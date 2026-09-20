import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import Ajv2020 from 'ajv/dist/2020.js';
import { previewDamageSum } from './combat_arithmetic.mjs';
import { buildRuleReference } from './rule_reference.mjs';
import { combatFrame, observedCombatChange, buildDecisionBrief } from './decision_brief.mjs';
import { sameTurn, publicTurnPlan, turnGuard, advanceTurnPlan } from './turn_plan_state.mjs';
import { campPlanApplicable, publicCampTarget } from './camp_plan_state.mjs';
import { potionEffectFacts } from './potion_effects.mjs';
import { positioningError } from './combat_positioning.mjs';
import { publicRunStrategy } from './run_strategy_state.mjs';
import { scopeDecisionHistory } from './history_scope.mjs';
import { describeCombatEffects } from './effect_lifecycle.mjs';

export const CONTEXT_VERSION = 'sts2.decision.v1';
export class ContextError extends Error {
  constructor(message, details = {}) { super(message); this.name = 'ContextError'; this.details = details; }
}

const protocolSchema = JSON.parse(fs.readFileSync(new URL('../schemas/decision-context.v1.schema.json', import.meta.url), 'utf8'));
const protocolCheck = new Ajv2020({ allErrors: true, strict: true }).compile(protocolSchema);
export function validateDecisionPacket(rawPacket) {
  const packet = expandRecordTables(rawPacket);
  if (!protocolCheck(packet)) throw new ContextError('Decision JSON does not match the versioned protocol', { errors: clone(protocolCheck.errors) });
  if (packet.in_combat !== Boolean(packet.combat)) throw new ContextError('in_combat contradicts combat data');
  if (packet.run_strategy && packet.run_strategy.run_id !== packet.run?.run_id) throw new ContextError('Strategic intention belongs to another run');
  if (packet.run_strategy) {
    const strategy = packet.run_strategy;
    if (strategy.basis.run_id !== strategy.run_id || strategy.freshness.needs_review !== (strategy.freshness.reason !== null)) throw new ContextError('Strategic review metadata is inconsistent');
    if (!strategy.freshness.needs_review) {
      const anchor = strategy.anchor;
      const present = anchor.kind === 'none' ? anchor.id === null : anchor.kind === 'card'
        ? packet.deck.cards.some(group => group.card.id === anchor.id) : packet.player.relics.some(relic => relic.id === anchor.id);
      if (!present) throw new ContextError('Current strategic anchor does not belong to the owned build');
    }
  }
  if (packet.combat) {
    const issue = positioningError({ ...packet.combat, player: packet.player });
    if (issue) throw new ContextError(issue);
  }
  if (packet.resources?.potion_effects) {
    const resolveText = value => value?.text_ref ? packet.text_dictionary?.[value.text_ref] : value;
    const expected = (packet.player?.potions || []).map(potion => potionEffectFacts({ ...potion, description: resolveText(potion.description) })).filter(Boolean);
    const actual = packet.resources.potion_effects.map(effect => ({ ...effect, source: resolveText(effect.source) }));
    if (!isDeepStrictEqual(actual, expected)) throw new ContextError('Potion effect facts contradict the current potion rules or slots');
  }
  if (packet.map?.routes) {
    const expected = routeFacts(packet.map, packet.map.legal_next_nodes);
    if (!isDeepStrictEqual(packet.map.routes, expected)) throw new ContextError('Route facts contradict the visible map or legal next nodes');
  }
  const reservation = packet.turn_planning?.energy_reservation;
  if (reservation) {
    let remaining = reservation.observed_energy;
    if (remaining !== packet.player?.energy) throw new ContextError('Planned energy does not start from observed player energy');
    const proposed = packet.turn_planning.proposed_steps || [];
    if (proposed.length !== reservation.steps.length) throw new ContextError('Energy reservation omits proposed steps');
    for (const [index, step] of reservation.steps.entries()) {
      if (step.sequence !== index || step.energy_before !== remaining || step.energy_after !== remaining - step.reserved_cost
        || step.affordable !== (step.reserved_cost <= remaining)) throw new ContextError('Inconsistent energy transition in proposed sequence');
      if (step.kind !== proposed[index].kind || (step.kind === 'play_card'
        ? !packet.combat?.hand.some(card => card.index === step.hand_index) : step.hand_index !== null)) throw new ContextError('Energy transition does not refer to the proposed action and observed hand');
      remaining = step.energy_after;
    }
    if (remaining !== reservation.remaining_after_printed_costs || (reservation.is_observed && reservation.steps.length)) throw new ContextError('Energy reservation contradicts its sequence or observation status');
  }
  const actionIds = packet.legal_actions.map(a => a.action_id);
  const actions = packet.turn_planning?.action_reservation;
  if (actions) {
    const proposed = packet.turn_planning.proposed_steps || [];
    if (actions.transitions.length !== proposed.length) throw new ContextError('Action reservation omits proposed steps');
    let starts = 0;
    for (const [index, step] of actions.transitions.entries()) {
      const violated = step.kind === 'play_card' ? actions.constraints.filter(rule =>
        rule.affected_card_instance_ids.includes(step.card_instance_id) && starts > rule.maximum_prior_card_starts).map(rule => rule.rule_id) : [];
      if (step.sequence !== index || step.kind !== proposed[index].kind || step.card_instance_id !== proposed[index].card_instance_id
        || step.card_starts_before !== starts || step.card_starts_after !== starts + Number(step.kind === 'play_card')
        || step.allowed !== (violated.length === 0) || !isDeepStrictEqual(step.violated_rules, violated)) throw new ContextError('Inconsistent action reservation');
      starts = step.card_starts_after;
    }
    if (actions.valid !== actions.transitions.every(step => step.allowed)) throw new ContextError('Action reservation contradicts its validity');
  }
  if (new Set(actionIds).size !== actionIds.length) throw new ContextError('Duplicate legal action IDs');
  const assessedIds = packet.strategy_assessment?.options?.map(option => option.action_id) || [];
  if (new Set(assessedIds).size !== assessedIds.length || assessedIds.some(id => !actionIds.includes(id))) throw new ContextError('Option assessment must refer to distinct legal actions');
  for (const action of packet.legal_actions) if (action.request === null && (!action.planning_choice || !packet.screen_state.selection_planning)) throw new ContextError('A non-dispatchable choice requires an explicit selection planning stage');
  const visit = item => {
    if (!item || typeof item !== 'object') return;
    if (item.text_ref && typeof packet.text_dictionary?.[item.text_ref] !== 'string') throw new ContextError('Dangling rule reference in decision JSON');
    if ('deck_group_index' in item && (!Number.isInteger(item.deck_group_index) || !packet.deck?.cards[item.deck_group_index])) throw new ContextError('Dangling permanent deck reference in decision JSON');
    if (['record_table_v1', 'record_table_v2'].includes(item.encoding)) for (const row of item.rows) {
      const layout = item.layouts[row[0]], fields = item.encoding === 'record_table_v2' ? layout?.fields : layout;
      if (!Number.isInteger(row[0]) || !Array.isArray(fields) || row.length !== fields.length + 1) throw new ContextError('Malformed decision history table');
    }
    Object.values(item).forEach(visit);
  };
  visit(packet);
  return rawPacket;
}

