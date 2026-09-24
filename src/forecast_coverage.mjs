import { displayedAttackTotal } from './combat_observation.mjs';
import { reviewedEffectScope, reviewedIntentScope, supportedNativePreviewRule } from './rule_scope.mjs';

// Closed coverage lists: a new active source is uncomputed until reviewed.
// Native preview modifiers are already incorporated in the observed numbers.
const previewPowers = new Set(['STRENGTH_POWER', 'DEXTERITY_POWER', 'WEAK_POWER', 'VULNERABLE_POWER', 'FRAIL_POWER', 'TANGLED_POWER']);
const playerPowers = new Set(['RAGE_POWER', 'PLATING_POWER', 'CONSTRICT_POWER', 'NO_DRAW_POWER', 'RINGING_POWER', 'RADIANCE_POWER', 'REGEN_POWER', 'SURROUNDED_POWER']);
const enemyPowers = new Set(['ARTIFACT_POWER', 'SLIPPERY_POWER', 'BUFFER_POWER', 'INTANGIBLE_POWER', 'SLOW_POWER',
  'PLOW_POWER', 'SHRIEK_POWER', 'SANDPIT_POWER', 'THORNS_POWER', 'FLAME_BARRIER_POWER', 'PERSONAL_HIVE_POWER', 'REATTACH_POWER', 'DEBILITATE_POWER',
  'BACK_ATTACK_LEFT_POWER', 'BACK_ATTACK_RIGHT_POWER']);
const coveredRelics = new Set(['ORICHALCUM', 'CLOAK_CLASP', 'BURNING_BLOOD', 'BAG_OF_PREPARATION', 'LOST_COFFER',
  'SWORD_OF_STONE', 'NUTRITIOUS_OYSTER', 'CAPTAINS_WHEEL', 'POCKETWATCH', 'HAPPY_FLOWER']);
const plainRule = /^(?:Deal [\d.]+ damage(?: to ALL enemies)?(?: (?:\d+ times|twice|thrice))?\.|Gain [\d.]+ Block\.)$/i;
const supportedSingle = card => plainRule.test(card.description.trim()) || supportedNativePreviewRule(card)
  || card.id === 'MANGLE' && /^Deal [\d.]+ damage\. Enemy loses \d+ Strength this turn\.$/i.test(card.description.trim())
  || card.id === 'BREAKTHROUGH' && /^Lose \d+ HP\. Deal [\d.]+ damage to ALL enemies\.$/i.test(card.description.trim())
  || card.id === 'WHIRLWIND' && Number.isSafeInteger(card.attack_preview?.hits)
  || card.id === 'DISMANTLE' && /^Deal [\d.]+ damage\. If the enemy is Vulnerable, hits twice\.$/i.test(card.description.trim())
  || card.id === 'RAGE' && Number.isFinite(card.rage_block_per_attack)
  || card.id === 'SECOND_WIND' && Number.isFinite(card.block);
const outputKinds = ['enemy_hp', 'player_block', 'player_hp', 'enemy_response'];
export const coverageAffects = (coverage, output) => coverage.uncovered_effects.some(effect => effect.affected_outputs.includes(output));

