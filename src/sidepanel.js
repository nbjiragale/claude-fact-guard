// Claude Fact Guard — side panel script
//
// Renders the clean Home view (Verify + result + stats) and a separate
// Settings view (provider, web/api config, session context). All API calls
// and storage live in the background service worker; the panel just
// dispatches messages.

const STATUS_LABELS = {
  idle: 'Idle',
  checking: 'Checking with Perplexity…',
  accurate: 'Accurate',
  inaccurate: 'Inaccurate — see correction below',
  error: 'Verification error',
};

const PROVIDER_KIND = {
  'perplexity-web': 'web',
  perplexity: 'api',
  openrouter: 'api',
};

const els = {
  versionLabel: document.getElementById('version-label'),
  tabWarning: document.getElementById('tab-warning'),

  // View / header switching
  homeView: document.getElementById('home-view'),
  settingsView: document.getElementById('settings-view'),
  homeHeader: document.getElementById('home-header'),
  settingsHeader: document.getElementById('settings-header'),
  openSettingsBtn: document.getElementById('open-settings-btn'),
  closeSettingsBtn: document.getElementById('close-settings-btn'),

  // Kebab menu (Home header)
  kebabBtn: document.getElementById('kebab-btn'),
  kebabMenu: document.getElementById('kebab-menu'),
  menuFreshThread: document.getElementById('menu-fresh-thread'),
  menuResetStats: document.getElementById('menu-reset-stats'),

  // Compact-mode toggle (Home header)
  compactToggle: document.getElementById('compact-toggle'),

  // Provider + web/api split (Settings view)
  webSettings: document.getElementById('web-settings'),
  apiSettings: document.getElementById('api-settings'),
  apiKey: document.getElementById('api-key'),
  apiKeyHint: document.getElementById('api-key-hint'),
  apiKeyLink: document.getElementById('api-key-link'),
  modelSelect: document.getElementById('model-select'),
  saveSettings: document.getElementById('save-settings'),

  // Web provider controls (Settings view)
  webStatusDot: document.getElementById('web-status-dot'),
  webStatusLabel: document.getElementById('web-status-label'),
  openPerplexityTab: document.getElementById('open-perplexity-tab'),
  webCustomInstructions: document.getElementById('web-custom-instructions'),
  resetWebInstructions: document.getElementById('reset-web-instructions'),
  resetThread: document.getElementById('reset-thread'),
  autoVerifyToggle: document.getElementById('auto-verify-toggle'),
  inlineHighlightsToggle: document.getElementById('inline-highlights-toggle'),

  // Session context (Settings view)
  contextInput: document.getElementById('context-input'),
  contextStatus: document.getElementById('context-status'),

  // Verify (Home view)
  verifyBtn: document.getElementById('verify-btn'),
  reverifyBtn: document.getElementById('reverify-btn'),
  statusDot: document.getElementById('status-dot'),
  statusLabel: document.getElementById('status-label'),
  statusError: document.getElementById('status-error'),
  cacheFlag: document.getElementById('cache-flag'),

  // Result (Home view)
  resultCard: document.getElementById('result-card'),
  verdictBadge: document.getElementById('verdict-badge'),
  verdictLabel: document.getElementById('verdict-label'),
  issuesBlock: document.getElementById('issues-block'),
  issuesList: document.getElementById('issues-list'),
  correctionBlock: document.getElementById('correction-block'),
  correctionText: document.getElementById('correction-text'),
  pasteCorrection: document.getElementById('paste-correction'),
  pasteSendCorrection: document.getElementById('paste-send-correction'),
  copyCorrection: document.getElementById('copy-correction'),
  citationsBlock: document.getElementById('citations-block'),
  citationsList: document.getElementById('citations-list'),

  // Stats (Home view, compact pills)
  statVerifications: document.getElementById('stat-verifications'),
  statInaccurate: document.getElementById('stat-inaccurate'),
  statErrors: document.getElementById('stat-errors'),
};

let state = {
  providers: null,
  settings: null,
  stats: null,
};

// ---------------------------------------------------------------------------
// View switching
// ---------------------------------------------------------------------------

