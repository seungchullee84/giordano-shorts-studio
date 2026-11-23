import fs from 'node:fs';
import {copyFile, mkdir, readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import {findDesktopPhotoRoot, findDesktopVideoRoot, findRegistrarDataDir} from './runtime.mjs';
import {extractGarmentColorProfile} from './product-loader.mjs';
import {probeMedia} from './video-renderer.mjs';

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv']);

function fileSha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function colorDistance(a, b) {
  if (!a || !b) return 0;
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  const rMean = (a.r + b.r) / 2;
  return Math.sqrt(((2 + rMean / 256) * dr * dr) + (4 * dg * dg) + ((2 + (255 - rMean) / 256) * db * db));
}

/**
 * 기존 상품등록기(매장 PC 등)에 캐시된 정면 판별 결과(role='front')가 있으면 읽기 전용으로 조회한다.
 */
async function loadCachedRoleMap() {
  const dataDir = findRegistrarDataDir();
  if (!dataDir) return new Map();
  const predDir = path.join(dataDir, 'local-photo-predictions');
  if (!fs.existsSync(predDir)) return new Map();
  const map = new Map();
  try {
    const files = await readdir(predDir);
    for (const f of files.slice(0, 1000)) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(predDir, f), 'utf8'));
        const hash = raw.hash || raw.photo?.hash;
        const role = raw.prediction?.role;
        if (hash && role) map.set(hash, role);
      } catch {}
    }
  } catch {}
  return map;
}

/**
 * 마네킨 정면 구도 특징 분석 (로컬 고속 연산):
 * - 좌우 대칭도 (정면 마네킨은 어깨·몸통 실루엣 대칭이 높고, 측면은 비대칭)
 * - 중앙 앞여밈/넥라인 수직 구조 신호
 * - 라벨/극단 클로즈업(텍스트 밀도 과다 또는 중앙-외곽 대비 부족) 감점
 * - 세로 전신/반신 비율 및 선명도 반영
 */
