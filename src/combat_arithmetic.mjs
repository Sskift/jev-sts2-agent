// Arithmetic over player-visible facts only. These are single-action estimates,
// not a combat simulator: draws, general triggered effects and future choices stay unknown.
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
  const areaHits = card?.target_type === 'AllEnemies' ? combat.enemies.filter(e => e.is_alive && e.hp > 0).map(enemy => {
    const preview = firstHitHpLoss(card, enemy);
    return { target_id: enemy.combat_id, hp_loss: preview?.hp_loss ?? null, hp_depleted: Boolean(preview && preview.hp_loss >= enemy.hp) };
  }) : null;
  const depleted = new Set(areaHits?.filter(preview => preview.hp_depleted).map(preview => preview.target_id));
  if (targetDepleted) depleted.add(target.combat_id);
  const incoming = combat.enemies.filter(e => e.is_alive && e.hp > 0 && !depleted.has(e.combat_id)).reduce((n, e) => n + intentDamage(e), 0);
  const exhausted = card?.id === 'SECOND_WIND' ? (combat.hand || []).filter(other => other.index !== card.index && other.type !== 'Attack') : null;
  const remainingHand = (combat.hand || []).filter(other => other.index !== card?.index && !exhausted?.some(removed => removed.index === other.index));
  const living = combat.enemies.filter(enemy => enemy.is_alive && enemy.hp > 0);
  const allTargetsDepleted = living.length > 0 && living.every(enemy => depleted.has(enemy.combat_id));
  const endTurnHandDamage = allTargetsDepleted ? 0 : remainingHand.filter(other => other.id === 'TOXIC').reduce((sum, other) => sum + Math.max(0, other.damage || 0), 0);
  const selfHpLoss = Math.max(0, card?.hp_loss || 0);
  const immediateBlock = card?.id === 'RAGE' || card?.type === 'Power' ? 0 : Math.max(0, card?.block || 0) * (exhausted ? exhausted.length : 1);
  let block = combat.player.block + immediateBlock;
  if (block === 0 && combat.player.relics?.some(relic => relic.id === 'ORICHALCUM')) block = 6;
  const loss = selfHpLoss + Math.max(0, incoming + endTurnHandDamage - block);
  const followup = card && target && hit ? followupAttackBudget(combat, card, target, hit) : null;
  // Sandpit is a visible, deterministic instant-death countdown. Ordinary
  // Block/HP cannot prevent it; Frantic Escape visibly adds one turn.
  const deathTimers = combat.enemies.filter(e => e.is_alive && e.hp > 0 && !depleted.has(e.combat_id))
    .flatMap(enemy => (enemy.powers || []).filter(p => p.id === 'SANDPIT_POWER' && p.amount > 0)
      .map(power => ({ target_id: enemy.combat_id, power_id: power.id, enemy_turns_remaining_after_card: power.amount + Number(card?.id === 'FRANTIC_ESCAPE') })));
  const instantDeath = deathTimers.some(timer => timer.enemy_turns_remaining_after_card <= 1);
  return {
    energy_after_printed_cost: card ? card.cost < 0 ? 0 : Math.max(0, combat.player.energy - card.cost) : combat.player.energy,
    first_hit_hp_loss: hit?.hp_loss ?? null,
    ...(areaHits ? { first_hit_hp_loss_by_target: areaHits } : {}),
    ...(selfHpLoss ? { declared_self_hp_loss: selfHpLoss, hp_remaining_after_declared_loss: combat.player.hp - selfHpLoss, fatal_from_declared_hp_loss: selfHpLoss >= combat.player.hp } : {}),
    ...(endTurnHandDamage ? { end_turn_hand_damage: endTurnHandDamage } : {}),
    block_after_card: block,
    displayed_attacks_after_target_depletion: incoming,
    hp_loss_if_end_turn: instantDeath ? combat.player.hp : loss,
    hp_remaining_if_end_turn: instantDeath ? 0 : combat.player.hp - loss,
    fatal_if_end_turn: instantDeath || loss >= combat.player.hp,
    ...(exhausted ? { exhausted_hand_cards: exhausted.map(c => ({ index: c.index, id: c.id, type: c.type })), immediate_block_gain: immediateBlock } : {}),
    ...(deathTimers.length ? { death_timers: deathTimers, instant_death_if_end_turn: instantDeath } : {}),
    ...(followup?.hand_indices.length ? { followup_attacks: followup } : {}),
    ...(card?.id === 'RAGE' ? { attack_trigger_potential: rageFollowups(combat, card) } : {})
  };
}

function rageFollowups(combat, rage) {
  const energy = Math.max(0, Math.min(30, combat.player.energy - Math.max(0, rage.cost)));
  const dp = Array.from({ length: energy + 1 }, () => []);
  for (const card of combat.hand || []) {
    if (card.index === rage.index || card.type !== 'Attack' || !card.can_play || !Number.isInteger(card.cost) || card.cost < 0 || card.cost > energy || (card.hp_loss || 0) > 0) continue;
    for (let budget = energy; budget >= card.cost; budget--) {
      const candidate = [...dp[budget - card.cost], card.index];
      if (candidate.length > dp[budget].length) dp[budget] = candidate;
    }
  }
  const blockPerAttack = Math.max(0, rage.block || 0);
  return { additional_block_per_attack: blockPerAttack, hand_indices: dp[energy], additional_block_if_all_played: blockPerAttack * dp[energy].length,
    note: 'Conditional future Block, not immediate Block. Play Rage before these currently playable attacks, using current fixed costs and remaining energy. Excludes X-cost and declared self-HP-loss attacks, draws, energy gains, cost changes and other triggers. Not a forced plan.' };
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
    if (card.index === played.index || !card.can_play || !Number.isInteger(card.cost) || card.cost < 0 || card.cost > energy || (card.hp_loss || 0) >= combat.player.hp - (played.hp_loss || 0)) continue;
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
