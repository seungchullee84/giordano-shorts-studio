import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CAPTION_POSITION_KEYS, CAPTION_STYLE_KEYS, FRAME_LAYOUT_KEYS, buildCaptionTimelineSpecs, buildGlobalMergedCaptions, cancelActiveRender, isRenderCancelled, normalizeVideoSpeed, resolveCaptionLayout, resolveFrameLayout, resolveGarmentFocus, splitCaptionPhrases} from '../lib/video-renderer.mjs';
import {
  STUDIO_PREFS_DEFAULTS,
  loadStudioPreferencesSync,
  resolveEffectiveRenderOptions,
  resolveUploadVideoFilename,
  saveStudioPreferencesSync,
} from '../lib/studio-preferences.mjs';
import {generateHookMentions} from '../lib/hook-generator.mjs';
import {buildTrendStrategy} from '../lib/trend-engine.mjs';
import {
  PLATFORM_URLS,
  buildClipPlaceSearchQuery,
  buildClipShopSearchQueries,
  cancelMultiPlatformPrepare,
  extractNaverRegisteredProductTitle,
  isMultiPlatformCancelRequested,
  resolveNaverClipCategory,
  runMultiPlatformPrepare,
} from '../lib/multi-upload-remote.mjs';
import {buildPublishKit, buildStoreSearchUrl, extractNaverProductId, getSavedProductUrl, loadPublishSettingsSync, normalizeHttpUrl, saveProductUrlForStyle, savePublishSettings} from '../lib/publish-kit.mjs';
import {FLOW_PRESETS} from '../lib/flow-engine.mjs';
import {
  buildDriveFolderUrl,
  loadStorageSettingsSync,
  parseGoogleDriveFolderId,
  saveStorageSettings,
} from '../lib/storage-sync.mjs';
import {BUILTIN_BGM_PRESETS, generateBuiltinBgmWav} from '../lib/bgm-synth.mjs';
import {extractFactualSellingPoints, extractNaturalSellingPoints} from '../lib/product-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FLOW_CDP_PORT,
  cancelRemoteFlow,
  findSystemChrome,
  isRemoteFlowCancelRequested,
  runRemoteFlowPipeline,
} from '../lib/flow-remote.mjs';

test('flow-remote 기본 상수 및 취소 플래그 동작 검증', () => {
  assert.equal(FLOW_CDP_PORT, 9229);
  cancelRemoteFlow();
  assert.equal(isRemoteFlowCancelRequested(), true);
});

test('시스템 Chrome 경로 탐색 및 준비 이미지 누락 방어 검증', async () => {
  const chrome = findSystemChrome();
  assert.ok(chrome === null || typeof chrome === 'string');
  await assert.rejects(
    () => runRemoteFlowPipeline({
      profileDir: './data/test-profile',
      downloadsDir: './data/test-downloads',
      preparedImagePaths: [],
      promptText: '테스트',
    }),
    /준비되지 않았습니다/
  );
});
test('동영상 재생 속도 기본 1.2배속 및 안전 범위 검증', () => {
  assert.equal(normalizeVideoSpeed(undefined), 1.2);
  assert.equal(normalizeVideoSpeed(1.2), 1.2);
  assert.equal(normalizeVideoSpeed(1), 1);
  assert.equal(normalizeVideoSpeed(3.0), 1.75);
  assert.equal(normalizeVideoSpeed(0.2), 0.75);
});

