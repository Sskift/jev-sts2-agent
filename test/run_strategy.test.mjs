import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DecisionMemory, expandRecordTables } from '../src/decision_context.mjs';
import { makeModDecisionWithJev, prepareModDecision } from '../src/mod_decision.mjs';
import { compileModelRequest } from '../src/context_compiler.mjs';
import { strategicCapabilities, strategyBasis, strategyRefreshReason, publicRunStrategy, rememberRunStrategy } from '../src/run_strategy_state.mjs';
import { prepareRunStrategy } from '../src/run_strategy.mjs';
import { completeCombat, fixtureCard } from './fixtures/context.mjs';

function answers() {
  return { ...Object.fromEntries(Object.keys(strategicCapabilities).map(id => [`capability_${id}`, { type: 'score', score: 1, confidence: 0.7 }])),
    development_priority: { type: 'choice', choice: 'draw_consistency', confidence: 0.6 },
    build_anchor: { type: 'choice', choice: 'card_STRIKE_IRONCLAD', confidence: 0.4 } };
}
function assessment(state, memory) {
  const prepared = prepareRunStrategy(state, prepareModDecision(state, { memory }), strategyRefreshReason(state, memory));
  return { ...prepared.parseResult({ answers: answers() }), model: 'jev-test' };
}

test('a complete strategic judgment persists across restart but belongs only to its original run', t => {
  const base = path.resolve(os.tmpdir()), directory = fs.mkdtempSync(path.join(base, 'sts2-strategy-'));
  t.after(() => { assert.equal(path.dirname(directory), base); assert.ok(path.basename(directory).startsWith('sts2-strategy-')); fs.rmSync(directory, { recursive: true, force: true }); });
  const file = path.join(directory, 'memory.json'), memory = new DecisionMemory({ file }), state = completeCombat();
  memory.observe(state);
  rememberRunStrategy(memory, state, assessment(state, memory), 'Initial build review.');
  const restored = new DecisionMemory({ file }), view = publicRunStrategy(state, restored);
  assert.equal(view.is_observed_fact, false);
  assert.equal(view.development_priority.id, 'draw_consistency');
  assert.equal(view.revision, 1);
  assert.equal(view.freshness.needs_review, false);
  const compiled = compileModelRequest(prepareModDecision(state, { memory: restored }).payload).payload.state;
  assert.equal(compiled.intent.run_strategy.development_priority.id, 'draw_consistency');
  assert.equal(compiled.analysis.run_capability_assessment.source, 'jev_judgment');
  assert.equal(expandRecordTables(compiled.history.strategy_revisions).length, 0, 'Tactical context uses current strategy without its revision history');
  assert.equal(compiled.history.strategy_coverage.assessments_archived, 1);
  state.decision_context.run_id = 'another-run';
  assert.equal(publicRunStrategy(state, restored), null);
  restored.observe(state);
  assert.equal(restored.data.run_strategy, undefined);
});

test('ordinary hand, HP, energy and counter changes reuse strategy while build and checkpoint changes require review', () => {
  const state = completeCombat(), memory = new DecisionMemory(); memory.observe(state);
  rememberRunStrategy(memory, state, assessment(state, memory), 'Initial build review.');
  const baseline = strategyBasis(state).build_id;
  state.combat.player.hp--; state.combat.player.energy = 0; state.combat.hand.reverse();
  state.decision_context.player.hp--;
  assert.equal(strategyRefreshReason(state, memory), null);
  assert.equal(strategyBasis(state).build_id, baseline);
  state.decision_context.master_deck.push(fixtureCard('BASH'));
  assert.match(strategyRefreshReason(state, memory), /permanent deck/);
  state.decision_context.master_deck.pop();
  state.decision_context.total_floor++;
  assert.match(strategyRefreshReason(state, memory), /new room/);
  state.decision_context.total_floor--; delete state.combat; state.screen = 'REWARD';
  assert.match(strategyRefreshReason(state, memory), /post-combat/);
  state.decision_context.act_index++;
  assert.match(strategyRefreshReason(state, memory), /different act/);
});

