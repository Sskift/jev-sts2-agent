import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDecisionContext, DecisionMemory, groupCards, routeFacts, deduplicateText, compactContext, validateDecisionPacket } from '../src/decision_context.mjs';
import { buildModCandidates, prepareModDecision, makeModDecisionWithJev } from '../src/mod_decision.mjs';
import { actionFingerprint, runModLoop } from '../src/mod_loop.mjs';
import { completeCombat, withContext, fixtureCard } from './fixtures/context.mjs';

const packet = (state, memory) => buildDecisionContext(state, { candidates: buildModCandidates(state), memory });
function temporary(t) {
  const base = path.resolve(os.tmpdir()), directory = fs.mkdtempSync(path.join(base, 'sts2-context-'));
  t.after(() => { assert.equal(path.dirname(directory), base); assert.ok(path.basename(directory).startsWith('sts2-context-')); fs.rmSync(directory, { recursive: true, force: true }); });
  return directory;
}

test('temporary Windows sharing violations do not lose the atomic memory write', t => {
  const file = path.join(temporary(t), 'memory.json');
  const memory = new DecisionMemory({ file });
  const rename = fs.renameSync;
  let calls = 0;
  t.mock.method(fs, 'renameSync', (...args) => {
    if (++calls < 3) throw Object.assign(new Error('Sharing violation'), { code: 'EPERM' });
    return rename(...args);
  });
  memory.persist();
  assert.equal(calls, 3);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), memory.data);
});

test('map decisions have current player, permanent deck, rules, downstream graph and executable options together', () => {
  const graph = { act_index: 0, nodes: [
    { col: 0, row: 1, type: 'MONSTER', children: [{ col: 0, row: 2 }] },
    { col: 1, row: 1, type: 'ELITE', children: [{ col: 1, row: 2 }] },
    { col: 0, row: 2, type: 'REST_SITE', children: [{ col: 0, row: 3 }] },
    { col: 1, row: 2, type: 'SHOP', children: [{ col: 0, row: 3 }] },
    { col: 0, row: 3, type: 'BOSS', children: [] }
  ] };
  const state = withContext({ screen: 'MAP', map: { ...graph, travelable_coords: [{ col: 0, row: 1 }, { col: 1, row: 1 }] } }, { map: graph });
  const value = packet(state);
  assert.equal(value.schema_version, 'sts2.decision.v1');
  assert.equal(value.player.gold, 90);
  assert.equal(value.deck.count, 1);
  assert.equal(value.map.routes[0].nearest_steps_after_chosen_node.REST_SITE, 1);
  assert.equal(value.map.routes[1].counts.ELITE.min, 1);
  assert.equal(value.map.routes[1].counts.REST_SITE.max, 0);
  assert.equal(value.map.routes[0].reaches_boss, true);
  assert.equal(value.map.nodes.length, 5);
  assert.deepEqual(value.legal_actions[1].request, { cmd: 'choose_map_node', args: [1, 1] });
  assert.equal(value.in_combat, false);
});

test('combat includes full pile contents, previous plays, exhausted cards, stable targets and no hidden move label', () => {
  const state = completeCombat();
  state.decision_context.combat_history = [{ sequence: 0, type: 'CardPlayFinishedEntry', card_id: 'BASH', result_pile: 'Discard', description: 'Bash was played.' }];
  const value = packet(state);
  assert.equal(value.player.hp, 40);
  assert.equal(value.combat.hand[0].damage, 6);
  assert.match(value.combat.draw_pile.cards[0].card.description, /5 Block/);
  assert.equal(value.combat.draw_pile.order, 'unknown');
  assert.equal(value.combat.discard_pile[0].id, 'BASH');
  assert.equal(value.combat.exhaust_pile[0].id, 'BURNING_PACT');
  assert.equal(value.combat.history[0].card_id, 'BASH');
  assert.equal(value.combat.enemies[0].move_id, undefined);
  assert.equal(value.combat.enemies[0].intents[0].hits, 2);
  assert.deepEqual(value.legal_actions[0].request, { cmd: 'play_card', id: 'STRIKE_IRONCLAD', nth: 0, target: 42 });
});

test('selection overlays retain their purpose plus underlying combat and complete run context', () => {
  const state = completeCombat();
  state.screen = 'HAND_SELECT';
  state.hand_select = { prompt: 'Exhaust a card', selected_count: 0, max_select: 1, selectable_cards: [{ index: 0, card_id: 'STRIKE_IRONCLAD', card_name: 'Strike', description: 'Deal 6 damage.' }] };
  const value = packet(state);
  assert.equal(value.in_combat, true);
  assert.equal(value.screen_state.hand_select.prompt, 'Exhaust a card');
  assert.equal(value.player.hp, 40);
  assert.equal(value.legal_actions[0].request.cmd, 'hand_select_card');
});

