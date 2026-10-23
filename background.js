importScripts("config.js"); // WORKER_URL, saveTokens

// ---------- constants ----------
const LC_GRAPHQL = "https://leetcode.com/graphql";
const GH_GRAPHQL = "https://api.github.com/graphql";

const EXT = {
  python3: "py", python: "py", pythondata: "py", cpp: "cpp", c: "c", java: "java",
  javascript: "js", typescript: "ts", golang: "go", rust: "rs", kotlin: "kt",
  csharp: "cs", swift: "swift", ruby: "rb", scala: "scala", php: "php", dart: "dart",
  racket: "rkt", erlang: "erl", elixir: "ex", bash: "sh",
  mysql: "sql", mssql: "sql", oraclesql: "sql", postgresql: "sql",
};

// ---------- LeetCode queries (keep all here; undocumented API, may change) ----------
const Q_LIST = `query($s:String!){
  questionSubmissionList(offset:0, limit:20, questionSlug:$s){
    submissions{ id statusDisplay }
  }
}`;

const Q_DETAILS = `query($id:Int!,$s:String!){
  details: submissionDetails(submissionId:$id){
    code runtimeDisplay memoryDisplay lang{ name }
  }
  q: question(titleSlug:$s){ questionFrontendId title titleSlug difficulty }
}`;

const Q_QUESTION = `query($s:String!){
  question(titleSlug:$s){ questionFrontendId title titleSlug difficulty }
}`;

// autosync: just the verdict and the problem slug (statusCode 10 = Accepted)
const Q_AUTO = `query($id:Int!){
  details: submissionDetails(submissionId:$id){ statusCode question{ titleSlug } }
}`;

// bulk: every problem the logged-in user has solved (status AC), 100 per page
const Q_SOLVED = `query($skip:Int,$limit:Int,$filters:QuestionListFilterInput){
  problemsetQuestionList: questionList(categorySlug:"", limit:$limit, skip:$skip, filters:$filters){
    total: totalNum
    questions: data{ questionFrontendId title titleSlug difficulty }
  }
}`;

