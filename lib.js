// dsh-catnest/lib.js — 零依赖（B 规范）：猫窝状态账本 + 时间片生命周期 + 家物理。
//
// 纯逻辑层：给定一个目录（宿主侧默认 ~/.dsh/.catnest），管理以下文件：
//   home.json          家状态（房间布局 / 角色位置与活动 / 主人位置 / 听到缓冲）
//   relations.json     三对角色对数值（intimacy 亲密度 / spice 色色度，0..100）
//   current.json       当前打开时间片指针（close 后删除）
//   slices/<sliceId>/  每个时间片一个目录：meta.json / log.jsonl / open.snapshot.json / close.snapshot.json
//
// 语义（猫窝设计草案，随仓库 docs/ 分发）：
//   - 时间片 = 一次连续陪伴；模式外家静止 → 一切变更操作要求有打开的时间片
//   - 时间片切对话，不切状态：home / relations 跨时间片延续（含听到缓冲）
//   - 新时间片 open 时返回上一已关闭时间片的回顾：优先收尾摘要
//     （summary.json，角色调度层蒸馏产物），无则规则化回顾
//   - 事件（发情期/生日等）不建独立日历，复用记忆系统
//   - 家物理（里程碑二）：距离感知（同房/相邻/远处）、活动与响应度、
//     "听到"决策链缓冲（攒满阈值→喊话/无视）、同房接话顺序、点名打断、
//     主人方案二视角（一视同仁按距离感知）、在场对话回看（transcript）
//   - 角色调度（里程碑三）：companion 名册同步纯函数（companionSync/
//     relationSync，名册数据由 index.js 从 dsh-personas companion 字段读取）；
//     感知遍历以 home.characters 为准（名册同步后新角色自动参与物理）；
//     时间片事件文本化（sliceEventsText，供收尾蒸馏 / LLM 回顾喂料）
//   - 打断反应不穷举：物理层只产出规则与事件，反应由 index.js 调度层 AI 生成

