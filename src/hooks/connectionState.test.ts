import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canStartProviderAction,
  connectionReducer,
  createInitialConnectionState,
  isConnectionBusy,
} from './connectionState';

describe('connectionReducer', () => {
  it('確認開始で checking になる', () => {
    const next = connectionReducer(createInitialConnectionState(), {
      type: 'start_check',
      provider: 'github',
      requestId: 'r1',
    });
    assert.equal(next.github.status, 'checking');
    assert.equal(isConnectionBusy(next), true);
  });

  it('全遷移を辿れる', () => {
    let state = createInitialConnectionState();
    state = connectionReducer(state, {
      type: 'start_check',
      provider: 'slack',
      requestId: 'r1',
    });
    state = connectionReducer(state, {
      type: 'apply_event',
      provider: 'slack',
      requestId: 'r1',
      event: {
        type: 'auth_required',
        provider: 'slack',
        auth_url: 'https://slack.com/oauth',
      },
    });
    assert.equal(state.slack.status, 'authorization_required');
    assert.equal(state.slack.authUrl, undefined);

    state = connectionReducer(state, {
      type: 'auth_url_ready',
      provider: 'slack',
      requestId: 'r1',
      authUrl: 'https://slack.com/oauth',
    });
    assert.equal(state.slack.authUrl, 'https://slack.com/oauth');

    state = connectionReducer(state, {
      type: 'apply_event',
      provider: 'slack',
      requestId: 'r1',
      event: {
        type: 'connection_status',
        provider: 'slack',
        status: 'connected',
      },
    });
    assert.equal(state.slack.status, 'connected');
  });

  it('古い request の event で新しい state を上書きしない', () => {
    let state = createInitialConnectionState();
    state = connectionReducer(state, {
      type: 'start_check',
      provider: 'github',
      requestId: 'new',
    });
    state = connectionReducer(state, {
      type: 'apply_event',
      provider: 'github',
      requestId: 'old',
      event: {
        type: 'connection_status',
        provider: 'github',
        status: 'connected',
      },
    });
    assert.equal(state.github.status, 'checking');
  });

  it('複数 provider の確認状態を同時に保持できる', () => {
    let state = createInitialConnectionState();
    state = connectionReducer(state, {
      type: 'start_check',
      provider: 'github',
      requestId: 'r1',
    });
    state = connectionReducer(state, {
      type: 'start_check',
      provider: 'slack',
      requestId: 'r2',
    });
    assert.equal(state.github.status, 'checking');
    assert.equal(state.slack.status, 'checking');
    assert.equal(isConnectionBusy(state), true);
  });

  it('別providerの確認中でも確認を並列開始できる', () => {
    const states = connectionReducer(createInitialConnectionState(), {
      type: 'start_check',
      provider: 'github',
      requestId: 'r1',
    });

    assert.equal(
      canStartProviderAction(states, 'slack', 'check', {
        chatBusy: false,
        activeRequestCount: 1,
        probeActive: false,
      }),
      true,
    );
    assert.equal(
      canStartProviderAction(states, 'slack', 'connect', {
        chatBusy: false,
        activeRequestCount: 1,
        probeActive: false,
      }),
      false,
    );
  });

  it('認可中は別providerの確認・認可を開始しない', () => {
    const states = connectionReducer(createInitialConnectionState(), {
      type: 'apply_chat_auth_required',
      provider: 'github',
      authUrl: 'https://github.com/login/oauth',
    });
    const options = {
      chatBusy: false,
      activeRequestCount: 1,
      probeActive: true,
    };

    assert.equal(
      canStartProviderAction(states, 'slack', 'check', options),
      false,
    );
    assert.equal(
      canStartProviderAction(states, 'slack', 'connect', options),
      false,
    );
  });

  it('キャッシュ表示を保ったまま再確認し、最新結果に置き換える', () => {
    let state = createInitialConnectionState({
      github: {
        status: 'connected',
        checkedAt: 100,
      },
    });
    assert.equal(state.github.cached, true);

    state = connectionReducer(state, {
      type: 'start_check',
      provider: 'github',
      requestId: 'r1',
    });
    assert.equal(state.github.status, 'connected');
    assert.equal(state.github.refreshing, true);

    state = connectionReducer(state, {
      type: 'apply_event',
      provider: 'github',
      requestId: 'r1',
      event: {
        type: 'connection_status',
        provider: 'github',
        status: 'checking',
      },
    });
    assert.equal(state.github.status, 'connected');
    assert.equal(state.github.refreshing, true);

    state = connectionReducer(state, {
      type: 'apply_event',
      provider: 'github',
      requestId: 'r1',
      checkedAt: 200,
      event: {
        type: 'connection_status',
        provider: 'github',
        status: 'not_connected',
      },
    });
    assert.equal(state.github.status, 'not_connected');
    assert.equal(state.github.cached, undefined);
    assert.equal(state.github.refreshing, undefined);
    assert.equal(state.github.checkedAt, 200);
  });

  it('https 以外の認可 URL を拒否する', () => {
    let state = createInitialConnectionState();
    state = connectionReducer(state, {
      type: 'start_check',
      provider: 'github',
      requestId: 'r1',
    });
    state = connectionReducer(state, {
      type: 'auth_url_ready',
      provider: 'github',
      requestId: 'r1',
      authUrl: 'http://insecure.example',
    });
    assert.equal(state.github.status, 'error');
    assert.equal(state.github.errorCode, 'invalid_authorization_url');
  });

  it('not_connected へ遷移でき busy ではない', () => {
    let state = createInitialConnectionState();
    state = connectionReducer(state, {
      type: 'start_check',
      provider: 'github',
      requestId: 'r1',
    });
    state = connectionReducer(state, {
      type: 'apply_event',
      provider: 'github',
      requestId: 'r1',
      event: {
        type: 'connection_status',
        provider: 'github',
        status: 'not_connected',
      },
    });
    assert.equal(state.github.status, 'not_connected');
    assert.equal(isConnectionBusy(state), false);
  });

  it('chat 起点 auth_required が同じ provider state へ反映される', () => {
    const state = connectionReducer(createInitialConnectionState(), {
      type: 'apply_chat_auth_required',
      provider: 'google_calendar',
      authUrl: 'https://accounts.google.com/o/oauth2',
    });
    assert.equal(state.google_calendar.status, 'authorization_required');
    assert.equal(
      state.google_calendar.authUrl,
      'https://accounts.google.com/o/oauth2',
    );
  });

  it('chat 起点の authorization_timeout で error になり busy が解ける', () => {
    let state = connectionReducer(createInitialConnectionState(), {
      type: 'apply_chat_auth_required',
      provider: 'github',
      authUrl: 'https://github.com/login/oauth',
    });
    assert.equal(isConnectionBusy(state), true);

    state = connectionReducer(state, {
      type: 'apply_chat_error',
      provider: 'github',
      code: 'authorization_timeout',
      message: '認可の待機時間を超えました。もう一度お試しください。',
    });
    assert.equal(state.github.status, 'error');
    assert.equal(state.github.errorCode, 'authorization_timeout');
    assert.equal(isConnectionBusy(state), false);
  });

  it('error から再試行できる', () => {
    let state = createInitialConnectionState();
    state = connectionReducer(state, {
      type: 'set_error',
      provider: 'github',
      code: 'provider_unavailable',
    });
    assert.equal(state.github.status, 'error');
    state = connectionReducer(state, {
      type: 'start_check',
      provider: 'github',
      requestId: 'r2',
    });
    assert.equal(state.github.status, 'checking');
  });
});