// ---------- helpers ----------
async function lcGql(query, variables) {
  const r = await fetch(LC_GRAPHQL, {
    method: "POST",
    credentials: "include", // sends the user's logged-in LeetCode session
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!r.ok) {
    throw new Error(`LeetCode request failed (${r.status}). Make sure you are logged in to leetcode.com.`);
  }
  const j = await r.json();
  if (j.errors) throw new Error(`LeetCode: ${j.errors[0].message}`);
  return j.data;
}

async function ghGql(token, query, variables) {
  const r = await fetch(GH_GRAPHQL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (r.status === 403 || r.status === 429) {
    const e = new Error("GitHub rate limit hit. Wait a minute and retry.");
    e.rateLimited = true;
    throw e;
  }
  if (r.status === 401) throw new Error("GitHub rejected the token (401). Check it in settings.");
  const j = await r.json();
  if (j.errors) throw new Error(`GitHub: ${j.errors[0].message}`);
  return j.data;
}

// Repos the GitHub App was granted (only those the user selected at install time).
async function listAppRepos(token) {
  try {
    const rest = async (path) => {
      const r = await fetch(`https://api.github.com${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      });
      if (r.status === 401) throw new Error("GitHub rejected the token (401). Click Connect GitHub again.");
      if (!r.ok) throw new Error(`GitHub request failed (${r.status}).`);
      return r.json();
    };
    const { installations } = await rest("/user/installations?per_page=100");
    const lists = await Promise.all(
      installations.map((i) => rest(`/user/installations/${i.id}/repositories?per_page=100`))
    );
    const repos = lists
      .flatMap((l) => l.repositories)
      .filter((r) => !r.archived)
      .map((r) => ({ name: r.full_name, isEmpty: false }));
    return { ok: true, repos };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// UTF-8 safe base64
function b64(str) {
  let bin = "";
  for (const byte of new TextEncoder().encode(str)) bin += String.fromCharCode(byte);
  return btoa(bin);
}

// Expiring GitHub App tokens are refreshed through the worker. Refresh tokens rotate (the old one dies),
// so concurrent callers must share one refresh.
let refreshing = null;
function refreshAccess(refreshToken) {
  return (refreshing ??= (async () => {
    try {
      const r = await fetch(`${WORKER_URL}/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      const t = await r.json();
      if (t.access_token) {
        await saveTokens(t);
        return t.access_token;
      }
      if (t.code === "bad_refresh_token") { // revoked or too old: the user has to sign in again
        await chrome.storage.local.remove(["token", "refreshToken", "expiresAt"]);
        throw new Error("GitHub session expired. Open settings and click Connect GitHub.");
      }
      throw new Error(`Could not refresh the GitHub token (${t.error || r.status}). Try again.`);
    } finally {
      refreshing = null;
    }
  })());
}

async function getConfig(refresh = true) {
  let { token, refreshToken, expiresAt, owner, repo } = await chrome.storage.local.get(["token", "refreshToken", "expiresAt", "owner", "repo"]);
  if (refresh && token && refreshToken && expiresAt && Date.now() > expiresAt - 60000) {
    token = await refreshAccess(refreshToken);
  }
  return { token, owner, repo, configured: !!(token && owner && repo) };
}

async function getHead(token, owner, repo) {
  const d = await ghGql(
    token,
    `query($o:String!,$r:String!){
       repository(owner:$o,name:$r){ defaultBranchRef{ name target{ oid } } }
     }`,
    { o: owner, r: repo }
  );
  const ref = d.repository?.defaultBranchRef;
  if (!ref) throw new Error("Repo not found, or empty (make an initial commit first).");
  return { branch: ref.name, oid: ref.target.oid };
}

// question info, cached in session storage (cleared when the browser closes)
async function getQuestion(slug) {
  const key = `q:${slug}`;
  const hit = (await chrome.storage.session.get(key))[key];
  if (hit) return hit;
  const d = await lcGql(Q_QUESTION, { s: slug });
  if (d.question) await chrome.storage.session.set({ [key]: d.question });
  return d.question;
}

// ---------- the sync ----------
const COMMIT = `mutation($input:CreateCommitOnBranchInput!){
  createCommitOnBranch(input:$input){ commit{ oid } }
}`;

// The two files committed for one solved problem. Shared by sync() and syncAll().
function solutionFiles(q, det) {
  const safe = (s) => String(s).replace(/[^\w-]/g, ""); // ids/slugs come from LeetCode: never let them add path parts
  const folder = `${safe(q.questionFrontendId).padStart(4, "0")}-${safe(q.titleSlug)}`;
  const ext = Object.hasOwn(EXT, det.lang.name) ? EXT[det.lang.name] : "txt";
  const path = `${folder}/solution.${ext}`;
  const readme =
    `# ${q.questionFrontendId}. ${q.title}\n\n` +
    `- Difficulty: ${q.difficulty}\n` +
    `- Language: ${det.lang.name}\n` +
    `- Runtime: ${det.runtimeDisplay}\n` +
    `- Memory: ${det.memoryDisplay}\n` +
    `- Link: https://leetcode.com/problems/${q.titleSlug}/\n`;
  return {
    path,
    additions: [
      { path, contents: b64(det.code) },
      { path: `${folder}/README.md`, contents: b64(readme) },
    ],
  };
}

// ONE queue for every GitHub write, manual or automatic: writes run serially (GitHub's advice)
// and a double click or two quick submissions can never race. It lives in memory only, which is
// fine because the worker stays awake while a job runs.
let queue = Promise.resolve();
function exclusive(job) {
  const run = queue.then(job);
  queue = run.catch(() => {}); // a failed job must not block the next one
  return run;
}

// subId (optional): sync exactly this submission. Autosync passes it, because the "latest accepted"
// list can lag behind the verdict and would return the previous submission, which then gets skipped.
function sync(slug, force, subId) {
  return exclusive(async () => {
    const { token, owner, repo, configured } = await getConfig();
    if (!configured) throw new Error("Set your GitHub token, username and repo in settings first.");

    // start the GitHub head lookup now; it runs in parallel with the LeetCode calls
    const headP = getHead(token, owner, repo);
    headP.catch(() => {}); // avoid an unhandled rejection if we return early

    // 1) the submission to sync: the one given, else the latest accepted
    let sub;
    if (subId) {
      sub = { id: String(subId) };
    } else {
      const list = await lcGql(Q_LIST, { s: slug });
      sub = list.questionSubmissionList.submissions.find((x) => x.statusDisplay === "Accepted");
      if (!sub) throw new Error("No accepted submission found for this problem.");
    }

    // 2) skip if this exact submission was already synced
    const syncedKey = `synced:${slug}`;
    const prev = (await chrome.storage.local.get(syncedKey))[syncedKey];
    if (!force && prev && prev.id === sub.id) return { ...prev, skipped: true };

    // 3) details + question metadata in one request
    const d = await lcGql(Q_DETAILS, { id: Number(sub.id), s: slug });
    const det = d.details;
    const q = d.q;
    if (!det || !q) throw new Error("Could not read submission details from LeetCode.");

    const { path, additions } = solutionFiles(q, det);

    const commit = (head) =>
      ghGql(token, COMMIT, {
        input: {
          branch: { repositoryNameWithOwner: `${owner}/${repo}`, branchName: head.branch },
          message: { headline: `Add ${q.title} (${det.lang.name})` },
          fileChanges: {
            additions,
          },
          expectedHeadOid: head.oid,
        },
      });

    // 4) one commit with both files; retry once if the branch head moved
    let head = await headP;
    try {
      await commit(head);
    } catch (e) {
      if (e.rateLimited) throw e;
      head = await getHead(token, owner, repo);
      await commit(head);
    }

    const result = {
      id: sub.id,
      title: q.title,
      path,
      url: `https://github.com/${owner}/${repo}/blob/${head.branch}/${path}`,
    };
    await chrome.storage.local.set({ [syncedKey]: result });
    return result;
  });
}

// ---------- sync ALL solved problems (one-time catch-up) ----------
// Finds every problem you have solved, fetches your latest accepted code for each one that is not
// synced yet, and commits them in batches of BULK_SIZE problems (one commit per batch).
const BULK_SIZE = 40;

async function mapLimit(items, n, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    })
  );
}

