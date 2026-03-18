/**
 * Transcript Merger Service
 *
 * Takes call details from multiple providers, sorts them chronologically,
 * and produces a single merged Markdown document.
 */
class TranscriptMerger {
  /**
   * @param {Array} callDetails - Array of call detail objects from any provider
   * @param {Object} options - { projectName, selectedAccounts }
   */
  constructor(callDetails, options = {}) {
    this.callDetails = callDetails;
    this.projectName = options.projectName || 'Call Transcripts';
    this.selectedAccounts = options.selectedAccounts || [];
    this.sortMode = options.sortMode || 'chronological';
  }

  /**
   * Sort all calls chronologically and generate merged Markdown.
   * @returns {{ markdown: string, wordCount: number }}
   */
  generate() {
    let sorted;

    if (this.sortMode === 'byAccount') {
      // Sort alphabetically by account name, then by date within each account
      sorted = [...this.callDetails].sort((a, b) => {
        const accountA = (a.accountName || 'Unknown').toLowerCase();
        const accountB = (b.accountName || 'Unknown').toLowerCase();
        const cmp = accountA.localeCompare(accountB);
        if (cmp !== 0) return cmp;
        return new Date(a.date).getTime() - new Date(b.date).getTime();
      });
    } else {
      // Default: sort by date ascending
      sorted = [...this.callDetails].sort((a, b) => {
        return new Date(a.date).getTime() - new Date(b.date).getTime();
      });
    }

    const lines = [];

    // Document header
    lines.push(`# ${this.projectName}`);
    lines.push('');
    lines.push(`**Generated:** ${new Date().toISOString().split('T')[0]}`);
    lines.push(`**Total Calls:** ${sorted.length}`);

    if (this.selectedAccounts.length > 0) {
      const accountNames = [...new Set(this.selectedAccounts.map(a => a.name))].sort();
      lines.push(`**Accounts:** ${accountNames.join(', ')}`);
    }

    const sources = [...new Set(sorted.map(c => c.source))];
    lines.push(`**Sources:** ${sources.join(', ')}`);

    if (this.sortMode === 'byAccount') {
      lines.push(`**Sort Order:** By account (alphabetical), then by date`);
    }

    lines.push('');
    lines.push('---');
    lines.push('');

    // Table of contents
    lines.push('## Table of Contents');
    lines.push('');

    if (this.sortMode === 'byAccount') {
      // Group TOC by account
      let currentAccount = null;
      sorted.forEach((call, idx) => {
        const accountName = call.accountName || 'Unknown';
        if (accountName !== currentAccount) {
          if (currentAccount !== null) lines.push('');
          lines.push(`### ${this._sanitize(accountName)}`);
          lines.push('');
          currentAccount = accountName;
        }
        const num = idx + 1;
        const dateStr = this._formatDate(call.date);
        const safeTitle = this._sanitize(call.title);
        const anchor = this._makeAnchor(num, call.title);
        lines.push(`${num}. [${dateStr} — ${safeTitle}](#${anchor}) *(${this._sanitize(call.source)})*`);
      });
    } else {
      sorted.forEach((call, idx) => {
        const num = idx + 1;
        const dateStr = this._formatDate(call.date);
        const safeTitle = this._sanitize(call.title);
        const anchor = this._makeAnchor(num, call.title);
        lines.push(`${num}. [${dateStr} — ${safeTitle}](#${anchor}) *(${this._sanitize(call.source)})*`);
      });
    }
    lines.push('');
    lines.push('---');
    lines.push('');

    // Each call — render with account group headers in byAccount mode
    let currentAccountHeader = null;
    sorted.forEach((call, idx) => {
      const num = idx + 1;

      // In byAccount mode, insert account section headers
      if (this.sortMode === 'byAccount') {
        const accountName = call.accountName || 'Unknown';
        if (accountName !== currentAccountHeader) {
          if (currentAccountHeader !== null) {
            lines.push('');
          }
          lines.push(`# ${this._sanitize(accountName)}`);
          lines.push('');
          currentAccountHeader = accountName;
        }
      }

      lines.push(`## ${num}. ${this._sanitize(call.title)}`);
      lines.push('');

      // Metadata table — include as much metadata as possible
      lines.push('| Field | Value |');
      lines.push('|-------|-------|');
      lines.push(`| **Date** | ${this._formatDate(call.date)} |`);
      lines.push(`| **Source** | ${this._sanitize(call.source)} |`);
      if (call.accountName) {
        lines.push(`| **Account** | ${this._sanitize(call.accountName)} |`);
      }
      if (call.duration) {
        lines.push(`| **Duration** | ${this._formatDuration(call.duration)} |`);
      }
      if (call.id) {
        lines.push(`| **Call ID** | ${this._sanitize(String(call.id))} |`);
      }
      if (call.error) {
        lines.push(`| **Error** | ${this._sanitize(call.error)} |`);
      }
      lines.push('');

      // Speakers
      if (call.speakers && call.speakers.length > 0) {
        lines.push('### Participants');
        lines.push('');
        for (const speaker of call.speakers) {
          const roleTag = speaker.role === 'internal' ? '🏢' : '👤';
          const parts = [`${roleTag} **${this._sanitize(speaker.name)}**`];
          if (speaker.title) parts.push(`— ${this._sanitize(speaker.title)}`);
          if (speaker.email) parts.push(`(${this._sanitize(speaker.email)})`);
          lines.push(`- ${parts.join(' ')}`);
        }
        lines.push('');
      }

      // Summary
      if (call.summary) {
        lines.push('### Summary');
        lines.push('');
        lines.push(this._sanitize(call.summary));
        lines.push('');
      }

      // Key Points
      if (call.keyPoints) {
        lines.push('### Key Points');
        lines.push('');
        lines.push(this._sanitize(call.keyPoints));
        lines.push('');
      }

      // Outline
      if (call.outline) {
        lines.push('### Outline');
        lines.push('');
        lines.push(this._sanitize(call.outline));
        lines.push('');
      }

      // Transcript
      if (call.transcript && call.transcript.length > 0) {
        lines.push('### Transcript');
        lines.push('');

        let lastSpeaker = null;
        for (const entry of call.transcript) {
          if (entry.speaker !== lastSpeaker) {
            if (lastSpeaker !== null) lines.push('');
            const timeStr = entry.startMs > 0 ? ` *(${this._formatMs(entry.startMs)})*` : '';
            lines.push(`**${this._sanitize(entry.speaker)}**${timeStr}:`);
            lastSpeaker = entry.speaker;
          }
          lines.push(`${this._sanitize(entry.text)}`);
        }
        lines.push('');
      } else {
        lines.push('*No transcript available for this call.*');
        lines.push('');
      }

      lines.push('---');
      lines.push('');
    });

    // Footer
    lines.push(`*Document generated by Call Transcript Merger on ${new Date().toISOString()}*`);

    const markdown = lines.join('\n');
    const wordCount = this._countWords(markdown);

    return { markdown, wordCount };
  }

  _formatDate(isoDate) {
    try {
      const d = new Date(isoDate);
      return d.toLocaleDateString('en-US', {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return isoDate;
    }
  }

  _formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  _formatMs(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  _makeAnchor(num, title) {
    return `${num}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}`;
  }

  // L4: Strip HTML tags from API content to prevent XSS when Markdown is rendered
  _sanitize(str) {
    if (!str || typeof str !== 'string') return str;
    return str.replace(/<[^>]*>/g, '');
  }

  _countWords(text) {
    return text
      .replace(/[#*|_\-\[\]()>]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 0).length;
  }
}

module.exports = TranscriptMerger;
