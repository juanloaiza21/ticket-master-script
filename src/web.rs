//! Browser entry points (WebAssembly).
//!
//! JavaScript does the fetching, storage and drawing. Everything that decides what is worth
//! alerting on is the same Rust the CLI uses. Data crosses the boundary as JSON strings.

use anyhow::{Context, Result};
use serde::Serialize;
use wasm_bindgen::prelude::*;

use crate::api::{self, Event, parse_attractions, parse_events_page, pick_attraction};
use crate::state::{State, unresolved_key, watch_key};
use crate::watch::{Alert, Outcome, evaluate, render_alert};

#[derive(Serialize)]
struct PickedArtist<'a> {
    id: &'a str,
    name: &'a str,
    exact: bool,
    others: Vec<&'a str>,
}

#[derive(Serialize)]
struct EventsPage {
    events: Vec<Event>,
    total_pages: u32,
}

#[derive(Serialize)]
struct AlertView {
    kind: &'static str,
    event: Event,
    changes: Vec<String>,
    /// Plain-text version, handy for desktop notifications.
    text: String,
}

#[derive(Serialize)]
struct CheckResult<'a> {
    /// Opaque to JavaScript: store it and pass it back on the next check.
    state: &'a State,
    /// "baseline" (first look, nothing to announce), "quiet" or "alerts".
    outcome: &'static str,
    alerts: Vec<AlertView>,
    tracked: usize,
}

fn load_state(json: &str) -> Result<State> {
    if json.trim().is_empty() {
        return Ok(State::default());
    }
    serde_json::from_str(json).context("saved state is corrupt; reset it to start fresh")
}

fn to_json<T: Serialize>(value: &T) -> Result<String> {
    Ok(serde_json::to_string(value)?)
}

fn pick_artist_json(query: &str, attractions_body: &str) -> Result<String> {
    let candidates = parse_attractions(attractions_body)?;
    match pick_attraction(query, &candidates) {
        None => Ok("null".to_string()),
        Some((found, exact)) => to_json(&PickedArtist {
            id: &found.id,
            name: &found.name,
            exact,
            others: candidates
                .iter()
                .filter(|c| c.id != found.id)
                .take(3)
                .map(|c| c.name.as_str())
                .collect(),
        }),
    }
}

fn parse_events_json(body: &str) -> Result<String> {
    let (events, total_pages) = parse_events_page(body)?;
    to_json(&EventsPage {
        events,
        total_pages,
    })
}

fn mark_unresolved_json(state_json: &str, artist: &str, country: &str) -> Result<String> {
    let country = api::normalize_country(Some(country))?;
    let mut state = load_state(state_json)?;
    state.mark_unresolved(unresolved_key(artist, country.as_deref()));
    to_json(&state)
}

fn check_json(
    state_json: &str,
    artist: &str,
    attraction_id: &str,
    attraction_name: &str,
    country: &str,
    events_json: &str,
) -> Result<String> {
    let country = api::normalize_country(Some(country))?;
    let events: Vec<Event> =
        serde_json::from_str(events_json).context("events must be a JSON array of events")?;
    let mut state = load_state(state_json)?;

    let key = watch_key(attraction_id, country.as_deref());
    let pending = unresolved_key(artist, country.as_deref());
    let prev = state.previous(&key, &pending);
    let (watch, outcome) = evaluate(prev.as_ref(), attraction_name, events);
    let tracked = watch.events.len();
    state.commit(key, &pending, watch);

    let (outcome, alerts) = match outcome {
        Outcome::Baseline => ("baseline", vec![]),
        Outcome::Quiet => ("quiet", vec![]),
        Outcome::Alerts(alerts) => (
            "alerts",
            alerts
                .into_iter()
                .map(|a| {
                    let text = render_alert(&a);
                    match a {
                        Alert::New(event) => AlertView {
                            kind: "new",
                            event,
                            changes: vec![],
                            text,
                        },
                        Alert::Changed { event, changes } => AlertView {
                            kind: "changed",
                            event,
                            changes,
                            text,
                        },
                    }
                })
                .collect(),
        ),
    };

    to_json(&CheckResult {
        state: &state,
        outcome,
        alerts,
        tracked,
    })
}

fn js_err(e: anyhow::Error) -> JsError {
    JsError::new(&format!("{e:#}"))
}

/// Choose the artist for `query` out of an `attractions.json` response body.
/// Returns JSON `{id, name, exact, others}`, or `null` when there is no match.
#[wasm_bindgen]
pub fn pick_artist(query: &str, attractions_body: &str) -> Result<String, JsError> {
    pick_artist_json(query, attractions_body).map_err(js_err)
}

/// Parse one `events.json` response body into JSON `{events, total_pages}`.
#[wasm_bindgen]
pub fn parse_events(body: &str) -> Result<String, JsError> {
    parse_events_json(body).map_err(js_err)
}

