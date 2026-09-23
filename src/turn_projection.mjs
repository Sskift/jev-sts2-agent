import { attackHpLoss, combatForecast, combatForecastBaseline, intentDamage, knownStunThreshold, uncomputedDepletionRules } from './combat_arithmetic.mjs';
import { forecastCoverage, coverageAffects } from './forecast_coverage.mjs';
import { projectPositioning } from './combat_positioning.mjs';
import { reserveActionSequence } from './turn_action_constraints.mjs';
import { describeCardFlow } from './card_flow_projection.mjs';
import { projectDebuffDependencies, modeledPowerChanges } from './turn_debuff_projection.mjs';
import { describeEffectLifecycle } from './effect_lifecycle.mjs';
import { inspectSequence } from './turn_sequence.mjs';
import { encounterProgress } from './strategy_knowledge.mjs';
import { supportedNativePreviewRule } from './rule_scope.mjs';

export function sequenceEnergyBudget(state, steps) {
  const sequence = inspectSequence(state, steps);
  if (sequence.transitions.length !== steps.length) return null;
  return { energy_left: sequence.energy_left, costs: sequence.costs, transitions: sequence.transitions,
    affordable: !sequence.violations.length && sequence.transitions.every(step => step.affordable) };
}

export function reserveSequence(state, steps) {
  const budget = sequenceEnergyBudget(state, steps);
  if (!budget?.affordable || !reserveActionSequence(state, steps).valid) return null;
  for (let index = 1; index < steps.length; index++) {
    if (steps[index].kind === 'end_turn') continue;
    const unavailable = unavailableTargetsAfterPrefix(state, steps.slice(0, index));
    if (unavailable.includes(steps[index].target)
      || unavailable.length && state.combat.enemies.filter(e => e.is_alive && e.hp > 0).every(e => unavailable.includes(e.combat_id))) return null;
  }
  return { energy_left: budget.energy_left, costs: budget.costs };
}

// Reuse the same ordered arithmetic as plan comparison. Only a prefix with
// no unresolved effects can establish that a later explicit target is gone.
// Draw checkpoints, revival/death hooks and uncertain modifiers stay unknown.
export function unavailableTargetsAfterPrefix(state, steps) {
  if (!steps.length || !steps.some(step => step.kind === 'use_potion'
    || state.combat.hand.some(card => card.details?.instance_id === step.card_instance_id && card.type === 'Attack'))) return [];
  const projection = describeTurnProjection(state, steps);
  if (projection.omitted_effects.length || projection.sequence_dependencies.checkpoint) return [];
  return projection.known_effects_only.enemies.filter(enemy => enemy.hp === 0
    && state.combat.enemies.some(current => current.combat_id === enemy.combat_id && current.is_alive && current.hp > 0)).map(enemy => enemy.combat_id);
}

function checkpointAttackBalance(projection, responseUnresolved, energy, coverage) {
  const hp = projection.uncomputed_reactions.length || coverageAffects(coverage, 'player_hp') ? null : projection.hp_after_declared_self_loss;
  const block = coverageAffects(coverage, 'player_block') ? null : projection.block;
  const attack = responseUnresolved ? null : projection.current_attack_after_known_prefix;
  const uncovered = attack === null || block === null ? null : Math.max(0, attack - block);
  const margin = hp === null || uncovered === null ? null : hp - uncovered;
  return { is_end_turn_prediction: false, energy_after_known_payments: energy,
    hp_after_declared_self_loss: hp, block_from_known_prefix: block, current_attack_after_known_prefix: attack,
    attack_damage_not_covered_by_known_block: uncovered, hp_margin_against_current_attacks: margin,
    additional_attack_mitigation_to_leave_positive_hp: margin === null ? null : Math.max(0, 1 - margin),
    scope: 'Attack-only balance at an observation checkpoint using the declared known prefix. A negative margin is a remaining exposure, not a promised death or end-turn result. Excludes unresolved draws, healing, reactions, automatic end-turn gains/losses and later actions. Compare the remaining energy, hand and draw pool to judge possible responses; no particular draw or rescue is guaranteed.' };
}

