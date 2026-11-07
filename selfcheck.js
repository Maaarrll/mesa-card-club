// npm run check: rule checks plus thousands of all-bot rounds. Exits non-zero on failure.
const assert = require('assert');
const tongits = require('./games/tongits');
const poker = require('./games/poker');
const blackjack = require('./games/blackjack');

// Tongits melds
assert(tongits.isMeld(['5H', '5S', '5D']));
assert(tongits.isMeld(['AH', '2H', '3H', '4H']));
assert(!tongits.isMeld(['QH', 'KH', 'AH']), 'ace is low only');
assert(!tongits.isMeld(['5H', '6S', '7H']));
assert(!tongits.isMeld(['5H', '5H', '5S']));
assert.equal(tongits.bestMelds(['5H', '6H', '7H', '9S', '9D', '9C', 'KS']).dead, 10);

// Poker hand order
const s = cs => poker.score5(cs.split(' '));
assert(poker.cmp(s('9H TH JH QH KH'), s('AS AH AD AC KD')) > 0);
assert(poker.cmp(s('AS 2D 3H 4C 5S'), s('2S 3D 4H 5C 6S')) < 0, 'wheel is the lowest straight');
assert(poker.cmp(s('KS KD 2H 2C 3S'), s('QS QD JH JC AS')) > 0);
assert(poker.cmp(s('AS AD 9H 8C 7S'), s('AH AC 9D 8S 6S')) > 0);

const bots = n => Array.from({ length: n }, (_, i) => ({ name: 'P' + i, chips: [300, 1000, 5000][i % 3] }));
function play(game, players, bet, round) {
  const st = game.start(players, bet, round);
  for (let steps = 0; !st.result; steps++) {
    assert(steps < 5000, 'round never ended');
    const seat = game.turn(st);
    game.act(st, seat, game.botAct(st, seat));
  }
  return st;
}

for (let i = 0; i < 1500; i++) {
  const t = play(tongits, bots(3), 10, i);
  assert.equal(t.result.deltas.reduce((a, b) => a + b, 0), 0);
  const all = [...t.hands.flat(), ...t.stock, ...t.discard, ...t.melds.flatMap(m => m.cards)];
  assert.equal(new Set(all).size, 52, 'tongits lost or duplicated a card');
  t.melds.forEach(m => assert(tongits.isMeld(m.cards)));
  assert(Math.max(...t.result.deltas.map(Math.abs)) <= tongits.minChips(10));

  const n = 2 + (i % 5), p = play(poker, bots(n), 10, i);
  assert.equal(p.result.deltas.reduce((a, b) => a + b, 0), 0, 'poker chips not conserved');
  p.stacks.forEach(x => assert(x >= 0));

  const b = play(blackjack, bots(1 + (i % 5)), 10, i);
  b.result.deltas.forEach((d, s) => assert(-d <= blackjack.stake(10, bots(5)[s].chips), 'blackjack loss above the held stake'));
}

// A player who keeps timing out (seat 0) still plays legal moves until the round ends.
for (let i = 0; i < 300; i++) {
  const t = tongits.start(bots(3), 10, i);
  for (let steps = 0; !t.result; steps++) {
    assert(steps < 5000);
    const seat = tongits.turn(t);
    tongits.act(t, seat, (seat === 0 ? tongits.timeoutAct : tongits.botAct)(t, seat));
  }
  // No round can cost more than the stake held for it.
  t.result.deltas.forEach(d => assert(d >= -tongits.stake(10)));
}

// Side pot: short stack all-in can win at most what each opponent matched.
for (let i = 0; i < 300; i++) {
  const p = poker.start([{ name: 'short', chips: 100 }, { name: 'b', chips: 1e4 }, { name: 'c', chips: 1e4 }], 10, i);
  while (!p.result) poker.act(p, p.turn, { type: 'allin' });
  assert(p.result.deltas[0] <= 200 && p.result.deltas[0] >= -100);
  assert.equal(p.result.deltas.reduce((a, b) => a + b, 0), 0);
}

// Blackjack betting: chips add up, the cap holds, cards come only after everyone locks in.
{
  const b = blackjack.start([{ name: 'me', chips: 300 }, { name: 'bot', bot: true, chips: Infinity }]);
  assert.equal(b.phase, 'bet');
  assert(b.ready[1] && b.bets[1] > 0, 'bot bets by itself');
  assert.throws(() => blackjack.act(b, 0, { type: 'deal' }), /chip/);
  blackjack.act(b, 0, { type: 'chip', value: 100 });
  blackjack.act(b, 0, { type: 'chip', value: 50 });
  assert.throws(() => blackjack.act(b, 0, { type: 'chip', value: 10 }), /max bet is 150/);
  assert.throws(() => blackjack.act(b, 0, { type: 'chip', value: 7 }));
  blackjack.act(b, 0, { type: 'clear' });
  blackjack.act(b, 0, { type: 'chip', value: 50 });
  assert.equal(b.hands[0].length, 0, 'no cards before the bets are in');
  blackjack.act(b, 0, { type: 'deal' });
  assert.equal(b.bets[0], 50);
  assert(b.phase === 'play' && b.hands[0].length === 2 && b.dealer.length >= 2);
  assert.equal(blackjack.stake(10, 300), 300);
  assert.equal(blackjack.stake(10, 5000), 1000);
}

