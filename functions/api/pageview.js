/**
 * POST /api/pageview — Cloudflare Pages Function.
 *
 * The server copy of the browser pixel's PageView. The page generates one id
 * per view, fires fbq('track', 'PageView', {}, { eventID: id }) and posts the
 * same id here, so Meta pairs the two and counts the view once (event
 * coverage). The server copy adds what the browser cannot send reliably: the
 * real client IP, and a location estimate from Cloudflare.
 *
 * Sends nothing personal that the visitor did not already send the pixel:
 * no email, phone or name exists at this point.
 *
 * Environment variables (shared with /api/lead):
 *   META_CAPI_TOKEN        required; without it this endpoint does nothing
 *   META_PIXEL_ID          defaults to this site's pixel
 *   META_TEST_EVENT_CODE   only while checking in Events Manager > Test events
 *   META_SERVER_PAGEVIEW   "off" to stop sending server PageViews
 */

const PIXEL_FALLBACK = '2302599970275699';

const EVENT_ID = /^[A-Za-z0-9-]{8,64}$/;
// The visitor id is 32 random bytes as hex. It is sent as is, by the pixel
// (fbq init external_id) and here, so both sides hand Meta the same value.
const VISITOR_ID = /^[a-f0-9]{64}$/;
const BOT_UA = /bot|crawl|spider|slurp|lighthouse|pagespeed|headless|preview/i;

const done = (status = 204) =>
  new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });

async function sha256(value) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Meta's normalisation for location keys, hashed. Missing values are left out. */
async function geoUserData(cf) {
  const out = {};
  if (!cf) return out;
  const city = String(cf.city || '').toLowerCase().replace(/[^a-z]/g, '');
  const state = String(cf.regionCode || '').toLowerCase().replace(/[^a-z]/g, '');
  const country = String(cf.country || '').toLowerCase().replace(/[^a-z]/g, '');
  let zip = String(cf.postalCode || '').toLowerCase().replace(/\s/g, '');
  if (country === 'us') zip = zip.slice(0, 5);
  if (city) out.ct = [await sha256(city)];
  if (state && state.length === 2) out.st = [await sha256(state)];
  if (zip) out.zp = [await sha256(zip)];
  if (country && country.length === 2) out.country = [await sha256(country)];
  return out;
}

function cookieValue(v) {
  const s = String(v || '');
  return /^fb\.\d\.\d+\.[\w.-]+$/.test(s) && s.length < 300 ? s : undefined;
}

export async function onRequestPost({ request, env, waitUntil }) {
  if (env.META_SERVER_PAGEVIEW === 'off') return done();
  const token = env.META_CAPI_TOKEN;
  if (!token) return done();

  const host = new URL(request.url).host;
  const origin = request.headers.get('Origin');
  if (origin) {
    try {
      if (new URL(origin).host !== host) return done(403);
    } catch (_) {
      return done(403);
    }
  }

  let body;
  try {
    body = JSON.parse(await request.text());
  } catch (_) {
    return done(400);
  }
  if (!body || !EVENT_ID.test(String(body.event_id || ''))) return done(400);

  let pageUrl;
  try {
    pageUrl = new URL(String(body.page_url || ''));
  } catch (_) {
    return done(400);
  }
  if (pageUrl.host !== host) return done(400);

  const ua = request.headers.get('User-Agent') || '';
  if (!ua || BOT_UA.test(ua)) return done();

  const user_data = {
    client_ip_address: request.headers.get('CF-Connecting-IP') || undefined,
    client_user_agent: ua,
    fbp: cookieValue(body.fbp),
    fbc: cookieValue(body.fbc),
    ...(await geoUserData(request.cf)),
  };
  if (VISITOR_ID.test(String(body.visitor_id || ''))) user_data.external_id = [body.visitor_id];

  const payload = {
    data: [
      {
        event_name: 'PageView',
        event_time: Math.floor(Date.now() / 1000),
        event_id: body.event_id,
        event_source_url: pageUrl.origin + pageUrl.pathname + pageUrl.search,
        action_source: 'website',
        user_data,
      },
    ],
  };
  if (env.META_TEST_EVENT_CODE) payload.test_event_code = env.META_TEST_EVENT_CODE;

  const pixelId = env.META_PIXEL_ID || PIXEL_FALLBACK;
  const send = fetch(
    `https://graph.facebook.com/v21.0/${pixelId}/events?access_token=${encodeURIComponent(token)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }
  )
    .then(async (res) => {
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        console.log('PAGEVIEW_CAPI_FAILED', res.status, detail.slice(0, 300));
      }
    })
    .catch((err) => console.log('PAGEVIEW_CAPI_FAILED', String(err)));

  if (typeof waitUntil === 'function') waitUntil(send);
  else await send;
  return done();
}

export function onRequestGet() {
  return done(405);
}
