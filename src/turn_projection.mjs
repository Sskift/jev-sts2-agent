import { attackHpLoss, combatForecast, intentDamage } from './combat_arithmetic.mjs';
import { projectPositioning } from './combat_positioning.mjs';
import { reserveActionSequence } from './turn_action_constraints.mjs';
import { describeCardFlow } from './card_flow_projection.mjs';
import { projectDebuffDependencies } from './turn_debuff_projection.mjs';
import { describeEffectLifecycle } from './effect_lifecycle.mjs';
import { inspectSequence } from './turn_sequence.mjs';

export function sequenceEnergyBudget(state, steps) {
  const sequence = inspectSequence(state, steps);
  if (sequence.transitions.length !== steps.length) return null;
  return { energy_left: sequence.energy_left, costs: sequence.costs, transitions: sequence.transitions,
    affordable: !sequence.violations.length && sequence.transitions.every(step => step.affordable) };
}

export function reserveSequence(state, steps) {
  const budget = sequenceEnergyBudget(state, steps);
  return budget?.affordable && reserveActionSequence(state, steps).valid ? { energy_left: budget.energy_left, costs: budget.costs } : null;
}

// Keep omitted effects next to an explicitly scoped baseline. A plan containing
// a potion or another unresolved effect must not claim its final HP/damage
// equals that of an otherwise identical plan without it.
export function describeTurnProjection(state, steps) {
  const sequence = inspectSequence(state, steps);
  const projection = projectTurnPrefix(state, steps, sequence);
  const debuffs = projectDebuffDependencies(state, steps, sequence.entries);
  const lifecycle = describeEffectLifecycle(state, steps);
  const affected = new Set([...(debuffs?.affected_target_ids || []), ...sequence.unknown_targets]);
  const hp = affected.size ? null : projection.hp_if_ending_after_prefix;
  return {
    calculation_status: projection.unresolved_effects.length || debuffs ? 'incomplete' : 'preview_arithmetic',
    fully_simulated: false,
    known_effects_only: {
      block: projection.block, hp_if_ending: hp,
      hp_loss_if_ending: hp === null ? null : state.combat.player.hp - hp,
      block_including_end_turn_gains: projection.block_including_end_turn_gains,
      end_turn_block_gains: projection.end_turn_block_gains,
      end_turn_damage_events: projection.end_turn_damage_events,
      incoming_attack: affected.size ? null : projection.incoming_attack_after_prefix,
      enemies: projection.remaining_enemies.map(({ combat_id, hp, block }) => {
        const before = state.combat.enemies.find(enemy => enemy.combat_id === combat_id);
        if (affected.has(combat_id)) return { combat_id, hp: null, block: null, hp_removed: null, block_removed: null };
        return { combat_id, hp, block, hp_removed: before.hp - hp, block_removed: before.block - block };
      })
    },
    ...(projection.positioning ? { positioning: projection.positioning } : {}),
    ...(projection.uncomputed_reactions.length ? { uncomputed_reactions: projection.uncomputed_reactions } : {}),
    ...(projection.card_flow ? { card_flow: projection.card_flow } : {}),
    ...(debuffs ? { debuff_dependencies: debuffs } : {}),
    ...(lifecycle ? { effect_lifecycle: lifecycle } : {}),
    sequence_dependencies: sequence.analysis,
    ...(projection.loss_deadlines.length ? { loss_deadlines: projection.loss_deadlines } : {}),
    ...(projection.uncomputed_turn_end_effects.length ? { uncomputed_turn_end_effects: projection.uncomputed_turn_end_effects } : {}),
    omitted_effects: [...projection.unresolved_effects, ...(affected.size ? ['New debuffs invalidate unchanged-preview point estimates; use debuff_dependencies for scoped ordered damage and current-intent ranges.'] : [])],
    interpretation: 'Numbers exclude omitted effects; an omitted effect is not zero benefit. Compare its full rules, timing and later-turn benefits separately. Equal baselines do not establish equal outcomes.',
    scope: projection.scope
  };
}

