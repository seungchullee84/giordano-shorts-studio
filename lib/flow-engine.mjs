import fs from 'node:fs';
import {copyFile, mkdir, readdir, stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
import sharp from 'sharp';
import {findSystemChrome} from './runtime.mjs';

export const FLOW_URL = 'https://flow.google.com/';

export const FLOW_MODELS = {
  'omni-1.2-720p': {
    id: 'omni-1.2-720p',
    label: 'Omni Flash 1.2 · 720p 고화질 (기본 추천)',
    modelKeyword: 'Omni',
    resolution: '720p',
    defaultSeconds: 15,
    maxSeconds: 15,
    creditsPerSec: 3,
    description: '공식몰 누끼·마네킨 샷·동영상 멀티 레퍼런스로 옷 원본 일관성이 가장 뛰어납니다.',
  },
  'omni-1.2-360p': {
    id: 'omni-1.2-360p',
    label: 'Omni Flash 1.2 · 360p 초안 검수 (절약형)',
    modelKeyword: 'Omni',
    resolution: '360p',
    defaultSeconds: 15,
    maxSeconds: 15,
    creditsPerSec: 1,
    description: '초당 1크레딧으로 옷 변형 여부를 먼저 확인하고 마음에 들 때 고화질로 올릴 수 있습니다.',
  },
  'veo-3.1-lite': {
    id: 'veo-3.1-lite',
    label: 'Veo 3.1 Lite · 가성비 대량 제작 (8초)',
    modelKeyword: 'Veo 3.1',
    resolution: '720p',
    defaultSeconds: 8,
    maxSeconds: 8,
    flatCredits: 5,
    description: '편당 약 5크레딧(구독 기준)으로 여러 품번을 빠르게 대량 제작할 때 적합합니다.',
  },
};

export const FLOW_PRESETS = {
  // =====================================================================
  // 👕 상의 · 아우터 역동적 핵심 5종 (액션 최우선 · 살아 움직이는 패션 CF 콘티)
  // =====================================================================
  'top-signature-lookbook': {
    id: 'top-signature-lookbook',
    garmentGroup: 'top',
    category: '👕 상의·아우터',
    label: '① 런웨이 워킹 & 90도 턴 CF (만능 대표)',
    prompt: '[1막 {T0}~{T1}초 · 즉각 런웨이 워킹 스타트] 0.2초 만에 정지를 깨고 모델이 카메라를 향해 힘차고 경쾌한 발걸음으로 3보 성큼 걸어 나옵니다. 팔의 자연스러운 스윙과 걸음 리듬에 맞춰 상의 밑단과 소매가 살아 움직이며, 카메라는 짐벌 백트래킹(후진 추적)으로 생동감 있게 따라갑니다. [2막 {T1}~{T2}초 · 활기찬 90도 턴 & 어깨 스윙] 모델이 발끝을 축으로 시원하게 좌·우 90도로 몸을 휙 틀며 한 손을 가볍게 주머니에 꽂았다가 빼고, 어깨선·가슴 핏·소매 볼륨을 입체적으로 펼쳐 보입니다. 동시에 카메라는 100도 각도로 과감하게 반원 오빗(Arc Orbit) 선회하며 입체감을 폭발시킵니다. [3막 {T2}~{T3}초 · 카메라 접근 & 자신감 있는 아이컨택] 모델이 한 걸음 더 성큼 다가오며 고개를 경쾌하게 돌려 카메라를 직시하고, 환하고 여유로운 표정과 함께 상반신으로 빠르게 푸시인(Push-in)하며 패션 CF처럼 강렬하게 마무리합니다.',
  },
  'top-360-spin': {
    id: 'top-360-spin',
    garmentGroup: 'top',
    category: '👕 상의·아우터',
    label: '② 경쾌한 360도 풀 스핀 핏 쇼케이스',
    prompt: '[1막 {T0}~{T1}초 · 스텝 오프닝] 시작 직후 모델이 앞으로 성큼 한 걸음 내디디며 어깨를 펴고 정면 핏을 또렷이 각인시킵니다. [2막 {T1}~{T2}초 · 끊김 없는 360도 한 바퀴 풀 스핀] 모델이 런웨이 턴처럼 경쾌하고 리듬감 있는 속도로 정면 → 좌측 옆선 → 완전한 등판 뒷모습(뒷기장·어깨라인) → 우측 옆선 → 정면까지 360도 한 바퀴 시원하게 회전합니다. 회전의 원심력으로 상의 밑단과 소매가 자연스럽게 찰랑이며, 카메라는 반대 방향으로 역동적인 오빗 패럴랙스 무빙을 더해 입체감을 극대화합니다. [3막 {T2}~{T3}초 · 쿨한 옷깃 터치 & 푸시인 피니시] 정면에 딱 안착한 직후 모델이 한 손으로 옷깃이나 밑단을 시원하게 한 번 털어 정돈하고 고개를 살짝 치켜들며 카메라가 상반신으로 경쾌하게 돌리-인하며 마무리합니다.',
  },
  'top-stretch-span': {
    id: 'top-stretch-span',
    garmentGroup: 'top',
    category: '👕 상의·아우터',
    label: '③ 액티브 스트레치 · 팔 스윙 스판 체감',
    prompt: '[1막 {T0}~{T1}초 · 리듬 스타트] 시작 즉시 모델이 가볍게 제자리 스텝을 밟으며 어깨를 크게 한 바퀴 돌려 활기차게 몸을 풉니다. [2막 {T1}~{T2}초 · 큰 팔 스트레치 & 상체 트위스트 실증] 모델이 양팔을 앞뒤와 좌우로 시원하게 크게 벌려 뻗고, 양팔꿈치를 힘 있게 굽혀 올린 뒤 상체를 좌·우 60도로 역동적으로 트위스트합니다. 큰 동작마다 겨드랑이·등판·소매 원단이 탄력 있게 쭉 늘어났다가 팔을 내리자마자 즉각 깔끔한 원래 실루엣으로 복원되는 뛰어난 신축성을 생생하게 증명합니다. 카메라는 모델의 팔 스윙에 맞춰 좌우 트래킹과 다이내믹 줌을 구사합니다. [3막 {T2}~{T3}초 · 경쾌한 스텝 착지 & 미소 피니시] 가볍게 한 걸음 앞으로 디디며 완벽히 복원된 핏을 보여주고, 상반신 미디엄 샷으로 경쾌하게 다가서며 밝은 미소로 마무리합니다.',
  },
  'top-fabric-macro': {
    id: 'top-fabric-macro',
    garmentGroup: 'top',
    category: '👕 상의·아우터',
    label: '④ 다이나믹 줌인 · 원단 터치 모션 컷',
    prompt: '[1막 {T0}~{T1}초 · 활기찬 45도 턴 오프닝] 시작하자마자 모델이 경쾌하게 반 걸음 내디디며 상체를 45도로 틀어 빛을 받는 원단 표면의 입체감을 먼저 드러냅니다. [2막 {T1}~{T2}초 · 과감한 85mm 줌인 & 리얼 원단 터치] 카메라가 모델의 가슴·어깨·소매 라인으로 과감하고 매끄럽게 빠르게 줌인(Dolly-in)하는 동안, 모델이 한 손바닥으로 반대쪽 소매와 앞판 원단을 위에서 아래로 힘 있고 자연스럽게 쓸어내리며 톡톡 두드려 부드러운 기모감·짜임 조직·탄탄한 두께감을 손끝 움직임으로 생생히 체감시킵니다. [3막 {T2}~{T3}초 · 경쾌한 풀백 & 포즈 체인지] 카메라가 상반신에서 쓰리쿼터로 빠르게 풀백(Dolly-out)함과 동시에 모델이 정면으로 몸을 활짝 돌리며 세련된 시선 처리로 마무리합니다.',
  },
  'top-outer-detail': {
    id: 'top-outer-detail',
    garmentGroup: 'top',
    category: '👕 상의·아우터',
    label: '⑤ 아우터 스윙 · 자락 펄럭임 & 런웨이 턴',
    prompt: '[1막 {T0}~{T1}초 · 파워 워킹 스타트] 시작 즉시 모델이 양손을 아우터 주머니에 쿨하게 꽂고 카메라를 향해 2~3보 당당하게 걸어 나오며 아우터의 입체적인 어깨선과 가벼운 볼륨감을 과시합니다. [2막 {T1}~{T2}초 · 자켓 자락 스윙 180도 턴 & 라펠 여밈] 모델이 주머니에서 한 손을 꺼내 카라·라펠·앞여밈을 시원하게 한 번 매만진 뒤, 경쾌하게 180도 반회전했다가 다시 정면으로 휙 돌아서며 아우터 자락이 리듬감 있게 펄럭이는 생동감과 뒷판·옆선 볼륨을 한 번에 보여줍니다. 카메라는 낮은 앵글에서 아크 오빗으로 따라 돌며 웅장한 CF 스케일을 만듭니다. [3막 {T2}~{T3}초 · 당당한 캠페인 클로징] 카메라 가까이 성큼 멈춰 서서 강렬하고 자신감 있는 눈맞춤과 함께 상반신으로 푸시인하며 마무리합니다.',
  },

  // =====================================================================
  // 👖 하의 역동적 핵심 5종 (액션 최우선 · 살아 움직이는 패션 CF 콘티)
  // =====================================================================
  'bottom-fit-silhouette': {
    id: 'bottom-fit-silhouette',
    garmentGroup: 'bottom',
    category: '👖 하의',
    label: '① 하의 런웨이 워킹 & 바지 통 스윙 (만능 대표)',
    prompt: '[1막 {T0}~{T1}초 · 전신 런웨이 워킹 스타트] 시작 즉시 머리부터 발끝까지 전신 구도 안에서 모델이 카메라를 향해 힘차고 경쾌한 보폭으로 3~4보 성큼성큼 걸어 나옵니다. 카메라는 허리 높이 짐벌 백트래킹으로 함께 뒤로 빠지며 속도감 있는 워킹을 포착합니다. [2막 {T1}~{T2}초 · 바지 통 찰랑임 & 방향 전환 턴] 걸음마다 바지 통이 리듬감 있게 흔들리고 무릎 아래 레그라인과 밑단 브레이크가 살아 움직이는 실착 핏을 생생히 보여준 뒤, 모델이 쿨하게 방향을 45도~90도로 틀며 주머니에 한 손을 꽂아 옆선과 골반 여유를 드러냅니다. [3막 {T2}~{T3}초 · 킥 스탠스 런웨이 피니시] 한쪽 발을 힘 있게 앞으로 내딛고 정면을 바라보는 시원한 전신 황금 비율 포즈로 마무리합니다.',
  },
  'bottom-360-spin': {
    id: 'bottom-360-spin',
    garmentGroup: 'bottom',
    category: '👖 하의',
    label: '② 하의 경쾌한 360도 풀 턴 (힙·레그라인)',
    prompt: '[1막 {T0}~{T1}초 · 스텝 인 오프닝] 시작 직후 전신 구도(발끝 절대 잘림 금지)에서 모델이 한 걸음 성큼 앞으로 나오며 허리선과 정면 바지 핏을 강하게 제시합니다. [2막 {T1}~{T2}초 · 끊김 없는 360도 한 바퀴 전신 회전] 모델이 경쾌한 스텝을 밟으며 정면 → 좌측 옆선(골반·허벅지 여유) → 완전한 뒷모습(힙라인 볼륨·백포켓·종아리 떨어짐) → 우측 옆선 → 정면까지 360도 한 바퀴 활기차게 회전합니다. 회전할 때마다 바지 원단이 다리를 감싸며 자연스럽게 찰랑이고, 카메라는 살짝 반대로 오빗하며 3D 입체감을 강조합니다. [3막 {T2}~{T3}초 · 다이나믹 전신 포즈 피니시] 정면 복귀와 동시에 양손을 가볍게 주머니에 걸치고 한 발을 앞세운 시원한 전신 포즈로 마무리합니다.',
  },
  'bottom-sit-stand-span': {
    id: 'bottom-sit-stand-span',
    garmentGroup: 'bottom',
    category: '👖 하의',
    label: '③ 리얼 스쿼트 · 앉았다 힘차게 일어나기',
    prompt: '[1막 {T0}~{T1}초 · 전신 스텝 스타트] 시작 즉시 전신 구도에서 모델이 가볍게 30도 측면으로 스텝을 옮기며 단정한 하의 실루엣을 보여줍니다. [2막 {T1}~{T2}초 · 깊은 앉기·스쿼트 & 탄력 있는 기립 실증] 모델이 망설임 없이 경쾌하게 무릎을 깊게 굽혀 앉았다가(리얼 스쿼트/앉기 자세) 허벅지·무릎·골반이 전혀 끼이지 않는 편안함을 확실히 보여준 뒤, 탄력 있게 벌떡 일어나 가볍게 두 걸음 제자리 스텝을 밟습니다. 일어서는 순간 무릎 나옴이나 구김 없이 곧바로 일자·와이드 핏이 쫙 펴지는 복원력을 생생히 증명합니다. 카메라는 앉고 일어서는 높이에 맞춰 수직 짐벌 트래킹합니다. [3막 {T2}~{T3}초 · 활기찬 전진 피니시] 한 걸음 카메라 쪽으로 힘차게 내딛고 웃으며 완벽히 복원된 전신 레그라인으로 마무리합니다.',
  },
  'bottom-tilt-waist-hem': {
    id: 'bottom-tilt-waist-hem',
    garmentGroup: 'bottom',
    category: '👖 하의',
    label: '④ 허리→밑단 스피드 틸트 & 스텝 스캔',
    prompt: '[1막 {T0}~{T1}초 · 허리선 & 포켓 액티브 훅] 시작 즉시 모델이 양손을 바지 주머니에 쿨하게 꽂았다 빼며 허리 밴딩·스트링과 포켓 라인을 강조하고, 경쾌하게 체중을 좌우로 옮깁니다. [2막 {T1}~{T2}초 · 경쾌한 스피드 틸트다운 & 발 스텝] 카메라가 허리선에서 허벅지 원단 결 → 무릎 → 신발 위 밑단 마감까지 속도감 있고 유려하게 수직 틸트다운(Tilt-down)하며 스캔합니다. 동시에 모델이 리듬에 맞춰 발을 한 걸음씩 앞뒤로 교차 스텝하며 바지 통의 움직임과 원단 두께감을 생생히 드러냅니다. [3막 {T2}~{T3}초 · 로우앵글 치고 올라오는 풀백 피니시] 밑단 로우앵글에서 단숨에 전신 풀샷으로 경쾌하게 풀백(Dolly-out) & 틸트업하며 모델의 45도 턴 포즈로 마무리합니다.',
  },
  'bottom-big-stride-walk': {
    id: 'bottom-big-stride-walk',
    garmentGroup: 'bottom',
    category: '👖 하의',
    label: '⑤ 큰 보폭 성큼성큼 · 롱다리 로우앵글 런웨이',
    prompt: '[1막 {T0}~{T1}초 · 로우앵글 파워 스타트] 시작 즉시 카메라가 무릎 높이의 역동적인 로우앵글로 낮게 깔리며 다리가 길고 시원해 보이는 런웨이 구도로 전환합니다. [2막 {T1}~{T2}초 · 큰 보폭 4~5보 전진 & 사이드 턴 활동성] 모델이 평소보다 크고 시원한 보폭으로 4~5보 성큼성큼 힘차게 전진하고, 이어 경쾌하게 사이드 스텝과 90도 방향 전환을 연속으로 펼칩니다. 넓은 보폭에도 허벅지와 골반이 전혀 당기지 않는 탁월한 활동성과 걸음마다 바지 통이 시원하게 휘날리는 리얼한 핏을 역동적인 짐벌 백트래킹으로 담아냅니다. [3막 {T2}~{T3}초 · 런웨이 스톱 & 뒤돌아보기 피니시] 힘 있게 멈춰 서서 45도 몸을 틀고 어깨 너머로 카메라를 멋스럽게 응시하며 긴 레그라인으로 마무리합니다.',
  },
};

export function estimateFlowCredits(modelId = 'omni-1.2-720p', durationSec = 10) {
  const model = FLOW_MODELS[modelId] || FLOW_MODELS['omni-1.2-720p'];
  if (Number.isFinite(model.flatCredits)) return model.flatCredits;
  const clamped = Math.max(4, Math.min(model.maxSeconds, Math.round(Number(durationSec) || model.defaultSeconds)));
  return clamped * model.creditsPerSec;
}

/**
 * 이미지 상·하단 테두리의 색상 균일도를 측정하여 스튜디오 단색 배경 여부를 판별하고 대표 배경색을 반환한다.
 */
export async function analyzeBackdropCleanliness(sourcePath) {
  try {
    const {data, info} = await sharp(sourcePath)
      .rotate()
      .resize(96, 128, {fit: 'fill'})
      .removeAlpha()
      .raw()
      .toBuffer({resolveWithObject: true});

    const w = info.width;
    const h = info.height;
    const sampleRows = (startY, endY) => {
      let rSum = 0, gSum = 0, bSum = 0, count = 0;
      const pixels = [];
      for (let y = startY; y < endY; y++) {
        for (let x = 0; x < w; x++) {
          // 중앙 인물 머리/발이 닿을 수 있는 정중앙 24%는 제외하고 좌우 가장자리 위주로 배경색 추출
          if (x > w * 0.38 && x < w * 0.62) continue;
          const idx = (y * w + x) * 3;
          const r = data[idx], g = data[idx + 1], b = data[idx + 2];
          rSum += r; gSum += g; bSum += b; count++;
          pixels.push([r, g, b]);
        }
      }
      if (!count) return {r: 245, g: 245, b: 245, std: 99};
      const mr = rSum / count, mg = gSum / count, mb = bSum / count;
      let varSum = 0;
      for (const [r, g, b] of pixels) {
        varSum += ((r - mr) ** 2 + (g - mg) ** 2 + (b - mb) ** 2) / 3;
      }
      return {
        r: Math.round(mr),
        g: Math.round(mg),
        b: Math.round(mb),
        std: Math.sqrt(varSum / count),
      };
    };

    const top = sampleRows(0, 6);
    const bottom = sampleRows(h - 6, h);
    const colorDiff = Math.hypot(top.r - bottom.r, top.g - bottom.g, top.b - bottom.b);
    const isCleanStudio = top.std < 14 && bottom.std < 18 && colorDiff < 28;
    const studioScore = Math.max(0, 100 - (top.std * 2.2 + bottom.std * 1.8 + colorDiff * 0.9));
    return {isCleanStudio, studioScore, top, bottom};
  } catch {
    return {isCleanStudio: false, studioScore: 0, top: {r: 244, g: 244, b: 244}, bottom: {r: 244, g: 244, b: 244}};
  }
}

/**
 * 수집된 이미지 중 Google Flow 시작 프레임(대표 1번)으로 가장 적합한 전신 스튜디오 착용 컷을 우선 정렬한다.
 * (단, 사용자가 직접 순서를 변경한 경우 preserveOrder=true 이면 사용자 순서를 100% 존중한다.)
 */
export async function selectBestFlowReferences(imageAssets = [], {preserveOrder = false, maxCount = 4} = {}) {
  if (!imageAssets.length) return [];
  if (preserveOrder) return imageAssets.slice(0, maxCount);

  const scored = await Promise.all(imageAssets.map(async (asset, idx) => {
    const bg = await analyzeBackdropCleanliness(asset.filePath);
    // 공식몰 모델 착용 컷이면서 깔끔한 단색 스튜디오 배경(전신 정면 룩북 컷)일수록 최우선 순위 부여
    const kindBonus = asset.kind === 'official' ? 100 : 40;
    const studioBonus = bg.isCleanStudio ? (50 + bg.studioScore * 0.4) : (bg.studioScore * 0.15);
    const orderTieBreak = Math.max(0, 10 - idx * 2);
    return {asset, score: kindBonus + studioBonus + orderTieBreak, bg};
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxCount).map(s => s.asset);
}

/**
 * 원본 100% 무손상 원칙:
 * - 더러운 상하 블러(얼룩) 패딩을 절대 사용하지 않는다!
 * - 깔끔한 스튜디오 배경 사진은 실제 상·하단 배경 픽셀 컬러를 이음새 없이 연장해 완벽한 9:16 화보 비율(1080x1920)로 만든다.
 * - 실내/야외/매장 배경 사진은 억지 여백 합성 없이 원본 비율 그대로 고화질 저장하여 AI가 얼룩을 오인식하지 않게 한다.
 */
export async function prepareFlowReferenceImage(sourcePath, outputPath, {isCutout = false, studioTone = '#efeae2'} = {}) {
  await mkdir(path.dirname(outputPath), {recursive: true});
  const W = 1080;
  const H = 1920;

  if (isCutout) {
    const fg = await sharp(sourcePath)
      .rotate()
      .resize({width: 940, height: 1560, fit: 'inside', withoutEnlargement: false})
      .png()
      .toBuffer();

    const bgSvg = Buffer.from(`
      <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <radialGradient id="g" cx="50%" cy="42%" r="65%">
            <stop offset="0%" stop-color="#faf8f5"/>
            <stop offset="100%" stop-color="${studioTone}"/>
          </radialGradient>
        </defs>
        <rect width="${W}" height="${H}" fill="url(#g)"/>
      </svg>
    `);

    await sharp(bgSvg)
      .composite([{input: fg, gravity: 'center'}])
      .jpeg({quality: 95})
      .toFile(outputPath);
    return outputPath;
  }

  const bgInfo = await analyzeBackdropCleanliness(sourcePath);
  if (bgInfo.isCleanStudio) {
    const resized = await sharp(sourcePath)
      .rotate()
      .resize({width: W, height: H, fit: 'inside', withoutEnlargement: false})
      .toBuffer({resolveWithObject: true});

    const padTotal = Math.max(0, H - resized.info.height);
    const padTop = Math.floor(padTotal / 2);
    const padBottom = padTotal - padTop;
    const padHoriz = Math.max(0, W - resized.info.width);
    const padLeft = Math.floor(padHoriz / 2);
    const padRight = padHoriz - padLeft;

    await sharp(resized.data)
      .extend({
        top: padTop,
        bottom: padBottom,
        left: padLeft,
        right: padRight,
        extendWith: 'copy', // 최상단/최하단 실제 스튜디오 픽셀 행을 그대로 연장해 수평 경계선 0% 달성!
      })
      .jpeg({quality: 95})
      .toFile(outputPath);
    return outputPath;
  }

  // 실내 무드컷이나 매장 마네킨 샷은 지저분한 블러 패딩 없이 원본 그대로 깨끗하게 전달
  await sharp(sourcePath)
    .rotate()
    .resize({width: 1440, height: 1920, fit: 'inside', withoutEnlargement: true})
    .jpeg({quality: 95})
    .toFile(outputPath);

  return outputPath;
}

export const GARMENT_CATEGORIES = {
  top: {id: 'top', label: '상의 (티셔츠·니트·셔츠·맨투맨·후드)'},
  outer: {id: 'outer', label: '아우터 (패딩·자켓·코트·집업·가디건)'},
  bottom: {id: 'bottom', label: '하의 (팬츠·데님·슬랙스·조거·스커트)'},
};

/**
 * 상품명과 확인된 설명을 분석하여 'bottom'(하의) | 'outer'(아우터) | 'top'(상의)를 정확히 판별한다.
 */
export function classifyGarmentCategory(product = {}) {
  const nameText = `${product.name || ''} ${product.rawName || ''} ${product.headline || ''}`.trim();
  const fullText = `${nameText} ${Array.isArray(product.sellingPoints) ? product.sellingPoints.join(' ') : ''}`;

  if (/(?:팬츠|바지|슬랙스|데님|청바지|진\b|조거|치노|카고|쇼츠|반바지|하프팬츠|스커트|치마|레깅스|트라우저|와이드핏\s*팬츠|스웻\s*팬츠|트레이닝\s*팬츠|pants|jeans|slacks|skirt|shorts|trouser|jogger|chino)/i.test(nameText)) {
    return 'bottom';
  }
  if (/(?:패딩|다운|푸퍼|점퍼|자켓|재킷|코트|집업|가디건|베스트|조끼|블루종|야상|트렌치|무스탕|아우터|파카|윈드브레이커|바람막이|플리스\s*집업|후드\s*집업|jacket|coat|padding|down|jumper|cardigan|vest|zip-?up|outer)/i.test(nameText)) {
    return 'outer';
  }
  if (/(?:티셔츠|니트|스웨터|맨투맨|스웻셔츠|후드티|후디|후드|셔츠|블라우스|폴로|카라티|긴팔|반팔|크루넥|터틀넥|목폴라|라운드넥|풀오버|탑|이너|shirt|knit|sweater|hoodie|sweatshirt|tee|polo|blouse)/i.test(nameText)) {
    return 'top';
  }
  if (/(?:다리\s*라인|허벅지|밑단까지\s*일자|허리\s*밴드|스트링\s*디테일|하의)/i.test(fullText)) {
    return 'bottom';
  }
  if (/(?:충전재|보온성|레이어드|퀼팅|아우터)/i.test(fullText)) {
    return 'outer';
  }
  return 'top';
}

/**
 * 의류 구분과 상품 특성에 가장 잘 어울리는 기본 연출 프리셋 ID를 자동 추천한다.
 * - 스판/신축성이 확인된 하의는 '앉았다 일어나도 편한 스판 신축성'을 우선 추천한다.
 */
export function recommendDefaultPreset(category, product = {}) {
  const nameText = `${product.name || ''} ${product.rawName || ''}`;
  const fullText = `${nameText} ${product.material || ''} ${Array.isArray(product.sellingPoints) ? product.sellingPoints.join(' ') : ''}`;
  if (category === 'bottom') {
    if (/스판|신축성|폴리우레탄|엘라스틴|스트레치/i.test(fullText)) return 'bottom-sit-stand-span';
    if (/기모|코듀로이|핀턱|스트링|밴딩|데님|청바지/i.test(fullText)) return 'bottom-tilt-waist-hem';
    if (/와이드|루즈|카고|조거|활동|트랙/i.test(nameText)) return 'bottom-big-stride-walk';
    return 'bottom-fit-silhouette';
  }
  if (category === 'outer') return 'top-outer-detail';
  if (/셔츠|블라우스|폴로|가디건|집업|카라/i.test(nameText)) return 'top-outer-detail';
  if (/스판|신축성|스트레치|폴리우레탄|기능성|지모션|G-MOTION/i.test(fullText)) return 'top-stretch-span';
  if (/기모|브러쉬드|니트|스웨터|캐시미어|울|코듀로이|와플|플리스/i.test(fullText)) return 'top-fabric-macro';
  return 'top-signature-lookbook';
}

/**
 * 선택된 영상 길이(8초/12초/15초 등)에 맞춰 3막 타임라인 초 단위를 정확히 계산해 치환한다.
 */
function formatActTimeline(promptText, durationSec = 12) {
  const total = Math.max(6, Math.min(15, Math.round(Number(durationSec) || 12)));
  const t1 = Math.max(2, Math.round(total * 0.25));
  const t2 = Math.max(t1 + 3, Math.round(total * 0.72));
  return String(promptText || '')
    .replaceAll('{T0}', '0')
    .replaceAll('{T1}', String(t1))
    .replaceAll('{T2}', String(t2))
    .replaceAll('{T3}', String(total));
}

function adaptPresetPromptForGarment(presetPrompt, category) {
  let text = String(presetPrompt || '');
  if (category === 'bottom') {
    text = text
      .replace(/전신에서 상반신 방향으로/g, '전신에서 허리선~다리 라인 중심으로')
      .replace(/전신에서 상반신까지/g, '전신에서 허리선~허벅지·밑단 라인까지')
      .replace(/상반신 클로즈업 구도에서/g, '허리선과 다리 핏이 잘 보이는 미디엄 샷에서')
      .replace(/상반신 핵심 디테일까지/g, '허리 밴딩·허벅지·밑단 핵심 핏까지')
      .replace(/허리 위 상반신 프레임 안에서/g, '허리선부터 발끝까지 하의가 주인공이 되는 프레임 안에서')
      .replace(/허리 위 미디엄 샷을 중심으로/g, '허리선부터 밑단까지 다리 전체가 보이는 쓰리쿼터·전신 구도로')
      .replace(/무릎 위 미디엄 풀샷에서/g, '머리부터 발끝까지 바지 전체가 보이는 풀샷에서')
      .replace(/가슴·카라 영역으로/g, '허리선·포켓·바지 원단 조직 영역으로')
      .replace(/어깨선,\s*소매 통,\s*옆 실루엣과 총기장 떨어짐/g, '허리선, 골반·허벅지 통 넓이, 옆 실루엣과 밑단 떨어짐')
      .replace(/어깨선과 소매 외곽 라인/g, '바지 옆 봉제선과 밑단 외곽 라인')
      .replace(/어깨선과 깔끔하게 떨어지는 핏/g, '허리선과 일자로 깔끔하게 떨어지는 바지 핏')
      .replace(/소매 끝단이나 카라·앞여밈 라인을 한 손으로 가볍고 우아하게 정돈한 뒤/g, '바지 주머니와 허리선·스트링 주변을 한 손으로 가볍게 정돈한 뒤')
      .replace(/옷깃을 포근하게 여미거나/g, '주머니에 가볍게 손을 넣거나 자연스럽게 걸으며')
      .replace(/넥라인,\s*어깨 재봉선,\s*가슴 핏/g, '허리 밴딩·스트링, 포켓 마감, 허벅지~밑단 핏')
      .replace(/넥라인·앞여밈·단추·지퍼·재봉선 마감/g, '허리 밴딩·스트링·포켓·옆 봉제선·밑단 마감')
      .replace(/상단 카라·어깨 봉제 디테일/g, '허리선·포켓·다리 실루엣 디테일')
      .replace(/어깨와 팔의 힘을 빼/g, '자연스럽게 한 걸음 체중을 옮기며');
  } else if (category === 'top') {
    text = text
      .replace(/옷자락과 바지 통이/g, '상의 밑단과 소매 라인이')
      .replace(/바지 앞판 중심선과 옆 봉제선,\s*밑단 주름/g, '상의 어깨선과 소매 봉제선, 자연스러운 원단 드레이프');
  } else if (category === 'outer') {
    text = text
      .replace(/바지 앞판 중심선과 옆 봉제선,\s*밑단 주름/g, '아우터의 퀼팅·앞여밈 라인과 입체 볼륨 실루엣');
  }
  return text;
}

/**
 * 원본 보존 + 성별 고정 + 상의/아우터/하의 완전 구분 전용 Google Flow 프롬프트 생성기.
 * 시작 프레임(원본 사진)의 인물·성별·착장 의류를 첫 프레임부터 끝까지 100% 동일하게 고정한다.
 */
export function buildFlowPrompt({product = {}, assets = [], modelId = 'omni-1.2-720p', durationSec = 15, presetId = '', customDirection = '', garmentCategory = 'auto'} = {}) {
  const hasMannequin = assets.some(a => a.kind === 'mannequin');
  const hasOfficial = assets.some(a => a.kind === 'official');
  const itemName = product.name || product.rawName || product.headline || '지오다노 의류 상품';
  const rawGender = String(product.gender || '').trim();
  const resolvedCategory = (garmentCategory && GARMENT_CATEGORIES[garmentCategory])
    ? garmentCategory
    : classifyGarmentCategory(product);
  const categoryLabel = GARMENT_CATEGORIES[resolvedCategory]?.label || '상의';
  const materialNote = product.material ? `[실제 소재 질감 표현] 확인된 원단(${product.material}) 특유의 두께감·결·탄력이 모델의 움직임과 함께 생동감 있게 드러나게 연출하세요.` : '';
  const preset = FLOW_PRESETS[presetId] || FLOW_PRESETS[recommendDefaultPreset(resolvedCategory, product)] || FLOW_PRESETS['top-signature-lookbook'];
  const adaptedPresetPrompt = adaptPresetPromptForGarment(formatActTimeline(preset.prompt, durationSec), resolvedCategory);
  const customNote = String(customDirection || '').trim();

  const refLabels = [
    hasOfficial ? '공식몰 모델 착용 원본 컷' : null,
    hasMannequin ? '매장 마네킨 실물 정면 컷' : null,
  ].filter(Boolean).join(', ') || '원본 상품 착용 사진';

  let genderText = '시작 프레임 속 모델(또는 마네킨)의 성별·얼굴·체형·헤어';
  if (/남성|맨|남자|MEN/i.test(rawGender) && !/공용|유니섹스/i.test(rawGender)) {
    genderText = `남성용 의류(${itemName})에 맞춰 시작 프레임 속 남성 모델의 얼굴·체형·헤어`;
  } else if (/여성|우먼|여자|WOMEN/i.test(rawGender) && !/공용|유니섹스/i.test(rawGender)) {
    genderText = `여성용 의류(${itemName})에 맞춰 시작 프레임 속 여성 모델의 얼굴·체형·헤어`;
  }

  let focusAndFramingRule = '';
  if (resolvedCategory === 'bottom') {
    focusAndFramingRule = `[하의 주인공 · 구도 고정] 이 상품(${itemName})은 하의(바지)입니다. 첫 프레임부터 끝까지 발끝과 하의 전체(허리선·골반·허벅지·밑단)가 화면 밖으로 잘리지 않는 전신·하체 중심 구도로 역동적인 워킹과 핏을 보여주세요.`;
  } else if (resolvedCategory === 'outer') {
    focusAndFramingRule = `[아우터 주인공 · 구도 고정] 이 상품(${itemName})은 아우터입니다. 움직임 속에서 아우터의 입체 볼륨, 어깨선, 앞여밈·카라, 기장과 레이어드 실루엣이 돋보이도록 전신~쓰리쿼터 구도로 담아주세요.`;
  } else {
    focusAndFramingRule = `[상의 주인공 · 구도 고정] 이 상품(${itemName})은 상의입니다. 모델의 활기찬 움직임과 함께 상의의 넥라인, 어깨선, 소매, 몸통 핏과 밑단 떨어짐에 시선이 집중되도록 연출하세요.`;
  }

  const verifiedFitHints = Array.isArray(product.sellingPoints)
    ? product.sellingPoints.map(s => String(s || '').trim()).filter(Boolean).slice(0, 2)
    : [];
  const verifiedFitLine = verifiedFitHints.length
    ? `[실제 상품 포인트 액션 반영] ${verifiedFitHints.join(' / ')} — 위 특징이 모델의 움직임 속에 자연스럽게 체감되도록 보여주세요.`
    : '';

  // 핵심: 정적 동결을 막기 위해 [역동적 액션 + 3막 콘티]를 최상단에 배치하고, 보존 지침은 하단에 간결히 정리!
  const activeDirectorHeader = `[20년차 패션 CF 감독 · 역동적 액션 우선 디렉팅 (${Math.round(durationSec)}초 · 9:16)] 첨부된 시작 프레임(${refLabels})에서 절대 멈춰 서 있지 말고, 0.2초 만에 즉각 활기차게 움직이기 시작하세요! 정적인 포즈·느린 숨쉬기·고정 카메라를 금지하고, 매 2~3초마다 뚜렷한 보행·회전·팔 동작·포즈 전환과 과감한 짐벌 트래킹·오빗·푸시인 카메라 무빙이 살아 숨 쉬는 경쾌한 리얼타임 1.0x 하이패션 릴스 원테이크로 제작하세요.`;

  const concisePreservationRule = `[원본 절대 보존 원칙 · 화면 청결] 위 역동적인 움직임 전체 구간 동안 ${genderText}와 현재 착용한 실제 의류(${itemName})의 디자인·디테일·실물 색감은 변형 없이 동일하게 유지하세요. 영상 안에 글자, 자막, 숫자, 워터마크, 임의 로고, 분할 화면은 절대 넣지 마세요.`;

  const promptKo = [
    activeDirectorHeader,
    adaptedPresetPrompt,
    verifiedFitLine,
    materialNote,
    customNote ? `[추가 디렉팅] ${customNote}` : '',
    focusAndFramingRule,
    concisePreservationRule,
  ].filter(Boolean).join('\n\n');

  const refDesc = hasOfficial ? '공식몰 전신 모델 착용 원본 사진 (시작 프레임 연동)' : (hasMannequin ? '매장 마네킨 정면 실물 사진 (시작 프레임 연동)' : '원본 상품 사진');
  const summaryKo = [
    `엔진: ${(FLOW_MODELS[modelId] || FLOW_MODELS['omni-1.2-720p']).label} (${Math.round(durationSec)}초 · 예상 약 ${estimateFlowCredits(modelId, durationSec)}크레딧)`,
    `의류 맞춤 설정: ${categoryLabel}${rawGender ? ` · 성별: ${rawGender}` : ''}`,
    `연출 프리셋: ${preset.label} · 액션 최우선 다이내믹 디렉팅`,
    `참고자료: ${refDesc}`,
  ].join('\n');

  return {promptEn: promptKo, summaryKo, resolvedCategory};
}

let activeBrowser = null;
let activeContext = null;
let activePage = null;
const FLOW_CDP_PORT = 9229;

async function waitForCdpReady(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {signal: AbortSignal.timeout(1200)});
      if (res.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 350));
  }
  return false;
}

