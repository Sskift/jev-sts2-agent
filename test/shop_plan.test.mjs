import test from 'node:test';
import assert from 'node:assert/strict';
import { withContext, fixtureCard } from './fixtures/context.mjs';
import { parseJevRequest } from './fixtures/jev.mjs';
import { buildModCandidates, makeModDecisionWithJev, prepareModDecision } from '../src/mod_decision.mjs';
import { DecisionMemory, groupCards } from '../src/decision_context.mjs';
import { compileModelRequest } from '../src/context_compiler.mjs';
import { shopEconomy } from '../src/shop_context.mjs';
import { shopRemovalBasis, plannedShopRemoval } from '../src/shop_plan_state.mjs';
import { buildStrategyKnowledge } from '../src/strategy_knowledge.mjs';
import { compareShopRemoval } from '../src/shop_plan.mjs';

const strike = (instance, extra = {}) => fixtureCard('STRIKE_IRONCLAD', { details: { instance_id: instance, upgrade_level: 0 }, ...extra });
function shop() {
  const state = withContext({ screen: 'SHOP', shop: { player_gold: 107, can_proceed: true,
    card_removal: { cost: 75, is_used: false }, cards: [
      { index: 0, card_id: 'IRON_WAVE', card_name: 'Iron Wave', description: 'Deal 5 damage. Gain 5 Block.', energy_cost: 1, cost: 48, is_stocked: true },
      { index: 1, card_id: 'ANGER', card_name: 'Anger', description: 'Deal 6 damage. Add a copy to your discard pile.', energy_cost: 0, cost: 24, is_stocked: true }
    ], relics: [], potions: [] } }, { master_deck: [strike('s0'), strike('s1'), strike('up', { name: 'Strike+', is_upgraded: true, description: 'Deal 9 damage.' }),
      fixtureCard('IRON_WAVE', { name: 'Iron Wave' }), fixtureCard('ETERNAL_CURSE', { keywords: ['Eternal'], type: 'Curse' })] });
  state.decision_context.player.gold = 107;
  return state;
}
function planFor(state) {
  const groups = groupCards(state.decision_context.master_deck);
  const index = groups.findIndex(g => g.count === 2);
  return { run_id: state.decision_context.run_id, floor: state.decision_context.total_floor,
    basis: shopRemovalBasis(state), deck_group_index: index, card: groups[index].card, instance_ids: groups[index].instance_ids, cost: 75 };
}
function gridFor(state) {
  const result = structuredClone(state); result.screen = 'GRID_CARD_SELECT'; delete result.shop;
  result.grid_card_select = { selection_type: 'remove', min_select: 1, max_select: 1, cancelable: true,
    cards: result.decision_context.master_deck.filter(c => !c.keywords.includes('Eternal')).map((c, index) => ({
      index, card_id: c.id, card_name: c.name, description: c.description, cost: c.cost, card_type: c.type })) };
  return result;
}

test('shop facts distinguish losing removal affordability from an affordable bundle, preserving exact copies', () => {
  const state = shop(), groups = groupCards(state.decision_context.master_deck);
  const facts = shopEconomy(state, groups, buildModCandidates(state));
  assert.equal(facts.removal.targets.length, 3);
  assert.ok(facts.removal.targets.some(t => t.copies_before === 2 && t.copies_after_removing_one === 1));
  assert.equal(facts.transactions[0].gold_after, 59);
  assert.equal(facts.transactions[0].forecloses_affordable_removal, true);
  assert.equal(facts.transactions[0].owned_copies_of_card_id, 1);
  assert.equal(facts.transactions[1].forecloses_affordable_removal, false);
  assert.equal(facts.transactions[1].gold_after_purchase_and_removal, 8);
  state.shop.card_removal.cost = 110;
  const costly = shopEconomy(state, groups, buildModCandidates(state));
  assert.equal(costly.removal.affordable, false);
  assert.equal(costly.transactions[0].forecloses_affordable_removal, false);
  delete state.shop.card_removal;
  assert.equal(shopEconomy(state, groups, buildModCandidates(state)).removal.offered, false);
  assert.ok(!buildModCandidates(state).has('remove_card'));
});

