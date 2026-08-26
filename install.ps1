# One command to put Tandem on a Windows machine:
#
#   irm https://raw.githubusercontent.com/umarbashirr/umar_code/main/install.ps1 | iex
#
# It reads the newest release from the public GitHub API, so there is no gh CLI
# to install and no account to log into, downloads the installer that matches
# the machine, and runs it. The installer is one click: it goes into
# %LOCALAPPDATA%\Programs\tandem for the current user, asks for no password,
# puts `tandem` on PATH and adds "Open with Tandem" to a folder's right-click
# menu.
#
# A piped script takes no arguments, so pass them like this instead:
#
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/umarbashirr/umar_code/main/install.ps1))) -Uninstall

[CmdletBinding()]
param(
  [string] $Version,      # a release to install instead of the newest
  [switch] $Force,        # reinstall even if this version is already here
  [switch] $Silent,       # no installer window, for scripting
  [switch] $Uninstall
)

$ErrorActionPreference = 'Stop'
$repo = 'umarbashirr/umar_code'

# Windows PowerShell 5.1 still defaults to TLS 1.0, which GitHub hung up on
# years ago. PowerShell 7 ignores this and is right to.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

function Say  { param($m) Write-Host $m }
function Step { param($m) Write-Host "`n> $m" }

# The installed copy registers itself the way every Windows program does, and
# that registration is the only honest answer to what is already here.
function Get-Installed {
  foreach ($root in @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
  )) {
    if (-not (Test-Path $root)) { continue }
    foreach ($key in Get-ChildItem $root -ErrorAction SilentlyContinue) {
      $p = Get-ItemProperty $key.PSPath -ErrorAction SilentlyContinue
      if ($p -and $p.DisplayName -like 'Tandem*') { return $p }
    }
  }
  return $null
}

# Releases have been named pba-* and are now tandem-*, so the asset is found by
# its extension and the architecture in its name, never by the product name.
# One .exe with no architecture in its name is still this machine's, as long as
# this machine is the one Windows builds are made for.
function Select-Asset {
  param($assets, [string] $arch)
  $exes = @($assets | Where-Object { $_.name -like '*.exe' })
  $hit = $exes | Where-Object { $_.name -like "*$arch*" } | Select-Object -First 1
  if (-not $hit -and $arch -eq 'x64' -and $exes.Count -eq 1) { $hit = $exes[0] }
  return $hit
}

# The uninstall string is a quoted path, sometimes with arguments after it.
function Split-Command {
  param([string] $cmd)
  if ($cmd -match '^\s*"([^"]+)"\s*(.*)$') { return @($Matches[1], $Matches[2]) }
  return @($cmd, '')
}

function Remove-Tandem {
  Step 'Removing Tandem'
  $found = Get-Installed
  if (-not $found) { throw 'Tandem is not installed for this user' }

  $cmd = if ($found.QuietUninstallString) { $found.QuietUninstallString } else { $found.UninstallString }
  if (-not $cmd) { throw 'the installed copy has no uninstaller registered' }

  $exe, $rest = Split-Command $cmd
  $argList = @($rest -split '\s+' | Where-Object { $_ })
  if ($Silent -and $argList -notcontains '/S') { $argList += '/S' }

  Start-Process -FilePath $exe -ArgumentList $argList -Wait
  Say 'Gone. Your settings and open-project state are still in %USERPROFILE%\.tandem; delete that too if you want none of it back.'
}

function Install-Tandem {
  if ($env:OS -ne 'Windows_NT') { throw 'this installer is for Windows. On Linux, use install.sh' }

  $arch = switch ($env:PROCESSOR_ARCHITECTURE) {
    'AMD64' { 'x64' }
    'ARM64' { 'arm64' }
    default { $env:PROCESSOR_ARCHITECTURE }
  }

  Step 'Looking up the release'
  $api = if ($Version) {
    "https://api.github.com/repos/$repo/releases/tags/v$($Version.TrimStart('v'))"
  } else {
    "https://api.github.com/repos/$repo/releases/latest"
  }

  try {
    $release = Invoke-RestMethod -Uri $api -Headers @{ 'User-Agent' = 'tandem-install' }
  } catch {
    $code = $_.Exception.Response.StatusCode.value__
    if ($code -eq 404 -and $Version) { throw "there is no release v$($Version.TrimStart('v'))" }
    throw "could not reach GitHub. Are you online? ($($_.Exception.Message))"
  }

  $latest = ([string]$release.tag_name).TrimStart('v')
  if (-not $latest) { throw 'GitHub answered with a release that has no tag' }

  $asset = Select-Asset $release.assets $arch
  if (-not $asset) {
    $have = @($release.assets | ForEach-Object { $_.name })
    if ($have.Count -eq 0) {
      throw "release v$latest has no files attached yet"
    }
    throw "release v$latest has no Windows installer for $arch. Attached: $($have -join ', '). The .exe is built on Windows and has to be uploaded to the release; it cannot be cross-built from Linux."
  }

  Say "Tandem $latest, $($asset.name)"

  $here = Get-Installed
  if (-not $Force -and $here -and $here.DisplayVersion -eq $latest) {
    Say "Already on $latest. Nothing to do, and -Force if you disagree."
    return
  }

  $file = Join-Path ([IO.Path]::GetTempPath()) $asset.name
  Step "Downloading $([math]::Round($asset.size / 1MB)) MB"

  # Invoke-WebRequest draws a progress bar that costs more than the download on
  # a file this size, so it is turned off and the size is said up front instead.
  $progress = $ProgressPreference
  $ProgressPreference = 'SilentlyContinue'
  try {
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $file -UseBasicParsing
  } catch {
    throw "the download failed ($($_.Exception.Message))"
  } finally {
    $ProgressPreference = $progress
  }

  Step 'Installing'
  $argList = @()
  if ($Silent) { $argList += '/S' }
  $run = Start-Process -FilePath $file -ArgumentList $argList -Wait -PassThru
  if ($run.ExitCode -ne 0) { throw "the installer stopped with exit code $($run.ExitCode)" }
  Remove-Item $file -ErrorAction SilentlyContinue

  Step "Tandem $latest is installed"
  Say @'

  tandem .             open the folder you are in
  tandem C:\code\shop  open another one
  tandem go 3000       point the preview at a port

The tandem command was just added to your PATH, so open a new terminal before
using it. Right-clicking a folder in Explorer offers "Open with Tandem" too.

The agent uses your existing Claude Code login. If claude works in your
terminal, the panel works.
'@
}

# Nothing here calls exit: this script is meant to be piped into iex, and an
# exit there closes the window the person was about to read the error in.
try {
  if ($Uninstall) { Remove-Tandem } else { Install-Tandem }
} catch {
  Write-Host "tandem: $($_.Exception.Message)" -ForegroundColor Red
}
