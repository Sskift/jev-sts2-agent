import test from 'node:test';
import assert from 'node:assert/strict';
import { DecisionMemory } from '../src/decision_context.mjs';
import { makeModDecisionWithJev, buildModCandidates } from '../src/mod_decision.mjs';
import { campUpgradeTargets, distinctCampUpgradeTargets, plannedCampSelection } from '../src/camp_plan_state.mjs';
import { campSurvivalFacts } from '../src/camp_context.mjs';
import { withContext, fixtureCard } from './fixtures/context.mjs';

function camp() {
  const deck = ['first', 'second'].map(instance_id => fixtureCard('STRIKE_IRONCLAD', { details: { instance_id, upgrade_level: 0, target_type: 'AnyEnemy' } }));
  const state = withContext({ screen: 'REST_SITE', rest_site: { options: [
    { option_id: 'HEAL', name: 'Rest', description: 'Heal 24 HP.', is_enabled: true },
    { option_id: 'SMITH', name: 'Smith', description: 'Upgrade a card.', is_enabled: true }
  ], can_proceed: false } }, { master_deck: deck, deck_upgrade_previews: deck.map((card, deck_index) => ({
    deck_index, instance_id: card.details.instance_id, card_id: card.id, name: 'Strike+', description: 'Deal 9 damage.', cost: 1
  })) });
  state.decision_context.map.nodes[0].type = 'REST_SITE';
  state.decision_context.map.nodes[1].type = 'MONSTER';
  return state;
}
function grid(state) {
  const after = structuredClone(state); after.screen = 'GRID_CARD_SELECT'; delete after.rest_site;
  after.grid_card_select = { selection_type: 'upgrade', min_select: 1, max_select: 1, cancelable: true,
    cards: after.decision_context.master_deck.map((card, index) => ({ index, card_id: card.id, card_name: card.name,
      description: card.description, cost: card.cost, upgrade_preview_name: 'Strike+', upgrade_preview: 'Deal 9 damage.', upgrade_preview_cost: 1 })) };
  return after;
}
async function decide(state, memory, finalChoice) {
  const requests = [];
  const result = await makeModDecisionWithJev(state, { memory, apiKey: 'fixture-only', fetchImpl: async (_url, request) => {
    const payload = JSON.parse(request.body); payload.state = JSON.parse(payload.state); requests.push(payload);
    const key = Object.keys(payload.questions)[0], choice = key === 'upgrade_target' ? 'upgrade_0' : finalChoice;
    if (key === 'upgrade_target') assert.deepEqual(Object.keys(payload.questions[key].criteria), ['upgrade_0']);
    if (key === 'next_action') {
      assert.equal(payload.state.intent.camp_planning.deck_index, 0);
      assert.deepEqual(payload.state.intent.camp_planning.equivalent_deck_indices, [0, 1]);
      assert.equal(payload.state.intent.camp_planning.after.description, 'Deal 9 damage.');
      assert.equal(payload.state.observation.screen_state.camp_planning, undefined);
      assert.equal(memory.data.pending, null, 'Planning has no dispatch side effects');
      assert.equal(memory.data.camp_upgrade_plan, undefined);
    }
    return { ok: true, json: async () => ({ model: 'jev-test', usage: { input_tokens: 10, output_tokens: 1 },
      answers: { [key]: { type: 'choice', choice, probabilities: { [choice]: 1 } } } }) };
  } });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].state.decision.output_role, 'unexecuted_plan_component');
  assert.equal(requests[0].state.decision.observation_id, requests[1].state.decision.observation_id);
  assert.equal(result.usage.input_tokens, 20);
  return result;
}

test('camp compares a concrete upgrade and follows its equivalent old-DTO copy only after confirmed Smith', async () => {
  const state = camp(), after = grid(state), memory = new DecisionMemory(); memory.observe(state);
  const result = await decide(state, memory, 'rest_SMITH');
  memory.begin(result.request, state, { campUpgradePlan: result.camp_upgrade_plan });
  assert.equal(memory.data.camp_upgrade_plan, undefined);
  memory.finish({ ok: true }, after); memory.observe(after);
  assert.equal(memory.data.actions[0].camp_upgrade_plan, undefined, 'Do not add plan copies to historical commands');
  const selected = await makeModDecisionWithJev(after, { memory, fetchImpl: () => { throw new Error('Existing concrete intention requires no new judgment'); } });
  assert.equal(selected.model, 'jev-camp-plan-selection');
  assert.deepEqual(selected.request, { cmd: 'grid_select_card', card_ids: ['STRIKE_IRONCLAD'], nth_values: [0] });
  memory.begin(selected.request, after); memory.finish({ ok: true }, state);
  assert.equal(memory.data.camp_upgrade_plan, undefined, 'Selection consumes the interaction intention');
});

test('camp grouping preserves native per-copy and upgrade differences without mutating observations', () => {
  const state = camp(), before = structuredClone(state);
  assert.equal(campUpgradeTargets(state).length, 2, 'Physical targets remain available for exact follow-through');
  assert.equal(distinctCampUpgradeTargets(state).length, 1);
  assert.deepEqual(state, before);
  state.decision_context.master_deck[1].details.enchantment = { id: 'SHARP', amount: 2 };
  assert.equal(distinctCampUpgradeTargets(state).length, 2, 'Full data, not card ID or face text, defines equivalence');
  delete state.decision_context.master_deck[1].details.enchantment;
  state.decision_context.deck_upgrade_previews[1].description = 'Deal 12 damage.';
  assert.equal(distinctCampUpgradeTargets(state).length, 2);
  state.decision_context.deck_upgrade_previews[1].instance_id = 'stale';
  assert.equal(distinctCampUpgradeTargets(state).length, 0, 'An incomplete snapshot cannot silently omit alternatives');
});

