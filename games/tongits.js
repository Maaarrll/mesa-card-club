// Tongits, 3 players, standard rules: draw or take the discard (only into a meld), lay melds,
// sapaw onto any meld, discard. Empty hand = Tongits. Call "Draw" to fight on lowest points.
const { deck, shuffle, rank, suit, pretty } = require('./cards');

const points = c => Math.min(rank(c), 10);
const handPoints = h => h.reduce((t, c) => t + points(c), 0);
const sortCards = cs => cs.sort((a, b) => rank(a) - rank(b) || suit(a).localeCompare(suit(b)));

function isMeld(cards) {
  if (cards.length < 3 || new Set(cards).size !== cards.length || cards.some(c => rank(c) < 1)) return false;
  const rs = cards.map(rank).sort((a, b) => a - b);
  if (cards.length <= 4 && rs.every(r => r === rs[0])) return true; // set
  return cards.every(c => suit(c) === suit(cards[0])) && rs.every((r, i) => !i || r === rs[i - 1] + 1); // run, ace low
}

function candidates(hand) {
  const out = [], byRank = {};
  for (const c of hand) (byRank[rank(c)] ||= []).push(c);
  for (const g of Object.values(byRank)) {
    if (g.length >= 3) out.push(g);
    if (g.length === 4) g.forEach(x => out.push(g.filter(y => y !== x)));
  }
  for (const s of 'SHDC') {
    const has = new Map(hand.filter(c => suit(c) === s).map(c => [rank(c), c]));
    for (let a = 1; a <= 11; a++) {
      const run = [];
      for (let r = a; r <= 13 && has.has(r); r++) {
        run.push(has.get(r));
        if (run.length >= 3) out.push([...run]);
      }
    }
  }
  return out;
}

// Melds that leave the fewest deadwood points.
function bestMelds(hand) {
  const cands = candidates(hand);
  let best = { melds: [], dead: handPoints(hand) };
  const used = new Set(), melds = [];
  (function go(from) {
    const dead = handPoints(hand.filter(c => !used.has(c)));
    if (dead < best.dead) best = { melds: [...melds], dead };
    for (let k = from; k < cands.length; k++) {
      if (cands[k].some(c => used.has(c))) continue;
      cands[k].forEach(c => used.add(c)); melds.push(cands[k]);
      go(k + 1);
      cands[k].forEach(c => used.delete(c)); melds.pop();
    }
  })(0);
  return best;
}

function start(players, bet, round = 0) {
  const dealer = round % 3, d = shuffle(deck());
  const hands = players.map((_, i) => sortCards(d.splice(0, i === dealer ? 13 : 12)));
  return {
    bet, names: players.map(p => p.name), hands, stock: d, discard: [], melds: [],
    turn: dealer, phase: 'play', exposed: [false, false, false], sapawed: [false, false, false],
    fight: null, log: [`${players[dealer].name} is dealer and plays first`], result: null,
  };
}

function finish(s, winner, how) {
  const deltas = [0, 0, 0];
  s.hands.forEach((_, i) => {
    if (i === winner) return;
    const pay = s.bet * (how === 'tongits' ? 2 : 1) * (how === 'stock' && !s.exposed[i] ? 2 : 1);
    deltas[i] -= pay; deltas[winner] += pay;
  });
  const n = s.names[winner], pts = handPoints(s.hands[winner]);
  const text = how === 'tongits' ? `${n} TONGITS! (double pay)`
    : how === 'draw' ? `${n} wins the Draw with ${pts} points`
    : `Stock ran out: ${n} wins with ${pts} points (players with no meld are burned, pay double)`;
  s.result = { winner, how, deltas, text };
  s.phase = 'over';
  s.log.push(text);
}

function settleFight(s) {
  const { caller, fighters } = s.fight, pts = s.hands.map(handPoints);
  const low = Math.min(...[caller, ...fighters].map(i => pts[i]));
  finish(s, fighters.find(f => pts[f] === low) ?? caller, 'draw'); // tie goes to the challenger
}

function endByCount(s) {
  const order = [1, 2, 3].map(k => (s.turn + k) % 3);
  const pool = order.filter(i => s.exposed[i]);
  const cand = pool.length ? pool : order;
  finish(s, cand.reduce((b, i) => (handPoints(s.hands[i]) < handPoints(s.hands[b]) ? i : b)), 'stock');
}

