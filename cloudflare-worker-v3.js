// ═══════════════════════════════════════════════════════════════════
//  QuantHub Sales Scorecard — Cloudflare Worker
//  Version:  v20b
//  Updated:  2026-04-06
//  Secrets:  HUBSPOT_TOKEN, GITHUB_TOKEN, ADMIN_PIN, ALLOWED_ORIGIN
//  Repo:     github.com/krausshauss/quahthub-dashboard
//  Worker:   quanthub-proxy-dev.michael-20e.workers.dev
// ═══════════════════════════════════════════════════════════════════

const WORKER_VERSION = 'w3.1';  // ← bump this on every deploy
const DATA_FILE      = 'data.json';
const QUOTA         = 100000;
const TEAM_TARGET   = 1000000;
const STALE_DAYS    = 7;

const REPS = {
  '80811940': { name: 'Nate Spargo',  role: 'Director of CS',                        initials: 'NS' },
  '81657454': { name: 'Joe DeRario',  role: 'Sr. Sales Account Executive',           initials: 'JD' },
  '86826804': { name: 'Jason Rupert', role: 'Sales Account Executive',               initials: 'JR' },
  '90736265': { name: 'Jakob Krause', role: 'Director of Sales and Client Consulting', initials: 'JK' },
};
const REP_IDS = Object.keys(REPS);

function cors(env, req) {
  const origin  = req.headers.get('Origin') || '';
  const allowed = env.ALLOWED_ORIGIN || 'https://krausshauss.github.io';
  const ok      = !origin || origin.startsWith(allowed) || origin.includes('hubspot') || origin.includes('localhost');
  return {
    'Access-Control-Allow-Origin':  ok ? (origin || '*') : allowed,
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Pin',
    'Vary': 'Origin',
  };
}

function json(data, status, hdrs) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...hdrs },
  });
}

