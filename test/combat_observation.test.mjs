import test from 'node:test';
import assert from 'node:assert/strict';
import { completeCombat } from './fixtures/context.mjs';
import { buildDecisionContext, expandRecordTables, compactDecisionRequest, presentCurrentRecords } from '../src/decision_context.mjs';
import { buildModCandidates } from '../src/mod_decision.mjs';
import { compileModelRequest, restoreCanonicalContext } from '../src/context_compiler.mjs';
import { verifyNativeCombatObservation, currentCombatArithmetic, intentDamage } from '../src/combat_observation.mjs';
import { combatForecast } from '../src/combat_arithmetic.mjs';
import { describeTurnProjection } from '../src/turn_projection.mjs';

test('full native combat records survive the packet and final model compiler', () => {
  const state = completeCombat();
  state.combat.hand[0].target_previews = [{ target_id: 42, damage: 6, description: 'Deal 6 damage.', future_native_field: 17 }];
  state.combat.enemies[0].future_native_field = { phase: 'visible', count: 3 };
  state.combat.player.powers = [{ id: 'UNFAMILIAR_POWER', amount: 0, description: 'This effect is active even with zero stacks.' }];
  state.decision_context.player = structuredClone(state.combat.player);
  const original = structuredClone(state);
  const packet = buildDecisionContext(state, { candidates: buildModCandidates(state) });
  assert.doesNotThrow(() => verifyNativeCombatObservation(state, packet));
  const compiled = compileModelRequest({ state: packet, questions: { next_action: { type: 'choice', instructions: 'Choose.', criteria: { end_turn: 'End turn' } } } }).payload;
  assert.deepEqual(expandRecordTables(restoreCanonicalContext(compiled.state)), expandRecordTables(packet));
  assert.deepEqual(compiled.state.observation.combat.hand, packet.combat.hand);
  assert.equal(packet.combat.effect_timing.effects.find(effect => effect.source_id === 'UNFAMILIAR_POWER').current_amount, 0);
  assert.deepEqual(state, original);
  for (const change of [p => { p.player.hp--; }, p => { p.combat.hand[0].target_previews[0].damage++; },
    p => { p.combat.enemies[0].powers = [{ id: 'INVENTED' }]; }, p => { p.combat.draw_pile.cards[0].count++; }]) {
    const damaged = structuredClone(packet); change(damaged);
    assert.throws(() => verifyNativeCombatObservation(state, damaged), /Native combat fact/);
  }
});

test('visible Attack arithmetic preserves zero and unknown independently from future survival', () => {
  const state = completeCombat(), enemy = state.combat.enemies[0];
  enemy.intents = [{ type: 'Attack', damage: 10, hits: 0 }];
  assert.equal(intentDamage(enemy), 0);
  delete enemy.intents[0].hits;
  assert.equal(currentCombatArithmetic(state.combat).incoming_attack_damage, null);
  assert.equal(combatForecast(state.combat).hp_remaining_if_end_turn, null);
  assert.equal('fatal_if_end_turn_from_visible_attacks' in currentCombatArithmetic(state.combat), false);
  enemy.intents[0].hits = 1; delete enemy.intents[0].damage;
  assert.equal(intentDamage(enemy), null);
  enemy.intents = [{ type: 'Buff', damage: null, hits: null }];
  assert.equal(intentDamage(enemy), 0, 'No displayed Attack is different from an Attack with a missing preview');
  assert.equal(combatForecast(state.combat).hp_remaining_if_end_turn, null, 'The unknown buff action can still affect the response');
});

test('card attachments and automatic actors cannot disappear behind a plain card description', () => {
  const state = completeCombat(), card = state.combat.hand[0];
  card.target_previews = [{ target_id: 42, damage: 6 }];
  card.details.enchantment = { id: 'FUTURE_ENCHANTMENT', description: 'After playing this, lose HP.' };
  state.combat.player.orbs = [{ id: 'FUTURE_ORB', description: 'At end of turn, damage a random enemy.' }];
  const forecast = combatForecast(state.combat, card, state.combat.enemies[0]);
  assert.equal(forecast.hp_remaining_if_end_turn, null);
  assert.equal(forecast.attack_hp_loss, null);
  assert.deepEqual(forecast.calculation_coverage.uncovered_effects.map(effect => effect.source_id).sort(), ['FUTURE_ENCHANTMENT', 'FUTURE_ORB']);
});

test('an unrecognized reactive power cannot produce precise counterfactual outcomes', () => {
  const state = completeCombat(), card = state.combat.hand[0];
  card.target_previews = [{ target_id: 42, damage: 6 }];
  state.combat.enemies[0].powers = [{ id: 'FUTURE_REACTION_POWER', amount: 0,
    description: 'When hit, change phase, gain Block, and replace the next attack.' }];
  const single = combatForecast(state.combat, card, state.combat.enemies[0]);
  assert.equal(single.hp_remaining_if_end_turn, null);
  assert.equal(single.attack_hp_loss, null);
  assert.equal(single.calculation_coverage.uncovered_effects[0].source_id, 'FUTURE_REACTION_POWER');
  const plan = describeTurnProjection(state, [{ kind: 'play_card', card_instance_id: card.details.instance_id, target: 42 }]);
  assert.equal(plan.known_effects_only.enemies[0].hp, null);
  assert.equal(plan.known_effects_only.hp_if_ending, null);
  assert.equal(plan.known_effects_only.incoming_attack, null);
  assert.equal(state.combat.enemies[0].hp, 12);
});

test('Happy Flower normalization reports both the native display and gameplay value', () => {
  const state = completeCombat();
  state.combat.player.relics = [{ id: 'HAPPY_FLOWER', counter: 3, description: 'Every 3 turns, gain 1 Energy.' }];
  state.decision_context.player = structuredClone(state.combat.player);
  const packet = buildDecisionContext(state, { candidates: buildModCandidates(state) });
  assert.equal(packet.player.relics[0].counter, 0);
  assert.equal(packet.information.observation_integrity.normalizations[0].native_display_value, 3);
});

test('the native receipt rejects later numeric and text changes at the real compiler boundary', () => {
  const state = completeCombat();
  state.combat.hand[0].details.instance_id = 'a'.repeat(32);
  const packet = buildDecisionContext(state, { candidates: buildModCandidates(state) });
  const payload = { state: packet, questions: { next_action: { type: 'choice', instructions: 'Choose.', criteria: { end_turn: 'End turn' } } } };
  assert.equal(packet.combat.hand[0].details.instance_id, 'i1');
  const packed = compactDecisionRequest(payload);
  assert.doesNotThrow(() => compileModelRequest(packed));
  assert.doesNotThrow(() => compileModelRequest(presentCurrentRecords(packed, 200000).payload));
  const broken = structuredClone(payload);
  broken.state.combat.hand[0].description = 'Deal 999 damage.';
  assert.throws(() => compileModelRequest(broken), /Native combat facts changed/);
  const changedNumber = structuredClone(payload);
  changedNumber.state.player.hp--;
  assert.throws(() => compileModelRequest(changedNumber), /Native combat facts changed/);
  const missingReceipt = structuredClone(payload);
  delete missingReceipt.state.information.observation_integrity;
  assert.throws(() => compileModelRequest(missingReceipt), /Missing verified native combat facts/);
});
