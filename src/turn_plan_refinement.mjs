import { planStep, cardInstance } from './turn_plan_state.mjs';
import { describeTurnProjection, reserveSequence } from './turn_projection.mjs';
import { potionEffectFacts } from './potion_effects.mjs';
import { handUpgradeMode, nextCardKind, preservesPlanDependencies } from './turn_effects.mjs';
import { reserveActionSequence } from './turn_action_constraints.mjs';
import { inspectSequence } from './turn_sequence.mjs';
import { independentTurnCandidates, compareFinalists, planSignature, planAllocation, shortlistPlans } from './turn_candidates.mjs';
import { describeContinuation } from './card_flow_projection.mjs';
import { intentDamage } from './combat_arithmetic.mjs';
import { ContextError } from './decision_context.mjs';

const signature = planSignature;
const bindFollowthrough = (step, following) => {
  const consumer = nextCardKind(step.rules_at_planning);
  const next = following.find(candidate => candidate.kind === 'play_card'
    && (!consumer || consumer === 'Any' || candidate.card_type === consumer));
  if (!next) return step;
  if (handUpgradeMode(step.rules_at_planning) || consumer) {
    step.role = 'preparation'; step.beneficiary_instance_id = next.card_instance_id; step.beneficiary_name = next.name;
    if (consumer) { step.next_card_instance_id = next.card_instance_id; step.next_card_type = consumer; }
  }
  return step;
};

// Share the same resource and consequence accounting at every plan boundary.
export function describePlanAlternative(state, steps) {
  const budget = reserveSequence(state, steps);
  const actions = reserveActionSequence(state, steps);
  const sequence = inspectSequence(state, steps), projection = describeTurnProjection(state, steps);
  const usedPotions = new Set(sequence.entries.filter(e => e.potion).map(e => e.potion.slot));
  const potions = (state.combat.player.potions || []).map(p => ({ id: p.id, slot: p.slot }));
  const automaticPotions = new Set((state.combat.player.potions || []).filter(p => p.usage === 'Automatic').map(p => p.slot));
  const conditionalPotions = new Set((projection.uncomputed_death_prevention || []).map(effect => effect.potion_slot));
  const known = projection.known_effects_only;
  const currentAttack = state.combat.enemies.filter(e => e.is_alive && e.hp > 0).reduce((sum, e) => sum + intentDamage(e), 0);
  const blockable = known.incoming_attack === null ? null : known.incoming_attack + known.end_turn_damage_events.reduce((sum, event) => sum + event.amount, 0);
  let energyAfterPrintedCosts = state.combat.player.energy;
  return {
    resource_consequences: {
      current_displayed_attack_damage: currentAttack,
      consumed_potions: potions.filter(p => usedPotions.has(p.slot)),
      potions_still_available: potions.filter(p => !usedPotions.has(p.slot) && !conditionalPotions.has(p.slot) && !automaticPotions.has(p.slot)),
      ...(automaticPotions.size ? { automatic_potions_held_until_triggered: potions.filter(p => automaticPotions.has(p.slot)) } : {}),
      ...(conditionalPotions.size ? { potions_consumed_if_death_prevention_triggers: potions.filter(p => conditionalPotions.has(p.slot)) } : {}),
      known_blockable_damage_before_block: blockable,
      block_unused_by_known_damage: blockable === null || known.block_including_end_turn_gains === null ? null : Math.max(0, known.block_including_end_turn_gains - blockable),
      ordinary_block_reset: 'At the next owner turn start; it protects through this enemy response, but does not carry to a later enemy turn without a retention rule.',
      scope: 'Conditional on the declared actions. Consumed potions are unavailable afterward; held automatic potions remain armed until their conditions trigger, and their final inventory is not simulated. Block accounting covers only calculated incoming damage; evaluate uncomputed triggers, retention and other uses of Block from the current rules.'
    },
    ordered_sequence: steps.filter(step => step.kind !== 'end_turn').map((step, index) => {
      energyAfterPrintedCosts -= budget.costs[index];
      const beneficiary = state.combat.hand.find(card => cardInstance(card) === (step.beneficiary_instance_id || step.next_card_instance_id));
      const card = state.combat.hand.find(card => cardInstance(card) === step.card_instance_id);
      const potionEffect = step.kind === 'use_potion' ? potionEffectFacts(state.combat.player.potions.find(p => p.id === step.potion_id && p.slot === step.slot)) : null;
      return { action: step.name, ...(card ? { hand_index: card.index, printed_cost: card.cost } : {}), ...(step.target !== undefined ? { target: step.target } : {}), rules: step.rules_at_planning,
        ...(potionEffect ? { effect_facts: potionEffect } : {}),
        energy_after_reserved_costs: energyAfterPrintedCosts,
        ...(beneficiary ? { intended_followthrough: beneficiary.name,
          ...(handUpgradeMode(step.rules_at_planning) ? { upgrade_payoff: beneficiary.name, inspectable_upgrade: beneficiary.upgrade_preview ?? null } : {}) } : {}) };
    }),
    then: sequence.checkpoint ? 'Observe the changed native state and replan the remaining turn; no end-turn command is promised.' : 'End turn, unless a new observation requires a revision.',
    continuation: describeContinuation(state.combat, sequence),
    energy_left: budget.energy_left, energy_spent: state.combat.player.energy - budget.energy_left,
    conditional_preview: projection,
    ...(actions.constraints.length ? { action_reservation: actions } : {}),
    limitation: 'Use ordered sequence dependencies and scoped calculations. Unresolved changes require observation; a checkpoint is not an end-turn outcome.'
  };
}