// Keep omitted effects next to an explicitly scoped baseline. A plan containing
// a potion or another unresolved effect must not claim its final HP/damage
// equals that of an otherwise identical plan without it.
export function describeTurnProjection(state, steps) {
  const sequence = inspectSequence(state, steps);
  const debuffs = projectDebuffDependencies(state, steps, sequence.entries, sequence.analysis);
  const resolved = (debuffs?.enemies || []).filter(result => {
    const before = state.combat.enemies.find(e => e.combat_id === result.combat_id);
    return [result.hp_remaining, result.block_remaining, result.current_attack_after_debuffs, ...result.power_changes.map(p => p.after_declared_actions)]
        .every(range => Number.isFinite(range.min) && range.min === range.max)
      && (result.hp_remaining.max === 0 || result.current_attack_after_debuffs.min === intentDamage(before)
        || Boolean(result.attack_intents_after_debuffs));
  });
  const knownResponses = new Set((debuffs?.enemies || []).filter(result => {
    const before = state.combat.enemies.find(e => e.combat_id === result.combat_id);
    return result.hp_remaining.min > 0 && result.current_attack_after_debuffs.min === intentDamage(before)
      && result.current_attack_after_debuffs.max === intentDamage(before) || resolved.some(e => e.combat_id === result.combat_id);
  }).map(result => result.combat_id));
  const projection = projectTurnPrefix(state, steps, { ...sequence, unknown_targets: sequence.unknown_targets.filter(id => !knownResponses.has(id)) },
    { enemies: resolved, applications: debuffs?.transitions || [], ordered_damage: debuffs?.ordered_damage || [] });
  const coverage = forecastCoverage(state.combat, null, { sequence: true, uncomputedActions: projection.uncomputed_actions,
    playedCards: sequence.entries.map(entry => entry.card).filter(Boolean) });
  const unknownActions = coverageAffects(coverage, 'enemy_hp');
  const unknownResponse = coverageAffects(coverage, 'enemy_response');
  if (coverage.uncovered_effects.length) projection.unresolved_effects.push('Active effects outside numeric coverage invalidate future totals. Read calculation_coverage and the complete current rules.');
  const lifecycle = describeEffectLifecycle(state, steps);
  const affected = new Set([...(debuffs?.affected_target_ids || []), ...sequence.unknown_targets].filter(id => !resolved.some(e => e.combat_id === id)));
  if (unknownActions) for (const enemy of state.combat.enemies) affected.add(enemy.combat_id);
  for (const reaction of projection.uncomputed_reactions) affected.add(reaction.owner_combat_id);
  const depletionEffects = projection.remaining_enemies.flatMap(enemy => {
    const before = state.combat.enemies.find(e => e.combat_id === enemy.combat_id);
    return enemy.hp <= 0 && before.hp > 0 ? uncomputedDepletionRules(before).map(power => ({ owner_combat_id: enemy.combat_id, source_id: power.id, description: power.description })) : [];
  });
  for (const effect of depletionEffects) affected.add(effect.owner_combat_id);
  // A rounded damage range can leave the enemy certainly alive with the same
  // displayed attack. Its uncertain HP must not erase an independent response.
  // Possible depletion, changed attacks and other unknown modifiers still do.
  const responseUnresolved = unknownResponse || projection.uncomputed_reactions.length > 0 || [...affected].some(id => {
    const result = debuffs?.enemies.find(e => e.combat_id === id);
    const before = state.combat.enemies.find(e => e.combat_id === id);
    return !result || !(result.hp_remaining.min > 0)
      || result.current_attack_after_debuffs.min !== intentDamage(before)
      || result.current_attack_after_debuffs.max !== intentDamage(before);
  });
  const hp = responseUnresolved || projection.unresolved_effects.length ? null : projection.hp_if_ending_after_prefix;
  return {
    calculation_status: projection.unresolved_effects.length || debuffs || depletionEffects.length ? 'incomplete' : 'preview_arithmetic',
    calculation_coverage: coverage,
    fully_simulated: false,
    known_effects_only: {
      block: coverageAffects(coverage, 'player_block') ? null : projection.block, hp_if_ending: hp,
      hp_loss_if_ending: hp === null ? null : state.combat.player.hp - hp,
      block_including_end_turn_gains: coverageAffects(coverage, 'player_block') || depletionEffects.length ? null : projection.block_including_end_turn_gains,
      end_turn_block_gains: projection.end_turn_block_gains,
      end_turn_damage_events: projection.end_turn_damage_events,
      ...(projection.threshold_reactions.length && !unknownActions ? { threshold_reactions: projection.threshold_reactions } : {}),
      incoming_attack: responseUnresolved ? null : projection.incoming_attack_after_prefix,
      enemies: projection.remaining_enemies.map(({ combat_id, hp, block }) => {
        const before = state.combat.enemies.find(enemy => enemy.combat_id === combat_id);
        const after = projection.remaining_enemies.find(enemy => enemy.combat_id === combat_id);
        const dependency = debuffs?.enemies.find(e => e.combat_id === combat_id);
        const powerChanges = !unknownActions && dependency?.power_changes
          || modeledPowerChanges(before, [after], affected.has(combat_id));
        if (affected.has(combat_id)) {
          const range = dependency?.hp_remaining;
          const bounded = !unknownActions && Number.isFinite(range?.min) && Number.isFinite(range?.max)
            && !depletionEffects.some(e => e.owner_combat_id === combat_id);
          return { combat_id, hp: null, block: null, hp_removed: null, block_removed: null, power_changes: powerChanges,
            ...(bounded ? { conditional_bounds: { hp: range, hp_removed: { min: before.hp - range.max, max: before.hp - range.min }, block: dependency.block_remaining } } : {}) };
        }
        return { combat_id, hp, block, hp_removed: before.hp - hp, block_removed: before.block - block, power_changes: powerChanges };
      })
    },
    ...(sequence.checkpoint ? { checkpoint_attack_balance: checkpointAttackBalance(projection, responseUnresolved, sequence.energy_left, coverage) } : {}),
    ...(projection.positioning ? { positioning: projection.positioning } : {}),
    ...(projection.uncomputed_reactions.length ? { uncomputed_reactions: projection.uncomputed_reactions } : {}),
    ...(projection.uncomputed_death_prevention.length ? { uncomputed_death_prevention: projection.uncomputed_death_prevention } : {}),
    ...(projection.card_flow ? { card_flow: projection.card_flow } : {}),
    ...(debuffs && !unknownActions ? { debuff_dependencies: debuffs } : {}),
    ...(lifecycle ? { effect_lifecycle: lifecycle } : {}),
    sequence_dependencies: { ...sequence.analysis, steps: sequence.analysis.steps.map(step => {
      const ordered = debuffs?.ordered_damage.filter(effect => effect.sequence === step.sequence) || [];
      const effects = projection.attack_effects.filter(effect => effect.sequence === step.sequence).map(effect => {
        const updated = ordered.find(e => e.target_id === effect.target_id)?.after_block_and_hp_loss_caps;
        return updated ? { ...effect,
          hp_removed: updated.hp_removed.min === updated.hp_removed.max ? updated.hp_removed.min : null,
          block_removed: updated.block_removed.min === updated.block_removed.max ? updated.block_removed.min : null,
          applied_hp_loss_limits: updated.applied_hp_loss_limits } : effect;
      });
      const damage = step.damage_per_target?.map(effect => {
        const updated = ordered.find(e => e.target_id === effect.target_id);
        return updated ? { ...effect, per_hit_before_block_and_hp_loss_caps: updated.per_hit,
          total_before_block_and_hp_loss_caps: Object.fromEntries(['min', 'max'].map(bound => [bound,
            updated.per_hit[bound] === null || updated.preview_hits === null ? null : updated.per_hit[bound] * updated.preview_hits])) } : effect;
      });
      const hitCounts = ordered.map(effect => effect.preview_hits);
      return { ...step, ...(hitCounts.length ? { damage_instances: hitCounts.every(hits => hits === hitCounts[0]) ? hitCounts[0] : null } : {}),
        ...(damage ? { damage_per_target: damage } : {}),
        ...(effects.length ? { after_block_and_hp_loss_caps: effects.map(({ sequence: _sequence, ...effect }) =>
          affected.has(effect.target_id) ? { ...effect, hp_removed: null, block_removed: null, limitation: 'Unresolved modifiers or depletion hooks invalidate this point estimate; see dependency ranges.' } : effect) } : {}) };
    }) },
    ...(depletionEffects.length ? { uncomputed_depletion_effects: depletionEffects } : {}),
    encounter_progress: encounterProgress(state.combat, projection.remaining_enemies, [...affected]),
    ...(projection.loss_deadlines.length ? { loss_deadlines: projection.loss_deadlines } : {}),
    ...(projection.uncomputed_turn_end_effects.length ? { uncomputed_turn_end_effects: projection.uncomputed_turn_end_effects } : {}),
    omitted_effects: [...projection.unresolved_effects, ...(affected.size ? ['Changed modifiers or uncomputed depletion hooks invalidate affected preview estimates; use the listed dependencies and rules.'] : []),
      ...(depletionEffects.length ? ['Death/revival hooks are not simulated. Depleting this HP bar does not establish a removed enemy, canceled intent, or ended combat.'] : [])],
    interpretation: 'Numbers exclude omitted effects; an omitted effect is not zero benefit. Compare its full rules, timing and later-turn benefits separately. Equal baselines do not establish equal outcomes.',
    scope: projection.scope
  };
}

