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
  mainView: document.getElementById('main-view'),
  driveView: document.getElementById('drive-view'),
  exportMd: document.getElementById('export-md'),
  exportDrive: document.getElementById('export-drive'),
  exportIncognito: document.getElementById('export-incognito'),
  driveBack: document.getElementById('drive-back'),
  driveAsMd: document.getElementById('drive-as-md'),
  driveAsDoc: document.getElementById('drive-as-doc'),
  closeAll: document.getElementById('close-all'),
  confirmPanel: document.getElementById('confirm-panel'),
  confirmText: document.getElementById('confirm-text'),
  confirmClose: document.getElementById('confirm-close'),
  cancelClose: document.getElementById('cancel-close'),
  status: document.getElementById('status'),
  statusText: document.getElementById('status-text'),
  statusLink: document.getElementById('status-link'),
};

const actionButtons = [
  ui.exportMd,
  ui.exportDrive,
  ui.exportIncognito,
  ui.driveBack,
  ui.driveAsMd,
  ui.driveAsDoc,
  ui.closeAll,
];

function showView(name) {
  ui.mainView.hidden = name !== 'main';
  ui.driveView.hidden = name !== 'drive';
}

function setStatus(message, kind = 'info') {
  ui.statusText.textContent = message;
  ui.statusLink.hidden = true;
  ui.statusLink.removeAttribute('href');
  ui.statusLink.textContent = '';
  statusLinkAction = null;
  ui.status.className = `status ${kind}`;
  ui.status.hidden = false;
}

function clearStatus() {
  ui.status.hidden = true;
  ui.statusText.textContent = '';
  ui.statusLink.hidden = true;
}

/**
 * The status link either navigates like a normal anchor (Drive webViewLink)
 * or runs a JS action — extensions cannot link to file:// URLs, so local
 * files are revealed in the system file manager via downloads.show().
 */
let statusLinkAction = null;

ui.statusLink.addEventListener('click', (event) => {
  if (!statusLinkAction) return; // real href: let the browser navigate
  event.preventDefault();
  statusLinkAction().catch((error) =>
    setStatus(error?.message || String(error), 'error'),
  );
});

/** Show a clickable link to the created Drive file below the status text. */
function showDriveFileLink(file) {
  if (!file?.webViewLink && !file?.id) return;
  ui.statusLink.href =
    file.webViewLink || `https://drive.google.com/file/d/${encodeURIComponent(file.id)}/view`;
  ui.statusLink.textContent = file.name || 'Open in Google Drive';
  ui.statusLink.title = 'Open in Google Drive';
  ui.statusLink.hidden = false;
}

/** Show the locally saved file's name; clicking reveals it in the file manager. */
function showLocalFileLink(download) {
  if (!download?.filename || typeof download.id !== 'number') return;
  ui.statusLink.href = '#';
  ui.statusLink.textContent = download.filename;
  ui.statusLink.title = 'Show in folder';
  ui.statusLink.hidden = false;
  statusLinkAction = () => revealDownload(download);
}

/**
 * Reveal a saved download in the system file manager.
 *
 * downloads.show() must be the FIRST call here: Firefox stops treating the
 * code as user input handling after an await, and refuses the reveal.
 * Firefox also resolves show() with `false` instead of rejecting when it
 * cannot reach a file manager (e.g. sandboxed Snap/Flatpak builds), so a
 * refusal falls back to the Downloads folder, then to showing the path.
 */
