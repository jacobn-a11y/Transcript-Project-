const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const SESSIONS_DIR = path.join(__dirname, '..', '..', 'sessions');

/**
 * Session Manager
 *
 * Handles pause/resume of transcript export projects.
 * Saves state to disk so work is never lost even if the API limit resets.
 */
class SessionManager {
  constructor() {
    if (!fs.existsSync(SESSIONS_DIR)) {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    }
  }

  /**
   * Create a new session.
   */
  create(options) {
    const session = {
      id: uuidv4(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'active', // active | paused | completed | error
      projectName: options.projectName || 'Untitled Project',
      providers: options.providers || [],
      selectedAccounts: options.selectedAccounts || [],
      primarySchema: options.primarySchema || 'gong', // gong | grain
      progress: {
        phase: 'init', // init | fetching_calls | fetching_details | generating | done
        totalCalls: 0,
        completedCalls: 0,
        callsList: [],       // List of { id, source, status }
        completedDetails: [], // Full call details already fetched
      },
      error: null,
    };

    this._save(session);
    return session;
  }

  /**
   * Load an existing session.
   */
  load(sessionId) {
    const filePath = path.join(SESSIONS_DIR, `${sessionId}.json`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Session ${sessionId} not found`);
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }

  /**
   * List all sessions.
   */
  listAll() {
    if (!fs.existsSync(SESSIONS_DIR)) return [];
    return fs.readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf-8'));
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  /**
   * Update session state.
   */
  update(sessionId, updates) {
    const session = this.load(sessionId);
    Object.assign(session, updates, { updatedAt: new Date().toISOString() });
    this._save(session);
    return session;
  }

  /**
   * Update progress within a session.
   */
  updateProgress(sessionId, progressUpdates) {
    const session = this.load(sessionId);
    Object.assign(session.progress, progressUpdates);
    session.updatedAt = new Date().toISOString();
    this._save(session);
    return session;
  }

  /**
   * Mark a call as completed and store its detail data.
   */
  markCallCompleted(sessionId, callId, callDetail) {
    const session = this.load(sessionId);

    // Update call status in the list
    const callEntry = session.progress.callsList.find(c => c.id === callId);
    if (callEntry) callEntry.status = 'completed';

    // Store the detail
    session.progress.completedDetails.push(callDetail);
    session.progress.completedCalls = session.progress.completedDetails.length;
    session.updatedAt = new Date().toISOString();

    this._save(session);
    return session;
  }

  /**
   * Pause a session (e.g., when API limits are hit).
   */
  pause(sessionId, reason) {
    return this.update(sessionId, {
      status: 'paused',
      error: reason || 'Paused by user or rate limit.',
    });
  }

  /**
   * Resume a paused session.
   */
  resume(sessionId) {
    return this.update(sessionId, {
      status: 'active',
      error: null,
    });
  }

  /**
   * Mark session as completed.
   */
  complete(sessionId) {
    return this.update(sessionId, {
      status: 'completed',
      error: null,
    });
  }

  /**
   * Delete a session.
   */
  delete(sessionId) {
    const filePath = path.join(SESSIONS_DIR, `${sessionId}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  _save(session) {
    const filePath = path.join(SESSIONS_DIR, `${session.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8');
  }
}

module.exports = SessionManager;
