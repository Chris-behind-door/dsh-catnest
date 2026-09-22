// dsh-catnest index.js 接线冒烟：stub ctx 跑宿主服务全接口
// （含角色调度层：personas 名册 / llm 打断反应与收尾蒸馏 / memory 落域）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import plugin from '../index.js'
import { HOME_VERSION } from '../lib.js'

const mkCtx = (services = {}) => {
  const provided = {}
  const effects = []
  const ctx = {
    provide: (name, value) => {
      provided[name] = value
    },
    effect: (cb) => {
      const dispose = cb()
      effects.push(dispose || (() => {}))
      return () => {}
    },
    get: (name) => (name in services ? services[name] : undefined),
  }
  return { ctx, provided, effects }
}

// llm 桩：stream() 返回一次性 async generator（chunk 形态与宿主一致）
const llmStub = (text) => ({
  stream: async function* () {
    yield { type: 'text-delta', text }
  },
})

// agent 化 tool-call 桩（2026-08-27 阶段一）：模拟模型调用一次 say 工具。
// 关键：基于 opts.messages 判断——若本轮已回填过 tool-call（messages 含 assistant 的
// tool-call 块），则收手返回 stop；否则返回一次 say 调用。这样多步循环里每角色只说一次，
// 且多角色串行时按 queue 自然轮流。
const hasAssistantToolCall = (messages) =>
  (messages || []).some((m) => m.role === 'assistant' && (m.content || []).some((b) => b.type === 'tool-call'))

const sayToolStub = (text) => ({
  stream: (opts) => {
    const stop = hasAssistantToolCall(opts && opts.messages)
    return (async function* () {
      if (stop) {
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'say' }
      yield { type: 'tool-call-delta', index: 0, argumentsDelta: JSON.stringify({ text }) }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    })()
  },
})

// 按队列序返回 say 台词的桩（多角色串行接话用）；队列耗尽后静默。
const sayQueueStub = (queue) => ({
  stream: (opts) => {
    const stop = hasAssistantToolCall(opts && opts.messages)
    return (async function* () {
      if (stop) {
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const text = queue.shift()
      if (text === undefined) {
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'say' }
      yield { type: 'tool-call-delta', index: 0, argumentsDelta: JSON.stringify({ text }) }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    })()
  },
})

// 沉默桩：模型不调任何工具（直接 stop）。
const silentStub = {
  stream: async function* () {
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}

// 角色限定工具桩 + 全量 messages 捕获（要看工具回执进下一轮的样子）。
const toolOnceMessagesStub = (who, name, args, out) => ({
  stream: (opts) => {
    const mine = typeof opts.system === 'string' && opts.system.includes('家里的成员' + who)
    const stop = !mine || hasAssistantToolCall(opts.messages)
    if (mine) out.push({ system: opts.system, messages: opts.messages })
    return (async function* () {
      if (stop) {
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield { type: 'tool-call-delta', index: 0, id: 'call_x', name }
      yield { type: 'tool-call-delta', index: 0, argumentsDelta: JSON.stringify(args) }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    })()
  },
})

// §9.18：周期抖动与每日掷骰的固定随机源——0.5 永不命中（chance 0.12），抖动折中成 0。
// 不注入的话，调用 tick 的用例会偶发被"今天家里掷出一个状态"打乱（实测飘红一次）。
const noRoll = () => 0.5

// 给角色写一个"已到期"的活动（测试用）：tick 第 2 步会走 T3 到期并叫醒她。
const expireActivity = async (dir, charId) => {
  const file = join(dir, 'home.json')
  const home = JSON.parse(await readFile(file, 'utf8'))
  const ch = home.characters[charId]
  ch.activity = '发呆'
  ch.activityEndsAt = new Date(Date.now() - 1000).toISOString()
  ch.lastAmbientAt = new Date(Date.now() - 1000).toISOString()
  await writeFile(file, JSON.stringify(home, null, 2) + '\n')
}

// 捕获 prompt + 按队列说台词（§9.13 参考话题引子测试用）：先记录本轮 prompt，
// 再决定说什么。队列耗尽即沉默（仍会记录 prompt）。
const sayCaptureStub = (queue, out) => ({
  stream: (opts) => {
    const stop = hasAssistantToolCall(opts && opts.messages)
    if (!stop && opts && Array.isArray(opts.messages)) {
      out.push({ system: opts.system, user: captureUser(opts.messages[0]) })
    }
    return (async function* () {
      if (stop) {
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const text = queue.shift()
      if (text === undefined) {
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'say' }
      yield { type: 'tool-call-delta', index: 0, argumentsDelta: JSON.stringify({ text }) }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    })()
  },
})

// agent 化通用工具桩：第一轮调指定工具一次（arguments 原样下发），之后收手 stop。
// 供 adjust_relation 等工具测试复用；hasAssistantToolCall 保证多步循环只调一次。
const toolOnceStub = (name, args) => ({
  stream: (opts) => {
    const stop = hasAssistantToolCall(opts.messages)
    return (async function* () {
      if (stop) {
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield { type: 'tool-call-delta', index: 0, id: 'call_x', name }
      yield { type: 'tool-call-delta', index: 0, argumentsDelta: JSON.stringify(args) }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    })()
  },
})

// 角色限定工具桩：只有指定角色的回合调一次该工具，其余角色沉默。
// 同房多角色场景（话题只在同房间开得起来）下用来精确控制「谁调工具」。
const toolOnceForStub = (who, name, args) => ({
  stream: (opts) => {
    const mine = typeof opts.system === 'string' && opts.system.includes('家里的成员' + who)
    const stop = !mine || hasAssistantToolCall(opts.messages)
    return (async function* () {
      if (stop) {
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield { type: 'tool-call-delta', index: 0, id: 'call_c', name }
      yield { type: 'tool-call-delta', index: 0, argumentsDelta: JSON.stringify(args) }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    })()
  },
})

// 捕获桩：记录每次 llm.stream 的 system/messages，同时按角色限定调一次工具。
// 用来验证「工具失败 → 回执真的回到模型手里」。
const captureToolStub = (captured, who, name, args) => ({
  stream: (opts) => {
    captured.push({
      system: typeof opts.system === 'string' ? opts.system : '',
      messages: (Array.isArray(opts.messages) ? opts.messages : []).map((m) => ({ ...m })),
    })
    const mine = typeof opts.system === 'string' && opts.system.includes('家里的成员' + who)
    const stop = !mine || hasAssistantToolCall(opts.messages)
    return (async function* () {
      if (stop) {
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield { type: 'tool-call-delta', index: 0, id: 'call_c', name }
      yield { type: 'tool-call-delta', index: 0, argumentsDelta: JSON.stringify(args) }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    })()
  },
})

const PERSONAS_STUB = {
  list: async () => [
    { id: 'kyu', name: '小玖', description: '', companion: true },
    { id: 'moli', name: '墨璃', description: '', companion: true },
    { id: 'zhua', name: '小爪', description: '', companion: false },
  ],
  get: async (id) =>
    id === 'kyu'
      ? { id: 'kyu', name: '小玖', persona: '你是主人的猫娘女仆，名叫小玖。\n\n性格：活泼，黏人略带傲娇。' }
      : undefined,
}

// 清理重试：后台蒸馏（fire-and-forget）可能仍在写盘，撞 ENOTEMPTY 就等它写完再删
const rmSafe = async (dir) => {
  for (let i = 0; ; i++) {
    try {
      await rm(dir, { recursive: true, force: true })
      return
    } catch (e) {
      if (i >= 15) throw e
      await new Promise((r) => setTimeout(r, 100))
    }
  }
}

// 轮询等待条件成立（后台蒸馏是 fire-and-forget，测试里等它落地）
const until = async (fn, ms = 3000) => {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - start > ms) throw new Error('until: 等待超时')
    await new Promise((r) => setTimeout(r, 20))
  }
}

test('apply 接线：ctx.catnest 全接口可用', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catnest-idx-'))
  const { ctx, provided } = mkCtx({ personas: PERSONAS_STUB })
  try {
    plugin.apply(ctx, { catnestDir: dir, tickRand: noRoll })
    const svc = provided.catnest
    assert.ok(svc, 'ctx.catnest 已提供')
    assert.equal(svc.dir, dir)

    assert.equal((await svc.status()).open, false)
    const opened = await svc.open()
    assert.equal(typeof opened.sliceId, 'string')
    assert.equal(opened.recap, null)

    await svc.moveMaster('living')
    await svc.moveCharacter('kyu', 'kitchen')
    await svc.setActivity('moli', '读书', 30)
    await svc.adjustRelation('master:moli', 'intimacy', 5)

    const home = await svc.home()
    assert.equal(home.characters.kyu.room, 'kitchen')
    assert.equal(home.master.room, 'living')
    const rel = await svc.relations()
    assert.equal(rel.pairs['master:moli'].intimacy, 55)

    // 家物理接线：小玖在厨房说话 → 客厅的墨璃攒缓冲
    const sayR = await svc.say('kyu', '客厅那边有人吗喵')
    assert.equal(sayR.room, 'kitchen')
    assert.equal(sayR.direct.length, 0)
    assert.ok(sayR.adjacent.includes('moli'), sayR)
    const hearR = await svc.hear('moli')
    assert.equal(hearR.buffer.length, 1)
    assert.equal(hearR.threshold, 5)
    const sceneR = await svc.scene('master')
    assert.equal(sceneR.room, 'living')
    assert.ok(sceneR.adjacent.includes('kyu'), sceneR)
    const respR = await svc.responders('living')
    assert.deepEqual(respR.candidates, []) // 墨璃在忙（读书30分钟），小玖在厨房
    await svc.interrupt('moli', 'master')
    await svc.resolveHear('moli', 'ignore')

    const closed = await svc.close()
    assert.equal(closed.sliceId, opened.sliceId)

    const again = await svc.open()
    assert.equal(typeof again.recap, 'string')
    assert.ok(again.recap.includes('小玖'), again.recap)
    await svc.close()
  } finally {
    await rmSafe(dir)
  }
})

test('companions：personas 过滤 companion:true；服务缺席回退默认名册', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catnest-idx-c-'))
  try {
    const { ctx, provided } = mkCtx({ personas: PERSONAS_STUB })
    plugin.apply(ctx, { catnestDir: dir, tickRand: noRoll })
    const roster = await provided.catnest.companions()
    assert.equal(roster.source, 'personas')
    assert.deepEqual(roster.entries.map((e) => e.id).sort(), ['kyu', 'moli'])
    assert.ok(!roster.entries.some((e) => e.id === 'zhua'), 'companion:false 不进名册')
  } finally {
    await rmSafe(dir)
  }

  const dir2 = await mkdtemp(join(tmpdir(), 'catnest-idx-c2-'))
  try {
    const { ctx, provided } = mkCtx({}) // 无 personas
    plugin.apply(ctx, { catnestDir: dir2, tickRand: noRoll })
    const roster = await provided.catnest.companions()
    assert.equal(roster.source, 'default')
    assert.deepEqual(roster.entries.map((e) => e.id).sort(), ['kyu', 'moli'])
  } finally {
    await rmSafe(dir2)
  }
})

test('open 名册对齐：名册新角色自动进家 + 建 master 关系对', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catnest-idx-o-'))
  const personasStub = {
    list: async () => [
      { id: 'kyu', name: '小玖', description: '', companion: true },
      { id: 'moli', name: '墨璃', description: '', companion: true },
      { id: 'sister2', name: '二号姐姐', description: '', companion: true },
    ],
    get: async () => undefined,
  }
  try {
    const { ctx, provided } = mkCtx({ personas: personasStub })
    plugin.apply(ctx, { catnestDir: dir, tickRand: noRoll })
    const svc = provided.catnest
    const opened = await svc.open()
    assert.equal(typeof opened.sliceId, 'string')
    const home = await svc.home()
    assert.equal(home.characters.sister2.room, 'living')
    assert.equal(home.characters.sister2.name, '二号姐姐')
    const rel = await svc.relations()
    assert.deepEqual(rel.pairs['master:sister2'], { intimacy: 15, spice: 0 }) // 未知名回退 15
    await svc.close()
  } finally {
    await rmSafe(dir)
  }
})

test('close→收尾蒸馏：回顾段落盘 summary + 分角色 learn 各域；open 回顾优先摘要', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catnest-idx-d-'))
  const learned = []
  const { ctx, provided } = mkCtx({
    personas: PERSONAS_STUB,
    llm: llmStub(
      '【回顾】上次主人回来时，小玖在厨房忙了一下午，客厅里大家都在贴贴。安安静静的。\n' +
      '\n【小玖】\n- 在厨房忙了一下午\n- 主人回来时和墨璃贴贴\n' +
      '\n【墨璃】\n- 在客厅发呆等主人回来',
    ),
    memory: {
      learn: async (key, text, tags) => {
        learned.push({ key, text, tags })
      },
    },
  })
  try {
    plugin.apply(ctx, { catnestDir: dir, tickRand: noRoll })
    const svc = provided.catnest
    await svc.open()
    await svc.moveMaster('living')
    await svc.say('kyu', '主人回来啦')
    await svc.say('master', '辛苦啦')
    const closed = await svc.close()
    // 后台蒸馏是 fire-and-forget：等 learn 落地
    await until(() => learned.length >= 3)
    const keys = [...new Set(learned.map((l) => l.key))].sort()
    assert.deepEqual(keys, ['kyu', 'moli'], '两个角色的域都要被写')
    assert.ok(learned.every((l) => l.tags.includes('猫窝') && l.tags.includes('时间片')))
    const kyuItems = learned.filter((l) => l.key === 'kyu')
    assert.ok(kyuItems.some((l) => l.text.includes('厨房')), '小玖域收到自己视角的条目')
    const sumText = await readFile(join(dir, 'slices', closed.sliceId, 'summary.json'), 'utf8')
    assert.ok(JSON.parse(sumText).text.includes('贴贴'))
    // open 回顾优先收尾摘要（LLM 版）
    const again = await svc.open()
    assert.ok(again.recap.includes('贴贴'), again.recap)
  } finally {
    await rmSafe(dir)
  }
})

test('distill 显式调用：llm 缺席回落规则化；空片给安静文案', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catnest-idx-d2-'))
  const { ctx, provided } = mkCtx({ personas: PERSONAS_STUB }) // 无 llm
  try {
    plugin.apply(ctx, { catnestDir: dir, tickRand: noRoll })
    const svc = provided.catnest
    await svc.open()
    await svc.say('moli', '今天的风好温柔')
    await svc.close()
    const d = await svc.distill() // 显式、可等待
    assert.equal(d.ok, true)
    assert.equal(d.source, 'rule') // llm 缺席 → 规则化
    assert.ok(d.summary.includes('墨璃'), d.summary)
    // 空片：无事件
    await svc.open()
    await svc.close()
    const d2 = await svc.distill()
    assert.equal(d2.source, 'empty')
    assert.ok(d2.summary.includes('安静'))
  } finally {
    await rmSafe(dir)
  }
})

test('回落规则化时不写角色记忆，且 summary.json 记 source/reason（2026-09-23）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catnest-idx-dist3-'))
  const learned = []
  const { ctx, provided } = mkCtx({
    personas: PERSONAS_STUB, // 无 llm → 必定回落
    memory: {
      learn: async (key, text, tags) => {
        learned.push({ key, text, tags })
      },
    },
  })
  try {
    plugin.apply(ctx, { catnestDir: dir, tickRand: noRoll })
    const svc = provided.catnest
    await svc.open()
    await svc.say('moli', '今天的风好温柔')
    const closed = await svc.close()
    const d = await svc.distill(closed.sliceId)
    assert.equal(d.source, 'rule')
    assert.ok(d.reason && d.reason.includes('llm'), 'reason 要写明 llm 缺席: ' + d.reason)
    assert.equal(learned.length, 0, '回落时一条记忆都不该写，实际写了: ' + JSON.stringify(learned))
    const sum = JSON.parse(await readFile(join(dir, 'slices', closed.sliceId, 'summary.json'), 'utf8'))
    assert.equal(sum.source, 'rule', 'summary.json 要留下来源，别让人对着文件猜')
    assert.ok(sum.reason, 'summary.json 要留下失败原因')
  } finally {
    await rmSafe(dir)
  }
})

test('llm 空输出：reason 记空输出并带上预算，记忆照旧不写（2026-09-23）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catnest-idx-dist4-'))
  const learned = []
  const emptyLlm = {
    stream: async function* () {
      yield { type: 'text-delta', text: '   ' } // 推理块吃光预算后的空正文
    },
  }
  const { ctx, provided } = mkCtx({
    personas: PERSONAS_STUB,
    llm: emptyLlm,
    memory: {
      learn: async (key, text, tags) => {
        learned.push({ key, text, tags })
      },
    },
  })
  try {
    plugin.apply(ctx, { catnestDir: dir, tickRand: noRoll })
    const svc = provided.catnest
    await svc.open()
    await svc.say('kyu', '主人不在家，守着呢')
    const closed = await svc.close()
    const d = await svc.distill(closed.sliceId)
    assert.equal(d.source, 'rule')
    assert.ok(d.reason.includes('空输出'), 'reason 要指出是空输出: ' + d.reason)
    assert.ok(d.reason.includes('16000'), 'reason 要带上预算，方便回看是不是又被吃光: ' + d.reason)
    assert.equal(learned.length, 0, '空输出回落时也不许写记忆')
  } finally {
    await rmSafe(dir)
  }
})

test('HTTP op distill：可手动重跑指定片的收尾蒸馏（2026-09-23）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catnest-idx-dist5-'))
  const ws = webServerStub()
  const learned = []
  const { ctx, provided } = mkCtx({
    personas: PERSONAS_STUB,
    llm: llmStub('【回顾】小玖在客厅守了一夜，天亮才眯着。\n\n【小玖】\n- 守了一夜'),
    memory: {
      learn: async (key, text, tags) => {
        learned.push({ key, text, tags })
      },
    },
  })
  ctx.webServer = ws
  try {
    plugin.apply(ctx, { catnestDir: dir, tickRand: noRoll })
    const svc = provided.catnest
    await svc.open()
    await svc.say('kyu', '守夜呢')
    const closed = await svc.close()
    const handler = ws.routes[0].handler

    let res = fakeRes()
    await handler(fakeReq('POST', '/catnest/api/action', JSON.stringify({ op: 'distill', sliceId: closed.sliceId })), res)
    assert.equal(res.code, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.source, 'llm', JSON.stringify(body))
    assert.ok(body.summary.includes('守了一夜'), body.summary)

    // 缺 sliceId → 400，不许拿「最近一片」顶替
    res = fakeRes()
    await handler(fakeReq('POST', '/catnest/api/action', JSON.stringify({ op: 'distill' })), res)
    assert.equal(res.code, 400)
  } finally {
    await rmSafe(dir)
  }
})

test('distill 分角色分条：各角色段分别 learn 各自记忆；回顾段进 summary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catnest-idx-dist2-'))
  const learned = []
  const memoryStub = {
    learn: async (sessionId, text, tags) => {
      learned.push({ sessionId, text, tags: tags ? tags.slice() : tags })
      return { id: 'm-' + learned.length }
    },
  }
  const llmSegments = '【回顾】小玖和墨璃在客厅玩了一晚的游戏，主人回来的时候家里还亮着灯。\n' +
    '\n【小玖】\n- 和小玖……不，和墨璃联机赢了两把\n- 给主人留了宵夜\n' +
    '\n【墨璃】\n- 画画画到一半被小玖拉去玩游戏\n- 答应了明天教小玖调色'
  const { ctx, provided } = mkCtx({
    personas: PERSONAS_STUB,
    llm: llmStub(llmSegments),
    memory: memoryStub,
  })
  try {
    plugin.apply(ctx, { catnestDir: dir, tickRand: noRoll })
    const svc = provided.catnest
    await svc.open()
    await svc.say('moli', '风好温柔')
    await svc.close()
    const d = await svc.distill()
    assert.equal(d.ok, true)
    assert.equal(d.source, 'llm')
    assert.ok(d.summary.includes('客厅'), '回顾段应进 summary: ' + d.summary)
    // 分角色 learn：kyu 域收到小玖段条目、moli 域收到墨璃段条目，不再全员同一份
    const kyuLearns = learned.filter((l) => l.sessionId === 'kyu')
    const moliLearns = learned.filter((l) => l.sessionId === 'moli')
    assert.ok(kyuLearns.length >= 2, '小玖应有分条记忆，实际: ' + learned.length)
    assert.ok(kyuLearns.some((l) => l.text.includes('宵夜')), '小玖条目内容正确')
    assert.ok(moliLearns.some((l) => l.text.includes('调色')), '墨璃条目带自己视角')
    assert.ok(!kyuLearns.some((l) => l.text.includes('调色')), '墨璃的记忆不进小玖域（分视角）')
    for (const l of [...kyuLearns, ...moliLearns]) {
      assert.ok(l.tags.includes('时间片') && l.tags.includes(d.sliceId), 'tags 照旧')
    }
  } finally {
    await rmSafe(dir)
  }
})

