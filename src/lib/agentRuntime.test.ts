import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createSerialEmitter,
  createSseParser,
  isHttpsAuthUrl,
  normalizeRuntimeEvent,
} from './agentRuntime';

describe('createSseParser', () => {
  it('分割された JSON 行を復元する', () => {
    const events: unknown[] = [];
    const parser = createSseParser((e) => events.push(e));

    parser.push('data: {"type":"text","da');
    parser.push('ta":"hello"}\n');
    parser.flush();

    assert.deepEqual(events, [{ type: 'text', data: 'hello' }]);
  });

  it('1 chunk に複数 event があっても順番を保つ', () => {
    const events: unknown[] = [];
    const parser = createSseParser((e) => events.push(e));

    parser.push(
      'data: {"type":"connection_status","provider":"github","status":"checking"}\n' +
        'data: {"type":"connection_status","provider":"github","status":"connected"}\n',
    );

    assert.deepEqual(events, [
      {
        type: 'connection_status',
        provider: 'github',
        status: 'checking',
      },
      {
        type: 'connection_status',
        provider: 'github',
        status: 'connected',
      },
    ]);
  });

  it('不正 JSON を error へ変換する', () => {
    const events: unknown[] = [];
    const parser = createSseParser((e) => events.push(e));
    parser.push('data: {not-json}\n');

    assert.equal((events[0] as { type: string }).type, 'error');
    assert.equal((events[0] as { code?: string }).code, 'invalid_event');
  });
});

describe('normalizeRuntimeEvent', () => {
  it('auth_required の provider を受け取る', () => {
    assert.deepEqual(
      normalizeRuntimeEvent({
        type: 'auth_required',
        provider: 'slack',
        auth_url: 'https://example.com/oauth',
      }),
      {
        type: 'auth_required',
        provider: 'slack',
        auth_url: 'https://example.com/oauth',
      },
    );
  });
});

describe('isHttpsAuthUrl', () => {
  it('https のみ許可する', () => {
    assert.equal(isHttpsAuthUrl('https://github.com/login'), true);
    assert.equal(isHttpsAuthUrl('http://evil.example'), false);
    assert.equal(isHttpsAuthUrl('javascript:alert(1)'), false);
    assert.equal(isHttpsAuthUrl('not-a-url'), false);
  });
});

describe('createSerialEmitter', () => {
  it('遅い handler があってもイベント順を保つ', async () => {
    const order: string[] = [];
    const { emit, flush } = createSerialEmitter(async (event) => {
      if (event.type === 'auth_required') {
        await new Promise((r) => setTimeout(r, 30));
        order.push('auth_required');
        return;
      }
      if (event.type === 'connection_status') {
        order.push(event.status);
      }
    });

    emit({
      type: 'auth_required',
      provider: 'github',
      auth_url: 'https://example.com/oauth',
    });
    emit({
      type: 'connection_status',
      provider: 'github',
      status: 'connected',
    });
    await flush();

    assert.deepEqual(order, ['auth_required', 'connected']);
  });
});
