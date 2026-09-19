import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';

export const CONTEXT_VERSION = 'sts2.decision.v1';
export class ContextError extends Error {
  constructor(message, details = {}) { super(message); this.name = 'ContextError'; this.details = details; }
}

const protocolSchema = JSON.parse(fs.readFileSync(new URL('../schemas/decision-context.v1.schema.json', import.meta.url), 'utf8'));
const protocolCheck = new Ajv2020({ allErrors: true, strict: true }).compile(protocolSchema);
export function validateDecisionPacket(packet) {
  if (!protocolCheck(packet)) throw new ContextError('Decision JSON does not match the versioned protocol', { errors: clone(protocolCheck.errors) });
  if (packet.in_combat !== Boolean(packet.combat)) throw new ContextError('in_combat contradicts combat data');
  const actionIds = packet.legal_actions.map(a => a.action_id);
  if (new Set(actionIds).size !== actionIds.length) throw new ContextError('Duplicate legal action IDs');
  const visit = item => {
    if (!item || typeof item !== 'object') return;
    if (item.text_ref && typeof packet.text_dictionary?.[item.text_ref] !== 'string') throw new ContextError('Dangling rule reference in decision JSON');
    if (item.encoding === 'record_table_v1') for (const row of item.rows) {
      if (!Number.isInteger(row[0]) || !item.layouts[row[0]] || row.length !== item.layouts[row[0]].length + 1) throw new ContextError('Malformed decision history table');
    }
    Object.values(item).forEach(visit);
  };
  visit(packet);
  return packet;
}

const clone = value => structuredClone(value);
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
    return { next_node: choice, reachable_node_count: visited.size, nearest_steps_after_chosen_node: nearest, ...result };
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
    fs.renameSync(temporary, this.file);
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
  begin(request, state) {
    if (this.data.pending) throw new ContextError('An earlier action has an unresolved outcome; inspect the saved memory before continuing.');
    const matching = state.combat?.hand?.filter(card => card.id.toUpperCase() === request.id?.toUpperCase()).sort((a, b) => a.index - b.index);
    this.data.pending = { request: clone(request), floor: state.decision_context?.total_floor, combat_id: state.decision_context?.combat_id || null, round: state.combat?.turn_number, screen: state.screen,
      ...(request.cmd === 'play_card' ? { played_card_at_request: clone(matching?.[request.nth ?? 0]) } : {}) };
    if (request.cmd === 'use_potion') this.data.pending.potion_at_request = clone(state.decision_context?.player?.potions.filter(p => p.id.toUpperCase() === request.id?.toUpperCase()).sort((a, b) => a.slot - b.slot)[request.nth ?? 0]);
    this.persist();
  }
  finish(response, after) {
    this.data.actions.push({ ...this.data.pending, ok: response.ok, result: clone(response.data ?? response.error ?? null), after_screen: after.screen });
    this.data.pending = !response.ok && ['TIMEOUT', 'INTERNAL_ERROR'].includes(response.error) ? { ...this.data.pending, outcome_unknown: true, error: response.error } : null;
    this.persist();
  }
  context(state) {
    if (state.decision_context?.run_id !== this.data.run_id) return { coverage: 'No matching run memory', actions: [], observations: [] };
    const combatId = state.decision_context?.combat_id;
    const actions = clone(this.data.actions.filter(a => !a.combat_id || a.combat_id === combatId));
    for (const action of actions) {
      // Successful card/turn effects are already in the same combat's complete
      // engine history. Keep the command, outcome and the card's then-current
      // rules, instead of duplicating each engine event in two histories.
      if (action.ok && action.combat_id === combatId && ['play_card', 'end_turn'].includes(action.request.cmd)) delete action.result;
      if (action.played_card_at_request) {
        const card = action.played_card_at_request;
        for (const key of ['index', 'can_play', 'valid_target_ids', 'target_previews', 'tags', 'rarity']) delete card[key];
      }
    }
    const observations = [], completedRooms = new Map();
    for (const observation of this.data.observations) {
      if (!observation.combat_id || observation.combat_id === combatId) { observations.push(observation); continue; }
      const room = completedRooms.get(observation.floor) || { floor: observation.floor, changes: {} };
      for (const [field, change] of Object.entries(observation.changes)) {
        if (['block', 'energy'].includes(field)) continue;
        room.changes[field] = { before: room.changes[field]?.before ?? change.before, after: change.after };
      }
      completedRooms.set(observation.floor, room);
    }
    const relevant = clone([...completedRooms.values(), ...observations]);
    for (const observation of relevant) {
      if (observation.changes.master_deck?.before) observation.changes.master_deck = deckDifference(observation.changes.master_deck);
      for (const field of ['relics', 'potions']) if (observation.changes[field]?.before) observation.changes[field] = effectDifference(observation.changes[field]);
    }
    return { coverage: `${this.data.coverage} Completed combats retain room resource changes; their expired tactical actions are in local logs. Deck changes list added and removed copies; an upgrade replaces its former state. Relic/potion changes list added, removed and updated fields; unchanged fields remain as previously observed.`, actions: clone(actions), observations: relevant, pending: clone(this.data.pending) };
  }
}

