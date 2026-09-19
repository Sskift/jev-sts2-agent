# Slay the Spire 2 Autonomous Agent Loop

基于 **Claude Opus 5 (视觉感知/空间定位)** + **TypeSafe Jev (System One 战术决策)** + **原生 Computer Use (模拟操作)** 的《杀戮尖塔 2》全自动闭环 Agent。

## 架构职责分工

1. **Claude Opus 5 (Vision / 多模态感知)**
   - 截取游戏窗口画面
   - 识别界面场景（战斗、选牌奖励、地图路径、营地、事件等）
   - 提取玩家状态（HP/护盾/费用）与手牌、怪物坐标与意图、回合结束按钮位置
   - 输出纯结构化 `GameState` JSON

2. **TypeSafe Jev (System One / 毫秒级战术决策)**
   - 接收结构化游戏状态
   - 采用 Jev 核心原语进行快速强类型决策：
     - `choice`：选择本动打哪张手牌、指定攻击哪个敌方目标
     - `noul`：二值概率判断是否应结束当前回合
     - `score`：1~5 分级量化评估当前敌方威胁程度与生存压力
   - 实测响应延迟 ~700ms

3. **Computer Use (动作执行)**
   - 基于 Windows 平台平滑鼠标轨迹插值（避免游戏丢帧或丢动作）
   - 自动执行拖拽打牌（手牌 -> 怪物 / 战场中心）
   - 自动点击结束回合按钮、地图节点与选卡奖励

## 快速运行

```bash
# 验证 Jev 决策模型
node test_jev.mjs

# 验证单步模拟 Loop
node src/agent_loop.mjs --sim

# 启动全自动 Agent Loop
node src/agent_loop.mjs
```

