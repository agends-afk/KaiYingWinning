# Kai Ying Winning

The Pelicans' single-file horse racing form app for metro meetings. It rates each runner from the form, converts ratings to win chances, and adjusts itself during the day as results come in. Built to be used from a phone.

The whole app is `index.html`. It is published as a Claude artifact; the source here is the record.

## What it does

Each runner is scored on fourteen metrics: last start, recent form, track record, distance record, record on today's going, career strike rate, jockey, trainer, barrier, weight carried, freshness, market, form lines from earlier races today, and your own assessment. Scores are standardised within the race so that only relative merit counts, multiplied by the metric weights, and passed through a softmax to give win percentages and a fair price.

Weights are sliders on the Weights tab and take effect immediately across every race.

When a result is entered, the app compares the winner's rated position and chance with the margin of error you have set. Inside the margin, nothing changes. Outside it, each metric weight moves toward the metrics that would have picked the placed horses, by an amount governed by the learning rate. Every change is logged and the last automatic change can be reverted.

Independently of the weights, each result feeds three live adjustments into races still to run: form lines (horses out of the same last-start race as a horse that ran above or below expectation), riders who have won on the day, and a barrier bias reading from where the winners and seconds have been drawn.

## Loading the form

The Load tab accepts JSON in the schema shown on that tab, or CSV with the listed columns. Form guides are not machine readable, so the intended workflow is:

1. Copy the conversion prompt from the Load tab.
2. Give it to Claude with the form guide text or PDF. Claude returns JSON in the schema.
3. Paste the JSON into the Load tab and load it.

Where the artifact runtime allows it, a "Convert raw form text with Claude" button does the same from inside the page.

Records are `[starts, wins, placings]`. Form strings read oldest to newest, most recent run last, as in Australian form guides. The `last.race` field ("2026-08-22 Rosehill R4") is what links horses for form lines, so it needs to be written consistently across runners.

## Pelicans

On first open each person picks a name. The form, scratchings and results are shared. Each Pelican keeps their own metric weights, adaptation settings, runner calls, notes and tips (one win tip and up to two place tips per race). Every result is replayed through every Pelican's model on their own margin settings, so nobody's weights depend on who entered the result. The Flock tab scores tips (three points for a winner, one for a tip that runs a place) and shows how many winners each model had on top.

## Punters club and flock talk

Each race has a comment thread. Anyone can record a club bet on a runner (win, place or each way, with stake and odds). Existing bets on the runner show before you record another and the app asks before a same-type double-up. Once the result is in, bets settle and the Flock tab shows staked, returned and P&L, who has contributed and who has not. Place returns use the place price entered or a quarter of the win odds as an estimate.

## Roster

Mick, Wilko, Big Dog and Shirty are preset with their own avatar and colour. Anyone else can add a name on the roll call.

## Hosting and storage

Two backends. On GitHub Pages (workflow in `.github/workflows/pages.yml`) the page uses Supabase through the `SUPABASE` config block at the top of the script: tables `kyw_meeting`, `kyw_results`, `kyw_punters`, `kyw_comments` and `kyw_bets`, with realtime enabled and writes gated by an `x-flock-code` header checked in row-level security. Inside a Claude artifact the same code falls back to the artifact `db` capability. State is cached in the browser and, when published with the `db` capability, synced through the artifact's shared store. That store is available only to signed-in members of the publisher's Claude organisation. Sharing with people outside the organisation needs the page hosted elsewhere with its own backend; the storage code is isolated in `pushDb`, `pullMeeting` and `initDb` for that purpose.

## Limitations

Results are entered by hand. There is no live results feed, no sectional or in-running data, and no automatic scratchings or track condition updates. The example meeting is fictional throughout.