test('interruptReaction：llm 按角色×活动生成反应；llm 缺席 reaction=null', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catnest-idx-r-'))
  const { ctx, provided } = mkCtx({
    personas: PERSONAS_STUB,
    llm: llmStub('喵？主人叫我？人家刚打到关键的地方啦！'),
  })
  try {
    plugin.apply(ctx, { catnestDir: dir, tickRand: noRoll })
    const svc = provided.catnest
    await svc.open()
    await svc.setActivity('kyu', '打游戏', 30)
    const r = await svc.interruptReaction('kyu', 'master')
    assert.equal(r.busy, true)
    assert.equal(r.activity, '打游戏')
    assert.equal(r.reaction, '喵？主人叫我？人家刚打到关键的地方啦！')
    await svc.close()
  } finally {
    await rmSafe(dir)
  }

  const dir2 = await mkdtemp(join(tmpdir(), 'catnest-idx-r2-'))
  try {
    const { ctx: ctx2, provided: provided2 } = mkCtx({ personas: PERSONAS_STUB }) // 无 llm
    plugin.apply(ctx2, { catnestDir: dir2, tickRand: noRoll })
    await provided2.catnest.open()
    const r2 = await provided2.catnest.interruptReaction('kyu', 'master')
    assert.equal(r2.reaction, null)
    await provided2.catnest.close()
  } finally {
    await rmSafe(dir2)
  }
})

test('recapLLM：llm 改写回顾；llm 缺席回落规则化', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catnest-idx-l-'))
  const { ctx, provided } = mkCtx({
    personas: PERSONAS_STUB,
    llm: llmStub('你不在的时候，小玖在厨房忙活，墨璃陪着她聊天，家里暖暖的。'),
  })
  try {
    plugin.apply(ctx, { catnestDir: dir, tickRand: noRoll })
    const svc = provided.catnest
    await svc.open()
    await svc.moveMaster('living')
    await svc.say('kyu', '我煮了面')
    await svc.close()
    const r = await svc.recapLLM()
    assert.equal(r.source, 'llm')
    assert.ok(r.recap.includes('暖暖的'), r.recap)
  } finally {
    await rmSafe(dir)
  }

  const dir2 = await mkdtemp(join(tmpdir(), 'catnest-idx-l2-'))
  try {
    const { ctx: ctx2, provided: provided2 } = mkCtx({ personas: PERSONAS_STUB }) // 无 llm
    plugin.apply(ctx2, { catnestDir: dir2, tickRand: noRoll })
    await provided2.catnest.open()
    await provided2.catnest.say('kyu', '喵')
    await provided2.catnest.close()
    const r2 = await provided2.catnest.recapLLM()
    assert.equal(r2.source, 'rule')
    assert.ok(r2.recap.includes('小玖'), r2.recap)
  } finally {
    await rmSafe(dir2)
  }
})

test('apply 无 config 时默认目录不炸（只校验字段存在）', async () => {
  const { ctx, provided } = mkCtx({})
  plugin.apply(ctx)
  assert.equal(provided.catnest.dir, join(homedir(), '.dsh', '.catnest'))
})

// ── 存在感 UI 路由（/catnest/api/*）──

// 假 webServer：捕获 register 的路由，供测试直接调 handler
const webServerStub = () => {
  const routes = []
  return {
    routes,
    register: (r) => {
      routes.push(r)
    },
  }
}
// 假 req/res（Node Server 对象的最小子集）
const fakeReq = (method, url, body) => {
  const listeners = {}
  const req = {
    method,
    url,
    on: (ev, fn) => {
      (listeners[ev] = listeners[ev] || []).push(fn)
      return req
    },
    destroy: () => {},
  }
  // 微任务后放行 body（模拟异步到达）
  queueMicrotask(() => {
    if (body !== undefined) for (const f of listeners.data || []) f(Buffer.from(body))
    for (const f of listeners.end || []) f()
  })
  return req
}
const fakeRes = () => {
  const res = {
    code: 0,
    headers: null,
    body: null,
    writeHead(code, headers) {
      res.code = code
      res.headers = headers
      return res
    },
    end(data) {
      res.body = data
      return res
    },
  }
  return res
}

test('存在感 UI 路由：state 返回家视图 / action 可开片关片移动主人 / plan.svg 缺文件 404', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catnest-idx-ui-'))
  const ws = webServerStub()
  try {
    const { ctx, provided } = mkCtx({ personas: PERSONAS_STUB })
    ctx.webServer = ws
    plugin.apply(ctx, { catnestDir: dir, tickRand: noRoll })
    assert.equal(ws.routes.length, 1)
    assert.equal(ws.routes[0].path, '/catnest/api')
    const handler = ws.routes[0].handler

    // GET state：未开片
    let res = fakeRes()
    await handler(fakeReq('GET', '/catnest/api/state'), res)
    assert.equal(res.code, 200)
    const view = JSON.parse(res.body)
    assert.ok(Array.isArray(view.rooms) && view.rooms.length >= 5)
    // 大地图 §2–§3：房间表里现在也有小区节点（outdoor），主人位置多一层 place + 人话 label
    assert.ok(view.rooms.some((r) => r.id === 'bench' && r.outdoor === true), '小区节点在图里')
    // 场景图（2026-09-22）：房间带 image 文件名，前端拼 /catnest/api/rooms/<file> 当整屏背景
    assert.equal(view.rooms.find((r) => r.id === 'bedroom').image, 'bedroom.webp', '屋里的房间带图')
    assert.equal(view.rooms.find((r) => r.id === 'bench').image, 'yard_bench.webp', '小区节点也带图')
    assert.deepEqual(view.master, {
      place: { kind: 'away' },
      atHome: false,
      room: null,
      label: '不在家',
    })

    // POST action open → 状态变开
    res = fakeRes()
    await handler(fakeReq('POST', '/catnest/api/action', JSON.stringify({ op: 'open' })), res)
    assert.equal(res.code, 200)
    assert.equal(typeof JSON.parse(res.body).sliceId, 'string')

    // POST moveMaster living
    res = fakeRes()
    await handler(fakeReq('POST', '/catnest/api/action', JSON.stringify({ op: 'moveMaster', room: 'living' })), res)
    assert.equal(res.code, 200)
    const home = await provided.catnest.home()
    assert.equal(home.master.room, 'living')

    // GET state 反映主人在家
    res = fakeRes()
    await handler(fakeReq('GET', '/catnest/api/state'), res)
    assert.equal(JSON.parse(res.body).master.atHome, true)

    // POST close
    res = fakeRes()
    await handler(fakeReq('POST', '/catnest/api/action', JSON.stringify({ op: 'close' })), res)
    assert.equal(res.code, 200)

    // 未知 op → 400；未知路径 → 404
    res = fakeRes()
    await handler(fakeReq('POST', '/catnest/api/action', JSON.stringify({ op: 'nope' })), res)
    assert.equal(res.code, 400)
    res = fakeRes()
    await handler(fakeReq('GET', '/catnest/api/nothing'), res)
    assert.equal(res.code, 404)
    // plan.svg：真实资产应可读出 SVG（assets 随包在）
    res = fakeRes()
    await handler(fakeReq('GET', '/catnest/api/plan.svg'), res)
    assert.equal(res.code, 200)
    assert.match(String(res.headers['Content-Type']), /svg/)
  } finally {
    await rmSafe(dir)
  }
})

test('POST say：主人消息立刻入账，同房角色后台接话进 dialogue 流；空文本 400', async () => {
  const dir3 = await mkdtemp(join(tmpdir(), 'catnest-idx-say-'))
  const ws3 = webServerStub()
  const { ctx: ctx3, provided: provided3 } = mkCtx({
    personas: PERSONAS_STUB,
    llm: sayToolStub('喵？主人说什么啦，我刚才在发呆呢。'),
  })
  ctx3.webServer = ws3
  try {
    plugin.apply(ctx3, { catnestDir: dir3, tickRand: noRoll })
    const h3 = ws3.routes[0].handler
    const call = (method, url, body) => {
      const r = fakeRes()
      return h3(fakeReq(method, url, body), r).then(() => r)
    }
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'open' }))
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'moveMaster', room: 'living' }))
    // 墨璃请去厨房、小玖留在客厅：验证单人接话路径
    await provided3.catnest.moveCharacter('kyu', 'living')
    await provided3.catnest.moveCharacter('moli', 'kitchen')
    const sr = await call(
      'POST',
      '/catnest/api/action',
      JSON.stringify({ op: 'say', text: '小玖在吗喵' }),
    )
    assert.equal(sr.code, 200)
    const sayR = JSON.parse(sr.body)
    // 新语义：立即返回，接话在后台链上跑
    assert.equal(sayR.said, true)
    assert.deepEqual(sayR.pending, ['小玖'])
    // 后台接话完成 → dialogue 流出现主人 + 小玖两句
    await until(async () => {
      const dr = await call('GET', '/catnest/api/dialogue')
      return JSON.parse(dr.body).lines.length >= 2
    })
    const dr = await call('GET', '/catnest/api/dialogue')
    const dlg = JSON.parse(dr.body)
    assert.equal(dlg.lines[0].who, 'master')
    assert.equal(dlg.lines[1].who, 'kyu')
    // 主人不在家时说话拒绝
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'moveMaster', room: null }))
    const nr = await call('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '在吗' }))
    assert.equal(nr.code, 500)
    assert.ok(JSON.parse(nr.body).error.includes('不在家'), nr.body)
    // 空文本 400
    const br = await call('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '  ' }))
    assert.equal(br.code, 400)
  } finally {
    await rmSafe(dir3)
  }
})

test('多角色接话链：同房两角色串行接话（后者可见前者台词），单点失败不拖累', async () => {
  const dir4 = await mkdtemp(join(tmpdir(), 'catnest-idx-chain-'))
  const ws4 = webServerStub()
  // llm 桩按角色序返回：小玖先说、墨璃后说（串行依次，后者可见前者台词）
  const llmChain = sayQueueStub(['主人回来啦喵！', '（微微行礼）欢迎回家，主人。'])
  const { ctx: ctx4, provided: provided4 } = mkCtx({
    personas: PERSONAS_STUB,
    llm: llmChain,
  })
  ctx4.webServer = ws4
  try {
    plugin.apply(ctx4, { catnestDir: dir4, tickRand: noRoll })
    const svc = provided4.catnest
    const h4 = ws4.routes[0].handler
    const call = (method, url, body) => {
      const r = fakeRes()
      return h4(fakeReq(method, url, body), r).then(() => r)
    }
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'open' }))
    await svc.moveMaster('living')
    await svc.moveCharacter('kyu', 'living')
    await svc.moveCharacter('moli', 'living')
    const sr = await call('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '我回来啦' }))
    assert.equal(sr.code, 200)
    assert.equal(JSON.parse(sr.body).pending.length, 2, '两个同房角色都排进接话链')
    // 等接话链跑完：dialogue 应有 3 句（主人 + 两位）
    await until(async () => {
      const dr = await call('GET', '/catnest/api/dialogue')
      return JSON.parse(dr.body).lines.length >= 3
    })
    const dr = await call('GET', '/catnest/api/dialogue')
    const lines = JSON.parse(dr.body).lines
    assert.equal(lines.length, 3)
    assert.deepEqual(lines.map((l) => l.who), ['master', 'kyu', 'moli'])
    assert.ok(lines[2].text.includes('欢迎回家'), lines[2].text)
  } finally {
    await rmSafe(dir4)
  }
})

test('接话提示词：不设风格限制（无行数/字数/格式约束），多行消息全链路保留换行', async () => {
  const dir6 = await mkdtemp(join(tmpdir(), 'catnest-idx-prompt-'))
  const ws6 = webServerStub()
  const prompts = []
  // llm 桩：记录每次 system 提示词；台词带换行（经 say 工具 JSON 序列化往返，验证不吞 \n）
  const llmPromptSpy = {
    stream: (opts) => {
      const stop = hasAssistantToolCall(opts.messages)
      if (!stop) prompts.push(opts.system)
      return (async function* () {
        if (stop) {
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        const text = '主人这样夸小玖，小玖会开心得转圈圈喵～\n（蹭蹭你的手）\n那、那小玖现在就去干活了哦！'
        yield { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'say' }
        yield { type: 'tool-call-delta', index: 0, argumentsDelta: JSON.stringify({ text }) }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      })()
    },
  }
  const { ctx: ctx6, provided: provided6 } = mkCtx({
    personas: PERSONAS_STUB,
    llm: llmPromptSpy,
  })
  ctx6.webServer = ws6
  try {
    plugin.apply(ctx6, { catnestDir: dir6, tickRand: noRoll })
    const svc = provided6.catnest
    const h6 = ws6.routes[0].handler
    const call = (method, url, body) => {
      const r = fakeRes()
      return h6(fakeReq(method, url, body), r).then(() => r)
    }
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'open' }))
    await svc.moveMaster('living')
    await svc.moveCharacter('kyu', 'living')
    await svc.moveCharacter('moli', 'bedroom') // 只留小玖一人接话，场景干净
    const masterText = '小玖听我讲话的认真样子真可爱呢～\n（摸你的耳朵）\n小玖，要现在就开始工作吗？'
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: masterText }))
    // 等接话链跑完：主人 + 小玖 两句
    await until(async () => {
      const dr = await call('GET', '/catnest/api/dialogue')
      return JSON.parse(dr.body).lines.length >= 2
    })
    const dr = await call('GET', '/catnest/api/dialogue')
    const lines = JSON.parse(dr.body).lines
    assert.equal(lines.length, 2)
    // 提示词：风格不设限（主人拍板）——无行数/字数/格式约束，腔调由人设带出
    assert.ok(prompts.length >= 1, '接话应触发 llm 生成')
    assert.ok(!/不超过|1~3 行|格式示意|单独一行|一句台词/.test(prompts[0]), '提示词不应带风格限制: ' + prompts[0])
    assert.ok(!prompts[0].includes('只输出台词本身'), '输出卫生约束应退役: ' + prompts[0])
    assert.ok(prompts[0].includes('say'), 'system 应引导用工具行动: ' + prompts[0])
    // 换行全链路保留：主人多行消息与小玖多行台词都原样入账
    assert.equal(lines[0].text, masterText, '主人多行消息原样入账')
    assert.ok(lines[1].text.includes('\n'), '角色多行台词保留换行: ' + lines[1].text)
  } finally {
    await rmSafe(dir6)
  }
})

test('接话回忆：recall 直接按 时间片 标签池级过滤（防先 recall 后过滤空手），工程笔记不进客厅', async () => {
  const dir7 = await mkdtemp(join(tmpdir(), 'catnest-idx-mem-'))
  const ws7 = webServerStub()
  const recallCalls = []
  // 记忆桩：域里同时有家史（带 时间片 标签）和工程笔记（无）——
  // 故意把工程笔记也回给调用方，验证 catnest 本地还有兜底过滤
  const memoryStub = {
    recall: async (charId, query, limit, tags) => {
      recallCalls.push({ charId, query, limit, tags: tags ? tags.slice() : tags })
      return {
        entries: [
          { id: 'h1', text: '上次主人在客厅夸小玖修好了路由器', tags: ['猫窝', '时间片', '20260822T130543'] },
          { id: 'h2', text: '上片收尾时墨璃在卧室小憩', tags: ['猫窝', '时间片', '20260821T220000'] },
          { id: 'e1', text: 'SSE 交付时 res.write 链式调用要留意', tags: ['猫窝', 'dsh', '里程碑'] },
        ],
        total: 3,
      }
    },
  }
  const userMsgs = []
  const llmMsgSpy = {
    stream: (opts) => {
      const stop = hasAssistantToolCall(opts.messages)
      if (!stop) userMsgs.push(opts.messages[0].content[0].text)
      return (async function* () {
        if (stop) {
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        yield { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'say' }
        yield { type: 'tool-call-delta', index: 0, argumentsDelta: JSON.stringify({ text: '记得呢，就是那个路由器喵！' }) }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      })()
    },
  }
  const { ctx: ctx7, provided: provided7 } = mkCtx({ personas: PERSONAS_STUB, llm: llmMsgSpy, memory: memoryStub })
  ctx7.webServer = ws7
  try {
    plugin.apply(ctx7, { catnestDir: dir7, tickRand: noRoll })
    const svc = provided7.catnest
    const h7 = ws7.routes[0].handler
    const call = (method, url, body) => {
      const r = fakeRes()
      return h7(fakeReq(method, url, body), r).then(() => r)
    }
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'open' }))
    await svc.moveMaster('living')
    await svc.moveCharacter('kyu', 'living')
    await svc.moveCharacter('moli', 'bedroom')
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '还记得路由器的事吗？' }))
    await until(() => userMsgs.length >= 1)
    // recall 直接带 时间片 标签（服务侧先过滤池再打分），不再是"recall 8 条猫窝再本地过滤"
    const kyuRecall = recallCalls.find((c) => c.charId === 'kyu')
    assert.ok(kyuRecall, '接话应触发回忆')
    assert.deepEqual(kyuRecall.tags, ['时间片'], '直接把 时间片 标签传给 recall 做池级过滤')
    assert.equal(kyuRecall.limit, 3, 'limit 直接给 3，不再放宽到 8')
    // 家史进了提示词；工程笔记（无 时间片 标签）被本地兜底挡在客厅外
    assert.ok(userMsgs[0].includes('路由器'), '家史应注入接话提示词: ' + userMsgs[0])
    assert.ok(!userMsgs[0].includes('SSE'), '工程笔记不得注入接话提示词')
  } finally {
    await rmSafe(dir7)
  }
})

