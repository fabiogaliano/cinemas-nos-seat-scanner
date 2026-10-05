# autobuy

Watches Cinemas NOS for a newly published date and buys tickets the moment one
appears. Private: the whole folder is gitignored and is not part of the public
`nos-seat-scanner` repo.

It reuses the parent app's seat ranking (`src/shared/ranking.ts`) and schedule
fetcher (`src/server/scanner.ts`), so it lives inside the repo rather than
standing alone.

---

## What it does

Every 5 minutes it fetches the NOS session aggregator, keeps only the sessions
at the configured cinema and format, and diffs the set of `operationalDate`
values against what it has seen before.

When a new date appears:

| Case | Behaviour |
| --- | --- |
| A showing matches `WATCH_PREFERRED_TIMES` | Buys it: picks the best seats, screenshots the seat page to your phone, fires an MB WAY push. |
| No showing matches | Buys nothing. Screenshots the day's full schedule to your phone at urgent priority so you can decide manually. |

Payment **only** completes when you approve the MB WAY push in the app. No card
details exist anywhere in this system.

### Purchase flow

Eight steps through the NOS OutSystems checkout, all headless:

```
guest checkout → party size → seats → benefits → bar
→ personal details → email confirmation → paygate.nos.pt → MB WAY
```

Seats come from `bestBlock`. Every step verifies it actually advanced, so a
change on NOS's side fails loudly rather than buying the wrong thing.

---

## Setup

```bash
cp autobuy/.env.example autobuy/.env   # then fill it in
```

