import { useEffect, useRef, useState } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { withAuthenticator, type WithAuthenticatorProps } from '@aws-amplify/ui-react';
import { Streamdown } from 'streamdown';
import outputs from '../amplify_outputs.json';

const custom = (
  outputs as {
    custom: { sessionBindingApiUrl: string; agentArn?: string };
  }
).custom;
const API_URL = custom.sessionBindingApiUrl;
const AGENT_ARN = custom.agentArn ?? '';
const REGION = AGENT_ARN.split(':')[3] || 'us-east-1';

const SESSION_HEADER = 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id';
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

const providerFromUrl = (url: string) => {
  if (url.includes('slack.com')) return 'Slack';
  if (url.includes('github.com')) return 'GitHub';
  if (url.includes('google.com')) return 'Google';
  return '外部サービス';
};

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  authUrl?: string;
}

const GitHubMark = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
  </svg>
);

function App({ signOut }: WithAuthenticatorProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState(() => getOrCreateSessionId());
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const handleNewConversation = () => {
    const newId = resetSessionId();
    setSessionId(newId);
    setMessages([]);
    setInput('');
  };

  const send = async () => {
    if (!input.trim() || loading || !AGENT_ARN) return;
    const text = input.trim();
    setInput('');
    setLoading(true);
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: 'user', content: text },
    ]);

    try {
      const session = await fetchAuthSession();
      const token = session.tokens?.accessToken?.toString() ?? '';

      const url =
        `https://bedrock-agentcore.${REGION}.amazonaws.com/runtimes/` +
        `${encodeURIComponent(AGENT_ARN)}/invocations?qualifier=DEFAULT`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          [SESSION_HEADER]: sessionId,
        },
        body: JSON.stringify({ prompt: text }),
      });

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let assistantText = '';
      let assistantId = crypto.randomUUID();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of decoder
          .decode(value, { stream: true })
          .split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const event = JSON.parse(line.slice(6));

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
            await fetch(`${API_URL}/auth/pending`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}` },
            });
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: 'assistant',
                content:
                  `${providerFromUrl(event.auth_url)}へのアクセス許可が必要です。` +
                  'リンクから認可を完了すると処理を続行します。',
                authUrl: event.auth_url,
              },
            ]);
          } else if (event.type === 'error') {
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: 'assistant',
                content: `エラーが発生しました: ${event.data}`,
              },
            ]);
          }
        }
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="chat-shell">
      <header className="chat-header">
        <span className="brand">3LO Agent</span>
        <div className="header-actions">
          <button
            type="button"
            className="ghost-btn"
            onClick={handleNewConversation}
            disabled={loading}
          >
            新しい会話
          </button>
          <button type="button" className="ghost-btn" onClick={signOut}>
            ログアウト
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
                >
                  {s}
                </button>
              ))}
            </div>
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
                <Streamdown linkSafety={{ enabled: false }}>{m.content}</Streamdown>
              ) : (
                m.content
              )}
            </div>
            {m.authUrl && (
              <div className="auth-card">
                <p>
                  認可は{providerFromUrl(m.authUrl)}
                  の画面で行われ、完了後に自動で処理を再開します
                </p>
                <a
                  className="auth-btn"
                  href={m.authUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {providerFromUrl(m.authUrl) === 'GitHub' && <GitHubMark />}
                  {providerFromUrl(m.authUrl)}で認可する
                </a>
              </div>
            )}
          </div>
        ))}

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
            disabled={!AGENT_ARN}
          />
          <button type="submit" disabled={loading || !AGENT_ARN}>
            送信
          </button>
        </form>
      </div>
    </div>
  );
}

export default withAuthenticator(App);
