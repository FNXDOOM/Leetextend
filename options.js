const $ = (id) => document.getElementById(id);
const msg = (text, ok) => { $("msg").textContent = text; $("msg").className = ok ? "ok" : "err"; };
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

// The single "owner/repo" field is split into the two stored keys, so background.js is unchanged.
function read() {
  const token = $("token").value.trim();
  const full = $("repo").value.trim();
  const valid = REPO_RE.test(full);
  const [owner = "", repo = ""] = valid ? full.split("/") : [];
  return { token, owner, repo, valid };
}

chrome.storage.local.get(["token", "owner", "repo"]).then((v) => {
  $("token").value = v.token || "";
  $("repo").value = v.owner && v.repo ? `${v.owner}/${v.repo}` : "";
});

// Runs only when the user clicks the button (R18).
$("load").onclick = async () => {
  const { token } = read();
  if (!token) return msg("Paste your token first.", false);
  msg("Loading repositories…", true);
  const res = await chrome.runtime.sendMessage({ type: "LIST_REPOS", token });
  if (!res.ok) return msg(`${res.error} You can still type owner/repo by hand.`, false);
  $("repoList").replaceChildren(
    ...res.repos.map((r) => {
      const o = document.createElement("option");
      o.value = r.name;
      if (r.isEmpty) o.label = "empty: needs an initial commit";
      return o;
    })
  );
  msg(`Loaded ${res.repos.length} repositories. Click the repository field to pick one.`, true);
};

$("save").onclick = async () => {
  const { token, owner, repo, valid } = read();
  if (!token) return msg("Paste your GitHub token.", false);
  if (!valid) return msg("Choose a repository, or type it as owner/repo.", false);
  await chrome.storage.local.set({ token, owner, repo });
  msg("Saved.", true);
};

$("test").onclick = async () => {
  const { token, owner, repo, valid } = read();
  if (!token || !valid) return msg("Enter the token and choose a repository first.", false);
  msg("Testing…", true);
  const res = await chrome.runtime.sendMessage({ type: "TEST", token, owner, repo });
  res.ok ? msg(`Connected. Default branch: ${res.branch}`, true) : msg(res.error, false);
};
