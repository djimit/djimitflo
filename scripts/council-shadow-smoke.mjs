#!/usr/bin/env node
const base = process.env.DJIMITFLO_API_URL || 'http://127.0.0.1:3001/api';
const modelNames = (process.env.COUNCIL_SHADOW_MODELS || 'qwen2.5:0.5b,llama3.2:1b,smollm2:360m').split(',');

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  const body = await response.json();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${JSON.stringify(body)}`);
  return body;
}

const login = await request('/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: process.env.AUTH_BOOTSTRAP_ADMIN_EMAIL, password: process.env.AUTH_BOOTSTRAP_ADMIN_PASSWORD }),
});
const headers = { authorization: `Bearer ${login.token}`, 'content-type': 'application/json' };
let models = await request('/council/models', { headers });

for (const model_name of modelNames.filter(name => !models.some(model => model.model_name === name))) {
  await request('/council/models', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      provider: 'ollama', model_name, capabilities: ['local', 'shadow-evaluation'],
      reasoning_depth: 1, cost_per_1m_tokens: 0, privacy_class: 'local', independence_score: 0.3,
      metadata: { shared_runtime: true, certification: 'shadow' },
    }),
  });
}

models = await request('/council/models', { headers });
const session = await request('/council/sessions', {
  method: 'POST',
  headers,
  body: JSON.stringify({
    task_description: 'Shadow readiness check: identify the operational risks of claiming autonomous readiness without provider and benchmark evidence.',
    mode: 'council', risk_class: 'low', privacy_sensitive: true, custom_models: modelNames,
  }),
});
const result = await request(`/council/sessions/${session.id}/execute`, { method: 'POST', headers });
console.log(JSON.stringify({
  registered_models: models.map(model => model.model_name), session_id: session.id,
  phase: result.session.status, outputs: result.outputs.length, evaluations: result.evaluations.length,
  confidence: result.confidence, duration_ms: result.duration_ms,
}));
