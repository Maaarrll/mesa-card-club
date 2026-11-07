const crypto = require('crypto');

const RANKS = 'A23456789TJQK';
const SUITS = 'SHDC';
// A card is a 2-char string: rank + suit, e.g. "TD" = 10 of diamonds.
const deck = () => [...SUITS].flatMap(s => [...RANKS].map(r => r + s));
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const rank = c => RANKS.indexOf(c[0]) + 1; // A=1 .. K=13
const suit = c => c[1];
const pretty = c => (c[0] === 'T' ? '10' : c[0]) + { S: '♠', H: '♥', D: '♦', C: '♣' }[c[1]];

module.exports = { deck, shuffle, rank, suit, pretty };
