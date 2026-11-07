const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const coins = n => '🪙 ' + Number(n).toLocaleString();
const GAME_NAMES = { tongits: 'Tongits', poker: "Texas Hold'em", blackjack: 'Blackjack' };
const SUIT = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RANKS = 'A23456789TJQK';
const rk = c => RANKS.indexOf(c[0]);
const calm = matchMedia('(prefers-reduced-motion: reduce)');

const THEMES = ['lagoon', 'sunset', 'midnight', 'classic'];
const AVATARS = ['🐱', '🐶', '🦊', '🐼', '🐸', '🐵', '🦁', '🐯', '🐨', '🐰', '🐙', '🦄', '🐲', '🐧', '😎', '🤠']; // same list as the server
const EMOTES = ['😂', '😎', '😭', '🔥', '👏', '😡', '🙏', '🤑'];
const pref = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(k, v); } catch { /* per-device preference only */ } };
let theme = pref('theme', 'lagoon'), musicOn = pref('music', '0') === '1', pickGame = 'tongits', lastChatId = null;
document.body.dataset.theme = theme;
// Drifting card suits behind everything.
$('#sky').innerHTML = Array.from({ length: 16 }, (_, i) =>
  `<span style="left:${(i * 6.3 + Math.random() * 4) % 100}%;font-size:${18 + Math.random() * 40}px;animation-duration:${22 + Math.random() * 30}s;animation-delay:-${Math.random() * 50}s">${'♠♥♦♣'[i % 4]}</span>`).join('');

let token = pref('token', null), me = null, R = null, es = null, screen = '', authMode = 'login';
let lastHtml = '', sel = new Set(), selMeld = null, raiseTo = '', deadline = 0, lastSig = '';

async function api(path, body) {
  const r = await fetch('/api/' + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: body && JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) logout();
  if (!r.ok) throw new Error(j.message || 'Something went wrong');
  return j;
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show';
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.className = ''), 2800);
}
const run = p => p.catch(e => toast(e.message));
const room = (op, extra = {}) => run(api('room', { op, ...extra }));
// One move at a time: a double-tap must not send the same move twice.
let acting = false;
const act = action => {
  if (acting) return;
  acting = true;
  run(api('room', { op: 'act', action }).then(() => { sel.clear(); selMeld = null; raiseTo = ''; render(); })).finally(() => (acting = false));
};

function connect() {
  es?.close();
  es = new EventSource('/api/events?token=' + encodeURIComponent(token));
  es.onmessage = e => {
    const d = JSON.parse(e.data);
    me = d.me;
    R = d.room;
    deadline = R?.turnEndsIn != null ? Date.now() + R.turnEndsIn : 0;
    render();
    if (d.notice) toast(d.notice); // e.g. "Ana left, so the table closed."
  };
  // A closed stream isn't proof the login expired (reloads and network blips close it too).
  // Ask the server: api() logs out on 401; otherwise reconnect.
  es.onerror = () => {
    if (es.readyState !== EventSource.CLOSED) return; // the browser is already retrying
    const retry = () => token && api('rooms').then(connect, e => { if (token && !/log in/i.test(e.message)) setTimeout(retry, 3000); });
    setTimeout(retry, 1000);
  };
}
function logout() {
  if (token) fetch('/api/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + token } }).catch(() => {});
  token = null; me = null; R = null; screen = '';
  try { localStorage.removeItem('token'); } catch { /* storage blocked: nothing saved anyway */ }
  es?.close();
  showAuth();
}

// A card. k = stable key so new cards can be animated; src = selector of where it flies from.
function card(c, { cls = '', act = '', k = '', src = '', style = '' } = {}) {
  const anim = `${k ? `data-k="${k}"` : ''} ${src ? `data-src="${src}"` : ''} ${style ? `style="${style}"` : ''}`;
  if (!c || c === '??') return `<div class="card back ${cls}" ${anim}></div>`;
  const r = c[0] === 'T' ? '10' : c[0];
  return `<div class="card s-${c[1]} ${'HD'.includes(c[1]) ? 'red' : ''} ${cls}" ${anim} ${act ? `data-do="${act}" data-card="${c}" role="button" tabindex="0"` : ''} aria-label="${r} of ${SUIT[c[1]]}">
    <b>${r}<i>${SUIT[c[1]]}</i></b><span class="pip">${SUIT[c[1]]}</span></div>`;
}
const btn = (doo, a, label, extra = '') => `<button data-do="${doo}" data-a="${a}" ${extra}>${label}</button>`;

// ---------- butter: every card animates from where it was to where it is now ----------
const EASE = 'cubic-bezier(.33,.9,.3,1)';
// Relaxed tempo: how long a card takes to travel, and the gap between dealt cards (ms).
const MOVE = 750, FLY = 900, DEAL = 130;
const cardOf = k => { const c = k.slice(-2); return /^[A2-9TJQK][SHDC]$/.test(c) ? c : null; };
function snapshot(root) {
  const m = new Map();
  root.querySelectorAll('[data-k]').forEach(e => m.set(e.dataset.k, e.getBoundingClientRect()));
  return m;
}
// Same key moved: slide it (FLIP). Same card under a new key (hand -> discard/meld): fly from its exact old spot.
// Brand-new card: fly from its source (deck, a seat), or flip over if it was just revealed.
function animateBoard(root, before) {
  const byCard = new Map();
  before.forEach((r, k) => { const c = cardOf(k); if (c) byCard.set(c, r); });
  const els = [...root.querySelectorAll('[data-k]')];
  els.filter(e => !before.has(e.dataset.k)).slice(0, 16).forEach((_, n) => sfx.card(n * DEAL / 1000 + FLY * 0.72 / 1000));
  if (calm.matches) return;
  let dealt = 0;
  for (const el of els) {
    const k = el.dataset.k, b = el.getBoundingClientRect(), end = getComputedStyle(el).transform, rest = end === 'none' ? '' : end;
    const same = before.get(k);
    if (same) {
      const dx = same.left - b.left, dy = same.top - b.top;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) el.animate([{ transform: `translate(${dx}px, ${dy}px) ${rest}` }, { transform: rest || 'none' }], { duration: MOVE, easing: EASE });
      continue;
    }
    const c = cardOf(k), old = c && byCard.get(c);
    const srcEl = !old && el.dataset.src && root.querySelector(el.dataset.src);
    if (!old && !srcEl) {
      el.animate([{ transform: `rotateY(90deg) scale(.9) ${rest}` }, { transform: rest || 'none' }], { duration: MOVE, delay: Math.min(dealt++, 24) * DEAL, easing: EASE, fill: 'backwards' });
      continue;
    }
    const a = old || srcEl.getBoundingClientRect();
    const dx = a.left + a.width / 2 - (b.left + b.width / 2), dy = a.top + a.height / 2 - (b.top + b.height / 2);
    const s = old ? a.width / b.width : 0.6;
    el.animate([
      { transform: `translate(${dx}px, ${dy}px) rotate(${old ? 0 : -25}deg) scale(${s})`, opacity: old ? 1 : 0.4 },
      { transform: `translateY(-10px) ${rest} scale(1.06)`, opacity: 1, offset: 0.75 },
      { transform: rest || 'none', opacity: 1 },
    ], { duration: old ? MOVE : FLY, delay: old ? 0 : Math.min(dealt++, 24) * DEAL, easing: EASE, fill: 'backwards' });
  }
}

