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
    return 3; // 3 requests per second
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
      });
      return response.data;
    });
  }

  async testConnection() {
    const data = await this._request('get', '/users', null, {
      fromDateTime: '2020-01-01T00:00:00Z',
      toDateTime: new Date().toISOString(),
    });
    return { success: true, message: `Connected. Found users.` };
  }

  /**
   * Gong doesn't have a direct "list accounts" endpoint.
   * We fetch calls with extended context and extract unique account names
   * from the CRM context and party affiliations.
   */
  async getAccounts() {
    const accounts = new Map();
    let cursor = null;

    // Fetch calls in large date range to discover accounts
    const now = new Date().toISOString();
    const threeYearsAgo = new Date(Date.now() - 3 * 365 * 24 * 60 * 60 * 1000).toISOString();

    do {
      const payload = {
        filter: {
          fromDateTime: threeYearsAgo,
          toDateTime: now,
        },
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
        // Extract account info from parties' context
        for (const party of (call.parties || [])) {
          if (party.affiliation === 'External') {
            // Try to get company from context
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
            // Fallback: use emailAddress domain as company identifier
            if (party.emailAddress && accounts.size === 0) {
              const domain = party.emailAddress.split('@')[1];
              if (domain && !domain.match(/(gmail|yahoo|hotmail|outlook)\./)) {
                const name = domain.split('.')[0];
                const id = `domain:${domain}`;
                if (!accounts.has(id)) {
                  accounts.set(id, { id, name: this._capitalize(name), source: 'Gong' });
                }
              }
            }
          }
        }

        // Also extract from call title if it contains company references
        if (call.metaData && call.metaData.title) {
          // Store call titles for later matching if needed
        }
      }

      cursor = data.records && data.records.cursor ? data.records.cursor : null;
    } while (cursor);

    // If no CRM accounts found, try the CRM objects endpoint
    if (accounts.size === 0) {
      try {
        const crmData = await this._request('get', '/crm/object/list', null, {
          objectType: 'Account',
        });
        for (const obj of (crmData.objects || [])) {
          const name = (obj.fields && (obj.fields.name || obj.fields.Name)) || obj.objectId;
          accounts.set(obj.objectId, { id: obj.objectId, name, source: 'Gong' });
        }
      } catch (e) {
        // CRM endpoint may not be available
      }
    }

    // Final fallback: extract unique external participant domains from calls
    if (accounts.size === 0) {
      accounts.set('all', { id: 'all', name: '(All Gong Calls)', source: 'Gong' });
    }

    return Array.from(accounts.values());
  }

  /**
   * Fetch all calls associated with a given account.
   */
  async getCallsForAccount(accountId) {
    const calls = [];
    let cursor = null;
    const now = new Date().toISOString();
    const threeYearsAgo = new Date(Date.now() - 3 * 365 * 24 * 60 * 60 * 1000).toISOString();

    do {
      const payload = {
        filter: {
          fromDateTime: threeYearsAgo,
          toDateTime: now,
        },
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

      cursor = data.records && data.records.cursor ? data.records.cursor : null;
    } while (cursor);

    return calls;
  }

  /**
   * Fetch full call detail with transcript, speakers, and summaries.
   */
  async getCallDetail(callId) {
    // Fetch call metadata and content
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
        // Domain-based matching
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
