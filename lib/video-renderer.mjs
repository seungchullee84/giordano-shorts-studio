import fs from 'node:fs';
import {mkdir, rm} from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {chromium} from 'playwright';
import sharp from 'sharp';
import {findFFmpegTools, findSystemChrome} from './runtime.mjs';
import {analyzeBackdropCleanliness, classifyGarmentCategory} from './flow-engine.mjs';
import {generateBuiltinBgmWav} from './bgm-synth.mjs';

const execFileAsync = promisify(execFile);

const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 30;

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeFilenamePart(text, fallback = 'giordano') {
  const cleaned = String(text || '')
    .replace(/[\\/:*?"<>|\r\n]+/g, ' ')
    .replace(/\s+/g, '_')
    .trim()
    .slice(0, 36);
  return cleaned || fallback;
}

export async function probeMedia(filePath) {
  const {ffprobe, available} = findFFmpegTools();
  if (!available) throw new Error('FFmpeg/FFprobe가 설치되어 있지 않습니다.');
  const {stdout} = await execFileAsync(ffprobe, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ], {timeout: 20000});
  const parsed = JSON.parse(stdout);
  const videoStream = (parsed.streams || []).find(s => s.codec_type === 'video');
  const audioStream = (parsed.streams || []).find(s => s.codec_type === 'audio');
  const duration = Number(parsed.format?.duration || videoStream?.duration || 0);
  return {
    duration: Number.isFinite(duration) ? Number(duration.toFixed(2)) : 0,
    width: Number(videoStream?.width || 0),
    height: Number(videoStream?.height || 0),
    hasAudio: Boolean(audioStream),
  };
}

/**
 * 15~20초 자동 시나리오 구성:
 * - 사용자가 순서를 직접 변경하지 않은 경우, 움직임이 있는 Flow 영상/사용자 동영상을 먼저 배치하고
 *   매장 마네킨 샷과 공식몰 컷을 리듬감 있게 교차 배치한다.
 */
export function normalizeVideoSpeed(raw) {
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) return 1.3;
  return Number(Math.max(0.75, Math.min(1.75, num)).toFixed(2));
}

export function buildAutoClipPlan(assets = [], options = {}) {
  const active = assets.filter(a => a && a.enabled !== false && a.filePath && fs.existsSync(a.filePath));
  if (!active.length) throw new Error('영상에 넣을 사진 또는 동영상을 1개 이상 추가해 주세요.');

  const preserveOrder = Boolean(options.preserveOrder);
  let ordered = [...active];

  if (!preserveOrder) {
    const flowVideos = active.filter(a => a.kind === 'flow');
    const userVideos = active.filter(a => a.mediaType === 'video' && a.kind !== 'flow');
    const mannequins = active.filter(a => a.kind === 'mannequin' && a.mediaType === 'image');
    const officials = active.filter(a => a.kind === 'official' && a.mediaType === 'image');
    const others = active.filter(a => !flowVideos.includes(a) && !userVideos.includes(a) && !mannequins.includes(a) && !officials.includes(a));

    ordered = [...flowVideos, ...userVideos];
    const maxLen = Math.max(mannequins.length, officials.length);
    for (let i = 0; i < maxLen; i++) {
      if (officials[i]) ordered.push(officials[i]);
      if (mannequins[i]) ordered.push(mannequins[i]);
    }
    ordered.push(...others);
  }

  const includeEnding = options.includeEnding !== false;
  const endingSec = includeEnding ? 2.4 : 0;
  const targetTotal = Math.max(10, Math.min(20, Number(options.targetDurationSec) || 17.5));

  const videoSpeed = normalizeVideoSpeed(options.videoSpeed);

  // 영상 클립의 배속 적용 후 실제 재생 시간 먼저 합산
  let videoSum = 0;
  const imageClips = [];
  const plan = ordered.map((asset, index) => {
    if (asset.mediaType === 'video') {
      const start = Math.max(0, Number(asset.trimStart) || 0);
      const rawEnd = asset.trimEnd != null && asset.trimEnd !== '' ? Number(asset.trimEnd) : null;
      const sourceDur = Number(asset.sourceDurationSec || asset.durationSec || 6);
      const end = rawEnd && rawEnd > start ? Math.min(rawEnd, sourceDur || rawEnd) : sourceDur;
      const sourceSpan = Math.max(1.0, Math.min(20, Number((end - start).toFixed(2)) || 6));
      const clipDur = Math.max(1.2, Math.min(15, Number((sourceSpan / videoSpeed).toFixed(2)) || 5));
      videoSum += clipDur;
      return {asset, index, start, sourceDuration: sourceSpan, speed: videoSpeed, duration: clipDur};
    }
    const item = {asset, index, start: 0, duration: Number(asset.durationSec) || 0};
    imageClips.push(item);
    return item;
  });

  if (imageClips.length) {
    const remaining = Math.max(imageClips.length * 1.8, targetTotal - endingSec - videoSum);
    const autoPerImage = Math.max(1.8, Math.min(4.2, Number((remaining / imageClips.length).toFixed(2))));
    for (const item of imageClips) {
      if (!options.preserveDurations || !item.duration) {
        item.duration = autoPerImage;
      } else {
        item.duration = Math.max(1.2, Math.min(6, item.duration));
      }
    }
  }

  const totalSec = Number((plan.reduce((acc, c) => acc + c.duration, 0) + endingSec).toFixed(2));
  return {clips: plan, includeEnding, endingSec, totalSec};
}

/**
 * 이미지 1장을 1080x1920 무손상 캔버스로 준비한다.
 * - 공식몰 누끼(useCutout=true): 원본 RGB를 유지한 채 에디토리얼 스튜디오 배경 위에 입체 배치
 * - 마네킨 샷 / 일반 사진: 배경 제거 없이 원본 그대로 중앙 배치 + 여백만 은은한 블러로 채움
 */
