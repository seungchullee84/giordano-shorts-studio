import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

export const BUILTIN_BGM_PRESETS = {
  'lounge-pad': {
    id: 'lounge-pad',
    label: '쇼룸 라운지 앰비언트 (따뜻한 백화점 무드 · 기본)',
  },
  'minimal-piano': {
    id: 'minimal-piano',
    label: '모던 피아노 미니멀 코드 (감성 화보 무드)',
  },
  'city-chill': {
    id: 'city-chill',
    label: '도심 칠아웃 리듬 비트 (세련된 숏츠 리듬)',
  },
  'none': {
    id: 'none',
    label: '무음 (내장 BGM 사용 안 함)',
  },
};

function midiToFreq(midi) {
  return 440 * (2 ** ((midi - 69) / 12));
}

function encodeWavStereo16(left, right, sampleRate = 48000) {
  const numFrames = left.length;
  const dataSize = numFrames * 4;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(2, 22); // Stereo
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    const l = Math.max(-0.98, Math.min(0.98, left[i]));
    const r = Math.max(-0.98, Math.min(0.98, right[i]));
    buf.writeInt16LE(Math.round(l * 32767), offset);
    buf.writeInt16LE(Math.round(r * 32767), offset + 2);
    offset += 4;
  }
  return buf;
}

/**
 * 저작권 걱정 없는 백화점 패션 쇼룸 전용 고음질 BGM WAV를 로컬에서 즉시 합성한다.
 * - 부드러운 재즈/로파이 코드 진행(Fmaj9 -> Em7 -> Dm9 -> Cmaj9)과 따뜻한 하모닉스 사용
 */
