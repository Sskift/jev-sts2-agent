import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import Ajv2020 from 'ajv/dist/2020.js';
import { ContextError, compactRecords, expandRecordTables, validateDecisionPacket } from './decision_context.mjs';
import { normalizeRuleId as normalize, visitRuleEntities } from './rule_entities.mjs';

export const MODEL_CONTEXT_VERSION = 'sts2.context.v2';
const checkSchema = new Ajv2020({ allErrors: true, strict: true }).compile(JSON.parse(
  fs.readFileSync(new URL('../schemas/model-context.v2.schema.json', import.meta.url), 'utf8')));

// Specific derived/history fields must be lifted before their current-state
// parents. This table is also the versioned alias contract for planner text.
const routes = [
  ['combat.history', 'history.combat.events'],
  ['combat.history_coverage', 'history.combat.coverage'],
  ['combat.visible_arithmetic', 'analysis.current_combat'],
  ['deck.statistics', 'analysis.deck_statistics'],
  ['map.routes', 'analysis.routes'],
  ['map.route_semantics', 'analysis.route_semantics'],
  ['resources.potion_effects', 'knowledge.resolved_potion_effects'],
  ['turn_planning.conditional_projection', 'analysis.proposed_sequence'],
  ['turn_planning.energy_reservation', 'analysis.energy_reservation'],
  ['turn_planning.comparisons', 'analysis.plan_alternatives'],
  ['turn_planning.survival_constraints', 'analysis.survival_constraints'],
  ['screen_state.shop.route_context', 'analysis.shop_route_context'],
  ['screen_state.preceding_observed_action', 'history.selection_trigger'],
  ['screen_state.skipped_card_rewards', 'history.skipped_card_rewards'],
  ['screen_state.selection_planning', 'intent.selection_planning'],
  ['run_strategy.capability_assessment', 'analysis.run_capability_assessment'],
  ['run_strategy.revisions', 'history.strategy_revisions'],
  ['run_strategy.revision_coverage', 'history.strategy_coverage'],
  ['run_strategy', 'intent.run_strategy'],
  ['objective', 'intent.run_objective'],
  ['turn_plan', 'intent.persisted_turn_plan'],
  ['turn_planning', 'intent.current_planning'],
  ['decision_brief', 'history.recent_changes'],
  ['strategy_assessment', 'analysis.model_assessment'],
  ['rule_reference', 'knowledge.reference'],
  ['rules', 'knowledge.native_glossary'],
  ['memory', 'history.run_memory'],
  ['information', 'uncertainty'],
  ...['screen', 'in_combat', 'run', 'player', 'resources', 'deck', 'map', 'combat', 'screen_state', 'legal_actions']
    .map(key => [key, `observation.${key}`]),
  ['text_dictionary', 'text_dictionary']
];
const aliases = Object.fromEntries(routes);
aliases['rule_reference.entries'] = 'knowledge.catalog (keyed by category and rule ID)';
aliases['legal_actions[].combat_estimate'] = 'analysis.action_estimates (keyed by action_id)';
const domains = ['observation', 'knowledge', 'history', 'intent', 'analysis'];
const prefix = 'Use the v2 domains and decision.reference_paths for source-path references. ';

function take(object, path) {
  const keys = path.split('.'), key = keys.pop();
  let owner = object;
  for (const item of keys) { owner = owner?.[item]; if (!owner || typeof owner !== 'object') return { present: false }; }
  if (!Object.hasOwn(owner, key)) return { present: false };
  const value = owner[key]; delete owner[key];
  return { present: true, value };
}
function put(object, path, value) {
  const keys = path.split('.'), key = keys.pop();
  let owner = object;
  for (const item of keys) owner = owner[item] ??= {};
  owner[key] = value;
}
function digestObservation(object, dictionary = {}) {
  const stable = value => {
    if (!value || typeof value !== 'object') return value;
    if (value.text_ref && Object.keys(value).length === 1) {
      if (typeof dictionary[value.text_ref] !== 'string') throw new ContextError('Observation has an unresolved text reference');
      return dictionary[value.text_ref];
    }
    return Array.isArray(value) ? value.map(stable)
      : Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  };
  return createHash('sha256').update(JSON.stringify(stable(expandRecordTables(object)))).digest('hex').slice(0, 24);
}
function entityLinks(observation, catalog) {
  const index = new Map();
  for (const [category, table] of Object.entries(catalog || {})) {
    for (const id of table.keys) index.set(`${category}/${normalize(id)}`, `${category}/${id}`);
  }
  const links = {};
  visitRuleEntities(expandRecordTables(observation), ({ category, id }) => {
    if (id) links[`${category}/${id}`] = index.get(`${category}/${normalize(id)}`) ?? null;
  });
  return links;
}