import { mkdir, readdir, readFile, rename, rm, stat, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'

// 猫窝角色名册（默认兜底）：正常运行时从 dsh-personas 的 companion 字段读取
// （见 index.js companions()），这里仅作无 personas 服务时的回退。
export const COMPANION_IDS = ['kyu', 'moli']
export const CHARACTER_NAMES = { kyu: '小玖', moli: '墨璃' }
// 家人一句话简卡（公共知识：外貌/性格关键词）——进各角色 system 的【家人】段，
// 让成员互相知道彼此的基本形象（否则小玖连墨璃长什么都不知道）。
// 原则：简卡是公共知识，全卡是私人身份；只给关键词不注入完整人设，防他人视角污染自我。
export const CHARACTER_BIOS = {
  kyu: '小玖：白毛浅绿瞳的猫娘少女，活泼黏人，偶尔傲娇，专注起来六亲不认。',
  moli: '墨璃：黑长直红瞳的姐姐，温柔沉静，说话轻声细语，最会照顾人。',
}

// 房间建议稿（草案第四节）；home.json 落盘后以文件为准，主人增删直接改文件
export const DEFAULT_ROOMS = [
  { id: 'entry', name: '玄关', functions: ['迎接', '送别'], adjacent: ['living'] },
  { id: 'living', name: '客厅', functions: ['读书', '聊天', '游戏', '看电视'], adjacent: ['entry', 'kitchen', 'balcony', 'study', 'bedroom'] },
  { id: 'study', name: '书房', functions: ['安静看书', '发呆'], adjacent: ['living'] },
  { id: 'kitchen', name: '厨房', functions: ['做饭', '吃东西', '投喂'], adjacent: ['living'] },
  { id: 'bedroom', name: '卧室', functions: ['睡觉', '贴贴', '亲密'], adjacent: ['living'] },
  { id: 'bath', name: '浴室', functions: ['洗漱', '泡澡'], adjacent: ['bedroom'] },
  { id: 'balcony', name: '阳台', functions: ['晒太阳', '看风景', '晾衣服'], adjacent: ['living'] },
]

// 三对角色对（草案第六节：主人×姐姐、主人×小玖、姐姐×小玖）
export const RELATION_PAIRS = ['master:kyu', 'master:moli', 'moli:kyu']
export const RELATION_FIELDS = ['intimacy', 'spice']
export const INITIAL_RELATIONS = { intimacy: 50, spice: 0 }
// companion 初始亲密（2026-08-22 主人拍板：小玖20/姐姐10，慢慢堆；未知角色 15）
export const INITIAL_INTIMACY = { kyu: 20, moli: 10 }
export const DEFAULT_INITIAL_INTIMACY = 15
export function initialRelationsOf(companionId) {
  return {
    intimacy: INITIAL_INTIMACY[companionId] ?? DEFAULT_INITIAL_INTIMACY,
    spice: 0,
  }
}

// ── 家物理常量（草案第四节）──
// v2→v3（2026-09-05 §9）：home.topics 话题状态（片内作用域）+ 角色 activityPaused
// （pause_activity 放下锅铲）+ lastAmbientAt（活动隔墙动静去重）
export const HOME_VERSION = 3
// "听到"决策链阈值（草案：小玖3条/姐姐5条，待调——存 home.json 可改）
export const HEAR_THRESHOLDS = { kyu: 3, moli: 5 }
// 同房接话顺序：小玖活泼先抢，姐姐谦让（草案 4.5）
export const TURN_ORDER = ['kyu', 'moli']
// 距离层级（草案 4.2 主人已定）：同房间可对话；相邻能听到动静；远处与不在家无感
export const DISTANCE_LEVELS = ['same', 'adjacent', 'far']

// ── 持久状态目录（2026-08-30 主人拍板：猫科为主，发情周期）──
// 每个条件是一条「时间段」：{ id, name, startAt, endAt, cycleDays? }。
// phase（pending/active/expired）由 now 实时推导，不落盘；cycleDays 表示
// 到期后几天自动开始下一轮（发情周期自动续）。
export const CONDITION_TYPES = {
  estrus: { label: '发情期', defaultDays: 4, cycleDays: 20 },
  sick: { label: '生病', defaultDays: 2 },
  injured: { label: '受伤', defaultDays: 2 },
  tired: { label: '疲劳', defaultDays: 1 },
}
// 未知状态名的默认时长（天）
export const CONDITION_DEFAULT_DAYS = 1
// 中文名 → 收录键别名（模型挂状态写中文名「发情」，需映射回 estrus，
// 否则查不到收录表 → 默认时长/周期失效，回落通用 1 天。2026-08-30 实测踩中）
export const CONDITION_ALIASES = {
  发情: 'estrus',
  发情期: 'estrus',
  生病: 'sick',
  受伤: 'injured',
  疲劳: 'tired',
  estrus: 'estrus',
  sick: 'sick',
  injured: 'injured',
  tired: 'tired',
}
// 归一化：中文名 → 收录键（查不到原样返回）
export function conditionKey(name) {
  const k = CONDITION_ALIASES[name]
  return k || name
}

const HOME_FILE = 'home.json'
const RELATIONS_FILE = 'relations.json'
const CURRENT_FILE = 'current.json'
const SLICES_DIR = 'slices'
const META_FILE = 'meta.json'
const LOG_FILE = 'log.jsonl'
const OPEN_SNAP_FILE = 'open.snapshot.json'
const CLOSE_SNAP_FILE = 'close.snapshot.json'

function defaultHome() {
  return {
    version: HOME_VERSION,
    rooms: DEFAULT_ROOMS.map((r) => ({ ...r, adjacent: [...r.adjacent] })),
    characters: Object.fromEntries(
      COMPANION_IDS.map((id) => [
        id,
        {
          id,
          name: CHARACTER_NAMES[id] ?? id,
          room: 'living',
          activity: null,
          activityEndsAt: null,
          activityLeftMs: null, // 模式外冻结时的剩余毫秒（close 时写入，open 时换回 endsAt）
          activityPaused: null, // pause_activity「放下锅铲」：暂停中的活动标记（暂停=不忙）
          lastAmbientAt: null, // 活动隔墙动静上次入账时刻（§9.5，每 10min 补一条去重）
          mood: null, // 挂状态（心情/神态，字符串；空=无），瞬态随位置进场景动态窗口
          conditions: [], // 持久状态（时间段）：{ id, name, startAt, endAt, cycleDays? }
          hear: [], // "听到"决策链缓冲（相邻动静攒存）
        },
      ]),
    ),
    hearThresholds: { ...HEAR_THRESHOLDS },
    master: { atHome: false, room: null },
    topics: {}, // 话题状态（§9.2，片内作用域：open 时清空；跨片不延续）
  }
}

function defaultRelations() {
  return {
    version: 1,
    pairs: Object.fromEntries(RELATION_PAIRS.map((p) => [p, { ...INITIAL_RELATIONS }])),
  }
}

// sliceId：本地时间 YYYYMMDDTHHMMSS（家按主人的时钟过日子）
export function sliceIdOf(date) {
  const p = (n) => String(n).padStart(2, '0')
  return (
    String(date.getFullYear()) +
    p(date.getMonth() + 1) +
    p(date.getDate()) +
    'T' +
    p(date.getHours()) +
    p(date.getMinutes()) +
    p(date.getSeconds())
  )
}

function clamp(v) {
  return Math.max(0, Math.min(100, Math.round(v)))
}

async function pathExists(p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

export function roomName(home, roomId) {
  const r = (home.rooms || []).find((x) => x.id === roomId)
  return r ? r.name : String(roomId)
}

// ── 家物理 · 纯函数 ──

// 距离层级：same（同房间可对话）/ adjacent（相邻能听到动静）/ far（远处与不在家无感）
export function roomRelation(home, fromRoom, toRoom) {
  if (fromRoom === toRoom) return 'same'
  const room = (home.rooms || []).find((r) => r.id === fromRoom)
  if (!room || !Array.isArray(room.adjacent)) return 'far'
  return room.adjacent.includes(toRoom) ? 'adjacent' : 'far'
}

// 角色是否在忙（有活动且未到期；无结束时间的活动视为一直在忙）。
// 暂停中的活动（activityPaused，「放下锅铲」）= 不忙：可被叫、可接话、可被轻推（§9.9）。
export function isBusy(ch, now) {
  if (!ch || !ch.activity) return false
  if (ch.activityPaused) return false
  if (!ch.activityEndsAt) return true
  return new Date(ch.activityEndsAt).getTime() > now.getTime()
}

// ── 持久状态（conditions）纯函数 ──

// 条件名 → 展示标签（收录表优先，未知状态名原样）
export function conditionLabel(name) {
  const t = CONDITION_TYPES[conditionKey(name)]
  return t && t.label ? t.label : String(name)
}

// 时间段状态当前相位：pending（未开始） / active（进行中） / expired（已到期）
export function conditionPhase(cond, now) {
  const startAt = cond && cond.startAt ? new Date(cond.startAt).getTime() : null
  const endAt = cond && cond.endAt ? new Date(cond.endAt).getTime() : null
  const t = now instanceof Date ? now.getTime() : Date.now()
  if (startAt !== null && t < startAt) return 'pending'
  if (endAt !== null && t >= endAt) return 'expired'
  return 'active'
}

// 人类可读的时段差："还剩X天Y小时" / "还有X天Y小时后开始"
export function humanInterval(fromMs, toMs) {
  const ms = Math.max(0, toMs - fromMs) // 截断成倒计时，不显示负值
  const days = Math.floor(ms / 86400000)
  const hours = Math.floor((ms % 86400000) / 3600000)
  if (days > 0) return days + '天' + (hours > 0 ? hours + '小时' : '')
  if (hours > 0) return hours + '小时' + Math.floor((ms % 3600000) / 60000) + '分'
  return Math.max(1, Math.ceil(ms / 60000)) + '分钟'
}

// 状态卡/场景一行话：进行中显示剩余，未开始显示倒计时，到期空串（由推进清理）
export function conditionText(cond, now) {
  if (!cond) return ''
  const t = now instanceof Date ? now.getTime() : Date.now()
  const startAt = cond.startAt ? new Date(cond.startAt).getTime() : null
  const endAt = cond.endAt ? new Date(cond.endAt).getTime() : null
  const phase = conditionPhase(cond, now)
  const label = conditionLabel(cond.name)
  if (phase === 'pending' && startAt !== null) return label + '（还有' + humanInterval(t, startAt) + '开始）'
  if (phase === 'active' && endAt !== null) return label + '中（还剩' + humanInterval(t, endAt) + '）'
  if (phase === 'active') return label + '中'
  return ''
}

// 到期推进（就地改 home）：pending→active 翻转 → start 事件（notifiedAt 一次性确认，
// 按轮次：续轮后 startAt 前移，下一轮再触发）；expired 且带 cycleDays → 自动排下一轮
// （发情周期续）；expired 无周期 → 移除。返回 { changed }，供 log 与调度层唤醒。
export function advanceConditions(home, now) {
  const t = now instanceof Date ? now.getTime() : Date.now()
  const changed = []
  for (const ch of Object.values(home.characters || {})) {
    if (!ch || !Array.isArray(ch.conditions) || ch.conditions.length === 0) continue
    const kept = []
    for (const cond of ch.conditions) {
      const phase = conditionPhase(cond, now)
      if (phase === 'active') {
        // pending→active 翻转（一次性）：notifiedAt 未确认或落后于当前轮 startAt 才触发
        const notifiedT = cond.notifiedAt ? new Date(cond.notifiedAt).getTime() : null
        const startT = new Date(cond.startAt).getTime()
        if (notifiedT === null || notifiedT < startT) {
          cond.notifiedAt = cond.startAt
          changed.push({ charId: ch.id, condition: cond.name, kind: 'start', startAt: cond.startAt })
        }
        kept.push(cond)
        continue
      }
      if (phase !== 'expired') {
        kept.push(cond)
        continue
      }
      const endAt = new Date(cond.endAt).getTime()
      const cycleDays = Number(cond.cycleDays)
      if (Number.isFinite(cycleDays) && cycleDays > 0) {
        const durMs = endAt - new Date(cond.startAt).getTime()
        const nextStart = new Date(endAt + cycleDays * 86400000)
        const nextEnd = new Date(nextStart.getTime() + Math.max(durMs, 86400000))
        cond.startAt = nextStart.toISOString()
        cond.endAt = nextEnd.toISOString()
        kept.push(cond)
        changed.push({ charId: ch.id, condition: cond.name, kind: 'renew', nextStart: cond.startAt })
      } else {
        changed.push({ charId: ch.id, condition: cond.name, kind: 'expire' })
      }
    }
    ch.conditions = kept
  }
  return { changed }
}

// 某角色"听到"缓冲是否攒满阈值（触发喊话/无视决策机会）
export function hearReadyOf(home, charId, now) {
  const ch = home.characters && home.characters[charId]
  if (!ch) return false
  const threshold =
    (home.hearThresholds && home.hearThresholds[charId]) || HEAR_THRESHOLDS[charId] || 3
  return (ch.hear || []).length >= threshold
}

// 同一房间空闲角色按性格的接话顺序（小玖活泼先抢，墨璃谦让）
export function respondersOrder(home, roomId, now) {
  return TURN_ORDER.filter((id) => {
    const ch = home.characters && home.characters[id]
    return ch && ch.room === roomId && !isBusy(ch, now)
  })
}

// 角色显示名（主人/名册名）
export function charName(home, id) {
  if (id === 'master') return '主人'
  return (home.characters && home.characters[id] && home.characters[id].name) || CHARACTER_NAMES[id] || String(id)
}

// ── 话题（topic）状态纯函数（路 B §9.2，2026-09-05 三轮定稿）──
// home.topics = { [openedBy + '|' + about]: { about, room, openedBy, to?, participants,
//   openedAt, lastTurnAt, turns, status: 'open'|'closing'|'ended', endedBy?, endedAt? } }
// status 流转：open →（end_topic 提议）closing →（另一参与方裁决 / 沉默兜底）ended；
// 裁决否决（对方继续说 X）回 open。话题是片内作用域（nest.open 清空；片内进程重启不丢）。
// 一轮 = 一条解析到 X 的 say；账本行只记 open/join/end/reopen，接受/沉默收尾无独立行。

// 收话题沉默超时（tick 兜底）：自最后一条 mention 起 10 分钟无人对 X 说话 → 沉默自动收
export const TOPIC_SILENCE_TIMEOUT_MS = 10 * 60000
// 活动隔墙动静「持续中」补条间隔（§9.5）：每 10min tick 补一条，同窗不重复
export const AMBIENT_REPEAT_MS = 10 * 60000

export function topicKey(charId, about) {
  return charId + '|' + about
}

// 匹配规则（「解析到 X」）：about 完全相等优先；否则 X 是 X.room 里唯一话题 且
// 说话人是参与方 且这次 say 带 about。拿不准按不解析（保守，可用精确短语消歧）。
export function matchTopic(home, charId, about) {
  const topics = home && home.topics ? home.topics : {}
  const list = Object.values(topics).filter((x) => x && x.status !== 'ended')
  const a = typeof about === 'string' ? about.trim() : ''
  if (!a || list.length === 0) return null
  const exact = list.filter((x) => x.about === a)
  if (exact.length > 0) {
    return exact.sort((p, q) => String(q.lastTurnAt || '').localeCompare(String(p.lastTurnAt || '')))[0]
  }
  const ch = home.characters && home.characters[charId]
  const myRoom = ch ? ch.room : null
  const inRoom = myRoom ? list.filter((x) => x.room === myRoom) : []
  if (inRoom.length === 1) {
    const x = inRoom[0]
    if (Array.isArray(x.participants) && x.participants.includes(charId)) return x
  }
  return null
}

// 开启话题（幂等）：同人同短语重复提起＝幂等更新（不重置参与方/轮次，只刷新现场）。
// 返回 { key, opened, topic }；opened=false 表示更新的是既有话题。
export function topicOpenState(home, now, charId, about, to) {
  const topics = home.topics || (home.topics = {})
  const a = String(about).trim()
  const key = topicKey(charId, a)
  const t = now instanceof Date ? now.getTime() : Date.now()
  const ch = home.characters && home.characters[charId]
  const room = ch ? ch.room : null
  const existing = topics[key]
  if (existing) {
    existing.room = room
    existing.lastTurnAt = new Date(t).toISOString()
    existing.turns = (existing.turns || 0) + 1
    return { key, opened: false, topic: existing }
  }
  const topic = {
    about: a,
    room,
    openedBy: charId,
    ...(to ? { to } : {}),
    participants: [charId],
    openedAt: new Date(t).toISOString(),
    lastTurnAt: new Date(t).toISOString(),
    turns: 1,
    status: 'open',
  }
  topics[key] = topic
  return { key, opened: true, topic }
}

// 一次 say 后的话题账：裁决（closing 中另一参与方说话→否决，其他动作/不解析→接受）+
// 加入（open 中非参与方第一条解析到 X 的 say）+ 续谈（参与方轮数 +1）。
// 返回 { matched, key, verdict: null|'reopen'|'join', joined, accepted:[话题] }
// accepted=本次说话顺带裁决收掉的话题（无独立账本行，仅状态，供测试观察）。
export function topicResolveSay(home, now, charId, about) {
  const topics = home.topics || {}
  const t = now instanceof Date ? now.getTime() : Date.now()
  const accepted = []
  const mx = matchTopic(home, charId, about)
  // 1) 裁决接受：参与中的 closing 话题，除解析到 X 的（→ 下面否决），其余接受收掉
  for (const x of Object.values(topics)) {
    if (!x || x.status !== 'closing') continue
    if (x.endedBy === charId) continue // 提议人自己不动自己的话题
    if (!Array.isArray(x.participants) || !x.participants.includes(charId)) continue
    if (mx === x) continue // 说得正起劲 → 否决，算继续聊
    x.status = 'ended'
    x.endedBy = charId
    x.endedAt = new Date(t).toISOString()
    accepted.push(x)
  }
  if (!mx) return { matched: false, key: null, verdict: null, joined: false, accepted }
  const key = Object.keys(topics).find((k) => topics[k] === mx)
  // 2) 否决：另一参与方在 closing 中说了解析到 X 的内容 → 回 open（reopen 账本行）
  if (mx.status === 'closing' && mx.endedBy !== charId && Array.isArray(mx.participants) && mx.participants.includes(charId)) {
    mx.status = 'open'
    mx.turns = (mx.turns || 0) + 1
    mx.lastTurnAt = new Date(t).toISOString()
    return { matched: true, key, verdict: 'reopen', joined: false, accepted }
  }
  // 3) 加入：open 话题里非参与方第一条解析到 X 的 say（topic-join 账本行）
  if (mx.status === 'open' && !(Array.isArray(mx.participants) && mx.participants.includes(charId))) {
    mx.participants = [...(mx.participants || []), charId]
    mx.turns = (mx.turns || 0) + 1
    mx.lastTurnAt = new Date(t).toISOString()
    return { matched: true, key, verdict: 'join', joined: true, accepted }
  }
  // 4) 续谈：参与者（或 closing 中提议人自己再说）轮数 +1；非参与方提到不算
  if (Array.isArray(mx.participants) && mx.participants.includes(charId)) {
    mx.turns = (mx.turns || 0) + 1
    mx.lastTurnAt = new Date(t).toISOString()
  }
  return { matched: true, key, verdict: null, joined: false, accepted }
}

// 一次非说话动作后的话题账：参与中的 closing 话题 → 裁决接受（ended）。
// （B 做了 do_activity/move_to/set_condition 等 → 接受；无独立账本行，仅状态）
export function topicResolveAction(home, now, charId) {
  const topics = home.topics || {}
  const t = now instanceof Date ? now.getTime() : Date.now()
  const accepted = []
  for (const x of Object.values(topics)) {
    if (!x || x.status !== 'closing') continue
    if (x.endedBy === charId) continue
    if (!Array.isArray(x.participants) || !x.participants.includes(charId)) continue
    x.status = 'ended'
    x.endedBy = charId
    x.endedAt = new Date(t).toISOString()
    accepted.push(x)
  }
  return { accepted }
}

// end_topic：open → closing（提议收掉）；另一参与方在 closing 中再 end → 双收（ended）。
// 只允许话题参与方调用。end_topic 是精确动作（要收哪个说哪个）：只匹配 about 完全相等。
// 返回 { key, verdict: 'propose'|'accepted'|null }；找不到返回 key:null。
export function topicEndState(home, now, charId, about) {
  const topics = home.topics || {}
  const a = typeof about === 'string' ? about.trim() : ''
  if (!a) return { key: null, verdict: null }
  const cands = Object.entries(topics)
    .map(([k, v]) => ({ k, v }))
    .filter(
      ({ v }) =>
        v &&
        v.status !== 'ended' &&
        v.about === a &&
        Array.isArray(v.participants) &&
        v.participants.includes(charId),
    )
    .sort((p, q) => String(q.v.lastTurnAt || '').localeCompare(String(p.v.lastTurnAt || '')))
  if (cands.length === 0) return { key: null, verdict: null }
  const x = cands[0].v
  const key = cands[0].k
  const t = now instanceof Date ? now.getTime() : Date.now()
  if (x.status === 'closing') {
    if (x.endedBy !== charId) {
      // 双收：对方也提收 → 直接 ended
      x.status = 'ended'
      x.endedBy = charId
      x.endedAt = new Date(t).toISOString()
      return { key, verdict: 'accepted' }
    }
    x.lastTurnAt = new Date(t).toISOString()
    return { key, verdict: 'propose' } // 自己再提：幂等保持 closing
  }
  if (x.status === 'open') {
    x.status = 'closing'
    x.endedBy = charId
    x.lastTurnAt = new Date(t).toISOString()
    return { key, verdict: 'propose' }
  }
  return { key, verdict: null } // 已 ended
}

// tick 兜底：status!=ended 且超时（默认 10 分钟）无人说话 → 沉默自动收（endedBy='silence'）
export function topicExpire(home, now, timeoutMs) {
  const topics = home.topics || {}
  const t = now instanceof Date ? now.getTime() : Date.now()
  const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : TOPIC_SILENCE_TIMEOUT_MS
  const expired = []
  for (const x of Object.values(topics)) {
    if (!x || x.status === 'ended') continue
    const last = x.lastTurnAt ? new Date(x.lastTurnAt).getTime() : t
    if (t - last <= ms) continue
    x.status = 'ended'
    x.endedBy = 'silence'
    x.endedAt = new Date(t).toISOString()
    expired.push(x)
  }
  return expired
}

// 模式外冻结：close 时把进行中的活动换算成剩余毫秒（模式外时间不流逝）
export function freezeActivities(home, now) {
  for (const ch of Object.values(home.characters || {})) {
    if (ch.activity && typeof ch.activityEndsAt === 'string') {
      const left = new Date(ch.activityEndsAt).getTime() - now.getTime()
      if (left <= 0) {
        // 片内已到期：活动自然结束
        ch.activity = null
        ch.activityEndsAt = null
        ch.activityLeftMs = null
      } else {
        ch.activityLeftMs = left
        ch.activityEndsAt = null
      }
    } else if (!ch.activity) {
      ch.activityLeftMs = null
    }
  }
}

// 模式内解冻：open 时把剩余毫秒换回新的结束时间（片外流逝不计入）
export function thawActivities(home, now) {
  for (const ch of Object.values(home.characters || {})) {
    if (ch.activity && !ch.activityEndsAt && Number.isFinite(ch.activityLeftMs) && ch.activityLeftMs > 0) {
      ch.activityEndsAt = new Date(now.getTime() + ch.activityLeftMs).toISOString()
      ch.activityLeftMs = null
    }
  }
}

// 对话事件 → 人话（transcript 回看用）
export function dialogueText(home, e) {
  const who = e.who || e.char
  const name = charName(home, who)
  switch (e.type) {
    case 'say':
      return e.action
        ? `${name}（${e.action}）${typeof e.about === 'string' && e.about ? `（聊${e.about}）` : ''}：${e.text}`
        : `${name}${typeof e.about === 'string' && e.about ? `（聊${e.about}）` : ''}：${e.text}`
    case 'shout':
      return `${name}喊话（喊${charName(home, e.target)}）：${e.text}`
    case 'hear':
      return `${charName(home, e.char)}听到${charName(home, e.from)}的动静：${e.text}`
    case 'topic-open':
      return `${name}${e.to ? '向' + charName(home, e.to) : ''}提起话题：${e.about}`
    case 'topic-join':
      return `${name}加入了话题：${e.about}`
    case 'topic-end':
      return `${name}提议收掉话题：${e.about}`
    case 'topic-reopen':
      return `${name}：这个还要聊`
    case 'activity-pause':
      return `${name}放下了手里的活（${e.activity}）`
    default:
      return ''
  }
}

function parseLog(text) {
  return String(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

// 规则化回顾（纯函数）：上一时间片的"主人离开时家里什么样"。
// 输入：sliceId、meta、开/关快照、log 原文。无 close 快照返回 null。
export function buildRecap(sliceId, meta, openSnap, closeSnap, logText) {
  if (!closeSnap || !closeSnap.home) return null
  const events = parseLog(logText)
  const home = closeSnap.home
  const chars = Object.values(home.characters || {})

  const parts = []
  for (const ch of chars) {
    const moves = events.filter((e) => e.type === 'move' && e.char === ch.id).length
    const acts = events.filter((e) => e.type === 'activity' && e.char === ch.id && e.activity)
    const last = acts.length ? acts[acts.length - 1].activity : ch.activity
    const bits = []
    if (moves > 0) bits.push(`挪了${moves}次窝`)
    if (last) bits.push(`在做${last}`)
    if (bits.length) parts.push(`${ch.name}${bits.join('，')}`)
  }

  const relDeltas = []
  const relEvents = events.filter((e) => e.type === 'relation')
  if (openSnap && openSnap.relations && relEvents.length) {
    for (const pair of RELATION_PAIRS) {
      const a = openSnap.relations.pairs && openSnap.relations.pairs[pair]
      const b = closeSnap.relations.pairs && closeSnap.relations.pairs[pair]
      if (!a || !b) continue
      for (const f of RELATION_FIELDS) {
        const d = b[f] - a[f]
        if (d !== 0) relDeltas.push(`${pair} 的${f === 'intimacy' ? '亲密度' : '色色度'}${d > 0 ? '升了' : '降了'}${Math.abs(d)}`)
      }
    }
  }

  const closing = chars.map((ch) => `${ch.name}在${roomName(home, ch.room)}`)

  const when =
    meta && typeof meta.openedAt === 'string' ? meta.openedAt.slice(0, 16).replace('T', ' ') : sliceId
  const durMin =
    meta && typeof meta.openedAt === 'string' && typeof meta.closedAt === 'string'
      ? Math.round((new Date(meta.closedAt).getTime() - new Date(meta.openedAt).getTime()) / 60000)
      : null
  const head = `上次在一起（${when}${durMin !== null ? `，约${durMin}分钟）` : ''}：`

  const out = [head]
  if (parts.length === 0 && relDeltas.length === 0) {
    out.push('家里安安静静的。')
  } else {
    if (parts.length) out.push(`${parts.join('；')}。`)
    if (relDeltas.length) out.push(`${relDeltas.join('，')}。`)
  }
  if (closing.length) out.push(`走的时候，${closing.join('，')}。`)
  return out.join('')
}

// ── 角色调度（里程碑三）纯函数 ──

// companion 名册 → 家角色（纯函数）：名册里缺的角色补进家（默认客厅、无活动、
// 空缓冲），已有角色原样保留（名册移除不自动逐出，家是持久状态，避免误删）。
// companions: [{id, name}]，来自 dsh-personas companion: true 的人设。
// 返回 { home, added: [新补角色 id] }
export function companionSync(home, companions) {
  const next = { ...home, characters: { ...(home.characters || {}) } }
  const added = []
  for (const c of companions || []) {
    const id = c && c.id
    if (!id || typeof id !== 'string') continue
    if (next.characters[id]) continue
    next.characters[id] = {
      id,
      name: (c && c.name) || CHARACTER_NAMES[id] || id,
      room: 'living',
      activity: null,
      activityEndsAt: null,
      activityLeftMs: null,
      activityPaused: null,
      lastAmbientAt: null,
      mood: null,
      conditions: [],
      hear: [],
    }
    added.push(id)
  }
  return { home: next, added }
}

// companion 名册 → 关系对（纯函数）：新角色自动建 master×新角色 对（初始亲密
// 按 INITIAL_INTIMACY 表，主人拍板小玖20/姐姐10），已有对与姐妹对不动。
// 返回 { rel, added: [新关系对] }
export function relationSync(rel, companionIds) {
  const next = { ...rel, pairs: { ...(rel.pairs || {}) } }
  const added = []
  for (const id of companionIds || []) {
    if (!id || typeof id !== 'string') continue
    const pair = `master:${id}`
    if (next.pairs[pair]) continue
    next.pairs[pair] = initialRelationsOf(id)
    added.push(pair)
  }
  return { rel: next, added }
}

// 时间片事件流 → 人话时间线（纯函数，收尾蒸馏 / LLM 回顾喂料）。
// 与 dialogueText（只覆盖对话事件、transcript 用）不同，这里覆盖全部事件类型，
// 按 log 顺序逐条成句。
export function sliceEventsText(home, logText) {
  const events = parseLog(logText)
  const lines = []
  for (const e of events) {
    switch (e.type) {
      case 'say':
        lines.push(
          `${charName(home, e.who)}${e.action ? `（${e.action}）` : ''}${typeof e.about === 'string' && e.about ? `（聊${e.about}）` : ''}：${e.text}`,
        )
        break
      case 'shout':
        lines.push(`${charName(home, e.char)}朝${charName(home, e.target)}喊话：${e.text}`)
        break
      case 'hear-ignore':
        lines.push(`${charName(home, e.char)}掂量了一下，没理会动静`)
        break
      case 'topic-open':
        lines.push(`${charName(home, e.char)}${e.to ? '向' + charName(home, e.to) : ''}提起话题：${e.about}`)
        break
      case 'topic-join':
        lines.push(`${charName(home, e.char)}加入了话题：${e.about}`)
        break
      case 'topic-end':
        lines.push(`${charName(home, e.char)}提议收掉话题：${e.about}`)
        break
      case 'topic-reopen':
        lines.push(`${charName(home, e.char)}：这个还要聊`)
        break
      case 'activity-pause':
        lines.push(`${charName(home, e.char)}放下了手里的活（${e.activity}）`)
        break
      case 'move':
        lines.push(`${charName(home, e.char)}从${roomName(home, e.from)}挪去了${roomName(home, e.to)}`)
        break
      case 'activity':
        if (e.activity) lines.push(`${charName(home, e.char)}开始${e.activity}`)
        else lines.push(`${charName(home, e.char)}做完了事`)
        break
      case 'master-move':
        if (e.to) lines.push(`主人回来，去了${roomName(home, e.to)}`)
        else lines.push(`主人出门了`)
        break
      case 'relation':
        lines.push(`${e.pair} 的${e.field === 'intimacy' ? '亲密度' : '色色度'}从 ${e.from} 变到 ${e.to}`)
        break
      case 'interrupt':
        lines.push(
          `${charName(home, e.by)}叫住了${charName(home, e.char)}${e.activity ? `（当时正在${e.activity}）` : ''}`,
        )
        break
      case 'notice':
        // 调度层事件行：公共=家庭事实原样；私有=该角色的感知（「墨璃被发情叫醒」也是家史）
        lines.push(e.private ? `${charName(home, e.char)}注意到：${e.text}` : e.text)
        break
      case 'hear':
        // 缓冲攒存是过程细节，不进蒸馏（避免噪音）
        break
      default:
        break
    }
  }
  return lines
}

export class CatNest {
  constructor(dir, opts = {}) {
    this.dir = dir
    this.now = opts.now || (() => new Date())
    this.chain = Promise.resolve() // 写操作串行化
  }

  // ── 文件原语 ──

  async readJson(path, fallback) {
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch {
      return fallback
    }
  }

  async writeJsonAtomic(path, value) {
    const tmp = `${path}.tmp`
    await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
    await rename(tmp, path)
  }

  // 初始化账本（幂等）。并发调用共享同一个 in-flight promise，
  // 防止两个 ensure 同时在空目录建默认账本、原子写互相撞 tmp。
  ensure() {
    if (!this._ensureInflight) {
      this._ensureInflight = this.doEnsure().catch((e) => {
        this._ensureInflight = null // 失败不缓存，允许重试
        throw e
      })
    }
    return this._ensureInflight
  }

  async doEnsure() {
    await mkdir(join(this.dir, SLICES_DIR), { recursive: true, mode: 0o700 })
    const homePath = join(this.dir, HOME_FILE)
    const home = await this.readJson(homePath, null)
    if (!home || !Array.isArray(home.rooms) || typeof home.characters !== 'object') {
      await this.writeJsonAtomic(homePath, defaultHome())
    } else {
      // v2 → v3 迁移：补 topics / 暂停标记 / 隔墙动静去重，旧房间与角色保持原样
      let changed = false
      if (!home.topics || typeof home.topics !== 'object') {
        home.topics = {}
        changed = true
      }
      if (!home.hearThresholds || typeof home.hearThresholds !== 'object') {
        home.hearThresholds = { ...HEAR_THRESHOLDS }
        changed = true
      }
      for (const ch of Object.values(home.characters)) {
        if (!ch || typeof ch !== 'object') continue
        if (!Array.isArray(ch.hear)) {
          ch.hear = []
          changed = true
        }
        if (ch.activityLeftMs === undefined) {
          ch.activityLeftMs = null
          changed = true
        }
        if (ch.activityPaused === undefined) {
          ch.activityPaused = null
          changed = true
        }
        if (ch.lastAmbientAt === undefined) {
          ch.lastAmbientAt = null
          changed = true
        }
        if (ch.mood === undefined) {
          ch.mood = null
          changed = true
        }
        if (!Array.isArray(ch.conditions)) {
          ch.conditions = []
          changed = true
        }
      }
      if (home.version !== HOME_VERSION) {
        home.version = HOME_VERSION
        changed = true
      }
      if (changed) await this.writeJsonAtomic(homePath, home)
    }
    const relPath = join(this.dir, RELATIONS_FILE)
    const rel = await this.readJson(relPath, null)
    if (!rel || typeof rel.pairs !== 'object') {
      await this.writeJsonAtomic(relPath, defaultRelations())
    }
  }

  homePath() {
    return join(this.dir, HOME_FILE)
  }

  async saveHome(home) {
    await this.writeJsonAtomic(this.homePath(), home)
  }

  async saveRelations(rel) {
    await this.writeJsonAtomic(join(this.dir, RELATIONS_FILE), rel)
  }

  // ── 读 ──

  async home() {
    await this.ensure()
    const home = await this.readJson(this.homePath(), null)
    return home && Array.isArray(home.rooms) ? home : defaultHome()
  }

  async relations() {
    await this.ensure()
    const rel = await this.readJson(join(this.dir, RELATIONS_FILE), null)
    return rel && typeof rel.pairs === 'object' ? rel : defaultRelations()
  }

  async status() {
    const cur = await this.readJson(join(this.dir, CURRENT_FILE), null)
    return cur && typeof cur.sliceId === 'string'
      ? { open: true, sliceId: cur.sliceId, openedAt: cur.openedAt || null }
      : { open: false, sliceId: null, openedAt: null }
  }

  // ── 时间片生命周期 ──

  async open() {
    await this.ensure()
    const st = await this.status()
    if (st.open) throw new Error(`时间片已打开（${st.sliceId}），请先 close`)
    // 秒级 id 可能撞车（同秒开关片）：撞了加唯一后缀
    let sliceId = sliceIdOf(this.now())
    for (let i = 2; await pathExists(join(this.dir, SLICES_DIR, sliceId)); i += 1) {
      sliceId = `${sliceIdOf(this.now())}-${i}`
    }
    const dir = join(this.dir, SLICES_DIR, sliceId)
    await mkdir(dir, { recursive: true })
    const openedAt = this.now().toISOString()
    // 解冻活动：片外流逝不计入（模式外家静止）
    const home = await this.home()
    thawActivities(home, this.now())
    // 话题是片内作用域：开新片清空全部旧话题（对话不跨片，回顾归蒸馏；片内进程重启则留存）
    home.topics = {}
    await this.saveHome(home)
    const snapshot = { home, relations: await this.relations() }
    await this.writeJsonAtomic(join(dir, OPEN_SNAP_FILE), snapshot)
    await this.writeJsonAtomic(join(dir, META_FILE), { sliceId, openedAt, closedAt: null })
    await writeFile(join(dir, LOG_FILE), '', { mode: 0o600 })
    await this.writeJsonAtomic(join(this.dir, CURRENT_FILE), { sliceId, openedAt })
    // 回顾取"最近一个已关闭时间片"：新片 closedAt 为 null，天然排除
    const recap = await this.recap()
    return { sliceId, openedAt, recap }
  }

  async close() {
    const cur = await this.readJson(join(this.dir, CURRENT_FILE), null)
    if (!cur || typeof cur.sliceId !== 'string') throw new Error('没有打开的时间片')
    const dir = join(this.dir, SLICES_DIR, cur.sliceId)
    const closedAt = this.now().toISOString()
    const home = await this.home()
    // 快照先落片内最终状态（活动未冻结）
    await this.writeJsonAtomic(join(dir, CLOSE_SNAP_FILE), {
      home,
      relations: await this.relations(),
    })
    // 暂停中的活动是片内瞬态，不跨片：清掉（不落 activity 行、无 notice）
    for (const ch of Object.values(home.characters || {})) {
      if (ch && ch.activityPaused) {
        ch.activity = null
        ch.activityEndsAt = null
        ch.activityLeftMs = null
        ch.activityPaused = null
        ch.lastAmbientAt = null
      }
    }
    // 再冻结活动写入 home.json：剩余时长换算为毫秒，模式外不流逝
    freezeActivities(home, this.now())
    await this.saveHome(home)
    const meta = (await this.readJson(join(dir, META_FILE), null)) || { sliceId: cur.sliceId, openedAt: cur.openedAt }
    await this.writeJsonAtomic(join(dir, META_FILE), { ...meta, closedAt })
    await rm(join(this.dir, CURRENT_FILE), { force: true })
    return { sliceId: cur.sliceId, openedAt: cur.openedAt || null, closedAt }
  }

  // ── 变更（模式外家静止：一律要求有打开的时间片）──

  async requireOpen() {
    const cur = await this.readJson(join(this.dir, CURRENT_FILE), null)
    if (!cur || typeof cur.sliceId !== 'string') throw new Error('家静止中：没有打开的时间片（先 open）')
    return cur
  }

  mutate(fn) {
    const run = this.chain.then(async () => fn())
    this.chain = run.catch(() => {})
    return run
  }

  async log(type, fields) {
    const cur = await this.requireOpen()
    const line = JSON.stringify({ t: this.now().toISOString(), type, ...fields })
    await appendFile(join(this.dir, SLICES_DIR, cur.sliceId, LOG_FILE), line + '\n', { mode: 0o600 })
  }

  async moveCharacter(id, roomId) {
    return this.mutate(async () => {
      await this.requireOpen()
      const home = await this.home()
      const ch = home.characters[id]
      if (!ch) throw new Error(`角色 "${id}" 不存在`)
      const room = home.rooms.find((r) => r.id === roomId)
      if (!room) throw new Error(`房间 "${roomId}" 不存在`)
      const from = ch.room
      ch.room = roomId
      await this.saveHome(home)
      await this.log('move', { char: id, from, to: roomId })
      return { char: id, from, to: roomId }
    })
  }

  async setActivity(id, activity, durationMin) {
    return this.mutate(async () => {
      await this.requireOpen()
      const home = await this.home()
      const ch = home.characters[id]
      if (!ch) throw new Error(`角色 "${id}" 不存在`)
      if (activity === null || activity === undefined || activity === '') {
        // 停下当前活动；若有暂停中的一并视为放弃（同 do_activity('') 语义）
        ch.activity = null
        ch.activityEndsAt = null
        ch.activityLeftMs = null
        ch.activityPaused = null
        ch.lastAmbientAt = null
        await this.saveHome(home)
        await this.log('activity', { char: id, activity: null })
        return { char: id, activity: null, activityEndsAt: null }
      }
      if (typeof activity !== 'string') throw new Error('activity 需要是字符串（或 null 清除）')
      // 回灶续做：同名 do_activity → 解冻暂停的活动（§9.9；不记账本行，presence 可见）
      if (ch.activityPaused && ch.activity === activity) {
        if (Number.isFinite(ch.activityLeftMs) && ch.activityLeftMs > 0) {
          ch.activityEndsAt = new Date(this.now().getTime() + ch.activityLeftMs).toISOString()
        }
        ch.activityLeftMs = null
        ch.activityPaused = null
        ch.lastAmbientAt = this.now().toISOString()
        await this.saveHome(home)
        return { char: id, activity, activityEndsAt: ch.activityEndsAt, resumed: true }
      }
      // 新活动（若之前有暂停中的视为放弃）
      ch.activityPaused = null
      ch.activityLeftMs = null
      let endsAt = null
      if (durationMin !== undefined && durationMin !== null) {
        const d = Number(durationMin)
        if (!Number.isFinite(d) || d <= 0) throw new Error('durationMin 需要是正数')
        endsAt = new Date(this.now().getTime() + d * 60000).toISOString()
      }
      ch.activity = activity
      ch.activityEndsAt = endsAt
      // 活动隔墙动静（§9.5，切片 2）：开始时相邻房角色 hear 缓冲加一条（主体先于事件）
      const around = this.perceiveAround(home, ch.room, false, id)
      const roomTxt = roomName(home, ch.room) || ch.room
      const text = roomTxt + '传来' + activity + '的动静'
      for (const aid of around.adjacent) {
        if (aid === 'master') continue // 主人不攒缓冲（人是即时感知的）
        const ach = home.characters && home.characters[aid]
        if (!ach) continue
        ach.hear = ach.hear || []
        ach.hear.push({ t: this.now().toISOString(), from: id, text })
        await this.log('hear', { char: aid, from: id, text })
      }
      ch.lastAmbientAt = this.now().toISOString()
      await this.saveHome(home)
      await this.log('activity', { char: id, activity, endsAt })
      return { char: id, activity, activityEndsAt: endsAt }
    })
  }

  // 挂状态（mood）：角色自己标注当下的心情/神态（如「开心」「困了」「若有所思」）。
  // mood 为 null / '' 清除。瞬态字段，随场景动态窗口进 prompt，不冻结不清算。
  async setMood(id, mood) {
    return this.mutate(async () => {
      await this.requireOpen()
      const home = await this.home()
      const ch = home.characters[id]
      if (!ch) throw new Error(`角色 "${id}" 不存在`)
      if (mood === null || mood === undefined || mood === '') {
        const from = ch.mood
        ch.mood = null
        await this.saveHome(home)
        await this.log('mood', { char: id, from, to: null })
        return { char: id, mood: null, from }
      }
      if (typeof mood !== 'string') throw new Error('mood 需要是字符串（或空清除）')
      const m = mood.trim()
      if (!m) {
        const from = ch.mood
        ch.mood = null
        await this.saveHome(home)
        await this.log('mood', { char: id, from, to: null })
        return { char: id, mood: null, from }
      }
      const from = ch.mood
      ch.mood = m
      await this.saveHome(home)
      await this.log('mood', { char: id, from, to: m })
      return { char: id, mood: m, from }
    })
  }

  // 挂持久状态（condition）：{ name, startsInDays?, lastsDays?, cycleDays? }
  //  - name：状态名（发情/生病/受伤…，或自定义），必填
  //  - startsInDays：几天后开始（0=立即，缺省 0；正数=未开始倒计时）
  //  - lastsDays：持续几天（缺省按 CONDITION_TYPES 收录默认 / 通用 1 天）
  //  - lastsDays: 0 → 清除该状态的所有条目
  //  - cycleDays：到期几天后自动开始下一轮（发情周期自动续）
  // 同名单条替换（先移除旧的再插新）。返回 { id, name, startAt, endAt, cycleDays }
  async setCondition(id, opts = {}) {
    return this.mutate(async () => {
      await this.requireOpen()
      const home = await this.home()
      const ch = home.characters[id]
      if (!ch) throw new Error(`角色 "${id}" 不存在`)
      const name = typeof opts.name === 'string' ? opts.name.trim() : ''
      if (!name) throw new Error('条件名不能为空')
      // lastsDays = 0：清除该状态
      if (Number(opts.lastsDays) === 0) {
        const before = ch.conditions.length
        ch.conditions = (ch.conditions || []).filter((c) => c.name !== name)
        await this.saveHome(home)
        await this.log('condition', { char: id, name, action: 'clear', removed: before - ch.conditions.length })
        return { id, name, action: 'clear', removed: before - ch.conditions.length }
      }
      let startsInDays = opts.startsInDays === undefined || opts.startsInDays === null ? 0 : Number(opts.startsInDays)
      if (!Number.isFinite(startsInDays) || startsInDays < 0) throw new Error('startsInDays 需要是不小于 0 的数字')
      startsInDays = Math.round(startsInDays)
      let lastsDays = Number(opts.lastsDays)
      const def = CONDITION_TYPES[conditionKey(name)]
      if (!Number.isFinite(lastsDays) || lastsDays <= 0) lastsDays = def ? def.defaultDays : CONDITION_DEFAULT_DAYS
      let cycleDays = Number(opts.cycleDays)
      if (!Number.isFinite(cycleDays) || cycleDays < 0) cycleDays = def ? def.cycleDays : 0
      const nowT = this.now().getTime()
      const startAt = new Date(nowT + startsInDays * 86400000).toISOString()
      const endAt = new Date(nowT + startsInDays * 86400000 + lastsDays * 86400000).toISOString()
      const cond = {
        id: (id + '-' + name + '-' + startsInDays + '-' + Date.now()).replace(/[^a-zA-Z0-9-]/g, ''),
        name,
        startAt,
        endAt,
      }
      if (cycleDays > 0) cond.cycleDays = cycleDays
      // 立即开始的状态（多为角色自设）创建时即自确认：调度层不叫醒自己刚做的事
      if (startsInDays === 0) cond.notifiedAt = startAt
      ch.conditions = (ch.conditions || []).filter((c) => c.name !== name).concat([cond])
      await this.saveHome(home)
      await this.log('condition', { char: id, name, action: 'set', startAt, endAt, cycleDays: cycleDays || 0 })
      return { id: cond.id, name, startAt, endAt, cycleDays: cycleDays || 0 }
    })
  }

  // 到期推进：过期条件按 cycleDays 自动续下一轮 / 无周期移除（就地改并落盘）。
  // 返回 { changed: [{charId, condition, kind}] }，无变化不写盘。
  async tickConditions() {
    return this.mutate(async () => {
      const home = await this.home()
      const r = advanceConditions(home, this.now())
      if (r.changed.length > 0) {
        await this.saveHome(home)
        for (const e of r.changed) await this.log('condition', { char: e.charId, name: e.condition, action: e.kind })
      }
      return r
    })
  }

  // 只读：某角色当前可见的持久状态（phase + 一行话），供场景/UI 用。
  async conditionsOf(id) {
    const home = await this.home()
    const ch = home.characters && home.characters[id]
    const list = (ch && Array.isArray(ch.conditions) ? ch.conditions : []).map((c) => ({
      id: c.id,
      name: c.name,
      label: conditionLabel(c.name),
      startAt: c.startAt,
      endAt: c.endAt,
      cycleDays: c.cycleDays || 0,
      phase: conditionPhase(c, this.now()),
      text: conditionText(c, this.now()),
    }))
    return { charId: id, conditions: list }
  }

  async moveMaster(roomId) {
    return this.mutate(async () => {
      await this.requireOpen()
      const home = await this.home()
      if (roomId === null || roomId === undefined || roomId === '') {
        const from = home.master
        home.master = { atHome: false, room: null }
        await this.saveHome(home)
        await this.log('master-move', { from: from.room, to: null })
        return { atHome: false, room: null }
      }
      const room = home.rooms.find((r) => r.id === roomId)
      if (!room) throw new Error(`房间 "${roomId}" 不存在`)
      const from = home.master.room
      home.master = { atHome: true, room: roomId }
      await this.saveHome(home)
      await this.log('master-move', { from, to: roomId })
      return { atHome: true, room: roomId }
    })
  }

  async adjustRelation(pair, field, delta) {
    return this.mutate(async () => {
      await this.requireOpen()
      if (!RELATION_PAIRS.includes(pair)) throw new Error(`关系对 "${pair}" 不存在`)
      if (!RELATION_FIELDS.includes(field)) throw new Error(`数值字段 "${field}" 不存在`)
      const d = Number(delta)
      if (!Number.isFinite(d) || d === 0) throw new Error('delta 需要是非零有限数')
      const rel = await this.relations()
      const p = rel.pairs[pair]
      const from = p[field]
      const to = clamp(from + d)
      p[field] = to
      await this.saveRelations(rel)
      await this.log('relation', { pair, field, from, to, delta: d })
      return { pair, field, from, to }
    })
  }

  // ── 家物理：对话流 ──

  locateRoom(home, who) {
    if (who === 'master') {
      const m = home.master
      return m && m.atHome ? m.room : null
    }
    const ch = home.characters && home.characters[who]
    return ch ? ch.room : null
  }

  // 某房间视角：谁能直接听（同房）/ 缓冲听到（相邻）/ 无感（远处）。includeMaster=false 用于主人自己的视角。
  // excludeWho：说话者本人不算听众。
  perceiveAround(home, roomId, includeMaster = true, excludeWho = null) {
    const direct = []
    const adjacent = []
    const far = []
    // 以实际进家的角色为准（名册同步后新角色自动参与物理）
    for (const id of Object.keys(home.characters || {})) {
      const ch = home.characters[id]
      if (!ch || id === excludeWho) continue
      const lvl = roomRelation(home, roomId, ch.room)
      if (lvl === 'same') direct.push(id)
      else if (lvl === 'adjacent') adjacent.push(id)
      else far.push(id)
    }
    if (includeMaster && home.master && home.master.atHome && home.master.room && home.master.room !== excludeWho) {
      const lvl = roomRelation(home, roomId, home.master.room)
      if (lvl === 'same') direct.push('master')
      else if (lvl === 'adjacent') adjacent.push('master')
      else far.push('master')
    }
    return { direct, adjacent, far }
  }

  // 说话：同房角色直接听到（进会话）；相邻角色加入"听到"缓冲（攒存决策链）；远处无感。
  // log 行带 positions（说话时刻全员位置快照）与 audience（听众名单：clear=同房真切，
  // faint=相邻闻声）——片内历史构建的权威判定数据，听觉问题从推理退化成查表
  // （2026-08-26 定案 #5；旧 log 无这两字段，消费侧需容缺省）。
  // action（可选）= 说这句话时伴随的即时小动作（舞台指示，如「蹭了蹭主人」）。
  // 它是视觉信息：同房（含自己）看得见，隔墙闻声的只收台词（听觉）。
  // 与 do_activity（持续状态）/ move_to（位置变化）不同，action 只属于这句话。
  // about（可选）= 话题短语（topic 套件 §9.2）：在某个话题里说的话带上它；轻飘飘一句不带。
  async say(who, text, action, about) {
    return this.mutate(async () => {
      await this.requireOpen()
      if (typeof who !== 'string' || !who) throw new Error('who 需要是角色 id 或 "master"')
      if (typeof text !== 'string' || !text.trim()) throw new Error('text 需要是非空字符串')
      const act = typeof action === 'string' ? action.trim() : ''
      const ab = typeof about === 'string' ? about.trim() : ''
      const home = await this.home()
      return this._sayCore(home, who, text, act || undefined, ab || undefined)
    })
  }

  // 说话核心（必须在 mutate 内调用）：入账 say 行 + 相邻进缓冲 + 落盘。
  // say() 与 resolveHear() 共用；后者不能直接调 this.say()（mutate 内再 mutate 会死锁排队）。
  async _sayCore(home, who, text, action, about) {
    const room = this.locateRoom(home, who)
    if (!room) {
      if (who === 'master') throw new Error('主人不在家（先 moveMaster 进房）')
      throw new Error(`角色 "${who}" 不存在`)
    }
    // 说话时刻全员位置快照（含主人；人不在家不记）
    const positions = {}
    for (const [id, ch] of Object.entries(home.characters || {})) {
      if (ch && ch.room) positions[id] = ch.room
    }
    if (home.master && home.master.atHome && home.master.room) positions.master = home.master.room
    const around = this.perceiveAround(home, room, who !== 'master', who)
    await this.log('say', {
      who,
      room,
      text,
      // 动作随台词入账（视觉信息）；旧 log 无此字段，消费侧容缺省
      ...(action ? { action } : {}),
      // 话题短语（topic 套件）：话题里的发言带 about，口径与渲染一致
      ...(about ? { about } : {}),
      positions,
      audience: { clear: [...around.direct], faint: [...around.adjacent] },
    })
    const buffered = []
    for (const id of around.adjacent) {
      if (id === 'master') continue // 主人不攒缓冲（人是即时感知的），回看走 transcript
      const ch = home.characters && home.characters[id]
      if (!ch) continue
      ch.hear = ch.hear || []
      // 缓冲只攒声音（text）：action 是视觉信息，隔墙看不见，不进缓冲
      ch.hear.push({ t: this.now().toISOString(), from: who, text })
      buffered.push(id)
      await this.log('hear', { char: id, from: who, text })
    }
    await this.saveHome(home)
    const ready = Object.keys(home.characters || {}).filter((id) => hearReadyOf(home, id))
    // direct 同房可对话；adjacent 相邻能听到（角色进缓冲，主人即时感知）；far 远处无感
    return {
      who,
      room,
      direct: around.direct,
      adjacent: around.adjacent,
      buffered,
      far: around.far,
      hearReady: ready,
    }
  }

  // 查看某角色的听到缓冲与决策链状态（只读，无片也可查）
  async hear(charId) {
    const home = await this.home()
    const ch = home.characters && home.characters[charId]
    if (!ch) throw new Error(`角色 "${charId}" 不存在`)
    const threshold = (home.hearThresholds && home.hearThresholds[charId]) || HEAR_THRESHOLDS[charId] || 3
    return { char: charId, buffer: [...(ch.hear || [])], threshold, ready: (ch.hear || []).length >= threshold }
  }

  // 听到缓冲的决策机会：喊话（进对方缓冲）/ 无视（清空重攒）。打断反应由角色调度层 AI 生成，这里只产出事件。
  async resolveHear(charId, decision, text) {
    return this.mutate(async () => {
      await this.requireOpen()
      const home = await this.home()
      const ch = home.characters && home.characters[charId]
      if (!ch) throw new Error(`角色 "${charId}" 不存在`)
      const buf = ch.hear || []
      if (buf.length === 0) throw new Error('听到缓冲为空，没有可决策的内容')
      if (decision !== 'shout' && decision !== 'ignore') throw new Error('decision 需要是 shout 或 ignore')
      if (decision === 'ignore') {
        ch.hear = []
        await this.log('hear-ignore', { char: charId })
        await this.saveHome(home)
        return { char: charId, decision: 'ignore' }
      }
      if (typeof text !== 'string' || !text.trim()) throw new Error('喊话需要 text')
      // shout 类型退役（2026-08-26 定案 #9）：「隔墙搭腔」就是普通说话，声音按距离
      // 自然传播（同房真切/相邻闻声），不再定向进对方缓冲。decision:'shout' 作为
      // 合法值保留（调用方零破坏），内部转普通 say。target 仅作旧返回形状兼容。
      const target = buf[buf.length - 1].from
      ch.hear = []
      const said = await this._sayCore(home, charId, text)
      return { char: charId, decision: 'shout', target, targetReady: hearReadyOf(home, target), said }
    })
  }

  // 调度层事件行（notice）：唤醒入账，进片 log。char=被唤醒角色；source=动静来源
  // （角色 id / 'master' / 'body'）；private=true（默认）只进本人时间线（感知/生理类），
  // false 全员可见（客观家庭事实，仅「做完了事」这类）。要求打开的时间片。
  async notice(char, source, text, isPrivate) {
    return this.mutate(async () => {
      await this.requireOpen()
      const home = await this.home()
      if (!home.characters || !home.characters[char]) throw new Error(`角色 "${char}" 不存在`)
      const t = typeof text === 'string' ? text.trim() : ''
      if (!t) throw new Error('notice text 不能为空')
      const src = typeof source === 'string' && source.trim() ? source.trim() : 'body'
      // 缺省=私有（v1 拍板：私有是默认，公共是例外，必须显式 false）
      const priv = isPrivate === undefined ? true : !!isPrivate
      await this.log('notice', { char, source: src, text: t, private: priv })
      return { char, source: src, text: t, private: priv }
    })
  }

  // 调度层：消费「听到」缓冲（agentTurn 回合开始时弹出）。返回消费到的条目
  // [{t, from, text}] 并清空该角色 hear——一次唤醒=一次决策；回合中新动静攒新鲜
  // 缓冲，防同一批动静反复拍醒。不要求打开的时间片（缓冲只在片内增长，清空无害）。
  async consumeHear(charId) {
    return this.mutate(async () => {
      const home = await this.home()
      const ch = home.characters && home.characters[charId]
      const buf = ch && Array.isArray(ch.hear) ? ch.hear : []
      if (ch) {
        ch.hear = []
        // 「这批动静已通告」标记随缓冲清零：新批动静从 0 重新攒、重新允许通告
        ch.hearNotified = false
        await this.saveHome(home)
      }
      return { char: charId, heard: buf.map((h) => ({ t: h.t, from: h.from, text: h.text })) }
    })
  }

  // 调度层：标记「这批动静已通告」（tryWakeHear 入账 notice 后调，防同一批动静
  // 在缓冲持续满员期间反复写时间线刷屏；consumeHear 随缓冲一起重置）
  async markHearNotified(charId) {
    return this.mutate(async () => {
      const home = await this.home()
      const ch = home.characters && home.characters[charId]
      if (!ch) return { char: charId, ok: false }
      ch.hearNotified = true
      await this.saveHome(home)
      return { char: charId, ok: true }
    })
  }

  // 调度层：活动到期静默清除（不落 activity 行——「做完了事」事实由公共 notice
  // 承载，避免蒸馏里同一件事两句话）。要求打开的时间片。
  async clearActivity(id) {
    return this.mutate(async () => {
      await this.requireOpen()
      const home = await this.home()
      const ch = home.characters[id]
      if (!ch) throw new Error(`角色 "${id}" 不存在`)
      const from = ch.activity || null
      ch.activity = null
      ch.activityEndsAt = null
      ch.activityLeftMs = null
      ch.activityPaused = null
      ch.lastAmbientAt = null
      await this.saveHome(home)
      return { char: id, from }
    })
  }

  // 话题：开启并说开场白（open_topic，§9.2）——一个调用完成「开启+开场」。
  // 入账一条 topic-open 行 + 一条带 about 的 say 行（走正常 say 通道）。
  // to：可选定向对象（角色 id 或名字），缺省=对房间（同房者皆可加入）。
  async openTopic(charId, about, text, to) {
    return this.mutate(async () => {
      await this.requireOpen()
      const a = typeof about === 'string' ? about.trim() : ''
      if (!a) throw new Error('about 话题短语不能为空')
      const t0 = typeof text === 'string' ? text.trim() : ''
      if (!t0) throw new Error('open_topic 需要开场白 text')
      const home = await this.home()
      if (!home.characters || !home.characters[charId]) throw new Error(`角色 "${charId}" 不存在`)
      let toId = null
      if (to !== undefined && to !== null && to !== '') {
        const toRaw = String(to).trim()
        const found = Object.keys(home.characters || {}).find(
          (id) => id === toRaw || (home.characters[id] && home.characters[id].name === toRaw),
        )
        if (!found) throw new Error('to 指向的角色不存在：' + toRaw)
        toId = found
      }
      const r = topicOpenState(home, this.now(), charId, a, toId)
      await this.log('topic-open', { char: charId, about: a, ...(toId ? { to: toId } : {}), room: r.topic.room })
      const said = await this._sayCore(home, charId, t0, undefined, a)
      return { char: charId, about: a, to: toId, opened: r.opened, said }
    })
  }

  // 话题：提议收掉（end_topic）——topic-end 行 +（可选）带 about 的收尾 say。
  // 只允许话题参与方调用；另一参与方在 closing 中再 end → 双收（accepted）。
  async endTopic(charId, about, text) {
    return this.mutate(async () => {
      await this.requireOpen()
      const a = typeof about === 'string' ? about.trim() : ''
      if (!a) throw new Error('about 话题短语不能为空')
      const home = await this.home()
      const r = topicEndState(home, this.now(), charId, a)
      if (!r.key) throw new Error('没有你参与的「' + a + '」话题')
      await this.log('topic-end', { char: charId, about: a, ...(typeof text === 'string' && text.trim() ? { text: text.trim() } : {}) })
      let said = null
      if (typeof text === 'string' && text.trim()) {
        said = await this._sayCore(home, charId, text.trim(), undefined, a)
      } else {
        await this.saveHome(home) // 无收尾句：topicEndState 的改动也要落盘
      }
      return { char: charId, about: a, verdict: r.verdict, said }
    })
  }

  // 「放下锅铲」（pause_activity，§9.9 一等公民）：暂停当前活动——计时冻结
  // （activityEndsAt → activityLeftMs，同 freezeActivities 机制）+ activityPaused 标记。
  // 暂停=不忙；回灶＝同名 do_activity（setActivity 解冻）。入账 activity-pause 行。
  async pauseActivity(id) {
    return this.mutate(async () => {
      await this.requireOpen()
      const home = await this.home()
      const ch = home.characters[id]
      if (!ch) throw new Error(`角色 "${id}" 不存在`)
      if (!ch.activity) throw new Error('没有正在做的活动可以暂停')
      if (ch.activityPaused) throw new Error('活动已经在暂停中')
      const from = ch.activity
      if (typeof ch.activityEndsAt === 'string') {
        const left = new Date(ch.activityEndsAt).getTime() - this.now().getTime()
        ch.activityLeftMs = left > 0 ? left : null
      }
      ch.activityEndsAt = null
      ch.activityPaused = true
      await this.saveHome(home)
      await this.log('activity-pause', { char: id, activity: from })
      return { char: id, activity: from, activityPaused: true }
    })
  }

  // 话题：一次 say 后入账（在 nest.say 之后调用）。join/reopen 各落对应账本行，
  // 裁决接受（ended）无独立行。about 为本句带的话题短语（无则 null）。
  async resolveTopicSay(charId, about) {
    return this.mutate(async () => {
      await this.requireOpen()
      const home = await this.home()
      const r = topicResolveSay(home, this.now(), charId, about)
      if (r.verdict === 'join') await this.log('topic-join', { char: charId, about: r.key ? r.key.split('|')[1] : String(about || '') })
      else if (r.verdict === 'reopen') await this.log('topic-reopen', { char: charId, about: r.key ? r.key.split('|')[1] : String(about || '') })
      await this.saveHome(home)
      return r
    })
  }

  // 话题：一次非说话动作后入账（closing 裁决接受——无账本行，仅状态）。
  async resolveTopicAction(charId) {
    return this.mutate(async () => {
      await this.requireOpen()
      const home = await this.home()
      const r = topicResolveAction(home, this.now(), charId)
      if (r.accepted.length > 0) await this.saveHome(home)
      return r
    })
  }

  // 话题：tick 兜底沉默自动收（10 分钟无人对 X 说话 → endedBy='silence'）
  async expireTopics() {
    return this.mutate(async () => {
      await this.requireOpen()
      const home = await this.home()
      const expired = topicExpire(home, this.now(), TOPIC_SILENCE_TIMEOUT_MS)
      if (expired.length > 0) await this.saveHome(home)
      return { expired }
    })
  }

  // 活动隔墙动静（§9.5，切片 2）：活动持续中每 10min tick 给相邻房角色补一条
  // （lastAmbientAt 去重，同窗不重复）。阈值/边沿触发复用 T1 现有链路。
  async ambientTick() {
    return this.mutate(async () => {
      await this.requireOpen()
      const home = await this.home()
      const nowT = this.now().getTime()
      const dropped = []
      for (const ch of Object.values(home.characters || {})) {
        if (!ch || !ch.activity || ch.activityPaused || !ch.activityEndsAt) continue
        if (!ch.lastAmbientAt) continue // 旧数据无条目：不补
        if (nowT - new Date(ch.lastAmbientAt).getTime() <= AMBIENT_REPEAT_MS) continue
        const around = this.perceiveAround(home, ch.room, false, ch.id)
        const roomTxt = roomName(home, ch.room) || ch.room
        const text = roomTxt + '传来' + ch.activity + '的动静'
        for (const aid of around.adjacent) {
          if (aid === 'master') continue
          const ach = home.characters && home.characters[aid]
          if (!ach) continue
          ach.hear = ach.hear || []
          ach.hear.push({ t: new Date(nowT).toISOString(), from: ch.id, text })
          await this.log('hear', { char: aid, from: ch.id, text })
        }
        ch.lastAmbientAt = new Date(nowT).toISOString()
        dropped.push(ch.id)
      }
      if (dropped.length > 0) await this.saveHome(home)
      return { ambient: dropped }
    })
  }

  // 场景视角：某人所在房间的直接听到 / 相邻 / 远处 + 听到缓冲
  async scene(who) {
    const home = await this.home()
    if (who === 'master') {
      const m = home.master
      if (!m || !m.atHome) {
        const all = Object.keys(home.characters || {})
        return { who: 'master', atHome: false, room: null, direct: [], adjacent: [], far: all }
      }
      return { who: 'master', atHome: true, room: m.room, ...this.perceiveAround(home, m.room, false, 'master') }
    }
    const ch = home.characters && home.characters[who]
    if (!ch) throw new Error(`角色 "${who}" 不存在`)
    const threshold = (home.hearThresholds && home.hearThresholds[who]) || HEAR_THRESHOLDS[who] || 3
    return {
      who,
      room: ch.room,
      ...this.perceiveAround(home, ch.room, true, who),
      hear: { buffer: [...(ch.hear || [])], threshold, ready: (ch.hear || []).length >= threshold },
    }
  }

  // 某房间空闲角色的接话顺序（同房都空闲时按性格分配）
  async responders(roomId) {
    const home = await this.home()
    const room = (home.rooms || []).find((r) => r.id === roomId)
    if (!room) throw new Error(`房间 "${roomId}" 不存在`)
    return { room: roomId, candidates: respondersOrder(home, roomId, this.now()) }
  }

  // 点名打断：允许打断进行中的活动（方案主人拍板），反应由角色调度层 AI 生成
  async interrupt(charId, by) {
    return this.mutate(async () => {
      await this.requireOpen()
      const home = await this.home()
      const ch = home.characters && home.characters[charId]
      if (!ch) throw new Error(`角色 "${charId}" 不存在`)
      const busy = isBusy(ch, this.now())
      await this.log('interrupt', { char: charId, by, activity: busy ? ch.activity : null })
      return { char: charId, by, busy, activity: busy ? ch.activity : null }
    })
  }

  // 回看：某时间片在场的对话记录（主人方案二附带需求：可回看在场时的对话）
  // 未指定片号 → 优先当前打开的时间片（主人边聊边回看）→ 否则最近一个已关闭片
  async transcript(sliceId) {
    let id = sliceId
    if (!id) {
      const cur = await this.readJson(join(this.dir, CURRENT_FILE), null)
      id = cur && typeof cur.sliceId === 'string' ? cur.sliceId : await this.latestClosedSliceId()
    }
    if (!id) return null
    const dir = join(this.dir, SLICES_DIR, id)
    const meta = await this.readJson(join(dir, META_FILE), null)
    let logText = ''
    try {
      logText = await readFile(join(dir, LOG_FILE), 'utf8')
    } catch {
      logText = ''
    }
    const home = await this.home()
    const events = parseLog(logText)
    // text=人话化（含名字前缀）；rawText=say/shout 的事件原文，供前端自定义渲染
    const lines = events.map((e) => ({
      ...e,
      text: dialogueText(home, e),
      rawText: typeof e.text === 'string' ? e.text : '',
    }))
    return { sliceId: id, openedAt: meta && meta.openedAt, closedAt: meta && meta.closedAt, lines }
  }

  // ── 回顾 ──

  async latestClosedSliceId() {
    let entries = []
    try {
      entries = await readdir(join(this.dir, SLICES_DIR), { withFileTypes: true })
    } catch {
      return null
    }
    let latest = null
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const meta = await this.readJson(join(this.dir, SLICES_DIR, e.name, META_FILE), null)
      if (meta && typeof meta.closedAt === 'string') {
        if (!latest || meta.closedAt > latest.meta.closedAt) latest = { id: e.name, meta }
      }
    }
    return latest ? latest.id : null
  }

  // 读一个时间片的完整数据（meta / 开·关快照 / log 原文）——收尾蒸馏与回顾共用
  async sliceData(sliceId) {
    if (!sliceId) return null
    const dir = join(this.dir, SLICES_DIR, sliceId)
    const meta = await this.readJson(join(dir, META_FILE), null)
    const openSnap = await this.readJson(join(dir, OPEN_SNAP_FILE), null)
    const closeSnap = await this.readJson(join(dir, CLOSE_SNAP_FILE), null)
    let logText = ''
    try {
      logText = await readFile(join(dir, LOG_FILE), 'utf8')
    } catch {
      logText = ''
    }
    return { sliceId, meta, openSnap, closeSnap, logText }
  }

  // 指定已关闭时间片的规则化回顾（未指定片号 → 最近一个已关闭片）；没有则 null
  async recapOf(sliceId) {
    const id = sliceId || (await this.latestClosedSliceId())
    if (!id) return null
    const data = await this.sliceData(id)
    if (!data) return null
    return buildRecap(data.sliceId, data.meta, data.openSnap, data.closeSnap, data.logText)
  }

  // 最近一个已关闭时间片的回顾；没有则 null
  async recap() {
    return this.recapOf()
  }

  // ── 角色调度（里程碑三）实例方法 ──

  // 名册同步：companion 名册角色补进家 + 新角色建 master 关系对。
  // 不要求打开时间片（名册是家的成员构成，不是片内变更）。
  // roster: [{id, name}]。返回 { added, relationPairsAdded, characters, pairs }
  async syncRoster(roster) {
    return this.mutate(async () => {
      const home = await this.home()
      const rel = await this.relations()
      const hs = companionSync(home, roster)
      const rs = relationSync(rel, (roster || []).map((c) => c && c.id))
      if (hs.added.length > 0) await this.saveHome(hs.home)
      if (rs.added.length > 0) await this.saveRelations(rs.rel)
      return {
        added: hs.added,
        relationPairsAdded: rs.added,
        characters: Object.keys(hs.home.characters),
        pairs: Object.keys(rs.rel.pairs),
      }
    })
  }

  // 收尾摘要落盘（角色调度层蒸馏产物；open 回顾优先读它）
  async writeSliceSummary(sliceId, text) {
    const value = { text: String(text), at: new Date().toISOString() }
    await this.writeJsonAtomic(join(this.dir, SLICES_DIR, sliceId, 'summary.json'), value)
    return value
  }

  // 最近一个已关闭时间片的收尾摘要；没有则 null
  async latestClosedSummary() {
    const id = await this.latestClosedSliceId()
    if (!id) return null
    return this.readJson(join(this.dir, SLICES_DIR, id, 'summary.json'), null)
  }

  // 指定已关闭时间片的收尾摘要；没有则 null
  async sliceSummary(sliceId) {
    if (!sliceId) return null
    return this.readJson(join(this.dir, SLICES_DIR, sliceId, 'summary.json'), null)
  }
}
