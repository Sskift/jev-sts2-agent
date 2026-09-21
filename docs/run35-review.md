# 第 35 局复盘

标准模式、铁甲战士、进阶 0，`run-1789968641`。从第一层开始，通过第一幕 Ceremonial Beast，最终在第二幕第 33 层 The Insatiable 第 7 回合失败，分数 644。共 35 局启动并结束、22 局通过第一幕，尚无三幕胜利。

最后一次续接实际加载 `c81d856`，从同一 Boss 第 4 回合继续，没有重开。原生 `GAME_OVER.is_victory=false`；读取时 `can_return_to_menu` 与 `can_continue` 都为 false，未将它描述成已返回菜单。最终 pending=null。账目截至本局结束累计报告 $1.166443656，包含该账目下早先回放与续接，不等于本局全部历史费用。

## 第二幕 Boss

| 回合 | 开始生命 | Boss 开始生命 | 实际主要动作 | 结束后生命 |
|---|---:|---:|---|---:|
| 1 | 80 | 320 | Battle Trance → Iron Wave → Stomp+ → Salvo → Heart of Iron → Headbutt | 80 |
| 2 | 80 | 271 | Iron Wave → Defend+ → Strike | 80 |
| 3 | 80 | 251 | Defend+ → Ultimate Defend+ → Bash | 80 |
| 4 | 80 | 233 | Frantic Escape → Strike → Anger → Defend+ → Barricade+ | 80 |
| 5 | 80 | 196 | Perfected Strike → Rage+ → Iron Wave → Evil Eye | 80 |
| 6 | 80 | 161 | Frantic Escape → Strike → Defend+ → True Grit | 80 |
| 7 | 80 | 142 | Defend+ → Ultimate Defend+ → Defend+ → Headbutt，回收 Ultimate Defend+ 到抽牌堆顶 | 0 |

最后结束回合前，玩家仍有 80 生命、43 格挡，Boss 133 生命、可见攻击 30，但 Sandpit=1 明确表示下一敌方回合会被吞噬。死亡机制是倒计时处决，格挡与生命都不能解决。

第 7 回合手里只有 Decay、两张 Defend+、Ultimate Defend+ 和 Headbutt；六张 Frantic Escape 都在未知顺序的抽牌堆里，手中没有抽牌工具。Headbutt 把牌放在牌堆顶，不会立即抽到手中。最终残局不能简单归为“本来能打逃跑牌却忘了打”；更早的输出、牌组密度和抽牌稳定性才需要一起评估。也没有证据证明删除某张牌即可必胜。

## 商店与后续改动

| 商店 | 原始购物 | 删牌情况 |
|---|---|---|
| 第一幕第 4 层 | Colossus、Anger | 进店 130 金，删牌 75，未使用 |
| 第二幕第 24 层假商人 | Fake Venerable Tea Set | 原生没有删牌服务 |
| 第二幕第 27 层 | Battle Trance、Salvo、Heart of Iron、第二张 Iron Wave、Stampede | 进店 343 金，删牌 75，未使用；牌组 23→27 张 |

用户指出的删牌问题有日志依据。尤其是剩 107 金后购买第二张 Iron Wave，直接让当场删牌变得不可负担；但早期买牌和带 Perfected Strike 的删 Strike 都存在真实取舍，不能统一标成错误。

已完成[商店策略修改与开发快照回放](shop-removal.md)。新逻辑不强制删牌，保留旧版、初版和最终版的全部结果及顺序分歧；提交推送后再开始新的完整对局。原始结算、逐回合动作、商店流水及哈希见[证据](evidence/2026-09-21/run35-review.json)。
