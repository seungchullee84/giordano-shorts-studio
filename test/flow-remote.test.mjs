import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CAPTION_POSITION_KEYS, CAPTION_STYLE_KEYS, buildCaptionTimelineSpecs, buildGlobalMergedCaptions, normalizeVideoSpeed, resolveCaptionLayout} from '../lib/video-renderer.mjs';
import {generateHookMentions} from '../lib/hook-generator.mjs';
import {buildTrendStrategy} from '../lib/trend-engine.mjs';
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

test('스모크 유리 계열 자막 스타일 3종 고정 및 플랫폼 UI 회피 세로 위치 검증', () => {
  assert.equal(CAPTION_STYLE_KEYS.length, 3);
  assert.equal(CAPTION_POSITION_KEYS.length, 3);
  const def = resolveCaptionLayout();
  assert.equal(def.styleKey, 'reels-highlight');
  assert.equal(def.posKey, 'safe-lower');
  assert.equal(def.bottomPx, 310);
  const upper = resolveCaptionLayout({captionStyle: 'lookbook-center', captionPosition: 'upper-title'});
  assert.equal(upper.isCentered, true);
  assert.equal(upper.isUpper, true);
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
