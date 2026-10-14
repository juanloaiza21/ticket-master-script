use std::collections::HashMap;
use std::path::PathBuf;
use std::process::ExitCode;
use std::thread::sleep;
use std::time::Duration;

use anyhow::{Result, bail};
use clap::Parser;
use reqwest::blocking::Client;

use ticketwatch::api::{Attraction, normalize_country, pick_attraction};
use ticketwatch::client::{AuthError, DEFAULT_BASE_URL, Discovery};
use ticketwatch::notify::Notifier;
use ticketwatch::state::{State, unresolved_key, watch_key};
use ticketwatch::watch::{Outcome, evaluate, render_alert, render_event};

/// Get alerted when Ticketmaster lists new events, opens presales/public sales, or changes
/// the status of events for the artists you follow.
#[derive(Parser)]
#[command(version)]
struct Cli {
    /// Artist to watch. Repeat to watch several: -a "Silvana Estrada" -a "Bad Bunny"
    #[arg(short, long = "artist", required = true, value_name = "NAME")]
    artists: Vec<String>,

    /// Ticketmaster Discovery API key (free: https://developer.ticketmaster.com)
    #[arg(long, env = "TICKETMASTER_API_KEY", hide_env_values = true)]
    api_key: String,

    /// Only events in this country, as a 2-letter code (US, MX, CO, ES, ...). Default: worldwide
    #[arg(short, long, value_name = "CODE")]
    country: Option<String>,

    /// Seconds between checks. The API allows 5000 requests/day; each check costs 1 per artist
    #[arg(short, long, default_value_t = 600, value_parser = clap::value_parser!(u64).range(60..))]
    interval: u64,

    /// Check once and exit instead of looping (for cron / systemd timers)
    #[arg(long)]
    once: bool,

    /// Where to remember which events were already seen
    #[arg(long, default_value = "ticketwatch-state.json", value_name = "FILE")]
    state_file: PathBuf,

    /// Also post alerts to a Slack or Discord incoming-webhook URL
    #[arg(long, env = "TICKETWATCH_WEBHOOK_URL", hide_env_values = true)]
    webhook_url: Option<String>,

    /// Also push alerts to this ntfy topic (phone notifications, see https://ntfy.sh)
    #[arg(long, env = "TICKETWATCH_NTFY_TOPIC", hide_env_values = true)]
    ntfy_topic: Option<String>,

    /// ntfy server to use
    #[arg(long, default_value = "https://ntfy.sh")]
    ntfy_server: String,

    /// Override the API base URL (for testing)
    #[arg(long, env = "TICKETMASTER_BASE_URL", default_value = DEFAULT_BASE_URL, hide = true)]
    base_url: String,
}

fn log(msg: impl std::fmt::Display) {
    println!(
        "[{}] {msg}",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
    );
}

struct App {
    artists: Vec<String>,
    country: Option<String>,
    state_file: PathBuf,
    api: Discovery,
    notifier: Notifier,
    state: State,
    /// Artist query -> resolved Ticketmaster artist, so we only look each one up once.
    resolved: HashMap<String, Attraction>,
}

impl App {
    /// Check every artist once. `Err` is reserved for fatal problems (bad API key, unusable
    /// state file); `Ok(false)` means some artist failed but is worth retrying later.
    fn cycle(&mut self) -> Result<bool> {
        let mut all_ok = true;
        for artist in self.artists.clone() {
            match self.check(&artist) {
                Ok(()) => {}
                Err(e) if e.downcast_ref::<AuthError>().is_some() => return Err(e),
                Err(e) => {
                    all_ok = false;
                    eprintln!(
                        "[{}] {artist}: {e:#}",
                        chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
                    );
                }
            }
        }
        Ok(all_ok)
    }

