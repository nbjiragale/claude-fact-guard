# Claude Fact Guard

A Chrome extension that fact-checks Claude AI **and ChatGPT** responses
and pastes a literal correction back into the chat — on demand or
automatically, from a side panel, with optional Grammarly-style inline
highlights of the wrong claims.

Built for interview prep and other learning sessions where AI
hallucinations are unacceptable, and where you want a *second opinion*
on every claim before you internalize it.

> **Status:** v3.4 — Perplexity Web (your tab) is the default provider.
> Claude.ai and ChatGPT.com are both supported. Perplexity API and
> OpenRouter remain as paid alternatives.

---

## Why

Claude is one of the strongest models for explanation and back-and-forth
learning, but it occasionally states wrong facts (outdated version numbers,
fabricated dates, wrong attribution) with high confidence. Claude's built-in
web search drains the free-tier token budget when you flip it on for every
message.

Claude Fact Guard solves this by routing **only the latest assistant
response** (from Claude or ChatGPT) — when *you* click Verify, or
automatically when Auto-verify is on — through a fact-checker that you
trust. The default flow uses your **already-paid Perplexity Pro tab** as
the fact-checker, so the extension itself costs $0/month.

The correction is phrased as a plain fact:

> *Actually `<wrong claim>` is wrong — the correct fact is `<correct fact>` because `<brief reason>`. Please correct only those points and keep the rest of the explanation unchanged.*

so Claude just acknowledges it without an attribution tangent.

---

## Providers

You can choose between three fact-check providers in the side panel:

| Provider | Cost | What it does |
| --- | --- | --- |
| **Perplexity Web (your tab)** *(default)* | $0 — uses your Perplexity Pro subscription | Drives a logged-in `www.perplexity.ai` tab via a content script. Each Verify uses one of your **300 Pro searches/day**. |
| **Perplexity API (direct)** | metered (~$0.005–0.02 per call) | Calls `https://api.perplexity.ai/chat/completions` with your API key. |
| **OpenRouter** | metered (provider markup) | Calls `https://openrouter.ai/api/v1/chat/completions` routed to a `perplexity/sonar*` model. |

The Web provider was added in v3 specifically to remove the per-call cost
for solo-dev / hobby usage. The two API providers are still available for
users who already have credit and want lower latency.

---

## How it works

### Perplexity Web (default)

```
┌─ Claude.ai tab ─────────────────────┐    ┌─ Side panel ──────────────┐
│ assistant message #N (latest)       │    │  Provider = Perplexity Web │
│                                     │◄───┤  Set Context (one time)    │
│  ▲ paste correction into composer   │    │  Verify latest response ──┐│
│  │                                  │    │                           ││
│  └── content.js                     │    │  ◀── render verdict ◀──┐  ││
└─────────────────────────────────────┘    │                        │  ││
                                            └────────────┬───────────┘  ││
                                                         │              ││
                                                         ▼              ││
                                            ┌─ background.js ──────┐    ││
                                            │ find / focus / pin   │    ││
                                            │ Perplexity tab       │    ││
                                            └────────────┬─────────┘    ││
                                                         │              ││
                                                         ▼              ││
                                  ┌─ www.perplexity.ai tab ─────────┐   ││
                                  │ perplexity-content.js           │   ││
                                  │ - inject prompt into composer   │   ││
                                  │ - click send                    │   ││
                                  │ - MutationObserver waits for    │   ││
                                  │   streaming to finish           │   ││
                                  │ - read latest answer + sources  ├───┘│
                                  └─────────────────────────────────┘    │
                                                                          │
                                  background.js parses "Accurate." or     │
                                  "Actually X is wrong — Y because Z." ───┘
```

The Perplexity tab is **persistent for the entire Claude session**: the
first Verify seeds it with your strict fact-check instructions + saved
session context, and every subsequent Verify in the same Chrome session
reuses that thread so Perplexity remembers the context.

### Perplexity API / OpenRouter

These call the chosen REST endpoint with the same strict prompt, parse
the JSON verdict, and surface it identically in the UI.

---

## Install (developer / unpacked)

1. Clone this repo:
   ```
   git clone https://github.com/nbjiragale/claude-fact-guard.git
   ```
