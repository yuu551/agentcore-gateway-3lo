import { useEffect, useRef, useState } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { withAuthenticator, type WithAuthenticatorProps } from '@aws-amplify/ui-react';
import { Streamdown } from 'streamdown';
import outputs from '../amplify_outputs.json';
import { ConnectionPanel } from './components/ConnectionPanel';
import { ProviderIcon } from './components/ProviderIcon';
import {
  displayNameFromAuthUrl,
  guessProviderFromUrl,
  PROVIDER_META,
} from './hooks/connectionState';
import { useConnectionManager } from './hooks/useConnectionManager';
import { invokeRuntime, isHttpsAuthUrl } from './lib/agentRuntime';
import type { ProviderId } from './types/runtime';

const custom = (
  outputs as {
    custom: { sessionBindingApiUrl: string; agentArn?: string };
  }
).custom;
const API_URL = custom.sessionBindingApiUrl;
const AGENT_ARN = custom.agentArn ?? '';
const REGION = AGENT_ARN.split(':')[3] || 'us-east-1';

const SESSION_STORAGE_KEY = 'agentcore-session-id';

function getOrCreateSessionId(): string {
  let id = sessionStorage.getItem(SESSION_STORAGE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(SESSION_STORAGE_KEY, id);
  }
  return id;
}

function resetSessionId(): string {
  const id = crypto.randomUUID();
  sessionStorage.setItem(SESSION_STORAGE_KEY, id);
  return id;
}

const SUGGESTIONS = [
  '私のリポジトリを教えて',
  'アサインされているIssueは？',
  'Slackで自分のメッセージを検索して',
  '今日の予定を教えて',
];

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  authUrl?: string;
  provider?: ProviderId;
}