const clone = value => structuredClone(value);
export function cardRewardKey(reward) {
  if (!Array.isArray(reward?.card_choices)) return null;
  // Reward indices shift as gold and potions are claimed; the offered cards do not.
  const cards = reward.card_choices.map(({ index, ...card }) => card);
  return createHash('sha256').update(JSON.stringify(cards)).digest('hex');
}
const keyOf = node => `${node.col},${node.row}`;
const preRun = new Set(['MENU', 'SINGLEPLAYER_SUBMENU', 'CHARACTER_SELECT', 'GAME_OVER']);
const array = (value, name) => { if (!Array.isArray(value)) throw new ContextError(`Missing context array: ${name}`); return value; };

// Canonicalize only unordered piles, never hand positions, discard order,
// selected cards, or action/history sequences. Every card attribute is retained.
export function canonicalObservation(state) {
  const copy = clone(state);
  delete copy.timestamp;
  if (copy.combat?.draw_pile) copy.combat.draw_pile.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return copy;
}

export function validateContext(state) {
  if (preRun.has(state.screen)) return;
  const context = state.decision_context;
  if (context?.schema_version !== 1 || !context.run_id) throw new ContextError('Complete decision context requires mod 0.111.0-context.1 or newer; install the context build before playing.');
  const errors = array(context.extraction_errors, 'extraction_errors');
  // The game can no longer format a consumed potion's history text after its
  // owner is detached. The typed event and local action/result remain intact.
  const fatal = errors.filter(error => !/^history\.\d+\.description: NullReferenceException$/.test(error));
  if (fatal.length) throw new ContextError('The mod reported incomplete decision context', { extraction_errors: fatal });
  const player = context.player;
  for (const field of ['act_index', 'act_floor', 'total_floor', 'ascension', 'potion_capacity']) if (!Number.isInteger(context[field]) || context[field] < 0) throw new ContextError(`Missing run.${field}`);
  array(context.modifiers, 'modifiers');
  array(context.glossary, 'glossary');
  for (const field of ['hp', 'max_hp', 'gold', 'deck_count']) if (!Number.isFinite(player?.[field])) throw new ContextError(`Missing player.${field}`);
  for (const field of ['relics', 'potions', 'powers']) array(player[field], `player.${field}`);
  const deck = array(context.master_deck, 'master_deck');
  if (deck.length !== player.deck_count) throw new ContextError('Master deck count does not match its contents');
  array(context.map?.nodes, 'map.nodes');
  if (context.map.act_index !== context.act_index) throw new ContextError('Map belongs to a different act');
  const checkCards = (cards, source) => {
    for (const card of cards) if (!card.id || typeof card.description !== 'string' || !card.description.trim()) throw new ContextError(`Missing card rules in ${source}`, { card_id: card.id });
  };
  checkCards(deck, 'master_deck');
  const checkEffects = (effects, label) => {
    for (const effect of effects) if (!effect.id || !effect.description?.trim()) throw new ContextError(`Missing ${label} effect rules`, { id: effect.id });
  };
  for (const field of ['relics', 'potions', 'powers']) checkEffects(player[field], `player.${field}`);
  if (state.combat) {
    const issue = positioningError(state.combat);
    if (issue) throw new ContextError(issue);
    if (!context.combat_id) throw new ContextError('Missing combat identity');
    array(context.combat_history, 'combat_history');
    array(context.play_pile, 'play_pile');
    checkCards(context.play_pile, 'play_pile');
    for (const [pile, count] of [['hand', 'hand_count'], ['draw_pile', 'draw_count'], ['discard_pile', 'discard_count'], ['exhaust_pile', 'exhaust_count']]) {
      const cards = array(state.combat[pile], `combat.${pile}`);
      if (cards.length !== state.combat.player?.[count]) throw new ContextError(`Incomplete combat.${pile}`);
      checkCards(cards, pile);
    }
    array(state.combat.enemies, 'combat.enemies');
    for (const enemy of state.combat.enemies) {
      checkEffects(array(enemy.powers, 'enemy.powers'), 'enemy.powers');
      array(enemy.intents, 'enemy.intents');
      for (const intent of enemy.intents) if (!intent.description?.trim() && !intent.type) throw new ContextError('Enemy intent description and visible type are missing');
    }
    if (JSON.stringify(state.combat.player) !== JSON.stringify(player)) throw new ContextError('Player snapshots disagree inside one observation');
  }
}

// Lossless multiplicity grouping. A modified/upgraded copy remains a separate
// entry; opaque card IDs are retained, and array position never means draw order.
export function groupCards(cards) {
  const groups = new Map();
  for (const original of cards) {
    const card = clone(original);
    const instance = card.details?.instance_id;
    if (instance) delete card.details.instance_id;
    const signature = JSON.stringify(card);
    if (!groups.has(signature)) groups.set(signature, { card, count: 0, instance_ids: [] });
    const group = groups.get(signature);
    group.count++;
    if (instance) group.instance_ids.push(instance);
  }
  return [...groups.values()].sort((a, b) => JSON.stringify(a.card).localeCompare(JSON.stringify(b.card))).map(g => ({ ...g, instance_ids: g.instance_ids.sort() }));
}

export function routeFacts(map, choices) {
  const nodes = new Map(map.nodes.map(node => [keyOf(node), node]));
  const memo = new Map(), visiting = new Set();
  const types = ['MONSTER', 'ELITE', 'REST_SITE', 'SHOP', 'TREASURE', 'UNKNOWN', 'BOSS'];
  function bounds(id) {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) throw new ContextError('Map contains a cycle');
    const node = nodes.get(id);
    if (!node) throw new ContextError(`Map edge points to missing node ${id}`);
    visiting.add(id);
    const children = node.type === 'BOSS' ? [] : (node.children || []).map(child => bounds(keyOf(child)));
    const result = { reaches_boss: node.type === 'BOSS' || children.some(c => c.reaches_boss), counts: {} };
    for (const type of types) {
      const own = Number(node.type === type);
      result.counts[type] = { min: own + (children.length ? Math.min(...children.map(c => c.counts[type].min)) : 0), max: own + (children.length ? Math.max(...children.map(c => c.counts[type].max)) : 0) };
    }
    const continuation = children.map(child => child.minimum_elite_route_example).filter(Boolean)
      .sort((a, b) => a.known_elites - b.known_elites)[0];
    result.minimum_elite_route_example = node.type === 'BOSS' || continuation ? {
      known_elites: Number(node.type === 'ELITE') + (continuation?.known_elites || 0),
      nodes: [{ col: node.col, row: node.row, type: node.type }, ...(continuation?.nodes || [])]
    } : null;
    visiting.delete(id); memo.set(id, result); return result;
  }
  return choices.map(choice => {
    const id = keyOf(choice);
    const result = bounds(id), nearest = {}, visited = new Set(), queue = [[id, 0]];
    for (let i = 0; i < queue.length; i++) {
      const [at, distance] = queue[i];
      if (visited.has(at)) continue;
      visited.add(at);
      const node = nodes.get(at);
      nearest[node.type] ??= distance;
      if (node.type !== 'BOSS') for (const child of node.children || []) queue.push([keyOf(child), distance + 1]);
    }
    return { next_node: choice, reachable_node_count: visited.size, nearest_steps_after_chosen_node: nearest, ...result,
      known_elite_required_to_reach_boss: result.minimum_elite_route_example ? result.minimum_elite_route_example.known_elites > 0 : null };
  });
}

