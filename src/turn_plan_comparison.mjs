import { combatForecast, intentDamage, previewHitCount } from './combat_arithmetic.mjs';
import { uncomputedAttackReactions } from './combat_reactions.mjs';

export const planValueLevels = [
  'A losing or seriously wasteful commitment: an avoidable defeat, failed essential dependency, or sacrifice with no credible compensating benefit.',
  'Weak use of this situation: substantial avoidable loss or a missed feasible opportunity, even after accounting for its possible continuation.',
  'A workable compromise: preserves a viable turn, but leaves a meaningful weakness or opportunity compared with available resources.',
  'A strong use of this situation: coherent timing and resource tradeoffs address current threats and further the run, including useful continuation options.',
  'An excellent use of this situation: captures the major feasible benefits with justified costs and no apparent important missed opportunity.'
];

export function planAssessmentQuestions(plans, instructions) {
  return Object.fromEntries(plans.map((_, index) => [`assessment_${index}`, { type: 'score', criteria: planValueLevels,
    instructions: `Evaluate the single proposed plan at analysis.plan_assessments[${index}] against the ACTUAL current situation and available resources, using the same absolute levels for every plan. ${instructions} Read continuation: a checkpoint keeps the player turn and permits another decision with remaining energy and the observed new hand; do not score it as if the player ends immediately. Evaluate that opportunity from the known pool and retained choices, accounting for its costs and constraints without assuming a particular draw. Neither more listed actions nor more certain arithmetic is inherently better. This is a quality assessment, not a comparison with a neighboring item or a probability of winning.` }]));
}

export function resolvePlanAssessments(plans, answers) {
  return plans.map((plan, index) => {
    const answer = answers?.[`assessment_${index}`];
    if (answer?.type !== 'score' || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > planValueLevels.length - 1) throw new Error('Jev returned an invalid turn-plan assessment');
    return { value: plan.value, score: answer.score, probabilities: answer.probabilities, confidence: answer.confidence };
  });
}

// Eligibility is deliberately separate from a model's preference. With no
// represented lethal exposure, better ordinary mitigation is a value trade,
// not permission to override the value judgment. This is not a safety proof.
export function visibleSurvivalConstraints(state) {
  const combat = state.combat, constraints = [];
  const incoming = combat.enemies.filter(enemy => enemy.is_alive && enemy.hp > 0)
    .reduce((sum, enemy) => sum + intentDamage(enemy), 0);
  const selfLoss = combat.hand.reduce((sum, card) => sum + Math.max(0, card.hp_loss || 0), 0);
  const reactionRules = new Set();
  const reactionExposure = combat.hand.reduce((sum, card) => {
    const targets = card.target_type === 'AllEnemies' ? [null] : combat.enemies.filter(enemy => enemy.is_alive && enemy.hp > 0);
    const alternatives = targets.map(target => uncomputedAttackReactions(combat, card, target, previewHitCount(card, target)));
    for (const reaction of alternatives.flat()) reactionRules.add(reaction.source_id);
    return sum + Math.max(0, ...alternatives.map(reactions => reactions.reduce((total, reaction) => total + (reaction.damage_if_all_preview_hits_resolve ?? 0), 0)));
  }, 0);
  const forecast = combatForecast(combat);
  if (incoming + selfLoss + reactionExposure >= combat.player.hp || forecast.fatal_if_end_turn === true && !forecast.instant_death_if_end_turn) {
    constraints.push({ kind: 'potential_lethal_health_loss', current_hp: combat.player.hp,
      displayed_attacks_before_block: incoming, hand_declared_self_loss_upper_bound: selfLoss,
      ...(reactionExposure ? { hand_preview_reaction_exposure: reactionExposure, reaction_rule_ids: [...reactionRules] } : {}),
      scope: 'Conditional exposure only; not all cards are affordable or will be played. Reactive exposure uses known preview hits, largest possible target exposure per single-target card, and excludes unknown hit counts. Evaluate each full plan, reaction timing, prevention and current Block; this is not predicted HP loss.' });
  }
  for (const timer of forecast.death_timers || []) {
    const power = combat.enemies.find(enemy => enemy.combat_id === timer.target_id)?.powers.find(power => power.id === timer.power_id);
    constraints.push({ kind: 'observed_loss_countdown', ...timer, description: power?.description });
  }
  const terminalRule = /\b(?:you|the player|players?)\b[^.]*\b(?:die|dies|dead|death|defeated|lose (?:the )?(?:combat|fight|run))\b|\b(?:lose|set|reduce)[^.]*\b(?:all|0|zero)[^.]*\b(?:HP|health)\b/i;
  const healthLossRule = /\b(?:take|suffer)\b[^.]*\bdamage\b|\blose\b[^.]*\b(?:HP|health)\b/i;
  const inspect = (record, owner, healthEffects = false) => {
    const description = record.description || '';
    if (terminalRule.test(description) || healthEffects && healthLossRule.test(description)) {
      constraints.push({ kind: 'explicit_loss_rule', owner, id: record.id, description,
        scope: 'Current rule requiring evaluation, not a claim it triggers in either proposed plan.' });
    }
  };
  for (const power of combat.player.powers || []) inspect(power, 'player', true);
  for (const enemy of combat.enemies.filter(enemy => enemy.is_alive && enemy.hp > 0)) {
    for (const power of enemy.powers || []) {
      if (!constraints.some(c => c.kind === 'observed_loss_countdown' && c.target_id === enemy.combat_id && c.power_id === power.id)) inspect(power, `enemy:${enemy.combat_id}`);
    }
  }
  for (const card of combat.hand) inspect(card, `hand:${card.index}`);
  for (const relic of combat.player.relics || []) inspect(relic, 'player_relic');
  for (const potion of combat.player.potions || []) inspect(potion, `potion:${potion.slot}`);
  return constraints;
}

