import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

export const BUILTIN_BGM_PRESETS = {
  'lounge-pad': {
    id: 'lounge-pad',
    label: '🎵 쇼룸 라운지 앰비언트 (따뜻한 백화점 · 기본)',
  },
  'runway-house': {
    id: 'runway-house',
    label: '🔥 런웨이 딥 하우스 122 BPM (역동적 패션 CF)',
  },
  'acoustic-cafe': {
    id: 'acoustic-cafe',
    label: '🎸 어쿠스틱 카페 기타 (포근한 데일리룩)',
  },
  'sunset-lofi': {
    id: 'sunset-lofi',
    label: '☕ 선셋 로파이 재즈 92 BPM (감성 룩북)',
  },
  'citypop-funk': {
    id: 'citypop-funk',
    label: '✨ 트렌디 시티팝 바운스 116 BPM (컬러 캐주얼)',
  },
  'luxury-strings': {
    id: 'luxury-strings',
    label: '🎻 럭셔리 스트링 시네마 (프리미엄 코트·니트)',
  },
  'minimal-piano': {
    id: 'minimal-piano',
    label: '🎹 모던 피아노 미니멀 코드 (감성 화보)',
  },
  'city-chill': {
    id: 'city-chill',
    label: '🎧 도심 칠아웃 리듬 비트 (세련된 숏츠)',
  },
  'none': {
    id: 'none',
    label: '🔇 무음 (배경 음악 사용 안 함)',
  },
};

function midiToFreq(midi) {
  return 440 * (2 ** ((midi - 69) / 12));
}

