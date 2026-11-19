// Wada Lens proxy Worker (v2)
// Owns the prompt, model, token limit and output schema. The page sends only colors.
//
// Secrets / variables (Cloudflare dashboard > Worker > Settings):
//   ANTHROPIC_API_KEY   (secret, required)
//   PRIMARY_MODEL       (optional, default below)
//   FALLBACK_MODEL      (optional, default below)
//   EXTRA_ORIGINS       (optional, comma list, e.g. http://localhost:8000)
//   ALERT_WEBHOOK_URL   (optional, e.g. https://ntfy.sh/your-private-topic)
//   ALLOW_LEGACY        (optional, set to "false" to turn off the old passthrough)
//
// Routes:
//   POST /analyze   new thin endpoint used by wada_lens_simple_v23+
//   POST /          legacy passthrough for older pages (origin checked, clamped)
//   GET  /health    live check of the model chain, cached 5 minutes
// Cron trigger (daily) runs the same health check and posts to ALERT_WEBHOOK_URL on failure.

const DEFAULT_PRIMARY = 'claude-sonnet-4-6';
const DEFAULT_FALLBACK = 'claude-sonnet-5-5';
const API_URL = 'https://api.anthropic.com/v1/messages';
const ALLOWED_ORIGINS = [
  'https://losqstudios.github.io',
  'https://losqstudios.com',
  'https://www.losqstudios.com'
];
const MAX_TOKENS = 1500;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const TOOL = {
  name: 'report_wada_reading',
  description: 'Return the Wada Lens analysis of the palette.',
  input_schema: {
    type: 'object',
    properties: {
      reading: { type: 'string', description: '2-3 sentences analyzing harmony and character.' },
      psychology: {
        type: 'array', minItems: 3, maxItems: 3,
        items: { type: 'string', description: 'One psychological effect, 1-2 sentences.' }
      },
      wada: {
        type: 'object',
        properties: {
          chips: {
            type: 'array', minItems: 4, maxItems: 4,
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Wada pigment name' },
                hex: { type: 'string', description: 'Hex color like #A1B2C3' }
              },
              required: ['name', 'hex']
            }
          },
          note: { type: 'string', description: '2-3 sentences connecting to Wada\'s color observations. No plate numbers.' }
        },
        required: ['chips', 'note']
      }
    },
    required: ['reading', 'psychology', 'wada']
  }
};

