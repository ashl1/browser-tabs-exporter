/**
 * Background script: Google OAuth2 + Drive upload, and the close-all-tabs
 * operation (both must survive the popup being closed).
 *
 * Runs as a service worker on Chromium and as an event page on Firefox, so
 * it is a classic script with no ES module imports.
 *
 * OAuth strategy:
 *   1. Chromium first tries `chrome.identity.getAuthToken` (needs the
 *      "Chrome Extension" OAuth client declared in manifest.json `oauth2`).
 *   2. Firefox — and any Chromium browser where getAuthToken is unavailable
 *      or fails (Edge, Brave) — falls back to `identity.launchWebAuthFlow`
 *      with a "Web application" OAuth client (implicit grant).
 */

'use strict';

const api = globalThis.browser ?? globalThis.chrome;
const IS_FIREFOX = api.runtime.getURL('').startsWith('moz-extension://');

// "Web application" OAuth client used by the launchWebAuthFlow fallback.
// See README.md → "Google Cloud setup".
const WEB_OAUTH_CLIENT_ID = '567268955685-rfpuerdtrrag804fod8hahggpv10b2t4.apps.googleusercontent.com';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const DRIVE_UPLOAD_URL =
  'https://www.googleapis.com/upload/drive/v3/files' +
  '?uploadType=multipart&fields=id,name,webViewLink';

// storage.session is wiped when the browser closes — the right lifetime for
// an access token. Fall back to storage.local on older browsers.
const tokenStore = api.storage.session ?? api.storage.local;
const TOKEN_KEY = 'driveWebFlowToken';

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

function nativeGetAuthTokenAvailable() {
  return !IS_FIREFOX && typeof globalThis.chrome?.identity?.getAuthToken === 'function';
}

/** Promise wrapper for the callback-only chrome.identity.getAuthToken. */
function chromeGetAuthToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!token) {
        reject(new Error('Google sign-in was cancelled.'));
      } else {
        resolve(token);
      }
    });
  });
}

async function getCachedWebFlowToken() {
  const stored = await tokenStore.get(TOKEN_KEY);
  const record = stored?.[TOKEN_KEY];
  if (record?.accessToken && record.expiresAt > Date.now()) {
    return record.accessToken;
  }
  return null;
}

function parseWebAuthResponse(responseUrl) {
  // Token arrives in the URL fragment: #access_token=...&expires_in=3599...
  const fragment = new URL(responseUrl).hash.replace(/^#/, '');
  const params = new URLSearchParams(fragment);
  const error = params.get('error');
  if (error) {
    throw new Error(`Google sign-in failed: ${error}`);
  }
  const accessToken = params.get('access_token');
  if (!accessToken) {
    throw new Error('Google sign-in did not return an access token.');
  }
  const expiresIn = Number(params.get('expires_in') || '3600');
  return { accessToken, expiresIn };
}

async function webFlowGetToken(interactive) {
  const cached = await getCachedWebFlowToken();
  if (cached) return cached;
  if (!interactive) {
    throw new Error('Not signed in to Google.');
  }
  if (WEB_OAUTH_CLIENT_ID.startsWith('REPLACE_WITH')) {
    throw new Error(
      'Google Drive export is not configured yet: set WEB_OAUTH_CLIENT_ID in background.js (see README).',
    );
  }

  const redirectUri = api.identity.getRedirectURL();
  const authUrl = new URL(GOOGLE_AUTH_URL);
  authUrl.searchParams.set('client_id', WEB_OAUTH_CLIENT_ID);
  authUrl.searchParams.set('response_type', 'token');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', DRIVE_SCOPE);
  authUrl.searchParams.set('prompt', 'select_account');

  const responseUrl = await api.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive: true,
  });
  if (!responseUrl) {
    throw new Error('Google sign-in was cancelled.');
  }

  const { accessToken, expiresIn } = parseWebAuthResponse(responseUrl);
  await tokenStore.set({
    [TOKEN_KEY]: {
      accessToken,
      // 60s safety margin so we never send a token that expires mid-request.
      expiresAt: Date.now() + Math.max(expiresIn - 60, 60) * 1000,
    },
  });
  return accessToken;
}

/** Get an access token, preferring the browser-native flow on Chromium. */
async function getAccessToken(interactive) {
  if (nativeGetAuthTokenAvailable()) {
    try {
      return { token: await chromeGetAuthToken(interactive), source: 'native' };
    } catch (error) {
      // Edge and Brave ship chrome.identity but cannot mint Google tokens;
      // a misconfigured manifest client id fails the same way. Fall back.
      console.warn('getAuthToken failed, falling back to launchWebAuthFlow:', error.message);
    }
  }
  return { token: await webFlowGetToken(interactive), source: 'webflow' };
}

