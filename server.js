// Mesa Card Club: accounts, tables (rooms) and live game state. No dependencies, Node 18+.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GAMES = { tongits: require('./games/tongits'), poker: require('./games/poker'), blackjack: require('./games/blackjack') };
const BETS = [10, 50, 100];
const BOT_NAMES = ['Bot Ana', 'Bot Ben', 'Bot Carla', 'Bot Dodong', 'Bot Ella', 'Bot Fely'];
const PORT = process.env.PORT || 3000;
const NEXT_ROUND_MS = 4500; // pause between rounds before the next deal
const DB = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'users.json');
const PUBLIC = path.join(__dirname, 'public');

fs.mkdirSync(path.dirname(DB), { recursive: true });
// Secret admin panel (/admin). The key comes from ADMIN_KEY, or is generated once into data/admin-key.txt.
const KEY_FILE = path.join(path.dirname(DB), 'admin-key.txt');
const ADMIN_LOG = path.join(path.dirname(DB), 'admin-log.jsonl');
const ADMIN_KEY = process.env.ADMIN_KEY || (fs.existsSync(KEY_FILE) ? fs.readFileSync(KEY_FILE, 'utf8').trim()
  : (() => { const k = crypto.randomBytes(16).toString('hex'); fs.writeFileSync(KEY_FILE, k); return k; })());
let adminFails = { n: 0, until: 0 };

// ---------- saved data: accounts, logins, admin history ----------
// Locally: data/users.json. On a host without a disk (Render free), set UPSTASH_REDIS_REST_URL and
// UPSTASH_REDIS_REST_TOKEN and everything is also kept in a free Upstash Redis database.
// shortcut: everything is one JSON value; fine for a few thousand players, move to real tables beyond that.
const users = {};
const sessions = new Map(); // token -> email
let adminEntries = []; // admin coin changes, oldest first
const KV_URL = process.env.UPSTASH_REDIS_REST_URL, KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN, KV_KEY = 'mesa:data';
async function kv(command) {
  const r = await fetch(KV_URL, { method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`Upstash ${r.status}: ${j.error || 'request failed'}`);
  return j.result;
}
let pushTimer = null, pushing = Promise.resolve();
function save() {
  fs.writeFileSync(DB + '.tmp', JSON.stringify(users, null, 1));
  fs.renameSync(DB + '.tmp', DB);
  if (KV_URL) { clearTimeout(pushTimer); pushTimer = setTimeout(flush, 300); } // many quick changes -> one upload
}
function flush() {
  clearTimeout(pushTimer);
  pushTimer = null;
  const data = JSON.stringify({ users, sessions: [...sessions], adminLog: adminEntries.slice(-200) });
  pushing = pushing.then(() => kv(['SET', KV_KEY, data])).catch(e => {
    console.error('Cloud save failed, retrying in 5s:', e.message); // keep the data in memory and try again
    pushTimer = setTimeout(flush, 5000);
  });
  return pushing;
}
async function loadData() {
  let saved = null;
  if (KV_URL) {
    // If the database can't be reached we stop here (Render restarts us) instead of starting empty
    // and then overwriting everyone's saved accounts.
    const raw = await kv(['GET', KV_KEY]);
    saved = raw ? JSON.parse(raw) : null;
    console.log(saved ? `Loaded ${Object.keys(saved.users).length} accounts from the cloud database` : 'Cloud database is empty: starting fresh');
  }
  if (!saved) saved = {
    users: fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB, 'utf8')) : {},
    adminLog: fs.existsSync(ADMIN_LOG) ? fs.readFileSync(ADMIN_LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [],
  };
  Object.assign(users, saved.users);
  for (const [t, e] of saved.sessions || []) if (users[e]) sessions.set(t, e);
  adminEntries = saved.adminLog || [];
  // Coins held for a round that was still running when the server stopped go back to their owner.
  for (const u of Object.values(users)) if (u.held) { u.chips += u.held; u.held = 0; }
  save();
  if (KV_URL) await flush(); // store the refunds right away
}
const rooms = new Map(); // code -> room
const userRoom = new Map(); // email -> code
const clients = new Map(); // email -> Set of open event streams

