//! Runs the real binary against a local mock of the Ticketmaster API and a webhook.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::{Arc, Mutex};
use std::thread;

const GOOD_KEY: &str = "good-key";

struct Shared {
    attractions: String,
    events: String,
    hooks: Vec<String>,
    hook_fails: bool,
    event_queries: Vec<String>,
}

struct Mock {
    port: u16,
    shared: Arc<Mutex<Shared>>,
    dir: PathBuf,
}

impl Drop for Mock {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

const ONE_ATTRACTION: &str = r#"{"_embedded":{"attractions":[
    {"id":"ATTR1","name":"Silvana Estrada"},{"id":"ATTR2","name":"Silvana Estrada Tribute"}]}}"#;

fn event_json(id: &str, status: &str, public_start: Option<&str>) -> String {
    let sales = match public_start {
        Some(s) => format!(r#""sales":{{"public":{{"startDateTime":"{s}"}}}},"#),
        None => String::new(),
    };
    format!(
        r#"{{"id":"{id}","name":"Show {id}","url":"https://tm.example/{id}",
        "dates":{{"start":{{"localDate":"2026-11-20","localTime":"20:00:00"}},"status":{{"code":"{status}"}}}},
        {sales}
        "_embedded":{{"venues":[{{"name":"Auditorio","city":{{"name":"CDMX"}},"country":{{"countryCode":"MX"}}}}]}}}}"#
    )
}

fn events_body(events: &[String]) -> String {
    format!(
        r#"{{"_embedded":{{"events":[{}]}},"page":{{"size":200,"totalElements":{n},"totalPages":1,"number":0}}}}"#,
        events.join(","),
        n = events.len()
    )
}

impl Mock {
    fn start(name: &str) -> Mock {
        let dir =
            std::env::temp_dir().join(format!("ticketwatch-e2e-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let shared = Arc::new(Mutex::new(Shared {
            attractions: ONE_ATTRACTION.to_string(),
            events: events_body(&[]),
            hooks: vec![],
            hook_fails: false,
            event_queries: vec![],
        }));
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let s = shared.clone();
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let s = s.clone();
                thread::spawn(move || handle(stream, s));
            }
        });
        Mock { port, shared, dir }
    }

    fn set_events(&self, events: &[String]) {
        self.shared.lock().unwrap().events = events_body(events);
    }

    fn hooks(&self) -> Vec<String> {
        self.shared.lock().unwrap().hooks.clone()
    }

    fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}/discovery/v2", self.port)
    }

    fn hook_url(&self) -> String {
        format!("http://127.0.0.1:{}/hook", self.port)
    }

    fn state_file(&self) -> PathBuf {
        self.dir.join("state.json")
    }

    /// Run the binary once. Env is cleared so host proxy settings can't interfere.
    fn run(&self, extra: &[&str]) -> Output {
        run_bin(&self.base_url(), &self.state_file(), Some(GOOD_KEY), extra)
    }
}

fn run_bin(base_url: &str, state: &Path, key: Option<&str>, extra: &[&str]) -> Output {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_ticketwatch"));
    cmd.env_clear()
        .args([
            "--once",
            "--artist",
            "Silvana Estrada",
            "--base-url",
            base_url,
            "--state-file",
        ])
        .arg(state)
        .args(extra);
    if let Some(k) = key {
        cmd.env("TICKETMASTER_API_KEY", k);
    }
    cmd.output().unwrap()
}

fn out(o: &Output) -> String {
    String::from_utf8_lossy(&o.stdout).into_owned()
}
fn err(o: &Output) -> String {
    String::from_utf8_lossy(&o.stderr).into_owned()
}
fn code(o: &Output) -> i32 {
    o.status.code().unwrap()
}

