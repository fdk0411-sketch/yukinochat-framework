import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReplySettings, parseReplyRequest, replyEffort, replyPersona, CONCISE_REPLY_INSTRUCTIONS,
  assertEffortSupported, TurnTimingTracker } from '../reply-policy.mjs';

const config = { version: 1, enabled: true, dailyEffort: 'medium', deepEffort: 'ultra', conciseReplies: false };

test('app-local config is strict and never implies a model change', () => {
  assert.deepEqual(parseReplySettings(config), { enabled: true, defaultMode: 'daily', dailyEffort: 'medium', deepEffort: 'ultra', conciseReplies: false });
  for (const bad of [null, [], {}, { ...config, version: 2 }, { ...config, model: 'other' }, { ...config, dailyEffort: 'automatic' }, { ...config, enabled: 'true' }]) {
    assert.throws(() => parseReplySettings(bad));
  }
});

test('mode and trace validation rejects arbitrary values before generation', () => {
  assert.deepEqual(parseReplyRequest({}), { mode: 'daily', clientTraceId: null });
  assert.deepEqual(parseReplyRequest({ responseMode: 'deep', clientTraceId: 'test:123_abc-0.1' }), { mode: 'deep', clientTraceId: 'test:123_abc-0.1' });
  assert.equal(parseReplyRequest({ clientTraceId: 'a'.repeat(96) }).clientTraceId.length, 96);
  for (const responseMode of [null, 'low', 'DAILY', {}, 0]) assert.throws(() => parseReplyRequest({ responseMode }));
  for (const clientTraceId of [null, '', 'a'.repeat(97), '漢字', 'a\nb', '<tag>', {}, 1]) assert.throws(() => parseReplyRequest({ clientTraceId }));
});

test('disabled baseline keeps the exact full persona and inherits effort', () => {
  const baseline = parseReplySettings({ ...config, enabled: false, conciseReplies: true });
  assert.equal(replyEffort(baseline, 'daily'), null);
  assert.equal(replyEffort(baseline, 'deep'), null);
  assert.equal(replyPersona('original\n完整角色与格式', baseline), 'original\n完整角色与格式');
  assert.equal(replyPersona('original', parseReplySettings(config)), 'original');
  assert.equal(replyPersona('original', parseReplySettings({ ...config, conciseReplies: true })), `original\n\n${CONCISE_REPLY_INSTRUCTIONS}`);
  assert.equal(replyEffort(parseReplySettings(config), 'daily'), 'medium');
  assert.equal(replyEffort(parseReplySettings(config), 'deep'), 'ultra');
});

test('capabilities are checked for the actual model without fallback', () => {
  const models = [{ model: 'same-model', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }];
  assert.doesNotThrow(() => assertEffortSupported(models, 'same-model', 'medium'));
  assert.doesNotThrow(() => assertEffortSupported([], 'anything', null));
  assert.throws(() => assertEffortSupported(models, 'same-model', 'low'));
  assert.throws(() => assertEffortSupported(models, 'another', 'medium'));
});

test('timings preserve absent observations, protect late results, and isolate conversations', () => {
  let now = 100;
  const tracker = new TurnTimingTracker(() => now);
  const first = tracker.start('a', { mode: 'daily', clientTraceId: 'one', requestedEffort: 'medium' });
  now = 110;
  tracker.mark('a', first, 'firstAgentDeltaMs');
  tracker.bind('a', first, 'turn-one');
  assert.equal(tracker.forTurn('a', 'different'), null);
  now = 120;
  tracker.mark('a', first, 'firstAgentDeltaMs');
  tracker.mark('a', first, 'firstBodyReadyMs');
  tracker.metadata('a', first, { model: 'real', reasoningEffort: 'medium', privateText: 'never copy' });
  assert.equal(tracker.snapshot().a.firstAgentDeltaMs, 10);
  assert.equal(tracker.snapshot().a.firstBodyReadyMs, 20);
  assert.equal(tracker.snapshot().a.reasoningCompletedMs, null);
  const second = tracker.start('a', { mode: 'deep', clientTraceId: 'two', requestedEffort: 'ultra' });
  tracker.start('b', { mode: 'daily', clientTraceId: 'other', requestedEffort: 'medium' });
  now = 125;
  tracker.metadata('a', first, { model: 'stale', reasoningEffort: 'medium' });
  tracker.mark('a', first, 'textCompleteMs');
  tracker.mark('a', second, 'turnStartedMs');
  assert.equal(tracker.snapshot().a.actualEffort, null);
  assert.equal(tracker.snapshot().a.textCompleteMs, null);
  assert.equal(tracker.snapshot().a.turnStartedMs, 5);
  assert.equal(tracker.snapshot().b.turnStartedMs, null);
  assert.ok(!JSON.stringify(tracker.snapshot()).includes('privateText'));
  const snapshot = tracker.snapshot(); snapshot.a.actualEffort = 'mutated';
  assert.equal(tracker.snapshot().a.actualEffort, null);
});

test('timing history is bounded and recently used conversations stay available', () => {
  const tracker = new TurnTimingTracker(() => 10, { maxRecords: 2 });
  const params = { mode: 'daily', clientTraceId: null, requestedEffort: 'medium' };
  const old = tracker.start('a', params);
  tracker.start('b', params);
  tracker.start('a', params);
  tracker.start('c', params);
  assert.deepEqual(Object.keys(tracker.snapshot()), ['a', 'c']);
  tracker.mark('a', old, 'firstBodyReadyMs');
  tracker.mark('missing', null, 'firstBodyReadyMs');
  assert.equal(tracker.snapshot().a.firstBodyReadyMs, null);
});
