// Claude Fact Guard — content script
//
// Lives on the supported AI assistant tabs (claude.ai, chatgpt.com,
// chat.openai.com). Listens for messages from the side panel:
//
//   - GET_LATEST_RESPONSE: returns the text of the latest fully-rendered
//                          assistant message on the page.
//   - INJECT_TEXT { text, send }: writes `text` into the composer; if
//                                 `send` is true, clicks the send button.
//
// This script does NOT auto-fact-check anything. Verification is triggered
// manually from the side panel ("Verify" / "Set Context" buttons) or by
// the auto-verify observer when the corresponding setting is on.
//
// All assistant-site DOM selectors live in HOST_ADAPTERS so support for a
// new host (e.g. Gemini) is purely additive: add an entry there and the
// rest of this file stays unchanged.

const HOST_ADAPTERS = {
  // Anthropic Claude — https://claude.ai
  'claude.ai': {
    label: 'Claude',
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
  },
  // OpenAI ChatGPT — https://chatgpt.com (legacy chat.openai.com redirects)
  'chatgpt.com': {
    label: 'ChatGPT',
    assistantMessage: {
      primary: '[data-message-author-role="assistant"]',
      fallback:
        'div.markdown.prose, [data-testid^="conversation-turn"] [data-message-author-role="assistant"]',
    },
    composerInput: {
      primary: '#prompt-textarea',
      fallback:
        'div[contenteditable="true"][data-virtualkeyboard], textarea#prompt-textarea, textarea[data-testid="prompt-textarea"]',
    },
    sendButton: {
      primary: 'button[data-testid="send-button"]',
      fallback:
        'button[data-testid="fruitjuice-send-button"], button[aria-label="Send prompt" i], button[aria-label="Send message" i], form button[type="submit"]',
    },
  },
};
// Aliased hosts that share an adapter.
HOST_ADAPTERS['chat.openai.com'] = HOST_ADAPTERS['chatgpt.com'];

const HOST_KEY = (() => {
  const h = (location.hostname || '').toLowerCase();
  // Strip leading "www." so www.claude.ai matches claude.ai if that ever ships.
  return h.startsWith('www.') ? h.slice(4) : h;
})();
const HOST_ADAPTER = HOST_ADAPTERS[HOST_KEY] || HOST_ADAPTERS['claude.ai'];
const SELECTORS = {
  assistantMessage: HOST_ADAPTER.assistantMessage,
  composerInput: HOST_ADAPTER.composerInput,
  sendButton: HOST_ADAPTER.sendButton,
};
const HOST_LABEL = HOST_ADAPTER.label;

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
  if (!messages.length) {
    return {
      ok: false,
      error: `No ${HOST_LABEL} assistant messages found on this page yet.`,
    };
  }
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

  // Plain <textarea> path (legacy ChatGPT fallback) — React/Lexical here read
  // the .value via the prototype setter, so go through it to trigger their
  // controlled-component change handler.
  if (composer.tagName === 'TEXTAREA' || composer.tagName === 'INPUT') {
    try {
      const proto = Object.getPrototypeOf(composer);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) {
        setter.call(composer, text);
      } else {
        composer.value = text;
      }
    } catch (_) {
      composer.value = text;
    }
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    composer.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }

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
  // React/Tiptap/ProseMirror's synthetic event system picks up the change.
  while (composer.firstChild) composer.removeChild(composer.firstChild);
  // ProseMirror (used by ChatGPT) renders one <p> per line; mirroring that
  // is more compatible than raw text nodes inside the editor root.
  const lines = text.split('\n');
  if (HOST_KEY === 'chatgpt.com' || HOST_KEY === 'chat.openai.com') {
    lines.forEach((line) => {
      const p = document.createElement('p');
      p.textContent = line.length ? line : '';
      if (!line.length) {
        const br = document.createElement('br');
        br.className = 'ProseMirror-trailingBreak';
        p.appendChild(br);
      }
      composer.appendChild(p);
    });
  } else {
    // Claude / generic contenteditable: text nodes with <br> separators.
    lines.forEach((line, i) => {
      composer.appendChild(document.createTextNode(line));
      if (i < lines.length - 1) {
        composer.appendChild(document.createElement('br'));
      }
    });
  }

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
    return {
      ok: false,
      error: `${HOST_LABEL} composer not found. Is the chat thread open?`,
    };
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
      case 'APPLY_HIGHLIGHTS': {
        try {
          const out = applyInlineHighlights(msg.verdict || null);
          sendResponse({ ok: true, ...out });
        } catch (err) {
          sendResponse({ ok: false, error: err?.message || String(err) });
        }
        return;
      }
      case 'CLEAR_HIGHLIGHTS': {
        try {
          clearInlineHighlights();
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err?.message || String(err) });
        }
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

