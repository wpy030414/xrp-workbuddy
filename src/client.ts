/**
 * workbuddy/client.ts — OpenAI Chat Completions → WorkBuddy 网关转发。
 *
 * 逆向结论（详见 docs/WORKBUDDY_REVERSE.md）：
 * - 推理端点：POST {base}/v2/chat/completions，仅支持流式（非流式返回 11101）
 * - 响应即标准 OpenAI SSE chunk（含 reasoning_content / extra_fields），以 data: [DONE] 结束
 * - 认证：Authorization: Bearer <accessToken> + X-User-Id / X-Domain / X-IDE-* 等客户端头
 * - 工具调用：标准 OpenAI tools/tool_calls 语义，网关原生支持
 *
 * 因此插件对非流式客户端做「上游流式 + 本地聚合」，对流式客户端直接透传。
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { settings } from './config';
import { forceRefresh, getToken, type WorkBuddyAuthState } from './auth';

export interface WorkBuddyModelInfo {
  id: string;
  name: string;
  vendor?: string;
  supportsToolCall?: boolean;
  tags?: string[];
}

/** 目录拉取失败时的兜底模型（正常情况使用云端目录） */
const FALLBACK_MODELS: WorkBuddyModelInfo[] = [
  { id: 'auto', name: 'Auto' },
  { id: 'glm-5.3', name: 'GLM-5.3' },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash' },
  { id: 'glm-5.2', name: 'GLM-5.2' },
  { id: 'glm-5.1', name: 'GLM-5.1' },
  { id: 'kimi-k3-1', name: 'Kimi-K3' },
  { id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview' },
  { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro' },
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' },
  { id: 'minimax-m3', name: 'MiniMax-M3' },
  { id: 'hy4-preview', name: 'Hy4 preview' },
  { id: 'step-5-preview', name: 'Step-5-Preview' },
];

function traceHeaders(): Record<string, string> {
  const traceId = randomBytes(16).toString('hex');
  const spanId = randomBytes(8).toString('hex');
  return {
    'traceparent': `00-${traceId}-${spanId}-01`,
    'b3': `${traceId}-${spanId}-1-${randomBytes(8).toString('hex')}`,
    'X-B3-TraceId': traceId,
    'X-B3-SpanId': spanId,
    'X-B3-Sampled': '1',
  };
}

/** WorkBuddy 网关要求的客户端身份头 */
function gatewayHeaders(
  token: WorkBuddyAuthState,
  opts: { stream: boolean; conversation?: boolean },
): Record<string, string> {
  const h: Record<string, string> = {
    'Authorization': `Bearer ${token.accessToken}`,
    'X-Product': settings.product,
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': settings.ideVersion,
    'X-Private-Data': 'true',
    'User-Agent': `WorkBuddy/${settings.ideVersion}`,
    'X-Domain': token.domain || settings.domain,
    'x-requested-with': 'XMLHttpRequest',
    'Content-Type': 'application/json',
    'Accept': opts.stream ? 'text/event-stream' : 'application/json',
    'Accept-Encoding': 'identity',
    ...traceHeaders(),
  };
  if (token.uid) h['X-User-Id'] = token.uid;
  if (opts.conversation) {
    h['X-Conversation-ID'] = randomUUID();
    h['X-Conversation-Request-ID'] = randomUUID();
    h['X-Conversation-Message-ID'] = randomUUID();
    h['acp-connection-id'] = randomUUID();
    h['X-Request-ID'] = randomUUID();
    h['X-Agent-Intent'] = 'craft';
    h['X-Agent-Purpose'] = 'conversation';
    h['x-codebuddy-request'] = '1';
  }
  return h;
}

/** 拉取云端模型目录（/v2/enterprises/personal/models） */
export async function fetchModelCatalog(): Promise<WorkBuddyModelInfo[]> {
  const token = await getToken();
  const res = await fetch(`${settings.baseUrl}${settings.modelsPath}`, {
    method: 'GET',
    headers: gatewayHeaders(token, { stream: false }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`模型目录拉取失败：HTTP ${res.status}`);
  const json: any = await res.json();
  const list: any[] = json?.data?.models;
  if (!Array.isArray(list)) throw new Error('模型目录格式异常：data.models 缺失');
  return list
    .filter((m) => m && typeof m.id === 'string' && !(m.tags || []).includes('text-to-image'))
    .map((m) => ({
      id: m.id,
      name: typeof m.name === 'string' && m.name ? m.name : m.id,
      vendor: typeof m.vendor === 'string' ? m.vendor : undefined,
      supportsToolCall: m.supportsToolCall === true,
      tags: Array.isArray(m.tags) ? m.tags : undefined,
    }));
}

/** 计算注册用模型列表：显式 WORKBUDDY_MODELS 优先，否则全量目录，最后兜底 */
export async function resolveModels(): Promise<WorkBuddyModelInfo[]> {
  let catalog: WorkBuddyModelInfo[] = [];
  try {
    catalog = await fetchModelCatalog();
    console.log(`[workbuddy] 已拉取模型目录：${catalog.length} 个模型`);
  } catch (e: any) {
    console.warn(`[workbuddy] 模型目录拉取失败（使用兜底列表）: ${e.message}`);
  }
  if (settings.availableModels.length > 0) {
    return settings.availableModels.map((id) => catalog.find((m) => m.id === id) ?? { id, name: id });
  }
  return catalog.length > 0 ? catalog : FALLBACK_MODELS;
}

function postChat(token: WorkBuddyAuthState, bodyStr: string, signal: AbortSignal): Promise<Response> {
  return fetch(`${settings.baseUrl}${settings.chatPath}`, {
    method: 'POST',
    headers: gatewayHeaders(token, { stream: true, conversation: true }),
    body: bodyStr,
    signal,
  });
}

function upstreamError(c: Context, status: number, message: string): Response {
  const type = status === 401 || status === 403 ? 'authentication_error' : status === 429 ? 'rate_limit_error' : 'upstream_error';
  return c.json({ error: { message, type } }, status as any);
}

/**
 * 流式分片归一化（适配 xrl-router 的 Anthropic 转换）：
 * 1) Router 把 `finish_reason: ""` 当作结束信号（空串也是 Some）→ 统一转成 null
 * 2) Router 把任何带 `function.name`（包括空字符串）的分片当作新 tool_use 块
 *    → 首个分片只发 id/type/name + 空 arguments，后续分片只发 index + arguments
 * 3) Router 把空 `tool_calls: []` 数组也当作块边界（会提前关闭 thinking/text）
 *    → 上游每个 chunk 都带该字段，必须剔除
 */
function normalizeStreamChunk(chunk: any, seen: Set<number>): any {
  const choice = chunk?.choices?.[0];
  if (!choice) return chunk;
  const nextChoice = choice.finish_reason ? choice : { ...choice, finish_reason: null };
  const delta = nextChoice.delta;
  if (!delta) return nextChoice === choice ? chunk : { ...chunk, choices: [nextChoice] };

  const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
  let nextDelta = delta;

  if (delta.tool_calls !== undefined && toolCalls.length === 0) {
    nextDelta = { ...delta };
    delete nextDelta.tool_calls;
  }

  if (toolCalls.length > 0) {
    const out: any[] = [];
    for (const tc of toolCalls) {
      const index = typeof tc.index === 'number' ? tc.index : 0;
      const name = typeof tc.function?.name === 'string' ? tc.function.name : '';
      const args = typeof tc.function?.arguments === 'string' ? tc.function.arguments : '';
      if (!seen.has(index)) {
        seen.add(index);
        out.push({ index, id: tc.id || '', type: tc.type || 'function', function: { name, arguments: '' } });
      }
      if (args) out.push({ index, function: { arguments: args } });
    }
    nextDelta = { ...nextDelta, tool_calls: out };
  }

  if (nextChoice === choice && nextDelta === delta) return chunk;
  return { ...chunk, choices: [{ ...nextChoice, delta: nextDelta }] };
}

/** 解析上游 SSE，逐个产出 data: 负载（跳过 heartbeat 注释行） */
async function* ssePayloads(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '').trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload) yield payload;
      }
    }
    buf += decoder.decode();
    const tail = buf.trim();
    if (tail.startsWith('data:')) {
      const payload = tail.slice(5).trim();
      if (payload) yield payload;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }
}

