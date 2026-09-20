import test from 'node:test';
import assert from 'node:assert/strict';
import { completeCombat, fixtureCard } from './fixtures/context.mjs';
import { inspectSequence } from '../src/turn_sequence.mjs';
import { describeTurnProjection, reserveSequence } from '../src/turn_projection.mjs';
import { prepareModDecision } from '../src/mod_decision.mjs';
import { compileModelRequest } from '../src/context_compiler.mjs';
import { combatForecast } from '../src/combat_arithmetic.mjs';
import { describePlanAlternative } from '../src/turn_plan_refinement.mjs';

const play = (id, target) => ({ kind: 'play_card', card_instance_id: id, target });
const potion = id => ({ kind: 'use_potion', potion_id: id, slot: 0 });
const end = { kind: 'end_turn' };
function combat() {
  const s = completeCombat();
  s.combat.player.energy = 3;
  s.combat.hand[0].target_previews = [{ target_id: 42, damage: 6 }];
  s.combat.enemies[0].hp = 50;
  s.combat.hand.push(fixtureCard('DEFEND_IRONCLAD', { index: 1, type: 'Skill', description: 'Gain 5 Block.', block: 5,
    upgrade_preview: { description: 'Gain 8 Block.', name: 'Defend+', cost: 1 } }));
  return s;
}

test('potion modifiers apply only to subsequent matching actions, without changing observed previews', () => {
  const s = combat();
  s.combat.player.potions = [{ id: 'STRENGTH_POTION', slot: 0, description: 'Gain 2 Strength.' }];
  const before = structuredClone(s), hit = play('STRIKE_IRONCLAD', 42);
  const early = describeTurnProjection(s, [potion('STRENGTH_POTION'), hit, end]);
  const late = describeTurnProjection(s, [hit, potion('STRENGTH_POTION'), end]);
  assert.equal(early.known_effects_only.enemies[0].hp_removed, 8);
  assert.equal(late.known_effects_only.enemies[0].hp_removed, 6);
  s.combat.player.potions[0] = { id: 'SPEED_POTION', slot: 0, description: 'Gain 5 Dexterity. At the end of your turn, lose 5 Dexterity.' };
  const defend = play('DEFEND_IRONCLAD');
  assert.equal(describeTurnProjection(s, [potion('SPEED_POTION'), defend]).known_effects_only.block, 10);
  assert.equal(describeTurnProjection(s, [defend, potion('SPEED_POTION')]).known_effects_only.block, 5);
  assert.deepEqual(s.combat.hand, before.combat.hand);
});

test('inspection uses the intended hand upgrade and rejects a target already played', () => {
  const s = combat();
  s.combat.hand.push(fixtureCard('ARMAMENTS', { index: 2, type: 'Skill', description: 'Gain 5 Block. Upgrade a card in your Hand.', block: 5 }));
  const upgrade = { ...play('ARMAMENTS'), beneficiary_instance_id: 'DEFEND_IRONCLAD' }, defend = play('DEFEND_IRONCLAD');
  assert.equal(describeTurnProjection(s, [upgrade, defend, end]).known_effects_only.block, 13);
  assert.equal(reserveSequence(s, [defend, upgrade, end]), null);
  assert.equal(inspectSequence(s, [play('ARMAMENTS')]).checkpoint.after_sequence, 0);
});

test('a transform or draw ends the executable prefix and cannot promise an old card afterward', () => {
  const s = combat();
  s.combat.hand.push(fixtureCard('PRIMAL_FORCE', { index: 2, cost: 0, type: 'Skill', description: 'Transform all Attacks in your Hand into Giant Rock.' }));
  const transform = play('PRIMAL_FORCE'), strike = play('STRIKE_IRONCLAD', 42);
  assert.equal(reserveSequence(s, [transform, strike, end]), null);
  const p = describeTurnProjection(s, [transform, end]);
  assert.equal(p.sequence_dependencies.checkpoint.after_sequence, 0);
  assert.equal(p.known_effects_only.hp_if_ending, null);
  assert.ok(reserveSequence(s, [transform]));
});

test('card retrieval and uncomputed next-card cost changes require observation before continuing', () => {
  for (const description of ['Put up to 2 cards from your Discard Pile into your Hand.', 'The next Attack you play costs 0 Energy.']) {
    const s = combat();
    s.combat.hand.push(fixtureCard('STATE_CHANGE', { index: 2, cost: 0, type: 'Skill', description }));
    const change = play('STATE_CHANGE');
    assert.ok(inspectSequence(s, [change]).checkpoint);
    assert.equal(reserveSequence(s, [change, play('STRIKE_IRONCLAD', 42)]), null);
    assert.equal(describeTurnProjection(s, [change, end]).known_effects_only.hp_if_ending, null);
  }
});

test('zero remaining energy gives identity-X Whirlwind zero hits while preserving independent on-play Block', () => {
  const s = combat();
  s.combat.player.energy = 1;
  s.combat.player.powers = [{ id: 'RAGE_POWER', amount: 3 }];
  s.combat.hand.push(fixtureCard('WHIRLWIND', { index: 2, cost: -1, target_type: 'AllEnemies', description: 'Deal 5 damage to ALL enemies X times.',
    attack_preview: { hits: 1, energy_to_spend: 1 }, target_previews: [{ target_id: 42, damage: 5 }] }));
  const p = describeTurnProjection(s, [play('DEFEND_IRONCLAD'), play('WHIRLWIND'), end]);
  assert.equal(p.sequence_dependencies.steps[1].x_hits, 0);
  assert.equal(p.known_effects_only.enemies[0].hp_removed, 0);
  assert.equal(p.known_effects_only.block, 8, 'An Attack play can trigger Rage even when its X damage is zero');
});

