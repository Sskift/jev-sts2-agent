import fs from 'node:fs';
import path from 'node:path';

const PROVIDERS = {
  typesafe: { url: 'https://api.typesafe.ai/v1/systemone', key: 'TYPESAFE_API_KEY', model: 'jev-latest' },
  openrouter: { url: 'https://openrouter.ai/api/alpha/decisions', key: 'OPENROUTER_API_KEY', model: 'typesafe/jev-1.13' },
  vercel: { url: 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model', key: 'AI_GATEWAY_API_KEY', model: 'typesafe-ai/jev' }
};

// Content budget before HTTP JSON escaping, not a tokenizer or provider limit.
export const JEV_REQUEST_BUDGET = 90000;
const cooldowns = new Map();

function localEnv() {
  const file = path.join(process.cwd(), '.env');
  const values = {};
  if (fs.existsSync(file)) for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z_0-9]*)\s*=\s*(.*?)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return { ...values, ...process.env };
}

// Credentials stay here and in the Authorization header, never in decision state.
export function getJevConfig(options = {}) {
  const env = options.env ?? localEnv();
  const provider = options.provider || env.JEV_PROVIDER || 'typesafe';
  const settings = PROVIDERS[provider];
  if (!settings) throw new Error('JEV_PROVIDER must be typesafe, openrouter or vercel');
  const assessmentSetting = Object.hasOwn(options, 'planAssessmentLimit') ? options.planAssessmentLimit : env.JEV_PLAN_ASSESSMENT_LIMIT;
  const planAssessmentLimit = assessmentSetting == null || assessmentSetting === '' ? null : Number(assessmentSetting);
  if (planAssessmentLimit !== null && (!Number.isSafeInteger(planAssessmentLimit) || planAssessmentLimit < 2)) throw new Error('JEV_PLAN_ASSESSMENT_LIMIT must be an integer of at least 2');
  let model = options.model || env.JEV_MODEL || settings.model;
  if (provider === 'openrouter' && model === 'jev-latest') model = '~typesafe/jev-latest';
  else if (provider === 'openrouter' && /^jev-/.test(model)) model = `typesafe/${model}`;
  else if (provider === 'typesafe') model = model.replace(/^~?typesafe\//, '');
  if (provider === 'vercel' ? model !== 'typesafe-ai/jev' : !/^(?:~?typesafe\/)?jev-[A-Za-z0-9.-]+$/.test(model)) throw new Error('JEV_MODEL must name a supported Jev model for this provider');
  return { provider, model, url: settings.url, apiKey: options.apiKey ?? env[settings.key] ?? '', keyName: settings.key, planAssessmentLimit };
}

export function getJevApiKey(options = {}) { return getJevConfig(options).apiKey; }
export function getJevModel(options = {}) { return getJevConfig(options).model; }

/** Transport failover retries judgments only, before any game action exists.
 * Credentials and model names are resolved separately for each provider. */
export async function requestJev(payload, options = {}) {
  const env = options.env ?? localEnv();
  const config = getJevConfig({ ...options, env, model: payload.model || options.model });
  const fallback = options.fallbackProvider ?? env.JEV_FALLBACK_PROVIDER;
  const routingKey = `${config.provider}:${config.apiKey}`, until = cooldowns.get(routingKey) || 0;
  let primaryError;
  if (fallback && fallback !== config.provider && until > Date.now()) {
    primaryError = { retryable: true, failureCode: 'provider_cooldown', retryAfterMs: until - Date.now() };
  } else {
    cooldowns.delete(routingKey);
    try { return await requestOnce(payload, options, config, 1); }
    catch (error) { primaryError = error; }
  }
  if (!fallback || fallback === config.provider || !primaryError.retryable) throw primaryError;
  if (primaryError.retryAfterMs) cooldowns.set(routingKey, Date.now() + primaryError.retryAfterMs);
  const backup = getJevConfig({ env, provider: fallback,
    model: options.fallbackModel || env.JEV_FALLBACK_MODEL || PROVIDERS[fallback]?.model,
    apiKey: options.fallbackApiKey ?? env[PROVIDERS[fallback]?.key] ?? '' });
  const failover = { from: config.provider, to: backup.provider, reason: primaryError.failureCode,
    ...(primaryError.retryAfterMs ? { retry_after_ms: primaryError.retryAfterMs } : {}) };
  const result = await requestOnce(payload, { ...options, metrics: { ...options.metrics, failover } }, backup, 2);
  return { ...result, failover };
}

async function requestOnce(payload, options, config, attempt) {
  if (!config.apiKey) throw new Error(`${config.keyName} not found`);
  const logicalPayload = { ...payload, model: config.model };
  const contentBytes = Buffer.byteLength(JSON.stringify(logicalPayload));
  // The native API accepts state as a string. Explicit compact JSON used fewer
  // input tokens in measured requests, without removing or summarizing facts.
  const encodeState = options.stateEncoding !== 'object' && payload.state && typeof payload.state === 'object';
  const wirePayload = { ...logicalPayload, state: encodeState ? JSON.stringify(payload.state) : payload.state };
  if (config.provider === 'vercel') delete wirePayload.model; // Model is an SDK protocol header.
  const body = JSON.stringify(wirePayload);
  const metrics = { ...options.metrics, provider: config.provider, requested_model: config.model, attempt,
    content_bytes: contentBytes, request_bytes: Buffer.byteLength(body),
    state_encoding: encodeState ? 'compact_json_text' : typeof payload.state === 'string' ? 'text' : 'object',
    byte_budget_scope: 'Logical request before HTTP string escaping; the provider independently enforces token limits.' };
  if (contentBytes > (metrics.max_request_bytes ?? JEV_REQUEST_BUDGET)) throw new Error('Complete context exceeds the configured request budget');
  const traceId = options.onRequest?.(wirePayload, metrics);
  const failure = (message, code, retryable, retryAfterMs) => Object.assign(new Error(message), { failureCode: code, retryable, retryAfterMs });
  let response;
  try {
    response = await (options.fetchImpl || globalThis.fetch)(config.url, {
      method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json',
        ...(config.provider === 'vercel' ? { 'ai-model-id': config.model, 'ai-evaluation-model-specification-version': '4',
          'ai-gateway-protocol-version': '0.0.1', 'ai-gateway-auth-method': 'api-key' } : {}) },
      body, signal: AbortSignal.timeout(options.timeoutMs ?? 30000)
    });
  } catch {
    options.onResponse?.({ error: { type: 'network_or_timeout' }, provider: config.provider }, metrics, traceId);
    throw failure(`Jev network or timeout error via ${config.provider}`, 'network_or_timeout', true, 5000);
  }
  if (!response.ok) {
    let kind;
    try {
      const error = await response.json();
      kind = error?.detail?.error_type ?? error?.error?.type;
      // OpenRouter wraps the upstream JSON inside an HTTP-prefixed message.
      // Parse just that documented observed shape; never log the raw message.
      const upstream = error?.error?.message?.match(/^HTTP \d{3}: (\{.*\})$/s);
      if (!kind && upstream) kind = JSON.parse(upstream[1])?.detail?.error_type;
    } catch {}
    // Provider bodies can echo headers or request data. Keep only a bounded code.
    const safeKind = typeof kind === 'string' && /^[a-z_]{1,80}$/.test(kind) ? kind : undefined;
    const retry = response.headers?.get('retry-after');
    const retryAfterMs = retry ? (/^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now()))
      : response.status === 429 ? 60000 : response.status >= 500 ? 10000 : undefined;
    options.onResponse?.({ error: { status: response.status, type: safeKind, retry_after_ms: retryAfterMs }, provider: config.provider }, metrics, traceId);
    throw failure(`Jev API error ${response.status}${safeKind ? ` (${safeKind})` : ''} via ${config.provider}`,
      safeKind || `http_${response.status}`, [401, 402, 403, 408, 429].includes(response.status) || response.status >= 500, retryAfterMs);
  }
  let raw;
  try { raw = await response.json(); }
  catch {
    options.onResponse?.({ error: { type: 'invalid_json' }, provider: config.provider }, metrics, traceId);
    throw failure(`Invalid Jev response via ${config.provider}`, 'invalid_json', true);
  }
  options.onResponse?.(raw, metrics, traceId);
  if (config.provider !== 'vercel') return raw;
  // The gateway carries TypeSafe confidence separately from typed answers.
  // Copy only reported values; preserve the raw response in the transport log.
  const confidence = raw.providerMetadata?.typesafe?.confidence;
  const answers = Object.fromEntries(Object.entries(raw.answers || {}).map(([id, answer]) => [id,
    Number.isFinite(confidence?.[id]) && confidence[id] >= 0 && confidence[id] <= 1
      ? { ...answer, confidence: answer.confidence ?? confidence[id] } : answer]));
  return { ...raw, answers, model: raw.model || config.model, provider: config.provider,
    usage: { ...raw.usage, input_tokens: raw.usage?.inputTokens ?? raw.usage?.input_tokens,
      output_tokens: raw.usage?.outputTokens ?? raw.usage?.output_tokens } };
}
