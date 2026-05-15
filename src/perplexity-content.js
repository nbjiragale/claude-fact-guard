// Claude Fact Guard — Perplexity content script
//
// Lives on perplexity.ai. The extension uses your logged-in Perplexity
// session as a free fact-checker (no API cost) by driving the web UI.
//
// Message API (from background service worker):
//
//   - PERPLEXITY_PING:            { ok, where, url, ready, loggedIn, hasInput }
//   - PERPLEXITY_NEW_THREAD:      navigate to a fresh "Home" thread
//   - PERPLEXITY_ASK { prompt }:  type prompt, send, wait for streaming to
//                                 finish, return { ok, answer, citations }
//
// All selectors are declared at the top so they can be patched in one place
// when Perplexity's UI changes.

const SELECTORS = {
  // The main "Ask anything" composer on the Home / Thread pages.
  // As of late-2024 Perplexity ships a Lexical contenteditable on Home and a
  // separate one for follow-ups; both are caught here.
  composer: {
    primary: [
      'textarea[placeholder*="Ask" i]',
      'textarea[placeholder*="follow-up" i]',
      'textarea[placeholder*="Ask anything" i]',
      'div[contenteditable="true"][role="textbox"]',
      'div[data-lexical-editor="true"]',
      'div[contenteditable="true"][aria-label*="Ask" i]',
      'div[contenteditable="true"][aria-label*="follow-up" i]',
    ].join(', '),
    fallback: [
      'textarea',
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"]',
      'div[contenteditable="true"]',
    ].join(', '),
  },
  // Send / submit button (paper-plane / arrow icon).
  sendButton: {
    primary: [
      'button[aria-label*="Submit" i]',
      'button[aria-label*="Send" i]',
      'button[data-testid*="submit" i]',
      'button[data-testid*="send" i]',
    ].join(', '),
    fallback: 'button[type="submit"]',
  },
  // The container for the latest assistant answer block.
  // Perplexity tends to render answers as prose paragraphs grouped under
  // a unique wrapper per turn.
  answerBlock: {
    primary:
      'div[id^="markdown-content"], div[class*="prose"], article[class*="prose"]',
    fallback:
      '[data-testid="answer"], main article, main div[class*="answer" i]',
  },
  // The "Stop generating" / "Stop" button that appears only while streaming.
  stopButton: {
    primary:
      'button[aria-label*="Stop" i], button[data-testid*="stop" i]',
    fallback: 'button[aria-label*="stop generating" i]',
  },
  // Source citation links appearing under or alongside the answer.
  citationLink: {
    primary: 'a[href^="http"][class*="citation" i], a[data-testid*="citation" i]',
    fallback: 'a[href^="http"][rel*="noreferrer" i]',
  },
  // The login / "Sign in" gate. Presence => the user is logged out.
  // NOTE: legacy fallback used jQuery-style `:contains()` which is not a
  // valid CSS selector; querySelector throws on it. We catch the throw but
  // it added noise to the console — use a CSS-valid fallback instead.
  loginGate: {
    primary:
      'button[data-testid*="login" i], a[href*="/login" i], a[href*="/sign-in" i]',
    fallback: 'a[href*="login" i], a[href*="signin" i]',
  },
};

// Detect Cloudflare's "Verifying you are human" challenge interstitial. When
// this is on screen, the page DOM never renders the real composer; reporting
// hasInput=false until CF clears is correct, but we want to give the user a
// helpful diagnostic.
function isCloudflareChallenge() {
  const url = (location.href || '').toLowerCase();
  if (url.includes('challenge') || url.includes('cdn-cgi/challenge')) return true;
  const title = (document.title || '').toLowerCase();
  if (title.includes('just a moment') || title.includes('attention required')) return true;
  const cfBox = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
  if (cfBox) return true;
  const body = document.body && document.body.innerText ? document.body.innerText.toLowerCase() : '';
  return body.includes('verifying you are human') || body.includes('performing security verification');
}

