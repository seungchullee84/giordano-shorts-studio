import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {extractFactualSellingPoints, koreanizeApparelCopy, loadProductByInput, parseStyleOrUrl, selectDiverseModelShots} from '../lib/product-loader.mjs';
import {loadLocalMannequinAndVideos} from '../lib/local-mannequin-loader.mjs';
import {createOfficialCutout} from '../lib/cutout.mjs';
import {FLOW_PRESETS, buildFlowPrompt, classifyGarmentCategory, estimateFlowCredits, prepareFlowReferenceImage} from '../lib/flow-engine.mjs';
import {buildAutoClipPlan, probeMedia, renderShortsVideo} from '../lib/video-renderer.mjs';
import {findFFmpegTools} from '../lib/runtime.mjs';

test('품번 및 공식몰 주소 검증', () => {
  assert.deepEqual(parseStyleOrUrl('375908'), {style: '375908', url: null});
  assert.throws(() => parseStyleOrUrl('https://example.com/shop/detail.php?pno=1'));
  assert.throws(() => parseStyleOrUrl('abc'));
});

test('거짓 정보 금지 및 외래어 한글 순화 원칙 검증', () => {
  assert.deepEqual(extractFactualSellingPoints(''), []);
  const pts = extractFactualSellingPoints('20수 코튼 100% 소재로 탄탄한 착용감을 제공합니다. 실측사이즈 참고하여 구매 부탁드립니다.');
  assert.equal(pts.length, 1);
  assert.match(pts[0], /20수 면/);
  assert.equal(koreanizeApparelCopy('브러시드 테리 원단으로 포근해요.'), '부드러운 기모 원단으로 포근해요.');
  assert.equal(koreanizeApparelCopy('보온성과 복원력이 뛰어난 PTT 충전재예요.'), '보온성과 복원력이 뛰어난 경량 보온 충전재예요.');
});

test('Google Flow Omni Flash 1.2 크레딧 계산 및 한국어 원본 보존 프롬프트·프리셋', () => {
  assert.equal(Object.keys(FLOW_PRESETS).length, 30, '연출 프리셋은 30종이어야 합니다');
  assert.equal(estimateFlowCredits('omni-1.2-720p', 10), 30);
  assert.equal(estimateFlowCredits('omni-1.2-360p', 10), 10);
  assert.equal(estimateFlowCredits('veo-3.1-lite', 8), 5);
  const {promptEn} = buildFlowPrompt({
    product: {name: '코튼 크루넥 티셔츠', material: '면 100%'},
    assets: [{kind: 'official', mediaType: 'image'}, {kind: 'mannequin', mediaType: 'image'}],
    modelId: 'omni-1.2-720p',
    durationSec: 10,
    presetId: 'top-360-spin',
    customDirection: '어깨선 자연스럽게 강조',
  });
  assert.match(promptEn, /원본 절대 보존 원칙/);
  assert.match(promptEn, /매장 마네킨/);
  assert.match(promptEn, /360도 한 바퀴/);
  assert.match(promptEn, /어깨선 자연스럽게 강조/);
  assert.match(promptEn, /자막.*워터마크/);
});

