import { nextCardKind } from './turn_effects.mjs';
import { lookupRule } from './rule_reference.mjs';
import { potionEffectFacts } from './potion_effects.mjs';

// Public rules: Spire Codex v0.111.0. Precise hook timing was checked against
// the corresponding native Power classes. Values always come from live state.
const timing = {
  THORNS: { trigger: 'before_each_qualifying_damage_instance', expires: 'until_removed', consequence: 'blockable_damage_to_attacker', detail: 'Triggers on powered Attack damage or Omnislice, even when the hit would kill its owner or is fully blocked. Reaction precedes the incoming hit and later actions; end-turn Block is too late.' },
  FLAME_BARRIER: { trigger: 'after_each_incoming_powered_attack_damage_instance', expires: 'opposing_side_turn_end', consequence: 'blockable_damage_to_attacker', detail: 'For the player this persists through the coming enemy attacks. It is not removed at the end of the player action phase.' },
  CONSTRICT: { trigger: 'owner_turn_end_after_early_block', expires: 'applier_death_or_removal', consequence: 'blockable_damage_to_owner', detail: 'Current amount is damage at each owner turn end while its applier survives, in addition to displayed enemy attacks.' },
  PLATING: { trigger: 'owner_turn_end_early', expires: 'decrements_at_owner_turn_start', consequence: 'unpowered_block_to_owner', detail: 'Current stacks grant Block before end-turn damage. The later decrement is not an immediate reduction of this gain.' },
  ORICHALCUM: { trigger: 'player_turn_end_very_early', expires: 'while_owned', consequence: 'unpowered_block_to_player', detail: 'If Block is zero before early end effects, gain 6 Block; this check precedes Plating.' },
  CLOAK_CLASP: { trigger: 'before_player_turn_end', expires: 'while_owned', consequence: 'unpowered_block_per_remaining_hand_card', detail: 'Uses cards still in hand after manual actions. This gain precedes the Orichalcum zero-Block check and is not modified by Dexterity or Frail.' },
  PARRYING_SHIELD: { trigger: 'after_owner_side_turn_end', expires: 'while_owned', consequence: 'conditional_unpowered_damage_to_random_hittable_enemy', detail: 'Checks the owner Block when this hook resolves. Its damage can trigger enemy HP thresholds, stun or death before enemy actions. Other end effects can change Block and recipients; the starting intent is not a guaranteed response.' },
  PLOW: { trigger: 'after_positive_unblocked_damage_at_or_below_hp_threshold', expires: 'removed_after_triggering_once', consequence: 'remove_owner_strength_and_stun', detail: 'Current amount is the HP threshold. Any qualifying damage, including unpowered turn-end damage, can trigger it. Native removal includes temporary Strength, then Stun and removal of Plow; do not keep the previous attack intent as a guaranteed outcome.' },
  RAGE: { trigger: 'after_owner_plays_each_attack_card', expires: 'owner_turn_end', consequence: 'unpowered_block_to_owner', detail: 'Once per Attack play, not per hit; establish before the attacks that consume the opportunity.' },
  REATTACH: { trigger: 'owner_death_then_second_enemy_turn', expires: 'all_reattach_owners_defeated', consequence: 'interrupt_current_move_then_conditional_revival', detail: 'A Decimillipede segment loses its current attack when depleted. It revives two enemy turns after that depletion only if another Reattach owner is alive. A segment already showing Heal is closer to revival; its remaining delay is not reset. All segments down together prevents revival.' },
  ONE_TWO_PUNCH: { trigger: 'next_owner_attack_play', expires: 'owner_turn_end_or_consumption', consequence: 'one_extra_play_per_qualifying_attack', detail: 'Current power stacks count qualifying Attack cards. Extra plays and their reactions are not included in unchanged damage previews.' },
  SANDPIT: { trigger: 'enemy_turn_start_countdown', expires: 'owner_death_or_countdown_resolution', consequence: 'player_death_at_zero', detail: 'Decrements at enemy turn start. HP and Block cannot prevent this loss condition; a delay changes the deadline, not the need to handle later deadlines.' },
  PERSONAL_HIVE: { trigger: 'each_incoming_attack_hit', expires: 'until_removed', consequence: 'dazed_inserted_randomly_into_draw_pile', detail: 'Count hits rather than Attack cards. Generated status cards affect later draw quality and can displace a known top card.' },
  BURN: { trigger: 'player_turn_end_while_in_hand', expires: 'leaves_hand', consequence: 'blockable_damage_to_player' },
  TOXIC: { trigger: 'player_turn_end_while_in_hand', expires: 'leaves_hand', consequence: 'blockable_damage_to_player' },
  FAIRY_IN_A_BOTTLE: { trigger: 'ordinary_owner_death_check', expires: 'consumed_when_triggered', consequence: 'prevent_death_and_heal', detail: 'Automatic while held; no manual use is needed. Consumed before healing for 30% of maximum HP, minimum 1 before modifiers. Later damage can still kill. Forced death, including Sandpit, bypasses this prevention.' }
};
const idOf = entity => entity.id.replace(/_POWER$/, '');
export const effectTiming = id => timing[id.replace(/_POWER$/, '')] ?? null;
const temporal = /\b(?:whenever|when|at the (?:end|start)|this turn|next turn|next (?:\d+ )?(?:Attack|Skill|card)|lose|die)\b/i;

