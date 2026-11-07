// Texas Hold'em, one hand per round. Bet = big blind. Stack = min(your coins, 50 big blinds).
const { deck, shuffle, rank } = require('./cards');

const hi = c => (rank(c) === 1 ? 14 : rank(c));
const NAMES = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'];

function score5(cs) {
  const rs = cs.map(hi).sort((a, b) => b - a);
  const flush = cs.every(c => c[1] === cs[0][1]);
  const count = {};
  rs.forEach(r => (count[r] = (count[r] || 0) + 1));
  const groups = Object.entries(count).map(([r, n]) => [n, +r]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const kick = groups.map(g => g[1]);
  let straight = 0;
  if (groups.length === 5) {
    if (rs[0] - rs[4] === 4) straight = rs[0];
    else if (rs[0] === 14 && rs[1] === 5) straight = 5; // wheel A-2-3-4-5
  }
  if (straight && flush) return [8, straight];
  if (groups[0][0] === 4) return [7, ...kick];
  if (groups[0][0] === 3 && groups[1][0] === 2) return [6, ...kick];
  if (flush) return [5, ...rs];
  if (straight) return [4, straight];
  if (groups[0][0] === 3) return [3, ...kick];
  if (groups[0][0] === 2 && groups[1][0] === 2) return [2, ...kick];
  if (groups[0][0] === 2) return [1, ...kick];
  return [0, ...rs];
}
const cmp = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  return 0;
};
function best(cards) {
  let top = null;
  (function pick(from, chosen) {
    if (chosen.length === 5) { const sc = score5(chosen); if (!top || cmp(sc, top) > 0) top = sc; return; }
    for (let i = from; i <= cards.length - (5 - chosen.length); i++) pick(i + 1, [...chosen, cards[i]]);
  })(0, []);
  return top;
}

const seats = s => [...Array(s.n).keys()];
const canAct = (s, i) => !s.folded[i] && !s.allin[i];
function put(s, i, amt) {
  amt = Math.min(amt, s.stacks[i]);
  s.stacks[i] -= amt; s.bets[i] += amt; s.contrib[i] += amt;
  if (!s.stacks[i]) s.allin[i] = true;
}
function nextActor(s, from) {
  for (let k = 1; k <= s.n; k++) { const i = (from + k) % s.n; if (canAct(s, i)) return i; }
  return null;
}

function start(players, bet, round = 0) {
  const n = players.length, d = shuffle(deck());
  const stacks = players.map(p => Math.min(p.chips, bet * 50));
  const z = v => Array(n).fill(v);
  const s = {
    bet, n, names: players.map(p => p.name), deck: d, hole: players.map(() => d.splice(0, 2)), board: [],
    stacks, start: [...stacks], bets: z(0), contrib: z(0), folded: z(false), allin: z(false), acted: z(false),
    dealer: round % n, street: 0, current: 0, minRaise: bet, turn: null, log: [], result: null,
  };
  const sb = n === 2 ? s.dealer : (s.dealer + 1) % n, bb = (sb + 1) % n;
  put(s, sb, Math.floor(bet / 2));
  put(s, bb, bet);
  s.current = Math.max(...s.bets);
  s.log.push(`${s.names[sb]} posts ${s.bets[sb]}, ${s.names[bb]} posts ${s.bets[bb]}`);
  advance(s, bb);
  return s;
}

function advance(s, last) {
  if (seats(s).filter(i => !s.folded[i]).length === 1) return finish(s);
  for (let k = 1; k <= s.n; k++) {
    const i = (last + k) % s.n;
    if (canAct(s, i) && (!s.acted[i] || s.bets[i] < s.current)) { s.turn = i; return; }
  }
  s.bets.fill(0); s.acted.fill(false); s.current = 0; s.minRaise = s.bet;
  while (s.street < 3) {
    s.street++;
    s.board.push(...s.deck.splice(0, s.street === 1 ? 3 : 1));
    if (seats(s).filter(i => canAct(s, i)).length >= 2) { s.turn = nextActor(s, s.dealer); return; }
  }
  finish(s);
}