function showView(name) {
  const isSettings = name === 'settings';
  els.homeView.hidden = isSettings;
  els.settingsView.hidden = !isSettings;
  els.homeHeader.hidden = isSettings;
  els.settingsHeader.hidden = !isSettings;
  if (isSettings) closeKebabMenu();
}

function openKebabMenu() {
  els.kebabMenu.hidden = false;
  els.kebabBtn.setAttribute('aria-expanded', 'true');
}

function closeKebabMenu() {
  els.kebabMenu.hidden = true;
  els.kebabBtn.setAttribute('aria-expanded', 'false');
}

document.addEventListener('click', (e) => {
  if (els.kebabMenu.hidden) return;
  if (e.target.closest('#kebab-menu') || e.target.closest('#kebab-btn')) return;
  closeKebabMenu();
});

// ---------------------------------------------------------------------------
// Messaging helpers
// ---------------------------------------------------------------------------

function sendBg(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(resp || { ok: false, error: 'No response from background.' });
      }
    });
  });
}

// URL patterns for every supported AI assistant tab. Adding a new host
// (e.g. Gemini) means: 1) update HOST_ADAPTERS in content.js, 2) update
// AI_TAB_URL_PATTERNS in background.js, 3) extend this regex below.
const AI_TAB_URL_REGEX = /^https:\/\/(claude\.ai|chatgpt\.com|chat\.openai\.com)\//;

async function getActiveAITab() {
  const tabs = await new Promise((resolve) =>
    chrome.tabs.query({ active: true, currentWindow: true }, (t) =>
      resolve(t || []),
    ),
  );
  const tab = tabs[0];
  if (!tab) return { ok: false, error: 'No active tab.' };
  if (!AI_TAB_URL_REGEX.test(tab.url || '')) {
    return {
      ok: false,
      error: 'The current tab is not Claude.ai or ChatGPT.com.',
    };
  }
  return { ok: true, tab };
}

// Chrome reports "Could not establish connection. Receiving end does
// not exist." when sendMessage targets a tab whose content script
// isn't loaded — typically because the AI chat tab existed BEFORE
// the extension was installed / reloaded. manifest.json content
// scripts don't retroactively attach to pre-existing tabs. When we
// see this error we inject src/content.js on-demand and retry once,
// which removes the "reload the tab" requirement entirely.
function isMissingReceiverError(msg) {
  if (!msg) return false;
  return /Receiving end does not exist|Could not establish connection/i.test(msg);
}

function rawSendTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          error:
            chrome.runtime.lastError.message ||
            'Cannot reach the AI assistant tab.',
        });
      } else {
        resolve(resp || { ok: false, error: 'No response from content script.' });
      }
    });
  });
}

