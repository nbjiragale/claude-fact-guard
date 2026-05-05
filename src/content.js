// Claude Fact Guard — content script
//
// Observes Claude's chat DOM, detects fully streamed assistant messages,
// runs a regex pre-filter, asks the background service worker to verify
// the message with Gemini (Search Grounding), and — when the verdict is
// inaccurate — injects a targeted correction prompt back into Claude's
// composer.
//
// All DOM selectors are declared as constants at the top of this file so
// they can be updated in one place when Claude's UI changes.

// ---------------------------------------------------------------------------
// Selector constants (PRD §DOM Selector Strategy)
// ---------------------------------------------------------------------------

const SELECTORS = {
  assistantMessage: {
    primary: '[data-testid="assistant-message"]',
    fallback: '.font-claude-message',
  },
  composerInput: {
    primary: '[data-testid="composer-input"] [contenteditable]',
    fallback: '[contenteditable][role="textbox"]',
  },
  sendButton: {
    primary: '[data-testid="send-button"]',
    fallback: 'button[type="submit"]',
  },
};

// Tunable constants (PRD FR-1.3, FR-3.3, FR-4.4)
const DEBOUNCE_MS = 1200;
const INJECT_DELAY_MS = 300;
const MAX_RESPONSE_CHARS = 3000;

// ---------------------------------------------------------------------------
// Pre-filter regexes (PRD FR-2.2 — factual signal patterns)
// ---------------------------------------------------------------------------

const FACTUAL_SIGNAL_PATTERNS = [
  /\bin\s+(?:19|20)\d{2}\b/i,                  // year reference: "in 2024"
  /\bversion\s+\d+(?:\.\d+)*\b/i,              // version number: "version 3.2"
  /\bv\d+(?:\.\d+){1,3}\b/i,                   // semver-ish: "v3.2.1"
  /\baccording\s+to\b/i,                       // attribution
  /\bas\s+of\b/i,                              // recency signal
  /\b(?:latest|recently\s+released|newly\s+released|just\s+released)\b/i,
  /\b\d{1,3}(?:\.\d+)?\s*%\s+of\b/i,           // statistical claim: "47% of"
  /\bstudies\s+show\b/i,
  /\bresearch(?:ers)?\s+(?:show|found|suggest|confirm)\b/i,
  /\bpublished\s+in\s+(?:19|20)\d{2}\b/i,
];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const seenResponses = new Set();          // dedup hashes (PRD FR-1.4)
const pendingDebounces = new WeakMap();   // element -> timer id
const verifyingElements = new WeakSet();  // elements currently being verified

let composerBusyWarned = false;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function log(...args) {
  // Quiet by default. Toggle via DevTools: localStorage.setItem('cfg:debug','1')
  try {
    if (localStorage.getItem('cfg:debug') === '1') {
      // eslint-disable-next-line no-console
      console.log('[ClaudeFactGuard]', ...args);
    }
  } catch (_) {
    // localStorage may be unavailable in some contexts; ignore.
  }
}

function warn(...args) {
  // eslint-disable-next-line no-console
  console.warn('[ClaudeFactGuard]', ...args);
}

function querySelectorWithFallback({ primary, fallback }, root = document) {
  return root.querySelector(primary) || root.querySelector(fallback);
}

function querySelectorAllWithFallback({ primary, fallback }, root = document) {
  const primaryHits = root.querySelectorAll(primary);
  if (primaryHits.length > 0) return Array.from(primaryHits);
  return Array.from(root.querySelectorAll(fallback));
}

