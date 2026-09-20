import { parseJevRequest } from './fixtures/jev.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildModCandidates, makeModDecisionWithJev, prepareModDecision } from '../src/mod_decision.mjs';
import { runModLoop } from '../src/mod_loop.mjs';
import { withContext, fixtureCard } from './fixtures/context.mjs';

function selection(size = 24, min = 4, max = min) {
  return withContext({ screen: 'GRID_CARD_SELECT', grid_card_select: {
    selection_type: 'upgrade', prompt: `Choose ${min} to ${max} cards to Upgrade.`, min_select: min, max_select: max, cancelable: false,
    cards: Array.from({ length: size }, (_, index) => ({ index, card_id: index < 3 ? 'STRIKE_IRONCLAD' : `CARD_${index}`, card_name: `Card ${index}`, description: 'Deal 6 damage.', cost: 1, upgrade_preview: 'Deal 9 damage.', upgrade_preview_cost: 1 }))
  } }, { master_deck: Array.from({ length: size }, (_, index) => fixtureCard(index < 3 ? 'STRIKE_IRONCLAD' : `CARD_${index}`, { details: { instance_id: `copy_${index}` } })) });
}

function mockModel(choices, inspect = () => {}) {
  let call = 0;
  return async (_url, request) => {
    const payload = parseJevRequest(request.body);
    inspect(payload, call);
    const choice = choices[call++];
    assert.ok(choice, 'Unexpected extra model call');
    return { ok: true, json: async () => ({ model: 'jev-test', usage: { input_tokens: 100, output_tokens: 1 }, answers: { next_action: { type: 'choice', choice } } }) };
  };
}

function artifacts(t) {
  const root = path.resolve(os.tmpdir()), dir = fs.mkdtempSync(path.join(root, 'sts2-selection-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), root);
    assert.ok(path.basename(dir).startsWith('sts2-selection-test-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('24-choose-4 gives every remaining card and full context at each stage, then one complete request', async t => {
  const state = selection(), requests = [], chosen = [2, 0, 23, 1], stageResults = [];
  const fetchImpl = mockModel(chosen.map(index => `plan_card_${index}`), (payload, i) => {
    const planning = payload.state.screen_state.selection_planning;
    assert.equal(payload.state.deck.count, 24);
    assert.equal(payload.state.player.hp, 70);
    assert.ok(payload.state.map.nodes.length);
    assert.equal(payload.state.screen_state.grid_card_select.cards.length, 24);
    assert.deepEqual(planning.selected_indices, chosen.slice(0, i));
    assert.equal(planning.remaining_to_choose, 4 - i);
    assert.equal(payload.state.legal_actions.length, 24 - i);
    assert.ok(payload.state.legal_actions.every(a => a.request === null && !chosen.slice(0, i).includes(a.planning_choice.card_index)));
    assert.equal(requests.length, 0, 'No partial selection reaches the game');
  });
  const client = { async state() { return structuredClone(state); }, async request(request) { requests.push(request); return { ok: true }; } };
  const artifactDir = artifacts(t);
  const result = await runModLoop({ client, artifactDir, maxSteps: 1, intervalMs: 0, logger() {}, decide: (s, options) => makeModDecisionWithJev(s, { ...options, apiKey: 'offline', fetchImpl, onPlanningDecision: (decision, payload) => { stageResults.push(decision); options.onPlanningDecision(decision, payload); } }) });
  assert.equal(result.error, undefined);
  assert.equal(stageResults.length, 4);
  assert.deepEqual(requests, [{ cmd: 'grid_select_card', card_ids: ['STRIKE_IRONCLAD', 'STRIKE_IRONCLAD', 'CARD_23', 'STRIKE_IRONCLAD'], nth_values: [2, 0, 0, 1] }]);
  const decision = JSON.parse(fs.readFileSync(path.join(artifactDir, 'step-0001', 'decision.json')));
  assert.equal(decision.planning_trace.length, 4);
  assert.equal(decision.usage.input_tokens, 400);
  assert.ok(fs.existsSync(path.join(artifactDir, 'step-0001', 'jev-planning-request-0004.json')));
});

test('variable selection counts are model choices, while small selections include all permitted sizes', async () => {
  const state = selection(24, 1, 3);
  const decision = await makeModDecisionWithJev(state, { apiKey: 'offline', fetchImpl: mockModel(['plan_count_2', 'plan_card_5', 'plan_card_6'], (payload, i) => {
    const plan = payload.state.screen_state.selection_planning;
    if (i === 0) assert.deepEqual(payload.state.legal_actions.map(a => a.planning_choice.count), [1, 2, 3]);
    else assert.equal(plan.required_count, 2);
  }) });
  assert.equal(decision.request.card_ids.length, 2);
  assert.deepEqual([...buildModCandidates(selection(3, 1, 3)).values()].map(a => a.request.card_ids.length), [1, 1, 1, 2, 2, 2, 3]);
});

test('failure during selection planning preserves evidence and sends no game action', async t => {
  const state = selection(), artifactDir = artifacts(t);
  let calls = 0, writes = 0;
  const client = { async state() { return structuredClone(state); }, async request() { writes++; throw new Error('Unexpected game action'); } };
  const result = await runModLoop({ client, artifactDir, maxSteps: 1, logger() {}, decide: (s, options) => makeModDecisionWithJev(s, { ...options, apiKey: 'offline', fetchImpl: async (...args) => {
    if (++calls === 2) throw new Error('Offline second-stage failure');
    return mockModel(['plan_card_0'])(...args);
  } }) });
  assert.match(result.error, /second-stage failure/);
  assert.equal(writes, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(artifactDir, 'memory.json'))).pending, null);
  assert.ok(fs.existsSync(path.join(artifactDir, 'step-0001', 'jev-planning-request-0002.json')));
  assert.ok(fs.existsSync(path.join(artifactDir, 'step-0001', 'jev-planning-decision-0001.json')));
});

test('state changes during multi-stage planning discard the complete selection before dispatch', async t => {
  const state = selection(), changed = structuredClone(state);
  changed.grid_card_select.cards[0].upgrade_preview = 'An externally changed upgrade.';
  let reads = 0, writes = 0;
  const client = { async state() { return reads++ ? changed : state; }, async request() { writes++; } };
  const result = await runModLoop({ client, artifactDir: artifacts(t), maxSteps: 1, logger() {}, decide: (s, options) => makeModDecisionWithJev(s, { ...options, apiKey: 'offline', fetchImpl: mockModel(['plan_card_0', 'plan_card_1', 'plan_card_2', 'plan_card_3']) }) });
  assert.equal(result.error, undefined);
  assert.equal(writes, 0);
});

test('already selected and invented card choices are rejected; incomplete plans cannot dispatch', async t => {
  const state = selection();
  for (const choices of [['plan_card_0', 'plan_card_0'], ['plan_card_999']]) await assert.rejects(makeModDecisionWithJev(state, { apiKey: 'offline', fetchImpl: mockModel(choices) }), /invalid mod action/);
  let writes = 0;
  const result = await runModLoop({ client: { async state() { return state; }, async request() { writes++; } }, artifactDir: artifacts(t), maxSteps: 1, logger() {}, decide: () => [...prepareModDecision(state).candidates.values()][0] });
  assert.match(result.error, /not a complete dispatchable/);
  assert.equal(writes, 0);
});
