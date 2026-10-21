# Запуск dev-экземпляра Космолёта со своим профилем и портами (ARCHITECTURE §2).
# Пример: powershell -ExecutionPolicy Bypass -File tools\start-dev.ps1 -Profile core-main -DevPort 47410 -McpPort 47331 -CdpPort 9341 -Open https://example.com
param(
  [string]$Profile = 'dev',
  [int]$DevPort = 47399,
  [int]$McpPort = 0,
  [int]$CdpPort = 9333,
  [string[]]$Open = @(),
  [switch]$NoRestore,
  [string]$UiRoot = '',
  # По умолчанию окно за пределами экрана (снимки /shot работают, пользователю не мешает); -OnScreen — показать на экране.
  [switch]$OnScreen,
  [int]$TimeoutSec = 40
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) { Write-Error "Не найден $electron"; exit 1 }

$profileDir = Join-Path $root ".profiles\$Profile"
New-Item -ItemType Directory -Force $profileDir | Out-Null

$argList = @("`"$root`"", '--dev', "--profile=$Profile", "--dev-port=$DevPort", "--cdp-port=$CdpPort")
if ($McpPort -gt 0) { $argList += "--mcp-port=$McpPort" }
if ($NoRestore) { $argList += '--no-restore' }
if (-not $OnScreen) { $argList += '--offscreen' }
if ($UiRoot) { $argList += "--ui-root=`"$UiRoot`"" }
foreach ($u in $Open) { $argList += "--open=`"$u`"" }

$out = Join-Path $profileDir 'main-stdout.log'
$err = Join-Path $profileDir 'main-stderr.log'
$p = Start-Process -FilePath $electron -ArgumentList $argList -WorkingDirectory $root -PassThru `
  -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Normal

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$ok = $false
while ((Get-Date) -lt $deadline) {
  if ($p.HasExited) { break }
  try {
    $h = Invoke-RestMethod -Uri "http://127.0.0.1:$DevPort/health" -TimeoutSec 2
    if ($h.ok) { $ok = $true; break }
  } catch { Start-Sleep -Milliseconds 300 }
}
if ($ok) {
  Write-Output "PID $($p.Id)"
  Write-Output "dev-сервер http://127.0.0.1:$DevPort  лог: $out"
  exit 0
}
if ($p.HasExited) { Write-Output "Процесс завершился (код $($p.ExitCode)). Лог: $out, $err" } else { Write-Output "PID $($p.Id) — dev-сервер не ответил за $TimeoutSec с. Лог: $out" }
exit 1
