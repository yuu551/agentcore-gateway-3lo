import { PROVIDER_IDS } from '../types/runtime';
import type {
  CachedConnectionState,
  ConnectionStateMap,
} from './connectionState';

export const CONNECTION_CACHE_TTL_MS = 5 * 60 * 1000;
const CONNECTION_CACHE_KEY = '3lo-agent:connection-status:v1';
const CACHE_VERSION = 1;

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

type CacheEnvelope = {
  version: typeof CACHE_VERSION;
  owner: string;
  providers: CachedConnectionState;
};

function isCacheableStatus(
  value: unknown,
): value is 'connected' | 'not_connected' {
  return value === 'connected' || value === 'not_connected';
}

function parseEnvelope(raw: string | null): CacheEnvelope | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      parsed.version !== CACHE_VERSION ||
      typeof parsed.owner !== 'string' ||
      !parsed.providers ||
      typeof parsed.providers !== 'object'
    ) {
      return null;
    }
    return parsed as CacheEnvelope;
  } catch {
    return null;
  }
}

export function readConnectionCache(
  storage: StorageLike,
  owner: string,
  now = Date.now(),
): CachedConnectionState {
  if (!owner) return {};
  let envelope: CacheEnvelope | null;
  try {
    envelope = parseEnvelope(storage.getItem(CONNECTION_CACHE_KEY));
  } catch {
    return {};
  }
  if (!envelope || envelope.owner !== owner) return {};

  const result: CachedConnectionState = {};
  for (const provider of PROVIDER_IDS) {
    const entry = envelope.providers[provider];
    if (
      !entry ||
      !isCacheableStatus(entry.status) ||
      typeof entry.checkedAt !== 'number' ||
      entry.checkedAt > now ||
      now - entry.checkedAt > CONNECTION_CACHE_TTL_MS
    ) {
      continue;
    }
    result[provider] = {
      status: entry.status,
      checkedAt: entry.checkedAt,
    };
  }
  return result;
}

/**
 * 確定状態だけを保存する。checking 中は直前のキャッシュを維持し、
 * error になった provider は古い成功状態を残さない。
 */
export function persistConnectionCache(
  storage: StorageLike,
  owner: string,
  states: ConnectionStateMap,
  now = Date.now(),
): void {
  if (!owner) return;

  const providers: CachedConnectionState = {
    ...readConnectionCache(storage, owner, now),
  };

  for (const provider of PROVIDER_IDS) {
    const state = states[provider];
    if (
      (state.status === 'connected' ||
        state.status === 'not_connected') &&
      typeof state.checkedAt === 'number'
    ) {
      providers[provider] = {
        status: state.status,
        checkedAt: state.checkedAt,
      };
      continue;
    }
    if (state.status === 'error') {
      delete providers[provider];
    }
  }

  if (Object.keys(providers).length === 0) {
    try {
      storage.removeItem(CONNECTION_CACHE_KEY);
    } catch {
      // キャッシュ不可でも接続確認そのものは継続する。
    }
    return;
  }

  const envelope: CacheEnvelope = {
    version: CACHE_VERSION,
    owner,
    providers,
  };
  try {
    storage.setItem(CONNECTION_CACHE_KEY, JSON.stringify(envelope));
  } catch {
    // 容量制限やブラウザ設定で保存できない場合はキャッシュだけ諦める。
  }
}

export function getSessionStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}
