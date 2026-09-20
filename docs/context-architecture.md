# Unified Jev context architecture

The objective remains one autonomous standard run through all three acts and the formal victory screen. The implemented architecture addresses how the system represents a decision. It does not claim improved win rate before live evidence exists.

The sequence-dependency change has been evaluated against saved observations and a subsequent standard run. Run 28 failed at the Act 1 boss; its [review](run28-review.md) records both context gaps and remaining model errors. Ordered debuff bounds now reconcile exact HP, Block and prevention-counter results before response arithmetic. Retrieval checkpoints also distinguish earlier completed plays from the still-resolving card. These changes do not establish a win-rate improvement; see the [plan](plan.md).

`knowledge.strategy` now contains sourced, conditional advice for the current character, selected by relevant owned mechanics during combat. `knowledge.catalog.monsters` uses the version-pinned native transition graphs alongside Codex move facts. `analysis.enemy_outlook` links visible intent shapes to conditional next moves without internal move IDs or RNG. Plan `encounter_progress` distinguishes damage, depletion, revival and permanent removal; uncomputed death hooks invalidate affected survival estimates. These additions do not change the source precedence or lossless round-trip contract.

`analysis.routes[].route_examples` supplies up to five concrete first-boss paths per next node: fewest/most known elites, most rests, most shops and most normal fights. Identical examples merge their criteria. Each example has joint counts and its full node order; independent extrema are never combined into a fictitious path. Boss-path ranges exclude unfinished branches. These are bounded tradeoff examples, not recommendations or an exhaustive frontier; unknown rooms and later movement effects remain unresolved. The [route audit](evidence/2026-09-21/joint-route-context.json) records compilation cost and one unchanged development replay.

## Current problem

The internal v1 packet contains the required observations and reference material, but mixes several kinds of information. Derived route statistics live beside map observations; partial combat arithmetic appears inside current combat and action descriptions; an intended sequence and its partial projection share a container. Planning phases construct their own extra state. Lossless packing preserves data but does not establish a consistent reading order or a clear source of truth.

A rule being present is not sufficient. The model must be able to connect the rule to the current entity, distinguish already observed effects from an intended action, understand what question is being asked, and recognize the limits of any calculation.

## Pipeline

1. **Acquire and validate observations.** The native mod produces one main-thread snapshot. Node validates identities, complete piles, legality and mutually consistent fields. Hidden draws and future random outcomes remain unknown.
2. **Join knowledge and select relevant history.** A versioned local rule library supplies transitive relationships. Native current values take precedence. A history policy supplies current-round causality and explicitly needed older evidence, plus the still-active turn intention. Old outcomes already represented by current state remain in the local audit. Every request remains self-contained within its declared scope.
3. **Build the decision specification.** The planner supplies a typed question, all offered alternatives, its horizon and any parent intention. This stage does not execute an action or make its predicted effects true.
4. **Compile one model-facing context.** All decision stages pass through the same compiler immediately before the API call. The compiler routes content by epistemic role, builds generic entity-to-rule links, and emits a v2 packet with a stable observation identity and decision-stage metadata.
5. **Encode without losing facts.** Existing lossless tables and in-request text references remain supported. Readable current records use spare capacity. A compiler round trip must preserve the entire canonical packet, question keys and choices; insufficient capacity stops before an action.
6. **Execute and reconcile.** Jev selects an offered result. Code validates identity and legality, dispatches one action, reads its actual result and either follows the remaining plan or requests a revision. The original observation, wire request, answer and result stay inspectable.

## Model-facing domains

| Domain | Meaning | Authority |
|---|---|---|
| `decision` | Current phase, horizon, output mode, observation identity, question keys and path aliases | Compiler metadata; not game facts |
| `observation` | Run/player/deck/piles/map/interaction and legal commands | Validated current snapshot |
| `knowledge` | Versioned rule catalogue, generic entity links, glossary, resolved mechanic facts and sourced strategy notes | Rules and explicitly advisory notes; live observations override base values |
| `history` | Confirmed combat events, local run memory and recent changes | Past observations, with coverage limits |
| `intent` | Overall objective, persistent turn plan and the unexecuted proposed sequence | Intentions, never observations |
| `analysis` | Route statistics, partial arithmetic, action estimates, conditional projections and model assessments | Explicitly conditional or advisory |
| `uncertainty` | Extraction/coverage limits and unknown information | Absence stays unknown |

