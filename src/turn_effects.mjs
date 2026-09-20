// Recognize only explicit, standalone English rules verified in native output.
// A future/random upgrade (e.g. Aggression) does not promise a hand-selection
// modal or allow choosing the current payoff. Unrecognized effects stay unknown.
export function handUpgradeMode(description = '') {
  const clauses = description.split(/[.\n]/).map(text => text.trim());
  if (clauses.some(text => /^Upgrade (?:a|1) card in your Hand$/i.test(text))) return 'one';
  if (clauses.some(text => /^Upgrade ALL cards in your Hand$/i.test(text))) return 'all';
  return null;
}

export function nextCardKind(description = '') {
  // Do not bind a later-turn trigger to this turn's planned sequence.
  if (/\bnext turn\b|\bat the (?:start|end) of\b/i.test(description)) return null;
  const match = description.match(/\b(?:your|the) next (?:\d+ )?(card|Attack|Skill|Power)s?\b/i);
  return match ? { card: 'Any', attack: 'Attack', skill: 'Skill', power: 'Power' }[match[1].toLowerCase()] : null;
}

export function preservesPlanDependencies(steps) {
  return steps.every((step, index) => !step.next_card_instance_id
    || steps.slice(index + 1).find(next => next.kind === 'play_card'
      && (!step.next_card_type || step.next_card_type === 'Any' || next.card_type === step.next_card_type))?.card_instance_id === step.next_card_instance_id);
}
