import test from 'node:test';
import assert from 'node:assert/strict';
import { completeCombat, fixtureCard } from './fixtures/context.mjs';
import { buildModCandidates } from '../src/mod_decision.mjs';
import { independentTurnCandidates, compareFinalists, balancePlanPreference, planAllocation, shortlistPlans } from '../src/turn_candidates.mjs';
import { inspectSequence } from '../src/turn_sequence.mjs';
import { describeContinuation, compareContinuationResources } from '../src/card_flow_projection.mjs';
import { describePlanAlternative } from '../src/turn_plan_refinement.mjs';
import { planStep } from '../src/turn_plan_state.mjs';

test('independent search offers distinct first actions and orders, preserves identities and stops at draws', () => {
  const state = completeCombat();
  state.combat.hand = ['A', 'B', 'DRAW'].map((id, index) => fixtureCard(id, { index, can_play: true, cost: 0,
    description: id === 'DRAW' ? 'Draw 1 card.' : 'Deal 6 damage.', target_type: 'Self', details: { instance_id: id } }));
  const snapshot = structuredClone(state);
  const result = independentTurnCandidates(state, buildModCandidates(state));
  const sequences = result.plans.map(p => p.filter(s => s.kind === 'play_card').map(s => s.card_instance_id).join(','));
  assert.ok(sequences.includes('A,B,DRAW')); assert.ok(sequences.includes('B,A,DRAW'));
  assert.ok(sequences.includes('DRAW')); assert.ok(!sequences.includes('DRAW,A'));
  assert.ok(result.plans.every(p => !inspectSequence(state, p).violations.length));
  assert.deepEqual(state, snapshot);
  const bounded = independentTurnCandidates(state, buildModCandidates(state), { maxInspections: 5, maxPlans: 2 });
  assert.ok(bounded.coverage.search_truncated); assert.ok(bounded.coverage.inspected_prefixes <= 5);
});

test('finalist review exposes position bias and does not mistake unanimous slot choice for certainty', async () => {
  const a = { value: 'keep', label: {} }, b = { value: 'other', label: {} };
  const result = await compareFinalists([b], a, async pairs => pairs.map(p => p[0].value), '', {});
  assert.equal(result.selected, 'keep');
  assert.equal(result.audit.order_disagreements.length, 1);
  assert.equal(result.audit.comparisons, 2);
  const stable = await compareFinalists([b], a, async pairs => pairs.map(() => 'other'), '', {});
  assert.equal(stable.selected, 'other'); assert.equal(stable.audit.order_disagreements.length, 0);
});

test('identical copies share shortlist capacity while targets, multiplicity, modifiers and bound identities remain distinct', () => {
  const state = completeCombat();
  state.combat.hand = ['a', 'b', 'c'].map((id, index) => fixtureCard('STRIKE_IRONCLAD', { index, details: { instance_id: id } }));
  state.combat.hand.push(fixtureCard('BASH', { index: 3, cost: 2, details: { instance_id: 'bash' } }));
  const hit = id => ({ kind: 'play_card', card_instance_id: id, target: 42 });
  const entry = (value, steps) => ({ value, allocation: planAllocation(steps, state),
    label: { energy_left: 0, continuation: { handoff: 'enemy_turn', further_player_choices: false } } });
  const plans = [entry('copy-a', [hit('a')]), entry('copy-b', [hit('b')]), entry('copy-c', [hit('c')]),
    entry('bash', [hit('bash')]), entry('two-hits', [hit('a'), hit('b')])];
  const original = structuredClone(state);
  const shortlist = shortlistPlans(plans, plans.map((p, i) => ({ value: p.value, score: 4 - i / 10 })));
  assert.deepEqual(shortlist.candidates.map(p => p.value), ['copy-a', 'bash', 'two-hits']);
  assert.notEqual(planAllocation([hit('a')], state), planAllocation([{ ...hit('b'), target: 43 }], state));
  state.combat.hand[1].details.enchantment = { id: 'SHARP', amount: 2 };
  assert.notEqual(planAllocation([hit('a')], state), planAllocation([hit('b')], state));
  delete state.combat.hand[1].details.enchantment;
  const upgrade = { kind: 'play_card', card_instance_id: 'armaments', beneficiary_instance_id: 'a' };
  assert.notEqual(planAllocation([upgrade, hit('a')], state), planAllocation([upgrade, hit('b')], state));
  assert.equal(plans.length, 5, 'Every concrete sequence remains in the assessment pool');
  assert.deepEqual(state, original);
});

