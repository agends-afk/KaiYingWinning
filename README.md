# Kai Ying Winning

The Pelicans' single-file horse racing form app for metro meetings. It rates each runner from the form, converts ratings to win chances, and adjusts itself during the day as results come in. Built to be used from a phone.

The whole app is `index.html`. It is published as a Claude artifact; the source here is the record.

## What it does

Each runner is scored on fourteen metrics: last start, recent form, track record, distance record, record on today's going, career strike rate, jockey, trainer, barrier, weight carried, freshness, market, form lines from earlier races today, and your own assessment. Scores are standardised within the race so that only relative merit counts, multiplied by the metric weights, and passed through a softmax to give win percentages and a fair price.

Weights are sliders on the Weights tab and take effect immediately across every race.

When a result is entered, the app compares the winner's rated position and chance with the margin of error you have set. Inside the margin, nothing changes. Outside it, each metric weight moves toward the metrics that would have picked the placed horses, by an amount governed by the learning rate. Every change is logged and the last automatic change can be reverted.

Independently of the weights, each result feeds three live adjustments into races still to run: form lines (horses out of the same last-start race as a horse that ran above or below expectation), riders who have won on the day, and a barrier bias reading from where the winners and seconds have been drawn.

## The feed

A Supabase Edge Function reads racing.com's public GraphQL and writes the meetings, fields, prices and results the app reads. It runs on two schedules:

- 6am AEST daily: archives yesterday's followed meetings into the backtest table (form as at the morning, priced at SP, with results), picks the day's meetings, and loads every field.
- Every 10 minutes, but only while a followed meeting is racing (45 minutes before its first race to 20 minutes after its last).

Which meetings: every metro meeting on Wednesdays and Saturdays; on every day, the richest TAB card in each of NSW, Victoria, Queensland, the ACT and WA where no metro is already taken; Hong Kong (Sha Tin and Happy Valley) on Wednesdays and Sundays.

Within a run every race is re-read until its result is in, so fields, scratchings, prices and results are never more than ten minutes old during racing hours. The function writes a meeting only when something has changed, and logs itself only when it did work. Sync now on the Feed tab forces a full re-read.

Hong Kong from racing.com carries fields, barriers, weights, riders, track and distance records, prices and results, but not the horse form history the model uses for last start, recent form and class. HKJC's results and horse pages are plain HTML and reachable from the Edge runtime, so that history can be added from HKJC later.

## Loading the form by hand

The Load tab accepts JSON in the schema shown on that tab, or CSV with the listed columns. This is the fallback if a meeting is not on the feed.

1. Copy the conversion prompt from the Load tab.
2. Give it to Claude with the form guide text or PDF. Claude returns JSON in the schema.
3. Paste the JSON into the Load tab and load it.

Where the artifact runtime allows it, a "Convert raw form text with Claude" button does the same from inside the page.

Records are `[starts, wins, placings]`. Form strings read oldest to newest, most recent run last, as in Australian form guides. The `last.race` field ("2026-08-22 Rosehill R4") is what links horses for form lines, so it needs to be written consistently across runners.

## Your model

Tips are fixed at the jump. The first time a race is seen past its start time, or with a result in, the model's ranking and roughie for that race are locked on the device and shown from then on, so later slider moves cannot rewrite what was tipped. The feed also keeps the last pre-result field for a run race, so post-race price and scratching changes do not alter the judgement.

The page is public and single-user. Your weights, adjustments and picks are kept in your browser and never sent anywhere; the shared database is read-only from the page. Drag a slider on the Model tab and the current race reprices in front of you.

## Hosting and storage

Two backends. On GitHub Pages (workflow in `.github/workflows/pages.yml`) the page uses Supabase through the `SUPABASE` config block at the top of the script: tables `kyw_meeting`, `kyw_results`, `kyw_punters`, `kyw_comments` and `kyw_bets`, with realtime enabled and writes gated by an `x-flock-code` header checked in row-level security. Inside a Claude artifact the same code falls back to the artifact `db` capability. State is cached in the browser and, when published with the `db` capability, synced through the artifact's shared store. That store is available only to signed-in members of the publisher's Claude organisation. Sharing with people outside the organisation needs the page hosted elsewhere with its own backend; the storage code is isolated in `pushDb`, `pullMeeting` and `initDb` for that purpose.

## Stress test

The rating uses the opening market (the first price read each morning) at a weight of 0.75, refreshed once about 20 minutes before each race. Before the jump a tip can move when a result lands (adaptation), a horse is scratched, or that market refresh happens; each device keeps a tip trail per race recording every move and its reason, shown on the race screen, and the Card flags races whose tip has moved. The live price is shown alongside and drives value calls and the Edge board. Prices (the median fixed-odds price on racing.com at the last read) are the benchmark the form rating is judged against, and the Edge board on the Card lists the biggest disagreements. A Trust setting controls how far a disagreement is backed for value calls and stakes; the market weight slider can put the market back into the rating for anyone who wants it.

The model was run over 220 metro Saturday races (8 August to 5 September 2026) with the form as it stood that morning and settled at starting price. Records that included the day's run were unwound and ratings withheld, so the test does not see the result before it tips.

| Selection | Result | Flat-stake return |
| --- | --- | --- |
| Model best bet | won 68 of 220 (31%) | +4% |
| Market favourite | won 73 of 220 (33%) | -6% |
| Value calls | won 10 of 80 | -15% |
| Best roughie | won 10 of 169 | -37% |

Log-loss on the winner was 1.99 for the model against 1.85 for the market, so the market's probabilities were better calibrated than ours. The best-bet gap to the favourite is inside noise on a sample this size. No edge has been demonstrated. The proving ground on the Model tab lets each Pelican test their own weights against the same races.

## Limitations

Results are entered by hand. There is no live results feed, no sectional or in-running data, and no automatic scratchings or track condition updates. The example meeting is fictional throughout.
