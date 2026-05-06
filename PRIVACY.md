# Privacy Policy — Claude Fact Guard

**Last updated:** 2026-05-05

Claude Fact Guard is a Chrome extension that runs entirely in your browser.

## What data the extension handles

- **Claude AI assistant messages** displayed in the active `claude.ai` tab
  are read from the page DOM after they finish streaming.
- A message is **only** sent off-device if it passes a regex pre-filter
  designed to detect verifiable factual claims (years, version numbers,
  attributions, statistics).
- When a message qualifies, it is sent — together with a fact-checking
  prompt — to **Google Gemini 2.0 Flash** at
  `https://generativelanguage.googleapis.com` using **your** Gemini API key.
  Google's terms of service govern that request.
- The Gemini verdict is parsed locally; if Gemini reports inaccuracies,
  the resulting correction prompt is typed back into your Claude composer.

## What data is stored

- Your Gemini API key is stored in `chrome.storage.sync` so it can sync
  across your signed-in Chrome profiles. It is never transmitted anywhere
  other than the Gemini API endpoint.
- Per-session counters (verifications, corrections, errors) and the last
  verification status are stored in `chrome.storage.session` and cleared
  when the browser closes.

## What data is NOT collected

- Claude Fact Guard does not run any analytics, tracking, or telemetry.
- The extension does not contact any server other than the Gemini API.
- No conversation history is persisted by the extension.
- The extension only operates on `https://claude.ai/*` and has no
  permissions to read other websites.

## Removing your data

Uninstalling the extension removes everything in `chrome.storage.sync`
and `chrome.storage.session` belonging to it, including your saved API
key and session counters.

## Contact

Issues and questions: <https://github.com/nbjiragale/claude-fact-guard/issues>
