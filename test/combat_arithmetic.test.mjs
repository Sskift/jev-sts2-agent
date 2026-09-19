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
