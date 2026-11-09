const test=require('node:test');
const assert=require('node:assert/strict');
const {StreamAudioQueue,pcmChunk,formatOf}=require('../public/stream-audio.js');
const {AdaptiveAudioQueue,Controller}=require('../public/voice.js');
const clarity=require('../public/audio-clarity.js');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const format={type:'format',sampleRate:48000,channels:1,bitsPerSample:16,encoding:'pcm_s16le'};
function pcm(frames=19200,value=1000,channels=1){const bytes=Buffer.alloc(frames*channels*2);for(let i=0;i<bytes.length;i+=2)bytes.writeInt16LE(value,i);return bytes.toString('base64');}

function harness(options={}) {
  let now=0,sequence=0,denyResume=options.denyResume || false;
  const timers=new Map(),sources=[],compressors=[],analysers=[],splitters=[],requests=[],statuses=[],listeners=[],timings=[],levels=[];
  const context={state:options.suspended?'suspended':'running',currentTime:0,destination:{},
    addEventListener(type,listener){if(type==='statechange')listeners.push(listener);},
    notifyStateChange(){listeners.forEach(fn=>fn());},
    async resume(){if(denyResume){denyResume=false;throw Object.assign(new Error('blocked'),{name:'NotAllowedError'});}this.state='running';listeners.forEach(fn=>fn());},
    createBuffer(channels,frames,sampleRate){const data=Array.from({length:channels},()=>new Float32Array(frames));return {duration:frames/sampleRate,numberOfChannels:channels,sampleRate,getChannelData(index){return data[index];}};},
    createBufferSource(){const source={buffer:null,stopped:false,ended:false,connect(destination){this.destination=destination;},disconnect(){this.disconnected=true;},start(at){this.startAt=at;},stop(){this.stopped=true;}};sources.push(source);return source;},
    createDynamicsCompressor(){const compressor={connect(destination){this.destination=destination;},disconnect(){this.disconnected=true;}};for(const key of ['threshold','knee','ratio','attack','release'])compressor[key]={value:0};compressors.push(compressor);return compressor;},
    createAnalyser(){const analyser={fftSize:2048,level:.125,connect(destination){this.destination=destination;},disconnect(){this.disconnected=true;},getFloatTimeDomainData(data){for(let i=0;i<data.length;i++)data[i]=i%2?this.level:-this.level;}};analysers.push(analyser);return analyser;},
    createChannelSplitter(channels){const splitter={channels,connections:[],connect(destination,output,input){this.connections.push({destination,output,input});},disconnect(){this.disconnected=true;}};splitters.push(splitter);return splitter;},
  };
  const queue=new StreamAudioQueue({contextFactory:()=>context,clarityAPI:options.clarityAPI || clarity,clarityEnabled:!!options.clarityEnabled,
    now:()=>now,setTimeout(callback,delay){const id=++sequence;timers.set(id,{callback,at:now+delay});return id;},clearTimeout(id){timers.delete(id);},
    onStatus(status){statuses.push(status);},
    onLevel:options.measureLevels?level=>{levels.push(level);options.onLevel?.(level);}:undefined,
    onTiming(event){timings.push(event);options.onTiming?.(event);},
    fetch(url,request){
      const record={url,request};requests.push(record);
      const body=new ReadableStream({start(controller){record.controller=controller;},cancel(){record.cancelled=true;}});
      record.raw=value=>record.controller.enqueue(new TextEncoder().encode(value));
      record.event=value=>record.raw(JSON.stringify(value)+'\n');
      record.done=()=>{record.event({type:'done',metrics:{queueMs:2,firstAudioMs:50,completeMs:100}});record.controller.close();};
      return Promise.resolve({ok:true,headers:{get:()=> 'application/x-ndjson'},body});
    },
  });
  function advance(milliseconds){
    const until=now+milliseconds;
    const move=at=>{if(context.state==='running')context.currentTime+=(at-now)/1000;now=at;
      for(const source of sources)if(!source.stopped && !source.ended && source.startAt!==undefined && source.startAt+source.buffer.duration<=context.currentTime+.00001){source.ended=true;source.onended?.();}
    };
    for(;;){const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!next || next[1].at>until)break;timers.delete(next[0]);move(next[1].at);next[1].callback();}
    move(until);
  }
  return {queue,context,sources,compressors,analysers,splitters,requests,statuses,timings,timers,levels,advance};
}

