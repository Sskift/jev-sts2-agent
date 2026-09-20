import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractPattern } from '../scripts/extract_enemy_patterns.mjs';
import { enemyPattern, enemyOutlook } from '../src/enemy_patterns.mjs';
import { lookupRule } from '../src/rule_reference.mjs';
import { buildStrategyKnowledge, encounterProgress } from '../src/strategy_knowledge.mjs';
import { completeCombat } from './fixtures/context.mjs';

test('native patterns retain optional-weight branches, repeat caps and cooldowns without confusing overloads', () => {
  const hunter = enemyPattern('HUNTER_KILLER').states.find(s => s.type === 'random');
  assert.equal(hunter.branches[0].repeat, 'CannotRepeat');
  assert.equal(hunter.branches[1].max_consecutive, 2);
  assert.deepEqual(hunter.branches.map(b => b.base_weight), [1, 1]);
  const spores = enemyPattern('FLYCONID').states.find(s => s.id === 'RAND').branches[0];
  assert.equal(spores.cooldown, 3); assert.equal(spores.max_consecutive, undefined);
  assert.equal(spores.repeat, 'CannotRepeat'); assert.equal(spores.base_weight, 1);
  const graph = extractPattern('GenerateMoveStateMachine() { MoveState a = new MoveState("A", Move, new BuffIntent()); RandomBranchState r = (RandomBranchState)(a.FollowUpState = new RandomBranchState("R")); r.AddBranch(a, 2, MoveRepeatType.CannotRepeat, () => 0.5f); return new MonsterMoveStateMachine(list, a); }');
  assert.equal(graph.states.length, 2); assert.equal(graph.states[0].next, 'R');
  assert.deepEqual(graph.states[1].branches[0], { next: 'A', cooldown: 2, repeat: 'CannotRepeat', base_weight: 0.5 });
});

test('all 115 pinned patterns have unique nodes and resolved edges; dynamic construction remains explicit', () => {
  const data = JSON.parse(fs.readFileSync(new URL('../data/strategy/v0.111.0/enemy-patterns.json', import.meta.url)));
  assert.equal(Object.keys(data.entries).length, 115);
  for (const [id, pattern] of Object.entries(data.entries)) {
    assert.ok(pattern.states.length, id);
    const ids = new Set(pattern.states.map(s => s.id));
    assert.equal(ids.size, pattern.states.length, id);
    for (const s of pattern.states) {
      if (s.next) assert.ok(ids.has(s.next), `${id}/${s.next}`);
      if (s.type !== 'move') { assert.ok(s.branches.length, id); for (const b of s.branches) assert.ok(ids.has(b.next), id); }
    }
  }
  assert.ok(enemyPattern('AXEBOT').gaps.some(g => g.includes('construction')));
  assert.equal(enemyPattern('CEREMONIAL_BEAST').states.find(s => s.id === 'STUN_MOVE').must_perform_once, true);
});

test('future patterns follow only visible intent and do not consume an internal move label', () => {
  const enemy = { combat_id: 1, id: 'VANTOM', intents: [{ type: 'Attack', damage: 6, hits: 2 }] };
  const base = enemyOutlook(enemy, lookupRule('monsters', enemy.id).moves);
  assert.equal(base.matching_moves.length, 1);
  assert.equal(base.matching_moves[0].after_current_intent.move_id, 'DISMEMBER');
  assert.equal(base.matching_moves[0].after_current_intent.then.move_id, 'PREPARE');
  assert.deepEqual(enemyOutlook({ ...enemy, move_id: 'SECRET_OTHER_MOVE' }, lookupRule('monsters', enemy.id).moves), base);
  assert.deepEqual(enemyOutlook({ ...enemy, intents: [{ type: 'Unknown' }] }).matching_moves, []);
  const beast = enemyOutlook({ ...enemy, id: 'CEREMONIAL_BEAST', intents: [{ type: 'Attack', hits: 1 }, { type: 'Buff' }] });
  assert.equal(beast.matching_moves.length, 2, 'Same visible shape must not identify a hidden phase');
});

test('knowledge stays relevant and advisory, and revival progress is not permanent removal', () => {
  const state = completeCombat();
  state.decision_context.master_deck = [{ id: 'BASH', description: 'Apply 2 Vulnerable.' }];
  const notes = buildStrategyKnowledge(state);
  assert.deepEqual(notes.character.packages.map(p => p.id), ['vulnerable']);
  assert.equal(notes.character.id, 'IRONCLAD'); assert.match(notes.authority, /Advisory/);
  state.combat.enemies[0].powers = [{ id: 'ILLUSION_POWER', amount: 1, description: 'Revives at full HP next turn.' }];
  const progress = encounterProgress(state.combat, [{ combat_id: 42, hp: 1 }])[0];
  assert.equal(progress.hp_depleted, false); assert.equal(progress.permanent_removal_established, null);
  assert.equal(progress.role, 'minion');
  assert.equal(encounterProgress(state.combat, [{ combat_id: 42, hp: 0 }], [42])[0].hp_depleted, null);
});
