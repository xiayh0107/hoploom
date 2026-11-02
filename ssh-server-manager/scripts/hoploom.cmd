@echo off
set ROOT=%~dp0..
if exist "%ROOT%\.venv\Scripts\python.exe" (
  "%ROOT%\.venv\Scripts\python.exe" "%ROOT%\scripts\hoploom.py" %*
) else (
  python "%ROOT%\scripts\hoploom.py" %*
)
