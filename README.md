# Tabs Exporter

Cross-browser (Chrome / Edge / Brave / Firefox) Manifest V3 extension that exports
every open tab to structured Markdown — as a local `.md` download or straight to
Google Drive — with full support for tab groups, incognito windows, and
suspended/discarded tabs (they are read without being woken up).

## Features

1. **Export All to Markdown** — downloads all tabs from all windows as a `.md` file.
2. **Export All to Google Drive** — opens a sub-menu (with a Back button)
   offering two formats:
   - **as Markdown file** — uploads the `.md` file as-is;
   - **as native document** — creates a native Google Doc: the Markdown is
     converted server-side by Drive (target mimeType
     `application/vnd.google-apps.document`), so headers, links, and lists
     become real Docs formatting.

   Uses OAuth2 with the `drive.file` scope — the extension can only see files
   it created. On success the popup shows a clickable link to the created file.

   The sub-menu also shows the **target folder** (default: *My Drive*),
   remembered until changed. **Change…** opens the real Google Picker on a
   small page you host (see "Choosing a Drive folder" below); **New folder**
   creates a folder inside the current target and selects it.
3. **Export Incognito Only** — downloads only currently open incognito/private tabs.
4. **Close All Tabs** — closes every tab in every window, behind an in-popup
   confirmation step.

After any successful export the popup shows:

> `N tabs for M windows and K tabs groups are exported!`

Exports usually settle after the popup has already closed — the OS save
dialog or Google's auth window takes focus, which closes it. So the result of
the last successful export is persisted, and the next time the popup opens it
replays the same status prefixed with **"Previously"**, followed by how the
export was made (`to a local Markdown file`, `to Google Drive`, or
`incognito tabs to a local Markdown file`), e.g.
`Previously 12 tabs for 2 windows and 1 tabs groups are exported! (to Google
Drive)`. It stays until the next export replaces it.

Every export also shows the created file's name as a link: Drive exports open
the file on Google Drive, and local exports reveal the saved `.md` file in the
system file manager (extensions cannot link `file://` URLs directly, so this
uses `downloads.show()`; if the entry was cleared from the browser's download
history, a message says so). Two Firefox quirks are handled: `show()` must be
called before any `await` in the click handler or Firefox no longer counts it
as user input and refuses it, and Firefox resolves `show()` with `false`
instead of rejecting when it cannot reach a file manager (e.g. sandboxed
Snap/Flatpak builds) — in that case the extension opens the Downloads folder
instead, or shows the file's full path.

### Markdown format

- Tabs inside a tab group are listed under `## Group: [Group Name]`.
- Ungrouped tabs are listed under `## Window: [First Tab Title]`
  (the title of the first tab of that window).
- Every tab is a link: `- [Tab Title](URL)`.

## Project structure

```
save_tabs_extension/
├── README.md
├── docs/
│   └── picker.html              # Hosted Google Picker page (serve via GitHub Pages)
└── extension/                   # ← load THIS folder as the unpacked extension
    ├── manifest.json            # Chromium manifest (Chrome / Edge / Brave)
    ├── manifest.firefox.json    # Firefox manifest (swap in when packaging for Firefox)
    ├── background.js            # Service worker / event page: OAuth2 + Drive upload,
    │                            # folder picking/creation, close-all-tabs (classic
    │                            # script — no ES imports, runs on both browsers)
    ├── content/
    │   └── picker-relay.js      # Relays the picked folder from the hosted page
    ├── popup/
    │   ├── popup.html           # UI
    │   ├── popup.css            # Styling (light/dark aware)
    │   └── popup.js             # UI controller (ES module)
    ├── lib/
    │   ├── env.js               # browser.*/chrome.* namespace shim
    │   ├── collect.js           # Tab/window/group collection (never wakes tabs)
    │   └── markdown.js          # Markdown formatting, counts message, filenames
    └── icons/                   # 16/32/48/128 px PNGs
```

## Installation (development)

### Chrome / Edge / Brave

1. Open `chrome://extensions` (`edge://extensions`, `brave://extensions`).
2. Enable **Developer mode**.
3. **Load unpacked** → select the `extension/` folder.

### Firefox (139 or newer — required for the tab groups API)

1. Swap the manifest inside `extension/`:
   `cd extension && cp manifest.json manifest.chrome.json && cp manifest.firefox.json manifest.json`
   (or use `web-ext` with a build step). Restore afterwards.
2. Open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** →
   pick `extension/manifest.json`.
3. For a permanent install, sign the ZIP on addons.mozilla.org (the
   `browser_specific_settings.gecko.id` in the manifest must stay stable).

## Enabling incognito / private-window access (required for action 3)

Browsers never grant extensions incognito access by default — the user must
opt in manually:

- **Chrome / Brave**: `chrome://extensions` → Tabs Exporter → **Details** →
  enable **Allow in Incognito**.
- **Edge**: `edge://extensions` → Tabs Exporter → **Details** →
  enable **Allow in InPrivate**.
- **Firefox**: `about:addons` → Tabs Exporter → **Details** tab →
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
   project (e.g. *Tabs Exporter*).
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

## Choosing a Drive folder (hosted Google Picker)

The Google Picker cannot run inside an MV3 extension page — extension CSP and
store policies forbid loading Google's remote `api.js`. So the Picker lives on
a tiny static page, `docs/picker.html`, that **you host** (GitHub Pages is the
easy path since it can serve this repo's `docs/` folder). This keeps the
narrow `drive.file` scope: **picking a folder in the Picker is exactly what
grants the extension write access to it.**

How the flow works: the popup's **Change…** button asks the background for an
access token, which opens `picker.html#access_token=…&state=…` in a new tab
(the fragment never leaves the browser). The page shows a folders-only Picker;
the result is posted as a window message, picked up by the extension's content
script (`extension/content/picker-relay.js`), validated against the `state`
nonce in the background, persisted, and the tab closes itself. The chosen
folder is shown in the Drive sub-menu and used for all exports until changed.
If the folder is later deleted in Drive, the next export shows a clear error
and resets the target to My Drive.

### One-time setup

1. **Host the page**: push this repo to GitHub → repo **Settings → Pages** →
   Source: *Deploy from a branch*, Branch: `main`, folder `/docs`. The page
   URL becomes `https://<your-username>.github.io/save_tabs_extension/picker.html`.
2. **Enable the Picker API**: in the same Google Cloud project as the OAuth
   clients (this is required — the `drive.file` grant is per-project), open
   **APIs & Services → Library** → **Google Picker API** → **Enable**.
3. **Create a browser API key**: **Credentials → Create credentials → API
   key**. Restrict it: *Application restrictions* → **Websites** → add your
   Pages origin (`https://<your-username>.github.io/*`); *API restrictions* →
   **Google Picker API** only.
4. **Find the project number**: **IAM & Admin → Settings** → *Project number*
   (numeric, not the project ID). The Picker's `setAppId()` needs it so the
   folder grant applies to this app.
5. **Fill the placeholders**:
   - `docs/picker.html` → `API_KEY`, `PROJECT_NUMBER`;
   - `extension/background.js` → `PICKER_PAGE_URL`;
   - both manifests → `content_scripts[0].matches` (replace
     `your-github-username`).
6. Commit, push (so Pages redeploys), and reload the extension.

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

## License

GPLv3 — see [COPYING](COPYING).
