import { ContextError, groupCards } from './decision_context.mjs';
import { compileModelRequest } from './context_compiler.mjs';
import { removableCard, shopEconomy } from './shop_context.mjs';
import { publicShopRemoval, shopRemovalBasis } from './shop_plan_state.mjs';

// One conditional Choice, rather than a paid Score for every removable card.
// The following existing option assessment compares this concrete cut with buys.
export async function planShopRemoval(state, options, prepared, choose) {
  if (state.screen !== 'SHOP' || !prepared.candidates.has('remove_card')) return null;
  const groups = groupCards(state.decision_context.master_deck);
  if (groups.some(g => removableCard(g.card) === null)) return null;
  const choices = new Map(groups.flatMap((group, deck_group_index) => removableCard(group.card)
    ? [[`remove_${deck_group_index}`, { run_id: state.decision_context.run_id, floor: state.decision_context.total_floor,
      basis: shopRemovalBasis(state), deck_group_index, card: group.card, instance_ids: group.instance_ids,
      cost: state.shop.card_removal.cost }]] : []));
  if (!choices.size) return null;
  if (choices.size > 255) throw new ContextError('Removal targets exceed model choice limit; none were discarded');
  const payload = { ...prepared.payload, questions: { removal_target: {
    type: 'choice',
    instructions: 'If you pay for ONE permanent card removal here, which owned copy would best improve this run? Compare full deck.cards rules, upgrades and enchantments, existing replacements for its job, draw access to stronger cards, relics, visible boss and route. A weak standalone card can still supply needed damage, defense, exhaust fuel or a supported Strike/curse payoff. Removing a payoff component has a cost. Do not use a fixed Strike-before-Defend rule or target deck size. Each option removes one copy. This is only a conditional target; the subsequent shop decision may instead buy or leave.',
    criteria: Object.fromEntries([...choices].map(([id, plan]) => [id, publicShopRemoval(plan)]))
  } } };
  const metrics = { ...prepared.metrics, purpose: 'shop_removal_target', question_count: 1 };
  metrics.request_bytes = compileModelRequest(payload, metrics).bytes;
  if (metrics.request_bytes > metrics.max_request_bytes) throw new ContextError('Complete removal planning context exceeds request budget');
  const result = await choose(state, options, { ...prepared, payload, metrics, parseResult: result => {
    const answer = result.answers?.removal_target;
    if (answer?.type !== 'choice' || !choices.has(answer.choice)) throw new Error('Invalid conditional shop removal target');
    return { action: 'plan_shop_removal', target: choices.get(answer.choice), confidence: answer.confidence, probabilities: answer.probabilities };
  } });
  options.onPlanningDecision?.(result);
  return result;
}

// A paid card the model itself rated marginal needs a direct comparison with
// keeping the gold. A useful card still passes through the full-menu choice.
export async function compareShopCardWithSaving(state, options, prepared, decision, choose) {
  if (state.screen !== 'SHOP' || decision.request?.cmd !== 'shop_buy_card') return decision;
  const saving = prepared.candidates.get('proceed');
  const rating = options.strategyAssessment?.options.find(option => option.action_id === decision.candidate_id)?.probabilities;
  if (!saving || !rating || ![0, 1, 2, 3].every(level => Number.isFinite(rating[level]) && rating[level] >= 0 && rating[level] <= 1)
    || Math.abs(Object.values(rating).reduce((sum, value) => sum + value, 0) - 1) >= 0.02
    || rating[0] + rating[1] <= rating[2] + rating[3]) return decision;
  const purchase = prepared.candidates.get(decision.candidate_id);
  if (!purchase) throw new ContextError('Chosen shop card is missing from current candidates');
  const buy = { action_id: decision.candidate_id, effect: purchase.description };
  const leave = { action_id: 'proceed', effect: saving.description, gold_carried_forward: state.shop.player_gold };
  const instructions = 'The proposed paid card was independently rated more likely marginal or worse than clearly useful. Reconsider that uncertain judgment using the complete current state. Which outcome better serves winning the run: buy this exact card now, or leave this shop carrying the gold? Compare its concrete job, existing copies, energy and draw cost, price, current deck needs, visible boss and route. A needed immediate card can still justify its cost; a redundant or unreliable addition can make the deck worse. Leaving forfeits this shop stock. Do not assume unknown future offers or treat the earlier rating as a fact. Choose the better complete tradeoff.';
  const questions = Object.fromEntries([['card_forward', buy, leave], ['card_reverse', leave, buy]].map(([id, first, second]) =>
    [id, { type: 'choice', instructions, criteria: { first, second } }]));
  const payload = { ...prepared.payload, questions }, metrics = { ...prepared.metrics, purpose: 'shop_card_vs_saving', question_count: 2 };
  metrics.request_bytes = compileModelRequest(payload, metrics).bytes;
  if (metrics.request_bytes > metrics.max_request_bytes) throw new ContextError('Complete shop card comparison exceeds request budget');
  const comparison = await choose(state, options, { ...prepared, payload, metrics, parseResult: result => {
    const judgments = Object.entries(questions).map(([id, question]) => {
      const answer = result.answers?.[id];
      if (answer?.type !== 'choice' || !Object.hasOwn(question.criteria, answer.choice)) throw new Error('Invalid shop card comparison');
      return { question: id, action_id: question.criteria[answer.choice].action_id, confidence: answer.confidence, probabilities: answer.probabilities };
    });
    return { action: 'compare_shop_card_with_saving', judgments,
      consensus_action_id: judgments[0].action_id === judgments[1].action_id ? judgments[0].action_id : null };
  } });
  options.onPlanningDecision?.(comparison);
  const changed = comparison.consensus_action_id === 'proceed';
  return { ...decision, ...(changed ? { ...saving, candidate_id: 'proceed', model: comparison.model,
    confidence: undefined, probabilities: undefined } : {}),
    initial_shop_card_choice: { candidate_id: decision.candidate_id, confidence: decision.confidence,
      probabilities: decision.probabilities }, shop_card_comparison: comparison,
    usage: { input_tokens: (decision.usage?.input_tokens || 0) + (comparison.usage?.input_tokens || 0),
      output_tokens: (decision.usage?.output_tokens || 0) + (comparison.usage?.output_tokens || 0) } };
}

