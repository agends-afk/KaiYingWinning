// Kai Ying Winning feed: racing.com -> Supabase tables the app reads.
// Runs on a schedule (pg_cron -> pg_net: 10 minutes during race hours, plus a 6am AEST daily roll) and on demand from the app ("Sync now").
// Racing.com is the raw data source only. Ratings are computed in the app from each Pelican's weights.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { parseForm, matchKey } from "./ra.js";
import { parseRaceCard, parseRaceInfo, parseHorse, parseResults, parseStats, toteMap, toteOn, classRank as hkClassRank } from "./hkjc.js";

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
// Trials and jump-outs. racing.com flags some of them; the rest are caught by class name or by the Free Fields run lines for the horse (trialDates).
// The Maribyrnong Trial Stakes and similar named races are real races, so a trial word only counts when the class has no Listed or Group status.
function isTrialRun(f: any, trialDates?: Set<string>): boolean {
  if (f.isTrial || f.isJumpOut) return true;
  if (trialDates && f.date && trialDates.has(String(f.date).slice(0, 10))) return true;
  const c = String(f.raceClass ?? "").toUpperCase();
  return /\bTRL\b|\bTRIAL\b|JUMP|\bJMP\b|^OUT\b/.test(c) && !/LISTED|\bLR\b|GROUP|\bG[123]\b|STAKES/.test(c);
}
function raceRuns(form: any[] | null, meetDate: string, trialDates?: Set<string>) {
  return (form ?? []).filter(f => f.date && f.date < meetDate && !isTrialRun(f, trialDates)).sort((a, b) => (a.date < b.date ? 1 : -1));
}
// Last start: the latest race run. A horse with no race run is rated on its latest trial instead, marked trial so the app counts it at a fraction of a race.
function lastStart(form: any[] | null, meetDate: string, todayClass: string, trialDates?: Set<string>) {
  if (!form) return null;
  const runs = raceRuns(form, meetDate, trialDates);
  const trial = !runs.length;
  const l = trial ? form.filter(f => f.date && f.date < meetDate && f.position).sort((a, b) => (a.date < b.date ? 1 : -1))[0] : runs[0]; if (!l) return null;
  const days = Math.round((Date.parse(meetDate) - Date.parse(l.date)) / 86400000);
  const tr = classRank(todayClass), lr = trial ? null : classRank(l.raceClass); let cc = 0; if (tr != null && lr != null && Math.abs(tr - lr) >= 5) cc = tr > lr ? 1 : -1;
  return { pos: l.position ?? null, field: l.starters ?? null, margin: l.position === 1 ? 0 : num(l.margin), days, race: String(l.raceCode ?? ""), classChange: cc, venue: l.venue ?? "", date: l.date, ...(trial ? { trial: true } : {}) };
}
// average early position over the last four real runs, 0 = led, 1 = last
function paceOf(form: any[] | null, meetDate: string, trialDates?: Set<string>): number | null {
  if (!form) return null; const runs = raceRuns(form, meetDate, trialDates).filter(f => f.positionAt800 && f.starters > 1).slice(0, 4);
  if (!runs.length) return null; const v = runs.reduce((a, f) => a + Math.min(1, Math.max(0, (f.positionAt800 - 1) / (f.starters - 1))), 0) / runs.length; return +v.toFixed(2);
}
function recentRuns(form: any[] | null, meetDate: string, trialDates?: Set<string>) {
  if (!form) return null; const runs = raceRuns(form, meetDate, trialDates).slice(0, 3);
  return runs.map(l => ({ pos: l.position ?? null, field: l.starters ?? null, margin: l.position === 1 ? 0 : num(l.margin), cls: classRank(l.raceClass), date: l.date, venue: l.venue ?? "" }));
}
function formFromRuns(form: any[] | null, meetDate: string, lastTen: unknown, trialDates?: Set<string>): string {
  const runs = raceRuns(form, meetDate, trialDates).filter(f => f.position).reverse();
  // racing.com's lastTen counts trials, so it stands in only when there is no run history at all
  if (!runs.length) { if (form && form.length) return ""; try { const arr = JSON.parse(String(lastTen ?? "[]")); return arr.map((c: string) => (c === "-" ? "x" : c)).join("").slice(-8); } catch { return ""; } }
  let out = ""; let prev: string | null = null;
  for (const r of runs) { if (prev && (Date.parse(r.date) - Date.parse(prev)) / 86400000 >= 84) out += "x"; out += r.position >= 10 ? "0" : String(r.position); prev = r.date; }
  if (prev && (Date.parse(meetDate) - Date.parse(prev)) / 86400000 >= 84) out += "x";
  return out.slice(-8);
}

