import { createHash } from 'node:crypto';
import { costAfterAttacks } from './turn_sequence.mjs';
import { projectDebuffDependencies } from './turn_debuff_projection.mjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const cardInstance = card => card?.details?.instance_id;

export function sameTurn(plan, state) {
  return Boolean(plan && state.combat && plan.run_id === state.decision_context?.run_id
    && plan.combat_id === state.decision_context?.combat_id && plan.turn === state.combat.turn_number);
}

// A consistency check, not extra model knowledge. Ignore extraction time and
// unknown draw order. Original game observations remain in the step artifacts.
export function turnFingerprint(state) {
  const copy = structuredClone(state);
  delete copy.timestamp;
  if (copy.combat?.draw_pile) copy.combat.draw_pile.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash('sha256').update(JSON.stringify(copy)).digest('hex');
}

export function turnGuard(state, step = null) {
  if (!state.combat) return null;
  const combat = state.combat;
  const expectedEnemies = step ? projectDebuffDependencies(state, [step])?.enemies : null;
  return {
    energy: combat.player.energy, hp: combat.player.hp, powers: combat.player.powers,
    relics: combat.player.relics, orbs: combat.player.orbs,
    positioning: combat.positioning,
    hand: combat.hand.map(card => ({ id: card.id, instance_id: cardInstance(card), cost: card.cost, description: card.description, can_play: card.can_play })),
    enemies: combat.enemies.map(enemy => ({ combat_id: enemy.combat_id, hp: enemy.hp, block: enemy.block, is_alive: enemy.is_alive, intents: enemy.intents, powers: enemy.powers })),
    ...(expectedEnemies ? { expected_enemy_changes: expectedEnemies } : {})
  };
}

export function planStep(state, candidate, role = 'payoff') {
  const card = candidate.request.cmd === 'play_card' ? state.combat.hand.find(card => card.index === candidate.card_hand_index) : null;
  const potion = candidate.request.cmd === 'use_potion'
    ? state.combat.player.potions.filter(p => p.id.toUpperCase() === candidate.request.id.toUpperCase()).sort((a, b) => a.slot - b.slot)[candidate.request.nth || 0] : null;
  if (card && !cardInstance(card)) throw new Error('A turn plan requires stable card instance IDs');
  return {
    kind: candidate.request.cmd, role,
    description: card ? `Play ${card.name}${candidate.request.target !== undefined ? ` against combat_id ${candidate.request.target}` : ''}.`
      : potion ? `Use ${potion.name}.` : 'End the player turn after the preceding planned steps.',
    ...(card ? { card_instance_id: cardInstance(card), card_id: card.id, card_type: card.type, name: card.name, cost_at_planning: card.cost, rules_at_planning: card.description } : {}),
    ...(potion ? { potion_id: potion.id, slot: potion.slot, name: potion.name, rules_at_planning: potion.description } : {}),
    ...(candidate.request.target !== undefined ? { target: candidate.request.target } : {})
  };
}

// Rebuild nth from the live hand. Saving yesterday's wire command would select
// the wrong copy as earlier cards leave the hand.
export function resolvePlanStep(step, state, candidates) {
  if (!step) return null;
  const card = step.kind === 'play_card' ? state.combat?.hand.find(card => cardInstance(card) === step.card_instance_id) : null;
  const potion = step.kind === 'use_potion' ? state.combat?.player.potions.find(potion => potion.slot === step.slot && potion.id === step.potion_id) : null;
  for (const [id, candidate] of candidates) {
    if (candidate.request?.cmd !== step.kind || candidate.request.target !== step.target) continue;
    if (step.kind === 'play_card' && (!card || candidate.card_hand_index !== card.index)) continue;
    if (step.kind === 'use_potion') {
      if (!potion) continue;
      const copies = state.combat.player.potions.filter(p => p.id.toUpperCase() === potion.id.toUpperCase()).sort((a, b) => a.slot - b.slot);
      if (candidate.request.id !== potion.id || (candidate.request.nth || 0) !== copies.indexOf(potion)) continue;
    }
    return { ...candidate, candidate_id: id };
  }
  return null;
}

