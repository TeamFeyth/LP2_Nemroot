/**
 * nemroot-lead-logs — keeps the lead function's log records.
 *
 * Pages Functions do not store logs, Workers do. The /api/lead function on
 * LP1 and LP2 posts one JSON record per request here through a service
 * binding (LEAD_LOG), and Workers Logs stores it: Cloudflare dashboard >
 * Workers & Pages > nemroot-lead-logs > Logs.
 *
 * The workers.dev URL is turned off, so only the bound Pages projects can
 * reach this Worker. It never touches a lead; it only writes the record.
 */
export default {
  async fetch(request) {
    if (request.method !== 'POST') return new Response('not found', { status: 404 });

    let entry;
    try {
      entry = await request.json();
    } catch (_) {
      return new Response('bad json', { status: 400 });
    }

    // Logged as an object so every field is searchable in the dashboard.
    const level = entry && (entry.level === 'error' || entry.level === 'warn') ? entry.level : 'log';
    console[level](entry);
    return new Response('ok');
  },
};
