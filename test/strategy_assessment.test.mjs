import test from 'node:test';
import assert from 'node:assert/strict';
import { makeModDecisionWithJev } from '../src/mod_decision.mjs';
import { withContext } from './fixtures/context.mjs';

const shop = () => withContext({ screen: 'SHOP', shop: { player_gold: 90, can_proceed: true, cards: [
  { index: 0, card_id: 'SHRUG_IT_OFF', card_name: 'Shrug It Off', description: 'Gain 8 Block. Draw 1 card.', energy_cost: 1, cost: 30, is_stocked: true },
  { index: 1, card_id: 'BASH', card_name: 'Bash', description: 'Deal 8 damage. Apply 2 Vulnerable.', energy_cost: 2, cost: 50, is_stocked: true }
], relics: [], potions: [] } });
const reply = answers => ({ ok: true, json: async () => ({ model: 'jev-offline', usage: { input_tokens: 100, output_tokens: 5 }, answers }) });
const scores = { option_0: { type: 'score', score: 2.4, confidence: 0.7 }, option_1: { type: 'score', score: 0.8, confidence: 0.6 } };

test('incremental option judgments share complete state and leave every final action selectable', async () => {
  const requests = [];
  const decision = await makeModDecisionWithJev(shop(), { apiKey: 'offline', fetchImpl: async (_url, request) => {
    const payload = JSON.parse(request.body); requests.push(payload);
    assert.equal(payload.state.player.hp, 70);
    assert.equal(payload.state.deck.count, 1);
    assert.ok(payload.state.map.nodes.length);
    assert.equal(payload.state.screen_state.shop.cards.length, 2);
    if (!payload.questions.next_action) {
      assert.equal(payload.state.strategy_assessment, undefined);
      assert.equal(Object.keys(payload.questions).length, 2);
      assert.equal(payload.questions.option_0.type, 'score');
      assert.match(payload.questions.option_0.instructions, /Shrug It Off/);
      assert.equal(payload.questions.option_0.criteria.length, 4);
      return reply(scores);
    }
    assert.deepEqual(payload.state.strategy_assessment.options.map(o => [o.action_id, o.score]), [['buy_card_0', 2.4], ['buy_card_1', 0.8]]);
    assert.match(payload.state.strategy_assessment.source, /advisory/);
    assert.deepEqual(payload.state.legal_actions.map(a => a.action_id), requests[0].state.legal_actions.map(a => a.action_id));
    return reply({ next_action: { type: 'choice', choice: 'buy_card_0' } });
  } });
  assert.equal(requests.length, 2);
  assert.deepEqual(decision.request, { cmd: 'shop_buy_card', id: 'SHRUG_IT_OFF', nth: 0 });
  assert.equal(decision.strategy_assessment.options[0].score, 2.4);
  assert.equal(decision.usage.input_tokens, 200);
  assert.equal(decision.action_usage.input_tokens, 100);
});

test('invalid, missing, or failed assessments stop before selecting a game action', async () => {
  for (const broken of [{ ...scores, option_0: { type: 'score', score: 4 } }, { option_0: scores.option_0 }, { ...scores, option_0: { type: 'choice', choice: 'buy_card_0' } }]) {
    let calls = 0;
    await assert.rejects(makeModDecisionWithJev(shop(), { apiKey: 'offline', fetchImpl: async () => { calls++; return reply(broken); } }), /invalid option assessment/);
    assert.equal(calls, 1);
  }
  await assert.rejects(makeModDecisionWithJev(shop(), { apiKey: 'offline', fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) }), /503/);
});

test('one offered card still gets a real assessment and a high score never forces taking it', async () => {
  const state = shop(); state.shop.cards.length = 1;
  let calls = 0;
  const result = await makeModDecisionWithJev(state, { apiKey: 'offline', fetchImpl: async (_url, request) => {
    calls++;
    const payload = JSON.parse(request.body);
    if (!payload.questions.next_action) return reply({ option_0: { type: 'score', score: 3 } });
    assert.ok(payload.questions.next_action.criteria.proceed);
    return reply({ next_action: { type: 'choice', choice: 'proceed' } });
  } });
  assert.equal(calls, 2);
  assert.equal(result.request.cmd, 'proceed');
});
