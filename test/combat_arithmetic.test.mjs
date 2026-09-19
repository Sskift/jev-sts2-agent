import test from 'node:test';
import assert from 'node:assert/strict';
import { combatForecast, firstHitHpLoss } from '../src/combat_arithmetic.mjs';

test('visible damage caps prevent a false lethal and defensive arithmetic exposes survival', () => {
  const enemy = { combat_id: 1, hp: 15, block: 0, is_alive: true, powers: [{ id: 'SLIPPERY_POWER', amount: 1, name: 'Slippery' }], intents: [{ damage: 2, hits: 3 }] };
  const combat = { player: { hp: 5, block: 0, energy: 2 }, enemies: [enemy, { combat_id: 2, hp: 16, block: 0, is_alive: true, intents: [{ damage: 3, hits: 1 }] }] };
  const bash = { cost: 2, target_previews: [{ target_id: 1, damage: 18 }] };
  assert.equal(firstHitHpLoss(bash, enemy).hp_loss, 1);
  assert.equal(combatForecast(combat, bash, enemy).fatal_if_end_turn, true);
  const defend = combatForecast(combat, { cost: 1, block: 8 });
  assert.equal(defend.hp_remaining_if_end_turn, 4);
  assert.equal(defend.fatal_if_end_turn, false);
  assert.equal(defend.energy_after_card, 1);
  enemy.powers = [];
  assert.equal(combatForecast(combat, bash, enemy).hp_remaining_if_end_turn, 2);
});

test('an inexpensive first hit leaves enough energy to finish a target after consuming Slippery', () => {
  const enemy = { combat_id: 1, hp: 16, block: 0, is_alive: true, powers: [{ id: 'SLIPPERY_POWER', amount: 1 }], intents: [{ damage: 8 }] };
  const strike = { index: 0, cost: 1, can_play: true, target_previews: [{ target_id: 1, damage: 9 }] };
  const bigAttack = { index: 1, cost: 2, can_play: true, target_previews: [{ target_id: 1, damage: 30 }] };
  const combat = { player: { hp: 10, block: 0, energy: 3 }, hand: [strike, bigAttack], enemies: [enemy] };
  assert.equal(combatForecast(combat, strike, enemy).followup_attacks.enough_to_deplete_target, true);
  assert.equal(combatForecast(combat, bigAttack, enemy).followup_attacks.enough_to_deplete_target, false);
});

test('Orichalcum and delayed Rage block are not mistaken for immediate block gains', () => {
  const combat = { player: { hp: 10, energy: 3, block: 0, relics: [{ id: 'ORICHALCUM' }] }, hand: [], enemies: [{ is_alive: true, hp: 20, intents: [{ damage: 6 }] }] };
  assert.equal(combatForecast(combat).hp_loss_if_end_turn, 0);
  assert.equal(combatForecast(combat, { cost: 1, block: 5 }).hp_loss_if_end_turn, 1);
  assert.equal(combatForecast(combat, { id: 'RAGE', cost: 0, block: 3 }).block_after_card, 6);
});

test('visible Sandpit instant death overrides safe-looking HP and Block arithmetic', () => {
  const boss = { combat_id: 1, hp: 143, block: 0, is_alive: true, intents: [{ damage: 10, hits: 2 }], powers: [{ id: 'SANDPIT_POWER', amount: 1 }] };
  const combat = { player: { hp: 45, block: 10, energy: 1 }, hand: [], enemies: [boss] };
  assert.equal(combatForecast(combat).instant_death_if_end_turn, true);
  assert.equal(combatForecast(combat).hp_loss_if_end_turn, 45);
  assert.equal(combatForecast(combat, { cost: 1, block: 99 }).hp_remaining_if_end_turn, 0);
  const escaped = combatForecast(combat, { id: 'FRANTIC_ESCAPE', cost: 1 });
  assert.equal(escaped.fatal_if_end_turn, false);
  assert.equal(escaped.death_timers[0].enemy_turns_remaining_after_card, 2);
  const kill = combatForecast(combat, { cost: 1, target_previews: [{ target_id: 1, damage: 143 }] }, boss);
  assert.equal(kill.fatal_if_end_turn, false, 'Killing the countdown owner ends this threat');
  boss.powers[0].amount = 2;
  assert.equal(combatForecast(combat).instant_death_if_end_turn, false);
});

