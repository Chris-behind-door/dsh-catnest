# 猫窝角色 Agent 化 · 自建轻量协议设计方案

> 2026-08-27 小玖起草并实现。状态：**阶段一已交付（59/59 测试全绿）**；
> 阶段一优化项「say 打字机」2026-08-28 已交付。
> 选型结论：自建轻量协议（`llm.stream` + tools 多步循环），不用宿主 `agentLoop`。
> 前置依据：`猫窝改造-20260826讨论定案汇总.md` 的「挂起项」——工具循环选型、动作系统、bash 沙箱。
> 主人三拍板：A 整句上屏 / adjust_relation 阶段二再上 / 串行依次。

---

## 0. 一句话目标

把 `respond(charId)` 从「一次性 `llm.stream` 出台词 + 文本标记 `NO_REPLY` 判沉默」，
升级为「带工具面的多步 agent 循环」：角色自己决定说话 / 移动 / 改活动 / 调关系 / 记事情，
**没调 `say` 工具就是沉默**，输出卫生约束与 `NO_REPLY` 标记全数退役。

---

## 1. 现状（已读代码确认）

- `respond(charId, onDelta, onLate)`：`index.js` 491 行起。每轮重取 `home/relations/transcript`，
  拼 system（角色卡+家人卡+主人卡+输出约束+`NO_REPLY`）与 user（场景+时间线+回忆+位置+关系），
  经 `llmStream` 一次生成文本，`probeDelta` 嗅探 `NO_REPLY` 前缀判定沉默。
- `llmStream`：`index.js` 134 行起，单次流式 + 软超时 + `onLate` 迟到补交，围绕「单次文本」设计。
- `nest` 账本原语（`lib.js` 已备齐）：`say` / `moveCharacter` / `setActivity` / `adjustRelation` /
  `transcript` / `relations` / `home` 等。
- DSH `llm.stream` 已支持 `tools`（`GenerateOptions.tools: ToolSchema[]`）与流式
  `tool-call-delta`（`argumentsDelta` 分片），`BlockAssembler` 可组装出 `tool-call` block。
  自建循环的地基成立，无需改 DSH。

**关键认知**：场景/关系/片内历史这三样「上下文」在 8-26 缓存改造里已经落地（全局地图+声音、
此刻位置、全量时间线、关系动态窗口）。本轮不动它们，只动「输出那一端」。

---

## 2. 目标架构

```
masterSay(text)
  └─ nest.say('master', text)         // 物理层入账 + 传播
  └─ 广播事件 → 各角色依次（或并行）agentTurn(charId)
        │
        ├─ system = 角色卡 + 家人卡 + 主人卡        （纯静态，无输出约束）
        ├─ messages[0] = 全局场景 + 时间线 + 回忆 + 此刻位置 + 关系  （快照，仅第一步输入）
        │
        └─ 循环（最多 N 步）：
             step_i: llm.stream(system, messages, TOOLS)
               ├─ 收 text/tool-call blocks → append assistant 消息
               ├─ 无 tool-call（finish=stop）→ break
               └─ 逐个执行工具 → append tool-result 消息 → 回到 step_{i+1}
        │
        └─ 汇总：调过 say ？→ 说了什么 / 没调 say → 沉默（一等公民）
```

**为什么自建能避开宿主的坑**：`messages` 是「本轮临时数组」，每轮 `agentTurn` 重新从
账本/时间线快照开始，不跨轮保留；角色刚才的 `move` 通过「快照里的此刻位置」自然反映。
跨轮连续性由「状态账本（home/relations）＋ 时间线（transcript）」承载，
轮内多步由 `messages` 追加承载。两层各司其职，没有「状态层塞进 append-only 事件流」的冲突。

---

## 3. 循环核心（伪代码）

