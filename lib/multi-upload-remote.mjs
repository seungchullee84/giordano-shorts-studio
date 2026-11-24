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
  clip: 'https://clipcreators.naver.com/web/upload',
  reels: 'https://www.instagram.com/',
  reelsMetaFallback: 'https://business.facebook.com/latest/reels_composer',
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
 * 🟢 네이버 클립 크리에이터 (clipcreators.naver.com/web/upload):
 * 업로드 페이지 직행 → 완성 .mp4 첨부 → /web/draft/ 편집 화면의 설명란(#content-description)에 본문·URL·해시태그 자동 입력.
 * 안전 원칙: 카테고리/쇼핑 태그 선택 및 최종 [등록] 버튼은 절대 클릭하지 않는다!
 */
async function prepareNaverClipTab(context, {videoPath, title, body}, log) {
  const page = await context.newPage();
  try {
    log('🟢 네이버 클립 업로드 페이지 여는 중…');
    await page.goto(PLATFORM_URLS.clip, {waitUntil: 'domcontentloaded', timeout: 30000});
    await page.waitForTimeout(2200);

    if (/nid\.naver\.com/i.test(page.url())) {
      return {platform: 'clip', status: 'login_required', message: '네이버 로그인 필요 — 열린 네이버 클립 탭에서 로그인 후 다시 눌러주세요.'};
    }

    // 대시보드로 리다이렉트된 경우 상단 [업로드] 버튼 클릭해 /web/upload 진입
    if (/\/web\/dashboard/i.test(page.url())) {
      const uploadNavBtn = await findFirstVisible(page, [
        'button:has-text("업로드")',
        'button[aria-label="업로드"]',
        'button:has-text("클립 올리기")',
      ], 5000);
      if (uploadNavBtn) {
        await uploadNavBtn.click().catch(() => {});
        await page.waitForTimeout(2000);
      }
    }

    // Next.js 클라이언트 렌더링 완료까지 숨겨진 동영상 file input 대기 (최대 18초)
    const videoFileSelector = 'input[type="file"][accept*=".mp4"], input[type="file"][accept*="video"], input[type="file"]';
    let attached = false;
    const deadline = Date.now() + 18000;
    while (Date.now() < deadline) {
      if (/nid\.naver\.com/i.test(page.url())) {
        return {platform: 'clip', status: 'login_required', message: '네이버 로그인 필요 — 열린 네이버 클립 탭에서 로그인 후 다시 눌러주세요.'};
      }
      const fi = page.locator(videoFileSelector).first();
      if (await fi.count().catch(() => 0) > 0) {
        log(`🟢 네이버 클립에 완성 영상 첨부 중: ${path.basename(videoPath)}`);
        await fi.setInputFiles(videoPath);
        attached = true;
        break;
      }
      await page.waitForTimeout(500);
    }

    // file input이 아직 안 잡혔지만 [파일 선택] 버튼이 보이면 fileChooser로 첨부
    if (!attached) {
      const pickBtn = await findFirstVisible(page, [
        'button:has-text("파일 선택")',
        'button:has-text("동영상 선택")',
      ], 4000);
      if (pickBtn) {
        const [fc] = await Promise.all([
          page.waitForEvent('filechooser', {timeout: 8000}).catch(() => null),
          pickBtn.click().catch(() => {}),
        ]);
        if (fc) {
          log(`🟢 네이버 클립에 완성 영상 첨부 중: ${path.basename(videoPath)}`);
          await fc.setFiles(videoPath);
          attached = true;
        }
      }
    }

    if (!attached) {
      return {platform: 'clip', status: 'opened_manual', message: '네이버 클립 업로드 탭을 열었습니다. [파일 선택]으로 영상을 올린 뒤 복사한 본문을 붙여넣어 주세요.'};
    }

    // /web/draft/... 상세 편집 화면의 설명란(#content-description)이 뜰 때까지 최대 25초 대기
    const descBox = await findFirstVisible(page, [
      'textarea#content-description',
      'textarea[name="description"]',
      'textarea[placeholder*="경험"]',
      'textarea[placeholder*="소개"]',
      'textarea[placeholder*="설명"]',
      'textarea',
    ], 25000);

    if (!descBox) {
      return {platform: 'clip', status: 'uploaded_wait', message: '네이버 클립 영상 첨부 완료! 편집 화면이 열리면 복사한 본문을 붙여넣어 주세요.'};
    }

    const clipText = String(body || title || '').trim().slice(0, 3000);
    if (clipText) {
      await descBox.fill(clipText).catch(async () => {
        await fillEditableSafely(page, descBox, clipText).catch(() => {});
      });
      // React 상태 반영 확인 후 비어 있으면 키보드 입력 폴백
      const filledLen = await descBox.inputValue().then(v => v.length).catch(() => 0);
      if (filledLen === 0) {
        await fillEditableSafely(page, descBox, clipText).catch(() => {});
      }
    }

    return {
      platform: 'clip',
      status: 'ready_for_review',
      message: '네이버 클립 영상·본문(URL·해시태그) 자동 입력 완료! [카테고리]와 [쇼핑 태그] 선택 후 [등록]만 눌러주세요.',
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
 * 🟣 인스타 릴스 (https://www.instagram.com/ PC 웹 직접 업로드):
 * Meta Business Suite / Facebook 페이지 없이 일반·크리에이터·비즈니스 계정 모두에서 동작!
 * 좌측 [+ 만들기/게시물] → .mp4 첨부 → 9:16 원본 비율 → 다음 → 다음 → 캡션·해시태그 자동 입력.
 * 안전 원칙: 최종 [공유하기] 버튼은 절대 클릭하지 않는다!
 */
async function prepareInstagramReelsTab(context, {videoPath, caption}, log) {
  const page = await context.newPage();
  try {
    log('🟣 Instagram(인스타 릴스) 여는 중…');
    await page.goto(PLATFORM_URLS.reels, {waitUntil: 'domcontentloaded', timeout: 30000});
    await page.waitForTimeout(2800);

    // 로그인 필요 여부 확인 (URL 또는 이메일/아이디·비밀번호 입력창 존재)
    const loginFormVisible = await findFirstVisible(page, [
      'input[name="username"]',
      'input[name="email"]',
      'input[name="pass"]',
      'input[name="password"]',
      'button:has-text("로그인")',
      'div[role="button"]:has-text("Instagram으로 로그인")',
    ], 2200);
    if (/\/accounts\/login/i.test(page.url()) || loginFormVisible) {
      return {
        platform: 'reels',
        status: 'login_required',
        message: 'Instagram 로그인 필요 — 열린 Instagram 탭에서 로그인("로그인 정보 저장" 권장) 후 다시 눌러주세요.',
      };
    }

    // 1) 좌측 메뉴 [+ 만들기 / 게시물] 버튼 클릭
    const createBtn = await findFirstVisible(page, [
      'a:has(svg[aria-label="새로운 게시물"])',
      'a:has(svg[aria-label="게시물"])',
      'a:has(svg[aria-label="만들기"])',
      'a:has(svg[aria-label="New post"])',
      'a:has(svg[aria-label="Create"])',
      'div[role="button"]:has(svg[aria-label="새로운 게시물"])',
      'div[role="button"]:has(svg[aria-label="게시물"])',
      'a:has-text("만들기")',
      'a:has-text("Create")',
    ], 9000);

    if (!createBtn) {
      return {
        platform: 'reels',
        status: 'opened_manual',
        message: 'Instagram 탭을 열었습니다. 좌측 [+] 만들기 버튼으로 영상을 올린 뒤 복사한 릴스 캡션을 붙여넣어 주세요.',
      };
    }

    await createBtn.click();
    await page.waitForTimeout(1400);

    // 하위 메뉴([게시물] / [라이브 방송] 등)가 뜨면 [게시물] 항목 클릭
    let hasUploadModal = await page.locator('[role="dialog"] input[type="file"], button:has-text("컴퓨터에서 선택"), button:has-text("Select from computer")').count().catch(() => 0);
    if (!hasUploadModal) {
      const postSubItem = await findFirstVisible(page, [
        'a:has-text("게시물")',
        'div[role="menuitem"]:has-text("게시물")',
        'span:has-text("게시물")',
        'a:has-text("Post")',
        'div[role="menuitem"]:has-text("Post")',
        'span:has-text("Post")',
      ], 3500);
      if (postSubItem) {
        await postSubItem.click().catch(() => {});
        await page.waitForTimeout(1400);
      }
    }

    // 2) 완성 .mp4 첨부 (모달 내 hidden input[type="file"] 우선, 없으면 [컴퓨터에서 선택] fileChooser)
    let attached = false;
    const modalFileInput = page.locator('[role="dialog"] input[type="file"], input[type="file"][accept*="video"], input[type="file"]').first();
    if (await modalFileInput.count().catch(() => 0) > 0) {
      log(`🟣 인스타 릴스에 완성 영상 첨부 중: ${path.basename(videoPath)}`);
      await modalFileInput.setInputFiles(videoPath);
      attached = true;
    } else {
      const pickBtn = await findFirstVisible(page, [
        'button:has-text("컴퓨터에서 선택")',
        'button:has-text("Select from computer")',
      ], 6000);
      if (pickBtn) {
        const [fc] = await Promise.all([
          page.waitForEvent('filechooser', {timeout: 8000}).catch(() => null),
          pickBtn.click().catch(() => {}),
        ]);
        if (fc) {
          log(`🟣 인스타 릴스에 완성 영상 첨부 중: ${path.basename(videoPath)}`);
          await fc.setFiles(videoPath);
          attached = true;
        }
      }
    }

    if (!attached) {
      return {
        platform: 'reels',
        status: 'opened_manual',
        message: 'Instagram 업로드 창을 열었습니다. [컴퓨터에서 선택]으로 영상을 올린 뒤 복사한 릴스 캡션을 붙여넣어 주세요.',
      };
    }

    await page.waitForTimeout(2600);

    // 3) 1회성 안내 팝업("동영상 게시물이 이제 릴스로 공유됩니다" 등) 닫기
    const okNoticeBtn = await findFirstVisible(page, [
      '[role="dialog"] button:has-text("확인")',
      '[role="dialog"] button:has-text("OK")',
    ], 2200);
    if (okNoticeBtn) {
      await okNoticeBtn.click().catch(() => {});
      await page.waitForTimeout(900);
    }

    // 4) 9:16 세로 릴스가 정사각형으로 잘리지 않도록 비율 [원본] 선택 시도
    const cropBtn = await findFirstVisible(page, [
      '[role="dialog"] button:has(svg[aria-label="자르기 선택"])',
      '[role="dialog"] button:has(svg[aria-label="Select crop"])',
      '[role="dialog"] svg[aria-label="자르기 선택"]',
      '[role="dialog"] svg[aria-label="Select crop"]',
    ], 2500);
    if (cropBtn) {
      await cropBtn.click().catch(() => {});
      await page.waitForTimeout(700);
      const origRatio = await findFirstVisible(page, [
        '[role="dialog"] span:has-text("원본")',
        '[role="dialog"] button:has-text("원본")',
        '[role="dialog"] span:has-text("Original")',
        '[role="dialog"] button:has-text("Original")',
      ], 2000);
      if (origRatio) {
        await origRatio.click().catch(() => {});
        await page.waitForTimeout(700);
      }
    }

    // 5) 자르기 → 커버/편집 → 문구 입력 화면까지 [다음] 최대 2회 진행
    for (let step = 0; step < 2; step += 1) {
      const captionAlready = await findFirstVisible(page, [
        '[role="dialog"] div[role="textbox"][contenteditable="true"]',
        '[role="dialog"] div[aria-label*="문구"]',
        '[role="dialog"] div[aria-label*="caption" i]',
      ], 1000);
      if (captionAlready) break;

      const nextBtn = await findFirstVisible(page, [
        '[role="dialog"] div[role="button"]:has-text("다음")',
        '[role="dialog"] button:has-text("다음")',
        '[role="dialog"] div[role="button"]:has-text("Next")',
        '[role="dialog"] button:has-text("Next")',
      ], 5000);
      if (!nextBtn) break;
      await nextBtn.click().catch(() => {});
      await page.waitForTimeout(1600);
    }

    // 6) 캡션(문구·품번 안내·해시태그) 자동 입력 — 최종 [공유하기] 버튼은 절대 누르지 않음!
    const captionBox = await findFirstVisible(page, [
      '[role="dialog"] div[role="textbox"][contenteditable="true"]',
      '[role="dialog"] div[aria-label*="문구"]',
      '[role="dialog"] div[aria-label*="caption" i]',
      '[role="dialog"] textarea',
    ], 8000);

    if (captionBox && caption) {
      await fillEditableSafely(page, captionBox, caption).catch(() => {});
      return {
        platform: 'reels',
        status: 'ready_for_review',
        message: '인스타 릴스 영상·캡션(해시태그) 자동 입력 완료! 확인 후 [공유하기]만 눌러주세요.',
      };
    }

    return {
      platform: 'reels',
      status: 'uploaded_wait',
      message: '인스타 릴스 영상 첨부 완료! [다음]을 눌러 문구 입력 칸에 복사한 릴스 캡션을 붙여넣어 주세요.',
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
      results.push(await prepareInstagramReelsTab(context, {
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
