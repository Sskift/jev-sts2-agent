import { potionEffectFacts } from './potion_effects.mjs';
import { handUpgradeMode, nextCardKind, slowPercent } from './turn_effects.mjs';
import { previewHitCount } from './combat_arithmetic.mjs';

const instance = card => card?.details?.instance_id;
const amount = (entity, id) => (entity.powers || []).find(p => p.id === id)?.amount || 0;
const gain = (text, unit) => Number(text?.match(new RegExp(`(?:^|\\.\\s*)Gain (\\d+) ${unit}\\.(?:\\s|$)`))?.[1]);

// Native Stomp reduces its current cost for each subsequent owned Attack.
// Planning and confirmation share this rule; other cost changes stay unknown.
export const costAfterAttacks = (card, attacks) => card.id === 'STOMP' && card.cost >= 0 ? Math.max(0, card.cost - attacks) : card.cost;

// Native v0.111.0 OnPlay directly applies these stats to the owner. Restrict
// the adapter to the resolved one-clause rule; other powers remain unknown.
function directStatPower(card) {
  const stat = card?.type === 'Power' && ({ INFLAME: 'Strength', FOOTWORK: 'Dexterity' })[card.id];
  const match = stat && card.description?.trim().match(new RegExp(`^Gain (\\d+) ${stat}\\.$`));
  return match ? { power_id: `${stat.toUpperCase()}_POWER`, amount: Number(match[1]), expires: 'combat_end' } : null;
}

// These changes require a new native observation. A generated/transformed card
// is never represented by its old instance and an invented future cost.
export function observationReason(state, step, resolvedEntity) {
  const entity = resolvedEntity || (step.kind === 'play_card' ? state.combat.hand.find(c => instance(c) === step.card_instance_id)
    : step.kind === 'use_potion' ? state.combat.player.potions?.find(p => p.slot === step.slot) : null);
  if (!entity) return null;
  const clauses = (entity.description || '').split(/[.\n]/).map(s => s.trim());
  const changing = clauses.find(s => /^(?:Draw\b|Choose\b|Transform\b|Add\b.*\bHand\b|Return\b|Shuffle\b|Discard\b|Gain\b.*\bEnergy\b)/i.test(s)
    || /^(?:Put|Move)\b.*\b(?:Hand|Pile)\b/i.test(s)
    || /\bnext\b[^.]*\bcosts?\b[^.]*\bEnergy\b/i.test(s)
    || /^Exhaust (?:a|1|\d+) cards?\b/i.test(s));
  if (changing) return changing;
  if (entity.type === 'Power' && !directStatPower(entity)) return 'Observe the installed power and its native cost, stat and trigger changes before continuing.';
  if (handUpgradeMode(entity.description) === 'one' && !step.beneficiary_instance_id) return 'Observe the selected upgrade before specifying its continuation.';
  return null;
}

function upgradedCard(card) {
  const upgrade = card.upgrade_preview;
  if (!upgrade) return card;
  const result = { ...card, ...upgrade, is_upgraded: true };
  delete result.upgrade_preview;
  const block = gain(upgrade.description, 'Block');
  if (Number.isFinite(block)) result.block = block;
  const damage = Number(upgrade.description?.match(/(?:^|\.\s*)Deal (\d+) damage\b/)?.[1]);
  if (Number.isFinite(damage)) {
    result.damage = damage;
    result.target_previews = card.target_previews?.map(p => ({ ...p, damage: p.damage === card.damage ? damage : undefined }));
  } else if (card.type === 'Attack') result.target_previews = card.target_previews?.map(p => ({ ...p, damage: undefined }));
  return result;
}

