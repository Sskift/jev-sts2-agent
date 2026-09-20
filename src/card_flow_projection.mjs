// Visible-rule adapters produce conditional pile deltas. They do not insert
// hypothetical cards into the observation or sample hidden placement/draw RNG.
export function attackCardFlowEffects(combat, card, target, hits, hitSource = 'supplied_preview') {
  if (card?.type !== 'Attack' || card.id === 'OMNISLICE' || hits === 0) return [];
  const living = combat.enemies.filter(enemy => enemy.is_alive && enemy.hp > 0);
  const amount = enemy => (enemy.powers || []).filter(power => power.id === 'PERSONAL_HIVE_POWER')
    .reduce((sum, power) => sum + Math.max(0, power.amount || 0), 0);
  let targets;
  if (card.target_type === 'AllEnemies' || card.target_type === 'RandomEnemy') targets = living;
  else targets = target ? living.filter(enemy => enemy.combat_id === target.combat_id) : [];
  if (!targets.some(enemy => amount(enemy) > 0)) return [];
  const random = card.target_type === 'RandomEnemy';
  const groups = random ? [targets] : targets.filter(enemy => amount(enemy) > 0).map(enemy => [enemy]);
  return groups.map(group => {
    const minimum = Math.min(...group.map(amount)), maximum = Math.max(...group.map(amount));
    return {
      source_id: 'PERSONAL_HIVE_POWER', owner_combat_ids: group.map(enemy => enemy.combat_id),
      played_card_id: card.id, generated_card_id: 'DAZED', generated_base_keywords: ['Unplayable', 'Ethereal'],
      destination: 'draw_pile', placement: 'random', may_displace_known_top: true,
      timing: 'after_each_powered_attack_damage_instance', preview_hits: hits, preview_hits_source: hitSource,
      added_if_all_preview_hits_resolve: { min: hits === null ? null : minimum * hits, max: hits === null ? null : maximum * hits },
      target_allocation: random ? 'random_enemy_per_hit' : card.target_type === 'AllEnemies' ? 'each_targeted_enemy' : 'selected_enemy',
      scope: 'Native v0.111.0 Personal Hive; each qualifying hit adds the current stack amount, even when blocked. Non-attack damage does not trigger it. Counts assume these powers/targets and all preview hits remain applicable. Unknown hit counts, deaths, future modifiers, draws and random insertion order are not simulated. Base keywords can be affected by current rules.'
    };
  });
}

export function describeCardFlow(combat, effects) {
  if (!effects.length) return null;
  const pile = combat.draw_pile || [];
  const sum = key => effects.some(effect => effect.added_if_all_preview_hits_resolve[key] === null) ? null
    : effects.reduce((total, effect) => total + effect.added_if_all_preview_hits_resolve[key], 0);
  return { is_observed_effect: false,
    observed_draw_pile: { count: pile.length, status_cards: pile.filter(card => card.type === 'Status').length,
      unplayable_keyword_cards: pile.filter(card => card.keywords?.includes('Unplayable')).length },
    generated_into_draw_pile: { min: sum('min'), max: sum('max') }, effects,
    scope: 'Conditional additions only, separate from the unchanged observed piles. Not a next-hand prediction: planned draws, selections, discards, reshuffles and early termination are not simulated. Random insertion may change previously known top-card placement. Compare draw quality and future response availability as well as immediate damage.'
  };
}
