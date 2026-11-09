const test=require('node:test');
const assert=require('node:assert/strict');
const {Controller}=require('../public/avatar.js');
const {Renderer,Live2DRenderer,expressionParameters,mouthOpenForLevel,verifyModelProfile,PRESETS,PARAMETERS,CANDIDATE_PARAMETERS,PROFILES,MODEL}=require('../public/live2d-avatar.js');

function stage() {
  return {dataset:{},attributes:{},children:[],hidden:false,style:{setProperty(){}},classList:{toggle(){}},setAttribute(key,value){this.attributes[key]=value;},replaceChildren(...children){this.children=children;}};
}
function rig(options={}) {
  const renderer=new Live2DRenderer(stage(),()=>{},options), values=new Map();
  const parameters=expressionParameters({expression:'calm'},options);
  const range=id=>id==='ParamAngleX'||id==='ParamAngleY'?[-30,30]:id==='ParamBodyAngleY'?[-10,10]:id.includes('Brow')||id.includes('EyeBall')||id==='ParamMouthForm'||id.startsWith('ParamArmScreen')?[-1,1]:[0,1];
  renderer.parameterInfo=new Map(Object.keys(parameters).map((id,index)=>[id,{index,min:range(id)[0],max:range(id)[1],default:parameters[id]}]));
  const ids=[...renderer.parameterInfo.keys()];
  renderer.core={setParameterValueByIndex(index,value){values.set(ids[index],value);},getParameterValueByIndex(index){return values.get(ids[index]);}};
  // Mirrors the installed vendor's public update contract: update(dt) queues
  // time; its draw calls internal.update only when queued deltaTime is nonzero.
  let pending=0;
  renderer.internal={update(){renderer.applyParameters();}};
  renderer.model={update(dt){pending+=dt;}};
  renderer.app={ticker:{started:false},start(){this.ticker.started=true;},stop(){this.ticker.started=false;},render(){if(pending){renderer.internal.update();pending=0;}}};
  renderer.loaded=true;
  return {renderer,values,frame(dt=33){renderer.advance(dt);renderer.app.render();}};
}

test('silent, static and invalid sample inputs cannot open the model mouth',()=>{
  for(const expression of Object.keys(PRESETS)) {
    for(const snapshot of [
      {moving:false,speaking:true,mouthLevel:1},{moving:true,speaking:false,mouthLevel:1},
      {moving:true,speaking:true,mouthLevel:0},{moving:true,speaking:true,mouthLevel:NaN},
      {moving:true,speaking:true,mouthLevel:Infinity},{moving:true,speaking:true,mouthLevel:-2},
      {moving:true,speaking:true,mouthLevel:1,visible:false},{moving:true,speaking:true,mouthLevel:1,connected:false},
    ])assert.equal(expressionParameters({expression,...snapshot}).ParamMouthOpenY,0);
    const loud=expressionParameters({expression,moving:true,speaking:true,mouthLevel:100});
    assert.ok(loud.ParamMouthOpenY>0 && loud.ParamMouthOpenY<1,'Even high input stays below a full open mouth.');
  }
});

test('mouth response skips only the rig handoff interval, stays monotonic, and preserves the calibrated gain',()=>{
  const mouth=level=>expressionParameters({moving:true,speaking:true,mouthLevel:level}).ParamMouthOpenY;
  for(const quiet of [0,.001,.004,.005])assert.equal(mouth(quiet),0,'Quiet input resolves to a fully closed authored mouth.');
  assert.equal(mouth(.0051),.1);assert.equal(mouth(.02),.1);
  for(const level of [.025,.04,.08,.12,.16])assert.equal(mouth(level),level*4,'Above the handoff retain the original four-times level.');
  let previous=0;
  for(let sample=0;sample<=1000;sample++){
    const value=mouth(sample/1000);
    assert.ok(value>=previous && value<=.65,'More level never makes the mouth smaller or exceeds the restrained cap.');
    assert.ok(value===0 || value>=.1,'No held value remains inside the two-layer overlap interval.');
    previous=value;
  }
  for(const off of [{speaking:false},{moving:false},{visible:false},{connected:false}]){
    assert.equal(expressionParameters({moving:true,speaking:true,mouthLevel:.01,...off}).ParamMouthOpenY,0);
  }
});

test('contextual presets drive only authored face controls, with restrained amplitude and no unsupported effects',()=>{
  for(const expression of Object.keys(PRESETS)) {
    for(const intensity of ['low','medium','high',undefined]) {
      const p=expressionParameters({expression,intensity,moving:true,speaking:false,mouthLevel:1,PARAM_SWEAT:1});
      assert.deepEqual(Object.keys(p).sort(),[...PARAMETERS].sort(),'No head, gaze, body or exaggerated effect control is emitted.');
      assert.ok(p.ParamEyeLOpen>=.85 && p.ParamEyeLOpen<=1);
      assert.ok(p.ParamEyeROpen>=.85 && p.ParamEyeROpen<=1);
      assert.ok(Math.abs(p.ParamBrowLY)<=.25 && Math.abs(p.ParamBrowRY)<=.25);
      assert.ok(Object.values(p).every(Number.isFinite));
    }
    assert.deepEqual(expressionParameters({expression,intensity:'high'}),expressionParameters({expression,intensity:'low'}));
    assert.deepEqual(expressionParameters({expression,gaze:'aside',action:'nod'}),expressionParameters({expression}),'Unbound gaze and head actions cannot invent movement.');
  }
  assert.deepEqual(expressionParameters({expression:'calm'}),{ParamEyeLOpen:1,ParamEyeROpen:1,ParamBrowLY:0,ParamBrowRY:0,ParamMouthOpenY:0});
  assert.deepEqual(expressionParameters({expression:'unknown'}),expressionParameters({expression:'calm'}));
  assert.deepEqual(expressionParameters({expression:'__proto__'}),expressionParameters({expression:'calm'}));
});

