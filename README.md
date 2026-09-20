# jev-sts2-agent

《Slay the Spire 2》游戏 Agent：**C# 模组读取实时状态 → Node.js 组织规则与上下文 → Jev 制定回合计划 → 模组执行 → 重新观察。** 游戏自行结算和渲染，正常循环不要求窗口置顶。

目前是研究原型。27 局历史运行中，16 局通过第一幕，最远到第二幕 Boss，尚未通关。当前继续离线完善知识和回合规划，**没有启动新对局**。已接入五个角色的策略参考、115 个怪物的行动图、独立有序候选和方案比较分歧记录；历史回放不能证明稳定通关或胜率提升。

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

[策略知识](data/strategy/README.md) 将攻略建议与原生规则分开：每个组合记录前提和代价，不预设固定流派。怪物图区分固定顺序、条件、随机权重、重复限制和资料缺口；只根据可见意图关联后续可能行动，保留阶段中断和识别歧义。

统一上下文区分观察、规则、相关历史、意图、条件分析和未知信息。每次模型请求自包含，不依赖 Jev 跨调用记忆。历史默认保留当前回合、上一轮敌方响应，以及仍影响当前决策的计数、延迟或牌序信息。

Jev 在代码提供的目标与候选空间中选择构筑方向、回合目标、准备动作、顺序和完整方案。回合目标是可修订的意图，服从整局价值。普通连续出牌沿用计划；抽牌、变形、回收／选牌、未计算的费用变化及新能力等，在原生结果可见后继续规划。框架与候选生成由代码定义，模型负责其中的判断；当前没有完整的跨回合战斗求解器。

完整方案包含从不同合法起手独立展开的有序段，也保留模型原提案及局部替换。搜索按起手和长度分配候选，记录搜索与采样上限，不按伤害评分预先筛掉策略。入围方案与原提案直接比较，并交换 A/B 位置复核；分歧和并列保留在日志中。每对方案直接提供完整描述。

能量预留、候选描述和方案比较共用一次有序状态计算。已核实的升级、属性变化和 X 费支付只影响后续动作；起始牌面不会被当成始终不变的未来数值。完整方案列出消耗／保留的药水、格挡的有效期、已计算的伤害与倒计时、需要重新观察的位置。未计算的状态变化不会凭空生成新牌或确定的结束回合结果。

效果表明确区分已生效能力与尚未打出的牌／药水，提供来源、作用对象、触发时机和失效时间。例如反伤按命中触发，Flame Barrier 持续到敌方回合结束，One-Two Punch 要在玩家回合结束前获得攻击消费者。方案同时列出已计算的回合末伤害、未计算效果以及临时增益的使用情况。

条件算术只覆盖已核实的机制。未知触发、随机抽牌、未揭示房间和未来敌人随机动作保持未知；局部数字不能当成完整模拟。命令结果不明确时停止并保留待核对状态，不自动重发。

## 历史回放

最新[知识与规划回归](docs/knowledge-evaluation.md)使用已接触过的旧局面，记录知识接入、目标选择、布局敏感性和实际开销。这不是新的独立测试集。[上一轮划分](eval/sequence-split.json)及[有序依赖结果](docs/sequence-evaluation.md)、[效果时序报告](docs/harness-evaluation.md)继续保留。原始历史存于本机 `run-artifacts/`，不随仓库分发；回放只向 Jev 请求决策，不连接游戏命名管道。冻结同时覆盖代码、schema 与本地 JSON 知识源。

```powershell
# 从开发局的某一步提取当时观察与此前已确认的记忆
npm run replay -- collect --split eval/sequence-split.json --output run-artifacts/replay-example --step run-artifacts/<session>/step-0001 --id example

# 对同一个快照运行当前代码；结果包含原始请求、模型返回和有序方案
npm run replay -- replay --split eval/sequence-split.json --output run-artifacts/replay-example --case run-artifacts/replay-example/cases/example.json
```

可用 `--code <旧版本目录>` 对比旧 harness，用 `--repeat 2` 保留重复结果。快照带有输入哈希；留出集在代码冻结后运行。评估比较具体规则、顺序、资源和后果，不能把“选择变了”或模型高置信度直接当成改善。

主循环和回放保存实际请求及完整响应，包括提供方返回的概率分布与置信度。置信度反映该次选择分布的集中程度，不是通关概率，也不保证选择正确。

## 代码结构与检查

| 位置 | 职责 |
|---|---|
| `src/mod_client.mjs`、`src/mod_loop.mjs` | 模组通信、执行核对与运行记录 |
| `src/decision_context.mjs`、`src/context_compiler.mjs`、`schemas/` | 状态契约、记忆、统一模型上下文与容量管理 |
| `src/rule_reference.mjs`、`src/effect_lifecycle.mjs` | 规则关联、效果时序与有效期 |
| `src/enemy_patterns.mjs`、`src/strategy_knowledge.mjs`、`data/strategy/` | 怪物后继、角色建议、复活与战斗进展 |
| `src/turn_plan*.mjs`、`src/turn_sequence.mjs`、`src/turn_projection.mjs` | 有序回合计划、依赖传播、观察断点和有限效果分析 |
| `src/turn_candidates.mjs` | 独立有序候选、覆盖记录和入围方案复核 |
| `src/run_strategy*.mjs`、`src/camp_plan*.mjs` | 构筑方向和跨界面意图 |
| `scripts/replay_harness.mjs` | 无游戏操作的历史对照回放 |
| `native/WindowDriver/`、录屏脚本 | 可选窗口诊断与录像，不参与正常决策 |

```powershell
npm test
```

[当前计划](docs/plan.md) · [上下文架构](docs/context-architecture.md) · [决策管线](docs/decision-pipeline.md) · [历史战况](docs/full-run-progress.md)