test('片内时间线：全量入 prompt（同房入账/跨房隔离/相邻弱化前缀/move 合并/末行即触发句）', async () => {
  const dir8 = await mkdtemp(join(tmpdir(), 'catnest-idx-hist-'))
  const ws8 = webServerStub()
  const replyQueue = ['甲', '乙', '丙', '丁', '戊', '己', '庚']
  const prompts = []
  const llmHist = {
    stream: (opts) => {
      const stop = hasAssistantToolCall(opts.messages)
      if (!stop) prompts.push({ system: opts.system, user: opts.messages[0].content[0].text })
      return (async function* () {
        if (stop) {
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        const text = replyQueue.shift() || '？'
        yield { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'say' }
        yield { type: 'tool-call-delta', index: 0, argumentsDelta: JSON.stringify({ text }) }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      })()
    },
  }
  const { ctx: ctx8, provided: provided8 } = mkCtx({ personas: PERSONAS_STUB, llm: llmHist })
  ctx8.webServer = ws8
  try {
    plugin.apply(ctx8, { catnestDir: dir8, tickRand: noRoll })
    const svc = provided8.catnest
    const h8 = ws8.routes[0].handler
    const call = (method, url, body) => {
      const r = fakeRes()
      return h8(fakeReq(method, url, body), r).then(() => r)
    }
    // 注意不能用 includes('小玖') 过滤：【家人】段注入了对方的完整角色卡（姐妹对互含），
    // 会把墨璃的调用混进来。过滤一律用 system 身份句特征词（成员小玖/成员墨璃）。
    const kyuPrompts = () => prompts.filter((p) => p.system.includes('成员小玖'))
    const tlSection = (user) => {
      const start = user.indexOf('【这个时间片里发生的事】')
      const end = user.indexOf('【此刻的位置】')
      if (start < 0 || end < 0 || end <= start) return null
      return user.slice(start, end)
    }
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'open' }))
    await svc.moveMaster('living')
    await svc.moveCharacter('kyu', 'living')
    await svc.moveCharacter('moli', 'living')

    // 等待谓词：台词入账（transcript 可见）才算这一轮真正结束
    const lineInTranscript = async (text) => {
      const t = await svc.transcript()
      return !!(t && Array.isArray(t.lines) && t.lines.some((l) => l.rawText === text))
    }

    // 第 1 轮：客厅两人接话（甲=小玖、乙=墨璃）
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '我回来啦' }))
    await until(() => lineInTranscript('乙'))
    // 第 2 轮：再接（丙=小玖、丁=墨璃）
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '今天怎么样' }))
    await until(() => lineInTranscript('丁'))

    // 墨璃挪去卧室，主人跟过去说一句；墨璃卧室接话（戊）
    await svc.moveCharacter('moli', 'bedroom')
    await svc.moveMaster('bedroom')
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '墨璃，过来一下' }))
    await until(() => lineInTranscript('戊'))
    // 主人回客厅再说话，小玖接话（己）
    await svc.moveMaster('living')
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '小玖，刚才说什么来着' }))
    await until(() => lineInTranscript('己'))

    const r1 = kyuPrompts()[0]
    const r2 = kyuPrompts()[1]
    const r4 = kyuPrompts()[2]

    // system 只留角色卡（含沉默权说明），不再有输出卫生老措辞与场景小抄
    assert.ok(r1.system.includes('角色卡'), 'system 应含角色卡段')
    assert.ok(!r1.system.includes('NO_REPLY'), 'system 不应再有 NO_REPLY 标记')
    assert.ok(r1.system.includes('say'), 'system 应引导用工具行动')
    assert.ok(!r1.user.includes('主人现在对你说'), '主人不特殊：不应再有特供槽位')

    // 片首时间线：只有主人的第一句
    const h1 = tlSection(r1.user)
    assert.ok(h1.includes('我回来啦'), '触发句应在时间线里: ' + h1)
    assert.ok(!h1.includes('甲'), '片首不应有后续台词')

    // 第 2 轮：全量时间线含第 1 轮三句 + 本轮触发句；丙是本轮新台词不在内
    const h2 = tlSection(r2.user)
    assert.ok(h2.includes('我回来啦'), '第2轮时间线应含第1轮主人的话: ' + h2)
    assert.ok(h2.includes('甲'), '第2轮时间线应含小玖第1轮台词: ' + h2)
    assert.ok(h2.includes('乙'), '第2轮时间线应含墨璃第1轮台词: ' + h2)
    assert.ok(h2.includes('今天怎么样'), '本轮触发句在时间线末尾')
    assert.ok(!h2.includes('丙'), '丙尚未入账，不应出现')
    assert.ok(!/900|12 行/.test(h2), '不再截断')

    // 第 3 轮（kyu 在客厅）：按说话时听众名单判定——
    const h4 = tlSection(r4.user)
    assert.ok(h4.includes('丁'), '客厅时的墨璃台词照常入账（说话时同房）')
    assert.ok(h4.includes('（卧室传来主人的声音：）墨璃，过来一下'), '相邻房间主人的话以弱化前缀入账: ' + h4)
    assert.ok(h4.includes('（卧室传来墨璃的声音：）戊'), '相邻房间墨璃的台词同样以闻声形态入账')
    assert.ok(h4.includes('墨璃从客厅挪去了卧室'), 'move 人话化入时间线')
    assert.ok(h4.includes('小玖，刚才说什么来着'), '最新一句就是触发句')

    // 主人去浴室（与客厅隔着卧室 = far）自言自语，小玖应该完全听不见
    await svc.moveMaster('bath')
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '哼哼哼' }))
    // 浴室没有其他角色在场：无人被询问，直接回客厅继续
    await svc.moveMaster('living')
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '小玖，刚才说什么来着' }))
    await until(() => lineInTranscript('庚'))

    const r5 = kyuPrompts()[kyuPrompts().length - 1]
    const h5 = tlSection(r5.user)
    assert.ok(!h5.includes('哼哼哼'), '远处（浴室）的话不应入账: ' + h5)
    assert.ok(h5.includes('主人从客厅挪去了浴室'), '主人移动同样人话化入时间线')
  } finally {
    await rmSafe(dir8)
  }
})

test('缓存布局：system 移动前后逐字节稳定；易变状态居尾部动态窗口；家人简卡互通', async () => {
  const dirC = await mkdtemp(join(tmpdir(), 'catnest-idx-cache-'))
  const wsC = webServerStub()
  const prompts = []
  const llmCache = {
    stream: (opts) => {
      const stop = hasAssistantToolCall(opts.messages)
      if (!stop) prompts.push({ system: opts.system, user: opts.messages[0].content[0].text })
      return (async function* () {
        if (stop) {
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        yield { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'say' }
        yield { type: 'tool-call-delta', index: 0, argumentsDelta: JSON.stringify({ text: '好' }) }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      })()
    },
  }
  const { ctx: ctxC, provided: providedC } = mkCtx({ personas: PERSONAS_STUB, llm: llmCache })
  ctxC.webServer = wsC
  try {
    plugin.apply(ctxC, { catnestDir: dirC, tickRand: noRoll })
    const svc = providedC.catnest
    const hC = wsC.routes[0].handler
    const call = (method, url, body) => {
      const r = fakeRes()
      return hC(fakeReq(method, url, body), r).then(() => r)
    }
    const transcriptCount = async (text) => {
      const t = await svc.transcript()
      return (t && Array.isArray(t.lines) ? t.lines : []).filter((l) => l.rawText === text).length
    }
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'open' }))
    await svc.moveMaster('living')
    await svc.moveCharacter('kyu', 'living')
    await svc.moveCharacter('moli', 'living')

    // 轮1：客厅两人先后接话（各产出一条 prompt）
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '第一句' }))
    await until(async () => (await transcriptCount('好')) >= 2)

    const kyuP = () => prompts.filter((p) => p.system.includes('成员小玖'))
    const moliP = () => prompts.filter((p) => p.system.includes('成员墨璃'))

    // 家人互通：各自 system 注入对方完整角色卡；自己不在家人段里
    const k1 = kyuP()[0]
    assert.ok(k1.system.includes('【家人】'), 'system 应含家人段')
    assert.ok(
      k1.system.includes('墨璃的角色卡') && k1.system.includes('黑长直红瞳'),
      'personas 缺席时对方无卡 → 应回落 CHARACTER_BIOS 一句话简卡兜底',
    )
    assert.ok(!k1.system.includes('亲密'), '关系数值退出 system（缓存前缀的根必须全静态）')
    const m1 = moliP()[0]
    assert.ok(m1.system.includes('小玖的角色卡'), '墨璃的 system 应含小玖的完整角色卡')
    assert.ok(m1.system.includes('猫娘女仆'), '注入的是完整卡而非简卡')
    assert.ok(!m1.system.includes('墨璃的角色卡'), '不应把自己的角色卡当家人列出')

    // 动态窗口在 user 尾部：位置快照在触发句之前、时间线之后
    const u1 = k1.user
    const posIdx = u1.indexOf('【此刻的位置】')
    const trigIdx = u1.indexOf('——现在轮到你了')
    assert.ok(posIdx > 0 && trigIdx > posIdx, '位置快照应居尾部动态窗口: ' + u1.slice(-200))

    // 墨璃挪去卧室；主人在客厅再说话 → 同房只剩小玖，仅她被询问
    await svc.moveCharacter('moli', 'bedroom')
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '第二句' }))
    await until(async () => (await transcriptCount('好')) >= 3)

    const k2 = kyuP()[kyuP().length - 1]
    // 核心：system 是缓存前缀的根，移动前后必须逐字节一致
    assert.equal(k2.system, k1.system, 'system 应全静态：移动前后逐字节一致')
    // 公共前缀应覆盖到旧时间线末行末尾（缓存命中的主体）。
    // 允许的唯一分歧：u1 时间线之后是段间空行，而 u2 同位置是续写的台词行——
    // 这正是前缀单调生长的正确形态，损失仅分隔符级字节。
    const lastLineEnd = u1.indexOf('主人：第一句') + '主人：第一句'.length
    let common = 0
    while (common < Math.min(u1.length, k2.user.length) && u1[common] === k2.user[common]) common++
    assert.ok(
      common >= lastLineEnd,
      `公共前缀(${common}) 应至少覆盖静态场景+全部旧时间线(至${lastLineEnd})`,
    )
    assert.ok(k2.user.includes('墨璃从客厅挪去了卧室'), '移动以增量行人话化进时间线')
    const seg2 = k2.user.slice(k2.user.indexOf('【此刻的位置】'))
    assert.ok(seg2.includes('墨璃在卧室'), '此刻快照应反映新位置')
    assert.ok(seg2.indexOf('——现在轮到你了') > seg2.indexOf('【此刻的位置】'), '触发句仍在动态窗口之后')
  } finally {
    await rmSafe(dirC)
  }
})

test('沉默权：模型不调 say 工具 → 不入账、不算错误', async () => {
  const dir9 = await mkdtemp(join(tmpdir(), 'catnest-idx-noreply-'))
  const ws9 = webServerStub()
  const { ctx: ctx9, provided: provided9 } = mkCtx({
    personas: PERSONAS_STUB,
    llm: silentStub,
  })
  ctx9.webServer = ws9
  try {
    plugin.apply(ctx9, { catnestDir: dir9, tickRand: noRoll })
    const svc = provided9.catnest
    const h9 = ws9.routes[0].handler
    const closeCbs = []
    const sseReq = {
      method: 'GET',
      url: '/catnest/api/events',
      on: (ev, fn) => {
        if (ev === 'close') closeCbs.push(fn)
        return sseReq
      },
    }
    const sseRes = fakeRes()
    sseRes.written = []
    sseRes.write = (chunk) => {
      sseRes.written.push(String(chunk))
      return sseRes
    }
    await h9(sseReq, sseRes)
    const call = (method, url, body) => {
      const r = fakeRes()
      return h9(fakeReq(method, url, body), r).then(() => r)
    }
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'open' }))
    await svc.moveMaster('living')
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '在吗' }))
    // 等接话链走完（无台词入账）：给后台链路留出时间
    await new Promise((r) => setTimeout(r, 400))
    const dr = await call('GET', '/catnest/api/dialogue')
    const lines = JSON.parse(dr.body).lines
    assert.equal(lines.length, 1, '只有主人的话，角色沉默不入账')
    assert.equal(
      sseRes.written.some((w) => w.includes('"kind":"replyError"')),
      false,
      '沉默不是错误，不得推 replyError',
    )
    assert.equal(
      sseRes.written.some((w) => w.includes('"kind":"settle"')),
      true,
      '沉默应推 settle 结算事件，前端据此收起「正在想」等待名单',
    )
    for (const fn of closeCbs) fn()
  } finally {
    await rmSafe(dir9)
  }
})

test('SSE events：连接即推首帧快照；avatar 路由白名单伺服 PNG', async () => {
  const dir5 = await mkdtemp(join(tmpdir(), 'catnest-idx-sse-'))
  const ws5 = webServerStub()
  const { ctx: ctx5 } = mkCtx({ personas: PERSONAS_STUB })
  ctx5.webServer = ws5
  try {
    plugin.apply(ctx5, { catnestDir: dir5, tickRand: noRoll })
    const h5 = ws5.routes[0].handler

    // SSE：假 res 记录 write 出的帧；req close 可手动触发
    const closeCbs = []
    const sseReq = {
      method: 'GET',
      url: '/catnest/api/events',
      on: (ev, fn) => {
        if (ev === 'close') closeCbs.push(fn)
        return sseReq
      },
    }
    const sseRes = fakeRes()
    sseRes.written = []
    sseRes.write = (chunk) => {
      sseRes.written.push(String(chunk))
      return sseRes
    }
    await h5(sseReq, sseRes)
    assert.equal(sseRes.code, 200)
    assert.match(String(sseRes.headers['Content-Type']), /event-stream/)
    assert.ok(sseRes.written[0].startsWith(': connected'))
    // 首帧快照异步到达
    await until(() => sseRes.written.some((w) => w.startsWith('data: ')))
    const frame = sseRes.written.find((w) => w.startsWith('data: '))
    const evt = JSON.parse(frame.replace(/^data: /, '').trim())
    assert.equal(evt.kind, 'snapshot')
    assert.ok(Array.isArray(evt.state.rooms))
    assert.ok(Array.isArray(evt.dialogue.lines))
    // 断开清理：close 后不再推帧
    for (const fn of closeCbs) fn()
    // 变化信号（开片）不应再写给已断开的连接
    const r2 = fakeRes()
    await h5(fakeReq('POST', '/catnest/api/action', JSON.stringify({ op: 'open' })), r2)
    await new Promise((r) => setTimeout(r, 250))
    const dataFrames = sseRes.written.filter((w) => w.startsWith('data: '))
    assert.equal(dataFrames.length, 1, '断开后快照不再写给该连接')

    // avatar：白名单命中 / 未知 404 / 穿越字符被剥
    const av1 = fakeRes()
    await h5(fakeReq('GET', '/catnest/api/avatar/kyu'), av1)
    assert.equal(av1.code, 200)
    assert.match(String(av1.headers['Content-Type']), /png/)
    const av2 = fakeRes()
    await h5(fakeReq('GET', '/catnest/api/avatar/nope'), av2)
    assert.equal(av2.code, 404)
    const av1b = fakeRes()
    await h5(fakeReq('GET', '/catnest/api/avatar/kyu.png'), av1b)
    assert.equal(av1b.code, 200)
    assert.match(String(av1b.headers['Content-Type']), /png/)
    const av3 = fakeRes()
    await h5(fakeReq('GET', '/catnest/api/avatar/../index.js'), av3)
    assert.equal(av3.code, 404)

    // 场景图（2026-09-22）：白名单来自 assets/rooms/index.json，不在清单里的一律 404
    const sc1 = fakeRes()
    await h5(fakeReq('GET', '/catnest/api/rooms/bedroom.webp'), sc1)
    assert.equal(sc1.code, 200)
    assert.match(String(sc1.headers['Content-Type']), /webp/)
    const sc2 = fakeRes()
    await h5(fakeReq('GET', '/catnest/api/rooms/nope.webp'), sc2)
    assert.equal(sc2.code, 404)
    const sc3 = fakeRes()
    await h5(fakeReq('GET', '/catnest/api/rooms/../index.js'), sc3)
    assert.equal(sc3.code, 404)
  } finally {
    await rmSafe(dir5)
  }
})

test('接话失败可见：llm 缺席 → SSE 推 replyError(noLlm)，不再静默吞掉', async () => {
  const dir6 = await mkdtemp(join(tmpdir(), 'catnest-idx-rerr-'))
  const ws6 = webServerStub()
  const { ctx: ctx6, provided: provided6 } = mkCtx({
    personas: PERSONAS_STUB,
    // 不传 llm：模拟 llm 服务缺席（角色无法决定，属系统故障而非沉默）
  })
  ctx6.webServer = ws6
  try {
    plugin.apply(ctx6, { catnestDir: dir6, tickRand: noRoll })
    const svc = provided6.catnest
    const h6 = ws6.routes[0].handler
    // 连一个 SSE 客户端
    const closeCbs = []
    const sseReq = {
      method: 'GET',
      url: '/catnest/api/events',
      on: (ev, fn) => {
        if (ev === 'close') closeCbs.push(fn)
        return sseReq
      },
    }
    const sseRes = fakeRes()
    sseRes.written = []
    sseRes.write = (chunk) => {
      sseRes.written.push(String(chunk))
      return sseRes
    }
    await h6(sseReq, sseRes)
    // 开片 + 主人进客厅（小玖默认同房）
    const call = (method, url, body) => {
      const r = fakeRes()
      return h6(fakeReq(method, url, body), r).then(() => r)
    }
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'open' }))
    await svc.moveMaster('living')
    const sr = await call('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '在吗' }))
    assert.equal(sr.code, 200)
    assert.equal(JSON.parse(sr.body).pending.length >= 1, true)
    // 等 replyError 帧推给订阅者
    await until(() =>
      sseRes.written.some((w) => w.includes('"kind":"replyError"')),
    )
    const frame = sseRes.written.find((w) => w.includes('"kind":"replyError"'))
    const evt = JSON.parse(frame.replace(/^data: /, '').trim())
    assert.equal(evt.reason, 'noLlm')
    assert.ok(evt.name, evt.name)
    for (const fn of closeCbs) fn()
  } finally {
    await rmSafe(dir6)
  }
})

test('工具说话整句入账：模型调 say 工具 → 台词进 dialogue（打字机退役，整句上屏）', async () => {
  const dir7 = await mkdtemp(join(tmpdir(), 'catnest-idx-delta-'))
  const ws7 = webServerStub()
  const { ctx: ctx7, provided: provided7 } = mkCtx({
    personas: PERSONAS_STUB,
    llm: sayToolStub('喵，我在呢！'),
  })
  ctx7.webServer = ws7
  try {
    plugin.apply(ctx7, { catnestDir: dir7, tickRand: noRoll })
    const svc = provided7.catnest
    const h7 = ws7.routes[0].handler
    const call = (method, url, body) => {
      const r = fakeRes()
      return h7(fakeReq(method, url, body), r).then(() => r)
    }
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'open' }))
    await svc.moveMaster('living')
    const sr = await call('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '在吗' }))
    assert.equal(sr.code, 200)
    // 台词经 say 工具整句入账 dialogue（打字机 delta 只给 SSE 订阅者直播，此处无订阅者）
    await until(async () => {
      const dr = await call('GET', '/catnest/api/dialogue')
      return JSON.parse(dr.body).lines.length >= 2
    })
    const dr = await call('GET', '/catnest/api/dialogue')
    const lines = JSON.parse(dr.body).lines
    assert.equal(lines[1].text, '喵，我在呢！', 'say 工具台词整句入账')
  } finally {
    await rmSafe(dir7)
  }
})

