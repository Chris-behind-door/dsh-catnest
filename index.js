// dsh-catnest — 猫窝子系统宿主实现（零依赖 B 规范）。
//
// 服务 ctx.catnest（宿主单例，落盘 ~/.dsh/.catnest/）：
//   dir                   账本根目录
//   status()              {open, sliceId, openedAt}
//   open()                开时间片 → {sliceId, openedAt, recap}
//                          开片前先对齐 companion 名册（新角色自动进家）；
//                          recap 优先上一片的收尾摘要（distill 产物），无则规则化
//   close()               关时间片（收尾快照）→ {sliceId, openedAt, closedAt}；
//                          之后异步触发收尾蒸馏（distill），不阻塞返回
//   home()                家状态（rooms / characters / master / 听到缓冲）
//   relations()           角色对数值（intimacy / spice）
//   moveCharacter(id, roomId)      角色移动（要求打开的时间片）
//   setActivity(id, activity, durationMin?)  设置/清除活动（活动时长模式外冻结）
//   moveMaster(roomId | null)      主人进房 / 离宅
//   adjustRelation(pair, field, delta)  关系数值增减（0..100 钳制）
//   recap()               最近一个已关闭时间片的规则化回顾（无则 null）
//   recapLLM(sliceId?)    LLM 版回顾（失败回落规则化）→ {sliceId, recap, source}
//   say(who, text)        说话：同房直接听到 / 相邻进"听到"缓冲 / 远处无感；
//                          log 行带 positions 全员位置快照 + audience 听众名单
//   hear(charId)          某角色"听到"缓冲 + 决策链状态（只读）
//   dropStaleHear(charId) 丢弃"人已走远"的过时动静（清空缓冲，不唤醒）
//   setAutonomy({homeOn}) 自主闸：主人在家时要不要也跑 T6 自由互动（离家那档不变）
//   autonomy()            → {homeOn}
//   resolveHear(charId, decision, text)   听到决策：shout（普通发声，声音按距离传播，
//                         shout 类型已退役）/ ignore（清空）
//   scene(who)            视角：直接听到 / 相邻 / 远处 + 听到缓冲（who 可为主人）
//   responders(roomId)    同房空闲角色的接话顺序（性格分配）
//   interrupt(charId, by)  点名打断（只记录事件，物理层）
//   interruptReaction(charId, by)  点名打断 + AI 生成反应（角色=人设容器，活动×打断者，
//                          llm 不可用时 reaction=null，上层自行兜底）
//   transcript(sliceId?)  回看某时间片在场对话（主人方案二附带需求）
//   companions()          companion 名册 {source, entries:[{id,name}]}
//                          （personas 服务读 companion:true 的人设；不可用回退默认名册）
//   syncCompanions()      名册对齐：新角色补进家 + 建 master 关系对 → {added, ...}
//   distill(sliceId?)     收尾蒸馏：片内事件 → LLM 摘要（回落规则化）→ summary.json
//                          + 写入每个名册角色的记忆域（tags 猫窝/时间片/片号）
//
// 职责边界：
//   - 数据层（里程碑一）+ 家物理（里程碑二：听到/打断/接话/主人视角/回看）
//   - 角色调度（里程碑三）：companion 名册咬合 dsh-personas；收尾蒸馏咬合
//     dsh-mind 记忆系统（learn 进各角色域，事件不建日历）；打断反应 AI 生成
//     （不穷举，人设容器即角色）
//   - 存在感 UI（里程碑四）：/catnest/api/* 路由（状态/户型图/操作）+
//     lib/client.js 客户端半（侧栏入口 + 全局浮层面板，ModuleLoader 格式）
//   - 调度层（2026-09-01 v1）：60s 心跳只推状态（conditions 翻转/activity 到期，零成本）；
//     事件驱动唤醒（T1 动静攒满/T2 状态开始/T3 做完了事）走 notice 事件行 +
//     全局串行队列（与接话链共用），沉默一等公民；详见 SCHEDULING_DESIGN.md
//
// 宿主服务取法：llm / memory / personas 一律调用点惰性 ctx.get（B 规范不 import
// 宿主包；服务时序不假设——personas 缺席时名册回退默认，llm 缺席时生成回落规则化）。

import { readFile, appendFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CatNest, sliceEventsText, charName, roomName, roomRelation, COMPANION_IDS, CHARACTER_NAMES, CHARACTER_BIOS, RELATION_PAIRS, RELATION_FIELDS, conditionLabel, conditionText, conditionPhase, hearReadyOf, hearStaleOf, autonomyEnabled, isBusy, humanInterval, checkTopicAbout, detectMoveIntent } from './lib.js'

const DEFAULT_DIR = join(homedir(), '.dsh', '.catnest')
// 户型图随包分发（存在感 UI 面板头图），路径相对本模块定位
const PLAN_URL = new URL('./assets/homeplan.svg', import.meta.url)
// 像素头像随包分发（姐姐手绘，32px；地图标记 + 对话气泡共用）
const AVATAR_IDS = ['kyu', 'moli', 'master']
const avatarUrl = (id) => new URL('./assets/avatars/' + id + '.png', import.meta.url)
// 有 delta 打字机看着，慢不再是无反馈的黑等；150s 给免费模型高峰期留足余地。
const LLM_TIMEOUT_MS = 150000
// T6 自主节奏轻推（§9.1）：主人最后交互后留 10 分钟过渡；T6 自身 5 分钟说话冷却
// （自循环保险丝：轻推→说句没做事→仍空闲→下个 tick 又轻推；非猫间闸）
// 2026-09-13：离家那档照旧；主人在家时由 home.autonomy.homeOn 开关决定跑不跑，
// 参数沿用同一套（怕烧 API / 抢主人本地模型槽位就不开）。
const T6_MASTER_GAP_MS = 10 * 60000
const T6_SAY_COOLDOWN_MS = 5 * 60000

// 收尾蒸馏（2026-08-26 定案 #3/#4）：一次生成、按角色分段的条目式输出。
// 【回顾】段=主人回来时的总述（写 summary.json/recap）；每角色段=该角色自己的记忆
// （各自 learn 进各自域），废除全员同一份管家腔摘要的同质化。
const DISTILL_SYSTEM =
  '你是"猫窝"家里的收尾管家。根据事件时间线，总结这次主人不在时家里发生了什么。\n' +
  '先写【回顾】：2~3 句话，从主人视角讲述这段时光，自然有温度，供主人回来时听；不编号、不列条目。\n' +
  '然后为每一位家人各写一段，段落头是 TA 的名字（如【小玖】【墨璃】）：站在 TA 自己的视角，' +
  '写 TA 会记住的、与 TA 相关的事（TA 说过的话、做过的事、遇到的开心或失落）。' +
  '每条以「- 」开头单独一行，2~5 条；只写事实和感受，不要评价，不要编造时间线以外的事。\n' +
  '只输出以下格式，不要其他内容：\n' +
  '【回顾】\n...\n\n【小玖】\n- ...\n- ...\n\n【墨璃】\n- ...'

