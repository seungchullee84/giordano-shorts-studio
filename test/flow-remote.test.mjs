import {normalizeVideoSpeed} from '../lib/video-renderer.mjs';
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
