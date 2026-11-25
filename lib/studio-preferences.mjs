import fs from 'node:fs';
import path from 'node:path';
import {FRAME_LAYOUT_KEYS, normalizeVideoSpeed} from './video-renderer.mjs';

export const STUDIO_PREFS_FILENAME = 'studio-preferences.json';

export const STUDIO_PREFS_DEFAULTS = Object.freeze({
  frameLayout: 'white-studio',
  videoSpeed: 1.2,
});

export function normalizeFrameLayout(raw, fallback = STUDIO_PREFS_DEFAULTS.frameLayout) {
  const key = String(raw || '').trim();
  return FRAME_LAYOUT_KEYS.includes(key) ? key : fallback;
}

export function loadStudioPreferencesSync(dataDir) {
  const filePath = path.join(dataDir, STUDIO_PREFS_FILENAME);
  try {
    if (!fs.existsSync(filePath)) {
      return {...STUDIO_PREFS_DEFAULTS};
    }
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      frameLayout: normalizeFrameLayout(raw?.frameLayout, STUDIO_PREFS_DEFAULTS.frameLayout),
      videoSpeed: normalizeVideoSpeed(raw?.videoSpeed ?? STUDIO_PREFS_DEFAULTS.videoSpeed),
      updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : '',
    };
  } catch {
    return {...STUDIO_PREFS_DEFAULTS};
  }
}

export function saveStudioPreferencesSync(dataDir, patch = {}) {
  const current = loadStudioPreferencesSync(dataDir);
  const next = {
    frameLayout: patch.frameLayout !== undefined
      ? normalizeFrameLayout(patch.frameLayout, current.frameLayout)
      : current.frameLayout,
    videoSpeed: patch.videoSpeed !== undefined
      ? normalizeVideoSpeed(patch.videoSpeed)
      : current.videoSpeed,
    updatedAt: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(dataDir, {recursive: true});
    const filePath = path.join(dataDir, STUDIO_PREFS_FILENAME);
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch {}
  return next;
}

/**
 * 모든 영상 제작 경로(직접 제작 · 사진 전용 · 원클릭 Flow 자동 합성 · 다운로드 감시)가
 * 항상 영구 저장된 화이트/블랙 프레임·1.2배속·상의/하의 포커스를 동일하게 적용하도록 통합 정규화한다.
 */
export function resolveEffectiveRenderOptions(sessionOptions = {}, flowState = {}, dataDir = '') {
  const prefs = dataDir ? loadStudioPreferencesSync(dataDir) : {...STUDIO_PREFS_DEFAULTS};
  const frameLayout = normalizeFrameLayout(sessionOptions?.frameLayout, prefs.frameLayout);
  const videoSpeed = normalizeVideoSpeed(sessionOptions?.videoSpeed ?? prefs.videoSpeed);
  const flowCat = String(flowState?.garmentCategory || '').trim();
  const garmentCategory = ['top', 'outer', 'bottom'].includes(flowCat)
    ? flowCat
    : (['top', 'outer', 'bottom'].includes(sessionOptions?.garmentCategory) ? sessionOptions.garmentCategory : undefined);

  return {
    ...sessionOptions,
    frameLayout,
    videoSpeed,
    ...(garmentCategory ? {garmentCategory} : {}),
  };
}
