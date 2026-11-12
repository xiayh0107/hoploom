//! Request-owned process execution. Business policy and authentication remain
//! in Python; this crate never opens the host database or credential vault.
mod engine;
mod owner;
#[cfg(feature = "python")]
mod python;

pub use engine::{ProcessResult, Spec, Task, initialized, shutdown, submit};
