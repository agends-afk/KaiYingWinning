// Hong Kong season backfill for the model's regression work: HKJC results pages for every Sha Tin and Happy Valley meeting in a date range,
// and the horse page of every runner seen, stored raw-parsed in kyw_hk_race and kyw_hk_horse. Form as it stood before a race is rebuilt later
// from each horse's run lines dated before it. Driven by a temporary pg_cron job; kept apart from kyw-sync so live racing is untouched.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { parseResults, parseHorse } from "./hkjc.js";

const FLOCK = Deno.env.get("KYW_FLOCK_CODE") ?? "pelicans-2026";
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const HKJC = "https://racing.hkjc.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
async function hkGet(path: string): Promise<string | null> {
  for (let a = 0; a < 3; a++) { try { const res = await fetch(HKJC + path, { headers: { "User-Agent": UA, "Accept": "text/html", "Accept-Language": "en-US,en;q=0.9" }, redirect: "follow" }); if (res.status === 200) return await res.text(); } catch { /* retry */ } await new Promise(r => setTimeout(r, 400 * (a + 1))); }
  return null;
}
const text = (html: string) => html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const resultsPath = (date: string, venue: string, no: number) => `/racing/information/English/Racing/LocalResults.aspx?RaceDate=${date.replace(/-/g, "/")}&Racecourse=${venue}&RaceNo=${no}`;

// Race header on a results page: class, distance, rating band, going, course, prize.
function parseHeader(html: string, no: number) {
  const t = text(html); const i = t.search(new RegExp(`RACE\\s+${no}\\s*\\(`, "i")); const s = i >= 0 ? t.slice(i, i + 700) : "";
  const cls = /(Class\s+\d|Group\s+(?:One|Two|Three|1|2|3)|Griffin|Restricted|4 Year Olds|Hong Kong Group\s+\w+)/i.exec(s)?.[1] ?? null;
  const dist = /(\d{3,4})M/.exec(s)?.[1]; const band = /\((\d+)-(\d+)\)/.exec(s);
  const going = /Going\s*:\s*([A-Z /]+?)(?=\s+[A-Z][a-z]|\s+Course|\s+HK\$|$)/.exec(s)?.[1]?.trim() ?? null;
  const course = /Course\s*:\s*(.+?)(?=\s+HK\$|\s+Time|$)/.exec(s)?.[1]?.trim() ?? null;
  const prize = /HK\$\s*([\d,]+)/.exec(s)?.[1];
  return { cls, distance: dist ? +dist : null, band: band ? [+band[1], +band[2]] : null, going, course, prize: prize ? +prize.replace(/,/g, "") : null, header: s.slice(0, 300) };
}

async function doMeeting(date: string, venue: string) {
  const races: any[] = [];
  for (let no = 1; no <= 12; no++) {
    const html = await hkGet(resultsPath(date, venue, no)); if (!html) break;
    const rows = parseResults(html); if (!rows.length) break;
    races.push({ race_key: `${date}-${venue}-${no}`, date, venue, race_no: no, data: { ...parseHeader(html, no), runners: rows }, fetched_at: new Date().toISOString() });
  }
  if (races.length) {
    const { error } = await sb.from("kyw_hk_race").upsert(races); if (error) throw error;
    const ids = [...new Set(races.flatMap(r => r.data.runners.map((x: any) => x.horseId)))].map(id => ({ horse_id: id, status: "todo" }));
    const { error: e2 } = await sb.from("kyw_hk_horse").upsert(ids, { onConflict: "horse_id", ignoreDuplicates: true }); if (e2) throw e2;
  }
  return races.length;
}

async function batch(budgetMs: number) {
  const t0 = Date.now(); const log: any = { meetings: [], horses: 0, horseMiss: 0 };
  const { data: probes } = await sb.from("kyw_hk_probe").select("date,venue").eq("status", "todo").order("date").limit(40);
  for (const p of probes ?? []) { if (Date.now() - t0 > budgetMs * 0.6) break;
    try { const n = await doMeeting(String(p.date), p.venue); await sb.from("kyw_hk_probe").update({ status: n ? "done" : "none", races: n }).eq("date", p.date).eq("venue", p.venue); if (n) log.meetings.push(`${p.date} ${p.venue} ${n}`); }
    catch (e) { log.error = String(e).slice(0, 200); break; } }
  const { data: hs } = await sb.from("kyw_hk_horse").select("horse_id").eq("status", "todo").limit(60);
  const todo = hs ?? [];
  for (let i = 0; i < todo.length; i += 6) { if (Date.now() - t0 > budgetMs) break;
    await Promise.all(todo.slice(i, i + 6).map(async (h: any) => {
      const html = await hkGet(`/racing/information/English/Horse/Horse.aspx?HorseId=${h.horse_id}`);
      const parsed = html ? parseHorse(html) : null; const ok = !!(parsed && parsed.runs.length);
      await sb.from("kyw_hk_horse").update({ status: ok ? "ok" : "miss", data: parsed, fetched_at: new Date().toISOString() }).eq("horse_id", h.horse_id);
      if (ok) log.horses++; else log.horseMiss++; })); }
  return log;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if ((req.headers.get("x-flock-code") ?? url.searchParams.get("code")) !== FLOCK) return new Response("not the flock", { status: 401 });
  const j = (o: any, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
  try {
    const dbg = url.searchParams.get("debug"); // date,venue,race: header parse and a text sample, nothing stored
    if (dbg) { const [d, v, n] = dbg.split(","); const html = await hkGet(resultsPath(d, v, +n)); if (!html) return j({ html: null });
      return j({ len: html.length, header: parseHeader(html, +n), rows: parseResults(html).slice(0, 3) }); }
    const hd = url.searchParams.get("horse"); if (hd) { const html = await hkGet(`/racing/information/English/Horse/Horse.aspx?HorseId=${hd}`); const p = html ? parseHorse(html) : null; return j({ len: html?.length, rec: p?.rec, runs: p?.runs.length, first: p?.runs[0], last: p?.runs.at(-1) }); }
    return j({ ok: true, at: new Date().toISOString(), ...(await batch(100000)) });
  } catch (e) { return j({ error: String(e).slice(0, 300) }, 500); }
});
