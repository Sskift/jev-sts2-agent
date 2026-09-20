import { parseJevRequest } from './fixtures/jev.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DecisionMemory, expandRecordTables, validateDecisionPacket } from '../src/decision_context.mjs';
import { makeModDecisionWithJev, prepareModDecision, buildModCandidates } from '../src/mod_decision.mjs';
import { planStep, inspectTurnPlan, turnFingerprint, resolvePlanStep, plannedUpgradeSelection } from '../src/turn_plan_state.mjs';
import { completeCombat, fixtureCard } from './fixtures/context.mjs';
import { refineTurnPlan } from '../src/turn_plan_refinement.mjs';
import { resolvePlanComparisons, visibleSurvivalConstraints, planComparisonQuestions } from '../src/turn_plan_comparison.mjs';
import { reserveActionSequence } from '../src/turn_action_constraints.mjs';

const card = (id, instance, index, extra = {}) => fixtureCard(id, {
  index, can_play: true, target_type: 'AnyEnemy', target_previews: [{ target_id: 42, damage: 6 }],
  details: { instance_id: instance, upgrade_level: 0, target_type: 'AnyEnemy' }, ...extra
});
function stateWith(hand, energy = 3) {
  const state = completeCombat();
  state.combat.hand = hand;
  state.combat.enemies[0].hp = 50;
  state.combat.player.energy = energy;
  return sync(state);
}
function sync(state) {
  for (const [pile, count] of [['hand', 'hand_count'], ['draw_pile', 'draw_count'], ['discard_pile', 'discard_count'], ['exhaust_pile', 'exhaust_count']]) state.combat.player[count] = state.combat[pile].length;
  state.decision_context.player = structuredClone(state.combat.player);
  return state;
}
function savedPlan(state, ids) {
  const candidates = buildModCandidates(state);
  return { version: 1, id: 'test-plan', run_id: state.decision_context.run_id, combat_id: state.decision_context.combat_id,
    turn: state.combat.turn_number, revision: 0, objective: { id: 'damage', meaning: 'Deal efficient damage this turn.' },
    steps: ids.map(id => planStep(state, candidates.get(id))), retained_cards: [], cursor: 0,
    status: 'active', review_reasons: [], completed_actions: [], expected_fingerprint: turnFingerprint(state) };
}
function fakeJev(answers, seen = []) {
  return async (_url, request) => {
    const body = parseJevRequest(request.body); seen.push(body);
    if (!body.questions.next_action) {
      return { ok: true, json: async () => ({ model: 'jev-test', usage: { input_tokens: 100 },
        answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'choice', choice: 'plan_a', probabilities: { plan_a: 1 }, confidence: 1 }])) }) };
    }
    const selected = answers.shift();
    assert.ok(selected, 'Unexpected extra Jev decision');
    assert.ok(Object.hasOwn(body.questions.next_action.criteria, selected), `Missing choice ${selected}`);
    return { ok: true, json: async () => ({ model: 'jev-test', usage: { input_tokens: 100 }, answers: { next_action: { type: 'choice', choice: selected, probabilities: { [selected]: 1 }, confidence: 1 } } }) };
  };
}
const noModel = () => { throw new Error('A valid turn plan must execute without another independent card choice'); };

test('card-start restrictions depend on the affected instance, not a blanket per-turn ban', () => {
  const state = stateWith([card('DEFEND_IRONCLAD', 'ringing', 0), card('STRIKE_IRONCLAD', 'other', 1)]);
  state.combat.player.powers.push({ id: 'RINGING_POWER', amount: 1 });
  state.combat.hand[0].details.affliction = { id: 'RINGING' };
  state.combat.hand[1].details.affliction = { id: 'OTHER_AFFLICTION' };
  const ringing = { kind: 'play_card', card_instance_id: 'ringing' }, other = { kind: 'play_card', card_instance_id: 'other' };
  assert.equal(reserveActionSequence(state, [ringing, other]).valid, true);
  assert.equal(reserveActionSequence(state, [other, ringing]).valid, false);
  assert.equal(reserveActionSequence(state, [{ kind: 'use_potion' }, ringing]).valid, true);
  assert.equal(reserveActionSequence(state, [ringing, ringing]).valid, false);
  state.combat.player.powers = [];
  assert.deepEqual(reserveActionSequence(state, [other, ringing]).constraints, []);
});

