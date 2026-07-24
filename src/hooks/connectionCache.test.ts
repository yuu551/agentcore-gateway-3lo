import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ConnectionStateMap } from './connectionState';
import {
  CONNECTION_CACHE_TTL_MS,
  persistConnectionCache,
  readConnectionCache,
} from './connectionCache';

function createMemoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    values,
  };
}

function states(
  partial: Partial<ConnectionStateMap> = {},
): ConnectionStateMap {
  return {
    github: { status: 'unknown' },
    slack: { status: 'unknown' },
    google_calendar: { status: 'unknown' },
    ...partial,
  };
}

describe('connectionCache', () => {
  it('確定状態だけを同じユーザーへ復元する', () => {
    const storage = createMemoryStorage();
    persistConnectionCache(
      storage,
      'user-1',
      states({
        github: { status: 'connected', checkedAt: 1_000 },
        slack: { status: 'not_connected', checkedAt: 1_100 },
        google_calendar: {
          status: 'authorization_required',
          authUrl: 'https://accounts.google.com/oauth',
        },
      }),
      1_200,
    );

    assert.deepEqual(readConnectionCache(storage, 'user-1', 1_200), {
      github: { status: 'connected', checkedAt: 1_000 },
      slack: { status: 'not_connected', checkedAt: 1_100 },
    });
    assert.deepEqual(readConnectionCache(storage, 'user-2', 1_200), {});

    const serialized = [...storage.values.values()].join('');
    assert.equal(serialized.includes('accounts.google.com'), false);
    assert.equal(serialized.includes('authUrl'), false);
  });

  it('5分を過ぎた状態は復元しない', () => {
    const storage = createMemoryStorage();
    persistConnectionCache(
      storage,
      'user-1',
      states({
        github: { status: 'connected', checkedAt: 1_000 },
      }),
      1_000,
    );

    assert.deepEqual(
      readConnectionCache(
        storage,
        'user-1',
        1_000 + CONNECTION_CACHE_TTL_MS + 1,
      ),
      {},
    );
  });

  it('再確認中は直前値を維持し、エラー時は破棄する', () => {
    const storage = createMemoryStorage();
    persistConnectionCache(
      storage,
      'user-1',
      states({
        github: { status: 'connected', checkedAt: 1_000 },
      }),
      1_000,
    );

    persistConnectionCache(
      storage,
      'user-1',
      states({
        github: { status: 'checking', requestId: 'r1' },
      }),
      1_100,
    );
    assert.equal(
      readConnectionCache(storage, 'user-1', 1_100).github?.status,
      'connected',
    );

    persistConnectionCache(
      storage,
      'user-1',
      states({
        github: { status: 'error', errorCode: 'provider_unavailable' },
      }),
      1_200,
    );
    assert.deepEqual(readConnectionCache(storage, 'user-1', 1_200), {});
  });

  it('storageが利用できなくても接続画面を壊さない', () => {
    const unavailableStorage = {
      getItem: () => {
        throw new Error('storage disabled');
      },
      setItem: () => {
        throw new Error('storage disabled');
      },
      removeItem: () => {
        throw new Error('storage disabled');
      },
    };

    assert.deepEqual(readConnectionCache(unavailableStorage, 'user-1'), {});
    assert.doesNotThrow(() =>
      persistConnectionCache(
        unavailableStorage,
        'user-1',
        states({
          github: { status: 'connected', checkedAt: 1_000 },
        }),
        1_000,
      ),
    );
  });
});
