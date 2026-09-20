// One identity registry for rule retrieval and model-facing joins. These names
// describe typed fields in native/canonical state, not card-specific strategy.
const containers = {
  master_deck: 'cards', cards: 'cards', card: 'cards', hand: 'cards', draw_pile: 'cards',
  discard_pile: 'cards', exhaust_pile: 'cards', play_pile: 'cards', card_choices: 'cards',
  selectable_cards: 'cards', deck_upgrade_previews: 'cards', relics: 'relics', potions: 'potions',
  powers: 'powers', enemies: 'monsters', orbs: 'orbs', modifiers: 'modifiers',
  enchantment: 'enchantments', affliction: 'afflictions', event: 'events', boss: 'encounters'
};
const references = {
  card_id: 'cards', relic_id: 'relics', potion_id: 'potions', event_id: 'events',
  monster_id: 'monsters', encounter_id: 'encounters', power_id: 'powers'
};

export const normalizeRuleId = value => String(value || '').replace(/_POWER$/, '').replace(/[^a-z0-9]/gi, '').toLowerCase();

/** Enumerate current identities, including typed IDs in offered choices.
 * History and glossary text are not retrieval roots; transitive rule closure
 * is handled separately. Missing IDs never become guessed current entities.
 */
export function visitRuleEntities(root, visitor) {
  const visit = (value, category, path) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach((item, i) => visit(item, category, `${path}[${i}]`)); return; }
    if (category && value.id) visitor({ category, id: value.id, path });
    // Older map providers may expose a name without an ID. Restrict that
    // fallback to its declared category, so equal monster/encounter names do
    // not make a visible encounter disappear or select the wrong category.
    if (category === 'encounters' && !value.id && value.name) visitor({ category, name: value.name, path });
    for (const [field, type] of Object.entries(references)) if (value[field]) visitor({ category: type, id: value[field], path: `${path}.${field}` });
    for (const [field, type] of [['enchantment', 'enchantments'], ['affliction', 'afflictions']]) {
      if (typeof value[field] === 'string') visitor({ category: type, id: value[field], path: `${path}.${field}` });
    }
    for (const keyword of value.keywords || []) visitor({ category: 'keywords', id: keyword, path: `${path}.keywords` });
    for (const [key, child] of Object.entries(value)) {
      if (['combat_history', 'history', 'glossary'].includes(key)) continue;
      visit(child, containers[key], path ? `${path}.${key}` : key);
    }
  };
  visit(root, null, '');
}