// HKJC run lines in the shape of racing.com's horseForm, so lastStart, recentRuns and formFromRuns serve Hong Kong unchanged.
const hkRaceClass = (c: string | null | undefined) => { const s = String(c ?? "").toUpperCase(); if (/^G[123]$/.test(s)) return s; const r = hkClassRank(s); return r != null ? `BM${r}` : (/GRIFFIN/.test(s) ? "MDN" : ""); };
const hkFormRuns = (hk: any) => (hk.runs ?? []).map((q: any) => ({ date: q.d, venue: q.v ?? "", position: q.p, starters: null, margin: q.m, raceClass: hkRaceClass(q.c), raceCode: "", isTrial: false, isJumpOut: false }));
function mapEntry(e: any, meetDate: string, todayClass: string, trialDates?: Set<string>, hk?: any) {
  const h = e.horse ?? {};
  if (hk) { h.horseForm = hkFormRuns(hk); if (!stats(h.careerStats) && hk.rec) h.careerStats = `${hk.rec[0]}:${hk.rec[1]}-0-${hk.rec[2]}`; trialDates = undefined; }
  // No career starts means every run in the history is a trial or jump-out, whatever its flags say.
  const c0 = stats(h.careerStats); if (c0 && c0[0] === 0) trialDates = new Set((h.horseForm ?? []).map((f: any) => String(f.date ?? "").slice(0, 10)));
  return {
    no: e.raceEntryNumber, name: e.horseName ?? h.name ?? "", barrier: e.liveBarrierNumber || e.barrierNumber || null,
    weight: num(e.weightCarried ?? e.weight), jockey: e.jockey?.fullName ?? e.jockeyName ?? "", trainer: e.trainer?.fullName ?? e.trainerName ?? "",
    age: h.age ?? null, sex: h.sex ? String(h.sex)[0] : "",
    career: stats(h.careerStats), track: stats(e.trackStats), distance: stats(e.distanceStats), trackDistance: stats(e.trackDistanceStats), barrierRec: stats(e.atThisBarrierNumberStats), classRec: stats(e.atThisClassStats), pace: paceOf(h.horseForm, meetDate, trialDates),
    good: stats(h.goodStats), soft: stats(h.softStats), heavy: stats(h.heavyStats), firstUp: stats(h.firstUpStats), secondUp: stats(h.secondUpStats),
    form: formFromRuns(h.horseForm, meetDate, h.lastTen, trialDates), last: lastStart(h.horseForm, meetDate, todayClass, trialDates), recent: recentRuns(h.horseForm, meetDate, trialDates),
    jockeyPct: hk?.jp ?? num(e.jockey?.winPercent), trainerPct: hk?.tp ?? num(e.trainer?.winPercent), jockeyRecentPct: num(e.jockey?.recentWinPercent), trainerRecentPct: num(e.trainer?.recentWinPercent),
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


/* ---- Racing Australia Free Fields: one form page per followed meeting per day, cached in kyw_ra ----
   Adds each runner's full career record and run-by-run lines (with 600m times and in-running positions for every state) to the racing.com field.
   Fetched once at the morning roll or on the first sync of the day; a miss is retried after two hours; nothing is fetched during the 10-minute cycle otherwise. */
const RA = "https://racingaustralia.horse";
const RA_HEADERS = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15", "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8", "Accept-Language": "en-AU,en;q=0.9" };
const raCal: Record<string, string> = {};
async function raFetch(path: string) { const res = await fetch(RA + path, { headers: RA_HEADERS, redirect: "follow" }); if (!res.ok) throw new Error(`racingaustralia ${res.status}`); return await res.text(); }
const nameKey = (s: any) => String(s ?? "").toUpperCase().replace(/\(.*?\)/g, "").replace(/[^A-Z0-9]/g, "");
function compactRA(parsed: any) { const out: Record<string, any> = {};
  for (const race of parsed.races) for (const r of race.runners) { if (!r.name) continue;
    out[nameKey(r.name)] = { race: race.no, no: r.no, gear: r.gear || "", rec: r.rec, last10: r.last10 || "", hcp: r.hcp ?? null,
      runs: (r.runs ?? []).slice(0, 10).map((x: any) => ({ t: x.trial ? 1 : 0, pos: x.pos, of: x.of, v: x.venue, d: x.date, dist: x.distance, c: x.cond, cls: x.cls, j: x.jockey, w: x.weight, b: x.barrier, win: x.first, time: x.time, l600: x.l600, m: x.margin, p8: x.p800, p4: x.p400, sp: x.sp, open: x.prices ? x.prices[0] : null })) }; }
  return out; }
// Dates of each horse's trials and jump-outs in its Free Fields run lines, keyed by name.
function raTrialDates(ra: any): Record<string, Set<string>> { const out: Record<string, Set<string>> = {};
  for (const [k, r] of Object.entries<any>(ra?.runners ?? {})) { const s = new Set<string>();
    for (const x of r.runs ?? []) if (x.d && (x.t || /\bTRL\b|TRIAL|^OUT\b|JUMP/i.test(String(x.cls ?? "")) || /jump/i.test(String(x.c ?? ""))) && !/\bLR\b|LISTED|GROUP|\bG[123]\b/i.test(String(x.cls ?? ""))) s.add(String(x.d).slice(0, 10));
    if (s.size) out[k] = s; }
  return out; }
async function raForMeeting(meetId: string, meetDate: string, state: string, venueSlug: string): Promise<any | null> {
  const { data: row } = await sb.from("kyw_ra").select("*").eq("meet_id", meetId).maybeSingle();
  if (row && String(row.date) === meetDate) { if (row.status === "ok") return row.data; if (Date.now() - Date.parse(row.fetched_at) < 2 * 3600e3) return null; }
  let status = "miss", key: string | null = null, data: any = null;
  try {
    if (!/^(NSW|VIC|QLD|SA|WA|TAS|ACT|NT)$/.test(state)) throw new Error("no Free Fields for " + state);
    const cal = raCal[state] ?? (raCal[state] = await raFetch(`/FreeFields/Calendar.aspx?State=${state}`));
    key = matchKey(cal, meetDate, venueSlug); if (!key) throw new Error("no Free Fields meeting matched " + venueSlug);
    const html = await raFetch(`/FreeFields/Form.aspx?Key=${encodeURIComponent(key)}`); const parsed = parseForm(html, key);
    if (!parsed.races.length) throw new Error("Free Fields page had no races");
    data = { key, condition: parsed.condition, rail: parsed.rail, weather: parsed.weather, races: parsed.races.map((r: any) => ({ no: r.no, conditions: r.conditions, prize: r.prize })), runners: compactRA(parsed) }; status = "ok";
  } catch (e) { data = { error: String(e).slice(0, 200) }; }
  await sb.from("kyw_ra").upsert({ meet_id: meetId, key, date: meetDate, fetched_at: new Date().toISOString(), status, data });
  return status === "ok" ? data : null;
}

/* ---- Hong Kong: HKJC form pages, race times and tote ----
   racing.com carries no horse form for Hong Kong and labels its race times in Sydney clock time as if UTC, so a day's HKJC racecards, horse pages and jockey and trainer
   season stats are read once and cached in kyw_ra (data.races[raceNo][saddleNo]). Race times come from the HKJC racecard (Hong Kong time, UTC+8).
   Prices: racing.com fixed odds until 30 minutes before the meeting's first race, then the HKJC tote win pool (every 5 minutes, every minute inside 5 minutes of the jump). */
const HKJC = "https://racing.hkjc.com";
const hkVenue = (meetId: string, name: string): string | null => (/-SHAT$/i.test(meetId) || /sha.?tin/i.test(name)) ? "ST" : (/-H V$|-HV$/i.test(meetId) || /happy.?valley/i.test(name)) ? "HV" : null;
const isHKMeet = (meetId: string, state?: string) => /^HK/i.test(meetId) || state === "HK";
async function hkGet(path: string): Promise<string | null> {
  for (let a = 0; a < 3; a++) { try { const res = await fetch(HKJC + path, { headers: { ...RA_HEADERS, "Accept-Language": "en-US,en;q=0.9" }, redirect: "follow" }); if (res.status === 200) return await res.text(); } catch { /* retry */ } await new Promise(r => setTimeout(r, 300 * (a + 1))); }
  return null;
}
async function pool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> { const out: R[] = []; for (let i = 0; i < items.length; i += limit) out.push(...await Promise.all(items.slice(i, i + limit).map(fn))); return out; }
// racing.com's Hong Kong times read as Sydney local clock time; used only when the HKJC racecard time is missing.
function sydneyClockToUtc(label: string): string {
  const asUtc = Date.parse(String(label).replace(/(\.\d{3})\d+Z$/, "$1Z")); if (isNaN(asUtc)) return label;
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "Australia/Sydney", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const off = (d: number) => { const p: any = Object.fromEntries(f.formatToParts(new Date(d)).map(x => [x.type, x.value])); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - d; };
  return new Date(asUtc - off(asUtc)).toISOString();
}
async function hkForMeeting(meetId: string, meetDate: string, venue: string, nRaces: number): Promise<any | null> {
  const { data: row } = await sb.from("kyw_ra").select("*").eq("meet_id", meetId).maybeSingle();
  // Only a row written by this function counts (its key starts "HKJC"); an older Free Fields miss under the same meeting id must not hold up the fetch.
  if (row && String(row.date) === meetDate && String(row.key ?? "").startsWith("HKJC")) { if (row.status === "ok") return row.data; if (Date.now() - Date.parse(row.fetched_at) < 2 * 3600e3) return null; }
  let status = "miss", data: any = null;
  try {
    const slash = meetDate.replace(/-/g, "/"); const cards: Record<number, any[]> = {}; const times: Record<number, string> = {}; const hIds = new Set<string>(), jIds = new Set<string>(), tIds = new Set<string>();
    for (let n = 1; n <= nRaces; n++) {
      const html = await hkGet(`/racing/information/English/Racing/RaceCard.aspx?RaceDate=${slash}&Racecourse=${venue}&RaceNo=${n}`); if (!html) continue;
      const info = parseRaceInfo(html, meetDate); if (info?.timeUtc) times[n] = info.timeUtc;
      const rs = parseRaceCard(html); if (!rs.length) continue; cards[n] = rs; for (const x of rs) { hIds.add(x.horseId); if (x.jockeyId) jIds.add(x.jockeyId); if (x.trainerId) tIds.add(x.trainerId); }
    }
    if (!Object.keys(cards).length) throw new Error("no HKJC racecards for " + meetDate + " " + venue);
    const horses: Record<string, any> = {};
    await pool([...hIds], 10, async (id) => { const html = await hkGet(`/racing/information/English/Horse/Horse.aspx?HorseId=${id}`); horses[id] = html ? parseHorse(html) : null; });
    const rate = async (kind: "jockey" | "trainer", id: string) => { let w = 0, r = 0; for (const season of ["Current", "Previous"]) { const html = await hkGet(`/en-us/local/information/${kind}winstat?${kind}id=${id}&season=${season}`); const st = html ? parseStats(html) : null; if (st) { w += st.wins; r += st.rides; } } return r >= 40 ? +(100 * w / r).toFixed(1) : null; };
    const jp: Record<string, number | null> = {}, tp: Record<string, number | null> = {};
    await pool([...jIds], 10, async (id) => { jp[id] = await rate("jockey", id); }); await pool([...tIds], 10, async (id) => { tp[id] = await rate("trainer", id); });
    const races: Record<number, Record<number, any>> = {};
    for (const [n, rs] of Object.entries(cards)) { races[+n] = {}; for (const x of rs) { const h = horses[x.horseId];
      races[+n][x.no] = { name: x.name, horseId: x.horseId, draw: x.draw, rec: h?.rec ?? null, rtg: x.rating, jp: x.jockeyId ? jp[x.jockeyId] ?? null : null, tp: x.trainerId ? tp[x.trainerId] ?? null : null,
        runs: (h?.runs ?? []).filter((q: any) => q.pos != null).slice(0, 10).map((q: any) => ({ d: q.date, p: q.pos, c: q.cls, m: q.pos === 1 ? 0 : q.margin, v: q.venue, dist: q.dist, sp: q.sp })) }; } }
    data = { source: "hkjc", venue, times, races, fetched: { cards: Object.keys(cards).length, horses: hIds.size, noHorsePage: Object.values(horses).filter(h => !h).length } }; status = "ok";
  } catch (e) { data = { error: String(e).slice(0, 200) }; }
  await sb.from("kyw_ra").upsert({ meet_id: meetId, key: `HKJC,${meetDate},${venue}`, date: meetDate, fetched_at: new Date().toISOString(), status, data });
  return status === "ok" ? data : null;
}
// racing.com files Hong Kong results under Sydney dates, so a race that jumps after Sydney midnight (the back half of a Happy Valley card) never gets a result there.
// The finishing order comes from the HKJC results page instead: saddle numbers in finishing order, or null until at least three finishers are listed.
async function hkResults(date: string, venue: string, raceNo: number): Promise<number[] | null> {
  const html = await hkGet(`/racing/information/English/Racing/LocalResults.aspx?RaceDate=${date.replace(/-/g, "/")}&Racecourse=${venue}&RaceNo=${raceNo}`); if (!html) return null;
  const rows = parseResults(html).filter((x: any) => x.place != null && x.no != null).sort((a: any, b: any) => a.place - b.place);
  return rows.length >= 3 ? rows.map((x: any) => x.no as number) : null;
}
const hkWithBudget = (p: Promise<any | null>) => Promise.race([p, new Promise<null>(res => setTimeout(() => res(null), 80000))]);
// HKJC's own stored query for pool odds. The endpoint answers only this exact text (WHITELIST_ERROR otherwise), so it is kept verbatim.
const HK_ODDS_Q = `
      query racing($date: String, $venueCode: String, $oddsTypes: [OddsType], $raceNo: Int) {
          raceMeetings(date: $date, venueCode: $venueCode)
          {
            pmPools(oddsTypes: $oddsTypes, raceNo: $raceNo) {
              id
              status
              sellStatus
              oddsType
              lastUpdateTime
              guarantee
              minTicketCost
              name_en
              name_ch
              leg {
                number
                races
              }
              cWinSelections {
                composite
                name_ch
                name_en
                starters
              }
              oddsNodes {
                combString
                oddsValue
                hotFavourite
                oddsDropValue
                bankerOdds {
                  combString
                  oddsValue
                }
              }
            }
          }
      }
`;
async function hkTote(date: string, venue: string, raceNo: number): Promise<{ map: Record<number, number>; status: string | null; updated: string | null } | null> {
  try {
    const res = await fetch("https://info.cld.hkjc.com/graphql/base/", { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json", "Origin": "https://bet.hkjc.com", "Referer": "https://bet.hkjc.com/", "User-Agent": RA_HEADERS["User-Agent"] },
      body: JSON.stringify({ operationName: "racing", query: HK_ODDS_Q, variables: { date, venueCode: venue, oddsTypes: ["WIN"], raceNo } }) });
    const j = await res.json(); if (j.errors) { console.error("hkTote", JSON.stringify(j.errors).slice(0, 200)); return null; }
    const p = (j.data?.raceMeetings?.[0]?.pmPools ?? []).find((x: any) => x.oddsType === "WIN"); if (!p) return null;
    return { map: toteMap(p.oddsNodes), status: p.sellStatus ?? p.status ?? null, updated: p.lastUpdateTime ?? null };
  } catch (e) { console.error("hkTote", e); return null; }
}
// Once a minute while a Hong Kong meeting is in its tote window (the job is only scheduled on Hong Kong race days, for race hours: see kyw_arm_jobs): refresh each unrun race's tote prices (every 5 minutes, every minute inside 5 minutes of the jump) and take the rating's late price at 5 minutes.
async function hkOddsTick(): Promise<any[]> {
  const out: any[] = []; const now = Date.now(); const minute = Math.floor(now / 60000);
  const { data: feeds } = await sb.from("kyw_feed").select("meet_id,name").eq("active", true).like("meet_id", "HK%");
  for (const f of feeds ?? []) {
    const { data: row } = await sb.from("kyw_meeting").select("id,data").eq("id", f.meet_id).maybeSingle(); const m = row?.data; if (!m?.races?.length) continue;
    const venue = hkVenue(String(f.meet_id), String(m.venue || f.name || "")); if (!venue) continue; const date = String(m.date).slice(0, 10);
    const tms = m.races.map((r: any) => Date.parse(r.time)).filter((t: number) => !isNaN(t)); if (!tms.length || !toteOn(Math.min(...tms), now)) { out.push({ meetId: f.meet_id, skipped: "before the tote window" }); continue; }
    const { data: prow } = await sb.from("kyw_prices").select("data").eq("meet_id", f.meet_id).maybeSingle(); const races: Record<string, any> = { ...(prow?.data?.races ?? {}) };
    let wrote = false, changed = false; const log: any = { meetId: f.meet_id, read: [] as number[], none: [] as number[] };
    for (const r of m.races) {
      if (r.feedResult || r.frozenAt) continue; const mins = (Date.parse(r.time) - now) / 60000; if (isNaN(mins) || mins < -2) continue;
      if (mins > 5.5 && minute % 5 !== 0) continue;
      const tt = await hkTote(date, venue, r.no); if (!tt || !Object.keys(tt.map).length) { log.none.push(r.no);
        if (mins <= 2 && !r.lateAt) { r.lateAt = new Date().toISOString(); r.priceSource = "fixed"; for (const x of r.runners ?? []) x.lateOdds = x.odds ?? null; changed = true; } continue; }
      races[r.no] = { ...(races[r.no] ?? {}), ...tt.map }; wrote = true; log.read.push(r.no);
      if (mins <= 5 && !r.lateAt) { r.lateAt = new Date().toISOString(); r.priceSource = "tote"; for (const x of r.runners ?? []) x.lateOdds = tt.map[x.no] ?? x.odds ?? null; changed = true; }
    }
    if (wrote) await sb.from("kyw_prices").upsert({ meet_id: f.meet_id, data: { at: new Date().toISOString(), races }, updated_at: new Date().toISOString() });
    if (changed) { m.syncedAt = new Date().toISOString(); m.updatedAt = Date.now(); await sb.from("kyw_meeting").upsert({ id: f.meet_id, data: m, updated_at: new Date().toISOString() }); }
    out.push({ ...log, lateSet: changed }); }
  if (out.some(o => o.lateSet || o.none?.length)) await sb.from("kyw_feed_log").insert({ summary: { hkodds: out } });
  return out;
}

async function syncMeeting(feed: any, existing: any | null, force: boolean, live: any = null) {
  const meetId = String(feed.meet_id);
  const d = await gql(`{ m: getMeeting(id:"${meetId}"){ id date meetingName venueName state trackCondition trackRating railPosition weather racesCount status }
    races: getRacesForMeet(meetCode:"${meetId}"){ ${RACE_FIELDS} } }`);
  const m = d.m ?? {}; const races: any[] = (d.races ?? []).sort((a: any, b: any) => a.raceNumber - b.raceNumber);
  const meetDate = m.date ?? feed.date; const now = Date.now();
  const stored: any = existing?.data ?? null; const storedRaces: Record<number, any> = {}; for (const r of stored?.races ?? []) storedRaces[r.no] = r;
  const outRaces: any[] = []; const results: any[] = []; let fetched = 0;
  const isHK = isHKMeet(meetId, m.state); const hkv = isHK ? hkVenue(meetId, String(m.venueName ?? feed.name ?? "")) : null; const dateOnly = String(meetDate).slice(0, 10);
  let ra: any = null; if (!isHK) { try { ra = await raForMeeting(meetId, String(meetDate), String(m.state ?? ""), String(m.venueName ?? "")); } catch (e) { console.error("ra", e); } }
  const trials = raTrialDates(ra);
  let hkd: any = null; if (isHK && hkv) { try { hkd = await hkWithBudget(hkForMeeting(meetId, dateOnly, hkv, races.length)); } catch (e) { console.error("hk", e); } }
  const rtime = (r: any): string | null => !r.time ? null : isHK ? (hkd?.times?.[r.raceNumber] ?? sydneyClockToUtc(r.time)) : r.time;
  const firstRaceMs = Math.min(...races.map((r: any) => rtime(r) ? Date.parse(rtime(r)!) : NaN).filter((t: number) => !isNaN(t)));
  // Inside the tote window the per-minute odds job (hkOddsTick) owns Hong Kong prices and the late price; this sync leaves both alone.
  const toteNow = !!(isHK && hkv && toteOn(firstRaceMs, now));
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
      const runners = entries.map((e: any) => mapEntry(e, meetDate, fr.class ?? r.class, trials[nameKey(e.horseName ?? e.horse?.name)], hkd?.races?.[no]?.[e.raceEntryNumber])).sort((a: any, b: any) => a.no - b.no);
      // The tote prices the odds job last stored, so a field frozen at the result still carries tote prices.
      if (toteNow && !finished) { const tp = live?.races?.[no]; if (tp) for (const x of runners) if (tp[x.no] != null) x.odds = tp[x.no]; }
      const order = runners.filter((x: any) => x.finish && x.finish > 0 && x.finish < 100).sort((a: any, b: any) => a.finish - b.finish).map((x: any) => x.no);
      let positions = order.length ? order : (finished && fr.resultsString ? String(fr.resultsString).split(/[^0-9]+/).filter(Boolean).map(Number) : []);
      if (isHK && hkv && positions.length < 3 && rtime(r) && (now - Date.parse(rtime(r)!)) / 60000 >= 8) { const hp = await hkResults(dateOnly, hkv, no); if (hp) positions = hp; }
      // The field the app judges a run race by is the last one read before the result: pre-race prices and scratchings, never post-race data.
      // Opening price: the first price seen for the runner today. Kept across re-reads so the tip has a fixed market to work from; the live price keeps moving alongside it.
      const prevByNo: Record<number, any> = {}; for (const x of prev?.runners ?? []) prevByNo[x.no] = x;
      // Late market: one refresh of the rating's market about 20 minutes before the jump, taken on the first read inside that window and then held.
      const t = rtime(r) ? Date.parse(rtime(r)!) : null; const minsTo = t != null ? (t - now) / 60000 : null;
      const lateAt: string | undefined = prev?.lateAt ?? ((!isHK && minsTo != null && minsTo <= 20 && minsTo > -60) ? new Date().toISOString() : undefined);
      const freshRunners = runners.map(({ finish, ...rest }: any) => ({ ...rest,
        openOdds: prevByNo[rest.no]?.openOdds ?? prevByNo[rest.no]?.odds ?? rest.odds ?? null,
        lateOdds: prev?.lateAt ? (prevByNo[rest.no]?.lateOdds ?? null) : (lateAt ? (rest.odds ?? null) : undefined) }));
      const frozen = (prev?.frozenAt && prev?.runners?.length) ? prev.runners : (positions.length >= 3 && prev?.runners?.length && !prevHasResult ? prev.runners : null);
      race = { no, name: fr.name ?? "", distance: num(fr.distance), class: fr.class ?? "", time: (isHK ? rtime(r) : fr.time) ?? null, ...(isHK ? { priceSource: toteNow ? "tote" : "fixed" } : {}), raceStatus: fr.raceStatus ?? "", condition: [fr.trackCondition, fr.trackRating].filter(Boolean).join(" "), prizemoney: fr.totalPrizeMoney ?? null, meetingId: meetId,
        runners: frozen ? frozen.map(({ ra, ...x }: any) => x) : freshRunners, frozenAt: frozen ? (prev.frozenAt ?? prev.syncedAt) : undefined, lateAt: frozen ? prev?.lateAt : lateAt, lockOverride: prev?.lockOverride, feedResult: positions.length >= 3 ? { positions, at: prev?.feedResult?.at ?? new Date().toISOString() } : null, syncedAt: new Date().toISOString() };
    } else { race = { ...prev, raceStatus: r.raceStatus ?? prev.raceStatus }; }
    outRaces.push(race);
    if (race.feedResult) results.push({ meeting_id: meetId, race_no: no, positions: race.feedResult.positions, entered_by: "racing.com feed", entered_at: race.feedResult.at });
  }
  const meeting = { id: meetId, meeting: feed.name ?? m.venueName ?? m.meetingName, venue: m.venueName ?? "", state: m.state ?? "", date: meetDate, condition: [m.trackCondition, m.trackRating].filter(Boolean).join(" ") || (stored?.condition ?? "Good 4"), rail: m.railPosition ?? "", weather: m.weather ?? "", status: m.status ?? "", sort: feed.sort ?? 99,
    races: outRaces, source: "racing.com", raKey: ra?.key ?? stored?.raKey ?? null, syncedAt: stored?.syncedAt ?? new Date().toISOString(), updatedAt: stored?.updatedAt ?? Date.now() };
  // Write only when something other than the timestamps differs.
  // Postgres returns jsonb with its own key order, so compare a key-sorted rendering.
  const canon = (v: any): string => Array.isArray(v) ? "[" + v.map(canon).join(",") + "]" : (v && typeof v === "object") ? "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}" : JSON.stringify(v ?? null);
  // Live prices change every read, so they live in kyw_prices (a few kB) and are left out of the meeting's change signature.
  // A race's runners keep the odds they carried at the last meeting write; frozen (pre-result) fields therefore hold their pre-jump prices.
  const prices: Record<string, Record<string, number | null>> = {};
  for (const r of outRaces) { if (r.frozenAt) continue; prices[r.no] = {}; for (const x of r.runners ?? []) prices[r.no][x.no] = x.odds ?? null; }
  const sig = (x: any) => canon({ ...x, syncedAt: 0, updatedAt: 0, races: (x.races ?? []).map((r: any) => ({ ...r, syncedAt: 0, feedResult: r.feedResult ? { positions: r.feedResult.positions } : null, runners: r.frozenAt ? r.runners : (r.runners ?? []).map((q: any) => ({ ...q, odds: null })) })) });
  const changed = !stored || sig(meeting) !== sig(stored);
  if (changed) { meeting.syncedAt = new Date().toISOString(); meeting.updatedAt = Date.now(); const { error } = await sb.from("kyw_meeting").upsert({ id: meetId, data: meeting, updated_at: new Date().toISOString() }); if (error) throw error; }
  if (Object.keys(prices).length && !toteNow) { const { error: e3 } = await sb.from("kyw_prices").upsert({ meet_id: meetId, data: { at: new Date().toISOString(), races: prices }, updated_at: new Date().toISOString() }); if (e3) throw e3; }
  const newResults = results.filter(r => !(storedRaces[r.race_no]?.feedResult));
  if (newResults.length) { const { error: e2 } = await sb.from("kyw_results").upsert(newResults, { onConflict: "meeting_id,race_no", ignoreDuplicates: true }); if (e2) throw e2; }
  // Keep the feed row's race window current so the scheduler knows when to run.
  const times = races.map((r: any) => rtime(r) ? Date.parse(rtime(r)!) : NaN).filter((t: number) => !isNaN(t));
  if (times.length) { const first = new Date(Math.min(...times)).toISOString(), last = new Date(Math.max(...times)).toISOString();
    const same = (a: any, b: string) => a && Date.parse(a) === Date.parse(b);
    if (!same(feed.first_at, first) || !same(feed.last_at, last)) await sb.from("kyw_feed").update({ first_at: first, last_at: last }).eq("meet_id", meetId); }
  return { meetId, name: meeting.meeting, races: outRaces.length, fetched, changed, results: newResults.length, ...(isHK ? { hk: { form: !!hkd, times: hkd ? Object.keys(hkd.times ?? {}).length : 0, toteNow } } : {}) };
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
    picks.push({ meet_id: String(m.id), name: hit[1], state: hit[2], venue: slug, date, sort: STATE_ORDER[hit[2]] ?? 9 }); taken.add(hit[2]); }
  for (const st of TOP_STATES) { if (taken.has(st)) continue; const cands = all.filter((m: any) => m.state === st); if (!cands.length) continue;
    let best: any = null, bestPrize = -1;
    for (const c of cands) { let prize = 0; try { const r = await gql(`{ races: getRacesForMeet(meetCode:"${c.id}"){ totalPrizeMoney } }`); prize = (r.races ?? []).reduce((a: number, x: any) => a + (num(x.totalPrizeMoney) ?? 0), 0); } catch { prize = 0; }
      if (prize > bestPrize) { bestPrize = prize; best = c; } }
    if (best) { const slug = String(best.venueName ?? "").toLowerCase(); const hit = METRO.find(([re]) => re.test(slug)); picks.push({ meet_id: String(best.id), name: hit ? hit[1] : prettyVenue(slug), state: st, venue: slug, date, sort: STATE_ORDER[st] ?? 9 }); taken.add(st); } }
  if (hkDay) for (const m of all) { if (m.state !== "HK") continue; const slug = String(m.venueName ?? "").toLowerCase(); const hit = HK_VENUES.find(([re]) => re.test(slug));
    picks.push({ meet_id: String(m.id), name: hit ? hit[1] : prettyVenue(slug), state: "HK", venue: slug, date, sort: STATE_ORDER.HK }); }
  return picks;
}