test('say 打字机：argumentsDelta 分片增量抠 text（转义/切分边界/帧序），整句仍原样入账', async () => {
  const dirTy1 = await mkdtemp(join(tmpdir(), 'catnest-idx-typer1-'))
  const wsTy1 = webServerStub()
  // 台词含换行/引号/反斜杠/unicode 转义：JSON 序列化后故意按 7 字符切碎分片，
  // 必然有分片边界落在转义序列中间（\ 与 " 各占一片），验证状态机跨片拼接
  const line = '喵～\n主人！"贴贴"时间，\\ 反斜杠也要活下来。'
  const argsJson = JSON.stringify({ text: line })
  const pieces = []
  for (let i = 0; i < argsJson.length; i += 7) pieces.push(argsJson.slice(i, i + 7))
  const llmTyper = {
    stream: (opts) => {
      const stop = hasAssistantToolCall(opts.messages)
      return (async function* () {
        if (stop) {
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        yield { type: 'tool-call-delta', index: 0, id: 'call_t', name: 'say' }
        for (const pc of pieces) yield { type: 'tool-call-delta', index: 0, argumentsDelta: pc }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      })()
    },
  }
  const { ctx: ctxTy1, provided: providedTy1 } = mkCtx({ personas: PERSONAS_STUB, llm: llmTyper })
  ctxTy1.webServer = wsTy1
  try {
    plugin.apply(ctxTy1, { catnestDir: dirTy1, tickRand: noRoll })
    const svc = providedTy1.catnest
    const hTy1 = wsTy1.routes[0].handler
    const sseReq = {
      method: 'GET',
      url: '/catnest/api/events',
      on: () => sseReq,
    }
    const sseRes = fakeRes()
    sseRes.written = []
    sseRes.write = (chunk) => {
      sseRes.written.push(String(chunk))
      return sseRes
    }
    await hTy1(sseReq, sseRes)
    const call = (method, url, body) => {
      const r = fakeRes()
      return hTy1(fakeReq(method, url, body), r).then(() => r)
    }
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'open' }))
    await svc.moveMaster('living')
    // 小玖墨璃默认都在客厅：两人都接话，顺带验证串行链下打字机一人收一人开
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '小玖，来一下' }))
    await until(async () => {
      const dr = await call('GET', '/catnest/api/dialogue')
      return JSON.parse(dr.body).lines.length >= 3
    })
    const frames = sseRes.written
      .filter((w) => w.startsWith('data: '))
      .map((w) => JSON.parse(w.replace(/^data: /, '').trim()))
    // 每个角色的打字机帧各自成段：start→delta…→end；串行链下小玖段整体先于墨璃段
    for (const [cid, cname] of [['kyu', '小玖'], ['moli', '墨璃']]) {
      const seg = frames
        .map((f, i) => ((f.char || null) === cid ? i : -1))
        .filter((i) => i >= 0)
      assert.ok(seg.length >= 3, cid + ' 应有 start+多delta+end 帧段: ' + seg.length)
      assert.equal(frames[seg[0]].kind, 'deltaStart')
      assert.equal(frames[seg[seg.length - 1]].kind, 'deltaEnd')
      assert.equal(frames[seg[0]].name, cname)
      assert.equal(
        frames.slice(seg[0] + 1, seg[seg.length - 1]).map((f) => f.text).join(''),
        line,
        cid + ' 的 delta 片段应逐字节等于原台词（转义全部解回）',
      )
    }
    const kyuEnd = frames.findIndex((f) => f.kind === 'deltaEnd' && f.char === 'kyu')
    const moliStart = frames.findIndex((f) => f.kind === 'deltaStart' && f.char === 'moli')
    assert.ok(moliStart > kyuEnd, '串行链：小玖的打字机收完才轮到墨璃开播')
    // 正式入账不受打字机影响：整句原样
    const dr = await call('GET', '/catnest/api/dialogue')
    const lines = JSON.parse(dr.body).lines
    assert.equal(lines[1].text, line, '小玖台词整句原样入账')
    assert.equal(lines[2].text, line, '墨璃台词整句原样入账')
  } finally {
    await rmSafe(dirTy1)
  }
})

test('打字机只跟 say：move_to 等其他工具不产生 delta 帧', async () => {
  const dirTy2 = await mkdtemp(join(tmpdir(), 'catnest-idx-typer2-'))
  const wsTy2 = webServerStub()
  // 第一步调 move_to（args 同样切碎），第二步收手沉默
  const moveJson = JSON.stringify({ room: '卧室' })
  const movePieces = []
  for (let i = 0; i < moveJson.length; i += 5) movePieces.push(moveJson.slice(i, i + 5))
  const llmMover = {
    stream: (opts) => {
      const stop = hasAssistantToolCall(opts.messages)
      return (async function* () {
        if (stop) {
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        yield { type: 'tool-call-delta', index: 0, id: 'call_m', name: 'move_to' }
        for (const pc of movePieces) yield { type: 'tool-call-delta', index: 0, argumentsDelta: pc }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      })()
    },
  }
  const { ctx: ctxTy2, provided: providedTy2 } = mkCtx({ personas: PERSONAS_STUB, llm: llmMover })
  ctxTy2.webServer = wsTy2
  try {
    plugin.apply(ctxTy2, { catnestDir: dirTy2, tickRand: noRoll })
    const svc = providedTy2.catnest
    const hTy2 = wsTy2.routes[0].handler
    const sseReq = {
      method: 'GET',
      url: '/catnest/api/events',
      on: () => sseReq,
    }
    const sseRes = fakeRes()
    sseRes.written = []
    sseRes.write = (chunk) => {
      sseRes.written.push(String(chunk))
      return sseRes
    }
    await hTy2(sseReq, sseRes)
    const call = (method, url, body) => {
      const r = fakeRes()
      return hTy2(fakeReq(method, url, body), r).then(() => r)
    }
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'open' }))
    await svc.moveMaster('living')
    await svc.moveCharacter('kyu', 'living')
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '随便走走' }))
    // 等接话链走完（移动+沉默）
    await until(async () => {
      const home = await svc.home()
      return home.characters.kyu.room === 'bedroom'
    })
    await new Promise((r) => setTimeout(r, 300))
    const joined = sseRes.written.join('')
    assert.ok(!joined.includes('"kind":"deltaStart"'), 'move_to 不得触发打字机')
    assert.ok(!joined.includes('"kind":"delta"'), 'move_to 不得推 delta 帧')
    assert.ok(!joined.includes('"kind":"deltaEnd"'), 'move_to 不得推 deltaEnd')
    assert.ok(joined.includes('"kind":"settle"'), '未说话应推 settle 结算')
  } finally {
    await rmSafe(dirTy2)
  }
})

// ── 阶段二·亲密度自动演化（2026-08-30）：adjust_relation 工具 ──

const setupNest = async (llm) => {
  const dir = await mkdtemp(join(tmpdir(), 'catnest-idx-rel-'))
  const ws = webServerStub()
  const { ctx, provided } = mkCtx({ personas: PERSONAS_STUB, llm })
  ctx.webServer = ws
  plugin.apply(ctx, { catnestDir: dir, tickRand: noRoll })
  const svc = provided.catnest
  const h = ws.routes[0].handler
  await h(fakeReq('POST', '/catnest/api/action', JSON.stringify({ op: 'open' })), fakeRes())
  await svc.moveMaster('living')
  await svc.moveCharacter('kyu', 'living')
  await svc.moveCharacter('moli', 'bedroom') // 墨璃不在同房，只有小玖被询问
  return { dir, svc, h }
}

// ── 大地图（小区）§2–§8：工具面接线 ──

test('move_to 认小区地名 + 场景描写进回执；账本记 door「出家门」', async () => {
  const n = await setupNest(toolOnceForStub('小玖', 'move_to', { room: '长椅' }))
  try {
    await n.h(
      fakeReq('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '我出门走走' })),
      fakeRes(),
    )
    await until(async () => (await n.svc.home()).characters.kyu.room === 'bench')
    const home = await n.svc.home()
    assert.equal(home.characters.kyu.room, 'bench')
    const st = await n.svc.status()
    const log = await readLog(n.dir, st.sliceId)
    const mv = log.filter((e) => e.type === 'move' && e.char === 'kyu').pop()
    assert.equal(mv.to, 'bench')
    // 收手确认取消（§9.20）下工具回执不进模型，所以这里验的是账本与状态；
    // 场景描写在工具结果里给模型（那条靠 prompt 捕获桩验，见下一条）
  } finally {
    await rmSafe(n.dir)
  }
})

test('go_home：在小区里能回玄关；本来在家就拒绝（不静默瞬移）', async () => {
  const n = await setupNest(toolOnceForStub('小玖', 'go_home', {}))
  try {
    await n.h(
      fakeReq('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '我出门走走' })),
      fakeRes(),
    )
    // 本来在客厅（不是户外）→ 这轮 go_home 会失败，位置不动（判据：回合跑完还留在客厅）
    await until(async () => (await n.svc.status()).turnPending === 0 || true)
    await new Promise((r) => setTimeout(r, 250))
    assert.equal((await n.svc.home()).characters.kyu.room, 'living', '在家调 go_home 不该动她')
    // 先真的把她挪到小区，主人也跟到同一处（不然喊她听不见、这轮根本不会轮到她）
    await n.svc.moveCharacter('kyu', 'bench')
    await n.svc.moveMaster('bench')
    await n.h(
      fakeReq('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '回来啦' })),
      fakeRes(),
    )
    await until(async () => (await n.svc.home()).characters.kyu.room === 'entry')
    assert.equal((await n.svc.home()).characters.kyu.room, 'entry', '从小区回玄关')
  } finally {
    await rmSafe(n.dir)
  }
})

test('小区场景描写进角色上下文：在步道上时【眼前】带那一句', async () => {
  const captured = []
  const n = await setupNest(silentCapture(captured))
  try {
    await n.svc.moveCharacter('kyu', 'path')
    await n.svc.moveMaster('path') // 主人也在同一处，才轮得到她答话
    await n.h(
      fakeReq('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '你到哪儿了' })),
      fakeRes(),
    )
    await until(() => captured.length >= 1)
    const p = captured[captured.length - 1]
    assert.match(p.user, /【眼前】/, '户外节点给一句场景描写')
    assert.match(p.user, /桂花/, '就是节点描述里那一句')
    assert.match(p.user, /小区·步道/, '位置带小区前缀')
  } finally {
    await rmSafe(n.dir)
  }
})

test('adjust_relation：模型调工具 → 亲密度按 delta 增减并入账（阶段二）', async () => {
  const n = await setupNest(toolOnceStub('adjust_relation', { person: '主人', field: 'intimacy', delta: 5 }))
  try {
    const rel0 = await n.svc.relations()
    assert.equal(rel0.pairs['master:kyu'].intimacy, 50)
    await n.h(
      fakeReq('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '小玖，今天辛苦啦' })),
      fakeRes(),
    )
    await until(async () => (await n.svc.relations()).pairs['master:kyu'].intimacy === 55)
    const rel = await n.svc.relations()
    assert.equal(rel.pairs['master:kyu'].intimacy, 55, '亲密 50 → 55')
    assert.equal(rel.pairs['master:kyu'].spice, 0, 'spice 不被误动')
  } finally {
    await rmSafe(n.dir)
  }
})

test('adjust_relation 非法输入：不存在的人物 / 非法字段 / delta=0 → 拒绝且数值不变', async () => {
  const cases = [
    { name: 'person 不存在', args: { person: '路人甲', field: 'intimacy', delta: 3 } },
    { name: 'field 非法', args: { person: '主人', field: 'hate', delta: 3 } },
    { name: 'delta=0', args: { person: '主人', field: 'intimacy', delta: 0 } },
    { name: 'delta 非数字', args: { person: '主人', field: 'intimacy', delta: 'abc' } },
  ]
  for (const c of cases) {
    const n = await setupNest(toolOnceStub('adjust_relation', c.args))
    try {
      await n.h(
        fakeReq('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '触发 ' + c.name })),
        fakeRes(),
      )
      await new Promise((r) => setTimeout(r, 350))
      const rel = await n.svc.relations()
      assert.equal(rel.pairs['master:kyu'].intimacy, 50, c.name + '：数值应保持 50')
      assert.equal(rel.pairs['master:kyu'].spice, 0, c.name + '：spice 应保持 0')
    } finally {
      await rmSafe(n.dir)
    }
  }
})

test('adjust_relation 钳制边界：delta 溢出仍钳制在 0~100；中文人名可解析', async () => {
  const n = await setupNest(toolOnceStub('adjust_relation', { person: '主人', field: 'intimacy', delta: 500 }))
  try {
    await n.h(
      fakeReq('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '小玖，一直陪着我喵' })),
      fakeRes(),
    )
    await until(async () => (await n.svc.relations()).pairs['master:kyu'].intimacy === 100)
    assert.equal((await n.svc.relations()).pairs['master:kyu'].intimacy, 100, '500 → 钳到 100')
  } finally {
    await rmSafe(n.dir)
  }

  // 负向钳制：delta=-500 → 0
  const n2 = await setupNest(toolOnceStub('adjust_relation', { person: '主人', field: 'intimacy', delta: -500 }))
  try {
    await n2.h(
      fakeReq('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '测试负向' })),
      fakeRes(),
    )
    await until(async () => (await n2.svc.relations()).pairs['master:kyu'].intimacy === 0)
    assert.equal((await n2.svc.relations()).pairs['master:kyu'].intimacy, 0, '-500 → 钳到 0')
  } finally {
    await rmSafe(n2.dir)
  }
})

// ── 阶段二·挂状态（set_condition）：持久状态落地 + 倒计时 + 前端数据 ──

test('set_condition：模型挂状态 → home 落 conditions、stateView 带 phase 与倒计时文本', async () => {
  const n = await setupNest(toolOnceStub('set_condition', { name: '发情', lastsDays: 3 }))
  try {
    const home0 = await n.svc.home()
    assert.equal(home0.characters.kyu.conditions.length, 0, '初始无持久状态')
    await n.h(
      fakeReq('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '小玖现在怎么样' })),
      fakeRes(),
    )
    await until(async () => (await n.svc.home()).characters.kyu.conditions.length === 1)
    const cond = (await n.svc.home()).characters.kyu.conditions[0]
    assert.equal(cond.name, '发情')
    assert.ok(cond.startAt && cond.endAt, '状态应带时间段')
    const of = await n.svc.conditionsOf('kyu')
    assert.equal(of.conditions[0].phase, 'active')
    assert.ok(of.conditions[0].text.includes('还剩'), 'active 应显示剩余倒计时: ' + of.conditions[0].text)
    assert.ok(of.conditions[0].text.includes('发情'), '文本应含状态名')
  } finally {
    await rmSafe(n.dir)
  }
})

test('set_condition：startsInDays 预置倒计时 → pending（还有N天后开始）；lastsDays=0 清除', async () => {
  // 预置 2 天后开始的生病
  const n = await setupNest(toolOnceStub('set_condition', { name: '生病', startsInDays: 2, lastsDays: 1 }))
  try {
    await n.h(
      fakeReq('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '小玖预告一下' })),
      fakeRes(),
    )
    await until(async () => (await n.svc.home()).characters.kyu.conditions.length === 1)
    const of = await n.svc.conditionsOf('kyu')
    assert.equal(of.conditions[0].phase, 'pending', '未来开始 → pending')
    assert.ok(of.conditions[0].text.includes('还有') && of.conditions[0].text.includes('开始'), 'pending 倒计时文本: ' + of.conditions[0].text)
    // 起止时间确实在未来 2 天
    const startMs = new Date(of.conditions[0].startAt).getTime()
    const dayMs = 86400000
    assert.ok(startMs > Date.now() + 1.5 * dayMs, 'startAt 应在 2 天后的窗口内: ' + of.conditions[0].startAt)
  } finally {
    await rmSafe(n.dir)
  }

  // lastsDays=0 → 清除
  const n2 = await setupNest(toolOnceStub('set_condition', { name: '生病', lastsDays: 0 }))
  try {
    await n2.svc.setCondition('kyu', { name: '生病', lastsDays: 1 })
    assert.equal((await n2.svc.home()).characters.kyu.conditions.length, 1)
    await n2.h(
      fakeReq('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '病好了清除吧' })),
      fakeRes(),
    )
    await until(async () => (await n2.svc.home()).characters.kyu.conditions.length === 0)
    assert.equal((await n2.svc.home()).characters.kyu.conditions.length, 0, 'lastsDays=0 清除该状态')
  } finally {
    await rmSafe(n2.dir)
  }
})

test('set_condition 非法输入：空 name / 负 startsInDays → 拒绝且 conditions 不动', async () => {
  const bad = [
    { name: '空 name', args: { name: '', lastsDays: 1 } },
    { name: '负 startsInDays', args: { name: '生病', startsInDays: -1 } },
  ]
  for (const c of bad) {
    const n = await setupNest(toolOnceStub('set_condition', c.args))
    try {
      await n.h(
        fakeReq('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '触发' })),
        fakeRes(),
      )
      await new Promise((r) => setTimeout(r, 350))
      assert.equal((await n.svc.home()).characters.kyu.conditions.length, 0, c.name + '：conditions 应保持空')
    } finally {
      await rmSafe(n.dir)
    }
  }
})

test('状态进角色上下文：active 与 pending 倒计时都在自己的 prompt 里', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catnest-idx-condctx-'))
  const ws = webServerStub()
  let captured = null
  const llmCap = {
    stream: (opts) => {
      // 第一轮捕获 user 场景文本；角色沉默（不调工具）
      if (!hasAssistantToolCall(opts.messages) && captured === null) {
        captured = opts.messages[0].content[0].text
      }
      return (async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const { ctx, provided } = mkCtx({ personas: PERSONAS_STUB, llm: llmCap })
  ctx.webServer = ws
  try {
    plugin.apply(ctx, { catnestDir: dir, tickRand: noRoll })
    const svc = provided.catnest
    const h = ws.routes[0].handler
    await h(fakeReq('POST', '/catnest/api/action', JSON.stringify({ op: 'open' })), fakeRes())
    await svc.moveMaster('living')
    await svc.moveCharacter('kyu', 'living')
    await svc.moveCharacter('moli', 'bedroom')
    // 预挂：进行中的发情 + 2 天后开始的生病（pending 倒计时）
    await svc.setCondition('kyu', { name: '发情', lastsDays: 1 })
    await svc.setCondition('kyu', { name: '生病', startsInDays: 2, lastsDays: 1 })
    await h(fakeReq('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '小玖，最近身体怎么样？' })), fakeRes())
    await until(async () => captured !== null)
    assert.ok(captured.includes('【你此刻的身体状态】'), '上下文应含自己的状态段')
    assert.ok(captured.includes('发情'), captured)
    assert.ok(captured.includes('还剩'), 'active 状态应带剩余倒计时: ' + captured.slice(captured.indexOf('【你此刻的身体状态】')))
    assert.ok(captured.includes('还有') && captured.includes('开始'), 'pending 应带开始倒计时')
    // 主动作路径：位置段仍只有 active 标注（pending 只给自己看）
    assert.ok(captured.includes('小玖在客厅（发情期中）'), captured.slice(0, 500))
  } finally {
    await rmSafe(dir)
  }
})

// ── 对话层·say 陪台词动作（2026-08-31）：action 参数 ──

test('say action：动作随台词入账、dialogue 透传、时间线同房可见/隔墙只闻声剥离动作', async () => {
  const dirA = await mkdtemp(join(tmpdir(), 'catnest-idx-action-'))
  const wsA = webServerStub()
  const prompts = []
  // 三轮台词队列：第一轮带动作，后两轮不带（验证无动作路径不受影响）
  const replyQueue = [
    { text: '喵，我在呢！', action: '蹭了蹭主人' },
    { text: '嗯嗯，什么事呀？' },
    { text: '来了来了。', action: '合上书' },
  ]
  const llmAct = {
    stream: (opts) => {
      const stop = hasAssistantToolCall(opts.messages)
      if (!stop) prompts.push({ system: opts.system, user: opts.messages[0].content[0].text })
      return (async function* () {
        if (stop) {
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        const r = replyQueue.shift() || {}
        yield { type: 'tool-call-delta', index: 0, id: 'call_a', name: 'say' }
        yield { type: 'tool-call-delta', index: 0, argumentsDelta: JSON.stringify(r) }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      })()
    },
  }
  const { ctx: ctxA, provided: providedA } = mkCtx({ personas: PERSONAS_STUB, llm: llmAct })
  ctxA.webServer = wsA
  try {
    plugin.apply(ctxA, { catnestDir: dirA, tickRand: noRoll })
    const svc = providedA.catnest
    const h = wsA.routes[0].handler
    const call = (method, url, body) => {
      const r = fakeRes()
      return h(fakeReq(method, url, body), r).then(() => r)
    }
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'open' }))
    await svc.moveMaster('living')
    await svc.moveCharacter('kyu', 'living')
    await svc.moveCharacter('moli', 'bedroom') // 墨璃卧室（与客厅相邻），不接客厅的话

    // 第 1 轮：小玖接话并带动作
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '小玖，我回来啦' }))
    await until(async () => {
      const t = await svc.transcript()
      return !!(t && t.lines.some((l) => l.rawText === '喵，我在呢！'))
    })
    // 入账：transcript 行带 action
    const t1 = await svc.transcript()
    const line1 = t1.lines.find((l) => l.rawText === '喵，我在呢！')
    assert.equal(line1.action, '蹭了蹭主人', 'transcript 行应透传 action')
    // dialogue 视图（前端对话流同源）透传 action
    const dv = JSON.parse((await call('GET', '/catnest/api/dialogue', null)).body)
    const dline = dv.lines.find((l) => l.text === '喵，我在呢！')
    assert.equal(dline.action, '蹭了蹭主人', 'dialogue 行应带 action 供前端渲染')
    assert.equal(dline.who, 'kyu')
    // 主人乐观上屏的行（master 说话）action 为空串不炸前端
    assert.ok(dv.lines.every((l) => typeof l.action === 'string'), '所有行 action 应为字符串')

    // 第 2 轮：小玖再接（不带动作）——自己的时间线应看见第 1 轮「动作＋台词」
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '今天怎么样' }))
    await until(async () => {
      const t = await svc.transcript()
      return !!(t && t.lines.some((l) => l.rawText === '嗯嗯，什么事呀？'))
    })
    const kyuPrompts = prompts.filter((p) => p.system.includes('成员小玖'))
    assert.ok(kyuPrompts.length >= 2, '小玖应被询问两次')
    const tlSection = (user) => {
      const start = user.indexOf('【这个时间片里发生的事】')
      const end = user.indexOf('【此刻的位置】')
      if (start < 0 || end < 0 || end <= start) return null
      return user.slice(start, end)
    }
    const h2 = tlSection(kyuPrompts[1].user)
    assert.ok(h2.includes('小玖（蹭了蹭主人）：喵，我在呢！'), '同房（含自己）应看见动作: ' + h2)
    // 第 2 轮自己的无动作台词：下一轮渲染应无括号
    // （本轮先验证触发句与旧行形态）
    assert.ok(h2.includes('今天怎么样'), '触发句在时间线里')

    // 第 3 轮：主人去卧室叫墨璃——墨璃的时间线里，客厅小玖的话是「隔墙闻声」：
    // 台词进、动作剥（视觉信息不入听觉）
    await svc.moveMaster('bedroom')
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '墨璃，过来一下' }))
    await until(async () => {
      const t = await svc.transcript()
      return !!(t && t.lines.some((l) => l.rawText === '来了来了。'))
    })
    const moliPrompts = prompts.filter((p) => p.system.includes('成员墨璃'))
    assert.ok(moliPrompts.length >= 1, '墨璃应被询问')
    const h3 = tlSection(moliPrompts[0].user)
    assert.ok(h3.includes('（客厅传来小玖的声音：）喵，我在呢！'), '隔墙台词以闻声前缀入账: ' + h3)
    assert.ok(!h3.includes('蹭了蹭主人'), '隔墙听不见动作（视觉信息剥离）: ' + h3)
    assert.ok(h3.includes('（客厅传来小玖的声音：）嗯嗯，什么事呀？'), '无动作台词闻声形态不变')
    // 墨璃自己的接话带动作 → 入账
    const t3 = await svc.transcript()
    const line3 = t3.lines.find((l) => l.rawText === '来了来了。')
    assert.equal(line3.action, '合上书')
  } finally {
    await rmSafe(dirA)
  }
})

test('隔墙话题：开完之后不限房间——卧室的墨璃看得见话题标记，也接得上', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catnest-idx-top3-'))
  const ws = webServerStub()
  const prompts = []
  const { ctx, provided } = mkCtx({ personas: PERSONAS_STUB, llm: silentCapture(prompts) })
  ctx.webServer = ws
  try {
    plugin.apply(ctx, { catnestDir: dir, tickRand: noRoll })
    const svc = provided.catnest
    const h = ws.routes[0].handler
    const call = (url, body) => h(fakeReq('POST', url, body), fakeRes()).then(() => {})
    await call('/catnest/api/action', JSON.stringify({ op: 'open' }))
    await svc.moveMaster('living')
    await svc.moveCharacter('kyu', 'living')
    await svc.moveCharacter('moli', 'living')
    // 当面开话题（开门门禁要求同房间）
    await svc.openTopic('kyu', '那盆花', '你看那盆花开了')
    // 墨璃走回卧室（与客厅相邻）；小玖在客厅继续说这条线 → 墨璃只闻声
    await svc.moveCharacter('moli', 'bedroom')
    await svc.say('kyu', '花开得真好', undefined, '那盆花')
    await svc.resolveTopicSay('kyu', '那盆花')
    // 主人去卧室说话 → 墨璃被询问，她时间线里客厅那条线 = 闻声 + 话题标记
    await svc.moveMaster('bedroom')
    await call('/catnest/api/action', JSON.stringify({ op: 'say', text: '墨璃，过来一下' }))
    await until(() => prompts.some((p) => p.system.includes('成员墨璃')))
    const moliP = prompts.find((p) => p.system.includes('成员墨璃'))
    assert.ok(
      moliP.user.includes('（客厅传来小玖的声音：）（聊那盆花）花开得真好'),
      '隔墙闻声也要带话题标记（否则接不上）: ' + moliP.user,
    )
    // 隔墙照样能接上这条线（开完不限房间）
    await svc.say('moli', '我在卧室也听见了', undefined, '那盆花')
    assert.equal((await svc.resolveTopicSay('moli', '那盆花')).matched, true)
    assert.equal((await svc.home()).topics['那盆花'].turns, 3, '1 开 + 1 小玖续谈 + 1 墨璃隔墙接话')
  } finally {
    await rmSafe(dir)
  }
})

// ── 调度层（SCHEDULING_DESIGN.md v1）──

// 沉默桩（带 prompt 捕获）：记录每回合第一步的 system + 完整 user 文本（上下文断言用）
const captureUser = (m) =>
  typeof m.content === 'string' ? m.content : (m.content || []).map((b) => (b && b.text) || '').join('')
const silentCapture = (out) => ({
  stream: (opts) => {
    const stop = hasAssistantToolCall(opts && opts.messages)
    if (!stop && opts && Array.isArray(opts.messages)) {
      out.push({ system: opts.system, user: captureUser(opts.messages[0]) })
    }
    return (async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  },
})

// 门控桩：所有 llm 调用阻塞在 gate 上直到 release（测队列忙跳过/边沿复检用），也捕 prompt
const makeGatedStub = (out) => {
  let release
  const gate = new Promise((r) => {
    release = r
  })
  return {
    release: () => release(),
    stream: (opts) => {
      const stop = hasAssistantToolCall(opts && opts.messages)
      if (!stop && opts && Array.isArray(opts.messages)) {
        out.push({ system: opts.system, user: captureUser(opts.messages[0]) })
      }
      return (async function* () {
        await gate
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

const readLog = async (dir, sliceId) => {
  const raw = await readFile(join(dir, 'slices', sliceId, 'log.jsonl'), 'utf8')
  return raw.trim().split('\n').map((l) => JSON.parse(l))
}

// 工具层便捷断言：角色此刻是否在忙（读家状态；暂停=不忙）
const isBusyOf = async (svc, id) => {
  const home = await svc.home()
  const ch = home.characters[id]
  return !!(ch && ch.activity && !ch.activityPaused)
}

test('notice 链路：私有只进本人时间线，公共原样进全员；私有不入他人 prompt', async () => {
  const dirN = await mkdtemp(join(tmpdir(), 'catnest-idx-notice-'))
  const wsN = webServerStub()
  const prompts = []
  const { ctx: ctxN, provided: providedN } = mkCtx({
    personas: PERSONAS_STUB,
    llm: silentCapture(prompts),
  })
  ctxN.webServer = wsN
  try {
    plugin.apply(ctxN, { catnestDir: dirN, tickRand: noRoll })
    const svc = providedN.catnest
    const hN = wsN.routes[0].handler
    const call = (method, url, body) => {
      const r = fakeRes()
      return hN(fakeReq(method, url, body), r).then(() => r)
    }
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'open' }))
    await svc.moveMaster('living')
    // 一条私有 notice（moli 的感知，缺省私有）+ 一条公共 notice（家庭事实，显式 false）
    await svc.notice('moli', 'master', '隔壁客厅传来主人的动静，已经几次了（见【最近听到的】）')
    await svc.notice('moli', 'moli', '墨璃做完了读书', false)
    // 两人默认都在客厅：主人说话 → 串行接话，两人都被问（捕获各自 prompt）
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '在吗' }))
    await until(async () => prompts.length >= 2)
    const kyuPrompt = prompts.find((p) => p.system.includes('你是"猫窝"家里的成员小玖'))
    const moliPrompt = prompts.find((p) => p.system.includes('你是"猫窝"家里的成员墨璃'))
    assert.ok(kyuPrompt && moliPrompt, '两角色的 prompt 都被捕获')
    // 公共 notice：kyu 原样可见；moli 自己带【你注意到】
    assert.ok(kyuPrompt.user.includes('墨璃做完了读书'), 'kyu 应看到公共 notice 原文')
    // 大地图 §8 的 T7 入场觉察也是私有 notice（有人走进你在的房间）——这里要排除它，
    // 只验证「别人的公共/私有 notice 不沾到 kyu」
    const kyuTimeline = kyuPrompt.user
      .split('【最近的时间线】')[1]
      ?.split('【')[0] ?? ''
    assert.ok(!kyuTimeline.includes('你注意到'), 'kyu 的时间线不应有【你注意到】')
    assert.ok(moliPrompt.user.includes('【你注意到】墨璃做完了读书'), 'moli 自己的公共 notice 带触发前缀')
    // 私有 notice：只进 moli 的时间线
    assert.ok(moliPrompt.user.includes('【你注意到】隔壁客厅传来主人的动静'), 'moli 看到自己的私有 notice')
    assert.ok(!kyuPrompt.user.includes('隔壁客厅传来主人的动静'), 'kyu 不应看到 moli 的私有 notice')
  } finally {
    await rmSafe(dirN)
  }
})

test('T1 唤醒：缓冲攒满边沿触发 notice+唤醒；in-flight 不重复入账；回合后缓冲未重满不再醒', async () => {
  const dirT1 = await mkdtemp(join(tmpdir(), 'catnest-idx-t1-'))
  const wsT1 = webServerStub()
  const prompts = []
  const gated = makeGatedStub(prompts)
  const { ctx: ctxT1, provided: providedT1 } = mkCtx({
    personas: PERSONAS_STUB,
    llm: gated,
  })
  ctxT1.webServer = wsT1
  try {
    plugin.apply(ctxT1, { catnestDir: dirT1, tickRand: noRoll })
    const svc = providedT1.catnest
    const hT1 = wsT1.routes[0].handler
    const call = (method, url, body) => {
      const r = fakeRes()
      return hT1(fakeReq(method, url, body), r).then(() => r)
    }
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'open' }))
    await svc.moveMaster('living')
    // 小玖在客厅连说 5 句（墨璃在厨房，阈值 5，隔墙攒满）
    await svc.moveCharacter('moli', 'kitchen')
    for (let i = 0; i < 5; i++) await svc.say('kyu', '动静' + i)
    // 主人第一句：T1 边沿 → 墨璃 notice 入账 + 唤醒入队（门控挂住）
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '在吗' }))
    const st = await svc.status()
    // T7 入场觉察（大地图 §8）也会写 notice 行，这里只数 T1 那条「听到的动静」
    const hears = (log0) => log0.filter((e) => e.type === 'notice' && /听到的/.test(e.text || ''))
    let log = await readLog(dirT1, st.sliceId)
    const notices = hears(log)
    assert.equal(notices.length, 1, '第一句触发一次 notice')
    assert.equal(notices[0].char, 'moli')
    assert.equal(notices[0].private, true)
    assert.ok(/传来.{1,6}的动静，已经几次了（见【最近听到的】）/.test(notices[0].text), notices[0].text)
    // 主人第二句（墨璃回合 in-flight、队列忙）：不重复入账、不叠加唤醒
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '还在吗' }))
    log = await readLog(dirT1, st.sliceId)
    assert.equal(hears(log).length, 1, '同批动静只入账一次（hearNotified 防刷屏）')
    // 放行门控：墨璃唤醒回合 → 小玖两次接话回合
    gated.release()
    await until(() => prompts.length >= 3)
    const moliPrompts = prompts.filter((p) => p.system.includes('你是"猫窝"家里的成员墨璃'))
    assert.equal(moliPrompts.length, 1, '墨璃只被唤醒一次（in-flight 期间不叠加）')
    const moliPrompt = moliPrompts[0]
    assert.ok(moliPrompt.user.includes('【最近听到的（隔墙动静）】'), '唤醒回合带【最近听到的】段')
    assert.ok((moliPrompt.user.match(/- 小玖：/g) || []).length >= 5, '5 条小玖的动静都在缓冲快照里')
    assert.ok(moliPrompt.user.includes('【你注意到】') && moliPrompt.user.includes('的动静，已经几次了'), 'notice 触发句在时间线里')
    const kyuPrompts = prompts.filter((p) => p.system.includes('你是"猫窝"家里的成员小玖'))
    assert.equal(kyuPrompts.length, 2, '小玖两次接话（主人各一句）')
    // 回合中攒下的新鲜动静（第二句「还在吗」）< 阈值 → 不触发再唤醒。
    // 注：「谁先到」取决于 moli 回合与第二句的微任务竞争——消费得早则缓冲空，
    // 消费得晚则那句新鲜动静一起被弹走。两种都合法，关键是旧动静不会留着掀被子。
    const home = await svc.home()
    const moliHear = home.characters.moli.hear
    assert.ok(moliHear.length <= 1, '旧动静已被回合消费，不该留着再掀被子')
    if (moliHear.length === 1) assert.equal(moliHear[0].text, '还在吗', '留下的只会是回合中新来的那条')
  } finally {
    await rmSafe(dirT1)
  }
})