const fail = (status, message) => Object.assign(new Error(message), { status });
const hash = (pw, salt) => crypto.scryptSync(String(pw), salt, 32);
// Coins shown to players include coins held on the table for the current round.
const total = u => u.chips + (u.held || 0);
const publicUser = u => ({ email: u.email, name: u.name, chips: total(u), bonusAt: u.bonusAt, avatar: u.avatar || null });
const AVATARS = ['🐱', '🐶', '🦊', '🐼', '🐸', '🐵', '🦁', '🐯', '🐨', '🐰', '🐙', '🦄', '🐲', '🐧', '😎', '🤠'];
const humans = r => r.seats.filter(s => s.id && !s.left);
// Simple throttles: failed logins per email, chat messages per player.
const loginFails = new Map(); // email -> { n, until }
const lastChat = new Map(); // email -> ms
const active = r => r.state && !r.state.result;
function newSession(email) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, email);
  save(); // logins are saved too, so players stay logged in after the server sleeps
  return { token, user: publicUser(users[email]) };
}

// ---------- live updates (Server-Sent Events) ----------
function roomView(r, email) {
  const seat = r.seats.findIndex(s => s.id === email && !s.left), g = GAMES[r.game];
  return {
    code: r.code, game: r.game, bet: r.bet, tableBet: g.tableBet !== false, min: g.min, max: g.max, minChips: g.minChips(r.bet),
    isHost: r.host === email, hostSeat: r.seats.findIndex(s => s.id === r.host),
    seats: r.seats.map(s => ({ name: s.name, bot: !!(s.bot || s.left), chips: s.id ? total(users[s.id]) : null, avatar: s.id ? users[s.id].avatar || null : null })),
    mySeat: seat, chat: r.chat, turnEndsIn: r.deadline ? r.deadline - Date.now() : null,
    state: r.state && g.view(r.state, seat),
  };
}
function sendTo(email) {
  const set = clients.get(email);
  if (!set?.size) return;
  const r = rooms.get(userRoom.get(email));
  const data = `data: ${JSON.stringify({ me: publicUser(users[email]), room: r ? roomView(r, email) : null })}\n\n`;
  set.forEach(res => res.write(data));
}
const push = r => r.seats.forEach(s => s.id && !s.left && sendTo(s.id));

// ---------- game loop: bots, turn timer, payouts ----------
function update(r) {
  if (r.state?.result && !r.paid) {
    r.paid = true;
    // Release each player's held stake plus their win/loss (a loss never exceeds the stake).
    r.state.result.deltas.forEach((d, i) => {
      const s = r.seats[i], u = s.id && users[s.id];
      if (!u) return;
      u.held -= s.stake;
      u.chips += s.stake + d;
      s.stake = 0;
    });
    save();
    r.seats.forEach(s => s.left && sendTo(s.id));
    if (!humans(r).length) { rooms.delete(r.code); return; } // everyone left: the round was finished by bots
    // Keep playing: deal the next round by itself after a short pause to see the cards.
    const finished = r.state;
    clearTimeout(r.nextTimer);
    r.nextTimer = setTimeout(() => {
      if (r.state !== finished || rooms.get(r.code) !== r) return; // host already dealt, changed players, or table closed
      try { startRound(r); } catch (e) { chat(r, '•', `${e.message}. The host can deal again when ready.`); push(r); }
    }, NEXT_ROUND_MS);
  }
  schedule(r);
  push(r);
}
function schedule(r) {
  clearTimeout(r.timer);
  r.deadline = null;
  const g = GAMES[r.game], s = r.state;
  if (!s || s.result) return;
  const seat = g.turn(s);
  if (seat == null) return;
  const auto = r.seats[seat].bot || r.seats[seat].left;
  // Bots take a relaxed ~2s per move, and wait for the deal animation to finish first.
  // Humans get 30s, then the move is made for them.
  const ms = auto ? Math.max(2000, (r.dealtAt || 0) + 4500 - Date.now()) : 30000;
  if (!auto) r.deadline = Date.now() + ms;
  r.timer = setTimeout(() => {
    try { g.act(s, seat, (auto ? g.botAct : g.timeoutAct)(s, seat)); }
    catch (e) {
      // Never leave a table frozen: fall back to the safest move.
      console.error('auto move failed, trying the safe move', r.code, e);
      try { g.act(s, seat, g.timeoutAct(s, seat)); } catch (e2) { console.error('safe move failed too', r.code, e2); return; }
    }
    update(r);
  }, ms);
}
const EMOTES = ['😂', '😎', '😭', '🔥', '👏', '😡', '🙏', '🤑'];
function chat(r, name, text, seat) {
  r.chatId = (r.chatId || 0) + 1;
  r.chat.push({ id: r.chatId, name, text, seat });
  r.chat = r.chat.slice(-40);
}
// Between rounds only: drop seats of players who left, and clear the old result (seat numbers change).
function tidy(r) { r.seats = r.seats.filter(s => !s.left); r.state = null; }

