// dsh-catnest 测试：node --test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CatNest,
  buildRecap,
  sliceIdOf,
  DEFAULT_ROOMS,
  RELATION_PAIRS,
  RELATION_FIELDS,
  COMPANION_IDS,
  roomRelation,
  isBusy,
  hearReadyOf,
  respondersOrder,
  charName,
  freezeActivities,
  thawActivities,
  dialogueText,
  companionSync,
  relationSync,
  sliceEventsText,
  HEAR_THRESHOLDS,
  TURN_ORDER,
  HOME_VERSION,
  conditionLabel,
  conditionPhase,
  conditionText,
  advanceConditions,
  CONDITION_TYPES,
} from '../lib.js'

const FIXED = new Date('2026-08-22T11:00:00+08:00')
const fixedNow = () => new Date(FIXED.getTime())

const mk = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catnest-'))
  return { dir, nest: new CatNest(dir, { now: fixedNow }), cleanup: () => rm(dir, { recursive: true, force: true }) }
}

// ── 种子与幂等 ──

test('ensure 落默认账本：7 房间 / 2 角色 / 3 关系对', async () => {
  const { dir, nest, cleanup } = await mk()
  try {
    const home = await nest.home()
    assert.equal(home.rooms.length, DEFAULT_ROOMS.length)
    assert.equal(Object.keys(home.characters).sort().join(','), COMPANION_IDS.slice().sort().join(','))
    for (const ch of Object.values(home.characters)) {
      assert.equal(ch.room, 'living')
      assert.equal(ch.activity, null)
    }
    assert.deepEqual(home.master, { atHome: false, room: null })
    const rel = await nest.relations()
    assert.deepEqual(Object.keys(rel.pairs).sort(), RELATION_PAIRS.slice().sort())
    for (const p of Object.values(rel.pairs)) assert.deepEqual(p, { intimacy: 50, spice: 0 })
  } finally {
    await cleanup()
  }
})

test('ensure 幂等：已有账本不被覆盖', async () => {
  const { dir, nest, cleanup } = await mk()
  try {
    await nest.home()
    const custom = { version: 1, rooms: [{ id: 'x', name: 'X', functions: [], adjacent: [] }], characters: { a: { id: 'a', name: 'A', room: 'x', activity: null, activityEndsAt: null } }, master: { atHome: true, room: 'x' } }
    await writeFile(join(dir, 'home.json'), JSON.stringify(custom))
    await nest.ensure()
    const home = await nest.home()
    assert.equal(home.rooms.length, 1)
    assert.equal(home.master.room, 'x')
  } finally {
    await cleanup()
  }
})

// ── 时间片生命周期 ──

test('open → status → close 全周期', async () => {
  const { nest, cleanup } = await mk()
  try {
    assert.deepEqual(await nest.status(), { open: false, sliceId: null, openedAt: null })
    const opened = await nest.open()
    assert.match(opened.sliceId, /^\d{8}T\d{6}(-\d+)?$/)
    const st = await nest.status()
    assert.equal(st.open, true)
    assert.equal(st.sliceId, opened.sliceId)
    await assert.rejects(() => nest.open(), /已打开/)
    const closed = await nest.close()
    assert.equal(closed.sliceId, opened.sliceId)
    assert.equal(typeof closed.closedAt, 'string')
    assert.deepEqual(await nest.status(), { open: false, sliceId: null, openedAt: null })
    await assert.rejects(() => nest.close(), /没有打开的时间片/)
  } finally {
    await cleanup()
  }
})

test('模式外家静止：无打开时间片时变更全部拒绝', async () => {
  const { nest, cleanup } = await mk()
  try {
    await assert.rejects(() => nest.moveCharacter('kyu', 'kitchen'), /家静止中/)
    await assert.rejects(() => nest.setActivity('kyu', '读书'), /家静止中/)
    await assert.rejects(() => nest.moveMaster('living'), /家静止中/)
    await assert.rejects(() => nest.adjustRelation('master:kyu', 'intimacy', 1), /家静止中/)
  } finally {
    await cleanup()
  }
})

// ── 变更 ──

test('moveCharacter：合法移动 + 记 log，非法房间拒绝', async () => {
  const { nest, cleanup } = await mk()
  try {
    await nest.open()
    const r = await nest.moveCharacter('kyu', 'kitchen')
    assert.deepEqual(r, { char: 'kyu', from: 'living', to: 'kitchen' })
    const home = await nest.home()
    assert.equal(home.characters.kyu.room, 'kitchen')
    await assert.rejects(() => nest.moveCharacter('kyu', 'nope'), /房间 "nope" 不存在/)
    await assert.rejects(() => nest.moveCharacter('zhua', 'living'), /角色 "zhua" 不存在/)
  } finally {
    await cleanup()
  }
})

test('setActivity：设置带时长 / 清除 / 非法参数', async () => {
  const { nest, cleanup } = await mk()
  try {
    await nest.open()
    const r = await nest.setActivity('moli', '读书', 30)
    assert.equal(r.activity, '读书')
    assert.equal(r.activityEndsAt, new Date(FIXED.getTime() + 30 * 60000).toISOString())
    const home = await nest.home()
    assert.equal(home.characters.moli.activity, '读书')
    const cleared = await nest.setActivity('moli', null)
    assert.equal(cleared.activity, null)
    await assert.rejects(() => nest.setActivity('moli', '读书', -1), /正数/)
    await assert.rejects(() => nest.setActivity('moli', 42), /字符串/)
  } finally {
    await cleanup()
  }
})

test('moveMaster：进房 / 离宅', async () => {
  const { nest, cleanup } = await mk()
  try {
    await nest.open()
    assert.deepEqual(await nest.moveMaster('living'), { atHome: true, room: 'living' })
    assert.deepEqual((await nest.home()).master, { atHome: true, room: 'living' })
    assert.deepEqual(await nest.moveMaster(null), { atHome: false, room: null })
    assert.deepEqual((await nest.home()).master, { atHome: false, room: null })
    await assert.rejects(() => nest.moveMaster('nope'), /房间 "nope" 不存在/)
  } finally {
    await cleanup()
  }
})

