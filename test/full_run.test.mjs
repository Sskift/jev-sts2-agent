import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModCandidates, makeModDecisionWithJev } from '../src/mod_decision.mjs';
import { observeRun } from '../src/mod_loop.mjs';
import { DecisionMemory } from '../src/decision_context.mjs';
import { withContext } from './fixtures/context.mjs';

test('ordinary rewards keep offering cards, gold and proceeding', () => {
  const state = withContext({ screen: 'REWARD', rewards: { can_skip: true, rewards: [
    { index: 0, type: 'Gold', description: '20 Gold' },
    { index: 1, type: 'Card', card_choices: [{ index: 0, id: 'SHRUG_IT_OFF', name: 'Shrug', description: 'Gain 8 Block. Draw 1 card.', cost: 1 }] }
  ] } });
  const candidates = buildModCandidates(state);
  assert.deepEqual(candidates.get('claim_0').request, { cmd: 'reward_claim', reward_type: 'gold', nth: 0 });
  assert.equal(candidates.get('reward_1_card_0').request.card_id, 'SHRUG_IT_OFF');
  assert.ok(candidates.has('skip_card_0'));
  assert.ok(candidates.has('proceed'));
});

test('free gold and a potion with an uncontested open slot are claimed before leaving rewards', async () => {
  const state = withContext({ screen: 'REWARD', rewards: { can_skip: true, rewards: [
    { index: 0, type: 'Gold', description: '17 Gold' },
    { index: 1, type: 'Potion', description: 'Speed Potion', potion_id: 'SPEED_POTION' },
    { index: 2, type: 'Card', card_choices: [{ index: 0, id: 'A', name: 'A', description: 'Example card', cost: 1 }] }
  ] } });
  let calls = 0;
  const offline = { runStrategy: false, apiKey: 'offline', fetchImpl() { calls++; throw new Error('Offline'); } };
  const gold = await makeModDecisionWithJev(state, offline);
  assert.deepEqual(gold.request, { cmd: 'reward_claim', reward_type: 'gold', nth: 0 });
  state.rewards.rewards.shift();
  const potion = await makeModDecisionWithJev(state, offline);
  assert.deepEqual(potion.request, { cmd: 'reward_claim', reward_type: 'potion', nth: 0 });
  assert.equal(calls, 0);
  state.rewards.rewards.unshift({ index: 3, type: 'Potion', description: 'Another potion', potion_id: 'ANOTHER_POTION' });
  state.decision_context.potion_capacity = 1;
  await assert.rejects(makeModDecisionWithJev(state, offline), /network or timeout/);
  assert.equal(calls, 1);
});

test('shop candidates exclude unaffordable and sold items but count sold copies for nth', () => {
  const state = withContext({ screen: 'SHOP', shop: { player_gold: 80, can_proceed: true,
    cards: [
      { index: 0, card_id: 'A', is_stocked: false, cost: 20 },
      { index: 1, card_id: 'A', is_stocked: true, cost: 40 },
      { index: 2, card_id: 'B', is_stocked: true, cost: 100 },
      { index: 3, is_stocked: false }
    ], relics: [], potions: [], card_removal: { cost: 75, is_used: false }
  } });
  const candidates = buildModCandidates(state);
  assert.equal(candidates.has('buy_card_0'), false);
  assert.equal(candidates.has('buy_card_2'), false);
  assert.equal(candidates.get('buy_card_1').request.nth, 1);
  assert.ok(candidates.has('remove_card'));
});

test('formal victory requires one observed run beginning in act one and reaching all three acts', () => {
  const run = {};
  for (const [act, floor] of [[0, 1], [1, 18], [2, 35]]) {
    observeRun(run, { screen: 'MAP', decision_context: { run_id: 'same-run', act_index: act, total_floor: floor } }, 'state.json');
  }
  observeRun(run, { screen: 'REWARD' }, 'reward.json');
  assert.equal(run.complete, undefined);
  observeRun(run, { screen: 'GAME_OVER', game_over: { is_victory: true, can_return_to_menu: true } }, 'final.json');
  assert.equal(run.complete, true);
  assert.throws(() => observeRun(run, { decision_context: { run_id: 'another-run' } }), /identity changed/);
  const attachedLate = { startedAtFloor: 40, acts: [2] };
  observeRun(attachedLate, { screen: 'GAME_OVER', game_over: { is_victory: true } }, 'final.json');
  assert.equal(attachedLate.complete, false);
});