// Native v0.111.0 AfterAutoPostPlayPhaseEntered hooks. Pile membership is
// visible; draw-pile enumeration never establishes which card is on top.
const pileTriggers = {
  HOWL_FROM_BEYOND: { pile: 'exhaust_pile', condition: 'in_exhaust_pile', condition_evaluated: true },
  I_AM_INVINCIBLE: { pile: 'draw_pile', condition: 'on_top_of_draw_pile', condition_evaluated: false }
};
function cardSources(combat, hand = combat.hand || []) {
  return [
    ...hand.map(entity => ({ entity, pile: 'hand' })),
    ...['draw_pile', 'discard_pile', 'exhaust_pile'].flatMap(pile => (combat[pile] || [])
      .filter(entity => pileTriggers[entity.id]).map(entity => ({ entity, pile })))
  ];
}

/** A compact effect ledger beside the current observation. No new judgment or
 * action policy: owner, activation, trigger, expiry and unknown coverage. */
export function describeCombatEffects(combat) {
  const sources = [
    ...(combat.player.powers || []).map(entity => ({ entity, category: 'powers', owner: 'player', active: true })),
    ...combat.enemies.filter(e => e.is_alive && e.hp > 0).flatMap(e => (e.powers || []).map(entity => ({ entity, category: 'powers', owner: e.combat_id, active: true }))),
    ...(combat.player.relics || []).map(entity => ({ entity, category: 'relics', owner: 'player', active: true })),
    ...cardSources(combat).map(({ entity, pile }) => ({ entity, pile, category: 'cards', owner: 'player',
      active: pileTriggers[entity.id] ? pileTriggers[entity.id].pile === pile : ['BURN', 'TOXIC'].includes(entity.id) })),
    ...(combat.player.potions || []).map(entity => ({ entity, category: 'potions', owner: 'player', active: entity.usage === 'Automatic' }))
  ];
  const effects = [];
  for (const { entity, category, owner, active, pile } of sources) {
    const id = idOf(entity), definition = timing[id], rule = lookupRule(category, entity.id);
    const pileTrigger = category === 'cards' ? pileTriggers[id] : null;
    const description = entity.description || '';
    const potion = category === 'potions' ? potionEffectFacts(entity) : null;
    if (!definition && !potion && !temporal.test(description) && !turnEnd.test(description)) continue;
    const expires = potion?.expires_at ?? definition?.expires ?? (pileTrigger ? 'leaves_required_pile' : null);
    effects.push({ source_id: entity.id, category, owner, active,
      ...(entity.details?.instance_id ? { card_instance_id: entity.details.instance_id } : {}),
      ...(pileTrigger ? { observed_pile: pile, required_pile: pileTrigger.pile, trigger_condition: pileTrigger.condition } : {}),
      ...(entity.slot === undefined ? {} : { potion_slot: entity.slot }),
      ...(Number.isFinite(entity.amount) ? { current_amount: entity.amount } : {}),
      live_rule: description, wiki_rule_id: rule ? `${category}/${rule.id}` : null,
      activation: active ? 'already_present' : pileTrigger ? 'enters_required_pile' : category === 'potions' ? 'after_use' : 'after_play',
      trigger: definition?.trigger ?? (pileTrigger ? 'owner_auto_post_play_phase' : potion ? 'subsequent_matching_card_effects' : turnEnd.test(description) ? 'declared_turn_end' : null), expires,
      ...(definition?.consequence ? { consequence: definition.consequence } : {}),
      ...(definition?.detail ? { timing_detail: definition.detail } : {}),
      ...(pileTrigger ? { timing_detail: 'This automatic play requires the stated pile condition when the hook resolves. Being in hand or playing the card manually does not establish it. Draw-pile contents do not reveal the top card; automatic-play effects are not simulated.' } : {}),
      ...(potion ? { followup: potion.affected_quantity, amount_after_use: potion.amount, retroactive: false } : {}),
      timing_coverage: definition || potion || pileTrigger ? 'versioned_rule_adapter' : 'live_rule_only_do_not_assume_no_effect'
    });
  }
  return { game_version: 'v0.111.0', effects,
    scope: 'Resolved live rules and public timing semantics. Ordinary hand cards and manually used potions require activation; automatic potions are armed while held, and pile-dependent cards require their stated pile and trigger conditions. Wiki example numbers are never current stacks. This ledger describes causal timing, not fully simulated outcomes; read uncomputed effects in each candidate projection.',
    phase_order: ['player_actions_and_immediate_reactions', 'player_end_early_block', 'player_end_damage_and_expiry', 'enemy_start_countdowns', 'enemy_actions_and_reactions', 'enemy_end_expiry', 'next_player_turn_start'] };
}

