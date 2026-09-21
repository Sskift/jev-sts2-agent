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
  assert.equal(getJevConfig({ env: { ...env, JEV_PLAN_ASSESSMENT_LIMIT: '24' } }).planAssessmentLimit, 24);
  assert.equal(getJevConfig({ env: { ...env, JEV_PLAN_ASSESSMENT_LIMIT: '24' }, planAssessmentLimit: null }).planAssessmentLimit, null);
  assert.throws(() => getJevConfig({ env: { ...env, JEV_PLAN_ASSESSMENT_LIMIT: '0' } }), /JEV_PLAN_ASSESSMENT_LIMIT/);
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
      assert.equal(typeof sent.state, 'string');
      assert.deepEqual({ ...sent, state: JSON.parse(sent.state) }, { ...payload, model: '~typesafe/jev-latest' });
      assert.deepEqual(logged, sent);
      assert.equal(request.body.includes('router-test'), false);
      return { ok: true, json: async () => result };
    } }), result);
});

test('JSON text preserves Unicode, quotes, newlines and all nested facts; byte budget excludes HTTP escaping', async () => {
  const payload = { model: 'jev-latest', state: { note: '牌 "A"\nsecond line', nested: [{ cost: 0, active: false, absent: null }] }, questions: {} };
  const bytes = Buffer.byteLength(JSON.stringify(payload));
  let metrics;
  await requestJev(payload, { env: { TYPESAFE_API_KEY: 'offline' }, metrics: { max_request_bytes: bytes },
    onRequest: (_payload, m) => { metrics = m; }, fetchImpl: async (_url, request) => {
      const sent = JSON.parse(request.body);
      assert.deepEqual(JSON.parse(sent.state), payload.state);
      assert.equal(metrics.content_bytes, bytes);
      assert.ok(metrics.request_bytes > metrics.content_bytes);
      return { ok: true, json: async () => ({}) };
    } });
  assert.equal(metrics.state_encoding, 'compact_json_text');
});

test('provider failures stop without fallback or exposing response secrets', async () => {
  let calls = 0;
  await assert.rejects(requestJev({ model: 'jev-latest' }, { env: { TYPESAFE_API_KEY: 'direct-test' }, fetchImpl: async url => {
    calls++;
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    return { ok: false, status: 402, json: async () => ({ detail: { error_type: 'billing_error', message: 'secret' } }) };
  } }), { message: 'Jev API error 402 (billing_error) via typesafe' });
  assert.equal(calls, 1);
  await assert.rejects(requestJev({ model: 'jev-latest' }, { env: { JEV_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'router-test' }, fetchImpl: async () => ({
    ok: false, status: 400, json: async () => ({ error: { code: 400, message: 'HTTP 400: {"detail":{"error_type":"max_tokens_exceeded","message":"secret"}}' } })
  }) }), { message: 'Jev API error 400 (max_tokens_exceeded) via openrouter' });
});

