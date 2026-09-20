import test from 'node:test';
import assert from 'node:assert/strict';
import { DecisionMemory } from '../src/decision_context.mjs';
import { makeModDecisionWithJev, buildModCandidates } from '../src/mod_decision.mjs';
import { campUpgradeTargets, plannedCampSelection } from '../src/camp_plan_state.mjs';
import { withContext, fixtureCard } from './fixtures/context.mjs';

function camp() {
  const deck = ['first', 'second'].map(instance_id => fixtureCard('STRIKE_IRONCLAD', { details: { instance_id, upgrade_level: 0, target_type: 'AnyEnemy' } }));
  return withContext({ screen: 'REST_SITE', rest_site: { options: [
    { option_id: 'HEAL', name: 'Rest', description: 'Heal 24 HP.', is_enabled: true },
    { option_id: 'SMITH', name: 'Smith', description: 'Upgrade a card.', is_enabled: true }
  ], can_proceed: false } }, { master_deck: deck, deck_upgrade_previews: deck.map((card, deck_index) => ({
    deck_index, instance_id: card.details.instance_id, card_id: card.id, name: 'Strike+', description: 'Deal 9 damage.', cost: 1
  })) });
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
    const key = Object.keys(payload.questions)[0], choice = key === 'upgrade_target' ? 'upgrade_1' : finalChoice;
    if (key === 'next_action') {
      assert.equal(payload.state.intent.camp_planning.deck_index, 1);
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