log('Claude Fact Guard content script attached', { host: HOST_KEY, label: HOST_LABEL });

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

// ---------------------------------------------------------------------------
// Inline highlights (Grammarly-style)
//
// When the side-panel verify (manual or auto) returns an INACCURATE verdict
// with `inlineIssues[]`, the background sends APPLY_HIGHLIGHTS here. For
// every {quote, fix, why} block, we find the verbatim QUOTE inside the
// latest Claude assistant message and wrap it in a marked span with a
// hover/click popover that surfaces the correction + sources.
//
// Design constraints:
//   • Never modify Claude's editable composer DOM — we only decorate the
//     read-only assistant-message subtree.
//   • Skip <pre>/<code> blocks entirely; code is not fact-checked.
//   • Tolerant text matching: tries the exact QUOTE first, then strips
//     curly quotes / collapses whitespace and retries, finally falls back
//     to the most distinctive token (4+ char alnum word).
//   • Re-applies if Claude re-renders the assistant message (SPA navigation,
//     streaming refresh) — we cache the last verdict + a snapshot of the
//     message DOM signature and re-mark on relevant mutations.
//   • A single shared popover element is reused across all highlight spans.
// ---------------------------------------------------------------------------

const HIGHLIGHT_CLASS = 'cfg-issue';
const HIGHLIGHT_DATA = 'data-cfg-issue';
const POPOVER_ID = 'cfg-issue-popover';
const HIGHLIGHT_STYLE_ID = 'cfg-issue-style';
const HIGHLIGHT_MAX_ISSUES = 12;

let cachedHighlightVerdict = null;
let highlightReapplyTimer = null;
let highlightObserverAttached = false;

function ensureHighlightStyles() {
  if (document.getElementById(HIGHLIGHT_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = HIGHLIGHT_STYLE_ID;
  style.textContent = `
    .${HIGHLIGHT_CLASS} {
      background: linear-gradient(transparent 60%, rgba(217,119,87,0.32) 60%);
      border-bottom: 2px solid #d97757;
      cursor: pointer;
      border-radius: 1px;
      padding: 0 1px;
      transition: background 0.12s ease;
    }
    .${HIGHLIGHT_CLASS}:hover {
      background: linear-gradient(transparent 60%, rgba(217,119,87,0.55) 60%);
    }
    #${POPOVER_ID} {
      position: absolute;
      z-index: 2147483646;
      max-width: 380px;
      min-width: 240px;
      background: #ffffff;
      color: #2D2A26;
      border: 1px solid #d8d3c1;
      border-radius: 10px;
      box-shadow: 0 12px 32px rgba(0,0,0,0.18);
      padding: 12px 14px;
      font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
      pointer-events: auto;
    }
    #${POPOVER_ID} .cfg-pop-header {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #d97757;
      margin-bottom: 8px;
    }
    #${POPOVER_ID} .cfg-pop-quote {
      font-size: 12px;
      color: #8a847a;
      text-decoration: line-through;
      margin-bottom: 6px;
      word-break: break-word;
    }
    #${POPOVER_ID} .cfg-pop-fix {
      font-size: 13px;
      color: #2D2A26;
      font-weight: 600;
      margin-bottom: 4px;
      word-break: break-word;
    }
    #${POPOVER_ID} .cfg-pop-why {
      font-size: 12px;
      color: #5b564f;
      word-break: break-word;
      margin-bottom: 8px;
    }
    #${POPOVER_ID} .cfg-pop-sources {
      font-size: 11px;
      color: #8a847a;
      margin-bottom: 8px;
      word-break: break-all;
    }
    #${POPOVER_ID} .cfg-pop-sources a {
      color: #d97757;
      text-decoration: none;
      margin-right: 6px;
    }
    #${POPOVER_ID} .cfg-pop-sources a:hover {
      text-decoration: underline;
    }
    #${POPOVER_ID} .cfg-pop-actions {
      display: flex;
      gap: 8px;
    }
    #${POPOVER_ID} button.cfg-pop-btn {
      flex: 1;
      font: inherit;
      font-size: 12px;
      padding: 6px 10px;
      border-radius: 6px;
      border: 1px solid #d8d3c1;
      background: #faf9f5;
      color: #2D2A26;
      cursor: pointer;
    }
    #${POPOVER_ID} button.cfg-pop-btn.primary {
      background: #d97757;
      color: #ffffff;
      border-color: #d97757;
    }
    #${POPOVER_ID} button.cfg-pop-btn:hover {
      filter: brightness(0.96);
    }
    @media (prefers-color-scheme: dark) {
      #${POPOVER_ID} {
        background: #2C2A25;
        color: #F0EEE6;
        border-color: #423E37;
      }
      #${POPOVER_ID} .cfg-pop-fix { color: #F0EEE6; }
      #${POPOVER_ID} .cfg-pop-why { color: #c8c1b6; }
      #${POPOVER_ID} button.cfg-pop-btn {
        background: #1F1E1B;
        color: #F0EEE6;
        border-color: #423E37;
      }
    }
  `;
  document.documentElement.appendChild(style);
}

function getLatestAssistantElement() {
  const messages = querySelectorAllWithFallback(SELECTORS.assistantMessage);
  if (!messages.length) return null;
  return messages[messages.length - 1];
}

function clearInlineHighlights(scope) {
  const root = scope || document;
  const marks = root.querySelectorAll(`span.${HIGHLIGHT_CLASS}`);
  marks.forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize?.();
  });
  hidePopover();
}

