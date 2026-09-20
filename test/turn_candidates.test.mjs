import test from 'node:test';
import assert from 'node:assert/strict';
import { completeCombat, fixtureCard } from './fixtures/context.mjs';
import { buildModCandidates } from '../src/mod_decision.mjs';
import { independentTurnCandidates, compareFinalists } from '../src/turn_candidates.mjs';
import { inspectSequence } from '../src/turn_sequence.mjs';

test('independent search offers distinct first actions and orders, preserves identities and stops at draws', () => {
  const state = completeCombat();
  state.combat.hand = ['A', 'B', 'DRAW'].map((id, index) => fixtureCard(id, { index, can_play: true, cost: 0,
    description: id === 'DRAW' ? 'Draw 1 card.' : 'Deal 6 damage.', target_type: 'Self', details: { instance_id: id } }));
  const snapshot = structuredClone(state);
  const result = independentTurnCandidates(state, buildModCandidates(state));
  const sequences = result.plans.map(p => p.filter(s => s.kind === 'play_card').map(s => s.card_instance_id).join(','));
  assert.ok(sequences.includes('A,B,DRAW')); assert.ok(sequences.includes('B,A,DRAW'));
  assert.ok(sequences.includes('DRAW')); assert.ok(!sequences.includes('DRAW,A'));
  assert.ok(result.plans.every(p => !inspectSequence(state, p).violations.length));
  assert.deepEqual(state, snapshot);
  const bounded = independentTurnCandidates(state, buildModCandidates(state), { maxInspections: 5, maxPlans: 2 });
  assert.ok(bounded.coverage.search_truncated); assert.ok(bounded.coverage.inspected_prefixes <= 5);
});

test('finalist review exposes position bias and does not mistake unanimous slot choice for certainty', async () => {
  const a = { value: 'keep', label: {} }, b = { value: 'other', label: {} };
  const result = await compareFinalists([b], a, async pairs => pairs.map(p => p[0].value), '', {});
  assert.equal(result.selected, 'keep');
  assert.equal(result.audit.order_disagreements.length, 1);
  assert.equal(result.audit.comparisons, 2);
  const stable = await compareFinalists([b], a, async pairs => pairs.map(() => 'other'), '', {});
  assert.equal(stable.selected, 'other'); assert.equal(stable.audit.order_disagreements.length, 0);
});

test('a potion next-card trigger is consumed before a later manual action can reuse old previews', () => {
  const state = completeCombat();
  state.combat.player.potions = [{ id: 'DUPLICATOR', slot: 0, description: 'This turn, your next card is played an extra time.' }];
  state.combat.hand.push(fixtureCard('SECOND', { details: { instance_id: 'SECOND' }, cost: 0 }));
  const steps = [{ kind: 'use_potion', potion_id: 'DUPLICATOR', slot: 0 }, { kind: 'play_card', card_instance_id: 'STRIKE_IRONCLAD', target: 42 }, { kind: 'play_card', card_instance_id: 'SECOND', target: 42 }];
  const result = inspectSequence(state, steps);
  assert.equal(result.checkpoint.after_sequence, 1);
  assert.ok(result.violations.some(v => v.sequence === 2));
});
