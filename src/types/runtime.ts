export type ProviderId = 'github' | 'slack' | 'google_calendar';

export const PROVIDER_IDS: readonly ProviderId[] = [
  'github',
  'slack',
  'google_calendar',
] as const;

export type RuntimeRequest =
  | {
      operation?: 'chat';
      prompt: string;
    }
  | {
      operation: 'connection_probe';
      provider: ProviderId;
    }
  | {
      operation: 'connection_check';
      provider: ProviderId;
    };

export type ConnectionStatusEvent =
  | 'checking'
  | 'connected'
  | 'not_connected';

export type RuntimeEvent =
  | { type: 'text'; data: string }
  | { type: 'tool_use'; tool_name: string }
  | {
      type: 'auth_required';
      provider?: ProviderId;
      auth_url: string;
    }
  | {
      type: 'connection_status';
      provider: ProviderId;
      status: ConnectionStatusEvent;
    }
  | {
      type: 'error';
      data: string;
      scope?: 'chat' | 'connection';
      provider?: ProviderId;
      code?: string;
    };

export type ConnectionStatus =
  | 'unknown'
  | 'checking'
  | 'not_connected'
  | 'authorization_required'
  | 'connected'
  | 'error';

export type ProviderConnectionState = {
  status: ConnectionStatus;
  authUrl?: string;
  errorCode?: string;
  errorMessage?: string;
  requestId?: string;
  /** キャッシュ由来の前回確認結果か */
  cached?: boolean;
  /** キャッシュ値を表示したまま再確認しているか */
  refreshing?: boolean;
  /** connected / not_connected を最後に確認した時刻 */
  checkedAt?: number;
};

export function isProviderId(value: unknown): value is ProviderId {
  return (
    value === 'github' || value === 'slack' || value === 'google_calendar'
  );
}