// Deal a new round (host's Start / Deal now, or automatically after the last round).
function startRound(r) {
  const g = GAMES[r.game];
  clearTimeout(r.nextTimer);
  tidy(r);
  // No automatic bots: the table plays with whoever is seated (the host can still press "Add bot").
  if (r.seats.length < g.min) throw fail(400, `Need at least ${g.min} players. Share the code with a friend or add a bot.`);
  const poor = r.seats.filter(s => s.id && users[s.id].chips < g.minChips(r.bet));
  if (poor.length) throw fail(400, `${poor.map(s => s.name).join(', ')} need at least ${g.minChips(r.bet)} coins for this table`);
  r.state = g.start(r.seats.map(s => ({ name: s.name, bot: !!s.bot, chips: s.id ? users[s.id].chips : Infinity })), r.bet, r.round++);
  // Hold each player's worst-case loss so the coins can't be spent elsewhere mid-round.
  for (const s of r.seats) {
    if (!s.id) continue;
    const u = users[s.id];
    s.stake = g.stake(r.bet, u.chips);
    u.chips -= s.stake;
    u.held = (u.held || 0) + s.stake;
  }
  save();
  r.paid = false;
  r.dealtAt = Date.now();
  update(r);
}

function leave(r, email) {
  userRoom.delete(email);
  const i = r.seats.findIndex(s => s.id === email && !s.left);
  if (i < 0) return;
  chat(r, '•', `${r.seats[i].name} left`);
  if (active(r)) r.seats[i].left = true; // a bot finishes their round; they still win or lose it
  else { r.seats.splice(i, 1); r.state = null; }
  const left = humans(r);
  // Last human gone: close the table, but a running round plays out first so leaving can't dodge a loss.
  if (!left.length && !active(r)) { clearTimeout(r.timer); clearTimeout(r.nextTimer); rooms.delete(r.code); return; }
  if (r.host === email && left.length) r.host = left[0].id;
  update(r);
}

function checkAdmin(key) {
  if (adminFails.n >= 5 && adminFails.until > Date.now()) throw fail(429, `Too many wrong keys. Try again in ${Math.ceil((adminFails.until - Date.now()) / 1000)}s.`);
  const a = Buffer.from(String(key || '')), b = Buffer.from(ADMIN_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    adminFails = { n: (adminFails.until > Date.now() ? adminFails.n : 0) + 1, until: Date.now() + 60e3 };
    throw fail(403, 'Wrong admin key');
  }
  adminFails = { n: 0, until: 0 };
}
const adminLog = () => adminEntries.slice(-25).reverse();

