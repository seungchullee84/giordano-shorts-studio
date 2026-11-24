import fs from 'node:fs';
import {copyFile, mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {FLOW_CDP_PORT, isCdpAlive, openOrConnectRemoteChrome} from './flow-remote.mjs';

export const DEFAULT_STORAGE_SETTINGS = {
  autoCopyDesktop: true,
  desktopFolderName: '숏츠완성영상',
  autoSyncGoogleDrive: true,
  driveFolderId: '',
  driveFolderName: '지오다노_숏츠',
  driveFolderUrl: '',
};

export function parseGoogleDriveFolderId(raw = '') {
  const text = String(raw || '').trim();
  if (!text) return '';
  const m = text.match(/\/folders\/([a-zA-Z0-9_-]{10,})/);
  if (m) return m[1];
  const mId = text.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (mId) return mId[1];
  if (/^[a-zA-Z0-9_-]{15,}$/.test(text)) return text;
  return '';
}

export function buildDriveFolderUrl(folderId = '') {
  const id = parseGoogleDriveFolderId(folderId);
  return id ? `https://drive.google.com/drive/folders/${id}` : 'https://drive.google.com/drive/my-drive';
}

export function findDesktopBaseDir() {
  const home = os.homedir();
  const candidates = [
    path.join(home, 'OneDrive', 'Desktop'),
    path.join(home, 'Desktop'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return path.join(home, 'Desktop');
}

export function getDesktopOutputsDir(folderName = DEFAULT_STORAGE_SETTINGS.desktopFolderName) {
  const safeName = String(folderName || DEFAULT_STORAGE_SETTINGS.desktopFolderName)
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim() || DEFAULT_STORAGE_SETTINGS.desktopFolderName;
  return path.join(findDesktopBaseDir(), safeName);
}

export function findGoogleDriveDesktopRoot() {
  const home = os.homedir();
  const candidates = [
    'G:\\내 드라이브',
    'G:\\My Drive',
    'H:\\내 드라이브',
    'H:\\My Drive',
    'I:\\내 드라이브',
    'I:\\My Drive',
    path.join(home, 'Google 드라이브'),
    path.join(home, 'Google Drive'),
  ];
  for (const dir of candidates) {
    try {
      if (fs.existsSync(dir)) return dir;
    } catch {}
  }
  return null;
}

export function loadStorageSettingsSync(dataDir) {
  const settingsPath = path.join(dataDir, 'storage-settings.json');
  try {
    if (!fs.existsSync(settingsPath)) return {...DEFAULT_STORAGE_SETTINGS};
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const folderId = parseGoogleDriveFolderId(raw.driveFolderId || raw.driveFolderUrl || '');
    return {
      ...DEFAULT_STORAGE_SETTINGS,
      ...raw,
      autoCopyDesktop: raw.autoCopyDesktop !== false,
      autoSyncGoogleDrive: raw.autoSyncGoogleDrive !== false,
      desktopFolderName: String(raw.desktopFolderName || DEFAULT_STORAGE_SETTINGS.desktopFolderName).trim() || DEFAULT_STORAGE_SETTINGS.desktopFolderName,
      driveFolderName: String(raw.driveFolderName || DEFAULT_STORAGE_SETTINGS.driveFolderName).trim() || DEFAULT_STORAGE_SETTINGS.driveFolderName,
      driveFolderId: folderId,
      driveFolderUrl: folderId ? buildDriveFolderUrl(folderId) : String(raw.driveFolderUrl || '').trim(),
    };
  } catch {
    return {...DEFAULT_STORAGE_SETTINGS};
  }
}

export async function saveStorageSettings(dataDir, patch = {}) {
  await mkdir(dataDir, {recursive: true});
  const current = loadStorageSettingsSync(dataDir);
  const next = {...current};
  if (patch.autoCopyDesktop !== undefined) next.autoCopyDesktop = Boolean(patch.autoCopyDesktop);
  if (patch.autoSyncGoogleDrive !== undefined) next.autoSyncGoogleDrive = Boolean(patch.autoSyncGoogleDrive);
  if (patch.desktopFolderName !== undefined) {
    const clean = String(patch.desktopFolderName || '').replace(/[\\/:*?"<>|]/g, '_').trim();
    if (clean) next.desktopFolderName = clean;
  }
  if (patch.driveFolderName !== undefined) {
    const clean = String(patch.driveFolderName || '').replace(/[\\/:*?"<>|]/g, '_').trim();
    if (clean) next.driveFolderName = clean;
  }
  if (patch.driveFolderUrl !== undefined || patch.driveFolderId !== undefined) {
    const parsedId = parseGoogleDriveFolderId(patch.driveFolderId || patch.driveFolderUrl || '');
    next.driveFolderId = parsedId;
    next.driveFolderUrl = parsedId ? buildDriveFolderUrl(parsedId) : '';
  }
  const settingsPath = path.join(dataDir, 'storage-settings.json');
  await writeFile(settingsPath, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/**
 * 컴퓨터 바탕화면 [숏츠완성영상] 폴더에 원본 손상 없이 자동 복사 저장한다.
 */
export async function copyOutputToDesktop(mp4Path, settings = DEFAULT_STORAGE_SETTINGS) {
  if (!mp4Path || !fs.existsSync(mp4Path)) {
    throw new Error('복사할 완성 영상 파일을 찾지 못했습니다.');
  }
  const dirPath = getDesktopOutputsDir(settings.desktopFolderName);
  await mkdir(dirPath, {recursive: true});
  const filename = path.basename(mp4Path);
  const destPath = path.join(dirPath, filename);
  await copyFile(mp4Path, destPath);
  const st = await stat(destPath);
  return {
    ok: true,
    dirPath,
    destPath,
    filename,
    sizeBytes: st.size,
  };
}

async function findFirstVisible(page, selectors, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.isVisible({timeout: 180})) return loc;
      } catch {}
    }
    await page.waitForTimeout(220);
  }
  return null;
}

// 전용 Chrome Drive 업로드 직렬화 큐 & CDP 연결 재사용 (브라우저 종료 방지)
let driveUploadChain = Promise.resolve();
let cachedDriveBrowser = null;

/**
 * 완성된 숏츠 영상을 Google 드라이브로 자동 업로드한다.
 * - 1순위: PC에 Google Drive 데스크톱(G:\내 드라이브 등)이 설치되어 있으면 즉시 파일 복사(1초)
 * - 2순위: 이미 로그인된 전용 Chrome(CDP 9229)의 새 탭으로 Google 드라이브 폴더에 직접 자동 업로드 후 탭 닫기
 */
export function uploadOutputToGoogleDrive(mp4Path, options = {}) {
  const task = () => runGoogleDriveUploadInternal(mp4Path, options);
  const next = driveUploadChain.then(task, task);
  driveUploadChain = next.catch(() => {});
  return next;
}

async function runGoogleDriveUploadInternal(mp4Path, {
  settings = DEFAULT_STORAGE_SETTINGS,
  profileDir = '',
  onStatus = () => {},
} = {}) {
  if (!mp4Path || !fs.existsSync(mp4Path)) {
    return {ok: false, status: 'error', message: '업로드할 완성 영상 파일을 찾지 못했습니다.'};
  }
  const filename = path.basename(mp4Path);
  const folderName = settings.driveFolderName || DEFAULT_STORAGE_SETTINGS.driveFolderName;
  const folderId = parseGoogleDriveFolderId(settings.driveFolderId || settings.driveFolderUrl || '');
  const folderUrl = buildDriveFolderUrl(folderId);

  // 1순위: 로컬 Google Drive 데스크톱 마운트 폴더가 있으면 초고속 복사 동기화
  const driveRoot = findGoogleDriveDesktopRoot();
  if (driveRoot) {
    try {
      onStatus(`Google 드라이브 폴더(${folderName})로 바로 복사 중…`);
      const targetDir = path.join(driveRoot, folderName);
      await mkdir(targetDir, {recursive: true});
      const destPath = path.join(targetDir, filename);
      await copyFile(mp4Path, destPath);
      return {
        ok: true,
        status: 'completed',
        method: 'desktop-sync',
        filename,
        folderName,
        folderUrl,
        destPath,
        message: `Google 드라이브(${folderName}) 동기화 폴더에 저장 완료!`,
      };
    } catch (err) {
      // 데스크톱 복사 실패 시 웹 업로드로 자동 폴백
      onStatus(`로컬 드라이브 복사 실패(${err.message}), 전용 Chrome 업로드로 전환…`);
    }
  }

  // 2순위: 이미 로그인된 전용 Chrome(CDP 9229)으로 웹 Google 드라이브 자동 업로드
  let page = null;
  let keepPageOpen = false;
  try {
    onStatus('전용 Chrome으로 Google 드라이브 연결 중…');
    if (!(await isCdpAlive(FLOW_CDP_PORT, 1500))) {
      if (!profileDir) {
        return {ok: false, status: 'error', message: '전용 Chrome 프로필 경로가 없어 드라이브에 연결할 수 없습니다.'};
      }
      await openOrConnectRemoteChrome({profileDir, log: onStatus});
    }

    if (!cachedDriveBrowser || !cachedDriveBrowser.isConnected()) {
      cachedDriveBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${FLOW_CDP_PORT}`);
      cachedDriveBrowser.on('disconnected', () => {
        cachedDriveBrowser = null;
      });
    }
    const context = cachedDriveBrowser.contexts()[0];
    if (!context) {
      return {ok: false, status: 'error', message: '전용 Chrome 브라우저 컨텍스트를 열지 못했습니다.'};
    }

    page = await context.newPage();
    onStatus(`Google 드라이브 [${folderName}] 폴더 여는 중…`);
    await page.goto(folderUrl, {waitUntil: 'domcontentloaded', timeout: 35000});
    await page.waitForTimeout(2200);

    // 로그인 확인
    const curUrl = page.url();
    if (/accounts\.google\.com/i.test(curUrl)) {
      keepPageOpen = true;
      return {
        ok: false,
        status: 'login_required',
        folderName,
        folderUrl,
        message: '전용 Chrome에서 Google 계정 로그인을 완료한 뒤 다시 드라이브 전송을 눌러주세요.',
      };
    }

    // 만약 폴더 ID 없이 my-drive로 들어온 경우, 지정된 이름의 폴더 찾아 들어가기 시도
    if (!folderId && /\/drive\/my-drive/i.test(curUrl)) {
      const folderRow = await findFirstVisible(page, [
        `[role="gridcell"]:has-text("${folderName}")`,
        `[data-tooltip*="${folderName}"]`,
        `div:has-text("${folderName}")`,
      ], 3500);
      if (folderRow) {
        await folderRow.dblclick().catch(() => {});
        await page.waitForTimeout(2000);
      }
    }

    // [신규] / [New] 버튼 클릭 → [파일 업로드] 메뉴 클릭 + fileChooser로 파일 전달
    onStatus(`Google 드라이브에 [${filename}] 업로드 시작 중…`);
    const newBtn = await findFirstVisible(page, [
      'button[guidedhelpid="new_menu_button"]',
      'button:has-text("신규")',
      'button[aria-label="신규"]',
      'button[aria-label*="신규"]',
      'button:has-text("New")',
      'button[aria-label="New"]',
    ], 12000);

    if (!newBtn) {
      return {
        ok: false,
        status: 'error',
        folderName,
        folderUrl,
        message: 'Google 드라이브의 [신규] 업로드 버튼을 찾지 못했습니다. 전용 Chrome 로그인 상태를 확인해 주세요.',
      };
    }

    await newBtn.click();
    await page.waitForTimeout(600);

    const fileUploadMenu = await findFirstVisible(page, [
      '[role="menuitem"]:has-text("파일 업로드")',
      'div[role="menu"] >> text="파일 업로드"',
      '[role="menuitem"]:has-text("File upload")',
      'div[role="menu"] >> text="File upload"',
    ], 6000);

    if (!fileUploadMenu) {
      return {
        ok: false,
        status: 'error',
        folderName,
        folderUrl,
        message: 'Google 드라이브 메뉴에서 [파일 업로드] 항목을 찾지 못했습니다.',
      };
    }

    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', {timeout: 15000}),
      fileUploadMenu.click(),
    ]);
    await fileChooser.setFiles(mp4Path);
    onStatus(`Google 드라이브 [${folderName}] 폴더로 영상 전송 중…`);

    // 업로드 완료 감지 (최대 150초)
    const uploadDeadline = Date.now() + 150000;
    let uploadConfirmed = false;
    while (Date.now() < uploadDeadline) {
      await page.waitForTimeout(1500);

      // 동일 파일명 중복 팝업("기존 파일 바꾸기 / 별도 파일로 보관") 자동 처리
      const dupUploadBtn = await findFirstVisible(page, [
        'button:has-text("업로드"):not(:has-text("파일 업로드"))',
        'button:has-text("Upload")',
      ], 300);
      if (dupUploadBtn) {
        const dialogVisible = await page.locator('[role="dialog"], [role="alertdialog"]').first().isVisible().catch(() => false);
        if (dialogVisible) {
          await dupUploadBtn.click().catch(() => {});
          await page.waitForTimeout(600);
        }
      }

      const stateCheck = await page.evaluate((targetName) => {
        const bodyText = document.body?.innerText || '';
        const hasDonePhrase = /(?:1\s*개\s*업로드\s*완료|업로드\s*완료|1\s*upload\s*complete|uploads?\s*complete)/i.test(bodyText);
        const hasUploadingPhrase = /(?:업로드\s*중|항목\s*업로드\s*중|Uploading\s*\d|Starting\s*upload|업로드\s*시작\s*중|남음)/i.test(bodyText);
        const hasFileListed = bodyText.includes(targetName);
        const hasCancelUpload = Boolean(document.querySelector('button[aria-label*="업로드 취소"], button[aria-label*="Cancel upload"]'));
        return {hasDonePhrase, hasUploadingPhrase, hasFileListed, hasCancelUpload};
      }, filename).catch(() => ({hasDonePhrase: false, hasUploadingPhrase: false, hasFileListed: false, hasCancelUpload: false}));

      if (stateCheck.hasDonePhrase && !stateCheck.hasCancelUpload) {
        uploadConfirmed = true;
        break;
      }
      if (stateCheck.hasFileListed && !stateCheck.hasUploadingPhrase && !stateCheck.hasCancelUpload) {
        await page.waitForTimeout(1500);
        uploadConfirmed = true;
        break;
      }
    }

    if (!uploadConfirmed) {
      return {
        ok: false,
        status: 'timeout',
        filename,
        folderName,
        folderUrl,
        message: 'Google 드라이브 업로드 완료 확인 시간이 초과되었습니다. 드라이브 폴더에서 확인해 주세요.',
      };
    }

    await page.waitForTimeout(1200);
    return {
      ok: true,
      status: 'completed',
      method: 'chrome-web',
      filename,
      folderName,
      folderUrl,
      message: `Google 드라이브 [${folderName}] 폴더 업로드 완료!`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 'error',
      filename,
      folderName,
      folderUrl,
      message: `Google 드라이브 업로드 오류: ${err.message}`,
    };
  } finally {
    if (page && !keepPageOpen) {
      await page.close().catch(() => {});
    }
  }
}