Question-specific choices remain in the native `questions` API field. A shared path-alias contract translates the internal planner's references into these domains. The compiler preserves the original canonical contract for execution and replay; the transport layout cannot change game commands.

## Boundaries and subsequent work

`analysis.combat_effects` now carries a compact timing ledger: source, owner, current stacks, whether it is already active or requires playing/using, trigger, expiration and coverage. It joins versioned rules by ID while retaining native resolved text. Verified timing adapters distinguish player-end expiry from opposing-side-end expiry. Unsupported rules retain explicit unknown timing rather than acquiring an invented duration.

Sequence analysis separately lists end-turn damage, remaining consumers of expiring bonuses and uncomputed reactions/health effects. Known Constrict damage requires a unique visible rule-named applier; ambiguous sources stay uncomputed. Arithmetic affected by uncomputed health effects cannot claim a final HP value. These are conditional facts, not policy choices or a complete simulator. All Jev requests and full API responses are recorded, including probability distributions when the provider returns them.

`turn_sequence.mjs` supplies one ordered dependency walk for resource reservations, candidate values and plan comparisons. It applies inspectable upgrades, supported stat changes and X payments only to subsequent actions. It preserves the original observation and invalidates unsupported ranges. Draws, transformations, new powers and uncomputed next-card consumption end the declared executable segment; a native observation supplies the next segment. Full-plan labels also identify consumed/remaining potions, Block unused by calculated damage, and conditional loss deadlines. The turn objective is advisory, not a rule to maximize Block or damage regardless of overall value.

The first implementation centralizes every existing request and preserves all its semantic content. It does not add more model calls, replace Jev's choices with heuristics, or claim a complete simulator. Rule links are based on category and stable IDs, not a list of favored cards. Coverage describes which data and rules were included, not whether all game mechanics have been modeled.

## Strategic memory across rooms

The main loop now asks Jev for one batched strategic assessment at meaningful checkpoints. Seven typed scores describe single-target damage, multiple-enemy control, sustained defense, long-fight scaling, draw consistency, energy efficiency and recovery. Independent choices select a development priority and an anchor from the actually owned cards/relics, including an explicit no-anchor choice. These judgments do not create actions, filter offers or force an archetype.

The result persists under the current run ID. A full build fingerprint tracks permanent card multiplicities, upgrades, enchantments/afflictions, owned relic identities and maximum HP. A second structural fingerprint keeps card identities, multiplicities, upgrades, modification identities and relic identities. A different act, structural build change, new room, or transition to combat aftermath requests a review. Numeric permanent growth within the same combat is coalesced until aftermath; `freshness.deferred_until_post_combat` states when the stored assessment predates that growth. Current card values and maximum HP still update immediately in every tactical request. Ordinary changes to the hand, energy, current HP or cycling relic counters do not create a new strategic call. Every tactical/route/reward/selection request still includes current facts, so immediate survival and superior concrete options can override the earlier development priority.

This distinction was motivated by live run-23 evidence: playing an enchanted Defend permanently increased its modifier amount and caused another nine-question strategic assessment even while executing the same turn plan. The structural fingerprint stays unchanged for that numeric growth. The [saved-observation lifecycle check](evidence/2026-09-20/strategy-review-lifecycle.json) verifies reuse during combat and review at aftermath without sending game commands. Main-loop logs now distinguish all `modelCalls` from `strategicAssessments` and tactical `planningCalls`, so a reused turn plan cannot hide a separate strategic request.

The compiler places the development intention and its freshness under `intent.run_strategy`, the latest complete capability ratings under `analysis.run_capability_assessment`, and every change of development priority or anchor under `history.strategy_revisions`. Each included revision records its checkpoint and review reason. Superseded numerical ratings and confidence-only changes stay in the full local audit archive; they are not repeatedly injected as strategic evidence. `history.strategy_coverage` states that policy and both record counts. This policy removes no game observations or confirmed actions. Prior model judgments never become native observations. A new run discards the previous run's intention, and an incomplete model response cannot partially commit a strategy or dispatch a game command.

