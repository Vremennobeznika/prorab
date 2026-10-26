param([Parameter(Mandatory=$true)][string]$Installer)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$base = Join-Path ([System.IO.Path]::GetTempPath()) ('prorab-windows-' + [guid]::NewGuid().ToString('N'))
$installDir = Join-Path $base 'Программа с пробелами'
$profile = Join-Path $base 'Данные пользователя'
New-Item -ItemType Directory -Path $base, $profile -Force | Out-Null
$nodeProcess = $null
$launcher = $null
$installed = $false

function Install-App {
  $process = Start-Process -FilePath $Installer -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',('/DIR="' + $installDir + '"')) -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Installer exit code: $($process.ExitCode)" }
  foreach ($file in @('Прораб.exe','runtime/node.exe','runtime/NODE-LICENSE.txt','Microsoft.Web.WebView2.Core.dll','WebView2Loader.dll','app/src/main.js','app/src/agent/memory.js','app/certs/russian_trusted_root_ca_pem.crt','app/ORIGINS.md','app/THIRD_PARTY_NOTICES.md','app/src/agent/learning.js','unins000.exe')) {
    if (!(Test-Path (Join-Path $installDir $file))) { throw "Installed file missing: $file" }
  }
}

function Start-PackagedApp {
  $ready = Join-Path $base ('ready-' + [guid]::NewGuid().ToString('N') + '.json')
  $entry = Join-Path $installDir 'app/src/main.js'
  $process = Start-Process -FilePath (Join-Path $installDir 'runtime/node.exe') -ArgumentList @(('"' + $entry + '"'),'--no-open','--port','0','--ready-file',('"' + $ready + '"')) -WorkingDirectory (Join-Path $installDir 'app') -Environment @{ PRORAB_USER_DIR = $profile } -PassThru
  try {
    for ($i = 0; $i -lt 150; $i++) {
      if (Test-Path $ready) { return @{ process = $process; ready = (Get-Content $ready -Raw | ConvertFrom-Json) } }
      if ($process.HasExited) { throw "Packaged application exited: $($process.ExitCode)" }
      Start-Sleep -Milliseconds 100
    }
    throw 'Packaged application readiness timed out'
  } catch { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue; throw }
}

function Connect-App($info) {
  # Never print the token-bearing URL or cookie.
  $uri = [Uri]$info.url
  $token = $uri.Query.Substring(1) -replace '^token=', ''
  $session = [Microsoft.PowerShell.Commands.WebRequestSession]::new()
  $session.Cookies.Add([System.Net.Cookie]::new('prorab_token', $token, '/', $uri.Host))
  $origin = $uri.GetLeftPart([System.UriPartial]::Authority)
  $page = Invoke-WebRequest -Uri ($origin + '/') -WebSession $session -TimeoutSec 10
  if ($page.StatusCode -ne 200) { throw 'Installed UI did not return HTTP 200' }
  $state = Invoke-RestMethod -Uri ($origin + '/api/state') -WebSession $session -TimeoutSec 10
  if (@($state.agents).Count -ne 11) { throw 'Expected 11 installed agents' }
  if (!(@($state.agents.tools) -contains 'search_files')) { throw 'Local file search tool missing' }
  return @{ origin = $origin; session = $session }
}

function Stop-OwnedProcess($process) {
  if ($null -ne $process -and !$process.HasExited) {
    & taskkill.exe /PID $process.Id /T /F | Out-Null
    if ($LASTEXITCODE -ne 0 -and !$process.HasExited) { throw 'Could not stop smoke-test process tree' }
    $process.WaitForExit(10000) | Out-Null
  }
}

