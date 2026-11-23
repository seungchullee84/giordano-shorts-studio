import fs from 'node:fs';
import {readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function findFFmpegTools() {
  const candidates = [];
  const localPrograms = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'FFmpeg');
  if (fs.existsSync(localPrograms)) {
    try {
      for (const entry of fs.readdirSync(localPrograms, {withFileTypes: true})) {
        if (entry.isDirectory() && entry.name.toLowerCase().startsWith('ffmpeg')) {
          candidates.push(path.join(localPrograms, entry.name, 'bin'));
        }
      }
    } catch {}
  }
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  candidates.push(...pathDirs);

  for (const dir of candidates) {
    const ffmpeg = path.join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    const ffprobe = path.join(dir, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    if (fs.existsSync(ffmpeg) && fs.existsSync(ffprobe)) {
      return {ffmpeg, ffprobe, available: true};
    }
  }
  return {ffmpeg: null, ffprobe: null, available: false};
}

export function findSystemChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);
  for (const exe of candidates) {
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

export function findRegistrarDataDir() {
  const home = os.homedir();
  const candidates = [
    process.env.REGISTRAR_DATA_DIR,
    path.join(home, 'OneDrive', 'Desktop', 'lotteon-smartstore-v36-main', 'data'),
    path.join(home, 'Desktop', 'lotteon-smartstore-v36-main', 'data'),
    path.join(home, '.gemini', 'antigravity', 'scratch', 'lotteon-smartstore-v36', 'data'),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

export function findDesktopPhotoRoot() {
  const home = os.homedir();
  const candidates = [
    process.env.REGISTRAR_PHOTO_DIR,
    path.join(home, 'OneDrive', 'Desktop', '상품등록기사진폴더'),
    path.join(home, 'Desktop', '상품등록기사진폴더'),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

export function findDesktopVideoRoot() {
  const home = os.homedir();
  const candidates = [
    process.env.REGISTRAR_VIDEO_DIR,
    path.join(home, 'OneDrive', 'Desktop', '상품영상'),
    path.join(home, 'Desktop', '상품영상'),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

export function findSellingPointResearchRoot() {
  const home = os.homedir();
  const candidates = [
    process.env.REGISTRAR_RESEARCH_DIR,
    path.join(home, 'OneDrive', 'Desktop', '지오다노소구점자료', 'auto-new-products'),
    path.join(home, 'Desktop', '지오다노소구점자료', 'auto-new-products'),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

export function findPythonRuntime() {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe'),
    ...((process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, 'python.exe'))),
  ];
  for (const exe of candidates) {
    if (fs.existsSync(exe) && !exe.toLowerCase().includes('windowsapps')) {
      return exe;
    }
  }
  return null;
}

export async function listRegistrarStyles(limit = 20) {
  const dataDir = findRegistrarDataDir();
  if (!dataDir) return [];
  try {
    const entries = await readdir(dataDir, {withFileTypes: true});
    const matched = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const m = entry.name.match(/^(\d{6})-(.+)$/);
      if (!m) continue;
      const folderPath = path.join(dataDir, entry.name);
      if (!fs.existsSync(path.join(folderPath, 'product.json'))) continue;
      matched.push({style: m[1], folderName: entry.name, folderPath, stamp: m[2]});
    }
    matched.sort((a, b) => b.stamp.localeCompare(a.stamp));
    const seen = new Set();
    const recent = [];
    for (const item of matched) {
      if (seen.has(item.style)) continue;
      seen.add(item.style);
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(item.folderPath, 'product.json'), 'utf8'));
        recent.push({
          style: item.style,
          name: raw.rawName || raw.name || item.style,
          material: raw.material || '',
          colorCount: Array.isArray(raw.colors) ? raw.colors.length : 0,
        });
      } catch {
        recent.push({style: item.style, name: item.style, material: '', colorCount: 0});
      }
      if (recent.length >= limit) break;
    }
    return recent;
  } catch {
    return [];
  }
}

export function getEnvironmentStatus() {
  const ff = findFFmpegTools();
  const chrome = findSystemChrome();
  const registrarDataDir = findRegistrarDataDir();
  const photoRoot = findDesktopPhotoRoot();
  const videoRoot = findDesktopVideoRoot();
  const python = findPythonRuntime();
  return {
    ffmpeg: ff.available,
    ffmpegPath: ff.ffmpeg,
    chrome: Boolean(chrome),
    chromePath: chrome,
    registrarLinked: Boolean(registrarDataDir),
    registrarDataDir,
    photoFolderLinked: Boolean(photoRoot),
    photoRoot,
    videoFolderLinked: Boolean(videoRoot),
    videoRoot,
    python: Boolean(python),
  };
}
