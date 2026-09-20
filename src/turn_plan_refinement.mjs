import { planStep, cardInstance } from './turn_plan_state.mjs';
import { projectTurnPrefix, reserveSequence } from './turn_projection.mjs';
import { handUpgradeMode, preservesPlanDependencies } from './turn_effects.mjs';

const signature = steps => JSON.stringify(steps.map(step => [step.kind, step.card_instance_id, step.potion_id, step.slot, step.target]));

// Compare concrete complete plans, not another disconnected next-card choice.
// These are bounded local alternatives, not an exhaustive solver. Every current
// legal action remains available in the main planning stages.
export async function refineTurnPlan(state, plan, prepared, ask) {
  if (plan.end_policy !== 'end_after_steps_unless_conditions_change') return;
  const seen = new Set([signature(plan.steps)]);
  const label = steps => {
    const budget = reserveSequence(state, steps), projection = projectTurnPrefix(state, steps);
    return {
      ordered_sequence: steps.filter(step => step.kind !== 'end_turn').map(step => {
        const beneficiary = state.combat.hand.find(card => cardInstance(card) === step.beneficiary_instance_id);
        return { action: step.name, ...(step.target !== undefined ? { target: step.target } : {}), rules: step.rules_at_planning,
          ...(beneficiary ? { intended_followthrough: beneficiary.name,
            ...(handUpgradeMode(step.rules_at_planning) ? { upgrade_payoff: beneficiary.name, inspectable_upgrade: beneficiary.upgrade_preview ?? null } : {}) } : {}) };
      }),
      then: 'End turn, unless a new observation requires a revision.',
      energy_left: budget.energy_left,
      conditional_preview: { block: projection.block, hp_if_ending: projection.hp_if_ending_after_prefix,
        enemies: projection.remaining_enemies.map(({ combat_id, hp }) => ({ combat_id, hp })),
        unconfirmed_effects: projection.unresolved_effects },
      limitation: 'Current-preview arithmetic only; upgrades, debuffs, draws, potions and other changing effects may alter these numbers.'
    };
  };
  for (let pass = 0; pass < 2; pass++) {
    const end = plan.steps.at(-1), prefix = plan.steps.slice(0, -1), alternatives = new Map([['keep', plan.steps]]);
    const add = steps => {
      const key = signature(steps);
      if (seen.has(key) || !reserveSequence(state, steps) || !preservesPlanDependencies(steps)) return;
      seen.add(key); alternatives.set(`variant_${alternatives.size}`, steps);
    };
    // Adjacent swaps explicitly test local timing, e.g. Vulnerable before an
    // attack. One insertion tests whether stopping leaves a useful card unused.
    for (let index = 0; index + 1 < prefix.length; index++) {
      const copy = structuredClone(prefix); [copy[index], copy[index + 1]] = [copy[index + 1], copy[index]];
      add([...copy, end]);
    }
    const occupiedCards = new Set([...prefix, ...(plan.retained_cards || [])].map(step => step.card_instance_id).filter(Boolean));
    const occupiedPotions = new Set(prefix.filter(step => step.kind === 'use_potion').map(step => step.slot));
    for (const candidate of prepared.candidates.values()) {
      if (!['play_card', 'use_potion'].includes(candidate.request.cmd)) continue;
      const step = planStep(state, candidate);
      if (occupiedCards.has(step.card_instance_id) || (step.kind === 'use_potion' && occupiedPotions.has(step.slot))) continue;
      for (let index = 0; index <= prefix.length; index++) {
        const inserted = structuredClone(step), next = prefix[index];
        if (handUpgradeMode(step.rules_at_planning) && next?.kind === 'play_card') {
          inserted.role = 'preparation'; inserted.beneficiary_instance_id = next.card_instance_id; inserted.beneficiary_name = next.name;
        }
        add([...prefix.slice(0, index), inserted, ...prefix.slice(index), end]);
      }
    }
    if (alternatives.size === 1) break;
    // Keep the original in every comparison and then compare batch winners.
    // No candidate is pruned by a damage heuristic or a card-specific strategy.
    const keep = { value: 'keep', label: label(plan.steps) };
    const maxLabels = Math.min(12000, prepared.metrics.max_request_bytes - prepared.metrics.request_bytes - 6000);
    if (maxLabels < Buffer.byteLength(JSON.stringify(keep)) * 2) {
      plan.refinement_limit = 'Optional whole-plan comparisons skipped because the complete state leaves insufficient request space.';
      return;
    }
    const instruction = 'Compare these COMPLETE ordered turn plans under turn_planning.objective. Choose the most useful whole turn. Check whether a buff/debuff/upgrade comes before its beneficiaries and whether spending remaining energy improves survival or damage. A non-immediate preparation must have useful follow-through. Do not stop merely because one card already served the objective. Do not reorder a payoff before a preparation that improves it without a concrete benefit. Conditional arithmetic is incomplete; use the explicit rules for unknown effects. Keeping the original plan is valid if alternatives waste resources or disrupt it.';
    const winners = new Set(['keep']);
    let batch = { keep }, bytes = Buffer.byteLength(JSON.stringify(batch));
    const compare = async () => { if (Object.keys(batch).length > 1) winners.add(await ask('refine', instruction, batch)); };
    for (const [id, steps] of [...alternatives].slice(1)) {
      const item = { value: id, label: label(steps) }, size = Buffer.byteLength(JSON.stringify(item)) + id.length + 5;
      if (bytes + size > maxLabels || Object.keys(batch).length >= 30) { await compare(); batch = { keep }; bytes = Buffer.byteLength(JSON.stringify(batch)); }
      batch[id] = item; bytes += size;
    }
    await compare();
    let selected = 'keep';
    if (winners.size > 1) {
      const finalists = Object.fromEntries([...winners].map(id => [id, { value: id, label: label(alternatives.get(id)) }]));
      if (Buffer.byteLength(JSON.stringify(finalists)) <= maxLabels) selected = await ask('refine_final', instruction, finalists);
      else for (const id of [...winners].filter(id => id !== 'keep')) {
        // Tournament rounds also respect the same bounded request size.
        selected = await ask('refine_final', instruction, { incumbent: { value: selected, label: label(alternatives.get(selected)) }, challenger: { value: id, label: label(alternatives.get(id)) } });
      }
    }
    if (selected === 'keep') break;
    plan.steps = structuredClone(alternatives.get(selected));
    for (const [index, step] of plan.steps.entries()) {
      step.reserved_energy = reserveSequence(state, plan.steps).costs[index];
      if (step.beneficiary_instance_id && !plan.steps.slice(index + 1).some(next => next.card_instance_id === step.beneficiary_instance_id)) {
        delete step.beneficiary_instance_id; delete step.beneficiary_name; step.role = 'payoff';
      }
    }
    plan.budget.remaining_after_printed_costs = reserveSequence(state, plan.steps).energy_left;
  }
}
