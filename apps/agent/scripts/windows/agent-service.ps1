<#
.SYNOPSIS
  Run the Bambu Fleet agent in the background on Windows, starting when you log in.

.DESCRIPTION
  Registers a Task Scheduler task for the current user that starts the agent hidden at logon and keeps it
  running. The task also fires every 5 minutes, which starts it again if it was stopped by anything other
  than this script. While running, it restarts the agent when it exits, or when it has delivered nothing
  to the dashboard for 5 minutes. Logs go to apps\agent\logs\agent.log. No administrator rights are needed.

  Commands:
    install    Register the task and start the agent now
    uninstall  Stop the agent and remove the task
    start      Start the agent
    stop       Stop the agent until the next start (the task is disabled meanwhile)
    restart    Stop, then start the agent
    status     Show whether the task and the agent are running, plus the last log lines
    logs       Follow the log (Ctrl+C to stop following; the agent keeps running)
    update     Stop, git pull, pnpm install, then install again (so task changes apply) and start
    run        Used by the task itself: run the agent and restart it whenever it exits

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File apps\agent\scripts\windows\agent-service.ps1 status
  # Shortcut for your PowerShell profile ($PROFILE), then: fleet status / fleet logs / fleet update
  function fleet { powershell -NoProfile -ExecutionPolicy Bypass -File "C:\path\to\repo\apps\agent\scripts\windows\agent-service.ps1" @args }
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet("install", "uninstall", "start", "stop", "restart", "status", "logs", "update", "run")]
  [string]$Command = "status",
  # Full path to node.exe; the task is registered with the one found at install time.
  [string]$Node
)

$ErrorActionPreference = "Stop"
$TaskName = "Bambu Fleet Agent"
$AgentDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$RepoDir = (Resolve-Path (Join-Path $AgentDir "..\..")).Path
$LogDir = Join-Path $AgentDir "logs"
$LogFile = Join-Path $LogDir "agent.log"
$CrashFile = Join-Path $LogDir "agent.stderr.log"
# Written by the agent each time the dashboard accepts its live state (see AgentStatus in src/agent.ts).
$StatusFile = Join-Path $LogDir "status.json"
$ScriptPath = Join-Path $PSScriptRoot "agent-service.ps1"
# Restart an agent that is running but has delivered nothing for this long.
$StallSeconds = 300

function Write-WrapperLog([string]$Level, [string]$Message, [hashtable]$Fields = @{}) {
  $entry = [ordered]@{ t = (Get-Date).ToUniversalTime().ToString("o"); level = $Level; msg = $Message; source = "service" }
  foreach ($key in $Fields.Keys) { $entry[$key] = $Fields[$key] }
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  # UTF-8 without BOM, matching what the agent writes.
  [IO.File]::AppendAllText($LogFile, (($entry | ConvertTo-Json -Compress) + "`n"))
}

# Agent processes started by this script carry the log file path on their command line.
function Get-ServiceAgents {
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($LogFile) }
}

# An agent started by hand (pnpm start / node src\main.ts run) would make a second MQTT client per printer.
function Get-ManualAgents {
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -match "main\.ts`"?\s+run" -and -not $_.CommandLine.Contains($LogFile) }
}

# The hidden PowerShell loop the task runs ("run" command), which starts and supervises node.
function Get-Wrappers {
  Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($ScriptPath) -and $_.CommandLine -match "\srun(\s|$)" -and $_.ProcessId -ne $PID }
}

function Get-AgentTask { Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }

