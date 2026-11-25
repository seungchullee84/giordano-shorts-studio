import {BUILTIN_BGM_PRESETS} from './bgm-synth.mjs';
import {FLOW_PRESETS, classifyGarmentCategory} from './flow-engine.mjs';

const CAPTION_STYLE_LABELS = {
  'reels-highlight': '① 스모크 유리 바',
  'shopping-card': '② 웜 글래스 화보 카드',
  'lookbook-center': '③ 시네마 센터 룩북',
};

const CAPTION_POS_LABELS = {
  'safe-lower': '안전 하단 위',
  'mid-lower': '중하단 강조',
  'upper-title': '상단 배치 (하의용)',
};

const TRANSITION_LABELS = {
  fade: '부드러운 크로스 페이드',
  mix: '절제 리듬 믹스',
  'slide-left': '가로 슬라이드',
  'slide-up': '세로 넘김',
};

/**
 * 10년차 쇼핑 숏폼 트렌드 분석가 기준의 카테고리별 실전 숏폼 처방전 & 6종 원클릭 자동 세팅 엔진.
 * - 외부 API 비용 0원 · 0.1초 즉시 산출 · 거짓 정보 없음 (확인된 공식 상품 정보 기준).
 */
export function buildTrendStrategy({product = {}, facts = {}, garmentCategory = 'auto'} = {}) {
  const merged = {...(product || {}), ...(facts || {})};
  const name = String(merged.headline || merged.name || merged.rawName || '').trim();
  const material = String(merged.material || '').trim();
  const points = Array.isArray(merged.sellingPoints) ? merged.sellingPoints.join(' ') : '';
  const evidence = `${name} ${material} ${merged.officialDescription || ''} ${points}`;
  const colorCount = Array.isArray(merged.colors) ? merged.colors.filter(Boolean).length : 0;

  const resolvedCat = ['top', 'outer', 'bottom'].includes(garmentCategory)
    ? garmentCategory
    : classifyGarmentCategory(merged);

  const hasBrushed = /기모|브러[시쉬]드|보온|포근|플리스/.test(evidence);
  const hasStretch = /스판|신축|스트레치|폴리우레탄|엘라스틴|지모션|G-MOTION/i.test(evidence);
  const hasBandString = /밴드|밴딩|스트링|트레이닝|조거/.test(evidence);
  const hasWideOrDenim = /와이드|루즈|카고|데님|청바지|진\b|스트레이트/.test(evidence);
  const hasLightPad = /경량|패딩|다운|푸퍼|클라우드\s*라이트|점퍼/.test(evidence);
  const hasKnit = /니트|스웨터|케이블|피셔맨|울|캐시미어|와플/.test(evidence);
  const hasShirtCardigan = /셔츠|블라우스|가디건|폴로|집업|카라/.test(evidence);
  const hasManyColors = colorCount >= 6;

  let profile;

  if (resolvedCat === 'bottom') {
    if (hasStretch || (hasBrushed && hasBandString)) {
      profile = {
        id: 'bottom-comfort-span',
        badge: hasBrushed ? '👖 기모·밴딩 편안한 하의 트렌드' : '👖 스판·활동성 하의 트렌드',
        clicheAvoid: '정지된 바지 사진만 나열하거나 "편해요/인생바지" 같은 추상적 문구 반복 금지',
        formatTip: '0~3초 문제 제기 훅 + 즉각 워킹 → 중반 리얼 스쿼트(앉았다 일어나기)로 허벅지·무릎 편안함 실증 → 전신 핏 마무리',
        captionTip: '바지 실루엣과 신발 밑단을 가리지 않도록 [상단 배치] + 어떤 컬러에서도 잘 읽히는 [① 스모크 유리 바] 조합',
        timingTip: '1.2배속 경쾌한 템포 + 0.66초 크로스 페이드 (같은 문구 연속 유지로 시선 분산 차단)',
        bgmTip: '과한 클럽 비트보다 편안한 실착 무드에 맞춘 [🎸 어쿠스틱 카페 기타] 또는 [🎧 도심 칠아웃]',
        recommended: {
          presetId: 'bottom-sit-stand-span',
          captionStyle: 'reels-highlight',
          captionPosition: 'upper-title',
          videoSpeed: 1.2,
          transitionStyle: 'fade',
          builtinBgm: hasBrushed ? 'acoustic-cafe' : 'city-chill',
          includeSplitShowcase: colorCount >= 3,
        },
      };
    } else if (hasWideOrDenim) {
      profile = {
        id: 'bottom-wide-runway',
        badge: '👖 와이드·스트레이트 데님/팬츠 트렌드',
        clicheAvoid: '가까이서 바지만 찍어 비율이 안 보이는 구도, 정면 차렷 자세 고정 금지',
        formatTip: '무릎 높이 로우앵글에서 성큼성큼 4~5보 큰 보폭 워킹 → 90도 턴으로 바지 통 찰랑임과 롱다리 비율 증명',
        captionTip: '다리 전체가 시원하게 보이게 [상단 배치] + 깔끔한 [① 스모크 유리 바]로 핏 방해 최소화',
        timingTip: '1.2배속 리듬감 있는 보행 템포 + 부드러운 크로스 페이드 전환',
        bgmTip: '워킹 리듬과 맞물려 완주율을 높이는 [🔥 런웨이 딥 하우스 122 BPM]',
        recommended: {
          presetId: 'bottom-big-stride-walk',
          captionStyle: 'reels-highlight',
          captionPosition: 'upper-title',
          videoSpeed: 1.2,
          transitionStyle: 'fade',
          builtinBgm: 'runway-house',
          includeSplitShowcase: colorCount >= 3,
        },
      };
    } else {
      profile = {
        id: 'bottom-signature',
        badge: '👖 슬랙스·데일리 팬츠 트렌드',
        clicheAvoid: '허리~밑단 전체 핏을 숨기는 상반신 위주 컷과 느린 1.0배속 진행 금지',
        formatTip: '0.2초 즉시 전신 런웨이 워킹 스타트 → 45~90도 턴으로 골반·레그라인과 밑단 떨어짐 입체 확인',
        captionTip: '레그라인을 가리지 않는 [상단 배치] + 고급스러운 [② 웜 글래스 화보 카드]',
        timingTip: '1.2배속 깔끔한 전개 + 0.66초 크로스 페이드',
        bgmTip: '출근룩·데일리 슬랙스 톤에 어울리는 세련된 [🎧 도심 칠아웃 리듬 비트]',
        recommended: {
          presetId: 'bottom-fit-silhouette',
          captionStyle: 'shopping-card',
          captionPosition: 'upper-title',
          videoSpeed: 1.2,
          transitionStyle: 'fade',
          builtinBgm: 'city-chill',
          includeSplitShowcase: colorCount >= 3,
        },
      };
    }
  } else if (resolvedCat === 'outer') {
    if (hasLightPad) {
      profile = {
        id: 'outer-light-padding',
        badge: '🧥 경량 패딩·아우터 CF 트렌드',
        clicheAvoid: '무겁게 서 있기만 하는 컷, "가볍고 따뜻해요" 뻔한 한 줄 반복 금지',
        formatTip: '0~3초 무게 고민 문제 제기 훅 + 파워 워킹 스타트 → 180도 자락 스윙 턴으로 가벼운 볼륨과 어깨선 입체 증명',
        captionTip: '아우터 실루엣과 플랫폼 하단 UI를 모두 피하는 [안전 하단 위] + 시선 집중 [① 스모크 유리 바]',
        timingTip: '1.2배속 역동적 CF 템포 + 0.66초 크로스 페이드로 고급 화보 흐름 유지',
        bgmTip: '겨울 아우터 캠페인 몰입감을 끌어올리는 [🔥 런웨이 딥 하우스 122 BPM]',
        recommended: {
          presetId: 'top-outer-detail',
          captionStyle: 'reels-highlight',
          captionPosition: 'safe-lower',
          videoSpeed: 1.2,
          transitionStyle: 'fade',
          builtinBgm: 'runway-house',
          includeSplitShowcase: colorCount >= 3,
        },
      };
    } else {
      profile = {
        id: 'outer-premium-coat',
        badge: '🧥 프리미엄 자켓·코트 아우터 트렌드',
        clicheAvoid: '원단 두께감·라펠 디테일 없이 먼 전신만 짧게 스쳐 지나가는 편집 금지',
        formatTip: '당당한 2~3보 워킹 → 카라·라펠 손끝 정돈 & 180도 턴으로 자락 움직임과 고급 실루엣 강조',
        captionTip: '백화점 룩북 무드를 살리는 [② 웜 글래스 화보 카드] + [안전 하단 위]',
        timingTip: '1.15배속 절제된 럭셔리 템포 + 부드러운 크로스 페이드',
        bgmTip: '프리미엄 아우터의 가격 설득력을 높이는 [🎻 럭셔리 스트링 시네마]',
        recommended: {
          presetId: 'top-outer-detail',
          captionStyle: 'shopping-card',
          captionPosition: 'safe-lower',
          videoSpeed: 1.15,
          transitionStyle: 'fade',
          builtinBgm: 'luxury-strings',
          includeSplitShowcase: colorCount >= 3,
        },
      };
    }
  } else if (hasKnit) {
    profile = {
      id: 'top-knit-texture',
      badge: '🧶 니트·스웨터 원단 질감 트렌드',
      clicheAvoid: '짜임 조직을 안 보여주고 멀리서만 찍거나 밋밋한 텍스트 카드 나열 금지',
      formatTip: '45도 턴 오프닝 → 과감한 85mm 줌인 & 손끝 원단 터치로 케이블 짜임·포근한 두께감을 눈으로 체감 → 풀백 피니시',
      captionTip: '화보 감성을 살리는 [③ 시네마 센터 룩북] + [안전 하단 위]',
      timingTip: '1.15배속 우아한 템포 + 부드러운 크로스 페이드 (원단 결 감상 시간 확보)',
      bgmTip: '니트·울의 따뜻한 감성을 극대화하는 [🎻 럭셔리 스트링 시네마] 또는 [🎹 모던 피아노]',
      recommended: {
        presetId: 'top-fabric-macro',
        captionStyle: 'lookbook-center',
        captionPosition: 'safe-lower',
        videoSpeed: 1.15,
        transitionStyle: 'fade',
        builtinBgm: 'luxury-strings',
        includeSplitShowcase: colorCount >= 3,
      },
    };
  } else if (hasStretch) {
    profile = {
      id: 'top-active-stretch',
      badge: '👕 스판·기능성 액티브 상의 트렌드',
      clicheAvoid: '신축성을 말로만 적고 모델은 차렷 자세로 서 있는 뻔한 연출 금지',
      formatTip: '즉각 리듬 스텝 → 양팔 크게 벌리기·상체 60도 트위스트로 원단이 늘어났다 복원되는 신축성을 직접 증명',
      captionTip: '움직임 속에서도 1초 만에 읽히는 [① 스모크 유리 바] + [안전 하단 위]',
      timingTip: '1.2배속 경쾌한 액티브 템포 + 부드러운 크로스 페이드',
      bgmTip: '탄력 있는 액티브 컷과 딱 맞는 [🔥 런웨이 딥 하우스 122 BPM]',
      recommended: {
        presetId: 'top-stretch-span',
        captionStyle: 'reels-highlight',
        captionPosition: 'safe-lower',
        videoSpeed: 1.2,
        transitionStyle: 'fade',
        builtinBgm: 'runway-house',
        includeSplitShowcase: colorCount >= 3,
      },
    };
  } else if (hasBrushed || hasManyColors) {
    const useCitypop = hasManyColors && !hasBrushed;
    profile = {
      id: 'top-daily-brushed-color',
      badge: hasManyColors
        ? `👕 ${hasBrushed ? '기모 ' : ''}맨투맨·상의 (${colorCount}컬러) 트렌드`
        : '👕 기모 맨투맨·데일리 상의 트렌드',
      clicheAvoid: '"겨울 필수템/가성비 최고" 같은 뻔한 카피와 움직임 없는 정지 화보 나열 금지',
      formatTip: `0~3초 고민 제기 훅 + 0.2초 워킹 스타트 → 90도 턴으로 깔끔한 정핏·밑단 증명${hasManyColors ? ` → ${colorCount}가지 컬러 3분할 비교 컷으로 체류시간 극대화` : ''}`,
      captionTip: '다양한 옷 컬러 위에서도 선명하게 읽히는 [① 스모크 유리 바] + [안전 하단 위]',
      timingTip: '1.2배속(이탈률 방지 핵심) + 0.66초 크로스 페이드 & 동일 문구 연속 유지',
      bgmTip: useCitypop
        ? '다채로운 컬러 라인업을 산뜻하게 살리는 [✨ 트렌디 시티팝 바운스 116 BPM]'
        : (hasManyColors
          ? '포근한 기모와 다양한 컬러 무드를 동시에 살리는 [✨ 트렌디 시티팝 바운스] 또는 [🎸 어쿠스틱 카페 기타]'
          : '포근한 기모 데일리룩 완주율 1위 [🎸 어쿠스틱 카페 기타]'),
      recommended: {
        presetId: 'top-signature-lookbook',
        captionStyle: 'reels-highlight',
        captionPosition: 'safe-lower',
        videoSpeed: 1.2,
        transitionStyle: 'fade',
        builtinBgm: hasManyColors ? 'citypop-funk' : 'acoustic-cafe',
        includeSplitShowcase: colorCount >= 3,
      },
    };
  } else if (hasShirtCardigan) {
    profile = {
      id: 'top-shirt-cardigan',
      badge: '👔 셔츠·가디건·카라 데일리 트렌드',
      clicheAvoid: '정면 1장만 길게 끌어 지루해지는 룩북 구성 금지',
      formatTip: '가벼운 워킹 스타트 → 카라·앞여밈 손끝 정돈 & 180도 턴으로 단독·레이어드 실루엣 모두 노출',
      captionTip: '단정하고 신뢰감 주는 [② 웜 글래스 화보 카드] + [안전 하단 위]',
      timingTip: '1.2배속 경쾌한 리듬 + 부드러운 크로스 페이드',
      bgmTip: '세련된 오피스·카페룩 감성의 [☕ 선셋 로파이 재즈 92 BPM]',
      recommended: {
        presetId: 'top-outer-detail',
        captionStyle: 'shopping-card',
        captionPosition: 'safe-lower',
        videoSpeed: 1.2,
        transitionStyle: 'fade',
        builtinBgm: 'sunset-lofi',
        includeSplitShowcase: colorCount >= 3,
      },
    };
  } else {
    profile = {
      id: 'top-default-lookbook',
      badge: '👕 데일리 상의 릴스·쇼츠 트렌드',
      clicheAvoid: '3초 안에 아무 움직임 없는 정지 화면과 뻔한 상품명 나열 금지',
      formatTip: '0~3초 호기심·문제 제기 훅 + 0.2초 워킹 스타트 → 90도 턴과 카메라 접근 아이컨택으로 CF처럼 마무리',
      captionTip: '모바일 가독성 1위 [① 스모크 유리 바] + [안전 하단 위]',
      timingTip: '1.2배속 경쾌한 컷 전개 + 0.66초 크로스 페이드',
      bgmTip: '어떤 코디에도 자연스럽게 녹아드는 [☕ 선셋 로파이 재즈 92 BPM]',
      recommended: {
        presetId: 'top-signature-lookbook',
        captionStyle: 'reels-highlight',
        captionPosition: 'safe-lower',
        videoSpeed: 1.2,
        transitionStyle: 'fade',
        builtinBgm: 'sunset-lofi',
        includeSplitShowcase: colorCount >= 3,
      },
    };
  }

  const rec = profile.recommended;
  return {
    ...profile,
    recommended: {
      ...rec,
      presetLabel: FLOW_PRESETS[rec.presetId]?.label || rec.presetId,
      captionStyleLabel: CAPTION_STYLE_LABELS[rec.captionStyle] || rec.captionStyle,
      captionPositionLabel: CAPTION_POS_LABELS[rec.captionPosition] || rec.captionPosition,
      transitionLabel: TRANSITION_LABELS[rec.transitionStyle] || rec.transitionStyle,
      builtinBgmLabel: BUILTIN_BGM_PRESETS[rec.builtinBgm]?.label || rec.builtinBgm,
    },
  };
}
