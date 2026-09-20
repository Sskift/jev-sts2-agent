# 本地策略与怪物知识

运行时只加载 JSON，无网络抓取、Python 服务或新增依赖。`v0.111.0/strategy.json` 保存五个角色的简短策略笔记、适用前提、代价和来源；`v0.111.0/enemy-patterns.json` 保存与现有 Codex 目录对应的 115 个怪物行动图。

## 来源与权限层级

1. 当前模组状态是费用、伤害、意图、能力计数与合法动作的依据。
2. [Spire Codex](https://spire-codex.com/developers) 的本地快照提供招式、卡牌和关联能力；原始文件保持不变。
3. 怪物行动图从本机 v0.111.0 `sts2.dll` 静态提取，记录程序集与单类型源码哈希。未调用游戏状态机，也不读取 RNG。临时反编译文件不进入仓库。
4. 攻略是有版本限制的建议。整理了 [Jorbs 的构筑职责框架](https://sts2.untapped.gg/en/articles/slay-the-spire-deckbuilding-strategy-solving-the-spire-with-jobs)、[地图取舍](https://sts2.untapped.gg/en/guides/how-to-make-the-best-map-choices-in-slay-the-spire-2)、Untapped.gg 的[铁甲战士](https://sts2.untapped.gg/en/characters/ironclad)、[静默猎手](https://sts2.untapped.gg/en/characters/silent)、[储君](https://sts2.untapped.gg/en/characters/regent)、[亡灵契约师](https://sts2.untapped.gg/en/characters/necrobinder)、[故障机器人](https://sts2.untapped.gg/en/characters/defect)，以及 [Baalorlord 的充能球攻略](https://sts2.untapped.gg/en/guides/defect-build-orb-spam)。只保存自己的简短转述和链接，没有搬运全文。

攻略没有明确标注当前版本时，不采用其精确数值、固定卡牌排名或通关率。实际发现 Necrobinder 页面把 Doom 门槛写成最大 HP，因此没有采纳该条；其余建议也不能覆盖当前原生规则。Jorbs 文章的 STS1 敌人示例和旧幕次经验没有导入。

## 行动图的边界

提取器保留固定后继、条件分支、相对随机权重、连续重复上限、冷却和必须先执行一次的状态。它修复了原 Codex 图中默认权重分支缺失及重复 RAND 节点的问题。例如 Hunter Killer 的第二个整数参数是最多连续重复次数，不是两倍权重；另一个重载中的整数则是冷却。

14 个条目包含无法确定的初始条件；存在条件式图构造时也明确标记。条件表达式只是公开逻辑，不代表知道本局的私有标志。死亡、复活、眩晕和阶段转换可能打断普通循环。

`analysis.enemy_outlook` 仅匹配可见意图类型和已知命中次数，最多展开随后两个正常招式。不能用 Wiki 基础伤害去匹配被增益修改过的伤害。多个招式对应同一可见意图时，保留所有可能；内部 `move_id` 继续排除在模型输入之外。随机权重不被当成已经归一化的概率，缺失历史也不被假定为空历史。

原生 `StatusCard` 与静态 `Status` 意图归一后参与匹配。具名招式中的直接 `AddToCombatAndPreview<T>` 调用提供生成牌类型、目的地和每次调用数量，并让规则库补入对应卡牌及关键词；目前覆盖 14 个调用，其中三个数量表达式保持未知。该字段描述调用被执行时的效果，不计算分支、重复、手牌溢出或打断，也不把未来牌加入当前观察。其他生成方式尚未提取，不能把字段缺失理解为不会生成牌。

曾查看 [EnemyCycle](https://github.com/sts2mods/EnemyCycle) 的预测设计作为研究参考；没有安装它、复制其实现或使用它读取 RNG 的路径。

## 更新

使用 ILSpy 对所需 `MegaCrit.Sts2.Core.Models.Monsters.*` 类型导出独立 C# 文件，再运行：

```powershell
node scripts/extract_enemy_patterns.mjs <源码目录> <当前版本的sts2.dll路径> data/strategy/v0.111.0/enemy-patterns.json
```

提取器仅针对已核对的 v0.111.0 语法与重载。升级游戏时应新建版本目录、核对重载及缺口，再修改运行时引用；不能给其他版本直接贴 v0.111.0 标签。静态图覆盖不等于完整敌人模拟。

每次请求只带当前角色的策略；战斗中进一步筛选已有卡组／手牌涉及的组合，房间外保留该角色的候选方向。全部规则仍由 `rule_reference` 做关联查询。攻略不会创建合法动作或指定固定构筑。