test('legacy candidate keeps its original gaze-only whitelist and unrepaired mouth handoff',()=>{
  const options={profile:'v3-gaze-legacy'};
  const base={expression:'calm',moving:true,visible:true,connected:true,speaking:true};
  for(const [gaze,x,y] of [['forward',0,0],['aside',-.55,-.08],['down',0,-.45]]){
    const parameters=expressionParameters({...base,gaze,mouthLevel:.08,eyesClosed:true,action:'nod'},options);
    assert.deepEqual(Object.keys(parameters).sort(),[...PROFILES['v3-gaze-legacy'].parameters].sort());
    assert.equal(parameters.ParamEyeBallX,x);assert.equal(parameters.ParamEyeBallY,y);
    assert.equal(parameters.ParamEyeLOpen,undefined);assert.equal(parameters.ParamAngleY,undefined);
  }
  assert.equal(mouthOpenForLevel(.005,options),0);assert.equal(mouthOpenForLevel(.0051,options),.1);
  assert.equal(mouthOpenForLevel(.08,options),.30*(1-Math.exp(-.08/.06)));
  let previous=0;
  for(let index=0;index<=1000;index++){
    const value=mouthOpenForLevel(index/1000,options);
    assert.ok(value>=previous&&value<=.30);assert.ok(value===0||value>=.1);previous=value;
  }
  for(const invalid of [NaN,Infinity,-1])assert.equal(mouthOpenForLevel(invalid,options),0);
  for(const off of [{speaking:false},{moving:false},{visible:false},{connected:false}])assert.equal(expressionParameters({...base,mouthLevel:.2,...off},options).ParamMouthOpenY,0);
  assert.ok(mouthOpenForLevel(.2,{...options,mouth:{maxOpen:.25,scale:.08}})<.25);
  assert.equal(mouthOpenForLevel(.1),.4,'The default v2 mapping remains unchanged.');
  assert.throws(()=>mouthOpenForLevel(.1,{profile:'unverified'}),/Unknown/);
  assert.throws(()=>mouthOpenForLevel(.1,{mouth:{maxOpen:.3}}),/candidate-only/);
  for(const mouth of [{scale:0},{threshold:NaN},{minOpen:.05},{maxOpen:2}])assert.throws(()=>mouthOpenForLevel(.1,{...options,mouth}),/Invalid/);
});

test('repaired candidate emits only its seven verified controls and has no onset mouth jump',()=>{
  const options={profile:'v3-candidate'},base={expression:'calm',moving:true,visible:true,connected:true,speaking:true};
  for(const [gaze,x,y] of [['forward',0,0],['aside',-.55,-.08],['down',0,-.45]]){
    const parameters=expressionParameters({...base,gaze,mouthLevel:.08,action:'nod'},options);
    assert.deepEqual(Object.keys(parameters).sort(),[...CANDIDATE_PARAMETERS].sort());
    assert.equal(parameters.ParamEyeBallX,x);assert.equal(parameters.ParamEyeBallY,y);
    assert.equal(parameters.ParamEyeLOpen,1);assert.equal(parameters.ParamEyeROpen,1);
    for(const unbound of ['ParamAngleX','ParamAngleY','ParamAngleZ','ParamMouthForm','ParamBodyAngleX','ParamArmLA'])assert.equal(parameters[unbound],undefined);
  }
  for(const level of [0,.004,.005,NaN,Infinity,-1])assert.equal(mouthOpenForLevel(level,options),0);
  assert.ok(mouthOpenForLevel(.005000001,options)<1e-7,'There is no discontinuity above the quiet threshold.');
  assert.ok(mouthOpenForLevel(.0051,options)>0&&mouthOpenForLevel(.0051,options)<.001);
  assert.equal(mouthOpenForLevel(.08,options),.30*(1-Math.exp(-(.08-.005)/.06)));
  let previous=0,traversedLowRange=false;
  for(let index=0;index<=1000;index++){
    const value=mouthOpenForLevel(index/1000,options);
    assert.ok(value>=previous&&value<=.30);traversedLowRange ||= value>0&&value<.1;previous=value;
  }
  assert.equal(traversedLowRange,true);
  for(const off of [{speaking:false},{moving:false},{visible:false},{connected:false}])assert.equal(expressionParameters({...base,mouthLevel:.2,...off},options).ParamMouthOpenY,0);
  assert.ok(mouthOpenForLevel(.2,{...options,mouth:{maxOpen:.25,scale:.08}})<.25);
  for(const mouth of [{scale:0},{threshold:NaN},{minOpen:.1},{minOpen:-.01},{maxOpen:0},{maxOpen:.31},{maxOpen:2}])assert.throws(()=>mouthOpenForLevel(.1,{...options,mouth}),/Invalid/);
});