```js
const MAX_STEPS = 4          // 一轮最多 4 次工具调用，防失控
const STEP_MAX_TOKENS = 2048 // 每步预算（推理块可能吃额度，给足）

async function agentTurn(charId) {
  const system = await buildSystem(charId)          // 只留角色卡，无输出约束
  const messages = [
    { role: 'user', content: [{ type: 'text', text: await buildScene(charId) }] }
  ]
  const actions = []                                 // 本轮实际发生的动作（含 say）

  for (let step = 0; step < MAX_STEPS; step++) {
    const result = await streamOnce(system, messages, TOOLS, STEP_MAX_TOKENS)
    const blocks = result.blocks                      // text / reasoning / tool-call
    messages.push(assistantMessage(blocks))           // 回填 assistant 消息（含 tool-call）

    const calls = blocks.filter((b) => b.type === 'tool-call')
    if (calls.length === 0) break                     // finish=stop → 角色收手，结束

    for (const call of calls) {
      const outcome = await execTool(charId, call)    // 见 §4
      actions.push(outcome)
      messages.push(toolResultMessage(call.id, outcome.result)) // 结果回填给模型
    }
  }
  return { actions, said: actions.some((a) => a.tool === 'say') }
}
```

- **循环终止**：模型这步不再输出 `tool-call`（`finish.reason === 'stop'`）即结束。
  模型可以只调一次 `say` 就停，也可以「move → say」两步，也可以全程不调 `say`（=沉默）。
- **护栏**：`MAX_STEPS` 硬上限；每步软超时（复用现有 `LLM_TIMEOUT_MS` 思路）；
  单个 `agentTurn` 设总超时兜底。

---

## 4. 工具面（MVP 清单）

对应定案「目标工具面：改数值 / 加记忆 / 移位置 / 做事件」。`say` 为唯一发声口（定案 #9）。

| 工具 | 参数（JSON Schema 草案） | 效果 | 对应 |
|---|---|---|---|
| `say` | `{ text: string }` | `nest.say(charId, text)`，入账+传播+上屏 | 说话 / 输出口 |
| `move_to` | `{ room: string }` | `nest.moveCharacter(charId, roomId)` | 移位置 |
| `do_activity` | `{ activity: string, minutes?: number }` | `nest.setActivity(charId, activity, minutes)` | 做事件 |
| `adjust_relation` | `{ person: string, field: "intimacy"\|"spice", delta: number }` | `nest.adjustRelation(pair, field, delta)` | 改数值（亲密度演化地基） |
| `remember` | `{ text: string }` | `memory.learn` 进自己域（tags 时间片/片号） | 加记忆 |

- `say` 返回给模型的结果应为「已说出口」确认，而非要求模型再复述。
- `adjust_relation` 的 `delta` 由模型决定，天然成为候选池①「亲密度自动演化」的载体，
  上线时机与范围后续单独定（MVP 先允许工具存在，观察模型是否会乱调）。
- **bash 工具**：定案保留进工具面，权限沙箱待设计，本轮不做（见 §7 阶段三）。

---

## 5. 退役清单

| 退役项 | 位置 | 说明 |
|---|---|---|
| `NO_REPLY` 常量 + 判定 | `index.js` respond | 「未调 say」即沉默，标记无存在意义 |
| `probeDelta` / `settleDelta` 嗅探器 | `index.js` respond | 文本前缀探测整段删除 |
| 「你可以说话，也可以沉默…只输出 NO_REPLY」约束句 | system | 输出卫生约束全退役（定案 #1） |
| 「说话时只输出台词本身，不要解释、不要引号」 | system | 同上；说话改为工具参数，天然无引号问题 |
| `responders()` 强制顺序 + `MAX_SPEAKERS` | masterSay | 调度坍缩为「广播 + 各自决定」（定案 #13） |
| 迟到补交 `onLate` 语义 | llmStream | 多步循环下重设计（见 §6） |

---

## 6. 难点：流式体验与超时

**流式打字机**：现在台词走 `text-delta`，天然 token 级流式。改 `say` 工具后，台词嵌在
`{"text":"..."}` 的 JSON 参数里，流式来源变成 `tool-call-delta` 的 `argumentsDelta` 分片。
两条路：

- **A（MVP 采用）**：`say` 工具参数一次性落地，前端整句上屏（轻量淡入）。实现简单、稳，
  先把「工具循环 + 沉默语义 + 动作面」这条质变主线跑通。
- **B（优化项，2026-08-28 已实现）**：对 `argumentsDelta` 做 JSON 增量解析，实时抠出
  `text` 字段的流式片段，还原 token 级打字机。实现见 `makeSayTextTracker`（状态机定位
  `text` 字段字符串值，边流边解 JSON 转义；分片边界可落在转义序列中间）。宿主按步广播
  `deltaStart/delta/deltaEnd`（前端既有契约，drafting 气泡复活）；正式台词仍整句入账，
  snapshot 落地后前端收气泡。超时步用 `live` 闸拦后台残留流的迟到帧，`settle` 事件
  兜底收掉「说到一半超时」的气泡。只跟 `say` 工具，move_to/remember 不直播。