function launchVisibleChromeProcess(chromeExe, profileDir, port, initialUrl) {
  const child = spawn(chromeExe, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--start-maximized',
    initialUrl,
  ], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.on('error', () => {});
  child.unref();
}

export async function ensureFlowChrome(profileDir, log = () => {}) {
  await mkdir(profileDir, {recursive: true});

  // 이미 떠 있는 전용 Chrome(CDP 9229)에 먼저 재연결 시도
  if (!activeBrowser || !activeBrowser.isConnected()) {
    const alreadyUp = await waitForCdpReady(FLOW_CDP_PORT, 900);
    if (!alreadyUp) {
      const systemChrome = findSystemChrome();
      if (!systemChrome) {
        throw new Error('이 PC에서 Google Chrome을 찾지 못했습니다. Chrome 설치 후 다시 시도해 주세요.');
      }
      log('실제 Google Chrome(전용 프로필) 창을 화면에 여는 중…');
      launchVisibleChromeProcess(systemChrome, profileDir, FLOW_CDP_PORT, FLOW_URL);
      const ready = await waitForCdpReady(FLOW_CDP_PORT, 18000);
      if (!ready) {
        throw new Error('Google Chrome 창 연결 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.');
      }
    }
    activeBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${FLOW_CDP_PORT}`);
    activeBrowser.on('disconnected', () => {
      activeBrowser = null;
      activeContext = null;
      activePage = null;
    });
  }

  activeContext = activeBrowser.contexts()[0];
  if (!activeContext) throw new Error('Chrome 브라우저 컨텍스트를 열지 못했습니다.');
  const pages = activeContext.pages();
  activePage = pages.find(p => /^https:\/\/(?:labs\.google\/|flow\.google\.com)/i.test(p.url())) || pages[0] || await activeContext.newPage();
  await activePage.bringToFront().catch(() => {});
  return {context: activeContext, page: activePage};
}

function openInUserBrowser(url) {
  if (process.platform === 'win32') {
    const child = spawn('explorer.exe', [url], {detached: true, stdio: 'ignore'});
    child.on('error', () => {});
    child.unref();
    return;
  }
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(opener, [url], {detached: true, stdio: 'ignore'});
  child.on('error', () => {});
  child.unref();
}

function copyTextToClipboard(text) {
  if (process.platform !== 'win32' || !text) return;
  try {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-WindowStyle', 'Hidden',
      '-Command',
      '[Console]::InputEncoding = [Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())',
    ], {stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true});
    child.on('error', () => {});
    child.stdin.write(text, 'utf8');
    child.stdin.end();
  } catch {}
}

/**
 * 사용자의 실제 기본 Chrome 창에 Google Flow(https://flow.google.com/)를 확실하게 열고,
 * 한국어 원본 보존 프롬프트를 클립보드에 자동 복사하며 9:16 준비 폴더도 바로 쓸 수 있게 준비한다.
 */
export async function launchAndPrepareFlow({
  preparedImagePaths = [],
  promptEn = '',
  modelId = 'omni-1.2-720p',
  downloadsDir,
  log = () => {},
}) {
  if (downloadsDir) await mkdir(downloadsDir, {recursive: true});

  if (promptEn) {
    copyTextToClipboard(promptEn);
    log('한국어 원본 보존 프롬프트를 클립보드에 자동 복사했습니다. (Flow에서 Ctrl+V로 바로 붙여넣기 가능)');
  }

  log('Google Flow용 9:16 참고 이미지와 한국어 프롬프트 준비 완료.');

  const modelInfo = FLOW_MODELS[modelId] || FLOW_MODELS['omni-1.2-720p'];
  const actions = [
    '새 탭으로 Google Flow(flow.google.com)가 열렸습니다.',
    '한국어 원본 보존 프롬프트가 클립보드에 자동 복사되었습니다. (Flow에서 Ctrl+V)',
    preparedImagePaths.length
      ? `9:16 참고 이미지 ${preparedImagePaths.length}장이 준비되었습니다. [9:16 준비 폴더 열기]에서 Flow로 끌어다 놓으세요.`
      : '참고 이미지를 먼저 불러온 뒤 Flow로 끌어다 놓으세요.',
  ];

  return {
    status: 'ready',
    message: `Google Flow를 열었습니다! (${modelInfo.label}) Flow에서 생성·다운로드 후 [2. 최신 Flow 영상 불러오기]를 누르면 1초 만에 불러옵니다.`,
    actions,
    url: FLOW_URL,
  };
}

/**
 * Flow 전용 다운로드 폴더 또는 PC 기본 Downloads 폴더에서 가장 최근 MP4 영상을 찾아 작업 폴더로 복사한다.
 * (원본 파일은 절대 삭제·수정하지 않고 복사본만 사용)
 */
export async function importLatestFlowVideo(flowDownloadsDir, destSourcesDir, {maxAgeMs = 45 * 60 * 1000} = {}) {
  const candidatesDirs = [
    flowDownloadsDir,
    path.join(os.homedir(), 'Downloads'),
  ].filter(dir => dir && fs.existsSync(dir));

  const now = Date.now();
  let latest = null;
  for (const dir of candidatesDirs) {
    try {
      const entries = await readdir(dir, {withFileTypes: true});
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!/\.(mp4|mov|webm)$/i.test(entry.name)) continue;
        const full = path.join(dir, entry.name);
        const st = await stat(full);
        if (maxAgeMs && (now - st.mtimeMs) > maxAgeMs) continue;
        if (!latest || st.mtimeMs > latest.mtimeMs) {
          latest = {full, name: entry.name, mtimeMs: st.mtimeMs, size: st.size};
        }
      }
    } catch {}
  }

  if (!latest) {
    throw new Error('최근 45분 이내에 새로 다운로드된 Flow 동영상 파일(MP4)이 없습니다. Flow 화면의 영상 카드 우측 상단 [⋮] → [다운로드] 후 다시 눌러주세요.');
  }

  await mkdir(destSourcesDir, {recursive: true});
  const ext = path.extname(latest.name) || '.mp4';
  const safeBase = `flow-${Date.now()}${ext}`;
  const destPath = path.join(destSourcesDir, safeBase);
  await copyFile(latest.full, destPath);

  return {
    filePath: destPath,
    filename: safeBase,
    originalName: latest.name,
    size: latest.size,
  };
}

export async function closeFlowChrome() {
  if (activeBrowser) {
    await activeBrowser.close().catch(() => {});
    activeBrowser = null;
    activeContext = null;
    activePage = null;
  }
}
