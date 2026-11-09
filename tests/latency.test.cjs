const test=require('node:test');
const assert=require('node:assert/strict');
const {LatencyTracker,effectiveBody,responseMode}=require('../public/latency.js');
function harness(options={}){
  let now=100,ids=0;const frames=[];
  const tracker=new LatencyTracker({now:()=>now,idFactory:()=>`trace-${++ids}`,requestAnimationFrame:fn=>frames.push(fn),isVisible:element=>element.visible!==false,...options});
  return {tracker,frames,set(value){now=value;},frame(){const work=frames.splice(0);for(const fn of work)fn();}};
}
const body=(text='こんにちは')=>({isConnected:true,textContent:text,visible:true});
const conversation=(status='running')=>({id:'chat',status,messages:[{id:'fresh',role:'assistant'}]});
function event(id,type,at,jobId=1,extra={}){return {clientTraceId:id,conversationId:'chat',type,at,jobId,transport:'pcm-stream',...extra};}

test('send starts before new-chat RTT; bind never resets start and snapshots are bounded copies',()=>{
  const h=harness({limit:2}),t=h.tracker,id=t.start({mode:'deep'});
  h.set(250);assert.equal(t.bind(id,'chat'),true);t.mark(id,'sendFetchAt');
  h.set(300);t.observeBody({conversationId:'chat',messageId:'fresh',role:'assistant',element:body()});
  assert.equal(t.snapshot().durations.sendToFirstBodyDomMs,200);
  assert.equal(t.snapshot().marks.sendFetchAt,250);
  assert.equal(t.snapshot().responseMode,'deep');
  const copy=t.snapshot();copy.marks.sendAt=0;assert.equal(t.snapshot().marks.sendAt,100);
  t.start();t.start();assert.equal(t.history().length,2);
  assert.equal(responseMode('arbitrary'),'daily');
});

test('body requires fresh connected prose, not history, labels, punctuation or avatar controls',()=>{
  const h=harness(),t=h.tracker;t.start({conversationId:'chat',messages:[{id:'old'}]});
  for(const text of ['','……!?','<yukino-avatar expression="calm" pose="rest"/>','雪乃正在回应···','Thinking...'])assert.equal(effectiveBody(text),false);
  for(const text of ['あ','你','A','7','한'])assert.equal(effectiveBody(text),true);
  const observe=(overrides={})=>t.observeBody({conversationId:'chat',messageId:'fresh',role:'assistant',element:body(),...overrides});
  observe({messageId:'old'});observe({role:'user'});observe({conversationId:'other'});observe({element:{...body(),isConnected:false}});observe({element:body('…')});
  assert.equal(t.snapshot().marks.firstBodyDomAt,null);
  h.set(150);observe();h.set(180);observe();assert.equal(t.snapshot().marks.firstBodyDomAt,150);
  h.frame();assert.equal(t.snapshot().marks.firstVisibleFrameOpportunityAt,null);
  h.set(200);h.frame();assert.equal(t.snapshot().marks.firstVisibleFrameOpportunityAt,200);
});

test('server trace must match; foreign turns and server-relative clocks never supply browser timestamps',()=>{
  const h=harness(),t=h.tracker,id=t.start({conversationId:'chat',serverTimingRequired:true});
  assert.equal(t.observeConversation(conversation(),{clientTraceId:'old',firstBodyReadyMs:2}),false);
  t.observeBody({conversationId:'chat',messageId:'fresh',role:'assistant',element:body()});
  assert.equal(t.snapshot().marks.firstBodyDomAt,null);
  assert.equal(t.observeConversation(conversation(),{clientTraceId:id,mode:'daily',firstBodyReadyMs:2,textCompleteMs:9,unexpectedText:'private text'}),true);
  assert.equal(t.snapshot().serverTimings.firstBodyReadyMs,2);
  assert.equal(t.snapshot().marks.textCompleteAt,null);
  assert.equal(JSON.stringify(t.snapshot()).includes('private text'),false);
  t.observeConversation(conversation(),{clientTraceId:'other'});
  t.timing(event(id,'ttsRequest',130));assert.equal(t.snapshot().marks.firstTtsRequestAt,null);
});