test('planning and refinement cannot promise a second affected card after an upgrade preparation', async () => {
  const state = stateWith([
    card('ARMAMENTS', 'a'.repeat(32), 0, { name: 'Armaments', type: 'Skill', target_type: 'Self', description: 'Gain 5 Block. Upgrade a card in your Hand. Ringing.', block: 5 }),
    card('DEFEND_IRONCLAD', 'd'.repeat(32), 1, { name: 'Defend', type: 'Skill', target_type: 'Self', description: 'Gain 5 Block. Ringing.', block: 5 })
  ]);
  state.combat.player.powers.push({ id: 'RINGING_POWER', amount: 1, description: 'You can only play 1 card this turn.' });
  for (const card of state.combat.hand) card.details.affliction = { id: 'RINGING' };
  sync(state);
  const memory = new DecisionMemory(); memory.observe(state);
  const seen = [];
  const result = await makeModDecisionWithJev(state, { memory, apiKey: 'offline', fetchImpl: fakeJev(['protect_hp', 'card_1'], seen) });
  assert.deepEqual(result.turn_plan.steps.map(step => step.kind), ['play_card', 'end_turn']);
  for (const request of seen) {
    const full = expandRecordTables(request.state);
    assert.ok(full.turn_planning.action_reservation.valid);
    for (const pair of full.turn_planning.comparisons || []) for (const option of Object.values(pair)) {
      assert.ok(option.ordered_sequence.length <= 1, 'No illegal two-card alternative reaches Jev');
    }
    if (full.turn_planning.action_reservation.transitions.length) {
      const broken = structuredClone(full); broken.turn_planning.action_reservation.transitions[0].card_starts_after++;
      assert.throws(() => validateDecisionPacket(broken), /action reservation/);
    }
  }
});

test('complete-plan alternatives can remove redundant Block and show energy available when drawing', async () => {
  const state = stateWith([
    card('DEFEND_IRONCLAD', 'd1', 0, { name: 'Defend', cost: 1, type: 'Skill', target_type: 'Self', description: 'Gain 5 Block.', block: 5 }),
    card('SHRUG_IT_OFF', 'draw', 1, { name: 'Shrug It Off', cost: 1, type: 'Skill', target_type: 'Self', description: 'Gain 8 Block. Draw 1 card.', block: 8 })
  ], 2);
  state.combat.player.block = 6; sync(state);
  const plan = savedPlan(state, ['card_0', 'card_1', 'end_turn']);
  plan.end_policy = 'end_after_steps_unless_conditions_change'; plan.budget = {};
  let sawDrawWithNoEnergy = false, sawDrawWithEnergy = false, sawRemovedDefense = false;
  await refineTurnPlan(state, plan, prepareModDecision(state), noModel, async pairs => pairs.map(pair => {
    for (const option of pair) {
      const sequence = option.label.ordered_sequence, draw = sequence.find(s => s.action === 'Shrug It Off');
      if (draw) {
        sawDrawWithNoEnergy ||= draw.energy_after_reserved_costs === 0;
        sawDrawWithEnergy ||= draw.energy_after_reserved_costs === 1;
        sawRemovedDefense ||= sequence.length === 1;
      }
    }
    return (pair.find(option => option.label.ordered_sequence.length === 1
      && option.label.ordered_sequence[0].action === 'Shrug It Off') || pair[0]).value;
  }));
  assert.ok(sawDrawWithNoEnergy && sawDrawWithEnergy && sawRemovedDefense);
  assert.deepEqual(plan.steps.map(s => s.card_instance_id).filter(Boolean), ['draw']);
  assert.equal(plan.budget.remaining_after_printed_costs, 1);
});

