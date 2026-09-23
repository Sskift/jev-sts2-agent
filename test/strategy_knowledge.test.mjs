import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractPattern } from '../scripts/extract_enemy_patterns.mjs';
import { enemyPattern, enemyOutlook } from '../src/enemy_patterns.mjs';
import { lookupRule } from '../src/rule_reference.mjs';
import { buildStrategyKnowledge, encounterProgress, describeCombatProgress, describeEnemyOutlook } from '../src/strategy_knowledge.mjs';
import { completeCombat, withContext } from './fixtures/context.mjs';

test('a revealed Vantom boss is available during drafting and again in combat', () => {
  const reward = withContext({ screen: 'REWARD', rewards: { can_skip: true, rewards: [] } });
  reward.decision_context.map.boss = { id: 'VANTOM_BOSS', name: 'Vantom' };
  const preparation = buildStrategyKnowledge(reward).encounter;
  assert.equal(preparation[0].enemy_id, 'VANTOM_BOSS');
  assert.equal(preparation[0].role, 'revealed_act_boss');
  assert.match(preparation[0].advice, /Slippery/);
  const combat = completeCombat();
  combat.combat.enemies[0].id = 'VANTOM';
  assert.match(buildStrategyKnowledge(combat).encounter[0].advice, /multi-hit/);
});

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
      for (const reference of s.rule_references || []) assert.ok(lookupRule(reference.category, reference.id), `${id}/${reference.category}/${reference.id}`);
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

test('a downed segment still exposes its visible revival intent and unknown random follow-up', () => {
  const state = completeCombat();
  Object.assign(state.combat.enemies[0], { id: 'DECIMILLIPEDE_SEGMENT_FRONT', hp: 0, is_alive: false,
    powers: [{ id: 'REATTACH_POWER', amount: 25 }], intents: [{ type: 'Heal' }] });
  const outlook = describeEnemyOutlook(state);
  assert.equal(outlook.length, 1);
  assert.equal(outlook[0].matching_moves[0].current_move, 'REATTACH');
  assert.equal(outlook[0].matching_moves[0].after_current_intent.branch, 'random');
  assert.match(outlook[0].matching_moves[0].after_current_intent.resolution, /Unknown/);
  const progress = encounterProgress(state.combat, [{ combat_id: 42, hp: 0 }], [42]);
  assert.equal(progress[0].reattach.revival_prevented_by_group_depletion, null);
});

test('visible status-card intents identify their public move and linked card generation', () => {
  const enemy = { combat_id: 1, id: 'MYTE', intents: [{ type: 'StatusCard' }] };
  const outlook = enemyOutlook(enemy, lookupRule('monsters', 'MYTE').moves);
  assert.equal(outlook.matching_moves.length, 1);
  const move = outlook.matching_moves[0];
  assert.equal(move.current_move, 'TOXIC');
  assert.equal(move.after_current_intent.move_id, 'BITE');
  assert.equal(move.after_current_intent.then.move_id, 'SUCK');
  assert.deepEqual(move.generated_cards_if_current_move_resolves.map(e => [e.card_id, e.destination, e.count]), [['TOXIC', 'Hand', 2]]);
  assert.deepEqual(enemyOutlook({ ...enemy, move_id: 'HIDDEN_OTHER_MOVE' }, lookupRule('monsters', 'MYTE').moves), outlook);
  assert.equal(enemyOutlook({ ...enemy, intents: [{ type: 'CardDebuff' }] }).matching_moves.length, 0);
});

test('move card generation keeps symbolic amounts and conditional invocation limits', () => {
  const graph = extractPattern(`GenerateMoveStateMachine() {
    MoveState a = new MoveState("A", Emit, new StatusIntent(2));
    return new MonsterMoveStateMachine(list, a);
  }
  private async Task Emit(IReadOnlyList<Creature> targets) {
    if (condition) { await CardPileCmd.AddToCombatAndPreview<Toxic>(targets, PileType.Hand, 2, null); }
    await CardPileCmd.AddToCombatAndPreview<FranticEscape>(targets, PileType.Discard, Amount, null);
  }`);
  const effects = graph.states[0].generated_cards;
  assert.equal(effects.length, 2);
  assert.equal(effects[0].count, 2);
  assert.match(effects[0].scope, /if reached/);
  assert.equal(effects[1].card_id, 'FRANTIC_ESCAPE');
  assert.equal(effects[1].count, null);
  assert.equal(effects[1].count_expression, 'Amount');
});