test('Vercel evaluation preserves typed questions and raw confidence while adapting model headers and token usage', async () => {
  const env = { JEV_PROVIDER: 'vercel', AI_GATEWAY_API_KEY: 'gateway-test' };
  assert.equal(getJevConfig({ env }).model, 'typesafe-ai/jev');
  const payload = { state: { energy: 3 }, questions: { value: { type: 'score', instructions: 'Assess', criteria: ['Low', 'High'] } } };
  const raw = { answers: { value: { type: 'score', score: 0.8, probabilities: { 0: 0.2, 1: 0.8 } }, unknown: { type: 'score', score: 0.5 } },
    providerMetadata: { typesafe: { confidence: { value: 0 } } }, usage: { inputTokens: 200, outputTokens: 20 } };
  let logged;
  const result = await requestJev(payload, { env, onResponse: r => { logged = r; }, fetchImpl: async (url, request) => {
    assert.equal(url, 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model');
    assert.equal(request.headers['ai-model-id'], 'typesafe-ai/jev');
    assert.equal(request.headers['ai-evaluation-model-specification-version'], '4');
    assert.equal(request.headers.Authorization, 'Bearer gateway-test');
    assert.deepEqual(JSON.parse(request.body), { ...payload, state: JSON.stringify(payload.state) });
    return { ok: true, json: async () => raw };
  } });
  assert.deepEqual(logged, raw);
  assert.equal(result.usage.input_tokens, 200);
  assert.equal(result.answers.value.confidence, 0);
  assert.equal(result.answers.unknown.confidence, undefined, 'Absent confidence remains absent');
  assert.equal(raw.answers.value.confidence, undefined, 'The archived raw response stays unchanged');
  assert.equal(result.model, 'typesafe-ai/jev', 'Do not invent the gateway upstream version');
});

test('configured transport failover uses a separate credential and model without changing the decision', async () => {
  const env = { JEV_PROVIDER: 'vercel', AI_GATEWAY_API_KEY: 'gateway-test', OPENROUTER_API_KEY: 'router-test', JEV_FALLBACK_PROVIDER: 'openrouter' };
  const payload = { model: 'typesafe-ai/jev', state: { energy: 3 }, questions: { q: { type: 'choice', instructions: 'Choose', criteria: { a: 'A' } } } };
  const logs = [], calls = [];
  const result = await requestJev(payload, { env, onResponse: r => logs.push(r), fetchImpl: async (url, request) => {
    calls.push(url);
    const wire = JSON.parse(request.body); assert.deepEqual(wire.questions, payload.questions); assert.deepEqual(JSON.parse(wire.state), payload.state);
    if (calls.length === 1) return { ok: false, status: 403, json: async () => ({ error: { type: 'customer_verification_required', message: 'echo gateway-test' } }) };
    assert.equal(request.headers.Authorization, 'Bearer router-test');
    assert.equal(wire.model, 'typesafe/jev-1.13');
    return { ok: true, json: async () => ({ model: 'typesafe/jev-1.13', answers: { q: { type: 'choice', choice: 'a', confidence: 0.01 } } }) };
  } });
  assert.equal(calls.length, 2);
  assert.equal(result.failover.to, 'openrouter');
  assert.equal(JSON.stringify(logs).includes('gateway-test'), false);
  assert.equal(result.answers.q.confidence, 0.01, 'Low confidence does not trigger another transport');
});

test('bad context does not fail over, and an unavailable backup is attempted only once', async () => {
  const env = { JEV_PROVIDER: 'vercel', AI_GATEWAY_API_KEY: 'gateway-test', OPENROUTER_API_KEY: 'router-test', JEV_FALLBACK_PROVIDER: 'openrouter' };
  for (const [status, expected] of [[400, 1], [429, 2]]) {
    let calls = 0;
    await assert.rejects(requestJev({ state: 'state', questions: {} }, { env, fetchImpl: async () => {
      calls++; return { ok: false, status, json: async () => ({}) };
    } }), new RegExp(String(status)));
    assert.equal(calls, expected);
  }
});

test('a rate limit cools the primary transport until Retry-After without delaying the available backup', async () => {
  const env = { JEV_PROVIDER: 'vercel', AI_GATEWAY_API_KEY: 'limited-test', OPENROUTER_API_KEY: 'backup-test', JEV_FALLBACK_PROVIDER: 'openrouter' };
  const calls = [], traces = [];
  const options = { env, onRequest: (_payload, metrics) => traces.push(metrics), fetchImpl: async url => {
    calls.push(url);
    return url.includes('vercel') ? { ok: false, status: 429, headers: new Headers({ 'retry-after': '60' }), json: async () => ({}) }
      : { ok: true, json: async () => ({ answers: {} }) };
  } };
  await requestJev({ state: 'first', questions: {} }, options);
  const result = await requestJev({ state: 'second', questions: {} }, options);
  assert.equal(calls.length, 3);
  assert.equal(result.failover.reason, 'provider_cooldown');
  assert.ok(result.failover.retry_after_ms > 0 && result.failover.retry_after_ms <= 60000);
  assert.equal(traces.at(-1).failover.reason, 'provider_cooldown');
});
