# Claude Fact Guard

A Chrome extension that silently fact-checks every Claude AI response with
**Google Gemini 2.0 Flash** (Search Grounding enabled), and — when it finds
inaccuracies — types a targeted correction prompt back into Claude's input
field automatically.

You don't fact-check Claude. The extension does, in the background, while
you keep the conversational flow.

> **Status:** Phase 1 (Core) + pre-filter + deduplication.

---

## Why

Claude is one of the strongest LLMs for learning and concept explanation —
but it occasionally states wrong facts (outdated version numbers, fabricated
statistics, hallucinated dates) with high confidence. Turning on Claude's
built-in web search for *every* message rapidly drains the free-tier token
budget.

Claude Fact Guard solves both problems by:

1. Watching for completed assistant messages on `claude.ai`.
2. Skipping anything that looks purely conceptual (no factual signals).
3. Asking Gemini — with Google Search grounding — to verify the rest.
4. Injecting a precise correction prompt only for the inaccurate claims.

You keep using Claude normally. The extension stays out of the way.

---

## How it works

```
claude.ai tab ──► content.js
                    │  MutationObserver detects assistant message
                    │  Debounce 1200ms (full stream completed)
                    │  Regex pre-filter for factual signals
                    ▼
              chrome.runtime.sendMessage({ type: 'VERIFY', text })
                    │
                    ▼
              background.js (service worker)
                    │  POST → Gemini 2.0 Flash + google_search tool
                    │  Parse JSON verdict
                    ▼
              { accurate, issues, correctionPrompt }
                    │  if !accurate
                    ▼
              content.js → injectCorrection(prompt)
                    │  set composer innerText
                    │  dispatch InputEvent → React state syncs
                    │  click send button after 300ms
                    ▼
              Claude responds with a corrected, focused answer
```

---

## Install (developer / unpacked)

1. Clone this repo:
   ```
   git clone https://github.com/nbjiragale/claude-fact-guard.git
   ```
2. Open `chrome://extensions` in Chrome 120+.
3. Toggle **Developer mode** (top right).
4. Click **Load unpacked** and select the `claude-fact-guard/` directory.
5. Pin the extension and click its icon.
6. Paste your **Gemini API key** (get one at
   [Google AI Studio](https://aistudio.google.com/app/apikey)) and hit
   **Save key**.
7. Open [claude.ai](https://claude.ai), ask Claude something with verifiable
   facts, and watch the popup status update from `Checking…` to either
   `✓ Accurate` or `⚠ Corrected`.

To uninstall, remove it from `chrome://extensions`.

---

## File layout

```
claude-fact-guard/
├── manifest.json            ← MV3 manifest
├── src/
│   ├── content.js           ← MutationObserver, pre-filter, dedup, injection
│   ├── background.js        ← Gemini call, verdict parsing, session stats
│   ├── popup.html
│   ├── popup.css
│   └── popup.js             ← API key, toggle, status, counters
├── icons/                   ← 16 / 48 / 128px PNGs
├── scripts/
│   └── generate-icons.py    ← Regenerate icons from a single source
├── PRIVACY.md
├── LICENSE
└── README.md
```

All Claude DOM selectors are declared as constants at the top of
`src/content.js` so they can be patched in one place when Claude's UI
changes.

---

## Privacy

- Conversation messages are read from the page DOM only. Nothing is stored
  on disk.
- A message is **only** sent to Gemini if it passes the regex pre-filter.
- Gemini is called directly from the extension over HTTPS using **your**
  API key. The extension does not contact any other server, has no
  analytics, and has no remote code.
- Permissions are limited to `storage` + `https://claude.ai/*` +
  `https://generativelanguage.googleapis.com/*`.

See [PRIVACY.md](PRIVACY.md) for the full policy.

---

## Configuration

The popup exposes:

| Setting | Where it lives | Default |
| --- | --- | --- |
| Gemini API key | `chrome.storage.sync` | _(empty — required)_ |
| Enabled toggle | `chrome.storage.sync` | `true` |
| Session counters | `chrome.storage.session` | `0` |

To debug, open Claude DevTools and run:

```js
localStorage.setItem('cfg:debug', '1')
```

The content script will start logging detection / pre-filter / verdict
events to the page console.

---

## Roadmap

This first cut implements PRD Phase 1 (Core) plus the pre-filter and
deduplication from Phase 2. Planned next:

- **Phase 2 finishing touches:** selector health-check toast, additional
  fallback injection via `execCommand`.
- **Phase 3 — UX polish:** in-page toast when a correction is injected,
  popup history list of recent verdicts.
- **Phase 4 — Publish:** Chrome Web Store listing, store screenshots,
  signed builds.

---

## License

[MIT](LICENSE).