function act(s, seat, a) {
  if (s.result) throw new Error('This round is over');
  const hand = s.hands[seat], name = s.names[seat], cs = Array.isArray(a.cards) ? a.cards : [];
  const fromHand = cards => {
    if (!cards.length || !cards.every(c => hand.includes(c)) || new Set(cards).size !== cards.length) throw new Error('Pick cards from your hand');
    cards.forEach(c => hand.splice(hand.indexOf(c), 1));
  };
  const layDown = cards => { s.melds.push({ owner: seat, cards: sortCards([...cards]) }); s.exposed[seat] = true; };
  const checkOut = () => { if (!hand.length) finish(s, seat, 'tongits'); };

  if (s.phase === 'fight') {
    if (s.fight.pending[0] !== seat) throw new Error('Waiting for another player');
    if (a.type !== 'fight' && a.type !== 'fold') throw new Error('Choose Fight or Fold');
    s.last = seat;
    s.fight.pending.shift();
    if (a.type === 'fight') s.fight.fighters.push(seat);
    s.log.push(`${name} ${a.type === 'fight' ? 'fights!' : 'folds'}`);
    if (!s.fight.pending.length) settleFight(s);
    return;
  }
  if (s.turn !== seat) throw new Error('Not your turn');
  s.last = seat; // display only: where moved cards fly from
  const need = p => { if (s.phase !== p) throw new Error(p === 'draw' ? 'You already drew this turn' : 'Draw a card first'); };

  switch (a.type) {
    case 'call': {
      need('draw');
      if (!s.exposed[seat]) throw new Error('You need your own meld on the table to call Draw');
      if (s.sapawed[seat]) throw new Error('Someone sapaw-ed your meld, so you cannot call Draw this turn');
      s.log.push(`${name} calls DRAW!`);
      const others = [1, 2].map(k => (seat + k) % 3);
      others.filter(i => !s.exposed[i]).forEach(i => s.log.push(`${s.names[i]} has no meld and must fold`));
      s.phase = 'fight';
      s.fight = { caller: seat, pending: others.filter(i => s.exposed[i]), fighters: [] };
      if (!s.fight.pending.length) settleFight(s);
      return;
    }
    case 'draw':
      need('draw');
      hand.push(s.stock.pop());
      s.phase = 'play';
      s.log.push(`${name} draws from the stock`);
      return;
    case 'pick': {
      need('draw');
      const top = s.discard.at(-1);
      if (!top) throw new Error('The discard pile is empty');
      if (!isMeld([...cs, top])) throw new Error(`Select cards that make a meld with ${pretty(top)}`);
      fromHand(cs);
      s.discard.pop();
      layDown([...cs, top]);
      s.phase = 'play';
      s.log.push(`${name} takes ${pretty(top)} and melds`);
      return checkOut();
    }
    case 'meld':
      need('play');
      if (!isMeld(cs)) throw new Error('Not a valid meld (3-4 of a kind, or 3+ in a row of one suit)');
      fromHand(cs);
      layDown(cs);
      s.log.push(`${name} lays down ${cs.map(pretty).join(' ')}`);
      return checkOut();
    case 'sapaw': {
      need('play');
      const m = Number.isInteger(a.meld) && s.melds[a.meld];
      if (!m) throw new Error('Tap a meld on the table first');
      if (!cs.length || !isMeld([...m.cards, ...cs])) throw new Error('Those cards do not fit that meld');
      fromHand(cs);
      m.cards = sortCards([...m.cards, ...cs]);
      if (m.owner !== seat) s.sapawed[m.owner] = true;
      s.log.push(`${name} sapaw ${cs.map(pretty).join(' ')} on ${s.names[m.owner]}'s meld`);
      return checkOut();
    }
    case 'discard':
      need('play');
      if (!hand.includes(a.card)) throw new Error('Select one card to discard');
      fromHand([a.card]);
      s.discard.push(a.card);
      s.sapawed[seat] = false;
      s.log.push(`${name} discards ${pretty(a.card)}`);
      if (!hand.length) return finish(s, seat, 'tongits');
      if (!s.stock.length) return endByCount(s);
      s.turn = (seat + 1) % 3;
      s.phase = 'draw';
      return;
  }
  throw new Error('Unknown move');
}

const turn = s => (s.result ? null : s.phase === 'fight' ? s.fight.pending[0] : s.turn);

function botAct(s, seat) {
  const hand = s.hands[seat];
  if (s.phase === 'fight') return { type: handPoints(hand) <= 12 ? 'fight' : 'fold' };
  if (s.phase === 'draw') {
    if (s.exposed[seat] && !s.sapawed[seat] && handPoints(hand) <= 9) return { type: 'call' };
    const top = s.discard.at(-1);
    const m = top && bestMelds([...hand, top]).melds.find(x => x.includes(top));
    return m ? { type: 'pick', cards: m.filter(c => c !== top) } : { type: 'draw' };
  }
  const m = bestMelds(hand).melds[0];
  if (m) return { type: 'meld', cards: m };
  for (const c of hand) for (let i = 0; i < s.melds.length; i++) {
    if (isMeld([...s.melds[i].cards, c])) return { type: 'sapaw', cards: [c], meld: i };
  }
  return { type: 'discard', card: bestDiscard(hand) };
}
// The costly card with the fewest neighbours (pairs / near-runs).
function bestDiscard(hand) {
  const near = c => hand.filter(o => o !== c && (rank(o) === rank(c) || (suit(o) === suit(c) && Math.abs(rank(o) - rank(c)) <= 2))).length;
  const cost = c => points(c) - 5 * near(c);
  return hand.reduce((b, c) => (cost(c) > cost(b) ? c : b));
}
// A player who ran out of time: the safest moves only (never calls Draw or melds for them).
function timeoutAct(s, seat) {
  if (s.phase === 'fight') return { type: 'fold' };
  if (s.phase === 'draw') return { type: 'draw' };
  return { type: 'discard', card: bestDiscard(s.hands[seat]) };
}

function view(s, seat) {
  return {
    hand: s.hands[seat], counts: s.hands.map(h => h.length), stock: s.stock.length,
    top: s.discard.at(-1) || null, melds: s.melds, turn: s.turn, phase: s.phase, exposed: s.exposed,
    canCall: s.phase === 'draw' && s.turn === seat && s.exposed[seat] && !s.sapawed[seat],
    points: handPoints(s.hands[seat]), fight: s.fight, log: s.log.slice(-6), last: s.last ?? s.turn,
    suggest: bestMelds(s.hands[seat]).melds,
    result: s.result && { ...s.result, hands: s.hands, points: s.hands.map(handPoints) },
  };
}

module.exports = {
  // stake = held while the round runs; covers the worst loss (2x bet for Tongits or burned).
  min: 3, max: 3, minChips: bet => bet * 4, stake: bet => bet * 4,
  start, act, turn, botAct, timeoutAct, view, isMeld, bestMelds, handPoints,
};