function playerChanges(before, after) {
  const a = before.decision_context?.player || before.combat?.player;
  const b = after.decision_context?.player || after.combat?.player;
  const changes = {};
  for (const field of ['hp', 'max_hp', 'gold', 'energy', 'block', 'deck_count']) if (Number.isFinite(a?.[field]) && Number.isFinite(b?.[field]) && a[field] !== b[field]) changes[field] = { before: a[field], after: b[field] };
  for (const field of ['relics', 'potions']) if (a?.[field] && b?.[field] && JSON.stringify(a[field]) !== JSON.stringify(b[field])) changes[field] = { before: a[field], after: b[field] };
  for (const field of ['master_deck']) if (before.decision_context?.[field] && after.decision_context?.[field] && JSON.stringify(before.decision_context[field]) !== JSON.stringify(after.decision_context[field])) changes[field] = { before: groupCards(before.decision_context[field]), after: groupCards(after.decision_context[field]) };
  return changes;
}

function deckDifference(change) {
  const counts = groups => new Map(groups.map(g => [JSON.stringify(g.card), { card: g.card, count: g.count }]));
  const before = counts(change.before), after = counts(change.after), added = [], removed = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const delta = (after.get(key)?.count || 0) - (before.get(key)?.count || 0);
    if (delta > 0) added.push({ card: after.get(key).card, count: delta });
    if (delta < 0) removed.push({ card: before.get(key).card, count: -delta });
  }
  return { added, removed };
}

function effectDifference(change) {
  const key = item => `${item.id}:${item.slot ?? ''}`;
  const before = new Map(change.before.map(item => [key(item), item]));
  const after = new Map(change.after.map(item => [key(item), item]));
  const added = [], removed = [], updated = [];
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(id), b = after.get(id);
    if (!a) { added.push(b); continue; }
    if (!b) { removed.push(a); continue; }
    const fields = {};
    for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[field]) !== JSON.stringify(b[field])) fields[field] = { before: a[field] ?? null, after: b[field] ?? null };
    }
    if (Object.keys(fields).length) updated.push({ id: b.id, ...(b.slot !== undefined ? { slot: b.slot } : {}), fields });
  }
  return { added, removed, updated };
}

