// Fill these in once (see README). The Client ID is public; the client secret lives only in the worker.
// Shared by options.js and background.js (loaded with <script> / importScripts).
const CLIENT_ID = "";  // GitHub App > General > Client ID
const APP_SLUG = "";   // the <slug> in https://github.com/apps/<slug>
const WORKER_URL = ""; // e.g. https://leetcode-github-auth.<you>.workers.dev (no trailing slash)

// Store a token response from the worker. A token without refresh_token/expires_in never refreshes.
const saveTokens = (t) =>
  chrome.storage.local.set({
    token: t.access_token,
    refreshToken: t.refresh_token || "",
    expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : 0,
  });
