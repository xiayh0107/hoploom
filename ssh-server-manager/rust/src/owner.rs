use std::io;
use std::time::Duration;
use tokio::process::{Child, Command};

pub struct Owner {
    pid: u32,
    tree: bool,
    stopped: bool,
    #[cfg(windows)]
    job: windows_sys::Win32::Foundation::HANDLE,
}
// A job HANDLE is an OS reference owned by this object, never a borrowed pointer.
#[cfg(windows)]
unsafe impl Send for Owner {}

#[cfg(windows)]
struct ProcessHandles(Vec<windows_sys::Win32::Foundation::HANDLE>);
// These are owned synchronization references, closed only after polling ends.
#[cfg(windows)]
unsafe impl Send for ProcessHandles {}
#[cfg(windows)]
impl Drop for ProcessHandles {
    fn drop(&mut self) {
        for handle in &self.0 {
            unsafe { windows_sys::Win32::Foundation::CloseHandle(*handle) };
        }
    }
}

impl Owner {
    pub fn configure(command: &mut Command, tree: bool) {
        if !tree {
            return;
        }
        #[cfg(unix)]
        command.process_group(0);
        #[cfg(windows)]
        command.creation_flags(0x00000200 | 0x00000004); // NEW_PROCESS_GROUP | SUSPENDED
    }
    pub fn attach(child: &Child, tree: bool) -> io::Result<Self> {
        let owner = Self {
            pid: child.id().unwrap(),
            tree,
            stopped: false,
            #[cfg(windows)]
            job: std::ptr::null_mut(),
        };
        #[cfg(windows)]
        {
            let mut owner = owner;
            if tree {
                owner.attach_job()?;
            }
            Ok(owner)
        }
        #[cfg(not(windows))]
        {
            Ok(owner)
        }
    }
    pub async fn stop(&mut self, child: &mut Child) -> io::Result<()> {
        #[cfg(unix)]
        if self.tree {
            self.signal_group(child, libc::SIGTERM).await?;
            let _ = tokio::time::timeout(Duration::from_millis(250), child.wait()).await;
            self.signal_group(child, libc::SIGKILL).await?;
        }
        #[cfg(windows)]
        if self.tree {
            self.stop_job().await?;
        }
        if !self.tree && child.try_wait()?.is_none() {
            child.start_kill()?;
        }
        tokio::time::timeout(Duration::from_secs(3), child.wait())
            .await
            .map_err(|_| {
                io::Error::new(io::ErrorKind::TimedOut, "Request process cleanup timed out")
            })??;
        self.stopped = true;
        Ok(())
    }
    #[cfg(unix)]
    async fn signal_group(&self, child: &mut Child, signal: i32) -> io::Result<()> {
        // This PGID was created for this request by Command::process_group(0).
        let sent = unsafe { libc::kill(-(self.pid as i32), signal) };
        if sent == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(());
        }
        if error.raw_os_error() != Some(libc::EPERM) {
            return Err(error);
        }
        // macOS may refuse signals to an exited, unreaped group. Reap our
        // root, then prove there are no live group members before accepting it.
        let _ = child.try_wait()?;
        let output = tokio::time::timeout(
            Duration::from_secs(1),
            Command::new("ps")
                .args(["-axo", "pid=,pgid=,stat="])
                .output(),
        )
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "Request group check timed out"))??;
        if !output.status.success() {
            return Err(error);
        }
        let group = self.pid.to_string();
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let columns: Vec<_> = line.split_whitespace().collect();
            if columns.len() >= 3 && columns[1] == group && !columns[2].starts_with('Z') {
                return Err(error);
            }
        }
        Ok(())
    }
}

impl Drop for Owner {
    fn drop(&mut self) {
        #[cfg(unix)]
        if self.tree && !self.stopped {
            unsafe {
                libc::kill(-(self.pid as i32), libc::SIGKILL);
            }
        }
        #[cfg(windows)]
        if !self.job.is_null() {
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(self.job);
            }
        }
    }
}

