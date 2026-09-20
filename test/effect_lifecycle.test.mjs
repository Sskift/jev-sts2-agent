import test from 'node:test';
import assert from 'node:assert/strict';
import { completeCombat } from './fixtures/context.mjs';
import { describeCombatEffects, describeEffectLifecycle, uncomputedTurnEndHealthEffects } from '../src/effect_lifecycle.mjs';
import { combatForecast } from '../src/combat_arithmetic.mjs';
import { describeTurnProjection } from '../src/turn_projection.mjs';
import { prepareModDecision } from '../src/mod_decision.mjs';
import { compileModelRequest } from '../src/context_compiler.mjs';
import { describePlanAlternative } from '../src/turn_plan_refinement.mjs';

test('automatic revival is armed while held and invalidates summed lethal damage without overriding forced death', () => {
  const s = completeCombat();
  s.combat.player.hp = 5;
  s.combat.player.potions = [{ id: 'FAIRY_IN_A_BOTTLE', name: 'Fairy in a Bottle', slot: 0, usage: 'Automatic', can_use: false, target_type: 'Self', rarity: 'Rare', valid_target_ids: [0],
    description: 'When your HP would be reduced to 0, instead this potion is discarded and you heal to 30% of your Max HP.' }];
  const before = structuredClone(s), effect = describeCombatEffects(s.combat).effects.find(e => e.source_id === 'FAIRY_IN_A_BOTTLE');
  assert.equal(effect.active, true); assert.equal(effect.activation, 'already_present');
  const forecast = combatForecast(s.combat);
  assert.equal(forecast.hp_remaining_if_end_turn, null); assert.equal(forecast.fatal_if_end_turn, null);
  assert.equal(forecast.uncomputed_death_prevention[0].potion_slot, 0);
  const end = [{ kind: 'end_turn' }], plan = describePlanAlternative(s, end);
  assert.equal(plan.conditional_preview.known_effects_only.hp_if_ending, null);
  assert.equal(plan.conditional_preview.calculation_status, 'incomplete');
  assert.deepEqual(plan.resource_consequences.potions_still_available, []);
  assert.deepEqual(plan.resource_consequences.automatic_potions_held_until_triggered, [{ id: 'FAIRY_IN_A_BOTTLE', slot: 0 }]);
  assert.deepEqual(plan.resource_consequences.potions_consumed_if_death_prevention_triggers, [{ id: 'FAIRY_IN_A_BOTTLE', slot: 0 }]);
  const harm = combatForecast(s.combat, { cost: 0, hp_loss: 6 });
  assert.equal(harm.hp_remaining_after_declared_loss, null); assert.equal(harm.fatal_from_declared_hp_loss, null);
  assert.deepEqual(s, before);
  s.decision_context.player = structuredClone(s.combat.player);
  const prepared = prepareModDecision(s);
  prepared.payload.state.turn_planning = { phase_scope: 'Death-prevention fixture', conditional_projection: plan.conditional_preview,
    energy_reservation: { observed_energy: s.combat.player.energy, remaining_after_printed_costs: s.combat.player.energy, is_observed: false, includes_future_energy_gains: false, steps: [], scope: 'No prefix' } };
  assert.doesNotThrow(() => compileModelRequest(prepared.payload));
  s.combat.enemies[0].powers.push({ id: 'SANDPIT_POWER', amount: 1 });
  assert.equal(combatForecast(s.combat).fatal_if_end_turn, true, 'Sandpit force:true bypasses the Fairy');
  s.combat.enemies[0].powers.pop(); s.combat.player.hp = 50;
  assert.equal(combatForecast(s.combat).uncomputed_death_prevention, undefined, 'Nonlethal arithmetic remains useful');
  s.combat.player.potions = [];
  s.combat.player.hp = 5;
  assert.equal(combatForecast(s.combat).fatal_if_end_turn, true, 'An absent/consumed Fairy cannot be reused');
});

test('an uncomputed current turn-end health rule invalidates endpoint claims without hiding current attack or immediate Block', () => {
  const s = completeCombat();
  s.combat.player.powers = [{ id: 'CONSTRICT_POWER', amount: 3, description: 'While the Slithering Strangler is alive, at the end of your turn, take 3 damage.' }];
  s.decision_context.player = structuredClone(s.combat.player);
  const before = structuredClone(s), f = combatForecast(s.combat);
  assert.equal(f.hp_remaining_if_end_turn, null);
  assert.equal(f.fatal_if_end_turn, null);
  assert.equal(f.block_after_card, s.combat.player.block);
  assert.equal(f.displayed_attacks_after_target_depletion, 12);
  assert.equal(f.uncomputed_turn_end_effects[0].condition_evaluated, false);
  const projection = describeTurnProjection(s, [{ kind: 'end_turn' }]);
  assert.equal(projection.known_effects_only.hp_if_ending, null);
  assert.equal(projection.uncomputed_turn_end_effects[0].source_id, 'CONSTRICT_POWER');
  const prepared = prepareModDecision(s);
  prepared.payload.state.turn_planning = { phase_scope: 'End-turn fixture', energy_reservation: {
    observed_energy: s.combat.player.energy, remaining_after_printed_costs: s.combat.player.energy, scope: 'No prefix', is_observed: false, includes_future_energy_gains: false, steps: [] }, conditional_projection: projection };
  assert.doesNotThrow(() => compileModelRequest(prepared.payload));
  assert.deepEqual(s, before);
});

