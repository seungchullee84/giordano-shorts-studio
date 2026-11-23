import fs from 'node:fs';
import {mkdir, readdir, stat, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {FLOW_URL} from './flow-engine.mjs';

export const FLOW_CDP_PORT = 9229;

let connectedBrowser = null;

async function isCdpAlive(port = FLOW_CDP_PORT, timeoutMs = 1500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {signal: AbortSignal.timeout(timeoutMs)});
    return res.ok;
  } catch {
    return false;
  }
}

export async function openOrConnectRemoteChrome({profileDir}) {
  await mkdir(profileDir, {recursive: true});

  if (!(await isCdpAlive(FLOW_CDP_PORT, 1500))) {
    throw new Error('원격 제어 Chrome 창이 아직 열려 있지 않습니다. 바탕화면의 [Flow 원격 로그인 창 열기] 아이콘을 더블클릭해 창을 열어주세요!');
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
      .slice(0, 40);
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
        const full = path.join(dir, e.name);
        const st = await stat(full);
        map.set(full, st.mtimeMs);
      }
    } catch {}
  }
  return map;
}

/**
 * 2026 Google Flow 한국어 UI 전용 [원본 시작 프레임 100% 고정] 원격 자동화 파이프라인.
 * - 원본 사진을 [시작] 프레임 슬롯에 직접 장착하여 성별·얼굴·의류 착장 변형을 0%로 원천 차단한다.
 * - 시작 프레임이 실제로 장착(button[aria-label="이미지 소재"] 확인)되지 않으면 절대 생성을 누르지 않는다.
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
  liveSnapPath = null,
  onStatus = () => {},
}) {
  if (!preparedImagePaths.length || !fs.existsSync(preparedImagePaths[0])) {
    throw new Error('원본 참고 이미지가 준비되지 않았습니다. 1단계에서 상품 사진을 먼저 확인해 주세요.');
  }

  await mkdir(downloadsDir, {recursive: true});
  const watchDirs = [downloadsDir, path.join(os.homedir(), 'Downloads')];
  const beforeFiles = await listRecentMp4InDownloads(watchDirs);
  const pipelineStartedAt = Date.now();

  onStatus('1/6 전용 원격 Chrome 연결 확인 중…');
  const {page} = await openOrConnectRemoteChrome({studioRoot, profileDir});
  const snap = async () => {
    if (!liveSnapPath) return;
    try { await page.screenshot({path: liveSnapPath, quality: 85, type: 'jpeg'}); } catch {}
  };
  await snap();

  let downloadedPath = null;
  const downloadHandler = async (download) => {
    try {
      const suggested = download.suggestedFilename() || `flow-${Date.now()}.mp4`;
      const dest = path.join(downloadsDir, `${Date.now()}-${suggested}`);
      await download.saveAs(dest);
      downloadedPath = dest;
      onStatus(`Flow 영상 다운로드 완료: ${path.basename(dest)}`);
    } catch {}
  };
  page.on('download', downloadHandler);

  try {
    // 1. Flow 진입 및 로그인 확인
    if (!/^https:\/\/(?:flow\.google\.com|labs\.google)/i.test(page.url()) && !/accounts\.google\.com/i.test(page.url())) {
      await page.goto(FLOW_URL, {waitUntil: 'domcontentloaded', timeout: 30000});
      await page.waitForTimeout(2200);
    }

    if (/\/about/i.test(page.url())) {
      await clickFirstVisible(page, [
        'button:has-text("시작하기")',
        'a:has-text("시작하기")',
        'button:has-text("Create with Flow")',
        'a:has-text("Create with Flow")',
      ]);
      await page.waitForTimeout(2500);
    }

    await snap();
    if (/accounts\.google\.com|signin/i.test(page.url())) {
      return {
        status: 'login_required',
        message: '열린 원격 Chrome 창에서 Google 로그인을 먼저 완료해 주세요! 완료 후 다시 버튼을 누르시면 자동 진행됩니다.',
      };
    }

    // 2. 서브 화면(/character, /tool 등)에 있으면 반드시 메인 프로젝트 에디터(/project/<id>)로 복귀
    onStatus('2/6 Google Flow 메인 프로젝트 에디터 정렬 중…');
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
      ]);
      await page.waitForTimeout(2800);
    }

    // 우측 에이전트 사이드 패널 닫기
    await clickFirstVisible(page, ['button:has-text("right_panel_close")']);
    await page.waitForTimeout(400);

    // 하단 바가 Flow 에이전트 모드(설정 트리거 미표시)로 되어 있으면 직접 생성 모드로 전환
    let settingsTrigger = page.locator('button[aria-label="설정 트리거"]').filter({visible: true}).first();
    if (await settingsTrigger.count() === 0) {
      await clickFirstVisible(page, ['button[aria-label="Flow 에이전트"]']);
      await page.waitForTimeout(700);
      settingsTrigger = page.locator('button[aria-label="설정 트리거"]').filter({visible: true}).first();
    }
    await snap();

    // 3. 설정 트리거 팝업에서 [동영상 · 프레임(시작 이미지 고정!) · 9:16 · Omni 1.2 / Veo · 720p/360p · 15초/12초 · x1] 세팅
    if (await settingsTrigger.count() > 0) {
      onStatus('3/6 동영상 · [프레임 고정 모드] · 9:16 세로 · Omni 1.2 · 15초 · x1 설정 중…');
      await settingsTrigger.click({timeout: 4000});
      await page.waitForTimeout(600);

      await clickFirstVisible(page, ['button[role="radio"]:has-text("동영상")']);
      await page.waitForTimeout(350);

      // 핵심!! '소재' 대신 '프레임'(Image-to-Video 시작 프레임 고정) 모드를 선택해 인물·성별·착장 변형을 0%로 차단!
      await clickFirstVisible(page, ['button[role="radio"]:has-text("프레임")']);
      await page.waitForTimeout(350);

      await clickFirstVisible(page, ['button[role="radio"]:has-text("9:16")']);
      await page.waitForTimeout(250);

      const modelBtn = page.locator('button[aria-label="모델 제품군 선택"]').filter({visible: true}).first();
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
        const sliders = [...document.querySelectorAll('input[type="range"][aria-label="길이"]')];
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

    // 4. 이전 프롬프트/이전 시작 프레임을 먼저 깨끗이 비운 뒤, 이번 상품의 대표 원본 사진을 [시작] 프레임에 100% 장착!
    await clickFirstVisible(page, ['button[aria-label="프롬프트 지우기"]']);
    await page.waitForTimeout(450);

    const heroImagePath = preparedImagePaths[0];
    const heroBasePrefix = path.parse(heroImagePath).name.slice(0, 14);
    onStatus(`4/6 공식 원본 대표 사진(${path.basename(heroImagePath)})을 [시작 프레임]에 고정 장착 중…`);

    const startSlotBtn = page.locator('button:has-text("시작"), [role="button"]:has-text("시작")').filter({visible: true}).first();
    if (await startSlotBtn.count() === 0) {
      throw new Error('Flow 하단에서 [시작] 프레임 슬롯을 찾지 못했습니다. 다시 한 번 버튼을 눌러주세요.');
    }
    await startSlotBtn.click({timeout: 4000});
    await page.waitForTimeout(750);

    const uploadBtn = page.locator('button:has-text("미디어 업로드"), [role="button"]:has-text("미디어 업로드")').filter({visible: true}).first();
    if (await uploadBtn.count() === 0) {
      throw new Error('프레임 이미지 선택 창에서 [미디어 업로드] 버튼을 찾지 못했습니다.');
    }

    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', {timeout: 6000}),
      uploadBtn.click({timeout: 4000}),
    ]);
    await chooser.setFiles([heroImagePath]);
    onStatus('원본 사진 업로드 전송 완료 · 시작 프레임 슬롯에 선택 고정 중…');

    // 업로드 완료 후 팝업 목록에 짧은 고유 접두사(heroBasePrefix) 항목이 나타날 때까지 대기 후 클릭!
    const uploadedOption = page.locator(`[role="option"]:has-text("${heroBasePrefix}"), button:has-text("${heroBasePrefix}")`).filter({visible: true}).first();
    await uploadedOption.waitFor({state: 'visible', timeout: 18000});
    await page.waitForTimeout(400);
    await uploadedOption.click({timeout: 5000});
    await page.waitForTimeout(900);

    // 만약 팝업이 아직 닫히지 않고 [프롬프트에 추가]가 활성 상태면 클릭
    const confirmAddBtn = page.locator('button:has-text("프롬프트에 추가")').filter({visible: true}).first();
    if (await confirmAddBtn.count() > 0 && !(await confirmAddBtn.isDisabled().catch(() => true))) {
      await confirmAddBtn.click().catch(() => {});
      await page.waitForTimeout(800);
    }

    await snap();

    // [절대 안전장치] 시작 프레임이 실제로 장착되었는지(button[aria-label="이미지 소재"]) 반드시 검증!
    // 장착되지 않았다면 절대 텍스트만으로 생성하지 않고 중단한다!
    const attachedStartChip = page.locator('button[aria-label="이미지 소재"]').filter({visible: true}).first();
    if (await attachedStartChip.count() === 0) {
      throw new Error('원본 이미지가 시작 프레임에 장착되지 않아 크레딧 보호를 위해 생성을 중단했습니다. 다시 한 번 눌러주세요!');
    }

    // 5. 하단 프롬프트 입력창에 성별 고정 + 원본 착장 보존 한국어 프롬프트 입력 후 [생성 시작] 클릭
    const promptBoxes = page.locator('div[role="textbox"][aria-label="무엇을 만들고 싶으신가요?"], div[role="textbox"]').filter({visible: true});
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
      throw new Error('프롬프트 입력창을 찾지 못했습니다.');
    }

    const existingVideoSrcs = await page.evaluate(() =>
      [...document.querySelectorAll('video')].map(v => v.currentSrc || v.src || '').filter(Boolean)
    ).catch(() => []);

    onStatus('5/6 원본 사진 장착 확인 완료! 성별·착장 고정 프롬프트 입력 및 [생성 시작] 클릭 중…');
    await targetBox.click();
    await page.waitForTimeout(250);
    await page.keyboard.insertText(promptText);
    await page.waitForTimeout(700);
    await snap();

    const startGenBtn = page.locator('button[aria-label="생성 시작"]').filter({visible: true}).first();
    if (await startGenBtn.count() > 0) {
      await startGenBtn.click();
    } else {
      await page.keyboard.press('Enter').catch(() => {});
    }

    await page.waitForTimeout(1800);
    await snap();
    onStatus('Google Flow에서 [원본 사진 시작 프레임 고정] 9:16 영상 생성이 시작되었습니다! 실시간 중계 중…');

    if (!waitForCompletion) {
      return {status: 'submitted', message: '원본 시작 프레임 고정 영상 생성이 시작되었습니다!'};
    }

    // 6. 생성 완료 실시간 감시 (최대 260초) & 카드 호버 -> [옵션 더보기(⋮)] -> [다운로드] 자동 실행
    const deadline = Date.now() + 260 * 1000;
    let tick = 0;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 3500));
      tick++;
      await snap();

      if (downloadedPath && fs.existsSync(downloadedPath)) {
        return {status: 'completed', videoPath: downloadedPath, message: 'Google Flow 원본 기반 영상 자동 다운로드 완료!'};
      }

      const nowFiles = await listRecentMp4InDownloads(watchDirs);
      for (const [full, mtime] of nowFiles.entries()) {
        // 반드시 이번 파이프라인 시작 시각 이후에 새로 저장된 파일만 인식!
        if (mtime >= (pipelineStartedAt - 1000) && (!beforeFiles.has(full) || mtime > (beforeFiles.get(full) + 1000))) {
          const st = await stat(full).catch(() => null);
          if (st && st.size > 100 * 1024) {
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

      if (newVideoInfo) {
        onStatus('6/6 새 영상 생성 완료 감지! 카드 메뉴에서 원본 MP4 다운로드 중…');
        // 1) 새로 생성된 동영상 카드 중앙으로 마우스를 올려 우측 상단 [옵션 더보기(⋮)] 노출
        await page.mouse.move(newVideoInfo.cx, newVideoInfo.cy);
        await page.waitForTimeout(600);

        // 해당 카드 영역 안의 [옵션 더보기] 버튼 찾기
        const moreBtns = page.locator('button[aria-label="옵션 더보기"]').filter({visible: true});
        const mCount = await moreBtns.count();
        for (let i = 0; i < mCount; i++) {
          const box = await moreBtns.nth(i).boundingBox().catch(() => null);
          if (box && box.x >= newVideoInfo.left - 20 && box.x <= newVideoInfo.right + 20 && Math.abs(box.y - newVideoInfo.top) < 120) {
            await moreBtns.nth(i).click({timeout: 3000}).catch(() => {});
            await page.waitForTimeout(550);
            await clickFirstVisible(page, [
              '[role="menuitem"]:has-text("다운로드")',
              'button:has-text("다운로드")',
              '[role="menuitem"]:has-text("Download")',
            ]);
            break;
          }
        }

        await page.waitForTimeout(4500);
        if (downloadedPath && fs.existsSync(downloadedPath)) {
          return {status: 'completed', videoPath: downloadedPath, message: 'Google Flow 영상 자동 다운로드 완료!'};
        }

        // 폴백: 비디오 스트림 직접 추출
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
      message: '대기 시간(4분)이 지났습니다. 열린 Flow 창에서 영상 카드 우측 상단 [⋮] → [다운로드] 후 [수동 다운로드 영상 불러오기]를 눌러주세요.',
    };
  } finally {
    page.off('download', downloadHandler);
  }
}