interface Aggregated {
  id: string;
  model: string;
  finishReason: string;
  message: any;
  usage?: any;
}

/** 把流式 chunk 聚合为一条 chat.completion.message */
async function aggregate(body: ReadableStream<Uint8Array>): Promise<Aggregated> {
  const deltas: any[] = [];
  let id = '';
  let model = '';
  let finishReason = 'stop';
  let usage: any;

  for await (const payload of ssePayloads(body)) {
    if (payload === '[DONE]') break;
    let chunk: any;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    if (chunk.id) id = chunk.id;
    if (chunk.model) model = chunk.model;
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (choice?.delta) deltas.push(choice.delta);
    if (choice?.finish_reason) finishReason = choice.finish_reason;
  }

  const content = deltas.map((d) => (typeof d.content === 'string' ? d.content : '')).join('');
  const reasoning = deltas.map((d) => (typeof d.reasoning_content === 'string' ? d.reasoning_content : '')).join('');

  const toolCallMap = new Map<number, any>();
  for (const d of deltas) {
    if (!Array.isArray(d.tool_calls)) continue;
    for (const tc of d.tool_calls) {
      const index = typeof tc.index === 'number' ? tc.index : 0;
      if (!toolCallMap.has(index)) {
        toolCallMap.set(index, {
          index,
          id: '',
          type: 'function',
          function: { name: '', arguments: '' },
        });
      }
      const merged = toolCallMap.get(index);
      if (tc.id) merged.id = tc.id;
      if (tc.type) merged.type = tc.type;
      if (tc.function?.name) merged.function.name = tc.function.name;
      if (typeof tc.function?.arguments === 'string') merged.function.arguments += tc.function.arguments;
    }
  }

  const message: any = { role: 'assistant' };
  if (content) message.content = content;
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCallMap.size > 0) {
    message.tool_calls = [...toolCallMap.values()]
      .sort((a, b) => a.index - b.index)
      .map(({ index: _index, ...tc }) => tc);
    if (!content) message.content = null;
  }

  return { id, model, finishReason, message, usage };
}