export function publicTurnPlan(plan, state) {
  if (!sameTurn(plan, state)) return null;
  return {
    source: 'Jev plan for this player turn; intentions are not observed effects. Recheck changed conditions before continuing.',
    revision: plan.revision, turn: plan.turn, objective: plan.objective,
    status: plan.status, next_step: plan.cursor,
    ordered_steps: plan.steps.map(({ description, ...step }, index) => ({ sequence: index, ...step,
      ...(step.card_instance_id ? { current_hand_index: state.combat.hand.find(card => cardInstance(card) === step.card_instance_id)?.index ?? null } : {}),
      status: index < plan.cursor ? 'confirmed' : 'intended' })),
    completed_actions: plan.completed_actions, review_reasons: plan.review_reasons,
    retained_cards: plan.retained_cards, continuation_intent: plan.continuation_intent,
    budget: plan.budget, end_policy: plan.end_policy
  };
}

export function inspectTurnPlan(plan, state, candidates) {
  if (!sameTurn(plan, state) || plan.status === 'completed' || state.combat.is_player_turn !== true) return { kind: 'new_turn' };
  const reasons = [...(plan.review_reasons || [])];
  if (plan.expected_fingerprint !== turnFingerprint(state)) reasons.push('Observation changed after the last confirmed command.');
  const next = resolvePlanStep(plan.steps[plan.cursor], state, candidates);
  if (!next) reasons.push('The next planned action is absent or no longer legal.');
  if (plan.retained_cards?.some(card => !state.combat.hand.some(current => cardInstance(current) === card.card_instance_id))) reasons.push('A card reserved for an automatic effect is no longer in hand.');
  // No implicit replay of a command whose result is still unresolved.
  if (plan.status === 'outcome_unknown') throw new Error('Turn plan has an unresolved command outcome');
  if (plan.status === 'needs_review' && !reasons.length) reasons.push('The planned segment needs a continuation.');
  return reasons.length ? { kind: 'review', reasons: [...new Set(reasons)], next } : { kind: 'continue', next };
}

export function plannedUpgradeSelection(plan, state, candidates) {
  if (!sameTurn(plan, state) || state.screen !== 'HAND_SELECT' || state.hand_select?.mode !== 'UpgradeSelect'
    || state.hand_select.selected_count !== 0 || state.hand_select.min_select !== 1 || state.hand_select.max_select !== 1) return null;
  const preceding = plan.steps[plan.cursor - 1];
  if (preceding?.role !== 'preparation' || !preceding.beneficiary_instance_id) return null;
  const beneficiary = state.combat.hand.find(card => cardInstance(card) === preceding.beneficiary_instance_id);
  if (!beneficiary) return null;
  // context.14 supplies the same identity in the modal as in the combat hand.
  const exact = state.hand_select.selectable_cards.filter(card => cardInstance(card) === preceding.beneficiary_instance_id);
  if (exact.length === 1) return [...candidates].map(([candidate_id, candidate]) => ({ ...candidate, candidate_id }))
    .find(candidate => candidate.request.cmd === 'hand_select_card' && candidate.card_hand_index === exact[0].index) || null;
  if (state.hand_select.selectable_cards.some(cardInstance)) return null;
  // Older upstream modals omit instance IDs. Only bind when identity is
  // unambiguous in both lists; never guess a duplicate's index.
  const sameId = card => (card.id || card.card_id)?.toUpperCase() === beneficiary.id.toUpperCase();
  const offered = state.hand_select.selectable_cards.filter(sameId);
  if (state.combat.hand.filter(sameId).length !== 1 || offered.length !== 1) return null;
  return [...candidates].map(([candidate_id, candidate]) => ({ ...candidate, candidate_id }))
    .find(candidate => candidate.request.cmd === 'hand_select_card' && candidate.card_hand_index === offered[0].index) || null;
}

// Reuse the same native-rule arithmetic used when choosing the sequence.
// Only exact HP, Block and known power amounts can explain a power change.
// Other powers retain their full records; changed intents and hand effects
// still require review independently. This never substitutes a predicted state.
function expectedEnemyPowers(before, after, expected) {
  if (!expected || !expected.power_changes.length) return false;
  for (const [field, range] of [['hp', expected.hp_remaining], ['block', expected.block_remaining]]) {
    if (!Number.isFinite(range?.min) || range.min !== range.max || after[field] !== range.min) return false;
  }
  if (expected.power_changes.some(p => !Number.isFinite(p.after_declared_actions.min)
    || p.after_declared_actions.min !== p.after_declared_actions.max)) return false;
  const changes = new Map(expected.power_changes.map(p => [p.power_id, p.after_declared_actions.min]));
  const projected = [...before.powers.filter(p => !changes.has(p.id)),
    ...[...changes].filter(([, amount]) => amount !== 0).map(([id, amount]) => ({ id, amount }))];
  const observed = after.powers.filter(p => !changes.has(p.id) || p.amount !== 0)
    .map(p => changes.has(p.id) ? { id: p.id, amount: p.amount } : p);
  const ordered = powers => powers.toSorted((a, b) => a.id.localeCompare(b.id));
  return same(ordered(projected), ordered(observed));
}