test('complete-plan comparison can replace two separated defenses with one stronger card while preserving free attacks', async () => {
  const state = stateWith([
    card('EXPECT_A_FIGHT', 'strong', 0, { name: 'Expect a Fight', cost: 3, type: 'Skill', target_type: 'Self', description: 'Gain 25 Block. Gains 5 additional Block for each Strength you have.', block: 25 }),
    card('DEFEND_IRONCLAD', 'd1', 1, { name: 'Defend', cost: 1, type: 'Skill', target_type: 'Self', description: 'Gain 5 Block.', block: 5 }),
    card('ANGER', 'a1', 2, { name: 'Anger', cost: 0 }),
    card('DEFEND_IRONCLAD', 'd2', 3, { name: 'Defend', cost: 1, type: 'Skill', target_type: 'Self', description: 'Gain 5 Block.', block: 5 }),
    card('STRIKE_IRONCLAD', 'a2', 4, { name: 'Strike', cost: 0 })
  ]);
  const plan = savedPlan(state, ['card_1', 'card_2_target_42', 'card_3', 'card_4_target_42', 'end_turn']);
  plan.end_policy = 'end_after_steps_unless_conditions_change'; plan.budget = {};
  const prepared = prepareModDecision(state), original = structuredClone(state);
  let offered = false;
  const isTarget = option => {
    const actions = option.label.ordered_sequence.map(step => step.action);
    return actions.length === 3 && actions.includes('Expect a Fight') && actions.includes('Anger') && actions.includes('Strike');
  };
  await refineTurnPlan(state, plan, prepared, noModel, async pairs => pairs.map(pair => {
    const target = pair.find(isTarget);
    if (target) { offered = true; assert.equal(target.label.energy_spent, 3); assert.equal(target.label.conditional_preview.known_effects_only.block, 25); }
    return (target || pair[0]).value;
  }));
  assert.ok(offered, 'The model must see the consolidated alternative even though a one-card replacement is unaffordable');
  assert.equal(plan.steps.filter(step => step.kind === 'play_card').length, 3);
  assert.deepEqual(plan.steps.filter(step => ['a1', 'a2'].includes(step.card_instance_id)).map(step => step.card_instance_id), ['a1', 'a2']);
  assert.deepEqual(state, original);
});

test('constructs an objective, ordered preparation and payoff before dispatch, with complete state in every question', async () => {
  const arm = card('ARMAMENTS', 'arm', 0, { name: 'Armaments', type: 'Skill', target_type: 'Self', description: 'Gain 5 Block. Upgrade a card in your Hand.', block: 5 });
  const payoff = card('BASH', 'attack', 1, { name: 'Bash', cost: 2 });
  const state = stateWith([arm, payoff]), memory = new DecisionMemory(); memory.observe(state);
  const seen = [], answers = ['damage', 'card_1_target_42', 'card_0', 'manual'];
  const result = await makeModDecisionWithJev(state, { memory, apiKey: 'offline', fetchImpl: fakeJev(answers, seen) });
  assert.equal(result.request.id, 'ARMAMENTS');
  assert.deepEqual(result.turn_plan.steps.map(step => [step.kind, step.card_instance_id]), [['play_card', 'arm'], ['play_card', 'attack'], ['end_turn', undefined]]);
  assert.equal(result.turn_plan.steps[0].beneficiary_instance_id, 'attack');
  assert.equal(result.turn_plan.objective.id, 'damage');
  assert.equal(result.turn_plan.budget.remaining_after_printed_costs, 0);
  assert.equal(memory.data.turn_plan, undefined, 'Planning is not a persisted game commitment until the freshness check and begin');
  assert.equal(memory.data.pending, null);
  let sawPreparationBudget = false;
  for (const body of seen) {
    const full = expandRecordTables(body.state);
    assert.equal(full.combat.hand.length, 2);
    assert.equal(full.combat.discard_pile.length, 1);
    assert.equal(full.combat.exhaust_pile.length, 1);
    assert.ok(full.map.nodes.length && full.deck.cards.length && full.rule_reference);
    assert.ok(full.legal_actions.some(action => action.request.cmd === 'end_turn'));
    assert.match(full.turn_planning.phase_scope, /NOT happened/);
    const reservation = full.turn_planning.energy_reservation;
    assert.equal(reservation.is_observed, false);
    assert.equal(reservation.includes_future_energy_gains, false);
    assert.equal(reservation.steps.length, full.turn_planning.proposed_steps.length);
    if (reservation.steps.length) {
      sawPreparationBudget = true;
      assert.deepEqual(reservation.steps[0], { sequence: 0, kind: 'play_card', hand_index: 0,
        energy_before: 3, reserved_cost: 1, energy_after: 2, affordable: true });
      const broken = structuredClone(full); broken.turn_planning.energy_reservation.steps[0].energy_after = 3;
      assert.throws(() => validateDecisionPacket(broken), /Inconsistent energy transition/);
      const missing = structuredClone(full); delete missing.turn_planning.energy_reservation.steps;
      assert.throws(() => validateDecisionPacket(missing), /versioned protocol/);
    }
  }
  assert.ok(sawPreparationBudget, 'Budget transitions must be sent before final plan comparison');
  assert.equal(result.usage.input_tokens, seen.length * 100);
});

