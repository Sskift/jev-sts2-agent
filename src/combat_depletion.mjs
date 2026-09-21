// Native v0.111.0 ReattachPower.AfterDeath / DoReattach and the segment move
// graph: depletion replaces the current move with DEAD, then REATTACH. The
// group cannot revive after every owner is dead. No internal revive flag is read.
export const reattachPower = enemy => /^DECIMILLIPEDE_SEGMENT_(FRONT|MIDDLE|BACK)$/.test(enemy.id || '')
  ? (enemy.powers || []).find(power => power.id === 'REATTACH_POWER') : undefined;

export const uncomputedDepletionRules = enemy => (enemy.powers || []).filter(power =>
  !['ILLUSION_POWER', 'MINION_POWER'].includes(power.id)
  && !(power.id === 'REATTACH_POWER' && reattachPower(enemy))
  && (['ADAPTABLE_POWER', 'REATTACH_POWER'].includes(power.id)
    || /reviv|resurrect|(?:when|upon|on)[^.]*\b(?:death|dies?|defeated)\b/i.test(power.description || '')));

export function describeReattachProgress(combat, enemy, remaining, unknownTargets = []) {
  const power = reattachPower(enemy);
  if (!power) return null;
  const group = combat.enemies.filter(member => member.powers?.some(p => p.id === 'REATTACH_POWER'));
  const down = group.map(member => {
    const after = remaining.find(result => result.combat_id === member.combat_id);
    if (!reattachPower(member) || unknownTargets.includes(member.combat_id) || uncomputedDepletionRules(member).length || !Number.isFinite(after?.hp)) return null;
    return after.hp <= 0;
  });
  const allDown = down.includes(false) ? false : down.includes(null) ? null : true;
  return { current_intent_canceled_if_depleted: true,
    enemy_turns_until_revive_after_new_depletion: 2,
    revive_hp_before_other_modifiers: Number.isFinite(power.amount) ? power.amount : null,
    all_segments_down_after_declared_actions: allDown,
    revival_prevented_by_group_depletion: allDown,
    scope: 'Conditional on the declared hits resolving. A newly depleted segment loses its current attack and cannot be hit while reviving. Existing downed segments may already be closer to revival; use their visible intent. If all Reattach owners are down before a revival, the group stays defeated. Otherwise a surviving segment permits revival; future random attacks and healing modifiers are not simulated.' };
}
