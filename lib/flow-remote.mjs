import {spawn} from 'node:child_process';
import fs from 'node:fs';
import {mkdir, readdir, stat, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {FLOW_URL} from './flow-engine.mjs';

export const FLOW_CDP_PORT = 9229;
const PS_EXE = process.platform === 'win32' ? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' : 'powershell.exe';

let connectedBrowser = null;
let cancelRequested = false;

export function cancelRemoteFlow() {
  cancelRequested = true;
}

export function isRemoteFlowCancelRequested() {
  return cancelRequested;
}

function checkCancelled() {
  if (cancelRequested) {
    const err = new Error('사용자 요청으로 Flow 자동 실행을 중지했습니다.');
    err.code = 'FLOW_CANCELLED';
    throw err;
  }
}

export function findSystemChrome() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export async function isCdpAlive(port = FLOW_CDP_PORT, timeoutMs = 1500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {signal: AbortSignal.timeout(timeoutMs)});
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForCdpReady(port = FLOW_CDP_PORT, timeoutMs = 18000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isCdpAlive(port, 1200)) return true;
    await new Promise(r => setTimeout(r, 450));
  }
  return false;
}

async function hasVisibleRemoteChromeWindow() {
  if (process.platform !== 'win32') return true;
  const ps = `
$procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*flow-chrome-profile*' -and $_.CommandLine -notlike '*--type=*' }
foreach ($p in $procs) {
  $gp = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
  if ($gp -and $gp.MainWindowHandle -ne 0) { Write-Output 'VISIBLE'; exit 0 }
}
Write-Output 'HIDDEN'
`;
  return await new Promise((resolve) => {
    const encoded = Buffer.from(ps, 'utf16le').toString('base64');
    const child = spawn(PS_EXE, ['-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', d => { out += d.toString(); });
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(false); }, 4000);
    child.on('exit', () => { clearTimeout(timer); resolve(out.includes('VISIBLE')); });
    child.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

async function killHiddenRemoteChrome() {
  if (process.platform !== 'win32') return;
  const ps = `
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*flow-chrome-profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
`;
  await new Promise((resolve) => {
    const encoded = Buffer.from(ps, 'utf16le').toString('base64');
    const child = spawn(PS_EXE, ['-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(); }, 4000);
    child.on('exit', () => { clearTimeout(timer); resolve(); });
    child.on('error', () => { clearTimeout(timer); resolve(); });
  });
  await new Promise(r => setTimeout(r, 700));
}

function launchRemoteChromeProcess(chromeExe, profileDir, port = FLOW_CDP_PORT, startUrl = FLOW_URL) {
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    '--start-maximized',
    startUrl,
  ];
  if (process.platform === 'win32') {
    const esc = (str) => "'" + String(str).replace(/'/g, "''") + "'";
    const argsStr = `--remote-debugging-port=${port} --user-data-dir="${profileDir}" --no-first-run --no-default-browser-check --new-window --start-maximized ${startUrl}`;
    const argList = args.map(esc).join(', ');
    const ps = `try { $sh = New-Object -ComObject Shell.Application; $sh.ShellExecute(${esc(chromeExe)}, ${esc(argsStr)}, '', 'open', 3) } catch { Start-Process -FilePath ${esc(chromeExe)} -WindowStyle Maximized -ArgumentList @(${argList}) }`;
    const encoded = Buffer.from(ps, 'utf16le').toString('base64');
    const child = spawn(PS_EXE, ['-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => {});
    return;
  }
  const child = spawn(chromeExe, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.on('error', () => {});
  child.unref();
}

export async function bringRemoteChromeToFront() {
  if (process.platform !== 'win32') return;
  const psScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class FlowChromeTop {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@ -ErrorAction SilentlyContinue
$wshell = New-Object -ComObject WScript.Shell
$procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*flow-chrome-profile*' -and $_.CommandLine -notlike '*--type=*' }
foreach ($p in $procs) {
  $gp = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
  if ($gp -and $gp.MainWindowHandle -ne 0) {
    $h = $gp.MainWindowHandle
    $fg = [FlowChromeTop]::GetForegroundWindow()
    [uint32]$fgPid = 0
    $fgTid = [FlowChromeTop]::GetWindowThreadProcessId($fg, [ref]$fgPid)
    $curTid = [FlowChromeTop]::GetCurrentThreadId()
    if ($fgTid -ne 0 -and $fgTid -ne $curTid) {
      [FlowChromeTop]::AttachThreadInput($curTid, $fgTid, $true) | Out-Null
    }
    # Alt 키 토글로 Windows 포그라운드 잠금 해제 후 최대화 + 최상단 배치
    [FlowChromeTop]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
    [FlowChromeTop]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    [FlowChromeTop]::ShowWindowAsync($h, 9) | Out-Null
    [FlowChromeTop]::ShowWindowAsync($h, 3) | Out-Null
    [FlowChromeTop]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0003) | Out-Null
    [FlowChromeTop]::BringWindowToTop($h) | Out-Null
    [FlowChromeTop]::SetForegroundWindow($h) | Out-Null
    $null = $wshell.AppActivate($gp.Id)
    Start-Sleep -Milliseconds 180
    [FlowChromeTop]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x0003) | Out-Null
    if ($fgTid -ne 0 -and $fgTid -ne $curTid) {
      [FlowChromeTop]::AttachThreadInput($curTid, $fgTid, $false) | Out-Null
    }
  }
}
`;
  await new Promise((resolve) => {
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    const child = spawn(PS_EXE, ['-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      resolve();
    }, 5000);
    child.on('exit', () => { clearTimeout(timer); resolve(); });
    child.on('error', () => { clearTimeout(timer); resolve(); });
  });
}

export async function openOrConnectRemoteChrome({profileDir, log = () => {}} = {}) {
  if (!profileDir) throw new Error('전용 Chrome 프로필 경로가 지정되지 않았습니다.');
  await mkdir(profileDir, {recursive: true});

  let alive = await isCdpAlive(FLOW_CDP_PORT, 1500);

  if (!alive) {
    const chromeExe = findSystemChrome();
    if (!chromeExe) {
      throw new Error('이 PC에서 Google Chrome을 찾지 못했습니다. Chrome 설치 후 다시 시도해 주세요.');
    }
    log('전용 원격 제어 Chrome 창을 자동으로 여는 중…');
    launchRemoteChromeProcess(chromeExe, profileDir, FLOW_CDP_PORT, FLOW_URL);
    const ready = await waitForCdpReady(FLOW_CDP_PORT, 18000);
    if (!ready) {
      throw new Error('전용 Chrome 연결 시간이 초과되었습니다. 열려 있는 전용 Chrome 창을 닫고 다시 시도해 주세요.');
    }
    await new Promise(r => setTimeout(r, 800));
    if (!(await hasVisibleRemoteChromeWindow())) {
      await killHiddenRemoteChrome();
      throw new Error('현재 서버가 숨김 백그라운드 세션에서 실행 중이라 전용 Chrome 새 창을 화면에 띄울 수 없습니다. 바탕화면의 [숏츠등록기 최신버전] 아이콘으로 다시 실행해 주세요.');
    }
  }

  if (!connectedBrowser || !connectedBrowser.isConnected()) {
    connectedBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${FLOW_CDP_PORT}`);
    connectedBrowser.on('disconnected', () => {
      connectedBrowser = null;
    });
  }

  const context = connectedBrowser.contexts()[0];
  if (!context) throw new Error('원격 Chrome 컨텍스트를 찾지 못했습니다.');
  const pages = context.pages();
  let page = pages.find(p => /^https:\/\/(?:flow\.google\.com|labs\.google)/i.test(p.url()))
    || pages.find(p => /accounts\.google\.com/i.test(p.url()))
    || pages[0];

  if (!page) page = await context.newPage();

  try {
    const cdp = await context.newCDPSession(page);
    const {windowId} = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', {windowId, bounds: {windowState: 'maximized'}}).catch(() => {});
    await cdp.send('Page.bringToFront').catch(() => {});
    await cdp.detach().catch(() => {});
  } catch {}

  await page.bringToFront().catch(() => {});
  await bringRemoteChromeToFront();
  return {browser: connectedBrowser, context, page};
}

export async function inspectRemoteFlowPage({studioRoot, profileDir}) {
  const {page} = await openOrConnectRemoteChrome({studioRoot, profileDir});
  const url = page.url();
  const info = await page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const st = window.getComputedStyle(el);
      return r.width > 2 && r.height > 2 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const buttons = [...document.querySelectorAll('button, [role="button"]')]
      .filter(visible)
      .map(b => (b.innerText || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 50);
    const textareas = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')]
      .filter(visible)
      .map(el => ({
        tag: el.tagName.toLowerCase(),
        aria: el.getAttribute('aria-label') || '',
      }));
    return {title: document.title, buttons, textareas};
  });
  return {url, ...info};
}

/**
 * hidden="" 복제 요소에 절대 걸리지 않도록 화면에 실제로 보이는(visible: true) 요소만 클릭한다.
 */
async function findFirstVisible(page, selectors) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).filter({visible: true}).first();
      if (await loc.count() > 0) return loc;
    } catch {}
  }
  return null;
}