test('PCM level reads the post-compressor analyser only at actual playback and is independent of clarity',async()=>{
  for(const clarityEnabled of [false,true]) {
    const h=harness({measureLevels:true,clarityEnabled});h.queue.enqueue(['声です。']);await tick();
    h.requests[0].event(format);h.requests[0].event({type:'audio',audio:pcm()});await tick();
    assert.equal(h.analysers.length,1);assert.equal(h.compressors[0].destination,h.analysers[0]);
    assert.equal(h.analysers[0].destination,h.context.destination);assert.equal(h.analysers[0].fftSize,1024);
    assert.ok(h.levels.every(value=>value===0),'prefetch and scheduled-but-unplayed PCM keep the mouth closed');
    h.advance(65);assert.equal(h.levels.at(-1),.125);
    h.analysers[0].level=0;h.advance(34);assert.equal(h.levels.at(-1),0,'silence is read from actual samples');
    h.analysers[0].level=.25;h.advance(34);assert.equal(h.levels.at(-1),.25);
    const oldCallbacks=[...h.timers.values()].map(item=>item.callback);
    h.queue.clear();assert.equal(h.levels.at(-1),0);assert.equal(h.analysers[0].disconnected,true);
    const count=h.levels.length;oldCallbacks.forEach(fn=>fn());h.advance(2000);
    assert.equal(h.levels.length,count);assert.equal(h.timers.size,0);
  }
});

test('PCM suspension, errors and sentence gaps immediately close the mouth without deleting queued data',async()=>{
  const h=harness({measureLevels:true});h.queue.enqueue(['一。','二。']);await tick();
  h.requests[0].event(format);h.requests[0].event({type:'audio',audio:pcm()});h.requests[0].done();await tick();
  h.requests[1].event(format);h.requests[1].event({type:'audio',audio:pcm()});h.requests[1].done();await tick();
  h.advance(65);assert.equal(h.levels.at(-1),.125);
  h.context.state='suspended';h.context.notifyStateChange();assert.equal(h.levels.at(-1),0);
  h.advance(500);assert.equal(h.levels.at(-1),0);assert.equal(h.sources.length,2);
  await h.queue.resume();assert.equal(h.levels.at(-1),.125);
  h.advance(430);assert.equal(h.levels.at(-1),0,'the 180 ms sentence gap has no speaking envelope');
  h.advance(160);assert.equal(h.levels.at(-1),.125);
  h.queue.fail('test');assert.equal(h.levels.at(-1),0);assert.equal(h.timers.size,0);
});

test('stereo PCM meter preserves opposite-phase channel energy and releases its observation branch',async()=>{
  const h=harness({measureLevels:true});h.queue.enqueue(['ステレオ。']);await tick();
  h.requests[0].event({...format,channels:2});h.requests[0].event({type:'audio',audio:pcm(19200,1000,2)});await tick();
  assert.equal(h.analysers.length,2);assert.equal(h.splitters[0].channels,2);
  assert.deepEqual(h.splitters[0].connections.map(connection=>connection.output),[0,1]);
  assert.equal(h.compressors[0].destination,h.context.destination,'The stereo output is independent of meter outputs.');
  assert.ok(h.analysers.every(analyser=>!analyser.destination));
  h.analysers[0].level=.25;h.analysers[1].level=-.25;h.advance(65);
  assert.equal(h.levels.at(-1),.25,'Opposite phases contribute the same energy.');
  h.analysers[1].level=0;h.advance(34);assert.ok(Math.abs(h.levels.at(-1)-.25/Math.sqrt(2))<1e-7);
  h.queue.clear();assert.equal(h.levels.at(-1),0);
  assert.ok(h.analysers.every(analyser=>analyser.disconnected));assert.equal(h.splitters[0].disconnected,true);
});

