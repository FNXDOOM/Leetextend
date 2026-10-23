# LeetCode → GitHub Sync

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Chrome Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4)

A Chrome extension that commits your **accepted LeetCode solutions** to a GitHub repository, one
commit per solution, the moment LeetCode shows "Accepted". Sign in with GitHub, choose which
repositories the extension may touch, and it works. No tokens to copy.

## Features

- **Automatic sync.** Submit on LeetCode; when the verdict is Accepted, the solution is committed with no click.
- **One-click sync** for the problem you are viewing, plus **Sync all solved problems** to catch up on your history.
- **Sign in with GitHub.** Authorize in a popup and pick repositories. Access is limited to the repos you choose, and **Disconnect** revokes it.
- **Light footprint.** No content scripts: nothing is injected into LeetCode pages. The extension is idle unless a submission is being judged or the popup is open.
- **Safe to repeat.** A submission already in your repo is skipped, never duplicated.
- **Light and dark themes**, following your system.

## What gets committed

Each sync adds one commit containing two files in a folder named after the problem:

```
your-repo/
  0001-two-sum/
    solution.py      <- your exact accepted code
    README.md        <- title, difficulty, language, runtime, memory, problem link
  0002-add-two-numbers/
    ...
```

## Getting started

1. **Install** the extension (see [Installation](#installation)). The settings page opens automatically.
2. Click **Connect GitHub**, then **Authorize** in the GitHub popup.
3. In the next popup, choose **Only select repositories**, pick the repo your solutions will live in, and click **Install**. The repo needs at least one commit (a README is enough).
4. The extension selects the repo (or lets you pick one if you granted several) and tests the connection. **"Connected to owner/repo"** means you are ready.
5. Solve a problem on LeetCode and click **Submit**.

If you already installed the app on a repo, step 3 is skipped.

## Usage

| Action | How |
| --- | --- |
| Auto-sync | On by default. A green ✓ appears on the toolbar icon when it worked, a red ! if it failed. Open the popup for details. |
| Turn auto-sync off | Switch off **Auto-sync accepted submissions** in the popup. |
| Sync the current problem | Open the problem, click the toolbar icon, then **Sync to GitHub**. |
| Sync everything you have solved | Click **Sync all solved problems** in the popup. It commits in batches of 40 problems. |
| Re-sync an unchanged submission | Click **Sync to GitHub**, then **Sync anyway**. |
| Change which repos are allowed | Settings → **Choose repositories on GitHub**. |
| Sign out | Settings → **Disconnect**. This revokes the app's access on GitHub and clears the extension's saved data. |

Only **Submit** counts. Run Code, wrong answers, time-limit errors and compile errors are never synced.

## Installation

**From source (current method)**

```
git clone https://github.com/FNXDOOM/Leetextend.git
```

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select the folder that contains `manifest.json`.

Signing in requires a GitHub App and a small token worker. If you are using a build someone else
published, they have already done this. If you are running your own copy, follow
[Setup for maintainers](#setup-for-maintainers) once.

## Setup for maintainers

This is a one-time job for whoever owns the extension. End users never do any of it.

**Why a worker?** GitHub's sign-in needs a client secret, and a secret cannot safely live inside
an extension. A tiny Cloudflare Worker (`auth-worker/`) holds it and does three things: exchange a
sign-in code for a token, refresh tokens, and revoke access.

### 1. Find your callback URL

Load the extension unpacked, open its settings page, open DevTools (right-click → Inspect →
Console), and copy the line `GitHub App callback URL: https://<id>.chromiumapp.org/`.

### 2. Create the GitHub App

Go to <https://github.com/settings/apps/new> and set:

| Setting | Value |
| --- | --- |
| GitHub App name / Homepage URL | Anything (the homepage can be this repository) |
| Callback URL | The URL from step 1, exactly as shown, including the trailing slash |
| Request user authorization (OAuth) during installation | Ticked |
| Expire user authorization tokens | Ticked |
| Enable Device Flow | Unticked |
| Webhook → Active | Unticked |
| Repository permissions → Contents | Read and write |
| Where can this GitHub App be installed? | Any account (so other people can use it) |

Create the app, then note its **Client ID** and **slug** (the `<slug>` in
`github.com/apps/<slug>`), and click **Generate a new client secret**.

### 3. Deploy the worker

You need Node.js and a free Cloudflare account.

```
cd auth-worker
npx wrangler login
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler deploy
```

Wrangler prints the worker's URL, for example `https://leetcode-github-auth.<you>.workers.dev`.
Keep the secret in `wrangler secret`, never in `wrangler.toml` or any committed file.

| Route | Purpose |
| --- | --- |
| `POST /token` | Exchanges a sign-in code for tokens. Requires a PKCE verifier. |
| `POST /refresh` | Swaps a refresh token for a new access token. |
| `POST /revoke` | Removes the app's access to the user's account (Disconnect). |

### 4. Configure the extension

Edit `config.js`:

```js
const CLIENT_ID = "Iv1.xxxxxxxxxxxxxxxx";
const APP_SLUG = "your-app-slug";
const WORKER_URL = "https://leetcode-github-auth.<you>.workers.dev"; // no trailing slash
```

The Client ID is public by design. Reload the extension at `chrome://extensions`.

## Using a personal access token instead

If you do not want to set up a GitHub App, paste a token under **Use a personal access token
instead** in settings:

1. Go to <https://github.com/settings/personal-access-tokens/new>.
2. **Repository access:** *Only select repositories*, then pick your solutions repo.
3. **Permissions:** *Contents* → **Read and write**. Nothing else is needed.
4. Generate the token (`github_pat_…`), paste it into settings, choose the repo, and click **Save**.

Pasted tokens do not refresh, so you will need to replace them when they expire.

## How it works

- **Detecting Accepted.** While LeetCode judges a submission, its page polls
  `/submissions/detail/<id>/check/`. The extension watches those requests read-only with the
  `webRequest` permission, asks LeetCode's GraphQL endpoint for the verdict, and syncs only when it
  is Accepted. It never reads or modifies the page.
- **Committing.** Both files are written in a single commit through GitHub's GraphQL
  `createCommitOnBranch` mutation on the repo's default branch. All writes run through one queue,
  so a double click or two quick submissions cannot collide.
- **Signing in.** The popup uses `chrome.identity.launchWebAuthFlow` with PKCE and a random
  `state`. The returned code goes to the worker, which exchanges it using the client secret.
  Expiring tokens are refreshed automatically shortly before they run out.

## Permissions and privacy

| Permission | Why it is needed |
| --- | --- |
| `storage` | Saves your settings, token and the list of synced problems. |
| `activeTab` | Reads the current tab's URL when you open the popup, to know which problem you are on. |
| `webRequest` | Observes LeetCode's judging requests to detect an Accepted verdict. Observe-only. |
| `identity` | Opens the GitHub sign-in popup. |
| `leetcode.com` | Reads your submissions through LeetCode's GraphQL API using your logged-in session. |
| `api.github.com` | Creates commits and lists the repositories you granted. |

- Your token is stored only in this browser's `chrome.storage.local` and is never logged.
- It is sent to `api.github.com`. During sign-in, token refresh and Disconnect, the sign-in code
  or refresh token passes through the maintainer's worker, which forwards it to GitHub and stores
  nothing.
- Your solutions go only to the GitHub repo you chose. There is no analytics and no other server.
- Choose a **private** repository if you do not want your solutions public.

## Limitations

- Chrome (Manifest V3). Auto-sync works only while the browser is running with the extension enabled.
- LeetCode has no official API. The extension relies on undocumented GraphQL queries and an
  internal polling URL, so a LeetCode change can break it. The queries are at the top of
  `background.js`, and `CHECK_URL` and `CHECK_RE` define the polling URL.
- Submissions made on another device or in the LeetCode app are not seen by auto-sync. Open that problem and click **Sync to GitHub**.
- **Sync all solved problems** only finds problems whose accepted submission is among your last 20 attempts on that problem.
- Commits go to the repo's default branch, so a branch-protection rule that blocks direct pushes will reject them.
- Solving the same problem in another language adds a second solution file to that problem's folder.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| "Set CLIENT_ID, APP_SLUG and WORKER_URL in config.js first" | The maintainer setup is not finished. See [Setup for maintainers](#setup-for-maintainers). |
| GitHub says the redirect URI is not associated with the app | The app's Callback URL must match the console URL exactly. Add one per extension ID (your local one and the Chrome Web Store one). |
| "No repositories were granted" | The install popup was closed early. Click **Choose repositories on GitHub**, select a repo, and finish the install. |
| "Repo not found, or empty" | Make an initial commit in the repo, for example a README. |
| "GitHub session expired" | Click **Connect GitHub** again. |
| "GitHub rate limit hit" | Wait a minute and retry. |
| "LeetCode request failed" | Log in to leetcode.com in the same browser. |
| Auto-sync does nothing | Check the popup switch is on and a repo is connected. Then open `chrome://extensions`, click **Inspect** on the service worker, and look for `[autosync]` lines. If a submission produces no `check request` line, LeetCode changed its endpoint. |

## Development

There is no build step and the extension has no dependencies. Edit the files and click reload at
`chrome://extensions`.

```
manifest.json    extension manifest (MV3)
background.js    service worker: LeetCode and GitHub calls, autosync, token refresh
popup.html/.css/.js     toolbar popup
options.html/.js        settings page and GitHub sign-in
config.js        Client ID, app slug and worker URL (shared by the two scripts above)
auth-worker/     Cloudflare Worker that holds the client secret
```

An unpacked extension's ID comes from its folder path. Keep the folder in place, or pin the ID
with a [`key`](https://developer.chrome.com/docs/extensions/reference/manifest/key) in `manifest.json`,
so the callback URL registered in the GitHub App stays valid.

### Publishing checklist

- Zip only the extension files (`manifest.json`, the `.js`, `.html` and `.css` files). Leave out `auth-worker/` and `.git`.
- Add the callback URL for the Chrome Web Store extension ID (`https://<store-id>.chromiumapp.org/`) to the GitHub App.
- Make sure the GitHub App can be installed on any account.
- The Web Store asks for a privacy policy. The [Permissions and privacy](#permissions-and-privacy) section is a starting point.

## License

Released under the [MIT License](LICENSE).