test('legacy candidate gaze eases to context and back to neutral, while static mode claims no blink',()=>{
  const h=rig({profile:'v3-gaze-legacy'}),base={expression:'calm',gaze:'forward',moving:true,visible:true,connected:true,speaking:false};
  h.renderer.render(base);h.frame();
  h.renderer.render({...base,gaze:'aside'});h.frame(33);
  assert.ok(h.values.get('ParamEyeBallX')<0&&h.values.get('ParamEyeBallX')>-.55,'The first gaze frame uses easing.');
  for(let index=0;index<32;index++)h.frame(50);
  assert.ok(Math.abs(h.values.get('ParamEyeBallX')+.55)<.001);
  h.renderer.render(base);for(let index=0;index<32;index++)h.frame(50);
  assert.ok(Math.abs(h.values.get('ParamEyeBallX'))<.001);assert.ok(Math.abs(h.values.get('ParamEyeBallY'))<.001);
  h.renderer.render({...base,moving:false,gaze:'down',speaking:true,mouthLevel:.5,eyesClosed:true});
  assert.equal(h.renderer.app.ticker.started,false);assert.equal(h.values.get('ParamMouthOpenY'),0);
  assert.equal(h.values.get('ParamEyeBallY'),-.45,'Static context can retain a gaze without advancing animation.');
  assert.equal(h.renderer.stage.dataset.frame,'base');assert.equal(h.renderer.diagnostics().blinkSupported,false);
  assert.ok(!h.values.has('ParamEyeLOpen'));
});

test('repaired candidate combines continuous blink and gaze and releases both lids immediately when inactive',()=>{
  for(const inactive of [{moving:false},{visible:false},{connected:false}]){
    const h=rig({profile:'v3-candidate'}),base={expression:'calm',gaze:'aside',moving:true,visible:true,connected:true,speaking:true,mouthLevel:.006};
    h.renderer.render(base);h.frame();
    assert.ok(h.values.get('ParamMouthOpenY')>0&&h.values.get('ParamMouthOpenY')<.1);
    h.renderer.render({...base,eyesClosed:true});h.frame(16);
    const closing=h.values.get('ParamEyeLOpen');
    assert.ok(closing>0&&closing<1,'Blink visits a real intermediate lid position.');
    for(let index=0;index<6;index++)h.frame(16);
    assert.ok(h.values.get('ParamEyeLOpen')<.01);assert.equal(h.values.get('ParamEyeROpen'),h.values.get('ParamEyeLOpen'));
    assert.ok(h.values.get('ParamEyeBallX')<0);assert.equal(h.renderer.diagnostics().blinkSupported,true);
    h.renderer.render({...base,eyesClosed:true,...inactive});
    assert.equal(h.renderer.app.ticker.started,false);assert.equal(h.values.get('ParamMouthOpenY'),0);
    assert.equal(h.values.get('ParamEyeLOpen'),1);assert.equal(h.values.get('ParamEyeROpen'),1);
    assert.equal(h.renderer.stage.dataset.frame,'base');
  }
});

test('verified mouth-form profile adds only restrained expression curvature, independent of speech level',()=>{
  const options={profile:'v3-mouthform-candidate'};
  for(const expression of Object.keys(PRESETS)){
    const silent=expressionParameters({expression,intensity:'medium',moving:true,speaking:false},options);
    const voiced=expressionParameters({expression,intensity:'medium',moving:true,speaking:true,mouthLevel:.2},options);
    assert.deepEqual(Object.keys(silent).sort(),[...PROFILES[options.profile].parameters].sort());
    assert.equal(silent.ParamMouthForm,voiced.ParamMouthForm);assert.ok(Math.abs(silent.ParamMouthForm)<=.5);
    assert.equal(silent.ParamMouthOpenY,0);assert.ok(voiced.ParamMouthOpenY>0);
    assert.equal(silent.ParamAngleX,undefined);assert.equal(silent.ParamBodyAngleX,undefined);
  }
  assert.ok(expressionParameters({expression:'smile'},options).ParamMouthForm>0);
  assert.ok(expressionParameters({expression:'serious'},options).ParamMouthForm<0);
  for(const expression of ['calm','unknown','__proto__','constructor'])assert.equal(expressionParameters({expression},options).ParamMouthForm,0);
  assert.equal(expressionParameters({expression:'smile'},{profile:'v3-candidate'}).ParamMouthForm,undefined);
});

test('mouth-form eases with expression, follows semantic priority and clears click influence at lifecycle boundaries',t=>{
  const h=rig({profile:'v3-mouthform-candidate'}),classes=new Set();
  h.renderer.bubble={textContent:'',classList:{add:name=>classes.add(name),remove:name=>classes.delete(name)}};
  t.after(()=>h.renderer.clearTransient());
  const base={expression:'calm',intensity:'medium',gaze:'forward',moving:true,visible:true,connected:true,speaking:false,conversationId:'a'};
  h.renderer.render(base);h.frame();h.renderer.interact('greet');h.frame();
  const first=h.values.get('ParamMouthForm');assert.ok(first>0&&first<.35);
  assert.equal(h.values.get('ParamMouthOpenY'),0,'A greeting changes curvature without pretending to speak.');
  h.renderer.render({...base,expression:'serious'});for(let i=0;i<32;i++)h.frame(50);
  assert.equal(h.renderer.reaction,null);assert.ok(h.values.get('ParamMouthForm')<-.199);
  h.renderer.render({...base,expression:'serious',moving:false});assert.equal(h.values.get('ParamMouthForm'),-.2);
  h.renderer.render({...base,conversationId:'b',moving:false});
  assert.equal(h.values.get('ParamMouthForm'),0);assert.equal(h.values.get('ParamMouthOpenY'),0);assert.equal(h.renderer.reaction,null);
});

