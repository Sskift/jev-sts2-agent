import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModClient } from './mod_client.mjs';
import { makeModDecisionWithJev, buildModCandidates } from './mod_decision.mjs';
import { createSession } from './artifacts.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const save = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');

// Ignore extraction timestamps and randomly ordered draw piles, but preserve
// every action-relevant combat field and each candidate's exact wire request.
export function actionFingerprint(state) {
  return JSON.stringify({
    screen: state.screen,
    context: state.combat ? null : { ...state, timestamp: undefined },
    combat: state.combat ? {
      turn: state.combat.turn_number, playerTurn: state.combat.is_player_turn,
      disabled: state.combat.is_player_actions_disabled, ending: state.combat.is_combat_ending,
      player: state.combat.player, hand: state.combat.hand, enemies: state.combat.enemies
    } : null,
    candidates: [...buildModCandidates(state)].map(([id, action]) => [id, action.request])
  });
}

export function observeModBattle(tracker, state, evidence) {
  if (state.screen === 'COMBAT' && state.combat?.enemies?.some(enemy => enemy.is_alive && enemy.hp > 0)) {
    tracker.sawCombat = true;
    tracker.combatEvidence ||= evidence;
    tracker.encounter ||= state.combat.encounter;
    tracker.initialHp ??= state.combat.player?.hp;
  }
  if (state.screen === 'GAME_OVER' || state.combat?.player?.hp === 0) {
    tracker.failed = true;
    tracker.failureEvidence = evidence;
  }
  if (state.combat?.player) tracker.lastCombatHp = state.combat.player.hp;
  if (tracker.sawCombat && tracker.playedCards > 0 && !tracker.failed && state.screen === 'REWARD' && state.rewards?.rewards?.length > 0) {
    tracker.complete = true;
    tracker.victoryEvidence = evidence;
    tracker.reason = 'Observed live enemies, sent card actions, and then observed post-combat rewards';
  }
}

export async function runModLoop({ client, driver = null, decide = makeModDecisionWithJev, maxSteps = 80, intervalMs = 600, artifactDir = createSession(), signal, logger = console.log } = {}) {
  if (!client) throw new Error('Mod client is required');
  const battle = { sawCombat: false, complete: false, failed: false, playedCards: 0, endedTurns: 0 };
  const summary = { startedAt: new Date().toISOString(), mode: 'mod', decisionModel: 'jev-latest', artifactDir, steps: 0, battle };
  const history = [];
  let unchangedActions = 0, emptyCycles = 0;
  const snapshot = async (directory, name) => {
    if (!driver) return;
    try {
      const status = await driver.status();
      save(path.join(directory, `${name}-window.json`), status);
      if (!status.window?.minimized) save(path.join(directory, `${name}-capture.json`), await driver.capture(path.join(directory, `${name}.png`)));
    } catch (error) { save(path.join(directory, `${name}-capture-error.json`), { error: error.message }); }
  };
  save(path.join(artifactDir, 'session.json'), summary);
  logger(`Starting mod loop; artifacts=${artifactDir}; maxSteps=${maxSteps}`);
  try {
    for (let step = 1; step <= maxSteps && !signal?.aborted; step++) {
      summary.steps = step;
      const directory = path.join(artifactDir, `step-${String(step).padStart(4, '0')}`);
      fs.mkdirSync(directory);
      const state = await client.state();
      save(path.join(directory, 'before-state.json'), state);
      await snapshot(directory, 'before');
      observeModBattle(battle, state, path.join(directory, 'before-state.json'));
      if (battle.complete || battle.failed) break;
      const decision = await decide(state, { recentActions: history.slice(-3) });
      save(path.join(directory, 'decision.json'), decision);
      if (signal?.aborted) break;
      if (decision.action === 'wait') {
        logger(JSON.stringify({ step, screen: state.screen, wait: decision.reason }));
        if (++emptyCycles >= 12) { summary.stoppedReason = 'No supported action after 12 observations'; break; }
        await sleep(intervalMs);
        continue;
      }
      emptyCycles = 0;
      // A user or animation may change state while Jev is answering.
      const current = await client.state();
      save(path.join(directory, 'pre-action-state.json'), current);
      if (actionFingerprint(current) !== actionFingerprint(state)) {
        save(path.join(directory, 'result.json'), { executed: false, reason: 'State changed during decision; observe again' });
        continue;
      }
      const response = await client.request(decision.request);
      save(path.join(directory, 'response.json'), response);
      await sleep(intervalMs);
      const after = await client.state();
      save(path.join(directory, 'after-state.json'), after);
      await snapshot(directory, 'after');
      const changed = actionFingerprint(after) !== actionFingerprint(state);
      history.push({ request: decision.request, ok: response.ok, beforeScreen: state.screen, afterScreen: after.screen, changed, result: response.data || response.error });
      history.splice(0, Math.max(0, history.length - 3));
      if (response.ok && decision.request.cmd === 'play_card') battle.playedCards++;
      if (response.ok && decision.request.cmd === 'end_turn') battle.endedTurns++;
      observeModBattle(battle, after, path.join(directory, 'after-state.json'));
      save(path.join(directory, 'result.json'), { request: decision.request, response, changed, battle: { ...battle } });
      logger(JSON.stringify({ step, screen: state.screen, request: decision.request, ok: response.ok, changed, afterScreen: after.screen, hp: after.combat?.player?.hp, energy: after.combat?.player?.energy, enemies: after.combat?.enemies?.map(enemy => ({ name: enemy.name, hp: enemy.hp })), battle }));
      save(path.join(artifactDir, 'session.json'), summary);
      if (!response.ok) { summary.stoppedReason = `Mod rejected action: ${response.error}: ${response.message || ''}`; break; }
      unchangedActions = changed ? 0 : unchangedActions + 1;
      if (unchangedActions >= 3) { summary.stoppedReason = 'Three actions caused no observed state change; inspect unsupported overlay'; break; }
      if (battle.complete || battle.failed) break;
    }
  } catch (error) {
    summary.error = error.message;
    summary.outcomeUnknown = Boolean(error.outcomeUnknown);
    summary.stoppedReason = 'error; no automatic action replay';
  } finally {
    summary.finishedAt = new Date().toISOString();
    summary.stoppedReason ||= battle.complete ? 'battle_complete' : battle.failed ? 'battle_failed' : signal?.aborted ? 'interrupted' : 'max_steps';
    save(path.join(artifactDir, 'session.json'), summary);
  }
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let maxSteps = 80, screenshots = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--screenshots') screenshots = true;
    else if (args[index] === '--max-steps') maxSteps = Number(args[++index]);
    else throw new Error(`Unknown option ${args[index]}`);
  }
  if (!Number.isInteger(maxSteps) || maxSteps < 1) throw new Error('Invalid max steps');
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  const client = new ModClient();
  let driver;
  try {
    if (screenshots) {
      const { WindowDriver } = await import('./window_driver.mjs');
      driver = new WindowDriver();
    }
    const summary = await runModLoop({ client, driver, maxSteps, signal: controller.signal });
    console.log(JSON.stringify(summary));
    if (!summary.battle.complete) process.exitCode = 2;
  } finally { client.close(); await driver?.close(); }
}
