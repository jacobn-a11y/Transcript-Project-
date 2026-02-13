/* global state */
let currentStep = 1;
let allAccounts = [];
let selectedAccountIds = new Set();
let currentSessionId = null;
let mergeResult = null;
let customProviders = [];
let pollingInterval = null;
let toastStack = 0;

const API = '';

/* ============= Navigation ============= */

function goToStep(step) {
  // Validate before advancing
  if (step === 2 && currentStep === 1) {
    const providers = getEnabledProviders();
    if (providers.length === 0) {
      toast('Enable at least one provider', 'error');
      return;
    }
    // Save config and fetch accounts
    saveConfig().then(() => fetchAccounts());
  }

  if (step === 3 && currentStep === 2) {
    if (selectedAccountIds.size === 0) {
      toast('Select at least one account', 'error');
      return;
    }
    // Pre-fill project name from first selected account
    const first = allAccounts.find(a => selectedAccountIds.has(a.id + '|' + a.source));
    if (first) {
      document.getElementById('projectName').value =
        document.getElementById('projectName').value || `${first.name} — Call History`;
    }
  }

  currentStep = step;

  for (let i = 1; i <= 5; i++) {
    document.getElementById(`step-${i}`).classList.toggle('hidden', i !== step);
  }

  document.querySelectorAll('.steps .step').forEach(el => {
    const s = parseInt(el.dataset.step);
    el.classList.toggle('done', s < step);
    el.classList.toggle('active', s === step);
  });
}

/* ============= Provider Config ============= */

document.getElementById('gong-enabled').addEventListener('change', (e) => {
  document.getElementById('gong-config').classList.toggle('hidden', !e.target.checked);
});
document.getElementById('grain-enabled').addEventListener('change', (e) => {
  document.getElementById('grain-config').classList.toggle('hidden', !e.target.checked);
});

function getEnabledProviders() {
  const providers = [];
  if (document.getElementById('gong-enabled').checked) providers.push('gong');
  if (document.getElementById('grain-enabled').checked) providers.push('grain');
  for (const cp of customProviders) providers.push(`custom:${cp.providerName}`);
  return providers;
}

