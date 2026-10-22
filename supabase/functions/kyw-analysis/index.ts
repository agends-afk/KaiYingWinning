// Model regression analysis, run next to the data. Builds race rows with the app's own scoring into kyw_model_rows, then fits and scores on request.
//   ?build=au&offset=N&limit=K   archived Australian meetings (kyw_backtest)
//   ?build=hk&from=YYYY-MM-DD&to=YYYY-MM-DD   backfilled Hong Kong races (kyw_hk_race + kyw_hk_horse), form rebuilt as it stood before each race
//   ?build=vic&from=..&to=..     Victorian run history (kyw_runs), for the wet-track question
//   POST ?fit=1 { set, filter, extra, inter, lambda, prior, nonneg, split }   returns coefficients and out-of-sample metrics
// Read-only towards everything except kyw_model_rows. Not called by the app.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { KEYS, raceRow, fitLogit, metrics, design, bootstrap, probs, appCoefficients, toWeights, hkRunner, hkExtras, hkClassNum, hkGoing } from "./lib.js";
import { num, clamp } from "./model.js";

const FLOCK = Deno.env.get("KYW_FLOCK_CODE") ?? "pelicans-2026";
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const j = (o: any, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
async function all(q: () => any, page = 1000) { const out: any[] = []; for (let i = 0; ; i += page) { const { data, error } = await q().range(i, i + page - 1); if (error) throw error; out.push(...(data ?? [])); if (!data || data.length < page) break; } return out; }
async function save(set: string, rows: any[]) {
  const recs = rows.filter(Boolean).map((r: any) => ({ key: `${set}:${r.key}`, set, meet: r.meet, date: r.date || null, state: r.state, tier: r.tier, wet: !!r.wet, data: r }));
  for (let i = 0; i < recs.length; i += 200) { const { error } = await sb.from("kyw_model_rows").upsert(recs.slice(i, i + 200)); if (error) throw error; }
  return recs.length;
}

async function buildAU(offset: number, limit: number) {
  const { data, error } = await sb.from("kyw_backtest").select("meet_id,data").order("meet_id").range(offset, offset + limit - 1); if (error) throw error;
  const rows: any[] = []; for (const b of data ?? []) { const m = b.data; if (!m?.races) continue; if (m.state === "HK") continue; for (const r of m.races) rows.push(raceRow(r, { ...m, id: b.meet_id })); }
  return { meetings: data?.length ?? 0, races: await save("au", rows) };
}

// Hong Kong: jockey and trainer win rates over the 365 days before each race, from the backfilled results themselves (no hindsight).
async function buildHK(from: string, to: string) {
  const races = await all(() => sb.from("kyw_hk_race").select("race_key,date,venue,race_no,data").order("date"));
  const ids = new Set<string>(); for (const r of races) if (r.date >= from && r.date <= to) for (const x of r.data.runners) ids.add(x.horseId);
  const horses: Record<string, any> = {}; const idl = [...ids];
  for (let i = 0; i < idl.length; i += 150) { const { data } = await sb.from("kyw_hk_horse").select("horse_id,status,data").in("horse_id", idl.slice(i, i + 150)); for (const h of data ?? []) horses[h.horse_id] = h; }
  const rideLog: { date: string; j: string; t: string; win: boolean }[] = []; for (const r of races) for (const x of r.data.runners) if (x.place != null) rideLog.push({ date: r.date, j: x.jockeyId, t: x.trainerId, win: x.place === 1 });
  const rateBefore = (date: string) => { const lo = new Date(Date.parse(date) - 365 * 86400000).toISOString().slice(0, 10); const jw: any = {}, tw: any = {};
    for (const x of rideLog) { if (x.date >= date || x.date < lo) continue; (jw[x.j] ??= [0, 0]); jw[x.j][0]++; if (x.win) jw[x.j][1]++; (tw[x.t] ??= [0, 0]); tw[x.t][0]++; if (x.win) tw[x.t][1]++; }
    const pct = (o: any, k: string) => (o[k] && o[k][0] >= 40 ? (100 * o[k][1]) / o[k][0] : null); return { jw, tw, pct }; };
  const out: any[] = []; let cache: any = null, cacheDate = "";
  for (const r of races) { if (r.date < from || r.date > to) continue; const d = r.data; if (!d.runners?.length) continue;
    if (cacheDate !== r.date) { cache = rateBefore(r.date); cacheDate = r.date; }
    const cls = hkClassNum(d.cls); const going = hkGoing(/Going\s*:\s*([A-Z ]+?)(?=\s+[A-Z]{2,}\s|\s+Course)/.exec(d.header ?? "")?.[1] ?? d.going);
    const finishers = d.runners.filter((x: any) => x.place != null); const winner = finishers.find((x: any) => x.place === 1); if (!winner || finishers.length < 3) continue;
    const runners = finishers.map((x: any) => { const h = horses[x.horseId]; const rn: any = hkRunner(x, h?.status === "ok" ? h.data?.runs : [], r.date, r.venue, d.distance, { j: cache.pct(cache.jw, x.jockeyId), t: cache.pct(cache.tw, x.trainerId) });
      if (rn.last && rn._lastCls != null && cls != null) { const rk = (c: number) => ({ 0: 85, 1: 75, 2: 66, 3: 58, 4: 50, 5: 42, 6: 40 } as any)[c]; const diff = rk(cls) - rk(rn._lastCls); rn.last.classChange = Math.abs(diff) >= 5 ? (diff > 0 ? 1 : -1) : 0; }
      return rn; });
    const extra: any = {}; for (const rn of runners) extra[rn.no] = hkExtras(rn, cls, d.band);
    const race = { no: r.race_no, distance: d.distance, class: d.cls, condition: going >= 7 ? "Soft " + going : "Good 4", runners, result: { positions: finishers.sort((a: any, b: any) => a.place - b.place).map((x: any) => x.no) } };
    const row = raceRow(race, { id: `${r.date}-${r.venue}`, meeting: r.venue === "ST" ? "sha-tin" : "happy-valley", state: "HK", date: r.date, condition: race.condition }, extra);
    if (row) { row.key = r.race_key; row.hkClass = cls; out.push(row); } }
  return { races: await save("hk", out), horsesMissing: idl.filter(id => horses[id]?.status !== "ok").length };
}

// Victoria: each horse's record before each race, from the run history itself. Features are z-scored within the race, as the app does.
async function buildVIC(from: string, to: string) {
  const runs = await all(() => sb.from("kyw_runs").select("race_id,date,venue,condition,rating,horse_code,finish,margin,sp,field_count,scratched,barrier,weight").order("date"));
  const byHorse = new Map<string, any[]>(); for (const r of runs) { if (r.scratched || !r.horse_code || !(num(r.finish) > 0 && num(r.finish) < 50)) continue; if (!byHorse.has(r.horse_code)) byHorse.set(r.horse_code, []); byHorse.get(r.horse_code)!.push(r); }
  const wetOf = (r: any) => { const g = num(r.rating); return g != null && g >= 7 && !/synth/i.test(String(r.condition ?? "") + r.venue); };
  const recScore = (s: number, w: number, p: number) => { if (!s) return null; const wr = (w + 0.12 * 4) / (s + 4), pr = (w + p + 0.38 * 4) / (s + 4); return 0.5 * clamp(wr / 0.3, 0, 1) + 0.5 * clamp(pr / 0.6, 0, 1); };
  const formOf = (xs: any[]) => { const last = xs.slice(0, 5).reverse(); if (!last.length) return null; const ws = [.1, .15, .2, .25, .3].slice(-last.length); let t = 0, sw = 0; last.forEach((q: any, i: number) => { const f = num(q.finish), n = num(q.field_count) || 12; t += clamp(1 - (f - 1) / Math.max(n - 1, 1), 0, 1) * ws[i]; sw += ws[i]; }); return t / sw; };
  const z = (v: (number | null)[]) => { const xs = v.filter(x => x != null) as number[]; if (xs.length < 2) return v.map(() => 0); const m = xs.reduce((a, b) => a + b, 0) / xs.length; const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length) || 1; return v.map(x => (x == null ? 0 : clamp((x - m) / sd, -2.5, 2.5))); };
  const races = new Map<string, any[]>(); for (const r of runs) { if (r.date < from || r.date > to || r.scratched) continue; if (!races.has(r.race_id)) races.set(r.race_id, []); races.get(r.race_id)!.push(r); }
  const out: any[] = [];
  for (const [rid, field] of races) { const fin = field.filter(r => num(r.finish) > 0 && num(r.finish) < 50); const win = fin.find(r => num(r.finish) === 1); if (!win || fin.length < 4) continue;
    const feats = fin.map(r => { const prior = (byHorse.get(r.horse_code) ?? []).filter(q => q.date < r.date).sort((a, b) => (a.date < b.date ? 1 : -1));
      const rc = (xs: any[]) => recScore(xs.length, xs.filter(q => num(q.finish) === 1).length, xs.filter(q => [2, 3].includes(num(q.finish))).length);
      const wet = prior.filter(wetOf), dry = prior.filter(q => !wetOf(q)); const l = prior[0];
      return { no: num(r.barrier) ?? 0, horse: r.horse_code, sp: num(r.sp), win: r === win, career: rc(prior), wetRec: rc(wet), dryRec: rc(dry), form: formOf(prior), dryForm: formOf(dry), wetForm: formOf(wet),
        last: l ? clamp(0.5 * clamp(1 - (num(l.finish) - 1) / Math.max((num(l.field_count) || 12) - 1, 1), 0, 1) + 0.5 * clamp(1 - (num(l.margin) || 0) / 10, 0, 1), 0, 1) : null, nWet: wet.length, nPrior: prior.length }; });
    const keys = ["career", "wetRec", "dryRec", "form", "dryForm", "wetForm", "last"]; const zs: any = {}; for (const k of keys) zs[k] = z(feats.map((f: any) => f[k]));
    const g = num(field[0].rating); out.push({ key: rid, meet: `${field[0].date}-${field[0].venue}`, date: field[0].date, state: "VIC", venue: field[0].venue, tier: "vic", going: g, wet: wetOf(field[0]), n: fin.length,
      win: fin.indexOf(win), vkeys: keys, runners: feats.map((f: any, i: number) => ({ no: i, sp: f.sp, x: keys.map(k => +zs[k][i].toFixed(4)), e: { nWet: f.nWet, nPrior: f.nPrior } })) });
    out[out.length - 1].win = out[out.length - 1].runners[fin.indexOf(win)].no; }
  return { races: await save("vic", out) };
}

