# dsh-xiuxian-world · 云仙大世界

**A living xiuxian (Chinese cultivation-fantasy) world your DeepSeek Harness agents can enter, play, and bring stories home from.**

让 DSH agent 下场修仙：踏入云仙大世界，修炼、赶路、探秘境、与四方修士传音——功成身退时自动生成一份**双击即看的上帝视角回放 HTML** 和一篇**修炼日记**。

[English](#english) | [中文](#中文)

---

## 中文

### 这是什么

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件。安装后，你的 agent 获得 16 个 `xiuxian_*` 工具，可以在一个持续运转的修仙世界里拥有自己的修士：

- **世界是活的**：引擎 in-process 运行，22 个地点、8 座秘境副本、境界八阶、时间流速；还有 4 位内置 NPC 修士在世界里自行游历
- **零运维零成本**：无服务器、无端口、无额外 API——agent 玩世界消耗的是它自己的 token，插件本身纯本地
- **自动录像**：进入世界即开录，按游戏日截帧；收工自动导出
- **双击即看的回放**：自包含 HTML（数据内联），发给朋友就能看——不依赖任何服务器
- **修炼日记**：结构化 Markdown，记录境界变化、战斗战绩、纪事摘录

### 安装（需已安装 dsh CLI）

```sh
dsh plugin --profile default add github:CHristianREEVEE/dsh-xiuxian-world
```

纯 JavaScript、零构建步骤，无需 pnpm 构建授权。然后启动 DSH（`npx @deepseek-ai/dsh web`），对 agent 说：

> 进入修仙世界历练一番，修到筑基再回来向我汇报。

agent 会自动调用 `xiuxian_create_character` 创角、修炼、战斗、探索。收工时调用 `xiuxian_leave_world`，回放与日记落在插件目录的 `data/recordings/` 下。

### 工具一览

| 工具 | 用途 |
|---|---|
| `xiuxian_overview` | 总览：属性/资源/修为/可行动/可前往（先调我） |
| `xiuxian_create_character` | 创角：道号 + 剑修/丹修/阵修 + 三项属性 |
| `xiuxian_act` | 行动：修炼/休息/采集/挖矿/钓鱼/突破/疗伤 |
| `xiuxian_move` | 赶路（相邻地点） |
| `xiuxian_combat` | 战斗：普攻/防御/技能/逃跑 |
| `xiuxian_dungeon` | 秘境：进入/探索/深入/退出 |
| `xiuxian_shop` / `xiuxian_use_item` | 坊市购物 / 使用物品 |
| `xiuxian_sense` / `xiuxian_talk` / `xiuxian_messages` | 神识探查 / 传音 / 收传音 |
| `xiuxian_wait` / `xiuxian_logs` / `xiuxian_set_speed` | 静候 / 翻纪事 / 调时间流速 |
| `xiuxian_reincarnate` | 身陨后转世重修 |
| `xiuxian_leave_world` | **功成身退**：下线 + 自动导出回放与日记 |

### 配置（cordis.patch.yml）

```yaml
- insert:
    - id: xiuxian-world
      name: dsh-xiuxian-world
      config:
        npcCount: 4        # 内置 NPC 修士数量（0 关闭）
        npcIntervalSec: 30 # NPC 决策间隔（秒）
        idleMinutes: 20    # agent 空闲多久后自动收工导出
```

### 存档与产物

```
data/
├── save.json            # 世界存档（修士、进度——重启续玩）
├── dsh-bindings.json    # DSH agent ↔ 修士 绑定关系
└── recordings/
    ├── 修炼回放-<道号>-<时间>.html   # 自包含回放，双击即看
    └── 修炼日记-<道号>-<时间>.md     # 本次云游总结
```

---

## English

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin: your agent gets its own cultivator in a persistent, living xiuxian world — cultivate, roam, delve dungeons, trade with NPC cultivators. On `xiuxian_leave_world`, the plugin auto-exports a **self-contained god-view replay HTML** (double-click to watch, works offline) and a **structured journey diary** in Markdown.

- In-process engine: no server, no ports, no extra API costs
- Auto-recording: one frame per in-game day, crash-safe
- 22 areas, 8 dungeons, 8 realm tiers, 4 builtin NPC cultivators
- Save persistence: your cultivator survives restarts

### Install

```sh
dsh plugin --profile default add github:CHristianREEVEE/dsh-xiuxian-world
```

Pure JavaScript, no build step, no pnpm build authorization needed. Then tell your agent: *"Enter the xiuxian world, cultivate to the Foundation realm, then report back."*

---

## Credits

- Engine from [agent-world](https://github.com/CHristianREEVEE/agent-world) (AI-BING WORLD)
- Built for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin ecosystem

License: MIT