// Coin total counts up/down smoothly instead of jumping.
let shownChips = null, chipAnim = 0;
function showChips(n) {
  const el = $('#chips');
  if (!el) return;
  if (shownChips == null || calm.matches) { shownChips = n; el.textContent = coins(n); return; }
  if (n === shownChips) { el.textContent = coins(n); return; }
  const from = shownChips, t0 = performance.now(), id = ++chipAnim;
  el.classList.remove('up', 'down'); void el.offsetWidth; el.classList.add(n > from ? 'up' : 'down');
  shownChips = n;
  (function step(t) {
    if (id !== chipAnim) return;
    const p = Math.min(1, (t - t0) / 900), e = 1 - (1 - p) ** 3;
    el.textContent = coins(Math.round(from + (n - from) * e));
    if (p < 1) requestAnimationFrame(step);
  })(t0);
}
const updateTimers = () => {
  const s = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  document.querySelectorAll('.timer').forEach(t => { t.textContent = '⏱ ' + s + 's'; t.classList.toggle('low', s <= 10); });
};
// Selection changes only flip classes, so the CSS transition does the lift.
function syncSelection() {
  document.querySelectorAll('.hand .card').forEach(e => e.classList.toggle('sel', sel.has(e.dataset.card)));
  document.querySelectorAll('.meld').forEach(e => e.classList.toggle('sel', +e.dataset.i === selMeld));
  updateSelUI();
}

// ---------- sound (synthesized with Web Audio, no files) ----------
let muted = pref('muted', '0') === '1';
let actx = null;
function audio() {
  if (muted) return null;
  try {
    actx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    return actx;
  } catch { return null; } // no Web Audio: play silently instead of breaking every click
}
function tone(freq, dur, { type = 'sine', vol = 0.15, at = 0, to = 0 } = {}) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + at, o = a.createOscillator(), g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}
function snap(at = 0, vol = 0.35) {
  const a = audio();
  if (!a) return;
  const len = Math.floor(a.sampleRate * 0.06), buf = a.createBuffer(1, len, a.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
  const src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain(), t = a.currentTime + at;
  src.buffer = buf;
  f.type = 'bandpass'; f.frequency.value = 2200 + Math.random() * 800; f.Q.value = 0.9;
  g.gain.value = vol;
  src.connect(f).connect(g).connect(a.destination);
  src.start(t);
}
const sfx = {
  card: at => snap(at),
  select: () => tone(1200, 0.05, { type: 'triangle', vol: 0.05 }),
  coin: () => [1319, 1760, 2093].forEach((f, i) => tone(f, 0.18, { type: 'triangle', vol: 0.08, at: i * 0.07 })),
  win: () => {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.22, { type: 'square', vol: 0.06, at: i * 0.11 }));
    tone(1047, 0.7, { type: 'triangle', vol: 0.1, at: 0.44 });
    [1568, 2093, 2637, 3136].forEach((f, i) => tone(f, 0.15, { type: 'triangle', vol: 0.04, at: 0.55 + i * 0.06 }));
  },
  lose: () => [392, 349, 311, 262].forEach((f, i) => tone(f, 0.3, { type: 'sawtooth', vol: 0.04, at: i * 0.18, to: f * 0.97 })),
  draw: () => { tone(110, 0.35, { vol: 0.3, to: 55 }); tone(110, 0.35, { vol: 0.3, to: 55, at: 0.22 }); tone(880, 0.3, { type: 'square', vol: 0.04, at: 0.22 }); },
  turn: () => tone(880, 0.12, { type: 'sine', vol: 0.08 }),
};

// Chill lo-fi loop: soft Rhodes-like chords, a round bass and a few random bell notes.
let music = null;
function startMusic() {
  const a = audio();
  if (!a || music) return;
  const out = a.createGain(), lp = a.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 1400;
  lp.connect(out).connect(a.destination);
  out.gain.setValueAtTime(0, a.currentTime);
  out.gain.linearRampToValueAtTime(0.35, a.currentTime + 3);
  const hz = m => 440 * 2 ** ((m - 69) / 12);
  const note = (m, t, dur, vol, type = 'triangle') => {
    const o = a.createOscillator(), g = a.createGain();
    o.type = type; o.frequency.value = hz(m); o.detune.value = (Math.random() - 0.5) * 12;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(lp); o.start(t); o.stop(t + dur + 0.05);
  };
  const chords = [[48, 64, 67, 71, 74], [45, 60, 64, 67, 71], [50, 65, 69, 72, 76], [43, 62, 65, 69, 71]]; // Cmaj9 Am9 Dm9 G13
  const scale = [72, 74, 76, 79, 81, 84];
  const bar = 3.2; // ~75 bpm
  let next = a.currentTime + 0.2, i = 0;
  const tick = setInterval(() => {
    while (next < a.currentTime + 1.5) {
      const [bass, ...ch] = chords[i % 4];
      ch.forEach((m, k) => note(m, next + k * 0.03, bar * 0.95, 0.05));
      note(bass - 12, next, 1.4, 0.18, 'sine');
      note(bass - 12, next + bar * 0.625, 1, 0.12, 'sine');
      for (let b = 0; b < 3; b++) if (Math.random() < 0.55) note(scale[Math.floor(Math.random() * scale.length)], next + (1 + b) * bar / 4 + 0.4, 1.2, 0.03, 'sine');
      next += bar; i++;
    }
  }, 300);
  music = {
    stop() {
      clearInterval(tick);
      out.gain.cancelScheduledValues(a.currentTime);
      out.gain.setValueAtTime(out.gain.value, a.currentTime);
      out.gain.linearRampToValueAtTime(0, a.currentTime + 0.8);
      setTimeout(() => out.disconnect(), 1500);
      music = null;
    },
  };
}

function floatEmote(seat, text) {
  const wrap = $('.feltwrap');
  if (!wrap) return;
  const from = $('#seat' + seat) || $('#board');
  const w = wrap.getBoundingClientRect(), f = from.getBoundingClientRect();
  const el = document.createElement('div');
  el.className = 'emote';
  el.textContent = text;
  el.style.left = f.left - w.left + f.width / 2 - 23 + 'px';
  el.style.top = f.top - w.top + f.height / 2 - 30 + 'px';
  wrap.append(el);
  tone(660, 0.12, { type: 'sine', vol: 0.06 }); tone(990, 0.15, { type: 'sine', vol: 0.05, at: 0.08 });
  const anim = calm.matches
    ? el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 1600 })
    : el.animate([
      { transform: 'scale(.2)', opacity: 0 }, { transform: 'scale(1.3) rotate(-8deg)', opacity: 1, offset: 0.15 },
      { transform: 'translateY(-30px) scale(1) rotate(6deg)', opacity: 1, offset: 0.6 }, { transform: 'translateY(-90px) scale(.9)', opacity: 0 },
    ], { duration: 2600, easing: 'ease-out' });
  anim.onfinish = () => el.remove();
}

// Quick "You win +20" / "You lose -10" label on the table; a plain timer hides it, nothing to get stuck.
function flash(text, cls = '') {
  const f = $('#flash');
  if (!f) return;
  clearTimeout(flash.timer);
  f.textContent = text;
  f.className = 'flash ' + cls;
  f.hidden = false;
  flash.timer = setTimeout(() => (f.hidden = true), 1500);
}

// ---------- screens ----------
function render() {
  if (!token) return showAuth();
  if (!me) return;
  if (!R) {
    if (screen !== 'lobby') showLobby();
  } else {
    if (screen !== 'room:' + R.code) showRoomShell();
    fillRoom();
  }
  showChips(me.chips);
}

function showAuth() {
  screen = 'auth';
  document.body.classList.remove('in-room');
  const reg = authMode === 'register';
  $('#app').innerHTML = `<div class="auth panel">
    <div class="logo">Mesa Card Club</div>
    <div class="suits" aria-hidden="true"><span>♠</span><span>♥</span><span>♦</span><span>♣</span></div>
    <p class="muted">Kick back. Deal some cards. Tongits · Poker · Blackjack with your friends.</p>
    <form id="authForm">
      ${reg ? '<label>Display name<input name="name" maxlength="16" required autocomplete="nickname"></label>' : ''}
      <label>Gmail<input name="email" type="email" placeholder="you@gmail.com" pattern=".+@gmail\\.com" required autocomplete="email"></label>
      <label>Password<input name="password" type="password" minlength="6" required autocomplete="${reg ? 'new-password' : 'current-password'}"></label>
      <button class="primary">${reg ? 'Create account' : 'Log in'}</button>
    </form>
    <p>${reg ? 'Already have an account? <a href="#" data-do="mode">Log in</a>'
      : 'New here? <a href="#" data-do="mode">Create an account</a>. Every new player starts with 🪙 1,000.'}</p>
  </div>`;
}

