// Compare a forecast attached to the dispatched action with the next native
// observation. This audits our arithmetic; it never rewrites observed state.
export function auditObservedAction(before, decision, after) {
  const request = decision?.request;
  const estimate = decision?.combat_estimate;
  if (before?.screen !== 'COMBAT' || !request || !estimate
    || before.decision_context?.run_id !== after?.decision_context?.run_id) return null;

  const comparisons = [];
  const compare = (field, predicted, observed) => {
    if (Number.isFinite(predicted) && Number.isFinite(observed))
      comparisons.push({ field, predicted, observed, matches: predicted === observed });
  };

  const sameCombat = before.decision_context?.combat_id === after.decision_context?.combat_id;
  const sameTurn = sameCombat && after.screen === 'COMBAT'
    && after.combat?.turn_number === before.combat?.turn_number && after.combat?.is_player_turn === true
    && after.combat.is_player_actions_disabled !== true && after.combat.is_combat_ending !== true;
  const completedTurn = after.screen === 'GAME_OVER'
    || (sameCombat && after.screen === 'COMBAT' && after.combat?.is_player_turn === true
      && Number.isFinite(before.combat?.turn_number) && after.combat.turn_number > before.combat.turn_number);

  if (request.cmd === 'end_turn' && completedTurn) {
    // HP cannot be negative in the native observation. A completed turn or
    // game-over snapshot can validate the end-turn survival calculation.
    const observedHp = after.decision_context?.player?.hp;
    if (Number.isFinite(estimate.hp_remaining_if_end_turn))
      compare('player_hp_after_end_turn', Math.max(0, estimate.hp_remaining_if_end_turn), observedHp);
  } else if (request.cmd === 'play_card' && sameTurn && !estimate.uncomputed_reactions?.length) {
    compare('player_block_after_card', estimate.block_after_card, after.combat.player?.block);
    const targets = estimate.attack_hp_loss_by_target
      || (Number.isFinite(estimate.attack_hp_loss) ? [{ target_id: request.target, hp_loss: estimate.attack_hp_loss }] : []);
    for (const { target_id, hp_loss } of targets) {
      const prior = before.combat?.enemies?.find(enemy => enemy.combat_id === target_id);
      const current = after.combat?.enemies?.find(enemy => enemy.combat_id === target_id);
      if (prior && current && Number.isFinite(hp_loss)) compare(`enemy_${target_id}_hp_removed`, Math.min(prior.hp, hp_loss), prior.hp - current.hp);
    }
  }
  return comparisons.length ? { source: 'harness_forecast_vs_native_observation',
    comparisons, mismatch: comparisons.some(item => !item.matches) } : null;
}
