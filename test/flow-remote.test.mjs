import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CAPTION_POSITION_KEYS, CAPTION_STYLE_KEYS, FRAME_LAYOUT_KEYS, buildCaptionTimelineSpecs, buildGlobalMergedCaptions, normalizeVideoSpeed, resolveCaptionLayout, resolveFrameLayout} from '../lib/video-renderer.mjs';
import {generateHookMentions} from '../lib/hook-generator.mjs';
import {buildTrendStrategy} from '../lib/trend-engine.mjs';
import {PLATFORM_URLS, runMultiPlatformPrepare} from '../lib/multi-upload-remote.mjs';
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
test('동영상 재생 속도 기본 1.3배속 및 안전 범위 검증', () => {
  assert.equal(normalizeVideoSpeed(undefined), 1.3);
  assert.equal(normalizeVideoSpeed(1.3), 1.3);
  assert.equal(normalizeVideoSpeed(1), 1);
  assert.equal(normalizeVideoSpeed(3.0), 1.75);
  assert.equal(normalizeVideoSpeed(0.2), 0.75);
});

test('스모크 유리 계열 자막 스타일 3종 · 상·하단 블랙 레터박스 및 모바일 UI 회피 검증', () => {
  assert.equal(CAPTION_STYLE_KEYS.length, 3);
  assert.equal(CAPTION_POSITION_KEYS.length, 3);
  assert.equal(FRAME_LAYOUT_KEYS.length, 3);
  const lb = resolveFrameLayout('letterbox-black');
  assert.equal(lb.key, 'letterbox-black');
  assert.equal(lb.topBarH, 195);
  assert.equal(lb.stageH, 1340);
  assert.equal(lb.bottomSafeH, 385);
  const th = resolveFrameLayout('top-header-full');
  assert.equal(th.topBarH, 355);
  assert.equal(th.stageH, 1565);

  const def = resolveCaptionLayout();
  assert.equal(def.styleKey, 'reels-highlight');
  assert.equal(def.posKey, 'safe-lower');
  assert.equal(def.frameLayout, 'letterbox-black');
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


test('개조식 공식 설명문(026980 패턴 ~제공/~연출) 핵심 소구점 자동 추출 검증', async () => {
  const desc = '베이직한 크루넥 디자인과 여유로운 레귤러 핏으로 편안한 착용감 제공 안정적인 기장감과 밑단 시보리로 깔끔하고 안정적인 실루엣 연출 260GSM 기모 테리 소재에 안쪽 기모 가공을 더해 부드럽고 포근한 착용감 제공';
  const factual = extractFactualSellingPoints(desc, 4);
  assert.ok(factual.length >= 3, '개조식 3문장이 모두 분리 추출되어야 합니다: ' + JSON.stringify(factual));
  const natural = await extractNaturalSellingPoints(desc, 4, '026980');
  assert.ok(natural.length >= 3, '026980 핵심 소구점이 3개 이상 추출되어야 합니다: ' + JSON.stringify(natural));
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

    // 추적 꼬리표(?NaPm=..., utm_*) 자동 제거 및 네이버 상품번호 추출 검증
    const dirtyUrl = 'https://shopping.naver.com/window-products/department/1234567890?NaPm=ct%3Dabc%7Cci%3Dshoppingwindow&utm_source=test';
    const cleanedUrl = normalizeHttpUrl(dirtyUrl);
    assert.equal(cleanedUrl, 'https://shopping.naver.com/window-products/department/1234567890');
    assert.equal(extractNaverProductId(cleanedUrl), '1234567890');

    // 구매 링크가 설명 하단이 아닌 상단(상품 정보·소구점보다 앞쪽)에 배치되는지 검증
    const topLinkKit = buildPublishKit({
      product: {style: '243801', name: '3팩 반팔 티셔츠', sellingPoints: ['면 100% 원단']},
      facts: {style: '243801', headline: '3팩 반팔 티셔츠', hookText: '국민 반팔티 3팩', productUrl: dirtyUrl},
      publishSettings: settings,
    });
    assert.ok(!topLinkKit.clip.body.includes('NaPm='), '추적 파라미터가 제거되어야 함');
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


test('3대 플랫폼 동시 자동 준비 URL 상수 및 완성 영상 누락 방어 검증', async () => {
  assert.equal(PLATFORM_URLS.clip, 'https://clipcreators.naver.com/web/upload');
  assert.equal(PLATFORM_URLS.youtube, 'https://studio.youtube.com/');
  assert.equal(PLATFORM_URLS.reels, 'https://www.instagram.com/');
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
  ];
  for (const id of requiredButtonIds) {
    assert.ok(
      appSource.includes(`'${id}'`) && appSource.includes('addEventListener'),
      `public/app.js에 버튼 이벤트 연결이 누락되었습니다: ${id}`
    );
  }
});
