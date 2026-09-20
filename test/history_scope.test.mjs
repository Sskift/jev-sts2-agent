import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDecisionContext, DecisionMemory } from '../src/decision_context.mjs';
import { buildModCandidates } from '../src/mod_decision.mjs';
import { decisionHistoryPolicy } from '../src/history_scope.mjs';
import { completeCombat, withContext } from './fixtures/context.mjs';

test('tactical context keeps current-round causality and the last enemy response, not prior room accounting', () => {
  const state = completeCombat(); state.combat.turn_number = 5;
  state.decision_context.combat_history = [
    { sequence: 0, round: 1, side: 'Player', type: 'EnergySpentEntry', amount: 1 },
    { sequence: 1, round: 4, side: 'Player', type: 'BlockGainedEntry', amount: 5 },
    { sequence: 2, round: 4, side: 'Enemy', type: 'DamageReceivedEntry', actor_id: 0, amount: 3 },
    { sequence: 3, round: 5, side: 'Player', type: 'CardExhaustedEntry', card_id: 'STRIKE_IRONCLAD' },
    { sequence: 4, round: 5, side: 'Player', type: 'EnergySpentEntry', amount: 1 }
  ];
  const memory = new DecisionMemory(); memory.observe(state);
  memory.data.actions = [
    { floor: 0, combat_id: null, ok: true, request: { cmd: 'shop_buy_card', id: 'BASH' } },
    { floor: 1, combat_id: 'offline-combat', round: 1, ok: true, request: { cmd: 'end_turn' } },
    { floor: 1, combat_id: 'offline-combat', round: 5, ok: true, request: { cmd: 'use_potion', id: 'ENERGY_POTION' } }
  ];
  memory.data.observations = [{ floor: 0, changes: { gold: { before: 100, after: 50 } } }];
  const before = structuredClone(memory.data);
  const packet = buildDecisionContext(state, { candidates: buildModCandidates(state), memory });
  assert.deepEqual(packet.combat.history.map(event => event.sequence), [2, 3, 4]);
  assert.deepEqual(packet.memory.actions.map(action => action.request.cmd), ['use_potion']);
  assert.deepEqual(packet.memory.observations, []);
  assert.equal(packet.memory.relevance.from_round, 5);
  assert.equal(packet.player.hp, state.combat.player.hp);
  assert.equal(packet.combat.exhaust_pile.length, state.combat.exhaust_pile.length);
  assert.deepEqual(memory.data, before, 'Local audit is untouched');
});

test('temporal rules and potentially unresolved draw-order choices expand the history window with a reason', () => {
  const state = completeCombat(); state.combat.turn_number = 6;
  const archive = { run_id: state.decision_context.run_id, actions: [] };
  state.combat.hand[0].description = 'Deal damage for each card exhausted this combat.';
  assert.equal(decisionHistoryPolicy(state, archive).from_round, 0);
  state.combat.hand[0].description = 'Gain Block if you lost HP last turn.';
  assert.equal(decisionHistoryPolicy(state, archive).from_round, 5);
  state.combat.hand[0].description = 'Deal 6 damage.';
  archive.actions = [
    { floor: 1, combat_id: 'offline-combat', round: 3, ok: true, request: { cmd: 'play_card', id: 'HEADBUTT' },
      played_card_at_request: { id: 'HEADBUTT', description: 'Put a card from your Discard Pile on top of your Draw Pile.' } },
    { floor: 1, combat_id: 'offline-combat', round: 3, ok: true, request: { cmd: 'grid_select_card', card_ids: ['DEFEND_IRONCLAD'] } }
  ];
  const selected = decisionHistoryPolicy(state, archive);
  assert.equal(selected.from_round, 6, 'Ordering evidence does not retain unrelated damage/energy events');
  assert.deepEqual(selected.ordering_windows, [{ round: 3, rule_id: 'HEADBUTT' }]);
  assert.equal(selected.reasons[0].kind, 'possible_remaining_order_knowledge');
  state.combat.draw_pile = [];
  assert.deepEqual(decisionHistoryPolicy(state, archive).ordering_windows, [], 'Selected identity is no longer in draw pile');
  archive.actions = [{ ...archive.actions[0], round: 4, played_card_at_request: { id: 'DELAYED_FIXTURE', description: 'In three turns, gain Block.' } }];
  assert.equal(decisionHistoryPolicy(state, archive).from_round, 4);
});

test('between-room decisions retain this interaction while using current build and resources for prior outcomes', () => {
  const state = withContext({ screen: 'REWARD', rewards: { rewards: [] } });
  state.decision_context.total_floor = 8;
  const memory = new DecisionMemory(); memory.observe(state);
  memory.data.actions = [
    { floor: 3, combat_id: null, ok: true, request: { cmd: 'reward_choose_card', card_id: 'BASH' } },
    { floor: 8, combat_id: null, ok: true, request: { cmd: 'reward_skip_card', nth: 0 } }
  ];
  const context = buildDecisionContext(state, { candidates: new Map(), memory });
  assert.equal(context.memory.actions.length, 1);
  assert.equal(context.memory.actions[0].request.cmd, 'reward_skip_card');
  assert.equal(context.memory.relevance.mode, 'current_room');
});

test('old executed damage remains in a compact encounter total without restoring old raw events', () => {
  const state = completeCombat(); state.combat.turn_number = 5;
  state.decision_context.combat_history = [
    { sequence: 0, round: 1, side: 'Player', type: 'DamageReceivedEntry', actor_id: 42, damage: { total: 6, blocked: 0, unblocked: 6, overkill: 0 } },
    { sequence: 1, round: 5, side: 'Player', type: 'EnergySpentEntry', amount: 1 }
  ];
  const memory = new DecisionMemory(); memory.observe(state);
  const packet = buildDecisionContext(state, { candidates: buildModCandidates(state), memory });
  assert.ok(!packet.combat.history.some(event => event.sequence === 0));
  assert.equal(packet.combat.observed_progress.enemies[0].recorded_hp_damage, 6);
  assert.equal(packet.combat.observed_progress.enemies[0].last_damaged_round, 1);
});
