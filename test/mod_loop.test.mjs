import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { actionFingerprint, observeModBattle, runModLoop, observedEndTurnSelection, observedEventProgress } from '../src/mod_loop.mjs';
import { DecisionMemory } from '../src/decision_context.mjs';
import { canonicalObservation } from '../src/observation_state.mjs';
import { turnFingerprint, turnGuard } from '../src/turn_plan_state.mjs';
import { buildModCandidates } from '../src/mod_decision.mjs';
import { ModTransportError } from '../src/mod_client.mjs';
import { withContext } from './fixtures/context.mjs';

function combat(enemyHp = 20) {
  return withContext({
    screen: 'COMBAT', timestamp: 1000,
    combat: {
      encounter: 'Offline test encounter', turn_number: 1,
      is_player_turn: true, is_player_actions_disabled: false, is_combat_ending: false,
      player: { hp: 70, max_hp: 80, block: 0, energy: 3 },
      hand: [{ index: 0, id: 'STRIKE_IRONCLAD', name: 'Strike', description: 'Deal 6 damage.', target_type: 'AnyEnemy', cost: 1, can_play: true }],
      enemies: [{ combat_id: 42, name: 'Offline enemy', hp: enemyHp, block: 0, is_alive: true }],
      draw_pile: [{ id: 'DEFEND_IRONCLAD' }, { id: 'STRIKE_IRONCLAD' }]
    }
  });
}

const reward = () => ({ screen: 'REWARD', rewards: { rewards: [{ type: 'gold', amount: 15 }] } });
const tracker = () => ({ sawCombat: false, complete: false, failed: false, playedCards: 0, endedTurns: 0 });

