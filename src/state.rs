//! What we've already seen, persisted between runs so we only alert on changes.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::api::Event;

/// Everything known about one watched artist (+ country filter).
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct Watch {
    pub artist: String,
    /// Keyed by Ticketmaster event id. Never pruned: an event that briefly vanishes from
    /// the API must not be announced as "new" when it comes back.
    pub events: BTreeMap<String, Event>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct State {
    /// Keyed by `watch_key`.
    #[serde(default)]
    pub watches: BTreeMap<String, Watch>,
    /// Artists we looked for before Ticketmaster had any page for them. When one shows up
    /// we must announce its events instead of treating them as a silent first-run baseline.
    #[serde(default)]
    pub unresolved: BTreeSet<String>,
}

pub fn watch_key(attraction_id: &str, country: Option<&str>) -> String {
    format!("{attraction_id}|{}", country.unwrap_or("*"))
}

pub fn unresolved_key(query: &str, country: Option<&str>) -> String {
    format!("{}|{}", query.trim().to_lowercase(), country.unwrap_or("*"))
}

impl State {
    /// What we last knew about this artist, to diff fresh API data against. `None` means
    /// first sight, which is a silent baseline. An artist that wasn't on Ticketmaster when we
    /// first looked counts as known-with-nothing-listed, so its first events are announced.
    pub fn previous(&self, key: &str, unresolved: &str) -> Option<Watch> {
        match self.watches.get(key) {
            Some(w) => Some(w.clone()),
            None if self.unresolved.contains(unresolved) => Some(Watch::default()),
            None => None,
        }
    }

    /// Record that Ticketmaster has no page for this artist yet. True if newly recorded.
    pub fn mark_unresolved(&mut self, unresolved: String) -> bool {
        self.unresolved.insert(unresolved)
    }

    /// Store the outcome of a check. Call only once any alerts have been delivered.
    pub fn commit(&mut self, key: String, unresolved: &str, watch: Watch) {
        self.watches.insert(key, watch);
        self.unresolved.remove(unresolved);
    }

    pub fn load(path: &Path) -> Result<State> {
        match fs::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text).with_context(|| {
                // Starting over silently would re-baseline everything and swallow alerts.
                format!(
                    "state file {} is corrupt; fix it or delete it to start fresh",
                    path.display()
                )
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(State::default()),
            Err(e) => Err(e).with_context(|| format!("reading state file {}", path.display())),
        }
    }

    /// Write via a temp file + rename so a crash can't leave a half-written state file.
    pub fn save(&self, path: &Path) -> Result<()> {
        let mut tmp = path.as_os_str().to_owned();
        tmp.push(".tmp");
        let tmp = std::path::PathBuf::from(tmp);
        let json = serde_json::to_string_pretty(self)?;
        fs::write(&tmp, json).with_context(|| format!("writing {}", tmp.display()))?;
        fs::rename(&tmp, path).with_context(|| format!("replacing {}", path.display()))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_is_empty_state_and_corrupt_file_is_an_error() {
        let dir =
            std::env::temp_dir().join(format!("ticketwatch-state-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.json");

        assert!(State::load(&path).unwrap().watches.is_empty());

        let mut s = State::default();
        s.unresolved.insert("someone|*".into());
        s.save(&path).unwrap();
        assert!(State::load(&path).unwrap().unresolved.contains("someone|*"));

        fs::write(&path, "{ not json").unwrap();
        let err = State::load(&path).unwrap_err();
        assert!(format!("{err:#}").contains("corrupt"));

        fs::remove_dir_all(&dir).unwrap();
    }
}
