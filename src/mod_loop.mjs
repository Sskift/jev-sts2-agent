import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModClient, ModTransportError, validateModRequest } from './mod_client.mjs';
import { makeModDecisionWithJev, prepareModDecision, buildModCandidates } from './mod_decision.mjs';
import { DecisionMemory, ContextError, canonicalObservation } from './decision_context.mjs';
import { createSession } from './artifacts.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const save = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');

// Every supplied decision fact invalidates an old answer when changed.
// Extraction time and randomized draw order do not.
export function actionFingerprint(state) {
  return JSON.stringify({
    context: canonicalObservation(state),
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

export function observeRun(progress, state, evidence) {
  const context = state.decision_context;
  if (context?.run_id) {
    if (progress.runId && progress.runId !== context.run_id) throw new ContextError('Run identity changed during this session');
    progress.runId = context.run_id;
    progress.startedAtFloor ??= context.total_floor;
    progress.acts ||= [];
    if (!progress.acts.includes(context.act_index)) progress.acts.push(context.act_index);
    progress.floor = context.total_floor;
    progress.hp = context.player?.hp;
  }
  if (state.screen === 'GAME_OVER') {
    progress.formalResult = state.game_over;
    progress.finalEvidence = evidence;
    progress.failed = state.game_over?.is_victory === false;
    progress.victory = state.game_over?.is_victory === true;
    progress.complete = progress.victory && state.game_over.can_return_to_menu === true && progress.startedAtFloor <= 1 && [0, 1, 2].every(act => progress.acts?.includes(act));
  }
}

export async function runModLoop({ client, driver = null, decide = makeModDecisionWithJev, maxSteps = 3000, intervalMs = 600, artifactDir = createSession(), memoryFile = path.join(artifactDir, 'memory.json'), signal, logger = console.log, stopAfterBattle = false } = {}) {
  if (!client) throw new Error('Mod client is required');
  const battle = { sawCombat: false, complete: false, failed: false, playedCards: 0, endedTurns: 0 };
  const summary = { startedAt: new Date().toISOString(), mode: 'mod', decisionModel: 'jev-latest', artifactDir, steps: 0, battle };
  const memory = new DecisionMemory({ file: memoryFile });
  const previous = memory.data.run_progress;
  const progress = summary.run = previous?.failed || previous?.complete ? {} : previous || {};
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
      const state = await client.state({ includePileDetails: true });
      save(path.join(directory, 'before-state.json'), state);
      memory.observe(state);
      observeRun(progress, state, path.join(directory, 'before-state.json'));
      memory.data.run_progress = progress;
      memory.persist();
      if (memory.data.pending && state.decision_context?.run_id === memory.data.run_id) throw Object.assign(new ContextError('An earlier action has an unresolved outcome; inspect saved memory before continuing.'), { outcomeUnknown: true });
      await snapshot(directory, 'before');
      observeModBattle(battle, state, path.join(directory, 'before-state.json'));
      if ((progress.victory && state.game_over?.can_return_to_menu) || progress.failed || (stopAfterBattle && (battle.complete || battle.failed))) break;
      const prepared = prepareModDecision(state, { memory });
      if (prepared.payload) {
        save(path.join(directory, 'jev-request.json'), prepared.payload);
        save(path.join(directory, 'context-metrics.json'), prepared.metrics);
      }
      let planningCalls = 0, planningDecisions = 0;
      const decision = await decide(state, { memory, prepared,
        onRequest: payload => {
          if (prepared.selectionPlan) save(path.join(directory, `jev-planning-request-${String(++planningCalls).padStart(4, '0')}.json`), payload);
        },
        onPlanningDecision: result => save(path.join(directory, `jev-planning-decision-${String(++planningDecisions).padStart(4, '0')}.json`), result)
      });
      save(path.join(directory, 'decision.json'), decision);
      if (signal?.aborted) break;
      if (decision.action === 'wait') {
        logger(JSON.stringify({ step, screen: state.screen, wait: decision.reason }));
        if (++emptyCycles >= (state.screen === 'GAME_OVER' ? 60 : 20)) { summary.stoppedReason = `No supported action after ${emptyCycles} observations`; break; }
        await sleep(intervalMs);
        continue;
      }
      emptyCycles = 0;
      if (decision.action !== 'mod_command' || !decision.request) throw new ContextError('Decision is not a complete dispatchable game command');
      validateModRequest(decision.request);
      // A user or animation may change state while Jev is answering.
      const current = await client.state({ includePileDetails: true });
      save(path.join(directory, 'pre-action-state.json'), current);
      if (actionFingerprint(current) !== actionFingerprint(state)) {
        save(path.join(directory, 'result.json'), { executed: false, reason: 'State changed during decision; observe again' });
        continue;
      }
      memory.begin(decision.request, current);
      let response;
      try { response = await client.request(decision.request); }
      catch (error) {
        if (!(error instanceof ModTransportError) || error.dispatched) throw error;
        // A failed connection sent no command. Record that fact and make a new
        // decision from a fresh observation; never replay a stale selection.
        memory.finish({ ok: false, error: 'NOT_DISPATCHED' }, current);
        save(path.join(directory, 'result.json'), { executed: false, reason: error.message });
        logger(JSON.stringify({ step, screen: state.screen, wait: 'Mod connection unavailable; no action was sent' }));
        await sleep(intervalMs);
        continue;
      }
      save(path.join(directory, 'response.json'), response);
      await sleep(intervalMs);
      const after = await client.state({ includePileDetails: true });
      save(path.join(directory, 'after-state.json'), after);
      await snapshot(directory, 'after');
      memory.finish(response, after);
      if (memory.data.pending) summary.outcomeUnknown = true;
      memory.observe(after);
      observeRun(progress, after, path.join(directory, 'after-state.json'));
      memory.data.run_progress = progress;
      memory.persist();
      const changed = actionFingerprint(after) !== actionFingerprint(state);
      if (response.ok && decision.request.cmd === 'play_card') battle.playedCards++;
      if (response.ok && decision.request.cmd === 'end_turn') battle.endedTurns++;
      observeModBattle(battle, after, path.join(directory, 'after-state.json'));
      save(path.join(directory, 'result.json'), { request: decision.request, response, changed, battle: { ...battle } });
      logger(JSON.stringify({ step, screen: state.screen, request: decision.request, model: decision.model, ok: response.ok, changed, afterScreen: after.screen, act: after.decision_context?.act_index, floor: after.decision_context?.total_floor, hp: after.decision_context?.player?.hp, energy: after.combat?.player?.energy, enemies: after.combat?.enemies?.map(enemy => ({ name: enemy.name, hp: enemy.hp })) }));
      save(path.join(artifactDir, 'session.json'), summary);
      if (!response.ok) { summary.stoppedReason = `Mod rejected action: ${response.error}: ${response.message || ''}`; break; }
      unchangedActions = changed ? 0 : unchangedActions + 1;
      if (unchangedActions >= 3) { summary.stoppedReason = 'Three actions caused no observed state change; inspect unsupported overlay'; break; }
      if ((progress.victory && after.game_over?.can_return_to_menu) || progress.failed || (stopAfterBattle && (battle.complete || battle.failed))) break;
    }
  } catch (error) {
    summary.error = error.message;
    if (error.details) summary.errorDetails = error.details;
    summary.outcomeUnknown = Boolean(error.outcomeUnknown);
    summary.stoppedReason = 'error; no automatic action replay';
  } finally {
    summary.finishedAt = new Date().toISOString();
    summary.stoppedReason ||= progress.complete ? 'run_complete' : progress.victory ? 'victory_without_full_run_history' : progress.failed ? 'run_failed' : stopAfterBattle && battle.complete ? 'battle_complete' : signal?.aborted ? 'interrupted' : 'max_steps';
    save(path.join(artifactDir, 'session.json'), summary);
  }
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let maxSteps = 3000, screenshots = false;
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
    const summary = await runModLoop({ client, driver, maxSteps, signal: controller.signal, memoryFile: path.resolve('run-artifacts/mod-memory.json') });
    console.log(JSON.stringify(summary));
    if (!summary.run.complete) process.exitCode = 2;
  } finally { client.close(); await driver?.close(); }
}