    fn resolve(&mut self, artist: &str) -> Result<Option<Attraction>> {
        if let Some(a) = self.resolved.get(artist) {
            return Ok(Some(a.clone()));
        }
        let candidates = self.api.find_attractions(artist)?;
        let Some((found, exact)) = pick_attraction(artist, &candidates) else {
            return Ok(None);
        };
        if exact {
            log(format_args!(
                "{artist}: matched Ticketmaster artist id {}",
                found.id
            ));
        } else {
            let others: Vec<&str> = candidates
                .iter()
                .filter(|c| c.id != found.id)
                .take(3)
                .map(|c| c.name.as_str())
                .collect();
            log(format_args!(
                "{artist}: no exact match, using closest result \"{}\" (id {}){}",
                found.name,
                found.id,
                if others.is_empty() {
                    String::new()
                } else {
                    format!("; other results: {}", others.join(", "))
                },
            ));
        }
        self.resolved.insert(artist.to_string(), found.clone());
        Ok(Some(found.clone()))
    }

    fn check(&mut self, artist: &str) -> Result<()> {
        let country = self.country.clone();
        let country = country.as_deref();

        let Some(attraction) = self.resolve(artist)? else {
            // Ticketmaster has no page for them yet. Remember that, so once one appears its
            // events are announced rather than swallowed as a first-run baseline.
            if self
                .state
                .unresolved
                .insert(unresolved_key(artist, country))
            {
                self.state.save(&self.state_file)?;
            }
            log(format_args!(
                "{artist}: no Ticketmaster artist page yet; will keep checking"
            ));
            return Ok(());
        };

        let key = watch_key(&attraction.id, country);
        let events = self.api.events_for(&attraction.id, country)?;

        let pending = unresolved_key(artist, country);
        let prev = self.state.previous(&key, &pending);

        let (watch, outcome) = evaluate(prev.as_ref(), &attraction.name, events);

        match outcome {
            Outcome::Baseline => {
                let n = watch.events.len();
                log(format_args!(
                    "{}: first check, {n} event(s) listed. Alerts start from now on.",
                    attraction.name
                ));
                for e in watch.events.values() {
                    print!("  {}", render_event(e));
                }
            }
            Outcome::Quiet => {
                log(format_args!(
                    "{}: no changes (tracking {} event(s))",
                    attraction.name,
                    watch.events.len()
                ));
            }
            Outcome::Alerts(alerts) => {
                let blocks: Vec<String> = alerts.iter().map(render_alert).collect();
                let headline = format!(
                    "{}: {} update(s) on Ticketmaster",
                    attraction.name,
                    alerts.len()
                );
                log(&headline);
                for b in &blocks {
                    println!("  {b}");
                }
                if self.notifier.is_configured() {
                    let message = format!("{headline}\n\n{}", blocks.join("\n"));
                    // If delivery fails, bail before saving state so the same alerts are
                    // retried next cycle. A duplicate alert beats a missed one.
                    if let Err(e) = self.notifier.send(&message) {
                        bail!("could not deliver notification ({e}); will retry next check");
                    }
                }
            }
        }

        self.state.commit(key, &pending, watch);
        self.state.save(&self.state_file)
    }
}

fn run(cli: Cli) -> Result<bool> {
    let country = normalize_country(cli.country.as_deref())?;
    let state = State::load(&cli.state_file)?;

    let http = Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent(concat!("ticketwatch/", env!("CARGO_PKG_VERSION")))
        .build()?;

    let mut app = App {
        artists: cli.artists,
        country,
        state_file: cli.state_file,
        api: Discovery::new(http.clone(), &cli.base_url, &cli.api_key),
        notifier: Notifier::new(http, cli.webhook_url, &cli.ntfy_server, cli.ntfy_topic),
        state,
        resolved: HashMap::new(),
    };

    if cli.once {
        return app.cycle();
    }

    log(format_args!(
        "watching {} artist(s) every {}s (Ctrl-C to stop)",
        app.artists.len(),
        cli.interval
    ));
    loop {
        app.cycle()?;
        sleep(Duration::from_secs(cli.interval));
    }
}

fn main() -> ExitCode {
    match run(Cli::parse()) {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::from(1),
        Err(e) => {
            eprintln!("error: {e:#}");
            ExitCode::from(2)
        }
    }
}
