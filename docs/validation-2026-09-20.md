# 2026-09-20 首场真实战斗验收

本机 Windows、Slay the Spire 2 `v0.111.0`，窗口客户区 1280×720，使用 `STS2.Cli.Mod 0.111.0-local-compat` 与真实 Jev `jev-1.13.0`，完成一场战斗。用户已允许结构化模组通道替代 Computer Use；游戏自身的动作流程照常渲染动画，截图不再是主循环的前置条件。

## 真实运行证据

本次命令：`npm run start:mod -- --screenshots --max-steps 80`。从主菜单进入单人铁甲战士，选择首个可达节点，击败 `NIBBITS_WEAK`（小啃兽），停在奖励界面，没有继续领取奖励或开始下一场。

| 项目 | 实测结果 |
|---|---|
| UTC 时间 | 2026-09-19 16:39:33.430 → 16:40:13.833（本地 9 月 20 日） |
| 总耗时 | 40,403 ms，包含菜单、模型调用与动画等待；单次样本 |
| 状态观察轮数 | 17 |
| Jev 调用 / 游戏动作 | 11 / 11，全部动作返回成功 |
| 战斗动作 | 6 次出牌、2 次结束回合，跨 3 个玩家回合 |
| 初始敌人 | 小啃兽，44 HP |
| 玩家 HP | 开始 80；最后出牌前 62；奖励画面 68/80（燃烧之血回复 6） |
| 奖励 | 20 金币和选卡奖励 |
| Jev 用量 | 总输入 25,010、输出 645 tokens |
| Jev 请求耗时 | 281–1,584 ms，11 次样本 |
| 战斗中的 Opus / CU 输入 | 0 / 0 |

完整本地原始记录位于 `run-artifacts/2026-09-19T16-39-33-428Z-dcc28eb7/`。该目录包含每步结构化状态、模型返回、精确请求、执行响应和可选截图，属于本机运行资料，不随 Git 提交。

可随仓库审阅的证据是 [battle.json](evidence/2026-09-20/battle.json)、[战斗画面](evidence/2026-09-20/combat.png) 和 [奖励画面](evidence/2026-09-20/reward.png)。JSON 保留全部 11 条动作及前后 HP/能量/敌人变化，不含 API 凭据和账号目录。

28 次窗口/截图采样全部显示游戏 HWND 与 foreground HWND 不同，28 次截图前后 foreground/cursor 均相同。验收后再次查询，游戏 `topmost:false`，其上存在 3 个矩形相交的可见窗口；后台截图仍是完整奖励界面。矩形相交数是窗口几何证据，不等于逐像素遮挡比例。主循环动作全部经 Named Pipe，代码不调用系统鼠标或激活窗口。

## 安装和兼容修复

发布包 `v0.102.1` 从上游 GitHub Releases 下载并与 GitHub 提供的 SHA-256 digest 一致。CLI 放在 `%LOCALAPPDATA%/sts2-cli/sts2.exe`，模组 DLL/manifest 放在游戏 `mods/` 根目录。游戏设置仅启用 `STS2.Cli.Mod`，原有 `RebalancedRegentForging` 明确禁用；游戏日志证实只加载 1 个模组。

原始设置备份为 `temp/mod-install-backup/settings.before-cli.save`，原始 release DLL 保存在同目录的 `STS2.Cli.Mod.release.dll`。旧 DLL 可以建立连接和读取菜单，但源码对当前游戏存在 8 处已删除 API 的引用，因此换成针对本机程序集构建的兼容版本。

兼容补丁与可复现构建在 [mods/sts2-cli-compat](../mods/sts2-cli-compat/README.md)。修复玩家回合阶段、商店本地 inventory 访问，以及结束回合等待新玩家 Play 阶段。使用现有 SDK 8 的 C# 12 编译器和游戏自带 .NET 9 程序集，未全局安装另一套 SDK。上游 [Draft PR #1](https://github.com/longkerdandy/STS2-Cli-Mod/pull/1) 已提交，尚未合并。

## 界面例外与范围

首次开始游戏时出现“要看教程吗”弹窗，上游 `state` 仍报告角色选择界面，没有暴露该弹窗。此前通过游戏截图识别并用后台 `PostMessage` 点击“不了”，之后才进行了上面这次完整模组闭环。该次点击保持前台和光标不变。此例说明模组主通道适用于已覆盖界面，不证明可以完全删除所有界面后备。

模组在游戏最小化时已实测 `state` 和 `new_run` 成功；本次完整战斗在非前台普通窗口下运行，不推断为完整最小化战斗已测。商店 API 仅完成编译验证；更多角色、多人、整局通关和所有特殊选牌界面未验证。上游部分能力描述仍有 `Amount` 本地化模板错误，未影响本次出牌，但尚需后续修复。未进行同负载 CPU/GPU/内存基准，不能从语言选择或单次耗时推出普遍性能结论。

## 工程检查

- `npm test`：46 项离线测试通过，覆盖管道真实分块/BOM、未知动作结果不重放、同名卡副本、过期状态拦截、死亡及奖励验收边界等。
- `npm run sim`：离线模拟通过，不调用模型、截图或输入。
- `npm run build:driver`：可选 C# 窗口工具构建零错误、零警告。
- 兼容模组针对固定上游 commit、102 个源文件及 186 个游戏/运行时程序集编译，零错误、零警告；真实战斗验证如上。

默认 `npm start` 只运行 Node 与已加载的游戏模组，不启动 Computer Use helper，不需要 Opus 凭据。`--screenshots` 和 `npm run start:vision` 是明确选择的可选功能。