// Survival constraints and ordinary value are independent model judgments over
// the same complete alternatives. A favorable damage/Block estimate must not
// compensate for losing the only known response to a fatal mechanic.
export function planComparisonQuestions(pairs, valueInstructions, compareSurvival = true) {
  return Object.fromEntries(pairs.flatMap((_, index) => {
    const location = `The two complete, mutually exclusive proposed plans are at analysis.plan_alternatives[${index}]. They start from the same current observation and have NOT executed.`;
    const questions = [
      [`survival_${index}`, {
        type: 'choice',
        instructions: `${location} Compare only the represented exposures in analysis.survival_constraints, independently of ordinary damage or setup value. Their presence permits this check; it does NOT prove either plan unsafe. Inspect current rules, counters, resources and all piles through the coming enemy response and the next known deadline. Does one plan avoid forced defeat, or preserve a viable response that the other loses before it can be used? Positive HP/Block arithmetic does not establish safety against other loss conditions. Account for where response cards go and whether they can be available in time; unknown draws, random rewards and unconfirmed retrieval are not guaranteed rescues. Prefer a side only for a concrete survival constraint supported by the visible facts. Ordinary nonlethal HP trades and speculative distant threats belong in the value comparison. If neither side has an established advantage on these constraints, choose no_clear_difference.`,
        criteria: {
          plan_a: 'Plan A has the supported survival-constraint advantage.',
          plan_b: 'Plan B has the supported survival-constraint advantage.',
          no_clear_difference: 'No supported survival-constraint advantage separates these plans; compare their overall value.'
        }
      }],
      [`comparison_${index}`, {
        type: 'choice', instructions: `${location} ${valueInstructions} Choose no_clear_difference when the available evidence does not establish an overall advantage for either plan, including equivalent outcomes or unresolved tradeoffs. Do not invent a preference merely because two plans were offered. Uncertainty alone does not erase a supported advantage in survival, progress, lasting effects or resource costs.`,
        criteria: { plan_a: 'Complete plan A has the supported overall advantage.', plan_b: 'Complete plan B has the supported overall advantage.',
          no_clear_difference: 'The available evidence does not establish an overall advantage for either complete plan.' }
      }]
    ];
    return compareSurvival ? questions : questions.slice(1);
  }));
}

export function resolvePlanComparisons(pairs, answers, compareSurvival = true) {
  return pairs.map((pair, index) => {
    const survival = answers?.[`survival_${index}`], value = answers?.[`comparison_${index}`];
    if (compareSurvival && (survival?.type !== 'choice' || !['plan_a', 'plan_b', 'no_clear_difference'].includes(survival.choice))
      || value?.type !== 'choice' || !['plan_a', 'plan_b', 'no_clear_difference'].includes(value.choice)) {
      throw new Error('Jev returned an invalid turn-plan comparison');
    }
    const selectionBasis = !compareSurvival || survival.choice === 'no_clear_difference' ? 'overall_value' : 'survival_constraint';
    const selected = selectionBasis === 'overall_value' ? value : survival;
    return { selected: selected.choice === 'no_clear_difference' ? null : pair[selected.choice === 'plan_a' ? 0 : 1].value,
      options: { plan_a: pair[0].value, plan_b: pair[1].value },
      selection_basis: selectionBasis,
      survival_assessment: compareSurvival ? survival : null, value_assessment: value,
      probabilities: selected.probabilities, confidence: selected.confidence };
  });
}
