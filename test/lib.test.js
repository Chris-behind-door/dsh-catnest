// dsh-catnest 测试：node --test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises'
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
  t6BackoffMs,
  hearReadyOf,
  hearStaleOf,
  autonomyEnabled,
  respondersOrder,
  charName,
  roomItems,
  roomItemsText,
  itemsDiff,
  itemsEventText,
  settleActivities,
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
  settleCycles,
  settleRegime,
  cycleView,
  dayKeyOf,
  CYCLE_CONFIG,
  CYCLE_JITTER_DAYS,
  CYCLE_LEAD_DAYS,
  REGIME_POOL,
  REGIME_DAILY_CHANCE,
  topicKey,
  topicPeers,
  matchTopic,
  checkTopicAbout,
  topicOpenState,
  topicResolveSay,
  topicResolveAction,
  topicEndState,
  topicExpire,
  TOPIC_SILENCE_TIMEOUT_MS,
  detectMoveIntent,
  TOPIC_SEED_CATEGORIES,
  TOPIC_SEEDS,
  pickTopicSeeds,
  topicSeedsText,
  activeTopicsOf,
  recentTopicPhrases,
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
    assert.equal(r.minutes, 30)
    assert.equal(r.defaulted, false)
    // §9.14：活动必须带结束时间。缺省 60 分钟兜底、上限 24 小时
    const def = await nest.setActivity('moli', '发呆')
    assert.equal(def.defaulted, true)
    assert.equal(def.minutes, 60)
    assert.equal(def.activityEndsAt, new Date(FIXED.getTime() + 60 * 60000).toISOString())
    const big = await nest.setActivity('moli', '长睡', 5000)
    assert.equal(big.clamped, true)
    assert.equal(big.minutes, 24 * 60)
    assert.equal(big.activityEndsAt, new Date(FIXED.getTime() + 24 * 60 * 60000).toISOString())
    await nest.setActivity('moli', '读书', 30)
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
    // hear = 活动隔墙动静（§9.5）：墨璃读书 → 相邻厨房的小玖攒一条「客厅传来读书的动静」
    assert.deepEqual(types, ['activity', 'hear', 'master-move', 'move', 'relation'])
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

