"""Own only the process tree started for one executor task.

Shared OpenSSH masters must be started in a separate lifetime before selecting
tree ownership. A caller using a pre-existing shared group can select process
ownership explicitly; that compatibility path never sends a group signal.
"""
from __future__ import annotations

import os
import signal
import subprocess
import time
from typing import Any


class ProcessOwner:
    def __init__(self, command: list[str] | str, *, env: dict[str, str], tree: bool = True) -> None:
        self.tree = tree
        self.job: tuple[Any, Any] | None = None
        self._job_limits: Any = None
        options: dict[str, Any] = {}
        if tree:
            options = ({"start_new_session": True} if os.name != "nt" else
                       {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP | 0x00000004})
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, env=env, **options)
        if tree and os.name == "nt":
            try:
                self._attach_windows_job()
            except Exception:
                self.close()
                raise OSError("Cannot establish ownership of the request process") from None

    def stop(self) -> None:
        process = self.process
        if self.job is not None:
            kernel, job = self.job
            deadline = time.monotonic() + 3
            members = self._windows_members(kernel, job)
            try:
                if not kernel.TerminateJobObject(job, 1):
                    raise OSError("Cannot terminate the request job")
                # Termination and accounting updates do not prove that each
                # process handle is signaled. Retain and wait on the members.
                for member in members:
                    remaining = max(0, round((deadline - time.monotonic()) * 1000))
                    if kernel.WaitForSingleObject(member, remaining) != 0:
                        raise OSError("Request process cleanup deadline exceeded")
                process.wait(timeout=max(0, deadline - time.monotonic()))
            finally:
                for member in members:
                    kernel.CloseHandle(member)
            self._wait_empty_job(kernel, job, deadline)
            return
        if self.tree and os.name != "nt":
            self._signal_group(signal.SIGTERM)
            try:
                process.wait(timeout=0.25)
            except subprocess.TimeoutExpired:
                pass
            # Reap descendants even if their parent already exited. Output
            # readers must not be left waiting on an inherited write handle.
            self._signal_group(signal.SIGKILL)
        elif process.poll() is None:
            process.kill()
        process.wait(timeout=3)

    def _signal_group(self, number: int) -> None:
        try:
            os.killpg(self.process.pid, number)
        except ProcessLookupError:
            return
        except PermissionError:
            # macOS can report EPERM for a group containing only an exited,
            # unreaped process. Reap our child and prove there is no live group
            # member; a genuine permission failure must still fail cleanup.
            self.process.poll()
            result = subprocess.run(["ps", "-axo", "pid=,pgid=,stat="], capture_output=True, text=True,
                                    timeout=1, check=True)
            for line in result.stdout.splitlines():
                fields = line.split()
                if len(fields) >= 3 and fields[1] == str(self.process.pid) and not fields[2].startswith("Z"):
                    raise

    def close(self) -> None:
        try:
            self.stop()
        finally:
            if self.job is not None:
                kernel, job = self.job
                self.job = None
                kernel.CloseHandle(job)

    def _attach_windows_job(self) -> None:
        import ctypes
        from ctypes import wintypes

        class BasicLimit(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                        ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                        ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]

        class IO(ctypes.Structure):
            _fields_ = [(name, ctypes.c_uint64) for name in ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                                                          "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

        class ExtendedLimit(ctypes.Structure):
            _fields_ = [("BasicLimitInformation", BasicLimit), ("IoInfo", IO), ("ProcessMemoryLimit", ctypes.c_size_t),
                        ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t),
                        ("PeakJobMemoryUsed", ctypes.c_size_t)]

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        kernel.CreateJobObjectW.restype = wintypes.HANDLE
        kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        kernel.SetInformationJobObject.restype = wintypes.BOOL
        kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel.AssignProcessToJobObject.restype = wintypes.BOOL
        kernel.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
        kernel.TerminateJobObject.restype = wintypes.BOOL
        kernel.QueryInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p]
        kernel.QueryInformationJobObject.restype = wintypes.BOOL
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.WaitForSingleObject.restype = wintypes.DWORD
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL
        job = kernel.CreateJobObjectW(None, None)
        if not job:
            raise OSError("Job creation failed")
        limits = ExtendedLimit()
        limits.BasicLimitInformation.LimitFlags = 0x2000
        if not kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            kernel.CloseHandle(job)
            raise OSError("Job policy failed")
        if not kernel.AssignProcessToJobObject(job, wintypes.HANDLE(int(self.process._handle))):
            kernel.CloseHandle(job)
            raise OSError("Job assignment failed")
        self.job = (kernel, job)
        self._job_limits = limits

        class ThreadEntry(ctypes.Structure):
            _fields_ = [(name, wintypes.DWORD) for name in ("dwSize", "cntUsage", "th32ThreadID", "th32OwnerProcessID")] + [
                ("tpBasePri", wintypes.LONG), ("tpDeltaPri", wintypes.LONG), ("dwFlags", wintypes.DWORD)]

        kernel.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
        kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
        kernel.Thread32First.argtypes = [wintypes.HANDLE, ctypes.POINTER(ThreadEntry)]
        kernel.Thread32Next.argtypes = [wintypes.HANDLE, ctypes.POINTER(ThreadEntry)]
        kernel.OpenThread.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenThread.restype = wintypes.HANDLE
        kernel.ResumeThread.argtypes = [wintypes.HANDLE]
        kernel.ResumeThread.restype = wintypes.DWORD
        snapshot = kernel.CreateToolhelp32Snapshot(0x00000004, 0)
        if snapshot == ctypes.c_void_p(-1).value:
            raise OSError("Thread snapshot failed")
        try:
            entry = ThreadEntry(); entry.dwSize = ctypes.sizeof(entry)
            found = kernel.Thread32First(snapshot, ctypes.byref(entry))
            threads = []
            while found:
                if entry.th32OwnerProcessID == self.process.pid:
                    threads.append(entry.th32ThreadID)
                entry.dwSize = ctypes.sizeof(entry)
                found = kernel.Thread32Next(snapshot, ctypes.byref(entry))
            if len(threads) != 1:
                raise OSError("Suspended primary thread unavailable")
            thread = kernel.OpenThread(0x0002, False, threads[0])
            if not thread:
                raise OSError("Primary thread unavailable")
            try:
                if kernel.ResumeThread(thread) != 1:
                    raise OSError("Primary thread resume failed")
            finally:
                kernel.CloseHandle(thread)
        finally:
            kernel.CloseHandle(snapshot)

    def _windows_members(self, kernel: Any, job: Any) -> list[Any]:
        import ctypes
        from ctypes import wintypes

        # Block new children before taking the snapshot. Existing members may
        # exceed this limit; none can successfully add another live process.
        self._job_limits.BasicLimitInformation.LimitFlags |= 0x00000008
        self._job_limits.BasicLimitInformation.ActiveProcessLimit = 1
        if not kernel.SetInformationJobObject(job, 9, ctypes.byref(self._job_limits), ctypes.sizeof(self._job_limits)):
            raise OSError("Cannot seal the request job")
        capacity = 16
        while capacity <= 65536:
            class ProcessIds(ctypes.Structure):
                _fields_ = [("assigned", wintypes.DWORD), ("count", wintypes.DWORD),
                            ("ids", ctypes.c_size_t * capacity)]
            status = ProcessIds()
            ok = kernel.QueryInformationJobObject(job, 3, ctypes.byref(status), ctypes.sizeof(status), None)
            if ok and status.count <= capacity and status.assigned <= capacity:
                break
            if not ok and ctypes.get_last_error() != 234:  # ERROR_MORE_DATA
                raise OSError("Cannot enumerate the request job")
            capacity = max(capacity * 2, status.assigned)
        else:
            raise OSError("Request job membership exceeds the cleanup limit")
        members = []
        try:
            for pid in status.ids[:status.count]:
                member = kernel.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
                if member:
                    members.append(member)
                elif ctypes.get_last_error() != 87:  # ERROR_INVALID_PARAMETER: already gone
                    raise OSError("Cannot retain the request process")
            return members
        except BaseException:
            for member in members:
                kernel.CloseHandle(member)
            raise

    @staticmethod
    def _wait_empty_job(kernel: Any, job: Any, deadline: float) -> None:
        import ctypes
        from ctypes import wintypes

        class Accounting(ctypes.Structure):
            _fields_ = [(name, ctypes.c_int64) for name in ("TotalUserTime", "TotalKernelTime", "ThisPeriodTotalUserTime", "ThisPeriodTotalKernelTime")] + [
                (name, wintypes.DWORD) for name in ("TotalPageFaultCount", "TotalProcesses", "ActiveProcesses", "TotalTerminatedProcesses")]

        while True:
            status = Accounting()
            if not kernel.QueryInformationJobObject(job, 1, ctypes.byref(status), ctypes.sizeof(status), None):
                raise OSError("Cannot verify request job exit")
            if status.ActiveProcesses == 0:
                return
            if time.monotonic() >= deadline:
                raise OSError("Request job cleanup deadline exceeded")
            time.sleep(0.01)
