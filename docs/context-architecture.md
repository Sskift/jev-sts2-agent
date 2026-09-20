# Unified Jev context architecture

The objective remains one autonomous standard run through all three acts and the formal victory screen. The next architectural change addresses how the system represents a decision, rather than adding another card-specific instruction. It does not claim improved win rate before live evidence exists.

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

After this is running, the next architectural question is strategic memory across rooms and combats: retain explicit, revisable deck/resource priorities rather than only a local turn objective. That needs a separate evidence-based design. It must not silently convert an earlier model judgment into an observed fact or lock the run into an obsolete strategy.
