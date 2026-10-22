// The app's scoring code, copied verbatim from index.html (METRICS, helpers, scoreRace) so the analysis rates runners exactly as the app does.
// Lines 203 to 313 of index.html, unchanged apart from the export at the end.
const METRICS = [
  {key:'last',      label:'Last start',            base:0.7,   fit:'held', desc:'Finishing position, margin and field size last start, adjusted for a rise or drop in class today. Trials and jump-outs are left out; a horse yet to race is rated on its latest trial at a fifth of the weight of a race run.'},
  {key:'form',      label:'Recent form',           base:1.125, fit:'held', desc:'Last five runs, most recent counting most. Spells are skipped.'},
  {key:'classform', label:'Class of recent runs',  base:0.9,   fit:'held', desc:'The grade of the last three races and how close the horse got. A narrow defeat in a Group 1 outranks a win in a benchmark race.'},
  {key:'career',    label:'Career strike rate',    base:0.6,   fit:'held', desc:'Career win and place percentages.'},
  {key:'track',     label:'Track record',          base:0.6,   fit:'held', desc:'Win and place rate at this track, shrunk toward average where starts are few.'},
  {key:'trackdist', label:'Track and distance',    base:0.35,  fit:'held', desc:'Record at this track over this distance.'},
  {key:'condition', label:'Track condition',       base:0,     fit:'none', desc:'Record on today\'s going. Showed no measured effect on the mostly dry days tested; turn it on for a wet track if you believe it matters.'},
  {key:'jockey',    label:'Jockey',                base:2.1,   fit:'thin', desc:'Jockey win percentage this season. Fitted high on a small sample and probably inflated; treat the default with suspicion.'},
  {key:'trainer',   label:'Trainer',               base:0.563, fit:'held', desc:'Trainer win percentage this season.'},
  {key:'barrier',   label:'Barrier',               base:0.45,  fit:'held', desc:'Inside draws favoured over short trips, fading with distance. The day\'s barrier bias, read from results, shifts this.'},
  {key:'barrierrec',label:'Record from this gate', base:0.9,   fit:'held', desc:'The horse\'s own record from this barrier number.'},
  {key:'weight',    label:'Weight carried',        base:0.4,   fit:'held', desc:'Weight relative to the field average.'},
  {key:'market',    label:'Opening market',        base:0.75,  fit:'held', desc:'Implied chance from the morning prices, refreshed once about 20 minutes before the race. At 0.75 it improved the return on past races without handing every tip to the favourite. Zero is pure form.'},
  {key:'formline',  label:'Form lines today',      base:1.0,   fit:'live', hidden:true, desc:'Horses out of the same last-start race as one that ran above or below expectation today, and riders winning on the day.'},
  {key:'manual',    label:'Your call',             base:1.0,   fit:'live', hidden:true, desc:'Your own plus or minus on a runner, set on the race screen.'}
];
const DEFAULT_SETTINGS = { marginRank:3, marginProb:0.12, lr:0.12, formlineGain:0.6, beta:2.2, autoAdapt:true, valueEdge:0.05, book:1.20, trust:0.5 };
const KELLY=0.25; // fraction of Kelly used by the unit allocator test
const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
const num = v => (v===null||v===undefined||v===''||isNaN(+v)) ? null : +v;
function rec(v){ if(!v) return null; if(Array.isArray(v)) return {s:num(v[0])||0,w:num(v[1])||0,p:num(v[2])||0};
  if(typeof v==='string'){ const m=v.split(/[-:/ ]+/).map(num); if(m.length>=3) return {s:m[0]||0,w:m[1]||0,p:m[2]||0}; return null; }
  if(typeof v==='object') return {s:num(v.starts??v.s)||0,w:num(v.wins??v.w)||0,p:num(v.places??v.p)||0}; return null; }
function condCategory(cond){ const c=String(cond||'').toLowerCase(); if(c.startsWith('h')) return 'heavy'; if(c.startsWith('so')||c.startsWith('sl')||c.startsWith('sy')) return 'soft'; return 'good'; }
function normKey(s){ return String(s||'').toLowerCase().replace(/\s+/g,' ').trim(); }
function active(race){ return race.runners.filter(r=>!r.scratched); }
function runnerKey(race,r){ return 'm'+(race.meetingId||'')+'_r'+race.no+'_'+r.no; }
/* ---------------- scoring ---------------- */
function rate(w,s,prior,k){ return (w + prior*k)/(s + k); }
function recScore(r){ if(!r||r.s===0) return null; const wr=rate(r.w,r.s,0.12,4), pr=rate(r.w+r.p,r.s,0.38,4); return 0.5*clamp(wr/0.3,0,1)+0.5*clamp(pr/0.6,0,1); }
const FORM_PTS = {'1':1,'2':.75,'3':.6,'4':.45,'5':.35,'6':.25,'7':.2,'8':.15,'9':.12,'0':.08};
function formScore(f){ if(!f) return null; const runs=String(f).replace(/[^0-9a-zA-Z]/g,'').split('').filter(c=>!/x/i.test(c)).slice(-5); if(!runs.length) return null;
  const ws=[.1,.15,.2,.25,.3].slice(-runs.length); let tot=0,sw=0; runs.forEach((c,i)=>{ tot+=(FORM_PTS[c]??0.1)*ws[i]; sw+=ws[i]; }); return tot/sw; }
