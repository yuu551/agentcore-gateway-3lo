import { useEffect, useId, useRef, type RefObject } from 'react';
import type { ProviderConnectionState, ProviderId } from '../types/runtime';
import { PROVIDER_IDS } from '../types/runtime';
import {
  ERROR_COPY,
  PROVIDER_META,
  STATUS_LABEL,
  type ConnectionStateMap,
  type ProviderActionKind,
} from '../hooks/connectionState';
import { ProviderIcon } from './ProviderIcon';

type ConnectionPanelProps = {
  open: boolean;
  onClose: () => void;
  states: ConnectionStateMap;
  canStartProvider: (
    provider: ProviderId,
    action: ProviderActionKind,
  ) => boolean;
  onCheck: (provider: ProviderId) => void;
  onConnect: (provider: ProviderId) => void;
  onOpened: () => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
};

function actionForStatus(status: string): {
  label: string;
  kind: 'check' | 'connect' | null;
} {
  switch (status) {
    case 'unknown':
      return { label: '確認する', kind: 'check' };
    case 'connected':
      return { label: '再確認', kind: 'check' };
    case 'not_connected':
      return { label: '連携する', kind: 'connect' };
    case 'error':
      return { label: '再試行', kind: 'check' };
    default:
      return { label: '', kind: null };
  }
}

function statusLabelFor(state: ProviderConnectionState): string {
  const label = STATUS_LABEL[state.status];
  return state.cached ? `前回: ${label}` : label;
}

export function ConnectionPanel({
  open,
  onClose,
  states,
  canStartProvider,
  onCheck,
  onConnect,
  onOpened,
  returnFocusRef,
}: ConnectionPanelProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const liveId = useId();
  const openedNotifiedRef = useRef(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      if (!dialog.open) {
        dialog.showModal();
      }
      if (!openedNotifiedRef.current) {
        openedNotifiedRef.current = true;
        onOpened();
      }
      queueMicrotask(() => closeBtnRef.current?.focus());
    } else if (dialog.open) {
      dialog.close();
      openedNotifiedRef.current = false;
    }
  }, [open, onOpened]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const handleClose = () => {
      onClose();
      queueMicrotask(() => returnFocusRef.current?.focus());
    };

    const handleCancel = (event: Event) => {
      event.preventDefault();
      onClose();
    };

    dialog.addEventListener('close', handleClose);
    dialog.addEventListener('cancel', handleCancel);
    return () => {
      dialog.removeEventListener('close', handleClose);
      dialog.removeEventListener('cancel', handleCancel);
    };
  }, [onClose, returnFocusRef]);

  const liveMessage = PROVIDER_IDS.map((id) => {
    const state = states[id];
    return `${PROVIDER_META[id].label}: ${statusLabelFor(state)}`;
  }).join('。');

  return (
    <dialog
      ref={dialogRef}
      className="connection-panel"
      aria-labelledby={titleId}
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose();
      }}
    >
      <div className="connection-panel-inner">
        <header className="connection-panel-header">
          <h2 id={titleId}>外部サービス連携</h2>
          <button
            ref={closeBtnRef}
            type="button"
            className="connection-close"
            aria-label="連携設定を閉じる"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <p className="connection-lead">
          使用するサービスを選んで、接続を確認・連携できます。
        </p>

        <div className="connection-live" id={liveId} aria-live="polite">
          {liveMessage}
        </div>

        <ul className="connection-list">
          {PROVIDER_IDS.map((provider) => {
            const meta = PROVIDER_META[provider];
            const state = states[provider];
            const checking =
              state.status === 'checking' || state.refreshing === true;
            const authRequired = state.status === 'authorization_required';
            const action = actionForStatus(state.status);
            const disabled =
              checking ||
              (action.kind !== null &&
                !canStartProvider(provider, action.kind));

            return (
              <li
                key={provider}
                className={`connection-row status-${state.status}`}
                aria-busy={checking || undefined}
              >
                <div className="connection-row-main">
                  <span className="connection-icon" aria-hidden="true">
                    <ProviderIcon provider={provider} />
                  </span>
                  <div className="connection-copy">
                    <div className="connection-name">{meta.label}</div>
                    <div className="connection-desc">{meta.description}</div>
                  </div>
                </div>

                <div className="connection-row-status">
                  <span
                    className={`status-pill status-${state.status}${
                      state.cached ? ' is-cached' : ''
                    }`}
                  >
                    {statusLabelFor(state)}
                  </span>
                  {checking || (authRequired && !state.authUrl) ? (
                    <span className="connection-progress" aria-hidden="true" />
                  ) : authRequired && state.authUrl ? null : action.kind ? (
                    <button
                      type="button"
                      className="connection-action"
                      disabled={disabled}
                      onClick={() =>
                        action.kind === 'connect'
                          ? onConnect(provider)
                          : onCheck(provider)
                      }
                    >
                      {action.label}
                    </button>
                  ) : null}
                </div>

                {authRequired && (
                  <div className="connection-auth">
                    <p>
                      {meta.label}
                      の画面でアクセスを許可してください。
                    </p>
                    {state.authUrl ? (
                      <a
                        className="auth-btn"
                        href={state.authUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <ProviderIcon provider={provider} />
                        {meta.label} で認可する
                      </a>
                    ) : (
                      <p className="connection-auth-pending">
                        認可の準備をしています…
                      </p>
                    )}
                  </div>
                )}

                {state.status === 'error' && (
                  <p className="connection-error">
                    {state.errorMessage ??
                      ERROR_COPY[state.errorCode ?? ''] ??
                      ERROR_COPY.runtime_request_failed}
                  </p>
                )}
              </li>
            );
          })}
        </ul>

        <p className="connection-footnote">
          接続確認は並列で実行できます。認可は1件ずつ進めます。状態はこのタブに5分間キャッシュされ、トークンは保存されません。
        </p>
      </div>
    </dialog>
  );
}
