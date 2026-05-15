// Claude Fact Guard — background service worker (MV3)
//
// Receives messages from the side panel:
//   - VERIFY:        fact-check the latest Claude response using the chosen
//                    provider (Perplexity Web tab, Perplexity API, or OpenRouter)
//   - SET_CONTEXT:   store an interview-prep context that gets prepended to
//                    every subsequent VERIFY call (or, for the web provider,
//                    seeded into the Perplexity thread on first use)
//   - GET_STATE:     return current settings + last verdict for UI hydration
//   - RESET_STATS:   zero the per-session counters
//   - RESET_PERPLEXITY_THREAD: forget the current Perplexity thread tab and
//                              start a fresh one on the next VERIFY
//   - OPEN_PERPLEXITY_TAB:     focus or create the Perplexity tab
//
// Also opens the side panel when the toolbar action icon is clicked.
//
// Three providers are supported:
//   - perplexity-web: drive the user's logged-in www.perplexity.ai tab via
//                     a content script (no API cost — rides on Pro subscription)
//   - perplexity:     direct REST call to https://api.perplexity.ai/chat/completions
//   - openrouter:     https://openrouter.ai/api/v1/chat/completions (model = perplexity/<sonar-variant>)

const PROVIDERS = {
  'perplexity-web': {
    label: 'Perplexity Web (your tab)',
    kind: 'web',
    requiresKey: false,
    models: [
      { id: 'web', label: 'Whatever your Perplexity tab is set to (Pro / Sonar / Auto)' },
    ],
    defaultModel: 'web',
    keyHint: '',
    keyHelpUrl: 'https://www.perplexity.ai/',
  },
  perplexity: {
    label: 'Perplexity API (direct)',
    kind: 'api',
    endpoint: 'https://api.perplexity.ai/chat/completions',
    requiresKey: true,
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
    kind: 'api',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    requiresKey: true,
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

const DEFAULT_PROVIDER = 'perplexity-web';
const PERPLEXITY_URL = 'https://www.perplexity.ai/';
const PERPLEXITY_HOST_RE = /^https:\/\/(?:www\.)?perplexity\.ai\//;

const STORAGE_KEYS = {
  provider: 'provider',
  apiKey: {
    perplexity: 'pplxKey',
    openrouter: 'openrouterKey',
  },
  model: 'model',
  context: 'context',
  // perplexity-web only
  webVisible: 'perplexityWebVisible',
  webCustomInstructions: 'perplexityWebCustomInstructions',
};

const SESSION_KEYS = {
  stats: 'stats',
  webThreadTabId: 'pplxThreadTabId',
  webThreadSeeded: 'pplxThreadSeeded',
  dedupCache: 'verifyDedup',
};

// Default custom instructions for the web provider. Prepended to the FIRST
// message of every new Perplexity thread to set the fact-checker's posture.
// Structured with explicit sections + one-shot example so Perplexity follows
// the output format reliably.
const DEFAULT_WEB_CUSTOM_INSTRUCTIONS = [
  'ROLE',
  'You are my strict fact-checker. I will paste AI assistant responses; verify their factual claims against current authoritative web sources. Always run a fresh search — do not rely on your own memory.',
  '',
  'SCOPE',
  'Fact-check ONLY:',
  '  • numbers, dates, version strings, release timelines',
  '  • named entities (people, products, papers, RFCs, standards)',
  '  • public API / library / framework behavior and syntax',
  '  • definitions of established technical terms',
  'Do NOT flag:',
  '  • opinions, style preferences, design choices',
  '  • conceptual or pedagogical explanations',
  '  • code that is functionally correct even if not idiomatic',
  '  • paraphrasing differences when the substance is right',
  '',
  'STRICTNESS',
  'Flag anything even 1% off, outdated, or misleading. If sources are mixed or ambiguous, treat that as inaccurate and say so explicitly.',
  '',
  'OUTPUT — choose exactly one form, nothing else:',
  '',
  '  (A) If fully accurate:',
  '        Accurate.',
  '',
  '  (B) If anything is inaccurate, one paragraph in this exact form:',
  '        Actually <wrong claim> is wrong — the correct fact is <correct fact> because <brief verifiable reason> [n].',
  '      • Cite at least one source [n] for every claim.',
  '      • For multiple issues, chain with ". Also, " using the same template for each issue.',
  '      • End with: " Please correct only those points and keep the rest of the explanation unchanged."',
  '',
  'EXAMPLES',
  '  Accurate.',
  '',
  '  Actually Python 3.11 being the current LTS is wrong — the correct fact is that Python has no LTS designation and 3.12 is the current stable line as of Oct 2023 [1]. Also, Spring Boot 3.0 supporting Java 8 is wrong — the correct fact is Spring Boot 3.x requires Java 17+ because the baseline was bumped in the 3.0 release [2]. Please correct only those points and keep the rest of the explanation unchanged.',
  '',
  'FORBIDDEN',
  '  • Do not mention Perplexity, Sonar, Gemini, ChatGPT, OpenAI, OpenRouter, or any tool/model name in the output.',
  '  • No markdown headings or bullets in the output, only the one paragraph (or the single word "Accurate.").',
  '  • No preamble, no postamble.',
].join('\n');

const MAX_RESPONSE_CHARS = 8000;
const MAX_CONTEXT_CHARS = 8000;
const DEDUP_CACHE_MAX = 20;

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
  const data = await getSession(SESSION_KEYS.stats);
  return { ...SESSION_DEFAULTS, ...(data[SESSION_KEYS.stats] || {}) };
}

async function updateStats(patch) {
  const current = await getStats();
  const next = { ...current, ...patch, updatedAt: Date.now() };
  await setSessionVal({ [SESSION_KEYS.stats]: next });
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
    STORAGE_KEYS.webVisible,
    STORAGE_KEYS.webCustomInstructions,
  ]);
  const provider =
    data[STORAGE_KEYS.provider] && PROVIDERS[data[STORAGE_KEYS.provider]]
      ? data[STORAGE_KEYS.provider]
      : DEFAULT_PROVIDER;
  const providerCfg = PROVIDERS[provider];
  const model =
    data[STORAGE_KEYS.model] &&
    providerCfg.models.some((m) => m.id === data[STORAGE_KEYS.model])
      ? data[STORAGE_KEYS.model]
      : providerCfg.defaultModel;
  const webVisible =
    typeof data[STORAGE_KEYS.webVisible] === 'boolean'
      ? data[STORAGE_KEYS.webVisible]
      : true;
  const webCustomInstructions =
    typeof data[STORAGE_KEYS.webCustomInstructions] === 'string' &&
    data[STORAGE_KEYS.webCustomInstructions].trim().length > 0
      ? data[STORAGE_KEYS.webCustomInstructions]
      : DEFAULT_WEB_CUSTOM_INSTRUCTIONS;
  return {
    provider,
    perplexityKey: data[STORAGE_KEYS.apiKey.perplexity] || '',
    openrouterKey: data[STORAGE_KEYS.apiKey.openrouter] || '',
    model,
    context: data[STORAGE_KEYS.context] || '',
    webVisible,
    webCustomInstructions,
  };
}

