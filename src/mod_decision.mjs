import { getJevApiKey } from './decision_jev.mjs';
import { validateModRequest } from './mod_client.mjs';

const API_URL = 'https://api.typesafe.ai/v1/systemone';
const integer = value => Number.isInteger(value) && value >= 0;
const hasId = value => typeof value === 'string' && value.length > 0;

// The server matches IDs case-insensitively and counts every copy, including
// currently unplayable copies. Hand index and nth are not interchangeable.
function indexedCopies(cards, idField) {
  const seenIndices = new Set();
  for (const card of cards) {
    if (!integer(card.index) || seenIndices.has(card.index)) throw new Error('Mod cards need unique nonnegative indices');
    if (!hasId(card[idField])) throw new Error('Mod card stable ID is missing');
    seenIndices.add(card.index);
  }
  const counts = new Map();
  return [...cards].sort((a, b) => a.index - b.index).map(card => {
    const key = card[idField].toUpperCase();
    const nth = counts.get(key) || 0;
    counts.set(key, nth + 1);
    return { card, nth };
  });
}

function combinations(items, size) {
  const result = [];
  const visit = (start, chosen) => {
    if (result.length > 255) throw new Error('Selection has more than 255 complete choices');
    if (chosen.length === size) { result.push(chosen); return; }
    for (let index = start; index < items.length; index++) visit(index + 1, [...chosen, items[index]]);
  };
  visit(0, []);
  return result;
}