// ---------- helpers ----------
function originAllowed(request, env) {
  const origin = request.headers.get('Origin') || '';
  const extra = (env.EXTRA_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  return ALLOWED_ORIGINS.concat(extra).includes(origin) ? origin : null;
}
function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin || 'null',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}
function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, origin ? cors(origin) : {})
  });
}
function clean(str, max) {
  return String(str == null ? '' : str).replace(/[<>\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function modelChain(env) {
  const chain = [env.PRIMARY_MODEL || DEFAULT_PRIMARY, env.FALLBACK_MODEL || DEFAULT_FALLBACK];
  return chain.filter((m, i) => m && chain.indexOf(m) === i);
}
function shouldFallback(status, body) {
  if (status === 404 || status === 429 || status === 529 || status >= 500) return true;
  const t = body && body.error && body.error.type;
  const msg = (body && body.error && body.error.message) || '';
  return t === 'not_found_error' || (status === 400 && /model/i.test(msg));
}

async function callAnthropic(env, payload) {
  return fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(payload)
  });
}

// ---------- prompt + validation ----------
function buildPrompt(name, colors) {
  return 'You are a color theory expert specializing in Sanzo Wada\'s 1933 work "A Dictionary of Color Combinations."\n' +
    'A user has built a custom 4-color palette called "' + name + '":\n' +
    colors.map((c, i) => (i + 1) + '. ' + c.name + ' - ' + c.hex).join('\n') + '\n' +
    'Analyze it and respond by calling the report_wada_reading tool. Provide a 2-3 sentence reading of harmony and character, ' +
    'exactly 3 psychological effects (1-2 sentences each), exactly 4 Wada-inspired refinement colors (pigment name and hex), ' +
    'and a 2-3 sentence note connecting to Wada\'s color observations. Do not mention plate numbers.';
}

function validateInput(body) {
  if (!body || typeof body !== 'object') return null;
  if (!Array.isArray(body.colors) || body.colors.length !== 4) return null;
  const colors = [];
  for (const c of body.colors) {
    if (!c || !HEX_RE.test(String(c.hex))) return null;
    colors.push({ hex: String(c.hex).toUpperCase(), name: clean(c.name, 40) || 'Color' });
  }
  return { name: clean(body.name, 60) || 'Custom Palette', colors };
}

function validateResult(r) {
  if (!r || typeof r.reading !== 'string' || !r.reading.trim()) return null;
  if (!Array.isArray(r.psychology) || r.psychology.length < 1) return null;
  if (!r.wada || !Array.isArray(r.wada.chips) || r.wada.chips.length !== 4) return null;
  const chips = [];
  for (const c of r.wada.chips) {
    if (!c || !HEX_RE.test(String(c.hex))) return null;
    chips.push({ name: clean(c.name, 40) || 'Wada color', hex: String(c.hex).toUpperCase() });
  }
  return {
    reading: clean(r.reading, 800),
    psychology: r.psychology.slice(0, 3).map(s => clean(s, 500)).filter(Boolean),
    wada: { chips, note: clean(r.wada.note, 800) }
  };
}

async function analyze(env, name, colors) {
  const chain = modelChain(env);
  let lastErr = 'unknown';
  for (const model of chain) {
    let res, data;
    try {
      res = await callAnthropic(env, {
        model, max_tokens: MAX_TOKENS,
        tools: [TOOL], tool_choice: { type: 'tool', name: TOOL.name },
        messages: [{ role: 'user', content: buildPrompt(name, colors) }]
      });
      data = await res.json();
    } catch (e) { lastErr = 'network'; continue; }
    if (!res.ok || data.type === 'error') {
      lastErr = (data && data.error && data.error.type) || ('http_' + res.status);
      if (shouldFallback(res.status, data)) continue;
      return { ok: false, error: lastErr };
    }
    const block = (data.content || []).find(b => b.type === 'tool_use');
    const result = block && validateResult(block.input);
    if (result) return { ok: true, result, model };
    lastErr = 'bad_shape';
  }
  return { ok: false, error: lastErr };
}

// ---------- health ----------
let healthCache = { t: 0, v: null };
async function healthCheck(env) {
  if (healthCache.v && Date.now() - healthCache.t < 300000) return healthCache.v;
  const out = await analyze(env, 'Health Check', [
    { hex: '#CB1A47', name: 'Red' }, { hex: '#FFEF3D', name: 'Yellow' },
    { hex: '#212121', name: 'Black' }, { hex: '#FEFFF0', name: 'White' }
  ]);
  const v = out.ok ? { ok: true, model: out.model } : { ok: false, error: out.error };
  healthCache = { t: Date.now(), v };
  return v;
}
async function alert(env, text) {
  if (!env.ALERT_WEBHOOK_URL) return;
  try { await fetch(env.ALERT_WEBHOOK_URL, { method: 'POST', body: text }); } catch (e) {}
}

// ---------- entry points ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = originAllowed(request, env);

    if (request.method === 'OPTIONS') {
      return origin ? new Response(null, { status: 204, headers: cors(origin) }) : new Response(null, { status: 403 });
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      const h = await healthCheck(env);
      return json(h, h.ok ? 200 : 503, null);
    }
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, origin);
    if (!origin) return json({ error: 'forbidden' }, 403, null);

    let body;
    try { body = await request.json(); } catch (e) { return json({ error: 'bad_json' }, 400, origin); }

    // New thin endpoint
    if (url.pathname === '/analyze') {
      const input = validateInput(body);
      if (!input) return json({ error: 'bad_input' }, 400, origin);
      const out = await analyze(env, input.name, input.colors);
      if (!out.ok) {
        await alert(env, 'Wada Lens: analyze failed (' + out.error + ')');
        return json({ error: out.error }, 502, origin);
      }
      return json(out.result, 200, origin);
    }

    // Legacy passthrough for older pages (v20-v22 and the catalog page). Turn off with ALLOW_LEGACY=false.
    if (env.ALLOW_LEGACY === 'false') return json({ error: 'legacy_disabled' }, 410, origin);
    if (!body || !Array.isArray(body.messages)) return json({ error: 'bad_input' }, 400, origin);
    const payload = {
      model: modelChain(env)[0],
      max_tokens: Math.min(Number(body.max_tokens) || MAX_TOKENS, MAX_TOKENS),
      messages: body.messages.slice(0, 1)
    };
    const res = await callAnthropic(env, payload);
    return new Response(res.body, {
      status: res.status,
      headers: Object.assign({ 'Content-Type': 'application/json' }, cors(origin))
    });
  },

  async scheduled(event, env, ctx) {
    healthCache = { t: 0, v: null };
    const h = await healthCheck(env);
    if (!h.ok) await alert(env, 'Wada Lens daily check FAILED: ' + h.error);
  }
};
