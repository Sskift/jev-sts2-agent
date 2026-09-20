import { attackHpLoss, combatForecast, intentDamage } from './combat_arithmetic.mjs';
import { projectPositioning } from './combat_positioning.mjs';
import { reserveActionSequence } from './turn_action_constraints.mjs';
import { describeCardFlow } from './card_flow_projection.mjs';

export function sequenceEnergyBudget(state, steps) {
  let energy = state.combat.player.energy, attacks = 0;
  const costs = [], transitions = [];
  for (const [sequence, step] of steps.entries()) {
    const card = step.kind === 'play_card' ? state.combat.hand.find(card => card.details?.instance_id === step.card_instance_id) : null;
    if (step.kind === 'play_card' && !card) return null;
    const cost = card ? card.cost < 0 ? Math.max(0, energy) : card.id === 'STOMP' ? Math.max(0, card.cost - attacks) : card.cost : 0;
    transitions.push({ sequence, kind: step.kind, hand_index: card?.index ?? null,
      energy_before: energy, reserved_cost: cost, energy_after: energy - cost, affordable: cost <= energy });
    costs.push(cost); energy -= cost;
    if (card?.type === 'Attack') attacks++;
  }
  return { energy_left: energy, costs, transitions, affordable: transitions.every(step => step.affordable) };
}

export function reserveSequence(state, steps) {
  const budget = sequenceEnergyBudget(state, steps);
  return budget?.affordable && reserveActionSequence(state, steps).valid ? { energy_left: budget.energy_left, costs: budget.costs } : null;
}

// Keep omitted effects next to an explicitly scoped baseline. A plan containing
// a potion or another unresolved effect must not claim its final HP/damage
// equals that of an otherwise identical plan without it.
export function describeTurnProjection(state, steps) {
  const projection = projectTurnPrefix(state, steps);
  return {
    calculation_status: projection.unresolved_effects.length ? 'incomplete' : 'preview_arithmetic',
    fully_simulated: false,
    known_effects_only: {
      block: projection.block, hp_if_ending: projection.hp_if_ending_after_prefix,
      hp_loss_if_ending: projection.hp_if_ending_after_prefix === null ? null : state.combat.player.hp - projection.hp_if_ending_after_prefix,
      block_including_end_turn_gains: projection.block_including_end_turn_gains,
      end_turn_block_gains: projection.end_turn_block_gains,
      incoming_attack: projection.incoming_attack_after_prefix,
      enemies: projection.remaining_enemies.map(({ combat_id, hp, block }) => {
        const before = state.combat.enemies.find(enemy => enemy.combat_id === combat_id);
        return { combat_id, hp, block, hp_removed: before.hp - hp, block_removed: before.block - block };
      })
    },
    ...(projection.positioning ? { positioning: projection.positioning } : {}),
    ...(projection.uncomputed_reactions.length ? { uncomputed_reactions: projection.uncomputed_reactions } : {}),
    ...(projection.card_flow ? { card_flow: projection.card_flow } : {}),
    omitted_effects: projection.unresolved_effects,
    interpretation: 'Numbers exclude omitted effects; an omitted effect is not zero benefit. Compare its full rules, timing and later-turn benefits separately. Equal baselines do not establish equal outcomes.',
    scope: projection.scope
  };
}