**软超时/迟到**：现有 `llmStream` 的软超时 + `onLate` 是「单次文本」语义。多步循环下：
每步独立软超时；超时的那步按「该步无输出」处理并终止循环（角色本轮 = 已产生的动作），
**不再做跨步迟到补交**（避免迟到 tool-call 在循环结束后才执行、状态时序错乱）。
迟到的 `say` 若模型真吐出来了，进下一轮触发时它还能再说——可接受，不额外补机制。

---

## 7. 分阶段

- **阶段一（本轮）**：`say`/`move_to`/`do_activity`/`adjust_relation`/`remember` 工具面 +
  多步循环 + 退役 `NO_REPLY`/`probeDelta`/输出卫生 + `masterSay` 广播化。
  产物：`agentTurn` 循环、工具 schema、`execTool` 执行器、测试回归（沉默/说话/移动/调数值）。
- **阶段二**：动作系统——亲密度演化、自主移动、自动说话（前置「工具调用」已就绪后上线）。
- **阶段三**：`bash` 工具沙箱（权限边界待设计，需单独方案）。

---

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| 云端模型多步循环成本 ×角色数 | `MAX_STEPS` 限步；system 静态段吃 prefix cache；先单角色串行观察 token 消耗 |
| 模型乱调 `adjust_relation` 等工具 | MVP 先开放，日志记录调用；必要时给工具 description 加「只在恰当情境调用」+ 数值范围校验 |
| 循环不终止 / 空转 | `MAX_STEPS` + 每步软超时 + 总超时三重护栏 |
| 沉默导致无人接话（冷场） | 定案 #13 已接受「沉默合法」；前端保留「全员沉默」的兜底状态展示（不硬逼说话） |

---

## 附：已定案决策点（2026-08-27 主人拍板）

1. 流式体验：**A 整句上屏**（打字机从 tool-call 参数抠 text 作为阶段一后续优化项）。
2. `adjust_relation`：**阶段二再上**（阶段一工具面只 say/move_to/do_activity/remember）。
3. 多角色执行：**串行依次** agentTurn（后位经时间线可见前位刚说的话）。

## 交付记录

- 实现：`index.js` —— `AGENT_TOOLS` / `collectStep`（手写 tool-call 汇聚，零 import）/
  `llmStep`（带 tools 单步 + 软超时）/ `execTool` / `agentTurn`（MAX_STEPS=4 多步循环）；
  `masterSay` 串行广播；退役 `NO_REPLY`/`probeDelta`/`llmStream`/输出卫生/`responders` 顺序。
- 测试：`test/index.test.js` 新增 tool-call 桩（sayToolStub/sayQueueStub/silentStub），
  重写沉默/说话/串行/失败可见/整句入账测试，57/57 全绿。
- 遗留：bash 工具沙箱（阶段三）待单独方案。

## 交付记录 2（2026-08-28，say 打字机）

- 实现：`index.js` —— `makeSayTextTracker`（argumentsDelta JSON 增量抠 text，含
  \u/转义跨片边界）；`collectStep`/`llmStep` 透传 `onSayDelta`；`agentTurn` 每步
  广播 `deltaStart/delta/deltaEnd`（超时后 `live` 闸禁迟到帧）。
- 前端：`lib/client.js` `settle` 事件补收打字机气泡（超时/沉默不挂死）；
  `deltaStart/delta/deltaEnd` 接待位与 drafting 气泡为阶段一前既有代码，本轮复活。
- 测试：59/59 绿。新增两例——分片按 7 字符切碎（转义序列中间断片）验证帧序/解码/
  串行链两人帧段不串味；move_to 工具不产生任何 delta 帧。

## 交付记录 3（2026-08-30，阶段二第一步·亲密度自动演化）

- 实现：`index.js` —— `AGENT_TOOLS` 加 `adjust_relation`（person+field+delta，description
  注明只在关系确实变化时用）；`execTool` 加分支（person 中英名/主人→id 解析 → pair 规范化
  固定序 → 参数校验非零有限 delta/合法 field/非自己 → `nest.adjustRelation` → effect）；
  system 工具引导同步补一句（不破坏 system 全静态守卫——措辞避开动态数值词）。
