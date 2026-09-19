import path from 'node:path';
import fs from 'node:fs';
import { createSession } from './artifacts.mjs';
export { createSession } from './artifacts.mjs';
import { fileURLToPath } from 'node:url';
import { analyzeScreenshot } from './vision_opus.mjs';
import { makeDecisionWithJev } from './decision_jev.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

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

/** Desktop snapshots can include concurrent user input; differences are not causation. */
export function observeDesktop(result, operation, { strictDesktop = false } = {}) {
  const foregroundChanged = result?.foregroundUnchanged === false;
  const cursorChanged = result?.cursorUnchanged === false;
  const beforeForeground = result?.before?.foreground;
  const afterForeground = result?.after?.foreground;
  const sameHandle = (left, right) => left != null && right != null && String(left).toLowerCase() === String(right).toLowerCase();
  const observation = {
    operation, foregroundChanged, cursorChanged,
    targetBecameForeground: beforeForeground != null && afterForeground != null && result?.hwnd != null
      ? !sameHandle(beforeForeground, result.hwnd) && sameHandle(afterForeground, result.hwnd) : null,
    attribution: foregroundChanged || cursorChanged ? 'unattributed_desktop_change' : 'no_change_observed'
  };
  const recorded = { ...result, desktopObservation: observation };
  if (strictDesktop && (foregroundChanged || cursorChanged)) {
    const error = new Error(`Strict desktop observation detected a change during ${operation}; its cause is unknown`);
    error.actionResult = recorded;
    error.fatal = true;
    throw error;
  }
  return recorded;
}

/** Pure mapping: image pixels equal window client pixels. No desktop offsets. */
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
    if (!end || (card.target_required && (decision.target_enemy?.targetable === false || decision.target_enemy?.hp === 0))) return waitPlan(card.target_required ? 'Target enemy coordinates are missing or out of bounds' : 'A valid play area was not recognized');
    return { type: 'drag', args: [start.x, start.y, end.x, end.y], name: card.name };
  }
  if (decision.action === 'end_turn') {
    const target = state.end_turn_btn?.visible === true && state.end_turn_btn.enabled !== false ? safePoint(state.end_turn_btn.screen_pos, state) : null;
    if (!target) return waitPlan('End-turn button was not recognized');
    return { type: 'click', args: [target.x, target.y], name: 'End turn' };
  }
  if (decision.action === 'click') {
    if (state.scene === 'combat' || state.scene === 'unknown') return waitPlan('Generic clicks are not allowed in this scene');
    const target = safePoint(decision.target, state);
    const visible = (state.selectable_options || []).some(option => {
      const point = safePoint(option.screen_pos, state);
      return option.enabled !== false && option.visible !== false && point && target && point.x === target.x && point.y === target.y;
    });
    if (!visible) return waitPlan('Selected option coordinates were not recognized');
    return { type: 'click', args: [target.x, target.y], name: decision.name };
  }
  return waitPlan(`Unsupported action: ${decision.action}`);
}

export async function executeActionPlan(plan, { dryRun = false, driver, capture = null, strictDesktop = false } = {}) {
  if (plan.type === 'wait' || dryRun) return { executed: false, plan };
  const expectedArgs = { click: 2, drag: 4 }[plan.type];
  if (!expectedArgs || !Array.isArray(plan.args) || plan.args.length !== expectedArgs || plan.args.some(n => !Number.isInteger(n) || n < 0)) throw new Error('Invalid native action plan');
  if (!driver?.execute) throw new Error('A background window driver is required');
  if (capture && driver.status) {
    const current = await driver.status();
    if (String(current.hwnd) !== String(capture.hwnd) || current.width !== capture.width || current.height !== capture.height) throw new Error('Window identity or client dimensions changed after perception; recapture before acting');
  }
  const [x, y, endX, endY] = plan.args;
  const output = observeDesktop(await driver.execute({ type: plan.type, x, y, ...(plan.type === 'drag' ? { endX, endY } : {}), ...(capture ? { expectedWidth: capture.width, expectedHeight: capture.height } : {}) }), 'window_action', { strictDesktop });
  return { executed: true, plan, output };
}

