import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { canonicalRelics } from './observation_state.mjs';

// A missing count or damage value is not a zero-damage Attack. Zero hits is
// a real zero and must not be changed by JavaScript's truthy-default operator.
export function intentDamage(enemy) {
  let total = 0;
  for (const intent of enemy.intents || []) {
    if (intent.type !== 'Attack' && intent.damage == null) continue;
    if (!Number.isFinite(intent.damage) || intent.damage < 0
      || !Number.isSafeInteger(intent.hits) || intent.hits < 0) return null;
    total += intent.damage * intent.hits;
  }
  return total;
}

export function displayedAttackTotal(enemies) {
  const values = enemies.filter(enemy => enemy.is_alive && enemy.hp > 0).map(intentDamage);
  return values.includes(null) ? null : values.reduce((sum, value) => sum + value, 0);
}

export function currentCombatArithmetic(combat) {
  const incoming = displayedAttackTotal(combat.enemies);
  return { incoming_attack_damage: incoming, current_block: combat.player.block,
    attack_damage_after_current_block: incoming === null ? null : Math.max(0, incoming - combat.player.block),
    energy_remaining: combat.player.energy,
    ...(combat.positioning ? { incoming_attack_facing: combat.positioning.facing, includes_current_back_attack_multiplier: true } : {}),
    note: 'Sum of currently displayed per-hit Attack intents, with the currently held Block subtracted separately. This is not end-turn HP loss or a survival prediction: prevention, retaliation, temporary effects, expiry and enemy actions can change the result. Missing Attack damage or hit count keeps the sum unknown.' };
}

const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const sorted = records => records.map(record => JSON.stringify(stable(record))).sort();
function ungroup(groups) {
  return groups.flatMap(({ card, count, instance_ids }) => Array.from({ length: count }, (_, index) => {
    const copy = structuredClone(card);
    if (instance_ids[index]) (copy.details ||= {}).instance_id = instance_ids[index];
    return copy;
  }));
}

// Called on expanded canonical records. Resolve text references so readable
// and packed requests share the same receipt; derived analysis is not hashed.
export function combatFactDigest(packet) {
  const receipt = packet.information.observation_integrity;
  const resolve = value => {
    if (value && typeof value === 'object' && Object.keys(value).length === 1 && value.text_ref) {
      const text = packet.text_dictionary?.[value.text_ref];
      if (typeof text !== 'string') throw new Error('Native combat fact has an unresolved text reference');
      return text;
    }
    return Array.isArray(value) ? value.map(resolve) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)])) : value;
  };
  const facts = Object.fromEntries(receipt.verified_sections.filter(key => key !== 'combat.player')
    .map(key => [key, key.split('.').reduce((value, field) => value?.[field], packet)]));
  return createHash('sha256').update(JSON.stringify(stable(resolve(facts)))).digest('hex');
}

// Independent source-to-packet check after history scoping and BEFORE identity
// aliases or packing. A fact digest verifies all subsequent encoding steps.
export function verifyNativeCombatObservation(native, packet) {
  if (!native.combat) return null;
  const context = native.decision_context, checked = [];
  const equal = (label, expected, actual) => {
    if (!isDeepStrictEqual(expected, actual)) throw new Error(`Native combat fact changed or disappeared: ${label}`);
    checked.push(label);
  };
  const expectedPlayer = { ...context.player, relics: canonicalRelics(context.player.relics) };
  equal('player', expectedPlayer, packet.player);
  for (const [key, value] of Object.entries(native.combat)) {
    if (key === 'player') { equal('combat.player', native.combat.player, context.player); continue; }
    if (key === 'draw_pile') { equal('combat.draw_pile', sorted(value), sorted(ungroup(packet.combat.draw_pile.cards))); continue; }
    if (key === 'enemies') {
      const expected = value.map(enemy => {
        const copy = structuredClone(enemy);
        delete copy.move_id; // Internal AI state, not a human-visible fact.
        for (const intent of copy.intents) if (!intent.description?.trim())
          intent.description = `Visible ${intent.type} intent. Exact effect is not specified by the displayed label.`;
        return copy;
      });
      equal('combat.enemies', expected, packet.combat.enemies); continue;
    }
    equal(`combat.${key}`, value, packet.combat[key]);
  }
  equal('combat.play_pile', context.play_pile, packet.combat.play_pile);
  equal('deck.cards', sorted(context.master_deck), sorted(ungroup(packet.deck.cards)));
  equal('resources.potion_capacity', context.potion_capacity, packet.resources.potion_capacity);
  equal('rules', context.glossary, packet.rules);
  return { source: 'native_snapshot_before_model_encoding', verified_sections: checked,
    native_snapshot_sha256: createHash('sha256').update(JSON.stringify(native)).digest('hex'),
    normalizations: context.player.relics.filter(relic => relic.id === 'HAPPY_FLOWER' && relic.counter === 3)
      .map(relic => ({ source_id: relic.id, field: 'counter', native_display_value: 3, gameplay_value: 0,
        reason: 'Verified v0.111.0 activation animation displays 3 while TurnsSeen has reset to 0.' })),
    scope: 'Checks every supplied combat field and full player, pile, deck and rule records. Draw order and hidden move IDs are intentionally not revealed. This establishes faithful transport of supplied facts, not completeness of the native extractor or accuracy of derived forecasts.' };
}
