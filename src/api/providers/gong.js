const axios = require('axios');
const BaseProvider = require('../base-provider');

class GongProvider extends BaseProvider {
  constructor(config) {
    super('Gong', config);
    this.baseUrl = config.baseUrl || 'https://api.gong.io/v2';
    this.auth = {
      username: config.accessKey,
      password: config.accessKeySecret,
    };
  }

  getRateLimit() {
    // Gong documents ~10,000 requests/day. To be safe we use ~1 req/sec
    // which equals ~3600/hour, well under the daily cap.
    return 1;
  }

  async _request(method, path, data = null, params = null) {
    return this.throttledRequest(async () => {
      const response = await axios({
        method,
        url: `${this.baseUrl}${path}`,
        auth: this.auth,
        data,
        params,
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
      });
      return response.data;
    });
  }

  async testConnection() {
    await this._request('get', '/users');
    return { success: true, message: 'Connected to Gong.' };
  }

  /**
   * Discover accounts. Strategy (in order of preference):
   *  1. Try the CRM objects endpoint (cheapest — 1 API call)
   *  2. Scan recent calls for CRM account context (capped at MAX_PAGES)
   *  3. Fall back to domain extraction from external participants
   *  4. Offer "(All Gong Calls)" bucket
   */
  async getAccounts() {
    const accounts = new Map();

    // Strategy 1: CRM accounts endpoint (single call)
    try {
      const crmData = await this._request('get', '/crm/object/list', null, {
        objectType: 'Account',
      });
      for (const obj of (crmData.objects || [])) {
        const name = (obj.fields && (obj.fields.name || obj.fields.Name)) || obj.objectId;
        accounts.set(obj.objectId, { id: obj.objectId, name, source: 'Gong' });
      }
      if (accounts.size > 0) return Array.from(accounts.values());
    } catch {
      // CRM endpoint may not be available — fall through
    }

    // Strategy 2: Scan recent calls (capped to avoid burning API quota)
    const MAX_PAGES = 5;
    let cursor = null;
    let pages = 0;
    const now = new Date().toISOString();
    const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();

    do {
      const payload = {
        filter: { fromDateTime: oneYearAgo, toDateTime: now },
        contentSelector: {
          context: 'Extended',
          exposedFields: {
            parties: true,
            content: { brief: false },
          },
        },
      };
      if (cursor) payload.cursor = cursor;

      const data = await this._request('post', '/calls/extensive', payload);

      for (const call of (data.calls || [])) {
        this._extractAccountsFromCall(call, accounts);
      }

      cursor = (data.records && data.records.cursor) || data.cursor || null;
      pages++;
    } while (cursor && pages < MAX_PAGES);

    if (accounts.size > 0) return Array.from(accounts.values());

    // Strategy 3: Final fallback
    accounts.set('all', { id: 'all', name: '(All Gong Calls)', source: 'Gong' });
    return Array.from(accounts.values());
  }

  /** Extract CRM accounts and domain-based accounts from a single call. */
  _extractAccountsFromCall(call, accounts) {
    for (const party of (call.parties || [])) {
      if (party.affiliation !== 'External') continue;

      // CRM context
      for (const ctx of (party.context || [])) {
        if (ctx.system === 'CRM' && ctx.objects) {
          for (const obj of ctx.objects) {
            if (obj.objectType === 'Account' && obj.fields) {
              const name = obj.fields.name || obj.fields.Name;
              const id = obj.objectId || name;
              if (name && !accounts.has(id)) {
                accounts.set(id, { id, name, source: 'Gong' });
              }
            }
          }
        }
      }

      // Domain fallback
      if (party.emailAddress) {
        const domain = party.emailAddress.split('@')[1];
        if (domain && !domain.match(/(gmail|yahoo|hotmail|outlook|icloud|aol|proton)\./i)) {
          const id = `domain:${domain}`;
          if (!accounts.has(id)) {
            accounts.set(id, { id, name: this._capitalize(domain.split('.')[0]), source: 'Gong' });
          }
        }
      }
    }
  }

  /**
   * Fetch all calls associated with a given account.
   * @param {string} accountId
   * @param {object} [options]
   * @param {function} [options.onProgress] - Called with (message) on each page
   */
  async getCallsForAccount(accountId, options = {}) {
    const onProgress = options.onProgress || (() => {});
    const calls = [];
    let cursor = null;
    let page = 0;
    const now = new Date().toISOString();
    const threeYearsAgo = new Date(Date.now() - 3 * 365 * 24 * 60 * 60 * 1000).toISOString();

    do {
      page++;
      onProgress(`Scanning Gong calls (page ${page}, ${calls.length} matches so far)...`);

      const payload = {
        filter: { fromDateTime: threeYearsAgo, toDateTime: now },
        contentSelector: {
          context: 'Extended',
          exposedFields: {
            parties: true,
            content: { brief: true },
          },
        },
      };
      if (cursor) payload.cursor = cursor;

      const data = await this._request('post', '/calls/extensive', payload);

      for (const call of (data.calls || [])) {
        if (this._callMatchesAccount(call, accountId)) {
          calls.push({
            id: call.metaData.id,
            title: call.metaData.title || 'Untitled Call',
            date: call.metaData.started,
            duration: call.metaData.duration,
            accountId,
            accountName: this._getAccountNameFromCall(call, accountId),
            source: 'Gong',
          });
        }
      }

      cursor = (data.records && data.records.cursor) || data.cursor || null;
    } while (cursor);

    return calls;
  }

