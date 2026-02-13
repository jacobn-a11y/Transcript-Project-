module.exports = function (describe, assert) {
  const GongProvider = require('../src/api/providers/gong');

  describe('GongProvider — Configuration', (it) => {
    it('sets default base URL', () => {
      const p = new GongProvider({ accessKey: 'k', accessKeySecret: 's' });
      assert.equal(p.baseUrl, 'https://api.gong.io/v2');
    });

    it('allows custom base URL', () => {
      const p = new GongProvider({ accessKey: 'k', accessKeySecret: 's', baseUrl: 'https://custom.gong.io/v2' });
      assert.equal(p.baseUrl, 'https://custom.gong.io/v2');
    });

    it('getRateLimit() returns 1', () => {
      const p = new GongProvider({ accessKey: 'k', accessKeySecret: 's' });
      assert.equal(p.getRateLimit(), 1);
    });

    it('sets basic auth from access key pair', () => {
      const p = new GongProvider({ accessKey: 'myKey', accessKeySecret: 'mySecret' });
      assert.equal(p.auth.username, 'myKey');
      assert.equal(p.auth.password, 'mySecret');
    });
  });

  describe('GongProvider — Internal helpers', (it) => {
    const p = new GongProvider({ accessKey: 'k', accessKeySecret: 's' });

    it('_capitalize() works', () => {
      assert.equal(p._capitalize('hello'), 'Hello');
      assert.equal(p._capitalize('A'), 'A');
    });

    it('_callMatchesAccount() matches "all"', () => {
      assert.ok(p._callMatchesAccount({}, 'all'));
    });

    it('_callMatchesAccount() matches domain-based account', () => {
      const call = {
        parties: [{
          affiliation: 'External',
          emailAddress: 'bob@acme.com',
          context: [],
        }],
      };
      assert.ok(p._callMatchesAccount(call, 'domain:acme.com'));
      assert.ok(!p._callMatchesAccount(call, 'domain:other.com'));
    });

    it('_callMatchesAccount() matches CRM account ID', () => {
      const call = {
        parties: [{
          affiliation: 'External',
          context: [{
            system: 'CRM',
            objects: [{ objectId: 'acc-123', objectType: 'Account', fields: { name: 'Acme' } }],
          }],
        }],
      };
      assert.ok(p._callMatchesAccount(call, 'acc-123'));
      assert.ok(!p._callMatchesAccount(call, 'acc-999'));
    });

    it('_callMatchesAccount() matches CRM account by name fallback', () => {
      const call = {
        parties: [{
          affiliation: 'External',
          context: [{
            system: 'CRM',
            objects: [{ objectId: 'acc-123', objectType: 'Account', fields: { name: 'Lionakis' } }],
          }],
        }],
      };
      // When account was discovered with name as ID (objectId missing during discovery)
      assert.ok(p._callMatchesAccount(call, 'Lionakis'));
      assert.ok(!p._callMatchesAccount(call, 'OtherCompany'));
    });

    it('_getAccountNameFromCall() extracts CRM account name', () => {
      const call = {
        parties: [{
          affiliation: 'External',
          context: [{
            system: 'CRM',
            objects: [{ objectType: 'Account', fields: { name: 'BigCorp' } }],
          }],
        }],
      };
      assert.equal(p._getAccountNameFromCall(call, 'x'), 'BigCorp');
    });

    it('_getAccountNameFromCall() returns empty for no CRM data', () => {
      const call = { parties: [{ affiliation: 'Internal', context: [] }] };
      assert.equal(p._getAccountNameFromCall(call, null), '');
    });
  });
};
