import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModClient, ModTransportError, validateModRequest } from './mod_client.mjs';
import { makeModDecisionWithJev, prepareModDecision, buildModCandidates } from './mod_decision.mjs';
import { DecisionMemory, ContextError, canonicalObservation } from './decision_context.mjs';
import { createSession } from './artifacts.mjs';
import { getJevConfig } from './jev_client.mjs';
import { auditObservedAction } from './observation_audit.mjs';

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
  if (state.screen === 'GAME_OVER' || (!state.combat?.multiplayer && state.combat?.player?.hp === 0)) {
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

// An enemy-turn selection proves end_turn was accepted and yielded to another
// player decision. It does not prove the enemy turn has finished, and never
// authorizes sending end_turn again.
export function observedEndTurnSelection(pending, state) {
  const selection = { TRI_SELECT: state.tri_select, GRID_CARD_SELECT: state.grid_card_select, HAND_SELECT: state.hand_select }[state.screen];
  const cards = selection?.cards || selection?.selectable_cards;
  if (pending?.request?.cmd !== 'end_turn' || pending.screen !== 'COMBAT' || pending.outcome_unknown
    || !pending.combat_id || pending.combat_id !== state.decision_context?.combat_id
    || pending.floor !== state.decision_context?.total_floor || pending.round !== state.combat?.turn_number
    || state.combat?.is_player_turn !== false || state.combat?.is_player_actions_disabled !== true
    || state.combat?.is_combat_ending !== false || !Array.isArray(cards) || !cards.length || !(selection.min_select > 0)) return null;
  return { ok: true, data: { action: 'END_TURN', reason: 'observed_enemy_turn_selection', turn_completed: false, observed_screen: state.screen, command_replayed: false } };
}

// Some mod versions compare only event button titles. Repeated event pages can
// keep those titles while changing their actual effects and costs.
export function observedEventProgress(before, request, after) {
  if (request?.cmd !== 'choose_event' || before.screen !== 'EVENT' || after.screen !== 'EVENT'
    || before.combat || after.combat || before.event?.is_finished !== false
    || !before.decision_context?.run_id || before.decision_context.run_id !== after.decision_context?.run_id
    || before.decision_context.total_floor !== after.decision_context?.total_floor
    || !before.event?.event_id || before.event.event_id !== after.event?.event_id
    || !before.event.options?.some(option => option.index === request.args?.[0] && option.is_locked === false)) return null;
  const choices = event => (event.options || []).map(({ index, title, description, text_key, is_locked, is_proceed }) => ({ index, title, description, text_key, is_locked, is_proceed }));
  const advanced = after.event.is_finished === true || (after.event.options?.length > 0 && JSON.stringify(choices(before.event)) !== JSON.stringify(choices(after.event)));
  if (!advanced) return null;
  return { ok: true, data: { action: 'CHOOSE_EVENT', reason: 'observed_event_progress', observed_event_id: after.event.event_id, command_replayed: false } };
}

export async function runModLoop({ client, driver = null, decide = makeModDecisionWithJev, maxSteps = 3000, intervalMs = 600, artifactDir = createSession(), memoryFile = path.join(artifactDir, 'memory.json'), signal, logger = console.log, stopAfterBattle = false, onObservation, onBeforeAction } = {}) {
  if (!client) throw new Error('Mod client is required');
  const battle = { sawCombat: false, complete: false, failed: false, playedCards: 0, endedTurns: 0 };
  const { provider, model } = getJevConfig();
  const summary = { startedAt: new Date().toISOString(), mode: 'mod', decisionProvider: provider, decisionModel: model, artifactDir, steps: 0, battle,
    numericAudit: { checked: 0, mismatches: 0 } };
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
      await onObservation?.(state);
      memory.observe(state);
      observeRun(progress, state, path.join(directory, 'before-state.json'));
      memory.data.run_progress = progress;
      memory.persist();
      if (memory.data.pending && state.decision_context?.run_id === memory.data.run_id) {
        const observed = observedEndTurnSelection(memory.data.pending, state);
        if (!observed) throw Object.assign(new ContextError('An earlier action has an unresolved outcome; inspect saved memory before continuing.'), { outcomeUnknown: true });
        save(path.join(directory, 'pending-action-observed.json'), { pending: memory.data.pending, observed });
        memory.finish(observed, state);
      }
      await snapshot(directory, 'before');
      observeModBattle(battle, state, path.join(directory, 'before-state.json'));
      if ((progress.victory && state.game_over?.can_return_to_menu) || progress.failed || (stopAfterBattle && (battle.complete || battle.failed))) break;
      const prepared = prepareModDecision(state, { memory });
      if (prepared.payload) {
        save(path.join(directory, 'jev-request.json'), prepared.payload);
        save(path.join(directory, 'context-metrics.json'), prepared.metrics);
      }
      let planningCalls = 0, planningDecisions = 0, modelCalls = 0, strategicAssessments = 0;
      const decision = await decide(state, { memory, prepared, runStrategy: true,
        onRequest: (payload, metrics) => {
          modelCalls++;
          if (metrics.purpose === 'run_strategy_assessment') {
            strategicAssessments++;
            save(path.join(directory, 'jev-run-strategy-request.json'), payload);
            save(path.join(directory, 'context-run-strategy.json'), metrics);
          }
          else if (metrics.purpose === 'option_assessment') save(path.join(directory, 'jev-strategy-request.json'), payload);
          else if (metrics.purpose?.startsWith('turn_') || metrics.purpose?.startsWith('camp_') || metrics.purpose?.startsWith('shop_')) {
            const sequence = String(++planningCalls).padStart(4, '0');
            save(path.join(directory, `jev-${metrics.purpose}-${sequence}.json`), payload);
            save(path.join(directory, `context-${metrics.purpose}-${sequence}.json`), metrics);
          }
          else { save(path.join(directory, 'jev-request.json'), payload); save(path.join(directory, 'context-metrics.json'), metrics); }
          if (prepared.selectionPlan) save(path.join(directory, `jev-planning-request-${String(++planningCalls).padStart(4, '0')}.json`), payload);
          return modelCalls;
        },
        onResponse: (result, metrics, id) => save(path.join(directory, `jev-response-${String(id).padStart(4, '0')}.json`),
          { purpose: metrics.purpose, transport: { provider: metrics.provider, requested_model: metrics.requested_model, attempt: metrics.attempt, failover: metrics.failover }, ...result }),
        onPlanningDecision: result => save(path.join(directory, `jev-planning-decision-${String(++planningDecisions).padStart(4, '0')}.json`), result),
        onRunStrategy: result => save(path.join(directory, 'run-strategy-decision.json'), result)
      });
      save(path.join(directory, 'decision.json'), decision);
      if (signal?.aborted) break;
      if (decision.action === 'wait') {
        logger(JSON.stringify({ step, screen: state.screen, wait: decision.reason }));
        if (state.combat?.multiplayer && !state.combat.is_player_turn) {
          // A submitted turn or a downed local player can wait for human
          // teammates longer than the single-player animation timeout.
          emptyCycles = 0;
          await sleep(intervalMs);
          continue;
        }
        if (++emptyCycles >= (state.screen === 'GAME_OVER' ? 60 : 20)) { summary.stoppedReason = `No supported action after ${emptyCycles} observations`; break; }
        await sleep(intervalMs);
        continue;
      }
      emptyCycles = 0;
      if (decision.action !== 'mod_command' || !decision.request) throw new ContextError('Decision is not a complete dispatchable game command');
      validateModRequest(decision.request);
      await onBeforeAction?.(state, decision);
      // A user or animation may change state while Jev is answering.
      const current = await client.state({ includePileDetails: true });
      save(path.join(directory, 'pre-action-state.json'), current);
      if (actionFingerprint(current) !== actionFingerprint(state)) {
        save(path.join(directory, 'result.json'), { executed: false, reason: 'State changed during decision; observe again' });
        continue;
      }
      memory.begin(decision.request, current, { turnPlan: decision.turn_plan, turnStep: decision.turn_step, campUpgradePlan: decision.camp_upgrade_plan, shopRemovalPlan: decision.shop_removal_plan });
      let response;
      try { response = await client.request(decision.request); }
      catch (error) {
        if (!(error instanceof ModTransportError)) throw error;
        if (error.dispatched) {
          if (decision.request.cmd !== 'end_turn') throw error;
          const observedState = await client.state({ includePileDetails: true });
          save(path.join(directory, 'timeout-observation.json'), observedState);
          response = observedEndTurnSelection(memory.data.pending, observedState);
          if (!response) throw error;
        } else {
          // A failed connection sent no command. Record that fact and make a new
          // decision from a fresh observation; never replay a stale selection.
          memory.finish({ ok: false, error: 'NOT_DISPATCHED' }, current);
          save(path.join(directory, 'result.json'), { executed: false, reason: error.message });
          logger(JSON.stringify({ step, screen: state.screen, wait: 'Mod connection unavailable; no action was sent' }));
          await sleep(intervalMs);
          continue;
        }
      }
      save(path.join(directory, 'response.json'), response);
      await sleep(intervalMs);
      const after = await client.state({ includePileDetails: true });
      save(path.join(directory, 'after-state.json'), after);
      if (response.ok) {
        const audit = auditObservedAction(current, decision, after);
        if (audit) {
          save(path.join(directory, 'estimate-audit.json'), audit);
          summary.numericAudit.checked += audit.comparisons.length;
          if (audit.mismatch) {
            summary.numericAudit.mismatches += audit.comparisons.filter(item => !item.matches).length;
            logger(JSON.stringify({ step, numericAudit: audit }));
          }
        }
      }
      await snapshot(directory, 'after');
      if (!response.ok && response.error === 'TIMEOUT' && decision.request.cmd === 'end_turn') {
        const observed = observedEndTurnSelection(memory.data.pending, after);
        if (observed) { save(path.join(directory, 'timeout-response.json'), response); response = observed; }
      }
      if (!response.ok && response.error === 'EVENT_TIMEOUT') {
        const observed = observedEventProgress(current, decision.request, after);
        if (observed) { save(path.join(directory, 'timeout-response.json'), response); response = observed; }
      }
      memory.finish(response, after);
      if (memory.data.pending) summary.outcomeUnknown = true;
      memory.observe(after);
      observeRun(progress, after, path.join(directory, 'after-state.json'));
      memory.data.run_progress = progress;
      memory.persist();
      await onObservation?.(after);
      const changed = actionFingerprint(after) !== actionFingerprint(state);
      if (response.ok && decision.request.cmd === 'play_card') battle.playedCards++;
      if (response.ok && decision.request.cmd === 'end_turn') battle.endedTurns++;
      observeModBattle(battle, after, path.join(directory, 'after-state.json'));
      save(path.join(directory, 'result.json'), { request: decision.request, response, changed, battle: { ...battle } });
      logger(JSON.stringify({ step, screen: state.screen, request: decision.request, model: decision.model, modelCalls, strategicAssessments, ...(decision.turn_plan ? { turnObjective: decision.turn_plan.objective?.id, planRevision: decision.turn_plan.revision, plannedStep: decision.turn_step, planningCalls: decision.planning_trace?.length || 0 } : {}), ok: response.ok, changed, afterScreen: after.screen, act: after.decision_context?.act_index, floor: after.decision_context?.total_floor, hp: after.decision_context?.player?.hp, energy: after.combat?.player?.energy, enemies: after.combat?.enemies?.map(enemy => ({ name: enemy.name, hp: enemy.hp })) }));
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