/**
 * 处理 OpenAI Chat Completions 请求。
 * 上游始终以流式调用（WorkBuddy 仅支持流式）；客户端非流式时本地聚合。
 */
export async function forwardChatCompletions(body: any, c: Context): Promise<Response> {
  const model = typeof body.model === 'string' && body.model ? body.model : 'auto';
  const isStream = body.stream === true;

  // 上游强制流式；去掉只对上游无意义的字段
  const forwardBody: any = { ...body, model, stream: true };
  delete forwardBody.extra_body;
  const bodyStr = JSON.stringify(forwardBody);

  const ac = new AbortController();
  const onClientAbort = () => ac.abort();
  c.req.raw.signal.addEventListener('abort', onClientAbort);
  const timer = setTimeout(() => ac.abort(), settings.requestTimeoutMs);
  const cleanup = () => {
    clearTimeout(timer);
    c.req.raw.signal.removeEventListener('abort', onClientAbort);
  };

  let token: WorkBuddyAuthState;
  try {
    token = await getToken();
  } catch (e: any) {
    cleanup();
    return upstreamError(c, 401, e.message);
  }

  let upstream: Response;
  try {
    upstream = await postChat(token, bodyStr, ac.signal);
    if (upstream.status === 401) {
      // App 侧 token 可能刚过期：强制刷新后重试一次
      try {
        token = await forceRefresh();
        upstream = await postChat(token, bodyStr, ac.signal);
      } catch (e: any) {
        console.warn(`[workbuddy] 401 后刷新重试失败: ${e.message}`);
      }
    }
  } catch (e: any) {
    cleanup();
    if (e.name === 'AbortError') return new Response(null, { status: 499 });
    return upstreamError(c, 502, `连接 WorkBuddy 网关失败: ${e.message}`);
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    cleanup();
    let message = text.slice(0, 500);
    try {
      const j = JSON.parse(text);
      message = j.msg || j.message || j.error?.message || message;
    } catch {
      /* 保留原文 */
    }
    if (!message) message = `WorkBuddy upstream ${upstream.status}`;
    return upstreamError(c, upstream.status, message);
  }

  if (!upstream.body) {
    cleanup();
    return upstreamError(c, 502, 'WorkBuddy upstream 响应为空');
  }

  if (!isStream) {
    try {
      const agg = await aggregate(upstream.body);
      return c.json({
        id: agg.id || `chatcmpl-${randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: agg.message, finish_reason: agg.finishReason }],
        usage: agg.usage,
      });
    } catch (e: any) {
      if (e.name === 'AbortError') return new Response(null, { status: 499 });
      console.error(`[workbuddy] 非流式聚合失败: ${e.message}`);
      return upstreamError(c, 502, `上游流读取失败: ${e.message}`);
    } finally {
      cleanup();
    }
  }

  const encoder = new TextEncoder();
  const seenToolCalls = new Set<number>();
  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      let doneSent = false;
      try {
        for await (const payload of ssePayloads(upstream.body!)) {
          if (payload === '[DONE]') {
            if (!doneSent) {
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              doneSent = true;
            }
            break;
          }
          let outgoing = payload;
          try {
            outgoing = JSON.stringify(normalizeStreamChunk(JSON.parse(payload), seenToolCalls));
          } catch {
            /* 非 JSON 原样透传 */
          }
          controller.enqueue(encoder.encode(`data: ${outgoing}\n\n`));
        }
        if (!doneSent) controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      } catch (e: any) {
        if (!ac.signal.aborted) {
          console.error(`[workbuddy] 流式转发中断: ${e.message}`);
        }
      } finally {
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      ac.abort();
      cleanup();
    },
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