test('stable plan survives persistence and resolves duplicate copies against the current hand without new Jev calls', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-plan-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = stateWith([card('STRIKE_IRONCLAD', 'first', 0), card('STRIKE_IRONCLAD', 'second', 1), card('STRIKE_IRONCLAD', 'third', 2)]);
  let memory = new DecisionMemory({ file: path.join(dir, 'memory.json') }); memory.observe(state);
  const plan = savedPlan(state, ['card_0_target_42', 'card_1_target_42', 'card_2_target_42', 'end_turn']);
  const first = resolvePlanStep(plan.steps[0], state, buildModCandidates(state));
  memory.begin(first.request, state, { turnPlan: plan, turnStep: 0 });
  const after = structuredClone(state); after.combat.hand.shift(); after.combat.hand.forEach((card, index) => card.index = index);
  after.combat.player.energy--; after.combat.enemies[0].hp -= 6; sync(after);
  memory.finish({ ok: true }, after); memory.observe(after);
  memory = new DecisionMemory({ file: path.join(dir, 'memory.json') });
  const next = await makeModDecisionWithJev(after, { memory, fetchImpl: noModel });
  assert.equal(next.turn_step, 1);
  assert.deepEqual(next.request, { cmd: 'play_card', id: 'STRIKE_IRONCLAD', nth: 0, target: 42 });
  assert.equal(next.turn_plan.steps[1].card_instance_id, 'second');
  assert.equal(next.usage.input_tokens, 0);
  assert.equal(next.planning_trace.length, 0);
});

test('next-Attack preparation binds the exact payoff instance before the first command', async () => {
  const prep = card('ONE_TWO_PUNCH', 'prep', 0, { name: 'One-Two Punch', type: 'Skill', target_type: 'Self', description: 'This turn, your next Attack is played an extra time.' });
  const payoff = card('BASH', 'attack', 1, { name: 'Bash', type: 'Attack', cost: 2 });
  const state = stateWith([prep, payoff]), memory = new DecisionMemory(); memory.observe(state);
  const result = await makeModDecisionWithJev(state, { memory, apiKey: 'offline', refineTurnPlan: false,
    fetchImpl: fakeJev(['damage', 'card_1_target_42', 'card_0', 'manual']) });
  assert.equal(result.request.id, 'ONE_TWO_PUNCH');
  assert.equal(result.turn_plan.steps[0].next_card_instance_id, 'attack');
  assert.equal(result.turn_plan.steps[0].next_card_type, 'Attack');
  assert.equal(result.turn_plan.steps[1].card_type, 'Attack');
});

