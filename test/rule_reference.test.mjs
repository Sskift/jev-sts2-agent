import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRuleReference } from '../src/rule_reference.mjs';
import { prepareModDecision } from '../src/mod_decision.mjs';
import { expandRecordTables, compactContext, validateDecisionPacket } from '../src/decision_context.mjs';
import { completeCombat } from './fixtures/context.mjs';

const stateWith = fields => ({ decision_context: { run_id: 'reference-test', master_deck: [], player: {} }, ...fields });

test('Wiki closure follows generated cards, powers and keywords without expanding random card pools', () => {
  const state = stateWith({ tri_select: { cards: [{ card_id: 'BLADE_DANCE' }, { card_id: 'INFERNAL_BLADE' }, { card_id: 'PRIMAL_FORCE' }] } });
  const rules = buildRuleReference(state), cards = rules.entries.cards;
  assert.deepEqual(cards.map(card => card.id).sort(), ['BLADE_DANCE', 'GIANT_ROCK', 'INFERNAL_BLADE', 'PRIMAL_FORCE', 'SHIV'].sort());
  assert.ok(rules.entries.keywords.some(keyword => keyword.id === 'EXHAUST'));
  const bladeDance = cards.find(card => card.id === 'BLADE_DANCE');
  assert.match(bladeDance.base_rules, /Add 3 Shivs/);
  assert.equal('cards_draw' in bladeDance, false); // Upstream parser calls generated CardsVar a draw count.
  assert.equal(rules.game_version, 'v0.111.0');
});

test('base/upgrade/X rules stay separate and never replace current combat values', () => {
  const state = stateWith({ combat: { hand: [{ id: 'RAGE', block: 0, rage_block_per_attack: 5 }, { id: 'WHIRLWIND', cost: -1, damage: 12 }], player: { powers: [{ id: 'RAGE_POWER', amount: 5, description: 'Gain 5 Block per Attack.' }] } } });
  const before = structuredClone(state), rules = buildRuleReference(state);
  const rage = rules.entries.cards.find(card => card.id === 'RAGE');
  assert.match(rage.base_rules, /gain 3 Block/);
  assert.match(rage.upgraded_rules, /gain 5 Block/);
  assert.equal(rules.entries.cards.find(card => card.id === 'WHIRLWIND').base_energy_cost, 'X');
  assert.ok(rules.entries.powers.some(power => power.id === 'RAGE'));
  assert.match(rules.scope, /Live mod state/);
  assert.deepEqual(state, before);
});

test('power namespace, attached modifications and missing references remain explicit', () => {
  const state = stateWith({ combat: { hand: [{ id: 'INFLAME', details: { enchantment: { id: 'ADROIT' }, affliction: { id: 'BOUND' } } }, { id: 'UNKNOWN_MOD_CARD' }], player: { powers: [{ id: 'STRENGTH_POWER', amount: 2 }] } } });
  const rules = buildRuleReference(state);
  assert.ok(rules.entries.powers.some(power => power.id === 'STRENGTH'));
  assert.ok(rules.entries.enchantments.some(rule => rule.id === 'ADROIT'));
  assert.ok(rules.entries.afflictions.some(rule => rule.id === 'BOUND'));
  assert.deepEqual(rules.missing, ['cards/UNKNOWN_MOD_CARD']);
});

test('Speed Potion links to Dexterity and its native tooltip explains the effect', () => {
  const state = stateWith({ combat: { player: { potions: [{ id: 'SPEED_POTION' }] } } });
  state.decision_context.glossary = [{ title: 'Dexterity', description: 'Dexterity improves Block gained from cards.' }];
  const rules = buildRuleReference(state);
  assert.ok(rules.entries.potions[0].related_rules.includes('powers/DEXTERITY'));
  assert.equal(rules.entries.powers.find(power => power.id === 'DEXTERITY').native_tooltip, 'Dexterity improves Block gained from cards.');
});

test('event branches are public possibilities and never create game options', () => {
  const state = stateWith({ event: { event_id: 'SLIPPERY_BRIDGE', options: [{ title: 'Hold On', description: 'Lose 7 HP.' }] } });
  const before = structuredClone(state), rules = buildRuleReference(state);
  const event = rules.entries.events.find(event => event.id === 'SLIPPERY_BRIDGE');
  assert.ok(event.pages.length > 1);
  assert.match(event.coverage, /not the observed current page/);
  assert.deepEqual(state, before);
  const neow = buildRuleReference(stateWith({ event: { event_id: 'NEOW', options: [{ relic_id: 'ARCANE_SCROLL' }] } }));
  assert.deepEqual(neow.entries.relics.map(relic => relic.id), ['ARCANE_SCROLL']);
  assert.match(neow.entries.events[0].coverage, /unavailable/);
});

test('complete requests include local references and compression preserves every selected rule', () => {
  const state = completeCombat();
  const prepared = prepareModDecision(state);
  const packet = expandRecordTables(prepared.payload.state);
  assert.ok(packet.rule_reference.entries.cards.some(card => card.id === 'STRIKE_IRONCLAD'));
  const packed = compactContext(packet);
  validateDecisionPacket(packed);
  // Text interning is also self-contained; table expansion must retain IDs/counts.
  assert.deepEqual(expandRecordTables(packed).rule_reference.entries.cards.map(card => card.id), packet.rule_reference.entries.cards.map(card => card.id));
  assert.equal(buildRuleReference({ screen: 'MENU' }), null);
});
