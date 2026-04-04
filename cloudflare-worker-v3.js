// ═══════════════════════════════════════════════════════════════════════════
//  QuantHub Sales Scorecard — Cloudflare Worker v3
//  Handles: HubSpot API → live deal/activity data + GitHub data.json r/w
//
//  Secrets required in Cloudflare Worker settings:
//    HUBSPOT_TOKEN  — HubSpot Private App token (pat-na1-...)
//    GITHUB_TOKEN   — GitHub classic token (ghp_...)
//    ADMIN_PIN      — 4-digit admin PIN (e.g. 7777)
//    ALLOWED_ORIGIN — e.g. https://krausshauss.github.io
// ═══════════════════════════════════════════════════════════════════════════

const GITHUB_OWNER  = 'krausshauss';
const GITHUB_REPO   = 'quahthub-dashboard';
const GITHUB_BRANCH = 'main';
const DATA_FILE     = 'data.json';

// ── REP ROSTER ─────────────────────────────────────────────────────────────
const REPS = {
  '80811940': { name: 'Nate Spargo',    role: 'Director of CS',               initials: 'NS' },
  '87448455': { name: 'Michael Krause', role: 'Strategic Advisor',            initials: 'MK' },
  '81657454': { name: 'Joe DeRario',    role: 'Sr. Sales Account Executive',  initials: 'JD' },
  '86826804': { name: 'Jason Rupert',   role: 'Sales Account Executive',      initials: 'JR' },
  '84255670': { name: 'Matthew Fickling',role:'Sales Account Executive',      initials: 'MF' },
};
const SCORED_REPS = Object.keys(REPS); // all reps scored
const QUOTA        = 100000;  // per-rep quarterly quota
const TEAM_TARGET  = 1000000; // annual team revenue target
const STALE_DAYS   = 7;

// ── CORS ────────────────────────────────────────────────────────────────────
function corsHeaders(env, request) {
  const origin  = request.headers.get('Origin') || '';
  const allowed = env.ALLOWED_ORIGIN || 'https://krausshauss.github.io';
  const isOk    = !origin || origin.startsWith(allowed) ||
                  origin.includes('hubspot') || origin.includes('localhost');
  return {
    'Access-Control-Allow-Origin':  isOk ? (origin || '*') : allowed,
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Pin',
    'Access-Control-Max-Age':       '86400',
    'Vary': 'Origin',
  };
}

