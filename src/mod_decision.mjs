import { decisionInstructions } from "./decision_instructions.mjs";
import { getJevModel, requestJev, JEV_REQUEST_BUDGET } from './jev_client.mjs';
import { compileModelRequest } from './context_compiler.mjs';
import { refreshRunStrategy } from './run_strategy.mjs';
import { validateModRequest } from './mod_client.mjs';
import { buildDecisionContext, ContextError, compactDecisionRequest, validateDecisionPacket, cardRewardKey, presentCurrentRecords } from './decision_context.mjs';
import { potionEffectFacts, potionForRequest } from './potion_effects.mjs';
import { combatForecast, firstHitHpLoss, attackHpLoss, previewDamageSum } from './combat_arithmetic.mjs';
import { selectionStage, assembleSelection } from './mod_selection.mjs';
import { needsStrategyAssessment, prepareStrategyAssessment, parseStrategyAssessment } from './strategy_assessment.mjs';
import { decideTurn } from './turn_plan.mjs';
import { plannedUpgradeSelection } from './turn_plan_state.mjs';
import { decideCamp } from './camp_plan.mjs';
import { plannedCampSelection } from './camp_plan_state.mjs';

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

function combinations(items, size, limit = 255) {
  const result = [];
  const visit = (start, chosen) => {
    if (result.length > limit) return;
    if (chosen.length === size) { result.push(chosen); return; }
    for (let index = start; index <= items.length - (size - chosen.length) && result.length <= limit; index++) visit(index + 1, [...chosen, items[index]]);
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
    case 'GAME_OVER':
      if (state.game_over?.can_continue) add('game_over_continue', { cmd: 'game_over_continue' }, 'Continue the formal result and unlock summary.');
      break;
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
      else if (state.event?.is_finished === true) add('event_proceed', { cmd: 'proceed' }, 'Leave the finished event and open the map.');
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
        const description = `Play ${card.name}, hand ${card.index}, cost ${card.cost < 0 ? `X (current energy ${combat.player.energy})` : card.cost}.`;
        if (card.target_type === 'AnyEnemy') {
          for (const enemy of enemies) if (!Array.isArray(card.valid_target_ids) || card.valid_target_ids.includes(enemy.combat_id)) {
            const preview = card.target_previews?.find(p => p.target_id === enemy.combat_id);
            const effect = `${description}${Number.isFinite(preview?.damage) ? ` Deal ${preview.damage} damage per hit.` : ''}`;
            const hit = firstHitHpLoss(card, enemy);
            const lethal = hit && hit.hp_loss >= enemy.hp ? ' First hit depletes target HP.' : '';
            const revival = enemy.powers?.some(power => power.id === 'ILLUSION_POWER' && power.amount > 0);
            const deathRule = revival ? ' Illusion: revives next turn at full HP; a knockdown only provides temporary relief.' : enemy.is_minion ? ' Minion: abandons combat when its leader dies.' : enemies.some(other => other.is_minion) && enemies.filter(other => !other.is_minion).length === 1 ? ' Last non-minion: defeating this leader makes its minions abandon combat.' : '';
            add(`card_${card.index}_target_${enemy.combat_id}`, { ...request, target: enemy.combat_id }, `${effect} Target ${enemy.name} #${enemy.combat_id}.${lethal}${deathRule}`, { card_hand_index: card.index, target_combat_id: enemy.combat_id });
          }
        } else if (['AnyAlly', 'AnyPlayer'].includes(card.target_type) && Array.isArray(card.valid_target_ids)) {
          for (const target of card.valid_target_ids) if (integer(target)) {
            const pet = combat.player?.pets?.find(p => p.combat_id === target);
            add(`card_${card.index}_ally_${target}`, { ...request, target }, `${description} Target ${pet?.name || 'the local player'}, combat_id ${target}.`, { card_hand_index: card.index, target_combat_id: target });
          }
        } else {
          // ActionUtils.ResolveTarget defaults AnyAlly/AnyPlayer to the player;
          // Self/AllEnemies/None/etc. explicitly require omission of target.
          add(`card_${card.index}`, request, `${description} ${card.target_type}.`, { card_hand_index: card.index });
          if (['AnyAlly', 'AnyPlayer'].includes(card.target_type)) {
            for (const pet of combat.player?.pets || []) if (pet.is_alive === true && integer(pet.combat_id) && (!Array.isArray(card.valid_target_ids) || card.valid_target_ids.includes(pet.combat_id))) add(`card_${card.index}_ally_${pet.combat_id}`, { ...request, target: pet.combat_id }, `${description} Target ally ${pet.name} (${pet.combat_id}).`, { card_hand_index: card.index, target_combat_id: pet.combat_id });
          }
        }
      }
      const potions = (combat.player?.potions || []).map(potion => ({ ...potion, index: potion.slot }));
      for (const { card: potion, nth } of indexedCopies(potions, 'id')) {
        if (potion.can_use !== true) continue;
        const request = { cmd: 'use_potion', id: potion.id, nth };
        const description = `Use potion in slot ${potion.slot}: ${potion.name}; ${potion.description}. Consumes this potion.`;
        if (['AnyEnemy', 'AnyAlly', 'AnyPlayer'].includes(potion.target_type)) {
          for (const target of potion.valid_target_ids || []) if (integer(target)) add(`potion_${potion.slot}_target_${target}`, { ...request, target }, `${description} Target combat_id ${target}.`);
        } else if (['Self', 'AllEnemies', 'None', 'RandomEnemy', 'AllAllies', 'AllPlayers'].includes(potion.target_type)) {
          add(`potion_${potion.slot}`, request, description);
        }
      }
      const incoming = enemies.flatMap(e => e.intents || []).reduce((n, i) => n + (Number.isFinite(i.damage) ? i.damage * (i.hits || 1) : 0), 0);
      add('end_turn', { cmd: 'end_turn' }, `End turn: ${combat.player.energy} unused energy, ${combat.player.block} Block, ${incoming} incoming attack damage. Spend resources on useful actions first.`);
      break;
    }
    case 'HAND_SELECT': {
      const selection = state.hand_select;
      if (!selection) break;
      if (selection.can_confirm === true) add('hand_confirm', { cmd: 'hand_confirm_selection' }, `Confirm the ${selection.selected_count} currently selected cards.`);
      if (selection.selected_count < selection.max_select) for (const { card, nth } of indexedCopies(selection.selectable_cards || [], 'card_id')) {
        add(`hand_select_${card.index}`, { cmd: 'hand_select_card', card_ids: [card.card_id], nth_values: [nth] }, `${selection.prompt || 'Choose a hand card'}: ${card.card_name}, cost ${card.cost < 0 ? 'X' : card.cost}; ${card.description || ''}`, { card_hand_index: card.index });
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
      const min = Math.max(1, selection.min_select), max = Math.min(copies.length, selection.max_select);
      const groups = [];
      if (integer(min) && integer(max)) for (let count = min; count <= max && groups.length <= 254; count++) groups.push(...combinations(copies, count, 254 - groups.length));
      if (groups.length > 254) {
        candidates.selectionPlan = { command, copies, min, max, canSkip: grid ? selection.cancelable === true : selection.can_skip === true, skipCommand: grid ? 'grid_select_skip' : 'tri_select_skip' };
        break;
      }
      for (const [index, group] of groups.entries()) {
        add(`selection_${index}`, { cmd: command, card_ids: group.map(item => item.card.card_id), nth_values: group.map(item => item.nth) }, `${selection.prompt || selection.selection_type || 'Select cards'}: ${group.map(item => `${item.card.card_name}: ${item.card.description || ''}${item.card.upgrade_preview ? ` Upgrade: ${item.card.upgrade_preview}; upgraded energy cost ${item.card.upgrade_preview_cost ?? 'unknown'}.` : ''}`).join('; ')}`);
      }
      if (grid ? selection.cancelable === true : selection.can_skip === true) add('skip_selection', { cmd: grid ? 'grid_select_skip' : 'tri_select_skip' }, 'Skip this optional card selection.');
      break;
    }
    case 'RELIC_SELECT':
      for (const relic of state.relic_select?.relics || []) if (integer(relic.index)) add(`relic_${relic.index}`, { cmd: 'relic_select', args: [relic.index] }, `Choose relic ${relic.name}: ${relic.description || ''}`);
      if (state.relic_select?.can_skip === true) add('relic_skip', { cmd: 'relic_skip' }, 'Skip this relic selection.');
      break;
    case 'REST_SITE':
      for (const option of state.rest_site?.options || []) if (option.is_enabled === true && hasId(option.option_id)) {
        const player = state.decision_context?.player;
        const missingHp = player ? Math.max(0, player.max_hp - player.hp) : null;
        const health = option.option_id === 'HEAL' && missingHp !== null ? ` Current HP ${player.hp}/${player.max_hp}: healing can restore at most ${missingHp} HP before reaching the maximum. Check any additional rest-triggered effects.` : '';
        const upgrade = option.option_id === 'SMITH' ? ' Permanently improve a card for every remaining fight; choose the card next. Compare actual outcomes in screen_state.rest_site.deck_upgrade_previews when supplied; instance_id matches the current deck copy.' : '';
        add(`rest_${option.option_id}`, { cmd: 'choose_rest_option', id: option.option_id }, `${option.name}: ${option.description || ''}${health}${upgrade}`);
      }
      if (state.rest_site?.can_proceed === true) add('proceed', { cmd: 'proceed' }, 'Leave the rest site and open the map.');
      break;
    case 'TREASURE':
      if (state.treasure?.is_chest_opened === false) add('open_chest', { cmd: 'open_chest' }, 'Open the treasure chest.');
      for (const relic of state.treasure?.relics || []) if (integer(relic.index)) add(`treasure_${relic.index}`, { cmd: 'pick_relic', args: [relic.index] }, `Take relic ${relic.name}: ${relic.description || ''}`);
      if (state.treasure?.can_proceed === true) add('proceed', { cmd: 'proceed' }, 'Leave the treasure room and open the map.');
      break;
    case 'SHOP': {
      const shop = state.shop;
      if (!shop) break;
      for (const [kind, field] of [['card', 'cards'], ['relic', 'relics'], ['potion', 'potions']]) {
        for (const { card: item, nth } of indexedCopies((shop[field] || []).filter(item => hasId(item[`${kind}_id`]) || item.is_stocked), `${kind}_id`)) {
          if (!item.is_stocked || item.cost > shop.player_gold) continue;
          if (kind === 'potion' && state.decision_context?.player.potions.length >= state.decision_context?.potion_capacity) continue;
          add(`buy_${kind}_${item.index}`, { cmd: `shop_buy_${kind}`, id: item[`${kind}_id`], nth }, `Buy ${item[`${kind}_name`]} for ${item.cost} gold (${shop.player_gold - item.cost} gold left). ${kind === 'card' ? `Card energy cost ${item.energy_cost}. ` : ''}${item.description}`);
        }
      }
      if (shop.card_removal && !shop.card_removal.is_used && shop.card_removal.cost <= shop.player_gold) add('remove_card', { cmd: 'shop_remove_card' }, `Pay ${shop.card_removal.cost} gold to remove a card; choose the card on the next screen.`);
      if (shop.can_proceed === true) add('proceed', { cmd: 'proceed' }, `Leave this shop without further purchases; its stock will no longer be accessible. Carry ${shop.player_gold} gold onward.`);
      break;
    }
    case 'REWARD':
    case 'CARD_REWARD': {
      const counts = new Map();
      for (const reward of state.rewards?.rewards || []) {
        const type = reward.type === 'SpecialCard' ? 'special_card' : reward.type.toLowerCase();
        const nth = counts.get(type) || 0;
        counts.set(type, nth + 1);
        if (type === 'card') {
          for (const card of reward.card_choices || []) add(`reward_${reward.index}_card_${card.index}`, { cmd: 'reward_choose_card', reward_type: 'card', nth, card_id: card.id }, `Add ${card.name} (${card.id}) to the permanent deck: ${card.description}. Energy cost ${card.cost}. Other rewards remain available.`);
          if (state.rewards.can_skip !== false) add(`skip_card_${nth}`, { cmd: 'reward_skip_card', reward_type: 'card', nth }, 'Decline this card reward for now; add no card. Other rewards remain available.');
        } else if (['gold', 'relic', 'potion', 'special_card', 'cardremoval'].includes(type)) {
          if (type === 'potion' && state.decision_context?.player.potions.length >= state.decision_context?.potion_capacity) continue;
          add(`claim_${reward.index}`, { cmd: 'reward_claim', reward_type: type, nth }, `Claim ${reward.description}. ${reward.relic_description || reward.potion_description || reward.card_description || ''}${type === 'gold' ? ' Collect this gold reward without adding a card; other rewards remain available.' : ''}`);
        }
      }
      if (state.screen === 'REWARD' && (state.rewards?.can_skip === true || state.rewards?.rewards.length === 0)) add('proceed', { cmd: 'proceed' }, 'Leave rewards and continue the run; remaining rewards are forfeited.');
      break;
    }
    case 'BUNDLE_SELECT': {
      const selection = state.bundle_select;
      if (!selection?.preview_showing) for (const bundle of selection?.bundles || []) add(`bundle_${bundle.index}`, { cmd: 'bundle_select', args: [bundle.index] }, `Preview bundle ${bundle.index}: ${bundle.cards.map(c => `${c.card_name}: ${c.description}`).join('; ')}`);
      if (selection?.can_confirm) add('bundle_confirm', { cmd: 'bundle_confirm' }, 'Accept the currently previewed bundle.');
      if (selection?.can_cancel) add('bundle_cancel', { cmd: 'bundle_cancel' }, 'Return to the bundle choices.');
      break;
    }
    case 'CRYSTAL_SPHERE': {
      const crystal = state.crystal_sphere;
      for (const tool of ['big', 'small']) if (crystal?.[`can_use_${tool}_tool`] && crystal.tool !== tool) add(`tool_${tool}`, { cmd: 'crystal_set_tool', id: tool }, `Switch to the ${tool} divination tool.`);
      if (crystal?.divinations_left > 0) for (const cell of crystal.clickable_cells || []) add(`cell_${cell.x}_${cell.y}`, { cmd: 'crystal_click_cell', args: [cell.x, cell.y] }, `Use the current ${crystal.tool} tool at column ${cell.x}, row ${cell.y}; hidden contents are unknown.`);
      if (crystal?.can_proceed) add('crystal_proceed', { cmd: 'crystal_proceed' }, 'Finish divination and collect revealed results.');
      break;
    }
  }
  if (state.screen === 'COMBAT' && state.combat?.is_player_turn) {
    for (const action of candidates.values()) {
      const card = state.combat.hand.find(c => c.index === action.card_hand_index);
      if (!card && action.request.cmd !== 'end_turn') continue;
      const target = state.combat.enemies.find(e => e.combat_id === action.target_combat_id);
      const estimate = combatForecast(state.combat, card, target);
      action.combat_estimate = estimate;
      const observedDescription = action.description;
      const unknownBlock = estimate.block_preview?.amount === null;
      action.description += ` End-now HP ${estimate.hp_remaining_if_end_turn ?? 'unknown'}${estimate.fatal_if_end_turn && !unknownBlock ? ' (FATAL)' : ''}; energy after printed cost ${estimate.energy_after_printed_cost} (gains excluded).`;
      if (estimate.incoming_attack_preview_valid === false) action.description += ` Facing changes to ${estimate.positioning.facing_after_sequence}; current enemy intent damage is stale for this outcome. Do not reuse it as the final incoming damage.`;
      if (unknownBlock) action.description += ' Block contribution is UNKNOWN, not zero: this HP number omits that effect and cannot establish fatality. Evaluate the complete live rule.';
      else if (estimate.block_preview) action.description += ` Immediate Block ${estimate.block_preview.amount} from the resolved live first sentence; its native numeric preview is absent.`;
      if (estimate.active_rage_block_gain) action.description += ` Active Rage adds ${estimate.active_rage_block_gain} Block for playing this Attack (once per card, already included in the estimate).`;
      if (estimate.end_turn_block_gains.length) action.description += ` Automatic turn-end Block: ${estimate.end_turn_block_gains.map(gain => `${gain.source_id} +${gain.amount}`).join(', ')}; included once in end-now HP, not immediate Block.`;
      if (card?.cost < 0 && !card.attack_preview) action.description += ' X-cost: per-hit damage does not guarantee a hit. Without a known hit count this estimate assumes no attack repetitions; use current energy, card rules and modifiers.';
      if (estimate.declared_self_hp_loss) action.description += ` Printed self HP loss ${estimate.declared_self_hp_loss}; HP after that loss ${estimate.hp_remaining_after_declared_loss}${estimate.fatal_from_declared_hp_loss ? ' (LETHAL SELF-LOSS before waiting for enemies)' : ''}. Check any loss-prevention effects.`;
      if (estimate.end_turn_hand_damage) action.description += ` Remaining Toxic cards deal ${estimate.end_turn_hand_damage} extra blockable damage at end of turn.`;
      if (estimate.attack_trigger_potential) {
        const trigger = estimate.attack_trigger_potential;
        action.description += ` Playing this before current-hand attacks ${trigger.hand_indices.join(', ') || '(none affordable in this calculation)'} can add ${trigger.additional_block_if_all_played} Block this turn (${trigger.additional_block_per_attack} per attack), conditional on playing those attacks afterward; this is not included in the end-now estimate.`;
      }
      if (estimate.exhausted_hand_cards) action.description += ` Exhausts ${estimate.exhausted_hand_cards.map(c => `${c.id} (hand ${c.index})`).join(', ') || 'no other cards'} for ${estimate.immediate_block_gain} immediate Block.`;
      if (estimate.instant_death_if_end_turn) action.description += ' Sandpit causes instant death on the next enemy turn, regardless of HP/Block.';
      else if (card?.id === 'FRANTIC_ESCAPE' && estimate.death_timers?.length) action.description += ` Sandpit deadline extended to ${estimate.death_timers[0].enemy_turns_remaining_after_card} enemy turns.`;
      const hit = card && target ? attackHpLoss(card, target) : null;
      if (hit?.limits.length) action.description += ` ${hit.limits.join(', ')}: preview HP damage ${hit.hp_loss} across ${hit.hits} counted hits.`;
      const followup = estimate.followup_attacks;
      if (followup?.enough_to_deplete_target && followup.hand_indices.length) action.description += ` Then hand ${followup.hand_indices.join(', ')} has ${followup.hp_damage} damage: enough to finish this target.`;
      estimate.explanation = action.description.slice(observedDescription.length).trim();
      action.description = observedDescription;
    }
  }
  // Any-time potions can also be used between rooms. Modal selections must finish first.
  if (['MAP', 'EVENT', 'REWARD', 'SHOP', 'REST_SITE', 'TREASURE'].includes(state.screen)) {
    for (const { card: potion, nth } of indexedCopies((state.decision_context?.player?.potions || []).map(p => ({ ...p, index: p.slot })), 'id')) {
      if (potion.can_use && potion.target_type !== 'AnyEnemy') add(`potion_${potion.slot}`, { cmd: 'use_potion', id: potion.id, nth }, `Consume ${potion.name}: ${potion.description}`);
    }
  }
  if (candidates.size > 255) throw new Error('Jev supports at most 255 complete mod action candidates');
  return candidates;
}