test('adjustRelation：增减、0..100 钳制、非法参数', async () => {
  const { nest, cleanup } = await mk()
  try {
    await nest.open()
    assert.deepEqual(await nest.adjustRelation('master:kyu', 'intimacy', 20), { pair: 'master:kyu', field: 'intimacy', from: 50, to: 70 })
    assert.deepEqual(await nest.adjustRelation('master:kyu', 'intimacy', 999), { pair: 'master:kyu', field: 'intimacy', from: 70, to: 100 })
    assert.deepEqual(await nest.adjustRelation('master:kyu', 'spice', -30), { pair: 'master:kyu', field: 'spice', from: 0, to: 0 })
    await assert.rejects(() => nest.adjustRelation('kyu:kyu', 'intimacy', 1), /不存在/)
    await assert.rejects(() => nest.adjustRelation('master:kyu', 'mood', 1), /不存在/)
    await assert.rejects(() => nest.adjustRelation('master:kyu', 'intimacy', 0), /非零/)
  } finally {
    await cleanup()
  }
})

// ── 跨进程持久化 ──

test('状态跨实例延续：close 后新实例读到全部变更 + 片目录完整', async () => {
  const { dir, nest, cleanup } = await mk()
  try {
    const opened = await nest.open()
    await nest.moveCharacter('kyu', 'kitchen')
    await nest.setActivity('moli', '读书', 30)
    await nest.moveMaster('living')
    await nest.adjustRelation('master:kyu', 'intimacy', 20)
    await nest.close()

    const nest2 = new CatNest(dir)
    const home = await nest2.home()
    assert.equal(home.characters.kyu.room, 'kitchen')
    assert.equal(home.characters.moli.activity, '读书')
    assert.deepEqual(home.master, { atHome: true, room: 'living' })
    const rel = await nest2.relations()
    assert.equal(rel.pairs['master:kyu'].intimacy, 70)

    const meta = JSON.parse(await readFile(join(dir, 'slices', opened.sliceId, 'meta.json'), 'utf8'))
    assert.equal(meta.sliceId, opened.sliceId)
    assert.equal(typeof meta.closedAt, 'string')
    const snap = JSON.parse(await readFile(join(dir, 'slices', opened.sliceId, 'close.snapshot.json'), 'utf8'))
    assert.equal(snap.home.characters.kyu.room, 'kitchen')
    const logText = await readFile(join(dir, 'slices', opened.sliceId, 'log.jsonl'), 'utf8')
    const types = logText.trim().split('\n').map((l) => JSON.parse(l).type).sort()
    assert.deepEqual(types, ['activity', 'master-move', 'move', 'relation'])
  } finally {
    await cleanup()
  }
})

// ── 回顾 ──

test('首个时间片 open 无回顾；close 后新片 open 有规则化回顾', async () => {
  const { nest, cleanup } = await mk()
  try {
    const first = await nest.open()
    assert.equal(first.recap, null)
    await nest.moveCharacter('kyu', 'kitchen')
    await nest.setActivity('moli', '读书', 30)
    await nest.adjustRelation('master:kyu', 'intimacy', 20)
    await nest.close()

    const second = await nest.open()
    assert.equal(typeof second.recap, 'string')
    assert.ok(second.recap.includes('小玖'), second.recap)
    assert.ok(second.recap.includes('厨房'), second.recap)
    assert.ok(second.recap.includes('读书'), second.recap)
    assert.ok(second.recap.includes('亲密度升了20'), second.recap)
    assert.ok(second.recap.includes('走的时候'), second.recap)
    // recap() 独立可读
    const recap = await nest.recap()
    assert.equal(recap, second.recap)
  } finally {
    await cleanup()
  }
})

test('buildRecap 纯函数：无 close 快照返回 null；空 log 也出走时状态', () => {
  assert.equal(buildRecap('s1', null, null, null, ''), null)
  const home = {
    rooms: [{ id: 'living', name: '客厅' }, { id: 'study', name: '书房' }],
    characters: { kyu: { id: 'kyu', name: '小玖', room: 'study', activity: null, activityEndsAt: null } },
  }
  const text = buildRecap('s1', { openedAt: '2026-08-22T10:00:00.000Z', closedAt: '2026-08-22T10:40:00.000Z' }, null, { home, relations: { pairs: {} } }, '')
  assert.ok(text.includes('安安静静的'), text)
  assert.ok(text.includes('约40分钟'), text)
  assert.ok(text.includes('小玖在书房'), text)
})

test('同秒开关片：sliceId 撞车时加唯一后缀，不覆盖旧片', async () => {
  const { dir, nest, cleanup } = await mk()
  try {
    const first = await nest.open()
    await nest.close()
    const second = await nest.open()
    assert.notEqual(second.sliceId, first.sliceId)
    assert.ok(second.sliceId.startsWith(first.sliceId), '后缀版以原 id 开头')
    // 旧片数据完好
    const meta1 = JSON.parse(await readFile(join(dir, 'slices', first.sliceId, 'meta.json'), 'utf8'))
    assert.equal(typeof meta1.closedAt, 'string')
    const recap = await nest.recap()
    assert.equal(typeof recap, 'string')
    await nest.close()
  } finally {
    await cleanup()
  }
})

test('sliceIdOf 本地时间格式', () => {
  assert.equal(sliceIdOf(new Date('2026-08-22T09:05:07+08:00')), '20260822T090507')
})

// ── 家物理 · 纯规则 ──

test('roomRelation：同房 same / 相邻 adjacent / 远处 far / 未知房间 far', () => {
  const home = { rooms: DEFAULT_ROOMS.map((r) => ({ ...r, adjacent: [...r.adjacent] })) }
  assert.equal(roomRelation(home, 'living', 'living'), 'same')
  assert.equal(roomRelation(home, 'living', 'kitchen'), 'adjacent')
  assert.equal(roomRelation(home, 'living', 'bath'), 'far') // 浴室在卧室后面，客厅听不到
  assert.equal(roomRelation(home, 'entry', 'living'), 'adjacent')
  assert.equal(roomRelation(home, 'nope', 'living'), 'far')
})

