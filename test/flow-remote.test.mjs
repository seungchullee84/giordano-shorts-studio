import {CAPTION_POSITION_KEYS, CAPTION_STYLE_KEYS, buildGlobalMergedCaptions, normalizeVideoSpeed, resolveCaptionLayout} from '../lib/video-renderer.mjs';
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
