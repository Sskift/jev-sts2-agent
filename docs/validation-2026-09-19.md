# 2026-09-19 验证记录

这是接手故障任务后的实际验证范围，不是通关或实机出牌记录。

| 项目 | 结果 |
|---|---|
| 私有 GitHub 仓库 | Sskift/jev-sts2-agent，远程已存在 |
| TypeSafe models 查询 | HTTP 200，返回 jev-latest / jev-preview |
| 三 primitive 真实请求 | HTTP 200，model=jev-1.13.0，675ms，487 input / 71 output tokens |
| 修复后 decision 模块真实请求 | 一个 end_turn 候选成功，433 input / 27 output tokens；没有执行鼠标 |
| 指定 Opus 5 合成图请求 | 修正配置后 npm run test:opus 成功：HTTP 200，claude-opus-5，3709ms，223 input / 84 output tokens；中心(142,110)，预期(140,110)，误差2px |
| TLS | 默认 Node 证书库无法验证网关证书链，启用 --use-system-ca 后通过；未关闭 TLS 校验 |
| 离线测试 | npm test：15/15 通过 |
| 离线模拟 | npm run sim：输出拖拽计划，无 API、截图、鼠标动作 |
| 配置检查 | npm run check:opus-config：凭据存在，固定 claude-opus-5；仅配置检查 |
| Python 环境 | Python 3.12.3、Pillow 11.2.1、user32 可用；未实机操作 |
| 本机游戏 | 二代 appid 2868840，v0.111.0；存在影响玩法的 RebalancedRegentForging v2.3.0 |
| 飞书交付 | 原文档更新并读回；原画板保留，代码读回与新图一致，预览已检查 |

核心测试覆盖零费牌、重复手牌/敌人、完整动作目标关联、未知或敌方回合、缺失与越界坐标、HTTP失败和非法choice、离线模拟无副作用、参数数组执行、Opus指定模型/鉴权/输出完整性。注入的测试替身不执行真实输入。

早先 ENOTFOUND 是旧网关配置问题，当前已解决。剩余工作是验证真实游戏视觉，补窗口裁剪/坐标变换与出牌后的变化确认，再进行一场战斗和房间推进。CLI mod 的本机兼容性、多阶段选牌、特殊资源、药水与高阶策略未验证。

当前方案见仓库内的[工作计划](plan.md)；本文保留早期实测记录，不代表当前实现或运行状态。