fn handle(stream: TcpStream, shared: Arc<Mutex<Shared>>) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut request_line = String::new();
    reader.read_line(&mut request_line).unwrap();
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
            break;
        }
        if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            content_length = v.trim().parse().unwrap();
        }
    }
    let mut body = vec![0u8; content_length];
    reader.read_exact(&mut body).unwrap();

    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");
    let (path, query) = target.split_once('?').unwrap_or((target, ""));

    let authed = query
        .split('&')
        .any(|kv| kv == format!("apikey={GOOD_KEY}"));
    let mut s = shared.lock().unwrap();
    let (status, payload) = match (method, path) {
        ("POST", "/hook") if s.hook_fails => (500, "boom".to_string()),
        ("POST", "/hook") => {
            s.hooks.push(String::from_utf8_lossy(&body).into_owned());
            (200, "ok".to_string())
        }
        ("GET", "/discovery/v2/attractions.json" | "/discovery/v2/events.json") if !authed => (
            401,
            r#"{"fault":{"faultstring":"Invalid ApiKey"}}"#.to_string(),
        ),
        ("GET", "/discovery/v2/attractions.json") => (200, s.attractions.clone()),
        ("GET", "/discovery/v2/events.json") => {
            s.event_queries.push(query.to_string());
            (200, s.events.clone())
        }
        _ => (404, "{}".to_string()),
    };
    drop(s);

    let mut stream = stream;
    let _ = write!(
        stream,
        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
        payload.len()
    );
}

#[test]
fn baseline_then_quiet_then_alerts_with_webhook() {
    let m = Mock::start("lifecycle");
    m.set_events(&[event_json("A", "offsale", None)]);

    // First run: baseline, nothing sent. Exact-name match must beat the tribute act.
    let o = m.run(&["--webhook-url", &m.hook_url()]);
    assert_eq!(code(&o), 0, "{}\n{}", out(&o), err(&o));
    assert!(
        out(&o).contains("matched Ticketmaster artist id ATTR1"),
        "{}",
        out(&o)
    );
    assert!(out(&o).contains("first check, 1 event(s)"), "{}", out(&o));
    assert!(m.hooks().is_empty());
    {
        let s = m.shared.lock().unwrap();
        let q = &s.event_queries[0];
        assert!(q.contains("attractionId=ATTR1"), "{q}");
        assert!(q.contains("apikey=good-key"), "{q}");
        assert!(q.contains("locale=*") || q.contains("locale=%2A"), "{q}");
        assert!(!q.contains("countryCode"), "{q}");
    }

    // Same data: quiet.
    let o = m.run(&["--webhook-url", &m.hook_url()]);
    assert_eq!(code(&o), 0);
    assert!(out(&o).contains("no changes"), "{}", out(&o));
    assert!(m.hooks().is_empty());

    // A goes on sale and B is announced: one alert message covering both.
    m.set_events(&[
        event_json("A", "onsale", Some("2026-10-16T16:00:00Z")),
        event_json("B", "offsale", None),
    ]);
    let o = m.run(&["--webhook-url", &m.hook_url()]);
    assert_eq!(code(&o), 0, "{}\n{}", out(&o), err(&o));
    let stdout = out(&o);
    assert!(stdout.contains("NEW EVENT  Show B"), "{stdout}");
    assert!(stdout.contains("status: offsale -> onsale"), "{stdout}");
    assert!(stdout.contains("2026-10-16T16:00:00Z"), "{stdout}");

    let hooks = m.hooks();
    assert_eq!(hooks.len(), 1);
    let payload: serde_json::Value = serde_json::from_str(&hooks[0]).unwrap();
    for field in ["text", "content"] {
        let text = payload[field].as_str().unwrap();
        assert!(
            text.contains("Show B") && text.contains("2 update(s)"),
            "{text}"
        );
    }

    // Already announced: quiet again.
    let o = m.run(&["--webhook-url", &m.hook_url()]);
    assert!(out(&o).contains("no changes"), "{}", out(&o));
    assert_eq!(m.hooks().len(), 1);
}