async function injectAITabContentScript(tabId) {
  if (!chrome.scripting?.executeScript) {
    return { ok: false, error: 'chrome.scripting unavailable.' };
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/content.js'],
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

async function sendTab(tabId, message) {
  const first = await rawSendTab(tabId, message);
  if (first.ok || !isMissingReceiverError(first.error)) return first;
  const inject = await injectAITabContentScript(tabId);
  if (!inject.ok) {
    return {
      ok: false,
      error:
        `Cannot attach content script to this tab (${inject.error}). ` +
        'Reload the tab and try again.',
    };
  }
  // Give the freshly-injected listener a tick to register before retry.
  await new Promise((r) => setTimeout(r, 150));
  return rawSendTab(tabId, message);
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderProviderUI() {
  const { providers, settings } = state;
  const cfg = providers[settings.provider];
  const kind = PROVIDER_KIND[settings.provider] || 'api';

  document.querySelectorAll('input[name="provider"]').forEach((el) => {
    el.checked = el.value === settings.provider;
  });

  els.webSettings.hidden = kind !== 'web';
  els.apiSettings.hidden = kind === 'web';

  if (kind === 'web') {
    document.querySelectorAll('input[name="web-visible"]').forEach((el) => {
      el.checked = String(settings.webVisible) === el.value;
    });
    if (
      document.activeElement !== els.webCustomInstructions &&
      els.webCustomInstructions.value !== settings.webCustomInstructions
    ) {
      els.webCustomInstructions.value = settings.webCustomInstructions || '';
    }
    if (els.autoVerifyToggle) {
      els.autoVerifyToggle.checked = !!settings.autoVerify;
    }
    if (els.inlineHighlightsToggle) {
      // Default ON: if the value isn't a literal `false`, treat as on.
      els.inlineHighlightsToggle.checked = settings.inlineHighlights !== false;
    }
  } else {
    const stored =
      settings.provider === 'perplexity'
        ? settings.perplexityKey
        : settings.openrouterKey;
    els.apiKey.value = stored || '';
    els.apiKey.placeholder = stored ? 'API key saved' : cfg.keyHint;
    els.apiKeyLink.href = cfg.keyHelpUrl;
    els.apiKeyLink.textContent =
      settings.provider === 'perplexity'
        ? 'Perplexity API settings'
        : 'OpenRouter API keys';

    els.modelSelect.innerHTML = '';
    for (const m of cfg.models) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label;
      els.modelSelect.appendChild(opt);
    }
    els.modelSelect.value = settings.model;
  }
}

async function renderWebStatus() {
  if (state.settings?.provider !== 'perplexity-web') return;
  const resp = await sendBg({ type: 'PERPLEXITY_WEB_STATUS' });
  if (!resp.ok) {
    els.webStatusDot.className = 'status-dot';
    els.webStatusLabel.textContent = 'Status unavailable';
    return;
  }
  if (!resp.alive) {
    els.webStatusDot.className = 'status-dot';
    els.webStatusLabel.textContent = 'No Perplexity tab — will open on first Verify';
  } else if (resp.loggedIn === false) {
    els.webStatusDot.className = 'status-dot error';
    els.webStatusLabel.textContent = 'Tab open but signed out — sign in to Perplexity';
  } else {
    els.webStatusDot.className = 'status-dot accurate';
    els.webStatusLabel.textContent = resp.seeded
      ? 'Connected · thread active (context loaded)'
      : 'Connected · fresh thread';
  }
}

function renderContext() {
  const ctx = state.settings?.context || '';
  if (document.activeElement !== els.contextInput && els.contextInput.value !== ctx) {
    els.contextInput.value = ctx;
  }
}

function renderStats() {
  const s = state.stats || {};
  els.statVerifications.textContent = String(s.verifications || 0);
  els.statInaccurate.textContent = String(s.inaccurate || 0);
  els.statErrors.textContent = String(s.errors || 0);

  const status = s.lastStatus || 'idle';
  els.statusLabel.textContent = STATUS_LABELS[status] || STATUS_LABELS.idle;
  els.statusDot.className = 'status-dot';
  if (status !== 'idle') els.statusDot.classList.add(status);

  if (status === 'error' && s.lastError) {
    els.statusError.hidden = false;
    els.statusError.textContent = s.lastError;
  } else {
    els.statusError.hidden = true;
    els.statusError.textContent = '';
  }

  renderVerdict(s.lastVerdict);
  els.reverifyBtn.hidden = !s.lastVerdict;
}

function renderVerdict(verdict) {
  if (!verdict) {
    els.resultCard.hidden = true;
    return;
  }
  els.resultCard.hidden = false;

  if (verdict.accurate) {
    els.verdictBadge.textContent = 'Accurate';
    els.verdictBadge.className = 'verdict-badge accurate';
    els.verdictLabel.textContent = 'No factual issues detected.';
    els.issuesBlock.hidden = true;
    els.correctionBlock.hidden = true;
  } else {
    els.verdictBadge.textContent = 'Inaccurate';
    els.verdictBadge.className = 'verdict-badge inaccurate';
    els.verdictLabel.textContent = `${verdict.issues.length} issue${verdict.issues.length === 1 ? '' : 's'} found.`;

    if (verdict.issues.length) {
      els.issuesBlock.hidden = false;
      els.issuesList.innerHTML = '';
      for (const issue of verdict.issues) {
        const li = document.createElement('li');
        li.textContent = issue;
        els.issuesList.appendChild(li);
      }
    } else {
      els.issuesBlock.hidden = true;
    }

    if (verdict.correction) {
      els.correctionBlock.hidden = false;
      els.correctionText.textContent = verdict.correction;
    } else {
      els.correctionBlock.hidden = true;
    }
  }

  if (verdict.citations && verdict.citations.length) {
    els.citationsBlock.hidden = false;
    els.citationsList.innerHTML = '';
    for (const url of verdict.citations) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noreferrer noopener';
      a.textContent = url;
      li.appendChild(a);
      els.citationsList.appendChild(li);
    }
  } else {
    els.citationsBlock.hidden = true;
  }
}

// ---------------------------------------------------------------------------
// Header / view-switch handlers
// ---------------------------------------------------------------------------

els.openSettingsBtn.addEventListener('click', () => showView('settings'));
els.closeSettingsBtn.addEventListener('click', () => showView('home'));

els.kebabBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (els.kebabMenu.hidden) openKebabMenu();
  else closeKebabMenu();
});

