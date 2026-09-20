import test from 'node:test';
import assert from 'node:assert/strict';
import { compileModelRequest, restoreCanonicalContext, validateModelRequest, MODEL_CONTEXT_VERSION } from '../src/context_compiler.mjs';
import { prepareModDecision, makeModDecisionWithJev } from '../src/mod_decision.mjs';
import { compactDecisionRequest, expandRecordTables } from '../src/decision_context.mjs';
import { completeCombat, withContext } from './fixtures/context.mjs';

test('one compiler separates observations, rules, history, intentions and calculations without changing the canonical packet', () => {
  const state = completeCombat(), prepared = prepareModDecision(state);
  const canonical = compactDecisionRequest(prepared.payload), before = structuredClone(canonical);
  const { payload, metrics } = compileModelRequest(canonical, { purpose: 'turn_payoff' });
  const view = payload.state;
  assert.equal(view.schema_version, MODEL_CONTEXT_VERSION);
  assert.equal(view.decision.output_role, 'unexecuted_plan_component');
  assert.equal(view.observation.combat.history, undefined);
  assert.equal(view.observation.combat.visible_arithmetic, undefined);
  assert.equal(view.observation.combat.observed_progress, undefined);
  assert.ok(view.history.combat.events);
  assert.ok(view.analysis.current_combat);
  assert.ok(view.analysis.combat_progress);
  assert.ok(Object.keys(view.analysis.action_estimates).length);
  assert.ok(expandRecordTables(view.observation.legal_actions).every(action => !action.combat_estimate));
  assert.equal(view.knowledge.entity_rules['cards/STRIKE_IRONCLAD'], 'cards/STRIKE_IRONCLAD');
  assert.equal(view.knowledge.entity_rules['monsters/OFFLINE_ENEMY'], null);
  assert.ok(expandRecordTables(view.knowledge.catalog.cards).STRIKE_IRONCLAD);
  assert.deepEqual(expandRecordTables(restoreCanonicalContext(view)), expandRecordTables(canonical.state));
  assert.deepEqual(canonical, before);
  assert.equal(metrics.preservation, 'canonical_round_trip_verified');
  assert.deepEqual(payload.questions.next_action.criteria, canonical.questions.next_action.criteria);
});

test('changing a planning stage does not invent a new observation, while changing a current fact does', () => {
  const canonical = prepareModDecision(completeCombat()).payload;
  const one = compileModelRequest(canonical, { purpose: 'turn_payoff' }).payload;
  const two = compileModelRequest(canonical, { purpose: 'turn_preparation' }).payload;
  assert.equal(one.state.decision.observation_id, two.state.decision.observation_id);
  const packed = compileModelRequest(compactDecisionRequest(canonical), { purpose: 'turn_preparation' }).payload;
  assert.equal(one.state.decision.observation_id, packed.state.decision.observation_id, 'Observation identity is independent of table/text encoding');
  assert.notEqual(one.state.decision.phase, two.state.decision.phase);
  two.state.observation.player.hp--;
  assert.throws(() => validateModelRequest(two), /different observation/);
  one.state.knowledge.entity_rules['cards/STRIKE_IRONCLAD'] = null;
  assert.throws(() => validateModelRequest(one), /index is stale/);
});

test('between-room choices and advisory ratings use the same full context boundary', async () => {
  const state = withContext({ screen: 'REWARD', rewards: { rewards: [{ type: 'Card', card_choices: [{
    index: 0, id: 'BASH', name: 'Bash', type: 'Attack', cost: 2, description: 'Deal 8 damage. Apply 2 Vulnerable.'
  }] }] } });
  const seen = [];
  await makeModDecisionWithJev(state, { apiKey: 'offline', fetchImpl: async (_url, request) => {
    const body = JSON.parse(request.body); body.state = JSON.parse(body.state); seen.push(body);
    assert.equal(body.state.schema_version, MODEL_CONTEXT_VERSION);
    validateModelRequest(body);
    return { ok: true, json: async () => ({ model: 'jev-test', answers: Object.fromEntries(Object.entries(body.questions).map(([key, question]) => [key,
      question.type === 'score' ? { type: 'score', score: 2 } : { type: 'choice', choice: Object.keys(question.criteria)[0] }])) }) };
  } });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].state.decision.output_role, 'advisory_assessment');
  assert.equal(seen[1].state.decision.output_role, 'legal_action_selection');
  assert.equal(seen[1].state.analysis.model_assessment.options.length, 1);
  assert.deepEqual(seen[0].state.observation.deck, seen[1].state.observation.deck);
});
