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
  // auto-verify
  autoVerify: 'autoVerify',
  // inline corrections (highlight wrong claims directly in Claude's reply)
  inlineHighlights: 'inlineHighlights',
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
  '  • less detail than your sources provide — if the claim is correct but shorter, that is ACCURATE',
  '  • "unsupported wording" or missing citations in the original — if the substance is correct, that is ACCURATE',
  '  • anything you cannot find an authoritative source explicitly contradicting',
  '',
  'STRICTNESS',
  'Default to ACCURATE. Only mark INACCURATE when you find authoritative sources that EXPLICITLY contradict a specific factual claim in the response (wrong date, wrong number, wrong version, wrong name, wrong definition, wrong API behavior). Mixed or ambiguous sources — mark ACCURATE and move on, do NOT flag. "Could be more detailed" — ACCURATE. "Source does not explicitly say this exact phrase" — ACCURATE (so long as substance is correct).',
  '',
  'OUTPUT — choose exactly one form, nothing else. The FIRST LINE must be a single word verdict label, uppercase, no punctuation:',
  '',
  '  (A) If the response is correct in substance (even if your sources are more detailed):',
  '        ACCURATE',
  '        <one short sentence describing what you verified, no markdown>',
  '',
  '  (B) If you found at least one authoritative source that explicitly contradicts a factual claim, output ONE block PER wrong claim using this exact line-based schema (do NOT use markdown bullets or prose paragraphs):',
  '        INACCURATE',
  '        QUOTE: "<copy the wrong claim VERBATIM from the response — exact characters, no paraphrasing, no markdown — keep the original capitalisation and punctuation>"',
  '        FIX: <the correct fact in one short sentence>',
  '        WHY: <one short verifiable reason, no markdown> [n]',
  '        ---',
  '        QUOTE: "<next verbatim wrong excerpt>"',
  '        FIX: <correct fact>',
  '        WHY: <reason> [n]',
  '',
  '      • QUOTE must be a contiguous substring of the response you were asked to check. If you cannot quote the wrong text verbatim, do NOT flag it — mark ACCURATE.',
  '      • Each block is separated by a single line containing exactly three hyphens (---).',
  '      • Cite at least one source [n] in WHY for every block.',
  '      • Do not include any prose outside these blocks.',
  '',
  'EXAMPLES',
  '  ACCURATE',
  '  Siddaramaiah is the current CM of Karnataka, sworn in May 20 2023, INC, MLA from Varuna — all substantive claims verified [1][2].',
  '',
  '  INACCURATE',
  '  QUOTE: "Python 3.11 is the current LTS version"',
  '  FIX: Python has no LTS designation; 3.12 is the current stable line as of Oct 2023.',
  '  WHY: PEP 602 and python.org\'s release schedule list no LTS designation; 3.12 was released Oct 2023 [1].',
  '  ---',
  '  QUOTE: "Spring Boot 3.0 supports Java 8"',
  '  FIX: Spring Boot 3.x requires Java 17 or newer.',
  '  WHY: Spring Boot 3.0 release notes explicitly bump the baseline from Java 8 to Java 17 [2].',
  '',
  'FORBIDDEN',
  '  • Do not mention Perplexity, Sonar, Gemini, ChatGPT, OpenAI, OpenRouter, or any tool/model name in the output.',
  '  • No markdown headings, bullets, or prose paragraphs in the output. Only the QUOTE/FIX/WHY schema for INACCURATE.',
  '  • No preamble, no postamble, no extra commentary outside the format above.',
  '  • Never paraphrase the QUOTE — it must be a verbatim substring of the response, otherwise the highlight will not match.',
  '  • Never write INACCURATE for a claim that is factually correct but less detailed or differently phrased. Substance only.',
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