test('candidate lifecycle clears local reactions and speech without replaying unbound actions',t=>{
  const h=rig({profile:'v3-candidate'}),classes=new Set();
  h.renderer.bubble={textContent:'',classList:{add:name=>classes.add(name),remove:name=>classes.delete(name)}};
  const controller=new Controller({renderer:h.renderer,setTimeout:()=>1,clearTimeout(){}});
  t.after(()=>{controller.resetFrames();h.renderer.clearTransient();});
  controller.setConnected(true);controller.select({id:'candidate',messages:[]});
  controller.setPresentation({expression:'thinking',gaze:'aside',action:'nod'},{messageId:'new'});
  controller.setVoice({kind:'playing'});controller.setVoiceLevel(.08);h.frame();
  assert.ok(h.values.get('ParamMouthOpenY')>.1);h.renderer.interact('greet');
  controller.stop();h.frame();assert.equal(h.values.get('ParamMouthOpenY'),0);
  assert.equal(h.renderer.reaction,null);assert.equal(classes.has('visible'),false);assert.equal(h.renderer.action,undefined);
  controller.setVisible(false);assert.equal(h.renderer.app.ticker.started,false);assert.equal(h.values.get('ParamMouthOpenY'),0);
  controller.setVisible(true);controller.select({id:'next',messages:[]});
  for(let index=0;index<32;index++)h.frame(50);
  assert.ok(Math.abs(h.values.get('ParamEyeBallX'))<.001);assert.equal(h.values.get('ParamMouthOpenY'),0);
  controller.disconnect();assert.equal(h.renderer.app.ticker.started,false);
});

test('final body driver is explicitly locked to the reviewed fourteen-control model',()=>{
  const profile=PROFILES['v3-final-candidate'];
  assert.equal(profile.pendingVerification,undefined);
  assert.equal(profile.verifiedMocSha256,'59db679fa0df638647373bcaeeebee894e92bb0c8f6b4bca185a863e0ec39a7b');
  const p=expressionParameters({moving:true,expression:'smile',gaze:'aside'},{profile:profile.id});
  assert.deepEqual(Object.keys(p).sort(),[...profile.parameters].sort());
  for(const id of ['ParamAngleZ','ParamBodyAngleX','ParamHandL','ParamHandR'])assert.equal(p[id],undefined);
});

test('final idle driver remains within partial authored ranges and preserves semantic gaze offset',()=>{
  const a=rig({profile:'v3-final-candidate'}),b=rig({profile:'v3-final-candidate'});
  const base={expression:'calm',moving:true,visible:true,connected:true,idleMotionAllowed:true,speaking:false,transientEpoch:0,actionSequence:0};
  a.renderer.render({...base,gaze:'forward'});b.renderer.render({...base,gaze:'aside'});
  const peaks={x:0,y:0,body:0,breath:0};
  for(let i=0;i<200;i++){
    a.frame(50);b.frame(50);
    peaks.x=Math.max(peaks.x,Math.abs(a.values.get('ParamAngleX')));peaks.y=Math.max(peaks.y,Math.abs(a.values.get('ParamAngleY')));
    peaks.body=Math.max(peaks.body,Math.abs(a.values.get('ParamBodyAngleY')));peaks.breath=Math.max(peaks.breath,a.values.get('ParamBreath'));
    for(const h of [a,b]){
      assert.ok(Math.abs(h.values.get('ParamAngleX'))<=18);assert.ok(Math.abs(h.values.get('ParamAngleY'))<=18);
      assert.ok(Math.abs(h.values.get('ParamBodyAngleY'))<=5);assert.ok(h.values.get('ParamBreath')>=0&&h.values.get('ParamBreath')<=.5);
      assert.equal(h.values.get('ParamArmScreenL'),0);assert.equal(h.values.get('ParamArmScreenR'),0);
    }
  }
  assert.ok(peaks.x>8&&peaks.y>5&&peaks.body>2&&peaks.breath>.4,'Micro-motion uses meaningful fractions of the already small authored range.');
  assert.ok(Math.abs(b.values.get('ParamAngleX')-a.values.get('ParamAngleX')+7)<.001);
  assert.equal(a.values.get('ParamMouthOpenY'),0);assert.equal(b.values.get('ParamMouthOpenY'),0);
});