function decisionFrame(source, questions, metrics, observation) {
  const phase = metrics.purpose || (source.screen_state?.selection_planning ? 'selection_assembly' : source.screen.toLowerCase());
  const planning = phase.startsWith('turn_') && phase !== 'turn_end_check';
  const advisory = ['option_assessment', 'run_strategy_assessment'].includes(phase);
  return {
    phase, horizon: phase === 'run_strategy_assessment' ? 'remaining_run' : source.in_combat ? 'remaining_turn_with_full_run_objective' : 'current_choice_with_full_run_objective',
    output_role: advisory ? 'advisory_assessment' : planning || phase === 'selection_assembly' ? 'unexecuted_plan_component' : 'legal_action_selection',
    observation_id: digestObservation(observation, source.text_dictionary), question_keys: Object.keys(questions),
    reference_paths: aliases,
    contract: {
      authority: 'Observation holds current values. History holds past observations. Native resolved values override static Knowledge base values. Intent is not an executed effect. Analysis is partial arithmetic or advisory model judgment, never an observed future.',
      rules: 'knowledge.entity_rules joins a current category/ID to a category/rule ID. A null link means no matching static reference, not no effect. knowledge.catalog is keyed by category, then ID after decoding record_map_v1; follow each rule related_rules transitively. Native current rules remain in Observation.',
      decision: 'Answer each offered question independently using its exact alternatives and inherited Intent. Plan components and assessments send no command. Evaluate the whole relevant horizon; conditional numbers cannot establish outcomes for effects they omit.',
      completeness: 'The entire canonical packet, every question and every alternative remain in this request. Structural preservation does not prove that the native extractor or game-rule model covers every mechanic. Unknown information and omitted effects remain unknown.'
    }
  };
}

/** The one boundary between internal game/planner state and every Jev request.
 * No game/card strategy is selected here. Routing, joins and encoding are code;
 * all decision alternatives and complete source facts are preserved.
 */
