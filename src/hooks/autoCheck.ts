import type { ConnectionStatus, ProviderId } from '../types/runtime';
import { PROVIDER_IDS } from '../types/runtime';

export type AutoCheckDeps = {
  getStatus: (provider: ProviderId) => ConnectionStatus;
  isCached: (provider: ProviderId) => boolean;
  isChatBusy: () => boolean;
  isAuthorizationBusy: () => boolean;
  startCheck: (provider: ProviderId) => Promise<void>;
};

/** unknown またはキャッシュ由来の provider を同時に確認する。 */
export async function runAutoCheckBatch(
  deps: AutoCheckDeps,
): Promise<'completed' | 'deferred'> {
  if (deps.isChatBusy() || deps.isAuthorizationBusy()) return 'deferred';

  const targets = PROVIDER_IDS.filter(
    (provider) =>
      deps.getStatus(provider) === 'unknown' || deps.isCached(provider),
  );
  await Promise.allSettled(
    targets.map((provider) => deps.startCheck(provider)),
  );
  return 'completed';
}

/**
 * パネル初回オープンで要求し、チャット中断後も再開できるスケジューラ。
 * completed 後は同じページ内で再実行しない。
 */
export function createAutoCheckScheduler(deps: AutoCheckDeps) {
  let requested = false;
  let completed = false;
  let running = false;

  const tick = async () => {
    if (!requested || completed || running) return;
    if (deps.isChatBusy()) return;

    running = true;
    try {
      const result = await runAutoCheckBatch(deps);
      if (result === 'completed') {
        completed = true;
      }
    } finally {
      running = false;
    }
  };

  return {
    /** パネルを開いたときに呼ぶ */
    request: () => {
      requested = true;
      return tick();
    },
    /** チャットが空いたときに呼ぶ */
    onChatIdle: () => {
      if (!requested || completed) return Promise.resolve();
      return tick();
    },
    get requested() {
      return requested;
    },
    get completed() {
      return completed;
    },
  };
}
