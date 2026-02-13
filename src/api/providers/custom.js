const axios = require('axios');
const BaseProvider = require('../base-provider');

/**
 * Custom API provider that allows users to connect any call recording service
 * by mapping its API fields to the standard schema (Gong or Grain fields).
 *
 * The setup wizard captures:
 * - Base URL
 * - Auth method and credentials
 * - Endpoints for: list accounts, list calls, get call detail
 * - Field mappings from the external API to our canonical schema
 * - Rate limit
 */
class CustomProvider extends BaseProvider {
  constructor(config) {
    super(config.providerName || 'Custom', config);
    this.baseUrl = config.baseUrl;
    this.authType = config.authType; // 'bearer', 'basic', 'apikey-header', 'apikey-query'
    this.authConfig = config.authConfig; // { token, username, password, headerName, queryParam }
    this.endpoints = config.endpoints; // { accounts, calls, callDetail }
    this.fieldMaps = config.fieldMaps; // { accounts, calls, callDetail }
    this.rateLimit = config.rateLimit || 3;
    this.paginationConfig = config.pagination || { type: 'none' };
  }

  getRateLimit() {
    return this.rateLimit;
  }

  _buildHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (this.authType === 'bearer') {
      headers['Authorization'] = `Bearer ${this.authConfig.token}`;
    } else if (this.authType === 'apikey-header') {
      headers[this.authConfig.headerName || 'X-API-Key'] = this.authConfig.token;
    }
    return headers;
  }

  _buildAuth() {
    if (this.authType === 'basic') {
      return {
        username: this.authConfig.username,
        password: this.authConfig.password,
      };
    }
    return undefined;
  }

  _buildParams(extraParams = {}) {
    const params = { ...extraParams };
    if (this.authType === 'apikey-query') {
      params[this.authConfig.queryParam || 'api_key'] = this.authConfig.token;
    }
    return params;
  }

  async _request(method, url, data = null, params = null) {
    return this.throttledRequest(async () => {
      const response = await axios({
        method,
        url,
        data,
        params: this._buildParams(params || {}),
        headers: this._buildHeaders(),
        auth: this._buildAuth(),
      });
      return response.data;
    });
  }

  async testConnection() {
    try {
      const endpoint = this.endpoints.accounts || this.endpoints.calls;
      const url = `${this.baseUrl}${endpoint.path}`;
      await this._request(endpoint.method || 'get', url);
      return { success: true, message: `Connected to ${this.name}.` };
    } catch (e) {
      return { success: false, message: `Connection failed: ${e.message}` };
    }
  }

  /**
   * Extract a nested field value using dot-notation path.
   * e.g., extractField(obj, 'data.company.name') -> obj.data.company.name
   */
  _extractField(obj, path) {
    if (!path) return undefined;
    return path.split('.').reduce((curr, key) => {
      if (curr === undefined || curr === null) return undefined;
      // Support array index: items[0].name
      const arrMatch = key.match(/^(\w+)\[(\d+)\]$/);
      if (arrMatch) {
        return (curr[arrMatch[1]] || [])[parseInt(arrMatch[2], 10)];
      }
      return curr[key];
    }, obj);
  }

  /**
   * Extract array data from response using the configured array path.
   */
  _extractArray(responseData, arrayPath) {
    if (!arrayPath) {
      return Array.isArray(responseData) ? responseData : [responseData];
    }
    const arr = this._extractField(responseData, arrayPath);
    return Array.isArray(arr) ? arr : [];
  }

  async _paginatedFetch(endpointConfig) {
    const allItems = [];
    let page = 1;
    let cursor = null;
    let hasMore = true;

    while (hasMore) {
      const params = { ...(endpointConfig.defaultParams || {}) };

      if (this.paginationConfig.type === 'cursor') {
        if (cursor) params[this.paginationConfig.cursorParam || 'cursor'] = cursor;
      } else if (this.paginationConfig.type === 'page') {
        params[this.paginationConfig.pageParam || 'page'] = page;
      } else if (this.paginationConfig.type === 'offset') {
        params[this.paginationConfig.offsetParam || 'offset'] = allItems.length;
        params[this.paginationConfig.limitParam || 'limit'] = this.paginationConfig.pageSize || 100;
      }

      const url = `${this.baseUrl}${endpointConfig.path}`;
      const data = await this._request(endpointConfig.method || 'get', url, null, params);

      const items = this._extractArray(data, endpointConfig.arrayPath);
      allItems.push(...items);

      if (this.paginationConfig.type === 'cursor') {
        cursor = this._extractField(data, this.paginationConfig.cursorPath);
        hasMore = !!cursor;
      } else if (this.paginationConfig.type === 'page') {
        const total = this._extractField(data, this.paginationConfig.totalPath);
        hasMore = total ? allItems.length < total : items.length > 0;
        page++;
      } else if (this.paginationConfig.type === 'offset') {
        hasMore = items.length >= (this.paginationConfig.pageSize || 100);
      } else {
        hasMore = false;
      }

      // Safety: max 200 pages
      if (page > 200) break;
    }

    return allItems;
  }

  async getAccounts() {
    if (!this.endpoints.accounts) {
      return [{ id: 'all', name: `(All ${this.name} Calls)`, source: this.name }];
    }

    const endpointConfig = this.endpoints.accounts;
    const items = await this._paginatedFetch(endpointConfig);
    const map = this.fieldMaps.accounts;

    return items.map(item => ({
      id: String(this._extractField(item, map.id) || ''),
      name: String(this._extractField(item, map.name) || 'Unknown'),
      source: this.name,
    }));
  }

  async getCallsForAccount(accountId) {
    const endpointConfig = { ...this.endpoints.calls };

    // Replace {accountId} placeholder in path
    if (endpointConfig.path) {
      endpointConfig.path = endpointConfig.path.replace('{accountId}', accountId);
    }
    if (!endpointConfig.defaultParams) endpointConfig.defaultParams = {};
    if (endpointConfig.accountParam) {
      endpointConfig.defaultParams[endpointConfig.accountParam] = accountId;
    }

    const items = await this._paginatedFetch(endpointConfig);
    const map = this.fieldMaps.calls;

    return items.map(item => ({
      id: String(this._extractField(item, map.id) || ''),
      title: String(this._extractField(item, map.title) || 'Untitled'),
      date: String(this._extractField(item, map.date) || new Date().toISOString()),
      duration: Number(this._extractField(item, map.duration) || 0),
      accountId,
      accountName: String(this._extractField(item, map.accountName) || ''),
      source: this.name,
    }));
  }

  async getCallDetail(callId) {
    const endpointConfig = this.endpoints.callDetail;
    const path = endpointConfig.path.replace('{callId}', callId);
    const url = `${this.baseUrl}${path}`;
    const data = await this._request(endpointConfig.method || 'get', url);
    const map = this.fieldMaps.callDetail;

    // Extract speakers
    const speakersRaw = this._extractArray(data, map.speakersPath);
    const speakers = speakersRaw.map(s => ({
      name: String(this._extractField(s, map.speakerName) || 'Unknown'),
      email: String(this._extractField(s, map.speakerEmail) || ''),
      role: String(this._extractField(s, map.speakerRole) || 'external'),
    }));

    // Extract transcript
    const transcriptRaw = this._extractArray(data, map.transcriptPath);
    const transcript = transcriptRaw.map(t => ({
      speaker: String(this._extractField(t, map.transcriptSpeaker) || 'Unknown'),
      text: String(this._extractField(t, map.transcriptText) || ''),
      startMs: Number(this._extractField(t, map.transcriptStart) || 0),
      endMs: Number(this._extractField(t, map.transcriptEnd) || 0),
    }));

    return {
      id: callId,
      title: String(this._extractField(data, map.title) || 'Untitled'),
      date: String(this._extractField(data, map.date) || new Date().toISOString()),
      duration: Number(this._extractField(data, map.duration) || 0),
      accountName: String(this._extractField(data, map.accountName) || ''),
      source: this.name,
      speakers,
      summary: String(this._extractField(data, map.summary) || ''),
      outline: String(this._extractField(data, map.outline) || ''),
      keyPoints: String(this._extractField(data, map.keyPoints) || ''),
      transcript,
    };
  }

  /** Serialize the full config for saving/restoring */
  toJSON() {
    return {
      providerName: this.name,
      baseUrl: this.baseUrl,
      authType: this.authType,
      authConfig: this.authConfig,
      endpoints: this.endpoints,
      fieldMaps: this.fieldMaps,
      rateLimit: this.rateLimit,
      pagination: this.paginationConfig,
    };
  }

  static fromJSON(json) {
    return new CustomProvider(json);
  }
}

module.exports = CustomProvider;
