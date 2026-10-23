const $ = (id) => document.getElementById(id);
const msg = (text, ok) => { $("msg").textContent = text; $("msg").className = ok ? "ok" : "err"; };
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

// CLIENT_ID, APP_SLUG, WORKER_URL and saveTokens() live in config.js
const REDIRECT = chrome.identity.getRedirectURL(); // register this as the app's Callback URL
console.log("GitHub App callback URL:", REDIRECT);
const INSTALL_URL = () => `https://github.com/apps/${APP_SLUG}/installations/new`;

// The single "owner/repo" field is split into the two stored keys, so background.js is unchanged.
function read() {
  const token = $("token").value.trim();
  const full = $("repo").value.trim();
  const valid = REPO_RE.test(full);
  const [owner = "", repo = ""] = valid ? full.split("/") : [];
  return { token, owner, repo, valid };
}

chrome.storage.local.get(["owner", "repo"]).then((v) => {
  $("repo").value = v.owner && v.repo ? `${v.owner}/${v.repo}` : "";
});
// the background hands back a fresh token (it refreshes an expiring one first)
chrome.runtime.sendMessage({ type: "TOKEN" }).then((r) => {
  $("token").value = r?.token || "";
  if (r?.error) msg(r.error, false);
});

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
// GitHub in a small browser popup; resolves with the URL it redirects to, rejects if the popup is closed
const webFlow = (url) => chrome.identity.launchWebAuthFlow({ url, interactive: true });

// ---- repositories ----
const known = new Set();
async function listRepos(token) {
  const res = await chrome.runtime.sendMessage({ type: "LIST_REPOS", token });
  if (!res.ok) throw new Error(res.error);
  known.clear();
  res.repos.forEach((r) => known.add(r.name));
  $("repoList").replaceChildren(
    ...res.repos.map((r) => {
      const o = document.createElement("option");
      o.value = r.name;
      if (r.isEmpty) o.label = "empty: needs an initial commit";
      return o;
    })
  );
  return res.repos;
}

// Save the choice, then test it once. This is where setup ends.
async function finish() {
  const { token, owner, repo, valid } = read();
  if (!token || !valid) return;
  const cur = (await chrome.storage.local.get("token")).token;
  await chrome.storage.local.set({ owner, repo });
  if (token !== cur) { // a pasted token replaces the signed-in one: drop the old refresh data
    await chrome.storage.local.set({ token });
    await chrome.storage.local.remove(["refreshToken", "expiresAt"]);
  }
  msg("Testing connection…", true);
  const res = await chrome.runtime.sendMessage({ type: "TEST", token, owner, repo });
  res.ok
    ? msg(`Connected to ${owner}/${repo} (branch ${res.branch}). You're all set: open a LeetCode problem and submit.`, true)
    : msg(res.error, false);
}

// Use the repos you granted. None yet: show GitHub's repo picker in a popup.
async function pickRepo(token) {
  let repos = await listRepos(token);
  if (!repos.length) {
    msg("Choose which repositories to allow in the GitHub window…", true);
    try { await webFlow(INSTALL_URL()); } catch { /* window closed before GitHub redirected: fine */ }
    for (let i = 0; i < 5; i++) { // GitHub can take a moment to show a new install
      repos = await listRepos(token);
      if (repos.length) break;
      await sleep(2);
    }
    if (!repos.length) throw new Error("No repositories were granted. Click Connect GitHub to try again.");
  }
  if (repos.length === 1) {
    $("repo").value = repos[0].name;
    return finish();
  }
  msg("Pick the repository to sync to.", true);
  $("repo").value = "";
  $("repo").focus();
}

// choosing a repo from the list finishes setup
$("repo").oninput = () => { if (known.has($("repo").value)) finish(); };

