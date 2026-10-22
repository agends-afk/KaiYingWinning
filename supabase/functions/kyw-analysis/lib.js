// Regression analysis of the model: race rows built with the app's own scoring, a conditional logit fitter, and the metrics the report uses.
// Plain JS so it runs in Deno (the kyw-analysis function, next to the data) and Node (tests in this folder).
import { METRICS, DEFAULT_SETTINGS, scoreRace, num, clamp } from "./model.js";

// Form factors the regression fits. The market is left out: the archive is priced at SP, which would leak the result's own market into the fit.
export const KEYS = ["last", "form", "classform", "career", "track", "trackdist", "condition", "jockey", "trainer", "barrier", "barrierrec", "weight"];
export const BASE = Object.fromEntries(METRICS.map(m => [m.key, m.base]));

/* ---- segments ---- */
const METRO = /flemington|caulfield|the-valley|moonee-valley|sandown|randwick|rosehill|warwick-farm|canterbury|kensington|eagle-farm|doomben|morphettville|ascot|belmont/;
const PROVINCIAL = {
  VIC: /geelong|ballarat|bendigo|mornington|cranbourne|pakenham|sale|kilmore|seymour|warrnambool|kyneton|yarra-valley|moe|werribee/,
  NSW: /newcastle|gosford|hawkesbury|kembla|illawarra|wyong/,
  QLD: /gold-coast|sunshine-coast|ipswich|toowoomba/,
  WA: /bunbury|northam|pinjarra|york/,
  SA: /murray-bridge|gawler|balaklava|strathalbyn/,
  ACT: /canberra/,
};
const STATE_OF = [[/flemington|caulfield|the-valley|moonee|sandown/, "VIC"], [/randwick|rosehill|warwick-farm|canterbury|kensington/, "NSW"], [/eagle-farm|doomben/, "QLD"], [/morphettville/, "SA"], [/ascot|belmont/, "WA"], [/sha-tin|happy-valley/, "HK"]];
export function stateOf(state, venue) { if (state) return state; const hit = STATE_OF.find(([re]) => re.test(venue)); return hit ? hit[1] : "?"; }
export function tierOf(state, venue) { if (state === "HK") return "hk"; if (METRO.test(venue)) return "metro"; const p = PROVINCIAL[state]; return p && p.test(venue) ? "provincial" : "country"; }
// "Soft 7" -> 7; "Heavy 8" -> 8; a bare "Soft" -> 6, "Heavy" -> 9; synthetic -> null (never treated as wet)
export function goingRating(cond) { const s = String(cond ?? "").toLowerCase(); if (/synth|poly/.test(s)) return null; const m = /(\d+)/.exec(s); if (m) return +m[1]; if (s.startsWith("h")) return 9; if (s.startsWith("so")) return 6; if (s.startsWith("g")) return 4; return null; }

/* ---- rows: one per resulted race, each runner's form-factor z-scores as the app computes them ---- */
export function raceRow(race, meeting, extra = {}) {
  const res = race.result && race.result.positions; if (!res || !res.length) return null;
  const scored = scoreRace({ ...race, meetingId: meeting.id }, meeting, BASE, DEFAULT_SETTINGS, { formline: {}, barrierBias: 0 }, {});
  if (scored.length < 3) return null;
  const winner = res[0]; if (!scored.some(s => s.r.no === winner)) return null;
  const venue = String(meeting.meeting ?? "").toLowerCase(); const state = stateOf(meeting.state, venue); const going = goingRating(race.condition || meeting.condition);
  return { key: `${meeting.id}:${race.no}`, meet: String(meeting.id), date: String(meeting.date ?? "").slice(0, 10), state, venue, tier: tierOf(state, venue), going, wet: going != null && going >= 7,
    dist: num(race.distance), cls: race.class ?? null, n: scored.length, win: winner,
    runners: scored.map(s => ({ no: s.r.no, sp: num(s.r.odds), x: KEYS.map(k => +(s.z[k] || 0).toFixed(4)), ...(extra[s.r.no] ? { e: extra[s.r.no] } : {}) })) };
}