// ---------- API ----------
const api = {
  admin({ key, op, email, amount, reason }) {
    checkAdmin(key);
    if (op === 'adjust') {
      const u = users[String(email || '')];
      if (!u) throw fail(404, 'No player with that email');
      const n = Number(amount);
      if (!Number.isInteger(n) || n === 0 || Math.abs(n) > 1e6) throw fail(400, 'Amount must be a whole number between -1,000,000 and 1,000,000 (not 0)');
      // Only free coins can be removed; coins held for a running round stay put.
      if (u.chips + n < 0) throw fail(400, `${u.name} only has ${u.chips} free coins to remove`);
      const before = total(u);
      u.chips += n;
      const entry = { at: Date.now(), email: u.email, name: u.name, amount: n, before, after: total(u), reason: String(reason || '').slice(0, 100) };
      adminEntries.push(entry);
      fs.appendFileSync(ADMIN_LOG, JSON.stringify(entry) + '\n');
      save();
      sendTo(u.email);
      const r = rooms.get(userRoom.get(u.email));
      if (r) push(r);
    } else if (op !== 'list') throw fail(400, 'Unknown admin request');
    return {
      players: Object.values(users).sort((a, b) => a.name.localeCompare(b.name))
        .map(u => ({ email: u.email, name: u.name, chips: total(u), free: u.chips, held: u.held || 0, online: !!clients.get(u.email)?.size })),
      log: adminLog(),
    };
  },
  register({ email, password, name }) {
    email = String(email || '').trim().toLowerCase();
    name = String(name || '').trim().slice(0, 16);
    if (!/^[a-z0-9._%+-]+@gmail\.com$/.test(email)) throw fail(400, 'Please use a Gmail address (name@gmail.com)');
    if (String(password || '').length < 6) throw fail(400, 'Password must be at least 6 characters');
    if (String(password).length > 200) throw fail(400, 'Password is too long');
    if (!name) throw fail(400, 'Pick a display name');
    if (/^bot\b|^•/i.test(name)) throw fail(400, 'That name is reserved for bots. Pick another one.');
    if (users[email]) throw fail(400, 'That Gmail is already registered. Log in instead.');
    const salt = crypto.randomBytes(16).toString('hex');
    users[email] = { email, name, salt, hash: hash(password, salt).toString('hex'), chips: 1000, bonusAt: Date.now() };
    save();
    return newSession(email);
  },
  login({ email, password }) {
    const key = String(email || '').trim().toLowerCase(), u = users[key], f = loginFails.get(key);
    if (f && f.n >= 5 && f.until > Date.now()) throw fail(429, `Too many wrong passwords. Try again in ${Math.ceil((f.until - Date.now()) / 1000)}s.`);
    if (!u || String(password || '').length > 200 || !crypto.timingSafeEqual(hash(password || '', u.salt), Buffer.from(u.hash, 'hex'))) {
      const n = (f && f.until > Date.now() ? f.n : 0) + 1;
      loginFails.set(key, { n, until: Date.now() + 60e3 });
      throw fail(400, 'Wrong email or password');
    }
    loginFails.delete(key);
    return newSession(u.email);
  },
  logout(_, email, token) { sessions.delete(token); save(); return {}; },
  avatar({ avatar }, email) {
    if (!AVATARS.includes(avatar)) throw fail(400, 'Pick one of the avatars');
    users[email].avatar = avatar;
    save();
    sendTo(email);
    const r = rooms.get(userRoom.get(email));
    if (r) push(r);
    return {};
  },
  bonus(_, email) {
    const u = users[email], wait = u.bonusAt + 864e5 - Date.now();
    if (wait > 0) throw fail(400, `Daily bonus ready in ${Math.ceil(wait / 36e5)}h`);
    u.chips += 100;
    u.bonusAt = Date.now();
    save();
    sendTo(email);
    const r = rooms.get(userRoom.get(email));
    if (r) push(r);
    return {};
  },
  leaderboard() {
    return Object.values(users).sort((a, b) => total(b) - total(a)).slice(0, 10).map(u => ({ name: u.name, chips: total(u) }));
  },
  rooms() {
    return [...rooms.values()].filter(r => !active(r) && r.seats.length < GAMES[r.game].max)
      .map(r => ({ code: r.code, game: r.game, bet: r.bet, players: r.seats.length, max: GAMES[r.game].max, host: users[r.host].name }));
  },
  room(body, email) {
    const cur = rooms.get(userRoom.get(email)), op = body.op, name = users[email].name;
    if (op === 'create' || op === 'join') {
      let r;
      if (op === 'create') {
        if (!GAMES[body.game]) throw fail(400, 'Unknown game');
        if (!BETS.includes(Number(body.bet))) throw fail(400, 'Bad bet');
        let code;
        do code = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[crypto.randomInt(24)]).join(''); while (rooms.has(code));
        r = { code, game: body.game, bet: Number(body.bet), host: email, seats: [], chat: [], round: 0, state: null };
      } else {
        r = rooms.get(String(body.code || '').trim().toUpperCase());
        if (!r) throw fail(404, 'No table with that code');
        if (r === cur) return {};
        if (active(r)) throw fail(400, 'A round is in progress. Try again when it ends.');
        tidy(r);
        if (r.seats.length >= GAMES[r.game].max) throw fail(400, 'That table is full');
      }
      if (cur) leave(cur, email);
      rooms.set(r.code, r);
      r.seats.push({ id: email, name });
      userRoom.set(email, r.code);
      chat(r, '•', `${name} joined`);
      update(r);
      return { code: r.code };
    }
    if (!cur) throw fail(400, 'You are not at a table');
    const g = GAMES[cur.game], seat = cur.seats.findIndex(s => s.id === email && !s.left);
    const hostOnly = () => {
      if (cur.host !== email) throw fail(403, 'Only the host can do that');
      if (active(cur)) throw fail(400, 'Wait for the round to end');
      tidy(cur);
    };
    if (op === 'chat' || op === 'emote') {
      if (Date.now() - (lastChat.get(email) || 0) < 600) throw fail(429, 'Slow down a little');
      lastChat.set(email, Date.now());
    }
    switch (op) {
      case 'leave': leave(cur, email); sendTo(email); return {};
      case 'chat': {
        const text = String(body.text || '').trim().slice(0, 200);
        if (text) { chat(cur, name, text); push(cur); }
        return {};
      }
      case 'emote':
        if (!EMOTES.includes(body.text)) throw fail(400, 'Unknown emote');
        chat(cur, name, body.text, seat);
        push(cur);
        return {};
      case 'addbot':
        hostOnly();
        if (cur.seats.length >= g.max) throw fail(400, 'The table is full');
        cur.seats.push({ bot: true, name: BOT_NAMES.find(n => !cur.seats.some(s => s.name === n)) });
        update(cur);
        return {};
      case 'removebot': {
        hostOnly();
        const i = cur.seats.map(s => !!s.bot).lastIndexOf(true);
        if (i >= 0) cur.seats.splice(i, 1);
        update(cur);
        return {};
      }
      case 'lobby': hostOnly(); update(cur); return {}; // back to the seating screen
      case 'setbet': {
        // Between rounds only. Not hostOnly(): that would also clear the last round's result.
        if (g.tableBet === false) throw fail(400, 'In this game each player bets at the table');
        if (cur.host !== email) throw fail(403, 'Only the host can change the bet');
        if (active(cur)) throw fail(400, 'You can change the bet when this round ends');
        if (!BETS.includes(Number(body.bet))) throw fail(400, 'Bad bet');
        if (cur.bet !== Number(body.bet)) {
          cur.bet = Number(body.bet);
          chat(cur, '•', `${name} set the bet to ${cur.bet}`);
          update(cur);
        }
        return {};
      }
      case 'start': hostOnly(); startRound(cur); return {};
      case 'act':
        if (!active(cur)) throw fail(400, 'No round is running');
        g.act(cur.state, seat, body.action && typeof body.action === 'object' ? body.action : {});
        update(cur);
        return {};
    }
    throw fail(400, 'Unknown request');
  },
};
const PUBLIC_API = new Set(['register', 'login', 'admin']); // admin checks its own key

