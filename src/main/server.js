const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const GongProvider = require('../api/providers/gong');
const GrainProvider = require('../api/providers/grain');
const CustomProvider = require('../api/providers/custom');
const { createRateLimiter } = require('../utils/rate-limiter');
const TranscriptMerger = require('../services/merger');
const SessionManager = require('../services/session');

const app = express();
const PORT = process.env.PORT || 3847;

// H2: Per-session auth token — prevents unauthorized local processes from using the API
const AUTH_TOKEN = crypto.randomBytes(32).toString('hex');

// H3: Host header validation — prevents DNS rebinding attacks
app.use((req, res, next) => {
  const host = req.headers.host;
  const allowed = [`localhost:${PORT}`, `127.0.0.1:${PORT}`, 'localhost', '127.0.0.1'];
  if (!host || !allowed.includes(host)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
});

// M7: Content-Security-Policy header
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; frame-src 'none';"
  );
  next();
});

app.use(express.json({ limit: '2mb' }));

// H2: Serve index.html with auth token injected (before static middleware)
app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, '..', '..', 'public', 'index.html');
  let html = fs.readFileSync(htmlPath, 'utf-8');
  html = html.replace('</head>', `<meta name="api-token" content="${AUTH_TOKEN}">\n</head>`);
  res.type('html').send(html);
});

app.use(express.static(path.join(__dirname, '..', '..', 'public')));

// H2: Auth middleware for all API endpoints
app.use('/api', (req, res, next) => {
  const token = req.headers['x-auth-token'] || req.query._token;
  if (token !== AUTH_TOKEN) {
    return res.status(403).json({ error: 'Invalid or missing auth token.' });
  }
  next();
});

// L3: Simple rate limiting on incoming endpoints (120 requests per minute)
const requestCounts = new Map();
app.use('/api', (req, res, next) => {
  const now = Date.now();
  const windowStart = now - 60000;
  const timestamps = (requestCounts.get('global') || []).filter(t => t > windowStart);
  if (timestamps.length >= 120) {
    return res.status(429).json({ error: 'Too many requests. Try again later.' });
  }
  timestamps.push(now);
  requestCounts.set('global', timestamps);
  next();
});

const sessionManager = new SessionManager();

// H1: SSRF protection — block requests to private/internal networks
function isPrivateUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    const hostname = parsed.hostname.toLowerCase();

    // Block known private hostnames
    if (['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'].includes(hostname)) return true;

    // Block private IP ranges
    const ipParts = hostname.split('.').map(Number);
    if (ipParts.length === 4 && ipParts.every(p => !isNaN(p) && p >= 0 && p <= 255)) {
      if (ipParts[0] === 10) return true;                                       // 10.0.0.0/8
      if (ipParts[0] === 172 && ipParts[1] >= 16 && ipParts[1] <= 31) return true; // 172.16.0.0/12
      if (ipParts[0] === 192 && ipParts[1] === 168) return true;                // 192.168.0.0/16
      if (ipParts[0] === 169 && ipParts[1] === 254) return true;                // 169.254.0.0/16
      if (ipParts[0] === 0) return true;                                         // 0.0.0.0/8
    }

    return false;
  } catch {
    return true;
  }
}

function validateBaseUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  try {
    const parsed = new URL(urlStr);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    if (isPrivateUrl(urlStr)) return false;
    return true;
  } catch {
    return false;
  }
}

