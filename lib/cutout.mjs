import fs from 'node:fs';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import sharp from 'sharp';
import {findPythonRuntime} from './runtime.mjs';

const execFileAsync = promisify(execFile);

/**
 * Python rembg가 설치되어 있는 경우 정밀 딥러닝 AI 누끼를 실행한다.
 */
async function tryPythonRembg(inputPath, outputPath) {
  const py = findPythonRuntime();
  if (!py) return false;
  const code = `
import sys
from rembg import remove
with open(sys.argv[1], 'rb') as f:
    data = f.read()
out = remove(data)
with open(sys.argv[2], 'wb') as f:
    f.write(out)
`;
  try {
    await execFileAsync(py, ['-I', '-c', code, inputPath, outputPath], {timeout: 120000});
    return fs.existsSync(outputPath);
  } catch {
    return false;
  }
}

/**
 * 지오다노 공식몰 스튜디오 배경 전용 초고속 무손상 로컬 누끼 (추가 비용 0원 · 오프라인 동작).
 * - 4면 가장자리에서 배경 색상을 샘플링한 뒤 BFS Flood-Fill로 외부 배경만 정밀 분리한다.
 * - 옷 내부의 흰색/밝은 무늬가 구멍 뚫리지 않도록 "외부에서 연결된 배경"만 제거한다.
 * - 경계 픽셀은 부드러운 소프트 알파 페더링을 적용해 계단 현상을 최소화한다.
 * - 원본 파일은 절대 수정하지 않으며, 투명 PNG만 별도 저장한다.
 */
