import { useEffect, useRef, useState } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import outputs from '../amplify_outputs.json';

const API_URL = (outputs as { custom: { sessionBindingApiUrl: string } })
  .custom.sessionBindingApiUrl;

type Status = 'working' | 'done' | 'error';

export default function Callback() {
  const [status, setStatus] = useState<Status>('working');
  // コールバックURLにはsession_idしか含まれず対象サービスを特定できないため、
  // 文言はプロバイダー非依存にする
  const [message, setMessage] = useState('アカウント連携を完了しています…');
  // Session Bindingはワンタイム処理のため、StrictModeの二重実行を防ぐ
  const started = useRef(false);
  const mounted = useRef(false);
  const closeTimer = useRef<number | null>(null);
  const closeFallbackTimer = useRef<number | null>(null);

  useEffect(() => {
    mounted.current = true;
    const cleanup = () => {
      mounted.current = false;
      if (closeTimer.current !== null) {
        window.clearTimeout(closeTimer.current);
      }
      if (closeFallbackTimer.current !== null) {
        window.clearTimeout(closeFallbackTimer.current);
      }
    };

    if (started.current) return cleanup;
    started.current = true;

    (async () => {
      try {
        const sessionId = new URLSearchParams(window.location.search).get(
          'session_id'
        );
        if (!sessionId) {
          setStatus('error');
          setMessage('session_idが見つかりません');
          return;
        }

        const session = await fetchAuthSession();
        if (!mounted.current) return;
        const token = session.tokens?.accessToken?.toString();
        if (!token) {
          setStatus('error');
          setMessage(
            'ログインセッションが見つかりません。先にアプリへログインしてください。'
          );
          return;
        }

        const res = await fetch(`${API_URL}/auth/complete`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ session_id: sessionId }),
        });
        if (!mounted.current) return;

        if (!res.ok) {
          setStatus('error');
          setMessage(
            'アカウント連携に失敗しました。もう一度お試しください。'
          );
          return;
        }

        setStatus('done');
        setMessage(
          '元の画面でまもなく処理を再開します。このタブは自動で閉じます。'
        );
        closeTimer.current = window.setTimeout(() => {
          window.close();
          closeFallbackTimer.current = window.setTimeout(() => {
            setMessage(
              '連携は完了しています。自動で閉じられない場合は、このタブを閉じて元の画面へお戻りください。'
            );
          }, 500);
        }, 1000);
      } catch {
        if (!mounted.current) return;
        setStatus('error');
        setMessage(
          'アカウント連携に失敗しました。もう一度お試しください。'
        );
      }
    })();

    return cleanup;
  }, []);

  return (
    <div className="callback-shell" aria-live="polite">
      <div className="callback-card">
        <div className={`callback-icon ${status}`}>
          {status === 'done' ? '✓' : status === 'error' ? '!' : ''}
        </div>
        <h2>
          {status === 'done'
            ? 'アカウント連携が完了しました'
            : status === 'error'
              ? '連携に失敗しました'
              : 'アカウント連携を処理中'}
        </h2>
        <p>{message}</p>
        {status === 'done' && (
          <button
            type="button"
            className="callback-close"
            onClick={() => window.close()}
          >
            このタブを閉じる
          </button>
        )}
      </div>
    </div>
  );
}
