<#
.SYNOPSIS
  Run the Bambu Fleet agent in the background on Windows, starting when you log in.

.DESCRIPTION
  Registers a Task Scheduler task for the current user that starts the agent hidden at logon and keeps it
  running: if the agent exits, it is started again after a short pause. Logs go to apps\agent\logs\agent.log.
  No administrator rights are needed.

  Commands:
    install    Register the task and start the agent now
    uninstall  Stop the agent and remove the task
    start      Start the agent
    stop       Stop the agent
    restart    Stop, then start the agent
    status     Show whether the task and the agent are running, plus the last log lines
    logs       Follow the log (Ctrl+C to stop following; the agent keeps running)
    update     Stop, git pull, pnpm install, start
    run        Used by the task itself: run the agent and restart it whenever it exits

.EXAMPLE
  pnpm run service install
  powershell -NoProfile -ExecutionPolicy Bypass -File apps\agent\scripts\windows\agent-service.ps1 status
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

function Get-AgentTask { Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }

function Assert-Installed {
  if (-not (Get-AgentTask)) { throw "The '$TaskName' task is not installed. Run: pnpm run service install" }
}

function Warn-ManualAgents {
  $manual = @(Get-ManualAgents)
  if ($manual.Count -gt 0) {
    Write-Warning ("Another agent is running outside the background task (PID {0})." -f (($manual | ForEach-Object ProcessId) -join ", "))
    Write-Warning "Close that PowerShell window (Ctrl+C) so each printer keeps a single MQTT connection."
  }
}

function Stop-Agent {
  if (Get-AgentTask) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
  # Ending the task stops the wrapper; make sure the node process it started goes too.
  foreach ($p in @(Get-ServiceAgents)) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Start-Agent {
  Assert-Installed
  Warn-ManualAgents
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 3
  $agent = @(Get-ServiceAgents)
  if ($agent.Count -gt 0) { Write-Host "Agent running (PID $($agent[0].ProcessId)). Log: $LogFile" }
  else { Write-Warning "The task started but the agent isn't running yet. Check: pnpm run service status" }
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
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
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
  Write-Host "Installed '$TaskName': starts at logon for $user, using $Node."
  Start-Agent
}

function Show-Status {
  $task = Get-AgentTask
  if (-not $task) { Write-Host "Task: not installed"; Warn-ManualAgents; return }
  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  Write-Host ("Task:   {0} (last run {1}, result 0x{2:X})" -f $task.State, $info.LastRunTime, $info.LastTaskResult)
  $agent = @(Get-ServiceAgents)
  if ($agent.Count -gt 0) {
    Write-Host ("Agent:  running, PID {0}, since {1}" -f $agent[0].ProcessId, $agent[0].CreationDate)
  } else {
    Write-Host "Agent:  not running"
  }
  Warn-ManualAgents
  if (Test-Path $LogFile) {
    Write-Host "Log:    $LogFile`n"
    Get-Content $LogFile -Tail 10 -Encoding UTF8
  }
}

function Update-Agent {
  Stop-Agent
  try {
    git -C $RepoDir pull --ff-only
    if ($LASTEXITCODE -ne 0) { throw "git pull failed" }
    Push-Location $RepoDir
    try { pnpm install --frozen-lockfile } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }
  } finally {
    # Start again even if the update failed, so the fleet keeps reporting on the old version.
    if (Get-AgentTask) { Start-Agent }
  }
}

function Invoke-Run {
  # Native stderr must not stop the loop.
  $ErrorActionPreference = "Continue"
  if (-not $Node) { $Node = "node.exe" }
  foreach ($p in @(Get-ServiceAgents)) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  while ($true) {
    $started = Get-Date
    $proc = Start-Process -FilePath $Node -ArgumentList @("src/main.ts", "run", "--log-file", "`"$LogFile`"") `
      -WorkingDirectory $AgentDir -NoNewWindow -PassThru -RedirectStandardError $CrashFile
    $null = $proc.Handle # needed for ExitCode to be filled in after the process exits
    $proc.WaitForExit()
    $stderr = if (Test-Path $CrashFile) { (Get-Content $CrashFile -Raw -Encoding UTF8) } else { "" }
    $ranFor = [int]((Get-Date) - $started).TotalSeconds
    Write-WrapperLog "error" "agent exited, restarting" @{ exitCode = $proc.ExitCode; ranForSec = $ranFor; stderr = "$stderr".Trim() }
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
  "stop" { Assert-Installed; Stop-Agent; Write-Host "Agent stopped. It starts again at the next logon." }
  "restart" { Assert-Installed; Stop-Agent; Start-Agent }
  "status" { Show-Status }
  "logs" {
    if (-not (Test-Path $LogFile)) { throw "No log yet at $LogFile" }
    Get-Content $LogFile -Tail 40 -Wait -Encoding UTF8
  }
  "update" { Update-Agent }
  "run" { Invoke-Run }
}
