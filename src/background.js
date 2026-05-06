// Claude Fact Guard — background service worker (MV3)
//
// Receives VERIFY messages from the content script, calls Gemini 2.0 Flash
// with Google Search Grounding, parses the structured JSON verdict, and
// returns it. Also tracks per-session counters and the last verdict so the
// popup can render live status (PRD FR-5.3, FR-5.4).

const GEMINI_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

const MAX_RESPONSE_CHARS = 3000;

const STORAGE_KEYS = {
  apiKey: 'geminiKey',
  enabled: 'enabled',
};

const SESSION_DEFAULTS = {
  verifications: 0,
  corrections: 0,
  skipped: 0,
  errors: 0,
  lastStatus: 'idle',
  lastError: null,
  updatedAt: 0,
};

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function getSyncStorage(keys) {
  return new Promise((resolve) => {
    chrome.storage.sync.get(keys, (result) => resolve(result || {}));
  });
}

function getSessionStorage(keys) {
  return new Promise((resolve) => {
    chrome.storage.session.get(keys, (result) => resolve(result || {}));
  });
}

function setSessionStorage(values) {
  return new Promise((resolve) => {
    chrome.storage.session.set(values, () => resolve());
  });
}

async function getStats() {
  const data = await getSessionStorage('stats');
  return { ...SESSION_DEFAULTS, ...(data.stats || {}) };
}

async function updateStats(patch) {
  const current = await getStats();
  const next = { ...current, ...patch, updatedAt: Date.now() };
  await setSessionStorage({ stats: next });
  return next;
}

async function bumpStats(field) {
  const current = await getStats();
  return updateStats({ [field]: (current[field] || 0) + 1 });
}

// ---------------------------------------------------------------------------
// Prompt construction (PRD §Gemini API Request Format)
// ---------------------------------------------------------------------------