test('old mod, missing card rules, missing powers, extraction failures and mismatched counts fail before any API call', async () => {
  for (const alter of [
    s => { delete s.decision_context; },
    s => { delete s.combat.draw_pile[0].description; },
    s => { s.decision_context.extraction_errors = ['power description failed']; },
    s => { s.combat.player.discard_count++; },
    s => { s.decision_context.map.act_index++; },
    s => { s.combat.enemies[0].powers = [{ id: 'WEAK', amount: 2 }]; }
  ]) {
    const state = completeCombat(); alter(state);
    let calls = 0;
    await assert.rejects(makeModDecisionWithJev(state, { apiKey: 'test', fetchImpl: async () => { calls++; } }), /context|Missing|Incomplete|different act/);
    assert.equal(calls, 0);
  }
});

test('equivalent draw cards group losslessly; upgraded and enchanted copies remain distinct', () => {
  const first = fixtureCard('STRIKE', { details: { instance_id: 'b', upgrade_level: 0 } });
  const second = structuredClone(first); second.details.instance_id = 'a';
  const upgraded = fixtureCard('STRIKE', { cost: 0, is_upgraded: true, description: 'Deal 9 damage.', details: { instance_id: 'c', upgrade_level: 1 } });
  const values = groupCards([first, upgraded, second]);
  assert.equal(values.length, 2);
  const repeated = values.find(v => v.count === 2);
  assert.deepEqual(repeated.instance_ids, ['a', 'b']);
  assert.equal(values.reduce((n, v) => n + v.count, 0), 3);
  assert.equal(first.details.instance_id, 'b', 'Packing never mutates source evidence');
});

test('freshness notices draw/discard/exhaust, master deck, potion and relic changes; ignores only shuffle and timestamps', () => {
  const before = completeCombat();
  for (const mutate of [
    s => { s.combat.draw_pile[0].cost++; },
    s => { s.combat.discard_pile = []; },
    s => { s.combat.exhaust_pile[0].is_upgraded = true; },
    s => { s.decision_context.master_deck[0].description = 'Deal 9 damage.'; },
    s => { s.decision_context.player.potions.push({ id: 'HEAL' }); },
    s => { s.decision_context.player.relics.push({ id: 'RELIC' }); }
  ]) {
    const after = structuredClone(before); mutate(after);
    assert.notEqual(actionFingerprint(after), actionFingerprint(before));
  }
  const after = structuredClone(before); after.timestamp++; after.combat.draw_pile.reverse();
  assert.equal(actionFingerprint(after), actionFingerprint(before));
});

test('memory persists more than three actions, includes observed effects, and never mixes runs', t => {
  const file = path.join(temporary(t), 'memory.json'), state = completeCombat();
  let memory = new DecisionMemory({ file }); memory.observe(state);
  for (let i = 0; i < 7; i++) { memory.begin({ cmd: 'play_card', id: 'STRIKE_IRONCLAD', nth: 0, target: 42 }, state); memory.finish({ ok: true, data: { damage: 6 } }, state); }
  memory = new DecisionMemory({ file }); memory.observe(state);
  assert.equal(packet(state, memory).memory.actions.length, 7);
  assert.equal(packet(state, memory).memory.actions[0].played_card_at_request.cost, 1);
  const after = structuredClone(state); after.decision_context.player.hp -= 9; memory.observe(after);
  assert.deepEqual(memory.context(after).observations[0].changes.hp, { before: 40, after: 31 });
  after.decision_context.run_id = 'another-run'; memory.observe(after);
  assert.equal(memory.context(after).actions.length, 0);
  assert.equal(memory.context(after).observations.length, 0);
});

test('unresolved actions survive process restart and cannot be replayed automatically', async t => {
  const artifactDir = temporary(t), file = path.join(artifactDir, 'memory.json'), state = completeCombat();
  const memory = new DecisionMemory({ file }); memory.observe(state); memory.begin({ cmd: 'end_turn' }, state);
  let sends = 0, decisions = 0;
  const summary = await runModLoop({ artifactDir, memoryFile: file, maxSteps: 1, logger() {}, client: { state: async () => state, request: async () => { sends++; } }, decide: async () => { decisions++; } });
  assert.match(summary.error, /unresolved outcome/);
  assert.equal(summary.outcomeUnknown, true);
  assert.equal(sends, 0); assert.equal(decisions, 0);
});

