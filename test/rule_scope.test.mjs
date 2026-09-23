import test from 'node:test';
import assert from 'node:assert/strict';
import { completeCombat, fixtureCard, withContext } from './fixtures/context.mjs';
import { lookupRule } from '../src/rule_reference.mjs';
import { combatForecast } from '../src/combat_arithmetic.mjs';
import { describeTurnProjection } from '../src/turn_projection.mjs';
import { inspectSequence } from '../src/turn_sequence.mjs';
import { describeCombatEffects } from '../src/effect_lifecycle.mjs';
import { prepareModDecision } from '../src/mod_decision.mjs';
import { compileModelRequest } from '../src/context_compiler.mjs';

const rule = (category, id) => ({ id, description: lookupRule(category, id).description });
const play = (id, target) => ({ kind: 'play_card', card_instance_id: id, target });
const hit = play('STRIKE_IRONCLAD', 42);
const potion = { kind: 'use_potion', potion_id: 'STRENGTH_POTION', slot: 0 };
function state() {
  const s = completeCombat(); s.combat.player.energy = 4; s.combat.enemies[0].hp = 60;
  s.combat.hand[0].target_previews = [{ target_id: 42, damage: 6 }];
  return s;
}

test('verified pickup/reward effects and resolved draw-cost enchantments do not erase current arithmetic', () => {
  const s = state();
  s.combat.player.relics = ['POMANDER', 'NUTRITIOUS_SOUP', 'PRAYER_WHEEL'].map(id => rule('relics', id));
  const card = s.combat.hand[0]; card.cost = 2; card.details.enchantment = rule('enchantments', 'SLITHER');
  const original = structuredClone(s), result = describeTurnProjection(s, [hit]);
  assert.equal(result.known_effects_only.enemies[0].hp_removed, 6);
  assert.equal(result.known_effects_only.hp_if_ending, 28);
  assert.equal(inspectSequence(s, [hit]).energy_left, 2);
  assert.equal(result.calculation_coverage.reviewed_dependencies.length, 4);
  assert.deepEqual(s, original);
  assert.ok(compileModelRequest(prepareModDecision(withContext(s)).payload).bytes > 0);
  s.combat.hand.push(fixtureCard('SHRUG_IT_OFF', { index: 1, type: 'Skill', target_type: 'Self', block: 8,
    description: 'Gain 8 Block. Draw 1 card.' }));
  assert.equal(describeTurnProjection(s, [play('SHRUG_IT_OFF')]).known_effects_only.hp_if_ending, null);
  // Different descriptions on another card cannot be hidden by ID deduplication.
  s.combat.draw_pile[0].details.enchantment = { ...card.details.enchantment, description: 'When drawn, lose 3 HP.' };
  assert.equal(describeTurnProjection(s, [hit]).known_effects_only.hp_if_ending, null);
});

test('Entangled uses the native current cost and Tangled amount is not a duration countdown', () => {
  const s = state(), card = s.combat.hand[0];
  card.cost = 3; card.details.affliction = { ...rule('afflictions', 'ENTANGLED'), description: 'Costs an additional 1 Energy.' };
  s.combat.player.powers = [{ id: 'TANGLED_POWER', amount: 2, description: 'Attacks cost an additional 1 Energy for 2 turns.' }];
  assert.equal(inspectSequence(s, [hit]).energy_left, 1);
  assert.equal(describeTurnProjection(s, [hit]).known_effects_only.enemies[0].hp_removed, 6);
  const timing = describeCombatEffects(s.combat).effects.find(effect => effect.source_id === 'TANGLED_POWER');
  assert.equal(timing.current_amount, 2);
  assert.equal(timing.expires, 'owner_side_turn_end');
  assert.match(timing.timing_detail, /not a remaining-turn countdown/);
});

test('Permafrost only invalidates Block-dependent predictions for a prefix that can trigger it', () => {
  const s = state(); s.combat.player.relics = [{ ...rule('relics', 'PERMAFROST'), status: 'Normal' }];
  s.combat.hand.push(fixtureCard('INFLAME', { index: 1, type: 'Power', target_type: 'Self', description: 'Gain 2 Strength.' }));
  const attack = describeTurnProjection(s, [hit]);
  assert.equal(attack.known_effects_only.block, 0);
  assert.equal(attack.known_effects_only.hp_if_ending, 28);
  const power = describeTurnProjection(s, [play('INFLAME'), hit]);
  assert.equal(power.known_effects_only.block, null);
  assert.equal(power.known_effects_only.hp_if_ending, null);
  assert.equal(power.known_effects_only.enemies[0].hp_removed, 8);
  assert.equal(power.known_effects_only.incoming_attack, 12);
  assert.deepEqual(power.calculation_coverage.uncovered_effects[0].affected_outputs, ['player_block', 'player_hp']);
  s.combat.player.relics[0].description += ' Also gain Block after Attacks.';
  assert.equal(describeTurnProjection(s, [hit]).known_effects_only.enemies[0].hp_removed, null);
});