// Tongits with 2 players plays to the end, cards conserved, coins zero-sum.
let tongitsWins = 0;
for (let i = 0; i < 800; i++) {
  const t2 = play(tongits, bots(2), 10, i);
  assert.equal(t2.hands.length, 2);
  assert.equal(new Set([...t2.hands.flat(), ...t2.stock, ...t2.discard, ...t2.melds.flatMap(m => m.cards)]).size, 52);
  assert.equal(t2.result.deltas.reduce((a, b) => a + b, 0), 0);
  if (t2.result.how === 'tongits') tongitsWins++;
}
assert(tongitsWins > 0, 'bots should sometimes go out (Tongits) in 2-player games');

// Recognising Tongits: planOut finds a way to empty the hand, including sapaw and a final discard.
{
  const P = tongits.planOut;
  assert(P(['5H', '5S', '5D', '7C', '8C', '9C'], []), 'two melds, nothing left');
  assert.equal(P(['5H', '5S', '5D', '7C', '8C', '9C', 'KD'], []).discard, 'KD', 'one loose card is the final discard');
  assert.equal(P(['5H', '5S', '5D', 'KD', 'QH'], []), null, 'two loose cards: cannot go out');
  const table = [{ owner: 1, cards: ['JH', 'QH', 'KH'] }];
  const p = P(['5H', '5S', '5D', 'TH', '2C'], table);
  assert(p && p.sapaws.some(x => x.card === 'TH' && x.meldIndex === 0) && p.discard === '2C', 'sapaw 10H onto J-Q-K hearts, discard 2C');
  // A split that bestMelds would not choose: 4-4-4-4 + 5-6 of spades needs the 4S in the run.
  assert(P(['4H', '4D', '4C', '4S', '5S', '6S'], []), 'finds 4H 4D 4C + 4S 5S 6S');

  // The one-tap move empties the hand and ends the round as Tongits; the opponent's meld counts as sapaw-ed.
  const s = tongits.start(bots(2), 10, 0);
  s.hands[0] = ['5H', '5S', '5D', 'TH', '2C']; s.melds = [{ owner: 1, cards: ['JH', 'QH', 'KH'] }]; s.exposed[1] = true;
  assert.equal(tongits.view(s, 0).hints.tongits, true);
  tongits.act(s, 0, { type: 'tongits' });
  assert.equal(s.result.how, 'tongits'); assert.equal(s.hands[0].length, 0);
  assert.deepEqual(s.melds[0].cards, ['TH', 'JH', 'QH', 'KH']); assert.equal(s.discard.at(-1), '2C');
  assert.equal(s.result.deltas[0], 20, 'Tongits pays double');

  // Hints: green melds, blue sapaw with its target, orange burn, and the discard pick when drawing.
  const h = tongits.start(bots(2), 10, 0);
  h.hands[0] = ['5H', '5S', '5D', 'TH', 'KD', '2C']; h.melds = [{ owner: 1, cards: ['JH', 'QH', 'KH'] }];
  const hv = tongits.view(h, 0).hints;
  assert.deepEqual(hv.melds, [['5H', '5S', '5D']]);
  assert.deepEqual(hv.sapaw, [{ card: 'TH', meld: 0 }]);
  assert.equal(hv.burn, 'KD', 'burn the costly loose card'); assert.equal(hv.tongits, false);
  h.turn = 0; h.phase = 'draw'; h.discard = ['5C'];
  assert.deepEqual(tongits.view(h, 0).hints.pick.sort(), ['5D', '5H', '5S']);
  assert.equal(tongits.view(h, 1).hints, null, 'no hints when it is not your turn');
}

// Scores count only cards that are not part of a meld.
{
  assert.equal(tongits.score(['KH', 'KS', 'KD', '7C', '8C', '9C', '2H', '3S']), 5, 'K-K-K and 7-8-9 are free: only 2 + 3 count');
  assert.equal(tongits.score(['QH', 'KS', 'AD']), 21, 'no meld: everything counts (10 + 10 + 1)');
  assert.equal(tongits.score(['4H', '4D', '4C', '4S', '5S', '6S']), 0, 'all cards in melds: score 0');
  const s = tongits.start(bots(2), 10, 0);
  s.hands[0] = ['KH', 'KS', 'KD', '2H']; // 33 counting everything, 2 counting only loose cards
  s.hands[1] = ['5H', '6C'];             // 11
  assert.equal(tongits.view(s, 0).points, 2, 'your score badge shows only unmatched cards');
  s.turn = 0; s.phase = 'draw'; s.exposed = [true, true];
  tongits.act(s, 0, { type: 'call' });
  tongits.act(s, 1, { type: 'fight' });
  assert.equal(s.result.winner, 0, 'Draw is won on unmatched points: 2 beats 11');
  assert.deepEqual(tongits.view(s, 0).result.points, [2, 11]);
}

// Illegal moves are rejected and leave state unchanged.
const t = tongits.start(bots(3), 10, 0);
assert.throws(() => tongits.act(t, 1, { type: 'draw' }), /Not your turn/);
assert.throws(() => tongits.act(t, 0, { type: 'meld', cards: ['XX', 'YY', 'ZZ'] }));
assert.throws(() => tongits.act(t, 0, { type: 'call' }), /already drew/);
assert.equal(t.hands[0].length, 13);

console.log('selfcheck ok');