function Read-AgentStatus {
  if (-not (Test-Path $StatusFile)) { return $null }
  try { return Get-Content $StatusFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
}

function Get-EpochMs { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

function Assert-Installed {
  if (-not (Get-AgentTask)) { throw "The '$TaskName' task is not installed. Run this script with: install" }
}

function Warn-ManualAgents {
  $manual = @(Get-ManualAgents)
  if ($manual.Count -gt 0) {
    Write-Warning ("Another agent is running outside the background task (PID {0})." -f (($manual | ForEach-Object ProcessId) -join ", "))
    Write-Warning "Close that PowerShell window (Ctrl+C) so each printer keeps a single MQTT connection."
  }
}

function Stop-Agent {
  if (Get-AgentTask) {
    # Disabled, so the 5-minute trigger doesn't start it again; start and install enable it.
    Disable-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  }
  # Ending the task stops the wrapper; make sure the wrapper and the node process it started both go.
  foreach ($p in @(Get-Wrappers) + @(Get-ServiceAgents)) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Start-Agent {
  Assert-Installed
  Warn-ManualAgents
  Enable-ScheduledTask -TaskName $TaskName | Out-Null
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 3
  $agent = @(Get-ServiceAgents)
  if ($agent.Count -gt 0) { Write-Host "Agent running (PID $($agent[0].ProcessId)). Log: $LogFile" }
  else { Write-Warning "The task started but the agent isn't running yet. Check this script's status command." }
}

function Install-Agent {
  if (-not $Node) { $Node = (Get-Command node -ErrorAction SilentlyContinue).Source }
  if (-not $Node) { throw "node.exe not found on PATH. Install Node.js 24 LTS and open a new PowerShell window." }
  & $Node -e "process.exit(process.features.typescript ? 0 : 1)"
  if ($LASTEXITCODE -ne 0) { throw "$Node can't run TypeScript directly. Install Node.js 24 LTS (or 22.18+)." }
  if (-not (Test-Path (Join-Path $AgentDir "agent.yaml"))) { throw "Missing $AgentDir\agent.yaml. Copy agent.example.yaml and fill it in first." }
  if (-not (Test-Path (Join-Path $RepoDir "node_modules"))) { throw "Dependencies are missing. Run pnpm install in $RepoDir first." }

  $user = "$env:USERDOMAIN\$env:USERNAME"
  $script = Join-Path $PSScriptRoot "agent-service.ps1"
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -WorkingDirectory $AgentDir `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" run -Node `"$Node`""
  # At logon, and every 5 minutes after: with IgnoreNew this only does something when the task isn't running,
  # so a wrapper that died (or a missed logon) is back within 5 minutes.
  $atLogon = New-ScheduledTaskTrigger -AtLogOn -User $user
  $every5 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
  $trigger = @($atLogon, $every5)
  # No time limit (the default stops tasks after 3 days), keep running on battery, never start a second copy.
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

  Stop-Agent
  try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
      -Description "Bambu Fleet LAN agent ($AgentDir). Manage with apps\agent\scripts\windows\agent-service.ps1." -Force | Out-Null
  } catch {
    throw "Couldn't register the task ($($_.Exception.Message)). If access was denied, run this once from PowerShell opened as Administrator."
  }
  Write-Host "Installed '$TaskName': starts at logon for $user and is checked every 5 minutes, using $Node."
  Start-Agent
}

# Task Scheduler result codes, by hex string: PowerShell 5.1 reads hex literals above 0x7FFFFFFF as negative.
$TaskResults = @{
  "0" = "finished"
  "41301" = "running"
  "41303" = "not run yet"
  "41306" = "stopped"
  "8004131F" = "already running"
  "800710E0" = "refused by Windows (conditions not met)"
  "C000013A" = "ended (log off or Ctrl+C)"
}

function Show-Status {
  $task = Get-AgentTask
  if (-not $task) { Write-Host "Task:      not installed"; Warn-ManualAgents; return }
  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  $hex = "{0:X}" -f [uint32]$info.LastTaskResult
  $result = $TaskResults[$hex]
  if (-not $result) { $result = "code 0x$hex" }
  Write-Host ("Task:      {0}, last run {1} ({2}), next check {3}" -f $task.State, $info.LastRunTime, $result, $info.NextRunTime)
  $node = ($task.Actions[0].Arguments -split '-Node ')[1]
  if ($node) {
    $node = $node.Trim('"', ' ')
    if (-not (Test-Path $node)) { Write-Warning "The task runs $node, which no longer exists. Run install again." }
  }

  $wrapper = @(Get-Wrappers)
  $agent = @(Get-ServiceAgents)
  if ($wrapper.Count -eq 0) { Write-Host "Service:   not running (the task starts it within 5 minutes unless stopped)" }
  else { Write-Host ("Service:   running, PID {0}" -f $wrapper[0].ProcessId) }
  if ($agent.Count -gt 0) { Write-Host ("Agent:     running, PID {0}, since {1}" -f $agent[0].ProcessId, $agent[0].CreationDate) }
  else { Write-Host "Agent:     not running" }

  $status = Read-AgentStatus
  if ($status -and $agent.Count -gt 0 -and $status.pid -eq $agent[0].ProcessId) {
    $now = Get-EpochMs
    if ($status.lastPushOkAt) {
      Write-Host ("Dashboard: last delivered {0} s ago, {1} of {2} printers connected" -f [int](($now - $status.lastPushOkAt) / 1000), $status.printersConnected, $status.printersKnown)
    } else {
      Write-Host "Dashboard: nothing delivered yet"
    }
    if ($status.lastPushError -and (-not $status.lastPushOkAt -or $status.lastPushError.at -gt $status.lastPushOkAt)) {
      Write-Warning ("Last delivery failed {0} s ago: {1} {2}" -f [int](($now - $status.lastPushError.at) / 1000), $status.lastPushError.status, $status.lastPushError.error)
    }
  }
  Warn-ManualAgents

  if (Test-Path $LogFile) {
    $events = @(Select-String -Path $LogFile -Pattern '"source":"service"' -Encoding UTF8 | Select-Object -Last 3)
    if ($events.Count -gt 0) {
      Write-Host "`nService events:"
      $events | ForEach-Object { Write-Host "  $($_.Line)" }
    }
    Write-Host "`nLog:       $LogFile"
    Get-Content $LogFile -Tail 10 -Encoding UTF8
  }
}

function Update-Agent {
  Stop-Agent
  try {
    git -C $RepoDir pull --ff-only
    if ($LASTEXITCODE -ne 0) { throw "git pull failed" }
    # Use the pnpm version the repository pins, whatever pnpm is installed globally (a newer one refuses to run).
    $pinned = ((Get-Content (Join-Path $RepoDir "package.json") -Raw | ConvertFrom-Json).packageManager -split "\+")[0]
    Push-Location $RepoDir
    try {
      if ($pinned) { npx --yes $pinned install --frozen-lockfile } else { pnpm install --frozen-lockfile }
    } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }
  } finally {
    # Install again from the freshly pulled script (this one is the old copy, already loaded), so task changes
    # apply too. It runs even if the update failed, so the fleet keeps reporting on the old version.
    if (Get-AgentTask) { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ScriptPath install }
  }
}

function Invoke-Run {
  # Native stderr must not stop the loop.
  $ErrorActionPreference = "Continue"
  if (-not $Node) { $Node = "node.exe" }
  # One supervisor at a time; a second copy (started by hand) just leaves.
  if (@(Get-Wrappers).Count -gt 0) { return }
  foreach ($p in @(Get-ServiceAgents)) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  while ($true) {
    Remove-Item $StatusFile -ErrorAction SilentlyContinue
    $started = Get-Date
    $proc = $null
    try {
      $proc = Start-Process -FilePath $Node -WorkingDirectory $AgentDir -NoNewWindow -PassThru -RedirectStandardError $CrashFile `
        -ArgumentList @("src/main.ts", "run", "--log-file", "`"$LogFile`"", "--status-file", "`"$StatusFile`"")
    } catch {
      Write-WrapperLog "error" "couldn't start the agent" @{ node = $Node; error = $_.Exception.Message }
    }
    $reason = "exited"
    if ($proc) {
      $null = $proc.Handle # needed for ExitCode to be filled in after the process exits
      Write-WrapperLog "info" "agent started" @{ pid = $proc.Id }
      # Check once a minute that it is still delivering; a stuck agent is restarted rather than left running.
      while (-not $proc.WaitForExit(60000)) {
        $status = Read-AgentStatus
        $since = ((Get-Date) - $started).TotalSeconds
        $last = $null
        if ($status -and $status.pid -eq $proc.Id) {
          $last = $status.lastPushOkAt
          if (-not $last) { $last = $status.startedAt }
        }
        $quietFor = if ($last) { ((Get-EpochMs) - $last) / 1000 } else { $since }
        if ($quietFor -gt $StallSeconds) {
          $reason = "stalled"
          $detail = @{ pid = $proc.Id; quietSec = [int]$quietFor }
          if ($status -and $status.lastPushError) { $detail.lastError = "$($status.lastPushError.status) $($status.lastPushError.error)" }
          Write-WrapperLog "error" "agent delivered nothing for 5 minutes, restarting" $detail
          Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
          $proc.WaitForExit(10000) | Out-Null
          break
        }
      }
    }
    $stderr = if (Test-Path $CrashFile) { (Get-Content $CrashFile -Raw -Encoding UTF8) } else { "" }
    $ranFor = [int]((Get-Date) - $started).TotalSeconds
    if ($reason -eq "exited") {
      $exitCode = if ($proc) { $proc.ExitCode } else { $null }
      Write-WrapperLog "error" "agent exited, restarting" @{ exitCode = $exitCode; ranForSec = $ranFor; stderr = "$stderr".Trim() }
    }
    # Back off when it fails straight away (bad config, no network), so the log doesn't fill up.
    Start-Sleep -Seconds ($(if ($ranFor -lt 60) { 60 } else { 10 }))
  }
}

switch ($Command) {
  "install" { Install-Agent }
  "uninstall" {
    Stop-Agent
    if (Get-AgentTask) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
    Write-Host "Removed '$TaskName'. Logs are kept in $LogDir."
  }
  "start" { Start-Agent }
  "stop" { Assert-Installed; Stop-Agent; Write-Host "Agent stopped. It stays off until you run start (or install) again." }
  "restart" { Assert-Installed; Stop-Agent; Start-Agent }
  "status" { Show-Status }
  "logs" {
    if (-not (Test-Path $LogFile)) { throw "No log yet at $LogFile" }
    Get-Content $LogFile -Tail 40 -Wait -Encoding UTF8
  }
  "update" { Update-Agent }
  "run" { Invoke-Run }
}
