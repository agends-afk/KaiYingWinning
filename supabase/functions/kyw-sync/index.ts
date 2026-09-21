// Kai Ying Winning feed: racing.com -> Supabase tables the app reads.
// Runs on a schedule (pg_cron -> pg_net: 10 minutes during race hours, plus a 6am AEST daily roll) and on demand from the app ("Sync now").
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

// Before race day racing.com's raceEntries holds only the scratchings; the full field is in formRaceEntries. Merge on saddlecloth number, raceEntries winning where both exist.
function mergeEntries(a: any[] | null | undefined, b: any[] | null | undefined): any[] {
  const byNo = new Map<number, any>();
  for (const e of b ?? []) if (e && e.raceEntryNumber != null) byNo.set(e.raceEntryNumber, e);
  for (const e of a ?? []) { if (!e || e.raceEntryNumber == null) continue; const base = { ...(byNo.get(e.raceEntryNumber) ?? {}) }; for (const [k, v] of Object.entries(e)) if (v !== null && v !== undefined) (base as any)[k] = v; byNo.set(e.raceEntryNumber, base); }
  return [...byNo.values()];
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
    const no = r.raceNumber; const prev = storedRaces[no];
    const finished = !!(r.hasResults || (r.resultsString && r.resultsString.trim()));
    const prevHasResult = !!(prev && prev.feedResult);
    // Every run (10 minutes apart during racing hours) re-reads each race until its result is in. Writes happen only when something changed.
    const need = force || !prev || !prevHasResult || (r.raceStatus !== prev?.raceStatus);
    let race: any;
    if (need) {
      fetched++;
      const fd = await gql(FORM_QUERY(meetId, no)); const fr = fd.r ?? r;
      const entries = mergeEntries(fr.raceEntries, fr.formRaceEntries);
      const runners = entries.map((e: any) => mapEntry(e, meetDate, fr.class ?? r.class)).sort((a: any, b: any) => a.no - b.no);
      const order = runners.filter((x: any) => x.finish && x.finish > 0 && x.finish < 100).sort((a: any, b: any) => a.finish - b.finish).map((x: any) => x.no);
      const positions = order.length ? order : (finished && fr.resultsString ? String(fr.resultsString).split(/[^0-9]+/).filter(Boolean).map(Number) : []);
      // The field the app judges a run race by is the last one read before the result: pre-race prices and scratchings, never post-race data.
      // Opening price: the first price seen for the runner today. Kept across re-reads so the tip has a fixed market to work from; the live price keeps moving alongside it.
      const prevByNo: Record<number, any> = {}; for (const x of prev?.runners ?? []) prevByNo[x.no] = x;
      // Late market: one refresh of the rating's market about 20 minutes before the jump, taken on the first read inside that window and then held.
      const t = r.time ? Date.parse(r.time) : null; const minsTo = t != null ? (t - now) / 60000 : null;
      const lateAt: string | undefined = prev?.lateAt ?? ((minsTo != null && minsTo <= 20 && minsTo > -60) ? new Date().toISOString() : undefined);
      const freshRunners = runners.map(({ finish, ...rest }: any) => ({ ...rest,
        openOdds: prevByNo[rest.no]?.openOdds ?? prevByNo[rest.no]?.odds ?? rest.odds ?? null,
        lateOdds: prev?.lateAt ? (prevByNo[rest.no]?.lateOdds ?? null) : (lateAt ? (rest.odds ?? null) : undefined) }));
      const frozen = (prev?.frozenAt && prev?.runners?.length) ? prev.runners : (positions.length >= 3 && prev?.runners?.length && !prevHasResult ? prev.runners : null);
      race = { no, name: fr.name ?? "", distance: num(fr.distance), class: fr.class ?? "", time: fr.time ?? null, raceStatus: fr.raceStatus ?? "", condition: [fr.trackCondition, fr.trackRating].filter(Boolean).join(" "), prizemoney: fr.totalPrizeMoney ?? null, meetingId: meetId,
        runners: frozen ?? freshRunners, frozenAt: frozen ? (prev.frozenAt ?? prev.syncedAt) : undefined, lateAt: frozen ? prev?.lateAt : lateAt, lockOverride: prev?.lockOverride, feedResult: positions.length >= 3 ? { positions, at: prev?.feedResult?.at ?? new Date().toISOString() } : null, syncedAt: new Date().toISOString() };
    } else { race = { ...prev, raceStatus: r.raceStatus ?? prev.raceStatus }; }
    outRaces.push(race);
    if (race.feedResult) results.push({ meeting_id: meetId, race_no: no, positions: race.feedResult.positions, entered_by: "racing.com feed", entered_at: race.feedResult.at });
  }
  const meeting = { id: meetId, meeting: feed.name ?? m.venueName ?? m.meetingName, venue: m.venueName ?? "", state: m.state ?? "", date: meetDate, condition: [m.trackCondition, m.trackRating].filter(Boolean).join(" ") || (stored?.condition ?? "Good 4"), rail: m.railPosition ?? "", weather: m.weather ?? "", status: m.status ?? "", sort: feed.sort ?? 99,
    races: outRaces, source: "racing.com", syncedAt: stored?.syncedAt ?? new Date().toISOString(), updatedAt: stored?.updatedAt ?? Date.now() };
  // Write only when something other than the timestamps differs.
  // Postgres returns jsonb with its own key order, so compare a key-sorted rendering.
  const canon = (v: any): string => Array.isArray(v) ? "[" + v.map(canon).join(",") + "]" : (v && typeof v === "object") ? "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}" : JSON.stringify(v ?? null);
  const sig = (x: any) => canon({ ...x, syncedAt: 0, updatedAt: 0, races: (x.races ?? []).map((r: any) => ({ ...r, syncedAt: 0, feedResult: r.feedResult ? { positions: r.feedResult.positions } : null })) });
  const changed = !stored || sig(meeting) !== sig(stored);
  if (changed) { meeting.syncedAt = new Date().toISOString(); meeting.updatedAt = Date.now(); const { error } = await sb.from("kyw_meeting").upsert({ id: meetId, data: meeting, updated_at: new Date().toISOString() }); if (error) throw error; }
  const newResults = results.filter(r => !(storedRaces[r.race_no]?.feedResult));
  if (newResults.length) { const { error: e2 } = await sb.from("kyw_results").upsert(newResults, { onConflict: "meeting_id,race_no", ignoreDuplicates: true }); if (e2) throw e2; }
  // Keep the feed row's race window current so the scheduler knows when to run.
  const times = races.map((r: any) => r.time ? Date.parse(r.time) : NaN).filter((t: number) => !isNaN(t));
  if (times.length) { const first = new Date(Math.min(...times)).toISOString(), last = new Date(Math.max(...times)).toISOString();
    const same = (a: any, b: string) => a && Date.parse(a) === Date.parse(b);
    if (!same(feed.first_at, first) || !same(feed.last_at, last)) await sb.from("kyw_feed").update({ first_at: first, last_at: last }).eq("meet_id", meetId); }
  return { meetId, name: meeting.meeting, races: outRaces.length, fetched, changed, results: newResults.length };
}

