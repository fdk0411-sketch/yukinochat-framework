const test = require('node:test');
const assert = require('node:assert/strict');
const { Controller, normalizedAvatar, validateManifest, clipInsets, visibleFrames, motionEnabled } = require('../public/avatar.js');

function harness(options = {}) {
  const frames = [];
  let now = 0, sequence = 0;
  const timers = new Map(), callbacks = [];
  const avatar = new Controller({
    ...options,
    renderer:{ render(frame) { frames.push({...frame}); } },
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id,{callback,at:now + delay}); callbacks.push(callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  function advance(duration) {
    const until = now + duration;
    for (;;) {
      const entry = [...timers].sort((a,b)=>a[1].at - b[1].at)[0];
      if (!entry || entry[1].at > until) break;
      now = entry[1].at; timers.delete(entry[0]); entry[1].callback();
    }
    now = until;
  }
  return {avatar,frames,timers,callbacks,advance};
}
const user = id => ({id,role:'user',text:'会話'});
const reply = (id,expression='smile',turnId='t1') => ({id,role:'assistant',avatar:{expression,pose:'invalid'},text:'こんにちは。（你好。）',turnId});
const chat = (messages,status='completed',id='chat1',turnId=null) => ({id,messages,status,turnId});

test('only enumerated expressions and local raster assets cross the renderer boundary',()=>{
  assert.deepEqual(normalizedAvatar({expression:'<script>',pose:'run'}),{expression:'calm',pose:'rest',intensity:'low',gaze:'forward',action:'none'});
  assert.deepEqual(normalizedAvatar({expression:'thinking',pose:'../../bad'}),{expression:'thinking',pose:'think',intensity:'low',gaze:'forward',action:'none'});
  const manifest={version:1,scene:{room:'/avatar-assets/room.png',width:1672,height:941},states:{
    calm:{base:'/avatar-assets/calm.png',blink:'https://external.test/x.png',talk:'/avatar-assets/../talk.png'},
    smile:{base:'/avatar-assets/smile.webp',placement:{x:.6,y:.1,width:.3,height:.8}},
    constructor:{base:'/avatar-assets/hostile.png'},
  }};
  const validated=validateManifest(manifest);
  assert.equal(validated.states.calm.blink,null);
  assert.equal(validated.states.calm.talk,null);
  assert.deepEqual(Object.keys(validated.states),['calm','smile']);
  assert.deepEqual(validated.states.smile.placement,{x:.6,y:.1,width:.3,height:.8});
  assert.throws(()=>validateManifest({...manifest,scene:{...manifest.scene,room:'//evil.test/room.png'}}));
  assert.throws(()=>validateManifest({...manifest,states:{}}));
});

test('selecting historical messages restores the pose without starting speech',()=>{
  const h=harness();
  h.avatar.setConnected(true);
  h.avatar.select(chat([reply('old','concern')]));
  assert.equal(h.avatar.snapshot().expression,'concern');
  assert.equal(h.avatar.snapshot().speaking,false);
  h.advance(1000);
  assert.ok(h.frames.every(frame=>!frame.mouthOpen));
  h.avatar.select(chat([{id:'old',role:'assistant',text:'旧记录'}]));
  assert.equal(h.avatar.snapshot().expression,'calm');
});

test('a new send ignores stale previous terminal snapshots and waits for fresh metadata',()=>{
  const h=harness();
  const old=chat([reply('old','serious')],'interrupted');
  h.avatar.setConnected(true); h.avatar.begin(old);
  h.avatar.observe(old,{connected:true});
  assert.equal(h.avatar.snapshot().expression,'thinking');
  const streaming={id:'new',role:'assistant',text:'',turnId:'t2'};
  h.avatar.observe(chat([...old.messages,user('u2'),streaming],'running','chat1','t2'),{connected:true});
  assert.equal(h.avatar.snapshot().expression,'thinking');
  streaming.avatar={expression:'smile',pose:'explain'};
  h.avatar.observe(chat([...old.messages,user('u2'),streaming],'running','chat1','t2'),{connected:true});
  assert.equal(h.avatar.snapshot().expression,'smile');
});

test('only actual playback opens the mouth; loading, blocked, failure and stop close it',()=>{
  const h=harness(); h.avatar.setConnected(true);
  for(const kind of ['loading','blocked','error','idle']) {
    h.avatar.setVoice({kind}); h.advance(400);
    assert.equal(h.avatar.snapshot().mouthOpen,false);
  }
  h.avatar.setVoice({kind:'playing'}); h.advance(180);
  assert.equal(h.avatar.snapshot().mouthOpen,true);
  const stale=h.callbacks[h.callbacks.length-1];
  h.avatar.setVoice({kind:'idle'}); stale();
  assert.equal(h.avatar.snapshot().mouthOpen,false);
  assert.equal(h.avatar.snapshot().speaking,false);
});

test('stop rejects later snapshots from the interrupted turn and clears old frame callbacks',()=>{
  const h=harness();
  const active=chat([user('u1'),reply('m1','smile')],'running','chat1','t1');
  h.avatar.observe(active,{connected:true}); h.avatar.setVoice({kind:'playing'}); h.advance(180);
  const callbacks=[...h.callbacks]; h.avatar.stop(); callbacks.forEach(callback=>callback());
  h.avatar.observe(chat([user('u1'),reply('m1','shy'),reply('m2','serious')],'running','chat1','t1'),{connected:true});
  assert.equal(h.avatar.snapshot().expression,'smile');
  assert.equal(h.avatar.snapshot().mouthOpen,false);
  assert.equal(h.timers.size,0);
  h.avatar.begin(active);
  h.avatar.observe(chat([...active.messages,user('u2'),reply('m3','concern','t2')],'running','chat1','t2'),{connected:true});
  assert.equal(h.avatar.snapshot().expression,'concern');
});

test('switching conversations or disconnecting invalidates old speech and animation work',()=>{
  const h=harness();
  h.avatar.observe(chat([reply('a','smile')]),{connected:true});
  h.avatar.setVoice({kind:'playing'}); h.advance(180);
  const late=[...h.callbacks];
  h.avatar.select(chat([reply('b','serious')],'completed','chat2'));
  late.forEach(callback=>callback());
  assert.equal(h.avatar.snapshot().mouthOpen,false);
  assert.equal(h.avatar.snapshot().expression,'serious');
  h.avatar.disconnect(); h.advance(10000);
  assert.equal(h.timers.size,0);
  assert.equal(h.avatar.snapshot().moving,false);
  assert.equal(h.avatar.snapshot().eyesClosed,false);
});

test('static mode, reduced motion and hidden tabs suppress loops without discarding expression',()=>{
  const h=harness();
  h.avatar.setConnected(true); h.avatar.setExpression('concern'); h.avatar.setVoice({kind:'playing'});
  h.avatar.setDynamic(false); h.advance(10000);
  assert.equal(h.timers.size,0); assert.equal(h.avatar.snapshot().mouthOpen,false);
  assert.equal(h.avatar.snapshot().expression,'concern');
  h.avatar.setDynamic(true); h.avatar.setReducedMotion(true);
  assert.equal(h.timers.size,0);
  h.avatar.setReducedMotion(false); assert.ok(h.timers.size>0);
  h.avatar.setVisible(false); assert.equal(h.timers.size,0);
  h.avatar.setVisible(true); assert.ok(h.timers.size>0);
});

test('repeated identical snapshots do not reset the blink cadence',()=>{
  const h=harness(); const conversation=chat([reply('a','smile')]);
  h.avatar.observe(conversation,{connected:true});
  h.advance(4500);
  for(let i=0;i<10;i++)h.avatar.observe(conversation,{connected:true});
  h.advance(110);
  assert.equal(h.avatar.snapshot().eyesClosed,true);
  h.advance(145); assert.equal(h.avatar.snapshot().eyesClosed,false);
});

test('long sentence playback and changing presentations preserve natural blink cadence',()=>{
  const h=harness();h.avatar.setConnected(true);h.avatar.select(chat([]));
  let previous=false,blinks=0,frameIndex=h.frames.length;
  const countBlinks=()=>{
    for(const frame of h.frames.slice(frameIndex)){if(frame.eyesClosed&&!previous)blinks++;previous=frame.eyesClosed;}
    frameIndex=h.frames.length;
  };
  for(let sentence=0;sentence<15;sentence++){
    h.avatar.setVoice({kind:'playing'});h.avatar.setVoiceLevel(.08);
    h.avatar.setPresentation({expression:sentence%2?'thinking':'smile',gaze:sentence%2?'aside':'forward'});
    assert.equal(h.avatar.snapshot().mouthLevel,.08,'An expression update retains the current measured audio level.');
    h.advance(1000);countBlinks();
    h.avatar.setVoice({kind:'idle'});assert.equal(h.avatar.snapshot().mouthOpen,false);assert.equal(h.avatar.snapshot().mouthLevel,0);
    h.advance(300);countBlinks();
    assert.equal(h.timers.size,1,'Only the independent blink timer remains between sentences.');
  }
  assert.equal(blinks,4,'19.5 seconds contains four natural closures at the fixed 4600 + 145 ms cadence.');
  assert.equal(h.avatar.snapshot().eyesClosed,false);
});

test('voice changes during a blink preserve reopening and reject stale mouth callbacks in the next sentence',()=>{
  const h=harness();h.avatar.setConnected(true);h.avatar.setVoice({kind:'playing'});h.advance(4600);
  assert.equal(h.avatar.snapshot().eyesClosed,true);
  const staleMouth=h.timers.get(h.avatar.mouthTimer).callback,generation=h.avatar.generation;
  h.avatar.setVoice({kind:'idle'});h.avatar.setVoice({kind:'playing'});
  const count=h.timers.size,frames=h.frames.length;staleMouth();
  assert.equal(h.timers.size,count);assert.equal(h.frames.length,frames,'A cancelled mouth callback cannot act in a newer sentence.');
  assert.equal(h.avatar.generation,generation);assert.equal(h.avatar.snapshot().eyesClosed,true);
  h.advance(145);assert.equal(h.avatar.snapshot().eyesClosed,false,'The original reopening callback survives sentence transitions.');
  h.advance(30);assert.equal(h.avatar.snapshot().mouthOpen,true,'The new sentence has exactly its own mouth cadence.');
});

test('all motion lifecycle boundaries cancel independent blink and mouth timers including queued callbacks',()=>{
  for(const change of [c=>c.setDynamic(false),c=>c.setReducedMotion(true),c=>c.setVisible(false),c=>c.disconnect(),c=>c.stop(),c=>c.destroy()]){
    const h=harness();h.avatar.setConnected(true);h.avatar.setVoice({kind:'playing'});h.advance(4600);
    assert.equal(h.avatar.snapshot().eyesClosed,true);const stale=[...h.callbacks];
    change(h.avatar);const frameCount=h.frames.length;stale.forEach(callback=>callback());h.advance(10000);
    assert.equal(h.frames.length,frameCount);assert.equal(h.timers.size,0);
    assert.equal(h.avatar.snapshot().eyesClosed,false);assert.equal(h.avatar.snapshot().mouthOpen,false);assert.equal(h.avatar.snapshot().mouthLevel,0);
  }
  const h=harness();h.avatar.setConnected(true);h.avatar.setVoice({kind:'playing'});h.advance(4600);
  h.avatar.setVisible(false);h.advance(10000);h.avatar.setVisible(true);h.advance(4599);
  assert.equal(h.avatar.snapshot().eyesClosed,false);h.advance(1);assert.equal(h.avatar.snapshot().eyesClosed,true,'Returning to a visible page starts one fresh cadence.');
  h.avatar.select(chat([],'completed','new-conversation'));
  assert.equal(h.avatar.snapshot().eyesClosed,false);assert.equal(h.timers.size,1);assert.equal(h.avatar.snapshot().speaking,false);
});

test('reviewed face regions keep the base visible and allow concurrent blinking and speech',()=>{
  const definition={frameRegions:{blink:{x:.72,y:.28,width:.09,height:.04},talk:{x:.75,y:.36,width:.04,height:.04}}};
  const frames={base:{},blink:{},talk:{}};
  const active={moving:true,eyesClosed:true,speaking:true,mouthOpen:true};
  assert.deepEqual(visibleFrames(definition,frames,active),{base:true,blink:true,talk:true});
  assert.deepEqual(visibleFrames(definition,frames,{...active,eyesClosed:false}),{base:true,blink:false,talk:true});
  assert.deepEqual(visibleFrames(definition,frames,{...active,moving:false}),{base:true,blink:false,talk:false});
  assert.deepEqual(visibleFrames(definition,frames,{...active,speaking:false}),{base:true,blink:true,talk:false});
  assert.deepEqual(visibleFrames({frameRegions:{blink:definition.frameRegions.blink}},frames,active),{base:true,blink:true,talk:false});
  assert.deepEqual(visibleFrames({},frames,active),{base:false,blink:true,talk:false},'unconfigured legacy assets retain full-frame priority');
  assert.deepEqual(visibleFrames({},frames,{...active,eyesClosed:false}),{base:false,blink:false,talk:true});
});

test('manifest face rectangles are finite bounded numeric data and map to cropped placements',()=>{
  const base={version:1,scene:{room:'/avatar-assets/room.png',width:1672,height:941},states:{calm:{base:'/avatar-assets/calm.png',frameRegions:{
    blink:{x:.7,y:.3,width:.1,height:.05},talk:{x:-1,y:.5,width:2,height:1},extra:{x:0,y:0,width:1,height:1},
  }}}};
  const sanitized=validateManifest(base);
  assert.deepEqual(sanitized.states.calm.frameRegions,{blink:{x:.7,y:.3,width:.1,height:.05}});
  assert.equal(clipInsets(sanitized.states.calm.frameRegions.blink),'inset(30% 20% 65% 70%)');
  assert.equal(clipInsets({x:.7,y:.3,width:.1,height:.05},{x:.5,y:.1,width:.5,height:.5}),'inset(40% 40% 50% 40%)');
  base.states.calm.frameRegions.blink={x:.7,y:NaN,width:.1,height:.05};
  assert.equal(validateManifest(base).states.calm.frameRegions,undefined);
});

test('motion follows system by default, while persisted explicit choices survive system changes',()=>{
  assert.equal(motionEnabled(null,true),false);
  assert.equal(motionEnabled(null,false),true);
  assert.equal(motionEnabled('unknown',true),false);
  assert.equal(motionEnabled('1',true),true);
  assert.equal(motionEnabled('1',false),true);
  assert.equal(motionEnabled('0',false),false);
  assert.equal(motionEnabled('0',true),false);
  const h=harness({dynamic:motionEnabled(null,true)}); h.avatar.setConnected(true);
  assert.equal(h.timers.size,0);
  h.avatar.setDynamic(motionEnabled('1',true)); h.avatar.setVoice({kind:'playing'}); h.advance(180);
  assert.equal(h.avatar.snapshot().mouthOpen,true,'manual enable works even with an OS reduced-motion default');
});

test('explicit replay after an interrupted turn is not silenced by repeated terminal snapshots',()=>{
  const h=harness(); const stopped=chat([user('u1'),reply('a','calm')],'interrupted');
  h.avatar.observe(stopped,{connected:true});
  assert.equal(h.timers.size,0);
  h.avatar.setVoice({kind:'playing'}); h.advance(180);
  assert.equal(h.avatar.snapshot().mouthOpen,true);
  h.avatar.observe(stopped,{connected:true});
  assert.equal(h.avatar.snapshot().speaking,true);
  assert.equal(h.avatar.snapshot().mouthOpen,true);
});

test('default timers retain the browser global receiver instead of binding to Controller',()=>{
  const originalSet=globalThis.setTimeout, originalClear=globalThis.clearTimeout;
  let sequence=0;
  const pending=new Set();
  try {
    globalThis.setTimeout=function(callback,delay) {
      assert.equal(this,globalThis,'native Window.setTimeout requires the global receiver');
      assert.equal(typeof callback,'function'); assert.ok(delay>0);
      const id=++sequence; pending.add(id); return id;
    };
    globalThis.clearTimeout=function(id) {
      assert.equal(this,globalThis,'native Window.clearTimeout requires the global receiver');
      pending.delete(id);
    };
    const avatar=new Controller();
    avatar.setConnected(true);
    assert.equal(pending.size,1);
    avatar.setVoice({kind:'playing'});
    assert.equal(pending.size,2);
    avatar.stop();
    assert.equal(pending.size,0);
  } finally {
    globalThis.setTimeout=originalSet; globalThis.clearTimeout=originalClear;
  }
});

test('continuous mouth levels follow actual playback and never survive a lifecycle boundary',()=>{
  const h=harness(); h.avatar.setConnected(true);
  h.avatar.setVoiceLevel(.7);
  assert.equal(h.avatar.snapshot().mouthLevel,0,'received audio is not playing audio');
  h.avatar.setVoice({kind:'playing'});
  for (const [input,expected] of [[.25,.25],[5,1],[-1,0],[NaN,0],[Infinity,0],['.5',0]]) {
    h.avatar.setVoiceLevel(input);
    assert.equal(h.avatar.snapshot().mouthLevel,expected);
  }
  for (const kind of ['loading','blocked','error','idle']) {
    h.avatar.setVoice({kind:'playing'}); h.avatar.setVoiceLevel(.8);
    h.avatar.setVoice({kind}); h.avatar.setVoiceLevel(.9);
    assert.equal(h.avatar.snapshot().mouthLevel,0);
  }
  h.avatar.setVoice({kind:'playing'}); h.avatar.setVoiceLevel(.8);
  h.avatar.setVisible(false); h.avatar.setVoiceLevel(.9);
  assert.equal(h.avatar.snapshot().mouthLevel,0);
  h.avatar.setVisible(true);
  assert.equal(h.avatar.snapshot().mouthLevel,0,'returning to a tab cannot reuse an old sample');
  h.avatar.setVoiceLevel(.4); assert.equal(h.avatar.snapshot().mouthLevel,.4);
  h.avatar.setDynamic(false); h.avatar.setVoiceLevel(.9);
  assert.equal(h.avatar.snapshot().mouthLevel,0);
  h.avatar.setDynamic(true); h.avatar.setVoiceLevel(.4);
  h.avatar.select(chat([],'completed','other')); h.avatar.setVoiceLevel(.9);
  assert.equal(h.avatar.snapshot().mouthLevel,0);
  h.avatar.setVoice({kind:'playing'}); h.avatar.setVoiceLevel(.8); h.avatar.stop();
  assert.equal(h.avatar.snapshot().mouthLevel,0);
  h.avatar.setVoiceLevel(.9); assert.equal(h.avatar.snapshot().mouthLevel,0);
  h.avatar.disconnect(); assert.equal(h.avatar.snapshot().connected,false);
});

test('new messages trigger a short action once while repeated and historical snapshots do not',()=>{
  const h=harness(); h.avatar.setConnected(true);
  const previous=chat([user('u1'),reply('a','calm')]); h.avatar.select(previous); h.avatar.begin(previous);
  const message=reply('b','wry','t2');
  message.avatar={expression:'wry',pose:'rest',intensity:'medium',gaze:'aside',action:'tilt'};
  const active=chat([...previous.messages,user('u2'),message],'running','chat1','t2');
  h.avatar.observe(active,{connected:true});
  const first=h.avatar.snapshot();
  assert.equal(first.expression,'wry'); assert.equal(first.intensity,'medium'); assert.equal(first.gaze,'aside');
  assert.equal(first.action,'tilt'); assert.equal(first.actionSequence,1);
  for(let i=0;i<5;i++)h.avatar.observe(active,{connected:true});
  assert.equal(h.avatar.snapshot().actionSequence,first.actionSequence);
  h.avatar.select(active);
  const restored=h.avatar.snapshot();
  assert.equal(restored.action,'none'); assert.ok(restored.transientEpoch>first.transientEpoch);
  assert.equal(restored.gaze,'aside'); assert.equal(restored.conversationId,'chat1');
  h.avatar.observe(active,{connected:true});
  assert.equal(h.avatar.snapshot().action,'none','historical action cannot replay on the next SSE update');
  assert.equal(h.avatar.snapshot().actionSequence,first.actionSequence);
});

test('transient epoch explicitly cancels local reactions on stop, selection, begin, hide and disconnect',()=>{
  const h=harness(); h.avatar.setConnected(true); h.avatar.select(chat([]));
  for (const change of [()=>h.avatar.stop(),()=>h.avatar.select(chat([],'completed','next')),
    ()=>h.avatar.begin(chat([],'completed','next')),()=>h.avatar.setVisible(false),
    ()=>h.avatar.setDynamic(false),()=>h.avatar.setReducedMotion(true),()=>h.avatar.disconnect()]) {
    const before=h.avatar.snapshot().transientEpoch;
    change();
    assert.ok(h.avatar.snapshot().transientEpoch>before);
    assert.equal(h.avatar.snapshot().action,'none');
    assert.equal(h.avatar.snapshot().mouthLevel,0);
  }
});

test('front-end presentation normalization permits only restrained known parameters',()=>{
  assert.deepEqual(normalizedAvatar({expression:'surprise',intensity:'high',gaze:'../../file',action:'jump'}),
    {expression:'surprise',pose:'rest',intensity:'low',gaze:'forward',action:'none'});
  assert.deepEqual(normalizedAvatar({expression:'__proto__',intensity:'medium',gaze:'aside',action:'nod'}),
    {expression:'calm',pose:'rest',intensity:'low',gaze:'forward',action:'none'});
  const h=harness({dynamic:false}); h.avatar.setConnected(true);
  h.avatar.setPresentation({expression:'surprise',intensity:'low',gaze:'down',action:'nod'},{messageId:'new'});
  assert.equal(h.avatar.snapshot().expression,'surprise');
  assert.equal(h.avatar.snapshot().actionSequence,0);
  h.avatar.setDynamic(true);
  h.avatar.setPresentation({expression:'surprise',action:'nod'},{messageId:'new'});
  assert.equal(h.avatar.snapshot().actionSequence,0,'actions ignored while static cannot queue for later');
});

test('a page initially hidden stays motionless before the first visibility event',()=>{
  const h=harness({visible:false}); h.avatar.setConnected(true);
  h.avatar.setVoice({kind:'playing'}); h.avatar.setVoiceLevel(.8);
  assert.equal(h.avatar.snapshot().visible,false);
  assert.equal(h.avatar.snapshot().moving,false);
  assert.equal(h.avatar.snapshot().mouthLevel,0);
  assert.equal(h.timers.size,0);
  h.avatar.setVisible(true);
  assert.equal(h.avatar.snapshot().moving,true);
  assert.equal(h.avatar.snapshot().mouthLevel,0);
});

test('identical SSE presentations do not request redundant renders in hidden or static mode',()=>{
  for(const options of [{visible:false},{dynamic:false},{}]) {
    const h=harness(options);
    const conversation=chat([user('u1'),reply('a1','smile')]);
    h.avatar.observe(conversation,{connected:true});
    const count=h.frames.length;
    for(let index=0;index<20;index++)h.avatar.observe(conversation,{connected:true});
    assert.equal(h.frames.length,count);
    conversation.messages[1].avatar={expression:'concern',gaze:'down'};
    h.avatar.observe(conversation,{connected:true});
    assert.ok(h.frames.length>count,'A real expression change is still rendered.');
  }
});