test('timed effect discovery is rule-based and excludes already counted Toxic and unrelated/end-of-combat rules', () => {
  const s = completeCombat();
  s.combat.player.powers = [{ id: 'UNKNOWN_HEAL', description: 'At the end of your turn, heal 2 HP if a condition holds.' },
    { id: 'PLATING_POWER', amount: 3, description: 'At the end of your turn, gain 3 Block.' }];
  s.combat.player.relics = [{ id: 'BURNING_BLOOD', description: 'At the end of combat, heal 6 HP.' }];
  const toxic = { id: 'TOXIC', description: 'At the end of your turn, take 2 damage.' };
  assert.deepEqual(uncomputedTurnEndHealthEffects(s.combat, [toxic]).map(e => e.source_id), ['UNKNOWN_HEAL']);
  assert.equal(uncomputedTurnEndHealthEffects(s.combat, [{ ...toxic, id: 'UNMODELED_CARD' }]).length, 2);
});

test('pile-dependent automatic plays distinguish current hand, exhaust and an unknown draw-pile top', () => {
  const s = completeCombat();
  const howl = { ...s.combat.hand[0], index: 1, can_play: false, id: 'HOWL_FROM_BEYOND', name: 'Howl from Beyond', cost: 3,
    description: 'Deal 18 damage to ALL enemies. At the end of your turn, if this is in your Exhaust Pile, play it.', details: { instance_id: 'howl' } };
  s.combat.hand.push(howl);
  s.combat.player.hand_count++;
  s.decision_context.player = structuredClone(s.combat.player);
  const before = structuredClone(s);
  assert.equal(combatForecast(s.combat).hp_remaining_if_end_turn, 28, 'A hand-only Howl cannot auto-play from Exhaust');
  const inactive = describeCombatEffects(s.combat).effects.find(e => e.source_id === howl.id);
  assert.equal(inactive.active, false);
  assert.equal(inactive.activation, 'enters_required_pile');
  assert.equal(inactive.observed_pile, 'hand');
  assert.equal(inactive.required_pile, 'exhaust_pile');
  assert.doesNotThrow(() => compileModelRequest(prepareModDecision(s).payload));
  assert.deepEqual(s, before);
  s.combat.hand.pop(); s.combat.exhaust_pile.push(howl);
  s.combat.player.hand_count--; s.combat.player.exhaust_count++;
  s.decision_context.player = structuredClone(s.combat.player);
  const end = combatForecast(s.combat);
  assert.equal(end.hp_remaining_if_end_turn, null, 'An armed automatic attack is not simulated as zero damage');
  assert.equal(end.uncomputed_turn_end_effects[0].observed_pile, 'exhaust_pile');
  assert.equal(end.uncomputed_turn_end_effects[0].condition_evaluated, true);
  assert.equal(describeCombatEffects(s.combat).effects.find(e => e.source_id === howl.id).active, true);
  const projection = describeTurnProjection(s, [{ kind: 'end_turn' }]);
  assert.equal(projection.known_effects_only.hp_if_ending, null);
  const prepared = prepareModDecision(s);
  prepared.payload.state.turn_planning = { phase_scope: 'Pile trigger fixture', energy_reservation: {
    observed_energy: 2, remaining_after_printed_costs: 2, scope: 'No prefix', is_observed: false, includes_future_energy_gains: false, steps: [] }, conditional_projection: projection };
  assert.doesNotThrow(() => compileModelRequest(prepared.payload));
  s.combat.exhaust_pile.pop(); s.combat.draw_pile.push({ ...howl, id: 'I_AM_INVINCIBLE', type: 'Skill',
    description: 'Gain 10 Block. At the end of your turn, if this is on top of your Draw Pile, play it.' });
  const unknownTop = combatForecast(s.combat);
  assert.equal(unknownTop.hp_remaining_if_end_turn, null);
  assert.equal(unknownTop.uncomputed_turn_end_effects[0].condition_evaluated, false);
  s.combat.discard_pile.push(s.combat.draw_pile.pop());
  assert.equal(combatForecast(s.combat).hp_remaining_if_end_turn, 28);
});