test('t6BackoffMs：无产出退避 2^n 拉长、封顶（§9.14）', () => {
  const base = 5 * 60000
  const cap = 120 * 60000
  assert.equal(t6BackoffMs(0, base, cap), base, '第一次轻推用基础冷却')
  assert.equal(t6BackoffMs(1, base, cap), 10 * 60000)
  assert.equal(t6BackoffMs(3, base, cap), 40 * 60000)
  assert.equal(t6BackoffMs(99, base, cap), cap, '封顶 2 小时')
  assert.equal(t6BackoffMs(-1, base, cap), base, '非法 streak 归零')
  assert.equal(t6BackoffMs(undefined, base, cap), base)
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

// ── 家物理 · 活动持续计时（2026-09-15：close 不冻结，片外照流；2026-09-16 §9.16：开片静默结算）──

test('活动持续计时（§9.15/§9.16）：close 不清 endsAt，开片把片外到期的静默结算', async () => {
  const { dir, nest, cleanup } = await mk()
  const t0 = FIXED.getTime()
  try {
    await nest.open()
    await nest.setActivity('moli', '读书', 30) // endsAt = t0+30min
    const h1 = await nest.home()
    assert.equal(typeof h1.characters.moli.activityEndsAt, 'string')
    // 片内过 10 分钟 → close：endsAt 原样保留（不再换算成 leftMs）
    nest.now = () => new Date(t0 + 10 * 60000)
    await nest.close()
    const h2 = await nest.home()
    assert.equal(h2.characters.moli.activityEndsAt, new Date(t0 + 30 * 60000).toISOString())
    assert.equal(h2.characters.moli.activityLeftMs, null)
    assert.equal(h2.characters.moli.activity, '读书')
    // 模式外过 3 天 → open：片外这段时间"流过了但没被经历"，早已到期的活动在这一瞬静默
    // 结算——不补发迟到的「做完了X」公共 notice、不唤醒（§9.16：否则就是下午 6 点才睡醒）
    nest.now = () => new Date(t0 + 10 * 60000 + 3 * 86400000)
    await nest.open()
    const h3 = await nest.home()
    assert.equal(h3.characters.moli.activity, null, '片外已到期 → 开片静默结算')
    assert.equal(h3.characters.moli.activityEndsAt, null)
    assert.equal(h3.characters.moli.activityLeftMs, null)
    assert.equal(isBusy(h3.characters.moli, nest.now()), false, '跨片到期 → 不忙')
    const lines = (await nest.transcript()).lines
    assert.ok(!lines.some((l) => l.type === 'notice'), '静默收尾：不落「做完了」notice')
    assert.ok(
      lines.some((l) => l.type === 'gap' && typeof l.ms === 'number'),
      '隔得久 → 记一行片外空窗，实际：' + JSON.stringify(lines.map((l) => l.type)),
    )
    await nest.close()
  } finally {
    await cleanup()
  }
})

test('片外未到期的活动照旧跨片带着绝对 endsAt（§9.15/§9.16）', async () => {
  const { dir, nest, cleanup } = await mk()
  const t0 = FIXED.getTime()
  try {
    await nest.open()
    await nest.setActivity('kyu', '睡觉', 480) // endsAt = t0+8h
    nest.now = () => new Date(t0 + 10 * 60000)
    await nest.close()
    // 片外只过 15 分钟（离到点还早）→ 开片不算过期，计时继续走
    nest.now = () => new Date(t0 + 25 * 60000)
    await nest.open()
    const h = await nest.home()
    assert.equal(h.characters.kyu.activity, '睡觉')
    assert.equal(h.characters.kyu.activityEndsAt, new Date(t0 + 480 * 60000).toISOString())
    assert.equal(isBusy(h.characters.kyu, nest.now()), true)
    assert.ok(
      !(await nest.transcript()).lines.some((l) => l.type === 'gap'),
      '空窗不到半小时 → 不在时间线里留空窗行（日常开关片不刷屏）',
    )
    await nest.close()
  } finally {
    await cleanup()
  }
})

test('活动缺省时长按 60 分钟兜底（§9.14）：close 保持绝对 endsAt，不再是「永久忙」', async () => {
  const { dir, nest, cleanup } = await mk()
  try {
    await nest.open()
    const r = await nest.setActivity('kyu', '发呆') // 无 duration → 兜底 60 分钟
    assert.equal(r.defaulted, true)
    await nest.close()
    const home = await nest.home()
    assert.equal(home.characters.kyu.activity, '发呆')
    assert.equal(
      typeof home.characters.kyu.activityEndsAt,
      'string',
      '有结束时间 → close 保持绝对 endsAt（片外持续计时）',
    )
    assert.equal(home.characters.kyu.activityLeftMs, null)
  } finally {
    await cleanup()
  }
})

test('settleActivities：片内已到期 close 自然收尾；未到期保持 endsAt；旧账本遗留不写 leftMs', () => {
  const home = {
    characters: {
      a: { id: 'a', activity: '发呆', activityEndsAt: null, activityLeftMs: null },
      b: {
        id: 'b',
        activity: '睡觉',
        activityEndsAt: new Date(FIXED.getTime() - 60000).toISOString(),
        activityLeftMs: null,
      },
      c: {
        id: 'c',
        activity: '读书',
        activityEndsAt: new Date(FIXED.getTime() + 60000).toISOString(),
        activityLeftMs: null,
      },
    },
  }
  settleActivities(home, FIXED)
  assert.equal(home.characters.a.activity, '发呆', '无结束时间的旧账本保留')
  assert.equal(home.characters.a.activityLeftMs, null, '不写 leftMs')
  assert.equal(home.characters.b.activity, null, '片内已到期 → close 自然收尾')
  assert.equal(home.characters.b.activityEndsAt, null)
  assert.equal(home.characters.c.activity, '读书', '未到期活动保留')
  assert.equal(home.characters.c.activityEndsAt, new Date(FIXED.getTime() + 60000).toISOString())
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

test('say 音量（§9.16）：小声不出屋 / 大声隔壁真切并当场叫人 / 再远隐约 / 忙碌降半档', async () => {
  const { nest, cleanup } = await mk()
  try {
    await nest.open()
    await nest.moveMaster('living')
    await nest.moveCharacter('kyu', 'living') // 小玖在客厅
    await nest.moveCharacter('moli', 'kitchen') // 墨璃在厨房（与客厅相邻）
    // 1) 小声 = 悄悄话：隔壁完全听不见（缓冲不进、audience.silent 记账）
    const r1 = await nest.say('kyu', '这句只想跟主人说', undefined, undefined, '小声')
    assert.equal(r1.volume, '小声')
    assert.deepEqual(r1.faint, [], '隔壁不该隐约听见')
    assert.ok(r1.silent.includes('moli'), r1)
    assert.equal((await nest.hear('moli')).buffer.length, 0)
    assert.equal(r1.direct.includes('master'), true, '同房照旧听得见（小声不出屋，不是没声音）')
    const row1 = (await nest.transcript()).lines.filter((l) => l.type === 'say').pop()
    assert.equal(row1.volume, '小声', '音量入账，供时间线与字体渲染')
    assert.deepEqual(row1.audience.silent, ['moli'])
    // 2) 大声 = 喊一声：隔壁听得真切（进缓冲 + urgent 立刻叫人），再远一间的隐约听得到
    await nest.moveCharacter('kyu', 'living')
    const r2 = await nest.say('kyu', '姐姐——！', undefined, undefined, '大声')
    assert.equal(r2.volume, '大声')
    assert.ok(r2.faint.includes('moli'), '隔壁听得见')
    assert.ok(r2.urgent.includes('moli'), '隔壁真切到当场叫人（不等缓冲攒够）')
    assert.equal((await nest.hear('moli')).buffer.length, 1)
    // 远处（卧室→厨房隔着客厅）
    await nest.moveCharacter('moli', 'bedroom')
    await nest.moveCharacter('kyu', 'kitchen')
    const r3 = await nest.say('kyu', '喊一声试试', undefined, undefined, '大声')
    assert.ok(r3.faint.includes('moli'), '大声到远处变隐约（听得见）')
    assert.ok(!r3.urgent.includes('moli'), '远处不真切，不当场叫人')
    await nest.resolveHear('moli', 'ignore')
    // 3) 忙碌降半档：埋头做事的猫，隔壁的大声落到"隐约"，不被一嗓子打断
    await nest.moveCharacter('kyu', 'living')
    await nest.moveCharacter('moli', 'kitchen')
    await nest.setActivity('moli', '修bug', 60)
    const r4 = await nest.say('kyu', '姐姐，吃饭啦！', undefined, undefined, '大声')
    assert.ok(r4.faint.includes('moli'), '忙也听得见（进缓冲）')
    assert.ok(!r4.urgent.includes('moli'), '忙 → 不当场叫醒（工作状态下隔壁的大声降半档）')
    const row4 = (await nest.transcript()).lines.filter((l) => l.type === 'say').pop()
    assert.ok(!row4.audience.silent.includes('moli'), '降半档不等于听不见——不会变成"一忙就聋"')
    // 正常音量在忙碌时行为不变（老规矩：隐约 + 攒阈值）
    await nest.resolveHear('moli', 'ignore')
    const r5 = await nest.say('kyu', '随口一句', undefined, undefined, '正常')
    assert.ok(r5.faint.includes('moli'))
    assert.deepEqual(r5.urgent, [])
    // 非法音量按正常处理
    const r6 = await nest.say('kyu', '乱传的音量', undefined, undefined, '超级大声')
    assert.equal(r6.volume, '正常')
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

// ── §9.18 发情周期日历（home.cycles）+ 每日随机身体状态（home.regime）──

test('settleCycles：首次播种按 CYCLE_CONFIG 错开（姐姐 4 天 / 小玖 9 天），同一天幂等', () => {
  const day = 86400000
  const t0 = FIXED.getTime()
  const home = { characters: { kyu: { conditions: [] }, moli: { conditions: [] } } }
  const r1 = settleCycles(home, FIXED, () => 0.5)
  assert.equal(r1.changed.filter((e) => e.kind === 'cycle-init').length, 2)
  const moliDelay = Math.round((new Date(home.cycles.moli.nextStart).getTime() - t0) / day)
  const kyuDelay = Math.round((new Date(home.cycles.kyu.nextStart).getTime() - t0) / day)
  assert.equal(moliDelay, CYCLE_CONFIG.moli.firstDelayDays)
  assert.equal(kyuDelay, CYCLE_CONFIG.kyu.firstDelayDays)
  assert.ok(kyuDelay > moliDelay, '第一轮错开，不会开场双发情')
  assert.equal(home.cycles.kyu.gapDays, 40, '小玖 40 天一轮')
  assert.equal(home.cycles.moli.gapDays, 30, '姐姐 30 天一轮')
  assert.equal(home.cycles.moli.durDays, 3)
  assert.equal(home.characters.kyu.conditions.length, 0, '离开始还有 9 天 > LEAD 窗口 → 不写 pending，她的上下文干净')
  const r2 = settleCycles(home, FIXED, () => 0.5)
  assert.equal(r2.changed.length, 0, '同一天重复结算不再变化')
})

test('settleCycles：临近 LEAD 天写 pending（source=system）；本轮过去滚下一轮且抖动落盘', () => {
  const day = 86400000
  const t0 = FIXED.getTime()
  const iso = (ms) => new Date(ms).toISOString()
  const home = {
    characters: { kyu: { conditions: [] }, moli: { conditions: [] } },
    cycles: {
      kyu: { gapDays: 40, durDays: 3, nextStart: iso(t0 + day), nextEnd: iso(t0 + 4 * day), jitterDays: 0, seeded: false, rounds: 0 },
      moli: { gapDays: 30, durDays: 3, nextStart: iso(t0 - 5 * day), nextEnd: iso(t0 - 2 * day), jitterDays: 0, seeded: true, rounds: 1 },
    },
  }
  const r = settleCycles(home, FIXED, () => 0.9) // randInt(-3,3) → +3
  const jitter = -CYCLE_JITTER_DAYS + Math.floor(0.9 * (CYCLE_JITTER_DAYS * 2 + 1))
  assert.ok(r.changed.find((e) => e.kind === 'cycle-seed' && e.charId === 'kyu'), '小玖 1 天后开始 → 播种')
  const c = home.characters.kyu.conditions[0]
  assert.equal(c.name, '发情')
  assert.equal(c.startAt, home.cycles.kyu.nextStart)
  assert.equal(c.endAt, home.cycles.kyu.nextEnd)
  assert.equal(c.source, 'system', '来路要记着是家里排的')
  assert.equal(c.cycleDays, undefined, '条件不再自带周期，续轮归 cycles 表')
  const next = r.changed.find((e) => e.kind === 'cycle-next' && e.charId === 'moli')
  assert.ok(next, '姐姐本轮已过去 → 滚下一轮')
  assert.equal(next.jitterDays, jitter)
  assert.equal(home.cycles.moli.jitterDays, jitter, '抖动落盘：日历上的下一次才是确定日期')
  assert.equal(new Date(home.cycles.moli.nextStart).getTime(), t0 - 2 * day + (30 + jitter) * day)
  assert.equal(home.cycles.moli.seeded, false)
  assert.equal(settleCycles(home, FIXED, () => 0.9).changed.length, 0, '再跑不重复播种/滚动')
})

test('settleCycles：她自己挂过发情时不重复写（不覆盖本人那条）', () => {
  const day = 86400000
  const t0 = FIXED.getTime()
  const iso = (ms) => new Date(ms).toISOString()
  const home = {
    characters: {
      kyu: { conditions: [{ id: 'x', name: '发情', startAt: iso(t0 + day), endAt: iso(t0 + 4 * day), source: 'self' }] },
      moli: { conditions: [] },
    },
    cycles: {
      kyu: { gapDays: 40, durDays: 3, nextStart: iso(t0 + day), nextEnd: iso(t0 + 4 * day), jitterDays: 0, seeded: false, rounds: 0 },
      moli: { gapDays: 30, durDays: 3, nextStart: iso(t0 + 2 * day), nextEnd: iso(t0 + 5 * day), jitterDays: 0, seeded: false, rounds: 0 },
    },
  }
  const r = settleCycles(home, FIXED, () => 0.5)
  assert.equal(home.characters.kyu.conditions.length, 1)
  assert.equal(home.characters.kyu.conditions[0].source, 'self')
  assert.equal(home.cycles.kyu.seeded, true, '标记已投影，不然每天都来检查一遍')
  assert.equal(r.changed.filter((e) => e.kind === 'cycle-adopt').length, 1, '本人那条被认领，不覆盖')
  assert.equal(r.changed.filter((e) => e.kind === 'cycle-seed').length, 1, '只有姐姐那条是新播种的')
})

test('cycleView：active / pending / idle 三态 + 「再下一次」是虚线预计', () => {
  const day = 86400000
  const t0 = FIXED.getTime()
  const iso = (ms) => new Date(ms).toISOString()
  const base = (startMs) => ({ gapDays: 40, durDays: 3, nextStart: iso(startMs), nextEnd: iso(startMs + 3 * day), jitterDays: 0, seeded: true, rounds: 0 })
  const v1 = cycleView({ cycles: { kyu: base(t0 - day) } }, 'kyu', FIXED)
  assert.equal(v1.phase, 'active')
  assert.ok(v1.remainMs > 0)
  assert.equal(v1.label, '发情期')
  assert.equal(v1.afterStart, iso(t0 + 2 * day + 40 * day), '再下一次 = 本轮结束 + gap（没算抖动）')
  const v2 = cycleView({ cycles: { kyu: base(t0 + day) } }, 'kyu', FIXED)
  assert.equal(v2.phase, 'pending')
  assert.equal(v2.untilMs, day)
  const v3 = cycleView({ cycles: { kyu: base(t0 + 10 * day) } }, 'kyu', FIXED)
  assert.equal(v3.phase, 'idle')
  assert.equal(cycleView({}, 'kyu', FIXED), null)
})

test('settleRegime：一天一掷、命中写 condition（source=system + 自确认 + note）', () => {
  const day = 86400000
  const home = {
    characters: { kyu: { conditions: [] }, moli: { conditions: [] } },
    regime: { enabled: true, rolledOn: null, picks: [] },
  }
  const seq = [0.01, 0, 0] // 命中 → 抽中第一项 → 选第一只猫
  let i = 0
  const rand = () => seq[Math.min(i++, seq.length - 1)]
  const r = settleRegime(home, FIXED, rand)
  assert.equal(r.rolled, true)
  assert.equal(r.picked, REGIME_POOL[0].name)
  const c = home.characters.kyu.conditions[0]
  assert.equal(c.name, '精神特别好')
  assert.equal(c.source, 'system')
  assert.equal(c.notifiedAt, c.startAt, '自确认：告知与唤醒由调度层当场发，别让 T2 再来一次')
  assert.equal(c.note, REGIME_POOL[0].line)
  assert.equal(new Date(c.endAt).getTime() - new Date(c.startAt).getTime(), REGIME_POOL[0].durDays * day)
  assert.equal(home.regime.rolledOn, dayKeyOf(FIXED))
  assert.deepEqual(home.regime.picks[0], { date: dayKeyOf(FIXED), charId: 'kyu', name: '精神特别好' })
  assert.equal(settleRegime(home, FIXED, rand).skip, 'already')
})

test('settleRegime：关掉不掷、发情开场那天独占、掷空也记今天', () => {
  const day = 86400000
  const t0 = FIXED.getTime()
  const fresh = () => ({
    characters: { kyu: { conditions: [] }, moli: { conditions: [] } },
    regime: { enabled: true, rolledOn: null, picks: [] },
  })
  const off = fresh()
  off.regime.enabled = false
  assert.equal(settleRegime(off, FIXED, () => 0).skip, 'off')
  assert.equal(off.regime.rolledOn, null, '关着的时候不动账')
  const h2 = fresh()
  h2.characters.kyu.conditions.push({ name: '发情', startAt: FIXED.toISOString(), endAt: new Date(t0 + 3 * day).toISOString() })
  const r2 = settleRegime(h2, FIXED, () => 0)
  assert.equal(r2.skip, 'cycle-day', '发情开场独占一天，不叠随机状态')
  assert.equal(h2.regime.rolledOn, dayKeyOf(FIXED), '独占那天也记着掷过，免得之后又叠一个')
  assert.equal(h2.characters.kyu.conditions.length, 1, '不写新状态')
  const h3 = fresh()
  const r3 = settleRegime(h3, FIXED, () => 0.99)
  assert.equal(r3.skip, 'miss')
  assert.equal(h3.regime.rolledOn, dayKeyOf(FIXED), '掷空也落盘：重开片不会同一天再掷一次')
  assert.equal(h3.characters.kyu.conditions.length, 0)
  assert.ok(REGIME_DAILY_CHANCE > 0 && REGIME_DAILY_CHANCE < 0.5, '先按低频跑，试行一周看频率再调')
})

test('home v5→v6 迁移：补 cycles 空表与 regime 默认开，用户数据不丢', async () => {
  const { dir, nest, cleanup } = await mk()
  try {
    await writeFile(
      join(dir, 'home.json'),
      JSON.stringify({
        version: 5,
        rooms: [{ id: 'living', name: '客厅', functions: [], adjacent: [], items: [] }],
        characters: { kyu: { id: 'kyu', name: '小玖', room: 'living', conditions: [] } },
        master: { atHome: false, room: null },
        topics: {},
        autonomy: { homeOn: false },
        hearThresholds: { kyu: 3 },
      }),
    )
    await nest.ensure()
    const home = await nest.home()
    assert.equal(home.version, HOME_VERSION)
    assert.equal(home.rooms[0].name, '客厅', '用户数据不丢')
    assert.deepEqual(home.cycles, {}, '周期表留空，首次结算才播种')
    assert.equal(home.regime.enabled, true, '默认开（2026-09-17 主人拍板）')
    assert.equal(home.regime.rolledOn, null)
    assert.deepEqual(home.regime.picks, [])
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
  // §9.18：发情不再自带 cycleDays（周期归 home.cycles 表记账，按猫配 + 抖动）
  assert.equal(CONDITION_TYPES.estrus.cycleDays, undefined, '发情的周期不再挂收录表')
  assert.equal(conditionLabel('精神特别好'), '精神好', '随机池的状态名也要有收录标签')
})

test('setCondition：立即开始 / 未来倒计时 / lastsDays=0 清除 / 非法输入', async () => {
  const { nest, cleanup } = await mk()
  try {
    await nest.open()
    // 立即开始（缺省 name=发情 归一化到 estrus：默认 3 天，不是通用 1 天）
    const r1 = await nest.setCondition('kyu', { name: '发情' })
    assert.equal(conditionPhase(r1, FIXED), 'active')
    const r1ms = new Date(r1.endAt).getTime() - new Date(r1.startAt).getTime()
    assert.ok(Math.abs(r1ms - 3 * 86400000) < 60000, '中文名「发情」应落到收录表默认 3 天，实得 ' + (r1ms / 86400000) + ' 天')
    assert.equal(r1.cycleDays, 0, '§9.18：发情不再自带 cycleDays，周期归 cycles 表')
    // 自己挂的发情要把日历一起挪过去（单一记账者）
    const h1 = await nest.home()
    assert.equal(h1.cycles.kyu.seeded, true, '自己挂的那轮要标记已投影')
    assert.equal(h1.cycles.kyu.nextStart, r1.startAt)
    assert.equal(h1.cycles.kyu.durDays, 3)
    assert.equal(h1.characters.kyu.conditions[0].source, 'self', '来路字段')
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

// ── 路 B §9：话题 / 放下锅铲 / 隔墙动静（2026-09-05 三轮定稿）──

test('topic 纯函数：open（在场即参与）→幂等→续谈→propose→显式否决→动作接受→沉默自动收', () => {
  const now = (ms) => new Date(FIXED.getTime() + ms)
  const home = {
    rooms: DEFAULT_ROOMS.map((r) => ({ ...r, adjacent: [...r.adjacent] })),
    characters: {
      kyu: { id: 'kyu', name: '小玖', room: 'living' },
      moli: { id: 'moli', name: '墨璃', room: 'living' },
    },
    topics: {},
  }
  // 小玖开启「那盆花」：身份＝房间|短语，同房间的姐妹在场即参与
  const r1 = topicOpenState(home, now(0), 'kyu', '那盆花')
  assert.equal(r1.opened, true)
  assert.equal(r1.reopened, false)
  assert.equal(r1.key, topicKey('那盆花'))
  const x = home.topics[r1.key]
  assert.equal(x.status, 'open')
  assert.deepEqual(x.participants, ['kyu', 'moli'], '在场即参与')
  assert.equal(x.turns, 1)
  // 同人同短语重复提起＝幂等续谈（不重置参与方，轮数 +1）
  const r1b = topicOpenState(home, now(60000), 'kyu', '那盆花')
  assert.equal(r1b.opened, false)
  assert.equal(r1b.reopened, false)
  assert.deepEqual(x.participants, ['kyu', 'moli'])
  assert.equal(x.turns, 2)
  // 参与方续谈：轮数 +1（在场即参与，所以不是 join）
  const r2 = topicResolveSay(home, now(120000), 'moli', '那盆花')
  assert.equal(r2.verdict, null)
  assert.equal(r2.joined, false)
  assert.equal(x.turns, 3)
  // 小玖提议收掉 → closing（endedBy=提议人）
  const r3 = topicEndState(home, now(180000), 'kyu', '那盆花')
  assert.equal(r3.verdict, 'propose')
  assert.equal(x.status, 'closing')
  assert.equal(x.endedBy, 'kyu')
  // 墨璃继续说这条线：只算续谈，不再当否决（状态保持 closing）
  const r4 = topicResolveSay(home, now(240000), 'moli', '那盆花')
  assert.equal(r4.verdict, null)
  assert.equal(x.status, 'closing')
  assert.equal(x.turns, 4)
  // 显式否决：墨璃用 open_topic 重提同名 → 拉回 open
  const r5 = topicOpenState(home, now(300000), 'moli', '那盆花')
  assert.equal(r5.opened, false)
  assert.equal(r5.reopened, true)
  assert.equal(x.status, 'open')
  assert.equal(x.endedBy, undefined)
  // 小玖再提收 → closing；墨璃去做事（非说话动作）→ 裁决接受 ended
  topicEndState(home, now(360000), 'kyu', '那盆花')
  assert.equal(x.status, 'closing')
  const r6 = topicResolveAction(home, now(420000), 'moli')
  assert.equal(r6.accepted.length, 1)
  assert.equal(x.status, 'ended')
  assert.equal(x.endedBy, 'moli')
  // 已 ended 的同名话题再开：新生命周期（重置轮次，不复用旧壳）
  const r7 = topicOpenState(home, now(480000), 'kyu', '那盆花')
  assert.equal(r7.opened, true)
  assert.equal(r7.topic.turns, 1)
  assert.notEqual(r7.topic, x, 'ended 的旧壳不复用')
  assert.equal(x.status, 'ended', '旧壳仍是 ended')
  // 沉默自动收：新话题 10 分钟无 mention → endedBy='silence'
  const r8 = topicOpenState(home, now(540000), 'kyu', '今晚吃什么')
  const y = home.topics[r8.key]
  const early = topicExpire(home, now(540000 + 9 * 60000))
  assert.equal(early.length, 0, '9 分钟未到不收')
  const expired = topicExpire(home, now(540000 + 11 * 60000))
  assert.ok(expired.some((e) => e.about === '今晚吃什么'))
  assert.equal(y.status, 'ended')
  assert.equal(y.endedBy, 'silence')
})

test('topic 门禁（2026-09-10）：开门要当面；开完不限房间；对方不在身边就直收；硬校验', () => {
  const now = (ms) => new Date(FIXED.getTime() + ms)
  const mkHome = (moliRoom = 'living') => ({
    rooms: DEFAULT_ROOMS.map((r) => ({ ...r, adjacent: [...r.adjacent] })),
    characters: {
      kyu: { id: 'kyu', name: '小玖', room: 'living' },
      moli: { id: 'moli', name: '墨璃', room: moliRoom },
    },
    topics: {},
  })

  // ① 身边没人时收话题：直接 ended（solo），不挂 closing 干等
  const solo = mkHome('bedroom')
  const s1 = topicOpenState(solo, now(0), 'kyu', '自言自语') // 纯函数不拦，服务层拦「开门要当面」
  assert.deepEqual(solo.topics[s1.key].participants, ['kyu'])
  assert.equal(topicEndState(solo, now(60000), 'kyu', '自言自语').verdict, 'solo')
  assert.equal(solo.topics[s1.key].status, 'ended')

  // ② 开完之后不限房间：墨璃走到厨房照样能接话
  const h = mkHome()
  topicOpenState(h, now(0), 'kyu', '那盆花')
  h.characters.moli.room = 'kitchen'
  assert.ok(matchTopic(h, 'moli', '那盆花'), '开完不限房间：照样匹配')
  assert.ok(checkTopicAbout(h, 'moli', '那盆花').topic, '开完不限房间：照样合法')
  assert.equal(topicResolveSay(h, now(60000), 'moli', '那盆花').matched, true)
  assert.equal(h.topics[topicKey('那盆花')].turns, 2, '隔墙续谈也计轮次')
  // 但收话题：对方不在身边（小玖在客厅、墨璃在厨房）→ 小玖提收直接 ended
  assert.equal(topicEndState(h, now(120000), 'kyu', '那盆花').verdict, 'solo')
  assert.equal(h.topics[topicKey('那盆花')].status, 'ended')

  // ③ 裁决要求当面：提议人走到别的房间时，对方的动作不算裁决
  const h2 = mkHome()
  topicOpenState(h2, now(0), 'kyu', '那盆花')
  assert.equal(topicEndState(h2, now(60000), 'kyu', '那盆花').verdict, 'propose', '墨璃在身边 → closing')
  assert.equal(h2.topics[topicKey('那盆花')].status, 'closing')
  h2.characters.kyu.room = 'study' // 提议人走开
  assert.equal(topicResolveAction(h2, now(120000), 'moli').accepted.length, 0, '提议人不在身边，动作不算裁决')
  h2.characters.kyu.room = 'living' // 提议人回来
  assert.equal(topicResolveAction(h2, now(180000), 'moli').accepted.length, 1, '当面才裁决')
  assert.equal(h2.topics[topicKey('那盆花')].status, 'ended')

  // ④ checkTopicAbout：不存在 / 已收掉
  assert.match(checkTopicAbout(h2, 'kyu', '月亮').error, /不存在/)
  assert.match(checkTopicAbout(h2, 'kyu', '那盆花').error, /不存在/, 'ended 的话题不再合法')

  // ⑤ 全屋同名唯一：两边谁提都是同一条线
  const h3 = mkHome()
  const a1 = topicOpenState(h3, now(0), 'kyu', '那盆花')
  h3.characters.kyu.room = 'kitchen'
  const a2 = topicOpenState(h3, now(60000), 'moli', '那盆花')
  assert.equal(a2.key, a1.key, '全屋同名唯一')
  assert.equal(Object.keys(h3.topics).length, 1)
  topicOpenState(h3, now(120000), 'moli', '月亮')
  assert.equal(Object.keys(h3.topics).length, 2)

  // ⑥ topicPeers：同房间的姐妹；to 指定时只取那一位
  h3.characters.kyu.room = 'living'
  assert.deepEqual(topicPeers(h3, 'moli', null), ['kyu'])
  assert.deepEqual(topicPeers(h3, 'moli', 'kyu'), ['kyu'])
  assert.deepEqual(topicPeers(h3, 'moli', 'zhua'), [])
  h3.characters.kyu.room = 'kitchen'
  assert.deepEqual(topicPeers(h3, 'moli', null), [], '不在同一个房间 → 没有 peer')
})

test('matchTopic：全屋唯一 + 短语完全相等（不限房间；旧「房间唯一话题吸附」兜底已删）', () => {
  const home = {
    rooms: DEFAULT_ROOMS.map((r) => ({ ...r, adjacent: [...r.adjacent] })),
    characters: {
      kyu: { id: 'kyu', name: '小玖', room: 'living' },
      moli: { id: 'moli', name: '墨璃', room: 'living' },
    },
    topics: {},
  }
  const r1 = topicOpenState(home, FIXED, 'kyu', '那盆花')
  // 完全相等 → 命中（未参与也命中：一句带 about 的接话即加入）
  assert.equal(matchTopic(home, 'moli', '那盆花'), home.topics[r1.key])
  // 不等短语：不再按「房间唯一话题」吸附
  assert.equal(matchTopic(home, 'moli', '花'), null)
  assert.equal(matchTopic(home, 'moli', '月亮'), null)
  // 开完之后不限房间：人走到别处照样匹配
  home.characters.moli.room = 'bedroom'
  assert.equal(matchTopic(home, 'moli', '那盆花'), home.topics[r1.key])
  // 收掉的话题不再匹配
  home.topics[r1.key].status = 'ended'
  assert.equal(matchTopic(home, 'kyu', '那盆花'), null)
})

test('topic 裁决边界：提议人自己说话不算裁决；双收直接 ended；非参与方不能收', () => {
  const now = (ms) => new Date(FIXED.getTime() + ms)
  const home = {
    rooms: DEFAULT_ROOMS.map((r) => ({ ...r, adjacent: [...r.adjacent] })),
    characters: {
      kyu: { id: 'kyu', name: '小玖', room: 'living' },
      moli: { id: 'moli', name: '墨璃', room: 'living' },
    },
    topics: {},
  }
  const r1 = topicOpenState(home, now(0), 'kyu', '那盆花')
  const x = home.topics[r1.key]
  topicResolveSay(home, now(60000), 'moli', '那盆花') // 墨璃加入
  topicEndState(home, now(120000), 'kyu', '那盆花') // kyu 提议收
  // 提议人自己再说解析 X 的话：不算裁决，维持 closing
  const r2 = topicResolveSay(home, now(180000), 'kyu', '那盆花')
  assert.equal(r2.verdict, null)
  assert.equal(x.status, 'closing')
  // 非参与方 end_topic：拒绝（没参与）
  const r3 = topicEndState(home, now(240000), 'kyu', '月亮') // 没这话题
  assert.equal(r3.key, null)
  // 双收：墨璃也 end → 直接 ended
  const r4 = topicEndState(home, now(300000), 'moli', '那盆花')
  assert.equal(r4.verdict, 'accepted')
  assert.equal(x.status, 'ended')
  assert.equal(x.endedBy, 'moli')
})

test('home v3：默认账本带 topics/activityPaused/lastAmbientAt；旧账本迁移补齐', async () => {
  const { dir, nest, cleanup } = await mk()
  try {
    const h1 = await nest.home()
    assert.equal(h1.version, HOME_VERSION)
    assert.deepEqual(h1.topics, {})
    for (const ch of Object.values(h1.characters)) {
      assert.equal(ch.activityPaused, null)
      assert.equal(ch.lastAmbientAt, null)
    }
    // 旧账本（v2 无新字段）迁移补齐，用户数据不丢
    // 注意：ensure 的迁移只在进程首次执行（in-flight 缓存）；用新实例模拟真实启动
    const custom = {
      version: 2,
      rooms: DEFAULT_ROOMS.map((r) => ({ ...r, adjacent: [...r.adjacent] })),
      characters: {
        kyu: { id: 'kyu', name: '小玖', room: 'kitchen', activity: '做饭', activityEndsAt: null, activityLeftMs: null, mood: null, conditions: [], hear: [] },
      },
      hearThresholds: { ...HEAR_THRESHOLDS },
      master: { atHome: true, room: 'living' },
    }
    await writeFile(join(dir, 'home.json'), JSON.stringify(custom))
    const nest3 = new CatNest(dir, { now: fixedNow })
    const h2 = await nest3.home()
    assert.equal(h2.version, HOME_VERSION)
    assert.deepEqual(h2.topics, {})
    assert.equal(h2.characters.kyu.activity, '做饭', '已有数据不丢')
    assert.equal(h2.characters.kyu.activityPaused, null)
    assert.equal(h2.characters.kyu.lastAmbientAt, null)
    assert.equal(h2.master.room, 'living')
  } finally {
    await cleanup()
  }
})

test('话题片内作用域：open 清空旧话题；片内进程重启（不开片）留存', async () => {
  const { dir, nest, cleanup } = await mk()
  try {
    await nest.open()
    const r = await nest.openTopic('kyu', '那盆花', '你看那盆花开了')
    assert.equal(r.opened, true)
    assert.ok((await nest.home()).topics[topicKey('那盆花')])
    // 片内重启：新实例读同一目录，话题留存（进程在片内重启不丢）
    const nest2 = new CatNest(dir, { now: fixedNow })
    assert.ok((await nest2.home()).topics[topicKey('那盆花')], '片内重启话题留存')
    await nest2.close()
    // 新片 open：话题清空
    const opened = await nest.open()
    assert.deepEqual((await nest.home()).topics, {}, 'open 新片清空话题（对话不跨片）')
  } finally {
    await cleanup()
  }
})

test('pause_activity：暂停=不忙；暂停中再暂停拒绝；回灶解冻续计时；close 清暂停活动', async () => {
  const { dir, nest, cleanup } = await mk()
  try {
    await nest.open()
    await nest.setActivity('moli', '做饭', 30)
    const p = await nest.pauseActivity('moli')
    assert.equal(p.activity, '做饭')
    assert.equal(p.activityPaused, true)
    const ch1 = (await nest.home()).characters.moli
    assert.equal(ch1.activityEndsAt, null, '暂停：endsAt 冻结')
    assert.ok(ch1.activityLeftMs > 0, '剩余毫秒存 leftMs')
    assert.equal(isBusy(ch1, nest.now()), false, '暂停=不忙（可被叫/可接话/可被轻推）')
    await assert.rejects(() => nest.pauseActivity('moli'), /暂停中/)
    // 回灶：同名 do_activity → 解冻续计时（endsAt 恢复，leftMs 清空）
    const r2 = await nest.setActivity('moli', '做饭', 30)
    assert.equal(r2.resumed, true)
    const ch2 = (await nest.home()).characters.moli
    assert.equal(ch2.activityPaused, null)
    assert.equal(ch2.activityLeftMs, null)
    assert.ok(ch2.activityEndsAt, '回灶恢复 endsAt')
    assert.equal(ch2.activityEndsAt, new Date(FIXED.getTime() + 30 * 60000).toISOString(), '剩余 30 分钟原样续上')
    assert.equal(isBusy(ch2, nest.now()), true, '回灶后重新在忙')
    // 不同名活动 = 放弃暂停、正常开新
    await nest.setActivity('moli', '读书', 30)
    const ch3 = (await nest.home()).characters.moli
    assert.equal(ch3.activity, '读书')
    assert.equal(ch3.activityPaused, null)
    // close 清暂停活动（片内瞬态不跨片；快照保留现场）
    await nest.setActivity('moli', '做饭', 30)
    await nest.pauseActivity('moli')
    const sliceId = (await nest.status()).sliceId
    await nest.close()
    const ch4 = (await nest.home()).characters.moli
    assert.equal(ch4.activity, null)
    assert.equal(ch4.activityPaused, null)
    assert.equal(ch4.activityLeftMs, null)
    const snap = JSON.parse(await readFile(join(dir, 'slices', sliceId, 'close.snapshot.json'), 'utf8'))
    assert.equal(snap.home.characters.moli.activity, '做饭')
    assert.equal(snap.home.characters.moli.activityPaused, true, '快照保留暂停现场（片内最终状态）')
  } finally {
    await cleanup()
  }
})

test('活动隔墙动静（§9.5）：开始时相邻房攒一条；同房不攒；每 10min tick 补一条去重', async () => {
  const { nest, cleanup } = await mk()
  try {
    await nest.open()
    await nest.moveCharacter('kyu', 'kitchen') // 厨房与客厅相邻
    await nest.setActivity('moli', '做饭', 60) // 墨璃在客厅做饭
    const kyuHear = await nest.hear('kyu')
    assert.equal(kyuHear.buffer.length, 1, '开始时相邻房攒一条')
    assert.equal(kyuHear.buffer[0].from, 'moli')
    assert.ok(kyuHear.buffer[0].text.includes('客厅传来做饭的动静'), kyuHear.buffer[0].text)
    assert.equal((await nest.hear('moli')).buffer.length, 0, '同房不攒自己')
    // 未到 10 分钟：不补
    nest.now = () => new Date(FIXED.getTime() + 9 * 60000)
    await nest.ambientTick()
    assert.equal((await nest.hear('kyu')).buffer.length, 1)
    // 过 10 分钟：补一条（同窗去重）
    nest.now = () => new Date(FIXED.getTime() + 11 * 60000)
    await nest.ambientTick()
    assert.equal((await nest.hear('kyu')).buffer.length, 2)
    await nest.ambientTick()
    assert.equal((await nest.hear('kyu')).buffer.length, 2, '刚补过不重复')
    // 活动停止后不再补
    await nest.setActivity('moli', null)
    nest.now = () => new Date(FIXED.getTime() + 22 * 60000)
    await nest.ambientTick()
    assert.equal((await nest.hear('kyu')).buffer.length, 2)
    // 暂停的活动不补（暂停=没在做）：重新开始时打一条开始条，tick 不再补
    nest.now = () => new Date(FIXED.getTime() + 33 * 60000)
    await nest.setActivity('moli', '做饭', 60) // 新开始条（缓冲 3，lastAmbientAt=33min）
    await nest.ambientTick()
    assert.equal((await nest.hear('kyu')).buffer.length, 3, '恢复后按新 lastAmbientAt 计窗，不补')
    await nest.pauseActivity('moli')
    nest.now = () => new Date(FIXED.getTime() + 44 * 60000)
    await nest.ambientTick()
    assert.equal((await nest.hear('kyu')).buffer.length, 3, '暂停期间不补')
  } finally {
    await cleanup()
  }
})

test('openTopic/endTopic/resolveTopicSay 方法：账本行与状态一致（含 say 带 about）', async () => {
  const { nest, cleanup } = await mk()
  try {
    await nest.open()
    const KEY = topicKey('那盆花')
    const r1 = await nest.openTopic('kyu', '那盆花', '你看那盆花开了')
    assert.equal(r1.opened, true)
    assert.equal(r1.reopened, false)
    let t = await nest.transcript()
    assert.ok(t.lines.some((l) => l.type === 'topic-open' && l.about === '那盆花' && l.char === 'kyu'), 'topic-open 行入账')
    const say1 = t.lines.find((l) => l.type === 'say' && l.who === 'kyu')
    assert.equal(say1.about, '那盆花', '开场白 say 带 about')
    assert.deepEqual((await nest.home()).topics[KEY].participants, ['kyu', 'moli'], '同房间在场即参与')
    // 墨璃带 about 接话：她已在参与方里 → 续谈（不再产生 topic-join）
    await nest.say('moli', '我也想看', undefined, '那盆花')
    const r2 = await nest.resolveTopicSay('moli', '那盆花')
    assert.equal(r2.verdict, null)
    assert.equal((await nest.home()).topics[KEY].turns, 2)
    // 小玖收话题（带收尾句）→ topic-end 行 + 带 about 的收尾 say
    const r3 = await nest.endTopic('kyu', '那盆花', '那先聊到这')
    assert.equal(r3.verdict, 'propose')
    assert.equal((await nest.home()).topics[KEY].status, 'closing')
    t = await nest.transcript()
    assert.ok(t.lines.some((l) => l.type === 'topic-end' && l.about === '那盆花'))
    const sayEnd = t.lines.find((l) => l.type === 'say' && l.who === 'kyu' && l.rawText === '那先聊到这')
    assert.equal(sayEnd.about, '那盆花')
    // 墨璃继续说这条线：只算续谈，状态保持 closing（否决必须显式）
    await nest.say('moli', '等等还没说完', undefined, '那盆花')
    const r4 = await nest.resolveTopicSay('moli', '那盆花')
    assert.equal(r4.verdict, null)
    assert.equal((await nest.home()).topics[KEY].status, 'closing')
    // 显式否决：墨璃用 open_topic 重提同名 → topic-reopen 行 + 状态回 open
    const r5 = await nest.openTopic('moli', '那盆花', '等等，我还没说完呢')
    assert.equal(r5.reopened, true)
    assert.equal(r5.opened, false)
    assert.equal((await nest.home()).topics[KEY].status, 'open')
    t = await nest.transcript()
    assert.ok(t.lines.some((l) => l.type === 'topic-reopen' && l.char === 'moli'), 'topic-reopen 行入账')
    // 再收 → 墨璃非说话动作 → 接受 ended
    await nest.endTopic('kyu', '那盆花')
    const r6 = await nest.resolveTopicAction('moli')
    assert.equal(r6.accepted.length, 1)
    assert.equal((await nest.home()).topics[KEY].status, 'ended')
    // expireTopics：无 closing/open 话题时静默
    const r7 = await nest.expireTopics()
    assert.deepEqual(r7.expired, [])
    // 服务层 about 门禁（2026-09-16 定案·唯一真相）：about 是标签，台词是内容。
    // 指向不存在/已收掉的话题 → 摘掉标记照常入账，回执给模型人话原因；绝不吞台词。
    const before = (await nest.transcript()).lines.filter((l) => l.type === 'say').length
    const d1 = await nest.say('moli', '窗外那棵树的叶子掉了', undefined, '窗外那棵树')
    assert.equal(d1.aboutDropped, '窗外那棵树', '降级：报告丢掉的话题短语')
    assert.equal(d1.about, null, '降级后不带话题标记')
    assert.match(d1.aboutNote, /不存在或已经收掉/)
    const after1 = (await nest.transcript()).lines.filter((l) => l.type === 'say')
    assert.equal(after1.length, before + 1, '台词照常入账（旧的整句吞掉已退役）')
    assert.equal(after1[after1.length - 1].rawText, '窗外那棵树的叶子掉了')
    assert.ok(!after1[after1.length - 1].about, '不入账幽灵 about')
    // 已收掉的话题（那盆花刚 ended）同样降级
    const d2 = await nest.say('moli', '嗯', undefined, '那盆花')
    assert.equal(d2.aboutDropped, '那盆花')
    assert.equal((await nest.transcript()).lines.filter((l) => l.type === 'say').length, before + 2)
    // 合法 about 照旧挂上（不误伤）
    await nest.openTopic('kyu', '今晚吃什么', '今晚吃什么呢')
    const ok = await nest.say('moli', '吃面吧', undefined, '今晚吃什么')
    assert.equal(ok.about, '今晚吃什么')
    assert.equal(ok.aboutDropped, undefined)
  } finally {
    await cleanup()
  }
})

test('sliceEventsText：topic 行 + say.about 渲染进家史', () => {
  const home = {
    characters: {
      kyu: { id: 'kyu', name: '小玖' },
      moli: { id: 'moli', name: '墨璃' },
    },
  }
  const log = [
    { t: 't1', type: 'topic-open', char: 'kyu', about: '那盆花' },
    { t: 't2', type: 'say', who: 'kyu', text: '你看那盆花开了', about: '那盆花' },
    { t: 't3', type: 'topic-join', char: 'moli', about: '那盆花' },
    { t: 't4', type: 'topic-end', char: 'kyu', about: '那盆花' },
    { t: 't5', type: 'topic-reopen', char: 'moli', about: '那盆花' },
    { t: 't6', type: 'activity-pause', char: 'moli', activity: '做饭' },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n')
  const lines = sliceEventsText(home, log)
  assert.ok(lines.some((l) => l === '小玖提起话题：那盆花'), lines.join('|'))
  assert.ok(lines.some((l) => l === '小玖（聊那盆花）：你看那盆花开了'), lines.join('|'))
  assert.ok(lines.some((l) => l === '墨璃加入了话题：那盆花'), lines.join('|'))
  assert.ok(lines.some((l) => l === '小玖提议收掉话题：那盆花'), lines.join('|'))
  assert.ok(lines.some((l) => l === '墨璃：这个还要聊'), lines.join('|'))
  assert.ok(lines.some((l) => l === '墨璃放下了手里的活（做饭）'), lines.join('|'))
})

test('detectMoveIntent：认出台词里的位移意图，且不误伤对别人说的话', () => {
  const home = {
    rooms: DEFAULT_ROOMS,
    characters: { kyu: { id: 'kyu', name: '小玖', room: 'bedroom' } },
  }
  const hit = (text, action, h = home) => {
    const r = detectMoveIntent(text, action, h, 'kyu')
    return r ? r.name : null
  }
  // 命中：自称 + 紧邻房间名的去向动词（2026-09-10 片里三次漏网的同款句子）
  assert.equal(hit('主人你等下，小玖去书房把那个代码清干净，弄好了再回来陪你俩！'), '书房')
  assert.equal(hit('好啦好啦，小玖去书房把代码清干净了就来！'), '书房')
  assert.equal(hit('那我先回客厅了喵'), '客厅')
  assert.equal(hit('', '从床上蹦起来，我去厨房看看'), '厨房', 'action 里的位移同样算')
  // 漏网也无妨的反例：不是第一人称、动词不紧邻房间名、已经在那个房间
  assert.equal(hit('主人你去书房看看吧，那儿安静'), null, '对别人说不算自己的位移')
  assert.equal(hit('我去给你拿书房里的那本书'), null, '动词不紧邻房间名不算')
  assert.equal(hit('我回卧室了'), null, '已经在的房间不算「去」')
  assert.equal(hit('书房里好安静'), null, '没动词不算')
  // 房间列表来自 home（主人手改 home.json 增删房间也跟着走）
  const custom = {
    rooms: [{ id: 'attic', name: '阁楼' }],
    characters: { kyu: { id: 'kyu', name: '小玖', room: 'bedroom' } },
  }
  assert.equal(hit('我去阁楼找找看', null, custom), '阁楼')
})

// ── 听到缓冲修订 + 自主闸（2026-09-13）──
// 背景：书房攒满客厅的话，人散到卧室后才被复检捞起来 → 看起来像"回应了听不见的
// 卧室"（2026-09-13 片里真实发生）。修法：缓冲条目带说话时房间 + 唤醒前校验过时。

test('hear 条目带说话时房间：说话人后来挪走也不改', async () => {
  const { nest, cleanup } = await mk()
  try {
    await nest.open()
    await nest.moveCharacter('kyu', 'study')
    await nest.moveCharacter('moli', 'living')
    await nest.say('moli', '我先回卧室咯')
    await nest.moveCharacter('moli', 'bedroom') // 说完才走
    const h = await nest.hear('kyu')
    assert.equal(h.buffer.length, 1)
    assert.equal(h.buffer[0].room, 'living', '记的是说话那一刻的房间')
    assert.equal(h.buffer[0].from, 'moli')
  } finally {
    await cleanup()
  }
})

test('say 的 hearReady 只报本次声音真的传到的角色（旧：全屋扫描会误报）', async () => {
  const { nest, cleanup } = await mk()
  try {
    await nest.open()
    await nest.moveCharacter('kyu', 'study')
    await nest.moveCharacter('moli', 'living')
    // 书房攒满客厅的 3 条（小玖阈值 3），一直没被消费
    for (let i = 0; i < 3; i += 1) await nest.say('moli', '客厅动静' + i)
    assert.equal(hearReadyOf(await nest.home(), 'kyu'), true)
    // 小玖挪去浴室（与客厅不相邻）后，墨璃在客厅说话
    await nest.moveCharacter('kyu', 'bath')
    const r = await nest.say('moli', '客厅又一句')
    assert.equal(r.buffered.includes('kyu'), false, '这次声音到不了她耳朵')
    assert.equal(r.hearReady.includes('kyu'), false, '没听到就不该报 ready')
  } finally {
    await cleanup()
  }
})

test('过时动静：对话散场/人走远都不再掀被子（hearStaleOf / dropStaleHear）', async () => {
  const { dir, nest, cleanup } = await mk()
  try {
    const opened = await nest.open()
    await nest.moveCharacter('kyu', 'study')
    await nest.moveCharacter('moli', 'living')
    for (let i = 0; i < 3; i += 1) await nest.say('moli', '客厅动静' + i)
    // 攒满那一刻：客厅与书房相邻、对话正新鲜 → 照常唤醒（行为不变）
    assert.equal(hearStaleOf(await nest.home(), 'kyu', nest.now()), false)
    // 时间维度：一句之后过了 5 分钟（> HEAR_STALE_MS），那段对话早散场了
    const later = new Date(nest.now().getTime() + 5 * 60000)
    assert.equal(hearStaleOf(await nest.home(), 'kyu', later), true)
    // 空间维度：小玖挪去浴室（声源客厅 → 浴室 far）
    await nest.moveCharacter('kyu', 'bath')
    assert.equal(hearStaleOf(await nest.home(), 'kyu', nest.now()), true)
    assert.equal((await nest.dropStaleHear('kyu')).dropped, 3)
    assert.equal((await nest.hear('kyu')).buffer.length, 0)
    const logText = await readFile(join(dir, 'slices', opened.sliceId, 'log.jsonl'), 'utf8')
    assert.ok(logText.includes('hear-stale'), '落一条诊断账（观察期看误唤醒有多频繁）')
  } finally {
    await cleanup()
  }
})

test('hearStaleOf：没有 room/t 的旧条目视为可定位，不误判过时', () => {
  const home = {
    rooms: DEFAULT_ROOMS,
    characters: {
      kyu: { id: 'kyu', room: 'bedroom', hear: [{ from: 'moli', text: '旧数据' }] },
    },
  }
  assert.equal(hearStaleOf(home, 'kyu'), false)
  home.characters.kyu.hear = []
  assert.equal(hearStaleOf(home, 'kyu'), false, '空缓冲不算过时')
})

test('autonomyEnabled：离家照旧 / 在家看开关', () => {
  const at = (atHome, homeOn) =>
    autonomyEnabled({ master: { atHome }, ...(homeOn === undefined ? {} : { autonomy: { homeOn } }) })
  assert.equal(at(false, undefined), true, '离家：自动那档不动')
  assert.equal(at(false, false), true, '离家不受"在家开关"影响')
  assert.equal(at(true, undefined), false, '在家默认关（省 API、不抢主人模型槽位）')
  assert.equal(at(true, false), false)
  assert.equal(at(true, true), true, '打开后才跑')
})

test('setAutonomy：默认关、落盘、跨片保留', async () => {
  const { nest, cleanup } = await mk()
  try {
    await nest.open()
    assert.deepEqual((await nest.home()).autonomy, { homeOn: false })
    assert.deepEqual(await nest.setAutonomy({ homeOn: true }), { autonomy: { homeOn: true } })
    await nest.close()
    await nest.open()
    assert.equal((await nest.home()).autonomy.homeOn, true, '跨片保留（与阈值同规格）')
    await nest.setAutonomy({ homeOn: false })
    assert.equal((await nest.home()).autonomy.homeOn, false)
  } finally {
    await cleanup()
  }
})

test('home v3→v4 迁移：旧账本补 autonomy 默认关，用户数据不丢', async () => {
  const { dir, nest, cleanup } = await mk()
  try {
    await writeFile(
      join(dir, 'home.json'),
      JSON.stringify({
        version: 3,
        rooms: DEFAULT_ROOMS,
        characters: { kyu: { id: 'kyu', name: '小玖', room: 'living' } },
        master: { atHome: false, room: null },
        topics: {},
        hearThresholds: { kyu: 3 },
      }),
    )
    await nest.ensure()
    const home = await nest.home()
    assert.equal(home.version, HOME_VERSION)
    assert.deepEqual(home.autonomy, { homeOn: false })
    assert.deepEqual(home.characters.kyu.hear, [])
    assert.equal(home.characters.kyu.name, '小玖')
  } finally {
    await cleanup()
  }
})

test('home v4→v5 迁移：房间补 items 家当（已知房间默认稿，未知房间空数组，已有不动）', async () => {
  const { dir, nest, cleanup } = await mk()
  try {
    await writeFile(
      join(dir, 'home.json'),
      JSON.stringify({
        version: 4,
        rooms: [
          { id: 'living', name: '客厅', functions: ['聊天'], adjacent: ['kitchen'] },
          { id: 'attic', name: '阁楼', functions: [], adjacent: [] },
          { id: 'study', name: '书房', functions: [], adjacent: ['living'], items: [{ name: '我自己的东西' }] },
        ],
        characters: { kyu: { id: 'kyu', name: '小玖', room: 'living' } },
        master: { atHome: false, room: null },
        topics: {},
        autonomy: { homeOn: false },
        hearThresholds: { kyu: 3 },
      }),
    )
    await nest.ensure()
    const home = await nest.home()
    assert.equal(home.version, HOME_VERSION)
    assert.equal(home.rooms[0].name, '客厅')
    assert.deepEqual(home.rooms[0].adjacent, ['kitchen'], '用户数据不丢')
    assert.ok(home.rooms[0].items.length > 0, '已知房间补默认家当')
    assert.deepEqual(home.rooms[0].items[2], { name: '电视', state: '关着' })
    assert.deepEqual(home.rooms[1].items, [], '默认表里没有的房间给空数组（不猜主人有什么）')
    assert.deepEqual(home.rooms[2].items, [{ name: '我自己的东西' }], '已有 items 不被覆盖')
  } finally {
    await cleanup()
  }
})

// ── 家当（HOUSE_DESIGN §1）──

test('默认家当：每个默认房间都有东西，形态是 {name, state?}', () => {
  for (const r of DEFAULT_ROOMS) {
    assert.ok(Array.isArray(r.items) && r.items.length >= 2, r.id + ' 有家当')
    for (const it of r.items) {
      assert.equal(typeof it.name, 'string')
      assert.ok(!('state' in it) || typeof it.state === 'string', it.name + ' 的 state 是字符串')
    }
  }
})

test('roomItems/roomItemsText：归一化手写脏数据，数量与状态渲染，空房间不占 token', () => {
  const home = {
    rooms: [
      {
        id: 'living',
        name: '客厅',
        // 容错面：纯字符串、多余空白、缺 name、非对象、数字字符串数量、非法数量
        items: [
          { name: '沙发' },
          { name: '电视', state: '关着' },
          '茶几',
          { name: ' 落地灯 ', state: '   ' },
          { name: '消婴器', count: 50 },
          { name: '电池', count: '12' },
          { name: '垃圾袋', count: 0 },
          { name: '椅子', count: 2.5 },
          { state: '孤儿' },
          null,
          42,
        ],
      },
      { id: 'study', name: '书房', items: [] },
      { id: 'bath', name: '浴室' },
    ],
  }
  assert.deepEqual(roomItems(home, 'living'), [
    { name: '沙发', state: null, count: 1 },
    { name: '电视', state: '关着', count: 1 },
    { name: '茶几', state: null, count: 1 },
    { name: '落地灯', state: null, count: 1 },
    { name: '消婴器', state: null, count: 50 },
    { name: '电池', state: null, count: 12 },
    { name: '垃圾袋', state: null, count: 1 },
    { name: '椅子', state: null, count: 2 },
  ])
  assert.equal(
    roomItemsText(home, 'living'),
    '沙发、电视（关着）、茶几、落地灯、消婴器×50、电池×12、垃圾袋、椅子×2',
  )
  assert.equal(roomItemsText(home, 'study'), '', '空房间返回空串')
  assert.equal(roomItemsText(home, 'bath'), '', '缺 items 字段当空')
  assert.deepEqual(roomItems(home, 'nowhere'), [])
})

test('setRoomItems：整表替换、数量落盘、重名与非法值报错且不改盘', async () => {
  const { dir, nest, cleanup } = await mk()
  try {
    // 进货 50 个消婴器
    const r = await nest.setRoomItems('living', [
      { name: '沙发' },
      { name: '消婴器', count: 50, state: '新的' },
      { name: '水壶', count: 1 },
    ])
    assert.deepEqual(r.items, [
      { name: '沙发', state: null, count: 1 },
      { name: '消婴器', state: '新的', count: 50 },
      { name: '水壶', state: null, count: 1 },
    ])
    // 落盘是精简形态：count=1 不写、没状态不写
    const onDisk = JSON.parse(await readFile(join(dir, 'home.json'), 'utf8'))
    assert.deepEqual(onDisk.rooms.find((x) => x.id === 'living').items, [
      { name: '沙发' },
      { name: '消婴器', count: 50, state: '新的' },
      { name: '水壶' },
    ])
    // 数字字符串也认（前端输入框给的就是字符串）
    const r2 = await nest.setRoomItems('living', [{ name: '电池', count: '12' }])
    assert.equal(r2.items[0].count, 12)
    // 清空
    await nest.setRoomItems('living', [])
    assert.deepEqual((await nest.home()).rooms.find((x) => x.id === 'living').items, [])
    // 校验：报错，账本保持原样
    await assert.rejects(() => nest.setRoomItems('living', [{ name: '椅子' }, { name: '椅子' }]), /同名/)
    await assert.rejects(() => nest.setRoomItems('living', [{ name: '椅子', count: 0 }]), /数量/)
    await assert.rejects(() => nest.setRoomItems('living', [{ name: '椅子', count: '好多' }]), /数量/)
    await assert.rejects(() => nest.setRoomItems('living', [{ name: '  ' }]), /名字/)
    await assert.rejects(() => nest.setRoomItems('living', [{ name: 'a'.repeat(25) }]), /太长/)
    await assert.rejects(() => nest.setRoomItems('attic', []), /没有这个房间/)
    assert.deepEqual((await nest.home()).rooms.find((x) => x.id === 'living').items, [], '报错后账本没动')
  } finally {
    await cleanup()
  }
})

test('账本损坏：备份原文件 + 报错，绝不静默写默认家覆盖', async () => {
  const { dir, nest, cleanup } = await mk()
  try {
    await nest.home() // 建默认账本
    const p = join(dir, 'home.json')
    const good = await readFile(p, 'utf8')
    const broken = '{"version":5,"rooms":[{"id":"living"'
    await writeFile(p, broken)
    // 模拟重启：新实例重新 ensure
    const nest2 = new CatNest(dir, { now: fixedNow })
    await assert.rejects(() => nest2.ensure(), /读不出来/)
    assert.equal(await readFile(p, 'utf8'), broken, '原文件原地保留（没被默认家覆盖）')
    const baks = (await readdir(dir)).filter((f) => f.startsWith('home.json.corrupt-'))
    assert.equal(baks.length, 1, '另存了一份损坏备份')
    assert.equal(await readFile(join(dir, baks[0]), 'utf8'), broken)
    // 结构不对（缺 characters）也算损坏，一样不覆盖
    await writeFile(p, '{"version":5,"rooms":[]}')
    const nest4 = new CatNest(dir, { now: fixedNow })
    await assert.rejects(() => nest4.ensure(), /读不出来/)
    assert.equal(await readFile(p, 'utf8'), '{"version":5,"rooms":[]}', '结构不对也不覆盖')
    // 运行中读坏：抛错，不返回默认家
    await writeFile(p, good)
    const nest3 = new CatNest(dir, { now: fixedNow })
    await nest3.ensure()
    await writeFile(p, '{oops')
    await assert.rejects(() => nest3.home(), /读不出来/)
  } finally {
    await cleanup()
  }
})

// ── 家当账 + 家当工具（HOUSE_DESIGN §3/§4）──

test('itemsDiff：以名字为键算增删改（数量/状态变化才算 changed）', () => {
  const before = [
    { name: '沙发', state: null, count: 1 },
    { name: '消婴器', state: null, count: 50 },
    { name: '水壶', state: '满的', count: 1 },
  ]
  const after = [
    { name: '沙发', state: null, count: 1 },
    { name: '消婴器', state: null, count: 48 },
    { name: '水壶', state: '空的', count: 1 },
    { name: '零食', state: '新的', count: 3 },
  ]
  const d = itemsDiff(before, after)
  assert.deepEqual(d.added.map((i) => i.name), ['零食'])
  assert.deepEqual(d.removed, [])
  assert.deepEqual(d.changed.map((c) => c.name), ['消婴器', '水壶'])
  const d2 = itemsDiff(after, before)
  assert.deepEqual(d2.removed.map((i) => i.name), ['零食'])
  assert.deepEqual(d2.added, [])
})

test('itemsEventText：添/拿/变 三种说法，主人和猫娘各有主语', () => {
  const home = { characters: { kyu: { id: 'kyu', name: '小玖' } }, rooms: [{ id: 'living', name: '客厅' }] }
  assert.equal(
    itemsEventText({ room: 'living', by: 'master', added: [{ name: '消婴器', count: 50, state: '新的' }] }, home),
    '主人给客厅添了 消婴器×50（新的）',
  )
  assert.equal(
    itemsEventText({ room: 'living', by: 'kyu', removed: [{ name: '纸巾', count: 1 }] }, home),
    '小玖从客厅拿走了 纸巾',
  )
  assert.equal(
    itemsEventText({ room: 'living', by: 'kyu', took: [{ name: '消婴器', count: 2 }] }, home),
    '小玖从客厅拿走了 消婴器×2',
  )
  assert.equal(
    itemsEventText({ room: 'living', by: 'kyu', put: [{ name: '零食', count: 3, state: '新的' }] }, home),
    '小玖给客厅添了 零食×3（新的）',
  )
  assert.equal(
    itemsEventText({ room: 'living', by: 'kyu', changed: [{ name: '水壶', to: { name: '水壶', state: '空的', count: 1 } }] }, home),
    '小玖动了客厅的 水壶（空的）',
  )
  assert.equal(itemsEventText({ room: 'living', by: 'master' }, home), '')
})

test('家当账：setRoomItems 与家当工具都落 items 行（片内才记）', async () => {
  const { dir, nest, cleanup } = await mk()
  try {
    await nest.open()
    // 面板编辑：整表替换
    await nest.setRoomItems('living', [{ name: '消婴器', count: 50 }, { name: '沙发' }])
    // 猫娘：拿 2 个、放 3 包零食、改水壶状态
    const taken = await nest.takeItem('kyu', '消婴器', 2)
    assert.equal(taken.left, 48)
    const put = await nest.putItem('kyu', '零食', 3, '新的')
    assert.equal(put.count, 3)
    await nest.putItem('kyu', '水壶')
    const st = await nest.setItemState('kyu', '水壶', '空的')
    assert.equal(st.state, '空的')
    // 账本：片内 items 行按发生顺序排（面板一次 + 工具四次 = 五条）
    const cur = await nest.status()
    const rows = (await readFile(join(dir, 'slices', cur.sliceId, 'log.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .filter((r) => r.type === 'items')
    assert.equal(rows.length, 5, '五次变更五条账')
    assert.equal(rows[0].by, 'master')
    assert.ok(rows[0].added.some((i) => i.name === '消婴器'))
    assert.equal(rows[1].by, 'kyu')
    assert.deepEqual(rows[1].took, [{ name: '消婴器', count: 2 }], '工具报「拿了 2 个」，不是模糊的「变了」')
    assert.deepEqual(rows[2].put, [{ name: '零食', count: 3, state: '新的' }])
    assert.deepEqual(rows[3].put, [{ name: '水壶', count: 1, state: null }])
    assert.deepEqual(rows[4].changed.map((c) => c.name), ['水壶'])
    assert.equal(rows[4].changed[0].to.state, '空的')
    // 落盘是精简形态
    const onDisk = JSON.parse(await readFile(join(dir, 'home.json'), 'utf8'))
    const living = onDisk.rooms.find((r) => r.id === 'living').items
    assert.deepEqual(living.find((i) => i.name === '零食'), { name: '零食', count: 3, state: '新的' })
    assert.deepEqual(living.find((i) => i.name === '沙发'), { name: '沙发' })
    await nest.close()
  } finally {
    await cleanup()
  }
})

test('家当工具：拿不存在的 / 数量不够 / 改不存在的东西 都报错且不改账本', async () => {
  const { dir, nest, cleanup } = await mk()
  try {
    await nest.open()
    await nest.setRoomItems('living', [{ name: '消婴器', count: 3 }])
    await assert.rejects(() => nest.takeItem('kyu', '不存在的东西'), /没有/)
    await assert.rejects(() => nest.takeItem('kyu', '消婴器', 5), /只有 3 个/)
    await assert.rejects(() => nest.takeItem('kyu', '消婴器', 0), /整数/)
    await assert.rejects(() => nest.takeItem('kyu', '消婴器', 2.5), /整数/)
    await assert.rejects(() => nest.setItemState('kyu', '不存在的东西', 'x'), /没有/)
    await assert.rejects(() => nest.putItem('kyu', '', 1), /名字/)
    assert.deepEqual(roomItems(await nest.home(), 'living'), [{ name: '消婴器', state: null, count: 3 }])
    // 全拿走 → 从房间里消失
    const r = await nest.takeItem('kyu', '消婴器', 3)
    assert.equal(r.left, 0)
    assert.equal(roomItems(await nest.home(), 'living').length, 0)
    await nest.close()
  } finally {
    await cleanup()
  }
})

test('家当工具只能碰自己所在的房间', async () => {
  const { dir, nest, cleanup } = await mk()
  try {
    await nest.open()
    await nest.setRoomItems('kitchen', [{ name: '水壶' }])
    // 小玖默认在客厅：厨房的水壶够不着
    await assert.rejects(() => nest.takeItem('kyu', '水壶'), /没有/)
    await nest.moveCharacter('kyu', 'kitchen')
    const r = await nest.takeItem('kyu', '水壶')
    assert.equal(r.left, 0)
    await nest.close()
  } finally {
    await cleanup()
  }
})

// ── 参考话题池（§9.13）──

test('话题池类目表：每个默认房间都有对应类目，每类 6 条', () => {
  for (const c of TOPIC_SEED_CATEGORIES) {
    assert.ok(Array.isArray(TOPIC_SEEDS[c.id]), '类目 ' + c.id + ' 有池子')
    assert.equal(TOPIC_SEEDS[c.id].length, 6, c.id + ' 每类 6 条（只抽当前房间一类，条数不够会聊穷）')
  }
  for (const r of DEFAULT_ROOMS) {
    assert.ok(
      TOPIC_SEED_CATEGORIES.some((c) => c.kind === 'room' && c.room === r.id),
      '房间 ' + r.id + ' 有「关于xx」类目',
    )
  }
  assert.equal(TOPIC_SEED_CATEGORIES.filter((c) => c.kind === 'home').length, 4, '人物/家宅档 4 类')
})

test('pickTopicSeeds：场地档只认当前房间 + 人物档兜底；不同房间抽不同类', () => {
  const home = { characters: { kyu: { id: 'kyu', room: 'study' }, moli: { id: 'moli', room: 'kitchen' } }, topics: {} }
  const a = pickTopicSeeds(home, 'kyu', { rand: () => 0 })
  assert.equal(a.room.id, 'study')
  assert.equal(a.room.label, '关于书房')
  assert.equal(a.room.items.length, 3, '场地 3 条')
  assert.equal(a.other.items.length, 2, '人物/家宅 2 条')
  assert.equal(a.other.id, 'master', 'rand=0 取第一档')
  const b = pickTopicSeeds(home, 'moli', { rand: () => 0 })
  assert.equal(b.room.id, 'kitchen', '在厨房就聊厨房，不抽相邻也不抽别处')
})

test('pickTopicSeeds：指定类目 5 条；未知类目回 error；未知房间只给人物档', () => {
  const home = { characters: { kyu: { id: 'kyu', room: 'attic' } }, topics: {} }
  const auto = pickTopicSeeds(home, 'kyu', { rand: () => 0 })
  assert.equal(auto.room, null, '主人手加的房间没有类目 → 场地档空')
  assert.ok(auto.other.items.length > 0, '仍给人物/家宅档')
  const byCat = pickTopicSeeds(home, 'kyu', { category: '卧室', rand: () => 0 })
  assert.equal(byCat.room.label, '关于卧室')
  assert.equal(byCat.room.items.length, 5)
  const bad = pickTopicSeeds(home, 'kyu', { category: '天台' })
  assert.equal(bad.error, 'NO_CATEGORY')
  assert.ok(bad.categories.includes('书房'))
})

test('pickTopicSeeds：排除最近聊过的话题（防复读）', () => {
  const home = {
    characters: { kyu: { id: 'kyu', room: 'study' } },
    topics: {
      '书桌那一角': { about: '书桌那一角', status: 'open', participants: ['kyu'], openedBy: 'kyu', lastTurnAt: '2026-09-13T10:00:00+08:00' },
    },
  }
  const p = pickTopicSeeds(home, 'kyu', { rand: () => 0 })
  assert.deepEqual(p.recent, ['书桌那一角'])
  assert.ok(!p.room.items.some((t) => t.includes('书桌那一角')), '聊过的条目不重发')
  assert.ok(p.room.items.length > 0, '池子够厚，排除后仍抽得满')
})

test('activeTopicsOf / recentTopicPhrases：本人挂着的未结束话题才算', () => {
  const home = {
    characters: {},
    topics: {
      A: { about: 'A', status: 'open', participants: ['kyu'], openedBy: 'kyu', lastTurnAt: '2026-09-13T10:00:00+08:00' },
      B: { about: 'B', status: 'closing', participants: ['kyu', 'moli'], openedBy: 'moli', lastTurnAt: '2026-09-13T11:00:00+08:00' },
      C: { about: 'C', status: 'ended', participants: ['kyu'], openedBy: 'kyu', endedAt: '2026-09-13T12:00:00+08:00' },
      D: { about: 'D', status: 'open', participants: ['moli'], openedBy: 'moli', lastTurnAt: '2026-09-13T09:00:00+08:00' },
    },
  }
  assert.deepEqual(activeTopicsOf(home, 'kyu').map((x) => x.about).sort(), ['A', 'B'], 'open 与 closing 都算挂着；ended 不算')
  assert.deepEqual(activeTopicsOf(home, 'moli').map((x) => x.about).sort(), ['B', 'D'])
  assert.deepEqual(recentTopicPhrases(home, 2), ['C', 'B'], '按最近动静排序（ended 用 endedAt）')
})

test('topicSeedsText：渲染两档 + 用法说明；空抽签返回空串', () => {
  const home = { characters: { kyu: { id: 'kyu', room: 'balcony' } }, topics: {} }
  const text = topicSeedsText(pickTopicSeeds(home, 'kyu', { rand: () => 0 }))
  assert.ok(text.includes('【姐妹之间可以聊的（只是引子）】'))
  assert.ok(text.includes('关于阳台：'))
  assert.ok(text.includes('关于主人：'))
  assert.ok(text.includes('不想聊就安静待着'))
  assert.equal(topicSeedsText({ room: null, other: null }), '')
})
