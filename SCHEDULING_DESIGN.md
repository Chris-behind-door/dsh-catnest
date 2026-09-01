# 猫窝调度层设计方案（方向一）

> 2026-08-31 夜 小玖起草。**状态：v1 已交付（2026-08-31，78/78 测试全绿；宿主重启后生效）**。
>
> **交付记录（2026-08-31，切片 1–4 一次交付，切片 5 观察期待跑）**：
> 实现落点：index.js 调度层区块（masterSay 前）+ lib.js 原语（notice/consumeHear/
> markHearNotified/clearActivity/tickConditions+notifiedAt）。实现期与设计的四处偏差（均
> 为实现中发现的必要性补充，语义不偏离拍板）：
> 1. **hearNotified 标记**（新增，lib 原语 markHearNotified）：同一批动静只入账一条
>    notice——否则缓冲持续满员期间每次 say 边沿都重复入账刷屏；consumeHear 随缓冲重置。
> 2. **回合结束复检升级为全屋级**（recheckHear）：原稿只复检回合角色自己；但「队列忙
>    跳过唤醒」的受害方常是别的角色（如接话链里的小玖，被攒满的是厨房的墨璃），
>    只查自己会漏。每次回合结束查全员，边沿语义不变（每次唤醒都消费缓冲，无死循环）。
> 3. **T2/T3 唤醒用 force 入队**（队列忙也排）：状态翻转是一次性事件（notifiedAt
>    按轮次确认），「队列忙跳过」= 唤醒永久丢失（tick 不重检状态）；量级每片个位数，
>    排队代价可控。「忙则跳过」只保留给 T1（有 say 边沿+全屋复检双兜底，跳过不丢）。
> 4. **notice 服务接口 + tick 诊断接口**（ctx.catnest 新增 notice/tick）：测试与观察期
>    手动触发心跳需要；正常节奏仍由 60s 定时器驱动。
> 另修一处上个 session 遗留 bug：transcript() 把 log 行 text 覆写为人话渲染（notice
> 无渲染→空串、原文挪 rawText），timelineText 的 notice 分支原读 l.text → 触发句渲染
> 为空；改读 rawText。测试：lib 新增 3 例（consumeHear 重置/clearActivity 静默/notice
> 私有默认）、index 新增 4 例（notice 链路私隐/公共、T1 门控桩验忙跳过+防刷屏+回合后
> 未重满不再醒、T2 手动 tick 翻转+notifiedAt 一次性、T3 到期清除+公共 notice 他人可见）。
> 上游依据：`猫窝改造-20260826讨论定案汇总.md` 挂起项「调度层」（#12 不设菜单 / #13 沉默合法）、
> `AGENT_LOOP_DESIGN.md` 交付记录 7 遗留（方向一另文排期）。
> 前置已完成：工具循环（say/move_to/do_activity/remember/set_condition/adjust_relation）、
> 沉默语义（未调 say 即沉默）、hear 缓冲物理层、conditions 生命周期、activity 冻结/解冻。

## v1 拍板记录（2026-08-31）

1. **notice 可见性二档**（对齐现有「一本账、读时按人解析」）：`private` 默认（只进本人
   时间线，渲染「【你注意到】+text」）；公共是例外（全家时间线，text 原样）。
   声音的三档传播（clear/faint/无）仍归 say 的 audience，notice 无距离衰减不沿用。
2. **T1 改判私有**（原稿公共）：动静是她的耳朵、她的感知；她若起身，move 自己进时间线，
   叙事自动接上。T3「做完了事」是唯一公共（客观家庭事实，先例=master-move）。
3. **【最近听到的】段**：hear 缓冲是状态不是事件——不进账本渲染，进 user 尾部动态窗口
   （与位置/关系/身体状态并列），**每回合可见**，任何触发（T1/T2/T3/masterSay）都带。
   notice 正文只留指针（「见【最近听到的】」），台词内容不誊进家庭时间线。
4. **缓冲清空=回合开始时**（consumeHear 弹出）：一次唤醒=一次决策；回合中新动静攒新鲜
   缓冲，防同一批动静反复拍醒（死循环）。回合结束复检：缓冲又满→再唤醒（边沿触发，
   无 tick 回扫）。
5. **T1 检测在 say 时刻**（say 返回值 hearReady 边沿触发）+ 回合结束复检；tick 不查缓冲。
6. **T2 检测=一次性翻转**：condition 加 `notifiedAt`（已确认的开始时间戳，按轮次）；
   立即挂的状态（startsInDays=0，多为角色自设）创建时即自确认不唤醒；pending 跨 startAt
   由 advanceConditions 发 `start` 事件（tickConditions 顺带 log condition 行）。
