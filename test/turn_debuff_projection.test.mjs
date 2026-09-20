import test from 'node:test';
import assert from 'node:assert/strict';
import { completeCombat, fixtureCard } from './fixtures/context.mjs';
import { buildModCandidates, prepareModDecision } from '../src/mod_decision.mjs';
import { planStep } from '../src/turn_plan_state.mjs';
import { describeTurnProjection } from '../src/turn_projection.mjs';
import { compileModelRequest, restoreCanonicalContext } from '../src/context_compiler.mjs';
import { validateDecisionPacket } from '../src/decision_context.mjs';

function fixture() {
  const s = completeCombat();
  s.combat.hand = [
    fixtureCard('UPPERCUT', { index: 0, cost: 2, target_type: 'AnyEnemy', can_play: true, type: 'Attack', description: 'Deal 13 damage. Apply 1 Weak. Apply 1 Vulnerable.', details: { instance_id: 'uppercut' }, target_previews: [{ target_id: 42, damage: 13 }] }),
    fixtureCard('STRIKE_IRONCLAD', { index: 1, cost: 1, target_type: 'AnyEnemy', can_play: true, type: 'Attack', description: 'Deal 6 damage.', details: { instance_id: 'strike' }, target_previews: [{ target_id: 42, damage: 6 }] })
  ];
  s.combat.player.energy = 3; s.combat.player.hand_count = 2; s.combat.player.powers = []; s.combat.player.relics = [];
  const enemy = s.combat.enemies[0]; enemy.hp = enemy.max_hp = 22; enemy.block = 0; enemy.powers = [];
  enemy.intents = [{ type: 'Attack', damage: 10, hits: 1, description: 'Attack for 10 damage.' }];
  s.decision_context.player = structuredClone(s.combat.player);
  return s;
}
const steps = s => ['card_0_target_42', 'card_1_target_42', 'end_turn'].map(id => planStep(s, buildModCandidates(s).get(id)));

test('area damage precedes debuffs for each native recipient, with independent Artifact counts', () => {
  const s = fixture(); s.combat.enemies[0].hp = 16;
  s.combat.enemies.push({ ...structuredClone(s.combat.enemies[0]), combat_id: 43, hp: 20, powers: [{ id: 'ARTIFACT_POWER', amount: 1 }] });
  s.combat.hand[0] = { ...s.combat.hand[0], id: 'THUNDERCLAP', target_type: 'AllEnemies', cost: 1,
    description: 'Deal 7 damage and apply 1 Vulnerable to ALL enemies.', target_previews: [{ target_id: 42, damage: 7 }, { target_id: 43, damage: 7 }] };
  const candidates = buildModCandidates(s), plan = ['card_0', 'card_1_target_42', 'end_turn'].map(id => planStep(s, candidates.get(id)));
  let p = describeTurnProjection(s, plan).debuff_dependencies;
  assert.deepEqual(p.enemies.map(e => e.hp_remaining), [{ min: 0, max: 0 }, { min: 13, max: 13 }]);
  assert.deepEqual(p.transitions.map(t => t.outcome), ['applied', 'absorbed_by_artifact']);
  s.combat.hand[0] = { ...s.combat.hand[0], id: 'SHOCKWAVE', type: 'Skill', cost: 2,
    description: 'Apply 5 Weak and Vulnerable to ALL enemies.', target_previews: [{ target_id: 42, damage: null }, { target_id: 43, damage: null }] };
  plan[0] = planStep(s, buildModCandidates(s).get('card_0'));
  p = describeTurnProjection(s, plan).debuff_dependencies;
  assert.ok(p.transitions.every(t => t.amount === 5 && t.timing === 'during_card_effect'));
  assert.deepEqual(p.enemies[0].current_attack_after_debuffs, { min: 7, max: 8 });
  assert.deepEqual(p.enemies[1].current_attack_after_debuffs, { min: 10, max: 10 });
  s.combat.hand[0].target_previews = [{ target_id: 42, damage: null }];
  assert.ok(describeTurnProjection(s, plan).debuff_dependencies.transitions.every(t => t.target_id === 42), 'No debuff applied to a non-recipient');
});