function temporaryFolder(t) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'sts2-mod-loop-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), temporaryRoot);
    assert.ok(path.basename(directory).startsWith('sts2-mod-loop-test-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function scriptedClient(states, onRequest = async () => ({ ok: true, data: {} })) {
  let index = 0;
  const requests = [];
  return {
    requests,
    get reads() { return index; },
    async state() {
      assert.ok(index < states.length, 'Unexpected state read; the loop may have replayed an action');
      return structuredClone(states[index++]);
    },
    async request(request) {
      requests.push(structuredClone(request));
      return onRequest(request);
    }
  };
}

function chooseAttack(state) {
  const choice = [...buildModCandidates(state).values()].find(candidate => candidate.request.cmd === 'play_card');
  assert.ok(choice, 'Offline combat fixture needs an attack candidate');
  return choice;
}

test('Happy Flower activation display does not discard paid decisions or change gameplay counters', async t => {
  const initial = combat(), settled = combat(), artifactDir = temporaryFolder(t);
  for (const [state, counter] of [[initial, 3], [settled, 0]]) {
    const relics = [{ id: 'HAPPY_FLOWER', name: 'Happy Flower', description: 'Every 3 turns, gain 1 Energy.', counter }];
    state.decision_context.player.relics = relics;
    state.combat.player.relics = structuredClone(relics);
  }
  assert.equal(canonicalObservation(initial).combat.player.relics[0].counter, 0);
  assert.equal(initial.combat.player.relics[0].counter, 3, 'raw observation remains intact');
  assert.equal(actionFingerprint(initial), actionFingerprint(settled));
  assert.equal(turnFingerprint(initial), turnFingerprint(settled));
  assert.deepEqual(turnGuard(initial), turnGuard(settled));
  const memory = new DecisionMemory();
  memory.observe(initial); memory.observe(settled);
  assert.equal(memory.data.observations.length, 0, 'animation is not recorded as a gameplay event');
  const client = scriptedClient([initial, settled, reward()]);
  const seen = [];
  const result = await runModLoop({ client, artifactDir, maxSteps: 1, intervalMs: 0, logger() {}, decide: state => {
    seen.push(canonicalObservation(state).combat.player.relics[0].counter);
    return chooseAttack(state);
  } });
  assert.equal(result.error, undefined);
  assert.deepEqual(seen, [0]);
  assert.equal(client.requests.length, 1);
  assert.ok(fs.existsSync(path.join(artifactDir, 'step-0001', 'response.json')));
  for (const change of [
    state => { state.combat.player.energy++; },
    state => { state.combat.player.relics[0].counter = 1; },
    state => { state.combat.player.relics[0].status = 'Active'; },
    state => { state.combat.player.relics[0].id = 'OTHER_RELIC'; }
  ]) {
    const different = structuredClone(initial); change(different);
    assert.notEqual(actionFingerprint(initial), actionFingerprint(different));
    assert.notEqual(turnFingerprint(initial), turnFingerprint(different));
  }
  const otherBefore = structuredClone(initial), otherAfter = structuredClone(initial);
  otherBefore.combat.player.relics[0].id = otherAfter.combat.player.relics[0].id = 'OTHER_RELIC';
  otherAfter.combat.player.relics[0].counter = 0;
  assert.notEqual(actionFingerprint(otherBefore), actionFingerprint(otherAfter), 'other counters stay authoritative');
});

function enemySelection() {
  const state = combat();
  state.screen = 'TRI_SELECT';
  state.combat.is_player_turn = false;
  state.combat.is_player_actions_disabled = true;
  state.tri_select = { min_select: 1, max_select: 1, can_skip: false, cards: [{ index: 0, card_id: 'STATUS_A', card_name: 'Status A', description: 'A visible test effect.', cost: -1 }] };
  return state;
}

test('end-turn transport timeout yields to an observed mandatory enemy selection without replay', async t => {
  const initial = combat(), modal = enemySelection(), artifactDir = temporaryFolder(t);
  const client = scriptedClient([initial, initial, modal, modal], async request => { throw new ModTransportError('Timed out after dispatch', { request, dispatched: true, code: 'MOD_TIMEOUT' }); });
  const result = await runModLoop({ client, artifactDir, maxSteps: 1, intervalMs: 0, logger() {}, decide: () => ({ action: 'mod_command', request: { cmd: 'end_turn' } }) });
  assert.equal(result.error, undefined);
  assert.deepEqual(client.requests, [{ cmd: 'end_turn' }]);
  const memory = JSON.parse(fs.readFileSync(path.join(artifactDir, 'memory.json')));
  assert.equal(memory.pending, null);
  assert.equal(memory.actions[0].result.turn_completed, false);
  assert.equal(memory.actions[0].result.command_replayed, false);
});

test('a pending end-turn resumes at the observed selection, but different combat or active player phase stays unresolved', async t => {
  const initial = combat(), modal = enemySelection(), artifactDir = temporaryFolder(t), memoryFile = path.join(artifactDir, 'memory.json');
  const memory = new DecisionMemory({ file: memoryFile });
  memory.observe(initial); memory.begin({ cmd: 'end_turn' }, initial);
  const pending = structuredClone(memory.data.pending);
  assert.ok(observedEndTurnSelection(pending, modal));
  const wrong = structuredClone(modal); wrong.combat.is_player_turn = true;
  assert.equal(observedEndTurnSelection(pending, wrong), null);
  assert.equal(observedEndTurnSelection({ ...pending, combat_id: 'different' }, modal), null);
  assert.equal(observedEndTurnSelection({ ...pending, request: { cmd: 'play_card' } }, modal), null);
  assert.equal(observedEndTurnSelection({ ...pending, round: 5 }, modal), null);
  const client = scriptedClient([modal, modal, initial]);
  const result = await runModLoop({ client, artifactDir, memoryFile, maxSteps: 1, intervalMs: 0, logger() {}, decide: state => [...buildModCandidates(state).values()][0] });
  assert.equal(result.error, undefined);
  assert.deepEqual(client.requests, [{ cmd: 'tri_select_card', card_ids: ['STATUS_A'], nth_values: [0] }]);
  const saved = JSON.parse(fs.readFileSync(memoryFile));
  assert.equal(saved.actions.filter(action => action.request.cmd === 'end_turn').length, 1);
});

test('changed effects on same-title event options reconcile a timeout without replay', async t => {
  const initial = withContext({ screen: 'EVENT', event: { event_id: 'BRIDGE', is_finished: false, options: [{ index: 0, title: 'Hold On', description: 'Lose 3 HP.', text_key: 'HOLD_0', is_locked: false }] } });
  const after = structuredClone(initial);
  after.event.options[0].description = 'Lose 4 HP.';
  after.event.options[0].text_key = 'HOLD_1';
  after.decision_context.player.hp -= 3;
  const request = { cmd: 'choose_event', args: [0] }, artifactDir = temporaryFolder(t);
  const client = scriptedClient([initial, initial, after], async () => ({ ok: false, error: 'EVENT_TIMEOUT' }));
  const result = await runModLoop({ client, artifactDir, maxSteps: 1, intervalMs: 0, logger() {}, decide: () => ({ action: 'mod_command', request }) });
  assert.equal(result.stoppedReason, 'max_steps');
  assert.deepEqual(client.requests, [request]);
  const memory = JSON.parse(fs.readFileSync(path.join(artifactDir, 'memory.json')));
  assert.equal(memory.pending, null);
  assert.equal(memory.actions[0].result.reason, 'observed_event_progress');
  assert.equal(memory.actions[0].result.command_replayed, false);
  const wrong = structuredClone(after); wrong.decision_context.run_id = 'another-run';
  assert.equal(observedEventProgress(initial, request, wrong), null);
  wrong.decision_context.run_id = initial.decision_context.run_id; wrong.event.event_id = 'OTHER';
  assert.equal(observedEventProgress(initial, request, wrong), null);
});

test('an event timeout without changed choices remains unresolved even if HP changes', async t => {
  const initial = withContext({ screen: 'EVENT', event: { event_id: 'BRIDGE', is_finished: false, options: [{ index: 0, title: 'Hold On', description: 'Lose 3 HP.', is_locked: false }] } });
  const after = structuredClone(initial); after.decision_context.player.hp -= 3;
  const request = { cmd: 'choose_event', args: [0] }, artifactDir = temporaryFolder(t);
  assert.equal(observedEventProgress(initial, request, after), null);
  const client = scriptedClient([initial, initial, after], async () => ({ ok: false, error: 'EVENT_TIMEOUT' }));
  const result = await runModLoop({ client, artifactDir, maxSteps: 2, intervalMs: 0, logger() {}, decide: () => ({ action: 'mod_command', request }) });
  assert.equal(result.outcomeUnknown, true);
  assert.deepEqual(client.requests, [request]);
  const memory = JSON.parse(fs.readFileSync(path.join(artifactDir, 'memory.json')));
  assert.equal(memory.pending.error, 'EVENT_TIMEOUT');
});

test('reward without observed combat never meets battle acceptance', () => {
  const battle = tracker();
  observeModBattle(battle, reward(), 'unrelated-reward.json');
  assert.equal(battle.complete, false);
  assert.equal(battle.sawCombat, false);
  assert.equal(battle.victoryEvidence, undefined);
});

test('observed combat followed by rewards needs a successful card action', () => {
  const battle = tracker();
  observeModBattle(battle, combat(), 'before-combat.json');
  observeModBattle(battle, reward(), 'manual-or-event-reward.json');
  assert.equal(battle.sawCombat, true);
  assert.equal(battle.playedCards, 0);
  assert.equal(battle.complete, false);
  battle.playedCards = 1;
  observeModBattle(battle, { screen: 'REWARD', rewards: { rewards: [] } }, 'empty-reward.json');
  assert.equal(battle.complete, false);
});

test('death or game over prevents later reward from becoming a success', () => {
  const dead = combat();
  dead.combat.player.hp = 0;
  for (const terminal of [dead, { screen: 'GAME_OVER', game_over: { is_victory: false } }]) {
    const battle = tracker();
    observeModBattle(battle, combat(), 'live-combat.json');
    battle.playedCards = 1;
    observeModBattle(battle, terminal, 'death.json');
    observeModBattle(battle, reward(), 'later-reward.json');
    assert.equal(battle.failed, true);
    assert.equal(battle.complete, false);
    assert.equal(battle.failureEvidence, 'death.json');
  }
});

test('a successful card then fresh rewards completes once and saves acceptance evidence', async t => {
  const artifactDir = temporaryFolder(t);
  const client = scriptedClient([combat(), combat(), reward()]);
  const summary = await runModLoop({ client, decide: chooseAttack, artifactDir, intervalMs: 0, maxSteps: 5, stopAfterBattle: true, logger() {} });
  assert.equal(summary.stoppedReason, 'battle_complete');
  assert.equal(summary.steps, 1);
  assert.equal(summary.battle.complete, true);
  assert.equal(summary.battle.playedCards, 1);
  assert.equal(client.requests.length, 1);
  assert.match(summary.battle.combatEvidence, /before-state\.json$/);
  assert.match(summary.battle.victoryEvidence, /after-state\.json$/);
  const saved = JSON.parse(fs.readFileSync(path.join(artifactDir, 'session.json'), 'utf8'));
  assert.equal(saved.battle.complete, true);
});

test('same-scene combat change while deciding discards the stale request', async t => {
  const artifactDir = temporaryFolder(t);
  const client = scriptedClient([combat(20), combat(14)]);
  const summary = await runModLoop({ client, decide: chooseAttack, artifactDir, intervalMs: 0, maxSteps: 1, logger() {} });
  assert.equal(client.requests.length, 0);
  assert.equal(summary.battle.playedCards, 0);
  assert.equal(summary.battle.complete, false);
  const result = JSON.parse(fs.readFileSync(path.join(artifactDir, 'step-0001', 'result.json'), 'utf8'));
  assert.equal(result.executed, false);
  assert.match(result.reason, /State changed/);
});

test('a changed event effect at the same option index discards the stale request', async t => {
  const artifactDir = temporaryFolder(t);
  const event = description => withContext({ screen: 'EVENT', event: { event_id: 'OFFLINE_EVENT', is_in_dialogue: false, is_finished: false, options: [{ index: 0, title: 'Accept', description, is_locked: false }] } });
  const client = scriptedClient([event('Gain 10 gold.'), event('Lose 10 HP.')]);
  const summary = await runModLoop({ client, decide: state => [...buildModCandidates(state).values()][0], artifactDir, intervalMs: 0, maxSteps: 1, logger() {} });
  assert.equal(client.requests.length, 0, 'A same-index option may have a different effect after an event page changes');
  assert.equal(summary.error, undefined);
});

test('mod command rejection stops after one send and never counts a successful card', async t => {
  const artifactDir = temporaryFolder(t);
  const client = scriptedClient([combat(), combat(), combat()], async () => ({ ok: false, error: 'CANNOT_PLAY_CARD', message: 'No longer playable' }));
  let decisions = 0;
  const summary = await runModLoop({ client, decide: state => { decisions++; return chooseAttack(state); }, artifactDir, intervalMs: 0, maxSteps: 5, logger() {} });
  assert.equal(client.requests.length, 1);
  assert.equal(decisions, 1);
  assert.equal(summary.battle.playedCards, 0);
  assert.equal(summary.battle.complete, false);
  assert.match(summary.stoppedReason, /Mod rejected action: CANNOT_PLAY_CARD/);
});

test('unknown command outcome stops without automatically replaying the request', async t => {
  const artifactDir = temporaryFolder(t);
  const timeout = Object.assign(new Error('Sent action timed out'), { outcomeUnknown: true });
  const client = scriptedClient([combat(), combat()], async () => { throw timeout; });
  const summary = await runModLoop({ client, decide: chooseAttack, artifactDir, intervalMs: 0, maxSteps: 5, logger() {} });
  assert.equal(client.requests.length, 1);
  assert.equal(client.reads, 2);
  assert.equal(summary.outcomeUnknown, true);
  assert.equal(summary.error, timeout.message);
  assert.equal(summary.battle.complete, false);
  assert.match(summary.stoppedReason, /no automatic action replay/);
});

test('a failed connection clears only the unsent action and reobserves before deciding', async t => {
  const artifactDir = temporaryFolder(t), memoryFile = path.join(artifactDir, 'memory.json');
  let calls = 0, decisions = 0;
  const client = scriptedClient([combat(20), combat(20), combat(12), combat(12), reward()], async request => {
    if (++calls === 1) throw new ModTransportError('Pipe temporarily absent', { code: 'ENOENT', request, dispatched: false });
    return { ok: true };
  });
  const summary = await runModLoop({ client, memoryFile, decide: state => { decisions++; return chooseAttack(state); }, artifactDir, intervalMs: 0, maxSteps: 2, stopAfterBattle: true, logger() {} });
  const saved = JSON.parse(fs.readFileSync(memoryFile, 'utf8'));
  assert.equal(decisions, 2);
  assert.equal(summary.battle.playedCards, 1);
  assert.equal(saved.pending, null);
  assert.equal(saved.actions[0].result, 'NOT_DISPATCHED');
  assert.equal(saved.actions[0].ok, false);
});

test('combat progress in one screen resets the unchanged-action limit', async t => {
  const artifactDir = temporaryFolder(t);
  const states = [];
  for (let index = 0; index < 4; index++) states.push(combat(30 - index), combat(30 - index), combat(29 - index));
  const client = scriptedClient(states);
  const summary = await runModLoop({ client, decide: chooseAttack, artifactDir, intervalMs: 0, maxSteps: 4, logger() {} });
  assert.equal(client.requests.length, 4);
  assert.equal(summary.steps, 4);
  assert.equal(summary.stoppedReason, 'max_steps');
  assert.equal(summary.battle.complete, false);
  for (let index = 1; index <= 4; index++) {
    const result = JSON.parse(fs.readFileSync(path.join(artifactDir, `step-${String(index).padStart(4, '0')}`, 'result.json'), 'utf8'));
    assert.equal(result.changed, true);
  }
});

test('fresh extraction time and hidden draw order do not invalidate an unchanged action', () => {
  const before = combat();
  const after = structuredClone(before);
  after.timestamp += 1000;
  after.combat.draw_pile.reverse();
  assert.equal(actionFingerprint(before), actionFingerprint(after));
  after.combat.enemies[0].block = 5;
  assert.notEqual(actionFingerprint(before), actionFingerprint(after));
});