test('resting discards the hypothetical upgrade, and a failed Smith never authorizes it', async () => {
  const state = camp(), memory = new DecisionMemory(); memory.observe(state);
  const rest = await decide(state, memory, 'rest_HEAL');
  assert.equal(rest.camp_upgrade_plan, undefined);
  const smith = await decide(state, memory, 'rest_SMITH');
  memory.begin(smith.request, state, { campUpgradePlan: smith.camp_upgrade_plan });
  memory.finish({ ok: false, error: 'TIMEOUT' }, grid(state));
  assert.equal(memory.data.camp_upgrade_plan, undefined);
  assert.equal(memory.data.pending.outcome_unknown, true);
});

test('a known boss next receives exact heal arithmetic and a reversed rest-versus-upgrade review', async () => {
  const state = camp(), memory = new DecisionMemory();
  state.decision_context.player.hp = 32;
  state.rest_site.options[0].description = 'Heal for 30% of your Max HP (24).';
  state.decision_context.map.nodes[1].type = 'BOSS';
  const facts = campSurvivalFacts(state);
  assert.equal(facts.healing.hp_after, 56);
  assert.equal(facts.next_room.known_next_is_boss, true);
  memory.observe(state);
  const requests = [];
  const result = await makeModDecisionWithJev(state, { memory, runStrategy: false, apiKey: 'fixture-only', fetchImpl: async (_url, request) => {
    const payload = JSON.parse(request.body); payload.state = JSON.parse(payload.state); requests.push(payload);
    let answers;
    if (payload.questions.upgrade_target) answers = { upgrade_target: { type: 'choice', choice: 'upgrade_0' } };
    else if (payload.questions.next_action) {
      assert.equal(payload.state.observation.screen_state.rest_site.survival_tradeoff.healing.hp_after, 56);
      answers = { next_action: { type: 'choice', choice: 'rest_SMITH', confidence: 0.17 } };
    } else {
      assert.equal(payload.questions.boss_camp_forward.criteria.second.outcome.effective_hp_gain, 24);
      answers = { boss_camp_forward: { type: 'choice', choice: 'second' },
        boss_camp_reverse: { type: 'choice', choice: 'first' } };
    }
    return { ok: true, json: async () => ({ model: 'jev-test', usage: { input_tokens: 10, output_tokens: 1 }, answers }) };
  } });
  assert.equal(requests.length, 3);
  assert.equal(result.request.id, 'HEAL');
  assert.equal(result.camp_survival_comparison.consensus_action_id, 'rest_HEAL');
  assert.equal(result.camp_upgrade_plan, undefined);
  assert.equal(result.confidence, undefined);
  assert.equal(result.usage.input_tokens, 30);
});

test('very low HP before ordinary fights needs two-order evidence to Smith instead of Rest', async () => {
  for (const smithInReverse of [false, true]) {
    const state = camp(), memory = new DecisionMemory();
    state.decision_context.player.hp = 18;
    memory.observe(state);
    let calls = 0;
    const result = await makeModDecisionWithJev(state, { memory, runStrategy: false,
      apiKey: 'fixture-only', fetchImpl: async (_url, request) => {
        calls++;
        const payload = JSON.parse(request.body); payload.state = JSON.parse(payload.state);
        let answers;
        if (payload.questions.upgrade_target) answers = { upgrade_target: { type: 'choice', choice: 'upgrade_0' } };
        else if (payload.questions.next_action) answers = { next_action: { type: 'choice', choice: 'rest_SMITH' } };
        else {
          assert.equal(payload.state.observation.screen_state.rest_site.survival_tradeoff.healing.hp_after, 42);
          assert.match(payload.questions.low_hp_camp_forward.instructions, /bad opening hands/);
          answers = { low_hp_camp_forward: { type: 'choice', choice: 'first' },
            low_hp_camp_reverse: { type: 'choice', choice: smithInReverse ? 'second' : 'first' } };
        }
        return { ok: true, json: async () => ({ model: 'jev-test', answers }) };
      } });
    assert.equal(calls, 3);
    assert.equal(result.request.id, smithInReverse ? 'SMITH' : 'HEAL');
    assert.equal(result.camp_survival_comparison.reason, 'rest_at_least_doubles_current_hp');
    assert.equal(result.camp_upgrade_plan !== undefined, smithInReverse);
  }
});

test('camp intentions reject stale resources, changed previews and indistinguishable non-equivalent copies', () => {
  const state = camp(), target = campUpgradeTargets(state)[1], after = grid(state);
  const pick = view => plannedCampSelection(target, view, buildModCandidates(view));
  assert.ok(pick(after));
  after.decision_context.total_floor++;
  assert.equal(pick(after), null);
  after.decision_context.total_floor--; after.decision_context.player.hp--;
  assert.equal(pick(after), null);
  after.decision_context.player.hp++; after.grid_card_select.cards.forEach(card => card.upgrade_preview = 'Unexpected changed rule.');
  assert.equal(pick(after), null);
  state.decision_context.master_deck[0].details.enchantment = { id: 'HIDDEN_DIFFERENCE', amount: 1 };
  const differing = grid(state), differentTarget = campUpgradeTargets(state)[1];
  assert.equal(plannedCampSelection(differentTarget, differing, buildModCandidates(differing)), null);
  differing.grid_card_select.cards[1].details = { instance_id: 'second' };
  assert.deepEqual(plannedCampSelection(differentTarget, differing, buildModCandidates(differing)).request.nth_values, [1]);
});
