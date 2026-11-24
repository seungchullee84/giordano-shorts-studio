import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright';
import {
  FLOW_CDP_PORT,
  bringRemoteChromeToFront,
  isCdpAlive,
  openOrConnectRemoteChrome,
} from './flow-remote.mjs';

export const PLATFORM_URLS = {
  youtube: 'https://studio.youtube.com/',
  clip: 'https://clipcreators.naver.com/web',
  reels: 'https://business.facebook.com/latest/reels_composer',
  reelsFallback: 'https://business.facebook.com/latest/composer',
};

let cachedUploadBrowser = null;

async function connectUploadChrome(profileDir, log = () => {}) {
  if (!(await isCdpAlive(FLOW_CDP_PORT, 1500))) {
    await openOrConnectRemoteChrome({profileDir, log});
  }
  if (!cachedUploadBrowser || !cachedUploadBrowser.isConnected()) {
    cachedUploadBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${FLOW_CDP_PORT}`);
    cachedUploadBrowser.on('disconnected', () => {
      cachedUploadBrowser = null;
    });
  }
  const context = cachedUploadBrowser.contexts()[0];
  if (!context) throw new Error('전용 Chrome 컨텍스트에 연결하지 못했습니다.');
  return {browser: cachedUploadBrowser, context};
}

async function findFirstVisible(page, selectors, timeoutMs = 5000) {
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

async function fillEditableSafely(page, locator, text) {
  const value = String(text || '');
  if (!value) return false;
  await locator.click({timeout: 4000});
  await page.waitForTimeout(150);
  const tagName = await locator.evaluate(el => el.tagName.toLowerCase()).catch(() => '');
  if (tagName === 'input' || tagName === 'textarea') {
    await locator.fill(value);
    return true;
  }
  await page.keyboard.press('Control+A').catch(() => {});
  await page.waitForTimeout(80);
  await page.keyboard.press('Backspace').catch(() => {});
  await page.waitForTimeout(80);
  await page.keyboard.insertText(value);
  return true;
}

/**
 * 최초 1회 로그인 편의 기능: 전용 Chrome에 선택한 플랫폼의 로그인/대시보드 탭을 열어준다.
 */
export async function openPlatformLoginTabs({
  platforms = ['clip', 'youtube', 'reels'],
  profileDir = '',
  log = () => {},
} = {}) {
  const {context} = await connectUploadChrome(profileDir, log);
  const opened = [];
  for (const key of platforms) {
    const targetUrl = PLATFORM_URLS[key];
    if (!targetUrl) continue;
    const page = await context.newPage();
    await page.goto(targetUrl, {waitUntil: 'domcontentloaded', timeout: 25000}).catch(() => {});
    opened.push({platform: key, url: page.url()});
  }
  await bringRemoteChromeToFront().catch(() => {});
  return {ok: true, opened};
}

/**
 * 🔴 YouTube Studio: 영상 파일 자동 첨부 + 제목 + 설명란(스토어 URL 포함) + 아동용 아님 자동 설정.
 * 안전 원칙: 최종 [게시] / [공개] 버튼은 절대 클릭하지 않고 검수 화면에서 멈춘다!
 */
async function prepareYoutubeTab(context, {videoPath, title, description}, log) {
  const page = await context.newPage();
  try {
    log('🔴 YouTube Studio 여는 중…');
    await page.goto(PLATFORM_URLS.youtube, {waitUntil: 'domcontentloaded', timeout: 30000});
    await page.waitForTimeout(2500);

    if (/accounts\.google\.com/i.test(page.url())) {
      return {platform: 'youtube', status: 'login_required', message: 'YouTube 로그인 필요 — 열린 탭에서 로그인해 주세요.'};
    }

    // 1) [동영상 업로드] 직접 버튼 또는 우측 상단 [만들기] -> [동영상 업로드]
    const directUploadBtn = await findFirstVisible(page, [
      'ytcp-button#upload-button',
      'button[aria-label="동영상 업로드"]',
      'button:has-text("동영상 업로드")',
      'button:has-text("Upload videos")',
    ], 2500);

    if (directUploadBtn) {
      await directUploadBtn.click();
      await page.waitForTimeout(900);
    } else {
      const createBtn = await findFirstVisible(page, [
        'ytcp-button#create-icon',
        'button[aria-label="만들기"]',
        'button:has-text("만들기")',
        'button[aria-label="Create"]',
        'button:has-text("Create")',
      ], 7000);
      if (createBtn) {
        await createBtn.click();
        await page.waitForTimeout(700);
        const menuUpload = await findFirstVisible(page, [
          'tp-yt-paper-item#text-item-0',
          'tp-yt-paper-item:has-text("동영상 업로드")',
          'tp-yt-paper-item:has-text("Upload videos")',
        ], 5000);
        if (menuUpload) {
          await menuUpload.click();
          await page.waitForTimeout(900);
        }
      }
    }

    // 2) 숨겨진 input[type="file"]에 완성 .mp4 첨부
    const fileInput = page.locator('input[type="file"][name="Filedata"], input[type="file"]').first();
    const hasFileInput = await fileInput.count().catch(() => 0);
    if (!hasFileInput) {
      return {platform: 'youtube', status: 'opened_manual', message: 'YouTube Studio 탭을 열었습니다. [만들기 → 동영상 업로드]를 눌러 영상을 올려주세요.'};
    }

    log(`🔴 YouTube에 완성 영상 첨부 중: ${path.basename(videoPath)}`);
    await fileInput.setInputFiles(videoPath);

    // 3) 세부정보 입력 폼(제목/설명) 대기 (최대 20초)
    const titleBox = await findFirstVisible(page, [
      '#title-textarea #textbox',
      'ytcp-social-suggestions-textbox#title-textarea div#textbox',
      'div#textbox[aria-label*="제목"]',
      'div#textbox[aria-label*="title" i]',
    ], 20000);

    if (!titleBox) {
      return {platform: 'youtube', status: 'uploaded_wait', message: 'YouTube 영상 첨부 완료! 세부정보 화면이 열리면 제목·설명란을 붙여넣어 주세요.'};
    }

    await page.waitForTimeout(900);
    if (title) {
      await fillEditableSafely(page, titleBox, String(title).slice(0, 100));
    }

    const descBox = await findFirstVisible(page, [
      '#description-textarea #textbox',
      'ytcp-social-suggestions-textbox#description-textarea div#textbox',
      'div#textbox[aria-label*="설명"]',
      'div#textbox[aria-label*="Tell viewers" i]',
    ], 5000);
    if (descBox && description) {
      await fillEditableSafely(page, descBox, description);
    }

    // 아동용 아님 자동 선택
    const notForKids = await findFirstVisible(page, [
      'tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]',
      'tp-yt-paper-radio-button:has-text("아동용이 아닙니다")',
      'tp-yt-paper-radio-button:has-text("No, it\'s not made for kids")',
    ], 3500);
    if (notForKids) {
      await notForKids.click().catch(() => {});
    }

    // 절대 최종 [게시] 버튼은 누르지 않고 사용자 검수 상태에서 멈춤!
    return {
      platform: 'youtube',
      status: 'ready_for_review',
      message: 'YouTube 영상·제목·설명(스토어 URL) 자동 입력 완료! 확인 후 [다음 → 공개]만 눌러주세요.',
    };
  } catch (err) {
    return {
      platform: 'youtube',
      status: 'error',
      message: `YouTube 준비 오류: ${err.message}`,
    };
  }
}

/**
 * 🟢 네이버 클립 크리에이터 (clipcreators.naver.com/web):
 * 영상 파일 자동 첨부 + 제목/본문/URL/해시태그 자동 입력.
 * 안전 원칙: 쇼핑 태그 연결 및 최종 [게시/등록] 버튼은 절대 클릭하지 않는다!
 */
async function prepareNaverClipTab(context, {videoPath, title, body}, log) {
  const page = await context.newPage();
  try {
    log('🟢 네이버 클립 크리에이터 여는 중…');
    await page.goto(PLATFORM_URLS.clip, {waitUntil: 'domcontentloaded', timeout: 30000});
    await page.waitForTimeout(2500);

    if (/nid\.naver\.com/i.test(page.url())) {
      return {platform: 'clip', status: 'login_required', message: '네이버 로그인 필요 — 열린 탭에서 로그인 후 다시 눌러주세요.'};
    }

    // 업로드 버튼 탐색 (이미 업로드 화면이면 바로 input[type="file"] 탐색)
    let fileInputCount = await page.locator('input[type="file"]').count().catch(() => 0);
    if (!fileInputCount) {
      const uploadTrigger = await findFirstVisible(page, [
        'button:has-text("클립 올리기")',
        'button:has-text("업로드")',
        'button:has-text("만들기")',
        'a:has-text("클립 올리기")',
        'a:has-text("업로드")',
      ], 6000);
      if (uploadTrigger) {
        await uploadTrigger.click().catch(() => {});
        await page.waitForTimeout(1500);
      }
      fileInputCount = await page.locator('input[type="file"]').count().catch(() => 0);
    }

    if (!fileInputCount) {
      return {platform: 'clip', status: 'opened_manual', message: '네이버 클립 탭을 열었습니다. 영상 올리기 버튼을 누른 뒤 복사한 본문을 붙여넣어 주세요.'};
    }

    log(`🟢 네이버 클립에 완성 영상 첨부 중: ${path.basename(videoPath)}`);
    await page.locator('input[type="file"]').first().setInputFiles(videoPath);
    await page.waitForTimeout(3000);

    const titleInput = await findFirstVisible(page, [
      'input[placeholder*="제목"]',
      'textarea[placeholder*="제목"]',
    ], 4000);
    if (titleInput && title) {
      await fillEditableSafely(page, titleInput, title).catch(() => {});
    }

    const bodyInput = await findFirstVisible(page, [
      'textarea[placeholder*="소개"]',
      'textarea[placeholder*="내용"]',
      'textarea[placeholder*="설명"]',
      'textarea',
      '[contenteditable="true"]',
    ], 6000);
    if (bodyInput && body) {
      await fillEditableSafely(page, bodyInput, body).catch(() => {});
    }

    return {
      platform: 'clip',
      status: 'ready_for_review',
      message: '네이버 클립 영상·본문 자동 입력 완료! [쇼핑 태그]로 상품 연결 후 [게시]만 눌러주세요.',
    };
  } catch (err) {
    return {
      platform: 'clip',
      status: 'error',
      message: `네이버 클립 준비 오류: ${err.message}`,
    };
  }
}

/**
 * 🟣 인스타 릴스 (Meta Business Suite 공식 웹 컴포저):
 * 영상 파일 자동 첨부 + 캡션·프로필 품번 안내·해시태그 자동 입력.
 * 안전 원칙: 최종 [공유/게시] 버튼은 절대 클릭하지 않는다!
 */
async function prepareMetaReelsTab(context, {videoPath, caption}, log) {
  const page = await context.newPage();
  try {
    log('🟣 Meta Business Suite(인스타 릴스) 여는 중…');
    await page.goto(PLATFORM_URLS.reels, {waitUntil: 'domcontentloaded', timeout: 30000});
    await page.waitForTimeout(2800);

    if (/login|business\.facebook\.com\/business\/loginpage/i.test(page.url())) {
      return {platform: 'reels', status: 'login_required', message: 'Meta(인스타) 로그인 필요 — 열린 탭에서 로그인 후 다시 눌러주세요.'};
    }

    let fileInputCount = await page.locator('input[type="file"]').count().catch(() => 0);
    if (!fileInputCount) {
      const addVideoBtn = await findFirstVisible(page, [
        'button:has-text("동영상 추가")',
        'div[role="button"]:has-text("동영상 추가")',
        'button:has-text("Add video")',
        'div[role="button"]:has-text("Add video")',
      ], 6000);
      if (addVideoBtn) {
        const [fc] = await Promise.all([
          page.waitForEvent('filechooser', {timeout: 8000}).catch(() => null),
          addVideoBtn.click().catch(() => {}),
        ]);
        if (fc) {
          log(`🟣 인스타 릴스에 완성 영상 첨부 중: ${path.basename(videoPath)}`);
          await fc.setFiles(videoPath);
          fileInputCount = -1; // fileChooser로 첨부 완료
        }
      }
    }

    if (fileInputCount > 0) {
      log(`🟣 인스타 릴스에 완성 영상 첨부 중: ${path.basename(videoPath)}`);
      await page.locator('input[type="file"]').first().setInputFiles(videoPath);
    } else if (fileInputCount === 0) {
      return {platform: 'reels', status: 'opened_manual', message: 'Meta Business Suite 탭을 열었습니다. [동영상 추가] 후 복사한 릴스 캡션을 붙여넣어 주세요.'};
    }

    await page.waitForTimeout(2500);
    const captionBox = await findFirstVisible(page, [
      'div[role="textbox"][contenteditable="true"]',
      'textarea[placeholder*="릴스"]',
      'textarea',
      '[contenteditable="true"]',
    ], 10000);
    if (captionBox && caption) {
      await fillEditableSafely(page, captionBox, caption).catch(() => {});
    }

    return {
      platform: 'reels',
      status: 'ready_for_review',
      message: '인스타 릴스 영상·캡션 자동 입력 완료! 확인 후 [다음 → 공유]만 눌러주세요.',
    };
  } catch (err) {
    return {
      platform: 'reels',
      status: 'error',
      message: `인스타 릴스 준비 오류: ${err.message}`,
    };
  }
}

/**
 * 선택한 플랫폼(유튜브 쇼츠 · 네이버 클립 · 인스타 릴스)을 전용 Chrome에서 순차 자동 준비한다.
 * 어떤 플랫폼에서도 최종 게시/공개 버튼은 절대 누르지 않는다.
 */
export async function runMultiPlatformPrepare({
  platforms = ['youtube', 'clip', 'reels'],
  videoPath = '',
  clip = {},
  shorts = {},
  reels = {},
  profileDir = '',
  onStatus = () => {},
} = {}) {
  if (!videoPath || !fs.existsSync(videoPath)) {
    throw new Error('먼저 완성된 숏츠 영상(.mp4)을 제작하거나 목록에서 선택해 주세요.');
  }
  const selected = (Array.isArray(platforms) ? platforms : []).filter(p => ['youtube', 'clip', 'reels'].includes(p));
  if (!selected.length) {
    throw new Error('자동 준비할 플랫폼(클립·쇼츠·릴스)을 1개 이상 선택해 주세요.');
  }

  onStatus('전용 Chrome에 연결하는 중…');
  const {context} = await connectUploadChrome(profileDir, onStatus);

  const results = [];
  for (const p of selected) {
    if (p === 'youtube') {
      results.push(await prepareYoutubeTab(context, {
        videoPath,
        title: shorts.title || '',
        description: shorts.description || '',
      }, onStatus));
    } else if (p === 'clip') {
      results.push(await prepareNaverClipTab(context, {
        videoPath,
        title: clip.title || '',
        body: clip.body || '',
      }, onStatus));
    } else if (p === 'reels') {
      results.push(await prepareMetaReelsTab(context, {
        videoPath,
        caption: reels.caption || '',
      }, onStatus));
    }
  }

  await bringRemoteChromeToFront().catch(() => {});
  const readyCount = results.filter(r => r.status === 'ready_for_review').length;
  const loginCount = results.filter(r => r.status === 'login_required').length;
  let summary = `3대 플랫폼 준비 완료 (자동 입력 ${readyCount}곳`;
  if (loginCount > 0) summary += ` · 로그인 필요 ${loginCount}곳`;
  summary += ') — 전용 Chrome에서 확인 후 게시만 눌러주세요!';

  return {ok: true, results, summary};
}