async function saveConfig() {
  const config = {
    primarySchema: document.getElementById('primarySchema').value,
    providers: {},
  };

  if (document.getElementById('gong-enabled').checked) {
    config.providers.gong = {
      accessKey: document.getElementById('gong-accessKey').value,
      accessKeySecret: document.getElementById('gong-accessKeySecret').value,
      baseUrl: document.getElementById('gong-baseUrl').value,
    };
  }

  if (document.getElementById('grain-enabled').checked) {
    config.providers.grain = {
      apiKey: document.getElementById('grain-apiKey').value,
      baseUrl: document.getElementById('grain-baseUrl').value,
    };
  }

  for (const cp of customProviders) {
    config.providers[`custom:${cp.providerName}`] = cp;
  }

  const resp = await fetch(`${API}/api/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });

  if (!resp.ok) {
    toast('Failed to save config', 'error');
    throw new Error('Config save failed');
  }
}

async function testConnection(provider) {
  const statusEl = document.getElementById(`${provider}-status`);
  statusEl.textContent = 'Testing...';
  statusEl.style.color = 'var(--text-muted)';

  try {
    await saveConfig();
    const resp = await fetch(`${API}/api/test/${provider}`);
    const data = await resp.json();

    if (data.success) {
      statusEl.textContent = data.message;
      statusEl.style.color = 'var(--success)';
    } else {
      statusEl.textContent = data.message || 'Connection failed';
      statusEl.style.color = 'var(--danger)';
    }
  } catch (e) {
    statusEl.textContent = `Error: ${e.message}`;
    statusEl.style.color = 'var(--danger)';
  }
}

/* ============= Accounts ============= */

async function fetchAccounts() {
  const listEl = document.getElementById('account-list');
  listEl.innerHTML = '<div class="progress-text" style="padding:20px;text-align:center;">Loading accounts from all providers...</div>';

  try {
    const resp = await fetch(`${API}/api/accounts`);
    if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
    const data = await resp.json();
    allAccounts = data.accounts || [];
    renderAccounts(allAccounts);
  } catch (e) {
    listEl.innerHTML = `<div class="progress-text" style="padding:20px;text-align:center;color:var(--danger);">Error loading accounts: ${escapeHtml(e.message)}</div>`;
  }
}

function renderAccounts(accounts) {
  const listEl = document.getElementById('account-list');

  if (accounts.length === 0) {
    listEl.innerHTML = '<div class="progress-text" style="padding:20px;text-align:center;">No accounts found.</div>';
    return;
  }

  // Sort alphabetically
  const sorted = [...accounts].sort((a, b) => a.name.localeCompare(b.name));

  listEl.innerHTML = sorted.map(acc => {
    const key = acc.id + '|' + acc.source;
    const checked = selectedAccountIds.has(key) ? 'checked' : '';
    const badgeClass = acc.source.toLowerCase().includes('gong') ? 'badge-gong' :
      acc.source.toLowerCase().includes('grain') ? 'badge-grain' : 'badge-custom';
    return `
      <label class="account-item">
        <input type="checkbox" ${checked} onchange="toggleAccount('${escapeAttr(key)}')">
        <span>${escapeHtml(acc.name)}</span>
        <span class="source-badge ${badgeClass}">${escapeHtml(acc.source)}</span>
      </label>
    `;
  }).join('');
}

function toggleAccount(key) {
  if (selectedAccountIds.has(key)) {
    selectedAccountIds.delete(key);
  } else {
    selectedAccountIds.add(key);
  }
}

function filterAccounts() {
  const query = document.getElementById('account-search').value.toLowerCase();
  const filtered = allAccounts.filter(a =>
    a.name.toLowerCase().includes(query) || a.source.toLowerCase().includes(query)
  );
  renderAccounts(filtered);
}

/* ============= Merge Process ============= */

async function startMerge() {
  const projectName = document.getElementById('projectName').value || 'Call Transcripts';

  const selectedAccounts = allAccounts.filter(a =>
    selectedAccountIds.has(a.id + '|' + a.source)
  );

  try {
    const resp = await fetch(`${API}/api/merge/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectName,
        selectedAccounts,
        primarySchema: document.getElementById('primarySchema').value,
      }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: `Server returned ${resp.status}` }));
      throw new Error(err.error || 'Failed to start merge');
    }
    const data = await resp.json();
    currentSessionId = data.sessionId;

    goToStep(4);
    startPolling();
  } catch (e) {
    toast(`Failed to start: ${e.message}`, 'error');
  }
}

function startPolling() {
  if (pollingInterval) clearInterval(pollingInterval);
  pollingInterval = setInterval(pollProgress, 1500);

  // Pause polling when tab is hidden, resume when visible
  document.addEventListener('visibilitychange', handleVisibility);
}

function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
  document.removeEventListener('visibilitychange', handleVisibility);
}

function handleVisibility() {
  if (document.hidden) {
    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }
  } else {
    if (!pollingInterval && currentSessionId) {
      pollProgress(); // Immediate poll on return
      pollingInterval = setInterval(pollProgress, 1500);
    }
  }
}

async function pollProgress() {
  if (!currentSessionId) return;

  try {
    const resp = await fetch(`${API}/api/merge/progress/${currentSessionId}`);
    if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
    const data = await resp.json();

    updateProgressUI(data);

    if (data.status === 'completed') {
      stopPolling();
      mergeResult = data.result;
      goToStep(5);
      showCompleteStats(data);
    } else if (data.status === 'paused') {
      stopPolling();
    } else if (data.status === 'error') {
      stopPolling();
      toast(data.error || 'An error occurred', 'error');
    }
  } catch (e) {
    // Network error during polling — don't crash, just skip this tick
  }
}