function changesRequiringReview(before, after, step, remaining) {
  if (!before || !after) return ['Combat observation became unavailable.'];
  const reasons = [];
  const cost = step?.kind === 'play_card' ? step.cost_at_dispatch < 0 ? before.energy : step.cost_at_dispatch : 0;
  if (after.energy !== before.energy - cost) reasons.push('Energy differs from the reserved printed cost; new actions may be possible.');
  for (const field of ['hp', 'powers', 'relics', 'orbs', 'positioning']) if (!same(before[field], after[field])) reasons.push(`Player ${field} changed.`);
  const old = new Map(before.hand.map(card => [card.instance_id, card]));
  for (const card of after.hand) {
    const previous = old.get(card.instance_id);
    if (!previous) reasons.push('A new or returned card entered the hand.');
    else if (card.id !== previous.id || card.cost !== costAfterAttacks(previous, step?.card_type === 'Attack' ? 1 : 0)
      || card.description !== previous.description) reasons.push('A card cost or effect changed.');
    else if (card.can_play && !previous.can_play) reasons.push('An additional card became playable.');
  }
  for (const future of remaining) if (future.card_instance_id && !after.hand.some(card => card.instance_id === future.card_instance_id)) reasons.push('A future planned card left the hand.');
  for (const enemy of after.enemies) {
    const previous = before.enemies.find(old => old.combat_id === enemy.combat_id);
    const expected = before.expected_enemy_changes?.find(e => e.combat_id === enemy.combat_id);
    if (!previous || (enemy.hp > 0 && enemy.is_alive) !== (previous.hp > 0 && previous.is_alive)
      || !same(enemy.intents, previous.intents)
      || !same(enemy.powers, previous.powers) && !expectedEnemyPowers(previous, enemy, expected)) reasons.push('Enemy availability, intent or powers changed.');
  }
  if (before.enemies.some(enemy => !after.enemies.some(other => other.combat_id === enemy.combat_id))) reasons.push('An enemy left combat.');
  return [...new Set(reasons)];
}

export function advanceTurnPlan(plan, pending, response, after) {
  if (!plan || pending?.turn_plan_id !== plan.id) return;
  if (!response.ok) {
    plan.status = ['TIMEOUT', 'EVENT_TIMEOUT', 'PURCHASE_TIMEOUT', 'INTERNAL_ERROR'].includes(response.error) ? 'outcome_unknown' : 'needs_review';
    plan.review_reasons = ['The last command did not have a confirmed successful result.'];
    return;
  }
  const step = Number.isInteger(pending.turn_step) && pending.turn_step === plan.cursor ? plan.steps[plan.cursor] : null;
  if (step) plan.cursor++;
  plan.completed_actions.push({ request: pending.request, role: step?.role || 'selection', after_screen: after.screen });
  if (!sameTurn(plan, after) || pending.request.cmd === 'end_turn' || after.combat?.is_combat_ending) {
    plan.status = 'completed';
    return;
  }
  const remaining = plan.steps.slice(plan.cursor);
  const dispatchStep = step ? { ...step, cost_at_dispatch: pending.turn_card_cost } : null;
  const reasons = changesRequiringReview(pending.turn_guard, turnGuard(after), dispatchStep, remaining);
  // A modal belongs to the preceding card, so keep its planned beneficiary.
  // Review accumulated changes after that card and its selection have resolved.
  const inSelection = ['HAND_SELECT', 'GRID_CARD_SELECT', 'TRI_SELECT'].includes(after.screen);
  if (!inSelection && !remaining.length) reasons.push('Planned actions are complete; assess the remaining turn.');
  plan.review_reasons = [...new Set([...(plan.review_reasons || []), ...reasons])];
  plan.status = inSelection ? 'awaiting_selection' : plan.review_reasons.length ? 'needs_review' : 'active';
  plan.expected_fingerprint = turnFingerprint(after);
}
