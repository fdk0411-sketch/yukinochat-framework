(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const elements = Object.fromEntries(['connection-status','connection-label','conversation-list','conversation-title','conversation-scroll','messages','empty-state','thinking','approval-panel','composer','message-input','composer-note','response-mode','response-mode-label','send-button','stop-button','new-conversation','error-banner','error-text','retry-button','dismiss-error','export-button','width-button','menu-button','sidebar-scrim','jump-bottom','toast'].map((id) => [id, $(id)]));
  let state = {ready:false, conversations:[], pendingRequests:[]};
  let selectedId = readSetting('yukino.selected') || null;
  let sending = false;
  let stopping = false;
  let connectionOpen = false;
  let apiError = '';
  let toastTimer;
  let stateFetch;
  let approvalSignature = '';
  let listSignature = '';
  let renderedConversationId = null;
  const messageNodes = new Map();
  const approvalDrafts = new Map();
  const drafts = new Map();
  const workingStatuses = new Set(['running','inprogress','in_progress','streaming','thinking','queued','starting','waiting','busy','pending']);
  const normalizeResponseMode=window.YukinoLatencyTools?.responseMode || (value=>value==='deep'?'deep':'daily');
  let responseMode=normalizeResponseMode(readSetting('yukino.response.mode'));
  let rawLatency=null,latencyFailed=false;
  try{if(window.YukinoLatencyTools?.LatencyTracker)rawLatency=new window.YukinoLatencyTools.LatencyTracker();else latencyFailed=true;}catch{latencyFailed=true;}
  // Optional diagnostics cannot prevent a send, render or speech operation.
  const latency=Object.fromEntries(['start','bind','mark','observeConversation','observeBody','observeTerminal','timing','cancel','snapshot','history'].map(method=>[method,(...args)=>{
    if(!rawLatency || (latencyFailed && !['snapshot','history'].includes(method)))return null;
    try{return rawLatency[method](...args);}catch{latencyFailed=true;try{rawLatency.cancel('diagnostics-error');}catch{}return null;}
  }]));
  Object.defineProperty(window,'YukinoLatency',{value:Object.freeze({snapshot:()=>latency.snapshot(),history:()=>latency.history() || []}),writable:false,configurable:false});
  const avatarMotionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  let avatarMotionChoice = readSetting('yukino.avatar.motion');
  const avatarRenderer = { render() {}, destroy() {} }; // Framework distribution has no character assets.
  const avatar = new window.YukinoAvatar.Controller({ renderer:avatarRenderer, visible:!document.hidden, dynamic:false });
  const voiceElements = Object.fromEntries(['voice-provider','voice-auto','voice-clarity','voice-preview','voice-replay','voice-resume','voice-stop','voice-refresh','voice-status'].map(id => [id, $(id)]));
  let voiceStatus = { available:false, busy:false, blocked:false, kind:'idle', status:'checking', enabled:readSetting('yukino.voice.auto') !== '0', clarityEnabled:readSetting('yukino.voice.clarity') !== '0' };
  const voice = new window.YukinoVoice.Controller({ enabled:voiceStatus.enabled, clarityEnabled:voiceStatus.clarityEnabled, visible:!document.hidden, onUpdate:updateVoiceStatus, onLevel:level=>avatar.setVoiceLevel(level), onTiming:event=>latency.timing(event) });
  const snapshotOrder = new window.YukinoVoice.SnapshotOrder();

  function readSetting(key) { try { return localStorage.getItem(key); } catch { return null; } }
  function saveSetting(key, value) { try { localStorage.setItem(key, value); } catch { /* Storage can be disabled. */ } }
  function node(tag, className, text) { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; }
  function currentConversation() { return state.conversations.find((item) => item.id === selectedId) || null; }
  function isWorking(conversation) { return Boolean(conversation && (conversation.turnId || workingStatuses.has(String(conversation.status || '').toLowerCase()))); }
  function nearBottom() { const el = elements['conversation-scroll']; return el.scrollHeight - el.scrollTop - el.clientHeight < 110; }
  function scrollToBottom() { const el = elements['conversation-scroll']; el.scrollTop = el.scrollHeight; elements['jump-bottom'].hidden = true; }
  function notify(message) { elements.toast.textContent = message; elements.toast.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => elements.toast.classList.remove('visible'), 3200); }
  function showError(message) { apiError = String(message || '连接出现问题，请稍后重试。'); renderStatus(); }

  function latestSpokenReply() {
    return [...(currentConversation()?.messages || [])].reverse().find(message => message.role === 'assistant' && window.YukinoVoice.extractPairs(message.text).length)?.text || '';
  }
  function updateVoiceStatus(next) {
    if (next) voiceStatus = next;
    avatar.setVoice(voiceStatus);
    voiceElements['voice-auto'].checked = voiceStatus.enabled;
    voiceElements['voice-clarity'].checked = voiceStatus.clarityEnabled !== false;
    voiceElements['voice-provider'].value = voiceStatus.pendingProvider || voiceStatus.provider || '';
    voiceElements['voice-provider'].disabled = !!voiceStatus.switching || !voiceStatus.provider;
    voiceElements['voice-provider'].setAttribute('aria-busy', String(!!voiceStatus.switching));
    voiceElements['voice-preview'].disabled = !voiceStatus.available || voiceStatus.switching;
    voiceElements['voice-replay'].disabled = !voiceStatus.available || voiceStatus.switching || !latestSpokenReply();
    voiceElements['voice-stop'].disabled = !voiceStatus.busy;
    voiceElements['voice-resume'].hidden = !voiceStatus.blocked;
    voiceElements['voice-refresh'].hidden = voiceStatus.available;
    voiceElements['voice-refresh'].disabled = !!voiceStatus.switching || !!voiceStatus.checking;
    const label = window.YukinoVoice.voiceStatusLabel(voiceStatus);
    voiceElements['voice-status'].textContent = label;
    voiceElements['voice-status'].title = voiceStatus.message || voiceStatus.error || voiceStatus.name || label;
    // Local diagnostics contain durations only, never reply text or credentials.
    const metrics = voiceStatus.metrics || {};
    for (const key of ['firstAudioMs','playbackStartMs','completeMs','textToPlaybackMs']) {
      if (Number.isFinite(metrics[key])) voiceElements['voice-status'].dataset[key] = String(Math.round(metrics[key]));
      else delete voiceElements['voice-status'].dataset[key];
    }
    if (metrics.transport === 'pcm-stream' || metrics.transport === 'wav') voiceElements['voice-status'].dataset.transport = metrics.transport;
    else delete voiceElements['voice-status'].dataset.transport;
  }

  async function api(path, body, traceId=null) {
    const options = {credentials:'same-origin', cache:'no-store'};
    if (body !== undefined) { options.method = 'POST'; options.headers = {'Content-Type':'application/json','X-Yukino-Client':'1'}; options.body = JSON.stringify(body); }
    if(path==='/api/send' && traceId)latency.mark(traceId,'sendFetchAt');
    const response = await fetch(path, options);
    let data;
    try { data = await response.json(); } catch { throw new Error(`服务器返回了无法读取的响应（${response.status}）。`); }
    if (!response.ok || data.ok === false) throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || data.message || `请求失败（${response.status}）。`);
    return data;
  }

  async function fetchState() {
    if (stateFetch) return stateFetch;
    stateFetch = api('/api/state').then((next) => { applyState(next); }).catch((error) => { showError(error.message); }).finally(() => { stateFetch = null; });
    return stateFetch;
  }

  function applyState(next) {
    if (!next || typeof next !== 'object') return;
    const snapshotDecision = snapshotOrder.accept(next);
    if (!snapshotDecision.accepted) return;
    if (snapshotDecision.epochChanged) { latency.cancel('server-epoch');voice.handleVoiceChange(); avatar.disconnect(); }
    state = {...next, conversations:Array.isArray(next.conversations) ? next.conversations : [], pendingRequests:Array.isArray(next.pendingRequests) ? next.pendingRequests : []};
    if (!state.conversations.some((item) => item.id === selectedId)) { if(selectedId)latency.cancel('conversation-unavailable');voice.stop(); selectedId = state.activeConversationId || state.conversations[0]?.id || null; }
    if (selectedId) saveSetting('yukino.selected', selectedId);
    const acceptedTiming=latency.observeConversation(currentConversation(),state.turnTimings?.[selectedId]);
    render();
    avatar.observe(currentConversation(), { connected:connectionOpen && state.ready, waitingApproval:state.pendingRequests.some(request => request.conversationId === selectedId) });
    voice.observe(currentConversation());
    latency.observeTerminal(currentConversation(),acceptedTiming);
  }

  function renderStatus() {
    const ready = Boolean(state.ready);
    elements['connection-status'].className = 'connection-status' + (ready && connectionOpen ? ' ready' : (state.error || apiError ? ' error' : ''));
    elements['connection-label'].textContent = ready ? (connectionOpen ? '已连接 Codex' : '正在恢复连接') : (state.error ? '连接异常' : '正在连接 Codex');
    const conversation = currentConversation();
    const error = apiError || (typeof conversation?.error === 'string' ? conversation.error : conversation?.error?.message || '') || (typeof state.error === 'string' ? state.error : state.error?.message || '');
    elements['error-banner'].hidden = !error;
    elements['error-text'].textContent = error;
    const busy = isWorking(conversation);
    elements['send-button'].hidden = busy;
    elements['stop-button'].hidden = !busy;
    elements['stop-button'].disabled = stopping;
    elements['stop-button'].firstChild.textContent = stopping ? '正在停止 ' : '停止回应 ';
    elements['send-button'].disabled = !ready || sending || !elements['message-input'].value.trim();
    elements['response-mode-label'].hidden=state.replySettings?.enabled!==true;
    elements['response-mode'].value=responseMode;
    elements['response-mode'].disabled=sending || busy;
    elements['new-conversation'].disabled = !ready || sending;
    elements['export-button'].disabled = !currentConversation();
    const activity = typeof conversation?.activity === 'string' ? conversation.activity : conversation?.activity?.message;
    elements['composer-note'].textContent = busy ? (activity || '回应中 · 你可以先写下下一句话') : sending ? '正在递交……' : 'Enter 发送 · Shift + Enter 换行';
    elements['composer-note'].title = elements['composer-note'].textContent;
    updateVoiceStatus();
  }

  function renderConversations() {
    const signature = JSON.stringify([selectedId, state.conversations.map(({id,title,updatedAt,status,turnId}) => [id,title,updatedAt,status,turnId])]);
    if (signature === listSignature) return;
    listSignature = signature;
    const fragment = document.createDocumentFragment();
    if (!state.conversations.length) fragment.append(node('p','list-empty','新的对话会保存在这里。'));
    for (const conversation of [...state.conversations].sort((a,b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))) {
      const button = node('button','note-entry' + (conversation.id === selectedId ? ' active' : ''));
      button.type = 'button';
      button.setAttribute('aria-current', conversation.id === selectedId ? 'page' : 'false');
      const title = conversation.title || '新的手记';
      button.title = title;
      button.append(node('span','note-entry-title', title));
      const date = new Date(conversation.updatedAt);
      button.append(node('small','',isWorking(conversation) ? '正在回应……' : Number.isNaN(date.getTime()) ? '一页手记' : date.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})));
      button.addEventListener('click',() => selectConversation(conversation.id));
      fragment.append(button);
    }
    elements['conversation-list'].replaceChildren(fragment);
  }

  function selectConversation(id,{preserveLatency=false}={}) {
    if(!preserveLatency)latency.cancel('conversation-switch');
    voice.stop();
    drafts.set(selectedId, elements['message-input'].value);
    selectedId = id;
    avatar.select(currentConversation());
    saveSetting('yukino.selected', id);
    elements['message-input'].value = drafts.get(id) || '';
    autosizeInput();
    closeSidebar();
    render();
    scrollToBottom();
    elements['message-input'].focus();
    api('/api/select',{conversationId:id}).catch((error)=>showError(error.message));
  }

  async function copyText(text, button) {
    try {
      await navigator.clipboard.writeText(text);
      if (button) { const original = button.textContent; button.textContent = '已复制'; setTimeout(() => { if (button.isConnected) button.textContent = original; },1800); }
      else notify('已复制');
    } catch { notify('无法访问剪贴板，请选中文字后复制。'); }
  }

  // Model text is always inserted as text nodes; Markdown only creates known elements.
  function inlineMarkdown(parent, text) {
    const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|\[[^\]\n]+\]\([^\s)]+\))/g;
    let match;
    let position = 0;
    while ((match = pattern.exec(text))) {
      parent.append(document.createTextNode(text.slice(position,match.index)));
      const token = match[0];
      if (token.startsWith('`')) parent.append(node('code','',token.slice(1,-1)));
      else if (token.startsWith('**') || token.startsWith('__')) parent.append(node('strong','',token.slice(2,-2)));
      else if (token.startsWith('*')) parent.append(node('em','',token.slice(1,-1)));
      else {
        const link = /^\[([^\]]+)\]\((.+)\)$/.exec(token);
        let url;
        try { url = new URL(link[2]); } catch { url = null; }
        if (url && ['https:','http:','mailto:'].includes(url.protocol)) { const anchor = node('a','',link[1]); anchor.href = url.href; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; parent.append(anchor); }
        else parent.append(document.createTextNode(token));
      }
      position = pattern.lastIndex;
    }
    parent.append(document.createTextNode(text.slice(position)));
  }

  function renderMarkdown(text) {
    const fragment = document.createDocumentFragment();
    const lines = String(text || '').replace(/\r\n?/g,'\n').split('\n');
    let index = 0;
    const special = (line) => /^\s*(```|~~~)|^#{1,6}\s|^\s*[-*+]\s|^\s*\d+[.)]\s|^>\s?|^\s*(?:---+|\*\*\*+)\s*$/.test(line);
    const tableCells = (line) => line.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map((cell) => cell.trim());
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) { index++; continue; }
      const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        const language = fence[2].trim().split(/\s/)[0].slice(0,40);
        const codeLines = [];
        index++;
        while (index < lines.length && !lines[index].trim().startsWith(fence[1])) codeLines.push(lines[index++]);
        if (index < lines.length) index++;
        const rawCode = codeLines.join('\n');
        const block = node('div','code-block');
        const bar = node('div','code-bar');
        const copy = node('button','', '复制代码'); copy.type = 'button'; copy.addEventListener('click',() => copyText(rawCode, copy));
        bar.append(node('span','',language || '代码'),copy);
        const pre = node('pre'); pre.append(node('code','',rawCode)); block.append(bar,pre); fragment.append(block); continue;
      }
      const heading = /^(#{1,6})\s+(.+)$/.exec(line);
      if (heading) { const el = node(`h${Math.min(4,heading[1].length+1)}`); inlineMarkdown(el,heading[2]); fragment.append(el); index++; continue; }
      if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) { fragment.append(node('hr')); index++; continue; }
      if (/^>\s?/.test(line)) { const quotes=[]; while(index<lines.length && /^>\s?/.test(lines[index])) quotes.push(lines[index++].replace(/^>\s?/,'')); const el=node('blockquote');inlineMarkdown(el,quotes.join('\n'));fragment.append(el);continue; }
      if (line.includes('|') && index+1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index+1])) {
        const wrap=node('div','table-wrap');const table=node('table');const head=node('thead');const row=node('tr');
        for(const cell of tableCells(line)){const th=node('th');inlineMarkdown(th,cell);row.append(th);}head.append(row);table.append(head);index+=2;
        const tbody=node('tbody');while(index<lines.length && lines[index].includes('|') && lines[index].trim()){const tr=node('tr');for(const cell of tableCells(lines[index++])){const td=node('td');inlineMarkdown(td,cell);tr.append(td);}tbody.append(tr);}table.append(tbody);wrap.append(table);fragment.append(wrap);continue;
      }
      const listMatch = /^(\s*)([-*+]|\d+[.)])\s+(.+)$/.exec(line);
      if (listMatch) {
        const ordered=/^\d/.test(listMatch[2]);const list=node(ordered?'ol':'ul');if(ordered)list.start=parseInt(listMatch[2],10);
        while(index<lines.length){const match=/^(\s*)([-*+]|\d+[.)])\s+(.+)$/.exec(lines[index]);if(!match || /^\d/.test(match[2])!==ordered)break;const li=node('li');inlineMarkdown(li,match[3]);list.append(li);index++;}fragment.append(list);continue;
      }
      const paragraph=[line];index++;
      while(index<lines.length && lines[index].trim() && !special(lines[index]) && !(lines[index].includes('|') && lines[index+1] && /^\s*\|?\s*:?-{3,}/.test(lines[index+1]))) paragraph.push(lines[index++]);
      const el=node('p');inlineMarkdown(el,paragraph.join('\n'));fragment.append(el);
    }
    return fragment;
  }

  function renderMessages() {
    const conversation=currentConversation();
    const changed=renderedConversationId!==selectedId;
    const stick=changed||nearBottom();
    if(changed){messageNodes.clear();elements.messages.replaceChildren();renderedConversationId=selectedId;}
    const messages=Array.isArray(conversation?.messages)?conversation.messages:[];
    const seen=new Set();
    messages.forEach((message,index)=>{
      const id=String(message.id || `${message.role}-${index}`);seen.add(id);
      let item=messageNodes.get(id);
      if(!item){
        const article=node('article','message paper');
        const label=node('div','name-tag');label.append(node('span','clip'));const name=node('span');label.append(name);
        const body=node('div','message-body');const actions=node('div','message-actions');const status=node('span','message-state');const copy=node('button','','复制');copy.type='button';copy.addEventListener('click',()=>copyText(item.text,copy));actions.append(status,copy);article.append(label,body,actions);
        item={article,name,body,status,copy,text:null,signature:null};messageNodes.set(id,item);
      }
      const text=String(message.text || '');const signature=JSON.stringify([text,message.role,message.status]);
      if(item.signature!==signature){
        const role=message.role || 'assistant';const status=String(message.status || '').toLowerCase();
        item.article.className='message paper '+(role==='user'?'user-message':role==='assistant'?'assistant-message':'system-message')+(workingStatuses.has(status)?' streaming':'');
        item.name.textContent=role==='user'?'你':role==='assistant'?'AI 助手':'系统记录';
        item.body.replaceChildren(role==='user'?node('p','',text):renderMarkdown(text));
        item.text=text;item.signature=signature;item.copy.disabled=!text;
        item.status.textContent=['interrupted','cancelled','canceled'].includes(status)?'已停止':['failed','error'].includes(status)?'回应中断':'';
      }
      if(elements.messages.children[index]!==item.article)elements.messages.insertBefore(item.article,elements.messages.children[index]||null);
      latency.observeBody({conversationId:conversation.id,messageId:message.id,role:message.role,element:item.body});
    });
    for(const [id,item] of messageNodes){if(!seen.has(id)){item.article.remove();messageNodes.delete(id);}}
    elements['empty-state'].hidden=messages.length>0;
    const last=messages[messages.length-1];
    elements.thinking.hidden=!isWorking(conversation)||(last?.role==='assistant' && Boolean(last.text));
    elements['conversation-title'].textContent=conversation?.title || '放学后的奉仕部';
    renderApprovals();
    if(stick)requestAnimationFrame(scrollToBottom);
    else elements['jump-bottom'].hidden=nearBottom();
  }

  function renderApprovals() {
    const requests=state.pendingRequests.filter((request)=>!request.conversationId || request.conversationId===selectedId);
    const signature=JSON.stringify(requests);
    if(signature===approvalSignature)return;
    approvalSignature=signature;
    elements['approval-panel'].hidden=!requests.length;
    const fragment=document.createDocumentFragment();
    for(const request of requests){
      const item=node('div','approval-item');
      item.append(node('h2','approval-title',request.kind==='question'?'想听听你的决定':'这一步需要你确认'));
      const question=typeof request.question==='string'?request.question:JSON.stringify(request.question||request.description||'是否允许继续这项操作？',null,2);
      item.append(node('p','approval-question',question));
      let input;
      if(request.kind==='question'){
        const options=node('div','approval-options');
        for(const option of (Array.isArray(request.options)?request.options:[])){
          const value=typeof option==='string'?option:String(option.label||option.value||option.title||'');
          if(!value)continue;
          const button=node('button','approval-option',value);button.type='button';button.addEventListener('click',()=>{input.value=value;approvalDrafts.set(request.id,value);});options.append(button);
        }
        if(options.childNodes.length)item.append(options);
        input=node('textarea','approval-answer');input.placeholder='写下你的回答……';input.setAttribute('aria-label','确认问题的回答');input.value=approvalDrafts.get(request.id)||'';input.addEventListener('input',()=>approvalDrafts.set(request.id,input.value));item.append(input);
      }
      const controls=node('div','approval-controls');
      for(const decision of ['accept','decline']){
        const button=node('button',decision==='decline'?'decline':'',decision==='accept'?(input?'提交回答':'允许这一次'):'拒绝');button.type='button';
        button.addEventListener('click',async()=>{
          if(input && decision==='accept' && !input.value.trim()){input.focus();notify('请先选择或填写回答。');return;}
          for(const child of controls.children)child.disabled=true;
          try{await api('/api/approval',{requestId:request.id,decision,...(input?{answer:input.value.trim()}:{})});approvalDrafts.delete(request.id);await fetchState();}
          catch(error){showError(error.message);for(const child of controls.children)child.disabled=false;}
        });controls.append(button);
      }
      item.append(controls);fragment.append(item);
    }
    elements['approval-panel'].replaceChildren(fragment);
  }

  function render(){renderConversations();renderMessages();renderStatus();}
  function autosizeInput(){const input=elements['message-input'];input.style.height='auto';input.style.height=Math.min(150,Math.max(53,input.scrollHeight))+'px';}

  async function createConversation({preserveLatency=false}={}){
    if(!preserveLatency)latency.cancel('new-conversation');
    voice.stop();
    avatar.stop();
    const result=await api('/api/conversations',{});
    await fetchState();
    if(!result.id)throw new Error('新对话未返回会话编号。');
    selectConversation(result.id,{preserveLatency});
    return result.id;
  }

  async function sendMessage(event){
    event?.preventDefault();
    const input=elements['message-input'];const text=input.value.trim();
    if(!text||sending||!state.ready||isWorking(currentConversation()))return;
    const mode=state.replySettings?.enabled===true?responseMode:'daily';
    const traceId=latency.start({conversationId:selectedId,messages:currentConversation()?.messages || [],mode,speechEnabled:voiceStatus.enabled,serverTimingRequired:!!state.turnTimings});
    voice.unlockPlayback();
    sending=true;apiError='';renderStatus();
    try{
      const conversationId=selectedId || await createConversation({preserveLatency:true});
      latency.bind(traceId,conversationId,currentConversation()?.messages || []);
      avatar.begin(currentConversation());
      voice.begin(currentConversation(),traceId?{clientTraceId:traceId,conversationId}:null);
      await api('/api/send',{conversationId,text,...(traceId?{clientTraceId:traceId}:{}),...(state.replySettings?.enabled===true?{responseMode:mode}:{})},traceId);
      latency.mark(traceId,'sendAckAt');
      drafts.delete(conversationId);
      if(selectedId===conversationId && input.value.trim()===text){input.value='';autosizeInput();}
      await fetchState();
      if(selectedId===conversationId)scrollToBottom();
    }catch(error){latency.cancel('send-error');voice.stop();avatar.stop();if(!input.value)input.value=text;autosizeInput();showError(error.message);}
    finally{sending=false;renderStatus();input.focus();}
  }

  elements.composer.addEventListener('submit',sendMessage);
  elements['response-mode'].addEventListener('change',()=>{if(sending || isWorking(currentConversation())){elements['response-mode'].value=responseMode;return;}responseMode=normalizeResponseMode(elements['response-mode'].value);saveSetting('yukino.response.mode',responseMode);});
  elements['message-input'].addEventListener('input',()=>{autosizeInput();drafts.set(selectedId,elements['message-input'].value);renderStatus();});
  elements['message-input'].addEventListener('keydown',(event)=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229){event.preventDefault();sendMessage();}});
  elements['new-conversation'].addEventListener('click',async()=>{if(sending)return; sending=true;renderStatus();try{await createConversation();}catch(error){showError(error.message);}finally{sending=false;renderStatus();}});
  elements['stop-button'].addEventListener('click',async()=>{if(!selectedId||stopping)return;latency.cancel('user-stop');voice.stop();avatar.stop();stopping=true;renderStatus();try{await api('/api/interrupt',{conversationId:selectedId});await fetchState();}catch(error){showError(error.message);}finally{stopping=false;renderStatus();}});
  elements['retry-button'].addEventListener('click',async()=>{apiError='';renderStatus();await fetchState();});
  elements['dismiss-error'].addEventListener('click',()=>{apiError='';elements['error-banner'].hidden=true;});
  elements['export-button'].addEventListener('click',()=>{const conversation=currentConversation();if(!conversation)return;const blob=new Blob([JSON.stringify({exportedAt:new Date().toISOString(),conversation},null,2)],{type:'application/json;charset=utf-8'});const url=URL.createObjectURL(blob);const anchor=node('a');anchor.href=url;anchor.download=(conversation.title||'奉仕部手记').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,70)+'.json';document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);notify('已导出当前手记。');});
  function setWidth(wide){document.body.classList.toggle('wide-reading',wide);elements['width-button'].setAttribute('aria-pressed',String(wide));elements['width-button'].textContent=wide?'恢复场景':'宽屏阅读';saveSetting('yukino.wide',wide?'1':'0');}
  elements['width-button'].addEventListener('click',()=>setWidth(!document.body.classList.contains('wide-reading')));
  function closeSidebar(){document.body.classList.remove('sidebar-open');$('sidebar').inert=true;elements['menu-button'].setAttribute('aria-expanded','false');elements['sidebar-scrim'].hidden=true;}
  elements['menu-button'].addEventListener('click',()=>{const open=!document.body.classList.contains('sidebar-open');document.body.classList.toggle('sidebar-open',open);$('sidebar').inert=!open;elements['menu-button'].setAttribute('aria-expanded',String(open));elements['sidebar-scrim'].hidden=!open;});
  elements['sidebar-scrim'].addEventListener('click',closeSidebar);
  document.addEventListener('keydown',(event)=>{if(event.key==='Escape')closeSidebar();});
  elements['conversation-scroll'].addEventListener('scroll',()=>{elements['jump-bottom'].hidden=nearBottom();},{passive:true});
  elements['jump-bottom'].addEventListener('click',scrollToBottom);
  document.addEventListener('visibilitychange',()=>{avatar.setVisible(!document.hidden);voice.setVisible(!document.hidden);if(!document.hidden)fetchState();});
  window.addEventListener('online',()=>{apiError='';voice.setConnected(true);fetchState();});
  window.addEventListener('offline',()=>{latency.cancel('offline');avatar.disconnect();voice.disconnect();showError('网络连接已断开，恢复连接后可继续。');});
  window.addEventListener('pagehide',()=>{latency.cancel('pagehide');voice.setVisible(false);voice.disconnect();avatar.disconnect();});
  window.addEventListener('pageshow',event=>{if(event.persisted){voice.setVisible(!document.hidden);voice.setConnected(true);fetchState();}});
  voiceElements['voice-provider'].addEventListener('change',()=>{void voice.setProvider(voiceElements['voice-provider'].value);});
  voiceElements['voice-auto'].addEventListener('change',()=>{saveSetting('yukino.voice.auto',voiceElements['voice-auto'].checked?'1':'0');voice.setEnabled(voiceElements['voice-auto'].checked);});
  voiceElements['voice-clarity'].addEventListener('change',()=>{const enabled=voiceElements['voice-clarity'].checked;saveSetting('yukino.voice.clarity',enabled?'1':'0');voice.setClarity(enabled);});
  voiceElements['voice-stop'].addEventListener('click',()=>voice.stop());
  voiceElements['voice-preview'].addEventListener('click',()=>{voice.unlockPlayback();voice.preview();});
  voiceElements['voice-replay'].addEventListener('click',()=>{voice.unlockPlayback();if(!voice.replay(latestSpokenReply()))notify('当前还没有可重听的日语回复。');});
  voiceElements['voice-resume'].addEventListener('click',()=>voice.resume());
  voiceElements['voice-refresh'].addEventListener('click',()=>voice.refreshAvailability());

  function updateAvatarToggle() {
    $('avatar-toggle').setAttribute('aria-pressed', String(avatar.dynamic));
    $('avatar-toggle').textContent = avatar.dynamic ? '动态形象' : '静态形象';
    $('avatar-stage').classList.toggle('avatar-motion-override', avatarMotionChoice === '1');
    $('avatar-toggle').title = !['0','1'].includes(avatarMotionChoice) && avatarMotionPreference.matches
      ? '当前跟随系统减少动态；点击可开启角色动作'
      : avatar.dynamic ? '已开启眨眼、说话与轻微呼吸动作；点击保持静止' : '点击开启眨眼、说话与轻微呼吸动作';
  }
  $('avatar-toggle').addEventListener('click',()=>{avatarMotionChoice=avatar.dynamic?'0':'1';saveSetting('yukino.avatar.motion',avatarMotionChoice);avatar.setDynamic(window.YukinoAvatar.motionEnabled(avatarMotionChoice,avatarMotionPreference.matches));updateAvatarToggle();});
  avatarMotionPreference.addEventListener('change',event=>{avatar.setDynamic(window.YukinoAvatar.motionEnabled(avatarMotionChoice,event.matches));updateAvatarToggle();});
  updateAvatarToggle();
  $('avatar-toggle').hidden = true;
  $('avatar-stage').hidden = true;

  setWidth(readSetting('yukino.wide')==='1');
  closeSidebar();
  render();
  fetchState();
  voice.refreshAvailability();
  const events=new EventSource('/api/events');
  events.addEventListener('open',()=>{connectionOpen=true;voice.setConnected(true);avatar.setConnected(state.ready);apiError='';renderStatus();fetchState();});
  events.addEventListener('message',(event)=>{try{const data=JSON.parse(event.data);if(data.type==='state')applyState(data.state);else if(data.type==='voice')void voice.handleVoiceChange();else if(data.type==='error')showError(data.message);}catch{showError('收到无法读取的状态信息，正在重新获取。');fetchState();}});
  events.addEventListener('error',()=>{latency.cancel('sse-disconnected');connectionOpen=false;voice.disconnect();avatar.disconnect();renderStatus();});
})();