test('isBusy：无活动不忙 / 有活动到期不忙 / 无结束时间一直忙', () => {
  const now = FIXED
  assert.equal(isBusy({ activity: null }, now), false)
  assert.equal(isBusy({ activity: '读书', activityEndsAt: new Date(FIXED.getTime() + 60000).toISOString() }, now), true)
  assert.equal(isBusy({ activity: '读书', activityEndsAt: new Date(FIXED.getTime() - 1000).toISOString() }, now), false)
  assert.equal(isBusy({ activity: '发呆', activityEndsAt: null }, now), true)
})

test('hearReadyOf：缓冲区攒满阈值才 ready（小玖3 / 墨璃5）', () => {
  const home = {
    characters: {
      kyu: { id: 'kyu', hear: [{ from: 'moli' }, { from: 'moli' }, { from: 'moli' }] },
      moli: { id: 'moli', hear: [{ from: 'kyu' }, { from: 'kyu' }, { from: 'kyu' }, { from: 'kyu' }, { from: 'kyu' }] },
    },
    hearThresholds: { ...HEAR_THRESHOLDS },
  }
  assert.equal(hearReadyOf(home, 'kyu', FIXED), true)
  assert.equal(hearReadyOf(home, 'moli', FIXED), true)
  home.characters.kyu.hear.pop()
  assert.equal(hearReadyOf(home, 'kyu', FIXED), false)
})

test('respondersOrder：同房空闲按性格顺序（小玖先，墨璃后），忙的排除', () => {
  const home = {
    rooms: DEFAULT_ROOMS.map((r) => ({ ...r, adjacent: [...r.adjacent] })),
    characters: {
      kyu: { id: 'kyu', room: 'living', activity: null, activityEndsAt: null },
      moli: { id: 'moli', room: 'living', activity: '读书', activityEndsAt: null }, // 一直忙
    },
    hearThresholds: { ...HEAR_THRESHOLDS },
  }
  assert.deepEqual(respondersOrder(home, 'living', FIXED), ['kyu'])
  assert.deepEqual(respondersOrder(home, 'kitchen', FIXED), [])
  // 墨璃闲下来 → 按性格序
  home.characters.moli.activity = null
  home.characters.moli.activityEndsAt = null
  assert.deepEqual(respondersOrder(home, 'living', FIXED), TURN_ORDER)
})

test('charName：主人 / 名册名 / 未知回显', () => {
  const home = { characters: { kyu: { name: '小玖' } } }
  assert.equal(charName(home, 'master'), '主人')
  assert.equal(charName(home, 'kyu'), '小玖')
  assert.equal(charName(home, 'moli'), '墨璃')
  assert.equal(charName(home, 'nobody'), 'nobody')
})

// ── 家物理 · 活动冻结/解冻 ──

test('活动时长模式外冻结：close 冻结剩余，open 解冻且片外时间不计入', async () => {
  const { dir, nest, cleanup } = await mk()
  const t0 = FIXED.getTime()
  try {
    await nest.open()
    await nest.setActivity('moli', '读书', 30) // endsAt = t0+30min
    const h1 = await nest.home()
    assert.equal(typeof h1.characters.moli.activityEndsAt, 'string')
    // 片内过 10 分钟 → close
    nest.now = () => new Date(t0 + 10 * 60000)
    await nest.close()
    const h2 = await nest.home()
    // 冻结：endsAt 清空，剩余 20 分钟存入 activityLeftMs
    assert.equal(h2.characters.moli.activityEndsAt, null)
    assert.equal(h2.characters.moli.activityLeftMs, 20 * 60000)
    assert.equal(h2.characters.moli.activity, '读书')
    // 模式外过 3 天 → open：剩余照旧 20 分钟（不是 20min-3day，即片外不计入）
    nest.now = () => new Date(t0 + 10 * 60000 + 3 * 86400000)
    const opened = await nest.open()
    const h3 = await nest.home()
    assert.equal(h3.characters.moli.activityLeftMs, null)
    assert.equal(h3.characters.moli.activityEndsAt, new Date(nest.now().getTime() + 20 * 60000).toISOString())
    // 解冻后切到 21 分钟：活动到期 → isBusy false
    nest.now = () => new Date(t0 + 10 * 60000 + 3 * 86400000 + 21 * 60000)
    const ch = (await nest.home()).characters.moli
    assert.equal(isBusy(ch, nest.now()), false)
    await nest.close()
  } finally {
    await cleanup()
  }
})

test('活动无结束时间不清除：close 保留 activity，activityLeftMs 不写', async () => {
  const { dir, nest, cleanup } = await mk()
  try {
    await nest.open()
    await nest.setActivity('kyu', '发呆') // 无 duration
    await nest.close()
    const home = await nest.home()
    assert.equal(home.characters.kyu.activity, '发呆')
    assert.equal(home.characters.kyu.activityLeftMs, null)
  } finally {
    await cleanup()
  }
})

// ── 家物理 · 对话流 ──

test('say：同房直接听到 / 相邻进缓冲 / 远处无感，主人视角按距离', async () => {
  const { nest, cleanup } = await mk()
  try {
    await nest.open()
    await nest.moveMaster('living')
    await nest.moveCharacter('moli', 'kitchen') // 厨房与客厅相邻
    // 小玖在客厅说话：主人同房直接听到，墨璃在厨房攒缓冲
    const r1 = await nest.say('kyu', '主人来了喵')
    assert.equal(r1.direct.includes('master'), true)
    assert.equal(r1.buffered.includes('moli'), true)
    assert.equal(r1.adjacent.includes('moli'), true)
    assert.equal(r1.far.length, 0)
    // 墨璃的缓冲有 1 条
    const h = await nest.hear('moli')
    assert.equal(h.buffer.length, 1)
    assert.equal(h.buffer[0].from, 'kyu')
    assert.equal(h.ready, false)
    // 主人其实不在家时说话会被拒
    await nest.moveMaster(null)
    await assert.rejects(() => nest.say('master', '有人吗'), /不在家/)
    await nest.moveMaster('living')
    // 缓冲跨开关片延续（不切状态）
    await nest.close()
    await nest.open()
    const h2 = await nest.hear('moli')
    assert.equal(h2.buffer.length, 1)
  } finally {
    await cleanup()
  }
})

