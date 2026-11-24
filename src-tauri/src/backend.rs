use serde::Deserialize;
use std::{
    fs,
    io::{BufRead, BufReader, Read},
    os::unix::{fs::PermissionsExt, process::CommandExt},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc::{self, RecvTimeoutError, Sender},
    thread,
    time::{Duration, Instant},
};
use tauri::Url;

const STARTUP_TIMEOUT: Duration = Duration::from_secs(12);
const EXIT_TIMEOUT: Duration = Duration::from_secs(3);
const TICK: Duration = Duration::from_millis(60);
const MAX_LINE: u64 = 64 * 1024;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(try_from = "String")]
pub struct Supplier(String);

impl Supplier {
    fn valid(value: &str) -> bool {
        matches!(value, "A" | "B")
            || (value.len() == 13
                && value.starts_with('p')
                && value
                    .bytes()
                    .skip(1)
                    .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')))
    }

    pub fn label(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for Supplier {
    type Error = &'static str;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        if Self::valid(&value) {
            Ok(Self(value))
        } else {
            Err("invalid supplier ID")
        }
    }
}

#[derive(Debug)]
pub struct Session(Url);

impl Session {
    fn parse(value: &str) -> Option<Self> {
        let url = Url::parse(value).ok()?;
        let key = url.path().strip_prefix("/ui/")?.strip_suffix('/')?;
        if url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || url.port() != Some(17880)
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || key.len() != 43
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return None;
        }
        Some(Self(url))
    }

    pub fn url(&self, supplier: Option<Supplier>) -> Url {
        let mut url = self.0.clone();
        let fragment = supplier.map(|id| format!("import-{}", id.label()));
        url.set_fragment(fragment.as_deref());
        url
    }

    pub fn allows(&self, url: &Url) -> bool {
        if url
            .fragment()
            .is_some_and(|value| !value.strip_prefix("import-").is_some_and(Supplier::valid))
        {
            return false;
        }
        let mut base = url.clone();
        base.set_fragment(None);
        base == self.0
    }
}

#[derive(Deserialize)]
#[serde(tag = "event", rename_all = "lowercase")]
enum Message {
    Ready {
        url: String,
    },
    Alert {
        id: String,
        supplier: Supplier,
        message: String,
    },
    Error {
        message: String,
    },
}

enum Action {
    Start,
    Shutdown,
    Message(u64, Message),
}

pub enum Status {
    Starting,
    Ready(Session),
    Alert {
        id: String,
        supplier: Supplier,
        message: String,
    },
    Failed(String),
    Stopped,
}

struct Running {
    child: Child,
    id: u64,
    started: Instant,
    ready: bool,
}

#[derive(Clone)]
pub struct Supervisor(Sender<Action>);

impl Supervisor {
    pub fn new(directory: PathBuf, update: impl Fn(Status) + Send + 'static) -> Self {
        let (tx, rx) = mpsc::channel();
        let worker = tx.clone();
        thread::spawn(move || {
            let mut running: Option<Running> = None;
            let mut id = 0;
            loop {
                match rx.recv_timeout(TICK) {
                    Ok(Action::Shutdown) | Err(RecvTimeoutError::Disconnected) => {
                        if let Some(mut run) = running.take() {
                            stop(&mut run.child);
                        }
                        update(Status::Stopped);
                        break;
                    }
                    Ok(Action::Start) if running.is_none() => {
                        update(Status::Starting);
                        id += 1;
                        match launch(&directory, worker.clone(), id) {
                            Ok(child) => {
                                running = Some(Running {
                                    child,
                                    id,
                                    started: Instant::now(),
                                    ready: false,
                                })
                            }
                            Err(message) => update(Status::Failed(message)),
                        }
                    }
                    Ok(Action::Message(id, message))
                        if running.as_ref().is_some_and(|run| run.id == id) =>
                    {
                        match message {
                            Message::Ready { url } if !running.as_ref().unwrap().ready => {
                                if let Some(session) = Session::parse(&url) {
                                    running.as_mut().unwrap().ready = true;
                                    update(Status::Ready(session));
                                } else {
                                    fail(
                                        &mut running,
                                        &update,
                                        "本机服务返回了无效的界面地址。".into(),
                                    );
                                }
                            }
                            Message::Alert {
                                id,
                                supplier,
                                message,
                            } if running.as_ref().unwrap().ready => {
                                if id.len() <= 80 && !id.is_empty() && message.len() <= 1024 {
                                    update(Status::Alert {
                                        id,
                                        supplier,
                                        message,
                                    });
                                }
                            }
                            Message::Error { message } => {
                                fail(&mut running, &update, message.chars().take(180).collect());
                            }
                            _ => {}
                        }
                    }
                    _ => {}
                }
                if let Some(run) = running.as_mut() {
                    if !run.ready && run.started.elapsed() >= STARTUP_TIMEOUT {
                        fail(&mut running, &update, "本机服务启动超时。".into());
                    } else if run.ready && !matches!(run.child.try_wait(), Ok(None)) {
                        fail(&mut running, &update, "本机服务已停止。".into());
                    }
                }
            }
        });
        Self(tx)
    }

