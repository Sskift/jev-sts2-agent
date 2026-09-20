// Dependency information for effects the arithmetic does not execute. This
// registry invalidates affected outcomes instead of treating absent work as 0.
// Counts are conditional preview exposure, not predicted HP loss.
import { effectTiming } from './effect_lifecycle.mjs';

export function uncomputedAttackReactions(combat, card, target, hits) {
  if (!card || (card.type !== 'Attack' && card.id !== 'OMNISLICE') || hits === 0) return [];
  const targets = card.target_type === 'AllEnemies' ? combat.enemies.filter(enemy => enemy.is_alive && enemy.hp > 0)
    : target?.is_alive && target.hp > 0 ? [target] : [];
  return targets.flatMap(enemy => (enemy.powers || []).filter(power =>
    ['THORNS_POWER', 'FLAME_BARRIER_POWER'].includes(power.id) && power.amount > 0
    && (card.type === 'Attack' || power.id === 'THORNS_POWER')).map(power => ({
    source_id: power.id, owner_combat_id: enemy.combat_id, card_id: card.id,
    description: power.description, timing: effectTiming(power.id).trigger,
    trigger: effectTiming(power.id).detail,
    damage_per_trigger: power.amount, preview_hits: hits,
    damage_if_all_preview_hits_resolve: hits === null ? null : power.amount * hits,
    damage_kind: 'unpowered_blockable',
    affected_outputs: ['player_hp', 'player_block', 'enemy_survival', 'remaining_incoming_attack'],
    scope: 'Verified native v0.111.0 reaction hook; reaction damage, prevention, interruption on death and other hooks are not simulated. Preview hit count is conditional; unknown hits are not zero. Turn-end Block arrives after this reaction.'
  })));
}
