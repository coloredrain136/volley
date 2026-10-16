// Shared server helpers for Volley. Files in api/_lib are not public endpoints.
const webpush = require('web-push');

const SUPA_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPA_KEY = process.env.SUPABASE_SECRET_KEY || '';
const PASSCODE = process.env.VOLLEY_PASSCODE || '';
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:volley@example.com';

let pushReady = false;
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  try { webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE); pushReady = true; }
  catch (e) { console.error('VAPID setup failed:', e.message); }
}

const APP_VERSION = 'volley-9'; // must match VERSION in index.html

const configured = () => !!(SUPA_URL && SUPA_KEY && PASSCODE);

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };

// ---- Supabase REST ----
function headers(extra) {
  const h = { apikey: SUPA_KEY, 'Content-Type': 'application/json', ...extra };
  // New sb_secret_ keys go in apikey only. Legacy service_role JWTs also need Authorization.
  if (!SUPA_KEY.startsWith('sb_')) h.Authorization = 'Bearer ' + SUPA_KEY;
  return h;
}
async function sb(path, { method = 'GET', body, prefer } = {}) {
  const h = headers(prefer ? { Prefer: prefer } : {});
  const r = await fetch(`${SUPA_URL}/rest/v1/${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const msg = (data && (data.message || data.error)) || `Supabase ${r.status}`;
    const err = new HttpError(r.status === 409 ? 409 : 502, msg);
    err.code = data && data.code;
    throw err;
  }
  return data;
}
const q = (v) => encodeURIComponent(v);
const nowIso = () => new Date().toISOString();
const other = (p) => (p === 'a' ? 'b' : 'a');

// ---- Players ----
async function getPlayers() {
  const rows = await sb('volley_settings?key=in.(player_a,player_b)&select=key,value');
  const out = { a: null, b: null };
  for (const r of rows || []) out[r.key.slice(-1)] = r.value;
  return out;
}
const nameOf = (players, p) => (players[p] && players[p].name) || (p === 'a' ? 'Player 1' : 'Player 2');

const GAME_NAMES = { checkers: 'Checkers', chess: 'Chess', golf: 'Mini Golf', pool: '8-Ball' };
const gameName = (t) => GAME_NAMES[t] || 'a game';

// ---- Push ----
async function badgeFor(player) {
  try {
    const rows = await sb(`volley_games?status=in.(invited,active)&turn=eq.${player}&select=id`);
    return (rows || []).length;
  } catch { return undefined; }
}
async function notify(player, payload) {
  if (!pushReady) return { sent: 0, reason: 'push_not_configured' };
  let subs = [];
  try { subs = await sb(`volley_push_subs?player=eq.${player}&select=endpoint,keys`); } catch (e) { return { sent: 0, reason: e.message }; }
  if (!subs || !subs.length) return { sent: 0, reason: 'no_subscriptions' };
  const badge = await badgeFor(player);
  const body = JSON.stringify({ ...payload, badge });
  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body, { TTL: 60 * 60 * 24, urgency: 'high' });
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        try { await sb(`volley_push_subs?endpoint=eq.${q(s.endpoint)}`, { method: 'DELETE' }); } catch {}
      } else console.error('push failed', e.statusCode, e.body || e.message);
    }
  }));
  return { sent };
}
// Never let a push problem break a move or a message
const notifySafe = (player, payload) => notify(player, payload).catch((e) => console.error('notify', e.message));

// ---- Turn timers ----
const WARN_HOURS = 3;
function deadlineFrom(options) {
  const h = Number(options && options.timer) || 0;
  return h > 0 ? new Date(Date.now() + h * 3600e3).toISOString() : null;
}

async function sweep() {
  const now = nowIso();
  const players = await getPlayers();
  let forfeits = 0, warnings = 0;

  const expired = await sb(`volley_games?status=eq.active&turn_deadline=lt.${q(now)}&select=id,type,turn`);
  for (const g of expired || []) {
    if (!g.turn) continue;
    const winner = other(g.turn);
    const upd = await sb(`volley_games?id=eq.${g.id}&status=eq.active&turn=eq.${g.turn}`, {
      method: 'PATCH', prefer: 'return=representation',
      body: { status: 'finished', winner, end_reason: 'timeout', turn: null, turn_deadline: null, finished_at: now, updated_at: now },
    });
    if (upd && upd.length) {
      forfeits++;
      const url = `/?g=${g.id}`;
      await notifySafe(g.turn, { title: 'Time ran out', body: `Your ${gameName(g.type)} timer ran out, so ${nameOf(players, winner)} wins.`, tag: 'g-' + g.id, url });
      await notifySafe(winner, { title: 'You win!', body: `${nameOf(players, g.turn)}'s timer ran out in ${gameName(g.type)}.`, tag: 'g-' + g.id, url });
    }
  }

  const soon = new Date(Date.now() + WARN_HOURS * 3600e3).toISOString();
  const warn = await sb(`volley_games?status=eq.active&warned_at=is.null&turn_deadline=lt.${q(soon)}&select=id,type,turn,turn_deadline`);
  for (const g of warn || []) {
    if (!g.turn) continue;
    const upd = await sb(`volley_games?id=eq.${g.id}&warned_at=is.null`, { method: 'PATCH', prefer: 'return=representation', body: { warned_at: now } });
    if (upd && upd.length) {
      warnings++;
      const hrs = Math.max(1, Math.round((new Date(g.turn_deadline) - Date.now()) / 3600e3));
      await notifySafe(g.turn, { title: 'Timer running out', body: `About ${hrs} hour${hrs === 1 ? '' : 's'} left on your ${gameName(g.type)} turn.`, tag: 'g-' + g.id, url: `/?g=${g.id}` });
    }
  }
  return { forfeits, warnings };
}

let lastSweep = 0;
async function maybeSweep() {
  if (Date.now() - lastSweep < 60e3) return;
  lastSweep = Date.now();
  try { await sweep(); } catch (e) { console.error('sweep', e.message); }
}

// ---- Request helpers ----
function checkAuth(req, { needPlayer = true } = {}) {
  if (!configured()) fail(500, 'not_configured');
  if ((req.headers['x-volley-key'] || '') !== PASSCODE) fail(401, 'bad_passcode');
  const me = req.headers['x-volley-player'];
  if (needPlayer && me !== 'a' && me !== 'b') fail(400, 'no_player');
  return me;
}
function sendError(res, e) {
  const status = e.status || 500;
  if (status >= 500) console.error(e);
  res.status(status).json({ error: e.message || 'server_error' });
}

module.exports = {
  sb, q, nowIso, other, getPlayers, nameOf, gameName, notify, notifySafe,
  deadlineFrom, sweep, maybeSweep, checkAuth, sendError, fail, HttpError,
  VAPID_PUBLIC, pushReady: () => pushReady, APP_VERSION,
};
