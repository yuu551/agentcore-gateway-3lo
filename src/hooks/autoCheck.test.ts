import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ConnectionStatus, ProviderId } from '../types/runtime';
import { PROVIDER_IDS } from '../types/runtime';
import { createAutoCheckScheduler, runAutoCheckBatch } from './autoCheck';

function createFakeDeps(options?: {
  initial?: Partial<Record<ProviderId, ConnectionStatus>>;
  cached?: ProviderId[];
  chatBusy?: () => boolean;
  authBusy?: () => boolean;
  onCheck?: (provider: ProviderId) => void | Promise<void>;
}) {
  const statuses: Record<ProviderId, ConnectionStatus> = {
    github: 'unknown',
    slack: 'unknown',
    google_calendar: 'unknown',
    ...options?.initial,
  };
  const cached = new Set(options?.cached ?? []);
  const checked: ProviderId[] = [];

  const deps = {
    getStatus: (provider: ProviderId) => statuses[provider],
    isCached: (provider: ProviderId) => cached.has(provider),
    isChatBusy: options?.chatBusy ?? (() => false),
    isAuthorizationBusy: options?.authBusy ?? (() => false),
    startCheck: async (provider: ProviderId) => {
      checked.push(provider);
      await options?.onCheck?.(provider);
      cached.delete(provider);
      statuses[provider] =
        provider === 'slack' ? 'not_connected' : 'connected';
    },
    checked,
    statuses,
  };

  return deps;
}

describe('runAutoCheckBatch', () => {
  it('3件を待ち合わせずに並列開始する', async () => {
    const started: ProviderId[] = [];
    const resolvers = new Map<ProviderId, () => void>();
    const deps = createFakeDeps({
      onCheck: (provider) =>
        new Promise<void>((resolve) => {
          started.push(provider);
          resolvers.set(provider, resolve);
        }),
    });

    const resultPromise = runAutoCheckBatch(deps);
    assert.deepEqual(started, [...PROVIDER_IDS]);

    for (const provider of PROVIDER_IDS) {
      resolvers.get(provider)?.();
    }
    assert.equal(await resultPromise, 'completed');
  });

  it('1件が失敗しても他providerの完了を待つ', async () => {
    const deps = createFakeDeps({
      onCheck: async (provider) => {
        if (provider === 'slack') throw new Error('provider unavailable');
      },
    });

    const result = await runAutoCheckBatch(deps);
    assert.equal(result, 'completed');
    assert.deepEqual(deps.checked, [...PROVIDER_IDS]);
    assert.equal(deps.statuses.github, 'connected');
    assert.equal(deps.statuses.google_calendar, 'connected');
  });

  it('unknownとキャッシュ由来だけを再確認する', async () => {
    const deps = createFakeDeps({
      initial: {
        github: 'connected',
        slack: 'connected',
        google_calendar: 'unknown',
      },
      cached: ['github'],
    });

    await runAutoCheckBatch(deps);
    assert.deepEqual(deps.checked, ['github', 'google_calendar']);
  });

  it('chatBusyまたは認可中ならdeferredにする', async () => {
    const chatBusy = createFakeDeps({ chatBusy: () => true });
    assert.equal(await runAutoCheckBatch(chatBusy), 'deferred');
    assert.deepEqual(chatBusy.checked, []);

    const authBusy = createFakeDeps({ authBusy: () => true });
    assert.equal(await runAutoCheckBatch(authBusy), 'deferred');
    assert.deepEqual(authBusy.checked, []);
  });
});

describe('createAutoCheckScheduler', () => {
  it('チャット中のrequestを保持し、idle後に並列確認する', async () => {
    let chatBusy = true;
    const deps = createFakeDeps({
      chatBusy: () => chatBusy,
    });
    const scheduler = createAutoCheckScheduler(deps);

    await scheduler.request();
    assert.equal(scheduler.completed, false);
    assert.deepEqual(deps.checked, []);

    chatBusy = false;
    await scheduler.onChatIdle();
    assert.equal(scheduler.completed, true);
    assert.deepEqual(deps.checked, [...PROVIDER_IDS]);
  });

  it('完了後の再表示では再実行しない', async () => {
    const deps = createFakeDeps();
    const scheduler = createAutoCheckScheduler(deps);

    await scheduler.request();
    assert.deepEqual(deps.checked, [...PROVIDER_IDS]);

    deps.statuses.github = 'unknown';
    deps.statuses.slack = 'unknown';
    deps.statuses.google_calendar = 'unknown';
    deps.checked.length = 0;

    await scheduler.request();
    assert.deepEqual(deps.checked, []);
    assert.equal(scheduler.completed, true);
  });
});