// Before leaving an Act 1 shop with no added Attack, put the real damage
// options beside saving gold. The model may still save or choose removal next.
export async function compareShopFirstAttack(state, options, prepared, decision, choose) {
  if (state.screen !== 'SHOP' || decision.request?.cmd !== 'proceed'
    || state.decision_context?.act_index !== 0
    || state.decision_context.master_deck.some(card => card.type === 'Attack' && card.rarity !== 'Basic')) return decision;
  const buys = (state.shop?.cards || []).filter(card => card.is_stocked && card.card_type === 'Attack'
    && card.cost <= state.shop.player_gold && prepared.candidates.has(`buy_card_${card.index}`));
  if (!buys.length) return decision;
  const alternatives = [{ action_id: 'proceed', effect: prepared.candidates.get('proceed').description,
    gold_after: state.shop.player_gold, deck_count_after: state.decision_context.master_deck.length },
  ...buys.map(card => ({ action_id: `buy_card_${card.index}`,
    effect: prepared.candidates.get(`buy_card_${card.index}`).description,
    gold_after: state.shop.player_gold - card.cost,
    deck_count_after: state.decision_context.master_deck.length + 1 }))];
  const instructions = 'This Act 1 deck still has no added non-Basic Attack. Compare leaving with the gold against buying ONE of these exact available Attacks. Basic or upgraded attacks, other damage effects, relics and potions may already provide enough damage; an Attack is not mandatory. Assess first-cycle damage, energy, draw dilution, each price, current HP, visible threats and the need to save for removal or later offers. A weak or redundant Attack should lose to saving; an efficient first Attack may prevent repeated enemy turns. Do not assume future card offers. Choose the best complete tradeoff.';
  const questions = Object.fromEntries([['first_attack_forward', alternatives],
    ['first_attack_reverse', [...alternatives].reverse()]].map(([id, ordered]) => [id,
    { type: 'choice', instructions, criteria: Object.fromEntries(ordered.map((item, index) => [`option_${index}`, item])) }]));
  const payload = { ...prepared.payload, questions }, metrics = { ...prepared.metrics,
    purpose: 'shop_first_attack_vs_saving', question_count: 2 };
  metrics.request_bytes = compileModelRequest(payload, metrics).bytes;
  if (metrics.request_bytes > metrics.max_request_bytes) throw new ContextError('Complete first Attack comparison exceeds request budget');
  const comparison = await choose(state, options, { ...prepared, payload, metrics, parseResult: result => {
    const judgments = Object.entries(questions).map(([id, question]) => {
      const answer = result.answers?.[id];
      if (answer?.type !== 'choice' || !Object.hasOwn(question.criteria, answer.choice)) throw new Error('Invalid first Attack comparison');
      return { question: id, action_id: question.criteria[answer.choice].action_id,
        confidence: answer.confidence, probabilities: answer.probabilities };
    });
    return { action: 'compare_shop_first_attack', judgments,
      consensus_action_id: judgments[0].action_id === judgments[1].action_id ? judgments[0].action_id : null };
  } });
  options.onPlanningDecision?.(comparison);
  const selectedId = comparison.consensus_action_id;
  const selected = selectedId && selectedId !== 'proceed' ? prepared.candidates.get(selectedId) : null;
  return { ...decision, ...(selected ? { ...selected, candidate_id: selectedId, model: comparison.model,
    confidence: undefined, probabilities: undefined } : {}),
    initial_shop_exit_choice: { candidate_id: decision.candidate_id, confidence: decision.confidence,
      probabilities: decision.probabilities }, shop_first_attack_comparison: comparison,
    usage: { input_tokens: (decision.usage?.input_tokens || 0) + (comparison.usage?.input_tokens || 0),
      output_tokens: (decision.usage?.output_tokens || 0) + (comparison.usage?.output_tokens || 0) } };
}

