import { createHash } from 'node:crypto';

const encode = value => JSON.stringify(value);
const face = card => ({ id: card.id, name: card.name, description: card.description, cost: card.cost });
const withoutIdentity = card => {
  const copy = structuredClone(card);
  delete copy.index;
  if (copy.details) delete copy.details.instance_id;
  return copy;
};
export function shopRemovalBasis(state) {
  const c = state.decision_context;
  return createHash('sha256').update(encode({ run: c?.run_id, floor: c?.total_floor, act: c?.act_index,
    deck: c?.master_deck, relics: c?.player.relics })).digest('hex');
}
export function shopRemovalApplicable(plan, state) {
  return Boolean(plan && plan.run_id === state.decision_context?.run_id && plan.floor === state.decision_context?.total_floor
    && ['SHOP', 'GRID_CARD_SELECT'].includes(state.screen) && plan.basis === shopRemovalBasis(state)
    && (state.screen !== 'SHOP' || (state.shop?.card_removal?.cost === plan.cost
      && !state.shop.card_removal.is_used && state.shop.player_gold >= plan.cost)));
}
export function publicShopRemoval(plan) {
  return { is_observed_effect: false, deck_group_index: plan.deck_group_index, card: face(plan.card), cost: plan.cost,
    scope: 'Jev conditional target: remove ONE exact copy if the removal service wins the purchase comparison. This does not commit to paying. Remaining equivalent copies stay in the deck. The native removal grid must still match.' };
}
export function plannedShopRemoval(plan, state, candidates) {
  const grid = state.grid_card_select;
  if (!shopRemovalApplicable(plan, state) || state.screen !== 'GRID_CARD_SELECT'
    || grid?.selection_type !== 'remove' || grid.min_select !== 1 || grid.max_select !== 1) return null;
  const matches = card => card.card_id === plan.card.id && card.card_name === plan.card.name
    && card.description === plan.card.description && card.cost === plan.card.cost;
  const matching = grid.cards.filter(matches);
  let selected = matching.find(card => plan.instance_ids.includes(card.details?.instance_id ?? card.instance_id));
  if (!selected) {
    if (!matching.length || matching.some(card => card.details?.instance_id || card.instance_id)) return null;
    // Older grid DTOs omit identity. Only identical full card states may share
    // a visible-face fallback; enchantments/other hidden differences forbid it.
    const sameFace = state.decision_context.master_deck.filter(card => encode(face(card)) === encode(face(plan.card)));
    if (!sameFace.length || sameFace.some(card => encode(withoutIdentity(card)) !== encode(plan.card))) return null;
    selected = matching[0];
  }
  const copies = grid.cards.filter(c => c.card_id.toUpperCase() === selected.card_id.toUpperCase()).sort((a, b) => a.index - b.index);
  const nth = copies.findIndex(c => c.index === selected.index);
  for (const [candidate_id, candidate] of candidates) {
    const request = candidate.request;
    if (request?.cmd === 'grid_select_card' && request.card_ids.length === 1
      && request.card_ids[0] === selected.card_id && request.nth_values[0] === nth) return { ...candidate, candidate_id };
  }
  return null;
}