// This is a conditional sum of visible previews, not a game simulator. Keeping
// it separate from combat prevents planned outcomes from becoming observations.
export function projectTurnPrefix(state, steps) {
  const combat = structuredClone(state.combat), unresolved = [], reactions = [], cardFlowEffects = [];
  for (const [index, step] of steps.entries()) {
    if (step.kind === 'end_turn') break;
    if (step.kind !== 'play_card') { unresolved.push(`${step.name}: potion effects are not simulated`); continue; }
    let card = combat.hand.find(card => card.details?.instance_id === step.card_instance_id);
    if (!card) { unresolved.push(`${step.name}: card availability is unconfirmed`); continue; }
    const original = card;
    if (card.cost < 0 && combat.player.energy !== state.combat.player.energy) {
      card = { ...card, attack_preview: undefined };
      unresolved.push(`${card.name}: X-cost hit count after earlier spending is not recomputed`);
    }
    const target = combat.enemies.find(enemy => enemy.combat_id === step.target);
    // Keep immediate Block separate from effects due only at turn end.
    const estimate = combatForecast(combat, card, target);
    for (const reaction of estimate.uncomputed_reactions || []) reactions.push({ sequence: index, ...reaction });
    for (const effect of estimate.card_flow?.effects || []) cardFlowEffects.push({ sequence: index, ...effect });
    if (estimate.block_preview?.amount === null) unresolved.push(`${card.name}: Block contribution is unknown, not zero; HP arithmetic omits it`);
    const targets = card.target_type === 'AllEnemies' ? combat.enemies.filter(enemy => enemy.is_alive && enemy.hp > 0) : target ? [target] : [];
    for (const enemy of targets) {
      const hit = attackHpLoss(card, enemy);
      if (hit) { enemy.hp = Math.max(0, enemy.hp - hit.hp_loss); enemy.block = hit.block_after; enemy.powers = hit.powers_after; enemy.is_alive = enemy.hp > 0; }
    }
    combat.player.energy = reserveSequence(state, steps.slice(0, index + 1))?.energy_left ?? estimate.energy_after_printed_cost;
    combat.player.block = estimate.block_after_card ?? estimate.block_baseline_without_reactions;
    combat.player.hp -= estimate.declared_self_hp_loss || 0;
    const exhausted = new Set(estimate.exhausted_hand_cards?.map(card => card.index));
    combat.hand = combat.hand.filter(other => other !== original && !exhausted.has(other.index));
    if (card.id === 'RAGE' && Number.isFinite(card.rage_block_per_attack)) {
      const power = combat.player.powers.find(power => power.id === 'RAGE_POWER');
      if (power) power.amount += card.rage_block_per_attack;
      else combat.player.powers.push({ id: 'RAGE_POWER', amount: card.rage_block_per_attack });
    }
    if (!/^(?:Deal [\d.]+ damage\.?|Gain [\d.]+ Block\.?)$/i.test(card.description.trim()) && card.id !== 'RAGE') unresolved.push(`${card.name}: only existing damage/Block previews and printed cost/self-loss are counted; other effects are unconfirmed`);
  }
  const end = combatForecast(combat);
  const depleted = new Set(combat.enemies.filter(enemy => !enemy.is_alive || enemy.hp <= 0).map(enemy => enemy.combat_id));
  const positioning = projectPositioning(state.combat, steps, depleted);
  const facingUnresolved = positioning && !positioning.current_intents_still_applicable;
  if (facingUnresolved) unresolved.push('Player facing changes: current enemy intent damage includes the previous facing; final incoming damage and HP are unknown until new native previews are observed.');
  if (reactions.length) unresolved.push('Uncomputed attack reactions affect HP and Block before later actions and turn-end gains. Final HP, Block and remaining attack totals are unknown; enemy HP/removal values are conditional on all proposed attacks resolving. See uncomputed_reactions for source, timing and per-hit exposure.');
  if (cardFlowEffects.length) unresolved.push('Triggered card generation is listed in card_flow. Random insertion, subsequent draw quality and changes to known top-card placement are not simulated; immediate damage/Block numbers omit these costs.');
  // The single-action forecast can know a current loss timer without the
  // sequence evaluator knowing how an omitted effect changes that timer.
  // Reusing its old value would falsely declare every such plan fatal.
  const timedLossUnresolved = end.death_timers?.length > 0 && unresolved.length > 0;
  if (timedLossUnresolved) unresolved.push('An active loss countdown coexists with uncomputed effects. Its value after this sequence and resulting survival are not calculated; evaluate the current counter and every proposed rule, including response availability before the next deadline.');
  return {
    scope: 'Conditional arithmetic if current previews remain applicable. Not an observed or fully simulated future. Counts known hit caps, printed Block/self-loss, active or newly declared Rage, Second Wind hand exhaustion, and active Plating/Orichalcum once at turn end. Does not predict upgrades, debuffs, changing attack values, draws, potion effects, energy gains, cost changes, death triggers or future enemy choices.',
    remaining_enemies: combat.enemies.map(enemy => ({ combat_id: enemy.combat_id, name: enemy.name, hp: enemy.hp, block: enemy.block, visible_attack: enemy.is_alive ? intentDamage(enemy) : 0 })),
    block: reactions.length ? null : combat.player.block, block_including_end_turn_gains: reactions.length ? null : end.block_including_end_turn_gains, end_turn_block_gains: end.end_turn_block_gains,
    hp_after_declared_self_loss: combat.player.hp,
    hp_if_ending_after_prefix: facingUnresolved || timedLossUnresolved || reactions.length ? null : end.hp_remaining_if_end_turn,
    incoming_attack_after_prefix: facingUnresolved || reactions.length ? null : end.displayed_attacks_after_target_depletion,
    uncomputed_reactions: reactions,
    card_flow: describeCardFlow(state.combat, cardFlowEffects),
    ...(positioning ? { positioning } : {}),
    unresolved_effects: [...new Set(unresolved)]
  };
}