export function prepareModDecision(gameState, options = {}) {
  let candidates = buildModCandidates(gameState);
  const skippedCardRewards = [];
  if (gameState.screen === 'REWARD' && options.memory) {
    const cardRewards = (gameState.rewards?.rewards || []).filter(reward => reward.type.toLowerCase() === 'card');
    for (const [nth, reward] of cardRewards.entries()) {
      const key = cardRewardKey(reward);
      if (key && options.memory.data.run_id === gameState.decision_context?.run_id && options.memory.data.actions.some(action => action.ok && action.request.cmd === 'reward_skip_card' && action.floor === gameState.decision_context.total_floor && action.card_reward_key === key && (action.request.nth ?? 0) === nth)) {
        skippedCardRewards.push(nth);
        candidates.delete(`skip_card_${nth}`);
        for (const candidate of candidates.values()) if (candidate.request.cmd === 'reward_choose_card' && candidate.request.nth === nth) candidate.description += ' This reward was already skipped; selecting it now reconsiders that choice.';
      }
    }
  }
  const selectionPlan = candidates.selectionPlan;
  const stage = selectionPlan ? selectionStage(selectionPlan, options.selectionProgress) : null;
  if (stage) candidates = stage.candidates;
  if (!candidates.size) return { action: 'wait', reason: `No complete supported action in ${gameState?.screen || 'unknown'}` };
  const context = buildDecisionContext(gameState, { candidates, memory: options.memory, selectionPlanning: stage?.state });
  if (skippedCardRewards.length) context.screen_state.skipped_card_rewards = { reward_nths: skippedCardRewards, note: 'Skip closes the card picker but the game keeps this reward available. The earlier skip choice is remembered: duplicate skip commands are omitted, while taking a card to reconsider and claiming other rewards remain available.' };
  if (options.strategyAssessment) context.strategy_assessment = { source: 'Independent Jev judgments of incremental value, advisory rather than verified facts', scale: options.strategyAssessment.scale, options: options.strategyAssessment.options };
  if (gameState.screen === 'MAP') for (const route of context.map?.routes || []) {
    const id = `map_${route.next_node.col}_${route.next_node.row}`, candidate = candidates.get(id);
    if (!candidate) continue;
    const nearest = route.nearest_steps_after_chosen_node;
    candidate.description += ` After this node: nearest known elite ${nearest.ELITE ?? 'none reachable'} steps, rest ${nearest.REST_SITE ?? 'none reachable'} steps, shop ${nearest.SHOP ?? 'none reachable'} steps. Paths to boss contain ${route.counts.ELITE.min}-${route.counts.ELITE.max} elites and ${route.counts.REST_SITE.min}-${route.counts.REST_SITE.max} rests (bounds may be on different paths). Deck has ${context.deck.statistics.non_basic_attacks} non-basic attacks and ${context.deck.statistics.upgraded_attacks} upgraded attacks; consider their rules, relics and potions before taking early elites.`;
    const example = route.minimum_elite_route_example;
    if (example) candidate.description += ` One complete route with the fewest known elites is ${example.nodes.map(node => node.type).join(' -> ')} (${example.known_elites} known elites). ${example.known_elites ? 'Every currently visible route to the boss through this choice includes an elite.' : 'A route to the boss avoiding all currently known elites remains available.'} This is one example, not a commitment or a prediction of UNKNOWN rooms; compare the full map and resources.`;
    context.legal_actions.find(action => action.action_id === id).description = candidate.description;
  }
  let payload = {
    model: getJevModel(options),
    state: context,
    questions: { next_action: {
      type: 'choice',
      instructions: `${decisionInstructions(gameState)}${options.strategyAssessment ? ' Consider strategy_assessment as advisory assessments of each concrete option\'s incremental value. Compare all offered actions and actual effects; a strong improvement can be valuable even if the deck has several other needs. The scores do not force buying or taking any option, and any action remains selectable.' : ''}${stage ? ' This is a multi-card planning stage: follow screen_state.selection_planning, choose the next component of the final set, and consider its synergy with already selected cards. A planning choice with request=null sends no game action. Every remaining card is available as a choice; the final complete set is submitted only after all choices.' : ''}`,
      criteria: Object.fromEntries([...candidates].map(([id, candidate]) => {
        // Keep the immediate choice readable even when full histories and card
        // collections use tables. Rules remain in state; this is a direct label,
        // not a second strategy or a replacement for target previews.
        const card = gameState.screen === 'COMBAT' && candidate.request?.cmd === 'play_card'
          ? gameState.combat.hand.find(card => card.index === candidate.card_hand_index) : null;
        const target = card && gameState.combat.enemies.find(enemy => enemy.combat_id === candidate.target_combat_id);
        const countedDamage = card?.attack_preview ? (target ? [target] : card.target_type === 'AllEnemies' ? gameState.combat.enemies.filter(enemy => enemy.is_alive && enemy.hp > 0) : []).map(enemy => `${enemy.name} #${enemy.combat_id}: ${previewDamageSum(card, enemy) ?? 'unknown'} damage before Block/prevention`).join('; ') : '';
        const effect = card ? `${card.name}, cost ${card.cost < 0 ? `X (current energy ${gameState.combat.player.energy})` : card.cost}: ${card.description}${target ? ` Target ${target.name} (${target.hp} HP, ${target.block} Block).` : ''}${card.attack_preview ? ` Current preview ${card.attack_preview.hits} hits; ${countedDamage}. Modifiers and later triggers may change totals.` : ''}` : candidate.description;
        const estimate = candidate.combat_estimate;
        const potionEffect = potionEffectFacts(potionForRequest(gameState.combat?.player || gameState.decision_context?.player, candidate.request));
        return [id, { action_id: id, command: candidate.request?.cmd || 'plan_selection', effect,
          ...(potionEffect ? { effect_facts: potionEffect } : {}),
          ...(estimate ? { limited_calculation: {
            energy_left: estimate.energy_after_printed_cost,
            block: estimate.block_after_card,
            block_including_end_turn_gains: estimate.block_including_end_turn_gains,
            end_turn_block_gains: estimate.end_turn_block_gains,
            ...(estimate.block_preview ? { block_preview: estimate.block_preview } : {}),
            ...(estimate.attack_hp_loss !== undefined ? { target_hp_loss: estimate.attack_hp_loss } : {}),
            ...(estimate.attack_hp_loss_by_target ? { hp_loss_by_target: estimate.attack_hp_loss_by_target } : {}),
            end_now_hp: estimate.hp_remaining_if_end_turn,
            ...(estimate.positioning ? { positioning: estimate.positioning } : {}),
            ...(estimate.active_rage_block_gain ? { rage_block_included: estimate.active_rage_block_gain } : {}),
            ...(estimate.followup_attacks?.hand_indices.length ? { conditional_followups: estimate.followup_attacks } : {}),
            ...(estimate.attack_trigger_potential ? { conditional_attack_block: { hand_indices: estimate.attack_trigger_potential.hand_indices, additional_block_if_all_played: estimate.attack_trigger_potential.additional_block_if_all_played } } : {})
          } } : {}) }];
      }))
    } }
  };
  const originalBytes = Buffer.byteLength(JSON.stringify(payload));
  const maxBytes = options.maxRequestBytes ?? JEV_REQUEST_BUDGET;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new ContextError('Invalid Jev request byte budget');
  const shouldPack = originalBytes > Math.min(maxBytes, 30000);
  if (shouldPack) payload = compactDecisionRequest(payload);
  validateDecisionPacket(payload.state);
  const body = JSON.stringify(payload), requestBytes = compileModelRequest(payload).bytes;
  const metrics = { request_bytes: requestBytes, original_bytes: originalBytes, max_request_bytes: maxBytes, compression: shouldPack ? 'lossless_records_and_text' : 'none', candidate_count: candidates.size };
  // Byte length is only a local size guard, not the provider's token limit.
  // Compact JSON state text is sent without provider-side object formatting.
  // This budget excludes HTTP escaping and still is not a token guarantee;
  // any provider rejection stops before game input.
  if (requestBytes > maxBytes) throw new ContextError('Complete context exceeds the configured request budget; no facts were truncated and no model/action request was sent.', metrics);
  return { candidates, payload, body, metrics, skippedCardRewards, ...(selectionPlan ? { selectionPlan, selectionProgress: stage.progress } : {}) };
}

