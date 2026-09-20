import { createHash } from 'node:crypto';

const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const encode = value => JSON.stringify(stable(value));
const brief = card => ({ name: card.name, description: card.description, cost: card.cost });

function basis(state) {
  const context = state.decision_context;
  return createHash('sha256').update(encode({ run_id: context?.run_id, floor: context?.total_floor,
    act: context?.act_index, player: context?.player, deck: context?.master_deck, map: context?.map })).digest('hex');
}

export function campUpgradeTargets(state) {
  const context = state.decision_context;
  if (state.screen !== 'REST_SITE' || !state.rest_site?.options?.some(option => option.option_id === 'SMITH' && option.is_enabled)) return [];
  const previews = context?.deck_upgrade_previews;
  if (!Array.isArray(previews) || !previews.length) return [];
  const snapshotBasis = basis(state);
  const targets = previews.map(preview => {
    const card = context.master_deck[preview.deck_index];
    if (!card || card.details?.instance_id !== preview.instance_id || card.id !== preview.card_id
      || !preview.description || !Number.isInteger(preview.cost)) return null;
    return { run_id: context.run_id, floor: context.total_floor, basis: snapshotBasis,
      deck_index: preview.deck_index, instance_id: preview.instance_id, card_id: card.id,
      before: brief(card), after: brief(preview) };
  });
  // Incomplete previews cannot silently remove an offered alternative.
  return targets.every(Boolean) ? targets : [];
}

export function campPlanApplicable(plan, state) {
  return Boolean(plan && plan.run_id === state.decision_context?.run_id && plan.floor === state.decision_context?.total_floor
    && ['REST_SITE', 'GRID_CARD_SELECT'].includes(state.screen) && plan.basis === basis(state));
}

export function publicCampTarget(target) {
  return { is_observed_effect: false, deck_index: target.deck_index, card_id: target.card_id,
    before: target.before, after: target.after,
    scope: 'Conditional upgrade selected by Jev. No upgrade has occurred; apply this target only if Smith is chosen and the following native upgrade selection still matches.' };
}

function matchesPreview(card, target) {
  return card.card_id === target.card_id && card.card_name === target.before.name
    && card.description === target.before.description && card.cost === target.before.cost
    && card.upgrade_preview === target.after.description && card.upgrade_preview_cost === target.after.cost
    && card.upgrade_preview_name === target.after.name;
}

export function plannedCampSelection(plan, state, candidates) {
  const grid = state.grid_card_select;
  if (!campPlanApplicable(plan, state) || state.screen !== 'GRID_CARD_SELECT'
    || grid?.selection_type !== 'upgrade' || grid.min_select !== 1 || grid.max_select !== 1) return null;
  const matching = grid.cards.filter(card => matchesPreview(card, plan));
  let selected = matching.find(card => card.details?.instance_id === plan.instance_id || card.instance_id === plan.instance_id);
  if (!selected) {
    if (!matching.length || matching.some(card => card.details?.instance_id || card.instance_id)) return null;
    // Old grid DTOs have no instance IDs. Only follow through when all deck
    // copies with this visible face are equivalent in their full native data.
    const equivalents = state.decision_context.master_deck.filter(card => card.id === plan.card_id && encode(brief(card)) === encode(plan.before));
    const withoutIdentity = card => {
      const copy = structuredClone(card); delete copy.index;
      if (copy.details) delete copy.details.instance_id;
      return encode(copy);
    };
    if (!equivalents.length || new Set(equivalents.map(withoutIdentity)).size !== 1) return null;
    selected = matching[0];
  }
  const copies = grid.cards.filter(card => card.card_id.toUpperCase() === selected.card_id.toUpperCase()).sort((a, b) => a.index - b.index);
  const nth = copies.findIndex(card => card.index === selected.index);
  for (const [candidate_id, candidate] of candidates) {
    const request = candidate.request;
    if (request?.cmd === 'grid_select_card' && request.card_ids.length === 1
      && request.card_ids[0] === selected.card_id && request.nth_values[0] === nth) return { ...candidate, candidate_id };
  }
  return null;
}