const topbar = inner => `<header class="top"><div class="logo sm">♠♥<span class="lbl"> Mesa</span></div>${inner}
  <div class="spacer"></div>
  <button class="icon" data-do="theme" title="Change table theme" aria-label="Change table theme">🎨</button>
  <button class="icon" data-do="music" id="musicBtn" title="Chill music" aria-label="Toggle music" aria-pressed="${musicOn}">${musicOn ? '🎵' : '🎶'}</button>
  <button class="icon" data-do="mute" id="mute" aria-label="Toggle sound">${muted ? '🔇' : '🔊'}</button><span class="who">${me.avatar || ''} ${esc(me.name)}</span><span id="chips" class="chips"></span>
  <button data-do="bonus" title="+100 coins every 24 hours" aria-label="Daily bonus">🎁<span class="lbl"> Daily bonus</span></button>
  <button data-do="logout" aria-label="Log out">🚪<span class="lbl"> Log out</span></button></header>`;

// One tab per game. Coins needed to sit mirror the server's minChips (display only; the server enforces it).
const GAME_INFO = {
  tongits: {
    icon: '🃏', players: '2-3 players', need: 4,
    note: b => `Each loser pays the winner ${b}. Tongits or burned pays double (${b * 2}).`,
    rules: `<p>52 cards, 2 or 3 players. Dealer gets 13 cards, others 12. Card points: A=1, 2-10 face value, J/Q/K=10.</p>
      <p><b>Your turn:</b> draw from the stock, <i>or</i> take the top discard (only if it makes a meld right away). Lay down melds (3-4 of a kind, or 3+ in a row of one suit), <b>sapaw</b> (add cards to any meld on the table), then discard one card.</p>
      <p><b>Tongits:</b> empty your hand and win double. <b>Draw:</b> at the start of your turn, if you have a meld down and nobody sapaw-ed it since your last turn, call Draw. Others with a meld may fight or fold; lowest points wins (ties go to the challenger).</p>
      <p><b>Stock runs out:</b> lowest points among players with a meld wins. Players with no meld are <b>burned</b> and pay double.</p>`,
  },
  poker: {
    icon: '♠️', players: '2-6 players', need: 2,
    note: b => `Big blind ${b}, small blind ${Math.floor(b / 2)}. You sit with up to ${(b * 50).toLocaleString()} of your coins.`,
    rules: `<p><b>Texas Hold'em.</b> Everyone gets 2 private cards; 5 shared cards come out in three steps (flop, turn, river).</p>
      <p><b>On your turn:</b> fold, check (if nothing to call), call, raise, or go all in.</p>
      <p><b>Showdown:</b> best 5-card hand from your 2 cards + the 5 on the table wins the pot. Royal flush › straight flush › four of a kind › full house › flush › straight › three of a kind › two pair › pair › high card.</p>`,
  },
  blackjack: {
    icon: '🂡', players: '1-5 players', need: 2, atTable: true, // players bet at the table, not here
    note: () => 'You place your own bet at the table: tap 10, 50 and 100 chips (up to 500 a hand). Win pays 1:1, blackjack pays 3:2.',
    rules: `<p><b>Get closer to 21 than the dealer</b> without going over. Number cards are face value, J/Q/K are 10, Ace is 1 or 11.</p>
      <p><b>Hit</b> for another card, <b>stand</b> to stop, <b>double</b> on your first two cards to double the bet and take exactly one more card.</p>
      <p>The dealer draws until 17. Blackjack (Ace + 10-value card) pays 3:2.</p>`,
  },
};
const BETS = [10, 50, 100];
let pickBet = 10, lobbyRooms = [];
if (GAME_INFO[pref('game', '')]) pickGame = pref('game', '');
const betNote = () => GAME_INFO[pickGame].atTable ? `${GAME_INFO[pickGame].note()} You need ${coins(20)} to sit.`
  : `${GAME_INFO[pickGame].note(pickBet)} You need ${coins(pickBet * GAME_INFO[pickGame].need)} to sit.`;
const createLabel = () => `Create ${GAME_NAMES[pickGame]} table${GAME_INFO[pickGame].atTable ? '' : ' · bet ' + pickBet}`;

function showLobby() {
  screen = 'lobby';
  document.body.classList.remove('in-room');
  document.body.classList.remove('chat-open');
  const g = GAME_INFO[pickGame], name = GAME_NAMES[pickGame];
  $('#app').innerHTML = topbar('') + `<main class="lobby" data-g="${pickGame}">
    <div class="tabs" role="tablist" aria-label="Games">${Object.entries(GAME_INFO).map(([k, x]) =>
      `<button role="tab" id="tab-${k}" class="tab ${k === pickGame ? 'on' : ''}" data-g="${k}" data-do="tab" aria-selected="${k === pickGame}" aria-controls="gamepanel" tabindex="${k === pickGame ? 0 : -1}">
        <big>${x.icon}</big><span>${GAME_NAMES[k]}<small>${x.players}</small></span></button>`).join('')}</div>
    <section class="panel play" id="gamepanel" role="tabpanel" aria-labelledby="tab-${pickGame}">
      <h2>${g.icon} Play ${name}</h2>
      ${g.atTable ? '' : `<p class="muted">Tap a chip to choose your bet:</p>
      <div class="chipsrow" role="radiogroup" aria-label="Bet">${BETS.map(b =>
        `<button class="betchip b${b} ${b === pickBet ? 'on' : ''}" role="radio" aria-checked="${b === pickBet}" data-do="bet" data-b="${b}">${b}</button>`).join('')}</div>`}
      <p class="muted" id="betnote">${betNote()}</p>
      <button class="primary big" id="createBtn" data-do="create">${createLabel()}</button>
      <p class="muted solo">Want to play solo? Create the table, then press Add bot.</p>
      <h3>Join a friend</h3>
      <div class="row"><input id="code" class="grow" maxlength="4" placeholder="Table code" autocapitalize="characters" aria-label="Table code"><button data-do="join">Join</button></div>
    </section>
    <section class="panel"><h2>Open ${name} tables <button class="link" data-do="refresh">refresh</button></h2>
      <ul id="openRooms" class="list"><li class="muted">Loading…</li></ul></section>
    ${fold('profile', `<span class="avatar emoji mini" style="--h:200">${me.avatar || esc((me.name[0] || '?').toUpperCase())}</span> Your profile <span class="muted sumnote">${coins(me.chips)}</span>`,
      `<div class="row"><div class="avatar big emoji" style="--h:200">${me.avatar || esc((me.name[0] || '?').toUpperCase())}</div>
        <div><b>${esc(me.name)}</b><br><span class="muted">${coins(me.chips)}</span></div></div>
      <p class="muted">Pick the picture everyone sees at your seat:</p>
      <div class="avatars" role="radiogroup" aria-label="Avatar">${AVATARS.map(a =>
        `<button class="${a === me.avatar ? 'on' : ''}" role="radio" aria-checked="${a === me.avatar}" data-do="avatar" data-a="${a}">${a}</button>`).join('')}</div>`, 'profile')}
    ${fold('leaders', '🏆 Richest players', '<ol id="leaders" class="list"></ol>')}
    ${fold('rules', `📖 How to play ${name}`, g.rules, 'rules')}
  </main>`;
  loadLobby();
}
// Lobby boxes that fold away on phones (open on bigger screens); remembers what you opened.
const folds = {};
const fold = (id, title, body, cls = '') =>
  `<details class="panel fold ${cls}" data-fold="${id}" ${folds[id] ?? !matchMedia('(max-width: 860px)').matches ? 'open' : ''}>
    <summary><h2>${title}</h2></summary>${body}</details>`;
