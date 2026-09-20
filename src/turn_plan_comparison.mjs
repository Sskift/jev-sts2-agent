// Survival constraints and ordinary value are independent model judgments over
// the same complete alternatives. A favorable damage/Block estimate must not
// compensate for losing the only known response to a fatal mechanic.
export function planComparisonQuestions(pairs, valueInstructions) {
  return Object.fromEntries(pairs.flatMap((_, index) => {
    const location = `The two complete, mutually exclusive proposed plans are at analysis.plan_alternatives[${index}]. They start from the same current observation and have NOT executed.`;
    return [
      [`survival_${index}`, {
        type: 'choice',
        instructions: `${location} Compare survival constraints, independently of ordinary damage or setup value. Inspect current rules, counters, resources and all piles through the coming enemy response and the next known deadline. Does one plan more reliably avoid forced defeat, or preserve a viable response that the other loses before it can be used? Positive HP/Block arithmetic does not establish safety against other loss conditions. Account for where response cards go and whether they can be available in time; unknown draws, random rewards and unconfirmed retrieval are not guaranteed rescues. Prefer a side only for a concrete survival constraint supported by the visible facts. Ordinary nonlethal HP trades and speculative distant threats belong in the value comparison. If neither side has an established advantage on these constraints, choose no_clear_difference.`,
        criteria: {
          plan_a: 'Plan A has the supported survival-constraint advantage.',
          plan_b: 'Plan B has the supported survival-constraint advantage.',
          no_clear_difference: 'No supported survival-constraint advantage separates these plans; compare their overall value.'
        }
      }],
      [`comparison_${index}`, {
        type: 'choice', instructions: `${location} ${valueInstructions}`,
        criteria: { plan_a: 'Choose complete plan A.', plan_b: 'Choose complete plan B.' }
      }]
    ];
  }));
}

export function resolvePlanComparisons(pairs, answers) {
  return pairs.map((pair, index) => {
    const survival = answers?.[`survival_${index}`], value = answers?.[`comparison_${index}`];
    if (survival?.type !== 'choice' || !['plan_a', 'plan_b', 'no_clear_difference'].includes(survival.choice)
      || value?.type !== 'choice' || !['plan_a', 'plan_b'].includes(value.choice)) {
      throw new Error('Jev returned an invalid turn-plan comparison');
    }
    const selectionBasis = survival.choice === 'no_clear_difference' ? 'overall_value' : 'survival_constraint';
    const selected = selectionBasis === 'overall_value' ? value : survival;
    return { selected: pair[selected.choice === 'plan_a' ? 0 : 1].value,
      options: { plan_a: pair[0].value, plan_b: pair[1].value },
      selection_basis: selectionBasis,
      survival_assessment: survival, value_assessment: value,
      probabilities: selected.probabilities, confidence: selected.confidence };
  });
}
