import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDecisionContext, DecisionMemory, groupCards, routeFacts, deduplicateText, compactContext, validateDecisionPacket, expandRecordTables } from '../src/decision_context.mjs';
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

test('frequent relic updates retain each value and ordering without repeated nested snapshots', () => {
  const state = completeCombat(), memory = new DecisionMemory(); memory.observe(state);
  const relic = { id: 'KUNAI', name: 'Kunai', description: 'Every 3 Attacks grant 1 Dexterity.', counter: 0, status: 'Normal' };
  for (let i = 0; i < 12; i++) memory.data.observations.push({ floor: 1, combat_id: 'offline-combat', changes: {
    relics: { before: [{ ...relic, counter: i % 3 }], after: [{ ...relic, counter: (i + 1) % 3 }] },
    ...(i === 5 ? { hp: { before: 40, after: 35 } } : {})
  } });
  const original = structuredClone(memory.data.observations), result = memory.context(state);
  assert.equal(result.relic_updates.length, 12);
  assert.deepEqual(result.relic_updates.map(update => [update.observation_sequence, update.before, update.after]), Array.from({ length: 12 }, (_, i) => [i, i % 3, (i + 1) % 3]));
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].observation_sequence, 5);
  assert.deepEqual(result.observations[0].changes.hp, { before: 40, after: 35 });
  assert.deepEqual(memory.data.observations, original);
  const built = packet(state, memory), packed = compactContext(built);
  assert.deepEqual(expandRecordTables(packed).memory.relic_updates, built.memory.relic_updates);
  validateDecisionPacket(packed);
});

test('matching card choices join the game history with rules and targets, while ambiguous autoplay stays separate', () => {
  const state = completeCombat(), memory = new DecisionMemory(); memory.observe(state);
  memory.begin({ cmd: 'play_card', id: 'STRIKE_IRONCLAD', nth: 0, target: 42 }, state);
  memory.finish({ ok: true }, state);
  state.decision_context.combat_history = [
    { sequence: 0, round: 2, type: 'CardPlayStartedEntry', actor_id: 0, card_id: 'STRIKE_IRONCLAD', card_instance_id: 'STRIKE_IRONCLAD' },
    { sequence: 1, round: 2, type: 'DamageReceivedEntry', actor_id: 42, amount: 6 },
    { sequence: 2, round: 2, type: 'CardPlayFinishedEntry', actor_id: 0, card_id: 'STRIKE_IRONCLAD', card_instance_id: 'STRIKE_IRONCLAD' }
  ];
  const original = structuredClone(memory.data), result = packet(state, memory);
  assert.equal(result.memory.actions.length, 0);
  assert.equal(result.combat.history.length, 3);
  assert.equal(result.combat.history[0].played_card_at_request.description, 'Deal 6 damage.');
  assert.equal(result.combat.history[0].selected_target_combat_id, 42);
  assert.equal(result.combat.history[0].selected_duplicate_nth, 0);
  assert.deepEqual(memory.data, original);
  const packed = compactContext(result), expanded = expandRecordTables(packed);
  assert.ok(expanded.combat.history[0].played_card_at_request.card_state_ref);
  validateDecisionPacket(packed);
  state.decision_context.combat_history.push({ ...state.decision_context.combat_history[0], sequence: 3 });
  const ambiguous = packet(state, memory);
  assert.equal(ambiguous.memory.actions.length, 1);
  assert.equal(ambiguous.combat.history[0].played_card_at_request, undefined);
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
  const prepared = prepareModDecision(state);
  assert.equal(prepared.payload.state.deck.statistics.non_basic_attacks, 0);
  assert.match(prepared.payload.questions.next_action.criteria.map_1_1.effect, /nearest known elite 0 steps, rest none reachable/);
});

