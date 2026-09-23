// Dependency information for effects the arithmetic does not execute. This
// registry invalidates affected outcomes instead of treating absent work as 0.
// Counts are conditional preview exposure, not predicted HP loss.
import { effectTiming } from './effect_lifecycle.mjs';

// These native enemy powers can alter the target, Block or intent while an
// Attack resolves. Until their exact order is modeled, an attack preview is
// only a baseline and must not become a certain end-turn HP prediction.
const unmodeledAttackPowers = {
  ASLEEP_POWER: 'losing HP can awaken the owner',
  SLUMBER_POWER: 'losing HP can advance awakening',
  BURROWED_POWER: 'removing Block can Stun the owner',
  CURL_UP_POWER: 'taking damage can grant Block before later hits',
  SKITTISH_POWER: 'the first hit can grant Block before later hits',
  FLUTTER_POWER: 'attack hit count can Stun the owner',
  HARDENED_SHELL_POWER: 'per-turn HP loss is capped',
  COVERED_POWER: 'attacks can be redirected to an ally',
  INTERCEPT_POWER: 'attacks can be redirected to the owner',
  DIE_FOR_YOU_POWER: 'an ally can absorb attack damage'
};

export function uncomputedAttackReactions(combat, card, target, hits) {
  if (!card || (card.type !== 'Attack' && card.id !== 'OMNISLICE') || hits === 0) return [];
  const targets = card.target_type === 'AllEnemies' ? combat.enemies.filter(enemy => enemy.is_alive && enemy.hp > 0)
    : target?.is_alive && target.hp > 0 ? [target] : [];
  return targets.flatMap(enemy => [
    ...(enemy.powers || []).filter(power =>
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
    })),
    ...(enemy.powers || []).filter(power => Object.hasOwn(unmodeledAttackPowers, power.id)).map(power => ({
      source_id: power.id, owner_combat_id: enemy.combat_id, card_id: card.id,
      description: power.description, timing: 'during_attack_resolution',
      trigger: unmodeledAttackPowers[power.id], damage_per_trigger: null,
      preview_hits: hits, affected_outputs: ['enemy_hp', 'enemy_block', 'remaining_incoming_attack', 'player_hp'],
      scope: 'The live power may react during this Attack. Its effect and ordering are not simulated; current target damage and later enemy response are conditional baselines.'
    }))
  ]);
}