export function forecastCoverage(combat, card = null, { sequence = false, uncomputedActions = [], playedCards = card ? [card] : [] } = {}) {
  const uncovered = uncomputedActions.map(effect => ({ ...effect, affected_outputs: outputKinds }));
  const reviewed = [];
  const add = (category, owner, source, reason, affected_outputs = outputKinds) => uncovered.push({ category, owner, source_id: source.id,
    live_rule: source.description || '', reason, affected_outputs });
  const review = (category, owner, source) => {
    const scope = reviewedEffectScope(category, source, { owner, playedCards });
    if (!scope) return false;
    reviewed.push({ category, owner, source_id: source.id, ...scope });
    if (scope.affected_outputs.length) add(category, owner, source, scope.interpretation, scope.affected_outputs);
    return true;
  };
  for (const power of combat.player.powers || []) if (!previewPowers.has(power.id) && !playerPowers.has(power.id)
    && !((sequence || !card) && power.id === 'TENDER_POWER'))
    add('power', 'player', power, 'Active player effect has no complete numeric adapter.');
  for (const enemy of combat.enemies) {
    for (const power of enemy.powers || []) if (!previewPowers.has(power.id) && !enemyPowers.has(power.id) && !review('powers', enemy.combat_id, power))
      add('power', enemy.combat_id, power, 'Enemy effect or reaction has no complete numeric adapter.');
    for (const intent of enemy.intents || []) if (enemy.is_alive && enemy.hp > 0 && intent.type
      && !['Attack', 'Stun', 'Defend'].includes(intent.type)) {
      const scope = reviewedIntentScope(enemy, intent);
      if (scope) reviewed.push({ category: 'intent', owner: enemy.combat_id, source_id: intent.type, ...scope });
      else add('intent', enemy.combat_id, { id: intent.type, description: intent.description }, 'Only the displayed intent is observed; this enemy action and its interaction with later actions are not simulated.', ['player_hp', 'enemy_response']);
    }
  }
  for (const relic of combat.player.relics || []) if (!coveredRelics.has(relic.id) && !review('relics', 'player', relic))
    add('relic', 'player', relic, 'Relic trigger timing or consequences have not been incorporated in this calculation.');
  for (const potion of combat.player.potions || []) if (potion.usage === 'Automatic' && potion.id !== 'FAIRY_IN_A_BOTTLE')
    add('potion', 'player', potion, 'Automatic potion trigger has no numeric adapter.');
  for (const category of ['orbs', 'pets']) for (const source of combat.player[category] || [])
    if (!review(category, 'player', source)) add(category, 'player', source, 'This automatic actor is present in the native state but its actions are not simulated.');
  // Attachments can add triggers without changing the card's ordinary rule.
  // Check all piles because an effect can trigger on draw/discard/exhaust.
  const seenAttachments = new Set();
  for (const pile of ['hand', 'draw_pile', 'discard_pile', 'exhaust_pile']) for (const current of combat[pile] || [])
    for (const category of ['enchantment', 'affliction']) {
      const raw = current.details?.[category] || current[category];
      const source = typeof raw === 'string' ? { id: raw } : raw;
      if (!source?.id || category === 'affliction' && source.id === 'RINGING') continue;
      const key = JSON.stringify([category, source.id, source.description, source.amount]);
      if (!seenAttachments.has(key) && !review(`${category}s`, 'player', source)) add(category, 'player', source, 'Card attachment triggers are not incorporated in this calculation.');
      seenAttachments.add(key);
    }
  if (displayedAttackTotal(combat.enemies) === null)
    add('intent', 'enemies', { id: 'INCOMPLETE_ATTACK_PREVIEW' }, 'A displayed Attack has unknown damage or hit count.', ['player_hp', 'enemy_response']);
  if (card?.description && !supportedSingle(card))
    add('card', 'player', card, 'Single-card arithmetic does not execute this complete rule; its native previews remain in the current hand.');
  return { status: uncovered.length ? 'incomplete' : 'bounded', uncovered_effects: uncovered,
    ...(reviewed.length ? { reviewed_dependencies: reviewed } : {}),
    scope: 'Current native rules remain authoritative. Coverage is closed: unrecognized active effects invalidate dependent future totals instead of counting as zero. Bounded arithmetic is still conditional, not a full game simulation.' };
}

export function scopeSingleActionForecast(combat, card, estimate) {
  const coverage = forecastCoverage(combat, card);
  const result = { ...estimate, calculation_coverage: coverage };
  const fields = {
    enemy_hp: ['first_hit_hp_loss', 'attack_hp_loss'],
    player_block: ['block_after_card', 'block_including_end_turn_gains'],
    player_hp: ['hp_loss_if_end_turn', 'hp_remaining_if_end_turn', 'fatal_if_end_turn', 'hp_remaining_after_declared_loss', 'fatal_from_declared_hp_loss', 'instant_death_if_end_turn'],
    enemy_response: ['displayed_attacks_after_target_depletion']
  };
  for (const [output, keys] of Object.entries(fields)) if (coverageAffects(coverage, output))
    for (const key of keys) if (key in result) result[key] = null;
  if (coverageAffects(coverage, 'enemy_hp')) {
    if (result.attack_hp_loss_by_target) result.attack_hp_loss_by_target = result.attack_hp_loss_by_target
      .map(hit => ({ ...hit, hp_loss: null, hp_depleted: null }));
    delete result.known_threshold_reactions;
  }
  if (coverageAffects(coverage, 'enemy_response') && result.temporary_enemy_strength_loss)
    result.temporary_enemy_strength_loss.current_attack_after_application = null;
  if (estimate.block_preview?.amount === null) {
    result.block_after_card = result.block_including_end_turn_gains = null;
    result.hp_loss_if_end_turn = result.hp_remaining_if_end_turn = result.fatal_if_end_turn = null;
  }
  return result;
}
