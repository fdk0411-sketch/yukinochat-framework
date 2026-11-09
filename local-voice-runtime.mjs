import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { inspectWav, localTtsPayload, VoiceServiceError } from './voice-service.mjs';

const execFileAsync = promisify(execFile);
const BACKEND = 'http://127.0.0.1:9880';
const LIMIT = 16 * 1024 * 1024;
const messageFor = status => status === 'local_warming'
  ? '本地声音正在预热，文字聊天可以继续。'
  : '本地声音正在启动，文字聊天可以继续。';

// Process ownership and port checks live in the fixed project launcher. Neither
// browser input nor a voice profile can supply executable names or arguments.
async function launch(root, signal) {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const environment = { ...process.env };
  for (const key of ['MOSS_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'HF_TOKEN']) delete environment[key];
  const { stdout } = await execFileAsync(executable, ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned',
    '-File', path.join(root, 'voice-runtime', 'Start-VoiceRuntime.ps1')], {
    cwd: root, windowsHide: true, encoding: 'utf8', env: environment,
    timeout: 20000, maxBuffer: 256 * 1024, signal,
  });
  const result = JSON.parse(stdout.replace(/^\uFEFF/u, '').trim());
  if (!['ready', 'starting'].includes(result.status) || result.url !== BACKEND || !Number.isInteger(result.pid)) {
    throw new Error('Invalid local launcher receipt');
  }
}

async function runtimeIdentity(root) {
  const file = path.join(root, 'voice-runtime', 'runtime-instance.json');
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 32768) throw new Error('Invalid runtime identity');
  const state = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/u, ''));
  if (!Number.isInteger(state.pid) || state.pid <= 0 || typeof state.creationDate !== 'string' ||
      state.host !== '127.0.0.1' || state.port !== 9880 ||
      state.configPath?.toLowerCase() !== path.join(root, 'voice-runtime', 'tts-active.yaml').toLowerCase()) {
    throw new Error('Unexpected runtime identity');
  }
  process.kill(state.pid, 0); // Existence only; never send a terminating signal.
  return JSON.stringify([state.pid, state.creationDate, state.launcherPid, state.launcherCreationDate, state.configPath]);
}

export function inspectLocalPcmWav(bytes) {
  const info = inspectWav(bytes);
  let pcm16 = false;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const length = bytes.readUInt32LE(offset + 4), start = offset + 8;
    if (bytes.toString('ascii', offset, offset + 4) === 'fmt ') {
      pcm16 = bytes.readUInt16LE(start) === 1 && bytes.readUInt16LE(start + 14) === 16;
    }
    offset = start + length + length % 2;
  }
  // The installed v2ProPlus runtime is fixed to this format. Refuse a changed
  // model rather than interpreting unlabelled raw PCM at a guessed rate.
  if (!pcm16 || info.sampleRate !== 32000 || info.channels !== 1) throw new Error('Unexpected local PCM format');
  return { sampleRate: 32000, channels: 1, bitsPerSample: 16, encoding: 'pcm_s16le' };
}

export function createLocalVoiceRuntime({ root, fetchImpl = globalThis.fetch,
  launchRuntime = signal => launch(root, signal), pollMs = 750,
  readRuntimeIdentity = () => runtimeIdentity(root),
  startupTimeoutMs = 120000, warmupTimeoutMs = 90000,
  probeTimeoutMs = 1500, retryDelayMs = 15000 } = {}) {
  if (!path.isAbsolute(root || '')) throw new Error('Absolute project root required');
  let record = null, disposed = false;

  async function probe(signal) {
    try {
      const response = await fetchImpl(`${BACKEND}/openapi.json`, {
        redirect: 'error', cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(probeTimeoutMs)]),
      });
      if (!response.ok || !(response.headers.get('content-type') || '').includes('application/json')) {
        await response.body?.cancel(); return false;
      }
      const schema = await response.json();
      return !!schema?.paths?.['/tts']?.post;
    } catch { return false; }
  }

  async function warm(config, signal) {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(warmupTimeoutMs)]);
    const response = await fetchImpl(`${BACKEND}/tts`, {
      method: 'POST', redirect: 'error', signal: bounded,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(localTtsPayload(config, 'こんにちは。', { streaming: false })),
    });
    if (!response.ok || !['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave']
      .includes((response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase())) {
      await response.body?.cancel(); throw new Error('Local warmup failed');
    }
    const declared = Number(response.headers.get('content-length'));
    if (!response.body || (Number.isFinite(declared) && declared > LIMIT)) {
      await response.body?.cancel(); throw new Error('Invalid warmup audio');
    }
    const reader = response.body.getReader(), chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (bounded.aborted || (total += value.byteLength) > LIMIT) throw new Error('Invalid warmup audio');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (bounded.aborted) throw new Error('Warmup cancelled');
    return inspectLocalPcmWav(Buffer.concat(chunks, total));
  }

  function begin(config) {
    record?.controller.abort();
    const current = { key: config.fingerprint, status: 'local_starting', controller: new AbortController(), format: null };
    record = current;
    current.work = (async () => {
      try {
        await launchRuntime(current.controller.signal);
        current.identity = await readRuntimeIdentity();
        const deadline = Date.now() + startupTimeoutMs;
        while (!await probe(current.controller.signal)) {
          if (current.controller.signal.aborted || Date.now() >= deadline) throw new Error('Local startup timeout');
          await new Promise(resolve => {
            const finish = () => { clearTimeout(timer); current.controller.signal.removeEventListener('abort', finish); resolve(); };
            const timer = setTimeout(finish, pollMs);
            current.controller.signal.addEventListener('abort', finish, { once: true });
          });
        }
        if (current.controller.signal.aborted) return;
        current.status = 'local_warming';
        current.format = await warm(config, current.controller.signal);
        if (current.controller.signal.aborted) return;
        if (await readRuntimeIdentity() !== current.identity) throw new Error('Runtime changed during warmup');
        current.status = 'ready';
      } catch {
        if (current.controller.signal.aborted) return;
        current.status = 'local_start_failed'; current.retryAt = Date.now() + retryDelayMs;
      }
    })();
  }

  async function getStatus(config) {
    if (disposed) return { available: false, status: 'local_start_failed', error: '本地声音服务已关闭。' };
    if (!record || record.key !== config.fingerprint ||
      (record.status === 'local_start_failed' && Date.now() >= record.retryAt)) begin(config);
    const current = record;
    const identityMatches = current.status !== 'ready' ||
      await readRuntimeIdentity().then(identity => identity === current.identity, () => false);
    if (current.status === 'ready' && (!identityMatches || !await probe(current.controller.signal))) {
      // Never keep an old ready flag after the listener has gone away.
      if (record === current) begin(config);
    }
    if (record.key !== config.fingerprint) throw new VoiceServiceError('音源已变更，请重新检查声音。', 409, 'voice_changed');
    if (record.status === 'ready') return { available: true, status: 'ready', format: { ...record.format } };
    if (record.status === 'local_start_failed') return {
      available: false, status: record.status, error: '本地声音启动未成功，请稍后点击检查声音。',
    };
    return { available: false, status: record.status, error: messageFor(record.status) };
  }

  async function ensureReady(config) {
    const state = await getStatus(config);
    if (!state.available) throw new VoiceServiceError(state.error, 503, state.status);
    return state.format;
  }

  function dispose() { disposed = true; record?.controller.abort(); }
  return { getStatus, ensureReady, dispose };
}