// L5: Sanitize error messages to avoid leaking internal details
function sanitizeError(message) {
  if (!message || typeof message !== 'string') return 'An error occurred.';
  // Strip file paths
  return message.replace(/\/[^\s:'"]+/g, '[path]').substring(0, 200);
}

// In-memory state
let currentConfig = null;
let providers = {};
let mergeLogs = {};     // sessionId -> [{ time, message, level }]
let mergeAbort = {};    // sessionId -> boolean (flag to stop processing)

/* ============= Config ============= */

app.post('/api/config', (req, res) => {
  // M3: Basic schema validation
  const body = req.body;
  if (!body || typeof body !== 'object' || !body.providers || typeof body.providers !== 'object') {
    return res.status(400).json({ error: 'Invalid config: providers object is required.' });
  }

  // M1: Clear old provider references before reconfiguring
  currentConfig = null;
  providers = {};

  currentConfig = body;

  // Determine the lowest rate limit across all enabled providers
  const rateLimits = [];

  if (currentConfig.providers && currentConfig.providers.gong) {
    // H1: Validate Gong base URL if user-provided
    const gongCfg = currentConfig.providers.gong;
    if (gongCfg.baseUrl && !validateBaseUrl(gongCfg.baseUrl)) {
      return res.status(400).json({ error: 'Invalid Gong base URL.' });
    }
    const p = new GongProvider(gongCfg);
    rateLimits.push(p.getRateLimit());
    providers.gong = p;
  }

  if (currentConfig.providers && currentConfig.providers.grain) {
    // H1: Validate Grain base URL if user-provided
    const grainCfg = currentConfig.providers.grain;
    if (grainCfg.baseUrl && !validateBaseUrl(grainCfg.baseUrl)) {
      return res.status(400).json({ error: 'Invalid Grain base URL.' });
    }
    const p = new GrainProvider(grainCfg);
    rateLimits.push(p.getRateLimit());
    providers.grain = p;
  }

  // Custom providers
  if (currentConfig.providers) {
    for (const [key, cfg] of Object.entries(currentConfig.providers)) {
      if (key.startsWith('custom:')) {
        // H1: Validate custom provider base URL
        if (!cfg.baseUrl || !validateBaseUrl(cfg.baseUrl)) {
          return res.status(400).json({ error: `Invalid base URL for custom provider "${key}".` });
        }
        const p = new CustomProvider(cfg);
        rateLimits.push(p.getRateLimit());
        providers[key] = p;
      }
    }
  }

  // Create a shared rate limiter using the lowest limit
  const minRate = rateLimits.length > 0 ? Math.min(...rateLimits) : 3;
  const limiter = createRateLimiter(minRate);

  for (const p of Object.values(providers)) {
    p.setRateLimiter(limiter);
  }

  res.json({ success: true, rateLimit: minRate, providers: Object.keys(providers) });
});

/* ============= Test Connection ============= */

app.get('/api/test/:provider', async (req, res) => {
  const providerKey = req.params.provider;
  const provider = providers[providerKey];

  if (!provider) {
    return res.json({ success: false, message: `Provider "${providerKey}" not configured.` });
  }

  try {
    const result = await provider.testConnection();
    res.json(result);
  } catch (e) {
    res.json({ success: false, message: sanitizeError(e.message) });
  }
});

/* ============= Accounts ============= */

app.get('/api/accounts', async (req, res) => {
  const allAccounts = [];

  for (const [key, provider] of Object.entries(providers)) {
    try {
      const accounts = await provider.getAccounts();
      allAccounts.push(...accounts);
    } catch (e) {
      console.error(`Error fetching accounts from ${key}:`, e.message);
    }
  }

  res.json({ accounts: allAccounts });
});

/* ============= Merge ============= */

app.post('/api/merge/start', async (req, res) => {
  const { projectName, selectedAccounts, primarySchema, sortMode, fetchAll } = req.body;

  if (!projectName || typeof projectName !== 'string') {
    return res.status(400).json({ error: 'projectName is required and must be a string.' });
  }

  // When fetchAll is true, we fetch all accounts from all providers instead of requiring selectedAccounts
  let accountsToMerge = selectedAccounts;

  if (fetchAll) {
    // Fetch all accounts from all enabled providers
    const allAccounts = [];
    for (const [key, provider] of Object.entries(providers)) {
      try {
        const accounts = await provider.getAccounts();
        allAccounts.push(...accounts);
      } catch (e) {
        console.error(`Error fetching accounts from ${key}:`, e.message);
      }
    }
    accountsToMerge = allAccounts;
  }

  if (!Array.isArray(accountsToMerge) || accountsToMerge.length === 0) {
    return res.status(400).json({ error: 'No accounts found. Enable at least one provider with accounts.' });
  }

  // Create session
  const session = sessionManager.create({
    projectName,
    selectedAccounts: accountsToMerge,
    primarySchema,
    sortMode: sortMode || 'chronological',
    fetchAll: !!fetchAll,
    providers: Object.keys(providers),
  });

  mergeLogs[session.id] = [];
  mergeAbort[session.id] = false;

  res.json({ sessionId: session.id });

  // Start async merge process
  runMerge(session.id, accountsToMerge, projectName, sortMode || 'chronological', !!fetchAll).catch(async (e) => {
    addLog(session.id, `Fatal error: ${e.message}`, 'error');
    await sessionManager.update(session.id, { status: 'error', error: e.message });
  });
});

async function runMerge(sessionId, selectedAccounts, projectName, sortMode = 'chronological', fetchAll = false) {
  addLog(sessionId, 'Starting merge process...');

  // Check if we already have a call list from a previous run (resume case)
  const existingSession = sessionManager.load(sessionId);
  let callsList = existingSession.progress.callsList || [];
  let uniqueCalls;

  if (callsList.length > 0 && existingSession.progress.phase === 'fetching_details') {
    // Resume: skip Phase 1, use existing call list
    addLog(sessionId, `Resuming with ${callsList.length} calls from previous run.`);
    uniqueCalls = callsList.map(c => ({
      id: c.id,
      source: c.source,
      title: c.title,
      date: c.date,
      accountName: c.accountName || '',
    }));
  } else {
    // Phase 1: Fetch call lists
    await sessionManager.updateProgress(sessionId, { phase: 'fetching_calls' });

    const allCalls = [];

    if (fetchAll) {
      // Fetch ALL calls from each provider in a single pass
      addLog(sessionId, 'Fetching all calls from all providers (single pass)...');

      for (const [key, provider] of Object.entries(providers)) {
        if (mergeAbort[sessionId]) {
          addLog(sessionId, 'Paused during call list fetch.', 'warn');
          return;
        }

        try {
          addLog(sessionId, `Fetching all calls from ${key}...`);
          const calls = await provider.getAllCalls({
            onProgress: (msg) => addLog(sessionId, msg),
          });
          addLog(sessionId, `Found ${calls.length} calls from ${key}`, 'success');
          allCalls.push(...calls);
        } catch (e) {
          if (isRateLimitError(e)) {
            addLog(sessionId, `Rate limit hit fetching calls from ${key}. Pausing session.`, 'warn');
            await sessionManager.pause(sessionId, `Rate limit reached. ${e.message}`);
            return;
          }
          addLog(sessionId, `Error fetching calls from ${key}: ${e.message}`, 'error');
        }
      }
    } else {
      // Fetch calls per selected account
      addLog(sessionId, 'Fetching call lists from all providers...');

      for (const account of selectedAccounts) {
        if (mergeAbort[sessionId]) {
          addLog(sessionId, 'Paused during call list fetch.', 'warn');
          return;
        }

        const provider = findProviderForSource(account.source);
        if (!provider) {
          addLog(sessionId, `No provider found for source: ${account.source}`, 'warn');
          continue;
        }

        try {
          addLog(sessionId, `Fetching calls for "${account.name}" from ${account.source}...`);
          const calls = await provider.getCallsForAccount(account.id, {
            onProgress: (msg) => addLog(sessionId, msg),
          });
          addLog(sessionId, `Found ${calls.length} calls for "${account.name}"`, 'success');
          allCalls.push(...calls);
        } catch (e) {
          if (isRateLimitError(e)) {
            addLog(sessionId, `Rate limit hit fetching calls for "${account.name}". Pausing session.`, 'warn');
            await sessionManager.pause(sessionId, `Rate limit reached. ${e.message}`);
            return;
          }
          addLog(sessionId, `Error fetching calls for "${account.name}": ${e.message}`, 'error');
        }
      }
    }

    // Deduplicate calls by id+source
    const seen = new Set();
    uniqueCalls = allCalls.filter(c => {
      const key = `${c.id}|${c.source}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Update session with call list (include accountName for fetchAll mode)
    callsList = uniqueCalls.map(c => ({
      id: c.id,
      source: c.source,
      title: c.title,
      date: c.date,
      accountName: c.accountName || '',
      status: 'pending',
    }));

    await sessionManager.updateProgress(sessionId, {
      phase: 'fetching_details',
      totalCalls: callsList.length,
      callsList,
    });
  }

  addLog(sessionId, `Total unique calls to process: ${uniqueCalls.length}`);

  // Phase 2: Fetch details for each call
  const session = sessionManager.load(sessionId);
  const alreadyCompleted = new Set(
    session.progress.completedDetails.map(d => `${d.id}|${d.source}`)
  );

  for (const call of uniqueCalls) {
    if (mergeAbort[sessionId]) {
      addLog(sessionId, 'Paused during detail fetch.', 'warn');
      return;
    }

    const callKey = `${call.id}|${call.source}`;
    if (alreadyCompleted.has(callKey)) {
      addLog(sessionId, `Skipping already completed: ${call.title}`);
      continue;
    }

    const provider = findProviderForSource(call.source);
    if (!provider) continue;

    try {
      addLog(sessionId, `Fetching transcript: ${call.title} (${call.source})...`);
      const detail = await provider.getCallDetail(call.id);
      detail.accountName = detail.accountName || call.accountName;
      await sessionManager.markCallCompleted(sessionId, call.id, detail);
      addLog(sessionId, `Completed: ${call.title}`, 'success');
    } catch (e) {
      if (isRateLimitError(e)) {
        addLog(sessionId, `Rate limit hit on "${call.title}". Pausing session.`, 'warn');
        await sessionManager.pause(sessionId, `Rate limit reached on call "${call.title}". ${e.message}`);
        return;
      }
      addLog(sessionId, `Error on "${call.title}": ${e.message}`, 'error');
      // Mark this call as failed but continue
      await sessionManager.markCallCompleted(sessionId, call.id, {
        id: call.id,
        title: call.title,
        date: call.date,
        source: call.source,
        accountName: call.accountName || '',
        speakers: [],
        summary: '',
        outline: '',
        keyPoints: '',
        transcript: [],
        error: e.message,
      });
    }
  }

  // Phase 3: Generate markdown
  await sessionManager.updateProgress(sessionId, { phase: 'generating' });
  addLog(sessionId, 'Generating merged Markdown document...');

  const finalSession = sessionManager.load(sessionId);
  const merger = new TranscriptMerger(finalSession.progress.completedDetails, {
    projectName,
    selectedAccounts,
    sortMode,
  });

  const { markdown, wordCount } = merger.generate();

  // Save to Downloads folder, avoiding overwrite of existing files
  const downloadsDir = path.join(os.homedir(), 'Downloads');
  const safeProjectName = String(projectName).replace(/[^a-zA-Z0-9_\- ]/g, '').substring(0, 80);
  let fileName = `${safeProjectName} (${wordCount} words).md`;
  let filePath = path.join(downloadsDir, fileName);

  let counter = 1;
  while (fs.existsSync(filePath)) {
    fileName = `${safeProjectName} (${wordCount} words) (${counter}).md`;
    filePath = path.join(downloadsDir, fileName);
    counter++;
  }

  fs.writeFileSync(filePath, markdown, 'utf-8');
  addLog(sessionId, `Saved: ${filePath}`, 'success');
  addLog(sessionId, `Word count: ${wordCount.toLocaleString()}`, 'success');

  // Store result info in session
  await sessionManager.update(sessionId, {
    status: 'completed',
    result: {
      filePath,
      fileName,
      wordCount,
      callCount: finalSession.progress.completedDetails.length,
    },
  });
  await sessionManager.updateProgress(sessionId, { phase: 'done' });
  addLog(sessionId, 'Merge complete!', 'success');

  // Clean up in-memory state for this session
  cleanupSession(sessionId);
}

function findProviderForSource(source) {
  const key = source.toLowerCase();
  if (providers[key]) return providers[key];

  for (const [k, p] of Object.entries(providers)) {
    if (p.name === source) return p;
  }

  return null;
}

function isRateLimitError(error) {
  if (error.response && error.response.status === 429) return true;
  if (error.message && error.message.toLowerCase().includes('rate limit')) return true;
  return false;
}

function addLog(sessionId, message, level = '') {
  if (!mergeLogs[sessionId]) mergeLogs[sessionId] = [];
  mergeLogs[sessionId].push({
    time: new Date().toLocaleTimeString(),
    message,
    level,
  });
  // Keep last 500 entries
  if (mergeLogs[sessionId].length > 500) {
    mergeLogs[sessionId] = mergeLogs[sessionId].slice(-500);
  }
  console.log(`[${sessionId.substring(0, 8)}] [${level || 'info'}] ${message}`);
}

function cleanupSession(sessionId) {
  // Free in-memory logs and abort flags for completed sessions
  // Keep for 5 minutes so the frontend can retrieve final state, then delete
  setTimeout(() => {
    delete mergeLogs[sessionId];
    delete mergeAbort[sessionId];
  }, 5 * 60 * 1000);
}

/* ============= Progress ============= */

app.get('/api/merge/progress/:sessionId', (req, res) => {
  try {
    const session = sessionManager.load(req.params.sessionId);
    // Don't send completedDetails over the wire (can be very large)
    const progress = { ...session.progress, completedDetails: undefined };
    res.json({
      ...session,
      progress,
      logs: (mergeLogs[session.id] || []).slice(-100),
    });
  } catch (e) {
    res.status(404).json({ error: sanitizeError(e.message) });
  }
});

/* ============= Pause / Resume ============= */

app.post('/api/merge/pause/:sessionId', async (req, res) => {
  try {
    mergeAbort[req.params.sessionId] = true;
    await sessionManager.pause(req.params.sessionId, 'Paused by user.');
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: sanitizeError(e.message) });
  }
});

app.post('/api/merge/resume/:sessionId', async (req, res) => {
  const sessionId = req.params.sessionId;
  try {
    mergeAbort[sessionId] = false;
    mergeLogs[sessionId] = mergeLogs[sessionId] || [];
    await sessionManager.resume(sessionId);
    res.json({ success: true });

    // Restart merge from where it left off
    const session = sessionManager.load(sessionId);
    runMerge(sessionId, session.selectedAccounts, session.projectName, session.sortMode || 'chronological', !!session.fetchAll).catch(async (e) => {
      addLog(sessionId, `Fatal error on resume: ${e.message}`, 'error');
      await sessionManager.update(sessionId, { status: 'error', error: e.message });
    });
  } catch (e) {
    res.status(400).json({ error: sanitizeError(e.message) });
  }
});

/* ============= Download ============= */

app.get('/api/merge/download/:sessionId', (req, res) => {
  try {
    const session = sessionManager.load(req.params.sessionId);
    if (!session.result || !session.result.filePath) {
      return res.status(404).json({ error: 'No output file found for this session.' });
    }

    // M6: Validate filePath is within the Downloads directory
    const downloadsDir = path.join(os.homedir(), 'Downloads');
    const resolvedPath = path.resolve(session.result.filePath);
    if (!resolvedPath.startsWith(downloadsDir + path.sep) && resolvedPath !== downloadsDir) {
      return res.status(403).json({ error: 'File path is outside the allowed directory.' });
    }

    if (!fs.existsSync(resolvedPath)) {
      // Regenerate
      const merger = new TranscriptMerger(session.progress.completedDetails, {
        projectName: session.projectName,
        selectedAccounts: session.selectedAccounts,
        sortMode: session.sortMode || 'chronological',
      });
      const { markdown } = merger.generate();
      fs.writeFileSync(resolvedPath, markdown, 'utf-8');
    }
    res.download(resolvedPath, session.result.fileName);
  } catch (e) {
    res.status(404).json({ error: sanitizeError(e.message) });
  }
});

/* ============= Sessions ============= */

app.get('/api/sessions', (req, res) => {
  const sessions = sessionManager.listAll();
  res.json({ sessions });
});

app.delete('/api/sessions/:sessionId', (req, res) => {
  try {
    sessionManager.delete(req.params.sessionId);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: sanitizeError(e.message) });
  }
});

/* ============= Start ============= */

// Bind to localhost only — not accessible from other machines on the network
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`Call Transcript Merger running at http://localhost:${PORT}`);
});

// Export a ready promise so Electron can wait for the server to be listening
const ready = new Promise((resolve) => {
  server.on('listening', resolve);
});

module.exports = server;
module.exports.ready = ready;