/* ---- conditional logit (one winner per race), Newton steps with a ridge penalty toward a prior vector ---- */
function solve(A, b) { const n = b.length; const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) { let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12; for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / d; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; } }
  return M.map((r, i) => r[n] / (r[i] || 1e-12)); }
// rows: [{ X: number[][] (runners x features), win: index }]; prior and lambda: penalty lambda * |beta - prior|^2; nonneg: indices held at >= 0
export function fitLogit(rows, prior, lambda = 0, nonneg = [], iters = 30) {
  const p = prior.length; let beta = [...prior]; const fixed = new Set();
  for (let pass = 0; pass < 4; pass++) {
    for (let it = 0; it < iters; it++) {
      const g = new Array(p).fill(0), H = Array.from({ length: p }, () => new Array(p).fill(0));
      for (const { X, win } of rows) { const u = X.map(x => x.reduce((a, v, k) => a + v * beta[k], 0)); const mx = Math.max(...u); const e = u.map(v => Math.exp(v - mx)); const S = e.reduce((a, b) => a + b, 0);
        const pr = e.map(v => v / S); const mean = new Array(p).fill(0); X.forEach((x, i) => x.forEach((v, k) => { mean[k] += pr[i] * v; }));
        for (let k = 0; k < p; k++) g[k] += X[win][k] - mean[k];
        X.forEach((x, i) => { for (let a = 0; a < p; a++) { const da = x[a] - mean[a]; if (!da) continue; for (let b = 0; b < p; b++) H[a][b] -= pr[i] * da * (x[b] - mean[b]); } }); }
      for (let k = 0; k < p; k++) { g[k] -= 2 * lambda * (beta[k] - prior[k]); H[k][k] -= 2 * lambda; }
      for (const k of fixed) { g[k] = 0; for (let j = 0; j < p; j++) { H[k][j] = 0; H[j][k] = 0; } H[k][k] = -1; }
      const step = solve(H.map(r => r.map(v => -v)), g); let mv = 0; for (let k = 0; k < p; k++) { beta[k] += step[k]; mv = Math.max(mv, Math.abs(step[k])); }
      if (mv < 1e-7) break; }
    const neg = nonneg.filter(k => beta[k] < 0 && !fixed.has(k)); if (!neg.length) break; for (const k of neg) { beta[k] = 0; fixed.add(k); } }
  return beta;
}
export function probs(X, beta) { const u = X.map(x => x.reduce((a, v, k) => a + v * beta[k], 0)); const mx = Math.max(...u); const e = u.map(v => Math.exp(v - mx)); const S = e.reduce((a, b) => a + b, 0); return e.map(v => v / S); }
export function marketProbs(sps) { const imp = sps.map(o => (o > 1 ? 1 / o : null)); const s = imp.reduce((a, b) => a + (b || 0), 0); return imp.map(v => (v && s ? v / s : null)); }

