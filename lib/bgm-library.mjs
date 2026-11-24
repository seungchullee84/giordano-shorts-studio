import fs from 'node:fs';
import {mkdir, readdir, stat, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {findDesktopBaseDir} from './storage-sync.mjs';

const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg']);

export function getDesktopBgmDir() {
  return path.join(findDesktopBaseDir(), '숏츠BGM');
}

export function getInternalBgmDir(dataDir) {
  return path.join(dataDir, 'bgm-library');
}

export async function ensureDesktopBgmDir() {
  const dir = getDesktopBgmDir();
  await mkdir(dir, {recursive: true}).catch(() => {});
  return dir;
}

function makeCustomTrackId(filePath) {
  const h = createHash('sha1').update(path.resolve(filePath).toLowerCase()).digest('hex').slice(0, 12);
  return `custom:${h}`;
}

function formatTrackLabel(filename, source) {
  const base = path.basename(filename, path.extname(filename)).replace(/[_]+/g, ' ').trim();
  const badge = source === 'desktop' ? '내 음악' : '보관함';
  return `💿 [${badge}] ${base}`;
}

/**
 * 바탕화면 [숏츠BGM] 폴더 및 내부 [data/bgm-library] 폴더의 사용자 MP3/WAV 음악 목록을 읽어 반환한다.
 */
export async function listCustomBgmTracks(dataDir) {
  const dirs = [
    {dir: getDesktopBgmDir(), source: 'desktop'},
    {dir: getInternalBgmDir(dataDir), source: 'internal'},
  ];
  const tracks = [];
  const seenNames = new Set();

  for (const {dir, source} of dirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    try {
      const entries = await readdir(dir, {withFileTypes: true});
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!AUDIO_EXTS.has(ext)) continue;
        const keyLower = entry.name.toLowerCase();
        if (seenNames.has(keyLower)) continue;
        seenNames.add(keyLower);

        const fullPath = path.join(dir, entry.name);
        const st = await stat(fullPath).catch(() => null);
        if (!st || st.size < 1024) continue;
        tracks.push({
          id: makeCustomTrackId(fullPath),
          filename: entry.name,
          label: formatTrackLabel(entry.name, source),
          filePath: fullPath,
          sizeBytes: st.size,
          source,
          updatedAt: st.mtime.toISOString(),
        });
      }
    } catch {}
  }

  tracks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return tracks;
}

export async function resolveCustomBgmTrack(trackId, dataDir) {
  if (!trackId || !String(trackId).startsWith('custom:')) return null;
  const list = await listCustomBgmTracks(dataDir);
  return list.find(t => t.id === trackId) || null;
}

/**
 * 사용자가 화면에서 추가한 MP3/WAV 파일을 바탕화면 [숏츠BGM] 폴더에 안전하게 복사 보관한다.
 */
export async function saveCustomBgmBuffer(buf, originalName, dataDir) {
  const ext = path.extname(String(originalName || '')).toLowerCase();
  if (!AUDIO_EXTS.has(ext)) {
    throw new Error('MP3, WAV, M4A, AAC, OGG 오디오 파일만 추가할 수 있습니다.');
  }
  const safeBase = path.basename(String(originalName || 'bgm'), ext)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || `내배경음악_${Date.now()}`;

  let targetDir = getDesktopBgmDir();
  try {
    await mkdir(targetDir, {recursive: true});
  } catch {
    targetDir = getInternalBgmDir(dataDir);
    await mkdir(targetDir, {recursive: true});
  }

  let destPath = path.join(targetDir, `${safeBase}${ext}`);
  if (fs.existsSync(destPath)) {
    destPath = path.join(targetDir, `${safeBase}_${Date.now().toString().slice(-4)}${ext}`);
  }
  await writeFile(destPath, buf);
  const st = await stat(destPath);
  const filename = path.basename(destPath);
  const source = targetDir === getDesktopBgmDir() ? 'desktop' : 'internal';
  return {
    id: makeCustomTrackId(destPath),
    filename,
    label: formatTrackLabel(filename, source),
    filePath: destPath,
    sizeBytes: st.size,
    source,
    updatedAt: st.mtime.toISOString(),
  };
}
