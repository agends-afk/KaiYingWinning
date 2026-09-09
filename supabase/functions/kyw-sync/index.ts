// Kai Ying Winning feed: racing.com -> Supabase tables the app reads.
// Runs on a schedule (pg_cron -> pg_net) and on demand from the app ("Sync now").
// Racing.com is the raw data source only. Ratings are computed in the app from each Pelican's weights.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const GQL = "https://graphql.rmdprod.racing.com/";
const GQL_KEY = "da2-6nsi4ztsynar3l3frgxf77q5fe"; // racing.com's public site key, taken from their config.js
const FLOCK = Deno.env.get("KYW_FLOCK_CODE") ?? "pelicans-2026";
const TOTE_PROVIDERS = new Set(["V", "N", "Q"]);

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function gql(query: string) {
  const res = await fetch(GQL, { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": GQL_KEY, "User-Agent": "Mozilla/5.0" }, body: JSON.stringify({ query }) });
  if (!res.ok) throw new Error(`racing.com ${res.status}`);
  const j = await res.json();
  if (j.errors && !j.data) throw new Error(JSON.stringify(j.errors).slice(0, 300));
  return j.data;
}

const num = (v: unknown): number | null => { if (v === null || v === undefined || v === "") return null; const n = parseFloat(String(v).replace(/[^0-9.\-]/g, "")); return isNaN(n) ? null : n; };
// "6-3-0-1" or "2:1-0-1" -> [starts, wins, seconds+thirds]
function stats(s: unknown): [number, number, number] | null {
  if (!s) return null; const m = String(s).match(/(\d+)[:\-](\d+)-(\d+)-(\d+)/); if (!m) return null;
  return [+m[1], +m[2], +m[3] + +m[4]];
}
function classRank(c: string | null | undefined): number | null {
  if (!c) return null; const s = c.toUpperCase();
  if (/GROUP\s*1|\bG1\b/.test(s)) return 100; if (/GROUP\s*2|\bG2\b/.test(s)) return 90; if (/GROUP\s*3|\bG3\b/.test(s)) return 80; if (/LISTED|\bLR\b/.test(s)) return 70;
  const bm = s.match(/BM\s*(\d+)/); if (bm) return +bm[1]; if (/MDN|MAIDEN/.test(s)) return 40; const cl = s.match(/\bCL(\d)/); if (cl) return 45 + +cl[1] * 3; if (/OPEN|HCP/.test(s)) return 75; return null;
}
function median(xs: number[]) { if (!xs.length) return null; const a = [...xs].sort((x, y) => x - y); const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
function odds(list: any[] | null): number | null {
  if (!list) return null; const fixed = list.filter(o => o.oddsWin && !String(o.providerCode).startsWith("BTOTE") && !TOTE_PROVIDERS.has(o.providerCode)).map(o => num(o.oddsWin)!).filter(v => v && v > 1);
  const any = list.map(o => num(o.oddsWin)!).filter(v => v && v > 1); const m = median(fixed.length ? fixed : any); return m ? +m.toFixed(2) : null;
}
function lastStart(form: any[] | null, meetDate: string, todayClass: string) {
  if (!form) return null;
  const runs = form.filter(f => !f.isTrial && !f.isJumpOut && f.date && f.date < meetDate).sort((a, b) => (a.date < b.date ? 1 : -1));
  const l = runs[0]; if (!l) return null;
  const days = Math.round((Date.parse(meetDate) - Date.parse(l.date)) / 86400000);
  const tr = classRank(todayClass), lr = classRank(l.raceClass); let cc = 0; if (tr != null && lr != null && Math.abs(tr - lr) >= 5) cc = tr > lr ? 1 : -1;
  return { pos: l.position ?? null, field: l.starters ?? null, margin: l.position === 1 ? 0 : num(l.margin), days, race: String(l.raceCode ?? ""), classChange: cc, venue: l.venue ?? "", date: l.date };
}
// average early position over the last four real runs, 0 = led, 1 = last
function paceOf(form: any[] | null, meetDate: string): number | null {
  if (!form) return null; const runs = form.filter(f => !f.isTrial && !f.isJumpOut && f.date && f.date < meetDate && f.positionAt800 && f.starters > 1).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 4);
  if (!runs.length) return null; const v = runs.reduce((a, f) => a + Math.min(1, Math.max(0, (f.positionAt800 - 1) / (f.starters - 1))), 0) / runs.length; return +v.toFixed(2);
}
function recentRuns(form: any[] | null, meetDate: string) {
  if (!form) return null; const runs = form.filter(f => !f.isTrial && !f.isJumpOut && f.date && f.date < meetDate).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 3);
  return runs.map(l => ({ pos: l.position ?? null, field: l.starters ?? null, margin: l.position === 1 ? 0 : num(l.margin), cls: classRank(l.raceClass), date: l.date, venue: l.venue ?? "" }));
}
function formFromRuns(form: any[] | null, meetDate: string, lastTen: unknown): string {
  const runs = (form ?? []).filter(f => !f.isTrial && !f.isJumpOut && f.date && f.date < meetDate && f.position).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!runs.length) { try { const arr = JSON.parse(String(lastTen ?? "[]")); return arr.map((c: string) => (c === "-" ? "x" : c)).join("").slice(-8); } catch { return ""; } }
  let out = ""; let prev: string | null = null;
  for (const r of runs) { if (prev && (Date.parse(r.date) - Date.parse(prev)) / 86400000 >= 84) out += "x"; out += r.position >= 10 ? "0" : String(r.position); prev = r.date; }
  if (prev && (Date.parse(meetDate) - Date.parse(prev)) / 86400000 >= 84) out += "x";
  return out.slice(-8);
}

