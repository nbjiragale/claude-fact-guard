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
  // Assistant messages: today's Claude wraps responses in a div with the
  // `standard-markdown` class. The legacy data-testid is kept as a fallback
  // so the extension still works on older builds.
  assistantMessage: {
    primary: '.standard-markdown',
    fallback: '[data-testid="assistant-message"], .font-claude-message',
  },
  // Composer input: `data-testid="chat-input"` lives directly on the
  // contenteditable. The role-based selector is the broad fallback.
  composerInput: {
    primary: '[data-testid="chat-input"]',
    fallback: '[contenteditable="true"][role="textbox"]',
  },
  // Send button: only materializes after text is in the composer. Multiple
  // selectors are tried in order; an additional heuristic (`findSendButton`)
  // walks up from the composer to find a near-by submit-style button.
  sendButton: {
    primary: '[data-testid="send-button"]',
    fallback:
      'button[aria-label="Send message" i], button[aria-label="Send" i], button[aria-label*="Send message" i]:not([aria-label*="voice" i]), button[type="submit"]',
  },
};

// Tunable constants (PRD FR-1.3, FR-3.3, FR-4.4)
const DEBOUNCE_MS = 1200;
const INJECT_DELAY_MS = 300;
const SEND_BUTTON_POLL_INTERVAL_MS = 150;
const SEND_BUTTON_POLL_MAX_MS = 3000;
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

  // Set text and notify the editor framework (PRD FR-4.3). Today's Claude
  // composer is a Tiptap/ProseMirror contenteditable, which listens for
  // `beforeinput` and `input` events to update its document model.
  composer.focus();
  setComposerText(composer, correctionPrompt);

  // Poll for the send button: it's typically not in the DOM until text is
  // present, and may take a moment to mount after the input event.
  const startedAt = Date.now();
  const initialDelay = INJECT_DELAY_MS;
  setTimeout(() => pollAndClickSend(composer, startedAt), initialDelay);

  return true;
}

function setComposerText(composer, text) {
  // Strategy 1: dispatch a beforeinput with `insertReplacementText` and the
  // full string as `data`. This is what ProseMirror reacts to natively.
  try {
    const beforeInput = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertReplacementText',
      data: text,
      // dataTransfer is read-only via property; provide via constructor when
      // supported by the runtime.
    });
    const accepted = composer.dispatchEvent(beforeInput);
    if (accepted) {
      // Some editors handle the event natively and update their model. If
      // they didn't (event not preventDefault'd by the editor), fall through
      // to the textContent-set path below.
    }
  } catch (_) {
    /* InputEvent might reject the inputType in some browsers; ignore. */
  }

  // Strategy 2: directly set the editor text and dispatch an input event so
  // React/Tiptap's synthetic event system picks up the change. Clearing the
  // node first avoids leaving stray ProseMirror placeholder nodes.
  while (composer.firstChild) composer.removeChild(composer.firstChild);
  composer.appendChild(document.createTextNode(text));

  const inputEvent = new InputEvent('input', {
    bubbles: true,
    cancelable: true,
    inputType: 'insertText',
    data: text,
  });
  composer.dispatchEvent(inputEvent);

  // Generic safety-net change event for any non-React listeners.
  composer.dispatchEvent(new Event('change', { bubbles: true }));
}

function pollAndClickSend(composer, startedAt) {
  const sendBtn = findSendButton(composer);
  if (sendBtn && !sendBtn.disabled && sendBtn.getAttribute('aria-disabled') !== 'true') {
    sendBtn.click();
    log('Correction submitted');
    return;
  }

  if (Date.now() - startedAt >= SEND_BUTTON_POLL_MAX_MS) {
    warn(
      'Send button never became clickable after injection (waited',
      SEND_BUTTON_POLL_MAX_MS,
      'ms). Correction text is in the composer but was not submitted.',
    );
    return;
  }

  setTimeout(
    () => pollAndClickSend(composer, startedAt),
    SEND_BUTTON_POLL_INTERVAL_MS,
  );
}

function findSendButton(composer) {
  // 1. Try declared selectors.
  const declared = querySelectorWithFallback(SELECTORS.sendButton);
  if (declared) return declared;

  // 2. Walk up from the composer and find a near-by submit-style button.
  let scope = composer.closest('form') || composer.parentElement;
  while (scope && scope !== document.body) {
    const candidates = Array.from(scope.querySelectorAll('button')).filter(
      (b) => {
        if (b.disabled) return false;
        if (b.offsetParent === null) return false; // not visible
        const label = (b.getAttribute('aria-label') || '').toLowerCase();
        if (label.includes('send')) return true;
        if (b.type === 'submit') return true;
        return false;
      },
    );
    if (candidates.length > 0) return candidates[candidates.length - 1];
    scope = scope.parentElement;
  }
  return null;
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
