// Kai Ying Winning edge hunt: one row per runner per race, from racing.com, for every TAB meeting on a date.
// ?date=YYYY-MM-DD pulls that date; &states=VIC,HK restricts to those states. ?next=1 works kyw_runs_queue newest-first until the time budget (?budget= ms, default 60000) is spent.
// Nothing here touches the live feed tables.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const GQL = "https://graphql.rmdprod.racing.com/";
const GQL_KEY = "da2-6nsi4ztsynar3l3frgxf77q5fe";
const FLOCK = Deno.env.get("KYW_FLOCK_CODE") ?? "pelicans-2026";
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function gql(query: string, tries = 3): Promise<any> {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(GQL, { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": GQL_KEY, "User-Agent": "Mozilla/5.0" }, body: JSON.stringify({ query }) });
      if (res.status === 403 || res.status === 429) { if (i >= tries - 1) throw new Error(`Throttled ${res.status}`); await new Promise(r => setTimeout(r, 20000 * (i + 1))); continue; }
      if (!res.ok) throw new Error(`racing.com ${res.status}`);
      const j = await res.json();
      if (j.errors && !j.data) throw new Error(JSON.stringify(j.errors).slice(0, 300));
      return j.data;
    } catch (e) { if (i >= tries - 1) throw e; await new Promise(r => setTimeout(r, 800 * (i + 1))); }
  }
}

const num = (v: any): number | null => { if (v == null || v === "") return null; const n = parseFloat(String(v).replace(/[$,kgL]/g, "")); return Number.isFinite(n) ? n : null; };
const price = (v: any): number | null => { const n = num(v); return n != null && n > 1 ? n : null; };

const RACE_Q = (meet: string, no: number) => `{ r: getRaceForm(meetCode:"${meet}", raceNumber:${no}){ id raceNumber name distance class trackCondition trackRating fieldCount hasSectionals timingSource time totalPrizeMoney
  raceEntries { raceEntryNumber barrierNumber liveBarrierNumber weight weightCarried weightPrevious scratched isLateScratching emergency finish margin beatenMargin horseName horseCode jockeyName jockeyCode trainerName trainerCode gearChanges gearHasChanges jockeyChanged handicapRating lastRaceDate startingPrice bettingFluctuationsPriceOpen bettingFluctuationsPriceMoveOne bettingFluctuationsPriceMoveTwo speedValue positionAtSettled positionAt800 positionAt400 prizeMoney
    horse { age sex } jockey { apprentice weightClaim } timing { finishTimeSeconds sixHundredMetresTime twoHundredMetresTime timeVarToWinner distanceTravelled } } } }`;

function mapRace(m: any, r: any) {
  const sect = !!r.hasSectionals;
  // racing.com can list a saddlecloth twice (an emergency and a scratching); keep the entry that ran, else the last seen.
  const byNo = new Map<number, any>();
  for (const e of r.raceEntries ?? []) { if (!e || e.raceEntryNumber == null) continue; const cur = byNo.get(e.raceEntryNumber); if (!cur || (e.finish && e.finish < 100) || !(cur.finish && cur.finish < 100)) byNo.set(e.raceEntryNumber, e); }
  return [...byNo.values()].map((e: any) => ({
    race_id: String(r.id), no: e.raceEntryNumber, meet_id: String(m.id), date: m.date, venue: m.venueName ?? "", state: m.state ?? "", category: m.category ?? null, meet_quality: m.meetQuality ?? null, rail: m.railPosition ?? null,
    race_no: r.raceNumber, race_name: r.name ?? null, distance: num(r.distance), class: r.class ?? null, condition: r.trackCondition ?? null, rating: r.trackRating ?? null, field_count: r.fieldCount ?? null, prize: num(r.totalPrizeMoney), race_time: r.time ?? null,
    horse_code: String(e.horseCode ?? ""), horse: e.horseName ?? "", age: num(e.horse?.age), sex: e.horse?.sex ? String(e.horse.sex)[0] : null,
    barrier: e.liveBarrierNumber || e.barrierNumber || null, weight: num(e.weightCarried ?? e.weight), weight_prev: num(e.weightPrevious),
    jockey: e.jockeyName ?? null, jockey_code: e.jockeyCode ?? null, trainer: e.trainerName ?? null, trainer_code: e.trainerCode ?? null, apprentice: !!e.jockey?.apprentice, claim: num(e.jockey?.weightClaim),
    scratched: !!(e.scratched || e.isLateScratching || e.finish === 109), emergency: !!e.emergency, jockey_changed: !!e.jockeyChanged, gear_changed: !!e.gearHasChanges, gear: e.gearChanges ?? null,
    hcp_rating: e.handicapRating ?? null, last_race_date: e.lastRaceDate ?? null,
    finish: (e.finish && e.finish > 0 && e.finish < 100) ? e.finish : null, margin: num(e.beatenMargin ?? e.margin),
    sp: price(e.startingPrice), open: price(e.bettingFluctuationsPriceOpen), move1: price(e.bettingFluctuationsPriceMoveOne), move2: price(e.bettingFluctuationsPriceMoveTwo),
    pos_settled: e.positionAtSettled ?? null, pos_800: e.positionAt800 ?? null, pos_400: e.positionAt400 ?? null, speed_value: num(e.speedValue),
    time_s: sect && e.timing?.finishTimeSeconds ? e.timing.finishTimeSeconds / 100 : null, last_600: sect ? num(e.timing?.sixHundredMetresTime) : null, last_200: sect ? num(e.timing?.twoHundredMetresTime) : null, var_to_winner: sect ? (e.timing?.timeVarToWinner ?? null) : null, dist_travelled: sect ? (e.timing?.distanceTravelled ?? null) : null,
    prize_won: num(e.prizeMoney),
  }));
}

