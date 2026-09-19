# Slay the Spire 2 Agent Loop：当前执行计划

更新：2026-09-20。目标是 **Jev 在同一局标准游戏中，从第一幕开始，经过第二幕和第三幕，击败最终 Boss，进入正式胜利结算**。当前尚未完成这一目标，真实整局测试持续进行。

## 当前实现

- 主路径是 Node.js 编排 → 本机命名管道 → 游戏内 C# 模组。Jev 负责策略选择，模组执行原生动作，游戏自行结算和渲染。
- 每次请求发送自包含的 `sts2.decision.v1` JSON：本局与玩家资源、永久卡组、战斗各牌堆、敌人可见意图与能力、地图及后续路线、当前交互、相关历史和 `legal_actions`。不假定 Jev 记住上一次调用。
- 本地保存各局记忆和动作结果；每次执行前后重读状态。状态变化时重新决策，结果不明的动作保留待核对状态，不自动重放。
- 已接入地图、战斗、药水、事件、奖励与跳过、商店购买与删牌、休息、升级、附魔、遗物与多种选牌界面及幕间过渡。罕见机制随实测补齐。
- 默认无 Python、无额外常驻窗口驱动。截图和 Computer Use 是可选补充，正常循环不依赖前台或置顶。

当前部署模组为 `0.111.0-context.7`，针对本机游戏 v0.111.0 编译。91 项 Node 测试通过。已经完成过第一幕并到达第二幕 Boss；整局结果和具体问题见[实测进展](docs/full-run-progress.md)。测试通过不等于已经通关。

## 正在执行

1. 持续进行真实 Jev 请求与真实游戏动作，沿同一局继续推进。
2. 遇到失败或阻塞，检查可见状态、完整候选、规则说明、明确计算、执行与等待。修复实际问题后继续；正式失败后允许正常开始新局。
3. 只使用玩家能查看、观察和记住的信息。隐藏抽牌顺序、RNG、未来随机结果保持未知。不编辑存档，不作弊，不重置战斗，也不拼接不同局的成功片段。
4. 游戏内模组需要更新时，在已结束战斗的稳定界面正常退出、部署并继续。策略选择始终交给 Jev；唯一合法动作和纯流程推进由代码执行。
5. 按项目约定直接在 `master` 开发和 commit，不创建本项目 PR。CLI 模组的实际缺陷可单独修复并向上游贡献；已有[兼容修复 Draft PR](https://github.com/longkerdandy/STS2-Cli-Mod/pull/1)。

## 完成条件

- [x] 完整决策上下文真正接入主循环，并完成必要构建与测试。
- [x] 普通奖励后继续游戏，移除原型的一场战斗停止限制。
- [ ] 同一局从第一幕经过三幕，击败最终 Boss，进入正式胜利结算。
- [ ] 在主分支提交最终实现，并同步实际运行结果和重要限制。
- [ ] 更新[现有飞书方案文档](https://icnainlav1b8.feishu.cn/docx/Ijr1dLJpio6JvNxfcAfcnvXKnUR)，展示最终胜利截图后，才结束 goal。

飞书正文和原架构画板已更新为当前实现，最终通关结果仍待完成。

## 运行与资料

- `npm start -- --max-steps 3000`：持续执行当前存档或正常新局。
- `npm run context:preview`：只读查看当前 JSON，不调用 Jev、不发送游戏动作、不修改记忆。
- `npm test`：运行离线回归测试。
- [决策上下文与 JSON 协议](docs/decision-context.md)、[Schema](schemas/decision-context.v1.schema.json)、[合成示例](docs/examples/decision-context.v1.json)。
- [架构图](docs/agent-loop.png)、[技术选型与早期资源验证](docs/technology-selection.md)、[早期单场战斗记录](docs/validation-2026-09-20.md)。早期记录只证明当时的单场后台运行。

仓库：[Sskift/jev-sts2-agent](https://github.com/Sskift/jev-sts2-agent)。实际运行日志和完整记忆保存在本机 `run-artifacts/`，不将凭据、存档或编译 DLL 提交到仓库。
