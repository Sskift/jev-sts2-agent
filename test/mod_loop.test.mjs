import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { actionFingerprint, observeModBattle, runModLoop } from '../src/mod_loop.mjs';
import { buildModCandidates } from '../src/mod_decision.mjs';

function combat(enemyHp = 20) {
  return {
    screen: 'COMBAT', timestamp: 1000,
    combat: {
      encounter: 'Offline test encounter', turn_number: 1,
      is_player_turn: true, is_player_actions_disabled: false, is_combat_ending: false,
      player: { hp: 70, max_hp: 80, block: 0, energy: 3 },
      hand: [{ index: 0, id: 'STRIKE_IRONCLAD', name: 'Strike', description: 'Deal 6 damage.', target_type: 'AnyEnemy', cost: 1, can_play: true }],
      enemies: [{ combat_id: 42, name: 'Offline enemy', hp: enemyHp, block: 0, is_alive: true }],
      draw_pile: [{ id: 'DEFEND_IRONCLAD' }, { id: 'STRIKE_IRONCLAD' }]
    }
  };
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
  const summary = await runModLoop({ client, decide: chooseAttack, artifactDir, intervalMs: 0, maxSteps: 5, logger() {} });
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
  const event = description => ({ screen: 'EVENT', event: { event_id: 'OFFLINE_EVENT', is_in_dialogue: false, is_finished: false, options: [{ index: 0, title: 'Accept', description, is_locked: false }] } });
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