try {
  Install-App
  $installed = $true
  & (Join-Path $installDir 'runtime/node.exe') (Join-Path $PSScriptRoot 'gigachat-tls.mjs') (Join-Path $installDir 'app')
  if ($LASTEXITCODE -ne 0) { throw 'Installed GigaChat TLS verification failed' }
  $running = Start-PackagedApp
  $nodeProcess = $running.process
  $api = Connect-App $running.ready
  $note = Invoke-RestMethod -Uri ($api.origin + '/api/memory') -WebSession $api.session -Method Post -ContentType 'application/json; charset=utf-8' -Body (@{text='Windows smoke: remember this';localOnly=$true;pinned=$true;kind='decision';topic='Windows smoke'} | ConvertTo-Json) -TimeoutSec 10
  $marker = Join-Path $profile 'workspace/проверка.txt'
  Set-Content -LiteralPath $marker -Value 'keep after uninstall' -Encoding utf8
  Stop-OwnedProcess $nodeProcess
  $nodeProcess = $null

  $running = Start-PackagedApp
  $nodeProcess = $running.process
  $api = Connect-App $running.ready
  $memory = Invoke-RestMethod -Uri ($api.origin + '/api/memory') -WebSession $api.session -TimeoutSec 10
  if (!(@($memory.notes.id) -contains $note.id)) { throw 'Memory did not survive application restart' }
  $restored = $memory.notes | Where-Object { $_.id -eq $note.id } | Select-Object -First 1
  if ($restored.kind -ne 'decision' -or $restored.topic -ne 'Windows smoke' -or $restored.status -ne 'accepted') { throw 'Memory metadata lost after restart' }
  Stop-OwnedProcess $nodeProcess
  $nodeProcess = $null

  # Exercise the actual GUI/tray launcher and its child bundled runtime too.
  $started = Get-Date
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0)
  $listener.Start(); $debugPort = $listener.LocalEndpoint.Port; $listener.Stop()
  $launcher = Start-Process -FilePath (Join-Path $installDir 'Прораб.exe') -WorkingDirectory $installDir -Environment @{ PRORAB_UI_TEST_PORT = [string]$debugPort } -PassThru
  $launcherReady = $null
  for ($i = 0; $i -lt 150; $i++) {
    if ($launcher.HasExited) { throw "GUI launcher exited: $($launcher.ExitCode)" }
    $candidate = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Prorab') -Filter 'launch-*.json' -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -ge $started.AddSeconds(-1) } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($candidate -and (Test-Path ($candidate.FullName + '.desktop'))) { $launcherReady = Get-Content $candidate.FullName -Raw | ConvertFrom-Json; break }
    Start-Sleep -Milliseconds 100
  }
  if (!$launcherReady) { throw 'Native desktop window did not render' }
  $launcher.Refresh()
  if ($launcher.MainWindowHandle -eq 0) { throw 'Native application window missing' }
  $null = Connect-App $launcherReady
  & (Join-Path $installDir 'runtime/node.exe') (Join-Path $PSScriptRoot 'native-settings-smoke.mjs') $debugPort $launcher.Id
  if ($LASTEXITCODE -ne 0) { throw 'Native key paste/save regression failed' }
  Stop-OwnedProcess $launcher
  $launcher = $null

  $started = Get-Date
  $launcher = Start-Process -FilePath (Join-Path $installDir 'Прораб.exe') -WorkingDirectory $installDir -Environment @{ PRORAB_UI_TEST_PORT = [string]$debugPort } -PassThru
  $restartReady = $null
  for ($i = 0; $i -lt 150; $i++) {
    if ($launcher.HasExited) { throw 'Native app exited during credential restart check' }
    $candidate = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Prorab') -Filter 'launch-*.json' -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -ge $started.AddSeconds(-1) } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($candidate -and (Test-Path ($candidate.FullName + '.desktop'))) { $restartReady = $candidate; break }
    Start-Sleep -Milliseconds 100
  }
  if (!$restartReady) { throw 'Native credential restart did not render' }
  $env:PRORAB_UI_VERIFY_RESTART='1'
  try {
    & (Join-Path $installDir 'runtime/node.exe') (Join-Path $PSScriptRoot 'native-settings-smoke.mjs') $debugPort $launcher.Id
    if ($LASTEXITCODE -ne 0) { throw 'Native saved key did not survive restart' }
  } finally { Remove-Item Env:PRORAB_UI_VERIFY_RESTART }
  Stop-OwnedProcess $launcher
  $launcher = $null

  $uninstaller = Join-Path $installDir 'unins000.exe'
  $process = Start-Process -FilePath $uninstaller -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART') -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Uninstaller exit code: $($process.ExitCode)" }
  $installed = $false
  if (Test-Path (Join-Path $installDir 'Прораб.exe')) { throw 'Uninstall left the launcher behind' }
  if (!(Test-Path $marker) -or !(Test-Path (Join-Path $profile 'data/memory.json'))) { throw 'User data lost during uninstall' }

  Install-App
  $installed = $true
  $running = Start-PackagedApp
  $nodeProcess = $running.process
  $api = Connect-App $running.ready
  $memory = Invoke-RestMethod -Uri ($api.origin + '/api/memory') -WebSession $api.session -TimeoutSec 10
  if (!(@($memory.notes.id) -contains $note.id)) { throw 'Memory did not survive reinstall' }
  Write-Host 'PASS: real installer, bundled runtime, authenticated UI, 11 agents, search, memory after restart/reinstall, native rendered desktop window, uninstall retains user files'
} finally {
  Stop-OwnedProcess $nodeProcess
  Stop-OwnedProcess $launcher
  if ($installed -and (Test-Path (Join-Path $installDir 'unins000.exe'))) {
    $null = Start-Process -FilePath (Join-Path $installDir 'unins000.exe') -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART') -Wait -PassThru
  }
}