/// Upper-case and validate a 2-letter country code. Empty in, empty out.
#[wasm_bindgen]
pub fn normalize_country(code: &str) -> Result<String, JsError> {
    api::normalize_country(Some(code))
        .map(|c| c.unwrap_or_default())
        .map_err(js_err)
}

/// Note that Ticketmaster had no page for this artist yet. Returns the new state JSON.
#[wasm_bindgen]
pub fn mark_unresolved(state_json: &str, artist: &str, country: &str) -> Result<String, JsError> {
    mark_unresolved_json(state_json, artist, country).map_err(js_err)
}

/// Compare fresh events (a JSON array) against the saved state. Returns JSON
/// `{state, outcome, alerts, tracked}`; store `state` for the next call.
#[wasm_bindgen]
pub fn check(
    state_json: &str,
    artist: &str,
    attraction_id: &str,
    attraction_name: &str,
    country: &str,
    events_json: &str,
) -> Result<String, JsError> {
    check_json(
        state_json,
        artist,
        attraction_id,
        attraction_name,
        country,
        events_json,
    )
    .map_err(js_err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn event(id: &str, status: &str) -> Value {
        json!({
            "id": id, "name": format!("Show {id}"), "url": null, "date": "2026-11-20 20:00",
            "venue": null, "city": null, "country": null, "status": status,
            "public_sale_start": null, "presales": []
        })
    }

    fn run(state: &str, id: &str, events: Vec<Value>) -> Value {
        let out = check_json(
            state,
            "Artist",
            id,
            "Artist",
            "mx",
            &Value::Array(events).to_string(),
        )
        .unwrap();
        serde_json::from_str(&out).unwrap()
    }

    #[test]
    fn state_round_trips_through_json_across_checks() {
        let first = run("", "K1", vec![event("a", "offsale")]);
        assert_eq!(first["outcome"], "baseline");
        assert_eq!(first["tracked"], 1);

        let state = first["state"].to_string();
        let quiet = run(&state, "K1", vec![event("a", "offsale")]);
        assert_eq!(quiet["outcome"], "quiet");

        let state = quiet["state"].to_string();
        let alerts = run(
            &state,
            "K1",
            vec![event("a", "onsale"), event("b", "offsale")],
        );
        assert_eq!(alerts["outcome"], "alerts");
        let list = alerts["alerts"].as_array().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0]["kind"], "changed");
        assert_eq!(list[0]["changes"][0], "status: offsale -> onsale");
        assert_eq!(list[1]["kind"], "new");
        assert_eq!(list[1]["event"]["name"], "Show b");
        assert!(list[1]["text"].as_str().unwrap().contains("NEW EVENT"));
    }

    #[test]
    fn artist_without_a_page_yet_is_announced_once_it_appears() {
        let state = mark_unresolved_json("", "Artist", "MX").unwrap();
        // Same country, different case: must line up with the key `check` computes.
        let result = run(&state, "K1", vec![event("a", "onsale")]);
        assert_eq!(result["outcome"], "alerts");
        assert_eq!(result["state"]["unresolved"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn country_is_validated_and_part_of_the_key() {
        assert!(check_json("", "A", "K1", "A", "mexico", "[]").is_err());
        let mx = run("", "K1", vec![event("a", "onsale")]);
        // A different country filter is a separate watch, so it gets its own baseline.
        let out = check_json(
            &mx["state"].to_string(),
            "Artist",
            "K1",
            "Artist",
            "co",
            "[]",
        )
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["outcome"], "baseline");
    }

    #[test]
    fn corrupt_state_is_an_error_not_a_silent_reset() {
        let err = check_json("{nope", "A", "K1", "A", "", "[]").unwrap_err();
        assert!(format!("{err:#}").contains("corrupt"));
    }

    #[test]
    fn picks_and_parses_api_bodies() {
        let body = r#"{"_embedded":{"attractions":[{"id":"1","name":"Other"},{"id":"2","name":"Silvana Estrada"}]}}"#;
        let v: Value =
            serde_json::from_str(&pick_artist_json("silvana estrada", body).unwrap()).unwrap();
        assert_eq!(
            (v["id"].as_str(), v["exact"].as_bool()),
            (Some("2"), Some(true))
        );
        assert_eq!(pick_artist_json("x", "{}").unwrap(), "null");

        let page = r#"{"_embedded":{"events":[{"id":"e","name":"N"}]},"page":{"totalPages":3}}"#;
        let v: Value = serde_json::from_str(&parse_events_json(page).unwrap()).unwrap();
        assert_eq!(v["total_pages"], 3);
        assert_eq!(v["events"][0]["status"], "unknown");
    }
}