// A feed write that must land: retried twice, 5 and 10 seconds apart, then thrown so the roll stops before anything is cleaned up.
async function must<T>(label: string, f: () => PromiseLike<{ data: T; error: any }>): Promise<T> {
  for (let i = 0; ; i++) { const { data, error } = await f(); if (!error) return data; if (i >= 2) throw new Error(`${label}: ${error.message ?? error}`); await new Promise(r => setTimeout(r, 5000 * (i + 1))); }
}
// Once a day: point the feed at today's meetings, drop yesterday's, trim the log.
async function dailyRoll(): Promise<{ date: string; picks: any[]; archived: any[] }> {
  const date = aestDate(0);
  const picks = await selectMeetings(date);
  // Archive the meetings we followed, as the form stood that morning and priced at SP, so any weights can be tested against them later.
  const archived: any[] = [];
  const oldFeeds: any[] = await must("feed read", () => sb.from("kyw_feed").select("meet_id,name,date").eq("active", true));
  for (const f of oldFeeds ?? []) { if (String(f.date) >= date) continue; try { archived.push(await backtest(String(f.meet_id))); } catch (e) { archived.push({ meetId: f.meet_id, error: String(e).slice(0, 200) }); } }
  if (picks.length) {
    // Today's meetings go in before yesterday's come out, so a failed write leaves the old feed running and nothing deleted.
    await must("feed upsert", () => sb.from("kyw_feed").upsert(picks.map(({ state, venue, ...f }) => ({ ...f, active: true, first_at: null, last_at: null })), { onConflict: "meet_id" }));
    await must("feed retire", () => sb.from("kyw_feed").update({ active: false }).eq("active", true).not("meet_id", "in", `(${picks.map(p => JSON.stringify(String(p.meet_id))).join(",")})`));
    // Read the day's Free Fields form once, now, so the first sync carries it.
    for (const p of picks) { if (isHKMeet(String(p.meet_id), p.state)) continue; try { await raForMeeting(p.meet_id, date, p.state, p.venue); } catch (e) { console.error("ra roll", e); } }
    const keep = picks.map(f => f.meet_id);
    const { data: olds } = await sb.from("kyw_meeting").select("id"); for (const o of olds ?? []) { if (!keep.includes(String(o.id))) { await sb.from("kyw_meeting").delete().eq("id", o.id); await sb.from("kyw_results").delete().eq("meeting_id", o.id); await sb.from("kyw_prices").delete().eq("meet_id", o.id); } }
    await sb.from("kyw_ra").delete().lt("date", aestDate(-7));
    await sb.from("kyw_feed").delete().eq("active", false).lt("date", aestDate(-14));
  }
  await sb.from("kyw_feed_log").delete().lt("at", new Date(Date.now() - 7 * 86400000).toISOString());
  return { date, picks, archived };
}