// Venues we name. Metro list first (used in full on Wednesdays and Saturdays), then Hong Kong and Canberra.
const METRO: [RegExp, string, string][] = [
  [/flemington/, "Flemington", "VIC"], [/caulfield/, "Caulfield", "VIC"], [/moonee-valley|the-valley/, "Moonee Valley", "VIC"], [/sandown/, "Sandown", "VIC"],
  [/randwick/, "Randwick", "NSW"], [/rosehill/, "Rosehill", "NSW"], [/warwick-farm/, "Warwick Farm", "NSW"], [/canterbury/, "Canterbury", "NSW"], [/kensington/, "Kensington", "NSW"],
  [/eagle-farm/, "Eagle Farm", "QLD"], [/doomben/, "Doomben", "QLD"], [/gold-coast/, "Gold Coast", "QLD"], [/sunshine-coast/, "Sunshine Coast", "QLD"],
  [/morphettville/, "Morphettville", "SA"], [/ascot/, "Ascot", "WA"], [/belmont/, "Belmont", "WA"],
];
const HK_VENUES: [RegExp, string][] = [[/sha-tin/, "Sha Tin"], [/happy-valley/, "Happy Valley"]];
const TOP_STATES = ["NSW", "VIC", "QLD", "ACT", "WA"]; // one meeting a day from each, the richest card
const STATE_ORDER: Record<string, number> = { VIC: 1, NSW: 2, QLD: 3, SA: 4, ACT: 5, WA: 6, HK: 7 };
function aestDate(offsetDays = 0) { const d = new Date(Date.now() + 10 * 3600 * 1000 + offsetDays * 86400000); return d.toISOString().slice(0, 10); }
function aestDow(date: string) { return new Date(date + "T00:00:00Z").getUTCDay(); } // 0 Sun .. 6 Sat
function prettyVenue(slug: string) { return slug.split("-").filter(w => !/^(bet365|ladbrokes|sportsbet|tab|pioneer|park)$/i.test(w)).map(w => w[0].toUpperCase() + w.slice(1)).join(" "); }