export async function analyzeMannequinFrontScore(imagePath, cachedRole = null) {
  const meta = await sharp(imagePath).rotate().metadata();
  const width = Number(meta.width || 0);
  const height = Number(meta.height || 0);
  if (width < 320 || height < 320) {
    return {score: 0, likelyFront: false, reason: '저해상도', width, height};
  }

  // 등록기 검증 캐시에 role이 이미 있는 경우 강하게 반영
  if (cachedRole === 'care-label' || cachedRole === 'detail' || cachedRole === 'back') {
    return {score: 12, likelyFront: false, reason: `기존 판별: ${cachedRole}`, width, height};
  }

  const W = 64;
  const H = 84;
  const {data} = await sharp(imagePath)
    .rotate()
    .resize(W, H, {fit: 'cover'})
    .grayscale()
    .raw()
    .toBuffer({resolveWithObject: true});

  const px = (x, y) => data[y * W + x];

  // 1. 좌우 대칭도 (중앙 의류 영역: y 18%~82%, x 14%~86%)
  let symDiffSum = 0;
  let symCount = 0;
  for (let y = Math.floor(H * 0.18); y < Math.floor(H * 0.82); y++) {
    for (let x = Math.floor(W * 0.14); x < Math.floor(W * 0.5); x++) {
      const mirrorX = W - 1 - x;
      symDiffSum += Math.abs(px(x, y) - px(mirrorX, y));
      symCount++;
    }
  }
  const meanSymDiff = symDiffSum / Math.max(1, symCount);
  const symmetryScore = Math.max(0, Math.min(1, 1 - meanSymDiff / 68)); // 0~1

  // 2. 중앙 피사체 vs 외곽 배경 분리도 (극단 확대 클로즈업/평면 텍스처 감점)
  let edgeSum = 0, edgeN = 0, centerSum = 0, centerN = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = px(x, y);
      if (x < 6 || x >= W - 6 || y < 5) {
        edgeSum += v; edgeN++;
      } else if (x >= 18 && x < W - 18 && y >= 18 && y < H - 14) {
        centerSum += v; centerN++;
      }
    }
  }
  const subjectContrast = Math.abs((centerSum / Math.max(1, centerN)) - (edgeSum / Math.max(1, edgeN)));
  const framingScore = Math.min(1, subjectContrast / 42);

  // 3. 중앙 앞여밈/넥라인 수직 에지 강도 (정면 지퍼·단추·브이넥·목선 보조 단서)
  let centerVertEdge = 0, centerEdgeN = 0;
  for (let y = Math.floor(H * 0.16); y < Math.floor(H * 0.72); y++) {
    for (let x = Math.floor(W * 0.44); x <= Math.floor(W * 0.56); x++) {
      centerVertEdge += Math.abs(px(x + 1, y) - px(x - 1, y));
      centerEdgeN++;
    }
  }
  const centerLineScore = Math.min(1, (centerVertEdge / Math.max(1, centerEdgeN)) / 26);

  // 4. 케어라벨/문서 감점 (밝은 바탕 + 고주파 작은 텍스트 에지가 화면 전체에 분포)
  let brightPixels = 0, highFreqEdges = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const v = px(x, y);
      if (v > 215) brightPixels++;
      const grad = Math.abs(px(x + 1, y) - px(x - 1, y)) + Math.abs(px(x, y + 1) - px(x, y - 1));
      if (grad > 65) highFreqEdges++;
    }
  }
  const brightRatio = brightPixels / (W * H);
  const sharpEdgeRatio = highFreqEdges / (W * H);
  const isLikelyLabel = brightRatio > 0.62 && sharpEdgeRatio > 0.18;

  // 5. 세로 구도 점수 (마네킨 전신/상반신 사진은 보통 세로 비율)
  const ratio = height / width;
  const aspectScore = ratio >= 1.15 && ratio <= 2.1 ? 1.0 : (ratio >= 0.9 && ratio <= 2.3 ? 0.72 : 0.35);

  let total = (
    symmetryScore * 42 +
    framingScore * 20 +
    centerLineScore * 18 +
    aspectScore * 20
  );
  if (isLikelyLabel) total -= 45;
  if (cachedRole === 'front') total = Math.min(100, total + 30);

  const score = Math.max(0, Math.min(100, Math.round(total)));
  return {
    score,
    likelyFront: score >= 52 && !isLikelyLabel,
    reason: cachedRole === 'front'
      ? '등록기 정면 판별 일치'
      : isLikelyLabel
        ? '라벨·문서 의심 제외'
        : `정면 대칭·구도 ${score}점`,
    width,
    height,
  };
}

/**
 * 품번 6자리로 상품등록기사진폴더 안의 매칭 폴더를 찾는다. (예: "375908", "116958 와이드", "116955일자")
 */
export async function findStylePhotoFolders(style) {
  const photoRoot = findDesktopPhotoRoot();
  if (!photoRoot || !/^\d{6}$/.test(String(style || ''))) return [];
  const entries = await readdir(photoRoot, {withFileTypes: true}).catch(() => []);
  const matched = entries
    .filter(e => e.isDirectory() && e.name.includes(style))
    .map(e => path.join(photoRoot, e.name))
    .sort((a, b) => {
      const aExact = path.basename(a) === style ? 0 : 1;
      const bExact = path.basename(b) === style ? 0 : 1;
      return aExact - bExact || a.localeCompare(b);
    });
  return matched;
}

/**
 * 정면 점수 상위 후보들 중에서 서로 다른 컬러 2~4장을 우선 선별하고,
 * 다른 컬러가 부족하면 정면 점수가 높은 같은 컬러 컷으로 2~4장을 채운다.
 */
