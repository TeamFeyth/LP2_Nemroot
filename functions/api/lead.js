/**
 * POST /api/lead — Cloudflare Pages Function (Nemroot LP2).
 *
 * Runs automatically on Cloudflare Pages; no adapter or extra config needed.
 * Three jobs, each independent so one failure never blocks the others:
 *   1. Forward the lead to the CRM (Nemroot).
 *   2. Mirror it to a backup webhook (n8n / Zapier / Sheets), if configured.
 *   3. Send the Meta CAPI "Lead" event, de-duplicated against the browser
 *      pixel via the shared event_id.
 *
 * Environment variables (Cloudflare Pages > Settings > Environment variables):
 *   NEMROOT_API_BASE      Nemroot partner API host              (pending)
 *   NEMROOT_PARTNER_KEY   X-Partner-Key, issued once by Nemroot  (pending)
 *   NEMROOT_CUSTOMER_ID   nemroot-website
 *   NEMROOT_SOURCE        optional: overrides the derived source label
 *   RELAY_URL             Universal Standard Lead Relay /exec?key=...
 *   CRM_ENDPOINT          legacy Apps Script, kept during the transition
 *   CRM_AUTH_HEADER       e.g. "Authorization" or "X-API-Key"   (optional)
 *   CRM_AUTH_VALUE        e.g. "Bearer xxxxx"                   (optional)
 *   LEAD_BACKUP_WEBHOOK   n8n / Zapier catch URL                (optional)
 *   META_PIXEL_ID         defaults to the campaign pixel
 *   META_CAPI_TOKEN       Meta system-user access token         (pending)
 *   META_SERVER_LEAD      "on" to send the server-side Lead event (default off)
 *   LEAD_DEBUG           "true" to echo the normalized lead in the response
 */

// Same pixel as the browser snippet in BaseLayout.astro. The two must match,
// or the server's Lead event lands on a pixel the campaign never sees.
const PIXEL_FALLBACK = '2302599970275699';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

async function sha256(value) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const digits = (v) => String(v || '').replace(/\D/g, '');

function splitName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] || '', last: parts.slice(1).join(' ') };
}

/**
 * The page URL without its query string or hash. A tagged Meta ad URL runs to
 * 500+ characters, which the Partner API rejected (VALIDATION_ERROR, Oct 8).
 * Nothing is lost by trimming: the UTMs and click ids are already their own
 * fields, the ad ids are read out by adIdsFromUrl(), and the sheet keeps the
 * full URL.
 */
function cleanUrl(raw) {
  try {
    const u = new URL(raw);
    return u.origin + u.pathname;
  } catch (_) {
    return String(raw || '').split(/[?#]/)[0].slice(0, 500);
  }
}

/** Ad, ad set and campaign ids and the placement, from the ad's URL tags. */
function adIdsFromUrl(raw) {
  let p;
  try {
    p = new URL(raw).searchParams;
  } catch (_) {
    return { ad_id: '', ad_group_id: '', campaign_id: '', placement: '' };
  }
  return {
    ad_id: p.get('fb_ad_id') || p.get('hsa_ad') || '',
    ad_group_id: p.get('hsa_grp') || '',
    campaign_id: p.get('utm_id') || p.get('hsa_cam') || '',
    placement: p.get('utm_placement') || '',
  };
}

function validate(body) {
  // The Nemroot form asks for a first name, a phone and the dealership. There
  // is no email field and no consent checkbox, so neither is required here.
  const errors = [];
  if (!String(body.first_name || '').trim()) errors.push('first_name');
  if (digits(body.phone).length < 10) errors.push('phone');
  if (!String(body.dealership_name || '').trim()) errors.push('dealership_name');
  return errors;
}

/**
 * Cloudflare Turnstile.
 *
 * Deliberately fails OPEN if Cloudflare's verify endpoint is unreachable: on a
 * paid-traffic page, losing real leads to someone else's outage is worse than
 * letting a bot through. It only fails CLOSED on a token Cloudflare actively
 * rejects, and only when TURNSTILE_ENFORCE is not "false".
 */
async function verifyTurnstile(token, env, request) {
  if (!env.TURNSTILE_SECRET_KEY) return { checked: false, reason: 'not configured' };

  const form = new URLSearchParams();
  form.append('secret', env.TURNSTILE_SECRET_KEY);
  form.append('response', token || '');
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) form.append('remoteip', ip);

  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
    });
    const data = await res.json();
    return { checked: true, ok: !!data.success, codes: data['error-codes'] || [] };
  } catch (err) {
    return { checked: true, ok: true, failOpen: true, error: String(err) };
  }
}

