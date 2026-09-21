import test from 'node:test';
import assert from 'node:assert/strict';
import { attackCardFlowEffects, describeCardFlow, describeContinuation, compareContinuationResources } from '../src/card_flow_projection.mjs';
import { combatForecast, attackHitPreview } from '../src/combat_arithmetic.mjs';
import { describeTurnProjection } from '../src/turn_projection.mjs';
import { prepareModDecision } from '../src/mod_decision.mjs';
import { compileModelRequest } from '../src/context_compiler.mjs';
import { completeCombat, fixtureCard } from './fixtures/context.mjs';
import { decisionHistoryPolicy, relevantCombatEvent } from '../src/history_scope.mjs';

import { inspectSequence } from '../src/turn_sequence.mjs';

function state() {
  const s = completeCombat();
  s.combat.enemies[0].hp = 100;
  s.combat.enemies[0].powers = [{ id: 'PERSONAL_HIVE_POWER', amount: 2, description: 'Whenever this enemy is hit by an Attack, add 2 Dazed into your Draw Pile.' }];
  Object.assign(s.combat.hand[0], { id: 'SWORD_BOOMERANG', type: 'Attack', target_type: 'RandomEnemy', attack_preview: { hits: 3 } });
  return s;
}

test('random-target multihit attacks expose per-hit pile costs without inventing insertion order', () => {
  const s = state(), original = structuredClone(s), card = s.combat.hand[0];
  const effects = attackCardFlowEffects(s.combat, card, null, 3);
  assert.deepEqual(effects[0].added_if_all_preview_hits_resolve, { min: 6, max: 6 });
  assert.equal(effects[0].may_displace_known_top, true);
  const result = combatForecast(s.combat, card);
  assert.deepEqual(result.card_flow.generated_into_draw_pile, { min: 6, max: 6 });
  assert.equal(result.uncomputed_reactions, undefined, 'Card pollution is distinct from direct HP retaliation');
  const projected = describeTurnProjection(s, [{ kind: 'play_card', name: card.name, card_instance_id: card.details.instance_id }]);
  assert.deepEqual(projected.card_flow.generated_into_draw_pile, { min: 6, max: 6 });
  assert.equal(projected.card_flow.effects[0].sequence, 0);
  assert.equal(projected.calculation_status, 'incomplete');
  assert.deepEqual(s, original);
  const prepared = prepareModDecision(s);
  prepared.payload.state.turn_planning = { phase_scope: 'card flow fixture', energy_reservation: {
    observed_energy: 2, remaining_after_printed_costs: 2, scope: 'fixture', is_observed: false, includes_future_energy_gains: false, steps: []
  }, conditional_projection: projected };
  assert.doesNotThrow(() => compileModelRequest(prepared.payload));
});

test('mixed random targets give a range; all-enemy, zero-hit, unknown-hit and non-attack cases stay distinct', () => {
  const s = state(), card = s.combat.hand[0];
  s.combat.enemies.push({ combat_id: 43, hp: 10, is_alive: true, powers: [] });
  let effects = attackCardFlowEffects(s.combat, card, null, 3);
  assert.deepEqual(describeCardFlow(s.combat, effects).generated_into_draw_pile, { min: 0, max: 6 });
  effects = attackCardFlowEffects(s.combat, { ...card, target_type: 'AllEnemies' }, null, 3);
  assert.deepEqual(describeCardFlow(s.combat, effects).generated_into_draw_pile, { min: 6, max: 6 });
  assert.deepEqual(attackCardFlowEffects(s.combat, card, null, 0), []);
  assert.deepEqual(attackCardFlowEffects(s.combat, { ...card, type: 'Skill' }, null, 3), []);
  assert.deepEqual(attackCardFlowEffects(s.combat, { ...card, id: 'OMNISLICE' }, null, 3), [], 'Hive has no Thorns-style Omnislice exception');
  const unknown = describeCardFlow(s.combat, attackCardFlowEffects(s.combat, card, null, null));
  assert.deepEqual(unknown.generated_into_draw_pile, { min: null, max: null });
});

test('legacy random-hit DTO uses an unconditional live count and does not invent conditional repetitions', () => {
  const s = state(), card = s.combat.hand[0];
  delete card.attack_preview;
  card.description = 'Deal 3 damage to a random enemy 3 times.';
  const flow = combatForecast(s.combat, card).card_flow;
  assert.deepEqual(flow.generated_into_draw_pile, { min: 6, max: 6 });
  assert.equal(flow.effects[0].preview_hits_source, 'resolved_live_first_sentence');
  assert.deepEqual(attackHitPreview({ ...card, description: 'Deal 10 damage. If the enemy is Vulnerable, hits twice.' }), { hits: null, source: 'unresolved_repetition_rule' });
  assert.equal(attackHitPreview({ ...card, cost: -1 }).hits, null);
  assert.deepEqual(attackHitPreview({ ...card, attack_preview: { hits: 4 } }), { hits: 4, source: 'native_preview' });
});