test('route calculations preserve branch uncertainty and reject broken topology', () => {
  const map = { nodes: [
    { col: 0, row: 0, type: 'UNKNOWN', children: [{ col: 0, row: 1 }, { col: 1, row: 1 }] },
    { col: 0, row: 1, type: 'ELITE', children: [{ col: 0, row: 2 }] },
    { col: 1, row: 1, type: 'REST_SITE', children: [{ col: 0, row: 2 }] },
    { col: 0, row: 2, type: 'BOSS', children: [] }
  ] };
  const result = routeFacts(map, [{ col: 0, row: 0 }])[0];
  assert.deepEqual(result.counts.ELITE, { min: 0, max: 1 });
  assert.deepEqual(result.counts.UNKNOWN, { min: 1, max: 1 });
  map.nodes[1].children = [{ col: 9, row: 9 }];
  assert.throws(() => routeFacts(map, [{ col: 0, row: 0 }]), /missing node/);
  map.nodes[1].children = [{ col: 0, row: 0 }];
  assert.throws(() => routeFacts(map, [{ col: 0, row: 0 }]), /cycle/);
});

test('long repeated rules can be restored exactly from the same request; oversize data never silently truncates', async () => {
  const description = 'An observed rule with exact numbers and exceptions. '.repeat(8);
  const original = { one: description, nested: [{ two: description }], short: 'x' };
  const packed = deduplicateText(original);
  const expand = value => value?.text_ref ? packed.text_dictionary[value.text_ref] : Array.isArray(value) ? value.map(expand) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v)])) : value;
  const { text_dictionary, ...body } = packed;
  assert.deepEqual(expand(body), original);
  const state = completeCombat();
  state.decision_context.glossary = [{ title: 'Distinct relevant rules', description: 'x'.repeat(40000) }];
  let calls = 0;
  await assert.rejects(makeModDecisionWithJev(state, { maxRequestBytes: 30000, apiKey: 'test', fetchImpl: async () => { calls++; } }), /no facts were truncated/);
  assert.equal(calls, 0);
});

test('every independent API request contains the full JSON context and exactly the offered action IDs', async () => {
  const state = completeCombat(), memory = new DecisionMemory(); memory.observe(state);
  const requests = [];
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body); requests.push(request);
    assert.equal(request.state.schema_version, 'sts2.decision.v1');
    assert.deepEqual(Object.keys(request.questions.next_action.criteria), request.state.legal_actions.map(a => a.action_id));
    return { ok: true, json: async () => ({ model: 'offline', usage: { input_tokens: 2400 }, answers: { next_action: { type: 'choice', choice: 'end_turn' } } }) };
  };
  await makeModDecisionWithJev(state, { memory, apiKey: 'test', fetchImpl });
  memory.begin({ cmd: 'end_turn' }, state); memory.finish({ ok: true }, state);
  const result = await makeModDecisionWithJev(state, { memory, apiKey: 'test', fetchImpl });
  for (const request of requests) {
    assert.ok(request.state.map.nodes.length);
    assert.ok(request.state.deck.cards.length);
    assert.equal(request.state.player.hp, 40);
    assert.equal(request.state.combat.exhaust_pile.length, 1);
  }
  assert.equal(requests[1].state.memory.actions.length, 1);
  assert.equal(result.usage.input_tokens, 2400);
  assert.ok(result.context_metrics.request_bytes > 1000);
});

test('the loop requests full pile details for every observation and saves the exact model request before execution', async t => {
  const artifactDir = temporary(t), state = completeCombat(), reads = [], states = [state, state, state];
  const summary = await runModLoop({ artifactDir, maxSteps: 1, intervalMs: 0, logger() {}, client: {
    state: async options => { reads.push(options); return structuredClone(states.shift()); },
    request: async () => ({ ok: true, data: { ended: true } })
  }, decide: (_state, options) => { assert.equal(options.prepared.payload.state.player.hp, 40); return buildModCandidates(state).get('end_turn'); } });
  assert.equal(summary.error, undefined);
  assert.equal(reads.length, 3);
  assert.ok(reads.every(r => r.includePileDetails === true));
  const request = JSON.parse(fs.readFileSync(path.join(artifactDir, 'step-0001', 'jev-request.json'), 'utf8'));
  assert.equal(request.state.combat.exhaust_pile[0].id, 'BURNING_PACT');
});