document.addEventListener('toggle', e => { if (e.target.dataset?.fold) folds[e.target.dataset.fold] = e.target.open; }, true);

async function loadLobby() {
  if (screen !== 'lobby') return;
  try {
    const [rooms, leaders] = await Promise.all([api('rooms'), api('leaderboard')]);
    lobbyRooms = rooms;
    $('#openRooms').innerHTML = lobbyRooms.filter(r => r.game === pickGame).map(r => `<li><span><b>${r.code}</b> · bet ${r.bet} · ${r.players}/${r.max} · ${esc(r.host)}</span>
      <button data-do="join" data-code="${r.code}">Join</button></li>`).join('') || `<li class="muted">No open ${GAME_NAMES[pickGame]} tables. Create one!</li>`;
    $('#leaders').innerHTML = leaders.map(u => `<li><span>${esc(u.name)}</span><span>${coins(u.chips)}</span></li>`).join('');
  } catch { /* lobby refresh is best-effort */ }
}
setInterval(loadLobby, 5000);

function showRoomShell() {
  screen = 'room:' + R.code;
  sel.clear(); selMeld = null; lastSig = null; lastChatId = null; lastHtml = ''; shownChips = null; wasMyTurn = false;
  document.body.classList.remove('chat-open');
  $('#app').innerHTML = topbar(`<span class="tablecode"><span class="lbl">${GAME_NAMES[R.game]} · </span><span class="tw">Table </span><b>${R.code}</b></span>
    <button data-do="leave">Leave</button>
    <button class="icon chatbtn" data-do="chat" aria-label="Players and chat" aria-expanded="false" aria-controls="side">💬<span class="dot" hidden></span></button>`) + `<main class="room">
    <div class="feltwrap"><div id="betbadge" class="betbadge" aria-live="polite"></div><div id="board" class="stage"></div><div id="flash" class="flash" hidden aria-live="polite"></div></div>
    <aside class="panel side" id="side" aria-label="Players and chat">
      <div class="sidehead"><h3>Players</h3><button class="icon closechat" data-do="chat" aria-label="Close chat">✕</button></div>
      <ul id="seats" class="list"></ul>
      <h3>Chat</h3>
      <div class="emotes">${EMOTES.map(e => `<button data-do="emote" data-e="${e}" aria-label="Send ${e}">${e}</button>`).join('')}</div>
      <div id="chatlog" class="chatlog"></div>
      <form id="chatForm" class="row"><input name="text" maxlength="200" placeholder="Say something…" autocomplete="off"><button>Send</button></form>
    </aside></main>`;
  $('.top').classList.add('inroom');
  document.body.classList.add('in-room');
  fitTopbar();
}
// The table fills the screen below the top bar; the bar can wrap to 2 lines, so measure it.
function fitTopbar() {
  const top = $('.top');
  if (top) document.documentElement.style.setProperty('--top', top.offsetHeight + 'px');
}
addEventListener('resize', fitTopbar);

function fillRoom() {
  $('#seats').innerHTML = R.seats.map((s, i) => `<li class="${i === R.mySeat ? 'me' : ''}">
    <span>${R.hostSeat === i ? '👑 ' : ''}${esc(s.name)}${s.bot ? ' 🤖' : ''}</span><span>${s.chips != null ? coins(s.chips) : ''}</span></li>`).join('');
  const log = $('#chatlog'), atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 5;
  log.innerHTML = R.chat.map(m => `<p><b>${esc(m.name)}</b> ${esc(m.text)}</p>`).join('');
  if (atBottom) log.scrollTop = log.scrollHeight;

  $('#betbadge').textContent = R.tableBet ? `Bet 🪙 ${R.bet}` : 'Bets 🪙 10 – 500';
  const v = R.state, board = $('#board');
  const html = (v ? { tongits, poker, blackjack }[R.game](v) : waiting()) + (v?.result ? resultBox(v) : '');
  if (html !== lastHtml) {
    const newRound = v && !v.result && lastSig === 'r'; // fresh deal: animate from the deck, not from last round's spots
    const before = newRound ? new Map() : snapshot(board);
    board.innerHTML = html;
    lastHtml = html;
    animateBoard(board, before);
    updateTimers();
    updateSelUI();
  }

  // Float new emoji reactions from the sender's seat (not the backlog on first load).
  const newest = R.chat.at(-1)?.id ?? 0;
  if (lastChatId != null) R.chat.filter(m => m.id > lastChatId && EMOTES.includes(m.text) && m.seat >= 0).forEach(m => floatEmote(m.seat, m.text));
  if (lastChatId != null && newest > lastChatId && !document.body.classList.contains('chat-open')) $('.chatbtn .dot').hidden = false; // unread
  lastChatId = newest;

  // Quick label when a fight starts or a round ends.
  const sig = !v ? '' : v.result ? 'r' : v.phase === 'fight' ? 'f' : '';
  if (sig && lastSig !== null && sig !== lastSig) { // lastSig null = just sat down: don't replay an old result
    if (sig === 'f') { sfx.draw(); flash('Draw called!'); }
    else {
      const d = v.result.deltas[R.mySeat] || 0, how = v.result.how, w = v.result.winner;
      setTimeout(d > 0 ? sfx.win : d < 0 ? sfx.lose : sfx.select, 300);
      const name = w != null && R.seats[w] ? R.seats[w].name : '';
      flash(how === 'tongits' ? (w === R.mySeat ? `TONGITS! +${d}` : `${name}: TONGITS! ${d}`)
        : how === 'draw' ? (d > 0 ? `You win the Draw +${d}` : `${name} wins the Draw ${d}`)
        : d > 0 ? `You win +${d}` : d < 0 ? `You lose ${d}` : 'Push',
        how === 'tongits' ? 'tongits' : d > 0 ? 'win' : d < 0 ? 'lose' : '');
    }
  }
  lastSig = sig;
  // Soft ping when it becomes your turn.
  const myTurn = !!(v && !v.result && R.turnEndsIn != null && (v.phase === 'fight' ? v.fight.pending[0] : v.turn) === R.mySeat);
  if (myTurn && !wasMyTurn) sfx.turn();
  wasMyTurn = myTurn;
}
let wasMyTurn = false;
let meldSort = pref('meldsort', '0') === '1';
let showHints = pref('hints', '1') === '1'; // hint lights on unless turned off // hand grouped by melds (on) or plain rank order (off)

// ---------- The table: a round felt with everyone seated in a circle around it ----------
// Where seat i sits on the rim. You are always at the bottom; the others go round the table.
// 'arc' (blackjack): players curve along the bottom, the dealer sits at the top.
function seatAngle(i, n, layout = 'circle') {
  const k = (((i - Math.max(R.mySeat, 0)) % n) + n) % n;
  let deg;
  if (layout === 'arc') {
    const j = k <= (n - 1) / 2 ? k : k - n; // you in the middle, others to either side
    deg = 90 - j * (n > 1 ? Math.min(34, 136 / (n - 1)) : 0);
  } else deg = 90 + (k * 360) / n;
  return (deg * Math.PI) / 180;
}
// Seats sit on the table edge (not hanging below it) so nothing spills into your hand below.
// Kept 11-89% across so a seat never hangs off the side of a narrow phone screen.
const posAt = (a, rx, ry) => `left:${Math.min(89, Math.max(11, 50 + rx * Math.cos(a))).toFixed(1)}%;top:${(50 + ry * Math.sin(a)).toFixed(1)}%`;
const seatAt = (i, n, layout) => posAt(seatAngle(i, n, layout), 45, 37);
// A player's cards / bet / score lie on the felt in front of them, between their seat and the middle.
// Blackjack's players sit along the bottom, so their cards spread wider and flatter to avoid touching.
// On a phone held sideways the table is flat, so cards sit closer to the middle (away from the seats).
const flatTable = matchMedia('(orientation: landscape) and (max-height: 500px)');
flatTable.addEventListener?.('change', () => { lastHtml = ''; if (R) render(); }); // re-place cards when the phone is rotated
// Heads-up Tongits: the opponent sits across the table, so their melds go to a drop area on the left side
// (like the original game) instead of covering the stock and discard pile in the middle.
const frontAt = (i, n, layout) => layout === 'tg2' && i !== R.mySeat ? posAt(Math.PI * 196 / 180, 30, 20) : posAt(seatAngle(i, n, layout),
  ...(layout === 'arc' ? (flatTable.matches ? [36, 11] : [33, 16]) : (flatTable.matches ? [33, 18] : [29, 22])));
