# ticketwatch

Get alerted when Ticketmaster lists **new events**, announces a **presale or public on-sale
time**, or **changes the status** of an event (e.g. `offsale` → `onsale`) for any artist you
follow. Built on Ticketmaster's official [Discovery API](https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/),
so there is no scraping and nothing to get blocked.

```
$ ticketwatch -a "Silvana Estrada" -c MX
[2026-10-14 15:35:43] Silvana Estrada: matched Ticketmaster artist id K8vZ917
[2026-10-14 15:35:43] Silvana Estrada: first check, 1 event(s) listed. Alerts start from now on.
  Silvana Estrada: Vendrán Suaves Lluvias Tour
    where:   Teatro Metropolitan, Mexico City, MX
    when:    2026-11-20 20:00
    status:  offsale
    on sale: 2026-10-20T16:00:00Z
    tickets: https://www.ticketmaster.com.mx/event/...
...
[2026-10-14 15:45:44] Silvana Estrada: 1 update(s) on Ticketmaster
  NEW EVENT  Silvana Estrada en Bogotá
    ...
```

## Setup

1. Get a free API key: sign up at <https://developer.ticketmaster.com>, then copy the
   **Consumer Key** of your app.
2. Install [Rust](https://rustup.rs) and build:
   ```sh
   cargo build --release      # binary: target/release/ticketwatch
   ```
3. Run it:
   ```sh
   export TICKETMASTER_API_KEY=your_consumer_key
   ./target/release/ticketwatch --artist "Silvana Estrada"
   ```

The first check only records what's currently listed (no alerts). From then on you're told
about anything new. State lives in `ticketwatch-state.json`, so restarts don't re-alert.

## Usage

```
ticketwatch --artist <NAME> [--artist <NAME> ...] [options]
```

| Option | Description |
| --- | --- |
| `-a, --artist <NAME>` | Artist to watch. Repeat for several. |
| `-c, --country <CODE>` | Only events in one country, 2-letter code (`US`, `MX`, `CO`, `ES`, …). Default: worldwide. |
| `-i, --interval <SECS>` | Seconds between checks (default 600, minimum 60). |
| `--once` | Check once and exit, for cron / systemd timers. |
| `--state-file <FILE>` | Where seen events are remembered (default `ticketwatch-state.json`). |
| `--webhook-url <URL>` | Also post alerts to a Slack or Discord incoming webhook. |
| `--ntfy-topic <TOPIC>` | Also push alerts to your phone via [ntfy](https://ntfy.sh). `--ntfy-server` to self-host. |
| `--api-key <KEY>` | API key (prefer the `TICKETMASTER_API_KEY` env var so it isn't in your shell history). |

`TICKETWATCH_WEBHOOK_URL` and `TICKETWATCH_NTFY_TOPIC` work as env vars too. Alerts always
print to the console; the webhook and ntfy are extras. Exit codes: `0` ok, `1` some artist
failed this run, `2` fatal (bad API key, bad arguments, unreadable state file).

### Run it on a schedule

Either leave `ticketwatch` running (`nohup ticketwatch -a "Silvana Estrada" --ntfy-topic my-secret-topic &`)
or use cron with `--once`:

```cron
*/10 * * * * TICKETMASTER_API_KEY=xxx /path/to/ticketwatch --once -a "Silvana Estrada" -c MX --state-file /path/to/state.json --webhook-url https://hooks.slack.com/...
```

The API allows 5000 requests/day. A check costs one request per artist (plus one lookup when
the process starts), so the default 10-minute interval is far below the limit.

## How it behaves

- **Artist matching.** The name is resolved to a Ticketmaster artist ID first, preferring an
  exact (case-insensitive) match, and the match is printed so you can verify it. If there's no
  exact match it uses the closest result and lists the alternatives it skipped.
- **Artist not on Ticketmaster yet.** It keeps looking each check, and when a page appears
  its events are announced rather than treated as the quiet first-run baseline.
- **Delivery failures are retried.** If a webhook/ntfy post fails, the state isn't updated, so
  the same alert is re-sent next check. You may get a duplicate, but never a miss.
- **Secrets stay out of logs.** API keys, webhook URLs and ntfy topics are stripped from
  error messages.

## Development

```sh
cargo test      # unit tests + end-to-end tests against a local mock of the API
```

The end-to-end tests run the real binary against a mock Ticketmaster server and webhook, so
they need no API key or network access.