test('first job milestones freeze; format is not PCM; idle between sentences is not final idle',()=>{
  const h=harness(),t=h.tracker,id=t.start({conversationId:'chat'});
  t.timing(event(id,'japaneseReady',150));t.timing(event(id,'audioBusy',151));t.timing(event(id,'ttsRequest',160));
  t.timing(event(id,'format',170));assert.equal(t.snapshot().marks.firstPcmAt,null);
  t.timing(event(id,'firstPcm',180));t.timing(event(id,'audioScheduled',181,1,{scheduledContextTime:2,contextTimeAtSchedule:1.94,baseLatencySeconds:.01}));
  t.timing(event(id,'playbackObserved',245));t.timing(event(id,'ttsDone',300,1,{serverMetrics:{queueMs:12,firstAudioMs:50,completeMs:130,text:'not diagnostic data',invalid:Infinity}}));t.timing(event(id,'audioIdle',400));
  assert.equal(t.snapshot().marks.audioIdleAt,null);
  t.timing(event(id,'audioBusy',450));t.timing(event(id,'ttsRequest',451,2));t.timing(event(id,'firstPcm',480,2));t.timing(event(id,'playbackObserved',550,2));
  t.timing(event(id,'ttsDone',555,2,{serverMetrics:{queueMs:999,firstAudioMs:999,completeMs:999}}));
  h.set(560);t.observeTerminal(conversation('completed'),true);
  assert.equal(t.snapshot().status,'active');assert.equal(t.snapshot().marks.textCompleteAt,560);
  t.timing(event(id,'audioIdle',700));
  const out=t.snapshot();assert.equal(out.status,'completed');assert.equal(out.marks.audioIdleAt,700);assert.equal(out.marks.firstTtsRequestAt,160);assert.equal(out.marks.firstPlaybackObservedAt,245);
  assert.equal(out.audio.scheduledContextTime,2);assert.equal(out.durations.sendToFirstPlaybackObservedMs,145);
  assert.deepEqual(out.audio.serverMetrics,{queueMs:12,firstAudioMs:50,completeMs:130});
});

test('first-job server metrics keep only finite nonnegative numeric values',()=>{
  const h=harness(),t=h.tracker,id=t.start({conversationId:'chat'});
  t.timing(event(id,'ttsRequest',120));t.timing(event(id,'ttsDone',130,1,{serverMetrics:{queueMs:-1,firstAudioMs:Infinity,completeMs:'20',text:'private'}}));
  assert.deepEqual(t.snapshot().audio.serverMetrics,{});
  t.timing(event(id,'ttsDone',140,1,{serverMetrics:{queueMs:1}}));assert.deepEqual(t.snapshot().audio.serverMetrics,{});
});

test('audio can finish before text; text completion remains separate and missing speech is never zero',()=>{
  const h=harness(),t=h.tracker,id=t.start({conversationId:'chat'});
  t.timing(event(id,'japaneseReady',120));t.timing(event(id,'ttsRequest',130));t.timing(event(id,'audioIdle',200));
  h.set(300);t.observeTerminal(conversation('completed'),true);
  assert.equal(t.snapshot().marks.audioIdleAt,200);assert.equal(t.snapshot().marks.textCompleteAt,300);assert.equal(t.snapshot().status,'completed');
  t.start({conversationId:'chat',speechEnabled:false});h.set(400);t.observeTerminal(conversation('completed'),true);
  assert.equal(t.snapshot().status,'completed');assert.equal(t.snapshot().marks.firstPlaybackObservedAt,null);
  assert.equal(t.snapshot().durations.sendToFirstPlaybackObservedMs,null);
});

test('cancel preserves evidence, invalidates queued rAF and old callbacks, and cannot cancel the next send',()=>{
  const h=harness(),t=h.tracker,id=t.start({conversationId:'chat'});
  h.set(120);t.observeBody({conversationId:'chat',messageId:'fresh',role:'assistant',element:body()});
  t.cancel('conversation-switch');h.frame();h.frame();t.timing(event(id,'ttsRequest',150));
  assert.equal(t.snapshot().marks.firstBodyDomAt,120);assert.equal(t.snapshot().marks.firstVisibleFrameOpportunityAt,null);assert.equal(t.snapshot().cancelReason,'conversation-switch');
  const next=t.start({conversationId:'chat'});t.timing(event(id,'cancel',200,1,{reason:'new-turn'}));
  assert.equal(t.snapshot().clientTraceId,next);assert.equal(t.snapshot().status,'active');
});

test('hidden frame opportunity remains missing and may be observed on a later valid render',()=>{
  const h=harness(),t=h.tracker;t.start({conversationId:'chat'});const element=body();element.visible=false;
  const observe=()=>t.observeBody({conversationId:'chat',messageId:'fresh',role:'assistant',element});
  observe();h.frame();h.frame();assert.equal(t.snapshot().marks.firstVisibleFrameOpportunityAt,null);
  element.visible=true;h.set(200);observe();h.frame();h.frame();assert.equal(t.snapshot().marks.firstVisibleFrameOpportunityAt,200);
});
