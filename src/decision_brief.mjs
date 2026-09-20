// Small, observed snapshots for continuity across independent Jev calls.
// Full rules, piles and history stay in the surrounding decision context.
export function combatFrame(state) {
  const combat = state.combat, player = combat?.player;
  if (!combat || !player) return null;
  const powers = list => (list || []).map(({ id, amount }) => ({ id, amount }));
  return {
    turn: combat.turn_number, is_player_turn: combat.is_player_turn,
    player: { hp: player.hp, block: player.block, energy: player.energy, powers: powers(player.powers) },
    hand_count: combat.hand.length,
    enemies: combat.enemies.map(enemy => ({ combat_id: enemy.combat_id, id: enemy.id, hp: enemy.hp, block: enemy.block, is_alive: enemy.is_alive, powers: powers(enemy.powers) }))
  };
}

export function observedCombatChange(before, afterState) {
  const after = combatFrame(afterState);
  if (!before || !after) return null;
  const changes = {};
  for (const key of ['hp', 'block', 'energy', 'powers']) if (JSON.stringify(before.player[key]) !== JSON.stringify(after.player[key])) changes[key] = { before: before.player[key], after: after.player[key] };
  const enemyChanges = after.enemies.flatMap(enemy => {
    const old = before.enemies.find(item => item.combat_id === enemy.combat_id);
    if (!old) return [{ combat_id: enemy.combat_id, appeared: enemy }];
    const delta = Object.fromEntries(['hp', 'block', 'is_alive', 'powers'].filter(key => JSON.stringify(old[key]) !== JSON.stringify(enemy[key])).map(key => [key, { before: old[key], after: enemy[key] }]));
    return Object.keys(delta).length ? [{ combat_id: enemy.combat_id, changes: delta }] : [];
  });
  for (const enemy of before.enemies) if (!after.enemies.some(item => item.combat_id === enemy.combat_id)) enemyChanges.push({ combat_id: enemy.combat_id, disappeared: true });
  return { from_turn: before.turn, to_turn: after.turn, is_player_turn_after: after.is_player_turn, player_changes: changes,
    ...(enemyChanges.length ? { enemy_changes: enemyChanges } : {}),
    ...(before.hand_count !== after.hand_count ? { hand_count: { before: before.hand_count, after: after.hand_count } } : {}) };
}

export function buildDecisionBrief(state, memory) {
  if (!state.combat) return null;
  const context = state.decision_context;
  const actions = memory.data.run_id === context?.run_id ? memory.data.actions.filter(action => action.ok && action.floor === context.total_floor && action.combat_id === context.combat_id).slice(-4) : [];
  return {
    purpose: 'Reading aid for this independent decision, not a replacement for full state/history. Recent changes were observed between command and confirmation and can include game triggers. They are past facts, not promised future effects or a forced plan.',
    turn_number: state.combat.turn_number,
    current_resources: { hp: state.combat.player.hp, energy: state.combat.player.energy, block: state.combat.player.block },
    recent_confirmed_actions: actions.map(action => ({ round: action.round, request: action.request, after_screen: action.after_screen,
      ...(action.played_card_at_request ? { played_card: { id: action.played_card_at_request.id, name: action.played_card_at_request.name, cost: action.played_card_at_request.cost, rules_at_play: action.played_card_at_request.description } } : {}),
      ...(action.potion_at_request ? { used_potion: action.potion_at_request } : {}),
      observed_change: action.observed_combat_change ?? null })),
    history_coverage: actions.some(action => !action.observed_combat_change) ? 'Some older commands have no paired combat snapshot. Their full game history and recorded actions remain available; null is unknown.' : 'Last four confirmed commands from this combat; all available earlier game history is retained separately.'
  };
}
