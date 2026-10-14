//! Blocking HTTP client for the Discovery API (used by the CLI).

use std::fmt;

use anyhow::{Result, anyhow, bail};
use reqwest::StatusCode;
use reqwest::blocking::Client;

use crate::api::{Attraction, Event, parse_attractions, parse_events_page};

pub const DEFAULT_BASE_URL: &str = "https://app.ticketmaster.com/discovery/v2";

const PAGE_SIZE: u32 = 200;
// The API refuses deep paging past size * page >= 1000.
const MAX_PAGES: u32 = 5;

/// The API key was rejected. Retrying will never help, so callers treat it as fatal.
#[derive(Debug)]
pub struct AuthError(pub StatusCode);

impl fmt::Display for AuthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Ticketmaster rejected the API key (HTTP {}); check TICKETMASTER_API_KEY",
            self.0.as_u16()
        )
    }
}

impl std::error::Error for AuthError {}

pub struct Discovery {
    http: Client,
    base_url: String,
    api_key: String,
}

impl Discovery {
    pub fn new(http: Client, base_url: &str, api_key: &str) -> Self {
        Self {
            http,
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key: api_key.to_string(),
        }
    }

    fn get(&self, path: &str, params: &[(&str, &str)]) -> Result<String> {
        let url = format!("{}/{path}", self.base_url);
        // reqwest errors embed the full URL, which includes the API key. Strip it.
        let resp = self
            .http
            .get(&url)
            .query(&[("apikey", self.api_key.as_str())])
            .query(params)
            .send()
            .map_err(|e| {
                anyhow::Error::new(e.without_url()).context(format!("GET {path} failed"))
            })?;
        let status = resp.status();
        let body = resp.text().map_err(|e| {
            anyhow::Error::new(e.without_url()).context(format!("reading {path} response"))
        })?;

        if status == StatusCode::UNAUTHORIZED {
            return Err(AuthError(status).into());
        }
        if status == StatusCode::TOO_MANY_REQUESTS {
            bail!("Ticketmaster rate limit hit (HTTP 429); try a longer --interval");
        }
        if !status.is_success() {
            let snippet: String = body.chars().take(200).collect();
            bail!("GET {path} returned HTTP {}: {snippet}", status.as_u16());
        }
        Ok(body)
    }

    pub fn find_attractions(&self, keyword: &str) -> Result<Vec<Attraction>> {
        let body = self.get(
            "attractions.json",
            &[("keyword", keyword), ("size", "10"), ("locale", "*")],
        )?;
        parse_attractions(&body)
    }

    pub fn events_for(&self, attraction_id: &str, country: Option<&str>) -> Result<Vec<Event>> {
        let size = PAGE_SIZE.to_string();
        let mut all: std::collections::BTreeMap<String, Event> = Default::default();

        for page in 0..MAX_PAGES {
            let page_s = page.to_string();
            // locale=* matters: without it the API only returns events that have an
            // English-locale record, which hides many events in Latin America and Spain.
            let mut params = vec![
                ("attractionId", attraction_id),
                ("size", size.as_str()),
                ("page", page_s.as_str()),
                ("sort", "date,asc"),
                ("locale", "*"),
            ];
            if let Some(c) = country {
                params.push(("countryCode", c));
            }
            let body = self.get("events.json", &params)?;
            let (events, total_pages) =
                parse_events_page(&body).map_err(|e| anyhow!("{e:#} (page {page})"))?;
            for e in events {
                all.insert(e.id.clone(), e);
            }
            if page + 1 >= total_pages {
                break;
            }
        }
        Ok(all.into_values().collect())
    }
}