test('an expiring bonus reports the declared consumer and distinguishes an unresolved draw from a complete ending', () => {
  const s = completeCombat();
  const setup = { ...s.combat.hand[0], id: 'ONE_TWO_PUNCH', type: 'Skill', description: 'This turn, your next Attack is played an extra time.', details: { instance_id: 'setup' } };
  s.combat.hand.push(setup);
  const prep = { kind: 'play_card', card_id: setup.id, card_instance_id: 'setup', card_type: 'Skill', rules_at_planning: setup.description };
  const hit = { kind: 'play_card', card_id: 'STRIKE_IRONCLAD', card_instance_id: 'hit', card_type: 'Attack', name: 'Strike' };
  const finish = { kind: 'end_turn' };
  let p = describeEffectLifecycle(s, [prep, finish]);
  assert.equal(p.next_card_triggers[0].declared_manual_consumers, 0);
  assert.equal(p.next_card_triggers[0].plan_reaches_end_turn, true);
  assert.equal(describeEffectLifecycle(s, [prep, hit, finish]).next_card_triggers[0].first_consumer.card_id, hit.card_id);
  assert.equal(describeEffectLifecycle(s, [hit, prep, finish]).next_card_triggers[0].declared_manual_consumers, 0);
  p = describeEffectLifecycle(s, [prep, { kind: 'play_card', rules_at_planning: 'Draw 2 cards.' }]);
  assert.equal(p.next_card_triggers[0].possible_new_consumer_requires_observation, true);
  assert.equal(p.next_card_triggers[0].plan_reaches_end_turn, false);
  s.combat.player.powers.push({ id: 'NEXT_ATTACK', description: 'Your next Attack is played an extra time this turn.' });
  assert.equal(describeEffectLifecycle(s, [hit, finish]).next_card_triggers[0].source_category, 'active_power');
});

test('native timing distinguishes opposing-turn retaliation from expiring next-Attack buffs and never imports Wiki example amounts', () => {
  const s = completeCombat();
  s.combat.player.powers = [
    { id: 'FLAME_BARRIER_POWER', amount: 9, description: 'Whenever you are attacked this turn, deal 9 damage back.' },
    { id: 'ONE_TWO_PUNCH_POWER', amount: 2, description: 'Your next 2 Attacks are played an extra time this turn.' },
    { id: 'UNRECOGNIZED_POWER', amount: 7, description: 'At the end of your turn, something unknown happens.' }
  ];
  const effects = describeCombatEffects(s.combat).effects;
  assert.equal(effects[0].current_amount, 9);
  assert.equal(effects[0].expires, 'opposing_side_turn_end');
  assert.equal(effects[1].expires, 'owner_turn_end_or_consumption');
  assert.equal(effects[2].timing_coverage, 'live_rule_only_do_not_assume_no_effect');
  const hit = { kind: 'play_card', card_type: 'Attack', card_id: 'STRIKE_IRONCLAD' };
  const bonus = describeEffectLifecycle(s, [hit, hit, { kind: 'end_turn' }]).next_card_triggers[0];
  assert.equal(bonus.declared_manual_consumers, 2);
  assert.equal(bonus.unused_triggers_at_declared_end, 0);
});

test('a unique live Constrict source and held Burn are counted after early Block; ambiguous appliers stay unknown', () => {
  const s = completeCombat(), c = s.combat;
  Object.assign(c.player, { hp: 51, block: 5 });
  c.player.powers = [{ id: 'CONSTRICT_POWER', amount: 3, description: 'While the Slithering Strangler is alive, at the end of your turn, take 3 damage.' }];
  Object.assign(c.enemies[0], { id: 'SLITHERING_STRANGLER', intents: [{ type: 'Attack', damage: 7, hits: 1 }] });
  assert.equal(combatForecast(c).hp_remaining_if_end_turn, 46);
  c.hand.push({ id: 'BURN', index: 99, damage: 2, description: 'At the end of your turn, if this is in your Hand, take 2 damage.' });
  assert.equal(combatForecast(c).hp_remaining_if_end_turn, 44);
  c.player.powers.push({ id: 'PLATING_POWER', amount: 4 });
  assert.equal(combatForecast(c).hp_remaining_if_end_turn, 48);
  c.enemies.push({ ...structuredClone(c.enemies[0]), combat_id: 43 });
  assert.equal(combatForecast(c).hp_remaining_if_end_turn, null);
});

test('reaction endpoint names survive the same lossless text references used in large planning requests', () => {
  const s = completeCombat();
  s.combat.enemies[0].powers = [{ id: 'THORNS_POWER', amount: 3, description: 'Whenever attacked, deal 3 damage back.' }];
  const projection = describeTurnProjection(s, [{ kind: 'play_card', card_instance_id: 'STRIKE_IRONCLAD', target: 42 }, { kind: 'end_turn' }]);
  assert.equal(projection.known_effects_only.hp_if_ending, null);
  projection.uncomputed_reactions[0].affected_outputs[3] = { text_ref: 't999' };
  const prepared = prepareModDecision(s);
  prepared.payload.state.text_dictionary = { t999: 'remaining_incoming_attack' };
  prepared.payload.state.turn_planning = { phase_scope: 'Reaction fixture', energy_reservation: {
    observed_energy: 2, remaining_after_printed_costs: 2, scope: 'No reserved prefix', is_observed: false, includes_future_energy_gains: false, steps: [] }, conditional_projection: projection };
  assert.doesNotThrow(() => compileModelRequest(prepared.payload));
});
