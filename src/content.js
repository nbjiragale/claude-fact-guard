// Claude Fact Guard — content script
//
// Lives on claude.ai. Listens for messages from the side panel:
//
//   - GET_LATEST_RESPONSE: returns the text of the latest fully-rendered
//                          assistant message on the page.
//   - INJECT_TEXT { text, send }: writes `text` into the composer; if
//                                 `send` is true, clicks the send button.
//
// This script does NOT auto-fact-check anything. Verification is triggered
// manually from the side panel ("Verify" / "Set Context" buttons).
//
// All Claude DOM selectors are declared at the top of this file so they
// can be patched in one place when Claude's UI changes.

const SELECTORS = {
  assistantMessage: {
    primary: '.standard-markdown',
    fallback: '[data-testid="assistant-message"], .font-claude-message',
  },
  composerInput: {
    primary: '[data-testid="chat-input"]',
    fallback: '[contenteditable="true"][role="textbox"]',
  },
  sendButton: {
    primary: '[data-testid="send-button"]',
    fallback:
      'button[aria-label="Send message" i], button[aria-label="Send" i], button[aria-label*="Send message" i]:not([aria-label*="voice" i]), button[type="submit"]',
  },
};

const INJECT_SEND_DELAY_MS = 300;
const SEND_BUTTON_POLL_INTERVAL_MS = 150;
const SEND_BUTTON_POLL_MAX_MS = 3000;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function log(...args) {
  try {
    if (localStorage.getItem('cfg:debug') === '1') {
      // eslint-disable-next-line no-console
      console.log('[ClaudeFactGuard]', ...args);
    }
  } catch (_) {
    /* ignore */
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

// ---------------------------------------------------------------------------
// Reading the latest assistant message
// ---------------------------------------------------------------------------

function getLatestAssistantMessageText() {
  const messages = querySelectorAllWithFallback(SELECTORS.assistantMessage);
  if (!messages.length) return { ok: false, error: 'No Claude assistant messages found on this page yet.' };
  const last = messages[messages.length - 1];
  const text = (last.innerText || '').trim();
  if (!text) {
    return { ok: false, error: 'Latest assistant message is empty (still streaming?).' };
  }
  return { ok: true, text };
}

// ---------------------------------------------------------------------------
// Composer injection
// ---------------------------------------------------------------------------

function setComposerText(composer, text) {
  composer.focus();

  // Strategy 1: dispatch a beforeinput event for editors (Tiptap/ProseMirror)
  // that listen for native input events.
  try {
    const beforeInput = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertReplacementText',
      data: text,
    });
    composer.dispatchEvent(beforeInput);
  } catch (_) {
    /* some browsers reject this inputType; fall through */
  }

  // Strategy 2: directly set the editor text and dispatch an input event so
  // React/Tiptap's synthetic event system picks up the change.
  while (composer.firstChild) composer.removeChild(composer.firstChild);
  // Preserve user-friendly line breaks by splitting on \n and adding <br>s.
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

function findSendButton(composer) {
  const declared = querySelectorWithFallback(SELECTORS.sendButton);
  if (declared) return declared;

  let scope = composer.closest('form') || composer.parentElement;
  while (scope && scope !== document.body) {
    const candidates = Array.from(scope.querySelectorAll('button')).filter(
      (b) => {
        if (b.disabled) return false;
        if (b.offsetParent === null) return false;
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

function pollAndClickSend(composer, startedAt) {
  const sendBtn = findSendButton(composer);
  const enabled =
    sendBtn &&
    !sendBtn.disabled &&
    sendBtn.getAttribute('aria-disabled') !== 'true';
  if (enabled) {
    sendBtn.click();
    log('Send button clicked');
    return true;
  }
  if (Date.now() - startedAt >= SEND_BUTTON_POLL_MAX_MS) {
    warn(
      'Send button never became clickable after injection. Text is in the composer but was not submitted.',
    );
    return false;
  }
  setTimeout(
    () => pollAndClickSend(composer, startedAt),
    SEND_BUTTON_POLL_INTERVAL_MS,
  );
  return null; // pending
}

function injectText(text, { send }) {
  const composer = querySelectorWithFallback(SELECTORS.composerInput);
  if (!composer) {
    return { ok: false, error: 'Claude composer not found. Is the chat thread open?' };
  }
  setComposerText(composer, text);

  if (!send) return { ok: true, sent: false };

  setTimeout(() => pollAndClickSend(composer, Date.now()), INJECT_SEND_DELAY_MS);
  return { ok: true, sent: true };
}

// ---------------------------------------------------------------------------
// Message router (side panel <-> content script)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  try {
    switch (msg?.type) {
      case 'GET_LATEST_RESPONSE': {
        sendResponse(getLatestAssistantMessageText());
        return; // sync
      }
      case 'INJECT_TEXT': {
        const text = (msg.text || '').toString();
        if (!text.trim()) {
          sendResponse({ ok: false, error: 'No text to inject.' });
          return;
        }
        sendResponse(injectText(text, { send: !!msg.send }));
        return;
      }
      case 'PING': {
        sendResponse({ ok: true, where: 'content', url: location.href });
        return;
      }
      default:
        sendResponse({ ok: false, error: `Unknown message type: ${msg?.type}` });
    }
  } catch (err) {
    sendResponse({ ok: false, error: err?.message || String(err) });
  }
  return true;
});

log('Claude Fact Guard content script attached');

// ---------------------------------------------------------------------------
// Auto-verify observer
//
// When the "Auto-verify Claude responses" setting is on, watch for new
// assistant messages and notify the background once a message has stopped
// streaming. The background applies the dedup cache and runs the same
// Verify flow it would run on a manual click — except the Perplexity tab
// is forced hidden so the user's focus stays on Claude.
//
// Detection strategy: a MutationObserver coalesces DOM activity onto a
// debounced "quiet timer". When the last assistant message has been
// unchanged for AUTO_VERIFY_QUIET_MS we treat streaming as finished and
// send CLAUDE_RESPONSE_COMPLETE exactly once per unique response.
// ---------------------------------------------------------------------------

const AUTO_VERIFY_QUIET_MS = 2500;
const AUTO_VERIFY_MIN_CHARS = 40;
const AUTO_VERIFY_COALESCE_MS = 250;

let autoVerifyEnabled = false;
let autoVerifyCoalesceTimer = null;
let autoVerifyQuietTimer = null;
let autoVerifyLastHash = '';

function fnv1a32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) | 0;
  }
  return ('0000000' + (h >>> 0).toString(16)).slice(-8);
}