/** Completion requires a combat frame followed by observed victory/reward evidence. */
export function observeBattle(tracker, state, evidence) {
  if (!tracker || !state) return;
  if (state.scene === 'combat' && state.enemies?.some(enemy => Number.isFinite(enemy.hp) && enemy.hp > 0)) {
    tracker.sawCombat = true;
    tracker.combatEvidence ||= evidence;
  }
  if (state.scene === 'game_over' || state.battle_result === 'defeat' || (state.scene === 'combat' && state.player?.hp === 0)) {
    tracker.failed = true;
    tracker.complete = false;
    tracker.failureEvidence = evidence;
  }
  const livingEnemies = state.enemies?.some(enemy => !Number.isFinite(enemy.hp) || enemy.hp > 0);
  const rewardVisible = state.scene === 'reward' && state.selectable_options?.some(option => option.visible !== false && option.screen_pos);
  const explicitVictory = ['combat', 'reward'].includes(state.scene) && state.battle_result === 'victory' && typeof state.battle_evidence === 'string' && state.battle_evidence.trim().length > 0;
  if (tracker.sawCombat && !tracker.failed && !livingEnemies && (rewardVisible || explicitVictory)) {
    tracker.complete = true;
    tracker.victoryEvidence = evidence;
    tracker.victoryReason = rewardVisible ? 'Reward screen observed after combat' : state.battle_evidence;
  }
}

/** Compare observed fields, not animation pixels or assumptions about action success. */
export function summarizeObservedChanges(before, after) {
  const fields = {
    scene: state => state.scene,
    player: state => state.player,
    enemies: state => (state.enemies || []).map(({ name, hp, block, intent_type, intent_damage }) => ({ name, hp, block, intent_type, intent_damage })),
    hand: state => (state.cards || []).map(({ name, cost, playable }) => ({ name, cost, playable })),
    options: state => (state.selectable_options || []).map(({ name, enabled, selected }) => ({ name, enabled, selected })).sort((a, b) => a.name.localeCompare(b.name))
  };
  return Object.entries(fields).filter(([, read]) => JSON.stringify(read(before)) !== JSON.stringify(read(after))).map(([field]) => field);
}

export async function runLoopCycle({ mockState = null, mockDecision = null, dryRun = false, decisionFn = makeDecisionWithJev, perceiveFn = analyzeScreenshot, driver, artifactDir = null, step = 1, settleMs = 1000, battleTracker = null, strictDesktop = false, recentActions = [], logger = console.log } = {}) {
  if ((mockState || mockDecision) && !dryRun) throw new Error('Mock input requires dryRun');
  const directory = artifactDir ? path.join(artifactDir, `step-${String(step).padStart(4, '0')}`) : null;
  if (directory) fs.mkdirSync(directory, { recursive: true });
  const persist = (name, value) => { if (directory) writeJson(path.join(directory, `${name}.json`), value); };
  const result = { step, dryRun, startedAt: new Date().toISOString() };
  try {
    let state = mockState;
    let capture;
    if (!state) {
      if (!driver?.capture || !directory) throw new Error('A window driver and artifact directory are required for live observation');
      const imagePath = path.join(directory, 'before.png');
      capture = observeDesktop(await driver.capture(imagePath), 'before_capture', { strictDesktop });
      persist('capture', capture);
      state = await perceiveFn(imagePath);
      if (state.screen_size?.width !== capture.width || state.screen_size?.height !== capture.height) throw new Error('Screenshot and window client dimensions differ; no implicit coordinate scaling is allowed');
    }
    state = { ...state, recent_actions: recentActions.slice(-3) };
    result.state = state;
    persist('state', state);
    observeBattle(battleTracker, state, directory ? path.join(directory, 'before.png') : 'mock-before');
    const decision = battleTracker?.complete || battleTracker?.failed ? { action: 'wait', reason: 'Battle acceptance is terminal' } : mockDecision || await decisionFn(state);
    result.decision = decision;
    persist('decision', decision);
    const plan = planAction(decision, state);
    result.plan = plan;
    persist('action', plan);
    Object.assign(result, await executeActionPlan(plan, { dryRun, driver, capture, strictDesktop }));
    if (result.executed) {
      await sleep(settleMs);
      const afterPath = path.join(directory, 'after.png');
      const afterCapture = observeDesktop(await driver.capture(afterPath), 'after_capture', { strictDesktop });
      persist('after-capture', afterCapture);
      result.afterState = await perceiveFn(afterPath, { previousAction: plan });
      if (result.afterState.screen_size?.width !== afterCapture.width || result.afterState.screen_size?.height !== afterCapture.height) throw new Error('Post-action screenshot and window client dimensions differ');
      persist('after-state', result.afterState);
      observeBattle(battleTracker, result.afterState, afterPath);
      const changedFields = summarizeObservedChanges(state, result.afterState);
      result.observedOutcome = { changedFields, summary: changedFields.length ? `Observed changed fields: ${changedFields.join(', ')}` : 'No structured change observed; this does not prove the input was ignored' };
      recentActions.push({ step, scene: state.scene, action: { type: plan.type, name: plan.name }, afterScene: result.afterState.scene, observedOutcome: result.observedOutcome, beforeSummary: state.screen_summary || null, afterSummary: result.afterState.screen_summary || null });
      if (recentActions.length > 3) recentActions.splice(0, recentActions.length - 3);
    }
    result.finishedAt = new Date().toISOString();
    if (battleTracker) result.battle = { ...battleTracker };
    persist('result', result);
    logger(JSON.stringify({ step, scene: state.scene, afterScene: result.afterState?.scene, dryRun, plan, battle: battleTracker }));
    return result;
  } catch (error) {
    persist('result', { ...result, finishedAt: new Date().toISOString(), error: error.message, ...(error.actionResult ? { actionResult: error.actionResult } : {}) });
    throw error;
  }
}