test('move references link constructed cards and powers without inventing effects or scanning unrelated methods', () => {
  const graph = extractPattern(`GenerateMoveStateMachine() {
    MoveState a = new MoveState("A", Emit, new StatusIntent(2));
    return new MonsterMoveStateMachine(list, a);
  }
  private async Task Emit(IReadOnlyList<Creature> targets) {
    if (condition) { var card = base.CombatState.CreateCard<FranticEscape>(player); }
    var power = ModelDb.Power<SandpitPower>().ToMutable();
    await PowerCmd.Apply<WeakPower>(context, targets, amount, owner, null);
  }
  private Task Unused() { return CardPileCmd.AddToCombatAndPreview<Toxic>(targets, PileType.Hand, 2, null); }
  `);
  const node = graph.states[0];
  assert.deepEqual(node.rule_references, [
    { category: 'cards', id: 'FRANTIC_ESCAPE' },
    { category: 'powers', id: 'SANDPIT' },
    { category: 'powers', id: 'WEAK' }
  ]);
  assert.equal(node.generated_cards, undefined, 'A constructed card has no inferred count, destination or application');
});

test('native power call arguments separate amount and recipients from the resulting live stack', () => {
  const graph = extractPattern(`GenerateMoveStateMachine() {
    MoveState a = new MoveState("A", Buff, new BuffIntent());
    return new MonsterMoveStateMachine(list, a);
  }
  private async Task Buff(IReadOnlyList<Creature> targets) {
    await PowerCmd.Apply<StrengthPower>(context, base.Creature, 3m, base.Creature, null);
    await PowerCmd.Apply<StrengthPower>(context, base.CombatState.GetTeammatesOf(base.Creature), -2m, base.Creature, null);
    await PowerCmd.Apply<WeakPower>(context, targets, DebuffAmount, base.Creature, null);
    await PowerCmd.Apply<FrailPower>(context, chosenTarget, 1m, base.Creature, null);
  }`);
  const effects = graph.states[0].power_applications;
  assert.deepEqual(effects.map(p => [p.power_id, p.amount, p.recipients]), [
    ['STRENGTH', 3, 'self'], ['STRENGTH', -2, 'self_and_allies'],
    ['WEAK', null, 'move_targets'], ['FRAIL', 1, 'unresolved']
  ]);
  assert.equal(effects[2].amount_expression, 'DebuffAmount');
  assert.equal(effects[3].recipients_expression, 'chosenTarget');
  assert.match(effects[0].scope, /not a resulting stack/);
  const outlook = enemyOutlook({ combat_id: 1, id: 'THE_OBSCURA', intents: [{ type: 'Buff' }] });
  assert.equal(outlook.matching_moves[0].power_applications_if_current_move_resolves[0].amount, 3);
  assert.equal(outlook.matching_moves[0].power_applications_if_current_move_resolves[0].recipients, 'self_and_allies');
});

test('encounter statistics preserve capped damage and observed depletions without treating revival as removal', () => {
  const state = completeCombat(); state.combat.turn_number = 5;
  state.combat.enemies[0].powers = [{ id: 'ILLUSION_POWER', amount: 1 }];
  state.decision_context.combat_history = [
    { type: 'DamageReceivedEntry', round: 2, actor_id: 42, damage: { unblocked: 21, overkill: 12 } },
    { type: 'DamageReceivedEntry', round: 4, actor_id: 42, damage: { unblocked: 7, overkill: 0 } },
    { type: 'DamageReceivedEntry', round: 6, actor_id: 42, damage: { unblocked: 99, overkill: 0 } }
  ];
  const action = (round, ok = true, combat_id = state.decision_context.combat_id) => ({ round, ok, combat_id,
    observed_combat_change: { enemy_changes: [{ combat_id: 42, changes: { hp: { before: 7, after: 0 } } }] } });
  const memory = { data: { run_id: state.decision_context.run_id, actions: [action(2), action(4), action(6), action(3, false), action(3, true, 'other'),
    { ...action(3), observed_combat_change: { enemy_changes: [{ combat_id: 42, added: { hp: 21 } }] } }] } };
  const before = structuredClone({ state, memory }), progress = describeCombatProgress(state, memory).enemies[0];
  assert.equal(progress.recorded_hp_damage, 28, 'Native unblocked HP damage already excludes the separate overkill');
  assert.equal(progress.recorded_overkill, 12);
  assert.equal(progress.observed_hp_depletions, 2);
  assert.equal(progress.role, 'minion');
  assert.equal(progress.last_damaged_round, 4);
  assert.equal(progress.current_hp, state.combat.enemies[0].hp);
  assert.deepEqual({ state, memory }, before);
  memory.data.run_id = 'another-run';
  assert.equal(describeCombatProgress(state, memory).enemies[0].observed_hp_depletions, null);
  state.decision_context.combat_history[0].damage = {};
  assert.equal(describeCombatProgress(state, memory).enemies[0].recorded_hp_damage, null);
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
