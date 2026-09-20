import fs from 'node:fs';
import path from 'node:path';

const PROVIDERS = {
  typesafe: { url: 'https://api.typesafe.ai/v1/systemone', key: 'TYPESAFE_API_KEY', model: 'jev-latest' },
  openrouter: { url: 'https://openrouter.ai/api/alpha/decisions', key: 'OPENROUTER_API_KEY', model: 'typesafe/jev-1.13' }
};

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
  if (!settings) throw new Error('JEV_PROVIDER must be typesafe or openrouter');
  let model = options.model || env.JEV_MODEL || settings.model;
  if (provider === 'openrouter' && model === 'jev-latest') model = '~typesafe/jev-latest';
  else if (provider === 'openrouter' && /^jev-/.test(model)) model = `typesafe/${model}`;
  else if (provider === 'typesafe') model = model.replace(/^~?typesafe\//, '');
  if (!/^(?:~?typesafe\/)?jev-[A-Za-z0-9.-]+$/.test(model)) throw new Error('JEV_MODEL must name a Jev model');
  return { provider, model, url: settings.url, apiKey: options.apiKey ?? env[settings.key] ?? '', keyName: settings.key };
}

export function getJevApiKey(options = {}) { return getJevConfig(options).apiKey; }
export function getJevModel(options = {}) { return getJevConfig(options).model; }

/** Both providers accept native state/questions and return typed answers. */
export async function requestJev(payload, options = {}) {
  const config = getJevConfig({ ...options, model: payload.model || options.model });
  if (!config.apiKey) throw new Error(`${config.keyName} not found`);
  const wirePayload = { ...payload, model: config.model };
  const body = JSON.stringify(wirePayload);
  const metrics = options.metrics ? { ...options.metrics, request_bytes: Buffer.byteLength(body) } : undefined;
  if (metrics && metrics.request_bytes > metrics.max_request_bytes) throw new Error('Complete context exceeds the configured request budget');
  options.onRequest?.(wirePayload, metrics);
  const response = await (options.fetchImpl || globalThis.fetch)(config.url, {
    method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body, signal: AbortSignal.timeout(options.timeoutMs ?? 30000)
  });
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
    throw new Error(`Jev API error ${response.status}${typeof kind === 'string' && /^[a-z_]{1,80}$/.test(kind) ? ` (${kind})` : ''} via ${config.provider}`);
  }
  return response.json();
}