test('상의 · 아우터 · 하의 자동 구분 및 부위별 맞춤 프롬프트 생성 검증', () => {
  assert.equal(classifyGarmentCategory({name: 'NEW 기모 테리 스트레이트 스웻 팬츠'}), 'bottom');
  assert.equal(classifyGarmentCategory({name: '경량 다운 푸퍼 점퍼'}), 'outer');
  assert.equal(classifyGarmentCategory({name: '옥스포드 셔츠'}), 'top');

  const topCount = Object.values(FLOW_PRESETS).filter(p => p.garmentGroup === 'top').length;
  const bottomCount = Object.values(FLOW_PRESETS).filter(p => p.garmentGroup === 'bottom').length;
  assert.equal(topCount, 15);
  assert.equal(bottomCount, 15);

  const bottomPrompt = buildFlowPrompt({
    product: {name: 'NEW 기모 테리 스트레이트 스웻 팬츠', gender: '남성', material: '면 60%, 폴리에스터 40%'},
    assets: [{kind: 'official', mediaType: 'image'}],
    presetId: 'bottom-sit-stand-span',
  });
  assert.equal(bottomPrompt.resolvedCategory, 'bottom');
  assert.match(bottomPrompt.promptEn, /\[하의 주인공 · 구도 고정\]/);
  assert.match(bottomPrompt.promptEn, /앉았다/);
  assert.match(bottomPrompt.promptEn, /남성용 의류/);
  assert.doesNotMatch(bottomPrompt.promptEn, /소매 통/);

  const topPrompt = buildFlowPrompt({
    product: {name: '코튼 크루넥 니트', gender: '여성'},
    assets: [{kind: 'official', mediaType: 'image'}],
    presetId: 'top-stretch-span',
  });
  assert.equal(topPrompt.resolvedCategory, 'top');
  assert.match(topPrompt.promptEn, /\[상의 주인공 · 구도 고정\]/);
  assert.match(topPrompt.promptEn, /여성용 의류/);
});

test('서로 다른 컬러 3장 우선 선별 및 단일 컬러 폴백 검증', () => {
  // 1) 서로 다른 컬러가 있는 경우
  const multi = selectDiverseModelShots([
    {id: 'a1', colorProfile: {r: 20, g: 20, b: 25}},    // 블랙
    {id: 'a2', colorProfile: {r: 25, g: 22, b: 28}},    // 블랙(유사)
    {id: 'b1', colorProfile: {r: 230, g: 225, b: 215}}, // 아이보리
    {id: 'c1', colorProfile: {r: 140, g: 90, b: 75}},   // 브라운
  ], 3);
  const activeMulti = multi.filter(x => x.enabled);
  assert.deepEqual(activeMulti.map(x => x.id), ['a1', 'b1', 'c1']);

  // 2) 모두 같은 컬러인 경우에도 3장 모두 정상 수집
  const same = selectDiverseModelShots([
    {id: 's1', colorProfile: {r: 30, g: 30, b: 32}},
    {id: 's2', colorProfile: {r: 34, g: 32, b: 35}},
    {id: 's3', colorProfile: {r: 28, g: 29, b: 31}},
  ], 3);
  assert.equal(same.filter(x => x.enabled).length, 3);
});

test('등록기 연동 품번(375908)에서 서로 다른 컬러 모델 착용 컷 3장 자동 선별 검증', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'giordano-load-test-'));
  try {
    const loaded = await loadProductByInput('375908', tmpDir);
    assert.equal(loaded.product.style, '375908');
    const active = loaded.assets.filter(a => a.enabled);
    assert.equal(active.length, 3, `기본 활성 모델 컷이 3장이어야 합니다 (실제: ${active.length}장)`);
    assert.ok(loaded.assets.length >= 3);
  } finally {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
});

test('상품등록기사진폴더(116958, 375908) 마네킨 정면 2~4장 및 상품영상 자동 수집 검증', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'giordano-mannequin-test-'));
  try {
    const p1 = await loadLocalMannequinAndVideos('116958', path.join(tmpDir, '116958'));
    const active1 = p1.mannequinAssets.filter(a => a.enabled);
    assert.ok(active1.length >= 2 && active1.length <= 4, `116958 마네킨 정면 선별은 2~4장이어야 합니다 (실제: ${active1.length}장)`);

    const p2 = await loadLocalMannequinAndVideos('375908', path.join(tmpDir, '375908'));
    const active2 = p2.mannequinAssets.filter(a => a.enabled);
    assert.ok(active2.length >= 2 && active2.length <= 4, `375908 마네킨 정면 선별은 2~4장이어야 합니다 (실제: ${active2.length}장)`);
    assert.ok(p2.videoAssets.length >= 1, '375908 상품영상 폴더 영상도 자동 발견되어야 합니다');
  } finally {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
});

