const test=require('node:test');
const assert=require('node:assert/strict');
const {PRESET,designBiquad,Biquad,ClarityProcessor,UtteranceGain,wavLayout,processWavPcm16,applyWavHeadroom}=require('../public/audio-clarity.js');

// Deterministic analytic test signals; no random source or seed is involved.
function tone(frequency,{rate=48000,seconds=1,amplitude=0.1,channels=1}={}) {
  return Float32Array.from({length:Math.round(rate*seconds)*channels},(_,index)=>amplitude*Math.sin(2*Math.PI*frequency*Math.floor(index/channels)/rate));
}
function rms(data,start=0) { let sum=0;for(let index=start;index<data.length;index++)sum+=data[index]**2;return Math.sqrt(sum/(data.length-start)); }
function measuredFilterDb(specification,frequency) {
  const input=tone(frequency),filter=new Biquad(designBiquad(48000,specification));
  const output=Float64Array.from(input,sample=>filter.sample(sample));
  return 20*Math.log10(rms(output,24000)/rms(input,24000));
}
function wav(samples,channels=1,rate=48000) {
  const bytes=Buffer.alloc(44+samples.length*2);
  bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);
  bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(channels,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*channels*2,28);
  bytes.writeUInt16LE(channels*2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(samples.length*2,40);
  samples.forEach((sample,index)=>bytes.writeInt16LE(sample,44+index*2));return bytes;
}
test('known biquad gains: highpass corner and peaking centers',()=>{
  assert.ok(Math.abs(measuredFilterDb(PRESET.filters[0],75)+3.0103)<0.005);
  assert.ok(measuredFilterDb(PRESET.filters[0],10)<-34);
  assert.ok(Math.abs(measuredFilterDb(PRESET.filters[1],300)+2)<0.005);
  assert.ok(Math.abs(measuredFilterDb(PRESET.filters[2],2700)-1.2)<0.005);
});
test('streamed chunk boundaries are sample-identical to whole-buffer processing',()=>{
  const input=Float32Array.from({length:12000},(_,index)=>0.2*Math.sin(index*.037)+0.07*Math.sin(index*.413));
  const original=input.slice();
  const expected=new ClarityProcessor({sampleRate:48000,channels:2}).processInterleaved(input);
  const stream=new ClarityProcessor({sampleRate:48000,channels:2}),actual=new Float32Array(input.length);
  const boundaries=[0,2,16,514,4096,8190,12000];
  for(let index=0;index<boundaries.length-1;index++)actual.set(stream.processInterleaved(input.subarray(boundaries[index],boundaries[index+1])),boundaries[index]);
  assert.deepEqual(actual,expected);assert.deepEqual(input,original);assert.equal(stream.getStats().frames,6000);
});
test('channels keep independent histories and do not leak into a silent channel',()=>{
  const input=new Float32Array(9600);input[0]=0.8;
  const output=new ClarityProcessor({sampleRate:48000,channels:2}).processInterleaved(input);
  assert.ok(output.some((sample,index)=>index%2===0&&Math.abs(sample)>0));
  assert.ok(output.every((sample,index)=>index%2===0||sample===0));
});
test('DC is rejected after settling, samples and duration are preserved',()=>{
  const processor=new ClarityProcessor({sampleRate:48000,channels:1});
  const output=processor.processInterleaved(new Float32Array(96000).fill(0.1));
  assert.equal(output.length,96000);assert.ok(rms(output,48000)<1e-10);
});
test('reset clears filter histories and statistics for a new independent stream',()=>{
  const processor=new ClarityProcessor({sampleRate:48000});const input=tone(300,{seconds:.1});
  const first=processor.processInterleaved(input);processor.processInterleaved(input);processor.reset();
  assert.equal(processor.getStats().frames,0);assert.deepEqual(processor.processInterleaved(input),first);
});
test('emergency guard bounds output and reports activation',()=>{
  const processor=new ClarityProcessor({sampleRate:48000});const output=processor.processInterleaved(tone(2700,{amplitude:8}));
  assert.ok(processor.getStats().guardedSamples>0);
  assert.ok(output.every(sample=>Number.isFinite(sample)&&Math.abs(sample)<=10**(-1/20)+1e-7));
});
test('downstream-compressor mode disables only the emergency sample guard',()=>{
  const processor=new ClarityProcessor({sampleRate:48000,guard:false});
  const output=processor.processInterleaved(tone(2700,{amplitude:2}));
  assert.equal(processor.getStats().guardedSamples,0);
  assert.ok(output.some(sample=>Math.abs(sample)>1));
  assert.ok(output.every(Number.isFinite));
});
test('utterance gain waits through initial silence without amplifying it',()=>{
  const gain=new UtteranceGain({sampleRate:48000});
  assert.equal(gain.observe(new Float32Array(19200)).locked,false);
  assert.equal(gain.observe(new Float32Array(19200).fill(0.00001)).gain,1);
  const audible=gain.observe(tone(300,{seconds:.4,amplitude:.1}));
  assert.equal(audible.locked,true);assert.ok(Math.abs(audible.gainDb-14)<0.001);
});
test('utterance gain stays fixed across later loud/quiet chunks and caps at +18 dB',()=>{
  const gain=new UtteranceGain({sampleRate:48000});
  const first=gain.observe(tone(300,{seconds:.4,amplitude:.01}));
  assert.ok(Math.abs(first.gainDb-18)<1e-10);
  assert.deepEqual(gain.observe(tone(300,{seconds:.4,amplitude:.9})),first);
  assert.deepEqual(gain.observe(new Float32Array(19200)),first);
  gain.reset();assert.equal(gain.getState().gain,1);assert.equal(gain.getState().locked,false);
});
test('utterance gain rejects invalid frames without accepting them as a reference',()=>{
  const gain=new UtteranceGain({sampleRate:48000,channels:2});
  assert.throws(()=>gain.observe(new Float32Array([1,NaN])),/finite/);
  assert.throws(()=>gain.observe(new Float32Array([1])),/frames/);
  assert.equal(gain.getState().inspectedChunks,0);
});
test('invalid chunks fail before contaminating continuous state',()=>{
  const tested=new ClarityProcessor({sampleRate:48000,channels:2});
  assert.throws(()=>tested.processInterleaved(new Float32Array([0,NaN])),/finite/);
  assert.throws(()=>tested.processInterleaved(new Float32Array([0])),/frames/);
  assert.throws(()=>tested.processInterleaved(new Int16Array([0,0])),/Float32/);
  assert.equal(tested.getStats().frames,0);
  const input=tone(300,{seconds:.1,channels:2});
  assert.deepEqual(tested.processInterleaved(input),new ClarityProcessor({sampleRate:48000,channels:2}).processInterleaved(input));
});
test('WAV processing preserves source, headers, sample rate, channels and frame count',()=>{
  const source=wav(Int16Array.from(tone(300,{seconds:.1,channels:2}),sample=>Math.round(sample*32768)),2);
  const original=Buffer.from(source),result=processWavPcm16(source),layout=wavLayout(result.bytes);
  assert.deepEqual(source,original);assert.deepEqual(Buffer.from(result.bytes.subarray(0,44)),source.subarray(0,44));
  assert.equal(result.bytes.length,source.length);assert.equal(result.sampleRate,48000);assert.equal(result.channels,2);
  assert.equal(layout.frames,4800);assert.equal(result.stats.guardedSamples,0);
  assert.notDeepEqual(Buffer.from(result.bytes.subarray(44)),source.subarray(44));
});
test('WAV bypass uses the same fixed headroom without EQ, mutation or metadata changes',()=>{
  const source=wav(Int16Array.from([10000,-10000,32767,-32768,0,42]),2,32000),original=Buffer.from(source);
  const result=applyWavHeadroom(source),output=Buffer.from(result.bytes),gain=10**(-PRESET.headroomDb/20);
  assert.deepEqual(source,original);assert.deepEqual(output.subarray(0,44),source.subarray(0,44));
  assert.equal(result.sampleRate,32000);assert.equal(result.channels,2);assert.equal(result.frames,3);
  assert.equal(result.stats.guardedSamples,0);
  for(let offset=44;offset<source.length;offset+=2)assert.ok(Math.abs(output.readInt16LE(offset)-source.readInt16LE(offset)*gain)<=.5);
});
test('invalid format and out-of-range filter designs fail explicitly',()=>{
  const source=wav(new Int16Array(100));source.writeUInt16LE(3,20);
  assert.throws(()=>processWavPcm16(source),/PCM16/);
  assert.throws(()=>new ClarityProcessor({sampleRate:1000}),/sampleRate/);
  assert.throws(()=>designBiquad(8000,{type:'peaking',frequency:5000,q:1,gainDb:1}),/Invalid/);
});
