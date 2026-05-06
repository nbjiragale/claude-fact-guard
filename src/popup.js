// Claude Fact Guard — popup script

const STORAGE_KEYS = {
  apiKey: 'geminiKey',
  enabled: 'enabled',
};

const STATUS_LABELS = {
  idle: '— Not checked',
  checking: '… Checking with Gemini',
  accurate: '✓ Accurate',
  corrected: '⚠ Corrected',
  skipped: '— Skipped (no factual signals)',
  busy: '… Composer busy — skipped injection',
  error: '⚠ Verification error',
  'no-key': '⚠ Gemini API key missing',
};

const els = {
  enabledToggle: document.getElementById('enabled-toggle'),
  apiKeyInput: document.getElementById('api-key'),
  saveKeyBtn: document.getElementById('save-key'),
  statusDot: document.getElementById('status-dot'),
  statusLabel: document.getElementById('status-label'),
  statusError: document.getElementById('status-error'),
  resetStatsBtn: document.getElementById('reset-stats'),
  statVerifications: document.getElementById('stat-verifications'),
  statCorrections: document.getElementById('stat-corrections'),
  statSkipped: document.getElementById('stat-skipped'),
  statErrors: document.getElementById('stat-errors'),
  versionLabel: document.getElementById('version-label'),
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function getSync(keys) {
  return new Promise((resolve) =>
    chrome.storage.sync.get(keys, (r) => resolve(r || {})),
  );
}

function setSync(values) {
  return new Promise((resolve) =>
    chrome.storage.sync.set(values, () => resolve()),
  );
}

async function loadSettings() {
  const data = await getSync([STORAGE_KEYS.apiKey, STORAGE_KEYS.enabled]);
  els.enabledToggle.checked = data[STORAGE_KEYS.enabled] !== false;
  if (data[STORAGE_KEYS.apiKey]) {
    els.apiKeyInput.value = data[STORAGE_KEYS.apiKey];
    els.apiKeyInput.placeholder = 'API key saved';
  }
}

els.enabledToggle.addEventListener('change', async () => {
  await setSync({ [STORAGE_KEYS.enabled]: els.enabledToggle.checked });
});

els.saveKeyBtn.addEventListener('click', async () => {
  const key = els.apiKeyInput.value.trim();
  if (!key) {
    flashButton(els.saveKeyBtn, 'Enter a key');
    return;
  }
  await setSync({ [STORAGE_KEYS.apiKey]: key });
  flashButton(els.saveKeyBtn, 'Saved');
  await refreshStats();
});

function flashButton(btn, text) {
  const original = btn.textContent;
  btn.textContent = text;
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = original;
    btn.disabled = false;
  }, 1100);
}

// ---------------------------------------------------------------------------
// Status / stats
// ---------------------------------------------------------------------------

function applyStatus(stats) {
  const status = stats?.lastStatus || 'idle';
  const label = STATUS_LABELS[status] || STATUS_LABELS.idle;
  els.statusLabel.textContent = label;

  els.statusDot.className = 'status-dot';
  if (
    status === 'accurate' ||
    status === 'corrected' ||
    status === 'error' ||
    status === 'no-key' ||
    status === 'checking'
  ) {
    els.statusDot.classList.add(status);
  }

  if (status === 'error' && stats?.lastError) {
    els.statusError.hidden = false;
    els.statusError.textContent = stats.lastError;
  } else {
    els.statusError.hidden = true;
    els.statusError.textContent = '';
  }

  els.statVerifications.textContent = String(stats?.verifications || 0);
  els.statCorrections.textContent = String(stats?.corrections || 0);
  els.statSkipped.textContent = String(stats?.skipped || 0);
  els.statErrors.textContent = String(stats?.errors || 0);
}

function getStats() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_STATS' }, (resp) => {
      resolve(resp?.stats || null);
    });
  });
}

async function refreshStats() {
  const stats = await getStats();
  if (stats) applyStatus(stats);
}

els.resetStatsBtn.addEventListener('click', async () => {
  await new Promise((resolve) =>
    chrome.runtime.sendMessage({ type: 'RESET_STATS' }, () => resolve()),
  );
  await refreshStats();
});

// Live updates while the popup is open: poll storage.session.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.stats) {
    applyStatus(changes.stats.newValue);
  }
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

(async function init() {
  const manifest = chrome.runtime.getManifest();
  els.versionLabel.textContent = `v${manifest.version}`;
  await loadSettings();
  await refreshStats();
})();
