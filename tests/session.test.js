const path = require('path');
const fs = require('fs');

module.exports = function (describe, assert) {
  // Fresh SessionManager per suite to avoid cross-contamination
  function freshSessionManager() {
    // Clear require cache to get a fresh instance
    const modPath = require.resolve('../src/services/session');
    delete require.cache[modPath];
    return new (require(modPath))();
  }

  describe('SessionManager — CRUD', (it) => {
    const sm = freshSessionManager();
    let sessionId;

    it('create() returns a valid session object', () => {
      const s = sm.create({ projectName: 'Test CRUD', primarySchema: 'gong' });
      sessionId = s.id;
      assert.ok(s.id, 'Should have an id');
      assert.equal(s.status, 'active');
      assert.equal(s.projectName, 'Test CRUD');
      assert.equal(s.primarySchema, 'gong');
      assert.equal(s.progress.phase, 'init');
      assert.equal(s.progress.completedCalls, 0);
    });

    it('load() retrieves the created session', () => {
      const s = sm.load(sessionId);
      assert.equal(s.id, sessionId);
      assert.equal(s.projectName, 'Test CRUD');
    });

    it('listAll() includes the created session', () => {
      const all = sm.listAll();
      assert.ok(all.some(s => s.id === sessionId), 'Session should appear in list');
    });

    it('delete() removes the session', () => {
      sm.delete(sessionId);
      assert.throws(() => sm.load(sessionId), 'Load after delete should throw');
    });
  });

  describe('SessionManager — Security', (it) => {
    const sm = freshSessionManager();

    it('rejects path traversal in load()', () => {
      assert.throws(() => sm.load('../../etc/passwd'));
    });

    it('rejects path traversal in delete()', () => {
      assert.throws(() => sm.delete('../../../tmp/evil'));
    });

    it('rejects non-UUID strings', () => {
      assert.throws(() => sm.load('not-a-uuid'));
      assert.throws(() => sm.load(''));
      assert.throws(() => sm.load(null));
    });

    it('update() only modifies safe keys (status, error, result)', async () => {
      const s = sm.create({ projectName: 'SafeKeyTest' });
      await sm.update(s.id, { id: 'hacked', projectName: 'Hacked', status: 'paused' });
      const loaded = sm.load(s.id);
      assert.equal(loaded.id, s.id, 'id must not be overwritten');
      assert.equal(loaded.projectName, 'SafeKeyTest', 'projectName must not be overwritten');
      assert.equal(loaded.status, 'paused', 'status should be updated');
      sm.delete(s.id);
    });
  });

  describe('SessionManager — Async locking', (it) => {
    const sm = freshSessionManager();

    it('concurrent markCallCompleted() calls preserve all data', async () => {
      const s = sm.create({ projectName: 'ConcurrencyTest' });
      await sm.updateProgress(s.id, {
        phase: 'fetching_details',
        totalCalls: 5,
        callsList: Array.from({ length: 5 }, (_, i) => ({
          id: `c${i}`, source: 'Gong', status: 'pending',
        })),
      });

      // Fire 5 concurrent writes
      await Promise.all(Array.from({ length: 5 }, (_, i) =>
        sm.markCallCompleted(s.id, `c${i}`, {
          id: `c${i}`, title: `Call ${i}`, source: 'Gong', transcript: [`line-${i}`],
        })
      ));

      const final = sm.load(s.id);
      assert.equal(final.progress.completedCalls, 5, 'All 5 should be recorded');
      assert.equal(final.progress.completedDetails.length, 5);

      // Verify each call's data is intact
      for (let i = 0; i < 5; i++) {
        const detail = final.progress.completedDetails.find(d => d.id === `c${i}`);
        assert.ok(detail, `Detail for c${i} should exist`);
        assert.deepEqual(detail.transcript, [`line-${i}`]);
      }

      sm.delete(s.id);
    });
  });

  describe('SessionManager — Pause / Resume flow', (it) => {
    const sm = freshSessionManager();

    it('pause() sets status and error message', async () => {
      const s = sm.create({ projectName: 'PauseTest' });
      await sm.pause(s.id, 'Rate limit hit');
      const loaded = sm.load(s.id);
      assert.equal(loaded.status, 'paused');
      assert.equal(loaded.error, 'Rate limit hit');
      sm.delete(s.id);
    });

    it('resume() clears error and sets active', async () => {
      const s = sm.create({ projectName: 'ResumeTest' });
      await sm.pause(s.id, 'Paused');
      await sm.resume(s.id);
      const loaded = sm.load(s.id);
      assert.equal(loaded.status, 'active');
      assert.equal(loaded.error, null);
      sm.delete(s.id);
    });

    it('complete() sets status to completed', async () => {
      const s = sm.create({ projectName: 'CompleteTest' });
      await sm.complete(s.id);
      const loaded = sm.load(s.id);
      assert.equal(loaded.status, 'completed');
      sm.delete(s.id);
    });
  });

  describe('SessionManager — Atomic writes', (it) => {
    const sm = freshSessionManager();
    const os = require('os');
    const sessDir = path.join(os.homedir(), '.call-transcript-merger', 'sessions');

    it('session file contains valid JSON after write', () => {
      const s = sm.create({ projectName: 'AtomicTest' });
      const filePath = path.join(sessDir, `${s.id}.json`);
      assert.ok(fs.existsSync(filePath), 'File should exist');
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(content); // Should not throw
      assert.equal(parsed.id, s.id);
      sm.delete(s.id);
    });

    it('no .tmp files left behind after successful write', () => {
      const s = sm.create({ projectName: 'TmpCleanup' });
      const tmpFiles = fs.readdirSync(sessDir).filter(f => f.endsWith('.tmp'));
      assert.equal(tmpFiles.length, 0, 'No .tmp files should remain');
      sm.delete(s.id);
    });
  });
};