function mapEntry(e: any, meetDate: string, todayClass: string) {
  const h = e.horse ?? {};
  return {
    no: e.raceEntryNumber, name: e.horseName ?? h.name ?? "", barrier: e.liveBarrierNumber || e.barrierNumber || null,
    weight: num(e.weightCarried ?? e.weight), jockey: e.jockey?.fullName ?? e.jockeyName ?? "", trainer: e.trainer?.fullName ?? e.trainerName ?? "",
    age: h.age ?? null, sex: h.sex ? String(h.sex)[0] : "",
    career: stats(h.careerStats), track: stats(e.trackStats), distance: stats(e.distanceStats), trackDistance: stats(e.trackDistanceStats), barrierRec: stats(e.atThisBarrierNumberStats), classRec: stats(e.atThisClassStats), pace: paceOf(h.horseForm, meetDate),
    good: stats(h.goodStats), soft: stats(h.softStats), heavy: stats(h.heavyStats), firstUp: stats(h.firstUpStats), secondUp: stats(h.secondUpStats),
    form: formFromRuns(h.horseForm, meetDate, h.lastTen), last: lastStart(h.horseForm, meetDate, todayClass), recent: recentRuns(h.horseForm, meetDate),
    jockeyPct: num(e.jockey?.winPercent), trainerPct: num(e.trainer?.winPercent), jockeyRecentPct: num(e.jockey?.recentWinPercent), trainerRecentPct: num(e.trainer?.recentWinPercent),
    apprentice: !!e.jockey?.apprentice, claim: num(e.jockey?.weightClaim), rating: num(h.rating ?? e.handicapRating),
    odds: odds(e.odds), scratched: !!(e.scratched || e.isLateScratching || e.finish === 109), emergency: !!e.emergency,
    gear: e.gearChanges ?? "", comment: e.commentShort ?? "", horseCode: String(e.horseCode ?? h.id ?? ""), finish: e.finish ?? null, sp: num(e.startingPrice),
  };
}

const RACE_FIELDS = `id raceNumber name distance class raceStatus status hasResults resultsString trackCondition trackRating time runnersCount fieldCount totalPrizeMoney`;
const FORM_QUERY = (meet: string, no: number) => `{ r: getRaceForm(meetCode:"${meet}", raceNumber:${no}){ ${RACE_FIELDS}
  raceEntries { ...E } formRaceEntries { ...E } } }
fragment E on RaceEntryItem { id raceEntryNumber barrierNumber liveBarrierNumber weight weightCarried scratched isLateScratching emergency finish horseName horseCode jockeyName trainerName gearChanges commentShort trackStats distanceStats trackDistanceStats atThisBarrierNumberStats atThisClassStats handicapRating
    horse { id name age sex careerStats lastTen goodStats softStats heavyStats firstUpStats secondUpStats rating horseForm { date venue distance position starters margin raceClass raceCode isTrial isJumpOut positionAt800 positionAt400 } }
    jockey { fullName winPercent recentWinPercent apprentice weightClaim } trainer { fullName winPercent recentWinPercent } odds { providerCode oddsWin } startingPrice }`;

