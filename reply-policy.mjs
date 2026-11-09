import { performance } from 'node:perf_hooks';

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const CONFIG_KEYS = ['version', 'enabled', 'dailyEffort', 'deepEffort', 'conciseReplies'];
export const CONCISE_REPLY_INSTRUCTIONS = '本窗口的回复节奏：日常交谈通常用 1–3 句。首个日语句写成自然的独立短句，通常 10–20 个日语字符，原则上不超过 25 字；只表达一个针对用户具体话题或感受的核心回应，或直接给出所问的结论。数值或判断问题在首句给出结果，不先说“安排如下”等引入语。背景、理由、举例和追问放到第二句以后；若省略必要限定会误导，首句应保留该限定，但仍尽量短。专门的翻译请求保留原句的完整内容，不受首句字数建议限制，也不添加引入句。不要把仅表示收到、邀请继续说或表示思考的套话单独作为第一句，不加入固定占位语。每个完整日语句子后立即给出原约定的全角括号中文译文。复杂问题、科研说明或需要充分解释的任务不受 1–3 句限制，应提供足够的信息与依据；保持原有角色、事实边界和审批规则。';

export function parseReplySettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !CONFIG_KEYS.includes(key)) ||
      value.version !== 1 || typeof value.enabled !== 'boolean' || typeof value.conciseReplies !== 'boolean' ||
      !EFFORTS.has(value.dailyEffort) || !EFFORTS.has(value.deepEffort)) {
    throw new Error('回复设置无效，请检查应用内 reply/config.json。');
  }
  return Object.freeze({ enabled: value.enabled, defaultMode: 'daily', dailyEffort: value.dailyEffort,
    deepEffort: value.deepEffort, conciseReplies: value.conciseReplies });
}

export function parseReplyRequest(input) {
  const mode = input.responseMode === undefined ? 'daily' : input.responseMode;
  if (!['daily', 'deep'].includes(mode)) throw new Error('responseMode 必须为 daily 或 deep。');
  const clientTraceId = input.clientTraceId === undefined ? null : input.clientTraceId;
  if (clientTraceId !== null && (typeof clientTraceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(clientTraceId))) {
    throw new Error('clientTraceId 必须为 1–96 个安全 ASCII 字符。');
  }
  if (Object.hasOwn(input, 'clientTraceId') && input.clientTraceId === null) throw new Error('clientTraceId 不能为 null。');
  return { mode, clientTraceId };
}

export function replyEffort(settings, mode) {
  return settings.enabled ? (mode === 'deep' ? settings.deepEffort : settings.dailyEffort) : null;
}

export function replyPersona(persona, settings) {
  return settings.enabled && settings.conciseReplies ? `${persona}\n\n${CONCISE_REPLY_INSTRUCTIONS}` : persona;
}

export function assertEffortSupported(models, model, effort) {
  if (!effort) return;
  const entry = models.find(item => item.model === model || item.id === model);
  if (!entry?.supportedReasoningEfforts?.some(option => option.reasoningEffort === effort)) {
    throw new Error(`当前模型未确认支持 ${effort} 推理强度；未切换模型或发起生成。`);
  }
}

const STAGES = Object.freeze(['threadReadyMs', 'turnRequestMs', 'turnStartedMs', 'firstReasoningEventMs',
  'reasoningCompletedMs', 'firstAgentDeltaMs', 'firstBodyReadyMs', 'textCompleteMs']);

/** Monotonic, memory-only records. Tokens guard late async results across turns. */
export class TurnTimingTracker {
  #records = new Map();
  #clock;
  #maxRecords;
  constructor(clock = () => performance.now(), { maxRecords = 128 } = {}) {
    this.#clock = clock; this.#maxRecords = maxRecords;
    if (!Number.isInteger(maxRecords) || maxRecords < 1) throw new Error('Invalid timing record limit');
  }
  start(conversationId, { mode, clientTraceId, requestedEffort }, startedAt = this.#clock()) {
    const token = { startedAt, record: { mode, clientTraceId, requestedEffort, turnId: null,
      actualModel: null, actualEffort: null, actualServiceTier: null,
      ...Object.fromEntries(STAGES.map(stage => [stage, null])) } };
    this.#records.delete(conversationId); // Refresh insertion order for active conversations.
    this.#records.set(conversationId, token);
    while (this.#records.size > this.#maxRecords) this.#records.delete(this.#records.keys().next().value);
    return token;
  }
  current(conversationId, token) { return !!token && this.#records.get(conversationId) === token; }
  forTurn(conversationId, turnId) {
    const token = this.#records.get(conversationId);
    if (!token || (turnId && token.record.turnId && token.record.turnId !== turnId)) return null;
    return token;
  }
  bind(conversationId, token, turnId) {
    if (!this.current(conversationId, token) || (token.record.turnId && token.record.turnId !== turnId)) return false;
    token.record.turnId = turnId;
    return true;
  }
  mark(conversationId, token, stage, { latest = false } = {}) {
    if (!this.current(conversationId, token) || !STAGES.includes(stage)) return;
    if (latest || token.record[stage] === null) token.record[stage] = Math.max(0, Math.round((this.#clock() - token.startedAt) * 1000) / 1000);
  }
  metadata(conversationId, token, value) {
    if (!this.current(conversationId, token)) return;
    for (const [source, target] of [['model', 'actualModel'], ['reasoningEffort', 'actualEffort'], ['serviceTier', 'actualServiceTier']]) {
      if (typeof value[source] === 'string') token.record[target] = value[source];
    }
  }
  snapshot() { return Object.fromEntries([...this.#records].map(([id, token]) => [id, { ...token.record }])); }
}