// A delta enters before ordinary Weak/Vulnerable/Shrink/Frail multipliers. Native
// integer previews hide a fractional remainder; only an exact range may be
// reused as a point estimate. Rational factors avoid floating-point underflow
// at integer boundaries (Shrink is 7/10). Active modifiers must still hold.
function shifted(value, delta, numerator, denominator, supported) {
  if (!Number.isFinite(value) || !supported) return { min: null, max: null };
  if (value === 0 && delta > 0) return { min: null, max: null }; // A clamped preview hides how far below zero the original value was.
  const lower = value * denominator + delta * numerator;
  return { min: Math.max(0, Math.floor(lower / denominator)), max: Math.max(0, Math.ceil((lower + denominator) / denominator) - 1) };
}
const exact = range => range.min === range.max ? range.min : null;

/** One ordered walk supplies resource reservations and conditional card values.
 * It never mutates the native observation. Enemy reactions/AI remain elsewhere.
 * Stop at observation boundaries rather than continuing with stale identities. */
export function inspectSequence(state, steps) {
  const observed = state.combat;
  const hand = new Map(observed.hand.map(c => [instance(c), structuredClone(c)]));
  let energy = observed.player.energy, attacks = 0, strength = 0, dexterity = 0;
  let checkpoint = null, unknownStrength = false, unknownDexterity = false;
  const nextEffects = (observed.player.powers || []).filter(p => nextCardKind(p.description));
  const entries = [], transitions = [], trace = [], violations = [], unknownTargets = new Set();
  let unknownBlock = false;
  for (const [sequence, step] of steps.entries()) {
    if (checkpoint) {
      if (step.kind !== 'end_turn') violations.push({ sequence, reason: 'Action follows a required native observation.' });
      transitions.push({ sequence, kind: step.kind, hand_index: null, energy_before: energy, reserved_cost: 0, energy_after: energy, affordable: step.kind === 'end_turn' });
      continue;
    }
    const original = step.kind === 'play_card' ? hand.get(step.card_instance_id) : null;
    if (step.kind === 'play_card' && !original) {
      violations.push({ sequence, reason: 'Card is absent or was already consumed.' }); break;
    }
    const card = original && structuredClone(original);
    const cost = card ? card.cost < 0 ? Math.max(0, energy) : costAfterAttacks(card, attacks) : 0;
    const before = energy;
    energy -= cost;
    if (cost > before) violations.push({ sequence, reason: 'Insufficient known energy.' });
    transitions.push({ sequence, kind: step.kind, hand_index: card?.index ?? null, energy_before: before, reserved_cost: cost, energy_after: energy, affordable: cost <= before });
    if (step.kind === 'end_turn') break;
    const detail = { sequence, source_id: card?.id || step.potion_id || null, energy_before: before, energy_after: energy,
      strength_change_before_action: unknownStrength ? null : strength, dexterity_change_before_action: unknownDexterity ? null : dexterity };
    const potion = step.kind === 'use_potion' ? observed.player.potions?.find(p => p.slot === step.slot && p.id === step.potion_id) : null;
    const effect = potionEffectFacts(potion);
    if (effect) {
      if (effect.power_id === 'STRENGTH_POWER') strength += effect.amount;
      else dexterity += effect.amount;
      detail.applies_after_action = { power_id: effect.power_id, amount: effect.amount, expires: effect.expires_at };
    }
    if (potion && nextCardKind(potion.description)) nextEffects.push(potion);
    if (card) {
      const consumed = nextEffects.filter(effect => nextCardKind(effect.description) === 'Any' || nextCardKind(effect.description) === card.type);
      const repeats = consumed.some(effect => /\b(?:extra time|additional time|played twice|played .* times)\b/i.test(effect.description));
      if (repeats) {
        card._uncomputed_repetitions = true;
        if (observed.player.powers?.some(p => p.id === 'RAGE_POWER')) unknownBlock = true;
      }
      if (card.cost < 0 && before !== observed.player.energy) {
        // For the verified Whirlwind construction, an unchanged identity-X
        // preview with no declared X modifier follows reserved energy.
        const xModifier = [...(observed.player.powers || []), ...(observed.player.relics || [])]
          .some(p => /\bX\b/.test(p.description || '') || p.id === 'CHEMICAL_X');
        const native = card.attack_preview;
        const known = card.id === 'WHIRLWIND' && !xModifier && native?.energy_to_spend === observed.player.energy && native.hits === native.energy_to_spend;
        card.attack_preview = known ? { ...native, hits: Math.max(0, before), energy_to_spend: Math.max(0, before) } : undefined;
        detail.x_hits = known ? Math.max(0, before) : null;
      }
      if (card.type === 'Attack') {
        const weak = amount(observed.player, 'WEAK_POWER') > 0;
        // Shrink -1 is indefinite, not inactive; its verified native hook
        // multiplies powered attack damage by 0.7 independently of stacks.
        const shrink = observed.player.powers?.some(p => p.id === 'SHRINK_POWER');
        // A standalone cost discount (native Stomp) changes payment, not its
        // damage basis. Keep other counter-dependent clauses conservative.
        const damageRules = card.description.split(/[.\n]/).map(clause => clause.trim())
          .filter(clause => !/^Costs? \d+ less (?:\d+ )?Energy for each Attack played this turn$/i.test(clause)).join('. ');
        const mutableBasis = sequence > 0 && /(?:your (?:current )?(?:Block|HP)|cards? in (?:your )?(?:Hand|Discard|Exhaust)|(?:Attacks?|Skills?|cards?) played (?:this turn|this combat))/i.test(damageRules);
        const unusualScaling = strength !== 0 && /\bStrength\b/i.test(card.description) && card.id !== 'SETUP_STRIKE';
        const hits = previewHitCount(card, observed.enemies.find(e => e.combat_id === step.target));
        detail.damage_instances = hits;
        if (hits === null || !card.target_previews?.length && hits !== 0) {
          for (const enemy of observed.enemies.filter(e => e.is_alive && (card.target_type === 'AllEnemies' || e.combat_id === step.target))) unknownTargets.add(enemy.combat_id);
        }
        detail.damage_per_target = (card.target_previews || []).map(preview => {
          const enemy = observed.enemies.find(e => e.combat_id === preview.target_id);
          const vulnerable = enemy && amount(enemy, 'VULNERABLE_POWER') > 0;
          const slow = slowPercent(enemy);
          const custom = unknownStrength || mutableBasis || unusualScaling || repeats
            || (strength !== 0 && enemy && amount(enemy, 'INTANGIBLE_POWER') > 0)
            || (vulnerable && (amount(enemy, 'DEBILITATE_POWER') || amount(observed.player, 'CRUELTY_POWER')
            || observed.player.relics?.some(r => r.id === 'PAPER_PHROG')));
          const range = strength === 0 && !unknownStrength && !mutableBasis && !repeats ? { min: preview.damage ?? null, max: preview.damage ?? null }
            : shifted(preview.damage, strength, (weak ? 3 : 1) * (vulnerable ? 3 : 1) * (shrink ? 7 : 1) * (100 + (slow ?? 0)),
              (weak ? 4 : 1) * (vulnerable ? 2 : 1) * (shrink ? 10 : 1) * 100, !custom && slow !== null && card.id !== 'OMNISLICE');
          preview.damage = exact(range) ?? undefined;
          if (preview.damage === undefined) unknownTargets.add(preview.target_id);
          return { target_id: preview.target_id, per_hit_before_block_and_hp_loss_caps: range, total_before_block_and_hp_loss_caps: hits === 0 ? { min: 0, max: 0 }
            : { min: range.min === null || hits === null ? null : range.min * hits, max: range.max === null || hits === null ? null : range.max * hits } };
        });
        attacks++;
      }
      if (Number.isFinite(card.block) && card.type !== 'Power') {
        const range = dexterity === 0 && !unknownDexterity && !repeats ? { min: card.block, max: card.block }
          : shifted(card.block, dexterity, amount(observed.player, 'FRAIL_POWER') > 0 ? 3 : 1,
            amount(observed.player, 'FRAIL_POWER') > 0 ? 4 : 1, !unknownDexterity && !repeats);
        detail.block_per_gain = range;
        const block = exact(range);
        if (block === null) { unknownBlock = true; card.block = undefined; }
        else card.block = block;
      }
      hand.delete(step.card_instance_id);
      const upgrade = handUpgradeMode(card.description);
      if (upgrade) {
        const targets = upgrade === 'all' ? [...hand.keys()] : [step.beneficiary_instance_id];
        if (upgrade === 'one' && step.beneficiary_instance_id && !hand.has(step.beneficiary_instance_id)) violations.push({ sequence, reason: 'The chosen upgrade target has already left the hand.' });
        for (const id of targets) if (hand.has(id)) hand.set(id, upgradedCard(hand.get(id)));
        detail.upgrades_before_later_actions = targets.filter(id => hand.has(id));
      }
      if (card.id === 'SECOND_WIND') for (const [id, other] of hand) if (other.type !== 'Attack') hand.delete(id);
      // Native Tender's DisplayAmount counts earlier plays, not trigger strength.
      // The loss happens after each owned card, including when the amount is 0.
      if (observed.player.powers?.some(p => p.id === 'TENDER_POWER')) {
        strength--; dexterity--; detail.after_play_stat_change = { strength: -1, dexterity: -1, source_id: 'TENDER_POWER' };
      }
      const setupStrength = card.id === 'SETUP_STRIKE' ? Number(card.description.match(/\bGain (\d+) Strength this turn\./)?.[1]) : NaN;
      const statPower = directStatPower(card);
      if (statPower) {
        if (statPower.power_id === 'STRENGTH_POWER') strength += statPower.amount;
        else dexterity += statPower.amount;
        detail.applies_after_action = statPower;
      } else if (Number.isFinite(setupStrength)) {
        strength += setupStrength;
        detail.applies_after_action = { power_id: 'STRENGTH_POWER', amount: setupStrength, expires: 'owner_turn_end' };
      } else if (/\b(?:gain|lose)\b[^.]*\b(?:Strength|Dexterity)\b/i.test(card.description)) {
        unknownStrength ||= /\b(?:gain|lose)\b[^.]*\bStrength\b/i.test(card.description);
        unknownDexterity ||= /\b(?:gain|lose)\b[^.]*\bDexterity\b/i.test(card.description);
        detail.uncomputed_stat_change = card.description;
      }
      if (consumed.length) {
        detail.consumes_next_card_effects = consumed.map(effect => effect.id);
        checkpoint = { after_sequence: sequence, source_id: card.id, reason: 'Observe consumed next-card effects, automatic plays and their reactions before reusing later previews.' };
      }
      if (nextCardKind(card.description)) nextEffects.push(card);
    }
    const reason = observationReason(state, step, card || potion);
    if (reason) checkpoint = { after_sequence: sequence, source_id: card?.id || step.potion_id || null, reason };
    entries.push({ sequence, step, card, potion, cost, energy_before: before, energy_after: energy });
    trace.push(detail);
  }
  return { entries, remaining_hand: [...hand.values()], energy_left: energy, costs: transitions.map(t => t.reserved_cost), transitions, checkpoint, violations,
    unknown_targets: [...unknownTargets], unknown_block: unknownBlock,
    analysis: { is_observed: false, steps: trace, checkpoint, violations,
      scope: 'Conditional ordered costs, inspectable hand upgrades, resolved stat potion deltas, direct Inflame/Footwork gains, Setup Strike, Tender after each card, and identity-X Whirlwind payment. Stat deltas use ordinary Weak, Vulnerable, Shrink and Frail multipliers while those modifiers remain active; source death and other multiplier changes are not simulated. Next-card consumers, draws and other uncomputed state changes require observation. Native starting previews are not reapplied as unchanged future facts; unresolved ranges remain unknown. No actions beyond a checkpoint are promised.' } };
}
