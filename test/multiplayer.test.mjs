import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { completeCombat } from './fixtures/context.mjs';
import { buildModCandidates, prepareModDecision } from '../src/mod_decision.mjs';
import { currentCombatArithmetic } from '../src/combat_observation.mjs';
import { forecastCoverage } from '../src/forecast_coverage.mjs';
import { turnFingerprint, turnGuard } from '../src/turn_plan_state.mjs';
import { runModLoop } from '../src/mod_loop.mjs';
function party() {
  const state = completeCombat();
  state.combat.multiplayer = { local_player_id: 'guest', players: [
    { player_id: 'host', combat_id: 1, is_local: false, state: { character_name: 'Silent', hp: 60, block: 0 } },
    { player_id: 'guest', combat_id: 2, is_local: true, state: { character_name: 'Ironclad', hp: 40, block: 0 } }
  ], enemy_intents_by_player: [] };
  state.decision_context.multiplayer = structuredClone(state.combat.multiplayer);
  return state;
}
test('non-host local context preserves party facts and names native legal ally targets', () => {
  const state = party();
  state.combat.hand[0].target_type = 'AnyPlayer';
  state.combat.hand[0].valid_target_ids = [1, 2];
  const candidates = buildModCandidates(state);
  assert.match(candidates.get('card_0_ally_1').description, /teammate Silent/);
  assert.match(candidates.get('card_0_ally_2').description, /local player Ironclad/);
  const prepared = prepareModDecision(state);
  assert.deepEqual(prepared.payload.state.combat.multiplayer, state.combat.multiplayer);
  assert.equal(currentCombatArithmetic(state.combat).incoming_attack_damage, null);
  assert.ok(forecastCoverage(state.combat).uncovered_effects.some(e => e.source_id === 'CONCURRENT_PARTY_ACTIONS'));
  const changed = structuredClone(state); changed.combat.multiplayer.players[0].state.block++;
  assert.notEqual(turnFingerprint(state), turnFingerprint(changed));
  assert.notDeepEqual(turnGuard(state).teammates, turnGuard(changed).teammates);
});
test('submitted multiplayer turn waits beyond twenty observations without commands or model calls', async t => {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts2-party-'));
  t.after(() => fs.rmSync(artifactDir, { recursive: true, force: true }));
  const state = party(); state.combat.is_player_turn = false;
  let reads = 0;
  const result = await runModLoop({ artifactDir, maxSteps: 22, intervalMs: 0, logger: () => {},
    client: { state: async () => { reads++; return structuredClone(state); }, request: () => { throw Error('No command while waiting'); } } });
  assert.equal(result.error, undefined);
  assert.equal(result.stoppedReason, 'max_steps');
  assert.equal(reads, 22);
});