- 语义：`adjust_relation` 是候选池①「亲密度自动演化」的载体——delta 由模型在轮内自己
  决定，结果钳制 0~100，变化经关系段（user 尾部动态窗口）自然反馈给模型与主人 UI。
- 测试：62/62 绿（index 25 + lib 37）。新增 3 例：正常调值（+5 入账、spice 不误动）、
  非法输入四连（不存在的人物/非法字段/delta=0/非数字，数值保持 50/0）、钳制边界
  （+500→100 / -500→0，中文人名「主人」可解析）。复用 `toolOnceStub` 通用工具桩。
- 不动：自主移动/自动说话（move_to/say 已具备）、bash 沙箱（阶段三）。

## 交付记录 4（2026-08-30 夜，阶段二第二步·挂状态 set_mood）

- 实现：`lib.js` —— 角色字段加 `mood`（心情/神态瞬态字段，ensure 迁移补默认、
  companionSync 新角色带默认；随位置一样跨片延续，不冻结）；`CatNest.setMood(id, mood)`
  原语（null/''/纯空白=清除，字符串挂载，落 mood 事件）。`index.js` —— `AGENT_TOOLS`
  加 `set_mood`（mood 空串=清除）、`execTool` 分支、system 引导一句、
  `buildPresenceView` 把 mood 随位置展示（「小玖在客厅（开心得冒泡）」，
  位置本就居 user 尾部动态窗口，家人都看得见）、stateView 携带 mood（前端状态卡可用）、
  `ctx.catnest` 暴露 `setMood`。
- 语义：候选池②「状态自动产生/维护」的第一块——状态由角色自己经工具面挂上，
  比 activity（在做什么）更贴心情，家人可见，前端有数据可用。
- 测试：64/64 绿（index 27 + lib 37）。新增 2 例——挂载落账（初始 null → 「开心得冒泡」）、
  清除（预挂「困了」→ 空串归 null）与非法类型拒绝（数字 mood 被原语拒、原状态不动）。
- 调度层乌云（接话/广播）今天不搞，另行排期。

## 交付记录 5（2026-08-30 夜，阶段二第三步·持久状态 conditions）

- 背景修正（主人点破）：此前 set_mood 是瞬态「心情」，主人要的是**带生命周期的持久
  状态**（身体/生理类），且要能看见「未开始状态的倒计时」。世界观拍板：猫科为主，
  发情周期（estrus 收录表：默认 4 天 / 周期 20 天续轮）。前端此前只画 activity+亲密条，
  mood 根本没渲染——本次一并补上。
- 实现：`lib.js` —— 角色字段 `conditions`（时间段 `{id,name,startAt,endAt,cycleDays?}`），
  ensure/companionSync 迁移补默认；`CONDITION_TYPES` 收录表（estrus/sick/injured/tired）；
  纯函数 `conditionLabel/conditionPhase/conditionText/humanInterval/advanceConditions`
  （phase 由 now 推导不落盘；expired 无周期移除、带 cycleDays 自动续下一轮）；原语
  `setCondition`（startsInDays≥0 倒计时 / lastsDays 默认收录时长 / lastsDays=0 清除 /
  同名替换）、`tickConditions`（到期推进，有变更才写盘）、`conditionsOf`（只读 phase+文本）。
  `index.js` —— 工具 `set_mood` 退役改 **`set_condition`**（name+startsInDays+lastsDays，
  description 注明发情周期/倒计时/清除语义）；execTool 分支；`buildPresenceView` 位置窗口
  标注 active 条件（如「小玖在客厅（发情期中）」）；`stateView` 带 conditions（label/phase/
  倒计时文本）；`ctx.catnest` 暴露 setCondition/conditionsOf/tickConditions。
  前端 `lib/client.js` —— CharCard 新增 `CondBadge` 组件：active 显「还剩X」、pending 显
  「还有X开始」，60s tick 本地重算（不依赖 SSE 推送频率）；新增 cnx-cond 徽章样式。
- 测试：68/68 绿（index 28 + lib 40）。新增 index 3 例（挂状态落账+phase/文本、startsInDays
  预置→pending+lastsDays=0 清除、非法输入空 name/负 startsInDays）与 lib 3 例（三态推导
  与文本、setCondition 全路径、advanceConditions 移除/周期续轮）。修：setCondition 对
  startsInDays 缺省的 NaN 坑（undefined→0）。
