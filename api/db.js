// Volley data endpoint. Every call: POST /api/db  { action, ...fields }
// Headers: x-volley-key (passcode), x-volley-player ('a' or 'b')
const {
  sb, q, nowIso, other, getPlayers, nameOf, gameName, notifySafe,
  deadlineFrom, maybeSweep, checkAuth, sendError, fail, VAPID_PUBLIC, pushReady,
} = require('./_lib/core');

const TYPES = ['checkers']; // chess and golf get added in later builds
const TIMERS = [0, 24, 72];

const GAME_COLS = 'id,type,status,options,turn,state,ply,winner,end_reason,turn_deadline,nudged_at,rematch_of,created_by,created_at,updated_at,last_move_at,finished_at';

async function getGame(id) {
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) fail(400, 'bad_id');
  const rows = await sb(`volley_games?id=eq.${id}&select=${GAME_COLS}`);
  if (!rows || !rows.length) fail(404, 'game_not_found');
  return rows[0];
}
async function patchGame(id, body, filter = '') {
  const rows = await sb(`volley_games?id=eq.${id}${filter}&select=${GAME_COLS}`, {
    method: 'PATCH', prefer: 'return=representation', body: { ...body, updated_at: nowIso() },
  });
  if (!rows || !rows.length) fail(409, 'game_changed');
  return rows[0];
}
const urlFor = (g) => `/?g=${g.id}`;
async function cancelPending(gameId) {
  await sb(`volley_requests?game_id=eq.${gameId}&status=eq.pending`, { method: 'PATCH', body: { status: 'cancelled', resolved_at: nowIso() } });
}
function resultText(g, players, forPlayer) {
  if (g.winner === 'draw') return `${gameName(g.type)} ended in a draw.`;
  const won = g.winner === forPlayer;
  const why = g.end_reason === 'resign' ? (won ? `${nameOf(players, other(forPlayer))} resigned` : 'You resigned')
    : g.end_reason === 'timeout' ? (won ? `${nameOf(players, other(forPlayer))}'s timer ran out` : 'Your timer ran out') : '';
  return won ? `You won ${gameName(g.type)}!${why ? ' ' + why + '.' : ''}` : `${nameOf(players, g.winner)} won ${gameName(g.type)}.${why ? ' ' + why + '.' : ''}`;
}