// This is dependency detection, not execution of arbitrary English rules.
// A match means an endpoint cannot be fully calculated by the current adapter.
const turnEnd = /\b(?:(?:at|on) (?:the )?end of [^.]{0,28}\bturns?|(?:if|when|whenever) you end (?:a |your |the )?turn)\b/i;
const healthChange = /\b(?:damage|Block|HP|health|heal|die|death)\b/i;
export function knownTurnEndDamage(combat, remainingHand, depleted = new Set()) {
  const events = [];
  for (const card of remainingHand) if (['BURN', 'TOXIC'].includes(card.id)) {
    const amount = card.damage ?? Number(card.description?.match(/\btake (\d+) damage\b/i)?.[1]);
    if (Number.isFinite(amount) && amount >= 0) events.push({ source_id: card.id, hand_index: card.index, amount,
      timing: 'player_turn_end_after_early_block', damage_kind: 'unpowered_blockable', condition: 'remains_in_hand' });
  }
  for (const power of combat.player.powers || []) if (power.id === 'CONSTRICT_POWER' && Number.isFinite(power.amount)) {
    const appliers = combat.enemies.filter(e => e.id === 'SLITHERING_STRANGLER');
    // Native state currently does not expose Applier. A unique rule-named
    // enemy permits this condition; multiple possible appliers stay unknown.
    if (appliers.length !== 1) continue;
    const enemy = appliers[0];
    events.push({ source_id: power.id, owner_combat_id: enemy.combat_id,
      amount: enemy.is_alive && enemy.hp > 0 && !depleted.has(enemy.combat_id) ? Math.max(0, power.amount) : 0,
      timing: 'player_turn_end_after_early_block', damage_kind: 'unpowered_blockable', condition: 'unique_rule_named_applier_survives' });
  }
  return events;
}

export function uncomputedTurnEndHealthEffects(combat, remainingHand = combat.hand || [], known = knownTurnEndDamage(combat, remainingHand)) {
  const sources = [
    ...(combat.player.powers || []).map(p => ({ category: 'power', ...p })),
    ...(combat.player.relics || []).map(r => ({ category: 'relic', ...r })),
    ...cardSources(combat, remainingHand).filter(({ entity, pile }) => !pileTriggers[entity.id] || pileTriggers[entity.id].pile === pile)
      .map(({ entity, pile }) => ({ ...entity, category: pile === 'hand' ? 'hand_card' : 'pile_card', pile }))
  ];
  const knownBlock = source => source.id === 'PLATING_POWER' && Number.isFinite(source.amount) || source.id === 'ORICHALCUM'
    || source.id === 'CLOAK_CLASP' && /gain \d+ Block for each card in your Hand/i.test(source.description || '');
  return sources.filter(s => !knownBlock(s) && !known.some(e => e.source_id === s.id && (s.index === undefined || e.hand_index === s.index))
    && turnEnd.test(s.description || '') && healthChange.test(s.description || '')).map(s => {
    const outgoing = /\bdeal\b[^.]*\bdamage\b[^.]*\benem(?:y|ies)\b/i.test(s.description || '');
    return {
    category: s.category, source_id: s.id, ...(s.category === 'hand_card' && s.index !== undefined ? { hand_index: s.index } : {}),
    ...(s.pile ? { observed_pile: s.pile } : {}),
    ...(s.details?.instance_id ? { card_instance_id: s.details.instance_id } : {}),
    description: s.description, ...(s.amount === undefined ? {} : { amount: s.amount }),
    timing: timing[idOf(s)]?.trigger ?? (pileTriggers[s.id] ? 'owner_auto_post_play_phase' : 'declared_turn_end'),
    condition_evaluated: pileTriggers[s.id]?.condition_evaluated ?? false,
    ...(pileTriggers[s.id] ? { condition: pileTriggers[s.id].condition } : {}),
    affected_outputs: ['end_turn_hp', 'end_turn_fatality', 'block_after_turn_end_effects', ...(outgoing ? ['enemy_hp', 'enemy_response_after_end_effects'] : [])],
    ...(outgoing ? { enemy_response_dependency: {
      order: ['conditional_end_effect', 'enemy_damage_and_prevention', 'enemy_hp_threshold_or_death_reactions', 'remaining_enemy_actions'],
      enemies_before_unresolved_end_effects: combat.enemies.filter(e => e.is_alive && e.hp > 0).map(e => ({ combat_id: e.combat_id, hp: e.hp, block: e.block,
        current_power_ids: (e.powers || []).map(p => p.id) })),
      target_selection_simulated: false,
      scope: 'Enemy baselines may already include the declared prefix; they are not a new observation, predicted random recipient or future hittable set. Read their powers: damage may interrupt an attack, remove Strength, change phase or end combat. Current intent damage is a baseline before these unresolved effects.' } } : {}),
    scope: 'The current rule mentions turn-end health, damage or Block. Only an explicitly marked pile condition is evaluated; automatic plays, timing order, prevention, enemy reactions and healing are not simulated. This does not promise the trigger will remain available after other effects. Use the full current rule; absent calculation is not zero effect.'
  }; });
}