// This is a conditional sum of visible previews, not a game simulator. Keeping
// it separate from combat prevents planned outcomes from becoming observations.
export function projectTurnPrefix(state, steps, sequence = inspectSequence(state, steps)) {
  const combat = structuredClone(state.combat), unresolved = [], reactions = [], cardFlowEffects = [];
  for (const entry of sequence.entries) {
    const { sequence: index, step, card } = entry;
    if (step.kind !== 'play_card') { if (!sequence.analysis.steps.find(s => s.sequence === index)?.applies_after_action) unresolved.push(`${step.name}: potion effects are not simulated`); continue; }
    if (!card) { unresolved.push(`${step.name}: card availability is unconfirmed`); continue; }
    if (card.cost < 0 && !card.attack_preview) unresolved.push(`${card.name}: X-cost hit count after earlier spending is unknown`);
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
    combat.player.energy = entry.energy_after;
    combat.player.block = estimate.block_after_card ?? estimate.block_baseline_without_reactions;
    combat.player.hp -= estimate.declared_self_hp_loss || 0;
    const exhausted = new Set(estimate.exhausted_hand_cards?.map(card => card.index));
    combat.hand = combat.hand.filter(other => other.details?.instance_id !== step.card_instance_id && !exhausted.has(other.index));
    if (card.id === 'RAGE' && Number.isFinite(card.rage_block_per_attack)) {
      const power = combat.player.powers.find(power => power.id === 'RAGE_POWER');
      if (power) power.amount += card.rage_block_per_attack;
      else combat.player.powers.push({ id: 'RAGE_POWER', amount: card.rage_block_per_attack });
    }
    // Native FranticEscape changes the current owner's Sandpit counter before
    // the enemy-start decrement. Keep this separate from HP/Block survival.
    const sandpitOwners = combat.enemies.filter(enemy => enemy.is_alive && enemy.powers?.some(p => p.id === 'SANDPIT_POWER'));
    if (card.id === 'FRANTIC_ESCAPE' && sandpitOwners.length === 1) sandpitOwners[0].powers.find(p => p.id === 'SANDPIT_POWER').amount++;
    const dependency = sequence.analysis.steps.find(s => s.sequence === index);
    const covered = card.id === 'RAGE' && Number.isFinite(card.rage_block_per_attack)
      || card.id === 'ARMAMENTS' && dependency?.upgrades_before_later_actions?.every(id => state.combat.hand.find(c => c.details?.instance_id === id)?.upgrade_preview)
      || card.id === 'SETUP_STRIKE' && dependency?.applies_after_action
      || card.id === 'WHIRLWIND' && Number.isFinite(dependency?.damage_instances)
      || card.id === 'FRANTIC_ESCAPE' && sandpitOwners.length === 1;
    if (!covered && !/^(?:Deal [\d.]+ damage\.?|Gain [\d.]+ Block\.?)$/i.test(card.description.trim())) unresolved.push(`${card.name}: only existing damage/Block previews and printed cost/self-loss are counted; other effects are unconfirmed`);
  }
  const end = combatForecast(combat);
  if (sequence.checkpoint) unresolved.push(`Observe after ${sequence.checkpoint.source_id}: ${sequence.checkpoint.reason} No later action or end-turn outcome is promised.`);
  if (sequence.unknown_targets.length || sequence.unknown_block) unresolved.push('A changed modifier has an unresolved preview range; affected damage, Block and final HP are unknown. See sequence_dependencies.');
  if (end.uncomputed_turn_end_effects?.length) unresolved.push('Current turn-end health/damage/Block rules are not calculated; final HP and turn-end Block remain unknown. See uncomputed_turn_end_effects for the current sources and conditions.');
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
  if (timedLossUnresolved) unresolved.push('Known counter changes are listed in loss_deadlines, but uncomputed effects prevent a complete survival conclusion. Evaluate every proposed rule and response availability before the next deadline.');
  const lossDeadlines = (end.death_timers || []).map(timer => ({
    source_id: timer.power_id, owner_combat_id: timer.target_id,
    counter_after_declared_actions: timer.enemy_turns_remaining_after_card,
    counter_after_upcoming_enemy_start: sequence.checkpoint ? null : Math.max(0, timer.enemy_turns_remaining_after_card - 1),
    enemy_starts_until_lethal_without_further_changes: timer.enemy_turns_remaining_after_card,
    known_delay_cards: {
      in_remaining_hand: combat.hand.filter(c => c.id === 'FRANTIC_ESCAPE').map(c => ({ instance_id: c.details.instance_id, cost: c.cost, keywords: c.keywords })),
      in_current_draw_pile: combat.draw_pile.filter(c => c.id === 'FRANTIC_ESCAPE').length,
      in_current_discard_pile: combat.discard_pile.filter(c => c.id === 'FRANTIC_ESCAPE').length,
      draw_pile_size: combat.draw_pile.length
    },
    scope: 'Conditional known counter changes, not a survival proof. Sandpit decrements at each enemy turn start and kills at zero, independent of HP or Block. Ordinary unretained hand cards are discarded at turn end; discarded responses need retrieval or a reshuffle before drawing. Card generation and future retrieval are not guaranteed. A checkpoint can still produce a new continuation before ending.'
  }));
  return {
    scope: 'Conditional arithmetic over the ordered sequence_dependencies, known hit caps, immediate Block/self-loss, Rage, Second Wind and Plating/Orichalcum. Not an observed or fully simulated future. Unknown draws, generated/transformed identities, unsupported modifiers, energy gains, death triggers and future enemy choices require observation. End-turn outcomes are not promised across a checkpoint.',
    remaining_enemies: combat.enemies.map(enemy => ({ combat_id: enemy.combat_id, name: enemy.name, hp: enemy.hp, block: enemy.block, visible_attack: enemy.is_alive ? intentDamage(enemy) : 0 })),
    block: reactions.length || sequence.unknown_block ? null : combat.player.block, block_including_end_turn_gains: reactions.length || sequence.unknown_block || sequence.checkpoint ? null : end.block_including_end_turn_gains, end_turn_block_gains: end.end_turn_block_gains,
    hp_after_declared_self_loss: combat.player.hp,
    hp_if_ending_after_prefix: facingUnresolved || timedLossUnresolved || reactions.length || sequence.unknown_block || sequence.unknown_targets.length || sequence.checkpoint ? null : end.hp_remaining_if_end_turn,
    incoming_attack_after_prefix: facingUnresolved || reactions.length || sequence.unknown_targets.length || sequence.checkpoint ? null : end.displayed_attacks_after_target_depletion,
    uncomputed_reactions: reactions,
    uncomputed_turn_end_effects: end.uncomputed_turn_end_effects || [],
    end_turn_damage_events: end.end_turn_damage_events || [],
    loss_deadlines: lossDeadlines,
    card_flow: describeCardFlow(state.combat, cardFlowEffects),
    ...(positioning ? { positioning } : {}),
    unresolved_effects: [...new Set(unresolved)]
  };
}