// If the user previously clicked "Save settings" while a now-superseded
// managed default was in the custom-instructions textarea, their storage holds
// a stale prompt that overrides our new default. Detect those and migrate so
// every new release ships the latest fact-checker posture without forcing the
// user to manually reset.
function isLegacyManagedDefault(saved) {
  if (!saved || typeof saved !== 'string') return false;
  // Pre-3.1 free-form default.
  if (saved.includes('critical fact-checker for an interview preparation session')) {
    return true;
  }
  // 3.1.0 structured default (no ACCURATE/INACCURATE first-line label, no
  // "less detail than your sources provide" SCOPE bullet).
  if (
    saved.includes('You are my strict fact-checker. I will paste AI assistant responses') &&
    !saved.includes('less detail than your sources provide')
  ) {
    return true;
  }
  // 3.1.1 structured default (first-line verdict + loosened SCOPE, but the
  // INACCURATE branch was a free-form "Actually X is wrong" paragraph — no
  // QUOTE/FIX/WHY schema yet). Detect by presence of the v3.1.1 SCOPE
  // bullets but absence of the new QUOTE: schema.
  if (
    saved.includes('less detail than your sources provide') &&
    !saved.includes('QUOTE:')
  ) {
    return true;
  }
  return false;
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
    STORAGE_KEYS.autoVerify,
    STORAGE_KEYS.inlineHighlights,
  ]);
  if (isLegacyManagedDefault(data[STORAGE_KEYS.webCustomInstructions])) {
    // Clear the stale stored value so the new default applies. Fire-and-forget
    // — we don't await because the override below already uses the fresh value.
    setSync({ [STORAGE_KEYS.webCustomInstructions]: '' }).catch(() => {});
    data[STORAGE_KEYS.webCustomInstructions] = '';
  }
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
  const autoVerify = data[STORAGE_KEYS.autoVerify] === true;
  // Inline highlights default to ON; only flip off if user has explicitly
  // saved `false`. `undefined` means "never set" → use the default.
  const inlineHighlights =
    data[STORAGE_KEYS.inlineHighlights] === undefined
      ? true
      : data[STORAGE_KEYS.inlineHighlights] === true;
  return {
    provider,
    perplexityKey: data[STORAGE_KEYS.apiKey.perplexity] || '',
    openrouterKey: data[STORAGE_KEYS.apiKey.openrouter] || '',
    model,
    context: data[STORAGE_KEYS.context] || '',
    webVisible,
    webCustomInstructions,
    autoVerify,
    inlineHighlights,
  };
}

// Re-load the autoVerify flag on its own. The settings storage key is in
// chrome.storage.sync, but reads through getSettings hit too many other keys.
async function loadAutoVerifyFlag() {
  const data = await getSync([STORAGE_KEYS.autoVerify]);
  return data[STORAGE_KEYS.autoVerify] === true;
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
  'DEFAULT TO accurate=true. Only set accurate=false when you found authoritative sources that EXPLICITLY contradict a specific factual claim. Mixed or ambiguous sources — accurate=true. Less detailed than your sources — accurate=true. "Unsupported wording" — accurate=true.',
  'If accurate: accurate=true, issues=[], correction="".',
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
    // API providers return free-form JSON without inline-issue quotes, so
    // we just emit an empty array. Inline highlighting is best-effort and
    // only the Web provider supports it today.
    inlineIssues: [],
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

// Chrome surfaces "Could not establish connection. Receiving end does
// not exist." when sendMessage targets a tab that has no listener —
// i.e. the content script for that tab isn't loaded. The most common
// trigger is a tab that existed BEFORE the extension was installed /
// reloaded: content_scripts in manifest.json are not retroactively
// injected into pre-existing tabs.
function isMissingReceiverError(msg) {
  if (!msg) return false;
  return /Receiving end does not exist|Could not establish connection/i.test(msg);
}

function rawSendToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          error: chrome.runtime.lastError.message || 'No response from tab.',
        });
      } else {
        resolve(resp || { ok: false, error: 'Empty response from content script.' });
      }
    });
  });
}

