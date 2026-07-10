/**
 * Tab collection.
 *
 * Builds an in-memory snapshot of every window / tab / tab group using only
 * `windows.getAll({ populate: true })` and `tabGroups.get()`. Both read
 * metadata straight from the browser's session store, so discarded
 * ("sleeping") tabs keep their URL and title and are never woken up — no
 * content scripts, no tab activation.
 */

import { api } from './env.js';

const GROUP_ID_NONE = api.tabGroups?.TAB_GROUP_ID_NONE ?? -1;

/**
 * @typedef {{ title: string, url: string, discarded: boolean }} TabEntry
 * @typedef {{ id: number, name: string, tabs: TabEntry[] }} GroupEntry
 * @typedef {{
 *   incognito: boolean,
 *   firstTabTitle: string,
 *   ungrouped: TabEntry[],
 *   groups: GroupEntry[],
 * }} WindowEntry
 * @typedef {{
 *   windows: WindowEntry[],
 *   counts: { tabs: number, windows: number, groups: number },
 * }} TabSnapshot
 */

function toEntry(tab) {
  // `pendingUrl` covers tabs restored lazily that have not committed a
  // navigation yet; `url` is populated for discarded tabs as long as the
  // extension holds the "tabs" permission.
  const url = tab.url || tab.pendingUrl || '';
  return {
    title: (tab.title || url || 'Untitled').trim(),
    url,
    discarded: Boolean(tab.discarded),
  };
}

async function resolveGroupName(groupId, cache) {
  if (cache.has(groupId)) return cache.get(groupId);
  let name = '';
  try {
    const group = await api.tabGroups.get(groupId);
    name = (group.title || '').trim();
  } catch {
    // Group vanished between query and lookup, or API unavailable.
  }
  const resolved = name || 'Unnamed group';
  cache.set(groupId, resolved);
  return resolved;
}

/**
 * Snapshot all open tabs.
 *
 * @param {{ incognitoOnly?: boolean }} [options]
 * @returns {Promise<TabSnapshot>}
 */
export async function collectTabSnapshot({ incognitoOnly = false } = {}) {
  const allWindows = await api.windows.getAll({
    populate: true,
    windowTypes: ['normal'],
  });
  const targetWindows = incognitoOnly
    ? allWindows.filter((win) => win.incognito)
    : allWindows;

  // Firefox < 139 has no tabGroups API; treat every tab as ungrouped there.
  const groupsSupported = typeof api.tabGroups?.get === 'function';
  const groupNameCache = new Map();

  const snapshot = {
    windows: [],
    counts: { tabs: 0, windows: 0, groups: 0 },
  };

  for (const win of targetWindows) {
    const tabs = (win.tabs ?? []).slice().sort((a, b) => a.index - b.index);
    if (tabs.length === 0) continue;

    /** @type {WindowEntry} */
    const windowEntry = {
      incognito: win.incognito,
      firstTabTitle: toEntry(tabs[0]).title,
      ungrouped: [],
      groups: [],
    };
    const groupsById = new Map();

    for (const tab of tabs) {
      const entry = toEntry(tab);
      const groupId = groupsSupported ? (tab.groupId ?? GROUP_ID_NONE) : GROUP_ID_NONE;

      if (groupId === GROUP_ID_NONE) {
        windowEntry.ungrouped.push(entry);
      } else {
        let group = groupsById.get(groupId);
        if (!group) {
          group = { id: groupId, name: '', tabs: [] };
          groupsById.set(groupId, group);
          windowEntry.groups.push(group);
        }
        group.tabs.push(entry);
      }
      snapshot.counts.tabs += 1;
    }

    for (const group of windowEntry.groups) {
      group.name = await resolveGroupName(group.id, groupNameCache);
    }

    snapshot.counts.windows += 1;
    snapshot.counts.groups += windowEntry.groups.length;
    snapshot.windows.push(windowEntry);
  }

  return snapshot;
}