// ── HUBSPOT FETCH HELPER ────────────────────────────────────────────────────
async function hs(env, path, opts = {}) {
  const res = await fetch(`https://api.hubapi.com${path}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${env.HUBSPOT_TOKEN}`,
      'Content-Type':  'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`HubSpot ${path} → ${res.status}`);
  return res.json();
}

// Paginate through all HubSpot CRM objects
async function hsAll(env, objectType, properties, filterGroups = []) {
  const results = [];
  let after    = undefined;
  const limit  = 100;
  while (true) {
    const body = {
      filterGroups,
      properties,
      limit,
      sorts: [],
      ...(after ? { after } : {}),
    };
    const data = await hs(env, `/crm/v3/objects/${objectType}/search`, {
      method: 'POST',
      body:   JSON.stringify(body),
    });
    results.push(...(data.results || []));
    if (data.paging?.next?.after) {
      after = data.paging.next.after;
    } else {
      break;
    }
  }
  return results;
}

// ── BUILD SCORECARD DATA ────────────────────────────────────────────────────
async function buildScorecardData(env) {
  const today   = new Date();
  const y2026   = new Date('2026-01-01T00:00:00Z');
  const weekAgo = new Date(today); weekAgo.setDate(weekAgo.getDate() - STALE_DAYS);
  const yearAgo = new Date(today); yearAgo.setFullYear(today.getFullYear() - 1);

  // ── 1. FETCH ALL DEALS owned by scored reps ──────────────────────────────
  const dealProps = [
    'dealname', 'amount', 'dealstage', 'pipeline', 'hubspot_owner_id',
    'closedate', 'createdate', 'hs_lastmodifieddate', 'notes_last_updated',
    'hs_is_closed_won', 'hs_is_closed', 'hs_deal_stage_probability',
    'num_notes', 'num_associated_contacts', 'hs_next_step',
    'notes_last_contacted', 'engagements_last_meeting_booked',
  ];

  // Fetch all deals owned by any scored rep (no pipeline filter — avoids wrong ID)
  const allDeals = await hsAll(env, 'deals', dealProps, [
    { filters: [
      { propertyName: 'hubspot_owner_id', operator: 'IN',
        values: Object.keys(REPS) }
    ]}
  ]);

  // ── 2. FETCH ENGAGEMENTS (calls + meetings) for last 7 days ──────────────
  // Use associations to get activities per owner
  const activityMap = {}; // ownerId → { calls, meetings, emails }
  SCORED_REPS.forEach(id => { activityMap[id] = { calls: 0, meetings: 0, emails: 0 }; });

  // Fetch calls
  try {
    const calls = await hsAll(env, 'calls', [
      'hs_call_direction', 'hubspot_owner_id', 'hs_timestamp', 'hs_call_status'
    ], [{
      filters: [
        { propertyName: 'hs_timestamp', operator: 'GTE', value: weekAgo.toISOString() },
        { propertyName: 'hs_call_status', operator: 'EQ', value: 'COMPLETED' },
      ]
    }]);
    calls.forEach(c => {
      const oid = c.properties?.hubspot_owner_id;
      if (oid && activityMap[oid]) activityMap[oid].calls++;
    });
  } catch(e) { console.warn('Calls fetch failed:', e.message); }

  // Fetch meetings
  try {
    const meetings = await hsAll(env, 'meetings', [
      'hubspot_owner_id', 'hs_timestamp', 'hs_meeting_outcome'
    ], [{
      filters: [
        { propertyName: 'hs_timestamp', operator: 'GTE', value: weekAgo.toISOString() },
      ]
    }]);
    meetings.forEach(m => {
      const oid = m.properties?.hubspot_owner_id;
      if (oid && activityMap[oid]) activityMap[oid].meetings++;
    });
  } catch(e) { console.warn('Meetings fetch failed:', e.message); }

  // Fetch emails
  try {
    const emails = await hsAll(env, 'emails', [
      'hubspot_owner_id', 'hs_timestamp'
    ], [{
      filters: [
        { propertyName: 'hs_timestamp', operator: 'GTE', value: weekAgo.toISOString() },
      ]
    }]);
    emails.forEach(e => {
      const oid = e.properties?.hubspot_owner_id;
      if (oid && activityMap[oid]) activityMap[oid].emails++;
    });
  } catch(e) { console.warn('Emails fetch failed:', e.message); }

  // ── 3. GROUP DEALS BY REP ─────────────────────────────────────────────────
  const grouped = {};
  SCORED_REPS.forEach(id => { grouped[id] = []; });

  allDeals.forEach(deal => {
    const oid = deal.properties?.hubspot_owner_id;
    if (oid && grouped[oid]) grouped[oid].push(deal.properties);
  });

  // ── 4. BUILD REP OBJECTS ──────────────────────────────────────────────────
  const reps = SCORED_REPS.map(ownerId => {
    const info  = REPS[ownerId];
    const deals = grouped[ownerId] || [];
    const act   = activityMap[ownerId] || { calls: 0, meetings: 0, emails: 0 };

    // Classify deals
    const active = deals.filter(d => {
      const stage   = (d.dealstage || '').toLowerCase();
      const isWon   = d.hs_is_closed_won === 'true' || d.hs_is_closed_won === true;
      const isClosed= d.hs_is_closed     === 'true' || d.hs_is_closed     === true;
      return !isWon && !isClosed &&
             !stage.includes('closed lost') && !stage.includes('closedlost');
    });

    const cwDeals2026 = deals.filter(d => {
      // HubSpot returns string 'true'/'false' for boolean fields
      const isWon = d.hs_is_closed_won === 'true' || d.hs_is_closed_won === true;
      if (!isWon) return false;
      const cd = d.closedate ? new Date(d.closedate) : null;
      return cd && cd >= y2026;
    });

    const cwAmount   = cwDeals2026.reduce((s, d) => s + (parseFloat(d.amount) || 0), 0);
    const pipeValue  = active.reduce((s, d) => s + (parseFloat(d.amount) || 0), 0);

    // Stale: last activity > 7 days ago
    const stale = active.filter(d => {
      const lastAct = d.notes_last_updated || d.hs_lastmodifieddate;
      if (!lastAct) return true;
      return new Date(lastAct) < weekAgo;
    }).length;

    // Advanced this week
    const advancedWk = active.filter(d => {
      const lm = d.hs_lastmodifieddate;
      return lm && new Date(lm) >= weekAgo;
    }).length;

    // Data quality
    const total      = active.length;
    const hasNS      = active.filter(d => d.hs_next_step && d.hs_next_step.trim()).length;
    const hasAmt     = active.filter(d => parseFloat(d.amount) > 0).length;
    const hasCD      = active.filter(d => d.closedate).length;

    // Stage flow — proper stages
    const VALID_STAGES = [
      'negotiation', 'commit', 'trial', 'salesopportunity', 'opportunity',
      'discovery', 'demo', 'sql', 'closedwon', 'closedlost'
    ];
    const stageFlow = active.filter(d => {
      const s = (d.dealstage || '').toLowerCase().replace(/[^a-z]/g, '');
      return VALID_STAGES.some(v => s.includes(v));
    }).length;

    // Avg days to close
    const ages = active
      .filter(d => d.createdate)
      .map(d => (today - new Date(d.createdate)) / 86400000);
    const avgAge = ages.length
      ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length)
      : 45;

    // Expansion deals (CW in last 90 days, re-purchased accounts)
    const expansionDeals = cwDeals2026
      .filter(d => {
        const cd = d.closedate ? new Date(d.closedate) : null;
        return cd && (today - cd) / 86400000 < 90;
      })
      .map(d => ({
        name:   d.dealname || '',
        amount: parseFloat(d.amount) || 0,
        stage:  'Closed Won',
        cw:     true,
      }));

    // Build deal list for pipeline view
    const dealList = active.map(d => {
      let stage = d.dealstage || 'Unknown';
      // Normalize stage names
      const sl = stage.toLowerCase();
      if (sl.includes('negotiat'))      stage = 'Negotiation';
      else if (sl.includes('commit') || sl.includes('verbal')) stage = 'Commit/Verbal';
      else if (sl.includes('trial'))    stage = 'Trial (optional)';
      else if (sl.includes('opportun')) stage = 'Sales Opportunity';
      else if (sl.includes('discov') || sl.includes('demo') || sl.includes('sql')) stage = 'Discovery/Demo (SQL)';

      const lastAct = d.notes_last_updated || d.hs_lastmodifieddate;
      const staleDays = lastAct
        ? Math.round((today - new Date(lastAct)) / 86400000)
        : 999;

      return {
        name:   d.dealname || '',
        stage,
        amount: parseFloat(d.amount) || null,
        stale:  staleDays,
        next:   d.hs_next_step || '',
      };
    });

    const isMK = ownerId === '87448455';

    return {
      id:       info.initials.toLowerCase(),
      name:     info.name,
      initials: info.initials,
      role:     info.role,
      // CW
      cw_amount:  cwAmount,
      cw_deals:   cwDeals2026.length,
      // Pipeline
      active_deals:        total,
      pipeline_value:      pipeValue,
      stale_7d:            stale,
      deals_advanced_week: advancedWk,
      avg_days_to_close:   avgAge,
      // Activity (from API)
      ip_meetings_week:    Math.round(act.meetings * 0.5),
      vr_calls_week:       act.meetings - Math.round(act.meetings * 0.5),
      phone_calls_week:    act.calls,
      text_touches_week:   0,
      raw_calls:           act.calls,
      raw_meetings:        act.meetings,
      raw_emails:          act.emails,
      meetings_target:     isMK ? 4  : 6,
      calls_target:        isMK ? 8  : 15,
      text_target:         isMK ? 3  : 5,
      // Quality
      next_step_pct:    total ? Math.round(hasNS  / total * 100) : 0,
      amount_populated: total ? Math.round(hasAmt  / total * 100) : 0,
      close_date_set:   total ? Math.round(hasCD   / total * 100) : 0,
      stage_flow_pct:   total ? Math.round(stageFlow / total * 100) : 0,
      bant_pct:         50,
      daily_verified:   80,
      // Expansion + deals
      expansion_deals: expansionDeals,
      deals:           dealList,
    };
  });

  return {
    reps,
    exportDate: today.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
    savedAt:    today.toISOString(),
    version:    10,
    source:     'hubspot-api',
  };
}

