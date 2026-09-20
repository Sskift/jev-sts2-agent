# jev-sts2-agent

《Slay the Spire 2》游戏 Agent：**C# 模组读取实时状态 → Node.js 组织规则与上下文 → Jev 制定回合计划 → 模组执行 → 重新观察。** 游戏自行结算和渲染，正常循环不要求窗口置顶。

目前是研究原型。27 局历史运行中，16 局通过第一幕，最远到第二幕 Boss，尚未通关。当前暂停新对局，使用历史局面改进 harness；模型回放不操作游戏，也不能证明整局胜率。

## 环境与启动

- Windows、Node.js（本机使用 v25.8.1）、已安装的游戏及兼容 CLI 模组。
- 当前支持游戏 **v0.111.0**，模组构建 **0.111.0-context.17**。安装与构建步骤见 [模组说明](mods/sts2-cli-compat/README.md)。只有重建模组或使用窗口诊断工具才需要 .NET 开发工具。
- Jev 的 TypeSafe 或 OpenRouter API key。项目只依赖 Ajv 做 JSON 校验，无 Python 服务、向量数据库或视觉模型依赖。

```powershell
npm ci
Copy-Item .env.example .env
```

在本地 `.env` 填入配置，例如：

```dotenv
JEV_PROVIDER=openrouter
JEV_MODEL=typesafe/jev-1.13
OPENROUTER_API_KEY=your-key
```

也可使用 `JEV_PROVIDER=typesafe` 和 `TYPESAFE_API_KEY`。凭据、原始运行记录及临时文件不提交 Git。

启动已启用模组的游戏后：

```powershell
node src/mod_client.mjs ping
npm run mod:state         # 只读原生状态
npm run context:preview   # 只读组织好的上下文，不调用模型
npm start                # 会操作游戏，仅在需要开始或继续实战时运行
```

## 决策方式

实时输入包含生命、能量、各牌堆、当前费用和目标预览、药水、遗物、敌人意图、地图及合法动作。本地 [Spire Codex v0.111.0](data/spire-codex/README.md) 补充关联规则；当前原生数值优先于 Wiki 基础数值。

统一上下文区分观察、规则、相关历史、意图、条件分析和未知信息。每次模型请求自包含，不依赖 Jev 跨调用记忆。历史默认保留当前回合、上一轮敌方响应，以及仍影响当前决策的计数、延迟或牌序信息。

Jev 在代码提供的目标与候选空间中选择构筑方向、回合目标、准备动作、顺序和完整方案。普通连续出牌沿用计划，抽牌、目标死亡、费用变化及选牌结果触发复核。框架与候选生成由代码定义，模型负责其中的判断；当前没有完整的跨回合战斗求解器。

效果表明确区分已生效能力与尚未打出的牌／药水，提供来源、作用对象、触发时机和失效时间。例如反伤按命中触发，Flame Barrier 持续到敌方回合结束，One-Two Punch 要在玩家回合结束前获得攻击消费者。方案同时列出已计算的回合末伤害、未计算效果以及临时增益的使用情况。

条件算术只覆盖已核实的机制。未知触发、随机抽牌、未揭示房间和未来敌人随机动作保持未知；局部数字不能当成完整模拟。命令结果不明确时停止并保留待核对状态，不自动重发。

## 历史回放

[数据划分与评估约定](eval/harness-split.json)固定开发局与 3 局本轮留出集；结果与局限见[评估报告](docs/harness-evaluation.md)。原始历史保存在本机 `run-artifacts/`，不随仓库分发。回放只向 Jev 请求决策，不连接游戏命名管道。

```powershell
# 从开发局的某一步提取当时观察与此前已确认的记忆
npm run replay -- collect --step run-artifacts/<session>/step-0001 --id example

# 对同一个快照运行当前代码；结果包含原始请求、模型返回和有序方案
npm run replay -- replay --case run-artifacts/harness-evaluation/cases/example.json
```

可用 `--code <旧版本目录>` 对比旧 harness，用 `--repeat 2` 保留重复结果。快照带有输入哈希；留出集在代码冻结后运行。评估比较具体规则、顺序、资源和后果，不能把“选择变了”或模型高置信度直接当成改善。

## 代码结构与检查

| 位置 | 职责 |
|---|---|
| `src/mod_client.mjs`、`src/mod_loop.mjs` | 模组通信、执行核对与运行记录 |
| `src/decision_context.mjs`、`src/context_compiler.mjs`、`schemas/` | 状态契约、记忆、统一模型上下文与容量管理 |
| `src/rule_reference.mjs`、`src/effect_lifecycle.mjs` | 规则关联、效果时序与有效期 |
| `src/turn_plan*.mjs`、`src/turn_projection.mjs` | 有序回合计划、方案比较和有限效果分析 |
| `src/run_strategy*.mjs`、`src/camp_plan*.mjs` | 构筑方向和跨界面意图 |
| `scripts/replay_harness.mjs` | 无游戏操作的历史对照回放 |
| `native/WindowDriver/`、录屏脚本 | 可选窗口诊断与录像，不参与正常决策 |

```powershell
npm test
```

[当前计划](docs/plan.md) · [上下文架构](docs/context-architecture.md) · [决策管线](docs/decision-pipeline.md) · [历史战况](docs/full-run-progress.md)
