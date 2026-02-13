const axios = require('axios');
const BaseProvider = require('../base-provider');

class GrainProvider extends BaseProvider {
  constructor(config) {
    super('Grain', config);
    this.baseUrl = config.baseUrl || 'https://api.grain.com/_/public-api';
    this.apiKey = config.apiKey;
  }

  getRateLimit() {
    // Grain doesn't publish rate limits; use a conservative default
    return 5;
  }

  async _request(method, path, data = null, params = null) {
    return this.throttledRequest(async () => {
      const response = await axios({
        method,
        url: `${this.baseUrl}${path}`,
        data,
        params,
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      });
      return response.data;
    });
  }

  async testConnection() {
    const data = await this._request('get', '/me');
    return { success: true, message: `Connected as ${data.name || data.email || 'user'}.` };
  }

  /**
   * Grain doesn't have an explicit accounts endpoint.
   * We fetch all recordings and extract unique account/company names
   * from meeting titles and participant info.
   */
  async getAccounts() {
    const accounts = new Map();
    const recordings = await this._getAllRecordings();

    for (const rec of recordings) {
      // Try to extract company from title patterns like "Company - Meeting" or "Meeting with Company"
      const title = rec.title || '';

      // Extract participant companies if available in metadata
      if (rec.participants) {
        for (const p of rec.participants) {
          if (p.company) {
            const id = `company:${p.company.toLowerCase()}`;
            if (!accounts.has(id)) {
              accounts.set(id, { id, name: p.company, source: 'Grain' });
            }
          } else if (p.email) {
            const domain = p.email.split('@')[1];
            if (domain && !domain.match(/(gmail|yahoo|hotmail|outlook)\./)) {
              const name = domain.split('.')[0];
              const id = `domain:${domain}`;
              if (!accounts.has(id)) {
                accounts.set(id, {
                  id,
                  name: name.charAt(0).toUpperCase() + name.slice(1),
                  source: 'Grain',
                });
              }
            }
          }
        }
      }

      // If no participant data, try to extract from title
      if (accounts.size === 0 && title) {
        // Common patterns: "Company - Topic", "Call with Company", "Company <> Us"
        const patterns = [
          /^(.+?)\s*[-–—]\s*/,
          /(?:call|meeting|demo|sync)\s+with\s+(.+?)(?:\s*[-–—]|$)/i,
          /^(.+?)\s*<>\s*/,
        ];
        for (const pattern of patterns) {
          const match = title.match(pattern);
          if (match && match[1]) {
            const name = match[1].trim();
            const id = `title:${name.toLowerCase()}`;
            if (!accounts.has(id) && name.length > 1 && name.length < 60) {
              accounts.set(id, { id, name, source: 'Grain' });
            }
            break;
          }
        }
      }
    }

    // Fallback: group recordings by unique title prefixes
    if (accounts.size === 0 && recordings.length > 0) {
      accounts.set('all', { id: 'all', name: '(All Grain Recordings)', source: 'Grain' });
    }

    return Array.from(accounts.values());
  }

  async getCallsForAccount(accountId) {
    const recordings = await this._getAllRecordings();
    const calls = [];

    for (const rec of recordings) {
      if (this._recordingMatchesAccount(rec, accountId)) {
        calls.push({
          id: rec.id,
          title: rec.title || 'Untitled Recording',
          date: rec.date || rec.created_at || rec.start_time || new Date().toISOString(),
          accountId,
          accountName: this._extractAccountName(rec, accountId),
          source: 'Grain',
        });
      }
    }

    return calls;
  }

  async getCallDetail(callId) {
    // Fetch recording with transcript and intelligence notes
    const data = await this._request('get', `/recordings/${callId}`, null, {
      transcript_format: 'json',
      intelligence_notes_format: 'md',
    });

    const speakers = [];
    if (data.participants) {
      for (const p of data.participants) {
        speakers.push({
          name: p.name || p.email || 'Unknown',
          email: p.email || '',
          role: p.is_host ? 'internal' : 'external',
        });
      }
    }

    // Parse transcript
    const transcript = [];
    if (data.transcript) {
      if (Array.isArray(data.transcript)) {
        for (const entry of data.transcript) {
          transcript.push({
            speaker: entry.speaker || entry.speaker_name || 'Unknown',
            text: entry.text || entry.content || '',
            startMs: entry.start_time ? entry.start_time * 1000 : (entry.start || 0),
            endMs: entry.end_time ? entry.end_time * 1000 : (entry.end || 0),
          });
        }
      } else if (typeof data.transcript === 'string') {
        // VTT or plain text - parse as single block
        transcript.push({
          speaker: 'Unknown',
          text: data.transcript,
          startMs: 0,
          endMs: 0,
        });
      }
    }

    // Extract summary from intelligence notes
    let summary = '';
    let keyPoints = '';
    if (data.intelligence_notes) {
      if (typeof data.intelligence_notes === 'string') {
        summary = data.intelligence_notes;
      } else if (data.intelligence_notes.summary) {
        summary = data.intelligence_notes.summary;
      }
      if (data.intelligence_notes.key_points) {
        keyPoints = Array.isArray(data.intelligence_notes.key_points)
          ? data.intelligence_notes.key_points.map(p => `- ${p}`).join('\n')
          : data.intelligence_notes.key_points;
      }
    }

    return {
      id: callId,
      title: data.title || 'Untitled Recording',
      date: data.date || data.created_at || data.start_time || new Date().toISOString(),
      duration: data.duration || 0,
      accountName: '',
      source: 'Grain',
      speakers,
      summary,
      outline: '',
      keyPoints,
      transcript,
    };
  }

  async _getAllRecordings() {
    const recordings = [];
    let cursor = null;

    do {
      const params = {};
      if (cursor) params.cursor = cursor;

      const data = await this._request('get', '/recordings', null, params);

      if (Array.isArray(data)) {
        recordings.push(...data);
        cursor = null; // No pagination info in flat array
      } else if (data.recordings) {
        recordings.push(...data.recordings);
        cursor = data.next_cursor || data.cursor || null;
      } else {
        cursor = null;
      }
    } while (cursor);

    return recordings;
  }

  _recordingMatchesAccount(recording, accountId) {
    if (accountId === 'all') return true;

    if (accountId.startsWith('company:')) {
      const companyName = accountId.replace('company:', '');
      if (recording.participants) {
        return recording.participants.some(
          p => p.company && p.company.toLowerCase() === companyName
        );
      }
    }

    if (accountId.startsWith('domain:')) {
      const domain = accountId.replace('domain:', '');
      if (recording.participants) {
        return recording.participants.some(
          p => p.email && p.email.split('@')[1] === domain
        );
      }
    }

    if (accountId.startsWith('title:')) {
      const titlePrefix = accountId.replace('title:', '');
      return (recording.title || '').toLowerCase().includes(titlePrefix);
    }

    return false;
  }

  _extractAccountName(recording, accountId) {
    if (accountId.startsWith('company:')) {
      return accountId.replace('company:', '').charAt(0).toUpperCase() +
        accountId.replace('company:', '').slice(1);
    }
    if (accountId.startsWith('domain:')) {
      const domain = accountId.replace('domain:', '');
      return domain.split('.')[0].charAt(0).toUpperCase() + domain.split('.')[0].slice(1);
    }
    if (accountId.startsWith('title:')) {
      return accountId.replace('title:', '');
    }
    return '';
  }
}

module.exports = GrainProvider;