test('partially unavailable stereo meters cannot silence playback or retain connected meter nodes',async()=>{
  for(const unavailable of ['splitter','second analyser']){
    const h=harness({measureLevels:true});
    if(unavailable==='splitter')h.context.createChannelSplitter=()=>{throw new Error('splitter unavailable');};
    else {const create=h.context.createAnalyser;h.context.createAnalyser=()=>{if(h.analysers.length)throw new Error('second analyser unavailable');return create();};}
    h.queue.enqueue(['続けます。']);await tick();h.requests[0].event({...format,channels:2});h.requests[0].event({type:'audio',audio:pcm(19200,1000,2)});await tick();
    h.advance(65);assert.equal(h.statuses.at(-1).kind,'playing');assert.equal(h.compressors[0].destination,h.context.destination);
    assert.equal(h.levels.at(-1),0);assert.ok(h.analysers.every(analyser=>analyser.disconnected));assert.ok(h.splitters.every(splitter=>splitter.disconnected));h.queue.clear();
  }
});

test('an optional level consumer or unavailable analyser cannot break PCM playback',async()=>{
  const h=harness({measureLevels:true,onLevel(){throw new Error('avatar only');}});
  h.context.createAnalyser=()=>{throw new Error('meter unavailable');};
  h.queue.enqueue(['続けます。']);await tick();h.requests[0].event(format);h.requests[0].event({type:'audio',audio:pcm()});await tick();
  h.advance(65);assert.equal(h.statuses.at(-1).kind,'playing');assert.equal(h.compressors[0].destination,h.context.destination);
  assert.equal(h.levels.at(-1),0);h.queue.clear();
});

test('PCM parser preserves odd-byte/channel carries and rejects unsafe format data',()=>{
  const bytes=Buffer.from([0,128,255,127]);
  const first=pcmChunk(bytes.subarray(0,3).toString('base64'),2);
  assert.equal(first.samples.length,0);assert.equal(first.carry.length,3);
  const second=pcmChunk(bytes.subarray(3).toString('base64'),2,first.carry);
  assert.deepEqual([...second.samples],[-1,32767/32768]);assert.equal(second.carry.length,0);
  assert.throws(()=>pcmChunk('?',1));
  assert.throws(()=>formatOf({...format,sampleRate:1000000}));
  assert.throws(()=>formatOf({...format,channels:5}));
  assert.throws(()=>formatOf({...format,encoding:'float32'}));
});

test('optional timing reports actual first-job stages without changing buffers or replaying after clear',async()=>{
  const h=harness(),context={clientTraceId:'trace-1',conversationId:'chat'};
  h.queue.enqueue(['一。','二。'],context);await tick();
  assert.equal(h.timings[0].type,'ttsRequest');assert.equal(h.timings[0].clientTraceId,'trace-1');
  h.requests[0].event(format);await tick();assert.equal(h.timings.some(e=>e.type==='firstPcm'),false);
  h.advance(100);h.requests[0].event({type:'audio',audio:pcm()});await tick();
  const scheduled=h.timings.find(e=>e.type==='audioScheduled');
  assert.equal(scheduled.at,100);assert.equal(scheduled.scheduledContextTime,.16);assert.equal(scheduled.contextTimeAtSchedule,.1);
  assert.equal(h.timings.some(e=>e.type==='playbackObserved'),false);
  h.advance(65);assert.equal(h.timings.filter(e=>e.type==='playbackObserved').length,1);
  h.requests[0].event({type:'audio',audio:pcm()});h.requests[0].done();await tick();
  assert.equal(h.timings.filter(e=>e.type==='audioScheduled' && e.jobId===1).length,1);
  assert.equal(h.timings.filter(e=>e.type==='ttsDone' && e.jobId===1).length,1);
  assert.deepEqual(h.timings.find(e=>e.type==='ttsDone' && e.jobId===1).serverMetrics,{queueMs:2,firstAudioMs:50,completeMs:100});
  const oldCallback=h.sources[0].onended,count=h.timings.length;h.queue.clear();oldCallback?.();h.advance(2000);
  assert.equal(h.timings.length,count);
});