function syncAll() {
  return exclusive(async () => {
    const { token, owner, repo, configured } = await getConfig();
    if (!configured) throw new Error("Set your GitHub token, username and repo in settings first.");
    const progress = (phase, done = 0, total = 0) => chrome.storage.session.set({ bulk: { phase, done, total } });

    // 1) every problem you have solved
    await progress("Finding solved problems…");
    const solved = [];
    for (let skip = 0; ; skip += 100) {
      const page = (await lcGql(Q_SOLVED, { skip, limit: 100, filters: { status: "AC" } })).problemsetQuestionList;
      solved.push(...page.questions);
      if (!page.questions.length || solved.length >= page.total) break;
    }

    // 2) leave out the ones already synced
    const have = await chrome.storage.local.get(solved.map((q) => `synced:${q.titleSlug}`));
    const todo = solved.filter((q) => !have[`synced:${q.titleSlug}`]);
    if (!todo.length) return { added: 0, skipped: 0, failed: 0, alreadySynced: solved.length };

    // 3) fetch your latest accepted code for each, 3 at a time to stay gentle with LeetCode
    const items = [];
    let done = 0, skipped = 0, failed = 0;
    await progress("Reading solutions", 0, todo.length);
    await mapLimit(todo, 3, async (q) => {
      try {
        const list = await lcGql(Q_LIST, { s: q.titleSlug });
        const sub = list.questionSubmissionList.submissions.find((x) => x.statusDisplay === "Accepted");
        if (!sub) { skipped++; return; } // accepted submission is older than your last 20 attempts
        const det = (await lcGql(Q_DETAILS, { id: Number(sub.id), s: q.titleSlug })).details;
        if (!det) { failed++; return; }
        items.push({ q, det, id: sub.id });
      } catch (e) {
        failed++;
      } finally {
        await progress("Reading solutions", ++done, todo.length);
      }
    });
    items.sort((a, b) => Number(a.q.questionFrontendId) - Number(b.q.questionFrontendId));

    // 4) commit in batches
    let added = 0;
    for (let i = 0; i < items.length; i += BULK_SIZE) {
      const chunk = items.slice(i, i + BULK_SIZE);
      await progress("Committing", i, items.length);
      const additions = chunk.flatMap(({ q, det }) => solutionFiles(q, det).additions);
      const commit = (h) =>
        ghGql(token, COMMIT, {
          input: {
            branch: { repositoryNameWithOwner: `${owner}/${repo}`, branchName: h.branch },
            message: { headline: `Add ${chunk.length} solved problems` },
            fileChanges: { additions },
            expectedHeadOid: h.oid,
          },
        });
      let head = await getHead(token, owner, repo);
      try {
        await commit(head);
      } catch (e) {
        if (e.rateLimited) throw e;
        head = await getHead(token, owner, repo);
        await commit(head);
      }
      const records = {};
      for (const { q, det, id } of chunk) {
        const path = solutionFiles(q, det).path;
        records[`synced:${q.titleSlug}`] = {
          id, title: q.title, path,
          url: `https://github.com/${owner}/${repo}/blob/${head.branch}/${path}`,
        };
      }
      await chrome.storage.local.set(records);
      added += chunk.length;
    }
    await progress("Done", added, added);
    return { added, skipped, failed, alreadySynced: solved.length - todo.length };
  });
}

