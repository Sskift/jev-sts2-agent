# 第 39 局：牌组取舍与首领前生存

2026-09-23，游戏 v0.111.0，Ironclad 标准模式。第 39 局在第一幕第 17 层 The Kin 首领战失败，原生 `GAME_OVER` 确认 `is_victory: false`，首领死亡前还剩 108 HP。完整本机记录在忽略的 `run-artifacts/run39-*`，这不是通关。

| 决策点 | 实际观察 | 工程处理 |
|---|---|---|
| 战后牌 | 第 4、6、14、15 层真实跳过了卡牌奖励，其他金币、药水和遗物照常领取；第 9 层仍拿了第二张 Taunt | 跳过与领取其他奖励的流程已贯通。每张牌仍按当时缺口判断，不设固定牌数 |
| 商店 | 第 5 层用 52 金买 Breakthrough，放弃 75 金删 Strike；第 12 层买 Tremble 和 Juggling，后者独立评分“恶化／边际”合计 0.67，和删牌比较又发生顺序分歧 | 补充边际付费牌与留金离店的双向比较，以及能删牌却准备离店时的删牌／留金比较。两项均在购买发生后加入，不能改写本局历史 |
| 首领前营地 | 32/80 HP，Rest 原生描述可回 24 HP；Jev 以 0.59 概率、0.17 置信度选择 Smith，把一张 Taunt 从 6 格挡／1 易伤升级到 7 格挡／2 易伤 | 请求现列出 Rest 后 56 HP、下一格必为 The Kin，以及唯一具体升级；Smith 入首领时追加休息／升级正反顺序比较 |
| The Kin 目标 | 入场 32 HP；前期伤害主要打在 190 HP 的 Priest，两个约 60 HP 的 Follower 长时间存活，持续造成压力 | 在战斗上下文中附上有来源的条件提示：根据当前输出和 HP，比较集中击杀一名 Follower 与迅速击杀 Priest；不固定攻击顺序，原生意图与 Minion 能力优先 |

营地使用**同一历史请求的完整状态、卡组、首领与升级目标**做了一次开发回放，只增补确定的回血算术和两项顺序相反的选择题。Jev 两次都改选 Rest，概率分别为 0.77 和 0.79；这证明改进后的请求改变了该局面的模型选择，不证明休息一定赢得后续战斗。调用费用为 $0.000462042，回放保存在本机 `temp/replay-camp39-result.json`。

依据：[Untapped 构筑指南](https://sts2.untapped.gg/en/guides/how-to-build-a-strong-deck)、[Baalorlord 的循环与密度分析](https://sts2.untapped.gg/en/articles/core-deckbuilding-concepts-in-slay-the-spire)、[Untapped 营地指南](https://sts2.untapped.gg/en/guides/rest-sites)、[GameSpot 的 The Kin 目标取舍](https://www.gamespot.com/gallery/slay-the-spire-2-bosses/2900-7563/)。攻略只提供条件性策略；数值与合法动作以本局原生状态为准。