async function syncMeeting(feed: any, existing: any | null, force: boolean) {
  const meetId = String(feed.meet_id);
  const d = await gql(`{ m: getMeeting(id:"${meetId}"){ id date meetingName venueName state trackCondition trackRating railPosition weather racesCount status }
    races: getRacesForMeet(meetCode:"${meetId}"){ ${RACE_FIELDS} } }`);
  const m = d.m ?? {}; const races: any[] = (d.races ?? []).sort((a: any, b: any) => a.raceNumber - b.raceNumber);
  const meetDate = m.date ?? feed.date; const now = Date.now();
  const stored: any = existing?.data ?? null; const storedRaces: Record<number, any> = {}; for (const r of stored?.races ?? []) storedRaces[r.no] = r;
  const outRaces: any[] = []; const results: any[] = []; let fetched = 0;
  for (const r of races) {
    const no = r.raceNumber; const prev = storedRaces[no]; const t = r.time ? Date.parse(r.time) : null;
    const finished = !!(r.hasResults || (r.resultsString && r.resultsString.trim()));
    const near = t != null && Math.abs(t - now) < 45 * 60 * 1000;
    const prevHasResult = !!(prev && prev.feedResult);
    const raceDay = !!meetDate && new Date(now + 10 * 3600 * 1000).toISOString().slice(0, 10) === String(meetDate).slice(0, 10);
    const prevAge = prev?.syncedAt ? now - Date.parse(prev.syncedAt) : Infinity;
    const stale = raceDay && !finished && !prevHasResult && prevAge > 20 * 60 * 1000;
    const need = force || !prev || stale || (near && !prevHasResult) || (finished && !prevHasResult) || (r.raceStatus !== prev?.raceStatus);
    let race: any;
    if (need) {
      fetched++;
      const fd = await gql(FORM_QUERY(meetId, no)); const fr = fd.r ?? r;
      const entries = (fr.raceEntries && fr.raceEntries.length) ? fr.raceEntries : (fr.formRaceEntries ?? []);
      const runners = entries.map((e: any) => mapEntry(e, meetDate, fr.class ?? r.class)).sort((a: any, b: any) => a.no - b.no);
      const order = runners.filter((x: any) => x.finish && x.finish > 0 && x.finish < 100).sort((a: any, b: any) => a.finish - b.finish).map((x: any) => x.no);
      const positions = order.length ? order : (finished && fr.resultsString ? String(fr.resultsString).split(/[^0-9]+/).filter(Boolean).map(Number) : []);
      race = { no, name: fr.name ?? "", distance: num(fr.distance), class: fr.class ?? "", time: fr.time ?? null, raceStatus: fr.raceStatus ?? "", condition: [fr.trackCondition, fr.trackRating].filter(Boolean).join(" "), prizemoney: fr.totalPrizeMoney ?? null, meetingId: meetId,
        runners: runners.map(({ finish, ...rest }: any) => rest), feedResult: positions.length >= 3 ? { positions, at: new Date().toISOString() } : null, syncedAt: new Date().toISOString() };
    } else { race = { ...prev, raceStatus: r.raceStatus ?? prev.raceStatus }; }
    outRaces.push(race);
    if (race.feedResult) results.push({ meeting_id: meetId, race_no: no, positions: race.feedResult.positions, entered_by: "racing.com feed", entered_at: race.feedResult.at });
  }
  const meeting = { id: meetId, meeting: feed.name ?? m.venueName ?? m.meetingName, venue: m.venueName ?? "", state: m.state ?? "", date: meetDate, condition: [m.trackCondition, m.trackRating].filter(Boolean).join(" ") || (stored?.condition ?? "Good 4"), rail: m.railPosition ?? "", weather: m.weather ?? "", status: m.status ?? "", sort: feed.sort ?? 99,
    races: outRaces, source: "racing.com", syncedAt: new Date().toISOString(), updatedAt: Date.now() };
  const { error } = await sb.from("kyw_meeting").upsert({ id: meetId, data: meeting, updated_at: new Date().toISOString() }); if (error) throw error;
  if (results.length) { const { error: e2 } = await sb.from("kyw_results").upsert(results, { onConflict: "meeting_id,race_no", ignoreDuplicates: true }); if (e2) throw e2; }
  return { meetId, name: meeting.meeting, races: outRaces.length, fetched, results: results.length };
}

