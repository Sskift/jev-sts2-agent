import fs from 'node:fs';
import path from 'node:path';
import { ModClient } from '../src/mod_client.mjs';
import { buildModCandidates, prepareModDecision } from '../src/mod_decision.mjs';
import { buildDecisionContext, DecisionMemory } from '../src/decision_context.mjs';
import { createSession } from '../src/artifacts.mjs';
import { compileModelRequest } from '../src/context_compiler.mjs';

// Read-only preflight: no model request, no game actions and no memory mutation.
const client = new ModClient();
try {
  const state = await client.state({ includePileDetails: true });
  const memory = new DecisionMemory({ file: path.resolve('run-artifacts/mod-memory.json') });
  const candidates = buildModCandidates(state);
  const prepared = candidates.size || candidates.selectionPlan ? prepareModDecision(state, { memory }) : null;
  const directory = createSession();
  const compiled = prepared?.payload ? compileModelRequest(prepared.payload, prepared.metrics) : null;
  fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify(state, null, 2) + '\n');
  fs.writeFileSync(path.join(directory, 'decision-context.json'), JSON.stringify(prepared?.payload.state || buildDecisionContext(state, { candidates, memory }), null, 2) + '\n');
  if (compiled) fs.writeFileSync(path.join(directory, 'model-context.json'), JSON.stringify(compiled.payload.state, null, 2) + '\n');
  console.log(JSON.stringify({ directory, screen: state.screen, legal_actions: prepared?.candidates.size ?? candidates.size, selection_planning: Boolean(prepared?.selectionPlan),
    metrics: compiled ? { ...prepared.metrics, ...compiled.metrics, request_bytes: compiled.bytes } : null,
    preview_scope: 'Canonical and compiled current-choice context; no strategic assessment or turn planning has been requested. Readability expansion at the live send boundary may change encoding without changing content.',
    model_called: false, game_actions_sent: 0 }));
} catch (error) {
  console.error(JSON.stringify({ error: error.message, details: error.details })); process.exitCode = 1;
} finally { client.close(); }
