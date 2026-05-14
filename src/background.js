// Claude Fact Guard — background service worker (MV3)
//
// Receives messages from the side panel:
//   - VERIFY:        fact-check the latest Claude response with Perplexity Sonar
//   - SET_CONTEXT:   store an interview-prep context that will be prepended to
//                    every subsequent VERIFY call (also used standalone as a
//                    sanity check that the API key + provider work)
//   - GET_STATE:     return current settings + last verdict for UI hydration
//   - RESET_STATS:   zero the per-session counters
//
// Also opens the side panel when the toolbar action icon is clicked.
//
// Only Perplexity Sonar is supported, via two API paths:
//   - Direct:     https://api.perplexity.ai/chat/completions
//   - OpenRouter: https://openrouter.ai/api/v1/chat/completions  (model = perplexity/<sonar-variant>)

const PROVIDERS = {
  perplexity: {
    label: 'Perplexity (direct)',
    endpoint: 'https://api.perplexity.ai/chat/completions',
    models: [
      { id: 'sonar', label: 'Sonar — cheapest, web-grounded (recommended)' },
      { id: 'sonar-pro', label: 'Sonar Pro — stronger search + longer context' },
      { id: 'sonar-reasoning', label: 'Sonar Reasoning — reasoning + search' },
      { id: 'sonar-reasoning-pro', label: 'Sonar Reasoning Pro — strongest, slowest' },
    ],
    defaultModel: 'sonar',
    keyHint: 'pplx-...',
    keyHelpUrl: 'https://www.perplexity.ai/settings/api',
  },
  openrouter: {
    label: 'OpenRouter',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    models: [
      { id: 'perplexity/sonar', label: 'perplexity/sonar — cheapest, web-grounded (recommended)' },
      { id: 'perplexity/sonar-pro', label: 'perplexity/sonar-pro — stronger search + longer context' },
      { id: 'perplexity/sonar-reasoning', label: 'perplexity/sonar-reasoning — reasoning + search' },
      { id: 'perplexity/sonar-reasoning-pro', label: 'perplexity/sonar-reasoning-pro — strongest' },
    ],
    defaultModel: 'perplexity/sonar',
    keyHint: 'sk-or-...',
    keyHelpUrl: 'https://openrouter.ai/settings/keys',
  },
};

const STORAGE_KEYS = {
  provider: 'provider',
  apiKey: {
    perplexity: 'pplxKey',
    openrouter: 'openrouterKey',
  },
  model: 'model',
  context: 'context',
};

const MAX_RESPONSE_CHARS = 8000;
const MAX_CONTEXT_CHARS = 8000;

const SESSION_DEFAULTS = {
  verifications: 0,
  inaccurate: 0,
  errors: 0,
  lastStatus: 'idle',
  lastError: null,
  lastVerdict: null,
  updatedAt: 0,
};

// ---------------------------------------------------------------------------
// Toolbar action -> open side panel
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch(() => {});
  }
});

chrome.action?.onClicked.addListener(async (tab) => {
  if (!chrome.sidePanel?.open) return;
  try {
    if (tab?.windowId != null) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
  } catch (err) {
    console.warn('[CFG] sidePanel.open failed', err);
  }
});

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function getSync(keys) {
  return new Promise((resolve) =>
    chrome.storage.sync.get(keys, (r) => resolve(r || {})),
  );
}

function setSync(values) {
  return new Promise((resolve) =>
    chrome.storage.sync.set(values, () => resolve()),
  );
}

function getSession(keys) {
  return new Promise((resolve) =>
    chrome.storage.session.get(keys, (r) => resolve(r || {})),
  );
}

function setSessionVal(values) {
  return new Promise((resolve) =>
    chrome.storage.session.set(values, () => resolve()),
  );
}

async function getStats() {
  const data = await getSession('stats');
  return { ...SESSION_DEFAULTS, ...(data.stats || {}) };
}

async function updateStats(patch) {
  const current = await getStats();
  const next = { ...current, ...patch, updatedAt: Date.now() };
  await setSessionVal({ stats: next });
  return next;
}

async function bumpStats(field) {
  const current = await getStats();
  return updateStats({ [field]: (current[field] || 0) + 1 });
}

