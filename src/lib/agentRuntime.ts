import type { ProviderId, RuntimeEvent, RuntimeRequest } from '../types/runtime';
import { isProviderId } from '../types/runtime';

const SESSION_HEADER = 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id';

export type RuntimeEventHandler = (
  event: RuntimeEvent,
) => void | Promise<void>;

export type InvokeRuntimeOptions = {
  payload: RuntimeRequest;
  runtimeSessionId: string;
  accessToken: string;
  agentArn: string;
  region: string;
  signal?: AbortSignal;
  onEvent: RuntimeEventHandler;
};

export function buildRuntimeUrl(agentArn: string, region: string): string {
  return (
    `https://bedrock-agentcore.${region}.amazonaws.com/runtimes/` +
    `${encodeURIComponent(agentArn)}/invocations?qualifier=DEFAULT`
  );
}

function connectionMeta(payload: RuntimeRequest): {
  scope?: 'chat' | 'connection';
  provider?: ProviderId;
} {
  if (
    'operation' in payload &&
    (payload.operation === 'connection_probe' ||
      payload.operation === 'connection_check')
  ) {
    return { scope: 'connection', provider: payload.provider };
  }
  return { scope: 'chat' };
}

export function normalizeRuntimeEvent(raw: unknown): RuntimeEvent {
  if (!raw || typeof raw !== 'object') {
    return {
      type: 'error',
      data: '不正なイベントを受信しました',
      code: 'invalid_event',
    };
  }

  const event = raw as Record<string, unknown>;
  const type = event.type;

  if (type === 'text' && typeof event.data === 'string') {
    return { type: 'text', data: event.data };
  }

  if (type === 'tool_use' && typeof event.tool_name === 'string') {
    return { type: 'tool_use', tool_name: event.tool_name };
  }

  if (type === 'auth_required' && typeof event.auth_url === 'string') {
    return {
      type: 'auth_required',
      auth_url: event.auth_url,
      ...(isProviderId(event.provider) ? { provider: event.provider } : {}),
    };
  }

  if (
    type === 'connection_status' &&
    isProviderId(event.provider) &&
    (event.status === 'checking' ||
      event.status === 'connected' ||
      event.status === 'not_connected')
  ) {
    return {
      type: 'connection_status',
      provider: event.provider,
      status: event.status,
    };
  }

  if (type === 'error' && typeof event.data === 'string') {
    return {
      type: 'error',
      data: event.data,
      ...(event.scope === 'chat' || event.scope === 'connection'
        ? { scope: event.scope }
        : {}),
      ...(isProviderId(event.provider) ? { provider: event.provider } : {}),
      ...(typeof event.code === 'string' ? { code: event.code } : {}),
    };
  }

  return {
    type: 'error',
    data: '不正なイベントを受信しました',
    code: 'invalid_event',
  };
}

export type SseParser = {
  push: (chunk: string) => void;
  flush: () => void;
};

/** onEvent を Promise チェーンで直列実行する。 */
export function createSerialEmitter(
  onEvent: RuntimeEventHandler,
  signal?: AbortSignal,
) {
  let chain: Promise<void> = Promise.resolve();

  return {
    emit(event: RuntimeEvent) {
      chain = chain.then(async () => {
        if (signal?.aborted) return;
        await onEvent(event);
      });
    },
    flush() {
      return chain;
    },
  };
}

/** SSE の `data: {...}` 行を chunk 境界をまたいで復元する。 */
export function createSseParser(
  onEvent: (event: RuntimeEvent) => void,
): SseParser {
  let buffer = '';

  const consumeLine = (line: string) => {
    const trimmed = line.replace(/\r$/, '');
    if (!trimmed.startsWith('data: ')) return;
    const raw = trimmed.slice(6).trim();
    if (!raw) return;
    try {
      onEvent(normalizeRuntimeEvent(JSON.parse(raw)));
    } catch {
      onEvent({
        type: 'error',
        data: '不正なイベントを受信しました',
        code: 'invalid_event',
      });
    }
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        consumeLine(line);
      }
    },
    flush() {
      if (buffer.trim()) {
        consumeLine(buffer);
      }
      buffer = '';
    },
  };
}

export async function invokeRuntime(
  options: InvokeRuntimeOptions,
): Promise<void> {
  const {
    payload,
    runtimeSessionId,
    accessToken,
    agentArn,
    region,
    signal,
    onEvent,
  } = options;

  const meta = connectionMeta(payload);
  const emitter = createSerialEmitter(onEvent, signal);

  if (!agentArn) {
    emitter.emit({
      type: 'error',
      data: 'エージェントが未登録です',
      code: 'runtime_request_failed',
      ...meta,
    });
    await emitter.flush();
    return;
  }

  const url = buildRuntimeUrl(agentArn, region);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        [SESSION_HEADER]: runtimeSessionId,
      },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) {
      await emitter.flush();
      return;
    }
    emitter.emit({
      type: 'error',
      data: '接続状態を確認できませんでした',
      code: 'runtime_request_failed',
      ...meta,
    });
    await emitter.flush();
    return;
  }

  if (!res.ok) {
    emitter.emit({
      type: 'error',
      data: `Runtime の呼び出しに失敗しました (${res.status})`,
      code: 'runtime_request_failed',
      ...meta,
    });
    await emitter.flush();
    return;
  }

  if (!res.body) {
    emitter.emit({
      type: 'error',
      data: 'Runtime から空の応答を受け取りました',
      code: 'runtime_request_failed',
      ...meta,
    });
    await emitter.flush();
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser((event) => emitter.emit(event));

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.flush();
  } finally {
    reader.releaseLock();
    await emitter.flush();
  }
}

export function isHttpsAuthUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}
