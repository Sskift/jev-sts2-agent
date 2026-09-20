import { createHash } from 'node:crypto';
import { planStep, cardInstance } from './turn_plan_state.mjs';
import { handUpgradeMode, nextCardKind } from './turn_effects.mjs';
import { inspectSequence } from './turn_sequence.mjs';
import { reserveActionSequence } from './turn_action_constraints.mjs';

export const planSignature = steps => JSON.stringify(steps.map(s => [s.kind, s.card_instance_id, s.potion_id, s.slot, s.target, s.beneficiary_instance_id, s.next_card_instance_id]));

// Only shortlist diversity changes: every exact sequence is still assessed.
// Equivalent visible copies should not crowd out other resource commitments.
export function planAllocation(steps, state) {
  const allocation = JSON.parse(planSignature(steps));
  // Keep bound identities distinct: upgrading one copy then playing another
  // must not collapse into upgrading and playing the same copy.
  if (state && !steps.some(s => s.beneficiary_instance_id || s.next_card_instance_id)) {
    const copies = new Map((state.combat.hand || []).map(card => {
      const copy = structuredClone(card); delete copy.index; delete copy.instance_id;
      if (copy.details) delete copy.details.instance_id;
      return [cardInstance(card), JSON.stringify(copy)];
    }));
    for (const item of allocation) if (item[0] === 'play_card' && copies.has(item[1])) item[1] = copies.get(item[1]);
  }
  return JSON.stringify(allocation.map(item => JSON.stringify(item)).sort());
}

export function shortlistPlans(candidates, judgments) {
  if (judgments.length !== candidates.length || judgments.some((j, index) => j.value !== candidates[index].value || !Number.isFinite(j.score))) throw new Error('Invalid turn-plan assessment coverage');
  const scores = new Map(judgments.map(j => [j.value, j]));
  const ranked = candidates.toSorted((a, b) => scores.get(b.value).score - scores.get(a.value).score || a.value.localeCompare(b.value));
  const allocations = new Map();
  for (const item of ranked) if (!allocations.has(item.allocation)) allocations.set(item.allocation, item);
  const selected = new Map();
  const add = (item, reason) => {
    if (!selected.has(item.value)) selected.set(item.value, { item, reason });
  };
  for (const item of [...allocations.values()].slice(0, 3)) add(item, 'best_assessed_distinct_allocation');
  // A short observation segment is a different resource commitment, not a
  // failed attempt at a long end-turn plan. Keep the best of each horizon and
  // a maximal-energy observation option for explicit comparison, not priority.
  for (const handoff of new Set(ranked.map(item => item.label.continuation.handoff))) {
    add(ranked.find(item => item.label.continuation.handoff === handoff), 'best_assessed_handoff');
  }
  const observations = ranked.filter(item => item.label.continuation.further_player_choices);
  if (observations.length) {
    const energy = Math.max(...observations.map(item => item.label.energy_left));
    add(observations.find(item => item.label.energy_left === energy), 'preserve_resources_for_observation');
  }
  return { candidates: [...selected.values()].map(({ item }) => item), allocation_count: allocations.size,
    assessments: [...selected.values()].map(({ item, reason }) => ({ ...scores.get(item.value), reason,
      handoff: item.label.continuation.handoff, energy_left: item.label.energy_left })) };
}

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

// Normalize rounding in the provider distribution. Choice-only callers remain
// supported, but their one-hot votes carry no measured probability information.
const distribution = answer => {
  const probabilities = answer?.probabilities || { [answer?.choice]: 1 };
  const sum = Object.values(probabilities).reduce((n, p) => n + p, 0);
  if (!(sum > 0) || Object.values(probabilities).some(p => !Number.isFinite(p) || p < 0 || p > 1)) throw new Error('Invalid plan preference distribution');
  return Object.fromEntries(Object.entries(probabilities).map(([key, p]) => [key, p / sum]));
};

export function balancePlanPreference(pair, forward, reverse) {
  const normalize = (result, options) => typeof result === 'string'
    ? { selected: result, value_assessment: { choice: result === options[0].value ? 'plan_a' : 'plan_b' } } : result;
  const a = normalize(forward, pair), b = normalize(reverse, [...pair].reverse());
  if (![a, b].every(r => pair.some(p => p.value === r?.selected))) throw new Error('Invalid finalist comparison');
  const average = field => {
    const first = distribution(a[field]), second = distribution(b[field]);
    return { plan_a: ((first.plan_a || 0) + (second.plan_b || 0)) / 2,
      plan_b: ((first.plan_b || 0) + (second.plan_a || 0)) / 2,
      no_clear_difference: ((first.no_clear_difference || 0) + (second.no_clear_difference || 0)) / 2 };
  };
  const value = average('value_assessment');
  const survival = a.survival_assessment && b.survival_assessment ? average('survival_assessment') : null;
  const survivalAdvantage = survival && Math.abs(survival.plan_a - survival.plan_b) > 1e-9
    && Math.max(survival.plan_a, survival.plan_b) > survival.no_clear_difference;
  const chosen = survivalAdvantage ? survival : value;
  const total = chosen.plan_a + chosen.plan_b;
  return { candidates: pair.map(p => p.value), preference_support: { [pair[0].value]: total ? chosen.plan_a / total : 0.5,
    [pair[1].value]: total ? chosen.plan_b / total : 0.5 },
    selection_basis: survivalAdvantage ? 'balanced_survival_constraint' : 'balanced_overall_value',
    value_distribution: value, survival_distribution: survival,
    order_disagreement: a.selected !== b.selected, selected_by_order: [a.selected, b.selected] };
}

/** Finalists meet in both orders. Average aligned distributions before ranking;
 * a narrow 51/49 reversal must not cancel an opposing 99/1 preference. This is
 * preference support among the finalists, never a calibrated correctness score.
 */
export async function compareFinalists(finalists, incumbent, compare, instruction, context) {
  const unique = [...new Map([...finalists, incumbent].map(item => [item.value, item])).values()];
  const pairs = [];
  for (let i = 0; i < unique.length; i++) for (let j = i + 1; j < unique.length; j++) pairs.push([unique[i], unique[j]], [unique[j], unique[i]]);
  if (!pairs.length) return { selected: unique[0].value, audit: { comparisons: 0, order_disagreements: [] } };
  const judgments = await compare(pairs, instruction, context);
  if (judgments.length !== pairs.length) throw new Error('Invalid finalist comparison');
  const support = new Map(unique.map(item => [item.value, 0])), balanced = [];
  for (let i = 0; i < pairs.length; i += 2) {
    const result = balancePlanPreference(pairs[i], judgments[i], judgments[i + 1]); balanced.push(result);
    for (const [id, p] of Object.entries(result.preference_support)) support.set(id, support.get(id) + p);
  }
  const ranked = unique.toSorted((a, b) => {
    const difference = support.get(b.value) - support.get(a.value);
    return Math.abs(difference) > 1e-9 ? difference
      : Number(b.value === incumbent.value) - Number(a.value === incumbent.value) || a.value.localeCompare(b.value);
  });
  return { selected: ranked[0].value, audit: { comparisons: pairs.length, preference_support: Object.fromEntries(support), balanced_pairs: balanced,
    order_disagreements: balanced.filter(r => r.order_disagreement).map(({ candidates, selected_by_order }) => ({ candidates, selected_by_order })),
    tied_at_top: ranked.filter(item => Math.abs(support.get(item.value) - support.get(ranked[0].value)) < 1e-9).map(item => item.value),
    interpretation: 'Position-balanced preference support among these finalists only, not correctness or win probability. Independent quality scores and bounded search can still omit a better plan.' } };
}