/** Enumerate only actions supported by the current upstream state/Request DTO. */
export function buildModCandidates(state) {
  const candidates = new Map();
  if (!state || state.error || typeof state.screen !== 'string') return candidates;
  const add = (id, request, description, details = {}) => {
    validateModRequest(request);
    candidates.set(id, { action: 'mod_command', request, description, ...details });
  };
  switch (state.screen) {
    case 'MENU':
      if (state.menu?.has_run_save === true) add('continue_run', { cmd: 'continue_run' }, 'Continue the saved single-player run.');
      else if (state.menu?.has_run_save === false) add('new_run', { cmd: 'new_run' }, 'Start a new single-player run.');
      break;
    case 'SINGLEPLAYER_SUBMENU':
      if (state.singleplayer_submenu?.standard_available === true) add('standard', { cmd: 'choose_game_mode', id: 'standard' }, 'Choose standard single-player mode.');
      break;
    case 'CHARACTER_SELECT':
      for (const [index, character] of (state.character_select?.available_characters || []).entries()) {
        if (character.is_locked === false && character.is_selected !== true && hasId(character.character_id)) add(`character_${index}`, { cmd: 'select_character', id: character.character_id }, `Select ${character.character_name} (${character.character_id}).`);
      }
      if (state.character_select?.can_embark === true && hasId(state.character_select.selected_character)) add('embark', { cmd: 'embark' }, `Start the run as the already selected ${state.character_select.selected_character}.`);
      break;
    case 'MAP':
      for (const coordinate of state.map?.travelable_coords || []) {
        if (!integer(coordinate.col) || !integer(coordinate.row)) continue;
        const node = state.map.nodes?.find(item => item.col === coordinate.col && item.row === coordinate.row);
        add(`map_${coordinate.col}_${coordinate.row}`, { cmd: 'choose_map_node', args: [coordinate.col, coordinate.row] }, `Travel to reachable ${node?.type || 'unknown'} node at column ${coordinate.col}, row ${coordinate.row}.`);
      }
      break;
    case 'EVENT':
      if (state.event?.is_in_dialogue === true) add('advance_dialogue', { cmd: 'advance_dialogue', args: [1] }, 'Advance all current Ancient dialogue until choices appear.');
      else if (state.event?.is_finished === true) add('event_proceed', { cmd: 'choose_event', args: [0] }, 'Leave the finished event and open the map.');
      else for (const option of state.event?.options || []) {
        if (option.is_locked === false && integer(option.index)) add(`event_${option.index}`, { cmd: 'choose_event', args: [option.index] }, `${option.title}: ${option.description || ''}${option.is_proceed ? ' Proceed onward.' : ''}`);
      }
      break;
    case 'COMBAT': {
      const combat = state.combat;
      if (!combat || combat.is_player_turn !== true || combat.is_player_actions_disabled !== false || combat.is_combat_ending !== false || combat.player?.hp <= 0) break;
      const enemies = (combat.enemies || []).filter(enemy => enemy.is_alive === true && enemy.hp > 0 && integer(enemy.combat_id));
      for (const { card, nth } of indexedCopies(combat.hand || [], 'id')) {
        if (card.can_play !== true || !hasId(card.target_type)) continue;
        const request = { cmd: 'play_card', id: card.id, nth };
        const description = `Play hand index ${card.index}: ${card.name}; cost ${card.cost}; ${card.description || ''}; preview damage ${card.damage ?? 'unknown'}, block ${card.block ?? 'unknown'}.`;
        if (card.target_type === 'AnyEnemy') {
          for (const enemy of enemies) add(`card_${card.index}_target_${enemy.combat_id}`, { ...request, target: enemy.combat_id }, `${description} Target ${enemy.name}, combat_id ${enemy.combat_id}, HP ${enemy.hp}, block ${enemy.block}.`, { card_hand_index: card.index, target_combat_id: enemy.combat_id });
        } else {
          // ActionUtils.ResolveTarget defaults AnyAlly/AnyPlayer to the player;
          // Self/AllEnemies/None/etc. explicitly require omission of target.
          add(`card_${card.index}`, request, `${description} Target type ${card.target_type}; no explicit target.`, { card_hand_index: card.index });
          if (['AnyAlly', 'AnyPlayer'].includes(card.target_type)) {
            for (const pet of combat.player?.pets || []) if (pet.is_alive === true && integer(pet.combat_id)) add(`card_${card.index}_ally_${pet.combat_id}`, { ...request, target: pet.combat_id }, `${description} Target ally ${pet.name} (${pet.combat_id}).`, { card_hand_index: card.index, target_combat_id: pet.combat_id });
          }
        }
      }
      add('end_turn', { cmd: 'end_turn' }, 'End the player turn; enemies execute their displayed intents. Spend remaining energy usefully first.');
      break;
    }
    case 'HAND_SELECT': {
      const selection = state.hand_select;
      if (!selection) break;
      if (selection.can_confirm === true) add('hand_confirm', { cmd: 'hand_confirm_selection' }, `Confirm the ${selection.selected_count} currently selected cards.`);
      if (selection.selected_count < selection.max_select) for (const { card, nth } of indexedCopies(selection.selectable_cards || [], 'card_id')) {
        add(`hand_select_${card.index}`, { cmd: 'hand_select_card', card_ids: [card.card_id], nth_values: [nth] }, `${selection.prompt || 'Choose a hand card'}: ${card.card_name}; ${card.description || ''}`, { card_hand_index: card.index });
      }
      break;
    }
    case 'GRID_CARD_SELECT':
    case 'TRI_SELECT': {
      const grid = state.screen === 'GRID_CARD_SELECT';
      const selection = grid ? state.grid_card_select : state.tri_select;
      if (!selection) break;
      const command = grid ? 'grid_select_card' : 'tri_select_card';
      const copies = indexedCopies(selection.cards || [], 'card_id');
      const count = Math.max(1, selection.min_select);
      if (integer(count) && count <= selection.max_select) for (const [index, group] of combinations(copies, count).entries()) {
        add(`selection_${index}`, { cmd: command, card_ids: group.map(item => item.card.card_id), nth_values: group.map(item => item.nth) }, `${selection.prompt || selection.selection_type || 'Select cards'}: ${group.map(item => `${item.card.card_name}: ${item.card.description || ''}`).join('; ')}`);
      }
      if (grid ? selection.cancelable === true : selection.can_skip === true) add('skip_selection', { cmd: grid ? 'grid_select_skip' : 'tri_select_skip' }, 'Skip this optional card selection.');
      break;
    }
    case 'RELIC_SELECT':
      for (const relic of state.relic_select?.relics || []) if (integer(relic.index)) add(`relic_${relic.index}`, { cmd: 'relic_select', args: [relic.index] }, `Choose relic ${relic.name}: ${relic.description || ''}`);
      break;
    case 'REST_SITE':
      for (const option of state.rest_site?.options || []) if (option.is_enabled === true && hasId(option.option_id)) add(`rest_${option.option_id}`, { cmd: 'choose_rest_option', id: option.option_id }, `${option.name}: ${option.description || ''}`);
      if (state.rest_site?.can_proceed === true) add('proceed', { cmd: 'proceed' }, 'Leave the rest site and open the map.');
      break;
    case 'TREASURE':
      if (state.treasure?.is_chest_opened === false) add('open_chest', { cmd: 'open_chest' }, 'Open the treasure chest.');
      for (const relic of state.treasure?.relics || []) if (integer(relic.index)) add(`treasure_${relic.index}`, { cmd: 'pick_relic', args: [relic.index] }, `Take relic ${relic.name}: ${relic.description || ''}`);
      if (state.treasure?.can_proceed === true) add('proceed', { cmd: 'proceed' }, 'Leave the treasure room and open the map.');
      break;
    case 'SHOP':
      if (state.shop?.can_proceed === true) add('proceed', { cmd: 'proceed' }, 'Leave the shop and progress toward the first combat.');
      break;
    // Reward and game-over screens are acceptance checkpoints, not new actions.
  }
  if (candidates.size > 255) throw new Error('Jev supports at most 255 complete mod action candidates');
  return candidates;
}