const face = s => (s.bot ? '🤖' : s.avatar || esc((s.name[0] || '?').toUpperCase()));
const avatar = i => `<div class="avatar ${R.seats[i].avatar || R.seats[i].bot ? 'emoji' : ''}" style="--h:${(i * 137 + 20) % 360}">${face(R.seats[i])}</div>`;
// One player's spot at the table: avatar, name plate with coins, then game-specific bits (cards, score, bet).
function seatBox(i, n, { active = false, cls = '', extra = '', front = '', layout, pos } = {}) {
  const s = R.seats[i];
  return `<div class="tseat2 ${active ? 'active' : ''} ${i === R.mySeat ? 'me' : ''} ${cls}" id="seat${i}" style="${pos || seatAt(i, n, layout)}">
    ${avatar(i)}
    <div class="plate"><b>${esc(s.name)}</b><small>${s.chips != null ? coins(s.chips) : 'Bot'}</small></div>
    ${extra}
  </div>${front ? `<div class="seatfront ${cls}" style="${frontAt(i, n, layout)}">${front}</div>` : ''}`;
}
const tableHtml = (seats, center, cls = '') =>
  `<div class="ptable ${cls}"><div class="tfelt"><div class="tcenter2">${center}</div></div>${seats}</div>`;
const dealerSeat = extra => `<div class="tseat2 dealer" id="dealerSeat"><div class="avatar emoji" style="--h:280">🎩</div><div class="plate"><b>Dealer</b></div>${extra}</div>`;
const deckPile = (attrs = '', cls = '') => `<div class="pile ${cls}" id="deck" ${attrs}><div class="stack">${card('??', { cls: 'sm' })}</div></div>`;

function waiting() {
  const bots = R.seats.some(s => s.bot), layout = R.game === 'blackjack' ? 'arc' : 'circle', n = R.max;
  const seats = Array.from({ length: n }, (_, i) => (R.seats[i] ? seatBox(i, n, { layout })
    : `<div class="tseat2 empty" style="${seatAt(i, n, layout)}"><div class="avatar">+</div><div class="plate"><small>Open seat</small></div></div>`)).join('');
  const center = `<h2>${GAME_NAMES[R.game]}</h2>
    <p class="muted">Friends join with code</p><div class="bigcode">${R.code}</div>
    <p class="muted">${R.seats.length}/${R.max} seated · each player needs ${coins(R.minChips)}</p>`;
  return tableHtml(seats + (R.game === 'blackjack' ? dealerSeat('') : ''), center) + `<div class="mine waitbar trayrow">
    ${betPicker('Bet:')}
    ${R.isHost ? `<div class="actions">
      <button class="primary" data-do="start" ${R.seats.length < R.min ? "disabled" : ""}>Start game</button>
      ${R.seats.length < R.max ? '<button data-do="addbot">Add bot</button>' : ''}
      ${bots ? '<button data-do="removebot">Remove bot</button>' : ''}</div>
      ${R.seats.length < R.min ? `<p class="muted">Need at least ${R.min} players: share the code or add a bot.</p>` : ''}`
      : '<p class="muted">Waiting for the host to start…</p>'}</div>`;
}

function resultBox(v) {
  return `<div class="result">
    <h3>${esc(v.result.text)}</h3>
    <ul>${R.seats.map((s, i) => { const d = v.result.deltas[i]; return `<li>${esc(s.name)}${v.result.outcome ? ' · ' + v.result.outcome[i] : ''} <b class="${d > 0 ? 'win' : d < 0 ? 'lose' : ''}">${d > 0 ? '+' : ''}${d}</b></li>`; }).join('')}</ul>
    <div class="trayrow"><span class="muted">Next round in a few seconds…</span>
    ${betPicker('Next bet:')}
    ${R.isHost ? '<button class="primary" data-do="start">Deal now</button> <button data-do="lobbyTable">Change players</button>' : ''}</div>
  </div>`;
}

// Bright score badges so your points/total are easy to spot.
const scoreTag = (text, cls = '') => `<span class="score ${cls}">${text}</span>`;
const tgScore = p => scoreTag(`${p} pts`, p <= 10 ? 'good' : p <= 25 ? 'mid' : 'high'); // Tongits: low is good
const bjScore = t => scoreTag(t, t > 21 ? 'bust' : t === 21 ? 'best' : '');
// Host picks the bet between rounds; everyone else just sees it.
const betPicker = label => !R.tableBet ? '<p class="muted">Each player places their own bet when the round starts.</p>' : R.isHost
  ? `<p class="muted">${label}</p><div class="chipsrow small" role="radiogroup" aria-label="Bet">${BETS.map(b =>
    `<button class="betchip b${b} ${b === R.bet ? 'on' : ''}" role="radio" aria-checked="${b === R.bet}" data-do="setbet" data-b="${b}">${b}</button>`).join('')}</div>`
  : `<p class="muted">Bet: ${coins(R.bet)} (the host picks it)</p>`;

const logBox = v => `<div class="log">${v.log.map(l => `<div>${esc(l)}</div>`).join('')}</div>`;
const timerTag = on => (on && deadline ? '<span class="timer"></span>' : '');

// ---------- Tongits ----------
function sortHand(v) {
  const byRank = (a, b) => rk(a) - rk(b) || a[1].localeCompare(b[1]);
  if (!meldSort) return [...v.hand].sort(byRank).map(c => [c, false]);
  // Sort by meld: possible melds first (each group spaced apart), loose cards after.
  const out = [], used = new Set();
  for (const m of v.suggest) { m.forEach((c, j) => { out.push([c, j === 0]); used.add(c); }); }
  v.hand.filter(c => !used.has(c)).sort(byRank).forEach((c, j) => out.push([c, j === 0 && out.length > 0]));
  return out;
}