test('T2 唤醒：pending→active 翻转 → 私有 notice + 唤醒；notifiedAt 一次性，二次 tick 不重复', async () => {
  const dirT2 = await mkdtemp(join(tmpdir(), 'catnest-idx-t2-'))
  const wsT2 = webServerStub()
  const prompts = []
  const { ctx: ctxT2, provided: providedT2 } = mkCtx({
    personas: PERSONAS_STUB,
    llm: silentCapture(prompts),
  })
  ctxT2.webServer = wsT2
  try {
    plugin.apply(ctxT2, { catnestDir: dirT2, tickRand: noRoll })
    const svc = providedT2.catnest
    await svc.open()
    // 主人在家：T6 自主轻推闸死（§9.1 触发闸=主人离家），T2 单向验证不被自主节奏污染
    await svc.moveMaster('living')
    // 手工造一个「刚跨过 startAt 未确认」的状态（等价于 pending 跨点被 tick 捕获）
    const homeP = join(dirT2, 'home.json')
    const home0 = JSON.parse(await readFile(homeP, 'utf8'))
    home0.characters.moli.conditions = [
      {
        id: 'c-t2',
        name: '发情',
        startAt: new Date(Date.now() - 3600000).toISOString(),
        endAt: new Date(Date.now() + 3 * 86400000).toISOString(),
      },
    ]
    await writeFile(homeP, JSON.stringify(home0, null, 2))
    // 手动 tick（观察期/测试入口；正常节奏 60s）
    await svc.tick()
    const st = await svc.status()
    const log = await readLog(dirT2, st.sliceId)
    // T7 入场觉察也写 notice 行，这里只数身体状态那条（source=body）
    const notices = log.filter((e) => e.type === 'notice' && e.source === 'body')
    assert.equal(notices.length, 1, '翻转触发一次 notice')
    assert.equal(notices[0].char, 'moli')
    assert.equal(notices[0].source, 'body')
    assert.equal(notices[0].private, true)
    assert.ok(notices[0].text.startsWith('你感觉到身体变了：发情期开始了'), notices[0].text)
    assert.ok(/还剩\d+天/.test(notices[0].text), notices[0].text)
    // notifiedAt 按轮次确认
    const home1 = await svc.home()
    const cond = home1.characters.moli.conditions.find((c) => c.name === '发情')
    assert.equal(cond.notifiedAt, cond.startAt, 'notifiedAt 一次性确认')
    // 唤醒回合：墨璃的 prompt 带 notice 触发句 + 自己的身体状态段
    await until(() => prompts.length >= 1)
    const moliPrompt = prompts.find((p) => p.system.includes('你是"猫窝"家里的成员墨璃'))
    assert.ok(moliPrompt, '墨璃被 T2 唤醒')
    assert.ok(moliPrompt.user.includes('【你注意到】你感觉到身体变了：发情期开始了'), moliPrompt.user)
    assert.ok(moliPrompt.user.includes('【你此刻的身体状态】'), '自己的状态段在场')
    assert.ok(/发情期中（还剩\d+天/.test(moliPrompt.user), 'active 倒计时可见')
    // 二次 tick：notifiedAt 已确认 → 不重复 notice、不重复唤醒
    await svc.tick()
    const log2 = await readLog(dirT2, st.sliceId)
    assert.equal(log2.filter((e) => e.type === 'notice' && e.source === 'body').length, 1, '一次性翻转不重复')
    assert.equal(prompts.length, 1, '不重复唤醒')
  } finally {
    await rmSafe(dirT2)
  }
})

test('T3 唤醒：activity 到期 → 静默清除 + 公共 notice「做完了事」+ 唤醒本人；他人原样可见', async () => {
  const dirT3 = await mkdtemp(join(tmpdir(), 'catnest-idx-t3-'))
  const wsT3 = webServerStub()
  const prompts = []
  const { ctx: ctxT3, provided: providedT3 } = mkCtx({
    personas: PERSONAS_STUB,
    llm: silentCapture(prompts),
  })
  ctxT3.webServer = wsT3
  try {
    plugin.apply(ctxT3, { catnestDir: dirT3, tickRand: noRoll })
    const svc = providedT3.catnest
    const hT3 = wsT3.routes[0].handler
    const call = (method, url, body) => {
      const r = fakeRes()
      return hT3(fakeReq(method, url, body), r).then(() => r)
    }
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'open' }))
    // 主人在家：T6 自主轻推闸死，T3 单向验证不被自主节奏污染
    await svc.moveMaster('living')
    // 墨璃挪去厨房：主人这次入场没有她（免得大地图 §8 的 T7 入场觉察污染「他人视角」断言），
    // 她的活动照旧在厨房里读书、照旧由 T3 到期唤醒
    await svc.moveCharacter('moli', 'kitchen')
    await svc.setActivity('moli', '读书', 30)
    // 把 activityEndsAt 拨到过去（等价于 30 分钟到期）
    const homeP = join(dirT3, 'home.json')
    const home0 = JSON.parse(await readFile(homeP, 'utf8'))
    home0.characters.moli.activityEndsAt = new Date(Date.now() - 1000).toISOString()
    await writeFile(homeP, JSON.stringify(home0, null, 2))
    await svc.tick()
    const st = await svc.status()
    const log = await readLog(dirT3, st.sliceId)
    // T7 入场觉察也写 notice 行，这里只数 T3 那条公共「做完了事」
    const notices = log.filter((e) => e.type === 'notice' && e.source === 'moli')
    assert.equal(notices.length, 1)
    assert.equal(notices[0].char, 'moli')
    assert.equal(notices[0].private, false, 'T3 是唯一公共事件')
    assert.equal(notices[0].text, '墨璃做完了读书')
    // 活动静默清除
    const home1 = await svc.home()
    assert.equal(home1.characters.moli.activity, null)
    assert.equal(home1.characters.moli.activityEndsAt, null)
    // 本人唤醒：prompt 带触发句
    await until(() => prompts.length >= 1)
    const moliPrompt = prompts.find((p) => p.system.includes('你是"猫窝"家里的成员墨璃'))
    assert.ok(moliPrompt && moliPrompt.user.includes('【你注意到】墨璃做完了读书'), '本人 prompt 带触发句')
    // 他人视角：公共 notice 原样进时间线
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '墨璃忙完了吗' }))
    await until(() => prompts.filter((p) => p.system.includes('你是"猫窝"家里的成员小玖')).length >= 1)
    const kyuPrompt = prompts.find((p) => p.system.includes('你是"猫窝"家里的成员小玖'))
    assert.ok(kyuPrompt.user.includes('墨璃做完了读书'), 'kyu 时间线原样可见公共 notice')
    // kyu 自己也会有私有 notice（大地图 §8 的 T7 入场觉察带【你注意到】前缀），
    // 所以要验的是「别人那条公共事件没有被她自己的前缀带着」——按行挑出那一句。
    const thatLine = kyuPrompt.user.split('\n').find((l) => l.includes('墨璃做完了读书'))
    assert.ok(!thatLine.includes('你注意到'), '公共 notice 在他人视角不带【你注意到】前缀：' + thatLine)
  } finally {
    await rmSafe(dirT3)
  }
})

