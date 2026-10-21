const $ = (id) => document.getElementById(id);
const show = (id, on) => $(id).classList.toggle("hidden", !on);
let slug = null;

function setBusy(busy) {
  $("sync").classList.toggle("loading", busy);
  $("sync").disabled = busy;
  $("label").textContent = busy ? "Syncing…" : "Sync to GitHub";
}

function renderResult({ ok, text, url, canForce }) {
  const el = $("result");
  el.className = `result ${ok ? "ok" : "err"}`;
  el.replaceChildren(document.createTextNode(`${ok ? "✓" : "✕"} ${text} `));

  if (url) {
    const a = document.createElement("a");
    a.href = url;
    a.textContent = "View on GitHub";
    a.onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url }); };
    el.append(a);
  }
  if (canForce) {
    el.append(document.createTextNode(" · "));
    const b = document.createElement("button");
    b.textContent = "Sync anyway";
    b.onclick = () => run(true);
    el.append(b);
  }
  show("result", true);
}

async function run(force = false) {
  show("result", false);
  setBusy(true);
  try {
    const res = await chrome.runtime.sendMessage({ type: "SYNC", slug, force });
    if (!res) throw new Error("No response from the background worker.");
    if (res.ok) {
      renderResult({
        ok: true,
        text: res.skipped ? "Already up to date." : "Synced!",
        url: res.url,
        canForce: !!res.skipped,
      });
    } else {
      renderResult({ ok: false, text: res.error });
    }
  } catch (e) {
    renderResult({ ok: false, text: e.message });
  } finally {
    setBusy(false);
  }
}

async function init() {
  const openSettings = () => chrome.runtime.openOptionsPage();
  $("settings").onclick = openSettings;
  $("openSettings").onclick = openSettings;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  slug = tab?.url?.match(/leetcode\.com\/problems\/([^/?#]+)/)?.[1] || null;

  // paint the problem card immediately from the slug; fill details when INFO returns
  if (slug) {
    $("title").textContent = slug.replace(/-/g, " ");
    show("problem", true);
  } else {
    show("empty", true);
  }

  const info = await chrome.runtime.sendMessage({ type: "INFO", slug });

  show("setup", !info.configured);
  if (info.repo) $("repoInfo").textContent = `Syncing to ${info.repo}`;

  if (slug) {
    const q = info.question;
    if (q) {
      $("title").textContent = q.title;
      $("num").textContent = `#${q.questionFrontendId}`;
      $("diff").textContent = q.difficulty;
      $("diff").className = `badge ${q.difficulty}`;
    }
    $("sync").disabled = !info.configured;
  }
}

$("sync").onclick = () => run(false);
init();
