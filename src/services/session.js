const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

// Always store sessions in the user's home directory.
// The app bundle is read-only on macOS (asar or App Translocation).
const SESSIONS_DIR = path.join(os.homedir(), '.call-transcript-merger', 'sessions');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Session Manager
 *
 * Handles pause/resume of transcript export projects.
 * Saves state to disk so work is never lost even if the API limit resets.
 * Uses atomic writes (write-to-tmp + rename) and an async lock per session
 * to prevent race conditions between concurrent readers/writers.
 */
class SessionManager {
  constructor() {
    this._locks = new Map(); // sessionId -> Promise chain for serialized writes
    if (!fs.existsSync(SESSIONS_DIR)) {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    }
  }

  _validateId(sessionId) {
    if (!sessionId || !UUID_RE.test(sessionId)) {
      throw new Error(`Invalid session ID: ${sessionId}`);
    }
  }

  /** Serialize all writes to a given session through a promise chain. */
  _withLock(sessionId, fn) {
    const prev = this._locks.get(sessionId) || Promise.resolve();
    const next = prev.then(fn, fn); // run fn even if prev rejected
    this._locks.set(sessionId, next);
    return next;
  }

  create(options) {
    const session = {
      id: uuidv4(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'active',
      projectName: String(options.projectName || 'Untitled Project'),
      providers: options.providers || [],
      selectedAccounts: options.selectedAccounts || [],
      primarySchema: options.primarySchema || 'gong',
      progress: {
        phase: 'init',
        totalCalls: 0,
        completedCalls: 0,
        callsList: [],
        completedDetails: [],
      },
      error: null,
    };

    this._save(session);
    return session;
  }

  load(sessionId) {
    this._validateId(sessionId);
    const filePath = path.join(SESSIONS_DIR, `${sessionId}.json`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Session ${sessionId} not found`);
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }

  listAll() {
    if (!fs.existsSync(SESSIONS_DIR)) return [];
    return fs.readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf-8'));
          // Return a summary without the large completedDetails array
          return {
            ...data,
            progress: { ...data.progress, completedDetails: undefined },
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  update(sessionId, updates) {
    this._validateId(sessionId);
    return this._withLock(sessionId, () => {
      const session = this.load(sessionId);
      // Only allow safe fields to be overwritten
      const safeKeys = ['status', 'error', 'result', 'updatedAt'];
      for (const key of safeKeys) {
        if (key in updates) session[key] = updates[key];
      }
      session.updatedAt = new Date().toISOString();
      this._save(session);
      return session;
    });
  }

  updateProgress(sessionId, progressUpdates) {
    this._validateId(sessionId);
    return this._withLock(sessionId, () => {
      const session = this.load(sessionId);
      Object.assign(session.progress, progressUpdates);
      session.updatedAt = new Date().toISOString();
      this._save(session);
      return session;
    });
  }

  markCallCompleted(sessionId, callId, callDetail) {
    this._validateId(sessionId);
    return this._withLock(sessionId, () => {
      const session = this.load(sessionId);

      const callEntry = session.progress.callsList.find(c => c.id === callId);
      if (callEntry) callEntry.status = 'completed';

      session.progress.completedDetails.push(callDetail);
      session.progress.completedCalls = session.progress.completedDetails.length;
      session.updatedAt = new Date().toISOString();

      this._save(session);
      return session;
    });
  }

  pause(sessionId, reason) {
    return this.update(sessionId, {
      status: 'paused',
      error: reason || 'Paused by user or rate limit.',
    });
  }

  resume(sessionId) {
    return this.update(sessionId, {
      status: 'active',
      error: null,
    });
  }

  complete(sessionId) {
    return this.update(sessionId, {
      status: 'completed',
      error: null,
    });
  }

  delete(sessionId) {
    this._validateId(sessionId);
    const filePath = path.join(SESSIONS_DIR, `${sessionId}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  /** Atomic write: write to temp file then rename into place. */
  _save(session) {
    this._validateId(session.id);
    const filePath = path.join(SESSIONS_DIR, `${session.id}.json`);
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(session, null, 2), 'utf-8');
      fs.renameSync(tmpPath, filePath);
    } catch (e) {
      // Clean up tmp file on failure
      try { fs.unlinkSync(tmpPath); } catch {}
      throw e;
    }
  }
}

module.exports = SessionManager;
