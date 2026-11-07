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

// Illegal moves are rejected and leave state unchanged.
const t = tongits.start(bots(3), 10, 0);
assert.throws(() => tongits.act(t, 1, { type: 'draw' }), /Not your turn/);
assert.throws(() => tongits.act(t, 0, { type: 'meld', cards: ['XX', 'YY', 'ZZ'] }));
assert.throws(() => tongits.act(t, 0, { type: 'call' }), /already drew/);
assert.equal(t.hands[0].length, 13);

console.log('selfcheck ok');