async function revealDownload(download) {
  let shown = false;
  try {
    shown = (await api.downloads.show(download.id)) !== false;
  } catch {
    // Unknown download id or gesture refused — diagnosed below.
  }

  // Firefox download ids are per-session, so a persisted record can point at
  // nothing (or at a different item) after a restart — verify by filename.
  const [item] = await api.downloads.search({ id: download.id });
  const basename = item?.filename?.split(/[\\/]/).pop();
  if (!item || item.exists === false || basename !== download.filename) {
    throw new Error("That file is no longer in the browser's download history.");
  }
  if (shown) return;

  try {
    await api.downloads.showDefaultFolder();
    setStatus(`Opened the Downloads folder — the file is ${item.filename}`, 'info');
  } catch {
    setStatus(`Could not open a file manager. The file is at ${item.filename}`, 'info');
  }
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
async function downloadMarkdown(markdown, filename, statusMessage, method) {
  const response = await api.runtime.sendMessage({
    type: 'download-markdown',
    markdown,
    filename,
    statusMessage,
    method,
  });
  if (!response) {
    throw new Error('No response from the background script. Please try again.');
  }
  if (!response.ok) {
    throw new Error(response.error || 'Download failed.');
  }
  return response;
}

// --- Action 1: Export all tabs to a local .md file -------------------------

const exportAllToMarkdown = guarded(async () => {
  const snapshot = await collectTabSnapshot();
  if (snapshot.counts.tabs === 0) {
    setStatus('No tabs found to export.', 'info');
    return;
  }
  const message = successMessage(snapshot.counts);
  const filename = makeFilename('tabs-export');
  const response = await downloadMarkdown(formatMarkdown(snapshot), filename, message, 'local');
  setStatus(message, 'success');
  showLocalFileLink({ id: response.downloadId, filename });
});

// --- Action 2: Export all tabs to Google Drive -----------------------------
// The "Export All to Google Drive" button opens a sub-menu offering two
// formats: a plain .md file, or a native Google Doc (Drive converts the
// Markdown server-side, so headers/links become real Docs formatting).

function makeDriveExport(format) {
  return guarded(async () => {
    const snapshot = await collectTabSnapshot();
    if (snapshot.counts.tabs === 0) {
      setStatus('No tabs found to export.', 'info');
      return;
    }
    setStatus('Connecting to Google Drive…', 'info');

    const message = successMessage(snapshot.counts);
    const response = await api.runtime.sendMessage({
      type: 'drive-export',
      format,
      markdown: formatMarkdown(snapshot),
      filename: makeFilename('tabs-export'),
      statusMessage: message,
      method: 'drive',
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
}

const exportDriveAsMarkdown = makeDriveExport('markdown');
const exportDriveAsDocument = makeDriveExport('document');

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
  const filename = makeFilename('incognito-tabs-export');
  const response = await downloadMarkdown(
    formatMarkdown(snapshot, { heading: 'Incognito tab export' }),
    filename,
    message,
    'incognito',
  );
  setStatus(message, 'success');
  showLocalFileLink({ id: response.downloadId, filename });
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
const METHOD_LABELS = {
  local: 'to a local Markdown file',
  drive: 'to Google Drive',
  incognito: 'incognito tabs to a local Markdown file',
};

async function restoreLastExportStatus() {
  const stored = await api.storage.local.get(LAST_STATUS_KEY);
  const record = stored?.[LAST_STATUS_KEY];
  if (!record?.message) return;
  const how = METHOD_LABELS[record.method];
  setStatus(`Previously ${record.message}${how ? ` (${how})` : ''}`, 'success');
  if (record.file) showDriveFileLink(record.file);
  else if (record.download) showLocalFileLink(record.download);
}

restoreLastExportStatus().catch((error) => console.error(error));

// --- Wiring ------------------------------------------------------------------

ui.exportMd.addEventListener('click', exportAllToMarkdown);
ui.exportDrive.addEventListener('click', () => {
  hideConfirm();
  clearStatus();
  showView('drive');
});
ui.driveBack.addEventListener('click', () => showView('main'));
ui.driveAsMd.addEventListener('click', exportDriveAsMarkdown);
ui.driveAsDoc.addEventListener('click', exportDriveAsDocument);
ui.exportIncognito.addEventListener('click', exportIncognitoOnly);
ui.closeAll.addEventListener('click', () => {
  showCloseConfirmation().catch((error) => setStatus(error.message, 'error'));
});
ui.confirmClose.addEventListener('click', confirmCloseAll);
ui.cancelClose.addEventListener('click', hideConfirm);
