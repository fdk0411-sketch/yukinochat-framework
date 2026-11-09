import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

// API contracts: https://github.com/RVC-Boss/GPT-SoVITS/blob/main/api_v2.py
// https://platform.moss.cn/docs/reference/speech/
// Local configuration selects a provider; browser input cannot choose an
// endpoint, model, voice ID, file path, language, credential, or shell command.
const BACKEND = 'http://127.0.0.1:9880';
const MOSS_BACKEND = 'https://api.mosi.cn';
const MOSS_MODELS = new Set(['moss-tts-1.5-flash', 'moss-tts-1.5-flash-2026-06-26']);
const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
const MAX_CONFIG_BYTES = 32 * 1024;
const DEFAULT_NAME = '雪乃 · 日语';
const MAX_SSE_FRAME_BYTES = 1024 * 1024;
const MAX_SSE_BYTES = Math.ceil(MAX_AUDIO_BYTES * 4 / 3) + 2 * 1024 * 1024;

export class VoiceServiceError extends Error {
  constructor(message, statusCode = 503, code = 'backend_unavailable') {
    super(message);
    this.name = 'VoiceServiceError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

const unavailable = () => new VoiceServiceError('语音服务尚未就绪，文字对话仍可继续。');
const cancelled = () => new VoiceServiceError('本次朗读已停止。', 499, 'cancelled');

function mossFailure(status) {
  // Never expose the upstream body: it may contain account or voice details.
  if (status === 401 || status === 403) return new VoiceServiceError('MOSS 语音认证失败，请检查服务端密钥。', status, 'moss_authentication_failed');
  if (status === 402) return new VoiceServiceError('MOSS 语音额度不足，文字对话仍可继续。', 402, 'moss_payment_required');
  if (status === 404) return new VoiceServiceError('MOSS 语音模型或音色不可用，请检查服务端配置。', 404, 'moss_not_found');
  if (status === 429) return new VoiceServiceError('MOSS 语音请求过于频繁，请稍后重听。', 429, 'moss_rate_limited');
  return new VoiceServiceError('本句 MOSS 语音合成失败，文字已保留，可以稍后重听。', 502, 'moss_synthesis_failed');
}

function validateText(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => key !== 'text') || typeof input.text !== 'string') {
    throw new VoiceServiceError('朗读请求只接受日语文本。', 400, 'invalid_text');
  }
  const text = input.text.trim();
  if (!text || [...text].length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    throw new VoiceServiceError('每段朗读需要 1–500 个字符。', 400, 'invalid_text');
  }
  return text;
}

// Validate real, bounded PCM/float WAV content; an HTTP 200 or audio MIME alone
// does not establish that the response is playable audio.
export function inspectWav(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44 || bytes.length > MAX_AUDIO_BYTES ||
      bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' ||
      bytes.readUInt32LE(4) + 8 !== bytes.length) throw new Error('Invalid WAV container');
  let format, dataBytes = 0, offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + length > bytes.length) throw new Error('Truncated WAV chunk');
    if (id === 'fmt ') {
      if (length < 16) throw new Error('Invalid WAV format');
      format = { encoding: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2),
        sampleRate: bytes.readUInt32LE(start + 4), byteRate: bytes.readUInt32LE(start + 8),
        blockAlign: bytes.readUInt16LE(start + 12), bits: bytes.readUInt16LE(start + 14) };
    }
    if (id === 'data') dataBytes += length;
    offset = start + length + (length % 2);
  }
  if (offset !== bytes.length || !format || ![1, 3].includes(format.encoding) ||
      ![1, 2].includes(format.channels) || format.sampleRate < 8000 || format.sampleRate > 192000 ||
      ![8, 16, 24, 32].includes(format.bits) || (format.encoding === 3 && format.bits !== 32) ||
      format.blockAlign !== format.channels * format.bits / 8 ||
      format.byteRate !== format.sampleRate * format.blockAlign ||
      !dataBytes || dataBytes % format.blockAlign !== 0) throw new Error('Unsupported WAV audio');
  const duration = dataBytes / format.byteRate;
  if (duration < 0.05 || duration > 180) throw new Error('Invalid WAV duration');
  return { duration, sampleRate: format.sampleRate, channels: format.channels };
}