export async function makeModDecisionWithJev(gameState, options = {}) {
  let prepared = options.prepared ?? prepareModDecision(gameState, options);
  if (prepared.action === 'wait') return prepared;
  const strategy = await refreshRunStrategy(gameState, options, prepared, choosePrepared);
  if (strategy) prepared = prepareModDecision(gameState, options);
  const decision = await decidePrepared(gameState, options, prepared);
  return { ...decision,
    ...(options.memory?.data.run_strategy ? { run_strategy_revision: options.memory.data.run_strategy.revision } : {}),
    ...(strategy ? { run_strategy_usage: strategy.usage, usage: {
      input_tokens: (strategy.usage?.input_tokens || 0) + (decision.usage?.input_tokens || 0),
      output_tokens: (strategy.usage?.output_tokens || 0) + (decision.usage?.output_tokens || 0)
    } } : {}) };
}

async function decidePrepared(gameState, options, prepared) {
  const campSelection = plannedCampSelection(options.memory?.data.camp_upgrade_plan, gameState, prepared.candidates);
  if (campSelection) return { ...campSelection, model: 'jev-camp-plan-selection', context_metrics: prepared.metrics };
  if (gameState.screen === 'REST_SITE') {
    const camp = await decideCamp(gameState, options, prepared, choosePrepared);
    if (camp) return camp;
  }
  if (options.turnPlanning !== false) {
    const selection = plannedUpgradeSelection(options.memory?.data.turn_plan, gameState, prepared.candidates);
    if (selection) return { ...selection, model: 'jev-turn-plan-selection', turn_plan: options.memory.data.turn_plan, context_metrics: prepared.metrics };
    if (gameState.screen === 'COMBAT' && prepared.candidates.size > 1) return decideTurn(gameState, options, prepared, choosePrepared);
  }
  let assessment;
  if (needsStrategyAssessment(gameState, options, prepared)) {
    assessment = await choosePrepared(gameState, options, prepareStrategyAssessment(prepared, options));
    options = { ...options, strategyAssessment: assessment };
    prepared = prepareModDecision(gameState, options);
  }
  if (prepared.selectionPlan) return assembleSelection(gameState, options, prepared, choosePrepared, prepareModDecision);
  const decision = await choosePrepared(gameState, options, prepared);
  return assessment ? { ...decision, strategy_assessment: assessment, action_usage: decision.usage, usage: { input_tokens: (assessment.usage?.input_tokens || 0) + (decision.usage?.input_tokens || 0), output_tokens: (assessment.usage?.output_tokens || 0) + (decision.usage?.output_tokens || 0) } } : decision;
}

