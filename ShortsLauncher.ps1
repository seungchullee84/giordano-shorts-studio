param([switch]$OpenFlowChromeOnly)
$ErrorActionPreference = 'Stop'
$studioRoot = 'C:\Users\lscas\.gemini\antigravity\scratch\giordano-shorts-studio'
$profileDir = Join-Path $studioRoot 'data\flow-chrome-profile'
$port = 4180
$cdpPort = 9229

function Find-ChromeExe {
  foreach ($p in @(
    'C:\Program Files\Google\Chrome\Application\chrome.exe',
    'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
  )) {
    if (Test-Path -LiteralPath $p) { return $p }
  }
  return $null
}

function Ensure-FlowRemoteChrome {
  New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
  $ready = $false
  try {
    $null = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$cdpPort/json/version" -TimeoutSec 1
    $ready = $true
  } catch {}

  if (-not $ready) {
    $chrome = Find-ChromeExe
    if (-not $chrome) { throw 'Google Chrome이 설치되어 있지 않습니다.' }
    Start-Process -FilePath $chrome -WindowStyle Maximized -ArgumentList @(
      "--remote-debugging-port=$cdpPort",
      "--user-data-dir=$profileDir",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
      "--start-maximized",
      "https://flow.google.com/"
    ) | Out-Null
  } else {
    # 이미 떠 있는 원격 Chrome 창을 Windows 최상단(화면 맨 앞)으로 즉시 끌어올리기
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public class FlowWin {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
}
"@ -ErrorAction SilentlyContinue
    $wshell = New-Object -ComObject WScript.Shell
    Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
      Where-Object { $_.CommandLine -like '*flow-chrome-profile*' -and $_.CommandLine -notlike '*--type=*' } |
      ForEach-Object {
        $proc = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
        if ($proc -and $proc.MainWindowHandle -ne 0) {
          $h = $proc.MainWindowHandle
          [FlowWin]::ShowWindow($h, 9) | Out-Null
          [FlowWin]::ShowWindow($h, 3) | Out-Null
          [FlowWin]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0003) | Out-Null
          [FlowWin]::SetForegroundWindow($h) | Out-Null
          $null = $wshell.AppActivate($proc.Id)
          Start-Sleep -Milliseconds 150
          [FlowWin]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x0003) | Out-Null
        }
      }
  }
}

if ($OpenFlowChromeOnly) {
  Ensure-FlowRemoteChrome
  exit 0
}

# 숏츠등록기 서버 실행 여부 확인 후 미실행 시 백그라운드 기동
$serverUp = $false
try {
  $res = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/api/state" -TimeoutSec 2
  if ($res.StatusCode -eq 200) { $serverUp = $true }
} catch {}

if (-not $serverUp) {
  $bundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
  $nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
  $nodeExe = if ($nodeCmd) { $nodeCmd.Source } elseif (Test-Path -LiteralPath $bundledNode) { $bundledNode } else { throw 'Node.js를 찾을 수 없습니다.' }
  $env:PORT = "$port"
  $env:NO_AUTO_OPEN = '1'
  Start-Process -FilePath $nodeExe -ArgumentList 'server.mjs' -WorkingDirectory $studioRoot -WindowStyle Hidden | Out-Null
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 400
    try {
      $res = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/api/state" -TimeoutSec 1
      if ($res.StatusCode -eq 200) { $serverUp = $true; break }
    } catch {}
  }
}

Start-Process "http://127.0.0.1:$port/"