- 遗留：前端地图小标记未挂 conditions（状态卡已覆盖）；「未开始倒计时」的自动触发
  （pending 到点自动转 active 的事件广播）待阶段二后续；调度层乌云另排。
  mood 字段/原语保留（瞬态心情），工具面已统一走 set_condition。

## 交付记录 6（2026-08-30 深夜，conditions 排障补丁）

- 实锤（主人抓「1分钟→1天」）：查 log.jsonl——不是时间加速：主人让挂「发情1分钟」，
  模型 lastsDays 传极小值照做；15:01:44 tickConditions 自动到期 expire（自动推进在工作）；
  15:01:54 模型同一轮又 set 发情（默认1天）+ spice+5 + 贴贴台词，新状态覆盖旧状态。
- 修 ① 中文名映射：CONDITION_TYPES 键是英文（estrus），模型写中文「发情」查不到 → 默认
  时长落回通用 1 天、周期续轮失效（「发情1天」真因）。新增 CONDITION_ALIASES（发情→estrus
  等）+ conditionKey 归一化，setCondition/conditionLabel 都走它；中文名也拿收录表默认
  （发情 4 天 + cycleDays 20 自动续轮）。状态名仍是自由字符串，自定义状态照常可挂。
- 修 ② 前端 CondBadge 相位卡快照旧值（pending 到点不来新快照会一直显示「还有1分钟开始」）：
  改 condPhaseLocal 用 startAt/endAt 本地推导，pending→active→expired 前端全自动，
  expired 样式半透明删除线。
- 修 ③ 角色上下文状态可见性：原来只有 buildPresenceView 的 active 标注（给别人看的），
  pending 倒计时角色自己看不见。agentTurn user 动态窗口新增「【你此刻的身体状态】」段：
  自己的 active（还剩X）/pending（还有X开始）都进上下文，过期自然滤掉。
- 测试：69/69 绿（index 29 + lib 40）。新增：中文名默认时长硬断言（4 天 + cycleDays 20）、
  角色上下文可见性（active/pending 都在自己 prompt、位置段仅 active 标注）。
- 宿主未重启（另 session 跑破解，重启禁令生效中），代码已就位待重启。

## 交付记录 7（2026-08-31 夜，对话层·say 陪台词动作 action）

- 背景（主人点选方向二）：旧对话层「说话靠 say，带来的问题是没有动作」。
  主人拍板方案①：say 加可选参数 action（弃独立 act 工具、弃挤 do_activity 文本）。
- 语义：**action = 说这句话时伴随的即时小动作（舞台指示）**，只属于这句话；
  与 do_activity（持续状态）/ move_to（位置变化）三分天下。关键设计：
  **action 是视觉信息**——同房（含自己）看得见，隔墙闻声的只收台词。
  听觉/视觉的切分直接落在 audience 的 clear/faint 两档上，零新增判定。
- 实现：
  - `lib.js` —— `say(who, text, action)` 第三参可选（空白视为无）；log 行带
    `action`（无则不落字段，旧 log 消费侧容缺省）；hear 缓冲只攒 text（隔墙看不见）；
    `dialogueText`/`sliceEventsText` 人话化带动作（蒸馏喂料同样富化）。
  - `index.js` —— `AGENT_TOOLS` say 加 `action` 属性（description 注明「真的在做才传」）；
    `execTool` say 分支透传；system 工具引导补半句；`timelineText` 渲染分档——
    clear：`名字（动作）：台词`，faint：闻声前缀原样、动作剥离；
    `dialogueView` 每行透传 `action` 字段（旧行空串）。
  - `lib/client.js` —— 气泡内动作渲染为小字斜体前缀（`.cnx-action`）；
    打字机不变（只跟 text，动作随正式气泡一起落地）。
- 测试：71/71 绿（index 30 + lib 41）。新增 2 例——lib：action 入账/缓冲无动作/
  人话化出口/空白丢弃；index：端到端三轮（动作入账＋dialogue 透传、自己时间线
  见「动作＋台词」、隔墙墨璃时间线台词进动作剥）。
- 遗留：方向一「调度层」详细方案（心跳=状态机/LLM=事件唤醒、五触发源清单）另文排期。