// Which meetings we follow on a given day.
// Wednesday and Saturday: every metro meeting. Every day: the richest TAB meeting in each of NSW, VIC, QLD, ACT and WA where no metro is already taken.
// Wednesday and Sunday: Hong Kong.
async function selectMeetings(date: string) {
  const dow = aestDow(date); const metroDay = dow === 3 || dow === 6; const hkDay = dow === 3 || dow === 0;
  const data = await gql(`{ m: GetMeetingByDate(date:"${date}"){ id venueName state country isTab isTrial isJumpOut } }`);
  const all = (data.m ?? []).filter((m: any) => m.isTab === 1 && !m.isTrial && !m.isJumpOut);
  const picks: any[] = []; const taken = new Set<string>();
  if (metroDay) for (const m of all) { const slug = String(m.venueName ?? "").toLowerCase(); const hit = METRO.find(([re]) => re.test(slug)); if (!hit) continue;
    picks.push({ meet_id: String(m.id), name: hit[1], state: hit[2], date, sort: STATE_ORDER[hit[2]] ?? 9 }); taken.add(hit[2]); }
  for (const st of TOP_STATES) { if (taken.has(st)) continue; const cands = all.filter((m: any) => m.state === st); if (!cands.length) continue;
    let best: any = null, bestPrize = -1;
    for (const c of cands) { let prize = 0; try { const r = await gql(`{ races: getRacesForMeet(meetCode:"${c.id}"){ totalPrizeMoney } }`); prize = (r.races ?? []).reduce((a: number, x: any) => a + (num(x.totalPrizeMoney) ?? 0), 0); } catch { prize = 0; }
      if (prize > bestPrize) { bestPrize = prize; best = c; } }
    if (best) { const slug = String(best.venueName ?? "").toLowerCase(); const hit = METRO.find(([re]) => re.test(slug)); picks.push({ meet_id: String(best.id), name: hit ? hit[1] : prettyVenue(slug), state: st, date, sort: STATE_ORDER[st] ?? 9 }); taken.add(st); } }
  if (hkDay) for (const m of all) { if (m.state !== "HK") continue; const slug = String(m.venueName ?? "").toLowerCase(); const hit = HK_VENUES.find(([re]) => re.test(slug));
    picks.push({ meet_id: String(m.id), name: hit ? hit[1] : prettyVenue(slug), state: "HK", date, sort: STATE_ORDER.HK }); }
  return picks;
}

// Once a day: point the feed at today's meetings, drop yesterday's, trim the log.
async function dailyRoll(): Promise<{ date: string; picks: any[]; archived: any[] }> {
  const date = aestDate(0);
  const picks = await selectMeetings(date);
  // Archive the meetings we followed, as the form stood that morning and priced at SP, so any weights can be tested against them later.
  const archived: any[] = [];
  const { data: oldFeeds } = await sb.from("kyw_feed").select("meet_id,name,date").eq("active", true);
  for (const f of oldFeeds ?? []) { if (String(f.date) >= date) continue; try { archived.push(await backtest(String(f.meet_id))); } catch (e) { archived.push({ meetId: f.meet_id, error: String(e).slice(0, 200) }); } }
  if (picks.length) {
    await sb.from("kyw_feed").update({ active: false }).eq("active", true);
    await sb.from("kyw_feed").upsert(picks.map(({ state, ...f }) => ({ ...f, active: true, first_at: null, last_at: null })), { onConflict: "meet_id" });
    const keep = picks.map(f => f.meet_id);
    const { data: olds } = await sb.from("kyw_meeting").select("id"); for (const o of olds ?? []) { if (!keep.includes(String(o.id))) { await sb.from("kyw_meeting").delete().eq("id", o.id); await sb.from("kyw_results").delete().eq("meeting_id", o.id); } }
    await sb.from("kyw_feed").delete().eq("active", false).lt("date", aestDate(-14));
  }
  await sb.from("kyw_feed_log").delete().lt("at", new Date(Date.now() - 7 * 86400000).toISOString());
  return { date, picks, archived };
}