// Compare removal with a purchase that consumes its budget, or with leaving
// while removal is still affordable. Disagreement preserves the full-menu
// choice; there is no hard-coded preference for removal.
export async function compareShopRemoval(state, options, prepared, decision, choose) {
  if (!options.shopRemovalPlan || state.screen !== 'SHOP') return decision;
  const removal = prepared.candidates.get('remove_card');
  if (!removal) return decision;
  const leaving = decision.candidate_id === 'proceed' && decision.request?.cmd === 'proceed';
  const transaction = shopEconomy(state, groupCards(state.decision_context.master_deck), prepared.candidates)
    .transactions.find(t => t.action_id === decision.candidate_id);
  if (!leaving && !transaction?.forecloses_affordable_removal) return decision;
  const alternative = { action_id: decision.candidate_id, effect: decision.description,
    ...(leaving ? { gold_carried_forward: state.shop.player_gold } : { budget: transaction }) };
  const cut = { action_id: 'remove_card', effect: removal.description, target: publicShopRemoval(options.shopRemovalPlan),
    gold_after: state.shop.player_gold - options.shopRemovalPlan.cost };
  const instructions = leaving
    ? 'Before leaving this shop, compare preserving all current gold for visible future opportunities against paying now to remove the specified owned card. Leaving forfeits this shop service; a future shop is only available if the known route reaches one, and its stock and prices are unknown. Removal improves repeated access to retained cards but loses this card and costs the displayed gold. Judge current deck jobs, actual replacement cards, upcoming fights and future route; neither removal nor saving is mandatory. Choose the better complete tradeoff. Prior option ratings are fallible model judgments.'
    : 'Compare these two concrete uses of the same current shop budget. Which leaves the run better prepared for its visible route and boss? This purchase makes the specified removal unaffordable, so they cannot both be taken at displayed prices. Weigh the purchased effect and any affordable remaining offers against the exact removed card, better access to retained cards, lost synergies and remaining gold. Necessary damage/defense or a powerful relic/potion can outweigh removal; redundant output can lose to consistency. Use actual rules and current resources, not a universal buy/remove policy. Choose the better complete tradeoff, not the more impressive isolated effect. Prior option ratings are fallible model judgments.';
  const questions = Object.fromEntries([['budget_forward', alternative, cut], ['budget_reverse', cut, alternative]].map(([id, first, second]) =>
    [id, { type: 'choice', instructions, criteria: { first, second } }]));
  const payload = { ...prepared.payload, questions }, metrics = { ...prepared.metrics, purpose: 'shop_budget_comparison', question_count: 2 };
  metrics.request_bytes = compileModelRequest(payload, metrics).bytes;
  if (metrics.request_bytes > metrics.max_request_bytes) throw new ContextError('Complete shop budget comparison exceeds request budget');
  const comparison = await choose(state, options, { ...prepared, payload, metrics, parseResult: result => {
    const judgments = Object.entries(questions).map(([id, question]) => {
      const answer = result.answers?.[id];
      if (answer?.type !== 'choice' || !Object.hasOwn(question.criteria, answer.choice)) throw new Error('Invalid shop budget comparison');
      return { question: id, action_id: question.criteria[answer.choice].action_id, confidence: answer.confidence, probabilities: answer.probabilities };
    });
    return { action: 'compare_shop_budget', judgments,
      consensus_action_id: judgments[0].action_id === judgments[1].action_id ? judgments[0].action_id : null };
  } });
  options.onPlanningDecision?.(comparison);
  const changed = comparison.consensus_action_id === 'remove_card';
  return { ...decision, ...(changed ? { ...removal, candidate_id: 'remove_card', model: comparison.model, confidence: undefined, probabilities: undefined } : {}),
    initial_shop_choice: { candidate_id: decision.candidate_id, confidence: decision.confidence, probabilities: decision.probabilities },
    shop_budget_comparison: comparison, usage: {
      input_tokens: (decision.usage?.input_tokens || 0) + (comparison.usage?.input_tokens || 0),
      output_tokens: (decision.usage?.output_tokens || 0) + (comparison.usage?.output_tokens || 0)
    } };
}