test('a sole legal workflow action needs no model request', async () => {
  const result = await makeModDecisionWithJev({ screen: 'MENU', menu: { has_run_save: false } }, { fetchImpl() { throw new Error('Unexpected API request'); } });
  assert.equal(result.request.cmd, 'new_run');
  assert.equal(result.model, 'forced-single-action');
});

test('after Jev skips the sole remaining card reward the workflow leaves instead of reopening it', async () => {
  const state = withContext({ screen: 'REWARD', rewards: { can_skip: true, rewards: [{ index: 0, type: 'Card', card_choices: [{ index: 0, id: 'A', name: 'A', description: 'Example card', cost: 1 }] }] } });
  const memory = new DecisionMemory(); memory.observe(state);
  memory.data.actions.push({ ok: true, request: { cmd: 'reward_skip_card', nth: 0 }, floor: state.decision_context.total_floor, after_screen: 'REWARD' });
  const decision = await makeModDecisionWithJev(state, { memory, fetchImpl() { throw new Error('Skip was already decided'); } });
  assert.equal(decision.request.cmd, 'proceed');
  assert.equal(decision.model, 'complete-selected-skip');
});

test('target-specific preview effects replace generic attack numbers in the chosen action', () => {
  const state = withContext({ screen: 'COMBAT', combat: { is_player_turn: true, is_player_actions_disabled: false, is_combat_ending: false,
    player: { hp: 30, max_hp: 80, energy: 1, block: 0 },
    hand: [{ index: 0, id: 'STRIKE', name: 'Strike', description: 'Deal 6 damage.', damage: 6, cost: 1, can_play: true, target_type: 'AnyEnemy', valid_target_ids: [1], target_previews: [{ target_id: 1, description: 'Deal 9 damage.', damage: 9 }] }],
    enemies: [{ combat_id: 1, name: 'Vulnerable enemy', hp: 7, block: 2, is_alive: true }]
  } });
  const action = buildModCandidates(state).get('card_0_target_1');
  assert.match(action.description, /Deal 9 damage/);
  assert.equal(action.combat_estimate.first_hit_hp_loss, 7);
});

test('completed combat tactical history stays local while resource changes carry forward', () => {
  const state = withContext({ screen: 'MAP' });
  const memory = new DecisionMemory(); memory.observe(state);
  memory.data.actions = [{ combat_id: 'previous', request: { cmd: 'play_card' } }, { combat_id: null, request: { cmd: 'choose_card' } }];
  memory.data.observations = [{ combat_id: 'previous', floor: 1, changes: { hp: { before: 80, after: 70 }, energy: { before: 3, after: 0 } } }];
  const context = memory.context(state);
  assert.equal(context.actions.length, 1);
  assert.deepEqual(context.observations[0].changes, { hp: { before: 80, after: 70 } });
});

test('relic counter history carries changed values without duplicating the inventory', () => {
  const state = withContext({ screen: 'MAP' });
  const memory = new DecisionMemory(); memory.observe(state);
  const fixed = { id: 'FIXED', description: 'Constant rule' };
  const counted = { id: 'COUNTED', description: 'Trigger every three attacks', counter: 1 };
  memory.data.observations.push({ floor: 1, changes: { relics: { before: [fixed, counted], after: [fixed, { ...counted, counter: 2 }] } } });
  const context = memory.context(state);
  assert.deepEqual(context.observations, []);
  assert.deepEqual(context.relic_updates, [{ observation_sequence: 0, floor: 1, id: 'COUNTED', field: 'counter', before: 1, after: 2 }]);
});
