import fs from 'node:fs';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {classifyGarmentCategory} from './flow-engine.mjs';

export const DEFAULT_PUBLISH_SETTINGS = {
  storeName: '동탄롯데 지오다노',
  storeUrl: '',
  instagramHandle: '',
};

export function normalizeHttpUrl(raw = '') {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    if (!['http:', 'https:'].includes(u.protocol)) return '';
    return u.href;
  } catch {
    return '';
  }
}

export function loadPublishSettingsSync(dataDir) {
  const p = path.join(dataDir, 'publish-settings.json');
  try {
    if (!fs.existsSync(p)) return {...DEFAULT_PUBLISH_SETTINGS};
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      storeName: String(raw.storeName || DEFAULT_PUBLISH_SETTINGS.storeName).trim() || DEFAULT_PUBLISH_SETTINGS.storeName,
      storeUrl: normalizeHttpUrl(raw.storeUrl || ''),
      instagramHandle: String(raw.instagramHandle || '').replace(/^@+/, '').trim(),
    };
  } catch {
    return {...DEFAULT_PUBLISH_SETTINGS};
  }
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
  const tags = ['#지오다노', '#동탄롯데지오다노', '#지오다노추천'];
  if (style) tags.push(`#${style}`);
  const evidence = `${name} ${material}`;
  const genderPrefix = /남성/.test(gender) ? '남자' : /여성/.test(gender) ? '여자' : '';

  if (/기모|브러[시쉬]드|플리스/.test(evidence)) tags.push('#기모');
  if (/맨투맨|스웻/.test(name)) tags.push(genderPrefix ? `#${genderPrefix}맨투맨` : '#맨투맨', '#기모맨투맨');
  else if (/니트|스웨터/.test(name)) tags.push(genderPrefix ? `#${genderPrefix}니트` : '#니트', '#겨울니트');
  else if (/패딩|다운|푸퍼/.test(name)) tags.push('#경량패딩', '#겨울아우터');
  else if (/자켓|코트/.test(name)) tags.push('#아우터추천', '#데일리자켓');
  else if (/트레이닝|조거/.test(name)) tags.push('#트레이닝팬츠', '#편한바지');
  else if (/슬랙스/.test(name)) tags.push('#슬랙스추천', '#출근룩');
  else if (/데님|청바지/.test(name)) tags.push('#데님팬츠', '#청바지추천');
  else if (/팬츠|바지/.test(name)) tags.push('#팬츠추천', '#데일리팬츠');
  else if (/셔츠/.test(name)) tags.push('#셔츠코디', '#데일리셔츠');
  else if (/티셔츠|긴팔/.test(name)) tags.push('#긴팔티', '#이너티');

  if (category === 'bottom') tags.push('#하의추천', '#바지핏');
  else if (category === 'outer') tags.push('#겨울코디', '#오오티디');
  else tags.push('#데일리룩', '#오오티디');

  tags.push('#네이버백화점윈도', '#패션릴스');
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
  const productUrl = normalizeHttpUrl(facts?.productUrl || '');
  const baseStoreUrl = normalizeHttpUrl(publishSettings?.storeUrl || '');
  const effectiveUrl = productUrl || baseStoreUrl;

  const tags = buildCategoryTags(cleanName, material, gender, resolvedCat, style);
  const clipTags = tags.slice(0, 8).join(' ');
  const shortsTags = ['#Shorts', ...tags.slice(0, 7)].join(' ');
  const reelsTags = [...tags.slice(0, 10), '#쇼핑릴스', '#코디추천'].join(' ');

  const factBullets = [];
  if (style) factBullets.push(`• 품번: ${style}`);
  if (price) factBullets.push(`• 소비자가: ${price}`);
  if (material) factBullets.push(`• 소재: ${material}`);
  if (colorCount >= 2) factBullets.push(`• 컬러: 총 ${colorCount}가지`);

  const pointLines = points.map(p => `✔ ${p}`);

  // 1) 네이버 클립 (쇼핑 태그 직결 + 스토어 URL)
  const clipTitle = `${hookText || cleanName}${style ? ` (${style})` : ''}`.slice(0, 80);
  const clipBodyParts = [
    hookText ? `${hookText}` : '',
    `지오다노 ${cleanName}${price ? ` · ${price}` : ''}`,
    pointLines.length ? pointLines.join('\n') : '',
    factBullets.length ? factBullets.join('\n') : '',
    effectiveUrl ? `🛍 ${storeName} 바로가기\n${effectiveUrl}` : `🛍 ${storeName}에서 품번 [${style || cleanName}] 검색`,
    clipTags,
  ].filter(Boolean);

  // 2) 유튜브 쇼츠 (45~90자 제목 + 설명란 + 고정댓글)
  const shortsBaseTitle = hookText
    ? `${hookText} | 지오다노 ${cleanName}`
    : `지오다노 ${cleanName}${price ? ` (${price})` : ''}`;
  const shortsTitle = `${shortsBaseTitle.slice(0, 84)} #Shorts`;
  const shortsDescParts = [
    hookText || `지오다노 ${cleanName} 실착 룩북`,
    '',
    `[상품 정보 · ${storeName}]`,
    `• 상품명: 지오다노 ${cleanName}`,
    ...factBullets,
    pointLines.length ? '\n[핵심 포인트]\n' + pointLines.join('\n') : '',
    effectiveUrl ? `\n▶ 네이버 백화점윈도 구매 링크\n${effectiveUrl}` : '',
    `\n${shortsTags}`,
  ].filter(v => v !== '');

  const shortsPinnedComment = [
    `📌 영상 속 지오다노 ${cleanName}${style ? ` (품번 ${style})` : ''} 바로 보기`,
    effectiveUrl ? `👉 ${effectiveUrl}` : `👉 채널 프로필 링크에서 [${storeName}] 방문 후 품번 검색`,
    price ? `소비자가 ${price} · 정품 백화점 매장 발송` : `${storeName} 정품 스토어`,
  ].join('\n');

  // 3) 인스타 릴스 (첫 줄 훅 + 프로필 링크·품번 검색 유도 + 해시태그)
  const reelsCaptionParts = [
    hookText || `지오다노 ${cleanName} 실착 핏 확인해 보세요`,
    '',
    `지오다노 ${cleanName}${style ? ` (${style})` : ''}`,
    price ? `소비자가 ${price}${colorCount >= 2 ? ` · ${colorCount}컬러` : ''}` : (colorCount >= 2 ? `총 ${colorCount}가지 컬러 구성` : ''),
    pointLines.length ? '\n' + pointLines.join('\n') : '',
    material ? `소재: ${material}` : '',
    '',
    `🛍 구매 방법`,
    style
      ? `• 프로필 링크 접속 → 품번 [${style}] 검색!`
      : `• 프로필 링크에서 [${storeName}] 바로 보기!`,
    `• 댓글에 "링크" 남겨주시면 스토어 주소 안내해 드려요`,
    effectiveUrl ? `• 스토어 주소: ${effectiveUrl}` : '',
    '',
    reelsTags,
  ].filter(v => v !== '');

  return {
    storeName,
    effectiveUrl,
    usingProductUrl: Boolean(productUrl),
    clip: {
      platform: '네이버 클립',
      title: clipTitle,
      body: clipBodyParts.join('\n\n'),
      uploadUrl: 'https://creator.naver.com/',
      tip: style
        ? `업로드 시 하단 [쇼핑 태그]에서 품번 ${style} 상품을 꼭 연결하면 클릭률이 가장 높습니다.`
        : '업로드 시 하단 [쇼핑 태그]에서 스마트스토어/백화점윈도 상품을 꼭 연결해 주세요.',
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