function updateProgressUI(data) {
  const phase = data.progress.phase;
  let pct = 0;
  let progressText = '';

  if (phase === 'fetching_calls') {
    // Phase 1: scanning calls — totalCalls isn't known yet
    const pages = data.progress.pagesScanned || 0;
    const found = data.progress.callsFoundSoFar || 0;
    progressText = pages > 0
      ? `Scanning Gong calls (page ${pages}, ${found} matches found)...`
      : 'Starting call scan...';
  } else if (data.progress.totalCalls > 0) {
    pct = Math.round((data.progress.completedCalls / data.progress.totalCalls) * 100);
    progressText = `${phase}: ${data.progress.completedCalls} / ${data.progress.totalCalls} calls processed (${pct}%)`;
  } else if (phase === 'generating') {
    pct = 95;
    progressText = 'Generating merged document...';
  } else if (phase === 'done') {
    pct = 100;
    progressText = 'Complete!';
  } else {
    progressText = `${phase}: preparing...`;
  }

  document.getElementById('merge-progress-fill').style.width = `${pct}%`;
  document.getElementById('merge-progress-text').textContent = progressText;

  const statusEl = document.getElementById('merge-status');
  statusEl.textContent = data.status;
  statusEl.className = `status-badge status-${data.status}`;

  // Update pause/resume buttons
  document.getElementById('btn-pause').classList.toggle('hidden', data.status !== 'active');
  document.getElementById('btn-resume').classList.toggle('hidden', data.status !== 'paused');

  // Update log
  if (data.logs && data.logs.length > 0) {
    const logEl = document.getElementById('merge-log');
    logEl.innerHTML = data.logs.map(l =>
      `<div class="entry ${l.level || ''}">[${l.time || ''}] ${escapeHtml(l.message)}</div>`
    ).join('');
    logEl.scrollTop = logEl.scrollHeight;
  }
}

async function pauseMerge() {
  if (!currentSessionId) return;
  try {
    await fetch(`${API}/api/merge/pause/${currentSessionId}`, { method: 'POST' });
    stopPolling();
    toast('Session paused. You can resume later.', 'warning');
    pollProgress(); // One final poll to update UI
  } catch (e) {
    toast(`Failed to pause: ${e.message}`, 'error');
  }
}

async function resumeMerge() {
  if (!currentSessionId) return;
  try {
    await fetch(`${API}/api/merge/resume/${currentSessionId}`, { method: 'POST' });
    startPolling();
    toast('Resuming...', 'success');
  } catch (e) {
    toast(`Failed to resume: ${e.message}`, 'error');
  }
}

function saveCurrentSession() {
  // Session state is automatically saved to disk on every progress update.
  // This button simply confirms to the user that their session is persisted.
  toast(`Session auto-saved: ${currentSessionId}. You can close and resume later.`, 'success');
}

function showCompleteStats(data) {
  const stats = document.getElementById('complete-stats');
  const r = data.result || {};
  stats.innerHTML = `
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
      <div class="card" style="text-align:center;">
        <div style="font-size:28px; font-weight:700; color:var(--primary);">${r.wordCount || 0}</div>
        <div style="font-size:13px; color:var(--text-muted);">Words</div>
      </div>
      <div class="card" style="text-align:center;">
        <div style="font-size:28px; font-weight:700; color:var(--primary);">${r.callCount || 0}</div>
        <div style="font-size:13px; color:var(--text-muted);">Calls Merged</div>
      </div>
    </div>
  `;
  document.getElementById('complete-message').textContent =
    `Your merged transcript "${r.fileName || 'output.md'}" has been saved to your Downloads folder.`;
}

async function downloadMarkdown() {
  if (!currentSessionId) return;
  window.location.href = `${API}/api/merge/download/${currentSessionId}`;
}

/* ============= Sessions ============= */