test('enemy Territorial is applied after its displayed attack, not on top of the observed damage', () => {
  const s = state(), power = { id: 'TERRITORIAL_POWER', amount: 1, description: "At the end of Byrdonis's turn, it gains 1 Strength." };
  s.combat.enemies[0].powers = [power, { id: 'STRENGTH_POWER', amount: 3 }];
  const p = describeTurnProjection(s, [hit]);
  assert.equal(p.known_effects_only.incoming_attack, 12);
  assert.equal(p.known_effects_only.hp_if_ending, 28);
  s.combat.player.powers = [power];
  assert.equal(describeTurnProjection(s, [hit]).known_effects_only.hp_if_ending, null);
});

test('Expect a Fight updates only preceding Strength deltas from its actual native Block preview', () => {
  const s = state(); s.combat.player.powers = [{ id: 'STRENGTH_POWER', amount: 2 }];
  s.combat.player.potions = [{ id: 'STRENGTH_POTION', slot: 0, description: 'Gain 2 Strength.' }];
  const card = fixtureCard('EXPECT_A_FIGHT', { index: 1, type: 'Skill', target_type: 'Self', cost: 3,
    description: 'Gain 25 Block. Gains 5 additional Block for each Strength you have.', block: 25 });
  s.combat.hand.push(card); const defend = play('EXPECT_A_FIGHT'), original = structuredClone(s);
  assert.equal(combatForecast(s.combat, card).block_after_card, 25);
  assert.equal(describeTurnProjection(s, [potion, defend]).known_effects_only.block, 35);
  assert.equal(describeTurnProjection(s, [defend, potion]).known_effects_only.block, 25);
  assert.deepEqual(s, original);
  s.combat.player.powers[0].amount = -1; card.block = 15;
  card.description = 'Gain 15 Block. Gains 5 additional Block for each Strength you have.';
  assert.equal(describeTurnProjection(s, [potion, defend]).known_effects_only.block, 20);
  card.is_upgraded = true; card.block = 16;
  card.description = 'Gain 16 Block. Gains 8 additional Block for each Strength you have.';
  assert.equal(describeTurnProjection(s, [potion, defend]).known_effects_only.block, 24);
});

test('Expect a Fight preserves Frail rounding bounds and does not invent a missing native Block preview', () => {
  const s = state(); s.combat.player.powers = [{ id: 'STRENGTH_POWER', amount: 2 }, { id: 'FRAIL_POWER', amount: 1 }];
  s.combat.player.potions = [{ id: 'STRENGTH_POTION', slot: 0, description: 'Gain 2 Strength.' }];
  const card = fixtureCard('EXPECT_A_FIGHT', { index: 1, type: 'Skill', target_type: 'Self', cost: 3,
    description: 'Gain 18 Block. Gains 5 additional Block for each Strength you have.', block: 18 });
  s.combat.hand.push(card); const defend = play('EXPECT_A_FIGHT');
  const seq = inspectSequence(s, [potion, defend]);
  assert.deepEqual(seq.analysis.steps[1].block_per_gain, { min: 25, max: 26 });
  assert.equal(describeTurnProjection(s, [potion, defend]).known_effects_only.block, null);
  delete card.block;
  assert.equal(describeTurnProjection(s, [defend]).known_effects_only.block, null);
  assert.equal(combatForecast(s.combat, card).block_after_card, null);
});

test('reviewed calculated attacks retain native target damage and compound Block while reactions remain unknown', () => {
  const s = state();
  s.combat.hand = [fixtureCard('PERFECTED_STRIKE', { index: 0, target_type: 'AnyEnemy', damage: 22,
    description: 'Deal 22 damage. Deals 2 additional damage for ALL your cards containing “Strike”.', target_previews: [{ target_id: 42, damage: 22 }] }),
  fixtureCard('IRON_WAVE', { index: 1, target_type: 'AnyEnemy', block: 5,
    description: 'Gain 5 Block. Deal 5 damage.', target_previews: [{ target_id: 42, damage: 5 }] })];
  const p = describeTurnProjection(s, [play('PERFECTED_STRIKE', 42), play('IRON_WAVE', 42)]);
  assert.equal(p.known_effects_only.enemies[0].hp_removed, 27);
  assert.equal(p.known_effects_only.block, 5);
  assert.equal(p.known_effects_only.hp_if_ending, 33);
  s.combat.enemies[0].powers.push({ id: 'THORNS_POWER', amount: 3, description: 'Whenever you receive Attack damage, deal 3 damage back.' });
  assert.equal(describeTurnProjection(s, [play('IRON_WAVE', 42)]).known_effects_only.hp_if_ending, null);
});