test('say 攒满阈值触发决策机会：hearReady 报告', async () => {
  const { nest, cleanup } = await mk()
  try {
    await nest.open()
    await nest.moveMaster('living')
    await nest.moveCharacter('moli', 'kitchen')
    // 墨璃阈值 5：客厅动静连说 5 条
    for (let i = 0; i < 5; i += 1) {
      await nest.say('kyu', `客厅动静喵${i}`)
    }
    const h = await nest.hear('moli')
    assert.equal(h.buffer.length, 5)
    assert.equal(h.ready, true)
    // hearReadyOf 也认为 ready
    const home = await nest.home()
    assert.equal(hearReadyOf(home, 'moli', nest.now()), true)
  } finally {
    await cleanup()
  }
})

test('resolveHear ignore：清空重攒；shout（已退役为普通发声）：按距离传播并清空自己', async () => {
  const { nest, cleanup } = await mk()
  try {
    await nest.open()
    await nest.moveCharacter('moli', 'kitchen')
    // 墨璃攒 2 条来自 kyu 的动静
    await nest.say('kyu', '喵喵')
    await nest.say('kyu', '喵喵喵')
    // ignore：清空
    const r1 = await nest.resolveHear('moli', 'ignore')
    assert.deepEqual(r1, { char: 'moli', decision: 'ignore' })
    assert.equal((await nest.hear('moli')).buffer.length, 0)
    // 再攒 5 条 → 决策发声（shout 已退役：以普通 say 入账，声音按距离自然传播）
    for (let i = 0; i < 5; i += 1) {
      await nest.say('kyu', `喵${i}`)
    }
    assert.equal((await nest.hear('moli')).ready, true)
    const r2 = await nest.resolveHear('moli', 'shout', '墨璃听到啦，别吵！')
    assert.equal(r2.decision, 'shout')
    assert.equal(r2.target, 'kyu') // 兼容旧返回形状：最近一次动静来源
    assert.equal(r2.said.room, 'kitchen') // 实际是墨璃在厨房普通发声
    assert.equal((await nest.hear('moli')).buffer.length, 0) // 自己清空
    // 厨房→客厅相邻：小玖照旧进缓冲，但不再有定向 shout 标记
    const kyuHear = await nest.hear('kyu')
    assert.equal(kyuHear.buffer.length, 1)
    assert.equal(kyuHear.buffer[0].from, 'moli')
    assert.equal(kyuHear.buffer[0].shout, undefined)
    // 台词以 say 类型入账（log 里不再产生新的 shout 行）
    const t = await nest.transcript()
    const dialogLines = t.lines.filter((l) => l.type === 'say' || l.type === 'shout')
    const lastLine = dialogLines[dialogLines.length - 1]
    assert.equal(lastLine.type, 'say')
    assert.equal(lastLine.rawText, '墨璃听到啦，别吵！')
    // 空缓冲不能再决策
    await assert.rejects(() => nest.resolveHear('moli', 'ignore'), /为空/)
    await assert.rejects(() => nest.resolveHear('kyu', 'nope'), /shout 或 ignore/)
  } finally {
    await cleanup()
  }
})

test('say 行存储升级：positions 全员位置快照 + audience 听众名单（clear/faint）', async () => {
  const { dir, nest, cleanup } = await mk()
  try {
    await nest.open()
    await nest.moveCharacter('moli', 'kitchen')
    await nest.moveMaster('study') // 主人在书房（与客厅相邻与否不影响快照存在性）
    await nest.say('kyu', '大家在干嘛呀')
    await nest.moveMaster(null)
    // 读回 log 原始行验证字段
    const cur = JSON.parse(await readFile(join(dir, 'current.json'), 'utf8'))
    const logText = await readFile(join(dir, 'slices', cur.sliceId, 'log.jsonl'), 'utf8')
    const sayLines = logText.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'say' && e.who === 'kyu')
    assert.equal(sayLines.length, 1)
    const line = sayLines[0]
    // positions：全员位置快照（含主人；此刻主人在书房）
    assert.equal(line.positions.kyu, 'living')
    assert.equal(line.positions.moli, 'kitchen')
    assert.equal(line.positions.master, 'study')
    // audience：同房无其他角色 → clear 空；相邻可闻者入 faint（墨璃在厨房、主人在书房）
    assert.deepEqual(line.audience.clear, [])
    assert.deepEqual(line.audience.faint.slice().sort(), ['master', 'moli'])
    // 主人再进客厅说一句：clear 应含小玖（同房），faint 视布局而定
    await nest.moveMaster('living')
    await nest.say('master', '我回来啦')
    const logText2 = await readFile(join(dir, 'slices', cur.sliceId, 'log.jsonl'), 'utf8')
    const masterSay = logText2.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'say' && e.who === 'master')[0]
    assert.ok(masterSay.audience.clear.includes('kyu'), '同房角色应入 clear 名单')
    assert.equal(masterSay.audience.clear.includes('master'), false, '说话者本人不入名单')
    assert.equal(masterSay.positions.master, 'living')
  } finally {
    await cleanup()
  }
})

