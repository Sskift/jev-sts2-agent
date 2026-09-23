import { ContextError } from './decision_context.mjs';
import { compileModelRequest } from './context_compiler.mjs';

// A full-menu choice is prone to treating a free card as a free improvement.
// Compare its actual incremental value with adding no card before executing it.
export async function compareRewardSkip(state, options, prepared, decision, choose) {
  if (state.screen !== 'REWARD' || decision.request?.cmd !== 'reward_choose_card') return decision;
  const skipId = `skip_card_${decision.request.nth ?? 0}`;
  const skip = prepared.candidates.get(skipId);
  if (!skip) return decision;
  const chosen = prepared.candidates.get(decision.candidate_id);
  if (!chosen) throw new ContextError('Chosen reward is missing from current candidates');
  const earlyDamage = prepared.payload.state.deck?.statistics?.early_damage_check;
  const needsFirstAttack = earlyDamage?.no_added_attack === true
    && earlyDamage.offered_attack_action_ids.some(id => prepared.candidates.get(id)?.request?.nth === decision.request.nth);
  const deckCount = state.decision_context?.master_deck?.length;
  const add = { action_id: decision.candidate_id, effect: chosen.description,
    deck_count_after: Number.isInteger(deckCount) ? deckCount + 1 : null };
  const decline = { action_id: skipId, effect: skip.description,
    deck_count_after: Number.isInteger(deckCount) ? deckCount : null };
  const instructions = 'Which choice better serves winning the whole run from this exact reward? The card is free in gold but occupies future draws; skipping keeps the current deck and other rewards remain claimable. Compare the proposed card with existing copies and jobs, current HP, energy, relics, draw, upcoming visible threats and supported synergies. A needed card can justify dilution; a marginal or redundant card can make the deck worse. Assess the concrete incremental effect, not whether any reward seems generally desirable. Do not treat a prior model rating as a fact or assume an unknown future card. Choose one alternative using the full current state.';
  const questions = Object.fromEntries([['reward_forward', add, decline], ['reward_reverse', decline, add]].map(([id, first, second]) =>
    [id, { type: 'choice', instructions, criteria: { first, second } }]));
  const payload = { ...prepared.payload, questions };
  const metrics = { ...prepared.metrics, purpose: 'reward_add_vs_skip', question_count: 2 };
  metrics.request_bytes = compileModelRequest(payload, metrics).bytes;
  if (metrics.request_bytes > metrics.max_request_bytes) throw new ContextError('Complete reward comparison exceeds request budget');
  const comparison = await choose(state, options, { ...prepared, payload, metrics, parseResult: result => {
    const judgments = Object.entries(questions).map(([id, question]) => {
      const answer = result.answers?.[id];
      if (answer?.type !== 'choice' || !Object.hasOwn(question.criteria, answer.choice)) throw new Error('Invalid reward comparison');
      return { question: id, action_id: question.criteria[answer.choice].action_id,
        confidence: answer.confidence, probabilities: answer.probabilities };
    });
    return { action: 'compare_reward_skip', judgments,
      ...(needsFirstAttack ? { first_non_basic_attack_missing: true } : {}),
      consensus_action_id: judgments[0].action_id === judgments[1].action_id ? judgments[0].action_id : null };
  } });
  options.onPlanningDecision?.(comparison);
  // The independent option rating is advisory. Run 42 showed it could veto
  // Shrug It Off before Jev compared the actual addition with keeping the deck.
  // Trust a two-order direct comparison when both answers agree; disagreement
  // keeps the original full-menu choice instead of inventing a skip threshold.
  const changed = comparison.consensus_action_id === skipId;
  return { ...decision, ...(changed ? { ...skip, candidate_id: skipId, model: comparison.model,
    confidence: undefined, probabilities: undefined } : {}),
    initial_reward_choice: { candidate_id: decision.candidate_id, confidence: decision.confidence,
      probabilities: decision.probabilities }, reward_skip_comparison: comparison,
    usage: { input_tokens: (decision.usage?.input_tokens || 0) + (comparison.usage?.input_tokens || 0),
      output_tokens: (decision.usage?.output_tokens || 0) + (comparison.usage?.output_tokens || 0) } };
}
