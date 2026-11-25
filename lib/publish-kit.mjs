import fs from 'node:fs';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {classifyGarmentCategory} from './flow-engine.mjs';

export const DEFAULT_PUBLISH_SETTINGS = {
  storeName: '동탄롯데 지오다노',
  storeUrl: '',
  instagramHandle: '',
  productUrls: {},
};

const TRACKING_QUERY_KEYS = new Set([
  'napm', 'nt_source', 'nt_medium', 'nt_detail', 'nt_keyword', 'nt_alias',
  'fbclid', 'igshid', 'gclid', 'ref', 'from', 'tr', 'ci', 'ct', 'hk', 'nv_ad',
]);

export function normalizeHttpUrl(raw = '') {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    if (!['http:', 'https:'].includes(u.protocol)) return '';
    const host = u.hostname.toLowerCase();
    // 네이버 쇼핑(백화점윈도)·스마트스토어·브랜드스토어 상품/스토어 정식 주소는
    // ?NaPm=..., ?nl-query=... 등 모든 불필요 쿼리·해시를 제거해 가장 짧은 정식 주소만 유지
    const isNaverCanonicalPath =
      (host === 'shopping.naver.com' && /^\/(?:window-products\/[^/]+\/\d+|window\/[^/]+\/store\/\d+)/i.test(u.pathname)) ||
      ((host === 'smartstore.naver.com' || host === 'm.smartstore.naver.com' || host === 'brand.naver.com') &&
        /^\/[^/]+\/products\/\d+/i.test(u.pathname));
    if (isNaverCanonicalPath) {
      u.search = '';
      u.hash = '';
      u.pathname = u.pathname.replace(/\/+$/, '');
      return u.href;
    }
    // 그 외 URL에서도 네이버 쇼핑 ?NaPm=... 및 utm_* 등 불필요한 추적 꼬리표 자동 제거
    for (const key of [...u.searchParams.keys()]) {
      const low = key.toLowerCase();
      if (TRACKING_QUERY_KEYS.has(low) || low.startsWith('utm_') || low.startsWith('nt_')) {
        u.searchParams.delete(key);
      }
    }
    return u.href;
  } catch {
    return '';
  }
}