export function selectFrontMannequinShots(candidates, {minCount = 2, maxCount = 3, distinctThreshold = 54} = {}) {
  if (!candidates.length) return [];
  const sorted = [...candidates].sort((a, b) => b.frontScore - a.frontScore);
  // 1순위: 정면 인식을 통과한 사진만 필터링 (라벨·후면·측면 제외)
  const frontOnly = sorted.filter(c => c.likelyFront);
  // 정면 후보가 최소 개수 이상이면 정면 사진만 사용, 부족할 때만 라벨이 아닌 상위 후보로 최소 개수 보충
  const pool = frontOnly.length >= minCount
    ? [...frontOnly]
    : (sorted.filter(c => c.frontScore >= 35).length >= minCount ? sorted.filter(c => c.frontScore >= 35) : [...sorted]);

  const targetCount = Math.min(maxCount, pool.length);
  const picked = [];
  const remaining = [...pool];

  // 1번: 정면 점수가 가장 높은 대표 마네킨 컷
  const first = remaining.shift();
  picked.push({...first, pickNote: '정면 대표'});

  while (picked.length < targetCount && remaining.length) {
    let bestIdx = -1;
    let bestTotal = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i];
      const minDist = Math.min(...picked.map(p => colorDistance(p.colorProfile, cand.colorProfile)));
      const distinctTagBonus = cand.colorTag && picked.every(p => p.colorTag !== cand.colorTag) ? 95 : 0;
      const colorScore = Math.min(130, minDist) + distinctTagBonus;
      const combined = cand.frontScore * 1.15 + colorScore * 0.65;
      if (combined > bestTotal) {
        bestTotal = combined;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break;
    const chosen = remaining.splice(bestIdx, 1)[0];
    const minDist = Math.min(...picked.map(p => colorDistance(p.colorProfile, chosen.colorProfile)));
    const isDiffColor = minDist >= distinctThreshold || (chosen.colorTag && picked.every(p => p.colorTag !== chosen.colorTag));
    picked.push({...chosen, pickNote: isDiffColor ? '정면 · 다른 컬러' : '정면 후보'});
  }

  // 정면으로 선별된 2~3장만 깔끔하게 반환 (나머지 미선별 사진은 올리지 않음)
  return picked.map(item => ({...item, enabled: true}));
}

/**
 * 품번으로 `상품등록기사진폴더`의 마네킨 정면 2~4장 + `상품영상`/품번폴더 내 해당 품번 동영상을 읽기 전용 복사 수집한다.
 */
