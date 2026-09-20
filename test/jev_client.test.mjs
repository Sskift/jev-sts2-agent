import test from 'node:test';
import assert from 'node:assert/strict';
import { getJevConfig, requestJev } from '../src/jev_client.mjs';

test('provider configuration keeps credentials separate and resolves Jev aliases', () => {
  const env = { TYPESAFE_API_KEY: 'direct-test', OPENROUTER_API_KEY: 'router-test' };
  assert.equal(getJevConfig({ env }).apiKey, 'direct-test');
  assert.equal(getJevConfig({ env, provider: 'openrouter' }).apiKey, 'router-test');
  assert.equal(getJevConfig({ env, provider: 'openrouter', model: 'jev-latest' }).model, '~typesafe/jev-latest');
  assert.throws(() => getJevConfig({ env, provider: 'typo' }), /JEV_PROVIDER/);
  assert.throws(() => getJevConfig({ env, model: 'another-model' }), /JEV_MODEL/);
});

test('OpenRouter native Decisions preserves structured state, batched questions and typed results', async () => {
  const payload = { model: 'jev-latest', state: { combat: { energy: 1 }, history: [{ played: 'Bash' }] }, questions: {
    action: { type: 'choice', instructions: 'Select next action', criteria: { attack: { target: 42 }, end: null } },
    risk: { type: 'score', instructions: 'Assess risk', criteria: ['Low', 'High'] }
  } };
  const result = { model: 'typesafe/jev-1.13', answers: {
    action: { type: 'choice', choice: 'attack', probabilities: { attack: 0.9, end: 0.1 }, confidence: 0.8 },
    risk: { type: 'score', score: 0.2, probabilities: { 0: 0.8, 1: 0.2 }, legend: { 0: 'Low', 1: 'High' } }
  }, usage: { input_tokens: 200, output_tokens: 30, cost: 0.0000084 } };
  let logged;
  assert.deepEqual(await requestJev(payload, { env: { JEV_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'router-test' },
    onRequest: p => { logged = p; }, fetchImpl: async (url, request) => {
      assert.equal(url, 'https://openrouter.ai/api/alpha/decisions');
      assert.equal(request.headers.Authorization, 'Bearer router-test');
      const sent = JSON.parse(request.body);
      assert.deepEqual(sent, { ...payload, model: '~typesafe/jev-latest' });
      assert.deepEqual(logged, sent);
      assert.equal(request.body.includes('router-test'), false);
      return { ok: true, json: async () => result };
    } }), result);
});

test('provider failures stop without fallback or exposing response secrets', async () => {
  let calls = 0;
  await assert.rejects(requestJev({ model: 'jev-latest' }, { env: { TYPESAFE_API_KEY: 'direct-test' }, fetchImpl: async url => {
    calls++;
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    return { ok: false, status: 402, json: async () => ({ detail: { error_type: 'billing_error', message: 'secret' } }) };
  } }), { message: 'Jev API error 402 (billing_error) via typesafe' });
  assert.equal(calls, 1);
});
