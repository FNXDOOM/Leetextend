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
  $("syncAll").disabled = !info.configured;
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

// ---- autosync toggle + result of the last automatic sync ----
const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

async function initAuto() {
  chrome.action.setBadgeText({ text: "" }); // popup is open, so clear the ✓ / ! badge
  const v = await chrome.storage.local.get(["autoSync", "lastAuto"]);
  $("auto").checked = v.autoSync !== false; // default ON
  $("auto").onchange = () => chrome.storage.local.set({ autoSync: $("auto").checked });

  const a = v.lastAuto;
  if (a) {
    const el = $("lastAuto");
    el.textContent = a.ok
      ? `Auto-synced ${a.title || a.path} · ${ago(a.at)}`
      : `Auto-sync failed: ${a.error} · ${ago(a.at)}`;
    el.className = `last ${a.ok ? "ok" : "err"}`;
  }
}

$("sync").onclick = () => run(false);

// ---- one-time catch-up: sync every problem you have already solved ----
$("syncAll").onclick = async () => {
  const btn = $("syncAll");
  show("result", false);
  btn.disabled = true;
  $("sync").disabled = true;
  btn.textContent = "Starting…";
  const onChange = (c, area) => {
    const b = area === "session" && c.bulk && c.bulk.newValue;
    if (b) btn.textContent = b.total ? `${b.phase} ${b.done}/${b.total}` : b.phase;
  };
  chrome.storage.onChanged.addListener(onChange);
  try {
    const res = await chrome.runtime.sendMessage({ type: "SYNC_ALL" });
    if (!res || !res.ok) return renderResult({ ok: false, text: (res && res.error) || "No response from the background worker." });
    const extra = [
      res.skipped ? `${res.skipped} skipped (no accepted submission in your last 20 attempts)` : "",
      res.failed ? `${res.failed} failed to read` : "",
    ].filter(Boolean).join(", ");
    renderResult({
      ok: true,
      text: res.added ? `Synced ${res.added} problems${extra ? ", " + extra : ""}.` : `Nothing new to sync${extra ? " (" + extra + ")" : ""}.`,
    });
  } catch (e) {
    renderResult({ ok: false, text: e.message });
  } finally {
    chrome.storage.onChanged.removeListener(onChange);
    btn.textContent = "Sync all solved problems";
    btn.disabled = false;
    $("sync").disabled = !slug;
  }
};
init();
initAuto();