test('공식몰 로컬 무료 누끼 + 9:16 준비 + 실제 FFmpeg 숏츠 렌더링 통합 검증', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'giordano-shorts-test-'));
  try {
    // 1. 스튜디오 배경(흰색) + 중앙 의류(네이비 사각형) 테스트 원본 이미지 생성
    const origPath = path.join(tmpDir, 'sample-official.jpg');
    const svg = Buffer.from(`
      <svg width="600" height="800" xmlns="http://www.w3.org/2000/svg">
        <rect width="600" height="800" fill="#f7f7f7"/>
        <rect x="170" y="180" width="260" height="440" rx="24" fill="#233047"/>
      </svg>
    `);
    await sharp(svg).jpeg({quality: 95}).toFile(origPath);
    const beforeBytes = fs.readFileSync(origPath);

    // 2. 로컬 무료 누끼 실행 및 원본 무손상 검증
    const cut = await createOfficialCutout(origPath, path.join(tmpDir, 'cutouts'), 'official-main');
    assert.ok(fs.existsSync(cut.cutoutPath));
    assert.deepEqual(fs.readFileSync(origPath), beforeBytes, '원본 이미지가 절대 수정되면 안 됩니다');
    const cutMeta = await sharp(cut.cutoutPath).metadata();
    assert.equal(cutMeta.hasAlpha, true);

    // 3. Flow 9:16 참고 이미지 생성 검증
    const prepPath = path.join(tmpDir, 'flow-prep', 'ref-1.jpg');
    await prepareFlowReferenceImage(cut.cutoutPath, prepPath, {isCutout: true});
    const prepMeta = await sharp(prepPath).metadata();
    assert.equal(prepMeta.width, 1080);
    assert.equal(prepMeta.height, 1920);

    // 4. FFmpeg 실제 9:16 MP4 렌더링 검증
    const ff = findFFmpegTools();
    assert.equal(ff.available, true, 'FFmpeg가 설치되어 있어야 합니다');

    const assets = [
      {
        id: 'official-main',
        kind: 'official',
        mediaType: 'image',
        label: '공식몰 대표 컷',
        filename: 'sample-official.jpg',
        filePath: origPath,
        cutoutPath: cut.cutoutPath,
        useCutout: true,
        enabled: true,
      },
      {
        id: 'mannequin-1',
        kind: 'mannequin',
        mediaType: 'image',
        label: '매장 마네킨 샷',
        filename: 'sample-official.jpg',
        filePath: origPath,
        useCutout: false,
        enabled: true,
      },
    ];

    const plan = buildAutoClipPlan(assets, {targetDurationSec: 10, includeEnding: true});
    assert.equal(plan.clips.length, 2);

    const rendered = await renderShortsVideo({
      assets,
      facts: {
        style: '243801',
        headline: '3팩 반팔 티셔츠 패키지',
        material: '면 100%',
        sellingPoints: ['20수 코튼 100% 소재로 탄탄한 착용감'],
        colors: [{name: '네이비', hex: '#233047'}, {name: '화이트', hex: '#f4f3ef'}],
        showLogo: true,
        showColors: true,
      },
      options: {targetDurationSec: 10, includeEnding: true},
      workDir: path.join(tmpDir, 'work'),
      outputsDir: path.join(tmpDir, 'outputs'),
      logoPath: path.resolve('public', 'giordano-official-logo.png'),
    });

    assert.ok(fs.existsSync(rendered.outputPath));
    const probed = await probeMedia(rendered.outputPath);
    assert.equal(probed.width, 1080);
    assert.equal(probed.height, 1920);
    assert.ok(probed.duration >= 7, `출력 영상 길이가 정상이어야 합니다 (실제: ${probed.duration}초)`);
  } finally {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
});
