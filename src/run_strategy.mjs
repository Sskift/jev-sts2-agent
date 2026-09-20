import { ContextError } from './decision_context.mjs';
import { compileModelRequest } from './context_compiler.mjs';
import { strategicCapabilities, developmentPriorities, strategyRefreshReason, rememberRunStrategy } from './run_strategy_state.mjs';

export function needsRunStrategy(state, options, prepared) {
  if (!options.runStrategy || !options.memory || !state.decision_context?.run_id || prepared.candidates.size <= 1) return null;
  if (!['MAP', 'COMBAT', 'REWARD', 'SHOP', 'EVENT', 'REST_SITE', 'TREASURE'].includes(state.screen)) return null;
  return strategyRefreshReason(state, options.memory);
}

export function prepareRunStrategy(state, prepared, reason) {
  const anchors = new Map([['none', { kind: 'none', id: null, name: 'No single owned card or relic defines a supported plan.' }]]);
  for (const [kind, entities] of [['card', state.decision_context.master_deck], ['relic', state.decision_context.player.relics]]) {
    for (const item of entities) anchors.set(`${kind}_${item.id}`, { kind, id: item.id, name: item.name });
  }
  if (anchors.size > 255) throw new ContextError('Strategic anchor choices exceed the model limit; no choices were discarded');
  const instructions = 'Review the current owned build for the remaining run and visible upcoming challenges. Use the entire permanent deck, actual upgrades, relics, resources, current encounter and visible map, linked rules, and confirmed history. Prior strategic judgments are advisory and may be revised. Account for actual frequency, deck dilution, supported combinations and setup cost; do not assume missing support will be acquired. This is a strategic assessment, not a game action or a next-card selection.';
  const questions = Object.fromEntries(Object.entries(strategicCapabilities).map(([id, meaning]) => [`capability_${id}`, {
    type: 'score', instructions: `${instructions} Assess this capability: ${meaning}`,
    criteria: ['Absent or unsupported by the owned build.', 'Weak or unreliable against the visible stage of the run.',
      'Adequate for the visible stage, with meaningful limitations.', 'Strong and reliable for the visible stage without assumed future acquisitions.']
  }]));
  questions.development_priority = { type: 'choice', instructions: `${instructions} Select the development priority that best improves this run over the next visible rooms. This is a direction for comparing concrete offers, not an instruction to take any card with a matching keyword. Immediate survival and a clearly superior offered option can override it. Review reason: ${reason}`,
    criteria: developmentPriorities };
  questions.build_anchor = { type: 'choice', instructions: `${instructions} Which existing card or relic most usefully anchors a coherent plan already supported by the build? Choose none if committing to one item would be speculative. A selected item is a reference to inspect, not a promise to play or preserve it at all costs.`,
    criteria: Object.fromEntries([...anchors].map(([id, anchor]) => [id, anchor])) };
  const payload = { ...prepared.payload, questions }, bytes = compileModelRequest(payload, { purpose: 'run_strategy_assessment' }).bytes;
  if (bytes > prepared.metrics.max_request_bytes) throw new ContextError('Complete strategic context exceeds the request budget');
  return { ...prepared, payload, body: JSON.stringify(payload),
    metrics: { ...prepared.metrics, request_bytes: bytes, question_count: Object.keys(questions).length, purpose: 'run_strategy_assessment' },
    parseResult(result) {
      const confidence = answer => {
        if (answer.confidence !== undefined && (!Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1)) throw new Error('Invalid strategy confidence');
        return answer.confidence ?? null;
      };
      const capabilities = Object.fromEntries(Object.keys(strategicCapabilities).map(id => {
        const answer = result.answers?.[`capability_${id}`];
        if (answer?.type !== 'score' || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > 3) throw new Error('Incomplete or invalid strategic capability answer');
        return [id, { score: answer.score, confidence: confidence(answer) }];
      }));
      const priority = result.answers?.development_priority, anchor = result.answers?.build_anchor;
      if (priority?.type !== 'choice' || !Object.hasOwn(developmentPriorities, priority.choice)
        || anchor?.type !== 'choice' || !anchors.has(anchor.choice)) throw new Error('Invalid strategic priority or anchor');
      return { action: 'assess_run_strategy', capabilities, priority: { choice: priority.choice, confidence: confidence(priority) },
        anchor: { ...anchors.get(anchor.choice), confidence: confidence(anchor) } };
    }
  };
}

export async function refreshRunStrategy(state, options, prepared, choose) {
  const reason = needsRunStrategy(state, options, prepared);
  if (!reason) return null;
  const result = await choose(state, options, prepareRunStrategy(state, prepared, reason));
  const current = rememberRunStrategy(options.memory, state, result, reason);
  options.onRunStrategy?.({ ...result, revision: current.revision, basis: current.basis, reason });
  return result;
}
