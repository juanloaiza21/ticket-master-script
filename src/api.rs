//! Ticketmaster Discovery API v2 data model and response parsing.
//! No I/O here, so it also compiles to WebAssembly.
//! Docs: https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Presale {
    pub name: String,
    pub start: Option<String>,
    pub end: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Event {
    pub id: String,
    pub name: String,
    pub url: Option<String>,
    /// Local date and, when known, time: "2026-11-20 20:00".
    pub date: Option<String>,
    pub venue: Option<String>,
    pub city: Option<String>,
    pub country: Option<String>,
    /// Ticketmaster status code: onsale, offsale, canceled, postponed, rescheduled.
    pub status: String,
    /// When the general public sale starts (UTC, ISO 8601), if announced.
    pub public_sale_start: Option<String>,
    pub presales: Vec<Presale>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attraction {
    pub id: String,
    pub name: String,
}

// ---- Wire format -----------------------------------------------------------

#[derive(Deserialize, Default)]
struct Page {
    #[serde(default, rename = "totalPages")]
    total_pages: u32,
}

#[derive(Deserialize)]
struct EventsResponse {
    #[serde(rename = "_embedded")]
    embedded: Option<EventsEmbedded>,
    #[serde(default)]
    page: Page,
}

#[derive(Deserialize)]
struct EventsEmbedded {
    #[serde(default)]
    events: Vec<RawEvent>,
}

#[derive(Deserialize)]
struct RawEvent {
    id: String,
    name: String,
    url: Option<String>,
    dates: Option<RawDates>,
    sales: Option<RawSales>,
    #[serde(rename = "_embedded")]
    embedded: Option<RawEventEmbedded>,
}

#[derive(Deserialize)]
struct RawDates {
    start: Option<RawStart>,
    status: Option<RawStatus>,
}

#[derive(Deserialize)]
struct RawStart {
    #[serde(rename = "localDate")]
    local_date: Option<String>,
    #[serde(rename = "localTime")]
    local_time: Option<String>,
}

#[derive(Deserialize)]
struct RawStatus {
    code: Option<String>,
}

#[derive(Deserialize)]
struct RawSales {
    public: Option<RawPublicSale>,
    #[serde(default)]
    presales: Vec<RawPresale>,
}

#[derive(Deserialize)]
struct RawPublicSale {
    #[serde(rename = "startDateTime")]
    start: Option<String>,
}

#[derive(Deserialize)]
struct RawPresale {
    name: Option<String>,
    #[serde(rename = "startDateTime")]
    start: Option<String>,
    #[serde(rename = "endDateTime")]
    end: Option<String>,
}

#[derive(Deserialize)]
struct RawEventEmbedded {
    #[serde(default)]
    venues: Vec<RawVenue>,
}

#[derive(Deserialize)]
struct RawVenue {
    name: Option<String>,
    city: Option<RawNamed>,
    country: Option<RawCountry>,
}

#[derive(Deserialize)]
struct RawNamed {
    name: Option<String>,
}

#[derive(Deserialize)]
struct RawCountry {
    #[serde(rename = "countryCode")]
    code: Option<String>,
}

#[derive(Deserialize)]
struct AttractionsResponse {
    #[serde(rename = "_embedded")]
    embedded: Option<AttractionsEmbedded>,
}

#[derive(Deserialize)]
struct AttractionsEmbedded {
    #[serde(default)]
    attractions: Vec<RawAttraction>,
}

#[derive(Deserialize)]
struct RawAttraction {
    id: String,
    name: String,
}

impl From<RawEvent> for Event {
    fn from(raw: RawEvent) -> Self {
        let (local_date, local_time, status) = match raw.dates {
            Some(d) => {
                let (date, time) = d
                    .start
                    .map(|s| (s.local_date, s.local_time))
                    .unwrap_or_default();
                (date, time, d.status.and_then(|s| s.code))
            }
            None => (None, None, None),
        };
        // localTime is "20:00:00"; seconds are noise.
        let date = local_date.map(|d| match local_time {
            Some(t) => format!("{d} {}", t.get(..5).unwrap_or(&t)),
            None => d,
        });

        let (public_sale_start, presales) = match raw.sales {
            Some(s) => (
                s.public.and_then(|p| p.start),
                s.presales
                    .into_iter()
                    .map(|p| Presale {
                        name: p.name.unwrap_or_else(|| "Presale".to_string()),
                        start: p.start,
                        end: p.end,
                    })
                    .collect(),
            ),
            None => (None, Vec::new()),
        };

        let venue = raw.embedded.and_then(|e| e.venues.into_iter().next());
        let (venue_name, city, country) = match venue {
            Some(v) => (
                v.name,
                v.city.and_then(|c| c.name),
                v.country.and_then(|c| c.code),
            ),
            None => (None, None, None),
        };

        Event {
            id: raw.id,
            name: raw.name,
            url: raw.url,
            date,
            venue: venue_name,
            city,
            country,
            status: status.unwrap_or_else(|| "unknown".to_string()),
            public_sale_start,
            presales,
        }
    }
}

/// Parse one page of `events.json`. Returns the events and the total page count.
pub fn parse_events_page(body: &str) -> Result<(Vec<Event>, u32)> {
    let resp: EventsResponse =
        serde_json::from_str(body).context("unexpected events response format")?;
    // With zero results the API omits `_embedded` entirely.
    let events = resp
        .embedded
        .map(|e| e.events.into_iter().map(Event::from).collect())
        .unwrap_or_default();
    Ok((events, resp.page.total_pages))
}

pub fn parse_attractions(body: &str) -> Result<Vec<Attraction>> {
    let resp: AttractionsResponse =
        serde_json::from_str(body).context("unexpected attractions response format")?;
    Ok(resp
        .embedded
        .map(|e| {
            e.attractions
                .into_iter()
                .map(|a| Attraction {
                    id: a.id,
                    name: a.name,
                })
                .collect()
        })
        .unwrap_or_default())
}

/// Validate an optional 2-letter country code and upper-case it, as the API expects.
pub fn normalize_country(code: Option<&str>) -> Result<Option<String>> {
    match code.map(str::trim).filter(|c| !c.is_empty()) {
        None => Ok(None),
        Some(c) if c.len() == 2 && c.chars().all(|ch| ch.is_ascii_alphabetic()) => {
            Ok(Some(c.to_ascii_uppercase()))
        }
        Some(c) => anyhow::bail!("country must be a 2-letter code like US or MX, got {c:?}"),
    }
}

/// Choose the attraction for a user-supplied artist name: an exact (case-insensitive)
/// name match if there is one, otherwise the API's most relevant result.
/// The bool says whether the match was exact.
pub fn pick_attraction<'a>(
    query: &str,
    candidates: &'a [Attraction],
) -> Option<(&'a Attraction, bool)> {
    let query = query.trim();
    candidates
        .iter()
        .find(|a| a.name.trim().eq_ignore_ascii_case(query))
        .map(|a| (a, true))
        .or_else(|| candidates.first().map(|a| (a, false)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const EVENTS_JSON: &str = r#"{
      "_embedded": { "events": [
        {
          "id": "Z7r9jZ1A7abc", "name": "Silvana Estrada: Tour",
          "url": "https://www.ticketmaster.com.mx/event/abc",
          "dates": {
            "start": { "localDate": "2026-11-20", "localTime": "20:00:00" },
            "status": { "code": "onsale" }
          },
          "sales": {
            "public": { "startDateTime": "2026-10-16T16:00:00Z" },
            "presales": [ { "name": "Citi", "startDateTime": "2026-10-15T16:00:00Z", "endDateTime": "2026-10-15T22:00:00Z" } ]
          },
          "_embedded": { "venues": [ {
            "name": "Auditorio Nacional",
            "city": { "name": "Mexico City" },
            "country": { "countryCode": "MX" }
          } ] }
        },
        { "id": "bare", "name": "Bare Minimum" }
      ] },
      "page": { "size": 200, "totalElements": 2, "totalPages": 1, "number": 0 }
    }"#;

    #[test]
    fn parses_full_and_minimal_events() {
        let (events, pages) = parse_events_page(EVENTS_JSON).unwrap();
        assert_eq!(pages, 1);
        assert_eq!(events.len(), 2);

        let full = &events[0];
        assert_eq!(full.date.as_deref(), Some("2026-11-20 20:00"));
        assert_eq!(full.status, "onsale");
        assert_eq!(
            full.public_sale_start.as_deref(),
            Some("2026-10-16T16:00:00Z")
        );
        assert_eq!(full.venue.as_deref(), Some("Auditorio Nacional"));
        assert_eq!(full.city.as_deref(), Some("Mexico City"));
        assert_eq!(full.country.as_deref(), Some("MX"));
        assert_eq!(full.presales.len(), 1);
        assert_eq!(full.presales[0].name, "Citi");

        let bare = &events[1];
        assert_eq!(bare.status, "unknown");
        assert!(bare.date.is_none() && bare.venue.is_none() && bare.presales.is_empty());
    }

    #[test]
    fn empty_result_has_no_embedded_block() {
        let (events, pages) = parse_events_page(
            r#"{"page":{"size":200,"totalElements":0,"totalPages":0,"number":0}}"#,
        )
        .unwrap();
        assert!(events.is_empty());
        assert_eq!(pages, 0);
        assert!(parse_attractions("{}").unwrap().is_empty());
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_events_page("<html>nope</html>").is_err());
    }

    #[test]
    fn picks_exact_match_over_relevance_order() {
        let c = vec![
            Attraction {
                id: "1".into(),
                name: "Silvana Estrada Tribute".into(),
            },
            Attraction {
                id: "2".into(),
                name: "silvana estrada".into(),
            },
        ];
        let (a, exact) = pick_attraction("  Silvana Estrada ", &c).unwrap();
        assert_eq!((a.id.as_str(), exact), ("2", true));

        let (a, exact) = pick_attraction("Silvana", &c).unwrap();
        assert_eq!((a.id.as_str(), exact), ("1", false));

        assert!(pick_attraction("x", &[]).is_none());
    }
}
