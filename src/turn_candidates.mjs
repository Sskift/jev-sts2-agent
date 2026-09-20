import { createHash } from 'node:crypto';
import { planStep, cardInstance } from './turn_plan_state.mjs';
import { handUpgradeMode, nextCardKind } from './turn_effects.mjs';
import { inspectSequence } from './turn_sequence.mjs';
import { reserveActionSequence } from './turn_action_constraints.mjs';

export const planSignature = steps => JSON.stringify(steps.map(s => [s.kind, s.card_instance_id, s.potion_id, s.slot, s.target, s.beneficiary_instance_id, s.next_card_instance_id]));

/** Enumerate independent ordered segments, without scoring their tactics.
 * Round-robin DFS across first actions avoids exploring only the greedy seed.
 * Stratify bounded output by first action and length. Unknown results stop the
 * segment. Search/selection limits are visible, never called exhaustive.
 */
export function independentTurnCandidates(state, candidates, { maxInspections = 4096, maxPlans = 64 } = {}) {
  const actions = [...candidates.values()].filter(c => ['play_card', 'use_potion'].includes(c.request.cmd)).map(c => planStep(state, c));
  const endCandidate = [...candidates.values()].find(c => c.request.cmd === 'end_turn');
  const end = endCandidate && planStep(state, endCandidate, 'finish_turn');
  if (!end) return { plans: [], coverage: { reason: 'No legal end-turn action.' } };
  let inspections = 0;
  function variants(action, available) {
    if (handUpgradeMode(action.rules_at_planning) !== 'one') return [action];
    const targets = available.filter(card => cardInstance(card) !== action.card_instance_id && card.upgrade_preview);
    return targets.length ? targets.map(card => ({ ...action, role: 'preparation', beneficiary_instance_id: cardInstance(card), beneficiary_name: card.name })) : [action];
  }
  function* visit(prefix) {
    if (inspections >= maxInspections) return;
    inspections++;
    const walked = inspectSequence(state, prefix);
    if (walked.violations.length || !reserveActionSequence(state, prefix).valid) return;
    const bound = prefix.map((step, index) => {
      const consumer = nextCardKind(step.rules_at_planning);
      const next = consumer && prefix.slice(index + 1).find(s => s.kind === 'play_card' && (consumer === 'Any' || s.card_type === consumer));
      return next ? { ...step, role: 'preparation', next_card_instance_id: next.card_instance_id, next_card_type: consumer,
        beneficiary_instance_id: next.card_instance_id, beneficiary_name: next.name } : step;
    });
    yield [...bound, end];
    if (walked.checkpoint) return;
    const available = new Set(walked.remaining_hand.map(cardInstance));
    const potions = new Set(prefix.filter(s => s.kind === 'use_potion').map(s => s.slot));
    for (const action of actions) {
      if (action.kind === 'play_card' ? !available.has(action.card_instance_id) : potions.has(action.slot)) continue;
      for (const step of variants(action, walked.remaining_hand)) yield* visit([...prefix, step]);
    }
  }
  const roots = actions.flatMap(action => variants(action, state.combat.hand));
  const walks = roots.map(root => visit([root])), buckets = roots.map(() => new Map()), all = new Map();
  let active = walks.map((walk, index) => ({ walk, index }));
  while (active.length && inspections < maxInspections) {
    const remaining = [];
    for (const { walk, index } of active) {
      const result = walk.next();
      if (result.done) continue;
      const steps = result.value, key = planSignature(steps);
      if (!all.has(key)) {
        all.set(key, steps);
        const group = buckets[index].get(steps.length) || [];
        group.push(key); buckets[index].set(steps.length, group);
      }
      remaining.push({ walk, index });
    }
    active = remaining;
  }
  const selected = new Map([[planSignature([end]), [end]]]);
  const add = key => { if (key) selected.set(key, all.get(key)); };
  // Include each first-action/upgrade-target alternative, then multiple depths
  // and continuations. Hash ordering is deterministic and tactical-score free.
  for (const groups of buckets) add(groups.get(2)?.[0]);
  const stratified = buckets.map(groups => [...groups].sort(([a], [b]) => b - a).map(([, group]) => group
    .sort((a, b) => createHash('sha256').update(a).digest('hex').localeCompare(createHash('sha256').update(b).digest('hex')))));
  const limit = Math.max(maxPlans, selected.size);
  for (let offset = 0; selected.size < limit; offset++) {
    let added = false;
    for (const groups of stratified) for (const group of groups) {
      if (selected.size >= limit) break;
      if (group[offset] && !selected.has(group[offset])) { add(group[offset]); added = true; }
    }
    if (!added) break;
  }
  return { plans: [...selected.values()], coverage: { inspected_prefixes: inspections, enumerated_plans: all.size + 1,
    selected_plans: selected.size, first_action_variants: roots.length,
    search_truncated: active.length > 0, candidate_selection_truncated: selected.size < all.size + 1,
    scope: 'Current legal card/potion commands, explicit upgrade targets and known order/energy constraints. Stops at observation checkpoints. Does not assume newly playable commands, generated cards or hidden outcomes. Candidate sampling is structural, not a damage or build heuristic.' } };
}

/** Finalists meet directly in both presentation orders. Disagreement is
 * recorded; raw Choice confidence is not treated as probability of correctness.
 * A structural tie uses the incumbent, then a stable signature, not a tactic.
 */
export async function compareFinalists(finalists, incumbent, compare, instruction, context) {
  const unique = [...new Map([...finalists, incumbent].map(item => [item.value, item])).values()];
  const pairs = [];
  for (let i = 0; i < unique.length; i++) for (let j = i + 1; j < unique.length; j++) pairs.push([unique[i], unique[j]], [unique[j], unique[i]]);
  if (!pairs.length) return { selected: unique[0].value, audit: { comparisons: 0, order_disagreements: [] } };
  const winners = await compare(pairs, instruction, context);
  if (winners.length !== pairs.length || winners.some((id, index) => !pairs[index].some(p => p.value === id))) throw new Error('Invalid finalist comparison');
  const wins = new Map(unique.map(item => [item.value, 0])), disagreements = [];
  for (const id of winners) wins.set(id, wins.get(id) + 1);
  for (let i = 0; i < pairs.length; i += 2) if (winners[i] !== winners[i + 1]) disagreements.push({ candidates: pairs[i].map(p => p.value), selected_by_order: winners.slice(i, i + 2) });
  const ranked = unique.toSorted((a, b) => wins.get(b.value) - wins.get(a.value)
    || Number(b.value === incumbent.value) - Number(a.value === incumbent.value)
    || a.value.localeCompare(b.value));
  return { selected: ranked[0].value, audit: { comparisons: pairs.length, wins: Object.fromEntries(wins), order_disagreements: disagreements,
    tied_at_top: ranked.filter(item => wins.get(item.value) === wins.get(ranked[0].value)).map(item => item.value),
    interpretation: 'Preference consistency among these finalists only; neither vote count nor confidence proves tactical correctness. Earlier bounded elimination can still omit a better plan.' } };
}