function tongits(v) {
  const my = R.mySeat, nm = i => esc(R.seats[i].name);
  const deciding = v.phase === 'fight' && !v.result ? v.fight.pending[0] : null;
  const active = i => !v.result && (deciding ?? v.turn) === i;
  const from = i => (i === my ? '#zone' + i : '#seat' + i); // where moved cards fly from
  const myPlay = !v.result && deciding == null && v.turn === my && v.phase === 'play';
  const myDraw = !v.result && deciding == null && v.turn === my && v.phase === 'draw';
  sel = new Set([...sel].filter(c => v.hand.includes(c)));
  if (selMeld != null && !v.melds[selMeld]) selMeld = null;
  // Signals (like Tongits Offline): ★ + a coloured bar per meld group, blue = sapaw (and its target meld),
  // orange 🔥 = card to dump, green pile = take the discard, green ▼ = the recommended button.
  const H = showHints && v.hints, glow = {}, style = {}, targets = new Set();
  const GROUP = ['#b06bff', '#ffa53d', '#3dc6ff', '#5be37f'];
  (H?.melds || []).forEach((m, g) => m.forEach(c => { glow[c] = 'hint-meld'; style[c] = '--gc:' + GROUP[g % GROUP.length]; }));
  (H?.pick || []).forEach(c => { glow[c] = 'hint-meld'; style[c] = '--gc:' + GROUP[0]; });
  (H?.sapaw || []).forEach(x => { glow[x.card] = 'hint-sapaw'; targets.add(x.meld); });
  if (H?.burn && !glow[H.burn]) glow[H.burn] = 'hint-burn';
  const rec = !H ? '' : myDraw ? (H.pick ? 'pick' : 'draw')
    : myPlay ? (H.tongits ? 'tongits' : H.melds?.length ? 'meld' : H.sapaw?.length ? 'sapaw' : 'discard') : '';
  const b = (a, label, cls = '', extra = '') => btn('tg', a, label, `class="${cls} ${rec === a ? 'rec' : ''}" ${extra}`);

  // Each player's melds lie on the felt in front of them; tap one to sapaw your selected cards onto it.
  const meldsOf = i => v.melds.map((m, gi) => m.owner !== i ? '' : `<div class="meld ${selMeld === gi ? 'sel' : ''} ${targets.has(gi) ? 'hint-target' : ''}" data-do="pickMeld" data-i="${gi}" role="button" tabindex="0" aria-label="${nm(m.owner)}'s meld">
      ${m.cards.map(c => card(c, { cls: 'sm', k: 'm:' + c, src: from(v.last) })).join('')}</div>`).join('');
  // End-of-round (and Draw) stamps: WIN / TONGITS! / FIGHT! / FOLD / BURNED.
  const stampOf = i => {
    const t = v.result ? v.result.tags?.[i] : v.fight && deciding != null ? (i === v.fight.caller ? 'DRAW' : v.fight.fighters.includes(i) ? 'FIGHT' : '') : '';
    if (!t) return '';
    const label = t === 'FIGHT' ? 'FIGHT!' : t === 'WIN' && v.result.how === 'tongits' ? 'TONGITS!' : t;
    return `<div class="stamp ${t.toLowerCase()} ${label === 'TONGITS!' ? 'tongits' : ''}">${label}</div>`;
  };
  // Table layout like the original game: opponents sit at the sides (or across, heads-up) with a
  // card-back badge showing how many cards they hold; every player has a DROP AREA box for their melds.
  const n = v.counts.length; // 2 or 3 players
  const k = i => (i - my + n) % n; // 1 = next player, 2 = the one after
  const others = n === 3 ? [(my + 2) % n, (my + 1) % n] : [(my + 1) % n]; // [left, right] or [across]
  const seatPos = i => (n === 2 ? 'left:50%;top:7%' : k(i) === 1 ? 'left:95%;top:30%' : 'left:5%;top:30%');
  const seats = others.map(i => seatBox(i, n, {
    active: active(i), pos: seatPos(i),
    extra: `<div class="handcount" title="${v.counts[i]} cards in hand">${v.counts[i]}</div>
      <div class="seatinfo">${v.result ? tgScore(v.result.points[i]) : ''}${v.exposed[i] ? '' : '<span class="tag">no meld</span>'} ${timerTag(active(i))}</div>${stampOf(i)}`,
  })).join('');
  // A box with many melds (or melds + a revealed hand) uses smaller cards so nothing gets cut off.
  const busy = i => { const m = v.melds.filter(x => x.owner === i).length + (v.result && i !== my ? 1 : 0); return m >= (i === my ? 5 : 3) ? 'dense' : ''; };
  const zone = (i, area) => `<div class="tzone ${area} ${i === my ? 'mydrop' : ''} ${active(i) ? 'turn' : ''} ${busy(i)}" id="zone${i}"
      ${i === my && myPlay ? 'data-do="dropArea" role="button" aria-label="Your drop area: lay down the selected meld"' : ''}>
      <span class="zlabel">${i === my ? 'YOUR DROP AREA' : 'DROP AREA'}</span>
      ${v.result && i !== my ? `<div class="reveal" aria-label="${nm(i)}'s hand">${v.result.hands[i].map(c => card(c, { cls: 'xs face', k: `or${i}:${c}` })).join('')}</div>` : ''}
      <div class="zmelds">${meldsOf(i)}</div>
      ${i === my ? `<div class="zstamp">${stampOf(i)}</div>` : ''}
    </div>`;

  let acts = '', hint = '';
  if (v.result) acts = '';
  else if (deciding != null) {
    acts = deciding === my ? btn('tg', 'fight', 'Fight!', 'class="primary"') + btn('tg', 'fold', 'Fold') : `<span class="muted">${nm(deciding)} is deciding…</span>`;
    hint = `${nm(v.fight.caller)} called Draw! Fight if your points are lower than theirs. Your hand: ${tgScore(v.points)}`;
  } else if (myDraw) {
    acts = b('draw', 'Draw', 'primary') + b('pick', 'Take discard', '', v.top ? '' : 'disabled') + (v.canCall ? btn('tg', 'call', 'Call DRAW', 'class="warn"') : '');
    hint = H?.pick ? 'The glowing discard makes a meld with your starred cards: tap it to take it.' : 'Tap the stock to draw a card.';
  } else if (myPlay) {
    acts = (H?.tongits ? b('tongits', 'TONGITS!', 'tongits-btn') : '')
      + b('meld', 'Drop', 'drop') + b('sapaw', 'Sapaw') + b('discard', 'Dump', 'dump')
      + btn('tg', 'meldall', 'Auto Meld', H?.melds?.length || v.suggest.length ? '' : 'disabled');
    hint = H?.tongits ? 'You can empty your hand! Press TONGITS! to win double.'
      : '★ = meld (Drop) · blue = Sapaw onto the glowing meld · 🔥 = best card to Dump. Select cards to see what they can do.';
  } else acts = `<span class="muted">${nm(v.turn)}'s turn…</span>`;

  const piles = `<div class="tpiles">
      <div class="row piles">
        <div class="col">${deckPile(myDraw ? 'data-do="tg" data-a="draw" role="button" tabindex="0" aria-label="Draw from stock"' : '', myDraw ? 'glow' : '')}<span class="pilecount"><b>${v.stock}</b></span></div>
        <div class="col"><div class="pile ${H?.pick ? 'hint-pick' : ''}" id="discard" ${myDraw && v.top ? 'data-do="pickDiscard" role="button" tabindex="0" aria-label="Take the discard"' : ''}>${v.top ? card(v.top, { cls: 'sm', k: 'd:' + v.top, src: from(v.last) }) : '<div class="card sm empty"></div>'}</div><span class="pilecount">Discard</span></div>
      </div>
      <div class="log one">${esc(v.log.at(-1) || '')}</div>
    </div>`;
  // Top row: opponents' drop areas with the stock & discard between them; bottom row: your drop area.
  const center = n === 3
    ? `<div class="tgrid three">${zone(others[0], 'zl')}${piles}${zone(others[1], 'zr')}${zone(my, 'zm')}</div>`
    : `<div class="tgrid two">${zone(others[0], 'zl')}${piles}${zone(my, 'zm')}</div>`;

  return tableHtml(seats, center, 'tongits ' + (n === 3 ? 'three' : 'two')) + `
    <div class="mine tgtray ${active(my) ? 'active' : ''}">
      <div class="trayhead"><div class="status"><b>Your hand</b> ${tgScore(v.points)} ${timerTag(active(my))}
        <button class="toggle ${meldSort ? 'on' : ''}" data-do="meldsort" aria-pressed="${meldSort}" title="Group your melds together">🔀<span class="long"> Sort</span></button>
        <button class="toggle ${showHints ? 'on' : ''}" data-do="hints" aria-pressed="${showHints}" title="Signals for what to drop, sapaw and dump">💡<span class="long"> Hints</span></button></div>
        <div class="actions">${acts}</div></div>
      <div class="sellabel" id="selLabel" aria-live="polite"></div>
      <div class="hand">${sortHand(v).map(([c, gap], j, all) => {
        const o = j - (all.length - 1) / 2; // curved fan: tilt and drop the outer cards
        return card(c, { cls: (sel.has(c) ? 'sel ' : '') + (gap ? 'gap ' : '') + (glow[c] || ''), act: 'toggle', k: 'h:' + c, src: '#deck',
          style: `--r:${(o * 1.6).toFixed(1)}deg;--y:${(o * o * 0.4).toFixed(1)}px;${style[c] || ''}` });
      }).join('')}</div>
      ${hint ? `<p class="hint">${hint}</p>` : ''}
    </div>`;
}