test('Tender amount zero still applies after each card, and ordered analysis survives the production schema', () => {
  const s = combat();
  s.combat.player.powers = [{ id: 'TENDER_POWER', amount: 0, description: 'Whenever you play a card, lose 1 Strength and 1 Dexterity this turn.' }];
  s.decision_context.player = structuredClone(s.combat.player);
  s.combat.player.hand_count = s.combat.hand.length;
  s.decision_context.player.hand_count = s.combat.hand.length;
  const p = describeTurnProjection(s, [play('STRIKE_IRONCLAD', 42), play('DEFEND_IRONCLAD'), end]);
  assert.equal(p.known_effects_only.enemies[0].hp_removed, 6);
  assert.equal(p.known_effects_only.block, 4);
  const prepared = prepareModDecision(s);
  prepared.payload.state.turn_planning = { phase_scope: 'Sequence fixture', conditional_projection: p, energy_reservation: {
    observed_energy: 3, remaining_after_printed_costs: 3, is_observed: false, includes_future_energy_gains: false, steps: [], scope: 'No reserved prefix' } };
  assert.doesNotThrow(() => compileModelRequest(prepared.payload));
});

test('end-turn hand Block precedes the zero-Block relic and unknown defensive triggers invalidate HP claims', () => {
  const s = combat(), c = s.combat;
  c.player.relics = [{ id: 'CLOAK_CLASP', description: 'At the end of your turn, gain 1 Block for each card in your Hand.' }, { id: 'ORICHALCUM' }];
  c.player.powers = [{ id: 'PLATING_POWER', amount: 3 }];
  const end = combatForecast(c);
  assert.deepEqual(end.end_turn_block_gains.map(g => [g.source_id, g.amount]), [['CLOAK_CLASP', 2], ['PLATING_POWER', 3]]);
  c.player.relics.push({ id: 'UNKNOWN_BLOCK', description: 'At the end of your turn, gain Block depending on an unresolved condition.' });
  assert.equal(combatForecast(c).hp_remaining_if_end_turn, null);
});

test('automatic extra plays do not reuse a single manual hit count for retaliation', () => {
  const s = combat();
  s.combat.player.powers = [{ id: 'ONE_TWO_PUNCH_POWER', amount: 1, description: 'Your next Attack is played an extra time this turn.' }];
  s.combat.enemies[0].powers = [{ id: 'THORNS_POWER', amount: 3 }];
  const p = describeTurnProjection(s, [play('STRIKE_IRONCLAD', 42)]);
  assert.equal(p.uncomputed_reactions[0].preview_hits, null);
  assert.equal(p.known_effects_only.hp_if_ending, null);
  assert.equal(p.sequence_dependencies.checkpoint.after_sequence, 0);
});

test('complete plans distinguish expiring excess Block from a preserved consumable', () => {
  const s = combat();
  s.combat.enemies[0].intents = [{ type: 'Buff', description: 'Buffing' }];
  s.combat.player.potions = [{ id: 'SPEED_POTION', slot: 0, description: 'Gain 5 Dexterity. At the end of your turn, lose 5 Dexterity.' }];
  const used = describePlanAlternative(s, [potion('SPEED_POTION'), play('DEFEND_IRONCLAD'), end]);
  const kept = describePlanAlternative(s, [play('DEFEND_IRONCLAD'), end]);
  assert.equal(used.conditional_preview.known_effects_only.hp_if_ending, kept.conditional_preview.known_effects_only.hp_if_ending);
  assert.equal(used.resource_consequences.block_unused_by_known_damage, 10);
  assert.equal(used.resource_consequences.consumed_potions.length, 1);
  assert.equal(kept.resource_consequences.potions_still_available.length, 1);
});

test('ordered delays move the loss deadline and retain the locations of future responses', () => {
  const s = combat();
  s.combat.enemies[0].powers = [{ id: 'SANDPIT_POWER', amount: 1 }];
  for (const index of [2, 3]) s.combat.hand.push(fixtureCard('FRANTIC_ESCAPE', { index, type: 'Status',
    details: { instance_id: `escape_${index}` }, description: 'Get farther away. Increase Sandpit by 1. Increase the cost of this card by 1.' }));
  const once = describeTurnProjection(s, [play('escape_2'), end]);
  const twice = describeTurnProjection(s, [play('escape_2'), play('escape_3'), end]);
  assert.equal(once.loss_deadlines[0].counter_after_upcoming_enemy_start, 1);
  assert.equal(twice.loss_deadlines[0].counter_after_upcoming_enemy_start, 2);
  assert.equal(once.loss_deadlines[0].known_delay_cards.in_remaining_hand.length, 1);
  assert.equal(twice.loss_deadlines[0].known_delay_cards.in_remaining_hand.length, 0);
  assert.equal(once.loss_deadlines[0].known_delay_cards.in_current_draw_pile, 0);
});