// ---- sign in: GitHub popup -> code -> worker swaps it for tokens (the worker holds the secret) ----
const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function authorize() {
  const state = crypto.randomUUID();
  // PKCE: only this run knows the verifier, so a stolen code is useless
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const back = new URL(
    await webFlow(
      "https://github.com/login/oauth/authorize?" +
        new URLSearchParams({
          client_id: CLIENT_ID, redirect_uri: REDIRECT, state,
          code_challenge: challenge, code_challenge_method: "S256",
        })
    )
  );
  if (back.searchParams.get("state") !== state) throw new Error("Sign-in was interrupted. Try again.");
  const code = back.searchParams.get("code");
  if (!code) throw new Error(back.searchParams.get("error_description") || "GitHub did not return a code.");
  const r = await fetch(`${WORKER_URL}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, redirect_uri: REDIRECT, code_verifier: verifier }),
  });
  const t = await r.json();
  if (!t.access_token) throw new Error(t.error || "Could not get a token from GitHub.");
  return t;
}

$("connect").onclick = async () => {
  if (!CLIENT_ID || !APP_SLUG || !WORKER_URL) {
    return msg("Set CLIENT_ID, APP_SLUG and WORKER_URL in config.js first (see README).", false);
  }
  $("connect").disabled = true;
  try {
    msg("Authorize the app in the GitHub window…", true);
    const t = await authorize();
    await saveTokens(t);
    $("token").value = t.access_token;
    await pickRepo(t.access_token);
  } catch (e) {
    msg(e.message, false);
  } finally {
    $("connect").disabled = false;
  }
};

// Sign out here and revoke the app's access on GitHub.
$("disconnect").onclick = async () => {
  const { token } = read();
  if (!token) return msg("Not connected.", false);
  $("disconnect").disabled = true;
  const app = token.startsWith("ghu_"); // a pasted personal token can't be revoked from here
  let revoked = false;
  if (app) {
    try {
      const r = await fetch(`${WORKER_URL}/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_token: token }),
      });
      revoked = r.ok;
    } catch { /* offline: still sign out locally */ }
  }
  const all = await chrome.storage.local.get(null); // synced:* records belong to the old repo
  await chrome.storage.local.remove([
    "token", "refreshToken", "expiresAt", "owner", "repo", "lastAuto",
    ...Object.keys(all).filter((k) => k.startsWith("synced:")),
  ]);
  $("token").value = "";
  $("repo").value = "";
  $("repoList").replaceChildren();
  $("disconnect").disabled = false;
  msg(
    revoked ? "Disconnected, and access was revoked on GitHub."
      : app ? "Disconnected here, but GitHub couldn't be reached. Remove the app under GitHub → Settings → Applications."
      : "Disconnected. Delete the token on GitHub to fully revoke it.",
    revoked || !app
  );
};

// Change which repos the app can see, then refresh the list.
$("manage").onclick = async () => {
  if (!APP_SLUG) return msg("Set APP_SLUG in config.js first (see README).", false);
  try { await webFlow(INSTALL_URL()); } catch { /* closed: fine */ }
  const { token } = read();
  if (!token) return;
  try { const r = await listRepos(token); msg(`Repository list updated (${r.length}). Pick one.`, true); }
  catch (e) { msg(e.message, false); }
};

// ---- manual controls (token users) ----
$("load").onclick = async () => {
  const { token } = read();
  if (!token) return msg("Connect GitHub or paste a token first.", false);
  msg("Loading repositories…", true);
  try {
    const r = await listRepos(token);
    msg(r.length ? `Loaded ${r.length} repositories. Click the repository field to pick one.`
                 : "No repositories granted yet. Click “Choose repositories on GitHub”.", r.length > 0);
  } catch (e) { msg(`${e.message} You can still type owner/repo by hand.`, false); }
};

$("save").onclick = () => {
  const { token, valid } = read();
  if (!token) return msg("Connect GitHub or paste a token.", false);
  if (!valid) return msg("Choose a repository, or type it as owner/repo.", false);
  finish();
};

$("test").onclick = async () => {
  const { token, owner, repo, valid } = read();
  if (!token || !valid) return msg("Connect GitHub (or paste a token) and choose a repository first.", false);
  msg("Testing…", true);
  const res = await chrome.runtime.sendMessage({ type: "TEST", token, owner, repo });
  res.ok ? msg(`Connected. Default branch: ${res.branch}`, true) : msg(res.error, false);
};
