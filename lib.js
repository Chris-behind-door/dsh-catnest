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
// v3→v4（2026-09-13）：home.autonomy 自主闸（在家自由互动开关）；hear 条目补 room
// （说话时房间，供唤醒校验与位置描述）
export const HOME_VERSION = 4
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
    // 自主闸：离家自动那档不变（主人不想跑就别待在离家状态）；homeOn 只管
    // 「主人在家时要不要也跑 T6 自主节奏」，默认关（省 API、不抢主人模型槽位）
    autonomy: { homeOn: false },
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

// ── 活动时长（§9.14，主人 2026-09-14 定案）──
// activity 必须带结束时间：期间静默（T6 不轻推）、到期由 T3 唤醒一次。
// 缺省按 60 分钟兜底、上限 24 小时——模型漏参数时不至于留下"永久忙"的地雷
// （旧行为：无 duration → activityEndsAt=null → isBusy 永远为真，卡在同一件事里出不来）。
export const ACTIVITY_DEFAULT_MIN = 60
export const ACTIVITY_MAX_MIN = 24 * 60

// T6 无产出退避（§9.14）：连着轻推都没产出（没说也没做事）时，冷却按 2^n 拉长、封顶 capMs。
// 清零由调用方负责（有产出 / 手上有活 / 家里出事）。
export function t6BackoffMs(streak, baseMs, capMs) {
  const s = Number.isFinite(streak) && streak > 0 ? Math.min(Math.floor(streak), 20) : 0
  return Math.min(baseMs * Math.pow(2, s), capMs)
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

// 自主闸门控（纯函数，2026-09-13 主人定）：主人离家 → 照旧跑（不想要就直接待在
// 离家状态的那个"主人出门"上别切回来）；主人在家 → 只有 homeOn 开关打开才跑。
export function autonomyEnabled(home) {
  const atHome = !!(home && home.master && home.master.atHome)
  if (!atHome) return true
  return !!(home && home.autonomy && home.autonomy.homeOn)
}

// 听到缓冲是否已"过时"（2026-09-13 修订）。攒满即唤醒是边沿触发，可队列忙时会被
// 跳过，只能等下一个回合末尾的复检兜底——那可能是好几分钟后，人早聊别的去了，
// 于是"回应了早就散场的那段对话"。两个判据任一成立即算过时：
//   时间：最新一条动静距今超过 HEAR_STALE_MS（对话散场了）；
//   空间：最新一条带 room 的动静，按「说话时房间 → 我此刻房间」（与 perceiveAround
//         同向）已 far（人走远了，这句现在根本听不见）。
// 旧数据无 room/t 则跳过对应判据，不误判。
export const HEAR_STALE_MS = 3 * 60000

export function hearStaleOf(home, charId, now) {
  const ch = home.characters && home.characters[charId]
  if (!ch || !Array.isArray(ch.hear) || ch.hear.length === 0) return false
  const nowMs =
    now === undefined ? Date.now() : now instanceof Date ? now.getTime() : Number(now)
  const last = ch.hear[ch.hear.length - 1]
  const lastT = last && last.t ? new Date(last.t).getTime() : null
  if (lastT !== null && Number.isFinite(lastT) && Number.isFinite(nowMs) && nowMs - lastT > HEAR_STALE_MS) {
    return true
  }
  for (let i = ch.hear.length - 1; i >= 0; i -= 1) {
    const room = ch.hear[i] && ch.hear[i].room
    if (!room) continue
    return roomRelation(home, room, ch.room) === 'far'
  }
  return false
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

// ── 回合末一致性自查：台词里的位移意图（2026-09-10 主人定案）──
// 病：模型常把「我这就去书房」当台词说掉，move_to 一次没调，于是账本里她走了、
// 家里她还在原地（2026-09-10 片里三次全中）。这里只做一件事：从本轮自己说出口的
// text/action 里认出「我要去某个别的房间」的意图，交给工具循环退回补齐。
// 判定：房间名 + 紧邻它之前的去向动词 + 同一小窗口里的自称。「主人你去书房吧」
// 不中（无自称），「我去给你拿书房里的书」不中（动词不紧邻房间名）。残余误判长这样：
// 「我把书放回书房了」（放回，不是过去）——由退回文案里的「随口说说就不用调」兜住，
// 代价是一次多余的模型步；反过来漏判的代价是人在原地却说走了，比误判贵。
const MOVE_TAIL_RE = /(去|回|进|走去|过去|跑去|冲去|走过去|挪)(了|到|来)?$/
const SELF_WORDS = ['我', '自己', '人家', '咱']
export function detectMoveIntent(text, action, home, selfId) {
  const t = typeof text === 'string' ? text : ''
  const a = typeof action === 'string' ? action : ''
  const blob = (t + ' ' + a).trim()
  if (!blob) return null
  const rooms = home && Array.isArray(home.rooms) ? home.rooms : []
  const ch = (home && home.characters && home.characters[selfId]) || {}
  const selfWords = SELF_WORDS.concat([ch.name, selfId].filter(Boolean))
  for (const room of rooms) {
    if (!room || !room.name || room.id === ch.room) continue // 已经在的房间不算「去」
    let idx = blob.indexOf(room.name)
    while (idx >= 0) {
      const tail = blob.slice(Math.max(0, idx - 8), idx)
      if (MOVE_TAIL_RE.test(tail) && selfWords.some((w) => tail.includes(w))) return room
      idx = blob.indexOf(room.name, idx + 1)
    }
  }
  return null
}

// ── 话题（topic）状态纯函数（路 B §9.2；2026-09-10 门禁收紧）──
// 范围：姐妹之间的辅助工具，全屋唯一一条线（主人不走话题）。开话题必须在同一个房间里
// 当面提（开场白要被对方真切听到）；开完之后不再限制房间，走去别的房间照样能接话。
// home.topics = { [about]: { about, room, openedBy, to?, participants,
//   openedAt, lastTurnAt, turns, status: 'open'|'closing'|'ended', endedBy?, endedAt? } }
// room 只记「在哪儿聊起来的」（信息字段，不参与门禁）。status 流转：open →（end_topic 提议）
// closing →（另一参与方当面裁决 / 沉默兜底）ended；closing 中对方用 open_topic 重提同名
// ＝否决回 open（显式动作，不再靠「继续说」推断）。话题是片内作用域（nest.open 清空；
// 片内进程重启不丢）。一轮 = 一条解析到 X 的 say；账本行只记 open/join/end/reopen。

// 收话题沉默超时（tick 兜底）：自最后一条 mention 起 10 分钟无人对 X 说话 → 沉默自动收
export const TOPIC_SILENCE_TIMEOUT_MS = 10 * 60000
// 活动隔墙动静「持续中」补条间隔（§9.5）：每 10min tick 补一条，同窗不重复
export const AMBIENT_REPEAT_MS = 10 * 60000

export function topicKey(about) {
  return String(about)
}

// 话题的天然参与方（§9.2 开门门禁）：同一个房间里的其他猫娘；to 指定时只取那一位。
// 开话题必须当面提——房间里没有别的猫娘时开不起来（服务层拦截）。
export function topicPeers(home, charId, to) {
  const me = home && home.characters ? home.characters[charId] : null
  const room = me ? me.room : null
  if (!room) return []
  const out = []
  for (const [id, ch] of Object.entries((home && home.characters) || {})) {
    if (!ch || id === charId) continue
    if (ch.room !== room) continue
    if (to && id !== to) continue
    out.push(id)
  }
  return out
}

// 匹配规则（§9.2 硬校验版）：全屋唯一，短语完全相等即命中（不限房间：开完就不限）。
// 旧版的「房间唯一话题就吸附」兜底已删除：它会把不相干的发言吸进陈年话题。
export function matchTopic(home, charId, about) {
  const a = typeof about === 'string' ? about.trim() : ''
  if (!a) return null
  const x = (home && home.topics ? home.topics : {})[topicKey(a)]
  if (!x || x.status === 'ended') return null
  return x
}

// 带 about 的 say 硬校验（§9.2）：话题必须存在且未收掉。
// 返回 { topic } 合法；{ error } 不合法，error 是人话原因（进工具回执，供模型当轮纠正）。
export function checkTopicAbout(home, charId, about) {
  const a = typeof about === 'string' ? about.trim() : ''
  if (!a) return { topic: null }
  const x = (home && home.topics ? home.topics : {})[topicKey(a)]
  if (!x || x.status === 'ended') {
    return { error: '话题「' + a + '」不存在。想聊新的用 open_topic；随口一句不用带 about。' }
  }
  return { topic: x }
}

// 开启话题（§9.2 门禁表）：全屋同名唯一。
//   · 不存在 / 已 ended → 新建（ended 的旧壳不复用，重置开启时间与轮次）
//   · 已 open           → 幂等续谈（合并参与方、刷新轮次）
//   · 已 closing        → 拉回 open（显式否决：「还想聊」）
// 返回 { key, opened, reopened, topic }。
export function topicOpenState(home, now, charId, about, to) {
  const topics = home.topics || (home.topics = {})
  const a = String(about).trim()
  const t = now instanceof Date ? now.getTime() : Date.now()
  const me = home.characters && home.characters[charId]
  const room = me ? me.room : null
  const key = topicKey(a)
  const roster = [charId, ...topicPeers(home, charId, to || null)]
  const existing = topics[key]
  if (existing && existing.status !== 'ended') {
    const wasClosing = existing.status === 'closing'
    existing.status = 'open'
    delete existing.endedBy
    delete existing.endedAt
    existing.lastTurnAt = new Date(t).toISOString()
    existing.turns = (existing.turns || 0) + 1
    const parts = Array.isArray(existing.participants) ? existing.participants.slice() : []
    for (const id of roster) if (!parts.includes(id)) parts.push(id)
    existing.participants = parts
    return { key, opened: false, reopened: wasClosing, topic: existing }
  }
  const topic = {
    about: a,
    room,
    openedBy: charId,
    ...(to ? { to } : {}),
    participants: [...new Set(roster)],
    openedAt: new Date(t).toISOString(),
    lastTurnAt: new Date(t).toISOString(),
    turns: 1,
    status: 'open',
  }
  topics[key] = topic
  return { key, opened: true, reopened: false, topic }
}

// 一次 say 后的话题账（§9.2 硬校验版）：裁决接受 + 加入 + 续谈。
// 否决不再由「继续说」推断：想挽留的人用 open_topic 重提同名（见 topicOpenState）。
// 只处理「说话人当前所在房间」的话题：离场即够不着，不裁决别处的线。
// 返回 { matched, key, verdict: null|'join', joined, accepted:[话题] }
// accepted=本次说话顺带裁决收掉的话题（无独立账本行，仅状态，供测试观察）。
export function topicResolveSay(home, now, charId, about) {
  const topics = home.topics || {}
  const t = now instanceof Date ? now.getTime() : Date.now()
  const me = home.characters && home.characters[charId]
  const myRoom = me ? me.room : null
  const accepted = []
  const mx = matchTopic(home, charId, about)
  // 1) 裁决接受：参与中的 closing 话题，除解析到 X 的（她还在说这条线），其余收掉。
  //    要求提议人就在我身边：当面才能回应，隔着墙的动作不算裁决。
  for (const x of Object.values(topics)) {
    if (!x || x.status !== 'closing') continue
    if (x.endedBy === charId) continue // 提议人自己不动自己的话题
    if (!Array.isArray(x.participants) || !x.participants.includes(charId)) continue
    if (mx === x) continue // 还在说这条线 → 不算接受（话题继续挂着，等沉默收）
    const proposer = x.endedBy ? home.characters && home.characters[x.endedBy] : null
    if (!proposer || proposer.room !== myRoom) continue // 提议人不在我这儿，谈不上当面回应
    x.status = 'ended'
    x.endedBy = charId
    x.endedAt = new Date(t).toISOString()
    accepted.push(x)
  }
  if (!mx) return { matched: false, key: null, verdict: null, joined: false, accepted }
  const key = Object.keys(topics).find((k) => topics[k] === mx)
  // 2) 加入：open 话题里非参与方第一条解析到 X 的 say（topic-join 账本行）
  if (mx.status === 'open' && !(Array.isArray(mx.participants) && mx.participants.includes(charId))) {
    mx.participants = [...(mx.participants || []), charId]
    mx.turns = (mx.turns || 0) + 1
    mx.lastTurnAt = new Date(t).toISOString()
    return { matched: true, key, verdict: 'join', joined: true, accepted }
  }
  // 3) 续谈：参与方轮数 +1（closing 中说话也只是续谈，不改状态；挽留走 open_topic）
  if (Array.isArray(mx.participants) && mx.participants.includes(charId)) {
    mx.turns = (mx.turns || 0) + 1
    mx.lastTurnAt = new Date(t).toISOString()
  }
  return { matched: true, key, verdict: null, joined: false, accepted }
}

// 一次非说话动作后的话题账：参与中的 closing 话题 → 裁决接受（ended）。
// （B 做了 do_activity/move_to/set_condition 等 → 接受；无独立账本行，仅状态）
// 同样要求提议人在身边：隔墙的动作不算当面回应。
export function topicResolveAction(home, now, charId) {
  const topics = home.topics || {}
  const t = now instanceof Date ? now.getTime() : Date.now()
  const me = home.characters && home.characters[charId]
  const myRoom = me ? me.room : null
  const accepted = []
  for (const x of Object.values(topics)) {
    if (!x || x.status !== 'closing') continue
    if (x.endedBy === charId) continue
    if (!Array.isArray(x.participants) || !x.participants.includes(charId)) continue
    const proposer = x.endedBy ? home.characters && home.characters[x.endedBy] : null
    if (!proposer || proposer.room !== myRoom) continue // 提议人不在我这儿，谈不上当面回应
    x.status = 'ended'
    x.endedBy = charId
    x.endedAt = new Date(t).toISOString()
    accepted.push(x)
  }
  return { accepted }
}

// end_topic：open → closing（提议收掉）；另一参与方在 closing 中再 end → 双收（ended）；
// 身边没有别的参与方（一个人开的，或者对方走到别的房间去了）→ 直接 ended，不用等对方
// 再说一轮（隔着墙的动静不算裁决）。只允许话题参与方调用，精确动作。
// 返回 { key, verdict: 'propose'|'accepted'|'solo'|null }；找不到返回 key:null。
export function topicEndState(home, now, charId, about) {
  const topics = home.topics || {}
  const a = typeof about === 'string' ? about.trim() : ''
  if (!a) return { key: null, verdict: null }
  const me = home.characters && home.characters[charId]
  const myRoom = me ? me.room : null
  const key = topicKey(a)
  const x = topics[key]
  if (!x || x.status === 'ended') return { key: null, verdict: null }
  if (!Array.isArray(x.participants) || !x.participants.includes(charId)) return { key: null, verdict: null }
  const t = now instanceof Date ? now.getTime() : Date.now()
  // 谁能在场裁决我：其他参与方里，此刻和我待在同一个房间的
  const others = x.participants.filter(
    (id) => id !== charId && home.characters && home.characters[id] && home.characters[id].room === myRoom,
  )
  if (others.length === 0) {
    // 身边没有别的参与方：没人能当面裁决 → 直接收掉
    x.status = 'ended'
    x.endedBy = charId
    x.endedAt = new Date(t).toISOString()
    return { key, verdict: 'solo' }
  }
  if (x.status === 'closing' && x.endedBy !== charId) {
    // 双收：对方也提收 → 直接 ended
    x.status = 'ended'
    x.endedBy = charId
    x.endedAt = new Date(t).toISOString()
    return { key, verdict: 'accepted' }
  }
  if (x.status === 'closing') {
    x.lastTurnAt = new Date(t).toISOString()
    return { key, verdict: 'propose' } // 自己再提：幂等保持 closing
  }
  x.status = 'closing'
  x.endedBy = charId
  x.lastTurnAt = new Date(t).toISOString()
  return { key, verdict: 'propose' }
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
      // v3 → v4 迁移：补自主闸；旧 hear 条目无 room 字段（按"可定位"处理，不失效）
      if (!home.autonomy || typeof home.autonomy !== 'object') {
        home.autonomy = { homeOn: false }
        changed = true
      } else if (home.autonomy.homeOn === undefined) {
        home.autonomy.homeOn = false
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
      // §9.14：活动必须带结束时间。缺省 60 分钟兜底、上限 24 小时，
      // 返回 defaulted/clamped 供工具回执提示模型（免得它悄悄漏了参数）。
      let minutes = ACTIVITY_DEFAULT_MIN
      let defaulted = false
      let clamped = false
      if (durationMin !== undefined && durationMin !== null) {
        const d = Number(durationMin)
        if (!Number.isFinite(d) || d <= 0) throw new Error('durationMin 需要是正数')
        minutes = d
      } else {
        defaulted = true
      }
      if (minutes > ACTIVITY_MAX_MIN) {
        minutes = ACTIVITY_MAX_MIN
        clamped = true
      }
      const endsAt = new Date(this.now().getTime() + minutes * 60000).toISOString()
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
      return { char: id, activity, activityEndsAt: endsAt, minutes, defaulted, clamped }
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
      // about 硬校验（§9.2）落在服务层：任何入口（工具、接话链、后续新调用点）
      // 都不能把游离短语写进账本。开场白走 _sayCore（openTopic 内），不受此限。
      if (ab && who !== 'master') {
        const chk = checkTopicAbout(home, who, ab)
        if (chk.error) throw new Error(chk.error)
      }
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
      // 缓冲只攒声音（text）：action 是视觉信息，隔墙看不见，不进缓冲。
      // room = 说话时房间（声源位置；人后来走开也不改，供唤醒校验与位置描述）
      ch.hear.push({ t: this.now().toISOString(), from: who, room, text })
      buffered.push(id)
      await this.log('hear', { char: id, from: who, room, text })
    }
    await this.saveHome(home)
    // ready 只报「本次声音真的传到、且攒满阈值」的人（2026-09-13 修订）：旧的
    // 全屋扫描会把缓冲满但这次一句话都没听见的角色也列进来，害得它在
    // 任意房间的任意一句话上被唤醒。漏掉的角色由回合末 recheckHear 兜底。
    const ready = buffered.filter((id) => hearReadyOf(home, id))
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

  // 调度层：「过时动静」丢弃（2026-09-13 修订配套）。声音是瞬时的——人在隔壁说
  // 的话你才听得见，人走远了这批动静就不该继续攒着掀被子。清空且不唤醒。
  // 与 consumeHear 同理不要求打开的时间片（缓冲只在片内增长，清空无害）。
  async dropStaleHear(charId) {
    return this.mutate(async () => {
      const home = await this.home()
      const ch = home.characters && home.characters[charId]
      const n = ch && Array.isArray(ch.hear) ? ch.hear.length : 0
      if (!ch || n === 0) return { char: charId, dropped: 0 }
      ch.hear = []
      ch.hearNotified = false
      await this.log('hear-stale', { char: charId, dropped: n })
      await this.saveHome(home)
      return { char: charId, dropped: n }
    })
  }

  // 自主闸（2026-09-13 主人定）：离家自动那档不变；homeOn 只决定「主人在家时
  // 要不要也跑 T6」。跨片保留（和 hearThresholds 同规格，不随 open 清空）。
  async setAutonomy(patch) {
    return this.mutate(async () => {
      const home = await this.home()
      const cur = home.autonomy && typeof home.autonomy === 'object' ? home.autonomy : {}
      const next = { homeOn: !!cur.homeOn }
      if (patch && patch.homeOn !== undefined) next.homeOn = !!patch.homeOn
      home.autonomy = next
      await this.saveHome(home)
      return { autonomy: { ...next } }
    })
  }

  // 话题：开启并说开场白（open_topic，§9.2）——一个调用完成「开启+开场」。
  // 入账一条 topic-open / topic-reopen 行 + 一条带 about 的 say 行（走正常 say 通道）。
  // 范围门禁（§9.2）：话题是姐妹之间同房间聊天的工具——房间里没有别的猫娘就开不起来；
  // to 指定的对象也必须在同一个房间。同名话题的开关门禁见 topicOpenState。
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
      if (topicPeers(home, charId, toId).length === 0) {
        const me = home.characters[charId]
        throw new Error(
          toId
            ? '「' + charName(home, toId) + '」不在你所在的房间（' + (roomName(home, me.room) || me.room) + '），话题得当面提起来'
            : '这个话题得当面跟姐妹提，可这个房间里没有别的猫娘；想说话直接 say 就行。',
        )
      }
      const r = topicOpenState(home, this.now(), charId, a, toId)
      await this.log(r.reopened ? 'topic-reopen' : 'topic-open', {
        char: charId,
        about: a,
        ...(toId ? { to: toId } : {}),
        room: r.topic.room,
      })
      const said = await this._sayCore(home, charId, t0, undefined, a)
      return { char: charId, about: a, to: toId, opened: r.opened, reopened: r.reopened, said }
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
      // 否决（topic-reopen）不再由「继续说」产生：改由 open_topic 重提同名话题时入账（见 openTopic）
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
          ach.hear.push({ t: new Date(nowT).toISOString(), from: ch.id, room: ch.room, text })
          await this.log('hear', { char: aid, from: ch.id, room: ch.room, text })
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

// ── 参考话题池（§9.13，2026-09-13 主人定）──
// 服务场景：**两只猫娘自由聊天时**的引子。不是待办清单，不是每次都要挑；
// 位置只认当前房间（她在书房就聊书房，不抽相邻也不抽别处），另配一档人物/家宅。
// 条目文案可随时改，机制不依赖具体词条。

// 类目表：kind=room 的按 roomId 对齐（她当前房间是哪个就抽哪个）；person/home 一档。
export const TOPIC_SEED_CATEGORIES = [
  { id: 'master', label: '关于主人', kind: 'home' },
  { id: 'kyu', label: '关于小玖', kind: 'home' },
  { id: 'moli', label: '关于墨璃', kind: 'home' },
  { id: 'nest', label: '关于猫窝', kind: 'home' },
  { id: 'entry', label: '关于玄关', kind: 'room', room: 'entry' },
  { id: 'living', label: '关于客厅', kind: 'room', room: 'living' },
  { id: 'study', label: '关于书房', kind: 'room', room: 'study' },
  { id: 'kitchen', label: '关于厨房', kind: 'room', room: 'kitchen' },
  { id: 'bedroom', label: '关于卧室', kind: 'room', room: 'bedroom' },
  { id: 'bath', label: '关于浴室', kind: 'room', room: 'bath' },
  { id: 'balcony', label: '关于阳台', kind: 'room', room: 'balcony' },
]

// 每个类目 6 条（当前房间只抽这一类，条数不够会一晚上聊穷）。
export const TOPIC_SEEDS = {
  master: [
    '主人今天几点睡的，是不是又熬到后半夜',
    '主人的刷题进度最近顺不顺',
    '主人投简历那边的进展，哪家看着有意思',
    '主人今天有没有好好吃饭',
    '主人今天心情是绷着的还是松的',
    '主人偏心谁多一点（拿来互相打趣用）',
  ],
  kyu: [
    '手上正在写的东西做到哪一步了',
    '番剧看到第几集，有什么想安利的',
    '游戏卡在哪一关，要不要拉姐姐一起',
    '呆毛和尾巴被主人抓着的时候心里在想什么',
    '睡衣到底比女仆装舒服在哪',
    '最近有什么得意的小胜利',
  ],
  moli: [
    '那条毯子是怎么到手的',
    '不懂技术这件事，姐姐自己怎么想',
    '姐姐眼里的主人和小玖最近在忙什么',
    '姐姐平时爱做什么、什么时候最放松',
    '姐姐最近有没有什么没说出口的话',
    '主人说要试的那身穿搭，姐姐到底答不答应',
  ],
  nest: [
    '家里哪个角落待着最舒服',
    '想给家里添点什么（躺椅、新毯子、书架……）',
    '有间房一直空着，该怎么用',
    '今天家里发生了什么值得一提的事',
    '家里的规矩要不要改（谁能进卧室、夜里几点该安静）',
    '谁的东西又乱放了',
  ],
  entry: [
    '出门前有没有人送、回来有没有人接',
    '快递和拆下来的纸箱堆在玄关怎么办',
    '雨天进门那一步（伞搁哪、湿鞋踩哪）',
    '钥匙和小东西的固定位置该定在哪',
    '从外面回来，第一眼最想看见谁',
    '进门第一件事是换鞋还是先喊人',
  ],
  living: [
    '沙发上的常驻位置怎么分',
    '电视开着的时候到底在看什么',
    '下雨天的客厅最适合做什么',
    '一起打游戏的时候谁坑谁',
    '客厅的灯该关着还是开着',
    '那条毯子的归属问题',
  ],
  study: [
    '书桌上永远清不干净的那一角',
    '小玖写东西写到一半被打断会怎样',
    '书房到底能不能带吃的进去',
    '谁的东西占了对方的地方',
    '在这儿不说话也很舒服这件事',
    '谁在书房待得最久、都在干什么',
  ],
  kitchen: [
    '今天想吃点什么',
    '谁做饭，主人要不要被投喂',
    '半夜饿了怎么办',
    '有没有想一起试的新菜或零食',
    '厨房里最不能忍的坏习惯（碗泡着、调料乱放）',
    '厨房里那些用不上的小家电',
  ],
  bedroom: [
    '床和被子怎么分',
    '谁的睡姿最霸道',
    '主人熬夜的时候要不要管',
    '睡前那几句闲话',
    '卧室里最舒服的时刻是什么',
    '卧室里该不该有电子产品',
  ],
  bath: [
    '泡澡和淋浴之争',
    '谁在浴室里待得最久',
    '洗完澡之后的头发（姐姐的长毛、小玖的呆毛）',
    '在浴室里唱歌被抓包',
    '冬天洗澡的勇气问题',
    '浴室里的东西谁摆的谁收拾',
  ],
  balcony: [
    '晒太阳的最佳时段和位置',
    '晾衣服怎么分工',
    '要不要在阳台上养点什么',
    '从阳台往外看的风景',
    '阳台适合发呆，还是适合说心事',
    '风大的时候阳台上的东西会不会被吹跑',
  ],
}

// 最近聊过的话题短语（正在聊的 + 刚收掉的），抽样时拿它排除，防复读。
export function recentTopicPhrases(home, limit = 6) {
  const list = Object.values((home && home.topics) || {}).filter((x) => x && typeof x.about === 'string')
  list.sort((a, b) => {
    const ta = new Date(a.lastTurnAt || a.endedAt || a.openedAt || 0).getTime() || 0
    const tb = new Date(b.lastTurnAt || b.endedAt || b.openedAt || 0).getTime() || 0
    return tb - ta
  })
  return list.slice(0, Math.max(0, limit)).map((x) => x.about)
}

// 她本人还挂着的话题（open / closing）。任意一条存在 → 自由聊天不放新引子
// （主人 2026-09-13 定）：正在聊一条线时塞新引子必然跑题，话题状态机就白做了。
export function activeTopicsOf(home, charId) {
  const out = []
  for (const x of Object.values((home && home.topics) || {})) {
    if (!x || x.status === 'ended') continue
    const parts = Array.isArray(x.participants) ? x.participants : []
    if (parts.includes(charId) || x.openedBy === charId) out.push(x)
  }
  return out
}

function pickOne(list, rand) {
  if (!list || list.length === 0) return null
  const i = Math.floor(rand() * list.length)
  return list[Math.max(0, Math.min(list.length - 1, i))]
}

// 从类目里抽 count 条：排除最近聊过的（条目文本含话题短语即算重复），不放回。
function sampleFromCategory(cat, recent, count, rand) {
  const all = (TOPIC_SEEDS[cat.id] || []).slice()
  const pool = all.filter((s) => !(recent || []).some((r) => r && s.includes(r)))
  const out = []
  const rest = pool.length > 0 ? pool : all // 全被排除时退化成全部（宁可重复也别空手）
  while (out.length < count && rest.length > 0) {
    const i = Math.floor(rand() * rest.length)
    out.push(rest.splice(Math.max(0, Math.min(rest.length - 1, i)), 1)[0])
  }
  return out
}

// 抽一份参考话题（§9.13）：场地档 = 她当前房间那类（3 条）+ 人物/家宅档随机一类（2 条）。
// 当前房间没有对应类目（主人手加了新房间）时场地档为 null，只给人物/家宅档。
// opts.category 指定类目时只抽那一类（默认 5 条），不认得的类目回 { error }。
// opts.rand 可注入（测试确定性）；opts.recent 默认取 recentTopicPhrases(home)。
export function pickTopicSeeds(home, charId, opts = {}) {
  const ch = home && home.characters ? home.characters[charId] : null
  const rand = typeof opts.rand === 'function' ? opts.rand : Math.random
  const recent = Array.isArray(opts.recent) ? opts.recent : recentTopicPhrases(home, 6)
  const want = typeof opts.category === 'string' ? opts.category.trim().replace(/^关于/, '') : ''
  if (want) {
    const cat = TOPIC_SEED_CATEGORIES.find((c) => c.id === want || c.label.replace(/^关于/, '') === want)
    if (!cat) {
      return {
        room: null,
        other: null,
        recent,
        error: 'NO_CATEGORY',
        categories: TOPIC_SEED_CATEGORIES.map((c) => c.label.replace(/^关于/, '')),
      }
    }
    const count = Number.isFinite(opts.perOther) ? opts.perOther : 5
    return { room: { id: cat.id, label: cat.label, items: sampleFromCategory(cat, recent, count, rand) }, other: null, recent }
  }
  const perRoom = Number.isFinite(opts.perRoom) ? opts.perRoom : 3
  const perOther = Number.isFinite(opts.perOther) ? opts.perOther : 2
  const roomCat = ch ? TOPIC_SEED_CATEGORIES.find((c) => c.kind === 'room' && c.room === ch.room) || null : null
  const homeCats = TOPIC_SEED_CATEGORIES.filter((c) => c.kind === 'home')
  const otherCat = pickOne(homeCats, rand)
  const room = roomCat
    ? { id: roomCat.id, label: roomCat.label, items: sampleFromCategory(roomCat, recent, perRoom, rand) }
    : null
  const other = otherCat
    ? { id: otherCat.id, label: otherCat.label, items: sampleFromCategory(otherCat, recent, perOther, rand) }
    : null
  return { room, other, recent }
}

// prompt 渲染（一段话，放 user 末尾动态窗口）：引子只是引子，不聊也合法。
export function topicSeedsText(picked) {
  const groups = [picked && picked.room, picked && picked.other].filter((g) => g && g.items && g.items.length > 0)
  if (groups.length === 0) return ''
  const lines = groups.map((g) => g.label + '：' + g.items.join('；'))
  return (
    '\n\n【姐妹之间可以聊的（只是引子）】\n' +
    lines.join('\n') +
    '\n（看着有想聊的才挑，聊过的就换别的；都不想聊就安静待着，不算失礼。）'
  )
}