test('map context keeps every future branch and the visited route while omitting expired forks', () => {
  const graph = { act_index: 0, current_coord: { col: 0, row: 2 }, visited: [{ col: 0, row: 1 }], nodes: [
    { col: 0, row: 1, type: 'MONSTER', children: [{ col: 0, row: 2 }] },
    { col: 1, row: 1, type: 'SHOP', children: [{ col: 0, row: 2 }] },
    { col: 0, row: 2, type: 'REST_SITE', children: [{ col: 0, row: 3 }] },
    { col: 0, row: 3, type: 'MONSTER', children: [{ col: 0, row: 4 }] },
    { col: 1, row: 3, type: 'SHOP', children: [{ col: 0, row: 4 }] },
    { col: 0, row: 4, type: 'BOSS', children: [] }
  ] };
  const state = withContext({ screen: 'MAP', map: { ...graph, travelable_coords: [{ col: 0, row: 3 }] } }, { map: graph });
  const value = packet(state);
  assert.deepEqual(value.map.visited, [{ col: 0, row: 1, type: 'MONSTER' }]);
  assert.equal(value.map.nodes.length, 4);
  assert.ok(value.map.nodes.some(n => n.col === 1 && n.row === 3));
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

test('rest upgrade previews match deck instances without recording hypothetical upgrades as deck changes', () => {
  const instance = 'abcdef0123456789abcdef0123456789';
  const state = withContext({ screen: 'REST_SITE', rest_site: { options: [
    { option_id: 'HEAL', name: 'Rest', description: 'Heal 24 HP.', is_enabled: true },
    { option_id: 'SMITH', name: 'Smith', description: 'Upgrade 1 card.', is_enabled: true }
  ] } }, { master_deck: [fixtureCard('STRIKE_IRONCLAD', { details: { instance_id: instance, upgrade_level: 0 } })],
    deck_upgrade_previews: [{ deck_index: 0, instance_id: instance, card_id: 'STRIKE_IRONCLAD', name: 'Strike+', description: 'Deal 9 damage.', cost: 1 }] });
  const memory = new DecisionMemory(); memory.observe(state);
  const value = packet(state, memory), preview = value.screen_state.rest_site.deck_upgrade_previews[0];
  assert.equal(preview.instance_id, value.deck.cards[0].instance_ids[0]);
  assert.equal(preview.description, 'Deal 9 damage.');
  assert.equal(value.deck.cards[0].card.description, 'Deal 6 damage.');
  assert.equal(value.deck.cards[0].card.is_upgraded, false);
  assert.deepEqual(expandRecordTables(compactContext(value)).screen_state.rest_site.deck_upgrade_previews, value.screen_state.rest_site.deck_upgrade_previews);
  const after = structuredClone(state); after.screen = 'MAP'; delete after.rest_site; delete after.decision_context.deck_upgrade_previews;
  memory.observe(after);
  assert.equal(memory.data.observations.length, 0);
});

test('selection shows its recorded trigger after restart without attributing a different room or run', t => {
  const file = path.join(temporary(t), 'memory.json'), memory = new DecisionMemory({ file });
  const option = { index: 0, title: 'Paperweight', description: 'Choose 1 card to add to your Deck.', is_locked: false };
  const before = withContext({ screen: 'EVENT', event: { options: [option] } });
  const after = withContext({ screen: 'TRI_SELECT', tri_select: { selection_type: 'choose_card', prompt: 'Choose a Card', min_select: 0, max_select: 1, can_skip: true, cards: [] } });
  memory.observe(before); memory.begin({ cmd: 'choose_event', args: [0] }, before);
  memory.finish({ ok: true, data: { event_state: { options: [{ ...option, was_chosen: true }] } } }, after); memory.observe(after);
  const restored = new DecisionMemory({ file }), result = packet(after, restored);
  assert.equal(result.screen_state.preceding_observed_action.selected_event_option.description, option.description);
  for (const change of [state => { state.decision_context.total_floor++; }, state => { state.decision_context.run_id = 'other-run'; }, state => { state.decision_context.combat_id = 'other-combat'; }]) {
    const unrelated = structuredClone(after); change(unrelated);
    assert.equal(packet(unrelated, restored).screen_state.preceding_observed_action, undefined);
  }
  restored.begin({ cmd: 'proceed' }, after); restored.finish({ ok: true }, { ...after, screen: 'MAP' });
  assert.equal(packet(after, restored).screen_state.preceding_observed_action, undefined);
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

test('memory removes only travel already in this act map and redundant successful command echoes', () => {
  const state = completeCombat(), memory = new DecisionMemory();
  state.decision_context.total_floor = 23;
  state.decision_context.act_floor = 5;
  state.decision_context.map.visited = [{ col: 1, row: 2 }];
  memory.observe(state);
  const travel = { floor: 20, combat_id: null, ok: true, request: { cmd: 'choose_map_node', args: [1, 2] } };
  memory.data.actions = [travel, { ...travel, floor: 3 }, { ...travel, ok: false },
    { ...travel, request: { cmd: 'choose_map_node', args: [2, 2] } },
    { floor: 22, combat_id: null, ok: true, request: { cmd: 'reward_choose_card', card_id: 'ANGER', nth: 0 }, after_screen: 'REWARD', result: { card_id: 'ANGER', nth: 0, card_name: 'Anger+', upgraded: true, screen: 'REWARD' } }];
  const projected = memory.context(state);
  assert.equal(projected.actions.length, 2);
  assert.equal(projected.travel_history[0].floor, 3, 'Earlier act travel is retained even at matching coordinates');
  assert.equal(projected.actions[0].ok, false);
  assert.equal(projected.travel_history[1].col, 2);
  assert.equal(projected.travel_history[1].row, 2);
  assert.deepEqual(projected.actions[1].result, { card_name: 'Anger+', upgraded: true });
  assert.equal(memory.data.actions.length, 5, 'Full local records remain untouched');
});

test('completed acts summarize resource changes while current rooms and strategic choices remain available', () => {
  const state = completeCombat(), memory = new DecisionMemory();
  state.decision_context.total_floor = 22;
  state.decision_context.act_floor = 5;
  memory.observe(state);
  memory.data.actions = [{ floor: 4, combat_id: null, ok: true, request: { cmd: 'choose_event', args: [1] }, result: { event_id: 'KNOWN_EVENT' } }];
  memory.data.observations = [
    { floor: 4, combat_id: 'old', changes: { hp: { before: 80, after: 60 }, gold: { before: 0, after: 20 } } },
    { floor: 4, combat_id: null, changes: { gold: { before: 20, after: 35 } } },
    { floor: 17, combat_id: 'boss', changes: { hp: { before: 60, after: 40 }, gold: { before: 35, after: 135 } } },
    { floor: 19, combat_id: 'recent', changes: { hp: { before: 80, after: 70 } } }
  ];
  const result = memory.context(state);
  assert.equal(result.actions[0].result.event_id, 'KNOWN_EVENT');
  assert.deepEqual(result.observations[0], { scope: 'earlier_acts', from_floor: 4, through_floor: 17, changes: { hp: { before: 80, after: 40 }, gold: { before: 0, after: 135 } } });
  assert.equal(result.observations[1].floor, 19);
  assert.equal(memory.data.observations.length, 4, 'Detailed local records are preserved');
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

test('every independent atomic action request contains the full JSON context and exactly the offered action IDs', async () => {
  const state = completeCombat(), memory = new DecisionMemory(); memory.observe(state);
  const requests = [];
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body); requests.push(request);
    assert.equal(request.state.schema_version, 'sts2.decision.v1');
    assert.deepEqual(Object.keys(request.questions.next_action.criteria), request.state.legal_actions.map(a => a.action_id));
    return { ok: true, json: async () => ({ model: 'offline', usage: { input_tokens: 2400 }, answers: { next_action: { type: 'choice', choice: 'end_turn' } } }) };
  };
  await makeModDecisionWithJev(state, { turnPlanning: false, memory, apiKey: 'test', fetchImpl });
  memory.begin({ cmd: 'end_turn' }, state); memory.finish({ ok: true }, state);
  const result = await makeModDecisionWithJev(state, { turnPlanning: false, memory, apiKey: 'test', fetchImpl });
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
  state.decision_context.combat_history = Array.from({ length: 100 }, (_, sequence) => ({ sequence, round: Math.floor(sequence / 6) + 1, actor_id: sequence % 2 ? 0 : 1, side: 'Player', type: sequence % 2 ? 'CardPlayFinishedEntry' : 'DamageReceivedEntry', description: 'Observed Strike dealing exactly 6 damage to a visible enemy.', ...(sequence % 2 ? { result_pile: 'Discard' } : { damage: { total: 6, blocked: sequence % 3, unblocked: 6 - sequence % 3, overkill: 0 } }) }));
  const original = packet(state), compact = compactContext(original);
  validateDecisionPacket(compact);
  const expand = item => {
    if (item?.text_ref) return compact.text_dictionary[item.text_ref];
    if (item?.encoding === 'record_table_v1') return item.rows.map(([layout, ...values]) => Object.fromEntries(item.layouts[layout].map((key, i) => [key, expand(values[i])])));
    if (item?.encoding === 'record_table_v2') return item.rows.map(([index, ...values]) => ({ ...expand(item.layouts[index].constants), ...Object.fromEntries(item.layouts[index].fields.map((key, i) => [key, expand(values[i])])) }));
    if (Array.isArray(item)) return item.map(expand);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'text_dictionary').map(([key, value]) => [key, expand(value)]));
    return item;
  };
  assert.deepEqual(expand(expandRecordTables(compact)), original);
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

test('nested record tables preserve all candidates, card copies, costs and nested field names', () => {
  const base = completeCombat();
  const state = withContext({ ...base, combat: { ...base.combat,
    hand: Array.from({ length: 12 }, (_, index) => fixtureCard('STRIKE_IRONCLAD', { index, cost: index % 3, damage: 6 + index, can_play: true, target_type: 'AnyEnemy', details: { instance_id: `copy_${index}`, nested: { 'display.damage': index, optional: index % 2 ? null : false } } })),
    enemies: Array.from({ length: 4 }, (_, i) => ({ ...base.combat.enemies[0], combat_id: 42 + i, hp: 12 + i }))
  } });
  const original = packet(state), compact = compactContext(original);
  assert.match(JSON.stringify(compact), /record_table_v3/);
  validateDecisionPacket(compact);
  const text = item => {
    if (item?.text_ref) return compact.text_dictionary[item.text_ref];
    if (Array.isArray(item)) return item.map(text);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'text_dictionary').map(([key, value]) => [key, text(value)]));
    return item;
  };
  assert.deepEqual(text(expandRecordTables(compact)), original);
  assert.ok(JSON.stringify(compact).length < JSON.stringify(original).length);
  const corrupted = structuredClone(compact);
  const table = corrupted.combat.hand;
  if (table.encoding === 'record_table_v3') {
    const layout = table.layouts[table.rows[0][0]], column = layout.fields.findIndex(path => path.length === 1 && path[0] === 'cost');
    assert.ok(column >= 0);
    table.rows[0][column + 1] = 'invalid energy';
    assert.throws(() => validateDecisionPacket(corrupted), /versioned protocol/);
  }
  assert.throws(() => expandRecordTables({ encoding: 'record_table_v3', layouts: [{ constants: [], fields: [['__proto__', 'x']] }], rows: [[0, 1]] }), /Malformed nested record path/);
});

test('historical deck references share only exactly identical current card states', () => {
  const original = packet(completeCombat());
  const card = original.deck.cards[0].card;
  original.memory.observations = [{ floor: 1, changes: { master_deck: {
    added: [{ card: structuredClone(card), count: 1 }],
    removed: [{ card: { ...card, cost: 7 }, count: 1 }]
  } } }];
  const compact = compactContext(original);
  validateDecisionPacket(compact);
  const table = compact.memory.observations;
  const observation = Array.isArray(table) ? table[0] : table.encoding === 'record_table_v1'
    ? Object.fromEntries(table.layouts[table.rows[0][0]].map((key, i) => [key, table.rows[0][i + 1]]))
    : { ...table.layouts[table.rows[0][0]].constants, ...Object.fromEntries(table.layouts[table.rows[0][0]].fields.map((key, i) => [key, table.rows[0][i + 1]])) };
  const change = observation.changes.master_deck;
  assert.equal(change.added[0].card.deck_group_index, 0);
  assert.deepEqual(compact.deck.cards[change.added[0].card.deck_group_index].card, card);
  assert.equal(change.removed[0].card.cost, 7, 'A historical variant keeps its own complete rules');
  change.added[0].card.deck_group_index = 999;
  assert.throws(() => validateDecisionPacket(compact), /Dangling permanent deck/);
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
