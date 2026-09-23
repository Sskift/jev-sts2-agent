import test from 'node:test';
import assert from 'node:assert/strict';
import { auditObservedAction } from '../src/observation_audit.mjs';

const before = { screen: 'COMBAT', decision_context: { run_id: 'run', combat_id: 'combat' },
  combat: { turn_number: 1, enemies: [{ combat_id: 3, hp: 40 }] } };

test('end-turn audit compares a completed native observation with an explicit forecast', () => {
  const decision = { request: { cmd: 'end_turn' }, combat_estimate: { hp_remaining_if_end_turn: -7 } };
  const after = { screen: 'GAME_OVER', decision_context: { run_id: 'run', player: { hp: 0 } } };
  assert.deepEqual(auditObservedAction(before, decision, after)?.comparisons,
    [{ field: 'player_hp_after_end_turn', predicted: 0, observed: 0, matches: true }]);
  assert.equal(auditObservedAction(before, { ...decision, combat_estimate: { hp_remaining_if_end_turn: null } }, after), null);
  assert.equal(auditObservedAction(before, decision, { screen: 'COMBAT',
    decision_context: { run_id: 'run', combat_id: 'combat', player: { hp: 2 } },
    combat: { is_player_turn: false, turn_number: 1 } }), null);
});

test('attack audit exposes an arithmetic mismatch without changing the observation', () => {
  const decision = { request: { cmd: 'play_card', target: 3 }, combat_estimate: { attack_hp_loss: 9 } };
  const after = { screen: 'COMBAT', decision_context: { run_id: 'run', combat_id: 'combat' },
    combat: { is_player_turn: true, turn_number: 1, enemies: [{ combat_id: 3, hp: 35 }] } };
  const result = auditObservedAction(before, decision, after);
  assert.equal(result.mismatch, true);
  assert.deepEqual(result.comparisons[0], { field: 'enemy_3_hp_removed', predicted: 9, observed: 5, matches: false });
  assert.equal(after.combat.enemies[0].hp, 35);
});

test('attack audit skips conditional or unobservable outcomes', () => {
  const decision = { request: { cmd: 'play_card', target: 3 }, combat_estimate: { attack_hp_loss: 9,
    uncomputed_reactions: [{ source_id: 'CURL_UP_POWER' }] } };
  const after = { screen: 'COMBAT', decision_context: { run_id: 'run', combat_id: 'combat' },
    combat: { is_player_turn: true, turn_number: 1, enemies: [{ combat_id: 3, hp: 35 }] } };
  assert.equal(auditObservedAction(before, decision, after), null);
  assert.equal(auditObservedAction(before, { ...decision, combat_estimate: { attack_hp_loss: 9 } },
    { ...after, screen: 'UNKNOWN' }), null);
});
