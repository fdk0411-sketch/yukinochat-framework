(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.YukinoVoice = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const SENTENCE_PAUSE_MS=180, SENTENCE_END=/[。！？!?][」』”’"']*$/u;

  // Retain offsets while excluding content that should never be spoken.
  function maskTechnicalContent(input) {
    let fence = null, inlineCode = null;
    function maskInlineCode(line) {
      let cursor = 0, result = '';
      while (cursor < line.length) {
        if (!inlineCode) {
          const open = line.indexOf('`', cursor);
          if (open < 0) return result + line.slice(cursor);
          result += line.slice(cursor, open);
          let end = open + 1;
          while (line[end] === '`') end++;
          inlineCode = end - open;
          result += ' '.repeat(inlineCode); cursor = end;
        }
        const runs = /`+/g; runs.lastIndex = cursor;
        let close, candidate;
        while ((candidate = runs.exec(line))) if (candidate[0].length === inlineCode) { close = candidate; break; }
        if (!close) return result + ' '.repeat(line.length - cursor);
        const end = close.index + close[0].length;
        result += ' '.repeat(end - cursor); cursor = end; inlineCode = null;
      }
      return result;
    }
    return String(input || '').split('\n').map(line => {
      const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
        return ' '.repeat(line.length);
      }
      if (marker && !inlineCode) { fence = {char:marker[1][0],length:marker[1].length}; return ' '.repeat(line.length); }
      const prose = maskInlineCode(line);
      if (/^\s*\|/.test(prose) || prose.includes('|') || /^\s*(?:https?:\/\/|\$\$|\\\[)/.test(prose)) return ' '.repeat(line.length);
      return prose
        .replace(/https?:\/\/[^\s）)]+/g, value => ' '.repeat(value.length));
    }).join('\n');
  }

  function cleanJapanese(input) {
    return input.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[*_]/g, '').replace(/\s+/g, ' ').trim();
  }

  // Fullwidth parentheses are reserved for the Chinese translation by the
  // application prompt. An unfinished pair is deliberately not sent to TTS.
  function extractPairs(input) {
    const text = maskTechnicalContent(input);
    const pairs = [];
    let cursor = 0;
    while (cursor < text.length) {
      const open = text.indexOf('（', cursor);
      if (open < 0) break;
      let depth = 1, end = open + 1;
      for (; end < text.length && depth; end++) {
        if (text[end] === '（') depth++;
        else if (text[end] === '）') depth--;
      }
      if (depth) break;
      const japanese = cleanJapanese(text.slice(cursor, open));
      const translation = text.slice(open + 1, end - 1).trim();
      if (japanese && translation) pairs.push({ text: japanese, start: cursor, end });
      cursor = end;
    }
    return pairs;
  }

  // Automatic playback can start as soon as a complete Japanese sentence is
  // followed by the translation opener. The opener is an explicit language
  // boundary; punctuation by itself is never used to guess the next language.
  // anchor/end are immutable offsets into the Japanese side, so completing or
  // extending the Chinese translation cannot enqueue the same sentence twice.
  function extractReadyUtterances(input) {
    const text = maskTechnicalContent(input), utterances = [];
    let cursor = 0;
    while (cursor < text.length) {
      const open = text.indexOf('（', cursor);
      if (open < 0) break;
      let depth = 1, end = open + 1;
      for (; end < text.length && depth; end++) {
        if (text[end] === '（') depth++;
        else if (text[end] === '）') depth--;
      }
      const japanese = cleanJapanese(text.slice(cursor, open));
      const completeSentence = /[。！？!?][」』”’"']*$/u.test(japanese);
      const completePair = !depth && text.slice(open + 1, end - 1).trim().length > 0;
      if (japanese && (completePair || (depth && completeSentence))) utterances.push({text:japanese,start:cursor,end:open,anchor:open});
      if (depth) break; // Never scan unfinished/nested Chinese as Japanese.
      cursor = end;
    }
    return utterances;
  }

  function speechChunks(text, maxLength = 220) {
    const sentences = text.match(/[^。！？!?]+[。！？!?]+[」』”’"']*|[^。！？!?]+$/g) || [];
    const chunks = [];
    for (const sentence of sentences) {
      let chars = Array.from(sentence.trim());
      while (chars.length > maxLength) {
        let split = maxLength;
        for (let i = maxLength - 1; i >= Math.floor(maxLength / 2); i--) {
          if (/[、，,；;：:\s]/.test(chars[i])) { split = i + 1; break; }
        }
        chunks.push(chars.slice(0, split).join(''));
        chars = chars.slice(split);
      }
      if (chars.length) chunks.push(chars.join(''));
    }
    return chunks;
  }

  class ReplyTracker {
    constructor() { this.session = null; }
    arm(conversationId, messages = []) {
      this.session = { conversationId, baseline: new Set(messages.map(message => message.id)), messages: new Map() };
    }
    clear() { this.session = null; }
    collect(conversation) {
      const session = this.session;
      if (!session || !conversation || conversation.id !== session.conversationId) return { chunks: [] };
      const hasNewMessage = (conversation.messages || []).some(message => message.id && !session.baseline.has(message.id));
      if (hasNewMessage && ['interrupted', 'failed', 'cancelled', 'canceled'].includes(conversation.status)) {
        this.clear(); return { chunks: [], interrupted: true };
      }
      const chunks = [];
      for (const message of conversation.messages || []) {
        if (message.role !== 'assistant' || !message.id || session.baseline.has(message.id)) continue;
        const text = String(message.text || '');
        let tracked = session.messages.get(message.id);
        if (!tracked) { tracked = { previous: '', consumed: [], turnId: message.turnId || null }; session.messages.set(message.id, tracked); }
        if (!text.startsWith(tracked.previous) || (tracked.turnId && message.turnId && message.turnId !== tracked.turnId)) {
          this.clear(); return { chunks: [], revised: true };
        }
        tracked.previous = text;
        const utterances = extractReadyUtterances(text);
        // Append-only text can still reveal a technical construct (for example
        // a later table delimiter). Cancel queued speech if its interpretation
        // changes; audio already heard cannot be taken back.
        if (tracked.consumed.some((unit, index) => unit.anchor !== utterances[index]?.anchor || unit.text !== utterances[index]?.text)) {
          this.clear(); return { chunks: [], revised: true };
        }
        for (const unit of utterances.slice(tracked.consumed.length)) chunks.push(...speechChunks(unit.text));
        tracked.consumed = utterances.map(({anchor,text}) => ({anchor,text}));
      }
      // Close eligibility at the end of this locally submitted turn. A later
      // reply initiated by another window must not inherit the permission.
      if (hasNewMessage && conversation.status === 'completed') this.clear();
      return { chunks };
    }
  }

  // GET and SSE use the same server-issued order. Do not infer freshness from
  // text length: a genuine newer revision still needs to cancel old speech.
  class SnapshotOrder {
    constructor() { this.epoch = null; this.sequence = 0; this.retiredEpochs = new Set(); }
    accept(snapshot) {
      const epoch = snapshot?.serverEpoch;
      const sequence = snapshot?.snapshotSequence;
      if (typeof epoch !== 'string' || !epoch.trim() || !Number.isSafeInteger(sequence) || sequence < 1) return { accepted:false, epochChanged:false };
      if (this.retiredEpochs.has(epoch) || (epoch === this.epoch && sequence <= this.sequence)) return { accepted:false, epochChanged:false };
      const epochChanged = this.epoch !== null && epoch !== this.epoch;
      if (epochChanged) this.retiredEpochs.add(this.epoch);
      this.epoch = epoch; this.sequence = sequence;
      return { accepted:true, epochChanged };
    }
  }

  class AudioQueue {
    constructor(options = {}) {
      this.requestAudio = options.requestAudio;
      this.createAudio = options.createAudio || (url => new Audio(url));
      this.createUrl = options.createUrl || (blob => URL.createObjectURL(blob));
      this.revokeUrl = options.revokeUrl || (url => URL.revokeObjectURL(url));
      this.onStatus = options.onStatus || (() => {});
      this.onLevel = typeof options.onLevel==='function'?options.onLevel:null;
      this.clarityAPI = options.clarityAPI || globalThis.YukinoAudioClarity;
      this.levelTimer = null; this.levelEpoch = 0;
      this.onTiming = options.onTiming || (() => {});this.jobSequence=0;
      this.now = options.now || (() => globalThis.performance.now());
      this.schedule = options.setTimeout || ((callback,delay) => globalThis.setTimeout(callback,delay));
      this.cancel = options.clearTimeout || (handle => globalThis.clearTimeout(handle));
      this.nextPlaybackAt = 0; this.pauseTimer = null;
      this.generation = 0;
      this.items = [];
      this.loading = null;
      this.current = null;
      this.blocked = false;
    }
    timing(item,type){try{this.onTiming({...item.timingContext,type,jobId:item.id,transport:'wav',at:this.now()});}catch{/* Diagnostics never interrupt playback. */}}
    emitLevel(level) { try { this.onLevel?.(Number.isFinite(level)?Math.min(1,Math.max(0,level)):0); } catch { /* Animation cannot interrupt sound. */ } }
    stopLevelMeter() {
      this.levelEpoch++;
      if(this.levelTimer!==null)this.cancel(this.levelTimer);
      this.levelTimer=null;this.emitLevel(0);
    }
    sampleLevel() {
      const current=this.current,audio=current?.audio;
      const volume=Number.isFinite(audio?.volume)?audio.volume:1;
      const level=current?.playing && !this.blocked && audio && !audio.paused && !audio.ended && !audio.muted
        ? (current.item.envelope?.at(audio.currentTime) || 0)*volume:0;
      this.emitLevel(level);
    }
    startLevelMeter() {
      this.stopLevelMeter();
      if(!this.onLevel || !this.current?.playing)return;
      const generation=this.generation,epoch=this.levelEpoch,audio=this.current.audio;
      const tick=()=>{
        if(generation!==this.generation || epoch!==this.levelEpoch || this.current?.audio!==audio)return;
        this.levelTimer=null;this.sampleLevel();
        if(this.current.playing)this.levelTimer=this.schedule(tick,1000/30);
      };
      tick();
    }
    releaseAudioEvents(audio) { audio.onended=audio.onerror=audio.onplaying=audio.onpause=audio.onwaiting=audio.onvolumechange=null; }
    enqueue(texts,timingContext=null) {
      for (const text of texts) if (String(text).trim()) this.items.push({ text, id:++this.jobSequence,timingContext:timingContext?{...timingContext}:null,status: 'queued', url: null });
      this.pump();
    }
    get busy() { return !!(this.current || this.loading || this.items.length); }
    clear(emit = true) {
      this.generation++;
      this.stopLevelMeter();
      if (this.pauseTimer !== null) this.cancel(this.pauseTimer);
      this.pauseTimer = null; this.nextPlaybackAt = 0;
      if (this.loading) this.loading.controller.abort();
      this.loading = null;
      if (this.current) {
        const { audio, item } = this.current;
        this.releaseAudioEvents(audio);
        audio.pause(); audio.removeAttribute?.('src'); audio.load?.();
        if (item.url) this.revokeUrl(item.url);
      }
      for (const item of this.items) if (item.url) this.revokeUrl(item.url);
      this.current = null; this.items = []; this.blocked = false;
      if (emit) this.onStatus({ kind: 'idle' });
    }
    fail(message) {
      this.clear(false);
      this.onStatus({ kind: 'error', message });
    }
    pump() {
      const generation = this.generation;
      // One synthesis request at a time; at most two prepared WAVs. Synthesis
      // of the next sentence overlaps playback without changing speech order.
      const waiting = this.items.find(item => item.status === 'queued');
      if (!this.loading && waiting && this.items.filter(item => item.status === 'ready').length < 2) {
        const controller = new AbortController();
        const operation = { controller, item: waiting };
        this.loading = operation; waiting.status = 'loading';
        waiting.requestAt=this.now();waiting.metrics={transport:'wav',firstAudioMs:null,playbackStartMs:null,completeMs:null};
        if (!this.current) this.onStatus({ kind: 'loading',metrics:{...waiting.metrics} });
        Promise.resolve().then(() => {if(generation!==this.generation || controller.signal.aborted)return;this.timing(waiting,'ttsRequest');return this.requestAudio(waiting.text, controller.signal);}).then(async blob => {
          if (generation !== this.generation || controller.signal.aborted) return;
          waiting.metrics.firstAudioMs=this.now()-waiting.requestAt;waiting.metrics.completeMs=waiting.metrics.firstAudioMs;
          this.timing(waiting,'ttsDone');
          if(this.onLevel && this.clarityAPI?.wavLevelEnvelope && blob?.arrayBuffer) {
            try { waiting.envelope=this.clarityAPI.wavLevelEnvelope(await blob.arrayBuffer()); }
            catch { /* Unsupported audio keeps playing, with a closed mouth. */ }
            if(generation!==this.generation || controller.signal.aborted)return;
          }
          waiting.url = this.createUrl(blob); waiting.status = 'ready';
        }).catch(error => {
          if (generation !== this.generation || controller.signal.aborted) return;
          this.fail(error.message || '声音生成失败，请稍后重试。');
        }).finally(() => {
          if (generation !== this.generation) return;
          if (this.loading === operation) this.loading = null;
          this.pump();
        });
      }
      if (this.current || this.blocked) return;
      const item = this.items[0];
      if (!item) { if (!this.loading) this.onStatus({ kind: 'idle' }); return; }
      if (item.status !== 'ready') return;
      // Keep prefetch running above; delay only playback of the next sentence.
      const remainingPause = this.nextPlaybackAt - this.now();
      if (remainingPause > 0) {
        if (this.pauseTimer === null) {
          this.onStatus({ kind: 'loading',metrics:item.metrics?{...item.metrics}:null });
          this.pauseTimer = this.schedule(() => {
            if (generation !== this.generation) return;
            this.pauseTimer = null; this.pump();
          }, remainingPause);
        }
        return;
      }
      if (this.pauseTimer !== null) this.cancel(this.pauseTimer);
      this.pauseTimer = null;
      this.items.shift();
      let audio;
      try { audio = this.createAudio(item.url); }
      catch { this.revokeUrl(item.url); this.fail('声音无法播放，请稍后重听。'); return; }
      this.current = { audio, item, playing:false };
      const current=()=>generation===this.generation && this.current?.audio===audio;
      audio.onplaying=()=>{if(current()){this.current.playing=true;this.startLevelMeter();}};
      audio.onpause=audio.onwaiting=()=>{if(current()){this.current.playing=false;this.stopLevelMeter();}};
      audio.onvolumechange=()=>{if(current())this.sampleLevel();};
      audio.onended = () => {
        if (generation !== this.generation || this.current?.audio !== audio) return;
        this.stopLevelMeter();this.releaseAudioEvents(audio);
        this.revokeUrl(item.url); this.current = null;
        this.nextPlaybackAt = this.now() + (SENTENCE_END.test(String(item.text).trim()) ? SENTENCE_PAUSE_MS : 0);
        this.pump();
      };
      audio.onerror = () => {
        if (generation === this.generation && this.current?.audio === audio) this.fail('声音文件无法播放，请稍后重听。');
      };
      this.playCurrent();
    }
    playCurrent() {
      if (!this.current) return;
      const generation = this.generation;
      const audio = this.current.audio;
      this.blocked = false;
      let promise;
      try { promise = audio.play(); }
      catch (error) { promise = Promise.reject(error); }
      Promise.resolve(promise).then(() => {
        if (generation === this.generation && this.current?.audio === audio) {
          const item=this.current.item;if(item.metrics.playbackStartMs===null){item.metrics.playbackStartMs=this.now()-item.requestAt;this.timing(item,'playbackObserved');}
          this.onStatus({ kind: 'playing',metrics:{...item.metrics} });
          this.current.playing=true;this.startLevelMeter();
        }
      }).catch(error => {
        if (generation !== this.generation || this.current?.audio !== audio) return;
        if (error.name === 'NotAllowedError') { this.blocked = true; this.current.playing=false;this.stopLevelMeter();this.onStatus({ kind: 'blocked' }); }
        else this.fail('播放没有成功，请稍后重听。');
      });
    }
    resume() { if (this.blocked) this.playCurrent(); }
  }

  async function requestAudio(text, signal) {
    const response = await fetch('/api/tts', {
      method: 'POST', credentials: 'same-origin', signal,
      headers: { 'Content-Type': 'application/json', 'X-Yukino-Client': '1' },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || '声音暂时无法生成，请稍后重试。');
    }
    if (!/^audio\/(?:wav|x-wav|wave)\b/i.test(response.headers.get('content-type') || '')) throw new Error('没有收到可播放的声音，请稍后重试。');
    return response.blob();
  }

  class AdaptiveAudioQueue {
    constructor(options={}) {
      this.onStatus=options.onStatus || (()=>{});
      this.onLevel=typeof options.onLevel==='function'?options.onLevel:null;
      this.clarityEnabled=!!options.clarityEnabled;
      this.now=options.now || (()=>globalThis.performance.now());
      this.streamAPI=options.streamAPI || globalThis.YukinoStreamAudio;
      this.clarityAPI=options.clarityAPI || globalThis.YukinoAudioClarity;
      this.generation=0;this.preferStreaming=false;this.active=null;
      this.wave=new AudioQueue({...options,requestAudio:async(text,signal)=>{
        const blob=await (options.waveRequestAudio || requestAudio)(text,signal);
        const process=this.clarityEnabled?this.clarityAPI?.processWavPcm16:this.clarityAPI?.applyWavHeadroom;
        if(process) {
          try {const processed=process(await blob.arrayBuffer());return new Blob([processed.bytes],{type:'audio/wav'});}
          catch {return blob;} // Optional playback processing never blocks WAV.
        }
        return blob;
      },onLevel:this.onLevel?level=>{if(this.active===this.wave)this.onLevel(level);}:undefined,onStatus:status=>{
        if(this.active!==this.wave)return;
        this.onStatus(status);
      }});
      this.stream=new this.streamAPI.StreamAudioQueue({...options,onLevel:this.onLevel?level=>{if(this.active===this.stream)this.onLevel(level);}:undefined,onStatus:status=>{if(this.active===this.stream)this.onStatus(status);}});
    }
    get busy(){return !!this.active?.busy;}
    get blocked(){return !!this.active?.blocked;}
    setStreaming(enabled){this.preferStreaming=!!enabled && this.streamAPI.isSupported();}
    setClarity(enabled){this.clarityEnabled=!!enabled;this.stream.setClarity(enabled);}
    unlock(){return this.stream.unlock();}
    enqueue(texts,timingContext=null){if(!this.active || !this.active.busy)this.active=this.preferStreaming?this.stream:this.wave;this.active.enqueue(texts,timingContext);}
    clear(emit=true){this.generation++;this.wave.clear(false);this.stream.clear(false);this.active=null;try{this.onLevel?.(0);}catch{}if(emit)this.onStatus({kind:'idle'});}
    resume(){return this.active?.resume();}
  }

  const PROVIDERS = new Set(['gpt-sovits', 'moss']);
  const STARTING_STATUSES = new Set(['starting','local_starting']);
  const WARMING_STATUSES = new Set(['warming','local_warming']);
  function safeMessage(value, fallback = '') {
    return typeof value === 'string' && value.trim() ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 220) : fallback;
  }
  function voiceStatusLabel(status = {}) {
    const provider = status.provider === 'gpt-sovits' ? '本地 · GPT-SoVITS' : status.provider === 'moss' ? '云端 · B' : '声音';
    let detail;
    if (status.switching) detail = '正在切换音源……';
    else if (status.kind === 'error') detail = safeMessage(status.message || status.error, '朗读未成功，可稍后重听');
    else if (status.kind === 'loading') detail = '正在准备这一句的声音……';
    else if (status.kind === 'playing') detail = '正在朗读日语';
    else if (status.kind === 'blocked') detail = '声音已准备好，请点击播放';
    else if (STARTING_STATUSES.has(status.status)) detail = '正在启动，请稍候……';
    else if (WARMING_STATUSES.has(status.status)) detail = '正在预热，就绪后会朗读新回复';
    else if (status.status === 'checking') detail = '正在检查声音……';
    else if (status.available) detail = status.enabled ? '新回复会用日语朗读' : '自动朗读已关闭';
    else if (status.status === 'moss_key_missing') detail = '尚未配置云端密钥，可切回本地';
    else detail = safeMessage(status.error, '声音暂未连接，文字聊天可继续');
    return `${provider} · ${detail}`;
  }

  class Controller {
    constructor(options = {}) {
      this.enabled = options.enabled !== false;
      this.clarityEnabled = !!options.clarityEnabled;
      this.onUpdate = options.onUpdate || (() => {});
      this.onLevel = typeof options.onLevel==='function'?options.onLevel:null;
      this.onTiming = options.onTiming || (() => {});this.timingContext=null;
      this.now = options.now || (() => globalThis.performance.now());
      this.firstTextAt = null;this.textToPlaybackMs=null;
      this.fetch = options.fetch || ((...args) => globalThis.fetch(...args));
      this.schedule = options.setTimeout || ((fn, ms) => globalThis.setTimeout(fn, ms));
      this.cancel = options.clearTimeout || (handle => globalThis.clearTimeout(handle));
      this.visible = options.visible !== false;
      this.connected = true;
      this.disposed = false;
      this.pollTimer = null;
      this.availabilityVersion = 0;
      this.availabilityOperation = null;
      this.providerRequest = null;
      this.providerOperation = null;
      this.providerRefreshPending = false;
      this.switching = false;
      this.pendingProvider = null;
      this.availability = { provider: null, configured: false, available: false, status: 'checking' };
      this.activity = { kind: 'idle' };
      this.tracker = new ReplyTracker();
      const Queue=!options.requestAudio && (options.streamAPI || globalThis.YukinoStreamAudio)?.StreamAudioQueue ? AdaptiveAudioQueue : AudioQueue;
      this.queue = new Queue({ ...options, ...(Queue===AudioQueue?{requestAudio:options.requestAudio || requestAudio}:{}), onLevel:this.onLevel?level=>this.emitLevel(level):undefined, onTiming:event=>{try{this.onTiming(event);}catch{}}, onStatus: status => {
        if(status.kind==='playing' && this.firstTextAt!==null && this.textToPlaybackMs===null)this.textToPlaybackMs=this.now()-this.firstTextAt;
        this.activity = {...status,...(this.textToPlaybackMs!==null?{metrics:{...status.metrics,textToPlaybackMs:this.textToPlaybackMs}}:{})};
        if (status.kind === 'error') {this.tracker.clear();this.timing('cancel',{reason:'playback-error'});}
        if (status.kind === 'idle')this.timing('audioIdle');
        if (status.kind !== 'playing')this.emitLevel(0);
        this.update();
      } });
      this.availabilityRequest = null;
      this.probeBuffer = null;
    }
    update() { if (!this.disposed) this.onUpdate({ ...this.availability, ...this.activity, switching:this.switching, pendingProvider:this.pendingProvider, checking:!!this.availabilityOperation, enabled: this.enabled, clarityEnabled:this.clarityEnabled, busy: this.queue.busy, blocked: this.queue.blocked }); }
    emitLevel(level) {
      const valid=this.visible && this.connected && !this.disposed && this.activity.kind==='playing' && Number.isFinite(level);
      try { this.onLevel?.(valid?Math.min(1,Math.max(0,level)):0); } catch { /* Optional avatar is isolated from playback. */ }
    }
    timing(type,extra={}){if(this.timingContext)try{this.onTiming({...this.timingContext,type,at:this.now(),...extra});}catch{/* Diagnostic consumers are optional. */}}
    clearPoll() { if (this.pollTimer !== null) this.cancel(this.pollTimer); this.pollTimer = null; }
    schedulePoll() {
      this.clearPoll();
      if (this.disposed || !this.visible || !this.connected || this.switching || this.availabilityOperation || !(STARTING_STATUSES.has(this.availability.status) || WARMING_STATUSES.has(this.availability.status))) return;
      this.pollTimer = this.schedule(() => { this.pollTimer = null; void this.refreshAvailability(); }, 2000);
    }
    invalidateAvailability() {
      this.clearPoll();
      this.availabilityVersion++;
      this.availabilityOperation?.controller.abort();
      this.availabilityOperation = null;
      this.availabilityRequest = null;
    }
    applyAvailability(result) {
      const provider = PROVIDERS.has(result?.provider) ? result.provider : this.availability.provider;
      if (this.availability.provider && provider !== this.availability.provider) this.stop();
      this.availability = { provider, configured:result?.configured === true, available:result?.available === true,
        streaming:result?.streaming === true, name:safeMessage(result?.name, '日语声音'),
        status:safeMessage(result?.status, 'unavailable'), error:safeMessage(result?.error) };
      this.queue.setStreaming?.(this.availability.streaming);
      const pending = this.probeBuffer;
      this.probeBuffer = null;
      if (!this.availability.available) {
        // A response produced during startup is not a backlog to play later.
        this.stop();
      } else if (!this.switching && pending?.generation === this.queue.generation && this.enabled){if(pending.chunks.length)this.timing('audioBusy');this.queue.enqueue(pending.chunks,this.timingContext);}
      this.update();
    }
    refreshAvailability({ duringSwitch = false } = {}) {
      if (this.disposed || !this.connected) return Promise.resolve();
      if (this.switching && !duringSwitch) return this.providerRequest || Promise.resolve();
      if (this.availabilityRequest) return this.availabilityRequest;
      this.clearPoll();
      const operation = { controller:new AbortController(), version:this.availabilityVersion };
      this.availabilityOperation = operation;
      const current = () => !this.disposed && operation.version === this.availabilityVersion && this.availabilityOperation === operation;
      const request = (async () => {
        try {
          const response = await this.fetch('/api/voice', { credentials: 'same-origin', cache: 'no-store', signal:operation.controller.signal });
          if (!response.ok) throw new Error('声音暂时未连接');
          const result = await response.json();
          if (current()) this.applyAvailability(result);
        } catch {
          if (current()) this.applyAvailability({ ...this.availability, available:false, status:'unavailable', error:'声音暂时未连接，请稍后检查。' });
        }
      })().finally(() => {
        if (this.availabilityOperation !== operation) return;
        this.availabilityOperation = null; this.availabilityRequest = null;
        this.schedulePoll(); this.update();
      });
      this.availabilityRequest = request;
      this.update();
      return request;
    }
    setProvider(provider) {
      if (!PROVIDERS.has(provider) || this.disposed) return Promise.resolve(false);
      if (this.providerRequest) return this.providerRequest;
      if (this.availability.provider === provider) return Promise.resolve(true);
      this.stop(); this.invalidateAvailability();
      this.switching = true; this.pendingProvider = provider;
      const operation = { controller:new AbortController() };
      this.providerOperation = operation;
      const request = (async () => {
        let errorMessage = '';
        try {
          const response = await this.fetch('/api/voice/provider', { method:'POST', credentials:'same-origin',
            headers:{'Content-Type':'application/json','X-Yukino-Client':'1'}, body:JSON.stringify({provider}), signal:operation.controller.signal });
          const result = await response.json();
          if (!response.ok || result.ok === false) throw new Error(safeMessage(result.error, '音源切换未成功，请稍后重试。'));
          if (!this.disposed) this.applyAvailability(result);
        } catch (error) { errorMessage = safeMessage(error.message, '音源切换未成功，请稍后重试。'); }
        if (this.disposed) return false;
        // A failed POST can still have reached the server; always re-read its
        // actual selection. Voice SSE received during the POST is coalesced here.
        do {
          this.providerRefreshPending = false;
          await this.refreshAvailability({duringSwitch:true});
        } while (this.providerRefreshPending && !this.disposed && this.connected);
        if (errorMessage && !this.disposed) this.activity = {kind:'error',message:errorMessage};
        return !errorMessage;
      })().finally(() => {
        if (this.providerOperation !== operation) return;
        this.providerOperation = null; this.providerRequest = null;
        this.switching = false; this.pendingProvider = null;
        this.schedulePoll(); this.update();
      });
      this.providerRequest = request;
      this.update();
      return request;
    }
    handleVoiceChange() {
      this.stop(); this.invalidateAvailability();
      this.availability = {...this.availability,available:false,status:'checking',error:''};
      this.providerRefreshPending = true;
      this.update();
      if (this.switching) return this.providerRequest || Promise.resolve();
      return this.refreshAvailability();
    }
    setVisible(value) {
      this.visible = !!value;
      if (!this.visible)this.emitLevel(0);
      if (!this.visible) this.clearPoll();
      else if (this.connected) void this.refreshAvailability();
    }
    setConnected(value) {
      this.connected = !!value;
      if (!this.connected) { this.stop('disconnected'); this.invalidateAvailability(); }
      else if (this.visible) void this.refreshAvailability();
    }
    dispose() {
      this.disposed = true; this.stop(); this.invalidateAvailability();
      this.providerOperation?.controller.abort();
    }
    setEnabled(value) { this.enabled = !!value; this.stop('voice-setting'); }
    setClarity(value) { this.clarityEnabled=!!value;this.stop('clarity-setting');this.queue.setClarity?.(this.clarityEnabled);this.update(); }
    unlockPlayback() { return this.queue.unlock?.() || Promise.resolve(true); }
    begin(conversation,timingContext=null) {
      this.stop('new-turn');
      this.timingContext=timingContext?{...timingContext}:null;
      if (this.enabled && conversation && !this.switching && !this.disposed && (this.availability.available || this.availability.status === 'checking')) {
        this.tracker.arm(conversation.id, conversation.messages || []);
        // Only a turn submitted in this window may wait for this probe. Clear
        // this buffer on every stop/switch, and discard it after a failed probe.
        if (this.availability.status === 'checking') this.probeBuffer = { generation: this.queue.generation, chunks: [] };
      }
      void this.refreshAvailability();
    }
    observe(conversation) {
      const session=this.tracker.session;
      if(this.firstTextAt===null && session && conversation?.id===session.conversationId && (conversation.messages || []).some(message=>message.role==='assistant' && message.id && !session.baseline.has(message.id) && String(message.text || '').trim())) this.firstTextAt=this.now();
      const result = this.tracker.collect(conversation);
      if (result.revised || result.interrupted) { this.stop(result.revised?'reply-revised':'turn-interrupted'); return; }
      if (!this.enabled || this.switching || this.disposed || !result.chunks.length) return;
      this.timing('japaneseReady');
      if (this.availability.available) {this.timing('audioBusy');this.queue.enqueue(result.chunks,this.timingContext);}
      else if (this.probeBuffer?.generation === this.queue.generation) this.probeBuffer.chunks.push(...result.chunks);
      // Once a probe has confirmed unavailable, consume subsequent snapshots
      // without storing them; recovery must not read accumulated old replies.
    }
    stop(reason='voice-stopped') {const context=this.timingContext;this.timingContext=null;this.probeBuffer = null; this.tracker.clear(); this.firstTextAt=null;this.textToPlaybackMs=null;this.queue.clear();if(context)try{this.onTiming({...context,type:'cancel',reason,at:this.now()});}catch{} }
    disconnect() { this.setConnected(false); }
    replay(text) {
      this.stop();
      if (!this.availability.available || this.switching || this.disposed) return false;
      const chunks = extractPairs(text).flatMap(pair => speechChunks(pair.text));
      if (!chunks.length) return false;
      this.queue.enqueue(chunks); return true;
    }
    preview() {
      this.stop();
      if (!this.availability.available || this.switching || this.disposed) return false;
      this.queue.enqueue(['こんにちは。', '今日も、あなたの話を聞かせて。']); return true;
    }
    resume() { this.queue.resume(); }
  }

  return { extractPairs, extractReadyUtterances, speechChunks, ReplyTracker, SnapshotOrder, AudioQueue, AdaptiveAudioQueue, Controller, voiceStatusLabel };
});
