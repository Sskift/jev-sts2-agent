import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { analyzeScreenshot } from './vision_opus.mjs';
import { makeDecisionWithJev } from './decision_jev.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPUTER_USE = path.join(ROOT, 'src', 'computer_use.py');

function runComputerUse(command, args, executeFile = execFileSync) {
  return executeFile('python', [COMPUTER_USE, command, ...args.map(String)], {
    cwd: ROOT, encoding: 'utf8', timeout: 10000
  }).trim();
}

function safePoint(point, state) {
  const size = state.screen_size;
  if (!size || !Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width <= 0 || size.height <= 0) return null;
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  if (point.x < 0 || point.y < 0 || point.x >= size.width || point.y >= size.height) return null;
  const x = Math.round(point.x), y = Math.round(point.y);
  if (x < 0 || y < 0 || x >= size.width || y >= size.height) return null;
  return { x, y };
}

const waitPlan = reason => ({ type: 'wait', reason });

/** Convert a decision to a bounded, explicit native action. No side effects. */
export function planAction(decision, state) {
  if (!decision || !state) return waitPlan('Missing decision or state');
  if (decision.action === 'wait') return waitPlan(decision.reason || 'Decision requested wait');
  if (['play_card', 'end_turn'].includes(decision.action) && (state.scene !== 'combat' || state.player_turn !== true)) return waitPlan('Player turn is not confirmed');
  if (decision.action === 'play_card') {
    const card = decision.card;
    if (!card || card.playable !== true || ![true, false].includes(card.target_required)) return waitPlan('Card playability or targeting is unconfirmed');
    const start = safePoint(card.screen_pos, state);
    if (!start) return waitPlan('Card coordinates are missing or out of bounds');
    const endpoint = card.target_required ? decision.target_enemy?.screen_pos : state.play_area?.visible === true ? state.play_area.screen_pos : null;
    const end = safePoint(endpoint, state);
    if (!end) return waitPlan(card.target_required ? 'Target enemy coordinates are missing or out of bounds' : 'A valid play area was not recognized');
    return { type: 'drag', args: [start.x, start.y, end.x, end.y], name: card.name };
  }
  if (decision.action === 'end_turn') {
    const target = state.end_turn_btn?.visible === true ? safePoint(state.end_turn_btn.screen_pos, state) : null;
    if (!target) return waitPlan('End-turn button was not recognized');
    return { type: 'click', args: [target.x, target.y], name: 'End turn' };
  }
  if (decision.action === 'click') {
    if (state.scene === 'combat' || state.scene === 'unknown') return waitPlan('Generic clicks are not allowed in this scene');
    const target = safePoint(decision.target, state);
    const visible = (state.selectable_options || []).some(option => {
      const point = safePoint(option.screen_pos, state);
      return point && target && point.x === target.x && point.y === target.y;
    });
    if (!visible) return waitPlan('Selected option coordinates were not recognized');
    return { type: 'click', args: [target.x, target.y], name: decision.name };
  }
  return waitPlan(`Unsupported action: ${decision.action}`);
}

export function executeActionPlan(plan, { dryRun = false, executeFile = execFileSync } = {}) {
  if (plan.type === 'wait' || dryRun) return { executed: false, plan };
  const expectedArgs = { click: 2, drag: 4 }[plan.type];
  if (!expectedArgs || !Array.isArray(plan.args) || plan.args.length !== expectedArgs || plan.args.some(n => !Number.isInteger(n) || n < 0)) throw new Error('Invalid native action plan');
  return { executed: true, plan, output: runComputerUse(plan.type, plan.args, executeFile) };
}

export async function runLoopCycle({ mockState = null, mockDecision = null, dryRun = false, decisionFn = makeDecisionWithJev, perceiveFn = analyzeScreenshot, executeFile = execFileSync, logger = console.log } = {}) {
  if ((mockState || mockDecision) && !dryRun) throw new Error('Mock input requires dryRun');
  let state = mockState;
  if (!state) {
    const tempDir = path.join(ROOT, 'temp');
    fs.mkdirSync(tempDir, { recursive: true });
    const imagePath = path.join(tempDir, 'screen.png');
    runComputerUse('capture', [imagePath], executeFile);
    state = await perceiveFn(imagePath);
  }
  const decision = mockDecision || await decisionFn(state);
  const plan = planAction(decision, state);
  logger(JSON.stringify({ scene: state.scene, dryRun, plan }));
  return { state, decision, ...executeActionPlan(plan, { dryRun, executeFile }) };
}

export async function startLoop(intervalMs = 2000, options = {}) {
  console.log(`Starting prototype loop (vision=claude-opus-5, dryRun=${Boolean(options.dryRun)})`);
  while (true) {
    try { await runLoopCycle(options); }
    catch (error) { console.error('[Loop tick failed]', error.message); }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

export function simulationFixture() {
  const state = {
    scene: 'combat', player_turn: true, screen_size: { width: 1280, height: 720 },
    player: { hp: 50, max_hp: 80, block: 5, energy: 2, max_energy: 3 },
    cards: [
      { slot: 0, id: 'card_0', name: 'Strike', description: 'Deal 6 damage.', cost: 1, type: 'attack', target_required: true, playable: true, screen_pos: { x: 500, y: 620 } },
      { slot: 1, id: 'card_1', name: 'Defend', description: 'Gain 5 Block.', cost: 1, type: 'skill', target_required: false, playable: true, screen_pos: { x: 600, y: 620 } }
    ],
    enemies: [{ slot: 0, id: 'enemy_0', name: 'Synthetic enemy', hp: 32, max_hp: 40, block: 0, intent_type: 'attack', intent_damage: 12, screen_pos: { x: 950, y: 300 } }],
    end_turn_btn: { visible: true, screen_pos: { x: 1150, y: 500 } },
    play_area: { visible: true, screen_pos: { x: 640, y: 300 } }, selectable_options: []
  };
  return { state, decision: { action: 'play_card', card: state.cards[0], target_enemy: state.enemies[0] } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2));
  const main = async () => {
    if (args.has('--sim')) {
      const { state, decision } = simulationFixture();
      await runLoopCycle({ mockState: state, mockDecision: decision, dryRun: true });
      console.log('Offline simulation completed; no APIs, screenshots or mouse actions were used.');
    } else if (args.has('--once')) {
      await runLoopCycle({ dryRun: args.has('--dry-run') });
    } else {
      await startLoop(2000, { dryRun: args.has('--dry-run') });
    }
  };
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