const DEFAULTS = {
  // Stop polling for an answer after this much total time.
  WAIT_FOR_ANSWER_MAX_MS: 90000,
  // Once an answer node exists and isn't changing, how long of "quiet"
  // (no DOM mutations) we treat as "streaming done".
  QUIET_MS: 1500,
  // Poll cadence for waiting on the send button to clear / answer to start.
  POLL_INTERVAL_MS: 200,
  // After typing the prompt, wait this long before clicking send.
  SEND_DELAY_MS: 250,
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function log(...args) {
  try {
    if (localStorage.getItem('cfg:debug') === '1') {
      // eslint-disable-next-line no-console
      console.log('[ClaudeFactGuard:perplexity]', ...args);
    }
  } catch (_) {
    /* ignore */
  }
}

function warn(...args) {
  // eslint-disable-next-line no-console
  console.warn('[ClaudeFactGuard:perplexity]', ...args);
}

function querySelectorWithFallback({ primary, fallback }, root = document) {
  try {
    const a = root.querySelector(primary);
    if (a) return a;
  } catch (_) {
    /* invalid selector; try fallback */
  }
  try {
    return root.querySelector(fallback);
  } catch (_) {
    return null;
  }
}

function querySelectorAllWithFallback({ primary, fallback }, root = document) {
  try {
    const a = root.querySelectorAll(primary);
    if (a.length > 0) return Array.from(a);
  } catch (_) {
    /* invalid; try fallback */
  }
  try {
    return Array.from(root.querySelectorAll(fallback));
  } catch (_) {
    return [];
  }
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// ---------------------------------------------------------------------------
// State / login detection
// ---------------------------------------------------------------------------

function isLoggedOut() {
  // Heuristic: prominent "Sign in" / "Login" buttons mean we're gated.
  const gate = querySelectorWithFallback(SELECTORS.loginGate);
  if (!gate) return false;
  const text = (gate.innerText || gate.textContent || '').toLowerCase();
  return /sign in|log in|login/.test(text);
}

function getComposer() {
  return querySelectorWithFallback(SELECTORS.composer);
}

function getSendButton() {
  return querySelectorWithFallback(SELECTORS.sendButton);
}

function getAllAnswerBlocks() {
  return querySelectorAllWithFallback(SELECTORS.answerBlock);
}

// ---------------------------------------------------------------------------
// Composer injection
// ---------------------------------------------------------------------------

function setComposerText(composer, text) {
  composer.focus();
  // Branch on element type.
  if (composer.tagName === 'TEXTAREA' || composer.tagName === 'INPUT') {
    // React-controlled inputs: use the native setter so React picks it up.
    const proto =
      composer.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) {
      setter.call(composer, text);
    } else {
      composer.value = text;
    }
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    composer.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    // Contenteditable composer (ProseMirror-style). Same strategy as the
    // Claude content script: replace nodes + fire input event.
    try {
      composer.dispatchEvent(
        new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertReplacementText',
          data: text,
        }),
      );
    } catch (_) {
      /* not all browsers accept this inputType */
    }
    while (composer.firstChild) composer.removeChild(composer.firstChild);
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      composer.appendChild(document.createTextNode(line));
      if (i < lines.length - 1) {
        composer.appendChild(document.createElement('br'));
      }
    });
    composer.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: text,
      }),
    );
    composer.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

async function waitFor(predicate, { intervalMs, timeoutMs }) {
  const startedAt = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const out = predicate();
      if (out) return out;
    } catch (_) {
      /* ignore predicate errors */
    }
    if (Date.now() - startedAt > timeoutMs) return null;
    await sleep(intervalMs);
  }
}

async function clickSend(composer) {
  // First wait for the send button to be enabled (it becomes enabled when
  // the composer has non-empty text).
  const sendBtn = await waitFor(
    () => {
      const b = getSendButton();
      if (!b) return null;
      if (b.disabled) return null;
      if (b.getAttribute('aria-disabled') === 'true') return null;
      return b;
    },
    { intervalMs: DEFAULTS.POLL_INTERVAL_MS, timeoutMs: 5000 },
  );
  if (sendBtn) {
    sendBtn.click();
    log('Perplexity send button clicked');
    return true;
  }
  // Fallback: synthesize Enter on the composer.
  try {
    composer.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
      }),
    );
    composer.dispatchEvent(
      new KeyboardEvent('keyup', {
        bubbles: true,
        cancelable: true,
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
      }),
    );
    log('Perplexity Enter key dispatched as send fallback');
    return true;
  } catch (_) {
    /* ignore */
  }
  return false;
}

// ---------------------------------------------------------------------------
// Reading the latest answer
// ---------------------------------------------------------------------------

function snapshotAnswerCount() {
  return getAllAnswerBlocks().length;
}

function readLatestAnswer() {
  const blocks = getAllAnswerBlocks();
  if (!blocks.length) return null;
  const last = blocks[blocks.length - 1];
  const text = (last.innerText || last.textContent || '').trim();
  if (!text) return null;
  // Citations: gather absolute URLs that appear inside the answer container
  // or in the same parent section.
  const scope = last.closest('article, section, main') || last.parentElement || last;
  const linkEls = querySelectorAllWithFallback(SELECTORS.citationLink, scope);
  const seen = new Set();
  const citations = [];
  for (const a of linkEls) {
    const href = a.getAttribute('href');
    if (!href || !/^https?:/i.test(href)) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    citations.push(href);
    if (citations.length >= 20) break;
  }
  return { answer: text, citations };
}

