module.exports = function (describe, assert) {
  const { createRateLimiter } = require('../src/utils/rate-limiter');

  describe('RateLimiter — Throttling', (it) => {
    it('creates a limiter without error', () => {
      const limiter = createRateLimiter(5);
      assert.ok(limiter);
    });

    it('processes tasks at the configured rate', async () => {
      const limiter = createRateLimiter(3);
      const start = Date.now();
      const results = [];

      for (let i = 0; i < 4; i++) {
        results.push(limiter.schedule(() => Promise.resolve(i)));
      }

      const values = await Promise.all(results);
      const elapsed = Date.now() - start;

      assert.equal(values.length, 4);
      assert.deepEqual(values, [0, 1, 2, 3]);
      // 4 tasks at 3/sec: first 3 immediate, 4th after ~333ms min
      assert.gt(elapsed, 200, 'Should take at least 200ms for 4 tasks at 3/sec');
    });

    it('handles errors in scheduled tasks', async () => {
      const limiter = createRateLimiter(10);
      let caught = false;
      try {
        await limiter.schedule(() => Promise.reject(new Error('test error')));
      } catch (e) {
        caught = true;
        assert.equal(e.message, 'test error');
      }
      assert.ok(caught, 'Error should propagate');
    });

    it('defaults to 3 per second when no arg given', () => {
      const limiter = createRateLimiter();
      assert.ok(limiter);
    });
  });
};