// ── GITHUB DATA STORE ───────────────────────────────────────────────────────
async function readDataJson(env) {
  const apiUrl  = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${DATA_FILE}`;
  const headers = {
    'Authorization': `token ${env.GITHUB_TOKEN}`,
    'Accept':        'application/vnd.github.v3+json',
    'User-Agent':    'QuantHub-Worker/3.0',
  };
  const res = await fetch(`${apiUrl}?ref=${GITHUB_BRANCH}`, { headers });
  if (res.status === 404) return { content: null, sha: null };
  if (!res.ok) throw new Error(`GitHub read error: ${res.status}`);
  const file    = await res.json();
  const decoded = atob(file.content.replace(/\n/g, ''));
  return { content: JSON.parse(decoded), sha: file.sha };
}

async function writeDataJson(env, data, sha) {
  const apiUrl  = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${DATA_FILE}`;
  const headers = {
    'Authorization': `token ${env.GITHUB_TOKEN}`,
    'Accept':        'application/vnd.github.v3+json',
    'User-Agent':    'QuantHub-Worker/3.0',
    'Content-Type':  'application/json',
  };
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
  const body    = {
    message: `Scorecard update: ${data.exportDate || new Date().toDateString()}`,
    content,
    branch: GITHUB_BRANCH,
    ...(sha ? { sha } : {}),
  };
  const res = await fetch(apiUrl, { method: 'PUT', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || `GitHub write error: ${res.status}`);
  }
  return true;
}