export class DecisionMemory {
  constructor({ file } = {}) {
    this.file = file;
    this.data = { version: 1, run_id: null, actions: [], observations: [], pending: null };
    if (file && fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.actions) || !Array.isArray(data.observations)) throw new ContextError('Unsupported or corrupt decision memory');
      this.data = data;
    }
    this.last = null;
  }
  persist() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.data) + '\n');
    // Windows may briefly deny replacement while an indexer or reader holds
    // the destination. Preserve atomic replacement and retry only that case.
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(temporary, this.file); break; }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * 2 ** attempt);
      }
    }
  }
  observe(state) {
    const runId = state.decision_context?.run_id || null;
    if (runId && runId !== this.data.run_id) {
      this.data = { version: 1, run_id: runId, actions: [], observations: [], pending: null, started_at_floor: state.decision_context.total_floor, coverage: 'Agent observations since attachment; game history supplies earlier events where available.' };
      this.last = null;
    }
    if (this.last && runId && runId === this.last.decision_context?.run_id) {
      const changes = playerChanges(this.last, state);
      if (Object.keys(changes).length) this.data.observations.push({ floor: state.decision_context.total_floor, combat_id: state.decision_context.combat_id || this.last.decision_context?.combat_id || null, changes, source: 'observed snapshots; cause may be agent, game, or human' });
    }
    this.last = clone(state);
    this.persist();
  }
  begin(request, state, { turnPlan, turnStep, campUpgradePlan } = {}) {
    if (this.data.pending) throw new ContextError('An earlier action has an unresolved outcome; inspect the saved memory before continuing.');
    if (turnPlan && !sameTurn(turnPlan, state)) throw new ContextError('Cannot attach a plan from another turn');
    if (campUpgradePlan && (!campPlanApplicable(campUpgradePlan, state) || state.screen !== 'REST_SITE'
      || request.cmd !== 'choose_rest_option' || request.id !== 'SMITH')) throw new ContextError('Cannot attach a stale or unrelated camp plan');
    const matching = state.combat?.hand?.filter(card => card.id.toUpperCase() === request.id?.toUpperCase()).sort((a, b) => a.index - b.index);
    this.data.pending = { request: clone(request), floor: state.decision_context?.total_floor, combat_id: state.decision_context?.combat_id || null, round: state.combat?.turn_number, screen: state.screen,
      ...(state.combat ? { combat_frame_before: combatFrame(state) } : {}),
      ...(request.cmd === 'play_card' ? { played_card_at_request: clone(matching?.[request.nth ?? 0]) } : {}) };
    if (request.cmd === 'use_potion') this.data.pending.potion_at_request = clone(state.decision_context?.player?.potions.filter(p => p.id.toUpperCase() === request.id?.toUpperCase()).sort((a, b) => a.slot - b.slot)[request.nth ?? 0]);
    if (request.cmd === 'reward_skip_card') this.data.pending.card_reward_key = cardRewardKey(state.rewards?.rewards?.filter(reward => reward.type.toLowerCase() === 'card')[request.nth ?? 0]);
    if (campUpgradePlan) this.data.pending.camp_upgrade_plan = clone(campUpgradePlan);
    if (turnPlan) {
      this.data.turn_plan = clone(turnPlan);
    }
    if (sameTurn(this.data.turn_plan, state)) {
      this.data.pending.turn_plan_id = this.data.turn_plan.id;
      this.data.pending.turn_step = turnStep;
      this.data.pending.turn_guard = turnGuard(state);
      this.data.pending.turn_card_cost = request.cmd === 'play_card' ? matching?.[request.nth ?? 0]?.cost : 0;
    }
    this.persist();
  }
  finish(response, after) {
    advanceTurnPlan(this.data.turn_plan, this.data.pending, response, after);
    // Promote only a confirmed Smith action. Failed/uncertain commands cannot
    // authorize automatic selection; the existing pending guard handles them.
    if (this.data.pending?.camp_upgrade_plan && response.ok) this.data.camp_upgrade_plan = clone(this.data.pending.camp_upgrade_plan);
    else delete this.data.camp_upgrade_plan;
    const change = response.ok && this.data.pending?.combat_id === after.decision_context?.combat_id
      ? observedCombatChange(this.data.pending?.combat_frame_before, after) : null;
    const recorded = { ...this.data.pending, ok: response.ok, result: clone(response.data ?? response.error ?? null), after_screen: after.screen,
      ...(change ? { observed_combat_change: change } : {}) };
    delete recorded.combat_frame_before;
    delete recorded.turn_guard;
    delete recorded.turn_card_cost;
    delete recorded.camp_upgrade_plan;
    this.data.actions.push(recorded);
    this.data.pending = !response.ok && ['TIMEOUT', 'EVENT_TIMEOUT', 'PURCHASE_TIMEOUT', 'INTERNAL_ERROR'].includes(response.error) ? { ...this.data.pending, outcome_unknown: true, error: response.error } : null;
    this.persist();
  }
  context(state) {
    if (state.decision_context?.run_id !== this.data.run_id) return { coverage: 'No matching run memory', actions: [], observations: [] };
    const combatId = state.decision_context?.combat_id;
    const pureFlow = new Set(['proceed', 'continue_run', 'advance_dialogue']);
    const currentActStart = state.decision_context.total_floor - state.decision_context.act_floor;
    const visited = new Set((state.decision_context.map?.visited || []).map(keyOf));
    const actions = clone(this.data.actions.filter(a => (!a.combat_id || a.combat_id === combatId)
      && !(a.floor < state.decision_context.total_floor && (pureFlow.has(a.request.cmd) || a.result?.is_proceed))
      // The map's ordered visited list already records these exact choices.
      // Keep older-act travel and failed/unmatched requests in memory.
      && !(a.ok && a.request.cmd === 'choose_map_node' && a.floor >= currentActStart
        && visited.has(`${a.request.args?.[0]},${a.request.args?.[1]}`))));
    for (const action of actions) {
      delete action.card_reward_key; // Local identity bookkeeping; the skip action itself is retained.
      delete action.observed_combat_change; // Recent pairs appear in decision_brief; full engine history is retained.
      delete action.turn_plan_id; // Full plan/revision evidence stays in step artifacts.
      delete action.turn_step;
      if (action.floor < state.decision_context.total_floor && action.result?.event_state) {
        const event = action.result.event_state;
        action.result = { event_id: event.event_id, title: event.title, description: event.description, chosen_options: event.options?.filter(option => option.was_chosen) || [] };
      }
      // Successful card/turn effects are already in the same combat's complete
      // engine history. Keep the command, outcome and the card's then-current
      // rules, instead of duplicating each engine event in two histories.
      if (action.ok && combatId && action.combat_id === combatId && state.decision_context.combat_history?.length
        && ['play_card', 'use_potion', 'end_turn'].includes(action.request.cmd)) delete action.result;
      if (action.ok && action.result && typeof action.result === 'object' && !Array.isArray(action.result)) {
        // Command echoes and success flags do not add information to a
        // successful action. Preserve every non-echo outcome/effect field.
        for (const [key, value] of Object.entries(action.result)) {
          if (JSON.stringify(value) === JSON.stringify(action.request[key])
            || (key === 'screen' && value === action.after_screen)
            || (key === 'claimed' && value === true)) delete action.result[key];
        }
        if (!Object.keys(action.result).length) delete action.result;
      }
      if (action.played_card_at_request) {
        const card = action.played_card_at_request;
        for (const key of ['index', 'can_play', 'valid_target_ids', 'target_previews', 'tags', 'rarity']) delete card[key];
      }
    }
    const travel = [], decisions = [];
    for (const action of actions) {
      if (action.ok && action.request.cmd === 'choose_map_node' && action.request.args?.length === 2) {
        travel.push({ floor: action.floor, col: action.request.args[0], row: action.request.args[1], type: action.result?.type ?? 'UNKNOWN', arrived_screen: action.after_screen });
      } else decisions.push(action);
    }
    const observations = [], completedRooms = new Map();
    for (const observation of this.data.observations) {
      if (observation.floor >= state.decision_context.total_floor
        && (!observation.combat_id || observation.combat_id === combatId)) { observations.push(observation); continue; }
      const previousAct = observation.floor <= currentActStart;
      const key = previousAct ? 'earlier_acts' : observation.floor;
      const room = completedRooms.get(key) || (previousAct
        ? { scope: 'earlier_acts', from_floor: observation.floor, through_floor: observation.floor, changes: {} }
        : { floor: observation.floor, changes: {} });
      if (previousAct) room.through_floor = Math.max(room.through_floor, observation.floor);
      for (const [field, change] of Object.entries(observation.changes)) {
        if (['block', 'energy'].includes(field)) continue;
        room.changes[field] = { before: room.changes[field]?.before ?? change.before, after: change.after };
      }
      completedRooms.set(key, room);
    }
    const relevant = clone([...completedRooms.values(), ...observations]);
    for (const observation of relevant) {
      for (const [field, change] of Object.entries(observation.changes)) {
        if (JSON.stringify(change.before) === JSON.stringify(change.after)) delete observation.changes[field];
      }
      // Current values and the engine's EnergySpent/BlockGained history already
      // describe combat resources. Do not send a second per-action snapshot log.
      if (combatId && observation.combat_id === combatId && state.decision_context.combat_history?.length) {
        delete observation.changes.energy;
        delete observation.changes.block;
      }
      if (observation.changes.master_deck?.before) observation.changes.master_deck = deckDifference(observation.changes.master_deck);
      for (const field of ['relics', 'potions']) if (observation.changes[field]?.before) observation.changes[field] = effectDifference(observation.changes[field]);
    }
    // Flatten frequently changing relic counters instead of repeating nested
    // arrays for every card play. Sequence numbers retain their position beside
    // simultaneous HP/resource changes; no observed field change is discarded.
    const relicUpdates = [];
    for (const [sequence, observation] of relevant.entries()) {
      observation.observation_sequence = sequence;
      const relics = observation.changes.relics;
      if (!relics?.updated?.length) continue;
      for (const update of relics.updated) for (const [field, values] of Object.entries(update.fields)) relicUpdates.push({ observation_sequence: sequence, floor: observation.floor, ...(observation.combat_id ? { combat_id: observation.combat_id } : {}), id: update.id, field, ...values });
      relics.updated = [];
      if (!relics.added.length && !relics.removed.length) delete observation.changes.relics;
    }
    if (!relicUpdates.length) for (const observation of relevant) delete observation.observation_sequence;
    return { coverage: `${this.data.coverage} Current-act completed rooms retain net resource/deck changes per room; earlier acts use one net change summary across its floor range. Strategic choices and event outcomes remain listed. Intermediate snapshots and expired combat actions stay in local logs. Successful travel already in map.visited and command echoes are not duplicated; other successful travel is in travel_history. Combat energy/Block use current values and engine history. Deck changes list added/removed copies; an upgrade replaces its former state. Relic/potion changes list added, removed and updated fields. Relic field updates use relic_updates, sharing observation_sequence with observations to preserve their order and simultaneous changes.`, actions: decisions, ...(travel.length ? { travel_history: travel } : {}), observations: relevant.filter(o => Object.keys(o.changes).length), ...(relicUpdates.length ? { relic_updates: relicUpdates } : {}), pending: clone(this.data.pending) };
  }
}

function mergeObservedCardPlays(combat, memoryContext) {
  if (!combat?.history?.length) return;
  const keyFor = (round, instance, id) => instance ? JSON.stringify([round, instance, id]) : null;
  const groups = new Map();
  for (const action of memoryContext.actions) {
    if (!action.ok || action.request.cmd !== 'play_card' || !action.played_card_at_request) continue;
    const card = action.played_card_at_request;
    const key = keyFor(action.round, card.details?.instance_id, action.request.id);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(action);
  }
  const merged = new Set();
  for (const [key, actions] of groups) {
    const matches = combat.history.filter(entry => keyFor(entry.round, entry.card_instance_id, entry.card_id) === key);
    const starts = matches.filter(entry => entry.type === 'CardPlayStartedEntry');
    const finishes = matches.filter(entry => entry.type === 'CardPlayFinishedEntry');
    // Autoplay, human actions or an unfinished play make correspondence unclear.
    // Retain both logs unless the entire round/instance group matches one to one.
    if (starts.length !== actions.length || finishes.length !== actions.length) continue;
    for (const [index, action] of actions.entries()) {
      const entry = starts[index];
      entry.played_card_at_request = action.played_card_at_request;
      if (action.request.target !== undefined) entry.selected_target_combat_id = action.request.target;
      if (action.request.nth !== undefined) entry.selected_duplicate_nth = action.request.nth;
      entry.agent_after_screen = action.after_screen;
      merged.add(action);
    }
  }
  if (merged.size) {
    memoryContext.actions = memoryContext.actions.filter(action => !merged.has(action));
    combat.history_coverage += ' Matched successful Agent card choices are attached to CardPlayStartedEntry: then-current card rules, target, duplicate nth and resulting screen. Unmatched commands remain in memory.actions.';
  }
}

