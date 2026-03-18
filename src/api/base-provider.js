/**
 * Base class for all call recording API providers.
 * Each provider must implement these methods to be compatible with the merger.
 */
class BaseProvider {
  constructor(name, config = {}) {
    this.name = name;
    this.config = config;
    this.rateLimiter = null;
  }

  setRateLimiter(limiter) {
    this.rateLimiter = limiter;
  }

  /** Wrap an API call through the rate limiter */
  async throttledRequest(fn) {
    if (this.rateLimiter) {
      return this.rateLimiter.schedule(() => fn());
    }
    return fn();
  }

  /** Return the provider's per-second rate limit */
  getRateLimit() {
    throw new Error(`${this.name}: getRateLimit() not implemented`);
  }

  /** Validate that credentials work */
  async testConnection() {
    throw new Error(`${this.name}: testConnection() not implemented`);
  }

  /**
   * Fetch all accounts/companies.
   * Returns: [{ id, name, source }]
   */
  async getAccounts() {
    throw new Error(`${this.name}: getAccounts() not implemented`);
  }

  /**
   * Fetch all calls for a given account.
   * Returns: [{ id, title, date, accountId, accountName, source }]
   */
  async getCallsForAccount(accountId) {
    throw new Error(`${this.name}: getCallsForAccount() not implemented`);
  }

  /**
   * Fetch ALL calls from this provider in a single pass (no account filtering).
   * Returns: [{ id, title, date, accountId, accountName, source }]
   * Default implementation falls back to getCallsForAccount('all').
   */
  async getAllCalls(options = {}) {
    return this.getCallsForAccount('all', options);
  }

  /**
   * Fetch full call detail including transcript.
   * Returns: {
   *   id, title, date, duration,
   *   accountName, source,
   *   speakers: [{ name, email, role }],
   *   summary, outline, keyPoints,
   *   transcript: [{ speaker, text, startMs, endMs }]
   * }
   */
  async getCallDetail(callId) {
    throw new Error(`${this.name}: getCallDetail() not implemented`);
  }

  /**
   * Returns the canonical field schema this provider uses.
   * Used by the custom provider setup wizard to show mapping targets.
   */
  static getFieldSchema() {
    return {
      account: { id: 'string', name: 'string' },
      call: {
        id: 'string',
        title: 'string',
        date: 'ISO-8601 datetime',
        duration: 'number (seconds)',
        accountId: 'string',
        accountName: 'string',
      },
      speaker: { name: 'string', email: 'string', role: 'string (internal/external)' },
      callDetail: {
        summary: 'string',
        outline: 'string',
        keyPoints: 'string',
        transcript: 'array of { speaker, text, startMs, endMs }',
      },
    };
  }
}

module.exports = BaseProvider;