test('history table and text dictionary restore every original event and ordering, including omitted fields', () => {
  const state = completeCombat();
  state.decision_context.combat_history = Array.from({ length: 100 }, (_, sequence) => ({ sequence, type: sequence % 2 ? 'CardPlayFinishedEntry' : 'DamageReceivedEntry', description: 'Observed Strike dealing exactly 6 damage to a visible enemy.', ...(sequence % 2 ? { result_pile: 'Discard' } : { hp_loss: 6 }) }));
  const original = packet(state), compact = compactContext(original);
  validateDecisionPacket(compact);
  const expand = item => {
    if (item?.text_ref) return compact.text_dictionary[item.text_ref];
    if (item?.encoding === 'record_table_v1') return item.rows.map(([layout, ...values]) => Object.fromEntries(item.layouts[layout].map((key, i) => [key, expand(values[i])])));
    if (Array.isArray(item)) return item.map(expand);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'text_dictionary').map(([key, value]) => [key, expand(value)]));
    return item;
  };
  assert.deepEqual(expand(compact), original);
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) < Buffer.byteLength(JSON.stringify(original)));
});

test('JSON Schema rejects unknown protocol versions, missing choices and invalid numeric types', () => {
  for (const change of [p => { p.schema_version = 'v99'; }, p => { delete p.legal_actions; }, p => { p.player.hp = '40'; }]) {
    const value = packet(completeCombat()); change(value);
    assert.throws(() => validateDecisionPacket(value), /versioned protocol/);
  }
  const value = packet(completeCombat());
  value.rules = [{ title: 'Broken reference', description: { text_ref: 'rule_99' } }];
  assert.throws(() => validateDecisionPacket(value), /Dangling/);
});

test('potion choices use authoritative usability/targets and nth among every same-ID slot', () => {
  const state = completeCombat();
  state.combat.player.potions = [
    { slot: 0, id: 'FIRE_POTION', name: 'Fire Potion', description: 'Deal 20 damage.', can_use: false, target_type: 'AnyEnemy', valid_target_ids: [42] },
    { slot: 2, id: 'FIRE_POTION', name: 'Fire Potion', description: 'Deal 20 damage.', can_use: true, target_type: 'AnyEnemy', valid_target_ids: [42] },
    { slot: 3, id: 'FAIRY', name: 'Fairy', description: 'Revive automatically.', can_use: false, target_type: 'Self', valid_target_ids: [] }
  ];
  state.combat.hand[0].valid_target_ids = [];
  const choices = buildModCandidates(state);
  assert.equal(choices.has('card_0_target_42'), false);
  assert.equal(choices.has('potion_0_target_42'), false);
  assert.equal(choices.has('potion_3'), false);
  assert.deepEqual(choices.get('potion_2_target_42').request, { cmd: 'use_potion', id: 'FIRE_POTION', nth: 1, target: 42 });
});

test('a mod-side action timeout remains unresolved in persistent memory', t => {
  const file = path.join(temporary(t), 'memory.json'), state = completeCombat();
  const memory = new DecisionMemory({ file }); memory.observe(state); memory.begin({ cmd: 'end_turn' }, state);
  memory.finish({ ok: false, error: 'TIMEOUT' }, state);
  assert.equal(new DecisionMemory({ file }).data.pending.outcome_unknown, true);
});

test('legacy map DTO cannot disclose an unrevealed extra boss through a future edge', () => {
  const state = withContext({ screen: 'MAP', map: { travelable_coords: [{ col: 0, row: 1 }], nodes: [
    { col: 0, row: 1, type: 'BOSS', state: 'TRAVELABLE', children: [{ col: 0, row: 2 }] },
    { col: 0, row: 2, type: 'BOSS', state: 'UNTRAVELABLE', children: [] }
  ] } });
  const value = packet(state);
  assert.equal(value.map.nodes.some(n => n.row === 2), false);
  assert.deepEqual(value.map.nodes.find(n => n.row === 1).children, []);
});

test('ally-targeted cards never add an implicit self target that the mod disallows', () => {
  const state = completeCombat();
  state.combat.hand[0].target_type = 'AnyAlly';
  state.combat.hand[0].valid_target_ids = [17];
  state.combat.player.pets = [{ combat_id: 17, name: 'Osty', is_alive: true }];
  const choices = buildModCandidates(state);
  assert.equal(choices.has('card_0'), false);
  assert.deepEqual(choices.get('card_0_ally_17').request, { cmd: 'play_card', id: 'STRIKE_IRONCLAD', nth: 0, target: 17 });
});