test('a throwing timing observer cannot stop streaming playback',async()=>{
  const h=harness({onTiming(){throw new Error('diagnostics only');}});
  h.queue.enqueue(['続けます。']);await tick();h.requests[0].event(format);h.requests[0].event({type:'audio',audio:pcm()});await tick();
  h.advance(65);assert.equal(h.statuses.at(-1).kind,'playing');h.queue.clear();
});

test('diagnostic first-source clock crossing does not wait for a UI timer that skipped the start boundary',async()=>{
  const h=harness();h.queue.enqueue(['計測します。'],{clientTraceId:'clock',conversationId:'chat'});await tick();
  h.requests[0].event(format);h.requests[0].event({type:'audio',audio:pcm()});await tick();
  assert.equal(h.sources[0].startAt,.06);
  h.advance(58);h.context.currentTime=.05595;h.advance(6);
  // At the legacy 62 ms callback the audio clock is 0.05995 s: its 0.0001
  // tolerance skips the 0.06 s boundary. The independent poll sees it at 64 ms.
  assert.equal(h.statuses.at(-1).kind,'loading');
  const observed=h.timings.filter(event=>event.type==='playbackObserved');
  assert.equal(observed.length,1);assert.equal(observed[0].at,64);
  h.requests[0].event({type:'audio',audio:pcm()});await tick();h.advance(100);
  assert.equal(h.timings.filter(event=>event.type==='playbackObserved').length,1);
  h.queue.clear();
});

test('diagnostic clock requires running context and clear cancels polls and late generations',async()=>{
  const h=harness();h.queue.enqueue(['止めます。'],{clientTraceId:'old',conversationId:'chat'});await tick();
  h.requests[0].event(format);h.requests[0].event({type:'audio',audio:pcm()});await tick();
  h.context.state='suspended';h.context.currentTime=.2;h.advance(20);
  assert.equal(h.timings.some(event=>event.type==='playbackObserved'),false);
  const pending=[...h.timers.values()].map(timer=>timer.callback),count=h.timings.length;
  h.queue.clear();assert.equal(h.timers.size,0);
  h.context.state='running';for(const callback of pending)callback();h.advance(200);
  assert.equal(h.timings.length,count);assert.equal(h.timers.size,0);
  h.queue.enqueue(['次です。'],{clientTraceId:'new',conversationId:'chat'});await tick();
  h.requests[1].event(format);h.requests[1].event({type:'audio',audio:pcm()});await tick();h.advance(65);
  assert.deepEqual(h.timings.filter(event=>event.type==='playbackObserved').map(event=>event.clientTraceId),['new']);h.queue.clear();
});

test('diagnostic clock sleeps until a distant queued start and polls suspended contexts slowly',async()=>{
  const h=harness();h.queue.nextStartTime=5;h.queue.enqueue(['後で始めます。'],{clientTraceId:'prefetched',conversationId:'chat'});await tick();
  h.requests[0].event(format);h.requests[0].event({type:'audio',audio:pcm()});await tick();
  assert.equal(h.sources[0].startAt,5);
  const initial=[...h.queue.clockTimers][0];assert.equal(h.timers.get(initial).at,5000);
  h.advance(1000);assert.deepEqual([...h.queue.clockTimers],[initial]);
  h.context.state='suspended';h.advance(4100);
  const paused=[...h.queue.clockTimers][0];assert.equal(h.timers.get(paused).at,5200);
  assert.equal(h.timings.some(event=>event.type==='playbackObserved'),false);
  h.context.state='running';h.advance(100);
  const resumed=[...h.queue.clockTimers][0];assert.ok(Math.abs(h.timers.get(resumed).at-9100)<.001);
  h.queue.clear();assert.equal(h.timers.size,0);assert.equal(h.queue.clockTimers.size,0);
});

