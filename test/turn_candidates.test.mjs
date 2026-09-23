import test from 'node:test';
import assert from 'node:assert/strict';
import { completeCombat, fixtureCard } from './fixtures/context.mjs';
import { buildModCandidates } from '../src/mod_decision.mjs';
import { independentTurnCandidates, adjacentPlanOrders, concentratedPlanTargets, compareFinalists, balancePlanPreference, planOrderSignature, planAllocation, shortlistPlans, limitPlanAssessments } from '../src/turn_candidates.mjs';
import { inspectSequence } from '../src/turn_sequence.mjs';
import { describeContinuation, compareContinuationResources } from '../src/card_flow_projection.mjs';
import { describePlanAlternative } from '../src/turn_plan_refinement.mjs';
import { planStep } from '../src/turn_plan_state.mjs';
import { reserveSequence, unavailableTargetsAfterPrefix } from '../src/turn_projection.mjs';

test('ordered candidates cannot spend another card on a certainly depleted target or after combat ends', () => {
  const state = completeCombat(); state.combat.player.energy = 3;
  state.combat.enemies[0].hp = 9;
  state.combat.enemies.push({ ...structuredClone(state.combat.enemies[0]), combat_id: 43, hp: 30 });
  state.combat.hand = [9, 6].map((damage, index) => fixtureCard('STRIKE_IRONCLAD', { index, damage,
    description: `Deal ${damage} damage.`, can_play: true, target_type: 'AnyEnemy',
    target_previews: [42, 43].map(target_id => ({ target_id, damage })), details: { instance_id: `attack${index}` } }));
  state.combat.hand.push(fixtureCard('DEFEND_IRONCLAD', { index: 2, type: 'Skill', description: 'Gain 5 Block.',
    block: 5, can_play: true, target_type: 'Self', details: { instance_id: 'defend' } }));
  const original = structuredClone(state), candidates = buildModCandidates(state);
  const step = id => planStep(state, candidates.get(id));
  const kill = step('card_0_target_42'), stale = step('card_1_target_42'), next = step('card_1_target_43'), defend = step('card_2');
  assert.deepEqual(unavailableTargetsAfterPrefix(state, [kill]), [42]);
  assert.equal(reserveSequence(state, [kill, stale]), null);
  assert.ok(reserveSequence(state, [kill, next]), 'The remaining card can still target another enemy');
  assert.ok(reserveSequence(state, [kill, defend]), 'A surviving enemy leaves a use for other actions');
  const generated = independentTurnCandidates(state, candidates).plans;
  assert.ok(generated.some(p => p[0].card_instance_id === kill.card_instance_id && p[0].target === 42 && p[1]?.target === 43));
  assert.ok(generated.every(p => reserveSequence(state, p)));
  assert.deepEqual(state, original);
  state.combat.enemies.pop();
  assert.equal(reserveSequence(state, [kill, defend]), null, 'Do not promise manual actions after the final kill');
  assert.ok(reserveSequence(state, [kill, { kind: 'end_turn' }]), 'An end marker can terminate the planned segment');
  state.combat.enemies[0].powers = [{ id: 'REVIVE_POWER', description: 'Upon death, revive with 10 HP.' }];
  assert.deepEqual(unavailableTargetsAfterPrefix(state, [kill]), [], 'Unresolved revival does not prove removal');
  state.combat.enemies[0].powers = [];
  state.combat.hand[0].description = 'Deal 9 damage. Draw 1 card.';
  assert.deepEqual(unavailableTargetsAfterPrefix(state, [planStep(state, buildModCandidates(state).get('card_0_target_42'))]), [], 'An observation checkpoint still requires native state');
});

test('assessment spending cap retains the seed, ending and changed order without editing context or ranking tactics', () => {
  const entry = (value, allocation, names) => ({ value, allocation, label: {
    ordered_sequence: names.map(action => ({ action, rules: `Complete rule for ${action}` })),
    conditional_preview: { unresolved: ['full facts remain'] }
  } });
  const candidates = [entry('keep', 'ab', ['A', 'B']), entry('reverse', 'ab', ['B', 'A']), entry('end', '', [])];
  for (let index = 0; index < 30; index++) candidates.push(entry(`x${index}`, `allocation${Math.floor(index / 2)}`, [`X${index}`]));
  const before = structuredClone(candidates), sampled = limitPlanAssessments(candidates, 12);
  assert.equal(sampled.length, 12);
  assert.deepEqual(sampled.slice(0, 3).map(p => p.value), ['keep', 'end', 'reverse']);
  assert.ok(new Set(sampled.map(p => p.allocation)).size > 3);
  assert.deepEqual(limitPlanAssessments([...candidates].reverse(), 12), sampled, 'Enumeration order cannot silently become a tactical preference');
  assert.ok(sampled.every(item => candidates.includes(item)), 'Keep complete existing alternatives instead of shortening their facts');
  assert.deepEqual(candidates, before);
  assert.equal(limitPlanAssessments(candidates), candidates);
  assert.throws(() => limitPlanAssessments(candidates, 1), /limit/);
});