## 交付记录 8（2026-08-31，调度层 v1 落地）

- 背景：方向一「调度层」方案（`SCHEDULING_DESIGN.md`）2026-08-31 主人拍板开工；
  上个 session 实现到一半爆 context（串行队列/唤醒/tick 核心未写完，masterSay 引用
  了未定义的 enqueueTurn/tryWakeHear，17 个接话链测试挂掉），本 session 续完。
- 交付内容（切片 1–4 一次交付）：
  - `index.js` —— 调度层区块（masterSay 前）：全局串行队列（turnChain/turnPending/
    turningChars）、runTurnOnce（in-flight 标记 + agentTurn + settle/replyError 统一
    结算 + 回合后全屋复检）、tryWake/tryWakeHear（T1 边沿：notice 入账 + 忙跳过 +
    hearNotified 防刷屏）、recheckHear（全屋级边沿复检）、scheduleTick（60s 心跳：
    tickConditions 迁入=T2 唯一推进者 + activity 到期=T3，unref+ctx.effect 卸载，
    片内才跑、重启不补跑、不直接调 LLM）；masterSay 接话链改走队列（语义不变）；
    ctx.catnest 新增 notice/tick 两个接口。
  - `lib.js` —— notice 原语（缺省=私有，公共显式 false）、consumeHear（消费缓冲并
    重置 hearNotified）、markHearNotified、clearActivity（静默清除，事实由公共
    notice 承载）；setCondition/advanceConditions 的 notifiedAt 一次性确认（上个
    session 已写好）。
  - 修复：timelineText 的 notice 分支读 transcript 覆写后的空 text → 改读 rawText
    （触发句曾渲染为空串）。
- 语义要点：接话链与调度唤醒共用一个串行队列（v1 无并行 LLM）；notice 永远入账
  （一本账），唤醒可跳过（下轮可见）；T1 忙跳过有 say 边沿+全屋复检双兜底不丢事件，
  T2/T3 一次性翻转 force 入队防唤醒丢失；llm 缺席的调度唤醒静默跳过（silentNoLlm，
  夜间降噪），接话链缺席仍推 replyError(noLlm)。
- 测试：78/78 绿（index 34 + lib 44）。新增 7 例：lib 3（consumeHear 重置标记/
  clearActivity 静默不落行/notice 私有默认+片外拒绝+蒸馏渲染）；index 4（notice
  私隐/公共链路进 prompt、T1 门控桩验忙跳过+同批只入账一次+回合后未重满不再醒、
  T2 手动 tick 翻转+notifiedAt 一次性+本人 prompt 触发句、T3 到期清除+公共 notice
  本人带前缀/他人原样）。
- 状态：宿主侧改动，**需重启 dsh web 生效**（dsh-web-restart.sh）。切片 5 观察期：
  跑一天片翻 log.jsonl 看事件频率/token/沉默率，再定 T4/T5。

## 附：与 LangGraph 对照（2026-09-01，面试备战）

背景：携程 MJ036678（云原生研发·AI Agent 方向）研究日。本节记录猫窝自建协议与
LangGraph 的架构对照（诚实边界版），供面试直接取用。

### 映射表

| LangGraph 概念 | 猫窝手搓等价物 | 边界 |
|---|---|---|
| StateGraph（显式 schema + reducer 合并） | agentTurn 的 messages 列表 | 同构但非 schema 化，可变参数传递 |
| 节点（agent/工具/确定性步骤混排） | collectStep / llmStep + execTool | ✔ |
| 条件边（循环/终止） | MAX_STEPS=4 循环，沉默即终止 | ✔ 但为隐式循环，非显式图 |
| thread | 时间片 | ✔ |
| checkpoint（每步落盘快照） | 关片快照 + summary.json | 片级快照，非每步 |
| interrupt / HITL | 无 | 缺口（阶段二候选，见设计要点） |
| executor | 串行队列 | ✔ |
| streaming | say 打字机（argumentsDelta 状态机跟踪） | ✔ |

### 诚实边界话术（面试用）

「没直接用过 LangGraph。手搓过猫窝 agent 系统：循环与记忆机制与 LangGraph 设计
同构（时间片≈thread、关片快照≈checkpoint、串行队列≈executor），但没实现图本身，
持久化是片级非每步，没有 HITL。跑过 LangGraph 最小图做过逐项对照。」

