// HKJC racecard and horse page parsers. Plain JS so it runs in Deno (the feed) and Node (tests).
// Racecard: racing.hkjc.com/racing/information/English/Racing/RaceCard.aspx?RaceDate=YYYY/MM/DD&Racecourse=ST|HV&RaceNo=n
// Horse page: racing.hkjc.com/racing/information/English/Horse/Horse.aspx?HorseId=HK_2023_J256
// Both are server-rendered HTML. HKJC publishes race runs only on the horse page (barrier trials live on a separate page), so no trial filtering is needed here.
const ent = (s) => String(s ?? "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&[a-z]+;/g, " ");
const text = (html) => ent(String(html ?? "").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
const num = (v) => { if (v == null) return null; const n = parseFloat(String(v).replace(/[$,*]/g, "")); return Number.isFinite(n) ? n : null; };
const cells = (rowHtml) => [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);

// Racecard rows, one per runner. Column order is fixed by HKJC; hidden columns are still present in the markup.
export function parseRaceCard(html) {
  const out = [];
  for (const m of html.matchAll(/<tr class="f_tac f_fs13">([\s\S]*?)<\/tr>/g)) {
    const c = cells(m[1]); if (c.length < 20) continue;
    const id = /horseid=([A-Z0-9_]+)/i.exec(c[3]); const no = num(text(c[0]));
    if (no == null || !id) continue;
    const jid = /jockeyid=([A-Z0-9]+)/i.exec(c[6]), tid = /trainerid=([A-Z0-9]+)/i.exec(c[9]);
    out.push({ no, last6: text(c[1]), name: text(c[3]), horseId: id[1].toUpperCase(), code: text(c[4]), weight: num(text(c[5])), jockey: text(c[6]), jockeyId: jid ? jid[1].toUpperCase() : null, draw: num(text(c[8])), trainer: text(c[9]), trainerId: tid ? tid[1].toUpperCase() : null,
      rating: num(text(c[11])), ratingChange: num(text(c[12])), declWeight: num(text(c[13])), age: num(text(c[16])), sex: text(c[18]), daysSince: num(text(c[21])), gear: text(c[22] ?? "") });
  }
  return out;
}

// "1-1/4" -> 1.25, "3/4" -> 0.75, "N" nose, "SH" short head, "HD" head, "NK" neck, "-" winner
export function lbw(s) {
  const t = String(s ?? "").trim().toUpperCase(); if (!t || t === "-") return null;
  const fix = { N: 0.1, SH: 0.2, HD: 0.3, NK: 0.4 }; if (t in fix) return fix[t];
  const m = /^(?:(\d+)-)?(?:(\d+)\/(\d+))?$/.exec(t); if (m && (m[1] || m[2])) return (m[1] ? +m[1] : 0) + (m[2] ? +m[2] / +m[3] : 0);
  const n = parseFloat(t); return Number.isFinite(n) ? n : null;
}
// HKJC class -> the 0 to 100 scale the app's class-of-recent-runs factor reads
export function classRank(c) {
  const s = String(c ?? "").toUpperCase().trim(); if (!s) return null;
  if (/^G1$|GRP?\s*1/.test(s)) return 100; if (/^G2$|GRP?\s*2/.test(s)) return 90; if (/^G3$|GRP?\s*3/.test(s)) return 80; if (/^LR$|LISTED/.test(s)) return 70;
  const m = /^(\d)/.exec(s); if (m) return { 1: 75, 2: 66, 3: 58, 4: 50, 5: 42 }[+m[1]] ?? null; if (/GRIFFIN/.test(s)) return 40; return null;
}
const isoDate = (d) => { const m = /(\d{2})\/(\d{2})\/(\d{2})/.exec(d || ""); return m ? `20${m[3]}-${m[2]}-${m[1]}` : null; };

// Horse page: profile record and every race run in the performance table, newest first.
export function parseHorse(html) {
  const out = { rec: null, rating: null, runs: [] };
  const pr = /No\. of 1-2-3-Starts\*?\s*<\/td>[\s\S]*?<td[^>]*>\s*(\d+)-(\d+)-(\d+)-(\d+)/.exec(html) || /No\. of 1-2-3-Starts\*?\s*:?\s*(\d+)-(\d+)-(\d+)-(\d+)/.exec(text(html.slice(html.indexOf("horseProfile") > 0 ? html.indexOf("horseProfile") : 0, (html.indexOf("horseProfile") > 0 ? html.indexOf("horseProfile") : 0) + 9000)));
  if (pr) out.rec = [+pr[4], +pr[1], +pr[2] + +pr[3]]; // [starts, wins, seconds+thirds] to match the app
  const rt = /Current Rating\s*<\/td>[\s\S]*?<td[^>]*>\s*(\d+)/.exec(html); if (rt) out.rating = +rt[1];
  // Each run row starts with a link to that race's result page. Rows nest a video table, so split on the link rather than on <tr>.
  const starts = [...html.matchAll(/<td\b[^>]*>\s*<a href="[^"]*localresults\?racedate=/gi)].map((m) => m.index);
  for (let i = 0; i < starts.length; i++) {
    const c = cells(html.slice(starts[i], starts[i + 1] ?? starts[i] + 6000)); if (c.length < 17) continue;
    const t = c.slice(0, 19).map(text); const d = isoDate(t[2]); if (!d) continue;
    const place = /^(\d+)/.exec(t[1]); const rcTrack = t[3].split("/").map((x) => x.trim().replace(/"/g, ""));
    const rp = t[14] ? t[14].split(/\s+/).map(Number).filter(Number.isFinite) : [];
    const ft = /^(\d+)\.(\d{2})\.(\d{2})$/.exec(t[15]);
    out.runs.push({ date: d, pos: place ? +place[1] : null, status: place ? null : t[1] || null, venue: rcTrack[0] || null, surface: rcTrack[1] || null, course: rcTrack[2] || null, dist: num(t[4]), going: t[5] || null, cls: t[6] || null,
      draw: num(t[7]), rtg: num(t[8]), trainer: t[9] || null, jockey: t[10] || null, margin: lbw(t[11]), sp: num(t[12]), weight: num(t[13]), running: rp, time: ft ? +ft[1] * 60 + +ft[2] + +ft[3] / 100 : null, gear: t[17] || null });
  }
  return out;
}

// Race header on a racecard page: "Race 1 - NAME Wednesday, October 14, 2026, Happy Valley, 18:35 Turf, "A" Course, 1650M, Good". Time is Hong Kong local (UTC+8, no daylight saving).
export function parseRaceInfo(html, date) {
  const t = text(html); const m = /Race\s+(\d+)\s*-\s*(.*?)\s+\w+day,\s+\w+\s+\d+,\s+\d{4},\s+[A-Za-z ]+?,\s+(\d{1,2}):(\d{2})\s+(Turf|All Weather)[^,]*,\s*"?[A-Z+0-9 ]*"?\s*Course,\s*(\d{3,4})M,\s*([A-Za-z ]+?)(?:\s+Prize|\s+\$|$)/.exec(t);
  if (!m) return null; const iso = date ? new Date(`${date}T${m[3].padStart(2, "0")}:${m[4]}:00+08:00`).toISOString() : null;
  return { raceNo: +m[1], name: m[2].trim(), hkTime: `${m[3].padStart(2, "0")}:${m[4]}`, timeUtc: iso, surface: m[5], distance: +m[6], going: m[7].trim() };
}

// Results page rows (past races): placing, number, horse, jockey, trainer, weight, draw, LBW, running positions, finish time, final tote win odds.
export function parseResults(html) {
  const out = [];
  for (const m of html.matchAll(/<tr>\s*(<td style="white-space: nowrap;">[\s\S]*?)<\/tr>/g)) {
    const c = cells(m[1]); if (c.length < 12) continue; const id = /horseid=([A-Z0-9_]+)/i.exec(c[2]); if (!id) continue;
    const place = /^(\d+)/.exec(text(c[0])); const jid = /jockeyid=([A-Z0-9]+)/i.exec(c[3]), tid = /trainerid=([A-Z0-9]+)/i.exec(c[4]);
    out.push({ place: place ? +place[1] : null, status: place ? null : text(c[0]) || null, no: num(text(c[1])), name: text(c[2]).replace(/\s*\(.*?\)\s*$/, ""), horseId: id[1].toUpperCase(), jockeyId: jid ? jid[1].toUpperCase() : null, trainerId: tid ? tid[1].toUpperCase() : null,
      weight: num(text(c[5])), draw: num(text(c[7])), margin: lbw(text(c[8])), running: [...(c[9].matchAll(/>\s*(\d+)\s*</g))].map((x) => +x[1]), winOdds: num(text(c[11])) });
  }
  return out;
}

// Jockey or trainer season table: the last row is "Total 17 14 12 84" = wins, seconds, thirds, unplaced.
export function parseStats(html) {
  const t = ent(String(html).replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " "); const m = [...t.matchAll(/Total\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/g)].pop(); if (!m) return null;
  const w = +m[1], n = +m[1] + +m[2] + +m[3] + +m[4]; return { wins: w, rides: n };
}

// WIN pool nodes ("01=4.5") to { runnerNo: odds }. Scratched or unpriced runners are left out.
export function toteMap(nodes) {
  const out = {}; for (const n of nodes ?? []) { const no = parseInt(n.combString, 10); const o = parseFloat(n.oddsValue); if (Number.isFinite(no) && Number.isFinite(o) && o > 1) out[no] = o; } return out;
}
// Hong Kong price rule: fixed odds until 30 minutes before the meeting's first race, then the tote.
export function toteOn(firstRaceMs, nowMs) { return Number.isFinite(firstRaceMs) && nowMs >= firstRaceMs - 30 * 60000; }
