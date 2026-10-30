/* Headless balance check for Tayak Tartysh.
   Runs the pure simulation from game.js with scripted tap patterns.

   Node:            node tests/balance.js
   macOS (no Node): sh tests/run-jsc.sh        (uses the built-in JavaScriptCore)
*/
(function () {
'use strict';

const sim = typeof require === 'function' ? require('../game.js') : globalThis.TAYAK_SIM;
const log = typeof console !== 'undefined' ? console.log : print; // eslint-disable-line no-undef
const { BALANCE, AIState, createRound, registerPull, stepRound } = sim;

const ROUNDS = 400;      // rounds per (difficulty, pattern)
const DT = 1 / 60;
const TIMEOUT = 120;     // seconds; a round this long counts as a loss

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A pattern returns the player's intended tap rate (taps/s) for the current moment.
const PATTERNS = {
  'steady 4 t/s': () => 4,
  'steady 6 t/s': () => 6,
  'all-out 8 t/s': () => 8,
  'smart (4.5 + bursts)': (r) => (r.ai && r.ai.state === AIState.RECOVERY ? 8 : 4.5)
};

function playRound(difficulty, pattern, seed) {
  const rng = mulberry32(seed);
  const human = mulberry32(seed ^ 0x9e3779b9); // tap timing jitter, ±10% like a real thumb
  const r = createRound(difficulty, { mode: '1p', rng });
  let nextTap = 0.05;
  let tiredAt = null;
  while (!r.winner && r.time < TIMEOUT) {
    if (r.time >= nextTap) {
      registerPull(r, 'left');
      nextTap = r.time + (1 / pattern(r)) * (0.9 + human() * 0.2);
    }
    stepRound(r, DT);
    if (tiredAt === null && r.left.tired) tiredAt = r.time;
  }
  return { won: r.winner === 'left', time: r.time, tiredAt };
}

function pct(x) { return (x * 100).toFixed(0).padStart(3) + '%'; }
function median(a) { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }

function staminaReport() {
  for (const mode of ['1p', '2p']) {
    const probe = createRound('easy', { mode, rng: mulberry32(1) });
    const S = probe.stamina;
    log(`STAMINA (${mode === '1p' ? '1 player' : '2 players'})`);
    for (const rate of [6, 7, 7.5, 8]) {
      // tap at a fixed rate with the stick held in the middle, so only stamina matters
      const r = createRound('easy', { mode, rng: mulberry32(1) });
      r.roundTime = Infinity; // no 2-player timer while measuring
      let next = 0;
      while (!r.left.tired && r.time < 300) {
        if (r.time >= next) { registerPull(r, 'left'); next = r.time + 1 / rate; }
        r.pullPosition = 0; r.pullVelocity = 0;
        stepRound(r, DT);
      }
      log(`  full stamina lasts ${r.left.tired ? r.time.toFixed(1) + ' s' : '> 300 s'} at ${rate} taps/s`);
    }
    for (const rate of [4, 4.5, 5]) {
      const drainPerSec = Math.max(0, rate - S.freeRate) * S.drainPerExcess * rate;
      log(`  ${rate} taps/s: ${drainPerSec ? 'empties in ' + (S.max / drainPerSec).toFixed(0) + ' s' : 'free'}`);
    }
    log(`  empty → full: ${(S.max / S.regenRate).toFixed(1)} s (+${S.regenDelay} s pause before refilling)`);
    log(`  tired: pull strength x${S.tiredMultiplier} until stamina is back above ${S.recoverAt}`);
  }
}

function balanceReport() {
  log('\nWIN RATES vs AI   (round win %, best-of-3 match win %, median round length, median time until tired)');
  for (const difficulty of ['easy', 'medium', 'hard']) {
    log(`\n${difficulty.toUpperCase()}`);
    for (const [name, pattern] of Object.entries(PATTERNS)) {
      const res = [];
      for (let i = 0; i < ROUNDS; i++) res.push(playRound(difficulty, pattern, 1000 + i * 7919));
      const p = res.filter((x) => x.won).length / ROUNDS;
      const match = p * p * (3 - 2 * p);
      const tired = res.filter((x) => x.tiredAt !== null).map((x) => x.tiredAt);
      const tiredTxt = tired.length ? `tired after ${median(tired).toFixed(0)} s in ${pct(tired.length / ROUNDS)} of rounds` : 'never tired';
      log(`  ${name.padEnd(22)} round ${pct(p)}   match ${pct(match)}   ${median(res.map((x) => x.time)).toFixed(1).padStart(5)} s   ${tiredTxt}`);
    }
  }
}

function twoPlayerReport() {
  log('\n2 PLAYERS   (median round length, % decided by the timer, how often Player 1 wins)');
  // a player is a tap rate (taps/s) that may depend on the situation, plus a start delay
  const steady = (rate, start = 0) => ({ rate: () => rate, start });
  const smart = () => ({ rate: (me, them) => (them.tired || me.stamina > 70 ? 8 : 5), start: 0 });
  const matchups = [
    ['equal 5 vs 5', steady(5), steady(5)],
    ['equal 6 vs 6', steady(6), steady(6)],
    ['P1 starts 0.4 s early', steady(5), steady(5, 0.4)],
    ['P1 5 vs P2 5.5', steady(5), steady(5.5)],
    ['P1 5 vs P2 6', steady(5), steady(6)],
    ['P1 sprints 8 vs steady 5.5', steady(8), steady(5.5)],
    ['P1 smart vs sprinter 8', smart(), steady(8)]
  ];
  for (const [label, A, C] of matchups) {
    const times = []; let p1 = 0, timeUps = 0;
    for (let i = 0; i < ROUNDS; i++) {
      const seed = 500 + i * 7919, rng = mulberry32(seed), hA = mulberry32(seed ^ 0x1234), hB = mulberry32(seed ^ 0x9876);
      const r = createRound(null, { mode: '2p', rng });
      let nA = 0.05 + A.start + hA() * 0.1, nB = 0.05 + C.start + hB() * 0.1;
      while (!r.winner && r.time < TIMEOUT) {
        if (r.time >= nA) { registerPull(r, 'left'); nA = r.time + (1 / A.rate(r.left, r.right)) * (0.88 + hA() * 0.24); }
        if (r.time >= nB) { registerPull(r, 'right'); nB = r.time + (1 / C.rate(r.right, r.left)) * (0.88 + hB() * 0.24); }
        stepRound(r, DT);
      }
      if (r.winner === 'left') p1++;
      if (r.timeUp) timeUps++;
      times.push(r.time);
    }
    log(`  ${label.padEnd(28)} ${median(times).toFixed(1).padStart(4)} s   timer ${pct(timeUps / ROUNDS)}   P1 wins ${pct(p1 / ROUNDS)}`);
  }
}

staminaReport();
balanceReport();
twoPlayerReport();
})();