async function injectScriptInto(tabId, files) {
  if (!chrome.scripting?.executeScript) {
    return { ok: false, error: 'chrome.scripting unavailable.' };
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

async function sendToTab(tabId, message) {
  const first = await rawSendToTab(tabId, message);
  if (first.ok || !isMissingReceiverError(first.error)) return first;
  // Receiving end missing — the Perplexity content script never
  // attached (pre-existing tab, or extension was reloaded). Inject
  // it via chrome.scripting and retry once.
  const inject = await injectScriptInto(tabId, ['src/perplexity-content.js']);
  if (!inject.ok) {
    return {
      ok: false,
      error: `Could not attach Perplexity content script: ${inject.error}. Reload the Perplexity tab and retry.`,
    };
  }
  // Give the freshly-injected script a tick to register its listener.
  await new Promise((r) => setTimeout(r, 150));
  return rawSendToTab(tabId, message);
}

async function waitForTabReady(tabId, timeoutMs = 60000) {
  // 60s default — cold first load plus Cloudflare's "Verifying you are human"
  // interstitial routinely takes 20–40s before Perplexity's composer renders.
  const start = Date.now();
  let lastPing = null;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const tab = await getTab(tabId);
    if (!tab) return { ok: false, error: 'Perplexity tab was closed.' };
    if (tab.status === 'complete') {
      // Wait one more tick for content script to attach.
      await new Promise((r) => setTimeout(r, 400));
      const ping = await sendToTab(tabId, { type: 'PERPLEXITY_PING' });
      lastPing = ping;
      if (ping.ok && ping.hasInput && !ping.cfChallenge) {
        return { ok: true, ping };
      }
      // Treat the signed-out signal as final ONLY when we're certain we're on
      // the real Perplexity page (not the CF interstitial). CF clears loggedIn
      // to null so this gate naturally skips it.
      if (ping.ok && ping.loggedIn === false && !ping.cfChallenge) {
        return { ok: false, loggedOut: true, error: 'You are signed out of Perplexity. Sign in to the Perplexity tab and retry.' };
      }
    }
    if (Date.now() - start > timeoutMs) {
      let why = 'Perplexity tab took too long to load.';
      if (lastPing && lastPing.ok) {
        if (lastPing.cfChallenge) {
          why = 'Perplexity is showing a Cloudflare verification page. Switch to the Perplexity tab, complete the "Verify you are human" check, then click Verify again.';
        } else if (!lastPing.hasInput) {
          why = `Could not find the Perplexity composer (URL: ${lastPing.url || 'unknown'}). The page may not be the chat UI, or Perplexity changed their markup. Open the Perplexity tab and confirm the "Ask anything" input is visible, then retry.`;
        }
      } else if (lastPing && !lastPing.ok) {
        why = `Perplexity tab is not responding (${lastPing.error || 'no content-script handshake'}). Reload the Perplexity tab and retry.`;
      }
      return { ok: false, error: why, ping: lastPing || null };
    }
    await new Promise((r) => setTimeout(r, 400));
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

  // Normalize the first non-empty line. The new contract is: first line is a
  // single-word verdict label, uppercase (ACCURATE / INACCURATE), then the
  // explanation. We are lenient — strip leading markdown / punctuation, accept
  // case-insensitive, accept legacy "Accurate." as the entire reply.
  const lines = trimmed.split(/\r?\n/);
  let firstLine = '';
  let rest = '';
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i].trim();
    if (!ln) continue;
    firstLine = ln;
    rest = lines.slice(i + 1).join('\n').trim();
    break;
  }
  const firstToken = firstLine
    .replace(/^[#>*\-\u2022\s\"'\(\[]+/, '') // strip markdown/punct prefix
    .replace(/[.,:;!?\s\"'\)\]]+$/, '')        // strip trailing punct
    .trim()
    .toLowerCase();

  if (firstToken === 'accurate' || firstToken === 'verified') {
    // Accurate verdict. Anything after the first line is treated as a short
    // verification note — surface it via correction so the user can see what
    // sources Perplexity actually checked, but keep accurate=true.
    return {
      accurate: true,
      issues: [],
      inlineIssues: [],
      correction: rest || '',
    };
  }

  if (firstToken === 'inaccurate' || firstToken === 'incorrect' || firstToken === 'wrong') {
    return extractInaccurate(rest || trimmed, /* haveExplicitLabel */ true);
  }

  // Backward-compat: legacy responses without the explicit first-line label.
  // If the whole answer is just "Accurate." treat it as accurate.
  if (/^accurate\.?\s*$/i.test(trimmed)) {
    return { accurate: true, issues: [], inlineIssues: [], correction: '' };
  }
  // Or if the first paragraph alone is "Accurate.".
  const firstPara = trimmed.split(/\n{2,}/)[0].trim();
  if (/^accurate\.?$/i.test(firstPara)) {
    return { accurate: true, issues: [], inlineIssues: [], correction: '' };
  }

  // Legacy: paragraph starting with "Actually … is wrong".
  if (/Actually[\s\S]+?is wrong/i.test(trimmed)) {
    return extractInaccurate(trimmed, /* haveExplicitLabel */ false);
  }

  // Unparseable — default to ACCURATE so we don't mislabel a likely-accurate
  // answer just because the model went off-format. Surface raw text so the
  // user can read it in the side panel.
  return {
    accurate: true,
    issues: [],
    inlineIssues: [],
    correction: trimmed,
  };
}

// Parse the structured INACCURATE body into (a) inlineIssues for the
// content-script highlighter, (b) a flat issues[] array of one-line
// summaries for the side panel, (c) a correction string for the
// "paste back into Claude" affordance.
//
// Recognised schema (v3.2+):
//   QUOTE: "<verbatim wrong excerpt>"
//   FIX: <correct fact>
//   WHY: <reason> [n]
//   ---
//   QUOTE: "..."
//   FIX: ...
//   WHY: ... [n]
//
// Legacy fallback (v3.1.x and earlier): a free-form "Actually X is
// wrong — the correct fact is Y because Z [n]. Also, ..." paragraph.
function extractInaccurate(body, haveExplicitLabel) {
  const text = (body || '').trim();

  const inlineIssues = parseQuoteFixWhyBlocks(text);
  if (inlineIssues.length > 0) {
    const issues = inlineIssues.map(
      (b) => b.quote || b.fix || '(see correction)',
    );
    const correction = inlineIssues
      .map((b) => {
        const parts = [];
        if (b.quote) parts.push(`Actually "${b.quote}" is wrong`);
        if (b.fix) parts.push(`the correct fact is ${b.fix}`);
        if (b.why) parts.push(`because ${b.why}`);
        return parts.join(' — ');
      })
      .join('. Also, ')
      .concat(' Please correct only those points and keep the rest of the explanation unchanged.');
    return {
      accurate: false,
      issues,
      inlineIssues,
      correction,
    };
  }

  // Legacy free-form paragraph.
  const match = text.match(/Actually[\s\S]+?(?:Please correct only those points and keep the rest of the explanation unchanged\.?|$)/i);
  const correction = match ? match[0].trim() : text;

  const issues = [];
  const re = /Actually\s+(.+?)\s+is wrong/gi;
  let m;
  while ((m = re.exec(correction)) !== null) {
    issues.push(m[1].trim());
    if (issues.length >= 10) break;
  }
  return {
    accurate: false,
    issues: issues.length
      ? issues
      : haveExplicitLabel
        ? ['(see correction)']
        : ['Perplexity did not follow the template; raw answer below.'],
    inlineIssues: [],
    correction,
  };
}

// Extract a list of {quote, fix, why, sources[]} blocks from a body that
// uses the QUOTE: / FIX: / WHY: schema separated by --- lines. Tolerant
// of missing fields and extra whitespace; rejects blocks without a
// non-empty QUOTE since we cannot highlight what we can't quote.
function parseQuoteFixWhyBlocks(body) {
  if (!body || !/QUOTE\s*:/i.test(body)) return [];
  const blocks = body
    .split(/^\s*-{3,}\s*$/m)
    .map((b) => b.trim())
    .filter(Boolean);
  const out = [];
  for (const block of blocks) {
    const quoteMatch = block.match(/QUOTE\s*:\s*([\s\S]*?)(?=\n\s*(?:FIX|WHY)\s*:|$)/i);
    const fixMatch = block.match(/FIX\s*:\s*([\s\S]*?)(?=\n\s*(?:QUOTE|WHY)\s*:|$)/i);
    const whyMatch = block.match(/WHY\s*:\s*([\s\S]*?)(?=\n\s*(?:QUOTE|FIX)\s*:|$)/i);
    let quote = quoteMatch ? quoteMatch[1].trim() : '';
    // Strip surrounding straight or smart quotes if present.
    quote = quote
      .replace(/^["\u201C\u201D\u2018\u2019\u00AB]+/, '')
      .replace(/["\u201C\u201D\u2018\u2019\u00BB]+$/, '')
      .trim();
    if (!quote) continue;
    const fix = fixMatch ? fixMatch[1].trim() : '';
    const why = whyMatch ? whyMatch[1].trim() : '';
    const sourceTags = Array.from(
      `${fix}\n${why}`.matchAll(/\[(\d+)\]/g),
      (m) => Number(m[1]),
    );
    out.push({
      quote,
      fix,
      why,
      sourceTags,
    });
    if (out.length >= 12) break;
  }
  return out;
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
      inlineIssues: parsed.inlineIssues || [],
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

// Single-flight guard for auto-verifies. Prevents the second of two
// back-to-back Claude responses from interrupting an in-flight verify.
// The user explicitly chose skip-over-queue behaviour for option (b).
let autoVerifyInFlight = false;

// URL patterns for every AI assistant host the extension supports. Kept in
// sync with manifest.json content_scripts.matches and HOST_ADAPTERS in
// content.js — adding a new assistant means appending here too.
const AI_TAB_URL_PATTERNS = [
  'https://claude.ai/*',
  'https://chatgpt.com/*',
  'https://chat.openai.com/*',
];

// Find the most recently focused AI assistant tab (Claude or ChatGPT) and
// ask its content script to apply (or clear) inline highlights for this
// verdict. Best-effort: if no supported tab is open, or the tab hasn't
// loaded the content script yet, silently no-op. The side panel remains
// the canonical surface.
async function pushHighlightsToAITab(verdict, responseText) {
  if (!verdict) return;
  const tabs = await queryTabs({ url: AI_TAB_URL_PATTERNS });
  if (!tabs.length) return;
  // Prefer the active tab if there is one, else the most recently used.
  const sorted = tabs.slice().sort((a, b) => {
    if (a.active && !b.active) return -1;
    if (!a.active && b.active) return 1;
    return (b.lastAccessed || 0) - (a.lastAccessed || 0);
  });
  const tab = sorted[0];
  if (!tab?.id) return;
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(
      tab.id,
      {
        type: 'APPLY_HIGHLIGHTS',
        verdict,
        responseText: (responseText || '').toString(),
      },
      () => {
        // chrome.runtime.lastError is expected when no listener is on the
        // tab; we don't surface it.
        void chrome.runtime.lastError;
        resolve();
      },
    );
  });
}

async function handleVerify(payload) {
  const settings = await getSettings();
  if (payload?.auto) {
    // Auto-verify always uses a hidden, pinned Perplexity tab so the
    // user's focus stays on Claude. This overrides the saved webVisible
    // setting for this one call only.
    settings.webVisible = false;
  }
  await updateStats({ lastStatus: 'checking', lastError: null });

  const rawText = (payload?.text || '').toString();
  if (!rawText.trim()) {
    const err = 'No assistant response text found to verify. Open Claude or ChatGPT and wait for an answer first.';
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
      if (settings.inlineHighlights) {
        pushHighlightsToAITab(cached.verdict, responseText).catch(() => {});
      }
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
    if (settings.inlineHighlights) {
      pushHighlightsToAITab(result.verdict, responseText).catch(() => {});
    }
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
          if (typeof msg.autoVerify === 'boolean') {
            patch[STORAGE_KEYS.autoVerify] = msg.autoVerify;
          }
          if (typeof msg.inlineHighlights === 'boolean') {
            patch[STORAGE_KEYS.inlineHighlights] = msg.inlineHighlights;
          }
          await setSync(patch);
          sendResponse({ ok: true });
          return;
        }
        case 'CLAUDE_RESPONSE_COMPLETE': {
          // Fired by the Claude content script when an assistant response has
          // finished streaming. Run a hidden auto-verify only if the setting is
          // on. Skip if another verify is already in flight.
          const enabled = await loadAutoVerifyFlag();
          if (!enabled) {
            sendResponse({ ok: true, skipped: 'auto-verify-disabled' });
            return;
          }
          if (autoVerifyInFlight) {
            sendResponse({ ok: true, skipped: 'verify-in-flight' });
            return;
          }
          autoVerifyInFlight = true;
          try {
            const out = await handleVerify({
              text: (msg.text || '').toString(),
              auto: true,
            });
            sendResponse(out);
          } finally {
            autoVerifyInFlight = false;
          }
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
          // Identify the Perplexity tab BEFORE clearing the cached id
          // so we can ask it to start a fresh thread visibly. Falls
          // back to any open perplexity.ai tab if the cached id is
          // stale or missing.
          const session = await getSession([SESSION_KEYS.webThreadTabId]);
          let targetTabId = session[SESSION_KEYS.webThreadTabId];
          if (!targetTabId || !(await isTabAlive(targetTabId))) {
            const existing = await queryTabs({ url: 'https://www.perplexity.ai/*' });
            targetTabId = existing[0]?.id || null;
          }
          await resetPerplexityThread();
          await clearDedupCache();
          let newThreadResult = null;
          if (targetTabId) {
            newThreadResult = await sendToTab(targetTabId, {
              type: 'PERPLEXITY_NEW_THREAD',
            });
          }
          sendResponse({
            ok: true,
            newThread: newThreadResult || { ok: false, error: 'No live Perplexity tab.' },
          });
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
