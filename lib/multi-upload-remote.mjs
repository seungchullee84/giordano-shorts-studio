import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright';
import {
  FLOW_CDP_PORT,
  bringRemoteChromeToFront,
  hasVisibleRemoteChromeWindow,
  isCdpAlive,
  killHiddenRemoteChrome,
  openOrConnectRemoteChrome,
} from './flow-remote.mjs';
import {extractNaverProductId} from './publish-kit.mjs';

export const PLATFORM_URLS = {
  youtube: 'https://studio.youtube.com/',
  clip: 'https://clipcreators.naver.com/web/upload',
  reels: 'https://www.instagram.com/',
  reelsMetaFallback: 'https://business.facebook.com/latest/reels_composer',
};

let cachedUploadBrowser = null;

async function showPageOnScreen(context, page) {
  try {
    if (page && !page.isClosed()) {
      await page.bringToFront().catch(() => {});
      const cdp = await context.newCDPSession(page).catch(() => null);
      if (cdp) {
        try {
          const {windowId} = await cdp.send('Browser.getWindowForTarget');
          await cdp.send('Browser.setWindowBounds', {windowId, bounds: {windowState: 'maximized'}}).catch(() => {});
          await cdp.send('Page.bringToFront').catch(() => {});
        } catch {}
        await cdp.detach().catch(() => {});
      }
    }
  } catch {}
  await bringRemoteChromeToFront().catch(() => {});
}

async function openPlatformPage(context) {
  const pages = context.pages();
  const blank = pages.find(p => !p.isClosed() && /^(?:about:blank|chrome:\/\/newtab\/?)$/i.test(p.url()));
  if (blank) return blank;
  return await context.newPage();
}

