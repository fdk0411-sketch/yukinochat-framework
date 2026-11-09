(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.YukinoAvatar = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Both the sprite renderer and a future Live2D renderer consume this small,
  // renderer-independent vocabulary. No model-generated URLs or CSS are used.
  const POSES = Object.freeze({ calm:'rest', smile:'explain', thinking:'think', concern:'lean', shy:'avert', serious:'folded', wry:'rest', surprise:'rest' });
  const WORKING = new Set(['starting','running','inprogress','in_progress','waiting','streaming']);
  const TERMINAL = new Set(['interrupted','cancelled','canceled','failed','error']);
  const assetPath = value => typeof value === 'string' && /^\/avatar-assets\/[a-zA-Z0-9_-]+\.(?:png|webp)$/.test(value) ? value : null;
  const validRegion = value => value && ['x','y','width','height'].every(key => Number.isFinite(value[key])) &&
    value.x >= 0 && value.y >= 0 && value.width > 0 && value.height > 0 &&
    value.x + value.width <= 1.001 && value.y + value.height <= 1.001;
  const copyRegion = value => ({ x:value.x, y:value.y, width:value.width, height:value.height });
  // A stored user choice overrides the OS preference; absence follows the OS.
  const motionEnabled = (choice, systemReduced) => choice === '1' ? true : choice === '0' ? false : !systemReduced;
  const normalizedAvatar = value => {
    const known = Object.hasOwn(POSES, value?.expression);
    const expression = known ? value.expression : 'calm';
    return { expression, pose:POSES[expression],
      intensity:known && value?.intensity === 'medium' ? 'medium' : 'low',
      gaze:known && ['down','aside'].includes(value?.gaze) ? value.gaze : 'forward',
      action:known && ['nod','tilt'].includes(value?.action) ? value.action : 'none' };
  };

  function validateManifest(input) {
    if (input?.version !== 1 || !assetPath(input.scene?.room)) throw new Error('形象素材清单暂不可用。');
    const width = Number(input.scene.width), height = Number(input.scene.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width > 16384 || height > 16384) throw new Error('形象画布尺寸无效。');
    const states = {};
    for (const expression of Object.keys(POSES)) {
      const state = input.states?.[expression];
      if (!assetPath(state?.base)) continue;
      const placement = state.placement;
      states[expression] = { pose:POSES[expression], base:state.base, blink:assetPath(state.blink), talk:assetPath(state.talk) };
      // Optional bounds are fractions of the room canvas, for cutout exports.
      // All three frames for a state must share these bounds.
      if (validRegion(placement)) states[expression].placement = copyRegion(placement);
      // Generated variants can drift outside the intended facial change. A
      // reviewed crop keeps the base body entirely stable while using only the
      // real image pixels inside the eye/mouth region, never drawn substitutes.
      const frameRegions = {};
      for (const key of ['blink','talk']) if (validRegion(state.frameRegions?.[key])) frameRegions[key] = copyRegion(state.frameRegions[key]);
      if (Object.keys(frameRegions).length) states[expression].frameRegions = frameRegions;
    }
    if (!states.calm) throw new Error('基础形象暂未准备好。');
    return { version:1, scene:{room:input.scene.room,width,height}, states };
  }

  function clipInsets(region, placement = {x:0,y:0,width:1,height:1}) {
    const clamp = value => Math.min(1,Math.max(0,value));
    const left = clamp((region.x - placement.x) / placement.width);
    const top = clamp((region.y - placement.y) / placement.height);
    const right = 1 - clamp((region.x + region.width - placement.x) / placement.width);
    const bottom = 1 - clamp((region.y + region.height - placement.y) / placement.height);
    return `inset(${[top,right,bottom,left].map(value => `${Number((value * 100).toFixed(5))}%`).join(' ')})`;
  }

  function visibleFrames(definition, frames, snapshot) {
    const blink = !!(snapshot.moving && snapshot.eyesClosed && frames.blink);
    const talk = !!(snapshot.moving && snapshot.speaking && snapshot.mouthOpen && frames.talk);
    if (definition.frameRegions) {
      // Patch mode never exposes an unreviewed full alternate frame. If a
      // single region is absent, that action stays on the neutral base pixels.
      return {base:true,blink:blink && !!definition.frameRegions.blink,talk:talk && !!definition.frameRegions.talk};
    }
    const frame = blink ? 'blink' : talk ? 'talk' : 'base';
    return {base:frame === 'base',blink:frame === 'blink',talk:frame === 'talk'};
  }

  class Controller {
    constructor(options = {}) {
      this.renderer = options.renderer || { render() {} };
      // Browser timer methods require a Window receiver. Keep native methods
      // behind wrappers so calling this.schedule() cannot bind them to us.
      this.schedule = options.setTimeout || ((callback, delay) => globalThis.setTimeout(callback, delay));
      this.cancel = options.clearTimeout || (handle => globalThis.clearTimeout(handle));
      this.dynamic = options.dynamic !== false;
      this.reducedMotion = !!options.reducedMotion;
      this.visible = options.visible !== false;
      this.connected = false;
      this.generation = 0;
      this.timers = new Set();
      this.blinkTimer = null; this.mouthTimer = null; this.mouthGeneration = 0;
      this.expression = 'calm';
      this.intensity = 'low'; this.gaze = 'forward'; this.action = 'none';
      // Renderers consume each actionSequence once. transientEpoch explicitly
      // invalidates local click reactions and short motions on lifecycle changes.
      this.actionSequence = 0; this.transientEpoch = 0;
      this.actionMessages = new Set();
      this.eyesClosed = false;
      this.mouthOpen = false;
      this.mouthLevel = 0;
      this.speaking = false;
      this.conversationId = null;
      this.awaiting = false;
      this.before = new Set();
      this.blockedTurn = null;
      this.blockedMessages = new Set();
      this.suspended = false;
      this.lastTurn = null;
      this.lastMessageIds = new Set();
      this.emit();
    }
    get moving() { return this.dynamic && !this.reducedMotion && this.visible && this.connected; }
    snapshot() { return { expression:this.expression, pose:POSES[this.expression],
      intensity:this.intensity, gaze:this.gaze, action:this.action,
      actionSequence:this.actionSequence, transientEpoch:this.transientEpoch,
      conversationId:this.conversationId, visible:this.visible, connected:this.connected,
      eyesClosed:this.eyesClosed, mouthOpen:this.mouthOpen,
      mouthLevel:this.speaking && this.moving ? this.mouthLevel : 0,
      speaking:this.speaking, moving:this.moving, idleMotionAllowed:!this.suspended, generation:this.generation }; }
    emit() { this.renderer.render(this.snapshot()); }
    later(callback, delay) {
      const generation = this.generation;
      const handle = this.schedule(() => { this.timers.delete(handle); if (generation === this.generation) callback(); }, delay);
      this.timers.add(handle);
      return handle;
    }
    resetFrames() {
      this.generation++;
      for (const handle of this.timers) this.cancel(handle);
      this.timers.clear(); this.eyesClosed = false; this.mouthOpen = false; this.mouthLevel = 0;
      this.blinkTimer = null; this.mouthTimer = null; this.mouthGeneration++;
    }
    resetMouth() {
      // Sentence transitions invalidate mouth callbacks without restarting the
      // independent blink cadence or interrupting a blink already closing.
      this.mouthGeneration++;
      if (this.mouthTimer !== null) { this.cancel(this.mouthTimer); this.timers.delete(this.mouthTimer); }
      this.mouthTimer = null; this.mouthOpen = false; this.mouthLevel = 0;
    }
    resetTransient() {
      this.transientEpoch++;
      this.action = 'none'; this.mouthLevel = 0;
    }
    restartMotion() {
      this.resetFrames();
      if (this.moving) {
        this.queueBlink();
        if (this.speaking) this.queueMouth();
      }
      this.emit();
    }
    queueBlink() {
      if (!this.moving || this.blinkTimer !== null) return;
      // Fixed cadence is intentionally reproducible; no random animation seed.
      this.blinkTimer = this.later(() => {
        this.eyesClosed = true; this.emit();
        this.blinkTimer = this.later(() => { this.blinkTimer = null; this.eyesClosed = false; this.emit(); this.queueBlink(); }, 145);
      }, 4600);
    }
    queueMouth() {
      if (!this.speaking || !this.moving || this.mouthTimer !== null) return;
      const generation = this.mouthGeneration;
      this.mouthTimer = this.later(() => {
        if (generation !== this.mouthGeneration) return;
        this.mouthTimer = null;
        if (!this.speaking || !this.moving) return;
        this.mouthOpen = !this.mouthOpen; this.emit(); this.queueMouth();
      }, this.mouthOpen ? 115 : 175);
    }
    setExpression(expression) {
      this.setPresentation({expression});
    }
    setPresentation(value, { messageId = null } = {}) {
      const next = normalizedAvatar(value);
      const changed = next.expression !== this.expression || next.intensity !== this.intensity || next.gaze !== this.gaze;
      const clearedAction = next.action === 'none' && this.action !== 'none';
      const freshAction = next.action !== 'none' && this.moving &&
        (messageId ? !this.actionMessages.has(messageId) : next.action !== this.action);
      if (messageId) this.actionMessages.add(messageId);
      this.expression = next.expression; this.intensity = next.intensity; this.gaze = next.gaze;
      if (freshAction) { this.action = next.action; this.actionSequence++; }
      else if (next.action === 'none') this.action = 'none';
      if (changed) {
        // Streaming expression changes do not restart blinking or discard the
        // measured mouth level. True lifecycle boundaries still reset both.
        if (this.moving) { this.queueBlink(); if (this.speaking) this.queueMouth(); }
        this.emit();
      }
      else if (freshAction || clearedAction) this.emit();
    }
    setDynamic(enabled) {
      if (this.dynamic === !!enabled) return;
      this.dynamic = !!enabled; if (!this.dynamic) this.resetTransient(); this.restartMotion();
    }
    setReducedMotion(enabled) {
      if (this.reducedMotion === !!enabled) return;
      this.reducedMotion = !!enabled; if (this.reducedMotion) this.resetTransient(); this.restartMotion();
    }
    setVisible(visible) {
      if (this.visible === !!visible) return;
      this.visible = !!visible; if (!this.visible) this.resetTransient(); this.restartMotion();
    }
    setConnected(connected) {
      if (this.connected === !!connected) return;
      this.connected = !!connected;
      if (!this.connected) { this.speaking = false; this.resetTransient(); }
      this.restartMotion();
    }
    setVoice(status) {
      const speaking = status?.kind === 'playing' && this.connected;
      if (speaking === this.speaking) return;
      this.speaking = speaking; this.resetMouth();
      if (this.speaking && this.moving) { this.queueBlink(); this.queueMouth(); }
      this.emit();
    }
    setVoiceLevel(level) {
      // Only measured samples during actual audible playback may open a model
      // mouth. Non-finite, stale and inactive samples resolve to closed.
      const next = this.speaking && this.moving && Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
      if (next === this.mouthLevel) return;
      this.mouthLevel = next; this.emit();
    }
    begin(conversation) {
      this.resetFrames(); this.resetTransient(); this.speaking = false;
      this.conversationId = conversation?.id || null;
      this.before = new Set((conversation?.messages || []).map(message => message.id));
      this.actionMessages = new Set(this.before);
      this.blockedTurn = null; this.blockedMessages.clear();
      this.suspended = false;
      this.awaiting = true; this.expression = 'thinking'; this.intensity = 'low'; this.gaze = 'forward'; this.restartMotion();
    }
    select(conversation) {
      this.resetFrames(); this.resetTransient(); this.speaking = false; this.awaiting = false;
      this.conversationId = conversation?.id || null;
      this.blockedTurn = null; this.blockedMessages.clear(); this.before.clear();
      this.suspended = false;
      this.lastTurn = conversation?.turnId || null;
      this.lastMessageIds = new Set((conversation?.messages || []).map(message => message.id));
      this.actionMessages = new Set(this.lastMessageIds);
      const last = [...(conversation?.messages || [])].reverse().find(message => message.role === 'assistant');
      const restored = normalizedAvatar(last?.avatar);
      this.expression = restored.expression; this.intensity = restored.intensity; this.gaze = restored.gaze;
      // Selection restores expression and gaze, never historical speech/actions.
      this.restartMotion();
    }
    observe(conversation, options = {}) {
      this.setConnected(options.connected === true);
      if ((conversation?.id || null) !== this.conversationId) this.select(conversation);
      if (!conversation) return;
      const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
      const turn = conversation.turnId || null;
      const newestAssistant = [...messages].reverse().find(message => message.role === 'assistant');
      this.lastTurn = turn || newestAssistant?.turnId || null;
      this.lastMessageIds = new Set(messages.map(message => message.id));
      const status = String(conversation.status || '').toLowerCase();
      if (TERMINAL.has(status) && !this.awaiting) { if (!this.suspended) this.stop(); return; }
      if (this.suspended) {
        const newestUser = messages.findLast(message => message.role === 'user');
        if (!newestUser || this.blockedMessages.has(newestUser.id)) return;
        this.suspended = false; this.blockedTurn = null; this.blockedMessages.clear();
      }
      const currentTurn = turn || newestAssistant?.turnId || null;
      if (this.blockedTurn && currentTurn === this.blockedTurn) return;
      if (newestAssistant && this.blockedMessages.has(newestAssistant.id)) return;
      const lastUserIndex = messages.findLastIndex(message => message.role === 'user');
      const reply = messages.slice(lastUserIndex + 1).findLast(message => message.role === 'assistant');
      const newReply = reply && (!this.awaiting || !this.before.has(reply.id));
      if (newReply && (reply.avatar || !WORKING.has(status))) {
        this.awaiting = false;
        this.setPresentation(reply.avatar, { messageId:reply.id });
      } else if ((WORKING.has(status) || this.awaiting) && !options.waitingApproval) this.setExpression('thinking');
      else if (options.waitingApproval) this.setExpression('calm');
    }
    stop() {
      this.blockedTurn = this.lastTurn;
      this.blockedMessages = new Set(this.lastMessageIds);
      this.suspended = true;
      this.awaiting = false; this.speaking = false;
      this.resetFrames(); this.resetTransient(); this.emit();
    }
    disconnect() { this.stop(); this.setConnected(false); }
    destroy() { this.resetFrames(); this.resetTransient(); this.connected = false; this.speaking = false; this.renderer.destroy?.(); }
  }

  class SpriteRenderer {
    constructor(stage, options = {}) {
      this.stage = stage;
      this.makeImage = options.createImage || (() => new Image());
      this.states = new Map(); this.manifest = null; this.current = null;
      this.pending = null; this.loaded = false;
    }
    async load(input) {
      const manifest = validateManifest(input);
      const loadImage = src => new Promise((resolve, reject) => {
        const image = this.makeImage();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('形象图片暂时无法加载。'));
        image.src = src;
      });
      const room = await loadImage(manifest.scene.room);
      const failures = [];
      for (const [expression, definition] of Object.entries(manifest.states)) {
        const frames = {};
        for (const key of ['base','blink','talk']) {
          if (!definition[key]) continue;
          try { frames[key] = await loadImage(definition[key]); }
          catch (error) { if (key === 'base' && expression === 'calm') throw error; failures.push(`${expression}.${key}`); }
        }
        if (frames.base) this.states.set(expression, {definition,frames});
      }
      this.manifest = manifest;
      this.stage.style.setProperty('--scene-ratio', String(manifest.scene.width / manifest.scene.height));
      this.stage.style.setProperty('--avatar-room-image', `url("${manifest.scene.room}")`);
      room.className = 'avatar-room'; room.alt = ''; room.draggable = false;
      const plane = document.createElement('div'); plane.className = 'avatar-plane';
      plane.append(room);
      const actor = document.createElement('div'); actor.className = 'avatar-actor';
      for (const [expression, state] of this.states) {
        const layer = document.createElement('div'); layer.className = 'avatar-state'; layer.dataset.expression = expression;
        const placement = state.definition.placement;
        if (placement) {
          layer.classList.add('avatar-placed');
          layer.style.left = `${placement.x * 100}%`; layer.style.top = `${placement.y * 100}%`;
          layer.style.width = `${placement.width * 100}%`; layer.style.height = `${placement.height * 100}%`;
        }
        for (const [key, image] of Object.entries(state.frames)) {
          image.className = 'avatar-frame'; image.alt = ''; image.draggable = false; image.hidden = key !== 'base';
          const region = state.definition.frameRegions?.[key];
          if (region) {
            image.classList.add('avatar-face-patch'); image.dataset.frame = key;
            image.style.clipPath = clipInsets(region, placement);
          }
          layer.append(image);
        }
        state.layer = layer; actor.append(layer);
      }
      plane.append(actor); this.stage.replaceChildren(plane); this.stage.hidden = false;
      this.stage.dataset.loadedStates = [...this.states.keys()].join(',');
      this.stage.dataset.frameFailures = failures.join(',');
      this.loaded = true;
      document.body.classList.add('avatar-ready');
      if (this.pending) this.render(this.pending);
      return { states:[...this.states.keys()], failures };
    }
    render(snapshot) {
      this.pending = snapshot;
      if (!this.loaded) return;
      const expression = this.states.has(snapshot.expression) ? snapshot.expression : 'calm';
      this.stage.dataset.expression = expression;
      this.stage.dataset.pose = POSES[expression];
      this.stage.dataset.speaking = String(snapshot.speaking);
      this.stage.classList.toggle('avatar-moving', snapshot.moving);
      for (const [key, state] of this.states) {
        state.layer.classList.toggle('is-current', key === expression);
        if (key !== expression) continue;
        const visible = visibleFrames(state.definition,state.frames,snapshot);
        this.stage.dataset.frame = ['blink','talk'].filter(kind => visible[kind]).join('+') || 'base';
        for (const [kind, image] of Object.entries(state.frames)) image.hidden = !visible[kind];
      }
      this.current = expression;
    }
    destroy() { this.stage.replaceChildren(); this.stage.hidden = true; this.loaded = false; }
  }

  return { POSES, normalizedAvatar, validateManifest, clipInsets, visibleFrames, motionEnabled, Controller, SpriteRenderer };
});