test('new Vulnerable propagates through an ordered plan; reversing order or using weaker setup does not promise the same kill', () => {
  const s = fixture(), before = structuredClone(s), plan = steps(s);
  const p = describeTurnProjection(s, plan);
  assert.deepEqual(s, before, 'Projection leaves actual observations intact');
  assert.deepEqual(p.debuff_dependencies.ordered_damage[1].per_hit, { min: 9, max: 10 });
  assert.deepEqual(p.debuff_dependencies.enemies[0].hp_remaining, { min: 0, max: 0 });
  assert.equal(p.debuff_dependencies.enemies[0].depleted_if_all_declared_hits_resolve, true);
  assert.equal(p.known_effects_only.enemies[0].hp, null, 'No contradictory unchanged-preview point estimate');
  assert.equal(describeTurnProjection(s, [plan[1], plan[0], plan[2]]).debuff_dependencies.enemies[0].hp_remaining.max, 3);
  s.combat.hand[0] = { ...s.combat.hand[0], id: 'BASH', description: 'Deal 10 damage. Apply 3 Vulnerable.', target_previews: [{ target_id: 42, damage: 10 }] };
  assert.deepEqual(describeTurnProjection(s, steps(s)).debuff_dependencies.enemies[0].hp_remaining, { min: 2, max: 3 });
});

test('a current X-cost hit count is not reused after spending on debuff setup', () => {
  const s = fixture();
  s.combat.enemies[0].hp = 50;
  s.combat.hand[1] = { ...s.combat.hand[1], id: 'WHIRLWIND', cost: -1, description: 'Deal 5 damage X times.', attack_preview: { hits: 3 } };
  const p = describeTurnProjection(s, steps(s)).debuff_dependencies;
  assert.equal(p.ordered_damage[1].preview_hits, null);
  assert.deepEqual(p.enemies[0].hp_remaining, { min: null, max: null });
});

test('Weak uses integer-preview bounds and existing debuffs are not multiplied twice', () => {
  const s = fixture(); s.combat.enemies[0].hp = 50;
  assert.deepEqual(describeTurnProjection(s, steps(s)).debuff_dependencies.enemies[0].current_attack_after_debuffs, { min: 7, max: 8 });
  s.combat.enemies[0].powers = [{ id: 'VULNERABLE_POWER', amount: 1 }, { id: 'WEAK_POWER', amount: 1 }];
  s.combat.hand[1].target_previews[0].damage = 9;
  s.combat.enemies[0].intents[0].damage = 7;
  const p = describeTurnProjection(s, steps(s)).debuff_dependencies;
  assert.deepEqual(p.ordered_damage[1].per_hit, { min: 9, max: 9 });
  assert.deepEqual(p.enemies[0].current_attack_after_debuffs, { min: 7, max: 7 });
});

test('Artifact consumes Weak before Vulnerable; caps and custom multipliers remain unknown', () => {
  const s = fixture(); s.combat.enemies[0].hp = 50;
  s.combat.enemies[0].powers = [{ id: 'ARTIFACT_POWER', amount: 1 }];
  let p = describeTurnProjection(s, steps(s)).debuff_dependencies;
  assert.deepEqual(p.transitions.map(t => t.outcome), ['absorbed_by_artifact', 'applied']);
  assert.deepEqual(p.ordered_damage[1].per_hit, { min: 9, max: 10 });
  assert.deepEqual(p.enemies[0].current_attack_after_debuffs, { min: 10, max: 10 });
  s.combat.enemies[0].powers = [{ id: 'ARTIFACT_POWER', amount: 2 }];
  p = describeTurnProjection(s, steps(s)).debuff_dependencies;
  assert.deepEqual(p.ordered_damage[1].per_hit, { min: 6, max: 6 });
  for (const modifiers of [[{ id: 'SLIPPERY_POWER', amount: 1 }], [{ id: 'DEBILITATE_POWER', amount: 1 }]]) {
    s.combat.enemies[0].powers = modifiers;
    assert.deepEqual(describeTurnProjection(s, steps(s)).debuff_dependencies.enemies[0].hp_remaining, { min: null, max: null });
  }
});

test('dependency ranges survive the production context compiler without modifying observations', () => {
  const s = fixture(), before = structuredClone(s), prepared = prepareModDecision(s);
  prepared.payload.state.turn_planning = { phase_scope: 'Hypothetical ordered plan from current observation.',
    energy_reservation: { observed_energy: 3, remaining_after_printed_costs: 3, scope: 'Each alternative reserves its own costs.', is_observed: false, includes_future_energy_gains: false, steps: [] },
    conditional_projection: describeTurnProjection(s, steps(s)) };
  validateDecisionPacket(prepared.payload.state);
  const compiled = compileModelRequest(prepared.payload, { purpose: 'turn_refine_pairs' });
  const restored = restoreCanonicalContext(compiled.payload.state);
  assert.ok(restored.turn_planning.conditional_projection.debuff_dependencies);
  assert.deepEqual(s, before);
});
