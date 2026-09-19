# jev-sts2-agent

Windows 上的《Slay the Spire 2》Agent Loop：**Node 读取游戏 mod 的结构化状态 → Jev 选择完整动作 → Named Pipe 调用游戏动作 → 重读状态确认**。用户已授权采用 STS2-Cli-Mod，截图、Opus 5 和 Computer Use 用于未覆盖弹窗与验收留证。**已实测推进至第二幕 Boss，正在以同一局三幕通关为验收继续开发。**

[仓库执行计划](feishu_plan.md) · [技术选型与资源预算](docs/technology-selection.md) · [飞书方案](https://icnainlav1b8.feishu.cn/docx/Ijr1dLJpio6JvNxfcAfcnvXKnUR)

当前阶段是整局通关开发与实测。每个 Jev 请求自带本局、玩家、永久卡组、地图、战斗各牌堆、相关历史和 `legal_actions`，已接入真实游戏。循环能继续普通奖励，并处理事件、选牌、商店、药水与休息；最终成功要求同一局经过三幕并显示正式胜利结算。[当前进展和待验证项](docs/full-run-progress.md)与下面旧版单场战斗记录分开维护。

当前部署构建为 `0.111.0-context.6`。`npm run context:preview` 可以只读检查完整请求，不调用 Jev、不执行游戏动作。本项目在 `master` 直接提交，不为自身改动提 PR。

## 早期单场验证记录

- 运行栈为 Node.js + 游戏内 C# mod；可选常驻 C# / .NET 8 窗口驱动负责截图和 CU 后备。不需要 Python 或 Pillow。
- 已安装 [STS2-Cli-Mod](https://github.com/longkerdandy/STS2-Cli-Mod) 的 `0.102.1` release，并实际验证 `ping`、`state`、`new_run` 在游戏最小化时成功。该结果只覆盖已测命令，不能推及完整战斗。
- 原 release 对本机 `v0.111.0` 存在旧 API 不兼容。已编译并部署 `0.111.0-local-compat`，替换 `IsPlayPhase` / `Inventory` 等调用；出牌和结束回合已通过首场战斗，商店和其他未走到的路径仍未实测。
- 首场 `NIBBITS_WEAK` 从菜单到奖励约 40.4 秒，17 轮观察、11 条成功命令，其中 6 次出牌、2 次结束回合。战后画面为 68/80 HP、20 金币与卡牌奖励；该段战斗没有用 CU 或 Opus 操作。
- 已发现模组未识别的新手教程弹窗：当时结构化 `screen` 仍为 `CHARACTER_SELECT`。借助截图和一次后台 `PostMessage` 点击后进入地图。这显示该弹窗当时需要另一种处理途径；可选择 CU 或补模组覆盖，不代表 CU 是固定依赖。
- 配置现为 `mods_enabled:true`，仅 `STS2.Cli.Mod` 启用；已安装的 RebalancedRegentForging 保持禁用。
- 旧视觉通道已验证 1280×720 非前台真截图、Opus 5 主菜单识别和 Jev 选择“单人模式”。这些是可复用能力，未作为“完成战斗”的证据。

战斗记录为 `run-artifacts/2026-09-19T16-39-33-428Z-dcc28eb7/`；`session.json` 标记 `battle_complete`，`step-0017/before-state.json` 与 `before.png` 共同确认战后奖励。28 份窗口/捕获样本均为游戏非前台、foreground/cursor 不变；终局另外检查到 `topmost:false` 且有多个更高层窗口与游戏重叠，后台奖励截图仍正常。详见[本轮验证记录](docs/validation-2026-09-20.md)。这证明本次单场后台运行成功，不代表所有场景、最小化战斗或长时间策略都完成验证。

## 环境、安装位置与备份

默认运行只需 Windows、Node、Steam、游戏及已安装的兼容 mod；不需要截图、Opus 或额外 C# helper。游戏内动作照常渲染动画，不必用 CU 播放动画。本机已确认 Node `v25.8.1`、.NET SDK `8.0.408`、STS2 `v0.111.0`；游戏自带 .NET 9 runtime。本地兼容构建使用 SDK 8 Roslyn 与游戏程序集，未安装全局 .NET 9 SDK。只有重建 mod 或使用可选窗口驱动时才需相应开发工具，详见[技术选型](docs/technology-selection.md)。

| 内容 | 本机位置 |
|---|---|
| 游戏安装目录 | `D:/SteamLibrary/steamapps/common/Slay the Spire 2` |
| 当前 mod | 游戏目录下 `mods/STS2.Cli.Mod.dll`、`mods/STS2.Cli.Mod.json` |
| 原 release 包与已安装 CLI | 包位于 `temp/sts2-release/`；CLI 为 `%LOCALAPPDATA%/sts2-cli/sts2.exe`，Agent 直接连 pipe |
| 启用 mod 前的配置备份 | `temp/mod-install-backup/settings.before-cli.save` |
| 原 release DLL 备份 | `temp/mod-install-backup/STS2.Cli.Mod.release.dll` |
| 兼容补丁与可复现构建 | 仓库 [mods/sts2-cli-compat](mods/sts2-cli-compat/README.md)；本地原始编译记录位于 `temp/compat-build/` |

上述 `temp/` 是本机工作材料，默认不随 Git 提交。恢复前退出游戏；只恢复本次改变的 mod DLL/manifest 或配置，避免覆盖后续游戏进度。配置源位于 `%APPDATA%/SlayTheSpire2/steam/<account>/settings.save`，仓库无需记录账号标识。

在 `.env` 设置 `TYPESAFE_API_KEY`，或通过同名环境变量提供。仅在使用视觉后备时需要 Claude 配置：从 `%USERPROFILE%/.claude/settings.json` 的 env 读取地址和凭据，支持 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN` 或 `ANTHROPIC_API_KEY` 覆盖，模型固定 `claude-opus-5`。带模型请求的项目启动命令使用 `--use-system-ca` 保持 TLS 校验；凭据不写入日志或提交仓库。

## 启动与检查

首次拉取或依赖更新后运行 `npm ci`。Node 使用锁定的 Ajv 8.20.0 校验决策协议；没有增加 Python 或额外后台服务。新版本测试顺序、部署边界和容量限制见[上下文说明](docs/decision-context.md#验证与下一阶段)。

通过 Steam 启动二代，应用 ID 为 `2868840`：

```powershell
& 'C:\Program Files (x86)\Steam\steam.exe' -applaunch 2868840 --windowed --resolution 1280x720

# 只读检查：Node 直接连接游戏的 Named Pipe
node src/mod_client.mjs ping
npm run mod:state

# 主通道：默认最多 3000 步，仅用 Node + 游戏 mod
npm start
```

Agent 不必为每条命令启动 `sts2.exe`。pipe 为 `\\.\pipe\sts2-cli-mod`；上游协议每条连接处理一行 UTF-8 JSON 后关闭，因此 Node 串行调用并为每次请求创建连接，不假设多路复用或额外 request ID。`id` 是游戏实体 ID，不能用作传输序号。已发送动作超时后先读状态，不盲目重发。

`npm start` 是结构化主循环，`npm run start:mod` 为同一路线的显式别名，默认最多 3000 步；省略 `--screenshots` 可只记录结构化数据，不启动窗口驱动。动作前重读状态，防止用户操作或动画让 Jev 的选择过时；动作后再读状态，连续三次动作无变化即停下排查。已发送动作的结果不明时停止，不自动重放。只读状态可重试短连接重建时的瞬时 pipe 错误。Ctrl+C 发出停止请求，可能需等当前请求返回。

`run_complete` 要求从第一幕开局观察到同一 run、经过 0/1/2 三个幕索引，最后读取到游戏正式 `GAME_OVER.is_victory`。普通 `REWARD` 会继续推进。进度与记忆保存在 `run-artifacts/mod-memory.json`，游戏保存的开局时间用于跨进程恢复 run 身份。下节的 `start:vision` 是保留的视觉循环。

## 视觉 / Computer Use 后备

需要看图、处理模组未覆盖弹窗或截图留证时，先编译窗口驱动：

```powershell
npm run build:driver
npm run window:status

# 为结构化主循环附加截图记录
npm start -- --screenshots --max-steps 80

# 真窗口截图与真模型，只生成一步计划
npm run start:vision -- --once --dry-run

# 视觉通道执行一步并重新观察
npm run start:vision -- --once
```

截图默认 `PrintWindow`，输入默认 `PostMessage`，坐标是游戏 client 原始像素。建议窗口为 1280×720；游戏配置可能覆盖启动参数，应以 `window:status` 为准。客户区变化后重新截图，不复用旧坐标。非前台截图已实测；**窗口驱动拒绝最小化窗口**，需要视觉后备时恢复窗口。模组通道已测部分命令能在最小化状态运行，两者不能混为一谈。

默认允许用户并发移动鼠标和切换窗口，只记录前后桌面差异。`--strict-desktop` 是可选无人干预检测，遇到变化会停止，但快照差异不能证明由 Agent 造成。用户已允许必要时短暂聚焦；实际使用后备时必须留证，不设置永久置顶。WGC 是特定 GPU/遮挡截图失败时的待选方案，不是已完成能力。

视觉循环另支持 `--max-steps`（默认 120）、`--until-battle-complete`、`--interval-ms`、`--settle-ms`、`--artifact-dir`、`--hwnd`；Ctrl+C 停止。该通道保留供调试和回退，主路线已改为结构化 mod。

## 测试、模块与验收

```powershell
npm test
npm run sim
npm run check:opus-config
npm run test:jev
npm run test:opus
```

离线测试使用替身，不证明实机完成；`sim` 不调用 API、不截图、不输入。`test:jev` / `test:opus` 实际调用服务并消耗额度，后者仅测试合成图。测试数量以本轮实际输出为准。

| 文件 | 职责 |
|---|---|
| `src/mod_client.mjs` | pipe 协议、串行请求、超时与状态读取 |
| `src/mod_decision.mjs` | 用结构化 `can_play`、卡牌 ID / `nth`、目标 `combat_id` 等产生完整候选并调用 Jev |
| `src/decision_context.mjs` / `schemas/decision-context.v1.schema.json` | 完整 JSON 决策协议、规则校验、持久记忆、路线事实和无损整理 |
| `src/mod_loop.mjs` | 主闭环、动作前状态一致性检查、动作后重读、无进展停止、战斗与证据跟踪 |
| `src/vision_opus.mjs`、`src/decision_jev.mjs` | 视觉后备：识别可见界面，生成像素动作 |
| `src/agent_loop.mjs` | 现有视觉循环、动作后观察、战斗跟踪和证据记录 |
| `src/window_driver.mjs`、`native/WindowDriver/` | 可选常驻 C# 窗口驱动、client 截图与后台消息 |

本机历史证据包括 `run-artifacts/2026-09-19T16-21-36-656Z-6415a6a2/` 的真 Opus/Jev dry-run（`battle.complete:false`）、`temp/resized.png` 的非前台截图，以及 `temp/mod-tutorial.png` / `temp/mod-after-tutorial.png` / `temp/mod-tutorial-dismiss.json` 的弹窗后备记录。原始运行材料默认不提交 Git；[历史验证记录](docs/validation-2026-09-19.md)只覆盖其注明时间与范围。

早期单场验收串联了真实战斗的结构化状态、Jev 答案、具体动作请求/响应、资源和敌人变化与战后奖励。截图和 CU 不是默认循环的前置条件，仅在模组未覆盖界面或查看结果时使用。当前整局验收要求同一局从第一幕开始，经过第二、第三幕并进入正式胜利结算，见[执行计划](feishu_plan.md)和[整局进展](docs/full-run-progress.md)。