// ── 路 B §9（2026-09-05 三轮定稿）：topic 套件 / 放下锅铲 / T6 自主节奏 ──

test('open_topic 工具接线：开话题 → topic-open 账本行 + 开场白 say 带 about + topics 状态', async () => {
  const n = await setupNest(toolOnceForStub('小玖', 'open_topic', { about: '那盆花', text: '你看那盆花开了' }))
  try {
    await n.svc.moveCharacter('moli', 'living') // 话题是姐妹之间同房间的工具，得让墨璃在场
    await n.h(
      fakeReq('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '小玖，我出门逛逛' })),
      fakeRes(),
    )
    await until(async () => {
      const topics = (await n.svc.home()).topics || {}
      return topics['那盆花'] !== undefined
    })
    await until(async () => {
      const st = await n.svc.status()
      const log = await readLog(n.dir, st.sliceId)
      return log.some((e) => e.type === 'topic-open' && e.char === 'kyu')
    })
    const topics = (await n.svc.home()).topics
    assert.equal(topics['那盆花'].openedBy, 'kyu')
    assert.equal(topics['那盆花'].status, 'open')
    assert.deepEqual(topics['那盆花'].participants, ['kyu', 'moli'], '同房间在场即参与')
    const st = await n.svc.status()
    const log = await readLog(n.dir, st.sliceId)
    const sayLine = log.find((e) => e.type === 'say' && e.who === 'kyu')
    assert.equal(sayLine.about, '那盆花', '开场白 say 带 about')
    assert.ok(log.some((e) => e.type === 'topic-open' && e.about === '那盆花'))
  } finally {
    await rmSafe(n.dir)
  }
})

test('end_topic 工具接线：收话题 → topic-end 账本行 + 状态 closing；无参与话题报错', async () => {
  const n = await setupNest(toolOnceForStub('小玖', 'end_topic', { about: '那盆花', text: '那先聊到这' }))
  try {
    await n.svc.moveCharacter('moli', 'living')
    // 先手动建立话题（墨璃在同房，开得起来；同房在场即参与，不需要再接话）
    await n.svc.openTopic('kyu', '那盆花', '你看那盆花开了')
    await n.svc.say('moli', '我想看看', undefined, '那盆花')
    await n.svc.resolveTopicSay('moli', '那盆花')
    // 主人说话 → 只有小玖的回合调 end_topic（墨璃的桩沉默，不跟着收）
    await n.h(
      fakeReq('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '我回来啦，聊什么呢' })),
      fakeRes(),
    )
    await until(async () => {
      const x = ((await n.svc.home()).topics || {})['那盆花']
      return x && x.status === 'closing'
    })
    const st = await n.svc.status()
    const log = await readLog(n.dir, st.sliceId)
    const endLine = log.find((e) => e.type === 'topic-end' && e.about === '那盆花')
    assert.ok(endLine, 'topic-end 行入账')
    const endSay = log.find((e) => e.type === 'say' && e.who === 'kyu' && e.text === '那先聊到这')
    assert.equal(endSay.about, '那盆花', '收尾句带 about')
    // 不存在的收话题：拒绝（lib 层抛错；execTool 兜底成 fail）
    await assert.rejects(() => n.svc.endTopic('kyu', '月亮'), /没有你参与的/)
  } finally {
    await rmSafe(n.dir)
  }
})

test('say.about 门禁降级（§9.2 修订）：话题不存在 → 话照说入账、不当失败（§9.20 一步直调）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catnest-idx-top2-'))
  const ws = webServerStub()
  const captured = []
  const { ctx, provided } = mkCtx({
    personas: PERSONAS_STUB,
    llm: captureToolStub(captured, '小玖', 'say', { text: '那盆花开了', about: '不存在的线' }),
  })
  ctx.webServer = ws
  try {
    plugin.apply(ctx, { catnestDir: dir, tickRand: noRoll })
    const svc = provided.catnest
    const h = ws.routes[0].handler
    const call = (url, body) => h(fakeReq('POST', url, body), fakeRes()).then(() => {})
    await call('/catnest/api/action', JSON.stringify({ op: 'open' }))
    await svc.moveMaster('living')
    await svc.moveCharacter('kyu', 'living')
    await svc.moveCharacter('moli', 'bedroom')
    await call('/catnest/api/action', JSON.stringify({ op: 'say', text: '小玖在吗' }))
    await until(() => captured.filter((c) => c.system.includes('成员小玖')).length >= 1)
    await new Promise((r) => setTimeout(r, 120))
    const kyuSteps = captured.filter((c) => c.system.includes('成员小玖'))
    // §9.20 一步直调（2026-09-20 主人拍板）：说了话且没有工具失败即收尾，不再有第二步收手
    // 调用，所以这里从「2 次 stream」变成「1 次」。门禁降级本身由下面的账本断言保证。
    assert.equal(kyuSteps.length, 1, '§9.20：说话成功即收尾，不再多问一次')
    const st = await svc.status()
    const log = await readLog(dir, st.sliceId)
    const row = log.find((e) => e.type === 'say' && e.who === 'kyu')
    assert.ok(row, '台词必须入账（旧行为是整句被话题门禁吞掉）')
    assert.ok(!row.about, '降级后不挂话题标记，实际：' + JSON.stringify(row.about))
  } finally {
    await rmSafe(dir)
  }
})

test('open_topic 范围门禁：房间里没有别的猫娘 / to 指向不在同房的姐妹 → 都拒绝', async () => {
  const n = await setupNest(silentStub)
  try {
    await n.svc.moveCharacter('kyu', 'living')
    await n.svc.moveCharacter('moli', 'bedroom')
    await assert.rejects(() => n.svc.openTopic('kyu', '那盆花', '你看那盆花开了'), /没有别的猫娘/)
    await assert.rejects(() => n.svc.openTopic('kyu', '那盆花', '你看那盆花开了', 'moli'), /不在你所在的房间/)
    // 墨璃回到同房：开得起来，to 指定的人进参与者
    await n.svc.moveCharacter('moli', 'living')
    const r = await n.svc.openTopic('kyu', '那盆花', '你看那盆花开了', '墨璃')
    assert.equal(r.opened, true)
    assert.deepEqual((await n.svc.home()).topics['那盆花'].participants, ['kyu', 'moli'])
  } finally {
    await rmSafe(n.dir)
  }
})

test('pause_activity 工具接线：放下锅铲 → activityPaused + activity-pause 账本行 + isBusy 变不忙', async () => {
  const n = await setupNest(toolOnceStub('pause_activity', {}))
  try {
    await n.svc.setActivity('kyu', '做饭', 30)
    assert.equal(await isBusyOf(n.svc, 'kyu'), true, '做事中=忙')
    await n.h(
      fakeReq('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '小玖你先歇会儿' })),
      fakeRes(),
    )
    await until(async () => (await n.svc.home()).characters.kyu.activityPaused === true)
    const home = await n.svc.home()
    assert.equal(home.characters.kyu.activity, '做饭')
    assert.equal(home.characters.kyu.activityEndsAt, null, '暂停=endsAt 冻结')
    assert.equal(await isBusyOf(n.svc, 'kyu'), false, '暂停=不忙')
    const st = await n.svc.status()
    const log = await readLog(n.dir, st.sliceId)
    assert.ok(log.some((e) => e.type === 'activity-pause' && e.char === 'kyu' && e.activity === '做饭'))
  } finally {
    await rmSafe(n.dir)
  }
})

test('say.about 渲染 + 【当前话题】presence：话题内发言带标记，常驻动态窗口', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catnest-idx-top1-'))
  const ws = webServerStub()
  const prompts = []
  const { ctx, provided } = mkCtx({ personas: PERSONAS_STUB, llm: silentCapture(prompts) })
  ctx.webServer = ws
  try {
    plugin.apply(ctx, { catnestDir: dir, tickRand: noRoll })
    const svc = provided.catnest
    const h = ws.routes[0].handler
    const call = (url, body) => h(fakeReq('POST', url, body), fakeRes()).then(() => {})
    await call('/catnest/api/action', JSON.stringify({ op: 'open' }))
    await svc.moveMaster('living')
    await svc.openTopic('kyu', '那盆花', '你看那盆花开了')
    await svc.say('moli', '我想看看', undefined, '那盆花')
    await svc.resolveTopicSay('moli', '那盆花')
    await call('/catnest/api/action', JSON.stringify({ op: 'say', text: '那盆花长势如何' }))
    await until(() => prompts.length >= 2)
    const kyuP = prompts.find((p) => p.system.includes('你是"猫窝"家里的成员小玖'))
    const moliP = prompts.find((p) => p.system.includes('你是"猫窝"家里的成员墨璃'))
    assert.ok(kyuP && moliP, '两个角色的回合都有')
    assert.ok(kyuP.user.includes('墨璃（聊那盆花）：我想看看'), '话题内发言带（聊X）渲染')
    assert.ok(moliP.user.includes('小玖（聊那盆花）：你看那盆花开了'), 'moli 视角开场白带标记')
    assert.ok(moliP.user.includes('【当前话题】'), '话题常驻动态窗口')
    assert.ok(moliP.user.includes('那盆花（小玖发起，已聊 2 轮）'), moliP.user)
    assert.ok(moliP.user.includes('现在是 '), '时钟行在场')
    assert.ok(moliP.user.includes('小玖（聊那盆花）：你看那盆花开了'), 'moli 视角开场白带标记')
  } finally {
    await rmSafe(dir)
  }
})

test('T6 门控：离家轻推（每 tick 至多一只）；睡觉/忙/刚说过不推；主人在家闸死', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catnest-idx-t6-'))
  const ws = webServerStub()
  const prompts = []
  const { ctx, provided } = mkCtx({ personas: PERSONAS_STUB, llm: silentCapture(prompts) })
  ctx.webServer = ws
  try {
    plugin.apply(ctx, { catnestDir: dir, tickRand: noRoll })
    const svc = provided.catnest
    const st0 = await svc.open()
    // 1) 主人从未交互（atHome=false 默认、无任何 master 行）→ tick 轻推
    //    （串行队列：同 tick 至多一只，队列忙则跳过、下次 tick 重评）
    await svc.tick()
    await until(() => prompts.length >= 1)
    await new Promise((r) => setTimeout(r, 150))
    const t6Prompts = prompts.filter((p) => p.user.includes('家里很安静，你闲下来了'))
    assert.equal(t6Prompts.length, 1, '每 tick 至多一只')
    const st = await svc.status()
    const log = await readLog(dir, st.sliceId)
    const t6Notices = log.filter((e) => e.type === 'notice' && e.text === '家里很安静，你闲下来了')
    assert.equal(t6Notices.length, 1, 'notice 只在成功排回合时入账')
    assert.equal(t6Notices[0].source, 'self')
    assert.equal(t6Notices[0].private, true)
    // 2) 小玖睡觉（§9.14：睡觉归 activity 管，不再是 condition）→ 下次 tick 推墨璃
    await svc.setActivity('kyu', '睡觉', 480)
    const n0 = prompts.length
    await svc.tick()
    await until(() => prompts.length >= n0 + 1)
    await new Promise((r) => setTimeout(r, 150))
    const moliTurn = prompts.slice(n0).find((p) => p.system.includes('你是"猫窝"家里的成员墨璃'))
    assert.ok(moliTurn, '在睡觉（activity）的小玖被排除，推的是墨璃')
    assert.ok(!prompts.slice(n0).some((p) => p.system.includes('成员小玖')), '小玖不被推')
    // 3) 小玖起床并在忙；墨璃刚说过话（5min 冷却）→ tick 无人被推
    await svc.setActivity('kyu', '读书', 60)
    await svc.say('moli', '喵')
    const n1 = prompts.length
    await svc.tick()
    await new Promise((r) => setTimeout(r, 250))
    assert.equal(prompts.length, n1, '忙的不推、冷却期的不推')
    // 4) 主人在家：闸死（T6 触发闸=atHome===false）
    await svc.moveMaster('living')
    const n2 = prompts.length
    await svc.tick()
    await new Promise((r) => setTimeout(r, 250))
    assert.equal(prompts.length, n2, '主人在家 T6 不触发')
  } finally {
    await rmSafe(dir)
  }
})

test('T6 静默闸只认 activity（§9.14）：生病等 condition 期间照旧被自主节奏唤醒', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catnest-idx-t6cond-'))
  const ws = webServerStub()
  const prompts = []
  const { ctx, provided } = mkCtx({ personas: PERSONAS_STUB, llm: silentCapture(prompts) })
  ctx.webServer = ws
  try {
    plugin.apply(ctx, { catnestDir: dir, tickRand: noRoll })
    const svc = provided.catnest
    await svc.open()
    await svc.setCondition('kyu', { name: '生病', lastsDays: 2 })
    await svc.tick()
    await until(() =>
      prompts.some((p) => p.system.includes('成员小玖') && p.user.includes('家里很安静，你闲下来了')),
    )
    assert.ok(true, '生病不占注意力 → 照旧轻推（condition 不再参与静默闸）')
  } finally {
    await rmSafe(dir)
  }
})

test('T6 无产出退避（§9.14）：推过一次还没产出 → 同一只不重复推（冷却从上次轻推起算）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catnest-idx-t6back-'))
  const ws = webServerStub()
  const prompts = []
  const { ctx, provided } = mkCtx({ personas: PERSONAS_STUB, llm: silentCapture(prompts) })
  ctx.webServer = ws
  try {
    plugin.apply(ctx, { catnestDir: dir, tickRand: noRoll })
    const svc = provided.catnest
    await svc.open()
    const kyuNudges = () =>
      prompts.filter((p) => p.system.includes('成员小玖') && p.user.includes('家里很安静，你闲下来了')).length
    await svc.tick()
    await until(() => kyuNudges() >= 1)
    await new Promise((r) => setTimeout(r, 150))
    await svc.tick()
    await new Promise((r) => setTimeout(r, 300))
    await svc.tick()
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(kyuNudges(), 1, '一个字没说（无产出）→ 退避生效，不重复推同一只')
    const st = await svc.status()
    const log = await readLog(dir, st.sliceId)
    const notices = log.filter(
      (e) => e.type === 'notice' && e.text === '家里很安静，你闲下来了' && e.char === 'kyu',
    )
    assert.equal(notices.length, 1, 'notice 也只入账一次')
  } finally {
    await rmSafe(dir)
  }
})