test('native unremovable cards, a used service and unknown eligibility cannot become a targeted removal', () => {
  const state = shop(); state.shop.card_removal.is_used = true;
  assert.ok(!buildModCandidates(state).has('remove_card'));
  state.shop.card_removal.is_used = false;
  state.decision_context.master_deck.forEach(c => c.keywords = ['Eternal']);
  assert.ok(!buildModCandidates(state).has('remove_card'));
  delete state.decision_context.master_deck[0].keywords;
  assert.equal(shopEconomy(state, groupCards(state.decision_context.master_deck), buildModCandidates(state)).removal.eligibility_unknown_groups.length, 1);
});

test('draw illustration is bounded arithmetic with explicit assumptions, never an opening-hand forecast', () => {
  const state = shop(); state.decision_context.master_deck = Array.from({ length: 25 }, (_, i) => strike(`s${i}`));
  const facts = shopEconomy(state, groupCards(state.decision_context.master_deck), buildModCandidates(state));
  assert.deepEqual(facts.draw_access_example.chance_to_see_one_retained_copy, { keep_deck: 5 / 25, remove_a_different_card: 5 / 24, add_a_different_card: 5 / 26 });
  assert.match(facts.draw_access_example.scope, /Not a prediction/);
});

test('shop analysis and conditional model intention compile into separate domains with lossless references', () => {
  const state = shop(), plan = planFor(state);
  const prepared = prepareModDecision(state, { shopRemovalPlan: plan });
  const compiled = compileModelRequest(prepared.payload);
  assert.ok(compiled.payload.state.analysis.shop_economy);
  assert.equal(compiled.payload.state.intent.shop_removal_planning.card.id, 'STRIKE_IRONCLAD');
  assert.equal(prepared.payload.state.screen_state.shop_removal_planning.deck_group_index, plan.deck_group_index);
});

test('one conditional target question precedes scoring and choice; buying remains legal and no removal is forced', async () => {
  for (const finalChoice of ['remove_card', 'buy_card_0']) {
    const state = shop(), memory = new DecisionMemory(); memory.observe(state);
    const requests = [];
    const decision = await makeModDecisionWithJev(state, { memory, runStrategy: false, apiKey: 'offline', fetchImpl: async (_url, request) => {
      const payload = parseJevRequest(request.body); requests.push(payload);
      let answers;
      if (payload.questions.removal_target) {
        const options = payload.questions.removal_target.criteria;
        assert.equal(Object.keys(options).length, 3);
        const choice = Object.keys(options).find(k => options[k].card.name === 'Strike');
        answers = { removal_target: { type: 'choice', choice, confidence: 0.8 } };
      } else if (payload.questions.budget_forward) {
        answers = Object.fromEntries(Object.entries(payload.questions).map(([key, q]) => [key,
          { type: 'choice', choice: Object.keys(q.criteria).find(k => q.criteria[k].action_id === finalChoice) }]));
      } else if (payload.questions.next_action) {
        assert.equal(payload.state.screen_state.shop_removal_planning.card.name, 'Strike');
        assert.ok(payload.questions.next_action.criteria.buy_card_0);
        answers = { next_action: { type: 'choice', choice: finalChoice } };
      } else {
        assert.equal(payload.state.screen_state.shop_removal_planning.card.name, 'Strike');
        answers = Object.fromEntries(Object.keys(payload.questions).map(k => [k, { type: 'score', score: 2 }]));
      }
      return { ok: true, json: async () => ({ model: 'offline', usage: { input_tokens: 100, output_tokens: 0 }, answers }) };
    } });
    assert.equal(requests.length, finalChoice === 'remove_card' ? 3 : 4);
    assert.equal(decision.usage.input_tokens, requests.length * 100);
    assert.equal(Boolean(decision.shop_removal_plan), finalChoice === 'remove_card');
    if (decision.shop_removal_plan) {
      const grid = gridFor(state);
      memory.begin(decision.request, state, { shopRemovalPlan: decision.shop_removal_plan });
      memory.finish({ ok: true }, grid);
      const followup = await makeModDecisionWithJev(grid, { memory, runStrategy: false, apiKey: 'offline', fetchImpl: () => { throw new Error('No second decision needed'); } });
      assert.equal(followup.model, 'jev-shop-plan-selection');
      assert.deepEqual(followup.request, { cmd: 'grid_select_card', card_ids: ['STRIKE_IRONCLAD'], nth_values: [0] });
      memory.begin(followup.request, grid); memory.finish({ ok: true }, state);
      assert.equal(memory.data.shop_removal_plan, undefined);
    }
  }
});