  /**
   * Fetch ALL calls in a single pass, extracting account names from each call's metadata.
   */
  async getAllCalls(options = {}) {
    const onProgress = (options && options.onProgress) || (() => {});
    const calls = [];
    let cursor = null;
    let page = 0;
    const now = new Date().toISOString();
    const threeYearsAgo = new Date(Date.now() - 3 * 365 * 24 * 60 * 60 * 1000).toISOString();

    do {
      page++;
      onProgress(`Scanning all Gong calls (page ${page}, ${calls.length} calls so far)...`);

      const payload = {
        filter: { fromDateTime: threeYearsAgo, toDateTime: now },
        contentSelector: {
          context: 'Extended',
          exposedFields: {
            parties: true,
            content: { brief: true },
          },
        },
      };
      if (cursor) payload.cursor = cursor;

      const data = await this._request('post', '/calls/extensive', payload);

      for (const call of (data.calls || [])) {
        const accountName = this._getAccountNameFromCall(call, null);
        calls.push({
          id: call.metaData.id,
          title: call.metaData.title || 'Untitled Call',
          date: call.metaData.started,
          duration: call.metaData.duration,
          accountId: 'all',
          accountName: accountName || 'Unknown',
          source: 'Gong',
        });
      }

      cursor = (data.records && data.records.cursor) || data.cursor || null;
    } while (cursor);

    return calls;
  }

  /**
   * Fetch full call detail with transcript, speakers, and summaries.
   */
  async getCallDetail(callId) {
    const extensivePayload = {
      filter: { callIds: [callId] },
      contentSelector: {
        context: 'Extended',
        exposedFields: {
          parties: true,
          content: {
            brief: true,
            outline: true,
            highlights: true,
            keyPoints: true,
            callOutcome: true,
            topics: true,
          },
          interaction: {
            speakers: true,
            personInteractionStats: true,
          },
        },
      },
    };

    const [extensiveData, transcriptData] = await Promise.all([
      this._request('post', '/calls/extensive', extensivePayload),
      this._request('post', '/calls/transcript', {
        filter: { callIds: [callId] },
      }),
    ]);

    const call = (extensiveData.calls || [])[0];
    const transcriptRecord = (transcriptData.callTranscripts || [])[0];

    if (!call) {
      throw new Error(`Call ${callId} not found in Gong`);
    }

    // Build speaker map: speakerId -> name
    const speakerMap = {};
    const speakers = [];
    for (const party of (call.parties || [])) {
      speakerMap[party.speakerId] = party.name || party.emailAddress || 'Unknown';
      speakers.push({
        name: party.name || 'Unknown',
        email: party.emailAddress || '',
        role: party.affiliation === 'Internal' ? 'internal' : 'external',
        title: party.title || '',
      });
    }

    // Build transcript
    const transcript = [];
    if (transcriptRecord && transcriptRecord.transcript) {
      for (const monologue of transcriptRecord.transcript) {
        const speakerName = speakerMap[monologue.speakerId] || `Speaker ${monologue.speakerId}`;
        for (const sentence of (monologue.sentences || [])) {
          transcript.push({
            speaker: speakerName,
            text: sentence.text,
            startMs: sentence.start,
            endMs: sentence.end,
          });
        }
      }
    }

    // Extract summaries
    const content = call.content || {};
    const summaryParts = [];
    if (content.brief) summaryParts.push(content.brief);
    const summary = summaryParts.join('\n\n') || '';

    const outlineParts = [];
    if (content.outline) {
      for (const item of content.outline) {
        outlineParts.push(`- ${item.text || item}`);
      }
    }

    const keyPointParts = [];
    if (content.keyPoints) {
      for (const item of content.keyPoints) {
        keyPointParts.push(`- ${item.text || item}`);
      }
    }

    return {
      id: callId,
      title: call.metaData.title || 'Untitled Call',
      date: call.metaData.started,
      duration: call.metaData.duration,
      accountName: this._getAccountNameFromCall(call, null),
      source: 'Gong',
      speakers,
      summary,
      outline: outlineParts.join('\n') || '',
      keyPoints: keyPointParts.join('\n') || '',
      transcript,
    };
  }

  _callMatchesAccount(call, accountId) {
    if (accountId === 'all') return true;

    for (const party of (call.parties || [])) {
      if (party.affiliation === 'External') {
        for (const ctx of (party.context || [])) {
          if (ctx.system === 'CRM' && ctx.objects) {
            for (const obj of ctx.objects) {
              if (obj.objectId === accountId) return true;
            }
          }
        }
        if (accountId.startsWith('domain:') && party.emailAddress) {
          const domain = party.emailAddress.split('@')[1];
          if (`domain:${domain}` === accountId) return true;
        }
      }
    }
    return false;
  }

  _getAccountNameFromCall(call, accountId) {
    for (const party of (call.parties || [])) {
      if (party.affiliation === 'External') {
        for (const ctx of (party.context || [])) {
          if (ctx.system === 'CRM' && ctx.objects) {
            for (const obj of ctx.objects) {
              if (obj.objectType === 'Account' && obj.fields) {
                return obj.fields.name || obj.fields.Name || '';
              }
            }
          }
        }
      }
    }
    return '';
  }

  _capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
}

module.exports = GongProvider;
