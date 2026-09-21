# Kai Ying Winning

A single-file form book for Australian racing with a calibrated model behind it. It rates every runner from the form, prices the field at the race's own book percentage, fixes each tip at the jump, and lets one person set what counts. It is built to be used from a phone.

The whole app is `index.html`, published on GitHub Pages. The feed is a Supabase Edge Function.

## What it is and is not

It is an instrument, not a tipster. On the archived race days the fitted defaults trail the market (form-only log-loss 2.05 against the market's 1.82 on the held-out month, best bet return -20% at SP) and every mechanical rule tested, value calls, roughies and the unit allocator, lost at starting price. The app says so on its face. What it offers is a rating whose default weights were fitted on one month and held on the next, a slider for each factor with what the data showed for it, a price beside the market's for every runner, a record of every tip as it stood at the jump, and a proving ground that tests any setting against real past days. The edge, where there is one, is the person's view; the tool makes that view a number and reports whether it paid.

Removed from the earlier build as noise: the roster of named punters, comments, the club bet book, tip overrides and the leaderboard, the best multi, bank and stake suggestions. Planned: a notes page, so the whole thing reads like a form book someone has written in.

## What it does

Each runner is scored on the factors below. Scores are standardised within the race so only relative merit counts, multiplied by the weights, and passed through a softmax to give win chances and a price. Factors with a slider: last start, recent form, class of recent runs, career strike rate, track record, track and distance, track condition, jockey, trainer, barrier, record from this gate, weight carried and the opening market. Two more work live without a slider: form lines from earlier races on the day and the person's own call on a runner. Distance record, handicap rating, run style and freshness were dropped after the refit found no measurable effect for them.

Each slider is labelled with what the fit showed: held out of sample, no measured effect, or fitted on a thin sample. Jockey is the one to treat with suspicion; it fitted high on a small sample.

When a result lands, the winner's rated position and chance are compared with the margin of error. Inside the margin nothing changes. Outside it, each weight moves toward the factors that would have picked the placed horses, by the learning rate, and every change is logged. Results also feed form lines, riders winning on the day and a barrier bias reading into the races still to run.

## The feed

A Supabase Edge Function reads racing.com's public GraphQL and writes the meetings, fields, prices and results the app reads. It runs on two schedules:

- 6am AEST daily: archives yesterday's followed meetings into the backtest table (form as at the morning, priced at SP, with results), picks the day's meetings, and loads every field.
- Every 10 minutes, but only while a followed meeting is racing (45 minutes before its first race to 20 minutes after its last).

Which meetings: every metro meeting on Wednesdays and Saturdays; on every day, the richest TAB card in each of NSW, Victoria, Queensland, the ACT and WA where no metro is already taken; Hong Kong (Sha Tin and Happy Valley) on Wednesdays and Sundays.

Once a day, at the morning roll or on the first sync, the Racing Australia Free Fields form page for each Australian meeting is read once, parsed (`supabase/functions/kyw-sync/ra.js`) and cached in `kyw_ra`. Every runner on the feed then carries its full career record by category and its run-by-run lines: date, track, distance, going, class, jockey, weight, barrier, winner, race time, last 600 metres, margin, positions at the 800 and 400, and prices from opening to SP. The race screen shows these as the form book. A few page views a day is the footprint; the site's robots file asks automated agents to keep out of Free Fields, and the licence question was put to the owner before this was built.

Within a run every race is re-read until its result is in, so fields, scratchings, prices and results are never more than ten minutes old during racing hours. The function writes a meeting only when something has changed, and logs itself only when it did work. Sync now on the Feed tab forces a full re-read.

Hong Kong from racing.com carries fields, barriers, weights, riders, track and distance records, prices and results, but not the horse form history the model uses for last start, recent form and class. HKJC's results and horse pages are plain HTML and reachable from the Edge runtime, so that history can be added from HKJC later.

## Loading the form by hand

The Feed tab accepts a meeting as JSON in the schema shown there. It is the fallback if a meeting is not on the feed, and it stays on the device.

## Your model

Tips are fixed at the jump. The first time a race is seen past its start time, or with a result in, the ranking and roughie for that race are locked on the device and shown from then on, so later slider moves cannot rewrite what was tipped. Before the jump a tip can move when a result lands, a horse is scratched, or the market is refreshed about 20 minutes out; a trail per race records every move and its reason and the Card marks the race Moved. The feed keeps the last pre-result field for a run race, so post-race price and scratching changes do not alter the judgement.

The page is public and single-user. Weights, settings, calls, notes and locked tips are kept in the browser and never sent anywhere; the database is read-only from the page.

## Hosting and storage

GitHub Pages serves `index.html` and `version.txt` (workflow in `.github/workflows/pages.yml`). The page reads Supabase through the `SUPABASE` block at the top of the script: `kyw_feed`, `kyw_meeting`, `kyw_results` and `kyw_backtest`, with realtime on the first three. Writes come only from the Edge Functions. `kyw_runs`, `kyw_form` and `kyw_runs_queue` hold the Victorian history pulled by `kyw-runs` for the edge hunt.

## Stress test

The rating uses the opening market (the first price read each morning) at a weight of 0.75, refreshed once about 20 minutes before each race. Before the jump a tip can move when a result lands (adaptation), a horse is scratched, or that market refresh happens; each device keeps a tip trail per race recording every move and its reason, shown on the race screen, and the Card flags races whose tip has moved. The live price is shown alongside and drives value calls and the Edge board. Prices (the median fixed-odds price on racing.com at the last read) are the benchmark the form rating is judged against, and the Edge board on the Card lists the biggest disagreements. A Trust setting controls how far a disagreement is backed for value calls and stakes; the market weight slider can put the market back into the rating for anyone who wants it.

The model was run over 220 metro Saturday races (8 August to 5 September 2026) with the form as it stood that morning and settled at starting price. Records that included the day's run were unwound and ratings withheld, so the test does not see the result before it tips.

| Selection | Result | Flat-stake return |
| --- | --- | --- |
| Model best bet | won 68 of 220 (31%) | +4% |
| Market favourite | won 73 of 220 (33%) | -6% |
| Value calls | won 10 of 80 | -15% |
| Best roughie | won 10 of 169 | -37% |

Log-loss on the winner was 1.99 for the model against 1.85 for the market, so the market's probabilities were better calibrated than ours. The best-bet gap to the favourite is inside noise on a sample this size. No edge has been demonstrated. The proving ground on the Model tab tests any weights against the same races.


### Unit allocator test

The proving ground also runs the unit allocator as a morning plan over each archived race day: candidates with positive edge under the trust setting, one per race, sized by fractional Kelly on 20 units, whole units, capped per race. Over the first 10 archived days (43 meetings, 377 races, settled at SP) it lost money under every setting tried: trust 35% to 100%, tenth to half Kelly, tighter and looser edge, price caps. Default settings placed 20 units, won 1 bet, lost 16.8 units, 7 losing days of 10.

The calibration table explains why. Grouping runners by how far the form rating sits above or below the market:

| Our chance / market chance | Runners | Actually won | Model said | Market said | Flat return |
| --- | --- | --- | --- | --- | --- |
| under 0.8 | 1179 | 17.0% | 8.4% | 16.5% | -17% |
| 0.8 to 1.0 | 431 | 10.9% | 11.0% | 12.3% | -28% |
| 1.0 to 1.25 | 431 | 11.1% | 11.1% | 10.0% | -23% |
| 1.25 to 1.6 | 427 | 9.4% | 11.5% | 8.2% | -14% |
| 1.6 to 2.5 | 657 | 5.0% | 10.5% | 5.4% | -41% |
| over 2.5 | 727 | 1.2% | 8.9% | 2.3% | -51% |

Where the rating disagrees most with the market, actual results track the market, not the rating. The form rating spreads chance too evenly: it under-rates the horses the market likes and over-rates the ones it does not. Until that changes, the allocator has nothing to allocate.

### Calibration and the roughie question

The weights were refitted by coordinate descent on the August archive and tested on September. The fit held out of sample and is now the default: jockey, form and class carry most of the weight; distance, condition, rating, pace and fitness dropped to zero. Form-only log-loss on the test races moved from 2.12 to 2.05 against the market's 1.82, and the best-bet flat return from -28% to -20%. Layering the form rating on top of the market improved log-loss by at most 0.002, so form adds nothing the market has not already priced.

Best roughie is the weakest corner, not the strongest. Across the 377 archived races the roughies the form liked most won 4.3% of the time against a market-implied 5.4%, a flat return of about -29%. The app's roughie rule ran -33% and an alternative definition -34%. The market prices the longshots the form fancies too generously, not too meanly. The roughie stays on the Card labelled as a lottery ticket.

### Edge hunt on a year of Victorian racing

A separate function (`kyw-runs`) pulled every Victorian TAB meeting from 20 September 2025 to 20 September 2026 from racing.com: 51,438 runner rows with starting price, opening price and two price moves, finish, margin, in-running positions, and sectional times where Victoria publishes them, plus 25,255 earlier runs (any state) for the horses involved. Every angle was bucketed and judged on actual wins against market-implied wins and flat-stake return at SP, separately on the first and second halves of the year so nothing is judged on the data it was found in.

No bucket of any angle returned a profit at SP in either half. The stable findings are all on the market's side or negative:

- Favourite-longshot bias: horses under $5 win about 8% more often than their price implies in both halves (return -10%); horses at $31 and over win 35% to 40% less often than implied (return -55%). The market is sharpest at the short end and too generous at the long end, which is why the roughie rule loses.
- Drifters lose: a horse whose price drifted more than 25% from opening to SP wins 15% less often than its SP implies (return -43% in both halves). Firmers only match their price.
- Poor last starts are overbet: beaten 6 lengths or more, or finishing 7th or worse, wins 10% to 15% less often than implied in both halves. A last-start winner wins 4% to 11% more often than implied but still returns -12% to -17%.
- Sectionals: the fastest last-600 metres at the previous start matched the market in one half and beat it by 5% in the other. Not a betting angle at SP.
- Barrier, field size, going, days since last run, weight change, distance change, jockey change and gear change all sit within noise of the market in both halves.

The instrument is calibrated against this. The edge, if any, is the person's, and the proving ground is where it shows.

## Limitations

Hong Kong meetings carry fields, prices and results from racing.com but no Free Fields form. Sectional times come only from the Free Fields run lines and racing.com's Victorian timing; there is no live sectional or in-running feed. Track condition and rail are as racing.com and Racing Australia publish them on the morning. The example meeting is fictional throughout.