test('stale, failed and ambiguous plans cannot auto-select a different card', () => {
  const state = shop(), plan = planFor(state), grid = gridFor(state);
  assert.ok(plannedShopRemoval(plan, grid, buildModCandidates(grid)));
  grid.grid_card_select.selection_type = 'upgrade';
  assert.equal(plannedShopRemoval(plan, grid, buildModCandidates(grid)), null);
  grid.grid_card_select.selection_type = 'remove';
  grid.decision_context.master_deck[0].description = 'Changed rules';
  assert.equal(plannedShopRemoval(plan, grid, buildModCandidates(grid)), null);
  assert.throws(() => new DecisionMemory().begin({ cmd: 'shop_remove_card' }, grid, { shopRemovalPlan: plan }), /stale/);
  const ambiguous = shop(); ambiguous.decision_context.master_deck[1].details.enchantment = { id: 'SPECIAL', amount: 2 };
  const ambiguousPlan = { ...plan, basis: shopRemovalBasis(ambiguous) };
  assert.equal(plannedShopRemoval(ambiguousPlan, gridFor(ambiguous), buildModCandidates(gridFor(ambiguous))), null);
  const memory = new DecisionMemory(); memory.observe(state);
  memory.begin({ cmd: 'shop_remove_card' }, state, { shopRemovalPlan: plan });
  memory.finish({ ok: false, error: 'TIMEOUT' }, gridFor(state));
  assert.equal(memory.data.shop_removal_plan, undefined);
  assert.ok(memory.data.pending.outcome_unknown);
  state.shop.card_removal.cost = 100;
  assert.throws(() => prepareModDecision(state, { shopRemovalPlan: plan }), /Stale/);
});

test('exclusive-budget comparison requires agreement across reversed positions and skips affordable bundles', async () => {
  const state = shop(), plan = planFor(state);
  const prepared = prepareModDecision(state, { shopRemovalPlan: plan });
  const selected = id => ({ ...prepared.candidates.get(id), candidate_id: id, confidence: 0.4, probabilities: { [id]: 0.6 }, usage: { input_tokens: 100 } });
  for (const agree of [true, false]) {
    const decision = await compareShopRemoval(state, { shopRemovalPlan: plan }, prepared, selected('buy_card_0'), async (_s, _o, p) => {
      assert.equal(p.payload.questions.budget_forward.criteria.second.action_id, 'remove_card');
      assert.equal(p.payload.questions.budget_reverse.criteria.first.action_id, 'remove_card');
      return { ...p.parseResult({ answers: { budget_forward: { type: 'choice', choice: 'second' }, budget_reverse: { type: 'choice', choice: agree ? 'first' : 'second' } } }), usage: { input_tokens: 100 } };
    });
    assert.equal(decision.request.cmd, agree ? 'shop_remove_card' : 'shop_buy_card');
    assert.equal(decision.confidence, agree ? undefined : 0.4, 'Pairwise judgments must not masquerade as full-menu confidence');
    assert.equal(decision.shop_budget_comparison.consensus_action_id, agree ? 'remove_card' : null);
    assert.equal(decision.usage.input_tokens, 200);
  }
  const cheap = selected('buy_card_1');
  assert.equal(await compareShopRemoval(state, { shopRemovalPlan: plan }, prepared, cheap, () => { throw new Error('No comparison needed'); }), cheap);
});

test('removal guidance is scoped to shops and permanent removal, not combat discard choices', () => {
  const state = shop();
  assert.ok(buildStrategyKnowledge(state).general.some(n => n.id === 'remove_obsolete_jobs'));
  const grid = gridFor(state);
  assert.ok(buildStrategyKnowledge(grid).general.some(n => n.id === 'remove_obsolete_jobs'));
  grid.grid_card_select.selection_type = 'upgrade';
  assert.ok(!buildStrategyKnowledge(grid).general.some(n => n.id === 'remove_obsolete_jobs'));
});
