use crate::owner::Owner;
use std::collections::HashMap;
use std::io;
use std::process::Stdio;
use std::sync::{Arc, Condvar, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::runtime::{Builder, Runtime};
use tokio_util::sync::CancellationToken;

// Deliberately no Debug implementation for commands, environment or captured IO.
pub struct Spec {
    pub program: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub input: Vec<u8>,
    pub timeout: Duration,
    pub stdout_limit: usize,
    pub stderr_limit: usize,
    pub owned_tree: bool,
    pub raw_args: Option<String>,
}

pub struct ProcessResult {
    pub reason: &'static str,
    pub returncode: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub elapsed_ms: u64,
    pub pid: Option<u32>,
}

type Listener = Box<dyn FnOnce() + Send>;
#[derive(Default)]
struct TaskState {
    pid: Option<u32>,
    result: Option<Arc<ProcessResult>>,
    listeners: Vec<Listener>,
}

pub struct Task {
    state: Mutex<TaskState>,
    changed: Condvar,
    cancel: CancellationToken,
}

impl Task {
    fn new() -> Self {
        Self {
            state: Mutex::new(TaskState::default()),
            changed: Condvar::new(),
            cancel: CancellationToken::new(),
        }
    }
    pub fn cancel(&self) {
        self.cancel.cancel();
    }
    pub fn pid(&self) -> Option<u32> {
        self.state.lock().unwrap().pid
    }
    pub fn result(&self) -> Option<Arc<ProcessResult>> {
        self.state.lock().unwrap().result.clone()
    }
    pub fn wait(&self, timeout: Option<Duration>, started: bool) -> Option<Arc<ProcessResult>> {
        let state = self.state.lock().unwrap();
        let ready = |state: &TaskState| state.result.is_some() || (started && state.pid.is_some());
        if let Some(timeout) = timeout {
            let (state, _) = self
                .changed
                .wait_timeout_while(state, timeout, |state| !ready(state))
                .unwrap();
            state.result.clone()
        } else {
            self.changed
                .wait_while(state, |state| !ready(state))
                .unwrap()
                .result
                .clone()
        }
    }
    pub fn on_done(&self, listener: Listener) {
        let mut state = self.state.lock().unwrap();
        if state.result.is_some() {
            drop(state);
            listener();
        } else {
            state.listeners.push(listener);
        }
    }
    fn started(&self, pid: u32) {
        self.state.lock().unwrap().pid = Some(pid);
        self.changed.notify_all();
    }
    fn finish(&self, result: ProcessResult) {
        let mut state = self.state.lock().unwrap();
        state.result = Some(Arc::new(result));
        let listeners = std::mem::take(&mut state.listeners);
        self.changed.notify_all();
        drop(state);
        for listener in listeners {
            listener();
        }
    }
}

#[derive(Default)]
struct Engine {
    runtime: Option<Runtime>,
    tasks: Vec<Weak<Task>>,
    stopping: bool,
}
static ENGINE: OnceLock<Mutex<Engine>> = OnceLock::new();

pub fn initialized() -> bool {
    ENGINE
        .get()
        .is_some_and(|engine| engine.lock().unwrap().runtime.is_some())
}

pub fn submit(spec: Spec) -> io::Result<Arc<Task>> {
    if spec.program.is_empty()
        || spec.program.contains('\0')
        || spec.args.iter().any(|arg| arg.contains('\0'))
        || spec.input.len() > 2 * 1024 * 1024
        || spec.stdout_limit > 16 * 1024 * 1024
        || spec.stderr_limit > 16 * 1024 * 1024
        || spec.timeout.is_zero()
        || spec.timeout > Duration::from_secs(86400)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Invalid execution specification",
        ));
    }
    let mut engine = ENGINE.get_or_init(Default::default).lock().unwrap();
    if engine.stopping {
        return Err(io::Error::other("Executor has stopped"));
    }
    if engine.runtime.is_none() {
        engine.runtime = Some(
            Builder::new_multi_thread()
                .worker_threads(2)
                .thread_name("hoploom-executor")
                .enable_all()
                .build()?,
        );
    }
    let task = Arc::new(Task::new());
    engine.tasks.retain(|task| task.strong_count() > 0);
    engine.tasks.push(Arc::downgrade(&task));
    let running = task.clone();
    let deadline = Instant::now() + spec.timeout;
    engine.runtime.as_ref().unwrap().spawn(async move {
        let result = execute(spec, &running, deadline).await;
        running.finish(result);
    });
    Ok(task)
}

