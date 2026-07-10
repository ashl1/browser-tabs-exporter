# Tab Snapshot — Markdown Export

Cross-browser (Chrome / Edge / Brave / Firefox) Manifest V3 extension that exports
every open tab to structured Markdown — as a local `.md` download or straight to
Google Drive — with full support for tab groups, incognito windows, and
suspended/discarded tabs (they are read without being woken up).

## Features

1. **Export All to Markdown** — downloads all tabs from all windows as a `.md` file.
2. **Export All to Google Drive** — uploads the same document to Drive
   (OAuth2, `drive.file` scope — the extension can only see files it created).
   On success the popup shows a clickable link to the created Drive file.
3. **Export Incognito Only** — downloads only currently open incognito/private tabs.
4. **Close All Tabs** — closes every tab in every window, behind an in-popup
   confirmation step.

After any successful export the popup shows:

> `N tabs for M windows and K tabs groups are exported!`

### Markdown format

- Tabs inside a tab group are listed under `## Group: [Group Name]`.
- Ungrouped tabs are listed under `## Window: [First Tab Title]`
  (the title of the first tab of that window).
- Every tab is a link: `- [Tab Title](URL)`.

## Project structure

```
save_tabs_extension/
├── manifest.json            # Chromium manifest (Chrome / Edge / Brave)
├── manifest.firefox.json    # Firefox manifest (swap in when packaging for Firefox)
├── background.js            # Service worker / event page: OAuth2 + Drive upload,
│                            # close-all-tabs (classic script — no ES imports, so the
│                            # same file runs on both browsers)
├── popup/
│   ├── popup.html           # UI
│   ├── popup.css            # Styling (light/dark aware)
│   └── popup.js             # UI controller (ES module)
├── lib/
│   ├── env.js               # browser.*/chrome.* namespace shim
│   ├── collect.js           # Tab/window/group collection (never wakes tabs)
│   └── markdown.js          # Markdown formatting, counts message, filenames
├── icons/                   # 16/32/48/128 px PNGs
└── README.md
```

## Installation (development)

### Chrome / Edge / Brave

1. Open `chrome://extensions` (`edge://extensions`, `brave://extensions`).
2. Enable **Developer mode**.
3. **Load unpacked** → select this folder.

### Firefox (139 or newer — required for the tab groups API)

1. Swap the manifest: `cp manifest.json manifest.chrome.json && cp manifest.firefox.json manifest.json`
   (or use `web-ext` with a build step). Restore afterwards.
2. Open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** →
   pick `manifest.json` in this folder.
3. For a permanent install, sign the ZIP on addons.mozilla.org (the
   `browser_specific_settings.gecko.id` in the manifest must stay stable).

## Enabling incognito / private-window access (required for action 3)

Browsers never grant extensions incognito access by default — the user must
opt in manually:

- **Chrome / Brave**: `chrome://extensions` → Tab Snapshot → **Details** →
  enable **Allow in Incognito**.
- **Edge**: `edge://extensions` → Tab Snapshot → **Details** →
  enable **Allow in InPrivate**.
- **Firefox**: `about:addons` → Tab Snapshot → **Details** tab →
  **Run in Private Windows** → **Allow**. (When loading a temporary add-on,
  Firefox also shows this as a checkbox in the install prompt.)

The manifest declares `"incognito": "spanning"` deliberately: in spanning mode a
single extension instance sees both regular and incognito windows, which is
what allows one popup to enumerate and export incognito tabs. (`"split"` would
isolate the incognito instance so the normal-window popup could never see those
tabs; Firefox does not support `"split"` at all.) If access has not been
granted, the popup detects it via `extension.isAllowedIncognitoAccess()` and
shows browser-specific instructions instead of a confusing empty export.

## Google Cloud setup (for Drive export)

Two OAuth clients are needed because Chromium and Firefox authenticate
differently: Chrome uses the browser-native `chrome.identity.getAuthToken`
(requires a **Chrome Extension** client), while Firefox — and Edge/Brave, which
ship `chrome.identity` but cannot mint Google tokens — fall back to
`identity.launchWebAuthFlow` (requires a **Web application** client).

### 1. Project and API

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → create a
   project (e.g. *Tab Snapshot*).
2. **APIs & Services → Library** → search **Google Drive API** → **Enable**.

### 2. OAuth consent screen