`run_strategy.mjs` supplies the assessment and result parsing; `run_strategy_state.mjs` owns lifetime, change detection and persistence. Offline decision replays can leave strategic refresh disabled while still carrying any strategy present at their historical cutoff. The production loop explicitly enables it and saves each actual strategy request, context metrics and parsed result next to the action artifacts.

## Coverage and source lifetimes

`analysis.combat_progress` retains a small encounter summary before raw history is scoped: current enemy HP, native recorded HP damage and overkill, last damage round, and confirmed transitions to zero HP. Native `unblocked` damage already excludes overkill. The summary uses only available events and confirmed actions from this combat; it does not reconstruct missing history or prescribe targets. Revival and healing can undo damage, and a zero-HP transition does not establish permanent removal. This lets a later turn compare temporary suppression with current remaining work without restoring old raw turns.

`history_scope.mjs` applies relevance before compilation and encoding. In combat it keeps this round and the preceding enemy response. Rules referring to a previous turn or combat-wide history broaden the retained window; recently played delayed effects preserve their needed rounds. Potential draw-order knowledge keeps the originating commands and intervening draw/discard/exhaust/shuffle events, not all unrelated HP/Block/energy events. Such evidence is explicitly historical, not a claim that an old top card remains on top. Unnumbered engine events stay conservatively included. These English-rule dependency recognizers are conservative coverage aids, not a complete effect simulator; current native state remains authoritative.

Current-room choices remain available outside combat. Earlier room purchases, travel, resource/deck/relic deltas and redundant snapshots are omitted from the model view because their surviving outcomes are already in the current build, map and resources. Tactical requests carry the current strategic direction and assessment without the sequence of older strategic changes. Full raw records persist locally. `history.run_memory.relevance` states the selected window, dependency reasons and available/included engine-event counts. This policy deliberately selects content; the later compiler must still preserve that selected canonical view exactly.

A read-only comparison of saved run-23 decisions reduced the round-7 Byrdonis view from 161 to 44 engine events and 62,721 to 45,587 logical request bytes; the round-9 Vantom view went from 209 to 47 events and 67,543 to 44,885 bytes. The current observation identity and question choices were unchanged. See [history-selection evidence](evidence/2026-09-20/decision-history-scope.json). These are repacked saved decision views, not paired model-quality trials or actual new API calls.

`rule_entities.mjs` is the shared typed-identity registry for both retrieval roots and model-facing rule joins. It recognizes permanent/combat card collections, offered card IDs, current effects, attached modifications, events and the visible map boss. Retrieval uses the declared category and stable ID first. An unknown authoritative ID remains missing; legacy name-only bosses may resolve uniquely within the encounter category. The earlier independent traversals could leave an encounter unreferenced when its name also belonged to a monster. With the shared registry, a visible encounter leads to its monster repertoire and related mechanics without revealing which future random choice will occur.

The context has three distinct retention policies: current observations refresh after every confirmed action; applicable public rules are retrieved through entity relationships; model judgments expire or are replaced according to their decision horizon. Complete raw observations, requests, answers and strategy revisions remain in local artifacts for audit. The canonical decision packet is the explicitly scoped view for one decision; compilation and transport must preserve that view exactly. A local archive is never described as implicit model memory.

## Survival constraints before ordinary plan value

Complete-plan comparisons use an observed-exposure gate before allowing a survival judgment to override ordinary value. Without a represented exposure, only the value question is asked. With one, two independent Jev questions share the same alternatives: whether the listed survival constraint favors one plan, and which plan has greater overall value. The first question considers the coming response and next known deadline using current rules, counters and card locations. It has an explicit `no_clear_difference` outcome for ordinary nonlethal trades or insufficient evidence. A supported survival preference takes precedence; otherwise the value preference selects the winner. Both answers and their distributions remain in the trace. These are model judgments, not verified game facts or a guarantee of safety.

