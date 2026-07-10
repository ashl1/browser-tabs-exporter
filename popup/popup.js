/**
 * Popup UI controller.
 *
 * Collects and formats tabs directly (the popup has the same API access as
 * the background context), downloads .md files itself, and delegates the two
 * jobs that must outlive the popup — the Google Drive OAuth/upload and the
 * close-all operation — to the background script via messaging.
 */

import { api, IS_FIREFOX } from '../lib/env.js';
import { collectTabSnapshot } from '../lib/collect.js';
import { formatMarkdown, successMessage, makeFilename } from '../lib/markdown.js';

const ui = {
  exportMd: document.getElementById('export-md'),
  exportDrive: document.getElementById('export-drive'),
  exportIncognito: document.getElementById('export-incognito'),
  closeAll: document.getElementById('close-all'),
  confirmPanel: document.getElementById('confirm-panel'),
  confirmText: document.getElementById('confirm-text'),
  confirmClose: document.getElementById('confirm-close'),
  cancelClose: document.getElementById('cancel-close'),
  status: document.getElementById('status'),
  statusText: document.getElementById('status-text'),
  statusLink: document.getElementById('status-link'),
};

const actionButtons = [ui.exportMd, ui.exportDrive, ui.exportIncognito, ui.closeAll];

function setStatus(message, kind = 'info') {
  ui.statusText.textContent = message;
  ui.statusLink.hidden = true;
  ui.statusLink.removeAttribute('href');
  ui.statusLink.textContent = '';
  ui.status.className = `status ${kind}`;
  ui.status.hidden = false;
}

function clearStatus() {
  ui.status.hidden = true;
  ui.statusText.textContent = '';
  ui.statusLink.hidden = true;
}

/** Show a clickable link to the created Drive file below the status text. */
function showDriveFileLink(file) {
  if (!file?.webViewLink && !file?.id) return;
  ui.statusLink.href =
    file.webViewLink || `https://drive.google.com/file/d/${encodeURIComponent(file.id)}/view`;
  ui.statusLink.textContent = file.name || 'Open in Google Drive';
  ui.statusLink.title = 'Open in Google Drive';
  ui.statusLink.hidden = false;
}

function setBusy(busy) {
  for (const button of actionButtons) button.disabled = busy;
}

/** Wrap a handler with busy-state management and last-resort error display. */
function guarded(handler) {
  return async () => {
    hideConfirm();
    clearStatus();
    setBusy(true);
    try {
      await handler();
    } catch (error) {
      console.error(error);
      setStatus(error?.message || 'Something went wrong. Please try again.', 'error');
    } finally {
      setBusy(false);
    }
  };
}

/**
 * Local downloads are delegated to the background context: Firefox denies
 * `data:` URLs in downloads.download(), and a Blob URL minted here in the
 * popup would be revoked the moment the popup closes (the OS save dialog
 * stealing focus is enough). The background script picks the right URL
 * strategy per browser and outlives the popup.
 */
async function downloadMarkdown(markdown, filename, statusMessage) {
  const response = await api.runtime.sendMessage({
    type: 'download-markdown',
    markdown,
    filename,
    statusMessage,
  });
  if (!response) {
    throw new Error('No response from the background script. Please try again.');
  }
  if (!response.ok) {
    throw new Error(response.error || 'Download failed.');
  }
}

// --- Action 1: Export all tabs to a local .md file -------------------------

const exportAllToMarkdown = guarded(async () => {
  const snapshot = await collectTabSnapshot();
  if (snapshot.counts.tabs === 0) {
    setStatus('No tabs found to export.', 'info');
    return;
  }
  const message = successMessage(snapshot.counts);
  await downloadMarkdown(formatMarkdown(snapshot), makeFilename('tabs-export'), message);
  setStatus(message, 'success');
});

// --- Action 2: Export all tabs to Google Drive -----------------------------

