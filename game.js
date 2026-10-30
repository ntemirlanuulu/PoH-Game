/* ==========================================================================
   TAYAK TARTYSH — The Nomadic Pulling Challenge
   Vanilla JS + Canvas 2D + Web Audio. No external assets.

   File layout
     1. Tuning (BALANCE) and state enums
     2. Force simulation + AI state machine + stamina (pure, no DOM; runs in Node too)
     3. bootGame(): rendering, animation, audio, input, UI flow
   UI text lives in strings.js (STRINGS), loaded before this file.
   ========================================================================== */
'use strict';

/* ---------------------------------------------------------------------------
   1. TUNING
   Each human puller's force uses a flat decay PLUS a proportional drag, so the
   steady-state force depends on tap rate:  F ≈ (rate·impulse − decay) / drag
   → 3 t/s ≈ 10.5, 4 t/s ≈ 14.8, 4.5 t/s ≈ 17, 5 t/s ≈ 19.2, 6+ t/s ≈ 24 (cap)

   Stamina (humans only): tapping below stamina.freeRate costs nothing. Above
   it, each tap costs drainPerExcess × (rate − freeRate). At 0 the puller is
   "tired": impulse and force cap drop to tiredMultiplier until stamina climbs
   back past recoverAt. Refill starts regenDelay seconds after the last costly tap.

   Pace (V3.1): the stick moves fast (positionScale) and each AI is weaker, so
   rounds take roughly 9 s on Easy, 13-22 s on Medium and 15-25 s on Hard.
   --------------------------------------------------------------------------- */
const BALANCE = {
  pullImpulse: 2.6,
  forceDecay: 1.5,            // flat decay, force per second
  forceDrag: 0.6,             // proportional decay, 1/second
  maxForce: 20,
  minTapInterval: 0.03,       // ignore key-switch chatter faster than this
  positionScale: 2.2,
  maxPositionSpeed: 28,
  positionDamping: 4,
  roundLimit: 100,
  desperationZone: 72,        // AI may attempt a last stand at pullPosition <= -72
  leverage: 4,                // the wrestler who is ahead gains leverage (breaks stalemates)
  aiForm: 0.08,               // per-round AI strength variation (±)
  aiDrift: 0.1,               // slow strength drift within a round (±)

  stamina: {
    max: 100,
    freeRate: 4,              // taps/s that never cost stamina
    drainPerExcess: 0.45,     // stamina per tap, per tap/s above freeRate
    rateSmoothing: 0.5,      // how fast the tap-rate estimate follows the latest gap
    regenDelay: 0.4,          // seconds after the last costly tap before refilling
    regenRate: 22,            // stamina per second → empty to full ≈ 4.5 s
    tiredMultiplier: 0.6,     // impulse and force cap while tired
    recoverAt: 30             // tired clears above this (hysteresis, no flicker)
  },

  // 2-player mode only. Nothing random and no snowballing: only the taps decide.
  //  - a higher force cap, so faster tapping keeps paying off (skill expression)
  //  - a short stamina pool that refills fast: burst, recover, strike when the
  //    other player is tired
  //  - a capped pull back toward the middle, so a lucky early lead fades but a
  //    genuinely stronger player still drags the stick all the way
  //  - a round timer: when it runs out, whoever has the stick on their side wins
  twoPlayer: {
    maxForce: 30,
    positionScale: 5,         // the stick reacts faster than against the AI
    maxPositionSpeed: 60,
    leverage: 0,              // no snowballing
    centering: 2,             // a small pull back toward the middle, capped at this force...
    centeringWidth: 25,       // ...reached this far from the middle: a head start fades, a stronger player still wins
    gripTime: 1.0,            // after PULL! the stick is held while both players take their grip
    roundTime: 15,            // seconds
    stamina: { freeRate: 4.5, drainPerExcess: 0.9, regenRate: 34, regenDelay: 0.3 }
  },

  ai: {
    easy: {
      baseForce: 7,
      attackBonus: 3,
      attackInterval: [5, 8],
      attackDuration: [0.6, 1.2],
      windup: 0.8,
      recoveryDuration: 1.8,
      recoveryFactor: 0.55,
      wobble: 0.08,
      opportunism: 0.15,
      pounce: 0.2,            // chance per second to attack a tired player
      desperationChance: 0.5,
      desperationLimit: 1,
      desperationWindup: 1.0,
      desperationDuration: 1.1,
      desperationBonus: 1.8
    },
    medium: {
      baseForce: 11.5,
      attackBonus: 5,
      attackInterval: [4, 7],
      attackDuration: [0.8, 1.4],
      windup: 0.65,
      recoveryDuration: 1.7,
      recoveryFactor: 0.55,
      wobble: 0.08,
      opportunism: 0.3,
      pounce: 0.5,
      desperationChance: 0.7,
      desperationLimit: 1,
      desperationWindup: 0.9,
      desperationDuration: 1.3,
      desperationBonus: 1.9
    },
    hard: {
      baseForce: 15,
      attackBonus: 7,
      attackInterval: [3.5, 6],
      attackDuration: [0.8, 1.5],
      windup: 0.55,
      recoveryDuration: 2.2,
      recoveryFactor: 0.45,
      wobble: 0.07,
      opportunism: 0.45,
      pounce: 0.8,
      desperationChance: 0.85,
      desperationLimit: 2,
      desperationWindup: 0.8,
      desperationDuration: 1.3,
      desperationBonus: 2.0
    }
  }
};

const GameState = Object.freeze({
  MENU: 'menu',
  HOW_TO_PLAY: 'how_to_play',
  FAQ: 'faq',
  COUNTDOWN: 'countdown',
  PLAYING: 'playing',
  ROUND_END: 'round_end',
  MATCH_END: 'match_end'
});

const AIState = Object.freeze({
  NORMAL: 'normal',
  ATTACK: 'attack',
  RECOVERY: 'recovery',
  DESPERATION: 'desperation'
});

/* ---------------------------------------------------------------------------
   2. SIMULATION
   One authoritative round object. Everything on screen (stick, bodies, HUD)
   is derived from round.pullPosition and the two forces.
   Sides: 'left' is always a human (blue). 'right' is the AI in 1-player mode
   and a second human in 2-player mode (r.ai is then null).
   --------------------------------------------------------------------------- */
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function lerp(a, b, t) { return a + (b - a) * t; }
function damp(cur, target, rate, dt) { return cur + (target - cur) * (1 - Math.exp(-rate * dt)); }
function randRange(rng, range) { return range[0] + (range[1] - range[0]) * rng(); }

function createPuller() {
  return {
    force: 0,
    stamina: BALANCE.stamina.max,
    tired: false,
    lastTap: -1,
    interval: 0.5,            // smoothed gap between taps (seconds)
    rate: 0,                  // taps per second, from the smoothed gap
    lastDrain: -10            // sim time of the last tap that cost stamina
  };
}

function createAI(cfg, rng) {
  return {
    state: AIState.NORMAL,
    phase: 'idle',
    phaseTime: 0,
    timer: 1.5 + randRange(rng, cfg.attackInterval) * 0.6,
    scanTimer: 1,
    strikeDuration: 0,
    recoveryDuration: cfg.recoveryDuration,
    recoveryFactor: cfg.recoveryFactor,
    desperationUsed: 0,
    dangerRolled: false,
    wobbleSeed: rng() * 100,
    form: 1 + (rng() * 2 - 1) * BALANCE.aiForm,
    driftFreq: 0.55 + rng() * 0.5,
    target: cfg.baseForce
  };
}

/**
 * mode: '1p' (right side is the AI) or '2p' (right side is a second human).
 * difficulty is ignored in 2p.
 */
function createRound(difficulty, { mode = '1p', rng = Math.random } = {}) {
  const twoPlayer = mode === '2p';
  const cfg = twoPlayer ? null : BALANCE.ai[difficulty];
  const TP = BALANCE.twoPlayer;
  return {
    mode,
    difficulty,
    cfg,
    rng,
    stamina: twoPlayer ? Object.assign({}, BALANCE.stamina, TP.stamina) : BALANCE.stamina,
    leverage: twoPlayer ? TP.leverage : BALANCE.leverage,
    centering: twoPlayer ? TP.centering : 0,
    centeringWidth: twoPlayer ? TP.centeringWidth : 1,
    maxForce: twoPlayer ? TP.maxForce : BALANCE.maxForce,
    positionScale: twoPlayer ? TP.positionScale : BALANCE.positionScale,
    maxPositionSpeed: twoPlayer ? TP.maxPositionSpeed : BALANCE.maxPositionSpeed,
    roundTime: twoPlayer ? TP.roundTime : Infinity,
    gripTime: twoPlayer ? TP.gripTime : 0,
    timeUp: false,
    time: 0,
    pullPosition: 0,
    pullVelocity: 0,
    left: createPuller(),
    right: twoPlayer ? createPuller() : null,
    aiForce: twoPlayer ? 0 : cfg.baseForce * 0.85,
    ai: twoPlayer ? null : createAI(cfg, rng),
    winner: null,
    events: []
  };
}

/** Current pulling force of a side (human or AI). */
function sideForce(r, side) {
  if (side === 'left') return r.left.force;
  return r.right ? r.right.force : r.aiForce;
}

/** A valid, fresh tap/press for a human side. Returns false if it was not accepted. */
function registerPull(r, side = 'left') {
  if (r.winner) return false;
  const p = side === 'left' ? r.left : r.right;
  if (!p) return false; // the AI side cannot be pulled for
  const S = r.stamina;
  if (p.lastTap >= 0) p.interval = lerp(p.interval, clamp(r.time - p.lastTap, 0.03, 1), S.rateSmoothing);
  p.lastTap = r.time;
  p.rate = 1 / p.interval;
  const excess = p.rate - S.freeRate;
  if (excess > 0) {
    p.stamina = Math.max(0, p.stamina - S.drainPerExcess * excess);
    p.lastDrain = r.time;
  }
  if (p.stamina <= 0) p.tired = true;
  const k = p.tired ? S.tiredMultiplier : 1;
  // A tired puller already above the lowered cap keeps that force (it decays
  // naturally) but cannot add to it.
  p.force = Math.min(p.force + BALANCE.pullImpulse * k, Math.max(p.force, r.maxForce * k));
  return true;
}

function setAIState(r, state, phase) {
  r.ai.state = state;
  r.ai.phase = phase;
  r.ai.phaseTime = 0;
}

function updateAI(r, dt) {
  const ai = r.ai, cfg = r.cfg, rng = r.rng;
  const base = cfg.baseForce * ai.form * (1 + BALANCE.aiDrift * Math.sin(r.time * ai.driftFreq + ai.wobbleSeed));
  ai.phaseTime += dt;

  // DESPERATION: one roll each time the AI is pushed into the danger zone,
  // capped per round so it can't rubber-band forever.
  if (r.pullPosition > -BALANCE.desperationZone + 12) ai.dangerRolled = false;
  if (ai.state === AIState.NORMAL && !ai.dangerRolled && r.pullPosition <= -BALANCE.desperationZone) {
    ai.dangerRolled = true;
    if (ai.desperationUsed < cfg.desperationLimit && rng() < cfg.desperationChance) {
      ai.desperationUsed++;
      setAIState(r, AIState.DESPERATION, 'windup');
      r.events.push({ type: 'desperationWarn' });
    }
  }

  let target = base;
  let rate = 4;

  switch (ai.state) {
    case AIState.NORMAL: {
      const t = r.time + ai.wobbleSeed;
      target = base * (1 + cfg.wobble * Math.sin(t * 1.25) + cfg.wobble * 0.6 * Math.sin(t * 3.3 + 1.7));
      ai.timer -= dt;
      ai.scanTimer -= dt;
      if (ai.scanTimer <= 0) {
        ai.scanTimer = 1;
        // Opportunism: if the player eases off, strike early.
        if (r.time > 2.5 && r.left.force < base * 0.45 && ai.timer > 0.6 && rng() < cfg.opportunism) ai.timer = 0;
        // Pounce: a tired player is an invitation.
        if (r.left.tired && ai.timer > 0.6 && rng() < cfg.pounce) ai.timer = 0;
      }
      if (ai.timer <= 0) {
        ai.strikeDuration = randRange(rng, cfg.attackDuration);
        setAIState(r, AIState.ATTACK, 'windup');
        r.events.push({ type: 'attackWarn' });
      }
      break;
    }
    case AIState.ATTACK:
      if (ai.phase === 'windup') {
        target = base * 0.9; // coils up: telegraphs the attack and gives a small window
        if (ai.phaseTime >= cfg.windup) {
          ai.phase = 'strike';
          ai.phaseTime = 0;
          r.events.push({ type: 'attackStrike' });
        }
      } else {
        const jolt = ai.phaseTime < 0.2 ? cfg.attackBonus * 0.35 : 0;
        target = base + cfg.attackBonus + jolt;
        rate = 10;
        if (ai.phaseTime >= ai.strikeDuration) {
          ai.recoveryDuration = cfg.recoveryDuration;
          ai.recoveryFactor = cfg.recoveryFactor;
          setAIState(r, AIState.RECOVERY, 'tired');
          r.events.push({ type: 'recovery' });
        }
      }
      break;
    case AIState.DESPERATION:
      if (ai.phase === 'windup') {
        target = base * 0.8;
        if (ai.phaseTime >= cfg.desperationWindup) {
          ai.phase = 'strike';
          ai.phaseTime = 0;
          r.events.push({ type: 'desperationStrike' });
        }
      } else {
        target = base + cfg.attackBonus * cfg.desperationBonus;
        rate = 10;
        if (ai.phaseTime >= cfg.desperationDuration) {
          ai.recoveryDuration = cfg.recoveryDuration * 1.5;
          ai.recoveryFactor = cfg.recoveryFactor * 0.8;
          setAIState(r, AIState.RECOVERY, 'tired');
          r.events.push({ type: 'recovery', big: true });
        }
      }
      break;
    case AIState.RECOVERY:
      target = base * ai.recoveryFactor;
      rate = 5;
      if (ai.phaseTime >= ai.recoveryDuration) {
        ai.timer = randRange(rng, cfg.attackInterval);
        setAIState(r, AIState.NORMAL, 'idle');
        r.events.push({ type: 'recovered' });
      }
      break;
  }

  ai.target = target;
  r.aiForce = damp(r.aiForce, target, rate, dt);
}

function stepPuller(r, p, side, dt) {
  const B = BALANCE, S = r.stamina;
  p.force = Math.max(0, p.force - (B.forceDecay + p.force * B.forceDrag) * dt);
  if (r.time - p.lastDrain >= S.regenDelay) p.stamina = Math.min(S.max, p.stamina + S.regenRate * dt);
  if (p.tired && p.stamina >= S.recoverAt) {
    p.tired = false;
    r.events.push({ type: 'staminaBack', side });
  } else if (p.tired && !p.tiredAnnounced) {
    r.events.push({ type: 'exhausted', side });
  }
  p.tiredAnnounced = p.tired;
}

/** Advance one round by dt seconds. Events raised this step are left in r.events. */
function stepRound(r, dt) {
  r.events.length = 0;
  if (r.winner) return;
  const B = BALANCE;
  r.time += dt;

  if (r.ai) updateAI(r, dt);
  stepPuller(r, r.left, 'left', dt);
  if (r.right) stepPuller(r, r.right, 'right', dt);

  // Positive net force → toward the right side (+100); negative → toward the left (−100).
  // Leverage (1 player): the leader gets a small bonus, which keeps evenly
  // matched rounds from stalling. Centering (2 players): a capped pull back
  // toward the middle, so a lucky early lead fades instead of deciding the round.
  const netForce = sideForce(r, 'right') - sideForce(r, 'left') + r.leverage * (r.pullPosition / B.roundLimit)
    - r.centering * clamp(r.pullPosition / r.centeringWidth, -1, 1);
  // during the grip phase taps build pulling power but the stick stays put, so tapping first is no advantage
  const targetVelocity = r.time < r.gripTime ? 0 : clamp(netForce * r.positionScale, -r.maxPositionSpeed, r.maxPositionSpeed);
  r.pullVelocity += (targetVelocity - r.pullVelocity) * (1 - Math.exp(-B.positionDamping * dt));
  r.pullPosition = clamp(r.pullPosition + r.pullVelocity * dt, -B.roundLimit, B.roundLimit);

  if (r.pullPosition <= -B.roundLimit) {
    r.winner = 'left';
    r.events.push({ type: 'win', winner: 'left' });
  } else if (r.pullPosition >= B.roundLimit) {
    r.winner = 'right';
    r.events.push({ type: 'win', winner: 'right' });
  } else if (r.time >= r.roundTime) {
    // time is up: the stick's side decides (an exact tie goes to whoever pulls harder right now)
    const lean = r.pullPosition || (sideForce(r, 'right') - sideForce(r, 'left')) || 1;
    r.timeUp = true;
    r.winner = lean < 0 ? 'left' : 'right';
    r.events.push({ type: 'win', winner: r.winner, timeUp: true });
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { BALANCE, GameState, AIState, createRound, registerPull, stepRound, sideForce };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootGame);
  else bootGame();
}

/* ---------------------------------------------------------------------------
   3. GAME (browser only)
   --------------------------------------------------------------------------- */