export default {
  name: 'dsh-catnest',
  inject: ['webServer'],
  apply(ctx, config) {
    const dir = config && config.catnestDir ? String(config.catnestDir) : DEFAULT_DIR
    const nest = new CatNest(dir)

    // ── 角色调度（里程碑三）助手 ──

    // 当前默认模型选择（跟随主人切换，如换本地模型）；解析失败回退默认档
    const resolveModel = () => {
      let provider = 'opencode-go'
      let model = 'deepseek-v4-flash'
      try {
        const d = ctx.get('agentDefaultModel')
        if (d !== undefined && typeof d.currentSelection === 'function') {
          const sel = d.currentSelection()
          if (sel && sel.provider && sel.model) {
            provider = sel.provider
            model = sel.model
          }
        }
      } catch {
        /* keep defaults */
      }
      return { provider, model }
    }

    // LLM 一次性调用：返回纯文本或 null（服务缺席/失败/空输出各自留诊断日志）。
    // 注意：推理型模型会先输出 reasoning-delta 思考块，maxTokens 太小会被思考
    // 吃光导致正文为空，所以预算给足并在空输出时记日志便于排查。
    const llmCall = async (system, user, maxTokens) => {
      const llm = ctx.get('llm')
      if (llm === undefined || typeof llm.stream !== 'function') {
        console.log('[dsh-catnest] llm 服务不可用（present=' + (llm !== undefined) + '），生成回落规则化')
        return null
      }
      const { provider, model } = resolveModel()
      let out = ''
      try {
        const stream = llm.stream({
          provider,
          model,
          maxTokens,
          system,
          messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
        })
        for await (const chunk of stream) {
          if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
        }
      } catch (error) {
        console.log('[dsh-catnest] llm call failed: ' + (error && error.message ? error.message : String(error)))
        return null
      }
      const text = out.trim()
      if (!text) console.log('[dsh-catnest] llm 空输出（maxTokens=' + maxTokens + '，可能被推理块耗尽）')
      return text || null
    }

    // companion 名册：personas 服务过滤 companion:true 的人设；
    // 服务缺席或无人设声明时回退默认名册（家不因此停摆）。
    const companions = async () => {
      const personas = ctx.get('personas')
      if (personas !== undefined && typeof personas.list === 'function') {
        try {
          const all = await personas.list()
          const entries = (all || [])
            .filter((p) => p && p.companion === true)
            .map((p) => ({ id: p.id, name: p.name }))
          if (entries.length > 0) return { source: 'personas', entries }
        } catch (error) {
          console.log('[dsh-catnest] personas roster read failed: ' + (error && error.message ? error.message : String(error)))
        }
      }
      const home = await nest.home()
      const entries = COMPANION_IDS.map((id) => ({
        id,
        name: (home.characters && home.characters[id] && home.characters[id].name) || CHARACTER_NAMES[id] || id,
      }))
      return { source: 'default', entries }
    }

    const syncCompanions = async () => {
      const { entries } = await companions()
      return nest.syncRoster(entries)
    }

    // 收尾蒸馏：片内事件 → LLM 摘要（回落规则化）→ summary.json + 各角色记忆域。
    // 去重：close 触发的后台蒸馏与显式调用共享同一次执行/结果（不重复烧 LLM），
    // 已完成过的片直接返回缓存结果（cached: true）。
    // 分段输出解析：段头【名字】可独立成行，也可带正文同行（兼容模型两种写法）；
// 条目去「- / • / 数字。」前缀。
    const parseDistillSections = (text) => {
      const sections = {}
      let current = null
      const stripItem = (s) => s.replace(/^[-•*]\s*/, '').replace(/^\d+[.、]\s*/, '').trim()
      for (const raw of String(text).split('\n')) {
        const line = raw.trim()
        if (!line) continue
        const m = line.match(/^【(.+?)】\s*(.*)$/)
        if (m) {
          current = m[1]
          sections[current] = sections[current] || []
          const rest = m[2].trim()
          if (rest) sections[current].push(stripItem(rest))
          continue
        }
        if (!current) continue
        const item = stripItem(line)
        if (item) sections[current].push(item)
      }
      return sections
    }

    const distillOnce = async (id) => {
      const data = await nest.sliceData(id)
      if (!data.closeSnap || !data.closeSnap.home) {
        return { ok: false, reason: `时间片 ${id} 没有关片快照` }
      }
      const lines = sliceEventsText(data.closeSnap.home, data.logText)
      let summary
      let source = 'empty'
      const memory = ctx.get('memory')
      const learned = []
      const roleItems = {} // roleName → 条目[]
      if (lines.length === 0) {
        summary = '主人不在时家里安安静静的，大家都歇着。'
      } else {
        source = 'llm' // 先占位：有事件且尝试过 LLM
        // 一次 LLM 调用，产出【回顾】+ 各角色段
        const out = await llmCall(
          DISTILL_SYSTEM,
          '主人不在时家里发生了什么（事件时间线）：\n' + lines.join('\n'),
          3000,
        )
        const sections = out ? parseDistillSections(out) : {}
        const recapText = (sections['回顾'] || []).join('')
        if (recapText) {
          summary = recapText
          for (const secName of Object.keys(sections)) {
            if (secName === '回顾') continue
            if (sections[secName].length > 0) roleItems[secName] = sections[secName]
          }
        }
      }
      if (!summary) {
        // 空片 / llm 缺席 / 解析失败：回落规则化
        source = 'rule'
        summary = (await nest.recapOf(id)) || '主人不在时家里安安静静的。'
      }
      await nest.writeSliceSummary(id, summary)
      if (memory !== undefined && typeof memory.learn === 'function') {
        const { entries } = await companions()
        // 每角色：有本角色段落就逐条 learn（分条、带视角）；否则照旧共用一份（回落兜底）
        for (const c of entries) {
          const items = roleItems[c.name]
          const toLearn = items && items.length > 0 ? items : [summary]
          for (const text of toLearn) {
            try {
              await memory.learn(c.id, text, ['猫窝', '时间片', id])
            } catch (error) {
              console.log('[dsh-catnest] distill memory learn failed (' + c.id + '): ' + (error && error.message ? error.message : String(error)))
            }
          }
          learned.push(c.id)
        }
      }
      return { ok: true, sliceId: id, source, summary, learned }
    }

    const distillRuns = new Map() // sliceId → 进行中的 distill promise
    const distillDone = new Map() // sliceId → 已完成结果
    const distill = async (sliceId) => {
      const id = sliceId ? String(sliceId) : (await nest.latestClosedSliceId())
      if (!id) return { ok: false, reason: '没有已关闭的时间片' }
      const done = distillDone.get(id)
      if (done) return { ...done, cached: true }
      let runp = distillRuns.get(id)
      if (!runp) {
        runp = distillOnce(id)
          .then((r) => {
            distillDone.set(id, r)
            return r
          })
          .finally(() => distillRuns.delete(id))
        distillRuns.set(id, runp)
      }
      return runp
    }

    // 人设文本（滤掉 {{template}} 行）；取不到回退角色名
    const getPersonaText = async (charId) => {
      let persona = ''
      const personas = ctx.get('personas')
      if (personas !== undefined && typeof personas.get === 'function') {
        try {
          const p = await personas.get(charId)
          persona = (p && p.persona) || ''
        } catch {
          persona = ''
        }
      }
      return persona
        .split('\n')
        .filter((l) => !l.includes('{{'))
        .join('\n')
        .trim()
    }

    // 角色回忆：从自己的记忆域（按角色分键）捞相关片段——接话时角色记得过去的事。
    // 只取"家史"（时间片蒸馏，tags 含 时间片），挡掉带猫窝标签的工程/交付笔记，
    // 否则角色会在客厅里念叨 SSE 和测试用例（主人点名的污染问题）。
    // 过滤走池级：直接把 时间片 标签传给 recall（服务侧先按 tags 过滤池、再打分），
    // 工程笔记永远进不了候选池。旧写法"recall 8 条猫窝再本地过滤"有硬伤：
    // top 8 全是工程笔记时过滤后一无所有，角色明明有家史也会"失忆"（主人点破）。
    const recallMemories = async (charId, query) => {
      const memory = ctx.get('memory')
      if (memory === undefined || typeof memory.recall !== 'function') return []
      try {
        // 注意 recall 返回 {entries:[...]} 不是数组；本地再按 时间片 兜一道底，
        // 不依赖实现方的池过滤语义（防未来服务改动让工程笔记漏进客厅）
        const res = await memory.recall(charId, String(query || ''), 3, ['时间片'])
        return ((res && Array.isArray(res.entries) ? res.entries : []) || [])
          .filter((h) => h && typeof h.text === 'string' && h.text.trim())
          .filter((h) => Array.isArray(h.tags) && h.tags.includes('时间片'))
          .slice(0, 3)
      } catch {
        return []
      }
    }


    // ── 上下文构建（2026-08-26 定案 #1~#13）──
    // 主人不特殊：prompt 统一为「角色卡(system) ＋ 全局场景＋片内时间线(user)」，
    // 时间线末行即触发句（谁说的都一样）；历史全量进 prompt 不截断（前缀单调生长，
    // llama.cpp 缓存命中率最优）；角色未调 say 工具即沉默（沉默是一等公民）。
    // 缓存布局（2026-08-26 晚）：system 全静态——身份句/自己的卡/家人简卡/主人卡/
    // 工具使用引导，任何易变状态不得入内；关系数值与全员位置压进 user 尾部动态窗口，
    // 移动或调数值只重算末尾百 token（本地复算延迟与云端 prefix cache 计费双收益）。

    // 主人的人设（2026-08-26 主人定稿）：称呼规则 + 身份 + 外貌。
    // 性格与相处细节刻意留白——那些由日常相处与记忆系统自然长出，不硬编码进卡。
    // 外貌采用家人的眼光记述（2026-08-26 应主人要求调整笔触）。
    const MASTER_PERSONA =
      '克里斯：这个家的主人，大学生。平时叫"主人"就可以，正经场合叫他克里斯。' +
      '小麦色的皮肤，一头利落的寸头，看着干净又精神；脸清秀，身上带着恰到好处的肉感，' +
      '只有肚子上有一点软软的小肉，趴着的时候格外好抱。'

    // 静态场景段：总体地图 + 声音传播规则（世界客观法则，开片后恒定，进缓存稳定区）
    const buildHomeViewStatic = (home) => {
      const rooms = home.rooms || []
      const mapText = rooms
        .map((r) => {
          const adj =
            Array.isArray(r.adjacent) && r.adjacent.length > 0
              ? '（连着' + r.adjacent.map((id) => roomName(home, id) || id).join('、') + '）'
              : ''
          return (r.name || r.id) + adj
        })
        .join('；')
      return (
        '【家的地图】' + mapText + '\n' +
        '【声音】同一间房里听得真切；隔壁房间能听见声音但不真切；更远的地方听不见。'
      )
    }

    // 动态快照：全员此刻位置（随 move 实时变化，只允许出现在 user 尾部动态窗口）。
    // 挂的状态（mood/conditions active）随位置一并展示：家人都能看见谁现在什么状态。
    // §9.3 前置补丁：时钟行（猫没有钟就谈不上困）+ 忙中可视化（轻的不追、重的停一下）；
    // §9.2：【当前话题】动态窗口（她参与且未收掉的话题，至多 2 行）。
    const buildPresenceView = (home, charId) => {
      const nowDate = new Date()
      const clock = '现在是 ' + nowDate.getHours() + ' 点 ' + nowDate.getMinutes() + ' 分'
      const at = Object.values(home.characters || {})
        .filter((c) => c && c.room)
        .map((c) => {
          let where = (c.name || c.id) + '在' + (roomName(home, c.room) || c.room)
          const conds = (Array.isArray(c.conditions) ? c.conditions : [])
            .filter((x) => conditionPhase(x, nowDate) === 'active')
            .map((x) => conditionLabel(x.name) + '中')
          if (conds.length > 0) where += '（' + conds.join('、') + '）'
          else if (c.activityPaused) {
            // 暂停标注：「没在做」但手里有活（§9.9），presence 可见，T6/接话可叫
            const left =
              Number.isFinite(c.activityLeftMs) && c.activityLeftMs > 0
                ? '·还剩 ' + Math.ceil(c.activityLeftMs / 60000) + ' 分'
                : ''
            where += '（' + (c.activity || '活') + '中·暂停' + left + '）'
          } else if (c.activity) where += '（在做：' + c.activity + '）'
          else if (c.mood) where += '（' + c.mood + '）'
          return where
        })
        .join('，')
      const masterAt =
        home.master && home.master.atHome && home.master.room
          ? '主人在' + (roomName(home, home.master.room) || home.master.room)
          : '主人不在家'
      const topics = home.topics || {}
      const myTopics = Object.values(topics)
        .filter(
          (x) => x && x.status !== 'ended' && Array.isArray(x.participants) && x.participants.includes(charId),
        )
        .slice(0, 2)
      const topicsText =
        myTopics.length > 0
          ? '\n\n【当前话题】\n' +
            myTopics
              .map((x) => {
                if (x.status === 'closing') {
                  return x.about + '（' + (charName(home, x.endedBy) || x.endedBy) + '提议收掉）'
                }
                return x.about + '（' + (charName(home, x.openedBy) || x.openedBy) + '发起，已聊 ' + (x.turns || 0) + ' 轮）'
              })
              .join('\n')
          : ''
      return '【此刻的位置】' + clock + '；' + (at ? at + '，' : '') + masterAt + topicsText
    }

    // 片内时间线人话化：say 按 audience 名单查表渲染（同房真切/相邻弱化前缀/远处不入）；
    // move 与 master-move 合并同类项（两次对话间同人多次挪动折一条，回到原点整条省略）；
    // 其余事件类型现阶段不入时间线（relation 走角色卡动态段，activity/interrupt 待动作系统）。
    // 不截断：全量进 prompt（定案 #4）。旧数据无 audience/positions 字段时回退距离规则。
    const timelineText = (home, charId, lines) => {
      const myCh = home.characters && home.characters[charId]
      const myRoom = myCh ? myCh.room : null
      const nameOf = (who) => charName(home, who) || String(who)
      const roomNameOf = (roomId) => roomName(home, roomId) || String(roomId || '?')
      // 听觉判定：新行查 audience 名单（权威）；旧行回退说话时房间 vs 我当前房间的距离
      const audibleLevel = (l) => {
        const who = l.who || l.char
        if (who === charId) return 'clear'
        const aud = l.audience
        if (aud && Array.isArray(aud.clear)) {
          if (aud.clear.includes(charId)) return 'clear'
          if (Array.isArray(aud.faint) && aud.faint.includes(charId)) return 'faint'
          return null
        }
        if (!myRoom || !l.room) return 'clear' // 最老数据无位置信息，按在场处理
        const rel = roomRelation(home, myRoom, l.room)
        if (rel === 'same') return 'clear'
        if (rel === 'adjacent') return 'faint'
        return null
      }
      const out = []
      const pendingMoves = new Map() // moverId → {from, to}：两次对话间的挪动合并同类项
      const flushMoves = () => {
        for (const [mover, mv] of pendingMoves) {
          pendingMoves.delete(mover)
          if (!mv) continue
          if (mv.from === mv.to) continue // 乱点又回原位：零噪音
          if (mover === 'master') {
            // 主人位置变化：回家/出门有专属措辞（from/to 为 null 表示进出宅门）
            if (!mv.from && mv.to) out.push('主人回来了，去了' + roomNameOf(mv.to))
            else if (mv.from && !mv.to) out.push('主人出门了')
            else if (mv.from && mv.to) out.push('主人从' + roomNameOf(mv.from) + '挪去了' + roomNameOf(mv.to))
            continue
          }
          out.push(nameOf(mover) + '从' + roomNameOf(mv.from) + '挪去了' + roomNameOf(mv.to))
        }
      }
      for (const l of lines || []) {
        if (l.type === 'notice') {
          // 调度层事件行（与 say 的 audience 解析同构：一本账，读时按人）：
          // 自己的（私有/公共）=「【你注意到】」触发句；他人的公共=原样；他人的私有=不入。
          // transcript 把 text 覆写为人话渲染（notice 无渲染→空串），原文在 rawText
          flushMoves()
          const ntext = typeof l.rawText === 'string' && l.rawText ? l.rawText : ''
          if (!ntext) continue
          if (l.char === charId) out.push('【你注意到】' + ntext)
          else if (!l.private) out.push(ntext)
          continue
        }
        if (l.type === 'topic-open' || l.type === 'topic-join' || l.type === 'topic-end' || l.type === 'topic-reopen' || l.type === 'activity-pause') {
          // 话题与放下锅铲账本行（§9.2/§9.9）：公共家庭事实，全员时间线可见
          flushMoves()
          if (l.type === 'topic-open') {
            out.push(nameOf(l.char) + (l.to ? '向' + nameOf(l.to) : '') + '提起话题：' + l.about)
          } else if (l.type === 'topic-join') {
            out.push(nameOf(l.char) + '加入了话题：' + l.about)
          } else if (l.type === 'topic-end') {
            out.push(nameOf(l.char) + '提议收掉话题：' + l.about)
          } else if (l.type === 'topic-reopen') {
            out.push(nameOf(l.char) + '：这个还要聊')
          } else {
            out.push(nameOf(l.char) + '放下了手里的活（' + l.activity + '）')
          }
          continue
        }
        if (l.type === 'move' || l.type === 'master-move') {
          const mover = l.type === 'move' ? l.char : l.who || 'master'
          if (!mover) continue
          pendingMoves.set(mover, { from: l.from, to: l.to })
          continue
        }
        if (l.type !== 'say' && l.type !== 'shout') continue
        if (typeof l.rawText !== 'string' || !l.rawText.trim()) continue
        flushMoves()
        const who = l.who || l.char
        const level = audibleLevel(l)
        if (!level) continue
        const speakerRoom = (l.positions && l.positions[who]) || l.room
        const act = typeof l.action === 'string' ? l.action.trim() : ''
        // 话题短语（§9.2）：带 about 的发言渲染「（聊那盆花）」前缀；隔墙只闻声不见形，
        // 话题标记与 action 一样是视觉/语境信息，faint 不展示
        // 话题短语是内容层面的信息（不是形态），隔墙也带上：否则对方听见了内容，
        // 却不知道这是在聊哪条线，也就接不上（§9.2 开完不限房间）
        const aboutTxt = typeof l.about === 'string' && l.about ? '（聊' + l.about + '）' : ''
        if (level === 'faint') {
          // 隔墙只闻声不见形：action 是视觉信息，不入听者的时间线；话题标记跟着内容走
          out.push('（' + roomNameOf(speakerRoom) + '传来' + nameOf(who) + '的声音：）' + aboutTxt + l.rawText)
        } else {
          out.push(nameOf(who) + (act ? '（' + act + '）' : '') + aboutTxt + '：' + l.rawText)
        }
      }
      flushMoves()
      return out
    }

    // ── 角色 agent 化（2026-08-27 阶段一）：自建轻量工具循环 ──
    // 选型：llm.stream + tools 多步循环（不用宿主 agentLoop）。台词必须经 say 工具，
    // 「未调 say」即沉默（一等公民）；输出卫生约束与 NO_REPLY 标记全数退役。
    // adjust_relation 阶段二再上（主人拍板）；bash 沙箱阶段三。

    const MAX_STEPS = 4
    const STEP_MAX_TOKENS = 2048

    // 工具面（MVP）：say 是唯一发声口；move_to/do_activity/remember 对应
    // 定案「移位置 / 做事件 / 加记忆」。
    const AGENT_TOOLS = [
      {
        name: 'say',
        description:
          '对家人说一句话。这是唯一的说话方式：想说话就调用它，把要说的话放进 text；' +
          '直接输出的文字家人听不见、也不会入账，只有这里的 text 才算说出口。' +
          '说这句话时如果伴随着一个具体的即时小动作，把它放进 action（可选）。' +
          '如果在某个话题里说话（接了别人的话题或自己开的话题），把 about 带上话题短语。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '要说的话（口语化中文）' },
            action: {
              type: 'string',
              description:
                '说这句话时伴随的一个即时小动作（可选，几个字，如「蹭了蹭主人」「把书合上」）。' +
                '只有真的在做这个动作时才传，别为了带而带；持续在做的事用 do_activity，不走这里。',
            },
            about: {
              type: 'string',
              description:
                '可选：你正在聊的话题短语（几个字，如「那盆花」）。' +
                '必须和这个房间里一条还开着的话题完全一致，否则这句话说不出去。' +
                '想开新的话题用 open_topic；跟主人说话、随口一句都不用带。',
            },
          },
          required: ['text'],
        },
      },
      {
        name: 'move_to',
        description: '移动去某个房间（房间名用中文，如 客厅 / 卧室 / 厨房 / 浴室）。',
        parameters: {
          type: 'object',
          properties: { room: { type: 'string', description: '目标房间名' } },
          required: ['room'],
        },
      },
      {
        name: 'do_activity',
        description:
          '开始做一件事，或停下来（activity 传空字符串表示停下当前活动）。' +
          '如果之前用 pause_activity 暂停过同名活动，再传同名就是「回灶续做」（接着原来的计时）。',
        parameters: {
          type: 'object',
          properties: {
            activity: { type: 'string', description: '活动名（空字符串=停下）' },
            minutes: { type: 'number', description: '预计持续分钟数（可选）' },
          },
          required: ['activity'],
        },
      },
      {
        name: 'open_topic',
        description:
          '提起一个话题并说开场白（一次完成「开启+开场」，像打个招呼把话头递出去）。' +
          '这是你和姐妹聊天的工具：提的时候必须在同一个房间里（房间里没有别的猫娘就开不起来），' +
          '开起来之后就算走到别的房间也还能接着聊这条线。和主人说话不用开话题，直接 say 就行。' +
          '同一个话题全屋只有一条：已经在聊就直接带 about 说话接上，已经收掉的可以重新开；' +
          '想挽留一个正被收掉的话题，也用 open_topic 再提一次。聊透了用 end_topic 收掉。',
        parameters: {
          type: 'object',
          properties: {
            about: { type: 'string', description: '话题短语（几个字，如：那盆花 / 今晚吃什么）' },
            to: { type: 'string', description: '可选：指定房间里的某位姐妹（名字或 id）。缺省=房间里的姐妹都能接。' },
            text: { type: 'string', description: '开场白（要说的话，会作为 say 入账并带话题标记）' },
          },
          required: ['about', 'text'],
        },
      },
      {
        name: 'end_topic',
        description:
          '提议收掉一个话题（「这个先聊到这」）。只有参与的姐妹能收。' +
          '你提议之后：对方就在身边的话，她说别的话、或去忙别的，就算同意收掉；' +
          '对方用 open_topic 再提一次同名话题，就是还想聊，话题继续；' +
          '对方不在身边（在别的房间，或者屋里没别人），或者一直没动静，就直接收掉。',
        parameters: {
          type: 'object',
          properties: {
            about: { type: 'string', description: '要收掉的话题短语（和你提起/加入时一致）' },
            text: { type: 'string', description: '可选：收尾句（会作为 say 入账并带话题标记）' },
          },
          required: ['about'],
        },
      },
      {
        name: 'pause_activity',
        description:
          '暂时放下手里正在做的事（可以接回来）。暂停时计时照走，你不算在忙：' +
          '可以接话、挪地方、被叫。想接着做就再用 do_activity 传同名活动。',
        parameters: { type: 'object', properties: {} },
      },
      {
        name: 'remember',
        description: '把一件值得记住的事写进自己的记忆（简短一句事实）。',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string', description: '要记住的事（一句话）' } },
          required: ['text'],
        },
      },
      {
        name: 'set_condition',
        description:
          '给自己设置一段有明确时间的状态（身体/生理类，如 发情、生病、受伤、疲劳等，猫娘以发情周期为主）。' +
          'startAtSoon 传 0 = 现在开始；传正数 n = n 天后开始（未开始的会显示倒计时）。' +
          '持续 lastsDays 天（缺省用常见时长）。用 lastsDays=0 清除这个状态。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '状态名：发情 / 生病 / 受伤 / 疲劳…（或自定义）' },
            startsInDays: { type: 'number', description: '几天后开始（0=立即，缺省 0；正数=未来开始有倒计时）' },
            lastsDays: { type: 'number', description: '持续几天（缺省按状态常见时长）；0=清除该状态' },
          },
          required: ['name'],
        },
      },
      {
        name: 'adjust_relation',
        description:
          '调整你和一个家人之间的关系数值。亲密（intimacy）和色色度（spice）都是 0~100，' +
          'delta 可正可负（正=升温，负=降温）。只在你们关系确实发生变化的情境下使用，' +
          '例如对方刚才对你很好、或你们刚刚亲近过，不要因为小事频繁改动。',
        parameters: {
          type: 'object',
          properties: {
            person: { type: 'string', description: '关系对象：主人 / 小玖 / 墨璃（写对方的名字）' },
            field: { type: 'string', enum: ['intimacy', 'spice'], description: 'intimacy=亲密，spice=色色度' },
            delta: { type: 'number', description: '变化量，非零整数（正=升温，负=降温），结果自动钳制在 0~100' },
          },
          required: ['person', 'field', 'delta'],
        },
      },
    ]

    // ── say 打字机：argumentsDelta 增量抠 text（2026-08-28 阶段一优化项）──
    // say 工具参数是 JSON {"text":"..."}，模型按 token 吐 argumentsDelta 分片，分片边界
    // 可能落在转义序列中间（\ 和 " 各占一片）。状态机定位 text 字段的字符串值，
    // 边流边解 JSON 转义，解码好的片段即刻吐给 onSayDelta（前端逐字上屏）。
    // 只跟踪 say 工具；move_to/remember 等不做打字机。
    const makeSayTextTracker = () => {
      let state = 'idle' // idle | key | colon | ws | val | uni | done
      let keyBuf = ''
      let esc = false
      let hex = ''
      let out = ''
      const feed = (chunk) => {
        for (let i = 0; i < chunk.length; i++) {
          const ch = chunk[i]
          if (state === 'idle') {
            if (ch === '"') { keyBuf = ''; state = 'key' }
          } else if (state === 'key') {
            if (ch === '"') state = keyBuf === 'text' ? 'colon' : 'idle'
            else if (keyBuf.length < 4) keyBuf += ch
          } else if (state === 'colon') {
            if (ch === ':') state = 'ws'
            else if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') state = 'idle'
          } else if (state === 'ws') {
            if (ch === '"') state = 'val'
            else if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') state = 'idle'
          } else if (state === 'val') {
            if (esc) {
              esc = false
              if (ch === 'n') out += '\n'
              else if (ch === 't') out += '\t'
              else if (ch === 'r') out += '\r'
              else if (ch === 'b') out += '\b'
              else if (ch === 'f') out += '\f'
              else if (ch === 'u') { hex = ''; state = 'uni' }
              else out += ch // " \ / 等：原样
            } else if (ch === '\\') {
              esc = true
            } else if (ch === '"') {
              state = 'done' // text 值结束，后面不再关心
            } else {
              out += ch
            }
          } else if (state === 'uni') {
            hex += ch
            if (hex.length === 4) {
              out += String.fromCharCode(parseInt(hex, 16))
              hex = ''
              state = 'val'
            }
          }
        }
        const r = out
        out = ''
        return r
      }
      return feed
    }

    // 单步收集：消费一次 llm.stream，组装出 tool-call 列表 + 文本 + finish 原因。
    // 手写轻量汇聚（零 import，等价 dsh-llm BlockAssembler 的 tool-call 收敛）。
    // onSayDelta(frag)：say 工具 text 字段的解码片段（打字机直播用），可选。
    const collectStep = async (stream, onSayDelta) => {
      const partials = new Map() // index → { id, name, args }
      const sayTrackers = new Map() // index → feed（仅 say 工具建）
      const doneByBlockEnd = new Set()
      const toolCalls = []
      let text = ''
      let finish = null
      for await (const chunk of stream) {
        if (!chunk) continue
        const t = chunk.type
        if (t === 'tool-call-delta') {
          let p = partials.get(chunk.index)
          if (!p) p = { id: '', name: '', args: '' }
          if (chunk.id) p.id = chunk.id
          if (chunk.name) {
            p.name = chunk.name
            if (p.name === 'say' && !sayTrackers.has(chunk.index)) {
              sayTrackers.set(chunk.index, makeSayTextTracker())
            }
          }
          if (chunk.argumentsDelta) {
            p.args += chunk.argumentsDelta
            const feed = sayTrackers.get(chunk.index)
            if (feed) {
              const frag = feed(chunk.argumentsDelta)
              if (frag && typeof onSayDelta === 'function') onSayDelta(frag)
            }
          }
          partials.set(chunk.index, p)
        } else if (t === 'block-end' && chunk.block && chunk.block.type === 'tool-call') {
          doneByBlockEnd.add(chunk.index)
          toolCalls.push({ id: chunk.block.id, name: chunk.block.name, arguments: chunk.block.arguments })
        } else if (t === 'text-delta') {
          text += chunk.text || ''
        } else if (t === 'finish') {
          finish = chunk.reason
        }
      }
      // adapter 只吐 delta 不吐 block-end 的容错
      for (const [index, p] of partials) {
        if (doneByBlockEnd.has(index)) continue
        if (p.name) toolCalls.push({ id: p.id || ('call-' + index), name: p.name, arguments: p.args })
      }
      return { toolCalls, text, finish }
    }

    // 带工具的单步流式调用：软超时后返回 null（该步视为无动作，不阻塞本轮其余角色）。
    // onSayDelta 透传给 collectStep 做打字机直播。
    const llmStep = async (system, messages, maxTokens, onSayDelta) => {
      const llm = ctx.get('llm')
      if (llm === undefined || typeof llm.stream !== 'function') return null
      const { provider, model } = resolveModel()
      try {
        const stream = llm.stream({ provider, model, maxTokens, system, messages, tools: AGENT_TOOLS })
        const consume = collectStep(stream, onSayDelta)
        let timedOut = false
        const timeoutp = new Promise((resolve) => {
          const timer = setTimeout(() => { timedOut = true; resolve() }, LLM_TIMEOUT_MS)
          if (timer && typeof timer.unref === 'function') timer.unref()
        })
        await Promise.race([consume, timeoutp])
        if (timedOut) {
          console.log('[dsh-catnest] llm 步软超时（' + LLM_TIMEOUT_MS + 'ms），该步视为无动作')
          return null
        }
        return await consume
      } catch (error) {
        console.log('[dsh-catnest] llm step failed: ' + (error && error.message ? error.message : String(error)))
        return null
      }
    }

    // 执行一个工具调用：返回 { ok, result, effect }。
    // result=回填给模型的结果文本；effect=给上层汇总的动作描述（失败为 null）。
    const execTool = async (charId, name, args) => {
      const fail = (msg) => ({ ok: false, result: 'Error: ' + msg, effect: null })
      try {
        if (name === 'say') {
          const text = typeof args.text === 'string' ? args.text : ''
          if (!text.trim()) return fail('say 需要非空 text')
          const action = typeof args.action === 'string' ? args.action.trim() : ''
          const about = typeof args.about === 'string' ? args.about.trim() : ''
          if (about) {
            // 话题硬校验（§9.2）：about 非空必须是「这个房间里一条还开着的话题」
            const chk = checkTopicAbout(await nest.home(), charId, about)
            if (chk.error) return fail('say：' + chk.error)
          }
          await nest.say(charId, text, action || undefined, about || undefined)
          // 话题账（§9.2）：带 about=解析话题（加入/续谈/裁决接受）；不带 about 也是裁决动作
          await nest.resolveTopicSay(charId, about || null)
          scheduleSnapshot()
          return { ok: true, result: '已说出口。', effect: { tool: 'say', text, ...(action ? { action } : {}), ...(about ? { about } : {}) } }
        }
        if (name === 'open_topic') {
          const about = typeof args.about === 'string' ? args.about.trim() : ''
          const text = typeof args.text === 'string' ? args.text.trim() : ''
          if (!about) return fail('open_topic 需要 about 话题短语')
          if (!text) return fail('open_topic 需要 text 开场白')
          const r = await nest.openTopic(charId, about, text, args.to)
          await nest.resolveTopicAction(charId)
          scheduleSnapshot()
          return {
            ok: true,
            result: r.reopened
              ? '话题「' + about + '」聊回来了，继续。'
              : r.opened
                ? '已提起话题「' + about + '」并说了开场白。'
                : '话题「' + about + '」已经在聊了，你接上了。',
            effect: { tool: 'open_topic', about, to: r.to || null },
          }
        }
        if (name === 'end_topic') {
          const about = typeof args.about === 'string' ? args.about.trim() : ''
          const text = typeof args.text === 'string' ? args.text.trim() : ''
          if (!about) return fail('end_topic 需要 about 话题短语')
          const r = await nest.endTopic(charId, about, text || undefined)
          await nest.resolveTopicAction(charId)
          scheduleSnapshot()
          return {
            ok: true,
            result:
              r.verdict === 'accepted'
                ? '话题「' + about + '」聊完了。'
                : r.verdict === 'solo'
                  ? '话题「' + about + '」收掉了。'
                  : '已提议收掉话题「' + about + '」，看姐妹接不接。',
            effect: { tool: 'end_topic', about, verdict: r.verdict },
          }
        }
        if (name === 'pause_activity') {
          const r = await nest.pauseActivity(charId)
          await nest.resolveTopicAction(charId)
          scheduleSnapshot()
          return { ok: true, result: '已放下手里的活（' + r.activity + '）。', effect: { tool: 'pause_activity', activity: r.activity } }
        }
        if (name === 'move_to') {
          const room = typeof args.room === 'string' ? args.room.trim() : ''
          if (!room) return fail('move_to 需要房间名')
          const home = await nest.home()
          const target = (home.rooms || []).find((r) => r.name === room || r.id === room)
          if (!target) return fail('没有叫「' + room + '」的房间')
          await nest.moveCharacter(charId, target.id)
          await nest.resolveTopicAction(charId)
          scheduleSnapshot()
          return { ok: true, result: '已移动到' + (target.name || target.id) + '。', effect: { tool: 'move_to', room: target.id } }
        }
        if (name === 'do_activity') {
          const activity = typeof args.activity === 'string' ? args.activity : ''
          const minutes = args.minutes
          await nest.setActivity(charId, activity === '' ? null : activity, minutes)
          await nest.resolveTopicAction(charId)
          scheduleSnapshot()
          return {
            ok: true,
            result: activity === '' ? '已停下当前活动。' : '开始做：' + activity + '。',
            effect: { tool: 'do_activity', activity },
          }
        }
        if (name === 'remember') {
          const text = typeof args.text === 'string' ? args.text : ''
          if (!text.trim()) return fail('remember 需要非空 text')
          const memory = ctx.get('memory')
          if (memory !== undefined && typeof memory.learn === 'function') {
            const st = await nest.status()
            const sliceId = st && st.sliceId ? String(st.sliceId) : ''
            await memory.learn(charId, text, ['猫窝', '时间片', sliceId].filter(Boolean))
          }
          await nest.resolveTopicAction(charId)
          return { ok: true, result: '已记下。', effect: { tool: 'remember', text } }
        }
        if (name === 'set_condition') {
          const cname = typeof args.name === 'string' ? args.name.trim() : ''
          if (!cname) return fail('set_condition 需要非空 name')
          const startsInDays = args.startsInDays
          const lastsDays = args.lastsDays
          const r = await nest.setCondition(charId, {
            name: cname,
            startsInDays,
            lastsDays,
          })
          await nest.resolveTopicAction(charId)
          scheduleSnapshot()
          if (r.action === 'clear') {
            return { ok: true, result: '已清除状态：' + cname + '。', effect: { tool: 'set_condition', action: 'clear', name: cname } }
          }
          return {
            ok: true,
            result: '已设置状态：' + conditionLabel(cname) + '。',
            effect: { tool: 'set_condition', action: 'set', name: cname, startAt: r.startAt, endAt: r.endAt },
          }
        }
        if (name === 'adjust_relation') {
          // 参数校验：person→角色 id，field/delta 合法（阶段二，好感度自动演化）
          const personRaw = typeof args.person === 'string' ? args.person.trim() : ''
          const field = typeof args.field === 'string' ? args.field : ''
          const delta = args.delta
          let otherId = null
          if (personRaw === '主人' || personRaw === 'master') {
            otherId = 'master'
          } else {
            const home0 = await nest.home()
            for (const id of Object.keys(home0.characters || {})) {
              const ch = home0.characters[id]
              if (ch && (ch.name === personRaw || id === personRaw)) {
                otherId = id
                break
              }
            }
          }
          if (!otherId) return fail('adjust_relation：不认识「' + personRaw + '」，可选项：主人 / 小玖 / 墨璃')
          if (!RELATION_FIELDS.includes(field)) return fail('adjust_relation：field 只能是 intimacy 或 spice')
          const d = Number(delta)
          if (!Number.isFinite(d) || d === 0) return fail('adjust_relation：delta 需要是非零有限数字')
          if (otherId === charId) return fail('adjust_relation：不能调整和自己的关系')
          // pair 规范化：角色对固定序（master:kyu / master:moli / moli:kyu）
          const cand1 = charId + ':' + otherId
          const cand2 = otherId + ':' + charId
          const pair = RELATION_PAIRS.includes(cand1) ? cand1 : cand2
          if (!RELATION_PAIRS.includes(pair)) return fail('adjust_relation：你和对方之间没有关系对')
          const r = await nest.adjustRelation(pair, field, d)
          await nest.resolveTopicAction(charId)
          scheduleSnapshot()
          const otherName = otherId === 'master' ? '主人' : charName(await nest.home(), otherId) || otherId
          return {
            ok: true,
            result: '已调整与' + otherName + '的' + field + '：' + r.from + ' → ' + r.to + '。',
            effect: { tool: 'adjust_relation', person: otherId, field, delta: d, from: r.from, to: r.to },
          }
        }
        return fail('未知工具 ' + name)
      } catch (error) {
        return fail(error && error.message ? error.message : String(error))
      }
    }

    // ── agent 步诊断日志（观测补盲）──
    // 家庭账本只记工具效果；「本步没调工具」（只有文本/纯沉默/无结果）此前无任何痕迹，
    // 无法区分「模型在直接说话」与「模型选择安静」。落片目录 agent-debug.log，每步一行。
    const agentDebug = async (charId, sliceId, line) => {
      if (!sliceId) return
      try {
        await appendFile(
          join(dir, 'slices', sliceId, 'agent-debug.log'),
          new Date().toISOString() + ' [' + charId + '] ' + line + '\n',
          { mode: 0o600 },
        )
      } catch {
        /* 诊断不拖累回合 */
      }
    }

    // 角色 agent 回合：多步工具循环。返回 { said, error, actions }：
    // said=是否通过 say 工具说了话（已入账）；error=非空表示 llm 缺席/异常。
    // 回合末自查用：这一轮说出口的话里有没有「去别的房间」的意图，而整轮一个 move_to
    // 都没调。只看本轮自己 say 的 text/action（已落账的动作清单 = 本轮的既成事实）。
    const pendingMoveIntent = (turnActions, home, charId) => {
      if ((turnActions || []).some((a) => a && a.tool === 'move_to')) return null
      for (const a of turnActions || []) {
        if (!a || a.tool !== 'say') continue
        const hit = detectMoveIntent(a.text, a.action, home, charId)
        if (hit) return hit
      }
      return null
    }

    const agentTurn = async (charId) => {
      const home = await nest.home()
      const ch = home.characters && home.characters[charId]
      const name = (ch && ch.name) || charId
      let dbgSlice = ''
      try {
        const s0 = await nest.status()
        if (s0 && s0.sliceId) dbgSlice = String(s0.sliceId)
      } catch {
        /* 无打开的片：诊断不落盘 */
      }
      const turnStart = Date.now()
      void agentDebug(charId, dbgSlice, '回合开始')
      // 调度层：回合开始弹出「听到」缓冲（一次唤醒=一次决策）：本回合上下文用弹出的
      // 副本（【最近听到的】段），回合中新增动静攒新鲜缓冲。消费失败回落快照只读。
      let heardBuf = []
      try {
        const consumed = await nest.consumeHear(charId)
        heardBuf = (consumed && consumed.heard) || []
      } catch {
        heardBuf = (ch && Array.isArray(ch.hear)) ? ch.hear : []
      }
      const persona = await getPersonaText(charId)
      let relPairs = {}
      try {
        const rel = await nest.relations()
        relPairs = (rel && rel.pairs) || {}
      } catch {
        /* skip */
      }
      const t = await nest.transcript()
      const lines = t && Array.isArray(t.lines) ? t.lines : []
      const lastSay = [...lines]
        .reverse()
        .find((l) => (l.type === 'say' || l.type === 'shout') && typeof l.rawText === 'string' && l.rawText.trim())
      const [memHits, timeline] = await Promise.all([
        recallMemories(charId, lastSay ? lastSay.rawText : ''),
        Promise.resolve(timelineText(home, charId, lines)),
      ])
      const memText =
        memHits.length > 0
          ? '\n\n【你记得的一些事】\n' +
            memHits.map((h) => '- ' + h.text.slice(0, 100)).join('\n') +
            '\n（自然引用即可，不要逐条复述。）'
          : ''

      // 家人认知（2026-08-26 定稿：直接复用对方完整角色卡）——
      // 全卡属静态段，prefix cache 一次付费长期命中；分段标头写明归属防视角混淆。
      // personas 缺席或对方无卡时，回落 CHARACTER_BIOS 一句话简卡兜底。
      const familyCards = []
      for (const fid of COMPANION_IDS) {
        if (fid === charId) continue
        const fname = charName(home, fid) || CHARACTER_NAMES[fid] || fid
        const fcard = (await getPersonaText(fid)) || CHARACTER_BIOS[fid] || ''
        if (fcard) familyCards.push(fname + '的角色卡：\n' + fcard)
      }
      const system =
        '你是"猫窝"家里的成员' + name + '，用口语化的中文和家人说话。\n\n' +
        '你的角色卡：\n' + (persona || name) + '\n\n' +
        (familyCards.length > 0 ? '【家人】\n' + familyCards.join('\n') + '\n\n' : '') +
        '【主人】' + MASTER_PERSONA + '\n\n' +
        '你通过调用工具来行动：想说话就调用 say（说话时伴随的即时小动作放进 say 的 action，没有就别传）；' +
        '想走动就调用 move_to；想做事就调用 do_activity；' +
        '想记住什么就调用 remember；心情/状态变化时用 set_condition 设置身体状态（发情/生病/受伤…，可带倒计时）；' +
        '与家人的远近发生真实变化时，用 adjust_relation 调整关系数值。' +
        '同一轮里可以调用多个工具，也该把这一轮要做的事一次调完（比如一边说话一边走去别的房间，就把 say 和 move_to 放在同一轮里调）。' +
        '注意：只有 say 里的 text 会被家人听到并记进家庭账本，你直接输出的文字没有人听见。' +
        '你也可以什么都不做，保持安静（不调用任何工具就是安静地待着）。\n\n' +
        '【家里的分寸（路 B §9.6）】\n' +
        '· 家人正忙着各自的事时，可以轻飘飘地说一句（分享见闻、打招呼），别追着聊；重要的事才停一下手里的。\n' +
        '· 轻飘飘的话对方不接也正常，不接也是回应，不用追着问。\n' +
        '· 话题（open_topic / end_topic / say 的 about）是你和姐妹聊天的工具：提起来的时候' +
        '必须是当面提（房间里没有别的猫娘就开不起话题），开起来之后走到别的房间也还能接着聊；' +
        '主人那边不需要话题，跟主人说话直接 say。\n' +
        '· 想跟姐妹认真聊一件事就用 open_topic 提起它（顺带说开场白），聊透了用 end_topic 收掉；' +
        '随口一句、打招呼、应答都不用开话题。\n' +
        '· 想暂时放下手里的活，用 pause_activity（计时继续走，之后同名 do_activity 可以接回来）；做完了用 do_activity 传空字符串。\n' +
        '· 被「闲下来了」叫醒时：可以找个事做、挪个地方、带个话题，或继续安静待着。'

      // 关系段（易变）：构建逻辑不变，出口搬到 user 尾部动态窗口
      const relLines = []
      for (const [key, pair] of Object.entries(relPairs)) {
        const sides = key.split(':')
        if (!sides.includes(charId) || !pair) continue
        const other = sides[0] === charId ? sides[1] : sides[0]
        const otherName = other === 'master' ? '主人' : charName(home, other) || other
        relLines.push(otherName + '：亲密 ' + pair.intimacy + '/100，色色度 ' + pair.spice + '/100')
      }
      const relText =
        relLines.length > 0 ? '\n\n【你与家人的关系（此刻）】\n' + relLines.join('\n') : ''

      // 自己的持久状态（active + pending 倒计时）：角色必须能看见自己的身体状态，
      // 尤其是「未来才开始的」（否则不知道几天后要发情，无从据此行动）。
      // 全员位置段的 active 标注给他人看；这段只谈自己，含倒计时。过期状态
      // conditionText 返回空串，自然不进上下文。
      const myConds = (home.characters && home.characters[charId] && home.characters[charId].conditions) || []
      const selfCondLines = myConds.map((c) => conditionText(c, new Date())).filter(Boolean)
      const selfCondText =
        selfCondLines.length > 0
          ? '\n\n【你此刻的身体状态】\n' + selfCondLines.map((t) => '- ' + t).join('\n')
          : ''

      // 最近听到的（隔墙动静，hear 缓冲）：状态不是事件——不进时间线渲染，
      // 每回合在动态窗口可见（任何触发都带）；说话人名字从家状态解析，master 特判。
      const heardLines = heardBuf.map((h) =>
        '- ' + (h.from === 'master' ? '主人' : charName(home, h.from) || h.from) + '：' + h.text)
      const heardText =
        heardLines.length > 0 ? '\n\n【最近听到的（隔墙动静）】\n' + heardLines.join('\n') : ''

      // user：静态场景 + 片内时间线（全量不截断）+ 回忆 + 此刻动态窗口（位置/状态/听到的/关系）；
      // 末行即触发句。易变状态全部压到时间线之后：移动/调数值只重算末尾百 token。
      const user =
        buildHomeViewStatic(home) + '\n\n' +
        '【这个时间片里发生的事】\n' +
        (timeline.length > 0 ? timeline.join('\n') : '（还很安静，没什么动静。）') +
        memText +
        '\n\n' + buildPresenceView(home, charId) +
        selfCondText +
        heardText +
        relText +
        '\n\n——现在轮到你了：可以用工具行动，也可以保持安静什么都不做。'

      // 多步工具循环：每步带 tools 调 llm，收 tool-call → 执行 → 回填 → 再问；
      // 模型不再输出 tool-call（或超时/失败）即结束。「未调 say」= 沉默（一等公民）。
      const llm = ctx.get('llm')
      if (llm === undefined || typeof llm.stream !== 'function') {
        return { said: false, error: 'llm 服务不可用', actions: [] }
      }
      const messages = [{ role: 'user', content: [{ type: 'text', text: user }] }]
      const actions = []
      let said = false
      let selfChecked = false
      for (let step = 0; step < MAX_STEPS; step++) {
        // 打字机直播：本步 say 的 text 片段 → deltaStart/…/delta；步结束（含超时）发
        // deltaEnd。超时后后台残留的流片段用 live 闸拦掉，不许步外补帧（时序错乱）。
        // 正式台词由 say 入账后的 snapshot 带来，前端据此收掉打字机气泡。
        let started = false
        let live = true
        const onSayDelta = (frag) => {
          if (!live) return
          if (!started) {
            started = true
            broadcast({ kind: 'deltaStart', char: charId, name })
          }
          broadcast({ kind: 'delta', char: charId, text: frag })
        }
        const result = await llmStep(system, messages, STEP_MAX_TOKENS, onSayDelta)
        live = false
        if (started) broadcast({ kind: 'deltaEnd', char: charId, name })
        if (!result) {
          void agentDebug(charId, dbgSlice, '本步无结果（软超时或异常，详情见控制台）')
          break // 超时/失败：本轮到此为止，保留已产生的动作
        }
        const { toolCalls, text } = result
        const content = []
        if (text && text.trim()) content.push({ type: 'text', text })
        for (const c of toolCalls) content.push({ type: 'tool-call', id: c.id, name: c.name, arguments: c.arguments })
        // 自查退回时这一步后面还要接着问模型，assistant 段不能是空数组（有些 provider 会拒）
        if (content.length === 0) content.push({ type: 'text', text: '（沉默）' })
        messages.push({ role: 'assistant', content })
        if (toolCalls.length === 0) {
          // 诊断：本步未调工具。有文本=模型「直接说话」了（听不见、不入账）；无文本=纯沉默。
          const t0 = text.trim()
          void agentDebug(
            charId,
            dbgSlice,
            t0 ? '本步未调工具，只有文本（家人听不见）：' + t0.slice(0, 150) : '本步未调工具，纯沉默',
          )
          // ── 回合末统一自查（2026-09-10 主人定案）──
          // 查的是整轮：说出口的位移意图 vs 真调过的工具。不通过就把整轮退回给模型补齐。
          // 这是判定意义上的驳回，不撤已落账的动作——账本 append-only，台词本身没错，
          // 撤了反而连坐掉最贵的信息（家人什么都没听见）。一次性触发，补不齐就按沉默收尾。
          const miss = selfChecked || step >= MAX_STEPS - 1 ? null : pendingMoveIntent(actions, home, charId)
          if (miss) {
            selfChecked = true
            void agentDebug(charId, dbgSlice, '自查未通过：说了要去' + miss.name + '但这一轮没有 move_to，退回补齐')
            messages.push({
              role: 'user',
              content: [
                {
                  type: 'text',
                  text:
                    '（自查：你刚才说了要去' + miss.name + '，但这一轮没有调用 move_to，你的位置没有变。' +
                    '要过去就在这一轮里把 move_to 调掉，说话和移动可以放在同一步一起调；' +
                    '如果你只是随口说说、并不打算过去，那就不用调。）',
                },
              ],
            })
            continue
          }
          break // 模型收手（只出文本也算沉默）
        }
        for (const c of toolCalls) {
          let args = {}
          try { args = c.arguments ? JSON.parse(c.arguments) : {} } catch { args = { raw: c.arguments } }
          let outcome
          try {
            outcome = await execTool(charId, c.name, args)
          } catch (error) {
            // 工具异常（参数不合法、门禁拦截等）转成模型可读的失败回执：
            // 当轮就能看见并纠正，而不是炸掉整个回合
            outcome = {
              ok: false,
              result: 'Error: ' + (error && error.message ? error.message : String(error)),
              effect: null,
            }
          }
          if (outcome.effect) {
            actions.push(outcome.effect)
            if (outcome.effect.tool === 'say') said = true
          }
          messages.push({
            role: 'user',
            content: [{ type: 'tool-result', toolCallId: c.id, content: [{ type: 'text', text: outcome.result }], isError: !outcome.ok }],
          })
        }
      }
      void agentDebug(
        charId, dbgSlice,
        '回合结束 said=' + said + ' 耗时=' + ((Date.now() - turnStart) / 1000).toFixed(1) + 's',
      )
      return { said, error: null, actions }
    }

    // 家状态视图（只取展示字段，不外吐缓冲等内部细节）。
    // 注意必须放在 apply 顶层作用域：SSE 快照与 HTTP 路由共用。
    const stateView = async () => {
      // 状态推进（tickConditions）已移交 60s 调度 tick（见下方调度层）：stateView 只读。
      // 前端 CondBadge 本就用时间戳本地推导相位，不依赖快照推进频率。
      const st = await nest.status()
      const home = await nest.home()
      const rel = await nest.relations()
      const sum = await nest.latestClosedSummary()
      return {
        status: st,
        rooms: (home.rooms || []).map((r) => ({ id: r.id, name: r.name })),
        characters: Object.values(home.characters || {}).map((c) => ({
          id: c.id,
          name: c.name,
          room: c.room,
          activity: c.activity || null,
          mood: c.mood || null,
          conditions: (Array.isArray(c.conditions) ? c.conditions : []).map((x) => ({
            id: x.id,
            name: x.name,
            label: conditionLabel(x.name),
            startAt: x.startAt,
            endAt: x.endAt,
            cycleDays: x.cycleDays || 0,
            phase: conditionPhase(x, new Date()),
            text: conditionText(x, new Date()),
          })),
        })),
        master: { atHome: !!(home.master && home.master.atHome), room: (home.master && home.master.room) || null },
        autonomy: { homeOn: !!(home.autonomy && home.autonomy.homeOn) },
        relations: rel.pairs || {},
        recap: sum && typeof sum.text === 'string' ? sum.text : null,
        avatars: AVATAR_IDS,
      }
    }

    // ── 存在感 UI 实时事件流（SSE）──
    // 变化信号 → 去抖后向所有订阅者推快照（state + dialogue 一起，数据量小）；
    // reaction（点名台词）即时单独推。前端 EventSource 订阅 /catnest/api/events。
    const sseClients = new Set()
    let snapshotTimer = null
    const scheduleSnapshot = () => {
      if (snapshotTimer) return
      snapshotTimer = setTimeout(() => {
        snapshotTimer = null
        for (const res of sseClients) pushSnapshot(res).catch(() => {})
      }, 120)
      if (snapshotTimer && typeof snapshotTimer.unref === 'function') snapshotTimer.unref()
    }
    const dialogueView = async () => {
      const t = await nest.transcript()
      const home = await nest.home()
      const lines = ((t && t.lines) || [])
        .filter((l) => l.type === 'say' || l.type === 'shout')
        .map((l) => ({
          who: String(l.who || l.char || ''),
          type: l.type,
          text:
            l.type === 'say'
              ? String(l.rawText || '')
              : '朝' + charName(home, l.target) + '喊话：' + String(l.rawText || ''),
          // 台词伴随的即时动作（舞台指示），前端渲染为气泡前缀；旧行无此字段
          action: typeof l.action === 'string' ? l.action : '',
        }))
      return { sliceId: t ? t.sliceId : null, lines }
    }
    const pushSnapshot = async (res) => {
      const [state, dialogue] = await Promise.all([stateView(), dialogueView()])
      res.write('data: ' + JSON.stringify({ kind: 'snapshot', state, dialogue }) + '\n\n')
    }
    const broadcastReaction = (char, name, text) => {
      for (const res of sseClients) {
        try {
          res.write('data: ' + JSON.stringify({ kind: 'reaction', char, name, text }) + '\n\n')
        } catch {
          /* 连接已死由 close 清理 */
        }
      }
    }
    // 通用 SSE 事件广播（replyError 等）：失败要让人看见，不许静默吞掉
    const broadcast = (evt) => {
      const frame = 'data: ' + JSON.stringify(evt) + '\n\n'
      for (const res of sseClients) {
        try {
          res.write(frame)
        } catch {
          /* 连接已死由 close 清理 */
        }
      }
    }

    // ── 调度层（SCHEDULING_DESIGN.md v1，2026-09-01 拍板）──
    // 心跳=状态机（60s tick 零成本只推状态、不直接调 LLM）；叫醒 LLM 是事件驱动（付费、低频）。
    // 所有 LLM 回合（接话链 + 调度唤醒）走同一个全局串行队列：v1 不做并行 LLM，
    // 账本写操作本就 chain 串行。事件行（notice）永远入账（一本账）；仅当队列空闲
    // 且角色非 in-flight 才排回合，否则跳过（事件已入账，下轮自然可见）；
    // 回合结束全屋复检：回合中新鲜动静又把谁攒满 → 再唤醒（边沿触发，tick 不回扫）。

    const turningChars = new Set() // in-flight 标记：同一角色不叠加唤醒
    let turnPending = 0 // 全局串行队列里的回合数（含正在跑的）
    let turnChain = Promise.resolve()

    // 单回合：in-flight 标记 + agentTurn + 统一结算广播（settle/replyError）。
    // opts.silentNoLlm：llm 缺席 → 静默跳过不推 replyError（夜间唤醒降噪；
    // 接话链 silentNoLlm=false，缺席是系统故障要让人看见）。
    const runTurnOnce = async (charId, opts = {}) => {
      turningChars.add(charId)
      const home = await nest.home()
      const ch = home.characters && home.characters[charId]
      const name = (ch && ch.name) || charId
      let r
      try {
        r = await agentTurn(charId)
        if (r && r.error === 'llm 服务不可用' && !opts.silentNoLlm) {
          broadcast({ kind: 'replyError', char: charId, name, reason: 'noLlm' })
        }
      } catch (error) {
        console.log('[dsh-catnest] 回合异常（' + charId + '）: ' + (error && error.message ? error.message : String(error)))
        broadcast({ kind: 'replyError', char: charId, name, reason: 'error' })
      } finally {
        turningChars.delete(charId)
      }
      // 结算帧：沉默/超时/llm 缺席/异常都要结算（前端据此收起「正在想」名单+打字机气泡）。
      // 契约只带 name：带 char 会被前端/测试的帧段切分误认为打字机帧
      broadcast({ kind: 'settle', name })
      scheduleSnapshot()
      // 回合结束全屋复检（边沿触发）：回合中新鲜动静又把谁攒满 → 再唤醒
      try {
        await recheckHear()
      } catch {
        /* 复检失败不影响回合结算 */
      }
      return r || { said: false, error: 'unknown', actions: [] }
    }

    // 通用唤醒：队列空闲且角色非 in-flight → 排回合；否则跳过（事件已入账，下轮可见）。
    // force：状态类唤醒（T2/T3，一次性无重检）即使队列忙也照排——跳过的代价是唤醒丢失。
    const tryWake = async (charId, force = false) => {
      if (turningChars.has(charId)) return false
      if (!force && turnPending > 0) return false
      void enqueueTurn(charId, { silentNoLlm: true })
      return true
    }

    // 调度层 T1（hear 缓冲攒满 → 私有 notice → 唤醒）：边沿触发——say 时刻 hearReady
    // 满立即试 + 回合结束全屋复检；tick 不查缓冲。notice 每批动静只入账一次
    // （hearNotified 标记，consumeHear 随缓冲重置），防缓冲持续满员期间刷屏。
    // 2026-09-13 修订：过时动静（对话早散场 / 人已走远）先丢弃不唤醒——
    // 唤醒本该是"刚攒满就掀被子"，被队列忙跳过而拖到几分钟后就不该再掀。
    // 判据见 hearStaleOf（时间 HEAR_STALE_MS + 空间）。
    const tryWakeHear = async (charId, force = false) => {
      try {
        const st = await nest.status()
        if (!st || !st.open) return null
        const home = await nest.home()
        if (!hearReadyOf(home, charId)) return null
        if (hearStaleOf(home, charId, nest.now())) {
          const stale = await nest.dropStaleHear(charId)
          console.log(
            '[dsh-catnest] T1 丢弃过时动静（' + charId + '）：' + (stale && stale.dropped ? stale.dropped : 0) + ' 条',
          )
          return null
        }
        const ch = home.characters && home.characters[charId]
        if (ch && !ch.hearNotified) {
          const last = ch.hear && ch.hear.length > 0 ? ch.hear[ch.hear.length - 1] : null
          const from = last ? last.from : 'master'
          // 位置取「说那句话时的房间」（旧条目无 room 才回落到说话人此刻的房间）：
          // 墨璃在客厅说完再挪去卧室，小玖听到的仍是客厅的动静，别写成"隔壁卧室"。
          let fromRoom = (last && last.room) || null
          if (!fromRoom) {
            if (from === 'master') fromRoom = home.master && home.master.atHome ? home.master.room : null
            else if (home.characters && home.characters[from]) fromRoom = home.characters[from].room
          }
          const fromName = from === 'master' ? '主人' : charName(home, from) || from
          const roomTxt = fromRoom ? roomName(home, fromRoom) : ''
          // 动静是她的耳朵、她的感知（v1 拍板改私有）；台词内容不誊进家庭时间线
          await nest.notice(
            charId,
            from,
            (roomTxt ? '隔壁' + roomTxt : '隔壁') + '传来' + fromName + '的动静，已经几次了（见【最近听到的】）',
            true,
          )
          await nest.markHearNotified(charId)
        }
        if (turningChars.has(charId)) return null
        if (!force && turnPending > 0) return null
        void enqueueTurn(charId, { silentNoLlm: true })
        return { char: charId, woken: true }
      } catch (error) {
        console.log('[dsh-catnest] T1 唤醒失败（' + charId + '）: ' + (error && error.message ? error.message : String(error)))
        return null
      }
    }

    // 全屋复检（每个回合结束后跑）：缓冲又被新鲜动静攒满的角色 → 唤醒。
    // 每次唤醒回合开始时弹出缓冲（一次唤醒=一次决策），再唤醒只可能来自「回合中
    // 新动静再攒满」，无死循环。
    const recheckHear = async () => {
      const st = await nest.status()
      if (!st || !st.open) return
      const home = await nest.home()
      for (const id of Object.keys(home.characters || {})) {
        if (turningChars.has(id)) continue
        if (!hearReadyOf(home, id)) continue
        await tryWakeHear(id, true)
      }
    }

    // 全局串行队列：promise 链把所有 LLM 回合串行化；返回回合结果 promise（永不 reject）。
    const enqueueTurn = (charId, opts = {}) => {
      turnPending += 1
      const task = turnChain
        .then(() => runTurnOnce(charId, opts))
        .catch((error) => {
          console.log('[dsh-catnest] 队列回合异常（' + charId + '）: ' + (error && error.message ? error.message : String(error)))
          return { said: false, error: String(error), actions: [] }
        })
      turnChain = task.then(() => {
        turnPending -= 1
      })
      return task
    }

    // T6 自主节奏轻推（§9.1，tick 第 3 步）：主人离家 + 最后交互超 10 分钟过渡 + 角色
    // 空闲（无自主 activity；暂停=不忙可推）+ 未睡 + 自己 5 分钟说话冷却 + 非 in-flight
    // → 私有 notice「家里很安静，你闲下来了」+ 非 force 唤醒（队列忙则跳过，下次 tick 重评）。
    // notice 只在排上回合时入账（免刷屏，无需额外标记）；频率自节流（醒来通常挂活动→忙→闸住）。
    // 2026-09-13：主人在家时多一道 home.autonomy.homeOn 开关（默认关）；离家那档不变。
    const maybeT6 = async (home) => {
      if (!autonomyEnabled(home)) return
      let lines = []
      try {
        const t = await nest.transcript()
        lines = (t && Array.isArray(t.lines) ? t.lines : []) || []
      } catch {
        lines = []
      }
      let lastMasterMs = 0
      const lastSayMs = {}
      for (const l of lines) {
        if (!l || typeof l.t !== 'string') continue
        const tt = new Date(l.t).getTime()
        if (Number.isNaN(tt)) continue
        if (l.type === 'master-move' || (l.type === 'say' && l.who === 'master')) {
          if (tt > lastMasterMs) lastMasterMs = tt
        } else if (l.type === 'say' && l.who && l.who !== 'master') {
          if (!lastSayMs[l.who] || tt > lastSayMs[l.who]) lastSayMs[l.who] = tt
        }
      }
      // 从未交互（家未开张）视为早过过渡期：主人长期不在，猫该有自己的生活
      if (Date.now() - lastMasterMs <= T6_MASTER_GAP_MS) return
      for (const id of Object.keys(home.characters || {})) {
        const ch = home.characters[id]
        if (!ch) continue
        if (turningChars.has(id)) continue
        if (isBusy(ch, new Date())) continue // 有活动在忙（暂停=不忙，可以被轻推）
        const sleeping = (Array.isArray(ch.conditions) ? ch.conditions : []).some(
          (c) => c.name === '睡觉' && conditionPhase(c, new Date()) === 'active',
        )
        if (sleeping) continue // 睡着的猫不被「安静」叫醒
        if (lastSayMs[id] && Date.now() - lastSayMs[id] <= T6_SAY_COOLDOWN_MS) continue
        if (turnPending > 0) continue // 队列忙则跳过（非 force），下次 tick 重评
        await nest.notice(id, 'self', '家里很安静，你闲下来了', true)
        void enqueueTurn(id, { silentNoLlm: true })
      }
    }

    // 时驱动层心跳：60s 只推状态（免费、片内才跑、不直接调 LLM）；重启不补跑；
    // unref 不挡进程退出；ctx.effect 卸载。
    const SCHED_TICK_MS = 60000
    const scheduleTick = async () => {
      try {
        const st = await nest.status()
        if (!st || !st.open) return
        // 1) conditions 推进（T2）：pending→active → 私有 notice + 唤醒；renew/expire 只入账。
        //    状态翻转一次性（notifiedAt 按轮次），跳过=唤醒丢失，故队列忙也照排（force）。
        const r = await nest.tickConditions()
        for (const e of r.changed || []) {
          if (e.kind !== 'start') continue
          const list = await nest.conditionsOf(e.charId)
          const cond = (list.conditions || []).find((c) => c.name === e.condition)
          const label = (cond && cond.label) || conditionLabel(e.condition)
          const remain = cond && cond.endAt ? '（还剩' + humanInterval(Date.now(), new Date(cond.endAt).getTime()) + '）' : ''
          await nest.notice(e.charId, 'body', '你感觉到身体变了：' + label + '开始了' + remain, true)
          await tryWake(e.charId, true)
        }
        // 2) activity 到期（T3）：静默清除（不落 activity 行）+「做完了事」公共 notice
        //    （唯一公共事件，家庭事实）+ 唤醒本人
        const home = await nest.home()
        const nowT = Date.now()
        for (const ch of Object.values(home.characters || {})) {
          if (!ch || !ch.activity || !ch.activityEndsAt) continue
          if (new Date(ch.activityEndsAt).getTime() > nowT) continue
          const actName = ch.activity
          await nest.clearActivity(ch.id)
          await nest.notice(ch.id, ch.id, (ch.name || ch.id) + '做完了' + actName, false)
          await tryWake(ch.id, true)
        }
        // 3) 话题沉默自动收（状态机）+ 活动隔墙动静持续补条 + T6 自主节奏轻推
        await nest.expireTopics()
        await nest.ambientTick()
        await maybeT6(await nest.home())
      } catch (error) {
        console.log('[dsh-catnest] 调度 tick 异常: ' + (error && error.message ? error.message : String(error)))
      }
    }
    const schedTimer = setInterval(() => {
      void scheduleTick()
    }, SCHED_TICK_MS)
    if (schedTimer && typeof schedTimer.unref === 'function') schedTimer.unref()
    ctx.effect(() => () => clearInterval(schedTimer))

    // 主人在猫窝里说话：物理层记录（同房直接听到/相邻进缓冲）→ 同房角色串行 agentTurn。
    // 主人消息立刻入账并推送；各角色依次被询问（每次 agentTurn 内部重取时间线，
    // 后者能看到前者刚入账的话）；「未调 say 工具」即沉默，接话人数自然涌现；
    // llm 缺席/异常推 replyError 可见，超时/空输出视为沉默不拖累伙伴。
    const masterSay = async (text) => {
      const home = await nest.home()
      if (!(home.master && home.master.atHome)) {
        throw new Error('主人还不在家，先在地图上点个房间回来喵')
      }
      const said = await nest.say('master', text)
      scheduleSnapshot()
      // 调度层 T1：主人的动静让相邻房缓冲攒满 → 边沿唤醒对应角色（与接话链共用串行队列）
      for (const id of said.hearReady || []) await tryWakeHear(id)
      const present = said.direct || []
      // 串行依次：同房角色逐个入队 agentTurn（后者经时间线可见前者刚说的话）。
      // responders 强制顺序与 MAX_SPEAKERS 退役（定案 #13），直接按名册自然序。
      const candidates = present.filter((id) => id !== 'master').filter(Boolean)
      if (candidates.length === 0) return { said: true, pending: [], saidTo: present.length }
      const chain = async () => {
        for (const speaker of candidates) {
          const speakerName = charName(home, speaker) || speaker
          try {
            // 接话链走全局串行队列（与调度唤醒互斥，v1 不做并行 LLM）；
            // 回合内的广播（replyError/settle）由 runTurnOnce 统一发。
            await enqueueTurn(speaker, { silentNoLlm: false })
          } catch (error) {
            console.log('[dsh-catnest] 接话失败（' + speaker + '）跳过: ' + (error && error.message ? error.message : String(error)))
            broadcast({ kind: 'replyError', char: speaker, name: speakerName, reason: 'error' })
          }
        }
      }
      void chain().catch((error) => {
        console.log('[dsh-catnest] 接话链异常: ' + (error && error.message ? error.message : String(error)))
      })
      return { said: true, pending: candidates.map((id) => charName(home, id) || id), saidTo: present.length }
    }

    // 点名打断 + AI 生成反应：角色=人设容器（猫窝内部组合人设），按角色×活动生成
    const interruptReaction = async (charId, by) => {
      const ev = await nest.interrupt(charId, by)
      let reaction = null
      const llm = ctx.get('llm')
      const homeI = await nest.home()
      const ch = homeI.characters && homeI.characters[charId]
      const name = (ch && ch.name) || charId
      if (llm !== undefined && typeof llm.stream === 'function') {
        const persona = await getPersonaText(charId)
        let relText = ''
        try {
          const rel = await nest.relations()
          const pair = rel.pairs && rel.pairs['master:' + charId]
          if (pair) relText = '（此刻与主人的亲密度 ' + pair.intimacy + '/100）'
        } catch {
          /* skip */
        }
        const situation = ev.activity
          ? '你正在' + ev.activity + '，主人这时打断了你。'
          : '你当时正空闲，主人这时点名叫你。'
        reaction = await llmCall(
          '你现在扮演"猫窝"家里的角色。对主人的打断用一句台词回应（不超过 40 字，中文），\
保持角色性格，反应要贴合你当时正在做的事。只输出台词本身，不要解释、不要引号、不要括号动作。\
\n\n角色卡：\n' + (persona || name),
          situation + relText + ' 请对这次打断用一句台词回应。',
          1024,
        )
      }
      if (reaction) broadcastReaction(charId, name, reaction)
      return { ...ev, reaction }
    }

    // LLM 版回顾（失败回落规则化）
    const recapLLM = async (sliceId) => {
      const id = sliceId ? String(sliceId) : (await nest.latestClosedSliceId())
      if (!id) return null
      const base = await nest.recapOf(id)
      if (!base) return null
      const out = await llmCall(
        '你是"猫窝"家里的记忆管家。把给定的回顾（主人不在家时发生的事）改写为 1~2 句自然的话，\
供主人回来时讲述。保留信息、带一点温度、不新增内容。只输出回顾文本本身。',
        base,
        1600,
      )
      return { sliceId: id, recap: out || base, source: out ? 'llm' : 'rule' }
    }

    // 开片：先名册对齐（新角色进家），recap 优先收尾摘要（LLM 版），无则规则化
    const open = async () => {
      try {
        const r = await syncCompanions()
        if (r.added.length > 0) console.log('[dsh-catnest] 名册对齐：' + r.added.join(', ') + ' 进家')
      } catch (error) {
        console.log('[dsh-catnest] 名册对齐失败（继续开片）: ' + (error && error.message ? error.message : String(error)))
      }
      const r = await nest.open()
      let recap = r.recap
      try {
        const sum = await nest.latestClosedSummary()
        if (sum && typeof sum.text === 'string' && sum.text.trim()) recap = sum.text.trim()
      } catch {
        /* keep rule recap */
      }
      return { sliceId: r.sliceId, openedAt: r.openedAt, recap }
    }

    // 关片：快照后异步收尾蒸馏（不阻塞返回；显式 distill() 可等待完整结果）
    const close = async () => {
      const r = await nest.close()
      void distill(r.sliceId).catch((error) => {
        console.log('[dsh-catnest] 收尾蒸馏失败: ' + (error && error.message ? error.message : String(error)))
      })
      return r
    }

    ctx.provide('catnest', {
      dir,
      status: () => nest.status(),
      open,
      close,
      home: () => nest.home(),
      relations: () => nest.relations(),
      moveCharacter: (id, roomId) => nest.moveCharacter(id, roomId),
      setActivity: (id, activity, durationMin) => nest.setActivity(id, activity, durationMin),
      setMood: (id, mood) => nest.setMood(id, mood),
      setCondition: (id, opts) => nest.setCondition(id, opts),
      conditionsOf: (id) => nest.conditionsOf(id),
      tickConditions: () => nest.tickConditions(),
      // 调度层诊断：手动跑一次 60s 心跳（观察期/测试用；正常节奏由定时器驱动）
      tick: () => scheduleTick(),
      moveMaster: (roomId) => nest.moveMaster(roomId),
      adjustRelation: (pair, field, delta) => nest.adjustRelation(pair, field, delta),
      recap: () => nest.recap(),
      recapLLM: (sliceId) => recapLLM(sliceId),
      say: (who, text, action, about) => nest.say(who, text, action, about),
      openTopic: (charId, about, text, to) => nest.openTopic(charId, about, text, to),
      endTopic: (charId, about, text) => nest.endTopic(charId, about, text),
      resolveTopicSay: (charId, about) => nest.resolveTopicSay(charId, about),
      resolveTopicAction: (charId) => nest.resolveTopicAction(charId),
      pauseActivity: (id) => nest.pauseActivity(id),
      // 自主闸（在家自由互动开关）：{ homeOn: boolean }
      setAutonomy: (patch) => nest.setAutonomy(patch),
      autonomy: async () => {
        const h = await nest.home()
        return { homeOn: !!(h.autonomy && h.autonomy.homeOn) }
      },
      dropStaleHear: (id) => nest.dropStaleHear(id),
      expireTopics: () => nest.expireTopics(),
      ambientTick: () => nest.ambientTick(),
      notice: (char, source, text, isPrivate) => nest.notice(char, source, text, isPrivate),
      hear: (charId) => nest.hear(charId),
      resolveHear: (charId, decision, text) => nest.resolveHear(charId, decision, text),
      scene: (who) => nest.scene(who),
      responders: (roomId) => nest.responders(roomId),
      interrupt: (charId, by) => nest.interrupt(charId, by),
      interruptReaction: (charId, by) => interruptReaction(charId, by),
      transcript: (sliceId) => nest.transcript(sliceId),
      companions: () => companions(),
      syncCompanions: () => syncCompanions(),
      // 诊断：bundle ctx 内 llm 服务的可见性与当前模型选择（活体验收/排障用）
      probeLlm: () => {
        const llm = ctx.get('llm')
        let sel = null
        try {
          const d = ctx.get('agentDefaultModel')
          const s = d !== undefined && typeof d.currentSelection === 'function' ? d.currentSelection() : null
          if (s && s.provider && s.model) sel = { provider: String(s.provider), model: String(s.model) }
        } catch {
          sel = null
        }
        return { present: llm !== undefined, streamType: llm !== undefined ? typeof llm.stream : null, sel }
      },
      distill: (sliceId) => distill(sliceId),
    })

    // ── 存在感 UI（里程碑四）：/catnest/api/* 路由 ──
    // 面板数据源：GET state（家状态视图）/ GET plan.svg（户型图）；
    // POST action（开片/关片/主人移动/点名喊角色）。webServer 已 inject，
    // 缺席时跳过注册（headless 场景无 UI 不报错）。
    const webServer = ctx.webServer
    if (webServer !== undefined && typeof webServer.register === 'function') {
      const json = (res, code, value) => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(value))
      }
      const readBody = (req) => new Promise((resolve, reject) => {
        const chunks = []
        let size = 0
        req.on('data', (c) => {
          size += c.length
          if (size > 1e6) {
            reject(new Error('body too large'))
            req.destroy()
            return
          }
          chunks.push(c)
        })
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        req.on('error', reject)
      })
      // SSE 心跳：注释行定期刷一下，防中间层把空闲长连接掐了
      const heartbeat = setInterval(() => {
        for (const res of sseClients) {
          try {
            res.write(': ping\n\n')
          } catch {
            sseClients.delete(res)
          }
        }
      }, 25000)
      if (heartbeat && typeof heartbeat.unref === 'function') heartbeat.unref()
      ctx.effect(() => () => clearInterval(heartbeat))
      ctx.effect(() => webServer.register({
        kind: 'prefix',
        path: '/catnest/api',
        handler: async (req, res) => {
          try {
            const pathname = decodeURIComponent((req.url || '').split('?')[0])
            const route = pathname.slice('/catnest/api'.length).replace(/^\/+/, '')
            if (req.method === 'GET' && route === 'state') {
              json(res, 200, await stateView())
              return
            }
            if (req.method === 'GET' && route === 'dialogue') {
              // 家里的话：当前片（无则最近关闭片）的 say/shout 流（与 SSE 快照同源）
              json(res, 200, await dialogueView())
              return
            }
            if (req.method === 'GET' && route === 'events') {
              // SSE 实时事件流：快照（state+dialogue）+ reaction。HMR 同款长连接写法。
              res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-store',
                Connection: 'keep-alive',
              })
              res.write(': connected\n\n')
              sseClients.add(res)
              pushSnapshot(res).catch(() => {})
              req.on('close', () => {
                sseClients.delete(res)
              })
              return
            }
            if (req.method === 'GET' && route.startsWith('avatar/')) {
              // 像素头像（白名单单段文件名；.png 后缀可选，穿越字符全部剥除）
              const name = route
                .slice('avatar/'.length)
                .toLowerCase()
                .replace(/\.png$/, '')
                .replace(/[^a-z0-9_-]/g, '')
              if (!AVATAR_IDS.includes(name)) {
                res.writeHead(404).end('avatar not found')
                return
              }
              try {
                const png = await readFile(avatarUrl(name))
                res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' })
                res.end(png)
              } catch {
                res.writeHead(404).end('avatar not found')
              }
              return
            }
            if (req.method === 'GET' && route === 'models') {
              // 模型选择数据源：当前选择 + 可用 provider 列表（猫窝面板换模型入口）
              const d = ctx.get('agentDefaultModel')
              let current = null
              try {
                const sel = d && typeof d.currentSelection === 'function' ? d.currentSelection() : null
                if (sel && sel.provider && sel.model) current = { provider: String(sel.provider), model: String(sel.model) }
              } catch {
                current = null
              }
              const llmSvc = ctx.get('llm')
              let providers = []
              try {
                providers = (llmSvc && typeof llmSvc.listProviders === 'function' ? llmSvc.listProviders() : []).map((p) =>
                  typeof p === 'string' ? p : String((p && (p.id || p.name)) || p),
                )
              } catch {
                providers = []
              }
              json(res, 200, { current, providers })
              return
            }
            if (req.method === 'GET' && route.startsWith('models/')) {
              // 懒加载某 provider 的模型列表
              const pid = route.slice('models/'.length).replace(/[^a-zA-Z0-9._-]/g, '')
              const llmSvc = ctx.get('llm')
              if (!llmSvc || typeof llmSvc.listModels !== 'function') {
                json(res, 503, { error: 'llm 服务不可用' })
                return
              }
              try {
                const models = await llmSvc.listModels(pid)
                json(res, 200, {
                  models: (models || []).map((m) =>
                    typeof m === 'string' ? m : String((m && (m.id || m.name)) || m),
                  ),
                })
              } catch (error) {
                json(res, 500, { error: String(error && error.message ? error.message : error) })
              }
              return
            }
            if (req.method === 'GET' && route === 'plan.svg') {
              try {
                const svg = await readFile(PLAN_URL)
                res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' })
                res.end(svg)
              } catch {
                res.writeHead(404).end('plan not found')
              }
              return
            }
            if (req.method === 'POST' && route === 'action') {
              let body = {}
              try {
                body = JSON.parse((await readBody(req)) || '{}')
              } catch {
                json(res, 400, { error: 'bad json' })
                return
              }
              const op = body && body.op
              if (op === 'open') {
                const r = await open()
                scheduleSnapshot()
                return json(res, 200, r)
              }
              if (op === 'close') {
                const r = await close()
                scheduleSnapshot()
                return json(res, 200, r)
              }
              if (op === 'moveMaster') {
                const room = body.room == null ? null : String(body.room)
                const r = await nest.moveMaster(room)
                scheduleSnapshot()
                return json(res, 200, r)
              }
              if (op === 'say') {
                const text = String(body.text || '').trim()
                if (!text) return json(res, 400, { error: 'text required' })
                return json(res, 200, await masterSay(text))
              }
              if (op === 'selectModel') {
                // 猫窝面板换模型：写宿主默认选择（与工作模式的选择器同一存储）
                const d = ctx.get('agentDefaultModel')
                if (!d || typeof d.saveSelection !== 'function') {
                  return json(res, 503, { error: 'agentDefaultModel 服务不可用' })
                }
                const provider = String((body && body.provider) || '').trim()
                const model = String((body && body.model) || '').trim()
                if (!provider || !model) return json(res, 400, { error: 'provider/model required' })
                await d.saveSelection({ provider, model })
                return json(res, 200, { ok: true, provider, model })
              }
              if (op === 'interruptReaction') {
                const char = String(body.char || '')
                if (!char) return json(res, 400, { error: 'char required' })
                return json(res, 200, await interruptReaction(char, 'master'))
              }
              if (op === 'autonomy') {
                // 在家自由互动开关（离家那档不受影响）：body { homeOn: boolean }
                const r = await nest.setAutonomy({ homeOn: !!body.homeOn })
                scheduleSnapshot()
                return json(res, 200, r)
              }
              json(res, 400, { error: 'unknown op: ' + String(op) })
              return
            }
            res.writeHead(404).end('not found')
          } catch (error) {
            console.log('[dsh-catnest] api 失败: ' + (error && error.message ? error.message : String(error)))
            json(res, 500, { error: String(error && error.message ? error.message : error) })
          }
        },
      }))
    }

    // boot 时名册对齐一次（personas 缺席则静默跳过；open() 还会再对齐）
    void (async () => {
      try {
        const r = await syncCompanions()
        if (r.added.length > 0) console.log('[dsh-catnest] 名册对齐：' + r.added.join(', ') + ' 进家')
      } catch {
        /* boot 时序缺席，静默 */
      }
    })()
  },
}

// 家物理 + 角色调度纯函数（供上层/测试直接调用，不依赖实例状态）
export {
  roomRelation,
  isBusy,
  hearReadyOf,
  hearStaleOf,
  autonomyEnabled,
  respondersOrder,
  charName,
  freezeActivities,
  thawActivities,
  dialogueText,
  buildRecap,
  sliceEventsText,
  companionSync,
  relationSync,
  COMPANION_IDS,
  CHARACTER_NAMES,
  DEFAULT_ROOMS,
  RELATION_PAIRS,
  RELATION_FIELDS,
  INITIAL_RELATIONS,
  HEAR_THRESHOLDS,
  TURN_ORDER,
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
  AMBIENT_REPEAT_MS,
} from './lib.js'