7. **tickConditions 唯一推进者=调度 tick**（从 stateView 移除）：状态推进只由 60s tick
   驱动，前端 CondBadge 本就用时间戳本地推导相位，不依赖快照频率。
8. 六件拍板事全部按小玖默认：tick 60s / T3 公共 / T4 v1 不唤醒只入账（master-move 本就
   已落地）/ T5 阈值 v2（候选 10 分钟）/ 夜间成本事件驱动可控 / 串行队列+in-flight 跳过。

---

## 0. 一句话目标

现在的家只有一个活性触发源：主人在同房说话。目标是把「家的心跳」补上——
**时间驱动只推状态（零成本），事件驱动才叫醒 LLM（付费、低频）**，
让不在同房的角色也能被「动静」唤醒，用完整工具面自由应对。

## 1. 核心原则

1. **心跳是状态机，不是 LLM。** 云端模型按次付费，每分钟全员问一遍不划算；
   `tickConditions` / activity 到期 / hear 缓冲推进都是纯状态机，零成本，可以常开。
2. **广播事件＋各自决定（定案 #13）。** host 只把事件行递进时间线，不预置
   「加入/搭腔/无视」菜单；角色拿完整工具面自己决定说话/移动/沉默。
3. **每次唤醒的感知与主人同源。** 触发以「事件行」入账（新事件类型 `notice`），
   进该角色的片内时间线、成为末行触发句——与 masterSay 的「末行即触发句」同构。
   账本仍是唯一事实源，没有旁路状态。
4. **事件不强制唤醒，只保证「下一次醒着时看得见」。** 事件行永远入账；
   若角色正在回合中（in-flight），跳过本次唤醒，新事件留待下轮自然可见。

## 2. 两层架构

### 2.1 时驱动层（免费，常开，片内运行）

- 60s 周期 tick（`setInterval` + unref，`ctx.effect` 卸载；重启不补跑；只在打开的片内跑）。
- tick 只做两件事，**有变更才写盘**：
  1. `advanceConditions`（经 tickConditions）：pending→active 翻转（`start` 事件，notifiedAt
     一次性确认）、expired 移除、cycleDays 续轮。tickConditions 从 stateView 迁入 tick，
     成为状态推进唯一驱动；
  2. activity 到期：`activityEndsAt` 过期 → 静默清 activity（`clearActivity`，不落 activity
     行）+「做完了事」公共 notice（事实由 notice 承载，防蒸馏重复）。
- hear 缓冲**不在 tick 查**：T1 在 say 时刻边沿触发（say 返回 hearReady）+ 回合结束复检。
- tick **不叫 LLM**。

### 2.2 事件驱动层（付费，按需）

- 唤醒动作 = 现有 `agentTurn(charId)`，不新写回合逻辑。
- 唤醒前先入账 `notice` 事件（见 §3 事件行设计）。
- 串行控制：
  - 每角色一个 in-flight 标记（同一角色不叠加唤醒）；
  - 全局一个串行队列（v1 不做并行 LLM，账本写操作本就 chain 串行，先简单）；
  - 队头角色若正在 masterSay 接话链里 → 跳过本次唤醒（事件已入账，下轮可见）。
- 护栏：沿用 MAX_STEPS=4 / 步软超时 / 总超时；llm 缺席 → 跳过不报错
  （事件已入账不丢，前端不广播 replyError，避免夜间无人在场时噪音）。

## 3. 事件行设计（`notice`）

- log 行：`{ type: 'notice', char, source, text, private }`
  - `char`：被唤醒的角色；`source`：动静来源（角色 id / 'master' / 'body' 自身生理）；
  - `text`：事件行的人话（直接给模型看的那句话），按家庭口吻写（「小玖做完了事」）；
  - `private: true`（**默认**）：只进该角色自己的时间线（感知/生理类）；
    `false`（例外，仅 T3）：全员时间线可见（客观家庭事实，先例=master-move）。
- `timelineText` 渲染（与 say 的 audience 解析同构：一本账，读时按人）：
  - 自己的 notice（private 与公共）：`【你注意到】` + text（触发句；第三人称指自己可接受）；
  - 他人的公共 notice：text 原样（如「小玖做完了事」）；
  - 他人的 private notice：不渲染。
- `dialogueView` 不渲染 notice（对话流只进 say）——v1 保持对话流纯净。
- `sliceEventsText` 渲染 notice（蒸馏可见，「墨璃被发情期叫醒」是家史的一部分）：
  公共=text 原样；私有=`{char}注意到：{text}`。
- hear 缓冲条目、master-move 等旧事件不动。
- **hear 缓冲内容不进账本渲染**：它是状态（会攒会清），进 user 尾部动态窗口
  「【最近听到的（隔墙动静）】」段，每回合可见；notice 正文只留指针，
  台词内容不誊进家庭时间线。