async function clickFirstVisible(page, selectors, timeout = 3000) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).filter({visible: true}).first();
      if (await loc.count() > 0) {
        await loc.click({timeout});
        return sel;
      }
    } catch {}
  }
  return null;
}

async function listRecentMp4InDownloads(dirs) {
  const map = new Map();
  for (const dir of dirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    try {
      const entries = await readdir(dir, {withFileTypes: true});
      for (const e of entries) {
        if (!e.isFile() || !/\.(mp4|mov|webm)$/i.test(e.name)) continue;
        if (/\.crdownload$|\.tmp$|\.part$/i.test(e.name)) continue;
        const full = path.join(dir, e.name);
        const st = await stat(full);
        map.set(full, {mtimeMs: st.mtimeMs, size: st.size});
      }
    } catch {}
  }
  return map;
}

async function waitFileStable(filePath, checks = 3, intervalMs = 600) {
  let prev = -1;
  for (let i = 0; i < checks; i++) {
    const st = await stat(filePath).catch(() => null);
    if (!st || st.size < 50 * 1024) return false;
    if (st.size === prev) return true;
    prev = st.size;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return prev >= 50 * 1024;
}

async function detectStartFrameAttached(page) {
  const selectors = [
    'button[aria-label="이미지 소재"]',
    'button[aria-label*="이미지 소재"]',
    'button[aria-label*="Image"]',
    'button:has-text("시작") img',
    '[data-testid*="frame"] img',
  ];
  for (const sel of selectors) {
    const loc = page.locator(sel).filter({visible: true}).first();
    if (await loc.count().catch(() => 0) > 0) return true;
  }
  // 시작 텍스트 버튼이 사라지고 같은 위치(swap_horiz 왼쪽)에 이미지 썸네일이 들어온 경우도 장착 성공으로 인식
  const hasFrameImg = await page.evaluate(() => {
    const swap = [...document.querySelectorAll('button')].find(b => /첫 번째 프레임/.test(b.getAttribute('aria-label') || '') || /swap_horiz/.test(b.innerText || ''));
    if (!swap) return false;
    const sr = swap.getBoundingClientRect();
    const imgs = [...document.querySelectorAll('img')].filter(img => {
      const r = img.getBoundingClientRect();
      return r.width >= 20 && r.height >= 20 && Math.abs(r.y - sr.y) < 80 && r.right <= sr.left + 20 && r.left >= sr.left - 180;
    });
    return imgs.length > 0;
  }).catch(() => false);
  return hasFrameImg;
}

/**
 * 2026 Google Flow 한국어/영어 UI 전용 [원본 시작 프레임 100% 고정] 끝까지 원격 자동화 파이프라인.
 * - 전용 Chrome이 닫혀 있으면 자동으로 실행하여 연결한다.
 * - 원본 사진을 [시작] 프레임 슬롯에 직접 장착하여 성별·얼굴·의류 착장 변형을 0%로 원천 차단한다.
 * - 시작 프레임 미장착 시 크레딧 보호를 위해 생성 시작 버튼을 절대 누르지 않고 중단한다.
 */
export async function runRemoteFlowPipeline({
  studioRoot,
  profileDir,
  downloadsDir,
  preparedImagePaths = [],
  promptText = '',
  modelId = 'omni-1.2-720p',
  durationSec = 15,
  waitForCompletion = true,
  liveSnapPath = '',
  onStatus = () => {},
}) {
  cancelRequested = false;
  if (!preparedImagePaths.length || !fs.existsSync(preparedImagePaths[0])) {
    throw new Error('업로드할 9:16 공식 원본 시작 프레임 이미지가 준비되지 않았습니다.');
  }

  await mkdir(downloadsDir, {recursive: true});
  const watchDirs = [downloadsDir, path.join(os.homedir(), 'Downloads')];
  const beforeFiles = await listRecentMp4InDownloads(watchDirs);
  const pipelineStartedAt = Date.now();

  onStatus('1/6 전용 원격 Chrome 연결 및 Google Flow 접속 중…');
  const {context, page} = await openOrConnectRemoteChrome({studioRoot, profileDir, log: onStatus});
  checkCancelled();

  // 전용 Chrome 다운로드 경로를 flow-downloads로 허용(지원 시)
  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadsDir,
      eventsEnabled: true,
    }).catch(() => {});
    await cdp.detach().catch(() => {});
  } catch {}

  const snap = async () => {
    if (!liveSnapPath) return;
    try {
      await page.screenshot({path: liveSnapPath, type: 'jpeg', quality: 72});
    } catch {}
  };

  let downloadedPath = null;
  const downloadHandler = async (download) => {
    try {
      const suggested = download.suggestedFilename() || `flow-${Date.now()}.mp4`;
      const target = path.join(downloadsDir, `${Date.now()}-${suggested}`);
      await download.saveAs(target);
      downloadedPath = target;
      onStatus(`Flow 영상 자동 다운로드 완료: ${path.basename(target)}`);
    } catch {}
  };
  page.on('download', downloadHandler);

  try {
    // 1. Flow 진입 및 로그인 확인
    if (!/^https:\/\/(?:flow\.google\.com|labs\.google)/i.test(page.url()) && !/accounts\.google\.com/i.test(page.url())) {
      await page.goto(FLOW_URL, {waitUntil: 'domcontentloaded', timeout: 30000});
      await page.waitForTimeout(2200);
    }
    checkCancelled();

    if (/\/about/i.test(page.url())) {
      await clickFirstVisible(page, [
        'button:has-text("동의함")',
        'button:has-text("Accept")',
      ], 1500);
      await page.waitForTimeout(400);
      await clickFirstVisible(page, [
        'button:has-text("Google Flow로 만들기")',
        'a:has-text("Google Flow로 만들기")',
        'button:has-text("Google Flow에서 사용해 보기")',
        'button:has-text("시작하기")',
        'a:has-text("시작하기")',
        'button:has-text("Create with Flow")',
        'a:has-text("Create with Flow")',
        'button:has-text("Get started")',
      ]);
      await page.waitForTimeout(2500);
    }

    await snap();
    const isLoginPage = /accounts\.google\.com|signin/i.test(page.url());
    const hasOnlySignInBtn = !isLoginPage && await page.locator('a:has-text("로그인"), button:has-text("로그인"), a:has-text("Sign in"), button:has-text("Sign in")').filter({visible: true}).count().catch(() => 0) > 0
      && await page.locator('button[aria-label="설정 트리거"], button:has-text("새 프로젝트"), button:has-text("New project"), div[role="textbox"]').filter({visible: true}).count().catch(() => 0) === 0;

    if (isLoginPage || hasOnlySignInBtn) {
      await bringRemoteChromeToFront();
      return {
        status: 'login_required',
        message: '전용 Chrome 창에서 최초 1회 Google 로그인을 완료해 주세요! 로그인 후 [⚡ 원클릭 Flow 끝까지 자동화]를 다시 누르면 바로 자동 진행됩니다.',
      };
    }

    // 2. 서브 화면(/character, /tool 등)에 있으면 반드시 메인 프로젝트 에디터(/project/<id>)로 복귀
    onStatus('2/6 Google Flow 메인 프로젝트 에디터 정렬 중…');
    checkCancelled();
    await page.keyboard.press('Escape').catch(() => {});
    const projMatch = page.url().match(/^(https:\/\/flow\.google\.com\/project\/[^/?#]+)\/.+/i);
    if (projMatch) {
      await page.goto(projMatch[1], {waitUntil: 'domcontentloaded', timeout: 25000});
      await page.waitForTimeout(2500);
    } else if (!/\/project\//i.test(page.url())) {
      await clickFirstVisible(page, [
        'button:has-text("새 프로젝트")',
        'button:has-text("New project")',
        'button:has-text("만들기")',
        '[aria-label*="새 프로젝트"]',
        '[aria-label*="New project"]',
      ]);
      await page.waitForTimeout(2800);
    }

    if (/accounts\.google\.com|signin/i.test(page.url())) {
      await snap();
      await bringRemoteChromeToFront();
      return {
        status: 'login_required',
        message: '전용 Chrome 창에서 최초 1회 Google 로그인을 완료해 주세요! 로그인 후 다시 버튼을 누르시면 자동 진행됩니다.',
      };
    }

    // 우측 에이전트 사이드 패널 닫기
    await clickFirstVisible(page, ['button:has-text("right_panel_close")']);
    await page.waitForTimeout(400);

    // 하단 바가 Flow 에이전트 모드(설정 트리거 미표시)로 되어 있으면 직접 생성 모드로 전환
    const settingsSelectors = [
      'button[aria-label="설정 트리거"]',
      'button[aria-label="Settings trigger"]',
      'button:has-text("Nano Banana")',
      'button:has-text("동영상 ·")',
      'button:has-text("Omni")',
      'button:has-text("Veo")',
    ];
    let settingsTrigger = await findFirstVisible(page, settingsSelectors);
    if (!settingsTrigger) {
      await clickFirstVisible(page, ['button[aria-label="Flow 에이전트"]', 'button[aria-label*="Agent"]']);
      await page.waitForTimeout(700);
      settingsTrigger = await findFirstVisible(page, settingsSelectors);
    }
    await snap();
    checkCancelled();

    // 3. 설정 트리거 팝업에서 [동영상 · 프레임(시작 이미지 고정!) · 9:16 · 모델 · 해상도 · 길이 · x1] 세팅
    if (settingsTrigger) {
      onStatus(`3/6 동영상 · [프레임 고정 모드] · 9:16 세로 · ${durationSec}초 · x1 설정 중…`);
      await settingsTrigger.click({timeout: 4000});
      await page.waitForTimeout(600);

      await clickFirstVisible(page, ['button[role="radio"]:has-text("동영상")', 'button[role="radio"]:has-text("Video")']);
      await page.waitForTimeout(350);

      // 핵심!! '소재' 대신 '프레임'(Image-to-Video 시작 프레임 고정) 모드를 선택해 인물·성별·착장 변형을 0%로 차단!
      await clickFirstVisible(page, ['button[role="radio"]:has-text("프레임")', 'button[role="radio"]:has-text("Frames")']);
      await page.waitForTimeout(350);

      await clickFirstVisible(page, ['button[role="radio"]:has-text("9:16")']);
      await page.waitForTimeout(250);

      const modelBtn = page.locator('button[aria-label="모델 제품군 선택"], button[aria-label*="Model"]').filter({visible: true}).first();
      if (await modelBtn.count() > 0) {
        const curModelText = (await modelBtn.innerText().catch(() => '')) || '';
        const wantVeo = modelId.includes('veo');
        if ((wantVeo && !/Veo/i.test(curModelText)) || (!wantVeo && !/Omni/i.test(curModelText))) {
          await modelBtn.click();
          await page.waitForTimeout(450);
          await clickFirstVisible(page, wantVeo
            ? ['[role="menuitem"]:has-text("Veo")', '[role="option"]:has-text("Veo")', 'button:has-text("Veo 3.1")']
            : ['[role="menuitem"]:has-text("Omni")', '[role="option"]:has-text("Omni")', 'button:has-text("Omni")']
          );
          await page.waitForTimeout(350);
        }
      }

      if (modelId === 'omni-1.2-360p') {
        await clickFirstVisible(page, ['button[role="radio"]:has-text("360p")']);
      } else {
        await clickFirstVisible(page, ['button[role="radio"]:has-text("720p")']);
      }
      await page.waitForTimeout(250);

      // 길이 슬라이더 설정 (val 0=3초 ... val 9=12초, val 12=15초)
      const sliderVal = Math.max(0, Math.min(12, Math.round(durationSec) - 3));
      await page.evaluate((targetVal) => {
        const sliders = [...document.querySelectorAll('input[type="range"][aria-label="길이"], input[type="range"][aria-label*="Duration"], input[type="range"]')];
        const slider = sliders.find(el => el.getBoundingClientRect().width > 0) || sliders[0];
        if (!slider) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(slider, String(targetVal));
        else slider.value = String(targetVal);
        slider.dispatchEvent(new Event('input', {bubbles: true}));
        slider.dispatchEvent(new Event('change', {bubbles: true}));
      }, sliderVal).catch(() => {});
      await page.waitForTimeout(250);

      await clickFirstVisible(page, ['button[role="radio"]:has-text("x1")']);
      await page.waitForTimeout(250);
      await snap();

      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(500);
    }
    checkCancelled();

    // 4. 이전 프롬프트/이전 시작 프레임을 먼저 깨끗이 비운 뒤, 이번 상품의 대표 원본 사진을 [시작] 프레임에 100% 장착!
    await clickFirstVisible(page, ['button[aria-label="프롬프트 지우기"]', 'button[aria-label*="Clear"]']);
    await page.waitForTimeout(450);

    const heroImagePath = preparedImagePaths[0];
    const heroBaseName = path.parse(heroImagePath).name;
    const heroBasePrefix = heroBaseName.slice(0, 14);
    onStatus(`4/6 공식 원본 대표 사진(${path.basename(heroImagePath)})을 [시작 프레임]에 고정 장착 중…`);

    const startSlotBtn = await findFirstVisible(page, [
      'button:text-is("시작")',
      'button:text-is("Start")',
      'button:has-text("시작"):not([aria-label*="생성"])',
      '[role="button"]:text-is("시작")',
      '[role="button"]:text-is("Start")',
    ]);
    if (!startSlotBtn) {
      throw new Error('Flow 하단에서 [시작] 프레임 슬롯을 찾지 못했습니다. 전용 Chrome에서 Flow 프로젝트 화면이 열려 있는지 확인 후 다시 눌러주세요.');
    }
    await startSlotBtn.click({timeout: 4000});
    await page.waitForTimeout(750);

    // 좌측 사이드바의 'drive_folder_upload'가 backdrop 뒤에서 잘못 잡히지 않도록 [미디어 업로드]만 최우선 순차 탐색!
    const uploadBtn = await findFirstVisible(page, [
      'button:has-text("미디어 업로드")',
      '[role="button"]:has-text("미디어 업로드")',
      'button:has-text("Upload media")',
      '[role="button"]:has-text("Upload media")',
      'button:has-text("Upload"):not(:has-text("drive_folder_upload"))',
    ]);
    if (uploadBtn) {
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', {timeout: 7000}),
        uploadBtn.click({timeout: 4000}),
      ]);
      await chooser.setFiles([heroImagePath]);
    } else {
      const fileInput = page.locator('input[type="file"]').first();
      if (await fileInput.count() === 0) {
        throw new Error('프레임 이미지 선택 창에서 [미디어 업로드] 버튼을 찾지 못했습니다.');
      }
      await fileInput.setInputFiles([heroImagePath]);
    }
    onStatus('원본 사진 업로드 전송 완료 · 시작 프레임 슬롯에 선택 고정 중…');
    checkCancelled();

    // 업로드 완료 후 팝업 목록에 고유 접두사 항목이 나타나면 클릭!
    const uploadedOption = page.locator(`[role="option"]:has-text("${heroBasePrefix}"), button:has-text("${heroBasePrefix}"), [role="menuitem"]:has-text("${heroBasePrefix}")`).filter({visible: true}).first();
    try {
      await uploadedOption.waitFor({state: 'visible', timeout: 18000});
      await page.waitForTimeout(400);
      await uploadedOption.click({timeout: 5000});
      await page.waitForTimeout(900);
    } catch {
      // 일부 UI에서는 업로드 직후 자동으로 시작 프레임에 바로 장착되기도 함
      await page.waitForTimeout(1200);
    }

    // [프롬프트에 추가] 버튼이 보이면 업로드 완료로 활성화될 때까지 최대 12초 대기 후 클릭!
    const confirmAddBtn = await findFirstVisible(page, [
      'button:has-text("프롬프트에 추가")',
      'button:has-text("Add to prompt")',
    ]);
    if (confirmAddBtn) {
      for (let w = 0; w < 24; w++) {
        checkCancelled();
        const visibleNow = await confirmAddBtn.isVisible().catch(() => false);
        if (!visibleNow) break;
        const disabledNow = await confirmAddBtn.isDisabled().catch(() => true);
        if (!disabledNow) {
          await confirmAddBtn.click({timeout: 4000}).catch(() => {});
          await page.waitForTimeout(900);
          break;
        }
        await page.waitForTimeout(500);
      }
    }

    await snap();
    checkCancelled();

    // [절대 안전장치] 시작 프레임이 실제로 장착되었는지 최대 6초 폴링 검증!
    // 장착되지 않았다면 절대 텍스트만으로 생성하지 않고 중단한다!
    let attached = false;
    for (let k = 0; k < 12; k++) {
      if (await detectStartFrameAttached(page)) {
        attached = true;
        break;
      }
      await page.waitForTimeout(500);
    }
    if (!attached) {
      throw new Error('원본 이미지가 시작 프레임에 장착되지 않아 크레딧 보호를 위해 생성을 중단했습니다. 전용 Chrome 화면을 확인 후 다시 눌러주세요!');
    }

    // 5. 하단 프롬프트 입력창에 성별 고정 + 원본 착장 보존 한국어 프롬프트 입력 후 [생성 시작] 클릭
    const promptBoxes = page.locator('div[role="textbox"][aria-label="무엇을 만들고 싶으신가요?"], div[role="textbox"], textarea').filter({visible: true});
    const boxCount = await promptBoxes.count();
    let targetBox = null;
    for (let i = 0; i < boxCount; i++) {
      const candidate = promptBoxes.nth(i);
      const rect = await candidate.boundingBox().catch(() => null);
      if (rect && rect.width >= 150 && rect.height >= 12) {
        targetBox = candidate;
        break;
      }
    }

    if (!targetBox) {
      throw new Error('Flow 프롬프트 입력창을 찾지 못했습니다.');
    }

    const existingVideoSrcs = await page.evaluate(() =>
      [...document.querySelectorAll('video')].map(v => v.currentSrc || v.src || '').filter(Boolean)
    ).catch(() => []);
    const existingThumbSrcs = await page.evaluate(() =>
      [...document.querySelectorAll('img[alt*="동영상 썸네일"], img[alt*="video thumbnail" i]')].map(img => img.currentSrc || img.src || '').filter(Boolean)
    ).catch(() => []);

    onStatus('5/6 원본 사진 장착 확인 완료! 성별·착장 고정 프롬프트 입력 및 [생성 시작] 클릭 중…');
    await targetBox.click();
    await page.waitForTimeout(200);
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    await page.waitForTimeout(150);
    await page.keyboard.insertText(promptText);
    await page.waitForTimeout(700);
    await snap();
    checkCancelled();

    const startGenBtn = await findFirstVisible(page, [
      'button[aria-label="생성 시작"]',
      'button[aria-label="Start generating"]',
      'button[aria-label="Generate"]',
      'button:has-text("arrow_forward")',
    ]);
    if (startGenBtn) {
      await startGenBtn.click();
    } else {
      await page.keyboard.press('Enter').catch(() => {});
    }

    await page.waitForTimeout(2000);
    await snap();
    onStatus('Google Flow에서 [원본 사진 시작 프레임 고정] 9:16 영상 생성이 시작되었습니다! 완료까지 자동 대기 중…');

    if (!waitForCompletion) {
      return {status: 'submitted', message: '원본 시작 프레임 고정 영상 생성이 시작되었습니다!'};
    }

    // 6. 생성 완료 실시간 감시 (최대 300초) & 카드 호버 -> [옵션 더보기(⋮)] -> [다운로드] 자동 실행
    const deadline = Date.now() + 300 * 1000;
    let tick = 0;
    let downloadTriggered = false;
    while (Date.now() < deadline) {
      checkCancelled();
      await new Promise(r => setTimeout(r, 3500));
      checkCancelled();
      tick++;
      await snap();

      if (downloadedPath && fs.existsSync(downloadedPath)) {
        const stable = await waitFileStable(downloadedPath);
        if (stable) {
          return {status: 'completed', videoPath: downloadedPath, message: 'Google Flow 원본 기반 영상 자동 다운로드 완료!'};
        }
      }

      const nowFiles = await listRecentMp4InDownloads(watchDirs);
      for (const [full, meta] of nowFiles.entries()) {
        const prev = beforeFiles.get(full);
        if (meta.mtimeMs >= (pipelineStartedAt - 1000) && (!prev || meta.mtimeMs > (prev.mtimeMs + 1000))) {
          if (await waitFileStable(full)) {
            return {status: 'completed', videoPath: full, message: 'Google Flow 새 영상 다운로드 감지 완료!'};
          }
        }
      }

      const newVideoInfo = await page.evaluate((prevSrcs) => {
        const vids = [...document.querySelectorAll('video')];
        for (const v of vids) {
          const src = v.currentSrc || v.src || '';
          const r = v.getBoundingClientRect();
          if (src && !prevSrcs.includes(src) && v.readyState >= 2 && v.duration > 1 && r.width > 40) {
            return {
              src,
              duration: v.duration,
              cx: Math.round(r.x + r.width / 2),
              cy: Math.round(r.y + r.height / 2),
              top: Math.round(r.y),
              left: Math.round(r.x),
              right: Math.round(r.right),
            };
          }
        }
        return null;
      }, existingVideoSrcs).catch(() => null);

      // 신규 동영상 썸네일(img[alt*="동영상 썸네일"]) 감지: Flow는 완료 시 <video> 대신 썸네일 카드로 먼저 표시됨
      const newThumbInfo = await page.evaluate((prevThumbs) => {
        const imgs = [...document.querySelectorAll('img[alt*="동영상 썸네일"], img[alt*="video thumbnail" i]')];
        for (const img of imgs) {
          const src = img.currentSrc || img.src || '';
          const r = img.getBoundingClientRect();
          if (src && !prevThumbs.includes(src) && r.width > 40 && r.height > 40) {
            return {
              src,
              cx: Math.round(r.x + r.width / 2),
              cy: Math.round(r.y + r.height / 2),
              top: Math.round(r.y),
              left: Math.round(r.x),
              right: Math.round(r.right),
            };
          }
        }
        return null;
      }, existingThumbSrcs).catch(() => null);

      if (newThumbInfo && !downloadTriggered) {
        downloadTriggered = true;
        onStatus('6/6 새 동영상 썸네일 완성 감지! 720p 원본 MP4 자동 다운로드 중…');
        // 썸네일을 클릭해 상세 화면(/edit) 상단 [미디어 다운로드]로 이동하거나 카드 메뉴에서 다운로드
        await page.mouse.click(newThumbInfo.cx, newThumbInfo.cy).catch(() => {});
        await page.waitForTimeout(1400);
        const mediaDlBtn = await findFirstVisible(page, [
          'button[aria-label="미디어 다운로드"]',
          'button[aria-label*="다운로드"]',
          'button[aria-label*="Download"]',
        ]);
        if (mediaDlBtn) {
          await mediaDlBtn.click({timeout: 4000}).catch(() => {});
          await page.waitForTimeout(700);
          // 무료인 [720p 원본 크기]를 최우선 선택 (유료 업스케일 크레딧 차감 방지)
          await clickFirstVisible(page, [
            '[role="menuitem"]:has-text("720p 원본 크기")',
            '[role="menuitem"]:has-text("720p 원본 크기")',
              '[role="menuitem"]:has-text("720p")',
            '[role="menuitem"]:has-text("원본")',
            '[role="menuitem"]:has-text("Original")',
          ], 2500);
        } else {
          await page.mouse.move(newThumbInfo.cx, newThumbInfo.cy).catch(() => {});
          await page.waitForTimeout(600);
          const moreBtns = page.locator('button[aria-label="옵션 더보기"], button[aria-label*="More options"]').filter({visible: true});
          const mCount = await moreBtns.count();
          for (let i = 0; i < mCount; i++) {
            const box = await moreBtns.nth(i).boundingBox().catch(() => null);
            if (box && box.x >= newThumbInfo.left - 30 && box.x <= newThumbInfo.right + 30 && Math.abs(box.y - newThumbInfo.top) < 140) {
              await moreBtns.nth(i).click({timeout: 3000}).catch(() => {});
              await page.waitForTimeout(550);
              await clickFirstVisible(page, [
                '[role="menuitem"]:has-text("다운로드")',
                '[role="menuitem"]:has-text("Download")',
              ]);
              await page.waitForTimeout(500);
              await clickFirstVisible(page, [
                '[role="menuitem"]:has-text("720p 원본 크기")',
                '[role="menuitem"]:has-text("720p 원본 크기")',
              '[role="menuitem"]:has-text("720p")',
                '[role="menuitem"]:has-text("원본")',
              ], 2000);
              break;
            }
          }
        }
        await page.waitForTimeout(3000);
      }

      if (newVideoInfo && !downloadTriggered) {
        downloadTriggered = true;
        onStatus('6/6 새 영상 생성 완료 감지! 카드 메뉴에서 원본 MP4 자동 다운로드 중…');
        // 1) 새로 생성된 동영상 카드 중앙으로 마우스를 올려 우측 상단 [옵션 더보기(⋮)] 노출
        await page.mouse.move(newVideoInfo.cx, newVideoInfo.cy);
        await page.waitForTimeout(650);

        // 해당 카드 영역 안의 [옵션 더보기] 버튼 찾기
        const moreBtns = page.locator('button[aria-label="옵션 더보기"], button[aria-label*="More options"], button[aria-label*="옵션"]').filter({visible: true});
        const mCount = await moreBtns.count();
        for (let i = 0; i < mCount; i++) {
          const box = await moreBtns.nth(i).boundingBox().catch(() => null);
          if (box && box.x >= newVideoInfo.left - 30 && box.x <= newVideoInfo.right + 30 && Math.abs(box.y - newVideoInfo.top) < 140) {
            await moreBtns.nth(i).click({timeout: 3000}).catch(() => {});
            await page.waitForTimeout(550);
            await clickFirstVisible(page, [
              '[role="menuitem"]:has-text("다운로드")',
              'button:has-text("다운로드")',
              '[role="menuitem"]:has-text("Download")',
              'button:has-text("Download")',
            ]);
            await page.waitForTimeout(450);
            // 해상도 선택 하위 메뉴가 뜨는 경우 720p 또는 원본 자동 선택
            await clickFirstVisible(page, [
              '[role="menuitem"]:has-text("720p 원본 크기")',
              '[role="menuitem"]:has-text("720p")',
              '[role="menuitem"]:has-text("원본")',
              '[role="menuitem"]:has-text("Original")',
            ], 1500);
            break;
          }
        }

        await page.waitForTimeout(4500);
        if (downloadedPath && fs.existsSync(downloadedPath) && await waitFileStable(downloadedPath)) {
          return {status: 'completed', videoPath: downloadedPath, message: 'Google Flow 영상 자동 다운로드 완료!'};
        }

        // 2) 폴백: 비디오 스트림 직접 추출
        const base64Data = await page.evaluate(async (videoUrl) => {
          try {
            const res = await fetch(videoUrl);
            if (!res.ok) return null;
            const buf = await res.arrayBuffer();
            if (buf.byteLength < 50000) return null;
            let binary = '';
            const bytes = new Uint8Array(buf);
            const chunk = 0x8000;
            for (let i = 0; i < bytes.length; i += chunk) {
              binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
            }
            return btoa(binary);
          } catch {
            return null;
          }
        }, newVideoInfo.src).catch(() => null);

        if (base64Data) {
          const directOut = path.join(downloadsDir, `flow-auto-${Date.now()}.mp4`);
          await writeFile(directOut, Buffer.from(base64Data, 'base64'));
          return {status: 'completed', videoPath: directOut, message: '생성된 Flow 영상을 직접 추출해 저장했습니다!'};
        }
      }

      if (tick % 4 === 0) {
        onStatus(`Google Flow 원본 고정 영상 렌더링 중… (${Math.round(tick * 3.5)}초 경과)`);
      }
    }

    return {
      status: 'timeout_waiting',
      message: '대기 시간(5분)이 지났습니다. 열린 Flow 창에서 영상 카드 우측 상단 [⋮] → [다운로드] 후 [다운로드 영상 수동 불러오기]를 눌러주세요.',
    };
  } catch (err) {
    if (err.code === 'FLOW_CANCELLED') {
      return {status: 'cancelled', message: err.message};
    }
    throw err;
  } finally {
    page.off('download', downloadHandler);
  }
}