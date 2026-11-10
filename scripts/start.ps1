# Windows twin of start.sh: starts the server from the repo this script belongs to, wherever
# that folder has moved. Settings come from $HOME\.config\interactive-document-translator\env (ANTHROPIC_API_KEY,
# PAPERGLOSS_PASSWORD, PORT, HOST, DATA_DIR). Refuses to start on online-only placeholders of a
# cloud-synced folder.
# With an instance name ("start.ps1 work"), it starts that other app of this code instead.
param([string]$Instance = '')
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

function Import-EnvFile($file) {
  # .NET resolves a relative path from the process's folder, which Set-Location does not move (a
  # scheduled task starts in System32): hand it the full path.
  $file = (Resolve-Path -LiteralPath $file).ProviderPath
  # The byte-order mark decides the encoding (Windows PowerShell's ">" writes UTF-16); else UTF-8.
  $reader = New-Object IO.StreamReader($file, [Text.UTF8Encoding]::new($false), $true)
  try { $text = $reader.ReadToEnd() } finally { $reader.Close() }
  $keys = 0
  foreach ($line in $text -split '\r?\n') {
    if ($line -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
      $value = $Matches[2] -replace '^"(.*)"$|^''(.*)''$', '$1$2'
      [Environment]::SetEnvironmentVariable($Matches[1], $value, 'Process')
      $keys++
    }
  }
  if (-not $keys) {
    [Console]::Error.WriteLine("$file has no KEY=value lines. Write it as plain text, one setting per line.")
    exit 1
  }
}

# A folder's full path, from this repo (.NET's own current folder is elsewhere, as above).
function Get-FullPath($dir) { [IO.Path]::GetFullPath([IO.Path]::Combine((Get-Location).ProviderPath, $dir)).TrimEnd('\') }

$envFile = [IO.Path]::Combine($HOME, '.config', 'interactive-document-translator', 'env')
if (Test-Path $envFile) { Import-EnvFile $envFile }
# Another app of this code: its name, id, port and data folder (instances\<name>.env, no secrets)
# go over the settings above. Its id (so its sign-in cookie, backups and log) and its data folder
# never come from those, which are the first app's: the id is its name unless its file gives one,
# and a file without a data folder of its own is refused.
$first = if ($env:DATA_DIR) { $env:DATA_DIR } else { 'data' }
if ($Instance) {
  $own = Join-Path 'instances' "$Instance.env"
  if ($Instance -notmatch '^[a-z0-9]+$' -or -not (Test-Path $own)) {
    [Console]::Error.WriteLine("No app named '$Instance' (instances\<name>.env, lowercase letters and digits).")
    exit 1
  }
  $env:APP_ID = $null
  $env:DATA_DIR = $null
  Import-EnvFile $own
  if (-not $env:APP_ID) { $env:APP_ID = $Instance }
  if (-not $env:DATA_DIR -or (Get-FullPath $env:DATA_DIR) -eq (Get-FullPath $first)) {
    [Console]::Error.WriteLine("The $Instance app needs a data folder of its own: set DATA_DIR in $own ($first is the first app's).")
    exit 1
  }
}
$data = if ($env:DATA_DIR) { $env:DATA_DIR } else { 'data' }

# A cloud-synced folder may hold online-only files as 0-byte placeholders, which read as empty.
$empty = @(Get-ChildItem -Path server, public -Recurse -File | Where-Object Length -eq 0)
if (Test-Path $data) {
  $empty += @(Get-ChildItem -Path $data -Recurse -File -Include meta.json, book.json, annotations.json, raw.json | Where-Object Length -eq 0)
}
if ($empty.Count) {
  [Console]::Error.WriteLine('These files are empty, most likely online-only placeholders of a synced folder:')
  foreach ($file in $empty) { [Console]::Error.WriteLine($file.FullName) }
  [Console]::Error.WriteLine('Make the folder available offline, let the sync finish, then start again.')
  exit 1
}

New-Item -ItemType Directory -Force -Path (Join-Path $data 'tmp') | Out-Null

# Task Scheduler restarts a task that fails to launch, not a server that stops, so this does what
# launchd's KeepAlive does on macOS: start it again a minute later. Ctrl+C (exit code 0) ends it.
# The task runs this in a conhost without a window (autostart.ps1), and stopping the task ends that
# conhost alone: the server watches it too, and stops (exit code 0) when it is gone.
try {
  $parent = Get-Process -Id (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId
  # The open handle keeps Windows from giving its id to another process once it has ended.
  if ($parent.ProcessName -eq 'conhost') { $env:PAPERGLOSS_WATCH_PID = $parent.Id; $null = $parent.Handle }
} catch { }
# The servers of this loop run one after another: the next takes over the heartbeat one leaves in
# the data folder (server/index.js), whatever process has its pid by then.
$env:PAPERGLOSS_LOOP = [guid]::NewGuid()
while ($true) {
  node (Join-Path 'server' 'index.js')
  if ($LASTEXITCODE -eq 0) { exit 0 }
  Start-Sleep -Seconds 60
  if ($env:PAPERGLOSS_WATCH_PID -and $parent.HasExited) { exit 0 }  # the task was stopped meanwhile
}