test('earlier card generation survives only a relevant unresolved ordering window', () => {
  const s = completeCombat(); s.combat.turn_number = 6;
  const archive = { run_id: s.decision_context.run_id, actions: [
    { ok: true, floor: 1, combat_id: s.decision_context.combat_id, round: 3, request: { cmd: 'play_card', id: 'HEADBUTT' },
      played_card_at_request: { id: 'HEADBUTT', description: 'Put a card from your Discard Pile on top of your Draw Pile.' } },
    { ok: true, floor: 1, combat_id: s.decision_context.combat_id, round: 3, request: { cmd: 'grid_select_card', card_ids: ['DEFEND_IRONCLAD'] } }
  ] };
  const generated = { round: 4, side: 'Player', type: 'CardGeneratedEntry' };
  let policy = decisionHistoryPolicy(s, archive);
  assert.equal(relevantCombatEvent(generated, policy), true);
  assert.equal(relevantCombatEvent({ ...generated, type: 'BlockGainedEntry' }, policy), false);
  s.combat.draw_pile = [];
  policy = decisionHistoryPolicy(s, archive);
  assert.equal(relevantCombatEvent(generated, policy), false);
});

const play = id => ({ kind: 'play_card', card_instance_id: id, target: id === 'STRIKE_IRONCLAD' ? 42 : undefined });
const transformState = () => {
  const state = completeCombat();
  state.combat.hand.push(
    fixtureCard('PRIMAL_FORCE', { index: 1, name: 'Primal Force', type: 'Skill', cost: 0, description: 'Transform all Attacks in your Hand into Giant Rock.' }),
    fixtureCard('DEFEND_IRONCLAD', { index: 2, name: 'Defend', type: 'Skill', description: 'Gain 5 Block.' })
  );
  return state;
};
const continuation = (state, ids) => describeContinuation(state.combat, inspectSequence(state, ids.map(play)));

test('ordered transformation recipients exclude earlier plays and leave other card types intact', () => {
  const state = transformState(), before = structuredClone(state);
  const early = continuation(state, ['PRIMAL_FORCE']);
  assert.deepEqual(early.hand_transformation.affected_hand_indices, [0]);
  assert.deepEqual(early.hand_transformation.unaffected_hand_indices, [2]);
  assert.equal(early.hand_transformation.copies_within_remaining_energy_at_base_cost, 1);
  assert.equal(early.hand_transformation.replacement_per_affected_card.rules, 'Deal 20 damage.');
  const empty = continuation(state, ['STRIKE_IRONCLAD', 'PRIMAL_FORCE']);
  assert.equal(empty.hand_transformation.affected_count, 0);
  assert.deepEqual(empty.hand_transformation.affected_hand_indices, []);
  assert.equal(empty.hand_transformation.copies_within_remaining_energy_at_base_cost, 0);
  assert.equal(empty.hand_transformation.after_sequence, 1);
  state.combat.player.energy = 0;
  assert.equal(continuation(state, ['PRIMAL_FORCE']).hand_transformation.copies_within_remaining_energy_at_base_cost, 0);
  state.combat.player.energy = before.combat.player.energy;
  assert.deepEqual(state, before, 'Describing replacement must not insert future cards into native state');
});

test('replacement upgrade follows the ordered source, not the Attack, and never crosses an unresolved draw', () => {
  const state = transformState();
  state.combat.hand[0].is_upgraded = true;
  state.combat.hand[0].keywords = ['Eternal'];
  assert.equal(continuation(state, ['PRIMAL_FORCE']).hand_transformation.affected_count, 1);
  assert.equal(continuation(state, ['PRIMAL_FORCE']).hand_transformation.replacement_per_affected_card.is_upgraded, false);
  state.combat.hand[1].upgrade_preview = { description: 'Transform all Attacks in your Hand into Giant Rock+.' };
  state.combat.hand.push(fixtureCard('ARMAMENTS', { index: 3, name: 'Armaments+', type: 'Skill', description: 'Gain 5 Block. Upgrade ALL cards in your Hand.' }));
  const upgraded = continuation(state, ['ARMAMENTS', 'PRIMAL_FORCE']).hand_transformation.replacement_per_affected_card;
  assert.equal(upgraded.is_upgraded, true);
  assert.equal(upgraded.rules, 'Deal 24 damage.');
  assert.equal(upgraded.base_energy_cost, 1);
  state.combat.hand.push(fixtureCard('DRAW', { index: 4, type: 'Skill', cost: 0, description: 'Draw 1 card.' }));
  const blocked = inspectSequence(state, [play('DRAW'), play('PRIMAL_FORCE')]);
  assert.equal(blocked.violations.length, 1);
  assert.equal(describeContinuation(state.combat, blocked).hand_transformation, undefined);
});

test('comparison does not reserve a transformed Attack as its old follow-up form', () => {
  const state = transformState();
  const early = { energy_left: 2, ordered_sequence: [{ hand_index: 1 }], continuation: continuation(state, ['PRIMAL_FORCE']) };
  const late = { energy_left: 0, ordered_sequence: [{ hand_index: 0 }, { hand_index: 2 }, { hand_index: 1 }],
    continuation: continuation(state, ['STRIKE_IRONCLAD', 'DEFEND_IRONCLAD', 'PRIMAL_FORCE']) };
  const result = compareContinuationResources(early, late).after_plan_a_observation;
  assert.deepEqual(result.other_plan_cards_replaced_by_checkpoint.map(card => card.hand_index), [0]);
  assert.deepEqual(result.other_plan_cards_still_in_hand_before_unresolved_effects.map(card => card.hand_index), [2]);
  assert.equal(result.total_observed_cost, 1);
  assert.equal(result.replacement_rule_ref, 'cards/GIANT_ROCK');
  assert.deepEqual(compareContinuationResources(late, early).after_plan_b_observation, result);
});
