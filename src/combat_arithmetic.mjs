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
  const block = combat.player.block + Math.max(0, card?.block || 0);
  const loss = Math.max(0, incoming - block);
  return {
    energy_after_card: card ? Math.max(0, combat.player.energy - Math.max(0, card.cost)) : combat.player.energy,
    first_hit_hp_loss: hit?.hp_loss ?? null,
    block_after_card: block,
    displayed_attacks_after_target_depletion: incoming,
    hp_loss_if_end_turn: loss,
    hp_remaining_if_end_turn: combat.player.hp - loss,
    fatal_if_end_turn: loss >= combat.player.hp
  };
}