function pickupLatestAssistantText() {
  const r = getLatestAssistantMessageText();
  return r.ok ? r.text : null;
}

function evaluateAutoVerify() {
  if (!autoVerifyEnabled) return;
  const text = pickupLatestAssistantText();
  if (!text || text.length < AUTO_VERIFY_MIN_CHARS) return;
  const hash = fnv1a32(text);
  if (hash === autoVerifyLastHash) return;
  if (autoVerifyQuietTimer) clearTimeout(autoVerifyQuietTimer);
  autoVerifyQuietTimer = setTimeout(() => {
    autoVerifyQuietTimer = null;
    const fresh = pickupLatestAssistantText();
    if (!fresh) return;
    const freshHash = fnv1a32(fresh);
    if (freshHash !== hash) {
      // Streaming still going — re-arm via the next mutation.
      return;
    }
    if (freshHash === autoVerifyLastHash) return;
    autoVerifyLastHash = freshHash;
    log('auto-verify firing for hash', freshHash, 'len', fresh.length);
    try {
      chrome.runtime.sendMessage(
        { type: 'CLAUDE_RESPONSE_COMPLETE', text: fresh },
        (resp) => {
          if (chrome.runtime.lastError) {
            warn('auto-verify send failed', chrome.runtime.lastError.message);
          } else {
            log('auto-verify response', resp);
          }
        },
      );
    } catch (err) {
      warn('auto-verify dispatch failed', err);
    }
  }, AUTO_VERIFY_QUIET_MS);
}

function onAutoVerifyMutation() {
  if (!autoVerifyEnabled) return;
  if (autoVerifyCoalesceTimer) return;
  autoVerifyCoalesceTimer = setTimeout(() => {
    autoVerifyCoalesceTimer = null;
    evaluateAutoVerify();
  }, AUTO_VERIFY_COALESCE_MS);
}

try {
  const autoVerifyObserver = new MutationObserver(onAutoVerifyMutation);
  autoVerifyObserver.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
  });
} catch (err) {
  warn('auto-verify observer failed to attach', err);
}

try {
  chrome.storage.sync.get(['autoVerify'], (data) => {
    autoVerifyEnabled = !!(data && data.autoVerify);
    log('auto-verify initial state:', autoVerifyEnabled);
    if (autoVerifyEnabled) evaluateAutoVerify();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes || !('autoVerify' in changes)) return;
    autoVerifyEnabled = !!changes.autoVerify.newValue;
    log('auto-verify toggled:', autoVerifyEnabled);
    if (autoVerifyEnabled) {
      // Re-evaluate immediately so an already-complete response gets caught.
      autoVerifyLastHash = '';
      evaluateAutoVerify();
    }
  });
} catch (err) {
  warn('failed to subscribe to autoVerify setting', err);
}
