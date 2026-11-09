(function(root,factory) {
  const api=factory();
  if(typeof module==='object' && module.exports) module.exports=api;
  else root.YukinoStreamAudio=api;
})(typeof globalThis!=='undefined'?globalThis:this,function() {
  'use strict';
  const MAX_LINE=4*1024*1024, MAX_AUDIO=32*1024*1024;
  const SENTENCE_PAUSE_SECONDS=.18, SENTENCE_END=/[。！？!?][」』”’"']*$/u;
  const isSupported=()=>typeof (globalThis.AudioContext || globalThis.webkitAudioContext)==='function';
  function formatOf(value) {
    if(value?.encoding!=='pcm_s16le' || value.bitsPerSample!==16 || !Number.isInteger(value.sampleRate) || value.sampleRate<8000 || value.sampleRate>96000 || ![1,2].includes(value.channels)) throw new Error('收到不支持的流式声音格式。');
    return {sampleRate:value.sampleRate,channels:value.channels,bitsPerSample:16,encoding:'pcm_s16le'};
  }
  function pcmChunk(encoded,channels,carry=new Uint8Array()) {
    if(typeof encoded!=='string' || !encoded.length || encoded.length%4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('流式声音数据无效。');
    let raw;
    try {raw=globalThis.atob(encoded);} catch {throw new Error('流式声音数据无效。');}
    const bytes=new Uint8Array(carry.length+raw.length); bytes.set(carry);
    for(let i=0;i<raw.length;i++)bytes[carry.length+i]=raw.charCodeAt(i);
    const length=bytes.length-bytes.length%(channels*2), view=new DataView(bytes.buffer,0,length);
    const samples=new Float32Array(length/2);
    for(let i=0;i<samples.length;i++)samples[i]=view.getInt16(i*2,true)/32768;
    return {samples,carry:bytes.slice(length),bytes:raw.length};
  }
  function joinSamples(blocks) {
    if(blocks.length===1)return blocks[0];
    const result=new Float32Array(blocks.reduce((sum,block)=>sum+block.length,0));
    let offset=0;for(const block of blocks){result.set(block,offset);offset+=block.length;}
    return result;
  }

  class StreamAudioQueue {
    constructor(options={}) {
      this.fetch=options.fetch || ((...args)=>globalThis.fetch(...args));
      this.makeContext=options.contextFactory || (()=>new (globalThis.AudioContext || globalThis.webkitAudioContext)());
      this.now=options.now || (()=>globalThis.performance.now());
      this.schedule=options.setTimeout || ((callback,delay)=>globalThis.setTimeout(callback,delay));
      this.cancel=options.clearTimeout || (handle=>globalThis.clearTimeout(handle));
      this.clarityAPI=options.clarityAPI || globalThis.YukinoAudioClarity;
      this.clarityEnabled=!!options.clarityEnabled;
      this.onStatus=options.onStatus || (()=>{});
      this.onLevel=typeof options.onLevel==='function'?options.onLevel:null;
      this.levelTimer=null;this.levelEpoch=0;
      this.onTiming=options.onTiming || (()=>{});this.timingEnabled=typeof options.onTiming==='function';this.jobSequence=0;
      this.context=null; this.contextPromise=null; this.generation=0;
      this.jobs=[];this.sources=new Set();this.loading=null;this.blocked=false;
      this.nextStartTime=0;this.playbackTimer=null;this.lastMetrics=null;this.clockTimers=new Set();
      this.lastScheduledJobId=null;this.lastScheduledSentenceEnded=false;
    }
    get busy(){return !!(this.jobs.length || this.loading || this.sources.size);}
    emitLevel(level){try{this.onLevel?.(Number.isFinite(level)?Math.min(1,Math.max(0,level)):0);}catch{/* Avatar observers cannot interrupt sound. */}}
    stopLevelMeter(){this.levelEpoch++;if(this.levelTimer!==null)this.cancel(this.levelTimer);this.levelTimer=null;this.emitLevel(0);}
    sampleLevel(){
      const context=this.context,time=context?.currentTime || 0;
      if(!context || context.state!=='running' || this.blocked){this.emitLevel(0);return false;}
      const audibleJobs=new Set([...this.sources].filter(entry=>entry.start<=time && entry.end+.02>time).map(entry=>entry.job));
      for(const job of this.jobs)if(job.tailTimer!==undefined && job.outputEnd>time)audibleJobs.add(job);
      let level=0;
      for(const job of audibleJobs){
        const meters=job.channelMeters || (job.analyser?[{analyser:job.analyser,samples:job.levelSamples}]:[]);
        if(!meters.length)continue;
        try {
          // Read the existing sentence's post-compressor graph; no new audio
          // source, gain, or text-to-mouth heuristic. W3C Web Audio API,
          // AnalyserNode.getFloatTimeDomainData: normalized waveform samples.
          // https://www.w3.org/TR/webaudio/#dom-analysernode-getfloattimedomaindata
          // AnalyserNode downmixes its input to mono. For stereo, analyse
          // separate channels before combining energy, so L=-R cannot cancel.
          // https://www.w3.org/TR/webaudio/#time-domain-down-mixing
          let sum=0,count=0;
          for(const meter of meters){
            meter.analyser.getFloatTimeDomainData(meter.samples);
            for(const value of meter.samples)sum+=value*value;
            count+=meter.samples.length;
          }
          const rms=Math.sqrt(sum/count);
          if(Number.isFinite(rms))level=Math.max(level,rms);
        }catch{/* A failed meter leaves speech playing and the mouth closed. */}
      }
      this.emitLevel(level);return audibleJobs.size>0;
    }
    releaseLevelNodes(job){
      try{job.channelSplitter?.disconnect();}catch{}
      for(const meter of job.channelMeters || [])try{meter.analyser.disconnect();}catch{}
      try{job.analyser?.disconnect();}catch{}
      job.channelSplitter=null;job.channelMeters=null;job.analyser=null;job.levelSamples=null;
    }
    startLevelMeter(){
      if(!this.onLevel || this.levelTimer!==null)return;
      const generation=this.generation,epoch=this.levelEpoch;
      const tick=()=>{
        if(generation!==this.generation || epoch!==this.levelEpoch)return;
        this.levelTimer=null;
        if(this.sampleLevel())this.levelTimer=this.schedule(tick,1000/30);
      };
      tick();
    }
    contextForPlayback() {
      if(!this.context || this.context.state==='closed') {
        this.context=this.makeContext();
        this.context.addEventListener?.('statechange',()=>{this.flush();this.refreshPlayback();});
      }
      return this.context;
    }
    // Call synchronously from the user's send/replay/preview gesture. A blocked
    // context retains received PCM; only an explicit resume retries playback.
    unlock() {
      let context;
      try {context=this.contextForPlayback();}
      catch {if(this.busy)this.fail('当前浏览器无法播放流式声音。');return Promise.resolve(false);}
      let resumed;
      try {resumed=context.state==='running'?Promise.resolve():context.resume();}
      catch(error){resumed=Promise.reject(error);}
      return Promise.resolve(resumed).then(()=>{
        this.blocked=context.state!=='running';this.flush();this.refreshPlayback();return !this.blocked;
      }).catch(()=>{this.blocked=true;if(this.busy)this.refreshPlayback();return false;});
    }
    resume(){return this.unlock();}
    setClarity(enabled){this.clarityEnabled=!!enabled;}
    timing(job,type,extra={}) {try{this.onTiming({...job.timingContext,type,jobId:job.id,transport:'pcm-stream',at:this.now(),...extra});}catch{/* Diagnostics never interrupt playback. */}}
    observeFirstSourceClock(job,context,start) {
      if(!this.timingEnabled)return;
      const generation=this.generation;
      const later=delay=>{job.clockTimer=this.schedule(check,delay);this.clockTimers.add(job.clockTimer);};
      const check=()=>{
        if(job.clockTimer!=null)this.clockTimers.delete(job.clockTimer);
        job.clockTimer=null;
        if(generation!==this.generation || job.generation!==generation || job.clockObserved || context.state==='closed')return;
        if(context.state==='running' && context.currentTime>=start){job.clockObserved=true;this.timing(job,'playbackObserved');return;}
        // Sleep through queued audio and suspended contexts. Only the immediate
        // start boundary needs 4 ms retries; this never changes audio scheduling.
        later(context.state==='running'?Math.max(4,(start-context.currentTime)*1000):100);
      };
      // Independent of the UI's boundary tolerance. This observes the browser
      // audio clock, not physical speaker output, and does not poll during a
      // seconds-long wait for a prefetched sentence's scheduled start.
      if(context.state==='running' && context.currentTime>=start)check();
      else later(context.state==='running'?Math.max(0,(start-context.currentTime)*1000):100);
    }
    enqueue(texts,timingContext=null) {
      for(const text of texts)if(String(text).trim())this.jobs.push({text:String(text),id:++this.jobSequence,timingContext:timingContext?{...timingContext}:null,status:'queued',remoteDone:false,blocks:[],carry:new Uint8Array(),bytes:0,receivedSamples:0,sources:new Set(),clarityEnabled:this.clarityEnabled});
      this.pump();
    }
    clear(emit=true) {
      this.generation++;
      this.stopLevelMeter();
      if(this.playbackTimer!==null)this.cancel(this.playbackTimer);this.playbackTimer=null;
      for(const timer of this.clockTimers)this.cancel(timer);this.clockTimers.clear();
      for(const job of this.jobs){job.controller?.abort();void job.reader?.cancel().catch(()=>{});if(job.tailTimer!==undefined)this.cancel(job.tailTimer);if(job.clockTimer!=null)this.cancel(job.clockTimer);job.clockTimer=null;try{job.compressor?.disconnect();}catch{}this.releaseLevelNodes(job);}
      for(const entry of this.sources){entry.node.onended=null;try{entry.node.stop();}catch{}try{entry.node.disconnect();}catch{}}
      this.jobs=[];this.sources.clear();this.loading=null;this.blocked=false;
      this.nextStartTime=this.context?.currentTime || 0;
      this.lastScheduledJobId=null;this.lastScheduledSentenceEnded=false;
      if(emit)this.onStatus({kind:'idle',metrics:this.lastMetrics});
    }
    fail(message) {const metrics=this.lastMetrics;this.clear(false);this.onStatus({kind:'error',message,metrics});}
    pump() {
      if(this.loading)return;
      // Keep one in-flight synthesis and at most one sentence ahead of the
      // currently scheduled sentence. Do not parallelize paid cloud requests.
      if(this.jobs.filter(job=>job.status!=='queued').length>=2)return;
      const job=this.jobs.find(item=>item.status==='queued');
      if(!job){this.refreshPlayback();return;}
      job.status='reading';job.controller=new AbortController();job.generation=this.generation;
      job.requestAt=this.now();job.metrics={transport:'pcm-stream',firstAudioMs:null,playbackStartMs:null,completeMs:null};
      this.loading=job;this.lastMetrics=job.metrics;this.refreshPlayback();
      this.readJob(job).catch(error=>{if(job.generation===this.generation&&!job.controller.signal.aborted)this.fail(error.message || '流式声音播放失败，请稍后重听。');}).finally(()=>{
        if(job.generation!==this.generation)return;
        if(this.loading===job)this.loading=null;
        this.finish(job);this.pump();
      });
    }
    async readJob(job) {
      this.timing(job,'ttsRequest');
      const response=await this.fetch('/api/tts-stream',{method:'POST',credentials:'same-origin',signal:job.controller.signal,headers:{'Content-Type':'application/json','X-Yukino-Client':'1'},body:JSON.stringify({text:job.text})});
      if(job.generation!==this.generation)return;
      if(!response.ok){const body=await response.json().catch(()=>({}));throw new Error(typeof body.error==='string'?body.error:'本句流式声音生成失败。');}
      if(!/^application\/x-ndjson\b/i.test(response.headers.get('content-type') || '') || !response.body?.getReader)throw new Error('没有收到可播放的流式声音。');
      const reader=job.reader=response.body.getReader(),decoder=new TextDecoder();let pending='',done=false;
      const line=value=>{
        if(job.generation!==this.generation)return;
        if(!value.trim())return;
        if(done)throw new Error('流式声音结束后仍收到额外数据。');
        let event;try{event=JSON.parse(value);}catch{throw new Error('流式声音数据不完整。');}
        if(event.type==='format') {
          if(job.format || job.receivedSamples)throw new Error('流式声音格式重复或发生变化。');
          job.format=formatOf(event);
          if(this.clarityAPI?.UtteranceGain)job.gain=new this.clarityAPI.UtteranceGain(job.format);
          if(job.clarityEnabled && this.clarityAPI?.ClarityProcessor)job.processor=new this.clarityAPI.ClarityProcessor({...job.format,guard:false});
        } else if(event.type==='audio') {
          if(!job.format)throw new Error('流式声音缺少格式信息。');
          const decoded=pcmChunk(event.audio,job.format.channels,job.carry);job.carry=decoded.carry;job.bytes+=decoded.bytes;
          if(job.bytes>MAX_AUDIO)throw new Error('本句流式声音过大，请分段朗读。');
          if(decoded.samples.length) {
            if(job.metrics.firstAudioMs===null){job.metrics.firstAudioMs=this.now()-job.requestAt;this.timing(job,'firstPcm');}
            const gain=job.gain?.observe(decoded.samples)?.gain || 1;
            const scaled=new Float32Array(decoded.samples.length);for(let i=0;i<scaled.length;i++)scaled[i]=decoded.samples[i]*gain;
            const samples=job.processor?job.processor.processInterleaved(scaled):scaled;
            if(!job.processor){const headroom=10**(-(this.clarityAPI?.PRESET?.headroomDb || 2)/20);for(let i=0;i<samples.length;i++)samples[i]*=headroom;}
            job.receivedSamples+=samples.length;job.blocks.push(samples);this.flush();this.refreshPlayback();
          }
        } else if(event.type==='done') {
          if(!job.format || !job.receivedSamples || job.carry.length)throw new Error('流式声音没有完整的音频数据。');
          done=true;job.remoteDone=true;job.status='received';job.metrics.completeMs=this.now()-job.requestAt;
          const server={};for(const key of ['queueMs','firstAudioMs','completeMs'])if(Number.isFinite(event.metrics?.[key])&&event.metrics[key]>=0)server[key]=event.metrics[key];
          this.timing(job,'ttsDone',{serverMetrics:{...server}});
          job.metrics.server=server;this.flush();this.refreshPlayback();
        } else if(event.type==='error')throw new Error(typeof event.error==='string'?event.error:'本句流式声音生成失败。');
        else throw new Error('流式声音事件无法识别。');
      };
      try {
        for(;;){const result=await reader.read();if(job.generation!==this.generation)return;if(result.done)break;pending+=decoder.decode(result.value,{stream:true});if(pending.length>MAX_LINE)throw new Error('流式声音数据行过长。');let at;while((at=pending.indexOf('\n'))>=0){line(pending.slice(0,at));pending=pending.slice(at+1);}}
        pending+=decoder.decode();if(pending.trim())line(pending);
        if(!done)throw new Error('流式声音意外中断，可稍后重听。');
      } finally {try{await reader.cancel();}catch{}try{reader.releaseLock();}catch{}}
    }
    flush() {
      if(!this.jobs.some(job=>job.blocks.length))return;
      let context;try{context=this.contextForPlayback();}catch{this.fail('当前浏览器无法播放流式声音。');return;}
      if(context.state!=='running'){this.blocked=true;return;}
      this.blocked=false;
      for(const job of this.jobs) {
        if(!job.format || !job.blocks.length)continue;
        const count=job.blocks.reduce((sum,block)=>sum+block.length,0);
        if(!job.remoteDone && count/job.format.channels/job.format.sampleRate<.06)break;
        const samples=joinSamples(job.blocks);job.blocks=[];
        const frames=samples.length/job.format.channels;
        const buffer=context.createBuffer(job.format.channels,frames,job.format.sampleRate);
        for(let channel=0;channel<job.format.channels;channel++){
          const data=buffer.getChannelData(channel);for(let frame=0;frame<frames;frame++)data[frame]=samples[frame*job.format.channels+channel];
        }
        // A sentence shares one downstream compressor across all provider
        // chunks, so its gain envelope never resets at network boundaries.
        if(!job.compressor) {
          job.compressor=context.createDynamicsCompressor();
          for(const [key,value] of Object.entries({threshold:-4,knee:4,ratio:12,attack:.003,release:.08}))job.compressor[key].value=value;
          if(this.onLevel && typeof context.createAnalyser==='function') {
            try {
              if(job.format.channels===2){
                // The meter is a parallel, output-unconnected observation
                // branch. The original stereo signal goes to destination.
                job.channelSplitter=context.createChannelSplitter(2);job.channelMeters=[];
                for(let channel=0;channel<2;channel++){
                  const analyser=context.createAnalyser();analyser.fftSize=1024;
                  job.channelMeters.push({analyser,samples:new Float32Array(analyser.fftSize)});
                  job.channelSplitter.connect(analyser,channel,0);
                }
                job.compressor.connect(job.channelSplitter);
              }else{
                job.analyser=context.createAnalyser();job.analyser.fftSize=1024;
                job.levelSamples=new Float32Array(job.analyser.fftSize);
                job.compressor.connect(job.analyser);job.analyser.connect(context.destination);
              }
            }catch{try{job.compressor.disconnect();}catch{}this.releaseLevelNodes(job);}
          }
          if(!job.analyser)job.compressor.connect(context.destination);
        }
        const node=context.createBufferSource();node.buffer=buffer;node.connect(job.compressor);
        // Pause only between complete sentences, never between PCM blocks or
        // safety-split fragments. Existing synthesis/network gaps count too.
        const sentencePause=this.lastScheduledJobId!==null && this.lastScheduledJobId!==job.id && this.lastScheduledSentenceEnded?SENTENCE_PAUSE_SECONDS:0;
        const start=Math.max(this.nextStartTime+sentencePause,context.currentTime+.06),end=start+frames/job.format.sampleRate;
        job.outputEnd=end+.02;
        const entry={node,job,start,end,generation:this.generation};this.nextStartTime=end;
        this.lastScheduledJobId=job.id;this.lastScheduledSentenceEnded=SENTENCE_END.test(job.text.trim());
        job.sources.add(entry);this.sources.add(entry);
        node.onended=()=>{if(entry.generation!==this.generation)return;try{node.disconnect();}catch{}job.sources.delete(entry);this.sources.delete(entry);this.finish(job);this.pump();this.refreshPlayback();};
        node.start(start);
        if(!job.scheduleObserved){job.scheduleObserved=true;this.timing(job,'audioScheduled',{scheduledContextTime:start,contextTimeAtSchedule:context.currentTime,baseLatencySeconds:context.baseLatency,outputLatencySeconds:context.outputLatency});this.observeFirstSourceClock(job,context,start);}
      }
    }
    finish(job) {
      if(!job.remoteDone || job.blocks.length || job.sources.size || this.loading===job || job.tailTimer!==undefined)return;
      // The compressor has look-ahead/internal latency. Keep its output graph
      // connected briefly after the last input source ends, rather than
      // chopping its delayed tail. Explicit stop still disconnects immediately.
      const generation=this.generation;
      job.tailTimer=this.schedule(()=>{
        if(generation!==this.generation)return;
        try{job.compressor?.disconnect();}catch{}
        this.releaseLevelNodes(job);
        this.jobs=this.jobs.filter(item=>item!==job);this.pump();this.refreshPlayback();
      },20);
    }
    refreshPlayback() {
      if(this.playbackTimer!==null)this.cancel(this.playbackTimer);this.playbackTimer=null;
      const context=this.context,time=context?.currentTime || 0;
      const active=context?.state==='running'?[...this.sources].filter(entry=>entry.start<=time && entry.end>time):[];
      const tail=context?.state==='running'?this.jobs.find(job=>job.tailTimer!==undefined && job.outputEnd>time):null;
      for(const entry of active)if(entry.job.metrics.playbackStartMs===null)entry.job.metrics.playbackStartMs=this.now()-entry.job.requestAt;
      const job=active[0]?.job || tail || this.jobs.find(item=>item.status!=='queued');
      if(job)this.lastMetrics=job.metrics;
      const kind=this.busy?(this.blocked || (context && context.state!=='running' && this.jobs.some(item=>item.receivedSamples))?'blocked':active.length || tail?'playing':'loading'):'idle';
      this.onStatus({kind,metrics:this.lastMetrics?{...this.lastMetrics}:null});
      if(kind==='playing')this.startLevelMeter();else this.stopLevelMeter();
      if(context?.state==='running' && this.sources.size) {
        const boundary=Math.min(...[...this.sources].flatMap(entry=>[entry.start,entry.end]).filter(at=>at>time+.0001));
        if(Number.isFinite(boundary)) {
          const generation=this.generation;
          // An ended/statechange callback may replace this timer before a
          // previously queued timer callback runs. Never lose the new handle.
          const timer=this.schedule(()=>{if(generation!==this.generation || this.playbackTimer!==timer)return;this.playbackTimer=null;this.refreshPlayback();},Math.max(4,(boundary-time)*1000+2));
          this.playbackTimer=timer;
        }
      }
    }
  }
  return {isSupported,formatOf,pcmChunk,StreamAudioQueue};
});