/** Express the lifetime of a next-card bonus against only the declared suffix.
 * A missing consumer is not a ban on the action: other on-play effects, draws
 * or automatic cards can still give value and require their own observation. */
export function describeEffectLifecycle(state, steps) {
  const end = steps.findIndex(s => s.kind === 'end_turn');
  const sequence = end < 0 ? steps : steps.slice(0, end);
  const triggers = [];
  const add = (source, category, index) => {
    const kind = nextCardKind(source.description);
    if (!kind || !/\bthis turn\b/i.test(source.description || '')) return;
    const following = sequence.slice(index + 1);
    const capacity = category === 'active_power' && Number.isSafeInteger(source.amount) ? source.amount
      : Number(source.description.match(/\bnext (\d+) /i)?.[1] || 1);
    const consumers = following.filter(step => step.kind === 'play_card' && (kind === 'Any'
      || (step.card_type || state.combat.hand.find(card => card.details?.instance_id === step.card_instance_id)?.type) === kind));
    const consumer = consumers[0];
    triggers.push({ source_category: category, source_id: source.id, source_sequence: index < 0 ? null : index,
      required_card_type: kind, expires_at: 'owner_turn_end', available_triggers: capacity,
      declared_manual_consumers: Math.min(capacity, consumers.length),
      unused_triggers_at_declared_end: end >= 0 ? Math.max(0, capacity - consumers.length) : null,
      first_consumer: consumer ? { card_id: consumer.card_id, card_instance_id: consumer.card_instance_id, name: consumer.name } : null,
      possible_new_consumer_requires_observation: following.some(step => step.kind === 'use_potion'
        || /\b(?:draw|create|add|generate|return)\b[^.]*\b(?:cards?|hand)\b/i.test(step.rules_at_planning || '')),
      plan_reaches_end_turn: end >= 0 });
  };
  for (const p of state.combat.player.powers || []) add(p, 'active_power', -1);
  sequence.forEach((step, index) => {
    const card = state.combat.hand.find(c => c.details?.instance_id === step.card_instance_id);
    if (card) add(card, 'planned_card', index);
  });
  const modifiers = [];
  sequence.forEach((step, index) => {
    const card = state.combat.hand.find(c => c.details?.instance_id === step.card_instance_id);
    const potion = step.kind === 'use_potion' ? state.combat.player.potions?.find(p => p.slot === step.slot) : null;
    const effect = potion && potionEffectFacts(potion);
    if (card?.id !== 'RAGE' && effect?.duration !== 'turn') return;
    const quantity = card?.id === 'RAGE' ? 'block_after_attack_play' : effect.affected_quantity;
    const following = sequence.slice(index + 1).filter(s => s.kind === 'play_card')
      .map(s => state.combat.hand.find(c => c.details?.instance_id === s.card_instance_id)).filter(Boolean);
    const consumers = following.filter(c => quantity === 'powered_block_gain'
      ? c.type !== 'Power' && Number.isFinite(c.block) && c.block > 0 : c.type === 'Attack');
    modifiers.push({ source_id: (potion || card).id, source_sequence: index, affected_quantity: quantity,
      expires_at: 'owner_turn_end', retroactive: false, declared_known_consumers: consumers.map(c => c.details.instance_id),
      plan_reaches_end_turn: end >= 0, coverage: 'Current known card consumers only; generated, drawn or automatic plays require observation. A missing consumer is not a ban and does not ignore independent on-play triggers.' });
  });
  return triggers.length || modifiers.length ? { is_observed_effect: false, next_card_triggers: triggers, expiring_modifiers: modifiers,
    scope: 'Explicit next-card bonuses that expire this turn, checked against the declared manual sequence. Zero consumers means that bonus is not used by those declared steps before expiry; it does not rule out separate on-play benefits, automatic plays or new cards obtained after observation. A plan segment without end_turn can still be extended. This is current rule/intent analysis, not additional history.' } : null;
}
