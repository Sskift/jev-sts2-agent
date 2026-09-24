import { lookupRule } from './rule_reference.mjs';

// Explicit v0.111.0 rules, checked against the pinned Wiki and native hooks.
// This is dependency classification, not execution of arbitrary Wiki prose.
const normalized = text => String(text || '').replace(/\[energy:(\d+)\]/g, '$1 Energy')
  .replace(/\[\/?(?:gold|blue|red|green|orange|purple|grey|gray|pink|b|i)\]/g, '').replace(/\s+/g, ' ').trim();
const scopes = {
  'relics/POMANDER': ['on_pickup', 'The upgrade already exists in the observed deck; possession adds no combat trigger.'],
  'relics/NUTRITIOUS_SOUP': ['on_pickup', 'The acquisition enchants Strikes. Inspect their actual enchantments separately; the relic does not repeat its pickup effect in combat.'],
  'relics/PRAYER_WHEEL': ['reward_generation', 'Changes post-combat card rewards, not current damage or Block.'],
  'relics/LEAD_PAPERWEIGHT': ['on_pickup', 'The chosen Colorless card is already in the observed deck. The relic has no combat hooks; inspect the chosen card independently.'],
  'relics/WAR_PAINT': ['on_pickup', 'The selected Skill upgrades already exist in native card records. Possession does not upgrade cards again during combat.'],
  'relics/AMETHYST_AUBERGINE': ['reward_generation', 'Adds Gold to qualifying post-combat rewards; no damage or Block hook.'],
  'relics/BAG_OF_MARBLES': ['before_owner_first_turn', 'This hook precedes the first player action phase. Current enemy powers and target damage already reflect its resolved application or prevention. Do not apply Vulnerable again or assume it persists.'],
  'enchantments/SLITHER': ['after_owner_card_drawn', 'Current native cost already contains this draw result. A later draw randomizes it again and requires a new observation; no future cost is inferred.'],
  'afflictions/ENTANGLED': ['native_cost_query', 'Tangled owns the cost modifier; this affliction has no independent trigger. Current native cost already includes the surcharge. Do not add it again.']
};

export function reviewedEffectScope(category, entity, { owner = 'player', playedCards } = {}) {
  const rule = lookupRule(category, entity.id);
  if (!rule) return null;
  const key = `${category}/${rule.id}`;
  if (key === 'enchantments/SHARP') {
    const match = normalized(entity.description).match(/^Increases damage on this card by (\d+(?:\.\d+)?)\.$/);
    if (!match || Number(match[1]) !== entity.amount) return null;
    return { wiki_rule_id: key, trigger: 'native_powered_attack_preview', affected_outputs: [],
      interpretation: 'Sharp adds its amount through the native powered-Attack damage hook. Current target previews already include it; it has no separate play/draw/end-turn trigger. Do not add its amount again.' };
  }
  if (key === 'powers/TERRITORIAL' && owner !== 'player') {
    const match = normalized(entity.description).match(/^At the end of .+ turn, it gains (\d+) Strength\.$/);
    if (!match || Number(match[1]) !== entity.amount) return null;
    return { wiki_rule_id: key, trigger: 'owner_side_turn_end', affected_outputs: [],
      interpretation: 'Strength is gained after this enemy turn, not before its currently displayed attack. This does not predict next-turn damage or retain the current intent for later turns.' };
  }
  if (!entity.description || normalized(entity.description) !== normalized(rule.description)) return null;
  if (key === 'relics/PERMAFROST') {
    const canTrigger = !playedCards || playedCards.some(card => card.type === 'Power');
    return { wiki_rule_id: key, trigger: 'after_first_owned_power_play_in_combat',
      affected_outputs: canTrigger ? ['player_block', 'player_hp'] : [],
      interpretation: canTrigger ? 'Grants unpowered Block only on the first Power play. The private activation flag is not exported; possession/status alone cannot establish the grant. Enemy damage previews are independent of this missing flag.'
        : 'No Power is played in this prefix; this relic cannot change its Block or HP. Its one-use activation flag is not inferred.' };
  }
  const scope = scopes[key];
  return scope ? { wiki_rule_id: key, trigger: scope[0], affected_outputs: [], interpretation: scope[1] } : null;
}

// Current engine previews already resolve these calculations. Coefficients
// below come from the live rule, never Wiki example damage/Block values.
export function strengthBlockCoefficient(card) {
  const match = card?.id === 'EXPECT_A_FIGHT' && normalized(card.description)
    .match(/^Gain [\d.]+ Block\. Gains (\d+) additional Block for each Strength you have\.$/);
  return match ? Number(match[1]) : null;
}

export function supportedNativePreviewRule(card) {
  const text = normalized(card?.description);
  if (strengthBlockCoefficient(card) !== null) return Number.isFinite(card.block);
  if (card?.id === 'PERFECTED_STRIKE') return /^Deal [\d.]+ damage\. Deals \d+ additional damage for ALL your cards containing [“"]Strike[”"]\.$/.test(text);
  if (card?.id === 'IRON_WAVE') return Number.isFinite(card.block) && /^Gain [\d.]+ Block\. Deal [\d.]+ damage\.$/.test(text);
  if (card?.id === 'STOMP') return /^Deal [\d.]+ damage to ALL enemies\. Costs 1 less 1 Energy for each Attack played this turn\.$/.test(text);
  if (card?.id === 'BASH') return /^Deal [\d.]+ damage\. Apply \d+ Vulnerable\.$/.test(text);
  return false;
}
