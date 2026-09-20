// Rule adapters describe mechanical sequence constraints, never preferred
// strategy. The evaluator is shared by planning, preparation and refinement.
// Ringing's v0.111.0 ShouldPlay hook checks ANY prior owned card start, but only
// blocks cards bearing the Ringing affliction. Other afflictions are exempt.
export function knownActionConstraints(state) {
  if (!state.combat?.player.powers?.some(power => power.id === 'RINGING_POWER')) return [];
  const affected = state.combat.hand.filter(card => (card.details?.affliction?.id || card.affliction) === 'RINGING')
    .map(card => card.details?.instance_id).filter(Boolean);
  return affected.length ? [{ rule_id: 'RINGING_POWER', affected_card_instance_ids: affected,
    maximum_prior_card_starts: 0,
    scope: 'A currently legal Ringing-afflicted card must be the first card in the proposed remaining sequence. Any earlier card consumes that opportunity. Unafflicted cards are not restricted by this rule; current native legality also applies.' }] : [];
}

export function reserveActionSequence(state, steps) {
  const constraints = knownActionConstraints(state);
  let starts = 0;
  const transitions = steps.map((step, sequence) => {
    const before = starts;
    const violated = step.kind === 'play_card' ? constraints.filter(constraint =>
      constraint.affected_card_instance_ids.includes(step.card_instance_id) && before > constraint.maximum_prior_card_starts) : [];
    if (step.kind === 'play_card') starts++;
    return { sequence, kind: step.kind, card_instance_id: step.card_instance_id ?? null,
      card_starts_before: before, card_starts_after: starts, allowed: violated.length === 0,
      violated_rules: violated.map(rule => rule.rule_id) };
  });
  return { is_observed: false, valid: transitions.every(step => step.allowed), constraints, transitions,
    scope: 'Known action-order constraints under current rules, independent of energy. Counts proposed manual card starts, not modal choices or potion use. Unobserved automatic plays or removed effects require a new observation; this is not a complete legality simulation.' };
}
