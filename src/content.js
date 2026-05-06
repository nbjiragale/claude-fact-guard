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
//
// The original PRD list was too narrow: factual answers about people in
// office, biographies, or geography rarely contain "in 20XX" / "version X" /
// "studies show". The expanded list below also catches incumbency, titles,
// biographical events, geo/civic facts, and authorship.
//
// A separate proper-noun heuristic (countProperNounPhrases) catches the
// long tail of factual responses that don't match any specific pattern.
// ---------------------------------------------------------------------------

const FACTUAL_SIGNAL_PATTERNS = [
  // --- Original PRD signals ---
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

  // --- Recency / incumbency ---
  /\b(?:current(?:ly)?|incumbent|present(?:ly)?|sitting)\b/i,
  /\b(?:as\s+of|since|until)\s+\d/i,

  // --- Titles + offices (people in named roles) ---
  /\b(?:president|vice\s+president|prime\s+minister|chief\s+minister|cm|pm|ceo|cto|cfo|coo|founder|co-founder|director|chairman|chairperson|secretary|governor|mayor|king|queen|emperor|empress|sultan|prince|princess|pope|sheikh|chancellor|premier|speaker|justice|judge|ambassador|senator|congressman|congresswoman|representative|minister)\b/i,

  // --- Biographical events ---
  /\b(?:born|died|founded|co-founded|established|launched|released|announced|published|created|invented|discovered|patented|elected|appointed|sworn\s+in|inaugurated|crowned|resigned|retired|deceased|passed\s+away)\b/i,

  // --- Geographic / civic facts ---
  /\b(?:capital|currency|population|official\s+language|national\s+anthem|national\s+sport|located\s+in|situated\s+in|borders|coastline|area\s+of)\b/i,
  /\b(?:country|continent|state|province|district|city|town|village|river|mountain|ocean|sea|lake)\s+of\b/i,

  // --- Authorship / attribution ---
  /\b(?:written|authored|directed|produced|composed|painted|sculpted|designed|engineered|developed|coded|architected|invented|discovered)\s+by\b/i,

  // --- Numeric / quantitative ---
  /\b(?:19|20)\d{2}\b/,                        // any 4-digit year (broader)
  /\b\d{1,3}(?:,\d{3})+\b/,                    // big numbers like "1,234,567"
  /\b\d+(?:\.\d+)?\s*(?:million|billion|trillion|thousand|crore|lakh)\b/i,
  /\b(?:approximately|roughly|about|around|nearly|over|more\s+than|less\s+than)\s+\d/i,

  // --- Dates / timeline ---
  /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+\d{4}\b/i,
  /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/i,
];

// Proper noun phrase heuristic: count distinct sequences of two or more
// Capitalized words. Three or more such phrases in a response strongly
// implies it is asserting facts about real-world entities (people, places,
// products), even when none of the explicit signals above match.
const PROPER_NOUN_PHRASE_RE = /\b[A-Z][a-z'’]+(?:\s+[A-Z][a-z'’]+){1,4}\b/g;
const MIN_PROPER_NOUN_PHRASES = 3;

// Stop-words that look like proper nouns at the start of a sentence — we
// strip these from the count so a response that just starts every sentence
// with "The" doesn't false-positive.
const SENTENCE_START_NOISE = new Set([
  'The', 'This', 'That', 'These', 'Those', 'A', 'An', 'It', 'They', 'You',
  'We', 'I', 'He', 'She', 'In', 'On', 'At', 'For', 'But', 'And', 'Or',
  'However', 'Therefore', 'Thus', 'Hence', 'So', 'Because', 'Since',
  'When', 'Where', 'What', 'Who', 'Why', 'How', 'If', 'Although', 'While',
  'Yes', 'No', 'Note', 'Important', 'Key', 'Here', 'There',
]);

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
  // Returns either { passed: true, reason: '<signal>' } or { passed: false }.
  // Reason is exposed in debug logs so the user can see WHY a message was
  // routed to Gemini (or skipped).
  for (const re of FACTUAL_SIGNAL_PATTERNS) {
    const m = text.match(re);
    if (m) return { passed: true, reason: `regex ${re.source} matched ${JSON.stringify(m[0])}` };
  }
  const propNouns = countProperNounPhrases(text);
  if (propNouns >= MIN_PROPER_NOUN_PHRASES) {
    return { passed: true, reason: `${propNouns} distinct proper-noun phrases` };
  }
  return { passed: false, reason: `0 signals, ${propNouns} proper-noun phrases (<${MIN_PROPER_NOUN_PHRASES})` };
}

function countProperNounPhrases(text) {
  // Match multi-word capitalized phrases, then drop matches that are purely
  // a sentence-starting stop word followed by another (e.g. "The Cat" can
  // still be a proper noun phrase, but we filter pairs where the FIRST word
  // is a stop word AND the phrase appears right after a sentence boundary).
  const matches = text.match(PROPER_NOUN_PHRASE_RE);
  if (!matches) return 0;
  const distinct = new Set();
  for (const m of matches) {
    const firstWord = m.split(/\s+/, 1)[0];
    if (SENTENCE_START_NOISE.has(firstWord)) {
      // Trim the leading stop word and re-check that the remainder is still
      // multi-word.
      const rest = m.slice(firstWord.length).trim();
      if (!/\s/.test(rest)) continue;
      distinct.add(rest);
    } else {
      distinct.add(m);
    }
  }
  return distinct.size;
}

// ---------------------------------------------------------------------------
// Selector health check (PRD §DOM Selector Strategy)
// ---------------------------------------------------------------------------

function selectorHealthCheck() {
  // Only the composer is guaranteed to be in the DOM at page load. Assistant
  // messages don't exist until Claude responds, and the send button only
  // mounts once text is in the composer. Surface a real warning only for
  // missing composer; debug-log the others so devs can still see them with
  // `localStorage.setItem('cfg:debug','1')`.
  const composer = querySelectorWithFallback(SELECTORS.composerInput);
  if (!composer) {
    warn(
      'Selector health check: composer input not found. ' +
        'Claude DOM may have changed; correction injection will fail.',
    );
  }
  if (!querySelectorWithFallback(SELECTORS.assistantMessage)) {
    log('Health check: no assistant message on page yet (expected on a fresh chat).');
  }
  if (!querySelectorWithFallback(SELECTORS.sendButton)) {
    log('Health check: send button not yet in DOM (expected when composer is empty).');
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

  const filterResult = passesPreFilter(rawText);
  if (!filterResult.passed) {
    log('Pre-filter skipped:', filterResult.reason);
    notifyPopup({ status: 'skipped' });
    return;
  }
  log('Pre-filter passed:', filterResult.reason);

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
