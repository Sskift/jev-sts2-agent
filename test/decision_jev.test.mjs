import { parseJevRequest } from './fixtures/jev.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDecisionWithJev } from '../src/decision_jev.mjs';

const position = { x: 100, y: 100 };
const card = { id: 'strike', name: 'Strike', description: 'Deal 6 damage.', effects: ['damage'], cost: 1, playable: true, target_required: true, screen_pos: position };
const enemy = { name: 'Slime', hp: 10, block: 0, screen_pos: { x: 300, y: 100 } };
function combat(overrides = {}) {
  return { scene: 'combat', player_turn: true, player: { energy: 1 }, cards: [card], enemies: [enemy], end_turn_btn: { visible: true, screen_pos: position }, play_area: { visible: true, screen_pos: position }, ...overrides };
}
function choose(choice, inspect = () => {}) {
  return { apiKey: 'offline-test', fetchImpl: async (_url, request) => {
    const payload = parseJevRequest(request.body);
    inspect(payload);
    return { ok: true, json: async () => ({ model: 'test-model', answers: { next_action: { type: 'choice', choice, probabilities: { [choice]: 1 }, confidence: 0.01 } }, usage: { input_tokens: 1, output_tokens: 1 } }) };
  }};
}
const noFetch = { apiKey: 'offline-test', fetchImpl: () => { throw new Error('Unexpected API call'); } };

test('zero energy still permits zero-cost cards and retains visible effects', async () => {
  const state = combat({ player: { energy: 0 }, cards: [{ ...card, cost: 0 }] });
  const decision = await makeDecisionWithJev(state, choose('card_0_enemy_0', payload => {
    assert.equal(payload.state.cards[0].description, 'Deal 6 damage.');
    assert.deepEqual(payload.state.cards[0].effects, ['damage']);
    assert.ok(payload.questions.next_action.criteria.end_turn);
  }));
  assert.equal(decision.action, 'play_card');
  assert.equal(decision.card.cost, 0);
  assert.equal(decision.confidence, 0.01);
});

test('duplicate names and IDs preserve exact card and enemy instances', async () => {
  const secondCard = { ...card, screen_pos: { x: 200, y: 100 } };
  const secondEnemy = { ...enemy, screen_pos: { x: 400, y: 100 } };
  const state = combat({ cards: [card, secondCard], enemies: [enemy, secondEnemy] });
  const decision = await makeDecisionWithJev(state, choose('card_1_enemy_1', payload => {
    assert.deepEqual(Object.keys(payload.questions.next_action.criteria), ['card_0_enemy_0', 'card_0_enemy_1', 'card_1_enemy_0', 'card_1_enemy_1', 'end_turn']);
  }));
  assert.equal(decision.card, secondCard);
  assert.equal(decision.target_enemy, secondEnemy);
});

test('missing evidence and non-player turns wait without a request', async () => {
  for (const state of [
    { scene: 'unknown', selectable_options: [{ name: 'Guess', screen_pos: position }] },
    combat({ player_turn: false }), combat({ player_turn: null }), combat({ player_turn: undefined }),
    combat({ enemies: [] }), combat({ cards: [], end_turn_btn: { visible: true } }),
    combat({ cards: [{ ...card, playable: false }], end_turn_btn: { visible: false } }),
    combat({ cards: [{ ...card, target_required: false }], play_area: null, end_turn_btn: null })
  ]) assert.equal((await makeDecisionWithJev(state, noFetch)).action, 'wait');
});

test('invalid choice is rejected instead of silently choosing the first card', async () => {
  await assert.rejects(makeDecisionWithJev(combat(), choose('card_99_enemy_0')), /invalid next_action/);
});

test('non-combat requests validate status and reject service errors', async () => {
  const state = { scene: 'reward', selectable_options: [{ name: 'Gold', description: 'Gain gold', screen_pos: position }] };
  await assert.rejects(makeDecisionWithJev(state, { apiKey: 'offline-test', fetchImpl: async () => ({ ok: false, status: 429, text: async () => 'rate limited' }) }), /Jev API error 429/);
  const decision = await makeDecisionWithJev(state, choose('option_0', payload => assert.equal(payload.state.selectable_options[0].description, 'Gain gold')));
  assert.equal(decision.action, 'click');
  assert.equal(decision.name, 'Gold');
});

test('untargeted cards use an observed play area and end turn uses observed coordinates', async () => {
  const state = combat({ cards: [{ ...card, target_required: false }] });
  assert.equal((await makeDecisionWithJev(state, choose('card_0'))).target_enemy, null);
  const decision = await makeDecisionWithJev(combat({ cards: [] }), choose('end_turn'));
  assert.equal(decision.action, 'end_turn');
  assert.deepEqual(decision.target, position);
});

test('disabled menu options and defeated games are not actionable candidates', async () => {
  const state = { scene: 'main_menu', selectable_options: [
    { name: 'Continue', enabled: false, screen_pos: position },
    { name: 'Single player', enabled: true, screen_pos: { x: 200, y: 100 } }
  ] };
  const decision = await makeDecisionWithJev(state, choose('option_1', payload => assert.deepEqual(Object.keys(payload.questions.next_action.criteria), ['option_1'])));
  assert.equal(decision.name, 'Single player');
  assert.equal((await makeDecisionWithJev({ ...state, scene: 'game_over' }, noFetch)).action, 'wait');
});