/**
 * Wait for Perplexity to finish streaming the answer.
 *
 * Strategy:
 *   1. Wait until the number of answer blocks increased past `baselineCount`
 *      OR an existing block grew in length (indicating a new answer started).
 *   2. Once "the answer block is present", attach a MutationObserver to it
 *      and consider streaming done after QUIET_MS of no mutations.
 *   3. As a belt-and-suspenders check, also treat absence of the "Stop"
 *      button for QUIET_MS as "done".
 *
 * Times out after WAIT_FOR_ANSWER_MAX_MS.
 */
async function waitForAnswerComplete(baselineCount) {
  const start = Date.now();

  const answerBlock = await waitFor(
    () => {
      const blocks = getAllAnswerBlocks();
      if (blocks.length > baselineCount) return blocks[blocks.length - 1];
      return null;
    },
    {
      intervalMs: DEFAULTS.POLL_INTERVAL_MS,
      timeoutMs: DEFAULTS.WAIT_FOR_ANSWER_MAX_MS,
    },
  );
  if (!answerBlock) {
    return { ok: false, error: 'Perplexity never produced a new answer block (timed out).' };
  }

  let lastMutationAt = Date.now();
  const observer = new MutationObserver(() => {
    lastMutationAt = Date.now();
  });
  observer.observe(answerBlock, {
    subtree: true,
    childList: true,
    characterData: true,
  });

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const stopBtn = querySelectorWithFallback(SELECTORS.stopButton);
      const stopVisible = stopBtn && stopBtn.offsetParent !== null;
      const quietFor = Date.now() - lastMutationAt;
      if (!stopVisible && quietFor >= DEFAULTS.QUIET_MS) {
        const out = readLatestAnswer();
        if (!out) {
          return { ok: false, error: 'Answer block went quiet but had no readable text.' };
        }
        return { ok: true, ...out };
      }
      if (Date.now() - start > DEFAULTS.WAIT_FOR_ANSWER_MAX_MS) {
        const out = readLatestAnswer();
        if (out) {
          // Return what we have so the user isn't blocked.
          return { ok: true, partial: true, ...out };
        }
        return { ok: false, error: 'Perplexity took too long to finish (timed out).' };
      }
      await sleep(DEFAULTS.POLL_INTERVAL_MS);
    }
  } finally {
    observer.disconnect();
  }
}

// ---------------------------------------------------------------------------
// Ask flow
// ---------------------------------------------------------------------------

async function askPerplexity(prompt) {
  if (isLoggedOut()) {
    return {
      ok: false,
      loggedOut: true,
      error:
        'You are signed out of Perplexity. Click "Open Perplexity tab" in the side panel and sign in, then retry.',
    };
  }
  const composer = getComposer();
  if (!composer) {
    return {
      ok: false,
      error:
        'Could not find the Perplexity input box. The page may still be loading — wait a moment and retry.',
    };
  }
  const baselineCount = snapshotAnswerCount();
  setComposerText(composer, prompt);
  await sleep(DEFAULTS.SEND_DELAY_MS);
  const sent = await clickSend(composer);
  if (!sent) {
    return {
      ok: false,
      error: 'Could not click Perplexity send button or dispatch Enter key.',
    };
  }
  const out = await waitForAnswerComplete(baselineCount);
  return out;
}

// ---------------------------------------------------------------------------
// Message router (background <-> content script)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case 'PERPLEXITY_PING': {
          const composer = getComposer();
          const cf = isCloudflareChallenge();
          sendResponse({
            ok: true,
            where: 'perplexity-content',
            url: location.href,
            title: document.title || '',
            cfChallenge: cf,
            loggedIn: cf ? null : !isLoggedOut(),
            hasInput: !!composer,
            composerTag: composer ? composer.tagName.toLowerCase() : null,
          });
          return;
        }
        case 'PERPLEXITY_NEW_THREAD': {
          // Navigate to a fresh thread. The simplest way is to click the
          // "New thread" / "Home" entry, but we can also just go to "/" or
          // "/?fresh=1".
          try {
            location.assign('/');
            sendResponse({ ok: true });
          } catch (err) {
            sendResponse({ ok: false, error: err?.message || 'Failed to start new thread.' });
          }
          return;
        }
        case 'PERPLEXITY_ASK': {
          const prompt = (msg.prompt || '').toString();
          if (!prompt.trim()) {
            sendResponse({ ok: false, error: 'Empty prompt.' });
            return;
          }
          const out = await askPerplexity(prompt);
          sendResponse(out);
          return;
        }
        default:
          sendResponse({ ok: false, error: `Unknown message type: ${msg?.type}` });
      }
    } catch (err) {
      warn('handler failed', err);
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();
  return true; // keep channel open for async sendResponse
});

log('Claude Fact Guard Perplexity content script attached');