export function compileModelRequest(payload, metrics = {}) {
  validateDecisionPacket(payload.state);
  const source = structuredClone(payload.state), original = payload.state;
  const state = { schema_version: MODEL_CONTEXT_VERSION, source_schema_version: source.schema_version, decision: null,
    ...Object.fromEntries(domains.map(domain => [domain, {}])) };
  delete source.schema_version;
  for (const [from, to] of routes) {
    const value = take(source, from);
    if (value.present) put(state, to, value.value);
  }
  if (Object.keys(source).length) throw new ContextError('Context compiler has unclassified source fields', { fields: Object.keys(source) });
  const reference = state.knowledge.reference;
  if (reference?.entries) {
    state.knowledge.catalog = Object.fromEntries(Object.entries(reference.entries).map(([category, records]) => {
      const ids = expandRecordTables(records).map(rule => rule.id);
      if (ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new ContextError('Rule catalogue IDs are not unique');
      return [category, { encoding: 'record_map_v1', keys: ids, records }];
    }));
    delete reference.entries;
  }
  const actions = expandRecordTables(state.observation.legal_actions);
  const estimates = {};
  for (const action of actions) {
    if (Object.hasOwn(action, 'combat_estimate')) {
      estimates[action.action_id] = action.combat_estimate;
      delete action.combat_estimate;
    }
  }
  // Only re-encode actions when removing a derived estimate. Their order,
  // exact commands, selection constraints and labels remain unchanged.
  if (Object.keys(estimates).length) {
    state.observation.legal_actions = compactRecords(actions);
    state.analysis.action_estimates = estimates;
  }
  state.knowledge.entity_rules = entityLinks(state.observation, state.knowledge.catalog);
  state.decision = decisionFrame(original, payload.questions, metrics, state.observation);
  const questions = Object.fromEntries(Object.entries(payload.questions).map(([id, question]) => [id,
    { ...question, instructions: prefix + question.instructions }]));
  const compiled = { ...payload, state, questions };
  validateModelRequest(compiled, payload);
  return { payload: compiled, bytes: Buffer.byteLength(JSON.stringify(compiled)), metrics: {
    context_version: MODEL_CONTEXT_VERSION, context_phase: state.decision.phase, observation_id: state.decision.observation_id,
    entity_rule_links: Object.keys(state.knowledge.entity_rules).length,
    entities_without_static_reference: Object.entries(state.knowledge.entity_rules).filter(([, link]) => link === null).map(([id]) => id),
    domain_bytes: Object.fromEntries(['decision', ...domains, 'uncertainty', 'text_dictionary'].filter(key => state[key] !== undefined)
      .map(key => [key, Buffer.byteLength(JSON.stringify(state[key]))])),
    questions_bytes: Buffer.byteLength(JSON.stringify(questions)),
    rule_counts: Object.fromEntries(Object.entries(state.knowledge.catalog || {}).map(([category, table]) => [category, table.keys.length])),
    source_bytes: Buffer.byteLength(JSON.stringify(payload)), preservation: 'canonical_round_trip_verified'
  } };
}

// Used by validation and offline inspection. The runtime executes canonical
// commands; it never turns the model-facing packet into new observations.
export function restoreCanonicalContext(context) {
  if (context.schema_version !== MODEL_CONTEXT_VERSION) return context;
  const source = structuredClone(context), result = { schema_version: source.source_schema_version };
  if (source.knowledge.catalog) source.knowledge.reference.entries = Object.fromEntries(Object.entries(source.knowledge.catalog)
    .map(([category, table]) => [category, table.records]));
  if (source.analysis.action_estimates) {
    source.observation.legal_actions = expandRecordTables(source.observation.legal_actions).map(action => ({ ...action,
      ...(Object.hasOwn(source.analysis.action_estimates, action.action_id) ? { combat_estimate: source.analysis.action_estimates[action.action_id] } : {}) }));
  }
  // Parent objects must be restored before lifted children.
  for (const [to, from] of [...routes].reverse()) {
    const value = take(source, from);
    if (value.present) put(result, to, value.value);
  }
  return result;
}

export function validateModelRequest(compiled, canonical) {
  const state = compiled.state;
  if (!checkSchema(state)) throw new ContextError('Invalid model context domains', { errors: structuredClone(checkSchema.errors) });
  for (const table of Object.values(state.knowledge.catalog || {})) {
    if (!isDeepStrictEqual(table.keys, expandRecordTables(table.records).map(rule => rule.id))) throw new ContextError('Rule catalogue keys do not match their records');
  }
  if (!isDeepStrictEqual(state.decision.question_keys, Object.keys(compiled.questions))) throw new ContextError('Decision frame does not match the current questions');
  if (state.decision.observation_id !== digestObservation(state.observation, state.text_dictionary)) throw new ContextError('Decision frame refers to a different observation');
  if (!isDeepStrictEqual(state.knowledge.entity_rules, entityLinks(state.observation, state.knowledge.catalog))) throw new ContextError('Entity-to-rule index is stale');
  const restored = restoreCanonicalContext(state);
  validateDecisionPacket(restored);
  if (canonical) {
    if (!isDeepStrictEqual(expandRecordTables(restored), expandRecordTables(canonical.state))) throw new ContextError('Context compiler lost or changed canonical data');
    const questions = Object.fromEntries(Object.entries(compiled.questions).map(([id, question]) => [id,
      { ...question, instructions: question.instructions.startsWith(prefix) ? question.instructions.slice(prefix.length) : question.instructions }]));
    if (!isDeepStrictEqual(questions, canonical.questions)) throw new ContextError('Context compiler changed questions or alternatives');
  }
  return compiled;
}