els.menuFreshThread.addEventListener('click', async () => {
  closeKebabMenu();
  await sendBg({ type: 'RESET_PERPLEXITY_THREAD' });
  await refreshState();
  await renderWebStatus();
});

els.menuResetStats.addEventListener('click', async () => {
  closeKebabMenu();
  await sendBg({ type: 'RESET_STATS' });
  await refreshState();
});

// ---------------------------------------------------------------------------
// Settings handlers
// ---------------------------------------------------------------------------

document.querySelectorAll('input[name="provider"]').forEach((el) => {
  el.addEventListener('change', () => {
    if (!state.settings) return;
    state.settings.provider = el.value;
    const cfg = state.providers[el.value];
    if (!cfg.models.some((m) => m.id === state.settings.model)) {
      state.settings.model = cfg.defaultModel;
    }
    renderProviderUI();
    renderWebStatus();
  });
});

document.querySelectorAll('input[name="web-visible"]').forEach((el) => {
  el.addEventListener('change', () => {
    if (!state.settings) return;
    state.settings.webVisible = el.value === 'true';
  });
});

els.webCustomInstructions?.addEventListener('input', () => {
  if (!state.settings) return;
  state.settings.webCustomInstructions = els.webCustomInstructions.value;
});

els.resetWebInstructions?.addEventListener('click', async () => {
  await sendBg({
    type: 'SAVE_SETTINGS',
    webCustomInstructions: '',
  });
  await refreshState();
  flash(els.resetWebInstructions, 'Reset');
});

els.resetThread?.addEventListener('click', async () => {
  flash(els.resetThread, 'Resetting…', true);
  await sendBg({ type: 'RESET_PERPLEXITY_THREAD' });
  await refreshState();
  await renderWebStatus();
  flash(els.resetThread, 'Fresh thread ready');
});

els.openPerplexityTab?.addEventListener('click', async () => {
  await sendBg({ type: 'OPEN_PERPLEXITY_TAB' });
  await renderWebStatus();
});

els.modelSelect.addEventListener('change', () => {
  state.settings.model = els.modelSelect.value;
});

els.apiKey.addEventListener('input', () => {
  if (!state.settings) return;
  const key = els.apiKey.value;
  if (state.settings.provider === 'perplexity') {
    state.settings.perplexityKey = key;
  } else if (state.settings.provider === 'openrouter') {
    state.settings.openrouterKey = key;
  }
});

els.contextInput.addEventListener('input', () => {
  if (!state.settings) return;
  state.settings.context = els.contextInput.value;
});

els.autoVerifyToggle?.addEventListener('change', async () => {
  if (!state.settings) return;
  const next = els.autoVerifyToggle.checked;
  state.settings.autoVerify = next;
  // Persist immediately so the content script picks up the change without
  // requiring the user to click "Save settings".
  await sendBg({ type: 'SAVE_SETTINGS', autoVerify: next });
});

els.inlineHighlightsToggle?.addEventListener('change', async () => {
  if (!state.settings) return;
  const next = els.inlineHighlightsToggle.checked;
  state.settings.inlineHighlights = next;
  await sendBg({ type: 'SAVE_SETTINGS', inlineHighlights: next });
  // If user turned the feature off, ask the active AI tab's content script
  // to tear down any highlights currently rendered.
  if (!next) {
    const aiTab = await getActiveAITab();
    if (aiTab.ok) {
      await sendTab(aiTab.tab.id, { type: 'CLEAR_HIGHLIGHTS' });
    }
  }
});