const handlers = {
  // Used by the lock screen: checks the passcode, returns who's set up
  async hello() {
    return { players: await getPlayers(), vapid: VAPID_PUBLIC, push: pushReady() };
  },

  async set_player(b, me, ctx) {
    const slot = b.slot === 'a' || b.slot === 'b' ? b.slot : me;
    if (slot !== 'a' && slot !== 'b') fail(400, 'bad_slot');
    const name = String(b.name || '').trim().slice(0, 24);
    const emoji = String(b.emoji || '').trim().slice(0, 16);
    if (!name) fail(400, 'name_required');
    await sb('volley_settings', {
      method: 'POST', prefer: 'resolution=merge-duplicates',
      body: { key: 'player_' + slot, value: { name, emoji: emoji || '🙂' }, updated_at: nowIso() },
    });
    return { players: await getPlayers() };
  },

  async list(b, me, ctx) {
    const [players, games, unreadRows, reqs] = await Promise.all([
      getPlayers(),
      sb(`volley_games?status=in.(invited,active,finished)&order=updated_at.desc&limit=500&select=${GAME_COLS}`),
      sb(`volley_messages?read_at=is.null&player=eq.${other(me)}&select=game_id`),
      sb(`volley_requests?status=eq.pending&select=id,game_id,kind,from_player,created_at`),
    ]);
    const unread = {};
    for (const r of unreadRows || []) unread[r.game_id] = (unread[r.game_id] || 0) + 1;
    return { players, games: games || [], unread, requests: reqs || [], vapid: VAPID_PUBLIC, push: pushReady(), now: nowIso() };
  },

  async game(b) {
    const g = await getGame(b.id);
    const [moves, messages, requests] = await Promise.all([
      sb(`volley_moves?game_id=eq.${g.id}&order=ply.asc&select=ply,player,move,state_before,created_at`),
      sb(`volley_messages?game_id=eq.${g.id}&order=id.desc&limit=300&select=id,player,body,created_at,read_at`),
      sb(`volley_requests?game_id=eq.${g.id}&status=eq.pending&select=id,kind,from_player,created_at`),
    ]);
    return { game: g, moves: moves || [], messages: (messages || []).reverse(), requests: requests || [], now: nowIso() };
  },

  async create(b, me, ctx) {
    if (!TYPES.includes(b.type)) fail(400, 'bad_type');
    const o = b.options || {};
    const options = { timer: TIMERS.includes(Number(o.timer)) ? Number(o.timer) : 0, hints: !!o.hints };
    const rows = await sb(`volley_games?select=${GAME_COLS}`, {
      method: 'POST', prefer: 'return=representation',
      body: { type: b.type, status: 'invited', options, turn: other(me), created_by: me },
    });
    const g = rows[0];
    const players = await getPlayers();
    ctx.later.push(notifySafe(other(me), { title: 'New game invite', body: `${nameOf(players, me)} wants to play ${gameName(g.type)}.`, tag: 'g-' + g.id, url: urlFor(g) }));
    return { game: g };
  },

  async respond(b, me, ctx) {
    const g = await getGame(b.id);
    if (g.status !== 'invited') fail(409, 'not_an_invite');
    if (g.created_by === me) fail(403, 'not_your_invite');
    const players = await getPlayers();
    if (!b.accept) {
      await patchGame(g.id, { status: 'declined', turn: null }, '&status=eq.invited');
      return { ok: true };
    }
    if (!b.state || (b.turn !== 'a' && b.turn !== 'b')) fail(400, 'state_required');
    const options = { ...g.options, hints: !!(g.options.hints && b.hints) };
    const now = nowIso();
    const ng = await patchGame(g.id, {
      status: 'active', options, state: b.state, turn: b.turn, ply: 0,
      last_move_at: now, turn_deadline: deadlineFrom(options), warned_at: null,
    }, '&status=eq.invited');
    const starter = b.turn === g.created_by ? ' Your move first.' : '';
    ctx.later.push(notifySafe(g.created_by, { title: 'Invite accepted', body: `${nameOf(players, me)} accepted ${gameName(g.type)}.${starter}`, tag: 'g-' + g.id, url: urlFor(g) }));
    return { game: ng };
  },

  async cancel(b, me, ctx) {
    const g = await getGame(b.id);
    if (g.status !== 'invited' || g.created_by !== me) fail(409, 'cannot_cancel');
    await patchGame(g.id, { status: 'declined', turn: null }, '&status=eq.invited');
    return { ok: true };
  },

  async move(b, me, ctx) {
    const g = await getGame(b.id);
    if (g.status !== 'active') fail(409, 'game_not_active');
    if (g.turn !== me) fail(409, 'not_your_turn');
    if (Number(b.ply) !== g.ply) fail(409, 'game_changed');
    if (!b.move || !b.state) fail(400, 'move_required');
    // The unique (game_id, ply) key makes a double-submit fail here instead of making two moves
    try {
      await sb('volley_moves', { method: 'POST', body: { game_id: g.id, ply: g.ply, player: me, move: b.move, state_before: g.state } });
    } catch (e) { if (e.status === 409) fail(409, 'game_changed'); throw e; }

    const now = nowIso();
    const r = b.result;
    const patch = { state: b.state, ply: g.ply + 1, last_move_at: now, warned_at: null };
    if (r && (r.winner === 'a' || r.winner === 'b' || r.winner === 'draw')) {
      Object.assign(patch, { status: 'finished', winner: r.winner, end_reason: r.winner === 'draw' ? 'draw' : 'win', turn: null, turn_deadline: null, finished_at: now });
    } else {
      Object.assign(patch, { turn: other(me), turn_deadline: deadlineFrom(g.options) });
    }
    let ng;
    try { ng = await patchGame(g.id, patch, `&ply=eq.${g.ply}&turn=eq.${me}`); }
    catch (e) {
      await sb(`volley_moves?game_id=eq.${g.id}&ply=eq.${g.ply}`, { method: 'DELETE' }).catch(() => {});
      throw e;
    }
    await cancelPending(g.id);
    const players = await getPlayers();
    if (ng.status === 'finished') {
      ctx.later.push(notifySafe(other(me), { title: 'Game over', body: resultText(ng, players, other(me)), tag: 'g-' + g.id, url: urlFor(g) }));
    } else {
      ctx.later.push(notifySafe(other(me), { title: 'Your turn', body: `${nameOf(players, me)} moved in ${gameName(g.type)}.`, tag: 'g-' + g.id, url: urlFor(g) }));
    }
    return { game: ng };
  },

  async request(b, me, ctx) {
    const g = await getGame(b.id);
    if (g.status !== 'active') fail(409, 'game_not_active');
    if (b.kind !== 'undo' && b.kind !== 'draw') fail(400, 'bad_kind');
    const pending = await sb(`volley_requests?game_id=eq.${g.id}&status=eq.pending&select=id,kind,from_player`);
    if ((pending || []).length) fail(409, 'request_pending');
    if (b.kind === 'undo') {
      if (g.turn === me || g.ply < 1) fail(409, 'nothing_to_undo');
      const last = await sb(`volley_moves?game_id=eq.${g.id}&order=ply.desc&limit=1&select=player,ply`);
      if (!last.length || last[0].player !== me) fail(409, 'nothing_to_undo');
    }
    const rows = await sb('volley_requests?select=id,kind,from_player,created_at', {
      method: 'POST', prefer: 'return=representation', body: { game_id: g.id, kind: b.kind, from_player: me },
    });
    const players = await getPlayers();
    const body = b.kind === 'undo' ? `${nameOf(players, me)} wants to take back their last move.` : `${nameOf(players, me)} offered a draw in ${gameName(g.type)}.`;
    ctx.later.push(notifySafe(other(me), { title: b.kind === 'undo' ? 'Undo request' : 'Draw offer', body, tag: 'g-' + g.id, url: urlFor(g) }));
    return { request: rows[0] };
  },

  async answer(b, me, ctx) {
    const id = Number(b.request_id);
    const rows = await sb(`volley_requests?id=eq.${id}&select=id,game_id,kind,from_player,status`);
    const r = rows && rows[0];
    if (!r || r.status !== 'pending') fail(409, 'request_gone');
    if (r.from_player === me) fail(403, 'not_yours_to_answer');
    const g = await getGame(r.game_id);
    const players = await getPlayers();
    const close = (status) => sb(`volley_requests?id=eq.${id}&status=eq.pending`, { method: 'PATCH', body: { status, resolved_at: nowIso() } });
    if (!b.accept || g.status !== 'active') {
      await close('denied');
      ctx.later.push(notifySafe(r.from_player, { title: r.kind === 'undo' ? 'Undo denied' : 'Draw declined', body: `${nameOf(players, me)} said no.`, tag: 'g-' + g.id, url: urlFor(g) }));
      return { game: g };
    }
    let ng;
    if (r.kind === 'undo') {
      const last = await sb(`volley_moves?game_id=eq.${g.id}&order=ply.desc&limit=1&select=ply,player,state_before`);
      const m = last && last[0];
      if (!m || m.player !== r.from_player || m.ply !== g.ply - 1 || g.turn === r.from_player) { await close('cancelled'); fail(409, 'nothing_to_undo'); }
      ng = await patchGame(g.id, {
        state: m.state_before, ply: m.ply, turn: r.from_player,
        turn_deadline: deadlineFrom(g.options), warned_at: null, last_move_at: nowIso(),
      }, `&ply=eq.${g.ply}`);
      await sb(`volley_moves?game_id=eq.${g.id}&ply=eq.${m.ply}`, { method: 'DELETE' });
      await close('accepted');
      ctx.later.push(notifySafe(r.from_player, { title: 'Undo allowed', body: `${nameOf(players, me)} let you take it back. Your move.`, tag: 'g-' + g.id, url: urlFor(g) }));
    } else {
      const now = nowIso();
      ng = await patchGame(g.id, { status: 'finished', winner: 'draw', end_reason: 'draw', turn: null, turn_deadline: null, finished_at: now }, '&status=eq.active');
      await close('accepted');
      ctx.later.push(notifySafe(r.from_player, { title: 'Draw accepted', body: `${gameName(g.type)} with ${nameOf(players, me)} ended in a draw.`, tag: 'g-' + g.id, url: urlFor(g) }));
    }
    return { game: ng };
  },

  async cancel_request(b, me, ctx) {
    await sb(`volley_requests?id=eq.${Number(b.request_id)}&from_player=eq.${me}&status=eq.pending`, { method: 'PATCH', body: { status: 'cancelled', resolved_at: nowIso() } });
    return { ok: true };
  },

  async resign(b, me, ctx) {
    const g = await getGame(b.id);
    if (g.status !== 'active') fail(409, 'game_not_active');
    const ng = await patchGame(g.id, { status: 'finished', winner: other(me), end_reason: 'resign', turn: null, turn_deadline: null, finished_at: nowIso() }, '&status=eq.active');
    await cancelPending(g.id);
    const players = await getPlayers();
    ctx.later.push(notifySafe(other(me), { title: 'You win!', body: `${nameOf(players, me)} resigned ${gameName(g.type)}.`, tag: 'g-' + g.id, url: urlFor(g) }));
    return { game: ng };
  },

  async nudge(b, me, ctx) {
    const g = await getGame(b.id);
    const waitingOn = g.status === 'active' ? g.turn : g.status === 'invited' ? other(g.created_by) : null;
    if (!waitingOn || waitingOn === me) fail(409, 'nothing_to_nudge');
    if (g.nudged_at && Date.now() - new Date(g.nudged_at) < 3600e3) fail(429, 'nudged_recently');
    const ng = await patchGame(g.id, { nudged_at: nowIso() });
    const players = await getPlayers();
    const what = g.status === 'invited' ? `your ${gameName(g.type)} invite` : `your ${gameName(g.type)} move`;
    ctx.later.push(notifySafe(other(me), { title: `👋 ${nameOf(players, me)} nudged you`, body: `They're waiting on ${what}.`, tag: 'n-' + g.id, url: urlFor(g) }));
    return { game: ng };
  },

  async chat(b, me, ctx) {
    const g = await getGame(b.id);
    const body = String(b.body || '').trim().slice(0, 1000);
    if (!body) fail(400, 'empty');
    const rows = await sb('volley_messages?select=id,player,body,created_at,read_at', {
      method: 'POST', prefer: 'return=representation', body: { game_id: g.id, player: me, body },
    });
    const players = await getPlayers();
    const p = players[me] || {};
    ctx.later.push(notifySafe(other(me), { title: `${p.emoji ? p.emoji + ' ' : ''}${nameOf(players, me)} · ${gameName(g.type)}`, body: body.length > 140 ? body.slice(0, 137) + '…' : body, tag: 'c-' + g.id, url: urlFor(g) + '&chat=1' }));
    return { message: rows[0] };
  },

  async read(b, me, ctx) {
    await sb(`volley_messages?game_id=eq.${q(b.id)}&player=eq.${other(me)}&read_at=is.null`, { method: 'PATCH', body: { read_at: nowIso() } });
    return { ok: true };
  },

  async rematch(b, me, ctx) {
    const g = await getGame(b.id);
    if (g.status !== 'finished') fail(409, 'not_finished');
    const existing = await sb(`volley_games?rematch_of=eq.${g.id}&status=in.(invited,active,finished)&select=${GAME_COLS}&limit=1`);
    if (existing && existing.length) return { game: existing[0], existing: true };
    const options = { timer: g.options.timer || 0, hints: !!g.options.hints };
    // Swap sides from last game so you take turns going first
    if (g.state && g.state.colors) {
      const c = g.state.colors; options.colors = { a: c.b, b: c.a };
    }
    const rows = await sb(`volley_games?select=${GAME_COLS}`, {
      method: 'POST', prefer: 'return=representation',
      body: { type: g.type, status: 'invited', options, turn: other(me), created_by: me, rematch_of: g.id },
    });
    const ng = rows[0];
    const players = await getPlayers();
    ctx.later.push(notifySafe(other(me), { title: 'Rematch?', body: `${nameOf(players, me)} wants a ${gameName(g.type)} rematch.`, tag: 'g-' + ng.id, url: urlFor(ng) }));
    return { game: ng };
  },
};

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'post_only' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = body.action;
    const open = action === 'hello' || action === 'set_player';
    const me = checkAuth(req, { needPlayer: !open });
    const fn = handlers[action];
    if (!fn) fail(400, 'unknown_action');
    await maybeSweep();
    const ctx = { later: [] };
    const out = await fn(body, me, ctx);
    await Promise.all(ctx.later); // finish sending pushes before the function freezes
    res.status(200).json(out);
  } catch (e) { sendError(res, e); }
};