/* ===========================================================================
 * Nemroot Partner Lead API
 *
 * Replaces the email hand-off. The lead is posted straight into the
 * dealership's Nemroot workspace, where their AI agent makes first contact by
 * text or email within seconds, so this call runs at the edge rather than via
 * the Apps Script relay: no cold start, no mail queue.
 *
 * Inert until NEMROOT_API_BASE, NEMROOT_PARTNER_KEY and NEMROOT_CUSTOMER_ID
 * are all set, so the current email path keeps working until cutover.
 * ======================================================================== */

const FORM_LABELS = {
  form_1_hero: 'hero form',
  form_2_prefooter: 'pre-footer form',
  form_3_popup_generic: 'exit-intent pop-up',
  form_3_popup_vehicle: 'vehicle pop-up (Check Availability)',
};

/** Which paid channel the click came from. Click IDs beat utm_source: they are
 *  set by the ad platform itself and cannot be mistyped in a campaign builder. */
function nemrootChannel(lead) {
  if (lead.gclid || lead.gbraid || lead.wbraid) return 'google_ads';
  if (lead.fbclid) return 'meta_ads';
  if (lead.msclkid) return 'bing_ads';
  const s = (lead.utm_source || '').toLowerCase();
  if (s.indexOf('google') !== -1) return 'google_ads';
  if (s.indexOf('facebook') !== -1 || s.indexOf('meta') !== -1 || s.indexOf('instagram') !== -1) {
    return 'meta_ads';
  }
  if (s.indexOf('bing') !== -1 || s.indexOf('microsoft') !== -1) return 'bing_ads';
  return 'direct';
}

/**
 * The `source` the dealership sees and reports on. Landing page plus channel,
 * so LP1 and LP2 and Google and Meta stay separable in their dashboard:
 * lp1_google_ads, lp2_meta_ads, and so on. NEMROOT_SOURCE overrides it whole if
 * Nemroot asks for a specific label.
 */
function nemrootSource(lead, env) {
  // Nemroot's own landing pages. Fixed per page rather than derived, because
  // the dealership reports on these as one stable source.
  return env.NEMROOT_SOURCE || 'nemroot_website_lp2';
}

/** Free text the AI agent reads before it writes to the buyer. */
function nemrootMessage(lead) {
  const lines = [
    'Demo request from the Nemroot landing page (' +
      (RELAY_FORM_NAMES[lead.form_id] || lead.form_id) +
      ' form on ' +
      RELAY_LANDING_PAGE +
      ').',
    '',
    'Dealership: ' + (lead.company || '-'),
    'Seats needed: ' + (lead.seats || '-'),
    'Leads per month: ' + (lead.monthly_leads || '-'),
    'Ad platforms running: ' + (lead.ad_platforms || '-'),
  ];
  const campaign = [lead.utm_source, lead.utm_medium, lead.utm_campaign]
    .filter(function (v) {
      return v;
    })
    .join(' / ');
  if (campaign) lines.push('', 'Campaign: ' + campaign);
  return lines.join('\n').slice(0, 5000);
}

/** Everything else worth keeping. The API caps this at 25 scalar keys. */
function nemrootCustomFields(lead) {
  const candidates = {
    landing_page: lead.landing_page,
    form_id: lead.form_id,
    dealership_name: lead.company,
    seats_needed: lead.seats,
    leads_per_month: lead.monthly_leads,
    ad_platforms: lead.ad_platforms,
    utm_source: lead.utm_source,
    utm_medium: lead.utm_medium,
    utm_campaign: lead.utm_campaign,
    utm_content: lead.utm_content,
    utm_term: lead.utm_term,
    gclid: lead.gclid,
    gbraid: lead.gbraid,
    wbraid: lead.wbraid,
    fbclid: lead.fbclid,
    msclkid: lead.msclkid,
    ad_id: lead.ad_id,
    ad_group_id: lead.ad_group_id,
    campaign_id: lead.campaign_id,
    placement: lead.placement,
    page_url: cleanUrl(lead.page_url),
    referrer: cleanUrl(lead.referrer),
    submitted_at: lead.submitted_at,
  };

  const out = {};
  let n = 0;
  for (const key in candidates) {
    const value = candidates[key];
    if (value === undefined || value === null || value === '') continue;
    if (n >= 25) break;
    // The API's per-value limit is undocumented; 500 is a safe ceiling.
    out[key] = String(value).slice(0, 500);
    n++;
  }
  return out;
}

