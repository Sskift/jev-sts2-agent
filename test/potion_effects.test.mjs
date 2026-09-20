import test from 'node:test';
import assert from 'node:assert/strict';
import { potionEffectFacts } from '../src/potion_effects.mjs';
import { prepareModDecision } from '../src/mod_decision.mjs';
import { expandRecordTables, validateDecisionPacket } from '../src/decision_context.mjs';
import { completeCombat } from './fixtures/context.mjs';

test('live potion amounts and expiry rules do not imply retroactive or immediate Block', () => {
  const live = potionEffectFacts({ id: 'DEXTERITY_POTION', slot: 0, description: 'Gain 4 Dexterity.' });
  assert.equal(live.amount, 4, 'Do not replace an enhanced live amount with the base value 2');
  assert.equal(live.duration, 'combat');
  assert.equal(live.affected_quantity, 'powered_block_gain');
  assert.equal(live.affects_prior_actions, false);
  assert.equal(live.direct_block, 0);
  assert.equal(live.unpowered_effects_excluded, true);
  const temporary = potionEffectFacts({ id: 'SPEED_POTION', slot: 0, description: 'Gain 10 Dexterity. At the end of your turn, lose 10 Dexterity.' });
  assert.equal(temporary.amount, 10);
  assert.equal(temporary.expires_at, 'owner_turn_end');
  assert.equal(potionEffectFacts({ id: 'STRENGTH_POTION', slot: 0, description: 'Unknown rules.' }), null);
  assert.equal(potionEffectFacts({ id: 'OTHER_POTION', slot: 0, description: 'Gain 2 Strength.' }), null);
});

test('effect facts reach state and offered use actions, and inconsistent live quantities are rejected', () => {
  const state = completeCombat();
  state.combat.player.potions = [{ id: 'STRENGTH_POTION', name: 'Strength Potion', slot: 2,
    description: 'Gain 4 Strength.', can_use: true, valid_target_ids: [0], target_type: 'AnyPlayer' }];
  state.decision_context.player = structuredClone(state.combat.player);
  const prepared = prepareModDecision(state), packet = expandRecordTables(prepared.payload.state);
  assert.equal(packet.resources.potion_effects[0].amount, 4);
  const option = Object.values(prepared.payload.questions.next_action.criteria).find(c => c.command === 'use_potion');
  assert.equal(option.effect_facts.duration, 'combat');
  assert.equal(option.effect_facts.application_unit, 'each_damage_instance');
  packet.resources.potion_effects[0].amount = 2;
  assert.throws(() => validateDecisionPacket(packet), /Potion effect facts contradict/);
});
