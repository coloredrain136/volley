// Push subscriptions. POST /api/push { action: 'subscribe' | 'unsubscribe' | 'test', ... }
const { sb, q, nowIso, checkAuth, sendError, fail, notify, pushReady } = require('./_lib/core');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'post_only' });
  try {
    const me = checkAuth(req);
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (b.action === 'subscribe') {
      const s = b.subscription || {};
      if (!s.endpoint || !s.keys || !s.keys.p256dh || !s.keys.auth) fail(400, 'bad_subscription');
      await sb('volley_push_subs', {
        method: 'POST', prefer: 'resolution=merge-duplicates',
        body: { endpoint: s.endpoint, player: me, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth }, created_at: nowIso() },
      });
      return res.json({ ok: true });
    }
    if (b.action === 'unsubscribe') {
      if (b.endpoint) await sb(`volley_push_subs?endpoint=eq.${q(b.endpoint)}`, { method: 'DELETE' });
      return res.json({ ok: true });
    }
    if (b.action === 'test') {
      if (!pushReady()) fail(500, 'push_not_configured');
      const r = await notify(me, { title: 'Volley', body: 'Notifications are working 🎉', tag: 'test', url: '/' });
      return res.json(r);
    }
    fail(400, 'unknown_action');
  } catch (e) { sendError(res, e); }
};