export function buildDecisionContext(state, { candidates, memory = new DecisionMemory(), selectionPlanning } = {}) {
  validateContext(state);
  const source = canonicalObservation(state), context = source.decision_context;
  const screenState = { ...source };
  for (const key of ['screen', 'combat', 'map', 'decision_context']) delete screenState[key];
  if (state.screen === 'GRID_CARD_SELECT' && campPlanApplicable(memory.data.camp_upgrade_plan, state)) {
    screenState.camp_planning = publicCampTarget(memory.data.camp_upgrade_plan);
  }
  if (state.screen === 'REST_SITE' && screenState.rest_site && context?.deck_upgrade_previews) {
    // Preview-only values must not turn entering/leaving a campfire into a
    // permanent deck change. Instance IDs still join the grouped deck below.
    screenState.rest_site.deck_upgrade_previews = context.deck_upgrade_previews;
  }
  const selectionScreens = new Set(['HAND_SELECT', 'GRID_CARD_SELECT', 'TRI_SELECT', 'RELIC_SELECT', 'BUNDLE_SELECT']);
  if (selectionScreens.has(state.screen) && memory.data.run_id === context?.run_id) {
    const selectionCommands = new Set(['hand_select_card', 'hand_confirm_selection', 'grid_select_card', 'tri_select_card', 'bundle_select']);
    const prior = memory.data.actions.findLast(action => !selectionCommands.has(action.request.cmd));
    if (prior?.ok && prior.floor === context.total_floor && (prior.combat_id || null) === (context.combat_id || null) && selectionScreens.has(prior.after_screen)) {
      const selectedEventOption = prior.request.cmd === 'choose_event'
        ? prior.result?.event_state?.options?.find(option => option.index === prior.request.args?.[0]) : null;
      screenState.preceding_observed_action = {
        note: 'Most recent confirmed action that opened a selection in this room. Its printed effect helps interpret the choice; the current prompt and constraints still apply.',
        request: clone(prior.request),
        ...(prior.played_card_at_request ? { card: clone(prior.played_card_at_request) } : {}),
        ...(prior.potion_at_request ? { potion: clone(prior.potion_at_request) } : {}),
        ...(selectedEventOption ? { selected_event_option: clone(selectedEventOption) } : {})
      };
    }
  }
  if (selectionPlanning) screenState.selection_planning = clone(selectionPlanning);
  const combat = source.combat ? { ...source.combat } : null;
  if (combat) {
    combat.effect_timing = describeCombatEffects(source.combat);
    delete combat.player; // Exactly equal to the authoritative player above.
    combat.draw_pile = { order: 'unknown', cards: groupCards(combat.draw_pile) };
    // Discard and exhaust are kept in their observed order, with full details.
    for (const enemy of combat.enemies) delete enemy.move_id; // Hidden state-machine label, not the visible intent.
    for (const enemy of combat.enemies) for (const intent of enemy.intents) {
      if (!intent.description?.trim()) intent.description = `Visible ${intent.type} intent. Exact effect is not specified by the displayed label.`;
    }
    const incoming = combat.enemies.filter(e => e.is_alive).flatMap(e => e.intents).reduce((sum, i) => sum + (Number.isFinite(i.damage) ? i.damage * (i.hits || 1) : 0), 0);
    combat.visible_arithmetic = {
      incoming_attack_damage: incoming,
      ...(combat.positioning ? { incoming_attack_facing: combat.positioning.facing, includes_current_back_attack_multiplier: true } : {}),
      current_block: context.player.block,
      attack_damage_after_current_block: Math.max(0, incoming - context.player.block),
      energy_remaining: context.player.energy,
      fatal_if_end_turn_from_visible_attacks: Math.max(0, incoming - context.player.block) >= context.player.hp,
      extra_block_needed_to_survive_visible_attacks: Math.max(0, incoming - context.player.block - context.player.hp + 1),
      note: 'Arithmetic from current visible intents only. Action estimates use known attack_preview.hits (otherwise one hit, or unknown for X), printed Block, active Rage once per Attack, explicit hp_loss and Toxic hand damage. They exclude other self-damage, changing hit modifiers, draws, buffs, other triggers, death prevention/revival and later actions. Printed hp_loss is before prevention hooks. Unspent ordinary energy disappears at end of turn unless a rule says otherwise.'
    };
    combat.visible_arithmetic.attack_budgets = combat.enemies.filter(enemy => enemy.is_alive).map(enemy => {
      const energy = Math.max(0, Math.min(30, context.player.energy || 0));
      const dp = Array.from({ length: energy + 1 }, () => ({ damage: 0, hand_indices: [] }));
      for (const card of combat.hand) {
        const damage = previewDamageSum(card, enemy);
        if (!card.can_play || !Number.isFinite(damage) || damage <= 0 || !Number.isInteger(card.cost) || card.cost < 0 || card.cost > energy || (card.hp_loss || 0) >= context.player.hp) continue;
        for (let budget = energy; budget >= card.cost; budget--) if (dp[budget - card.cost].damage + damage > dp[budget].damage) dp[budget] = { damage: dp[budget - card.cost].damage + damage, hand_indices: [...dp[budget - card.cost].hand_indices, card.index] };
      }
      return { target_id: enemy.combat_id, hp_plus_block: enemy.hp + enemy.block, energy_budget: energy, attack_preview_damage_sum: dp[energy].damage, hand_indices: dp[energy].hand_indices, note: 'Sum of current per-target previews under current fixed costs, one use per listed card. Uses known attack_preview.hits; other cards contribute only one hit. Excludes X-cost sequences and does not simulate changing costs, new buffs, draws, extra resources or death-prevention powers.' };
    });
    combat.play_pile = context.play_pile;
    combat.history = clone(context.combat_history);
    for (const entry of combat.history) {
      const verb = { CardDrawnEntry: 'drew', CardDiscardedEntry: 'discarded', CardExhaustedEntry: 'exhausted' }[entry.type];
      if (verb) delete entry.description; // Typed event/card/actor already fully describe this; the game's Drawn text incorrectly says discarded.
      else if (!entry.description && context.extraction_errors.some(e => e.startsWith(`history.${entry.sequence}.description:`))) entry.description = `${entry.type}; formatting unavailable. See matching recorded action and resource changes; unrecorded details are unknown.`;
    }
    combat.history_coverage = context.history_coverage;
  }
  const map = context?.map ? clone(context.map) : null;
  if (map && source.map) {
    // The actual UI determines legality (including relic-dependent movement).
    // Preserve any newly revealed node as well as all of the current-act graph.
    const nodes = new Map(map.nodes.map(n => [keyOf(n), n]));
    const visible = new Set(nodes.keys());
    for (const node of source.map.nodes || []) if (['TRAVELABLE', 'TRAVELED'].includes(node.state)) visible.add(keyOf(node));
    for (const node of source.map.nodes || []) if (visible.has(keyOf(node))) nodes.set(keyOf(node), { ...node, children: (node.children || []).filter(child => visible.has(keyOf(child))) });
    map.nodes = [...nodes.values()];
    map.legal_next_nodes = source.map.travelable_coords;
    map.routes = routeFacts(map, map.legal_next_nodes);
    map.route_semantics = 'Counts include the chosen node and end at the first boss or known terminal. Min/max for different node types may describe different paths. UNKNOWN nodes are not assumed safe or a specific encounter.';
  }
  if (map && Number.isInteger(map.current_coord?.row) && map.nodes.every(node => node.children.every(child => child.row > node.row))) {
    const firstRelevantRow = Math.min(map.current_coord.row, ...(map.legal_next_nodes || []).map(n => n.row));
    const byCoord = new Map(map.nodes.map(node => [keyOf(node), node]));
    map.visited = (map.visited || []).map(coord => ({ ...coord, type: byCoord.get(keyOf(coord))?.type ?? 'UNKNOWN' }));
    map.nodes = map.nodes.filter(node => node.row >= firstRelevantRow);
    map.scope = 'All nodes and edges at or ahead of the current row, including disconnected future branches. Earlier visited node types remain in visited; expired branches behind the player cannot affect forward routing.';
  }
  if (state.screen === 'SHOP' && screenState.shop && map?.current_coord && map.nodes.some(n => keyOf(n) === keyOf(map.current_coord))) {
    const route = routeFacts(map, [map.current_coord])[0];
    const ownShop = Number(map.nodes.find(n => keyOf(n) === keyOf(map.current_coord)).type === 'SHOP');
    screenState.shop.route_context = { steps_to_boss: route.nearest_steps_after_chosen_node.BOSS ?? null, future_shops_before_boss: { min: route.counts.SHOP.min - ownShop, max: route.counts.SHOP.max - ownShop }, note: 'Counts follow known map edges; movement relics may add future legal choices.' };
  }
  const memoryContext = memory.context(state);
  mergeObservedCardPlays(combat, memoryContext);
  const legalActions = [...candidates].map(([action_id, candidate]) => ({ action_id, request: candidate.request, description: candidate.description, ...(candidate.planning_choice ? { planning_choice: candidate.planning_choice } : {}), ...(candidate.card_hand_index !== undefined ? { card_hand_index: candidate.card_hand_index } : {}), ...(candidate.target_combat_id !== undefined ? { target_combat_id: candidate.target_combat_id } : {}), ...(candidate.combat_estimate ? { combat_estimate: candidate.combat_estimate } : {}) }));
  return validateDecisionPacket(aliasInstanceIds(scopeDecisionHistory({
    schema_version: CONTEXT_VERSION,
    objective: { strategy: 'Win this entire run through all three acts and the final boss. Balance immediate survival, efficient combat, coherent deck/relic synergies, resources, and visible future routes.', execution_checkpoint: 'Continue through ordinary rewards and act transitions until the formal final victory screen.' },
    screen: state.screen, in_combat: Boolean(combat),
    decision_brief: buildDecisionBrief(source, memory),
    turn_plan: publicTurnPlan(memory.data.turn_plan, source),
    run_strategy: publicRunStrategy(source, memory),
    run: context ? { run_id: context.run_id, combat_id: context.combat_id || null, act_index: context.act_index, act_floor: context.act_floor, total_floor: context.total_floor, ascension: context.ascension, game_mode: context.game_mode, modifiers: context.modifiers } : null,
    player: context?.player ?? null,
    resources: context ? { potion_capacity: context.potion_capacity,
      potion_effects: context.player.potions.map(potionEffectFacts).filter(Boolean) } : null,
    deck: context ? {
      count: context.master_deck.length, cards: groupCards(context.master_deck), kind: 'permanent master deck, distinct from combat piles',
      statistics: {
        by_type: Object.fromEntries([...new Set(context.master_deck.map(c => c.type))].map(type => [type, context.master_deck.filter(c => c.type === type).length])),
        basic_cards: context.master_deck.filter(c => c.rarity === 'Basic').length,
        non_basic_attacks: context.master_deck.filter(c => c.type === 'Attack' && c.rarity !== 'Basic').length,
        upgraded_attacks: context.master_deck.filter(c => c.type === 'Attack' && c.is_upgraded).length
      }
    } : null,
    map, combat, screen_state: screenState,
    memory: memoryContext,
    rules: context?.glossary || [],
    rule_reference: buildRuleReference(source),
    information: { source: 'single mod main-thread snapshot plus decision-relevant local memory', unknown: ['unobserved draw order; retained card effects may establish partial knowledge', 'unrevealed question-mark contents and rewards', 'future enemy random choices', 'later acts', 'history outside the stated decision window or before available observations', ...(context?.extraction_errors || []).filter(e => /^history\.\d+\.description: NullReferenceException$/.test(e)).map(e => `Unavailable history display text (${e}); retained typed events and commands are available.`)], card_grouping: 'Each cards entry with count represents that many exactly equivalent card states; instance_ids distinguish copies. Never infer draw order from array order or IDs.', extraction_errors: (context?.extraction_errors || []).filter(e => !/^history\.\d+\.description: NullReferenceException$/.test(e)) },
    legal_actions: legalActions
  }, source, memory)));
}