#[cfg(windows)]
impl Owner {
    fn attach_job(&mut self) -> io::Result<()> {
        use std::mem::{size_of, zeroed};
        use windows_sys::Win32::{
            Foundation::*,
            System::{Diagnostics::ToolHelp::*, JobObjects::*, Threading::*},
        };
        unsafe {
            self.job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if self.job.is_null() {
                return Err(io::Error::last_os_error());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                self.job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, self.pid);
            if process.is_null() {
                return Err(io::Error::last_os_error());
            }
            let assigned = AssignProcessToJobObject(self.job, process);
            CloseHandle(process);
            if assigned == 0 {
                return Err(io::Error::last_os_error());
            }
            // The suspended child has exactly one thread. Attach the job
            // before resuming it so no helper can escape ownership at launch.
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error());
            }
            let mut entry: THREADENTRY32 = zeroed();
            entry.dwSize = size_of::<THREADENTRY32>() as u32;
            let mut found = Thread32First(snapshot, &mut entry);
            let mut threads = Vec::new();
            while found != 0 {
                if entry.th32OwnerProcessID == self.pid {
                    threads.push(entry.th32ThreadID);
                }
                entry.dwSize = size_of::<THREADENTRY32>() as u32;
                found = Thread32Next(snapshot, &mut entry);
            }
            CloseHandle(snapshot);
            if threads.len() != 1 {
                return Err(io::Error::other("Suspended primary thread unavailable"));
            }
            let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, threads[0]);
            if thread.is_null() {
                return Err(io::Error::last_os_error());
            }
            let resumed = ResumeThread(thread);
            CloseHandle(thread);
            if resumed != 1 {
                return Err(io::Error::other("Primary thread resume failed"));
            }
        }
        Ok(())
    }
    fn job_members(&self) -> io::Result<ProcessHandles> {
        use std::mem::{size_of, zeroed};
        use windows_sys::Win32::{
            Foundation::{ERROR_INVALID_PARAMETER, ERROR_MORE_DATA},
            System::{JobObjects::*, Threading::*},
        };
        unsafe {
            // Seal creation before enumerating. Retain KILL_ON_JOB_CLOSE;
            // lowering the active limit does not remove existing members.
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            limits.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
            limits.BasicLimitInformation.ActiveProcessLimit = 1;
            if SetInformationJobObject(
                self.job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
            let mut capacity = 16;
            while capacity <= 65536 {
                // u64 storage keeps the variable-length structure aligned.
                let mut buffer = vec![0_u64; 1 + capacity];
                let list = buffer.as_mut_ptr() as *mut JOBOBJECT_BASIC_PROCESS_ID_LIST;
                let ok = QueryInformationJobObject(
                    self.job,
                    JobObjectBasicProcessIdList,
                    list as _,
                    (buffer.len() * size_of::<u64>()) as u32,
                    std::ptr::null_mut(),
                );
                let count = (*list).NumberOfProcessIdsInList as usize;
                let assigned = (*list).NumberOfAssignedProcesses as usize;
                if ok != 0 && count <= capacity && assigned <= capacity {
                    let mut members = ProcessHandles(Vec::with_capacity(count));
                    for pid in std::slice::from_raw_parts((*list).ProcessIdList.as_ptr(), count) {
                        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, *pid as u32);
                        if !handle.is_null() {
                            members.0.push(handle);
                        } else {
                            let error = io::Error::last_os_error();
                            if error.raw_os_error() != Some(ERROR_INVALID_PARAMETER as i32) {
                                return Err(error);
                            }
                        }
                    }
                    return Ok(members);
                }
                if ok == 0 {
                    let error = io::Error::last_os_error();
                    if error.raw_os_error() != Some(ERROR_MORE_DATA as i32) {
                        return Err(error);
                    }
                }
                capacity = (capacity * 2).max(assigned);
            }
        }
        Err(io::Error::other(
            "Request job membership exceeds cleanup limit",
        ))
    }
    async fn stop_job(&mut self) -> io::Result<()> {
        use std::mem::{size_of, zeroed};
        use windows_sys::Win32::{
            Foundation::{WAIT_FAILED, WAIT_OBJECT_0},
            System::{JobObjects::*, Threading::WaitForSingleObject},
        };
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        let members = self.job_members()?;
        if unsafe { TerminateJobObject(self.job, 1) } == 0 {
            return Err(io::Error::last_os_error());
        }
        loop {
            let mut exited = true;
            for handle in &members.0 {
                let status = unsafe { WaitForSingleObject(*handle, 0) };
                if status == WAIT_FAILED {
                    return Err(io::Error::last_os_error());
                }
                exited &= status == WAIT_OBJECT_0;
            }
            let mut status: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
            if unsafe {
                QueryInformationJobObject(
                    self.job,
                    JobObjectBasicAccountingInformation,
                    &mut status as *mut _ as _,
                    size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                    std::ptr::null_mut(),
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            if exited && status.ActiveProcesses == 0 {
                return Ok(());
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "Request job cleanup timed out",
                ));
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}
