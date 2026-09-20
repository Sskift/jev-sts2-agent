// Recognize only explicit, standalone English rules verified in native output.
// A future/random upgrade (e.g. Aggression) does not promise a hand-selection
// modal or allow choosing the current payoff. Unrecognized effects stay unknown.
export function handUpgradeMode(description = '') {
  const clauses = description.split(/[.\n]/).map(text => text.trim());
  if (clauses.some(text => /^Upgrade (?:a|1) card in your Hand$/i.test(text))) return 'one';
  if (clauses.some(text => /^Upgrade ALL cards in your Hand$/i.test(text))) return 'all';
  return null;
}

export function preservesPlanDependencies(steps) {
  return steps.every((step, index) => !step.next_card_instance_id
    || steps.slice(index + 1).find(next => next.kind === 'play_card')?.card_instance_id === step.next_card_instance_id);
}
