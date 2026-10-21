# LeetCode → GitHub Sync

A Chrome (Manifest V3) extension that copies your **accepted LeetCode solutions** into your GitHub
repository — one commit per solution. It syncs **automatically** the moment LeetCode shows
"Accepted", and the popup keeps a **Sync to GitHub** button for syncing the current problem on
demand. There are no content scripts: the extension is idle, adding nothing to your tabs, unless a
submission is being judged or the popup is open.

Each sync commits two files into `<NNNN-slug>/` of your repo:

```
your-repo/
  0001-two-sum/
    solution.py      ← your exact accepted code
    README.md        ← title, difficulty, language, runtime, memory, problem link
  0002-add-two-numbers/
    ...
```

## 1. Create a GitHub token

Use a **fine-grained personal access token** limited to the one repo you sync to:

1. Go to https://github.com/settings/personal-access-tokens/new
2. **Repository access:** *Only select repositories* → pick your solutions repo.
3. **Permissions:** *Contents* → **Read and write**. Nothing else is needed.
4. Generate the token (`github_pat_…`) and copy it.

If GitHub's GraphQL endpoint ever rejects the fine-grained token, create a classic token at
https://github.com/settings/tokens/new with the `repo` scope as a fallback.

## 2. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select this folder (the one containing `manifest.json`)

## 3. Configure

1. Open the extension's settings: the ⚙ button in the popup, or *Details → Extension options* on
   `chrome://extensions`.
2. Paste your token.
3. Click **Load my repositories** to pick a repo from a searchable list (newest push first,
   archived repos excluded), or just type `owner/repo` yourself. The repo must already have at
   least one commit.
4. Click **Save**, then **Test connection** — it should report the repo's default branch.
5. Open a LeetCode problem you have solved and click **Sync to GitHub**.

Repeat syncs of the same accepted submission are skipped ("Already up to date", with an optional
"Sync anyway" that commits regardless).

## Autosync

Autosync is **on by default**. Submit a solution on LeetCode and, when the verdict is Accepted, it is
committed to your repo with no click. A green ✓ appears on the extension icon when it worked and a
red ! if it failed; open the popup to see the details under the Sync button. Turn it off with the
**Auto-sync accepted submissions** switch in the popup (the Sync button keeps working either way).

- Only **Submit** counts. Run Code, wrong answers, time-limit errors and compile errors never sync.
- It never duplicates the manual button: a submission that is already in your repo is skipped.
- How it works: the extension watches (read-only) the `.../submissions/detail/<id>/check/` requests
  that LeetCode's page makes while judging, using the `webRequest` permission. It does not read the
  page or inject anything. If LeetCode changes that endpoint, update `CHECK_URL` / `CHECK_RE` in
  `background.js`.
- It only works while the browser is running with the extension enabled. Submissions made elsewhere
  (another device, the LeetCode app) are not seen; open that problem and click **Sync to GitHub** to
  catch up.

## Notes

- LeetCode has no official API; its undocumented GraphQL queries are kept together at the top of
  `background.js` so that a field-name change is a one-line fix.
- If "Load my repositories" returns nothing with a fine-grained token, type `owner/repo` by hand —
  that path always works.
- Your token is stored only in the browser's `chrome.storage.local` and is sent to
  `api.github.com` and nowhere else. It is never logged.
- Empty repos are listed but labeled — `createCommitOnBranch` needs an existing branch, so make
  an initial commit (e.g. a README) in an empty repo first.