function normalizeForMatch(s) {
  return (s || '')
    .replace(/[\u201C\u201D\u2018\u2019]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function shouldSkipNode(node) {
  let cur = node.parentNode;
  while (cur && cur !== document.body) {
    if (
      cur.classList?.contains(HIGHLIGHT_CLASS) ||
      cur.tagName === 'PRE' ||
      cur.tagName === 'CODE' ||
      cur.tagName === 'SCRIPT' ||
      cur.tagName === 'STYLE'
    ) {
      return true;
    }
    cur = cur.parentNode;
  }
  return false;
}

function collectTextNodes(root) {
  const out = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      if (shouldSkipNode(n)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let n;
  while ((n = walker.nextNode())) out.push(n);
  return out;
}

function findAndWrap(root, quote, issue, index) {
  if (!quote) return false;
  const needle = normalizeForMatch(quote).toLowerCase();
  if (needle.length < 3) return false;

  const nodes = collectTextNodes(root);
  for (const node of nodes) {
    const value = node.nodeValue || '';
    const hay = normalizeForMatch(value).toLowerCase();
    const idx = hay.indexOf(needle);
    if (idx === -1) continue;
    // Map normalized index back to the original string. We walk the raw
    // value collapsing whitespace runs to a single space, just like
    // normalizeForMatch does, and track positions so we know which
    // original-char range corresponds to the normalized hit.
    const range = mapNormalizedRange(value, idx, needle.length);
    if (!range) continue;
    wrapRange(node, range.start, range.end, issue, index);
    return true;
  }

  // Fallback: longest distinctive token (4+ char alnum + numbers).
  const tokens = needle.match(/[\w\d]{4,}/g) || [];
  tokens.sort((a, b) => b.length - a.length);
  for (const tok of tokens) {
    for (const node of nodes) {
      const value = node.nodeValue || '';
      const lower = value.toLowerCase();
      const idx = lower.indexOf(tok);
      if (idx === -1) continue;
      wrapRange(node, idx, idx + tok.length, issue, index);
      return true;
    }
  }
  return false;
}

// Map a (start, length) range expressed against the normalized version of
// `value` back to a (start, end) range in the original `value`. Returns
// null if mapping fails (e.g. trailing whitespace eaten by collapse).
function mapNormalizedRange(value, normStart, normLen) {
  let normIdx = 0;
  let startOrig = -1;
  let endOrig = -1;
  let prevSpace = false;
  const normEnd = normStart + normLen;
  // The normalizeForMatch trim() can strip leading whitespace; emulate.
  let leading = 0;
  while (leading < value.length && /\s/.test(value[leading])) leading++;
  for (let i = leading; i < value.length; i++) {
    const ch = value[i];
    const isSpace = /\s/.test(ch);
    let normCh = ch;
    if (isSpace) {
      if (prevSpace) continue;
      normCh = ' ';
    }
    if (normIdx === normStart && startOrig === -1) startOrig = i;
    if (normIdx === normEnd && endOrig === -1) {
      endOrig = i;
      break;
    }
    normIdx++;
    prevSpace = isSpace;
  }
  if (startOrig === -1) return null;
  if (endOrig === -1) endOrig = value.length;
  return { start: startOrig, end: endOrig };
}

function wrapRange(textNode, start, end, issue, index) {
  const value = textNode.nodeValue || '';
  if (start < 0 || end > value.length || start >= end) return;
  const before = value.slice(0, start);
  const middle = value.slice(start, end);
  const after = value.slice(end);
  const span = document.createElement('span');
  span.className = HIGHLIGHT_CLASS;
  span.setAttribute(HIGHLIGHT_DATA, String(index));
  span.textContent = middle;
  span.dataset.cfgQuote = issue.quote || '';
  span.dataset.cfgFix = issue.fix || '';
  span.dataset.cfgWhy = issue.why || '';
  span.dataset.cfgSources = JSON.stringify(issue.citations || []);
  span.addEventListener('click', onHighlightClick, { passive: true });
  span.addEventListener('mouseenter', onHighlightHover, { passive: true });
  const parent = textNode.parentNode;
  if (!parent) return;
  const beforeNode = document.createTextNode(before);
  const afterNode = document.createTextNode(after);
  parent.insertBefore(beforeNode, textNode);
  parent.insertBefore(span, textNode);
  parent.insertBefore(afterNode, textNode);
  parent.removeChild(textNode);
}

function getOrCreatePopover() {
  let pop = document.getElementById(POPOVER_ID);
  if (pop) return pop;
  pop = document.createElement('div');
  pop.id = POPOVER_ID;
  pop.style.display = 'none';
  pop.addEventListener('mouseleave', () => hidePopover());
  document.body.appendChild(pop);
  // Click-outside dismiss.
  document.addEventListener('click', (e) => {
    if (!pop) return;
    if (pop.style.display === 'none') return;
    if (pop.contains(e.target) || e.target.classList?.contains(HIGHLIGHT_CLASS)) return;
    hidePopover();
  });
  return pop;
}

function hidePopover() {
  const pop = document.getElementById(POPOVER_ID);
  if (pop) pop.style.display = 'none';
}

function buildPopoverContent(quote, fix, why, citations) {
  const safeQuote = (quote || '').replace(/[<>&]/g, (c) => `&#${c.charCodeAt(0)};`);
  const safeFix = (fix || '').replace(/[<>&]/g, (c) => `&#${c.charCodeAt(0)};`);
  const safeWhy = (why || '').replace(/[<>&]/g, (c) => `&#${c.charCodeAt(0)};`);
  const sourcesHtml = (citations || [])
    .slice(0, 4)
    .map((u, i) => {
      const url = (u || '').replace(/"/g, '%22');
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">[${i + 1}]</a>`;
    })
    .join(' ');
  return `
    <div class="cfg-pop-header">Inaccurate · Fact Guard</div>
    <div class="cfg-pop-quote">"${safeQuote}"</div>
    <div class="cfg-pop-fix">${safeFix || 'See correction in the side panel.'}</div>
    ${safeWhy ? `<div class="cfg-pop-why">${safeWhy}</div>` : ''}
    ${sourcesHtml ? `<div class="cfg-pop-sources">${sourcesHtml}</div>` : ''}
    <div class="cfg-pop-actions">
      <button class="cfg-pop-btn" data-cfg-act="copy">Copy correction</button>
      <button class="cfg-pop-btn primary" data-cfg-act="dismiss">Dismiss</button>
    </div>
  `;
}

function positionPopover(pop, span) {
  const rect = span.getBoundingClientRect();
  const scrollX = window.pageXOffset || document.documentElement.scrollLeft;
  const scrollY = window.pageYOffset || document.documentElement.scrollTop;
  pop.style.display = 'block';
  // Default below-and-left-aligned; flip above if too close to bottom.
  const popH = pop.offsetHeight || 160;
  const popW = pop.offsetWidth || 320;
  let top = rect.bottom + scrollY + 8;
  if (rect.bottom + popH + 12 > window.innerHeight) {
    top = rect.top + scrollY - popH - 8;
    if (top < scrollY + 8) top = scrollY + 8;
  }
  let left = rect.left + scrollX;
  if (left + popW + 12 > window.innerWidth + scrollX) {
    left = window.innerWidth + scrollX - popW - 12;
  }
  if (left < scrollX + 8) left = scrollX + 8;
  pop.style.top = `${top}px`;
  pop.style.left = `${left}px`;
}

function showPopoverForSpan(span) {
  const pop = getOrCreatePopover();
  const quote = span.dataset.cfgQuote || span.textContent;
  const fix = span.dataset.cfgFix || '';
  const why = span.dataset.cfgWhy || '';
  let citations = [];
  try {
    citations = JSON.parse(span.dataset.cfgSources || '[]');
  } catch (_) {
    citations = [];
  }
  pop.innerHTML = buildPopoverContent(quote, fix, why, citations);
  pop.querySelector('[data-cfg-act="dismiss"]')?.addEventListener('click', () => hidePopover());
  pop.querySelector('[data-cfg-act="copy"]')?.addEventListener('click', () => {
    const text = fix
      ? why
        ? `${fix} (${why})`
        : fix
      : quote;
    try {
      navigator.clipboard.writeText(text).catch(() => {});
    } catch (_) {
      /* ignore */
    }
  });
  positionPopover(pop, span);
}

function onHighlightHover(e) {
  showPopoverForSpan(e.currentTarget);
}

function onHighlightClick(e) {
  e.stopPropagation();
  showPopoverForSpan(e.currentTarget);
}

function applyInlineHighlights(verdict) {
  ensureHighlightStyles();
  // Always tear down old highlights — verdict may have changed.
  clearInlineHighlights();
  cachedHighlightVerdict = verdict;
  if (!verdict || verdict.accurate || !Array.isArray(verdict.inlineIssues)) {
    return { applied: 0 };
  }
  const root = getLatestAssistantElement();
  if (!root) return { applied: 0 };
  const citations = Array.isArray(verdict.citations) ? verdict.citations : [];
  let applied = 0;
  verdict.inlineIssues.slice(0, HIGHLIGHT_MAX_ISSUES).forEach((issue, i) => {
    if (!issue || !issue.quote) return;
    const enriched = {
      quote: issue.quote,
      fix: issue.fix || '',
      why: issue.why || '',
      citations: (issue.sourceTags || [])
        .map((tag) => citations[tag - 1])
        .filter(Boolean),
    };
    if (enriched.citations.length === 0) enriched.citations = citations.slice(0, 2);
    const ok = findAndWrap(root, issue.quote, enriched, i);
    if (ok) applied++;
  });
  attachHighlightReapplyObserver();
  return { applied };
}

function attachHighlightReapplyObserver() {
  if (highlightObserverAttached) return;
  highlightObserverAttached = true;
  const obs = new MutationObserver(() => {
    if (!cachedHighlightVerdict) return;
    const root = getLatestAssistantElement();
    if (!root) return;
    // If our marks are gone (Claude re-rendered) and we still have a
    // cached verdict, debounce a re-apply.
    if (!root.querySelector(`.${HIGHLIGHT_CLASS}`)) {
      if (highlightReapplyTimer) clearTimeout(highlightReapplyTimer);
      highlightReapplyTimer = setTimeout(() => {
        highlightReapplyTimer = null;
        if (cachedHighlightVerdict && !cachedHighlightVerdict.accurate) {
          applyInlineHighlights(cachedHighlightVerdict);
        }
      }, 600);
    }
  });
  obs.observe(document.body, { subtree: true, childList: true });
}

// ---------------------------------------------------------------------------
// Inline "Fact-check" button
//
// Renders a small action button on every assistant message so the user
// can trigger a verification with one click without opening the side
// panel. The button itself reflects the verdict state:
//
//   idle        — "Fact-check"            (clickable)
//   checking    — "Checking…"             (disabled, spinner)
//   accurate    — "Accurate"              (green)
//   inaccurate  — "N issues"              (orange; highlights also painted)
//   error       — "Error"                 (red; hover for details)
//
// Each button reads only its own assistant message's text on click, so
// the user can fact-check older messages, not just the latest one. The
// inline highlights still flow through the existing APPLY_HIGHLIGHTS
// path — the background pushes them to the latest assistant element
// after each VERIFY.
//
// Adheres to SRP: this section knows nothing about highlights, dedup,
// or providers — it just wires a click to the background's VERIFY
// message and renders the result on the button.
// ---------------------------------------------------------------------------

const VERIFY_BTN_CLASS = 'cfg-verify-btn';
const VERIFY_BTN_ROW_CLASS = 'cfg-verify-row';
const VERIFY_BTN_ATTACHED_ATTR = 'data-cfg-verify-attached';
const VERIFY_BTN_STYLE_ID = 'cfg-verify-btn-style';

function ensureVerifyButtonStyles() {
  if (document.getElementById(VERIFY_BTN_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = VERIFY_BTN_STYLE_ID;
  style.textContent = `
    .${VERIFY_BTN_ROW_CLASS} {
      display: flex;
      justify-content: flex-end;
      margin: 8px 0 4px;
      pointer-events: none;
    }
    .${VERIFY_BTN_CLASS} {
      pointer-events: auto;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      font: 500 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
      color: #8a7c5e;
      background: transparent;
      border: 1px solid rgba(138,124,94,0.35);
      border-radius: 999px;
      cursor: pointer;
      transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease, transform 0.06s ease;
    }
    .${VERIFY_BTN_CLASS}:hover {
      color: #d97757;
      border-color: #d97757;
      background: rgba(217,119,87,0.06);
    }
    .${VERIFY_BTN_CLASS}:active {
      transform: translateY(1px);
    }
    .${VERIFY_BTN_CLASS}:disabled {
      cursor: progress;
      opacity: 0.75;
    }
    .${VERIFY_BTN_CLASS} svg {
      width: 14px;
      height: 14px;
      flex: 0 0 14px;
    }
    .${VERIFY_BTN_CLASS}[data-cfg-state="checking"] svg {
      animation: cfg-verify-spin 0.9s linear infinite;
      transform-origin: 50% 50%;
    }
    .${VERIFY_BTN_CLASS}[data-cfg-state="accurate"] {
      color: #1f7a4d;
      border-color: rgba(31,122,77,0.5);
      background: rgba(31,122,77,0.08);
    }
    .${VERIFY_BTN_CLASS}[data-cfg-state="inaccurate"] {
      color: #b94a2b;
      border-color: rgba(217,119,87,0.55);
      background: rgba(217,119,87,0.10);
    }
    .${VERIFY_BTN_CLASS}[data-cfg-state="error"] {
      color: #8a2929;
      border-color: rgba(138,41,41,0.45);
      background: rgba(138,41,41,0.06);
    }
    @media (prefers-color-scheme: dark) {
      .${VERIFY_BTN_CLASS} {
        color: #b5a987;
        border-color: rgba(181,169,135,0.3);
      }
      .${VERIFY_BTN_CLASS}:hover {
        color: #e6916e;
        border-color: #e6916e;
        background: rgba(230,145,110,0.10);
      }
    }
    @keyframes cfg-verify-spin {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }
  `;
  document.documentElement.appendChild(style);
}

function buildVerifyButtonSVG(state) {
  if (state === 'checking') {
    // Simple ring spinner.
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3.5-7.1" /></svg>`;
  }
  if (state === 'accurate') {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>`;
  }
  if (state === 'inaccurate') {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" /></svg>`;
  }
  if (state === 'error') {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M15 9l-6 6" /><path d="M9 9l6 6" /></svg>`;
  }
  // idle — shield icon.
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.0" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m9 12 2 2 4-4" /></svg>`;
}

function setVerifyBtnState(btn, state, label, title) {
  if (!btn) return;
  btn.dataset.cfgState = state;
  btn.disabled = state === 'checking';
  const iconSlot = btn.querySelector('.cfg-verify-icon');
  if (iconSlot) iconSlot.innerHTML = buildVerifyButtonSVG(state);
  const labelEl = btn.querySelector('.cfg-verify-label');
  if (labelEl) labelEl.textContent = label;
  btn.title = title || label;
  btn.setAttribute('aria-label', `${HOST_LABEL} fact-check: ${label}`);
}

function attachVerifyButton(messageEl) {
  if (!messageEl) return;
  if (messageEl.getAttribute(VERIFY_BTN_ATTACHED_ATTR) === '1') return;
  // Guard: if a button row is already a child (re-render path), don't
  // duplicate. The attribute marker is the canonical signal.
  if (messageEl.querySelector(`.${VERIFY_BTN_ROW_CLASS}`)) {
    messageEl.setAttribute(VERIFY_BTN_ATTACHED_ATTR, '1');
    return;
  }
  messageEl.setAttribute(VERIFY_BTN_ATTACHED_ATTR, '1');

  const row = document.createElement('div');
  row.className = VERIFY_BTN_ROW_CLASS;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = VERIFY_BTN_CLASS;
  btn.dataset.cfgState = 'idle';
  btn.innerHTML =
    `<span class="cfg-verify-icon">${buildVerifyButtonSVG('idle')}</span>` +
    `<span class="cfg-verify-label">Fact-check</span>`;
  btn.title = `Fact-check this ${HOST_LABEL} response`;
  btn.setAttribute('aria-label', `Fact-check this ${HOST_LABEL} response`);
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    runInlineVerify(messageEl, btn);
  });

  row.appendChild(btn);
  messageEl.appendChild(row);
}

function runInlineVerify(messageEl, btn) {
  // Read only this message's text — not the page latest — so older
  // messages can also be fact-checked from their own button.
  let text = '';
  try {
    // Exclude the button row itself from innerText.
    const clone = messageEl.cloneNode(true);
    clone.querySelectorAll(`.${VERIFY_BTN_ROW_CLASS}`).forEach((n) => n.remove());
    text = (clone.innerText || '').trim();
  } catch (_) {
    text = (messageEl.innerText || '').trim();
  }
  if (!text) {
    setVerifyBtnState(btn, 'error', 'No text', 'This message has no readable text yet.');
    return;
  }
  setVerifyBtnState(btn, 'checking', 'Checking…', 'Fact-checking with your selected provider…');
  try {
    chrome.runtime.sendMessage({ type: 'VERIFY', text }, (resp) => {
      if (chrome.runtime.lastError) {
        setVerifyBtnState(
          btn,
          'error',
          'Error',
          chrome.runtime.lastError.message || 'Could not reach background.',
        );
        return;
      }
      if (!resp || !resp.ok) {
        setVerifyBtnState(
          btn,
          'error',
          'Error',
          resp?.error || 'Verification failed.',
        );
        return;
      }
      const v = resp.verdict || {};
      if (v.accurate) {
        setVerifyBtnState(
          btn,
          'accurate',
          resp.fromCache ? 'Accurate (cached)' : 'Accurate',
          'No factual issues detected. Click to re-verify via the side panel.',
        );
      } else {
        const n = Array.isArray(v.issues) ? v.issues.length : 0;
        const label = `${n || 1} issue${n === 1 ? '' : 's'}`;
        setVerifyBtnState(
          btn,
          'inaccurate',
          resp.fromCache ? `${label} (cached)` : label,
          'Inaccuracies highlighted in the message. Hover a highlight for the correction.',
        );
      }
    });
  } catch (err) {
    setVerifyBtnState(
      btn,
      'error',
      'Error',
      err?.message || String(err),
    );
  }
}

function scanAndAttachVerifyButtons() {
  ensureVerifyButtonStyles();
  const messages = querySelectorAllWithFallback(SELECTORS.assistantMessage);
  for (const msg of messages) attachVerifyButton(msg);
}

// Debounce scans so Claude's streaming mutations don't thrash this code.
let verifyBtnScanTimer = null;
function scheduleVerifyButtonScan() {
  if (verifyBtnScanTimer) return;
  verifyBtnScanTimer = setTimeout(() => {
    verifyBtnScanTimer = null;
    try {
      scanAndAttachVerifyButtons();
    } catch (err) {
      warn('verify button scan failed', err);
    }
  }, 300);
}

try {
  const verifyBtnObserver = new MutationObserver(scheduleVerifyButtonScan);
  verifyBtnObserver.observe(document.body, {
    subtree: true,
    childList: true,
  });
  // Initial pass.
  scanAndAttachVerifyButtons();
} catch (err) {
  warn('verify button observer failed to attach', err);
}