test('say action：即时动作随台词入账（视觉信息）；hear 缓冲只攒声音', async () => {
  const { dir, nest, cleanup } = await mk()
  try {
    await nest.open()
    await nest.moveMaster('living')
    await nest.moveCharacter('moli', 'kitchen') // 厨房与客厅相邻
    await nest.say('kyu', '主人，我在呢～', '蹭了蹭主人')
    const cur = JSON.parse(await readFile(join(dir, 'current.json'), 'utf8'))
    const logText = await readFile(join(dir, 'slices', cur.sliceId, 'log.jsonl'), 'utf8')
    const sayLine = logText.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'say' && e.who === 'kyu')[0]
    assert.equal(sayLine.action, '蹭了蹭主人', 'log 行应带 action')
    // 墨璃（相邻）缓冲只攒声音：有 text 无 action（隔墙看不见）
    const h = await nest.hear('moli')
    assert.equal(h.buffer.length, 1)
    assert.equal(h.buffer[0].text, '主人，我在呢～')
    assert.equal(h.buffer[0].action, undefined, '缓冲是听觉信息，不应带 action')
    // 人话化出口带动作
    const t = await nest.transcript()
    const tl = t.lines.filter((l) => l.type === 'say')[0]
    assert.equal(tl.text, '小玖（蹭了蹭主人）：主人，我在呢～')
    assert.equal(tl.action, '蹭了蹭主人', 'transcript 行应透传 action 供前端渲染')
    // 蒸馏喂料同样带动作
    const events = sliceEventsText(await nest.home(), logText)
    assert.ok(events.includes('小玖（蹭了蹭主人）：主人，我在呢～'), events.join('|'))
    // 不带 action 的 say：log 无该字段（旧形状兼容），人话化无括号
    await nest.say('kyu', '嗯嗯')
    const logText2 = await readFile(join(dir, 'slices', cur.sliceId, 'log.jsonl'), 'utf8')
    const sayLine2 = logText2.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'say' && e.who === 'kyu')[1]
    assert.equal(sayLine2.action, undefined, '无动作时不落 action 字段')
    const t2 = await nest.transcript()
    const tl2 = t2.lines.filter((l) => l.type === 'say')[1]
    assert.equal(tl2.text, '小玖：嗯嗯')
    // 空白 action 视为无动作
    await nest.say('moli', '喵', '   ')
    const logText3 = await readFile(join(dir, 'slices', cur.sliceId, 'log.jsonl'), 'utf8')
    const sayLine3 = logText3.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'say' && e.who === 'moli')[0]
    assert.equal(sayLine3.action, undefined, '纯空白 action 应被丢弃')
  } finally {
    await cleanup()
  }
})

test('scene：主人/角色视角按距离分层；responders：空闲接话顺序', async () => {
  const { nest, cleanup } = await mk()
  try {
    await nest.open()
    await nest.moveMaster('living')
    await nest.moveCharacter('moli', 'bedroom')
    // 主人视角：同房小玖 / 相邻从卧室能但 master 在客厅 → moli 在卧室（客厅相邻）= 客厅的 adjacent
    const sm = await nest.scene('master')
    assert.equal(sm.atHome, true)
    assert.equal(sm.direct.includes('kyu'), true)
    assert.equal(sm.adjacent.includes('moli'), true)
    assert.equal(sm.room, 'living')
    // 小玖视角：主人同房，墨璃在卧室（卧室相邻客厅）
    const sk = await nest.scene('kyu')
    assert.equal(sk.direct.includes('master'), true)
    assert.equal(sk.adjacent.includes('moli'), true)
    assert.equal(sk.hear.threshold, HEAR_THRESHOLDS.kyu)
    // 墨璃视角：客厅动静隔一间（卧室↔客厅 adjacent）→ 可见主人与小玖在 adjacent
    const smoli = await nest.scene('moli')
    assert.equal(smoli.direct.length, 0)
    assert.equal(smoli.adjacent.includes('master'), true)
    assert.equal(smoli.adjacent.includes('kyu'), true)
    // 门外的远处：墨璃去浴室听不到客厅
    await nest.moveCharacter('moli', 'bath')
    const sb = await nest.scene('moli')
    assert.equal(sb.adjacent.includes('master'), false)
  } finally {
    await cleanup()
  }
})

test('scene master 不在家：空视角；responders 非法房间拒绝', async () => {
  const { nest, cleanup } = await mk()
  try {
    await nest.open()
    const sm = await nest.scene('master')
    assert.equal(sm.atHome, false)
    assert.deepEqual(sm.far, ['kyu', 'moli'])
    await assert.rejects(() => nest.responders('nope'), /房间 "nope" 不存在/)
  } finally {
    await cleanup()
  }
})

test('interrupt：点名打断记事件（忙/闲），反应留给上层', async () => {
  const { nest, cleanup } = await mk()
  try {
    await nest.open()
    await nest.setActivity('moli', '读书', 30)
    const r1 = await nest.interrupt('moli', 'master')
    assert.equal(r1.busy, true)
    assert.equal(r1.activity, '读书')
    const r2 = await nest.interrupt('kyu', 'master')
    assert.equal(r2.busy, false)
    await assert.rejects(() => nest.interrupt('zhua', 'master'), /不存在/)
  } finally {
    await cleanup()
  }
})

test('transcript：回看时间片对话；不含片号时优先当前打开片', async () => {
  const { nest, cleanup } = await mk()
  try {
    await nest.open()
    await nest.moveMaster('living')
    await nest.say('kyu', '主人回来啦喵')
    await nest.say('master', '我回来啦')
    await nest.say('moli', '欢迎回家～')
    const cur = await nest.transcript() // 无片号 → 当前打开片
    assert.equal(cur.closedAt, null)
    const says = cur.lines.filter((l) => l.type === 'say').map((l) => l.text)
    assert.ok(says.includes('小玖：主人回来啦喵'), says)
    assert.ok(says.includes('主人：我回来啦'), says)
    assert.ok(says.includes('墨璃：欢迎回家～'), says)
    await nest.close()
    // 关闭后按片号也可查
    const tr = await nest.transcript(cur.sliceId)
    assert.equal(typeof tr.closedAt, 'string')
    assert.equal(tr.lines.filter((l) => l.type === 'say').length, 3)
    // dialogueText 纯函数
    assert.equal(dialogueText({ characters: {} }, { type: 'shout', char: 'moli', target: 'kyu', text: '喂！' }), '墨璃喊话（喊小玖）：喂！')
  } finally {
    await cleanup()
  }
})

test('家物理写操作同样要求打开时间片（模式外家静止）', async () => {
  const { nest, cleanup } = await mk()
  try {
    await assert.rejects(() => nest.say('kyu', 'hi'), /家静止中/)
    await assert.rejects(() => nest.resolveHear('kyu', 'ignore'), /家静止中/)
    await assert.rejects(() => nest.interrupt('kyu', 'master'), /家静止中/)
  } finally {
    await cleanup()
  }
})