export async function loadLocalMannequinAndVideos(style, destSourcesDir, {existingHashes = new Set(), maxMannequins = 3} = {}) {
  if (!/^\d{6}$/.test(String(style || ''))) {
    return {mannequinAssets: [], videoAssets: [], matchedFolder: null};
  }
  await mkdir(destSourcesDir, {recursive: true});

  const folders = await findStylePhotoFolders(style);
  const roleMap = await loadCachedRoleMap();
  const seenHashes = new Set(existingHashes);

  const imageCandidates = [];
  const videoCandidates = [];

  // 1. 상품등록기사진폴더/<품번*> 내부 스캔 (원본 읽기 전용)
  for (const dir of folders) {
    const entries = await readdir(dir, {withFileTypes: true}).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const full = path.join(dir, entry.name);
      const ext = path.extname(entry.name).toLowerCase();

      if (VIDEO_EXTS.has(ext)) {
        videoCandidates.push({srcPath: full, originalName: entry.name, sourceType: '사진폴더 영상'});
        continue;
      }
      if (!IMAGE_EXTS.has(ext)) continue;
      // ChatGPT 합성 이미지나 미리보기보다 실제 매장 촬영 원본 우선 (단, 전체가 합성뿐이면 포함)
      const isGenerated = /^chatgpt|preview|thumbnail/i.test(entry.name);
      try {
        const hash = fileSha256(full);
        if (seenHashes.has(hash)) continue;
        seenHashes.add(hash);

        const front = await analyzeMannequinFrontScore(full, roleMap.get(hash) || null);
        if (front.width < 320 || front.height < 320) continue;
        const colorProfile = await extractGarmentColorProfile(full);
        const colorTagMatch = entry.name.match(/(?:기존상품|color|컬러)[_\-\s]?(\d{2})/i);

        imageCandidates.push({
          srcPath: full,
          originalName: entry.name,
          ext,
          width: front.width,
          height: front.height,
          likelyFront: front.likelyFront,
          frontScore: Math.max(0, front.score - (isGenerated ? 12 : 0)),
          frontReason: front.reason,
          colorProfile,
          colorTag: colorTagMatch ? colorTagMatch[1] : null,
        });
      } catch {}
    }
  }

  // 2. 바탕화면 `상품영상` 폴더에서 품번 일치 영상 탐색 (원본 읽기 전용)
  const videoRoot = findDesktopVideoRoot();
  if (videoRoot) {
    const entries = await readdir(videoRoot, {withFileTypes: true}).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!VIDEO_EXTS.has(ext)) continue;
      if (!entry.name.includes(style)) continue;
      videoCandidates.push({
        srcPath: path.join(videoRoot, entry.name),
        originalName: entry.name,
        sourceType: '상품영상 폴더',
      });
    }
  }

  // 정면 인식 기준 2~4장 자동 선별
  const selectedMannequins = selectFrontMannequinShots(imageCandidates, {minCount: 2, maxCount: maxMannequins});
  const mannequinAssets = [];
  for (let i = 0; i < selectedMannequins.length; i++) {
    const item = selectedMannequins[i];
    const idx = i + 1;
    const destName = `mannequin-auto-${String(idx).padStart(2, '0')}${item.ext}`;
    const destPath = path.join(destSourcesDir, destName);
    await copyFile(item.srcPath, destPath);

    mannequinAssets.push({
      id: `mannequin-auto-${idx}`,
      kind: 'mannequin',
      mediaType: 'image',
      label: `마네킨 ${item.pickNote} ${idx} (${item.frontScore}점)`,
      originalName: item.originalName,
      frontScore: item.frontScore,
      frontReason: item.frontReason,
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

  // 해당 품번 영상 복사 수집 (최대 2개, 첫 번째 영상은 기본 활성화)
  const videoAssets = [];
  const seenVideoHashes = new Set();
  for (let i = 0; i < Math.min(3, videoCandidates.length); i++) {
    const v = videoCandidates[i];
    try {
      const hash = fileSha256(v.srcPath);
      if (seenVideoHashes.has(hash)) continue;
      seenVideoHashes.add(hash);

      const idx = videoAssets.length + 1;
      const ext = path.extname(v.originalName).toLowerCase() || '.mp4';
      const destName = `style-video-${String(idx).padStart(2, '0')}${ext}`;
      const destPath = path.join(destSourcesDir, destName);
      await copyFile(v.srcPath, destPath);

      const probe = await probeMedia(destPath).catch(() => ({duration: 6, width: 1080, height: 1920}));
      videoAssets.push({
        id: `style-video-${idx}`,
        kind: 'video',
        mediaType: 'video',
        label: `품번 영상 ${idx} · ${path.parse(v.originalName).name.slice(0, 18)}`,
        originalName: v.originalName,
        filename: destName,
        filePath: destPath,
        width: probe.width,
        height: probe.height,
        sourceDurationSec: probe.duration || 6,
        enabled: idx === 1, // 첫 번째 품번 영상은 바로 활용 가능하게 기본 켜기, 추가 영상은 선택 토글
        durationSec: Math.min(12, probe.duration || 6),
        trimStart: 0,
        trimEnd: Number(Math.min(12, probe.duration || 6).toFixed(1)),
      });
    } catch {}
  }

  return {
    mannequinAssets,
    videoAssets,
    matchedFolder: folders[0] || null,
  };
}
