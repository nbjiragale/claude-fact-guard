# Claude Fact Guard

A Chrome extension that fact-checks Claude AI responses with **Perplexity
Sonar** (web-grounded search) and pastes a literal correction back into
Claude — on demand, from a side panel.

Built for interview prep and other learning sessions where Claude's
hallucinations are unacceptable, and where you want a *second opinion*
on every claim before you internalize it.

> **Status:** v2.0 — manual Verify flow + side panel UI.

---

## Why

Claude is one of the strongest models for explanation and back-and-forth
learning, but it occasionally states wrong facts (outdated version numbers,
fabricated dates, wrong attribution) with high confidence. Claude's built-in
web search drains the free-tier token budget when you flip it on for every
message.

Claude Fact Guard solves this by routing **only the latest Claude response**
— when *you* click Verify — through a fact-checker that you trust:

- **Perplexity Sonar** with web grounding (cheap, fast, citation-backed)
- via your **own API key** (Perplexity direct *or* OpenRouter)
- with a **strict** prompt: even 1% off counts as inaccurate
- with an **interview-prep context** you set once at the start of the chat

No other model is used. The correction is phrased as a plain fact:

> *Actually `<wrong claim>` is wrong — the correct fact is `<correct fact>` because `<brief reason>`. Please correct only those points and keep the rest of the explanation unchanged.*

so Claude just acknowledges it without an attribution tangent.

---

## How it works

```
┌─ Claude.ai tab ───────────────────────┐    ┌─ Side panel ─────────────────┐
│ assistant message #N (latest)         │    │  Settings (provider + key)   │
│                                       │◄───┤  Set Context (one time)      │
│  ▲ paste correction into composer     │    │  Verify latest response  ──┐ │
│  │                                    │    │                            │ │
│  └─── content.js                      │    │  ◀── render verdict ◀──┐   │ │
└───────────────────────────────────────┘    │                        │   │ │
                                              │  Paste / Paste & Send  │   │ │
                                              └────────────┬───────────┘   │ │
                                                           │               │ │
                                                           ▼               │ │
                                                  ┌─ background.js ─┐      │ │
                                                  │ POST            │      │ │
                                                  │ api.perplexity  │◄─────┘ │
                                                  │ .ai / openrouter│        │
                                                  │ → JSON verdict  ├────────┘
                                                  └─────────────────┘
```

1. Pin the extension and click its icon → side panel opens.
2. **Settings:** choose a provider (Perplexity direct or OpenRouter), paste
   your API key, pick a model (default: `sonar` — the cheapest).
3. **Session context (optional but recommended):** paste your interview-prep
   topic and scope. Either save it (it'll be prepended to every Verify
   call) or paste it into the Claude composer with one click so Claude has
   it too.
4. Ask Claude something with verifiable facts.
5. Hit **Verify latest Claude response**. The extension reads the most
   recent assistant message from the page DOM, sends it (plus your context)
   to Perplexity Sonar with the strict fact-checker prompt, and renders a
   verdict + citations.
6. If anything is wrong, click **Paste** or **Paste & send** to push a
   literal correction back into Claude's composer.

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
6. In **Settings**, pick your provider and paste your API key:
   - **Perplexity (direct):** get a key at
     [perplexity.ai/settings/api](https://www.perplexity.ai/settings/api).
   - **OpenRouter:** get a key at
     [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys).
7. Open [claude.ai](https://claude.ai), have a conversation, and use
   **Verify latest Claude response** whenever you want a sanity check.

---

## Provider & model recommendations

Sonar is **only** offered through Perplexity's API and via OpenRouter. The
extension exposes the four current Sonar variants on each provider:

| Variant | Use case | Cost | Notes |
| --- | --- | --- | --- |
| `sonar` | **Default.** Fast, cheapest, web-grounded. | 💲 | Best price-per-fact for routine fact-checks. |
| `sonar-pro` | Stronger search, longer context. | 💲💲 | Use when Claude's answer is long or covers multiple topics at once. |
| `sonar-reasoning` | Reasoning + search. | 💲💲 | Use for multi-step claims (e.g. proofs, algorithm complexity). |
| `sonar-reasoning-pro` | Best, slowest. | 💲💲💲 | High-stakes fact-checks (final-round interview prep). |

If you want a third-party comparison of cost vs. capability, see the
[OpenRouter Perplexity model list](https://openrouter.ai/perplexity).

If you only want to manage one API key for many models in the future,
OpenRouter is more flexible. If you want lowest latency and direct
billing, go with the Perplexity direct provider.

---

## File layout

```
claude-fact-guard/
├── manifest.json              ← MV3 manifest (side_panel)
├── src/
│   ├── content.js             ← reads latest Claude message, injects text
│   ├── background.js          ← Perplexity Sonar call (direct or OpenRouter)
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

All Claude DOM selectors are declared as constants at the top of
`src/content.js` so they can be patched in one place when Claude's UI
changes.

---

## Privacy

- Conversation messages are read from the page DOM only, and only the
  **latest** assistant message, and only when you click Verify. Nothing is
  read or sent automatically.
- The latest assistant message + your saved context are sent — over HTTPS
  with **your** API key — to either:
  - `https://api.perplexity.ai/chat/completions` (Perplexity direct), or
  - `https://openrouter.ai/api/v1/chat/completions` (OpenRouter, routed to
    `perplexity/sonar*`).
- The extension does not contact any other server, has no analytics, and
  has no remote code.
- Permissions: `storage`, `sidePanel`, `scripting`, `activeTab`, and host
  permissions for `claude.ai`, `api.perplexity.ai`, and `openrouter.ai`.

See [PRIVACY.md](PRIVACY.md) for the full policy.

---

## Configuration

The side panel exposes:

| Setting | Where it lives | Default |
| --- | --- | --- |
| Provider | `chrome.storage.sync` | `perplexity` (direct) |
| Perplexity API key | `chrome.storage.sync` | _(empty — required for direct)_ |
| OpenRouter API key | `chrome.storage.sync` | _(empty — required for OpenRouter)_ |
| Model | `chrome.storage.sync` | `sonar` |
| Session context | `chrome.storage.sync` | _(empty)_ |
| Stats (verified / inaccurate / errors) | `chrome.storage.session` | `0` |

To debug, open Claude DevTools and run:

```js
localStorage.setItem('cfg:debug', '1')
```

The content script will start logging DOM detection / injection events.

---

## Roadmap

- Per-verdict "explain" toggle that shows the full Sonar JSON.
- Inline "differences from Claude" diff view alongside the correction.
- Optional auto-Verify on send (off by default — manual is the design goal).

---

## License

[MIT](LICENSE).