async function pullDate(date: string, states: Set<string> | null) {
  const d = await gql(`{ m: GetMeetingByDate(date:"${date}"){ id date venueName state isTab isTrial isJumpOut isPicnic category meetQuality railPosition } }`);
  const meets = (d.m ?? []).filter((m: any) => m.isTab === 1 && !m.isTrial && !m.isJumpOut && !m.isPicnic && (!states || states.has(String(m.state ?? "").toUpperCase())));
  const out: any[] = []; let rows = 0; let races = 0;
  // Gentle: one meeting at a time, four races at a time with a pause. racing.com returns 403 when hammered.
  const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
  for (const m of meets) {
    try {
      const rd = await gql(`{ races: getRacesForMeet(meetCode:"${m.id}"){ raceNumber } }`);
      const nos: number[] = (rd.races ?? []).map((r: any) => r.raceNumber).filter((n: any) => n != null);
      const all: any[] = [];
      for (let k = 0; k < nos.length; k += 4) {
        const part = await Promise.all(nos.slice(k, k + 4).map(async (n) => { const x = await gql(RACE_Q(String(m.id), n)); return mapRace({ ...m, date: m.date ?? date }, x.r ?? {}); }));
        all.push(...part.flat()); await pause(1200);
      }
      races += nos.length;
      for (let j = 0; j < all.length; j += 500) { const { error } = await sb.from("kyw_runs").upsert(all.slice(j, j + 500), { onConflict: "race_id,no" }); if (error) throw new Error(error.message); }
      rows += all.length; out.push({ meet: m.venueName, state: m.state, races: nos.length, rows: all.length });
    } catch (e) { const msg = String(e); out.push({ meet: m.venueName, error: msg.slice(0, 200) }); if (msg.includes("Throttled")) throw e; }
    await pause(800);
  }
  return { date, meetings: meets.length, races, rows, detail: out };
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if ((req.headers.get("x-flock-code") ?? url.searchParams.get("code")) !== FLOCK) return new Response("no", { status: 401 });
  const t0 = Date.now();
  const json = (b: any, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
  try {
    const st = url.searchParams.get("states"); const states = st ? new Set(st.split(",").map(x => x.trim().toUpperCase()).filter(Boolean)) : null;
    const date = url.searchParams.get("date");
    if (date) return json({ ...(await pullDate(date, states)), ms: Date.now() - t0 });
    if (!url.searchParams.get("next")) return json({ error: "date? or next=1" }, 400);
    // Work the queue, newest date first, until the time budget is spent (Edge wall clock is limited; a date can run past the budget by one date's length).
    const budget = Math.min(90000, +(url.searchParams.get("budget") ?? 60000));
    const done: any[] = [];
    while (Date.now() - t0 < budget) {
      const { data } = await sb.from("kyw_runs_queue").select("date").eq("status", "pending").order("date", { ascending: false }).limit(1);
      if (!data?.length) { done.push({ queueEmpty: true }); break; }
      const d = String(data[0].date);
      await sb.from("kyw_runs_queue").update({ status: "running", started_at: new Date().toISOString() }).eq("date", d);
      const t1 = Date.now();
      try {
        const r = await pullDate(d, states);
        const errors = r.detail.filter((x: any) => x.error).length;
        await sb.from("kyw_runs_queue").update({ status: errors ? "partial" : "done", finished_at: new Date().toISOString(), meetings: r.meetings, races: r.races, rows: r.rows, errors, ms: Date.now() - t1 }).eq("date", d);
        done.push({ date: d, meetings: r.meetings, races: r.races, rows: r.rows, errors, ms: Date.now() - t1 });
      } catch (e) {
        const throttled = String(e).includes("Throttled");
        await sb.from("kyw_runs_queue").update({ status: throttled ? "pending" : "failed", finished_at: new Date().toISOString(), errors: 1, ms: Date.now() - t1 }).eq("date", d);
        done.push({ date: d, error: String(e).slice(0, 200) });
        if (throttled) break;
      }
    }
    return json({ done, ms: Date.now() - t0 });
  } catch (e) {
    return json({ error: String(e).slice(0, 400), ms: Date.now() - t0 }, 500);
  }
});
