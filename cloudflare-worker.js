// ═══════════════════════════════════════════════════════
//  Dark Yeti Scorecard — Cloudflare Worker Proxy
//  Deploys to: workers.cloudflare.com (free tier)
//
//  SETUP:
//  1. Go to workers.cloudflare.com → Create Worker
//  2. Paste this entire file
//  3. Go to Settings → Variables → Add these secrets:
//       GITHUB_TOKEN  = your classic token (ghp_...)
//       ALLOWED_ORIGIN = https://krausshauss.github.io
//  4. Deploy → copy your Worker URL (e.g. quanthub-proxy.yourname.workers.dev)
//  5. Paste that URL into index.html as WORKER_URL
// ═══════════════════════════════════════════════════════

const GITHUB_OWNER  = 'krausshauss';
const GITHUB_REPO   = 'quahthub-dashboard';
const GITHUB_BRANCH = 'main';
const DATA_FILE     = 'data.json';

export default {
  async fetch(request, env) {

    // ── CORS headers ──────────────────────────────────────
    const origin = request.headers.get('Origin') || '';
    const allowedOrigin = env.ALLOWED_ORIGIN || 'https://krausshauss.github.io';
    const corsHeaders = {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Pin',
      'Access-Control-Max-Age': '86400',
    };

    // Handle preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url     = new URL(request.url);
    const method  = request.method;
    const token   = env.GITHUB_TOKEN;
    const apiBase = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${DATA_FILE}`;
    const ghHeaders = {
      'Authorization': `token ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Dark Yeti-Scorecard-Proxy/1.0',
    };

    try {

      // ── GET /data — fetch data.json ──────────────────────
      if (method === 'GET') {
        const res = await fetch(`${apiBase}?ref=${GITHUB_BRANCH}`, { headers: ghHeaders });
        if (res.status === 404) {
          return new Response(JSON.stringify({ exists: false }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }
        if (!res.ok) {
          return new Response(JSON.stringify({ error: 'GitHub API error', status: res.status }), {
            status: res.status,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }
        const file = await res.json();
        // Decode base64 content
        const decoded = atob(file.content.replace(/\n/g, ''));
        return new Response(decoded, {
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-File-SHA': file.sha,
          }
        });
      }

      // ── PUT /data — save data.json ───────────────────────
      if (method === 'PUT') {
        // Verify admin PIN header
        const pin = request.headers.get('X-Admin-Pin');
        const correctPin = env.ADMIN_PIN || '7777';
        if (!pin || pin !== correctPin) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        const body = await request.json();
        const content = btoa(unescape(encodeURIComponent(JSON.stringify(body, null, 2))));

        // Get current SHA
        let sha = null;
        const getRes = await fetch(`${apiBase}?ref=${GITHUB_BRANCH}`, { headers: ghHeaders });
        if (getRes.ok) {
          const existing = await getRes.json();
          sha = existing.sha;
        }

        const putBody = {
          message: `Scorecard update: ${new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}`,
          content,
          branch: GITHUB_BRANCH,
          ...(sha ? { sha } : {}),
        };

        const putRes = await fetch(apiBase, {
          method: 'PUT',
          headers: { ...ghHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify(putBody),
        });

        if (!putRes.ok) {
          const err = await putRes.json();
          return new Response(JSON.stringify({ error: err.message || 'Commit failed' }), {
            status: putRes.status,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        return new Response(JSON.stringify({ ok: true, committed: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      return new Response('Method not allowed', { status: 405, headers: corsHeaders });

    } catch(e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }
};