test('a potion next-card trigger is consumed before a later manual action can reuse old previews', () => {
  const state = completeCombat();
  state.combat.player.potions = [{ id: 'DUPLICATOR', slot: 0, description: 'This turn, your next card is played an extra time.' }];
  state.combat.hand.push(fixtureCard('SECOND', { details: { instance_id: 'SECOND' }, cost: 0 }));
  const steps = [{ kind: 'use_potion', potion_id: 'DUPLICATOR', slot: 0 }, { kind: 'play_card', card_instance_id: 'STRIKE_IRONCLAD', target: 42 }, { kind: 'play_card', card_instance_id: 'SECOND', target: 42 }];
  const result = inspectSequence(state, steps);
  assert.equal(result.checkpoint.after_sequence, 1);
  assert.ok(result.violations.some(v => v.sequence === 2));
});

test('aligned probabilities preserve a strong preference despite a narrow reversed-order vote', () => {
  const pair = [{ value: 'a' }, { value: 'b' }];
  const first = { selected: 'a', value_assessment: { choice: 'plan_a', probabilities: { plan_a: 0.99, plan_b: 0.01 } } };
  const second = { selected: 'b', value_assessment: { choice: 'plan_a', probabilities: { plan_a: 0.51, plan_b: 0.49 } } };
  const result = balancePlanPreference(pair, first, second);
  assert.equal(result.order_disagreement, true);
  assert.equal(result.preference_support.a, 0.74);
  assert.deepEqual(balancePlanPreference([...pair].reverse(), second, first).preference_support, result.preference_support);
  first.survival_assessment = { choice: 'plan_b', probabilities: { plan_a: 0, plan_b: 0.9, no_clear_difference: 0.1 } };
  second.survival_assessment = { choice: 'plan_a', probabilities: { plan_a: 0.9, plan_b: 0, no_clear_difference: 0.1 } };
  const survival = balancePlanPreference(pair, first, second);
  assert.equal(survival.selection_basis, 'balanced_survival_constraint');
  assert.equal(survival.preference_support.b, 1);
});

test('explicit no-difference probability is neutral while supported survival still takes precedence', async () => {
  const pair = [{ value: 'a' }, { value: 'b' }];
  const first = { selected: null, value_assessment: { choice: 'no_clear_difference', probabilities: { plan_a: 0.03, plan_b: 0.01, no_clear_difference: 0.96 } } };
  const second = { selected: null, value_assessment: { choice: 'no_clear_difference', probabilities: { plan_a: 0.01, plan_b: 0.05, no_clear_difference: 0.94 } } };
  const result = balancePlanPreference(pair, first, second);
  assert.deepEqual(result.preference_support, { a: 0.5, b: 0.5 });
  assert.equal(result.selection_basis, 'no_supported_difference');
  assert.deepEqual(balancePlanPreference([...pair].reverse(), second, first).preference_support, result.preference_support);
  const finalists = await compareFinalists([pair[0]], pair[1], async () => [first, second], '', {});
  assert.equal(finalists.selected, 'b', 'No residual probability overrides the existing plan');
  first.survival_assessment = { choice: 'plan_a', probabilities: { plan_a: 0.9, plan_b: 0.01, no_clear_difference: 0.09 } };
  second.survival_assessment = { choice: 'plan_b', probabilities: { plan_a: 0.01, plan_b: 0.9, no_clear_difference: 0.09 } };
  const survival = balancePlanPreference(pair, first, second);
  assert.equal(survival.selection_basis, 'balanced_survival_constraint');
  assert.ok(survival.preference_support.a > 0.98);
});

test('draw continuations expose retained choices and pool access without a predicted hand', () => {
  const state = completeCombat();
  state.combat.hand.push(fixtureCard('DRAW', { cost: 0, description: 'Draw 3 cards. You cannot draw additional cards this turn.', details: { instance_id: 'draw' } }));
  state.combat.draw_pile = [fixtureCard('DRAW_POOL', { cost: 2 }), fixtureCard('DRAW_POOL', { cost: 2 })];
  const before = structuredClone(state);
  const sequence = inspectSequence(state, [{ kind: 'play_card', card_instance_id: 'draw' }]);
  const continuation = describeContinuation(state.combat, sequence);
  assert.equal(continuation.handoff, 'observe_then_continue_same_player_turn');
  assert.equal(continuation.energy_after_known_payments, state.combat.player.energy);
  assert.equal(continuation.remaining_hand_before_unresolved_effects.length, 1);
  assert.equal(continuation.draw_access.declared_count, 3);
  assert.equal(continuation.draw_access.pool[0].count, 2);
  assert.equal(continuation.draw_access.pool_cards_within_remaining_energy_at_observed_cost, 2);
  assert.equal(continuation.draw_access.reshuffle_may_be_needed, true);
  assert.match(continuation.draw_access.checkpoint_rules, /cannot draw/);
  assert.deepEqual(state, before);
  assert.equal(describeContinuation(state.combat, inspectSequence(state, [{ kind: 'end_turn' }])).further_player_choices, false);
});