// Metro venues we follow, matched on racing.com's venue slug. Order within a state is the order here.
const METRO: [RegExp, string, string][] = [
  [/flemington/, "Flemington", "VIC"], [/caulfield/, "Caulfield", "VIC"], [/moonee-valley|the-valley/, "Moonee Valley", "VIC"], [/sandown/, "Sandown", "VIC"],
  [/randwick/, "Randwick", "NSW"], [/rosehill/, "Rosehill", "NSW"], [/warwick-farm/, "Warwick Farm", "NSW"], [/canterbury/, "Canterbury", "NSW"], [/kensington/, "Kensington", "NSW"],
  [/eagle-farm/, "Eagle Farm", "QLD"], [/doomben/, "Doomben", "QLD"], [/gold-coast/, "Gold Coast", "QLD"], [/sunshine-coast/, "Sunshine Coast", "QLD"],
  [/morphettville/, "Morphettville", "SA"], [/ascot/, "Ascot", "WA"], [/belmont/, "Belmont", "WA"],
];
const STATE_ORDER: Record<string, number> = { VIC: 1, NSW: 2, QLD: 3, SA: 4, WA: 5 };
function aestDate(offsetDays = 0) { const d = new Date(Date.now() + 10 * 3600 * 1000 + offsetDays * 86400000); return d.toISOString().slice(0, 10); }
// Keep the feed pointed at the next metro race day. Runs on every call; does nothing while the current feed is still current.
async function rollFeed(): Promise<string | null> {
  const { data: feeds } = await sb.from("kyw_feed").select("*").eq("active", true);
  const yesterday = aestDate(-1);
  if ((feeds ?? []).some((f: any) => f.date && String(f.date) >= yesterday)) return null;
  for (let d = 0; d <= 8; d++) {
    const date = aestDate(d);
    const data = await gql(`{ m: GetMeetingByDate(date:"${date}"){ id venueName state isTab isTrial isJumpOut status } }`);
    const found: any[] = [];
    for (const m of data.m ?? []) { if (m.isTab !== 1 || m.isTrial || m.isJumpOut) continue; const slug = String(m.venueName ?? "").toLowerCase();
      const hit = METRO.find(([re]) => re.test(slug)); if (!hit) continue; if (found.some(f => f.state === hit[2])) continue; // one metro per state
      found.push({ meet_id: String(m.id), name: hit[1], state: hit[2], date, sort: STATE_ORDER[hit[2]] ?? 9 }); }
    if (!found.length) continue;
    await sb.from("kyw_feed").update({ active: false }).eq("active", true);
    await sb.from("kyw_feed").upsert(found.map(({ state, ...f }) => ({ ...f, active: true })), { onConflict: "meet_id" });
    const keep = found.map(f => f.meet_id);
    const { data: olds } = await sb.from("kyw_meeting").select("id"); for (const o of olds ?? []) { if (!keep.includes(String(o.id))) await sb.from("kyw_meeting").delete().eq("id", o.id); }
    return date;
  }
  return null;
}