// What can the selected cards do right now? Shown as "DROP - SAPAW - DUMP" above your hand, and the
// places they can go (your drop area, an opponent's meld, the discard pile) light up.
const rankN = c => RANKS.indexOf(c[0]) + 1;
function isMeldC(cs) {
  if (cs.length < 3 || new Set(cs).size !== cs.length) return false;
  const rs = cs.map(rankN).sort((a, b) => a - b);
  if (cs.length <= 4 && rs.every(r => r === rs[0])) return true;
  return cs.every(c => c[1] === cs[0][1]) && rs.every((r, i) => !i || r === rs[i - 1] + 1);
}
function selectionInfo() {
  const v = R?.state;
  if (R?.game !== 'tongits' || !v || v.result || v.phase === 'fight' || v.turn !== R.mySeat) return null;
  const cards = [...sel];
  if (v.phase === 'draw') return { cards, pick: !!v.top && cards.length >= 2 && isMeldC([...cards, v.top]) };
  return {
    cards, drop: isMeldC(cards), dump: cards.length === 1,
    sapaw: v.melds.map((m, i) => (cards.length && isMeldC([...m.cards, ...cards]) ? i : -1)).filter(i => i >= 0),
  };
}
function updateSelUI() {
  const label = $('#selLabel'), info = selectionInfo();
  if (!label) return;
  const parts = !info || !info.cards.length ? [] : info.pick ? ['TAKE DISCARD']
    : [info.drop && 'DROP', info.sapaw?.length && 'SAPAW', info.dump && 'DUMP'].filter(Boolean);
  label.textContent = parts.length ? parts.join(' - ') : info?.cards.length ? "These cards don't go together" : '';
  label.classList.toggle('bad', !parts.length && !!info?.cards.length);
  $('.mydrop')?.classList.toggle('can', !!info?.drop);
  document.querySelectorAll('.ptable .meld').forEach(e => e.classList.toggle('can', !!info?.sapaw?.includes(+e.dataset.i)));
  $('#discard')?.classList.toggle('can', !!info?.pick);
}

// ---------- Poker ----------
function poker(v) {
  const my = R.mySeat, mine = !v.result && v.turn === my, n = R.seats.length;
  if (!mine) raiseTo = ''; // don't carry a typed raise over to a later turn
  const seats = R.seats.map((s, i) => seatBox(i, n, {
    active: !v.result && v.turn === i, cls: v.folded[i] ? 'folded' : '',
    extra: `<div class="seatinfo">${v.dealer === i ? '<span class="dbtn" title="Dealer">D</span>' : ''}${timerTag(!v.result && v.turn === i)}</div>`,
    front: `<div class="hole">${v.hole[i].map((c, j) => card(c, { cls: 'sm', k: `p${i}:${j}:${c}`, src: c === '??' || i === my ? '#deck' : '' })).join('')}</div>
      <div class="seatinfo">${v.result?.hands?.[i] ? scoreTag(esc(v.result.hands[i]), v.result.deltas[i] > 0 ? 'best' : '') : i === my && v.myHand ? scoreTag(v.myHand, 'good') : ''}
        ${v.bets[i] ? `<span class="betchipmini">🪙 ${v.bets[i]}</span>` : ''}${v.allin[i] ? '<span class="tag">ALL IN</span>' : ''}${v.folded[i] ? '<span class="tag">folded</span>' : ''}</div>
      <small class="stack">stack ${coins(v.stacks[i])}</small>`,
  })).join('');
  const val = raiseTo || Math.min(v.minTo, v.maxTo);
  const acts = mine ? `${btn('pk', 'fold', 'Fold')}${v.toCall ? btn('pk', 'call', `Call ${Math.min(v.toCall, v.stacks[my])}`, 'class="primary"') : btn('pk', 'check', 'Check', 'class="primary"')}
      ${v.maxTo > v.bets[my] + v.toCall ? `<input id="raise" type="number" inputmode="numeric" min="${v.minTo}" max="${v.maxTo}" value="${val}" aria-label="Raise to">${btn('pk', 'raise', 'Raise to')}` : ''}
      ${btn('pk', 'allin', 'All in', 'class="warn"')}` : !v.result ? `<span class="muted">${esc(R.seats[v.turn]?.name)}'s turn…</span>` : '';
  const center = `<div class="row board">${deckPile()}${v.board.map(c => card(c, { k: 'b:' + c, src: '#deck' })).join('')}${'<div class="card empty"></div>'.repeat(5 - v.board.length)}</div>
    <div class="pot">Pot ${coins(v.pot)}</div><div class="log one">${esc(v.log.at(-1) || '')}</div>`;
  return tableHtml(seats, center, 'poker') + `<div class="mine"><div class="actions">${acts}</div></div>`;
}

// ---------- Blackjack ----------
function blackjack(v) {
  const my = R.mySeat, mine = !v.result && v.turn === my, n = R.seats.length, betting = v.phase === 'bet';
  const seats = R.seats.map((s, i) => seatBox(i, n, {
    layout: 'arc', active: !v.result && !betting && v.turn === i, cls: betting && v.ready[i] ? 'ready' : '',
    extra: `<div class="seatinfo">${timerTag(!v.result && !betting && v.turn === i)}</div>`,
    front: betting
      ? `<div class="seatinfo">${v.bets[i] ? scoreTag('🪙 ' + v.bets[i], v.ready[i] ? 'best' : 'mid') : '<span class="tag">choosing…</span>'}</div>
         <small>${v.ready[i] ? '✓ Ready' : ''}</small>`
      : `<div class="hole">${v.hands[i].map((c, j) => card(c, { cls: 'sm', k: `bj${i}:${j}${c}`, src: '#deck' })).join('')}</div>
         <div class="seatinfo">${bjScore(v.totals[i])}<span class="betchipmini">🪙 ${v.bets[i]}</span></div>
         ${v.result ? `<small>${v.result.outcome[i]}</small>` : ''}`,
  })).join('');
  const dealer = dealerSeat(`<div class="row hole">${v.dealer.map((c, j) => card(c, { cls: 'sm', k: `dl:${j}${c}`, src: c === '??' || j !== 1 ? '#deck' : '' })).join('')}</div>
    ${v.dealerTotal != null ? `<div class="seatinfo">${bjScore(v.dealerTotal)}</div>` : ''}`);
  const center = betting
    ? `<h2 class="placebets">Place your bets!</h2><p class="muted">Max ${coins(v.max)} a hand</p>${deckPile()}`
    : `${deckPile()}<div class="log one">${esc(v.log.at(-1) || '')}</div>`;
  const bet = v.bets[my];
  const tray = betting
    ? (v.ready[my] ? `<p class="hint">Your bet of ${coins(bet)} is in. Waiting for the others…</p>`
      : `<div class="trayrow"><div class="status">Your bet ${scoreTag('🪙 ' + bet, bet ? 'mid' : '')} ${timerTag(v.ready.indexOf(false) === my)}</div>
        <div class="chipsrow small">${v.chips.map(c =>
          `<button class="betchip b${c}" data-do="bj" data-a="chip" data-v="${c}" ${bet + c > v.max ? 'disabled' : ''} aria-label="Add ${c}">${c}</button>`).join('')}</div>
        <div class="actions">${btn('bj', 'clear', 'Clear', bet ? '' : 'disabled')}${btn('bj', 'deal', `Deal ✓ ${bet ? '· ' + bet : ''}`, `class="primary" ${bet ? '' : 'disabled'}`)}</div></div>`)
    : `<div class="actions">${mine
      ? btn('bj', 'hit', 'Hit', 'class="primary"') + btn('bj', 'stand', 'Stand') + (v.hands[my].length === 2 ? btn('bj', 'double', 'Double') : '')
      : !v.result ? `<span class="muted">${esc(R.seats[v.turn]?.name)}'s turn…</span>` : ''}</div>`;
  return tableHtml(seats + dealer, center, 'blackjack') + `<div class="mine">${tray}</div>`;
}