// Fit: set, filter {tier, state, wet, notState, hkClassMin}, split {before} (train before the date, test on and after) or {folds, fold}.
async function fit(body: any) {
  const set = body.set ?? "au"; let q = () => { let x: any = sb.from("kyw_model_rows").select("data").eq("set", set); const f = body.filter ?? {};
    if (f.tier) x = x.in("tier", [].concat(f.tier)); if (f.state) x = x.in("state", [].concat(f.state)); if (f.wet != null) x = x.eq("wet", f.wet); return x; };
  const stored = (await all(q, 500)).map((r: any) => r.data);
  const rows = design(stored, body.extra ?? [], body.inter ?? []); const p = rows[0]?.X[0]?.length ?? KEYS.length;
  const pick = (b: any) => (Array.isArray(b) ? b : b === "zero" ? new Array(p).fill(0) : [...appCoefficients(), ...new Array(Math.max(0, p - KEYS.length)).fill(0)].slice(0, p));
  const prior = pick(body.prior ?? "app"); const start = body.start ? pick(body.start) : prior;
  const nonneg = body.nonneg === false ? [] : (body.nonneg ?? KEYS.map((_, i) => i)).filter((i: number) => i < p);
  let train = rows, test: any[] = [];
  if (body.split?.before) { train = rows.filter(r => r.date < body.split.before); test = rows.filter(r => r.date >= body.split.before); }
  else if (body.split?.folds) { const meets = [...new Set(rows.map(r => r.meet))].sort(); const fm = new Set(meets.filter((_, i) => i % body.split.folds === body.split.fold)); train = rows.filter(r => !fm.has(r.meet)); test = rows.filter(r => fm.has(r.meet)); }
  const beta = body.fixed ? pick(body.fixed) : fitLogit(train, prior, body.lambda ?? 0, nonneg);
  const appB = set === "vic" ? new Array(p).fill(0) : pick("app"); // Victoria has no app equivalent; its baseline is picking blind
  const evalOn = (rs: any[]) => { if (!rs.length) return null; const mF = metrics(rs, beta), mA = metrics(rs, appB);
    const diff = (r: any) => { const pf = probs(r.X, beta)[r.win], pa = probs(r.X, appB)[r.win]; return Math.log(Math.max(pf, 1e-9)) - Math.log(Math.max(pa, 1e-9)); };
    return { fitted: mF, current: mA, gainPerRace: rs.reduce((a, r) => a + diff(r), 0) / rs.length, gainCI: body.boot === false ? null : bootstrap(rs, diff, 300) }; };
  return { set, filter: body.filter ?? {}, nTrain: train.length, nTest: test.length, features: [...KEYS, ...(body.extra ?? []), ...(body.inter ?? []).map((x: any) => x.join("*"))].slice(0, p),
    beta: beta.map(v => +v.toFixed(4)), asWeights: toWeights(beta), train: body.evalTrain === false ? null : evalOn(train), test: evalOn(test) };
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if ((req.headers.get("x-flock-code") ?? url.searchParams.get("code")) !== FLOCK) return new Response("not the flock", { status: 401 });
  try {
    const b = url.searchParams.get("build");
    if (b === "au") return j(await buildAU(+(url.searchParams.get("offset") ?? 0), +(url.searchParams.get("limit") ?? 20)));
    if (b === "hk") return j(await buildHK(url.searchParams.get("from") ?? "2025-09-01", url.searchParams.get("to") ?? "2099-01-01"));
    if (b === "vic") return j(await buildVIC(url.searchParams.get("from") ?? "2025-09-01", url.searchParams.get("to") ?? "2099-01-01"));
    if (url.searchParams.get("fit")) return j(await fit(await req.json()));
    return j({ error: "nothing asked" }, 400);
  } catch (e) { return j({ error: String((e as any)?.message ?? e).slice(0, 400) }, 500); }
});
