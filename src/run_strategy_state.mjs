import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const strategicCapabilities = {
  single_target_damage: 'Reliable damage against one enemy within the actual recurring energy budget.',
  multiple_enemy_control: 'Handling several enemies before their combined pressure overwhelms the player.',
  sustained_defense: 'Repeatedly preventing HP loss across a full deck cycle, not just one strong defensive draw.',
  long_fight_scaling: 'Improving effectiveness enough to finish prolonged or scaling boss fights.',
  draw_consistency: 'Finding useful combinations reliably, accounting for deck size, draw, selection and unusable draws.',
  energy_efficiency: 'Playing useful combinations with available recurring energy, realistic setup costs and supported cost changes.',
  recovery: 'Recovering from accumulated damage using owned effects and visible route opportunities.'
};
export const developmentPriorities = { ...strategicCapabilities,
  preserve_flexibility: 'No single development need dominates; compare concrete improvements without forcing a speculative archetype.' };
const sort = values => values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

// Permanent capabilities are reconsidered at room/aftermath boundaries and
// after material build changes, not whenever a combat counter or hand changes.
export function strategyBasis(state) {
  const context = state.decision_context;
  if (!context?.run_id || !context.player) return null;
  const material = {
    act: context.act_index, max_hp: context.player.max_hp,
    deck: sort(context.master_deck.map(card => [card.id, card.details?.upgrade_level ?? Number(Boolean(card.is_upgraded)),
      card.details?.enchantment ?? null, card.details?.affliction ?? null])),
    relics: context.player.relics.map(relic => relic.id).sort()
  };
  return { run_id: context.run_id, act_index: context.act_index, floor: context.total_floor,
    checkpoint: `${context.total_floor}:${state.combat ? 'combat' : 'between_rooms'}`,
    build_id: createHash('sha256').update(JSON.stringify(material)).digest('hex').slice(0, 24) };
}

export function strategyRefreshReason(state, memory) {
  const basis = strategyBasis(state), current = memory?.data.run_strategy;
  if (!basis) return null;
  if (!current || current.basis.run_id !== basis.run_id) return 'No strategic assessment exists for this run.';
  if (current.basis.act_index !== basis.act_index) return 'The run entered a different act.';
  if (current.basis.build_id !== basis.build_id) return 'The permanent deck, owned relics or maximum HP changed.';
  if (current.basis.checkpoint !== basis.checkpoint) return 'A new room or its post-combat choices need a strategic review.';
  return null;
}

export function publicRunStrategy(state, memory) {
  const current = memory?.data.run_strategy;
  if (!current || current.basis.run_id !== state.decision_context?.run_id) return null;
  const reason = strategyRefreshReason(state, memory);
  return {
    source: 'persisted_jev_judgment', is_observed_fact: false, run_id: current.basis.run_id,
    revision: current.revision, basis: current.basis,
    freshness: { needs_review: Boolean(reason), reason },
    development_priority: { id: current.priority.choice, meaning: developmentPriorities[current.priority.choice], confidence: current.priority.confidence },
    anchor: current.anchor,
    capability_assessment: { source: 'jev_judgment', assessed_revision: current.revision, model: current.model,
      scale: '0 absent, 1 weak/unreliable, 2 adequate with limitations, 3 strong/reliable',
      dimensions: strategicCapabilities, ratings: current.capabilities },
    revisions: memory.data.strategy_revisions || [],
    scope: 'Advisory judgment of the owned build at the recorded checkpoint, not a fact, card-buying rule or commitment. Current HP, hand, enemies, prices and actual offered options take precedence. Tactical survival may override the development priority. No future random acquisition is assumed; revise after material changes.'
  };
}

export function rememberRunStrategy(memory, state, assessment, reason) {
  const basis = strategyBasis(state);
  if (!basis || memory.data.run_id !== basis.run_id) throw new Error('Cannot save strategy under another run');
  const previous = memory.data.run_strategy;
  const revision = previous?.basis.run_id === basis.run_id ? previous.revision + 1 : 1;
  const current = { revision, basis, priority: assessment.priority, anchor: assessment.anchor,
    capabilities: assessment.capabilities, model: assessment.model };
  const before = previous ? { priority: previous.priority, anchor: previous.anchor, capabilities: previous.capabilities } : {};
  const after = { priority: current.priority, anchor: current.anchor, capabilities: current.capabilities };
  const changes = {};
  for (const field of ['priority', 'anchor']) if (!isDeepStrictEqual(before[field], after[field])) changes[field] = { before: before[field] ?? null, after: after[field] };
  for (const [capability, rating] of Object.entries(after.capabilities)) {
    if (!isDeepStrictEqual(before.capabilities?.[capability], rating)) changes[capability] = { before: before.capabilities?.[capability] ?? null, after: rating };
  }
  memory.data.run_strategy = current;
  (memory.data.strategy_revisions ??= []).push({ revision, act_index: basis.act_index, floor: basis.floor, reason, changes });
  memory.persist();
  return current;
}