// Instance IDs are arbitrary identity labels, not gameplay facts. Use compact
// request-local aliases consistently across every pile, action and history entry.
// Original identities remain in local state logs and persistent memory.
function aliasInstanceIds(context) {
  const aliases = new Map();
  const visit = (item, key = '') => {
    if (typeof item === 'string' && /(^|_)ids?$/.test(key) && /^[a-f0-9]{32}$/.test(item)) {
      if (!aliases.has(item)) aliases.set(item, `i${aliases.size + 1}`);
      return aliases.get(item);
    }
    if (Array.isArray(item)) return item.map(value => visit(value, key));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([name, value]) => [name, visit(value, name)]));
    return item;
  };
  return visit(context);
}

// Losslessly intern repeated long rule text only when necessary. The dictionary
// is in this very request, never an assumed server-side cache or previous call.
export function deduplicateText(value, { dictionary = {} } = {}) {
  const counts = new Map();
  const eligible = field => !/(^|_)ids?$/.test(field) && !['schema_version', 'screen', 'cmd', 'encoding', 'type', 'instructions'].includes(field);
  const visit = (item, field = '') => {
    if (typeof item === 'string' && eligible(field) && Buffer.byteLength(item) >= 24) counts.set(item, (counts.get(item) || 0) + 1);
    else if (Array.isArray(item)) item.forEach(v => visit(v, field));
    else if (item && typeof item === 'object') Object.entries(item).forEach(([key, v]) => visit(v, key));
  };
  visit(value);
  const ids = new Map(Object.entries(dictionary).map(([id, text]) => [text, id]));
  let nextId = 1;
  for (const [text, count] of counts) {
    if (ids.has(text)) continue;
    while (Object.hasOwn(dictionary, `t${nextId}`) || [...ids.values()].includes(`t${nextId}`)) nextId++;
    const id = `t${nextId}`, bytes = Buffer.byteLength(JSON.stringify(text));
    const referenceBytes = Buffer.byteLength(JSON.stringify({ text_ref: id }));
    if (count * bytes > count * referenceBytes + bytes + id.length + 32) ids.set(text, id);
  }
  const replace = (item, field = '') => {
    if (typeof item === 'string' && eligible(field) && ids.has(item)) return { text_ref: ids.get(item) };
    if (Array.isArray(item)) return item.map(v => replace(v, field));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, v]) => [key, replace(v, key)]));
    return item;
  };
  return { ...replace(value), text_dictionary: Object.fromEntries([...ids].map(([text, id]) => [id, text])) };
}

