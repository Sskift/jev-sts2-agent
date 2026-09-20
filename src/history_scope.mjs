// Select a decision-relevant view without changing the complete local archive.
// Current values already encode old damage, purchases, counters and upgrades.
// Temporal/ordering dependencies broaden the window conservatively; they never
// assert that a historical effect is still active or reveal hidden draw order.
const selections = new Set(['hand_select_card', 'hand_confirm_selection', 'grid_select_card', 'tri_select_card', 'bundle_select']);
const rulesText = value => typeof value === 'string' ? value.replace(/\[[^\]]+\]/g, ' ') : '';
const ordering = /\b(?:top|bottom|order|rearrange|scry)\b[\s\S]*\b(?:draw pile|deck|cards)\b|\b(?:draw pile|deck)\b[\s\S]*\b(?:top|bottom|order|rearrange)\b/i;
const previousTurn = /\b(?:last|previous) (?:player |enemy )?turn\b/i;
const combatLookback = /\b(?:played|used|exhausted|discarded|drawn|lost|dealt|gained|times|each|every)\b[\s\S]*\bthis (?:combat|fight)\b/i;
function delayWindow(text) {
  const numbers = { one: 1, two: 2, three: 3 };
  return Math.max(/\bnext turn\b/i.test(text) ? 1 : 0,
    ...[...text.matchAll(/\bin (\d+|one|two|three) turns?\b/gi)].map(match => numbers[match[1].toLowerCase()] ?? Number(match[1])));
}

function activeRules(state) {
  const found = [];
  const visit = (value, path) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach((item, i) => visit(item, `${path}[${i}]`)); return; }
    if (value.description) found.push({ source: path, id: value.id ?? value.card_id ?? null, text: rulesText(value.description) });
    for (const [key, child] of Object.entries(value)) {
      if (['combat_history', 'history', 'glossary', 'map'].includes(key)) continue;
      visit(child, `${path}.${key}`);
    }
  };
  visit(state.combat, 'combat');
  // Owned build, including exhausted/temporarily absent cards, can contain
  // mechanics whose count is not yet exported as an explicit native counter.
  visit(state.decision_context?.master_deck, 'deck');
  visit(state.decision_context?.glossary, 'native_glossary');
  return found;
}

export function decisionHistoryPolicy(state, archive) {
  const context = state.decision_context;
  if (!state.combat) return { mode: 'current_room', floor: context?.total_floor, reasons: [] };
  const round = state.combat.turn_number, reasons = [], orderingWindows = [], rules = activeRules(state);
  let fromRound = round;
  const keepFrom = (from, reason) => { fromRound = Math.min(fromRound, from); reasons.push(reason); };
  const lookback = rules.find(rule => combatLookback.test(rule.text));
  if (lookback) keepFrom(0, { kind: 'combat_history_dependency', rule_id: lookback.id, source: lookback.source });
  const previous = rules.find(rule => previousTurn.test(rule.text));
  if (previous) keepFrom(Math.max(0, round - 1), { kind: 'previous_turn_dependency', rule_id: previous.id, source: previous.source });
  const actions = (archive?.run_id === context?.run_id ? archive.actions : []) || [];
  const inCombat = actions.filter(action => action.ok && action.combat_id === context.combat_id);
  const drawIds = new Set(state.combat.draw_pile.map(card => card.id));
  for (const [i, action] of inCombat.entries()) {
    if (!Number.isInteger(action.round) || action.round >= round) continue;
    const effect = action.played_card_at_request || action.potion_at_request;
    const text = rulesText(effect?.description);
    if (round - action.round <= delayWindow(text)) keepFrom(action.round, { kind: 'recent_delayed_effect', rule_id: effect.id });
    if (!ordering.test(text)) continue;
    const following = [];
    for (const next of inCombat.slice(i + 1)) {
      if (!selections.has(next.request.cmd)) break;
      following.push(next);
    }
    const chosen = following.flatMap(next => next.request.card_ids || []);
    // If the operation selected cards and none of those identities remain in
    // the draw pile, its old placement cannot determine a future draw now.
    // Otherwise retain the intervening evidence (draws/shuffles included).
    if (chosen.length && !chosen.some(id => drawIds.has(id))) continue;
    orderingWindows.push({ round: action.round, rule_id: effect.id });
  }
  if (orderingWindows.length) reasons.push({ kind: 'possible_remaining_order_knowledge',
    note: 'Only ordering commands and intervening card draws, discards, exhausts or shuffles are retained from these older windows. This is past evidence, not a claim that the order still holds.' });
  return { mode: 'current_turn_and_dependencies', floor: context.total_floor, current_round: round, from_round: fromRound,
    preceding_enemy_round: Math.max(0, round - 1), ordering_windows: orderingWindows,
    reasons: [...new Map(reasons.map(reason => [JSON.stringify(reason), reason])).values()] };
}