// ---------------------------------------------------------------------------
// Prompt construction — strict fact-checker
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  'ROLE',
  'You are a strict fact-checker. Verify the factual claims of an AI assistant response against current authoritative web sources. Always run a fresh search — do not rely on your own memory.',
  '',
  'SCOPE',
  'Fact-check ONLY:',
  '  • numbers, dates, version strings, release timelines',
  '  • named entities (people, products, papers, RFCs, standards)',
  '  • public API / library / framework behavior and syntax',
  '  • definitions of established technical terms',
  'Do NOT flag:',
  '  • opinions, style preferences, design choices',
  '  • conceptual or pedagogical explanations',
  '  • code that is functionally correct even if not idiomatic',
  '  • paraphrasing differences when the substance is right',
  '',
  'STRICTNESS',
  'Flag anything even 1% off, outdated, or misleading. If sources are mixed or ambiguous, treat that as inaccurate and say so explicitly in the issues list.',
  '',
  'OUTPUT',
  'Return a single JSON object only — no Markdown, no code fences, no commentary — matching this schema:',
  '{',
  '  "accurate": boolean,',
  '  "issues": string[],',
  '  "correction": string',
  '}',
  '',
  'If fully accurate: accurate=true, issues=[], correction="".',
  'If inaccurate: accurate=false, list each specific factual error in "issues", and set "correction" to ONE single paragraph the user can paste back, in this exact form:',
  '  "Actually <wrong claim> is wrong — the correct fact is <correct fact> because <brief verifiable reason>."',
  'For multiple issues, chain in the same paragraph using ". Also, " between each fact, repeating the same "Actually … is wrong — the correct fact is … because …" template for every issue.',
  'End the correction with: " Please correct only those points and keep the rest of the explanation unchanged."',
  '',
  'FORBIDDEN',
  '  • Do not mention Perplexity, Sonar, Gemini, ChatGPT, OpenAI, OpenRouter, or any tool/model name in the output.',
  '  • Do not wrap the JSON in code fences or add commentary around it.',
].join('\n');