/* ---- metrics over races: log-loss, skill over picking blind, top-pick strike rate, and the SP market for comparison ---- */
export function metrics(rows, beta) {
  let ll = 0, gain = 0, top = 0, n = 0, mll = 0, mn = 0, both = 0, bothModel = 0; const cal = Array.from({ length: 8 }, () => ({ p: 0, w: 0, k: 0 }));
  for (const r of rows) { const pr = probs(r.X, beta); const pw = Math.max(pr[r.win], 1e-9); ll += -Math.log(pw); gain += Math.log(pw * r.X.length); n++;
    const best = pr.indexOf(Math.max(...pr)); if (best === r.win) top++;
    pr.forEach((q, i) => { const b = Math.min(7, Math.floor(q / 0.05)); cal[b].p += q; cal[b].w += i === r.win ? 1 : 0; cal[b].k++; });
    const mp = r.mkt; if (mp && mp[r.win] && mp.filter(v => v != null).length >= Math.max(3, r.X.length * 0.7)) { mll += -Math.log(mp[r.win]); mn++; both += -Math.log(mp[r.win]); bothModel += -Math.log(pw); } }
  return { races: n, logloss: n ? ll / n : null, skill: n ? gain / n : null, topPick: n ? top / n : null,
    vsMarket: mn ? { races: mn, model: bothModel / mn, market: mll / mn, gap: (bothModel - both) / mn } : null,
    calibration: cal.filter(c => c.k).map((c, i) => ({ band: `${i * 5}-${i * 5 + 5}%`, predicted: +(c.p / c.k).toFixed(3), actual: +(c.w / c.k).toFixed(3), runners: c.k })) };
}
// Bootstrap by meeting: the spread of a per-race statistic difference, resampling whole meetings.
export function bootstrap(rows, f, reps = 400, seed = 7) {
  const byMeet = new Map(); for (const r of rows) { if (!byMeet.has(r.meet)) byMeet.set(r.meet, []); byMeet.get(r.meet).push(r); }
  const meets = [...byMeet.values()]; let s = seed; const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const out = []; for (let b = 0; b < reps; b++) { let tot = 0, k = 0; for (let i = 0; i < meets.length; i++) { const m = meets[Math.floor(rnd() * meets.length)]; for (const r of m) { tot += f(r); k++; } } out.push(tot / k); }
  out.sort((a, b) => a - b); return { lo: out[Math.floor(reps * 0.05)], hi: out[Math.floor(reps * 0.95)] };
}
// Rows from stored race rows: X (with optional extra features appended), winner index, market probabilities.
export function design(stored, extraKeys = [], interactions = []) {
  const out = [];
  for (const r of stored) { const wi = r.runners.findIndex(x => x.no === r.win); if (wi < 0) continue;
    const X = r.runners.map(x => { const base = [...x.x]; for (const k of extraKeys) base.push(x.e && x.e[k] != null ? x.e[k] : 0);
      for (const [a, b] of interactions) { const va = KEYS.includes(a) ? x.x[KEYS.indexOf(a)] : (x.e?.[a] ?? 0); const vb = KEYS.includes(b) ? x.x[KEYS.indexOf(b)] : (x.e?.[b] ?? 0); base.push(va * vb); } return base; });
    out.push({ X, win: wi, meet: r.meet, date: r.date, state: r.state, tier: r.tier, wet: r.wet, going: r.going, mkt: marketProbs(r.runners.map(x => x.sp)) }); }
  return out;
}
// The app's form-only chance is softmax(beta * sum(w z) / sum(w)); its coefficients are therefore beta * w / sum(w).
export function appCoefficients(weights = BASE, beta = DEFAULT_SETTINGS.beta) { const ws = KEYS.reduce((a, k) => a + (weights[k] || 0), 0) || 1; return KEYS.map(k => beta * (weights[k] || 0) / ws); }
// Back from fitted coefficients to slider weights and the beta that reproduce them, keeping the current weight total.
export function toWeights(coef, total = KEYS.reduce((a, k) => a + BASE[k], 0)) { const s = coef.slice(0, KEYS.length).reduce((a, b) => a + Math.max(b, 0), 0) || 1;
  return { beta: +s.toFixed(3), weights: Object.fromEntries(KEYS.map((k, i) => [k, +(total * Math.max(coef[i], 0) / s).toFixed(3)])) }; }