// This is a conditional sum of visible previews, not a game simulator. Keeping
// it separate from combat prevents planned outcomes from becoming observations.
export function projectTurnPrefix(state, steps, sequence = inspectSequence(state, steps), dependencies = { enemies: [], applications: [] }) {
  const combat = structuredClone(state.combat), unresolved = [], reactions = [], cardFlowEffects = [], attackEffects = [], uncomputedActions = [];
  const uncomputedAction = (entry, source, reason) => {
    unresolved.push(reason);
    uncomputedActions.push({ category: entry.step.kind, owner: 'player', sequence: entry.sequence,
      source_id: source?.id || entry.step.potion_id || entry.step.card_instance_id, live_rule: source?.description || '', reason });
  };
  for (const entry of sequence.entries) {
    const { sequence: index, step } = entry;
    let card = entry.card;
    // The debuff walk already knows whether a preceding application changed
    // the target's hit condition. Reuse that count for HP caps and reactions,
    // rather than rereading the unchanged native target in this separate walk.
    const counts = (dependencies.ordered_damage || []).filter(effect => effect.sequence === index).map(effect => effect.preview_hits);
    if (card?.type === 'Attack' && counts.length) card = { ...card,
      _ordered_hit_count: counts.every(hits => hits === counts[0]) ? counts[0] : null };
    // A passive after-play reaction does not cover the card's own effects.
    const applications = dependencies.applications.filter(effect => effect.sequence === index && effect.timing !== 'after_card_play');
    const supportedApplication = applications.length > 0 && applications.every(effect => effect.outcome !== 'unresolved');
    if (step.kind !== 'play_card') {
      if (!supportedApplication && !sequence.analysis.steps.find(s => s.sequence === index)?.applies_after_action)
        uncomputedAction(entry, combat.player.potions?.find(p => p.slot === step.slot), `${step.name}: potion effects are not simulated`);
      continue;
    }
    if (!card) { uncomputedAction(entry, null, `${step.name}: card availability is unconfirmed`); continue; }
    if (card.cost < 0 && !card.attack_preview) unresolved.push(`${card.name}: X-cost hit count after earlier spending is unknown`);
    const target = combat.enemies.find(enemy => enemy.combat_id === step.target);
    // Keep immediate Block separate from effects due only at turn end.
    const estimate = combatForecastBaseline(combat, card, target);
    for (const reaction of estimate.uncomputed_reactions || []) reactions.push({ sequence: index, ...reaction });
    for (const effect of estimate.card_flow?.effects || []) cardFlowEffects.push({ sequence: index, ...effect });
    if (estimate.block_preview?.amount === null) unresolved.push(`${card.name}: Block contribution is unknown, not zero; HP arithmetic omits it`);
    const targets = card.target_type === 'AllEnemies' ? combat.enemies.filter(enemy => enemy.is_alive && enemy.hp > 0) : target ? [target] : [];
    for (const enemy of targets) {
      const hit = attackHpLoss(card, enemy);
      if (card.type === 'Attack') attackEffects.push({ sequence: index, target_id: enemy.combat_id,
        hits_counted: hit?.hits ?? null, hp_removed: hit ? Math.min(enemy.hp, hit.hp_loss) : null,
        block_removed: hit ? enemy.block - hit.block_after : null, applied_hp_loss_limits: hit?.limits ?? [],
        scope: 'Conditional arithmetic for the counted hits, after current target Block and supported HP-loss caps. Other triggers, changed modifiers and death effects may invalidate it. These are not the pre-prevention damage numbers.' });
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
    const covered = supportedApplication || supportedNativePreviewRule(card) || card.id === 'RAGE' && Number.isFinite(card.rage_block_per_attack)
      || card.id === 'ARMAMENTS' && dependency?.upgrades_before_later_actions?.every(id => state.combat.hand.find(c => c.details?.instance_id === id)?.upgrade_preview)
      || card.id === 'SETUP_STRIKE' && dependency?.applies_after_action
      || ['INFLAME', 'FOOTWORK'].includes(card.id) && dependency?.applies_after_action
      || card.id === 'WHIRLWIND' && /^Deal [\d.]+ damage(?: to ALL enemies)? X times\.$/i.test(card.description.trim())
      || card.id === 'SECOND_WIND' && Number.isFinite(card.block)
      || card.id === 'DISMANTLE' && /^Deal [\d.]+ damage\. If the enemy is Vulnerable, hits twice\.$/i.test(card.description.trim())
      || card.id === 'BREAKTHROUGH' && /^Lose \d+ HP\. Deal [\d.]+ damage to ALL enemies\.$/i.test(card.description.trim())
      || card.id === 'FRANTIC_ESCAPE' && sandpitOwners.length === 1;
    // An unconditional draw ends the prefix. Its preceding plain damage/Block
    // remains computable; the drawn identities and resulting turn stay unknown.
    const drawCheckpoint = sequence.checkpoint && /^(?:(?:Deal [\d.]+ damage|Gain [\d.]+ Block)\. )?Draw \d+ cards?\.$/i.test(card.description.trim());
    if (!covered && !drawCheckpoint && !/^(?:Deal [\d.]+ damage(?: to ALL enemies)?(?: (?:\d+ times|twice|thrice))?\.?|Gain [\d.]+ Block\.?)$/i.test(card.description.trim()))
      uncomputedAction(entry, card, `${card.name}: only existing damage/Block previews and printed cost/self-loss are counted; other effects are unconfirmed`);
  }
  // Reconcile exact dependency bounds BEFORE calculating incoming damage and
  // turn-end hooks. A supported debuff must not erase a known HP/counter result
  // or leave an unchanged-preview value beside a different ordered result.
  for (const result of dependencies.enemies) {
    const enemy = combat.enemies.find(e => e.combat_id === result.combat_id);
    enemy.hp = result.hp_remaining.min; enemy.block = result.block_remaining.min; enemy.is_alive = enemy.hp > 0;
    if (result.attack_intents_after_debuffs) for (const intent of result.attack_intents_after_debuffs) {
      if (enemy.intents[intent.index]?.type === 'Attack') enemy.intents[intent.index].damage = intent.damage;
    }
    for (const change of result.power_changes) {
      const power = enemy.powers.find(p => p.id === change.power_id);
      if (power) power.amount = change.after_declared_actions.min;
      else enemy.powers.push({ id: change.power_id, amount: change.after_declared_actions.min });
    }
  }
  const thresholdReactions = [];
  for (const enemy of combat.enemies) {
    const before = state.combat.enemies.find(original => original.combat_id === enemy.combat_id);
    const trigger = knownStunThreshold(before, before.hp - enemy.hp);
    if (trigger === null || reactions.length || sequence.unknown_targets.includes(enemy.combat_id)
      || !attackEffects.some(effect => effect.target_id === enemy.combat_id && effect.hp_removed > 0)) continue;
    // This is a conditional projection from known damage, never a mutation of
    // the native observation. The actual action must still be confirmed.
    enemy.powers = enemy.powers.filter(power => power.id !== trigger.source_id
      && !(trigger.removes_strength && power.id === 'STRENGTH_POWER'));
    enemy.intents = [];
    thresholdReactions.push({ target_id: enemy.combat_id, source_id: trigger.source_id, threshold: trigger.threshold,
      hp_after_known_actions: enemy.hp, consequence: trigger.removes_strength
        ? 'Stunned before the upcoming enemy action; Strength removed' : 'Stunned before the upcoming enemy action', is_observed: false });
  }
  const end = combatForecast(combat);
  if (sequence.checkpoint) unresolved.push(`Observe after ${sequence.checkpoint.source_id}: ${sequence.checkpoint.reason} No later action or end-turn outcome is promised.`);
  if (sequence.unknown_targets.length || sequence.unknown_block) unresolved.push('A changed modifier has an unresolved preview range; affected damage, Block and final HP are unknown. See sequence_dependencies.');
  if (end.uncomputed_turn_end_effects?.length) unresolved.push('Current turn-end health/damage/Block rules are not calculated; final HP and turn-end Block remain unknown. See uncomputed_turn_end_effects for the current sources and conditions.');
  if (end.uncomputed_death_prevention?.length) unresolved.push('An automatic death-prevention potion may be consumed. Revival timing and later damage are not simulated; final HP and survival remain unknown. See uncomputed_death_prevention.');
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
    scope: 'Conditional arithmetic over the ordered sequence_dependencies, known hit caps, immediate Block/self-loss, Rage, Second Wind, Plating/Orichalcum and exact HP-threshold stun reactions. Not an observed or fully simulated future. Unknown draws, generated/transformed identities, unsupported modifiers, energy gains, death triggers and future enemy choices require observation. End-turn outcomes are not promised across a checkpoint.',
    remaining_enemies: combat.enemies.map(enemy => ({ combat_id: enemy.combat_id, name: enemy.name, hp: enemy.hp, block: enemy.block, powers: enemy.powers, visible_attack: enemy.is_alive ? intentDamage(enemy) : 0 })),
    block: reactions.length || sequence.unknown_block ? null : combat.player.block, block_including_end_turn_gains: reactions.length || sequence.unknown_block || sequence.checkpoint ? null : end.block_including_end_turn_gains, end_turn_block_gains: end.end_turn_block_gains,
    hp_after_declared_self_loss: combat.player.hp,
    current_attack_after_known_prefix: facingUnresolved || reactions.length || sequence.unknown_targets.length ? null : end.displayed_attacks_after_target_depletion,
    hp_if_ending_after_prefix: facingUnresolved || timedLossUnresolved || reactions.length || sequence.unknown_block || sequence.unknown_targets.length || sequence.checkpoint ? null : end.hp_remaining_if_end_turn,
    incoming_attack_after_prefix: facingUnresolved || reactions.length || sequence.unknown_targets.length || sequence.checkpoint ? null : end.displayed_attacks_after_target_depletion,
    uncomputed_reactions: reactions,
    uncomputed_actions: uncomputedActions,
    uncomputed_death_prevention: end.uncomputed_death_prevention || [],
    attack_effects: attackEffects,
    threshold_reactions: thresholdReactions,
    uncomputed_turn_end_effects: end.uncomputed_turn_end_effects || [],
    end_turn_damage_events: end.end_turn_damage_events || [],
    loss_deadlines: lossDeadlines,
    card_flow: describeCardFlow(state.combat, cardFlowEffects),
    ...(positioning ? { positioning } : {}),
    unresolved_effects: [...new Set(unresolved)]
  };
}
