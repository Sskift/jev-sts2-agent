import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VISION_MODEL = 'claude-opus-5';

export function getClaudeConfig({ env = process.env, settingsPath = path.join(os.homedir(), '.claude', 'settings.json') } = {}) {
  let settingsEnv = {};
  if (fs.existsSync(settingsPath)) settingsEnv = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).env || {};
  return {
    baseUrl: env.ANTHROPIC_BASE_URL || settingsEnv.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    authToken: env.ANTHROPIC_AUTH_TOKEN || settingsEnv.ANTHROPIC_AUTH_TOKEN || '',
    apiKey: env.ANTHROPIC_API_KEY || settingsEnv.ANTHROPIC_API_KEY || '',
    // A configured alias is not evidence that the requested model is available.
    model: VISION_MODEL
  };
}

function validatePoint(point, label) {
  if (point === null) return;
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error(`Invalid perception coordinate: ${label}`);
}

export function validateGameState(state) {
  const scenes = ['combat', 'reward', 'map', 'rest', 'event', 'main_menu', 'shop', 'treasure', 'card_select', 'game_over', 'character_select', 'unknown'];
  if (!state || !scenes.includes(state.scene)) throw new Error('Invalid perception scene');
  if (![true, false, null].includes(state.player_turn)) throw new Error('Invalid player_turn; use true, false or null');
  for (const field of ['cards', 'enemies', 'selectable_options']) {
    if (!Array.isArray(state[field])) throw new Error(`Invalid perception ${field}`);
    for (const [index, item] of state[field].entries()) {
      if (!item || typeof item.name !== 'string') throw new Error(`Invalid ${field}[${index}]`);
      validatePoint(item.screen_pos, `${field}[${index}].screen_pos`);
    }
  }
  const slots = new Set();
  for (const card of state.cards) {
    if (!Number.isInteger(card.slot) || card.slot < 0 || slots.has(card.slot)) throw new Error('Card slot must be unique and nonnegative');
    slots.add(card.slot);
    if (typeof card.description !== 'string') throw new Error('Card description must be a string');
    if (!(card.cost === null || card.cost === 'X' || (Number.isFinite(card.cost) && card.cost >= 0))) throw new Error('Invalid card cost');
    if (![true, false, null].includes(card.target_required) || typeof card.playable !== 'boolean') throw new Error('Invalid card playability');
  }
  for (const field of ['end_turn_btn', 'play_area']) {
    const region = state[field];
    if (!region || typeof region.visible !== 'boolean') throw new Error(`Invalid ${field}`);
    validatePoint(region.screen_pos, `${field}.screen_pos`);
    if (region.visible && region.screen_pos === null) throw new Error(`${field} is visible but has no coordinate`);
  }
  if (state.scene === 'combat' && (!state.player || !Number.isFinite(state.player.energy))) throw new Error('Combat energy was not recognized');
  return state;
}

const SYSTEM_PROMPT = `You perceive a Slay the Spire 2 screenshot. Extract only visible evidence, never invent a card effect or coordinate. Return a single JSON object without markdown:
{
  "scene": "combat|reward|map|rest|event|main_menu|shop|treasure|card_select|game_over|character_select|unknown",
  "player_turn": true,
  "player": {"hp": 0, "max_hp": 0, "block": 0, "energy": 0, "max_energy": 0},
  "cards": [{"slot": 0, "id": "card_0", "name": "visible name", "description": "visible effect text", "cost": 0, "type": "attack|skill|power|unknown", "target_required": true, "screen_pos": {"x": 0, "y": 0}, "playable": true}],
  "enemies": [{"slot": 0, "id": "enemy_0", "name": "visible name", "hp": 0, "max_hp": 0, "block": 0, "intent_type": "attack|defend|buff|debuff|unknown", "intent_damage": 0, "screen_pos": {"x": 0, "y": 0}}],
  "end_turn_btn": {"visible": false, "screen_pos": null},
  "play_area": {"visible": false, "screen_pos": null},
  "selectable_options": [{"name": "visible option", "screen_pos": {"x": 0, "y": 0}}]
}
Choose one listed enum value, not the pipe-separated example. player_turn is true only when visibly confirmed to be the player's actionable turn, false during the enemy's turn or animation, null if uncertain or outside combat. Set player to null outside combat. Use empty arrays when no entities are visible. Cards must have unique zero-based slots ordered left to right, including repeated cards. Use an empty description when unreadable; do not infer effects from the card name. Cost may be a nonnegative number, "X", or null if unreadable. target_required may be null if unknown. playable must be false if uncertain. Unknown coordinates are null. play_area is a visibly identified valid drop area for untargeted cards, never an assumed offset from the hand. All screen_pos coordinates are absolute pixels in the supplied image. Do not return a visible control without a recognized coordinate.`;

/** One PNG perception call. Does not change TLS verification or capture the desktop. */
export async function analyzeScreenshot(imagePath, { config = getClaudeConfig(), fetchImpl = fetch, timeoutMs = 45000 } = {}) {
  if (!config.authToken && !config.apiKey) throw new Error('Claude credentials are not configured');
  const image = fs.readFileSync(imagePath);
  if (image.length < 24 || image.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Vision input must be a PNG image');
  const screenSize = { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
  const response = await fetchImpl(`${config.baseUrl.replace(/\/$/, '')}/v1/messages`, {
    method: 'POST', signal: AbortSignal.timeout(timeoutMs),
    headers: {
      ...(config.authToken ? { Authorization: `Bearer ${config.authToken}` } : { 'x-api-key': config.apiKey }),
      'anthropic-version': '2023-06-01', 'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: VISION_MODEL, max_tokens: 4000, system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.toString('base64') } },
        { type: 'text', text: 'Identify the current scene, whether the player can act, visible card effects and slots, enemy intents, selectable options, the end-turn button and a valid untargeted-card play area.' }
      ] }]
    })
  });
  if (!response.ok) throw new Error(`Claude API error ${response.status}`);
  const data = await response.json();
  if (data.stop_reason !== 'end_turn') throw new Error(`Incomplete Claude perception response (${data.stop_reason || 'missing stop_reason'})`);
  const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
  const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const state = validateGameState(JSON.parse(clean));
  return { ...state, screen_size: screenSize };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = getClaudeConfig();
  console.log(JSON.stringify({ model: VISION_MODEL, credentialsConfigured: Boolean(config.authToken || config.apiKey), status: 'Configuration checked; no API request was made.' }));
}