test('ensure v1→v2 迁移：补听到缓冲/阈值/版本，旧房间与角色不变', async () => {
  const { dir, nest, cleanup } = await mk()
  try {
    await writeFile(
      join(dir, 'home.json'),
      JSON.stringify({
        version: 1,
        rooms: [{ id: 'x', name: 'X', functions: [], adjacent: [] }],
        characters: { a: { id: 'a', name: 'A', room: 'x', activity: null, activityEndsAt: null } },
        master: { atHome: false, room: null },
      }),
    )
    await nest.ensure()
    const home = await nest.home()
    assert.equal(home.version, HOME_VERSION)
    assert.deepEqual(home.hearThresholds, HEAR_THRESHOLDS)
    assert.deepEqual(home.characters.a.hear, [])
    assert.equal(home.characters.a.activityLeftMs, null)
    assert.equal(home.rooms.length, 1) // 自定义房间保留
  } finally {
    await cleanup()
  }
})

// ── 文件权限 ──

test('落盘文件权限：目录 700 / 文件 600', async () => {
  const { dir, nest, cleanup } = await mk()
  try {
    await nest.open()
    const stDir = await stat(dir)
    assert.equal((stDir.mode & 0o777).toString(8), '700')
    const stHome = await stat(join(dir, 'home.json'))
    assert.equal((stHome.mode & 0o777).toString(8), '600')
    const stCur = await stat(join(dir, 'current.json'))
    assert.equal((stCur.mode & 0o777).toString(8), '600')
  } finally {
    await cleanup()
  }
})

// ── 角色调度（里程碑三）──

test('companionSync：名册新角色补进家（默认客厅），已有角色原样保留', () => {
  const home = {
    rooms: [{ id: 'living', name: '客厅', functions: [], adjacent: [] }],
    characters: {
      kyu: { id: 'kyu', name: '小玖', room: 'kitchen', activity: '打游戏', activityEndsAt: null, activityLeftMs: null, hear: [] },
    },
  }
  const { home: next, added } = companionSync(home, [
    { id: 'kyu', name: '小玖' },
    { id: 'moli', name: '墨璃' },
    { id: 'newgirl', name: '新邻居' },
  ])
  assert.deepEqual(added.sort(), ['moli', 'newgirl'])
  // 已有角色不动
  assert.equal(next.characters.kyu.room, 'kitchen')
  assert.equal(next.characters.kyu.activity, '打游戏')
  // 新角色默认进客厅、无活动、空缓冲
  assert.equal(next.characters.moli.room, 'living')
  assert.equal(next.characters.moli.activity, null)
  assert.deepEqual(next.characters.moli.hear, [])
  assert.equal(next.characters.newgirl.name, '新邻居')
  // 名册里没有的已有角色不自动逐出（家是持久状态）
  const { home: kept, added: added2 } = companionSync(next, [{ id: 'kyu', name: '小玖' }])
  assert.ok(kept.characters.moli)
  assert.ok(kept.characters.newgirl)
  assert.deepEqual(added2, [])
})

test('relationSync：新角色建 master 对，已有对与姐妹对不动', () => {
  const rel = {
    version: 1,
    pairs: {
      'master:kyu': { intimacy: 80, spice: 10 },
      'moli:kyu': { intimacy: 60, spice: 0 },
    },
  }
  const { rel: next, added } = relationSync(rel, ['kyu', 'moli', 'newgirl'])
  assert.deepEqual(added.sort(), ['master:moli', 'master:newgirl'])
  assert.deepEqual(next.pairs['master:kyu'], { intimacy: 80, spice: 10 }) // 已有不动
  assert.deepEqual(next.pairs['master:moli'], { intimacy: 10, spice: 0 }) // 初始亲密按表（moli=10）
  assert.deepEqual(next.pairs['master:newgirl'], { intimacy: 15, spice: 0 }) // 未知名回退 15
})

test('sliceEventsText：全事件类型人话化，hear 缓冲过程细节不进蒸馏', () => {
  const home = {
    rooms: [{ id: 'living', name: '客厅', functions: [], adjacent: [] }, { id: 'kitchen', name: '厨房', functions: [], adjacent: [] }],
    characters: {
      kyu: { id: 'kyu', name: '小玖', room: 'kitchen', activity: null, activityEndsAt: null, activityLeftMs: null, hear: [] },
      moli: { id: 'moli', name: '墨璃', room: 'living', activity: null, activityEndsAt: null, activityLeftMs: null, hear: [] },
    },
    master: { atHome: false, room: null },
  }
  const logText = [
    JSON.stringify({ type: 'say', who: 'kyu', room: 'kitchen', text: '我做好饭了' }),
    JSON.stringify({ type: 'hear', char: 'moli', from: 'kyu', text: '我做好饭了' }),
    JSON.stringify({ type: 'shout', char: 'moli', target: 'kyu', text: '我来啦' }),
    JSON.stringify({ type: 'hear-ignore', char: 'kyu' }),
    JSON.stringify({ type: 'move', char: 'kyu', from: 'kitchen', to: 'living' }),
    JSON.stringify({ type: 'activity', char: 'moli', activity: '看书', endsAt: null }),
    JSON.stringify({ type: 'master-move', from: null, to: 'living' }),
    JSON.stringify({ type: 'relation', pair: 'master:kyu', field: 'intimacy', from: 50, to: 55, delta: 5 }),
    JSON.stringify({ type: 'interrupt', char: 'moli', by: 'master', activity: '看书' }),
  ].join('\n')
  const lines = sliceEventsText(home, logText)
  assert.equal(lines.length, 8) // hear 被跳过
  assert.ok(lines[0].includes('小玖：我做好饭了'))
  assert.ok(lines[1].includes('墨璃朝小玖喊话'))
  assert.ok(lines[2].includes('没理会'))
  assert.ok(lines[3].includes('厨房挪去了客厅'))
  assert.ok(lines[4].includes('开始看书'))
  assert.ok(lines[5].includes('主人回来，去了客厅'))
  assert.ok(lines[6].includes('亲密度从 50 变到 55'))
  assert.ok(lines[7].includes('主人叫住了墨璃（当时正在看书）'))
})