function buildUserPrompt({ context, responseText, truncated }) {
  const lines = [];
  if (context && context.trim()) {
    lines.push('SESSION CONTEXT (background only — DO NOT fact-check this block):');
    lines.push('<<<CONTEXT');
    lines.push(context.trim());
    lines.push('CONTEXT>>>');
    lines.push('');
  }
  lines.push('TASK: Fact-check the AI response delimited below using fresh web searches. Follow the SCOPE, STRICTNESS, and OUTPUT rules exactly.');
  lines.push('');
  lines.push('<<<RESPONSE');
  lines.push(responseText);
  lines.push('RESPONSE>>>');
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
// Perplexity Web tab management
// ---------------------------------------------------------------------------

function queryTabs(query) {
  return new Promise((resolve) =>
    chrome.tabs.query(query, (tabs) => resolve(tabs || [])),
  );
}

function getTab(tabId) {
  return new Promise((resolve) =>
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(tab || null);
    }),
  );
}

function createTab(options) {
  return new Promise((resolve) =>
    chrome.tabs.create(options, (tab) => resolve(tab)),
  );
}

function updateTab(tabId, options) {
  return new Promise((resolve) =>
    chrome.tabs.update(tabId, options, (tab) => resolve(tab || null)),
  );
}

async function isTabAlive(tabId) {
  if (!tabId) return false;
  const tab = await getTab(tabId);
  return !!tab && PERPLEXITY_HOST_RE.test(tab.url || '');
}

async function getOrCreatePerplexityTab({ visible }) {
  const session = await getSession([
    SESSION_KEYS.webThreadTabId,
    SESSION_KEYS.webThreadSeeded,
  ]);
  const cachedId = session[SESSION_KEYS.webThreadTabId];
  if (cachedId && (await isTabAlive(cachedId))) {
    if (visible) {
      await updateTab(cachedId, { active: true });
    }
    return { tabId: cachedId, fresh: false, seeded: !!session[SESSION_KEYS.webThreadSeeded] };
  }
  // Try to reuse an existing perplexity tab in any window.
  const existing = await queryTabs({ url: 'https://www.perplexity.ai/*' });
  let tab = existing[0];
  if (!tab) {
    tab = await createTab({
      url: PERPLEXITY_URL,
      active: !!visible,
      pinned: !visible,
    });
  } else if (visible) {
    await updateTab(tab.id, { active: true });
  }
  await setSessionVal({
    [SESSION_KEYS.webThreadTabId]: tab.id,
    [SESSION_KEYS.webThreadSeeded]: false,
  });
  return { tabId: tab.id, fresh: true, seeded: false };
}

function sendToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          error:
            chrome.runtime.lastError.message ||
            'No response from Perplexity tab. Reload the tab and retry.',
        });
      } else {
        resolve(resp || { ok: false, error: 'Empty response from content script.' });
      }
    });
  });
}