test('independent two-plan judgments share full state and a missing result commits no partial plan', async () => {
  const state = stateWith([
    card('ARMAMENTS', 'arm', 0, { name: 'Armaments', type: 'Skill', target_type: 'Self', description: 'Gain 5 Block. Upgrade a card in your Hand.', block: 5 }),
    card('BASH', 'attack', 1, { name: 'Bash', type: 'Attack', cost: 2 }),
    card('ANGER', 'free', 2, { name: 'Anger', type: 'Attack', cost: 0 }),
    card('DEFEND', 'defense', 3, { name: 'Defend', type: 'Skill', target_type: 'Self', block: 5 })
  ]);
  for (const omitAnswer of [false, true]) {
    const memory = new DecisionMemory(); memory.observe(state);
    const ordinary = ['damage', 'card_1_target_42', 'card_0', 'manual', 'none', 'end_turn'];
    let sawMultiple = false, compared = 0;
    const fetchImpl = async (_url, request) => {
      const body = parseJevRequest(request.body);
      let answers;
      if (body.questions.next_action) {
        const selected = ordinary.shift();
        assert.ok(Object.hasOwn(body.questions.next_action.criteria, selected));
        answers = { next_action: { type: 'choice', choice: selected } };
      } else {
        const full = expandRecordTables(body.state), entries = Object.entries(body.questions);
        assert.equal(full.combat.hand.length, 4);
        assert.ok(full.deck && full.map && full.memory && full.rule_reference);
        assert.equal(full.turn_planning.objective.id, 'damage');
        assert.deepEqual(full.turn_planning.proposed_steps, []);
        const wire = JSON.parse(request.body);
        const logical = { ...wire, state: JSON.parse(wire.state) };
        assert.ok(Buffer.byteLength(JSON.stringify(logical)) <= 90000, 'Budget covers the actual v2 request before HTTP string escaping');
        sawMultiple ||= entries.length > 1;
        compared += entries.length;
        assert.equal(full.turn_planning.comparisons.length * (full.turn_planning.survival_constraints.length ? 2 : 1), entries.length);
        for (const [id, question] of entries) assert.deepEqual(Object.keys(question.criteria),
          id.startsWith('survival_') ? ['plan_a', 'plan_b', 'no_clear_difference'] : ['plan_a', 'plan_b']);
        answers = Object.fromEntries(entries.slice(omitAnswer ? 1 : 0).map(([id]) => [id, { type: 'choice', choice: 'plan_a', probabilities: { plan_a: 0.6, plan_b: 0.4 } }]));
      }
      return { ok: true, json: async () => ({ model: 'jev-test', usage: { input_tokens: 100 }, answers }) };
    };
    const decision = makeModDecisionWithJev(state, { memory, apiKey: 'offline', fetchImpl });
    if (omitAnswer) await assert.rejects(decision, /invalid turn-plan comparison/);
    else {
      const result = await decision;
      assert.equal(sawMultiple, true);
      assert.ok(compared > 1);
      assert.equal(result.request.id, 'ARMAMENTS');
      assert.ok(result.planning_trace.some(item => item.stage === 'refine_pairs' && item.comparisons.length > 1));
    }
    assert.equal(memory.data.turn_plan, undefined);
    assert.equal(memory.data.pending, null);
  }
});

test('survival constraint wins over conflicting ordinary value; unknown or equal risk preserves value choice', () => {
  const pairs = [[{ value: 'a' }, { value: 'b' }]];
  const answers = { survival_0: { type: 'choice', choice: 'plan_b' }, comparison_0: { type: 'choice', choice: 'plan_a' } };
  assert.equal(resolvePlanComparisons(pairs, answers)[0].selected, 'b');
  assert.equal(resolvePlanComparisons(pairs, answers)[0].selection_basis, 'survival_constraint');
  answers.survival_0.choice = 'no_clear_difference';
  assert.equal(resolvePlanComparisons(pairs, answers)[0].selected, 'a');
  assert.equal(resolvePlanComparisons(pairs, answers)[0].selection_basis, 'overall_value');
  delete answers.comparison_0;
  assert.throws(() => resolvePlanComparisons(pairs, answers), /invalid turn-plan comparison/);
});

