const sideOf = enemy => enemy.powers?.some(power => power.id === 'BACK_ATTACK_LEFT_POWER') ? 'Left'
  : enemy.powers?.some(power => power.id === 'BACK_ATTACK_RIGHT_POWER') ? 'Right' : 'None';

export function positioningError(combat) {
  const active = combat.player?.powers?.some(power => power.id === 'SURROUNDED_POWER');
  const position = combat.positioning;
  if (!active) return position ? 'Positioning exists without the Surrounded power' : null;
  if (!position || !['Left', 'Right'].includes(position.facing)) return 'Surrounded requires an observed player facing from context.17 or newer';
  if (position.back_attack_multiplier !== 1.5 || position.intents_include_current_facing !== true) return 'Incorrect native positioning preview contract';
  if (!Array.isArray(position.enemies) || position.enemies.length !== combat.enemies.length) return 'Incomplete positioning enemy list';
  const ids = new Set();
  for (const entry of position.enemies) {
    const enemy = combat.enemies.find(enemy => enemy.combat_id === entry.combat_id);
    if (!enemy || ids.has(entry.combat_id) || entry.side !== sideOf(enemy)
      || entry.attacking_from_behind !== (entry.side !== 'None' && entry.side !== position.facing)) return 'Positioning contradicts visible enemy powers or player facing';
    ids.add(entry.combat_id);
  }
  return null;
}

// Surrounded updates before any explicitly targeted card/potion, including
// Skills. No attack/HP simulation and no edits to the observed native snapshot.
export function projectPositioning(combat, steps = [], depleted = new Set()) {
  const position = combat.positioning;
  if (!position) return null;
  let facing = position.facing;
  for (const step of steps) {
    if (step.kind === 'end_turn') break;
    if (!['play_card', 'use_potion'].includes(step.kind)) continue;
    const side = position.enemies.find(enemy => enemy.combat_id === step.target)?.side;
    if (['Left', 'Right'].includes(side)) facing = side;
  }
  const remaining = position.enemies.filter(entry => !depleted.has(entry.combat_id)
    && combat.enemies.some(enemy => enemy.combat_id === entry.combat_id && enemy.is_alive && enemy.hp > 0));
  // Conditional death effect only; depleted HP does not prove death when an
  // unmodelled prevention/revival power applies.
  if (depleted.size && remaining.length && remaining.every(entry => entry.side !== 'None' && entry.side === remaining[0].side)) facing = remaining[0].side;
  return {
    is_observed: false, observed_facing: position.facing, facing_after_sequence: facing,
    current_intents_still_applicable: facing === position.facing,
    enemies_after_sequence: remaining.map(entry => ({ combat_id: entry.combat_id, side: entry.side,
      attacking_from_behind: entry.side !== 'None' && entry.side !== facing,
      facing_damage_multiplier: entry.side !== 'None' && entry.side !== facing ? position.back_attack_multiplier : 1 })),
    scope: 'Conditional on the listed actions resolving, unchanged side powers and any depleted enemies dying without prevention/revival. Multipliers describe facing only; current intent damage already includes observed facing. Exact damage after changing facing is not recomputed.'
  };
}
