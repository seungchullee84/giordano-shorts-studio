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
  // 👕 상의 · 아우터 핵심 5종 (20년차 패션 CF·룩북 감독 3막 원테이크 콘티)
  // =====================================================================
  'top-signature-lookbook': {
    id: 'top-signature-lookbook',
    garmentGroup: 'top',
    category: '👕 상의·아우터',
    label: '① 시그니처 백화점 룩북 (만능 대표)',
    prompt: '[1막 {T0}~{T1}초 · 오프닝 훅] 시작 프레임의 정지된 구도에서 0.3초 만에 자연스러운 호흡과 미세한 눈맞춤으로 살아납니다. 모델이 한쪽 발에 가볍게 체중을 싣고 여유롭게 어깨를 풀며 상의의 전체 비율과 실물 색감을 즉각 각인시킵니다. [2막 {T1}~{T2}초 · 45도 시네마 턴 & 실루엣 입체감] 유압 스테디캠이 50mm 프라임 화각으로 천천히 반원 아크 돌리-인(Dolly-in)하는 동안, 모델이 상체를 좌·우 45도로 리얼타임 템포로 부드럽게 틀어 어깨 드롭 라인, 소매 통의 입체 볼륨, 가슴과 밑단 기장의 자연스러운 떨어짐을 끊김 없이 보여줍니다. [3막 {T2}~{T3}초 · 백화점 캠페인 엔딩 컷] 허리 위 상반신 미디엄 클로즈업으로 매끄럽게 안착하며 넥라인과 원단 표면에 흐르는 부드러운 하이라이트를 포착하고, 모델의 자신감 있는 정면 응시로 고급스럽게 마무리합니다. [감독 카메라·조명] 50mm 무왜곡 시네마 단렌즈 f/2.4 + 24fps 자연 모션블러 원테이크 + CRI 97 대형 옥타박스 소프트 키라이트와 은은한 어깨 림라이트.',
  },
  'top-360-spin': {
    id: 'top-360-spin',
    garmentGroup: 'top',
    category: '👕 상의·아우터',
    label: '② 360도 전·측·후면 완벽 핏 턴',
    prompt: '[1막 {T0}~{T1}초 · 정면 기준 핏 제시] 시작 프레임 정면 자세에서 경쾌하게 호흡하며 상의의 넥라인, 어깨 너비, 앞판 기장과 전체 실루엣을 정확히 각인시킵니다. [2막 {T1}~{T2}초 · 끊김 없는 360도 축 회전] 모델이 중심축이 흔들리지 않는 안정적인 발걸음으로 정면 → 좌측 옆선(소매 통·옆 기장) → 완전한 뒷모습(등판 핏·어깨 재봉·뒷기장 떨어짐) → 우측 옆선 → 다시 정면까지 자연스러운 리얼타임 속도로 한 바퀴 360도 우아하게 회전합니다. 카메라는 고정 아이레벨에서 미세하게 좌우 패럴랙스를 주어 입체 두께감을 극대화합니다. [3막 {T2}~{T3}초 · 정면 안착 푸시인] 정면 복귀 직후 상반신으로 부드럽게 돌리-인하며 한 손으로 밑단이나 옷깃을 가볍게 매만지는 자연스러운 마무리 포즈로 완성합니다. [감독 카메라·조명] 50mm 아이레벨 스테디캠 고정 축 + 회전 각도마다 원단 주름과 실루엣 경계가 선명히 살아나는 균일한 3점 소프트 스튜디오 조명.',
  },
  'top-stretch-span': {
    id: 'top-stretch-span',
    garmentGroup: 'top',
    category: '👕 상의·아우터',
    label: '③ 스판 신축성 · 활동성 리얼 체감',
    prompt: '[1막 {T0}~{T1}초 · 단정한 오프닝 스탠스] 시작 프레임에서 깔끔하게 정돈된 상의 핏을 보여준 뒤 가볍게 어깨를 펴며 동작을 시작합니다. [2막 {T1}~{T2}초 · 리얼 신축성 & 즉각 복원 실증] 모델이 일상에서 옷의 편안함을 확인하듯 양팔을 앞으로 교차했다가 좌우로 자연스럽게 뻗어 스트레치하고, 팔꿈치를 굽혀 올린 뒤 상체를 좌우로 가볍게 트위스트합니다. 겨드랑이·어깨·등판 원단이 당김이나 뭉침 없이 탄력 있게 늘어났다가 동작을 풀자마자 주름 없이 원래 실루엣으로 매끄럽게 복원되는 착용감을 리얼타임 속도로 직관적으로 증명합니다. [3막 {T2}~{T3}초 · 흐트러짐 없는 복원 피니시] 동작 직후에도 넥라인과 어깨선이 그대로 살아있는 정면 미디엄 샷으로 부드럽게 푸시인하며 편안한 미소로 마무리합니다. [감독 카메라·조명] 55mm 트래킹 짐벌 + 팔·상체 움직임에 따른 원단 텐션과 미세 주름 복원이 또렷하게 잡히는 선명한 확산 주광.',
  },
  'top-fabric-macro': {
    id: 'top-fabric-macro',
    garmentGroup: 'top',
    category: '👕 상의·아우터',
    label: '④ 원단 질감 · 기모·짜임 클로즈업',
    prompt: '[1막 {T0}~{T1}초 · 룩북 오프닝] 시작 프레임 정면 구도에서 상의의 고급스러운 색감과 포근한 표면 실루엣을 먼저 보여줍니다. [2막 {T1}~{T2}초 · 85mm 시네마 매크로 접근 & 촉감 연출] 카메라가 85mm 시네마 프라임 감각으로 가슴·어깨·소매 라인을 향해 유려하게 돌리-인합니다. 동시에 모델이 한 손끝으로 반대쪽 소매나 앞판 원단을 아주 자연스럽고 부드럽게 한 번 쓸어내리며, 손끝에 감기는 원단의 부드러운 기모감·짜임 조직·적당한 두께감과 빛을 받아 흐르는 미세한 텍스처 음영을 실감 나게 전달합니다. [3막 {T2}~{T3}초 · 우아한 풀백 피니시] 천천히 상반신 미디엄 샷으로 부드럽게 풀백(Dolly-out)하며 모델의 자연스러운 호흡과 원단 드레이프를 함께 담아 마무리합니다. [감독 카메라·조명] 85mm 얕은 심도(f/2.0) + 원단 결에 사선으로 스치는 소프트 사이드 림라이트(색상 왜곡 0%).',
  },
  'top-outer-detail': {
    id: 'top-outer-detail',
    garmentGroup: 'top',
    category: '👕 상의·아우터',
    label: '⑤ 아우터 · 카라·지퍼·볼륨 디테일',
    prompt: '[1막 {T0}~{T1}초 · 시선 고정 캠페인 오프닝] 시작 프레임에서 아우터(또는 셔츠·자켓)의 입체적인 어깨선과 깔끔한 앞여밈 실루엣을 당당하게 제시합니다. [2막 {T1}~{T2}초 · 포켓·라펠·입체 볼륨 디렉팅] 모델이 한 손을 바지 또는 아우터 주머니에 자연스럽게 넣고 상체를 45도 측면으로 돌려 아우터 특유의 가벼운 볼륨감·퀼팅/절개 라인·옆 기장과 이너 레이어드 밸런스를 보여줍니다. 이어 반대손으로 카라·라펠 또는 앞여밈 끝선을 가볍게 한 번 정돈하며 지퍼·단추·재봉선 마감의 높은 완성도를 강조합니다. [3막 {T2}~{T3}초 · 하이엔드 엔딩 포즈] 카메라가 쓰리쿼터에서 상반신으로 부드럽게 접근하며, 정면으로 시선을 고정한 세련된 백화점 화보 포즈로 마무리합니다. [감독 카메라·조명] 50mm 시네마 짐벌 아크 무빙 + 입체 볼륨과 절개선 음영을 또렷하게 살리는 소프트 톱라이트·키라이트 조합.',
  },

  // =====================================================================
  // 👖 하의 핵심 5종 (20년차 패션 CF·룩북 감독 3막 원테이크 콘티)
  // =====================================================================
  'bottom-fit-silhouette': {
    id: 'bottom-fit-silhouette',
    garmentGroup: 'bottom',
    category: '👖 하의',
    label: '① 하의 시그니처 일자·와이드 핏 룩북 (만능 대표)',
    prompt: '[1막 {T0}~{T1}초 · 전신 황금 비율 오프닝] 시작 프레임의 머리부터 발끝까지 전신 구도를 완벽히 유지하며, 허리선에서 발등까지 깔끔하게 떨어지는 하의의 전체 실루엣으로 시선을 집중시킵니다. [2막 {T1}~{T2}초 · 쇼룸 2~3보 워킹 & 바지 통 드레이프] 모델이 카메라를 향해 경쾌하고 자연스러운 리얼타임 템포로 2~3보 걸어 나오며, 걸음마다 살아나는 바지 통의 여유로운 흔들림, 무릎 아래 일자/와이드 떨어짐, 신발 위로 깔끔하게 얹히는 밑단 브레이크를 생생하게 보여줍니다. [3막 {T2}~{T3}초 · 45도 레그라인 엔딩 스탠스] 자연스럽게 멈춰 한쪽 발을 살짝 앞으로 내딛고 45도 각도로 틀어 서며 다리가 길어 보이는 완벽한 하의 비율로 마무리합니다. [감독 카메라·조명] 50mm 무왜곡 허리 높이 짐벌 백트래킹 + 바지 앞판 중심선과 통 볼륨을 살리는 부드러운 전면 확산광.',
  },
  'bottom-360-spin': {
    id: 'bottom-360-spin',
    garmentGroup: 'bottom',
    category: '👖 하의',
    label: '② 하의 360도 힙·허벅지·기장 회전',
    prompt: '[1막 {T0}~{T1}초 · 전신 정면 핏 기준] 시작 프레임 전신 구도에서 하의의 정면 허리선, 앞주름, 허벅지 통, 발목 기장을 정확히 보여줍니다. [2막 {T1}~{T2}초 · 하의 전·측·후면 360도 완전 공개] 모델이 발끝이 화면 밖으로 잘리지 않는 안정적인 축을 유지하며 정면 → 좌측 옆선(골반·허벅지 여유와 사이드 봉제선) → 완전한 뒷모습(힙라인 볼륨·백포켓 위치·종아리 떨어짐) → 우측 옆선 → 다시 정면까지 리얼타임 속도로 매끄럽게 360도 한 바퀴 회전합니다. [3막 {T2}~{T3}초 · 전신 밸런스 피니시] 정면으로 돌아와 주머니에 가볍게 한 손을 걸치고 편안히 서며, 어느 각도에서도 완벽한 하의 핏을 각인시킵니다. [감독 카메라·조명] 50mm 고정 아이레벨 전신 프레이밍(발끝 절대 잘림 금지) + 힙과 다리 실루엣 경계가 또렷한 클린 스튜디오 라이팅.',
  },
  'bottom-sit-stand-span': {
    id: 'bottom-sit-stand-span',
    garmentGroup: 'bottom',
    category: '👖 하의',
    label: '③ 앉았다 일어나도 편한 스판 신축성',
    prompt: '[1막 {T0}~{T1}초 · 정면 핏 제시] 시작 프레임 전신 구도에서 단정하게 떨어지는 하의의 정면 핏을 먼저 보여줍니다. [2막 {T1}~{T2}초 · 앉기·무릎 굽힘 스판 신축성 & 즉각 복원 실증] 모델이 살짝 30도 측면으로 선 상태에서 자연스럽고 경쾌하게 무릎을 깊게 굽혀 앉았다가(하프 스쿼트/앉기 자세) 부드럽게 일어납니다. 허벅지·무릎·골반·허리 라인이 전혀 팽팽하거나 끼이지 않고 유연하게 늘어나는 편안함과, 일어서는 순간 무릎 나옴 없이 곧바로 매끄러운 일자/와이드 라인으로 복원되는 뛰어난 탄력을 리얼타임으로 증명합니다. [3막 {T2}~{T3}초 · 깔끔한 복원 전신 피니시] 일어선 직후 한 걸음 가볍게 딛고 정면을 바라보며 구김 없이 완벽히 살아나는 레그라인으로 마무리합니다. [감독 카메라·조명] 50mm 수직 동기화 짐벌 트래킹(앉고 일어설 때 하의 전체가 프레임 안에 완전 유지) + 밝은 확산 주광.',
  },
  'bottom-tilt-waist-hem': {
    id: 'bottom-tilt-waist-hem',
    garmentGroup: 'bottom',
    category: '👖 하의',
    label: '④ 허리→밑단 시네마 틸트 · 원단·디테일 스캔',
    prompt: '[1막 {T0}~{T1}초 · 허리선 & 포켓 디테일 훅] 시작 프레임에서 허리선~골반 영역으로 자연스럽게 시선을 모으며, 모델이 한 손으로 허리 밴딩·스트링 또는 앞주머니 주변을 가볍게 매만져 깔끔한 허리 마감과 포켓 라인을 강조합니다. [2막 {T1}~{T2}초 · 유압 시네마 버티컬 틸트 스캔] 카메라가 일정하고 매끄러운 유압 틸트다운(Tilt-down)으로 허리선 → 허벅지 원단 결·두께감 → 무릎 라인 → 신발 위 밑단 마감까지 바지 전체를 고급 패션 CF처럼 훑어 내립니다. 모델은 틸트 흐름에 맞춰 한 발을 살짝 옮기며 원단의 부드러운 드레이프를 보여줍니다. [3막 {T2}~{T3}초 · 전신 풀백 피니시] 밑단에서 다시 전신 풀샷으로 부드럽게 풀백(Dolly-out)하며 하의 전체 황금 비율을 한눈에 각인시키며 마무리합니다. [감독 카메라·조명] 65mm 시네마 틸트 헤드 + 원단 조직감과 핀턱/봉제선이 입체적으로 보이는 사선 소프트 라이팅.',
  },
  'bottom-big-stride-walk': {
    id: 'bottom-big-stride-walk',
    garmentGroup: 'bottom',
    category: '👖 하의',
    label: '⑤ 시원한 보폭 · 롱다리 로우앵글 워킹',
    prompt: '[1막 {T0}~{T1}초 · 로우앵글 비율 오프닝] 시작 프레임에서 카메라가 무릎~골반 높이의 살짝 낮은 로우앵글로 매끄럽게 자리 잡아 다리가 길고 시원해 보이는 전신 비율을 강조합니다. [2막 {T1}~{T2}초 · 시원한 보폭 활동성 & 사이드 스텝] 모델이 경쾌하고 자신감 있는 리얼타임 속도로 평소보다 시원한 큰 보폭으로 3~4보 전진하고, 이어 가볍게 사이드 스텝을 밟아 방향을 전환합니다. 넓은 보폭에도 가랑이·허벅지가 전혀 당기지 않는 편안한 활동성과 걸음마다 물 흐르듯 감기는 바지 통의 입체 움직임을 생생하게 담아냅니다. [3막 {T2}~{T3}초 · 런웨이 스톱 & 45도 턴 피니시] 카메라 앞에서 안정적으로 스톱해 45도 각도로 멋스럽게 턴하며 긴 레그라인과 세련된 밑단 핏으로 마무리합니다. [감독 카메라·조명] 40mm~50mm 로우앵글 짐벌 백트래킹 + 시원한 워킹 리듬을 살리는 클린 하이패션 스튜디오 조명.',
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
  const materialNote = product.material ? `원단 질감은 확인된 실제 소재(${product.material})의 조직감, 두께감과 촉감을 그대로 유지해 주세요.` : '';
  const preset = FLOW_PRESETS[presetId] || FLOW_PRESETS[recommendDefaultPreset(resolvedCategory, product)] || FLOW_PRESETS['top-signature-lookbook'];
  const adaptedPresetPrompt = adaptPresetPromptForGarment(formatActTimeline(preset.prompt, durationSec), resolvedCategory);
  const customNote = String(customDirection || '').trim();

  let genderLockRule = '[인물·착장 100% 고정] 첨부된 시작 프레임(원본 사진) 속 실제 모델(또는 마네킨)의 성별, 얼굴, 체형, 헤어스타일과 현재 입고 있는 상·하의·신발 전체 착장을 첫 0초부터 마지막까지 100% 동일하게 유지하세요. 절대 다른 사람이나 다른 옷으로 바꾸지 마세요.';
  if (/남성|맨|남자|MEN/i.test(rawGender) && !/공용|유니섹스/i.test(rawGender)) {
    genderLockRule = `[남성 모델·원본 착장 100% 고정] 이 상품(${itemName})은 남성용 의류입니다. 반드시 첨부된 시작 프레임(원본 사진) 속 실제 남성 모델의 얼굴·체형·헤어와 입고 있는 실제 의류 착장을 첫 장면부터 끝까지 100% 동일하게 유지하세요. 절대 여성 모델로 바꾸거나 원본 사진에 없는 다른 옷을 입히지 마세요.`;
  } else if (/여성|우먼|여자|WOMEN/i.test(rawGender) && !/공용|유니섹스/i.test(rawGender)) {
    genderLockRule = `[여성 모델·원본 착장 100% 고정] 이 상품(${itemName})은 여성용 의류입니다. 반드시 첨부된 시작 프레임(원본 사진) 속 실제 여성 모델의 얼굴·체형·헤어와 입고 있는 실제 의류 착장을 첫 장면부터 끝까지 100% 동일하게 유지하세요. 절대 다른 모델이나 원본 사진에 없는 다른 옷으로 바꾸지 마세요.`;
  } else if (/공용|유니섹스|UNISEX/i.test(rawGender)) {
    genderLockRule = `[원본 모델·착장 100% 고정] 남녀공용 상품(${itemName})입니다. 반드시 첨부된 시작 프레임(원본 사진) 속 실제 모델의 성별·얼굴·체형과 현재 입고 있는 실제 의류 착장을 첫 장면부터 끝까지 100% 동일하게 유지하고 다른 옷으로 변형하지 마세요.`;
  }

  let focusAndFramingRule = '';
  let detailPreservationRule = '';

  if (resolvedCategory === 'bottom') {
    focusAndFramingRule = `[하의 주인공 · 구도 고정] 이 상품(${itemName})은 하의(바지/팬츠) 상품입니다. 함께 코디된 상의는 보조 역할일 뿐이며, 반드시 하의(허리선·골반·허벅지·무릎·밑단·신발까지 이어지는 전체 다리 실루엣과 바지 통 핏)가 영상의 중심 주인공이 되도록 촬영하세요. 절대 상반신만 클로즈업해서 바지가 화면 아래로 잘리게 하지 말고, 첫 프레임부터 마지막까지 하의 전체가 또렷하게 보이는 전신·하체 중심 구도를 유지하세요.`;
    detailPreservationRule = `[원본 절대 보존 원칙 · 하의 디테일] 원본 사진 속 하의(${itemName})의 허리 밴딩·스트링·지퍼·버튼, 앞뒤 포켓 위치, 바지 통 넓이, 일자/와이드/조거 떨어짐, 기장, 밑단 마감, 실제 색상을 단 1%도 변형·추가·생략하지 마세요. 모델이 천천히 걷거나 반회전할 때 바지 원단이 자연스럽게 흔들리고 복원되는 실제 착용 핏을 보여주세요.`;
  } else if (resolvedCategory === 'outer') {
    focusAndFramingRule = `[아우터 주인공 · 구도 고정] 이 상품(${itemName})은 아우터(겉옷) 상품입니다. 아우터 특유의 입체적인 볼륨감, 어깨선, 앞여밈(지퍼·단추), 카라·후드 형태, 포켓, 전체 기장감과 이너와의 레이어드 핏이 가장 돋보이도록 전신~쓰리쿼터(무릎 위) 중심 구도로 촬영하세요.`;
    detailPreservationRule = `[원본 절대 보존 원칙 · 아우터 디테일] 원본 사진 속 아우터(${itemName})의 퀼팅·절개선, 칼라·후드 모양, 지퍼·스냅·단추 개수와 위치, 소매 커프스, 포켓, 기장 비율과 실제 색감을 단 1%도 변형·추가·생략하지 마세요. 팔과 상체를 부드럽게 움직일 때 아우터의 가벼운 탄성과 입체감이 자연스럽게 드러나게 해주세요.`;
  } else {
    focusAndFramingRule = `[상의 주인공 · 구도 고정] 이 상품(${itemName})은 상의 상품입니다. 함께 코디된 하의는 보조 역할일 뿐이며, 반드시 상의(넥라인·카라, 어깨선, 소매 통, 가슴·몸통 핏, 밑단 시보리/기장, 원단 짜임)가 영상의 중심 주인공이 되도록 전신에서 허리선 위 상반신 중심으로 자연스럽게 시선이 모이는 구도로 촬영하세요.`;
    detailPreservationRule = `[원본 절대 보존 원칙 · 상의 디테일] 원본 사진 속 상의(${itemName})의 넥라인·카라 형태, 어깨 드롭 라인, 소매 길이와 통, 앞여밈·단추·포켓, 밑단 마감, 실제 색감을 단 1%도 변형·추가·생략하지 마세요. 모델의 호흡과 자연스러운 팔·상체 움직임에 따라 원단이 부드럽게 흐르는 실제 착용감을 보여주세요.`;
  }

  const verifiedFitHints = Array.isArray(product.sellingPoints)
    ? product.sellingPoints.map(s => String(s || '').trim()).filter(Boolean).slice(0, 2)
    : [];
  const verifiedFitLine = verifiedFitHints.length
    ? `[확인된 실제 상품 포인트 반영] ${verifiedFitHints.join(' / ')} — 위 확인된 특징이 과장 없이 자연스럽게 드러나도록 연출해 주세요.`
    : '';

  const refLabels = [
    hasOfficial ? '공식몰 모델 착용 원본 컷' : null,
    hasMannequin ? '매장 마네킨 실물 정면 컷' : null,
  ].filter(Boolean).join(', ') || '원본 상품 착용 사진';

  const directorMasterRule = '[20년차 패션 CF 감독 마스터 디렉팅 · 템포 & 물리 연속성] 지루하고 답답한 극슬로우모션이나 뚝뚝 끊기는 컷 전환을 금지합니다. 실제 하이엔드 백화점 패션 쇼룸에서 촬영한 듯 경쾌하고 자연스러운 리얼타임 1.0x 호흡의 매끄러운 원테이크(One-take)로 연결하세요. 움직이는 모든 순간 동안 시작 프레임의 배경 톤·조명 색온도·손가락 형태·관절 움직임·원단 봉제선과 실제 RGB 색감이 단 1%도 왜곡되거나 녹아내리지 않도록 철저한 물리적 연속성을 유지하세요.';

  const promptKo = [
    `[프로젝트 목표 · 20년차 패션 영상감독 룩북 디렉팅] 첨부된 시작 프레임(${refLabels})을 첫 프레임으로 100% 이어받아, 실제 백화점 프리미엄 브랜드 캠페인처럼 살아 움직이는 9:16 세로형 실사 룩북 영상(${Math.round(durationSec)}초)을 제작해 주세요.`,
    genderLockRule,
    focusAndFramingRule,
    detailPreservationRule,
    directorMasterRule,
    materialNote,
    verifiedFitLine,
    adaptedPresetPrompt,
    customNote ? `[추가 디렉팅 · 원본 인물/의류 변형 금지] ${customNote}` : '',
    `[화면 청결 규칙] 영상 내부에 어떠한 글자, 자막, 숫자, 워터마크, 임의 로고, 분할 화면, 인위적인 색보정 필터도 절대 생성하지 마세요.`
  ].filter(Boolean).join('\n\n');

  const refDesc = hasOfficial ? '공식몰 전신 모델 착용 원본 사진 (시작 프레임 100% 고정)' : (hasMannequin ? '매장 마네킨 정면 실물 사진 (시작 프레임 100% 고정)' : '원본 상품 사진 고정');
  const summaryKo = [
    `엔진: ${(FLOW_MODELS[modelId] || FLOW_MODELS['omni-1.2-720p']).label} (${Math.round(durationSec)}초 · 예상 약 ${estimateFlowCredits(modelId, durationSec)}크레딧)`,
    `의류 맞춤 설정: ${categoryLabel}${rawGender ? ` · 성별 고정: ${rawGender}` : ''}`,
    `연출 프리셋: ${preset.label} · 생성 방식: 시작 프레임 100% 고정`,
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
