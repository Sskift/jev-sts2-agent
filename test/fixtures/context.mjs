// Synthetic mod-contract fixtures. These are not evidence of a live game run.
export const fixtureCard = (id = 'STRIKE_IRONCLAD', extra = {}) => ({
  id, name: 'Strike', description: 'Deal 6 damage.', type: 'Attack', rarity: 'Basic', cost: 1,
  keywords: [], is_upgraded: false, details: { instance_id: id, upgrade_level: 0, target_type: 'AnyEnemy' }, ...extra
});

export function withContext(source, overrides = {}) {
  const state = structuredClone(source);
  const deck = overrides.master_deck || [fixtureCard()];
  const player = { character_id: 'IRONCLAD', hp: 70, max_hp: 80, gold: 90, deck_count: deck.length, relics: [], potions: [], powers: [], ...state.combat?.player };
  if (state.combat) {
    state.combat.enemies = state.combat.enemies.map(enemy => ({ powers: [], intents: [], ...enemy }));
    for (const [pile, count] of [['hand', 'hand_count'], ['draw_pile', 'draw_count'], ['discard_pile', 'discard_count'], ['exhaust_pile', 'exhaust_count']]) {
      state.combat[pile] = (state.combat[pile] || []).map(card => fixtureCard(card.id, card));
      player[count] = state.combat[pile].length;
    }
    state.combat.player = structuredClone(player);
  }
  state.decision_context = {
    schema_version: 1, run_id: 'offline-run', combat_id: state.combat ? 'offline-combat' : null,
    act_index: 0, act_floor: 1, total_floor: 1, ascension: 0, game_mode: 'Standard', modifiers: [],
    player, potion_capacity: 3, master_deck: deck,
    map: { act_index: 0, current_coord: { col: 0, row: 0 }, nodes: [
      { col: 0, row: 0, type: 'MONSTER', children: [{ col: 0, row: 1 }] },
      { col: 0, row: 1, type: 'BOSS', children: [] }
    ], visited: [], boss: { id: 'OFFLINE_BOSS', name: 'Fixture boss' } },
    combat_history: state.combat ? [] : null, play_pile: state.combat ? [] : null,
    history_coverage: 'Synthetic fixture combat history', glossary: [], extraction_errors: [], ...overrides
  };
  return state;
}

export function completeCombat() {
  return withContext({ screen: 'COMBAT', timestamp: 1000, combat: {
    encounter: 'OFFLINE_ENCOUNTER', turn_number: 2,
    is_player_turn: true, is_player_actions_disabled: false, is_combat_ending: false,
    player: { hp: 40, max_hp: 80, gold: 100, energy: 2, block: 0 },
    hand: [fixtureCard('STRIKE_IRONCLAD', { index: 0, can_play: true, target_type: 'AnyEnemy', damage: 6 })],
    draw_pile: [fixtureCard('DEFEND_IRONCLAD', { name: 'Defend', description: 'Gain 5 Block.', type: 'Skill' })],
    discard_pile: [fixtureCard('BASH', { name: 'Bash', description: 'Deal 8 damage. Apply 2 Vulnerable.', cost: 2 })],
    exhaust_pile: [fixtureCard('BURNING_PACT', { name: 'Burning Pact', description: 'Exhaust 1 card. Draw 2 cards.', type: 'Skill' })],
    enemies: [{ combat_id: 42, id: 'OFFLINE_ENEMY', name: 'Fixture enemy', hp: 12, block: 0, is_alive: true, powers: [], move_id: 'INTERNAL_HIDDEN_MOVE', intents: [{ type: 'Attack', damage: 6, hits: 2, description: 'Attack for 6 damage twice.' }] }]
  } });
}
