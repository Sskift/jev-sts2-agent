// Arithmetic over player-visible facts only. These are single-action estimates,
// not a combat simulator: draws, triggered effects and future choices stay unknown.
export const intentDamage = enemy => (enemy.intents || []).reduce((sum, intent) => sum + (Number.isFinite(intent.damage) ? intent.damage * (intent.hits || 1) : 0), 0);

export function firstHitHpLoss(card, enemy) {
  const damage = card.target_previews?.find(p => p.target_id === enemy.combat_id)?.damage;
  if (!Number.isFinite(damage)) return null;
  let hpLoss = Math.max(0, damage - enemy.block);
  const limits = [];
  for (const power of enemy.powers || []) if (power.amount > 0) {
    if (['SLIPPERY_POWER', 'INTANGIBLE_POWER'].includes(power.id)) { hpLoss = Math.min(hpLoss, 1); limits.push(power.name || power.id); }
    if (power.id === 'BUFFER_POWER') { hpLoss = 0; limits.push(power.name || power.id); }
  }
  return { damage, hp_loss: hpLoss, limits };
}

export function combatForecast(combat, card = null, target = null) {
  const hit = target && card ? firstHitHpLoss(card, target) : null;
  const targetDepleted = hit && hit.hp_loss >= target.hp;
  const incoming = combat.enemies.filter(e => e.is_alive && e.hp > 0 && !(targetDepleted && e.combat_id === target.combat_id)).reduce((n, e) => n + intentDamage(e), 0);
  const immediateBlock = card?.id === 'RAGE' || card?.type === 'Power' ? 0 : Math.max(0, card?.block || 0);
  let block = combat.player.block + immediateBlock;
  if (block === 0 && combat.player.relics?.some(relic => relic.id === 'ORICHALCUM')) block = 6;
  const loss = Math.max(0, incoming - block);
  const followup = card && target && hit ? followupAttackBudget(combat, card, target, hit) : null;
  return {
    energy_after_card: card ? card.cost < 0 ? 0 : Math.max(0, combat.player.energy - card.cost) : combat.player.energy,
    first_hit_hp_loss: hit?.hp_loss ?? null,
    block_after_card: block,
    displayed_attacks_after_target_depletion: incoming,
    hp_loss_if_end_turn: loss,
    hp_remaining_if_end_turn: combat.player.hp - loss,
    fatal_if_end_turn: loss >= combat.player.hp,
    ...(followup?.hand_indices.length ? { followup_attacks: followup } : {})
  };
}

function followupAttackBudget(combat, played, target, hit) {
  if (hit.hp_loss >= target.hp) return { hp_damage: 0, hand_indices: [], enough_to_deplete_target: true };
  const postPowers = (target.powers || []).map(p => ({ ...p }));
  if (postPowers.filter(p => p.amount > 0 && ['SLIPPERY_POWER', 'BUFFER_POWER'].includes(p.id)).length > 1) return null;
  // Slippery and Buffer consume one stack only when an unblocked hit arrives.
  if (hit.damage > target.block) for (const power of postPowers) {
    if (['SLIPPERY_POWER', 'BUFFER_POWER'].includes(power.id)) power.amount--;
  }
  if (postPowers.some(p => p.amount > 0 && ['SLIPPERY_POWER', 'BUFFER_POWER', 'INTANGIBLE_POWER'].includes(p.id))) return null;
  const energy = played.cost < 0 ? 0 : Math.max(0, Math.min(30, combat.player.energy - played.cost));
  const dp = Array.from({ length: energy + 1 }, () => ({ damage: 0, hand_indices: [] }));
  for (const card of combat.hand || []) {
    if (card.index === played.index || !card.can_play || !Number.isInteger(card.cost) || card.cost < 0 || card.cost > energy) continue;
    const damage = card.target_previews?.find(p => p.target_id === target.combat_id)?.damage;
    if (!Number.isFinite(damage) || damage <= 0) continue;
    for (let budget = energy; budget >= card.cost; budget--) {
      const prior = dp[budget - card.cost];
      if (prior.damage + damage > dp[budget].damage) dp[budget] = { damage: prior.damage + damage, hand_indices: [...prior.hand_indices, card.index] };
    }
  }
  const hpDamage = Math.max(0, dp[energy].damage - Math.max(0, target.block - hit.damage));
  return { hp_damage: hpDamage, hand_indices: dp[energy].hand_indices, enough_to_deplete_target: hpDamage + hit.hp_loss >= target.hp };
}
