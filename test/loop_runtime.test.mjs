import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeActionPlan, observeBattle, observeDesktop, parseOptions, runLoopCycle, simulationFixture, startLoop } from '../src/agent_loop.mjs';

function temporaryFolder(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sts2-loop-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  return directory;
}
const reward = { scene: 'reward', player_turn: null, player: null, cards: [], enemies: [], selectable_options: [{ name: 'Gold', screen_pos: { x: 100, y: 100 } }], battle_result: 'victory', battle_evidence: 'Combat rewards panel', screen_size: { width: 1280, height: 720 } };

test('completion needs observed combat then reward, not main menu, empty enemies or defeat', () => {
  const { state } = simulationFixture();
  const tracker = { sawCombat: false, complete: false, failed: false };
  observeBattle(tracker, reward, 'unrelated-reward.png');
  assert.equal(tracker.complete, false);
  observeBattle(tracker, state, 'combat.png');
  observeBattle(tracker, { ...state, enemies: [] }, 'animation.png');
  assert.equal(tracker.complete, false);
  observeBattle(tracker, { ...reward, scene: 'main_menu' }, 'menu.png');
  assert.equal(tracker.complete, false);
  observeBattle(tracker, reward, 'won.png');
  assert.equal(tracker.complete, true);
  assert.equal(tracker.combatEvidence, 'combat.png');
  assert.equal(tracker.victoryEvidence, 'won.png');
  const failed = { sawCombat: true, complete: false, failed: false };
  observeBattle(failed, { ...reward, scene: 'game_over', battle_result: 'defeat' }, 'lost.png');
  observeBattle(failed, reward, 'reward.png');
  assert.equal(failed.failed, true);
  assert.equal(failed.complete, false);
});

test('window resize or identity change rejects stale actions before native execution', async () => {
  const capture = { hwnd: 55, width: 1280, height: 720 };
  for (const current of [{ ...capture, width: 640 }, { ...capture, hwnd: 56 }]) {
    await assert.rejects(executeActionPlan({ type: 'click', args: [5, 5] }, { capture, driver: { status: async () => current, execute: () => assert.fail('must not execute') } }), /changed after perception/);
  }
  await assert.rejects(executeActionPlan({ type: 'click', args: [5, 5] }, { strictDesktop: true, driver: { execute: async () => ({ foregroundUnchanged: false, cursorUnchanged: true }) } }), /Strict desktop observation/);
});

test('concurrent user desktop input is recorded without being attributed to window messages', async () => {
  const nativeResult = { hwnd: '0x55', foregroundUnchanged: false, cursorUnchanged: false,
    before: { foreground: '0x22', cursor: { x: 100, y: 100 } }, after: { foreground: '0x33', cursor: { x: 102, y: 100 } } };
  const result = await executeActionPlan({ type: 'click', args: [5, 5] }, { driver: { execute: async () => nativeResult } });
  assert.equal(result.executed, true);
  assert.equal(result.output.cursorUnchanged, false);
  assert.equal(result.output.desktopObservation.targetBecameForeground, false);
  assert.equal(result.output.desktopObservation.attribution, 'unattributed_desktop_change');
  assert.deepEqual(result.output.before, nativeResult.before);
  const activated = observeDesktop({ ...nativeResult, after: { ...nativeResult.after, foreground: '0X55' } }, 'window_action');
  assert.equal(activated.desktopObservation.targetBecameForeground, true);
  assert.equal(activated.desktopObservation.attribution, 'unattributed_desktop_change');
});

test('live-shaped cycle persists stages and verifies battle using a fresh post-action frame', async t => {
  const artifactDir = temporaryFolder(t);
  const { state, decision } = simulationFixture();
  const capture = { hwnd: 55, width: 1280, height: 720, foregroundUnchanged: true, cursorUnchanged: false };
  const captured = [];
  let perceptions = 0, executions = 0;
  const tracker = { sawCombat: false, complete: false, failed: false };
  const result = await runLoopCycle({
    driver: { capture: async file => { captured.push(file); fs.writeFileSync(file, 'offline-fixture'); return capture; }, status: async () => capture, execute: async action => { executions++; assert.equal(action.expectedWidth, 1280); return { foregroundUnchanged: true, cursorUnchanged: true }; } },
    perceiveFn: async () => ++perceptions === 1 ? state : reward,
    decisionFn: async () => decision,
    artifactDir, settleMs: 0, battleTracker: tracker, logger() {}
  });
  assert.equal(executions, 1);
  assert.equal(perceptions, 2);
  assert.equal(captured.length, 2);
  assert.equal(tracker.complete, true);
  assert.equal(result.afterState.scene, 'reward');
  assert.equal(JSON.parse(fs.readFileSync(path.join(artifactDir, 'step-0001', 'capture.json'), 'utf8')).desktopObservation.cursorChanged, true);
  assert.deepEqual(fs.readdirSync(path.join(artifactDir, 'step-0001')).sort(), ['action.json', 'after-capture.json', 'after-state.json', 'after.png', 'before.png', 'capture.json', 'decision.json', 'result.json', 'state.json'].sort());
});

test('bounded loop stops after verified victory and does not consume reward controls', async t => {
  const artifactDir = temporaryFolder(t);
  const { state, decision } = simulationFixture();
  const capture = { hwnd: 55, width: 1280, height: 720 };
  let frames = 0, actions = 0;
  const summary = await startLoop(0, {
    artifactDir, maxSteps: 10, untilBattleComplete: true, settleMs: 0, logger() {},
    driver: { capture: async file => { fs.writeFileSync(file, 'offline-fixture'); return capture; }, status: async () => capture, execute: async () => { actions++; return { foregroundUnchanged: true, cursorUnchanged: true }; } },
    perceiveFn: async () => ++frames === 1 ? state : reward, decisionFn: async () => decision
  });
  assert.equal(summary.steps, 1);
  assert.equal(summary.stoppedReason, 'battle_complete');
  assert.equal(actions, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(artifactDir, 'session.json'), 'utf8')).battle.complete, true);
});

test('CLI bounds are explicit and invalid arguments do not start a loop', () => {
  assert.equal(parseOptions(['--once']).maxSteps, 1);
  assert.equal(parseOptions(['--max-steps', '6', '--until-battle-complete']).maxSteps, 6);
  assert.equal(parseOptions(['--dry-run']).dryRun, true);
  assert.equal(parseOptions([]).strictDesktop, false);
  assert.equal(parseOptions(['--strict-desktop']).strictDesktop, true);
  for (const args of [['--max-steps', '0'], ['--max-steps', 'infinity'], ['--max-steps'], ['--bogus']]) assert.throws(() => parseOptions(args));
});