function buildVerificationPrompt(responseText, truncated) {
  const truncationNote = truncated
    ? '\n\n(Note: the response was truncated to the first 3000 characters before being sent for verification.)'
    : '';
  return [
    'You are a fact-checker. A user received this AI response:',
    '---',
    responseText,
    '---',
    'Using Google Search, identify any factually inaccurate, outdated, or misleading claims.',
    '',
    'Respond ONLY with a single JSON object — no Markdown, no code fences, no commentary — matching this schema exactly:',
    '{',
    '  "accurate": boolean,',
    '  "issues": string[],',
    '  "correctionPrompt": string',
    '}',
    '',
    'Rules:',
    '- If the response is fully accurate, set "accurate" to true, "issues" to [], and "correctionPrompt" to "".',
    '- If you find inaccuracies, set "accurate" to false, list each one in "issues" as a short specific bullet, and provide a "correctionPrompt" the user can paste back to the original AI.',
    '- The "correctionPrompt" must follow this exact template, filling in the bullet list:',
    '    "I need to correct something in your previous response.\\nGemini with Google Search found the following issues:\\n- <issue 1>\\n- <issue 2>\\nPlease correct only those points and keep the rest of the explanation unchanged."',
    '- Do not flag opinions, stylistic choices, or purely conceptual explanations.',
    '- Be conservative: only flag claims you can verify as wrong with Search.',
    truncationNote,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Gemini call (PRD FR-3)
// ---------------------------------------------------------------------------

function extractJsonFromGeminiResponse(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;
  const text = parts
    .map((p) => (typeof p?.text === 'string' ? p.text : ''))
    .join('')
    .trim();
  if (!text) return null;

  // Models occasionally wrap JSON in ``` fences despite the prompt; strip them.
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  // Fallback: locate the first {...} block if any leading prose slipped in.
  let candidate = cleaned;
  if (!candidate.startsWith('{')) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    candidate = candidate.slice(start, end + 1);
  }

  try {
    return JSON.parse(candidate);
  } catch (_err) {
    return null;
  }
}

function normalizeVerdict(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const accurate = typeof parsed.accurate === 'boolean' ? parsed.accurate : null;
  if (accurate === null) return null;
  const issues = Array.isArray(parsed.issues)
    ? parsed.issues.filter((s) => typeof s === 'string' && s.trim().length > 0)
    : [];
  const correctionPrompt =
    typeof parsed.correctionPrompt === 'string' ? parsed.correctionPrompt : '';
  return {
    accurate,
    issues,
    correctionPrompt: accurate ? '' : correctionPrompt.trim(),
  };
}

async function callGemini(apiKey, responseText, truncated) {
  const body = {
    contents: [
      {
        parts: [{ text: buildVerificationPrompt(responseText, truncated) }],
      },
    ],
    tools: [{ google_search: {} }],
  };

  const url = `${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Gemini API ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const parsed = extractJsonFromGeminiResponse(data);
  const verdict = normalizeVerdict(parsed);
  if (!verdict) throw new Error('Gemini returned malformed JSON');
  return verdict;
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

async function handleVerify(message) {
  const settings = await getSyncStorage([STORAGE_KEYS.apiKey, STORAGE_KEYS.enabled]);
  const enabled = settings[STORAGE_KEYS.enabled] !== false; // default ON
  const apiKey = settings[STORAGE_KEYS.apiKey];

  if (!enabled) {
    return { ok: false, error: 'disabled', accurate: true, correctionPrompt: '' };
  }
  if (!apiKey) {
    await updateStats({ lastStatus: 'no-key', lastError: 'API key missing' });
    return { ok: false, error: 'no-key', accurate: true, correctionPrompt: '' };
  }

  const text = (message.text || '').slice(0, MAX_RESPONSE_CHARS);
  const truncated = Boolean(message.truncated);

  try {
    const verdict = await callGemini(apiKey, text, truncated);
    await bumpStats('verifications');
    if (!verdict.accurate && verdict.correctionPrompt) {
      await bumpStats('corrections');
      await updateStats({ lastStatus: 'corrected', lastError: null });
    } else {
      await updateStats({ lastStatus: 'accurate', lastError: null });
    }
    return { ok: true, ...verdict };
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    // PRD FR-3.4: silently fail on the page side; we still log here.
    // eslint-disable-next-line no-console
    console.warn('[ClaudeFactGuard:bg] verification failed', msg);
    await bumpStats('errors');
    await updateStats({ lastStatus: 'error', lastError: msg });
    return { ok: false, error: msg, accurate: true, correctionPrompt: '' };
  }
}

async function handleStatus(message) {
  const status = message?.payload?.status;
  if (!status) return;
  if (status === 'skipped') {
    await bumpStats('skipped');
    await updateStats({ lastStatus: 'skipped', lastError: null });
  } else if (status === 'checking') {
    await updateStats({ lastStatus: 'checking', lastError: null });
  } else if (status === 'busy') {
    await updateStats({ lastStatus: 'busy', lastError: null });
  } else if (status === 'error') {
    await bumpStats('errors');
    await updateStats({
      lastStatus: 'error',
      lastError: message?.payload?.error || 'unknown error',
    });
  } else if (status === 'accurate' || status === 'corrected') {
    await updateStats({ lastStatus: status, lastError: null });
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  if (message.type === 'VERIFY') {
    handleVerify(message).then(sendResponse);
    return true; // keep the channel open for async sendResponse
  }

  if (message.type === 'STATUS') {
    handleStatus(message).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === 'GET_STATS') {
    getStats().then((stats) => sendResponse({ ok: true, stats }));
    return true;
  }

  if (message.type === 'RESET_STATS') {
    setSessionStorage({ stats: { ...SESSION_DEFAULTS, updatedAt: Date.now() } }).then(
      () => sendResponse({ ok: true }),
    );
    return true;
  }

  return false;
});

// Initialize defaults on install so the popup has something coherent to show.
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await getSyncStorage([STORAGE_KEYS.enabled]);
  if (typeof existing[STORAGE_KEYS.enabled] !== 'boolean') {
    chrome.storage.sync.set({ [STORAGE_KEYS.enabled]: true });
  }
  await setSessionStorage({ stats: { ...SESSION_DEFAULTS, updatedAt: Date.now() } });
});
