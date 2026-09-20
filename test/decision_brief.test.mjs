import test from 'node:test';
import assert from 'node:assert/strict';
import { DecisionMemory, expandRecordTables } from '../src/decision_context.mjs';
import { buildDecisionBrief } from '../src/decision_brief.mjs';
import { prepareModDecision } from '../src/mod_decision.mjs';
import { completeCombat } from './fixtures/context.mjs';

test('confirmed commands retain observed resource/target changes through memory reload', () => {
  const state = completeCombat(), memory = new DecisionMemory(); memory.observe(state);
  const card = state.combat.hand[0], target = state.combat.enemies[0];
  memory.begin({ cmd: 'play_card', id: card.id, target: target.combat_id }, state);
  const after = structuredClone(state);
  after.combat.player.energy--;
  after.combat.player.block += 3;
  after.combat.enemies[0].hp -= 6;
  memory.finish({ ok: true }, after);
  const restored = new DecisionMemory(); restored.data = JSON.parse(JSON.stringify(memory.data));
  const brief = buildDecisionBrief(after, restored), action = brief.recent_confirmed_actions[0];
  assert.equal(action.played_card.id, card.id);
  assert.deepEqual(action.observed_change.player_changes.energy, { before: state.combat.player.energy, after: after.combat.player.energy });
  assert.equal(action.observed_change.enemy_changes[0].changes.hp.after, target.hp - 6);
  assert.equal('combat_frame_before' in restored.data.actions[0], false);
  assert.equal(brief.current_resources.block, after.combat.player.block);
});

test('recent action brief does not mix runs/fights or fabricate older command results', () => {
  const state = completeCombat(), memory = new DecisionMemory(); memory.observe(state);
  memory.data.actions = Array.from({ length: 6 }, (_, index) => ({ ok: true, floor: state.decision_context.total_floor, combat_id: state.decision_context.combat_id, round: index, request: { cmd: 'end_turn' }, after_screen: 'COMBAT' }));
  assert.deepEqual(buildDecisionBrief(state, memory).recent_confirmed_actions.map(action => action.round), [2, 3, 4, 5]);
  assert.equal(memory.data.actions.length, 6);
  assert.equal(buildDecisionBrief(state, memory).recent_confirmed_actions[0].observed_change, null);
  memory.data.run_id = 'other-run';
  assert.deepEqual(buildDecisionBrief(state, memory).recent_confirmed_actions, []);
});

test('immediate choice includes the same scoped arithmetic and preserves all legal candidates', () => {
  const state = completeCombat(), result = prepareModDecision(state);
  const context = expandRecordTables(result.payload.state);
  for (const [id, candidate] of result.candidates) {
    assert.ok(result.payload.questions.next_action.criteria[id]);
    if (candidate.combat_estimate) assert.equal(result.payload.questions.next_action.criteria[id].limited_calculation.end_now_hp, candidate.combat_estimate.hp_remaining_if_end_turn);
  }
  assert.deepEqual(context.decision_brief.current_resources, { hp: state.combat.player.hp, energy: state.combat.player.energy, block: state.combat.player.block });
});
