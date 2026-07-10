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
};

const actionButtons = [ui.exportMd, ui.exportDrive, ui.exportIncognito, ui.closeAll];

function setStatus(message, kind = 'info') {
  ui.status.textContent = message;
  ui.status.className = `status ${kind}`;
  ui.status.hidden = false;
}

function clearStatus() {
  ui.status.hidden = true;
  ui.status.textContent = '';
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
 * Trigger a local download. A `data:` URL is used instead of a Blob URL on
 * purpose: Blob URLs are revoked when the popup document closes, and the
 * OS save dialog stealing focus closes the popup in some browsers.
 */
async function downloadMarkdown(markdown, filename) {
  const url = `data:text/markdown;charset=utf-8,${encodeURIComponent(markdown)}`;
  await api.downloads.download({ url, filename, saveAs: true });
}

// --- Action 1: Export all tabs to a local .md file -------------------------

const exportAllToMarkdown = guarded(async () => {
  const snapshot = await collectTabSnapshot();
  if (snapshot.counts.tabs === 0) {
    setStatus('No tabs found to export.', 'info');
    return;
  }
  await downloadMarkdown(formatMarkdown(snapshot), makeFilename('tabs-export'));
  setStatus(successMessage(snapshot.counts), 'success');
});

// --- Action 2: Export all tabs to Google Drive -----------------------------

const exportAllToDrive = guarded(async () => {
  const snapshot = await collectTabSnapshot();
  if (snapshot.counts.tabs === 0) {
    setStatus('No tabs found to export.', 'info');
    return;
  }
  setStatus('Connecting to Google Drive…', 'info');

  const response = await api.runtime.sendMessage({
    type: 'drive-export',
    markdown: formatMarkdown(snapshot),
    filename: makeFilename('tabs-export'),
  });

  if (!response) {
    throw new Error('No response from the background script. Please try again.');
  }
  if (!response.ok) {
    throw new Error(response.error || 'Google Drive export failed.');
  }
  setStatus(successMessage(snapshot.counts), 'success');
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
  await downloadMarkdown(
    formatMarkdown(snapshot, { heading: 'Incognito tab export' }),
    makeFilename('incognito-tabs-export'),
  );
  setStatus(successMessage(snapshot.counts), 'success');
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

// --- Wiring ------------------------------------------------------------------

ui.exportMd.addEventListener('click', exportAllToMarkdown);
ui.exportDrive.addEventListener('click', exportAllToDrive);
ui.exportIncognito.addEventListener('click', exportIncognitoOnly);
ui.closeAll.addEventListener('click', () => {
  showCloseConfirmation().catch((error) => setStatus(error.message, 'error'));
});
ui.confirmClose.addEventListener('click', confirmCloseAll);
ui.cancelClose.addEventListener('click', hideConfirm);