async function showSessions() {
  document.getElementById('sessions-modal').classList.remove('hidden');
  document.getElementById('sessions-overlay').classList.remove('hidden');

  const listEl = document.getElementById('sessions-list');
  listEl.innerHTML = '<div class="progress-text">Loading...</div>';

  try {
    const resp = await fetch(`${API}/api/sessions`);
    if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
    const data = await resp.json();

    if (data.sessions.length === 0) {
      listEl.innerHTML = '<div class="progress-text">No saved sessions.</div>';
      return;
    }

    listEl.innerHTML = data.sessions.map(s => `
      <div class="session-item">
        <div class="session-info">
          <h3>${escapeHtml(s.projectName)}</h3>
          <div class="meta">
            ${s.progress.completedCalls}/${s.progress.totalCalls} calls &middot;
            ${new Date(s.updatedAt).toLocaleDateString()} &middot;
            <span class="status-badge status-${escapeAttr(s.status)}">${escapeHtml(s.status)}</span>
          </div>
        </div>
        <div class="btn-group" style="margin:0;">
          ${s.status === 'paused' ? `<button class="btn btn-sm btn-success" onclick="resumeSession('${escapeAttr(s.id)}')">Resume</button>` : ''}
          ${s.status === 'completed' ? `<button class="btn btn-sm btn-primary" onclick="downloadSession('${escapeAttr(s.id)}')">Download</button>` : ''}
          <button class="btn btn-sm btn-danger" onclick="deleteSession('${escapeAttr(s.id)}')">Delete</button>
        </div>
      </div>
    `).join('');
  } catch (e) {
    listEl.innerHTML = `<div class="progress-text" style="color:var(--danger);">Error: ${escapeHtml(e.message)}</div>`;
  }
}

function closeSessions() {
  document.getElementById('sessions-modal').classList.add('hidden');
  document.getElementById('sessions-overlay').classList.add('hidden');
}

async function resumeSession(sessionId) {
  closeSessions();
  currentSessionId = sessionId;
  goToStep(4);
  try {
    await fetch(`${API}/api/merge/resume/${sessionId}`, { method: 'POST' });
    startPolling();
  } catch (e) {
    toast(`Failed to resume: ${e.message}`, 'error');
  }
}

async function downloadSession(sessionId) {
  window.location.href = `${API}/api/merge/download/${sessionId}`;
}

async function deleteSession(sessionId) {
  try {
    await fetch(`${API}/api/sessions/${sessionId}`, { method: 'DELETE' });
    showSessions();
  } catch (e) {
    toast(`Failed to delete: ${e.message}`, 'error');
  }
}

/* ============= Custom Provider Wizard ============= */

function showCustomWizard() {
  document.getElementById('custom-wizard').classList.remove('hidden');
  document.getElementById('custom-wizard-overlay').classList.remove('hidden');
}

function closeCustomWizard() {
  document.getElementById('custom-wizard').classList.add('hidden');
  document.getElementById('custom-wizard-overlay').classList.add('hidden');
}

function updateCustomAuthFields() {
  const authType = document.getElementById('cw-authType').value;
  const container = document.getElementById('cw-auth-fields');

  if (authType === 'basic') {
    container.innerHTML = `
      <div class="form-row">
        <div class="form-group">
          <label>Username</label>
          <input type="text" id="cw-authUsername" placeholder="username">
        </div>
        <div class="form-group">
          <label>Password</label>
          <input type="password" id="cw-authPassword" placeholder="password">
        </div>
      </div>
    `;
  } else if (authType === 'apikey-header') {
    container.innerHTML = `
      <div class="form-row">
        <div class="form-group">
          <label>Header Name</label>
          <input type="text" id="cw-authHeaderName" placeholder="X-API-Key">
        </div>
        <div class="form-group">
          <label>API Key</label>
          <input type="password" id="cw-authToken" placeholder="api key">
        </div>
      </div>
    `;
  } else if (authType === 'apikey-query') {
    container.innerHTML = `
      <div class="form-row">
        <div class="form-group">
          <label>Query Parameter Name</label>
          <input type="text" id="cw-authQueryParam" placeholder="api_key">
        </div>
        <div class="form-group">
          <label>API Key</label>
          <input type="password" id="cw-authToken" placeholder="api key">
        </div>
      </div>
    `;
  } else {
    container.innerHTML = `
      <div class="form-group">
        <label>Token / API Key</label>
        <input type="password" id="cw-authToken" placeholder="Bearer token">
      </div>
    `;
  }
}

