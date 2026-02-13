const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');

const GongProvider = require('../api/providers/gong');
const GrainProvider = require('../api/providers/grain');
const CustomProvider = require('../api/providers/custom');
const { createRateLimiter } = require('../utils/rate-limiter');
const TranscriptMerger = require('../services/merger');
const SessionManager = require('../services/session');

const app = express();
const PORT = process.env.PORT || 3847;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', '..', 'public')));

const sessionManager = new SessionManager();

// In-memory state
let currentConfig = null;
let providers = {};
let mergeLogs = {};     // sessionId -> [{ time, message, level }]
let mergeAbort = {};    // sessionId -> boolean (flag to stop processing)

/* ============= Config ============= */

app.post('/api/config', (req, res) => {
  currentConfig = req.body;
  providers = {};

  // Determine the lowest rate limit across all enabled providers
  const rateLimits = [];

  if (currentConfig.providers && currentConfig.providers.gong) {
    const p = new GongProvider(currentConfig.providers.gong);
    rateLimits.push(p.getRateLimit());
    providers.gong = p;
  }

  if (currentConfig.providers && currentConfig.providers.grain) {
    const p = new GrainProvider(currentConfig.providers.grain);
    rateLimits.push(p.getRateLimit());
    providers.grain = p;
  }

  // Custom providers
  if (currentConfig.providers) {
    for (const [key, cfg] of Object.entries(currentConfig.providers)) {
      if (key.startsWith('custom:')) {
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
    res.json({ success: false, message: e.message });
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
  const { projectName, selectedAccounts, primarySchema } = req.body;

  if (!projectName || typeof projectName !== 'string') {
    return res.status(400).json({ error: 'projectName is required and must be a string.' });
  }
  if (!Array.isArray(selectedAccounts) || selectedAccounts.length === 0) {
    return res.status(400).json({ error: 'selectedAccounts must be a non-empty array.' });
  }

  // Create session
  const session = sessionManager.create({
    projectName,
    selectedAccounts,
    primarySchema,
    providers: Object.keys(providers),
  });

  mergeLogs[session.id] = [];
  mergeAbort[session.id] = false;

  res.json({ sessionId: session.id });

  // Start async merge process
  runMerge(session.id, selectedAccounts, projectName).catch(async (e) => {
    addLog(session.id, `Fatal error: ${e.message}`, 'error');
    await sessionManager.update(session.id, { status: 'error', error: e.message });
  });
});

async function runMerge(sessionId, selectedAccounts, projectName) {
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
      accountName: '',
    }));
  } else {
    // Phase 1: Fetch call lists for all selected accounts
    await sessionManager.updateProgress(sessionId, { phase: 'fetching_calls' });
    addLog(sessionId, 'Fetching call lists from all providers...');

    const allCalls = [];

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
        const calls = await provider.getCallsForAccount(account.id);
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

    // Deduplicate calls by id+source
    const seen = new Set();
    uniqueCalls = allCalls.filter(c => {
      const key = `${c.id}|${c.source}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Update session with call list
    callsList = uniqueCalls.map(c => ({
      id: c.id,
      source: c.source,
      title: c.title,
      date: c.date,
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
    res.status(404).json({ error: e.message });
  }
});

/* ============= Pause / Resume ============= */

app.post('/api/merge/pause/:sessionId', async (req, res) => {
  try {
    mergeAbort[req.params.sessionId] = true;
    await sessionManager.pause(req.params.sessionId, 'Paused by user.');
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
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
    runMerge(sessionId, session.selectedAccounts, session.projectName).catch(async (e) => {
      addLog(sessionId, `Fatal error on resume: ${e.message}`, 'error');
      await sessionManager.update(sessionId, { status: 'error', error: e.message });
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ============= Download ============= */

app.get('/api/merge/download/:sessionId', (req, res) => {
  try {
    const session = sessionManager.load(req.params.sessionId);
    if (!session.result || !session.result.filePath) {
      return res.status(404).json({ error: 'No output file found for this session.' });
    }
    if (!fs.existsSync(session.result.filePath)) {
      // Regenerate
      const merger = new TranscriptMerger(session.progress.completedDetails, {
        projectName: session.projectName,
        selectedAccounts: session.selectedAccounts,
      });
      const { markdown } = merger.generate();
      fs.writeFileSync(session.result.filePath, markdown, 'utf-8');
    }
    res.download(session.result.filePath, session.result.fileName);
  } catch (e) {
    res.status(404).json({ error: e.message });
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
    res.status(400).json({ error: e.message });
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