// ---------- autosync (no content script) ----------
// While a submission is being judged, LeetCode's page polls
//   GET https://leetcode.com/submissions/detail/<id>/check/
// about once a second. chrome.webRequest (observe only) wakes this worker for each poll; we never
// read the response. Instead we ask LeetCode's GraphQL for the verdict and call sync() only when it
// is Accepted. "Run Code" uses ids like "runcode_…", so the numeric-only regex ignores it.
// If LeetCode changes this endpoint, CHECK_URL and CHECK_RE are the only things to update.
const CHECK_URL = "https://leetcode.com/submissions/detail/*/check/*";
const CHECK_RE = /\/submissions\/detail\/(\d+)\/check\//;
const ACCEPTED = 10;
const FAILED = new Set([11, 12, 13, 14, 15, 20]); // WA, MLE, OLE, TLE, runtime error, compile error
const watching = new Set(); // ids being judged right now; only de-dupes the polls
const log = (...a) => console.log("[autosync]", ...a); // view: chrome://extensions > Inspect service worker

// Listeners must be registered at the top level, synchronously, so Chrome can wake the worker.
chrome.webRequest.onCompleted.addListener(
  (d) => {
    const id = CHECK_RE.exec(d.url)?.[1];
    log("check request", id, d.statusCode);
    if (id && d.statusCode === 200) watch(id);
  },
  { urls: [CHECK_URL] }
);

