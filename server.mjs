import http from 'node:http';
import fs from 'node:fs';
import {mkdir, readdir, readFile, stat, unlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import sharp from 'sharp';
import {getEnvironmentStatus, listRegistrarStyles} from './lib/runtime.mjs';
import {loadProductByInput} from './lib/product-loader.mjs';
import {loadLocalMannequinAndVideos} from './lib/local-mannequin-loader.mjs';
import {createOfficialCutout} from './lib/cutout.mjs';
import {
  FLOW_MODELS,
  FLOW_PRESETS,
  GARMENT_CATEGORIES,
  buildFlowPrompt,
  classifyGarmentCategory,
  closeFlowChrome,
  estimateFlowCredits,
  importLatestFlowVideo,
  launchAndPrepareFlow,
  prepareFlowReferenceImage,
  recommendDefaultPreset,
  selectBestFlowReferences,
} from './lib/flow-engine.mjs';
import {
  cancelRemoteFlow,
  inspectRemoteFlowPage,
  openOrConnectRemoteChrome,
  runRemoteFlowPipeline,
} from './lib/flow-remote.mjs';
import {probeMedia, renderShortsVideo} from './lib/video-renderer.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const dataDir = path.join(root, 'data');
const workspacesDir = path.join(root, 'workspaces');
const outputsDir = path.join(root, 'outputs');
const flowProfileDir = path.join(dataDir, 'flow-chrome-profile');
const flowDownloadsDir = path.join(dataDir, 'flow-downloads');
const sessionFilePath = path.join(dataDir, 'current-session.json');
const logoPath = path.join(publicDir, 'giordano-official-logo.png');

await mkdir(dataDir, {recursive: true});
await mkdir(workspacesDir, {recursive: true});
await mkdir(outputsDir, {recursive: true});
await mkdir(flowDownloadsDir, {recursive: true});

function createInitialSession() {
  const id = `job-${Date.now()}-${randomBytes(3).toString('hex')}`;
  return {
    id,
    dir: path.join(workspacesDir, id),
    sourcesDir: path.join(workspacesDir, id, 'sources'),
    cutoutsDir: path.join(workspacesDir, id, 'cutouts'),
    flowPrepDir: path.join(workspacesDir, id, 'flow-prep'),
    product: null,
    facts: {
      style: '',
      name: '',
      headline: '',
      price: '',
      material: '',
      sellingPoints: [],
      colors: [],
      showLogo: true,
      showColors: true,
      showPrice: true,
    },
    assets: [],
    bgm: null,
    flow: {
      modelId: 'omni-1.2-720p',
      durationSec: 15,
      presetId: 'top-signature-lookbook',
      garmentCategory: 'auto',
      customDirection: '',
      heroAssetId: null,
      preparedImages: [],
      promptEn: '',
      summaryKo: '',
      status: 'idle',
      busy: false,
      watchingDownloads: false,
      autoChainRender: true,
      message: '',
      actions: [],
    },
    options: {
      mode: 'flow-hybrid', // 'flow-hybrid' | 'motion-lookbook' | 'video-upgrade'
      captionStyle: 'magazine-serif', // 'magazine-serif' | 'editorial' | 'impact-shorts'
      transitionStyle: 'mix', // 'mix' | 'fade' | 'slide-left' | 'slide-up'
      builtinBgm: 'lounge-pad', // 'lounge-pad' | 'minimal-piano' | 'city-chill' | 'none'
      includeSplitShowcase: true,
      targetDurationSec: 17.5,
      videoSpeed: 1.3,
      includeEnding: true,
      keepOriginalAudio: false,
      originalVolume: 0.8,
      bgmVolume: 0.65,
      preserveOrder: false,
      studioTone: '#efeae2',
    },
    render: {
      busy: false,
      progress: 0,
      stage: '대기',
      error: '',
      lastOutput: null,
    },
    logs: [],
  };
}

function loadPersistedSession() {
  try {
    if (!fs.existsSync(sessionFilePath)) return createInitialSession();
    const saved = JSON.parse(fs.readFileSync(sessionFilePath, 'utf8'));
    if (!saved || typeof saved !== 'object' || !saved.id) return createInitialSession();
    const base = createInitialSession();
    const merged = {
      ...base,
      ...saved,
      facts: {...base.facts, ...(saved.facts || {})},
      flow: {...base.flow, ...(saved.flow || {})},
      options: {...base.options, ...(saved.options || {})},
      render: {
        ...base.render,
        ...(saved.render || {}),
        busy: false, // 재시작 시 이전 실행 중 플래그는 해제
        stage: saved.render?.busy ? '대기' : (saved.render?.stage || '대기'),
      },
      assets: Array.isArray(saved.assets) ? saved.assets.filter(a => a?.filePath && fs.existsSync(a.filePath)) : [],
      bgm: saved.bgm?.filePath && fs.existsSync(saved.bgm.filePath) ? saved.bgm : null,
      logs: Array.isArray(saved.logs) ? saved.logs.slice(0, 60) : [],
    };
    merged.flow.busy = false;
    merged.flow.watchingDownloads = false;
    merged.flow.preparedImages = Array.isArray(merged.flow.preparedImages)
      ? merged.flow.preparedImages.filter(p => p && fs.existsSync(p))
      : [];
    if (merged.render.lastOutput?.outputPath && !fs.existsSync(merged.render.lastOutput.outputPath)) {
      merged.render.lastOutput = null;
    }
    return merged;
  } catch {
    return createInitialSession();
  }
}

function saveSessionState() {
  try {
    const tmp = `${sessionFilePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(session, null, 2), 'utf8');
    fs.renameSync(tmp, sessionFilePath);
  } catch {}
}

let session = loadPersistedSession();

function addLog(message) {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  session.logs.unshift({time: `${hh}:${mm}:${ss}`, message});
  if (session.logs.length > 60) session.logs.length = 60;
  saveSessionState();
}

if (!session.logs.length) {
  addLog('지오다노 숏츠등록기가 준비되었습니다. 원본 무손상 · 거짓 정보 0% 모드로 동작합니다.');
} else {
  saveSessionState();
}

function toMediaUrl(filePath) {
  if (!filePath) return null;
  const rel = path.relative(root, filePath).split(path.sep).join('/');
  if (rel.startsWith('..')) return null;
  let ver = '';
  try {
    if (fs.existsSync(filePath)) {
      ver = `?v=${Math.floor(fs.statSync(filePath).mtimeMs)}`;
    }
  } catch {}
  return `/media/${rel.split('/').map(encodeURIComponent).join('/')}${ver}`;
}

async function buildPreparedFlowImages() {
  const rawImageAssets = session.assets.filter(a => a.enabled !== false && a.mediaType === 'image');
  if (!rawImageAssets.length) {
    session.flow.preparedImages = [];
    return [];
  }

  await mkdir(session.flowPrepDir, {recursive: true});
  let ordered = await selectBestFlowReferences(rawImageAssets, {preserveOrder: session.options.preserveOrder, maxCount: 4});

  // 사용자가 직접 지정한 대표 시작 사진(heroAssetId)이 있으면 무조건 1번으로 배치
  if (session.flow.heroAssetId) {
    const hero = rawImageAssets.find(a => a.id === session.flow.heroAssetId);
    if (hero) {
      ordered = [hero, ...ordered.filter(a => a.id !== hero.id)].slice(0, 4);
    } else {
      session.flow.heroAssetId = ordered[0]?.id || null;
    }
  } else {
    session.flow.heroAssetId = ordered[0]?.id || null;
  }

  const styleTag = (session.facts.style || 'item').replace(/[^a-zA-Z0-9가-힣]/g, '').slice(0, 10) || '상품';
  const prepared = [];
  for (let i = 0; i < ordered.length; i++) {
    const asset = ordered[i];
    const fileLabel = i === 0
      ? `1번_시작프레임_${styleTag}.jpg`
      : `${i + 1}번_보조참고_${styleTag}.jpg`;
    const out = path.join(session.flowPrepDir, fileLabel);
    await prepareFlowReferenceImage(asset.filePath, out, {isCutout: false, studioTone: session.options.studioTone});
    prepared.push(out);
  }
  session.flow.preparedImages = prepared;
  return prepared;
}

let downloadWatchTimer = null;
let downloadWatchBaseline = new Map();
let downloadWatchStartedAt = 0;
const pendingSizeMap = new Map();

async function snapshotDownloadVideos() {
  const dirs = [flowDownloadsDir, path.join(os.homedir(), 'Downloads')];
  const map = new Map();
  for (const dir of dirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    try {
      const entries = await readdir(dir, {withFileTypes: true});
      for (const e of entries) {
        if (!e.isFile() || !/\.(mp4|mov|webm)$/i.test(e.name)) continue;
        const full = path.join(dir, e.name);
        const st = await stat(full);
        map.set(full, {mtimeMs: st.mtimeMs, size: st.size});
      }
    } catch {}
  }
  return map;
}

function stopFlowDownloadWatcher() {
  if (downloadWatchTimer) {
    clearInterval(downloadWatchTimer);
    downloadWatchTimer = null;
  }
  pendingSizeMap.clear();
  session.flow.watchingDownloads = false;
}

async function handleDetectedFlowVideo(videoFullPath) {
  stopFlowDownloadWatcher();
  await mkdir(session.sourcesDir, {recursive: true});
  const ext = path.extname(videoFullPath) || '.mp4';
  const destName = `flow-auto-${Date.now()}${ext}`;
  const destPath = path.join(session.sourcesDir, destName);
  fs.copyFileSync(videoFullPath, destPath);

  const probe = await probeMedia(destPath).catch(() => ({duration: session.flow.durationSec || 15, width: 1080, height: 1920}));
  // 이전에 등록된 Flow 영상이 있으면 중복 재생 방지를 위해 자동 비활성화 후 새 영상을 1번에 배치
  for (const a of session.assets) {
    if (a.kind === 'flow') a.enabled = false;
  }

  session.assets.unshift({
    id: `flow-${Date.now()}`,
    kind: 'flow',
    mediaType: 'video',
    label: `Google Flow AI 영상 (${probe.duration || session.flow.durationSec}초)`,
    filename: destName,
    originalName: path.basename(videoFullPath),
    filePath: destPath,
    width: probe.width,
    height: probe.height,
    sourceDurationSec: probe.duration || session.flow.durationSec,
    enabled: true,
    durationSec: Math.min(15, probe.duration || session.flow.durationSec),
    trimStart: 0,
    trimEnd: Number(Math.min(15, probe.duration || session.flow.durationSec).toFixed(1)),
  });

  session.flow.status = 'completed';
  session.flow.message = `새 Flow 다운로드 감지 완료(${path.basename(videoFullPath)})! 자막·로고·컬러칩 최종 합성을 시작합니다…`;
  addLog(`새 Flow 영상 자동 감지 및 등록 완료: ${path.basename(videoFullPath)}`);
  saveSessionState();

  if (session.flow.autoChainRender !== false && !session.render.busy) {
    try {
      session.render = {busy: true, progress: 5, stage: 'Flow 영상 감지 → 한글 자막·로고·컬러칩 최종 합성 중…', error: '', lastOutput: session.render.lastOutput};
      saveSessionState();
      const renderWorkDir = path.join(session.dir, `render-${Date.now()}`);
      const outResult = await renderShortsVideo({
        assets: session.assets.filter(a => a.enabled !== false),
        facts: session.facts,
        options: session.options,
        bgmPath: session.bgm?.filePath || null,
        workDir: renderWorkDir,
        outputsDir,
        logoPath,
        onProgress: (stage, progress) => {
          session.render.stage = stage;
          session.render.progress = progress;
          addLog(stage);
        },
      });
      session.render = {busy: false, progress: 100, stage: '자동 제작 완료!', error: '', lastOutput: outResult};
      session.flow.message = `🎉 최종 숏츠 완성! (${outResult.filename}) 우측 미리보기에서 바로 확인하세요.`;
      addLog(`최종 숏츠 자동 완성: ${outResult.filename}`);
      saveSessionState();
    } catch (err) {
      session.render = {busy: false, progress: 0, stage: '제작 오류', error: err.message, lastOutput: session.render.lastOutput};
      addLog(`자동 합성 오류: ${err.message}`);
      saveSessionState();
    }
  }
}

async function startFlowDownloadWatcher() {
  stopFlowDownloadWatcher();
  await mkdir(flowDownloadsDir, {recursive: true});
  downloadWatchBaseline = await snapshotDownloadVideos();
  downloadWatchStartedAt = Date.now();
  session.flow.watchingDownloads = true;
  saveSessionState();

  downloadWatchTimer = setInterval(async () => {
    try {
      // 최대 35분 후 자동 종료
      if (Date.now() - downloadWatchStartedAt > 35 * 60 * 1000) {
        stopFlowDownloadWatcher();
        session.flow.message = '다운로드 자동 감시 대기 시간이 종료되었습니다. 필요 시 [수동 다운로드 영상 불러오기]를 눌러주세요.';
        saveSessionState();
        return;
      }

      const current = await snapshotDownloadVideos();
      for (const [full, info] of current.entries()) {
        const base = downloadWatchBaseline.get(full);
        const isNew = info.mtimeMs >= (downloadWatchStartedAt - 1500) && (!base || info.mtimeMs > base.mtimeMs + 1000);
        if (!isNew) continue;
        if (info.size < 100 * 1024) continue; // 아직 다운로드 초기 단계
        if (fs.existsSync(`${full}.crdownload`) || fs.existsSync(`${full}.part`)) continue;

        const prevSize = pendingSizeMap.get(full);
        if (prevSize === undefined || prevSize !== info.size) {
          pendingSizeMap.set(full, info.size);
          continue; // 다음 틱에 파일 크기가 안정화되었는지 한 번 더 확인
        }

        await handleDetectedFlowVideo(full);
        return;
      }
    } catch {}
  }, 1800);
}

async function listOutputs() {
  try {
    const entries = await readdir(outputsDir, {withFileTypes: true});
    const list = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/\.mp4$/i.test(entry.name)) continue;
      const full = path.join(outputsDir, entry.name);
      const st = await stat(full);
      list.push({
        filename: entry.name,
        url: toMediaUrl(full),
        sizeBytes: st.size,
        updatedAt: st.mtime.toISOString(),
      });
    }
    list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return list.slice(0, 15);
  } catch {
    return [];
  }
}

async function buildClientState() {
  const env = getEnvironmentStatus();
  const recentStyles = await listRegistrarStyles(12);
  const outputs = await listOutputs();
  return {
    sessionId: session.id,
    env,
    recentStyles,
    flowModels: Object.values(FLOW_MODELS),
    flowPresets: Object.values(FLOW_PRESETS),
    product: session.product,
    facts: session.facts,
    assets: session.assets.map(a => ({
      ...a,
      url: toMediaUrl(a.filePath),
      cutoutUrl: toMediaUrl(a.cutoutPath),
    })),
    bgm: session.bgm ? {
      filename: session.bgm.filename,
      originalName: session.bgm.originalName,
      url: toMediaUrl(session.bgm.filePath),
    } : null,
    flow: {
      ...session.flow,
      resolvedCategory: (session.flow.garmentCategory && GARMENT_CATEGORIES[session.flow.garmentCategory])
        ? session.flow.garmentCategory
        : classifyGarmentCategory({...session.product, ...session.facts}),
      estimatedCredits: estimateFlowCredits(session.flow.modelId, session.flow.durationSec),
      liveSnapUrl: null,
      preparedImages: session.flow.preparedImages.map(p => ({
        filename: path.basename(p),
        url: toMediaUrl(p),
      })),
    },
    options: session.options,
    render: {
      ...session.render,
      lastOutput: session.render.lastOutput ? {
        ...session.render.lastOutput,
        url: toMediaUrl(session.render.lastOutput.outputPath),
      } : null,
    },
    outputs,
    logs: session.logs,
  };
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req, maxBytes = 4 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error('요청 크기가 너무 큽니다.');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text ? JSON.parse(text) : {};
}

async function readBinaryBody(req, maxBytes = 250 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error('업로드 파일은 250MB 이하만 지원합니다.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function mimeForExt(ext) {
  const map = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.woff2': 'font/woff2',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
  };
  return map[ext.toLowerCase()] || 'application/octet-stream';
}

function serveMediaFile(req, res, absolutePath, forceDownload = false) {
  const resolved = path.resolve(absolutePath);
  const allowedRoots = [path.resolve(workspacesDir), path.resolve(outputsDir), path.resolve(publicDir)];
  if (!allowedRoots.some(r => resolved.startsWith(r + path.sep) || resolved === r)) {
    return sendJson(res, 403, {error: '접근이 허용되지 않은 경로입니다.'});
  }
  if (!fs.existsSync(resolved)) {
    return sendJson(res, 404, {error: '파일을 찾을 수 없습니다.'});
  }
  const st = fs.statSync(resolved);
  const ext = path.extname(resolved);
  const contentType = mimeForExt(ext);
  const range = req.headers.range;

  if (!forceDownload && range) {
    const match = range.match(/bytes=(\d*)-(\d*)/);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Math.min(Number(match[2]), st.size - 1) : st.size - 1;
      if (start <= end && start < st.size) {
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${st.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(end - start + 1),
          'Content-Type': contentType,
          'Cache-Control': 'no-store',
        });
        fs.createReadStream(resolved, {start, end}).pipe(res);
        return;
      }
    }
  }

  const headers = {
    'Content-Length': String(st.size),
    'Accept-Ranges': 'bytes',
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  };
  if (forceDownload) {
    const encodedName = encodeURIComponent(path.basename(resolved));
    headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodedName}`;
  }
  res.writeHead(200, headers);
  fs.createReadStream(resolved).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/api/state') {
      return sendJson(res, 200, await buildClientState());
    }

    if (req.method === 'POST' && url.pathname === '/api/load-product') {
      const body = await readJsonBody(req);
      addLog(`품번/주소 조회 시작: ${body.input}`);
      const loaded = await loadProductByInput(body.input, session.sourcesDir);

      // 수동 업로드한 사용자 파일만 유지하고, 이전 품번의 공식몰·마네킨·품번영상·Flow AI 영상은 깨끗하게 교체
      const manualAssets = session.assets.filter(
        a => a.kind !== 'flow' && !/^(?:official-model-|mannequin-auto-|style-video-|flow-)/.test(a.id)
      );
      stopFlowDownloadWatcher();
      session.options.preserveOrder = false;
      session.flow.status = 'ready';
      session.flow.message = '';
      session.flow.actions = [];

      // 공식몰 사진 해시 수집 (사진폴더와 동일 파일 중복 방지)
      const existingHashes = new Set();
      for (const a of loaded.assets) {
        try {
          if (fs.existsSync(a.filePath)) {
            existingHashes.add(createHash('sha256').update(fs.readFileSync(a.filePath)).digest('hex'));
          }
        } catch {}
      }

      // 상품등록기사진폴더(정면 인식된 마네킨 2~3장만) + 상품영상 폴더(품번 일치 영상 1개) 자동 수집 (원본 무손상 복사)
      const localPack = await loadLocalMannequinAndVideos(loaded.product.style, session.sourcesDir, {
        existingHashes,
        maxMannequins: 3,
      });

      const activeOfficial = loaded.assets.length;
      const activeMannequin = localPack.mannequinAssets.length;
      const activeVideos = localPack.videoAssets.filter(a => a.enabled).length;

      session.product = loaded.product;
      // 딱 황금 비율(품번 영상 0~1 + 공식몰 모델 3장 + 마네킨 정면 2~3장)만 깔끔하게 배치
      session.assets = [
        ...localPack.videoAssets.filter(a => a.enabled),
        ...loaded.assets,
        ...localPack.mannequinAssets,
        ...manualAssets,
      ];
      const formattedPrice = Number.isFinite(loaded.product.consumerPrice) && loaded.product.consumerPrice > 0
        ? `${loaded.product.consumerPrice.toLocaleString('ko-KR')}원`
        : '';
      session.facts = {
        style: loaded.product.style || '',
        gender: loaded.product.gender || '',
        name: loaded.product.name || '',
        headline: loaded.product.rawName || loaded.product.name || '',
        price: formattedPrice,
        material: loaded.product.material || '',
        sellingPoints: [...(loaded.product.sellingPoints || [])],
        colors: [...(loaded.product.colors || [])],
        showLogo: true,
        showColors: (loaded.product.colors || []).length > 0,
        showPrice: Boolean(formattedPrice),
      };
      addLog(
        `${loaded.product.sourceLabel} 완료 — 공식몰 모델 ${activeOfficial}장` +
        (activeMannequin ? ` · 사진폴더 마네킨 정면 ${activeMannequin}장` : '') +
        (activeVideos ? ` · 품번 영상 ${activeVideos}개` : '') +
        ' 자동 선별 완료'
      );

      const detectedCategory = classifyGarmentCategory({...loaded.product, ...session.facts});
      session.flow.garmentCategory = 'auto';
      session.flow.presetId = recommendDefaultPreset(detectedCategory, loaded.product);

      const promptData = buildFlowPrompt({
        product: {...(session.product || {}), ...session.facts},
        assets: session.assets,
        modelId: session.flow.modelId,
        durationSec: session.flow.durationSec,
        presetId: session.flow.presetId,
        customDirection: session.flow.customDirection,
        garmentCategory: session.flow.garmentCategory,
      });
      session.flow.heroAssetId = null;
      await buildPreparedFlowImages();
      session.flow.promptEn = promptData.promptEn;
      session.flow.summaryKo = promptData.summaryKo;
      saveSessionState();

      return sendJson(res, 200, await buildClientState());
    }

    if (req.method === 'POST' && url.pathname === '/api/upload') {
      const kind = url.searchParams.get('kind') || 'mannequin';
      const rawName = decodeURIComponent(url.searchParams.get('name') || `upload-${Date.now()}`);
      const ext = path.extname(rawName).toLowerCase() || (kind === 'bgm' ? '.mp3' : '.jpg');
      const buf = await readBinaryBody(req);
      if (!buf.length) throw new Error('빈 파일은 업로드할 수 없습니다.');

      await mkdir(session.sourcesDir, {recursive: true});
      const id = `${kind}-${Date.now()}-${randomBytes(2).toString('hex')}`;
      const filename = `${id}${ext}`;
      const destPath = path.join(session.sourcesDir, filename);
      await writeFile(destPath, buf);

      if (kind === 'bgm' || ['.mp3', '.wav', '.m4a', '.aac', '.ogg'].includes(ext)) {
        session.bgm = {filePath: destPath, filename, originalName: rawName};
        addLog(`BGM 음악이 등록되었습니다: ${rawName}`);
        return sendJson(res, 200, await buildClientState());
      }

      const isVideo = ['.mp4', '.mov', '.webm', '.mkv'].includes(ext);
      let width = 0, height = 0, sourceDurationSec = 0;
      if (isVideo) {
        const probe = await probeMedia(destPath).catch(() => ({duration: 6, width: 0, height: 0}));
        width = probe.width;
        height = probe.height;
        sourceDurationSec = probe.duration || 6;
      } else {
        const meta = await sharp(destPath).rotate().metadata().catch(() => ({}));
        width = meta.width || 0;
        height = meta.height || 0;
      }

      const normalizedKind = kind === 'flow' ? 'flow' : (isVideo ? 'video' : 'mannequin');
      const labelPrefix = normalizedKind === 'flow'
        ? 'Google Flow 영상'
        : normalizedKind === 'video'
          ? '내 동영상'
          : '매장 마네킨 샷';

      const asset = {
        id,
        kind: normalizedKind,
        mediaType: isVideo ? 'video' : 'image',
        label: `${labelPrefix} · ${path.parse(rawName).name.slice(0, 18)}`,
        filename,
        originalName: rawName,
        filePath: destPath,
        width,
        height,
        sourceDurationSec,
        cutoutPath: null,
        cutoutWarning: '',
        useCutout: false, // 매장 마네킨 샷은 절대 배경제거 없이 원본 유지!
        enabled: true,
        durationSec: isVideo ? Math.min(15, sourceDurationSec || 6) : 2.8,
        trimStart: 0,
        trimEnd: isVideo ? Number(Math.min(15, sourceDurationSec || 6).toFixed(1)) : null,
      };

      if (normalizedKind === 'flow') {
        session.assets.unshift(asset);
        addLog(`Google Flow 생성 영상이 추가되었습니다 (원본 검수 가능): ${rawName}`);
      } else {
        session.assets.push(asset);
        addLog(`${labelPrefix} 추가됨 (원본 그대로 보존): ${rawName}`);
      }

      return sendJson(res, 200, await buildClientState());
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/cutout/')) {
      const targetId = decodeURIComponent(url.pathname.slice('/api/cutout/'.length));
      const targets = targetId === 'all'
        ? session.assets.filter(a => a.kind === 'official' && a.mediaType === 'image')
        : session.assets.filter(a => a.id === targetId && a.kind === 'official' && a.mediaType === 'image');

      if (!targets.length) {
        throw new Error('누끼 대상 공식몰 사진이 없습니다. (매장 마네킨 샷은 원본 보존 원칙에 따라 누끼를 적용하지 않습니다.)');
      }

      for (const asset of targets) {
        addLog(`공식몰 누끼 추출 중: ${asset.label}`);
        const cut = await createOfficialCutout(asset.filePath, session.cutoutsDir, asset.id);
        asset.cutoutPath = cut.cutoutPath;
        asset.cutoutEngine = cut.engineLabel;
        asset.cutoutWarning = cut.warning || '';
        asset.useCutout = !cut.warning;
      }
      addLog(`공식몰 사진 ${targets.length}장 누끼 추출 완료 (원본 보존)`);
      return sendJson(res, 200, await buildClientState());
    }

    if (req.method === 'POST' && url.pathname === '/api/assets/update') {
      const body = await readJsonBody(req);
      if (body.action === 'reorder' && Array.isArray(body.order)) {
        const map = new Map(session.assets.map(a => [a.id, a]));
        const next = body.order.map(id => map.get(id)).filter(Boolean);
        for (const a of session.assets) {
          if (!next.includes(a)) next.push(a);
        }
        session.assets = next;
        session.options.preserveOrder = true;
        addLog('장면 순서가 변경되었습니다.');
      } else if (body.action === 'delete' && body.id) {
        session.assets = session.assets.filter(a => a.id !== body.id);
        addLog('선택한 재료를 작업 목록에서 제외했습니다. (PC 원본은 유지됩니다)');
      } else if (body.action === 'set-hero' && body.id) {
        const target = session.assets.find(a => a.id === body.id && a.mediaType === 'image');
        if (target) {
          target.enabled = true;
          session.flow.heroAssetId = target.id;
          await buildPreparedFlowImages();
          addLog(`Flow 대표 시작 사진을 변경했습니다: ${target.label}`);
        }
      } else if (body.action === 'remove-bgm') {
        session.bgm = null;
        addLog('BGM 설정을 해제했습니다.');
      } else if (body.id) {
        const target = session.assets.find(a => a.id === body.id);
        if (target) {
          if (typeof body.useCutout === 'boolean' && target.kind === 'official') target.useCutout = body.useCutout;
          if (typeof body.enabled === 'boolean') target.enabled = body.enabled;
          if (body.durationSec != null) target.durationSec = Math.max(1.2, Math.min(15, Number(body.durationSec) || 2.8));
          if (body.trimStart != null) target.trimStart = Math.max(0, Number(body.trimStart) || 0);
          if (body.trimEnd != null) target.trimEnd = body.trimEnd === '' ? null : Math.max(0.5, Number(body.trimEnd));
        }
      }
      saveSessionState();
      return sendJson(res, 200, await buildClientState());
    }

    if (req.method === 'POST' && url.pathname === '/api/facts/update') {
      const body = await readJsonBody(req);
      if (body.facts) {
        session.facts = {
          ...session.facts,
          style: String(body.facts.style ?? session.facts.style).trim(),
          headline: String(body.facts.headline ?? session.facts.headline).trim(),
          name: String(body.facts.headline ?? session.facts.name).trim(),
          price: String(body.facts.price ?? session.facts.price).trim(),
          material: String(body.facts.material ?? session.facts.material).trim(),
          sellingPoints: Array.isArray(body.facts.sellingPoints)
            ? body.facts.sellingPoints.map(s => String(s || '').trim()).filter(Boolean).slice(0, 5)
            : session.facts.sellingPoints,
          showLogo: body.facts.showLogo !== undefined ? Boolean(body.facts.showLogo) : session.facts.showLogo,
          showColors: body.facts.showColors !== undefined ? Boolean(body.facts.showColors) : session.facts.showColors,
          showPrice: body.facts.showPrice !== undefined ? Boolean(body.facts.showPrice) : session.facts.showPrice,
        };
      }
      if (body.options) {
        session.options = {...session.options, ...body.options};
      }
      if (body.flow) {
        if (body.flow.modelId && FLOW_MODELS[body.flow.modelId]) session.flow.modelId = body.flow.modelId;
        if (body.flow.durationSec != null) session.flow.durationSec = Math.max(4, Math.min(15, Number(body.flow.durationSec) || 15));
        if (body.flow.garmentCategory && ['auto', 'top', 'outer', 'bottom'].includes(body.flow.garmentCategory)) {
          const prevCat = session.flow.garmentCategory;
          session.flow.garmentCategory = body.flow.garmentCategory;
          if (prevCat !== body.flow.garmentCategory && !body.flow.presetId) {
            const nextResolved = session.flow.garmentCategory === 'auto'
              ? classifyGarmentCategory({...session.product, ...session.facts})
              : session.flow.garmentCategory;
            session.flow.presetId = recommendDefaultPreset(nextResolved, {...session.product, ...session.facts});
          }
        }
        if (body.flow.presetId && FLOW_PRESETS[body.flow.presetId]) session.flow.presetId = body.flow.presetId;
        if (body.flow.customDirection !== undefined) session.flow.customDirection = String(body.flow.customDirection || '').trim();
        const promptData = buildFlowPrompt({
          product: {...(session.product || {}), ...session.facts},
          assets: session.assets,
          modelId: session.flow.modelId,
          durationSec: session.flow.durationSec,
          presetId: session.flow.presetId,
          customDirection: session.flow.customDirection,
          garmentCategory: session.flow.garmentCategory,
        });
        session.flow.promptEn = body.flow.promptEn ?? promptData.promptEn;
        session.flow.summaryKo = promptData.summaryKo;
      }
      saveSessionState();
      return sendJson(res, 200, await buildClientState());
    }

    if (req.method === 'POST' && url.pathname === '/api/flow/prepare') {
      const body = await readJsonBody(req);
      if (body.modelId && FLOW_MODELS[body.modelId]) session.flow.modelId = body.modelId;
      if (body.durationSec != null) session.flow.durationSec = Math.max(4, Math.min(15, Number(body.durationSec) || 15));
      if (body.garmentCategory && ['auto', 'top', 'outer', 'bottom'].includes(body.garmentCategory)) {
        session.flow.garmentCategory = body.garmentCategory;
      }
      if (body.presetId && FLOW_PRESETS[body.presetId]) session.flow.presetId = body.presetId;
      if (body.customDirection !== undefined) session.flow.customDirection = String(body.customDirection || '').trim();

      const prepared = await buildPreparedFlowImages();
      if (!prepared.length) {
        throw new Error('Google Flow에 넣을 참고 사진(공식몰 사진 또는 마네킨 샷)을 1장 이상 먼저 추가해 주세요.');
      }

      const promptData = buildFlowPrompt({
        product: {...(session.product || {}), ...session.facts},
        assets: session.assets,
        modelId: session.flow.modelId,
        durationSec: session.flow.durationSec,
        presetId: session.flow.presetId,
        customDirection: session.flow.customDirection,
        garmentCategory: session.flow.garmentCategory,
      });

      session.flow.promptEn = promptData.promptEn;
      session.flow.summaryKo = promptData.summaryKo;
      session.flow.status = 'prepared';
      session.flow.message = `대표 시작 사진(${path.basename(prepared[0])})과 의류 맞춤 프롬프트가 준비되었습니다.`;
      addLog(session.flow.message);
      saveSessionState();

      return sendJson(res, 200, await buildClientState());
    }

    if (req.method === 'POST' && url.pathname === '/api/flow/launch') {
      const body = await readJsonBody(req);
      if (body.modelId && FLOW_MODELS[body.modelId]) session.flow.modelId = body.modelId;
      if (body.durationSec != null) session.flow.durationSec = Math.max(4, Math.min(15, Number(body.durationSec) || 15));
      if (body.garmentCategory && ['auto', 'top', 'outer', 'bottom'].includes(body.garmentCategory)) {
        session.flow.garmentCategory = body.garmentCategory;
      }
      if (body.presetId && FLOW_PRESETS[body.presetId]) session.flow.presetId = body.presetId;
      if (body.customDirection !== undefined) session.flow.customDirection = String(body.customDirection || '').trim();
      if (body.autoChainRender !== undefined) session.flow.autoChainRender = Boolean(body.autoChainRender);

      const prepared = await buildPreparedFlowImages();
      if (!prepared.length) {
        throw new Error('먼저 1단계에서 품번을 불러오거나 사진을 추가해 주세요.');
      }

      const promptData = buildFlowPrompt({
        product: {...(session.product || {}), ...session.facts},
        assets: session.assets,
        modelId: session.flow.modelId,
        durationSec: session.flow.durationSec,
        presetId: session.flow.presetId,
        customDirection: session.flow.customDirection,
        garmentCategory: session.flow.garmentCategory,
      });
      const userEdited = String(body.promptText || '').trim();
      const hasCategoryRule = /주인공 · 구도 고정\]/.test(userEdited);
      const finalPrompt = (userEdited && hasCategoryRule) ? userEdited : promptData.promptEn;
      session.flow.promptEn = finalPrompt;
      session.flow.summaryKo = promptData.summaryKo;

      const result = await launchAndPrepareFlow({
        profileDir: flowProfileDir,
        preparedImagePaths: prepared,
        promptEn: finalPrompt,
        modelId: session.flow.modelId,
        downloadsDir: flowDownloadsDir,
        log: addLog,
      });

      // 대표 시작 사진 파일이 바로 파랗게 선택된 상태로 탐색기 폴더 열기
      if (process.platform === 'win32' && prepared[0] && fs.existsSync(prepared[0])) {
        try {
          const child = spawn('explorer.exe', [`/select,${prepared[0]}`], {detached: true, stdio: 'ignore'});
          child.on('error', () => {});
          child.unref();
        } catch {}
      }

      // 백그라운드 다운로드 자동 감시기 시작!
      await startFlowDownloadWatcher();

      const heroFileName = path.basename(prepared[0]);
      session.flow.status = 'watching';
      session.flow.message = `🟢 다운로드 자동 감시 켜짐! Flow 하단 [시작] 칸에 [${heroFileName}] 1장을 드래그 → Ctrl+V → 생성 후 [다운로드]만 누르시면 자막·로고 최종 숏츠까지 자동 완성됩니다!`;
      session.flow.actions = [
        `1) 열린 폴더(또는 아래 대표 사진 카드)의 [${heroFileName}]을 Flow 하단 [시작] 칸에 드래그 (최초 1회: 동영상 · 프레임 · 9:16 · 15초 · x1 확인)`,
        `2) Flow 입력창 클릭 후 Ctrl+V (성별·착장 고정 프롬프트가 이미 복사됨) → 생성 시작(→)`,
        `3) 완성된 영상 카드 우측 상단 [⋮] → [다운로드] 클릭 시 이 화면에서 최종 자막 숏츠까지 자동 제작!`,
      ];
      addLog('다운로드 실시간 자동 감시 시작 — Flow에서 다운로드만 누르면 최종 자막 숏츠까지 자동 완성됩니다.');
      saveSessionState();
      return sendJson(res, 200, await buildClientState());
    }

    if (req.method === 'POST' && url.pathname === '/api/flow/watch-toggle') {
      const body = await readJsonBody(req);
      if (body.enable === false) {
        stopFlowDownloadWatcher();
        session.flow.status = 'ready';
        session.flow.message = '다운로드 자동 감시를 중지했습니다.';
      } else {
        await startFlowDownloadWatcher();
        session.flow.status = 'watching';
        session.flow.message = '🟢 다운로드 자동 감시가 켜졌습니다! Flow에서 영상을 다운로드하면 자동으로 최종 숏츠를 완성합니다.';
      }
      saveSessionState();
      return sendJson(res, 200, await buildClientState());
    }

    if (req.method === 'POST' && url.pathname === '/api/flow/remote-open') {
      await openOrConnectRemoteChrome({
        studioRoot: root,
        profileDir: flowProfileDir,
        log: addLog,
      });
      session.flow.status = 'chrome_opened';
      session.flow.message = '전용 원격 제어 Chrome 창이 열렸습니다. 최초 1회 Google 로그인을 완료해 두시면 이후 원클릭 자동 생성이 바로 실행됩니다.';
      saveSessionState();
      return sendJson(res, 200, await buildClientState());
    }

    if (req.method === 'POST' && url.pathname === '/api/flow/remote-cancel') {
      cancelRemoteFlow();
      session.flow.message = 'Flow 자동 실행 중지를 요청했습니다…';
      addLog('사용자가 Flow 원격 자동 실행 중지를 요청했습니다.');
      saveSessionState();
      return sendJson(res, 200, await buildClientState());
    }

    if (req.method === 'GET' && url.pathname === '/api/flow/inspect') {
      const info = await inspectRemoteFlowPage({studioRoot: root, profileDir: flowProfileDir});
      return sendJson(res, 200, info);
    }

    if (req.method === 'POST' && url.pathname === '/api/flow/remote-auto') {
      if (session.flow.busy || session.render.busy) {
        return sendJson(res, 409, {error: '현재 자동 작업이 진행 중입니다. 잠시만 기다려 주세요.'});
      }
      const body = await readJsonBody(req);
      if (body.modelId && FLOW_MODELS[body.modelId]) session.flow.modelId = body.modelId;
      if (body.garmentCategory && ['auto', 'top', 'bottom'].includes(body.garmentCategory)) {
        session.flow.garmentCategory = body.garmentCategory;
      }
      if (body.durationSec != null) session.flow.durationSec = Math.max(4, Math.min(15, Number(body.durationSec) || 15));
      if (body.presetId && FLOW_PRESETS[body.presetId]) session.flow.presetId = body.presetId;
      if (body.customDirection !== undefined) session.flow.customDirection = String(body.customDirection || '').trim();
      if (body.autoChainRender !== undefined) session.flow.autoChainRender = Boolean(body.autoChainRender);

      const rawImageAssets = session.assets.filter(a => a.enabled !== false && a.mediaType === 'image');
      if (!rawImageAssets.length) {
        throw new Error('먼저 1단계에서 품번을 불러오거나 참고할 사진을 추가해 주세요.');
      }

      // 기존 수동 다운로드 감시기가 켜져 있으면 중복 합성 방지를 위해 중지
      stopFlowDownloadWatcher();

      // 1. 대표 시작 사진(사용자 ☆ 지정 우선)을 1순위로 준비하고, Flow 업로드 목록 매칭용 영문 고유 파일명 생성
      await buildPreparedFlowImages();
      let orderedImages = await selectBestFlowReferences(rawImageAssets, {preserveOrder: session.options.preserveOrder, maxCount: 4});
      if (session.flow.heroAssetId) {
        const hero = rawImageAssets.find(a => a.id === session.flow.heroAssetId);
        if (hero) {
          orderedImages = [hero, ...orderedImages.filter(a => a.id !== hero.id)].slice(0, 4);
        }
      }
      const styleTag = (session.facts.style || 'item').replace(/[^a-zA-Z0-9]/g, '').slice(0, 6) || 'item';
      const batchTag = randomBytes(2).toString('hex');
      const prepared = [];
      for (let i = 0; i < orderedImages.length; i++) {
        const asset = orderedImages[i];
        const out = path.join(session.flowPrepDir, `f${styleTag}-${batchTag}-${i + 1}.jpg`);
        await prepareFlowReferenceImage(asset.filePath, out, {isCutout: false, studioTone: session.options.studioTone});
        prepared.push(out);
      }

      // 2. 의류 구분 + 성별·착장 고정 프롬프트 준비
      const promptData = buildFlowPrompt({
        product: {...(session.product || {}), ...session.facts},
        assets: session.assets,
        modelId: session.flow.modelId,
        durationSec: session.flow.durationSec,
        presetId: session.flow.presetId,
        customDirection: session.flow.customDirection,
        garmentCategory: session.flow.garmentCategory,
      });
      const candidatePrompt = String(body.promptText || session.flow.promptEn || '').trim();
      const hasCategoryRule = /주인공 · 구도 고정\]|100% 고정\]/.test(candidatePrompt);
      const finalPrompt = (candidatePrompt && hasCategoryRule) ? candidatePrompt : promptData.promptEn;
      session.flow.promptEn = finalPrompt;
      session.flow.summaryKo = promptData.summaryKo;
      session.flow.actions = [];
      session.flow.busy = true;
      session.flow.status = 'running';
      session.flow.message = '⚡ 전용 Chrome에서 Google Flow 끝까지 자동화를 시작합니다…';
      saveSessionState();

      // 비동기 백그라운드 원격 파이프라인 실행
      const liveSnapPath = '';
      session.flow.liveSnapPath = '';
      (async () => {
        try {
          const resFlow = await runRemoteFlowPipeline({
            studioRoot: root,
            profileDir: flowProfileDir,
            downloadsDir: flowDownloadsDir,
            preparedImagePaths: prepared,
            promptText: finalPrompt,
            modelId: session.flow.modelId,
            durationSec: session.flow.durationSec,
            waitForCompletion: true,
            liveSnapPath,
            onStatus: (msg) => {
              session.flow.message = msg;
              addLog(msg);
            },
          });

          session.flow.busy = false;
          session.flow.status = resFlow.status;
          session.flow.message = resFlow.message;

          if (resFlow.status === 'completed' && resFlow.videoPath && fs.existsSync(resFlow.videoPath)) {
            await mkdir(session.sourcesDir, {recursive: true});
            const ext = path.extname(resFlow.videoPath) || '.mp4';
            const destName = `flow-remote-${Date.now()}${ext}`;
            const destPath = path.join(session.sourcesDir, destName);
            fs.copyFileSync(resFlow.videoPath, destPath);
            const probe = await probeMedia(destPath).catch(() => ({duration: session.flow.durationSec, width: 1080, height: 1920}));

            session.assets.unshift({
              id: `flow-${Date.now()}`,
              kind: 'flow',
              mediaType: 'video',
              label: `Google Flow AI 영상 (${probe.duration || session.flow.durationSec}초)`,
              filename: destName,
              originalName: path.basename(resFlow.videoPath),
              filePath: destPath,
              width: probe.width,
              height: probe.height,
              sourceDurationSec: probe.duration || session.flow.durationSec,
              enabled: true,
              durationSec: Math.min(15, probe.duration || session.flow.durationSec),
              trimStart: 0,
              trimEnd: Number(Math.min(15, probe.duration || session.flow.durationSec).toFixed(1)),
            });
            addLog('원격 Flow 생성 영상을 필름 스트립 맨 앞에 자동 등록했습니다!');
            saveSessionState();

            // 논스톱 최종 FFmpeg 숏츠 자동 합성 연결
            if (session.flow.autoChainRender && !session.render.busy) {
              session.render = {busy: true, progress: 5, stage: 'Flow 완료 → 최종 숏츠 자동 합성 중…', error: '', lastOutput: session.render.lastOutput};
              saveSessionState();
              const renderWorkDir = path.join(session.dir, `render-${Date.now()}`);
              const outResult = await renderShortsVideo({
                assets: session.assets.filter(a => a.enabled !== false),
                facts: session.facts,
                options: session.options,
                bgmPath: session.bgm?.filePath || null,
                workDir: renderWorkDir,
                outputsDir,
                logoPath,
                onProgress: (stage, progress) => {
                  session.render.stage = stage;
                  session.render.progress = progress;
                  addLog(stage);
                },
              });
              session.render = {busy: false, progress: 100, stage: '원클릭 풀 자동 제작 완료!', error: '', lastOutput: outResult};
              addLog(`최종 숏츠 완성: ${outResult.filename}`);
              saveSessionState();
            }
          } else {
            saveSessionState();
          }
        } catch (err) {
          session.flow.busy = false;
          session.flow.status = 'error';
          session.flow.message = `원격 실행 오류: ${err.message}`;
          session.render.busy = false;
          addLog(`원격 Flow 오류: ${err.message}`);
          saveSessionState();
        }
      })();

      return sendJson(res, 202, await buildClientState());
    }

    if (req.method === 'POST' && url.pathname === '/api/flow/import-latest') {
      const imported = await importLatestFlowVideo(flowDownloadsDir, session.sourcesDir);
      const probe = await probeMedia(imported.filePath).catch(() => ({duration: 8, width: 1080, height: 1920}));
      const asset = {
        id: `flow-${Date.now()}`,
        kind: 'flow',
        mediaType: 'video',
        label: `Google Flow AI 영상 (${probe.duration || 8}초)`,
        filename: imported.filename,
        originalName: imported.originalName,
        filePath: imported.filePath,
        width: probe.width,
        height: probe.height,
        sourceDurationSec: probe.duration || 8,
        cutoutPath: null,
        cutoutWarning: '',
        useCutout: false,
        enabled: true,
        durationSec: Math.min(15, probe.duration || 8),
        trimStart: 0,
        trimEnd: Number(Math.min(15, probe.duration || 8).toFixed(1)),
      };
      session.assets.unshift(asset);
      addLog(`최신 Google Flow 영상을 불러왔습니다: ${imported.originalName} — 미리보기에서 원본 변형이 없는지 확인 후 제작해 주세요.`);
      return sendJson(res, 200, await buildClientState());
    }

    if (req.method === 'POST' && url.pathname === '/api/render') {
      if (session.render.busy) {
        return sendJson(res, 409, {error: '이미 영상을 제작 중입니다. 잠시만 기다려 주세요.'});
      }
      const body = await readJsonBody(req);
      if (body.options) session.options = {...session.options, ...body.options};
      if (body.facts) session.facts = {...session.facts, ...body.facts};

      const activeAssets = session.assets.filter(a => a.enabled !== false);
      if (!activeAssets.length) {
        throw new Error('영상에 넣을 사진 또는 동영상을 1개 이상 먼저 추가해 주세요.');
      }

      session.render = {busy: true, progress: 5, stage: '영상 제작 준비 중…', error: '', lastOutput: session.render.lastOutput};
      addLog('15~20초 스마트스토어 9:16 숏츠 자동 제작을 시작합니다.');

      const renderWorkDir = path.join(session.dir, `render-${Date.now()}`);
      renderShortsVideo({
        assets: activeAssets,
        facts: session.facts,
        options: session.options,
        bgmPath: session.bgm?.filePath || null,
        workDir: renderWorkDir,
        outputsDir,
        logoPath,
        onProgress: (stage, progress) => {
          session.render.stage = stage;
          session.render.progress = progress;
          addLog(stage);
        },
      }).then((result) => {
        session.render = {
          busy: false,
          progress: 100,
          stage: '제작 완료',
          error: '',
          lastOutput: result,
        };
        addLog(`완성 파일 저장됨: ${result.filename} (${result.durationSec}초 · ${(result.sizeBytes / (1024 * 1024)).toFixed(1)}MB)`);
      }).catch((err) => {
        session.render = {
          busy: false,
          progress: 0,
          stage: '제작 오류',
          error: err.message || '영상 제작에 실패했습니다.',
          lastOutput: session.render.lastOutput,
        };
        addLog(`오류: ${err.message}`);
      });

      return sendJson(res, 202, await buildClientState());
    }

    if (req.method === 'POST' && url.pathname === '/api/open-folder') {
      const body = await readJsonBody(req);
      const targetDir = body.target === 'flow-prep'
        ? session.flowPrepDir
        : body.target === 'cutouts'
          ? session.cutoutsDir
          : outputsDir;
      await mkdir(targetDir, {recursive: true});
      if (process.platform === 'win32') {
        const heroFile = body.target === 'flow-prep' && session.flow.preparedImages?.[0];
        const args = (heroFile && fs.existsSync(heroFile)) ? [`/select,${heroFile}`] : [targetDir];
        const child = spawn('explorer.exe', args, {detached: true, stdio: 'ignore'});
        child.on('error', () => {});
        child.unref();
      }
      addLog(`폴더를 열었습니다: ${targetDir}`);
      return sendJson(res, 200, {ok: true, path: targetDir});
    }

    if (req.method === 'POST' && url.pathname === '/api/reset') {
      if (session.render.busy) throw new Error('영상 제작 중에는 초기화할 수 없습니다.');
      stopFlowDownloadWatcher();
      session = createInitialSession();
      addLog('새 작업실이 열렸습니다. (이전에 완성한 영상은 outputs 폴더에 안전하게 보관됩니다.)');
      saveSessionState();
      return sendJson(res, 200, await buildClientState());
    }

    if (req.method === 'GET' && url.pathname.startsWith('/media/')) {
      const rel = url.pathname.slice('/media/'.length).split('/').map(decodeURIComponent).join(path.sep);
      const target = path.join(root, rel);
      const forceDownload = url.searchParams.get('download') === '1';
      return serveMediaFile(req, res, target, forceDownload);
    }

    if (req.method === 'GET') {
      const reqPath = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
      const fullPath = path.resolve(publicDir, reqPath);
      if (fullPath.startsWith(path.resolve(publicDir)) && fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        const content = await readFile(fullPath);
        res.writeHead(200, {
          'Content-Type': mimeForExt(path.extname(fullPath)),
          'Cache-Control': 'no-store',
        });
        return res.end(content);
      }
    }

    sendJson(res, 404, {error: '요청하신 경로를 찾을 수 없습니다.'});
  } catch (err) {
    sendJson(res, 400, {error: err.message || '요청 처리 중 오류가 발생했습니다.'});
  }
});

const requestedPort = Number(process.env.PORT || 4180);
server.listen(requestedPort, '127.0.0.1', () => {
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : requestedPort;
  const openUrl = `http://127.0.0.1:${actualPort}/`;
  console.log(`\n지오다노 숏츠등록기 실행됨: ${openUrl}`);
  if (process.env.NO_AUTO_OPEN !== '1' && process.platform === 'win32') {
    const child = spawn('cmd.exe', ['/c', 'start', '', openUrl], {windowsHide: true, stdio: 'ignore'});
    child.on('error', () => {});
  }
});

process.on('SIGINT', async () => {
  await closeFlowChrome();
  process.exit(0);
});