// Compare concrete complete plans, not another disconnected next-card choice.
// These are bounded local alternatives, not an exhaustive solver. Every current
// legal action remains available in the main planning stages.
export async function refineTurnPlan(state, plan, prepared, comparePairs, assessPlans) {
  // An observation segment is also a complete alternative. The trailing end
  // marker is removed before dispatch when the selected sequence checkpoints.
  if (plan.steps.at(-1)?.kind !== 'end_turn') {
    const finish = [...prepared.candidates.values()].find(c => c.request.cmd === 'end_turn');
    if (!finish) return;
    plan.steps.push(planStep(state, finish, 'finish_turn'));
  }
  const initialBudget = reserveSequence(state, plan.steps);
  if (!initialBudget) throw new ContextError('Turn-plan refinement requires an affordable, valid ordered seed');
  const labels = new Map();
  const label = steps => {
    const key = signature(steps);
    if (!labels.has(key)) labels.set(key, describePlanAlternative(state, steps));
    return labels.get(key);
  };
  plan.end_policy = inspectSequence(state, plan.steps).checkpoint ? 'review_after_segment' : 'end_after_steps_unless_conditions_change';
  // One neighborhood plus independent search; each sequence is described once.
  // Every candidate is an alternative to the entire unexecuted seed.
  const seen = new Set([signature(plan.steps)]);
  const end = plan.steps.at(-1), prefix = plan.steps.slice(0, -1), alternatives = new Map([['keep', plan.steps]]);
  const add = steps => {
    const key = signature(steps);
    if (seen.has(key) || !reserveSequence(state, steps) || !preservesPlanDependencies(steps)) return;
    if ((plan.retained_cards || []).some(card => card.prerequisite
      && !steps.some(step => (step.card_id || step.potion_id) === card.prerequisite))) return;
    const cards = [...steps, ...(plan.retained_cards || [])].map(step => step.card_instance_id).filter(Boolean);
    const potions = steps.filter(step => step.kind === 'use_potion').map(step => step.slot);
    if (new Set(cards).size !== cards.length || new Set(potions).size !== potions.length) return;
    seen.add(key); alternatives.set(`variant_${alternatives.size}`, steps);
    return true;
  };
  const independent = independentTurnCandidates(state, prepared.candidates);
  for (const steps of independent.plans) add(steps);
  plan.candidate_coverage = independent.coverage;
  // A useful plan can contain a redundant action. Offer its removal as a
  // complete alternative, leaving the saved resources available after draw.
  // Dependency and retained automatic-play checks still apply in add().
  for (let index = 0; index < prefix.length; index++) {
    add([...prefix.filter((_, position) => position !== index), end]);
  }
  // Adjacent swaps explicitly test local timing, e.g. Vulnerable before an
  // attack. One insertion tests whether stopping leaves a useful card unused.
  for (let index = 0; index + 1 < prefix.length; index++) {
    const copy = structuredClone(prefix); [copy[index], copy[index + 1]] = [copy[index + 1], copy[index]];
    add([...copy, end]);
  }
  // An expensive payoff can crowd out useful defense or setup even when its
  // order is correct. Compare substitutions (including target changes), and
  // offer concrete continuations using released energy. Never reuse one
  // physical card or consume a card reserved for an automatic effect.
  const releasedEnergyPlans = [], originalEnergy = initialBudget.energy_left;
  for (let index = 0; index < prefix.length; index++) {
    for (const candidate of prepared.candidates.values()) {
      if (!['play_card', 'use_potion'].includes(candidate.request.cmd)) continue;
      const replacement = bindFollowthrough(planStep(state, candidate), prefix.slice(index + 1));
      const replaced = [...prefix.slice(0, index), replacement, ...prefix.slice(index + 1), end];
      if (add(replaced) && reserveSequence(state, replaced).energy_left > originalEnergy) releasedEnergyPlans.push(replaced);
    }
  }
  // A single stronger play may replace TWO existing plays. One-to-one
  // substitutions cannot express this when the new card costs more than
  // either old card but fits after both are removed. Preserve the order of
  // all remaining actions, and compare both original placement positions.
  let consolidatedAdded = 0;
  consolidated: for (const candidate of prepared.candidates.values()) {
    if (!['play_card', 'use_potion'].includes(candidate.request.cmd)) continue;
    const newStep = planStep(state, candidate);
    // This neighborhood adds an unused resource. Recreating an existing
    // preparation would erase its already selected beneficiary/dependency.
    if (prefix.some(step => newStep.kind === 'play_card'
      ? step.card_instance_id === newStep.card_instance_id
      : step.kind === 'use_potion' && step.slot === newStep.slot)) continue;
    for (let first = 0; first + 1 < prefix.length; first++) {
      for (let second = first + 1; second < prefix.length; second++) {
        for (const position of new Set([first, second - 1])) {
          const remaining = structuredClone(prefix.filter((_, index) => index !== first && index !== second));
          const replacement = bindFollowthrough(planStep(state, candidate), remaining.slice(position));
          remaining.splice(position, 0, replacement);
          if (add([...remaining, end])) consolidatedAdded++;
          if (consolidatedAdded >= 96) {
            plan.refinement_limit = 'Two-to-one substitutions were bounded to 96 alternatives per refinement; this is not exhaustive search.';
            break consolidated;
          }
        }
      }
    }
  }
  // Compare a cheaper substitution together with a concrete use of its
  // released energy. Otherwise a plan ending with spare energy can lose to
  // the incumbent before its defense/setup follow-through is even offered.
  // This optional neighborhood is bounded and round-robins substitutions;
  // the main planning stages still expose every actual legal action.
  let coupledAdded = 0;
  coupled: for (const candidate of prepared.candidates.values()) {
    if (!['play_card', 'use_potion'].includes(candidate.request.cmd)) continue;
    for (const replaced of releasedEnergyPlans) {
      if (add([...replaced.slice(0, -1), planStep(state, candidate), end])) coupledAdded++;
      if (coupledAdded >= 96) { plan.refinement_limit = 'Coupled cheaper-substitution continuations were bounded to 96 alternatives per refinement; this is not exhaustive search.'; break coupled; }
    }
  }
  const occupiedCards = new Set([...prefix, ...(plan.retained_cards || [])].map(step => step.card_instance_id).filter(Boolean));
  const occupiedPotions = new Set(prefix.filter(step => step.kind === 'use_potion').map(step => step.slot));
  for (const candidate of prepared.candidates.values()) {
    if (!['play_card', 'use_potion'].includes(candidate.request.cmd)) continue;
    const step = planStep(state, candidate);
    if (occupiedCards.has(step.card_instance_id) || (step.kind === 'use_potion' && occupiedPotions.has(step.slot))) continue;
    for (let index = 0; index <= prefix.length; index++) {
      const inserted = bindFollowthrough(structuredClone(step), prefix.slice(index));
      add([...prefix.slice(0, index), inserted, ...prefix.slice(index), end]);
    }
  }
  plan.candidate_coverage.eligible_plans = alternatives.size;
  if (alternatives.size === 1) return;
  // Assess each complete alternative, then compare a diverse small shortlist.
  // Neither a local damage heuristic nor a card-specific strategy ranks them.
  const keep = { value: 'keep', label: label(plan.steps) };
  // judgePlans measures each actual compiled request and batches it to fit.
  // Raw label length cannot predict that size: shared descriptions and table
  // records compact together, and comparison state replaces the seed prefix.
  const instruction = 'Compare two mutually exclusive COMPLETE ordered plans starting from the actual current combat state. Choose the greater overall value toward winning the run. Compare HP actually lost, enemy damage and removal, lasting benefits, changed card piles, and persistent resources consumed or preserved. Read resource_consequences with conditional_preview: additional expiring Block is valuable only through damage it prevents or another supported rule interaction. Check preparation before its beneficiaries and actual follow-through. Ignore which plan was proposed earlier. Conditional arithmetic is incomplete; evaluate uncomputed rules without inventing hidden outcomes.';
  const comparisonState = { phase_scope: 'Compare mutually exclusive complete plans from the ACTUAL current state. These proposed steps have NOT happened. Every option replaces the entire unexecuted proposed prefix; do not execute both the old prefix and an option.',
    objective: null, retained_cards: [], proposed_steps: [], conditional_projection: [],
    energy_reservation: { observed_energy: state.combat.player.energy, remaining_after_printed_costs: state.combat.player.energy,
      is_observed: false, includes_future_energy_gains: false, steps: [], scope: 'No option has executed. Each option contains its own complete energy reservation and conditional outcome.' } };
  const candidates = [...alternatives].map(([value, steps]) => ({ value, allocation: planAllocation(steps), label: label(steps) }));
  const judgments = await assessPlans(candidates, 'Assess the overall quality of committing this ordered segment toward winning the run. Evaluate the whole remaining turn, including the ability to continue after an observation; use current rules and available resources, not hypothetical favorable draws.', comparisonState);
  const shortlist = shortlistPlans(candidates, judgments);
  plan.candidate_coverage.assessed_plans = judgments.length;
  plan.candidate_coverage.distinct_allocations = shortlist.allocation_count;
  plan.assessment_shortlist = shortlist.assessments;
  const final = await compareFinalists(shortlist.candidates, keep, comparePairs, instruction, comparisonState);
  plan.candidate_coverage.compared_plans = new Set((final.audit.balanced_pairs || []).flatMap(pair => pair.candidates)).size;
  plan.comparison_audit = final.audit;
  const selected = final.selected;
  if (selected === 'keep') return;
  plan.steps = structuredClone(alternatives.get(selected));
  delete plan.continuation_intent;
  const selectedBudget = reserveSequence(state, plan.steps);
  for (const [index, step] of plan.steps.entries()) {
    step.reserved_energy = selectedBudget.costs[index];
  }
  plan.budget.remaining_after_printed_costs = selectedBudget.energy_left;
  plan.end_policy = inspectSequence(state, plan.steps).checkpoint ? 'review_after_segment' : 'end_after_steps_unless_conditions_change';
}