// ---------- HTTP ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = req => new Promise((ok, bad) => {
  let s = '';
  req.on('data', d => { s += d; if (s.length > 1e4) { bad(fail(413, 'Too large')); req.destroy(); } });
  req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { bad(fail(400, 'Bad JSON')); } });
});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://local'); // inside try: a malformed address must not crash the server
    if (url.pathname === '/api/events') {
      const email = sessions.get(url.searchParams.get('token'));
      if (!email) { res.writeHead(401); return res.end(); }
      res.on('error', () => {}); // writing to a stream that just closed must not crash the server
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      if (!clients.has(email)) clients.set(email, new Set());
      clients.get(email).add(res);
      sendTo(email);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); clients.get(email).delete(res); });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      const name = url.pathname.slice(5), fn = Object.hasOwn(api, name) && api[name];
      if (!fn) throw fail(404, 'Not found');
      const token = (req.headers.authorization || '').replace('Bearer ', '');
      const email = sessions.get(token);
      if (!email && !PUBLIC_API.has(name)) throw fail(401, 'Please log in');
      const body = req.method === 'POST' ? await readBody(req) : {};
      return json(res, 200, fn(body, email, token));
    }
    const page = { '/': '/index.html', '/admin': '/admin.html' }[url.pathname] || url.pathname;
    const file = path.join(PUBLIC, path.normalize(page));
    const isFile = file.startsWith(PUBLIC + path.sep) && fs.statSync(file, { throwIfNoEntry: false })?.isFile();
    if (!isFile) throw fail(404, 'Not found'); // folders too: streaming a folder used to crash the server
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  } catch (e) {
    if (!e.status) e.status = 400; // game rule errors
    if (!res.headersSent) json(res, e.status, { message: e.message });
  }
});

if (require.main === module) {
  loadData().then(() => server.listen(PORT, '0.0.0.0', () => {
    console.log(`Mesa Card Club on http://localhost:${PORT}${KV_URL ? '  (accounts saved in Upstash)' : ''}`);
    console.log(`Admin panel: http://localhost:${PORT}/admin  (key: ${process.env.ADMIN_KEY ? 'ADMIN_KEY setting' : KEY_FILE})`);
  })).catch(e => { console.error('Could not load saved accounts, not starting:', e.message); process.exit(1); });
  // Render stops the server when it sleeps or redeploys: upload any unsaved change first.
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => {
    if (KV_URL) { await flush(); await pushing; }
    process.exit(0);
  });
}
module.exports = { server, users, sessions };