function hashText(text) {
  // Cheap 32-bit FNV-1a — good enough for dedup within a session.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

function passesPreFilter(text) {
  for (const re of FACTUAL_SIGNAL_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Selector health check (PRD §DOM Selector Strategy)
// ---------------------------------------------------------------------------

function selectorHealthCheck() {
  // Only assistant messages are guaranteed to be present after a response.
  // Composer/send button should appear once the chat UI is loaded. We log
  // warnings rather than failing hard so the extension keeps running.
  const checks = [
    ['assistantMessage', SELECTORS.assistantMessage, false],
    ['composerInput', SELECTORS.composerInput, true],
    ['sendButton', SELECTORS.sendButton, true],
  ];
  for (const [name, selector, expectAtLoad] of checks) {
    const el = querySelectorWithFallback(selector);
    if (!el && expectAtLoad) {
      warn(
        `Selector health check: "${name}" did not match. ` +
          'Claude DOM may have changed; injection or detection could fail.',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Detection (PRD FR-1)
// ---------------------------------------------------------------------------

function findAssistantMessageRoot(node) {
  if (!(node instanceof Element)) return null;
  const { primary, fallback } = SELECTORS.assistantMessage;
  return node.closest(primary) || node.closest(fallback);
}

function scheduleVerification(messageEl) {
  if (verifyingElements.has(messageEl)) return;

  const existing = pendingDebounces.get(messageEl);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    pendingDebounces.delete(messageEl);
    handleAssistantMessage(messageEl);
  }, DEBOUNCE_MS);

  pendingDebounces.set(messageEl, timer);
}

async function handleAssistantMessage(messageEl) {
  if (verifyingElements.has(messageEl)) return;
  if (!messageEl.isConnected) return;

  const rawText = (messageEl.innerText || '').trim();
  if (!rawText) return;

  const fingerprint = hashText(rawText);
  if (seenResponses.has(fingerprint)) {
    log('Skipping duplicate response');
    return;
  }
  seenResponses.add(fingerprint);

  if (!passesPreFilter(rawText)) {
    log('Pre-filter skipped (no factual signals)');
    notifyPopup({ status: 'skipped' });
    return;
  }

  const truncated = rawText.length > MAX_RESPONSE_CHARS;
  const responseText = truncated
    ? rawText.slice(0, MAX_RESPONSE_CHARS)
    : rawText;

  verifyingElements.add(messageEl);
  log('Sending to Gemini for verification', { len: responseText.length, truncated });
  notifyPopup({ status: 'checking' });

  try {
    const verdict = await chrome.runtime.sendMessage({
      type: 'VERIFY',
      text: responseText,
      truncated,
    });

    if (!verdict || !verdict.ok) {
      log('Verification failed', verdict && verdict.error);
      notifyPopup({ status: 'error', error: verdict && verdict.error });
      return;
    }

    if (verdict.accurate) {
      log('Verdict: accurate');
      notifyPopup({ status: 'accurate' });
      return;
    }

    if (!verdict.correctionPrompt) {
      log('Inaccurate but no correction prompt provided; skipping injection');
      notifyPopup({ status: 'accurate' });
      return;
    }

    const injected = injectCorrection(verdict.correctionPrompt);
    notifyPopup({ status: injected ? 'corrected' : 'busy' });
  } catch (err) {
    warn('Background messaging failed', err);
    notifyPopup({ status: 'error', error: String(err && err.message) });
  }
}

// ---------------------------------------------------------------------------
// Correction injection (PRD FR-4)
// ---------------------------------------------------------------------------

function injectCorrection(correctionPrompt) {
  const composer = querySelectorWithFallback(SELECTORS.composerInput);
  if (!composer) {
    warn('Cannot inject correction: composer input not found');
    return false;
  }

  const existing = (composer.innerText || '').trim();
  if (existing.length > 0) {
    if (!composerBusyWarned) {
      warn('Composer is non-empty — user is typing; skipping injection');
      composerBusyWarned = true;
    }
    return false;
  }
  composerBusyWarned = false;

  // Set text and notify React's synthetic event system (PRD FR-4.3)
  composer.focus();
  composer.innerText = correctionPrompt;

  const inputEvent = new InputEvent('input', {
    bubbles: true,
    cancelable: true,
    inputType: 'insertText',
    data: correctionPrompt,
  });
  composer.dispatchEvent(inputEvent);

  // Some Claude builds also rely on a native "change"-style event on the
  // contenteditable; dispatch a generic one as a safety net.
  composer.dispatchEvent(new Event('change', { bubbles: true }));

  setTimeout(() => {
    const sendBtn = querySelectorWithFallback(SELECTORS.sendButton);
    if (!sendBtn) {
      warn('Send button not found; correction text was injected but not submitted');
      return;
    }
    if (sendBtn.disabled) {
      warn('Send button is disabled; correction text was injected but not submitted');
      return;
    }
    sendBtn.click();
    log('Correction submitted');
  }, INJECT_DELAY_MS);

  return true;
}

// ---------------------------------------------------------------------------
// Popup status messaging (PRD FR-5.3, FR-5.4)
// ---------------------------------------------------------------------------

function notifyPopup(payload) {
  try {
    chrome.runtime.sendMessage({ type: 'STATUS', payload }).catch(() => {});
  } catch (_) {
    // sendMessage can throw synchronously if there's no receiver; ignore.
  }
}

// ---------------------------------------------------------------------------
// MutationObserver (PRD FR-1.1, FR-1.2)
// ---------------------------------------------------------------------------

function observeAssistantMessages() {
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'childList') {
        for (const added of m.addedNodes) {
          const msgRoot = findAssistantMessageRoot(added);
          if (msgRoot) scheduleVerification(msgRoot);
          // Streaming may also append nodes inside an existing message root.
          if (added instanceof Element) {
            const nested = querySelectorAllWithFallback(
              SELECTORS.assistantMessage,
              added,
            );
            for (const el of nested) scheduleVerification(el);
          }
        }
      }
      if (m.type === 'characterData') {
        const root = findAssistantMessageRoot(m.target.parentNode);
        if (root) scheduleVerification(root);
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  // Also catch any messages already on the page when the script attaches.
  for (const el of querySelectorAllWithFallback(SELECTORS.assistantMessage)) {
    scheduleVerification(el);
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

function bootstrap() {
  selectorHealthCheck();
  observeAssistantMessages();
  log('Claude Fact Guard content script attached');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
} else {
  bootstrap();
}
