// dsh-catnest index.js 接线冒烟：stub ctx 跑宿主服务全接口
// （含角色调度层：personas 名册 / llm 打断反应与收尾蒸馏 / memory 落域）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import plugin from '../index.js'

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
    plugin.apply(ctx, { catnestDir: dir })
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
    plugin.apply(ctx, { catnestDir: dir })
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
    plugin.apply(ctx, { catnestDir: dir2 })
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
    plugin.apply(ctx, { catnestDir: dir })
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
    plugin.apply(ctx, { catnestDir: dir })
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
    plugin.apply(ctx, { catnestDir: dir })
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
    plugin.apply(ctx, { catnestDir: dir })
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
    plugin.apply(ctx, { catnestDir: dir })
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
    plugin.apply(ctx2, { catnestDir: dir2 })
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
    plugin.apply(ctx, { catnestDir: dir })
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
    plugin.apply(ctx2, { catnestDir: dir2 })
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
    plugin.apply(ctx, { catnestDir: dir })
    assert.equal(ws.routes.length, 1)
    assert.equal(ws.routes[0].path, '/catnest/api')
    const handler = ws.routes[0].handler

    // GET state：未开片
    let res = fakeRes()
    await handler(fakeReq('GET', '/catnest/api/state'), res)
    assert.equal(res.code, 200)
    const view = JSON.parse(res.body)
    assert.ok(Array.isArray(view.rooms) && view.rooms.length >= 5)
    assert.deepEqual(view.master, { atHome: false, room: null })

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
    plugin.apply(ctx3, { catnestDir: dir3 })
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
    plugin.apply(ctx4, { catnestDir: dir4 })
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
    plugin.apply(ctx6, { catnestDir: dir6 })
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
    plugin.apply(ctx7, { catnestDir: dir7 })
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
    plugin.apply(ctx8, { catnestDir: dir8 })
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
    plugin.apply(ctxC, { catnestDir: dirC })
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
    plugin.apply(ctx9, { catnestDir: dir9 })
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
    plugin.apply(ctx5, { catnestDir: dir5 })
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
    plugin.apply(ctx6, { catnestDir: dir6 })
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
    plugin.apply(ctx7, { catnestDir: dir7 })
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
    plugin.apply(ctxTy1, { catnestDir: dirTy1 })
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
    plugin.apply(ctxTy2, { catnestDir: dirTy2 })
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
  plugin.apply(ctx, { catnestDir: dir })
  const svc = provided.catnest
  const h = ws.routes[0].handler
  await h(fakeReq('POST', '/catnest/api/action', JSON.stringify({ op: 'open' })), fakeRes())
  await svc.moveMaster('living')
  await svc.moveCharacter('kyu', 'living')
  await svc.moveCharacter('moli', 'bedroom') // 墨璃不在同房，只有小玖被询问
  return { dir, svc, h }
}

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
    plugin.apply(ctx, { catnestDir: dir })
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
    plugin.apply(ctxA, { catnestDir: dirA })
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
    plugin.apply(ctxN, { catnestDir: dirN })
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
    assert.ok(!kyuPrompt.user.includes('你注意到'), 'kyu 的时间线不应有【你注意到】')
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
    plugin.apply(ctxT1, { catnestDir: dirT1 })
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
    let log = await readLog(dirT1, st.sliceId)
    const notices = log.filter((e) => e.type === 'notice')
    assert.equal(notices.length, 1, '第一句触发一次 notice')
    assert.equal(notices[0].char, 'moli')
    assert.equal(notices[0].private, true)
    assert.ok(/传来.{1,6}的动静，已经几次了（见【最近听到的】）/.test(notices[0].text), notices[0].text)
    // 主人第二句（墨璃回合 in-flight、队列忙）：不重复入账、不叠加唤醒
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '还在吗' }))
    log = await readLog(dirT1, st.sliceId)
    assert.equal(log.filter((e) => e.type === 'notice').length, 1, '同批动静只入账一次（hearNotified 防刷屏）')
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
    // 回合中攒下的新鲜动静（第二句「还在吗」）< 阈值 → 不触发再唤醒
    const home = await svc.home()
    assert.equal(home.characters.moli.hear.length, 1, '回合后缓冲只剩新鲜的一条，未达阈值不再醒')
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
    plugin.apply(ctxT2, { catnestDir: dirT2 })
    const svc = providedT2.catnest
    await svc.open()
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
    const notices = log.filter((e) => e.type === 'notice')
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
    assert.equal(log2.filter((e) => e.type === 'notice').length, 1, '一次性翻转不重复')
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
    plugin.apply(ctxT3, { catnestDir: dirT3 })
    const svc = providedT3.catnest
    const hT3 = wsT3.routes[0].handler
    const call = (method, url, body) => {
      const r = fakeRes()
      return hT3(fakeReq(method, url, body), r).then(() => r)
    }
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'open' }))
    await svc.setActivity('moli', '读书', 30)
    // 把 activityEndsAt 拨到过去（等价于 30 分钟到期）
    const homeP = join(dirT3, 'home.json')
    const home0 = JSON.parse(await readFile(homeP, 'utf8'))
    home0.characters.moli.activityEndsAt = new Date(Date.now() - 1000).toISOString()
    await writeFile(homeP, JSON.stringify(home0, null, 2))
    await svc.tick()
    const st = await svc.status()
    const log = await readLog(dirT3, st.sliceId)
    const notices = log.filter((e) => e.type === 'notice')
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
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'moveMaster', room: 'living' }))
    await call('POST', '/catnest/api/action', JSON.stringify({ op: 'say', text: '墨璃忙完了吗' }))
    await until(() => prompts.filter((p) => p.system.includes('你是"猫窝"家里的成员小玖')).length >= 1)
    const kyuPrompt = prompts.find((p) => p.system.includes('你是"猫窝"家里的成员小玖'))
    assert.ok(kyuPrompt.user.includes('墨璃做完了读书'), 'kyu 时间线原样可见公共 notice')
    assert.ok(!kyuPrompt.user.includes('你注意到'), 'kyu 不应有【你注意到】前缀')
  } finally {
    await rmSafe(dirT3)
  }
})