export async function makeModDecisionWithJev(gameState, options = {}) {
  const candidates = buildModCandidates(gameState);
  if (!candidates.size) return { action: 'wait', reason: `No complete supported action in ${gameState?.screen || 'unknown'}` };
  const apiKey = options.apiKey ?? getJevApiKey();
  if (!apiKey) throw new Error('TYPESAFE_API_KEY not found');
  const payload = {
    model: options.model || 'jev-latest',
    state: { game_state: gameState, recent_actions: options.recentActions || [] },
    questions: { next_action: {
      type: 'choice',
      instructions: 'Choose one complete valid next action to win the first combat in Slay the Spire 2. Prefer continuing an existing run; otherwise start a standard single-player Ironclad run, and embark once Ironclad is selected. On the map prefer a reachable normal MONSTER room over elites or diversions. Resolve required Ancient dialogue and event choices to progress. In combat choose the exact hand card and target together; use authoritative descriptions, damage previews, energy, enemy HP/block, powers and intents (intent damage is per hit). Eliminate enemies to prevent their attacks and play useful affordable cards before ending the turn. Choose block when needed to preserve HP. For selection prompts select according to the stated discard/exhaust/upgrade purpose. Recent actions and their actual results are evidence; do not repeat an action that is no longer valid. Choose only an offered candidate; code will execute its exact request.',
      criteria: Object.fromEntries([...candidates].map(([id, candidate]) => [id, candidate.description]))
    } }
  };
  const started = performance.now();
  const response = await (options.fetchImpl || globalThis.fetch)(API_URL, {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(options.timeoutMs ?? 30000)
  });
  if (!response.ok) throw new Error(`Jev API error ${response.status}`);
  const result = await response.json();
  const answer = result.answers?.next_action;
  if (answer?.type !== 'choice' || typeof answer.choice !== 'string' || !candidates.has(answer.choice)) throw new Error('Jev returned an invalid mod action choice');
  return { ...candidates.get(answer.choice), candidate_id: answer.choice, model: result.model, probabilities: answer.probabilities, confidence: answer.confidence, usage: result.usage, durationMs: Math.round(performance.now() - started) };
}