    pub fn start(&self) {
        let _ = self.0.send(Action::Start);
    }

    pub fn shutdown(&self) -> bool {
        self.0.send(Action::Shutdown).is_ok()
    }
}

fn fail(running: &mut Option<Running>, update: &impl Fn(Status), reason: String) {
    if let Some(mut run) = running.take() {
        stop(&mut run.child);
    }
    update(Status::Failed(reason));
}

fn node_path(directory: &Path) -> Option<PathBuf> {
    let recorded = fs::read_to_string(directory.join("node-path.txt"))
        .ok()
        .map(|path| PathBuf::from(path.trim()));
    recorded
        .into_iter()
        .chain([
            PathBuf::from("/opt/homebrew/bin/node"),
            PathBuf::from("/usr/local/bin/node"),
        ])
        .find(|path| {
            path.is_absolute()
                && fs::metadata(path)
                    .is_ok_and(|data| data.is_file() && data.permissions().mode() & 0o111 != 0)
        })
}

fn launch(directory: &Path, tx: Sender<Action>, id: u64) -> Result<Child, String> {
    let node = node_path(directory)
        .ok_or_else(|| "找不到 Node.js。请安装 Node.js 22.12 或更新版本。".to_string())?;
    let mut child = Command::new(node)
        .current_dir(directory)
        .arg(directory.join("server.mjs"))
        .arg("--desktop")
        .process_group(0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "无法启动本机服务。请检查 Node.js 和应用包。".to_string())?;
    let output = child.stdout.take().expect("configured stdout pipe");
    thread::spawn(move || {
        let mut reader = BufReader::new(output);
        let mut line = Vec::new();
        loop {
            line.clear();
            match reader
                .by_ref()
                .take(MAX_LINE + 1)
                .read_until(b'\n', &mut line)
            {
                Ok(0) => {
                    // EOF arrives after the last pending line, so a specific startup error wins.
                    let _ = tx.send(Action::Message(
                        id,
                        Message::Error {
                            message: "本机服务已退出。请检查 Node.js 版本和应用配置。".into(),
                        },
                    ));
                    break;
                }
                Ok(count) if count as u64 <= MAX_LINE => {
                    if let Ok(event) = serde_json::from_slice::<Message>(&line) {
                        if tx.send(Action::Message(id, event)).is_err() {
                            break;
                        }
                    }
                }
                _ => {
                    let _ = tx.send(Action::Message(
                        id,
                        Message::Error {
                            message: "本机服务输出无法读取。".into(),
                        },
                    ));
                    break;
                }
            }
        }
    });
    Ok(child)
}

fn stop(child: &mut Child) {
    if !matches!(child.try_wait(), Ok(None)) {
        return;
    }
    let group = -(child.id() as libc::pid_t);
    // This process is the owner of a group created by Command::process_group(0).
    unsafe { libc::kill(group, libc::SIGTERM) };
    drop(child.stdin.take());
    let deadline = Instant::now() + EXIT_TIMEOUT;
    while Instant::now() < deadline {
        if !matches!(child.try_wait(), Ok(None)) {
            return;
        }
        thread::sleep(TICK);
    }
    unsafe { libc::kill(group, libc::SIGKILL) };
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;

    #[test]
    fn only_the_owned_loopback_session_and_supplier_fragments_are_allowed() {
        let key = "a".repeat(43);
        let allowed = format!("http://127.0.0.1:17880/ui/{key}/");
        let session = Session::parse(&allowed).unwrap();
        for id in ["B", "p1234abcd5678"] {
            let supplier = Supplier::try_from(id.to_string()).unwrap();
            assert!(session.allows(&session.url(Some(supplier))));
        }
        for invalid in [
            "http://localhost:17880",
            "http://127.0.0.1:17881",
            "https://127.0.0.1:17880",
        ] {
            assert!(Session::parse(&format!("{invalid}/ui/{key}/")).is_none());
        }
        for invalid in [
            format!("{allowed}?x=1"),
            format!("{allowed}#other"),
            format!("{allowed}#import-pbad"),
            format!("{allowed}api/state"),
        ] {
            assert!(!session.allows(&Url::parse(&invalid).unwrap()));
        }
    }

    #[test]
    fn reaps_a_child_that_ignores_graceful_shutdown() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "trap '' TERM; echo ready; while :; do sleep 1; done"])
            .process_group(0)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut ready = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut ready)
            .unwrap();
        assert_eq!(ready.trim(), "ready");
        let started = Instant::now();
        stop(&mut child);
        assert_eq!(
            child.try_wait().unwrap().unwrap().signal(),
            Some(libc::SIGKILL)
        );
        assert!(started.elapsed() >= EXIT_TIMEOUT);
        assert!(started.elapsed() < EXIT_TIMEOUT + Duration::from_secs(2));
    }
}