async function getSettings() {
  const data = await getSync([
    STORAGE_KEYS.provider,
    STORAGE_KEYS.apiKey.perplexity,
    STORAGE_KEYS.apiKey.openrouter,
    STORAGE_KEYS.model,
    STORAGE_KEYS.context,
  ]);
  const provider =
    data[STORAGE_KEYS.provider] && PROVIDERS[data[STORAGE_KEYS.provider]]
      ? data[STORAGE_KEYS.provider]
      : 'perplexity';
  const providerCfg = PROVIDERS[provider];
  const model =
    data[STORAGE_KEYS.model] &&
    providerCfg.models.some((m) => m.id === data[STORAGE_KEYS.model])
      ? data[STORAGE_KEYS.model]
      : providerCfg.defaultModel;
  return {
    provider,
    perplexityKey: data[STORAGE_KEYS.apiKey.perplexity] || '',
    openrouterKey: data[STORAGE_KEYS.apiKey.openrouter] || '',
    model,
    context: data[STORAGE_KEYS.context] || '',
  };
}

// ---------------------------------------------------------------------------
// Prompt construction — strict fact-checker
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  'You are a critical fact-checker for an interview preparation session.',
  'Your only job is to verify the accuracy of an AI assistant response against authoritative, up-to-date web sources.',
  'Be extremely strict: flag anything even slightly inaccurate, outdated, or misleading — even if only 1% is wrong.',
  'Do NOT add new tangential information. Do NOT flag opinions, stylistic choices, or purely conceptual explanations.',
  'Do NOT mention Perplexity, Gemini, ChatGPT, OpenAI, OpenRouter, or any tool/model name in the correction.',
  '',
  'You MUST output a single JSON object only — no Markdown, no code fences, no commentary — matching this schema:',
  '{',
  '  "accurate": boolean,',
  '  "issues": string[],',
  '  "correction": string',
  '}',
  '',
  'If the response is fully accurate: accurate=true, issues=[], correction="".',
  'If inaccurate: accurate=false, list each specific error in "issues", and produce ONE "correction" string the user can paste back to the original assistant, phrased EXACTLY as:',
  '  "Actually <wrong claim> is wrong — the correct fact is <correct fact> because <brief verifiable reason>."',
  'If there are multiple issues, chain them in the same sentence using ". Also, " between each fact, but keep using the same "Actually … is wrong — the correct fact is … because …" template for every issue.',
  'End the correction with: " Please correct only those points and keep the rest of the explanation unchanged."',
].join('\n');