// ── 回合末统一自查（2026-09-10 主人定案）──
// 桩：第一步 say 一句「我先去书房…」，第二步沉默（模型把位移当台词说掉就收手），
// 只有收到自查退回（messages 里出现「自查」）才补一次 move_to。
const selfCheckMoveStub = (sayText, room) => {
  let moved = false
  return {
    stream: (opts) => {
      const msgs = (opts && opts.messages) || []
      const called = hasAssistantToolCall(msgs)
      const nudged = msgs.some(
        (m) =>
          Array.isArray(m.content) &&
          m.content.some((b) => b.type === 'text' && typeof b.text === 'string' && b.text.includes('自查')),
      )
      return (async function* () {
        if (!called) {
          yield { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'say' }
          yield { type: 'tool-call-delta', index: 0, argumentsDelta: JSON.stringify({ text: sayText }) }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        if (nudged && !moved) {
          moved = true
          yield { type: 'tool-call-delta', index: 0, id: 'call_2', name: 'move_to' }
          yield { type: 'tool-call-delta', index: 0, argumentsDelta: JSON.stringify({ room }) }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

test('回合末自查：说了去书房却没调 move_to → 退回补齐（已在账上的台词不撤）', async () => {
  const n = await setupNest(selfCheckMoveStub('嗯嗯，姐姐慢慢说喵～小玖去书房把代码清干净，弄好了就回来！', '书房'))
  try {
    assert.equal((await n.svc.home()).characters.kyu.room, 'living')
    await n.h(
      fakeReq('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '小玖先去书房等我吧' })),
      fakeRes(),
    )
    await until(async () => (await n.svc.home()).characters.kyu.room === 'study')
    const st = await n.svc.status()
    const log = await readLog(n.dir, st.sliceId)
    assert.equal(log.filter((e) => e.type === 'say' && e.who === 'kyu').length, 1, '台词只入账一次')
    // setupNest 建场时也写过一条 move（living→living），这里只看真的挪去书房的那条
    assert.equal(
      log.filter((e) => e.type === 'move' && e.char === 'kyu' && e.to === 'study').length,
      1,
      '自查后补上一次移动去书房',
    )
  } finally {
    await rmSafe(n.dir)
  }
})

test('回合末自查：对别人说「你去书房」（无自称）不误伤，不退回不补步', async () => {
  let calls = 0
  const stub = {
    stream: (opts) => {
      calls++
      const called = hasAssistantToolCall((opts && opts.messages) || [])
      return (async function* () {
        if (!called) {
          yield { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'say' }
          yield {
            type: 'tool-call-delta',
            index: 0,
            argumentsDelta: JSON.stringify({ text: '主人你去书房看看吧，那儿安静' }),
          }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const n = await setupNest(stub)
  try {
    await n.h(
      fakeReq('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '小玖在吗' })),
      fakeRes(),
    )
    await until(async () => calls >= 1)
    await new Promise((r) => setTimeout(r, 120))
    assert.equal(calls, 1, '§9.20 一步直调：say 一步成功即收尾（原来还要一次收手调用），没有自查退回')
    assert.equal((await n.svc.home()).characters.kyu.room, 'living', '位置不变')
  } finally {
    await rmSafe(n.dir)
  }
})

test('§9.20：有工具失败时仍留第二步补救机会（收手确认只砍成功的那一步）', async () => {
  let calls = 0
  const stub = {
    stream: (opts) => {
      calls++
      const called = hasAssistantToolCall((opts && opts.messages) || [])
      return (async function* () {
        if (!called) {
          // 第一步：说一句 + 拿一个不存在的东西（工具失败 → 必须留一步补救机会）
          yield { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'say' }
          yield { type: 'tool-call-delta', index: 0, argumentsDelta: JSON.stringify({ text: '我去拿那个东西' }) }
          yield { type: 'tool-call-delta', index: 1, id: 'call_2', name: 'take_item' }
          yield { type: 'tool-call-delta', index: 1, argumentsDelta: JSON.stringify({ name: '压根不存在的东西' }) }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const n = await setupNest(stub)
  try {
    await n.h(
      fakeReq('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '小玖在吗' })),
      fakeRes(),
    )
    await until(async () => calls >= 2)
    await new Promise((r) => setTimeout(r, 120))
    assert.ok(calls >= 2, '说话那一步里有工具失败，仍然给了第二次调用（补救机会没被砍掉）')
  } finally {
    await rmSafe(n.dir)
  }
})

test('主人说话不再有 500 字上限（2026-09-10 定案下掉）', async () => {
  const n = await setupNest(silentStub)
  try {
    const long = '喵'.repeat(1200)
    const res = fakeRes()
    await n.h(fakeReq('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: long })), res)
    assert.equal(res.code, 200, '超长消息照常入账：' + String(res.body))
    const t = await n.svc.transcript()
    assert.ok(t.lines.some((l) => l.type === 'say' && l.who === 'master' && l.rawText === long))
  } finally {
    await rmSafe(n.dir)
  }
})

test('在家自由互动开关：API 落盘 + state 暴露（离家那档不动）', async () => {
  const n = await setupNest(silentStub)
  try {
    const call = (method, url, body) => {
      const res = fakeRes()
      return n.h(fakeReq(method, url, body), res).then(() => res)
    }
    // 默认关：主人在家也不自动跑（省 API、不抢主人模型槽位）
    let st = JSON.parse((await call('GET', '/catnest/api/state')).body)
    assert.equal(st.autonomy.homeOn, false)
    // 打开 → state 立刻反映（前端按钮点亮靠它）
    const r = await call('POST', '/catnest/api/action', JSON.stringify({ op: 'autonomy', homeOn: true }))
    assert.equal(JSON.parse(r.body).autonomy.homeOn, true)
    st = JSON.parse((await call('GET', '/catnest/api/state')).body)
    assert.equal(st.autonomy.homeOn, true)
    // 关回去 → 落盘持久（账本版本随 HOME_VERSION 走，别再硬编码）
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'autonomy', homeOn: false }))
    const homeJson = JSON.parse(await readFile(join(n.dir, 'home.json'), 'utf8'))
    assert.equal(homeJson.autonomy.homeOn, false)
    assert.equal(homeJson.version, HOME_VERSION)
    // 服务面同口径
    assert.deepEqual(await n.svc.setAutonomy({ homeOn: true }), { autonomy: { homeOn: true } })
    assert.deepEqual(await n.svc.autonomy(), { homeOn: true })
  } finally {
    await rmSafe(n.dir)
  }
})

test('参考话题引子：姐妹自由聊天给、状态唤醒与主人接话都不给', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catnest-idx-seeds-'))
  const ws = webServerStub()
  const prompts = []
  const { ctx, provided } = mkCtx({ personas: PERSONAS_STUB, llm: sayCaptureStub([], prompts) })
  ctx.webServer = ws
  try {
    plugin.apply(ctx, { catnestDir: dir, tickRand: noRoll })
    const svc = provided.catnest
    const h = ws.routes[0].handler
    const call = (body) => h(fakeReq('POST', '/catnest/api/action', JSON.stringify(body)), fakeRes()).then(() => {})
    await call({ op: 'open' })
    await svc.moveMaster('living')
    await svc.moveCharacter('moli', 'living')
    await svc.moveCharacter('kyu', 'study') // 与小玖相邻：隔墙攒动静
    // 墨璃在客厅连说 3 句 → 小玖缓冲攒满（阈值 3），最后一条来自姐妹
    await svc.say('moli', '铺垫一')
    await svc.say('moli', '铺垫二')
    await svc.say('moli', '铺垫三')
    // 造一次回合：给墨璃写一个"已到期"的活动，tick（T3）把她叫醒；
    // 她回合末的全屋复检再把攒满的小玖捞起来——这就是 T1 的正常路径
    await expireActivity(dir, 'moli')
    await svc.tick()
    await until(() => prompts.some((p) => p.system.includes('成员小玖')))
    const kyuP = prompts.find((p) => p.system.includes('成员小玖'))
    assert.ok(kyuP.user.includes('姐妹之间可以聊的'), 'T1 姐妹动静唤醒 → 给引子')
    assert.ok(kyuP.user.includes('关于书房'), '场地档只认她当前房间（书房）')
    // 状态/活动类唤醒（T3）不给引子
    const moliT3 = prompts.find((p) => p.system.includes('成员墨璃'))
    assert.ok(moliT3, '墨璃被活动到期叫醒')
    assert.ok(!moliT3.user.includes('姐妹之间可以聊的'), '状态/活动类唤醒不给引子')
    // 主人说话后的直接接话不给引子
    await call({ op: 'say', text: '你俩在聊什么' })
    await until(() => prompts.some((p) => p.system.includes('成员墨璃') && p.user.includes('你俩在聊什么')))
    const moliSay = prompts.find((p) => p.system.includes('成员墨璃') && p.user.includes('你俩在聊什么'))
    assert.ok(!moliSay.user.includes('姐妹之间可以聊的'), '主人接话不给引子')
  } finally {
    await rmSafe(dir)
  }
})

test('参考话题引子：她本人还挂着话题时不注入', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catnest-idx-seeds2-'))
  const ws = webServerStub()
  const prompts = []
  const { ctx, provided } = mkCtx({ personas: PERSONAS_STUB, llm: sayCaptureStub([], prompts) })
  ctx.webServer = ws
  try {
    plugin.apply(ctx, { catnestDir: dir, tickRand: noRoll })
    const svc = provided.catnest
    const h = ws.routes[0].handler
    const call = (body) => h(fakeReq('POST', '/catnest/api/action', JSON.stringify(body)), fakeRes()).then(() => {})
    await call({ op: 'open' })
    await svc.moveMaster('living')
    await svc.moveCharacter('kyu', 'living')
    await svc.moveCharacter('moli', 'living')
    // 当面开一条话题（小玖是参与方），随后小玖走开干活——话题还挂着
    await svc.openTopic('kyu', '那盆花', '你看那盆花开了')
    await svc.moveCharacter('kyu', 'study')
    await svc.say('moli', '铺垫一')
    await svc.say('moli', '铺垫二')
    await svc.say('moli', '铺垫三')
    await expireActivity(dir, 'moli')
    await svc.tick()
    await until(() => prompts.some((p) => p.system.includes('成员小玖')))
    const kyuP = prompts.find((p) => p.system.includes('成员小玖'))
    assert.ok(!kyuP.user.includes('姐妹之间可以聊的'), '正在聊一条线时不放新引子')
    assert.ok(kyuP.user.includes('那盆花'), '她确实还挂在这条话题上（引子闸才有意义）')
  } finally {
    await rmSafe(dir)
  }
})

test('pick_topic 工具：按当前房间给引子，也能点类目', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catnest-idx-picktopic-'))
  const ws = webServerStub()
  const seen = []
  const { ctx, provided } = mkCtx({
    personas: PERSONAS_STUB,
    llm: toolOnceMessagesStub('墨璃', 'pick_topic', { category: '书房' }, seen),
  })
  ctx.webServer = ws
  try {
    plugin.apply(ctx, { catnestDir: dir, tickRand: noRoll })
    const svc = provided.catnest
    const h = ws.routes[0].handler
    const call = (body) => h(fakeReq('POST', '/catnest/api/action', JSON.stringify(body)), fakeRes()).then(() => {})
    await call({ op: 'open' })
    await svc.moveMaster('kitchen')
    await svc.moveCharacter('moli', 'kitchen')
    await svc.moveCharacter('kyu', 'living')
    await call({ op: 'say', text: '姐姐，找点话说' })
    await until(() => seen.length > 1)
    // 第二轮 messages 带回执：点了类目就按类目给，并带"只是引子"的用法说明
    const flat = JSON.stringify(seen[seen.length - 1].messages)
    assert.ok(flat.includes('关于书房'), '点了类目就按类目给: ' + flat.slice(-300))
    assert.ok(flat.includes('别把话题念出来'), '回执带用法说明')
    // 服务面：不指定类目就按当前房间（墨璃在厨房）
    const auto = await svc.topicSeeds('moli')
    assert.equal(auto.room.label, '关于厨房')
    assert.equal(auto.room.items.length, 3)
    assert.equal(auto.other.items.length, 2)
    const bad = await svc.topicSeeds('moli', { category: '天台' })
    assert.equal(bad.error, 'NO_CATEGORY')
  } finally {
    await rmSafe(dir)
  }
})

test('家当（HOUSE_DESIGN §1）：prompt 只注入自己所在房间的东西，挪房即换，隔壁看不见', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catnest-idx-things-'))
  const ws = webServerStub()
  const prompts = []
  const llm = {
    stream: (opts) => {
      const stop = hasAssistantToolCall(opts.messages)
      if (!stop) prompts.push({ system: opts.system, user: opts.messages[0].content[0].text })
      return (async function* () {
        if (stop) {
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        yield { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'say' }
        yield { type: 'tool-call-delta', index: 0, argumentsDelta: JSON.stringify({ text: '嗯' }) }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      })()
    },
  }
  const { ctx, provided } = mkCtx({ personas: PERSONAS_STUB, llm })
  ctx.webServer = ws
  try {
    plugin.apply(ctx, { catnestDir: dir, tickRand: noRoll })
    const svc = provided.catnest
    const h = ws.routes[0].handler
    const call = (method, url, body) => {
      const r = fakeRes()
      return h(fakeReq(method, url, body), r).then(() => r)
    }
    const kyuPrompts = () => prompts.filter((p) => p.system.includes('成员小玖'))
    const lastKyuUser = () => {
      const list = kyuPrompts()
      return list.length > 0 ? list[list.length - 1].user : null
    }
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'open' }))
    await svc.moveMaster('study')
    await svc.moveCharacter('kyu', 'study')

    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '在忙吗' }))
    await until(() => kyuPrompts().length >= 1)
    const u1 = lastKyuUser()
    assert.ok(
      u1.includes('【屋里有什么】书房：书桌、书架、台灯、电脑'),
      '书房家当行: ' + u1.slice(-200),
    )
    assert.ok(!u1.includes('沙发'), '隔壁客厅有什么看不见')

    // 挪去客厅：同一份 prompt 里家当行跟着换
    await svc.moveCharacter('kyu', 'living')
    await svc.moveMaster('living')
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '过来坐' }))
    await until(() => kyuPrompts().length >= 2)
    const u2 = lastKyuUser()
    assert.ok(u2.includes('【屋里有什么】客厅：'), '挪房即换家当行')
    assert.ok(u2.includes('电视（关着）'), '带状态的物品渲染成括号')
    assert.ok(!u2.includes('书桌'), '离开书房后看不见书房的东西')
  } finally {
    await rmSafe(dir)
  }
})

test('家当记账口径（2026-09-19 主人定）：只记长期存在的东西与状态，prompt 写明瞬态不记', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catnest-idx-itemrule-'))
  const ws = webServerStub()
  const calls = []
  const llm = {
    stream: (opts) => {
      const stop = hasAssistantToolCall(opts.messages)
      if (!stop) calls.push({ system: opts.system, tools: opts.tools })
      return (async function* () {
        if (stop) {
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        yield { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'say' }
        yield { type: 'tool-call-delta', index: 0, argumentsDelta: JSON.stringify({ text: '嗯' }) }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      })()
    },
  }
  const { ctx, provided } = mkCtx({ personas: PERSONAS_STUB, llm })
  ctx.webServer = ws
  try {
    plugin.apply(ctx, { catnestDir: dir, tickRand: noRoll })
    const svc = provided.catnest
    const h = ws.routes[0].handler
    const call = (method, url, body) => {
      const r = fakeRes()
      return h(fakeReq(method, url, body), r).then(() => r)
    }
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'open' }))
    await svc.moveMaster('living')
    await svc.moveCharacter('kyu', 'living')
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '在吗' }))
    await until(() => calls.length >= 1)
    const { system, tools } = calls[0]
    assert.ok(system.includes('长期在那儿的东西'), 'system 段写明家当只记长期的东西')
    assert.ok(system.includes('用完就没的不用记账'), 'system 段写明饭菜茶水不入账')
    const desc = {}
    for (const t of tools || []) desc[t.name] = t.description || ''
    const d = (name) => desc[name] || ''
    assert.ok(d('set_item_state').includes('转眼就变'), 'set_item_state 写明瞬态状态不记')
    assert.ok(d('put_item').includes('用完就没的'), 'put_item 写明一次性物品不入账')
    assert.ok(d('take_item').includes('长期'), 'take_item 写明只管长期的东西')
  } finally {
    await rmSafe(dir)
  }
})

test('家当编辑接口（House §2）：setItems 整表替换 + 快照同步，校验失败报错且不改账本', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catnest-idx-items-'))
  const ws = webServerStub()
  const { ctx, provided } = mkCtx({ personas: PERSONAS_STUB, llm: llmStub('嗯') })
  ctx.webServer = ws
  try {
    plugin.apply(ctx, { catnestDir: dir, tickRand: noRoll })
    assert.ok(provided.catnest, '服务面已提供')
    const h = ws.routes[0].handler
    const call = (method, url, body) => {
      const r = fakeRes()
      return h(fakeReq(method, url, body), r).then(() => r)
    }
    const act = (payload) => call('POST', '/catnest/api/action', JSON.stringify(payload))

    // 进货 50 个消婴器
    const ok = await act({
      op: 'setItems',
      room: 'living',
      items: [{ name: '沙发' }, { name: '消婴器', count: 50, state: '新的' }],
    })
    assert.equal(ok.code, 200)
    // 主人视角快照立刻反映（面板卡片靠它）
    let st = JSON.parse((await call('GET', '/catnest/api/state')).body)
    assert.deepEqual(st.rooms.find((r) => r.id === 'living').items, [
      { name: '沙发', state: null, count: 1 },
      { name: '消婴器', state: '新的', count: 50 },
    ])
    // 服务面同口径
    const svcItems = await provided.catnest.setRoomItems('study', [{ name: '台灯', state: '亮着' }])
    assert.deepEqual(svcItems.items, [{ name: '台灯', state: '亮着', count: 1 }])
    // 校验失败：500 + 消息，账本保持原样
    const bad = await act({ op: 'setItems', room: 'living', items: [{ name: '椅子' }, { name: '椅子' }] })
    assert.equal(bad.code, 500)
    assert.ok(String(JSON.parse(bad.body).error).includes('同名'), '错误消息可读: ' + bad.body)
    const noRoom = await act({ op: 'setItems', room: 'attic', items: [] })
    assert.equal(noRoom.code, 500)
    st = JSON.parse((await call('GET', '/catnest/api/state')).body)
    assert.equal(st.rooms.find((r) => r.id === 'living').items.length, 2, '报错后账本没动')
  } finally {
    await rmSafe(dir)
  }
})

test('say 话题降级（§9.2 修订）：about 指向已收掉的话题，台词照常入账不丢', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catnest-idx-about-'))
  const ws = webServerStub()
  const line = '那条线都收了我还是想说完喵'
  const llm = {
    stream: (opts) => {
      const stop = hasAssistantToolCall(opts.messages)
      return (async function* () {
        if (stop) {
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        yield { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'say' }
        yield {
          type: 'tool-call-delta',
          index: 0,
          argumentsDelta: JSON.stringify({ text: line, about: '早就收掉的话题' }),
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      })()
    },
  }
  const { ctx, provided } = mkCtx({ personas: PERSONAS_STUB, llm })
  ctx.webServer = ws
  try {
    plugin.apply(ctx, { catnestDir: dir, tickRand: noRoll })
    const svc = provided.catnest
    const h = ws.routes[0].handler
    const call = (method, url, body) => {
      const r = fakeRes()
      return h(fakeReq(method, url, body), r).then(() => r)
    }
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'open' }))
    await svc.moveMaster('study')
    await svc.moveCharacter('kyu', 'study')
    await svc.moveCharacter('moli', 'study') // open_topic 要求同房有姐妹
    await svc.openTopic('kyu', '早就收掉的话题', '开个头')
    await svc.moveCharacter('moli', 'bedroom') // 再支开她，只留小玖一个接话人
    const homePath = join(dir, 'home.json')
    const home = JSON.parse(await readFile(homePath, 'utf8'))
    for (const x of Object.values(home.topics || {})) x.status = 'ended'
    await writeFile(homePath, JSON.stringify(home))
    // 主人说一句 → 小玖接话，她的 say 挂了个没了的话题
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '在吗' }))
    const findLine = async () => {
      const t = await svc.transcript()
      // transcript 给的是人话化文本（「小玖：…」），原文在 rawText
      return ((t && t.lines) || []).find(
        (l) => l.type === 'say' && l.who === 'kyu' && String(l.rawText || l.text || '').includes(line),
      )
    }
    await until(async () => !!(await findLine()))
    const row = await findLine()
    assert.ok(row, '台词必须入账（旧行为是整句被话题门禁吞掉，主人看到「说了又没了」）')
    assert.ok(!row.about, '降级后不挂话题标记，实际：' + JSON.stringify(row.about))
  } finally {
    await rmSafe(dir)
  }
})

test('家当工具接线（House §4）：猫娘 take_item 入账，下一轮时间线看得见', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catnest-idx-itemtool-'))
  const ws = webServerStub()
  const prompts = []
  const llm = {
    stream: (opts) => {
      const mine = typeof opts.system === 'string' && opts.system.includes('成员小玖')
      const stop = !mine || hasAssistantToolCall(opts.messages)
      if (mine && !stop) prompts.push(opts.messages[0].content[0].text)
      return (async function* () {
        if (stop) {
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        yield { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'take_item' }
        yield { type: 'tool-call-delta', index: 0, argumentsDelta: JSON.stringify({ name: '消婴器', count: 2 }) }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      })()
    },
  }
  const { ctx, provided } = mkCtx({ personas: PERSONAS_STUB, llm })
  ctx.webServer = ws
  try {
    plugin.apply(ctx, { catnestDir: dir, tickRand: noRoll })
    const svc = provided.catnest
    const h = ws.routes[0].handler
    const call = (method, url, body) => {
      const r = fakeRes()
      return h(fakeReq(method, url, body), r).then(() => r)
    }
    const livingItems = async () => {
      const st = JSON.parse((await call('GET', '/catnest/api/state')).body)
      return st.rooms.find((r) => r.id === 'living').items
    }
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'open' }))
    await svc.moveMaster('living')
    await svc.moveCharacter('kyu', 'living')
    await svc.moveCharacter('moli', 'bedroom') // 只留小玖一个
    await svc.setRoomItems('living', [{ name: '消婴器', count: 5 }], 'master')
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '零食到了' }))
    await until(async () => {
      const items = await livingItems()
      return items.length === 1 && items[0].count === 3
    })
    // 账本：by=kyu 的 took 行
    const st = await svc.status()
    const rows = (await readFile(join(dir, 'slices', st.sliceId, 'log.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    const took = rows.find((r) => r.type === 'items' && r.by === 'kyu' && r.took)
    assert.ok(took, '猫娘的动作入了账')
    assert.deepEqual(took.took, [{ name: '消婴器', count: 2 }])
    // 下一轮 prompt 的片内时间线里有人话（她下一轮就知道自己拿了几个）
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '还剩几个' }))
    await until(() => prompts.length >= 2)
    const last = prompts[prompts.length - 1]
    assert.ok(last.includes('小玖从客厅拿走了 消婴器×2'), '时间线里有家当变更：' + last.slice(-300))
  } finally {
    await rmSafe(dir)
  }
})

// ── §9.16（2026-09-16）：说话音量 + 跨片过期活动不补发唤醒 ──

test('say 音量（§9.16）：小声不出屋 / 大声隔壁真切，隔墙也听得清', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catnest-idx-vol-'))
  const ws = webServerStub()
  const { ctx, provided } = mkCtx({ personas: PERSONAS_STUB })
  ctx.webServer = ws
  try {
    plugin.apply(ctx, { catnestDir: dir, tickRand: noRoll })
    const svc = provided.catnest
    await svc.open()
    await svc.moveMaster('living')
    await svc.moveCharacter('kyu', 'living')
    await svc.moveCharacter('moli', 'kitchen') // 隔壁
    // 小声 = 耳语：隔壁的墨璃一个字都听不见（2026-09-16 主人要的「和姐姐耳语」）
    await svc.say('kyu', '这句只说给主人听', undefined, undefined, '小声')
    assert.equal((await svc.hear('moli')).buffer.length, 0, '耳语不出屋')
    // 大声 = 喊：隔壁进缓冲（闻声，不是看见形态）
    const r = await svc.say('kyu', '姐姐——！', undefined, undefined, '大声')
    assert.ok(r.faint.includes('moli'))
    assert.ok(r.urgent.includes('moli'), '真切到当场叫人')
    const st = await svc.status()
    const log = await readLog(dir, st.sliceId)
    const rows = log.filter((e) => e.type === 'say')
    assert.equal(rows[0].volume, '小声')
    assert.equal(rows[1].volume, '大声')
    assert.deepEqual(rows[0].audience.silent, ['moli'], '听不见也记账（复盘用）')
    assert.deepEqual(rows[1].audience.faint, ['moli'])
    // 忙碌降半档：埋头做事的猫，隔壁的大声落到"隐约"，不被一嗓子打断
    await svc.setActivity('moli', '修bug', 60)
    const r2 = await svc.say('kyu', '姐姐，吃饭啦！', undefined, undefined, '大声')
    assert.ok(r2.faint.includes('moli'), '忙也听得见')
    assert.ok(!r2.urgent.includes('moli'), '忙 → 不当场叫醒（工作状态下隔壁的大声降半档）')
    // 时间线渲染：隔墙的真切写成「喊声」，同房的小声标「低声」
    const tl = await svc.transcript()
    assert.ok(
      tl.lines.some((l) => l.type === 'say' && l.volume === '大声'),
      '音量随 transcript 出给前端做字号',
    )
  } finally {
    await rmSafe(dir)
  }
})