The gate lists potential lethal attack/self-loss exposure, already represented loss countdowns, explicit terminal rules, and current player effects that describe health loss. English rule matching supplements the limited arithmetic; it is not complete mechanic recognition. The bound is conservative and does not claim that every card is affordable or that mitigation fails. An empty list means no represented reason for this extra priority, not proven safety; the value question still receives all current rules and resources. Constraints live in `analysis.survival_constraints`, separately from the proposed plans.

This gate corrects a run-24 counterexample: at 80 HP against only 4 displayed damage, both proposed plans killed the attacker. The survival question nonetheless preferred redundant Block over a second kill, overriding the value question. There was no observed fatal rule. The same saved observation now produces no survival question and cannot apply that override. A further dangerous-state probe still had a close split between no clear difference and the better prepared option, so the model's handling of future deadlines remains unproven. See [eligibility evidence](evidence/2026-09-20/run24-survival-eligibility.json).

Each complete pair is stored once in `analysis.plan_alternatives`; its one or two questions reference it. Independent questions share one request, within the same byte limit and at most 32 questions. Current-state freshness checks, card identities, energy budgets and execution checkpoints are unchanged. No additional historical window or encounter-specific action policy is introduced.

Run 23 exposed this distinction at The Insatiable: on round 5 two response cards were in hand and none in the draw pile, but the selected plan spent the remaining energy on damage after one response. Round 6 ended in formal defeat despite 33 HP and 21 Block. A separate arithmetic issue made the existing countdown survive unchanged inside hypothetical sequences whose other effects were uncomputed. Such sequences now report end HP as unknown, rather than claiming the current countdown proves the proposed sequence fatal. Current raw counters and rules remain available for the model to evaluate.

In one saved-observation comparison, the value question preferred the old one-response plan while the survival question preferred a two-response alternative generated by the existing planner. A full production-planner replay instead chose a Colorless Potion first, retaining energy for the newly revealed option, and evaluated 67 pairs in 26 requests. Neither replay sent game actions or used subsequent draws. These results validate the separated decision path and a changed proposed continuation; they do not prove a boss win or improved win rate. See [run-23 survival evidence](evidence/2026-09-20/run23-survival-comparison.json).

## Decision horizon and conditional interaction plans

Context selection answers “can this fact change the current decision?” before encoding. In a combat turn, current HP/Block/energy, card locations and resolved effects, potions, enemy intentions, active powers/counters, linked rules and the remaining ordered plan are necessary. Current-turn actions matter for order-sensitive rules and already-used effects. Older actions matter only when a live mechanic or known card placement depends on them. Expired effects, old room accounting and earlier strategic deliberation stay in the local archive. This is a relevance policy, not an attempt to use the provider's whole context window.

Multi-stage choices also need short-lived intention. `camp_plan.mjs` first asks Jev which actual native before/after card upgrade it would select **if** Smith were chosen. A dependent request compares that concrete upgrade with actual rest healing and all other available actions. The target is classified as `intent.camp_planning`, not an observed effect. It does not add old combat history. Every request still passes through the same compiler and byte budget; the two planning requests are logged separately.

Only a confirmed Smith dispatch promotes the target to local interaction memory. The following upgrade grid reuses it if the run, floor, current build/resources and actual before/after preview still match. Instance IDs take precedence. For older grid DTOs without IDs, all indistinguishable deck copies must have equivalent full native data; otherwise a fresh model choice receives the still-applicable intention. Completing a command consumes the intention. Failed/unknown Smith results do not authorize automatic selection. A rest choice discards the hypothetical target.

Run 24 floor 28 originally chose Smith at 29/80 HP, then independently upgraded a Strike; the run later failed against Spiny Toad at floor 29. A read-only replay of the contemporaneous camp observation selected Flame Barrier conditionally, then Rest at 0.51 versus Smith at 0.49. The close distribution demonstrates concrete comparison, not a robust improvement or a counterfactual victory. See [camp evidence](evidence/2026-09-20/run24-camp-planning.json).

## Uncomputed reactions invalidate dependent outcomes