test('스모크 유리 계열 자막 스타일 3종 · 상·하단 블랙 레터박스 및 모바일 UI 회피 검증', () => {
  assert.equal(CAPTION_STYLE_KEYS.length, 3);
  assert.equal(CAPTION_POSITION_KEYS.length, 3);
  assert.equal(FRAME_LAYOUT_KEYS.length, 4);
  const ws = resolveFrameLayout('white-studio');
  assert.equal(ws.key, 'white-studio');
  assert.equal(ws.topBarH, 165);
  assert.equal(ws.stageH, 1755);
  assert.equal(ws.bottomSafeH, 0);
  assert.equal(ws.isLightFrame, true);
  const lb = resolveFrameLayout('letterbox-black');
  assert.equal(lb.key, 'letterbox-black');
  assert.equal(lb.topBarH, 165);
  assert.equal(lb.stageH, 1755);
  assert.equal(lb.bottomSafeH, 0);
  const topFocus = resolveGarmentFocus('top');
  assert.equal(topFocus.videoCropYFactor, '0.02');
  const botFocus = resolveGarmentFocus('bottom');
  assert.equal(botFocus.videoCropYFactor, '0.92');
  assert.equal(botFocus.sharpPosition, 'south');
  const phrases = splitCaptionPhrases('지오다노 누적판매량 3천만장이상 국민 티셔츠 !');
  assert.ok(phrases.length >= 3 && phrases.length <= 5, '어절 팝 분할은 3~5박자여야 함');
  assert.ok(!phrases.includes('!'), '단독 기호는 앞 어절에 붙어야 함');
  const th = resolveFrameLayout('top-header-full');
  assert.equal(th.topBarH, 355);
  assert.equal(th.stageH, 1565);

  const def = resolveCaptionLayout();
  assert.equal(def.styleKey, 'reels-highlight');
  assert.equal(def.posKey, 'safe-lower');
  assert.equal(def.frameLayout, 'white-studio');
  assert.ok(def.bottomPx >= 460, '풀화면 폴백 시에도 모바일 하단 아이디 회피 높이(460px+) 확보');
  const upper = resolveCaptionLayout({captionStyle: 'lookbook-center', captionPosition: 'upper-title', frameLayout: 'fullscreen'});
  assert.equal(upper.isCentered, true);
  assert.equal(upper.isUpper, true);
  assert.equal(upper.frameLayout, 'fullscreen');
});

test('연속 동일 문구 자막은 끄지 않고 1개의 연속 자막으로 자동 병합 유지 검증', () => {
  const specs = [
    [{badge: '포인트 01', mainText: '포근한 기모 소재', subText: '', renderColorRow: false, startSec: 0.2, endSec: 2.1}],
    [{badge: '착용 룩북', mainText: '기모 긴팔티', subText: '34,800원', renderColorRow: false, startSec: 0.3, endSec: 2.0}],
    [{badge: '매장 실물 핏', mainText: '기모 긴팔티', subText: '34,800원', renderColorRow: false, startSec: 0.3, endSec: 2.0}],
    [{badge: '착용 룩북', mainText: '기모 긴팔티', subText: '34,800원', renderColorRow: false, startSec: 0.3, endSec: 2.0}],
  ];
  const wins = [
    {start: 0, duration: 2.5},
    {start: 1.9, duration: 2.5},
    {start: 3.8, duration: 2.5},
    {start: 5.7, duration: 2.5},
  ];
  const merged = buildGlobalMergedCaptions(specs, wins, 8.2);
  assert.equal(merged.length, 2, '동일 문구 3컷이 1개로 병합되어 총 2개 자막이어야 함');
  assert.equal(merged[1].mainText, '기모 긴팔티');
  assert.equal(merged[1].badge, '착용 룩북 · 매장 실물 핏');
  assert.ok(merged[1].endSec - merged[1].startSec >= 5.0, '병합된 자막이 3컷 전체 구간을 연속 유지해야 함');
  assert.ok(merged[0].endSec < merged[1].startSec, '서로 다른 자막끼리는 겹치지 않아야 함');
});


