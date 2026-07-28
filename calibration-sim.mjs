#!/usr/bin/env node
// Headless sanity check for the openness auto-calibration in holosphere.html
// (mapOpenness + the low/high `cal` tracking). Run with: node calibration-sim.mjs
//
// This is a hand-kept MIRROR of the mapOpenness() logic in holosphere.html —
// it is not imported from the HTML file, so if you change the algorithm
// there, update the constants and the body of mapOpenness() below to match
// before trusting these results.

function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

const CAL_DEF = { lo: 0.40, hi: 0.86 };
const CAL_HI_HEADROOM = 0.05;
const CAL_LO_HEADROOM = 0.01;
const LOW_WINDOW_MS = 6000;
const LOW_HOLD_FRAMES = 6;

// Fake clock: each call to mapOpenness() advances time by FRAME_MS, mirroring
// one MediaPipe onResults() callback.
const FRAME_MS = 33; // ~30fps

function makeCal() {
  const cal = { lo: CAL_DEF.lo, hi: CAL_DEF.hi };
  let loWindow = [];
  let loWindowMinPrev = Infinity;
  let loHoldCount = 0;
  let nowMs = 0;

  function mapOpenness(ext) {
    nowMs += FRAME_MS;
    const now = nowMs;

    if (ext > cal.hi) cal.hi += (ext - cal.hi) * 0.5;
    cal.hi += (CAL_DEF.hi - cal.hi) * 0.0012;

    loWindow.push({ t: now, ext });
    while (loWindow.length > 1 && now - loWindow[0].t > LOW_WINDOW_MS) loWindow.shift();
    let windowMin = ext;
    for (const s of loWindow) if (s.ext < windowMin) windowMin = s.ext;

    const isNewLow = windowMin < loWindowMinPrev - 1e-6;
    const settled = !isNewLow && Math.abs(ext - windowMin) < 0.02;
    loHoldCount = settled ? loHoldCount + 1 : 0;
    loWindowMinPrev = windowMin;
    if (loHoldCount >= LOW_HOLD_FRAMES && windowMin < (cal.lo + cal.hi) / 2) {
      cal.lo += (windowMin - cal.lo) * 0.08;
    }

    const lin = clamp((ext - cal.lo) / (cal.hi - cal.lo), 0, 1);
    let open = 1 - Math.pow(1 - lin, 0.72);
    const guardHiLo = Math.max(cal.hi - CAL_HI_HEADROOM, cal.lo + 0.05);
    const guardHi = smoothstep(guardHiLo, cal.hi, ext);
    open += (1 - open) * guardHi;
    const guardLoHi = Math.min(cal.lo + CAL_LO_HEADROOM, cal.hi - 0.05);
    const guardLo = 1 - smoothstep(cal.lo, guardLoHi, ext);
    open -= open * guardLo;
    return open;
  }

  return { cal, mapOpenness, advanceMs: (ms) => { nowMs += ms; } };
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`); }
}

// ---------------------------------------------------------------------------
console.log('\n[1] Rotation jitter at full expansion should NOT read as shrinking');
{
  const { mapOpenness } = makeCal();
  for (let i = 0; i < 300; i++) mapOpenness(0.90); // settle calibration at a peak of 0.90
  let minOpen = 1;
  for (let i = 0; i < 200; i++) {
    const jittered = 0.90 - (i % 5) * 0.002; // ±1% wobble from rotation noise
    minOpen = Math.min(minOpen, mapOpenness(jittered));
  }
  check('open stays >= 0.98 during peak jitter', minOpen >= 0.98, `minOpen=${minOpen.toFixed(4)}`);
}

// ---------------------------------------------------------------------------
console.log('\n[2] Closing sweep should ease smoothly, no flat-then-snap, and NOT shadow to 0 mid-sweep');
{
  const { mapOpenness } = makeCal();
  for (let i = 0; i < 300; i++) mapOpenness(0.90);
  let prev = null, maxDrop = 0, flatSteps = 0, nearZeroMidSweep = 0;
  const N = Math.round((0.90 - 0.40) / 0.005);
  let i = 0;
  for (let ext = 0.90; ext >= 0.40; ext -= 0.005, i++) {
    const o = mapOpenness(ext);
    if (prev !== null) {
      const d = prev - o;
      maxDrop = Math.max(maxDrop, d);
      if (d < 0.0005) flatSteps++;
    }
    if (i < N - 15 && o < 0.05) nearZeroMidSweep++; // shouldn't be ~0 until near the very end
    prev = o;
  }
  check('no long flat dead-zone before a drop', flatSteps <= 1, `flatSteps=${flatSteps}`);
  check('max single-step drop stays bounded (< 0.05)', maxDrop < 0.05, `maxDrop=${maxDrop.toFixed(4)}`);
  check('does not shadow ext down to ~0% mid-sweep', nearZeroMidSweep === 0, `nearZeroMidSweep=${nearZeroMidSweep}`);
}

// ---------------------------------------------------------------------------
console.log('\n[3] Hand whose tightest fist never reaches CAL_DEF.lo (0.40) must still reach 0%, once HELD');
{
  const { cal, mapOpenness } = makeCal();
  for (let i = 0; i < 300; i++) mapOpenness(0.90);
  for (let i = 0; i < 300; i++) mapOpenness(0.46); // sustained "tight fist" well above default
  const open = mapOpenness(0.46);
  check('cal.lo rose to meet the real minimum', cal.lo > 0.44, `cal.lo=${cal.lo.toFixed(4)}`);
  check('open reaches 0 at the sustained minimum', open < 0.01, `open=${open.toFixed(4)}`);
}

// ---------------------------------------------------------------------------
console.log('\n[4] A single noisy low-outlier frame must heal, not latch forever, and must not be trusted instantly');
{
  const { cal, mapOpenness } = makeCal();
  for (let i = 0; i < 300; i++) mapOpenness(0.90);
  mapOpenness(0.10); // one bad glitch frame, way below anything achievable
  for (let i = 0; i < 5; i++) mapOpenness(0.55); // normal fist resumes immediately after
  check('glitch did not immediately drag cal.lo down', cal.lo > 0.35, `cal.lo=${cal.lo.toFixed(4)} right after glitch`);
  for (let i = 0; i < 400; i++) mapOpenness(0.55); // let the glitch age out of the 6s window (~13s here)
  check('cal.lo recovered near the real sustained minimum, not the glitch',
    cal.lo > 0.45, `cal.lo=${cal.lo.toFixed(4)}`);
}

// ---------------------------------------------------------------------------
console.log('\n[5] Sustained OPEN hand must not drag cal.lo upward (windowMin = ext while just sitting open)');
{
  const { cal, mapOpenness } = makeCal();
  for (let i = 0; i < 600; i++) mapOpenness(0.90); // 20s of just holding the hand open, no fist ever made
  check('cal.lo stayed near the default, unaffected by the open hold', cal.lo < 0.45, `cal.lo=${cal.lo.toFixed(4)}`);
}

// ---------------------------------------------------------------------------
console.log('\n[6] Regression: "reaches 0% once, then can\'t again" (reported bug)');
{
  // Reproduces the reported log: a fast close briefly reads ext=0.3961 (an
  // undershoot from motion), then settles into a sustained ext=0.41-0.42.
  // The old Math.max(CAL_DEF.lo, ...) floor made cal.lo creep back up to
  // 0.40+ after that first low reading, permanently blocking the sustained
  // 0.41-0.42 fist from ever reading 0% again.
  const { cal, mapOpenness } = makeCal();
  for (let i = 0; i < 200; i++) mapOpenness(0.95);
  const firstCloseOpen = mapOpenness(0.3961);
  check('first close reaches ~0%', firstCloseOpen < 0.01, `open=${firstCloseOpen.toFixed(4)}`);
  let laterOpen;
  for (let i = 0; i < 150; i++) laterOpen = mapOpenness(0.415); // sustained slightly-looser fist
  check('cal.lo did NOT get pulled back up above the proven minimum',
    cal.lo <= 0.42, `cal.lo=${cal.lo.toFixed(4)}`);
}

// ---------------------------------------------------------------------------
console.log('\n[7] Residual tremor at a fully-closed fist should stay at 0%, not flicker open');
{
  const { cal, mapOpenness } = makeCal();
  for (let i = 0; i < 300; i++) mapOpenness(0.90);
  for (let i = 0; i < 300; i++) mapOpenness(0.46); // calibrate cal.lo up to ~0.46
  let minOpenDuringTremor = 1;
  for (let i = 0; i < 200; i++) {
    const tremor = cal.lo + (i % 5) * 0.002; // small ±jitter within CAL_LO_HEADROOM (0.01)
    minOpenDuringTremor = Math.min(minOpenDuringTremor, mapOpenness(tremor));
  }
  check('open stays 0 (or near it) through tremor at the floor',
    minOpenDuringTremor < 0.02, `min open during tremor=${minOpenDuringTremor.toFixed(4)}`);
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