// Backtest: a finished meeting, mapped as the app would have seen it that morning (runs on or after the day excluded), priced at SP, with results.
async function backtest(meetId: string) {
  const d = await gql(`{ m: getMeeting(id:"${meetId}"){ id date meetingName venueName state trackCondition trackRating } races: getRacesForMeet(meetCode:"${meetId}"){ ${RACE_FIELDS} } }`);
  const m = d.m ?? {}; const meetDate = m.date; const out: any[] = [];
  for (const r of (d.races ?? []).sort((a: any, b: any) => a.raceNumber - b.raceNumber)) {
    const fd = await gql(FORM_QUERY(meetId, r.raceNumber)); const fr = fd.r ?? r;
    const entries = (fr.raceEntries && fr.raceEntries.length) ? fr.raceEntries : (fr.formRaceEntries ?? []);
    const cond = String(fr.trackCondition ?? "").toLowerCase(); const catKey = cond.startsWith("h") ? "heavy" : (cond.startsWith("so") || cond.startsWith("sy")) ? "soft" : "good";
    const unrun = (rec: any, fin: number | null) => { if (!rec || !fin || fin > 100) return rec; const [s, w, p] = rec; return [Math.max(0, s - 1), Math.max(0, w - (fin === 1 ? 1 : 0)), Math.max(0, p - (fin === 2 || fin === 3 ? 1 : 0))]; };
    const runners = entries.map((e: any) => mapEntry(e, meetDate, fr.class ?? r.class)).map((x: any) => ({ ...x, odds: x.sp ?? x.odds, rating: null,
      career: unrun(x.career, x.finish), track: unrun(x.track, x.finish), distance: unrun(x.distance, x.finish), trackDistance: unrun(x.trackDistance, x.finish), barrierRec: unrun(x.barrierRec, x.finish), [catKey]: unrun(x[catKey], x.finish) })).sort((a: any, b: any) => a.no - b.no);
    const positions = runners.filter((x: any) => x.finish && x.finish > 0 && x.finish < 100).sort((a: any, b: any) => a.finish - b.finish).map((x: any) => x.no);
    out.push({ no: r.raceNumber, name: fr.name, distance: num(fr.distance), class: fr.class, condition: [fr.trackCondition, fr.trackRating].filter(Boolean).join(" "), runners: runners.map(({ finish, ...rest }: any) => rest), result: positions.length >= 3 ? { positions } : null });
  }
  const data = { id: meetId, meeting: m.venueName, date: meetDate, condition: [m.trackCondition, m.trackRating].filter(Boolean).join(" "), races: out };
  await sb.from("kyw_backtest").upsert({ meet_id: meetId, data, created_at: new Date().toISOString() });
  return { meetId, name: m.venueName, races: out.length, withResults: out.filter(x => x.result).length };
}

async function backtestDate(date: string) {
  const data = await gql(`{ m: GetMeetingByDate(date:"${date}"){ id venueName state isTab isTrial isJumpOut } }`);
  const out: any[] = []; const seen = new Set<string>();
  for (const m of data.m ?? []) { if (m.isTab !== 1 || m.isTrial || m.isJumpOut) continue; const slug = String(m.venueName ?? "").toLowerCase(); const hit = METRO.find(([re]) => re.test(slug)); if (!hit || seen.has(hit[2])) continue; seen.add(hit[2]);
    try { out.push(await backtest(String(m.id))); } catch (e) { out.push({ meetId: m.id, error: String(e).slice(0, 200) }); } }
  return { date, meetings: out };
}

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, x-flock-code, authorization, apikey", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const code = req.headers.get("x-flock-code") ?? url.searchParams.get("code");
  if (code !== FLOCK) return new Response(JSON.stringify({ error: "not the flock" }), { status: 401, headers: { "Content-Type": "application/json", ...CORS } });
  const force = url.searchParams.get("force") === "1";
  const only = url.searchParams.get("meet");
  const bt = url.searchParams.get("backtest"); const btd = url.searchParams.get("backtestdate");
  if (btd) { try { const r = await backtestDate(btd); return new Response(JSON.stringify(r), { headers: { "Content-Type": "application/json", ...CORS } }); } catch (e) { return new Response(JSON.stringify({ error: String(e).slice(0, 400) }), { status: 500, headers: { "Content-Type": "application/json", ...CORS } }); } }
  if (bt) { try { const r = await backtest(bt); return new Response(JSON.stringify(r), { headers: { "Content-Type": "application/json", ...CORS } }); } catch (e) { return new Response(JSON.stringify({ error: String(e).slice(0, 400) }), { status: 500, headers: { "Content-Type": "application/json", ...CORS } }); } }
  let rolled: string | null = null; try { rolled = await rollFeed(); } catch (e) { console.error("rollFeed", e); }
  const { data: feeds, error } = await sb.from("kyw_feed").select("*").eq("active", true).order("sort");
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { "Content-Type": "application/json", ...CORS } });
  const { data: existingRows } = await sb.from("kyw_meeting").select("id,data");
  const existing: Record<string, any> = {}; for (const r of existingRows ?? []) existing[r.id] = r;
  const out: any[] = [];
  for (const f of feeds ?? []) { if (only && String(f.meet_id) !== only) continue;
    try { out.push(await syncMeeting(f, existing[String(f.meet_id)] ?? null, force)); } catch (e) { out.push({ meetId: f.meet_id, error: String(e).slice(0, 300) }); } }
  await sb.from("kyw_feed_log").insert({ summary: { rolled, meetings: out } });
  return new Response(JSON.stringify({ ok: true, at: new Date().toISOString(), rolled, meetings: out }), { headers: { "Content-Type": "application/json", ...CORS } });
});