/// Called with Python detached during interpreter shutdown. No new operations
/// are accepted while request trees and callbacks are being collected.
pub fn shutdown() {
    let Some(lock) = ENGINE.get() else { return };
    let (runtime, tasks) = {
        let mut engine = lock.lock().unwrap();
        engine.stopping = true;
        (
            engine.runtime.take(),
            engine
                .tasks
                .iter()
                .filter_map(Weak::upgrade)
                .collect::<Vec<_>>(),
        )
    };
    for task in &tasks {
        task.cancel();
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    for task in &tasks {
        task.wait(
            Some(deadline.saturating_duration_since(Instant::now())),
            false,
        );
    }
    if let Some(runtime) = runtime {
        runtime.shutdown_timeout(Duration::from_secs(2));
    }
}

async fn read_bounded<R: AsyncRead + Unpin>(
    mut pipe: R,
    limit: usize,
    exceeded: CancellationToken,
) -> io::Result<Vec<u8>> {
    let mut output = Vec::new();
    let mut buffer = [0u8; 65536];
    loop {
        let count = pipe.read(&mut buffer).await?;
        if count == 0 {
            return Ok(output);
        }
        let room = limit - output.len();
        output.extend_from_slice(&buffer[..count.min(room)]);
        if count > room {
            exceeded.cancel();
            return Ok(output);
        }
    }
}

async fn execute(spec: Spec, task: &Task, deadline: Instant) -> ProcessResult {
    let start = Instant::now();
    let mut result = ProcessResult {
        reason: "spawn_failed",
        returncode: None,
        stdout: Vec::new(),
        stderr: Vec::new(),
        elapsed_ms: 0,
        pid: None,
    };
    if task.cancel.is_cancelled() {
        result.reason = "canceled";
        return result;
    }
    if Instant::now() >= deadline {
        result.reason = "timeout";
        return result;
    }
    let mut command = Command::new(&spec.program);
    #[cfg(windows)]
    if let Some(raw) = &spec.raw_args {
        use std::os::windows::process::CommandExt;
        command.as_std_mut().raw_arg(raw);
    } else {
        command.args(&spec.args);
    }
    #[cfg(not(windows))]
    {
        if spec.raw_args.is_some() {
            return result;
        }
        command.args(&spec.args);
    }
    command
        .env_clear()
        .envs(&spec.env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    Owner::configure(&mut command, spec.owned_tree);
    let Ok(mut child) = command.spawn() else {
        return result;
    };
    result.pid = child.id();
    let Ok(mut owner) = Owner::attach(&child, spec.owned_tree) else {
        let _ = child.kill().await;
        return result;
    };
    task.started(child.id().unwrap());
    let exceeded = CancellationToken::new();
    let mut out = tokio::spawn(read_bounded(
        child.stdout.take().unwrap(),
        spec.stdout_limit,
        exceeded.clone(),
    ));
    let mut err = tokio::spawn(read_bounded(
        child.stderr.take().unwrap(),
        spec.stderr_limit,
        exceeded.clone(),
    ));
    let mut stdin = child.stdin.take().unwrap();
    let mut writer = tokio::spawn(async move {
        let _ = stdin.write_all(&spec.input).await;
        let _ = stdin.shutdown().await;
    });
    result.reason = tokio::select! {
        biased;
        _ = task.cancel.cancelled() => "canceled",
        _ = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => "timeout",
        _ = exceeded.cancelled() => "output_limit",
        status = child.wait() => {
            match status {
                Ok(status) => {
                    result.returncode = status.code();
                    #[cfg(unix)]
                    { use std::os::unix::process::ExitStatusExt; if let Some(signal) = status.signal() { result.returncode = Some(-signal); } }
                    "exit"
                },
                Err(_) => "spawn_failed",
            }
        }
    };
    if owner.stop(&mut child).await.is_err() {
        result.reason = "cleanup_failed";
    }
    if result.returncode.is_none() {
        result.returncode = child.try_wait().ok().flatten().and_then(|status| {
            #[cfg(unix)]
            {
                use std::os::unix::process::ExitStatusExt;
                status
                    .code()
                    .or_else(|| status.signal().map(|signal| -signal))
            }
            #[cfg(not(unix))]
            {
                status.code()
            }
        });
    }
    let outputs = tokio::time::timeout(Duration::from_secs(3), async {
        tokio::join!(&mut out, &mut err, &mut writer)
    })
    .await;
    match outputs {
        Ok((Ok(Ok(stdout)), Ok(Ok(stderr)), Ok(()))) => {
            result.stdout = stdout;
            result.stderr = stderr;
        }
        _ => {
            out.abort();
            err.abort();
            writer.abort();
            result.reason = "cleanup_failed";
        }
    }
    if result.reason == "exit" && exceeded.is_cancelled() {
        result.reason = "output_limit";
    }
    if result.reason != "exit" {
        result.returncode = None;
    }
    result.elapsed_ms = start.elapsed().as_millis() as u64;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn shell(code: &str) -> Spec {
        #[cfg(unix)]
        let (program, args) = ("/bin/sh", vec!["-c".into(), code.into()]);
        #[cfg(windows)]
        let (program, args) = ("cmd.exe", vec!["/C".into(), code.into()]);
        Spec {
            program: program.into(),
            args,
            env: std::env::vars().collect(),
            input: Vec::new(),
            timeout: Duration::from_secs(3),
            stdout_limit: 1024,
            stderr_limit: 1024,
            owned_tree: true,
            raw_args: None,
        }
    }
    #[test]
    fn captures_exit_and_missing_program() {
        let task = submit(shell("echo hello")).unwrap();
        let result = task.wait(Some(Duration::from_secs(5)), false).unwrap();
        assert_eq!(result.reason, "exit");
        assert_eq!(result.returncode, Some(0));
        assert!(String::from_utf8_lossy(&result.stdout).contains("hello"));
        let mut spec = shell("");
        spec.program = "hoploom-deliberately-missing-program".into();
        assert_eq!(
            submit(spec)
                .unwrap()
                .wait(Some(Duration::from_secs(5)), false)
                .unwrap()
                .reason,
            "spawn_failed"
        );
    }
    #[test]
    #[cfg(unix)]
    fn output_limits_cancel_and_timeout_are_distinct() {
        let task = submit(shell(
            "while :; do printf xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done",
        ))
        .unwrap();
        let result = task.wait(Some(Duration::from_secs(5)), false).unwrap();
        assert_eq!(result.reason, "output_limit");
        assert!(result.stdout.len() <= 1024);
        let task = submit(shell("sleep 60")).unwrap();
        task.cancel();
        assert_eq!(
            task.wait(Some(Duration::from_secs(5)), false)
                .unwrap()
                .reason,
            "canceled"
        );
        let mut spec = shell("sleep 60");
        spec.timeout = Duration::from_millis(20);
        assert_eq!(
            submit(spec)
                .unwrap()
                .wait(Some(Duration::from_secs(5)), false)
                .unwrap()
                .reason,
            "timeout"
        );
    }
}
