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

import { mkdir, readdir, readFile, rename, rm, stat, writeFile, appendFile, copyFile } from 'node:fs/promises'
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

// 房间建议稿（草案第四节）；home.json 落盘后以文件为准，主人增删直接改文件。
// items（HOUSE_DESIGN §1 家当）：房间里的东西，`{ name, state? }`——房间内名字即标识（不带 id，
// 主人手改 json 省事），state 是自由短语（「空的」「关着」），不带就没有状态。
// 只读：不做拿放/使用（物品互动系统不在本期），状态由主人改文件维护。
export const DEFAULT_ROOMS = [
  { id: 'entry', name: '玄关', functions: ['迎接', '送别'], adjacent: ['living'],
    items: [{ name: '鞋柜' }, { name: '衣帽架' }, { name: '换鞋凳' }] },
  { id: 'living', name: '客厅', functions: ['读书', '聊天', '游戏', '看电视'], adjacent: ['entry', 'kitchen', 'balcony', 'study', 'bedroom'],
    items: [{ name: '沙发' }, { name: '茶几' }, { name: '电视', state: '关着' }, { name: '落地灯' }, { name: '地毯' }] },
  { id: 'study', name: '书房', functions: ['安静看书', '发呆'], adjacent: ['living'],
    items: [{ name: '书桌' }, { name: '书架' }, { name: '台灯' }, { name: '电脑' }] },
  { id: 'kitchen', name: '厨房', functions: ['做饭', '吃东西', '投喂'], adjacent: ['living'],
    items: [{ name: '灶台' }, { name: '冰箱' }, { name: '水壶', state: '空的' }, { name: '碗柜' }] },
  { id: 'bedroom', name: '卧室', functions: ['睡觉', '贴贴', '亲密'], adjacent: ['living'],
    items: [{ name: '床' }, { name: '衣柜' }, { name: '梳妆台' }, { name: '窗帘', state: '拉着' }] },
  { id: 'bath', name: '浴室', functions: ['洗漱', '泡澡'], adjacent: ['bedroom'],
    items: [{ name: '淋浴' }, { name: '浴缸' }, { name: '洗手台' }, { name: '毛巾架' }] },
  { id: 'balcony', name: '阳台', functions: ['晒太阳', '看风景', '晾衣服'], adjacent: ['living'],
    items: [{ name: '晾衣架' }, { name: '洗衣机' }, { name: '绿植' }, { name: '躺椅' }] },
]