async function waitForTabReady(tabId, timeoutMs = 20000) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const tab = await getTab(tabId);
    if (!tab) return { ok: false, error: 'Perplexity tab was closed.' };
    if (tab.status === 'complete') {
      // Wait one more tick for content script to attach.
      await new Promise((r) => setTimeout(r, 400));
      const ping = await sendToTab(tabId, { type: 'PERPLEXITY_PING' });
      if (ping.ok && ping.hasInput) return { ok: true, ping };
      if (ping.ok && !ping.loggedIn) {
        return { ok: false, loggedOut: true, error: 'You are signed out of Perplexity. Sign in and retry.' };
      }
    }
    if (Date.now() - start > timeoutMs) {
      return { ok: false, error: 'Perplexity tab took too long to load.' };
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function resetPerplexityThread() {
  await setSessionVal({
    [SESSION_KEYS.webThreadTabId]: null,
    [SESSION_KEYS.webThreadSeeded]: false,
  });
}

// ---------------------------------------------------------------------------
// Dedup: hash a response so identical text isn't billed twice in a session
// ---------------------------------------------------------------------------

function hashText(text) {
  // FNV-1a 32-bit — cheap, dependency-free, collision-resistant enough for
  // "did the user just verify this exact text in this session".
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

async function getDedupCache() {
  const data = await getSession(SESSION_KEYS.dedupCache);
  const list = data[SESSION_KEYS.dedupCache];
  return Array.isArray(list) ? list : [];
}

async function getCachedVerdict(hash) {
  const list = await getDedupCache();
  return list.find((e) => e?.hash === hash) || null;
}

async function cacheVerdict(hash, verdict) {
  const list = await getDedupCache();
  const filtered = list.filter((e) => e?.hash !== hash);
  filtered.unshift({ hash, verdict, ts: Date.now() });
  await setSessionVal({
    [SESSION_KEYS.dedupCache]: filtered.slice(0, DEDUP_CACHE_MAX),
  });
}

async function clearDedupCache() {
  await setSessionVal({ [SESSION_KEYS.dedupCache]: [] });
}

// ---------------------------------------------------------------------------
// Parse Perplexity-web natural-language answer into a verdict
// ---------------------------------------------------------------------------

function parseWebAnswer(answerText) {
  const trimmed = (answerText || '').trim();
  if (!trimmed) return null;
  // Case 1: "Accurate." (or starts with it on its own line)
  if (/^accurate\.?\s*$/i.test(trimmed)) {
    return { accurate: true, issues: [], correction: '' };
  }
  // First non-empty line / paragraph.
  const firstLine = trimmed.split(/\n{2,}/)[0].trim();
  if (/^accurate\.?$/i.test(firstLine)) {
    return { accurate: true, issues: [], correction: '' };
  }
  // Case 2: paragraph starting with "Actually "… our template.
  const correctionMatch = trimmed.match(/Actually[\s\S]+?(?:Please correct only those points and keep the rest of the explanation unchanged\.?|$)/i);
  if (correctionMatch) {
    const correction = correctionMatch[0].trim();
    // Extract "<wrong claim> is wrong" fragments as the issues list.
    const issues = [];
    const re = /Actually\s+(.+?)\s+is wrong/gi;
    let m;
    while ((m = re.exec(correction)) !== null) {
      issues.push(m[1].trim());
      if (issues.length >= 10) break;
    }
    return {
      accurate: false,
      issues: issues.length ? issues : ['(see correction)'],
      correction,
    };
  }
  // Case 3: Perplexity ignored the template — fall back to surfacing the raw
  // text as the correction but mark it as inaccurate so the user sees it.
  return {
    accurate: false,
    issues: ['Perplexity did not follow the template; raw answer below.'],
    correction: trimmed,
  };
}

// ---------------------------------------------------------------------------
// Verify flow — web provider
// ---------------------------------------------------------------------------

async function verifyViaPerplexityWeb({ settings, responseText, truncated }) {
  const { tabId, seeded } = await getOrCreatePerplexityTab({
    visible: settings.webVisible,
  });
  const ready = await waitForTabReady(tabId);
  if (!ready.ok) return ready;

  const customInstructions =
    settings.webCustomInstructions || DEFAULT_WEB_CUSTOM_INSTRUCTIONS;
  const lines = [];
  if (!seeded) {
    // First message in this thread — install posture + (optional) context.
    lines.push(customInstructions);
    lines.push('');
    if (settings.context && settings.context.trim()) {
      lines.push('SESSION CONTEXT (background only — DO NOT fact-check this block):');
      lines.push('<<<CONTEXT');
      lines.push(settings.context.trim());
      lines.push('CONTEXT>>>');
      lines.push('Use this to understand topic + level. The next message and every message after it is an AI response to fact-check.');
      lines.push('');
    }
    lines.push('TASK: Fact-check the AI response delimited below using fresh web searches. Follow the ROLE, SCOPE, STRICTNESS, and OUTPUT rules above exactly.');
  } else {
    lines.push('TASK: Fact-check the AI response delimited below per the rules in the first message of this thread.');
  }
  lines.push('');
  lines.push('<<<RESPONSE');
  lines.push(responseText);
  lines.push('RESPONSE>>>');
  if (truncated) {
    lines.push('');
    lines.push(`(Note: the response above was truncated to ${MAX_RESPONSE_CHARS} characters.)`);
  }
  const prompt = lines.join('\n');

  const out = await sendToTab(tabId, { type: 'PERPLEXITY_ASK', prompt });
  if (!out.ok) return out;

  if (!seeded) {
    await setSessionVal({ [SESSION_KEYS.webThreadSeeded]: true });
  }

  const parsed = parseWebAnswer(out.answer);
  if (!parsed) {
    return { ok: false, error: 'Perplexity returned an empty answer.', raw: out.answer };
  }
  return {
    ok: true,
    verdict: {
      accurate: parsed.accurate,
      issues: parsed.issues,
      correction: parsed.correction,
      citations: Array.isArray(out.citations) ? out.citations : [],
      partial: !!out.partial,
    },
  };
}

// ---------------------------------------------------------------------------
// Verify flow — API provider (Perplexity direct or OpenRouter)
// ---------------------------------------------------------------------------

async function verifyViaApi({ settings, responseText, truncated }) {
  const apiKey =
    settings.provider === 'perplexity'
      ? settings.perplexityKey
      : settings.openrouterKey;
  const userPrompt = buildUserPrompt({
    context: settings.context,
    responseText,
    truncated,
  });
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
    return {
      ok: false,
      error: 'Could not parse a JSON verdict from the provider response.',
      raw: content,
    };
  }
  return { ok: true, verdict };
}

// ---------------------------------------------------------------------------
// Verify flow — dispatcher
// ---------------------------------------------------------------------------

async function handleVerify(payload) {
  const settings = await getSettings();
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

  // Dedup: return the cached verdict for byte-identical Claude responses
  // in the same session unless explicitly forced.
  const force = !!payload?.force;
  const dedupHash = hashText(responseText);
  if (!force) {
    const cached = await getCachedVerdict(dedupHash);
    if (cached?.verdict) {
      await updateStats({
        lastStatus: cached.verdict.accurate ? 'accurate' : 'inaccurate',
        lastError: null,
        lastVerdict: cached.verdict,
      });
      return { ok: true, verdict: cached.verdict, fromCache: true };
    }
  }

  try {
    const providerCfg = PROVIDERS[settings.provider];
    if (!providerCfg) {
      throw new Error(`Unknown provider: ${settings.provider}`);
    }
    let result;
    if (providerCfg.kind === 'web') {
      result = await verifyViaPerplexityWeb({ settings, responseText, truncated });
    } else {
      result = await verifyViaApi({ settings, responseText, truncated });
    }
    if (!result.ok) {
      await updateStats({ lastStatus: 'error', lastError: result.error, lastVerdict: null });
      await bumpStats('errors');
      return result;
    }
    await bumpStats('verifications');
    if (!result.verdict.accurate) await bumpStats('inaccurate');
    await updateStats({
      lastStatus: result.verdict.accurate ? 'accurate' : 'inaccurate',
      lastError: null,
      lastVerdict: result.verdict,
    });
    await cacheVerdict(dedupHash, result.verdict);
    return { ok: true, verdict: result.verdict, fromCache: false };
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
          await clearDedupCache();
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
          if (typeof msg.webVisible === 'boolean') {
            patch[STORAGE_KEYS.webVisible] = msg.webVisible;
          }
          if (typeof msg.webCustomInstructions === 'string') {
            patch[STORAGE_KEYS.webCustomInstructions] = msg.webCustomInstructions;
          }
          await setSync(patch);
          sendResponse({ ok: true });
          return;
        }
        case 'OPEN_PERPLEXITY_TAB': {
          const settings = await getSettings();
          const { tabId } = await getOrCreatePerplexityTab({
            visible: settings.webVisible,
          });
          await updateTab(tabId, { active: true });
          sendResponse({ ok: true, tabId });
          return;
        }
        case 'RESET_PERPLEXITY_THREAD': {
          await resetPerplexityThread();
          await clearDedupCache();
          sendResponse({ ok: true });
          return;
        }
        case 'PERPLEXITY_WEB_STATUS': {
          const session = await getSession([
            SESSION_KEYS.webThreadTabId,
            SESSION_KEYS.webThreadSeeded,
          ]);
          const tabId = session[SESSION_KEYS.webThreadTabId];
          let alive = false;
          let loggedIn = null;
          if (tabId && (await isTabAlive(tabId))) {
            alive = true;
            const ping = await sendToTab(tabId, { type: 'PERPLEXITY_PING' });
            if (ping.ok) loggedIn = ping.loggedIn;
          }
          sendResponse({
            ok: true,
            tabId: alive ? tabId : null,
            alive,
            loggedIn,
            seeded: !!session[SESSION_KEYS.webThreadSeeded],
          });
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
