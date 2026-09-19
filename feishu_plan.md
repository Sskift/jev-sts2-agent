# Slay the Spire 2 Agent Loop：模组状态与动作、Jev 决策、视觉后备

更新：2026-09-20。本文是仓库中的当前执行计划；用户已明确授权安装 STS2-Cli-Mod，并允许结构化状态和游戏动作替代 Computer Use。目标仍是**完成一场真实战斗**。进入战斗前必须经过的菜单、地图与事件属于本轮；战后多房间推进、构筑和通关属于后续。

## 1. 结论与当前进度

主路线改为：**Node 读取 mod state → 代码列出合法完整动作 → Jev 选一步 → Named Pipe 请求游戏内 C# mod → 游戏动作执行 → 重读 state 确认**。默认可以完全不截图、不调用 Opus、不启动窗口驱动；游戏动作本身照常渲染动画。CU 只在需要时用于未覆盖弹窗，未来也可由模组补齐相关界面。视觉诊断和截图留证均为可选，不能强耦合到主循环。

[私有仓库 Sskift/jev-sts2-agent](https://github.com/Sskift/jev-sts2-agent)保存本计划、实现和测试。[技术选型与资源预算](docs/technology-selection.md)说明为何使用 Node + C#，以及截图、输入和语言选择的性能取舍。**本轮已完成一场真实战斗**：`NIBBITS_WEAK`，从菜单到奖励约 40.4 秒，17 轮观察、11 条成功命令，其中 6 次出牌、2 次结束回合。战后画面为 68/80 HP、20 金币与卡牌奖励，该段战斗没有使用 CU 或 Opus 操作。详见[本轮验证记录](docs/validation-2026-09-20.md)。

| 已完成的实测/工作 | 证据范围 |
|---|---|
| Jev 真实 API | 返回 `jev-1.13.0`；单次 primitive 请求约 675 ms，不是策略质量或平均延迟 |
| Opus 5 合成图 | 指定 `claude-opus-5`，HTTP 200，约 3.7 秒、矩形中心误差 2 px；系统 CA 校验通过 |
| 非前台游戏截图 | 1280×720 `PrintWindow` client 真图，前后 foreground / cursor 不变 |
| 真图 Opus/Jev dry-run | 主菜单“单人模式” `(516,504)`，未执行点击；本地记录 `run-artifacts/2026-09-19T16-21-36-656Z-6415a6a2/` |
| STS2-Cli-Mod 安装和基本通路 | release `0.102.1` 的 `ping`、`state`、`new_run` 在游戏最小化时成功 |
| 本机版本兼容处理 | 针对 STS2 `v0.111.0` 构建并部署 `0.111.0-local-compat`；不是上游正式 release |
| 未覆盖教程弹窗 | mod 当时仍报 `CHARACTER_SELECT`；截图发现弹窗，后台点击后画面进入地图 |
| Node 模组闭环 | 已接入 `mod_client`、`mod_decision`、`mod_loop`，真实 Jev 决策并完成首场战斗 |
| 战斗与后台证据 | `run-artifacts/2026-09-19T16-39-33-428Z-dcc28eb7/`；`session.json` 与第 17 步状态/截图确认奖励，28 份窗口/捕获样本为游戏非前台且 foreground/cursor 不变 |
| 终局遮挡检查 | `topmost:false`、多个更高层窗口与游戏重叠；仍正常得到后台奖励截图，最新采样见验证记录 |

这些证据不能互相代替：编译成功不证明动作生效；pipe 连通不证明出牌；主菜单识别不证明战斗完成。

## 2. 模组通道与兼容边界

[STS2-Cli-Mod](https://github.com/longkerdandy/STS2-Cli-Mod)提供 C# 游戏 mod 与独立 CLI，通过 `sts2-cli-mod` Named Pipe 交换 JSON。当前 Agent 直接使用 Node `net` 连接 `\\.\pipe\sts2-cli-mod`，不为每一步再启动 CLI 进程。上游服务器每连接处理一行 UTF-8 JSON 请求后关闭；本地客户端串行请求、限制响应大小、拒绝格式错误，不假设长连接复用。协议中的 `id` 是游戏对象 ID。[PipeServer 源码](https://github.com/longkerdandy/STS2-Cli-Mod/blob/main/STS2.Cli.Mod/Server/PipeServer.cs)

出牌接口在游戏主线程验证卡牌和目标，把 `PlayCardAction` 加入游戏队列，再返回执行信息。它能驱动真实游戏状态变化，不是屏幕点击。用户已授权该路线；无需为了复刻鼠标轨迹继续使用拖牌作为主要动作通道。[PlayCardHandler](https://github.com/longkerdandy/STS2-Cli-Mod/blob/main/STS2.Cli.Mod/Actions/PlayCardHandler.cs)

上游 release `0.102.1` 与本机 `v0.111.0` 的不兼容已实测发现，不再只是风险推测。本地编译发现三处 `CombatManager.IsPlayPhase`、五处 `MerchantRoom.Inventory` 旧 API 引用；兼容补丁改用本地玩家 `PlayerCombatState.Phase == PlayerTurnPhase.Play` 和 `GetLocalInventory()`，结束回合等待补充监听 `PlayerTurnPhaseChanged`。编译使用本机 SDK 8 的 Roslyn 与游戏自带 .NET 9 实现程序集作为引用，未安装全局 SDK 9。补丁已通过首场出牌与结束回合实测；商店等未到达路径仍未验证，不声称全模组兼容。

安装与回退材料：

| 内容 | 位置 |
|---|---|
| 已部署 mod | 游戏目录 `mods/STS2.Cli.Mod.dll`、`mods/STS2.Cli.Mod.json` |
| 版本标识 | `0.111.0-local-compat` |
| 原版 release 包与 CLI | 包位于 `temp/sts2-release/`；已安装 CLI 为 `%LOCALAPPDATA%/sts2-cli/sts2.exe` |
| 原配置备份 | `temp/mod-install-backup/settings.before-cli.save` |
| 原 release DLL 备份 | `temp/mod-install-backup/STS2.Cli.Mod.release.dll` |
| 兼容补丁与可复现构建 | 仓库 [mods/sts2-cli-compat](mods/sts2-cli-compat/README.md)；本地原始记录在 `temp/compat-build/` |

游戏安装在 `D:/SteamLibrary/steamapps/common/Slay the Spire 2`。配置现为 `mods_enabled:true`，`STS2.Cli.Mod` 启用，已安装的 `RebalancedRegentForging v2.3.0` 单独禁用。启用前的全局 `mods_enabled:false` 属于历史状态。游戏日志确认只加载一个 mod；不要顺带启用修改玩法的模组。回退应在退出游戏后进行，保留后续存档进度。账号标识、凭据和整个个人配置不提交仓库，`temp/` 默认只在本机保留。

## 3. 模型、普通代码与游戏的职责

| 环节 | 负责者 | 输入与输出 |
|---|---|---|
| 权威状态提取 | 游戏内 mod | 当前场景、卡牌、目标、资源、意图、可执行性等 JSON |
| 候选生成 | Node | 当前 state → 完整动作请求，含卡牌副本、目标和必要参数 |
| 选择一步 | Jev | state + 候选 + 最近动作结果 → 一个候选 ID |
| 执行 | Node Named Pipe → C# mod | 请求校验后在游戏主线程执行实际动作 |
| 确认 | Node 重读 state | 资源、手牌、敌人、回合或场景变化 |
| 界面盲区 | 截图 + Opus 5 / 人工观察 + CU | 识别模组未覆盖的弹窗，再执行有限 UI 动作 |
| 留证 | 状态日志 + 按需截图 | 解释决策、动作结果和最终胜利 |

Jev 接收结构化文本而非图片，第一版每步只问一次 `choice`。枚举完整“卡牌副本 + 目标”，避免把独立选牌和选敌的结果错误拼接。它选择已有候选，不生成任意游戏命令或鼠标脚本。`noul` / `score` 留作未来窄判断，不是本轮前置要求。[TypeSafe API](https://docs.typesafe.ai/api)、[Choice](https://docs.typesafe.ai/primitives/choice)、[Function calling](https://docs.typesafe.ai/cookbooks/function_calling)

Jev 使用 `.env` 或环境变量的 `TYPESAFE_API_KEY`。Opus 后备固定 `claude-opus-5`，从本机 Claude 配置读取地址与凭据；`node --use-system-ca` 维持 TLS 验证。置信度不是完整系统成功率，不引入未经验证的固定阈值替代动作确认。

## 4. 结构化状态与完整动作

| 场景 / 数据 | 决策和执行规则 |
|---|---|
| `MENU` / `SINGLEPLAYER_SUBMENU` | 优先继续已有 run；明确没有 run 时才新建，选标准单人模式 |
| `CHARACTER_SELECT` | 只选未锁定角色；已选 Ironclad 且可出发时 embark，不重复切换角色 |
| `MAP` | 只从 `travelable_coords` 枚举节点，优先普通战斗以完成本轮验收 |
| `EVENT` | 根据对话、锁定选项和完成标记推进进入战斗所需的事件 |
| `COMBAT` | 仅玩家 play 阶段、动作未禁用、战斗未结束且玩家存活时列候选 |
| 卡牌 | 使用 `can_play` 与实际描述；同名卡用游戏 ID + `nth` 区分，手牌 index 不能直接代替 `nth` |
| 目标 | 使用 `combat_id`，不是数组位置或屏幕像素；按 `target_type` 匹配活敌/盟友 |
| 结束回合 | 作为合法完整候选；0 能量仍保留 `can_play` 的零费牌 |
| 必选牌层 | 按提示和数量约束生成弃牌/消耗/网格选择候选，拒绝缺参数的部分动作 |
| `REWARD` / `GAME_OVER` | 当前作为验收或失败检查点，不在成功后继续下一场战斗 |

候选上限、未知状态、缺失 ID、接口错误都显式处理，不默选第一个对象。只支持已实现和当前状态能证明合法的动作；上游支持某个命令，不等于本地候选生成或兼容补丁已经覆盖该路径。

Jev 返回后，在发动作前再次读取 state；若动作相关 fingerprint 已改变，则丢弃旧选择重新观察。每次只执行一步，动作响应后等待再读 state。传输超时、断连或应用错误停止本次循环；已发送动作可能已生效，不能自动重放。连续三次动作无状态变化时停止排查弹窗；持续没有合法候选也有有限观察次数，不无限忙等。

## 5. 视觉与 Computer Use 后备

已经遇到真实盲区：新手教程覆盖界面时，mod 仍返回 `CHARACTER_SELECT`。因此“结构化 state 返回正常”不等于画面没有 modal。`temp/mod-tutorial.png` 与 `temp/mod-after-tutorial.png` 记录了教程到地图的变化，`temp/mod-tutorial-dismiss.json` 记录后台 `PostMessage` 输入及未改变 foreground/cursor。此次已由实景坐标处理，不把 `(530,483)` 写成通用教程按钮坐标。

视觉/CU 路线为按 HWND 捕获 client → 识别当前可见按钮 → client 坐标点击 → 重读结构化 state 并检查图像。C# 驱动常驻，JSON-lines 与 Node 通信；默认 `PrintWindow` / `PostMessage`，不用 Python、`SetCursorPos` 或整屏截图作为主要机制。当前建议 client 1280×720，不能把旧图坐标用于已改变的窗口尺寸。

模组基本命令已在最小化状态成功；窗口截图驱动目前明确拒绝最小化窗口。需要视觉后备和终局截图时恢复普通窗口，仍不要求永久置顶。后台和遮挡截图要按当前 GPU/渲染器实际验证；若 `PrintWindow` 黑帧或旧帧，再考虑 WGC。

默认允许用户并发移动光标和切窗口，前后状态差异标记为来源未知，不自动归咎于 Agent。`--strict-desktop` 是视觉循环的可选无人干预检测。用户允许必要时短暂聚焦，但实际使用须留证，不把授权写成已完成的聚焦后备实现。

早期 [流程图](docs/agent-loop.png) / [Mermaid 源码](docs/agent-loop.mmd)描述的是视觉闭环分支；当前主路线以本节和前述模组闭环为准。

## 6. 工程入口与操作顺序

| 文件 / 命令 | 作用 |
|---|---|
| `src/mod_client.mjs` | 模组 Named Pipe、串行协议和错误处理 |
| `src/mod_decision.mjs` | 结构化完整候选及 Jev choice |
| `src/mod_loop.mjs` | 主循环、过期状态拦截、动作确认、无进展停机和战斗记录 |
| `src/vision_opus.mjs` / `src/decision_jev.mjs` | 视觉后备的识别与候选 |
| `src/agent_loop.mjs` | 现有视觉循环与 dry-run |
| `src/window_driver.mjs` / `native/WindowDriver/` | 可选常驻 .NET 8 窗口驱动 |
| `npm start` / `npm run start:mod` | 当前结构化主入口与显式别名，默认最多 80 步 |
| `npm run mod:state` | 只读检查当前 mod 状态 |
| `npm run build:driver` / `npm run window:status` | 构建窗口驱动 / 检查真实 client 尺寸 |
| `npm run start:vision` | 保留的视觉后备通道，不是模组主循环 |

```powershell
# 通过 Steam 启动本机游戏
& 'C:\Program Files (x86)\Steam\steam.exe' -applaunch 2868840 --windowed --resolution 1280x720

node src/mod_client.mjs ping
npm run mod:state
npm start -- --max-steps 80
```

如需截图，先 `npm run build:driver`，再加 `--screenshots`；不带它时不启动窗口驱动，也无需为正常运行编译它。最小化或截图失败会留记录/跳过截图，不能直接认定模组不工作。Ctrl+C 请求停止；当前请求返回后收尾。测试使用 `npm test`，离线视觉模拟 `npm run sim`，模型独立验证 `npm run test:jev` / `npm run test:opus`；测试数量和结论以本轮实际输出为准。

## 7. 执行检查表与完成标准

- [x] 确认模型配置与 TLS，真实调用 Jev / Opus 5。
- [x] 将主要运行依赖调整为 Node + C#，去除 Python/Pillow 运行要求。
- [x] 在非前台状态得到 1280×720 真游戏 client 截图，验证视觉后备的菜单识别。
- [x] 按用户授权安装 STS2-Cli-Mod，备份原配置和 release DLL，仅启用指定 mod。
- [x] 在最小化状态实测 `ping`、`state`、`new_run`，确认基本后台通道。
- [x] 针对本机 `v0.111.0` 编译部署兼容补丁，保留源补丁与构建记录。
- [x] 接好 Node → mod state → Jev 完整候选 → mod action → state 的运行入口。
- [x] 识别教程弹窗盲区，通过截图/CU 后备处理并进入地图。
- [x] 进入一场真实战斗，保存活敌、玩家、手牌和回合的初始状态。
- [x] 由 Jev 选择具体牌副本与目标，执行真实出牌，并确认手牌/能量/敌方 HP 等对应变化。
- [x] 实测结束回合与下一玩家回合，确认兼容补丁覆盖实际 play 阶段。
- [x] 完成同一场战斗，确认玩家未败且出现真实战后奖励，保存结构化连续记录；本次另附终局截图。
- [x] 核对本次模组动作、教程 CU 例外和非前台捕获记录，限定结论为本次单场验收。

代码的完成标记要求本次循环见到存活敌人、至少一次成功出牌响应、随后非空 `REWARD` 且未出现失败；核验还要检查实际变化与连续证据。截图是可选佐证，CU 或 Opus 不是必需条件。起点已经在奖励页、单个 `ok:true`、离线 fixture 或截图 hash 改变均不足以验收。

**本阶段完成标准是一场战斗。** 战后奖励选择、第二房间、商店购买、药水、更多特殊资源和通关在后续推进；没有为本轮额外增加“跨两个房间”门槛，也不把目标缩减成“模型连通”或“成功打出一张牌”。

## 8. 证据与后续范围

每步保存 `before-state.json`、`decision.json`、`pre-action-state.json`、`response.json`、`after-state.json`、`result.json`；可选保存同一步的前后 PNG、窗口与捕获记录。`session.json` 汇总 encounter、出牌数、结束回合数、完成/失败/停机原因。最近动作及真实结果回传 Jev，避免重复已无效操作。原始文件位于 `run-artifacts/`，默认不提交 Git；可提交经检查的验证总结。

后续再做全模组兼容矩阵、自动识别未覆盖 modal、状态变化更细致确认、截图留存限额和资源基准。尚未完成同负载 CPU/GPU/内存基准，不从 40.4 秒单次运行推算平均性能。对每个命令分别记录版本、最小化/遮挡状态和实测结果，不用上游“全流程”功能介绍替代本机证明。

一手资料：[STS2-Cli-Mod 源码](https://github.com/longkerdandy/STS2-Cli-Mod)、[命令参考](https://github.com/longkerdandy/STS2-Cli-Mod/blob/main/docs/cli-reference.md)、[Releases](https://github.com/longkerdandy/STS2-Cli-Mod/releases)、[TypeSafe 文档](https://docs.typesafe.ai/llms.txt)、[游戏官方商店页](https://store.steampowered.com/app/2868840/Slay_the_Spire_2/)。外部接口以本次使用的源码和版本为基线，更新游戏或模组后重新验证。
