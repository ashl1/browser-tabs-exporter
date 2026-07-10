/**
 * Cross-browser environment shim.
 *
 * Firefox exposes the promise-based `browser.*` namespace natively.
 * Chromium (Chrome / Edge / Brave) exposes `chrome.*`, which in Manifest V3
 * returns Promises for every API this extension uses when the callback is
 * omitted — so aliasing is sufficient here. The one callback-only holdout
 * (`chrome.identity.getAuthToken`) is wrapped manually in background.js.
 */

export const api = globalThis.browser ?? globalThis.chrome;

export const IS_FIREFOX = api.runtime.getURL('').startsWith('moz-extension://');