test('say 工具带 volume（§9.16）：角色喊一声 → 隔壁被当场唤醒（大喊 notice + 回合）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catnest-idx-voltool-'))
  const ws = webServerStub()
  const prompts = []
  // 小玖的桩：调 say(volume=大声)；其他角色沉默
  const llm = {
    stream: (opts) => {
      const mine = typeof opts.system === 'string' && opts.system.includes('成员小玖')
      const stop = !mine || hasAssistantToolCall(opts.messages)
      if (mine && !stop && Array.isArray(opts.messages)) prompts.push(captureUser(opts.messages[0]))
      return (async function* () {
        if (stop) {
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        yield { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'say' }
        yield {
          type: 'tool-call-delta',
          index: 0,
          argumentsDelta: JSON.stringify({ text: '姐姐，汤好了——！', volume: '大声' }),
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      })()
    },
  }
  const { ctx, provided } = mkCtx({ personas: PERSONAS_STUB, llm })
  ctx.webServer = ws
  try {
    plugin.apply(ctx, { catnestDir: dir, tickRand: noRoll })
    const svc = provided.catnest
    const h = ws.routes[0].handler
    const call = (method, url, body) => {
      const r = fakeRes()
      return h(fakeReq(method, url, body), r).then(() => r)
    }
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'open' }))
    await svc.moveMaster('living')
    await svc.moveCharacter('kyu', 'living')
    await svc.moveCharacter('moli', 'kitchen')
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '小玖？' }))
    await until(async () => {
      const l = await readLog(dir, (await svc.status()).sliceId)
      return l.some((e) => e.type === 'say' && e.who === 'kyu' && e.volume === '大声')
    })
    await until(async () => {
      const l = await readLog(dir, (await svc.status()).sliceId)
      return l.some((e) => e.type === 'notice' && /大喊，清清楚楚/.test(e.text || ''))
    })
    const log = await readLog(dir, (await svc.status()).sliceId)
    const clamor = log.find((e) => e.type === 'notice' && /大喊，清清楚楚/.test(e.text || ''))
    assert.equal(clamor.char, 'moli', '被叫醒的是隔壁的墨璃')
    assert.equal(clamor.private, true)
    assert.ok(/隔壁客厅传来小玖的一声大喊/.test(clamor.text), clamor.text)
    const sayRow = log.filter((e) => e.type === 'say' && e.who === 'kyu').pop()
    assert.equal(sayRow.volume, '大声', '音量入账')
    assert.ok(sayRow.audience.faint.includes('moli'), '隔壁闻声（看不见形态）')
    // 隔壁的墨璃确实被排了回合，且【最近听到的】里有那句喊话
    await until(() => prompts.length >= 1)
  } finally {
    await rmSafe(dir)
  }
})

test('POST say 音量：小声=耳语不出屋；大声=全屋清晰（2026-09-20 简化版）并当场叫醒隔壁', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catnest-idx-mvol-'))
  const ws = webServerStub()
  const prompts = []
  const { ctx, provided } = mkCtx({ personas: PERSONAS_STUB, llm: silentCapture(prompts) })
  ctx.webServer = ws
  try {
    plugin.apply(ctx, { catnestDir: dir, tickRand: noRoll })
    const svc = provided.catnest
    const h = ws.routes[0].handler
    const call = (method, url, body) => {
      const r = fakeRes()
      return h(fakeReq(method, url, body), r).then(() => r)
    }
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'open' }))
    await svc.moveMaster('living')
    await svc.moveCharacter('kyu', 'living')
    await svc.moveCharacter('moli', 'kitchen') // 隔壁
    // 主人耳语（面板选小声）：隔壁的墨璃一个字都听不到
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '姐姐，只跟你说', volume: '小声' }))
    assert.equal((await svc.hear('moli')).buffer.length, 0, '耳语不出客厅')
    // 主人喊一声（面板选大声）：隔壁听得清，当场被叫醒
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '姐姐——！', volume: '大声' }))
    await until(async () => {
      const l = await readLog(dir, (await svc.status()).sliceId)
      return l.some((e) => e.type === 'notice' && /大喊，清清楚楚/.test(e.text || ''))
    })
    const log = await readLog(dir, (await svc.status()).sliceId)
    const clamor = log.find((e) => e.type === 'notice' && /大喊，清清楚楚/.test(e.text || ''))
    assert.equal(clamor.char, 'moli')
    assert.ok(/隔壁客厅传来主人的一声大喊/.test(clamor.text), clamor.text)
    const rows = (await svc.transcript()).lines.filter((l) => l.type === 'say')
    assert.equal(rows[0].volume, '小声', '耳语音量入账（前端按它调字号）')
    assert.equal(rows[1].volume, '大声')
    await until(() => prompts.some((p) => p.system.includes('成员墨璃') && p.user.includes('姐姐——！')))
    const moliPrompt = prompts.find((p) => p.system.includes('成员墨璃') && p.user.includes('姐姐——！'))
    assert.ok(
      moliPrompt.user.includes('主人（大声）：姐姐——！'),
      '2026-09-20 简化版：大声全屋清晰，隔墙也按听得清的口径入账（不再弱化成「传来…的喊声」）：' + moliPrompt.user.slice(-400),
    )
    // 小声那句不进隔壁的时间线（耳语就是耳语）
    assert.ok(!moliPrompt.user.includes('姐姐，只跟你说'), '耳语不出现在隔壁的时间线里')
  } finally {
    await rmSafe(dir)
  }
})

test('T3 过时到期（§9.16）：停摆期间溜走的到期静默结算，不补发「做完了」也不唤醒', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catnest-idx-stale-'))
  const ws = webServerStub()
  const prompts = []
  const { ctx, provided } = mkCtx({ personas: PERSONAS_STUB, llm: silentCapture(prompts) })
  ctx.webServer = ws
  try {
    plugin.apply(ctx, { catnestDir: dir, tickRand: noRoll })
    const svc = provided.catnest
    await svc.open()
    await svc.moveMaster('living') // 主人在家（顺带把 T6 闸上）
    const homePath = join(dir, 'home.json')
    const home = JSON.parse(await readFile(homePath, 'utf8'))
    const nowMs = Date.now()
    // 小玖那只：40 分钟前就到期了（家在这段时间里根本没在跑）
    home.characters.kyu.activity = '睡觉'
    home.characters.kyu.activityEndsAt = new Date(nowMs - 40 * 60000).toISOString()
    // 墨璃那只：刚到期（正常 tick 该给的那一声）
    home.characters.moli.activity = '读书'
    home.characters.moli.activityEndsAt = new Date(nowMs - 60 * 1000).toISOString()
    await writeFile(homePath, JSON.stringify(home))
    await svc.tick()
    const st = await svc.status()
    const log = await readLog(dir, st.sliceId)
    const done = log.filter((e) => e.type === 'notice' && /做完了/.test(e.text || ''))
    assert.equal(done.length, 1, '只有新鲜到期才补发「做完了」，实际：' + JSON.stringify(done.map((d) => d.text)))
    assert.equal(done[0].char, 'moli')
    const h = await svc.home()
    assert.equal(h.characters.kyu.activity, null, '过时到期静默结算（状态照样清）')
    assert.equal(h.characters.moli.activity, null)
    await until(() => prompts.some((p) => p.system.includes('成员墨璃')))
    assert.ok(
      !prompts.some((p) => p.system.includes('成员小玖')),
      '过时的那只不被唤醒——「下午 6 点才睡醒」就是这么来的',
    )
  } finally {
    await rmSafe(dir)
  }
})

// ── §9.17（2026-09-16）：打字机兜底入账 ──

test('say 工具参数没解析出来（截断/裸换行）→ 打字机里的台词兜底入账，不再半透明消失', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catnest-idx-draft-'))
  const ws = webServerStub()
  const prompts = []
  // 复刻 2026-09-16 12:02:54 那轮：模型调了 say，argumentsDelta 把 text 吐出来（打字机
  // 有字），但 JSON 不合法（这里给一个没闭合的字符串）→ 工具失败、台词原本要丢
  const llm = {
    stream: (opts) => {
      const mine = typeof opts.system === 'string' && opts.system.includes('成员小玖')
      const stop = !mine || hasAssistantToolCall(opts.messages)
      if (mine && !stop && Array.isArray(opts.messages)) {
        prompts.push({ system: opts.system, user: captureUser(opts.messages[0]) })
      }
      return (async function* () {
        if (stop) {
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        yield { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'say' }
        yield { type: 'tool-call-delta', index: 0, argumentsDelta: '{"text":"诶——笨猫？我尾巴都要炸了喵' }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      })()
    },
  }
  const { ctx, provided } = mkCtx({ personas: PERSONAS_STUB, llm })
  ctx.webServer = ws
  try {
    plugin.apply(ctx, { catnestDir: dir, tickRand: noRoll })
    const svc = provided.catnest
    const h = ws.routes[0].handler
    const call = (method, url, body) => {
      const r = fakeRes()
      return h(fakeReq(method, url, body), r).then(() => r)
    }
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'open' }))
    await svc.moveMaster('living')
    await svc.moveCharacter('kyu', 'living')
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '小玖？' }))
    await until(() =>
      prompts.some((p) => p.system.includes('成员小玖')),
    )
    // 等一下兜底落账
    const st = await svc.status()
    await until(async () => {
      const lines = ((await svc.transcript()).lines || []).filter(
        (l) => l.type === 'say' && l.who === 'kyu',
      )
      return lines.length > 0
    })
    const rows = ((await svc.transcript()).lines || []).filter((l) => l.type === 'say' && l.who === 'kyu')
    assert.equal(rows[0].rawText, '诶——笨猫？我尾巴都要炸了喵', '打字机吐出来的话必须入账，实际：' + JSON.stringify(rows[0].rawText))
    const log = await readLog(dir, st.sliceId)
    const kyuSay = log.filter((e) => e.type === 'say' && e.who === 'kyu')
    assert.ok(kyuSay.length === 1, '只补一次，不重复入账')
    // 工具失败照样落诊断，兜底也留痕
    const dbg = await readFile(join(dir, 'slices', st.sliceId, 'agent-debug.log'), 'utf8')
    assert.ok(/工具失败 say/.test(dbg), '工具失败仍然落盘')
    assert.ok(/打字机兜底入账（工具调用没落地）/.test(dbg), '兜底也留痕，实际：' + dbg.slice(-400))
  } finally {
    await rmSafe(dir)
  }
})

test('say 正常落账时不会重复兜底（说出口一次就一次）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catnest-idx-draft2-'))
  const ws = webServerStub()
  const prompts = []
  const { ctx, provided } = mkCtx({ personas: PERSONAS_STUB, llm: sayToolStub('姐姐，汤好了') })
  ctx.webServer = ws
  try {
    plugin.apply(ctx, { catnestDir: dir, tickRand: noRoll })
    const svc = provided.catnest
    const h = ws.routes[0].handler
    const call = (method, url, body) => {
      const r = fakeRes()
      return h(fakeReq(method, url, body), r).then(() => r)
    }
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'open' }))
    await svc.moveMaster('living')
    await svc.moveCharacter('kyu', 'living')
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '小玖？' }))
    await until(async () => {
      const rows = ((await svc.transcript()).lines || []).filter((l) => l.type === 'say' && l.who === 'kyu')
      return rows.length > 0
    })
    await new Promise((r) => setTimeout(r, 250))
    const rows = ((await svc.transcript()).lines || []).filter((l) => l.type === 'say' && l.who === 'kyu')
    assert.equal(rows.length, 1, '正常路径只入账一次，兜底不该再补一条')
    assert.equal(rows[0].rawText, '姐姐，汤好了')
    void prompts
  } finally {
    await rmSafe(dir)
  }
})

// ── §9.18 发情周期日历 + 每日随机身体状态（2026-09-17 主人拍板）──

const stateOf = async (h) => {
  const r = fakeRes()
  await h(fakeReq('GET', '/catnest/api/state'), r)
  return JSON.parse(r.body)
}

test('§9.18 周期日历：首结算按猫播种（姐姐 4 天 / 小玖 9 天，错开），state 常驻可见', async () => {
  const n = await setupNest(silentStub)
  try {
    const day = 86400000
    await n.svc.tick()
    const home = await n.svc.home()
    const kyu = new Date(home.cycles.kyu.nextStart).getTime()
    const moli = new Date(home.cycles.moli.nextStart).getTime()
    assert.equal(Math.round((kyu - moli) / day), 5, '第一轮错开 5 天（姐姐 4 天 / 小玖 9 天）')
    assert.equal(home.cycles.kyu.gapDays, 40, '小玖 40 天一轮')
    assert.equal(home.cycles.moli.gapDays, 30, '姐姐 30 天一轮')
    assert.equal(home.cycles.kyu.durDays, 3)
    assert.equal(home.characters.kyu.conditions.length, 0, '还早 → 不写 pending，她的上下文干净')
    const st = await stateOf(n.h)
    const kc = st.characters.find((c) => c.id === 'kyu')
    assert.ok(kc.cycle, '主人的那份日历常驻在 state 里')
    assert.equal(kc.cycle.gapDays, 40)
    assert.equal(kc.cycle.phase, 'idle')
    assert.ok(kc.cycle.afterStart, '再下一次是虚线预计')
  } finally {
    await rmSafe(n.dir)
  }
})

test('§9.18 周期到点：临近写 pending（source=system）→ 到点走既有 T2 唤醒', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catnest-idx-cyc2-'))
  const ws = webServerStub()
  const prompts = []
  const { ctx, provided } = mkCtx({ personas: PERSONAS_STUB, llm: silentCapture(prompts) })
  ctx.webServer = ws
  try {
    plugin.apply(ctx, { catnestDir: dir, tickRand: noRoll })
    const svc = provided.catnest
    await svc.open()
    await svc.tick()
    const day = 86400000
    // 手工把姐姐的下一轮挪进临近窗口（1 天后开始）
    const home = await svc.home()
    const startMs = Date.now() + day
    home.cycles.moli.nextStart = new Date(startMs).toISOString()
    home.cycles.moli.nextEnd = new Date(startMs + 3 * day).toISOString()
    home.cycles.moli.seeded = false
    await writeFile(join(dir, 'home.json'), JSON.stringify(home, null, 2))
    await svc.tick()
    const h2 = await svc.home()
    const c = h2.characters.moli.conditions.find((x) => x.name === '发情')
    assert.ok(c, '临近 2 天 → 写进 conditions（这时她才看得到倒计时）')
    assert.equal(c.source, 'system')
    assert.equal(c.cycleDays, undefined, '条件不自带周期，续轮归 cycles 表')
    assert.equal(h2.characters.kyu.conditions.length, 0, '还早的那只不写')
    // 到点：把这一轮的开始挪到此刻之前 → 下一次 tick 的 T2 翻转并唤醒
    const h3 = await svc.home()
    const live = h3.characters.moli.conditions.find((x) => x.name === '发情')
    live.startAt = new Date(Date.now() - 1000).toISOString()
    delete live.notifiedAt
    await writeFile(join(dir, 'home.json'), JSON.stringify(h3, null, 2))
    await svc.tick()
    const st = await svc.status()
    const log = await readLog(dir, st.sliceId)
    assert.ok(
      log.some((e) => e.type === 'notice' && String(e.text).includes('你感觉到身体变了')),
      '到点走 T2：告知她本人身体变了',
    )
    await until(() => prompts.some((p) => p.system.includes('成员墨璃')))
    void prompts
  } finally {
    await rmSafe(dir)
  }
})

test('§9.18 每日随机身体状态：命中写 condition（system + 自确认）+ 当场告知唤醒；一天只一个', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catnest-idx-reg-'))
  const ws = webServerStub()
  const prompts = []
  const { ctx, provided } = mkCtx({ personas: PERSONAS_STUB, llm: silentCapture(prompts) })
  ctx.webServer = ws
  try {
    plugin.apply(ctx, { catnestDir: dir, tickRand: () => 0 }) // 必中：chance 判定过、抽第一项、选第一只猫
    const svc = provided.catnest
    await svc.open()
    await svc.tick()
    const home = await svc.home()
    const c = home.characters.kyu.conditions.find((x) => x.source === 'system')
    assert.ok(c, '命中：家里给了一只猫一个身体状态')
    assert.equal(c.name, '精神特别好')
    assert.equal(c.notifiedAt, c.startAt, '自确认：告知由调度层当场发，不让 T2 再来一次')
    const st = await svc.status()
    const log = await readLog(dir, st.sliceId)
    assert.ok(
      log.some((e) => e.type === 'notice' && e.private === true && e.text === c.note),
      '私有 notice 进她的时间线',
    )
    await until(() => prompts.some((p) => p.system.includes('成员小玖')))
    // 一天一个：再 tick 不叠第二个（rolledOn 落盘）
    await svc.tick()
    const h2 = await svc.home()
    assert.equal(h2.characters.kyu.conditions.filter((x) => x.source === 'system').length, 1)
    assert.equal(h2.characters.moli.conditions.filter((x) => x.source === 'system').length, 0)
    // 来路进 state（主人那边看得到是谁给的）
    const state = await stateOf(ws.routes[0].handler)
    const kc = state.characters.find((x) => x.id === 'kyu')
    assert.equal(kc.conditions[0].source, 'system')
    assert.equal(kc.conditions[0].note, c.note)
  } finally {
    await rmSafe(dir)
  }
})

// 2026-09-22 埋点：llmStep 每步落一行诊断（首字节/总耗时/帧数/finish/正文与推理字数/usage）。
// 起因：当天傍晚 18:39~19:00 连撞 8 次 150s 软超时，而旧日志只有「本步无结果」一行，
// 分不清「首字节根本没来（上游排队）」还是「吐到一半停住（截断）」。
const usageDiagStub = (text) => ({
  stream: (opts) => {
    const stop = hasAssistantToolCall(opts && opts.messages)
    return (async function* () {
      if (stop) {
        yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 22 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield { type: 'reasoning-delta', index: 0, text: '嗯……主人问的是晚饭。' }
      yield { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'say' }
      yield { type: 'tool-call-delta', index: 0, argumentsDelta: JSON.stringify({ text }) }
      yield {
        type: 'usage',
        usage: { inputTokens: 15234, outputTokens: 6120, cacheReadTokens: 14000, reasoningTokens: 4300 },
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    })()
  },
})

test('llmStep 落诊断：首字节/帧数/finish 原因/正文与推理字数/usage 都进 agent-debug', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catnest-idx-diag-'))
  const ws = webServerStub()
  const { ctx, provided } = mkCtx({ personas: PERSONAS_STUB, llm: usageDiagStub('姐姐，汤好了') })
  ctx.webServer = ws
  try {
    plugin.apply(ctx, { catnestDir: dir, tickRand: noRoll })
    const svc = provided.catnest
    const h = ws.routes[0].handler
    const call = (method, url, body) => {
      const r = fakeRes()
      return h(fakeReq(method, url, body), r).then(() => r)
    }
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'open' }))
    await svc.moveMaster('living')
    await svc.moveCharacter('kyu', 'living')
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '小玖？' }))
    const st = await svc.status()
    await until(async () => {
      const lines = ((await svc.transcript()).lines || []).filter((l) => l.type === 'say' && l.who === 'kyu')
      return lines.length > 0
    })
    const dbg = await readFile(join(dir, 'slices', st.sliceId, 'agent-debug.log'), 'utf8')
    const tail = '实际：' + dbg.slice(-500)
    assert.ok(/LLM 步完成：/.test(dbg), '每步落一行诊断，' + tail)
    assert.ok(/首字节=\d+\.\ds/.test(dbg), '记首字节，' + tail)
    assert.ok(/帧=\d+/.test(dbg), '记帧数，' + tail)
    assert.ok(/finish=tool-calls/.test(dbg), 'finish 取 kind 而不是 [object Object]，' + tail)
    assert.ok(!/\[object Object\]/.test(dbg), '不许出现 [object Object]，' + tail)
    assert.ok(/推理=11字/.test(dbg), 'reasoning-delta 累计字数（11 字），' + tail)
    assert.ok(/in=15234/.test(dbg) && /out=6120/.test(dbg) && /cache=14000/.test(dbg), 'usage 落盘，' + tail)
  } finally {
    await rmSafe(dir)
  }
})
