import type {
  ConnectionStatus,
  ProviderConnectionState,
  ProviderId,
  RuntimeEvent,
} from '../types/runtime';
import { PROVIDER_IDS } from '../types/runtime';
import { isHttpsAuthUrl } from '../lib/agentRuntime';

export const PROVIDER_META: Record<
  ProviderId,
  { label: string; description: string }
> = {
  github: {
    label: 'GitHub',
    description: 'リポジトリ、Issue、Pull Request',
  },
  slack: {
    label: 'Slack',
    description: 'チャンネル、投稿、スレッド',
  },
  google_calendar: {
    label: 'Google カレンダー',
    description: 'カレンダーと予定',
  },
};

export const STATUS_LABEL: Record<ConnectionStatus, string> = {
  unknown: '未確認',
  checking: '確認中',
  not_connected: '未連携',
  authorization_required: '認可が必要',
  connected: '連携済み',
  error: '確認できませんでした',
};

export const ERROR_COPY: Record<string, string> = {
  invalid_provider: 'このサービスは利用できません。',
  authorization_timeout: '認可の待機時間を超えました。もう一度お試しください。',
  pending_registration_failed:
    '認可の準備に失敗しました。もう一度お試しください。',
  provider_unavailable:
    'サービスへ接続できませんでした。時間をおいて再試行してください。',
  probe_tool_missing: '接続確認用のツールが構成されていません。',
  runtime_request_failed: '接続状態を確認できませんでした。',
  invalid_authorization_url: '安全な認可 URL を確認できませんでした。',
};

export type ConnectionStateMap = Record<ProviderId, ProviderConnectionState>;
export type ProviderActionKind = 'check' | 'connect';

export type CachedConnectionState = Partial<
  Record<
    ProviderId,
    {
      status: 'connected' | 'not_connected';
      checkedAt: number;
    }
  >
>;

export function createInitialConnectionState(
  cached: CachedConnectionState = {},
): ConnectionStateMap {
  const initialFor = (provider: ProviderId): ProviderConnectionState => {
    const entry = cached[provider];
    if (!entry) return { status: 'unknown' };
    return {
      status: entry.status,
      checkedAt: entry.checkedAt,
      cached: true,
    };
  };

  return {
    github: initialFor('github'),
    slack: initialFor('slack'),
    google_calendar: initialFor('google_calendar'),
  };
}

/** 認可待機中だけチャットと他操作を長くロックする。checking は短時間の競合防止。 */
export function isConnectionBusy(states: ConnectionStateMap): boolean {
  return PROVIDER_IDS.some((id) => {
    const state = states[id];
    return (
      state.refreshing === true ||
      state.status === 'checking' ||
      state.status === 'authorization_required'
    );
  });
}

export function isAuthorizationBusy(states: ConnectionStateMap): boolean {
  return PROVIDER_IDS.some(
    (id) => states[id].status === 'authorization_required',
  );
}

export function canStartProviderAction(
  states: ConnectionStateMap,
  provider: ProviderId,
  action: ProviderActionKind,
  options: {
    chatBusy: boolean;
    activeRequestCount: number;
    probeActive: boolean;
  },
): boolean {
  if (options.chatBusy) return false;

  const providerState = states[provider];
  const providerBusy =
    providerState.refreshing === true ||
    providerState.status === 'checking' ||
    providerState.status === 'authorization_required';
  if (providerBusy) return false;

  if (action === 'connect') {
    return (
      !isConnectionBusy(states) &&
      options.activeRequestCount === 0
    );
  }

  return !isAuthorizationBusy(states) && !options.probeActive;
}

export function busyProvider(states: ConnectionStateMap): ProviderId | null {
  for (const id of PROVIDER_IDS) {
    const state = states[id];
    if (
      state.refreshing ||
      state.status === 'checking' ||
      state.status === 'authorization_required'
    ) {
      return id;
    }
  }
  return null;
}

export type ConnectionAction =
  | { type: 'start_check'; provider: ProviderId; requestId: string }
  | {
      type: 'apply_event';
      provider: ProviderId;
      requestId: string;
      event: RuntimeEvent;
      checkedAt?: number;
    }
  | {
      type: 'auth_url_ready';
      provider: ProviderId;
      requestId: string;
      authUrl: string;
    }
  | {
      type: 'set_error';
      provider: ProviderId;
      requestId?: string;
      code: string;
      message?: string;
    }
  | {
      type: 'apply_chat_auth_required';
      provider: ProviderId;
      authUrl: string;
    }
  | {
      type: 'apply_chat_connected';
      provider: ProviderId;
      checkedAt: number;
    }
  | {
      type: 'apply_chat_error';
      provider: ProviderId;
      code: string;
      message?: string;
    };