async function prepareImageCanvas(asset, outPath, studioTone = '#efeae2') {
  const useCutout = asset.kind === 'official' && asset.useCutout && asset.cutoutPath && fs.existsSync(asset.cutoutPath);
  const srcPath = useCutout ? asset.cutoutPath : asset.filePath;

  if (useCutout) {
    const fg = await sharp(srcPath)
      .rotate()
      .resize({width: 960, height: 1520, fit: 'inside'})
      .png()
      .toBuffer();

    const bgSvg = Buffer.from(`
      <svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <radialGradient id="studio" cx="50%" cy="40%" r="70%">
            <stop offset="0%" stop-color="#fbf9f6"/>
            <stop offset="65%" stop-color="${studioTone}"/>
            <stop offset="100%" stop-color="#ddd5c8"/>
          </radialGradient>
        </defs>
        <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#studio)"/>
        <ellipse cx="540" cy="1585" rx="280" ry="34" fill="#000000" fill-opacity="0.09"/>
      </svg>
    `);

    await sharp(bgSvg)
      .composite([{input: fg, gravity: 'center'}])
      .jpeg({quality: 94})
      .toFile(outPath);
    return outPath;
  }

  // 원본 그대로 유지 (과도한 색보정 금지)
  const meta = await sharp(srcPath).rotate().metadata();
  const aspect = (meta.width || 1) / (meta.height || 1);
  // 이미 9:16에 매우 가까우면 여백 없이 깔끔하게 맞춤
  if (aspect >= 0.5 && aspect <= 0.62) {
    await sharp(srcPath)
      .rotate()
      .resize(WIDTH, HEIGHT, {fit: 'cover', position: 'center'})
      .jpeg({quality: 94})
      .toFile(outPath);
    return outPath;
  }

  const bgInfo = await analyzeBackdropCleanliness(srcPath);
  if (bgInfo.isCleanStudio) {
    const resized = await sharp(srcPath)
      .rotate()
      .resize({width: WIDTH, height: HEIGHT, fit: 'inside', withoutEnlargement: false})
      .toBuffer({resolveWithObject: true});
    const padTotal = Math.max(0, HEIGHT - resized.info.height);
    const padTop = Math.floor(padTotal / 2);
    const padBottom = padTotal - padTop;
    const padHoriz = Math.max(0, WIDTH - resized.info.width);
    const padLeft = Math.floor(padHoriz / 2);
    const padRight = padHoriz - padLeft;

    await sharp(resized.data)
      .extend({
        top: padTop,
        bottom: padBottom,
        left: padLeft,
        right: padRight,
        extendWith: 'copy',
      })
      .jpeg({quality: 94})
      .toFile(outPath);
    return outPath;
  }

  const blurredBg = await sharp(srcPath)
    .rotate()
    .resize(WIDTH, HEIGHT, {fit: 'cover', position: 'center'})
    .blur(40)
    .modulate({brightness: 0.85})
    .toBuffer();

  const fg = await sharp(srcPath)
    .rotate()
    .resize({width: WIDTH, height: HEIGHT, fit: 'inside'})
    .toBuffer();

  await sharp(blurredBg)
    .composite([{input: fg, gravity: 'center'}])
    .jpeg({quality: 94})
    .toFile(outPath);
  return outPath;
}