test('final click response returns body to neutral, stays bounded and respects serious expressions',t=>{
  const h=rig({profile:'v3-final-candidate'}),classes=new Set();
  h.renderer.bubble={textContent:'',classList:{add:n=>classes.add(n),remove:n=>classes.delete(n)}};
  t.after(()=>h.renderer.clearTransient());
  const base={expression:'serious',gaze:'forward',moving:true,visible:true,connected:true,idleMotionAllowed:false,speaking:false,transientEpoch:1,actionSequence:0};
  h.renderer.render(base);h.frame();h.renderer.interact('greet');
  let sleevePeak=0,headPeak=0;
  for(let i=0;i<40;i++){h.frame(50);sleevePeak=Math.max(sleevePeak,h.values.get('ParamArmScreenL'));headPeak=Math.max(headPeak,h.values.get('ParamAngleY'));}
  assert.ok(sleevePeak>.35&&sleevePeak<=.6);assert.ok(headPeak>6&&headPeak<18);
  for(const id of ['ParamAngleX','ParamAngleY','ParamBodyAngleY','ParamBreath','ParamArmScreenL','ParamArmScreenR'])assert.equal(h.values.get(id),0);
  assert.equal(h.renderer.bodyGesture,null);assert.equal(h.renderer.stage.dataset.displayExpression,'serious');
  assert.equal(h.values.get('ParamMouthOpenY'),0);
});

test('final semantic actions play once and all lifecycle boundaries clear body motion immediately',()=>{
  for(const off of [{moving:false},{visible:false},{connected:false},{idleMotionAllowed:false,transientEpoch:2},{conversationId:'next',idleMotionAllowed:false,transientEpoch:2}]){
    const h=rig({profile:'v3-final-candidate'});
    const base={expression:'thinking',gaze:'aside',moving:true,visible:true,connected:true,idleMotionAllowed:true,speaking:false,conversationId:'first',transientEpoch:1,actionSequence:0,action:'none'};
    h.renderer.render(base);h.frame(50);
    h.renderer.render({...base,action:'nod',actionSequence:1});h.frame(50);
    assert.equal(h.renderer.bodyGesture.kind,'nod');const gesture=h.renderer.bodyGesture;
    h.renderer.render({...base,action:'nod',actionSequence:1});assert.equal(h.renderer.bodyGesture,gesture,'Duplicate snapshots do not replay an action.');
    for(let i=0;i<10;i++)h.frame(50);
    h.renderer.render({...base,action:'nod',actionSequence:1,...off});h.frame(50);
    assert.equal(h.renderer.bodyGesture,null);
    for(const id of ['ParamAngleX','ParamAngleY','ParamBodyAngleY','ParamBreath','ParamArmScreenL','ParamArmScreenR'])assert.equal(h.values.get(id),0);
    assert.equal(h.values.get('ParamMouthOpenY'),0);
  }
});

