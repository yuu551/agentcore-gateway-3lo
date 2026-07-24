import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { invokeRuntime, isHttpsAuthUrl } from '../lib/agentRuntime';
import type { ProviderId, RuntimeEvent } from '../types/runtime';
import { createAutoCheckScheduler } from './autoCheck';
import {
  getSessionStorage,
  persistConnectionCache,
  readConnectionCache,
} from './connectionCache';
import {
  busyProvider,
  canStartProviderAction,
  connectionReducer,
  createInitialConnectionState,
  ERROR_COPY,
  isAuthorizationBusy,
  isConnectionBusy,
  type ProviderActionKind,
} from './connectionState';

type UseConnectionManagerOptions = {
  agentArn: string;
  region: string;
  apiUrl: string;
  /** sessionStorage のキャッシュをユーザー間で分離する識別子 */
  cacheIdentity?: string;
  /** チャット送信・実行中はプローブ開始を抑止する */
  chatBusy?: boolean;
};

function isTerminalConnectionEvent(
  event: RuntimeEvent,
  provider: ProviderId,
): boolean {
  if (
    event.type === 'connection_status' &&
    event.provider === provider &&
    (event.status === 'connected' || event.status === 'not_connected')
  ) {
    return true;
  }
  if (
    event.type === 'error' &&
    (event.scope === 'connection' || event.provider === provider)
  ) {
    return true;
  }
  return false;
}