test('observation comparisons expose unspent alternatives without promising a post-draw outcome', () => {
  const state = completeCombat(); state.combat.player.energy = 1;
  state.combat.hand.push(fixtureCard('DRAW', { index: 1, cost: 0, can_play: true, target_type: 'Self', description: 'Draw 3 cards.', details: { instance_id: 'draw' } }));
  const candidates = buildModCandidates(state);
  const draw = planStep(state, candidates.get('card_1')), attack = planStep(state, candidates.get('card_0_target_42'));
  const early = describePlanAlternative(state, [draw]), late = describePlanAlternative(state, [attack, draw]);
  const relation = compareContinuationResources(early, late);
  assert.equal(relation.after_plan_a_observation.total_observed_cost, 1);
  assert.equal(relation.after_plan_a_observation.fits_remaining_energy_at_observed_cost, true);
  assert.equal(relation.after_plan_b_observation, null);
  assert.match(relation.after_plan_a_observation.scope, /no follow-up effect is guaranteed/);
  assert.deepEqual(compareContinuationResources(late, early).after_plan_b_observation, relation.after_plan_a_observation);
  early.continuation.remaining_hand_before_unresolved_effects[0].cost = -1;
  assert.equal(compareContinuationResources(early, late).after_plan_a_observation.fits_remaining_energy_at_observed_cost, null);
});

test('retrieval checkpoints distinguish earlier completed plays from the still-resolving card', () => {
  const state = completeCombat();
  state.combat.hand = [
    fixtureCard('DEFEND_IRONCLAD', { index: 0, type: 'Skill', cost: 1, block: 8, description: 'Gain 8 Block.', details: { instance_id: 'defend' } }),
    fixtureCard('HEADBUTT', { index: 1, cost: 1, description: 'Deal 9 damage. Put a card from your Discard Pile on top of your Draw Pile.', details: { instance_id: 'headbutt' } })
  ];
  state.combat.discard_pile = [];
  const before = structuredClone(state);
  const sequence = inspectSequence(state, [{ kind: 'play_card', card_instance_id: 'defend' }, { kind: 'play_card', card_instance_id: 'headbutt', target: 42 }]);
  const access = describeContinuation(state.combat, sequence).conditional_pile_access;
  assert.equal(access.observed_discard_count, 0);
  assert.deepEqual(access.earlier_completed_plays.map(c => [c.instance_id, c.ordinary_post_play_destination]), [['defend', 'discard_pile']]);
  assert.equal(access.checkpoint_source_id, 'HEADBUTT');
  assert.deepEqual(state, before);
});

test('shortlisting compares different commitments instead of filling its slots with permutations', () => {
  const step = (id, target = 42) => ({ kind: 'play_card', card_instance_id: id, target });
  const entry = (value, steps, energy, observe = false) => ({ value, allocation: planAllocation(steps),
    label: { energy_left: energy, continuation: { handoff: observe ? 'observe' : 'end', further_player_choices: observe } } });
  const plans = [entry('ab', [step('a'), step('b')], 0), entry('ba', [step('b'), step('a')], 0),
    entry('other_target', [step('a', 99), step('b', 99)], 0), entry('late_draw', [step('a'), step('draw')], 0, true),
    entry('early_draw', [step('draw')], 3, true)];
  const judgments = plans.map((plan, i) => ({ value: plan.value, score: 4 - i * 0.2 }));
  const result = shortlistPlans(plans, judgments);
  assert.deepEqual(result.candidates.map(item => item.value), ['ab', 'other_target', 'late_draw', 'early_draw']);
  assert.equal(result.allocation_count, 4);
  assert.equal(result.assessments.at(-1).reason, 'preserve_resources_for_observation');
  assert.throws(() => shortlistPlans(plans, judgments.slice(1)), /coverage/);
});
