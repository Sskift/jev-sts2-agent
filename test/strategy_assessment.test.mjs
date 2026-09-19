import test from 'node:test';
import assert from 'node:assert/strict';
import { makeModDecisionWithJev } from '../src/mod_decision.mjs';
import { withContext } from './fixtures/context.mjs';

const shop = () => withContext({ screen: 'SHOP', shop: { player_gold: 90, can_proceed: true, cards: [
  { index: 0, card_id: 'SHRUG_IT_OFF', card_name: 'Shrug It Off', description: 'Gain 8 Block. Draw 1 card.', energy_cost: 1, cost: 30, is_stocked: true },
  { index: 1, card_id: 'BASH', card_name: 'Bash', description: 'Deal 8 damage. Apply 2 Vulnerable.', energy_cost: 2, cost: 50, is_stocked: true }
], relics: [], potions: [] } });
const answer = (key, choice) => ({ ok: true, json: async () => ({ model: 'jev-offline', usage: { input_tokens: 100, output_tokens: 5 }, answers: { [key]: { type: 'choice', choice } } }) });

test('a deck judgment and the following shop action each receive complete state and retain all action options', async () => {
  const requests = [];
  const decision = await makeModDecisionWithJev(shop(), { apiKey: 'offline', fetchImpl: async (_url, request) => {
    const payload = JSON.parse(request.body);
    requests.push(payload);
    assert.equal(payload.state.player.hp, 70);
    assert.equal(payload.state.deck.count, 1);
    assert.ok(payload.state.map.nodes.length);
    assert.equal(payload.state.screen_state.shop.cards.length, 2);
    if (payload.questions.deck_priority) {
      assert.equal(payload.state.strategy_assessment, undefined);
      assert.ok(payload.questions.deck_priority.criteria.reliable_defense);
      return answer('deck_priority', 'reliable_defense');
    }
    assert.equal(payload.state.strategy_assessment.priority, 'reliable_defense');
    assert.match(payload.state.strategy_assessment.source, /advisory/);
    assert.deepEqual(payload.state.legal_actions.map(a => a.action_id), requests[0].state.legal_actions.map(a => a.action_id));
    return answer('next_action', 'buy_card_0');
  } });
  assert.equal(requests.length, 2);
  assert.deepEqual(decision.request, { cmd: 'shop_buy_card', id: 'SHRUG_IT_OFF', nth: 0 });
  assert.equal(decision.strategy_assessment.priority, 'reliable_defense');
  assert.equal(decision.usage.input_tokens, 200);
  assert.equal(decision.action_usage.input_tokens, 100);
});

test('an invalid or failed deck assessment cannot be turned into a game action', async () => {
  let calls = 0;
  await assert.rejects(makeModDecisionWithJev(shop(), { apiKey: 'offline', fetchImpl: async () => { calls++; return answer('deck_priority', 'invented_priority'); } }), /invalid mod action/);
  assert.equal(calls, 1);
  await assert.rejects(makeModDecisionWithJev(shop(), { apiKey: 'offline', fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) }), /503/);
});