export function recordTable(records) {
  const layouts = [], lookup = new Map();
  const rows = records.map(record => {
    const keys = Object.keys(record), signature = JSON.stringify(keys);
    if (!lookup.has(signature)) { lookup.set(signature, layouts.length); layouts.push(keys); }
    return [lookup.get(signature), ...keys.map(key => record[key])];
  });
  return { encoding: 'record_table_v1', layouts, rows };
}

export function compactRecords(records, nested = true) {
  const layouts = [], lookup = new Map();
  const constantKeys = new Set(['type', 'side', 'actor_id', 'source_id', 'floor', 'combat_id', 'screen', 'ok', 'source', 'cmd', 'field']);
  const isConstantKey = key => constantKeys.has(nested ? key : JSON.parse(key).at(-1));
  const rows = records.map(record => {
    const constants = Object.fromEntries(Object.entries(record).filter(([key]) => isConstantKey(key)));
    const fields = Object.keys(record).filter(key => !isConstantKey(key));
    const layout = { constants, fields }, signature = JSON.stringify(layout);
    if (!lookup.has(signature)) { lookup.set(signature, layouts.length); layouts.push(layout); }
    return [lookup.get(signature), ...fields.map(key => record[key])];
  });
  // Mixed histories can have many floor/actor combinations. Instead of making
  // a separate layout for each combination, share only values actually common
  // to records with the same shape and event type. No event or field is lost.
  const groups = new Map();
  for (const record of records) {
    const kind = nested ? record.type ?? record.request?.cmd ?? record.field : record['["type"]'] ?? record['["request","cmd"]'] ?? record['["field"]'];
    const key = JSON.stringify([Object.keys(record), kind]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  const sharedLayouts = [], groupOf = new Map();
  for (const group of groups.values()) {
    const common = Object.keys(group[0]).filter(key => group.every(record => JSON.stringify(record[key]) === JSON.stringify(group[0][key])));
    const layout = { constants: Object.fromEntries(common.map(key => [key, group[0][key]])), fields: Object.keys(group[0]).filter(key => !common.includes(key)) };
    sharedLayouts.push(layout);
    for (const record of group) groupOf.set(record, sharedLayouts.length - 1);
  }
  const sharedRows = records.map(record => [groupOf.get(record), ...sharedLayouts[groupOf.get(record)].fields.map(key => record[key])]);
  const variants = [records, recordTable(records), { encoding: 'record_table_v2', layouts, rows }, { encoding: 'record_table_v2', layouts: sharedLayouts, rows: sharedRows }];
  if (nested) {
    const flatten = (item, path = [], output = {}) => {
      if (item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length) {
        for (const [key, value] of Object.entries(item)) flatten(value, [...path, key], output);
      } else output[JSON.stringify(path)] = item;
      return output;
    };
    const flat = compactRecords(records.map(record => flatten(record)), false);
    if (flat.encoding) variants.push({ encoding: 'record_table_v3', layouts: flat.layouts.map(layout => ({
      constants: Object.entries(Array.isArray(layout) ? {} : layout.constants).map(([key, value]) => [JSON.parse(key), value]),
      fields: (Array.isArray(layout) ? layout : layout.fields).map(key => JSON.parse(key))
    })), rows: flat.rows });
  }
  return variants
    .sort((a, b) => Buffer.byteLength(JSON.stringify(a)) - Buffer.byteLength(JSON.stringify(b)))[0];
}

// Decode for schema validation and round-trip checks. v3 stores explicit key
// paths rather than dotted keys, so original field names remain unambiguous.
export function expandRecordTables(item) {
  if (!item || typeof item !== 'object') return item;
  if (Array.isArray(item)) return item.map(expandRecordTables);
  if (item.encoding === 'event_timeline_v1') {
    const events = expandRecordTables(item.events);
    if (!Array.isArray(events) || !events.length || !Number.isInteger(item.sequence_start)
      || !Array.isArray(item.rounds) || !item.rounds.length || !Array.isArray(item.rounds[0]) || item.rounds[0][0] !== 0
      || item.rounds.some((entry, index) => !Array.isArray(entry) || entry.length !== 2
        || !entry.every(Number.isInteger) || entry[0] < 0 || entry[0] >= events.length
        || (index > 0 && entry[0] <= item.rounds[index - 1][0]))) throw new ContextError('Malformed event timeline');
    let segment = 0;
    return events.map((event, index) => {
      if (!event || typeof event !== 'object' || Array.isArray(event) || 'sequence' in event || 'round' in event) throw new ContextError('Malformed event timeline event');
      if (item.rounds[segment + 1]?.[0] === index) segment++;
      return { sequence: item.sequence_start + index, round: item.rounds[segment][1], ...event };
    });
  }
  if (item.encoding === 'record_map_v1') {
    const records = expandRecordTables(item.records);
    if (!Array.isArray(item.keys) || !Array.isArray(records) || item.keys.length !== records.length
      || new Set(item.keys).size !== item.keys.length || item.keys.some(key => typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key))) throw new ContextError('Malformed decision record map');
    return Object.fromEntries(item.keys.map((key, index) => [key, records[index]]));
  }
  if (['record_table_v1', 'record_table_v2', 'record_table_v3'].includes(item.encoding)) {
    if (!Array.isArray(item.layouts) || !Array.isArray(item.rows)) throw new ContextError('Malformed decision history table');
    return item.rows.map(row => {
      const layout = item.layouts[row?.[0]], fields = item.encoding === 'record_table_v1' ? layout : layout?.fields;
      if (!Array.isArray(row) || !Number.isInteger(row[0]) || !Array.isArray(fields) || row.length !== fields.length + 1) throw new ContextError('Malformed decision history table');
      if (item.encoding !== 'record_table_v3') return { ...expandRecordTables(item.encoding === 'record_table_v2' ? layout.constants : {}), ...Object.fromEntries(fields.map((key, i) => [key, expandRecordTables(row[i + 1])])) };
      const record = {};
      const set = (keys, value) => {
        if (!Array.isArray(keys) || !keys.length || keys.some(key => typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key))) throw new ContextError('Malformed nested record path');
        let target = record;
        for (const key of keys.slice(0, -1)) target = target[key] ??= {};
        target[keys.at(-1)] = expandRecordTables(value);
      };
      if (!Array.isArray(layout.constants)) throw new ContextError('Malformed nested record constants');
      for (const [keys, value] of layout.constants) set(keys, value);
      fields.forEach((keys, i) => set(keys, row[i + 1]));
      return record;
    });
  }
  return Object.fromEntries(Object.entries(item).map(([key, value]) => [key, expandRecordTables(value)]));
}