test('first PCM is scheduled and actually enters playing before NDJSON done, with distinct timing',async()=>{
  const h=harness();h.queue.enqueue(['こんにちは。']);await tick();h.advance(850);
  h.requests[0].event(format);h.requests[0].event({type:'audio',audio:pcm()});await tick();
  assert.equal(h.sources.length,1);assert.equal(h.statuses.at(-1).kind,'loading');
  assert.equal(h.statuses.at(-1).metrics.firstAudioMs,850);assert.equal(h.statuses.at(-1).metrics.playbackStartMs,null);
  h.advance(65);
  const playing=h.statuses.find(status=>status.kind==='playing');
  assert.ok(playing);assert.ok(playing.metrics.playbackStartMs>=910);assert.equal(playing.metrics.completeMs,null);
  assert.equal(playing.metrics.transport,'pcm-stream');
  assert.equal(h.requests[0].request.signal.aborted,false);
  h.requests[0].done();await tick();h.advance(500);await tick();
  assert.equal(h.queue.busy,false);assert.equal(h.statuses.at(-1).kind,'idle');
  assert.equal(h.compressors.length,1);assert.equal(h.compressors[0].disconnected,true);
});

test('arbitrary NDJSON fragments stay buffered until a full event and chunks share one sentence graph',async()=>{
  const h=harness({clarityEnabled:true});h.queue.enqueue(['文です。']);await tick();
  const record=h.requests[0];
  for(const char of JSON.stringify(format)+'\n')record.raw(char);
  const audio=JSON.stringify({type:'audio',audio:pcm()})+'\n';
  record.raw(audio.slice(0,23));await tick();assert.equal(h.sources.length,0);
  record.raw(audio.slice(23));await tick();assert.equal(h.sources.length,1);
  record.event({type:'audio',audio:pcm()});await tick();
  assert.equal(h.sources.length,2);assert.equal(h.compressors.length,1);
  assert.equal(h.sources[0].destination,h.sources[1].destination);
  assert.equal(h.sources[1].startAt,h.sources[0].startAt+h.sources[0].buffer.duration);
  record.done();await tick();h.queue.clear();
});

test('short PCM waits for 60ms of initial data but a valid done flushes a short utterance',async()=>{
  const h=harness();h.queue.enqueue(['はい。']);await tick();h.requests[0].event(format);
  h.requests[0].event({type:'audio',audio:pcm(480)});await tick();assert.equal(h.sources.length,0);
  h.requests[0].done();await tick();assert.equal(h.sources.length,1);assert.equal(h.sources[0].buffer.duration,.01);
  h.queue.clear();
});

test('autoplay block retains PCM and resumes without another paid request',async()=>{
  const h=harness({suspended:true,denyResume:true});assert.equal(await h.queue.unlock(),false);
  h.queue.enqueue(['止めないで。']);await tick();h.requests[0].event(format);h.requests[0].event({type:'audio',audio:pcm()});h.requests[0].done();await tick();
  assert.equal(h.queue.blocked,true);assert.equal(h.sources.length,0);assert.equal(h.statuses.at(-1).kind,'blocked');
  await h.queue.resume();assert.equal(h.sources.length,1);assert.equal(h.requests.length,1);
  h.advance(65);assert.equal(h.statuses.at(-1).kind,'playing');h.queue.clear();
});

test('stop aborts the request, clears sources and invalidates late ended/timer callbacks',async()=>{
  const h=harness();h.queue.enqueue(['古い。','次。']);await tick();h.requests[0].event(format);h.requests[0].event({type:'audio',audio:pcm()});await tick();
  const ended=h.sources[0].onended,callbacks=[...h.timers.values()].map(timer=>timer.callback);
  h.queue.clear();ended();callbacks.forEach(callback=>callback());await tick();
  assert.equal(h.requests[0].request.signal.aborted,true);assert.equal(h.requests[0].cancelled,true);
  assert.equal(h.sources[0].stopped,true);assert.equal(h.queue.busy,false);assert.equal(h.requests.length,1);
  assert.equal(h.statuses.at(-1).kind,'idle');
});

