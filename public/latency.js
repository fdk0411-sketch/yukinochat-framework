(function(root,factory){
  const api=factory();
  if(typeof module==='object' && module.exports)module.exports=api;
  else root.YukinoLatencyTools=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const MARKS=['sendAt','sendFetchAt','sendAckAt','firstBodyDomAt','firstVisibleFrameOpportunityAt','firstJapaneseReadyAt','firstTtsRequestAt','firstPcmAt','firstAudioScheduledAt','firstPlaybackObservedAt','firstTtsDoneAt','textCompleteAt','audioIdleAt'];
  const SERVER_MS=['threadReadyMs','turnRequestMs','turnStartedMs','firstReasoningEventMs','reasoningCompletedMs','firstAgentDeltaMs','firstBodyReadyMs','textCompleteMs'];
  const clone=value=>value==null?null:JSON.parse(JSON.stringify(value));
  const finite=value=>typeof value==='number' && Number.isFinite(value) && value>=0;
  const responseMode=value=>value==='deep'?'deep':'daily';
  let sequence=0;
  function traceId(){return globalThis.crypto?.randomUUID?.() || `latency-${Date.now().toString(36)}-${++sequence}`;}
  function effectiveBody(text){
    const body=String(text || '').replace(/<yukino-avatar\b[^>]*\/?\s*>/gi,'').trim();
    if(/^(?:雪乃正在回应|正在思考|正在回应|思考中|thinking)[\s.…·。!！?？]*$/iu.test(body))return false;
    return /[\p{Script=Latin}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Number}]/u.test(body);
  }
  function visibleElement(element){
    if(!element?.isConnected || element.ownerDocument?.visibilityState!=='visible')return false;
    const rect=element.getBoundingClientRect?.(), view=element.ownerDocument?.defaultView;
    if(!rect || rect.width<=0 || rect.height<=0 || rect.bottom<=0 || rect.right<=0 || rect.top>=(view?.innerHeight || Infinity) || rect.left>=(view?.innerWidth || Infinity))return false;
    const style=view?.getComputedStyle?.(element);
    return !style || (style.visibility!=='hidden' && style.display!=='none' && style.opacity!=='0');
  }
  class LatencyTracker {
    constructor(options={}){
      this.now=options.now || (()=>globalThis.performance.now());
      this.idFactory=options.idFactory || traceId;
      this.raf=options.requestAnimationFrame || (fn=>globalThis.requestAnimationFrame(fn));
      this.isVisible=options.isVisible || visibleElement;
      this.limit=Math.max(1,Math.min(16,options.limit || 8));
      this.records=[];this.current=null;this.generation=0;
    }
    start({conversationId=null,messages=[],mode='daily',speechEnabled=true,serverTimingRequired=false}={}){
      this.cancel('new-send');
      const record={clientTraceId:this.idFactory(),conversationId,responseMode:responseMode(mode),generation:++this.generation,status:'active',cancelReason:null,speechEnabled:!!speechEnabled,
        marks:Object.fromEntries(MARKS.map(key=>[key,null])),audio:{transport:null,firstJobId:null,scheduledContextTime:null,contextTimeAtSchedule:null,baseLatencySeconds:null,outputLatencySeconds:null,serverMetrics:null},serverTimings:null};
      record.marks.sendAt=this.now();
      this.current={record,baseline:new Set(messages.map(message=>message.id)),serverTimingRequired,serverMatched:!serverTimingRequired,snapshotAccepted:!serverTimingRequired,framePending:false,invalidated:false,audioBusy:false,idleAt:null};
      this.records.push(record);if(this.records.length>this.limit)this.records.shift();
      return record.clientTraceId;
    }
    matches(id){return !!this.current && !this.current.invalidated && this.current.record.clientTraceId===id && this.current.record.status!=='cancelled';}
    bind(id,conversationId,messages=[]){
      if(!this.matches(id))return false;
      const current=this.current;
      if(current.record.conversationId && current.record.conversationId!==conversationId)return false;
      current.record.conversationId=conversationId;
      for(const message of messages)current.baseline.add(message.id);
      return true;
    }
    mark(id,name,at=this.now()){
      if(!this.matches(id) || !MARKS.includes(name) || !finite(at))return false;
      const marks=this.current.record.marks;
      if(marks[name]!==null || at<marks.sendAt)return false;
      marks[name]=at;this.finish();return true;
    }
    observeConversation(conversation,timing){
      const current=this.current, record=current?.record;
      if(!record || !this.matches(record.clientTraceId) || !conversation || conversation.id!==record.conversationId)return false;
      if(current.serverTimingRequired && timing?.clientTraceId!==record.clientTraceId){current.snapshotAccepted=false;return false;}
      if(timing?.clientTraceId===record.clientTraceId){
        current.serverMatched=true;
        const safe={clientTraceId:record.clientTraceId,clock:'server-relative-send-handler',mode:responseMode(timing.mode)};
        for(const key of SERVER_MS)safe[key]=finite(timing[key])?timing[key]:null;
        for(const key of ['turnId','requestedEffort','actualModel','actualEffort','actualServiceTier'])safe[key]=typeof timing[key]==='string'?timing[key].slice(0,160):null;
        record.serverTimings=safe;
      }
      current.snapshotAccepted=current.serverMatched;return current.serverMatched;
    }
    observeBody({conversationId,messageId,role,element}){
      const current=this.current,record=current?.record;
      if(!record || !this.matches(record.clientTraceId) || !current.snapshotAccepted || record.conversationId!==conversationId || role!=='assistant' || !messageId || current.baseline.has(messageId) || !element?.isConnected || !effectiveBody(element.textContent))return;
      const id=record.clientTraceId;
      this.mark(id,'firstBodyDomAt');
      if(record.marks.firstVisibleFrameOpportunityAt!==null || current.framePending)return;
      current.framePending=true;
      // Two rAF callbacks offer a rendering opportunity; this is not a monitor
      // paint measurement. Revalidate identity and visibility after both frames.
      this.raf(()=>this.raf(()=>{
        if(this.current!==current || !this.matches(id))return;
        current.framePending=false;
        if(current.snapshotAccepted && this.isVisible(element) && effectiveBody(element.textContent))this.mark(id,'firstVisibleFrameOpportunityAt');
      }));
    }
    observeTerminal(conversation,accepted){
      const record=this.current?.record;
      if(!accepted || !record || conversation?.id!==record.conversationId || !this.current.serverMatched)return;
      const fresh=(conversation.messages || []).some(message=>message.role==='assistant' && message.id && !this.current.baseline.has(message.id));
      if(!fresh)return;
      if(conversation.status==='completed'){
        this.mark(record.clientTraceId,'textCompleteAt');
        if(!this.current.audioBusy && this.current.idleAt!==null && record.marks.firstTtsRequestAt!==null)this.mark(record.clientTraceId,'audioIdleAt',this.current.idleAt);
      }
      else if(['failed','interrupted','cancelled','canceled'].includes(conversation.status))this.cancel('turn-'+conversation.status);
    }
    timing(event){
      const current=this.current,record=current?.record;
      if(!record || !this.matches(event?.clientTraceId) || event.conversationId!==record.conversationId)return;
      if(event.type==='cancel'){this.cancel(event.reason || 'voice-stopped');return;}
      if(!current.snapshotAccepted)return;
      if(event.type==='japaneseReady'){this.mark(record.clientTraceId,'firstJapaneseReadyAt',event.at);return;}
      if(event.type==='audioBusy' || event.type==='ttsRequest'){current.audioBusy=true;current.idleAt=null;}
      if(event.type==='audioBusy')return;
      if(event.type==='audioIdle'){
        current.audioBusy=false;current.idleAt=finite(event.at)?event.at:this.now();
        if(record.marks.textCompleteAt!==null && record.marks.firstTtsRequestAt!==null)this.mark(record.clientTraceId,'audioIdleAt',current.idleAt);
        return;
      }
      if(event.type==='ttsRequest' && record.audio.firstJobId===null){record.audio.firstJobId=event.jobId;record.audio.transport=event.transport;}
      if(event.jobId!==record.audio.firstJobId || record.audio.firstJobId===null)return;
      const name={ttsRequest:'firstTtsRequestAt',firstPcm:'firstPcmAt',audioScheduled:'firstAudioScheduledAt',playbackObserved:'firstPlaybackObservedAt',ttsDone:'firstTtsDoneAt'}[event.type];
      if(!name)return;
      const first=this.mark(record.clientTraceId,name,event.at);
      if(first && event.type==='audioScheduled'){
        for(const key of ['scheduledContextTime','contextTimeAtSchedule','baseLatencySeconds','outputLatencySeconds'])record.audio[key]=finite(event[key])?event[key]:null;
      }
      if(first && event.type==='ttsDone' && event.serverMetrics && typeof event.serverMetrics==='object'){
        const server={};for(const key of ['queueMs','firstAudioMs','completeMs'])if(finite(event.serverMetrics[key]))server[key]=event.serverMetrics[key];
        record.audio.serverMetrics=server;
      }
    }
    finish(){
      const record=this.current?.record;
      if(record?.status==='active' && record.marks.textCompleteAt!==null && (!record.speechEnabled || record.marks.audioIdleAt!==null || (!this.current.audioBusy && record.marks.firstJapaneseReadyAt===null)))record.status='completed';
    }
    cancel(reason='stopped'){
      const record=this.current?.record;
      if(record?.status==='active'){record.status='cancelled';record.cancelReason=String(reason).slice(0,80);}
      if(this.current)this.current.invalidated=true;
    }
    serialize(record){
      if(!record)return null;
      const result=clone(record),m=result.marks;
      const diff=(end,start)=>m[end]===null || m[start]===null?null:m[end]-m[start];
      result.durations={sendToFirstBodyDomMs:diff('firstBodyDomAt','sendAt'),sendToFirstVisibleFrameOpportunityMs:diff('firstVisibleFrameOpportunityAt','sendAt'),sendToFirstJapaneseReadyMs:diff('firstJapaneseReadyAt','sendAt'),sendToFirstPlaybackObservedMs:diff('firstPlaybackObservedAt','sendAt'),sendToTextCompleteMs:diff('textCompleteAt','sendAt'),japaneseReadyToTtsRequestMs:diff('firstTtsRequestAt','firstJapaneseReadyAt'),ttsRequestToFirstPcmMs:diff('firstPcmAt','firstTtsRequestAt'),firstPcmToScheduledMs:diff('firstAudioScheduledAt','firstPcmAt')};
      return result;
    }
    snapshot(){return this.serialize(this.current?.record);}
    history(){return this.records.map(record=>this.serialize(record));}
  }
  return {LatencyTracker,effectiveBody,responseMode};
});