export async function startLoop(intervalMs = 1000, options = {}) {
  const { maxSteps = 120, untilBattleComplete = false, maxConsecutiveErrors = 3, logger = console.log } = options;
  const artifactDir = options.artifactDir || createSession();
  const battleTracker = { sawCombat: false, complete: false, failed: false };
  const recentActions = [];
  const summary = { startedAt: new Date().toISOString(), artifactDir, dryRun: Boolean(options.dryRun), strictDesktop: Boolean(options.strictDesktop), visionModel: 'claude-opus-5', decisionModel: 'jev-latest', battle: battleTracker, steps: 0, errors: 0 };
  writeJson(path.join(artifactDir, 'session.json'), summary);
  logger(`Starting background window loop; artifacts=${artifactDir}; maxSteps=${maxSteps}; dryRun=${summary.dryRun}`);
  let consecutiveErrors = 0;
  for (let step = 1; step <= maxSteps; step++) {
    try {
      await runLoopCycle({ ...options, artifactDir, step, battleTracker, recentActions });
      consecutiveErrors = 0;
    } catch (error) {
      summary.errors++;
      consecutiveErrors++;
      logger(JSON.stringify({ step, error: error.message }));
      if (error.fatal || consecutiveErrors >= maxConsecutiveErrors) {
        summary.stoppedReason = error.message;
        break;
      }
    } finally {
      summary.steps = step;
      writeJson(path.join(artifactDir, 'session.json'), summary);
    }
    if (battleTracker.failed || (untilBattleComplete && battleTracker.complete)) break;
    if (step < maxSteps) await sleep(intervalMs);
  }
  summary.finishedAt = new Date().toISOString();
  summary.stoppedReason ||= battleTracker.complete && untilBattleComplete ? 'battle_complete' : battleTracker.failed ? 'battle_failed' : 'max_steps';
  writeJson(path.join(artifactDir, 'session.json'), summary);
  return summary;
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

export function parseOptions(args) {
  const options = { dryRun: false, strictDesktop: false, maxSteps: 120, untilBattleComplete: false, intervalMs: 1000, settleMs: 1000 };
  const values = { '--max-steps': 'maxSteps', '--interval-ms': 'intervalMs', '--settle-ms': 'settleMs', '--artifact-dir': 'artifactRoot', '--window-title': 'titlePattern', '--hwnd': 'hwnd' };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--sim') options.sim = true;
    else if (arg === '--once') options.once = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--strict-desktop') options.strictDesktop = true;
    else if (arg === '--until-battle-complete') options.untilBattleComplete = true;
    else if (values[arg]) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      const key = values[arg];
      options[key] = ['maxSteps', 'intervalMs', 'settleMs'].includes(key) ? Number(value) : value;
      if (typeof options[key] === 'number' && (!Number.isInteger(options[key]) || options[key] < (key === 'maxSteps' ? 1 : 0))) throw new Error(`Invalid value for ${arg}`);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.once) options.maxSteps = 1;
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const main = async () => {
    const options = parseOptions(process.argv.slice(2));
    if (options.sim) {
      const { state, decision } = simulationFixture();
      await runLoopCycle({ mockState: state, mockDecision: decision, dryRun: true });
      console.log('Offline simulation completed; no APIs, screenshots or mouse actions were used.');
      return;
    }
    const { WindowDriver } = await import('./window_driver.mjs');
    const driver = new WindowDriver({ titlePattern: options.titlePattern || 'Slay the Spire 2', ...(options.hwnd ? { hwnd: options.hwnd } : {}) });
    try {
      const summary = await startLoop(options.intervalMs, { ...options, driver, artifactDir: createSession(options.artifactRoot) });
      console.log(JSON.stringify(summary));
      if (summary.battle.failed || !summary.battle.complete && (summary.errors > 0 || options.untilBattleComplete)) process.exitCode = 2;
    } finally { await driver.close(); }
  };
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