// Backtest: a finished meeting, mapped as the app would have seen it that morning (runs on or after the day excluded), priced at SP, with results.
async function backtest(meetId: string) {
  const d = await gql(`{ m: getMeeting(id:"${meetId}"){ id date meetingName venueName state trackCondition trackRating } races: getRacesForMeet(meetCode:"${meetId}"){ ${RACE_FIELDS} } }`);
  const m = d.m ?? {}; const meetDate = m.date;
  const out: any[] = await Promise.all((d.races ?? []).sort((a: any, b: any) => a.raceNumber - b.raceNumber).map(async (r: any) => {
    const fd = await gql(FORM_QUERY(meetId, r.raceNumber)); const fr = fd.r ?? r;
    const entries = mergeEntries(fr.raceEntries, fr.formRaceEntries);
    const cond = String(fr.trackCondition ?? "").toLowerCase(); const catKey = cond.startsWith("h") ? "heavy" : (cond.startsWith("so") || cond.startsWith("sy")) ? "soft" : "good";
    const unrun = (rec: any, fin: number | null) => { if (!rec || !fin || fin > 100) return rec; const [s, w, p] = rec; return [Math.max(0, s - 1), Math.max(0, w - (fin === 1 ? 1 : 0)), Math.max(0, p - (fin === 2 || fin === 3 ? 1 : 0))]; };
    const runners = entries.map((e: any) => mapEntry(e, meetDate, fr.class ?? r.class)).map((x: any) => ({ ...x, odds: x.sp ?? x.odds, rating: null,
      career: unrun(x.career, x.finish), track: unrun(x.track, x.finish), distance: unrun(x.distance, x.finish), trackDistance: unrun(x.trackDistance, x.finish), barrierRec: unrun(x.barrierRec, x.finish), [catKey]: unrun(x[catKey], x.finish) })).sort((a: any, b: any) => a.no - b.no);
    const positions = runners.filter((x: any) => x.finish && x.finish > 0 && x.finish < 100).sort((a: any, b: any) => a.finish - b.finish).map((x: any) => x.no);
    return { no: r.raceNumber, name: fr.name, distance: num(fr.distance), class: fr.class, condition: [fr.trackCondition, fr.trackRating].filter(Boolean).join(" "), runners: runners.map(({ finish, ...rest }: any) => rest), result: positions.length >= 3 ? { positions } : null };
  }));
  const data = { id: meetId, meeting: m.venueName, state: m.state ?? "", date: meetDate, condition: [m.trackCondition, m.trackRating].filter(Boolean).join(" "), races: out };
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
  const daily = url.searchParams.get("daily") === "1";
  let rolled: any = null; if (daily) { try { rolled = await dailyRoll(); } catch (e) { console.error("dailyRoll", e); rolled = { error: String(e).slice(0, 200) }; } }
  const { data: feeds, error } = await sb.from("kyw_feed").select("*").eq("active", true).order("sort");
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { "Content-Type": "application/json", ...CORS } });
  const { data: existingRows } = await sb.from("kyw_meeting").select("id,data");
  const existing: Record<string, any> = {}; for (const r of existingRows ?? []) existing[r.id] = r;
  const out: any[] = [];
  const todo = (feeds ?? []).filter((f: any) => !only || String(f.meet_id) === only);
  const one = async (f: any) => { try { return await syncMeeting(f, existing[String(f.meet_id)] ?? null, force || daily); } catch (e) { return { meetId: f.meet_id, error: String(e).slice(0, 300) }; } };
  if (daily || force) out.push(...await Promise.all(todo.map(one))); else for (const f of todo) out.push(await one(f));
  if (daily || out.some(o => o.error || o.changed || o.fetched)) await sb.from("kyw_feed_log").insert({ summary: { rolled, meetings: out } });
  return new Response(JSON.stringify({ ok: true, at: new Date().toISOString(), rolled, meetings: out }), { headers: { "Content-Type": "application/json", ...CORS } });
});