## 4. 触发源清单（五源，分批）

| # | 触发 | notice 文案（示例） | 唤醒 | private | 批次 |
|---|------|------|------|------|------|
| T1 | hear 缓冲攒满（相邻动静达阈值） | 「隔壁{room}传来{source}的动静，已经几次了（见【最近听到的】）」 | 缓冲满的角色 | **true**（v1 拍板改私有） | 主线 |
| T2 | conditions pending→active（发情开始/生病开始） | 「你感觉到身体变了：{状态}开始了（还剩{时长}）」 | 角色自己 | true | 主线 |
| T3 | activity 到期（做完了事） | 「{char}做完了{activity}」 | 该角色自己 | false | 主线 |
| T4 | 主人移动房间（master-move） | 「主人从{from}挪去了{to}」 | 新房间同房角色 + 相邻？ | false | v2（默认不唤醒，只入账） |
| T5 | ambient 兜底（主人与家都安静过久） | 「家里很安静，你闲下来了」 | 轮值一个角色 | true（说给轮值那只猫的） | v2（前四源稳定后） |

- T1 换血：`resolveHear` 的旧手工决策链（shout/ignore 菜单）退役——缓冲满 → 自动
  notice → agentTurn；`hear-ignore` 事件保留给「角色在回合里主动无视」（沉默即无视，
  可不落事件，v1 不落）。服务接口 `resolveHear` 留兼容壳不动。
- T1 检测时机（边沿触发）：say 入账时 `hearReady` 满 → 立即 tryWake；角色在回合中则
  跳过（turningChars），**回合结束后复检**缓冲，又满再唤醒。tick 不查缓冲（免 60s
  粒度回扫，也免 in-flight 期间每 tick 重发 notice 的刷屏）。
- T2 检测=一次性翻转：`notifiedAt` 按轮次确认（续轮后 startAt 前移，下一轮再触发）；
  立即挂的状态（startsInDays=0）创建时即自确认（多为角色自设，无需叫醒自己）。
- 缓冲消费：`consumeHear` 在 agentTurn 开始时弹出（一次唤醒=一次决策），内容进本回合
  【最近听到的】段；回合中新动静攒新鲜缓冲。
- T4 的默认形态：master-move 本就已人话化进时间线（「主人从客厅挪去了卧室」），
  不唤醒 = 角色在下次被问到时自然知道主人去过哪。v2 再议是否叫醒。
- T5 的预算形态：每片每角色至多一次 ambient 唤醒（防刷），触发条件 = 片内
  超过 N 分钟无任何 say/notice 事件。

## 5. 不动清单

- masterSay 同房串行语义（依次、后者可见前者）、audience 三档传播、say 的 action 视觉/听觉切分
  （交付记录 7）；实现上接话链改走全局串行队列（与唤醒共用，防并行 LLM），语义不变；
- 打字机与 SSE 事件契约（delta*/settle/replyError/reaction）——唤醒全程复用，零新事件 kind；
- hear 阈值数值（home.json 可调，现状 kyu3/moli5）；
- 时间片语义：模式外家静止（tick 只在打开的片内跑，close 时停）。

## 6. 实现切片（每片独立可验收）

1. **tick 地基**：60s interval + tickConditions 迁入 + activity 到期清除 +
   `notice` 事件类型全链路（入账/时间线渲染/蒸馏/私有过滤）+ 测试。
2. **T2 接线**：pending→active → private notice → agentTurn（交付记录 5 遗留收口）。
3. **T1 接线**：hear 满 → notice → agentTurn；resolveHear 退役（服务接口保留兼容壳）。
4. **T3 接线**：activity 到期 → 公共 notice → 本人 agentTurn。
5. **观察期**：跑一天片，翻 log.jsonl 看事件频率/token 消耗/沉默率，
   再定 T4/T5 与「每角色每片沉默配额」（若话太多）。

## 7. 风险与拍板（2026-08-31 全部按小玖默认拍板）

| # | 事项 | 小玖倾向 |
|---|------|------|
| 1 | tick 周期 | 60s（前端倒计时本已本地重算，60s 足够；状态推进精度不受影响，phase 由时间戳推导） |
| 2 | T3「做完了事」是否全家可见 | 可见（public）——家庭叙事的一部分，且是别人搭话的自然触发 |
| 3 | T4 是否唤醒 | v1 不唤醒，只入账 |
| 4 | T5 触发阈值（安静多久） | v2 再定，候选 10 分钟 |
| 5 | 夜间 LLM 成本 | T1–T3 全部事件驱动，量级＝每片个位数次，可控；观察期兜底 |
| 6 | 唤醒与 masterSay 接话链撞车 | 全局串行队列 + in-flight 跳过（§2.2），语义＝「她正在忙，这事下轮再说」 |