1. **APIs & Services → OAuth consent screen** → User type **External** → Create.
2. Fill in the app name, support email, and developer contact.
3. **Scopes** → *Add or remove scopes* → add
   `https://www.googleapis.com/auth/drive.file`
   (non-sensitive: access only to files the app itself creates).
4. While the app is in **Testing** status, add your Google account under
   **Test users** — otherwise sign-in is refused with `access_denied`.

### 3. Client A — "Chrome Extension" (for Chrome's getAuthToken)

1. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. Application type: **Chrome Extension**.
3. **Item ID**: your extension's 32-character ID.
   - Published: the ID from the Chrome Web Store listing.
   - Development: load the unpacked extension once and copy the ID from
     `chrome://extensions`. To keep that ID stable across machines, add the
     `"key"` field to `manifest.json` (copy the `key` from the Web Store
     developer dashboard, or from the generated `.pem` when packing).
4. Copy the client ID into `manifest.json` → `oauth2.client_id`.

> Note: `getAuthToken` needs the browser to be signed in to a Google account
> (Chrome sync sign-in). If it fails for any reason, the extension
> automatically falls back to Client B's web flow, so Drive export still works.

### 4. Client B — "Web application" (for launchWebAuthFlow: Firefox, Edge, Brave)

1. **Create credentials → OAuth client ID** → Application type: **Web application**.
2. Under **Authorized redirect URIs**, add the extension's identity redirect
   URL for each browser you target. Find it by running
   `browser.identity.getRedirectURL()` (Firefox) or
   `chrome.identity.getRedirectURL()` (Chromium) in the extension's background
   console (`about:debugging` → Inspect on Firefox). It looks like:
   - Firefox: `https://<hash-of-addon-id>.extensions.allizom.org/`
     (stable because `gecko.id` is pinned in `manifest.firefox.json`; for the
     current id `tab-snapshot@example.com` it is
     `https://d20b6781314671defd3978d3e33e9f6eef707e7e.extensions.allizom.org/`)
   - Chromium: `https://<extension-id>.chromiumapp.org/` — only needed for
     browsers that fall back to the web flow (Edge, Brave); Chrome itself
     uses the native `getAuthToken` path, which involves no redirect URI.
3. Copy the client ID into `background.js` → `WEB_OAUTH_CLIENT_ID`.

> **Error 400: redirect_uri_mismatch** during Firefox sign-in means the URI
> from step 2 is missing from (or does not exactly match) the Web client's
> **Authorized redirect URIs**. The match is character-exact: include the
> trailing slash, no path, no port. After saving, Google says changes can
> take 5 minutes to a few hours to propagate — usually a few minutes.
> Note that changing `gecko.id` in `manifest.firefox.json` (e.g. for AMO
> submission) changes the hash in the redirect URL, so the new URI must be
> added to the Google Cloud client again.

### 5. Smoke test

Click **Export All to Google Drive** → Google's account chooser opens →
approve → the popup shows the success message and the file appears in *My
Drive* as `tabs-export-<timestamp>.md`. Uploads use the Drive v3
`multipart/related` endpoint; expired tokens (HTTP 401) are invalidated and
retried once automatically.

## Implementation notes

- **Suspended/discarded tabs** are captured via
  `windows.getAll({ populate: true })`, which reads titles/URLs from the
  session store under the `tabs` permission — no content scripts, no
  `tabs.update`, so sleeping tabs stay asleep.
- **Tab groups** come from the `tabGroups` permission/API (Chrome 89+,
  Firefox 139+). On browsers without the API, all tabs are treated as
  ungrouped and `K` is `0`.
- **Local downloads** run in the background context because no single URL
  scheme works everywhere: Firefox's `downloads.download()` denies `data:`
  URLs, so its event page creates a Blob URL (revoked when the download
  settles); Chromium service workers lack `URL.createObjectURL`, so a `data:`
  URL is used there (which Chrome accepts). A Blob URL minted in the popup
  would not survive the popup closing — e.g. when the save dialog takes focus.
- **Close All Tabs** and the **Drive upload** are also executed in the
  background context, because both can outlive the popup (the popup dies when
  its window closes or the auth window takes focus). Drive results are also
  flashed on the toolbar badge (✓ / !) in case the popup closed mid-flow.
- `host_permissions` for `googleapis.com` are auto-granted on Chromium; on
  Firefox MV3 host permissions are user-optional, but the Drive endpoints send
  CORS headers, so the upload works either way.