// ---------- input ----------
const clicks = {
  mode: () => { authMode = authMode === 'login' ? 'register' : 'login'; showAuth(); },
  logout,
  bonus: () => run(api('bonus', {}).then(() => { sfx.coin(); toast('+100 coins!'); })),
  mute: el => {
    muted = !muted;
    setPref('muted', muted ? '1' : '0');
    el.textContent = muted ? '🔇' : '🔊';
    if (muted) music?.stop(); else if (musicOn) startMusic();
    sfx.select();
  },
  music: el => {
    musicOn = !musicOn;
    setPref('music', musicOn ? '1' : '0');
    el.textContent = musicOn ? '🎵' : '🎶';
    el.setAttribute('aria-pressed', musicOn);
    if (musicOn) { if (muted) toast('Sound is muted. Tap 🔇 to hear the music.'); startMusic(); } else music?.stop();
  },
  theme: () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    document.body.dataset.theme = theme;
    setPref('theme', theme);
    sfx.select();
    toast(`Theme: ${theme[0].toUpperCase() + theme.slice(1)}`);
  },
  emote: el => room('emote', { text: el.dataset.e }),
  chat: () => {
    const open = document.body.classList.toggle('chat-open');
    $('.chatbtn').setAttribute('aria-expanded', open);
    if (open) { $('.chatbtn .dot').hidden = true; $('#chatlog').scrollTop = 1e6; }
  },
  hints: () => { showHints = !showHints; setPref('hints', showHints ? '1' : '0'); sfx.select(); render(); },
  meldsort: () => { meldSort = !meldSort; setPref('meldsort', meldSort ? '1' : '0'); sfx.select(); render(); },
  tab: el => { pickGame = el.dataset.g; setPref('game', pickGame); sfx.select(); showLobby(); $('#tab-' + pickGame)?.focus(); },
  bet: el => {
    pickBet = +el.dataset.b;
    document.querySelectorAll('.betchip').forEach(b => { b.classList.toggle('on', b === el); b.setAttribute('aria-checked', b === el); });
    $('#betnote').textContent = betNote();
    $('#createBtn').textContent = createLabel();
    sfx.coin();
  },
  refresh: loadLobby,
  create: () => room('create', { game: pickGame, bet: GAME_INFO[pickGame].atTable ? BETS[0] : pickBet }),
  join: el => room('join', { code: el.dataset.code || $('#code').value }),
  leave: () => room('leave'),
  start: () => room('start'),
  addbot: () => room('addbot'),
  removebot: () => room('removebot'),
  lobbyTable: () => room('lobby'),
  landscape: async () => {
    try { await document.documentElement.requestFullscreen?.(); await screen.orientation?.lock?.('landscape'); }
    catch { toast('Please rotate your phone sideways'); }
  },
  avatar: el => run(api('avatar', { avatar: el.dataset.a }).then(() => { sfx.select(); screen = ''; render(); })), // redraw lobby with the new face
  setbet: el => { if (+el.dataset.b !== R.bet) { sfx.coin(); room('setbet', { bet: +el.dataset.b }); } },
  hint: () => {
    const m = R.state.suggest[0];
    if (!m) return toast('No meld in your hand yet. Try a sapaw, or discard your highest loose card.');
    sel = new Set(m); selMeld = null; sfx.select(); syncSelection();
  },
  toggle: el => { const c = el.dataset.card; sel.has(c) ? sel.delete(c) : sel.add(c); sfx.select(); syncSelection(); },
  pickMeld: el => {
    const i = +el.dataset.i, info = selectionInfo();
    if (info?.sapaw?.includes(i)) return act({ type: 'sapaw', cards: info.cards, meld: i });
    selMeld = selMeld === i ? null : i; sfx.select(); syncSelection();
  },
  dropArea: () => {
    const info = selectionInfo();
    if (info?.drop) return act({ type: 'meld', cards: info.cards });
    toast(sel.size ? 'Those cards are not a meld' : 'Select 3+ cards that make a meld, then tap here');
  },
  pickDiscard: () => clicks.tg({ dataset: { a: 'pick' } }),
  tg: el => {
    const a = el.dataset.a;
    let cards = [...sel];
    const H = R.state.hints;
    if (a === 'meld' && !cards.length) { // nothing selected: lay down the best meld in your hand
      cards = R.state.suggest[0] || [];
      if (!cards.length) return toast('No meld in your hand yet');
    }
    if (a === 'pick' && !cards.length && H?.pick) cards = H.pick; // take the discard with the cards it melds with
    if (a === 'sapaw' && !cards.length && selMeld == null && H?.sapaw?.length) { cards = [H.sapaw[0].card]; selMeld = H.sapaw[0].meld; }
    if (a === 'tongits') return act({ type: 'tongits' });
    if (a === 'meldall') return act({ type: 'meldall' });
    if (a === 'discard' && !cards.length && H?.burn) return toast('Select a card to dump. 🔥 marks the best one.');
    if (a === 'sapaw' && cards.length && selMeld == null) { // pick the meld the selected cards fit
      const fit = selectionInfo()?.sapaw?.[0];
      if (fit != null) selMeld = fit;
    }
    if (a === 'discard' && cards.length !== 1) return toast('Select exactly one card to discard');
    if (a === 'sapaw' && selMeld == null) return toast('Tap a meld on the table first');
    if (['pick', 'meld', 'sapaw'].includes(a) && !cards.length) return toast('Select cards from your hand first');
    act(a === 'discard' ? { type: a, card: cards[0] } : a === 'sapaw' ? { type: a, cards, meld: selMeld } : { type: a, cards });
  },
  pk: el => act({ type: el.dataset.a, to: +($('#raise')?.value || 0) }),
  bj: el => { if (el.dataset.a === 'chip') sfx.coin(); act({ type: el.dataset.a, value: +el.dataset.v || 0 }); },
};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-do]');
  audio(); // browsers only allow sound after a click, so unlock it on the first one
  if (musicOn && !music && el?.dataset.do !== 'music') startMusic();
  if (!el || el.disabled) return;
  e.preventDefault();
  clicks[el.dataset.do]?.(el);
});
document.addEventListener('dblclick', e => {
  // Double-click a hand card to discard it during your play phase.
  const el = e.target.closest('.hand [data-card]'), v = R?.state;
  if (el && R.game === 'tongits' && v && !v.result && v.turn === R.mySeat && v.phase === 'play') act({ type: 'discard', card: el.dataset.card });
});
document.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-do][role=button]')) { e.preventDefault(); e.target.click(); }
  if (e.key === 'Escape' && document.body.classList.contains('chat-open')) clicks.chat();
  if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && e.target.matches('[role=tab]')) {
    const tabs = [...document.querySelectorAll('[role=tab]')], i = tabs.indexOf(e.target);
    tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length].click();
  }
});
document.addEventListener('input', e => { if (e.target.id === 'raise') raiseTo = e.target.value; });
document.addEventListener('submit', e => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  if (e.target.id === 'authForm') run(api(authMode, f).then(r => { token = r.token; setPref('token', token); connect(); }));
  if (e.target.id === 'chatForm' && f.text.trim()) { room('chat', { text: f.text }); e.target.reset(); }
});
setInterval(updateTimers, 250);

if (token) connect();
render();