// Playback-only gain for validated PCM16 WAVs. Preserve the original buffer,
// headers, channel balance, sample rate and duration; never modify the reference.
// Target -3 dBFS, cap gain at +24 dB. Peaks <= 32 PCM counts (~-60 dBFS) are
// treated as silence/noise and left alone. Already-loud audio is not attenuated.
// Other valid encodings and ambiguous chunk layouts pass through unchanged.
export function normalizeWavForPlayback(bytes) {
  inspectWav(bytes);
  let encoding, bits, blockAlign, formats = 0;
  const ranges = [];
  for (let offset = 12; offset < bytes.length;) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4), start = offset + 8;
    if (id === 'fmt ') {
      formats++;
      encoding = bytes.readUInt16LE(start);
      blockAlign = bytes.readUInt16LE(start + 12);
      bits = bytes.readUInt16LE(start + 14);
    }
    if (id === 'data') ranges.push({ start, end: start + length, length });
    offset = start + length + (length % 2);
  }
  if (formats !== 1 || encoding !== 1 || bits !== 16 ||
      ranges.some(range => range.length % blockAlign !== 0)) return bytes;
  let peak = 0;
  for (const { start, end } of ranges) {
    for (let offset = start; offset < end; offset += 2) peak = Math.max(peak, Math.abs(bytes.readInt16LE(offset)));
  }
  if (peak <= 32) return bytes;
  const targetPeak = Math.floor(32767 * 10 ** (-3 / 20));
  const gain = Math.min(10 ** (24 / 20), targetPeak / peak);
  if (gain <= 1) return bytes;
  const playback = Buffer.from(bytes);
  for (const { start, end } of ranges) {
    for (let offset = start; offset < end; offset += 2) {
      // The global peak-based gain leaves 3 dB headroom; clamp is a final guard.
      const sample = Math.round(bytes.readInt16LE(offset) * gain);
      playback.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), offset);
    }
  }
  return playback;
}

async function readBounded(response, limit) {
  const advertisedLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(advertisedLength) && advertisedLength > limit) {
    await response.body?.cancel();
    throw new VoiceServiceError('语音服务返回的数据过大。', 502, 'invalid_audio');
  }
  if (!response.body) throw new VoiceServiceError('语音服务没有返回音频。', 502, 'invalid_audio');
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new VoiceServiceError('语音服务返回的数据过大。', 502, 'invalid_audio');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, length);
}

const invalidStream = () => new VoiceServiceError('流式语音数据不完整或格式不受支持，请稍后重听。', 502, 'invalid_audio');