test('synthesis stays ordered with one active request and bounded sentence lookahead',async()=>{
  const h=harness();h.queue.enqueue(['一。','二。','三。']);await tick();
  h.requests[0].event(format);h.requests[0].event({type:'audio',audio:pcm()});h.requests[0].done();await tick();
  assert.equal(h.requests.length,2);
  h.requests[1].event(format);h.requests[1].event({type:'audio',audio:pcm()});h.requests[1].done();await tick();
  assert.equal(h.requests.length,2,'third sentence waits until the first has played');
  assert.ok(h.sources[1].startAt>=h.sources[0].startAt+h.sources[0].buffer.duration);
  h.advance(490);await tick();assert.equal(h.requests.length,3);h.queue.clear();
});

test('truncated streams and in-band errors stop playback without retry or WAV fallback',async()=>{
  for(const inBand of [false,true]) {
    const h=harness();h.queue.enqueue(['失敗。','続き。']);await tick();h.requests[0].event(format);h.requests[0].event({type:'audio',audio:pcm()});
    if(inBand)h.requests[0].event({type:'error',error:'本句合成失败。'});
    h.requests[0].controller.close();await tick();
    assert.equal(h.queue.busy,false);assert.equal(h.requests.length,1);assert.equal(h.statuses.at(-1).kind,'error');
    assert.ok(h.sources.every(source=>source.stopped));
  }
});

test('clarity and gain instances are per utterance and shared across its complete provider blocks',async()=>{
  const processors=[],gains=[];
  const fakeClarity={PRESET:{headroomDb:2},UtteranceGain:class{constructor(){this.calls=0;gains.push(this);}observe(){this.calls++;return {gain:1};}},ClarityProcessor:class{constructor(options){this.options=options;this.calls=0;processors.push(this);}processInterleaved(samples){this.calls++;return samples;}}};
  const h=harness({clarityEnabled:true,clarityAPI:fakeClarity});h.queue.enqueue(['一。','二。']);await tick();
  h.requests[0].event(format);h.requests[0].event({type:'audio',audio:pcm()});h.requests[0].event({type:'audio',audio:pcm()});h.requests[0].done();await tick();
  h.requests[1].event(format);h.requests[1].event({type:'audio',audio:pcm()});h.requests[1].done();await tick();
  assert.deepEqual(processors.map(p=>p.calls),[2,1]);assert.deepEqual(gains.map(g=>g.calls),[2,1]);
  assert.equal(processors[0].options.guard,false);assert.equal(h.compressors.length,2);h.queue.clear();
});

test('adaptive transport is preselected from capability and stream failure never starts WAV',async()=>{
  let wavRequests=0;const streamCalls=[];
  class MockStream{constructor(options){this.options=options;this.busy=false;this.blocked=false;}enqueue(texts){streamCalls.push(texts);this.busy=true;this.options.onStatus({kind:'error',message:'No retry'});}clear(){this.busy=false;}unlock(){return Promise.resolve(true);}setClarity(){}resume(){}}
  const queue=new AdaptiveAudioQueue({streamAPI:{isSupported:()=>true,StreamAudioQueue:MockStream},waveRequestAudio:async()=>{wavRequests++;return new Blob();},createUrl:()=> 'blob:mock',revokeUrl(){},createAudio:()=>({play:async()=>{},pause(){},removeAttribute(){},load(){}})});
  queue.setStreaming(true);queue.enqueue(['流式。']);await tick();assert.deepEqual(streamCalls,[['流式。']]);assert.equal(wavRequests,0);
  queue.clear();queue.setStreaming(false);queue.enqueue(['WAV。']);await tick();assert.equal(wavRequests,1);queue.clear();
});

