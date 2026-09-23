import test from 'node:test';
import assert from 'node:assert/strict';
import { makeModDecisionWithJev } from '../src/mod_decision.mjs';
import { withContext, fixtureCard } from './fixtures/context.mjs';
import { parseJevRequest } from './fixtures/jev.mjs';

const reward = () => withContext({ screen: 'REWARD', rewards: { can_skip: true, rewards: [
  { index: 0, type: 'Card', card_choices: [{ index: 0, id: 'STRIKE_IRONCLAD', name: 'Strike', description: 'Deal 6 damage.', cost: 1 }] }
] } });
const reply = answers => ({ ok: true, json: async () => ({ model: 'offline', usage: { input_tokens: 100, output_tokens: 5 }, answers }) });

test('a proposed reward card is compared directly with skipping in both orders', async () => {
  for (const agreeToSkip of [true, false]) {
    const requests = [];
    const decision = await makeModDecisionWithJev(reward(), { runStrategy: false, apiKey: 'offline', fetchImpl: async (_url, request) => {
      const payload = parseJevRequest(request.body); requests.push(payload);
      if (payload.questions.option_0) return reply({ option_0: { type: 'score', score: 0.8 } });
      if (payload.questions.next_action) return reply({ next_action: { type: 'choice', choice: 'reward_0_card_0', confidence: 0.6 } });
      const forward = payload.questions.reward_forward, reverse = payload.questions.reward_reverse;
      assert.equal(forward.criteria.second.action_id, 'skip_card_0');
      assert.equal(reverse.criteria.first.action_id, 'skip_card_0');
      assert.equal(payload.state.deck.count, 1);
      return reply({ reward_forward: { type: 'choice', choice: 'second' },
        reward_reverse: { type: 'choice', choice: agreeToSkip ? 'first' : 'second' } });
    } });
    assert.equal(requests.length, 3);
    assert.equal(decision.request.cmd, agreeToSkip ? 'reward_skip_card' : 'reward_choose_card');
    assert.equal(decision.reward_skip_comparison.consensus_action_id, agreeToSkip ? 'skip_card_0' : null);
    assert.equal(decision.initial_reward_choice.candidate_id, 'reward_0_card_0');
    assert.equal(decision.confidence, agreeToSkip ? undefined : 0.6);
    assert.equal(decision.usage.input_tokens, 300);
  }
});

test('a direct skip choice does not need a second comparison', async () => {
  let calls = 0;
  const decision = await makeModDecisionWithJev(reward(), { runStrategy: false, apiKey: 'offline', fetchImpl: async (_url, request) => {
    calls++;
    const payload = parseJevRequest(request.body);
    return reply(payload.questions.option_0 ? { option_0: { type: 'score', score: 0.2 } }
      : { next_action: { type: 'choice', choice: 'skip_card_0' } });
  } });
  assert.equal(calls, 2);
  assert.equal(decision.request.cmd, 'reward_skip_card');
  assert.equal(decision.reward_skip_comparison, undefined);
});

test('independent Jev judgment skips a marginal card without another paid comparison', async () => {
  let calls = 0;
  const state = reward();
  state.decision_context.master_deck.push(fixtureCard('POMMEL_STRIKE', { rarity: 'Common', type: 'Attack',
    details: { instance_id: 'existing-attack', upgrade_level: 0 } }));
  state.decision_context.player.deck_count = state.decision_context.master_deck.length;
  const decision = await makeModDecisionWithJev(state, { runStrategy: false, apiKey: 'offline', fetchImpl: async (_url, request) => {
    calls++;
    const payload = parseJevRequest(request.body);
    if (payload.questions.option_0) return reply({ option_0: { type: 'score', score: 1.2,
      probabilities: { 0: 0.1, 1: 0.6, 2: 0.25, 3: 0.05 } } });
    assert.ok(payload.questions.next_action);
    return reply({ next_action: { type: 'choice', choice: 'reward_0_card_0', confidence: 0.8 } });
  } });
  assert.equal(calls, 2);
  assert.equal(decision.request.cmd, 'reward_skip_card');
  assert.equal(decision.reward_skip_assessment.card_judgments[0].marginal_or_worse_probability, 0.7);
  assert.equal(decision.initial_reward_choice.candidate_id, 'reward_0_card_0');
  assert.equal(decision.confidence, undefined);
});

test('a bare Act 1 starter deck rechecks an early damage card rather than auto-skipping it', async () => {
  const state = reward();
  state.rewards.rewards[0].card_choices[0] = { index: 0, id: 'POMMEL_STRIKE', name: 'Pommel Strike',
    description: 'Deal 9 damage. Draw 1 card.', cost: 1 };
  state.decision_context.master_deck = Array.from({ length: 10 }, (_, i) => fixtureCard('STRIKE_IRONCLAD',
    { details: { instance_id: `starter-${i}`, upgrade_level: 0 } }));
  state.decision_context.player.deck_count = state.decision_context.master_deck.length;
  const requests = [];
  const decision = await makeModDecisionWithJev(state, { runStrategy: false, apiKey: 'offline', fetchImpl: async (_url, request) => {
    const payload = parseJevRequest(request.body); requests.push(payload);
    if (payload.questions.option_0) return reply({ option_0: { type: 'score', score: 1.4,
      probabilities: { 0: 0.12, 1: 0.51, 2: 0.34, 3: 0.03 } } });
    if (payload.questions.next_action) return reply({ next_action: { type: 'choice', choice: 'reward_0_card_0' } });
    return reply({ reward_forward: { type: 'choice', choice: 'first' },
      reward_reverse: { type: 'choice', choice: 'second' } });
  } });
  assert.equal(requests.length, 3);
  assert.equal(decision.request.cmd, 'reward_choose_card');
  assert.equal(decision.reward_skip_comparison.first_non_basic_attack_missing, true);
  assert.equal(decision.reward_skip_assessment, undefined);
});