async function choosePrepared(gameState, options, prepared) {
  const { candidates, payload } = prepared;
  let { metrics } = prepared;
  const last = options.memory?.data.actions.at(-1);
  if (gameState.screen === 'REWARD' && gameState.rewards?.rewards.length === 1 && gameState.rewards.rewards[0].type === 'Card' && (prepared.skippedCardRewards?.includes(0) || (last?.ok && !last.card_reward_key && last.request.cmd === 'reward_skip_card' && last.floor === gameState.decision_context?.total_floor)) && candidates.has('proceed') && [...candidates.values()].every(candidate => ['proceed', 'reward_choose_card', 'reward_skip_card'].includes(candidate.request?.cmd))) {
    return { ...candidates.get('proceed'), candidate_id: 'proceed', model: 'complete-selected-skip', context_metrics: metrics };
  }
  if (!prepared.assessmentChoices && !prepared.parseResult && candidates.size === 1) {
    const [candidate_id, candidate] = candidates.entries().next().value;
    return { ...candidate, candidate_id, model: 'forced-single-action', context_metrics: metrics };
  }
  const started = performance.now();
  const compiled = compileModelRequest(payload, metrics);
  const availableForSource = metrics.max_request_bytes - compiled.bytes + Buffer.byteLength(JSON.stringify(payload));
  const presentation = options.contextPresentation === 'packed' ? { payload, bytes: Buffer.byteLength(JSON.stringify(payload)), presentation: 'packed', expanded_fields: [] }
    : presentCurrentRecords(payload, availableForSource);
  validateDecisionPacket(presentation.payload.state);
  let emitted = presentation.expanded_fields.length ? compileModelRequest(presentation.payload, metrics) : compiled;
  // Expansion is only a readability choice; its changed table layouts can have
  // a different compiler overhead. Fall back to the complete packed source.
  const useExpanded = emitted.bytes <= metrics.max_request_bytes;
  if (!useExpanded) emitted = compiled;
  if (emitted.bytes > metrics.max_request_bytes) throw new ContextError('Complete compiled context exceeds the request budget; no action sent', { request_bytes: emitted.bytes });
  metrics = { ...metrics, ...emitted.metrics, request_bytes: emitted.bytes,
    presentation: useExpanded ? presentation.presentation : 'packed', expanded_fields: useExpanded ? presentation.expanded_fields : [] };
  const result = await requestJev(emitted.payload, { ...options, metrics });
  if (prepared.parseResult) return { ...prepared.parseResult(result), model: result.model, usage: result.usage, context_metrics: metrics, durationMs: Math.round(performance.now() - started) };
  if (prepared.assessmentChoices) return { ...parseStrategyAssessment(prepared, result), model: result.model, usage: result.usage, context_metrics: metrics, durationMs: Math.round(performance.now() - started) };
  const answer = result.answers?.next_action;
  if (answer?.type !== 'choice' || typeof answer.choice !== 'string' || !candidates.has(answer.choice)) throw new Error('Jev returned an invalid mod action choice');
  return { ...candidates.get(answer.choice), candidate_id: answer.choice, model: result.model, probabilities: answer.probabilities, confidence: answer.confidence, usage: result.usage, context_metrics: metrics, durationMs: Math.round(performance.now() - started) };
}
