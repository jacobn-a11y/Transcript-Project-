const Bottleneck = require('bottleneck');

/**
 * Creates a rate limiter that respects the lowest per-second limit
 * among all configured providers.
 */
function createRateLimiter(callsPerSecond = 3) {
  const limiter = new Bottleneck({
    reservoir: callsPerSecond,
    reservoirRefreshAmount: callsPerSecond,
    reservoirRefreshInterval: 1000,
    maxConcurrent: 1,
    minTime: Math.ceil(1000 / callsPerSecond),
  });

  limiter.on('failed', async (error, jobInfo) => {
    if (error.response && error.response.status === 429) {
      const retryAfter = error.response.headers['retry-after'];
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 5000;
      console.log(`Rate limited. Waiting ${waitMs}ms before retry...`);
      return waitMs;
    }
    return null;
  });

  limiter.on('retry', (error, jobInfo) => {
    console.log(`Retrying job (attempt ${jobInfo.retryCount + 1})...`);
  });

  return limiter;
}

module.exports = { createRateLimiter };