async function hsPost(env, path, body) {
  const r = await fetch('https://api.hubapi.com' + path, {
    method:  'POST',
    headers: { 'Authorization': 'Bearer ' + env.HUBSPOT_TOKEN, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!r.ok) throw new Error('HubSpot ' + path + ' => ' + r.status + ': ' + await r.text());
  return r.json();
}

async function hsGet(env, path) {
  const r = await fetch('https://api.hubapi.com' + path, {
    headers: { 'Authorization': 'Bearer ' + env.HUBSPOT_TOKEN },
  });
  if (!r.ok) throw new Error('HubSpot GET ' + path + ' => ' + r.status);
  return r.json();
}

async function fetchAllDeals(env) {
  const props = [
    'dealname','amount','dealstage','pipeline','hubspot_owner_id',
    'closedate','createdate','hs_lastmodifieddate','notes_last_updated',
    'hs_is_closed_won','hs_is_closed','hs_next_step','hs_object_id',
    'hs_deal_score','hs_predicted_amount','hs_likelihood_to_close',
    'hs_deal_stage_probability','hs_days_to_close','hs_time_in_stage',
    'num_associated_contacts','hs_num_associated_deals',
    'notes_last_updated','hs_latest_meeting_activity',
  ];
  const results = [];
  let after = null;
  while (true) {
    const body = { properties: props, limit: 100 };
    if (after) body.after = after;
    const data = await hsPost(env, '/crm/v3/objects/deals/search', body);
    results.push(...(data.results || []));
    after = data.paging && data.paging.next ? data.paging.next.after : null;
    if (!after) break;
  }
  return results;
}

async function fetchActivity(env, objectType, props, filterProp, cutoff) {
  const results = [];
  let after = null;
  while (true) {
    const body = {
      properties: props,
      limit: 100,
      filterGroups: [{ filters: [{ propertyName: filterProp, operator: 'GTE', value: cutoff }] }],
    };
    if (after) body.after = after;
    try {
      const data = await hsPost(env, '/crm/v3/objects/' + objectType + '/search', body);
      results.push(...(data.results || []));
      after = data.paging && data.paging.next ? data.paging.next.after : null;
      if (!after) break;
    } catch(e) {
      console.warn('Activity fetch failed for ' + objectType + ': ' + e.message);
      break;
    }
  }
  return results;
}

async function fetchLeadActivities(env, objectType, props, cutoff, ownerIds) {
  const allProps = [...new Set([...props, 'hubspot_owner_id', 'hs_created_by_user_id', 'hs_timestamp'])];
  const results = [];
  let after = null;
  while (true) {
    const body = {
      properties: allProps,
      limit: 100,
      filterGroups: [
        { filters: [
          { propertyName: 'hs_timestamp', operator: 'GTE', value: cutoff },
          { propertyName: 'hubspot_owner_id', operator: 'IN', values: ownerIds },
        ]},
        { filters: [
          { propertyName: 'hs_timestamp', operator: 'GTE', value: cutoff },
          { propertyName: 'hs_created_by_user_id', operator: 'IN', values: ownerIds },
        ]},
      ],
    };
    if (after) body.after = after;
    try {
      const data = await hsPost(env, '/crm/v3/objects/' + objectType + '/search', body);
      results.push(...(data.results || []));
      after = data.paging && data.paging.next ? data.paging.next.after : null;
      if (!after) break;
    } catch(e) {
      console.warn('Lead activity fetch failed for ' + objectType + ': ' + e.message);
      break;
    }
  }
  return results;
}

// ── BUILD 4-WEEK HISTORY FROM DEAL DATA ─────────────────────────────
function buildWeeklyHistory(allDeals, allCalls, allMeetings, allComms, allSalesNavTasks, now, REP_MAP) {
  function getMondayOfWeek(d) {
    const day = d.getDay();
    const mon = new Date(d);
    mon.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
    mon.setHours(0, 0, 0, 0);
    return mon;
  }

  function countActivity(records, ownerId, wMon, wFri) {
    return records.filter(a => {
      const ts    = a.properties && a.properties.hs_timestamp
        ? new Date(a.properties.hs_timestamp) : null;
      const owner = a.properties && a.properties.hubspot_owner_id;
      const createdBy = a.properties && a.properties.hs_created_by_user_id;
      const isRep = owner === ownerId || createdBy === ownerId;
      return ts && isRep && ts >= wMon && ts <= wFri;
    }).length;
  }

  const thisMonday = getMondayOfWeek(now);
  const y2026start = new Date('2026-01-01T00:00:00Z');

  const weeks = [];
  for (let w = 1; w <= 4; w++) {
    const monMs  = thisMonday.getTime() - w * 7 * 86400000;
    const wMon   = new Date(monMs);
    const wFri   = new Date(monMs + 4 * 86400000 + 86399999);
    const label  = wMon.toLocaleDateString('en-US',{month:'short',day:'numeric'}) +
                   ' to ' +
                   wFri.toLocaleDateString('en-US',{month:'short',day:'numeric'});

    const repSnaps = {};
    Object.entries(REP_MAP).forEach(([id, info]) => {
      const repDeals = allDeals.filter(d => d.properties.hubspot_owner_id === id);

      const q2StartHist = new Date('2026-04-01T00:00:00Z');
      const cwWeek = repDeals.filter(d => {
        const cd = d.properties.closedate ? new Date(d.properties.closedate) : null;
        return cd && cd >= y2026start && cd <= wFri &&
               d.properties.hs_is_closed_won === 'true';
      });
      const cwQ2 = cwWeek.filter(d => {
        const cd = d.properties.closedate ? new Date(d.properties.closedate) : null;
        return cd && cd >= q2StartHist;
      });

      const active = repDeals.filter(d => {
        const created      = d.properties.createdate ? new Date(d.properties.createdate) : null;
        const closed       = d.properties.closedate  ? new Date(d.properties.closedate)  : null;
        const isClosedWon  = d.properties.hs_is_closed_won === 'true';
        const isClosed     = d.properties.hs_is_closed     === 'true';
        const isClosedLost = (d.properties.dealstage || '').toLowerCase().includes('closed lost');
        if (!created || created > wFri) return false;
        if (isClosedWon  && closed && closed <= wFri) return false;
        if (isClosed     && closed && closed <= wFri) return false;
        if (isClosedLost && closed && closed <= wFri) return false;
        return true;
      });

      const pipeV = active.reduce((s,d) => s + (parseFloat(d.properties.amount)||0), 0);

      const stale7 = active.filter(d => {
        const lm = d.properties.hs_lastmodifieddate ? new Date(d.properties.hs_lastmodifieddate) : null;
        return !lm || lm < new Date(wFri.getTime() - 7 * 86400000);
      }).length;

      const advanced = active.filter(d => {
        const lm = d.properties.hs_lastmodifieddate ? new Date(d.properties.hs_lastmodifieddate) : null;
        return lm && lm >= wMon && lm <= wFri;
      }).length;

      const wkCalls    = countActivity(allCalls,    id, wMon, wFri);
      const wkMeetings = countActivity(allMeetings, id, wMon, wFri);
      const wkLinkedInComms = allComms.filter(a => {
        const ts    = a.properties?.hs_timestamp ? new Date(a.properties.hs_timestamp) : null;
        const owner = a.properties?.hubspot_owner_id;
        const cb    = a.properties?.hs_created_by_user_id;
        const type  = (a.properties?.hs_communication_channel_type || '').toLowerCase();
        const isRep = owner === id || cb === id;
        const isLI  = type.includes('linkedin') || type.includes('sales_nav') || type.includes('inmail');
        return ts && isRep && isLI && ts >= wMon && ts <= wFri;
      }).length;
      const wkLinkedInTasks = allSalesNavTasks.filter(t => {
        const tsRaw = t.properties?.hs_task_completion_date || t.properties?.hs_timestamp;
        const ts    = tsRaw ? new Date(tsRaw) : null;
        const owner = t.properties?.hubspot_owner_id;
        const cb    = t.properties?.hs_created_by_user_id;
        return ts && (owner === id || cb === id) && ts >= wMon && ts <= wFri;
      }).length;
      const wkLinkedIn = wkLinkedInComms + wkLinkedInTasks;

      repSnaps[id] = {
        id:                  info.initials.toLowerCase(),
        name:                info.name,
        cw_amount:           cwWeek.reduce((s,d) => s+(parseFloat(d.properties.amount)||0), 0),
        cw_q2:               cwQ2.reduce((s,d) => s+(parseFloat(d.properties.amount)||0), 0),
        cw_deals:            cwWeek.length,
        active_deals:        active.length,
        pipeline_value:      pipeV,
        stale_7d:            stale7,
        raw_calls:           wkCalls,
        raw_meetings:        wkMeetings,
        raw_linkedin:        wkLinkedIn,
        deals_advanced_week: advanced,
      };
    });

    // Team CW totals from ALL owners (not just REPS) so team trend matches HubSpot reports
    const q2StartHist = new Date('2026-04-01T00:00:00Z');
    const teamCwWeek = allDeals.filter(d => {
      const cd = d.properties.closedate ? new Date(d.properties.closedate) : null;
      return cd && cd >= y2026start && cd <= wFri && d.properties.hs_is_closed_won === 'true';
    });
    const teamCwQ2 = teamCwWeek.filter(d => {
      const cd = d.properties.closedate ? new Date(d.properties.closedate) : null;
      return cd && cd >= q2StartHist;
    });

    weeks.push({
      week:       label,
      savedAt:    wFri.toISOString(),
      reps:       Object.values(repSnaps),
      team_cw:    teamCwWeek.reduce((s,d) => s+(parseFloat(d.properties.amount)||0), 0),
      team_cw_q2: teamCwQ2.reduce((s,d) => s+(parseFloat(d.properties.amount)||0), 0),
    });
  }

  return weeks;
}

async function buildData(env) {
  const now     = new Date();
  const y2026   = new Date('2026-01-01T00:00:00Z');
  const q1End   = new Date('2026-03-31T23:59:59Z');
  const q2Start = new Date('2026-04-01T00:00:00Z');
  const q2End   = new Date('2026-06-30T23:59:59Z');
  const q3Start = new Date('2026-07-01T00:00:00Z');
  const q3End   = new Date('2026-09-30T23:59:59Z');
  const q4Start = new Date('2026-10-01T00:00:00Z');
  const weekAgo = new Date(now.getTime() - STALE_DAYS * 86400000);

  const stageMap = {
    '1095818328': 'Sales Opportunity',
    '1095818329': 'Trial (optional)',
    '1095818330': 'Discovery/Demo (SQL)',
    '1095818331': 'Sales Opportunity',
    '1096685575': 'Negotiation',
    '36731685':   'Commit/Verbal',
    'Discovery/Demo (SQL)':  'Discovery/Demo (SQL)',
    'Sales Opportunity':     'Sales Opportunity',
    'Trial (optional)':      'Trial (optional)',
    'Negotiation':           'Negotiation',
    'Commit/Verbal':         'Commit/Verbal',
    'Closed Won':            'Closed Won',
    'Closed Lost':           'Closed Lost',
  };
  let higherEdPipelineId = null;
  try {
    const pipelines = await hsGet(env, '/crm/v3/pipelines/deals');
    (pipelines.results || []).forEach(p => {
      if ((p.label || '').toLowerCase().includes('higher ed')) higherEdPipelineId = p.id;
      (p.stages || []).forEach(s => {
        const label = (s.label || '').trim();
        const id    = (s.id    || '').trim();
        const ll    = label.toLowerCase();
        let mapped  = label;
        if      (ll.includes('discov') || ll.includes('demo') || ll.includes('sql'))  mapped = 'Discovery/Demo (SQL)';
        else if (ll.includes('sales') && ll.includes('opportun'))                     mapped = 'Sales Opportunity';
        else if (ll === 'sales opportunity')                                           mapped = 'Sales Opportunity';
        else if (ll.includes('trial'))                                                 mapped = 'Trial (optional)';
        else if (ll.includes('negotiat'))                                              mapped = 'Negotiation';
        else if (ll.includes('commit') || ll.includes('verbal'))                      mapped = 'Commit/Verbal';
        else if (ll.includes('closed won')  || ll === 'closedwon')                    mapped = 'Closed Won';
        else if (ll.includes('closed lost') || ll === 'closedlost')                   mapped = 'Closed Lost';
        if (id)    stageMap[id]    = mapped;
        if (label) stageMap[label] = mapped;
      });
    });
    console.log('[QH] Stage map:', Object.keys(stageMap).join(', '));
    console.log('[QH] Higher Ed pipeline ID:', higherEdPipelineId);
  } catch(e) {
    console.warn('[QH] Stage map skipped:', e.message);
  }

  const allDeals = await fetchAllDeals(env);
  console.log('[QH] Total deals: ' + allDeals.length);

  const actMap = {};
  REP_IDS.forEach(id => { actMap[id] = { calls: 0, meetings: 0, emails: 0, sms: 0, linkedin: 0 }; });

  const weekAgoISO      = weekAgo.toISOString();
  const fourWeeksAgo    = new Date(now.getTime() - 28 * 86400000);
  const fourWeeksAgoISO = fourWeeksAgo.toISOString();
  const repOwnerIds     = REP_IDS;

  const [calls, meetings, emails, comms, tasks] = await Promise.allSettled([
    fetchLeadActivities(env, 'calls',    ['hubspot_owner_id','hs_timestamp','hs_created_by_user_id'], fourWeeksAgoISO, repOwnerIds),
    fetchLeadActivities(env, 'meetings', ['hubspot_owner_id','hs_timestamp','hs_created_by_user_id'], fourWeeksAgoISO, repOwnerIds),
    fetchActivity(env, 'emails',         ['hubspot_owner_id','hs_timestamp'], 'hs_timestamp', weekAgoISO),
    fetchLeadActivities(env, 'communications', ['hubspot_owner_id','hs_timestamp','hs_communication_channel_type','hs_created_by_user_id'], fourWeeksAgoISO, repOwnerIds),
    fetchActivity(env, 'tasks', [
      'hubspot_owner_id','hs_task_type','hs_task_status',
      'hs_task_completion_date','subject','hs_created_by_user_id'
    ], 'hs_task_completion_date', fourWeeksAgoISO),
  ]);

  const allCalls    = (calls.status    === 'fulfilled' ? calls.value    : []);
  const allMeetings = (meetings.status === 'fulfilled' ? meetings.value : []);
  const allComms    = (comms.status    === 'fulfilled' ? comms.value    : []);
  const allTasks    = (tasks.status    === 'fulfilled' && Array.isArray(tasks.value)) ? tasks.value : [];
  console.log('[QH] Tasks fetched:', allTasks.length);

  const isThisWeek  = ts => { const d = ts ? new Date(ts) : null; return d && d >= weekAgo; };
  const repOwnerSet = new Set(REP_IDS);

  const isSalesNavTask = t => {
    const type   = (t.properties?.hs_task_type   || '').toUpperCase();
    const status = (t.properties?.hs_task_status || '').toUpperCase();
    const owner  = t.properties?.hubspot_owner_id || '';
    const isRep  = repOwnerSet.has(owner);
    const isLI   = type === 'LINKED_IN_CONNECT' || type.includes('LINKEDIN') || type.includes('SALES_NAV');
    const isDone = status === 'COMPLETED';
    return isRep && isLI && isDone;
  };
  const allSalesNavTasks = allTasks.filter(isSalesNavTask);
  console.log('[QH] Sales Nav tasks:', allSalesNavTasks.length);

  if (calls.status === 'fulfilled') calls.value.forEach(c => {
    if (!isThisWeek(c.properties?.hs_timestamp)) return;
    const o  = c.properties?.hubspot_owner_id;
    const cb = c.properties?.hs_created_by_user_id;
    const id = (o && repOwnerSet.has(o)) ? o : (cb && repOwnerSet.has(cb)) ? cb : null;
    if (id && actMap[id]) actMap[id].calls++;
  });
  if (meetings.status === 'fulfilled') meetings.value.forEach(m => {
    if (!isThisWeek(m.properties?.hs_timestamp)) return;
    const o  = m.properties?.hubspot_owner_id;
    const cb = m.properties?.hs_created_by_user_id;
    const id = (o && repOwnerSet.has(o)) ? o : (cb && repOwnerSet.has(cb)) ? cb : null;
    if (id && actMap[id]) actMap[id].meetings++;
  });
  if (emails.status === 'fulfilled') emails.value.forEach(e => {
    const o = e.properties?.hubspot_owner_id;
    if (o && actMap[o]) actMap[o].emails++;
  });
  if (comms.status === 'fulfilled') comms.value.forEach(c => {
    if (!isThisWeek(c.properties?.hs_timestamp)) return;
    const o    = c.properties?.hubspot_owner_id;
    const cb   = c.properties?.hs_created_by_user_id;
    const type = (c.properties?.hs_communication_channel_type || '').toLowerCase();
    const id   = (o && repOwnerSet.has(o)) ? o : (cb && repOwnerSet.has(cb)) ? cb : null;
    if (!id) return;
    if (type.includes('sms') || type.includes('whatsapp'))
      actMap[id].sms = (actMap[id].sms || 0) + 1;
    else if (type.includes('linkedin') || type.includes('sales_nav') || type.includes('inmail'))
      actMap[id].linkedin = (actMap[id].linkedin || 0) + 1;
    else
      actMap[id].other_comms = (actMap[id].other_comms || 0) + 1;
  });
  allSalesNavTasks.forEach(t => {
    const taskTs = t.properties?.hs_task_completion_date || t.properties?.hs_timestamp;
    if (!isThisWeek(taskTs)) return;
    const o  = t.properties?.hubspot_owner_id;
    const cb = t.properties?.hs_created_by_user_id;
    const id = (o && repOwnerSet.has(o)) ? o : (cb && repOwnerSet.has(cb)) ? cb : null;
    if (id) actMap[id].linkedin = (actMap[id].linkedin || 0) + 1;
  });

  const grouped = {};
  REP_IDS.forEach(id => { grouped[id] = []; });
  allDeals.forEach(d => {
    const oid = d.properties && d.properties.hubspot_owner_id;
    if (oid && grouped[oid]) grouped[oid].push(d.properties);
  });
  REP_IDS.forEach(id => console.log('[QH] ' + REPS[id].name + ': ' + grouped[id].length + ' deals'));

  const reps = REP_IDS.map(ownerId => {
    const info  = REPS[ownerId];
    const deals = grouped[ownerId] || [];
    const act   = actMap[ownerId]  || { calls: 0, meetings: 0, emails: 0 };

    const isWon    = d => d.hs_is_closed_won === 'true' || d.hs_is_closed_won === true;
    const isClosed = d => d.hs_is_closed     === 'true' || d.hs_is_closed     === true;

    const active = deals.filter(d => {
      const stage = (d.dealstage || '').toLowerCase();
      return !isWon(d) && !isClosed(d) && !stage.includes('closedlost') && !stage.includes('closed_lost');
    });

    const cw2026 = deals.filter(d => {
      if (!isWon(d)) return false;
      const cd = d.closedate ? new Date(d.closedate) : null;
      return cd && cd >= y2026;
    });

    const cwAmt  = cw2026.reduce((s, d) => s + (parseFloat(d.amount) || 0), 0);
    const inQ    = (d, qs, qe) => { const cd = d.closedate ? new Date(d.closedate) : null; return cd && cd >= qs && cd <= qe; };
    const q1Deals = cw2026.filter(d => inQ(d, y2026,   q1End  ));
    const q2Deals = cw2026.filter(d => inQ(d, q2Start, q2End  ));
    const q3Deals = cw2026.filter(d => inQ(d, q3Start, q3End  ));
    const q4Deals = cw2026.filter(d => inQ(d, q4Start, now    ));
    const q1Amt  = q1Deals.reduce((s,d) => s+(parseFloat(d.amount)||0), 0);
    const q2Amt  = q2Deals.reduce((s,d) => s+(parseFloat(d.amount)||0), 0);
    const q3Amt  = q3Deals.reduce((s,d) => s+(parseFloat(d.amount)||0), 0);
    const q4Amt  = q4Deals.reduce((s,d) => s+(parseFloat(d.amount)||0), 0);
    const pipeV  = active.reduce((s, d) => s + (parseFloat(d.amount) || 0), 0);
    const total  = active.length;

    const stale = active.filter(d => {
      const la = d.notes_last_updated || d.hs_lastmodifieddate;
      return !la || new Date(la) < weekAgo;
    }).length;

    const advWk = active.filter(d => {
      const lm = d.hs_lastmodifieddate;
      return lm && new Date(lm) >= weekAgo;
    }).length;

    const hasNS  = active.filter(d => d.hs_next_step && d.hs_next_step.trim()).length;
    const hasAmt = active.filter(d => parseFloat(d.amount) > 0).length;
    const hasCD  = active.filter(d => d.closedate).length;

    const VSTAGES = ['negotiat','commit','verbal','trial','opportun','discov','demo','sql','closedwon','closedlost'];
    const sfPct   = total ? Math.round(active.filter(d => {
      const s = (d.dealstage || '').toLowerCase();
      return VSTAGES.some(v => s.includes(v));
    }).length / total * 100) : 0;

    const ages   = active.filter(d => d.createdate).map(d => (now - new Date(d.createdate)) / 86400000);
    const avgAge = ages.length ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : 45;

    const expansion = cw2026.filter(d => {
      const cd = d.closedate ? new Date(d.closedate) : null;
      return cd && (now - cd) / 86400000 < 90;
    }).map(d => ({ name: d.dealname || '', amount: parseFloat(d.amount) || 0, stage: 'Closed Won', cw: true }));

    const dealList = active.map(d => {
      const rawStage = d.dealstage || '';
      let stage      = stageMap[rawStage] || rawStage || 'Unknown';
      const sl       = stage.toLowerCase().replace(/_/g,' ').replace(/[/]/g,' ');
      if      (sl === 'discovery demo  sql'  || sl === 'discovery/demo (sql)' || sl.includes('discov') || sl.includes('demo') || sl.includes('sql') || sl.includes('qualify') || sl.includes('appoint')) stage = 'Discovery/Demo (SQL)';
      else if (sl === 'sales opportunity'     || sl === 'salesopportunity'     || sl.includes('opportun'))             stage = 'Sales Opportunity';
      else if (sl === 'trial (optional)'      || sl === 'trial  optional '     || sl.includes('trial'))                stage = 'Trial (optional)';
      else if (sl === 'negotiation'           || sl.includes('negotiat'))                                              stage = 'Negotiation';
      else if (sl === 'commit v'              || sl === 'commit verbal'         || sl.includes('commit') || sl.includes('verbal')) stage = 'Commit/Verbal';
      else if (sl.includes('closed won')      || sl === 'closedwon')                                                   stage = 'Closed Won';
      else if (sl.includes('closed lost')     || sl === 'closedlost')                                                  stage = 'Closed Lost';
      else if (sl.includes('prospect') || sl.includes('lead') || sl.includes('contact') || sl.includes('present'))    stage = 'Discovery/Demo (SQL)';
      const la     = d.notes_last_updated || d.hs_lastmodifieddate;
      const staleD = la ? Math.round((now - new Date(la)) / 86400000) : 999;
      return {
        name:         d.dealname || '',
        stage,
        amount:       parseFloat(d.amount) || null,
        stale:        staleD,
        next:         d.hs_next_step || '',
        id:           d.hs_object_id || '',
        deal_score:   d.hs_deal_score ? Math.round(parseFloat(d.hs_deal_score)) : null,
        likelihood:   d.hs_likelihood_to_close ? Math.round(parseFloat(d.hs_likelihood_to_close)*100) : null,
        probability:  d.hs_deal_stage_probability ? Math.round(parseFloat(d.hs_deal_stage_probability)*100) : null,
        days_to_close: d.hs_days_to_close ? Math.round(parseFloat(d.hs_days_to_close)) : null,
        contacts:     d.num_associated_contacts ? parseInt(d.num_associated_contacts) : null,
      };
    });

    return {
      id: info.initials.toLowerCase(), name: info.name, initials: info.initials, role: info.role,
      cw_amount: cwAmt, cw_deals: cw2026.length,
      q1_cw: q1Amt, q2_cw: q2Amt, q3_cw: q3Amt, q4_cw: q4Amt,
      q1_deals: q1Deals.length, q2_deals: q2Deals.length, q3_deals: q3Deals.length, q4_deals: q4Deals.length,
      active_deals: total, pipeline_value: pipeV, stale_7d: stale,
      deals_advanced_week: advWk, avg_days_to_close: avgAge,
      ip_meetings_week: Math.round(act.meetings * 0.5),
      vr_calls_week:    act.meetings - Math.round(act.meetings * 0.5),
      phone_calls_week: act.calls, text_touches_week: 0,
      raw_calls: act.calls, raw_meetings: act.meetings, raw_emails: act.emails,
      raw_sms: act.sms||0, raw_linkedin: act.linkedin||0,
      meetings_target: 6, calls_target: 15, text_target: 5,
      next_step_pct:    total ? Math.round(hasNS  / total * 100) : 0,
      amount_populated: total ? Math.round(hasAmt  / total * 100) : 0,
      close_date_set:   total ? Math.round(hasCD   / total * 100) : 0,
      stage_flow_pct:   sfPct, bant_pct: 50, daily_verified: 80,
      expansion_deals: expansion, deals: dealList,
    };
  });

  let computedHistory = [];
  try {
    computedHistory = buildWeeklyHistory(allDeals, allCalls, allMeetings, allComms, allSalesNavTasks, now, REPS);
    console.log('[QH] Computed history: ' + computedHistory.length + ' weeks');
  } catch(e) {
    console.warn('[QH] History computation failed (non-fatal):', e.message);
  }

  // Team aggregates — Higher Ed pipeline only, active deals only
  const isHigherEd = d => !higherEdPipelineId || d.properties.pipeline === higherEdPipelineId;
  const teamActive = allDeals.filter(d => {
    if (!isHigherEd(d)) return false;
    const stage    = (d.properties.dealstage || '').toLowerCase();
    const isWon    = d.properties.hs_is_closed_won === 'true';
    const isClosed = d.properties.hs_is_closed     === 'true';
    return !isWon && !isClosed && !stage.includes('closedlost') && !stage.includes('closed_lost');
  });
  const teamCW2026 = allDeals.filter(d => {
    if (!isHigherEd(d)) return false;
    if (d.properties.hs_is_closed_won !== 'true') return false;
    const cd = d.properties.closedate ? new Date(d.properties.closedate) : null;
    return cd && cd >= y2026;
  });
  const inQtr = (d, qs, qe) => { const cd = d.properties.closedate ? new Date(d.properties.closedate) : null; return cd && cd >= qs && cd <= qe; };
  const team = {
    pipeline:     teamActive.reduce((s,d) => s + (parseFloat(d.properties.amount)||0), 0),
    active_deals: teamActive.length,
    stale_7d:     teamActive.filter(d => {
      const la = d.properties.notes_last_updated || d.properties.hs_lastmodifieddate;
      return !la || new Date(la) < weekAgo;
    }).length,
    cw_amount: teamCW2026.reduce((s,d) => s + (parseFloat(d.properties.amount)||0), 0),
    q1_cw: teamCW2026.filter(d => inQtr(d, y2026,   q1End  )).reduce((s,d) => s+(parseFloat(d.properties.amount)||0), 0),
    q2_cw: teamCW2026.filter(d => inQtr(d, q2Start, q2End  )).reduce((s,d) => s+(parseFloat(d.properties.amount)||0), 0),
    q3_cw: teamCW2026.filter(d => inQtr(d, q3Start, q3End  )).reduce((s,d) => s+(parseFloat(d.properties.amount)||0), 0),
    q4_cw: teamCW2026.filter(d => inQtr(d, q4Start, now    )).reduce((s,d) => s+(parseFloat(d.properties.amount)||0), 0),
  };
  console.log('[QH] Team pipeline: $' + Math.round(team.pipeline/1000) + 'K across ' + team.active_deals + ' deals');

  return {
    reps, team, version: 10, source: 'hubspot-api',
    workerVersion: WORKER_VERSION,
    exportDate: now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
    savedAt:    now.toISOString(),
    history:    computedHistory,
  };
}

// ── GITHUB CACHE ─────────────────────────────────────────────────────
async function ghRead(env) {
  const GITHUB_OWNER  = env.GITHUB_OWNER  || 'krausshauss';
  const GITHUB_REPO   = env.GITHUB_REPO   || 'quanthub-dashboard-dev';
  const GITHUB_BRANCH = env.GITHUB_BRANCH || 'dev';
  const url = 'https://api.github.com/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/contents/' + DATA_FILE + '?ref=' + GITHUB_BRANCH;
  const r   = await fetch(url, { headers: { 'Authorization': 'token ' + env.GITHUB_TOKEN, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'QH-Worker/3' } });
  if (r.status === 404) return { content: null, sha: null };
  if (!r.ok) throw new Error('GitHub read: ' + r.status);
  const f   = await r.json();
  return { content: JSON.parse(atob(f.content.replace(/\n/g, ''))), sha: f.sha };
}

async function ghWrite(env, data, sha) {
  const GITHUB_OWNER  = env.GITHUB_OWNER  || 'krausshauss';
  const GITHUB_REPO   = env.GITHUB_REPO   || 'quanthub-dashboard-dev';
  const GITHUB_BRANCH = env.GITHUB_BRANCH || 'dev';
  const url  = 'https://api.github.com/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/contents/' + DATA_FILE;
  const body = {
    message: 'Scorecard update: ' + (data.exportDate || new Date().toDateString()),
    content: btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2)))),
    branch:  GITHUB_BRANCH,
  };
  if (sha) body.sha = sha;
  const r = await fetch(url, {
    method: 'PUT',
    headers: { 'Authorization': 'token ' + env.GITHUB_TOKEN, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'QH-Worker/3', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) { const e = await r.json(); throw new Error(e.message || 'GitHub write: ' + r.status); }
  return true;
}

export default {
  async fetch(request, env, ctx) {
    const c   = cors(env, request);
    const url = new URL(request.url);
    const m   = request.method;
    const p   = url.pathname;

    if (m === 'OPTIONS') return new Response(null, { status: 204, headers: c });

    const pin     = request.headers.get('X-Admin-Pin') || url.searchParams.get('pin');
    const correct = env.ADMIN_PIN || '7777';

    try {

      // POST /validate-pin
      if (m === 'POST' && p.includes('validate-pin')) {
        return pin === correct
          ? json({ ok: true }, 200, c)
          : json({ error: 'Invalid PIN' }, 401, c);
      }

      // GET /debug — raw HubSpot sample + owner list (PIN required)
      if (m === 'GET' && p.includes('debug')) {
        if (pin !== correct) return json({ error: 'Unauthorized' }, 401, c);
        const raw    = await hsPost(env, '/crm/v3/objects/deals/search', { properties: ['dealname','amount','dealstage','hubspot_owner_id','hs_is_closed_won','closedate'], limit: 5 });
        const owners = await hsGet(env, '/crm/v3/owners?limit=50');
        let stages = [];
        try {
          const pipelines = await hsGet(env, '/crm/v3/pipelines/deals');
          stages = (pipelines.results || []).flatMap(p =>
            (p.stages || []).map(s => ({ pipeline: p.label, stageId: s.id, label: s.label }))
          );
        } catch(e) { stages = [{ error: e.message }]; }

        let meetingSample = [];
        try {
          const mtg = await hsPost(env, '/crm/v3/objects/meetings/search', {
            properties: ['hubspot_owner_id','hs_timestamp','hs_meeting_title',
                         'hs_created_by_user_id','hs_activity_type','hs_meeting_outcome'],
            limit: 20,
            filterGroups: [
              { filters: [{ propertyName: 'hs_timestamp', operator: 'GTE', value: new Date(Date.now() - 14*86400000).toISOString() },
                          { propertyName: 'hubspot_owner_id', operator: 'IN', values: REP_IDS }] },
              { filters: [{ propertyName: 'hs_timestamp', operator: 'GTE', value: new Date(Date.now() - 14*86400000).toISOString() },
                          { propertyName: 'hs_created_by_user_id', operator: 'IN', values: REP_IDS }] },
            ],
          });
          meetingSample = (mtg.results || []).map(m => ({
            title:      m.properties.hs_meeting_title,
            owner_id:   m.properties.hubspot_owner_id,
            created_by: m.properties.hs_created_by_user_id,
            timestamp:  m.properties.hs_timestamp,
            type:       m.properties.hs_activity_type,
            outcome:    m.properties.hs_meeting_outcome,
          }));
        } catch(e) { meetingSample = [{ error: e.message }]; }

        let callSample = [];
        try {
          const cl = await hsPost(env, '/crm/v3/objects/calls/search', {
            properties: ['hubspot_owner_id','hs_timestamp','hs_call_title','hs_created_by_user_id'],
            limit: 10,
            filterGroups: [{ filters: [{ propertyName: 'hs_timestamp', operator: 'GTE',
              value: new Date(Date.now() - 14*86400000).toISOString() }] }],
          });
          callSample = (cl.results || []).map(c => ({
            title:      c.properties.hs_call_title,
            owner_id:   c.properties.hubspot_owner_id,
            created_by: c.properties.hs_created_by_user_id,
            timestamp:  c.properties.hs_timestamp,
          }));
        } catch(e) { callSample = [{ error: e.message }]; }

        return json({
          total:   raw.total,
          sample:  (raw.results || []).slice(0, 10).map(d => ({
            dealname: d.properties.dealname,
            dealstage: d.properties.dealstage,
            owner: d.properties.hubspot_owner_id,
            closed_won: d.properties.hs_is_closed_won,
            amount: d.properties.amount,
          })),
          owners:       (owners.results || []).map(o => ({ id: o.id, name: o.firstName + ' ' + o.lastName, email: o.email })),
          stages,
          repKeys:      REP_IDS,
          meetingSample,
          callSample,
        }, 200, c);
      }

      // GET /version
      if (m === 'GET' && p.includes('version')) {
        return json({ version: WORKER_VERSION, updated: '2026-04-06', worker: 'quanthub-proxy-dev', status: 'ok' }, 200, c);
      }

      // GET /test — step-by-step buildData diagnosis (PIN required)
      if (m === 'GET' && p.includes('test')) {
        if (pin !== correct) return json({ error: 'Unauthorized' }, 401, c);
        const steps = [];
        try {
          steps.push('start');
          const allDeals = await fetchAllDeals(env);
          steps.push('deals:' + allDeals.length);
          const now = new Date();
          const fourWeeksAgo = new Date(now.getTime() - 28 * 86400000);
          steps.push('dates-ok');
          const calls = await fetchLeadActivities(env, 'calls', ['hubspot_owner_id','hs_timestamp'], fourWeeksAgo.toISOString(), REP_IDS);
          steps.push('calls:' + calls.length);
          const meetings = await fetchLeadActivities(env, 'meetings', ['hubspot_owner_id','hs_timestamp'], fourWeeksAgo.toISOString(), REP_IDS);
          steps.push('meetings:' + meetings.length);
          const comms = await fetchLeadActivities(env, 'communications', ['hubspot_owner_id','hs_timestamp','hs_communication_channel_type'], fourWeeksAgo.toISOString(), REP_IDS);
          steps.push('comms:' + comms.length);

          let taskSample = [];
          try {
            const allT = await fetchActivity(env, 'tasks', [
              'hubspot_owner_id','hs_task_type','hs_task_status',
              'hs_task_completion_date','subject','hs_created_by_user_id',
              'hs_task_subject'
            ], 'hs_task_completion_date', new Date(Date.now() - 28*86400000).toISOString());
            steps.push('total-tasks:' + allT.length);
            const liTasks = allT.filter(t =>
              (t.properties?.hs_task_type||'').toUpperCase() === 'LINKED_IN_CONNECT' &&
              (t.properties?.hs_task_status||'').toUpperCase() === 'COMPLETED'
            );
            steps.push('linkedin-connect-tasks:' + liTasks.length);
            taskSample = liTasks.slice(0,5).map(x => ({
              subject:    x.properties?.subject,
              type:       x.properties?.hs_task_type,
              status:     x.properties?.hs_task_status,
              owner:      x.properties?.hubspot_owner_id,
              completion: x.properties?.hs_task_completion_date,
            }));
          } catch(e) { steps.push('tasks-error:' + e.message); }

          steps.push('all-fetches-ok');
          return json({ ok: true, steps, taskSample }, 200, c);
        } catch(e) {
          return json({ ok: false, steps, error: e.message, stack: e.stack }, 500, c);
        }
      }

      // GET / — serve data (cache-first, stale-while-revalidate)
      if (m === 'GET') {
        const forceRefresh = url.searchParams.get('refresh') === '1';

        // Always read cache first
        let cachedContent = null, cachedSha = null, cacheAge = 999;
        try {
          const { content, sha } = await ghRead(env);
          if (content && content.reps && content.reps.length) {
            cachedContent = content;
            cachedSha     = sha;
            if (content.savedAt) {
              cacheAge = (Date.now() - new Date(content.savedAt).getTime()) / 3600000;
            }
          }
        } catch(e) { console.warn('[QH] Cache read failed:', e.message); }

        // Serve stale cache immediately if not forcing refresh and cache is under 24h
        if (!forceRefresh && cachedContent && cacheAge < 24) {
          console.log('[QH] Serving from cache, age: ' + cacheAge.toFixed(1) + 'h');
          // Refresh in background if older than 4h
          if (cacheAge >= 4 && ctx && ctx.waitUntil) {
            ctx.waitUntil((async () => {
              try {
                const data = await buildData(env);
                const { sha: freshSha } = await ghRead(env).catch(() => ({ sha: cachedSha }));
                await ghWrite(env, data, freshSha || cachedSha);
                console.log('[QH] Background refresh done');
              } catch(e) { console.warn('[QH] Background refresh failed:', e.message); }
            })());
          }
          return json(cachedContent, 200, { ...c, 'X-Source': 'cache' });
        }

        // No usable cache — fetch live
        console.log('[QH] Fetching live from HubSpot...');
        try {
          const data = await buildData(env);
          const shaForWrite = cachedSha;
          const cacheWrite = async () => {
            try {
              const { sha: freshSha } = await ghRead(env).catch(() => ({ sha: shaForWrite }));
              await ghWrite(env, data, freshSha || shaForWrite);
              console.log('[QH] Cache updated, reps: ' + data.reps.length);
            } catch(e) { console.warn('[QH] Cache write failed:', e.message); }
          };
          if (ctx && ctx.waitUntil) ctx.waitUntil(cacheWrite());
          else cacheWrite();
          return json(data, 200, { ...c, 'X-Source': 'live' });
        } catch(e) {
          // HubSpot unavailable — serve stale cache if we have it rather than error
          if (cachedContent) {
            console.warn('[QH] Live fetch failed, serving stale cache:', e.message);
            return json(cachedContent, 200, { ...c, 'X-Source': 'stale' });
          }
          throw e;
        }
      }

      // PUT / — save manual overrides (PIN required)
      if (m === 'PUT') {
        if (pin !== correct) return json({ error: 'Unauthorized' }, 401, c);
        const body    = await request.json();
        const { sha } = await ghRead(env);
        await ghWrite(env, body, sha);
        return json({ ok: true }, 200, c);
      }

      return new Response('Not found', { status: 404, headers: c });

    } catch(e) {
      console.error('[QH] Worker error: ' + e.message);
      return json({ error: e.message }, 500, c);
    }
  }
};
