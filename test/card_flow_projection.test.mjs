import test from 'node:test';
import assert from 'node:assert/strict';
import { attackCardFlowEffects, describeCardFlow } from '../src/card_flow_projection.mjs';
import { combatForecast, attackHitPreview } from '../src/combat_arithmetic.mjs';
import { describeTurnProjection } from '../src/turn_projection.mjs';
import { prepareModDecision } from '../src/mod_decision.mjs';
import { compileModelRequest } from '../src/context_compiler.mjs';
import { completeCombat } from './fixtures/context.mjs';
import { decisionHistoryPolicy, relevantCombatEvent } from '../src/history_scope.mjs';

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