async function studioFloodFillCutout(inputPath, outputPath, options = {}) {
  const tolerance = Number(options.tolerance ?? 30);
  const softRange = Number(options.softRange ?? 16);

  const image = sharp(inputPath).rotate().ensureAlpha();
  const {data, info} = await image.raw().toBuffer({resolveWithObject: true});
  const {width, height, channels} = info;
  const total = width * height;

  // 1. 4개 코너 + 상단/좌우 가장자리에서 대표 배경색 추정 (중앙값 기반)
  const samplesR = [], samplesG = [], samplesB = [];
  const samplePoint = (x, y) => {
    const i = (y * width + x) * channels;
    samplesR.push(data[i]);
    samplesG.push(data[i + 1]);
    samplesB.push(data[i + 2]);
  };
  const stepX = Math.max(1, Math.floor(width / 24));
  const stepY = Math.max(1, Math.floor(height / 24));
  for (let x = 0; x < width; x += stepX) {
    samplePoint(x, 0);
    samplePoint(x, Math.min(2, height - 1));
  }
  for (let y = 0; y < height; y += stepY) {
    samplePoint(0, y);
    samplePoint(width - 1, y);
  }
  const median = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)] ?? 245;
  };
  const bgR = median(samplesR);
  const bgG = median(samplesG);
  const bgB = median(samplesB);

  const colorDist = (idx) => {
    const dr = data[idx] - bgR;
    const dg = data[idx + 1] - bgG;
    const db = data[idx + 2] - bgB;
    return Math.sqrt(dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11) * 1.732;
  };

  // 2. 가장자리에서 시작하는 외부 연결 BFS Flood-Fill
  const visited = new Uint8Array(total);
  const bgMask = new Uint8Array(total); // 1 = 확실한 배경, 2 = 경계 소프트 매팅 후보
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;

  const trySeed = (x, y) => {
    const pos = y * width + x;
    if (visited[pos]) return;
    const dist = colorDist(pos * channels);
    if (dist <= tolerance + 6) {
      visited[pos] = 1;
      bgMask[pos] = 1;
      queue[tail++] = pos;
    }
  };

  for (let x = 0; x < width; x++) {
    trySeed(x, 0);
    trySeed(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    trySeed(0, y);
    trySeed(width - 1, y);
  }

  const maxStepDiff = Math.max(14, tolerance * 0.72);
  while (head < tail) {
    const pos = queue[head++];
    const x = pos % width;
    const y = (pos - x) / width;
    const baseIdx = pos * channels;
    const br = data[baseIdx], bg = data[baseIdx + 1], bb = data[baseIdx + 2];

    const neighbors = [];
    if (x > 0) neighbors.push(pos - 1);
    if (x + 1 < width) neighbors.push(pos + 1);
    if (y > 0) neighbors.push(pos - width);
    if (y + 1 < height) neighbors.push(pos + width);

    for (const nPos of neighbors) {
      if (visited[nPos]) continue;
      const nIdx = nPos * channels;
      const distBg = colorDist(nIdx);
      const stepDiff = Math.abs(data[nIdx] - br) + Math.abs(data[nIdx + 1] - bg) + Math.abs(data[nIdx + 2] - bb);
      if (distBg <= tolerance && stepDiff <= maxStepDiff * 3) {
        visited[nPos] = 1;
        bgMask[nPos] = 1;
        queue[tail++] = nPos;
      } else if (distBg <= tolerance + softRange) {
        bgMask[nPos] = 2;
      }
    }
  }

  // 3. 알파 채널 구성 (원본 RGB 픽셀은 전혀 건드리지 않고 알파만 적용)
  const out = Buffer.from(data);
  let foregroundCount = 0;
  for (let pos = 0; pos < total; pos++) {
    const idx = pos * channels;
    if (bgMask[pos] === 1) {
      out[idx + 3] = 0;
    } else if (bgMask[pos] === 2) {
      const dist = colorDist(idx);
      const ratio = Math.min(1, Math.max(0, (dist - tolerance) / Math.max(1, softRange)));
      out[idx + 3] = Math.round(ratio * 255);
      if (ratio > 0.4) foregroundCount++;
    } else {
      foregroundCount++;
    }
  }

  // 4. 알파 채널 경계 1회 부드럽게 스무딩 (계단 제거)
  const alphaCopy = new Uint8Array(total);
  for (let i = 0; i < total; i++) alphaCopy[i] = out[i * channels + 3];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const p = y * width + x;
      const a = alphaCopy[p];
      if (a > 0 && a < 255) {
        const avg = (
          alphaCopy[p - 1] + alphaCopy[p + 1] +
          alphaCopy[p - width] + alphaCopy[p + width] +
          a * 2
        ) / 6;
        out[p * channels + 3] = Math.round(avg);
      }
    }
  }

  await sharp(out, {raw: {width, height, channels}}).png({compressionLevel: 6}).toFile(outputPath);

  const fgRatio = foregroundCount / Math.max(1, total);
  let warning = '';
  if (fgRatio < 0.08) {
    warning = '배경과 옷 색상이 매우 비슷해 일부가 지워졌을 수 있습니다. 원본과 비교 후 필요하면 [원본 사용]을 선택해 주세요.';
  } else if (fgRatio > 0.94) {
    warning = '배경이 단색 스튜디오가 아니어서 누끼가 적게 분리됐습니다. 원본 그대로 쓰시는 편이 자연스럽습니다.';
  }

  return {
    engine: 'studio-local',
    engineLabel: '로컬 스튜디오 정밀 누끼 (무료)',
    foregroundRatio: Number(fgRatio.toFixed(3)),
    warning,
  };
}

/**
 * 공식몰 사진 전용 로컬 누끼 실행기.
 * (절대 원칙: 매장 마네킨 샷에는 사용하지 않고, 원본 파일은 절대 건드리지 않는다.)
 */
export async function createOfficialCutout(inputPath, cutoutsDir, assetId, options = {}) {
  await mkdir(cutoutsDir, {recursive: true});
  const outputPath = path.join(cutoutsDir, `${assetId}-cutout.png`);

  const rembgDone = await tryPythonRembg(inputPath, outputPath);
  if (rembgDone) {
    return {
      cutoutPath: outputPath,
      engine: 'rembg-ai',
      engineLabel: '로컬 AI 누끼 (rembg · 무료)',
      foregroundRatio: null,
      warning: '',
    };
  }

  const result = await studioFloodFillCutout(inputPath, outputPath, options);
  return {
    cutoutPath: outputPath,
    ...result,
  };
}
