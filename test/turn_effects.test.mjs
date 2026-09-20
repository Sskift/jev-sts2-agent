import test from 'node:test';
import assert from 'node:assert/strict';
import { handUpgradeMode, preservesPlanDependencies } from '../src/turn_effects.mjs';
import { reserveSequence } from '../src/turn_projection.mjs';
import { refineTurnPlan } from '../src/turn_plan_refinement.mjs';
import { planStep } from '../src/turn_plan_state.mjs';
import { prepareModDecision } from '../src/mod_decision.mjs';
import { completeCombat, fixtureCard } from './fixtures/context.mjs';

test('future/random upgrades never invent a current hand-selection promise', () => {
  assert.equal(handUpgradeMode('Gain 5 Block. Upgrade a card in your Hand.'), 'one');
  assert.equal(handUpgradeMode('Gain 5 Block. Upgrade ALL cards in your Hand.'), 'all');
  assert.equal(handUpgradeMode('At the start of your turn, put a random Attack from your Discard Pile into your Hand and Upgrade it.'), null);
  assert.equal(handUpgradeMode('At the start of your turn, Upgrade a card in your Hand.'), null);
  assert.equal(handUpgradeMode('Upgrade a random card in your Hand.'), null);
});

test('two preceding attacks reserve the verified discounted Stomp cost without changing the card', () => {
  const state = completeCombat(); state.combat.player.energy = 3;
  state.combat.hand = [fixtureCard('A', { cost: 1 }), fixtureCard('B', { cost: 1 }), fixtureCard('STOMP', { cost: 3 })];
  const steps = ['A', 'B', 'STOMP'].map(id => ({ kind: 'play_card', card_instance_id: id }));
  assert.deepEqual(reserveSequence(state, steps), { energy_left: 0, costs: [1, 1, 1] });
  assert.equal(state.combat.hand[2].cost, 3);
  assert.equal(reserveSequence(state, [steps[2], steps[0]]), null);
});

test('whole-plan alternatives preserve the intended next-card consumer', async () => {
  const state = completeCombat(); state.combat.player.energy = 3;
  state.combat.hand.push(fixtureCard('ANGER', { index: 1, name: 'Anger', target_type: 'AnyEnemy', can_play: true, cost: 0, description: 'Deal 6 damage.', target_previews: [{ target_id: 42, damage: 6 }] }));
  state.combat.player.hand_count = 2;
  state.combat.player.potions = [{ id: 'DUPLICATOR', name: 'Duplicator', slot: 0, can_use: true, target_type: 'Self', description: 'This turn, your next card is played an extra time.' }];
  state.decision_context.player = structuredClone(state.combat.player);
  const prepared = prepareModDecision(state);
  const potion = planStep(state, prepared.candidates.get('potion_0'), 'preparation'); potion.next_card_instance_id = 'STRIKE_IRONCLAD';
  const strike = planStep(state, prepared.candidates.get('card_0_target_42'));
  const anger = planStep(state, prepared.candidates.get('card_1_target_42'));
  const end = planStep(state, prepared.candidates.get('end_turn'), 'finish_turn');
  assert.equal(preservesPlanDependencies([potion, anger, strike, end]), false);
  assert.equal(preservesPlanDependencies([anger, potion, strike, end]), true);
  const plan = { steps: [potion, strike, end], retained_cards: [], end_policy: 'end_after_steps_unless_conditions_change', budget: { remaining_after_printed_costs: 2 } };
  let comparisons = 0;
  await refineTurnPlan(state, plan, prepared, async (_stage, _instructions, choices) => {
    comparisons++;
    for (const { label } of Object.values(choices)) {
      const names = label.ordered_sequence.map(step => step.action);
      assert.equal(names[names.indexOf('Duplicator') + 1], 'Strike');
    }
    return 'keep';
  });
  assert.ok(comparisons > 0);
  assert.equal(plan.steps.length, 3);
});
