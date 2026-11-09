(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.YukinoLive2D = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const MODEL = '/live2d/yukino/original-face-v3-59db679f/original-face.model3.json';
  const SCRIPTS = ['pixi.min.js', 'unsafe-eval.min.js', 'live2dcubismcore.min.js', 'cubism4.min.js'];
  const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
  const PARAMETERS = Object.freeze(['ParamEyeLOpen','ParamEyeROpen','ParamMouthOpenY','ParamBrowLY','ParamBrowRY']);
  const LEGACY_CANDIDATE_PARAMETERS = Object.freeze(['ParamEyeBallX','ParamEyeBallY','ParamBrowLY','ParamBrowRY','ParamMouthOpenY']);
  const CANDIDATE_PARAMETERS = Object.freeze(['ParamEyeLOpen','ParamEyeROpen',...LEGACY_CANDIDATE_PARAMETERS]);
  const MOUTHFORM_PARAMETERS = Object.freeze([...CANDIDATE_PARAMETERS,'ParamMouthForm']);
  const BODY_PARAMETERS = Object.freeze(['ParamAngleX','ParamAngleY','ParamBodyAngleY','ParamBreath','ParamArmScreenL','ParamArmScreenR']);
  const CANDIDATE_MOUTH = Object.freeze({threshold:.005,minOpen:0,maxOpen:.30,scale:.06});
  // The library retains its five-control v2 default; the app opts into its
  // reviewed profile explicitly. Each new whitelist belongs to scanned MOC bytes, not
  // merely to standard parameter IDs, which can exist without an authored bind.
  const PROFILES = Object.freeze({
    v2:Object.freeze({id:'v2',parameters:PARAMETERS,blink:true,gaze:false,mouth:null}),
    'v3-candidate':Object.freeze({id:'v3-candidate',parameters:CANDIDATE_PARAMETERS,blink:true,gaze:true,continuousMouth:true,mouth:CANDIDATE_MOUTH,
      verifiedMocSha256:'4c9175ab66cc8a2cb556ada14213dd9979b010cc36d1362257a93611fdf6c943'}),
    'v3-mouthform-candidate':Object.freeze({id:'v3-mouthform-candidate',parameters:MOUTHFORM_PARAMETERS,blink:true,gaze:true,mouthForm:true,continuousMouth:true,mouth:CANDIDATE_MOUTH,
      verifiedMocSha256:'71a0d88b09d17d24ecc51a526f65f721a3088e77b86f3dedcf718d0d95d16920'}),
    // Final original-art rig: independently scanned in actual Cubism Core and
    // exercised with native playback/blink timers before enabling this hash.
    'v3-final-candidate':Object.freeze({id:'v3-final-candidate',parameters:Object.freeze([...MOUTHFORM_PARAMETERS,...BODY_PARAMETERS]),blink:true,gaze:true,mouthForm:true,body:true,continuousMouth:true,mouth:CANDIDATE_MOUTH,
      verifiedMocSha256:'59db679fa0df638647373bcaeeebee894e92bb0c8f6b4bca185a863e0ec39a7b'}),
    // Retained as an explicit name for reproducing the isolated acceptance run.
    'v3-final-review':Object.freeze({id:'v3-final-review',parameters:Object.freeze([...MOUTHFORM_PARAMETERS,...BODY_PARAMETERS]),blink:true,gaze:true,mouthForm:true,body:true,continuousMouth:true,mouth:CANDIDATE_MOUTH,
      verifiedMocSha256:'59db679fa0df638647373bcaeeebee894e92bb0c8f6b4bca185a863e0ec39a7b'}),
    'v3-gaze-legacy':Object.freeze({id:'v3-gaze-legacy',parameters:LEGACY_CANDIDATE_PARAMETERS,blink:false,gaze:true,mouth:Object.freeze({...CANDIDATE_MOUTH,minOpen:.1}),
      verifiedMocSha256:'845cd1360e69b092fa7fa9b52b4acb632e2b58d72c795a744654748fe788e766'}),
  });
  const GAZE = Object.freeze({forward:Object.freeze([0,0]),aside:Object.freeze([-.55,-.08]),down:Object.freeze([0,-.45])});
  function resolveProfile(options={}) {
    const name=options.profile||'v2';
    if(!Object.prototype.hasOwnProperty.call(PROFILES,name))throw new Error('Unknown Live2D profile');
    const profile=PROFILES[name];
    if(!options.mouth)return profile;
    if(!profile.gaze)throw new Error('Custom mouth mapping is candidate-only');
    const mouth={...profile.mouth,...options.mouth};
    if(!Number.isFinite(mouth.threshold)||mouth.threshold<0||mouth.threshold>=1||
      !Number.isFinite(mouth.minOpen)||(profile.continuousMouth?mouth.minOpen!==0:mouth.minOpen<.1)||
      !Number.isFinite(mouth.maxOpen)||mouth.maxOpen<=mouth.minOpen||mouth.maxOpen>profile.mouth.maxOpen||
      !Number.isFinite(mouth.scale)||mouth.scale<=0)throw new Error('Invalid candidate mouth mapping');
    return Object.freeze({...profile,mouth:Object.freeze(mouth)});
  }
  const isMoving = snapshot => !!snapshot.moving && snapshot.visible !== false && snapshot.connected !== false;
  // The default v2 face rig has five authored controls. These small eye
  // and brow changes do not imply head, gaze, body, or mouth-form movement.
  const PRESETS = Object.freeze({
    calm: { eye: 1, browL: 0, browR: 0 },
    smile: { eye: .96, browL: .06, browR: .06 },
    thinking: { eye: .9, browL: -.08, browR: -.04 },
    concern: { eye: .97, browL: .14, browR: .14 },
    shy: { eye: .92, browL: -.03, browR: -.03 },
    serious: { eye: .96, browL: -.12, browR: -.12 },
    wry: { eye: .88, browL: -.08, browR: .04 },
    surprise: { eye: 1, browL: .2, browR: .2 },
  });
  const LABELS = { calm:'平静倾听', smile:'温和', thinking:'思索', concern:'关切', shy:'略显含蓄', serious:'认真', wry:'轻微无奈', surprise:'轻微惊讶' };
  // Positive authored form lowers the line's center slightly (a quiet smile).
  // This is an expression offset, independent of playback-driven mouth opening.
  const MOUTH_FORMS = Object.freeze({calm:0,smile:.35,thinking:-.08,concern:-.18,shy:.15,serious:-.20,wry:.10,surprise:0});

  function mappedMouth(level,profile) {
    if(profile.mouth){
      const p=profile.mouth,signal=clamp(level);
      // Only the verified repaired curve may traverse 0..0.1. Subtracting the
      // quiet threshold also removes the jump at voice onset; silence is exact 0.
      const activeSignal=profile.continuousMouth?signal-p.threshold:signal;
      return signal<=p.threshold?0:Math.max(p.minOpen,Math.min(p.maxOpen,p.maxOpen*(1-Math.exp(-activeSignal/p.scale))));
    }
    const mouth=clamp(level*4,0,.65);
    return mouth<=.02?0:Math.max(.1,mouth);
  }
  function mouthOpenForLevel(level,options={}) {return mappedMouth(level,resolveProfile(options));}
  function parametersForProfile(snapshot,profile) {
    const p = Object.prototype.hasOwnProperty.call(PRESETS,snapshot.expression) ? PRESETS[snapshot.expression] : PRESETS.calm;
    const strength = snapshot.intensity === 'medium' ? 1 : .78;
    const mouthOpen = isMoving(snapshot) && snapshot.speaking ? mappedMouth(snapshot.mouthLevel || 0,profile) : 0;
    const parameters={ParamBrowLY:p.browL*strength,ParamBrowRY:p.browR*strength,ParamMouthOpenY:mouthOpen};
    if(profile.blink){
      parameters.ParamEyeLOpen=1+(p.eye-1)*strength;
      parameters.ParamEyeROpen=1+(p.eye-1)*strength;
    }
    if(profile.gaze){
      const gaze=Object.prototype.hasOwnProperty.call(GAZE,snapshot.gaze)?GAZE[snapshot.gaze]:GAZE.forward;
      parameters.ParamEyeBallX=gaze[0];parameters.ParamEyeBallY=gaze[1];
    }
    if(profile.mouthForm){
      const form=Object.prototype.hasOwnProperty.call(MOUTH_FORMS,snapshot.expression)?MOUTH_FORMS[snapshot.expression]:0;
      parameters.ParamMouthForm=clamp(form*strength,-.5,.5);
    }
    if(profile.body)for(const id of BODY_PARAMETERS)parameters[id]=0;
    return parameters;
  }
  function expressionParameters(snapshot = {},options={}) {return parametersForProfile(snapshot,resolveProfile(options));}

  function bodyParameters(snapshot,time,gesture) {
    const values=Object.fromEntries(BODY_PARAMETERS.map(id=>[id,0]));
    if(!isMoving(snapshot))return values;
    if(snapshot.idleMotionAllowed!==false||snapshot.speaking){
      const ramp=clamp(time/900),fade=ramp*ramp*(3-2*ramp);
      const x=snapshot.gaze==='aside'?-7:0,y=snapshot.gaze==='down'?5:snapshot.expression==='thinking'?2:0;
      // The model's full authored ranges are already just 1–2 source pixels.
      // Fractions below preserve visible micro-motion without multiplying it away.
      values.ParamAngleX=fade*(x+10*Math.sin(time*Math.PI*2/8200));
      values.ParamAngleY=fade*(y+7*Math.sin(time*Math.PI*2/6700));
      values.ParamBodyAngleY=fade*3*Math.sin(time*Math.PI*2/7400);
      values.ParamBreath=fade*.25*(1-Math.cos(time*Math.PI*2/6400));
    }
    if(gesture){
      const pulse=Math.sin(Math.PI*clamp(gesture.elapsed/gesture.duration))**2;
      if(gesture.kind==='greet'||gesture.kind==='nod'){
        values.ParamAngleY+=12*pulse;values.ParamBodyAngleY+=2*pulse;
        if(gesture.kind==='greet'){values.ParamArmScreenL=.6*pulse;values.ParamArmScreenR=.4*pulse;}
      }else if(gesture.kind==='hair'||gesture.kind==='tilt'){
        // No rotation/AngleZ is bound: this is only a tiny lateral response.
        values.ParamAngleX-=10*pulse;values.ParamAngleY+=3*pulse;
        if(gesture.kind==='hair')values.ParamArmScreenR=-.35*pulse;
      }
    }
    values.ParamAngleX=clamp(values.ParamAngleX,-18,18);values.ParamAngleY=clamp(values.ParamAngleY,-18,18);
    values.ParamBodyAngleY=clamp(values.ParamBodyAngleY,-5,5);
    return values;
  }

  async function verifyProfileModel(profile) {
    if(profile.pendingVerification)throw new Error('Candidate profile awaits final model verification');
    if(!profile.verifiedMocSha256)return null;
    const modelUrl=new URL(MODEL,root.location.href);
    const manifestResponse=await root.fetch(modelUrl.href,{credentials:'same-origin',cache:'no-store'});
    if(!manifestResponse.ok)throw new Error('Candidate model manifest unavailable');
    const manifest=await manifestResponse.json(),reference=manifest.FileReferences?.Moc;
    if(typeof reference!=='string'||!reference)throw new Error('Candidate moc reference missing');
    const mocUrl=new URL(reference,modelUrl);
    if(mocUrl.origin!==modelUrl.origin||!mocUrl.pathname.startsWith(modelUrl.pathname.slice(0,modelUrl.pathname.lastIndexOf('/')+1)))throw new Error('Candidate moc must stay in its local model directory');
    const response=await root.fetch(mocUrl.href,{credentials:'same-origin',cache:'no-store'});
    if(!response.ok)throw new Error('Candidate moc unavailable');
    const bytes=await response.arrayBuffer();
    const digest=await root.crypto.subtle.digest('SHA-256',bytes);
    const hash=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
    if(hash!==profile.verifiedMocSha256)throw new Error('Candidate moc hash does not match the verified bound profile');
    return hash;
  }
  async function verifyModelProfile(options={}) {return verifyProfileModel(resolveProfile(options));}

  let runtimePromise;
  function loadRuntime() {
    if (runtimePromise) return runtimePromise;
    runtimePromise = (async () => {
      for (const file of SCRIPTS) await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        const timer = setTimeout(() => reject(new Error(`Runtime timeout: ${file}`)),15000);
        script.onload = () => { clearTimeout(timer); resolve(); };
        script.onerror = () => { clearTimeout(timer); reject(new Error(`Runtime unavailable: ${file}`)); };
        script.src = `/live2d/vendor/${file}`; document.head.append(script);
      });
      if (!root.PIXI?.live2d?.Live2DModel) throw new Error('Live2D runtime unavailable');
    })();
    return runtimePromise;
  }

  class Live2DRenderer {
    constructor(stage, onFailure, options={}) {
      this.profile=resolveProfile(options);
      this.stage=stage; this.onFailure=onFailure; this.snapshot={}; this.values={}; this.appliedValues={};
      this.reaction=null;
      this.bodyTime=0;this.bodyGesture=null;
      this.lastClick=-Infinity; this.clickTimes=[]; this.destroyed=false; this.cleanups=[];
    }
    async load(input) {
      const manifest=root.YukinoAvatar.validateManifest(input);
      await loadRuntime();
      if (this.destroyed) return;
      // Default v2 does not issue extra requests. The opt-in candidate must
      // match its scanned moc bytes; standard parameter IDs alone prove no bind.
      this.verifiedMocSha256=await verifyProfileModel(this.profile);
      if (this.destroyed) return;
      const PIXI=root.PIXI;
      const plane=document.createElement('div'); plane.className='avatar-plane live2d-plane';
      const room=new Image(); room.className='avatar-room'; room.alt=''; room.draggable=false;
      await new Promise((resolve,reject)=>{room.onload=resolve;room.onerror=()=>reject(new Error('Room unavailable'));room.src=manifest.scene.room;});
      const canvas=document.createElement('canvas'); canvas.className='live2d-canvas'; canvas.setAttribute('aria-hidden','true');
      plane.append(room,canvas);
      // The original seated artwork already includes the hands at table level;
      // another room/table overlay would cover those original pixels.
      this.bubble=document.createElement('output'); this.bubble.className='avatar-reaction'; this.bubble.setAttribute('aria-live','polite');
      plane.append(this.bubble);
      this.hair=this.makeHotspot('hair','轻触雪乃的头发',plane);
      this.greeting=this.makeHotspot('greet','向雪乃打个招呼',plane);
      this.stage.style.setProperty('--scene-ratio',String(manifest.scene.width/manifest.scene.height));
      this.stage.style.setProperty('--avatar-room-image',`url("${manifest.scene.room}")`);
      this.plane=plane; this.canvas=canvas;
      const app=new PIXI.Application({view:canvas,width:manifest.scene.width,height:manifest.scene.height,backgroundAlpha:0,antialias:true,autoStart:false,resolution:1,autoDensity:true,sharedTicker:false});
      this.app=app; app.ticker.maxFPS=30;
      this.model=await PIXI.live2d.Live2DModel.from(MODEL,{autoInteract:false,autoUpdate:false,motionPreload:'NONE',idleMotionGroup:'__disabled__'});
      if (this.destroyed) { this.model.destroy(); app.destroy(false); return; }
      app.stage.addChild(this.model);
      const internal=this.model.internalModel; this.internal=internal; this.core=internal.coreModel;
      internal.eyeBlink=undefined;
      // Only drive this explicit authored profile; source motions and the
      // vendor's default head/gaze effects must not add unsupported movement.
      internal.updateNaturalMovements=()=>{};
      internal.motionManager.stopAllMotions();
      this.parameterInfo=new Map();
      const parameters=this.core._model.parameters;
      for(let index=0;index<parameters.count;index++) this.parameterInfo.set(parameters.ids[index],{index,min:parameters.minimumValues[index],max:parameters.maximumValues[index],default:parameters.defaultValues[index]});
      for(const required of this.profile.parameters) if(!this.parameterInfo.has(required)) throw new Error(`Missing model parameter: ${required}`);
      // Model and room share the original 1672 x 941 canvas coordinates.
      this.model.anchor.set(0,0);
      this.model.scale.set(manifest.scene.width / internal.width);
      this.model.position.set(0,0);
      internal.on('beforeModelUpdate',()=>this.applyParameters());
      app.ticker.add(()=>this.advance(Math.min(app.ticker.deltaMS,50)),null,PIXI.UPDATE_PRIORITY.HIGH);
      const onContextLost=event=>{event.preventDefault();this.onFailure(new Error('WebGL context lost'));};
      canvas.addEventListener('webglcontextlost',onContextLost);
      this.cleanups.push(()=>canvas.removeEventListener('webglcontextlost',onContextLost));
      const onBlur=()=>this.clearTransient(); window.addEventListener('blur',onBlur);
      this.cleanups.push(()=>window.removeEventListener('blur',onBlur));
      this.stage.replaceChildren(plane);this.stage.hidden=false;document.body.classList.add('avatar-ready');
      this.stage.dataset.renderer='live2d';this.stage.dataset.loadedStates=Object.keys(PRESETS).join(',');
      this.stage.dataset.model=MODEL;this.stage.dataset.profile=this.profile.id;this.stage.dataset.blinkSupported=String(this.profile.blink);this.loaded=true;
      this.render(this.snapshot);
      return {renderer:'live2d',states:Object.keys(PRESETS),model:MODEL};
    }
    makeHotspot(kind,label,plane) {
      const button=document.createElement('button');button.type='button';button.className=`avatar-hotspot avatar-hotspot-${kind}`;
      button.setAttribute('aria-label',label);button.title=label;button.addEventListener('click',()=>this.interact(kind));plane.append(button);return button;
    }
    interact(kind) {
      const now=performance.now();if(now-this.lastClick<750)return false;
      this.lastClick=now;this.clickTimes=this.clickTimes.filter(at=>now-at<6500);this.clickTimes.push(now);
      const repeated=this.clickTimes.length>=3;
      const respectful=['concern','serious'].includes(this.snapshot.expression);
      const expression=respectful?this.snapshot.expression:repeated?'wry':kind==='hair'?'thinking':'smile';
      this.bubble.textContent=repeated?'……聞こえているわ。（……我听到了。）':kind==='hair'?'……なにかしら。（……有什么事吗。）':'ええ、聞いているわ。（嗯，我在听。）';
      this.bubble.classList.add('visible');clearTimeout(this.bubbleTimer);
      this.bubbleTimer=setTimeout(()=>{this.bubble?.classList.remove('visible');},2800);
      if(isMoving(this.snapshot))this.reaction={expression,until:now+2200};
      if(this.profile.body&&isMoving(this.snapshot))this.bodyGesture={kind,elapsed:0,duration:1800};
      this.stage.dataset.interaction=kind;this.stage.dataset.interactionCount=String(Number(this.stage.dataset.interactionCount||0)+1);
      return true;
    }
    clearTransient() {
      this.reaction=null;this.clickTimes=[];this.lastClick=-Infinity;
      this.bodyGesture=null;
      clearTimeout(this.bubbleTimer);this.bubble?.classList.remove('visible');delete this.stage.dataset.interaction;
    }
    render(snapshot) {
      const changed=snapshot.transientEpoch!==this.snapshot.transientEpoch || snapshot.conversationId!==this.snapshot.conversationId;
      const presentationChanged=['expression','intensity','gaze'].some(key=>snapshot[key]!==this.snapshot[key]);
      const actionChanged=snapshot.actionSequence!==this.snapshot.actionSequence;
      this.snapshot=snapshot;
      // A new conversational attitude takes priority over a local click. An
      // identical repeated snapshot must not cancel an ongoing click reaction.
      if(changed || presentationChanged || !isMoving(snapshot))this.clearTransient();
      if(changed || !isMoving(snapshot))this.bodyTime=0;
      if(this.profile.body&&isMoving(snapshot)&&!changed&&actionChanged&&['nod','tilt'].includes(snapshot.action))this.bodyGesture={kind:snapshot.action,elapsed:0,duration:1600};
      if(!this.loaded)return;
      Object.assign(this.stage.dataset,{expression:snapshot.expression||'calm',pose:snapshot.pose||'rest',speaking:String(!!snapshot.speaking)});
      this.stage.classList.toggle('avatar-moving',isMoving(snapshot));
      if(isMoving(snapshot))this.app.start();
      else this.app.stop();
      // Render a final still frame immediately, including closed mouth on stop.
      if(!this.app.ticker.started){this.advance(0);this.app.render();}
    }
    advance(dt) {
      // pixi-live2d-display skips internalModel.update when its deltaTime is
      // zero. A positive sub-millisecond step flushes a still frame (closed
      // mouth/new expression) even though the animation ticker is stopped.
      this.dt=dt;this.model.update(Math.max(.001,dt));
    }
    applyParameters() {
      const now=performance.now(), moving=isMoving(this.snapshot);
      if(this.reaction && now>=this.reaction.until)this.reaction=null;
      const expression=this.reaction?.expression || this.snapshot.expression || 'calm';
      const target=parametersForProfile({...this.snapshot,expression},this.profile);
      const bodyActive=moving&&(this.snapshot.idleMotionAllowed!==false||this.snapshot.speaking||this.bodyGesture);
      if(this.profile.body){
        const step=clamp(this.dt??33,0,50);
        if(bodyActive)this.bodyTime+=step;else this.bodyTime=0;
        if(this.bodyGesture){this.bodyGesture.elapsed+=step;if(this.bodyGesture.elapsed>=this.bodyGesture.duration)this.bodyGesture=null;}
        Object.assign(target,bodyParameters({...this.snapshot,expression},this.bodyTime,this.bodyGesture));
      }
      const alpha=moving?1-Math.exp(-Math.max(this.dt||33,1)/240):1;
      const blinkTarget=this.profile.blink&&moving&&this.snapshot.eyesClosed?0:1;
      this.blink=this.profile.blink&&moving?(this.blink??1)+(blinkTarget-(this.blink??1))*(1-Math.exp(-Math.max(this.dt||33,1)/(blinkTarget?45:22))):1;
      for(const id of this.profile.parameters){
        const wanted=target[id];if(!Number.isFinite(wanted))continue;
        const meta=this.parameterInfo.get(id);if(!meta)continue;
        let value=(this.values[id]??wanted)+(wanted-(this.values[id]??wanted))*alpha;
        // Blink and playback cessation must not lag behind smoothed emotions.
        if(id==='ParamMouthOpenY')value=this.snapshot.speaking&&moving?wanted:0;
        if(this.profile.body&&BODY_PARAMETERS.includes(id)&&!bodyActive)value=0;
        this.values[id]=value;
        if(id==='ParamEyeLOpen'||id==='ParamEyeROpen')value*=this.blink;
        const applied=clamp(value,meta.min,meta.max);
        this.core.setParameterValueByIndex(meta.index,applied);
        this.appliedValues[id]=applied;
      }
      this.stage.dataset.displayExpression=expression;this.stage.dataset.mouthLevel=String(Number((target.ParamMouthOpenY||0).toFixed(3)));
      this.stage.dataset.frame=this.profile.blink&&this.snapshot.eyesClosed&&moving?'blink':target.ParamMouthOpenY>.02?'talk':'base';
      this.stage.setAttribute('aria-label',`雪乃互动形象 · ${LABELS[expression]||LABELS.calm}`);
    }
    diagnostics() {
      // Cache the final submitted values: this.values precedes blinking, and
      // the vendor restores saved defaults in Core between rendered frames.
      const parameters=this.loaded?this.parameterInfo:[];
      return {renderer:'live2d',loaded:!!this.loaded,
        profile:this.profile.id,drivenParameters:[...this.profile.parameters],blinkSupported:this.profile.blink,
        parameterObservation:'Last rendered-frame values submitted to Core; vendor restores saved defaults between frames',
        parameters:[...parameters].map(([id,meta])=>({id,...meta,value:this.appliedValues[id]??this.core.getParameterValueByIndex(meta.index)})),
        canvas:this.loaded?{width:this.internal.width,height:this.internal.height}:null,snapshot:{...this.snapshot}};
    }
    destroy() {
      this.destroyed=true;this.loaded=false;this.clearTransient();for(const cleanup of this.cleanups)cleanup();this.cleanups=[];
      try{this.model?.destroy();this.app?.destroy(false);}catch{}
      this.stage.replaceChildren();
    }
  }

  class Renderer {
    constructor(stage,options={}) {this.stage=stage;this.options=options;this.pending={};this.engine=null;this.failed=false;this.destroyed=false;}
    async load(manifest) {
      this.manifest=manifest;
      const engine=new Live2DRenderer(this.stage,error=>{void this.fallback(error).catch(()=>{});},this.options);this.engine=engine;
      engine.render(this.pending);
      try{return await engine.load(manifest);}catch(error){return this.fallback(error);}
    }
    async fallback(error) {
      if(this.destroyed || this.failed)return;
      this.failed=true;this.engine?.destroy();
      const sprite=new root.YukinoAvatar.SpriteRenderer(this.stage);this.engine=sprite;sprite.render(this.pending);
      try {
        const result=await sprite.load(this.manifest);
        // Late image loads may finish after teardown. Clear before a paint.
        if(this.destroyed){sprite.destroy();document.body.classList.remove('avatar-ready');return;}
        this.stage.dataset.renderer='sprite';this.stage.dataset.fallbackReason=String(error?.message||'Live2D unavailable').slice(0,120);
        return {...result,renderer:'sprite'};
      } catch(fallbackError) {
        sprite.destroy();this.stage.hidden=true;document.body.classList.remove('avatar-ready');
        this.stage.dataset.renderer='background';
        throw fallbackError;
      }
    }
    render(snapshot) {this.pending=snapshot;this.engine?.render(snapshot);}
    diagnostics() {return this.engine?.diagnostics?.()||{renderer:'sprite'};}
    destroy() {this.destroyed=true;this.engine?.destroy();this.stage.hidden=true;document.body.classList.remove('avatar-ready');}
  }
  return {Renderer,Live2DRenderer,expressionParameters,mouthOpenForLevel,verifyModelProfile,PRESETS,PARAMETERS,CANDIDATE_PARAMETERS,CANDIDATE_MOUTH,PROFILES,MODEL};
});