Subscribe to your `NTFY_TOPIC` in the [ntfy](https://ntfy.sh) app on your phone.
Topics are public to anyone who knows the name, so use an unguessable one.

## Commands

Run from the `autobuy/` directory (Bun reads `.env` from the working directory).

| Command | Function |
| --- | --- |
| `bun scripts/watch.ts --seed` | Records the current dates as seen. Buys nothing. Do this first. |
| `bun scripts/watch.ts --once` | One check, then exits. |
| `bun scripts/watch.ts` | The 5-minute loop. |
| `bun scripts/buy.ts <sessionUuid> hold` | Runs the flow, stops before the push. |
| `bun scripts/buy.ts <sessionUuid> buy` | Runs the flow and fires the push. |
| `bun scripts/hold.ts <uuid> --row 4 --seats 6,7,8,9` | Holds those seats until you tap "Comprar agora". |
| `bun scripts/hold.ts --resume` | Picks up whatever the last run was holding. |
| `bun scripts/why-seat.ts <sessionUuid> 4` | Explains a seat choice with the actual scores. |

Add `--headed` to watch the browser, `--tickets N` to override the count.

**Seed before first use.** Without it the watcher treats every currently
published date as new and tries to buy the first one. `checkOnce` seeds
automatically when state is empty, but seed explicitly if unsure.

## Configuration

| Variable | Function |
| --- | --- |
| `BUYER_NAME` / `BUYER_PHONE` / `BUYER_EMAIL` | Fill the personal-details step. The phone also receives the MB WAY push. |
| `WATCH_AGGREGATE_ID` | The film's aggregate id. Covers all its formats. |
| `WATCH_MOVIE_URL` | Film page, used for the "no matching showing" screenshot. |
| `WATCH_CINEMA` | Substring match on the theatre name, e.g. `Colombo`. |
| `WATCH_FORMAT` | Exact format, e.g. `imax`. Empty means any. |
| `TICKET_COUNT` | 1 to 6. NOS refuses more. |
| `WATCH_PREFERRED_TIMES` | Ordered prefixes. `20:` matches any 20:xx; `20:10` is exact. No fallback beyond this list. |
| `PURCHASE_MODE` | `hold` stops before the push. `buy` fires it. |
| `NTFY_TOPIC` | ntfy topic for the screenshots. |
| `AVOID_STRANGERS` | `1` re-enables avoiding seats next to occupied ones. Off by default. |
| `CINEMAS_DATA_DIR` | State, heartbeat and screenshots. Default `./data`, `/data` in the container. |
| `RETAIN_ON_FAILURE` | `1` holds the seats when a push is not confirmed. Off by default. |
| `RETAIN_UNTIL` | When retention gives up, `HH:MM`. Default `09:00`. |
| `OBSERVE_PAYMENT_MS` | How long to watch the paygate before deciding. Default 8 min. |

---

## Holding seats after a failed payment

If the push goes unapproved — you were asleep — the seats are not gone, they
are just not yours yet. Retention keeps them until you are awake to decide.

```
purchase → push → not approved → retention
                                    │
        ┌───────────────────────────┴────────────────────────────┐
        │  take the seats → hold ~5 min → NOS releases → repeat  │
        └───────────────────────────┬────────────────────────────┘
                                    │  you tap "Comprar agora"
                                    ▼
                    same held booking → paygate → MB WAY push
```

Each cycle re-takes the **exact** seats by row and seat number, never a
substitute: tickets are not refundable, so quietly holding different seats
would be worse than holding none. The gap between cycles is seconds, which is
the only window anyone else gets.

### Why it pushes instead of letting you buy by hand

While the loop holds the seats, they read busy **to you as well** — and there is
no cancel button in the checkout, so releasing them takes up to five minutes. So
the loop keeps the booking and, on your command, walks that same booking to MB
WAY. You approve on the phone. There is no moment where the seats sit
unprotected.

### Telling it what to do

The container serves no HTTP, so the alert carries ntfy action buttons that POST
to `${NTFY_TOPIC}-control`, which the loop polls. No inbound port, no callback
to secure.

Taps arrive **duplicated** — one press can deliver three copies, and pressing
both buttons is normal. So the reader takes the newest command and records its
timestamp, and an acted-on command can never fire twice. Commands are scoped by
a per-run nonce, so a button in a stale notification cannot drive a later run.

An ntfy `http` action gives no feedback of its own, which makes a tap feel like
nothing happened. The loop replies on the alert topic as soon as it accepts a
command; that reply is the confirmation you see.

### Why there is no fallback showing

Cinema tickets are not refundable (art. 17(1)(k) DL 24/2014, as the NOS
checkout page states). Buying the wrong showing is the one mistake that cannot
be undone, so an unmatched date alerts instead of guessing.

### Why stranger avoidance is off

The ranking penalises sitting beside an occupied seat by `0.15`, while one seat
of centring is worth about `0.056` in a 33-seat row — so it outweighs nearly
three seats of centring and visibly pulls picks off-centre. For a film that
sells out, the buffer seat gets taken anyway. `bestBlock` now takes a
`strangerPenalty` option; this passes `0`.

---

## Deployment

Runs on a VPS as a single container. No HTTP surface, no Traefik route.

### First time

Create the host config as root. It sits **outside** the deploy target so
`rsync --delete` cannot remove it and a deploy cannot overwrite it:

```bash
ssh root@<host>
cat > /opt/apps/cinemas-watcher.conf   # paste the same keys as .env
chmod 600 /opt/apps/cinemas-watcher.conf
```

### Deploy

```bash
autobuy/deploy/deploy.sh root@<host>
```

Ships the repo to `/opt/apps/cinemas-autobuy`, builds, and starts. Refuses to
run if the host config is missing.

### Checking on it

```bash
ssh <host> 'docker ps --format "{{.Names}}\t{{.Status}}" | grep autobuy'
ssh <host> 'docker logs cinemas-autobuy --tail 30'
ssh <host> 'docker exec cinemas-autobuy cat /data/watch-state.json'
```

Healthy means the heartbeat file is under 15 minutes old. The parent image's
healthcheck curls port 5757, which this container does not serve — hence the
heartbeat instead. A watcher that dies quietly otherwise looks exactly like one
with nothing to report.

State lives on the `autobuy-data` volume: `watch-state.json` (seen dates with
first-seen timestamps), `watch-heartbeat`, and the last screenshots.

---

## Things that will break it

**NOS redesigning the checkout.** Selectors are bound to their CSS class names
and Portuguese screen text — `.o-compraSeat`, `.card-choosenumber`,
`Quantas pessoas vão?`. Every step is verified, so it fails loudly.

**reCAPTCHA being switched on.** The app ships the reCAPTCHA v2 bundle and
calls `GetSiteKeyFromAppConfigs`, but nothing renders — it is feature-flagged
off. If NOS enables it, the flow stops working. Solving it is out of scope.

**Terms of service.** This is automated checkout, which NOS's terms do not
permit. The realistic cost is the account or card being blocked.

---

## Notes from reverse-engineering

Kept because each cost real time to find.

- The session aggregator is served **windows-1252**, not UTF-8. Decoding it as
  UTF-8 mangles the Portuguese day names.
- Use each session's `operationalDate`, never the day label (`Hoje`, `Amanhã`).
- The aggregator **ignores every query parameter** — `days`, `date`,
  `startDate`, `numberOfDays`, `operationalDate` all return the same payload.
  You can only observe what NOS has published.
- `last-modified` equals the CDN cache-fill time, and on a cache-bust equals
  the current time. It is useless as a change signal: diff the data.
- `cache-control: max-age=300`, so polling faster than 5 minutes re-reads the
  same cached copy.
- **OutSystems ignores scripted value assignment.** Setting `input.value` and
  dispatching events updates the DOM but not its internal model, so the form
  reports every field as empty. Every field must be typed with real key events.
  This caused intermittent failures that looked random.
- Seat clicks must be real pointer events for the same reason, and the widget
  **refuses** a new seat while the party quota is full — it warns rather than
  swapping, so the auto-pick has to be cleared first.
- The rendered seat map carries no seat identity: each seat is a bare
  `div.o-compraSeat` with only a state modifier (`-free`, `-busy`, `-unable`,
  `-chosen`). Targeting is positional, and the API's `LocalSeats.List` order
  matches the rendered order — so the payload must **not** be sorted by column.
  NOS numbers seats descending, so sorting silently breaks every position.
- `paygate.nos.pt` offers MB WAY and card. Card runs through a CyberSource Flex
  Microform in a cross-origin iframe. MB WAY was chosen: no card data to store,
  and PSD2 SCA is irrelevant since approval is already a phone tap.

### The purchase clock, measured

Every number here came from watching the live site, not from documentation.

- `DataActionDT01_Get_NumberOfTickets_and_TimeToPurchase` returns
  `TimeToReservedSeat: 300000` and `NumberOfTickets: 6`. The same value appears
  at three different cinemas, so it is global config, not per-room.
- The client turns it into a plain `setTimeout(CountdownFinished, 300000)`
  started when the **Ticket screen loads** — before you pick a party size.
  Nothing restarts it: advancing a step does not buy more time, and there is
  **no visible countdown** anywhere in the UI. The page simply jumps to
  `Page_PurchaseOutOfTime` when it fires.
- **Advancing past the seat map is what reserves the seats.** Verified from a
  second browser with its own cookie jar: the seats read free before, and busy
  from that moment on.
- Left alone, the release is immediate — seats came back **within 8s** of the
  countdown firing.
- **A pending MB WAY payment holds the seats far longer**, and the duration is
  **not predictable**. Two runs, identical except for when the push was sent:

  | Push pressed at | After load | After push | After MB WAY expiry |
  | --- | --- | --- | --- |
  | load+80s | 20m 35s | 19m 15s | ~13m 20s |
  | load+240s | 17m 02s | 13m 01s | ~7m 06s |

  Pressing 160s **later** released the seats 213s **earlier**, so the hold is
  keyed to none of the three obvious anchors. It looks like a server-side sweep
  of dead bookings running on NOS's own schedule rather than a per-booking TTL.

  Two consequences:

  - Re-acquisition must **poll**, never schedule. A timer set to any of these
    figures would sometimes fire minutes after the seats were already free and
    exposed. `initialLockoutMs` (25 min) is only a "do not give up before this"
    floor, not an expected duration.
  - Pressing the pay button late to buy extra holding time does not work.
- The paygate's pending wording is
  `É necessário aprovar o pagamento na App MB WAY dentro de 5 minutos, senão
  será cancelado`, beside a timer that starts at **05:55** despite the sentence
  saying five minutes. The terminal wording is **not** known: confirming it
  would mean approving a real payment, so `observePayment` returns `unknown`
  for anything it does not recognise and callers treat that as not-bought.
- On a **single-ticket** purchase the "Lugares selecionados" summary stays
  empty, where two or more tickets render `M22 • M23`. The seat's own `-chosen`
  class is the reliable proof of selection; the label is a cross-check only.
