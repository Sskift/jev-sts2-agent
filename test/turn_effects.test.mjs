import test from 'node:test';
import assert from 'node:assert/strict';
import { handUpgradeMode, nextCardKind, preservesPlanDependencies } from '../src/turn_effects.mjs';
import { reserveSequence } from '../src/turn_projection.mjs';
import { refineTurnPlan } from '../src/turn_plan_refinement.mjs';
import { planStep } from '../src/turn_plan_state.mjs';
import { prepareModDecision } from '../src/mod_decision.mjs';
import { completeCombat, fixtureCard } from './fixtures/context.mjs';

const refineWithScores = (state, plan, prepared, score) => refineTurnPlan(state, plan, prepared,
  async pairs => pairs.map(pair => pair.toSorted((a, b) => score(b) - score(a))[0].value),
  async items => items.map(item => ({ value: item.value, score: score(item) })));

test('future/random upgrades never invent a current hand-selection promise', () => {
  assert.equal(handUpgradeMode('Gain 5 Block. Upgrade a card in your Hand.'), 'one');
  assert.equal(handUpgradeMode('Gain 5 Block. Upgrade ALL cards in your Hand.'), 'all');
  assert.equal(handUpgradeMode('At the start of your turn, put a random Attack from your Discard Pile into your Hand and Upgrade it.'), null);
  assert.equal(handUpgradeMode('At the start of your turn, Upgrade a card in your Hand.'), null);
  assert.equal(handUpgradeMode('Upgrade a random card in your Hand.'), null);
});

test('a next-Attack preparation permits intervening skills but rejects a different attacking consumer', () => {
  assert.equal(nextCardKind('This turn, your next Attack is played an extra time.'), 'Attack');
  assert.equal(nextCardKind('Next turn, your next Attack is played an extra time.'), null);
  const prep = { kind: 'play_card', card_type: 'Skill', card_instance_id: 'prep', next_card_instance_id: 'payoff', next_card_type: 'Attack' };
  const skill = { kind: 'play_card', card_type: 'Skill', card_instance_id: 'block' };
  const attack = { kind: 'play_card', card_type: 'Attack', card_instance_id: 'strike' };
  const payoff = { kind: 'play_card', card_type: 'Attack', card_instance_id: 'payoff' };
  assert.equal(preservesPlanDependencies([prep, skill, payoff, attack]), true);
  assert.equal(preservesPlanDependencies([prep, attack, skill, payoff]), false);
  assert.equal(preservesPlanDependencies([prep, skill]), false);
});

test('two preceding attacks reserve the verified discounted Stomp cost without changing the card', () => {
  const state = completeCombat(); state.combat.player.energy = 3;
  state.combat.hand = [fixtureCard('A', { cost: 1 }), fixtureCard('B', { cost: 1 }), fixtureCard('STOMP', { cost: 3 })];
  const steps = ['A', 'B', 'STOMP'].map(id => ({ kind: 'play_card', card_instance_id: id }));
  assert.deepEqual(reserveSequence(state, steps), { energy_left: 0, costs: [1, 1, 1] });
  assert.equal(state.combat.hand[2].cost, 3);
  assert.equal(reserveSequence(state, [steps[2], steps[0]]), null);
});

test('whole-plan alternatives keep their declared next-card binding consistent with the offered order', async () => {
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
  await refineWithScores(state, plan, prepared, ({ label }) => {
    comparisons++;
    const names = label.ordered_sequence.map(step => step.action);
    const trigger = label.ordered_sequence.find(s => s.action === 'Duplicator');
    if (trigger?.intended_followthrough) assert.equal(names[names.indexOf('Duplicator') + 1], trigger.intended_followthrough);
    return 2;
  });
  assert.ok(comparisons > 0);
  assert.equal(plan.steps.length, 3);
});