function finish(s) {
  const live = seats(s).filter(i => !s.folded[i]), showdown = live.length > 1;
  const scores = s.hole.map((h, i) => (showdown && !s.folded[i] ? best([...h, ...s.board]) : null));
  const won = Array(s.n).fill(0);
  let prev = 0;
  // Side pots: each contribution level is its own pot, won by the best eligible hand.
  for (const lv of [...new Set(s.contrib)].filter(x => x > 0).sort((a, b) => a - b)) {
    const pot = s.contrib.reduce((t, c) => t + Math.max(0, Math.min(c, lv) - prev), 0);
    let elig = live.filter(i => s.contrib[i] >= lv);
    if (!elig.length) elig = live;
    if (showdown) {
      const top = elig.reduce((b, i) => (cmp(scores[i], scores[b]) > 0 ? i : b));
      elig = elig.filter(i => cmp(scores[i], scores[top]) === 0);
    }
    elig.forEach((w, k) => (won[w] += Math.floor(pot / elig.length) + (k < pot % elig.length ? 1 : 0)));
    prev = lv;
  }
  s.stacks = s.stacks.map((x, i) => x + won[i]);
  const winners = seats(s).filter(i => won[i] > 0);
  const text = winners.map(i => `${s.names[i]} wins ${won[i]}${showdown ? ` with ${NAMES[scores[i][0]]}` : ''}`).join(', ');
  s.result = {
    deltas: s.stacks.map((x, i) => x - s.start[i]), showdown,
    hands: scores.map(sc => (sc ? NAMES[sc[0]] : null)),
    text: text + (showdown ? '' : ' (everyone else folded)'),
  };
  s.turn = null;
  s.log.push(s.result.text);
}

function act(s, seat, a) {
  if (s.result || s.turn !== seat) throw new Error('Not your turn');
  const toCall = s.current - s.bets[seat], all = s.bets[seat] + s.stacks[seat], name = s.names[seat];
  let type = a.type;
  if (type === 'allin') type = all > s.current ? 'raise' : 'call';
  switch (type) {
    case 'fold': s.folded[seat] = true; s.log.push(`${name} folds`); break;
    case 'check':
      if (toCall) throw new Error(`You must call ${toCall} or fold`);
      s.log.push(`${name} checks`); break;
    case 'call': put(s, seat, toCall); s.log.push(`${name} calls`); break;
    case 'raise': {
      const to = a.type === 'allin' ? all : Math.min(Math.floor(Number(a.to)) || 0, all);
      if (to <= s.current || (to - s.current < s.minRaise && to < all)) throw new Error(`Minimum raise is to ${s.current + s.minRaise}`);
      if (to - s.current >= s.minRaise) { s.minRaise = to - s.current; s.acted.fill(false); }
      s.current = to;
      put(s, seat, to - s.bets[seat]);
      s.log.push(`${name} ${s.allin[seat] ? 'goes ALL IN' : 'raises'} to ${to}`);
      break;
    }
    default: throw new Error('Unknown move');
  }
  s.acted[seat] = true;
  advance(s, seat);
}

const turn = s => (s.result ? null : s.turn);

// A player left mid-hand: their hand folds now (they lose only what's already in the pot).
function forfeit(s, seat) {
  if (s.result || s.folded[seat]) return;
  if (s.turn === seat) return act(s, seat, { type: 'fold' });
  s.folded[seat] = true;
  s.log.push(`${s.names[seat]} left and folds`);
  if (seats(s).filter(i => !s.folded[i]).length === 1) finish(s); // everyone else is gone: last player wins the pot
}

function botAct(s, seat) {
  const toCall = s.current - s.bets[seat], h = s.hole[seat], r = Math.random();
  let str;
  if (!s.board.length) {
    const [a, b] = h.map(hi);
    str = a === b ? 0.5 + a / 28 : (a + b) / 40 + (h[0][1] === h[1][1] ? 0.05 : 0);
  } else str = best([...h, ...s.board])[0] / 4 + 0.1;
  if (str > 0.7 && r < 0.6 && s.bets[seat] + s.stacks[seat] > s.current) return { type: 'raise', to: s.current + Math.max(s.minRaise, s.bet * 2) };
  if (!toCall) return { type: 'check' };
  if (str > 0.35 || (toCall <= s.bet && r < 0.5)) return { type: 'call' };
  return { type: 'fold' };
}
const timeoutAct = (s, seat) => ({ type: s.current > s.bets[seat] ? 'fold' : 'check' });

function view(s, seat) {
  const show = s.result?.showdown;
  return {
    hole: s.hole.map((h, i) => (i === seat || (show && !s.folded[i]) ? h : ['??', '??'])),
    board: s.board, stacks: s.stacks, bets: s.bets, folded: s.folded, allin: s.allin, dealer: s.dealer,
    turn: s.turn, pot: s.contrib.reduce((a, b) => a + b, 0), toCall: s.current - s.bets[seat],
    minTo: s.current + s.minRaise, maxTo: s.bets[seat] + s.stacks[seat], log: s.log.slice(-6), result: s.result,
    myHand: s.hole[seat] && s.board.length >= 3 && !s.folded[seat] ? NAMES[best([...s.hole[seat], ...s.board])[0]] : null,
  };
}

// stake = the stack you sit with (start() uses the same min), the most you can lose in one hand.
module.exports = { min: 2, max: 6, minChips: bet => bet * 2, stake: (bet, chips) => Math.min(chips, bet * 50), start, act, turn, botAct, timeoutAct, forfeit, view, score5, best, cmp };
