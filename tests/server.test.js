const http = require('http');

const PORT = 3848; // Use a different port to avoid conflicts
let serverReady = false;

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}${path}`, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    }).on('error', reject);
  });
}

function post(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(`http://127.0.0.1:${PORT}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function del(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${PORT}${path}`, {
      method: 'DELETE',
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function ensureServer() {
  if (serverReady) return;
  // Start server on alternate port
  process.env.PORT = String(PORT);
  // Clear cached modules to get fresh server
  const serverPath = require.resolve('../src/main/server');
  delete require.cache[serverPath];
  require(serverPath);
  // Wait for it to be ready
  await new Promise((resolve) => setTimeout(resolve, 500));
  serverReady = true;
}

module.exports = function (describe, assert) {
  describe('HTTP API — Static files', (it) => {
    it('serves index.html at /', async () => {
      await ensureServer();
      const resp = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${PORT}/`, (res) => {
          let data = '';
          res.on('data', (c) => data += c);
          res.on('end', () => resolve({ status: res.statusCode, body: data }));
        }).on('error', reject);
      });
      assert.equal(resp.status, 200);
      assert.includes(resp.body, 'Call Transcript Merger');
    });

    it('serves CSS', async () => {
      await ensureServer();
      const resp = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${PORT}/css/style.css`, (res) => {
          let data = '';
          res.on('data', (c) => data += c);
          res.on('end', () => resolve({ status: res.statusCode, body: data }));
        }).on('error', reject);
      });
      assert.equal(resp.status, 200);
      assert.includes(resp.body, '--primary');
    });
  });

  describe('HTTP API — Config', (it) => {
    it('POST /api/config accepts empty providers', async () => {
      await ensureServer();
      const resp = await post('/api/config', { primarySchema: 'gong', providers: {} });
      assert.equal(resp.status, 200);
      assert.ok(resp.body.success);
    });

    it('POST /api/config with Gong sets rate limit to 1', async () => {
      await ensureServer();
      const resp = await post('/api/config', {
        primarySchema: 'gong',
        providers: { gong: { accessKey: 'k', accessKeySecret: 's' } },
      });
      assert.equal(resp.body.rateLimit, 1);
      assert.includes(JSON.stringify(resp.body.providers), 'gong');
    });

    it('POST /api/config with Grain sets rate limit to 5', async () => {
      await ensureServer();
      const resp = await post('/api/config', {
        primarySchema: 'grain',
        providers: { grain: { apiKey: 'key123' } },
      });
      assert.equal(resp.body.rateLimit, 5);
    });

    it('POST /api/config with both uses min rate (1)', async () => {
      await ensureServer();
      const resp = await post('/api/config', {
        primarySchema: 'gong',
        providers: {
          gong: { accessKey: 'k', accessKeySecret: 's' },
          grain: { apiKey: 'key123' },
        },
      });
      assert.equal(resp.body.rateLimit, 1);
    });
  });

  describe('HTTP API — Input validation', (it) => {
    it('POST /api/merge/start rejects non-string projectName', async () => {
      await ensureServer();
      const resp = await post('/api/merge/start', { projectName: 123, selectedAccounts: [{}] });
      assert.equal(resp.status, 400);
    });

    it('POST /api/merge/start rejects empty selectedAccounts', async () => {
      await ensureServer();
      const resp = await post('/api/merge/start', { projectName: 'test', selectedAccounts: [] });
      assert.equal(resp.status, 400);
    });

    it('POST /api/merge/start rejects missing selectedAccounts', async () => {
      await ensureServer();
      const resp = await post('/api/merge/start', { projectName: 'test' });
      assert.equal(resp.status, 400);
    });
  });

  describe('HTTP API — Session ID validation', (it) => {
    it('GET /api/merge/progress rejects invalid session ID', async () => {
      await ensureServer();
      const resp = await get('/api/merge/progress/not-a-uuid');
      assert.equal(resp.status, 404);
    });

    it('GET /api/merge/progress rejects path traversal', async () => {
      await ensureServer();
      const resp = await get('/api/merge/progress/../../etc/passwd');
      assert.equal(resp.status, 404);
    });

    it('DELETE /api/sessions/:id rejects invalid ID', async () => {
      await ensureServer();
      const resp = await del('/api/sessions/bad-id');
      assert.equal(resp.status, 400);
    });
  });

  describe('HTTP API — Sessions', (it) => {
    it('GET /api/sessions returns array', async () => {
      await ensureServer();
      const resp = await get('/api/sessions');
      assert.equal(resp.status, 200);
      assert.ok(Array.isArray(resp.body.sessions));
    });
  });

  describe('HTTP API — Test connection', (it) => {
    it('GET /api/test/:provider returns error for unconfigured provider', async () => {
      await ensureServer();
      await post('/api/config', { primarySchema: 'gong', providers: {} });
      const resp = await get('/api/test/gong');
      assert.equal(resp.body.success, false);
      assert.includes(resp.body.message, 'not configured');
    });
  });

  describe('HTTP API — Accounts', (it) => {
    it('GET /api/accounts returns array when no providers configured', async () => {
      await ensureServer();
      await post('/api/config', { primarySchema: 'gong', providers: {} });
      const resp = await get('/api/accounts');
      assert.equal(resp.status, 200);
      assert.ok(Array.isArray(resp.body.accounts));
      assert.equal(resp.body.accounts.length, 0);
    });
  });
};