test('the main decision path reassesses once then carries the same strategy into later decisions', async () => {
  const state = completeCombat(), memory = new DecisionMemory(); memory.observe(state);
  const seen = [];
  const options = { memory, runStrategy: true, turnPlanning: false, apiKey: 'offline', fetchImpl: async (_url, request) => {
    const wire = JSON.parse(request.body), view = JSON.parse(wire.state); seen.push(view);
    const strategy = view.decision.phase === 'run_strategy_assessment';
    return { ok: true, json: async () => ({ model: 'jev-test', usage: { input_tokens: 10, output_tokens: 1 },
      answers: strategy ? answers() : { next_action: { type: 'choice', choice: Object.keys(wire.questions.next_action.criteria)[0] } } }) };
  } };
  const first = await makeModDecisionWithJev(state, options);
  assert.equal(first.run_strategy_revision, 1);
  assert.equal(first.usage.input_tokens, 20);
  await makeModDecisionWithJev(state, options);
  assert.equal(seen.length, 3);
  assert.equal(seen[0].decision.horizon, 'remaining_run');
  assert.equal(seen[0].decision.output_role, 'advisory_assessment');
  assert.equal(seen[0].analysis.action_estimates, undefined, 'Build review does not carry isolated action forecasts');
  assert.ok(seen[1].analysis.action_estimates, 'Actual action selection retains its action forecasts');
  assert.equal(seen[0].uncertainty.observation_integrity.encoded_fact_sha256,
    seen[1].uncertainty.observation_integrity.encoded_fact_sha256, 'Phase scoping preserves all verified native facts');
  assert.equal(seen[1].intent.run_strategy.development_priority.id, 'draw_consistency');
  assert.equal(seen[2].intent.run_strategy.revision, 1);
});

test('permanent numeric growth within combat updates live facts but coalesces strategic review until aftermath', () => {
  const state = completeCombat(), memory = new DecisionMemory(); memory.observe(state);
  state.decision_context.master_deck[0].details.enchantment = { id: 'GOOPY', amount: 1, description: 'Permanently grows when played.' };
  rememberRunStrategy(memory, state, assessment(state, memory), 'Combat entry.');
  const original = structuredClone(memory.data.run_strategy);
  state.decision_context.master_deck[0].details.enchantment.amount = 2;
  state.decision_context.player.max_hp++;
  state.combat.player.max_hp++;
  assert.notEqual(strategyBasis(state).build_id, original.basis.build_id);
  assert.equal(strategyBasis(state).structure_id, original.basis.structure_id);
  assert.equal(strategyRefreshReason(state, memory), null);
  assert.equal(publicRunStrategy(state, memory).freshness.deferred_until_post_combat, true);
  const prepared = prepareModDecision(state, { memory });
  const compiled = compileModelRequest(prepared.payload).payload.state;
  assert.equal(expandRecordTables(compiled.observation.deck.cards)[0].card.details.enchantment.amount, 2);
  assert.deepEqual(memory.data.run_strategy, original, 'Reusing judgment does not silently move its basis forward');
  delete state.combat; state.screen = 'REWARD';
  assert.match(strategyRefreshReason(state, memory), /permanent deck/);
  assert.equal(publicRunStrategy(state, memory).freshness.deferred_until_post_combat, false);
});

test('an incomplete strategic response commits no memory and does not select a game command', async () => {
  const state = completeCombat(), memory = new DecisionMemory(); memory.observe(state);
  let requests = 0;
  await assert.rejects(makeModDecisionWithJev(state, { memory, runStrategy: true, apiKey: 'offline', fetchImpl: async () => {
    requests++; const incomplete = answers(); delete incomplete.capability_sustained_defense;
    return { ok: true, json: async () => ({ model: 'jev-test', answers: incomplete }) };
  } }), /strategic capability/);
  assert.equal(requests, 1);
  assert.equal(memory.data.run_strategy, undefined);
  assert.equal(memory.data.pending, null);
});

test('request memory keeps current judgments and every intention change without recycling superseded scores', () => {
  const state = completeCombat(), memory = new DecisionMemory(); memory.observe(state);
  const initial = assessment(state, memory);
  rememberRunStrategy(memory, state, structuredClone(initial), 'Initial assessment.');
  const rerated = structuredClone(initial);
  rerated.capabilities.sustained_defense.score = 1.8;
  rerated.priority.confidence = 0.8;
  rememberRunStrategy(memory, state, rerated, 'Same direction; changed confidence and capability ratings.');
  const redirected = structuredClone(rerated);
  redirected.priority.choice = 'sustained_defense';
  rememberRunStrategy(memory, state, redirected, 'Development direction changed.');
  const archive = structuredClone(memory.data.strategy_revisions);
  const view = publicRunStrategy(state, memory);
  assert.deepEqual(view.revisions.map(entry => entry.revision), [1, 3]);
  assert.deepEqual(view.revisions[1].changes.priority, { before: 'draw_consistency', after: 'sustained_defense' });
  assert.equal(view.capability_assessment.ratings.sustained_defense.score, 1.8);
  assert.equal(view.development_priority.confidence, 0.8);
  assert.equal(view.revision_coverage.assessments_archived, 3);
  assert.equal(view.revision_coverage.intention_changes_included, 2);
  assert.deepEqual(memory.data.strategy_revisions, archive, 'Local audit remains complete and unchanged');
  const compiled = compileModelRequest(prepareModDecision(state, { memory }).payload).payload.state;
  assert.equal(compiled.history.strategy_coverage.assessments_archived, 3);
  assert.equal(compiled.intent.run_strategy.revision_coverage, undefined);
});