export function extractNaverProductId(rawUrl = '') {
  const clean = normalizeHttpUrl(rawUrl);
  if (!clean) return '';
  const m = clean.match(/\/(?:window-products\/[^/]+|products|itemdetail|catalog)\/(\d{7,15})(?:[/?#]|$)/i);
  return m ? m[1] : '';
}

function normalizeProductUrlMap(rawMap) {
  const out = {};
  if (!rawMap || typeof rawMap !== 'object') return out;
  for (const [k, v] of Object.entries(rawMap)) {
    const styleKey = String(k || '').trim();
    const cleanUrl = normalizeHttpUrl(v || '');
    if (styleKey && cleanUrl) out[styleKey] = cleanUrl;
  }
  return out;
}

export function loadPublishSettingsSync(dataDir) {
  const p = path.join(dataDir, 'publish-settings.json');
  try {
    if (!fs.existsSync(p)) return {...DEFAULT_PUBLISH_SETTINGS, productUrls: {}};
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      storeName: String(raw.storeName || DEFAULT_PUBLISH_SETTINGS.storeName).trim() || DEFAULT_PUBLISH_SETTINGS.storeName,
      storeUrl: normalizeHttpUrl(raw.storeUrl || ''),
      instagramHandle: String(raw.instagramHandle || '').replace(/^@+/, '').trim(),
      productUrls: normalizeProductUrlMap(raw.productUrls),
    };
  } catch {
    return {...DEFAULT_PUBLISH_SETTINGS, productUrls: {}};
  }
}

export function getSavedProductUrl(dataDir, style = '') {
  const key = String(style || '').trim();
  if (!key) return '';
  const settings = loadPublishSettingsSync(dataDir);
  return settings.productUrls?.[key] || '';
}

export async function saveProductUrlForStyle(dataDir, style = '', rawUrl = '') {
  const key = String(style || '').trim();
  if (!key) return loadPublishSettingsSync(dataDir);
  const cur = loadPublishSettingsSync(dataDir);
  const nextMap = {...(cur.productUrls || {})};
  const cleanUrl = normalizeHttpUrl(rawUrl || '');
  if (cleanUrl) nextMap[key] = cleanUrl;
  else delete nextMap[key];
  return await savePublishSettings(dataDir, {productUrls: nextMap});
}

export function buildStoreSearchUrl(baseStoreUrl = '') {
  const cleanBase = normalizeHttpUrl(baseStoreUrl);
  return cleanBase || 'https://shopping.naver.com/';
}

export async function savePublishSettings(dataDir, patch = {}) {
  await mkdir(dataDir, {recursive: true});
  const cur = loadPublishSettingsSync(dataDir);
  const next = {...cur};
  if (patch.storeName !== undefined) {
    const clean = String(patch.storeName || '').trim();
    if (clean) next.storeName = clean;
  }
  if (patch.storeUrl !== undefined) {
    next.storeUrl = normalizeHttpUrl(patch.storeUrl);
  }
  if (patch.instagramHandle !== undefined) {
    next.instagramHandle = String(patch.instagramHandle || '').replace(/^@+/, '').trim();
  }
  if (patch.productUrls && typeof patch.productUrls === 'object') {
    next.productUrls = normalizeProductUrlMap(patch.productUrls);
  }
  await writeFile(path.join(dataDir, 'publish-settings.json'), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function cleanProductTitle(raw = '') {
  return String(raw || '')
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/\b\d{6,8}\b/g, ' ')
    .replace(/변우석|문가영/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildCategoryTags(name = '', material = '', gender = '', category = 'top', style = '') {
  // 사용자 확정 기본 고정 해시태그: #지오다노 #동탄롯데백화점
  const tags = ['#지오다노', '#동탄롯데백화점'];
  const evidence = `${name} ${material}`;
  const gp = /남성/.test(gender) ? '남자' : /여성/.test(gender) ? '여자' : '';
  const hasBrushed = /기모|브러[시쉬]드/.test(evidence);
  const hasLinen = /린넨|리넨/.test(evidence);
  const hasWool = /울|캐시미어|메리노/.test(evidence);
  const hasSpan = /스판|스트레치|폴리우레탄|엘라스틴/.test(evidence);

  // 주의: '반팔 티셔츠'·'긴팔 티셔츠'·'스웻셔츠'와 '반팔 셔츠'·'긴팔 셔츠'를 정확히 분리 판별!
  const isPureShirt = /셔츠|블라우스/.test(name) && !/티셔츠|스웻셔츠/.test(name);
  if (/반팔/.test(name) && !isPureShirt) {
    tags.push('#지오다노반팔티', gp ? `#${gp}반팔티` : '#반팔티', '#반팔티셔츠', '#기본반팔티');
  } else if (/긴팔/.test(name) && !isPureShirt) {
    tags.push('#지오다노긴팔티', gp ? `#${gp}긴팔티` : '#긴팔티', '#긴팔티셔츠', hasBrushed ? '#기모긴팔티' : '#기본긴팔티');
  } else if (/카라티|폴로/.test(name)) {
    tags.push('#지오다노카라티', gp ? `#${gp}카라티` : '#카라티', '#폴로티');
  } else if (/티셔츠|반팔티|긴팔티/.test(name)) {
    tags.push('#지오다노티셔츠', gp ? `#${gp}티셔츠` : '#티셔츠', '#기본티셔츠');
  } else if (/맨투맨|스웻셔츠/.test(name)) {
    tags.push('#지오다노맨투맨', gp ? `#${gp}맨투맨` : '#맨투맨', hasBrushed ? '#기모맨투맨' : '#기본맨투맨');
  } else if (/후드\s*집업/.test(name)) {
    tags.push('#지오다노후드집업', gp ? `#${gp}후드집업` : '#후드집업', hasBrushed ? '#기모후드집업' : '#집업');
  } else if (/후드티|후디|후드/.test(name)) {
    tags.push('#지오다노후드티', gp ? `#${gp}후드티` : '#후드티', hasBrushed ? '#기모후드티' : '#데일리후드');
  } else if (/가디건/.test(name)) {
    tags.push('#지오다노가디건', gp ? `#${gp}가디건` : '#가디건', hasWool ? '#울가디건' : '#니트가디건');
  } else if (/니트|스웨터|풀오버/.test(name)) {
    tags.push('#지오다노니트', gp ? `#${gp}니트` : '#니트', '#스웨터', hasWool ? '#울니트' : '#데일리니트');
  } else if (/패딩|다운|푸퍼/.test(name)) {
    const isLight = /경량|클라우드/.test(name);
    tags.push(isLight ? '#지오다노경량패딩' : '#지오다노패딩', isLight ? '#경량패딩' : '#패딩', gp ? `#${gp}패딩` : '#겨울아우터');
  } else if (/코트/.test(name)) {
    tags.push('#지오다노코트', gp ? `#${gp}코트` : '#코트', '#겨울코트');
  } else if (/자켓|재킷|블루종|점퍼/.test(name)) {
    tags.push('#지오다노자켓', gp ? `#${gp}자켓` : '#자켓', '#데일리자켓');
  } else if (isPureShirt) {
    tags.push('#지오다노셔츠', gp ? `#${gp}셔츠` : '#셔츠', hasLinen ? '#린넨셔츠' : '#데일리셔츠');
  } else if (/트레이닝|조거/.test(name)) {
    tags.push('#지오다노트레이닝팬츠', gp ? `#${gp}트레이닝팬츠` : '#트레이닝팬츠', hasBrushed ? '#기모트레이닝팬츠' : '#편한바지');
  } else if (/슬랙스/.test(name)) {
    tags.push('#지오다노슬랙스', gp ? `#${gp}슬랙스` : '#슬랙스', hasSpan ? '#스판슬랙스' : '#데일리슬랙스');
  } else if (/데님|청바지|진/.test(name)) {
    tags.push('#지오다노청바지', gp ? `#${gp}청바지` : '#청바지', '#데님팬츠');
  } else if (/반바지|쇼츠|하프팬츠/.test(name)) {
    tags.push('#지오다노반바지', gp ? `#${gp}반바지` : '#반바지', '#여름반바지');
  } else if (/치노|카고|팬츠|바지/.test(name)) {
    tags.push('#지오다노팬츠', gp ? `#${gp}팬츠` : '#데일리팬츠', hasBrushed ? '#기모바지' : '#바지추천');
  } else if (/스커트|치마/.test(name)) {
    tags.push('#지오다노스커트', '#스커트', '#데일리스커트');
  } else if (category === 'bottom') {
    tags.push('#지오다노팬츠', '#데일리팬츠');
  } else if (category === 'outer') {
    tags.push('#지오다노아우터', '#데일리아우터');
  } else {
    tags.push('#지오다노상의', '#데일리상의');
  }

  if (hasBrushed && !tags.some(t => t.includes('기모'))) tags.push('#기모');
  if (hasLinen && !tags.some(t => t.includes('린넨'))) tags.push('#린넨');
  if (/면\s*100%/.test(material)) tags.push('#면100');
  if (style) tags.push(`#${style}`);
  tags.push('#데일리룩');

  return [...new Set(tags)].filter(t => t.length > 1);
}

/**
 * 확인된 공식 상품 팩트 + 사용자 스토어 URL만으로
 * 네이버 클립 · 유튜브 쇼츠 · 인스타 릴스 3대 플랫폼 맞춤 배포 문구를 자동 생성한다.
 */
export function buildPublishKit({product = {}, facts = {}, garmentCategory = 'auto', publishSettings = DEFAULT_PUBLISH_SETTINGS} = {}) {
  const merged = {...(product || {}), ...(facts || {})};
  const style = String(merged.style || '').trim();
  const cleanName = cleanProductTitle(merged.headline || merged.name || merged.rawName || '지오다노 상품');
  const hookText = String(facts?.hookText || '').trim();
  const price = String(facts?.price || (Number.isFinite(product?.consumerPrice) ? `${product.consumerPrice.toLocaleString('ko-KR')}원` : '')).trim();
  const material = String(merged.material || '').trim();
  const gender = String(merged.gender || '').trim();
  const points = (Array.isArray(merged.sellingPoints) ? merged.sellingPoints : [])
    .map(s => String(s || '').trim())
    .filter(Boolean)
    .slice(0, 3);
  const colorCount = Array.isArray(merged.colors) ? merged.colors.filter(Boolean).length : 0;

  const resolvedCat = ['top', 'outer', 'bottom'].includes(garmentCategory)
    ? garmentCategory
    : classifyGarmentCategory(merged);

  const storeName = String(publishSettings?.storeName || DEFAULT_PUBLISH_SETTINGS.storeName).trim() || DEFAULT_PUBLISH_SETTINGS.storeName;
  const savedForStyle = style ? normalizeHttpUrl(publishSettings?.productUrls?.[style] || '') : '';
  const productUrl = normalizeHttpUrl(facts?.productUrl || '') || savedForStyle;
  const baseStoreUrl = normalizeHttpUrl(publishSettings?.storeUrl || '');
  const effectiveUrl = productUrl || baseStoreUrl;
  const storeSearchUrl = buildStoreSearchUrl(baseStoreUrl, style || cleanName);

  const tags = buildCategoryTags(cleanName, material, gender, resolvedCat, style);
  const clipTags = tags.slice(0, 8).join(' ');
  const shortsTags = ['#Shorts', ...tags.slice(0, 7)].join(' ');
  const reelsTags = tags.slice(0, 10).join(' ');

  const factBullets = [];
  if (style) factBullets.push(`• 품번: ${style}`);
  if (price) factBullets.push(`• 소비자가: ${price}`);
  if (material) factBullets.push(`• 소재: ${material}`);
  if (colorCount >= 2) factBullets.push(`• 컬러: 총 ${colorCount}가지`);

  const pointLines = points.map(p => `✔ ${p}`);

  const naverProductId = extractNaverProductId(effectiveUrl);

  // 1) 네이버 클립 (구매 링크 맨 첫 줄 최상단 배치 + 쇼핑 태그 자동 연동)
  const clipTitle = `${hookText || cleanName}${style ? ` (${style})` : ''}`.slice(0, 80);
  const clipBodyParts = [
    effectiveUrl
      ? `🛍 ${storeName} 구매 바로가기\n${effectiveUrl}`
      : `🛍 ${storeName}에서 품번 [${style || cleanName}] 검색`,
    hookText ? `${hookText}` : '',
    `지오다노 ${cleanName}${price ? ` · ${price}` : ''}`,
    pointLines.length ? pointLines.join('\n') : '',
    factBullets.length ? factBullets.join('\n') : '',
    clipTags,
  ].filter(Boolean);

  // 2) 유튜브 쇼츠 (후킹 바로 아래 구매 링크 최상단 배치 + 프로필 링크 안내)
  const shortsBaseTitle = hookText
    ? `${hookText} | 지오다노 ${cleanName}`
    : `지오다노 ${cleanName}${price ? ` (${price})` : ''}`;
  const shortsTitle = `${shortsBaseTitle.slice(0, 84)} #Shorts`;
  const shortsDescParts = [
    hookText || `지오다노 ${cleanName} 실착 룩북`,
    effectiveUrl
      ? `\n🛍 ${storeName} 구매 바로가기\n${effectiveUrl}${style ? `\n※ 링크가 안 눌리면 채널 상단 프로필 링크 → 품번 [${style}] 검색!` : ''}`
      : `\n🛍 채널 상단 프로필 링크 → 품번 [${style || cleanName}] 검색!`,
    `\n[상품 정보 · ${storeName}]`,
    `• 상품명: 지오다노 ${cleanName}`,
    ...factBullets,
    pointLines.length ? '\n[핵심 포인트]\n' + pointLines.join('\n') : '',
    `\n${shortsTags}`,
  ].filter(v => v !== '');

  const shortsPinnedComment = [
    `🛍 ${storeName} 구매 바로가기`,
    effectiveUrl ? `👉 ${effectiveUrl}` : `👉 채널 프로필 링크에서 [${storeName}] 방문 후 품번 검색`,
    `📌 지오다노 ${cleanName}${style ? ` (품번 ${style})` : ''}${price ? ` · 소비자가 ${price}` : ''}`,
  ].join('\n');

  // 3) 인스타 릴스 (첫 줄 훅 바로 아래 구매 안내·링크 최상단 배치 + 해시태그)
  const reelsCaptionParts = [
    hookText || `지오다노 ${cleanName} 실착 핏 확인해 보세요`,
    '',
    style
      ? `🛍 구매 방법: 프로필 링크 → 품번 [${style}] 검색!`
      : `🛍 구매 방법: 프로필 링크에서 [${storeName}] 바로 보기!`,
    effectiveUrl ? `👉 ${effectiveUrl}` : '',
    '',
    `지오다노 ${cleanName}${style ? ` (${style})` : ''}`,
    price ? `소비자가 ${price}${colorCount >= 2 ? ` · ${colorCount}컬러` : ''}` : (colorCount >= 2 ? `총 ${colorCount}가지 컬러 구성` : ''),
    pointLines.length ? '\n' + pointLines.join('\n') : '',
    material ? `소재: ${material}` : '',
    `• 댓글에 "링크" 남겨주시면 스토어 주소 안내해 드려요`,
    '',
    reelsTags,
  ].filter(v => v !== '');

  return {
    storeName,
    effectiveUrl,
    baseStoreUrl,
    storeSearchUrl,
    productId: naverProductId,
    usingProductUrl: Boolean(productUrl),
    clip: {
      platform: '네이버 클립',
      title: clipTitle,
      body: clipBodyParts.join('\n\n'),
      productUrl: effectiveUrl,
      productId: naverProductId,
      style,
      storeName,
      headline: cleanName,
      uploadUrl: 'https://clipcreators.naver.com/web/upload',
      tip: style
        ? `업로드 시 하단 [정보 태그 → 쇼핑]에서 품번 ${style} 상품이 자동 검색·연결되며, 화면 위 클릭 구매 카드로 노출됩니다.`
        : '업로드 시 하단 [정보 태그 → 쇼핑]에서 스마트스토어/백화점윈도 상품을 연결하면 화면 위 클릭 구매 카드가 뜹니다.',
    },
    shorts: {
      platform: '유튜브 쇼츠',
      title: shortsTitle,
      description: shortsDescParts.join('\n'),
      pinnedComment: shortsPinnedComment,
      uploadUrl: 'https://studio.youtube.com/',
      tip: '설명란과 고정 댓글에 스토어 URL을 함께 넣으면 모바일 시청자가 바로 구매 페이지로 이동할 수 있습니다.',
    },
    reels: {
      platform: '인스타 릴스',
      caption: reelsCaptionParts.join('\n'),
      storyLinkUrl: effectiveUrl,
      uploadUrl: 'https://www.instagram.com/',
      metaSuiteUrl: 'https://business.facebook.com/latest/composer',
      tip: '인스타 캡션 URL은 클릭되지 않으므로 프로필 링크에 스토어 주소를 고정해 두고, 스토리 공유 시 링크 스티커로 붙여주세요.',
    },
  };
}
