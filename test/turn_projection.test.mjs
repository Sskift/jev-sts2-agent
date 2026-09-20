import test from 'node:test';
import assert from 'node:assert/strict';
import { projectTurnPrefix, describeTurnProjection } from '../src/turn_projection.mjs';
import { completeCombat, fixtureCard } from './fixtures/context.mjs';
import { combatForecast } from '../src/combat_arithmetic.mjs';

function state() {
  const s = completeCombat(); s.combat.player.energy = 3;
  s.combat.enemies[0].hp = 40;
  s.combat.hand = [fixtureCard('STRIKE_IRONCLAD', { index: 0, target_type: 'AnyEnemy', can_play: true, target_previews: [{ target_id: 42, damage: 6 }] }),
    fixtureCard('DEFEND_IRONCLAD', { index: 1, type: 'Skill', description: 'Gain 5 Block.', target_type: 'Self', block: 5 })];
  return s;
}
const strike = { kind: 'play_card', name: 'Strike', card_instance_id: 'STRIKE_IRONCLAD', target: 42 };
const defend = { kind: 'play_card', name: 'Defend', card_instance_id: 'DEFEND_IRONCLAD' };

test('uncomputed revival invalidates post-depletion enemy and survival estimates at both forecast boundaries', () => {
  const s = state(); s.combat.enemies[0].hp = 6;
  s.combat.enemies[0].powers = [{ id: 'ADAPTABLE_POWER', amount: 1, description: 'When this would be defeated, it revives stronger.' }];
  const single = combatForecast(s.combat, s.combat.hand[0], s.combat.enemies[0]);
  assert.equal(single.hp_remaining_if_end_turn, null); assert.equal(single.fatal_if_end_turn, null);
  const whole = describeTurnProjection(s, [strike]);
  assert.equal(whole.known_effects_only.hp_if_ending, null); assert.equal(whole.known_effects_only.incoming_attack, null);
  assert.equal(whole.known_effects_only.enemies[0].hp, null);
  assert.equal(whole.encounter_progress[0].permanent_removal_established, null);
  assert.equal(whole.uncomputed_depletion_effects[0].source_id, 'ADAPTABLE_POWER');
  assert.equal(s.combat.enemies[0].hp, 6);
});

test('uncomputed potion benefits stay distinct from equal numeric baselines', () => {
  const s = state();
  const plain = describeTurnProjection(s, [strike]);
  const withPotion = describeTurnProjection(s, [{ kind: 'use_potion', name: 'Strength Potion' }, strike]);
  assert.deepEqual(withPotion.known_effects_only, plain.known_effects_only);
  assert.equal(withPotion.calculation_status, 'incomplete');
  assert.equal(plain.calculation_status, 'preview_arithmetic');
  assert.equal(withPotion.fully_simulated, false);
  assert.match(withPotion.omitted_effects.join(' '), /Strength Potion/);
  assert.equal(withPotion.hp_if_ending, undefined, 'A partial baseline is not a top-level outcome');
});

test('a current lethal countdown cannot prove that an uncomputed sequence remains lethal', () => {
  const s = state();
  s.combat.enemies[0].powers = [{ id: 'SANDPIT_POWER', amount: 1 }];
  assert.equal(describeTurnProjection(s, [strike]).known_effects_only.hp_if_ending, 0);
  s.combat.hand.push(fixtureCard('RESPONSE_FIXTURE', { index: 2, type: 'Skill', description: 'Increase the loss countdown by 1.' }));
  const sequence = [{ kind: 'play_card', name: 'Response', card_instance_id: 'RESPONSE_FIXTURE' }, strike];
  const result = describeTurnProjection(s, sequence);
  assert.equal(result.known_effects_only.hp_if_ending, null);
  assert.equal(result.known_effects_only.hp_loss_if_ending, null);
  assert.ok(result.omitted_effects.length > 0);
  assert.equal(result.loss_deadlines[0].counter_after_declared_actions, 1, 'An unknown response must not invent a counter increase');
  assert.equal(s.combat.enemies[0].powers[0].amount, 1, 'Observed counters are unchanged');
});

test('conditional sequence sums never mutate observations or trigger Orichalcum between cards', () => {
  const s = state(); s.combat.player.relics = [{ id: 'ORICHALCUM' }];
  const original = structuredClone(s), projection = projectTurnPrefix(s, [strike, defend]);
  assert.equal(projection.block, 5);
  assert.equal(projection.hp_if_ending_after_prefix, 33);
  assert.equal(projection.remaining_enemies[0].hp, 34);
  assert.deepEqual(s, original);
  const noBlock = projectTurnPrefix(s, [strike]);
  assert.equal(noBlock.hp_if_ending_after_prefix, 34, 'Orichalcum applies once at turn end');
  assert.equal(noBlock.block, 0);
  assert.equal(noBlock.block_including_end_turn_gains, 6);
});

test('Plating is applied once after the whole sequence and never becomes intermediate card Block', () => {
  const s = state(); s.combat.player.powers = [{ id: 'PLATING_POWER', amount: 7 }];
  const original = structuredClone(s);
  const projection = projectTurnPrefix(s, [strike, defend]);
  assert.equal(projection.block, 5);
  assert.equal(projection.block_including_end_turn_gains, 12);
  assert.equal(projection.hp_if_ending_after_prefix, s.combat.player.hp);
  assert.equal(projection.end_turn_block_gains.length, 1);
  assert.deepEqual(s, original);
});

test('Rage preparation precedes attack-triggered Block and unknown potion/draw effects remain explicit', () => {
  const s = state();
  s.combat.hand.push(fixtureCard('RAGE', { index: 2, cost: 0, type: 'Skill', description: 'Whenever you play an Attack this turn, gain 3 Block.', rage_block_per_attack: 3 }));
  const rage = { kind: 'play_card', name: 'Rage', card_instance_id: 'RAGE' };
  assert.equal(projectTurnPrefix(s, [rage, strike]).block, 3);
  assert.equal(projectTurnPrefix(s, [strike, rage]).block, 0);
  assert.match(projectTurnPrefix(s, [{ kind: 'use_potion', name: 'Swift Potion' }]).unresolved_effects.join(' '), /not simulated/);
});
