(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.YukinoAudioClarity = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Reversible playback candidate, not denoising, dereverberation, or a claim
  // of improved quality. All frequencies are Hz; gains/headroom are dB.
  // Coefficients and Direct Form I follow Robert Bristow-Johnson's cookbook:
  // W3C Audio EQ Cookbook, 2021-06-08, sections "HPF" and "peakingEQ".
  // https://www.w3.org/TR/2021/NOTE-audio-eq-cookbook-20210608/
  const SOURCE = 'https://www.w3.org/TR/2021/NOTE-audio-eq-cookbook-20210608/';
  const PRESET = Object.freeze({
    name:'gentle-v1', headroomDb:2, ceilingDbFS:-1,
    filters:Object.freeze([
      Object.freeze({type:'highpass',frequency:75,q:Math.SQRT1_2}),
      Object.freeze({type:'peaking',frequency:300,q:0.75,gainDb:-2}),
      Object.freeze({type:'peaking',frequency:2700,q:0.8,gainDb:1.2}),
    ]),
  });
  function requireFormat(sampleRate, channels) {
    if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new RangeError('sampleRate must be 8000..192000 Hz.');
    if (!Number.isInteger(channels) || channels < 1 || channels > 8) throw new RangeError('channels must be 1..8.');
  }
  function designBiquad(sampleRate, specification) {
    requireFormat(sampleRate,1);
    const {type,frequency,q,gainDb=0}=specification || {};
    if (!['highpass','peaking'].includes(type) || !Number.isFinite(frequency) || frequency <= 0 || frequency >= sampleRate/2 ||
      !Number.isFinite(q) || q <= 0 || !Number.isFinite(gainDb) || Math.abs(gainDb)>24) throw new RangeError('Invalid biquad specification.');
    const omega=2*Math.PI*frequency/sampleRate, cosine=Math.cos(omega), alpha=Math.sin(omega)/(2*q);
    let b0,b1,b2,a0,a1,a2;
    if (type==='highpass') {
      b0=(1+cosine)/2; b1=-(1+cosine); b2=b0;
      a0=1+alpha; a1=-2*cosine; a2=1-alpha;
    } else {
      const amplitude=10**(gainDb/40);
      b0=1+alpha*amplitude; b1=-2*cosine; b2=1-alpha*amplitude;
      a0=1+alpha/amplitude; a1=-2*cosine; a2=1-alpha/amplitude;
    }
    return Object.freeze({b0:b0/a0,b1:b1/a0,b2:b2/a0,a1:a1/a0,a2:a2/a0});
  }
  class Biquad {
    constructor(coefficients) { this.coefficients=coefficients; this.reset(); }
    reset() { this.x1=0;this.x2=0;this.y1=0;this.y2=0; }
    sample(input) {
      const c=this.coefficients;
      const output=c.b0*input+c.b1*this.x1+c.b2*this.x2-c.a1*this.y1-c.a2*this.y2;
      this.x2=this.x1;this.x1=input;this.y2=this.y1;this.y1=output;
      return output;
    }
  }
  class ClarityProcessor {
    constructor({sampleRate,channels=1,guard=true}={}) {
      requireFormat(sampleRate,channels);
      if (typeof guard!=='boolean') throw new TypeError('guard must be a boolean.');
      this.sampleRate=sampleRate;this.channels=channels;
      // A caller with a shared downstream compressor may disable the emergency
      // guard to avoid hard clipping before that compressor. Never disable it
      // merely to encode unbounded output back into integer PCM.
      this.guard=guard;
      this.gain=10**(-PRESET.headroomDb/20);this.ceiling=10**(PRESET.ceilingDbFS/20);
      const coefficients=PRESET.filters.map(filter=>designBiquad(sampleRate,filter));
      this.filters=Array.from({length:channels},()=>coefficients.map(c=>new Biquad(c)));
      this.reset();
    }
    reset() {
      for (const channel of this.filters) for (const filter of channel) filter.reset();
      this.stats={frames:0,guardedSamples:0,peakBeforeGuard:0};
    }
    // Input/output: interleaved normalized floating PCM; frame count, channel
    // order, and sample rate are unchanged. Keep one instance across chunks.
    // Invalid chunks are rejected before state advances. Input is never edited.
    processInterleaved(input) {
      if (!(input instanceof Float32Array || input instanceof Float64Array) || input.length%this.channels) throw new TypeError('Expected complete interleaved Float32/Float64 PCM frames.');
      for (const sample of input) if (!Number.isFinite(sample) || Math.abs(sample)>16) throw new RangeError('PCM must be finite and within the defensive +/-16 range.');
      const output=new Float32Array(input.length);
      for (let index=0;index<input.length;index++) {
        let sample=input[index];
        for (const filter of this.filters[index%this.channels]) sample=filter.sample(sample);
        sample*=this.gain;
        this.stats.peakBeforeGuard=Math.max(this.stats.peakBeforeGuard,Math.abs(sample));
        // This is a sample-peak emergency guard, NOT a true-peak limiter.
        // Normal candidate audio should report zero guarded samples. If it
        // activates, report it rather than claiming artifact-free processing.
        if (this.guard&&Math.abs(sample)>this.ceiling) { this.stats.guardedSamples++;sample=Math.sign(sample)*this.ceiling; }
        output[index]=sample;
      }
      this.stats.frames+=input.length/this.channels;
      return output;
    }
    getStats() { return {...this.stats}; }
  }
  class UtteranceGain {
    constructor({sampleRate,channels=1,targetPeakDbFS=-6,maxGainDb=18}={}) {
      requireFormat(sampleRate,channels);
      if (!Number.isFinite(targetPeakDbFS)||targetPeakDbFS < -18||targetPeakDbFS > -3||
        !Number.isFinite(maxGainDb)||maxGainDb<0||maxGainDb>24) throw new RangeError('Invalid utterance gain limits.');
      this.sampleRate=sampleRate;this.channels=channels;
      this.targetPeak=10**(targetPeakDbFS/20);this.maximumGain=10**(maxGainDb/20);
      this.reset();
    }
    reset() { this.gain=1;this.locked=false;this.peak=0;this.rms=0;this.inspectedChunks=0; }
    getState() { return {gain:this.gain,gainDb:20*Math.log10(this.gain),locked:this.locked,peak:this.peak,rms:this.rms,inspectedChunks:this.inspectedChunks}; }
    observe(input) {
      // Call once for each complete provider PCM event, never arbitrary fetch
      // fragments. The first audible event sets ONE gain for this utterance.
      // Leading silence passes at unity without delaying playback or deciding
      // on a large gain from tiny noise. This is a level gate, not speech VAD.
      if (!(input instanceof Float32Array||input instanceof Float64Array)||input.length%this.channels) throw new TypeError('Expected complete floating PCM frames.');
      for (const sample of input) if (!Number.isFinite(sample)||Math.abs(sample)>16) throw new RangeError('PCM must be finite and bounded.');
      if (this.locked||!input.length) return this.getState();
      let squared=0,peak=0;
      for (const sample of input) {squared+=sample*sample;peak=Math.max(peak,Math.abs(sample));}
      this.peak=peak;this.rms=Math.sqrt(squared/input.length);this.inspectedChunks++;
      if (this.peak>=10**(-45/20)&&this.rms>=10**(-58/20)) {
        this.gain=Math.min(this.maximumGain,this.targetPeak/this.peak);
        this.locked=true;
      }
      return this.getState();
    }
  }
  function wavLayout(input) {
    const bytes=input instanceof ArrayBuffer?new Uint8Array(input):input;
    if (!(bytes instanceof Uint8Array) || bytes.length<44 || bytes.length>16*1024*1024) throw new TypeError('Expected a bounded WAV byte array.');
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    const tag=offset=>String.fromCharCode(...bytes.subarray(offset,offset+4));
    if (tag(0)!=='RIFF'||tag(8)!=='WAVE'||view.getUint32(4,true)+8!==bytes.length) throw new Error('Invalid RIFF/WAVE container.');
    let format=null,data=null,offset=12;
    while (offset+8<=bytes.length) {
      const id=tag(offset),length=view.getUint32(offset+4,true),start=offset+8;
      if (start+length>bytes.length) throw new Error('Truncated WAV chunk.');
      if (id==='fmt ') {
        if (format||length<16) throw new Error('Ambiguous WAV format.');
        format={encoding:view.getUint16(start,true),channels:view.getUint16(start+2,true),sampleRate:view.getUint32(start+4,true),
          byteRate:view.getUint32(start+8,true),blockAlign:view.getUint16(start+12,true),bits:view.getUint16(start+14,true)};
      }
      if (id==='data') { if (data) throw new Error('Multiple WAV data chunks are not supported.');data={start,length}; }
      offset=start+length+(length%2);
    }
    if (offset!==bytes.length||!format||!data||!data.length||format.encoding!==1||format.bits!==16||
      format.blockAlign!==format.channels*2||format.byteRate!==format.sampleRate*format.blockAlign||data.length%format.blockAlign) throw new Error('Expected unambiguous PCM16 WAV.');
    requireFormat(format.sampleRate,format.channels);
    return {bytes,view,...format,dataStart:data.start,dataLength:data.length,frames:data.length/format.blockAlign};
  }
  function processWavPcm16(input) {
    // Convenience for one independent WAV. Streaming callers must instead
    // retain ClarityProcessor and feed all PCM chunks to that one instance.
    const layout=wavLayout(input);
    const pcm=new Float32Array(layout.dataLength/2);
    for (let index=0;index<pcm.length;index++) pcm[index]=layout.view.getInt16(layout.dataStart+index*2,true)/32768;
    const processor=new ClarityProcessor(layout);
    const processed=processor.processInterleaved(pcm);
    const bytes=new Uint8Array(layout.bytes);
    const view=new DataView(bytes.buffer);
    for (let index=0;index<processed.length;index++) view.setInt16(layout.dataStart+index*2,Math.max(-32768,Math.min(32767,Math.round(processed[index]*32768))),true);
    return {bytes,sampleRate:layout.sampleRate,channels:layout.channels,frames:layout.frames,stats:processor.getStats(),preset:PRESET.name};
  }
  function applyWavHeadroom(input) {
    // The bypass path shares the candidate's fixed output headroom. This
    // avoids making an EQ toggle also add/remove a separate 2 dB gain stage.
    const layout=wavLayout(input),bytes=new Uint8Array(layout.bytes),view=new DataView(bytes.buffer);
    const gain=10**(-PRESET.headroomDb/20);
    let peak=0;
    for(let offset=layout.dataStart;offset<layout.dataStart+layout.dataLength;offset+=2){
      const scaled=layout.view.getInt16(offset,true)*gain;
      peak=Math.max(peak,Math.abs(scaled)/32768);view.setInt16(offset,Math.round(scaled),true);
    }
    return {bytes,sampleRate:layout.sampleRate,channels:layout.channels,frames:layout.frames,
      stats:{frames:layout.frames,guardedSamples:0,peakBeforeGuard:peak},preset:'headroom-only'};
  }
  function wavLevelEnvelope(input) {
    // Presentation-only short-time RMS: sqrt(mean(x^2)) over 20 ms of the
    // final, normalized PCM actually sent to HTMLAudio. Sample amplitudes are
    // unitless full-scale fractions, times are seconds. No text/phoneme guess
    // and no audio processing: the input WAV remains byte-for-byte unchanged.
    const layout=wavLayout(input),framesPerBin=Math.max(1,Math.round(layout.sampleRate*.02));
    const levels=new Float32Array(Math.ceil(layout.frames/framesPerBin));
    for(let bin=0;bin<levels.length;bin++) {
      const start=bin*framesPerBin,end=Math.min(layout.frames,start+framesPerBin);
      let sum=0;
      for(let frame=start;frame<end;frame++)for(let channel=0;channel<layout.channels;channel++) {
        const value=layout.view.getInt16(layout.dataStart+(frame*layout.channels+channel)*2,true)/32768;
        sum+=value*value;
      }
      levels[bin]=Math.sqrt(sum/((end-start)*layout.channels));
    }
    // Retain only the small envelope, not a second full copy of the WAV.
    const duration=layout.frames/layout.sampleRate,binSeconds=framesPerBin/layout.sampleRate;
    return {duration,binSeconds,levels,at(time) {
      if(!Number.isFinite(time)||time<0||time>=duration)return 0;
      return levels[Math.floor(time/binSeconds)] || 0;
    }};
  }
  return {SOURCE,PRESET,designBiquad,Biquad,ClarityProcessor,UtteranceGain,wavLayout,processWavPcm16,applyWavHeadroom,wavLevelEnvelope};
});