function localSentenceLines(text) {
  // Match the accepted prosody candidate: retain commas and complete terminal
  // punctuation/closing-quote runs. The lookahead prevents splitting "！？".
  return text.replace(/([。！？!?]+[」』”’"']*)(?=[^。！？!?\r\n」』”’"'])/gu, '$1\n');
}

const LOCAL_LETTER_NAMES = Object.freeze(['エー', 'ビー', 'シー', 'ディー', 'イー', 'エフ', 'ジー', 'エイチ',
  'アイ', 'ジェー', 'ケー', 'エル', 'エム', 'エヌ', 'オー', 'ピー', 'キュー', 'アール', 'エス', 'ティー',
  'ユー', 'ブイ', 'ダブリュー', 'エックス', 'ワイ', 'ゼット']);
function localSpokenLetters(text) {
  // Local Japanese G2P routes ASCII letters through an unavailable English
  // dependency. Spell isolated labels only; never split English words. Digits
  // remain intact (A1 -> エー1). Displayed replies and cloud input are untouched.
  return text.replace(/(?<![A-Za-z])([A-Za-z])(?![A-Za-z])/g,
    letter => LOCAL_LETTER_NAMES[letter.toUpperCase().charCodeAt(0) - 65]);
}

const LOCAL_LABEL_PATTERN = `(?:${[...LOCAL_LETTER_NAMES].sort((a, b) => b.length - a.length).join('|')})[0-9０-９]*`;
const LOCAL_LABEL_ARROW = new RegExp(`(?<![A-Za-z0-9_ァ-ヺー])(${LOCAL_LABEL_PATTERN})([ \\t]*)→([ \\t]*)(?=${LOCAL_LABEL_PATTERN}(?![A-Za-z0-9_ァ-ヺー]))`, 'gu');
function localSpokenRelations(text) {
  // Require numeric operands, not digits embedded in ASCII words/identifiers.
  // The right operand is a lookahead so chained sums retain every operation.
  const numbers = text.replace(/(?<![A-Za-z0-9_.])([0-9０-９]+(?:[.．][0-9０-９]+)?)([ \t]*)([+＋=＝])([ \t]*)(?=[0-9０-９]+(?:[.．][0-9０-９]+)?(?![A-Za-z0-9_.]))/gu,
    (_match, number, before, operator, after) => `${number}${before}${operator === '+' || operator === '＋' ? 'たす' : 'イコール'}${after}`);
  return localSpokenLetters(numbers).replace(LOCAL_LABEL_ARROW, '$1$2から$3');
}
function localSpokenText(text) {
  // URL and inline-code spelling is outside this narrow reading rule. Protect
  // those spans before both letter spelling and mathematical relation mapping.
  const protectedSpans = /(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>"'「」『』]+|`[^`\r\n]*`/gu;
  let result = '', position = 0;
  for (const match of text.matchAll(protectedSpans)) {
    result += localSentenceLines(localSpokenRelations(text.slice(position, match.index))) + match[0];
    position = match.index + match[0].length;
  }
  return result + localSentenceLines(localSpokenRelations(text.slice(position)));
}

export function localTtsPayload(config, text, { streaming = false } = {}) {
  // Sentence-level prosody accepted in the cut0 audition; warmup uses this too.
  return { text: localSpokenText(text), text_lang: 'ja', prompt_lang: 'ja', ref_audio_path: config.referenceAudio,
    prompt_text: config.promptText, aux_ref_audio_paths: [], text_split_method: 'cut0', batch_size: 1,
    media_type: streaming ? 'raw' : 'wav', streaming_mode: streaming ? 2 : false,
    seed: 42, parallel_infer: false, split_bucket: false, fragment_interval: 0.0,
    speed_factor: 1.0, top_k: 15, top_p: 1.0, temperature: 1.0, repetition_penalty: 1.35,
    use_cuda_graph: false, use_flash_attention: false, gpt_streaming: false,
    min_chunk_length: 16, overlap_length: 2, super_sampling: false };
}

function localFormat(value) {
  // Raw PCM carries no format header. Accept only the independently verified
  // v2ProPlus contract from runtime warmup or a trusted local configuration.
  if (!value || value.sampleRate !== 32000 || value.channels !== 1 ||
      value.bitsPerSample !== 16 || value.encoding !== 'pcm_s16le') throw invalidStream();
  return { sampleRate: 32000, channels: 1, bitsPerSample: 16, encoding: 'pcm_s16le' };
}

function abortable(work, signal) {
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(cancelled());
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(work).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

// SSE is a framing protocol, not one JSON object per network chunk. This parser
// accepts UTF-8/CRLF boundaries split at arbitrary byte positions and limits both
// the total transport size and an individual event before JSON parsing.
async function* mossSseEvents(response, signal) {
  if (!response.body) throw invalidStream();
  const advertised = Number(response.headers.get('content-length'));
  if (Number.isFinite(advertised) && advertised > MAX_SSE_BYTES) {
    await response.body.cancel(); throw invalidStream();
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '', size = 0, count = 0;
  function parse(frame) {
    if (Buffer.byteLength(frame) > MAX_SSE_FRAME_BYTES) throw invalidStream();
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return null; // Heartbeats and SSE routing fields carry no audio.
    if (++count > 10000) throw invalidStream();
    let event;
    try { event = JSON.parse(data); } catch { throw invalidStream(); }
    if (!event || Array.isArray(event) || typeof event !== 'object' || typeof event.type !== 'string') throw invalidStream();
    return event;
  }
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SSE_BYTES) throw invalidStream();
      try { pending += decoder.decode(value, { stream: true }); } catch { throw invalidStream(); }
      let separator;
      while ((separator = /\r?\n\r?\n/.exec(pending))) {
        const event = parse(pending.slice(0, separator.index));
        pending = pending.slice(separator.index + separator[0].length);
        if (event) yield event;
      }
      if (Buffer.byteLength(pending) > MAX_SSE_FRAME_BYTES) throw invalidStream();
    }
    try { pending += decoder.decode(); } catch { throw invalidStream(); }
    if (pending.trim()) { const event = parse(pending); if (event) yield event; }
  } finally {
    // Also runs when the consumer rejects an event or downstream playback stops.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createVoiceService({ configPath, fetchImpl = globalThis.fetch,
  requestTimeoutMs = 100000, probeTimeoutMs = 1800,
  getMossApiKey = () => process.env.MOSS_API_KEY, localRuntime } = {}) {
  if (!configPath || !path.isAbsolute(configPath)) throw new Error('An absolute voice config path is required');
  let active = false, lastSuccess = null, generation = 0, selectedProvider = 'gpt-sovits';
  let switchTail = Promise.resolve();
  const requests = new Set();
  const queue = [];

  async function readConfigurationFile() {
    let data, raw;
    try {
      const file = await fs.stat(configPath);
      if (!file.isFile() || file.size > MAX_CONFIG_BYTES) throw new Error('Invalid config file');
      raw = await fs.readFile(configPath, 'utf8');
      data = JSON.parse(raw.replace(/^\uFEFF/u, ''));
    } catch (error) {
      if (error.code === 'ENOENT') throw new VoiceServiceError('角色声音还在准备中。', 503, 'not_configured');
      throw new VoiceServiceError('角色声音配置需要检查。', 503, 'invalid_configuration');
    }
    if (!data || Array.isArray(data) || typeof data !== 'object') {
      throw new VoiceServiceError('角色声音配置需要检查。', 503, 'invalid_configuration');
    }
    return { data, raw };
  }

  async function configuration() {
    const { data, raw } = await readConfigurationFile();
    const provider = data.provider === undefined ? 'gpt-sovits' : data.provider;
    if (['gpt-sovits', 'moss'].includes(provider)) selectedProvider = provider;
    if (data?.enabled === false) throw new VoiceServiceError('角色声音尚未启用。', 503, 'not_configured');
    if (!data || Array.isArray(data) || data.version !== 1 || data.enabled !== true ||
        typeof data.voiceId !== 'string' || !/^[a-z0-9_-]{1,64}$/u.test(data.voiceId) ||
        typeof data.name !== 'string' || !data.name.trim() || data.name.length > 80) {
      throw new VoiceServiceError('角色声音配置需要检查。', 503, 'invalid_configuration');
    }
    if (!['gpt-sovits', 'moss'].includes(provider)) {
      throw new VoiceServiceError('角色声音配置需要检查。', 503, 'invalid_configuration');
    }
    if (provider === 'moss') {
      if (!data.moss || Array.isArray(data.moss) ||
          typeof data.moss.voiceId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(data.moss.voiceId) ||
          !MOSS_MODELS.has(data.moss.model)) {
        throw new VoiceServiceError('MOSS 角色声音配置需要检查。', 503, 'invalid_configuration');
      }
      let apiKey;
      try { apiKey = getMossApiKey(); } catch { /* A getter error must not disclose its message. */ }
      if (typeof apiKey !== 'string' || !/^[\x21-\x7e]{1,8192}$/u.test(apiKey.trim())) {
        throw new VoiceServiceError('MOSS 服务端密钥尚未配置。', 503, 'moss_key_missing');
      }
      apiKey = apiKey.trim();
      // Credential changes invalidate verification. Neither digest nor key is
      // persisted, returned to the browser, or included in an error/log message.
      const keyFingerprint = createHash('sha256').update(apiKey).digest('hex');
      const fingerprint = createHash('sha256').update(JSON.stringify({ provider, model: data.moss.model,
        voice: data.moss.voiceId, raw, keyFingerprint })).digest('hex');
      return { provider, voiceId: data.voiceId, name: data.name.trim(),
        moss: { voiceId: data.moss.voiceId, model: data.moss.model }, apiKey, fingerprint };
    }
    if (typeof data.referenceAudio !== 'string' || !path.isAbsolute(data.referenceAudio) ||
        path.extname(data.referenceAudio).toLowerCase() !== '.wav' ||
        typeof data.promptText !== 'string' || !data.promptText.trim() || data.promptText.length > 4000) {
      throw new VoiceServiceError('角色声音配置需要检查。', 503, 'invalid_configuration');
    }
    let reference;
    try {
      const file = await fs.stat(data.referenceAudio);
      if (!file.isFile() || file.size > MAX_AUDIO_BYTES) throw new Error('Invalid reference file');
      reference = await fs.readFile(data.referenceAudio);
      const { duration } = inspectWav(reference);
      if (duration < 3 || duration > 10) throw new Error('Reference must be 3–10 seconds');
    } catch {
      throw new VoiceServiceError('参考音频尚未准备好，请检查 3–10 秒的 WAV 片段。', 503, 'reference_unavailable');
    }
    // A changed configuration or reference invalidates a previous successful synthesis.
    const fingerprint = createHash('sha256').update(provider).update(raw).update(reference).digest('hex');
    return { ...data, provider, name: data.name.trim(), promptText: data.promptText.trim(), fingerprint };
  }

  function setProvider(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).length !== 1 || !Object.hasOwn(input, 'provider') ||
        !['gpt-sovits', 'moss'].includes(input.provider)) {
      return Promise.reject(new VoiceServiceError('请选择本地声音或 MOSS 声音。', 400, 'invalid_provider'));
    }
    const provider = input.provider;
    // Invalidate immediately, including requests queued before this write starts.
    generation++;
    lastSuccess = null;
    for (const controller of requests) controller.abort();
    const operation = switchTail.then(async () => {
      let temporary;
      try {
        const { data } = await readConfigurationFile();
        if (data.version !== 1 || typeof data.enabled !== 'boolean') {
          throw new VoiceServiceError('角色声音配置需要检查。', 503, 'invalid_configuration');
        }
        if (data.provider !== provider) {
          temporary = `${configPath}.${randomUUID()}.tmp`;
          const file = await fs.open(temporary, 'wx', 0o600);
          try { await file.writeFile(`${JSON.stringify({ ...data, provider }, null, 2)}\n`, 'utf8'); await file.sync(); }
          finally { await file.close(); }
          await fs.rename(temporary, configPath);
          temporary = null;
        }
        selectedProvider = provider;
        return { provider };
      } catch (error) {
        if (error instanceof VoiceServiceError) throw error;
        throw new VoiceServiceError('声音选择未能保存，请稍后重试。', 500, 'configuration_write_failed');
      } finally { if (temporary) await fs.unlink(temporary).catch(() => {}); }
    });
    // A failed write does not poison subsequent switches or syntheses.
    switchTail = operation.catch(() => {});
    return operation;
  }

  async function getStatus() {
    await switchTail;
    const statusGeneration = generation;
    let config;
    try { config = await configuration(); }
    catch (error) {
      if (statusGeneration !== generation) return getStatus();
      return { configured: false, available: false, name: DEFAULT_NAME, provider: selectedProvider,
        status: error.code || 'invalid_configuration', error: error.message, synthesisVerified: false,
        streaming: selectedProvider === 'moss' || Boolean(localRuntime) };
    }
    if (statusGeneration !== generation) return getStatus();
    // Verification means a valid audio response for this configuration, not
    // human approval of timbre, pronunciation or similarity to the character.
    let supportsLocalStream = Boolean(localRuntime);
    if (!supportsLocalStream && config.localStreamFormat) {
      try { localFormat(config.localStreamFormat); supportsLocalStream = true; } catch { /* invalid config is not streaming-capable */ }
    }
    const base = { configured: true, name: config.name, provider: config.provider,
      streaming: config.provider === 'moss' || supportsLocalStream,
      synthesisVerified: lastSuccess?.fingerprint === config.fingerprint,
      lastSynthesisAt: lastSuccess?.fingerprint === config.fingerprint ? lastSuccess.at : null };
    const controller = new AbortController();
    requests.add(controller);
    const timer = setTimeout(() => controller.abort(), probeTimeoutMs);
    try {
      const moss = config.provider === 'moss';
      if (!moss && localRuntime) {
        const state = await abortable(localRuntime.getStatus(config), controller.signal);
        if (statusGeneration !== generation) return getStatus();
        if (state.available) localFormat(state.format);
        return { ...base, available: state.available === true,
          status: typeof state.status === 'string' ? state.status : 'backend_unavailable',
          ...(!state.available && state.error ? { error: state.error } : {}) };
      }
      const response = await abortable(fetchImpl(moss ? `${MOSS_BACKEND}/v1/models` : `${BACKEND}/openapi.json`, {
        method: 'GET', ...(moss ? { headers: { Authorization: `Bearer ${config.apiKey}` } } : {}),
        signal: controller.signal, redirect: 'error', cache: 'no-store' }), controller.signal);
      if (!response.ok || !(response.headers.get('content-type') || '').includes('application/json')) {
        await response.body?.cancel();
        throw moss && !response.ok ? mossFailure(response.status) : unavailable();
      }
      const schema = JSON.parse((await abortable(readBounded(response, 1024 * 1024), controller.signal)).toString('utf8'));
      if (moss) {
        if (!Array.isArray(schema?.data)) throw unavailable();
        if (!schema.data.some(model => model?.id === config.moss.model)) {
          throw new VoiceServiceError('当前 MOSS 密钥不可使用配置的语音模型。', 503, 'moss_model_unavailable');
        }
      } else if (!schema?.paths?.['/tts']?.post) throw unavailable();
      // "available" only means the provider/model can be tried. In particular,
      // GET /models does not verify the configured voice ID or run inference.
      if (statusGeneration !== generation) return getStatus();
      return { ...base, available: true, status: 'ready' };
    } catch (error) {
      if (statusGeneration !== generation) return getStatus();
      const failure = error instanceof VoiceServiceError && error.code !== 'cancelled' ? error : unavailable();
      return { ...base, available: false, status: failure.code, error: failure.message };
    } finally { clearTimeout(timer); requests.delete(controller); }
  }

  function release() {
    active = false;
    while (queue.length) {
      const next = queue.shift();
      next.signal.removeEventListener('abort', next.onAbort);
      if (next.signal.aborted) { next.reject(cancelled()); continue; }
      active = true;
      next.resolve(release);
      break;
    }
  }

  function acquire(signal) {
    if (signal.aborted) return Promise.reject(cancelled());
    if (!active) { active = true; return Promise.resolve(release); }
    if (queue.length >= 2) return Promise.reject(new VoiceServiceError('朗读队列暂时已满，请稍后重听。', 429, 'queue_full'));
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal, onAbort: null };
      entry.onAbort = () => { const index = queue.indexOf(entry); if (index >= 0) queue.splice(index, 1); reject(cancelled()); };
      signal.addEventListener('abort', entry.onAbort, { once: true });
      queue.push(entry);
    });
  }

  async function synthesize(input, { signal: callerSignal } = {}) {
    const text = validateText(input);
    const controller = new AbortController();
    const requestGeneration = generation;
    let timedOut = false, unlock;
    const onAbort = () => controller.abort();
    if (callerSignal?.aborted) throw cancelled();
    requests.add(controller);
    callerSignal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, requestTimeoutMs);
    try {
      await abortable(switchTail, controller.signal);
      if (requestGeneration !== generation) throw cancelled();
      unlock = await acquire(controller.signal);
      if (controller.signal.aborted) throw cancelled();
      const config = await configuration();
      if (controller.signal.aborted) throw cancelled();
      const moss = config.provider === 'moss';
      if (!moss && localRuntime) localFormat(await abortable(localRuntime.ensureReady(config), controller.signal));
      if (controller.signal.aborted || requestGeneration !== generation) throw cancelled();
      const payload = moss ? { model: config.moss.model, input: text, voice_id: config.moss.voiceId,
        language: 'Japanese', stream: false, response_format: 'wav', delivery_method: 'audio' }
        : localTtsPayload(config, text);
      const response = await abortable(fetchImpl(moss ? `${MOSS_BACKEND}/v1/audio/speech` : `${BACKEND}/tts`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(moss ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
        signal: controller.signal, redirect: 'error', body: JSON.stringify(payload) }), controller.signal);
      if (!response.ok) {
        await response.body?.cancel();
        // Upstream error text may contain paths or a reference transcript. Do not expose it.
        if (moss) throw mossFailure(response.status);
        throw new VoiceServiceError('本句语音合成失败，文字已保留，可以稍后重听。', 502, 'synthesis_failed');
      }
      const mediaType = (response.headers.get('content-type') || '').split(';', 1)[0].toLowerCase();
      if (!['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'].includes(mediaType)) {
        await response.body?.cancel();
        throw new VoiceServiceError('语音服务返回的内容不是 WAV 音频。', 502, 'invalid_audio');
      }
      const bytes = await abortable(readBounded(response, MAX_AUDIO_BYTES), controller.signal);
      let playback;
      try { playback = normalizeWavForPlayback(bytes); }
      catch { throw new VoiceServiceError('语音数据不完整，请稍后重听。', 502, 'invalid_audio'); }
      if (controller.signal.aborted || requestGeneration !== generation) throw cancelled();
      lastSuccess = { fingerprint: config.fingerprint, at: new Date().toISOString() };
      return playback;
    } catch (error) {
      if (timedOut) throw new VoiceServiceError('本句语音等待超时，文字对话仍可继续。', 504, 'timeout');
      if (callerSignal?.aborted || controller.signal.aborted) throw cancelled();
      if (error instanceof VoiceServiceError) throw error;
      throw unavailable();
    } finally {
      clearTimeout(timer);
      requests.delete(controller);
      callerSignal?.removeEventListener('abort', onAbort);
      // Local or cloud synthesis may finish after an HTTP abort. This cancels
      // our wait; it does not promise to cancel model computation or cloud charges.
      // Never automatically retry a cloud synthesis or fall back to another voice.
      unlock?.();
    }
  }

  /**
   * Same fixed provider/voice and queue as WAV synthesis, but forward validated
   * PCM frames without whole-file normalization. DSP belongs to the player.
   * onEvent is awaited so a slow browser exerts backpressure; its signal also
   * covers the total timeout while waiting for downstream writes.
   */
  async function synthesizeStream(input, { signal: callerSignal, onEvent } = {}) {
    const text = validateText(input);
    if (typeof onEvent !== 'function') throw new Error('A stream event consumer is required');
    const started = performance.now();
    const elapsed = () => Math.round((performance.now() - started) * 1000) / 1000;
    const controller = new AbortController();
    const requestGeneration = generation;
    let timedOut = false, unlock, queueMs = 0, firstAudioMs = null;
    const onAbort = () => controller.abort();
    if (callerSignal?.aborted) throw cancelled();
    requests.add(controller);
    callerSignal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, requestTimeoutMs);
    const emit = async event => {
      if (controller.signal.aborted || requestGeneration !== generation) throw cancelled();
      await abortable(onEvent(event, { signal: controller.signal }), controller.signal);
      if (controller.signal.aborted || requestGeneration !== generation) throw cancelled();
    };
    try {
      await abortable(switchTail, controller.signal);
      if (requestGeneration !== generation) throw cancelled();
      unlock = await acquire(controller.signal); queueMs = elapsed();
      if (controller.signal.aborted) throw cancelled();
      const config = await configuration();
      if (controller.signal.aborted) throw cancelled();
      const moss = config.provider === 'moss';
      let format = null, done = false, bytesReceived = 0, carry = Buffer.alloc(0);
      let firstLocalChunks = [], firstLocalBytes = 0, firstLocalEmitted = false;
      if (!moss) {
        if (!localRuntime && !config.localStreamFormat) {
          throw new VoiceServiceError('本地音频格式尚未验证，请先检查声音。', 409, 'streaming_unavailable');
        }
        format = { type: 'format', ...localFormat(localRuntime
          ? await abortable(localRuntime.ensureReady(config), controller.signal) : config.localStreamFormat) };
      }
      if (controller.signal.aborted || requestGeneration !== generation) throw cancelled();
      const response = await abortable(fetchImpl(moss ? `${MOSS_BACKEND}/v1/audio/speech` : `${BACKEND}/tts`, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: moss ? 'text/event-stream' : 'audio/raw',
          ...(moss ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
        body: JSON.stringify(moss ? { model: config.moss.model, input: text, voice_id: config.moss.voiceId,
          language: 'Japanese', stream: true, response_format: 'pcm', stream_format: 'sse' }
          : localTtsPayload(config, text, { streaming: true })),
      }), controller.signal);
      if (!response.ok) {
        await response.body?.cancel();
        throw moss ? mossFailure(response.status)
          : new VoiceServiceError('本句本地语音合成失败，文字已保留。', 502, 'synthesis_failed');
      }
      if ((response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase() !== (moss ? 'text/event-stream' : 'audio/raw')) {
        await response.body?.cancel(); throw invalidStream();
      }
      const publishAudio = async chunk => {
        firstAudioMs ??= elapsed();
        await emit({ type: 'audio', audio: chunk.toString('base64') });
      };
      const audioChunk = async chunk => {
        bytesReceived += chunk.length;
        const blockAlign = format.channels * 2;
        if (bytesReceived > MAX_AUDIO_BYTES || bytesReceived / (format.sampleRate * blockAlign) > 180) throw invalidStream();
        const joined = carry.length ? Buffer.concat([carry, chunk]) : chunk;
        const alignedLength = joined.length - joined.length % blockAlign;
        carry = Buffer.from(joined.subarray(alignedLength));
        if (alignedLength) {
          const aligned = joined.subarray(0, alignedLength);
          if (!moss && !firstLocalEmitted) {
            // TCP boundaries are unrelated to acoustic phrases. A fixed first
            // 0.4 s window makes the player's one-time gain estimate independent
            // of arbitrary raw-network fragmentation; PCM itself is unchanged.
            firstLocalChunks.push(aligned); firstLocalBytes += aligned.length;
            if (firstLocalBytes < 25600) return;
            const first = Buffer.concat(firstLocalChunks, firstLocalBytes);
            firstLocalChunks = []; firstLocalBytes = 0; firstLocalEmitted = true;
            await publishAudio(first.subarray(0, 25600));
            if (first.length > 25600) await publishAudio(first.subarray(25600));
          } else await publishAudio(aligned);
        }
      };
      const validateEnd = () => {
        if (!format || carry.length || bytesReceived / (format.sampleRate * format.channels * 2) < 0.05) throw invalidStream();
      };
      if (!moss) {
        const lengthHeader = response.headers.get('content-length');
        const advertised = lengthHeader === null ? null : Number(lengthHeader);
        if (!response.body || (advertised !== null && (!Number.isSafeInteger(advertised) || advertised < 1 ||
            advertised > MAX_AUDIO_BYTES || advertised % 2 || advertised / 64000 > 180))) {
          await response.body?.cancel(); throw invalidStream();
        }
        await emit(format);
        const reader = response.body.getReader();
        try {
          for (;;) {
            const item = await abortable(reader.read(), controller.signal);
            if (item.done) break;
            if (item.value.byteLength) await audioChunk(Buffer.from(item.value));
          }
          if (advertised !== null && advertised !== bytesReceived) throw invalidStream();
          validateEnd();
          if (!firstLocalEmitted && firstLocalBytes) {
            // Short utterances are released only after a valid complete EOF.
            await publishAudio(Buffer.concat(firstLocalChunks, firstLocalBytes));
            firstLocalChunks = []; firstLocalBytes = 0; firstLocalEmitted = true;
          }
          done = true;
        } catch (error) {
          if (controller.signal.aborted) throw cancelled();
          if (error instanceof VoiceServiceError) throw error;
          throw invalidStream();
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        // Legacy raw HTTP has no application-level done marker. Normal EOF plus
        // framing/length checks cannot detect an upstream clean but semantic truncation.
      } else for await (const event of mossSseEvents(response, controller.signal)) {
        if (controller.signal.aborted) throw cancelled();
        if (event.type === 'error' || event.error || /(?:\.failed|\.error)$/.test(event.type)) {
          throw new VoiceServiceError('本句流式语音中断，文字已保留，可以稍后重听。', 502, 'moss_synthesis_failed');
        }
        if (event.type === 'speech.created') {
          if (format || done || event.format !== 'pcm' || !Number.isInteger(event.sample_rate) ||
              event.sample_rate < 8000 || event.sample_rate > 192000 ||
              ![1, 2].includes(event.channels) || event.bit_depth !== 16) throw invalidStream();
          // Cloud probe evidence: 48 kHz mono PCM16, with s16le waveform
          // inspection in evidence/voice-optimization-20261108/pcm-inspection.json.
          // The provider's current cloud metadata omits byte order. Its public
          // OpenMOSS local v1.5 example likewise calls its encoder pcm16le.
          // Explicit contradictory encoding metadata is rejected if introduced.
          if ((event.encoding && !['pcm_s16le', 's16le'].includes(event.encoding)) ||
              (event.endianness && event.endianness !== 'little') ||
              (event.byte_order && !['little', 'le'].includes(event.byte_order))) throw invalidStream();
          format = { type: 'format', sampleRate: event.sample_rate, channels: event.channels,
            bitsPerSample: 16, encoding: 'pcm_s16le' };
          await emit(format);
        } else if (event.type === 'speech.audio.delta') {
          if (!format || done || typeof event.audio !== 'string' || !event.audio.length ||
              event.audio.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(event.audio)) throw invalidStream();
          const chunk = Buffer.from(event.audio, 'base64');
          if (!chunk.length || chunk.toString('base64') !== event.audio) throw invalidStream();
          await audioChunk(chunk);
        } else if (event.type === 'speech.audio.done') {
          if (done) throw invalidStream();
          validateEnd();
          done = true;
        }
        // task.created, accounting and forward-compatible non-audio events are
        // consumed locally. No provider task/voice/account IDs reach the browser.
      }
      if (!done || !format || firstAudioMs === null || controller.signal.aborted) {
        if (controller.signal.aborted) throw cancelled();
        throw invalidStream();
      }
      const metrics = { queueMs, firstAudioMs, completeMs: elapsed() };
      await emit({ type: 'done', metrics });
      lastSuccess = { fingerprint: config.fingerprint, at: new Date().toISOString() };
      return metrics;
    } catch (error) {
      if (timedOut) throw new VoiceServiceError('本句语音等待超时，文字对话仍可继续。', 504, 'timeout');
      if (callerSignal?.aborted || controller.signal.aborted) throw cancelled();
      if (error instanceof VoiceServiceError) throw error;
      throw unavailable();
    } finally {
      clearTimeout(timer); callerSignal?.removeEventListener('abort', onAbort);
      requests.delete(controller);
      // Aborting local/cloud HTTP work cannot promise cancellation of billing.
      // Never automatically retry a partial stream or switch synthesis modes.
      unlock?.();
    }
  }

  return { getStatus, synthesize, synthesizeStream, setProvider };
}