async function watch(id) {
  if (watching.has(id)) return;
  watching.add(id);
  try {
    const { autoSync = true } = await chrome.storage.local.get("autoSync"); // default ON
    const cfg = await getConfig().catch((e) => ({ configured: false, error: e.message }));
    if (cfg.error) { await report({ ok: false, error: cfg.error }); return; }
    if (!autoSync || !cfg.configured) { log("skipped: autoSync", autoSync, "configured", cfg.configured); return; }

    const doneKey = `auto:${id}`;
    if ((await chrome.storage.session.get(doneKey))[doneKey]) return; // handled earlier this session

    // Wait for the verdict: up to ~12 s here. If judging is slower, the page's next poll calls watch() again.
    let lastError = null;
    for (let i = 0; i < 6; i++) {
      let det = null;
      try {
        det = (await lcGql(Q_AUTO, { id: Number(id) })).details;
        lastError = null;
        log("poll", i, id, JSON.stringify(det));
      } catch (e) {
        lastError = e; // still judging, a LeetCode hiccup, or logged out: try again below
        log("poll error", i, id, e.message);
      }

      if (det?.statusCode === ACCEPTED) {
        try {
          const res = await sync(det.question.titleSlug, false, id); // same path as the Sync button, for this exact submission
          log("sync result", JSON.stringify(res));
          await chrome.storage.session.set({ [doneKey]: 1 });
          if (!res.skipped) await report({ ok: true, title: res.title, path: res.path, url: res.url });
        } catch (e) {
          log("sync failed", e.message);
          await report({ ok: false, error: e.message });
        }
        return;
      }
      if (det && FAILED.has(det.statusCode)) return; // judged, not accepted: nothing to sync

      await new Promise((r) => setTimeout(r, 2000));
    }
    // only surface real request failures (e.g. logged out), not "still judging" GraphQL errors
    if (lastError && /request failed/.test(lastError.message)) {
      await report({ ok: false, error: lastError.message });
    }
  } finally {
    watching.delete(id);
  }
}

// Silent feature, so show the outcome: toolbar badge + a line in the popup.
async function report(r) {
  await chrome.storage.local.set({ lastAuto: { ...r, at: Date.now() } });
  await chrome.action.setBadgeBackgroundColor({ color: r.ok ? "#16a34a" : "#dc2626" });
  await chrome.action.setBadgeText({ text: r.ok ? "✓" : "!" });
}

// ---------- message handlers ----------
const handlers = {
  async SYNC({ slug, force }) {
    try {
      return { ok: true, ...(await sync(slug, !!force)) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  // popup: "Sync all solved problems" (progress is written to storage.session.bulk)
  async SYNC_ALL() {
    try {
      return { ok: true, ...(await syncAll()) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  // popup open: is the extension configured, and what problem is this?
  async INFO({ slug }) {
    const { owner, repo, configured } = await getConfig(false); // popup open: no refresh needed
    let question = null;
    if (slug) {
      try { question = await getQuestion(slug); } catch { /* popup falls back to the slug */ }
    }
    return { configured, repo: owner && repo ? `${owner}/${repo}` : "", question };
  },

  // options page: "Load my repositories" (runs only on click, see R18)
  async LIST_REPOS({ token }) {
    if (typeof token === "string" && token.startsWith("ghu_")) return listAppRepos(token); // GitHub App user token
    try {
      const d = await ghGql(
        token,
        `query{
           viewer{
             repositories(first:100, orderBy:{field:PUSHED_AT, direction:DESC},
                          affiliations:[OWNER, COLLABORATOR, ORGANIZATION_MEMBER]){
               nodes{ nameWithOwner isEmpty isArchived }
             }
           }
         }`,
        {}
      );
      const repos = d.viewer.repositories.nodes
        .filter((r) => !r.isArchived)
        .map((r) => ({ name: r.nameWithOwner, isEmpty: r.isEmpty }));
      return { ok: true, repos };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  // options page: the current token, refreshed first if it is about to expire
  async TOKEN() {
    try {
      return { token: (await getConfig()).token || "" };
    } catch (e) {
      return { token: "", error: e.message };
    }
  },

  // options page: "Test connection"
  async TEST({ token, owner, repo }) {
    try {
      const head = await getHead(token, owner, repo);
      return { ok: true, branch: head.branch };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },
};

// first install: open settings so the user can click Connect GitHub right away
chrome.runtime.onInstalled.addListener((d) => {
  if (d.reason === "install") chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false; // extension pages only
  const h = msg && Object.hasOwn(handlers, msg.type) ? handlers[msg.type] : null;
  if (!h) return false;
  h(msg).then(sendResponse);
  return true; // keep the channel open for the async response
});
