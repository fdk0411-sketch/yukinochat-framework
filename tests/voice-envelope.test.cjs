const test=require('node:test');
const assert=require('node:assert/strict');
const clarity=require('../public/audio-clarity.js');
const {AudioQueue,Controller}=require('../public/voice.js');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

// Deterministic synthetic PCM, not a voice-quality evaluation. No random data.
function wave(samples,channels=1,rate=8000){
  const bytes=Buffer.alloc(44+samples.length*2);
  bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);
  bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(channels,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*channels*2,28);
  bytes.writeUInt16LE(channels*2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(samples.length*2,40);
  samples.forEach((value,index)=>bytes.writeInt16LE(value,44+index*2));return bytes;
}
function harness(options={}){
  let now=0,sequence=0;const timers=new Map(),audio=[],levels=[],statuses=[];
  const bytes=wave(Int16Array.from({length:1600},(_,index)=>index<800?(index%2?8192:-8192):0));
  const queueOptions={
    clarityAPI:clarity,requestAudio:options.requestAudio || (async()=>new Blob([bytes])),
    createUrl:()=> 'blob:envelope-test',revokeUrl(){},
    now:()=>now,setTimeout(fn,delay){const id=++sequence;timers.set(id,{fn,at:now+delay});return id;},clearTimeout(id){timers.delete(id);},
    createAudio(){const item={currentTime:0,volume:1,muted:false,paused:true,ended:false,plays:0,
      play(){this.plays++;if(options.blockFirst && this.plays===1)return Promise.reject(Object.assign(new Error('blocked'),{name:'NotAllowedError'}));this.paused=false;return Promise.resolve();},
      pause(){this.paused=true;this.onpause?.();},removeAttribute(){},load(){}};audio.push(item);return item;},
    onLevel(level){levels.push(level);options.onLevel?.(level);},onStatus(status){statuses.push(status);},
  };
  const queue=options.controller?new Controller({...queueOptions,fetch:async()=>({ok:true,json:async()=>({available:true})})}):new AudioQueue(queueOptions);
  if(options.controller){queue.refreshAvailability=async()=>{};queue.availability={available:true};}
  const advance=ms=>{const until=now+ms;for(;;){const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>until)break;now=next[1].at;timers.delete(next[0]);next[1].fn();}now=until;};
  return {queue,audio,levels,statuses,timers,advance,bytes};
}

test('WAV envelope preserves bytes and measures stereo energy without phase cancellation',()=>{
  const samples=Int16Array.from({length:640},(_,index)=>index<320?(index%2?8192:-8192):0);
  const bytes=wave(samples,2),original=Buffer.from(bytes),envelope=clarity.wavLevelEnvelope(bytes);
  assert.deepEqual(bytes,original);assert.equal(envelope.duration,.04);assert.equal(envelope.binSeconds,.02);
  assert.equal(envelope.at(0),.25);assert.equal(envelope.at(.019),.25);assert.equal(envelope.at(.02),0);
  for(const time of [-1,.04,1,NaN,Infinity])assert.equal(envelope.at(time),0);
  assert.throws(()=>clarity.wavLevelEnvelope(new Uint8Array([1,2,3])),/WAV/);
});

test('WAV levels follow the final audio currentTime and close for silence, volume zero and mute',async()=>{
  const h=harness();h.queue.enqueue(['試験。']);await tick();await tick();
  assert.equal(h.levels.at(-1),.25);const a=h.audio[0];
  a.currentTime=.12;h.advance(34);assert.equal(h.levels.at(-1),0);
  a.currentTime=.04;a.volume=.4;a.onvolumechange();assert.ok(Math.abs(h.levels.at(-1)-.1)<1e-7);
  a.muted=true;a.onvolumechange();assert.equal(h.levels.at(-1),0);
  a.muted=false;a.volume=0;a.onvolumechange();assert.equal(h.levels.at(-1),0);
  a.volume=1;a.onvolumechange();assert.equal(h.levels.at(-1),.25);
  a.pause();assert.equal(h.levels.at(-1),0);assert.equal(h.timers.size,0);
  a.paused=false;a.onplaying();assert.equal(h.levels.at(-1),.25);
  const oldTick=[...h.timers.values()][0].fn,oldPlaying=a.onplaying;
  h.queue.clear();assert.equal(h.levels.at(-1),0);const count=h.levels.length;
  oldTick();oldPlaying();h.advance(500);assert.equal(h.levels.length,count);assert.equal(h.timers.size,0);
});

test('autoplay-blocked WAV has zero level until explicit resume and closes on ended/error',async()=>{
  const h=harness({blockFirst:true});h.queue.enqueue(['待ちます。']);await tick();await tick();
  assert.equal(h.queue.blocked,true);assert.ok(h.levels.every(value=>value===0));assert.equal(h.timers.size,0);
  h.queue.resume();await tick();assert.equal(h.levels.at(-1),.25);
  h.audio[0].ended=true;h.audio[0].onended();assert.equal(h.levels.at(-1),0);assert.equal(h.timers.size,0);
  h.queue.enqueue(['次です。']);h.advance(180);await tick();await tick();
  h.queue.fail('fixture error');assert.equal(h.levels.at(-1),0);assert.equal(h.timers.size,0);
});

test('unsupported WAV and throwing animation observers do not stop audio playback',async()=>{
  for(const requestAudio of [async()=>new Blob([new Uint8Array([1,2,3])]),undefined]){
    const h=harness({requestAudio,onLevel(){throw new Error('avatar only');}});h.queue.enqueue(['続けます。']);await tick();await tick();
    assert.equal(h.statuses.at(-1).kind,'playing');assert.equal(h.audio[0].plays,1);
    if(requestAudio)assert.ok(h.levels.every(value=>value===0));
    h.queue.clear();
  }
});

test('stopping during asynchronous envelope preparation cannot resurrect old WAVs',async()=>{
  let resolveBytes;
  const h=harness({requestAudio:async()=>({arrayBuffer:()=>new Promise(resolve=>{resolveBytes=resolve;})})});
  h.queue.enqueue(['古い。']);await tick();h.queue.clear();resolveBytes(h.bytes);await tick();await tick();
  assert.equal(h.audio.length,0);assert.equal(h.queue.busy,false);assert.equal(h.levels.at(-1),0);
});

test('voice Controller gates levels on actual playing, visibility, disconnect and dispose',async()=>{
  const h=harness({controller:true});h.queue.queue.enqueue(['試験。']);await tick();await tick();
  assert.equal(h.levels.at(-1),.25);
  h.queue.setVisible(false);assert.equal(h.levels.at(-1),0);h.advance(100);assert.equal(h.levels.at(-1),0);
  h.queue.setVisible(true);h.advance(34);assert.equal(h.levels.at(-1),.25);
  h.queue.disconnect();assert.equal(h.levels.at(-1),0);assert.equal(h.timers.size,0);
  h.queue.queue.onLevel(.9);assert.equal(h.levels.at(-1),0);
  h.queue.dispose();h.queue.queue.onLevel(.9);assert.equal(h.levels.at(-1),0);
});
