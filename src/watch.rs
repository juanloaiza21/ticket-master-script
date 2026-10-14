//! Decide what's worth telling the user, and how to show it.

use std::collections::BTreeMap;

use crate::api::Event;
use crate::state::Watch;

#[derive(Debug, PartialEq)]
pub enum Alert {
    New(Event),
    Changed { event: Event, changes: Vec<String> },
}

#[derive(Debug, PartialEq)]
pub enum Outcome {
    /// First time we've seen this artist: list what exists now, alert on nothing.
    Baseline,
    Alerts(Vec<Alert>),
    Quiet,
}

/// Compare the events Ticketmaster returns now against what we saw last time.
/// `prev == None` means first sight, which is a silent baseline.
/// Returns the updated watch to persist (only once any alerts were delivered).
pub fn evaluate(prev: Option<&Watch>, artist: &str, current: Vec<Event>) -> (Watch, Outcome) {
    let mut events: BTreeMap<String, Event> = prev.map(|p| p.events.clone()).unwrap_or_default();
    let mut alerts = Vec::new();

    for event in current {
        match events.get(&event.id) {
            None => alerts.push(Alert::New(event.clone())),
            Some(old) => {
                let changes = describe_changes(old, &event);
                if !changes.is_empty() {
                    alerts.push(Alert::Changed {
                        event: event.clone(),
                        changes,
                    });
                }
            }
        }
        events.insert(event.id.clone(), event);
    }

    let watch = Watch {
        artist: artist.to_string(),
        events,
    };
    let outcome = match prev {
        None => Outcome::Baseline,
        Some(_) if alerts.is_empty() => Outcome::Quiet,
        Some(_) => Outcome::Alerts(alerts),
    };
    (watch, outcome)
}

fn describe_changes(old: &Event, new: &Event) -> Vec<String> {
    let mut out = Vec::new();
    if old.status != new.status {
        out.push(format!("status: {} -> {}", old.status, new.status));
    }
    if old.public_sale_start != new.public_sale_start {
        out.push(format!(
            "public on-sale: {} -> {}",
            old.public_sale_start.as_deref().unwrap_or("not announced"),
            new.public_sale_start.as_deref().unwrap_or("not announced"),
        ));
    }
    if old.presales != new.presales {
        out.push(format!(
            "presales changed ({} -> {})",
            old.presales.len(),
            new.presales.len()
        ));
    }
    if old.date != new.date {
        out.push(format!(
            "date: {} -> {}",
            old.date.as_deref().unwrap_or("TBA"),
            new.date.as_deref().unwrap_or("TBA"),
        ));
    }
    out
}

/// Multi-line, human-readable description of one event.
pub fn render_event(e: &Event) -> String {
    let place: Vec<&str> = [e.venue.as_deref(), e.city.as_deref(), e.country.as_deref()]
        .into_iter()
        .flatten()
        .collect();
    let mut s = format!("{}\n", e.name);
    if !place.is_empty() {
        s.push_str(&format!("    where:   {}\n", place.join(", ")));
    }
    s.push_str(&format!(
        "    when:    {}\n",
        e.date.as_deref().unwrap_or("TBA")
    ));
    s.push_str(&format!("    status:  {}\n", e.status));
    if let Some(start) = &e.public_sale_start {
        s.push_str(&format!("    on sale: {start}\n"));
    }
    for p in &e.presales {
        let window = match (&p.start, &p.end) {
            (Some(a), Some(b)) => format!("{a} -> {b}"),
            (Some(a), None) => format!("from {a}"),
            _ => "dates TBA".to_string(),
        };
        s.push_str(&format!("    presale: {} ({window})\n", p.name));
    }
    if let Some(url) = &e.url {
        s.push_str(&format!("    tickets: {url}\n"));
    }
    s
}

