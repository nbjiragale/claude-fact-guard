# Privacy Policy — Claude Fact Guard

**Last updated:** 2026-05-14

Claude Fact Guard is a Chrome extension that runs entirely in your browser.

## What data the extension handles

- **Claude AI assistant messages** displayed in the active `claude.ai`
  tab are read from the page DOM **only** when you click the Verify
  button in the side panel. Nothing is read automatically.
- When you click Verify, the latest assistant message — together with
  your saved session context (if any) and a strict fact-checking prompt —
  is sent over HTTPS, with **your** API key, to **one of**:
  - `https://api.perplexity.ai/chat/completions` (Perplexity direct), or
  - `https://openrouter.ai/api/v1/chat/completions` (OpenRouter, routed to
    a `perplexity/sonar*` model).
  Perplexity's and/or OpenRouter's terms of service govern that request.
- The Sonar verdict is parsed locally. If you click Paste or Paste &
  Send, the resulting correction is typed into your Claude composer.

## What data is stored

- Your provider choice, API key(s), chosen Sonar model, and saved
  session context are stored in `chrome.storage.sync` so they sync across
  your signed-in Chrome profiles. They are never transmitted anywhere
  other than the provider API endpoint you selected.
- Per-session counters (verifications, inaccurate, errors) and the last
  verdict are stored in `chrome.storage.session` and cleared when the
  browser closes.

## What data is NOT collected

- Claude Fact Guard does not run any analytics, tracking, or telemetry.
- The extension does not contact any server other than the provider API
  endpoint you configured (Perplexity or OpenRouter).
- No conversation history is persisted by the extension.
- The extension only operates on `https://claude.ai/*` and has no
  permissions to read other websites.

## Removing your data

Uninstalling the extension removes everything in `chrome.storage.sync`
and `chrome.storage.session` belonging to it, including your saved API
key and session counters.

## Contact

Issues and questions: <https://github.com/nbjiragale/claude-fact-guard/issues>
