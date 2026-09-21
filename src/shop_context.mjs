// Merchant removal uses CardSelectCmd.FromDeckForRemoval -> CardModel.IsRemovable
// in v0.111.0: Eternal cards cannot be removed. The actual modal remains authoritative.
export const removableCard = card => Array.isArray(card.keywords)
  ? !card.keywords.some(keyword => String(keyword).toLowerCase() === 'eternal') : null;

export function shopEconomy(state, groups, candidates) {
  const shop = state.shop, size = state.decision_context.master_deck.length;
  const service = shop.card_removal;
  const offered = Boolean(service && !service.is_used);
  const affordable = offered && service.cost <= shop.player_gold;
  const targets = groups.flatMap((group, deck_group_index) => removableCard(group.card) === true
    ? [{ deck_group_index, copies_before: group.count, copies_after_removing_one: group.count - 1 }] : []);
  const transactions = [...candidates].flatMap(([action_id, candidate]) => {
    const kind = candidate.request?.cmd?.match(/^shop_buy_(card|relic|potion)$/)?.[1];
    if (!kind) return [];
    const item = shop[`${kind}s`].find(item => `buy_${kind}_${item.index}` === action_id);
    if (!item) return [];
    const left = shop.player_gold - item.cost;
    return [{ action_id, cost: item.cost, gold_after: left, deck_count_after: size + Number(kind === 'card'),
      ...(kind === 'card' ? { owned_copies_of_card_id: groups.filter(g => g.card.id === item.card_id).reduce((n, g) => n + g.count, 0) } : {}),
      ...(offered ? { removal_cost: service.cost, can_also_afford_removal: left >= service.cost,
        forecloses_affordable_removal: affordable && candidates.has('remove_card') && left < service.cost,
        gold_after_purchase_and_removal: left >= service.cost ? left - service.cost : null } : {}) }];
  });
  return { gold: shop.player_gold, deck_count: size,
    removal: { offered, affordable, action_available: candidates.has('remove_card'), cost: service?.cost ?? null,
      gold_after: affordable ? shop.player_gold - service.cost : null,
      deck_count_after: Math.max(0, size - 1), targets,
      eligibility_unknown_groups: groups.flatMap((g, deck_group_index) => removableCard(g.card) === null ? [{ deck_group_index }] : []),
      scope: 'Remove ONE copy permanently; target references resolve in deck.cards, including actual upgrades, enchantments and full rules. Eternal is excluded under native v0.111.0 rules. Current modal determines final eligibility. Prices are live, not a fixed 75-gold assumption.' },
    transactions,
    draw_access_example: { sample_size: 5, tracked_retained_copies: 1,
      chance_to_see_one_retained_copy: { keep_deck: size ? Math.min(5, size) / size : null,
        remove_a_different_card: size > 1 ? Math.min(5, size - 1) / (size - 1) : null,
        add_a_different_card: size ? Math.min(5, size + 1) / (size + 1) : null },
      scope: 'Illustration: uniformly sample up to five cards without replacement from the permanent deck. Track one specific retained copy. Not a prediction of the starting hand or current combat: excludes Innate, generated cards, draw effects, exhaust, ordering and shuffle changes. Removal also loses the removed card and its synergies; additions can themselves supply needed output or draw.' },
    scope: 'Affordability at displayed prices, excluding purchase/removal hooks that may change gold, stock or effects. Reobserve after each action. Affordable bundles are alternatives, not recommendations; keeping gold and leaving remain choices.' };
}
