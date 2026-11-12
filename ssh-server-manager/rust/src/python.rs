use crate::engine::{self, Spec, Task};
use pyo3::exceptions::{PyRuntimeError, PyTimeoutError, PyValueError};
use pyo3::prelude::*;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

type ResultTuple = (String, Option<i32>, Vec<u8>, Vec<u8>, u64, Option<u32>);

#[pyclass(module = "ssh_server_manager._native")]
struct TaskHandle {
    task: Arc<Task>,
}

#[pymethods]
impl TaskHandle {
    fn cancel(&self) {
        self.task.cancel();
    }
    #[getter]
    fn pid(&self) -> Option<u32> {
        self.task.pid()
    }
    #[pyo3(signature = (timeout=None))]
    fn wait(&self, py: Python<'_>, timeout: Option<f64>) -> PyResult<ResultTuple> {
        let limit = wait_limit(timeout)?;
        let result = py
            .detach(|| self.task.wait(limit, false))
            .ok_or_else(|| PyTimeoutError::new_err("The execution result is not ready"))?;
        Ok((
            result.reason.into(),
            result.returncode,
            result.stdout.clone(),
            result.stderr.clone(),
            result.elapsed_ms,
            result.pid,
        ))
    }
    #[pyo3(signature = (timeout=None))]
    fn wait_started(&self, py: Python<'_>, timeout: Option<f64>) -> PyResult<Option<u32>> {
        let limit = wait_limit(timeout)?;
        py.detach(|| self.task.wait(limit, true));
        if self.task.pid().is_none() && self.task.result().is_none() {
            return Err(PyTimeoutError::new_err("The execution has not started"));
        }
        Ok(self.task.pid())
    }
    fn add_done_callback(&self, callback: Py<PyAny>) {
        self.task.on_done(Box::new(move || {
            // Interpreter shutdown cancels and joins tasks while detached.
            // try_attach also avoids attaching after finalization has begun.
            Python::try_attach(|py| {
                let _ = callback.call0(py);
            });
        }));
    }
}

fn wait_limit(timeout: Option<f64>) -> PyResult<Option<Duration>> {
    timeout
        .map(|timeout| {
            if !timeout.is_finite() || !(0.0..=86400.0).contains(&timeout) {
                Err(PyValueError::new_err("Invalid wait timeout"))
            } else {
                Ok(Duration::from_secs_f64(timeout))
            }
        })
        .transpose()
}

#[pyfunction]
#[pyo3(signature = (program, args, env, input, timeout, stdout_limit, stderr_limit, owned_tree, raw_args=None))]
// Each argument is one field of the private ExecutionSpec wire contract.
#[allow(clippy::too_many_arguments)]
fn start(
    program: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    input: Vec<u8>,
    timeout: f64,
    stdout_limit: usize,
    stderr_limit: usize,
    owned_tree: bool,
    raw_args: Option<String>,
) -> PyResult<TaskHandle> {
    if !timeout.is_finite() || timeout <= 0.0 || timeout > 86400.0 {
        return Err(PyValueError::new_err("Invalid execution timeout"));
    }
    let spec = Spec {
        program,
        args,
        env,
        input,
        timeout: Duration::from_secs_f64(timeout),
        stdout_limit,
        stderr_limit,
        owned_tree,
        raw_args,
    };
    engine::submit(spec)
        .map(|task| TaskHandle { task })
        .map_err(|_| PyRuntimeError::new_err("Cannot start the selected executor"))
}

#[pyfunction]
fn shutdown(py: Python<'_>) {
    py.detach(engine::shutdown);
}

#[pyfunction]
fn initialized() -> bool {
    engine::initialized()
}

#[pymodule]
fn _native(module: &Bound<'_, PyModule>) -> PyResult<()> {
    module.add_class::<TaskHandle>()?;
    module.add_function(wrap_pyfunction!(start, module)?)?;
    module.add_function(wrap_pyfunction!(shutdown, module)?)?;
    module.add_function(wrap_pyfunction!(initialized, module)?)?;
    module.add("version", env!("CARGO_PKG_VERSION"))?;
    module.add("worker_threads", 2)?;
    Ok(())
}