export async function generateBuiltinBgmWav(presetId, outPath, durationSec = 24) {
  if (!presetId || presetId === 'none') return null;
  await mkdir(path.dirname(outPath), {recursive: true});

  const sr = 48000;
  const dur = Math.max(8, Math.min(40, Number(durationSec) || 24));
  const totalFrames = Math.floor(sr * dur);
  const left = new Float32Array(totalFrames);
  const right = new Float32Array(totalFrames);

  // 따뜻한 패션 룩북 4마디 코드 진행 (MIDI 음정)
  const chords = [
    [53, 60, 64, 67, 69], // Fmaj9
    [52, 59, 62, 67, 71], // Em7
    [50, 57, 60, 64, 69], // Dm9
    [48, 55, 59, 62, 67], // Cmaj9
  ];
  const barSec = presetId === 'city-chill' ? 2.4 : 3.0;

  for (let i = 0; i < totalFrames; i++) {
    const t = i / sr;
    const barIdx = Math.floor(t / barSec) % chords.length;
    const barPos = (t % barSec) / barSec; // 0..1
    const barTime = t % barSec;
    const chord = chords[barIdx];

    let sigL = 0;
    let sigR = 0;

    if (presetId === 'lounge-pad') {
      // 1. 쇼룸 라운지 앰비언트: 따뜻한 아날로그 패드 + 은은한 탑 노트
      const env = Math.sin(Math.PI * Math.min(1, barPos)) ** 0.55;
      const shimmer = 0.85 + 0.15 * Math.sin(2 * Math.PI * 0.45 * t);
      for (let n = 0; n < chord.length; n++) {
        const f = midiToFreq(chord[n]);
        const detuneL = Math.sin(2 * Math.PI * (f * 0.9985) * t);
        const detuneR = Math.sin(2 * Math.PI * (f * 1.0015) * t);
        const overtone = 0.22 * Math.sin(2 * Math.PI * (f * 2) * t);
        const weight = n === 0 ? 0.16 : 0.085;
        sigL += (detuneL + overtone) * weight * env * shimmer;
        sigR += (detuneR + overtone) * weight * env * shimmer;
      }
      // 1.5초마다 은은한 일렉트릭 벨 포인트
      const bellPhase = t % 1.5;
      const bellEnv = Math.exp(-bellPhase * 3.8);
      const bellFreq = midiToFreq(chord[(Math.floor(t / 1.5) % 3) + 2] + 12);
      const bell = Math.sin(2 * Math.PI * bellFreq * t) * bellEnv * 0.055;
      sigL += bell * 0.8;
      sigR += bell * 1.1;
    } else if (presetId === 'minimal-piano') {
      // 2. 모던 피아노 미니멀 코드: 맑은 일렉트릭 피아노 아르페지오 + 부드러운 베이스
      const baseFreq = midiToFreq(chord[0]);
      const baseEnv = Math.exp(-barTime * 1.25);
      const bass = (Math.sin(2 * Math.PI * baseFreq * t) + 0.25 * Math.sin(4 * Math.PI * baseFreq * t)) * baseEnv * 0.19;
      sigL += bass;
      sigR += bass;

      const stepSec = barSec / 6;
      const stepIdx = Math.floor(barTime / stepSec);
      const stepTime = barTime % stepSec;
      const noteOrder = [1, 2, 3, 4, 3, 2];
      const noteMidi = chord[noteOrder[stepIdx % noteOrder.length]] + (stepIdx >= 4 ? 12 : 0);
      const nf = midiToFreq(noteMidi);
      const pEnv = Math.min(1, stepTime / 0.015) * Math.exp(-stepTime * 3.2);
      const ep = (
        Math.sin(2 * Math.PI * nf * t)
        + 0.30 * Math.sin(2 * Math.PI * nf * 2 * t) * Math.exp(-stepTime * 5)
        + 0.10 * Math.sin(2 * Math.PI * nf * 3 * t) * Math.exp(-stepTime * 8)
      ) * pEnv * 0.16;
      const pan = (stepIdx % 2 === 0) ? 0.65 : 1.15;
      sigL += ep * pan;
      sigR += ep * (1.8 - pan);

      // 뒷배경 아주 옅은 에어 패드
      const padF = midiToFreq(chord[2]);
      const pad = Math.sin(2 * Math.PI * padF * t) * 0.045;
      sigL += pad;
      sigR += pad;
    } else {
      // 3. 도심 칠아웃 리듬 비트: 부드러운 딥 킥 + 하이햇 펄스 + 웜 코드
      const beatSec = barSec / 4; // 약 100 BPM
      const beatIdx = Math.floor(barTime / beatSec);
      const beatTime = barTime % beatSec;

      // 소프트 딥 킥 (1박, 3박)
      if (beatIdx === 0 || beatIdx === 2) {
        const kickPitch = 52 + 78 * Math.exp(-beatTime * 34);
        const kickEnv = Math.exp(-beatTime * 11);
        const kick = Math.sin(2 * Math.PI * kickPitch * beatTime) * kickEnv * 0.22;
        sigL += kick;
        sigR += kick;
      }

      // 부드러운 로파이 스냅/쉐이커 (2박, 4박)
      if (beatIdx === 1 || beatIdx === 3) {
        const snapEnv = Math.exp(-beatTime * 28);
        const noise = Math.sin(i * 12.9898) * 43758.5453;
        const frac = (noise - Math.floor(noise)) * 2 - 1;
        const snap = frac * snapEnv * 0.055;
        sigL += snap * 0.9;
        sigR += snap * 1.1;
      }

      // 웜 로즈 코드
      const chordEnv = Math.min(1, barTime / 0.04) * Math.exp(-barTime * 0.85);
      for (let n = 0; n < chord.length; n++) {
        const f = midiToFreq(chord[n]);
        const w = n === 0 ? 0.13 : 0.075;
        const tone = Math.sin(2 * Math.PI * f * t) + 0.18 * Math.sin(4 * Math.PI * f * t);
        sigL += tone * w * chordEnv * (n % 2 === 0 ? 1.05 : 0.92);
        sigR += tone * w * chordEnv * (n % 2 === 0 ? 0.92 : 1.05);
      }
    }

    // 전체 시작/끝 부드러운 페이드 처리
    const fadeIn = Math.min(1, t / 0.6);
    const fadeOut = Math.min(1, Math.max(0, (dur - t) / 1.0));
    const master = fadeIn * fadeOut;

    left[i] = Math.tanh(sigL * master * 1.65);
    right[i] = Math.tanh(sigR * master * 1.65);
  }

  // 유튜브 쇼츠 표준 음량(-1.5 dBFS 피크 정규화)으로 자동 마스터링하여 항상 또렷하게 들리도록 보장
  let peak = 0.001;
  for (let i = 0; i < totalFrames; i++) {
    const aL = Math.abs(left[i]);
    const aR = Math.abs(right[i]);
    if (aL > peak) peak = aL;
    if (aR > peak) peak = aR;
  }
  const gain = 0.86 / peak;
  for (let i = 0; i < totalFrames; i++) {
    left[i] = Math.max(-0.96, Math.min(0.96, left[i] * gain));
    right[i] = Math.max(-0.96, Math.min(0.96, right[i] * gain));
  }

  const wav = encodeWavStereo16(left, right, sr);
  await writeFile(outPath, wav);
  return outPath;
}