function App({ signOut, user }: WithAuthenticatorProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState(() => getOrCreateSessionId());
  const [panelOpen, setPanelOpen] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);
  const connectionBtnRef = useRef<HTMLButtonElement>(null);
  const chatAbortRef = useRef<AbortController | null>(null);

  const connections = useConnectionManager({
    agentArn: AGENT_ARN,
    region: REGION,
    apiUrl: API_URL,
    cacheIdentity: user?.userId,
    chatBusy: loading,
  });

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  useEffect(() => {
    return () => {
      chatAbortRef.current?.abort();
      chatAbortRef.current = null;
    };
  }, []);

  const handleNewConversation = () => {
    const newId = resetSessionId();
    setSessionId(newId);
    setMessages([]);
    setInput('');
  };

  const chatLocked = loading || connections.busy;

  const pushAssistantError = (content: string) => {
    setMessages((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        content,
      },
    ]);
  };

  const send = async () => {
    if (!input.trim() || chatLocked || !AGENT_ARN) return;
    const text = input.trim();
    setInput('');
    setLoading(true);
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: 'user', content: text },
    ]);

    chatAbortRef.current?.abort();
    const controller = new AbortController();
    chatAbortRef.current = controller;

    const abortChat = () => {
      controller.abort();
      if (chatAbortRef.current === controller) {
        chatAbortRef.current = null;
      }
    };

    try {
      const session = await fetchAuthSession();
      if (controller.signal.aborted) return;
      const token = session.tokens?.accessToken?.toString() ?? '';

      let assistantText = '';
      let assistantId = crypto.randomUUID();

      await invokeRuntime({
        payload: { prompt: text },
        runtimeSessionId: sessionId,
        accessToken: token,
        agentArn: AGENT_ARN,
        region: REGION,
        signal: controller.signal,
        onEvent: async (event) => {
          if (controller.signal.aborted) return;

          if (
            event.type === 'connection_status' ||
            event.type === 'error'
          ) {
            connections.applyChatEvent(event);
          }

          if (event.type === 'text') {
            assistantText += event.data;
            setMessages((prev) => {
              const others = prev.filter((m) => m.id !== assistantId);
              return [
                ...others,
                { id: assistantId, role: 'assistant', content: assistantText },
              ];
            });
          } else if (event.type === 'tool_use') {
            assistantText = '';
            assistantId = crypto.randomUUID();
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === 'tool' && last.content === event.tool_name) {
                return prev;
              }
              return [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: 'tool',
                  content: event.tool_name,
                },
              ];
            });
          } else if (event.type === 'auth_required') {
            const provider =
              event.provider ?? guessProviderFromUrl(event.auth_url) ?? undefined;

            if (!isHttpsAuthUrl(event.auth_url)) {
              pushAssistantError('安全な認可 URL を確認できませんでした。');
              if (provider) {
                connections.applyChatEvent({
                  type: 'error',
                  provider,
                  code: 'invalid_authorization_url',
                  data: '安全な認可 URL を確認できませんでした。',
                  scope: 'chat',
                });
              }
              abortChat();
              return;
            }

            try {
              const pending = await fetch(`${API_URL}/auth/pending`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
                signal: controller.signal,
              });
              if (controller.signal.aborted) return;
              if (!pending.ok) {
                pushAssistantError(
                  '認可の準備に失敗しました。もう一度お試しください。',
                );
                if (provider) {
                  connections.applyChatEvent({
                    type: 'error',
                    provider,
                    code: 'pending_registration_failed',
                    data: '認可の準備に失敗しました。もう一度お試しください。',
                    scope: 'chat',
                  });
                }
                abortChat();
                return;
              }
            } catch {
              if (controller.signal.aborted) return;
              pushAssistantError(
                '認可の準備に失敗しました。もう一度お試しください。',
              );
              if (provider) {
                connections.applyChatEvent({
                  type: 'error',
                  provider,
                  code: 'pending_registration_failed',
                  data: '認可の準備に失敗しました。もう一度お試しください。',
                  scope: 'chat',
                });
              }
              abortChat();
              return;
            }

            // pending 成功後だけパネル状態と認可リンクを反映する
            connections.applyChatEvent(
              provider && !event.provider
                ? { ...event, provider }
                : event,
            );

            const label = provider
              ? PROVIDER_META[provider].label
              : displayNameFromAuthUrl(event.auth_url);

            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: 'assistant',
                content:
                  `${label}へのアクセス許可が必要です。` +
                  'リンクから認可を完了すると処理を続行します。',
                authUrl: event.auth_url,
                provider,
              },
            ]);
          } else if (event.type === 'error' && event.scope !== 'connection') {
            pushAssistantError(
              event.data.startsWith('エラーが発生しました:')
                ? event.data
                : `エラーが発生しました: ${event.data}`,
            );
          }
        },
      });
    } catch {
      if (!controller.signal.aborted) {
        pushAssistantError(
          'エラーが発生しました: 接続状態を確認できませんでした。',
        );
      }
    } finally {
      setLoading(false);
      if (chatAbortRef.current === controller) {
        chatAbortRef.current = null;
      }
    }
  };

  const authLabel = (m: Message) => {
    if (m.provider) return PROVIDER_META[m.provider].label;
    if (m.authUrl) return displayNameFromAuthUrl(m.authUrl);
    return '外部サービス';
  };

  return (
    <div className="chat-shell">
      <header className="chat-header">
        <span className="brand">3LO Agent</span>
        <div className="header-actions">
          <button
            ref={connectionBtnRef}
            type="button"
            className="ghost-btn"
            onClick={() => setPanelOpen(true)}
          >
            <span className="label-full">連携設定</span>
            <span className="label-short">連携</span>
          </button>
          <button
            type="button"
            className="ghost-btn"
            onClick={handleNewConversation}
            disabled={chatLocked}
          >
            <span className="label-full">新しい会話</span>
            <span className="label-short">新規</span>
          </button>
          <button type="button" className="ghost-btn" onClick={signOut}>
            <span className="label-full">ログアウト</span>
            <span className="label-short">ログアウト</span>
          </button>
        </div>
      </header>

      <main className="chat-log">
        {!AGENT_ARN && (
          <p className="notice">エージェントが未登録です</p>
        )}

        {messages.length === 0 && AGENT_ARN && (
          <div className="empty">
            <h2>何をお手伝いしましょう？</h2>
            <p>あなたのGitHub・Slack・Googleカレンダーの情報を調べます</p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="suggestion"
                  onClick={() => setInput(s)}
                  disabled={chatLocked}
                >
                  {s}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="empty-connect"
              onClick={() => setPanelOpen(true)}
            >
              先に外部サービスを連携する
            </button>
          </div>
        )}

        {messages.map((m) =>
          m.role === 'tool' ? (
            <div key={m.id} className="msg msg-tool">
              <span className="tool-chip">
                <span className="tool-prompt">&gt;_</span>
                {m.content}
              </span>
            </div>
          ) : (
            <div
              key={m.id}
              className={`msg ${m.role === 'user' ? 'msg-user' : 'msg-agent'}`}
            >
              <div className="msg-label">
                {m.role === 'user' ? 'YOU' : 'AGENT'}
              </div>
              <div className="msg-body">
                {m.role === 'assistant' ? (
                  <Streamdown linkSafety={{ enabled: false }}>
                    {m.content}
                  </Streamdown>
                ) : (
                  m.content
                )}
              </div>
              {m.authUrl && (
                <div className="auth-card">
                  <p>
                    認可は{authLabel(m)}
                    の画面で行われ、完了後に自動で処理を再開します
                  </p>
                  <a
                    className="auth-btn"
                    href={m.authUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {m.provider && <ProviderIcon provider={m.provider} />}
                    {authLabel(m)}で認可する
                  </a>
                </div>
              )}
            </div>
          ),
        )}

        {loading && (
          <div className="msg msg-agent">
            <div className="msg-label">AGENT</div>
            <div className="typing">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
        <div ref={logEndRef} />
      </main>

      <div className="composer">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="メッセージを入力"
            disabled={!AGENT_ARN || connections.busy}
          />
          <button type="submit" disabled={chatLocked || !AGENT_ARN}>
            送信
          </button>
        </form>
      </div>

      <ConnectionPanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        states={connections.states}
        canStartProvider={connections.canStartProvider}
        onCheck={connections.startCheck}
        onConnect={connections.startProbe}
        onOpened={connections.onPanelOpened}
        returnFocusRef={connectionBtnRef}
      />
    </div>
  );
}

export default withAuthenticator(App);