2. Open `chrome://extensions` in Chrome 120+.
3. Toggle **Developer mode** (top right).
4. Click **Load unpacked** and select the `claude-fact-guard/` directory.
5. Pin the extension. Clicking the icon opens the side panel.
6. **Default provider — Perplexity Web:**
   - Make sure you have a Perplexity Pro subscription.
   - Click **Open / focus** in the side panel; sign in to Perplexity in
     the tab that opens.
   - Done. Open [claude.ai](https://claude.ai) or
     [chatgpt.com](https://chatgpt.com) and hit
     **Verify latest AI response**.
7. **Alternate providers — Perplexity API / OpenRouter:**
   - In Settings, switch the radio to Perplexity API or OpenRouter.
   - Paste your API key:
     - **Perplexity (direct):** get a key at
       [perplexity.ai/settings/api](https://www.perplexity.ai/settings/api).
     - **OpenRouter:** get a key at
       [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys).
   - Pick a Sonar variant and click **Save settings**.

---

## Configuration

The side panel exposes:

| Setting | Where it lives | Default |
| --- | --- | --- |
| Provider | `chrome.storage.sync` | `perplexity-web` |
| Perplexity tab visibility | `chrome.storage.sync` | `visible` |
| Perplexity custom instructions | `chrome.storage.sync` | strict built-in default |
| Perplexity API key | `chrome.storage.sync` | _(empty — required for direct)_ |
| OpenRouter API key | `chrome.storage.sync` | _(empty — required for OpenRouter)_ |
| API model | `chrome.storage.sync` | `sonar` |
| Session context | `chrome.storage.sync` | _(empty)_ |
| Perplexity thread tab id | `chrome.storage.session` | _(re-discovered)_ |
| Verdict dedup cache | `chrome.storage.session` | _(empty)_ |
| Stats (verified / inaccurate / errors) | `chrome.storage.session` | `0` |

### Deduplication

Each verified Claude response is hashed (FNV-1a) and the verdict is
cached in `chrome.storage.session`. Clicking **Verify** on byte-identical
text returns the cached verdict without making another Perplexity search
or API call. A `cached` badge appears on the status row. If you want to
force a fresh check (e.g. because the truth changed), click
**Re-verify** which appears below the main Verify button.

### Resetting the Perplexity thread

The Web provider reuses one Perplexity thread per Chrome session so the
saved context is loaded once. Use **Start a fresh Perplexity thread**
under the Web settings when switching topics — it clears the cached
thread id and the dedup cache so the next Verify opens a brand-new
Perplexity thread and re-seeds it with the current custom instructions
+ session context.

---

## Provider & model recommendations

For the **Perplexity Web** provider you don't pick a model — Perplexity
uses whatever your Pro tab is configured for (default: their best).

For the **API** providers, the extension exposes the four Sonar variants:

| Variant | Use case | Cost | Notes |
| --- | --- | --- | --- |
| `sonar` | **Default.** Fast, cheapest, web-grounded. | 💲 | Best price-per-fact for routine fact-checks. |
| `sonar-pro` | Stronger search, longer context. | 💲💲 | Use when Claude's answer is long or covers multiple topics at once. |
| `sonar-reasoning` | Reasoning + search. | 💲💲 | Use for multi-step claims (e.g. proofs, algorithm complexity). |
| `sonar-reasoning-pro` | Best, slowest. | 💲💲💲 | High-stakes fact-checks (final-round interview prep). |

If you want a third-party comparison of cost vs. capability, see the
[OpenRouter Perplexity model list](https://openrouter.ai/perplexity).

---

## File layout

```
claude-fact-guard/
├── manifest.json              ← MV3 manifest (side_panel + 2 content scripts)
├── src/
│   ├── content.js             ← Claude tab: read latest message, inject text
│   ├── perplexity-content.js  ← Perplexity tab: inject prompt, observe answer
│   ├── background.js          ← provider dispatcher (web / api / openrouter)
│   ├── sidepanel.html
│   ├── sidepanel.css
│   └── sidepanel.js           ← settings, context, verify, verdict UI
├── icons/                     ← 16 / 48 / 128px PNGs
├── scripts/
│   └── generate-icons.py
├── PRIVACY.md
├── LICENSE
└── README.md
```

All Claude and Perplexity DOM selectors are declared as constants at the
top of `src/content.js` and `src/perplexity-content.js` respectively so
they can be patched in one place when either UI changes.

---

## Privacy

- Conversation messages are read from the page DOM only, only the
  **latest** assistant message, and only when you click Verify. Nothing
  is read or sent automatically.
- **Perplexity Web provider:** the latest Claude response (and, on the
  first Verify in a session, your saved context + custom instructions)
  is typed into your existing logged-in `www.perplexity.ai` tab.
  No data leaves your browser to a 3rd-party API.
- **API providers:** the latest assistant message + your saved context
  are sent over HTTPS with **your** API key to either
  `https://api.perplexity.ai/chat/completions` (Perplexity direct) or
  `https://openrouter.ai/api/v1/chat/completions` (OpenRouter, routed to
  `perplexity/sonar*`).
- The extension does not contact any other server, has no analytics, and
  has no remote code.
- Permissions: `storage`, `sidePanel`, `scripting`, `activeTab`, `tabs`,
  and host permissions for `claude.ai`, `chatgpt.com`,
  `chat.openai.com`, `*.perplexity.ai`, and `openrouter.ai`.

See [PRIVACY.md](PRIVACY.md) for the full policy.

---

## Debugging

Open DevTools on either tab and run:

```js
localStorage.setItem('cfg:debug', '1')
```

The content scripts will start logging DOM detection / injection events
under `[ClaudeFactGuard]` and `[ClaudeFactGuard:perplexity]`.

---

## Roadmap

- Per-verdict "explain" toggle that shows the full Perplexity answer.
- Inline "differences from Claude" diff view alongside the correction.
- Optional auto-Verify on send (off by default — manual is the design
  goal).

---

## License

MIT.
