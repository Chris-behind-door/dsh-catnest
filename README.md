# dsh-catnest · 猫窝

DSH agent harness 上的**多角色家庭陪伴系统**：把「家」建成一个有地图、有时间片、有记忆、有心跳的多 agent 模拟——角色各自持有完整工具面（说话 / 移动 / 活动 / 记忆 / 状态 / 关系），由事件驱动唤醒，时间驱动只推状态。

## 能力一览

- **家状态账本**：房间布局与家当 / 角色位置与活动 / 主人位置 / 听到缓冲，落盘 `~/.dsh/.catnest/`，跨时间片延续
- **家当（房间里有什么）**：每个房间带一份东西（`{ name, state?, count? }`，如「水壶（空的）」「消婴器×50」）。角色只看得见自己此刻所在房间，主人视角在面板右侧栏（角色卡下面）看全屋，点 ✎ 就能增删改（补货 / 清理不用碰 JSON）
- **家当工具**：猫娘能碰自己房间里的东西——`take_item`（拿走/用掉，归零即消失）、`put_item`（放东西，同名累加）、`set_item_state`（改状态：灶台脏了、水壶空了）；动过就进片内时间线（「小玖从客厅拿走了 消婴器×2」），家里谁都看得见
- **时间片生命周期**：开片对齐 companion 名册（新角色自动进家），关片触发分角色收尾蒸馏，写进各角色记忆域
- **调度层（心跳 + 事件）**：60s tick 只推状态（conditions 翻转 / activity 到期，零成本）；动静边沿、状态翻转、活动到期才叫醒 LLM（付费、低频）；全局串行队列，沉默是一等公民（未调 `say` 即沉默）
- **路 B 猫自主行动**：主人离家时 T6 自主节奏轻推；topic 完整工具套件（`open_topic`/`end_topic`/`say.about`，TCP 式生命周期，框架控质量）；「放下锅铲」`pause_activity`（暂停=不忙，同名 `do_activity` 回灶）；活动隔墙动静（真在做事才有锅铲声，进 hear 缓冲喂 T1）
- **在家自由互动开关**：主人在家时也想让她们自己找话说、自己找事做，就在面板顶栏把「自由互动」打开（默认关；出门后的自由互动本来就是自动的，不受这个开关影响）
- **姐妹参考话题池**：她们自己聊起来时（自由互动轻推 / 听到姐妹的动静），框架按**当前房间**抽一份引子（场地 3 条 + 人物家宅 2 条）放进 prompt；正在聊一条线时不给。想多要可以调 `pick_topic` 工具翻类目（玄关/客厅/书房/厨房/卧室/浴室/阳台/主人/小玖/墨璃/猫窝）
- **角色 agent 化**：自建轻量工具循环（llm.stream + tools，多步收敛），台词必须经 `say` 工具，带打字机流式
- **记忆**：咬合 dsh-mind（BM25 + tag 池检索、LFU 带年龄平权淘汰），接话注入按 `时间片` 池精确过滤，主动检索放开全池
- **Web UI**：户型图 + 角色站位 + 时间线 + 侧栏面板（`/catnest/api/*` + SSE）

## 依赖

| 依赖 | 说明 |
|---|---|
| [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh) ≥ 0.1.1-rc.2 | 宿主 agent harness（npm 已公开） |
| `dsh-mind` | 记忆系统插件（兄弟仓库，同系列公开） |
| `dsh-personas` | 人设名册插件（兄弟仓库，同系列公开） |
| 任一 LLM | 经宿主 `llm` 服务接入（llama.cpp server / 云端均可）；缺席时生成回落规则化 |

## 安装

DSH 插件按 pnpm 依赖挂进 profile 的 bundle 栈：

```bash
# 本地开发（link 方式）
dsh plugin --profile <your-profile> add dsh-catnest=file:../path/to/dsh-catnest

# 或 npm/git 源（发布后）
dsh plugin --profile <your-profile> add dsh-catnest
```

并在 profile 的 `dsh.profile.bundles` 里按顺序加入 `dsh-personas`、`dsh-mind`、`dsh-catnest`（catnest 依赖前两者提供的 personas / memory 服务，顺序在前）。

## 数据与目录

- `~/.dsh/.catnest/`：家账本（home.json / relations.json / slices/<片号>/）。`home.json` 解析失败或结构不对时**不会静默重置**：原地保留原文件 + 另存一份 `home.json.corrupt-<片号>` + 报错，修好再启动
- `~/.dsh/.personas/`：角色人设卡（dsh-personas 维护；`companion: true` 的角色进家）
- 数据目录可用 profile 配置 `catnestDir` 覆盖

## 测试

```bash
node --test   # 自动发现 test/ 下全部用例
```

## 设计文档

- `AGENT_LOOP_DESIGN.md`：角色 agent 化（工具循环 / 沉默语义 / 打字机）
- `SCHEDULING_DESIGN.md`：调度层（心跳状态机 + 事件驱动唤醒）
- `HOUSE_DESIGN.md`：家物理（房间与相邻 / 可见性 / 家当）

## License

MIT
