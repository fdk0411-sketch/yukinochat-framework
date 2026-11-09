import test from 'node:test';
import assert from 'node:assert/strict';
import { AVATAR_POSES, MAX_AVATAR_HEADER, AvatarMessageWriter, avatarAssetForRoute, decodeAvatarReply } from '../avatar-protocol.mjs';

const marker = (expression = 'smile', pose = AVATAR_POSES[expression]) => `<yukino-avatar expression="${expression}" pose="${pose}"/>`;
const speech = 'よく頑張ったわね。（你做得很好。）\n次の一歩を考えましょう。（我们想想下一步吧。）';
const neutral = { expression: 'calm', pose: 'rest' };

test('all supported expression/pose pairs decode separately from bilingual text', () => {
  for (const [expression, pose] of Object.entries(AVATAR_POSES)) {
    assert.deepEqual(decodeAvatarReply(`${marker(expression)}\n${speech}`, { final: true }), { text: speech, avatar: { expression, pose } });
  }
});

test('optional restrained parameters are streamed without changing the legacy message shape', () => {
  const tag='<yukino-avatar expression="wry" pose="rest" intensity="medium" gaze="aside" action="tilt"/>';
  const expected={expression:'wry',pose:'rest',intensity:'medium',gaze:'aside',action:'tilt'};
  for(let split=0;split<=tag.length;split++) {
    const writer=new AvatarMessageWriter(), message={id:'new',text:''};
    writer.write(message,{delta:tag.slice(0,split)});
    assert.equal(message.text,'');
    writer.write(message,{delta:tag.slice(split)+speech}); writer.finish(message);
    assert.deepEqual(message.avatar,expected); assert.equal(message.text,speech);
  }
  assert.deepEqual(decodeAvatarReply(marker('surprise'),{final:true}).avatar,{expression:'surprise',pose:'rest'});
  assert.deepEqual(decodeAvatarReply('<yukino-avatar expression="calm" pose="rest" action="none"/>',{final:true}).avatar,
    {expression:'calm',pose:'rest',action:'none'});
});

test('invalid intensity, gaze, action and duplicate optional attributes fail closed', () => {
  for(const attrs of ['intensity="high"','gaze="left"','action="jump"','action="nod" action="tilt"',
    'intensity="low" intensity="medium"','gaze="forward" model="external"','action="__proto__"']) {
    const tag=`<yukino-avatar expression="smile" pose="explain" ${attrs}/>`;
    assert.deepEqual(decodeAvatarReply(tag+speech,{final:true}),{text:speech,avatar:neutral},attrs);
  }
});

test('repeated reserved markers and interrupted embedded tags never enter chat or speech', () => {
  const raw=marker('concern')+'はい。'+marker('smile')+'（是的。）';
  const expected='はい。（是的。）';
  const writer=new AvatarMessageWriter(), message={text:''};
  for(const char of raw) {
    writer.write(message,{delta:char});
    assert.ok(expected.startsWith(message.text));
  }
  writer.finish(message);
  assert.equal(message.text,expected); assert.equal(message.avatar.expression,'concern');
  assert.equal(decodeAvatarReply(marker()+'本文<yukino-ava',{final:true}).text,'本文');
  assert.equal(decodeAvatarReply('本文<yukino-avatar expression="smile"',{final:true}).text,'本文');
  assert.equal(decodeAvatarReply('比較 x <',{final:true}).text,'比較 x <');
});

test('every possible two-chunk boundary holds partial metadata and preserves streamed sentences', () => {
  const raw = `${marker()}\n${speech}`;
  for (let split = 0; split <= raw.length; split++) {
    const writer = new AvatarMessageWriter();
    const message = { id: 'a', text: '', status: 'streaming' };
    writer.write(message, { delta: raw.slice(0, split) });
    const partial = message.text;
    assert.equal(partial.includes('yukino-avatar'), false, `leaked at ${split}`);
    assert.ok(speech.startsWith(partial), `non-body characters at ${split}`);
    writer.write(message, { delta: raw.slice(split) });
    assert.ok(message.text.startsWith(partial));
    writer.finish(message);
    assert.equal(message.text, speech);
    assert.deepEqual(message.avatar, { expression: 'smile', pose: 'explain' });
  }
});

test('single-code-unit chunks preserve Unicode, escape-like content and plain Markdown', () => {
  const body = 'こんにちは😀。（你好😀。）\n`C:\\data\\test`\n**a > b**';
  const writer = new AvatarMessageWriter();
  const message = { text: '' };
  let previouslyVisible = '';
  for (const char of `${marker('thinking')}\n${body}`.split('')) {
    writer.write(message, { delta: char });
    assert.ok(message.text.startsWith(previouslyVisible));
    assert.equal(message.text.includes('yukino-avatar'), false);
    previouslyVisible = message.text;
  }
  writer.finish(message);
  assert.equal(message.text, body);
});

test('complete header exposes avatar before body arrives without waiting for the whole response', () => {
  assert.deepEqual(decodeAvatarReply(marker('concern')), { text: '', avatar: { expression: 'concern', pose: 'lean' } });
  assert.equal(decodeAvatarReply(`${marker()}\nはい。（是的。）`).text, 'はい。（是的。）');
});