test('Second Wind counts other non-attacks and exposes exhausted setup cards', () => {
  const wind = { id: 'SECOND_WIND', index: 1, type: 'Skill', cost: 1, block: 5 };
  const combat = { player: { hp: 9, block: 6, energy: 2 }, enemies: [{ is_alive: true, hp: 124, intents: [{ damage: 24 }] }], hand: [
    { id: 'PERFECTED_STRIKE', index: 0, type: 'Attack' }, wind,
    { id: 'DEFEND_IRONCLAD', index: 2, type: 'Skill' }, { id: 'DEFEND_IRONCLAD', index: 3, type: 'Skill' }
  ] };
  const forecast = combatForecast(combat, wind);
  assert.equal(forecast.hp_remaining_if_end_turn, 1, 'The recorded boss position is survivable with two exhausted Defends');
  assert.equal(forecast.immediate_block_gain, 10);
  combat.hand = [wind, { id: 'INFLAME', index: 0, type: 'Power' }];
  assert.deepEqual(combatForecast(combat, wind).exhausted_hand_cards, [{ index: 0, id: 'INFLAME', type: 'Power' }]);
  combat.hand = [wind, { index: 0, type: 'Attack' }];
  assert.equal(combatForecast(combat, wind).immediate_block_gain, 0, 'The played card is not itself exhausted');
});

test('an all-enemy attack uses each target preview and preserves surviving or unknown threats', () => {
  const enemies = [
    { combat_id: 1, hp: 6, block: 0, is_alive: true, intents: [{ damage: 10 }] },
    { combat_id: 2, hp: 6, block: 3, is_alive: true, intents: [{ damage: 7 }] },
    { combat_id: 3, hp: 6, block: 0, is_alive: true, intents: [{ damage: 4 }], powers: [{ id: 'SLIPPERY_POWER', amount: 1 }] },
    { combat_id: 4, hp: 6, block: 0, is_alive: true, intents: [{ damage: 2 }] }
  ];
  const combat = { player: { hp: 20, energy: 2, block: 0 }, hand: [], enemies };
  const area = { cost: 1, target_type: 'AllEnemies', target_previews: [1, 2, 3].map(target_id => ({ target_id, damage: 8 })) };
  const estimate = combatForecast(combat, area);
  assert.equal(estimate.hp_remaining_if_end_turn, 7, 'Only the first enemy loses all HP; the other three still threaten damage');
  assert.deepEqual(estimate.first_hit_hp_loss_by_target.map(p => p.hp_loss), [8, 5, 1, null]);
  assert.deepEqual(estimate.first_hit_hp_loss_by_target.map(p => p.hp_depleted), [true, false, false, false]);
  assert.equal(combatForecast(combat, { ...area, target_type: 'RandomEnemy' }).hp_remaining_if_end_turn, -3, 'A random-target attack cannot claim to hit every enemy');
});

test('declared self HP loss can kill before an otherwise fully blocked enemy turn', () => {
  const target = { combat_id: 2, hp: 61, block: 0, is_alive: true, intents: [{ damage: 6 }] };
  const combat = { player: { hp: 1, energy: 1, block: 20 }, hand: [], enemies: [target] };
  const selfHarm = combatForecast(combat, { cost: 1, hp_loss: 2, target_previews: [{ target_id: 2, damage: 15 }] }, target);
  assert.equal(selfHarm.fatal_from_declared_hp_loss, true);
  assert.equal(selfHarm.fatal_if_end_turn, true);
  assert.equal(selfHarm.hp_remaining_after_declared_loss, -1);
  assert.equal(combatForecast(combat, { cost: 1, target_previews: [{ target_id: 2, damage: 6 }] }, target).hp_remaining_if_end_turn, 1, 'The recorded Strike alternative preserves life');
});

test('Toxic hand damage uses block, and playing or exhausting the affected cards removes it', () => {
  const toxicA = { id: 'TOXIC', type: 'Status', index: 0, cost: 1, damage: 5 };
  const toxicB = { ...toxicA, index: 1 };
  const combat = { player: { hp: 19, energy: 3, block: 10 }, hand: [toxicA, toxicB], enemies: [{ is_alive: true, hp: 50, block: 0, intents: [{ damage: 18 }] }] };
  assert.equal(combatForecast(combat).hp_remaining_if_end_turn, 1, 'Two Toxic cards explain the observed extra ten damage');
  assert.equal(combatForecast(combat, toxicA).hp_remaining_if_end_turn, 6);
  const exhausted = combatForecast(combat, { id: 'SECOND_WIND', type: 'Skill', index: 2, cost: 1, block: 5 });
  assert.equal(exhausted.end_turn_hand_damage, undefined);
  assert.equal(exhausted.hp_remaining_if_end_turn, 19);
  const finishingAttack = { cost: 1, index: 2, target_previews: [{ target_id: 1, damage: 50 }] };
  combat.enemies[0].combat_id = 1;
  assert.equal(combatForecast(combat, finishingAttack, combat.enemies[0]).end_turn_hand_damage, undefined, 'Ending combat avoids retained-hand turn-end effects, subject to the existing revival caveat');
});