pub fn render_alert(a: &Alert) -> String {
    match a {
        Alert::New(e) => format!("NEW EVENT  {}", render_event(e)),
        Alert::Changed { event, changes } => {
            let mut s = format!("CHANGED    {}", render_event(event));
            for c in changes {
                s.push_str(&format!("    >> {c}\n"));
            }
            s
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::Presale;

    fn event(id: &str, status: &str) -> Event {
        Event {
            id: id.into(),
            name: format!("Show {id}"),
            url: Some(format!("https://tm.example/{id}")),
            date: Some("2026-11-20 20:00".into()),
            venue: Some("Auditorio".into()),
            city: Some("CDMX".into()),
            country: Some("MX".into()),
            status: status.into(),
            public_sale_start: None,
            presales: vec![],
        }
    }

    #[test]
    fn first_sight_is_a_silent_baseline_that_records_everything() {
        let (watch, outcome) = evaluate(None, "Artist", vec![event("a", "onsale")]);
        assert_eq!(outcome, Outcome::Baseline);
        assert!(watch.events.contains_key("a"));
    }

    #[test]
    fn unchanged_events_are_quiet() {
        let (w, _) = evaluate(None, "Artist", vec![event("a", "onsale")]);
        let (_, outcome) = evaluate(Some(&w), "Artist", vec![event("a", "onsale")]);
        assert_eq!(outcome, Outcome::Quiet);
    }

    #[test]
    fn new_event_is_announced_once() {
        let (w, _) = evaluate(None, "Artist", vec![event("a", "onsale")]);
        let (w2, outcome) = evaluate(
            Some(&w),
            "Artist",
            vec![event("a", "onsale"), event("b", "offsale")],
        );
        assert_eq!(
            outcome,
            Outcome::Alerts(vec![Alert::New(event("b", "offsale"))])
        );

        let (_, again) = evaluate(
            Some(&w2),
            "Artist",
            vec![event("a", "onsale"), event("b", "offsale")],
        );
        assert_eq!(again, Outcome::Quiet);
    }

    #[test]
    fn going_on_sale_and_new_presale_are_reported() {
        let (w, _) = evaluate(None, "Artist", vec![event("a", "offsale")]);

        let mut now = event("a", "onsale");
        now.public_sale_start = Some("2026-10-16T16:00:00Z".into());
        now.presales.push(Presale {
            name: "Citi".into(),
            start: None,
            end: None,
        });

        let (_, outcome) = evaluate(Some(&w), "Artist", vec![now]);
        let Outcome::Alerts(alerts) = outcome else {
            panic!("expected alerts")
        };
        let Alert::Changed { changes, .. } = &alerts[0] else {
            panic!("expected a change")
        };
        assert_eq!(changes.len(), 3, "{changes:?}");
        assert!(changes[0].contains("offsale -> onsale"));
        assert!(changes[1].contains("not announced -> 2026-10-16"));
    }

    #[test]
    fn event_missing_from_a_response_is_kept_and_not_re_announced() {
        let (w, _) = evaluate(
            None,
            "Artist",
            vec![event("a", "onsale"), event("b", "onsale")],
        );
        let (w2, outcome) = evaluate(Some(&w), "Artist", vec![event("a", "onsale")]);
        assert_eq!(outcome, Outcome::Quiet);
        assert!(w2.events.contains_key("b"));

        let (_, outcome) = evaluate(
            Some(&w2),
            "Artist",
            vec![event("a", "onsale"), event("b", "onsale")],
        );
        assert_eq!(outcome, Outcome::Quiet);
    }

    #[test]
    fn empty_baseline_then_first_event_alerts() {
        let (w, outcome) = evaluate(None, "Artist", vec![]);
        assert_eq!(outcome, Outcome::Baseline);
        let (_, outcome) = evaluate(Some(&w), "Artist", vec![event("a", "onsale")]);
        assert!(matches!(outcome, Outcome::Alerts(_)));
    }

    #[test]
    fn rendering_includes_the_essentials() {
        let mut e = event("a", "onsale");
        e.public_sale_start = Some("2026-10-16T16:00:00Z".into());
        let text = render_alert(&Alert::New(e));
        for needle in [
            "NEW EVENT",
            "Show a",
            "Auditorio, CDMX, MX",
            "2026-11-20 20:00",
            "onsale",
            "2026-10-16T16:00:00Z",
            "https://tm.example/a",
        ] {
            assert!(text.contains(needle), "missing {needle:?} in:\n{text}");
        }
    }
}
