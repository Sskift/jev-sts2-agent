import fs from 'node:fs';
import path from 'node:path';
import { ModClient } from '../src/mod_client.mjs';
import { buildModCandidates, prepareModDecision } from '../src/mod_decision.mjs';
import { buildDecisionContext, DecisionMemory } from '../src/decision_context.mjs';
import { createSession } from '../src/artifacts.mjs';

// Read-only preflight: no model request, no game actions and no memory mutation.
const client = new ModClient();
try {
  const state = await client.state({ includePileDetails: true });
  const memory = new DecisionMemory({ file: path.resolve('run-artifacts/mod-memory.json') });
  const candidates = buildModCandidates(state);
  const prepared = candidates.size ? prepareModDecision(state, { memory }) : null;
  const directory = createSession();
  fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify(state, null, 2) + '\n');
  fs.writeFileSync(path.join(directory, 'decision-context.json'), JSON.stringify(prepared?.payload.state || buildDecisionContext(state, { candidates, memory }), null, 2) + '\n');
  console.log(JSON.stringify({ directory, screen: state.screen, legal_actions: candidates.size, metrics: prepared?.metrics, model_called: false, game_actions_sent: 0 }));
} catch (error) {
  console.error(JSON.stringify({ error: error.message, details: error.details })); process.exitCode = 1;
} finally { client.close(); }