function lastScore(l){ if(!l||num(l.pos)==null) return null; const pos=num(l.pos), field=num(l.field)||12, margin=num(l.margin);
  const posS=pos<=1?1:clamp(1-(pos-1)/Math.max(field-1,1),0,1); const marS=margin==null?posS:clamp(1-margin/10,0,1);
  return clamp(0.5*posS+0.5*marS-0.1*(num(l.classChange)||0),0,1); }
function classFormScore(r){ const runs=Array.isArray(r.recent)?r.recent.filter(x=>x&&num(x.cls)!=null):[]; if(!runs.length) return null; const ws=[0.5,0.3,0.2]; let tot=0,sw=0;
  runs.slice(0,3).forEach((x,i)=>{ const pos=num(x.pos)||9, margin=num(x.margin)||0; const q=(num(x.cls)||60)/100 + (pos===1?0.15:pos<=3?0.06:0) - Math.min(margin,12)/40; tot+=q*ws[i]; sw+=ws[i]; }); return tot/sw; }
function distanceFactor(dist){ const d=num(dist)||1400; if(d<=1200) return 1; if(d<=1400) return .8; if(d<=1600) return .6; if(d<=2000) return .45; return .3; }
function barrierScore(r,race,n,bias){ const b=num(r.barrier); if(b==null||n<2) return null; const rel=clamp((b-1)/(n-1),0,1); const eff=clamp(distanceFactor(race.distance)*0.6+(bias||0),-1,1); return clamp(0.5-(rel-0.5)*eff,0,1); }
function jockeyScore(r){ const p=num(r.jockeyPct), rp=num(r.jockeyRecentPct); if(p!=null||rp!=null){ const a=p!=null?clamp(p/25,0,1):null, b=rp!=null?clamp(rp/25,0,1):null; return a!=null&&b!=null?0.5*a+0.5*b:(a??b); } const g=num(r.jockeyRating); if(g!=null) return clamp(g/100,0,1); return null; }
function trainerScore(r){ const p=num(r.trainerPct); if(p!=null) return clamp(p/20,0,1); const g=num(r.trainerRating); if(g!=null) return clamp(g/100,0,1); return null; }
// A trial stands in as last start only for a horse with no race run, and counts at this fraction of a race run.
const TRIAL_WEIGHT = 0.2;
// z-scores against the race runs only; a trial's score is placed on the same scale and then shrunk toward the field average.
function zscoresPartial(vals, part, w){ const base=vals.map((v,i)=>part[i]?null:v); const xs=base.filter(v=>v!=null); if(xs.length<2) return zscores(vals).map((z,i)=>part[i]?z*w:z);
  const m=xs.reduce((a,b)=>a+b,0)/xs.length; const sd=Math.sqrt(xs.reduce((a,b)=>a+(b-m)**2,0)/xs.length)||0; if(sd<1e-9) return vals.map(()=>0);
  return vals.map((v,i)=>v==null?0:clamp((v-m)/sd,-2.5,2.5)*(part[i]?w:1)); }
function zscores(vals){ const xs=vals.filter(v=>v!=null); if(xs.length<2) return vals.map(()=>0); const m=xs.reduce((a,b)=>a+b,0)/xs.length; const sd=Math.sqrt(xs.reduce((a,b)=>a+(b-m)**2,0)/xs.length)||0; if(sd<1e-9) return vals.map(()=>0); return vals.map(v=>v==null?0:clamp((v-m)/sd,-2.5,2.5)); }
// Records: Free Fields (ra) where the feed carries it, racing.com otherwise.
function recOf(r,key){ const ra=r.ra&&r.ra.rec; const map={career:'career',track:'track',distance:'dist',trackDistance:'trackDist',good:'good',soft:'soft',heavy:'heavy',firstUp:'firstUp'}; if(ra&&map[key]&&ra[map[key]]) return rec(ra[map[key]]); return rec(r[key]); }

