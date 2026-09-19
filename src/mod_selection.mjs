import { validateModRequest } from './mod_client.mjs';

// A large unordered selection is a sequence of typed choices over the same
// observation. No partial choice is sent to the game.
export function selectionStage(plan, progress = {}) {
  const picked = progress.picked || [];
  const count = progress.count ?? (plan.min === plan.max ? plan.min : null);
  const candidates = new Map();
  const add = (id, choice, description) => candidates.set(id, { action: 'plan_selection', request: null, planning_choice: choice, description });
  if (count === null) {
    for (let n = plan.min; n <= plan.max; n++) add(`plan_count_${n}`, { kind: 'count', count: n }, `Choose ${n} cards for this selection.`);
  } else {
    if (!Number.isInteger(count) || count < plan.min || count > plan.max || new Set(picked).size !== picked.length || picked.length >= count || picked.some(index => !plan.copies.some(item => item.card.index === index))) throw new Error('Invalid selection planning progress');
    for (const { card } of plan.copies) if (!picked.includes(card.index)) add(`plan_card_${card.index}`, { kind: 'card', card_index: card.index }, `Add ${card.card_name}, index ${card.index}, to this ${count}-card selection. Current: ${card.description || ''}${card.upgrade_preview ? ` Upgrade: ${card.upgrade_preview}; upgraded energy cost ${card.upgrade_preview_cost ?? 'unknown'}.` : ''}`);
  }
  if (!picked.length && plan.canSkip) candidates.set('skip_selection', { action: 'mod_command', request: { cmd: plan.skipCommand }, description: 'Skip the entire optional selection.' });
  if (candidates.size > 255) throw new Error('Selection planning stage exceeds 255 choices');
  return { candidates, progress: { count, picked }, state: { phase: count === null ? 'choose_count' : 'choose_next_card', required_count: count, minimum: plan.min, maximum: plan.max, selected_indices: picked, selected_cards: picked.map(index => plan.copies.find(item => item.card.index === index).card), remaining_to_choose: count === null ? null : count - picked.length, execution: 'Planning only: no game commands have been sent. Consider the whole final set, including cards already selected. After the set is complete, code rereads the game and submits all selected cards together.' } };
}

export async function assembleSelection(state, options, first, choose, prepare) {
  const plan = first.selectionPlan;
  let current = first, progress = first.selectionProgress;
  const trace = [];
  while (true) {
    const decision = await choose(state, options, current);
    trace.push({ request: current.payload, decision });
    options.onPlanningDecision?.(decision, current.payload);
    if (decision.action === 'mod_command') return { ...decision, planning_trace: trace };
    const choice = decision.planning_choice;
    if (choice.kind === 'count') progress = { count: choice.count, picked: [] };
    else if (choice.kind === 'card') progress = { count: progress.count, picked: [...progress.picked, choice.card_index] };
    else throw new Error('Invalid selection planning choice');
    if (progress.picked.length === progress.count) {
      const chosen = progress.picked.map(index => plan.copies.find(item => item.card.index === index));
      const request = { cmd: plan.command, card_ids: chosen.map(item => item.card.card_id), nth_values: chosen.map(item => item.nth) };
      validateModRequest(request);
      return {
        action: 'mod_command',
        request,
        description: `Select ${chosen.map(item => `${item.card.card_name} (index ${item.card.index})`).join(', ')}.`,
        model: trace.find(item => item.decision.model !== 'forced-single-action')?.decision.model || 'forced-single-action',
        planning_trace: trace,
        context_metrics: first.metrics,
        usage: { input_tokens: trace.reduce((sum, item) => sum + (item.decision.usage?.input_tokens || 0), 0), output_tokens: trace.reduce((sum, item) => sum + (item.decision.usage?.output_tokens || 0), 0) }
      };
    }
    current = prepare(state, { ...options, selectionProgress: progress });
  }
}