function buildUserPrompt({ context, responseText, truncated }) {
  const lines = [];
  if (context && context.trim()) {
    lines.push('[Interview-prep session context — use this to understand the topic, do NOT fact-check this section]:');
    lines.push(context.trim());
    lines.push('');
  }
  lines.push('[Assistant response to fact-check — verify every factual claim with web search]:');
  lines.push(responseText);
  if (truncated) {
    lines.push('');
    lines.push(`(Note: the response was truncated to the first ${MAX_RESPONSE_CHARS} characters before being sent.)`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Provider call
// ---------------------------------------------------------------------------

async function callProvider({ provider, apiKey, model, system, user }) {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`Unknown provider: ${provider}`);
  if (!apiKey) throw new Error('Missing API key. Open Settings in the side panel and add one.');

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  if (provider === 'openrouter') {
    // Optional but recommended by OpenRouter for attribution.
    headers['HTTP-Referer'] = 'https://github.com/nbjiragale/claude-fact-guard';
    headers['X-Title'] = 'Claude Fact Guard';
  }

  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.1,
  };

  const resp = await fetch(cfg.endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    let detail = '';
    try {
      const errBody = await resp.text();
      detail = errBody.slice(0, 400);
    } catch (_) {
      /* ignore */
    }
    throw new Error(`${cfg.label} HTTP ${resp.status}: ${detail || resp.statusText}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('Provider returned an empty response.');
  }
  const citations = Array.isArray(data?.citations)
    ? data.citations.filter((c) => typeof c === 'string')
    : [];
  return { content, citations };
}

function extractJson(text) {
  const trimmed = text.trim();
  const cleaned = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  let candidate = cleaned;
  if (!candidate.startsWith('{')) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    candidate = candidate.slice(start, end + 1);
  }
  try {
    return JSON.parse(candidate);
  } catch (_) {
    return null;
  }
}

function normalizeVerdict(parsed, citations) {
  if (!parsed || typeof parsed !== 'object') return null;
  const accurate =
    typeof parsed.accurate === 'boolean' ? parsed.accurate : null;
  if (accurate === null) return null;
  const issues = Array.isArray(parsed.issues)
    ? parsed.issues
        .map((s) => (typeof s === 'string' ? s.trim() : ''))
        .filter((s) => s.length > 0)
    : [];
  const correction =
    typeof parsed.correction === 'string' ? parsed.correction.trim() : '';
  return {
    accurate,
    issues,
    correction: accurate ? '' : correction,
    citations: Array.isArray(citations) ? citations : [],
  };
}

// ---------------------------------------------------------------------------
// Verify flow
// ---------------------------------------------------------------------------

async function handleVerify(payload) {
  const settings = await getSettings();
  const apiKey =
    settings.provider === 'perplexity'
      ? settings.perplexityKey
      : settings.openrouterKey;

  await updateStats({ lastStatus: 'checking', lastError: null });

  const rawText = (payload?.text || '').toString();
  if (!rawText.trim()) {
    const err = 'No assistant response text found to verify. Open Claude.ai and wait for an answer first.';
    await updateStats({ lastStatus: 'error', lastError: err });
    await bumpStats('errors');
    return { ok: false, error: err };
  }
  const truncated = rawText.length > MAX_RESPONSE_CHARS;
  const responseText = truncated ? rawText.slice(0, MAX_RESPONSE_CHARS) : rawText;

  const userPrompt = buildUserPrompt({
    context: settings.context,
    responseText,
    truncated,
  });

  try {
    const { content, citations } = await callProvider({
      provider: settings.provider,
      apiKey,
      model: settings.model,
      system: SYSTEM_PROMPT,
      user: userPrompt,
    });
    const parsed = extractJson(content);
    const verdict = normalizeVerdict(parsed, citations);
    if (!verdict) {
      const err = 'Could not parse a JSON verdict from the provider response.';
      await updateStats({ lastStatus: 'error', lastError: err, lastVerdict: null });
      await bumpStats('errors');
      return { ok: false, error: err, raw: content };
    }
    await bumpStats('verifications');
    if (!verdict.accurate) await bumpStats('inaccurate');
    await updateStats({
      lastStatus: verdict.accurate ? 'accurate' : 'inaccurate',
      lastError: null,
      lastVerdict: verdict,
    });
    return { ok: true, verdict };
  } catch (err) {
    const msg = err?.message || String(err);
    await updateStats({ lastStatus: 'error', lastError: msg });
    await bumpStats('errors');
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case 'VERIFY': {
          const out = await handleVerify(msg);
          sendResponse(out);
          return;
        }
        case 'SET_CONTEXT': {
          const text = (msg.text || '').toString().slice(0, MAX_CONTEXT_CHARS);
          await setSync({ [STORAGE_KEYS.context]: text });
          sendResponse({ ok: true });
          return;
        }
        case 'GET_STATE': {
          const settings = await getSettings();
          const stats = await getStats();
          sendResponse({
            ok: true,
            settings,
            stats,
            providers: PROVIDERS,
          });
          return;
        }
        case 'GET_STATS': {
          const stats = await getStats();
          sendResponse({ ok: true, stats });
          return;
        }
        case 'RESET_STATS': {
          await updateStats({
            ...SESSION_DEFAULTS,
            verifications: 0,
            inaccurate: 0,
            errors: 0,
            lastVerdict: null,
            lastStatus: 'idle',
            lastError: null,
          });
          sendResponse({ ok: true });
          return;
        }
        case 'SAVE_SETTINGS': {
          const patch = {};
          if (msg.provider && PROVIDERS[msg.provider]) {
            patch[STORAGE_KEYS.provider] = msg.provider;
          }
          if (typeof msg.perplexityKey === 'string') {
            patch[STORAGE_KEYS.apiKey.perplexity] = msg.perplexityKey.trim();
          }
          if (typeof msg.openrouterKey === 'string') {
            patch[STORAGE_KEYS.apiKey.openrouter] = msg.openrouterKey.trim();
          }
          if (typeof msg.model === 'string' && msg.model) {
            patch[STORAGE_KEYS.model] = msg.model;
          }
          await setSync(patch);
          sendResponse({ ok: true });
          return;
        }
        default:
          sendResponse({ ok: false, error: `Unknown message type: ${msg?.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();
  return true; // async response
});