test('ordinary nonlethal comparisons cannot override value through a survival preference', () => {
  const state = stateWith([card('STRIKE_IRONCLAD', 'a', 0)]);
  assert.deepEqual(visibleSurvivalConstraints(state), []);
  const pairs = [[{ value: 'a' }, { value: 'b' }]];
  assert.deepEqual(Object.keys(planComparisonQuestions(pairs, 'Compare value.', false)), ['comparison_0']);
  const result = resolvePlanComparisons(pairs, { comparison_0: { type: 'choice', choice: 'plan_b' },
    survival_0: { type: 'choice', choice: 'plan_a' } }, false)[0];
  assert.equal(result.selected, 'b'); assert.equal(result.survival_assessment, null);
  state.combat.player.hp = 2;
  assert.ok(visibleSurvivalConstraints(state).some(c => c.kind === 'potential_lethal_health_loss'));
  state.combat.player.hp = 80;
  state.combat.enemies[0].powers.push({ id: 'DEADLINE_FIXTURE', amount: 2, description: 'In two turns, you die.' });
  assert.ok(visibleSurvivalConstraints(state).some(c => c.kind === 'explicit_loss_rule'));
});

test('upgrade modal follows the beneficiary chosen before preparation and confirms it before reviewing the suffix', async () => {
  const state = stateWith([card('ARMAMENTS', 'arm', 0, { name: 'Armaments', type: 'Skill', target_type: 'Self', description: 'Upgrade a card.' }), card('BASH', 'attack', 1, { name: 'Bash', cost: 2 })]);
  const memory = new DecisionMemory(); memory.observe(state);
  const plan = savedPlan(state, ['card_0', 'card_1_target_42', 'end_turn']);
  plan.steps[0].role = 'preparation'; plan.steps[0].beneficiary_instance_id = 'attack';
  memory.begin({ cmd: 'play_card', id: 'ARMAMENTS', nth: 0 }, state, { turnPlan: plan, turnStep: 0 });
  const modal = structuredClone(state); modal.screen = 'HAND_SELECT'; modal.combat.hand.shift(); modal.combat.hand[0].index = 0; modal.combat.hand[0].can_play = false; modal.combat.player.energy = 2;
  modal.hand_select = { mode: 'UpgradeSelect', prompt: 'Confirm Card to Upgrade', min_select: 1, max_select: 1, selected_count: 0, can_confirm: false, selectable_cards: [{ index: 0, card_id: 'BASH', card_name: 'Bash', description: 'Deal 6 damage.', cost: 2 }] }; sync(modal);
  memory.finish({ ok: true }, modal); memory.observe(modal);
  const chosen = await makeModDecisionWithJev(modal, { memory, fetchImpl: noModel });
  assert.equal(chosen.model, 'jev-turn-plan-selection');
  assert.deepEqual(chosen.request, { cmd: 'hand_select_card', card_ids: ['BASH'], nth_values: [0] });
  memory.begin(chosen.request, modal, { turnPlan: chosen.turn_plan });
  const confirm = structuredClone(modal); confirm.hand_select.selectable_cards = []; confirm.hand_select.selected_count = 1; confirm.hand_select.can_confirm = true;
  memory.finish({ ok: true }, confirm); memory.observe(confirm);
  const confirmDecision = await makeModDecisionWithJev(confirm, { memory, fetchImpl: noModel });
  assert.equal(confirmDecision.request.cmd, 'hand_confirm_selection');
  memory.begin(confirmDecision.request, confirm);
  const after = structuredClone(confirm); after.screen = 'COMBAT'; delete after.hand_select; after.combat.hand[0].description = 'Deal 9 damage.'; after.combat.hand[0].can_play = true; sync(after);
  memory.finish({ ok: true }, after); memory.observe(after);
  assert.equal(memory.data.turn_plan.cursor, 1);
  assert.equal(memory.data.turn_plan.status, 'needs_review');
  const seen = [];
  const next = await makeModDecisionWithJev(after, { memory, apiKey: 'offline', fetchImpl: fakeJev(['continue_plan'], seen) });
  assert.equal(next.request.id, 'BASH');
  assert.equal(seen.length, 1, 'Review reuses the existing sequence instead of choosing this card from scratch');
  assert.equal(seen[0].state.turn_plan.objective.id, 'damage');
  assert.equal(next.turn_plan.cursor, 1);
});