export function relevantCombatEvent(event, policy) {
  return !Number.isInteger(event.round) || event.round >= policy.from_round
    || (event.round === policy.preceding_enemy_round && event.side === 'Enemy')
    || policy.ordering_windows.some(window => event.round >= window.round
      && (['CardDrawnEntry', 'CardDiscardedEntry', 'CardExhaustedEntry'].includes(event.type) || /shuffl/i.test(event.type)
        || (event.round === window.round && event.card_id === window.rule_id && /^CardPlay/.test(event.type))));
}

export function relevantMemoryAction(action, state, policy) {
  if (action.floor !== state.decision_context?.total_floor) return false;
  if (!state.combat) return !action.combat_id;
  if (action.combat_id !== state.decision_context.combat_id) return false;
  return !Number.isInteger(action.round) || action.round >= policy.from_round
    || policy.ordering_windows.some(window => action.round === window.round
      && (action.request.id === window.rule_id || selections.has(action.request.cmd)));
}

/** Apply the policy before encoding. All current observations, rule references,
 * legal alternatives and active intentions stay intact. An omitted log is not
 * model memory; coverage states exactly which evidence was selected.
 */
export function scopeDecisionHistory(packet, state, memory) {
  const policy = decisionHistoryPolicy(state, memory.data);
  const before = packet.combat?.history.length ?? 0;
  if (packet.combat) {
    packet.combat.history = packet.combat.history.filter(event => relevantCombatEvent(event, policy));
    packet.combat.history_coverage += ' Decision view contains this round, the preceding enemy response, and earlier rounds for explicit temporal dependencies. Possible older draw-order knowledge retains only its commands and intervening card-movement events. Unnumbered events are retained conservatively. Earlier ordinary events remain in the local archive; current HP, piles, powers, relics and counters are authoritative.';
  }
  const local = packet.memory;
  local.actions = local.actions.filter(action => relevantMemoryAction(action, state, policy));
  // Snapshot deltas duplicate current resources and the selected engine events.
  // Paired recent command results remain in decision_brief for causal continuity.
  local.observations = [];
  delete local.relic_updates;
  delete local.travel_history;
  local.coverage = 'Decision-scoped local memory: current-room choices outside combat; current-turn and dependency-window commands in combat. Old room purchases, travel, resource deltas and expired routine combat traces are not included. Current deck, resources, map, powers and relic counters hold their surviving results. The complete local archive is not implicit model memory.';
  local.relevance = { ...policy, engine_events_available: before, engine_events_included: packet.combat?.history.length ?? 0 };
  if (packet.decision_brief) {
    packet.decision_brief.recent_confirmed_actions = packet.decision_brief.recent_confirmed_actions.filter(action =>
      !Number.isInteger(action.round) || action.round >= policy.from_round
      || (action.request.cmd === 'end_turn' && action.round === policy.preceding_enemy_round));
    packet.decision_brief.purpose = 'Recent observed results relevant to this decision. Current state is authoritative; these are past effects, not a forced plan or promised future.';
    packet.decision_brief.history_coverage = 'Up to four recent confirmed commands within the retained decision window; null paired changes mean unavailable. Earlier ordinary traces are not included.';
  }
  // Tactical choices need the current strategic direction, not its biography.
  if (state.combat && packet.run_strategy) {
    packet.run_strategy.revisions = [];
    if (packet.run_strategy.revision_coverage) {
      packet.run_strategy.revision_coverage.policy = 'current_assessment_only_in_combat';
      packet.run_strategy.revision_coverage.intention_changes_included = 0;
      packet.run_strategy.revision_coverage.scope = 'Current strategic intention and complete current capability assessment are included. Earlier strategy changes are archived locally and omitted from tactical decisions.';
    }
  }
  return packet;
}
