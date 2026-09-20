import fs from 'node:fs';
import { lookupRule } from './rule_reference.mjs';
import { enemyOutlook } from './enemy_patterns.mjs';

const notes = JSON.parse(fs.readFileSync(new URL('../data/strategy/v0.111.0/strategy.json', import.meta.url)));
export function buildStrategyKnowledge(state) {
  const context = state.decision_context;
  if (!context) return null;
  const character = notes.characters[context.player.character_id];
  const cards = [...context.master_deck, ...(state.combat?.hand || [])];
  const ids = new Set(cards.map(c => c.id));
  const text = cards.map(c => c.description || '').join('\n');
  const packages = (character?.packages || []).map(note => ({ ...note,
    relevance: { current_cards: (note.cards || []).filter(id => ids.has(id)),
      present_mechanics: (note.terms || []).filter(term => new RegExp(`\\b${term}\\b`, 'i').test(text)) } }))
    // Between rooms all directions are potential answers to an offered reward.
    // In combat only supported packages are useful; no unrelated class guide.
    .filter(note => !state.combat || note.relevance.current_cards.length || note.relevance.present_mechanics.length);
  const general = notes.general.filter(note => !state.combat || !note.phases);
  const sources = new Set([...general.map(n => n.source), ...(character ? [character.source] : []), ...packages.map(n => n.source).filter(Boolean)]);
  return { rules_version: notes.rules_version, reviewed_at: notes.reviewed_at, authority: notes.authority,
    general, character: character ? { id: context.player.character_id, overview: character.overview, packages } : null,
    sources: Object.fromEntries([...sources].map(id => [id, notes.sources[id]])) };
}

export function describeEnemyOutlook(state) {
  return state.combat.enemies.filter(e => e.is_alive).map(enemy => enemyOutlook(enemy, lookupRule('monsters', enemy.id)?.moves));
}

// Retain compact encounter feedback even when old turn-by-turn history is
// scoped out. These are observed totals, never a target preference or forecast.
export function describeCombatProgress(state, memory) {
  const context = state.decision_context, combat = state.combat;
  const history = (context.combat_history || []).filter(e => e.round <= combat.turn_number);
  const actions = memory?.data.run_id === context.run_id ? memory.data.actions.filter(a => a.ok
    && a.combat_id === context.combat_id && a.round <= combat.turn_number) : null;
  const sum = (events, key) => events.every(e => Number.isFinite(e.damage?.[key]) && e.damage[key] >= 0)
    ? events.reduce((total, e) => total + e.damage[key], 0) : null;
  return { current_round: combat.turn_number, history_coverage: context.history_coverage,
    enemies: combat.enemies.map(enemy => {
      const damage = history.filter(e => e.type === 'DamageReceivedEntry' && e.actor_id === enemy.combat_id);
      const minion = enemy.powers?.some(p => ['ILLUSION_POWER', 'MINION_POWER'].includes(p.id));
      return { combat_id: enemy.combat_id, role: minion ? 'minion' : 'not_identified_as_minion', current_hp: enemy.hp,
        recorded_damage_events: damage.length, recorded_hp_damage: sum(damage, 'unblocked'),
        recorded_overkill: sum(damage, 'overkill'),
        last_damaged_round: damage.filter(e => e.damage?.unblocked > 0).at(-1)?.round ?? null,
        observed_hp_depletions: actions === null ? null : actions.reduce((total, action) => total +
          (action.observed_combat_change?.enemy_changes || []).filter(e => e.combat_id === enemy.combat_id
            && e.changes?.hp?.before > 0 && e.changes.hp.after === 0).length, 0) };
    }),
    scope: 'Totals from available executed native events and confirmed action snapshot changes in this combat only. Native unblocked damage already excludes overkill; it is not subtracted twice. Damage may have been healed or revived, and observed zero-HP transitions do not establish permanent removal. Missing earlier history is not reconstructed. Current HP, powers and revival/leader rules determine remaining work; these statistics do not prescribe a target.' };
}

// These labels expose how HP depletion relates to the encounter objective.
// They are facts/unknowns for Jev to weigh, never an automatic target policy.
export function encounterProgress(combat, remaining, unknownTargets = []) {
  return combat.enemies.map(enemy => {
    const after = remaining.find(e => e.combat_id === enemy.combat_id);
    const powers = enemy.powers || [];
    const rules = powers.filter(p => /reviv|resurrect|when.*di(?:e|es)|would be defeated|abandon|reattach/i.test(p.description || '')
      || ['ILLUSION_POWER', 'MINION_POWER', 'REATTACH_POWER', 'ADAPTABLE_POWER'].includes(p.id));
    const illusion = powers.some(p => p.id === 'ILLUSION_POWER');
    const minion = illusion || powers.some(p => p.id === 'MINION_POWER');
    const unknown = unknownTargets.includes(enemy.combat_id);
    const loss = !after || unknown ? null : Math.max(0, enemy.hp - after.hp);
    return { combat_id: enemy.combat_id, role: minion ? 'minion' : 'not_identified_as_minion',
      hp_removed_if_declared_actions_resolve: loss,
      hp_depleted: loss === null ? null : after.hp <= 0,
      depletion_rules: rules.map(p => ({ id: p.id, rules: p.description || lookupRule('powers', p.id.replace(/_POWER$/, ''))?.description_raw })),
      ...(illusion ? { consequence: 'Illusion replaces death with a revival move at full HP next turn and grants Minion. Partial damage neither cancels its current attack nor defeats it. Depletion interrupts its current attack but does not permanently remove it while a primary enemy remains.' } : {}),
      permanent_removal_established: loss === null || rules.length ? null : after.hp <= 0,
      scope: 'Conditional HP progress, not a complete death-hook simulation. Account for leader removal, revival, phase changes and current attacks separately; no future random outcome is assumed.' };
  });
}
