import { useEffect, useRef, useState } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import outputs from '../amplify_outputs.json';

const API_URL = (outputs as { custom: { sessionBindingApiUrl: string } })
  .custom.sessionBindingApiUrl;

type Status = 'working' | 'done' | 'error';

export default function Callback() {
  const [status, setStatus] = useState<Status>('working');
  const [message, setMessage] = useState('GitHub連携を完了しています…');
  // Session Bindingはワンタイム処理のため、StrictModeの二重実行を防ぐ
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      const sessionId = new URLSearchParams(window.location.search).get(
        'session_id'
      );
      if (!sessionId) {
        setStatus('error');
        setMessage('session_idが見つかりません');
        return;
      }

      const session = await fetchAuthSession();
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
      setStatus(res.ok ? 'done' : 'error');
      setMessage(
        res.ok
          ? 'このタブを閉じて元の画面にお戻りください。エージェントが自動で処理を再開します。'
          : 'GitHub連携に失敗しました。もう一度お試しください。'
      );
    })();
  }, []);

  return (
    <div className="callback-shell">
      <div className="callback-card">
        <div className={`callback-icon ${status}`}>
          {status === 'done' ? '✓' : status === 'error' ? '!' : ''}
        </div>
        <h2>
          {status === 'done'
            ? 'GitHub連携が完了しました'
            : status === 'error'
              ? '連携に失敗しました'
              : 'GitHub連携を処理中'}
        </h2>
        <p>{message}</p>
      </div>
    </div>
  );
}