function matchesRequest(
  state: ProviderConnectionState,
  requestId: string,
): boolean {
  return !state.requestId || state.requestId === requestId;
}

export function connectionReducer(
  state: ConnectionStateMap,
  action: ConnectionAction,
): ConnectionStateMap {
  switch (action.type) {
    case 'start_check': {
      const current = state[action.provider];
      if (
        current.cached &&
        (current.status === 'connected' ||
          current.status === 'not_connected')
      ) {
        return {
          ...state,
          [action.provider]: {
            ...current,
            refreshing: true,
            requestId: action.requestId,
          },
        };
      }
      return {
        ...state,
        [action.provider]: {
          status: 'checking',
          requestId: action.requestId,
        },
      };
    }
    case 'apply_event': {
      const current = state[action.provider];
      if (!matchesRequest(current, action.requestId)) {
        return state;
      }
      const { event } = action;
      if (event.type === 'connection_status') {
        if (event.status === 'checking') {
          if (current.cached && current.refreshing) {
            return state;
          }
          return {
            ...state,
            [action.provider]: {
              status: 'checking',
              requestId: action.requestId,
            },
          };
        }
        if (event.status === 'not_connected') {
          return {
            ...state,
            [action.provider]: {
              status: 'not_connected',
              requestId: action.requestId,
              checkedAt: action.checkedAt,
            },
          };
        }
        return {
          ...state,
          [action.provider]: {
            status: 'connected',
            requestId: action.requestId,
            checkedAt: action.checkedAt,
          },
        };
      }
      if (event.type === 'auth_required') {
        return {
          ...state,
          [action.provider]: {
            status: 'authorization_required',
            requestId: action.requestId,
          },
        };
      }
      if (event.type === 'error') {
        const code = event.code ?? 'runtime_request_failed';
        return {
          ...state,
          [action.provider]: {
            status: 'error',
            requestId: action.requestId,
            errorCode: code,
            errorMessage: event.data || ERROR_COPY[code],
          },
        };
      }
      return state;
    }
    case 'auth_url_ready': {
      const current = state[action.provider];
      if (!matchesRequest(current, action.requestId)) {
        return state;
      }
      if (!isHttpsAuthUrl(action.authUrl)) {
        return {
          ...state,
          [action.provider]: {
            status: 'error',
            requestId: action.requestId,
            errorCode: 'invalid_authorization_url',
            errorMessage: ERROR_COPY.invalid_authorization_url,
          },
        };
      }
      return {
        ...state,
        [action.provider]: {
          status: 'authorization_required',
          requestId: action.requestId,
          authUrl: action.authUrl,
        },
      };
    }
    case 'set_error': {
      const current = state[action.provider];
      if (
        action.requestId &&
        current.requestId &&
        current.requestId !== action.requestId
      ) {
        return state;
      }
      return {
        ...state,
        [action.provider]: {
          status: 'error',
          requestId: action.requestId ?? current.requestId,
          errorCode: action.code,
          errorMessage: action.message ?? ERROR_COPY[action.code],
        },
      };
    }
    case 'apply_chat_auth_required': {
      if (!isHttpsAuthUrl(action.authUrl)) {
        return {
          ...state,
          [action.provider]: {
            status: 'error',
            errorCode: 'invalid_authorization_url',
            errorMessage: ERROR_COPY.invalid_authorization_url,
          },
        };
      }
      return {
        ...state,
        [action.provider]: {
          status: 'authorization_required',
          authUrl: action.authUrl,
        },
      };
    }
    case 'apply_chat_connected': {
      return {
        ...state,
        [action.provider]: {
          status: 'connected',
          checkedAt: action.checkedAt,
        },
      };
    }
    case 'apply_chat_error': {
      return {
        ...state,
        [action.provider]: {
          status: 'error',
          errorCode: action.code,
          errorMessage: action.message ?? ERROR_COPY[action.code],
        },
      };
    }
    default:
      return state;
  }
}

export function providerLabel(provider: ProviderId): string {
  return PROVIDER_META[provider].label;
}

export function guessProviderFromUrl(url: string): ProviderId | null {
  if (url.includes('github.com')) return 'github';
  if (url.includes('slack.com')) return 'slack';
  if (url.includes('google.com')) return 'google_calendar';
  return null;
}

export function displayNameFromAuthUrl(url: string): string {
  const provider = guessProviderFromUrl(url);
  if (provider) return PROVIDER_META[provider].label;
  return '外部サービス';
}