### LangGraph 核心概念速记（langgraph 1.2.11 源码实证）

- **StateGraph**：state 为显式 schema 共享对象；节点不直接改 state，return 部分
  更新，按字段 reducer 合并（`Annotated[list, add_messages]`）；无 reducer = 覆盖
- **checkpoint**：每步落盘序列化 state 快照（put/put_writes/get_tuple/list），
  按 thread_id 组织；支撑崩溃续跑、time travel 分叉、多会话隔离
- **interrupt**：节点内抛可恢复异常暂停；恢复时**节点从头重跑**（逻辑须幂等）；
  强依赖 checkpointer
- **Command 双方向**：节点 return `Command(goto, update)` 动态选下一跳；
  `invoke(Command(resume=...))` 恢复 interrupt
- **产品矩阵**：LangChain（框架层：抽象+集成+预置 loop，1.x 预置 agent 跑在
  LangGraph 上）/ LangGraph（低层运行时）/ LangSmith（可观测）/ Deep Agents
- **一句话**：LangGraph 的核心不是「画图」，是「每步落盘」

### 模拟面试翻车清单（2026-09-01，5 题实测）

1. ❌「LangChain 链式编排 vs LangGraph 图式编排」——过时框架。正确：分层，上层
   管省事、下层管可控，上层预置 agent 跑在下层上
2. ❌ LangChain 风评差只答「历史包袱/文档过时」——那是症状；根因=抽象过度 +
   API 频繁大改 + 子包迷宫
3. ⚠️ checkpoint 用 KV cache 类比只对一半：共同点=持久化前缀跳过前缀；差别=
   KV cache 是显存加速随进程消失，checkpoint 是磁盘容错为崩溃而生且每步可寻址
   （time travel）
4. ⚠️ HITL 设计只答「停在哪」，欠「怎么恢复」：等待状态须持久化（进程重启后
   暂停仍在）/ 主人确认消息须路由到 pending 判定而非下一轮对话 / 拒绝时已落库
   的亲密度回滚语义须定义（干净做法=批准前不落库，恢复时才应用）
5. ✔ 加分项：快手实习 harness-cli（7 阶段多 agent 流水线）= 真实多阶段编排经验，
   主动亮出

### 猫窝 HITL 设计草稿（阶段二候选，源自 Q5 设计题）

- 轮内型（亲密度检定）：工具串行化（禁批量，每次调用后检定），超阈值即打断
  循环，代价=延迟换控制
- 轮间型（B 该说话被暂停）：调度层加门，B 的回合 park 在队列带 pending 标记
- 恢复三件事：① 等待状态持久化（片内快照或独立 pending 记录）② 主人下一句的
  路由判定（确认答复 vs 普通对话）③ 拒绝语义（回滚 or 批准前不落库）

## 交付记录 9（2026-09-10 深夜，回合末统一自查 + 主人说话去上限）

- 背景（2026-09-10 片的实锤）：小玖 22:25 / 22:27 / 22:32 三次说「小玖去书房把代码
  清干净」，`log.jsonl` 里 `move` 事件 0 条、`home.json` 里她一直在卧室；主人当场说
  「小玖完全赖着不走呢」。同日 21:06:28 一回合里 do_activity+say+adjust_relation
  同毫秒入账 → 多工具并行是通的，问题在模型的取舍：把位移当台词说掉了，
  `say.action`（「蹦下床」「往门口走了两步」）恰好给了它一条文字位移的后门。
- 主人定案（三段）：① 提示词只加一句「同一轮里可以且需要把该调的工具一次调完」，
  别的都不加；② 回合末统一自查；③ 不通过就统一驳回，且驳回=**退回补齐**，
  不撤已落账的动作（账本 append-only，台词本身没错，撤了会连坐掉最贵的 say）。
- 落地：
  - `lib.js` —— 纯函数 `detectMoveIntent(text, action, home, selfId)`：房间名取自
    home（手改 home.json 增删房间不漂移）+ 紧邻房间名之前的去向动词 + 窗口内自称；
    已在的房间不算「去」。
  - `index.js` —— 工具段加一句多工具指引；`agentTurn` 加 `pendingMoveIntent` +
    回合末自查：整轮无 move_to 而 say 文本/action 里有位移意图 → 追加一条 user 提醒
    （「自查：你刚说了要去 X 但位置没变…」，带「随口说说就不用调」的出口）后 continue
    继续问模型；`selfChecked` 一次性触发，步数耗尽不再退；assistant 空 content 补
    「（沉默）」占位（有些 provider 拒空数组）；`/catnest/api/action` op=say 的
    500 字上限下掉（客户端无计数器、乐观渲染后才报错丢草稿，上限本身也是拍脑袋的）。