test('candidate model guard checks moc bytes while default v2 has no extra fetch',async t=>{
  const names=['fetch','location','crypto'],previous=new Map(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  t.after(()=>{for(const [name,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}});
  const calls=[],bytes=Uint8Array.from([1,2,3]),expected=PROFILES['v3-candidate'].verifiedMocSha256;
  let reference='original-face.moc3',hash=expected;
  Object.defineProperty(globalThis,'location',{configurable:true,value:{href:'http://127.0.0.1/test'}});
  Object.defineProperty(globalThis,'fetch',{configurable:true,value:async url=>{
    calls.push(url);return{ok:true,json:async()=>({FileReferences:{Moc:reference}}),arrayBuffer:async()=>bytes.buffer};
  }});
  Object.defineProperty(globalThis,'crypto',{configurable:true,value:{subtle:{digest:async(algorithm,input)=>{
    assert.equal(algorithm,'SHA-256');assert.deepEqual(new Uint8Array(input),bytes);return Buffer.from(hash,'hex');
  }}}});
  assert.equal(await verifyModelProfile(),null);assert.equal(calls.length,0);
  assert.equal(await verifyModelProfile({profile:'v3-candidate'}),expected);assert.equal(calls.length,2);
  await assert.rejects(verifyModelProfile({profile:'v3-final-candidate'}),/hash does not match/);
  hash=PROFILES['v3-final-candidate'].verifiedMocSha256;
  assert.equal(await verifyModelProfile({profile:'v3-final-candidate'}),hash);
  assert.equal(await verifyModelProfile({profile:'v3-final-review'}),hash);
  hash=expected;
  await assert.rejects(verifyModelProfile({profile:'v3-gaze-legacy'}),/hash does not match/);
  await assert.rejects(verifyModelProfile({profile:'v3-mouthform-candidate'}),/hash does not match/);
  hash=PROFILES['v3-mouthform-candidate'].verifiedMocSha256;
  assert.equal(await verifyModelProfile({profile:'v3-mouthform-candidate'}),hash);
  await assert.rejects(verifyModelProfile({profile:'v3-candidate'}),/hash does not match/);
  hash=PROFILES['v3-gaze-legacy'].verifiedMocSha256;
  assert.equal(await verifyModelProfile({profile:'v3-gaze-legacy'}),hash);
  await assert.rejects(verifyModelProfile({profile:'v3-candidate'}),/hash does not match/,'The old MOC cannot gain blink or the repaired mouth curve.');
  hash='0'.repeat(64);await assert.rejects(verifyModelProfile({profile:'v3-candidate'}),/hash does not match/);
  reference='https://example.invalid/other.moc3';const before=calls.length;
  await assert.rejects(verifyModelProfile({profile:'v3-candidate'}),/local model directory/);assert.equal(calls.length,before+1);
});

test('Controller lifecycle markers cancel temporary expressions and leave unbound head actions inactive',()=>{
  const renderer=new Live2DRenderer(stage(),()=>{});
  let timer=0;
  const controller=new Controller({renderer,setTimeout:()=>++timer,clearTimeout(){}});
  const old={id:'chat',messages:[],status:'completed'};
  controller.setConnected(true);controller.select(old);controller.begin(old);
  const chat={id:'chat',status:'running',turnId:'t1',messages:[{id:'u1',role:'user'},{id:'a1',role:'assistant',avatar:{expression:'smile',pose:'explain',action:'nod'}}]};
  controller.observe(chat,{connected:true});
  assert.equal(renderer.action,undefined,'The face-only rig does not claim an unbound head gesture.');
  renderer.reaction={expression:'wry',until:Infinity};const reaction=renderer.reaction;
  controller.observe(chat,{connected:true});assert.equal(renderer.reaction,reaction,'Repeated snapshots preserve an active click reaction.');
  controller.stop();
  assert.equal(renderer.reaction,null);
  controller.select(chat);controller.observe(chat,{connected:true});assert.equal(renderer.reaction,null);
  renderer.reaction={expression:'wry',until:Infinity};controller.setVisible(false);assert.equal(renderer.reaction,null);
  controller.disconnect();assert.equal(renderer.snapshot.connected,false);
});

test('a frozen render immediately applies closed mouth and the new expression with the vendor update contract',()=>{
  const h=rig();
  const snapshot={expression:'smile',intensity:'low',gaze:'forward',moving:true,visible:true,connected:true,speaking:true,mouthLevel:.3,transientEpoch:1,actionSequence:0,conversationId:'chat'};
  h.renderer.render(snapshot);h.frame();
  assert.ok(h.values.get('ParamMouthOpenY')>0);
  const warmBrow=h.values.get('ParamBrowLY');
  h.renderer.render({...snapshot,moving:false,speaking:false,mouthLevel:0,expression:'serious',transientEpoch:2});
  assert.equal(h.renderer.app.ticker.started,false);
  assert.equal(h.values.get('ParamMouthOpenY'),0,'Stopping animation must not freeze an open mouth.');
  assert.equal(h.renderer.diagnostics().parameters.find(parameter=>parameter.id==='ParamMouthOpenY').value,0,'The stopped frame also replaces the last submitted-mouth diagnostic.');
  assert.ok(h.values.get('ParamBrowLY')<warmBrow,'A new static expression must reach the core without the ticker.');
});

test('static first load applies the safe facial state before any animation tick',()=>{
  const h=rig();
  h.renderer.render({expression:'calm',moving:false,speaking:false,visible:false,connected:true,transientEpoch:0,actionSequence:0});
  assert.equal(h.renderer.app.ticker.started,false);
  assert.equal(h.values.get('ParamMouthOpenY'),0);
  assert.equal(h.values.get('ParamEyeLOpen'),1);assert.equal(h.values.get('ParamEyeROpen'),1);
  assert.equal(h.values.get('ParamBrowLY'),0);assert.equal(h.values.get('ParamBrowRY'),0);
});

test('hidden or disconnected snapshots immediately close the mouth and release a blink',()=>{
  for(const inactive of [{visible:false},{connected:false}]) {
    const h=rig(),snapshot={expression:'calm',moving:true,visible:true,connected:true,speaking:true,mouthLevel:.3,eyesClosed:true};
    h.renderer.render(snapshot);h.frame();
    assert.ok(h.values.get('ParamMouthOpenY')>0);assert.ok(h.values.get('ParamEyeLOpen')<1);
    h.renderer.render({...snapshot,...inactive});
    assert.equal(h.renderer.app.ticker.started,false);
    assert.equal(h.values.get('ParamMouthOpenY'),0);assert.equal(h.values.get('ParamEyeLOpen'),1);
  }
});

test('diagnostics tolerate loading and report submitted blink values rather than the unsquinted expression',()=>{
  const loading=new Live2DRenderer(stage(),()=>{});
  assert.deepEqual(loading.diagnostics(),{renderer:'live2d',loaded:false,profile:'v2',drivenParameters:PARAMETERS,blinkSupported:true,parameterObservation:'Last rendered-frame values submitted to Core; vendor restores saved defaults between frames',parameters:[],canvas:null,snapshot:{}});
  const h=rig();
  h.renderer.render({expression:'calm',moving:true,visible:true,connected:true,speaking:true,mouthLevel:.1,eyesClosed:true});
  h.frame(33);
  const report=h.renderer.diagnostics();
  const actual=id=>report.parameters.find(parameter=>parameter.id===id).value;
  assert.equal(report.loaded,true);
  assert.equal(h.renderer.values.ParamEyeLOpen,1,'The underlying calm expression stays open.');
  assert.ok(actual('ParamEyeLOpen')<.3,'The report includes the blink currently submitted to Core.');
  assert.equal(actual('ParamEyeLOpen'),h.values.get('ParamEyeLOpen'));
  assert.equal(actual('ParamMouthOpenY'),h.values.get('ParamMouthOpenY'));
  for(const [id,meta] of h.renderer.parameterInfo)h.values.set(id,meta.default);
  const betweenFrames=h.renderer.diagnostics().parameters;
  assert.equal(betweenFrames.find(parameter=>parameter.id==='ParamEyeLOpen').value,actual('ParamEyeLOpen'),'Vendor restoration between frames must not replace the displayed blink value.');
  assert.equal(betweenFrames.find(parameter=>parameter.id==='ParamMouthOpenY').value,actual('ParamMouthOpenY'));
  h.renderer.destroy();
  h.renderer.core.getParameterValueByIndex=()=>{throw new Error('Core already released');};
  assert.deepEqual(h.renderer.diagnostics().parameters,[],'Teardown must not read a released Core model.');
  assert.equal(h.renderer.diagnostics().canvas,null);
});

test('click interaction keeps the bubble and temporary face reaction without inventing head movement',t=>{
  const h=rig(),classes=new Set();
  h.renderer.bubble={textContent:'',classList:{add:name=>classes.add(name),remove:name=>classes.delete(name)}};
  t.after(()=>h.renderer.clearTransient());
  h.renderer.render({expression:'calm',moving:true,speaking:false,visible:true,connected:true});
  assert.equal(h.renderer.interact('greet'),true);h.frame();
  assert.ok(h.renderer.bubble.textContent.includes('（'));
  assert.equal(h.renderer.stage.dataset.displayExpression,'smile');
  assert.equal(h.values.get('ParamMouthOpenY'),0,'An interaction bubble does not pretend audio is playing.');
  assert.equal(h.renderer.action,undefined);
  assert.equal(h.renderer.interact('greet'),false,'Immediate repeated clicks are debounced.');
  h.renderer.render({expression:'calm',moving:false,speaking:false});
  assert.equal(h.renderer.reaction,null);assert.equal(classes.has('visible'),false);
});

test('new streamed concern or serious replies outrank an active greeting reaction, while duplicate snapshots preserve it',async t=>{
  const {AvatarMessageWriter}=await import('../avatar-protocol.mjs');
  for(const [expression,pose] of [['concern','lean'],['serious','folded']]){
    const h=rig(),classes=new Set();
    h.renderer.bubble={textContent:'',classList:{add:name=>classes.add(name),remove:name=>classes.delete(name)}};
    const controller=new Controller({renderer:h.renderer,setTimeout:()=>1,clearTimeout(){}});
    t.after(()=>{controller.resetFrames();h.renderer.clearTransient();});
    const conversation={id:'context-'+expression,status:'running',turnId:'turn-'+expression,messages:[{id:'u',role:'user',text:'Synthetic context for the reply.'}]};
    controller.setConnected(true);controller.begin(conversation);
    assert.equal(h.renderer.interact('greet'),true);h.frame();
    assert.equal(h.renderer.stage.dataset.displayExpression,'smile');
    const reaction=h.renderer.reaction;
    controller.observe(conversation,{connected:true});h.frame();
    assert.equal(h.renderer.reaction,reaction,'An unchanged thinking snapshot must not erase a local interaction.');
    const message={id:'reply',role:'assistant',status:'streaming',turnId:conversation.turnId,text:''};
    const writer=new AvatarMessageWriter();
    writer.write(message,{delta:'<yukino-avatar expression="'+expression+'"'});
    writer.write(message,{delta:' pose="'+pose+'" intensity="low" gaze="forward" action="none"/>状況を確認しましょう。（我们确认一下情况吧。）'});
    controller.observe({...conversation,messages:[...conversation.messages,message]},{connected:true});h.frame();
    assert.equal(controller.snapshot().expression,expression);
    assert.equal(h.renderer.stage.dataset.displayExpression,expression,'Current conversation intent must replace the temporary smile immediately.');
    assert.equal(h.renderer.reaction,null);assert.equal(classes.has('visible'),false);
    assert.equal(h.values.get('ParamMouthOpenY'),0);
  }
});

test('original face loads with only its five parameters and shares the room canvas origin',async t=>{
  const previous=new Map(['document','window','Image','PIXI','YukinoAvatar'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  let renderer;
  t.after(()=>{renderer?.destroy();for(const [name,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}});
  const writes=new Map(),callbacks=new Map(),vectors={};let loadedPath,options;
  const node=()=>({children:[],classList:{add(){},remove(){}},append(...children){this.children.push(...children);},setAttribute(){},addEventListener(){},removeEventListener(){}});
  globalThis.document={createElement:node,body:{classList:{add(){},remove(){}}},head:{append(script){queueMicrotask(()=>script.onload());}}};
  globalThis.window={addEventListener(){},removeEventListener(){}};
  globalThis.Image=class {set src(value){this.url=value;queueMicrotask(()=>this.onload());}};
  globalThis.YukinoAvatar={validateManifest:value=>value};
  const ids=['ParamEyeLOpen','ParamEyeROpen','ParamMouthOpenY','ParamBrowLY','ParamBrowRY'];
  const internal={width:1672,height:941,coreModel:{_model:{parameters:{count:ids.length,ids,minimumValues:[0,0,0,-1,-1],maximumValues:[1,1,1,1,1],defaultValues:[1,1,0,0,0]}},setParameterValueByIndex(index,value){writes.set(ids[index],value);}},motionManager:{stopAllMotions(){}},on(event,callback){callbacks.set(event,callback);}};
  const model={internalModel:internal,anchor:{set(...v){vectors.anchor=v;}},scale:{set(...v){vectors.scale=v;}},position:{set(...v){vectors.position=v;}},update(){callbacks.get('beforeModelUpdate')?.();},destroy(){}};
  globalThis.PIXI={UPDATE_PRIORITY:{HIGH:50},Application:class {constructor(value){options=value;this.stage={addChild(){}};this.ticker={started:false,add(){}};}start(){this.ticker.started=true;}stop(){this.ticker.started=false;}render(){}destroy(){}},live2d:{Live2DModel:{async from(path){loadedPath=path;return model;}}}};
  renderer=new Live2DRenderer(stage(),()=>{});
  renderer.render({expression:'calm',moving:false,speaking:false});
  await renderer.load({scene:{width:1672,height:941,room:'/room.png'}});
  assert.equal(loadedPath,MODEL);assert.equal(renderer.stage.dataset.renderer,'live2d');
  assert.deepEqual(vectors,{anchor:[0,0],scale:[1],position:[0,0]});
  assert.equal(options.width,1672);assert.equal(options.height,941);
  assert.equal(renderer.app.ticker.maxFPS,30);
  assert.equal(writes.get('ParamEyeLOpen'),1);assert.equal(writes.get('ParamMouthOpenY'),0);
  assert.equal(renderer.plane.children.filter(child=>child.className==='avatar-room live2d-desk').length,0,'No duplicate table layer covers the authored hands.');
});

function fallbackFixture(t,{fail=false,deferred=false}={}) {
  const previousAvatar=Object.getOwnPropertyDescriptor(globalThis,'YukinoAvatar');
  const previousDocument=Object.getOwnPropertyDescriptor(globalThis,'document');
  const classes=new Set(['avatar-ready']);let resolveLoad;
  const gate=deferred?new Promise(resolve=>{resolveLoad=resolve;}):Promise.resolve();
  const body={classList:{add:name=>classes.add(name),remove:name=>classes.delete(name)}};
  class Sprite {
    constructor(target){this.stage=target;this.destroyCount=0;}
    render(snapshot){this.snapshot=snapshot;}
    async load(){await gate;if(fail)throw new Error('sprite assets unavailable');this.stage.replaceChildren('sprite');this.stage.hidden=false;body.classList.add('avatar-ready');return {states:['calm']};}
    destroy(){this.destroyCount++;this.stage.replaceChildren();this.stage.hidden=true;}
  }
  globalThis.YukinoAvatar={SpriteRenderer:Sprite};globalThis.document={body};
  t.after(()=>{
    if(previousAvatar)Object.defineProperty(globalThis,'YukinoAvatar',previousAvatar);else delete globalThis.YukinoAvatar;
    if(previousDocument)Object.defineProperty(globalThis,'document',previousDocument);else delete globalThis.document;
  });
  const target=stage(),renderer=new Renderer(target);renderer.manifest={};
  return {renderer,target,classes,resolveLoad:()=>resolveLoad?.()};
}

test('successful fallback preserves the latest controller state without replaying speech',async t=>{
  const f=fallbackFixture(t,{deferred:true});
  f.renderer.render({expression:'smile',speaking:true,mouthLevel:.3});
  const loading=f.renderer.fallback(new Error('WebGL unavailable'));
  f.renderer.render({expression:'concern',speaking:false,mouthLevel:0});
  f.resolveLoad();await loading;
  assert.equal(f.target.dataset.renderer,'sprite');
  assert.equal(f.renderer.engine.snapshot.expression,'concern');
  assert.equal(f.renderer.engine.snapshot.speaking,false);
});

test('fallback asset failure restores the original background instead of leaving an empty ready layer',async t=>{
  const f=fallbackFixture(t,{fail:true});
  await assert.rejects(f.renderer.fallback(new Error('WebGL unavailable')),/sprite assets unavailable/);
  assert.equal(f.target.hidden,true);assert.equal(f.target.dataset.renderer,'background');
  assert.equal(f.classes.has('avatar-ready'),false);assert.equal(f.target.children.length,0);
});

test('a late fallback load after destroy cannot resurrect the scene',async t=>{
  const f=fallbackFixture(t,{deferred:true});
  const loading=f.renderer.fallback(new Error('WebGL unavailable'));
  const sprite=f.renderer.engine;f.renderer.destroy();
  f.resolveLoad();await loading;
  assert.equal(f.target.hidden,true);assert.equal(f.target.children.length,0);
  assert.equal(f.classes.has('avatar-ready'),false);
  assert.ok(sprite.destroyCount>=2,'The late resource completion receives teardown too.');
});

test('context-loss fallback rejection is handled after restoring the background',async t=>{
  const f=fallbackFixture(t,{fail:true});
  const original=Live2DRenderer.prototype.load;
  Live2DRenderer.prototype.load=async function(){return {renderer:'live2d'};};
  t.after(()=>{Live2DRenderer.prototype.load=original;});
  await f.renderer.load({});
  // Exercise the same onFailure callback installed for webglcontextlost. Node's
  // test runner fails this test if its detached fallback rejection is unhandled.
  f.renderer.engine.onFailure(new Error('WebGL context lost'));
  await new Promise(resolve=>setImmediate(resolve));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.target.dataset.renderer,'background');assert.equal(f.target.hidden,true);
  assert.equal(f.classes.has('avatar-ready'),false);
});