async function connectUploadChrome(profileDir, log = () => {}, startUrl = 'about:blank') {
  let alive = await isCdpAlive(FLOW_CDP_PORT, 1500);
  if (alive && !(await hasVisibleRemoteChromeWindow())) {
    log('보이지 않는 백그라운드 전용 Chrome을 정리하고 새 창으로 다시 엽니다…');
    if (cachedUploadBrowser) {
      await cachedUploadBrowser.close().catch(() => {});
      cachedUploadBrowser = null;
    }
    await killHiddenRemoteChrome().catch(() => {});
    alive = false;
  }
  if (!alive) {
    await openOrConnectRemoteChrome({profileDir, startUrl, log});
  }
  if (!cachedUploadBrowser || !cachedUploadBrowser.isConnected()) {
    cachedUploadBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${FLOW_CDP_PORT}`);
    cachedUploadBrowser.on('disconnected', () => {
      cachedUploadBrowser = null;
    });
  }
  const context = cachedUploadBrowser.contexts()[0];
  if (!context) throw new Error('전용 Chrome 컨텍스트에 연결하지 못했습니다.');
  await bringRemoteChromeToFront().catch(() => {});
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
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  try {
    await locator.click({timeout: 4000});
  } catch {
    await locator.evaluate(el => {
      el.scrollIntoView({block: 'center'});
      el.focus();
    }).catch(() => {});
    await locator.click({force: true, timeout: 3000}).catch(() => {});
  }
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

export function classifyYoutubeUploadDialogError(dialogText = '', hasErrorScrim = false) {
  const text = String(dialogText || '').replace(/\s+/g, ' ').trim();
  if (/일일\s*업로드\s*한도\s*도달|Daily\s*upload\s*limit\s*reached/i.test(text)) {
    return {
      blocked: true,
      code: 'daily_limit',
      message: 'YouTube 일일 업로드 한도 도달 — 열린 YouTube Studio 하단의 [인증하기]를 1회 완료하거나 24시간 후 다시 시도해 주세요.',
    };
  }
  if (/중복\s*동영상|Duplicate\s*video/i.test(text)) {
    return {
      blocked: true,
      code: 'duplicate',
      message: 'YouTube 중복 동영상 감지 — 이미 업로드된 동일한 영상입니다.',
    };
  }
  if (hasErrorScrim) {
    return {
      blocked: true,
      code: 'upload_error',
      message: 'YouTube 업로드 창에 오류 안내가 표시되어 입력이 잠겼습니다. 열린 YouTube Studio 창을 확인해 주세요.',
    };
  }
  return {blocked: false, code: '', message: ''};
}

/**
 * 보안문자(CAPTCHA) · 2단계 인증(OTP) 화면 감지 시 자동 입력을 즉시 중단하고 사용자에게 넘긴다.
 */
async function hasLoginChallenge(page) {
  const fields = page.locator([
    'iframe[src*="captcha" i]',
    'iframe[src*="recaptcha" i]',
    'iframe[src*="turnstile" i]',
    'input[id*="captcha" i]',
    'input[name*="captcha" i]',
    'img[id*="captcha" i]',
    'input[autocomplete="one-time-code"]',
    'input[name="otp"]',
    'input[name="verificationCode"]',
  ].join(', '));
  const count = await fields.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    if (await fields.nth(i).isVisible().catch(() => false)) return true;
  }
  const challengeText = await page.evaluate(() => {
    const t = String(document.body?.innerText || '');
    return /보안문자|자동입력\s*방지|2단계\s*인증|2-Step\s*Verification|인증\s*알림을\s*보냈습니다|영수증\s*퀴즈|새로운\s*기기\s*등록/i.test(t);
  }).catch(() => false);
  return Boolean(challengeText);
}

async function tryNaverClipAutoLogin(context, page, loginStore, log = () => {}) {
  if (!loginStore || typeof loginStore.load !== 'function') return {attempted: false, loggedIn: false};
  let creds = null;
  try {
    creds = await loginStore.load('clip');
  } catch (err) {
    log(`🟢 저장된 네이버 로그인 정보 읽기 실패: ${err.message}`);
    return {attempted: false, loggedIn: false, reason: 'store_error'};
  }
  if (!creds) return {attempted: false, loggedIn: false, reason: 'unconfigured'};

  try {
    await showPageOnScreen(context, page);
    if (!/nid\.naver\.com/i.test(page.url())) return {attempted: false, loggedIn: true};
    if (await hasLoginChallenge(page)) return {attempted: true, loggedIn: false, reason: 'challenge'};

    const idInput = page.locator('input#id, input[name="id"]').first();
    const pwInput = page.locator('input#pw, input[name="pw"]').first();
    if (!(await idInput.isVisible({timeout: 4000}).catch(() => false)) || !(await pwInput.isVisible({timeout: 2000}).catch(() => false))) {
      return {attempted: true, loggedIn: false, reason: 'no_form'};
    }

    log('🟢 저장된 네이버 계정으로 자동 로그인을 시도합니다…');
    await idInput.fill(creds.username, {timeout: 3000});
    await idInput.press('Tab').catch(() => {});
    await page.waitForTimeout(150);
    await pwInput.fill(creds.password, {timeout: 3000});
    await pwInput.press('Tab').catch(() => {});
    await page.waitForTimeout(150);

    // 로그인 상태 유지 체크 (상품등록기 검증 방식 우선 + DOM 폴백)
    const keepRole = page.getByRole('checkbox', {name: '로그인 상태 유지', exact: true}).first();
    if (await keepRole.isVisible().catch(() => false)) {
      await keepRole.check({timeout: 3000}).catch(() => {});
    } else {
      const keepChk = page.locator('input#keep, input[name="nvlong"]').first();
      if (await keepChk.count().catch(() => 0) > 0 && !(await keepChk.isChecked().catch(() => false))) {
        const keepLabel = page.locator('label[for="keep"], .keep_check').first();
        if (await keepLabel.isVisible().catch(() => false)) {
          await keepLabel.click().catch(() => {});
        } else {
          await keepChk.check({force: true}).catch(() => {});
        }
      }
    }

    if (await hasLoginChallenge(page)) return {attempted: true, loggedIn: false, reason: 'challenge'};

    const roleSubmit = page.getByRole('button', {name: '로그인', exact: true}).first();
    if (await roleSubmit.isVisible().catch(() => false)) {
      await roleSubmit.click({timeout: 4000, noWaitAfter: true}).catch(() => {});
    } else {
      const submitBtn = await findFirstVisible(page, [
        'button#log\\.login',
        'button.btn_login',
        'button[type="submit"]:has-text("로그인")',
        'input[type="submit"][value="로그인"]',
      ], 3000);
      if (submitBtn) await submitBtn.click({timeout: 4000, noWaitAfter: true}).catch(() => {});
      else await pwInput.press('Enter').catch(() => {});
    }

    const deadline = Date.now() + 14000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(400);
      const curUrl = page.url();
      if (/clipcreators\.naver\.com/i.test(curUrl)) {
        log('🟢 네이버 자동 로그인 완료!');
        return {attempted: true, loggedIn: true};
      }
      if (await hasLoginChallenge(page)) {
        return {attempted: true, loggedIn: false, reason: 'challenge'};
      }
    }
    return {attempted: true, loggedIn: /clipcreators\.naver\.com/i.test(page.url()), reason: 'timeout'};
  } catch {
    return {attempted: true, loggedIn: false, reason: 'error'};
  } finally {
    creds = null;
  }
}

async function tryGoogleAutoLogin(context, page, loginStore, log = () => {}) {
  if (!loginStore || typeof loginStore.load !== 'function') return {attempted: false, loggedIn: false};
  let creds = null;
  try {
    creds = await loginStore.load('youtube');
  } catch (err) {
    log(`🔴 저장된 YouTube(Google) 로그인 정보 읽기 실패: ${err.message}`);
    return {attempted: false, loggedIn: false, reason: 'store_error'};
  }
  if (!creds) return {attempted: false, loggedIn: false, reason: 'unconfigured'};

  try {
    await showPageOnScreen(context, page);
    if (!/accounts\.google\.com/i.test(page.url())) return {attempted: false, loggedIn: true};
    if (await hasLoginChallenge(page)) return {attempted: true, loggedIn: false, reason: 'challenge'};

    log('🔴 저장된 YouTube(Google) 계정으로 자동 로그인을 시도합니다…');
    const emailInput = await findFirstVisible(page, ['input[type="email"]', 'input#identifierId'], 4000);
    if (emailInput) {
      await emailInput.fill(creds.username, {timeout: 3000});
      await page.waitForTimeout(200);
      const nextBtn1 = await findFirstVisible(page, [
        '#identifierNext button',
        'button:has-text("다음")',
        'button:has-text("Next")',
      ], 3000);
      if (nextBtn1) await nextBtn1.click().catch(() => {});
      else await emailInput.press('Enter').catch(() => {});
      await page.waitForTimeout(1800);
    }

    if (await hasLoginChallenge(page)) return {attempted: true, loggedIn: false, reason: 'challenge'};

    const pwInput = await findFirstVisible(page, ['input[type="password"]', 'input[name="Passwd"]'], 6000);
    if (pwInput) {
      await pwInput.fill(creds.password, {timeout: 3000});
      await page.waitForTimeout(200);
      const nextBtn2 = await findFirstVisible(page, [
        '#passwordNext button',
        'button:has-text("다음")',
        'button:has-text("Next")',
      ], 3000);
      if (nextBtn2) await nextBtn2.click().catch(() => {});
      else await pwInput.press('Enter').catch(() => {});
    }

    const deadline = Date.now() + 14000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(450);
      if (/studio\.youtube\.com/i.test(page.url())) {
        log('🔴 YouTube(Google) 자동 로그인 완료!');
        return {attempted: true, loggedIn: true};
      }
      if (await hasLoginChallenge(page)) {
        return {attempted: true, loggedIn: false, reason: 'challenge'};
      }
    }
    return {attempted: true, loggedIn: /studio\.youtube\.com/i.test(page.url()), reason: 'timeout'};
  } catch {
    return {attempted: true, loggedIn: false, reason: 'error'};
  } finally {
    creds = null;
  }
}

async function tryInstagramAutoLogin(context, page, loginStore, log = () => {}) {
  if (!loginStore || typeof loginStore.load !== 'function') return {attempted: false, loggedIn: false};
  let creds = null;
  try {
    creds = await loginStore.load('reels');
  } catch (err) {
    log(`🟣 저장된 Instagram 로그인 정보 읽기 실패: ${err.message}`);
    return {attempted: false, loggedIn: false, reason: 'store_error'};
  }
  if (!creds) return {attempted: false, loggedIn: false, reason: 'unconfigured'};

  try {
    await showPageOnScreen(context, page);
    if (await hasLoginChallenge(page)) return {attempted: true, loggedIn: false, reason: 'challenge'};

    const userInput = await findFirstVisible(page, ['input[name="username"]', 'input[name="email"]'], 4000);
    const pwInput = await findFirstVisible(page, ['input[name="password"]', 'input[name="pass"]'], 3000);
    if (!userInput || !pwInput) return {attempted: true, loggedIn: false, reason: 'no_form'};

    log('🟣 저장된 Instagram 계정으로 자동 로그인을 시도합니다…');
    await userInput.fill(creds.username, {timeout: 3000});
    await page.waitForTimeout(180);
    await pwInput.fill(creds.password, {timeout: 3000});
    await page.waitForTimeout(180);

    const submitBtn = await findFirstVisible(page, [
      'button[type="submit"]',
      'div[role="button"]:has-text("로그인")',
      'button:has-text("로그인")',
      'button:has-text("Log in")',
    ], 3000);
    if (submitBtn) await submitBtn.click().catch(() => {});
    else await pwInput.press('Enter').catch(() => {});

    const deadline = Date.now() + 14000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(500);
      if (await hasLoginChallenge(page)) {
        return {attempted: true, loggedIn: false, reason: 'challenge'};
      }
      // "로그인 정보를 저장하시겠어요?" 팝업이 뜨면 정보 저장 클릭
      const saveInfoBtn = await findFirstVisible(page, [
        'button:has-text("정보 저장")',
        'button:has-text("Save info")',
      ], 300);
      if (saveInfoBtn) {
        await saveInfoBtn.click().catch(() => {});
        await page.waitForTimeout(1000);
      }
      const hasCreate = await page.locator('svg[aria-label="새로운 게시물"], svg[aria-label="게시물"], svg[aria-label="만들기"], svg[aria-label="New post"], svg[aria-label="Create"]').count().catch(() => 0);
      if (hasCreate > 0 && !/\/accounts\/login/i.test(page.url())) {
        log('🟣 Instagram 자동 로그인 완료!');
        return {attempted: true, loggedIn: true};
      }
    }
    const stillLogin = /\/accounts\/login/i.test(page.url()) || await page.locator('input[name="password"], input[name="pass"]').first().isVisible().catch(() => false);
    return {attempted: true, loggedIn: !stillLogin, reason: stillLogin ? 'timeout' : ''};
  } catch {
    return {attempted: true, loggedIn: false, reason: 'error'};
  } finally {
    creds = null;
  }
}

/**
 * 최초 1회 로그인 편의 기능: 전용 Chrome에 선택한 플랫폼의 로그인/대시보드 탭을 열어준다.
 * 저장된 로그인 정보가 있는 플랫폼은 자동으로 1회 로그인까지 시도한다.
 */
export async function openPlatformLoginTabs({
  platforms = ['clip', 'youtube', 'reels'],
  profileDir = '',
  loginStore = null,
  log = () => {},
} = {}) {
  const {context} = await connectUploadChrome(profileDir, log, 'about:blank');
  const opened = [];
  for (const key of platforms) {
    const targetUrl = PLATFORM_URLS[key];
    if (!targetUrl) continue;
    const page = await openPlatformPage(context);
    await showPageOnScreen(context, page);
    await page.goto(targetUrl, {waitUntil: 'domcontentloaded', timeout: 25000}).catch(() => {});
    await page.waitForTimeout(1800);
    if (key === 'clip' && /nid\.naver\.com/i.test(page.url())) {
      await tryNaverClipAutoLogin(context, page, loginStore, log);
    } else if (key === 'youtube' && /accounts\.google\.com/i.test(page.url())) {
      await tryGoogleAutoLogin(context, page, loginStore, log);
    } else if (key === 'reels') {
      const needLogin = /\/accounts\/login/i.test(page.url()) || await page.locator('input[name="password"], input[name="pass"]').first().isVisible().catch(() => false);
      if (needLogin) await tryInstagramAutoLogin(context, page, loginStore, log);
    }
    opened.push({platform: key, url: page.url()});
  }
  await bringRemoteChromeToFront().catch(() => {});
  return {ok: true, opened};
}

/**
 * 🔴 YouTube Studio: 영상 파일 자동 첨부 + 제목 + 설명란(스토어 URL 포함) + 아동용 아님 자동 설정.
 * 안전 원칙: 최종 [게시] / [공개] 버튼은 절대 클릭하지 않고 검수 화면에서 멈춘다!
 */
async function prepareYoutubeTab(context, {videoPath, title, description, loginStore = null}, log) {
  const page = await openPlatformPage(context);
  await showPageOnScreen(context, page);
  try {
    log('🔴 YouTube Studio 여는 중…');
    await page.goto(PLATFORM_URLS.youtube, {waitUntil: 'domcontentloaded', timeout: 30000});
    await showPageOnScreen(context, page);
    await page.waitForTimeout(2500);

    if (/accounts\.google\.com/i.test(page.url())) {
      const loginRes = await tryGoogleAutoLogin(context, page, loginStore, log);
      if (!loginRes.loggedIn) {
        await showPageOnScreen(context, page);
        const msg = loginRes.reason === 'challenge'
          ? 'YouTube 추가 인증(보안문자/2단계 인증) 필요 — 열린 탭에서 인증을 완료해 주세요.'
          : 'YouTube 로그인 필요 — 열린 탭에서 로그인하거나 [🔐 로그인 저장]에 계정을 등록해 주세요.';
        return {platform: 'youtube', status: 'login_required', page, message: msg};
      }
      await page.waitForTimeout(2000);
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

    await page.waitForTimeout(1000);
    // YouTube 일일 업로드 한도 도달 / 중복 동영상 / 오류 스크림(show-error-scrim) 사전 감지
    const ytDialogState = await page.evaluate(() => {
      const dlg = document.querySelector('ytcp-uploads-dialog');
      if (!dlg) return {hasErrorScrim: false, text: ''};
      const hasErrorScrim = dlg.hasAttribute('show-error-scrim') || dlg.hasAttribute('has-error');
      const errText = [...dlg.querySelectorAll('[class*=error], .error-area, .error-details, .footer')]
        .map(el => (el.innerText || '').trim())
        .filter(Boolean)
        .join(' ');
      return {hasErrorScrim, text: errText || (dlg.innerText || '').slice(-400)};
    }).catch(() => ({hasErrorScrim: false, text: ''}));
    const ytErr = classifyYoutubeUploadDialogError(ytDialogState.text, ytDialogState.hasErrorScrim);
    if (ytErr.blocked) {
      await showPageOnScreen(context, page);
      return {platform: 'youtube', status: 'error', page, message: ytErr.message};
    }

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
 * 업로드 페이지 직행 → 완성 .mp4 첨부 → /web/draft/ 편집 화면의 설명란(#content-description) 입력
 * → 카테고리(1차 패션 → 2차 상품 맞춤 자동 선택) → [정보 태그 → 쇼핑] 상품번호 정확 일치 자동 연결.
 * 안전 원칙: 최종 [등록] 버튼은 절대 클릭하지 않는다!
 */
export function resolveNaverClipCategory({gender = '', headline = '', title = ''} = {}) {
  const combined = `${gender} ${headline} ${title}`.trim();
  const isUnisex = /공용|남여|남녀|유니섹스|unisex/i.test(combined);
  if (/언더웨어|속옷|내의|발열내의|드로즈|브리프|트렁크|런닝|브라|팬티|타이즈|양말|삭스/i.test(combined)) {
    return {primary: '패션', secondary: '언더웨어'};
  }
  if (/모자|캡|비니|버킷햇|가방|백팩|크로스백|토트백|에코백|벨트|머플러|목도리|스카프|장갑|지갑|우산|잡화/i.test(combined)) {
    return {primary: '패션', secondary: '잡화, 소품'};
  }
  if (!isUnisex && /여성|우먼|우먼즈|레이디|스커트|원피스|블라우스/i.test(combined)) {
    return {primary: '패션', secondary: '여성 데일리룩'};
  }
  if (!isUnisex && /남성|맨즈|남자/i.test(combined)) {
    return {primary: '패션', secondary: '남성 데일리룩'};
  }
  return {primary: '패션', secondary: '패션'};
}

/**
 * 네이버 클립 편집 화면(/web/draft/...)에서 필수 [카테고리 *] 1차·2차 드롭다운을 자동 선택한다.
 */
export async function selectNaverClipCategory(page, {gender = '', headline = '', title = ''} = {}, log = () => {}) {
  const target = resolveNaverClipCategory({gender, headline, title});
  const primaryBtn = await findFirstVisible(page, [
    'button[class*="ClipDetailForm_dropdownPrimary__"]',
    'button:has-text("1차 카테고리")',
  ], 5000);
  if (!primaryBtn) return {selected: false, reason: 'no_primary_dropdown'};

  await primaryBtn.scrollIntoViewIfNeeded().catch(() => {});
  const curPrimary = (await primaryBtn.innerText().catch(() => '')).trim();
  if (curPrimary !== target.primary) {
    await primaryBtn.click().catch(() => {});
    await page.waitForTimeout(450);
    const opt1 = page.locator('button[class*="ClipDetailForm_dropdownOption__"]').filter({hasText: new RegExp(`^${target.primary}$`)}).first();
    if (await opt1.count().catch(() => 0) > 0) {
      await opt1.click();
      await page.waitForTimeout(550);
    } else {
      return {selected: false, reason: 'primary_option_not_found'};
    }
  }

  const secondaryBtn = await findFirstVisible(page, [
    'button[class*="ClipDetailForm_dropdownSecondary__"]',
    'button:has-text("2차 카테고리")',
  ], 4000);
  if (!secondaryBtn) return {selected: false, reason: 'no_secondary_dropdown'};

  // 2차 드롭다운 활성화 대기 (최대 3초)
  const waitEnd = Date.now() + 3000;
  while (Date.now() < waitEnd && (await secondaryBtn.isDisabled().catch(() => true))) {
    await page.waitForTimeout(200);
  }
  if (await secondaryBtn.isDisabled().catch(() => true)) {
    return {selected: false, reason: 'secondary_disabled'};
  }

  const curSecondary = (await secondaryBtn.innerText().catch(() => '')).trim();
  if (curSecondary !== target.secondary) {
    await secondaryBtn.click().catch(() => {});
    await page.waitForTimeout(450);
    const escapedSec = target.secondary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let opt2 = page.locator('button[class*="ClipDetailForm_dropdownOption__"]').filter({hasText: new RegExp(`^${escapedSec}$`)}).first();
    if (await opt2.count().catch(() => 0) === 0) {
      opt2 = page.locator('button[class*="ClipDetailForm_dropdownOption__"]').filter({hasText: /^패션$/}).first();
    }
    if (await opt2.count().catch(() => 0) > 0) {
      await opt2.click();
      await page.waitForTimeout(450);
    } else {
      return {selected: false, reason: 'secondary_option_not_found'};
    }
  }

  const finalPrimary = (await primaryBtn.innerText().catch(() => '')).trim();
  const finalSecondary = (await secondaryBtn.innerText().catch(() => '')).trim();
  const ok = Boolean(finalPrimary && finalPrimary !== '1차 카테고리' && finalSecondary && finalSecondary !== '2차 카테고리');
  if (ok) {
    log(`🟢 네이버 클립 [카테고리] 자동 선택 완료: ${finalPrimary} > ${finalSecondary}`);
  }
  return {selected: ok, primary: finalPrimary, secondary: finalSecondary};
}

/**
 * 네이버 클립 편집 화면(/web/draft/...) 상세정보의 [AI 활용 설정] 스위치(role="switch")만
 * 정밀 탐색해 ON(aria-checked="true")으로 체크한다. (인접한 [광고·협찬 설정]은 절대 건드리지 않음!)
 */
export async function enableNaverClipAiDisclosure(page, log = () => {}) {
  const aiLabel = page.locator('span[class*="ClipDetailForm_moduleLabel"]', {hasText: /^AI 활용 설정$/}).first();
  if (await aiLabel.count().catch(() => 0) === 0) {
    return {enabled: false, reason: 'no_ai_label'};
  }
  const aiRow = page.locator('div, section').filter({has: aiLabel}).filter({
    has: page.locator('button[role="switch"]'),
  }).last();
  const aiSwitch = aiRow.locator('button[role="switch"]').first();
  if (await aiSwitch.count().catch(() => 0) === 0) {
    return {enabled: false, reason: 'no_ai_switch'};
  }
  await aiSwitch.scrollIntoViewIfNeeded().catch(() => {});
  const before = (await aiSwitch.getAttribute('aria-checked').catch(() => '')) === 'true';
  if (!before) {
    await aiSwitch.click().catch(() => {});
    await page.waitForTimeout(350);
  }
  const after = (await aiSwitch.getAttribute('aria-checked').catch(() => '')) === 'true';
  if (after) {
    log('🟢 네이버 클립 [AI 활용 설정] 자동 체크 완료');
  }
  return {enabled: after, alreadyOn: before};
}

export function extractNaverRegisteredProductTitle(rawTitle = '', ogTitle = '') {
  const cleanOne = (raw) => {
    let t = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    // "백화점 : 네이버+ 스토어 : 상품상세 : <상품명>" 패턴
    if (t.includes('상품상세 :')) {
      t = t.split('상품상세 :').pop().trim();
    }
    // "이런 상품 어때요? <상품명>" og:title 패턴
    t = t.replace(/^이런\s*상품\s*어때요\??\s*/i, '').trim();
    // 뒤쪽 ": 네이버 쇼핑", ": 스마트스토어", "| 네이버+" 등 접미사 제거
    t = t.replace(/\s*[:|·-]\s*(?:네이버\+?\s*스토어|네이버\s*쇼핑|스마트스토어|백화점\s*윈도|브랜드\s*스토어).*$/i, '').trim();
    // 앞쪽 "네이버 쇼핑 :" 등 접두사 제거
    t = t.replace(/^(?:백화점|네이버\+?\s*스토어|네이버\s*쇼핑|스마트스토어)\s*[:|]\s*/i, '').trim();
    return t;
  };
  const fromTitle = cleanOne(rawTitle);
  const fromOg = cleanOne(ogTitle);
  if (fromOg && (!fromTitle || /네이버\s*쇼핑|스마트스토어|스토어$/i.test(fromTitle))) return fromOg;
  return fromTitle || fromOg || '';
}

function fitClipSearchLen(q, maxLen = 40) {
  const s = String(q || '').replace(/\s+/g, ' ').trim();
  if (s.length <= maxLen) return s;
  const words = s.split(' ');
  let out = '';
  for (const w of words) {
    const next = out ? `${out} ${w}` : w;
    if (next.length > maxLen) break;
    out = next;
  }
  return out || s.slice(0, maxLen).trim();
}

export function buildClipShopSearchQueries({storeName = '', style = '', headline = '', registeredTitle = ''} = {}) {
  const s = String(style || '').trim();
  const st = String(storeName || '').trim();
  const h = String(headline || '').trim();
  const reg = String(registeredTitle || '').replace(/\s+/g, ' ').trim();
  const queries = [];

  // 1순위: 실제 네이버 상품 페이지에서 가져온 등록 상품명 (품번을 살짝 변형 등록해도 100% 적중!)
  if (reg) {
    queries.push(fitClipSearchLen(reg, 40));
    // 등록 제목이 길어 뒤쪽 변형 품번/핵심어가 잘린 경우: 앞 핵심 + 끝 토큰 조합 추가
    const regWords = reg.split(' ').filter(Boolean);
    if (reg.length > 40 && regWords.length >= 3) {
      const tail = regWords[regWords.length - 1];
      queries.push(fitClipSearchLen(`${regWords.slice(0, 4).join(' ')} ${tail}`, 40));
    }
    // 괄호·특수문자 제거한 순수 상품명
    const regClean = reg.replace(/[()[\]/]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (regClean && regClean !== reg) queries.push(fitClipSearchLen(regClean, 40));
  }

  // 2순위: 공식몰/편집기 상품 제목 기반 검색 (품번이 꼬여 있어도 제목으로 탐색)
  if (/동탄/.test(st) && /롯데/.test(st)) {
    if (h) queries.push(fitClipSearchLen(`롯데백화점 동탄점 지오다노 ${h}`, 40));
    if (s) queries.push(fitClipSearchLen(`롯데백화점 동탄점 지오다노 ${s}`, 40));
    if (s.length >= 6) queries.push(fitClipSearchLen(`롯데백화점 동탄점 지오다노 ${s.slice(-5)}`, 40));
    if (h) queries.push(fitClipSearchLen(`롯데백화점 동탄점 지오다노 ${h.split(/\s+/).slice(0, 2).join(' ')}`, 40));
  }
  if (h) queries.push(fitClipSearchLen(`지오다노 ${h}`, 40));
  if (st && s) queries.push(fitClipSearchLen(`${st} ${s}`, 40));
  if (s) queries.push(fitClipSearchLen(`지오다노 ${s}`, 40));
  if (s.length >= 6) queries.push(fitClipSearchLen(`지오다노 ${s.slice(-5)}`, 40));

  return [...new Set(queries.map(q => q.replace(/\s+/g, ' ').trim()).filter(Boolean))];
}

export function buildClipPlaceSearchQuery(storeName = '') {
  const st = String(storeName || '').replace(/\s+/g, ' ').trim();
  if (!st || (/동탄/.test(st) && /롯데/.test(st))) {
    return '지오다노 롯데백화점 동탄점';
  }
  return st;
}

async function fetchNaverRegisteredTitle(context, productUrl, log = () => {}) {
  if (!productUrl || !/naver\.com/i.test(productUrl) || !context) return '';
  let tmpPage = null;
  try {
    tmpPage = await context.newPage();
    await tmpPage.goto(productUrl, {waitUntil: 'domcontentloaded', timeout: 12000});
    await tmpPage.waitForTimeout(900);
    const info = await tmpPage.evaluate(() => ({
      title: document.title || '',
      ogTitle: document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '',
    }));
    const extracted = extractNaverRegisteredProductTitle(info.title, info.ogTitle);
    if (extracted) {
      log(`🟢 개별 URL 등록 상품명 확인: ${extracted}`);
    }
    return extracted;
  } catch {
    return '';
  } finally {
    if (tmpPage) await tmpPage.close().catch(() => {});
  }
}

/**
 * 네이버 클립 [정보 태그 → 장소] 팝업을 열어 매장 장소(예: 지오다노 롯데백화점 동탄점)를 자동 연결한다.
 */
export async function attachNaverClipPlaceTag(page, {storeName = ''} = {}, log = () => {}) {
  const query = buildClipPlaceSearchQuery(storeName);
  if (!query) return {attached: false, reason: 'no_query'};

  const placeBtn = await findFirstVisible(page, [
    'button[data-nlog-params*="place"]',
    'button:has-text("장소")',
  ], 5000);
  if (!placeBtn) return {attached: false, reason: 'no_place_button'};

  await placeBtn.scrollIntoViewIfNeeded().catch(() => {});
  await placeBtn.click().catch(() => {});
  await page.waitForTimeout(1100);

  const searchInput = await findFirstVisible(page, [
    'input[placeholder*="장소 검색"]',
    'input[class*="TagSearchBar_searchInput"]',
  ], 5000);
  if (!searchInput) return {attached: false, reason: 'no_search_input'};

  let lastItems = [];
  let respReceived = false;
  const onResp = async res => {
    if (!/editor-meta\/place\/search/i.test(res.url()) || res.status() !== 200) return;
    try {
      const json = await res.json();
      lastItems = Array.isArray(json?.items) ? json.items : [];
      respReceived = true;
    } catch {}
  };
  page.on('response', onResp);

  try {
    log(`🟢 네이버 클립 [장소 태그] 검색 중: ${query}`);
    await searchInput.fill('');
    await searchInput.fill(query);
    const searchBtn = await findFirstVisible(page, [
      'button[aria-label="검색"]',
      'button[class*="TagSearchBar_searchIconWrap"]',
    ], 2500);
    if (searchBtn) await searchBtn.click().catch(() => {});
    else await searchInput.press('Enter').catch(() => {});

    const waitEnd = Date.now() + 4000;
    while (Date.now() < waitEnd && !respReceived) {
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(450);

    if (lastItems.length > 0) {
      const tokens = query.split(/\s+/).filter(w => w.length >= 2);
      let matchIdx = lastItems.findIndex(it => {
        const hay = `${it?.name || ''} ${it?.address || ''} ${it?.roadAddress || ''}`;
        return tokens.every(tk => hay.includes(tk));
      });
      if (matchIdx < 0 && lastItems.length === 1) matchIdx = 0;

      if (matchIdx >= 0) {
        const cards = page.locator('[class*="InfoTagPopupView_card__"]');
        const cardCount = await cards.count().catch(() => 0);
        if (matchIdx < cardCount) {
          const pickBtn = cards.nth(matchIdx).locator('button:has-text("선택")').first();
          await pickBtn.scrollIntoViewIfNeeded().catch(() => {});
          await pickBtn.click();
          await page.waitForTimeout(800);
          const confirmBtn = await findFirstVisible(page, [
            '[class*="Modal_"] button:has-text("추가")',
            '[class*="Modal_"] button:has-text("확인")',
            '[class*="Modal_"] button:has-text("적용")',
            '[class*="Modal_"] button:has-text("완료")',
          ], 1000);
          if (confirmBtn) {
            await confirmBtn.click().catch(() => {});
            await page.waitForTimeout(500);
          }
          const picked = lastItems[matchIdx];
          log(`🟢 네이버 클립 [장소 태그] 자동 연결 완료: ${picked.name || query}`);
          return {attached: true, placeName: picked.name || query};
        }
      }
    }
    // 못 찾았으면 모달 닫아 다음 쇼핑 태그 입력에 방해되지 않게 정리
    const closeBtn = await findFirstVisible(page, ['[class*="Modal_closeBtn"]', 'button[aria-label*="닫기"]'], 1000);
    if (closeBtn) await closeBtn.click().catch(() => {});
    return {attached: false, reason: 'place_not_found'};
  } finally {
    page.off('response', onResp);
  }
}

/**
 * 네이버 클립 [정보 태그 → 쇼핑] 팝업을 열어 개별 상품 URL의 등록 상품명으로 검색하고
 * 1~3페이지까지 탐색해 상품번호(mallProductId)와 100% 일치하는 우리 매장 상품을 자동 선택한다.
 * (다른 지점 오선택 방지를 위해 상품번호가 정확히 일치할 때만 자동 선택 클릭!)
 */
export async function attachNaverClipShoppingTag(page, {productUrl = '', productId = '', style = '', storeName = '', headline = '', registeredTitle = ''} = {}, log = () => {}) {
  const targetId = String(productId || extractNaverProductId(productUrl) || '').trim();
  const resolvedRegTitle = registeredTitle || (productUrl ? await fetchNaverRegisteredTitle(page.context(), productUrl, log) : '');
  const queries = buildClipShopSearchQueries({storeName, style, headline, registeredTitle: resolvedRegTitle});
  if (!queries.length) return {attached: false, reason: 'no_query'};

  const shopBtn = await findFirstVisible(page, [
    'button[data-nlog-params*="shopping"]',
    'button:has-text("쇼핑")',
  ], 5000);
  if (!shopBtn) return {attached: false, reason: 'no_shop_button'};

  await shopBtn.scrollIntoViewIfNeeded().catch(() => {});
  await shopBtn.click().catch(() => {});
  await page.waitForTimeout(1300);

  const searchInput = await findFirstVisible(page, [
    'input[placeholder*="쇼핑 상품 검색"]',
    'input[class*="TagSearchBar_searchInput"]',
  ], 5000);
  if (!searchInput) return {attached: false, reason: 'no_search_input'};

  let lastItems = [];
  let respSeq = 0;
  const onResp = async res => {
    if (!/editor-meta\/shopping\/search/i.test(res.url()) || res.status() !== 200) return;
    try {
      const json = await res.json();
      lastItems = Array.isArray(json?.items) ? json.items : [];
      respSeq += 1;
    } catch {}
  };
  page.on('response', onResp);

  const tryPickMatchedOnCurrentPage = async (queryUsed) => {
    if (!targetId || lastItems.length === 0) return null;
    const matchIdx = lastItems.findIndex(it =>
      String(it?.mallProductId || '') === targetId ||
      String(it?.id || '') === targetId ||
      String(it?.landingUrl || '').includes(`/${targetId}`)
    );
    if (matchIdx < 0) return null;
    const cards = page.locator('[class*="InfoTagPopupView_card__"]');
    const cardCount = await cards.count().catch(() => 0);
    if (matchIdx >= cardCount) return null;
    const pickBtn = cards.nth(matchIdx).locator('button:has-text("선택")').first();
    await pickBtn.scrollIntoViewIfNeeded().catch(() => {});
    await pickBtn.click();
    await page.waitForTimeout(900);
    const confirmBtn = await findFirstVisible(page, [
      '[class*="Modal_"] button:has-text("추가")',
      '[class*="Modal_"] button:has-text("확인")',
      '[class*="Modal_"] button:has-text("적용")',
      '[class*="Modal_"] button:has-text("완료")',
    ], 1200);
    if (confirmBtn) {
      await confirmBtn.click().catch(() => {});
      await page.waitForTimeout(600);
    }
    const matchedItem = lastItems[matchIdx];
    log(`🟢 네이버 클립 [쇼핑 태그] 상품 자동 연결 완료: ${matchedItem.productName || targetId}`);
    return {attached: true, productId: targetId, productName: matchedItem.productName || '', query: queryUsed};
  };

  try {
    for (const q of queries) {
      const prevSeq = respSeq;
      lastItems = [];
      log(`🟢 네이버 클립 [쇼핑 태그] 검색 중: ${q}`);
      await searchInput.fill('');
      await searchInput.fill(q);
      const searchBtn = await findFirstVisible(page, [
        'button[aria-label="검색"]',
        'button[class*="TagSearchBar_searchIconWrap"]',
      ], 2500);
      if (searchBtn) await searchBtn.click().catch(() => {});
      else await searchInput.press('Enter').catch(() => {});

      const waitEnd = Date.now() + 4000;
      while (Date.now() < waitEnd && respSeq === prevSeq) {
        await page.waitForTimeout(200);
      }
      await page.waitForTimeout(450);

      // 1페이지 검사
      const hit1 = await tryPickMatchedOnCurrentPage(q);
      if (hit1) return hit1;

      // 1페이지에 없고 targetId가 있으면 2~3페이지까지 자동 탐색
      if (targetId && lastItems.length >= 10) {
        for (const pageNum of ['2', '3']) {
          const pBtn = page.locator('button[class*="TagPagination_pageBtn__"]').filter({hasText: new RegExp(`^${pageNum}$`)}).first();
          if (await pBtn.count().catch(() => 0) === 0) break;
          const seqBeforePage = respSeq;
          await pBtn.click().catch(() => {});
          const pWaitEnd = Date.now() + 3500;
          while (Date.now() < pWaitEnd && respSeq === seqBeforePage) {
            await page.waitForTimeout(200);
          }
          await page.waitForTimeout(400);
          const hitP = await tryPickMatchedOnCurrentPage(q);
          if (hitP) return hitP;
        }
      }

      // targetId가 없으면 첫 번째 검색 결과를 열어둔 상태로 멈춤 (수동 1클릭 선택 편의)
      if (!targetId && lastItems.length > 0) {
        return {attached: false, openedSearch: true, query: q, reason: 'no_target_id'};
      }
    }
    return {attached: false, openedSearch: true, reason: 'not_found_exact_id'};
  } finally {
    page.off('response', onResp);
  }
}

async function prepareNaverClipTab(context, {videoPath, title, body, productUrl = '', productId = '', style = '', storeName = '', headline = '', gender = '', loginStore = null}, log) {
  const page = await openPlatformPage(context);
  await showPageOnScreen(context, page);
  try {
    log('🟢 네이버 클립 업로드 페이지 여는 중…');
    await page.goto(PLATFORM_URLS.clip, {waitUntil: 'domcontentloaded', timeout: 30000});
    await showPageOnScreen(context, page);
    await page.waitForTimeout(2200);

    if (/nid\.naver\.com/i.test(page.url())) {
      const loginRes = await tryNaverClipAutoLogin(context, page, loginStore, log);
      if (!loginRes.loggedIn) {
        await showPageOnScreen(context, page);
        const msg = loginRes.reason === 'challenge'
          ? '네이버 추가 인증(보안문자/2단계 인증) 필요 — 열린 네이버 클립 탭에서 완료 후 다시 눌러주세요.'
          : '네이버 로그인 필요 — 열린 네이버 클립 탭에서 로그인하거나 [🔐 로그인 저장]에 계정을 등록해 주세요.';
        return {platform: 'clip', status: 'login_required', page, message: msg};
      }
      await page.waitForTimeout(1800);
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
        await showPageOnScreen(context, page);
        return {platform: 'clip', status: 'login_required', page, message: '네이버 로그인 필요 — 열린 네이버 클립 탭에서 로그인 후 다시 눌러주세요.'};
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

    // 1) 필수 [카테고리 *] 1차(패션) · 2차(성별/품목 맞춤) 자동 선택
    const catRes = await selectNaverClipCategory(page, {gender, headline, title}, log).catch(() => ({selected: false}));

    // 2) 상세정보 [AI 활용 설정] 스위치 자동 체크 (광고·협찬 스위치는 건드리지 않음)
    const aiRes = await enableNaverClipAiDisclosure(page, log).catch(() => ({enabled: false}));

    // 3) [정보 태그 → 장소] 매장 장소(지오다노 롯데백화점 동탄점 등) 자동 연결
    const placeRes = await attachNaverClipPlaceTag(page, {storeName}, log).catch(() => ({attached: false}));

    // 4) [정보 태그 → 쇼핑] 개별 URL 등록 상품명 조회 → 제목 검색 + 1~3페이지 탐색으로 상품번호 100% 일치 자동 연결
    let shopTagRes = {attached: false};
    if (productUrl || productId || style || headline) {
      shopTagRes = await attachNaverClipShoppingTag(page, {
        productUrl,
        productId,
        style,
        storeName,
        headline,
      }, log).catch(() => ({attached: false}));
    }

    const doneBadges = [];
    if (catRes.selected) doneBadges.push(`카테고리(${catRes.primary} > ${catRes.secondary})`);
    if (aiRes.enabled) doneBadges.push('AI 활용 체크');
    if (placeRes.attached) doneBadges.push(`장소(${placeRes.placeName || '매장'})`);
    if (shopTagRes.attached) doneBadges.push(`쇼핑 태그(${shopTagRes.productName || '상품'})`);
    const badgeStr = doneBadges.length ? `·[${doneBadges.join(' · ')}]` : '';
    const doneMsg = shopTagRes.attached
      ? `네이버 클립 영상·본문${badgeStr} 자동 완료! 확인 후 바로 [등록]만 눌러주세요.`
      : `네이버 클립 영상·본문${badgeStr} 자동 완료! 열린 [쇼핑] 검색창에서 상품 선택 후 바로 [등록]해 주세요.`;

    return {
      platform: 'clip',
      status: 'ready_for_review',
      categorySelected: Boolean(catRes.selected),
      category: catRes.selected ? `${catRes.primary} > ${catRes.secondary}` : '',
      aiDisclosureEnabled: Boolean(aiRes.enabled),
      placeTagAttached: Boolean(placeRes.attached),
      shoppingTagAttached: Boolean(shopTagRes.attached),
      message: doneMsg,
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
async function prepareInstagramReelsTab(context, {videoPath, caption, loginStore = null}, log) {
  const page = await openPlatformPage(context);
  await showPageOnScreen(context, page);
  try {
    log('🟣 Instagram(인스타 릴스) 여는 중…');
    await page.goto(PLATFORM_URLS.reels, {waitUntil: 'domcontentloaded', timeout: 30000});
    await showPageOnScreen(context, page);
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
      const loginRes = await tryInstagramAutoLogin(context, page, loginStore, log);
      if (!loginRes.loggedIn) {
        await showPageOnScreen(context, page);
        const msg = loginRes.reason === 'challenge'
          ? 'Instagram 추가 인증(보안문자/2단계 인증) 필요 — 열린 Instagram 탭에서 완료 후 다시 눌러주세요.'
          : 'Instagram 로그인 필요 — 열린 Instagram 탭에서 로그인하거나 [🔐 로그인 저장]에 계정을 등록해 주세요.';
        return {
          platform: 'reels',
          status: 'login_required',
          page,
          message: msg,
        };
      }
      await page.waitForTimeout(1800);
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

let multiUploadCancelRequested = false;

export function cancelMultiPlatformPrepare() {
  multiUploadCancelRequested = true;
}

export function isMultiPlatformCancelRequested() {
  return multiUploadCancelRequested;
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
  loginStore = null,
  onStatus = () => {},
} = {}) {
  multiUploadCancelRequested = false;
  if (!videoPath || !fs.existsSync(videoPath)) {
    throw new Error('먼저 완성된 숏츠 영상(.mp4)을 제작하거나 목록에서 선택해 주세요.');
  }
  const selected = (Array.isArray(platforms) ? platforms : []).filter(p => ['youtube', 'clip', 'reels'].includes(p));
  if (!selected.length) {
    throw new Error('자동 준비할 플랫폼(클립·쇼츠·릴스)을 1개 이상 선택해 주세요.');
  }

  onStatus('전용 Chrome에 연결하는 중…');
  const {context} = await connectUploadChrome(profileDir, onStatus, 'about:blank');

  const results = [];
  for (const p of selected) {
    if (multiUploadCancelRequested) {
      results.push({platform: p, status: 'cancelled', message: '사용자 요청으로 중단됨'});
      break;
    }
    if (p === 'youtube') {
      results.push(await prepareYoutubeTab(context, {
        videoPath,
        title: shorts.title || '',
        description: shorts.description || '',
        loginStore,
      }, onStatus));
    } else if (p === 'clip') {
      results.push(await prepareNaverClipTab(context, {
        videoPath,
        title: clip.title || '',
        body: clip.body || '',
        productUrl: clip.productUrl || '',
        productId: clip.productId || '',
        style: clip.style || '',
        storeName: clip.storeName || '',
        headline: clip.headline || '',
        gender: clip.gender || '',
        loginStore,
      }, onStatus));
    } else if (p === 'reels') {
      results.push(await prepareInstagramReelsTab(context, {
        videoPath,
        caption: reels.caption || '',
        loginStore,
      }, onStatus));
    }
  }

  // 로그인 필요 또는 오류 안내가 있는 탭을 맨 앞으로 포커스해 바로 조치할 수 있게 함
  const focusTarget = results.find(r => r.status === 'login_required' && r.page)
    || results.find(r => r.status === 'error' && r.page);
  if (focusTarget?.page) {
    await showPageOnScreen(context, focusTarget.page);
  } else {
    await bringRemoteChromeToFront().catch(() => {});
  }
  const cleanResults = results.map(({page: _p, ...rest}) => rest);
  const readyCount = cleanResults.filter(r => r.status === 'ready_for_review').length;
  const loginCount = cleanResults.filter(r => r.status === 'login_required').length;
  let summary = `3대 플랫폼 준비 완료 (자동 입력 ${readyCount}곳`;
  if (loginCount > 0) summary += ` · 로그인 필요 ${loginCount}곳`;
  summary += ') — 전용 Chrome에서 확인 후 게시만 눌러주세요!';

  return {ok: true, results: cleanResults, summary};
}
