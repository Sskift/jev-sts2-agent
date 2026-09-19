# jev-sts2-agent

在 Windows 上探索《Slay the Spire 2》的可见自动游玩：**Opus 5 看图 → Jev 从完整动作候选中选一步 → Computer Use 点击/拖拽 → 重新截图**。

[飞书方案](https://icnainlav1b8.feishu.cn/docx/Ijr1dLJpio6JvNxfcAfcnvXKnUR) · [本地方案](feishu_plan.md) · [闭环图](docs/agent-loop.mmd)

## 当前状态

- 私有 GitHub 仓库、TypeSafe skill 和 Node.js/Python 原型已就绪。
- Jev 真实 API 已验证：2026-09-19 返回 `jev-1.13.0`，单次三 primitive 测试约 675ms；此结果不代表游戏策略质量或平均延迟。
- 指定 `claude-opus-5` 的合成图请求遇到配置网关的 `ENOTFOUND`。尚未验证 Opus 视觉成功。
- 本机装有二代 `v0.111.0` 和影响玩法的 mod，尚未验证真实出牌、完整战斗或通关。

本轮修复模拟误触鼠标、硬编码坐标、零费牌被跳过、重复卡牌覆盖、选牌与选敌不关联及错误响应默选第一项等问题。现阶段仍是需要实景联调的原型。

## 环境与配置

需要现代 Node.js（内置 fetch，建议 22+）、Windows Python 3 和 Pillow：

```powershell
python -m pip install -r requirements.txt
```

在 `.env` 设置 `TYPESAFE_API_KEY`，或通过同名环境变量提供。Claude 地址和凭据从 `%USERPROFILE%/.claude/settings.json` 的 env 读取，可用同名环境变量覆盖：`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`（Bearer）或 `ANTHROPIC_API_KEY`（x-api-key）。视觉模型固定为用户指定的 `claude-opus-5`，不沿用默认 Opus alias。凭据、截图和临时日志不提交。

## 验证和运行

```powershell
npm test
npm run sim
npm run check:opus-config
```

`npm test` 是离线回归；`sim` 用合成局面和预设决策，仅打印动作计划，不调用 API、不截图、不移动鼠标。`check:opus-config` 只检查配置是否存在；旧命令 `test:opus` 是同一个配置检查，不是连通性测试。

```powershell
npm run test:jev
```

此命令实际调用 TypeSafe API，会消耗少量额度。

待网关可达、游戏处于主屏且坐标完成标定后：

```powershell
npm start -- --once --dry-run
npm start -- --once
npm start
```

`--once --dry-run` 会截取主屏并发送给 Opus、调用 Jev，仅打印鼠标动作。`--once` 会执行一次真实动作；不带参数则持续运行，Ctrl+C 停止。当前程序不自动启动或聚焦游戏，截图是整张主屏，应先让游戏占据该屏幕。

## 模块和边界

`vision_opus.mjs` 提取场景、玩家回合、牌面效果、实体坐标、End Turn 和释放区。`decision_jev.mjs` 用手牌/敌人的数组槽位枚举完整动作，Jev 一次 Choice 选中具体的“牌 + 目标”或界面选项。`agent_loop.mjs` 把当前帧坐标映射为动作计划，`computer_use.py` 执行 Windows 点击和拖拽。

每次只做一个动作，然后重新截图。没有识别到目标或按钮时不使用固定坐标；零能量仍保留可用零费牌。后续还需窗口裁剪/缩放逆变换、悬停读牌、动作后状态变化确认，以及特殊资源和多阶段选择处理。连续循环当前只在每次失败后等待再尝试，尚不具备完整故障恢复能力。

[STS2-Cli-Mod](https://github.com/longkerdandy/STS2-Cli-Mod) 是可选结构化状态通道。它没有手牌/敌人的屏幕像素坐标，其公开 release 与本机游戏版本也不同，尚未安装验证；默认主路线继续使用视觉和可见 Computer Use。
