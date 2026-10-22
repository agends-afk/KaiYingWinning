import { fitLogit, probs, metrics, design, raceRow, hkRunner, hkExtras, tierOf, goingRating, appCoefficients, toWeights, KEYS } from "./lib.js";
let s = 3; const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const truth = [0.8, 0.3, 0, 0.5]; const rows = [];
for (let r = 0; r < 1500; r++) { const n = 6 + Math.floor(rnd() * 8); const X = Array.from({ length: n }, () => truth.map(() => gauss())); const p = probs(X, truth); let u = rnd(), win = 0; for (; win < n - 1; win++) { u -= p[win]; if (u <= 0) break; } rows.push({ X, win }); }
const b = fitLogit(rows, [0, 0, 0, 0], 0, [0, 1, 2, 3]); console.log("truth", truth, "fit", b.map(v => +v.toFixed(3)));
const br = fitLogit(rows, [0, 0, 0, 0], 50, []); console.log("ridge50 toward 0", br.map(v => +v.toFixed(3)));
console.log("metrics", JSON.stringify(metrics(rows.slice(0, 300), b)).slice(0, 200));
console.log(tierOf("VIC","ladbrokes-geelong"), tierOf("VIC","bet365-swan-hill"), tierOf("NSW","royal-randwick"), tierOf("WA","bunbury"), tierOf("QLD","sunshine-coast"), goingRating("Soft 7"), goingRating("Heavy"), goingRating("Synthetic"));
console.log("app coef", appCoefficients().map(v=>+v.toFixed(3)), toWeights(appCoefficients()).beta);