function bootGame() {
  const B = BALANCE;
  const S = GameState;
  const W = 1280, H = 720, TAU = Math.PI * 2;
  const INK = '#2b1a14';
  const FONT = "'Lilita One', 'Rubik', 'Noto Sans SC', 'PingFang SC', 'Arial Black', Impact, sans-serif";

  // Arena coordinates (before the 1.3x arena zoom around the board's foot).
  const ARENA = { groundY: 590, boardX: 640, boardTop: 508, scale: 1.3, stickY: 468, stickRange: 76, stickHalf: 92 };
  const BODY = { torso: 100, neck: 40, headR: 31, upper: 66, fore: 62, thigh: 72, shin: 66 };

  const LOOKS = {
    player: {
      skin: '#f2bf94', skinDark: '#d29b70', outfit: '#2f7ae5', outfitDark: '#1d55b0', outfitLight: '#8cc0ff',
      trim: '#ffd23f', hair: '#1d1a24', style: 'player', browWidth: 4.5
    },
    // Easy: Ermek, a young herder in a white kalpak. Soft colours, rosy cheeks, raised brows.
    ermek: {
      skin: '#f6caa0', skinDark: '#dba57a', outfit: '#ff8a5c', outfitDark: '#d9603a', outfitLight: '#ffd0b8',
      trim: '#fff3c4', hair: '#7a4a26', style: 'ermek', blush: 0.35, browWidth: 3.5, browBias: -1.5
    },
    // Medium: Aibek, the shepherd: red singlet, handlebar moustache, topknot.
    aibek: {
      skin: '#cf9262', skinDark: '#a97046', outfit: '#e0392f', outfitDark: '#a3221c', outfitLight: '#ff9a8a',
      trim: '#ffd23f', hair: '#1a1416', style: 'aibek', browWidth: 6, unibrow: true
    },
    // Hard: Temir, "iron": black singlet with red trim, shaved head, scar, beard, iron wrist wraps.
    temir: {
      skin: '#b98352', skinDark: '#94643c', outfit: '#2d2733', outfitDark: '#16121a', outfitLight: '#8a9099',
      trim: '#e0392f', hair: '#141016', style: 'temir', browWidth: 8, browBias: 2.5, unibrow: true
    }
  };

  /* ---------- DOM ---------- */
  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const canvas = $('game');
  const ctx = canvas.getContext('2d');
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const meterRefs = (el) => ({
    el, key: el.querySelector('.key'), hint: el.querySelector('.hint-text'),
    power: el.querySelector('.power-fill'), tick: el.querySelector('.ai-tick'), rate: el.querySelector('.tap-rate b'),
    stamina: el.querySelector('.stamina-fill'), tired: el.querySelector('.tired-tag')
  });
  const ui = {
    hud: $('hud'), menu: $('menu'), howto: $('howto'), roundEnd: $('roundEnd'), matchEnd: $('matchEnd'),
    countdown: $('countdown'), roundLabel: $('roundLabel'), scoreLabel: $('scoreLabel'),
    playerPips: $('playerPips'), aiPips: $('aiPips'), tug: $('tug'), tugFill: $('tugFill'), tugMarker: $('tugMarker'),
    alert: $('alert'), leftName: $('leftName'), rightName: $('rightName'), rightSub: $('rightSub'),
    rightPlate: document.querySelector('.nameplate.ai'), roundTimer: $('roundTimer'), twoPRule: $('twoPRule'),
    meters: { left: meterRefs($('meterL')), right: meterRefs($('meterR')) },
    touchZones: $('touchZones'), tzLeft: $('tzLeft'), tzRight: $('tzRight'),
    roundTitle: $('roundTitle'), roundSub: $('roundSub'), nextBtn: $('nextBtn'), roundHint: $('roundHint'),
    factCard: $('factCard'), factText: $('factText'),
    matchTitle: $('matchTitle'), matchSub: $('matchSub'), rematchBtn: $('rematchBtn'), menuBtn: $('menuBtn'),
    trophy: $('trophy'), playBtn: $('playBtn'), howBtn: $('howBtn'), backBtn: $('backBtn'), muteBtn: $('muteBtn'),
    modeBtns: $$('.mode-btn'), diffBtns: $$('.diff-btn'), oppStory: $('oppStory'),
    tabs: $$('#howto .tab'), tabPanels: $$('#howto .tab-panel'),
    title: document.querySelector('#menu .title'), howScroll: document.querySelector('#howto .card-scroll'),
    faq: $('faq'), faqBtn: $('faqBtn'), faqBackBtn: $('faqBackBtn'), faqTitle: $('faqTitle'),
    faqItems: $$('.faq-item'), faqList: document.querySelector('#faq .faq-list'),
    lang: $('lang'), langBtn: $('langBtn'), langCode: $('langCode'),
    langItems: $$('#langMenu [data-lang]')
  };

  /* ---------- Languages ---------- */
  // UI text: STRINGS comes from strings.js
  let lang = 'en';
  function t(key, vars) {
    let str = STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
    if (vars) for (const k in vars) str = str.replace(`{${k}}`, vars[k]);
    return str;
  }
  /** Shrink a single-line element's font until it fits maxW stage pixels (long translations). */
  function fitText(el, maxW) {
    el.style.fontSize = '';
    // padding does not shrink with the text, so repeat a few times until it fits
    for (let i = 0; i < 4 && el.scrollWidth > maxW; i++) {
      el.style.fontSize = (parseFloat(getComputedStyle(el).fontSize) * Math.max(0.5, maxW / el.scrollWidth) * 0.98).toFixed(1) + 'px';
    }
  }
  /** The WIN zones are flex boxes, so measure their text with a Range (ratio is unaffected by stage scaling). */
  function fitZones() {
    document.querySelectorAll('.tug-zone').forEach((z) => {
      z.style.fontSize = '';
      const range = document.createRange();
      range.selectNodeContents(z);
      const ratio = range.getBoundingClientRect().width / z.getBoundingClientRect().width;
      if (ratio > 0.84) z.style.fontSize = (parseFloat(getComputedStyle(z).fontSize) * 0.84 / ratio).toFixed(1) + 'px';
    });
  }
  function refit() {
    fitText(ui.title, 1120);
    fitText(ui.faqTitle, 770);
    fitZones();
    document.querySelectorAll('.np-name').forEach((el) => fitText(el, el.parentElement.clientWidth - 24));
    // single-line buttons and labels: shrink long translations instead of clipping them
    document.querySelectorAll('.menu-links .btn, .mode-btn, .tab, .twop-badge, .diff-btn b, .diff-btn .opp-name, .bar-label, .tired-tag')
      .forEach((el) => { if (el.offsetParent) fitText(el, el.clientWidth); });
  }
  function applyLang(code) {
    lang = STRINGS[code] ? code : 'en';
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
    ui.muteBtn.title = t('muteTitle');
    ui.muteBtn.setAttribute('aria-label', t('muteTitle'));
    ui.langCode.textContent = t('code');
    ui.langItems.forEach((b) => b.classList.toggle('selected', b.dataset.lang === lang));
    refreshDynamicText();
    refit();
    try { localStorage.setItem('tayak-lang', lang); } catch (e) { /* ignore */ }
  }
  function initialLang() {
    try {
      const saved = localStorage.getItem('tayak-lang');
      if (saved && STRINGS[saved]) return saved;
    } catch (e) { /* storage unavailable */ }
    const nav = (navigator.language || 'en').slice(0, 2).toLowerCase();
    return STRINGS[nav] ? nav : 'en';
  }

  /* ---------- Small helpers ---------- */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function lerpPt(a, b, t) { return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) }; }
  function circle(g, x, y, r) { g.beginPath(); g.arc(x, y, r, 0, TAU); }
  function rr(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }
  function hexToRgb(h) {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function mix(a, b, t) {
    const A = hexToRgb(a), Bc = hexToRgb(b);
    return `rgb(${Math.round(lerp(A[0], Bc[0], t))},${Math.round(lerp(A[1], Bc[1], t))},${Math.round(lerp(A[2], Bc[2], t))})`;
  }
  function capsule(g, a, b, ra, rb) {
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    g.beginPath();
    g.arc(b.x, b.y, rb, ang - Math.PI / 2, ang + Math.PI / 2);
    g.arc(a.x, a.y, ra, ang + Math.PI / 2, ang + Math.PI * 1.5);
    g.closePath();
  }
  /** Outline + fill a tapered limb. */
  function limb(a, b, wa, wb, fill, lw = 5) {
    capsule(ctx, a, b, wa / 2, wb / 2);
    ctx.lineWidth = lw;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.fillStyle = fill;
    ctx.fill();
  }
  /** Draw several shapes as one cartoon "sticker": all outlines first, then all fills. */
  function union(shapes, fill, lw = 5) {
    ctx.lineWidth = lw;
    ctx.strokeStyle = INK;
    for (const s of shapes) { s(); ctx.stroke(); }
    ctx.fillStyle = fill;
    for (const s of shapes) { s(); ctx.fill(); }
  }
  /** Two-bone IK. score(candidate) picks which of the two solutions to use. */
  function ik(a, b, l1, l2, score) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 0.001;
    const dc = clamp(d, Math.abs(l1 - l2) + 0.01, l1 + l2 - 0.01);
    const ux = dx / d, uy = dy / d;
    const along = (l1 * l1 - l2 * l2 + dc * dc) / (2 * dc);
    const h = Math.sqrt(Math.max(0, l1 * l1 - along * along));
    const c1 = { x: a.x + ux * along - uy * h, y: a.y + uy * along + ux * h };
    const c2 = { x: a.x + ux * along + uy * h, y: a.y + uy * along - ux * h };
    return score(c1) >= score(c2) ? c1 : c2;
  }

  /* ======================================================================
     AUDIO — everything synthesized; context created on first interaction.
     ====================================================================== */
  const Sound = (() => {
    let ac = null, master = null, noiseBuf = null;
    let muted = false;
    try { muted = localStorage.getItem('tayak-muted') === '1'; } catch (e) { /* storage unavailable */ }

    function init() {
      if (!ac) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        ac = new AC();
        master = ac.createGain();
        master.gain.value = muted ? 0 : 0.6;
        const comp = ac.createDynamicsCompressor();
        master.connect(comp);
        comp.connect(ac.destination);
        noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      }
      if (ac.state === 'suspended') ac.resume();
    }
    const ok = () => ac && !muted && ac.state === 'running';

    function tone(freq, dur, o = {}) {
      if (!ok()) return;
      const t0 = ac.currentTime + (o.delay || 0);
      const osc = ac.createOscillator();
      osc.type = o.type || 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      if (o.slide) osc.frequency.exponentialRampToValueAtTime(o.slide, t0 + dur);
      const g = ac.createGain();
      const v = o.vol || 0.2, a = o.attack || 0.006;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(v, t0 + a);
      if (o.hold) g.gain.setValueAtTime(v, t0 + a + o.hold);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      let out = osc;
      if (o.filter) {
        const f = ac.createBiquadFilter();
        f.type = o.ftype || 'lowpass';
        f.frequency.value = o.filter;
        f.Q.value = o.q || 0.8;
        osc.connect(f);
        out = f;
      }
      if (o.vibrato) {
        const lfo = ac.createOscillator();
        const lg = ac.createGain();
        lfo.frequency.value = o.vibrato;
        lg.gain.value = freq * 0.03;
        lfo.connect(lg);
        lg.connect(osc.frequency);
        lfo.start(t0);
        lfo.stop(t0 + dur + 0.05);
      }
      out.connect(g);
      g.connect(master);
      osc.start(t0);
      osc.stop(t0 + dur + 0.05);
    }

    function noise(dur, o = {}) {
      if (!ok()) return;
      const t0 = ac.currentTime + (o.delay || 0);
      const src = ac.createBufferSource();
      src.buffer = noiseBuf;
      src.loop = true;
      const f = ac.createBiquadFilter();
      f.type = o.type || 'bandpass';
      f.frequency.setValueAtTime(o.freq || 1000, t0);
      if (o.slide) f.frequency.exponentialRampToValueAtTime(o.slide, t0 + dur);
      f.Q.value = o.q || 1;
      const g = ac.createGain();
      const v = o.vol || 0.2, a = o.attack || 0.005;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(v, t0 + a);
      if (o.hold) g.gain.setValueAtTime(v, t0 + a + o.hold);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(f);
      f.connect(g);
      g.connect(master);
      src.start(t0, Math.random() * 0.5);
      src.stop(t0 + dur + 0.05);
    }

    function cheer(dur = 2.5, vol = 0.2) {
      noise(dur, { type: 'bandpass', freq: 1100, q: 0.5, vol, attack: 0.3, hold: dur * 0.35 });
      noise(dur * 0.8, { type: 'bandpass', freq: 2600, q: 1.2, vol: vol * 0.35, attack: 0.25, hold: dur * 0.2 });
      for (let i = 0; i < 7; i++) {
        tone(700 + Math.random() * 500, 0.45, { type: 'sine', slide: 1300 + Math.random() * 700, vol: 0.035, delay: Math.random() * dur * 0.6, attack: 0.05 });
      }
      for (let i = 0; i < 18; i++) {
        noise(0.05, { type: 'highpass', freq: 1800, vol: 0.07, delay: Math.random() * dur * 0.7 });
      }
    }

    return {
      init,
      get muted() { return muted; },
      setMuted(m) {
        muted = m;
        try { localStorage.setItem('tayak-muted', m ? '1' : '0'); } catch (e) { /* ignore */ }
        if (master) master.gain.setTargetAtTime(m ? 0 : 0.6, ac.currentTime, 0.02);
      },
      click() { tone(700, 0.07, { type: 'square', vol: 0.06, filter: 2500 }); },
      pull(power) {
        tone(105 + power * 50, 0.1, { type: 'sine', slide: 52, vol: 0.32 });
        noise(0.05, { type: 'bandpass', freq: 1300 + Math.random() * 700, q: 1.4, vol: 0.09 });
      },
      grunt(low) {
        const f = (low ? 105 : 150) + Math.random() * 25;
        tone(f, 0.22, { type: 'sawtooth', slide: f * 0.7, vol: 0.14, filter: 750, ftype: 'bandpass', q: 2.5, attack: 0.02 });
      },
      creak() { tone(70 + Math.random() * 20, 0.4, { type: 'sawtooth', slide: 50, vol: 0.05, filter: 420, ftype: 'bandpass', q: 7 }); },
      attackWarn() {
        tone(440, 0.12, { type: 'square', vol: 0.09, filter: 2200 });
        tone(587, 0.16, { type: 'square', vol: 0.09, filter: 2200, delay: 0.14 });
      },
      attackStrike() {
        noise(0.3, { type: 'lowpass', freq: 220, vol: 0.45 });
        tone(95, 0.32, { type: 'sawtooth', slide: 48, vol: 0.16, filter: 500 });
        tone(125, 0.4, { type: 'sawtooth', slide: 95, vol: 0.12, filter: 850, ftype: 'bandpass', q: 2, attack: 0.03 });
      },
      desperationWarn() {
        for (let i = 0; i < 4; i++) tone(620, 0.09, { type: 'square', vol: 0.08, delay: i * 0.17, filter: 2600 });
        tone(98, 0.9, { type: 'sawtooth', vol: 0.13, filter: 600, vibrato: 7, attack: 0.1, hold: 0.4 });
      },
      desperationStrike() {
        noise(0.5, { type: 'lowpass', freq: 160, vol: 0.6 });
        tone(80, 0.6, { type: 'sawtooth', slide: 40, vol: 0.2, filter: 500 });
        tone(140, 0.55, { type: 'sawtooth', slide: 90, vol: 0.14, filter: 900, ftype: 'bandpass', q: 2, vibrato: 9, attack: 0.03 });
      },
      recovery() {
        noise(0.25, { type: 'bandpass', freq: 900, q: 0.8, vol: 0.08, attack: 0.05 });
        noise(0.25, { type: 'bandpass', freq: 800, q: 0.8, vol: 0.07, attack: 0.05, delay: 0.32 });
      },
      count() {
        tone(523, 0.2, { type: 'square', vol: 0.11, filter: 3000 });
        noise(0.12, { type: 'lowpass', freq: 160, vol: 0.4 });
      },
      go() {
        tone(784, 0.5, { type: 'square', vol: 0.12, filter: 4000, hold: 0.15 });
        tone(1047, 0.5, { type: 'triangle', vol: 0.12, hold: 0.15 });
        noise(0.35, { type: 'lowpass', freq: 140, vol: 0.6 });
        cheer(1.2, 0.08);
      },
      roundWin() {
        [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.3, { type: 'triangle', vol: 0.18, delay: i * 0.09 }));
        tone(1047, 0.6, { type: 'square', vol: 0.06, delay: 0.36, filter: 3000, hold: 0.2 });
        cheer(2.4, 0.22);
      },
      roundLose() {
        [392, 370, 349].forEach((f, i) => tone(f, 0.3, { type: 'sawtooth', vol: 0.1, delay: i * 0.3, filter: 1100 }));
        tone(330, 0.95, { type: 'sawtooth', vol: 0.11, delay: 0.9, slide: 247, filter: 1100, vibrato: 6, hold: 0.3 });
        cheer(1.6, 0.1);
      },
      matchWin() {
        const seq = [[523, 0, 0.13], [523, 0.15, 0.13], [523, 0.3, 0.13], [659, 0.45, 0.32], [587, 0.8, 0.13], [659, 0.95, 0.13], [784, 1.1, 0.75]];
        seq.forEach(([f, d, l]) => {
          tone(f, l + 0.12, { type: 'square', vol: 0.08, delay: d, filter: 2600, hold: l * 0.6 });
          tone(f / 2, l + 0.12, { type: 'triangle', vol: 0.12, delay: d, hold: l * 0.6 });
        });
        [0, 0.45, 1.1].forEach((d) => noise(0.25, { type: 'lowpass', freq: 170, vol: 0.5, delay: d }));
        cheer(4, 0.26);
      },
      matchLose() {
        [[392, 0, 0.3], [349, 0.33, 0.3], [311, 0.66, 0.3], [262, 1.0, 1.1]].forEach(([f, d, l], i) =>
          tone(f, l, { type: 'sawtooth', vol: 0.1, delay: d, filter: 1000, vibrato: i === 3 ? 5 : 0, hold: l * 0.4 }));
        cheer(2, 0.08);
      }
    };
  })();

  /* ======================================================================
     GAME STATE
     ====================================================================== */
  const game = {
    state: S.MENU,
    mode: '1p',             // '1p' vs the AI, '2p' two humans on one device
    input: 'keyboard',      // which hints to show: 'keyboard' or 'touch' (both inputs always work)
    difficulty: 'medium',
    round: 1,
    leftWins: 0,
    rightWins: 0,
    factDeck: [],           // fact numbers not yet shown this match
    sim: null,
    endInfo: null,
    cd: null,
    time: 0,
    stateTime: 0,
    shake: 0,
    flash: 0,
    crowd: 0.25,
    crowdBoost: 0,
    taps: { left: { times: [], count: 0, last: -1, rate: 0 }, right: { times: [], count: 0, last: -1, rate: 0 } },
    menuPull: 0
  };

  function createWrestler(side, look) {
    return {
      side, look,
      theta: 0.1, hipD: 150, hipY: 560, headTilt: 0, attach: 1,
      ankleD: 32, ankleY: ARENA.groundY - 16, footRot: 0,
      grips: [40, 64],
      free: [{ d: 60, y: 560 }, { d: 70, y: 565 }],
      kick: 0, tremble: 0, effort: 0, red: 0, blush: 0,
      expr: 'focus', exprHold: 0, blinkIn: 2 + Math.random() * 3, blink: 0,
      sweatIn: 0.5, breathIn: 0.3, dustIn: 0.2, pose: null
    };
  }
  const player = createWrestler(-1, LOOKS.player);
  const rival = createWrestler(1, LOOKS.aibek);
  const OPPONENT_LOOKS = { easy: LOOKS.ermek, medium: LOOKS.aibek, hard: LOOKS.temir };
  const stick = { x: ARENA.boardX, y: ARENA.stickY, angle: 0, nudge: 0 };

  const particles = [];   // arena space
  const confetti = [];    // screen space
  const popups = [];      // arena space floating words

  /* ======================================================================
     SCENERY (static layers are pre-rendered; animated bits drawn per frame)
     ====================================================================== */
  let pixelRatio = 1;
  const layers = { sky: null, land: null, front: null };
  const sceneRng = mulberry32(1337);
  const clouds = Array.from({ length: 7 }, (_, i) => ({
    x: i * 210 + sceneRng() * 120, y: 45 + sceneRng() * 120, s: 0.55 + sceneRng() * 0.6, v: 4 + sceneRng() * 7
  }));
  const crowd = buildCrowd();

  function makeLayer(draw) {
    const c = document.createElement('canvas');
    c.width = canvas.width;
    c.height = canvas.height;
    const g = c.getContext('2d');
    g.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    g.lineJoin = 'round';
    g.lineCap = 'round';
    draw(g);
    return c;
  }

  function buildLayers() {
    layers.sky = makeLayer(drawSkyLayer);
    layers.land = makeLayer(drawLandLayer);
    layers.front = makeLayer(drawFrontLayer);
  }

  function drawSkyLayer(g) {
    const grd = g.createLinearGradient(0, 0, 0, 440);
    grd.addColorStop(0, '#2b8ae4');
    grd.addColorStop(0.55, '#79c2f3');
    grd.addColorStop(1, '#d9f2fb');
    g.fillStyle = grd;
    g.fillRect(0, 0, W, H);
    const sx = 1050, sy = 150;
    const glow = g.createRadialGradient(sx, sy, 30, sx, sy, 230);
    glow.addColorStop(0, 'rgba(255,248,205,0.95)');
    glow.addColorStop(0.3, 'rgba(255,240,170,0.35)');
    glow.addColorStop(1, 'rgba(255,240,170,0)');
    g.fillStyle = glow;
    g.fillRect(sx - 240, sy - 240, 480, 480);
    g.fillStyle = '#fff7cf';
    circle(g, sx, sy, 44);
    g.fill();
  }

  function drawRange(g, rnd, o) {
    const pts = [{ x: -60, y: o.baseY }];
    const step = W / o.count;
    for (let i = 0; i <= o.count; i++) {
      const px = i * step + (rnd() - 0.5) * step * 0.5;
      if (i > 0) pts.push({ x: px - step * 0.5 + (rnd() - 0.5) * step * 0.2, y: o.baseY - o.minH * (0.25 + rnd() * 0.35) });
      pts.push({ x: px, y: o.baseY - (o.minH + rnd() * (o.maxH - o.minH)), peak: true });
    }
    pts.push({ x: W + 60, y: o.baseY });
    const ridge = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      ridge.push(a);
      for (let k = 1; k < 4; k++) ridge.push({ x: lerp(a.x, b.x, k / 4), y: lerp(a.y, b.y, k / 4) + (rnd() - 0.5) * o.jag });
    }
    ridge.push(pts[pts.length - 1]);
    const path = () => {
      g.beginPath();
      g.moveTo(-60, H);
      for (const p of ridge) g.lineTo(p.x, p.y);
      g.lineTo(W + 60, H);
      g.closePath();
    };
    path();
    g.fillStyle = o.color;
    g.fill();
    g.save();
    path();
    g.clip();
    if (o.snow) {
      g.fillStyle = o.snow;
      for (const p of pts) {
        if (!p.peak) continue;
        const capH = (o.baseY - p.y) * 0.34;
        g.beginPath();
        g.moveTo(p.x, p.y - 5);
        g.lineTo(p.x + 170, p.y + capH);
        for (let k = 8; k >= -8; k--) g.lineTo(p.x + k * 21, p.y + capH + (k % 2 ? -capH * 0.28 : capH * 0.05) + rnd() * 6);
        g.lineTo(p.x - 170, p.y + capH);
        g.closePath();
        g.fill();
      }
    }
    // Shade the right flank of every peak (sun is on the right, light comes over the ridge).
    g.fillStyle = o.shade;
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i];
      if (!p.peak) continue;
      const v = pts[i + 1];
      g.beginPath();
      g.moveTo(p.x, p.y);
      g.lineTo(v.x, v.y);
      g.lineTo(v.x - 10, o.baseY + 60);
      g.lineTo(p.x - 18, o.baseY + 60);
      g.closePath();
      g.fill();
    }
    g.restore();
  }

  function drawHill(g, baseY, amp, f1, f2, ph, c1, c2) {
    g.beginPath();
    g.moveTo(0, H);
    for (let x = 0; x <= W; x += 8) g.lineTo(x, baseY + Math.sin(x * f1 + ph) * amp + Math.sin(x * f2 + ph * 2.1) * amp * 0.45);
    g.lineTo(W, H);
    g.closePath();
    const grd = g.createLinearGradient(0, baseY - amp, 0, baseY + 120);
    grd.addColorStop(0, c1);
    grd.addColorStop(1, c2);
    g.fillStyle = grd;
    g.fill();
  }

  function drawPoplar(g, x, y, h) {
    g.fillStyle = '#6b4a2e';
    g.fillRect(x - 1.5, y - h * 0.25, 3, h * 0.25);
    g.fillStyle = '#4c8a3c';
    g.beginPath();
    g.ellipse(x, y - h * 0.58, h * 0.13, h * 0.42, 0, 0, TAU);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.12)';
    g.beginPath();
    g.ellipse(x + h * 0.04, y - h * 0.62, h * 0.05, h * 0.3, 0, 0, TAU);
    g.fill();
  }

  function drawYurt(g, x, baseY, w, h, band, door, line = INK) {
    const wallH = h * 0.42, roofTop = baseY - h, wallTop = baseY - wallH;
    const left = x - w / 2, right = x + w / 2;
    g.lineWidth = Math.max(2, w / 45);
    g.strokeStyle = line;
    // wall
    g.fillStyle = '#f3ead8';
    g.beginPath();
    g.moveTo(left, wallTop);
    g.lineTo(left, baseY);
    g.quadraticCurveTo(x, baseY + h * 0.05, right, baseY);
    g.lineTo(right, wallTop);
    g.closePath();
    g.fill();
    g.stroke();
    // lattice hint
    g.save();
    g.clip();
    g.strokeStyle = 'rgba(140,100,60,0.25)';
    g.lineWidth = 1.5;
    for (let k = left - wallH; k < right; k += w / 9) {
      g.beginPath(); g.moveTo(k, baseY); g.lineTo(k + wallH, wallTop); g.stroke();
      g.beginPath(); g.moveTo(k + wallH, baseY); g.lineTo(k, wallTop); g.stroke();
    }
    g.restore();
    // ornament band
    g.fillStyle = band;
    g.fillRect(left, wallTop, w, wallH * 0.24);
    g.strokeStyle = '#ffd23f';
    g.lineWidth = Math.max(1.5, w / 80);
    g.beginPath();
    const zz = w / 14;
    for (let k = 0; k <= 14; k++) g.lineTo(left + k * zz, wallTop + (k % 2 ? wallH * 0.05 : wallH * 0.19));
    g.stroke();
    // roof
    g.strokeStyle = line;
    g.lineWidth = Math.max(2, w / 45);
    g.fillStyle = '#ece0c6';
    g.beginPath();
    g.moveTo(left - w * 0.04, wallTop + 3);
    g.bezierCurveTo(left + w * 0.04, roofTop + h * 0.16, x - w * 0.22, roofTop, x, roofTop);
    g.bezierCurveTo(x + w * 0.22, roofTop, right - w * 0.04, roofTop + h * 0.16, right + w * 0.04, wallTop + 3);
    g.closePath();
    g.fill();
    g.stroke();
    // roof bands
    g.save();
    g.clip();
    g.strokeStyle = band;
    g.lineWidth = Math.max(2, w / 40);
    for (let k = -2; k <= 2; k++) {
      g.beginPath();
      g.moveTo(x + k * w * 0.05, roofTop + 3);
      g.quadraticCurveTo(x + k * w * 0.18, wallTop - h * 0.1, x + k * w * 0.26, wallTop + 4);
      g.stroke();
    }
    g.restore();
    // crown
    g.fillStyle = '#7a4a2a';
    g.beginPath();
    g.ellipse(x, roofTop + 2, w * 0.09, h * 0.04, 0, 0, TAU);
    g.fill();
    g.stroke();
    // door
    const dw = w * 0.2, dh = wallH * 0.82;
    g.fillStyle = door;
    g.fillRect(x - dw / 2, baseY - dh, dw, dh);
    g.strokeRect(x - dw / 2, baseY - dh, dw, dh);
    g.strokeStyle = '#ffd23f';
    g.lineWidth = Math.max(1, w / 90);
    g.strokeRect(x - dw * 0.32, baseY - dh * 0.85, dw * 0.64, dh * 0.7);
    g.beginPath();
    g.moveTo(x, baseY - dh * 0.75);
    g.lineTo(x + dw * 0.18, baseY - dh * 0.5);
    g.lineTo(x, baseY - dh * 0.25);
    g.lineTo(x - dw * 0.18, baseY - dh * 0.5);
    g.closePath();
    g.stroke();
  }

  function drawLandLayer(g) {
    const rnd = mulberry32(42);
    drawRange(g, rnd, { baseY: 370, minH: 120, maxH: 205, count: 6, jag: 14, color: '#8fa9d6', shade: 'rgba(40,50,110,0.16)', snow: '#f5f9ff' });
    drawRange(g, rnd, { baseY: 395, minH: 70, maxH: 125, count: 8, jag: 10, color: '#6787b8', shade: 'rgba(30,40,90,0.18)', snow: '#e8f0fb' });
    // haze band
    const hz = g.createLinearGradient(0, 330, 0, 420);
    hz.addColorStop(0, 'rgba(220,240,252,0)');
    hz.addColorStop(1, 'rgba(220,240,252,0.55)');
    g.fillStyle = hz;
    g.fillRect(0, 330, W, 90);
    drawHill(g, 410, 10, 0.004, 0.011, 1.3, '#9bcf72', '#7cb556');
    // far poplar rows and small yurts
    for (let x = 30; x < W; x += 26 + rnd() * 50) if (rnd() < 0.55) drawPoplar(g, x, 418 + rnd() * 6, 34 + rnd() * 22);
    [[330, 432, 46], [395, 436, 38], [880, 434, 44], [940, 438, 36], [610, 430, 30]].forEach(([x, y, w]) =>
      drawYurt(g, x, y, w, w * 0.78, '#b8322a', '#c4462c', '#6b4a35'));
    drawHill(g, 450, 12, 0.003, 0.009, 4.1, '#86c25e', '#5f9e42');
    // big festival yurts on the flanks
    drawYurt(g, 120, 545, 190, 150, '#b8322a', '#c4462c');
    drawYurt(g, 300, 528, 120, 96, '#2f6fb0', '#2f6fb0');
    drawYurt(g, 1160, 545, 190, 150, '#2f6fb0', '#c4462c');
    drawYurt(g, 985, 528, 120, 96, '#b8322a', '#2f6fb0');
    // grass ground behind the crowd
    g.fillStyle = '#5c9a3f';
    g.fillRect(0, 540, W, H - 540);
  }

  function hornMotif(g, x, y, s) {
    g.beginPath();
    g.moveTo(x, y + 4 * s);
    g.bezierCurveTo(x - 2 * s, y - 6 * s, x - 12 * s, y - 6 * s, x - 11 * s, y + 1 * s);
    g.bezierCurveTo(x - 10 * s, y + 6 * s, x - 5 * s, y + 4 * s, x - 6 * s, y);
    g.moveTo(x, y + 4 * s);
    g.bezierCurveTo(x + 2 * s, y - 6 * s, x + 12 * s, y - 6 * s, x + 11 * s, y + 1 * s);
    g.bezierCurveTo(x + 10 * s, y + 6 * s, x + 5 * s, y + 4 * s, x + 6 * s, y);
    g.stroke();
  }

  function drawFrontLayer(g) {
    // fence in front of the crowd
    g.lineWidth = 3;
    g.strokeStyle = INK;
    for (let x = 18; x < W; x += 66) {
      g.fillStyle = '#8a5a2b';
      rr(g, x - 6, 512, 12, 62, 3);
      g.fill();
      g.stroke();
    }
    [526, 548].forEach((y) => {
      g.fillStyle = '#a56d36';
      rr(g, -10, y, W + 20, 11, 4);
      g.fill();
      g.stroke();
    });

    // platform top surface
    g.fillStyle = '#d9a35f';
    g.beginPath();
    g.moveTo(40, 566);
    g.lineTo(W - 40, 566);
    g.lineTo(W + 10, 606);
    g.lineTo(-10, 606);
    g.closePath();
    g.fill();
    g.stroke();
    g.strokeStyle = 'rgba(110,60,20,0.35)';
    g.lineWidth = 2;
    for (let i = 1; i < 4; i++) {
      const y = 566 + i * 10;
      g.beginPath();
      g.moveTo(40 - i * 12.5, y);
      g.lineTo(W - 40 + i * 12.5, y);
      g.stroke();
    }

    // shyrdak felt carpet
    g.lineWidth = 3;
    g.strokeStyle = INK;
    g.fillStyle = '#b8322a';
    g.beginPath();
    g.moveTo(292, 569);
    g.lineTo(988, 569);
    g.lineTo(1014, 602);
    g.lineTo(266, 602);
    g.closePath();
    g.fill();
    g.stroke();
    g.strokeStyle = '#ffd23f';
    g.lineWidth = 2.5;
    g.beginPath();
    g.moveTo(302, 573);
    g.lineTo(978, 573);
    g.lineTo(1000, 598);
    g.lineTo(280, 598);
    g.closePath();
    g.stroke();
    g.strokeStyle = '#ffe58a';
    g.lineWidth = 2;
    for (let x = 320; x <= 960; x += 64) hornMotif(g, x, 585, 0.9);

    // front face
    const ff = g.createLinearGradient(0, 606, 0, H);
    ff.addColorStop(0, '#b0702f');
    ff.addColorStop(1, '#6e3f17');
    g.fillStyle = ff;
    g.fillRect(-10, 606, W + 20, H - 606);
    g.strokeStyle = 'rgba(40,20,8,0.5)';
    g.lineWidth = 2;
    for (let x = 30; x < W; x += 74) {
      g.beginPath();
      g.moveTo(x, 646);
      g.lineTo(x, H);
      g.stroke();
    }
    // painted ornament band
    g.fillStyle = '#7e1f1a';
    g.fillRect(-10, 610, W + 20, 34);
    g.strokeStyle = INK;
    g.lineWidth = 3;
    g.beginPath(); g.moveTo(-10, 610); g.lineTo(W + 10, 610); g.stroke();
    g.beginPath(); g.moveTo(-10, 644); g.lineTo(W + 10, 644); g.stroke();
    g.strokeStyle = '#ffd23f';
    g.lineWidth = 2.5;
    for (let x = 20; x < W; x += 52) hornMotif(g, x, 628, 1.05);
    g.fillStyle = '#ffd23f';
    for (let x = 46; x < W; x += 52) {
      g.beginPath();
      g.moveTo(x, 620); g.lineTo(x + 5, 627); g.lineTo(x, 634); g.lineTo(x - 5, 627);
      g.closePath();
      g.fill();
    }
    // bolts
    g.fillStyle = '#3a2210';
    for (let x = 30; x < W; x += 74) { circle(g, x + 6, 660, 3); g.fill(); circle(g, x + 6, 700, 3); g.fill(); }

    // center board (arena space)
    g.save();
    g.translate(ARENA.boardX, ARENA.groundY);
    g.scale(ARENA.scale, ARENA.scale);
    g.translate(-ARENA.boardX, -ARENA.groundY);
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.beginPath();
    g.ellipse(ARENA.boardX, ARENA.groundY + 1, 30, 5, 0, 0, TAU);
    g.fill();
    const bx = ARENA.boardX - 10, by = ARENA.boardTop, bh = ARENA.groundY - ARENA.boardTop + 2;
    const bg = g.createLinearGradient(bx, 0, bx + 20, 0);
    bg.addColorStop(0, '#d9a061');
    bg.addColorStop(1, '#9a5f2c');
    g.fillStyle = bg;
    rr(g, bx, by, 20, bh, 4);
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = INK;
    g.stroke();
    g.strokeStyle = '#ffd23f';
    g.lineWidth = 1.6;
    for (let y = by + 12; y < by + bh - 10; y += 16) {
      g.beginPath();
      g.moveTo(ARENA.boardX, y - 5); g.lineTo(ARENA.boardX + 5, y); g.lineTo(ARENA.boardX, y + 5); g.lineTo(ARENA.boardX - 5, y);
      g.closePath();
      g.stroke();
    }
    g.fillStyle = '#5a3416';
    rr(g, ARENA.boardX - 16, ARENA.groundY - 3, 32, 6, 2);
    g.fill();
    g.restore();
  }

  function buildCrowd() {
    const r = mulberry32(99);
    const robes = ['#7a3b8f', '#2e7d6b', '#c75b2a', '#3a5aa8', '#a83a3a', '#d1a03b', '#5b4636', '#2f6f9a', '#8a6a2f', '#3f8a4a'];
    const skins = ['#e8b48a', '#c99067', '#b07a52', '#f0c49c', '#d8a274'];
    const scarves = ['#e85d75', '#ffd23f', '#ffffff', '#7fd1c7', '#ff9a3c', '#b38bff'];
    const list = [];
    for (let row = 0; row < 2; row++) {
      const y = row === 0 ? 534 : 554;
      const k = row === 0 ? 0.8 : 1.0;
      const step = row === 0 ? 27 : 33;
      const haze = row === 0 ? 0.28 : 0;
      for (let x = 8 + r() * 12; x < W; x += step + r() * 12) {
        const hr = r();
        const robe = robes[Math.floor(r() * robes.length)];
        list.push({
          x, y: y + r() * 4, k: k * (0.88 + r() * 0.24),
          robe: mix(robe, '#c8def0', haze),
          skin: mix(skins[Math.floor(r() * skins.length)], '#c8def0', haze),
          hat: hr < 0.38 ? 'kalpak' : hr < 0.62 ? 'scarf' : hr < 0.8 ? 'tebetey' : 'hair',
          scarf: mix(scarves[Math.floor(r() * scarves.length)], '#c8def0', haze),
          phase: r() * TAU, speed: 2 + r() * 2.6, cheerAt: 0.35 + r() * 0.5,
          flag: r() < 0.16 ? (r() < 0.5 ? '#2f7ae5' : '#e0392f') : null
        });
      }
    }
    return list;
  }

  /* ---------- animated scenery ---------- */
  function drawCloud(c) {
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.scale(c.s, c.s);
    const blobs = [[-52, 4, 26], [-22, -12, 34], [16, -18, 31], [50, -2, 25], [0, 6, 30]];
    ctx.fillStyle = 'rgba(150,185,225,0.45)';
    for (const [x, y, r] of blobs) { circle(ctx, x, y + 8, r); ctx.fill(); }
    ctx.fillStyle = '#ffffff';
    for (const [x, y, r] of blobs) { circle(ctx, x, y, r); ctx.fill(); }
    ctx.restore();
  }

  function drawSkyLife(dt) {
    for (const c of clouds) {
      c.x += c.v * dt;
      if (c.x > W + 120) c.x = -120;
      drawCloud(c);
    }
    // a golden eagle (berkut) circling over the valley
    const t = game.time * 0.18;
    const ex = 400 + Math.cos(t) * 190, ey = 120 + Math.sin(t) * 28;
    const flap = Math.sin(game.time * 2.4) * 5;
    const dir = -Math.sin(t) >= 0 ? 1 : -1;
    ctx.save();
    ctx.translate(ex, ey);
    ctx.scale(dir, 1);
    ctx.strokeStyle = '#3b2a20';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-18, flap);
    ctx.quadraticCurveTo(-8, -6 + flap * 0.3, 0, 0);
    ctx.quadraticCurveTo(8, -6 + flap * 0.3, 18, flap);
    ctx.stroke();
    ctx.fillStyle = '#3b2a20';
    ctx.beginPath();
    ctx.ellipse(1, 1, 5, 2.5, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  function drawBanners() {
    const t = game.time;
    // poles
    for (const px of [46, W - 46]) {
      ctx.fillStyle = '#7a4a2a';
      ctx.strokeStyle = INK;
      ctx.lineWidth = 3;
      rr(ctx, px - 5, 118, 10, 460, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#ffd23f';
      circle(ctx, px, 114, 9);
      ctx.fill();
      ctx.stroke();
      // long pennant
      const dir = px < W / 2 ? 1 : -1;
      const col = px < W / 2 ? '#2f7ae5' : '#e0392f';
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(px, 126);
      for (let i = 0; i <= 8; i++) {
        const x = px + dir * i * 12;
        ctx.lineTo(x, 126 + Math.sin(t * 4 + i * 0.7) * 3 * (i / 8) + i * 1.5);
      }
      for (let i = 8; i >= 0; i--) {
        const x = px + dir * i * 12;
        ctx.lineTo(x, 126 + 44 - i * 4.2 + Math.sin(t * 4 + i * 0.7) * 3 * (i / 8));
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#ffd23f';
      circle(ctx, px + dir * 30, 146 + Math.sin(t * 4 + 2) * 1.5, 7);
      ctx.fill();
    }
    // garland of flags
    const x0 = 46, x1 = W - 46, y0 = 136, sag = 72;
    const yAt = (x) => y0 + sag * (1 - Math.pow((x - W / 2) / ((x1 - x0) / 2), 2));
    ctx.strokeStyle = '#5b3a24';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = x0; x <= x1; x += 10) ctx.lineTo(x, yAt(x));
    ctx.stroke();
    const cols = ['#e0392f', '#ffd23f', '#2f7ae5', '#3fae55', '#ffffff', '#f07c2a'];
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(43,26,20,0.7)';
    let i = 0;
    for (let x = x0 + 26; x < x1 - 14; x += 38, i++) {
      const ya = yAt(x - 13), yb = yAt(x + 13);
      const sway = Math.sin(t * 3 + i * 0.9) * 4;
      ctx.fillStyle = cols[i % cols.length];
      ctx.beginPath();
      ctx.moveTo(x - 13, ya);
      ctx.lineTo(x + 13, yb);
      ctx.lineTo(x + sway, (ya + yb) / 2 + 30);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }

  function drawSpectator(p, ex, t) {
    const k = p.k;
    const bob = Math.sin(t * p.speed + p.phase) * (0.8 + ex * 2.5) * k;
    const jump = ex > 0.62 ? Math.max(0, Math.sin(t * p.speed * 1.8 + p.phase)) * (ex - 0.62) * 34 * k : 0;
    const fy = p.y - jump;
    const bodyH = 44 * k, bodyW = 25 * k;
    const top = fy - bodyH + bob * 0.4;
    const cheer = ex > p.cheerAt;
    // arms
    ctx.strokeStyle = p.robe;
    ctx.lineWidth = 7 * k;
    if (cheer || p.flag) {
      const wave = Math.sin(t * p.speed * 2 + p.phase) * 6 * k;
      ctx.beginPath();
      ctx.moveTo(p.x - bodyW * 0.38, top + 8 * k);
      ctx.lineTo(p.x - bodyW * 0.7 + wave * 0.4, top - 16 * k + wave);
      ctx.stroke();
      if (cheer) {
        ctx.beginPath();
        ctx.moveTo(p.x + bodyW * 0.38, top + 8 * k);
        ctx.lineTo(p.x + bodyW * 0.7 - wave * 0.4, top - 16 * k - wave);
        ctx.stroke();
      }
      if (p.flag) {
        const hx = p.x - bodyW * 0.7 + wave * 0.4, hy = top - 16 * k + wave;
        ctx.strokeStyle = '#6b4a2e';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(hx, hy + 4);
        ctx.lineTo(hx, hy - 30 * k);
        ctx.stroke();
        ctx.fillStyle = p.flag;
        const f = Math.sin(t * 6 + p.phase) * 3 * k;
        ctx.beginPath();
        ctx.moveTo(hx, hy - 30 * k);
        ctx.quadraticCurveTo(hx + 10 * k, hy - 32 * k + f, hx + 20 * k, hy - 27 * k + f);
        ctx.lineTo(hx + 20 * k, hy - 15 * k + f);
        ctx.quadraticCurveTo(hx + 10 * k, hy - 20 * k + f, hx, hy - 18 * k);
        ctx.closePath();
        ctx.fill();
      }
    }
    // body
    ctx.fillStyle = p.robe;
    rr(ctx, p.x - bodyW / 2, top, bodyW, bodyH + 14, 10 * k);
    ctx.fill();
    ctx.strokeStyle = 'rgba(40,25,20,0.55)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // head
    const hy = top - 8 * k + bob * 0.3;
    ctx.fillStyle = p.skin;
    circle(ctx, p.x, hy, 9.5 * k);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#2b1a14';
    circle(ctx, p.x - 3 * k, hy, 1.2 * k); ctx.fill();
    circle(ctx, p.x + 3 * k, hy, 1.2 * k); ctx.fill();
    if (cheer) {
      ctx.beginPath();
      ctx.ellipse(p.x, hy + 4.5 * k, 2.4 * k, 2 * k, 0, 0, TAU);
      ctx.fill();
    }
    // hats
    switch (p.hat) {
      case 'kalpak':
        ctx.fillStyle = '#f7f3ea';
        ctx.beginPath();
        ctx.moveTo(p.x - 10 * k, hy - 4 * k);
        ctx.lineTo(p.x - 5 * k, hy - 25 * k);
        ctx.quadraticCurveTo(p.x, hy - 29 * k, p.x + 4 * k, hy - 25 * k);
        ctx.lineTo(p.x + 10 * k, hy - 4 * k);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#2b1a14';
        ctx.fillRect(p.x - 10.5 * k, hy - 7 * k, 21 * k, 3.5 * k);
        break;
      case 'scarf':
        ctx.fillStyle = p.scarf;
        ctx.beginPath();
        ctx.arc(p.x, hy - 1 * k, 11 * k, Math.PI * 1.02, Math.PI * 1.98);
        ctx.lineTo(p.x + 10 * k, hy + 7 * k);
        ctx.lineTo(p.x + 7 * k, hy - 2 * k);
        ctx.lineTo(p.x - 7 * k, hy - 2 * k);
        ctx.lineTo(p.x - 10 * k, hy + 7 * k);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        break;
      case 'tebetey':
        ctx.fillStyle = '#4a2f22';
        ctx.beginPath();
        ctx.ellipse(p.x, hy - 7 * k, 11 * k, 6 * k, 0, Math.PI, TAU);
        ctx.fill();
        ctx.fillStyle = '#c0392b';
        ctx.beginPath();
        ctx.ellipse(p.x, hy - 10 * k, 6 * k, 5 * k, 0, Math.PI, TAU);
        ctx.fill();
        break;
      default:
        ctx.fillStyle = '#1d1a24';
        ctx.beginPath();
        ctx.arc(p.x, hy - 1 * k, 9.8 * k, Math.PI * 1.05, Math.PI * 1.95);
        ctx.closePath();
        ctx.fill();
    }
  }

  function drawCrowd() {
    const ex = clamp(game.crowd, 0, 1);
    for (const p of crowd) drawSpectator(p, ex, game.time);
  }

  /* ======================================================================
     WRESTLER ANIMATION
     Procedural pose: smoothed parameters (lean, hip position, hands) chase
     targets derived from the simulation; joints are then solved with IK.
     ====================================================================== */
  function animateWrestler(w, dt, p) {
    const adv = clamp(p.adv, -1, 1);
    const lose = Math.max(0, -adv), win = Math.max(0, adv);
    const G = ARENA.groundY;
    w.kick = Math.max(0, w.kick - dt * 5);
    w.effort = damp(w.effort, clamp(p.effort, 0, 1.4), 8, dt);

    let tTheta = 0.1, tHipD = 150, tHipY = 560, tHead = 0, tAttach = 1;
    let tAnkleD = 32, tAnkleY = G - 16, tFootRot = 0, tTremble = 0, rate = 9;
    let tGrips = [40, 64];
    let tFree = null;

    if (p.mode === 'play') {
      const breathe = Math.sin(game.time * 2.2 + w.side) * 0.02;
      tTheta = 0.1 + adv * 0.42 + w.effort * 0.12 + w.kick * 0.1 + breathe;
      tHipD = 150 - lose * 30 + win * 4;
      tHipY = 560 - Math.pow(lose, 1.4) * 32;
      tHead = -adv * 0.1;
      tTremble = w.effort > 0.5 ? (w.effort - 0.5) * 3 : 0;
      if (p.underAttack) tTremble += 1;
      if (p.tired) { tTheta -= 0.06; tHead += 0.2; tTremble += 0.6; }
      const ai = p.ai;
      if (ai) {
        const strike = ai.phase === 'strike';
        if (ai.state === AIState.ATTACK) {
          if (strike) { tTheta += 0.18; tTremble += 2.2; } else { tTheta -= 0.08; tHead += 0.1; }
        } else if (ai.state === AIState.DESPERATION) {
          if (strike) { tTheta += 0.26; tTremble += 3.2; } else { tTheta -= 0.15; tTremble += 1.8; tHead += 0.15; }
        } else if (ai.state === AIState.RECOVERY) {
          tTheta -= 0.06;
          tHead += 0.22;
        }
      }
    } else if (p.mode === 'win') {
      if (p.t < 1.3) {
        tTheta = 1.22; tHipD = 156; tHipY = 562; rate = p.t < 0.4 ? 7 : 5;
        tHead = -0.3;
      } else {
        const bounce = Math.abs(Math.sin(game.time * 6)) * 6;
        tTheta = 0.04 + Math.sin(game.time * 6) * 0.03;
        tHipD = 150; tHipY = 560 - bounce; tGrips = [-26, 26]; rate = 6;
        tHead = 0.05;
      }
    } else if (p.mode === 'lose') {
      // yanked forward, then collapses face-down onto the board
      tTheta = -1.25; tHipD = 118; tHipY = 556; tHead = -0.6;
      tAttach = p.t < 0.18 ? 1 : 0; rate = 7;
      const sway = Math.sin(game.time * 2) * 3;
      tFree = [{ d: -22, y: G - 32 + sway }, { d: -42, y: G - 24 - sway }];
    }

    w.theta = damp(w.theta, tTheta, rate, dt);
    w.hipD = damp(w.hipD, tHipD, rate, dt);
    w.hipY = damp(w.hipY, tHipY, rate, dt);
    w.headTilt = damp(w.headTilt, tHead, 6, dt);
    w.attach = damp(w.attach, tAttach, 10, dt);
    w.ankleD = damp(w.ankleD, tAnkleD, 6, dt);
    w.ankleY = damp(w.ankleY, tAnkleY, 6, dt);
    w.footRot = damp(w.footRot, tFootRot, 6, dt);
    w.tremble = damp(w.tremble, tTremble, 10, dt);
    w.grips[0] = damp(w.grips[0], tGrips[0], 7, dt);
    w.grips[1] = damp(w.grips[1], tGrips[1], 7, dt);
    if (tFree) {
      w.free[0].d = damp(w.free[0].d, tFree[0].d, 6, dt); w.free[0].y = damp(w.free[0].y, tFree[0].y, 6, dt);
      w.free[1].d = damp(w.free[1].d, tFree[1].d, 6, dt); w.free[1].y = damp(w.free[1].y, tFree[1].y, 6, dt);
    } else if (w.pose) {
      // keep free targets glued to the hands so re-gripping is seamless
      for (let i = 0; i < 2; i++) {
        w.free[i].d = (w.pose.hands[i].x - ARENA.boardX) * w.side;
        w.free[i].y = w.pose.hands[i].y;
      }
    }

    // expression
    w.exprHold -= dt;
    const next = chooseExpression(w, p);
    if (next !== w.expr && w.exprHold <= 0) { w.expr = next; w.exprHold = 0.22; }
    const e = EXPR[w.expr] || EXPR.focus;
    w.red = damp(w.red, e.red || 0, 4, dt);
    w.blush = damp(w.blush, e.blush || 0, 4, dt);
    w.blinkIn -= dt;
    if (w.blinkIn <= 0) { w.blink = 0.13; w.blinkIn = 2 + Math.random() * 3.5; }
    w.blink = Math.max(0, w.blink - dt);
  }

  const EXPR = {
    neutral: { eyes: 'open', brow: 0, mouth: 'smile' },
    focus: { eyes: 'open', brow: 2.5, mouth: 'flat' },
    smug: { eyes: 'narrow', brow: 3, mouth: 'smirk', blush: 0.15 },
    grit: { eyes: 'narrow', brow: 5, mouth: 'grit', red: 0.25, blush: 0.3 },
    strain: { eyes: 'squeeze', brow: -3.5, mouth: 'strainOpen', red: 0.45, sweat: true },
    angry: { eyes: 'glare', brow: 7, mouth: 'grit', red: 0.25 },
    roar: { eyes: 'wide', brow: 8, mouth: 'roar', red: 0.4 },
    furious: { eyes: 'glare', brow: 8, mouth: 'strainOpen', red: 0.7, vein: true },
    tired: { eyes: 'droopy', brow: -4, mouth: 'tired', sweat: true, red: 0.1 },
    shout: { eyes: 'happy', brow: -2, mouth: 'grin', blush: 0.2 },
    joy: { eyes: 'happy', brow: -1.5, mouth: 'grin', blush: 0.4 },
    dizzy: { eyes: 'dizzy', brow: -3, mouth: 'wavy' }
  };

  function chooseExpression(w, p) {
    if (p.mode === 'win') return p.t < 1.3 ? 'shout' : 'joy';
    if (p.mode === 'lose') return 'dizzy';
    if (p.idle) return w.effort > 0.45 ? 'grit' : 'focus';
    if (p.tired) return 'tired';
    const ai = p.ai;
    if (ai) {
      const strike = ai.phase === 'strike';
      if (ai.state === AIState.ATTACK) return strike ? 'roar' : 'angry';
      if (ai.state === AIState.DESPERATION) return strike ? 'roar' : 'furious';
      if (ai.state === AIState.RECOVERY) return 'tired';
    }
    if (p.adv < -0.35 || (p.underAttack && p.adv < 0.15)) return 'strain';
    if (w.effort > 0.6) return 'grit';
    if (p.adv > 0.3) return 'smug';
    return 'focus';
  }

  function computePose(w) {
    const s = w.side;
    const X = (d) => ARENA.boardX + s * d;
    const tr = w.tremble * Math.sin(game.time * 57 + s * 2);
    const hip = { x: X(w.hipD), y: w.hipY };
    const sh = { x: X(w.hipD + Math.sin(w.theta) * BODY.torso) + tr, y: w.hipY - Math.cos(w.theta) * BODY.torso };
    const hth = w.theta * 0.7 + w.headTilt;
    const head = { x: sh.x + s * Math.sin(hth) * BODY.neck, y: sh.y - Math.cos(hth) * BODY.neck };
    const farSh = { x: sh.x + s * 6, y: sh.y - 3 };

    const ca = Math.cos(stick.angle), sa = Math.sin(stick.angle);
    const hands = [0, 1].map((i) => {
      const g = s * w.grips[i];
      const gx = stick.x + ca * g, gy = stick.y + sa * g;
      const fx = X(w.free[i].d), fy = w.free[i].y;
      return { x: lerp(fx, gx, w.attach), y: lerp(fy, gy, w.attach) };
    });

    // Reach constraint: if the stick is beyond arm's length, the upper body is dragged toward it.
    const reach = (BODY.upper + BODY.fore) * 0.985;
    let shx = 0, shy = 0, best = 0;
    [farSh, sh].forEach((o, i) => {
      const dx = hands[i].x - o.x, dy = hands[i].y - o.y, d = Math.hypot(dx, dy);
      if (d > reach && d - reach > best) { best = d - reach; shx = (dx / d) * best; shy = (dy / d) * best; }
    });
    if (best > 0) {
      for (const pt of [sh, farSh, head]) { pt.x += shx; pt.y += shy; }
      hip.x += shx * 0.6;
      hip.y += shy * 0.4;
    }

    const away = (pt) => s * (pt.x - ARENA.boardX);
    const elbowScore = (c) => c.y + 0.6 * away(c);
    const kneeScore = (c) => -c.y + 0.3 * away(c);

    const ankle = { x: X(w.ankleD), y: w.ankleY };
    const hip2 = { x: hip.x + s * 6, y: hip.y - 3 };
    const ankle2 = { x: ankle.x, y: ankle.y - 5 };
    return {
      hip, sh, farSh, head, hands, ankle, hip2, ankle2,
      knee: ik(hip, ankle, BODY.thigh, BODY.shin, kneeScore),
      knee2: ik(hip2, ankle2, BODY.thigh, BODY.shin, kneeScore),
      elbows: [ik(farSh, hands[0], BODY.upper, BODY.fore, elbowScore), ik(sh, hands[1], BODY.upper, BODY.fore, elbowScore)]
    };
  }

  /* ======================================================================
     WRESTLER DRAWING
     ====================================================================== */
  function drawFoot(a, w, boot) {
    ctx.save();
    ctx.translate(a.x, a.y);
    ctx.scale(-w.side, 1);
    ctx.rotate(w.footRot);
    ctx.beginPath();
    ctx.moveTo(-11, -4);
    ctx.quadraticCurveTo(-10, -18, 2, -20);
    ctx.lineTo(10, -30);
    ctx.quadraticCurveTo(21, -42, 23, -27);
    ctx.lineTo(23, 12);
    ctx.quadraticCurveTo(22, 17, 13, 17);
    ctx.lineTo(-4, 15);
    ctx.quadraticCurveTo(-13, 12, -11, -4);
    ctx.closePath();
    ctx.lineWidth = 5;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.fillStyle = boot;
    ctx.fill();
    ctx.fillStyle = '#2a1810';
    rr(ctx, 17, -31, 7, 47, 3);
    ctx.fill();
    ctx.strokeStyle = '#d9a35a';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(-4, 5); ctx.quadraticCurveTo(6, -6, 12, -22);
    ctx.stroke();
    ctx.restore();
  }

  function drawLeg(hip, knee, ankle, w, far) {
    const L = w.look;
    const skin = far ? L.skinDark : L.skin;
    const cloth = far ? L.outfitDark : L.outfit;
    const boot = far ? '#4b2a17' : '#6e3d1f';
    limb(knee, ankle, 21, 18, skin);
    const bootTop = lerpPt(knee, ankle, 0.52);
    limb(bootTop, ankle, 23, 20, boot);
    limb(bootTop, lerpPt(knee, ankle, 0.6), 24, 23, '#c9902f', 4);
    limb(hip, knee, 31, 23, skin);
    limb(hip, lerpPt(hip, knee, 0.62), 35, 29, cloth);
    drawFoot(ankle, w, boot);
  }

  function drawArm(sh, el, hand, w, far) {
    const L = w.look;
    const skin = far ? L.skinDark : L.skin;
    limb(el, hand, 19, 16, skin);
    const ang = Math.atan2(el.y - sh.y, el.x - sh.x);
    const mid = lerpPt(sh, el, 0.5);
    let nx = -Math.sin(ang), ny = Math.cos(ang);
    if (ny > 0) { nx = -nx; ny = -ny; }
    const bulge = 8 + Math.min(1, w.effort) * 5.5;
    union([
      () => capsule(ctx, sh, el, 13, 10),
      () => { ctx.beginPath(); ctx.ellipse(mid.x + nx * 5, mid.y + ny * 5, 21, bulge, ang, 0, TAU); }
    ], skin);
    // wrist wrap
    limb(lerpPt(el, hand, 0.66), lerpPt(el, hand, 0.82), 20, 19, far ? L.outfitDark : L.outfitLight, 4);
    // shoulder cap
    circle(ctx, sh.x, sh.y, 15);
    ctx.lineWidth = 4.5;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.fillStyle = skin;
    ctx.fill();
  }

  function drawFist(h, w, far) {
    const skin = far ? w.look.skinDark : w.look.skin;
    circle(ctx, h.x, h.y, 11.5);
    ctx.lineWidth = 4.5;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.fillStyle = skin;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const dx of [-4.5, 0, 4.5]) { ctx.moveTo(h.x + dx, h.y - 9); ctx.lineTo(h.x + dx, h.y - 3); }
    ctx.stroke();
  }

  function drawTorso(w, P) {
    const L = w.look, s = w.side;
    const dx = P.sh.x - P.hip.x, dy = P.sh.y - P.hip.y;
    const len = Math.hypot(dx, dy);
    ctx.save();
    ctx.translate(P.hip.x, P.hip.y);
    ctx.rotate(Math.atan2(dy, dx) + Math.PI / 2);
    ctx.scale(-s, 1);
    const top = -len;
    const path = () => {
      ctx.beginPath();
      ctx.moveTo(-25, 8);
      ctx.bezierCurveTo(-33, top * 0.45, -37, top * 0.85, -24, top - 6);
      ctx.quadraticCurveTo(-4, top - 17, 17, top - 8);
      ctx.bezierCurveTo(39, top + 4, 37, top * 0.5, 22, top * 0.28);
      ctx.quadraticCurveTo(27, -6, 21, 8);
      ctx.quadraticCurveTo(0, 17, -25, 8);
      ctx.closePath();
    };
    path();
    ctx.lineWidth = 5;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.fillStyle = L.skin;
    ctx.fill();
    ctx.save();
    path();
    ctx.clip();
    // singlet with a strap over the shoulder
    ctx.fillStyle = L.outfit;
    ctx.beginPath();
    ctx.moveTo(-60, 30);
    ctx.lineTo(-60, top * 0.8);
    ctx.lineTo(-16, top * 0.8);
    ctx.lineTo(-12, top - 22);
    ctx.lineTo(4, top - 22);
    ctx.lineTo(6, top * 0.74);
    ctx.quadraticCurveTo(22, top * 0.64, 60, top * 0.7);
    ctx.lineTo(60, 30);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    // back shading
    ctx.fillStyle = 'rgba(0,0,0,0.14)';
    ctx.fillRect(-60, top - 30, 36, len + 60);
    // side stripe
    ctx.strokeStyle = L.trim;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(-8, 10);
    ctx.quadraticCurveTo(-12, top * 0.4, -10, top * 0.78);
    ctx.stroke();
    // belt
    ctx.fillStyle = L.outfitDark;
    ctx.fillRect(-60, -8, 120, 12);
    ctx.fillStyle = L.trim;
    rr(ctx, 8, -9, 12, 14, 3);
    ctx.fill();
    // chest emblem (sun / tunduk motif)
    ctx.fillStyle = L.trim;
    circle(ctx, 16, top * 0.52, 7.5);
    ctx.fill();
    ctx.strokeStyle = L.outfitDark;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(10, top * 0.52); ctx.lineTo(22, top * 0.52);
    ctx.moveTo(16, top * 0.52 - 6); ctx.lineTo(16, top * 0.52 + 6);
    ctx.stroke();
    // pec / collar line on skin
    ctx.strokeStyle = 'rgba(80,40,20,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(8, top * 0.8);
    ctx.quadraticCurveTo(22, top * 0.86, 30, top * 0.78);
    ctx.stroke();
    ctx.restore();
    ctx.restore();
  }

  const R = BODY.headR;
  const headShapes = [
    () => { ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); },
    () => { ctx.beginPath(); ctx.ellipse(7, 12, 25, 19, 0, 0, TAU); },
    () => { ctx.beginPath(); ctx.ellipse(30, 2, 7, 8, 0, 0, TAU); },
    () => { ctx.beginPath(); ctx.ellipse(-11, 4, 7, 9, 0, 0, TAU); }
  ];

  function drawEye(x, y, type, front) {
    const rx = front ? 6 : 5.3, ry = front ? 7.5 : 6.8;
    ctx.strokeStyle = INK;
    ctx.fillStyle = INK;
    ctx.lineWidth = 2.5;
    switch (type) {
      case 'open':
      case 'wide': {
        const k = type === 'wide' ? 1.15 : 1;
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.ellipse(x, y, rx * k, ry * k, 0, 0, TAU); ctx.fill(); ctx.stroke();
        ctx.fillStyle = INK;
        circle(ctx, x + 1.8, y + 0.5, type === 'wide' ? 2.2 : 3.2); ctx.fill();
        if (type === 'open') { ctx.fillStyle = '#fff'; circle(ctx, x + 2.6, y - 0.8, 1); ctx.fill(); }
        break;
      }
      case 'narrow':
      case 'glare': {
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.ellipse(x, y + 1.8, rx, ry * 0.5, 0, 0, TAU); ctx.fill(); ctx.stroke();
        ctx.fillStyle = INK;
        circle(ctx, x + 1.8, y + 2, type === 'glare' ? 1.8 : 2.6); ctx.fill();
        ctx.lineWidth = 3.5;
        ctx.beginPath(); ctx.moveTo(x - rx - 1, y - 0.5); ctx.lineTo(x + rx + 1, y - 0.5); ctx.stroke();
        break;
      }
      case 'droopy': {
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.ellipse(x, y + 2.5, rx, ry * 0.45, 0, 0, Math.PI); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillStyle = INK;
        circle(ctx, x + 1, y + 4.5, 2); ctx.fill();
        ctx.lineWidth = 3.5;
        ctx.beginPath(); ctx.moveTo(x - rx - 1, y + 2.5); ctx.lineTo(x + rx + 1, y + 2.5); ctx.stroke();
        break;
      }
      case 'squeeze': {
        ctx.lineWidth = 3.2;
        const d = front ? -1 : 1;
        ctx.beginPath();
        ctx.moveTo(x - 5 * d, y - 5); ctx.lineTo(x + 4 * d, y); ctx.lineTo(x - 5 * d, y + 5);
        ctx.stroke();
        break;
      }
      case 'happy':
        ctx.lineWidth = 3.2;
        ctx.beginPath(); ctx.moveTo(x - 5, y + 2); ctx.quadraticCurveTo(x, y - 7, x + 5, y + 2); ctx.stroke();
        break;
      case 'closed':
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(x - 5, y + 1); ctx.quadraticCurveTo(x, y + 4, x + 5, y + 1); ctx.stroke();
        break;
      case 'dizzy': {
        ctx.lineWidth = 2;
        ctx.beginPath();
        const rot = game.time * 8 * (front ? 1 : -1);
        for (let a = 0; a < TAU * 2.2; a += 0.3) {
          const r = 0.6 + a * 0.42;
          ctx.lineTo(x + Math.cos(a + rot) * r, y + Math.sin(a + rot) * r);
        }
        ctx.stroke();
        break;
      }
    }
  }

  function drawMouth(type) {
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2.8;
    switch (type) {
      case 'smile':
        ctx.beginPath(); ctx.moveTo(8, 15); ctx.quadraticCurveTo(16, 22, 24, 14); ctx.stroke();
        break;
      case 'flat':
        ctx.beginPath(); ctx.moveTo(9, 18); ctx.quadraticCurveTo(16, 16, 23, 18.5); ctx.stroke();
        break;
      case 'smirk':
        ctx.beginPath(); ctx.moveTo(8, 18); ctx.quadraticCurveTo(17, 20, 25, 12); ctx.stroke();
        break;
      case 'grit':
        ctx.fillStyle = '#fff';
        rr(ctx, 6, 12, 21, 11, 4); ctx.fill(); ctx.stroke();
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(6, 17.5); ctx.lineTo(27, 17.5);
        for (const x of [11, 16, 21]) { ctx.moveTo(x, 12); ctx.lineTo(x, 23); }
        ctx.stroke();
        break;
      case 'strainOpen':
        ctx.fillStyle = '#5a1a14';
        rr(ctx, 5, 11, 23, 14, 5); ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillRect(6.5, 12, 20, 4);
        ctx.fillRect(6.5, 20.5, 20, 3.5);
        rr(ctx, 5, 11, 23, 14, 5); ctx.stroke();
        break;
      case 'roar':
        ctx.fillStyle = '#4a1210';
        ctx.beginPath(); ctx.ellipse(16, 19, 10, 9.5, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = '#e5636b';
        ctx.beginPath(); ctx.ellipse(16, 24, 6, 3.5, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillRect(9, 10.5, 14, 3.5);
        ctx.beginPath(); ctx.ellipse(16, 19, 10, 9.5, 0, 0, TAU); ctx.stroke();
        break;
      case 'grin':
        ctx.fillStyle = '#4a1210';
        ctx.beginPath();
        ctx.moveTo(5, 13); ctx.lineTo(27, 11.5);
        ctx.quadraticCurveTo(26, 27, 16, 27);
        ctx.quadraticCurveTo(6, 26, 5, 13);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#e5636b';
        ctx.beginPath(); ctx.ellipse(16, 23.5, 6, 3.2, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.moveTo(6, 13); ctx.lineTo(26.5, 11.8); ctx.lineTo(26, 15.5); ctx.lineTo(6.5, 16.5); ctx.closePath(); ctx.fill();
        ctx.beginPath();
        ctx.moveTo(5, 13); ctx.lineTo(27, 11.5);
        ctx.quadraticCurveTo(26, 27, 16, 27);
        ctx.quadraticCurveTo(6, 26, 5, 13);
        ctx.closePath();
        ctx.stroke();
        break;
      case 'tired':
        ctx.fillStyle = '#4a1210';
        ctx.beginPath(); ctx.ellipse(16, 19, 5.5, 6, 0, 0, TAU); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#e5636b';
        rr(ctx, 12.5, 21, 7, 9 + Math.sin(game.time * 9) * 1.2, 3.5); ctx.fill();
        ctx.lineWidth = 2; ctx.stroke();
        break;
      case 'wavy':
        ctx.beginPath();
        for (let x = 7; x <= 25; x += 1) ctx.lineTo(x, 19 + Math.sin(x * 0.9 + game.time * 6) * 2);
        ctx.stroke();
        break;
    }
  }

  function drawHead(w, P) {
    const L = w.look, s = w.side;
    let eType = (EXPR[w.expr] || EXPR.focus).eyes;
    const e = EXPR[w.expr] || EXPR.focus;
    if (w.blink > 0 && (eType === 'open' || eType === 'narrow' || eType === 'wide')) eType = 'closed';
    const ang = (Math.atan2(P.head.y - P.sh.y, P.head.x - P.sh.x) + Math.PI / 2) * 0.65;
    ctx.save();
    ctx.translate(P.head.x, P.head.y);
    ctx.rotate(ang);
    ctx.scale(-s, 1);
    const t = game.time;

    const st = L.style;
    // back-of-head pieces (behind the head)
    ctx.lineCap = 'round';
    if (st === 'player') {
      const wv = Math.sin(t * 7) * 3;
      for (const [ex, ey] of [[-54, -8 + wv], [-50, 4 - wv]]) {
        ctx.strokeStyle = INK; ctx.lineWidth = 10;
        ctx.beginPath(); ctx.moveTo(-28, -18); ctx.quadraticCurveTo(-40, -16, ex, ey); ctx.stroke();
        ctx.strokeStyle = L.outfit; ctx.lineWidth = 5.5;
        ctx.beginPath(); ctx.moveTo(-28, -18); ctx.quadraticCurveTo(-40, -16, ex, ey); ctx.stroke();
      }
    } else if (st === 'aibek') {
      const wv = Math.sin(t * 3) * 3;
      ctx.strokeStyle = INK; ctx.lineWidth = 14;
      ctx.beginPath(); ctx.moveTo(-22, -28); ctx.bezierCurveTo(-46, -22, -44 + wv, 0, -40 + wv, 20); ctx.stroke();
      ctx.strokeStyle = L.hair; ctx.lineWidth = 9;
      ctx.beginPath(); ctx.moveTo(-22, -28); ctx.bezierCurveTo(-46, -22, -44 + wv, 0, -40 + wv, 20); ctx.stroke();
    } else if (st === 'ermek') {
      // the kalpak's tassel swings behind
      const wv = Math.sin(t * 4) * 2.5;
      ctx.strokeStyle = INK; ctx.lineWidth = 3.5;
      ctx.beginPath(); ctx.moveTo(-8, -62); ctx.quadraticCurveTo(-30, -58, -38 + wv, -36); ctx.stroke();
      ctx.fillStyle = '#e0392f'; ctx.lineWidth = 2.5;
      circle(ctx, -38 + wv, -33, 5); ctx.fill(); ctx.stroke();
    }

    union(headShapes, L.skin, 5);
    // ear detail
    ctx.strokeStyle = 'rgba(90,45,20,0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(-11, 4, 3.6, -1.2, 2); ctx.stroke();

    if (w.red > 0.02) {
      ctx.save();
      ctx.globalAlpha = w.red * 0.45;
      ctx.fillStyle = '#ff3b2f';
      headShapes[0](); ctx.fill();
      headShapes[1](); ctx.fill();
      ctx.restore();
    }
    if (st === 'aibek' || st === 'temir') {
      // stubble + scalp shine (Temir's head is shaved, so it shines more)
      ctx.fillStyle = st === 'temir' ? 'rgba(20,10,5,0.3)' : 'rgba(40,20,10,0.18)';
      ctx.beginPath(); ctx.ellipse(10, 20, 20, 10, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.32)';
      ctx.beginPath(); ctx.ellipse(-6, -20, st === 'temir' ? 14 : 11, st === 'temir' ? 6 : 5, -0.4, 0, TAU); ctx.fill();
    }
    if (st === 'ermek') {
      // freckles
      ctx.fillStyle = 'rgba(150,80,40,0.55)';
      for (const [fx, fy] of [[0, 4], [4, 7], [-2, 9], [25, 5], [28, 8]]) { circle(ctx, fx, fy, 1.1); ctx.fill(); }
    }
    const blush = Math.max(w.blush, L.blush || 0);
    if (blush > 0.02) {
      ctx.fillStyle = `rgba(255,90,110,${blush * 0.7})`;
      ctx.beginPath(); ctx.ellipse(2, 9, 5, 3, 0, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.ellipse(24, 9, 4, 3, 0, 0, TAU); ctx.fill();
    }
    if (st === 'temir') {
      // deep-set eyes under a heavy brow ridge
      ctx.fillStyle = 'rgba(40,15,10,0.28)';
      ctx.beginPath(); ctx.ellipse(12, -8, 20, 8, 0, 0, TAU); ctx.fill();
    }

    drawEye(4, -6, eType, false);
    drawEye(19, -6, eType, true);

    if (st === 'temir') {
      // old scar across the front eye
      ctx.strokeStyle = '#a8433c';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(14, -26); ctx.lineTo(26, 4); ctx.stroke();
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (const k of [0.22, 0.5, 0.78]) {
        const x = 14 + 12 * k, y = -26 + 30 * k;
        ctx.moveTo(x - 4, y + 1.6); ctx.lineTo(x + 4, y - 1.6);
      }
      ctx.stroke();
    }

    // brows
    const a = e.brow + (L.browBias || 0);
    ctx.strokeStyle = L.hair;
    ctx.lineWidth = L.browWidth || 4.5;
    ctx.beginPath();
    ctx.moveTo(-3, -16 - a * 0.5);
    ctx.lineTo(10, -16 + a * 0.5);
    if (!L.unibrow) ctx.moveTo(14, -16 + a * 0.5);
    ctx.lineTo(25, -16 - a * 0.5);
    ctx.stroke();

    // nostril
    ctx.fillStyle = 'rgba(80,35,20,0.6)';
    circle(ctx, 29, 6, 1.6); ctx.fill();

    if (st === 'temir') {
      // full black beard around the jaw (the mouth is drawn on top)
      ctx.fillStyle = L.hair;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-8, 2);
      ctx.quadraticCurveTo(-6, 26, 6, 36);
      ctx.quadraticCurveTo(18, 46, 31, 34);
      ctx.quadraticCurveTo(37, 26, 34, 12);
      ctx.quadraticCurveTo(28, 23, 17, 25);
      ctx.quadraticCurveTo(5, 24, 1, 13);
      ctx.quadraticCurveTo(-3, 7, -8, 2);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    drawMouth(e.mouth);

    if (st === 'aibek') {
      // handlebar mustache
      ctx.fillStyle = L.hair;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(17, 9);
      ctx.quadraticCurveTo(8, 7, 3, 13);
      ctx.quadraticCurveTo(1, 19, -2, 20);
      ctx.quadraticCurveTo(6, 17, 9, 13);
      ctx.quadraticCurveTo(13, 12, 17, 12.5);
      ctx.quadraticCurveTo(23, 12, 27, 13);
      ctx.quadraticCurveTo(30, 17, 35, 19);
      ctx.quadraticCurveTo(32, 14, 30, 11);
      ctx.quadraticCurveTo(24, 6.5, 17, 9);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // topknot
      ctx.fillStyle = L.hair;
      ctx.lineWidth = 4;
      circle(ctx, -18, -30, 9); ctx.stroke(); ctx.fill();
      ctx.fillStyle = L.trim;
      ctx.fillRect(-24, -26, 11, 4);
    } else if (st === 'temir') {
      // heavy horseshoe moustache joining the beard
      ctx.fillStyle = L.hair;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(4, 18);
      ctx.quadraticCurveTo(5, 8, 17, 8.5);
      ctx.quadraticCurveTo(30, 8, 33, 18);
      ctx.lineTo(29, 19);
      ctx.quadraticCurveTo(26, 12.5, 17, 13);
      ctx.quadraticCurveTo(9, 12.5, 8, 19);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // iron ear ring
      ctx.strokeStyle = '#9aa0a8';
      ctx.lineWidth = 2.5;
      circle(ctx, -11, 13, 4); ctx.stroke();
    } else if (st === 'ermek') {
      // a few hairs peeking out under the hat
      ctx.fillStyle = L.hair;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.ellipse(-24, -10, 9, 12, 0.3, 0, TAU); ctx.stroke(); ctx.fill();
      // white felt kalpak with a black turned-up brim
      ctx.fillStyle = '#fbf6ea';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(-31, -14);
      ctx.quadraticCurveTo(-36, -48, -16, -66);
      ctx.quadraticCurveTo(-4, -74, 7, -63);
      ctx.quadraticCurveTo(23, -44, 29, -20);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = '#c9902f';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-14, -30); ctx.quadraticCurveTo(-10, -48, -4, -60);
      ctx.moveTo(4, -30); ctx.quadraticCurveTo(4, -46, 0, -60);
      ctx.stroke();
      ctx.fillStyle = '#1d1a24';
      ctx.strokeStyle = INK;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-34, -10);
      ctx.quadraticCurveTo(-2, -30, 31, -15);
      ctx.lineTo(29, -25);
      ctx.quadraticCurveTo(-2, -40, -33, -21);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // the brim is split at the front
      ctx.fillStyle = '#fbf6ea';
      ctx.beginPath(); ctx.moveTo(19, -21); ctx.lineTo(25, -21); ctx.lineTo(23, -29); ctx.closePath(); ctx.fill();
    } else {
      // spiky hair + headband
      ctx.fillStyle = L.hair;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(-31, 6);
      ctx.lineTo(-37, -8);
      ctx.lineTo(-32, -13);
      ctx.lineTo(-40, -24);
      ctx.lineTo(-27, -28);
      ctx.lineTo(-30, -42);
      ctx.lineTo(-14, -37);
      ctx.lineTo(-11, -50);
      ctx.lineTo(2, -39);
      ctx.lineTo(12, -49);
      ctx.lineTo(15, -35);
      ctx.lineTo(28, -38);
      ctx.lineTo(24, -26);
      ctx.quadraticCurveTo(10, -30, 0, -26);
      ctx.quadraticCurveTo(-18, -22, -21, -6);
      ctx.quadraticCurveTo(-24, 4, -31, 6);
      ctx.closePath();
      ctx.stroke();
      ctx.fill();
      ctx.lineCap = 'round';
      ctx.strokeStyle = INK; ctx.lineWidth = 11;
      ctx.beginPath(); ctx.moveTo(-30, -18); ctx.quadraticCurveTo(-2, -32, 27, -21); ctx.stroke();
      ctx.strokeStyle = L.outfit; ctx.lineWidth = 6.5;
      ctx.beginPath(); ctx.moveTo(-30, -18); ctx.quadraticCurveTo(-2, -32, 27, -21); ctx.stroke();
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(-28, -18.5); ctx.quadraticCurveTo(-2, -32, 26, -21.5); ctx.stroke();
    }

    if (e.vein) {
      ctx.strokeStyle = '#d0201a';
      ctx.lineWidth = 2.6;
      const vx = -6, vy = -22, k = 1 + Math.sin(t * 20) * 0.12;
      ctx.beginPath();
      ctx.moveTo(vx - 6 * k, vy - 2); ctx.quadraticCurveTo(vx - 2, vy - 2, vx - 2, vy - 6 * k);
      ctx.moveTo(vx + 6 * k, vy - 2); ctx.quadraticCurveTo(vx + 2, vy - 2, vx + 2, vy - 6 * k);
      ctx.moveTo(vx - 6 * k, vy + 2); ctx.quadraticCurveTo(vx - 2, vy + 2, vx - 2, vy + 6 * k);
      ctx.moveTo(vx + 6 * k, vy + 2); ctx.quadraticCurveTo(vx + 2, vy + 2, vx + 2, vy + 6 * k);
      ctx.stroke();
    }
    if (e.sweat) {
      const dropY = (Math.sin(t * 3) + 1) * 2;
      for (const [x, y] of [[-6, -16 + dropY], [27, -12 + dropY * 0.6]]) {
        ctx.fillStyle = '#9fdcff';
        ctx.strokeStyle = '#2b6aa0';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(x, y - 7);
        ctx.quadraticCurveTo(x + 5, y, x, y + 3);
        ctx.quadraticCurveTo(x - 5, y, x, y - 7);
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawWrestlerBack(w) {
    const P = w.pose;
    drawLeg(P.hip2, P.knee2, P.ankle2, w, true);
    drawArm(P.farSh, P.elbows[0], P.hands[0], w, true);
  }

  function drawWrestlerBody(w) {
    const P = w.pose;
    drawLeg(P.hip, P.knee, P.ankle, w, false);
    drawTorso(w, P);
    limb(lerpPt(P.sh, P.head, 0.25), lerpPt(P.sh, P.head, 0.8), 27, 25, w.look.skin);
    drawHead(w, P);
  }

  function drawWrestlerFront(w) {
    const P = w.pose;
    drawFist(P.hands[0], w, true);
    drawArm(P.sh, P.elbows[1], P.hands[1], w, false);
    drawFist(P.hands[1], w, false);
  }

  function drawStick() {
    const L = ARENA.stickHalf;
    ctx.save();
    ctx.translate(stick.x, stick.y);
    ctx.rotate(stick.angle);
    const g = ctx.createLinearGradient(0, -8, 0, 8);
    g.addColorStop(0, '#f0c27c');
    g.addColorStop(0.5, '#c98a46');
    g.addColorStop(1, '#8e5323');
    ctx.fillStyle = g;
    rr(ctx, -L, -8, L * 2, 16, 8);
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(90,45,15,0.45)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-L + 14, -2); ctx.bezierCurveTo(-30, -5, 10, 1, L - 16, -3);
    ctx.moveTo(-L + 30, 3); ctx.bezierCurveTo(-10, 5, 30, 2, L - 30, 4);
    ctx.stroke();
    ctx.fillStyle = '#7a4219';
    for (const x of [-L + 9, L - 9]) { rr(ctx, x - 3, -7, 6, 14, 2); ctx.fill(); }
    // center mark
    ctx.fillStyle = '#ffd23f';
    rr(ctx, -3, -7, 6, 14, 2);
    ctx.fill();
    ctx.restore();
  }

  function drawShadows() {
    ctx.fillStyle = 'rgba(40,10,10,0.25)';
    for (const w of [player, rival]) {
      const P = w.pose;
      ctx.beginPath();
      ctx.ellipse((P.hip.x + P.ankle.x) / 2, ARENA.groundY + 3, 95, 8, 0, 0, TAU);
      ctx.fill();
    }
  }

  function drawAuras() {
    const r = game.sim;
    if (!r || game.state !== S.PLAYING) return;
    const ai = r.ai;
    if (!ai || (ai.state !== AIState.ATTACK && ai.state !== AIState.DESPERATION)) return;
    const P = rival.pose;
    const cx = (P.hip.x + P.sh.x) / 2, cy = (P.hip.y + P.sh.y) / 2 - 10;
    const desp = ai.state === AIState.DESPERATION;
    const strike = ai.phase === 'strike';
    const pulse = 0.6 + Math.sin(game.time * (strike ? 30 : 14)) * 0.4;
    const rad = (desp ? 170 : 130) * (strike ? 1.1 : 0.9);
    const g = ctx.createRadialGradient(cx, cy, 10, cx, cy, rad);
    const col = desp ? '255,140,30' : '255,40,30';
    g.addColorStop(0, `rgba(${col},${0.45 * pulse})`);
    g.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, TAU);
    ctx.fill();
  }

  function drawMotionLines() {
    const st = game.state;
    if (st !== S.PLAYING) return;
    const r = game.sim;
    const t = game.time;
    for (const w of [player, rival]) {
      const isAI = w === rival;
      const strike = isAI && !!r.ai && r.ai.phase === 'strike';
      const intensity = strike ? 1 : clamp((w.effort - 0.55) * 2.2, 0, 1);
      if (intensity <= 0.05) continue;
      const P = w.pose;
      ctx.strokeStyle = strike ? `rgba(220,30,20,${0.8 * intensity})` : `rgba(43,26,20,${0.55 * intensity})`;
      ctx.lineWidth = strike ? 3.5 : 2.6;
      ctx.lineCap = 'round';
      const anchors = [P.sh, P.elbows[1], P.farSh];
      for (let i = 0; i < 3; i++) {
        const flick = (Math.sin(t * 23 + i * 2.1) + 1) * 0.5;
        const a = anchors[i];
        const x0 = a.x + w.side * (30 + flick * 10);
        const y = a.y + (i - 1) * 14;
        const len = (16 + flick * 18) * (0.6 + intensity * 0.6);
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(x0 + w.side * len, y);
        ctx.stroke();
      }
    }
  }

  function drawIndicators() {
    const r = game.sim, t = game.time;
    if (r && game.state === S.PLAYING) {
      const ai = r.ai;
      const warn = !!ai && (ai.state === AIState.ATTACK || ai.state === AIState.DESPERATION) && ai.phase === 'windup';
      if (warn) {
        const desp = ai.state === AIState.DESPERATION;
        const P = rival.pose;
        const x = P.head.x, y = P.head.y - 70 + Math.sin(t * 16) * 4;
        const sc = 1 + Math.sin(t * 20) * 0.08 + (desp ? 0.25 : 0);
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(sc, sc);
        ctx.fillStyle = desp ? '#ff9a1f' : '#e0392f';
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(0, 26);
        ctx.lineTo(-8, 16);
        ctx.arc(0, 0, 21, Math.PI * 0.62, Math.PI * 2.38);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.font = `30px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(desp ? '!!' : '!', 0, 2);
        ctx.restore();
      }
    }
    // dizzy stars over the loser
    const ei = game.endInfo;
    if (ei && (game.state === S.ROUND_END || game.state === S.MATCH_END) && ei.t > 0.7) {
      const loser = ei.winner === 'left' ? rival : player;
      const P = loser.pose;
      for (let i = 0; i < 3; i++) {
        const a = t * 3 + (i * TAU) / 3;
        const x = P.head.x + Math.cos(a) * 30;
        const y = P.head.y - 30 + Math.sin(a) * 9;
        drawStar(x, y, 7, '#ffd23f');
      }
    }
  }

  function drawStar(x, y, r, col) {
    ctx.fillStyle = col;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const rad = i % 2 ? r * 0.45 : r;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      ctx.lineTo(x + Math.cos(a) * rad, y + Math.sin(a) * rad);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  /* ======================================================================
     PARTICLES & POPUPS
     ====================================================================== */
  function spawn(p) { if (particles.length < 500) particles.push(p); }

  function spawnSweat(w) {
    const P = w.pose;
    if (!P) return;
    const s = w.side;
    spawn({
      type: 'sweat', x: P.head.x + (Math.random() - 0.5) * 30, y: P.head.y - 18 + Math.random() * 10,
      vx: s * (40 + Math.random() * 90), vy: -120 - Math.random() * 90, life: 0.8, max: 0.8, size: 3 + Math.random() * 2
    });
  }

  function spawnDust(x, y, n, spread = 40) {
    for (let i = 0; i < n; i++) {
      spawn({
        type: 'dust', x: x + (Math.random() - 0.5) * spread, y: y - Math.random() * 6,
        vx: (Math.random() - 0.5) * 120, vy: -20 - Math.random() * 50, life: 0.7 + Math.random() * 0.4, max: 1.1,
        size: 6 + Math.random() * 8
      });
    }
  }

  function spawnPuff(x, y) {
    spawn({ type: 'ring', x, y, vx: 0, vy: 0, life: 0.25, max: 0.25, size: 10 });
    for (let i = 0; i < 3; i++) {
      const a = Math.random() * TAU;
      spawn({ type: 'spark', x, y, vx: Math.cos(a) * 160, vy: Math.sin(a) * 160 - 40, life: 0.25, max: 0.25, size: 2.5 });
    }
  }

  function spawnBreath(w) {
    const P = w.pose;
    if (!P) return;
    spawn({
      type: 'breath', x: P.head.x - w.side * 34, y: P.head.y + 16,
      vx: -w.side * (30 + Math.random() * 20), vy: -15 - Math.random() * 10, life: 0.9, max: 0.9, size: 5
    });
  }

  function spawnConfetti(burst) {
    const cols = ['#ffd23f', '#2f7ae5', '#e0392f', '#3fae55', '#ffffff', '#f07c2a', '#b38bff'];
    for (let i = 0; i < burst; i++) {
      const fromLeft = Math.random() < 0.5;
      confetti.push({
        x: fromLeft ? -10 : W + 10, y: 380 + Math.random() * 200,
        vx: (fromLeft ? 1 : -1) * (280 + Math.random() * 380), vy: -420 - Math.random() * 360,
        rot: Math.random() * TAU, vr: (Math.random() - 0.5) * 14, flip: Math.random() * TAU,
        col: cols[Math.floor(Math.random() * cols.length)], w: 7 + Math.random() * 6, h: 4 + Math.random() * 4,
        life: 4 + Math.random() * 2
      });
    }
    if (confetti.length > 700) confetti.splice(0, confetti.length - 700);
  }

  function addPopup(text, x, y, color, size = 30) {
    popups.push({ text, x, y, color, size, life: 1.0, max: 1.0 });
  }

  function updateParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.type === 'sweat') p.vy += 620 * dt;
      else if (p.type === 'dust') { p.vx *= Math.exp(-3 * dt); p.vy *= Math.exp(-2 * dt); p.size += 14 * dt; }
      else if (p.type === 'breath') p.size += 10 * dt;
      else if (p.type === 'spark') p.vy += 400 * dt;
    }
    for (let i = confetti.length - 1; i >= 0; i--) {
      const c = confetti[i];
      c.life -= dt;
      if (c.life <= 0 || c.y > H + 30) { confetti.splice(i, 1); continue; }
      c.vx *= Math.exp(-1.6 * dt);
      c.vy = Math.min(c.vy + 520 * dt, 110 + Math.sin(c.flip) * 30);
      c.x += (c.vx + Math.sin(game.time * 3 + c.flip) * 30) * dt;
      c.y += c.vy * dt;
      c.rot += c.vr * dt;
      c.flip += dt * 8;
    }
    for (let i = popups.length - 1; i >= 0; i--) {
      const p = popups[i];
      p.life -= dt;
      p.y -= 50 * dt;
      if (p.life <= 0) popups.splice(i, 1);
    }
  }

  function drawParticles() {
    for (const p of particles) {
      const a = clamp(p.life / p.max, 0, 1);
      switch (p.type) {
        case 'sweat': {
          const ang = Math.atan2(p.vy, p.vx) + Math.PI / 2;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(ang);
          ctx.globalAlpha = a;
          ctx.fillStyle = '#9fdcff';
          ctx.strokeStyle = '#2b6aa0';
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(0, -p.size * 2);
          ctx.quadraticCurveTo(p.size, 0, 0, p.size);
          ctx.quadraticCurveTo(-p.size, 0, 0, -p.size * 2);
          ctx.fill();
          ctx.stroke();
          ctx.restore();
          break;
        }
        case 'dust':
          ctx.fillStyle = `rgba(222,190,140,${0.55 * a})`;
          circle(ctx, p.x, p.y, p.size);
          ctx.fill();
          break;
        case 'breath':
          ctx.fillStyle = `rgba(255,255,255,${0.7 * a})`;
          circle(ctx, p.x, p.y, p.size);
          ctx.fill();
          break;
        case 'ring':
          ctx.strokeStyle = `rgba(255,255,255,${a})`;
          ctx.lineWidth = 3;
          circle(ctx, p.x, p.y, p.size + (1 - a) * 18);
          ctx.stroke();
          break;
        case 'spark':
          ctx.fillStyle = `rgba(255,236,150,${a})`;
          circle(ctx, p.x, p.y, p.size);
          ctx.fill();
          break;
      }
    }
  }

  function drawPopups() {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const p of popups) {
      const a = clamp(p.life / p.max * 2, 0, 1);
      const sc = 1 + Math.max(0, p.life - p.max + 0.15) * 4;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.translate(p.x, p.y);
      ctx.scale(sc, sc);
      ctx.font = `${p.size}px ${FONT}`;
      ctx.lineWidth = 6;
      ctx.strokeStyle = INK;
      ctx.strokeText(p.text, 0, 0);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, 0, 0);
      ctx.restore();
    }
  }

  function drawConfetti() {
    for (const c of confetti) {
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(c.rot);
      ctx.scale(1, Math.cos(c.flip));
      ctx.fillStyle = c.col;
      ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
      ctx.restore();
    }
  }

  /* ======================================================================
     FLOW: rounds, countdown, results
     Sides: 'left' is player 1 (blue). 'right' is the AI in 1-player mode
     and player 2 (red) in 2-player mode.
     ====================================================================== */
  const SIDES = ['left', 'right'];
  const FACT_COUNT = 8;
  const isHuman = (side) => side === 'left' || game.mode === '2p';
  const wrestlerOf = (side) => (side === 'left' ? player : rival);
  // A phone held upright shows the rotate overlay; the match waits until it is turned back.
  const portraitMQ = window.matchMedia ? window.matchMedia('(orientation: portrait) and (pointer: coarse)') : null;
  const portraitPaused = () => !!portraitMQ && portraitMQ.matches;

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function showScreen(el, on) { el.classList.toggle('show', on); }

  function setState(s) {
    game.state = s;
    game.stateTime = 0;
    showScreen(ui.menu, s === S.MENU);
    showScreen(ui.howto, s === S.HOW_TO_PLAY);
    showScreen(ui.faq, s === S.FAQ);
    showScreen(ui.matchEnd, s === S.MATCH_END);
    if (s !== S.ROUND_END) showScreen(ui.roundEnd, false);
    ui.lang.classList.toggle('show', s === S.MENU || s === S.HOW_TO_PLAY || s === S.FAQ);
    setLangMenu(false);
    ui.hud.classList.toggle('show', s === S.COUNTDOWN || s === S.PLAYING || s === S.ROUND_END);
    ui.hud.classList.toggle('meters-off', s !== S.PLAYING && s !== S.COUNTDOWN);
    ui.touchZones.classList.toggle('show', s === S.COUNTDOWN && game.mode === '2p');
    document.body.classList.toggle('in-match', s === S.COUNTDOWN || s === S.PLAYING);
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }

  function showCountdown(text, cls) {
    const el = ui.countdown;
    el.textContent = text;
    el.className = '';
    void el.offsetWidth; // restart CSS animation
    el.className = 'show ' + cls;
    fitText(el, 1180);
  }

  function updateScoreUI() {
    ui.scoreLabel.textContent = `${game.leftWins} : ${game.rightWins}`;
    Array.from(ui.playerPips.children).forEach((el, i) => el.classList.toggle('on', i < game.leftWins));
    Array.from(ui.aiPips.children).forEach((el, i) => el.classList.toggle('on', i < game.rightWins));
  }

  /** Text that depends on the language, the mode, the input type or the chosen opponent. */
  function refreshDynamicText() {
    const two = game.mode === '2p', touch = game.input === 'touch', d = game.difficulty;
    document.body.classList.toggle('mode-2p', two);
    document.body.classList.toggle('mode-1p', !two);
    ui.leftName.textContent = two ? t('p1') : t('you');
    ui.rightName.textContent = two ? t('p2') : t(d + 'Name');
    ui.rightSub.textContent = two ? t('redCorner') : t(d + 'Title').toUpperCase();
    ui.oppStory.innerHTML = `<b>${t(d + 'Name')}</b> · ${t(d + 'Title')}<br>${t(d + 'Story')}`;
    rival.look = two ? LOOKS.aibek : OPPONENT_LOOKS[d];
    ui.rightPlate.dataset.opp = two ? 'p2' : d;
    const keys = { left: two ? 'A' : t('spaceKey'), right: 'L' };
    for (const side of SIDES) {
      const m = ui.meters[side];
      m.key.textContent = keys[side];
      m.key.classList.toggle('wide', !two);
      m.hint.textContent = touch ? t('tapToPull') : t('toPull');
    }
    ui.twoPRule.textContent = t('twoPRule', { s: B.twoPlayer.roundTime });
    ui.tzLeft.textContent = touch ? t('tapHere', { p: t('p1') }) : t('pressKey', { p: t('p1'), k: 'A' });
    ui.tzRight.textContent = touch ? t('tapHere', { p: t('p2') }) : t('pressKey', { p: t('p2'), k: 'L' });
    document.querySelectorAll('.np-name').forEach((el) => fitText(el, el.parentElement.clientWidth - 24));
  }

  function setMode(mode) {
    game.mode = mode === '2p' ? '2p' : '1p';
    ui.modeBtns.forEach((b) => {
      const on = b.dataset.mode === game.mode;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    refreshDynamicText();
    refit();
  }

  /** Hints follow the input actually used; both inputs always work. */
  function setInputMode(mode) {
    if (game.input === mode) return;
    game.input = mode;
    document.body.classList.toggle('input-touch', mode === 'touch');
    document.body.classList.toggle('input-keyboard', mode !== 'touch');
    refreshDynamicText();
  }

  function startMatch() {
    game.leftWins = 0;
    game.rightWins = 0;
    game.round = 1;
    game.factDeck = shuffle(Array.from({ length: FACT_COUNT }, (_, i) => i + 1));
    confetti.length = 0;
    refreshDynamicText();
    startRound();
  }

  function startRound() {
    game.sim = createRound(game.difficulty, { mode: game.mode });
    game.endInfo = null;
    game.cd = { t: 0, step: -1 };
    for (const side of SIDES) Object.assign(game.taps[side], { times: [], count: 0, last: -1, rate: 0 });
    activePointers.clear();
    stick.nudge = 0;
    ui.roundLabel.textContent = t('round', { n: game.round });
    updateScoreUI();
    setState(S.COUNTDOWN);
  }

  const CD_MARKS = [0.05, 0.95, 1.75, 2.55, 3.35];
  function updateCountdown(dt) {
    const cd = game.cd;
    cd.t += dt;
    while (cd.step + 1 < CD_MARKS.length && cd.t >= CD_MARKS[cd.step + 1]) {
      cd.step++;
      if (cd.step === 0) {
        showCountdown(game.round === 3 ? t('finalRound') : t('round', { n: game.round }), 'round');
      } else if (cd.step < 4) {
        showCountdown(String(4 - cd.step), 'num');
        Sound.count();
      } else {
        showCountdown(t('go'), 'go');
        Sound.go();
        setState(S.PLAYING); // input is accepted from this moment on
        game.crowdBoost = 0.8;
        return;
      }
    }
  }

  function endRound(winner) {
    if (game.state !== S.PLAYING || game.endInfo) return; // never score twice
    if (winner === 'left') game.leftWins++;
    else game.rightWins++;
    const matchOver = game.leftWins >= 2 || game.rightWins >= 2;
    game.endInfo = { winner, t: 0, overlay: false, matchOver };
    setState(S.ROUND_END);
    updateScoreUI();
    game.shake = Math.max(game.shake, 9);
    game.crowdBoost = 3;
    const cheer = winner === 'left' || game.mode === '2p'; // in 2P someone in the room always won
    if (cheer) Sound.roundWin();
    else Sound.roundLose();
    Sound.grunt(winner === 'right');
    spawnDust(ARENA.boardX, ARENA.groundY - 4, 14, 120);
    if (game.sim.timeUp) {
      addPopup(t('timeUp'), ARENA.boardX, 300, '#ffd23f', 46);
      Sound.go();
    }
    const loser = winner === 'left' ? rival : player;
    addPopup(cheer ? t('popYes') : t('popOof'), loser.pose.head.x, loser.pose.head.y - 70, winner === 'left' ? '#7cc2ff' : '#ff6a5c', 38);
  }

  /** One "Did you know?" fact per round, never repeated within a match. */
  function showFact() {
    if (!game.factDeck.length) game.factDeck = shuffle(Array.from({ length: FACT_COUNT }, (_, i) => i + 1));
    const n = game.factDeck.pop();
    ui.factCard.dataset.fact = n;
    ui.factText.textContent = t('fact' + n);
  }

  function updateRoundEnd(dt) {
    const ei = game.endInfo;
    ei.t += dt;
    if (!ei.overlay && ei.t > 1.6) {
      ei.overlay = true;
      const leftWon = ei.winner === 'left';
      if (game.mode === '2p') {
        ui.roundTitle.textContent = t('roundWonBy', { n: leftWon ? 1 : 2 });
        ui.roundSub.textContent = t('roundSub2p', { p: game.leftWins, a: game.rightWins });
      } else {
        ui.roundTitle.textContent = leftWon ? t('roundWon') : t('roundLost');
        ui.roundSub.textContent = t('roundSub', { p: game.leftWins, a: game.rightWins, name: t(game.difficulty + 'Name') });
      }
      ui.roundTitle.className = 'result-title ' + (leftWon ? 'won' : 'lost');
      fitText(ui.roundTitle, 1180);
      showFact();
      ui.nextBtn.style.display = ei.matchOver ? 'none' : '';
      ui.roundHint.style.display = ei.matchOver ? 'none' : '';
      showScreen(ui.roundEnd, true);
      ui.hud.classList.remove('show');
    }
    if (ei.matchOver && ei.t > 5) goMatchEnd(); // a little longer, so the last fact can be read
  }

  function goMatchEnd() {
    const leftWon = game.leftWins > game.rightWins;
    const score = t('finalScore', { p: game.leftWins, a: game.rightWins });
    setState(S.MATCH_END);
    if (game.mode === '2p') {
      ui.matchTitle.textContent = t('champ2p', { n: leftWon ? 1 : 2 });
      ui.matchTitle.className = 'result-title big champ ' + (leftWon ? 'champ-blue' : 'champ-red');
      ui.matchSub.textContent = score;
      ui.trophy.style.display = '';
    } else {
      const names = { name: t(game.difficulty + 'Name'), obj: t(game.difficulty + 'Obj') };
      ui.matchTitle.textContent = leftWon ? t('champ') : t('defeat');
      ui.matchTitle.className = 'result-title big ' + (leftWon ? 'champ' : 'lost');
      ui.matchSub.textContent = `${leftWon ? t('beatOpp', names) : t('lostOpp', names)}  ·  ${score}`;
      ui.trophy.style.display = leftWon ? '' : 'none';
    }
    fitText(ui.matchTitle, 1160);
    fitText(ui.matchSub, 1180);
    const celebrate = leftWon || game.mode === '2p';
    game.crowdBoost = celebrate ? 6 : 2;
    if (celebrate) { Sound.matchWin(); spawnConfetti(160); }
    else Sound.matchLose();
  }

  function updateMatchEnd(dt) {
    const ei = game.endInfo;
    if (ei) ei.t += dt;
    const celebrate = game.leftWins > game.rightWins || game.mode === '2p';
    if (celebrate && game.stateTime < 5 && Math.random() < dt * 8) spawnConfetti(10);
  }

  function nextRound() {
    const ei = game.endInfo;
    if (game.state !== S.ROUND_END || !ei || !ei.overlay || ei.matchOver) return;
    game.round++;
    startRound();
  }

  function goMenu() {
    game.sim = null;
    game.endInfo = null;
    ui.countdown.className = '';
    setState(S.MENU);
  }

  function handleSimEvent(ev) {
    if (ev.type === 'exhausted') {
      const P = wrestlerOf(ev.side).pose;
      if (P) addPopup(t('popHuff'), P.head.x, P.head.y - 60, '#e8e8f0', 22);
      Sound.recovery();
      return;
    }
    const P = rival.pose;
    if (!P) return;
    const hx = P.head.x, hy = P.head.y;
    switch (ev.type) {
      case 'attackWarn':
        Sound.attackWarn();
        break;
      case 'attackStrike':
        Sound.attackStrike();
        game.shake = Math.max(game.shake, 6);
        stick.nudge += 7;
        addPopup(t('popHyaa'), hx, hy - 64, '#ff5a3c', 32);
        spawnDust(P.hip.x, ARENA.groundY - 4, 6);
        break;
      case 'desperationWarn':
        Sound.desperationWarn();
        game.shake = Math.max(game.shake, 3);
        addPopup(t('popLastStand'), hx, hy - 96, '#ffb02e', 30);
        break;
      case 'desperationStrike':
        Sound.desperationStrike();
        game.shake = Math.max(game.shake, 12);
        game.flash = 0.7;
        stick.nudge += 10;
        addPopup(t('popRaaagh'), hx, hy - 64, '#ff9a1f', 40);
        spawnDust(P.hip.x, ARENA.groundY - 4, 10, 70);
        break;
      case 'recovery':
        Sound.recovery();
        addPopup(t('popHuff'), hx, hy - 60, '#e8e8f0', 22);
        break;
    }
  }

  /** One fresh tap or key press for a human side. */
  function onPull(side) {
    const r = game.sim;
    if (game.state !== S.PLAYING || !r || r.winner || !isHuman(side)) return;
    const tp = game.taps[side];
    const now = performance.now() / 1000;
    if (now - tp.last < B.minTapInterval) return;
    tp.last = now;
    if (!registerPull(r, side)) return;
    tp.times.push(now);
    tp.count++;
    const w = wrestlerOf(side);
    const puller = side === 'left' ? r.left : r.right;
    w.kick = Math.min(1.4, w.kick + 0.7);
    stick.nudge += side === 'left' ? -2.2 : 2.2;
    Sound.pull(puller.force / r.maxForce);
    if (tp.count % 8 === 0) Sound.grunt(side === 'right');
    if (w.pose) spawnPuff(w.pose.hands[1].x, w.pose.hands[1].y);
    const key = ui.meters[side].key;
    key.classList.remove('hit');
    void key.offsetWidth;
    key.classList.add('hit');
  }

  /* ======================================================================
     PER-FRAME UPDATE
     ====================================================================== */
  function updateActors(dt) {
    const st = game.state, r = game.sim, ei = game.endInfo;
    const inMatch = !!r && (st === S.COUNTDOWN || st === S.PLAYING || st === S.ROUND_END || st === S.MATCH_END);
    let pull, pEff, aEff, aiInfo = null, tiredL = false, tiredR = false;
    if (inMatch) {
      pull = r.pullPosition;
      if (st === S.COUNTDOWN) {
        pEff = 0.22; aEff = 0.22;
      } else {
        pEff = r.left.force / r.maxForce;
        aEff = r.right ? r.right.force / r.maxForce : r.aiForce / (r.cfg.baseForce + r.cfg.attackBonus);
        if (st === S.PLAYING) {
          aiInfo = r.ai;
          tiredL = r.left.tired;
          tiredR = !!r.right && r.right.tired;
        }
      }
    } else {
      game.menuPull = Math.sin(game.time * 0.55) * 24 + Math.sin(game.time * 1.4) * 7;
      pull = game.menuPull;
      pEff = 0.35 + 0.15 * Math.sin(game.time * 1.1);
      aEff = 0.35 + 0.15 * Math.sin(game.time * 0.9 + 1);
    }
    const ending = !!ei && (st === S.ROUND_END || st === S.MATCH_END);
    const strike = !!aiInfo && aiInfo.phase === 'strike';

    animateWrestler(player, dt, {
      mode: ending ? (ei.winner === 'left' ? 'win' : 'lose') : 'play',
      adv: -pull / 100, effort: pEff, t: ending ? ei.t : 0, ai: null, underAttack: strike, idle: !inMatch, tired: tiredL
    });
    animateWrestler(rival, dt, {
      mode: ending ? (ei.winner === 'right' ? 'win' : 'lose') : 'play',
      adv: pull / 100, effort: aEff, t: ending ? ei.t : 0, ai: aiInfo, underAttack: false, idle: !inMatch, tired: tiredR
    });

    // the shared stick
    stick.nudge = damp(stick.nudge, 0, 10, dt);
    if (ending) {
      const s = ei.winner === 'left' ? -1 : 1;
      const celebrate = ei.t >= 1.3;
      const bounce = celebrate ? Math.abs(Math.sin(game.time * 6)) * 6 : 0;
      const rate = ei.t < 0.45 ? 10 : 6;
      stick.x = damp(stick.x, ARENA.boardX + s * (celebrate ? 152 : 138), rate, dt);
      stick.y = damp(stick.y, celebrate ? 348 - bounce : 500, rate, dt);
      stick.angle = damp(stick.angle, celebrate ? Math.sin(game.time * 3) * 0.06 : -s * 0.1, 6, dt);
    } else {
      const jitter = strike ? Math.sin(game.time * 71) * 1.8 : 0;
      const tx = ARENA.boardX + (pull / 100) * ARENA.stickRange + stick.nudge + jitter;
      const ty = ARENA.stickY + Math.sin(game.time * 2.1) * 1.2 - (Math.abs(pull) / 100) * 6;
      if (st === S.PLAYING) {
        stick.x = tx;
        stick.y = damp(stick.y, ty, 12, dt);
      } else {
        stick.x = damp(stick.x, tx, 7, dt);
        stick.y = damp(stick.y, ty, 7, dt);
      }
      stick.angle = damp(stick.angle, 0, 8, dt);
    }

    player.pose = computePose(player);
    rival.pose = computePose(rival);

    // ambient effects
    if (st === S.PLAYING) {
      for (const w of [player, rival]) {
        if (EXPR[w.expr] && EXPR[w.expr].sweat) {
          w.sweatIn -= dt;
          if (w.sweatIn <= 0) { spawnSweat(w); w.sweatIn = 0.12 + Math.random() * 0.2; }
        }
      }
      // heavy breathing: tired humans, or the AI catching its breath after an attack
      for (const side of SIDES) {
        const gasping = side === 'left' ? r.left.tired : r.right ? r.right.tired : r.ai.state === AIState.RECOVERY;
        if (!gasping) continue;
        const w = wrestlerOf(side);
        w.breathIn -= dt;
        if (w.breathIn <= 0) { spawnBreath(w); w.breathIn = 0.35; }
      }
      if (Math.abs(r.pullVelocity) > 9) {
        const loser = r.pullVelocity > 0 ? player : rival;
        loser.dustIn -= dt;
        if (loser.dustIn <= 0) { spawnDust(loser.pose.hip.x, ARENA.groundY - 4, 2, 30); loser.dustIn = 0.12; }
      }
    }

    // crowd excitement
    let target = 0.22;
    if (st === S.PLAYING) target = 0.3 + (Math.abs(pull) / 100) * 0.35 + (strike ? 0.1 : 0);
    else if (st === S.COUNTDOWN) target = 0.3;
    else if (st === S.ROUND_END) target = 0.55;
    else if (st === S.MATCH_END) target = game.leftWins > game.rightWins || game.mode === '2p' ? 0.8 : 0.5;
    game.crowdBoost = Math.max(0, game.crowdBoost - dt);
    if (game.crowdBoost > 0) target = Math.max(target, 0.95);
    game.crowd = damp(game.crowd, target, 3, dt);

    game.shake *= Math.exp(-7 * dt);
    if (game.shake < 0.05) game.shake = 0;
    game.flash = Math.max(0, game.flash - dt * 1.6);
  }

  let lastAlert = null;
  function updateHUD() {
    const r = game.sim;
    if (!r) return;
    const p = r.pullPosition;
    ui.tugMarker.style.left = (50 + p / 2) + '%';
    if (p < 0) { ui.tugFill.style.left = (50 + p / 2) + '%'; ui.tugFill.style.width = (-p / 2) + '%'; }
    else { ui.tugFill.style.left = '50%'; ui.tugFill.style.width = (p / 2) + '%'; }
    ui.tug.classList.toggle('lead-player', p < -2);
    ui.tug.classList.toggle('lead-ai', p > 2);

    const now = performance.now() / 1000;
    for (const side of SIDES) {
      const puller = side === 'left' ? r.left : r.right;
      if (!puller) continue;
      const m = ui.meters[side], tp = game.taps[side];
      m.power.style.width = (puller.force / r.maxForce) * 100 + '%';
      const level = puller.stamina / B.stamina.max;
      m.stamina.style.width = level * 100 + '%';
      const band = puller.tired || level <= 0.25 ? 'low' : level <= 0.55 ? 'mid' : 'high';
      if (m.stamina.dataset.level !== band) m.stamina.dataset.level = band;
      m.el.classList.toggle('tired', puller.tired);
      while (tp.times.length && now - tp.times[0] > 1.5) tp.times.shift();
      const raw = game.state === S.PLAYING ? tp.times.length / 1.5 : 0;
      tp.rate = lerp(tp.rate, raw, 0.15);
      m.rate.textContent = tp.rate.toFixed(1);
    }
    if (r.ai) ui.meters.left.tick.style.left = clamp((r.aiForce / r.maxForce) * 100, 0, 100) + '%';
    if (isFinite(r.roundTime)) {
      const left = Math.max(0, Math.ceil(r.roundTime - r.time));
      if (ui.roundTimer.textContent !== String(left)) ui.roundTimer.textContent = left;
      ui.roundTimer.classList.toggle('urgent', game.state === S.PLAYING && left <= 5);
    }

    // AI warnings (1 player only)
    let text = '', cls = '';
    if (game.state === S.PLAYING && r.ai) {
      const ai = r.ai;
      if (ai.state === AIState.ATTACK) { text = ai.phase === 'windup' ? t('attackIncoming') : t('attackNow'); cls = 'danger'; }
      else if (ai.state === AIState.DESPERATION) { text = ai.phase === 'windup' ? t('lastStand') : t('desperation'); cls = 'desperate'; }
      else if (ai.state === AIState.RECOVERY) { text = t('tired'); cls = 'chance'; }
    }
    const key = text + cls;
    if (key !== lastAlert) {
      lastAlert = key;
      if (text) ui.alert.textContent = text;
      ui.alert.className = text ? 'show ' + cls : '';
    }
  }

  function update(dt) {
    game.time += dt;
    game.stateTime += dt;
    const paused = portraitPaused();
    switch (game.state) {
      case S.COUNTDOWN:
        if (!paused) updateCountdown(dt);
        break;
      case S.PLAYING: {
        if (paused) break;
        const r = game.sim;
        stepRound(r, dt);
        for (const ev of r.events) handleSimEvent(ev);
        if (r.winner) endRound(r.winner);
        break;
      }
      case S.ROUND_END:
        updateRoundEnd(dt);
        break;
      case S.MATCH_END:
        updateMatchEnd(dt);
        break;
    }
    updateActors(dt);
    updateParticles(dt);
    updateHUD();
  }

  /* ======================================================================
     RENDER
     ====================================================================== */
  function render(dt) {
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.fillStyle = '#79c2f3';
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    const sh = game.shake;
    if (sh > 0) {
      const t = game.time;
      ctx.translate(W / 2 + Math.sin(t * 91) * sh, H / 2 + Math.cos(t * 77) * sh * 0.7);
      const z = 1 + sh * 0.004;
      ctx.scale(z, z);
      ctx.translate(-W / 2, -H / 2);
    }

    ctx.drawImage(layers.sky, 0, 0, W, H);
    drawSkyLife(dt);
    ctx.drawImage(layers.land, 0, 0, W, H);
    drawBanners();
    drawCrowd();
    ctx.drawImage(layers.front, 0, 0, W, H);

    ctx.save();
    ctx.translate(ARENA.boardX, ARENA.groundY);
    ctx.scale(ARENA.scale, ARENA.scale);
    ctx.translate(-ARENA.boardX, -ARENA.groundY);
    drawShadows();
    drawAuras();
    drawWrestlerBack(player);
    drawWrestlerBack(rival);
    drawWrestlerBody(player);
    drawWrestlerBody(rival);
    drawStick();
    drawWrestlerFront(player);
    drawWrestlerFront(rival);
    drawMotionLines();
    drawParticles();
    drawIndicators();
    drawPopups();
    ctx.restore();

    ctx.restore();

    drawConfetti();
    if (game.flash > 0) {
      const g = ctx.createRadialGradient(W / 2, H / 2, 200, W / 2, H / 2, 760);
      g.addColorStop(0, 'rgba(255,90,20,0)');
      g.addColorStop(1, `rgba(255,90,20,${game.flash * 0.55})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
  }

  /* ======================================================================
     INPUT & UI WIRING
     Keyboard: SPACE pulls in 1-player mode; A (player 1) and L (player 2)
     in 2-player mode. Touch: a tap on the game area pulls; in 2-player mode
     the left half is player 1 and the right half player 2 (multi-touch).
     ====================================================================== */
  const heldKeys = new Set();         // a held key never generates more pulls
  const activePointers = new Map();   // pointerId → side, so each finger counts once
  const PULL_KEYS = { Space: ['1p', 'left'], KeyA: ['2p', 'left'], KeyL: ['2p', 'right'] };

  function toggleMute() {
    Sound.setMuted(!Sound.muted);
    ui.muteBtn.classList.toggle('muted', Sound.muted);
  }

  function onEnter() {
    switch (game.state) {
      case S.MENU: Sound.click(); startMatch(); break;
      case S.HOW_TO_PLAY:
      case S.FAQ: Sound.click(); setState(S.MENU); break;
      case S.ROUND_END: nextRound(); break;
      case S.MATCH_END: Sound.click(); startMatch(); break;
    }
  }

  window.addEventListener('keydown', (e) => {
    setInputMode('keyboard');
    const code = e.code || (e.key === ' ' ? 'Space' : e.key);
    const pull = PULL_KEYS[code];
    if (pull) {
      if (code === 'Space') e.preventDefault(); // no page scroll, no button activation
      Sound.init();
      if (e.repeat || heldKeys.has(code)) return; // holding a key never generates more pulls
      heldKeys.add(code);
      if (pull[0] === game.mode) onPull(pull[1]);
      return;
    }
    if (e.repeat) return;
    if (code === 'Enter' || code === 'NumpadEnter') { e.preventDefault(); Sound.init(); onEnter(); }
    else if (code === 'KeyM') { Sound.init(); toggleMute(); }
    else if (code === 'Escape') {
      if (ui.lang.classList.contains('open')) { setLangMenu(false); return; }
      if (game.state === S.HOW_TO_PLAY || game.state === S.FAQ || game.state === S.MATCH_END) goMenu();
    }
  }, { capture: true });

  window.addEventListener('keyup', (e) => {
    const code = e.code || (e.key === ' ' ? 'Space' : e.key);
    if (code === 'Space') e.preventDefault();
    heldKeys.delete(code);
  }, { capture: true });
  window.addEventListener('blur', () => { heldKeys.clear(); activePointers.clear(); });

  // Taps anywhere outside buttons pull, including the letterbox bars beside the stage.
  window.addEventListener('pointerdown', (e) => {
    Sound.init();
    if (e.pointerType === 'touch' || e.pointerType === 'pen') setInputMode('touch');
    if (game.state !== S.PLAYING) return;
    if (e.target.closest('button, .rotate') || activePointers.has(e.pointerId)) return;
    const side = game.mode === '2p' && e.clientX >= window.innerWidth / 2 ? 'right' : 'left';
    activePointers.set(e.pointerId, side);
    onPull(side);
  }, { capture: true });
  const releasePointer = (e) => activePointers.delete(e.pointerId);
  window.addEventListener('pointerup', releasePointer, { capture: true });
  window.addEventListener('pointercancel', releasePointer, { capture: true });

  // Fast tapping must never zoom or scroll the page (scrolling inside help panels still works).
  document.addEventListener('touchstart', (e) => {
    if (e.touches.length > 1 || !e.target.closest('button, .scroll-y')) e.preventDefault();
  }, { passive: false });
  document.addEventListener('touchmove', (e) => {
    if (e.touches.length > 1 || !e.target.closest('.scroll-y')) e.preventDefault();
  }, { passive: false });
  document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
  document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });

  ui.playBtn.addEventListener('click', () => { Sound.init(); Sound.click(); startMatch(); });
  ui.modeBtns.forEach((btn) => btn.addEventListener('click', () => {
    Sound.init();
    Sound.click();
    setMode(btn.dataset.mode);
    btn.blur();
  }));

  // How to play: the tab that opens first follows the detected input type.
  function selectTab(name) {
    ui.tabs.forEach((tab) => {
      const on = tab.dataset.tab === name;
      tab.classList.toggle('selected', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    ui.tabPanels.forEach((panel) => { panel.hidden = panel.dataset.panel !== name; });
  }
  ui.howBtn.addEventListener('click', () => {
    Sound.init();
    Sound.click();
    selectTab(game.input === 'touch' ? 'phone' : 'pc');
    ui.howScroll.scrollTop = 0;
    setState(S.HOW_TO_PLAY);
  });
  ui.tabs.forEach((tab) => tab.addEventListener('click', () => { Sound.click(); selectTab(tab.dataset.tab); tab.blur(); }));
  ui.backBtn.addEventListener('click', () => { Sound.click(); setState(S.MENU); });

  // FAQ: an accordion, one answer open at a time
  function openFaq(item) {
    ui.faqItems.forEach((it) => {
      const open = it === item && !it.classList.contains('open');
      it.classList.toggle('open', open);
      it.querySelector('.faq-q').setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }
  ui.faqBtn.addEventListener('click', () => {
    Sound.init();
    Sound.click();
    openFaq(null);
    ui.faqList.scrollTop = 0;
    setState(S.FAQ);
  });
  ui.faqBackBtn.addEventListener('click', () => { Sound.click(); setState(S.MENU); });
  ui.faqItems.forEach((it) => it.querySelector('.faq-q').addEventListener('click', (e) => {
    Sound.click();
    openFaq(it);
    e.currentTarget.blur();
  }));

  ui.nextBtn.addEventListener('click', () => { Sound.click(); nextRound(); });
  ui.rematchBtn.addEventListener('click', () => { Sound.click(); startMatch(); });
  ui.menuBtn.addEventListener('click', () => { Sound.click(); goMenu(); });
  ui.muteBtn.addEventListener('click', () => { Sound.init(); toggleMute(); ui.muteBtn.blur(); });
  ui.muteBtn.classList.toggle('muted', Sound.muted);

  function setLangMenu(open) {
    ui.lang.classList.toggle('open', open);
    ui.langBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  ui.langBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    Sound.init();
    Sound.click();
    setLangMenu(!ui.lang.classList.contains('open'));
    ui.langBtn.blur();
  });
  ui.langItems.forEach((btn) => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    Sound.click();
    applyLang(btn.dataset.lang);
    setLangMenu(false);
    btn.blur();
  }));
  document.addEventListener('click', () => setLangMenu(false));

  ui.diffBtns.forEach((btn) => btn.addEventListener('click', () => {
    game.difficulty = btn.dataset.diff;
    ui.diffBtns.forEach((b) => b.classList.toggle('selected', b === btn));
    refreshDynamicText();
    Sound.init();
    Sound.click();
    btn.blur();
  }));

  /* ======================================================================
     BOOT
     ====================================================================== */
  // Initial hint mode from the primary pointer; real input switches it later.
  const coarsePointer = !!window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  game.input = coarsePointer ? 'touch' : 'keyboard';
  document.body.classList.toggle('input-touch', coarsePointer);
  document.body.classList.toggle('input-keyboard', !coarsePointer);

  applyLang(initialLang());
  // Cyrillic/Chinese fallback fonts load lazily, so re-fit once they arrive.
  if (document.fonts) document.fonts.addEventListener('loadingdone', refit);

  function resize() {
    const k = Math.min(window.innerWidth / W, window.innerHeight / H);
    stage.style.transform = `translate(-50%, -50%) scale(${k})`;
    // Phones: the stage is drawn small, so the interface switches to larger text and touch targets.
    const compact = k < 0.75;
    if (document.body.classList.contains('compact') !== compact) {
      document.body.classList.toggle('compact', compact);
      refit();
    }
    const pr = clamp(k * (window.devicePixelRatio || 1), 1, 2.5);
    if (!layers.sky || Math.abs(pr - pixelRatio) > 0.01) {
      pixelRatio = pr;
      canvas.width = Math.round(W * pr);
      canvas.height = Math.round(H * pr);
      buildLayers();
    }
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 200));
  resize();

  player.pose = computePose(player);
  rival.pose = computePose(rival);
  setState(S.MENU);

  let last = performance.now();
  function frame(now) {
    let dt = (now - last) / 1000;
    last = now;
    dt = clamp(dt, 0, 0.05);
    update(dt);
    render(dt);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Debug / test hook
  window.TAYAK = { game, BALANCE, GameState, startMatch, goMenu, setMode, setInputMode, pull: onPull };
}
