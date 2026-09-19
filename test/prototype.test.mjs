import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planAction, executeActionPlan, runLoopCycle, simulationFixture } from '../src/agent_loop.mjs';
import { analyzeScreenshot, getClaudeConfig, validateGameState } from '../src/vision_opus.mjs';

const forbidden = () => { throw new Error('Unexpected external side effect'); };

test('simulation requires dry run and never calls API, capture or execution', async () => {
  const { state, decision } = simulationFixture();
  const result = await runLoopCycle({ mockState: state, mockDecision: decision, dryRun: true, decisionFn: forbidden, perceiveFn: forbidden, executeFile: forbidden, logger() {} });
  assert.equal(result.executed, false);
  assert.deepEqual(result.plan.args, [500, 620, 950, 300]);
  await assert.rejects(runLoopCycle({ mockState: state, mockDecision: decision, executeFile: forbidden }), /requires dryRun/);
});

test('missing target, drop area or end-turn control yields wait without invented coordinates', () => {
  const { state, decision } = simulationFixture();
  assert.equal(planAction({ ...decision, target_enemy: null }, state).type, 'wait');
  assert.equal(planAction({ action: 'end_turn', target: { x: 3400, y: 1500 } }, { ...state, end_turn_btn: null }).type, 'wait');
  assert.equal(planAction({ action: 'end_turn' }, { ...state, end_turn_btn: { ...state.end_turn_btn, visible: false } }).type, 'wait');
  const untargeted = { action: 'play_card', card: state.cards[1] };
  assert.equal(planAction(untargeted, { ...state, play_area: null }).type, 'wait');
  assert.deepEqual(planAction(untargeted, state).args, [600, 620, 640, 300]);
});

test('uncertain player turn and invalid coordinates never produce a native action', () => {
  const { state, decision } = simulationFixture();
  for (const player_turn of [false, null, undefined]) assert.equal(planAction(decision, { ...state, player_turn }).type, 'wait');
  for (const x of [-0.1, -1, 1280, NaN, Infinity, '500; bad']) {
    const invalid = { ...decision, card: { ...decision.card, screen_pos: { x, y: 620 } } };
    assert.equal(planAction(invalid, state).type, 'wait');
  }
  assert.equal(planAction(decision, { ...state, screen_size: null }).type, 'wait');
});

test('native adapter uses explicit argument array and dry run never invokes it', () => {
  const { state, decision } = simulationFixture();
  decision.card.screen_pos.x = 500.4;
  const plan = planAction(decision, state);
  let observed;
  const result = executeActionPlan(plan, { executeFile: (...args) => { observed = args; return 'stub executed'; } });
  assert.equal(result.executed, true);
  assert.equal(observed[0], 'python');
  assert.deepEqual(observed[1].slice(1), ['drag', '500', '620', '950', '300']);
  assert.equal(observed[2].shell, undefined);
  assert.equal(executeActionPlan(plan, { dryRun: true, executeFile: forbidden }).executed, false);
  assert.throws(() => executeActionPlan({ type: 'click', args: ['1 & bad', 2] }, { executeFile: forbidden }), /Invalid native/);
});

test('perception rejects incomplete state and duplicate card slots', () => {
  const { state } = simulationFixture();
  assert.equal(validateGameState(state), state);
  assert.throws(() => validateGameState({}), /scene/);
  assert.throws(() => validateGameState({ ...state, player_turn: 'true' }), /player_turn/);
  const duplicate = structuredClone(state);
  duplicate.cards[1].slot = 0;
  assert.throws(() => validateGameState(duplicate), /slot/);
});

test('vision uses specified model and Bearer auth, checks completion and parses validated JSON', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-vision-test-'));
  const imagePath = path.join(folder, 'synthetic.png');
  t.after(() => { fs.unlinkSync(imagePath); fs.rmdirSync(folder); });
  fs.writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64'));
  const config = { baseUrl: 'https://example.invalid/', authToken: 'test-token', model: 'unapproved-alias' };
  const { state } = simulationFixture();
  const tlsBefore = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  const parsed = await analyzeScreenshot(imagePath, { config, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://example.invalid/v1/messages');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.equal(options.headers['x-api-key'], undefined);
    assert.equal(JSON.parse(options.body).model, 'claude-opus-5');
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(state) }] }) };
  } });
  assert.deepEqual(parsed.screen_size, { width: 1, height: 1 });
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, tlsBefore);
  await assert.rejects(analyzeScreenshot(imagePath, { config, fetchImpl: async () => ({ ok: true, json: async () => ({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{}' }] }) }) }), /Incomplete/);
  await assert.rejects(analyzeScreenshot(imagePath, { config, fetchImpl: async () => ({ ok: false, status: 401 }) }), /401/);
  const resolved = getClaudeConfig({ env: { ANTHROPIC_AUTH_TOKEN: 'test-token', ANTHROPIC_DEFAULT_OPUS_MODEL: 'another-model' }, settingsPath: path.join(folder, 'absent.json') });
  assert.equal(resolved.model, 'claude-opus-5');
});