export function compactContext(context, { deduplicate = true } = {}) {
  const interned = deduplicate ? deduplicateText(context) : context;
  const copy = Buffer.byteLength(JSON.stringify(interned)) < Buffer.byteLength(JSON.stringify(context)) ? interned : clone(context);
  const deckStates = new Map((copy.deck?.cards || []).map((group, index) => [JSON.stringify(group.card), index]));
  for (const observation of copy.memory.observations || []) {
    const change = observation.changes.master_deck;
    for (const item of [...(change?.added || []), ...(change?.removed || [])]) {
      const index = deckStates.get(JSON.stringify(item.card));
      if (index !== undefined) item.card = { deck_group_index: index };
    }
  }
  const cardStates = {}, known = new Map();
  for (const action of [...(copy.memory.actions || []), ...(copy.combat?.history || [])]) if (action.played_card_at_request) {
    const card = clone(action.played_card_at_request), instance = card.details?.instance_id;
    if (card.details) delete card.details.instance_id;
    const signature = JSON.stringify(card);
    if (!known.has(signature)) {
      const id = `c${known.size + 1}`;
      known.set(signature, id); cardStates[id] = card;
    }
    action.played_card_at_request = { card_state_ref: known.get(signature), instance_id: instance };
  }
  if (known.size) {
    const packed = { encoding: 'record_map_v1', keys: Object.keys(cardStates), records: compactRecords(Object.values(cardStates)) };
    copy.memory.card_states = JSON.stringify(packed).length < JSON.stringify(cardStates).length ? packed : cardStates;
  }
  if (copy.combat?.history?.length) {
    const history = copy.combat.history;
    copy.combat.history = compactRecords(history);
    // Native sequence numbers are consecutive. Store that exact progression
    // once, and each round boundary once, retaining every event in order.
    if (history.every((event, index) => Number.isInteger(event.sequence)
      && event.sequence === history[0].sequence + index && Number.isInteger(event.round))) {
      const rounds = [];
      const events = history.map(({ sequence, round, ...event }, index) => {
        if (!index || round !== history[index - 1].round) rounds.push([index, round]);
        return event;
      });
      const timeline = { encoding: 'event_timeline_v1', sequence_start: history[0].sequence, rounds, events: compactRecords(events) };
      if (JSON.stringify(timeline).length < JSON.stringify(copy.combat.history).length) copy.combat.history = timeline;
    }
  }
  for (const key of ['actions', 'observations', 'relic_updates', 'travel_history']) if (copy.memory[key]?.length) copy.memory[key] = compactRecords(copy.memory[key]);
  if (copy.run_strategy?.revisions?.length) copy.run_strategy.revisions = compactRecords(copy.run_strategy.revisions);
  for (const container of [copy.deck, copy.combat?.draw_pile]) if (container?.cards?.length) container.cards = compactRecords(container.cards);
  for (const key of ['hand', 'discard_pile', 'exhaust_pile', 'play_pile', 'enemies']) if (copy.combat?.[key]?.length) copy.combat[key] = compactRecords(copy.combat[key]);
  if (copy.legal_actions?.length) copy.legal_actions = compactRecords(copy.legal_actions);
  if (copy.decision_brief?.recent_confirmed_actions?.length) copy.decision_brief.recent_confirmed_actions = compactRecords(copy.decision_brief.recent_confirmed_actions);
  for (const key of ['ordered_steps', 'completed_actions', 'retained_cards']) if (copy.turn_plan?.[key]?.length) copy.turn_plan[key] = compactRecords(copy.turn_plan[key]);
  // Modal cards and map nodes repeat the same fields just like combat piles.
  // Preserve the exact order, distinct copies, constraints and instance IDs.
  for (const key of ['nodes', 'visited', 'legal_next_nodes']) if (copy.map?.[key]?.length) copy.map[key] = compactRecords(copy.map[key]);
  for (const [screen, fields] of Object.entries({
    grid_card_select: ['cards'], tri_select: ['cards'], hand_select: ['selectable_cards'],
    rest_site: ['deck_upgrade_previews']
  })) for (const field of fields) if (copy.screen_state?.[screen]?.[field]?.length) {
    copy.screen_state[screen][field] = compactRecords(copy.screen_state[screen][field]);
  }
  if (copy.rule_reference?.entries) for (const [category, rows] of Object.entries(copy.rule_reference.entries)) copy.rule_reference.entries[category] = compactRecords(rows);
  return copy;
}

// Criteria often repeat the same rule as legal_actions and modal cards. Intern
// text across BOTH parts before record encoding, keeping the dictionary in state
// so the API still receives only its native model/state/questions fields.
export function compactDecisionRequest(payload) {
  const { state, questions, text_dictionary } = deduplicateText({ state: payload.state, questions: payload.questions });
  const packed = { ...payload, state: compactContext({ ...state, text_dictionary }, { deduplicate: false }), questions };
  return Buffer.byteLength(JSON.stringify(packed)) < Buffer.byteLength(JSON.stringify(payload)) ? packed : payload;
}

/** Pack newly added planning facts without reinterpreting encoded table cells. */
export function compactPlanningRequest(payload) {
  const extra = deduplicateText({ planning: payload.state.turn_planning, questions: payload.questions }, { dictionary: payload.state.text_dictionary });
  const planning = extra.planning;
  for (const field of ['proposed_steps', 'retained_cards']) if (planning?.[field]?.length) planning[field] = compactRecords(planning[field]);
  const packed = { ...payload, state: { ...payload.state, turn_planning: planning, text_dictionary: extra.text_dictionary }, questions: extra.questions };
  return Buffer.byteLength(JSON.stringify(packed)) < Buffer.byteLength(JSON.stringify(payload)) ? packed : payload;
}

// Prefer ordinary named records for the current decision when space permits.
// Historical tables remain intact. Each expansion is lossless and atomic, and
// cannot displace any facts, questions, or choices to make room.
export function presentCurrentRecords(payload, maxRequestBytes, maxExpansionBytes = 3000) {
  const initialBytes = Buffer.byteLength(JSON.stringify(payload));
  const ceiling = Math.min(maxRequestBytes, initialBytes + maxExpansionBytes);
  const state = structuredClone(payload.state), shown = { ...payload, state }, expanded = [];
  const resolve = value => {
    if (value && typeof value === 'object' && Object.keys(value).length === 1 && typeof value.text_ref === 'string') {
      const text = state.text_dictionary?.[value.text_ref];
      if (typeof text !== 'string') throw new ContextError('Dangling rule reference in current-state presentation');
      return text;
    }
    return Array.isArray(value) ? value.map(resolve) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)])) : value;
  };
  const paths = [['combat', 'hand'], ['combat', 'enemies'], ['player'], ['resources'],
    ['turn_plan'], ['turn_planning'], ['screen_state'], ['legal_actions'], ['decision_brief']];
  let bytes = initialBytes;
  for (const keys of paths) {
    const owner = keys.length === 1 ? state : state[keys[0]], key = keys.at(-1);
    const original = owner?.[key];
    if (!original) continue;
    const ordinary = resolve(expandRecordTables(original));
    if (JSON.stringify(ordinary) === JSON.stringify(original)) continue;
    owner[key] = ordinary;
    const nextBytes = Buffer.byteLength(JSON.stringify(shown));
    if (nextBytes <= ceiling) { bytes = nextBytes; expanded.push(keys.join('.')); }
    else owner[key] = original;
  }
  return { payload: expanded.length ? shown : payload, bytes,
    presentation: expanded.length ? 'current_records_expanded' : 'packed', expanded_fields: expanded };
}
