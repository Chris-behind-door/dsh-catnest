# dsh-catnest · 家物理设计

「家」是什么样：房间怎么连、声音怎么传、看得见什么。对应代码里的家状态账本
（`~/.dsh/.catnest/home.json`）与 lib.js「家物理 · 纯函数」区。

> 调度层（心跳 / 事件唤醒）见 `SCHEDULING_DESIGN.md`；角色 agent 化见 `AGENT_LOOP_DESIGN.md`。
> 本文编号独立（§1、§2…），跨文档引用写 `HOUSE_DESIGN §1`。

## 1 家当：房间里有什么（2026-09-16 交付）

**定案**：房间不止有名字和功能标签，还有**东西**。`home.rooms[].items`。

**数据形态**：

```json
{ "id": "living", "name": "客厅", "functions": ["聊天"], "adjacent": ["kitchen"],
  "items": [ { "name": "沙发" }, { "name": "电视", "state": "关着" } ] }
```

- **房间内名字即标识**：不带 id。主人手改 json 时不用维护主键，加一件东西就多一行。
- **`state` 是自由短语**（「空的」「关着」「亮着」），可省略；有状态才渲染成 `电视（关着）`。
- **容忍手写脏数据**：`items` 写成纯字符串数组（`["沙发"]`）也认（`roomItems` 归一化）；
  缺 `name` 的条目、非法条目直接跳过。
- **默认稿**：`DEFAULT_ROOMS` 每个房间给了 3~5 件（玄关鞋柜 / 客厅沙发电视 / 书房书桌书架 /
  厨房灶台水壶 / 卧室床衣柜 / 浴室淋浴浴缸 / 阳台晾衣架洗衣机）。这是**建议稿**，
  home.json 落盘后以文件为准。

**可见性（沿用声音那套房间观）**：

| 视角 | 看得见什么 | 实现 |
|---|---|---|
| 角色 | **只有自己此刻所在房间**的东西（隔壁有什么看不见） | `index.js` `buildPresenceView` 注入 `【屋里有什么】客厅：沙发、电视（关着）` |
| 主人 | 全屋（面板左侧「🧺 家里有什么」，当前有人的房间那行点亮） | `index.js` `stateView` 出 `rooms[].items`，`lib/client.js` `ThingsCard` |

角色的家当行进 **user 尾部动态窗口**（和位置、当前话题同处），不进 system 缓存稳定区：
家当虽不常变，但它是 per-角色视角的动态事实，且未来若做互动会变（缓存布局纪律，见
`AGENT_LOOP_DESIGN.md` 定案 #1~#13「任何易变状态不得入 system」）。

**本期边界（主人定）**：**不做物品互动系统**。没有拿 / 放 / 使用 / 状态自动变化的工具；
`state` 由主人改 `home.json` 维护，`nest.home()` 每轮读盘，改完下一次快照 / 下一次生成即生效。

**账本迁移**：`HOME_VERSION` 4 → 5。`ensure()` 里按房间 id 补默认稿——
已知房间用 `DEFAULT_ROOMS` 的家当，默认表里没有的房间给空数组（不猜主人家里有什么），
已有 `items` 的房间原样不动。

**实现锚点**：

| 点 | 位置 | 说明 |
|---|---|---|
| 家当数据 | `lib.js` `DEFAULT_ROOMS[].items` | 建议稿；`defaultHome()` 深拷贝落盘 |
| 归一化 | `lib.js` `roomItems(home, roomId)` | → `[{ name, state\|null }]`，手写脏数据的容错面 |
| 渲染 | `lib.js` `roomItemsText(home, roomId)` | → `沙发、电视（关着）`；空房间返回空串（不占 token） |
| 角色注入 | `index.js` `buildPresenceView` | 位置行之后、当前话题之前加一行 `【屋里有什么】` |
| 主人视角 | `index.js` `stateView` + `lib/client.js` `ThingsCard` | 房间随快照带 `items`，左侧导航列列出全屋 |
| 迁移 | `lib.js` `doEnsure()` | v4 → v5，补字段不覆盖用户数据 |

**测试**（`node --test`，125/125）：lib 新增 3 例（v4→v5 迁移三分支 / 默认家当形态 /
`roomItems`+`roomItemsText` 脏数据归一化），index 新增 1 例（prompt 只注入自己房间、
挪房即换、隔壁看不见）。

**留观察（没做）**：物品互动（拿放 / 使用 / 状态自动变化）、相邻房间能否瞥见、
物品与活动的咬合（做饭时灶台上什么变化）。