function buildNemrootLead(lead, env) {
  const body = {
    customerId: env.NEMROOT_CUSTOMER_ID,
    source: nemrootSource(lead, env),
    // Our own id for this submission, already a UUID. Doubles as the
    // idempotency key, so a retry can never create a second lead.
    externalId: lead.event_id,
    message: nemrootMessage(lead),
    customFields: nemrootCustomFields(lead),
    consent: {
      tcpa: !!lead.tcpa_consent,
      capturedAt: lead.submitted_at,
      sourceUrl: cleanUrl(lead.page_url) || 'https://' + RELAY_LANDING_PAGE + '/',
    },
  };

  // The form has no email field. Leave the key out rather than send "".
  if (lead.email) body.email = lead.email.slice(0, 254);
  if (lead.first_name) body.name = lead.first_name.slice(0, 200);
  if (lead.phone) body.phone = lead.phone.length === 10 ? '+1' + lead.phone : lead.phone;
  const campaignName = lead.utm_campaign || 'Nemroot ' + lead.landing_page;
  body.campaign = { campaignName: String(campaignName).slice(0, 200) };
  // The real ad id from Meta's URL tags. utm_content is a creative number
  // ("1"), and click ids are not ad ids, so neither is used here any more.
  if (lead.ad_id) body.campaign.adId = String(lead.ad_id).slice(0, 200);

  return body;
}

async function sendToNemroot(lead, env) {
  const base = (env.NEMROOT_API_BASE || '').replace(/\/+$/, '');
  if (!base || !env.NEMROOT_PARTNER_KEY || !env.NEMROOT_CUSTOMER_ID) {
    return { attempted: false, reason: 'Nemroot API not configured' };
  }

  // Tolerates either the host on its own or the full partner base path.
  const url =
    base.indexOf('/api/v1/partner') !== -1 ? base + '/leads' : base + '/api/v1/partner/leads';
  const body = JSON.stringify(buildNemrootLead(lead, env));

  let last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Partner-Key': env.NEMROOT_PARTNER_KEY,
        },
        body: body,
        signal: AbortSignal.timeout(8000),
      });

      const text = await res.text();
      let data = {};
      try {
        data = JSON.parse(text);
      } catch (_) {
        data = {};
      }

      if (res.ok) {
        const d = data.data || {};
        return {
          attempted: true,
          ok: true,
          status: res.status,
          attempt: attempt,
          leadId: d.leadId,
          duplicate: !!d.duplicate,
          isNew: d.isNew,
          channel: d.channel,
        };
      }

      last = {
        attempted: true,
        ok: false,
        status: res.status,
        attempt: attempt,
        code: data.code,
        error: data.error,
        // Names the field that failed. Goes to the sheet and the alert email.
        details: (function (d) {
          return d ? JSON.stringify(d).slice(0, 500) : undefined;
        })(data.details || data.errors || data.issues),
      };

      // A bad key, a bad customerId or a malformed field fails the same way
      // every time. Only 5xx and rate limiting are worth another attempt.
      if (res.status < 500 && res.status !== 429) return last;
    } catch (err) {
      last = { attempted: true, ok: false, attempt: attempt, error: String(err) };
    }

    if (attempt < 3) {
      await new Promise(function (r) {
        setTimeout(r, attempt === 1 ? 500 : 2000);
      });
    }
  }
  return last;
}

async function sendToCrm(lead, env, nemroot) {
  if (!env.CRM_ENDPOINT) return { attempted: false, ok: false, reason: 'CRM_ENDPOINT not set' };

  const headers = { 'Content-Type': 'application/json' };
  if (env.CRM_AUTH_HEADER && env.CRM_AUTH_VALUE) {
    headers[env.CRM_AUTH_HEADER] = env.CRM_AUTH_VALUE;
  }

  try {
    const res = await fetch(env.CRM_ENDPOINT, {
      method: 'POST',
      headers,
      // The Apps Script logs to the sheet, so it gets the Nemroot outcome too:
      // one place to see whether a lead actually reached the CRM.
      body: JSON.stringify(nemroot ? Object.assign({}, lead, { nemroot: nemroot }) : lead),
    });
    return { attempted: true, ok: res.ok, status: res.status };
  } catch (err) {
    return { attempted: true, ok: false, error: String(err) };
  }
}