els.saveSettings.addEventListener('click', async () => {
  flash(els.saveSettings, 'Saving…', true);
  const [settingsResp, contextResp] = await Promise.all([
    sendBg({
      type: 'SAVE_SETTINGS',
      provider: state.settings.provider,
      perplexityKey: state.settings.perplexityKey,
      openrouterKey: state.settings.openrouterKey,
      model: state.settings.model,
      webVisible: state.settings.webVisible,
      webCustomInstructions: state.settings.webCustomInstructions,
      autoVerify: !!state.settings.autoVerify,
      inlineHighlights: state.settings.inlineHighlights !== false,
    }),
    sendBg({
      type: 'SET_CONTEXT',
      text: els.contextInput.value,
    }),
  ]);
  if (settingsResp.ok && contextResp.ok) {
    await refreshState();
    await renderWebStatus();
    flash(els.saveSettings, 'Saved');
    els.contextStatus.textContent =
      (els.contextInput.value || '').trim()
        ? `Context saved (${(els.contextInput.value || '').trim().length} chars).`
        : '';
  } else {
    flash(els.saveSettings, 'Failed');
    els.contextStatus.textContent =
      settingsResp.error || contextResp.error || 'Failed to save settings.';
  }
});

// ---------------------------------------------------------------------------
// Verify + correction handlers
// ---------------------------------------------------------------------------

async function runVerify({ force }) {
  els.statusError.hidden = true;
  els.statusError.textContent = '';
  els.cacheFlag.hidden = true;
  els.verifyBtn.disabled = true;
  els.reverifyBtn.disabled = true;
  els.statusDot.className = 'status-dot checking';
  els.statusLabel.textContent = STATUS_LABELS.checking;

  try {
    const tabResp = await getActiveAITab();
    if (!tabResp.ok) {
      els.statusDot.className = 'status-dot error';
      els.statusLabel.textContent = STATUS_LABELS.error;
      els.statusError.hidden = false;
      els.statusError.textContent = tabResp.error;
      return;
    }

    const latest = await sendTab(tabResp.tab.id, { type: 'GET_LATEST_RESPONSE' });
    if (!latest.ok || !latest.text) {
      els.statusDot.className = 'status-dot error';
      els.statusLabel.textContent = STATUS_LABELS.error;
      els.statusError.hidden = false;
      els.statusError.textContent = latest.error || 'Could not read the assistant response.';
      return;
    }

    const verifyResp = await sendBg({
      type: 'VERIFY',
      text: latest.text,
      force: !!force,
    });
    if (!verifyResp.ok) {
      els.statusError.hidden = false;
      els.statusError.textContent = verifyResp.error || 'Verification failed.';
    } else if (verifyResp.fromCache) {
      els.cacheFlag.hidden = false;
    }
    await refreshState();
    await renderWebStatus();
  } finally {
    els.verifyBtn.disabled = false;
    els.reverifyBtn.disabled = false;
  }
}

els.verifyBtn.addEventListener('click', () => runVerify({ force: false }));
els.reverifyBtn.addEventListener('click', () => runVerify({ force: true }));

async function injectCorrection(send) {
  const text = (els.correctionText.textContent || '').trim();
  if (!text) return;
  const tabResp = await getActiveAITab();
  if (!tabResp.ok) {
    els.statusError.hidden = false;
    els.statusError.textContent = tabResp.error;
    return;
  }
  const resp = await sendTab(tabResp.tab.id, {
    type: 'INJECT_TEXT',
    text,
    send,
  });
  if (!resp.ok) {
    els.statusError.hidden = false;
    els.statusError.textContent = resp.error || 'Injection failed.';
  }
}

els.pasteCorrection.addEventListener('click', () => injectCorrection(false));
els.pasteSendCorrection.addEventListener('click', () => injectCorrection(true));

els.copyCorrection.addEventListener('click', async () => {
  const text = (els.correctionText.textContent || '').trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    flash(els.copyCorrection, 'Copied');
  } catch (_) {
    flash(els.copyCorrection, 'Failed');
  }
});

// ---------------------------------------------------------------------------
// Live updates
// ---------------------------------------------------------------------------

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'session') refreshState();
});

