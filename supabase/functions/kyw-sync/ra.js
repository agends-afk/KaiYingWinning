// Racing Australia Free Fields form page parser. Plain JS so it runs in Deno (the feed) and Node (tests).
// Input: the HTML of FreeFields/Form.aspx?Key=YYYYMonDD,STATE,Venue. Output: a meeting with races, runners, records and run lines.
const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
const ent = (s) => String(s ?? "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&rsquo;|&#39;|&apos;/g, "'").replace(/&lsquo;/g, "'").replace(/&quot;/g, '"').replace(/&ndash;/g, "-").replace(/&[a-z]+;/g, " ");
const text = (html) => ent(String(html ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).replace(/[ \t\r]+/g, " ").replace(/ *\n */g, "\n").trim();
const num = (v) => { if (v == null) return null; const n = parseFloat(String(v).replace(/[$,]/g, "")); return Number.isFinite(n) ? n : null; };
// "3:0-1-1" -> [starts, wins, seconds+thirds]; the app uses [s, w, p]
const rec = (s) => { const m = /(\d+):(\d+)-(\d+)-(\d+)/.exec(s || ""); return m ? [+m[1], +m[2], +m[3] + +m[4]] : null; };
const isoDate = (d) => { const m = /(\d{1,2})([A-Z][a-z]{2})(\d{2})/.exec(d || ""); if (!m) return null; return `20${m[3]}-${String(MONTHS[m[2]] || 0).padStart(2, "0")}-${m[1].padStart(2, "0")}`; };

// "2026Sep21,NSW,Grafton" or "2026Sep21,NSW,Grafton,Trial": a fourth segment flags a trial or picnic meeting.
function parseKey(key) { const m = /^(\d{4})([A-Z][a-z]{2})(\d{2}),([A-Z]+),([^,]+)(?:,(.+))?$/.exec(decodeURIComponent(key || "").replace(/\+/g, " ")); if (!m) return null;
  return { date: `${m[1]}-${String(MONTHS[m[2]] || 0).padStart(2, "0")}-${m[3]}`, state: m[4], venue: m[5].trim(), flag: m[6] ? m[6].trim() : null }; }

// One form line: "<b>KENS 14Jan26</b> 1150m Soft5 SUPER MDN-SW  $100,000 ($9,750) Tim Clark 57kg (cd 55kg) Barrier 5<br>1st Gorgeous 55.5kg, 2nd Let's Go Barbie 54kg 1:07.88 (600m 34.95), 0.65L, 2nd@800m, 2nd@400m, $4.80/$4.40/$4.20/$4"
function parseRun(posHtml, remainHtml) {
  const posT = text(posHtml); const trial = /^T\s*\d/.test(posT.replace(/\s+/g, " ")) || /<font[^>]*>T<\/font>/.test(posHtml);
  const pm = /(\d+)\s*of\s*(\d+)/.exec(posT); const pos = pm ? +pm[1] : null; const of = pm ? +pm[2] : null;
  const parts = text(remainHtml).split("\n"); const head = parts[0] || ""; const tail = parts.slice(1).join(" ");
  const hm = /^([A-Z][A-Z ]*?[A-Z])\s+(\d{1,2}[A-Z][a-z]{2}\d{2})\s+(\d+)m\s+(\S+)\s+(.*?)\s+\$([\d,]+)(?:\s+\(\$([\d,]+)\))?\s*(.*)$/.exec(head);
  const out = { trial, pos, of, venue: null, date: null, distance: null, cond: null, cls: null, prize: null, won: null, jockey: null, weight: null, claim: null, barrier: null, first: null, second: null, third: null, time: null, l600: null, margin: null, p800: null, p400: null, prices: null, sp: null };
  if (hm) { out.venue = hm[1]; out.date = isoDate(hm[2]); out.distance = +hm[3]; out.cond = hm[4]; out.cls = hm[5].trim(); out.prize = num(hm[6]); out.won = hm[7] ? num(hm[7]) : null;
    const rest = hm[8] || ""; const jm = /^(.*?)\s+([\d.]+)kg(?:\s+\(cd\s+([\d.]+)kg\))?\s+Barrier\s+(\d+)/.exec(rest); if (jm) { out.jockey = jm[1].trim(); out.weight = num(jm[2]); out.claim = jm[3] ? num(jm[3]) : null; out.barrier = +jm[4]; } }
  else { const vm = /^([A-Z][A-Z ]*?[A-Z])\s+(\d{1,2}[A-Z][a-z]{2}\d{2})/.exec(head); if (vm) { out.venue = vm[1]; out.date = isoDate(vm[2]); } const dm = /(\d+)m/.exec(head); if (dm) out.distance = +dm[1]; }
  const pl = /1st\s+(.*?)\s+[\d.]+kg/.exec(tail); if (pl) out.first = pl[1].trim();
  const p2 = /2nd\s+(.*?)\s+[\d.]+kg/.exec(tail); if (p2) out.second = p2[1].trim(); const p3 = /3rd\s+(.*?)\s+[\d.]+kg/.exec(tail); if (p3) out.third = p3[1].trim();
  const tm = /(\d+):(\d\d\.\d\d)/.exec(tail); if (tm) out.time = +tm[1] * 60 + +tm[2]; const sm = /600m\s+([\d.]+)/.exec(tail); if (sm) out.l600 = num(sm[1]);
  const mm = /([\d.]+)L/.exec(tail); if (mm) out.margin = num(mm[1]); const a8 = /(\d+)(?:st|nd|rd|th)@800m/.exec(tail); if (a8) out.p800 = +a8[1]; const a4 = /(\d+)(?:st|nd|rd|th)@400m/.exec(tail); if (a4) out.p400 = +a4[1];
  const pr = /(\$[\d.]+(?:\/\$[\d.]+)*)(EF)?/.exec(tail); if (pr) { out.prices = pr[1].split("/").map(num); out.sp = out.prices[out.prices.length - 1]; out.eqFav = !!pr[2]; }
  return out;
}

function parseRunnerBlock(block) {
  const r = {};
  const nm = /<span class="horse-number">(\d+)<\/span>/.exec(block); r.no = nm ? +nm[1] : null;
  const hn = /<span class="horse-name">[\s\S]*?>([^<]+)<\/a>/.exec(block); r.name = hn ? ent(hn[1]).trim() : null;
  const plain = /<span class="plain">([\s\S]*?)<\/span>\s*<\/div>/.exec(block); const pt = plain ? text(plain[1]) : "";
  const am = /(\d+)\s+year old\s+([a-z ]+?)\s+(colt|gelding|mare|filly|horse|stallion|rig)/i.exec(pt); if (am) { r.age = +am[1]; r.colour = am[2].trim(); r.sex = am[3][0].toUpperCase(); }
  const gm = /Gear Changes:\s*(.+)/.exec(pt); r.gear = gm ? gm[1].trim() : "";
  const tj = /<b>Trainer:<\/b>[\s\S]*?>([^<]+)<\/a>[\s\S]*?\(([^)]*)\)[\s\S]*?<b>Jockey:<\/b>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>[\s\S]*?<b>Barrier:<\/b>\s*(\d+)?/.exec(block);
  if (tj) { r.trainer = ent(tj[1]).trim(); r.stable = ent(tj[2]).trim(); const jt = text(tj[3]); const jm = /^(.*?)\s*([\d.]+)kg/.exec(jt); r.jockey = jm ? jm[1].trim() : jt; r.weight = jm ? num(jm[2]) : null; r.barrier = tj[4] ? +tj[4] : null; }
  const lab = (l) => { const m = new RegExp(`<b>${l}:<\\/b>\\s*([^<&]+)`).exec(block); return m ? m[1].trim() : null; };
  r.rec = { career: rec(lab("Record")), firstUp: rec(lab("1st Up")), secondUp: rec(lab("2nd Up")), track: rec(lab("Track")), dist: rec(lab("Dist")), trackDist: rec(lab("Track/Dist")), firm: rec(lab("Firm")), good: rec(lab("Good")), soft: rec(lab("Soft")), heavy: rec(lab("Heavy")), synth: rec(lab("Synthetic")) };
  r.prize = num(lab("Prizemoney"));
  r.runs = []; const rows = block.match(/<tr class='(?:Odd|Even)Row'>[\s\S]*?<\/tr>/g) || [];
  for (const row of rows) { const pm = /<td class='Pos'>([\s\S]*?)<\/td>\s*<td class='remain'>([\s\S]*?)<\/td>/.exec(row); if (pm) r.runs.push(parseRun(pm[1], pm[2])); }
  return r;
}

export function parseForm(html, key) {
  const k = parseKey(key) || {}; const out = { key, date: k.date || null, state: k.state || null, venue: k.venue || null, condition: null, rail: null, weather: null, races: [] };
  const vb = /<div class='race-venue-bottom'>([\s\S]*?)<div class='comments'>/.exec(html); if (vb) { const t = text(vb[1]); const g = (l) => { const m = new RegExp(`${l}:\\s*([^\\n]+)`).exec(t); return m ? m[1].trim() : null; }; out.rail = g("Rail Position"); out.condition = g("Track Condition"); out.weather = g("Weather"); }
  const sections = html.split(/<a name="Race(\d+)"><\/a>/); // [pre, n1, s1, n2, s2, ...]
  for (let i = 1; i < sections.length; i += 2) {
    const no = +sections[i]; const s = sections[i + 1] || ""; const race = { no, name: null, time: null, distance: null, class: null, conditions: null, prize: null, runners: [] };
    const tm = /<span class='raceNum'>Race \d+<\/span>\s*-\s*([\d:]+\s*[AP]M)?\s*([\s\S]*?)\((\d+)\s*METRES\)/.exec(s); if (tm) { race.time = tm[1] ? tm[1].trim() : null; race.name = text(tm[2]).trim(); race.distance = +tm[3]; }
    const ri = /<tr class="race-info">\s*<td>([\s\S]*?)<\/td>/.exec(s); if (ri) { const t = text(ri[1]); const pm = /Of \$([\d,]+)/.exec(t); race.prize = pm ? num(pm[1]) : null; const lines = t.split("\n").map(x => x.trim()).filter(Boolean); race.conditions = lines.find(l => !/^Of \$|^BOBS|^Track|^Field Limit|^From |^TRUE WEIGHT|^For more/.test(l) && !/Welfare Fund/.test(l)) || null; }
    // strip: number, last ten, hcp rating, penalty
    const strip = /<table[^>]*class="race-strip-fields">([\s\S]*?)<\/table>/.exec(s); const meta = {};
    if (strip) { for (const row of strip[1].match(/<tr class='(?:Odd|Even)Row[^']*'>[\s\S]*?<\/tr>/g) || []) { const cells = [...row.matchAll(/<td[^>]*class=["']?(\w+)["']?[^>]*>([\s\S]*?)<\/td>/g)]; const c = {}; for (const m of cells) c[m[1]] = text(m[2]); const n = num(c.no); if (n != null) meta[n] = { last10: c.last || "", hcp: num(c.hcp), penalty: c.penalty || "", scratched: /Scratched/i.test(row.slice(0, 60)) }; } }
    const blocks = s.split(/<table border="0" cellspacing="0" cellpadding="0" class="horse-form-table">/).slice(1);
    for (const b of blocks) { const r = parseRunnerBlock(b); if (r.no == null) continue; Object.assign(r, { scratched: false }, meta[r.no] || {}); race.runners.push(r); }
    out.races.push(race);
  }
  return out;
}

// Pick the Form.aspx key for a racing.com meeting from a Free Fields calendar page: same date, best venue-name overlap.
export function matchKey(calendarHtml, date, venueSlug) {
  const want = String(date).replace(/-/g, ""); const iso = (k) => { const p = parseKey(k); return p ? p.date.replace(/-/g, "") : null; };
  const keys = [...new Set([...calendarHtml.matchAll(/Form\.aspx\?Key=([^"'&]+)/g)].map(m => decodeURIComponent(m[1])))].filter(k => iso(k) === want && !parseKey(k).flag);
  const toks = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter(t => t && !["park", "racecourse", "the", "racing", "club", "gardens", "royal"].includes(t));
  const vt = toks(venueSlug.replace(/-/g, " ")); let best = null, bestScore = 0;
  for (const k of keys) { const p = parseKey(k); const kt = toks(p.venue); const score = vt.filter(t => kt.includes(t)).length + kt.filter(t => vt.includes(t)).length; if (score > bestScore) { best = k; bestScore = score; } }
  return best;
}