`combat_reactions.mjs` records known reaction dependencies that the arithmetic does not execute. Its first adapter follows the installed v0.111.0 Thorns hook: qualifying attack damage, including Omnislice, causes unpowered retaliation before the owner's damage is resolved. The record carries source/owner identity, timing, damage per trigger and conditional preview-hit exposure. Zero preview hits produce no reaction; unknown counts stay unknown. Damage blocked by the owner does not make the reaction disappear.

Single-action and complete-sequence estimates both propagate this gap. Final player HP, Block and remaining incoming attack totals become `null`; reaction records explain why. Damage/depletion and turn-end gain baselines remain conditional on the proposed attacks actually resolving. They cannot establish safety if reaction damage interrupts the sequence. The visible-risk gate also considers known conditional reaction exposure when deciding whether to ask the separate survival question; it does not prescribe defense or declare every such attack lethal. Ordinary low-exposure states keep the existing value-only comparison.

This is explicit coverage management, not a complete simulator. It currently recognizes Thorns on selected or all-enemy targets; unmodeled powers, damage prevention, random targeting, death hooks and changing previews still require the full live rules. There is no new historical window. On the saved run-24 Spiny Toad turn, every offered attack now exposes its reactive cost and withholds a falsely precise final-HP number. A fresh read-only model replay selected Perfected Strike followed by Swift Potion, instead of beginning with Strike; subsequent unknown draw results were not supplied or executed. See [reaction evidence](evidence/2026-09-20/run24-reaction-coverage.json).

## Action constraints beyond energy

An ordered plan can afford every printed cost and still violate a game rule. `turn_action_constraints.mjs` adds a shared reservation check for known action-order constraints. Main payoffs, preparation/payoff pairs, refinement alternatives and an existing unexecuted suffix all use it. When relevant, `analysis.action_reservation` states the affected card instances, the maximum number of preceding card starts, each proposed transition and validity. The canonical validator checks this ledger against the proposed steps. Current native legality remains authoritative at execution; unobserved automatic plays or a removed effect require another observation.

The first adapter covers the observed Ringing restriction, verified against the installed v0.111.0 `RingingPower.ShouldPlay` hook. It restricts cards bearing that affliction after any earlier owned card start, including an earlier card with another affliction. It does not impose a blanket ban on cards exempt from Ringing. Thus two affected manual plays are invalid, an affected play followed by an exempt play can remain valid, and potion use does not itself consume a manual card start. Other action constraints are not claimed to be modeled.

Run 24 round 6 of Ceremonial Beast previously planned Armaments then its upgraded Defend under Ringing. After Armaments, native state correctly exposed every remaining affected card as `BlockedByHook`, leaving two unused energy and only end-turn. The saved-observation replay now considers only valid sequences; it still selects Armaments, but as a single-card plan with no promised second Block. This fixes plan feasibility, not the optimality of that choice. See [action-constraint evidence](evidence/2026-09-20/run24-action-constraints.json). No game restart or native mod change was required.

Every emitted request logs bytes per domain, question bytes, selected rule counts and missing current rule links. `npm run context:preview` saves both canonical and compiled model context without a model call or game action; its report states that later planning questions and optional readability expansion are not part of that preview. These diagnostics make context pressure and retrieval gaps visible instead of treating a valid JSON shape as proof of semantic completeness.

Run 23 actual map, reward, combat and modal-selection requests contain the same strategic domains. Consecutive actions 50–52 share strategic revision 9 and one turn plan; actions 51–52 make no new planning call. At floor 13, replacing accumulated old model scores with the scoped history policy reduced the same observation's compiled current-choice request from 70,550 to 61,260 bytes. The reference repair also included the previously missing Vantom encounter and monster rules. See [runtime evidence](evidence/2026-09-20/run23-context-architecture.json). These observations verify data flow and capacity, not optimal decisions or a completed run.

## 条件牌堆影响与结束边界

`card_flow_projection.mjs` 将已核实的触发生成规则写入单动作及有序方案分析：规则来源、命中次数及来源、目标范围、生成数量区间、去向和随机性。当前覆盖 Personal Hive；未知次数返回未知，多目标随机命中给条件范围，不假设插入位置、未来手牌或中途死亡后的命中。当前观察与假设账目分开，静态 Dazed 关键词也不能覆盖本局改变关键词效果的规则。

