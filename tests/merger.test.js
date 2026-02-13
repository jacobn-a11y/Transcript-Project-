module.exports = function (describe, assert) {
  const TranscriptMerger = require('../src/services/merger');

  const makeCall = (overrides) => ({
    id: 'c1',
    title: 'Test Call',
    date: '2024-06-15T10:00:00Z',
    duration: 1800,
    accountName: 'Acme',
    source: 'Gong',
    speakers: [],
    summary: '',
    outline: '',
    keyPoints: '',
    transcript: [],
    ...overrides,
  });

  describe('TranscriptMerger — Chronological ordering', (it) => {
    it('sorts calls by date ascending', () => {
      const calls = [
        makeCall({ id: 'c3', title: 'Third', date: '2024-03-01T00:00:00Z' }),
        makeCall({ id: 'c1', title: 'First', date: '2024-01-01T00:00:00Z' }),
        makeCall({ id: 'c2', title: 'Second', date: '2024-02-01T00:00:00Z' }),
      ];
      const { markdown } = new TranscriptMerger(calls).generate();
      const titles = [...markdown.matchAll(/## \d+\. (.+)/g)].map(m => m[1]);
      assert.deepEqual(titles, ['First', 'Second', 'Third']);
    });

    it('handles calls with identical dates', () => {
      const calls = [
        makeCall({ id: 'c1', title: 'A', date: '2024-01-01T10:00:00Z' }),
        makeCall({ id: 'c2', title: 'B', date: '2024-01-01T10:00:00Z' }),
      ];
      const { markdown } = new TranscriptMerger(calls).generate();
      const titles = [...markdown.matchAll(/## \d+\. (.+)/g)].map(m => m[1]);
      assert.equal(titles.length, 2);
    });
  });

  describe('TranscriptMerger — Document structure', (it) => {
    it('includes document header with project name', () => {
      const { markdown } = new TranscriptMerger([makeCall()], {
        projectName: 'My Project',
      }).generate();
      assert.includes(markdown, '# My Project');
    });

    it('includes table of contents', () => {
      const { markdown } = new TranscriptMerger([
        makeCall({ id: 'c1', title: 'Call A' }),
        makeCall({ id: 'c2', title: 'Call B', date: '2024-07-01T00:00:00Z' }),
      ]).generate();
      assert.includes(markdown, '## Table of Contents');
      const tocLines = markdown.split('\n').filter(l => l.match(/^\d+\. \[/));
      assert.equal(tocLines.length, 2);
    });

    it('includes source and account info in header', () => {
      const { markdown } = new TranscriptMerger([makeCall()], {
        selectedAccounts: [{ name: 'Acme', source: 'Gong' }],
      }).generate();
      assert.includes(markdown, '**Accounts:** Acme');
      assert.includes(markdown, '**Sources:** Gong');
    });

    it('includes metadata table per call', () => {
      const { markdown } = new TranscriptMerger([
        makeCall({ duration: 3661 }),
      ]).generate();
      assert.includes(markdown, '| **Source** | Gong |');
      assert.includes(markdown, '| **Duration** | 1h 1m 1s |');
    });
  });

  describe('TranscriptMerger — Speakers', (it) => {
    it('renders speaker list with roles', () => {
      const { markdown } = new TranscriptMerger([
        makeCall({
          speakers: [
            { name: 'Alice', email: 'alice@co.com', role: 'internal', title: 'AE' },
            { name: 'Bob', email: 'bob@acme.com', role: 'external' },
          ],
        }),
      ]).generate();
      assert.includes(markdown, '### Participants');
      assert.includes(markdown, '**Alice**');
      assert.includes(markdown, '**Bob**');
    });

    it('omits participants section when no speakers', () => {
      const { markdown } = new TranscriptMerger([
        makeCall({ speakers: [] }),
      ]).generate();
      // Should NOT include Participants when speakers is empty
      const sections = markdown.split('### Participants');
      assert.equal(sections.length, 1, 'No Participants section for empty speakers');
    });
  });

  describe('TranscriptMerger — Transcript content', (it) => {
    it('renders transcript with speaker attribution and timestamps', () => {
      const { markdown } = new TranscriptMerger([
        makeCall({
          transcript: [
            { speaker: 'Alice', text: 'Hello everyone.', startMs: 5000, endMs: 8000 },
            { speaker: 'Alice', text: 'Welcome to the call.', startMs: 8100, endMs: 11000 },
            { speaker: 'Bob', text: 'Thanks Alice.', startMs: 12000, endMs: 14000 },
          ],
        }),
      ]).generate();
      assert.includes(markdown, '**Alice** *(0:05)*:');
      assert.includes(markdown, 'Hello everyone.');
      assert.includes(markdown, 'Welcome to the call.');
      assert.includes(markdown, '**Bob** *(0:12)*:');
    });

    it('shows fallback message when transcript is empty', () => {
      const { markdown } = new TranscriptMerger([
        makeCall({ transcript: [] }),
      ]).generate();
      assert.includes(markdown, 'No transcript available');
    });

    it('groups consecutive lines from same speaker', () => {
      const { markdown } = new TranscriptMerger([
        makeCall({
          transcript: [
            { speaker: 'Alice', text: 'Line 1.', startMs: 1000, endMs: 2000 },
            { speaker: 'Alice', text: 'Line 2.', startMs: 2000, endMs: 3000 },
          ],
        }),
      ]).generate();
      // "**Alice**" should appear only once (not twice)
      const aliceHeaders = markdown.match(/\*\*Alice\*\*/g);
      assert.equal(aliceHeaders.length, 1, 'Same speaker should not be repeated');
    });
  });

  describe('TranscriptMerger — Summary and key points', (it) => {
    it('includes summary when present', () => {
      const { markdown } = new TranscriptMerger([
        makeCall({ summary: 'Great discussion about Q4 targets.' }),
      ]).generate();
      assert.includes(markdown, '### Summary');
      assert.includes(markdown, 'Great discussion about Q4 targets.');
    });

    it('includes key points when present', () => {
      const { markdown } = new TranscriptMerger([
        makeCall({ keyPoints: '- Point A\n- Point B' }),
      ]).generate();
      assert.includes(markdown, '### Key Points');
      assert.includes(markdown, '- Point A');
    });

    it('omits summary section when empty', () => {
      const { markdown } = new TranscriptMerger([
        makeCall({ summary: '' }),
      ]).generate();
      assert.ok(!markdown.includes('### Summary'), 'No Summary section for empty');
    });
  });

  describe('TranscriptMerger — Word count', (it) => {
    it('returns a positive word count', () => {
      const { wordCount } = new TranscriptMerger([makeCall()]).generate();
      assert.gt(wordCount, 0);
    });

    it('word count increases with more content', () => {
      const short = new TranscriptMerger([makeCall()]).generate();
      const long = new TranscriptMerger([
        makeCall({
          transcript: Array.from({ length: 50 }, (_, i) => ({
            speaker: 'Speaker', text: `This is sentence number ${i}.`, startMs: i * 1000, endMs: (i + 1) * 1000,
          })),
        }),
      ]).generate();
      assert.gt(long.wordCount, short.wordCount);
    });
  });

  describe('TranscriptMerger — Mixed sources', (it) => {
    it('merges calls from Gong and Grain chronologically', () => {
      const calls = [
        makeCall({ id: 'g2', title: 'Gong Call', date: '2024-02-01T00:00:00Z', source: 'Gong' }),
        makeCall({ id: 'r1', title: 'Grain Call', date: '2024-01-15T00:00:00Z', source: 'Grain' }),
        makeCall({ id: 'g1', title: 'Early Gong', date: '2024-01-01T00:00:00Z', source: 'Gong' }),
      ];
      const { markdown } = new TranscriptMerger(calls).generate();
      const titles = [...markdown.matchAll(/## \d+\. (.+)/g)].map(m => m[1]);
      assert.deepEqual(titles, ['Early Gong', 'Grain Call', 'Gong Call']);
      assert.includes(markdown, '*(Gong)*');
      assert.includes(markdown, '*(Grain)*');
    });
  });

  describe('TranscriptMerger — Edge cases', (it) => {
    it('handles zero calls', () => {
      const { markdown, wordCount } = new TranscriptMerger([]).generate();
      assert.includes(markdown, '**Total Calls:** 0');
      assert.gt(wordCount, 0); // Header still has words
    });

    it('handles call with all empty fields', () => {
      const { markdown } = new TranscriptMerger([
        makeCall({ title: '', summary: '', speakers: [], transcript: [], keyPoints: '', outline: '' }),
      ]).generate();
      assert.ok(markdown.length > 0);
    });
  });
};
