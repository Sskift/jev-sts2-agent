import test from 'node:test';
import assert from 'node:assert/strict';
import { projectTurnPrefix } from '../src/turn_projection.mjs';
import { completeCombat, fixtureCard } from './fixtures/context.mjs';

function state() {
  const s = completeCombat(); s.combat.player.energy = 3;
  s.combat.enemies[0].hp = 40;
  s.combat.hand = [fixtureCard('STRIKE_IRONCLAD', { index: 0, target_type: 'AnyEnemy', can_play: true, target_previews: [{ target_id: 42, damage: 6 }] }),
    fixtureCard('DEFEND_IRONCLAD', { index: 1, type: 'Skill', description: 'Gain 5 Block.', target_type: 'Self', block: 5 })];
  return s;
}
const strike = { kind: 'play_card', name: 'Strike', card_instance_id: 'STRIKE_IRONCLAD', target: 42 };
const defend = { kind: 'play_card', name: 'Defend', card_instance_id: 'DEFEND_IRONCLAD' };

test('conditional sequence sums never mutate observations or trigger Orichalcum between cards', () => {
  const s = state(); s.combat.player.relics = [{ id: 'ORICHALCUM' }];
  const original = structuredClone(s), projection = projectTurnPrefix(s, [strike, defend]);
  assert.equal(projection.block, 5);
  assert.equal(projection.hp_if_ending_after_prefix, 33);
  assert.equal(projection.remaining_enemies[0].hp, 34);
  assert.deepEqual(s, original);
  const noBlock = projectTurnPrefix(s, [strike]);
  assert.equal(noBlock.hp_if_ending_after_prefix, 34, 'Orichalcum applies once at turn end');
});

test('Rage preparation precedes attack-triggered Block and unknown potion/draw effects remain explicit', () => {
  const s = state();
  s.combat.hand.push(fixtureCard('RAGE', { index: 2, cost: 0, type: 'Skill', description: 'Whenever you play an Attack this turn, gain 3 Block.', rage_block_per_attack: 3 }));
  const rage = { kind: 'play_card', name: 'Rage', card_instance_id: 'RAGE' };
  assert.equal(projectTurnPrefix(s, [rage, strike]).block, 3);
  assert.equal(projectTurnPrefix(s, [strike, rage]).block, 0);
  assert.match(projectTurnPrefix(s, [{ kind: 'use_potion', name: 'Swift Potion' }]).unresolved_effects.join(' '), /not simulated/);
});