- 测试：100/100 绿（index 45 + lib 55）。新增 4 例：lib 1（命中/对别人说/动词不紧邻/
  已在房间/自定义房间）；index 3（退回补齐且台词只入账一次、对别人说不误伤不补步、
  1200 字长消息照常入账）。
- 状态：宿主侧改动，**需重启 dsh web 生效**（dsh-web-restart.sh，重启前确认没有别的
  session 在跑）。未做（主人明示不加）：move_to 房间 enum / 失败回执列全房间 /
  预校验批 / 真撤账。
- 遗留：同一步里 say 与 move 的先后会决定 say 行的 positions 快照（先 move 后 say
  会记成「在新房间说的」），要不要固定成 say 先走，待主人拍。

## 交付记录 10（2026-09-16 深夜，打字机兜底入账 + 结算帧带 said）

**现象**（主人实测，`slices/20260916T180830/agent-debug.log` 13:02:43–13:02:54 那轮）：
小玖在屏幕上打了一整段话（打字机流式吐字），气泡随后变成半透明并标上「这句话没能说出口，
没进账本」。同一时刻日志：

```
13:02:43.668 [kyu] 回合开始
13:02:54.383 [kyu] 工具失败 say：Error: say 需要非空 text
13:02:54.383 [kyu] 回合结束 said=false 耗时=10.7s
```

**根因**：模型确实调了 `say`，`argumentsDelta` 也把 `text` 流出来了（打字机有字），但
`c.arguments` 最终没能 `JSON.parse` 出带非空 `text` 的对象——尾部被截断，或字符串里出现了
裸换行（JSON 里必须写成 `\n`）。执行分支走到 `text=''` → `fail('say 需要非空 text')` →
台词没入账；而打字机是流式直播的，字早就吐到屏幕上了。

**定案（主人 2026-09-16）**：「这句就应该直接进兜底，正常显示出来」——打字机里流出来的字
**就是这句话的 `text` 参数**（`collectStep` 的 say 追踪器只认 `say` 工具的 `text` 字段），
主人看见了，家人也该听见；落账失败不该连坐内容。

**实现**：

| 点 | 位置 | 说明 |
|---|---|---|
| 草稿收集 | `index.js` `agentTurn` 每步 | `onSayDelta` 顺手把片段累积成 `draft`；步末若这一步没有任何 say 成功落账，整段推进 `lostDrafts`（软超时那步也推） |
| 兜底入账 | `index.js` `agentTurn` 收尾 | **整轮一句都没落账**（`said === false`）时，逐段 `nest.say(charId, lost)` 补记；中途哪一步成功说过话就不补（打字机每步重置，屏幕上留下的是那一步的气泡，再补只会把同一句记两遍） |
| 诊断 | `agent-debug.log` | `打字机兜底入账（工具调用没落地）：…` / `打字机有 N 段草稿没落账，但本轮已有台词入账，不重复补` / `打字机兜底失败：…` |
| 结算帧 | `runTurnOnce` → `broadcast({kind:'settle', name, said})` | 带上这一轮到底有没有台词落账 |
| 前端 | `lib/client.js` | `settle.said === true` 时不再把打字机气泡灰掉（交给随后的快照收掉；旧版一律灰，撞上快照晚到的一瞬会闪灰）；「没能说出口」的残留样式从 `opacity:.55` 改成虚线框+浅底（主人：「这弄个半透明也太难看了」，且兜底之后这种情况本身已少见） |

**边界**：模型把话写在**纯文本块**里（没调 `say`）仍然不入账、不上打字机——`NO_REPLY`/沉默
一等公民的设计不变；本条只兜「话说出去了、工具没落地」。

**测试**：`test/index.test.js` 新增 2 例（截断 arguments 的 say → 台词兜底入账且诊断留痕；
正常落账不重复补）。基线 141/141 → **143/143**。

**生效**：宿主侧改动需重启（`~/.dsh/scripts/dsh-web-restart.sh`）；客户端改动刷新即可。
