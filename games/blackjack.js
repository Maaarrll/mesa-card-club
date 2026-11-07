// Blackjack vs the dealer. 4-deck shoe, dealer stands on 17, blackjack pays 3:2, no split.
// Each round starts with a betting step: every player taps chips for their own bet, then the cards are dealt.
const { deck, shuffle, rank, pretty } = require('./cards');

const CHIPS = [10, 50, 100];
const MAX_BET = 500;
// Biggest bet a player can place: half their coins, so a doubled losing hand is always covered.
const maxBet = chips => Math.min(MAX_BET, Math.floor(chips / 2));

function total(h) {
  let t = 0, aces = 0;
  for (const c of h) { const r = rank(c); t += r === 1 ? 11 : Math.min(r, 10); if (r === 1) aces++; }
  while (t > 21 && aces--) t -= 10;
  return t;
}
const natural = h => h.length === 2 && total(h) === 21;

function start(players) {
  const s = {
    phase: 'bet', names: players.map(p => p.name), shoe: shuffle([...deck(), ...deck(), ...deck(), ...deck()]),
    max: players.map(p => maxBet(p.chips)), hands: players.map(() => []), dealer: [], done: [],
    // Bots pick a bet right away; people tap chips.
    bets: players.map(p => (p.bot ? CHIPS[Math.floor(Math.random() * CHIPS.length)] : 0)),
    ready: players.map(p => !!p.bot), log: ['Place your bets!'], result: null, turn: null,
  };
  if (s.ready.every(Boolean)) deal(s);
  return s;
}

function deal(s) {
  s.phase = 'play';
  s.hands = s.hands.map(() => [s.shoe.pop(), s.shoe.pop()]);
  s.dealer = [s.shoe.pop(), s.shoe.pop()];
  s.done = s.hands.map(natural);
  if (natural(s.dealer)) s.done.fill(true);
  s.log.push('Cards are dealt');
  next(s, -1);
}

function next(s, from) {
  for (let i = from + 1; i < s.hands.length; i++) if (!s.done[i]) { s.turn = i; return; }
  s.turn = null;
  if (!natural(s.dealer)) while (total(s.dealer) < 17) s.dealer.push(s.shoe.pop());
  const d = total(s.dealer);
  const outcome = s.hands.map((h, i) => {
    const p = total(h), b = s.bets[i];
    if (p > 21) return ['Bust', -b];
    if (natural(h) && !natural(s.dealer)) return ['Blackjack!', Math.floor(b * 1.5)];
    if (natural(s.dealer) && !natural(h)) return ['Dealer blackjack', -b];
    if (d > 21 || p > d) return ['Win', b];
    return p < d ? ['Lose', -b] : ['Push', 0];
  });
  s.result = {
    deltas: outcome.map(o => o[1]), outcome: outcome.map(o => o[0]),
    text: `Dealer has ${d > 21 ? 'BUST (' + d + ')' : d}`,
  };
}

function act(s, seat, a) {
  if (s.result) throw new Error('This round is over');
  const name = s.names[seat];
  if (s.phase === 'bet') {
    // Everyone bets at the same time, so no turn check here.
    if (s.ready[seat]) throw new Error('Your bet is in. Waiting for the others.');
    switch (a.type) {
      case 'chip': {
        const v = Number(a.value);
        if (!CHIPS.includes(v)) throw new Error('Pick a 10, 50 or 100 chip');
        if (s.bets[seat] + v > s.max[seat]) throw new Error(`Your max bet is ${s.max[seat]}`);
        s.bets[seat] += v;
        return;
      }
      case 'clear': s.bets[seat] = 0; return;
      case 'minbet': // ran out of time: the smallest bet, then deal
        if (!s.bets[seat]) s.bets[seat] = CHIPS[0];
      // falls through
      case 'deal':
        if (!s.bets[seat]) throw new Error('Tap a chip to place your bet first');
        s.ready[seat] = true;
        s.log.push(`${name} bets ${s.bets[seat]}`);
        if (s.ready.every(Boolean)) deal(s);
        return;
    }
    throw new Error('Place your bet first');
  }
  if (s.turn !== seat) throw new Error('Not your turn');
  const h = s.hands[seat];
  if (a.type === 'double') {
    if (h.length !== 2) throw new Error('You can only double on your first two cards');
    s.bets[seat] *= 2;
  } else if (a.type !== 'hit' && a.type !== 'stand') throw new Error('Unknown move');
  if (a.type !== 'stand') h.push(s.shoe.pop());
  s.log.push(`${name} ${a.type}s${a.type === 'stand' ? '' : ': ' + pretty(h.at(-1))}`);
  if (a.type !== 'hit' || total(h) >= 21) { s.done[seat] = true; next(s, seat); }
}

// During betting the timer follows the first player who hasn't locked in a bet.
const turn = s => (s.result ? null : s.phase === 'bet' ? s.ready.indexOf(false) : s.turn);
const botAct = (s, seat) => (s.phase === 'bet' ? { type: 'minbet' } : { type: total(s.hands[seat]) < 17 ? 'hit' : 'stand' });
const timeoutAct = s => ({ type: s.phase === 'bet' ? 'minbet' : 'stand' });

function view(s, seat) {
  return {
    phase: s.phase, max: s.max[seat], ready: s.ready, chips: CHIPS,
    dealer: s.result || s.phase === 'bet' ? s.dealer : [s.dealer[0], '??'], dealerTotal: s.result ? total(s.dealer) : null,
    hands: s.hands, totals: s.hands.map(total), bets: s.bets, turn: s.turn, log: s.log.slice(-6), result: s.result,
  };
}

// Players bet at the table, so the table "bet" is unused. To sit you need 20 (a 10 bet you can double).
// stake = held while the round runs: covers the biggest bet you may place, doubled.
module.exports = {
  min: 1, max: 5, minChips: () => 20, stake: (bet, chips) => 2 * maxBet(chips), tableBet: false,
  start, act, turn, botAct, timeoutAct, view, total,
};
