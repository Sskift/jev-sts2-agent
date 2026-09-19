# Slay the Spire 2 Agent Loop：Opus 5 识别、Jev 决策、Computer Use 执行

更新：2026-09-19。先完成一场可见的自动战斗，再接上奖励、地图和事件。首版采用单人模式，不把最优策略、流派构筑或通关作为前置条件。

## 1. 结论与当前进度

主循环确定为“截图 → Opus 5 提取局面和坐标 → 代码列出可执行动作 → Jev 选一个动作 → 鼠标点击或拖拽 → 等待动画 → 重新截图”。Opus 5 使用本机 Claude Code 的地址和凭据，模型明确指定 `claude-opus-5`；Jev 使用项目 `.env` 的 TypeSafe key。

独立私有仓库 [Sskift/jev-sts2-agent](https://github.com/Sskift/jev-sts2-agent) 已存在，TypeSafe skill 已安装。2026-09-19 重测 Jev：三种 primitive 同一次请求返回 HTTP 200，实际模型 `jev-1.13.0`，单次约 675 ms，输入 487 tokens、输出 71 tokens。这只是一次小样本接口测试，不代表游戏局面的平均速度或决策质量。

Opus 5 的合成图片探测遇到 `ENOTFOUND`：当前 Claude Code 所配置网关的主机名无法解析，尚未收到 HTTP 响应。因此不能标记“Opus 视觉已调通”。本机已安装游戏于 `D:/SteamLibrary/steamapps/common/Slay the Spire 2`，本次检查版本为 `v0.111.0`；游戏未运行，本轮没有完成真实出牌验证。

首版完成与否以“真实游戏里打出牌，并从下一帧确认生效”为准。模拟运行、离线测试和 API 连通性分别记录，不能合并成“自动游玩已完成”。

## 2. 游戏能否读取状态和使用 CLI

游戏通过战斗、奖励、地图和房间交互推进。战斗中需要读手牌效果、费用、目标及敌人意图；房间之间需要选奖励、选路、处理营地、商店和事件。每张牌后局面可能改变，第一版每次只执行一个动作，再读新画面。具体规则以实机为准：本机已有影响玩法的 `RebalancedRegentForging v2.3.0` mod，不能把网上默认数值写死。[Mega Crit 官方 FAQ](https://www.megacrit.com/faq/)。

本次未找到官方公开、稳定、面向外部 agent 的完整状态与动作 API。社区已有真正针对二代的 [STS2-Cli-Mod](https://github.com/longkerdandy/STS2-Cli-Mod)：C#/.NET 9 mod 和 CLI 通过 `sts2-cli-mod` Named Pipe 交换 JSON，提供 `sts2 state`、出牌、结束回合、地图和奖励等动作。其出牌处理器把动作加入游戏 ActionQueue，不是模拟鼠标。mod 可驱动可见的游戏变化；若要展示鼠标轨迹，仍用 Computer Use。[PipeServer](https://github.com/longkerdandy/STS2-Cli-Mod/blob/main/STS2.Cli.Mod/Server/PipeServer.cs)、[PlayCardHandler](https://github.com/longkerdandy/STS2-Cli-Mod/blob/main/STS2.Cli.Mod/Actions/PlayCardHandler.cs)。

该 mod 的手牌、敌人 DTO 没有像素坐标，地图 `col/row` 是拓扑位置，不能直接拿来点击。最新公开 release 为 `v0.102.1`，与本机 `v0.111.0` 的兼容性尚未实测。它适合作为可选状态对照通道，暂不成为首版依赖；默认仍用 Opus 5 看图、Computer Use 操作。[CardStateDto](https://github.com/longkerdandy/STS2-Cli-Mod/blob/main/STS2.Cli.Mod/Models/State/CardStateDto.cs)、[EnemyStateDto](https://github.com/longkerdandy/STS2-Cli-Mod/blob/main/STS2.Cli.Mod/Models/State/EnemyStateDto.cs)、[Releases](https://github.com/longkerdandy/STS2-Cli-Mod/releases)。这些源码证明能力存在，不代表已在本机跑通。

## 3. Opus、Jev 和普通代码的职责

| 环节 | 负责者 | 输入与输出 |
|---|---|---|
| 看懂画面 | Opus 5 | 截图 → 场景、是否玩家回合、数值、牌面效果、目标、按钮和坐标 |
| 产生候选 | 普通代码 | 识别结果 → 完整动作，例如“第 2 张牌对第 1 个敌人” |
| 选择一步 | Jev | 局面与候选 → 一个 choice 候选 ID 及概率分布 |
| 执行动作 | 普通代码 + Windows 输入 | 候选 ID → 本帧坐标 → 一次点击或拖拽 |
| 观察结果 | 下一轮 Opus 5 | 新截图 → 新局面，确认牌、能量或界面是否变化 |

Jev 接收文字或 JSON，不接收图片，不生成任意文本或鼠标脚本。HTTP 接口为 `POST https://api.typesafe.ai/v1/systemone`，请求包含 `state`、`model`、`questions`。`choice` 选择有限候选；`noul` 返回命题为真的概率；`score` 返回有序等级的概率加权值，等级从 0 开始，并非固定 1–5 分。[TypeSafe State](https://docs.typesafe.ai/concepts/state)、[API](https://docs.typesafe.ai/api)、[Score](https://docs.typesafe.ai/primitives/score)。

第一版每步只用一次 `choice`。同批问题看不到彼此答案，不宜独立问“选哪张牌”和“打哪个敌人”再拼接。代码枚举“卡牌槽位 + 目标槽位”的完整候选；无目标牌只含卡牌槽位，并把可用的结束回合加入候选。一次选择就有完整执行参数。以后候选规模较大时，再拆成选牌后第二次选目标。[Function calling](https://docs.typesafe.ai/cookbooks/function_calling)、[Fan-out](https://docs.typesafe.ai/patterns/fan-out)。

`noul` 可留给后续窄判断，`score` 可用于风险比较，不必为了用齐模型能力进入首版。confidence 表示分布集中程度，不是全流程正确率；这轮不引入未经样本验证的 `0.85` 结束回合阈值。[Confidence](https://docs.typesafe.ai/confidence)。

## 4. 识别结果与动作候选

Opus 的 GameState 至少包含以下字段。读不到的值用 null，不猜数值；文字被遮挡时，后续补悬停读取。以下是接口设计，不是真实战斗样本。

| 字段 | 含义 |
|---|---|
| `scene`、`player_turn` | 场景；玩家回合 true、敌方回合 false、不确定 null |
| `screen_size` | 本次图片的像素宽高，供坐标检查及后续变换 |
| `player` | HP、上限、格挡、能量；其他角色资源后续按需补充 |
| `cards[]` | 槽位、名称、费用、description 牌面效果、可出标记、目标要求、坐标 |
| `enemies[]` | 槽位、名称、HP、格挡、意图文本和伤害、坐标 |
| `end_turn_btn`、`play_area` | 结束回合按钮、无目标牌释放位置 |
| `selectable_options[]` | 可点击选项、描述、可用性及坐标；地图只列可达节点 |

同名牌可能同时存在，所以代码以本帧数组槽位生成唯一候选标识，不依赖卡名或跨帧固定 ID。精确费用比较、候选与坐标映射由代码完成，Jev 看到的是牌面效果、当前局面和动作定义。

例如一张攻击牌、一张防御牌和两个敌人可以产生“攻击牌→敌人 A”“攻击牌→敌人 B”“防御牌”“结束回合”四个候选。选中第二项后，代码取本帧攻击牌与敌人 B 的坐标构造拖拽；Jev 不负责生成坐标。

能量为 0 仍可能有零费牌可出，不能直接结束回合。未知费用、X 费及特殊资源需要另做规则支持，首版不假定已经覆盖。接口错误或未知候选不默选第一张牌，以免把服务故障伪装成有效决定。

## 5. 从语义动作到 Computer Use

| 选择结果 | 执行动作 | 下一帧验证依据 |
|---|---|---|
| 定向出牌 | 从牌中心拖到选中敌人命中区，松开 | 手中牌、资源或目标状态变化 |
| 无目标出牌 | 从牌中心拖到本帧 play_area，松开 | 手牌、资源或状态变化 |
| 结束回合 | 点击本帧 End Turn 坐标 | 回合阶段变化 |
| 奖励、地图、休息、事件 | 点击本帧所选选项 | 场景或选项变化 |
| 敌方回合、动画、信息不足 | 等待并重新截图 | 新的可操作画面 |

选奖励后出现 Proceed、升级后出现选牌层、出牌后出现弃牌层，都作为下一轮新场景处理；不要预先写死一串点击。输入函数未报错不等于动作成功，必须通过新画面确认。

当前 Python 执行器使用 Pillow 截取主屏，用 DPI awareness、SetCursorPos 和 mouse_event 点击及平滑拖拽。约 0.35 秒的拖拽仅为初始参数，尚无“100% 成功”证据。无目标牌不能固定上移 500 像素，结束回合也不能固定为某台 4K 屏幕的坐标。

下一步先把游戏放在主屏，固定窗口大小校准；再补客户区截图和坐标变换。若窗口原点 `(L,T)`、客户区大小 `(W,H)`、发送图大小 `(w,h)`，识别点 `(x,y)` 对应桌面 `(L+x*W/w, T+y*H/h)`。模型侧图像缩放也需实际标定，不能仅凭提示词保证坐标。现有原型尚未实现完整窗口裁剪与逆变换。

每次动作后重新截图，不复用旧坐标连续出牌。手牌太小或遮挡时再补“悬停 → 局部截图 → Opus 补齐牌面”，目前该能力在计划中。

<!-- LOOP_DIAGRAM -->

[查看闭环流程图](docs/agent-loop.png) · [Mermaid 源码](docs/agent-loop.mmd)

## 6. 工程现状与本轮修复

| 文件 | 用途与边界 |
|---|---|
| `src/vision_opus.mjs` | 本机配置读地址和凭据，指定 Opus 5，解析局面 |
| `src/decision_jev.mjs` | 组装完整动作候选，调用 Jev 并解析 choice |
| `src/computer_use.py` | 主屏截屏、点击、平滑拖拽；真实坐标待标定 |
| `src/agent_loop.mjs` | 单轮编排、动作计划、离线模拟与 dry-run |
| `test/` | 离线回归；不代表真实游戏验证 |
| `feishu_plan.md` | 本方案本地副本 |

本轮修复影响后续联调的具体问题：模拟运行仍调用真实鼠标、全局关闭 TLS 校验、打印凭据、硬编码动作坐标、跳过零费牌、同名牌覆盖、选牌与目标独立、错误时默选第一项。保留 Node.js + Python 结构，不增加大型调度框架。

验证结果：12 项离线回归通过，模拟 CLI 通过且没有调用模型、截图或鼠标；Jev 的三个 primitive 及新决策模块的单候选请求均通过真实 API 验证。Opus 图片请求仍因 ENOTFOUND 失败，真实游戏尚未验证。

## 7. 实现顺序和完成标准

| 顺序 | 实现内容 | 完成时可看到的结果 |
|---|---|---|
| A | 修通当前 Claude Code 网关解析，再用合成图验证指定 Opus 5 | 收到识别 JSON，而非仅打印配置 |
| B | 实景截图与坐标标定，补齐牌面、释放区 | 真实战斗图转换成正确动作计划 |
| C | 单步执行，重拍确认出牌及结束回合 | 可见拖拽、扣费和回合流转，完成一场战斗 |
| D | 奖励、地图、休息、事件及选择牌/确认层 | 战后进入下一房间 |
| E | 按需补商店、药水、特殊费用、悬停 | 覆盖更多界面，再逐步改进策略 |

每步保存截图、识别结果、候选、Jev 答案和执行动作，便于判断是看错、选错还是点错。先以一场战斗和两个房间之间的推进作为里程碑，完整通关留待后续。CLI mod 只在确实需要状态对照时接入。

本轮交付调研、可执行方案及原型修复；真实游玩的前置问题仍是 Opus 网关解析和实景联调。已安装游戏、已写代码或一次 Jev 成功请求，都不能标记为全链路完成。

## 8. 一手资料

- [TypeSafe skill](https://github.com/typesafe-ai/skills/blob/main/skills/typesafe-ai/SKILL.md)
- [TypeSafe 文档索引](https://docs.typesafe.ai/llms.txt)、[Choice](https://docs.typesafe.ai/primitives/choice)、[Noul](https://docs.typesafe.ai/primitives/noul)
- [Slay the Spire 2 官方页面](https://store.steampowered.com/app/2868840/Slay_the_Spire_2/)
- [STS2-Cli-Mod 场景与动作参考](https://github.com/longkerdandy/STS2-Cli-Mod/blob/main/docs/cli-reference.md)

外部接口和版本信息以本次读取、探测为准；社区能力来自作者源码，本机兼容性另行验证。
