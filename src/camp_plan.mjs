import { ContextError } from './decision_context.mjs';
import { compileModelRequest } from './context_compiler.mjs';
import { distinctCampUpgradeTargets, publicCampTarget } from './camp_plan_state.mjs';

function phase(prepared, payload, purpose, parseResult) {
  const metrics = { ...prepared.metrics, purpose };
  const bytes = compileModelRequest(payload, metrics).bytes;
  if (bytes > metrics.max_request_bytes) throw new ContextError('Complete camp planning context exceeds the request budget; no action sent');
  return { ...prepared, payload, metrics: { ...metrics, request_bytes: bytes }, ...(parseResult ? { parseResult } : {}) };
}

export async function decideCamp(state, options, prepared, choose) {
  const targets = distinctCampUpgradeTargets(state);
  if (!targets.length || !prepared.candidates.has('rest_SMITH')) return null;
  if (targets.length > 255) throw new ContextError('Camp upgrade targets exceed the model choice limit; no target was discarded');
  const choices = new Map(targets.map(target => [`upgrade_${target.deck_index}`, target]));
  const conditional = phase(prepared, { ...prepared.payload, questions: { upgrade_target: {
    type: 'choice',
    instructions: 'Assume Smith is chosen at this rest site. Which ONE actual card upgrade best improves this owned deck for the remaining visible route? Compare the exact before/after rules, frequency of drawing the upgraded copy, supported combinations and existing strategic direction. Fully equivalent copies share one option; it upgrades only the indicated single copy. This is a conditional target selection, not a decision to Smith instead of resting; no game action occurs.',
    criteria: Object.fromEntries([...choices].map(([id, target]) => [id, publicCampTarget(target)]))
  } } }, 'camp_upgrade_target', result => {
    const answer = result.answers?.upgrade_target;
    if (answer?.type !== 'choice' || !choices.has(answer.choice)) throw new Error('Invalid conditional camp upgrade target');
    return { action: 'plan_camp_upgrade', target: choices.get(answer.choice), probabilities: answer.probabilities, confidence: answer.confidence };
  });
  const targetDecision = await choose(state, options, conditional);
  options.onPlanningDecision?.(targetDecision);
  const payload = structuredClone(prepared.payload);
  payload.state.screen_state.camp_planning = publicCampTarget(targetDecision.target);
  payload.questions.next_action.instructions += ' Compare the real rest-site options. Smith means exactly the conditional upgrade in intent.camp_planning, not an unspecified powerful upgrade. Compare its incremental benefit with actual capped healing and other rest effects, present HP, potions, remaining route and current build. You may choose any offered action; selecting the hypothetical upgrade above does not commit you to Smith.';
  payload.questions.next_action.criteria.rest_SMITH = { action_id: 'rest_SMITH', command: 'choose_rest_option',
    effect: 'Smith: perform the concrete upgrade in intent.camp_planning, then return to this rest site.' };
  const initial = await choose(state, options, phase(prepared, payload, 'camp_concrete_choice'));
  let decision = initial, comparison = null;
  const survival = payload.state.screen_state.rest_site?.survival_tradeoff;
  const rest = prepared.candidates.get('rest_HEAL');
  const bossNext = survival?.next_room.known_next_is_boss === true;
  // Run 43 reached an ordinary-fight camp at 30 HP and could heal 27, yet
  // upgraded a basic Defend without reviewing the survival tradeoff. A heal
  // worth at least two thirds of current HP merits the same direct review.
  const urgentLowHp = survival?.healing.hp_before <= survival?.healing.effective_hp_gain * 1.5;
  if (initial.request?.id === 'SMITH' && rest && survival?.healing.effective_hp_gain > 0
    && (bossNext || urgentLowHp)) {
    const heal = { action_id: 'rest_HEAL', effect: rest.description, outcome: survival.healing };
    const smith = { action_id: 'rest_SMITH', effect: 'Upgrade exactly one owned card',
      upgrade: publicCampTarget(targetDecision.target) };
    const instructions = bossNext
      ? 'The next known room is the revealed boss. Which camp action better serves surviving and winning that fight? Compare the exact immediate HP before/after Rest with the one concrete Smith upgrade, including its chance to be drawn and played in time, current deck, relics, potions and the visible boss rules. A powerful upgrade can beat healing when survival is already secure, while an upgrade cannot help after a lethal turn. Use the complete current state; do not treat the earlier full-menu choice as a fact or assume hidden future rewards.'
      : 'Rest would add at least two thirds as much HP as the player currently has before the next fights. Compare that exact survival buffer with upgrading this ONE actual card. Consider whether the upgrade is likely to be drawn and paid for before the next dangerous attack, bad opening hands, available potions and the visible route. Smith can still be better when its near-term effect reliably prevents more damage than Rest; an upgrade cannot help if the run dies first. Use the complete current state and do not assume hidden encounters or rewards.';
    const prefix = bossNext ? 'boss_camp' : 'low_hp_camp';
    const questions = Object.fromEntries([[`${prefix}_forward`, smith, heal], [`${prefix}_reverse`, heal, smith]]
      .map(([id, first, second]) => [id, { type: 'choice', instructions, criteria: { first, second } }]));
    const reviewed = await choose(state, options, phase(prepared, { ...payload, questions }, 'camp_survival_comparison', result => {
      const judgments = Object.entries(questions).map(([id, question]) => {
        const answer = result.answers?.[id];
        if (answer?.type !== 'choice' || !Object.hasOwn(question.criteria, answer.choice)) throw new Error('Invalid boss camp comparison');
        return { question: id, action_id: question.criteria[answer.choice].action_id,
          confidence: answer.confidence, probabilities: answer.probabilities };
      });
      return { action: 'compare_camp_survival', reason: bossNext ? 'revealed_boss_next' : 'rest_adds_at_least_two_thirds_current_hp', judgments,
        consensus_action_id: judgments[0].action_id === judgments[1].action_id ? judgments[0].action_id : null };
    }));
    comparison = reviewed;
    options.onPlanningDecision?.(reviewed);
    if (reviewed.consensus_action_id === 'rest_HEAL'
      || (urgentLowHp && reviewed.consensus_action_id !== 'rest_SMITH'))
      decision = { ...rest, candidate_id: 'rest_HEAL', model: reviewed.model };
  }
  return { ...decision, ...(decision.request?.cmd === 'choose_rest_option' && decision.request.id === 'SMITH'
    ? { camp_upgrade_plan: targetDecision.target } : {}),
    ...(comparison ? { initial_camp_choice: { candidate_id: initial.candidate_id, confidence: initial.confidence,
      probabilities: initial.probabilities }, camp_survival_comparison: comparison,
    ...(decision === initial ? {} : { confidence: undefined, probabilities: undefined }) } : {}),
    camp_target_decision: targetDecision, usage: {
      input_tokens: (targetDecision.usage?.input_tokens || 0) + (initial.usage?.input_tokens || 0) + (comparison?.usage?.input_tokens || 0),
      output_tokens: (targetDecision.usage?.output_tokens || 0) + (initial.usage?.output_tokens || 0) + (comparison?.usage?.output_tokens || 0)
    } };
}
