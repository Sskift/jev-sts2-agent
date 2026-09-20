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
  const decision = await choose(state, options, phase(prepared, payload, 'camp_concrete_choice'));
  return { ...decision, ...(decision.request?.cmd === 'choose_rest_option' && decision.request.id === 'SMITH'
    ? { camp_upgrade_plan: targetDecision.target } : {}),
    camp_target_decision: targetDecision, usage: {
      input_tokens: (targetDecision.usage?.input_tokens || 0) + (decision.usage?.input_tokens || 0),
      output_tokens: (targetDecision.usage?.output_tokens || 0) + (decision.usage?.output_tokens || 0)
    } };
}