/* ===========================================================================
 * Universal Standard Lead Relay
 *
 * The shared sheet log for every Feyth client. It takes the standard payload
 * below, which is identical across clients, and routes it to this client's
 * spreadsheet on a tab chosen by ad platform.
 *
 * Client-specific meaning lives in the five custom slots. For Nemroot:
 *   1 seats needed   2 leads per month   3 ad platforms   4 unused   5 unused
 * The labels for those columns are configured once in the relay, not here.
 * ======================================================================== */

/** This client's slug in the relay registry, and this page's live domain. */
const RELAY_CLIENT = 'nemroot';
const RELAY_LANDING_PAGE = 'book.nemroot.com';

/** Short, readable form names. The long ids stay internal. */
const RELAY_FORM_NAMES = {
  hero: 'hero',
  popup: 'popup',
  bottom: 'prefooter',
};

function buildRelayPayload(lead, nemroot, turnstile) {
  return {
    client: RELAY_CLIENT,
    landing_page: RELAY_LANDING_PAGE,
    form: RELAY_FORM_NAMES[lead.form_id] || lead.form_id,
    locale: lead.locale,

    // Same value as the CRM externalId and the Meta event_id, so one lead can
    // be followed across all three systems.
    lead_id: lead.event_id,
    submitted_at: lead.submitted_at,

    full_name: lead.full_name,
    first_name: lead.first_name,
    last_name: lead.last_name,
    phone: lead.phone_formatted,
    email: lead.email,
    company: lead.company,

    custom_1: lead.seats,
    custom_2: lead.monthly_leads,
    custom_3: lead.ad_platforms,
    custom_4: '',
    custom_5: '',

    consent: !!lead.tcpa_consent,
    channel: nemrootChannel(lead),

    utm_source: lead.utm_source,
    utm_medium: lead.utm_medium,
    utm_campaign: lead.utm_campaign,
    utm_content: lead.utm_content,
    utm_term: lead.utm_term,

    gclid: lead.gclid,
    gbraid: lead.gbraid,
    wbraid: lead.wbraid,
    fbclid: lead.fbclid,
    msclkid: lead.msclkid,
    fbp: lead.fbp,
    fbc: lead.fbc,

    page_url: lead.page_url,
    referrer: lead.referrer,
    user_agent: lead.user_agent,
    ip: lead.ip,

    // What the CRM did with it, so the sheet shows delivery in one column.
    crm: {
      attempted: !!nemroot.attempted,
      ok: !!nemroot.ok,
      leadId: nemroot.leadId || '',
      summary: nemroot.ok
        ? (nemroot.duplicate ? 'DUPLICATE' : 'OK') +
          (nemroot.leadId ? ' — ' + nemroot.leadId : '') +
          (nemroot.channel ? ' (' + nemroot.channel + ')' : '')
        : nemroot.attempted
          ? 'FAILED — ' + (nemroot.code || nemroot.status || '') + ' ' + (nemroot.error || '') +
            (nemroot.details ? ' | ' + nemroot.details : '')
          : 'skipped — ' + (nemroot.reason || 'not configured'),
    },

    turnstile: turnstile.checked
      ? turnstile.ok
        ? turnstile.failOpen
          ? 'not verified (Cloudflare unreachable)'
          : 'verified'
        : 'failed — ' + (turnstile.codes || []).join(', ')
      : 'skipped — not configured',
  };
}

async function sendToRelay(lead, env, nemroot, turnstile) {
  if (!env.RELAY_URL) return { attempted: false, reason: 'RELAY_URL not set' };
  try {
    const res = await fetch(env.RELAY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildRelayPayload(lead, nemroot, turnstile)),
    });
    const text = await res.text();
    let data = {};
    try {
      data = JSON.parse(text);
    } catch (_) {}
    return { attempted: true, ok: res.ok && data.ok !== false, status: res.status, tab: data.tab, error: data.error };
  } catch (err) {
    return { attempted: true, ok: false, error: String(err) };
  }
}

async function sendToBackup(lead, env) {
  if (!env.LEAD_BACKUP_WEBHOOK) return { attempted: false };
  try {
    const res = await fetch(env.LEAD_BACKUP_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lead),
    });
    return { attempted: true, ok: res.ok };
  } catch (err) {
    return { attempted: true, ok: false, error: String(err) };
  }
}

