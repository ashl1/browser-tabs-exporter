/**
 * Markdown formatting for tab snapshots.
 *
 * Grouping rules:
 *   - Tabs inside a tab group  → `## Group: [Group Name]`
 *   - Tabs outside any group   → `## Window: [First Tab Title]`
 *   - Every tab                → `- [Tab Title](URL)`
 */

/** Escape characters that would break Markdown link text. */
function escapeMarkdownText(text) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/([[\]`*_])/g, '\\$1')
    .replace(/\r?\n/g, ' ');
}

/** Escape characters that would terminate a Markdown link target early. */
function escapeMarkdownUrl(url) {
  return url
    .replace(/\\/g, '%5C')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/ /g, '%20')
    .replace(/</g, '%3C')
    .replace(/>/g, '%3E');
}

function tabLine(tab) {
  return `- [${escapeMarkdownText(tab.title)}](${escapeMarkdownUrl(tab.url)})`;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatTimestamp(date) {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * Render a snapshot (see lib/collect.js) as a Markdown document.
 *
 * @param {import('./collect.js').TabSnapshot} snapshot
 * @param {{ generatedAt?: Date, heading?: string }} [options]
 * @returns {string}
 */
export function formatMarkdown(snapshot, { generatedAt = new Date(), heading = 'Tab export' } = {}) {
  const lines = [`# ${heading} — ${formatTimestamp(generatedAt)}`, ''];

  for (const win of snapshot.windows) {
    if (win.ungrouped.length > 0) {
      lines.push(`## Window: ${escapeMarkdownText(win.firstTabTitle)}`, '');
      for (const tab of win.ungrouped) lines.push(tabLine(tab));
      lines.push('');
    }
    for (const group of win.groups) {
      lines.push(`## Group: ${escapeMarkdownText(group.name)}`, '');
      for (const tab of group.tabs) lines.push(tabLine(tab));
      lines.push('');
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * The exact success message required by the UI spec.
 *
 * @param {{ tabs: number, windows: number, groups: number }} counts
 */
export function successMessage({ tabs, windows, groups }) {
  return `${tabs} tabs for ${windows} windows and ${groups} tabs groups are exported!`;
}

/** Filesystem-safe export filename, e.g. `tabs-export-2026-07-10_14-30-05.md`. */
export function makeFilename(prefix = 'tabs-export', date = new Date()) {
  const stamp =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  return `${prefix}-${stamp}.md`;
}
