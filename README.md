# dsh-catnest · 猫窝

DSH agent harness 上的**多角色家庭陪伴系统**：把「家」建成一个有地图、有时间片、有记忆、有心跳的多 agent 模拟——角色各自持有完整工具面（说话 / 移动 / 活动 / 记忆 / 状态 / 关系），由事件驱动唤醒，时间驱动只推状态。

## 能力一览

- **家状态账本**：房间布局 / 角色位置与活动 / 主人位置 / 听到缓冲，落盘 `~/.dsh/.catnest/`，跨时间片延续
- **时间片生命周期**：开片对齐 companion 名册（新角色自动进家），关片触发分角色收尾蒸馏，写进各角色记忆域
- **调度层（心跳 + 事件）**：60s tick 只推状态（conditions 翻转 / activity 到期，零成本）；动静边沿、状态翻转、活动到期才叫醒 LLM（付费、低频）；全局串行队列，沉默是一等公民（未调 `say` 即沉默）
- **路 B 猫自主行动**：主人离家时 T6 自主节奏轻推；topic 完整工具套件（`open_topic`/`end_topic`/`say.about`，TCP 式生命周期，框架控质量）；「放下锅铲」`pause_activity`（暂停=不忙，同名 `do_activity` 回灶）；活动隔墙动静（真在做事才有锅铲声，进 hear 缓冲喂 T1）
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

- `~/.dsh/.catnest/`：家账本（home.json / relations.json / slices/<片号>/）
- `~/.dsh/.personas/`：角色人设卡（dsh-personas 维护；`companion: true` 的角色进家）
- 数据目录可用 profile 配置 `catnestDir` 覆盖

## 测试

```bash
node --test   # 自动发现 test/ 下全部用例
```

## 设计文档

- `AGENT_LOOP_DESIGN.md`：角色 agent 化（工具循环 / 沉默语义 / 打字机）
- `SCHEDULING_DESIGN.md`：调度层（心跳状态机 + 事件驱动唤醒）

## License

MIT