// Backtest: a finished meeting, mapped as the app would have seen it that morning (runs on or after the day excluded), priced at SP, with results.
async function backtest(meetId: string) {
  const d = await gql(`{ m: getMeeting(id:"${meetId}"){ id date meetingName venueName state trackCondition trackRating } races: getRacesForMeet(meetCode:"${meetId}"){ ${RACE_FIELDS} } }`);
  const m = d.m ?? {}; const meetDate = m.date;
  // Hong Kong: the HKJC form cached on the morning of the meeting, so the archive holds the form as it stood before the race.
  const hkv = isHKMeet(meetId, m.state) ? hkVenue(meetId, String(m.venueName ?? "")) : null;
  let hkd: any = null; if (isHKMeet(meetId, m.state)) { const { data: hrow } = await sb.from("kyw_ra").select("status,data").eq("meet_id", meetId).maybeSingle(); if (hrow?.status === "ok" && hrow.data?.source === "hkjc") hkd = hrow.data; }
  const out: any[] = await Promise.all((d.races ?? []).sort((a: any, b: any) => a.raceNumber - b.raceNumber).map(async (r: any) => {
    const fd = await gql(FORM_QUERY(meetId, r.raceNumber)); const fr = fd.r ?? r;
    const entries = mergeEntries(fr.raceEntries, fr.formRaceEntries);
    const cond = String(fr.trackCondition ?? "").toLowerCase(); const catKey = cond.startsWith("h") ? "heavy" : (cond.startsWith("so") || cond.startsWith("sy")) ? "soft" : "good";
    const unrun = (rec: any, fin: number | null) => { if (!rec || !fin || fin > 100) return rec; const [s, w, p] = rec; return [Math.max(0, s - 1), Math.max(0, w - (fin === 1 ? 1 : 0)), Math.max(0, p - (fin === 2 || fin === 3 ? 1 : 0))]; };
    const hkOf = (no: number) => hkd?.races?.[r.raceNumber]?.[no];
    const runners = entries.map((e: any) => ({ x: mapEntry(e, meetDate, fr.class ?? r.class, undefined, hkOf(e.raceEntryNumber)), hk: !!hkOf(e.raceEntryNumber) })).map(({ x, hk }: any) => ({ ...x, odds: x.sp ?? x.odds, rating: null,
      career: hk ? x.career : unrun(x.career, x.finish), track: unrun(x.track, x.finish), distance: unrun(x.distance, x.finish), trackDistance: unrun(x.trackDistance, x.finish), barrierRec: unrun(x.barrierRec, x.finish), [catKey]: unrun(x[catKey], x.finish) })).sort((a: any, b: any) => a.no - b.no);
    let positions = runners.filter((x: any) => x.finish && x.finish > 0 && x.finish < 100).sort((a: any, b: any) => a.finish - b.finish).map((x: any) => x.no);
    if (hkv && positions.length < 3) { const hp = await hkResults(String(meetDate).slice(0, 10), hkv, r.raceNumber); if (hp) positions = hp; }
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
  if (url.searchParams.get("hkodds") === "1") { try { return new Response(JSON.stringify({ ok: true, at: new Date().toISOString(), hk: await hkOddsTick() }), { headers: { "Content-Type": "application/json", ...CORS } }); } catch (e) { return new Response(JSON.stringify({ error: String(e).slice(0, 300) }), { status: 500, headers: { "Content-Type": "application/json", ...CORS } }); } }
  const force = url.searchParams.get("force") === "1";
  const only = url.searchParams.get("meet");
  const raq = url.searchParams.get("ra");
  if (raq) { try { const d = await gql(`{ m: getMeeting(id:"${raq}"){ id date venueName state } }`); if (force) await sb.from("kyw_ra").delete().eq("meet_id", raq);
      const ra = await raForMeeting(raq, String(d.m?.date ?? ""), String(d.m?.state ?? ""), String(d.m?.venueName ?? ""));
      const { data: row } = await sb.from("kyw_ra").select("status,key,fetched_at,data").eq("meet_id", raq).maybeSingle();
      const names = Object.keys(ra?.runners ?? {}); const first = names[0] ? ra.runners[names[0]] : null;
      return new Response(JSON.stringify({ meet: d.m, status: row?.status, key: row?.key, error: row?.data?.error, runners: names.length, condition: ra?.condition, rail: ra?.rail, sample: first ? { name: names[0], runs: first.runs.length, gear: first.gear, rec: first.rec.career, firstRun: first.runs[0] } : null }), { headers: { "Content-Type": "application/json", ...CORS } }); }
    catch (e) { return new Response(JSON.stringify({ error: String(e).slice(0, 400) }), { status: 500, headers: { "Content-Type": "application/json", ...CORS } }); } }
  const bt = url.searchParams.get("backtest"); const btd = url.searchParams.get("backtestdate");
  if (btd) { try { const r = await backtestDate(btd); return new Response(JSON.stringify(r), { headers: { "Content-Type": "application/json", ...CORS } }); } catch (e) { return new Response(JSON.stringify({ error: String(e).slice(0, 400) }), { status: 500, headers: { "Content-Type": "application/json", ...CORS } }); } }
  if (bt) { try { const r = await backtest(bt); return new Response(JSON.stringify(r), { headers: { "Content-Type": "application/json", ...CORS } }); } catch (e) { return new Response(JSON.stringify({ error: String(e).slice(0, 400) }), { status: 500, headers: { "Content-Type": "application/json", ...CORS } }); } }
  const daily = url.searchParams.get("daily") === "1";
  let rolled: any = null; if (daily) { try { rolled = await dailyRoll(); } catch (e) { console.error("dailyRoll", e); rolled = { error: String(e).slice(0, 200) }; } }
  const { data: feeds, error } = await sb.from("kyw_feed").select("*").eq("active", true).order("sort");
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { "Content-Type": "application/json", ...CORS } });
  const { data: existingRows } = await sb.from("kyw_meeting").select("id,data");
  const existing: Record<string, any> = {}; for (const r of existingRows ?? []) existing[r.id] = r;
  const { data: priceRows } = await sb.from("kyw_prices").select("meet_id,data").like("meet_id", "HK%");
  const live: Record<string, any> = {}; for (const r of priceRows ?? []) live[r.meet_id] = r.data;
  const out: any[] = [];
  const todo = (feeds ?? []).filter((f: any) => !only || String(f.meet_id) === only);
  const one = async (f: any) => { try { return await syncMeeting(f, existing[String(f.meet_id)] ?? null, force || daily, live[String(f.meet_id)] ?? null); } catch (e) { return { meetId: f.meet_id, error: String(e).slice(0, 300) }; } };
  if (daily || force) out.push(...await Promise.all(todo.map(one))); else for (const f of todo) out.push(await one(f));
  if (daily || out.some(o => o.error || o.changed || o.fetched)) await sb.from("kyw_feed_log").insert({ summary: { rolled, meetings: out } });
  return new Response(JSON.stringify({ ok: true, at: new Date().toISOString(), rolled, meetings: out }), { headers: { "Content-Type": "application/json", ...CORS } });
});