#[test]
fn failed_webhook_is_retried_on_the_next_run() {
    let m = Mock::start("retry");
    m.set_events(&[event_json("A", "onsale", None)]);
    assert_eq!(code(&m.run(&["--webhook-url", &m.hook_url()])), 0);

    m.set_events(&[
        event_json("A", "onsale", None),
        event_json("B", "onsale", None),
    ]);
    m.shared.lock().unwrap().hook_fails = true;
    let o = m.run(&["--webhook-url", &m.hook_url()]);
    assert_eq!(code(&o), 1);
    assert!(
        err(&o).contains("could not deliver notification"),
        "{}",
        err(&o)
    );
    assert!(
        !err(&o).contains("127.0.0.1"),
        "webhook URL leaked: {}",
        err(&o)
    );

    m.shared.lock().unwrap().hook_fails = false;
    let o = m.run(&["--webhook-url", &m.hook_url()]);
    assert_eq!(code(&o), 0, "{}\n{}", out(&o), err(&o));
    let hooks = m.hooks();
    assert_eq!(hooks.len(), 1, "the missed alert must be delivered now");
    assert!(hooks[0].contains("Show B"));
}

#[test]
fn bad_api_key_is_fatal_and_never_echoed() {
    let m = Mock::start("badkey");
    let o = run_bin(&m.base_url(), &m.state_file(), Some("wrong-key-xyz"), &[]);
    assert_eq!(code(&o), 2);
    assert!(err(&o).contains("rejected the API key"), "{}", err(&o));
    assert!(!err(&o).contains("wrong-key-xyz") && !out(&o).contains("wrong-key-xyz"));
}

#[test]
fn network_errors_do_not_leak_the_api_key() {
    // A port nobody is listening on.
    let closed = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let dir = std::env::temp_dir().join(format!("ticketwatch-e2e-net-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let o = run_bin(
        &format!("http://127.0.0.1:{closed}/discovery/v2"),
        &dir.join("s.json"),
        Some("super-secret-key"),
        &[],
    );
    std::fs::remove_dir_all(&dir).unwrap();
    assert_eq!(code(&o), 1);
    assert!(!err(&o).contains("super-secret-key"), "{}", err(&o));
    assert!(err(&o).contains("failed"), "{}", err(&o));
}

#[test]
fn artist_with_no_page_yet_is_announced_when_it_appears() {
    let m = Mock::start("unresolved");
    m.shared.lock().unwrap().attractions = "{}".to_string();

    let o = m.run(&["--webhook-url", &m.hook_url()]);
    assert_eq!(code(&o), 0, "{}\n{}", out(&o), err(&o));
    assert!(
        out(&o).contains("no Ticketmaster artist page yet"),
        "{}",
        out(&o)
    );

    // Page and first event show up. This must alert, not silently baseline.
    m.shared.lock().unwrap().attractions = ONE_ATTRACTION.to_string();
    m.set_events(&[event_json("A", "onsale", None)]);
    let o = m.run(&["--webhook-url", &m.hook_url()]);
    assert_eq!(code(&o), 0, "{}\n{}", out(&o), err(&o));
    assert!(out(&o).contains("NEW EVENT  Show A"), "{}", out(&o));
    assert_eq!(m.hooks().len(), 1);

    // And only once.
    let o = m.run(&["--webhook-url", &m.hook_url()]);
    assert!(out(&o).contains("no changes"), "{}", out(&o));
    assert_eq!(m.hooks().len(), 1);
}

#[test]
fn country_filter_is_uppercased_and_sent() {
    let m = Mock::start("country");
    let o = m.run(&["--country", "mx"]);
    assert_eq!(code(&o), 0, "{}\n{}", out(&o), err(&o));
    let s = m.shared.lock().unwrap();
    assert!(
        s.event_queries[0].contains("countryCode=MX"),
        "{}",
        s.event_queries[0]
    );
}

#[test]
fn invalid_arguments_are_rejected_before_any_request() {
    let m = Mock::start("args");
    let o = m.run(&["--country", "mexico"]);
    assert_eq!(code(&o), 2);
    assert!(err(&o).contains("2-letter"), "{}", err(&o));

    let o = m.run(&["--interval", "5"]);
    assert_eq!(code(&o), 2, "{}", err(&o));

    let o = run_bin(&m.base_url(), &m.state_file(), None, &[]);
    assert_eq!(code(&o), 2);
    assert!(err(&o).contains("--api-key"), "{}", err(&o));
    assert!(m.shared.lock().unwrap().event_queries.is_empty());
}
