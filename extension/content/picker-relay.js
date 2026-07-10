/**
 * Content script for the hosted Google Picker page (docs/picker.html).
 *
 * The page cannot talk to the extension directly (Firefox has no
 * externally_connectable), so it posts its result as a same-origin window
 * message and this relay forwards it to the background script, which
 * validates the state nonce before trusting it.
 */

'use strict';

const api = globalThis.browser ?? globalThis.chrome;

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const data = event.data;
  if (data?.type !== 'tab-snapshot-picker-result' || typeof data.state !== 'string') return;

  api.runtime.sendMessage({
    type: 'folder-picked',
    state: data.state,
    folder:
      data.folder && typeof data.folder.id === 'string' && typeof data.folder.name === 'string'
        ? { id: data.folder.id, name: data.folder.name }
        : null,
  });
});