test('ambiguous old modal copies do not guess a planned beneficiary and another modal purpose cannot use upgrade intent', () => {
  const state = stateWith([card('STRIKE_IRONCLAD', 'a', 0), card('STRIKE_IRONCLAD', 'b', 1)]);
  const plan = savedPlan(state, ['card_0_target_42']); plan.cursor = 1; plan.steps[0].role = 'preparation'; plan.steps[0].beneficiary_instance_id = 'b';
  state.screen = 'HAND_SELECT'; state.hand_select = { mode: 'UpgradeSelect', min_select: 1, max_select: 1, selected_count: 0, can_confirm: false, selectable_cards: [0, 1].map(index => ({ index, card_id: 'STRIKE_IRONCLAD', card_name: 'Strike', cost: 1 })) };
  assert.equal(plannedUpgradeSelection(plan, state, buildModCandidates(state)), null);
  state.hand_select.selectable_cards.forEach((card, index) => card.details = { instance_id: ['a', 'b'][index] });
  assert.deepEqual(plannedUpgradeSelection(plan, state, buildModCandidates(state)).request.nth_values, [1]);
  state.combat.hand.shift(); state.hand_select.selectable_cards.shift(); state.hand_select.mode = 'ExhaustSelect';
  assert.equal(plannedUpgradeSelection(plan, state, buildModCandidates(state)), null);
});

test('draw results invalidate the suffix while retaining the objective and confirmed preparation', async () => {
  const state = stateWith([card('BATTLE_TRANCE', 'draw', 0, { target_type: 'Self', cost: 0, type: 'Skill', description: 'Draw 3 cards.' }), card('STRIKE_IRONCLAD', 'attack', 1)]);
  const memory = new DecisionMemory(); memory.observe(state);
  const plan = savedPlan(state, ['card_0', 'card_1_target_42', 'end_turn']);
  memory.begin({ cmd: 'play_card', id: 'BATTLE_TRANCE', nth: 0 }, state, { turnPlan: plan, turnStep: 0 });
  const after = structuredClone(state); after.combat.hand.shift(); after.combat.hand[0].index = 0; after.combat.hand.push(card('BASH', 'new', 1, { cost: 2 })); sync(after);
  memory.finish({ ok: true }, after); memory.observe(after);
  assert.match(memory.data.turn_plan.review_reasons.join(' '), /new or returned card/);
  const seen = [];
  const next = await makeModDecisionWithJev(after, { memory, apiKey: 'offline', fetchImpl: fakeJev(['revise_remaining', 'card_1_target_42', 'none', 'card_0_target_42'], seen) });
  assert.equal(next.turn_plan.objective.id, 'damage');
  assert.equal(next.turn_plan.revision, 1);
  assert.equal(next.turn_plan.completed_actions[0].request.id, 'BATTLE_TRANCE');
  assert.equal(next.request.id, 'BASH');
  assert.equal(seen.some(body => Object.hasOwn(body.questions.next_action?.criteria || {}, 'finish_combat')), false);
});