async function sendToMetaCapi(lead, env, request) {
  // Off by default. The pixel's Event Setup Tool rule already fires Lead on
  // /thank-you/ and Meta mirrors it server-side; this event carries a
  // different id, so Meta cannot de-duplicate it and every lead counts twice.
  // Turn on only once the browser Lead sends eventID = lead.event_id.
  if (env.META_SERVER_LEAD !== 'on') return { attempted: false, reason: 'META_SERVER_LEAD off' };

  const token = env.META_CAPI_TOKEN;
  const pixelId = env.META_PIXEL_ID || PIXEL_FALLBACK;
  if (!token) return { attempted: false, reason: 'META_CAPI_TOKEN not set' };

  const { first, last } = splitName(lead.full_name);
  const phone = digits(lead.phone);
  // Only fields the lead actually gave. A hash of "" matches nobody and
  // counts against the event's match quality.
  const user_data = {
    ph: [await sha256(phone.length === 10 ? '1' + phone : phone)],
    country: [await sha256('us')],
    client_ip_address: request.headers.get('CF-Connecting-IP') || undefined,
    client_user_agent: request.headers.get('User-Agent') || undefined,
    fbp: lead.fbp || undefined,
    fbc: lead.fbc || undefined,
  };
  if (lead.email) user_data.em = [await sha256(lead.email)];
  if (first) user_data.fn = [await sha256(first.toLowerCase())];
  if (last) user_data.ln = [await sha256(last.toLowerCase())];

  const payload = {
    data: [
      {
        event_name: 'Lead',
        event_time: Math.floor(Date.now() / 1000),
        event_id: lead.event_id,
        event_source_url: lead.page_url,
        action_source: 'website',
        user_data,
        custom_data: {
          content_name: lead.form_id,
          content_category: lead.landing_page,
          lead_form: lead.form_id,
        },
      },
    ],
  };

  // Events Manager > Test Events only shows server events when this code is
  // attached. Leave META_TEST_EVENT_CODE unset in production: while it is set,
  // Meta treats the traffic as test data and it does not feed optimisation.
  if (env.META_TEST_EVENT_CODE) {
    payload.test_event_code = env.META_TEST_EVENT_CODE;
  }

  try {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${pixelId}/events?access_token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { attempted: true, ok: false, status: res.status, detail: detail.slice(0, 500) };
    }
    return { attempted: true, ok: true, status: res.status, testMode: !!env.META_TEST_EVENT_CODE };
  } catch (err) {
    return { attempted: true, ok: false, error: String(err) };
  }
}