function saveCustomProvider() {
  const authType = document.getElementById('cw-authType').value;
  let authConfig = {};

  if (authType === 'basic') {
    authConfig = {
      username: document.getElementById('cw-authUsername').value,
      password: document.getElementById('cw-authPassword').value,
    };
  } else if (authType === 'apikey-header') {
    authConfig = {
      token: document.getElementById('cw-authToken').value,
      headerName: document.getElementById('cw-authHeaderName').value,
    };
  } else if (authType === 'apikey-query') {
    authConfig = {
      token: document.getElementById('cw-authToken').value,
      queryParam: document.getElementById('cw-authQueryParam').value,
    };
  } else {
    authConfig = { token: document.getElementById('cw-authToken').value };
  }

  const provider = {
    providerName: document.getElementById('cw-name').value || 'Custom',
    baseUrl: document.getElementById('cw-baseUrl').value,
    authType,
    authConfig,
    rateLimit: parseInt(document.getElementById('cw-rateLimit').value, 10) || 3,
    pagination: { type: document.getElementById('cw-paginationType').value },
    endpoints: {
      accounts: {
        path: document.getElementById('cw-accounts-path').value,
        method: 'get',
        arrayPath: document.getElementById('cw-accounts-arrayPath').value,
      },
      calls: {
        path: document.getElementById('cw-calls-path').value,
        method: 'get',
        arrayPath: document.getElementById('cw-calls-arrayPath').value,
      },
      callDetail: {
        path: document.getElementById('cw-detail-path').value,
        method: 'get',
      },
    },
    fieldMaps: {
      accounts: {
        id: document.getElementById('cw-accounts-id').value,
        name: document.getElementById('cw-accounts-name').value,
      },
      calls: {
        id: document.getElementById('cw-calls-id').value,
        title: document.getElementById('cw-calls-title').value,
        date: document.getElementById('cw-calls-date').value,
        duration: document.getElementById('cw-calls-duration').value,
      },
      callDetail: {
        title: document.getElementById('cw-detail-title').value,
        date: document.getElementById('cw-detail-date').value,
        summary: document.getElementById('cw-detail-summary').value,
        speakersPath: document.getElementById('cw-detail-speakersPath').value,
        speakerName: document.getElementById('cw-detail-speakerName').value,
        speakerEmail: document.getElementById('cw-detail-speakerEmail').value,
        transcriptPath: document.getElementById('cw-detail-transcriptPath').value,
        transcriptSpeaker: document.getElementById('cw-detail-transcriptSpeaker').value,
        transcriptText: document.getElementById('cw-detail-transcriptText').value,
        transcriptStart: document.getElementById('cw-detail-transcriptStart').value,
        transcriptEnd: document.getElementById('cw-detail-transcriptEnd').value,
      },
    },
  };

  customProviders.push(provider);
  renderCustomProvidersList();
  closeCustomWizard();
  toast(`Added ${provider.providerName}`, 'success');
}

function renderCustomProvidersList() {
  const el = document.getElementById('custom-providers-list');
  if (customProviders.length === 0) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = customProviders.map((cp, i) => `
    <div style="display:flex; align-items:center; justify-content:space-between; padding:8px 0;">
      <span><span class="source-badge badge-custom">${escapeHtml(cp.providerName)}</span> — ${escapeHtml(cp.baseUrl)}</span>
      <button class="btn btn-sm btn-danger" onclick="removeCustomProvider(${i})">Remove</button>
    </div>
  `).join('');
}

function removeCustomProvider(index) {
  customProviders.splice(index, 1);
  renderCustomProvidersList();
}

/* ============= Utilities ============= */

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function escapeAttr(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function toast(message, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  // Stack toasts so they don't overlap
  el.style.bottom = `${20 + toastStack * 60}px`;
  toastStack++;
  document.body.appendChild(el);
  setTimeout(() => {
    el.remove();
    toastStack = Math.max(0, toastStack - 1);
  }, 4000);
}

/* ============= Init ============= */
goToStep(1);