chrome.tabs?.onActivated.addListener(() => updateTabWarning());
chrome.tabs?.onUpdated.addListener((_id, info) => {
  if (info.url || info.status === 'complete') updateTabWarning();
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

function flash(btn, text, keepDisabled = false) {
  const original = btn.dataset.original || btn.textContent;
  btn.dataset.original = original;
  btn.textContent = text;
  btn.disabled = true;
  if (keepDisabled) return;
  setTimeout(() => {
    btn.textContent = original;
    btn.disabled = false;
  }, 1100);
}

async function refreshState() {
  const resp = await sendBg({ type: 'GET_STATE' });
  if (!resp.ok) return;
  state = {
    providers: resp.providers,
    settings: resp.settings,
    stats: resp.stats,
  };
  renderProviderUI();
  renderContext();
  renderStats();
}

let webStatusTimer = null;
function startWebStatusPolling() {
  if (webStatusTimer) return;
  webStatusTimer = setInterval(() => {
    if (state.settings?.provider === 'perplexity-web') {
      renderWebStatus();
    }
  }, 5000);
}

async function updateTabWarning() {
  const tabResp = await getActiveAITab();
  els.tabWarning.hidden = tabResp.ok;
}

startWebStatusPolling();

// ---------------------------------------------------------------------------
// Collapsible side panel: compact mode + per-section <details> persistence
//
// State lives in chrome.storage.session so it survives the user closing /
// re-opening the side panel within the same browser session but resets on
// Chrome restart — which feels right for a transient UI preference. We use
// session (not sync) so multiple devices don't fight over the panel layout.
// ---------------------------------------------------------------------------

const PANEL_LAYOUT_KEY = 'panelLayout';
const DEFAULT_PANEL_LAYOUT = {
  compact: false,
  // Each key matches a [data-key] on a .collapsible <details> element.
  sections: { issues: true, correction: true, citations: true },
};

let panelLayout = { ...DEFAULT_PANEL_LAYOUT };

function applyCompactMode(on) {
  document.body.classList.toggle('compact', !!on);
  if (els.compactToggle) {
    els.compactToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
    const label = on ? 'Expand panel' : 'Collapse panel';
    els.compactToggle.setAttribute('aria-label', label);
    els.compactToggle.setAttribute('title', label);
  }
}

function applySectionOpenState() {
  const detailsEls = document.querySelectorAll('details.collapsible[data-key]');
  detailsEls.forEach((d) => {
    const key = d.getAttribute('data-key');
    if (!key) return;
    const open = panelLayout.sections?.[key];
    // `open` undefined → fall back to the default (true) so first-run users
    // see contents expanded; explicit `false` collapses, `true` opens.
    if (open === false) d.removeAttribute('open');
    else d.setAttribute('open', '');
  });
}

function persistPanelLayout() {
  try {
    chrome.storage.session.set({ [PANEL_LAYOUT_KEY]: panelLayout });
  } catch (_) {
    /* session storage may be unavailable in old Chrome; ignore */
  }
}

async function loadPanelLayout() {
  return new Promise((resolve) => {
    try {
      chrome.storage.session.get([PANEL_LAYOUT_KEY], (data) => {
        const saved = data && data[PANEL_LAYOUT_KEY];
        if (saved && typeof saved === 'object') {
          panelLayout = {
            compact: !!saved.compact,
            sections: {
              ...DEFAULT_PANEL_LAYOUT.sections,
              ...(saved.sections || {}),
            },
          };
        }
        resolve();
      });
    } catch (_) {
      resolve();
    }
  });
}

function wireCollapsibleHandlers() {
  els.compactToggle?.addEventListener('click', () => {
    panelLayout.compact = !panelLayout.compact;
    applyCompactMode(panelLayout.compact);
    persistPanelLayout();
  });

  // Listen for native <details> toggle events to persist open/closed state.
  document
    .querySelectorAll('details.collapsible[data-key]')
    .forEach((d) => {
      d.addEventListener('toggle', () => {
        const key = d.getAttribute('data-key');
        if (!key) return;
        panelLayout.sections = panelLayout.sections || {};
        panelLayout.sections[key] = d.open;
        persistPanelLayout();
      });
    });
}

(async function init() {
  const manifest = chrome.runtime.getManifest();
  els.versionLabel.textContent = `v${manifest.version}`;
  await loadPanelLayout();
  applyCompactMode(panelLayout.compact);
  applySectionOpenState();
  wireCollapsibleHandlers();
  await refreshState();
  updateTabWarning();
})();
