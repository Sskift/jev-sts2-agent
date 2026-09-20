import { projectPositioning } from './combat_positioning.mjs';
import { uncomputedAttackReactions } from './combat_reactions.mjs';

// Arithmetic over player-visible facts only. These are single-action estimates,
// not a combat simulator: draws, general triggered effects and future choices stay unknown.
export const intentDamage = enemy => (enemy.intents || []).reduce((sum, intent) => sum + (Number.isFinite(intent.damage) ? intent.damage * (intent.hits || 1) : 0), 0);

export function firstHitHpLoss(card, enemy) {
  // A per-hit preview without a verified count does not establish that X will hit.
  // Zero-energy Whirlwind is playable but can deal no damage; payment modifiers
  // also mean current energy alone cannot establish the number of hits.
  if (card.attack_preview?.hits === 0 || (card.cost < 0 && !(card.attack_preview?.hits > 0))) return null;
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

export function previewHitCount(card) {
  const hits = card.attack_preview?.hits;
  return Number.isSafeInteger(hits) && hits >= 0 ? hits : card.cost < 0 ? null : 1;
}

export function previewDamageSum(card, enemy) {
  const damage = card.target_previews?.find(preview => preview.target_id === enemy.combat_id)?.damage;
  const hits = previewHitCount(card);
  return Number.isFinite(damage) && hits !== null ? damage * hits : null;
}

// Known hit counts use the same visible per-hit preview. Only the listed caps
// and Block are advanced between hits; other changing triggers remain unknown.
export function attackHpLoss(card, enemy) {
  const hits = previewHitCount(card);
  if (hits === null) return null;
  if (hits === 0) return { damage: 0, hp_loss: 0, hits: 0, limits: [], block_after: enemy.block, powers_after: enemy.powers || [] };
  const remaining = { ...enemy, powers: (enemy.powers || []).map(power => ({ ...power })) };
  // Simultaneous damage-prevention hooks may consume stacks in an order this
  // arithmetic does not model. Keep the original first-hit bound in that case.
  const ambiguousCaps = remaining.powers.filter(power => power.amount > 0 && ['SLIPPERY_POWER', 'BUFFER_POWER', 'INTANGIBLE_POWER'].includes(power.id)).length > 1;
  const limit = ambiguousCaps ? 1 : hits;
  let hpLoss = 0, damage = 0;
  const limits = new Set();
  for (let index = 0; index < limit; index++) {
    const hit = firstHitHpLoss(card, remaining);
    if (!hit) return null;
    const unblocked = hit.damage > remaining.block;
    remaining.block = Math.max(0, remaining.block - hit.damage);
    hpLoss += hit.hp_loss; damage += hit.damage;
    hit.limits.forEach(name => limits.add(name));
    if (unblocked && !ambiguousCaps) for (const power of remaining.powers) {
      if (['SLIPPERY_POWER', 'BUFFER_POWER'].includes(power.id) && power.amount > 0) power.amount--;
    }
  }
  return { damage, hp_loss: hpLoss, hits: limit, limits: [...limits], block_after: remaining.block, powers_after: remaining.powers };
}

export function immediateBlockPreview(card) {
  if (!card || card.id === 'RAGE' || card.type === 'Power') return { amount: 0, source: 'no_immediate_block' };
  if (Number.isFinite(card.block)) return { amount: Math.max(0, card.block), source: 'native_preview' };
  // Only a complete, unconditional FIRST sentence in the resolved live text.
  // Do not parse future triggers, per-card multipliers, or static Wiki values.
  const literal = card.description?.trim().match(/^Gain (\d+(?:\.\d+)?) Block\.(?:\s|$)/);
  if (literal) return { amount: Number(literal[1]), source: 'resolved_live_first_sentence' };
  return { amount: /\bBlock\b/.test(card.description || '') ? null : 0, source: 'no_native_preview' };
}

export function combatForecast(combat, card = null, target = null) {
  const reactions = uncomputedAttackReactions(combat, card, target, card ? previewHitCount(card) : 0);
  const reactionUnresolved = reactions.length > 0;
  const hit = target && card ? attackHpLoss(card, target) : null;
  const targetDepleted = hit && hit.hp_loss >= target.hp;
  const areaHits = card?.target_type === 'AllEnemies' ? combat.enemies.filter(e => e.is_alive && e.hp > 0).map(enemy => {
    const preview = attackHpLoss(card, enemy);
    return { target_id: enemy.combat_id, hp_loss: preview?.hp_loss ?? null, hp_depleted: Boolean(preview && preview.hp_loss >= enemy.hp) };
  }) : null;
  const depleted = new Set(areaHits?.filter(preview => preview.hp_depleted).map(preview => preview.target_id));
  if (targetDepleted) depleted.add(target.combat_id);
  const positioning = projectPositioning(combat, card ? [{ kind: 'play_card', target: target?.combat_id }] : [], depleted);
  const facingUnresolved = positioning && !positioning.current_intents_still_applicable;
  const incoming = combat.enemies.filter(e => e.is_alive && e.hp > 0 && !depleted.has(e.combat_id)).reduce((n, e) => n + intentDamage(e), 0);
  const exhausted = card?.id === 'SECOND_WIND' ? (combat.hand || []).filter(other => other.index !== card.index && other.type !== 'Attack') : null;
  const remainingHand = (combat.hand || []).filter(other => other.index !== card?.index && !exhausted?.some(removed => removed.index === other.index));
  const living = combat.enemies.filter(enemy => enemy.is_alive && enemy.hp > 0);
  const allTargetsDepleted = living.length > 0 && living.every(enemy => depleted.has(enemy.combat_id));
  const endTurnHandDamage = allTargetsDepleted ? 0 : remainingHand.filter(other => other.id === 'TOXIC').reduce((sum, other) => sum + Math.max(0, other.damage || 0), 0);
  const selfHpLoss = Math.max(0, card?.hp_loss || 0);
  const blockPreview = immediateBlockPreview(card);
  const immediateBlock = (blockPreview.amount ?? 0) * (exhausted ? exhausted.length : 1);
  // The active power grants unpowered Block once per Attack card, not per hit.
  // Dexterity/Frail do not modify this amount. Other block hooks remain outside
  // this limited estimate, as with printed Block above.
  const rageBlock = card?.type === 'Attack' ? (combat.player.powers || []).filter(power => power.id === 'RAGE_POWER').reduce((sum, power) => sum + Math.max(0, power.amount || 0), 0) : 0;
  const block = combat.player.block + immediateBlock + rageBlock;
  // Native v0.111.0: Orichalcum checks zero Block in VeryEarly, before Plating
  // grants its current Amount in Early. Both grants are Unpowered; neither is
  // immediate card Block or repeated between planned actions.
  const endTurnBlockGains = [];
  if (living.some(enemy => !depleted.has(enemy.combat_id))) {
    for (const power of combat.player.powers || []) if (power.id === 'PLATING_POWER' && power.amount > 0) {
      endTurnBlockGains.push({ source_id: power.id, amount: power.amount, timing: 'turn_end_early' });
    }
    if (block === 0 && combat.player.relics?.some(relic => relic.id === 'ORICHALCUM')) {
      endTurnBlockGains.push({ source_id: 'ORICHALCUM', amount: 6, timing: 'turn_end', condition_checked: 'zero_before_end_effects' });
    }
  }
  const blockIncludingEndTurnGains = block + endTurnBlockGains.reduce((sum, gain) => sum + gain.amount, 0);
  const loss = selfHpLoss + Math.max(0, incoming + endTurnHandDamage - blockIncludingEndTurnGains);
  const followup = card && target && hit ? followupAttackBudget(combat, card, target, hit) : null;
  // Sandpit is a visible, deterministic instant-death countdown. Ordinary
  // Block/HP cannot prevent it; Frantic Escape visibly adds one turn.
  const deathTimers = combat.enemies.filter(e => e.is_alive && e.hp > 0 && !depleted.has(e.combat_id))
    .flatMap(enemy => (enemy.powers || []).filter(p => p.id === 'SANDPIT_POWER' && p.amount > 0)
      .map(power => ({ target_id: enemy.combat_id, power_id: power.id, enemy_turns_remaining_after_card: power.amount + Number(card?.id === 'FRANTIC_ESCAPE') })));
  const instantDeath = deathTimers.some(timer => timer.enemy_turns_remaining_after_card <= 1);
  return {
    energy_after_printed_cost: card ? card.cost < 0 ? 0 : Math.max(0, combat.player.energy - card.cost) : combat.player.energy,
    first_hit_hp_loss: target && card ? firstHitHpLoss(card, target)?.hp_loss ?? null : null,
    ...(hit ? { attack_hp_loss: hit.hp_loss, preview_hits: hit.hits } : {}),
    ...(areaHits ? { attack_hp_loss_by_target: areaHits } : {}),
    ...(selfHpLoss ? { declared_self_hp_loss: selfHpLoss, hp_remaining_after_declared_loss: combat.player.hp - selfHpLoss, fatal_from_declared_hp_loss: selfHpLoss >= combat.player.hp } : {}),
    ...(endTurnHandDamage ? { end_turn_hand_damage: endTurnHandDamage } : {}),
    block_after_card: reactionUnresolved ? null : block,
    block_including_end_turn_gains: reactionUnresolved ? null : blockIncludingEndTurnGains,
    end_turn_block_gains: endTurnBlockGains,
    ...(blockPreview.source === 'resolved_live_first_sentence' || blockPreview.amount === null ? { block_preview: blockPreview } : {}),
    ...(rageBlock ? { active_rage_block_gain: rageBlock } : {}),
    displayed_attacks_after_target_depletion: reactionUnresolved ? null : incoming,
    ...(reactionUnresolved ? { uncomputed_reactions: reactions,
      block_baseline_without_reactions: block,
      reaction_coverage: 'HP, final Block and remaining incoming damage are unknown. Attack damage/removal and turn-end gain entries are conditional baselines only: reaction may prevent the card or later hits from finishing.' } : {}),
    ...(positioning ? { positioning, incoming_attack_preview_valid: !facingUnresolved } : {}),
    hp_loss_if_end_turn: reactionUnresolved ? null : instantDeath ? combat.player.hp : facingUnresolved ? null : loss,
    hp_remaining_if_end_turn: reactionUnresolved ? null : instantDeath ? 0 : facingUnresolved ? null : combat.player.hp - loss,
    fatal_if_end_turn: reactionUnresolved ? null : instantDeath || selfHpLoss >= combat.player.hp ? true : blockPreview.amount === null || facingUnresolved ? null : loss >= combat.player.hp,
    ...(exhausted ? { exhausted_hand_cards: exhausted.map(c => ({ index: c.index, id: c.id, type: c.type })), immediate_block_gain: immediateBlock } : {}),
    ...(deathTimers.length ? { death_timers: deathTimers, instant_death_if_end_turn: instantDeath } : {}),
    ...(followup?.hand_indices.length ? { followup_attacks: followup } : {}),
    ...(card?.id === 'RAGE' ? { attack_trigger_potential: rageFollowups(combat, card) } : {})
  };
}

function rageFollowups(combat, rage) {
  // Rage uses a power amount, not the ordinary Block dynamic variable. Older
  // mod builds omit it: unknown must not be presented as a zero-value effect.
  if (!Number.isFinite(rage.rage_block_per_attack)) return null;
  const energy = Math.max(0, Math.min(30, combat.player.energy - Math.max(0, rage.cost)));
  const dp = Array.from({ length: energy + 1 }, () => []);
  for (const card of combat.hand || []) {
    if (card.index === rage.index || card.type !== 'Attack' || !card.can_play || !Number.isInteger(card.cost) || card.cost < 0 || card.cost > energy || (card.hp_loss || 0) > 0) continue;
    for (let budget = energy; budget >= card.cost; budget--) {
      const candidate = [...dp[budget - card.cost], card.index];
      if (candidate.length > dp[budget].length) dp[budget] = candidate;
    }
  }
  const blockPerAttack = Math.max(0, rage.rage_block_per_attack);
  return { additional_block_per_attack: blockPerAttack, hand_indices: dp[energy], additional_block_if_all_played: blockPerAttack * dp[energy].length,
    note: 'Conditional future Block, not immediate Block. Play Rage before these currently playable attacks, using current fixed costs and remaining energy. Excludes X-cost and declared self-HP-loss attacks, draws, energy gains, cost changes and other triggers. Not a forced plan.' };
}

function followupAttackBudget(combat, played, target, hit) {
  if (hit.hp_loss >= target.hp) return { hp_damage: 0, hand_indices: [], enough_to_deplete_target: true };
  const postPowers = hit.powers_after;
  if (postPowers.filter(p => p.amount > 0 && ['SLIPPERY_POWER', 'BUFFER_POWER'].includes(p.id)).length > 1) return null;
  if (postPowers.some(p => p.amount > 0 && ['SLIPPERY_POWER', 'BUFFER_POWER', 'INTANGIBLE_POWER'].includes(p.id))) return null;
  const energy = played.cost < 0 ? 0 : Math.max(0, Math.min(30, combat.player.energy - played.cost));
  const dp = Array.from({ length: energy + 1 }, () => ({ damage: 0, hand_indices: [] }));
  for (const card of combat.hand || []) {
    if (card.index === played.index || !card.can_play || !Number.isInteger(card.cost) || card.cost < 0 || card.cost > energy || (card.hp_loss || 0) >= combat.player.hp - (played.hp_loss || 0)) continue;
    const damage = previewDamageSum(card, target);
    if (!Number.isFinite(damage) || damage <= 0) continue;
    for (let budget = energy; budget >= card.cost; budget--) {
      const prior = dp[budget - card.cost];
      if (prior.damage + damage > dp[budget].damage) dp[budget] = { damage: prior.damage + damage, hand_indices: [...prior.hand_indices, card.index] };
    }
  }
  const hpDamage = Math.max(0, dp[energy].damage - hit.block_after);
  return { hp_damage: hpDamage, hand_indices: dp[energy].hand_indices, enough_to_deplete_target: hpDamage + hit.hp_loss >= target.hp };
}
