// Claude Fact Guard — side panel script
//
// Renders settings, the Set Context flow, the Verify button, and the
// fact-check verdict. All API calls and storage live in the background
// service worker; the panel just dispatches messages.

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

  // Settings
  settingsCard: document.getElementById('settings-card'),
  settingsSummary: document.getElementById('settings-summary'),
  webSettings: document.getElementById('web-settings'),
  apiSettings: document.getElementById('api-settings'),
  apiKey: document.getElementById('api-key'),
  apiKeyHint: document.getElementById('api-key-hint'),
  apiKeyLink: document.getElementById('api-key-link'),
  modelSelect: document.getElementById('model-select'),
  saveSettings: document.getElementById('save-settings'),

  // Web provider
  webStatusDot: document.getElementById('web-status-dot'),
  webStatusLabel: document.getElementById('web-status-label'),
  openPerplexityTab: document.getElementById('open-perplexity-tab'),
  webCustomInstructions: document.getElementById('web-custom-instructions'),
  resetWebInstructions: document.getElementById('reset-web-instructions'),
  resetThread: document.getElementById('reset-thread'),

  // Context
  contextCard: document.getElementById('context-card'),
  contextSummary: document.getElementById('context-summary'),
  contextInput: document.getElementById('context-input'),
  saveContext: document.getElementById('save-context'),
  pasteContext: document.getElementById('paste-context'),
  pasteSendContext: document.getElementById('paste-send-context'),
  contextStatus: document.getElementById('context-status'),

  // Verify
  verifyBtn: document.getElementById('verify-btn'),
  reverifyBtn: document.getElementById('reverify-btn'),
  statusDot: document.getElementById('status-dot'),
  statusLabel: document.getElementById('status-label'),
  statusError: document.getElementById('status-error'),
  cacheFlag: document.getElementById('cache-flag'),

  // Result
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

  // Stats
  statVerifications: document.getElementById('stat-verifications'),
  statInaccurate: document.getElementById('stat-inaccurate'),
  statErrors: document.getElementById('stat-errors'),
  resetStats: document.getElementById('reset-stats'),
};

let state = {
  providers: null,
  settings: null,
  stats: null,
};

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

async function getActiveClaudeTab() {
  const tabs = await new Promise((resolve) =>
    chrome.tabs.query({ active: true, currentWindow: true }, (t) =>
      resolve(t || []),
    ),
  );
  const tab = tabs[0];
  if (!tab) return { ok: false, error: 'No active tab.' };
  if (!/^https:\/\/claude\.ai\//.test(tab.url || '')) {
    return { ok: false, error: 'The current tab is not claude.ai.' };
  }
  return { ok: true, tab };
}

function sendTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          error:
            chrome.runtime.lastError.message ||
            'Cannot reach the claude.ai tab.',
        });
      } else {
        resolve(resp || { ok: false, error: 'No response from content script.' });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderProviderUI() {
  const { providers, settings } = state;
  const cfg = providers[settings.provider];
  const kind = PROVIDER_KIND[settings.provider] || 'api';

  // Radio buttons
  document.querySelectorAll('input[name="provider"]').forEach((el) => {
    el.checked = el.value === settings.provider;
  });

  // Show / hide web vs api sub-sections
  els.webSettings.hidden = kind !== 'web';
  els.apiSettings.hidden = kind === 'web';

  if (kind === 'web') {
    // Web settings
    document.querySelectorAll('input[name="web-visible"]').forEach((el) => {
      el.checked = String(settings.webVisible) === el.value;
    });
    if (
      document.activeElement !== els.webCustomInstructions &&
      els.webCustomInstructions.value !== settings.webCustomInstructions
    ) {
      els.webCustomInstructions.value = settings.webCustomInstructions || '';
    }
    els.settingsSummary.textContent = `${cfg.label} · ${settings.webVisible ? 'visible' : 'hidden'} tab`;
  } else {
    // API settings
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

    const hasKey = !!stored;
    els.settingsSummary.textContent = `${cfg.label} · ${settings.model} · ${hasKey ? 'key saved' : 'no key'}`;
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

function renderContextUI() {
  const ctx = state.settings.context || '';
  els.contextInput.value = ctx;
  const trimmed = ctx.trim();
  els.contextSummary.textContent = trimmed
    ? `${trimmed.length} chars saved`
    : 'Empty — optional but recommended';
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
  // Re-verify button is only visible when we have a verdict to re-verify.
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
// Event handlers
// ---------------------------------------------------------------------------

document.querySelectorAll('input[name="provider"]').forEach((el) => {
  el.addEventListener('change', () => {
    if (!state.settings) return;
    state.settings.provider = el.value;
    // Reset model to provider default if current model isn't valid here.
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
  // Send empty string — background resolves it to the built-in default.
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
  // Ignore inputs while on the web provider (the field is hidden).
});

els.saveSettings.addEventListener('click', async () => {
  flash(els.saveSettings, 'Saving…', true);
  const resp = await sendBg({
    type: 'SAVE_SETTINGS',
    provider: state.settings.provider,
    perplexityKey: state.settings.perplexityKey,
    openrouterKey: state.settings.openrouterKey,
    model: state.settings.model,
    webVisible: state.settings.webVisible,
    webCustomInstructions: state.settings.webCustomInstructions,
  });
  if (resp.ok) {
    await refreshState();
    await renderWebStatus();
    flash(els.saveSettings, 'Saved');
  } else {
    flash(els.saveSettings, 'Failed');
  }
});

els.saveContext.addEventListener('click', async () => {
  flash(els.saveContext, 'Saving…', true);
  const resp = await sendBg({
    type: 'SET_CONTEXT',
    text: els.contextInput.value,
  });
  if (resp.ok) {
    await refreshState();
    flash(els.saveContext, 'Saved');
    els.contextStatus.textContent = 'Context saved. It will be prepended to every Verify call.';
  } else {
    flash(els.saveContext, 'Failed');
    els.contextStatus.textContent = resp.error || 'Failed to save context.';
  }
});

async function pasteContextHelper(send) {
  const text = els.contextInput.value.trim();
  if (!text) {
    els.contextStatus.textContent = 'Type some context first.';
    return;
  }
  // Save first so it's persisted regardless of paste result.
  await sendBg({ type: 'SET_CONTEXT', text });
  await refreshState();

  const tabResp = await getActiveClaudeTab();
  if (!tabResp.ok) {
    els.contextStatus.textContent = tabResp.error;
    return;
  }
  const wrapped = `For our entire chat, use this context. ${text}`;
  const out = await sendTab(tabResp.tab.id, {
    type: 'INJECT_TEXT',
    text: wrapped,
    send,
  });
  if (!out.ok) {
    els.contextStatus.textContent = out.error || 'Injection failed.';
  } else {
    els.contextStatus.textContent = send
      ? 'Context sent to Claude.'
      : 'Context pasted into Claude composer.';
  }
}

els.pasteContext.addEventListener('click', () => pasteContextHelper(false));
els.pasteSendContext.addEventListener('click', () => pasteContextHelper(true));

async function runVerify({ force }) {
  els.statusError.hidden = true;
  els.statusError.textContent = '';
  els.cacheFlag.hidden = true;
  els.verifyBtn.disabled = true;
  els.reverifyBtn.disabled = true;
  els.statusDot.className = 'status-dot checking';
  els.statusLabel.textContent = STATUS_LABELS.checking;

  try {
    const tabResp = await getActiveClaudeTab();
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
      els.statusError.textContent = latest.error || 'Could not read Claude response.';
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
    // The background already wrote stats + verdict to session storage, which
    // the storage listener picks up to refresh the UI.
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
  const tabResp = await getActiveClaudeTab();
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

els.resetStats.addEventListener('click', async () => {
  await sendBg({ type: 'RESET_STATS' });
  await refreshState();
});

// Live updates: any storage.session change re-fetches state.
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'session') refreshState();
});

// Update tab warning when the user switches tabs.
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
  renderContextUI();
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
  const tabResp = await getActiveClaudeTab();
  els.tabWarning.hidden = tabResp.ok;
}

startWebStatusPolling();

(async function init() {
  const manifest = chrome.runtime.getManifest();
  els.versionLabel.textContent = `v${manifest.version}`;
  await refreshState();
  updateTabWarning();
})();