function hexToRgb(hex) {
  const m = String(hex || '').match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return null;
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

/**
 * 수집된 사진 중 서로 색감이 다른 최대 3장을 골라 1080x1920 세로 3열(또는 2열)
 * 매거진 [멀티 컬러 한눈에 보기] 스플릿 콜라주 캔버스를 무손상으로 생성한다.
 */
async function createMultiColorSplitCanvas(imageAssets, outPath) {
  const valid = (imageAssets || []).filter(a => a?.filePath && fs.existsSync(a.filePath));
  if (valid.length < 2) return null;

  // 서로 다른 컬러(garmentHex 거리 최대) 우선 3장 선택
  const picked = [valid[0]];
  const rest = valid.slice(1);
  while (picked.length < 3 && rest.length) {
    let bestIdx = 0;
    let bestScore = -1;
    for (let i = 0; i < rest.length; i++) {
      const rgbA = hexToRgb(rest[i].garmentHex);
      let score = rest[i].kind !== picked[picked.length - 1].kind ? 25 : 0;
      if (rgbA) {
        const dists = picked.map(p => {
          const rgbB = hexToRgb(p.garmentHex);
          return rgbB ? Math.hypot(rgbA[0] - rgbB[0], rgbA[1] - rgbB[1], rgbA[2] - rgbB[2]) : 60;
        });
        score += Math.min(...dists);
      } else {
        score += 40;
      }
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    picked.push(rest.splice(bestIdx, 1)[0]);
  }

  const count = picked.length;
  const gap = 8;
  const composites = [];

  if (count === 2) {
    // 2장: 상·하 2단 와이드 매거진 그리드 (옷이 절대 잘리지 않는 정중앙 포커스)
    const h1 = Math.floor((HEIGHT - gap) / 2);
    const h2 = HEIGHT - gap - h1;
    const topBuf = await sharp(picked[0].filePath).rotate().resize(WIDTH, h1, {fit: 'cover', position: 'center'}).jpeg({quality: 94}).toBuffer();
    const botBuf = await sharp(picked[1].filePath).rotate().resize(WIDTH, h2, {fit: 'cover', position: 'center'}).jpeg({quality: 94}).toBuffer();
    composites.push({input: topBuf, left: 0, top: 0});
    composites.push({input: botBuf, left: 0, top: h1 + gap});
  } else {
    // 3장: 상단 큰 1장 + 하단 좌우 2장 (1+2 하이엔드 패션 매거진 그리드 · 중앙 인물/의류 고정)
    const topH = 920;
    const botH = HEIGHT - topH - gap;
    const leftW = Math.floor((WIDTH - gap) / 2);
    const rightW = WIDTH - gap - leftW;

    const topBuf = await sharp(picked[0].filePath).rotate().resize(WIDTH, topH, {fit: 'cover', position: 'center'}).jpeg({quality: 94}).toBuffer();
    const blBuf = await sharp(picked[1].filePath).rotate().resize(leftW, botH, {fit: 'cover', position: 'center'}).jpeg({quality: 94}).toBuffer();
    const brBuf = await sharp(picked[2].filePath).rotate().resize(rightW, botH, {fit: 'cover', position: 'center'}).jpeg({quality: 94}).toBuffer();

    composites.push({input: topBuf, left: 0, top: 0});
    composites.push({input: blBuf, left: 0, top: topH + gap});
    composites.push({input: brBuf, left: leftW + gap, top: topH + gap});
  }

  await sharp({
    create: {
      width: WIDTH,
      height: HEIGHT,
      channels: 3,
      background: {r: 245, g: 241, b: 235},
    },
  })
    .composite(composites)
    .jpeg({quality: 95})
    .toFile(outPath);

  return {path: outPath, count};
}

/**
 * 컷 순서와 의류 구분(상의/아우터 vs 하의)에 맞춰 부드러운 짐벌 가감속(Ease-in-out)
 * 카메라 무빙 6종을 자동 순환 생성한다.
 */
function buildGimbalZoompanExpr(clipIndex, frames, garmentCategory = 'top') {
  const N = Math.max(30, frames);
  const p = `(0.5-0.5*cos(PI*on/${N}))`;
  const mode = clipIndex % 6;

  if (mode === 0) {
    // 1. 시네마 슬로우 푸시인 (중앙 몰입)
    return {
      z: `1+0.08*${p}`,
      x: `iw/2-(iw/zoom/2)`,
      y: `ih/2-(ih/zoom/2)`,
    };
  }
  if (mode === 1) {
    // 2. 좌→우 부드러운 수평 짐벌 패닝
    return {
      z: `1.07`,
      x: `(iw-iw/zoom)*(0.18+0.64*${p})`,
      y: `ih/2-(ih/zoom/2)`,
    };
  }
  if (mode === 2) {
    // 3. 의류 맞춤 수직 틸트 (하의: 허리→밑단 틸트다운 / 상의·아우터: 밑단→카라 틸트업)
    const yExpr = garmentCategory === 'bottom'
      ? `(ih-ih/zoom)*(0.22+0.56*${p})`
      : `(ih-ih/zoom)*(0.74-0.54*${p})`;
    return {
      z: `1.08`,
      x: `iw/2-(iw/zoom/2)`,
      y: yExpr,
    };
  }
  if (mode === 3) {
    // 4. 우아한 슬로우 줌아웃 (디테일→전체 실루엣 공개)
    return {
      z: `1.08-0.08*${p}`,
      x: `iw/2-(iw/zoom/2)`,
      y: `ih/2-(ih/zoom/2)`,
    };
  }
  if (mode === 4) {
    // 5. 우→좌 대각선 시네마 드리프트
    return {
      z: `1.07`,
      x: `(iw-iw/zoom)*(0.82-0.64*${p})`,
      y: `(ih-ih/zoom)*(0.40+0.20*${p})`,
    };
  }
  // 6. 안정 호흡 푸시인 (멀티컬러 스플릿 등)
  return {
    z: `1+0.055*${p}`,
    x: `iw/2-(iw/zoom/2)`,
    y: `ih/2-(ih/zoom/2)`,
  };
}

function pickXfadeTransition(style, stepIdx, isBeforeEnding) {
  if (isBeforeEnding) return 'fade';
  if (style === 'fade') return 'fade';
  if (style === 'slide-left') return 'smoothleft';
  if (style === 'slide-up') return 'smoothup';
  // 기본 추천('mix'): 매거진 룩북 리듬 조합
  const cycle = ['fade', 'smoothleft', 'dissolve', 'smoothup', 'fade'];
  return cycle[stepIdx % cycle.length];
}

/**
 * 클립 구성과 소구점(최대 5개)을 분석해, 중복 없이 모든 소구점이 시간 순서대로 부드럽게 전환되는 자막 큐를 생성한다.
 * - 긴 영상(예: 15초 Flow AI 영상) 안에서는 약 3.5~4초마다 소구점 1 -> 2 -> 3 -> 4(최대 5)가 릴레이로 전환된다.
 * - 뒤이어 나오는 사진 컷들에는 이미 나온 소구점을 반복하지 않고 소재·가격·컬러칩·실물 핏 정보를 배분한다.
 */
function buildCaptionTimelineSpecs(clips, facts) {
  const cleanName = String(facts.headline || facts.name || '').trim();
  const cleanStyle = String(facts.style || '').trim();
  const cleanPrice = String(facts.price || '').trim();
  const cleanMaterial = String(facts.material || '').trim();
  const cleanPoints = (Array.isArray(facts.sellingPoints) ? facts.sellingPoints : [])
    .map(s => String(s || '').trim())
    .filter(Boolean)
    .slice(0, 5);
  const cleanColors = (Array.isArray(facts.colors) ? facts.colors : [])
    .filter(c => c && c.name)
    .slice(0, 10);
  const showColors = facts.showColors !== false && cleanColors.length > 0;
  const showPrice = facts.showPrice !== false && Boolean(cleanPrice);

  let pointCursor = 0;
  let materialShown = false;
  let colorsShown = false;
  let priceShown = false;

  const perClipCues = [];

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const dur = Math.max(1.2, Number(clip.duration) || 2.8);
    const cues = [];

    // 6.5초 이상의 긴 영상 클립(예: 12~15초 Flow AI 영상)은 내부에서 소구점을 릴레이 전환!
    if (clip.asset?.mediaType === 'video' && dur >= 6.5) {
      const relayCards = [];
      // 1번 슬롯: 품번 + 상품명 + 소구점 1
      relayCards.push({
        badge: cleanStyle ? `품번 ${cleanStyle}` : '지오다노 신상',
        mainText: cleanName || cleanPoints[0] || '',
        subText: cleanName ? (cleanPoints[pointCursor++] || '') : '',
        renderColorRow: false,
      });

      // 나머지 확인된 소구점 전부(2, 3, 4, 5번) 순차 배정
      const maxSlots = Math.min(5, Math.max(2, Math.floor(dur / 3.0)));
      while (pointCursor < cleanPoints.length && relayCards.length < maxSlots) {
        const ptIdx = pointCursor + 1;
        relayCards.push({
          badge: `포인트 0${ptIdx}`,
          mainText: cleanPoints[pointCursor++],
          subText: '',
          renderColorRow: false,
        });
      }

      // 소구점이 적어서 슬롯에 여유가 있으면 소재·컬러칩 보충
      if (relayCards.length < maxSlots && cleanMaterial && !materialShown) {
        materialShown = true;
        relayCards.push({
          badge: '소재 정보',
          mainText: cleanMaterial,
          subText: showPrice && !priceShown ? ((priceShown = true), `소비자가 ${cleanPrice}`) : '',
          renderColorRow: false,
        });
      }
      if (relayCards.length < maxSlots && showColors && !colorsShown && clips.length === 1) {
        colorsShown = true;
        relayCards.push({
          badge: `${cleanColors.length}가지 컬러`,
          mainText: cleanName,
          subText: '',
          renderColorRow: true,
        });
      }

      const marginStart = 0.2;
      const marginEnd = 0.25;
      const usable = Math.max(2, dur - marginStart - marginEnd);
      const slotDur = usable / relayCards.length;

      relayCards.forEach((card, idx) => {
        const st = Number((marginStart + idx * slotDur).toFixed(2));
        const en = Number((marginStart + (idx + 1) * slotDur - (idx < relayCards.length - 1 ? 0.12 : 0)).toFixed(2));
        cues.push({...card, startSec: st, endSec: Math.max(st + 0.8, en)});
      });
    } else {
      // 짧은 사진/영상 컷 (1.8~4.5초): 중복 없이 새로운 정보 1장씩 깔끔하게 배정
      let card = null;
      if (clip.asset?.kind === 'split-showcase') {
        colorsShown = true;
        card = {
          badge: showColors ? `${cleanColors.length}가지 컬러 한눈에 보기` : '멀티 컬러 룩북',
          mainText: showPrice ? `${cleanName} · ${cleanPrice}` : cleanName,
          subText: '',
          renderColorRow: showColors,
        };
      } else if (i === 0) {
        card = {
          badge: cleanStyle ? `품번 ${cleanStyle}` : '',
          mainText: cleanName,
          subText: cleanPoints[pointCursor++] || '',
          renderColorRow: false,
        };
      } else if (i === clips.length - 1 && showColors && !colorsShown) {
        colorsShown = true;
        card = {
          badge: `${cleanColors.length}가지 컬러`,
          mainText: cleanPoints[pointCursor++] || (showPrice && !priceShown ? ((priceShown = true), `${cleanName} · ${cleanPrice}`) : cleanName),
          subText: '',
          renderColorRow: true,
        };
      } else if (pointCursor < cleanPoints.length) {
        const ptIdx = pointCursor + 1;
        card = {
          badge: `포인트 0${ptIdx}`,
          mainText: cleanPoints[pointCursor++],
          subText: '',
          renderColorRow: false,
        };
      } else if (cleanMaterial && !materialShown) {
        materialShown = true;
        card = {
          badge: '소재 정보',
          mainText: cleanMaterial,
          subText: '',
          renderColorRow: false,
        };
      } else if (showPrice && !priceShown) {
        priceShown = true;
        card = {
          badge: cleanStyle ? `품번 ${cleanStyle}` : '공식 소비자가',
          mainText: cleanPrice,
          subText: cleanName,
          renderColorRow: false,
        };
      } else if (showColors && !colorsShown) {
        colorsShown = true;
        card = {
          badge: `${cleanColors.length}가지 컬러`,
          mainText: cleanName,
          subText: '',
          renderColorRow: true,
        };
      } else {
        // 모든 팩트 정보를 이미 보여준 추가 실물/마네킨 컷은 깔끔한 실물 핏 라벨만 은은하게 표기
        card = {
          badge: clip.asset?.kind === 'mannequin' ? '매장 실물 핏' : '착용 룩북',
          mainText: cleanName,
          subText: showPrice ? cleanPrice : '',
          renderColorRow: false,
        };
      }

      const st = 0.12;
      const en = Number(Math.max(st + 0.8, dur - 0.14).toFixed(2));
      cues.push({...card, startSec: st, endSec: en});
    }

    perClipCues.push(cues);
  }

  return perClipCues;
}

/**
 * 100% 팩트 기반 투명 PNG 그래픽 오버레이 및 엔딩 카드 렌더링 (Playwright + 설치된 Chrome 사용).
 * - 상단 로고는 중앙의 튀는 흰색 알약 대신 우측 상단에 은은한 [동탄롯데 지오다노] 워터마크로 표기한다.
 * - 각 클립별 릴레이 자막 PNG를 개별 렌더링해 FFmpeg에서 부드럽게 페이드 인/아웃한다.
 */
async function renderOverlaysWithBrowser({workDir, logoPath, facts, clips, includeEnding, captionStyle = 'magazine-serif'}) {
  const systemChrome = findSystemChrome();
  const browser = await chromium.launch({
    headless: true,
    ...(systemChrome ? {executablePath: systemChrome} : {}),
  });

  try {
    const page = await browser.newPage({viewport: {width: WIDTH, height: HEIGHT}, deviceScaleFactor: 1});
    const logoDataUrl = logoPath && fs.existsSync(logoPath)
      ? `data:image/png;base64,${fs.readFileSync(logoPath).toString('base64')}`
      : '';

    const cleanName = String(facts.headline || facts.name || '').trim();
    const cleanStyle = String(facts.style || '').trim();
    const cleanPrice = String(facts.price || '').trim();
    const cleanMaterial = String(facts.material || '').trim();
    const cleanColors = (Array.isArray(facts.colors) ? facts.colors : [])
      .filter(c => c && c.name)
      .slice(0, 10);
    const showLogo = facts.showLogo !== false;
    const showColors = facts.showColors !== false && cleanColors.length > 0;
    const showPrice = facts.showPrice !== false && Boolean(cleanPrice);

    const styleKey = ['editorial', 'magazine-serif', 'impact-shorts'].includes(captionStyle)
      ? captionStyle
      : 'magazine-serif';

    const sansFont = `'Noto Sans KR', 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif`;
    const serifFont = `'Noto Serif KR', 'HANBatang', 'Batang', serif`;

    const theme = styleKey === 'magazine-serif'
      ? {
          bodyFont: sansFont,
          headFont: serifFont,
          headWeight: 600,
          headTracking: '-0.025em',
          subFont: sansFont,
          subWeight: 400,
          gradCss: 'linear-gradient(to top, rgba(16, 14, 12, 0.78) 0%, rgba(16, 14, 12, 0.36) 52%, rgba(16, 14, 12, 0) 100%)',
          boxExtra: 'border-left: 3px solid rgba(232, 202, 160, 0.85); padding-left: 24px;',
          eyebrowCss: `
            display: inline-flex; align-self: flex-start;
            padding: 0 0 6px 0;
            border-bottom: 1px solid rgba(232, 202, 160, 0.55);
            color: rgba(238, 214, 176, 0.96);
            font-family: ${sansFont};
            font-size: 20px; font-weight: 500; letter-spacing: 0.14em;
            text-shadow: 0 2px 10px rgba(0,0,0,0.45);
          `,
          endingBg: 'radial-gradient(circle at 50% 34%, #26211c 0%, #12100e 100%)',
          endingNameFont: serifFont,
          endingNameWeight: 600,
        }
      : styleKey === 'impact-shorts'
        ? {
            bodyFont: sansFont,
            headFont: sansFont,
            headWeight: 800,
            headTracking: '-0.03em',
            subFont: sansFont,
            subWeight: 600,
            gradCss: 'linear-gradient(to top, rgba(12, 12, 14, 0.86) 0%, rgba(12, 12, 14, 0.48) 58%, rgba(12, 12, 14, 0) 100%)',
            boxExtra: '',
            eyebrowCss: `
              display: inline-flex; align-self: flex-start;
              padding: 7px 18px; border-radius: 999px;
              background: rgba(232, 202, 160, 0.24);
              border: 1px solid rgba(232, 202, 160, 0.55);
              color: #fff6e8;
              font-family: ${sansFont};
              font-size: 22px; font-weight: 700; letter-spacing: 0.05em;
            `,
            endingBg: 'radial-gradient(circle at 50% 38%, #222226 0%, #0f0f12 100%)',
            endingNameFont: sansFont,
            endingNameWeight: 800,
          }
        : {
            bodyFont: sansFont,
            headFont: sansFont,
            headWeight: 700,
            headTracking: '-0.025em',
            subFont: sansFont,
            subWeight: 400,
            gradCss: 'linear-gradient(to top, rgba(15, 15, 14, 0.76) 0%, rgba(15, 15, 14, 0.34) 52%, rgba(15, 15, 14, 0) 100%)',
            boxExtra: 'border-left: 2px solid rgba(255, 255, 255, 0.65); padding-left: 22px;',
            eyebrowCss: `
              display: inline-flex; align-self: flex-start;
              padding: 5px 15px; border-radius: 999px;
              background: rgba(255, 255, 255, 0.14);
              border: 1px solid rgba(255, 255, 255, 0.28);
              color: rgba(255, 255, 255, 0.94);
              font-family: ${sansFont};
              font-size: 20px; font-weight: 600; letter-spacing: 0.08em;
            `,
            endingBg: 'radial-gradient(circle at 50% 36%, #232220 0%, #131211 100%)',
            endingNameFont: sansFont,
            endingNameWeight: 700,
          };

    const pickHeadlineSize = (txt = '') => {
      const len = String(txt || '').trim().length;
      if (styleKey === 'impact-shorts') return len <= 14 ? 48 : len <= 24 ? 43 : 38;
      return len <= 14 ? 45 : len <= 24 ? 40 : 35;
    };

    const baseCss = `
      * { box-sizing: border-box; margin: 0; padding: 0; }
      html, body {
        width: ${WIDTH}px;
        height: ${HEIGHT}px;
        background: transparent;
        font-family: ${theme.bodyFont};
        color: #ffffff;
        overflow: hidden;
        -webkit-font-smoothing: antialiased;
        font-synthesis: none;
      }
      .top-store-mark {
        position: absolute;
        top: 50px;
        right: 42px;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 18px;
        border-radius: 999px;
        background: rgba(18, 17, 15, 0.28);
        border: 1px solid rgba(255, 255, 255, 0.22);
        color: rgba(255, 252, 246, 0.86);
        font-family: ${sansFont};
        font-size: 19px;
        font-weight: 500;
        letter-spacing: 0.11em;
        text-shadow: 0 1px 6px rgba(0, 0, 0, 0.38);
      }
      .top-store-dot {
        width: 5px;
        height: 5px;
        border-radius: 50%;
        background: rgba(232, 202, 160, 0.88);
      }
      .bottom-grad {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        height: 490px;
        background: ${theme.gradCss};
      }
      .caption-box {
        position: absolute;
        left: 60px;
        right: 60px;
        bottom: 108px;
        display: flex;
        flex-direction: column;
        gap: 14px;
        ${theme.boxExtra}
      }
      .eyebrow {
        ${theme.eyebrowCss}
      }
      .headline {
        font-family: ${theme.headFont};
        line-height: 1.32;
        font-weight: ${theme.headWeight};
        letter-spacing: ${theme.headTracking};
        color: #fffdf9;
        text-shadow: 0 3px 18px rgba(0, 0, 0, 0.48);
        word-break: keep-all;
        text-wrap: balance;
      }
      .subline {
        font-family: ${theme.subFont};
        font-size: 28px;
        line-height: 1.46;
        font-weight: ${theme.subWeight};
        letter-spacing: -0.01em;
        color: rgba(246, 240, 230, 0.94);
        text-shadow: 0 2px 12px rgba(0, 0, 0, 0.48);
        word-break: keep-all;
      }
      .color-row {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
        margin-top: 6px;
      }
      .color-chip {
        display: inline-flex;
        align-items: center;
        gap: 9px;
        padding: 8px 16px;
        border-radius: 999px;
        background: rgba(18, 17, 16, 0.62);
        border: 1px solid rgba(255,255,255,0.22);
        font-family: ${sansFont};
        font-size: 21px;
        font-weight: 500;
        letter-spacing: 0.01em;
      }
      .swatch {
        width: 20px;
        height: 20px;
        border-radius: 50%;
        border: 1.5px solid rgba(255,255,255,0.85);
        flex-shrink: 0;
      }
    `;

    // 1) 우측 상단 은은한 [동탄롯데 지오다노] 상시 워터마크 PNG 1장 생성
    let brandOverlayPath = null;
    if (showLogo) {
      const brandHtml = `<!doctype html><html><head><meta charset="utf-8"><style>${baseCss}</style></head><body>
        <div class="top-store-mark"><span class="top-store-dot"></span><span>동탄롯데 지오다노</span></div>
      </body></html>`;
      await page.setContent(brandHtml, {waitUntil: 'load'});
      await page.evaluate(() => document.fonts?.ready).catch(() => {});
      brandOverlayPath = path.join(workDir, 'brand-top.png');
      await page.screenshot({path: brandOverlayPath, omitBackground: true});
    }

    // 2) 각 클립별 자막 큐 PNG 렌더링
    const specsPerClip = buildCaptionTimelineSpecs(clips, facts);
    const clipOverlayCues = [];

    for (let i = 0; i < specsPerClip.length; i++) {
      const renderedCues = [];
      for (let j = 0; j < specsPerClip[i].length; j++) {
        const c = specsPerClip[i][j];
        const hasCaption = Boolean(c.badge || c.mainText || c.subText || c.renderColorRow);
        if (!hasCaption) continue;

        const headSize = pickHeadlineSize(c.mainText);
        const html = `<!doctype html><html><head><meta charset="utf-8"><style>${baseCss}</style></head><body>
          <div class="bottom-grad"></div>
          <div class="caption-box">
            ${c.badge ? `<div class="eyebrow">${escapeHtml(c.badge)}</div>` : ''}
            ${c.mainText ? `<div class="headline" style="font-size:${headSize}px;">${escapeHtml(c.mainText)}</div>` : ''}
            ${c.subText ? `<div class="subline">${escapeHtml(c.subText)}</div>` : ''}
            ${c.renderColorRow ? `<div class="color-row">${cleanColors.map(col => `<span class="color-chip"><span class="swatch" style="background:${escapeHtml(col.hex || '#888')}"></span>${escapeHtml(col.name)}</span>`).join('')}</div>` : ''}
          </div>
        </body></html>`;

        await page.setContent(html, {waitUntil: 'load'});
        await page.evaluate(() => document.fonts?.ready).catch(() => {});
        const outPath = path.join(workDir, `caption-${i}-${j}.png`);
        await page.screenshot({path: outPath, omitBackground: true});
        renderedCues.push({
          path: outPath,
          startSec: c.startSec,
          endSec: c.endSec,
        });
      }
      clipOverlayCues.push(renderedCues);
    }

    let endingPath = null;
    if (includeEnding) {
      const endNameSize = cleanName.length <= 16 ? 48 : cleanName.length <= 26 ? 42 : 37;
      const endingHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body {
          width: ${WIDTH}px; height: ${HEIGHT}px;
          background: ${theme.endingBg};
          font-family: ${sansFont};
          color: #f6f1e9;
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          padding: 96px; text-align: center; gap: 30px;
          -webkit-font-smoothing: antialiased;
          font-synthesis: none;
        }
        .store-pill {
          font-family: ${sansFont};
          font-size: 21px;
          font-weight: 500;
          letter-spacing: 0.16em;
          color: rgba(236, 212, 174, 0.92);
          padding: 9px 26px;
          border-radius: 999px;
          border: 1px solid rgba(236, 212, 174, 0.34);
          background: rgba(255, 255, 255, 0.03);
        }
        .logo-card {
          background: rgba(255, 255, 255, 0.95);
          padding: 18px 42px;
          border-radius: 999px;
          box-shadow: 0 18px 46px rgba(0,0,0,0.38);
        }
        .logo-card img { height: 28px; display: block; }
        .divider {
          width: 48px;
          height: 1px;
          background: rgba(232, 202, 160, 0.55);
        }
        .name {
          font-family: ${theme.endingNameFont};
          font-size: ${endNameSize}px;
          font-weight: ${theme.endingNameWeight};
          line-height: 1.35;
          letter-spacing: -0.02em;
          word-break: keep-all;
          text-wrap: balance;
          color: #fffbf4;
        }
        .meta { font-size: 25px; color: rgba(218, 206, 189, 0.88); letter-spacing: 0.12em; font-weight: 400; }
        .price {
          font-family: ${theme.endingNameFont};
          font-size: 46px;
          font-weight: 600;
          color: #ebd0a6;
          letter-spacing: 0.01em;
        }
        .material {
          font-size: 24px;
          font-weight: 400;
          color: rgba(240, 232, 220, 0.9);
          padding: 11px 26px;
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,0.18);
          background: rgba(255,255,255,0.04);
        }
        .chips { display: flex; flex-wrap: wrap; justify-content: center; gap: 14px; max-width: 860px; }
        .chip { display: inline-flex; align-items: center; gap: 9px; font-size: 22px; font-weight: 400; padding: 9px 18px; border-radius: 999px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.15); }
        .dot { width: 20px; height: 20px; border-radius: 50%; border: 1.5px solid rgba(255,255,255,0.82); }
      </style></head><body>
        ${showLogo ? `<div class="store-pill">동탄롯데 지오다노</div>` : ''}
        ${showLogo && logoDataUrl ? `<div class="logo-card"><img src="${logoDataUrl}" alt="GIORDANO"></div>` : ''}
        <div class="divider"></div>
        ${cleanName ? `<div class="name">${escapeHtml(cleanName)}</div>` : ''}
        ${cleanStyle ? `<div class="meta">STYLE NO. ${escapeHtml(cleanStyle)}</div>` : ''}
        ${showPrice ? `<div class="price">${escapeHtml(cleanPrice)}</div>` : ''}
        ${cleanMaterial ? `<div class="material">${escapeHtml(cleanMaterial)}</div>` : ''}
        ${showColors ? `<div class="chips">${cleanColors.map(c => `<span class="chip"><span class="dot" style="background:${escapeHtml(c.hex || '#888')}"></span>${escapeHtml(c.name)}</span>`).join('')}</div>` : ''}
      </body></html>`;

      await page.setContent(endingHtml, {waitUntil: 'load'});
      await page.evaluate(() => document.fonts?.ready).catch(() => {});
      endingPath = path.join(workDir, 'ending-card.png');
      await page.screenshot({path: endingPath});
    }

    return {brandOverlayPath, clipOverlayCues, endingPath};
  } finally {
    await browser.close().catch(() => {});
  }
}

async function runFFmpeg(args) {
  const {ffmpeg, available} = findFFmpegTools();
  if (!available) throw new Error('FFmpeg 실행 파일을 찾지 못했습니다.');
  try {
    await execFileAsync(ffmpeg, args, {timeout: 300000, maxBuffer: 16 * 1024 * 1024});
  } catch (err) {
    const tail = String(err.stderr || err.message || '').split(/\r?\n/).slice(-8).join('\n');
    throw new Error(`영상 인코딩 중 오류가 발생했습니다:\n${tail}`);
  }
}

/**
 * 15~20초 스마트스토어 9:16 하이브리드 MP4 최종 렌더링.
 */
export async function renderShortsVideo({
  assets,
  facts = {},
  options = {},
  bgmPath = null,
  workDir,
  outputsDir,
  logoPath,
  onProgress = () => {},
}) {
  const ff = findFFmpegTools();
  if (!ff.available) {
    throw new Error('이 PC에서 FFmpeg를 찾지 못했습니다. FFmpeg 설치 후 다시 시도해 주세요.');
  }

  await mkdir(workDir, {recursive: true});
  await mkdir(outputsDir, {recursive: true});

  onProgress('장면 순서 및 15~20초 타임라인 계산 중…', 10);
  const plan = buildAutoClipPlan(assets, options);

  // 킬러 장면: 서로 다른 컬러 사진이 2장 이상이고 옵션이 켜져 있으면 엔딩 직전에 [멀티 컬러 3분할 스플릿 컷] 자동 추가!
  const includeSplitShowcase = options.includeSplitShowcase !== false;
  const imageAssetsForSplit = assets.filter(a => a && a.enabled !== false && a.mediaType === 'image');
  if (includeSplitShowcase && imageAssetsForSplit.length >= 2) {
    const splitCanvasPath = path.join(workDir, 'canvas-split-multicolor.jpg');
    const splitRes = await createMultiColorSplitCanvas(imageAssetsForSplit, splitCanvasPath).catch(() => null);
    if (splitRes?.path) {
      plan.clips.push({
        asset: {
          id: 'auto-split-showcase',
          kind: 'split-showcase',
          mediaType: 'image',
          label: `전 컬러 ${splitRes.count}분할 한눈에 보기`,
          filename: 'split-multicolor.jpg',
          filePath: splitRes.path,
          isPrebuiltCanvas: true,
        },
        index: plan.clips.length,
        start: 0,
        duration: 2.7,
      });
      plan.totalSec = Number((plan.totalSec + 2.7).toFixed(2));
    }
  }

  const garmentCategory = classifyGarmentCategory(facts);

  onProgress('팩트 기반 감성 매거진 자막 · 동탄롯데 지오다노 표기 생성 중…', 24);
  const {brandOverlayPath, clipOverlayCues, endingPath} = await renderOverlaysWithBrowser({
    workDir,
    logoPath,
    facts,
    clips: plan.clips,
    includeEnding: plan.includeEnding,
    captionStyle: options.captionStyle || 'magazine-serif',
  });

  const segmentPaths = [];
  const keepOriginalAudio = Boolean(options.keepOriginalAudio);
  const originalVolume = Math.max(0, Math.min(1.5, Number(options.originalVolume ?? 0.85)));

  // 상시 워터마크 + 여러 개의 릴레이 자막(아래→위 Slide-Up + 부드러운 페이드 인/아웃)을 합성하는 공통 필터 빌더
  const buildLayeredOverlayFilter = ({baseChain, brandIdx, cueInputs}) => {
    const parts = [baseChain];
    let cur = 'base';
    if (brandIdx != null) {
      parts.push(`[${cur}][${brandIdx}:v]overlay=0:0:shortest=1[brandv]`);
      cur = 'brandv';
    }
    cueInputs.forEach((cue, k) => {
      const span = Math.max(0.6, cue.endSec - cue.startSec);
      const fadeDur = Number(Math.min(0.34, Math.max(0.16, span * 0.22)).toFixed(2));
      const fadeOutSt = Number(Math.max(cue.startSec + fadeDur, cue.endSec - fadeDur).toFixed(2));
      const st = cue.startSec;
      const slideDur = 0.36;
      const ySlideExpr = `if(lt(t-${st},${slideDur}),round(22*(1-(t-${st})/${slideDur})*(1-(t-${st})/${slideDur})),0)`;
      parts.push(
        `[${cue.inputIdx}:v]format=rgba,fade=t=in:st=${st}:d=${fadeDur}:alpha=1,fade=t=out:st=${fadeOutSt}:d=${fadeDur}:alpha=1[cap${k}]`
      );
      const next = `ov${k}`;
      parts.push(`[${cur}][cap${k}]overlay=x=0:y='${ySlideExpr}':enable='between(t,${st},${cue.endSec})':shortest=1[${next}]`);
      cur = next;
    });
    parts.push(`[${cur}]format=yuv420p[vout]`);
    return parts.join(';');
  };

  for (let i = 0; i < plan.clips.length; i++) {
    const clip = plan.clips[i];
    const cues = clipOverlayCues[i] || [];
    const segOut = path.join(workDir, `seg-${String(i).padStart(2, '0')}.mp4`);
    const pct = 30 + Math.round(((i + 1) / (plan.clips.length + 1)) * 45);
    onProgress(`장면 ${i + 1}/${plan.clips.length} 렌더링 중 (${clip.asset.label || clip.asset.filename})…`, pct);

    if (clip.asset.mediaType === 'video') {
      const probe = await probeMedia(clip.asset.filePath).catch(() => ({hasAudio: false}));
      const useClipAudio = keepOriginalAudio && probe.hasAudio;
      const clipSpeed = normalizeVideoSpeed(clip.speed ?? options.videoSpeed);
      const inputReadSec = Number(clip.sourceDuration || (clip.duration * clipSpeed));
      const args = [
        '-y',
        '-ss', String(clip.start),
        '-t', String(Number(inputReadSec.toFixed(2))),
        '-i', clip.asset.filePath,
      ];
      let nextIdx = 1;
      let silenceIdx = null;
      if (!useClipAudio) {
        args.push('-f', 'lavfi', '-t', String(clip.duration), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
        silenceIdx = nextIdx++;
      }
      let brandIdx = null;
      if (brandOverlayPath) {
        args.push('-loop', '1', '-t', String(clip.duration), '-i', brandOverlayPath);
        brandIdx = nextIdx++;
      }
      const cueInputs = cues.map(c => {
        args.push('-loop', '1', '-t', String(clip.duration), '-i', c.path);
        return {...c, inputIdx: nextIdx++};
      });

      const speedVideoExpr = Math.abs(clipSpeed - 1) > 0.01 ? `setpts=(PTS-STARTPTS)/${clipSpeed},fps=${FPS},` : '';
      const speedAudioExpr = Math.abs(clipSpeed - 1) > 0.01 ? `atempo=${clipSpeed},` : '';
      const baseChain = [
        `[0:v]${speedVideoExpr}split=2[bg0][fg0]`,
        `[bg0]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},boxblur=24:4[bg]`,
        `[fg0]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease[fg]`,
        `[bg][fg]overlay=(W-w)/2:(H-h)/2,fps=${FPS},setsar=1[base]`,
      ].join(';');

      const videoFilter = buildLayeredOverlayFilter({
        baseChain,
        durationSec: clip.duration,
        brandIdx,
        cueInputs,
      });

      const audioFilter = useClipAudio
        ? `;[0:a]${speedAudioExpr}volume=${originalVolume},aresample=48000,aformat=channel_layouts=stereo[aout]`
        : `;[${silenceIdx}:a]aformat=sample_rates=48000:channel_layouts=stereo[aout]`;

      args.push(
        '-filter_complex', videoFilter + audioFilter,
        '-map', '[vout]',
        '-map', '[aout]',
        '-t', String(clip.duration),
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '20',
        '-r', String(FPS),
        '-c:a', 'aac',
        '-b:a', '192k',
        segOut,
      );
      await runFFmpeg(args);
    } else {
      const canvasPath = clip.asset.isPrebuiltCanvas
        ? clip.asset.filePath
        : path.join(workDir, `canvas-${String(i).padStart(2, '0')}.jpg`);
      if (!clip.asset.isPrebuiltCanvas) {
        await prepareImageCanvas(clip.asset, canvasPath, options.studioTone || '#efeae2');
      }
      const frames = Math.max(30, Math.round(clip.duration * FPS));
      const motionIndex = clip.asset.kind === 'split-showcase' ? 5 : i;
      const motion = buildGimbalZoompanExpr(motionIndex, frames, garmentCategory);

      const args = [
        '-y',
        '-i', canvasPath,
        '-f', 'lavfi', '-t', String(clip.duration), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
      ];
      let nextIdx = 2;
      let brandIdx = null;
      if (brandOverlayPath) {
        args.push('-loop', '1', '-t', String(clip.duration), '-i', brandOverlayPath);
        brandIdx = nextIdx++;
      }
      const cueInputs = cues.map(c => {
        args.push('-loop', '1', '-t', String(clip.duration), '-i', c.path);
        return {...c, inputIdx: nextIdx++};
      });

      const baseChain = `[0:v]scale=${WIDTH * 2}:${HEIGHT * 2},zoompan=z='${motion.z}':x='${motion.x}':y='${motion.y}':d=${frames}:s=${WIDTH}x${HEIGHT}:fps=${FPS},setsar=1[base]`;
      const filter = buildLayeredOverlayFilter({
        baseChain,
        brandIdx,
        cueInputs,
      });

      args.push(
        '-filter_complex', filter,
        '-map', '[vout]',
        '-map', '1:a',
        '-t', String(clip.duration),
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '20',
        '-r', String(FPS),
        '-c:a', 'aac',
        '-b:a', '192k',
        segOut,
      );
      await runFFmpeg(args);
    }
    segmentPaths.push(segOut);
  }

  if (plan.includeEnding && endingPath) {
    onProgress('동탄롯데 지오다노 엔딩 카드 생성 중…', 80);
    const endingSeg = path.join(workDir, 'seg-ending.mp4');
    await runFFmpeg([
      '-y',
      '-loop', '1',
      '-t', String(plan.endingSec),
      '-i', endingPath,
      '-f', 'lavfi',
      '-t', String(plan.endingSec),
      '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-vf', `fps=${FPS},fade=t=out:st=${Math.max(0.5, plan.endingSec - 0.5)}:d=0.5,format=yuv420p`,
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '20',
      '-r', String(FPS),
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
      endingSeg,
    ]);
    segmentPaths.push(endingSeg);
  }

  onProgress('부드러운 크로스 디졸브 전환으로 전체 장면 연결 중…', 90);
  const mergedPath = path.join(workDir, 'merged.mp4');

  if (segmentPaths.length === 1) {
    fs.copyFileSync(segmentPaths[0], mergedPath);
  } else {
    const segDurations = [];
    for (const seg of segmentPaths) {
      const p = await probeMedia(seg).catch(() => ({duration: 2.4}));
      segDurations.push(Math.max(1.0, p.duration || 2.4));
    }
    const minSegDur = Math.min(...segDurations);
    const xfadeDur = Number(Math.max(0.22, Math.min(0.45, minSegDur * 0.32)).toFixed(2));

    const mergeArgs = ['-y'];
    for (const seg of segmentPaths) {
      mergeArgs.push('-i', seg);
    }

    const filterLines = [];
    for (let k = 0; k < segmentPaths.length; k++) {
      filterLines.push(`[${k}:v]fps=${FPS},settb=AVTB,format=yuv420p[sv${k}]`);
      filterLines.push(`[${k}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[sa${k}]`);
    }

    const transitionStyle = options.transitionStyle || 'mix';
    let curV = 'sv0';
    let curA = 'sa0';
    let accDur = segDurations[0];
    for (let k = 1; k < segmentPaths.length; k++) {
      const offset = Math.max(0.1, Number((accDur - xfadeDur).toFixed(3)));
      const nextV = `xv${k}`;
      const nextA = `xa${k}`;
      const isBeforeEnding = Boolean(plan.includeEnding && endingPath && k === segmentPaths.length - 1);
      const transName = pickXfadeTransition(transitionStyle, k - 1, isBeforeEnding);
      filterLines.push(`[${curV}][sv${k}]xfade=transition=${transName}:duration=${xfadeDur}:offset=${offset}[${nextV}]`);
      filterLines.push(`[${curA}][sa${k}]acrossfade=d=${xfadeDur}:c1=tri:c2=tri[${nextA}]`);
      curV = nextV;
      curA = nextA;
      accDur = accDur + segDurations[k] - xfadeDur;
    }
    filterLines.push(`[${curV}]format=yuv420p[vout]`);

    mergeArgs.push(
      '-filter_complex', filterLines.join(';'),
      '-map', '[vout]',
      '-map', `[${curA}]`,
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '20',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      mergedPath,
    );
    await runFFmpeg(mergeArgs);
  }

  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  const stylePart = sanitizeFilenamePart(facts.style, 'shorts');
  const namePart = sanitizeFilenamePart(facts.headline || facts.name, 'giordano');
  const outputFilename = `${stylePart}_${namePart}_${stamp}.mp4`;
  const finalOutputPath = path.join(outputsDir, outputFilename);

  // 사용자 직접 업로드 BGM 최우선, 없으면 선택한 내장 백화점 쇼룸 BGM 자동 합성!
  let effectiveBgmPath = (bgmPath && fs.existsSync(bgmPath)) ? bgmPath : null;
  const builtinBgmId = options.builtinBgm ?? 'lounge-pad';
  if (!effectiveBgmPath && builtinBgmId && builtinBgmId !== 'none') {
    const mergedProbeTmp = await probeMedia(mergedPath).catch(() => ({duration: plan.totalSec}));
    const synthPath = path.join(workDir, `builtin-bgm-${builtinBgmId}.wav`);
    effectiveBgmPath = await generateBuiltinBgmWav(builtinBgmId, synthPath, Math.ceil((mergedProbeTmp.duration || plan.totalSec) + 2)).catch(() => null);
  }

  if (effectiveBgmPath && fs.existsSync(effectiveBgmPath)) {
    const mergedProbe = await probeMedia(mergedPath).catch(() => ({duration: plan.totalSec}));
    const totalDur = Math.max(2, mergedProbe.duration || plan.totalSec);
    const bgmVol = Math.max(0.1, Math.min(1.5, Number(options.bgmVolume ?? 0.65)));
    const fadeOutStart = Math.max(0.5, Number((totalDur - 1.2).toFixed(2)));

    const audioMix = keepOriginalAudio
      ? `[1:a]volume=${bgmVol},afade=t=in:st=0:d=0.4,afade=t=out:st=${fadeOutStart}:d=1.2,aresample=48000[bgm];[0:a]aresample=48000[orig];[orig][bgm]amix=inputs=2:duration=first:dropout_transition=2,dynaudnorm[aout]`
      : `[1:a]volume=${bgmVol},afade=t=in:st=0:d=0.4,afade=t=out:st=${fadeOutStart}:d=1.2,aresample=48000[aout]`;

    await runFFmpeg([
      '-y',
      '-i', mergedPath,
      '-stream_loop', '-1',
      '-i', effectiveBgmPath,
      '-filter_complex', audioMix,
      '-map', '0:v',
      '-map', '[aout]',
      '-t', String(totalDur),
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      finalOutputPath,
    ]);
  } else {
    fs.copyFileSync(mergedPath, finalOutputPath);
  }

  const finalProbe = await probeMedia(finalOutputPath).catch(() => ({duration: plan.totalSec, width: WIDTH, height: HEIGHT}));
  const finalSize = fs.statSync(finalOutputPath).size;

  // 임시 세그먼트만 정리 (원본·누끼·출력 영상은 유지)
  await rm(workDir, {recursive: true, force: true}).catch(() => {});

  onProgress('스마트스토어 9:16 숏츠 제작이 완료되었습니다!', 100);
  return {
    outputPath: finalOutputPath,
    filename: outputFilename,
    durationSec: finalProbe.duration || plan.totalSec,
    width: finalProbe.width || WIDTH,
    height: finalProbe.height || HEIGHT,
    sizeBytes: finalSize,
    clipCount: plan.clips.length,
  };
}
