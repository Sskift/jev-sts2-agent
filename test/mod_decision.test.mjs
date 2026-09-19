import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModCandidates, makeModDecisionWithJev } from '../src/mod_decision.mjs';
import { withContext } from './fixtures/context.mjs';

const card = { index: 0, id: 'STRIKE_IRONCLAD', name: 'Strike', description: 'Deal 6 damage.', target_type: 'AnyEnemy', cost: 1, can_play: true, damage: 6 };
const enemy = { combat_id: 42, name: 'Enemy', hp: 10, block: 0, is_alive: true };
function combat(hand = [card], overrides = {}) {
  return { screen: 'COMBAT', combat: { player: { hp: 80, energy: 3 }, is_player_turn: true, is_player_actions_disabled: false, is_combat_ending: false, hand, enemies: [enemy], ...overrides } };
}

test('same-ID cards use nth among all copies, preserve hand index and target stable combat ID', () => {
  const candidates = buildModCandidates(combat([{ ...card, index: 1, id: 'strike_ironclad' }, { ...card, can_play: false }, { ...card, index: 2 }]));
  assert.equal(candidates.has('card_0_target_42'), false);
  assert.deepEqual(candidates.get('card_1_target_42').request, { cmd: 'play_card', id: 'strike_ironclad', nth: 1, target: 42 });
  assert.equal(candidates.get('card_1_target_42').card_hand_index, 1);
  assert.deepEqual(candidates.get('card_2_target_42').request, { cmd: 'play_card', id: 'STRIKE_IRONCLAD', nth: 2, target: 42 });
  assert.throws(() => buildModCandidates(combat([card, { ...card }])), /unique nonnegative indices/);
});

test('targetless cards omit target and disabled or ending turns have no executable actions', () => {
  assert.deepEqual(buildModCandidates(combat([{ ...card, target_type: 'Self' }])).get('card_0').request, { cmd: 'play_card', id: card.id, nth: 0 });
  for (const override of [{ is_player_turn: false }, { is_player_actions_disabled: true }, { is_combat_ending: true }]) assert.equal(buildModCandidates(combat([card], override)).size, 0);
  assert.equal(buildModCandidates(combat([card], { enemies: [{ ...enemy, is_alive: false }] })).has('card_0_target_42'), false);
});

test('selected character advances via embark, menu saves continue and event dialogue uses real wire args', () => {
  const selected = { screen: 'CHARACTER_SELECT', character_select: { selected_character: 'IRONCLAD', can_embark: true, available_characters: [{ character_id: 'IRONCLAD', character_name: 'Ironclad', is_locked: false, is_selected: true }] } };
  assert.deepEqual([...buildModCandidates(selected).keys()], ['embark']);
  assert.deepEqual(buildModCandidates({ screen: 'MENU', menu: { has_run_save: true } }).get('continue_run').request, { cmd: 'continue_run' });
  assert.deepEqual(buildModCandidates({ screen: 'EVENT', event: { is_in_dialogue: true } }).get('advance_dialogue').request, { cmd: 'advance_dialogue', args: [1] });
});

test('Jev must select an enumerated complete action, never arbitrary JSON or an absent ID', async () => {
  const state = withContext(combat());
  const options = { apiKey: 'offline-only', fetchImpl: async (_url, request) => {
    const payload = JSON.parse(request.body);
    assert.equal(payload.state.combat.enemies[0].combat_id, 42);
    assert.match(payload.state.legal_actions.find(a => a.action_id === 'card_0_target_42').description, /Deal 6 damage/);
    assert.equal(payload.questions.next_action.criteria.card_0_target_42.action_id, 'card_0_target_42');
    return { ok: true, json: async () => ({ model: 'jev-test', answers: { next_action: { type: 'choice', choice: 'card_0_target_42', probabilities: { card_0_target_42: 1 } } } }) };
  } };
  const decision = await makeModDecisionWithJev(state, options);
  assert.deepEqual(decision.request, { cmd: 'play_card', id: card.id, nth: 0, target: 42 });
  await assert.rejects(makeModDecisionWithJev(state, { ...options, fetchImpl: async () => ({ ok: true, json: async () => ({ answers: { next_action: { type: 'choice', choice: 'invented' } } }) }) }), /invalid mod action/);
});
