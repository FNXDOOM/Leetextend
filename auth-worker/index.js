// Cloudflare Worker for the extension's GitHub sign-in. It exists only to hold the app's client
// secret, which must never ship inside the extension.
//   POST /token    { code, redirect_uri, code_verifier }  -> { access_token, refresh_token, expires_in }  (PKCE required)
//   POST /refresh  { refresh_token }                      -> { access_token, refresh_token, expires_in }
//   POST /revoke   { access_token }                       -> { ok }   (removes the app's access to the user's account)
// Secrets (wrangler secret put ...): GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function exchange(env, params) {
  const r = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, ...params }),
  });
  const t = await r.json();
  if (!t.access_token) return json({ error: t.error_description || t.error || "Exchange failed.", code: t.error }, 400);
  return json({ access_token: t.access_token, refresh_token: t.refresh_token, expires_in: t.expires_in });
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (req.method !== "POST") return json({ error: "POST only" }, 405);
    const body = await req.json().catch(() => ({}));
    const path = new URL(req.url).pathname;

    if (path === "/token") {
      const { code, redirect_uri, code_verifier } = body;
      if (!code || !code_verifier) return json({ error: "Missing code or code_verifier." }, 400);
      // only Chrome extension callbacks (https://<id>.chromiumapp.org/)
      if (!/^https:\/\/[a-p]{32}\.chromiumapp\.org\//.test(redirect_uri || "")) return json({ error: "Bad redirect_uri." }, 400);
      return exchange(env, { code, redirect_uri, code_verifier });
    }

    if (path === "/refresh") {
      if (!body.refresh_token) return json({ error: "Missing refresh_token." }, 400);
      return exchange(env, { grant_type: "refresh_token", refresh_token: body.refresh_token });
    }

    if (path === "/revoke") {
      if (!body.access_token) return json({ error: "Missing access_token." }, 400);
      const r = await fetch(`https://api.github.com/applications/${env.GITHUB_CLIENT_ID}/grant`, {
        method: "DELETE",
        headers: {
          Authorization: "Basic " + btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`),
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "leetcode-github-auth",
        },
        body: JSON.stringify({ access_token: body.access_token }),
      });
      return json({ ok: r.status === 204 }, r.status === 204 ? 200 : 400);
    }

    return json({ error: "Not found." }, 404);
  },
};
