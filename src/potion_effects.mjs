// Public rule semantics checked against native v0.111.0 Potion/Power classes.
// Amounts always come from the resolved live description, never the base Wiki
// amount. These describe dependencies, not simulated damage or a forced use.
const definitions = {
  STRENGTH_POTION: ['Strength', 'combat'],
  DEXTERITY_POTION: ['Dexterity', 'combat'],
  FLEX_POTION: ['Strength', 'turn'],
  SPEED_POTION: ['Dexterity', 'turn']
};

export function potionEffectFacts(potion) {
  const definition = definitions[potion?.id];
  if (!definition || !Number.isInteger(potion.slot) || potion.slot < 0) return null;
  const [stat, duration] = definition;
  const match = potion.description?.trim().match(new RegExp(`^Gain (\\d+) ${stat}${duration === 'turn' ? '(?: this turn)?' : ''}\\.(?:\\s|$)`));
  if (!match) return null;
  return {
    potion_id: potion.id, slot: potion.slot, power_id: `${stat.toUpperCase()}_POWER`, amount: Number(match[1]),
    duration, expires_at: duration === 'turn' ? 'owner_turn_end' : 'combat_end', can_be_changed_or_removed: true,
    affected_quantity: stat === 'Strength' ? 'powered_attack_damage' : 'powered_block_gain',
    application_unit: stat === 'Strength' ? 'each_damage_instance' : 'each_block_gain',
    applied_before_multipliers: true, affects_prior_actions: false, direct_damage: 0, direct_block: 0,
    requires_followup_actions: true, unpowered_effects_excluded: true,
    source: 'Native v0.111.0 rule; amount from the current resolved potion description. Reobserve actual values after use.'
  };
}

export function potionForRequest(player, request) {
  if (request?.cmd !== 'use_potion') return null;
  return (player?.potions || []).filter(p => p.id.toUpperCase() === request.id.toUpperCase())
    .sort((a, b) => a.slot - b.slot)[request.nth || 0] || null;
}
