import fs from 'node:fs';
import {copyFile, mkdir, readdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import * as cheerio from 'cheerio';
import sharp from 'sharp';
import {pathToFileURL} from 'node:url';
import {findRegistrarDataDir, findSellingPointResearchRoot} from './runtime.mjs';

export const OFFICIAL_ORIGIN = 'https://www.giordano.co.kr';

let registrarSellingPointsModule = null;
async function loadRegistrarSellingPointsModule() {
  if (registrarSellingPointsModule !== null) return registrarSellingPointsModule;
  const dataDir = findRegistrarDataDir();
  if (!dataDir) {
    registrarSellingPointsModule = false;
    return false;
  }
  const modPath = path.resolve(dataDir, '..', 'smartstore-selling-points.mjs');
  if (!fs.existsSync(modPath)) {
    registrarSellingPointsModule = false;
    return false;
  }
  try {
    registrarSellingPointsModule = await import(pathToFileURL(modPath).href);
    return registrarSellingPointsModule;
  } catch {
    registrarSellingPointsModule = false;
    return false;
  }
}

export function cleanMarkdownAndNoise(text) {
  return String(text || '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/[`#_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 낯선 영문·외래어 직역 의류 용어를 의미 손상 없이 자연스러운 한국어로 순화한다.
 * (거짓 정보 금지 원칙: 기존에 명시된 소재/기능의 뜻만 그대로 한국어로 바꾼다.)
 */
export function koreanizeApparelCopy(text) {
  return cleanMarkdownAndNoise(text)
    .replace(/^\d{6,8}\s+/, '')
    .replace(/^\[[^\]]{2,18}\]\s*/, '')
    .replace(/^\((?:디테일|소재|핏|디자인|포인트)\)\s*/i, '')
    .replace(/\([A-Za-z0-9\s\-_./,%]+\)/g, '')
    .replace(/\b\d+\s*(?:GSM|g\/㎡|g\/m2)\s*의?\s*/gi, '')
    .replace(/Syncloud[™®]?\s*(?:LOFT|Sorona)?/gi, '친환경 경량')
    .replace(/브러[시쉬]드\s*테리\s*원단|brushed\s*terry/gi, '부드러운 기모 원단')
    .replace(/브러[시쉬]드\s*테리/gi, '부드러운 기모 원단')
    .replace(/프렌치\s*테리\s*원단|프렌치\s*테리|french\s*terry/gi, '탄탄한 면 원단')
    .replace(/브러[시쉬]드|brushed/gi, '기모')
    .replace(/테리\s*원단/gi, '면 쭈리 원단')
    .replace(/PTT\s*충전재/gi, '경량 보온 충전재')
    .replace(/\bPTT\b/g, '경량 보온')
    .replace(/신클라우드\s*소로나/gi, '친환경 경량 충전재')
    .replace(/실키한\s*텍스처와/g, '매끄러운 촉감과')
    .replace(/실키한\s*텍스처/g, '매끄러운 촉감')
    .replace(/코어\s*컬러/g, '기본 컬러')
    .replace(/\b26\s*FW\b|\bFW\b/gi, '가을·겨울')
    .replace(/\b26\s*SS\b|\bSS\b/gi, '봄·여름')
    .replace(/에센셜\s*아이템/g, '필수 기본 아이템')
    .replace(/릴렉스(?:드)?/g, '여유로운')
    .replace(/소프트한/g, '부드러운')
    .replace(/소프트/g, '부드러운')
    .replace(/베이직한/g, '깔끔한 기본')
    .replace(/슬림\s*핏/g, '슬림핏')
    .replace(/레귤러\s*핏|레글러\s*핏/g, '기본 정핏')
    .replace(/루즈\s*핏/g, '여유로운 루즈핏')
    .replace(/오버\s*핏/g, '오버핏')
    .replace(/와이드\s*핏/g, '와이드핏')
    .replace(/조거\s*핏/g, '조거핏')
    .replace(/코튼|COTTON/gi, '면')
    .replace(/폴리에스터|POLYESTER/gi, '폴리에스터')
    .replace(/\s*&\s*/g, ' · ')
    .replace(/(여유로운\s+){2,}/g, '여유로운 ')
    .replace(/,\s*,+/g, ', ')
    .replace(/^[\s,·•\-]+|[\s,·•\-]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * OCR 깨짐(무의미한 영숫자 파편, 깨진 기호) 여부를 검사한다.
 */
function hasOcrCorruption(text) {
  const s = String(text || '');
  if (/\b\d+[a-z]{1,2}\b|\b[a-z]\s+[a-z]\b/i.test(s)) return true;
  if (/[£§¥¢¡¿\uFFFD]/.test(s)) return true;
  if (/^\d{6,8}\b/.test(s)) return true;
  return false;
}

/**
 * 지오다노 공식몰 상세페이지의 "POINT 01 • ..." 섹션 구조를 자연스러운 한국어 장점으로 파싱한다.
 */
export function parseOfficialPointSections(sourceText, maxCount = 4) {
  const raw = cleanMarkdownAndNoise(sourceText);
  if (!raw || !/POINT\s*0?[1-9]/i.test(raw)) return [];

  const parts = raw.split(/(?=POINT\s*0?[1-9]\b)/i).filter(p => /^POINT\s*0?[1-9]\b/i.test(p));
  const results = [];

  for (const part of parts) {
    let body = part
      .replace(/^POINT\s*0?[1-9]\s*[•·:\-]*\s*/i, '')
      .replace(/DETAIL\s*SIZE[\s\S]*$/i, '')
      .trim();
    // 단순 소재 스펙 라벨("(소재) 면 100%" 등)만 있는 경우 건너뜀
    if (/^\(?소재\)?\s*/.test(body) && /\d+%/.test(body) && body.length < 32) continue;

    body = koreanizeApparelCopy(body);
    if (!body || body.length < 10) continue;

    // 앞쪽 중복 소제목 제거 (예: "와이드핏 허벅지부터... 와이드핏 실루엣", "조거핏 ... 조거핏")
    body = body
      .replace(/^(?:와이드핏|조거핏|오버핏|슬림핏)\s+(?=.*(?:와이드핏|조거핏|오버핏|슬림핏))/, '')
      .replace(/^부드러운 기모 원단\s*,?\s*/, '')
      .replace(/\s*,\s*/g, ', ')
      .replace(/\s*\+\s*/g, '와 ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (body.length > 56) {
      const clauses = body.split(/(?<=[.!?다요])\s+|,\s+/).map(s => s.trim()).filter(s => s.length >= 10);
      if (clauses.length) {
        let joined = clauses[0];
        for (let i = 1; i < clauses.length; i++) {
          if ((joined + ', ' + clauses[i]).length <= 56) joined += ', ' + clauses[i];
          else break;
        }
        body = joined;
      }
    }

    if (body.length >= 10 && body.length <= 64 && !body.includes('…') && !results.includes(body)) {
      results.push(body);
    }
    if (results.length >= maxCount) break;
  }
  return results;
}

/**
 * 바탕화면 `지오다노소구점자료` 폴더의 해당 품번 조사 자료(products/<품번>.json, selling-point-review.json)를 읽기 전용으로 조회한다.
 */
function cleanDetailImageBenefitText(imageText) {
  const beforeSize = String(imageText || '').split(/(?:^|\n)\s*(?:COLORS|DETAIL\s*SIZE|CHECK\s*UP|INFORMATION)\b/i)[0] || '';
  return beforeSize
    .split(/\r?\n/)
    .map(l => l.replace(/\s+/g, ' ').trim())
    // OCR 잡음 줄(한글 비중이 너무 낮거나 짧은 깨진 기호 줄) 제거
    .filter(l => {
      if (l.length < 10) return false;
      const hangul = (l.match(/[가-힣]/g) || []).length;
      if (hangul < 6 || hangul / l.length < 0.45) return false;
      if (/STYLE\s*NO|실측|교환|반품|세탁/i.test(l)) return false;
      return true;
    })
    .join(' ');
}

function loadResearchDataForStyle(style) {
  const root = findSellingPointResearchRoot();
  if (!root || !/^\d{6}$/.test(String(style || ''))) return null;
  let pageText = '';
  let imageBenefitText = '';
  const reviewedPoints = [];

  const prodFile = path.join(root, 'products', `${style}.json`);
  if (fs.existsSync(prodFile)) {
    try {
      const p = JSON.parse(fs.readFileSync(prodFile, 'utf8'));
      if (p.pageText) pageText = String(p.pageText);
      if (p.imageText) imageBenefitText = cleanDetailImageBenefitText(p.imageText);
      if (Array.isArray(p.points)) reviewedPoints.push(...p.points);
    } catch {}
  }

  const reviewFile = path.join(root, 'smartstore-details', style, 'selling-point-review.json');
  if (fs.existsSync(reviewFile)) {
    try {
      const r = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
      if (Array.isArray(r.points)) reviewedPoints.push(...r.points);
    } catch {}
  }

  return {pageText, imageBenefitText, reviewedPoints};
}

export function parseStyleOrUrl(input) {
  const trimmed = String(input || '').trim();
  if (!trimmed) throw new Error('품번 6자리 또는 지오다노 공식몰 상품 주소를 입력해 주세요.');
  if (/^\d{6}$/.test(trimmed)) return {style: trimmed, url: null};
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('품번은 숫자 6자리(예: 375908) 또는 지오다노 공식몰 상품 주소로 입력해 주세요.');
  }
  if (!['www.giordano.co.kr', 'giordano.co.kr'].includes(parsed.hostname)) {
    throw new Error('지오다노 공식몰(www.giordano.co.kr) 상품 주소만 불러올 수 있습니다.');
  }
  parsed.hostname = 'www.giordano.co.kr';
  parsed.hash = '';
  return {style: null, url: parsed.href};
}

/**
 * 거짓 정보 절대 금지 + 자연스러운 완결 문장 원칙:
 * - 절대 글자 수로 문장 중간을 잘라 "…"을 붙이지 않는다.
 * - 1순위: 기존 상품등록기의 검증된 소구점 엔진(officialSellingPoints + displaySellingPoints)으로
 *   공식 근거가 확실하고 자연스러운 완결형 한국어 카피를 추출한다.
 * - 2순위(폴백): 공식 설명문에서 완결된 짧은 문장(46자 이내)만 마크다운 기호 없이 그대로 채택한다.
 */
export function extractFactualSellingPoints(officialDescription, maxCount = 3) {
  const cleaned = koreanizeApparelCopy(officialDescription);
  if (!cleaned) return [];

  const sentences = cleaned
    .split(/(?<=[.!?])\s+|[•●\n]+/)
    .map(s => s.replace(/^[*※\-\s]+/, '').trim())
    .filter(s => s.length >= 10 && s.length <= 66)
    .filter(s => /[다요]\.?$/.test(s))
    .filter(s => !/실측사이즈|구매 부탁|참고\s*하|배송|교환|환불|문의|모니터|해상도|컬러 안내|기존 대비|소비자\s*분쟁|품질\s*보증|보상해|AS\s*센터/.test(s));

  const picked = [];
  for (const s of sentences) {
    if (!picked.includes(s)) picked.push(s);
    if (picked.length >= maxCount) break;
  }
  return picked;
}

export async function extractNaturalSellingPoints(officialDescription, maxCount = 4, style = '') {
  const research = loadResearchDataForStyle(style);
  const combinedSource = [officialDescription || '', research?.pageText || '', research?.imageBenefitText || ''].filter(Boolean).join('\n');
  const collected = [];
  const pushUnique = (line) => {
    if (hasOcrCorruption(line)) return;
    const clean = koreanizeApparelCopy(line);
    if (!clean || clean.length < 8 || clean.length > 68 || clean.includes('…') || /\.\.\./.test(clean)) return;
    if (hasOcrCorruption(clean)) return;
    if (/^\(?소재\)?\s*/.test(clean) && /\d+%/.test(clean) && clean.length < 32) return;
    if (/소비자\s*분쟁|품질\s*보증|보상해\s*드립니다|AS\s*센터/.test(clean)) return;
    const norm = clean.replace(/[\s.,!?]+/g, '');
    if (collected.some(x => {
      const xn = x.replace(/[\s.,!?]+/g, '');
      if (xn === norm || xn.includes(norm) || norm.includes(xn)) return true;
      // 같은 핵심 주제(예: 기모 가공 보온, 허리 밴드 스트링, 볼륨 오버핏) 중복 문장 방지
      if (/기모\s*가공/.test(clean) && /기모\s*가공/.test(x)) return true;
      if (/허리\s*밴드/.test(clean) && /허리\s*밴드/.test(x)) return true;
      if (/오버핏/.test(clean) && /볼륨감/.test(clean) && /오버핏/.test(x) && /볼륨감/.test(x)) return true;
      return false;
    })) return;
    collected.push(clean);
  };

  // 1순위: 공식몰 상세페이지 POINT 01 / 02 / 03 구조 직접 추출 (가장 풍부하고 정확)
  for (const pt of parseOfficialPointSections(combinedSource, maxCount + 1)) {
    pushUnique(pt);
    if (collected.length >= maxCount) return collected.slice(0, maxCount);
  }

  // 2순위: 기존 상품등록기 검증 소구점 엔진 (officialSellingPoints + displaySellingPoints)
  const mod = await loadRegistrarSellingPointsModule();
  if (mod && typeof mod.officialSellingPoints === 'function' && combinedSource.trim()) {
    try {
      const rawPoints = mod.officialSellingPoints(cleanMarkdownAndNoise(combinedSource), {limit: maxCount + 2});
      const friendly = typeof mod.displaySellingPoints === 'function'
        ? mod.displaySellingPoints(rawPoints, {tone: true})
        : rawPoints;
      for (const p of friendly) {
        pushUnique(p.description || '');
        if (collected.length >= maxCount) return collected.slice(0, maxCount);
      }
    } catch {}
  }

  // 3순위: 바탕화면 지오다노소구점자료의 사전 검토 소구점(selling-point-review.json)
  if (research?.reviewedPoints?.length) {
    for (const p of research.reviewedPoints) {
      pushUnique(p.description || p.title || '');
      if (collected.length >= maxCount) return collected.slice(0, maxCount);
    }
  }

  // 4순위: 공식 설명문 완결 문장 폴백
  for (const line of extractFactualSellingPoints(combinedSource, maxCount)) {
    pushUnique(line);
    if (collected.length >= maxCount) return collected.slice(0, maxCount);
  }

  return collected.slice(0, maxCount);
}

async function sampleSwatchHex(imagePath) {
  try {
    const {data, info} = await sharp(imagePath)
      .resize(16, 16, {fit: 'cover'})
      .removeAlpha()
      .raw()
      .toBuffer({resolveWithObject: true});
    let r = 0, g = 0, b = 0, count = 0;
    for (let y = 4; y < 12; y++) {
      for (let x = 4; x < 12; x++) {
        const i = (y * info.width + x) * info.channels;
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        count++;
      }
    }
    const hex = (v) => Math.round(v / Math.max(1, count)).toString(16).padStart(2, '0');
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  } catch {
    return '#8e8a84';
  }
}

function guessHexFromColorName(name) {
  const s = String(name || '').toLowerCase();
  if (/블랙|black/.test(s)) return '#1f2023';
  if (/화이트|white/.test(s)) return '#f4f3ef';
  if (/아이보리|ivory|크림|cream|에크루|스톤/.test(s)) return '#ebe5d8';
  if (/베이지|beige|카멜|탄|오트밀|샌드/.test(s)) return '#cbb99e';
  if (/브라운|brown|초코|모카|에스프레소|커피/.test(s)) return '#5b4335';
  if (/네이비|navy|다크블루/.test(s)) return '#233047';
  if (/블루|blue|스카이|데님|인디고/.test(s)) return '#4d6f96';
  if (/그레이|멜란지|차콜|gray|grey/.test(s)) return /차콜|다크/.test(s) ? '#44464a' : '#a7a9ad';
  if (/카키|올리브|그린|세이지|민트/.test(s)) return '#5b6853';
  if (/레드|버건디|와인|체리|라즈베리/.test(s)) return '#8a2d36';
  if (/핑크|로즈|살몬|코랄/.test(s)) return '#d59ea5';
  if (/옐로우|머스타드|레몬/.test(s)) return '#d4b25c';
  if (/퍼플|라벤더|바이올렛/.test(s)) return '#7c6b8e';
  return '#8c867e';
}

function fileHash(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * 모델 착용 컷의 중앙 의류 영역(배경 제외) 대표 색상을 추출한다.
 * - 가장자리 스튜디오 배경과 비슷한 픽셀은 제외하고, 옷 본체 픽셀들의 평균 RGB를 계산한다.
 */
export async function extractGarmentColorProfile(imagePath) {
  try {
    const {data, info} = await sharp(imagePath)
      .rotate()
      .resize(48, 64, {fit: 'cover'})
      .removeAlpha()
      .raw()
      .toBuffer({resolveWithObject: true});
    const {width, height, channels} = info;

    // 4개 모서리 평균으로 스튜디오 배경색 추정
    let bgR = 0, bgG = 0, bgB = 0, bgN = 0;
    for (const [x, y] of [[1, 1], [width - 2, 1], [1, height - 2], [width - 2, height - 2]]) {
      const i = (y * width + x) * channels;
      bgR += data[i]; bgG += data[i + 1]; bgB += data[i + 2]; bgN++;
    }
    bgR /= bgN; bgG /= bgN; bgB /= bgN;

    // 중앙 의류 영역 (가로 25%~75%, 세로 26%~74%)
    let sumR = 0, sumG = 0, sumB = 0, count = 0;
    let fallbackR = 0, fallbackG = 0, fallbackB = 0, fallbackN = 0;
    for (let y = Math.floor(height * 0.26); y < Math.floor(height * 0.74); y++) {
      for (let x = Math.floor(width * 0.25); x < Math.floor(width * 0.75); x++) {
        const i = (y * width + x) * channels;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        fallbackR += r; fallbackG += g; fallbackB += b; fallbackN++;
        const bgDist = Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB);
        if (bgDist > 38) {
          sumR += r; sumG += g; sumB += b; count++;
        }
      }
    }
    const r = count >= 20 ? sumR / count : fallbackR / Math.max(1, fallbackN);
    const g = count >= 20 ? sumG / count : fallbackG / Math.max(1, fallbackN);
    const b = count >= 20 ? sumB / count : fallbackB / Math.max(1, fallbackN);
    const hex = '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
    return {r, g, b, hex};
  } catch {
    return {r: 128, g: 128, b: 128, hex: '#808080'};
  }
}

function colorDistance(a, b) {
  if (!a || !b) return 0;
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  // 인간 시각 가중 색차 (Redmean 근사)
  const rMean = (a.r + b.r) / 2;
  return Math.sqrt(((2 + rMean / 256) * dr * dr) + (4 * dg * dg) + ((2 + (255 - rMean) / 256) * db * db));
}

/**
 * 후보 모델 착용 컷들 중 서로 다른 컬러 3장을 우선 선별하고,
 * 다른 컬러가 부족하면 남은 같은 컬러 컷으로 채워 최소 targetCount장을 맞춘다.
 * 선별된 3장은 최상단(enabled: true), 나머지 추가 컷은 뒤에(enabled: false) 배치한다.
 */
export function selectDiverseModelShots(candidates, targetCount = 3, distinctThreshold = 58) {
  if (!candidates.length) return [];
  const remaining = [...candidates];
  const picked = [];

  // 1번 컷: 공식몰 대표 모델 컷 우선
  const first = remaining.shift();
  picked.push({...first, colorRole: '대표 컬러'});

  // 2~N번 컷: 이미 선택된 컷들과 색차가 가장 큰(서로 다른 컬러) 컷 우선 선별
  while (picked.length < targetCount && remaining.length) {
    let bestIdx = -1;
    let bestScore = -1;
    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i];
      const minDist = Math.min(...picked.map(p => colorDistance(p.colorProfile, cand.colorProfile)));
      // 명시적 컬러 라벨이 다르면 가산점
      const labelBonus = cand.colorTag && picked.every(p => p.colorTag !== cand.colorTag) ? 120 : 0;
      const score = minDist + labelBonus;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break;
    const chosen = remaining.splice(bestIdx, 1)[0];
    const isDistinct = bestScore >= distinctThreshold;
    picked.push({...chosen, colorRole: isDistinct ? '다른 컬러' : '동일 계열 보충'});
  }

  // 선별된 서로 다른 컬러 3장만 깔끔하게 반환 (불필요한 미사용 컷 제외)
  return picked.map((item, i) => ({...item, enabled: true, pickRank: i + 1}));
}

/**
 * 모델 착용 컷 적합성 필터:
 * - 아이콘, 썸네일, 너무 납작한 배너, 지나치게 긴 상세 통이미지(높이/너비 > 2.6) 제외
 */
function isGoodModelShotMeta(meta) {
  const w = Number(meta?.width || 0);
  const h = Number(meta?.height || 0);
  if (w < 320 || h < 320) return false;
  const ratio = h / w;
  if (ratio > 2.6 || ratio < 0.55) return false;
  return true;
}

async function findLatestRegistrarFolder(style) {
  const dataDir = findRegistrarDataDir();
  if (!dataDir) return null;
  const entries = await readdir(dataDir, {withFileTypes: true});
  const matched = entries
    .filter(e => e.isDirectory() && e.name.startsWith(`${style}-`))
    .map(e => ({name: e.name, fullPath: path.join(dataDir, e.name)}))
    .filter(item => fs.existsSync(path.join(item.fullPath, 'product.json')))
    .sort((a, b) => b.name.localeCompare(a.name));
  return matched[0]?.fullPath || null;
}

async function fetchOfficialHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept-Language': 'ko-KR,ko;q=0.9',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`지오다노 공식몰 응답 오류 (${res.status})`);
  return res.text();
}

function isAllowedOfficialImageHost(hostname = '') {
  const h = String(hostname || '').toLowerCase();
  return h === 'www.giordano.co.kr'
    || h === 'giordano.co.kr'
    || h.endsWith('.giordano.co.kr')
    || h.includes('giordano') && h.endsWith('.wisacdn.com')
    || h.endsWith('.wisacdn.com');
}

async function downloadOfficialImage(url, destPath) {
  const parsed = new URL(url);
  if (!isAllowedOfficialImageHost(parsed.hostname)) {
    throw new Error('지오다노 공식몰·공식 CDN 이외 이미지 주소는 차단됩니다.');
  }
  const res = await fetch(parsed.href, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Referer': 'https://www.giordano.co.kr/',
    },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`이미지 다운로드 실패 (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(destPath, buf);
  return sharp(destPath).metadata().catch(() => ({}));
}

/**
 * 공식몰 HTML에서 모델 착용 컷 URL 후보를 폭넓게 추출한다 (고시·사이즈표·아이콘 제외).
 */
function extractOfficialModelImageUrls(html, detailUrl, style = '') {
  const $ = cheerio.load(html);
  const seen = new Set();
  const candidates = [];

  const pushUrl = (rawSrc, priority = 2) => {
    if (!rawSrc) return;
    let full;
    try {
      full = new URL(rawSrc, detailUrl);
    } catch {
      return;
    }
    if (!isAllowedOfficialImageHost(full.hostname)) return;
    const href = full.href.split('#')[0];
    if (seen.has(href)) return;
    const lower = full.pathname.toLowerCase();
    // 비착용/시스템 이미지 제외
    if (/\.(gif|svg)$/i.test(lower)) return;
    if (/info\.|size_?\.|ch\.|icon|logo|banner|btn|bullet|notice|wash|colorchip|review|kakao|naver|instagram/i.test(lower)) return;
    if (style && new RegExp(`${style}(?:_?info|size_?|ch)\\.`, 'i').test(lower)) return;
    if (!/\/_data\/(?:attach|product)\/|\/_gio_on\/|\/product\/|\/upfile\//i.test(lower)) return;
    seen.add(href);
    candidates.push({url: href, priority});
  };

  // 1순위: 공식 상품 갤러리·컬러 툴팁·슬라이드 착용 이미지
  $('.product_image_tooltip_image_gio[data-image_no], .prdimg img, .detail_img img, #mainImg img, .swiper-slide img, .addimg img, .thumb img').each((_, el) => {
    pushUrl($(el).attr('src'), 1);
    pushUrl($(el).attr('data-src'), 1);
    pushUrl($(el).attr('data-original'), 1);
  });

  // 2순위: 전체 공식 상품 이미지
  $('img').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-original') || '';
    if (/\/_data\/(?:attach|product)\/|\/_gio_on\/|\/product\//i.test(src)) pushUrl(src, 2);
  });

  candidates.sort((a, b) => a.priority - b.priority);
  return candidates.map(c => c.url);
}

/**
 * 기존 상품등록기 data/ 에서 읽기 전용으로 상품 정보와 공식홈 모델 착용 컷 3장을 복사한다.
 * (매장 마네킨 사진인 smartstore-photo-* 는 공식몰 모델 컷과 엄격히 분리하여 마네킨 전용 슬롯에서만 사용한다.)
 */
async function loadFromRegistrar(style, destSourcesDir) {
  const folder = await findLatestRegistrarFolder(style);
  if (!folder) return null;

  const raw = JSON.parse(await readFile(path.join(folder, 'product.json'), 'utf8'));
  await mkdir(destSourcesDir, {recursive: true});

  const allFiles = await readdir(folder).catch(() => []);
  const candidateFiles = [];

  // 1순위: 지오다노 공식몰 실제 모델 착용 컷 (main, extra1, extra2)
  for (const [src, label] of [
    ['main.jpg', '공식몰 모델 대표 컷'],
    ['extra1.jpg', '공식몰 모델 착용 컷 2'],
    ['extra2.jpg', '공식몰 모델 착용 컷 3'],
  ]) {
    if (allFiles.includes(src)) candidateFiles.push({src, label});
  }

  // 2순위: 공식몰 컬러별 착용 컷 (color-*.jpg) — smartstore-photo-* 매장 마네킨은 제외!
  const colorFiles = allFiles.filter(f => /^color-\d+\.(?:jpe?g|png|webp)$/i.test(f)).sort();
  colorFiles.forEach((src, i) => candidateFiles.push({src, label: `공식몰 컬러 착용 컷 ${i + 1}`}));

  const seenHashes = new Set();
  const rawCandidates = [];

  for (const item of candidateFiles) {
    if (rawCandidates.length >= 20) break;
    const srcPath = path.join(folder, item.src);
    if (!fs.existsSync(srcPath)) continue;

    const meta = await sharp(srcPath).metadata().catch(() => null);
    if (!isGoodModelShotMeta(meta)) continue;

    const hash = fileHash(srcPath);
    if (seenHashes.has(hash)) continue;
    seenHashes.add(hash);

    const colorProfile = await extractGarmentColorProfile(srcPath);
    const colorTagMatch = item.src.match(/^color-(\d+)/i);
    rawCandidates.push({
      srcPath,
      ext: path.extname(item.src) || '.jpg',
      width: meta.width || 0,
      height: meta.height || 0,
      colorProfile,
      colorTag: colorTagMatch ? colorTagMatch[1] : null,
    });
  }

  // 등록기 폴더에 모델 컷이 3장 미만이면 공식몰 페이지에서 추가 모델 컷 자동 보충 시도
  if (rawCandidates.length < 3 && raw.sourceUrl) {
    try {
      const html = await fetchOfficialHtml(raw.sourceUrl);
      const extraUrls = extractOfficialModelImageUrls(html, raw.sourceUrl, raw.style || style);
      for (const imgUrl of extraUrls) {
        if (rawCandidates.length >= 12) break;
        const ext = path.extname(new URL(imgUrl).pathname) || '.jpg';
        const tempPath = path.join(destSourcesDir, `tmp-web-${rawCandidates.length + 1}${ext}`);
        try {
          const meta = await downloadOfficialImage(imgUrl, tempPath);
          if (!isGoodModelShotMeta(meta)) {
            fs.unlinkSync(tempPath);
            continue;
          }
          const hash = fileHash(tempPath);
          if (seenHashes.has(hash)) {
            fs.unlinkSync(tempPath);
            continue;
          }
          seenHashes.add(hash);
          const colorProfile = await extractGarmentColorProfile(tempPath);
          rawCandidates.push({
            srcPath: tempPath,
            isTemp: true,
            ext,
            width: meta.width || 0,
            height: meta.height || 0,
            colorProfile,
            colorTag: null,
          });
        } catch {}
      }
    } catch {}
  }

  // 서로 다른 컬러 3장 우선 자동 선별 (없으면 같은 컬러로 3장 보충)
  const ranked = selectDiverseModelShots(rawCandidates, 3).slice(0, 10);
  const copiedImages = [];
  for (let i = 0; i < ranked.length; i++) {
    const item = ranked[i];
    const idx = i + 1;
    const destName = `official-model-${String(idx).padStart(2, '0')}${item.ext}`;
    const destPath = path.join(destSourcesDir, destName);
    if (item.isTemp) {
      fs.renameSync(item.srcPath, destPath);
    } else {
      await copyFile(item.srcPath, destPath);
    }
    copiedImages.push({
      id: `official-model-${idx}`,
      kind: 'official',
      mediaType: 'image',
      label: `공식몰 모델 컷 ${idx} (${item.colorRole})`,
      colorRole: item.colorRole,
      garmentHex: item.colorProfile?.hex || '',
      filename: destName,
      filePath: destPath,
      width: item.width,
      height: item.height,
      enabled: item.enabled,
      durationSec: 2.8,
      trimStart: 0,
      trimEnd: null,
    });
  }
  // 미선택 임시 파일 정리
  for (const item of rawCandidates) {
    if (item.isTemp && fs.existsSync(item.srcPath)) {
      try { fs.unlinkSync(item.srcPath); } catch {}
    }
  }

  // 컬러칩 정보 읽기
  const colorNames = Array.isArray(raw.colors) ? raw.colors.filter(Boolean) : [];
  const colorSwatches = [];
  for (let i = 0; i < colorNames.length; i++) {
    const chipFile = path.join(folder, `colorchip-${i}.jpg`);
    const hex = fs.existsSync(chipFile) ? await sampleSwatchHex(chipFile) : guessHexFromColorName(colorNames[i]);
    colorSwatches.push({
      name: String(colorNames[i]).replace(/^\d{2}/, '').trim() || String(colorNames[i]),
      rawName: String(colorNames[i]),
      hex,
    });
  }

  const product = {
    source: 'registrar',
    sourceLabel: '기존 상품등록기 검증 데이터 (읽기 전용 연동)',
    style: raw.style || style,
    rawName: raw.rawName || '',
    name: raw.rawName || raw.name || '',
    gender: raw.gender || '',
    material: raw.material || '',
    consumerPrice: Number.isFinite(raw.consumerPrice) ? raw.consumerPrice : null,
    colors: colorSwatches,
    sizes: Array.isArray(raw.sizes) ? raw.sizes : [],
    officialDescription: raw.officialDescription || '',
    sellingPoints: await extractNaturalSellingPoints(raw.officialDescription, 4, raw.style || style),
    sourceUrl: raw.sourceUrl || '',
  };

  return {product, assets: copiedImages};
}

async function loadFromOfficialWebsite(parsedInput, destSourcesDir) {
  let detailUrl = parsedInput.url;
  let style = parsedInput.style;

  if (!detailUrl) {
    const searchUrl = `${OFFICIAL_ORIGIN}/shop/search_result.php?search_str=${encodeURIComponent(style)}`;
    const searchHtml = await fetchOfficialHtml(searchUrl);
    const $s = cheerio.load(searchHtml);
    const links = [...new Set(
      $s('a[href*="detail.php?pno="]')
        .map((_, el) => {
          try { return new URL($s(el).attr('href'), searchUrl).href; } catch { return null; }
        })
        .get()
        .filter(Boolean)
    )];
    if (!links.length) {
      throw new Error(`지오다노 공식몰에서 품번 ${style} 상품을 찾지 못했습니다. 공식몰 상품 URL을 직접 입력해 보세요.`);
    }
    for (const candidate of links.slice(0, 8)) {
      const html = await fetchOfficialHtml(candidate).catch(() => null);
      if (!html) continue;
      if (html.includes(style) && !/주니어|키즈|JUNIOR|KIDS/i.test(cheerio.load(html)('title').text())) {
        detailUrl = candidate;
        break;
      }
    }
    if (!detailUrl) detailUrl = links[0];
  }

  const html = await fetchOfficialHtml(detailUrl);
  const $ = cheerio.load(html);
  const rawName = $('title').text().split(' - ')[0].trim() || $('h3').first().text().trim();
  const bodyText = $('body').text();
  if (!style) {
    style = bodyText.match(/STYLE\s*[.:]\s*(?:\d{2})?(\d{6})(?!\d)/i)?.[1] || '';
  }

  const officialDescription = $('.prd_detail_content_gio').first().text().replace(/\s+/g, ' ').trim().slice(0, 4000);
  const priceText = $('.info[data-normal_prc]').first().attr('data-normal_prc') || '';
  const consumerPrice = /^\d+$/.test(priceText.replace(/,/g, '')) ? Number(priceText.replace(/,/g, '')) : null;

  const imgEls = $('img[src]').map((_, el) => ({
    alt: ($(el).attr('alt') || '').trim(),
  })).get();

  const colorsRaw = [...new Set(imgEls.map(x => x.alt).filter(a => /^\d{2}\s*\S+/.test(a)))].sort();
  const colorSwatches = colorsRaw.map(c => ({
    name: c.replace(/^\d{2}\s*/, '').trim() || c,
    rawName: c,
    hex: guessHexFromColorName(c),
  }));

  await mkdir(destSourcesDir, {recursive: true});
  const candidateUrls = extractOfficialModelImageUrls(html, detailUrl, style);
  const seenHashes = new Set();
  const webCandidates = [];

  for (const imgUrl of candidateUrls) {
    if (webCandidates.length >= 14) break;
    const ext = path.extname(new URL(imgUrl).pathname) || '.jpg';
    const tempPath = path.join(destSourcesDir, `tmp-official-${webCandidates.length + 1}${ext}`);
    try {
      const meta = await downloadOfficialImage(imgUrl, tempPath);
      if (!isGoodModelShotMeta(meta)) {
        fs.unlinkSync(tempPath);
        continue;
      }
      const hash = fileHash(tempPath);
      if (seenHashes.has(hash)) {
        fs.unlinkSync(tempPath);
        continue;
      }
      seenHashes.add(hash);
      const colorProfile = await extractGarmentColorProfile(tempPath);
      webCandidates.push({
        srcPath: tempPath,
        ext,
        width: meta.width || 0,
        height: meta.height || 0,
        colorProfile,
        colorTag: null,
      });
    } catch {}
  }

  const rankedWeb = selectDiverseModelShots(webCandidates, 3).slice(0, 10);
  const assets = [];
  for (let i = 0; i < rankedWeb.length; i++) {
    const item = rankedWeb[i];
    const idx = i + 1;
    const destName = `official-model-${String(idx).padStart(2, '0')}${item.ext}`;
    const destPath = path.join(destSourcesDir, destName);
    fs.renameSync(item.srcPath, destPath);
    assets.push({
      id: `official-model-${idx}`,
      kind: 'official',
      mediaType: 'image',
      label: `공식몰 모델 컷 ${idx} (${item.colorRole})`,
      colorRole: item.colorRole,
      garmentHex: item.colorProfile?.hex || '',
      filename: destName,
      filePath: destPath,
      width: item.width,
      height: item.height,
      enabled: item.enabled,
      durationSec: 2.8,
      trimStart: 0,
      trimEnd: null,
    });
  }
  for (const item of webCandidates) {
    if (fs.existsSync(item.srcPath)) {
      try { fs.unlinkSync(item.srcPath); } catch {}
    }
  }

  if (!assets.length) {
    throw new Error('공식몰 모델 착용 이미지를 가져오지 못했습니다. 품번이나 상품 주소를 확인해 주세요.');
  }

  const product = {
    source: 'official-web',
    sourceLabel: '지오다노 공식 홈페이지 실시간 수집',
    style: style || '',
    rawName,
    name: rawName,
    gender: '',
    material: '',
    consumerPrice,
    colors: colorSwatches,
    sizes: [],
    officialDescription,
    sellingPoints: await extractNaturalSellingPoints(officialDescription, 4, style || ''),
    sourceUrl: detailUrl,
  };

  return {product, assets};
}

export async function loadProductByInput(input, destSourcesDir) {
  const parsed = parseStyleOrUrl(input);
  if (parsed.style) {
    const fromRegistrar = await loadFromRegistrar(parsed.style, destSourcesDir);
    if (fromRegistrar) return fromRegistrar;
  }
  return loadFromOfficialWebsite(parsed, destSourcesDir);
}