// 家当编辑上限（HOUSE_DESIGN §2）：一个房间最多几件、名字/状态多长、数量多大。
// 校验从严：主人手滑当场报错，脏数据别写进账本（账本坏了代价比报错大得多）。
export const ITEMS_MAX = 50
export const ITEM_NAME_MAX = 24
export const ITEM_STATE_MAX = 24
export const ITEM_COUNT_MAX = 99999

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
// v4→v5（2026-09-16 HOUSE_DESIGN §1）：rooms[].items 家当（房间里的东西 + 可选状态）。迁移按
// 房间 id 补默认稿（主人改 home.json 即可增删），不在默认表里的房间给空数组。
export const HOME_VERSION = 6
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
// estrus 不再自带 cycleDays（§9.18）：周期统一归 home.cycles 表记账（按猫配、带抖动），
// condition 只是「当前这一轮」的投影。两套续轮逻辑并存会互相打架。
export const CONDITION_TYPES = {
  estrus: { label: '发情期', defaultDays: 3 },
  sick: { label: '生病', defaultDays: 2 },
  injured: { label: '受伤', defaultDays: 2 },
  tired: { label: '疲劳', defaultDays: 1 },
  // 每日随机身体状态的收录（§9.18）：给了标签，场景里才不会显示成「精神特别好中」
  spirited: { label: '精神好', defaultDays: 1 },
  appetite: { label: '胃口好', defaultDays: 1 },
  shedding: { label: '换毛期', defaultDays: 2 },
  insomnia: { label: '失眠', defaultDays: 1 },
  stiffneck: { label: '落枕', defaultDays: 1 },
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
  精神特别好: 'spirited',
  精神好: 'spirited',
  胃口特别好: 'appetite',
  胃口好: 'appetite',
  换毛期: 'shedding',
  换毛: 'shedding',
  失眠: 'insomnia',
  落枕: 'stiffneck',
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
    rooms: DEFAULT_ROOMS.map((r) => ({ ...r, adjacent: [...r.adjacent], items: r.items.map((it) => ({ ...it })) })),
    characters: Object.fromEntries(
      COMPANION_IDS.map((id) => [
        id,
        {
          id,
          name: CHARACTER_NAMES[id] ?? id,
          room: 'living',
          activity: null,
          activityEndsAt: null,
          activityLeftMs: null, // 暂停时冻结的剩余毫秒（pause_activity 写入，回灶换回 endsAt；close 不再冻结）
          activityPaused: null, // pause_activity「放下锅铲」：暂停中的活动标记（暂停=不忙）
          lastAmbientAt: null, // 活动隔墙动静上次入账时刻（§9.5，每 10min 补一条去重）
          mood: null, // 挂状态（心情/神态，字符串；空=无），瞬态随位置进场景动态窗口
          conditions: [], // 持久状态（时间段）：{ id, name, startAt, endAt, cycleDays?, source?, note? }
          hear: [], // "听到"决策链缓冲（相邻动静攒存）
        },
      ]),
    ),
    hearThresholds: { ...HEAR_THRESHOLDS },
    master: { atHome: false, room: null },
    topics: {}, // 话题状态（§9.2，片内作用域：open 时清空；跨片不延续）
    // 发情周期日历（§9.18）：每只猫一条 {gapDays, durDays, nextStart, nextEnd, jitterDays,
    // seeded, rounds}。首次结算由 settleCycles 按 CYCLE_CONFIG 错开播种，所以这里是空对象。
    cycles: {},
    // 每日随机身体状态（§9.18）：默认开（2026-09-17 主人拍板）；rolledOn 记今天掷过没有，
    // 防开片重掷（片是你开几次就几次，日子一天只有一个）
    regime: { enabled: true, rolledOn: null, picks: [], lastResult: null },
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

// 归一化房间物品（HOUSE_DESIGN §1 家当）：item 是 `{ name, state?, count? }`，也容忍主人
// 手写成纯字符串数组；state 归一成字符串或 null，count 归一成 ≥1 的整数（缺省 1，1 不显示）。
// 场景注入与前端视角共用同一个口径。
export function roomItems(home, roomId) {
  const r = (home.rooms || []).find((x) => x && x.id === roomId)
  const list = r && Array.isArray(r.items) ? r.items : []
  const out = []
  for (const it of list) {
    if (typeof it === 'string') {
      const name = it.trim()
      if (name) out.push({ name, state: null, count: 1 })
      continue
    }
    if (!it || typeof it !== 'object') continue
    const name = typeof it.name === 'string' ? it.name.trim() : ''
    if (!name) continue
    const state = typeof it.state === 'string' && it.state.trim() ? it.state.trim() : null
    out.push({ name, state, count: itemCount(it.count) })
  }
  return out
}

// 数量归一化（读路径，宽容）：认数字与数字字符串（手写 json 里 "50" 很常见）；
// 非数/小于 1/缺省都算 1，小数向下取整。写路径（setRoomItems）对小数直接报错。
function itemCount(v) {
  const n = typeof v === 'string' ? Number(v.trim()) : v
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1
}

// 工具传进来的数量参数（HOUSE_DESIGN §4）：缺省 1，必须 ≥1 的整数，上限 ITEM_COUNT_MAX
function itemAmountArg(v) {
  if (v === undefined || v === null || String(v).trim() === '') return 1
  const n = Number(String(v).trim())
  if (!Number.isFinite(n) || n < 1 || Math.floor(n) !== n) {
    throw new Error('数量要是 ≥1 的整数')
  }
  if (n > ITEM_COUNT_MAX) throw new Error('一次最多 ' + ITEM_COUNT_MAX + ' 个')
  return n
}

// 落盘用的精简形态：count=1 不写、没状态不写（账本保持轻）
function compactItem(it) {
  const out = { name: it.name }
  if ((it.count || 1) > 1) out.count = it.count
  if (it.state) out.state = it.state
  return out
}

// 家当变更差异（HOUSE_DESIGN §3）：以名字为键，产出 added / removed / changed。
// 账本行与时间线渲染共用同一份口径。
export function itemsDiff(before, after) {
  const b = new Map((before || []).map((it) => [it.name, it]))
  const a = new Map((after || []).map((it) => [it.name, it]))
  const added = []
  const removed = []
  const changed = []
  for (const [name, it] of a) {
    if (!b.has(name)) {
      added.push(it)
      continue
    }
    const old = b.get(name)
    if ((old.count || 1) !== (it.count || 1) || (old.state || '') !== (it.state || '')) {
      changed.push({ name, from: old, to: it })
    }
  }
  for (const [name, it] of b) if (!a.has(name)) removed.push(it)
  return { added, removed, changed }
}

// 家当变更的人话（HOUSE_DESIGN §3）：谁给哪个房间添了/拿走了什么、什么变了样。
// 片内时间线（index.js）与家史（sliceEventsText）共用。
export function itemsEventText(line, home) {
  if (!line) return ''
  const who = !line.by || line.by === 'master' ? '主人' : charName(home, line.by) || String(line.by)
  const room = roomName(home, line.room)
  const fmt = (it) =>
    it.name + ((it.count || 1) > 1 ? '×' + it.count : '') + (it.state ? '（' + it.state + '）' : '')
  const parts = []
  if (Array.isArray(line.took) && line.took.length > 0) {
    parts.push(who + '从' + room + '拿走了 ' + line.took.map(fmt).join('、'))
  }
  if (Array.isArray(line.put) && line.put.length > 0) {
    parts.push(who + '给' + room + '添了 ' + line.put.map(fmt).join('、'))
  }
  if (Array.isArray(line.added) && line.added.length > 0) {
    parts.push(who + '给' + room + '添了 ' + line.added.map(fmt).join('、'))
  }
  if (Array.isArray(line.removed) && line.removed.length > 0) {
    parts.push(who + '从' + room + '拿走了 ' + line.removed.map(fmt).join('、'))
  }
  if (Array.isArray(line.changed) && line.changed.length > 0) {
    parts.push(who + '动了' + room + '的 ' + line.changed.map((c) => fmt(c.to || c)).join('、'))
  }
  return parts.join('；')
}

// 房间物品渲染文本（「沙发、消婴器×50（新的）」）；没有东西的房间返回空串（不占 token）
export function roomItemsText(home, roomId) {
  return roomItems(home, roomId)
    .map((it) => {
      const head = it.count > 1 ? it.name + '×' + it.count : it.name
      return it.state ? head + '（' + it.state + '）' : head
    })
    .join('、')
}

// ── 家物理 · 纯函数 ──

// 距离层级：same（同房间可对话）/ adjacent（相邻能听到动静）/ far（远处与不在家无感）
export function roomRelation(home, fromRoom, toRoom) {
  if (fromRoom === toRoom) return 'same'
  const room = (home.rooms || []).find((r) => r.id === fromRoom)
  if (!room || !Array.isArray(room.adjacent)) return 'far'
  return room.adjacent.includes(toRoom) ? 'adjacent' : 'far'
}

// ── 说话音量（§9.16，2026-09-16 落地的 9/15 待办）──
// 离散三档（连续值语义不清："0.7 的声音是什么声音啊"）：
//   小声 = 悄悄话，只出这一间屋子（同房听得见，隔壁听不见）
//   正常 = 现在的行为，隔壁隐约闻声（进缓冲，攒够阈值才掀被子）
//   大声 = 喊一声，隔壁听得清清楚楚（当场被叫醒），再远一间的还隐约闻得到
// 声学模型：每穿一堵墙降一档（三档制）。主题例外只有一条——「工作状态下隔壁的大声
// 降半档」：真切到隔壁的那一声，落到正埋头做事的听者耳朵里降回"隐约"，她照旧听得见
// （进缓冲、按老规矩攒够才反应），但不会被一嗓子当场打断。忙碌只削弱"当场抓住"的
// 那一声，不改其他档位（正常/远处的动静本来就是慢路，不用再降——降了会变成"忙起来
// 就什么都听不见"，那是另一个设计）。
// 字体映射与传播范围是两件事（主人 2026-09-15 定的拆法）：前端按 volume 调字号，不走这里。
export const SAY_VOLUMES = ['小声', '正常', '大声']
export const SAY_VOLUME_DEFAULT = '正常'
const SAY_VOLUME_NOTCH = { 小声: 0, 正常: 1, 大声: 2 }
const SAY_RELATION_STEPS = { same: 0, adjacent: 1, far: 2 }

// 归一化：只认三档，其余（含旧数据缺省）一律按正常
export function sayVolume(v) {
  const s = typeof v === 'string' ? v.trim() : ''
  return SAY_VOLUMES.includes(s) ? s : SAY_VOLUME_DEFAULT
}

// 听觉判定：这句音量走到「听者所在房间」时剩下几档。
// 返回 { level: 'clear'|'faint'|'silent', steps, notch, gripped }。
// 同房（steps=0）永远真切——同一屋檐下，再小的声音也听得见，小声只是不出屋；
// 隔墙则看衰减后的档位：≥1 真切 / 0 隐约 / <0 听不见。
// gripped = 真切到"当场抓住注意力"（隔着一堵墙且不被忙碌削掉）——调度层据此立刻唤醒。
export function sayPerceive(home, speakingRoom, listenerRoom, volume, listenerBusy) {
  const rel = roomRelation(home, speakingRoom, listenerRoom)
  const steps = SAY_RELATION_STEPS[rel] === undefined ? 2 : SAY_RELATION_STEPS[rel]
  let notch = SAY_VOLUME_NOTCH[sayVolume(volume)] - steps
  // 忙碌降半档：只降"真切"那一档（大声）、且只降隔墙听见的（同房不降）
  const damped = steps >= 1 && !!listenerBusy && notch >= 1
  if (damped) notch -= 1
  if (notch < 0) return { level: 'silent', steps, notch, gripped: false }
  if (steps === 0) return { level: 'clear', steps, notch, gripped: false }
  if (notch >= 1) return { level: 'clear', steps, notch, gripped: true }
  return { level: 'faint', steps, notch, gripped: false }
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
// 片外空窗留行门槛（§9.16）：两片之间隔半小时以上才记一行「时间片外过去了…」。
// 日常开关片（回家自动开片、收工关片，隔几秒）不该在时间线里刷这种行。
export const GAP_LINE_MIN_MS = 30 * 60000

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

// ── 发情周期日历（§9.18，2026-09-17 主人拍板）──
// 周期归这张表记账（每只猫一条），conditions 里的「发情」只是当前这一轮的投影：
// 到期前 CYCLE_LEAD_DAYS 天才写进 conditions——倒计时太早进她的上下文，模型会一直
// 惦记这件事，比发情本身还出戏；到点仍走既有 T2 路径唤醒本人。
// 参数按猫配（主人定：姐姐 30 天一轮、小玖 40 天一轮，各持续 3 天）；续轮带 ±抖动，
// 否则日期在日历上一眼算得出来，家里的事就变成打卡了。抖动算出来即落盘 → 日历上的
// 「下一次」是确定日期，「再下一次」才是虚线预计。
export const CYCLE_CONFIG = {
  moli: { gapDays: 30, durDays: 3, firstDelayDays: 4 }, // 姐姐墨璃
  kyu: { gapDays: 40, durDays: 3, firstDelayDays: 9 }, // 小玖
}
export const CYCLE_NAME = '发情'
export const CYCLE_JITTER_DAYS = 3
export const CYCLE_LEAD_DAYS = 2
export const DAY_MS = 86400000

function randIntBetween(rand, min, max) {
  return min + Math.floor(rand() * (max - min + 1))
}

function isoOf(ms) {
  return new Date(ms).toISOString()
}

// 本地日 key（按主人的时钟过日子，与 sliceId 同一套时区观）
export function dayKeyOf(date) {
  const d = date instanceof Date ? date : new Date(date)
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

// 周期结算（纯函数，就地把结果写回 home）：
//   ① 首次播种：没有周期档的猫按 firstDelayDays 错开排第一轮（家里不会开场双发情）
//   ② 滚动：本轮整段过去 → 排下一轮（gapDays + 抖动，抖动落盘）
//   ③ 临近（≤ CYCLE_LEAD_DAYS 天）→ 写 pending 进 conditions（一次性；已有同名条目不动，
//      免得覆盖猫自己挂的那条）
// 幂等：同一天重复调用不再产生变化。返回 { changed: [{charId, kind, ...}] }。
export function settleCycles(home, now, rand = Math.random) {
  const t = now instanceof Date ? now.getTime() : Date.now()
  const changed = []
  if (!home.cycles || typeof home.cycles !== 'object') home.cycles = {}
  for (const [charId, cfg] of Object.entries(CYCLE_CONFIG)) {
    const ch = home.characters && home.characters[charId]
    if (!ch || typeof ch !== 'object') continue
    let cyc = home.cycles[charId]
    if (!cyc || !cyc.nextStart || !cyc.nextEnd) {
      const startMs = t + cfg.firstDelayDays * DAY_MS
      cyc = {
        gapDays: cfg.gapDays,
        durDays: cfg.durDays,
        nextStart: isoOf(startMs),
        nextEnd: isoOf(startMs + cfg.durDays * DAY_MS),
        jitterDays: 0,
        seeded: false,
        rounds: 0,
      }
      home.cycles[charId] = cyc
      changed.push({ charId, kind: 'cycle-init', nextStart: cyc.nextStart, nextEnd: cyc.nextEnd })
    }
    for (let guard = 0; t >= new Date(cyc.nextEnd).getTime() && guard < 200; guard += 1) {
      const jitter = randIntBetween(rand, -CYCLE_JITTER_DAYS, CYCLE_JITTER_DAYS)
      const startMs = new Date(cyc.nextEnd).getTime() + (Number(cyc.gapDays) || cfg.gapDays) * DAY_MS
      cyc.nextStart = isoOf(startMs + jitter * DAY_MS)
      cyc.nextEnd = isoOf(startMs + jitter * DAY_MS + (Number(cyc.durDays) || cfg.durDays) * DAY_MS)
      cyc.jitterDays = jitter
      cyc.seeded = false
      cyc.rounds = (Number(cyc.rounds) || 0) + 1
      changed.push({ charId, kind: 'cycle-next', nextStart: cyc.nextStart, nextEnd: cyc.nextEnd, jitterDays: jitter })
    }
    const startMs = new Date(cyc.nextStart).getTime()
    if (!cyc.seeded && t >= startMs - CYCLE_LEAD_DAYS * DAY_MS) {
      const list = Array.isArray(ch.conditions) ? ch.conditions : (ch.conditions = [])
      const key = conditionKey(CYCLE_NAME)
      if (list.some((c) => c && conditionKey(c.name) === key)) {
        // 她已经自己挂过了（或上一轮还留着）——认领它，不覆盖本人写的
        cyc.seeded = true
        changed.push({ charId, kind: 'cycle-adopt', startAt: cyc.nextStart, endAt: cyc.nextEnd })
      } else {
        list.push({
          id: (charId + '-cycle-r' + (Number(cyc.rounds) || 0)).replace(/[^a-zA-Z0-9-]/g, ''),
          name: CYCLE_NAME,
          startAt: cyc.nextStart,
          endAt: cyc.nextEnd,
          source: 'system',
        })
        cyc.seeded = true
        changed.push({ charId, kind: 'cycle-seed', startAt: cyc.nextStart, endAt: cyc.nextEnd })
      }
    }
  }
  return { changed }
}

// 日历视图（给主人看的那份，不进猫的上下文）：本轮/下一次是确定日期，afterStart 是
// 「再下一次」的虚线预计（那个位置还没抽抖动，所以标预计）。
export function cycleView(home, charId, now) {
  const cyc = home.cycles && home.cycles[charId]
  if (!cyc || !cyc.nextStart || !cyc.nextEnd) return null
  const t = now instanceof Date ? now.getTime() : now ? new Date(now).getTime() : Date.now()
  const startMs = new Date(cyc.nextStart).getTime()
  const endMs = new Date(cyc.nextEnd).getTime()
  const leadMs = CYCLE_LEAD_DAYS * DAY_MS
  let phase = 'idle'
  if (t >= startMs && t < endMs) phase = 'active'
  else if (t < startMs && t >= startMs - leadMs) phase = 'pending'
  const durDays = Number(cyc.durDays) || 3
  const afterStart = endMs + (Number(cyc.gapDays) || 30) * DAY_MS
  return {
    charId,
    label: conditionLabel(CYCLE_NAME),
    gapDays: Number(cyc.gapDays) || 30,
    durDays,
    phase, // active=本轮进行中 / pending=已临近（已写进她的状态）/ idle=还早
    startAt: cyc.nextStart,
    endAt: cyc.nextEnd,
    remainMs: Math.max(0, endMs - t),
    untilMs: Math.max(0, startMs - t),
    jitterDays: Number(cyc.jitterDays) || 0,
    rounds: Number(cyc.rounds) || 0,
    afterStart: isoOf(afterStart),
    afterEnd: isoOf(afterStart + durDays * DAY_MS),
  }
}

// ── 每日随机身体状态（§9.18）──
// 只掷「身体自己发生的事」——外界对她做了什么（受伤/被撞/摔了）必须由行动产生，
// 不能天降（主人 2026-08-31 定的「主体先于事件」）。身体不听意志，系统代管才成立。
// 命中后按权重抽一条；一天最多一个（主人 2026-09-17 明确），发情开场那天独占。
export const REGIME_POOL = [
  { name: '精神特别好', weight: 25, durDays: 1, line: '你今天精神特别好，浑身都是劲。' },
  { name: '胃口特别好', weight: 25, durDays: 1, line: '你今天胃口特别好，闻到什么都想吃。' },
  { name: '换毛期', weight: 20, durDays: 2, line: '你开始换毛了，走到哪掉到哪，鼻子也有点痒。' },
  { name: '失眠', weight: 18, durDays: 1, line: '你昨晚翻来覆去没睡好，今天脑袋发沉。' },
  { name: '落枕', weight: 8, durDays: 1, line: '你睡歪了脖子，转头有点费劲。' },
  { name: '生病', weight: 4, durDays: 2, line: '你有点着凉了，头昏昏的，鼻子也不通。' },
]
export const REGIME_DAILY_CHANCE = 0.12 // 每天掷一次，命中约 8 天一个

function pickWeighted(pool, rand) {
  const total = pool.reduce((s, it) => s + (Number(it.weight) || 0), 0)
  if (!(total > 0)) return pool[0] || null
  let r = rand() * total
  for (const it of pool) {
    r -= Number(it.weight) || 0
    if (r < 0) return it
  }
  return pool[pool.length - 1]
}

// 每日结算（纯函数）：片内第一次 tick 掷一次，落盘 rolledOn 防开片重掷/一天多个。
// 关闭时跳过；今天已经掷过跳过；今天发情开场则独占（不叠加）。返回本次发生了什么。
export function settleRegime(home, now, rand = Math.random) {
  const d = now instanceof Date ? now : new Date(now)
  const date = dayKeyOf(d)
  if (!home.regime || typeof home.regime !== 'object') home.regime = { enabled: true, rolledOn: null, picks: [] }
  const rg = home.regime
  if (rg.enabled !== false) rg.enabled = true // 归一化：只有显式 false 才算关（默认开）
  if (!Array.isArray(rg.picks)) rg.picks = []
  const out = { date, rolled: false, picked: null, entries: [], skip: null }
  if (rg.enabled === false) {
    out.skip = 'off'
    return out
  }
  if (rg.rolledOn === date) {
    out.skip = 'already'
    return out
  }
  // 发情开场独占一天：重事件和随机状态不同日叠加（否则开场就是「发情 + 感冒」）
  const estrusKey = conditionKey(CYCLE_NAME)
  const estrusToday = Object.values(home.characters || {}).some((ch) =>
    (Array.isArray(ch && ch.conditions) ? ch.conditions : []).some(
      (c) => c && conditionKey(c.name) === estrusKey && c.startAt && dayKeyOf(new Date(c.startAt)) === date,
    ),
  )
  rg.rolledOn = date
  if (estrusToday) {
    out.skip = 'cycle-day'
    return out
  }
  if (rand() >= REGIME_DAILY_CHANCE) {
    out.skip = 'miss'
    rg.lastResult = null
    return out
  }
  const item = pickWeighted(REGIME_POOL, rand)
  const ids = Object.keys(home.characters || {})
  if (!item || ids.length === 0) {
    out.skip = 'empty'
    return out
  }
  const charId = ids[Math.min(ids.length - 1, Math.floor(rand() * ids.length))]
  const ch = home.characters[charId]
  const list = Array.isArray(ch.conditions) ? ch.conditions : (ch.conditions = [])
  const startMs = d.getTime()
  const endMs = startMs + (Number(item.durDays) || 1) * DAY_MS
  list.push({
    id: (charId + '-daily-' + date).replace(/[^a-zA-Z0-9-]/g, ''),
    name: item.name,
    startAt: isoOf(startMs),
    endAt: isoOf(endMs),
    notifiedAt: isoOf(startMs), // 自确认：唤醒与告知由调度层当场发，别让 T2 再来一次
    source: 'system',
    note: item.line,
  })
  rg.lastResult = { date, charId, name: item.name }
  rg.picks = rg.picks.slice(-29).concat([{ date, charId, name: item.name }])
  out.rolled = true
  out.picked = item.name
  out.entries.push({ charId, name: item.name, line: item.line, startAt: isoOf(startMs), endAt: isoOf(endMs) })
  return out
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

// 带 about 的 say 话题判定（§9.2 / §9.16.3）：话题必须存在且未收掉。
// 返回 { topic } 合法；{ error } 不合法。注意：不合法**不是** say 的失败条件——
// 唯一的调用点在 say() 里，命中即降级（摘掉标记照常入账），error 只当人话原因用。
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

// 关片结算（2026-09-15 主人定案：活动持续计时）：片外时间照流，activityEndsAt 是
// 绝对时间戳、跨片保留不再冻结；只把片内已到期的活动自然收尾。
export function settleActivities(home, now) {
  for (const ch of Object.values(home.characters || {})) {
    if (ch.activity && typeof ch.activityEndsAt === 'string' && new Date(ch.activityEndsAt).getTime() <= now.getTime()) {
      // 片内已到期：活动自然结束
      ch.activity = null
      ch.activityEndsAt = null
      ch.activityLeftMs = null
      ch.activityPaused = null
      ch.lastAmbientAt = null
    } else if (!ch.activity) {
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
    case 'items':
      return itemsEventText(e, home)
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
      case 'items': {
        const t = itemsEventText(e, home)
        if (t) lines.push(t)
        break
      }
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

  // 细读：区分「文件不存在」/「解析失败」/「读到了」。账本损坏不能当成「没有账本」——
  // 当成没有就会被默认家覆盖，主人攒的东西一次清空（HOUSE_DESIGN §2 的加固）。
  async readJsonDetailed(path) {
    let text
    try {
      text = await readFile(path, 'utf8')
    } catch (e) {
      if (e && e.code === 'ENOENT') return { missing: true }
      throw e
    }
    try {
      return { value: JSON.parse(text) }
    } catch (e) {
      return { corrupt: String(e && e.message ? e.message : e) }
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
    const read = await this.readJsonDetailed(homePath)
    if (read.missing) {
      // 头一次装：写默认家
      await this.writeJsonAtomic(homePath, defaultHome())
    } else if (
      read.corrupt ||
      !read.value ||
      !Array.isArray(read.value.rooms) ||
      typeof read.value.characters !== 'object'
    ) {
      // 账本损坏：绝不静默重置（HOUSE_DESIGN §2）。旧行为是直接写默认家，主人攒的房间、
      // 家当、角色位置一次清空。现在原地保留原文件 + 另存一份 + 报错，主人修好再启动。
      const bak = homePath + '.corrupt-' + sliceIdOf(this.now())
      await copyFile(homePath, bak)
      throw new Error(
        '家账本读不出来（' +
          (read.corrupt || '结构不对：缺 rooms 或 characters') +
          '）。原文件保留在原处，另存了一份到 ' +
          bak +
          '；修好后再启动猫窝。',
      )
    } else {
      const home = read.value
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
      // v4 → v5 迁移：房间补 items 家当（已知房间用默认稿，其余空数组；不猜主人的东西）
      for (const r of home.rooms) {
        if (!r || typeof r !== 'object') continue
        if (!Array.isArray(r.items)) {
          const def = DEFAULT_ROOMS.find((x) => x.id === r.id)
          r.items = def && Array.isArray(def.items) ? def.items.map((it) => ({ ...it })) : []
          changed = true
        }
      }
      // v5 → v6 迁移：发情周期表 + 每日随机身体状态闸（§9.18）。周期表留空，首次结算
      // 按 CYCLE_CONFIG 错开播种；随机闸默认开（主人 2026-09-17 拍板，改掉了早些时候
      // 「开关默认关」的定案，见 SCHEDULING_DESIGN §9.18）。
      if (!home.cycles || typeof home.cycles !== 'object' || Array.isArray(home.cycles)) {
        home.cycles = {}
        changed = true
      }
      if (!home.regime || typeof home.regime !== 'object' || Array.isArray(home.regime)) {
        home.regime = { enabled: true, rolledOn: null, picks: [], lastResult: null }
        changed = true
      } else {
        if (home.regime.enabled === undefined) {
          home.regime.enabled = true
          changed = true
        }
        if (home.regime.rolledOn === undefined) {
          home.regime.rolledOn = null
          changed = true
        }
        if (!Array.isArray(home.regime.picks)) {
          home.regime.picks = []
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
    if (!home || !Array.isArray(home.rooms)) {
      // 运行中被改坏（编辑器保存到一半那种也算）：报错，别默默换成默认家把账本写花
      throw new Error('家账本读不出来：' + this.homePath() + '（JSON 解析失败或结构不对）')
    }
    return home
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
    // 活动持续计时：activityEndsAt 是绝对时间戳，片外照流，open 无需解冻
    const home = await this.home()
    // 话题是片内作用域：开新片清空全部旧话题（对话不跨片，回顾归蒸馏；片内进程重启则留存）
    home.topics = {}
    // 跨片过期活动静默结算（§9.16，2026-09-16 定案）：片外的时间照流（绝对计时，
    // §9.15 定案），但家是静止的——没人被谁叫醒。已经到期的活动在开片这一瞬安静收掉，
    // 不走 T3 的「做完了X」公共 notice + 唤醒。否则会出现「凌晨关片、睡觉在早上 8 点
    // 到期，傍晚 6 点开片时被告知刚睡醒」这种迟到 10 小时的闹钟（2026-09-16 实测：
    // 小玖「训练模型」到期 12 小时后在傍晚被唤醒并汇报「训练跑完啦」）。
    // 片外流逝的时间仍然承认（activityEndsAt 就是绝对戳），只是不再补一场迟到的唤醒。
    settleActivities(home, this.now())
    await this.saveHome(home)
    const snapshot = { home, relations: await this.relations() }
    await this.writeJsonAtomic(join(dir, OPEN_SNAP_FILE), snapshot)
    await this.writeJsonAtomic(join(dir, META_FILE), { sliceId, openedAt, closedAt: null })
    await writeFile(join(dir, LOG_FILE), '', { mode: 0o600 })
    await this.writeJsonAtomic(join(this.dir, CURRENT_FILE), { sliceId, openedAt })
    // 片外空窗留一行（§9.16）：时间片是猫的"经历"边界，片外的时间流过了却没被经历。
    // 隔得久（≥ GAP_LINE_MIN_MS）就记一行，让读时间线的角色知道「钟表走了这么久，
    // 但家里没人醒着」——否则两片之间的事件容易被脑补成"刚刚发生"。
    try {
      const prevId = await this.latestClosedSliceId()
      const prevMeta = prevId ? await this.readJson(join(this.dir, SLICES_DIR, prevId, META_FILE), null) : null
      const closedMs = prevMeta && typeof prevMeta.closedAt === 'string' ? new Date(prevMeta.closedAt).getTime() : NaN
      const nowMs = this.now().getTime()
      if (Number.isFinite(closedMs) && nowMs - closedMs >= GAP_LINE_MIN_MS) {
        await this.log('gap', { from: prevMeta.closedAt, to: openedAt, ms: nowMs - closedMs })
      }
    } catch {
      /* 空窗行是锦上添花，写不了不拖累开片 */
    }
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
    // 快照先落片内最终状态（活动未结算）
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
    // 再结算活动写入 home.json：已到期自然收尾，未到期保持绝对 endsAt（片外持续计时）
    settleActivities(home, this.now())
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
  //  - cycleDays：到期几天后自动开始下一轮（§9.18 起发情不再走它，周期归 home.cycles）
  // 同名单条替换（先移除旧的再插新）。返回 { id, name, startAt, endAt, cycleDays }
  async setCondition(id, opts = {}) {
    return this.mutate(async () => {
      await this.requireOpen()
      const home = await this.home()
      const ch = home.characters[id]
      if (!ch) throw new Error(`角色 "${id}" 不存在`)
      const name = typeof opts.name === 'string' ? opts.name.trim() : ''
      if (!name) throw new Error('条件名不能为空')
      const isCycle = conditionKey(name) === conditionKey(CYCLE_NAME)
      // lastsDays = 0：清除该状态
      if (Number(opts.lastsDays) === 0) {
        const before = ch.conditions.length
        ch.conditions = (ch.conditions || []).filter((c) => c.name !== name)
        await this.saveHome(home)
        await this.log('condition', { char: id, name, action: 'clear', source: 'self', removed: before - ch.conditions.length })
        return { id, name, action: 'clear', removed: before - ch.conditions.length }
      }
      let startsInDays = opts.startsInDays === undefined || opts.startsInDays === null ? 0 : Number(opts.startsInDays)
      if (!Number.isFinite(startsInDays) || startsInDays < 0) throw new Error('startsInDays 需要是不小于 0 的数字')
      startsInDays = Math.round(startsInDays)
      let lastsDays = Number(opts.lastsDays)
      const def = CONDITION_TYPES[conditionKey(name)]
      if (!Number.isFinite(lastsDays) || lastsDays <= 0) lastsDays = def ? def.defaultDays : CONDITION_DEFAULT_DAYS
      let cycleDays = Number(opts.cycleDays)
      if (!Number.isFinite(cycleDays) || cycleDays < 0) cycleDays = def && Number(def.cycleDays) > 0 ? def.cycleDays : 0
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
      cond.source = 'self' // 来路（§9.18）：她自己挂的，区别于系统播种/每日期
      // 猫自己挂发情时把日历一起挪过去（§9.18）：周期表是单一记账者，不挪就会出现
      // 「日历说下个月，人却现在是发情期」这种两套时间观打架
      if (isCycle) {
        if (!home.cycles || typeof home.cycles !== 'object') home.cycles = {}
        const prev = home.cycles[id] || {}
        const gap = Number(prev.gapDays) || (CYCLE_CONFIG[id] && CYCLE_CONFIG[id].gapDays) || 30
        home.cycles[id] = {
          gapDays: gap,
          durDays: lastsDays,
          nextStart: startAt,
          nextEnd: endAt,
          jitterDays: 0,
          seeded: true, // 这一轮已经投影成 condition 了，不用再播种
          rounds: (Number(prev.rounds) || 0) + 1,
        }
      }
      ch.conditions = (ch.conditions || []).filter((c) => c.name !== name).concat([cond])
      await this.saveHome(home)
      await this.log('condition', { char: id, name, action: 'set', source: 'self', startAt, endAt, cycleDays: cycleDays || 0 })
      return { id: cond.id, name, startAt, endAt, cycleDays: cycleDays || 0 }
    })
  }

  // 周期结算（§9.18）：播种/滚动/临近写 pending。返回 { changed }，无变化不写盘。
  // 唤醒不在这里——写的是 pending，到点仍走 T2（既有路径），不用新机制。
  async tickCycles(rand) {
    return this.mutate(async () => {
      const home = await this.home()
      const r = settleCycles(home, this.now(), rand)
      if (r.changed.length > 0) {
        await this.saveHome(home)
        for (const e of r.changed) await this.log('cycle', { char: e.charId, kind: e.kind, nextStart: e.nextStart, nextEnd: e.nextEnd, startAt: e.startAt, endAt: e.endAt, jitterDays: e.jitterDays })
      }
      return r
    })
  }

  // 每日随机身体状态（§9.18）：片内第一次结算时掷一次，一天最多一个（落盘 rolledOn）。
  // 命中才写盘；写的是 active + 自确认，告知与唤醒由调度层当场发。
  async tickRegime(rand) {
    return this.mutate(async () => {
      const home = await this.home()
      const r = settleRegime(home, this.now(), rand)
      if (r.rolled) {
        await this.saveHome(home)
        for (const e of r.entries) {
          await this.log('condition', { char: e.charId, name: e.name, action: 'set', source: 'system', by: 'daily', startAt: e.startAt, endAt: e.endAt })
        }
      } else if (r.skip && r.skip !== 'already' && r.skip !== 'off') {
        // 掷空的日期也落盘了（rolledOn），把盘写回去，否则重启后会重复掷
        await this.saveHome(home)
      }
      return r
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
  async say(who, text, action, about, volume) {
    return this.mutate(async () => {
      await this.requireOpen()
      if (typeof who !== 'string' || !who) throw new Error('who 需要是角色 id 或 "master"')
      if (typeof text !== 'string' || !text.trim()) throw new Error('text 需要是非空字符串')
      const act = typeof action === 'string' ? action.trim() : ''
      const home = await this.home()
      // 话题门禁降级（唯一真相，2026-09-16 定案）：about 是标签，台词是内容。
      // 指向不存在/已收掉的话题时摘掉标记照常入账。旧版「硬校验失败 → 整句吞掉」
      // 退役——工具层曾另有一份同样的降级，两份逻辑并存时谁先跑决定了「话丢了没有」
      // （服务层那份还会在「校验通过 → 话题被 tick 收掉 → 落账」的竞态里真吞一句）。
      // 现在只有这里一处判定：任何入口（工具/接话链/新调用点）行为一致。
      // 开场白走 _sayCore（openTopic 内），不受此限。
      let ab = typeof about === 'string' ? about.trim() : ''
      let aboutNote = ''
      let aboutDropped = ''
      if (ab && who !== 'master') {
        const chk = checkTopicAbout(home, who, ab)
        if (chk.error) {
          aboutDropped = ab
          ab = ''
          aboutNote =
            '（话题「' + aboutDropped + '」不存在或已经收掉了，这句按普通说话记下了。' +
            '想聊这条线就用 open_topic 重提一次。）'
        }
      }
      const r = await this._sayCore(home, who, text, act || undefined, ab || undefined, volume)
      if (!aboutDropped) return r
      return { ...r, aboutDropped, aboutNote }
    })
  }

  // 说话核心（必须在 mutate 内调用）：入账 say 行 + 听到的人进缓冲 + 落盘。
  // say() 与 resolveHear() 共用；后者不能直接调 this.say()（mutate 内再 mutate 会死锁排队）。
  // volume（§9.16）：小声/正常/大声，决定这句话能走多远（见 sayPerceive）。
  async _sayCore(home, who, text, action, about, volume) {
    const room = this.locateRoom(home, who)
    if (!room) {
      if (who === 'master') throw new Error('主人不在家（先 moveMaster 进房）')
      throw new Error(`角色 "${who}" 不存在`)
    }
    const vol = sayVolume(volume)
    // 说话时刻全员位置快照（含主人；人不在家不记）
    const positions = {}
    for (const [id, ch] of Object.entries(home.characters || {})) {
      if (ch && ch.room) positions[id] = ch.room
    }
    if (home.master && home.master.atHome && home.master.room) positions.master = home.master.room
    const around = this.perceiveAround(home, room, who !== 'master', who)
    // 听觉判定（§9.16 声学模型）：每穿一堵墙降一档；正在忙的听者再降一档（「工作状态下
    // 隔壁的大声降半档」）。≥1 真切 / 0 隐约 / <0 听不见。同房永远真切（同一屋檐下，
    // 再小的声音也听得见），所以忙碌降档只对隔壁和远处生效。
    const now = this.now()
    const clear = []
    const faint = []
    const silent = []
    const urgent = []
    for (const id of [...around.direct, ...around.adjacent, ...around.far]) {
      const lroom = id === 'master' ? (home.master && home.master.room) : (home.characters[id] && home.characters[id].room)
      const busy = id === 'master' ? false : isBusy(home.characters[id], now)
      const p = sayPerceive(home, room, lroom, vol, busy)
      if (p.level === 'silent') {
        silent.push(id)
      } else if (p.level === 'clear' && p.steps === 0) {
        clear.push(id) // 同房：听得见，也看得见形态（action 给人看）
      } else if (p.level === 'clear') {
        faint.push(id) // 隔壁大声：听得清，但还是隔着一堵墙（看不见形态）
        // urgent 只收角色：主人是真人（即时感知，没有 agent 回合可唤醒），不进这份名单。
        // 2026-09-19 事故：主人在隔壁时被 push 进 urgent，调度层拿它当唤醒名单，
        // enqueueTurn('master') 烧了一次 LLM 替主人回话（tryWakeHear 当时无角色守卫）。
        if (p.gripped && id !== 'master') urgent.push(id) // 真切到当场抓住注意力：喊一声就是为了被听见，不等缓冲攒够
      } else {
        faint.push(id)
      }
    }
    await this.log('say', {
      who,
      room,
      text,
      // 音量（§9.16）：小声/大声才记，缺省即正常；旧 log 无此字段，消费侧按正常处理
      ...(vol !== '正常' ? { volume: vol } : {}),
      // 动作随台词入账（视觉信息）；旧 log 无此字段，消费侧容缺省
      ...(action ? { action } : {}),
      // 话题短语（topic 套件）：话题里的发言带 about，口径与渲染一致
      ...(about ? { about } : {}),
      positions,
      // audience = 听觉判定结果（权威）：clear 同房真切（看得见形态）/ faint 隔墙闻声
      // （看不见形态）/ silent 完全没听见（小声不出屋就是这个）。旧行只有 clear/faint。
      audience: { clear, faint, silent },
    })
    const buffered = []
    for (const id of faint) {
      if (id === 'master') continue // 主人不攒缓冲（人是即时感知的），回看走 transcript
      const ch = home.characters && home.characters[id]
      if (!ch) continue
      ch.hear = ch.hear || []
      // 缓冲只攒声音（text）：action 是视觉信息，隔墙看不见，不进缓冲。
      // room = 说话时房间（声源位置；人后来走开也不改，供唤醒校验与位置描述）
      ch.hear.push({ t: now.toISOString(), from: who, room, text })
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
      volume: vol,
      about: about || null,
      direct: around.direct,
      adjacent: around.adjacent,
      buffered,
      far: around.far,
      clear,
      faint,
      silent,
      urgent,
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

  // 家当编辑（HOUSE_DESIGN §2）：整表替换一个房间的东西。主人补货/清理走这条
  // （面板 → API → 本方法），也可以继续手改 home.json。校验从严：报错即不改盘。
  async setRoomItems(roomId, rawItems, by) {
    return this.mutate(async () => {
      const home = await this.home()
      const room = (home.rooms || []).find((r) => r && r.id === roomId)
      if (!room) throw new Error('没有这个房间：' + String(roomId))
      const before = roomItems(home, roomId)
      if (!Array.isArray(rawItems)) throw new Error('items 需要是数组')
      if (rawItems.length > ITEMS_MAX) throw new Error('一个房间最多 ' + ITEMS_MAX + ' 件东西')
      const items = []
      const seen = new Set()
      for (const raw of rawItems) {
        const src = typeof raw === 'string' ? { name: raw } : raw && typeof raw === 'object' ? raw : null
        if (!src) throw new Error('物品条目格式不对')
        const name = String(src.name == null ? '' : src.name).trim()
        if (!name) throw new Error('每件东西都要有名字')
        if (name.length > ITEM_NAME_MAX) {
          throw new Error('物品名太长（最多 ' + ITEM_NAME_MAX + ' 字）：' + name)
        }
        if (seen.has(name)) throw new Error('同一个房间里不能有两件同名的东西：' + name)
        seen.add(name)
        const state = String(src.state == null ? '' : src.state).trim()
        if (state.length > ITEM_STATE_MAX) {
          throw new Error('状态太长（最多 ' + ITEM_STATE_MAX + ' 字）：' + name)
        }
        let count = 1
        if (src.count !== undefined && src.count !== null && String(src.count).trim() !== '') {
          const n = Number(String(src.count).trim())
          if (!Number.isFinite(n) || n < 1 || Math.floor(n) !== n) {
            throw new Error('数量要是 ≥1 的整数：' + name)
          }
          if (n > ITEM_COUNT_MAX) throw new Error('数量最多 ' + ITEM_COUNT_MAX + '：' + name)
          count = n
        }
        const item = { name }
        if (count > 1) item.count = count
        if (state) item.state = state
        items.push(item)
      }
      room.items = items
      const after = await this.applyItems(home, roomId, before, by)
      return { room: roomId, items: after }
    })
  }

  // 家当变更的公共尾巴（HOUSE_DESIGN §3/§4）：算差异 → 写账（片内才记，跟家里其他事件
  // 一个规矩） → 落盘。面板编辑与猫娘工具都走这里，账本口径只有一处。
  async applyItems(home, roomId, before, by, action) {
    const after = roomItems(home, roomId)
    await this.saveHome(home)
    // 账本行：工具知道自己在干什么（拿 2 个 / 放 3 个），就按它报的记——
    // 只靠 diff 会说成「变了样」，还丢掉主语；面板整表替换没有动作语义，才回落到 diff。
    const diff = itemsDiff(before, after)
    const row =
      action ||
      ({ added: diff.added, removed: diff.removed, changed: diff.changed })
    const touched =
      (row.added || []).length +
        (row.removed || []).length +
        (row.changed || []).length +
        (row.took || []).length +
        (row.put || []).length >
      0
    if (touched) {
      const cur = await this.readJson(join(this.dir, CURRENT_FILE), null)
      if (cur && cur.sliceId) {
        await this.log('items', { room: roomId, by: by || 'master', ...row })
      }
    }
    return after
  }

  // 猫娘的房间（家当工具用）：只能碰自己所在的房间——跟「隔壁有什么看不见」是同一套可见性
  roomOf(home, charId) {
    const ch = home.characters && home.characters[charId]
    if (!ch || !ch.room) throw new Error('你不在任何一个房间里')
    const room = (home.rooms || []).find((r) => r && r.id === ch.room)
    if (!room) throw new Error('找不到你所在的房间：' + ch.room)
    return room
  }

  // 家当工具（HOUSE_DESIGN §4）：拿/用掉 N 个。归零即从房间里消失。
  async takeItem(charId, name, count) {
    return this.mutate(async () => {
      await this.requireOpen()
      const home = await this.home()
      const room = this.roomOf(home, charId)
      const before = roomItems(home, room.id)
      const target = before.find((it) => it.name === name)
      if (!target) throw new Error('这个房间里没有「' + name + '」')
      const n = itemAmountArg(count)
      const have = target.count || 1
      if (have < n) throw new Error('「' + name + '」只有 ' + have + ' 个，拿不了 ' + n + ' 个')
      const left = have - n
      room.items = before
        .map((it) => (it.name === name ? { ...it, count: left } : it))
        .filter((it) => it.count > 0) // 注意别写 (it.count || 1)：0 会被兜成 1，拿空的条目删不掉
        .map(compactItem)
      const after = await this.applyItems(home, room.id, before, charId, { took: [{ name, count: n }] })
      return { room: room.id, name, taken: n, left, items: after }
    })
  }

  // 家当工具：往自己房间放 N 个（买回来的、做好的、从别处拿来的）。已有就累加。
  async putItem(charId, name, count, state) {
    return this.mutate(async () => {
      await this.requireOpen()
      const home = await this.home()
      const room = this.roomOf(home, charId)
      const before = roomItems(home, room.id)
      const clean = String(name == null ? '' : name).trim()
      if (!clean) throw new Error('要放的东西得有名字')
      if (clean.length > ITEM_NAME_MAX) throw new Error('名字太长（最多 ' + ITEM_NAME_MAX + ' 字）')
      const n = itemAmountArg(count)
      const st = typeof state === 'string' ? state.trim() : ''
      if (st.length > ITEM_STATE_MAX) throw new Error('状态太长（最多 ' + ITEM_STATE_MAX + ' 字）')
      const exists = before.some((it) => it.name === clean)
      if (!exists && before.length >= ITEMS_MAX) {
        throw new Error('这个房间已经放了 ' + ITEMS_MAX + ' 件东西，先收一收')
      }
      room.items = (exists
        ? before.map((it) =>
            it.name === clean
              ? { ...it, count: (it.count || 1) + n, state: st || it.state }
              : it,
          )
        : [...before, { name: clean, count: n, state: st || null }]
      ).map(compactItem)
      const after = await this.applyItems(home, room.id, before, charId, {
        put: [{ name: clean, count: n, state: st || null }],
      })
      return { room: room.id, name: clean, put: n, count: (after.find((it) => it.name === clean) || {}).count || 1, items: after }
    })
  }

  // 家当工具：改自己房间里某件东西的状态（「水壶」→「空的」）。空串＝没有状态。
  async setItemState(charId, name, state) {
    return this.mutate(async () => {
      await this.requireOpen()
      const home = await this.home()
      const room = this.roomOf(home, charId)
      const before = roomItems(home, room.id)
      const clean = String(name == null ? '' : name).trim()
      const target = before.find((it) => it.name === clean)
      if (!target) throw new Error('这个房间里没有「' + clean + '」')
      const st = typeof state === 'string' ? state.trim() : ''
      if (st.length > ITEM_STATE_MAX) throw new Error('状态太长（最多 ' + ITEM_STATE_MAX + ' 字）')
      room.items = before
        .map((it) => (it.name === clean ? { ...it, state: st || null } : it))
        .map(compactItem)
      const after = await this.applyItems(home, room.id, before, charId, {
        changed: [{ name: clean, from: target, to: { name: clean, state: st || null, count: target.count || 1 } }],
      })
      return { room: room.id, name: clean, state: st || null, items: after }
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
  // （activityEndsAt → activityLeftMs 冻结）+ activityPaused 标记。
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