回合结束检查只提名可能的追加动作；`describePlanAlternative` 与主规划共用同一个预算、规则和条件后果格式，再通过已有方案比较在追加与结束间选择。抽牌后仍须重读状态，未承诺未知后续动作。新增分析不要求更多普通历史；生成事件仅在当前窗口或仍有牌序依赖的旧窗口保留。

方案现在显式描述观察后的继续机会：当前费用预算下剩余能量、尚未消耗的手牌、当前抽牌堆的分组及费用可覆盖数量。方案对中的 `continuation_resources` 对称列出另一方打算使用、本方观察前仍未消耗的牌，并检查其当前总费用能否被剩余能量覆盖。它不模拟抽牌，也不承诺新效果、目标变化或费用变化后的合法性。这使已完成的防御／攻击与尚保留的选择权能在同一个回合视角内比较。

候选先接受独立的 Jev Score 判断，全部排序与概率保留在日志。最多三个不同卡牌／目标分配的代表入围，同时保留不同结束边界及最高剩余能量的观察候选，最后加原提案；最多六个方案双向两两比较。每个资源分配保留最高评分的具体出牌顺序，分组只分配比较名额，不把顺序当成等价或替模型选择某张牌。独立比较清空未执行提案的局部目标，避免初始目标成为排序的强制条件。双向结果按对齐概率求平均；致命约束有明确的合并优势时优先，否则比较整体价值。结束回合的追加动作使用同一双向机制。

Vercel Evaluation、OpenRouter Decisions 和 TypeSafe 原生 API 共享同一模型上下文及问题。提供方凭据只进入对应 HTTP 请求头；模型别名与用量、元数据置信度在传输边界适配。原始响应、每次请求的实际提供方、回退原因分别保存。限流和短暂故障只影响请求路由，不能触发重发已经交给游戏的动作，也不能根据低置信度改换模型来挑选答案。

## 状态变化与后续预览的依赖

`turn_debuff_projection.mjs` 将已核实的状态施加顺序与后续伤害预览联系起来。已核对原生 Bash、Uppercut、Thunderclap 与 Shockwave：攻击先造成伤害，再按顺序施加状态；Shockwave 直接施加状态。Artifact 消耗施加次数，群体技能只作用于原生目标预览列出的可命中对象。新的易伤改变后续攻击，新的虚弱改变当前敌方攻击意图，已有倍率不重复计算。由于 DTO 舍弃预览的小数部分，分析输出伤害与剩余生命范围，不以整数预览直接相乘伪装成精确结果。

`debuff_dependencies` 是分析字段；不会修改 `observation` 或既有历史。已知上限、自定义倍率、未解析次数及消耗资源后过期的 X 费命中次数保持未知。原有 `known_effects_only` 中受新状态影响的点估计留空，避免同时向模型提供互相矛盾的敌人生命或来袭伤害。范围仍以其他预览条件和已声明命中成立为前提，未覆盖的药水、升级、反应及未来敌方招式不能视为零效果。

步骤中的伤害范围明确标为 `before_block_and_hp_loss_caps`，与 `after_block_and_hp_loss_caps` 中逐步扣血／扣格挡及实际使用的限制分开。两者是不同计算阶段，不能将牌面 6 点伤害与 Slippery 限制后的 1 点 HP 损失视为冲突或择一忽略。后者共用现有有序伤害账目，未知修正与死亡触发仍使相关结果留空。

力量增减先于普通 Weak、Vulnerable 和 Shrink 倍率；敏捷增减先于 Frail。相应增量用有理数计算，再保留原生整数预览隐藏的小数范围，避免把 Shrink 的 -1 无限持续误判为未生效，也避免小数浮点误差跨越整数边界。原样使用的实时预览不会再次乘倍率。这仍以这些倍率保持生效为前提，不能用来模拟 Shrink 施加者死亡后的移除或其他未覆盖的倍率变化。[原生来源与回归](evidence/2026-09-21/run31-shrink-delta.json)。