test('dead targets, missing cards, costs and external changes require review; next turns and runs do not inherit a plan', () => {
  const state = stateWith([card('STRIKE_IRONCLAD', 'one', 0), card('STRIKE_IRONCLAD', 'two', 1)]), plan = savedPlan(state, ['card_0_target_42', 'card_1_target_42', 'end_turn']);
  for (const change of [copy => copy.combat.enemies[0].is_alive = false, copy => copy.combat.hand.shift(), copy => copy.combat.hand[0].cost = 2, copy => copy.combat.player.hp--]) {
    const after = structuredClone(state); change(after); sync(after);
    assert.equal(inspectTurnPlan(plan, after, buildModCandidates(after)).kind, 'review');
  }
  const turn = structuredClone(state); turn.combat.turn_number++;
  assert.equal(inspectTurnPlan(plan, turn, buildModCandidates(turn)).kind, 'new_turn');
  const run = structuredClone(state); run.decision_context.run_id = 'other-run';
  assert.equal(inspectTurnPlan(plan, run, buildModCandidates(run)).kind, 'new_turn');
  const shuffled = structuredClone(state); shuffled.timestamp++; shuffled.combat.draw_pile.reverse();
  assert.equal(turnFingerprint(shuffled), turnFingerprint(state));
});

test('unknown command outcome never advances the plan or clears the pending action', () => {
  const state = stateWith([card('STRIKE_IRONCLAD', 'one', 0)]), memory = new DecisionMemory(); memory.observe(state);
  const plan = savedPlan(state, ['card_0_target_42', 'end_turn']);
  memory.begin({ cmd: 'play_card', id: 'STRIKE_IRONCLAD', nth: 0, target: 42 }, state, { turnPlan: plan, turnStep: 0 });
  memory.finish({ ok: false, error: 'TIMEOUT' }, state);
  assert.equal(memory.data.turn_plan.cursor, 0);
  assert.equal(memory.data.turn_plan.status, 'outcome_unknown');
  assert.equal(memory.data.pending.outcome_unknown, true);
  assert.throws(() => inspectTurnPlan(memory.data.turn_plan, state, buildModCandidates(state)), /unresolved/);
});

test('failed or invented planning answers commit no plan and dispatch no game command', async () => {
  const state = stateWith([card('STRIKE_IRONCLAD', 'one', 0)]), memory = new DecisionMemory(); memory.observe(state);
  for (const fetchImpl of [async () => ({ ok: false, status: 503, json: async () => ({}) }), async () => ({ ok: true, json: async () => ({ answers: { next_action: { type: 'choice', choice: 'invented' } } }) })]) {
    await assert.rejects(makeModDecisionWithJev(state, { memory, apiKey: 'offline', fetchImpl }));
    assert.equal(memory.data.turn_plan, undefined);
    assert.equal(memory.data.pending, null);
    assert.equal(memory.data.actions.length, 0);
  }
});

test('end-turn handoff checks actual remaining options and extends the same objective when a free draw was overlooked', async () => {
  const state = stateWith([card('FINESSE', 'draw', 0, { name: 'Finesse', type: 'Skill', target_type: 'Self', cost: 0, description: 'Gain 4 Block. Draw 1 card.' })], 1);
  const memory = new DecisionMemory(); memory.observe(state); memory.data.turn_plan = savedPlan(state, ['end_turn']);
  const seen = [], decision = await makeModDecisionWithJev(state, { memory, apiKey: 'offline', fetchImpl: fakeJev(['card_0'], seen) });
  assert.equal(seen.length, 1);
  assert.match(seen[0].state.turn_planning.phase_scope, /ACTUAL/);
  assert.equal(decision.request.id, 'FINESSE');
  assert.equal(decision.turn_plan.objective.id, 'damage');
  assert.equal(decision.turn_plan.revision, 1);
  assert.equal(decision.turn_plan.end_policy, 'observe_continuation_then_review');
  assert.equal(decision.turn_plan.steps.length, 1);
  assert.equal(memory.data.turn_plan.revision, 0, 'No new plan is committed before freshness validation');
});
