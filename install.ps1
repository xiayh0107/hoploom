# One-line installer for the Hoploom Agent Skill (Windows).
#
#   powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/xiayh0107/hoploom/main/install.ps1 | iex"
#
# or from a checkout:  powershell -ExecutionPolicy Bypass -File install.ps1
#
# Overrides: $env:SSM_REPO_URL, $env:SSM_INSTALL_DIR, $env:SSM_SKILLS_DIRS (';'-separated).
$ErrorActionPreference = "Stop"

$SourceDirName = "ssh-server-manager"
$RepoUrl = if ($env:SSM_REPO_URL) { $env:SSM_REPO_URL } else { "https://github.com/xiayh0107/hoploom.git" }
$LegacyInstallDir = Join-Path $env:LOCALAPPDATA "servers-connect"
$InstallDir = if ($env:SSM_INSTALL_DIR) { $env:SSM_INSTALL_DIR } elseif (Test-Path (Join-Path $LegacyInstallDir "$SourceDirName\SKILL.md")) { $LegacyInstallDir } else { Join-Path $env:LOCALAPPDATA "hoploom" }

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    throw "python (3.10+) is required - install from python.org or the Microsoft Store"
}

# 1. Locate or fetch the source tree.
$Source = $null
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot "$SourceDirName\SKILL.md"))) {
    $Source = Join-Path $PSScriptRoot $SourceDirName
    Write-Host "Using source checkout: $Source"
} elseif (Test-Path (Join-Path $InstallDir "$SourceDirName\SKILL.md")) {
    $Source = Join-Path $InstallDir $SourceDirName
    if ((Test-Path (Join-Path $InstallDir ".git")) -and (Get-Command git -ErrorAction SilentlyContinue)) {
        Write-Host "Updating existing install in $InstallDir"
        git -C $InstallDir pull --ff-only
    }
} else {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "git is required to fetch $RepoUrl" }
    Write-Host "Cloning $RepoUrl -> $InstallDir"
    git clone --depth 1 $RepoUrl $InstallDir
    if ($LASTEXITCODE -ne 0) { throw "Could not clone the Hoploom repository" }
    $Source = Join-Path $InstallDir $SourceDirName
}

# 2. Dependencies.
Write-Host "Installing Python dependencies into $Source\.venv ..."
python (Join-Path $Source "scripts\bootstrap.py") | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Hoploom dependency installation failed" }

# 3. Install the canonical Skill and both CLI names; migrate owned old links.
& (Join-Path $Source ".venv\Scripts\python.exe") (Join-Path $Source "scripts\install-links.py")
if ($LASTEXITCODE -ne 0) { throw "Could not install Hoploom command and Skill links" }

# 4. Health check.
$Launcher = Join-Path $Source "scripts\hoploom.cmd"
Write-Host ""
Write-Host "Running hoploom doctor ..."
& $Launcher doctor
if ($LASTEXITCODE -ne 0) {
    Write-Host "doctor reported issues above - see $Source\docs\installation.md"
    exit 1
}

Write-Host ""
Write-Host "Hoploom is installed and the local health check passed."
Write-Host ""
Write-Host "If you are an AI agent running this installer, do not stop here:"
Write-Host "  1. Run: $Launcher server list --json"
Write-Host "  2. Tell the user which managed hosts are available (or that none are configured yet)."
Write-Host "  3. Give 3-5 short examples of things they can ask you to do using the real host aliases."
Write-Host "  4. Explain that saved SSH secrets stay in the local OS vault and do not need to enter chat."
Write-Host "  5. Say that doctor verified local readiness only; do not claim remote login works unless tested."
Write-Host "Do not make the user learn hoploom commands unless they ask for the CLI."