test('text-to-playback timing only covers the locally armed fresh reply and resets on stop',async()=>{
  let now=0,resolveAudio;const updates=[];
  const controller=new Controller({now:()=>now,requestAudio:()=>new Promise(resolve=>{resolveAudio=resolve;}),createUrl:()=> 'blob:x',revokeUrl(){},createAudio:()=>({play:async()=>{},pause(){},removeAttribute(){},load(){}}),onUpdate:status=>updates.push(status)});
  controller.refreshAvailability=async()=>{};controller.availability={configured:true,available:true};
  const old={id:'old',role:'assistant',text:'旧い。（旧。）'};
  controller.observe({id:'c',messages:[old],status:'completed'});assert.equal(controller.firstTextAt,null);
  controller.begin({id:'c',messages:[old]});now=100;
  const fresh={id:'new',role:'assistant',turnId:'t',text:'今日は'};
  controller.observe({id:'c',messages:[old,fresh],status:'running'});assert.equal(controller.firstTextAt,100);
  now=300;fresh.text='今日は晴れです。（';controller.observe({id:'c',messages:[old,fresh],status:'running'});await tick();
  now=900;resolveAudio(new Blob());await tick();
  assert.equal(updates.find(status=>status.kind==='playing').metrics.textToPlaybackMs,800);
  controller.stop();assert.equal(controller.firstTextAt,null);assert.equal(controller.textToPlaybackMs,null);
});

test('a completed input keeps its compressor connected for the delayed tail, but stop cuts it immediately',async()=>{
  const h=harness();h.queue.enqueue(['短い文。']);await tick();h.requests[0].event(format);h.requests[0].event({type:'audio',audio:pcm()});h.requests[0].done();await tick();
  h.advance(463);assert.equal(h.sources[0].ended,true);assert.notEqual(h.compressors[0].disconnected,true);
  assert.equal(h.statuses.at(-1).kind,'playing');
  h.advance(22);assert.equal(h.compressors[0].disconnected,true);assert.equal(h.queue.busy,false);
  const stop=harness();stop.queue.enqueue(['止めます。']);await tick();stop.requests[0].event(format);stop.requests[0].event({type:'audio',audio:pcm()});stop.requests[0].done();await tick();
  stop.advance(463);stop.queue.clear();assert.equal(stop.compressors[0].disconnected,true);assert.equal(stop.timers.size,0);
});

test('WAV fallback applies shared headroom in original mode and clarity processing only when selected',async()=>{
  const processing=[],blobs=[];
  class MockStream{constructor(){}setClarity(){}clear(){}unlock(){return Promise.resolve(true);}}
  const clarityAPI={
    applyWavHeadroom(bytes){processing.push('headroom');assert.deepEqual([...new Uint8Array(bytes)],[1]);return {bytes:new Uint8Array([2])};},
    processWavPcm16(bytes){processing.push('clarity');assert.deepEqual([...new Uint8Array(bytes)],[1]);return {bytes:new Uint8Array([3])};},
  };
  const queue=new AdaptiveAudioQueue({streamAPI:{isSupported:()=>false,StreamAudioQueue:MockStream},clarityAPI,waveRequestAudio:async()=>new Blob([new Uint8Array([1])]),createUrl:blob=>{blobs.push(blob);return 'blob:mock';},revokeUrl(){},createAudio:()=>({play:async()=>{},pause(){},removeAttribute(){},load(){}})});
  queue.enqueue(['原声音色。']);await tick();await tick();
  queue.clear();queue.setClarity(true);queue.enqueue(['清晰模式。']);await tick();await tick();queue.clear();
  assert.deepEqual(processing,['headroom','clarity']);
  assert.deepEqual([...new Uint8Array(await blobs[0].arrayBuffer())],[2]);
  assert.deepEqual([...new Uint8Array(await blobs[1].arrayBuffer())],[3]);
});
