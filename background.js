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

// UTF-8 safe base64
function b64(str) {
  let bin = "";
  for (const byte of new TextEncoder().encode(str)) bin += String.fromCharCode(byte);
  return btoa(bin);
}

async function getConfig() {
  const { token, owner, repo } = await chrome.storage.local.get(["token", "owner", "repo"]);
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

let syncing = false; // in-flight guard only; no persistent state lives in memory

async function sync(slug, force) {
  if (syncing) throw new Error("A sync is already in progress.");
  syncing = true;
  try {
    const { token, owner, repo, configured } = await getConfig();
    if (!configured) throw new Error("Set your GitHub token, username and repo in settings first.");

    // start the GitHub head lookup now; it runs in parallel with the LeetCode calls
    const headP = getHead(token, owner, repo);
    headP.catch(() => {}); // avoid an unhandled rejection if we return early

    // 1) latest accepted submission
    const list = await lcGql(Q_LIST, { s: slug });
    const sub = list.questionSubmissionList.submissions.find((x) => x.statusDisplay === "Accepted");
    if (!sub) throw new Error("No accepted submission found for this problem.");

    // 2) skip if this exact submission was already synced
    const syncedKey = `synced:${slug}`;
    const prev = (await chrome.storage.local.get(syncedKey))[syncedKey];
    if (!force && prev && prev.id === sub.id) return { ...prev, skipped: true };

    // 3) details + question metadata in one request
    const d = await lcGql(Q_DETAILS, { id: Number(sub.id), s: slug });
    const det = d.details;
    const q = d.q;
    if (!det || !q) throw new Error("Could not read submission details from LeetCode.");

    const folder = `${String(q.questionFrontendId).padStart(4, "0")}-${q.titleSlug}`;
    const ext = EXT[det.lang.name] || "txt";
    const path = `${folder}/solution.${ext}`;
    const readme =
      `# ${q.questionFrontendId}. ${q.title}\n\n` +
      `- Difficulty: ${q.difficulty}\n` +
      `- Language: ${det.lang.name}\n` +
      `- Runtime: ${det.runtimeDisplay}\n` +
      `- Memory: ${det.memoryDisplay}\n` +
      `- Link: https://leetcode.com/problems/${q.titleSlug}/\n`;

    const commit = (head) =>
      ghGql(token, COMMIT, {
        input: {
          branch: { repositoryNameWithOwner: `${owner}/${repo}`, branchName: head.branch },
          message: { headline: `Add ${q.title} (${det.lang.name})` },
          fileChanges: {
            additions: [
              { path, contents: b64(det.code) },
              { path: `${folder}/README.md`, contents: b64(readme) },
            ],
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
      path,
      url: `https://github.com/${owner}/${repo}/blob/${head.branch}/${path}`,
    };
    await chrome.storage.local.set({ [syncedKey]: result });
    return result;
  } finally {
    syncing = false;
  }
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

  // popup open: is the extension configured, and what problem is this?
  async INFO({ slug }) {
    const { owner, repo, configured } = await getConfig();
    let question = null;
    if (slug) {
      try { question = await getQuestion(slug); } catch { /* popup falls back to the slug */ }
    }
    return { configured, repo: owner && repo ? `${owner}/${repo}` : "", question };
  },

  // options page: "Load my repositories" (runs only on click, see R18)
  async LIST_REPOS({ token }) {
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const h = handlers[msg && msg.type];
  if (!h) return false;
  h(msg).then(sendResponse);
  return true; // keep the channel open for the async response
});
