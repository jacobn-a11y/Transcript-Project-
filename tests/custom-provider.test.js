module.exports = function (describe, assert) {
  const CustomProvider = require('../src/api/providers/custom');

  function makeProvider(overrides = {}) {
    return new CustomProvider({
      providerName: 'TestPlatform',
      baseUrl: 'https://api.example.com',
      authType: 'bearer',
      authConfig: { token: 'test-token' },
      rateLimit: 5,
      endpoints: {},
      fieldMaps: {},
      pagination: { type: 'none' },
      ...overrides,
    });
  }

  describe('CustomProvider — Field extraction', (it) => {
    const cp = makeProvider();

    it('extracts simple dot-path fields', () => {
      const obj = { data: { name: 'Acme' } };
      assert.equal(cp._extractField(obj, 'data.name'), 'Acme');
    });

    it('extracts deeply nested fields', () => {
      const obj = { a: { b: { c: { d: 42 } } } };
      assert.equal(cp._extractField(obj, 'a.b.c.d'), 42);
    });

    it('extracts array-indexed fields', () => {
      const obj = { items: [{ name: 'first' }, { name: 'second' }] };
      assert.equal(cp._extractField(obj, 'items[0].name'), 'first');
      assert.equal(cp._extractField(obj, 'items[1].name'), 'second');
    });

    it('returns undefined for missing paths', () => {
      assert.equal(cp._extractField({ a: 1 }, 'b.c'), undefined);
      assert.equal(cp._extractField(null, 'a'), undefined);
      assert.equal(cp._extractField({}, ''), undefined);
    });

    it('handles null in the middle of a path', () => {
      const obj = { a: { b: null } };
      assert.equal(cp._extractField(obj, 'a.b.c'), undefined);
    });
  });

  describe('CustomProvider — Array extraction', (it) => {
    const cp = makeProvider();

    it('extracts array at path', () => {
      const arr = cp._extractArray({ data: { items: [1, 2, 3] } }, 'data.items');
      assert.deepEqual(arr, [1, 2, 3]);
    });

    it('returns raw array when path is null', () => {
      const arr = cp._extractArray([4, 5], null);
      assert.deepEqual(arr, [4, 5]);
    });

    it('wraps non-array in array when path is null', () => {
      const arr = cp._extractArray({ single: true }, null);
      assert.deepEqual(arr, [{ single: true }]);
    });

    it('returns empty array for missing path', () => {
      const arr = cp._extractArray({}, 'nonexistent');
      assert.deepEqual(arr, []);
    });
  });

  describe('CustomProvider — Serialization', (it) => {
    it('toJSON() and fromJSON() round-trip', () => {
      const cp = makeProvider({ rateLimit: 7 });
      const json = cp.toJSON();
      assert.equal(json.providerName, 'TestPlatform');
      assert.equal(json.rateLimit, 7);

      const restored = CustomProvider.fromJSON(json);
      assert.equal(restored.name, 'TestPlatform');
      assert.equal(restored.getRateLimit(), 7);
      assert.equal(restored.baseUrl, 'https://api.example.com');
    });
  });

  describe('CustomProvider — Auth headers', (it) => {
    it('bearer auth sets Authorization header', () => {
      const cp = makeProvider({ authType: 'bearer', authConfig: { token: 'abc' } });
      const headers = cp._buildHeaders();
      assert.equal(headers['Authorization'], 'Bearer abc');
    });

    it('apikey-header sets custom header', () => {
      const cp = makeProvider({
        authType: 'apikey-header',
        authConfig: { token: 'key123', headerName: 'X-Custom-Key' },
      });
      const headers = cp._buildHeaders();
      assert.equal(headers['X-Custom-Key'], 'key123');
    });

    it('basic auth returns username/password', () => {
      const cp = makeProvider({
        authType: 'basic',
        authConfig: { username: 'user', password: 'pass' },
      });
      const auth = cp._buildAuth();
      assert.deepEqual(auth, { username: 'user', password: 'pass' });
    });

    it('apikey-query adds to params', () => {
      const cp = makeProvider({
        authType: 'apikey-query',
        authConfig: { token: 'qkey', queryParam: 'api_key' },
      });
      const params = cp._buildParams({ page: 1 });
      assert.equal(params.api_key, 'qkey');
      assert.equal(params.page, 1);
    });
  });

  describe('CustomProvider — Configuration', (it) => {
    it('getRateLimit() returns configured value', () => {
      assert.equal(makeProvider({ rateLimit: 10 }).getRateLimit(), 10);
      assert.equal(makeProvider({ rateLimit: 1 }).getRateLimit(), 1);
    });

    it('defaults to 3 when rateLimit not specified', () => {
      const cp = new CustomProvider({
        providerName: 'Test',
        baseUrl: 'https://api.test.com',
        authType: 'bearer',
        authConfig: { token: 't' },
        endpoints: {},
        fieldMaps: {},
      });
      assert.equal(cp.getRateLimit(), 3);
    });
  });
};