test('target coverage offers shared legal targets and keeps distinct calculated defeats within the same assessment cap', () => {
  const state = completeCombat(); state.combat.player.energy = 3;
  state.combat.enemies[0].hp = 18;
  state.combat.enemies.push({ ...structuredClone(state.combat.enemies[0]), combat_id: 43 });
  state.combat.hand = [0, 1].map(index => fixtureCard('STRIKE_IRONCLAD', { index, damage: 6,
    description: 'Deal 6 damage.', can_play: true, target_type: 'AnyEnemy',
    target_previews: [42, 43].map(target_id => ({ target_id, damage: 6 })), details: { instance_id: `attack${index}` } }));
  state.combat.hand.push(fixtureCard('TAUNT', { index: 2, type: 'Skill', block: 6, damage: 0,
    description: 'Gain 6 Block. Apply 1 Vulnerable.', can_play: true, target_type: 'AnyEnemy',
    details: { instance_id: 'debuff' } }));
  const choices = buildModCandidates(state), original = structuredClone(state);
  const seed = ['card_2_target_42', 'card_0_target_43', 'card_1_target_42', 'end_turn'].map(id => planStep(state, choices.get(id)));
  const concentrated = [...concentratedPlanTargets([seed], state, choices)];
  assert.deepEqual(concentrated.map(steps => steps.slice(0, -1).map(s => s.target)), [[42, 42, 42], [43, 43, 43]]);
  assert.ok(concentrated.every(steps => reserveSequence(state, steps)));
  const entry = (value, steps) => ({ value, allocation: planAllocation(steps, state), label: describePlanAlternative(state, steps) });
  const entries = [entry('keep', seed), entry('end', [seed.at(-1)]), ...concentrated.map((steps, i) => entry(`focus${i}`, steps))];
  for (let i = 0; i < 20; i++) entries.push({ ...entry(`other${i}`, [seed[0], seed.at(-1)]), allocation: `other${i}` });
  const sampled = limitPlanAssessments(entries, 9);
  assert.equal(sampled.length, 9);
  assert.ok(sampled.some(p => p.value === 'focus0')); assert.ok(sampled.some(p => p.value === 'focus1'));
  assert.deepEqual(limitPlanAssessments([...entries].reverse(), 9), sampled);
  const restricted = new Map([...choices].filter(([id]) => id !== 'card_2_target_43'));
  assert.equal([...concentratedPlanTargets([seed], state, restricted)].length, 1, 'All commands must legally accept the shared target');
  assert.deepEqual(state, original);
});

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

test('order review reaches every sampled commitment and keeps targets, copies and the end boundary', () => {
  const play = (id, target) => ({ kind: 'play_card', card_instance_id: id, target });
  const end = { kind: 'end_turn' };
  const plans = [[play('seed', 1), end], [play('a', 2), play('b', 2), end],
    [play('a', 1), play('copy', 2), play('c', 1), end]];
  const original = structuredClone(plans);
  const orders = [...adjacentPlanOrders(plans)];
  assert.deepEqual(orders.map(p => p.map(s => s.card_instance_id || 'end')), [
    ['b', 'a', 'end'], ['copy', 'a', 'c', 'end'], ['a', 'c', 'copy', 'end']
  ]);
  assert.deepEqual(orders.map(p => p.filter(s => s.kind === 'play_card').map(s => s.target)), [[2, 2], [2, 1, 1], [1, 1, 2]]);
  assert.deepEqual(plans, original);
  assert.ok(orders.every(p => p.at(-1).kind === 'end_turn'));
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
  assert.equal(planOrderSignature([hit('a'), hit('bash')], state), planOrderSignature([hit('b'), hit('bash')], state));
  assert.notEqual(planOrderSignature([hit('a'), hit('bash')], state), planOrderSignature([hit('bash'), hit('b')], state));
  assert.notEqual(planOrderSignature([upgrade, hit('a')], state), planOrderSignature([upgrade, hit('b')], state));
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

test('a high-damage sequence survives low independent ratings when projected HP is no worse', () => {
  const entry = (value, score, damage, hp = 25) => ({ value, score, allocation: value,
    label: { energy_left: 0, continuation: { handoff: 'end', further_player_choices: false },
      conditional_preview: { known_effects_only: { hp_if_ending: hp, enemies: [{ hp_removed: damage }] },
        sequence_dependencies: { checkpoint: null } } } });
  const plans = [entry('defend', 1.9, 1), entry('taunt', 1.8, 1), entry('block', 1.7, 0),
    entry('strike_then_heavy', 1.3, 21), entry('unsafe_burst', 1.2, 40, 5)];
  const result = shortlistPlans(plans, plans.map(({ value, score }) => ({ value, score })));
  assert.ok(result.candidates.some(item => item.value === 'strike_then_heavy'));
  assert.ok(!result.candidates.some(item => item.value === 'unsafe_burst'));
  assert.equal(result.assessments.find(item => item.value === 'strike_then_heavy').reason,
    'largest_calculated_damage_at_no_worse_projected_hp');
});