function pseudoNoise(i) {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
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
 * 저작권 걱정 없는 백화점 패션 쇼룸·릴스 전용 고음질 BGM WAV(8종)를 로컬에서 즉시 합성한다.
 */
export async function generateBuiltinBgmWav(presetId, outPath, durationSec = 24) {
  if (!presetId || presetId === 'none') return null;
  const key = BUILTIN_BGM_PRESETS[presetId] ? presetId : 'lounge-pad';
  await mkdir(path.dirname(outPath), {recursive: true});

  const sr = 48000;
  const dur = Math.max(8, Math.min(45, Number(durationSec) || 24));
  const totalFrames = Math.floor(sr * dur);
  const left = new Float32Array(totalFrames);
  const right = new Float32Array(totalFrames);

  // 따뜻한 패션 룩북 4마디 코드 진행 (Fmaj9 -> Em7 -> Dm9 -> Cmaj9)
  const warmChords = [
    [53, 60, 64, 67, 69],
    [52, 59, 62, 67, 71],
    [50, 57, 60, 64, 69],
    [48, 55, 59, 62, 67],
  ];
  // 세련된 런웨이 하우스 마이너 9th 진행 (Am9 -> Fmaj9 -> Dm9 -> Em7)
  const houseChords = [
    [45, 57, 60, 64, 71],
    [41, 53, 57, 60, 67],
    [38, 50, 53, 57, 64],
    [40, 52, 55, 59, 62],
  ];
  // 경쾌한 시티팝 펑크 진행 (Fmaj7 -> G6 -> Em7 -> Am9)
  const citypopChords = [
    [53, 60, 64, 69, 72],
    [55, 62, 67, 71, 74],
    [52, 59, 64, 67, 71],
    [57, 64, 67, 71, 76],
  ];
  // 럭셔리 스트링 시네마 진행 (Cmaj9 -> Am9 -> Fmaj9 -> Gsus4)
  const stringChords = [
    [48, 60, 64, 67, 74],
    [45, 57, 60, 64, 71],
    [41, 53, 57, 60, 67],
    [43, 55, 60, 62, 67],
  ];

  const barSecMap = {
    'lounge-pad': 3.0,
    'minimal-piano': 3.0,
    'city-chill': 2.4,
    'runway-house': 60 / 122 * 4, // 122 BPM 4박
    'acoustic-cafe': 2.8,
    'sunset-lofi': 60 / 92 * 4,   // 92 BPM 4박
    'citypop-funk': 60 / 116 * 4, // 116 BPM 4박
    'luxury-strings': 3.4,
  };
  const barSec = barSecMap[key] || 3.0;

  for (let i = 0; i < totalFrames; i++) {
    const t = i / sr;
    const chords = key === 'runway-house'
      ? houseChords
      : key === 'citypop-funk'
        ? citypopChords
        : key === 'luxury-strings'
          ? stringChords
          : warmChords;
    const barIdx = Math.floor(t / barSec) % chords.length;
    const barPos = (t % barSec) / barSec; // 0..1
    const barTime = t % barSec;
    const chord = chords[barIdx];

    let sigL = 0;
    let sigR = 0;

    if (key === 'lounge-pad') {
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
      const bellPhase = t % 1.5;
      const bellEnv = Math.exp(-bellPhase * 3.8);
      const bellFreq = midiToFreq(chord[(Math.floor(t / 1.5) % 3) + 2] + 12);
      const bell = Math.sin(2 * Math.PI * bellFreq * t) * bellEnv * 0.055;
      sigL += bell * 0.8;
      sigR += bell * 1.1;
    } else if (key === 'runway-house') {
      // 🔥 122 BPM 런웨이 딥 하우스: 4비트 펀치 킥 + 오프비트 햇 + 클랩 + 사이드체인 딥 베이스 + 세련된 신스 스탭
      const beatSec = barSec / 4;
      const beatIdx = Math.floor(barTime / beatSec);
      const beatTime = barTime % beatSec;
      const eighthIdx = Math.floor(barTime / (beatSec / 2));
      const eighthTime = barTime % (beatSec / 2);

      // 4-on-the-floor 딥 펀치 킥
      const kickPitch = 46 + 110 * Math.exp(-beatTime * 42);
      const kickEnv = Math.exp(-beatTime * 13);
      const kick = Math.sin(2 * Math.PI * kickPitch * beatTime) * kickEnv * 0.30;
      sigL += kick;
      sigR += kick;

      // 2박·4박 세련된 클랩
      if (beatIdx === 1 || beatIdx === 3) {
        const clapEnv = Math.exp(-beatTime * 26) * (1 + 0.35 * Math.exp(-Math.abs(beatTime - 0.012) * 180));
        const clap = pseudoNoise(i) * clapEnv * 0.085;
        sigL += clap * 0.92;
        sigR += clap * 1.08;
      }

      // 오프비트 하이햇 (짝수 아닌 8분음표)
      if (eighthIdx % 2 === 1) {
        const hatEnv = Math.exp(-eighthTime * 38);
        const hat = (pseudoNoise(i) - pseudoNoise(i - 1) * 0.65) * hatEnv * 0.055;
        sigL += hat * 1.12;
        sigR += hat * 0.88;
      }

      // 사이드체인 펌핑 딥 베이스
      const duck = 1 - 0.72 * Math.exp(-beatTime * 14);
      const bassStep = Math.floor(barTime / (beatSec / 2)) % 8;
      const bassSemi = (bassStep === 3 || bassStep === 7) ? chord[0] + 7 : chord[0];
      const bf = midiToFreq(bassSemi);
      const bassTone = (Math.sin(2 * Math.PI * bf * t) + 0.38 * Math.sin(4 * Math.PI * bf * t)) * duck * 0.21;
      sigL += bassTone;
      sigR += bassTone;

      // 싱코페이션 딥 하우스 코드 스탭 (1박, 2.5박, 4박)
      const stabTimes = [0, beatSec * 1.5, beatSec * 3.0];
      for (const st of stabTimes) {
        const dt = barTime - st;
        if (dt >= 0 && dt < 0.45) {
          const sEnv = Math.min(1, dt / 0.008) * Math.exp(-dt * 6.5) * duck;
          for (let n = 1; n < chord.length; n++) {
            const f = midiToFreq(chord[n]);
            const vL = Math.sin(2 * Math.PI * f * 0.998 * t) + 0.28 * Math.sin(4 * Math.PI * f * t);
            const vR = Math.sin(2 * Math.PI * f * 1.002 * t) + 0.28 * Math.sin(4 * Math.PI * f * t);
            sigL += vL * sEnv * 0.055;
            sigR += vR * sEnv * 0.055;
          }
        }
      }
    } else if (key === 'acoustic-cafe') {
      // 🎸 어쿠스틱 카페 기타: 따뜻한 나일론 기타 아르페지오 + 어쿠스틱 베이스 + 핑거 쉐이커
      const stepSec = barSec / 8;
      const stepIdx = Math.floor(barTime / stepSec);
      const stepTime = barTime % stepSec;

      // 따뜻한 우드 베이스 (1박, 5박)
      const bassTime = barTime % (barSec / 2);
      const bassMidi = (barTime >= barSec / 2) ? chord[0] + 7 : chord[0];
      const bf = midiToFreq(bassMidi);
      const bEnv = Math.min(1, bassTime / 0.012) * Math.exp(-bassTime * 2.2);
      const bass = (Math.sin(2 * Math.PI * bf * t) + 0.22 * Math.sin(4 * Math.PI * bf * t)) * bEnv * 0.18;
      sigL += bass;
      sigR += bass;

      // 나일론 기타 핑거피킹 (겹쳐 울리는 잔향 효과로 2개 이전 음까지 누적)
      const pattern = [0, 1, 2, 4, 3, 2, 1, 3];
      for (let lookback = 0; lookback <= 2; lookback++) {
        const idx = stepIdx - lookback;
        if (idx < 0) continue;
        const dt = stepTime + lookback * stepSec;
        const noteMidi = chord[pattern[idx % pattern.length]] + (idx % 4 === 3 ? 12 : 0);
        const nf = midiToFreq(noteMidi);
        const gEnv = Math.min(1, dt / 0.005) * Math.exp(-dt * 2.9);
        const pluck = (
          Math.sin(2 * Math.PI * nf * t)
          + 0.42 * Math.sin(2 * Math.PI * nf * 2 * t) * Math.exp(-dt * 4.5)
          + 0.18 * Math.sin(2 * Math.PI * nf * 3 * t) * Math.exp(-dt * 8.0)
          + 0.07 * Math.sin(2 * Math.PI * nf * 4 * t) * Math.exp(-dt * 12.0)
        ) * gEnv * 0.11;
        const pan = (idx % 2 === 0) ? 0.78 : 1.18;
        sigL += pluck * pan;
        sigR += pluck * (1.96 - pan);
      }

      // 부드러운 어쿠스틱 쉐이커 (8분음표)
      const shEnv = Math.exp(-stepTime * 34);
      const sh = (pseudoNoise(i) - pseudoNoise(i - 1) * 0.5) * shEnv * (stepIdx % 2 === 1 ? 0.032 : 0.016);
      sigL += sh * 1.15;
      sigR += sh * 0.85;
    } else if (key === 'sunset-lofi') {
      // ☕ 92 BPM 선셋 로파이 재즈: 따뜻한 로즈 코드 + 스윙 비트 + 부드러운 멜로디
      const beatSec = barSec / 4;
      const beatIdx = Math.floor(barTime / beatSec);
      const beatTime = barTime % beatSec;

      // 로파이 킥 (1박 + 3.5박 싱코페이션)
      const isKick1 = beatIdx === 0;
      const isKick2 = beatIdx === 2 && beatTime >= beatSec * 0.52;
      if (isKick1) {
        const kp = 48 + 68 * Math.exp(-beatTime * 30);
        const k = Math.sin(2 * Math.PI * kp * beatTime) * Math.exp(-beatTime * 9.5) * 0.24;
        sigL += k; sigR += k;
      }
      if (isKick2) {
        const dt = beatTime - beatSec * 0.52;
        const kp = 48 + 64 * Math.exp(-dt * 30);
        const k = Math.sin(2 * Math.PI * kp * dt) * Math.exp(-dt * 10.5) * 0.20;
        sigL += k; sigR += k;
      }

      // 2박·4박 브러시 스네어
      if (beatIdx === 1 || beatIdx === 3) {
        const snEnv = Math.exp(-beatTime * 20);
        const sn = (pseudoNoise(i) * 0.7 + Math.sin(2 * Math.PI * 190 * beatTime) * 0.3) * snEnv * 0.085;
        sigL += sn * 0.94;
        sigR += sn * 1.06;
      }

      // 웜 일렉트릭 로즈 패드 (미세 비브라토)
      const vibrato = 1 + 0.0022 * Math.sin(2 * Math.PI * 4.2 * t);
      const cEnv = Math.min(1, barTime / 0.035) * Math.exp(-barTime * 0.62);
      for (let n = 0; n < chord.length; n++) {
        const f = midiToFreq(chord[n]) * vibrato;
        const w = n === 0 ? 0.14 : 0.075;
        const rhodes = (Math.sin(2 * Math.PI * f * t) + 0.16 * Math.sin(4 * Math.PI * f * t) * Math.exp(-barTime * 2.5)) * w * cEnv;
        sigL += rhodes * (n % 2 === 0 ? 1.08 : 0.92);
        sigR += rhodes * (n % 2 === 0 ? 0.92 : 1.08);
      }

      // 감성 탑 벨 멜로디 (2박마다)
      const melTime = barTime % (beatSec * 2);
      const melIdx = Math.floor(t / (beatSec * 2));
      const melFreq = midiToFreq(chord[2 + (melIdx % 3)] + 12);
      const mel = Math.sin(2 * Math.PI * melFreq * t) * Math.exp(-melTime * 2.6) * 0.055;
      sigL += mel * 0.82;
      sigR += mel * 1.18;
    } else if (key === 'citypop-funk') {
      // ✨ 116 BPM 트렌디 시티팝 바운스: 펑키 신스 베이스 + 밝은 플럭 + 찰랑이는 디스코 햇
      const beatSec = barSec / 4;
      const beatIdx = Math.floor(barTime / beatSec);
      const beatTime = barTime % beatSec;
      const sixteenthSec = beatSec / 4;
      const step16 = Math.floor(barTime / sixteenthSec);
      const step16Time = barTime % sixteenthSec;

      // 타이트한 팝 킥 (1박, 3박) + 클랩 (2박, 4박)
      if (beatIdx === 0 || beatIdx === 2) {
        const kp = 54 + 92 * Math.exp(-beatTime * 44);
        const k = Math.sin(2 * Math.PI * kp * beatTime) * Math.exp(-beatTime * 14) * 0.25;
        sigL += k; sigR += k;
      } else {
        const cEnv = Math.exp(-beatTime * 30);
        const cl = pseudoNoise(i) * cEnv * 0.075;
        sigL += cl * 0.95; sigR += cl * 1.05;
      }

      // 16비트 디스코 하이햇
      if (step16 % 2 === 0) {
        const hEnv = Math.exp(-step16Time * 48);
        const h = (pseudoNoise(i) - pseudoNoise(i - 1) * 0.7) * hEnv * (step16 % 4 === 2 ? 0.045 : 0.022);
        sigL += h * 1.1; sigR += h * 0.9;
      }

      // 펑키 옥타브 바운스 신스 베이스
      const bassPattern = [0, -1, 12, 0, -1, 7, 12, -1, 0, -1, 12, 7, 0, -1, 10, 12];
      const offsetSemi = bassPattern[step16 % 16];
      if (offsetSemi >= 0) {
        const bf = midiToFreq(chord[0] - 12 + offsetSemi);
        const bEnv = Math.min(1, step16Time / 0.005) * Math.exp(-step16Time * 11);
        const bSig = (Math.sin(2 * Math.PI * bf * t) + 0.45 * Math.sin(4 * Math.PI * bf * t) + 0.18 * Math.sin(6 * Math.PI * bf * t)) * bEnv * 0.19;
        sigL += bSig; sigR += bSig;
      }

      // 밝은 시티팝 브라이트 코드 플럭 (1, 4, 7, 11, 14번 16분음표)
      if (step16 === 0 || step16 === 3 || step16 === 6 || step16 === 10 || step16 === 13) {
        const pEnv = Math.min(1, step16Time / 0.006) * Math.exp(-step16Time * 9.5);
        for (let n = 1; n < chord.length; n++) {
          const f = midiToFreq(chord[n]);
          const tone = (Math.sin(2 * Math.PI * f * t) + 0.30 * Math.sin(4 * Math.PI * f * t)) * pEnv * 0.068;
          sigL += tone * (n % 2 === 0 ? 1.15 : 0.85);
          sigR += tone * (n % 2 === 0 ? 0.85 : 1.15);
        }
      }
    } else if (key === 'luxury-strings') {
      // 🎻 럭셔리 스트링 시네마: 첼로·비올라·바이올린 앙상블 + 우아한 피아노 포인트
      const swell = Math.sin(Math.PI * Math.min(1, barPos)) ** 0.45;
      const slowVib = 1 + 0.003 * Math.sin(2 * Math.PI * 5.1 * t);
      for (let n = 0; n < chord.length; n++) {
        const f = midiToFreq(chord[n]) * slowVib;
        const sL = (
          Math.sin(2 * Math.PI * f * 0.997 * t)
          + 0.32 * Math.sin(2 * Math.PI * f * 2 * 0.999 * t)
          + 0.14 * Math.sin(2 * Math.PI * f * 3 * t)
        );
        const sR = (
          Math.sin(2 * Math.PI * f * 1.003 * t)
          + 0.32 * Math.sin(2 * Math.PI * f * 2 * 1.001 * t)
          + 0.14 * Math.sin(2 * Math.PI * f * 3 * t)
        );
        const weight = n === 0 ? 0.15 : 0.072;
        sigL += sL * weight * swell;
        sigR += sR * weight * swell;
      }
      // 우아한 하프/글로켄 포인트 (4분할)
      const hStep = barSec / 4;
      const hIdx = Math.floor(barTime / hStep);
      const hTime = barTime % hStep;
      const hf = midiToFreq(chord[Math.min(chord.length - 1, hIdx + 1)] + 12);
      const harp = (Math.sin(2 * Math.PI * hf * t) + 0.25 * Math.sin(4 * Math.PI * hf * t)) * Math.exp(-hTime * 3.4) * 0.068;
      sigL += harp * (hIdx % 2 === 0 ? 0.75 : 1.25);
      sigR += harp * (hIdx % 2 === 0 ? 1.25 : 0.75);
    } else if (key === 'minimal-piano') {
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

      const padF = midiToFreq(chord[2]);
      const pad = Math.sin(2 * Math.PI * padF * t) * 0.045;
      sigL += pad;
      sigR += pad;
    } else {
      // city-chill
      const beatSec = barSec / 4;
      const beatIdx = Math.floor(barTime / beatSec);
      const beatTime = barTime % beatSec;

      if (beatIdx === 0 || beatIdx === 2) {
        const kickPitch = 52 + 78 * Math.exp(-beatTime * 34);
        const kickEnv = Math.exp(-beatTime * 11);
        const kick = Math.sin(2 * Math.PI * kickPitch * beatTime) * kickEnv * 0.22;
        sigL += kick;
        sigR += kick;
      }

      if (beatIdx === 1 || beatIdx === 3) {
        const snapEnv = Math.exp(-beatTime * 28);
        const snap = pseudoNoise(i) * snapEnv * 0.055;
        sigL += snap * 0.9;
        sigR += snap * 1.1;
      }

      const chordEnv = Math.min(1, barTime / 0.04) * Math.exp(-barTime * 0.85);
      for (let n = 0; n < chord.length; n++) {
        const f = midiToFreq(chord[n]);
        const w = n === 0 ? 0.13 : 0.075;
        const tone = Math.sin(2 * Math.PI * f * t) + 0.18 * Math.sin(4 * Math.PI * f * t);
        sigL += tone * w * chordEnv * (n % 2 === 0 ? 1.05 : 0.92);
        sigR += tone * w * chordEnv * (n % 2 === 0 ? 0.92 : 1.05);
      }
    }

    const fadeIn = Math.min(1, t / 0.5);
    const fadeOut = Math.min(1, Math.max(0, (dur - t) / 0.9));
    const master = fadeIn * fadeOut;

    left[i] = Math.tanh(sigL * master * 1.65);
    right[i] = Math.tanh(sigR * master * 1.65);
  }

  // 유튜브 쇼츠 표준 음량(-1.5 dBFS 피크 정규화) 마스터링
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
