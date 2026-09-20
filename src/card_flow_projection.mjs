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

// Compare observation segments and end-turn plans at the same decision horizon.
// These are remaining choices and known pools, never sampled future cards.
export function describeContinuation(combat, sequence) {
  if (!sequence.checkpoint) return { handoff: 'enemy_turn', further_player_choices: false };
  const last = sequence.entries.at(-1), entity = last?.card || last?.potion;
  const text = entity?.description || '';
  const draw = text.match(/(?:^|[.\n]\s*)Draw (\d+) cards?\./i);
  const groups = new Map();
  for (const card of combat.draw_pile || []) {
    const key = JSON.stringify([card.id, card.cost, card.description]);
    const row = groups.get(key) || { id: card.id, name: card.name, cost: card.cost, count: 0,
      cost_within_remaining_energy: Number.isFinite(card.cost) && card.cost >= 0 ? card.cost <= sequence.energy_left : null };
    row.count++; groups.set(key, row);
  }
  return { handoff: 'observe_then_continue_same_player_turn', further_player_choices: true,
    checkpoint: sequence.checkpoint, energy_after_known_payments: sequence.energy_left,
    remaining_hand_before_unresolved_effects: sequence.remaining_hand.map(card => ({ hand_index: card.index,
      id: card.id, name: card.name, cost: card.cost, type: card.type, rules: card.description })),
    ...(draw ? { draw_access: { declared_count: Number(draw[1]),
      source: 'Currently observed draw pile; its array order is not predictive.', pool: [...groups.values()],
      pool_cards_within_remaining_energy_at_observed_cost: [...groups.values()].filter(row => row.cost_within_remaining_energy === true).reduce((n, row) => n + row.count, 0),
      observed_pool_size: combat.draw_pile.length, reshuffle_may_be_needed: Number(draw[1]) > combat.draw_pile.length,
      checkpoint_rules: text,
      current_draw_effects: (combat.player.powers || []).filter(p => /draw/i.test(p.description || '')).map(p => ({ id: p.id, rules: p.description })),
      scope: 'Declared draw, not guaranteed arrivals: hand capacity, draw prevention, triggers and reshuffle can change the result. Cost comparisons use observed pile costs and remaining energy only, not future costs, legal playability or a guarantee of drawing any affordable card. No specific card or ordering is assumed.' } } : {}),
    scope: 'The player still owns this turn. After observing, choose again using remaining resources and the actual changed hand; ending immediately is not required. Retained cards and the visible pool describe opportunities, not executed follow-up actions. Unresolved effects may change these resources; an unknown continuation is neither zero value nor a guaranteed best draw.' };
}

// Describe shared resources symmetrically when a short observation segment is
// compared with a longer commitment. It does not simulate through a checkpoint
// or promise the other plan's damage/Block after unresolved effects.
export function compareContinuationResources(planA, planB) {
  const describe = (plan, other) => {
    if (!plan.continuation.further_player_choices) return null;
    const hand = plan.continuation.remaining_hand_before_unresolved_effects;
    const unspent = other.ordered_sequence.flatMap(action => {
      const card = hand.find(card => card.hand_index === action.hand_index);
      return card ? [{ hand_index: card.hand_index, name: card.name, observed_cost: card.cost,
        ...(action.target !== undefined ? { other_plan_target: action.target } : {}) }] : [];
    });
    if (!unspent.length) return null;
    const cost = unspent.every(card => Number.isFinite(card.observed_cost) && card.observed_cost >= 0)
      ? unspent.reduce((sum, card) => sum + card.observed_cost, 0) : null;
    return { other_plan_cards_still_in_hand_before_unresolved_effects: unspent,
      total_observed_cost: cost, energy_after_known_payments: plan.energy_left,
      fits_remaining_energy_at_observed_cost: cost === null ? null : cost <= plan.energy_left,
      scope: 'These actions from the other plan have not been spent by this segment and remain possible follow-up resources, subject to the observation. This is only a current-cost reservation check. New effects, targets, costs, restrictions, selection, discards or hand transformations can invalidate it; no follow-up effect is guaranteed. Newly revealed choices may justify changing the continuation.' };
  };
  return { after_plan_a_observation: describe(planA, planB), after_plan_b_observation: describe(planB, planA) };
}
