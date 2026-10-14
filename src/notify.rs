//! Optional push notifications. Console output always happens regardless.

use anyhow::{Result, anyhow};
use reqwest::blocking::Client;

// Discord rejects messages over 2000 characters.
const MAX_CHARS: usize = 1900;

pub struct Notifier {
    http: Client,
    webhook_url: Option<String>,
    ntfy: Option<(String, String)>,
}

impl Notifier {
    pub fn new(
        http: Client,
        webhook_url: Option<String>,
        ntfy_server: &str,
        ntfy_topic: Option<String>,
    ) -> Self {
        Self {
            http,
            webhook_url,
            ntfy: ntfy_topic.map(|t| (ntfy_server.trim_end_matches('/').to_string(), t)),
        }
    }

    pub fn is_configured(&self) -> bool {
        self.webhook_url.is_some() || self.ntfy.is_some()
    }

    /// Send to every configured channel. Tries all of them and fails if any failed.
    pub fn send(&self, message: &str) -> Result<()> {
        let message: String = if message.chars().count() > MAX_CHARS {
            let cut: String = message.chars().take(MAX_CHARS).collect();
            format!("{cut}\n...(truncated)")
        } else {
            message.to_string()
        };

        let mut failures = Vec::new();

        if let Some(url) = &self.webhook_url {
            // `text` is read by Slack, `content` by Discord; each ignores the other.
            let body = serde_json::json!({ "text": message, "content": message });
            if let Err(e) = self.post(self.http.post(url).json(&body)) {
                failures.push(format!("webhook: {e}"));
            }
        }
        if let Some((server, topic)) = &self.ntfy {
            let url = format!("{server}/{topic}");
            if let Err(e) = self.post(self.http.post(url).body(message.clone())) {
                failures.push(format!("ntfy: {e}"));
            }
        }

        if failures.is_empty() {
            Ok(())
        } else {
            Err(anyhow!(failures.join("; ")))
        }
    }

    fn post(&self, req: reqwest::blocking::RequestBuilder) -> Result<()> {
        // Webhook URLs and ntfy topics are secrets, and reqwest errors embed the URL.
        let resp = req
            .send()
            .map_err(|e| anyhow!("{:#}", anyhow::Error::new(e.without_url())))?;
        if !resp.status().is_success() {
            return Err(anyhow!("HTTP {}", resp.status().as_u16()));
        }
        Ok(())
    }
}