test('syncRoster：不要求打开时间片，名册补角色 + 建关系对，持久化', async () => {
  const { dir, nest, cleanup } = await mk()
  try {
    await nest.ensure()
    const r = await nest.syncRoster([{ id: 'kyu', name: '小玖' }, { id: 'moli', name: '墨璃' }, { id: 'sister', name: '姐姐二号' }])
    assert.deepEqual(r.added, ['sister'])
    assert.ok(r.relationPairsAdded.includes('master:sister'))
    // 重新读盘验证持久化（新实例）
    const nest2 = new CatNest(dir, { now: fixedNow })
    const home = await nest2.home()
    assert.equal(home.characters.sister.room, 'living')
    const rel = await nest2.relations()
    assert.deepEqual(rel.pairs['master:sister'], { intimacy: 15, spice: 0 }) // 未知名回退 15
    // 幂等：再次同步无新增
    const r2 = await nest2.syncRoster([{ id: 'kyu', name: '小玖' }, { id: 'moli', name: '墨璃' }, { id: 'sister', name: '姐姐二号' }])
    assert.deepEqual(r2.added, [])
    assert.deepEqual(r2.relationPairsAdded, [])
  } finally {
    await cleanup()
  }
})

test('感知遍历以 home.characters 为准：手工加的角色也参与物理', async () => {
  const { dir, nest, cleanup } = await mk()
  try {
    await nest.ensure()
    // 手工往 home.json 加一个不在 COMPANION_IDS 里的角色
    const home = await nest.home()
    home.characters.guest = { id: 'guest', name: '访客', room: 'kitchen', activity: null, activityEndsAt: null, activityLeftMs: null, hear: [] }
    await nest.saveHome(home)
    const scene = await nest.scene('kyu')
    assert.ok(scene.adjacent.includes('guest'), '厨房访客对客厅小玖是相邻，应被感知到')
  } finally {
    await cleanup()
  }
})

test('sliceData / summary：收尾摘要落盘与读取', async () => {
  const { dir, nest, cleanup } = await mk()
  try {
    await nest.open()
    await nest.say('kyu', '今天天气真好')
    await nest.close()
    const data = await nest.sliceData(await nest.latestClosedSliceId())
    assert.ok(data.meta && data.closeSnap && data.closeSnap.home)
    assert.ok(data.logText.includes('今天天气真好'))
    // 无摘要时
    assert.equal(await nest.sliceSummary(data.sliceId), null)
    assert.equal(await nest.latestClosedSummary(), null)
    await nest.writeSliceSummary(data.sliceId, '小玖说天气真好喵。')
    const sum = await nest.latestClosedSummary()
    assert.equal(sum.text, '小玖说天气真好喵。')
    // recapOf 指定片号
    const recap = await nest.recapOf(data.sliceId)
    assert.ok(recap.includes('小玖'))
  } finally {
    await cleanup()
  }
})

// ── 持久状态（conditions）：phase 推导 / 文本 / 周期续期 ──

test('conditions 纯函数：phase 三态推导与倒计时文本', () => {
  const t0 = FIXED.getTime()
  const day = 86400000
  const pending = { name: '生病', startAt: new Date(t0 + 2 * day).toISOString(), endAt: new Date(t0 + 3 * day).toISOString() }
  const active = { name: '发情', startAt: new Date(t0 - 1 * day).toISOString(), endAt: new Date(t0 + 4 * day).toISOString() }
  const expired = { name: '受伤', startAt: new Date(t0 - 3 * day).toISOString(), endAt: new Date(t0 - 1 * day).toISOString() }
  assert.equal(conditionPhase(pending, FIXED), 'pending')
  assert.equal(conditionPhase(active, FIXED), 'active')
  assert.equal(conditionPhase(expired, FIXED), 'expired')
  assert.ok(conditionText(pending, FIXED).includes('还有') && conditionText(pending, FIXED).includes('开始'))
  assert.ok(conditionText(active, FIXED).includes('还剩'))
  assert.equal(conditionText(expired, FIXED), '')
  // 收录表标签 vs 自定义名（中文名归一化到收录键：发情→发情期）
  assert.equal(conditionLabel('estrus'), '发情期')
  assert.equal(conditionLabel('发情'), '发情期')
  assert.equal(conditionLabel('自定义状态'), '自定义状态')
  assert.equal(CONDITION_TYPES.estrus.cycleDays > 0, true, '发情应有周期')
})

test('setCondition：立即开始 / 未来倒计时 / lastsDays=0 清除 / 非法输入', async () => {
  const { nest, cleanup } = await mk()
  try {
    await nest.open()
    // 立即开始（缺省 name=发情 归一化到 estrus：默认 4 天，不是通用 1 天）
    const r1 = await nest.setCondition('kyu', { name: '发情' })
    assert.equal(conditionPhase(r1, FIXED), 'active')
    const r1ms = new Date(r1.endAt).getTime() - new Date(r1.startAt).getTime()
    assert.ok(Math.abs(r1ms - 4 * 86400000) < 60000, '中文名「发情」应落到收录表默认 4 天，实得 ' + (r1ms / 86400000) + ' 天')
    assert.equal(r1.cycleDays, 20, '中文名映射后应带发情周期续轮')
    // 未来 2 天开始
    const r2 = await nest.setCondition('moli', { name: '生病', startsInDays: 2, lastsDays: 1 })
    const of = await nest.conditionsOf('moli')
    assert.equal(of.conditions[0].phase, 'pending')
    // 同名替换
    await nest.setCondition('kyu', { name: '发情', lastsDays: 1 })
    const home = await nest.home()
    assert.equal(home.characters.kyu.conditions.length, 1, '同名条件应替换而非叠加')
    assert.equal(home.characters.kyu.conditions[0].name, '发情')
    // 清除
    await nest.setCondition('kyu', { name: '发情', lastsDays: 0 })
    assert.equal((await nest.home()).characters.kyu.conditions.length, 0)
    // 非法
    await assert.rejects(() => nest.setCondition('kyu', { name: '' }), /条件名不能为空/)
    await assert.rejects(() => nest.setCondition('kyu', { name: '生病', startsInDays: -1 }), /startsInDays/)
  } finally {
    await cleanup()
  }
})

