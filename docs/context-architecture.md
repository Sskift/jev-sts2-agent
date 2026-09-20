# Unified Jev context architecture

The objective remains one autonomous standard run through all three acts and the formal victory screen. The implemented architecture addresses how the system represents a decision. It does not claim improved win rate before live evidence exists.

## Current problem

The internal v1 packet contains the required observations and reference material, but mixes several kinds of information. Derived route statistics live beside map observations; partial combat arithmetic appears inside current combat and action descriptions; an intended sequence and its partial projection share a container. Planning phases construct their own extra state. Lossless packing preserves data but does not establish a consistent reading order or a clear source of truth.

A rule being present is not sufficient. The model must be able to connect the rule to the current entity, distinguish already observed effects from an intended action, understand what question is being asked, and recognize the limits of any calculation.

## Pipeline

1. **Acquire and validate observations.** The native mod produces one main-thread snapshot. Node validates identities, complete piles, legality and mutually consistent fields. Hidden draws and future random outcomes remain unknown.
2. **Join knowledge and history.** A versioned local rule library supplies transitive relationships. Native current values take precedence. Local memory supplies confirmed past actions and the still-active turn intention. Every request remains self-contained.
3. **Build the decision specification.** The planner supplies a typed question, all offered alternatives, its horizon and any parent intention. This stage does not execute an action or make its predicted effects true.
4. **Compile one model-facing context.** All decision stages pass through the same compiler immediately before the API call. The compiler routes content by epistemic role, builds generic entity-to-rule links, and emits a v2 packet with a stable observation identity and decision-stage metadata.
5. **Encode without losing facts.** Existing lossless tables and in-request text references remain supported. Readable current records use spare capacity. A compiler round trip must preserve the entire canonical packet, question keys and choices; insufficient capacity stops before an action.
6. **Execute and reconcile.** Jev selects an offered result. Code validates identity and legality, dispatches one action, reads its actual result and either follows the remaining plan or requests a revision. The original observation, wire request, answer and result stay inspectable.

## Model-facing domains

| Domain | Meaning | Authority |
|---|---|---|
| `decision` | Current phase, horizon, output mode, observation identity, question keys and path aliases | Compiler metadata; not game facts |
| `observation` | Run/player/deck/piles/map/interaction and legal commands | Validated current snapshot |
| `knowledge` | Versioned rule catalogue, generic entity links, glossary and resolved mechanic facts | Rules; live observations override base values |
| `history` | Confirmed combat events, local run memory and recent changes | Past observations, with coverage limits |
| `intent` | Overall objective, persistent turn plan and the unexecuted proposed sequence | Intentions, never observations |
| `analysis` | Route statistics, partial arithmetic, action estimates, conditional projections and model assessments | Explicitly conditional or advisory |
| `uncertainty` | Extraction/coverage limits and unknown information | Absence stays unknown |

Question-specific choices remain in the native `questions` API field. A shared path-alias contract translates the internal planner's references into these domains. The compiler preserves the original canonical contract for execution and replay; the transport layout cannot change game commands.

## Boundaries and subsequent work

The first implementation centralizes every existing request and preserves all its semantic content. It does not add more model calls, replace Jev's choices with heuristics, or claim a complete simulator. Rule links are based on category and stable IDs, not a list of favored cards. Coverage describes which data and rules were included, not whether all game mechanics have been modeled.

## Strategic memory across rooms

The main loop now asks Jev for one batched strategic assessment at meaningful checkpoints. Seven typed scores describe single-target damage, multiple-enemy control, sustained defense, long-fight scaling, draw consistency, energy efficiency and recovery. Independent choices select a development priority and an anchor from the actually owned cards/relics, including an explicit no-anchor choice. These judgments do not create actions, filter offers or force an archetype.

The result persists under the current run ID. A build fingerprint tracks permanent card multiplicities, upgrades, enchantments/afflictions, owned relic identities and maximum HP. A different act, a changed build, a new room, or a transition from combat to its aftermath requests a review. Ordinary changes to the hand, energy, current HP or cycling relic counters do not create a new strategic call. Every tactical/route/reward/selection request still includes current facts, so immediate survival and superior concrete options can override the earlier development priority.

The compiler places the development intention and its freshness under `intent.run_strategy`, the latest complete capability ratings under `analysis.run_capability_assessment`, and every change of development priority or anchor under `history.strategy_revisions`. Each included revision records its checkpoint and review reason. Superseded numerical ratings and confidence-only changes stay in the full local audit archive; they are not repeatedly injected as strategic evidence. `history.strategy_coverage` states that policy and both record counts. This policy removes no game observations or confirmed actions. Prior model judgments never become native observations. A new run discards the previous run's intention, and an incomplete model response cannot partially commit a strategy or dispatch a game command.

`run_strategy.mjs` supplies the assessment and result parsing; `run_strategy_state.mjs` owns lifetime, change detection and persistence. Offline decision replays can leave strategic refresh disabled while still carrying any strategy present at their historical cutoff. The production loop explicitly enables it and saves each actual strategy request, context metrics and parsed result next to the action artifacts.

## Coverage and source lifetimes

`rule_entities.mjs` is the shared typed-identity registry for both retrieval roots and model-facing rule joins. It recognizes permanent/combat card collections, offered card IDs, current effects, attached modifications, events and the visible map boss. Retrieval uses the declared category and stable ID first. An unknown authoritative ID remains missing; legacy name-only bosses may resolve uniquely within the encounter category. The earlier independent traversals could leave an encounter unreferenced when its name also belonged to a monster. With the shared registry, a visible encounter leads to its monster repertoire and related mechanics without revealing which future random choice will occur.

The context has three distinct retention policies: current observations refresh after every confirmed action; applicable public rules are retrieved through entity relationships; model judgments expire or are replaced according to their decision horizon. Complete raw observations, requests, answers and strategy revisions remain in local artifacts for audit. The canonical decision packet is the explicitly scoped view for one decision; compilation and transport must preserve that view exactly. A local archive is never described as implicit model memory.

Every emitted request logs bytes per domain, question bytes, selected rule counts and missing current rule links. `npm run context:preview` saves both canonical and compiled model context without a model call or game action; its report states that later planning questions and optional readability expansion are not part of that preview. These diagnostics make context pressure and retrieval gaps visible instead of treating a valid JSON shape as proof of semantic completeness.

Run 23 actual map, reward, combat and modal-selection requests contain the same strategic domains. Consecutive actions 50–52 share strategic revision 9 and one turn plan; actions 51–52 make no new planning call. At floor 13, replacing accumulated old model scores with the scoped history policy reduced the same observation's compiled current-choice request from 70,550 to 61,260 bytes. The reference repair also included the previously missing Vantom encounter and monster rules. See [runtime evidence](evidence/2026-09-20/run23-context-architecture.json). These observations verify data flow and capacity, not optimal decisions or a completed run.