// ── MAIN HANDLER ────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const cors   = corsHeaders(env, request);
    const method = request.method;

    // Preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url      = new URL(request.url);
    const pathname = url.pathname;

    try {

      // ── GET /  →  Serve live HubSpot data (with GitHub cache fallback) ────
      if (method === 'GET' && (pathname === '/' || pathname === '')) {
        const forceRefresh = url.searchParams.get('refresh') === '1';

        // Try GitHub cache first (unless force refresh requested)
        if (!forceRefresh) {
          try {
            const { content } = await readDataJson(env);
            if (content && content.reps && content.reps.length) {
              // Check if cache is fresh (< 4 hours old)
              const age = content.savedAt
                ? (Date.now() - new Date(content.savedAt).getTime()) / 3600000
                : 999;
              if (age < 4) {
                return new Response(JSON.stringify(content), {
                  headers: { ...cors, 'Content-Type': 'application/json',
                             'Cache-Control': 'no-store', 'X-Source': 'cache' }
                });
              }
            }
          } catch(e) { /* cache miss — fall through to live */ }
        }

        // Fetch live from HubSpot
        const data = await buildScorecardData(env);

        // Write back to GitHub cache (async, don't block response)
        try {
          const { sha } = await readDataJson(env);
          await writeDataJson(env, data, sha);
        } catch(e) { console.warn('Cache write failed:', e.message); }

        return new Response(JSON.stringify(data), {
          headers: { ...cors, 'Content-Type': 'application/json',
                     'Cache-Control': 'no-store', 'X-Source': 'live' }
        });
      }

      // ── PUT /  →  Save manual overrides (activity overrides from standup) ─
      if (method === 'PUT') {
        const pin     = request.headers.get('X-Admin-Pin');
        const correct = env.ADMIN_PIN || '7777';
        if (!pin || pin !== correct) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401, headers: { ...cors, 'Content-Type': 'application/json' }
          });
        }
        const body      = await request.json();
        const { sha }   = await readDataJson(env);
        await writeDataJson(env, body, sha);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...cors, 'Content-Type': 'application/json' }
        });
      }

      // ── GET /refresh  →  Force fresh HubSpot pull + cache update ──────────
      if (method === 'GET' && pathname === '/refresh') {
        const pin = request.headers.get('X-Admin-Pin') || url.searchParams.get('pin');
        if (pin !== (env.ADMIN_PIN || '7777')) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401, headers: { ...cors, 'Content-Type': 'application/json' }
          });
        }
        const data    = await buildScorecardData(env);
        const { sha } = await readDataJson(env);
        await writeDataJson(env, data, sha);
        return new Response(JSON.stringify({ ok: true, deals: data.reps.reduce((s,r) => s+r.active_deals,0), exportDate: data.exportDate }), {
          headers: { ...cors, 'Content-Type': 'application/json' }
        });
      }

      // ── POST /validate-pin  →  Validate PIN without doing anything else ──
      if (method === 'POST' && pathname.includes('validate-pin')) {
        const pin     = request.headers.get('X-Admin-Pin');
        const correct = env.ADMIN_PIN || '7777';
        if (pin && pin === correct) {
          return new Response(JSON.stringify({ ok: true }), {
            headers: { ...cors, 'Content-Type': 'application/json' }
          });
        }
        return new Response(JSON.stringify({ error: 'Invalid PIN' }), {
          status: 401, headers: { ...cors, 'Content-Type': 'application/json' }
        });
      }

      return new Response('Not found', { status: 404, headers: cors });

    } catch(e) {
      console.error('Worker error:', e.message);
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }
  }
};