const exportAllToDrive = guarded(async () => {
  const snapshot = await collectTabSnapshot();
  if (snapshot.counts.tabs === 0) {
    setStatus('No tabs found to export.', 'info');
    return;
  }
  setStatus('Connecting to Google Drive…', 'info');

  const message = successMessage(snapshot.counts);
  const response = await api.runtime.sendMessage({
    type: 'drive-export',
    markdown: formatMarkdown(snapshot),
    filename: makeFilename('tabs-export'),
    statusMessage: message,
  });

  if (!response) {
    throw new Error('No response from the background script. Please try again.');
  }
  if (!response.ok) {
    throw new Error(response.error || 'Google Drive export failed.');
  }
  setStatus(message, 'success');
  showDriveFileLink(response.file);
});

// --- Action 3: Export incognito tabs only -----------------------------------

const exportIncognitoOnly = guarded(async () => {
  const allowed = await api.extension.isAllowedIncognitoAccess();
  if (!allowed) {
    setStatus(
      IS_FIREFOX
        ? 'Private browsing access is disabled. Open about:addons → Tab Snapshot → "Run in Private Windows" → Allow.'
        : 'Incognito access is disabled. Open your browser\'s Extensions page → Tab Snapshot → Details → enable "Allow in Incognito".',
      'error',
    );
    return;
  }

  const snapshot = await collectTabSnapshot({ incognitoOnly: true });
  if (snapshot.counts.tabs === 0) {
    setStatus('No incognito tabs are open right now.', 'info');
    return;
  }
  const message = successMessage(snapshot.counts);
  await downloadMarkdown(
    formatMarkdown(snapshot, { heading: 'Incognito tab export' }),
    makeFilename('incognito-tabs-export'),
    message,
  );
  setStatus(message, 'success');
});

// --- Action 4: Close all tabs (with confirmation) ---------------------------

function hideConfirm() {
  ui.confirmPanel.hidden = true;
}

async function showCloseConfirmation() {
  clearStatus();
  const tabs = await api.tabs.query({});
  const windowIds = new Set(tabs.map((tab) => tab.windowId));
  ui.confirmText.textContent =
    `This will close ${tabs.length} tabs across ${windowIds.size} windows — ` +
    'including this one. Unsaved work in those tabs will be lost. Continue?';
  ui.confirmPanel.hidden = false;
  ui.confirmClose.focus();
}

const confirmCloseAll = guarded(async () => {
  // Delegated to the background script: the popup dies as soon as its own
  // window closes, but the background context survives to finish the job.
  await api.runtime.sendMessage({ type: 'close-all-tabs' });
  setStatus('Closing all tabs…', 'info');
});

// --- Last export status replay ----------------------------------------------

const LAST_STATUS_KEY = 'lastExportStatus'; // must match background.js

/**
 * Exports usually settle after this popup has already died — the OS save
 * dialog or Google's auth window takes focus, which closes it. The background
 * persists each successful export's status, and it is replayed here on the
 * next open, prefixed with "Previously" (with the Drive file link, if any).
 */
async function restoreLastExportStatus() {
  const stored = await api.storage.local.get(LAST_STATUS_KEY);
  const record = stored?.[LAST_STATUS_KEY];
  if (!record?.message) return;
  setStatus(`Previously ${record.message}`, 'success');
  if (record.file) showDriveFileLink(record.file);
}

restoreLastExportStatus().catch((error) => console.error(error));

// --- Wiring ------------------------------------------------------------------

ui.exportMd.addEventListener('click', exportAllToMarkdown);
ui.exportDrive.addEventListener('click', exportAllToDrive);
ui.exportIncognito.addEventListener('click', exportIncognitoOnly);
ui.closeAll.addEventListener('click', () => {
  showCloseConfirmation().catch((error) => setStatus(error.message, 'error'));
});
ui.confirmClose.addEventListener('click', confirmCloseAll);
ui.cancelClose.addEventListener('click', hideConfirm);