test('Google 드라이브 폴더 ID 파싱 · 설정 저장 · 로컬 복사 안전성 검증', async () => {
  const sampleId = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
  assert.equal(
    parseGoogleDriveFolderId(`https://drive.google.com/drive/folders/${sampleId}?usp=sharing`),
    sampleId
  );
  assert.equal(
    buildDriveFolderUrl(sampleId),
    `https://drive.google.com/drive/folders/${sampleId}`
  );

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shorts-storage-test-'));
  try {
    const saved = await saveStorageSettings(tmpDir, {
      autoCopyDesktop: true,
      autoSyncGoogleDrive: true,
      driveFolderUrl: `https://drive.google.com/drive/folders/${sampleId}`,
      driveFolderName: '지오다노_숏츠',
    });
    assert.equal(saved.driveFolderId, sampleId);
    const loaded = loadStorageSettingsSync(tmpDir);
    assert.equal(loaded.driveFolderName, '지오다노_숏츠');
    assert.equal(loaded.autoSyncGoogleDrive, true);
  } finally {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
});


test('개조식 공식 설명문(026980 패턴 ~제공/~연출) 및 긴 복문(374912 패턴) 핵심 소구점 자동 추출 검증', async () => {
  const desc = '베이직한 크루넥 디자인과 여유로운 레귤러 핏으로 편안한 착용감 제공 안정적인 기장감과 밑단 시보리로 깔끔하고 안정적인 실루엣 연출 260GSM 기모 테리 소재에 안쪽 기모 가공을 더해 부드럽고 포근한 착용감 제공';
  const factual = extractFactualSellingPoints(desc, 4);
  assert.ok(factual.length >= 3, '개조식 3문장이 모두 분리 추출되어야 합니다: ' + JSON.stringify(factual));
  const natural = await extractNaturalSellingPoints(desc, 4, '026980');
  assert.ok(natural.length >= 3, '026980 핵심 소구점이 3개 이상 추출되어야 합니다: ' + JSON.stringify(natural));

  const desc374912 = '아웃포켓 초경량 베스트 입니다 베이직한 실루엣으로 전체적으로 클래식한 일자 퀼팅으로 디자인 되었으며 입체적인 패턴을 사용하여 더욱더 세련된 핏감을 선사합니다 아웃포켓 디테일과 광택 처리된 유광 스냅 여밈으로 캐주얼 하면서도 트렌디한 무드를 느낄 수 있으며 하이넥 디테일과 밑단 안쪽 밴딩을을 넣어 스모킹 처리하여 외부의 차가운 공기를 효과적으로 차단해 줄 수 있도록 디자인 되었습니다 충전재로 안전성 기준 및 동물 학대와 관련된 행위를 하지 않은 RDS인증이 된 프리미엄 90:10 다운을 사용 하였으며, 밀착력과 보온성이 우수하고 가볍습니다. 브라이트 원사가 가미된 나일론 고밀도 원단 사용으로 전체적으로 겉면에 은은한 광택감이 흘러 고급스러움을 느낄 수 있으며, 원단 안쪽면에 WR 다운 프루프 가공과 함께 고밀도 다운백을 이중으로 덧대어 깃털 빠짐을 최소화 하였습니다. 늦은 가을부터 겨울까지 가볍고 보온성이 좋아 데일리로 편안하게 걸쳐 입기 좋으며, 여러 아이템과 다양하게 스타일 연출이 가능합니다.';
  const pts374912 = await extractNaturalSellingPoints(desc374912, 4, '999999');
  assert.ok(pts374912.length >= 3, '374912 긴 복문에서 소구점 3개 이상 추출되어야 합니다: ' + JSON.stringify(pts374912));
  assert.ok(pts374912.some(p => /90:10|다운|보온/.test(p)), 'RDS 90:10 다운/보온 소구점이 포함되어야 합니다');
  assert.ok(pts374912.some(p => /깃털|다운백|차단/.test(p)), '깃털 빠짐 방지 또는 찬바람 차단 소구점이 포함되어야 합니다');
  assert.ok(pts374912.every(p => !/을을/.test(p) && !/(?:하여|으며)$/.test(p)), '중복 조사 오타나 미완성 끊김이 없어야 합니다');
});

test('내장 저작권 무료 BGM 8종(무음 제외) 프리셋 정의 및 WAV 합성 검증', async () => {
  const keys = Object.keys(BUILTIN_BGM_PRESETS).filter(k => k !== 'none');
  assert.equal(keys.length, 8);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shorts-bgm8-test-'));
  try {
    for (const key of ['runway-house', 'acoustic-cafe', 'sunset-lofi', 'citypop-funk', 'luxury-strings']) {
      const outWav = path.join(tmpDir, `${key}.wav`);
      await generateBuiltinBgmWav(key, outWav, 8);
      const st = fs.statSync(outWav);
      assert.ok(st.size > 100000, `${key} WAV 파일이 정상 합성되어야 합니다`);
    }
  } finally {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
});


test('팩트 기반 3초 후킹 멘트 10종 생성 및 첫 3초 오프닝 자막 반영 검증', () => {
  const hooks = generateHookMentions({
    product: {
      style: '026980',
      name: '기모 테리 맨투맨 티셔츠',
      consumerPrice: 21800,
      material: '면60%, 폴리에스터40%',
      colors: Array.from({length: 25}, (_, i) => ({name: '컬러' + i})),
      sellingPoints: ['안쪽 기모 가공을 더해 포근.', '밑단 시보리로 깔끔한 실루엣 연출'],
    },
    garmentCategory: 'top',
  });
  assert.equal(hooks.length, 10);
  assert.ok(hooks[0].text.includes('기모'));
  assert.ok(hooks.some(h => h.text.includes('25가지')));
  assert.ok(hooks.every(h => !/최저가|역대급|품절대란/.test(h.text)));

  // 후킹 멘트 적용 시 첫 0~3초 메인 자막이 후킹 멘트로 들어가고 기존 소구점 1번도 누락 없이 이어져야 함
  const withHook = buildCaptionTimelineSpecs(
    [{duration: 12, asset: {mediaType: 'video', kind: 'flow'}}],
    {
      style: '026980',
      headline: '기모 테리 맨투맨',
      price: '21,800원',
      hookText: hooks[0].text,
      sellingPoints: ['안쪽 기모 가공을 더해 포근.', '깔끔한 실루엣 연출'],
      showPrice: true,
      showColors: false,
    }
  );
  assert.equal(withHook[0][0].mainText, hooks[0].text);
  assert.equal(withHook[0][0].subText, '기모 테리 맨투맨 · 21,800원');
  assert.equal(withHook[0][1].mainText, '안쪽 기모 가공을 더해 포근.');

  // 후킹 멘트를 비우면 기존처럼 상품명이 메인 자막으로 시작
  const withoutHook = buildCaptionTimelineSpecs(
    [{duration: 12, asset: {mediaType: 'video', kind: 'flow'}}],
    {
      style: '026980',
      headline: '기모 테리 맨투맨',
      price: '21,800원',
      hookText: '',
      sellingPoints: ['안쪽 기모 가공을 더해 포근.'],
      showPrice: true,
      showColors: false,
    }
  );
  assert.equal(withoutHook[0][0].mainText, '기모 테리 맨투맨');
});


test('카테고리별 트렌드 저격 6종 원클릭 자동 세팅 정합성 검증', () => {
  const cases = [
    {
      name: '기모 테리 맨투맨 티셔츠',
      colors: Array.from({length: 25}, (_, i) => ({name: 'c' + i})),
      sellingPoints: ['안쪽 기모 가공'],
      expectPos: 'safe-lower',
      expectBgm: 'citypop-funk',
    },
    {
      name: '기모 테리 트레이닝 팬츠',
      colors: [{name: '오트밀'}, {name: '블랙'}],
      sellingPoints: ['허리 밴드와 스트링', '안쪽 기모 처리'],
      expectPos: 'upper-title',
      expectBgm: 'acoustic-cafe',
    },
    {
      name: 'CLOUD LIGHT 경량 패딩 자켓',
      colors: [{name: '블랙'}, {name: '아이보리'}, {name: '카키'}],
      sellingPoints: ['가벼운 경량 충전재'],
      expectPos: 'safe-lower',
      expectBgm: 'runway-house',
    },
    {
      name: '울혼방 케이블 피셔맨 스웨터',
      colors: [{name: '그레이'}, {name: '네이비'}],
      sellingPoints: ['입체 케이블 짜임'],
      expectPos: 'safe-lower',
      expectBgm: 'luxury-strings',
    },
  ];

  for (const c of cases) {
    const st = buildTrendStrategy({product: c});
    const r = st.recommended;
    assert.ok(FLOW_PRESETS[r.presetId], '추천 프리셋 ID가 유효해야 함: ' + r.presetId);
    assert.ok(BUILTIN_BGM_PRESETS[r.builtinBgm], '추천 BGM ID가 유효해야 함: ' + r.builtinBgm);
    assert.ok(CAPTION_STYLE_KEYS.includes(r.captionStyle));
    assert.ok(CAPTION_POSITION_KEYS.includes(r.captionPosition));
    assert.equal(r.captionPosition, c.expectPos);
    assert.equal(r.builtinBgm, c.expectBgm);
    assert.ok(st.clicheAvoid && st.formatTip && st.captionTip && st.timingTip && st.bgmTip);
  }
});


test('네이버 클립 · 유튜브 쇼츠 · 인스타 릴스 3대 플랫폼 배포 문구 및 스토어 URL 연동 검증', async () => {
  const sampleUrl = 'https://shopping.naver.com/window/department/store/000000000';
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shorts-publish-test-'));
  try {
    const saved = await savePublishSettings(tmpDir, {
      storeName: '동탄롯데 지오다노',
      storeUrl: sampleUrl,
    });
    assert.equal(saved.storeUrl, sampleUrl);
    const loaded = loadPublishSettingsSync(tmpDir);
    const kit = buildPublishKit({
      product: {
        style: '026980',
        name: '기모 테리 맨투맨 티셔츠',
        consumerPrice: 21800,
        material: '면60%, 폴리에스터40%',
        colors: [{name: '블랙'}, {name: '오트밀'}],
        sellingPoints: ['안쪽 기모 가공을 더해 포근.'],
      },
      facts: {
        style: '026980',
        headline: '기모 테리 맨투맨 티셔츠',
        price: '21,800원',
        hookText: '두꺼운 옷은 둔하고 얇으면 춥다면? 안감 기모 맨투맨 어때요',
      },
      publishSettings: loaded,
    });
    assert.equal(kit.effectiveUrl, sampleUrl);
    assert.ok(kit.clip.body.includes(sampleUrl));
    assert.ok(kit.shorts.title.includes('#Shorts'));
    assert.ok(kit.shorts.description.includes(sampleUrl));
    assert.ok(kit.shorts.pinnedComment.includes(sampleUrl));
    assert.ok(kit.reels.caption.includes('026980'));
    assert.ok(kit.reels.caption.includes(sampleUrl));
  } finally {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
});


test('품번별 개별 상품 URL 영구 기억 · 통합 스토어 폴백 · 스토어 검색 링크 검증', async () => {
  const baseStore = 'https://shopping.naver.com/window/department/store/000000000';
  const prodUrl = 'https://shopping.naver.com/window/department/store/000000000/products/999999999';
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shorts-produrl-test-'));
  try {
    await savePublishSettings(tmpDir, {storeUrl: baseStore});
    await saveProductUrlForStyle(tmpDir, '026980', prodUrl);
    assert.equal(getSavedProductUrl(tmpDir, '026980'), prodUrl);
    assert.equal(getSavedProductUrl(tmpDir, '416971'), '');

    const settings = loadPublishSettingsSync(tmpDir);
    const kitWithProd = buildPublishKit({product: {style: '026980', name: '맨투맨'}, facts: {style: '026980'}, publishSettings: settings});
    assert.equal(kitWithProd.effectiveUrl, prodUrl);
    assert.equal(kitWithProd.usingProductUrl, true);
    assert.ok(kitWithProd.clip.body.includes(prodUrl));

    // 추적 꼬리표(?NaPm=..., ?nl-query=..., utm_*, #hash) 자동 제거 및 네이버 상품번호 추출 검증
    const dirtyUrl = 'https://shopping.naver.com/window-products/department/1234567890?NaPm=ct%3Dabc%7Cci%3Dshoppingwindow&nl-query=%EC%A7%80%EC%98%A4%EB%8B%A4%EB%85%B8&utm_source=test#top';
    const cleanedUrl = normalizeHttpUrl(dirtyUrl);
    assert.equal(cleanedUrl, 'https://shopping.naver.com/window-products/department/1234567890');
    assert.equal(extractNaverProductId(cleanedUrl), '1234567890');
    assert.equal(
      normalizeHttpUrl('https://smartstore.naver.com/demo/products/1234567890?n_media=123&catId=99'),
      'https://smartstore.naver.com/demo/products/1234567890'
    );
    assert.equal(normalizeHttpUrl('https://naver.me/AbCdEf12'), 'https://naver.me/AbCdEf12');

    // 구매 링크가 설명 하단이 아닌 상단(상품 정보·소구점보다 앞쪽)에 배치되는지 검증
    const topLinkKit = buildPublishKit({
      product: {style: '243801', name: '3팩 반팔 티셔츠', sellingPoints: ['면 100% 원단']},
      facts: {style: '243801', headline: '3팩 반팔 티셔츠', hookText: '국민 반팔티 3팩', productUrl: dirtyUrl},
      publishSettings: settings,
    });
    assert.ok(!topLinkKit.clip.body.includes('NaPm='), '추적 파라미터가 제거되어야 함');
    assert.ok(topLinkKit.clip.body.startsWith('#지오다노 #동탄롯데백화점'), '클립 본문은 해시태그가 가장 먼저 나와야 함');
    assert.ok(topLinkKit.shorts.description.startsWith('#지오다노 #동탄롯데백화점'), '쇼츠 본문은 해시태그가 가장 먼저 나와야 함');
    assert.ok(topLinkKit.reels.caption.startsWith('#지오다노 #동탄롯데백화점'), '릴스 본문은 해시태그가 가장 먼저 나와야 함');
    assert.ok(topLinkKit.clip.body.indexOf(cleanedUrl) < topLinkKit.clip.body.indexOf('국민 반팔티 3팩'), '클립 구매링크가 후킹 멘트보다 먼저 나와야 함');
    assert.ok(topLinkKit.clip.body.indexOf(cleanedUrl) < topLinkKit.clip.body.indexOf('• 품번:'), '클립 구매링크가 상품 정보보다 위에 있어야 함');
    assert.ok(topLinkKit.shorts.description.indexOf(cleanedUrl) < topLinkKit.shorts.description.indexOf('[상품 정보'), '쇼츠 구매링크가 상품 정보보다 위에 있어야 함');
    assert.ok(topLinkKit.reels.caption.indexOf(cleanedUrl) < topLinkKit.reels.caption.indexOf('지오다노 3팩'), '릴스 구매링크가 상품 상세보다 위에 있어야 함');

    const kitFallback = buildPublishKit({product: {style: '416971', name: '팬츠'}, facts: {style: '416971'}, publishSettings: settings});
    assert.equal(kitFallback.effectiveUrl, baseStore);
    assert.equal(kitFallback.usingProductUrl, false);
    assert.equal(buildStoreSearchUrl(baseStore, '416971'), baseStore);
  } finally {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
});


test('반팔 티셔츠 해시태그 정확도 (셔츠 오분류 및 #오오티디 제거 검증)', () => {
  const teeKit = buildPublishKit({
    product: {style: '016901', name: '남성 코튼 반팔 티셔츠', gender: '남성', material: '면 100%'},
    facts: {style: '016901', headline: '남성 코튼 반팔 티셔츠'},
  });
  assert.ok(teeKit.clip.body.includes('#지오다노 #동탄롯데백화점'), '클립에 기본 고정 해시태그가 포함되어야 합니다: ' + teeKit.clip.body);
  assert.ok(teeKit.shorts.description.includes('#지오다노 #동탄롯데백화점'), '쇼츠에 기본 고정 해시태그가 포함되어야 합니다: ' + teeKit.shorts.description);
  assert.ok(teeKit.reels.caption.includes('#지오다노 #동탄롯데백화점'), '릴스에 기본 고정 해시태그가 포함되어야 합니다: ' + teeKit.reels.caption);
  assert.ok(teeKit.clip.body.includes('#지오다노반팔티'), teeKit.clip.body);
  assert.ok(teeKit.clip.body.includes('#남자반팔티'), teeKit.clip.body);
  assert.ok(!teeKit.clip.body.includes('#셔츠'), '반팔 티셔츠에 셔츠 태그가 들어가면 안 됩니다: ' + teeKit.clip.body);
  assert.ok(!teeKit.clip.body.includes('#오오티디'), '오오티디 태그가 들어가면 안 됩니다: ' + teeKit.clip.body);
  assert.ok(!teeKit.reels.caption.includes('#오오티디') && !teeKit.reels.caption.includes('#패션릴스'));

  const shirtKit = buildPublishKit({
    product: {style: '046910', name: '옥스포드 긴팔 셔츠', gender: '남성', material: '면 100%'},
    facts: {style: '046910', headline: '옥스포드 긴팔 셔츠'},
  });
  assert.ok(shirtKit.clip.body.includes('#긴팔') || shirtKit.clip.body.includes('#지오다노셔츠'));
});


test('3대 플랫폼 동시 자동 준비 URL 상수 · 클립 카테고리 매칭 · 완성 영상 누락 방어 검증', async () => {
  assert.equal(PLATFORM_URLS.clip, 'https://clipcreators.naver.com/web/upload');
  assert.equal(PLATFORM_URLS.youtube, 'https://studio.youtube.com/');
  assert.equal(PLATFORM_URLS.reels, 'https://www.instagram.com/');
  assert.deepEqual(resolveNaverClipCategory({gender: '공용', headline: '3팩 반팔 티셔츠 패키지 (공용)'}), {primary: '패션', secondary: '패션'});
  assert.deepEqual(resolveNaverClipCategory({gender: '남성', headline: '남성 코튼 크루넥 맨투맨'}), {primary: '패션', secondary: '남성 데일리룩'});
  assert.deepEqual(resolveNaverClipCategory({gender: '여성', headline: '여성 케이블 니트 가디건'}), {primary: '패션', secondary: '여성 데일리룩'});
  assert.deepEqual(resolveNaverClipCategory({gender: '남성', headline: '남성 발열내의 타이즈'}), {primary: '패션', secondary: '언더웨어'});
  assert.deepEqual(resolveNaverClipCategory({gender: '공용', headline: '코튼 볼캡 모자'}), {primary: '패션', secondary: '잡화, 소품'});
  assert.equal(
    extractNaverRegisteredProductTitle('백화점 : 네이버+ 스토어 : 상품상세 : 지오다노 여성 기모 일자 겨울 트레이닝 바지 16971', ''),
    '지오다노 여성 기모 일자 겨울 트레이닝 바지 16971'
  );
  assert.equal(
    extractNaverRegisteredProductTitle('', '이런 상품 어때요? 지오다노 3팩 반팔 티셔츠'),
    '지오다노 3팩 반팔 티셔츠'
  );
  const shopQueries = buildClipShopSearchQueries({
    storeName: '동탄롯데 지오다노',
    style: '416971',
    headline: '기모 테리 트레이닝 팬츠',
    registeredTitle: '지오다노 여성 기모 일자 겨울 트레이닝 바지 16971',
  });
  assert.equal(shopQueries[0], '지오다노 여성 기모 일자 겨울 트레이닝 바지 16971');
  assert.ok(shopQueries.every(q => q.length <= 40), '클립 검색어는 40자 이하여야 합니다');
  assert.ok(shopQueries.some(q => q.includes('16971')), '변형 5자리 품번 폴백 검색어가 포함되어야 합니다');
  assert.equal(buildClipPlaceSearchQuery('동탄롯데 지오다노'), '지오다노 롯데백화점 동탄점');
  await assert.rejects(
    () => runMultiPlatformPrepare({platforms: ['youtube'], videoPath: ''}),
    /완성된 숏츠 영상/
  );
});


test('핵심 UI 버튼 이벤트 리스너 전수 연결 검증 (무반응 버튼 원천 차단)', () => {
  const appSource = fs.readFileSync(path.resolve('public/app.js'), 'utf8');
  const requiredButtonIds = [
    'previewBgmBtn',
    'addLibraryBgmBtn',
    'openBgmFolderBtn',
    'toggleHookPickerBtn',
    'clearHookBtn',
    'toggleTrendDetailBtn',
    'applyTrendBtn',
    'pasteProductUrlBtn',
    'clearProductUrlBtn',
    'copyPublishTitleBtn',
    'copyPublishBodyBtn',
    'copyPublishCommentBtn',
    'resetPublishTextBtn',
    'multiUploadLoginBtn',
    'multiUploadPrepareBtn',
    'frameWhiteBtn',
    'frameBlackBtn',
    'globalStopBtn',
    'refreshPageBtn',
  ];
  for (const id of requiredButtonIds) {
    assert.ok(
      appSource.includes(`'${id}'`) && appSource.includes('addEventListener'),
      `public/app.js에 버튼 이벤트 연결이 누락되었습니다: ${id}`
    );
  }
  cancelActiveRender();
  assert.equal(isRenderCancelled(), true);
  cancelMultiPlatformPrepare();
  assert.equal(isMultiPlatformCancelRequested(), true);
});


test('화이트·블랙 버전 영구 저장 및 전 영상 렌더링 옵션(배속·상의/하의 포커스) 통합 검증', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-prefs-'));
  try {
    // 1) 초기 기본값: 화이트 버전 + 1.2배속
    const init = loadStudioPreferencesSync(tmpDir);
    assert.equal(init.frameLayout, STUDIO_PREFS_DEFAULTS.frameLayout);
    assert.equal(init.frameLayout, 'white-studio');
    assert.equal(init.videoSpeed, 1.2);

    // 2) 블랙 버전 전환 저장 후 재로드 유지
    const savedBlack = saveStudioPreferencesSync(tmpDir, {frameLayout: 'letterbox-black'});
    assert.equal(savedBlack.frameLayout, 'letterbox-black');
    assert.equal(loadStudioPreferencesSync(tmpDir).frameLayout, 'letterbox-black');

    // 3) 전 경로 옵션 정규화: 세션 옵션이 비어있어도 영구 저장된 블랙 버전 유지 + 하의 포커스 전달
    const effBottom = resolveEffectiveRenderOptions({}, {garmentCategory: 'bottom'}, tmpDir);
    assert.equal(effBottom.frameLayout, 'letterbox-black');
    assert.equal(effBottom.videoSpeed, 1.2);
    assert.equal(effBottom.garmentCategory, 'bottom');

    // 4) 다시 화이트 버전으로 전환 저장 후 상의(auto) 처리 검증
    saveStudioPreferencesSync(tmpDir, {frameLayout: 'white-studio', videoSpeed: 1.2});
    const effWhite = resolveEffectiveRenderOptions({frameLayout: 'invalid-key'}, {garmentCategory: 'auto'}, tmpDir);
    assert.equal(effWhite.frameLayout, 'white-studio');
    assert.equal(effWhite.garmentCategory, undefined);

    // 5) 구버전 브라우저 탭이 explicitPreview 없이 옛날 파일명을 보내도 무시하고 현재 품번 최신 파일 강제 선택
    const fakeOutputs = [
      {filename: '243801_demo_20261125_101456.mp4'},
      {filename: '243801_demo_20261124_184709.mp4'},
    ];
    assert.equal(
      resolveUploadVideoFilename({
        outputsList: fakeOutputs,
        style: '243801',
        lastOutputFilename: '243801_demo_20261124_184709.mp4',
        requestedFilename: '243801_demo_20261124_184709.mp4',
        explicitPreview: false,
      }),
      '243801_demo_20261125_101456.mp4'
    );
    // 명시적으로 목록에서 다른 영상을 클릭한 경우(explicitPreview: true)만 해당 영상 허용
    assert.equal(
      resolveUploadVideoFilename({
        outputsList: fakeOutputs,
        style: '243801',
        requestedFilename: '243801_demo_20261124_184709.mp4',
        explicitPreview: true,
      }),
      '243801_demo_20261124_184709.mp4'
    );
  } finally {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
});


test('제작 진행 폴링 시 미리보기·필름스트립·완성목록 무깜박임 DOM 가드 및 미디어 캐시 검증', () => {
  const appSource = fs.readFileSync(path.resolve('public/app.js'), 'utf8');
  const serverSource = fs.readFileSync(path.resolve('server.mjs'), 'utf8');
  assert.ok(appSource.includes('screen.dataset.mediaKey === mediaKey'), 'renderPreview는 동일 미디어 시 DOM을 재생성하면 안 됩니다');
  assert.ok(appSource.includes('wrap.dataset.sig === sig'), 'renderFilmStrip은 동일 자산 시그니처 시 DOM을 재생성하면 안 됩니다');
  assert.ok(appSource.includes('listEl.dataset.sig !== outputsSig'), 'outputsList는 목록 변경 시에만 갱신되어야 합니다');
  assert.ok(appSource.includes('let pollInFlight = false;'), '폴링 중복 요청 방지 가드가 있어야 합니다');
  assert.ok(appSource.includes('function ensurePolling()'), 'triggerRender 등에서 중복 즉시 조회 없이 폴링만 시작해야 합니다');
  assert.ok(serverSource.includes('private, max-age=300'), '버전 쿼리(?v=)가 있는 미디어는 브라우저 캐시를 허용해야 합니다');
  assert.ok(serverSource.includes('[getDesktopBgmDir(), getInternalBgmDir(dataDir)]'), '내 음악 미리듣기는 바탕화면·내부 BGM 폴더를 허용해야 합니다');
  assert.ok(serverSource.includes('[bgmPreviewCacheDir]'), '내장 BGM 미리듣기는 bgmPreviewCacheDir를 허용해야 합니다');
  const rendererSource = fs.readFileSync(path.resolve('lib/video-renderer.mjs'), 'utf8');
  assert.ok(rendererSource.includes('rgba(255, 255, 255, 0.58)'), '화이트 버전 자막 카드는 반투명 슬림 글래스(58%)를 유지해야 합니다');
  assert.ok(rendererSource.includes('Math.max(385, frame.bottomSafeH + 185)'), '화이트·블랙 자막 기본 하단 높이는 옷 시야 확보(385px)를 유지해야 합니다');
});