function scoreRace(race, meeting, weights, settings, dyn, adj){
  const rs=active(race); const n=rs.length; const cat=condCategory(race.condition||meeting.condition);
  const ws=rs.map(r=>num(r.weight)).filter(v=>v!=null); const meanW=ws.length?ws.reduce((a,b)=>a+b,0)/ws.length:null;
  const openOf=r=>num(r.lateOdds)??num(r.openOdds)??num(r.odds); const maxImp=Math.max(...rs.map(r=>{const o=openOf(r); return o>1?1/o:0;}),0);
  const raw={};
  raw.last=rs.map(r=>lastScore(r.last)); raw.form=rs.map(r=>formScore(r.form)); raw.track=rs.map(r=>recScore(recOf(r,'track')));
  raw.condition=rs.map(r=>recScore(recOf(r,cat)||rec(r.cond)||(r.condition&&rec(r.condition[cat])))); raw.career=rs.map(r=>recScore(recOf(r,'career')));
  raw.jockey=rs.map(jockeyScore); raw.trainer=rs.map(trainerScore); raw.barrier=rs.map(r=>barrierScore(r,race,n,dyn.barrierBias));
  raw.classform=rs.map(classFormScore); raw.trackdist=rs.map(r=>recScore(recOf(r,'trackDistance'))); raw.barrierrec=rs.map(r=>recScore(rec(r.barrierRec)));
  raw.weight=rs.map(r=>{const w=num(r.weight); return (w==null||meanW==null)?null:clamp(0.5+(meanW-w)/6,0,1);});
  raw.market=rs.map(r=>{const o=openOf(r); return (o>1&&maxImp>0)?(1/o)/maxImp:null;}); // the morning market, fixed for the day, so the tip does not move with the price
  const z={}; for(const k of Object.keys(raw)) z[k]=zscores(raw[k]);
  const trialLast=rs.map(r=>!!(r.last&&r.last.trial)); if(trialLast.some(Boolean)) z.last=zscoresPartial(raw.last,trialLast,TRIAL_WEIGHT);
  z.formline=rs.map(r=>clamp(dyn.formline[runnerKey(race,r)]||0,-2,2));
  z.manual=rs.map(r=>((adj&&adj[runnerKey(race,r)]&&num(adj[runnerKey(race,r)].adj))||0)*0.5);
  const wsum=METRICS.reduce((a,m)=>a+(weights[m.key]||0),0)||1; const wsumFree=wsum-(weights.market||0)||1;
  const scored=rs.map((r,i)=>{ let rating=0, ratingFree=0; const contrib={}; for(const m of METRICS){ const c=(weights[m.key]||0)*(z[m.key][i]||0)/wsum; contrib[m.key]=c; rating+=c; if(m.key!=='market') ratingFree+=(weights[m.key]||0)*(z[m.key][i]||0)/wsumFree; }
    const missing=['last','form','track','career','classform'].filter(k=>raw[k][i]==null).length;
    return {r, z:Object.fromEntries(METRICS.map(m=>[m.key,z[m.key][i]])), contrib, rating, ratingFree, missing}; });
  const beta=settings.beta||2.2; const ex=scored.map(s=>Math.exp(beta*s.rating)); const sum=ex.reduce((a,b)=>a+b,0)||1; scored.forEach((s,i)=>s.prob=ex[i]/sum);
  const exF=scored.map(s=>Math.exp(beta*s.ratingFree)); const sumF=exF.reduce((a,b)=>a+b,0)||1; scored.forEach((s,i)=>s.probFree=exF[i]/sumF);
  const order=[...scored].sort((a,b)=>b.rating-a.rating); order.forEach((s,i)=>s.rank=i+1);
  const imp=order.map(s=>{const o=num(s.r.odds); return o>1?1/o:null;}); const impSum=imp.reduce((a,b)=>a+(b||0),0);
  const raceBook = (imp.filter(v=>v!=null).length>=Math.max(3,Math.floor(order.length*0.7)) && impSum>1) ? impSum : null;
  order.forEach((s,i)=>{ s.book=raceBook; s.market= imp[i]!=null&&impSum>0 ? imp[i]/impSum : null; s.probValue= s.market!=null ? (settings.trust??0.5)*s.probFree+(1-(settings.trust??0.5))*s.market : s.probFree; s.edge= s.market!=null ? s.probValue-s.market : null; });
  return order;
}
export { METRICS, DEFAULT_SETTINGS, scoreRace, rec, num, clamp, condCategory, active };