async function invalidateToken({ token, source }) {
  if (source === 'native') {
    await new Promise((resolve) => {
      chrome.identity.removeCachedAuthToken({ token }, () => resolve());
    });
  } else {
    await tokenStore.remove(TOKEN_KEY);
  }
}

// ---------------------------------------------------------------------------
// Google Drive upload (multipart/related)
// ---------------------------------------------------------------------------

async function driveUpload(token, filename, markdown) {
  const boundary = `tab-snapshot-${crypto.randomUUID()}`;
  const metadata = {
    name: filename,
    mimeType: 'text/markdown',
    description: 'Exported by the Tab Snapshot browser extension',
  };
  const body =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    'Content-Type: text/markdown; charset=UTF-8\r\n\r\n' +
    `${markdown}\r\n` +
    `--${boundary}--`;

  return fetch(DRIVE_UPLOAD_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });
}

async function readDriveError(response) {
  try {
    const payload = await response.json();
    return payload?.error?.message || `Google Drive returned HTTP ${response.status}.`;
  } catch {
    return `Google Drive returned HTTP ${response.status}.`;
  }
}

async function exportToDrive({ markdown, filename }) {
  if (typeof markdown !== 'string' || !markdown || typeof filename !== 'string') {
    throw new Error('Invalid export payload.');
  }

  let auth = await getAccessToken(true);
  let response = await driveUpload(auth.token, filename, markdown);

  // A stale cached token yields 401: invalidate it and retry exactly once.
  if (response.status === 401) {
    await invalidateToken(auth);
    auth = await getAccessToken(true);
    response = await driveUpload(auth.token, filename, markdown);
  }

  if (!response.ok) {
    throw new Error(await readDriveError(response));
  }

  const file = await response.json();
  return { ok: true, file: { id: file.id, name: file.name, webViewLink: file.webViewLink } };
}

// ---------------------------------------------------------------------------
// Local .md download.
//
// Firefox's downloads.download() denies data: URLs, so on Firefox (an event
// page with document APIs) a Blob URL is created here — it outlives the
// popup and is revoked once the download settles. Chromium service workers
// have no URL.createObjectURL, but Chrome accepts data: URLs.
// ---------------------------------------------------------------------------

const pendingBlobUrls = new Map(); // downloadId → blob URL awaiting revocation

api.downloads.onChanged.addListener((delta) => {
  const blobUrl = pendingBlobUrls.get(delta.id);
  if (!blobUrl) return;
  const state = delta.state?.current;
  if (state === 'complete' || state === 'interrupted') {
    URL.revokeObjectURL(blobUrl);
    pendingBlobUrls.delete(delta.id);
  }
});

async function downloadMarkdownFile({ markdown, filename }) {
  if (typeof markdown !== 'string' || !markdown || typeof filename !== 'string') {
    throw new Error('Invalid download payload.');
  }

  const canUseBlob = typeof URL.createObjectURL === 'function';
  const url = canUseBlob
    ? URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }))
    : `data:text/markdown;charset=utf-8,${encodeURIComponent(markdown)}`;

  try {
    const downloadId = await api.downloads.download({ url, filename, saveAs: true });
    if (canUseBlob) pendingBlobUrls.set(downloadId, url);
    return { ok: true, downloadId };
  } catch (error) {
    if (canUseBlob) URL.revokeObjectURL(url);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Close all tabs
// ---------------------------------------------------------------------------

async function closeAllTabs() {
  const tabs = await api.tabs.query({});
  const ids = tabs.map((tab) => tab.id).filter((id) => id !== undefined);
  if (ids.length > 0) {
    await api.tabs.remove(ids);
  }
  return { ok: true, closed: ids.length };
}

// ---------------------------------------------------------------------------
// Badge feedback — visible even if the auth window caused the popup to close.
// ---------------------------------------------------------------------------

function flashBadge(text, color) {
  api.action.setBadgeBackgroundColor({ color });
  api.action.setBadgeText({ text });
  setTimeout(() => api.action.setBadgeText({ text: '' }), 6000);
}

// ---------------------------------------------------------------------------
// Message router. Uses the sendResponse/return-true idiom because Chromium
// does not honour a Promise returned from an onMessage listener.
// ---------------------------------------------------------------------------

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message?.type) {
    case 'drive-export':
      exportToDrive(message)
        .then((result) => {
          flashBadge('✓', '#188038');
          sendResponse(result);
        })
        .catch((error) => {
          console.error('Drive export failed:', error);
          flashBadge('!', '#b3261e');
          sendResponse({ ok: false, error: error?.message || String(error) });
        });
      return true;

    case 'download-markdown':
      downloadMarkdownFile(message)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;

    case 'close-all-tabs':
      closeAllTabs()
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;

    default:
      return undefined;
  }
});