test('whole-plan substitutions can replace an expensive kill and use released energy without replaying a card', async () => {
  const state = completeCombat(); state.combat.player.energy = 3;
  state.combat.enemies[0].hp = 14;
  state.combat.hand = [
    fixtureCard('S1', { index: 0, name: 'Strike A', cost: 1, damage: 8, description: 'Deal 8 damage.', target_type: 'AnyEnemy', can_play: true, target_previews: [{ target_id: 42, damage: 8 }] }),
    fixtureCard('S2', { index: 1, name: 'Strike B', cost: 1, damage: 8, description: 'Deal 8 damage.', target_type: 'AnyEnemy', can_play: true, target_previews: [{ target_id: 42, damage: 8 }] }),
    fixtureCard('BASH', { index: 2, name: 'Bash', cost: 2, damage: 10, description: 'Deal 10 damage. Apply 2 Vulnerable.', target_type: 'AnyEnemy', can_play: true, target_previews: [{ target_id: 42, damage: 10 }] }),
    fixtureCard('DEFEND', { index: 3, name: 'Defend', cost: 1, type: 'Skill', block: 5, description: 'Gain 5 Block.', target_type: 'Self', can_play: true })
  ];
  state.combat.player.hand_count = 4; state.decision_context.player = structuredClone(state.combat.player);
  const prepared = prepareModDecision(state), end = planStep(state, prepared.candidates.get('end_turn'), 'finish_turn');
  const plan = { steps: [planStep(state, prepared.candidates.get('card_0_target_42')), planStep(state, prepared.candidates.get('card_2_target_42')), end], retained_cards: [], end_policy: 'end_after_steps_unless_conditions_change', budget: { remaining_after_printed_costs: 0 } };
  let sawCheapKill = false, sawDefense = false;
  await refineWithScores(state, plan, prepared, choice => {
    const names = choice.label.ordered_sequence.map(step => step.action);
    assert.equal(choice.label.energy_spent + choice.label.energy_left, state.combat.player.energy);
    for (const enemy of choice.label.conditional_preview.known_effects_only.enemies) {
      if (enemy.hp === null) {
        assert.equal(enemy.hp_removed, null, 'An uncomputed debuff dependency must not invent a point estimate');
        continue;
      }
      assert.equal(enemy.hp_removed + enemy.hp, state.combat.enemies.find(original => original.combat_id === enemy.combat_id).hp);
      assert.equal(enemy.block_removed + enemy.block, state.combat.enemies.find(original => original.combat_id === enemy.combat_id).block);
    }
    assert.equal(new Set(names).size, names.length, 'No physical card is planned twice');
    if (names.includes('Strike A') && names.includes('Strike B') && !names.includes('Bash')) {
      sawCheapKill = true;
      if (names.includes('Defend')) sawDefense = true;
      return names.includes('Defend') ? 2 : 1;
    }
    return 0;
  });
  assert.equal(sawCheapKill, true);
  assert.equal(sawDefense, true);
  assert.deepEqual(plan.steps.map(step => step.name).filter(Boolean).sort(), ['Defend', 'Strike A', 'Strike B']);
  assert.equal(plan.budget.remaining_after_printed_costs, 0);
});

test('independent alternatives compare different defenses without needing a second greedy refinement pass', async () => {
  const state = completeCombat(); state.combat.player.energy = 3;
  state.combat.enemies[0].hp = 14;
  state.combat.hand = [
    fixtureCard('S1', { index: 0, name: 'Strike A', cost: 1, damage: 8, description: 'Deal 8 damage.', target_type: 'AnyEnemy', can_play: true, target_previews: [{ target_id: 42, damage: 8 }] }),
    fixtureCard('S2', { index: 1, name: 'Strike B', cost: 1, damage: 8, description: 'Deal 8 damage.', target_type: 'AnyEnemy', can_play: true, target_previews: [{ target_id: 42, damage: 8 }] }),
    fixtureCard('BASH', { index: 2, name: 'Bash', cost: 2, damage: 10, description: 'Deal 10 damage. Apply 2 Vulnerable.', target_type: 'AnyEnemy', can_play: true, target_previews: [{ target_id: 42, damage: 10 }] }),
    fixtureCard('DEFEND', { index: 3, name: 'Defend', cost: 1, type: 'Skill', block: 5, description: 'Gain 5 Block.', target_type: 'Self', can_play: true }),
    fixtureCard('EVIL_EYE', { index: 4, name: 'Evil Eye', cost: 1, type: 'Skill', block: 8, description: 'Gain 8 Block.', target_type: 'Self', can_play: true })
  ];
  state.combat.player.hand_count = 5; state.decision_context.player = structuredClone(state.combat.player);
  const prepared = prepareModDecision(state), end = planStep(state, prepared.candidates.get('end_turn'), 'finish_turn');
  const plan = { steps: [planStep(state, prepared.candidates.get('card_0_target_42')), planStep(state, prepared.candidates.get('card_2_target_42')), end], retained_cards: [], end_policy: 'end_after_steps_unless_conditions_change', budget: { remaining_after_printed_costs: 0 } };
  const offered = new Set();
  await refineWithScores(state, plan, prepared, choice => {
    const names = choice.label.ordered_sequence.map(step => step.action).sort().join(',');
    offered.add(names);
    return names === 'Evil Eye,Strike A,Strike B' ? 3 : 1;
  });
  assert.ok(offered.has('Defend,Strike A,Strike B') && offered.has('Evil Eye,Strike A,Strike B'));
  assert.deepEqual(plan.steps.map(step => step.name).filter(Boolean).sort(), ['Evil Eye', 'Strike A', 'Strike B']);
});
