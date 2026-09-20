import test from 'node:test';
import assert from 'node:assert/strict';
import { projectPositioning } from '../src/combat_positioning.mjs';
import { combatForecast } from '../src/combat_arithmetic.mjs';
import { describeTurnProjection } from '../src/turn_projection.mjs';
import { buildDecisionContext, compactContext, validateContext, validateDecisionPacket } from '../src/decision_context.mjs';
import { buildModCandidates } from '../src/mod_decision.mjs';
import { completeCombat } from './fixtures/context.mjs';

function surrounded() {
  const state = completeCombat(), combat = state.combat;
  combat.player.powers = [{ id: 'SURROUNDED_POWER', description: 'Receive 50% more damage from behind.', amount: 1 }];
  state.decision_context.player = structuredClone(combat.player);
  combat.enemies = ['Left', 'Right'].map((side, index) => ({
    combat_id: index + 1, id: `FIXTURE_${side}`, name: side, hp: 40, block: 0, is_alive: true,
    powers: [{ id: `BACK_ATTACK_${side.toUpperCase()}_POWER`, description: 'Deal 50% more damage from behind.' }],
    intents: [{ type: 'Attack', damage: index ? 10 : 15, hits: 1, description: 'Current facing preview.' }]
  }));
  combat.hand[0].target_previews = [{ target_id: 1, damage: 6 }, { target_id: 2, damage: 6 }];
  combat.hand[0].valid_target_ids = [1, 2];
  combat.positioning = {
    source: 'native_visible_surrounded_state', player_combat_id: 0, facing: 'Right',
    back_attack_multiplier: 1.5, intents_include_current_facing: true,
    enemies: [{ combat_id: 1, side: 'Left', attacking_from_behind: true }, { combat_id: 2, side: 'Right', attacking_from_behind: false }],
    targeting_rule: 'Explicit card or potion targets turn toward that side before resolving.',
    death_rule: 'Face the sole remaining side after a confirmed death.',
    preview_scope: 'Current intent damage includes the current facing multiplier.'
  };
  return state;
}
const strike = target => ({ kind: 'play_card', name: 'Strike', card_instance_id: 'STRIKE_IRONCLAD', target });

test('observed Surrounded state and compressed packets require a consistent facing and enemy relation', () => {
  const state = surrounded();
  validateContext(state);
  const packet = buildDecisionContext(state, { candidates: buildModCandidates(state) });
  validateDecisionPacket(compactContext(packet));
  assert.equal(packet.combat.visible_arithmetic.incoming_attack_damage, 25, 'Do not apply the 1.5 multiplier twice');
  delete state.combat.positioning;
  assert.throws(() => validateContext(state), /observed player facing/);
  packet.combat.positioning.enemies[0].attacking_from_behind = false;
  assert.throws(() => validateDecisionPacket(compactContext(packet)), /contradicts/);
});

test('the last explicitly sided target determines facing; self and untargeted cards do not turn', () => {
  const combat = surrounded().combat, original = structuredClone(combat);
  const plan = [strike(1), { kind: 'play_card' }, { kind: 'use_potion', target: 0 }];
  assert.equal(projectPositioning(combat, plan).facing_after_sequence, 'Left');
  assert.equal(projectPositioning(combat, [...plan, { kind: 'use_potion', target: 2 }]).facing_after_sequence, 'Right');
  assert.equal(projectPositioning(combat, [strike(1), { kind: 'end_turn' }, strike(2)]).facing_after_sequence, 'Left');
  assert.deepEqual(combat, original);
  combat.enemies.push({ combat_id: 3, powers: [], is_alive: true, hp: 20 });
  combat.positioning.enemies.push({ combat_id: 3, side: 'None', attacking_from_behind: false });
  const unsided = projectPositioning(combat, [strike(1), strike(3)]);
  assert.equal(unsided.facing_after_sequence, 'Left');
  assert.equal(unsided.enemies_after_sequence[2].facing_damage_multiplier, 1);
});

test('targeting the other side invalidates incoming HP arithmetic, and targeting the original side restores only the facing baseline', () => {
  const state = surrounded();
  const end = combatForecast(state.combat);
  assert.equal(end.hp_loss_if_end_turn, 25);
  const changed = combatForecast(state.combat, state.combat.hand[0], state.combat.enemies[0]);
  assert.equal(changed.hp_remaining_if_end_turn, null);
  assert.equal(changed.fatal_if_end_turn, null);
  const plan = describeTurnProjection(state, [strike(1)]);
  assert.equal(plan.known_effects_only.incoming_attack, null);
  assert.equal(plan.known_effects_only.hp_loss_if_ending, null);
  assert.equal(plan.calculation_status, 'incomplete');
  assert.deepEqual(plan.positioning.enemies_after_sequence.map(enemy => enemy.attacking_from_behind), [false, true]);
  const reversed = projectPositioning(state.combat, [strike(1), strike(2)]);
  assert.equal(reversed.current_intents_still_applicable, true);
});

test('a surviving side changes facing conditionally on depletion being a real death', () => {
  const combat = surrounded().combat;
  const result = projectPositioning(combat, [strike(2)], new Set([2]));
  assert.equal(result.facing_after_sequence, 'Left');
  assert.equal(result.enemies_after_sequence[0].attacking_from_behind, false);
  assert.equal(result.current_intents_still_applicable, false);
  assert.match(result.scope, /prevention/);
});