test('advanceConditions：过期无周期移除；带 cycleDays 自动续下一轮', () => {
  const t0 = FIXED.getTime()
  const day = 86400000
  const home = {
    characters: {
      kyu: {
        conditions: [
          { id: 'c1', name: '受伤', startAt: new Date(t0 - 3 * day).toISOString(), endAt: new Date(t0 - 1 * day).toISOString() },
          { id: 'c2', name: '发情', startAt: new Date(t0 - 5 * day).toISOString(), endAt: new Date(t0 - 1 * day).toISOString(), cycleDays: 20 },
          { id: 'c3', name: '生病', startAt: new Date(t0 + 1 * day).toISOString(), endAt: new Date(t0 + 2 * day).toISOString() },
        ],
      },
      moli: { conditions: [] },
    },
  }
  const r = advanceConditions(home, FIXED)
  assert.equal(r.changed.length, 2, '受伤过期移除 + 发情续期各算一次变更')
  const kyuC = home.characters.kyu.conditions
  assert.equal(kyuC.length, 2, '受伤被移除，剩 发情(续)+生病(未到)')
  assert.ok(kyuC.some((c) => c.name === '生病'), 'pending 未到期不动')
  const estrus = kyuC.find((c) => c.name === '发情')
  assert.ok(estrus, '发情应续期保留')
  const nxt = new Date(estrus.startAt).getTime()
  assert.ok(nxt >= t0 - 1 * day + 20 * day, '下一轮应在原结束后第 20 天开始: ' + new Date(nxt).toISOString())
  assert.equal(conditionPhase(estrus, FIXED), 'pending', '续期后还没到 → pending（倒计时）')
})

// ── 调度层原语（notice / consumeHear / markHearNotified / clearActivity）──

test('consumeHear：弹出缓冲并重置「已通告」标记（新批动静重新可通告）', async () => {
  const { nest, cleanup } = await mk()
  try {
    await nest.open()
    await nest.moveMaster('living')
    await nest.moveCharacter('moli', 'kitchen')
    // 主人在客厅连说 5 句（moli 阈值 5）：隔壁厨房攒满
    for (let i = 0; i < 5; i++) await nest.say('master', '第' + i + '句')
    let h = await nest.home()
    assert.equal(h.characters.moli.hear.length, 5)
    // 标记这批已通告（tryWakeHear 入账 notice 后调）
    await nest.markHearNotified('moli')
    h = await nest.home()
    assert.equal(h.characters.moli.hearNotified, true)
    // 消费：弹出 5 条 + 缓冲清空 + 标记复位
    const c = await nest.consumeHear('moli')
    assert.equal(c.heard.length, 5)
    assert.equal(c.heard[0].from, 'master')
    h = await nest.home()
    assert.equal(h.characters.moli.hear.length, 0)
    assert.equal(h.characters.moli.hearNotified, false, '消费后标记复位')
    // 空缓冲再消费：返回空、不炸
    const c2 = await nest.consumeHear('moli')
    assert.deepEqual(c2.heard, [])
  } finally {
    await cleanup()
  }
})

test('clearActivity：到期静默清除（不落 activity 行，事实由公共 notice 承载）', async () => {
  const { dir, nest, cleanup } = await mk()
  try {
    await nest.open()
    await nest.setActivity('moli', '读书', 30)
    const home1 = await nest.home()
    assert.ok(home1.characters.moli.activityEndsAt)
    const r = await nest.clearActivity('moli')
    assert.equal(r.from, '读书')
    const home2 = await nest.home()
    assert.equal(home2.characters.moli.activity, null)
    assert.equal(home2.characters.moli.activityEndsAt, null)
    // 静默：log 里没有 activity 清除行（只有 setActivity 的开始行）
    const log = (await readFile(join(dir, 'slices', (await nest.status()).sliceId, 'log.jsonl'), 'utf8')).trim().split('\n')
    const actLines = log.map((l) => JSON.parse(l)).filter((e) => e.type === 'activity')
    assert.equal(actLines.length, 1, '只有开始行，清除不落行')
    assert.equal(actLines[0].activity, '读书')
    // 无活动时清除：from=null 幂等
    const r2 = await nest.clearActivity('moli')
    assert.equal(r2.from, null)
  } finally {
    await cleanup()
  }
})

test('notice：私有默认只进本人时间线；公共例外全员可见；要求打开的时间片', async () => {
  const { nest, cleanup } = await mk()
  try {
    // 片外拒绝
    await assert.rejects(() => nest.notice('kyu', 'body', 'x'), /打开的时间片|时间片/)
    await nest.open()
    const n1 = await nest.notice('moli', 'master', '隔壁客厅传来主人的动静，已经几次了（见【最近听到的】）')
    assert.equal(n1.private, true, '缺省=私有（v1 拍板：公共是例外）')
    await nest.notice('moli', 'moli', '墨璃做完了读书', false) // 公共=显式 false（T3 例外）
    const st = await nest.status()
    const log = (await readFile(join(dir0(nest), 'slices', st.sliceId, 'log.jsonl'), 'utf8')).trim().split('\n')
    const notices = log.map((l) => JSON.parse(l)).filter((e) => e.type === 'notice')
    assert.equal(notices.length, 2)
    assert.equal(notices[0].private, true)
    assert.equal(notices[1].private, false, '公共 notice 显式 isPrivate=false')
    assert.equal(notices[1].source, 'moli')
    // 蒸馏可见：私有=「X注意到：」，公共=原样
    const lines = sliceEventsText(await nest.home(), log.join('\n'))
    assert.ok(lines.some((t) => t.includes('墨璃注意到：')), lines.join('|'))
    assert.ok(lines.some((t) => t === '墨璃做完了读书'), lines.join('|'))
  } finally {
    await cleanup()
  }
})

function dir0(nest) {
  return nest.dir
}