/* ---- Hong Kong: runner objects in the feed's shape, rebuilt from HKJC run lines dated before the race ---- */
export function hkClassNum(c) { const s = String(c ?? "").toUpperCase(); const m = /CLASS\s*(\d)|^(\d)$/.exec(s); if (m) return +(m[1] ?? m[2]); if (/GROUP|^G\d|LR|LISTED/.test(s)) return 0; if (/GRIFFIN/.test(s)) return 6; return null; }
const HK_RANK = { 0: 85, 1: 75, 2: 66, 3: 58, 4: 50, 5: 42, 6: 40 };
const hkRank = (c) => { const n = hkClassNum(c); return n == null ? null : HK_RANK[n]; };
export function hkGoing(g) { const s = String(g ?? "").toUpperCase(); if (/HEAVY/.test(s)) return 9; if (/YIELDING TO SOFT|SOFT/.test(s)) return 7; if (/YIELDING/.test(s)) return 6; if (/GOOD TO YIELDING/.test(s)) return 5; return 4; }
const days = (a, b) => (Date.parse(a) - Date.parse(b)) / 86400000;
// runs: a horse's HKJC run lines (any order); date: the race day. Only runs before the day count.
export function hkRunner(row, runs, date, venue, dist, jt) {
  const prior = (runs ?? []).filter(q => q.date < date && q.pos != null).sort((a, b) => (a.date < b.date ? 1 : -1));
  const today = (runs ?? []).find(q => q.date === date);
  const rec = (xs) => [xs.length, xs.filter(q => q.pos === 1).length, xs.filter(q => q.pos === 2 || q.pos === 3).length];
  const l = prior[0]; let form = ""; let prev = null;
  for (const q of [...prior].reverse().slice(-8)) { if (prev && days(q.date, prev) >= 84) form += "x"; form += q.pos >= 10 ? "0" : String(q.pos); prev = q.date; }
  if (prev && days(date, prev) >= 84) form += "x";
  return { no: row.no, name: row.name, barrier: row.draw, weight: row.weight != null ? +(row.weight / 2.2046).toFixed(1) : null, scratched: false,
    career: prior.length ? rec(prior) : [0, 0, 0], track: rec(prior.filter(q => q.venue === venue)), trackDistance: rec(prior.filter(q => q.venue === venue && q.dist === dist)),
    form: form.slice(-8), last: l ? { pos: l.pos, field: null, margin: l.pos === 1 ? 0 : l.margin, days: Math.round(days(date, l.date)) } : null,
    recent: prior.slice(0, 3).map(q => ({ pos: q.pos, field: null, margin: q.pos === 1 ? 0 : q.margin, cls: hkRank(q.cls), date: q.date })),
    good: rec(prior.filter(q => hkGoing(q.going) <= 5)), soft: rec(prior.filter(q => hkGoing(q.going) >= 6 && hkGoing(q.going) <= 8)), heavy: rec(prior.filter(q => hkGoing(q.going) >= 9)),
    jockeyPct: jt?.j ?? null, trainerPct: jt?.t ?? null, odds: row.winOdds, finish: row.place,
    _rating: today?.rtg ?? null, _lastCls: l ? hkClassNum(l.cls) : null, _lastRating: l?.rtg ?? null, _prior: prior.slice(0, 5).map(q => ({ c: hkClassNum(q.cls), pos: q.pos, m: q.margin })) };
}
// Extra Hong Kong features for the class thesis. Classes run 1 (top) to 5; a horse dropping from Class 3 to Class 4 has classDrop +1.
export function hkExtras(runner, todayCls, band) {
  const drop = runner._lastCls != null && todayCls != null && runner._lastCls >= 1 && todayCls >= 1 ? todayCls - runner._lastCls : 0;
  // Margin-weighted performance in the last three runs, credited by how much stronger each race's class was than today's.
  let cf = 0, w = 0; (runner._prior ?? []).slice(0, 3).forEach((q, i) => { if (q.c == null || todayCls == null) return; const gap = clamp(todayCls - q.c, -2, 3); const perf = clamp(1 - (num(q.m) ?? (q.pos === 1 ? 0 : 6)) / 8, 0, 1); const wt = [0.5, 0.3, 0.2][i]; cf += wt * perf * gap; w += wt; });
  const pos = band && runner._rating != null && band[0] > band[1] ? clamp((runner._rating - band[1]) / (band[0] - band[1]), -0.5, 1.5) : null;
  return { classDrop: clamp(drop, -2, 3), classCredit: w ? +(cf / w).toFixed(4) : 0, bandPos: pos != null ? +pos.toFixed(4) : 0, rating: runner._rating ?? 0 };
}