export function useConnectionManager({
  agentArn,
  region,
  apiUrl,
  cacheIdentity = '',
  chatBusy = false,
}: UseConnectionManagerOptions) {
  const [states, dispatch] = useReducer(
    connectionReducer,
    cacheIdentity,
    (identity) => {
      const storage = getSessionStorage();
      return createInitialConnectionState(
        storage ? readConnectionCache(storage, identity) : {},
      );
    },
  );
  const statesRef = useRef(states);
  statesRef.current = states;

  const abortRefs = useRef(new Map<ProviderId, AbortController>());
  const activeRequestRefs = useRef(
    new Map<
      ProviderId,
      {
        requestId: string;
        operation: 'connection_check' | 'connection_probe';
      }
    >(),
  );
  const chatBusyRef = useRef(chatBusy);
  chatBusyRef.current = chatBusy;

  const connectionBusy = isConnectionBusy(states);
  const activeProvider = busyProvider(states);
  // 認可待ちは長くロック。checking 中も短時間ロック（競合防止）
  const busy = connectionBusy || chatBusy;

  const clearActiveRequest = useCallback(
    (provider: ProviderId, requestId?: string) => {
      const active = activeRequestRefs.current.get(provider);
      if (!requestId || active?.requestId === requestId) {
        activeRequestRefs.current.delete(provider);
        abortRefs.current.delete(provider);
      }
    },
    [],
  );

  const abortProvider = useCallback(
    (provider: ProviderId, requestId?: string) => {
      const active = activeRequestRefs.current.get(provider);
      if (requestId && active?.requestId !== requestId) return;
      abortRefs.current.get(provider)?.abort();
      abortRefs.current.delete(provider);
      clearActiveRequest(provider, requestId);
    },
    [clearActiveRequest],
  );

  const abortAll = useCallback(() => {
    for (const controller of abortRefs.current.values()) {
      controller.abort();
    }
    abortRefs.current.clear();
    activeRequestRefs.current.clear();
  }, []);

  useEffect(() => {
    return () => {
      abortAll();
    };
  }, [abortAll]);

  useEffect(() => {
    const storage = getSessionStorage();
    if (!storage || !cacheIdentity) return;
    persistConnectionCache(storage, cacheIdentity, states);
  }, [cacheIdentity, states]);

  const applyChatEvent = useCallback((event: RuntimeEvent) => {
    if (event.type === 'auth_required' && event.provider) {
      if (!isHttpsAuthUrl(event.auth_url)) return;
      dispatch({
        type: 'apply_chat_auth_required',
        provider: event.provider,
        authUrl: event.auth_url,
      });
      return;
    }
    if (event.type === 'connection_status' && event.status === 'connected') {
      dispatch({
        type: 'apply_chat_connected',
        provider: event.provider,
        checkedAt: Date.now(),
      });
      return;
    }
    if (event.type === 'error' && event.provider) {
      dispatch({
        type: 'apply_chat_error',
        provider: event.provider,
        code: event.code ?? 'runtime_request_failed',
        message: event.data,
      });
    }
  }, []);

  const runConnectionRequest = useCallback(
    async (
      provider: ProviderId,
      operation: 'connection_check' | 'connection_probe',
    ) => {
      if (chatBusyRef.current) return;
      if (activeRequestRefs.current.has(provider)) return;

      if (operation === 'connection_probe') {
        if (
          activeRequestRefs.current.size > 0 ||
          isConnectionBusy(statesRef.current)
        ) {
          return;
        }
      } else if (
        isAuthorizationBusy(statesRef.current) ||
        [...activeRequestRefs.current.values()].some(
          (active) => active.operation === 'connection_probe',
        )
      ) {
        return;
      }
      if (!agentArn) {
        dispatch({
          type: 'set_error',
          provider,
          code: 'runtime_request_failed',
        });
        return;
      }

      const controller = new AbortController();
      abortRefs.current.set(provider, controller);
      const requestId = crypto.randomUUID();
      const runtimeSessionId = crypto.randomUUID();
      activeRequestRefs.current.set(provider, { requestId, operation });

      let sawTerminal = false;

      const isActive = () => {
        const active = activeRequestRefs.current.get(provider);
        return (
          !controller.signal.aborted &&
          !!active &&
          active.requestId === requestId
        );
      };

      dispatch({ type: 'start_check', provider, requestId });

      try {
        const session = await fetchAuthSession();
        if (!isActive()) return;
        const token = session.tokens?.accessToken?.toString() ?? '';

        await invokeRuntime({
          payload: { operation, provider },
          runtimeSessionId,
          accessToken: token,
          agentArn,
          region,
          signal: controller.signal,
          onEvent: async (event) => {
            if (!isActive()) return;

            if (event.type === 'auth_required') {
              if (operation !== 'connection_probe') {
                // connection_check は auth_required を返さない想定
                return;
              }

              dispatch({
                type: 'apply_event',
                provider,
                requestId,
                event,
              });

              if (!isHttpsAuthUrl(event.auth_url)) {
                sawTerminal = true;
                dispatch({
                  type: 'set_error',
                  provider,
                  requestId,
                  code: 'invalid_authorization_url',
                });
                abortProvider(provider, requestId);
                return;
              }

              try {
                const pending = await fetch(`${apiUrl}/auth/pending`, {
                  method: 'POST',
                  headers: { Authorization: `Bearer ${token}` },
                  signal: controller.signal,
                });
                if (!isActive()) return;
                if (!pending.ok) {
                  sawTerminal = true;
                  dispatch({
                    type: 'set_error',
                    provider,
                    requestId,
                    code: 'pending_registration_failed',
                  });
                  abortProvider(provider, requestId);
                  return;
                }
                dispatch({
                  type: 'auth_url_ready',
                  provider,
                  requestId,
                  authUrl: event.auth_url,
                });
              } catch {
                if (!isActive()) return;
                sawTerminal = true;
                dispatch({
                  type: 'set_error',
                  provider,
                  requestId,
                  code: 'pending_registration_failed',
                });
                abortProvider(provider, requestId);
              }
              return;
            }

            if (
              event.type === 'connection_status' ||
              (event.type === 'error' &&
                (event.scope === 'connection' || event.provider === provider))
            ) {
              if (isTerminalConnectionEvent(event, provider)) {
                sawTerminal = true;
              }
              dispatch({
                type: 'apply_event',
                provider,
                requestId,
                event,
                checkedAt: isTerminalConnectionEvent(event, provider)
                  ? Date.now()
                  : undefined,
              });
              if (sawTerminal) {
                clearActiveRequest(provider, requestId);
              }
            }
          },
        });

        if (controller.signal.aborted) return;

        if (isActive() && !sawTerminal) {
          dispatch({
            type: 'set_error',
            provider,
            requestId,
            code: 'runtime_request_failed',
            message: ERROR_COPY.runtime_request_failed,
          });
          clearActiveRequest(provider, requestId);
        }
      } catch {
        if (controller.signal.aborted || sawTerminal || !isActive()) return;
        dispatch({
          type: 'set_error',
          provider,
          requestId,
          code: 'runtime_request_failed',
          message: ERROR_COPY.runtime_request_failed,
        });
        clearActiveRequest(provider, requestId);
      }
    },
    [abortProvider, agentArn, apiUrl, clearActiveRequest, region],
  );

  const startCheck = useCallback(
    (provider: ProviderId) =>
      runConnectionRequest(provider, 'connection_check'),
    [runConnectionRequest],
  );

  const startProbe = useCallback(
    (provider: ProviderId) =>
      runConnectionRequest(provider, 'connection_probe'),
    [runConnectionRequest],
  );

  const startCheckRef = useRef(startCheck);
  startCheckRef.current = startCheck;

  const autoCheck = useMemo(
    () =>
      createAutoCheckScheduler({
        getStatus: (provider) => statesRef.current[provider].status,
        isCached: (provider) =>
          statesRef.current[provider].cached === true,
        isChatBusy: () => chatBusyRef.current,
        isAuthorizationBusy: () => isAuthorizationBusy(statesRef.current),
        startCheck: (provider) => startCheckRef.current(provider),
      }),
    [],
  );

  const onPanelOpened = useCallback(() => {
    void autoCheck.request();
  }, [autoCheck]);

  useEffect(() => {
    if (!chatBusy) {
      void autoCheck.onChatIdle();
    }
  }, [autoCheck, chatBusy]);

  const canStartProvider = useCallback(
    (
      provider: ProviderId,
      action: ProviderActionKind,
    ) => {
      const activeRequests = [...activeRequestRefs.current.values()];
      return canStartProviderAction(states, provider, action, {
        chatBusy,
        activeRequestCount: activeRequests.length,
        probeActive: activeRequests.some(
          (active) => active.operation === 'connection_probe',
        ),
      });
    },
    [chatBusy, states],
  );

  return {
    states,
    busy,
    activeProvider,
    startCheck,
    startProbe,
    onPanelOpened,
    applyChatEvent,
    canStartProvider,
    errorCopy: ERROR_COPY,
  };
}