test('a partially streamed header does not publish a provisional calm pose', () => {
  const writer = new AvatarMessageWriter();
  const message = { id: 'new', text: '' };
  writer.write(message, { delta: '<yukino-avatar expression="con' });
  assert.equal(message.text, '');
  assert.equal(Object.hasOwn(message, 'avatar'), false);
  writer.write(message, { delta: 'cern" pose="lean"/>' });
  assert.equal(message.text, '');
  assert.deepEqual(message.avatar, { expression: 'concern', pose: 'lean' });
  writer.write(message, { delta: '\n一緒に考えましょう。（我们一起想想吧。）' });
  assert.equal(message.avatar.expression, 'concern');
});

test('ordinary legacy, tool-progress and code text stays unchanged', () => {
  for (const body of [speech, '調べています。（正在查询。）', '  保留开头空白', '```js\nconst x = 1;\n```', '<section>普通代码</section>', '比較： a < b', '']) {
    assert.deepEqual(decodeAvatarReply(body, { final: true }), { text: body, avatar: neutral });
  }
});

test('unknown values, duplicate/extra fields, wrong pair and malformed tags cannot select a pose', () => {
  const invalid = [
    marker('execute', 'shell'), marker('smile', 'folded'),
    '<yukino-avatar expression="smile" pose="explain" script="alert"/>',
    '<yukino-avatar expression="smile" expression="serious" pose="explain"/>',
    '<yukino-avatar expression="__proto__" pose="constructor"/>',
    '<yukino-avatar expression="smile"/>',
    '<YUKINO-AVATAR expression="smile" pose="explain"/>',
    '<yukino-avatar expression="smile" pose="explain">',
    "<yukino-avatar expression='smile' pose='explain'/>",
    `<yukino-avatar expression="${'x'.repeat(MAX_AVATAR_HEADER)}" pose="rest"/>`,
  ];
  for (const header of invalid) {
    assert.deepEqual(decodeAvatarReply(`${header}\n${speech}`, { final: true }), { text: speech, avatar: neutral }, header);
  }
});

test('quoted delimiter cannot escape the metadata header into TTS', () => {
  const raw = '<yukino-avatar expression="bad>payload" pose="rest"/>';
  assert.deepEqual(decodeAvatarReply(`${raw}\n${speech}`), { text: speech, avatar: neutral });
});

test('an interrupted partial or unclosed metadata header is never exposed', () => {
  for (let end = 1; end < marker().length; end++) {
    const partial = marker().slice(0, end);
    assert.equal(decodeAvatarReply(partial, { final: true }).text, '');
  }
  assert.equal(decodeAvatarReply(`<yukino-avatar expression="${'x'.repeat(5000)}`, { final: true }).text, '');
});

test('item and turn authoritative replacements use the same decoder and never publish raw buffers', () => {
  const writer = new AvatarMessageWriter();
  const message = { id: 'assistant-1', role: 'assistant', text: '' };
  writer.write(message, { delta: marker() + '\n' + speech.slice(0, 12) });
  writer.write(message, { text: marker() + '\n' + speech, final: true });
  writer.finish(message); // A terminal notification may finalize the same item again.
  assert.equal(message.text, speech);
  assert.deepEqual(message.avatar, { expression: 'smile', pose: 'explain' });
  assert.equal(JSON.stringify(message).includes('<yukino-avatar'), false);
  writer.write(message, { text: marker('serious') + '\n訂正します。（我修正一下。）', final: true });
  assert.equal(message.text, '訂正します。（我修正一下。）');
  assert.deepEqual(message.avatar, { expression: 'serious', pose: 'folded' });
  assert.equal(JSON.stringify(message).includes('<yukino-avatar'), false);
});

test('separate messages and conversations cannot share parser state; historical finish is a no-op', () => {
  const writer = new AvatarMessageWriter();
  const a = { text: '' }; const b = { text: '' };
  writer.write(a, { delta: '<yukino-ava' });
  writer.write(b, { delta: marker('thinking') + speech });
  writer.write(a, { delta: 'tar expression="smile" pose="explain"/>' + speech });
  writer.finish(a); writer.finish(b);
  assert.equal(a.text, speech); assert.equal(b.text, speech);
  assert.equal(a.avatar.expression, 'smile'); assert.equal(b.avatar.expression, 'thinking');
  const historical = { text: speech, role: 'assistant', status: 'completed' };
  writer.finish(historical);
  assert.deepEqual(historical, { text: speech, role: 'assistant', status: 'completed' });
});

test('asset routes only permit lowercase image basenames in the owned directory', () => {
  assert.deepEqual(avatarAssetForRoute('/avatar-assets/calm-rest.png'), ['avatar-assets/calm-rest.png', 'image/png']);
  assert.deepEqual(avatarAssetForRoute('/avatar-assets/scene-v1.webp'), ['avatar-assets/scene-v1.webp', 'image/webp']);
  for (const route of ['/avatar-assets/../config.json', '/avatar-assets/%2e%2e/config.json', '/avatar-assets/sub/calm.png', '/avatar-assets/a\\b.png', '/avatar-assets/calm.png:secret', '/avatar-assets/calm.svg', '/avatar-assets/.hidden.png', '/avatar-assets/a.png?x=1', '/avatar-assets/CALM.png', '/elsewhere/calm.png']) {
    assert.equal(avatarAssetForRoute(route), null, route);
  }
});