export async function onRequestPost({ request, env, waitUntil }) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  // Honeypot: a filled hidden field means a bot. Answer 200 so it moves on.
  if (body.hp) return json({ ok: true, ignored: true });

  const turnstile = await verifyTurnstile(body.turnstile_token, env, request);
  if (turnstile.checked && !turnstile.ok) {
    if (env.TURNSTILE_ENFORCE !== 'false') {
      return json({ ok: false, error: 'failed_bot_check' }, 403);
    }
    // Monitor mode: log what would have been blocked, but let the lead through.
    console.log('NEMROOT_TURNSTILE_WOULD_BLOCK', JSON.stringify(turnstile.codes));
  }

  const errors = validate(body);
  if (errors.length) return json({ ok: false, error: 'validation', fields: errors }, 422);

  const { first, last } = splitName(body.full_name);

  const lead = {
    // Contact. The form collects a first name only.
    full_name: String(body.first_name || '').trim(),
    first_name: String(body.first_name || '').trim(),
    last_name: '',
    email: String(body.email || '').trim().toLowerCase(),
    phone: digits(body.phone),
    phone_formatted: String(body.phone || '').trim(),
    company: String(body.dealership_name || '').trim(),

    // The three qualifying questions.
    seats: String(body.seats || '').trim(),
    monthly_leads: String(body.monthly_leads || '').trim(),
    ad_platforms: String(body.ad_platforms || '').trim(),

    // No consent checkbox on this form, so nothing is claimed.
    tcpa_consent: false,

    form_id: String(body.form_source || 'unknown'),
    landing_page: RELAY_LANDING_PAGE,
    locale: 'en',
    page_url: body.page_url || '',
    referrer: body.referrer || '',
    utm_source: body.utm_source || '',
    utm_medium: body.utm_medium || '',
    utm_campaign: body.utm_campaign || '',
    utm_content: body.utm_content || '',
    utm_term: body.utm_term || '',
    gclid: body.gclid || '',
    gbraid: body.gbraid || '',
    wbraid: body.wbraid || '',
    fbclid: body.fbclid || '',
    msclkid: body.msclkid || '',
    fbp: body.fbp || '',
    // Meta's click cookie. Rebuilt from the click id when the browser had
    // none, in the format Meta documents: fb.1.<ms timestamp>.<fbclid>.
    fbc: body.fbc || (body.fbclid ? 'fb.1.' + Date.now() + '.' + body.fbclid : ''),

    // Ad, ad set, campaign and placement, read from the ad's URL tags.
    ...adIdsFromUrl(body.page_url),

    // The browser already made one, and it is the idempotency key the Partner
    // API deduplicates on. Keep it rather than minting a second.
    event_id: body.external_id || body.event_id || crypto.randomUUID(),
    submitted_at: body.submitted_at || new Date().toISOString(),
    ip: request.headers.get('CF-Connecting-IP') || '',
    user_agent: body.user_agent || request.headers.get('User-Agent') || '',
  };

  /**
   * The three deliveries used to be awaited before answering the browser, so
   * the visitor sat waiting for all of them. The CRM hop is an Apps Script web
   * app: cold start, then a spreadsheet write, then an email send, commonly
   * three to eight seconds. That was the form latency.
   *
   * They now run on waitUntil, which keeps the worker alive after the response
   * is sent. The browser hears back as soon as the lead is validated, and
   * nothing is dropped. No information is lost either: the response never
   * reported delivery to the visitor anyway, failures are logged, and the
   * Google Sheet is the durable record.
   */
  /* Nemroot first, then the sheet, so the sheet can record whether the CRM
     accepted the lead. The extra hop costs the visitor nothing: all of this
     runs after the response has already gone out. */
  const crmChain = (async function () {
    const nemroot = await sendToNemroot(lead, env);

    /* The relay logs whether the CRM accepted the lead, so it runs after.
       The legacy Apps Script keeps running while CRM_ENDPOINT still has a
       value: a transition period with both sheets filling. Clear that
       variable once the standard sheet looks right and the old one retires. */
    const relay = await sendToRelay(lead, env, nemroot, turnstile);
    const crm = await sendToCrm(lead, env, nemroot);
    return { nemroot: nemroot, relay: relay, crm: crm };
  })();

  const deliver = Promise.all([
    crmChain,
    sendToBackup(lead, env),
    sendToMetaCapi(lead, env, request),
  ]).then(function (results) {
    const nemroot = results[0].nemroot;
    const relay = results[0].relay;
    const crm = results[0].crm;
    const backup = results[1];
    const capi = results[2];

    // Cloudflare Pages > Deployment > Functions > Real-time logs.
    if (nemroot.attempted && !nemroot.ok) {
      console.log('NEMROOT_NEMROOT_FAILED', JSON.stringify({ lead: lead, nemroot: nemroot }));
    }

    // Only truly lost if neither destination took it.
    if (!nemroot.ok && !crm.ok) {
      console.log('NEMROOT_LEAD_UNDELIVERED', JSON.stringify({ lead, nemroot, crm, backup }));
    } else {
      console.log(
        'NEMROOT_LEAD',
        lead.form_id,
        lead.email,
        lead.company || '-',
        'nemroot:' + (nemroot.ok ? nemroot.leadId || 'ok' : nemroot.reason || 'failed'),
        'relay:' + (relay.ok ? relay.tab || 'ok' : relay.reason || relay.error || 'failed'),
        'sheet:' + (crm.ok ? 'ok' : crm.reason || 'failed'),
        'capi:' + (capi.ok ? 'ok' : capi.reason || 'failed')
      );
    }
    return { nemroot: nemroot, relay: relay, crm: crm, backup: backup, capi: capi };
  });

  // Debug mode, and local dev where waitUntil does not exist, wait for the
  // result so the response can report it.
  if (env.LEAD_DEBUG === 'true' || typeof waitUntil !== 'function') {
    const delivery = await deliver;
    return json({
      ok: true,
      event_id: lead.event_id,
      turnstile: turnstile,
      delivery: delivery,
      lead: env.LEAD_DEBUG === 'true' ? lead : undefined,
    });
  }

  waitUntil(deliver);

  return json({
    ok: true,
    event_id: lead.event_id,
    turnstile: turnstile,
    queued: true,
  });
}

export async function onRequestGet() {
  return json({ ok: false, error: 'method_not_allowed' }, 405);
}