export function buildDecisionContext(state, { candidates, memory = new DecisionMemory() } = {}) {
  validateContext(state);
  const source = canonicalObservation(state), context = source.decision_context;
  const screenState = { ...source };
  for (const key of ['screen', 'combat', 'map', 'decision_context']) delete screenState[key];
  const combat = source.combat ? { ...source.combat } : null;
  if (combat) {
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
      current_block: context.player.block,
      attack_damage_after_current_block: Math.max(0, incoming - context.player.block),
      energy_remaining: context.player.energy,
      fatal_if_end_turn_from_visible_attacks: Math.max(0, incoming - context.player.block) >= context.player.hp,
      extra_block_needed_to_survive_visible_attacks: Math.max(0, incoming - context.player.block - context.player.hp + 1),
      note: 'Arithmetic from current visible intents only. Action estimates use one hit and printed Block, excluding multi-hits, self-damage, draws, buffs, triggers, death prevention/revival and later actions. Unspent ordinary energy disappears at end of turn unless a rule says otherwise.'
    };
    combat.visible_arithmetic.attack_budgets = combat.enemies.filter(enemy => enemy.is_alive).map(enemy => {
      const energy = Math.max(0, Math.min(30, context.player.energy || 0));
      const dp = Array.from({ length: energy + 1 }, () => ({ damage: 0, hand_indices: [] }));
      for (const card of combat.hand) {
        const damage = card.target_previews?.find(p => p.target_id === enemy.combat_id)?.damage;
        if (!card.can_play || !Number.isFinite(damage) || damage <= 0 || !Number.isInteger(card.cost) || card.cost < 0 || card.cost > energy) continue;
        for (let budget = energy; budget >= card.cost; budget--) if (dp[budget - card.cost].damage + damage > dp[budget].damage) dp[budget] = { damage: dp[budget - card.cost].damage + damage, hand_indices: [...dp[budget - card.cost].hand_indices, card.index] };
      }
      return { target_id: enemy.combat_id, hp_plus_block: enemy.hp + enemy.block, energy_budget: energy, first_hit_damage_sum: dp[energy].damage, hand_indices: dp[energy].hand_indices, note: 'Sum of current per-target first-hit previews under current costs, one use per listed card. Does not simulate changing costs, new buffs, multi-hits, draws, extra resources or death-prevention powers.' };
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
  const legalActions = [...candidates].map(([action_id, candidate]) => ({ action_id, request: candidate.request, description: candidate.description, ...(candidate.card_hand_index !== undefined ? { card_hand_index: candidate.card_hand_index } : {}), ...(candidate.target_combat_id !== undefined ? { target_combat_id: candidate.target_combat_id } : {}), ...(candidate.combat_estimate ? { combat_estimate: candidate.combat_estimate } : {}) }));
  return validateDecisionPacket(aliasInstanceIds({
    schema_version: CONTEXT_VERSION,
    objective: { strategy: 'Win this entire run through all three acts and the final boss. Balance immediate survival, efficient combat, coherent deck/relic synergies, resources, and visible future routes.', execution_checkpoint: 'Continue through ordinary rewards and act transitions until the formal final victory screen.' },
    screen: state.screen, in_combat: Boolean(combat),
    run: context ? { run_id: context.run_id, combat_id: context.combat_id || null, act_index: context.act_index, act_floor: context.act_floor, total_floor: context.total_floor, ascension: context.ascension, game_mode: context.game_mode, modifiers: context.modifiers } : null,
    player: context?.player ?? null,
    resources: context ? { potion_capacity: context.potion_capacity } : null,
    deck: context ? { count: context.master_deck.length, cards: groupCards(context.master_deck), kind: 'permanent master deck, distinct from combat piles' } : null,
    map, combat, screen_state: screenState,
    memory: memory.context(state),
    rules: context?.glossary || [],
    information: { source: 'single mod main-thread snapshot plus explicitly scoped local memory', unknown: ['unobserved draw order; recorded card effects may establish partial knowledge', 'unrevealed question-mark contents and rewards', 'future enemy random choices', 'later acts', 'history before available observations', ...(context?.extraction_errors || []).filter(e => /^history\.\d+\.description: NullReferenceException$/.test(e)).map(e => `Unavailable history display text (${e}); typed event and recorded actions retained.`)], card_grouping: 'Each cards entry with count represents that many exactly equivalent card states; instance_ids distinguish copies. Never infer draw order from array order or IDs.', extraction_errors: (context?.extraction_errors || []).filter(e => !/^history\.\d+\.description: NullReferenceException$/.test(e)) },
    legal_actions: legalActions
  }));
}

// Instance IDs are arbitrary identity labels, not gameplay facts. Use compact
// request-local aliases consistently across every pile, action and history entry.
// Original identities remain in local state logs and persistent memory.
function aliasInstanceIds(context) {
  const aliases = new Map();
  const visit = (item, key = '') => {
    if (typeof item === 'string' && /(^|_)ids?$/.test(key) && /^[a-f0-9]{32}$/.test(item)) {
      if (!aliases.has(item)) aliases.set(item, `instance_${aliases.size + 1}`);
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
export function deduplicateText(value) {
  const counts = new Map();
  const eligible = field => !/(^|_)ids?$/.test(field) && !['schema_version', 'screen', 'cmd', 'encoding', 'type'].includes(field);
  const visit = (item, field = '') => {
    if (typeof item === 'string' && eligible(field) && Buffer.byteLength(item) >= 24) counts.set(item, (counts.get(item) || 0) + 1);
    else if (Array.isArray(item)) item.forEach(v => visit(v, field));
    else if (item && typeof item === 'object') Object.entries(item).forEach(([key, v]) => visit(v, key));
  };
  visit(value);
  const ids = new Map();
  for (const [text, count] of counts) {
    const id = `rule_${ids.size + 1}`, bytes = Buffer.byteLength(JSON.stringify(text));
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

export function compactContext(context) {
  const interned = deduplicateText(context);
  const copy = Buffer.byteLength(JSON.stringify(interned)) < Buffer.byteLength(JSON.stringify(context)) ? interned : clone(context);
  const cardStates = {}, known = new Map();
  for (const action of copy.memory.actions || []) if (action.played_card_at_request) {
    const card = clone(action.played_card_at_request), instance = card.details?.instance_id;
    if (card.details) delete card.details.instance_id;
    const signature = JSON.stringify(card);
    if (!known.has(signature)) {
      const id = `played_${known.size + 1}`;
      known.set(signature, id); cardStates[id] = card;
    }
    action.played_card_at_request = { card_state_ref: known.get(signature), instance_id: instance };
  }
  if (known.size) copy.memory.card_states = cardStates;
  if (copy.combat?.history?.length) copy.combat.history = recordTable(copy.combat.history);
  for (const key of ['actions', 'observations']) if (copy.memory[key]?.length) copy.memory[key] = recordTable(copy.memory[key]);
  return copy;
}
