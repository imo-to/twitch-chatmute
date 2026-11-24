// ==UserScript==
// @name         Twitch Chat mute +
// @author       imouto
// @namespace    https://greasyfork.org/users/imouto
// @version      1.5
// @description ワンクリックでユーザーをその場で即座にミュートします。ミュート時はコメントも一緒に消します。おまけ機能アリ（ NGワード / ニコニコ弾幕 / ボーナス自動回収 など ）
// @match        https://www.twitch.tv/*
// @match        https://dokorisu.2saku.tech/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @run-at       document-end
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  /* ================================================================
     どこリス連携
     ・Twitch側：ミュートリストの名前を Shift / Ctrl を押しながらクリックすると、
       どこリスのユーザー別統計を「今のタブから移動せずに」開く
     ・どこリスを別タブで開いている間はこのスクリプトが生存を通知していて、
       リクエストが来たら新しいタブを開かず、そのタブの中で統計ページへ移動する
  ================================================================ */
  const DOKORISU_REQ_KEY   = 'tm_dokorisu_req_v1';
  const DOKORISU_ALIVE_KEY = 'tm_dokorisu_alive_v1';
  function buildDokorisuUrl(login) {
    const y = new Date().getFullYear();
    return 'https://dokorisu.2saku.tech/users/stats?platform=twitch&year=' + y +
           '&q=' + encodeURIComponent(login);
  }
  if (location.hostname === 'dokorisu.2saku.tech') {
    const beat = () => { try { GM_setValue(DOKORISU_ALIVE_KEY, Date.now()); } catch (e) {} };
    beat();
    setInterval(beat, 5000);
    try {
      GM_addValueChangeListener(DOKORISU_REQ_KEY, (name, oldValue, newValue) => {
        try {
          const req = JSON.parse(newValue || '{}');
          if (req && req.login && Date.now() - (req.ts || 0) < 60000) {
            location.href = buildDokorisuUrl(req.login);
          }
        } catch (e) {}
      });
    } catch (e) {}
    return; // どこリス側では本体（Twitch用）は動かさない
  }
  function openDokorisuSearch(login) {
    const url = buildDokorisuUrl(login);
    let reused = false;
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(DOKORISU_REQ_KEY, JSON.stringify({ login, ts: Date.now() }));
        const alive = (typeof GM_getValue === 'function' && GM_getValue(DOKORISU_ALIVE_KEY, 0)) || 0;
        reused = Date.now() - alive < 12000;
      }
    } catch (e) {}
    if (!reused) {
      // Ctrl+クリック相当で開くと、Chromeでは後ろのタブで開いて今のタブから移動しない
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
      setTimeout(() => { try { a.remove(); } catch (e) {} }, 100);
    }
    showToast(reused ? `どこリスで検索しました：${login}` : `どこリスを別タブで開きました：${login}`);
  }

  /* ================================================================
     UI位置調整リスト
     ここを変更するだけで全UIの位置を一括で調整できます
     値の単位は全て px です。
  ================================================================ */
  const UI_POSITIONS = {
    // 🔧 設定ボタン（⚙アイコン / ゴミ箱アイコン）
    settingButton: {
      top:          10,    // 上端からの距離
      right:        410,   // 右端からの距離（autoCalc=false時 or anchor取得失敗時のフォールバック）
      autoCalc:     true,  // true: ヘッダーボタンの隣に自動配置 / false: 固定位置を使う
      autoOffset:   5,     // 自動計算時、隣接ボタンとの間隔
      // 仕様変更耐性: anchor取得失敗時、最後に成功した位置を覚えておく
      stickyOnFailure: true,
    },

    // 📋 メインパネル（ミュートリスト）
    mainPanel: {
      top:          55,    // 上端からの距離（プレイヤー取得失敗時のフォールバック）
      right:        345,   // 右端からの距離（プレイヤー取得失敗時のフォールバック）
      gap:          5,     // 配信プレイヤー右上との間隔（上下左右5px程度の余白）
      defaultHeight: 340,  // 初期高さ（localStorageに保存されてれば上書きされる）
    },

    // 👥 視聴中ユーザーパネル
    viewerPanel: {
      top:          55,    // 上端からの距離
      right:        345,   // 右端からの距離（フォールバック値）
      gap:          2,     // メインパネルとの間隔
      width:        200,   // パネル幅
      maxHeight:    360,   // 最大高さ
    },

    // ❗ トースト通知バナー
    toast: {
      mode:         'bottomRight', // 'bottomRight'（配信プレイヤー右下基準） or 'fixed'（座標指定）
      bottomMargin: 5,     // 下方向の余白（⚙やシアターモードボタンとの距離）
      rightMargin:  5,     // 右方向の余白
      // 'fixed' モード時の座標
      bottom:       40,
      right:        345,
      maxWidth:     280,
      // 仕様変更耐性: プレイヤー取得失敗時、最後に成功した位置を覚えておく
      stickyOnFailure: true,
    },
  };

  /* ================================================================
     コミュニティハイライト領域ブロックリスト
     ここに aria-label を追加するだけで、新しいバナーを簡単に非表示にできる。
     ALLOW_LABELS（残したいもの）に該当しないものは全て非表示にする方針。
     「ホワイトリスト方式」で、Twitchが新バナーを追加しても自動で消える。
  ================================================================ */
  const COMMUNITY_HIGHLIGHT_ALLOW = {
    // 残したい aria-label / class / data属性 / textContent のキーワード（部分一致・大文字小文字無視）
    // 1) コメントのピン留め（配信者がコメントをピン留めするやつ）
    // 2) 賭け要素（Prediction）
    keywords: [
      // ピン留め関連
      'pinned-chat',          // クラス名: pinned-chat__highlight-card 等
      'pinned',               // クラス名: pinned-message 等（英語UI）
      'ピン留め',              // 日本語UI
      'ピン留めされた',
      'ピン留めメッセージ',
      'pin this message',
      'unpin',
      'アンケート',
      // 予想/賭け
      'prediction',           // 英語UI / クラス名
      '予想',                  // 日本語UI
      'チャンネルポイント予想',
      'channel-points-prediction',
      // ハイライトメッセージ（ユーザーがチャンネルポイントで強調表示したコメント）
      'highlight-message',
      'highlighted-message',
      // 共通: メッセージ系コンテキスト
      'chat-message',
    ],
    // 上記キーワードを含む aria-label / data-test-selector / class / textContent を持つ要素は「残す」
  };

  /* ================================================================
     ユーティリティ
     - DEBUG: localStorage.tm_debug='1' でデバッグログを有効化
     - safeExec: エラーを握りつぶさず debug ログに出しつつ既定値を返す
     - EventBus / ListenerScope / schedule / domCache まわりの共通処理
  ================================================================ */
  const DEBUG = (() => {
    try { return localStorage.getItem('tm_debug') === '1'; } catch (_) { return false; }
  })();

  function logDebug(...args) { if (DEBUG) try { console.debug('[tm]', ...args); } catch (_) {} }
  function logWarn(...args) { try { console.warn('[tm]', ...args); } catch (_) {} }

  // エラーを黙殺せず debug ログに出す。既定値も返せる。
  function safeExec(fn, fallback, ctx) {
    try { return fn(); }
    catch (err) {
      logDebug('safeExec failed', ctx || '', err);
      return fallback;
    }
  }

  // safe() は下の「ヘルパー（汎用）」セクションで定義（内部は safeExec を利用）

  // EventTarget を使った簡易 EventBus
  const bus = new EventTarget();
  function busEmit(type, detail) { bus.dispatchEvent(new CustomEvent(type, { detail })); }
  function busOn(type, handler, opts) { bus.addEventListener(type, handler, opts); }

  /**
   * AbortController のラッパ。addEventListener を一括破棄できる。
   * ドラッグ・リサイズ・チャット監視で個別に MutationObserver を作っていたのを
   * AbortSignal に集約することでリークを完全に断つ。
   */
  class ListenerScope {
    constructor() { this._ac = new AbortController(); this._disposed = false; this._extra = []; }
    get signal() { return this._ac.signal; }
    on(target, type, handler, opts) {
      if (this._disposed) return;
      const o = Object.assign({}, opts || {}, { signal: this._ac.signal });
      try { target.addEventListener(type, handler, o); }
      catch (err) { logDebug('ListenerScope.on failed', type, err); }
    }
    /** MutationObserver 等の追加リソースも同じスコープでライフサイクル管理する */
    add(cleanup) {
      if (typeof cleanup === 'function') this._extra.push(cleanup);
    }
    dispose() {
      if (this._disposed) return;
      this._disposed = true;
      try { this._ac.abort(); } catch (_) {}
      for (const fn of this._extra) { try { fn(); } catch (_) {} }
      this._extra.length = 0;
    }
  }

  /** rAF を coalescing する簡易スケジューラ */
  function makeRafScheduler(fn) {
    let scheduled = false;
    return () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; try { fn(); } catch (err) { logWarn('scheduler fn failed', err); } });
    };
  }

  /** 1行あたりの extractUserFromRow / extractMessageText 結果を保持する WeakMap キャッシュ。
   *  DOM が消えると自動的に GC 対象になる。 */
  const rowCache = new WeakMap();
  function getRowUser(row) {
    if (!row) return null;
    let cached = rowCache.get(row);
    if (cached && 'user' in cached) return cached.user;
    const u = _extractUserFromRowInternal(row);
    if (!cached) { cached = {}; rowCache.set(row, cached); }
    cached.user = u;
    return u;
  }
  function getRowMessage(row) {
    if (!row) return '';
    let cached = rowCache.get(row);
    if (cached && 'msg' in cached) return cached.msg;
    const m = _extractMessageTextInternal(row);
    if (!cached) { cached = {}; rowCache.set(row, cached); }
    cached.msg = m;
    return m;
  }
  // スタンプ（IMGのalt）を含まない「生の文字だけ」の本文。繰り返し判定専用。
  function getRowPlainText(row) {
    if (!row) return '';
    let cached = rowCache.get(row);
    if (cached && 'plain' in cached) return cached.plain;
    const m = _extractPlainTextInternal(row);
    if (!cached) { cached = {}; rowCache.set(row, cached); }
    cached.plain = m;
    return m;
  }
  function invalidateRowCache(row) {
    if (row) rowCache.delete(row);
  }

  /* ================================================================
     定数 / ストレージキー
  ================================================================ */
  const STORAGE_KEY  = 'tm_twitch_chat_mute_state_v2';
  const BACKUP_KEY   = 'tm_twitch_chat_mute_state_backup_v2';
  const ENABLED_KEY  = 'tm_twitch_chat_mute_enabled_v1';
  const SORT_KEY     = 'tm_twitch_chat_mute_sort_v1';
  const PANEL_H_KEY  = 'tm_twitch_chat_panel_h_v1';
  const STICKY_POS_KEY = 'tm_twitch_sticky_positions_v1'; // 仕様変更耐性のためのスティッキー位置キャッシュ
  const MUTE_TO_BLOCK_FEATURE_KEY = 'tm_mute_to_block_feature_enabled_v1'; // 「ミュートリストをブロックに追加」機能のON/OFF（パネル内の設定画面から切替・デフォルトOFF）
  const QUESTION_MARK_HIDE_KEY = 'tm_hide_question_mark_only_enabled_v1'; // 「？」だけのコメント非表示のON/OFF（デフォルトON＝既存動作を維持）
  const COMMUNITY_HIGHLIGHT_HIDE_KEY = 'tm_hide_community_highlight_enabled_v1'; // コミュニティハイライト（ギフト/クリップ ランキングバナー等）非表示のON/OFF（デフォルトON＝既存動作を維持）
  const LONG_PRESS_COPY_KEY = 'tm_long_press_copy_enabled_v1'; // コメント長押しコピーのON/OFF（デフォルトON＝既存動作を維持）
  const NG_WORDS_KEY   = 'tm_ng_words_v1';      // NGワード一覧（文字列の配列。/〜/ 形式は正規表現として扱う）
  const CHAR_LIMIT_KEY = 'tm_char_limit_v1';    // 文字数制限の上限（0＝OFF。これより長いコメントを隠す）
  const REPEAT_HIDE_KEY = 'tm_repeat_hide_enabled_v1'; // 繰り返しコメント非表示のON/OFF（デフォルトON）
  const ASCII_ART_HIDE_KEY = 'tm_ascii_art_hide_v1'; // アスキーアート非表示のON/OFF（デフォルトON）
  const SUB_ONLY_KEY    = 'tm_sub_only_mode_v1';       // サブスク限定モードのON/OFF（デフォルトOFF）
  const REPLY_BTN_SHOW_KEY = 'tm_reply_btn_show_v1';   // 返信ボタン表示のON/OFF（デフォルトOFF＝非表示。ホバー時のミュートボタンと被るため）
  const STATS_KEY       = 'tm_filter_stats_v1';        // フィルターのヒット数（今日/累計）
  const CAROUSEL_HINT_KEY = 'tm_carousel_hint_done_v1'; // 左下カルーセルのヒントアニメーションを見せ終わったか
  const DANMAKU_KEY    = 'tm_danmaku_enabled_v1';      // 弾幕のON/OFF（デフォルトOFF。チャット入力欄下の弾幕ボタンで切替）
  const CUSTOM_HIDDEN_ENABLED_KEY = 'tm_custom_hidden_enabled_v1'; // 要素ピッカー一括ON/OFF（デフォルトON）
  const DANMAKU_SPEED_KEY = 'tm_danmaku_speed_v1';       // 弾幕の速度（10=等速、5〜20）
  const DANMAKU_OPACITY_KEY = 'tm_danmaku_opacity_v1';   // 弾幕の透明度（%、100=不透明）
  const DANMAKU_SIZE_KEY = 'tm_danmaku_size_v1';         // 弾幕の文字サイズ（px）
  const DANMAKU_MAX_KEY = 'tm_danmaku_max_v1';           // 弾幕の同時表示数
  const DANMAKU_USER_COLOR_KEY = 'tm_danmaku_user_color_v1'; // 弾幕にユーザー色を使うか（デフォルトOFF）
  const MAX_MUTED    = 1000000; // ブラウザのlocalStorage容量が実際の上限になる
  const PAGE_SIZE    = 100;
  const DEBOUNCE_MS  = 250;

  const FONT_STACK_JP = '"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif';

  const PANEL_H_MIN = 200;
  const PANEL_H_MAX = 700;
  const SAVE_DEBOUNCE_MS = 100;
  const ACTIVE_EXPIRE = 90000;
  const VIEWER_PANEL_REFRESH_MS = 5000;
  const VIEWER_CLEANUP_MS = 20000;
  const VOD_SWEEP_MS = 2000;

  const HIDDEN_ATTR_SEL = '[data-tm-vod-muted="1"]';

  const MAX_VIEWER_MSGS = 5;
  const LONG_PRESS_MS   = 300;

  /* ================================================================
     状態変数
  ================================================================ */
  let ngWords       = []; // NGワード一覧（文字列の配列）
  let _ngMatchers   = []; // NGワードのコンパイル済みマッチャー
  let mutedUsers    = new Set();
  // Object.create(null): "__proto__" 等がログイン名として渡された場合の
  // プロトタイプ汚染を防ぐ（M-1: 通常オブジェクトだと mutedDisplays["__proto__"] = {...}
  // で全体のプロトタイプが書き換わり、存在しないキーの参照まで壊れる）
  let mutedDisplays = Object.create(null);
  let muteEnabled   = true;
  let sortOrder     = 'newest';
  let panelHeight   = UI_POSITIONS.mainPanel.defaultHeight;

  const activeViewers = new Map();
  let _viewerPanelLocked = false;

  /* ================================================================
     ヘルパー（汎用）
  ================================================================ */
  // デバッグモードではログを出し、それ以外では黙殺する
  function safe(fn, fallback) {
    try { return fn(); }
    catch (err) { if (DEBUG) logDebug('safe() caught', err); return fallback; }
  }
  function lsGet(key) { return safe(() => localStorage.getItem(key), null); }
  // 書き込みの成否を返す（QuotaExceededError等を呼び出し側で検知できるように）
  function lsSet(key, value) {
    try { localStorage.setItem(key, value); return true; }
    catch (err) {
      if (DEBUG) logDebug('lsSet failed', key, err);
      return false;
    }
  }

  /* ================================================================
     仕様変更耐性: スティッキー位置キャッシュ
     最後に成功したUI位置を localStorage に保存しておき、
     Twitch側の仕様変更でanchor要素が取得できなくなっても
     直前の位置を維持できるようにする
  ================================================================ */
  let stickyPositions = (() => {
    const raw = lsGet(STICKY_POS_KEY);
    if (!raw) return {};
    return safe(() => JSON.parse(raw), {}) || {};
  })();

  function saveStickyPos(key, value) {
    if (value == null || !Number.isFinite(value)) return;
    stickyPositions[key] = { value, at: Date.now() };
    lsSet(STICKY_POS_KEY, JSON.stringify(stickyPositions));
  }

  function getStickyPos(key) {
    const e = stickyPositions[key];
    if (!e || !Number.isFinite(e.value)) return null;
    // 7日以上古いキャッシュは無視（UIレイアウト大変更時に古い位置に固定されないように）
    if (Date.now() - (e.at || 0) > 7 * 24 * 3600 * 1000) return null;
    return e.value;
  }

  function normalizeLogin(raw) {
    return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  }

  function normalizeDisplayEntry(raw, fb) {
    if (raw && typeof raw === 'object') {
      return {
        display:     typeof raw.display === 'string' && raw.display.trim() ? raw.display.trim() : (fb || ''),
        mutedAt:     typeof raw.mutedAt === 'number' ? raw.mutedAt : null,
        muteComment: typeof raw.muteComment === 'string' ? raw.muteComment : null,
        reason:      typeof raw.reason === 'string' ? raw.reason : null,
        auto:        raw.auto ? 1 : null
      };
    }
    return {
      display:     typeof raw === 'string' && raw.trim() ? raw.trim() : (fb || ''),
      mutedAt:     null,
      muteComment: null,
      reason:      null,
      auto:        null
    };
  }

  function getDisplay(login) {
    const e = mutedDisplays[login];
    if (!e) return login;
    return (typeof e === 'object' ? e.display : e) || login;
  }

  function getMutedAt(login) {
    const e = mutedDisplays[login];
    return (e && typeof e === 'object') ? (e.mutedAt || null) : null;
  }

  function getMuteComment(login) {
    const e = mutedDisplays[login];
    return (e && typeof e === 'object') ? (e.muteComment || null) : null;
  }

  function getMuteReason(login) {
    const e = mutedDisplays[login];
    return (e && typeof e === 'object') ? (e.reason || null) : null;
  }

  function formatMutedAt(ts) {
    if (!ts) return null;
    return new Date(ts).toLocaleString('ja-JP', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    });
  }

  function formatRelative(ts) {
    if (!ts) return null;
    const d = Date.now() - ts;
    const m   = Math.floor(d / 60000);
    const h   = Math.floor(d / 3600000);
    const day = Math.floor(d / 86400000);
    if (m   <  1) return '今';
    if (m   < 60) return `${m}分前`;
    if (h   < 24) return `${h}時間前`;
    if (day <  7) return `${day}日前`;
    if (day < 30) return `${Math.floor(day/7)}週間前`;
    if (day < 365) return `${Math.floor(day/30)}ヶ月前`;
    return `${Math.floor(day/365)}年前`;
  }

  function formatHHMM(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleTimeString('ja-JP', {
      timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false
    });
  }

  function escapeSelector(str) {
    if (window.CSS && CSS.escape) return CSS.escape(str);
    // CSS.escape がない旧ブラウザ向けフォールバック。
    // CSS Selectors Level 4 の escape 仕様に合わせてスペース・制御文字をハイフン代えナーに
    // 変換することで、英数字 + 下線 + ハイフン以外は安全にエスケープする。
    return String(str).replace(/[^a-zA-Z0-9_-]/g, (ch) => {
      const cp = ch.codePointAt(0);
      // 制御文字 / スペースは Unicode エスケープ \XX
      if (cp <= 0x1F || cp === 0x7F) return '\\' + cp.toString(16) + ' ';
      return '\\' + ch;
    });
  }

  function isVodPage() {
    return safe(() => /\/videos\/\d+/i.test(location.pathname), false);
  }

  function copyTextToClipboard(text) {
    if (!text) return Promise.reject(new Error('empty text'));
    // セキュアコンテキスト（HTTPS/localhost）でのみは Clipboard API を優先
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch((err) => {
        // フォーカス失い・権限拒否などのときは execCommand にフォールバック
        return _copyViaExecCommand(text);
      });
    }
    return _copyViaExecCommand(text);
  }

  function _copyViaExecCommand(text) {
    return new Promise((resolve, reject) => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      // iOS Safari 対策: -9999px だとキーボードが飛ぶことがあるので、見えない場所に小さく置く
      Object.assign(ta.style, {
        position: 'fixed', top: '0', left: '0', width: '1px', height: '1px',
        padding: '0', border: 'none', outline: 'none', boxShadow: 'none',
        background: 'transparent', opacity: '0'
      });
      document.body.appendChild(ta);
      try {
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
        const ok = document.execCommand('copy');
        if (ok) resolve();
        else reject(new Error('execCommand copy failed'));
      } catch (e) {
        reject(e);
      } finally {
        ta.remove();
      }
    });
  }

  // 内部実体。キャッシュなしで直接DOMを読む。外部からは getRowMessage() と extractMessageText() の両方で到達できる。
  function _extractMessageTextInternal(row) {
    if (!row || row.nodeType !== Node.ELEMENT_NODE) return '';
    try {
      const body = row.querySelector(
        '[data-a-target="chat-line-message-body"], .chat-line__message-body, .video-chat__message'
      );
      const root = body || row;
      const buf = [];
      const walk = (el) => {
        el.childNodes.forEach(node => {
          if (node.nodeType === Node.TEXT_NODE) {
            buf.push(node.textContent);
          } else if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.tagName === 'IMG') {
              const alt = node.getAttribute('alt');
              if (alt) buf.push(alt);
            } else {
              walk(node);
            }
          }
        });
      };
      walk(root);
      const t = buf.join('').trim();
      if (t) return t;
    } catch (_) {}
    return '';
  }
  // 後方互換エイリアス。内部では getRowMessage() を使うことでキャッシュする。
  function extractMessageText(row) { return _extractMessageTextInternal(row); }

  // _extractMessageTextInternal の「スタンプ除外」版。本文のテキストノードだけを集める。
  function _extractPlainTextInternal(row) {
    if (!row || row.nodeType !== Node.ELEMENT_NODE) return '';
    try {
      const body = row.querySelector(
        '[data-a-target="chat-line-message-body"], .chat-line__message-body, .video-chat__message'
      );
      const root = body || row;
      const buf = [];
      const walk = (el) => {
        el.childNodes.forEach(node => {
          if (node.nodeType === Node.TEXT_NODE) {
            buf.push(node.textContent);
          } else if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.tagName === 'IMG') return; // スタンプは数えない
            walk(node);
          }
        });
      };
      walk(root);
      return buf.join('').trim();
    } catch (_) {}
    return '';
  }

  /* ================================================================
     ストレージ
  ================================================================ */
  function coerceState(p) {
    if (!p || typeof p !== 'object') return null;
    return {
      users:    Array.isArray(p.users) ? p.users : [],
      displays: (p.displays && typeof p.displays === 'object') ? p.displays : {}
    };
  }

  function readStateFromKey(key) {
    const r = lsGet(key);
    if (!r) return null;
    return safe(() => coerceState(JSON.parse(r)), null);
  }

  function rebuildFromState(src) {
    const usersSet = new Set();
    const dispObj  = {};
    if (src) {
      for (const u of src.users) {
        const l = normalizeLogin(u);
        if (l) usersSet.add(l);
      }
      for (const [k, v] of Object.entries(src.displays || {})) {
        const l = normalizeLogin(k);
        if (l) dispObj[l] = normalizeDisplayEntry(v, l);
      }
    }
    const clean = [...usersSet].filter(u => u.length > 0 && u.length < 100);
    mutedUsers    = new Set(clean.slice(-MAX_MUTED));
    mutedDisplays = Object.create(null);
    for (const l of mutedUsers) mutedDisplays[l] = dispObj[l] || normalizeDisplayEntry(null, l);
    for (const k of Object.keys(mutedDisplays)) {
      if (!mutedUsers.has(k)) delete mutedDisplays[k];
    }
  }

  // M-2: persistMutedState() は loadAll() 初回実行時（このすぐ下）にも呼ばれるため、
  // _lastLocalPayload は loadAll より前で宣言する必要がある。
  // 以前は下の「タブ間リアルタイム同期」セクションで let 宣言していたため、
  // loadAll 経由の初回 persistMutedState() 呼び出しが TDZ の ReferenceError を
  // 毎回投げていた（safe() に握り潰されて実害はなかったが、将来行の順序が
  // 入れ替わると初期保存が丸ごと効かなくなる潜伏バグだった）。
  let _lastLocalPayload = null;
  let _storageQuotaWarned = false;
  function persistMutedState() {
    const payload = JSON.stringify({
      schema:    2,
      updatedAt: Date.now(),
      users:     [...mutedUsers],
      displays:  mutedDisplays
    });
    // 自動バックアップへの二重書き込みはせず本体保存のみ。
    // 定期的なバックアップは手動の書き出し（エクスポート）機能で行う想定。
    const ok = lsSet(STORAGE_KEY, payload);
    if (!ok) {
      // 容量超過などで保存に失敗した場合は警告（連続発火を防ぐため1セッション1回だけ）
      if (!_storageQuotaWarned) {
        _storageQuotaWarned = true;
        showToast('⚠️ ミュートリストの保存に失敗しました（ブラウザの保存容量上限の可能性）。書き出し機能で定期的にバックアップを取ることをおすすめします', 6000);
        logWarn('persistMutedState: lsSet failed, likely storage quota exceeded. users=', mutedUsers.size);
      }
    } else {
      _storageQuotaWarned = false;
    }
    // 自タブの書き込みを記録して、storage イベントのループバックを防ぐ
    _lastLocalPayload = payload;
    // 同一タブ内で別インスタンス（拡張機能版とTampermonkey版の併用など）が
    //   動いている場合、storage イベントは同一ドキュメント内では発火しない。
    //   そのため保存のたびにカスタムイベントでも通知する
    //   （受け側は _lastLocalPayload との比較で自分の保存分を無視する）。
    safe(() => document.dispatchEvent(new CustomEvent('tm-chatmute-state-saved')));
  }

  (function loadAll() {
    const enRaw = lsGet(ENABLED_KEY);
    muteEnabled = enRaw === null ? true : enRaw === '1';

    const sRaw = lsGet(SORT_KEY);
    if (sRaw === 'oldest' || sRaw === 'name') sortOrder = sRaw;

    const hRaw = parseInt(lsGet(PANEL_H_KEY), 10);
    if (Number.isFinite(hRaw) && hRaw >= PANEL_H_MIN && hRaw <= PANEL_H_MAX) panelHeight = hRaw;

    // BACKUP_KEY は読み込み時のフォールバックとしてのみ利用し、以降は書き込まない
    rebuildFromState(readStateFromKey(STORAGE_KEY) || readStateFromKey(BACKUP_KEY));
    loadNgWords();
    safe(() => { if (localStorage.getItem(BACKUP_KEY) !== null) localStorage.removeItem(BACKUP_KEY); });
    safe(() => persistMutedState());
  })();

  let _saveTimer = null;
  function saveMuted() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
      _saveTimer = null;
      safe(() => persistMutedState());
    }, SAVE_DEBOUNCE_MS);
  }
  function flushSave() {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    safe(() => persistMutedState());
  }
  window.addEventListener('beforeunload', flushSave);
  // モバイル/PWA では beforeunload が飛ばないケースがあるため、pagehide と visibilitychange も契約
  window.addEventListener('pagehide', flushSave);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSave();
  });

  function saveEnabled() { lsSet(ENABLED_KEY, muteEnabled ? '1' : '0'); }
  function saveSort()    { lsSet(SORT_KEY, sortOrder); }
  function savePanelH()  { lsSet(PANEL_H_KEY, String(panelHeight)); }

  /* ================================================================
     タブ間リアルタイム同期
  ================================================================ */
  // タブ間同期: storage イベントは他タブの変更のみファイアする。
  // 同期ループの防止のため、自分が書き込んだ直後の newValue と同一ならスキップする保険を入れる。
  // （_lastLocalPayload の宣言は M-2 対応のため persistMutedState() の直前に移動済み）
  window.addEventListener('storage', (e) => {
    if (!e || e.key !== STORAGE_KEY || !e.newValue) return;
    if (e.newValue === _lastLocalPayload) return; // 自タブ発の変更をイグノア（安全側ガード）
    let state = null;
    try {
      state = coerceState(JSON.parse(e.newValue));
    } catch (err) {
      logWarn('storage sync JSON parse failed', err);
      return;
    }
    if (!state) return;
    safeExec(() => {
      rebuildFromState(state);
      invalidateFilterCache();
      // M-6: パネルを開いたまま他タブでミュート操作された場合、
      // panelSnapshot が古い配列のままだと getSortedSnapshot() がそれを優先してしまい、
      // 表示に「存在しないユーザーが残る／追加されたユーザーが出ない」不整合が起きる。
      // パネルが開いている（panelSnapshot が生成済みの）場合のみ最新状態で作り直す。
      if (panelSnapshot) panelSnapshot = [...mutedUsers].reverse();
      if (panelElem) renderPage(true);
      safeExec(() => syncAllExistingChatRows(), undefined, 'syncAll after storage');
      showToast('🔄 他タブと同期しました');
    }, undefined, 'storage handler');
  });

  // 同一ドキュメント内同期: 拡張機能版とTampermonkey版を併用していると、
  //   片方でミュートしても、もう片方のパネルには storage イベントが届かず
  //   リストに反映されない（再読み込みで直る）問題への対策。
  //   persistMutedState() が発するカスタムイベントを受けて読み直す。
  document.addEventListener('tm-chatmute-state-saved', () => {
    safeExec(() => {
      const raw = lsGet(STORAGE_KEY);
      if (!raw || raw === _lastLocalPayload) return; // 自分の保存は無視
      let state = null;
      try { state = coerceState(JSON.parse(raw)); } catch (err) { return; }
      if (!state) return;
      rebuildFromState(state);
      invalidateFilterCache();
      if (panelSnapshot) panelSnapshot = [...mutedUsers].reverse();
      if (panelElem) renderPage(true);
      safeExec(() => syncAllExistingChatRows(), undefined, 'syncAll after local sync');
    }, undefined, 'local sync handler');
  });

  /* ================================================================
     トースト（配信プレイヤー右下に固定 / Twitch仕様変更耐性付き）
  ================================================================ */
  let _toastTimer = null;
  let _toastResizeHooked = false;

  function getPlayerBottomRightAnchor() {
    // 優先順に試みる: 安定なdata-*属性ベース → クラス名 → 動的クラス（部分一致）
    const playerSelectors = [
      '[data-a-target="video-player"]',
      '[data-a-player-state]',
      '[data-test-selector="video-player__video-layout"]',
      '.video-player',
      '.persistent-player',
      '.video-player__container',
      '.channel-root__player',
      // 動的クラス対応: 部分一致
      '[class*="video-player"]',
      '[class*="persistent-player"]',
    ];
    for (const sel of playerSelectors) {
      const el = safe(() => document.querySelector(sel), null);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width > 100 && rect.height > 100) {
        return {
          bottom: window.innerHeight - rect.bottom,
          right:  window.innerWidth  - rect.right,
        };
      }
    }
    return null;
  }

  // メインパネル（MUTE LIST）用: プレイヤー右上を基準にしたアンカー取得
  //   getPlayerBottomRightAnchor と同じセレクタ優先順位・判定基準を踏襲
  function getPlayerTopRightAnchor() {
    const playerSelectors = [
      '[data-a-target="video-player"]',
      '[data-a-player-state]',
      '[data-test-selector="video-player__video-layout"]',
      '.video-player',
      '.persistent-player',
      '.video-player__container',
      '.channel-root__player',
      '[class*="video-player"]',
      '[class*="persistent-player"]',
    ];
    for (const sel of playerSelectors) {
      const el = safe(() => document.querySelector(sel), null);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width > 100 && rect.height > 100) {
        return {
          top:   rect.top,
          right: window.innerWidth - rect.right,
        };
      }
    }
    return null;
  }

  // 消した要素パネル用: プレイヤー左上を基準にしたアンカー取得（右上版の鏡写し）
  function getPlayerTopLeftAnchor() {
    const playerSelectors = [
      '[data-a-target="video-player"]',
      '[data-a-player-state]',
      '[data-test-selector="video-player__video-layout"]',
      '.video-player',
      '.persistent-player',
      '.video-player__container',
      '.channel-root__player',
      '[class*="video-player"]',
      '[class*="persistent-player"]',
    ];
    for (const sel of playerSelectors) {
      const el = safe(() => document.querySelector(sel), null);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width > 100 && rect.height > 100) {
        return {
          top:  rect.top,
          left: rect.left,
        };
      }
    }
    return null;
  }

  // 消した要素パネルの位置決め。メインパネル（プレイヤー右上・gap分内側）の鏡写しで左上に置く
  function positionHiddenPanel(panel) {
    const cfg = UI_POSITIONS.mainPanel;
    const anchor = getPlayerTopLeftAnchor();
    if (anchor) {
      const top  = anchor.top  + cfg.gap;
      const left = anchor.left + cfg.gap;
      panel.style.top  = `${top}px`;
      panel.style.left = `${left}px`;
      saveStickyPos('hiddenPanel_top', top);
      saveStickyPos('hiddenPanel_left', left);
    } else {
      const st = getStickyPos('hiddenPanel_top');
      const sl = getStickyPos('hiddenPanel_left');
      panel.style.top  = `${st != null ? st : cfg.top}px`;
      panel.style.left = `${sl != null ? sl : 10}px`;
    }
  }

  // メインパネル（MUTE LIST）の初期位置決め。トーストのpositionToastと同じ
  //   sticky方式（プレイヤー取得失敗時は最後に成功した位置を使う）を踏襲
  function positionMainPanel(panel) {
    const cfg = UI_POSITIONS.mainPanel;
    const anchor = getPlayerTopRightAnchor();
    if (anchor) {
      const top   = anchor.top   + cfg.gap;
      const right = anchor.right + cfg.gap;
      panel.style.top   = `${top}px`;
      panel.style.right = `${right}px`;
      saveStickyPos('mainPanel_top', top);
      saveStickyPos('mainPanel_right', right);
    } else {
      const st = getStickyPos('mainPanel_top');
      const sr = getStickyPos('mainPanel_right');
      panel.style.top   = `${st != null ? st : cfg.top}px`;
      panel.style.right = `${sr != null ? sr : cfg.right}px`;
    }
  }

  function positionToast(t) {
    const cfg = UI_POSITIONS.toast;
    if (cfg.mode === 'bottomRight') {
      const anchor = getPlayerBottomRightAnchor();
      if (anchor) {
        const bottom = anchor.bottom + cfg.bottomMargin;
        const right  = anchor.right  + cfg.rightMargin;
        t.style.bottom = `${bottom}px`;
        t.style.right  = `${right}px`;
        // スティッキーキャッシュ更新
        if (cfg.stickyOnFailure) {
          saveStickyPos('toast_bottom', bottom);
          saveStickyPos('toast_right',  right);
        }
      } else if (cfg.stickyOnFailure) {
        // プレイヤー取得失敗時、最後に成功した位置を使う
        const sb = getStickyPos('toast_bottom');
        const sr = getStickyPos('toast_right');
        if (sb != null && sr != null) {
          t.style.bottom = `${sb}px`;
          t.style.right  = `${sr}px`;
        } else {
          t.style.bottom = `${cfg.bottomMargin}px`;
          t.style.right  = `${cfg.rightMargin}px`;
        }
      } else {
        t.style.bottom = `${cfg.bottomMargin}px`;
        t.style.right  = `${cfg.rightMargin}px`;
      }
    } else {
      t.style.bottom = `${cfg.bottom}px`;
      t.style.right  = `${cfg.right}px`;
    }
  }

  // トーストはキュー化：連続して showToast() されても前のメッセージが上書きされないよう
  //   短い間隔で順に表示し切る（UI体験は既存と同じ「1つのバナーに順次表示」を保つ）。
  const toastQueue = [];
  let _toastActive = false;

  function _ensureToastEl() {
    let t = document.getElementById('tm-toast');
    if (t) return t;
    t = document.createElement('div');
    t.id = 'tm-toast';
    // aria-live でスクリーンリーダーにもアナウンス
    t.setAttribute('role', 'status');
    t.setAttribute('aria-live', 'polite');
    Object.assign(t.style, {
      position:      'fixed',
      background:    'rgba(18,18,22,0.93)',
      color:         '#f0f0f0',
      padding:       '8px 14px',
      borderRadius:  '8px',
      fontSize:      '13px',
      zIndex:        '9999999',
      pointerEvents: 'none',
      opacity:       '0',
      transition:    'opacity 0.18s ease',
      maxWidth:      `${UI_POSITIONS.toast.maxWidth}px`,
      lineHeight:    '1.5',
      fontFamily:    FONT_STACK_JP,
      boxShadow:     '0 4px 14px rgba(0,0,0,0.4)'
    });
    document.body.appendChild(t);

    if (!_toastResizeHooked) {
      _toastResizeHooked = true;
      const reposToast = () => {
        const el = document.getElementById('tm-toast');
        if (el && el.style.opacity !== '0') positionToast(el);
      };
      window.addEventListener('resize', reposToast, { passive: true });
      // プレイヤーサイズ変化の追従を ResizeObserver で軽量化
      safeExec(() => {
        if (typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(() => reposToast());
        const tryAttach = () => {
          const candidates = [
            '[data-a-target="video-player"]',
            '.video-player',
            '.persistent-player',
            '.channel-root__player',
          ];
          for (const sel of candidates) {
            const el = document.querySelector(sel);
            if (el) { ro.observe(el); return true; }
          }
          return false;
        };
        if (!tryAttach()) {
          setTimeout(tryAttach, 1500);
          setTimeout(tryAttach, 4000);
        }
      }, undefined, 'toast ResizeObserver');
    }
    return t;
  }

  function _drainToastQueue() {
    if (_toastActive) return;
    const next = toastQueue.shift();
    if (!next) return;
    _toastActive = true;
    const t = _ensureToastEl();
    positionToast(t);
    t.textContent = next.msg;
    t.style.opacity = '1';
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => {
      t.style.opacity = '0';
      // フェードアウト後に次のトーストへ
      setTimeout(() => {
        _toastActive = false;
        _drainToastQueue();
      }, 220);
    }, next.duration);
  }

  function showToast(msg, duration = 2400) {
    if (!msg) return;
    // 連続同一メッセージはマージ（スパム防止）
    const tail = toastQueue[toastQueue.length - 1];
    if (tail && tail.msg === msg) return;
    // キュー長の上限を設けてメモリ暴走を防止（大量ミュート時の不具合回避）
    if (toastQueue.length >= 20) toastQueue.shift();
    toastQueue.push({ msg: String(msg), duration });
    _drainToastQueue();
  }

  /* ================================================================
     視聴中ミュートユーザー検知
  ================================================================ */
  function trackActiveViewer(login, display, messageText) {
    if (!mutedUsers.has(login)) return;
    const prev = activeViewers.get(login);

    const entry = {
      display:       display || (prev ? prev.display : login),
      lastSeen:      Date.now(),
      hasNew:        true,
      messages:      prev && Array.isArray(prev.messages) ? prev.messages : [],
      _msgsCollapsed: prev ? !!prev._msgsCollapsed : false
    };

    if (typeof messageText === 'string') {
      const t = messageText.trim();
      if (t) {
        const newest = entry.messages[0];
        if (!newest || newest.text !== t) {
          entry.messages.unshift({ text: t, ts: entry.lastSeen, _expanded: false });
          while (entry.messages.length > MAX_VIEWER_MSGS) entry.messages.pop();
        } else {
          newest.ts = entry.lastSeen;
        }
      }
    }

    activeViewers.set(login, entry);
    updateViewerHeaderBadge();
    if (viewerPanelElem) refreshViewerPanel();
  }

  function cleanExpiredViewers() {
    const now = Date.now();
    let changed = false;
    for (const [l, d] of activeViewers) {
      if (now - d.lastSeen > ACTIVE_EXPIRE) {
        activeViewers.delete(l);
        changed = true;
      }
    }
    if (changed) {
      updateViewerHeaderBadge();
      if (viewerPanelElem) refreshViewerPanel();
    }
  }
  setInterval(cleanExpiredViewers, VIEWER_CLEANUP_MS);

  function updateViewerHeaderBadge() {
    if (!panelElem) return;
    const hasNew = [...activeViewers.values()].some(v => v.hasNew) && activeViewers.size > 0;
    const viewerBtn = panelElem.querySelector('#tm-viewer-toggle-btn');
    if (!viewerBtn) return;

    let dot = viewerBtn.querySelector('.tm-viewer-dot');
    if (hasNew) {
      if (!dot) {
        dot = document.createElement('span');
        dot.className = 'tm-viewer-dot';
        viewerBtn.appendChild(dot);
      }
    } else if (dot) {
      dot.remove();
    }
  }

  /* ================================================================
     視聴者パネル
  ================================================================ */
  let viewerPanelElem        = null;
  let viewerPanelRefreshTimer = null;
  // 視聴中パネルのコメント内検索（フィルタ方式）。パネルを閉じても保持する。
  // 検索欄は refreshViewerPanel() が書き換える #tm-viewer-body の外に置くため、
  // 5秒ごとの自動再描画でも入力内容とフォーカスは維持される。
  let viewerSearchText      = '';
  let viewerSearchComposing = false;

  function openViewerPanel() {
    if (viewerPanelElem) { closeViewerPanel(); return; }

    for (const [, d] of activeViewers) d.hasNew = false;
    updateViewerHeaderBadge();

    const panel = document.createElement('div');
    viewerPanelElem = panel;
    panel.id = 'tm-viewer-panel';
    // アクセシビリティ
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', '視聴中のミュートユーザー');

    const VIEWER_W   = UI_POSITIONS.viewerPanel.width;
    const VIEWER_GAP = UI_POSITIONS.viewerPanel.gap;

    let initTop   = `${UI_POSITIONS.viewerPanel.top}px`;
    let initRight = `${UI_POSITIONS.viewerPanel.right}px`;

    if (panelElem) {
      const rect = panelElem.getBoundingClientRect();
      initTop   = `${Math.max(0, rect.top)}px`;
      initRight = `${Math.max(0, window.innerWidth - rect.left + VIEWER_GAP)}px`;
    }

    Object.assign(panel.style, {
      position:      'fixed',
      top:           initTop,
      right:         initRight,
      zIndex:        '9999998',
      width:         `${VIEWER_W}px`,
      maxHeight:     `${UI_POSITIONS.viewerPanel.maxHeight}px`,
      background:    'rgba(12,12,16,0.96)',
      border:        '1px solid rgba(255,255,255,0.1)',
      borderRadius:  '12px',
      overflow:      'hidden',
      boxShadow:     '0 8px 24px rgba(0,0,0,0.5)',
      fontFamily:    FONT_STACK_JP,
      display:       'flex',
      flexDirection: 'column',
      userSelect:    'none'
    });

    const hdr = document.createElement('div');
    hdr.className = 'tm-viewer-header';
    Object.assign(hdr.style, {
      display:        'flex',
      alignItems:     'center',
      justifyContent: 'space-between',
      padding:        '10px 12px 8px',
      borderBottom:   '1px solid rgba(255,255,255,0.07)',
      flexShrink:     '0',
      cursor:         'grab',
      userSelect:     'none'
    });

    const hdrTitle = document.createElement('span');
    Object.assign(hdrTitle.style, { fontSize: '13px', fontWeight: '600', color: '#f0f0f0' });
    hdrTitle.textContent = ' 視聴中のミュートユーザー';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    // アクセシビリティ
    closeBtn.setAttribute('aria-label', '閉じる');
    Object.assign(closeBtn.style, {
      fontSize:   '16px',
      color:      '#888',
      cursor:     'pointer',
      background: 'none',
      border:     'none',
      padding:    '0',
      lineHeight: '1',
      flexShrink: '0'
    });
    closeBtn.textContent = '✕';
    closeBtn.onclick = (e) => { e.stopPropagation(); closeViewerPanel(); };

    hdr.appendChild(hdrTitle);
    hdr.appendChild(closeBtn);
    panel.appendChild(hdr);

    // コメント内検索欄（ヘッダー直下・body の外なので再描画で消えない）
    const searchRow = document.createElement('div');
    Object.assign(searchRow.style, {
      display: 'flex', alignItems: 'center', gap: '6px',
      padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.07)',
      flexShrink: '0'
    });
    const viewerSearchInput = document.createElement('input');
    viewerSearchInput.type = 'text';
    viewerSearchInput.id = 'tm-viewer-search-input';
    viewerSearchInput.placeholder = 'コメントを検索';
    viewerSearchInput.title = 'コメント本文とユーザー名で検索';
    viewerSearchInput.value = viewerSearchText;
    Object.assign(viewerSearchInput.style, {
      flex: '1 1 auto', minWidth: '0', boxSizing: 'border-box',
      background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
      borderRadius: '6px', color: '#f0f0f0', fontSize: '12px',
      padding: '5px 8px', outline: 'none', fontFamily: FONT_STACK_JP,
      userSelect: 'text'
    });
    const viewerSearchBadge = document.createElement('span');
    viewerSearchBadge.id = 'tm-viewer-search-badge';
    Object.assign(viewerSearchBadge.style, {
      fontSize: '11px', color: '#999', flexShrink: '0',
      cursor: 'pointer', userSelect: 'none'
    });
    viewerSearchBadge.title = 'クリックで検索をクリア';
    viewerSearchBadge.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!viewerSearchText) return;
      viewerSearchText = '';
      viewerSearchInput.value = '';
      refreshViewerPanel();
      safe(() => viewerSearchInput.focus());
    });
    viewerSearchInput.addEventListener('compositionstart', () => { viewerSearchComposing = true; });
    viewerSearchInput.addEventListener('compositionend', (ev) => {
      viewerSearchComposing = false;
      viewerSearchText = ev.target.value;
      refreshViewerPanel();
    });
    viewerSearchInput.addEventListener('input', (ev) => {
      viewerSearchText = ev.target.value;
      if (!viewerSearchComposing) refreshViewerPanel();
    });
    viewerSearchInput.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Escape' && viewerSearchText) {
        viewerSearchText = '';
        viewerSearchInput.value = '';
        refreshViewerPanel();
      }
    });
    // パネルのドラッグ判定や外側クリック判定に巻き込まれないよう伝播を止める
    viewerSearchInput.addEventListener('mousedown', (e) => { e.stopPropagation(); });
    viewerSearchInput.addEventListener('click', (e) => { e.stopPropagation(); });
    searchRow.appendChild(viewerSearchInput);
    searchRow.appendChild(viewerSearchBadge);
    panel.appendChild(searchRow);

    const body = document.createElement('div');
    body.id = 'tm-viewer-body';
    Object.assign(body.style, {
      overflowY:  'auto',
      flex:       '1',
      padding:    '8px 12px',
      userSelect: 'none'
    });
    panel.appendChild(body);

    document.body.appendChild(panel);

    setupPanelDragWithGrab(panel, hdr);

    refreshViewerPanel();

    if (viewerPanelRefreshTimer) clearInterval(viewerPanelRefreshTimer);
    viewerPanelRefreshTimer = setInterval(() => {
      if (!viewerPanelElem) {
        clearInterval(viewerPanelRefreshTimer);
        viewerPanelRefreshTimer = null;
        return;
      }
      cleanExpiredViewers();
      refreshViewerPanel();
    }, VIEWER_PANEL_REFRESH_MS);
  }

  function closeViewerPanel() {
    if (viewerPanelRefreshTimer) {
      clearInterval(viewerPanelRefreshTimer);
      viewerPanelRefreshTimer = null;
    }
    if (viewerPanelElem) {
      safe(() => viewerPanelElem.remove());
      viewerPanelElem = null;
    }
    _viewerPanelLocked = false;
  }

  function refreshViewerPanel() {
    if (!viewerPanelElem) return;
    if (_viewerPanelLocked) return;
    const body = viewerPanelElem.querySelector('#tm-viewer-body');
    if (!body) return;
    body.innerHTML = '';

    // コメント内検索クエリ（本文＋ユーザー名が対象、ユーザー名一致時はその人の全件を残す）
    const vq = viewerSearchText.trim().toLowerCase();
    const setViewerSearchBadge = (n) => {
      const badge = viewerPanelElem.querySelector('#tm-viewer-search-badge');
      if (badge) badge.textContent = vq ? `${n}件 ✕` : '';
    };

    if (activeViewers.size === 0) {
      setViewerSearchBadge(0);
      const em = document.createElement('div');
      Object.assign(em.style, {
        fontSize:      '12px',
        color:         '#777',
        padding:       '10px 0',
        textAlign:     'center',
        pointerEvents: 'none',
        userSelect:    'none'
      });
      em.textContent = '発言を検知しています…';
      body.appendChild(em);
      return;
    }

    const sorted = [...activeViewers.entries()].sort((a, b) => b[1].lastSeen - a[1].lastSeen);
    let viewerMatchCount = 0;
    let viewerShownCount = 0;
    for (const [login, data] of sorted) {
      // 検索中は一致したコメントだけを残し、一致しないユーザーは丸ごと隠す
      let visibleMessages = Array.isArray(data.messages) ? data.messages : [];
      if (vq) {
        const userMatches =
          login.toLowerCase().includes(vq) ||
          (data.display || '').toLowerCase().includes(vq);
        if (!userMatches) {
          visibleMessages = visibleMessages.filter(m => (m.text || '').toLowerCase().includes(vq));
        }
        if (!visibleMessages.length) continue;
        viewerMatchCount += visibleMessages.length;
      }
      viewerShownCount++;
      const row = document.createElement('div');
      Object.assign(row.style, {
        display:        'flex',
        alignItems:     'flex-start',
        justifyContent: 'space-between',
        padding:        '6px 0',
        borderBottom:   '1px solid rgba(255,255,255,0.05)',
        userSelect:     'none'
      });

      const left = document.createElement('div');
      Object.assign(left.style, { overflow: 'hidden', flex: '1 1 auto', minWidth: '0' });

      const nameEl = document.createElement('div');
      Object.assign(nameEl.style, {
        fontSize:     '13px',
        color:        '#f0f0f0',
        fontWeight:   '400',
        overflow:     'hidden',
        textOverflow: 'ellipsis',
        whiteSpace:   'nowrap',
        userSelect:   'none',
        cursor:       'pointer'
      });
      nameEl.title = 'クリックでIDをコピー';
      nameEl.textContent = data.display !== login ? `${data.display} (${login})` : login;

      nameEl.addEventListener('click', (ev) => {
        ev.stopPropagation();
        copyTextToClipboard(login).then(
          () => {
            showToast(`📋 ${login} をコピーしました`);
            const prevFilter = nameEl.style.filter;
            nameEl.style.filter = 'brightness(0.5)';
            setTimeout(() => { nameEl.style.filter = prevFilter; }, 150);
          },
          () => showToast('コピー失敗')
        );
      });

      const timeEl = document.createElement('div');
      Object.assign(timeEl.style, {
        fontSize:   '11px',
        color:      '#777',
        marginTop:  '2px',
        userSelect: 'none'
      });
      timeEl.textContent = `発言: ${formatHHMM(data.lastSeen)}`;

      left.appendChild(nameEl);
      left.appendChild(timeEl);

      if (visibleMessages.length) {
        if (typeof data._msgsCollapsed === 'undefined') data._msgsCollapsed = false;

        const collapseBtn = document.createElement('div');
        Object.assign(collapseBtn.style, {
          fontSize:   '11px',
          color:      '#888',
          cursor:     'pointer',
          userSelect: 'none',
          marginTop:  '3px',
          display:    'inline-block',
          padding:    '0 2px'
        });
        const updateCollapseBtn = () => {
          collapseBtn.textContent = data._msgsCollapsed
            ? `▶ コメント ${visibleMessages.length}件`
            : `▼ コメント ${visibleMessages.length}件`;
        };
        updateCollapseBtn();
        collapseBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          data._msgsCollapsed = !data._msgsCollapsed;
          updateCollapseBtn();
          msgsBox.style.display = data._msgsCollapsed ? 'none' : 'flex';
        });

        const msgsBox = document.createElement('div');
        Object.assign(msgsBox.style, {
          marginTop:     '2px',
          display:       data._msgsCollapsed ? 'none' : 'flex',
          flexDirection: 'column',
          gap:           '2px'
        });

        visibleMessages.forEach((m) => {
          const msgEl = createMessageEl(m);
          msgsBox.appendChild(msgEl);
        });

        left.appendChild(collapseBtn);
        left.appendChild(msgsBox);
      }

      row.appendChild(left);
      body.appendChild(row);
    }

    setViewerSearchBadge(viewerMatchCount);
    if (vq && viewerShownCount === 0) {
      const em = document.createElement('div');
      Object.assign(em.style, {
        fontSize:      '12px',
        color:         '#777',
        padding:       '10px 0',
        textAlign:     'center',
        pointerEvents: 'none',
        userSelect:    'none'
      });
      em.textContent = '一致するコメントなし';
      body.appendChild(em);
    }
  }

  function createMessageEl(m) {
    const msgEl = document.createElement('div');

    const baseStyle = {
      fontSize:     '12px',
      color:        '#cfcfd3',
      lineHeight:   '1.35',
      padding:      '2px 5px',
      borderRadius: '4px',
      background:   'rgba(255,255,255,0.04)',
      cursor:       'pointer',
      userSelect:   'none',
      transition:   'background-color .15s ease'
    };
    Object.assign(msgEl.style, baseStyle);

    const applyExpanded = (expanded) => {
      if (expanded) {
        msgEl.style.whiteSpace   = 'normal';
        msgEl.style.wordBreak    = 'break-word';
        msgEl.style.overflow     = 'visible';
        msgEl.style.textOverflow = 'clip';
      } else {
        msgEl.style.whiteSpace   = 'nowrap';
        msgEl.style.wordBreak    = '';
        msgEl.style.overflow     = 'hidden';
        msgEl.style.textOverflow = 'ellipsis';
      }
    };

    msgEl.textContent = m.text;
    msgEl.title = '短押し: 全文表示';
    applyExpanded(!!m._expanded);

    msgEl.addEventListener('click', (e) => {
      e.stopPropagation();
      m._expanded = !m._expanded;
      applyExpanded(!!m._expanded);
    });

    return msgEl;
  }

  /* ================================================================
     書き出し / 読み込み
  ================================================================ */
  function downloadJsonFile(filename, dataObj) {
    let url = null;
    try {
      const blob = new Blob([JSON.stringify(dataObj, null, 2)], { type: 'application/json;charset=utf-8' });
      url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement('a'), { href: url, download: filename, rel: 'noopener' });
      // display:none だと Firefox でクリックがキャンセルされるケースがあるため body に一旦付ける
      document.body.appendChild(a);
      a.click();
      a.remove();
      // revokeObjectURL はダウンロード開始後十分时間を置いてから。
      //   ハンドラが保持するのはファイルダイアログが開くまでなので直後に revoke すると失敗するケースあり
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 60_000);
      return true;
    } catch (e) {
      logWarn('download failed', e);
      if (url) try { URL.revokeObjectURL(url); } catch (_) {}
      return false;
    }
  }

  function getMuteExportPayload() {
    return {
      schema:     2,
      exportedAt: Date.now(),
      enabled:    muteEnabled,
      users:      [...mutedUsers],
      displays:   mutedDisplays
    };
  }

  // High-1: このスクリプト自身がエクスポートしたファイル（schema:2）であることを必須にする。
  // これがないと、無関係な JSON（例: 空の {} や別ツールのファイル）を誤って選んでも
  // coerceState() が黙って users:[] にフォールバックし、「置換」で確認なしに
  // ミュートリスト全体が消失する事故が起きうる。
  function isValidMuteExportPayload(payload) {
    return !!payload && typeof payload === 'object' && payload.schema === 2;
  }

  function applyImportedMutePayload(payload, mode = 'replace') {
    if (!isValidMuteExportPayload(payload)) return { ok: false, reason: 'invalid-schema' };
    const state = coerceState(payload);
    if (!state) return { ok: false, reason: 'invalid-schema' };

    const inSet  = new Set();
    const inDisp = {};
    for (const u of state.users) {
      const l = normalizeLogin(u);
      if (l && /^[a-z0-9_]{1,25}$/.test(l)) inSet.add(l);
    }
    for (const [k, v] of Object.entries(state.displays || {})) {
      const l = normalizeLogin(k);
      if (l && inSet.has(l)) inDisp[l] = normalizeDisplayEntry(v, l);
    }

    // High-1: 「置換」で中身が0件のファイルを読み込むと、現在のミュートリストが
    // 確認なしに空で上書きされてしまう。既存データがある場合のみ明示確認を挟む。
    if (mode === 'replace' && inSet.size === 0 && mutedUsers.size > 0) {
      const proceed = confirm(
        `⚠️ このファイルには有効なユーザーが1件も含まれていません。\n` +
        `このまま「 置換 」すると、現在のミュートリスト（ ${mutedUsers.size}件 ）が空になります。\n\n` +
        `本当に続行しますか？`
      );
      if (!proceed) return { ok: false, reason: 'aborted-empty-replace' };
    }

    if (mode === 'replace') {
      mutedUsers    = new Set([...inSet].slice(-MAX_MUTED));
      mutedDisplays = Object.create(null);
      for (const l of mutedUsers) mutedDisplays[l] = inDisp[l] || normalizeDisplayEntry(null, l);
    } else {
      for (const l of inSet) {
        if (mutedUsers.has(l) || mutedUsers.size >= MAX_MUTED) continue;
        mutedUsers.add(l);
        mutedDisplays[l] = inDisp[l] || normalizeDisplayEntry(null, l);
      }
    }

    if (typeof payload.enabled === 'boolean' && mode === 'replace') {
      muteEnabled = payload.enabled;
      saveEnabled();
      updateSettingsIconLook();
    }

    invalidateFilterCache();
    persistMutedState();
    if (panelElem) renderPage(true);
    safe(() => syncAllExistingChatRows());
    return { ok: true, total: mutedUsers.size, incoming: inSet.size };
  }

  async function importMuteStateFromText(text, mode) {
    if (typeof text !== 'string' || !text.trim()) return { ok: false };
    // サイズ制限: 20MB 以上は強制拒否。DoS（巨大JSONを食わせてブラウザをハング）を防ぐ。
    if (text.length > 20 * 1024 * 1024) {
      logWarn('import: payload too large', text.length);
      return { ok: false };
    }
    try { return applyImportedMutePayload(JSON.parse(text), mode); }
    catch (err) {
      logDebug('import JSON.parse failed', err);
      return { ok: false };
    }
  }

  function openImportDialog() {
    let input = document.getElementById('tm-mute-import-input');
    if (!input) {
      input = Object.assign(document.createElement('input'), {
        id:     'tm-mute-import-input',
        type:   'file',
        accept: 'application/json,.json'
      });
      input.style.display = 'none';
      document.body.appendChild(input);
    }
    input.value = '';
    input.onchange = null;
    input.addEventListener('change', async function h() {
      input.removeEventListener('change', h);
      const file = input.files && input.files[0];
      input.value = '';
      if (!file) return;
      const text = await file.text().catch(() => null);
      if (!text) { alert('読み込み失敗'); return; }
      showMergeDialog(text);
    });
    input.click();
  }

  function showMergeDialog(text) {
    const ex = document.getElementById('tm-merge-dialog');
    if (ex) ex.remove();

    const overlay = document.createElement('div');
    overlay.id = 'tm-merge-dialog';
    // アクセシビリティ: モーダルダイアログとしてマーク
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'ミュートリストのインポート方法を選択');
    Object.assign(overlay.style, {
      position:       'fixed',
      inset:          '0',
      zIndex:         '10000000',
      background:     'rgba(0,0,0,0.6)',
      display:        'flex',
      alignItems:     'center',
      justifyContent: 'center'
    });

    const box = document.createElement('div');
    Object.assign(box.style, {
      background:   'rgba(18,18,22,0.98)',
      border:       '1px solid rgba(255,255,255,0.12)',
      borderRadius: '12px',
      padding:      '20px 22px',
      width:        '270px',
      color:        '#f5f5f5',
      fontFamily:   FONT_STACK_JP,
      fontSize:     '13px',
      lineHeight:   '1.6'
    });
    box.innerHTML = `
      <div style="font-weight:600;font-size:14px;margin-bottom:10px;">インポート方法を選択</div>
      <div style="margin-bottom:14px;color:#cfcfd3;font-size:12px;">既存のミュートリストを、</div>
      <div style="display:flex;flex-direction:column;gap:8px;">
        <button id="tm-import-merge"   style="padding:9px 12px;border-radius:8px;border:1px solid rgba(255,255,255,0.18);background:rgba(255,255,255,0.18);color:#f5f5f5;cursor:pointer;font-size:13px;text-align:left;">追加 ( 既存を残し新規分を追加 )</button>
        <button id="tm-import-replace" style="padding:9px 12px;border-radius:8px;border:1px solid rgba(255,255,255,0.18);background:rgba(255,255,255,0.18);color:#f5f5f5;cursor:pointer;font-size:13px;text-align:left;"> 置換 ( 既存リストを上書き )</button>
        <button id="tm-import-cancel"  style="padding:7px 12px;border-radius:8px;border:none;background:transparent;color:#888;cursor:pointer;font-size:12px;">キャンセル</button>
      </div>`;
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    // High-1: 失敗理由ごとにメッセージを出し分ける。
    // 「aborted-empty-replace」はユーザー自身が確認ダイアログでキャンセルした結果なので、
    // 追加で失敗アラートは出さない（二重に警告を出すと紛らわしいため）。
    const reportImportFailure = (r) => {
      if (!r || r.reason === 'aborted-empty-replace') return;
      if (r.reason === 'invalid-schema') {
        alert('このファイルはミュートリストのエクスポート形式ではないようです（スキーマ不一致）。\nこのスクリプトの「書き出し」で作成したファイルを選んでください。');
      } else {
        alert('読み込み失敗');
      }
    };

    const close = () => overlay.remove();
    document.getElementById('tm-import-merge').onclick = async () => {
      close();
      const r = await importMuteStateFromText(text, 'merge');
      if (r.ok) showToast(`✅ 追加しました：合計 ${r.total} 件`); else reportImportFailure(r);
    };
    document.getElementById('tm-import-replace').onclick = async () => {
      close();
      const r = await importMuteStateFromText(text, 'replace');
      if (r.ok) showToast(`✅ 置換しました：${r.total} 件`); else reportImportFailure(r);
    };
    document.getElementById('tm-import-cancel').onclick = close;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    // ESC でダイアログを閉じる。ダイアログが閉じられたらハンドラも外す
    const escOnDialog = (ev) => {
      if (ev.key === 'Escape') { ev.stopPropagation(); close(); }
    };
    document.addEventListener('keydown', escOnDialog);
    const dialogObs = new MutationObserver(() => {
      if (!overlay.isConnected) {
        document.removeEventListener('keydown', escOnDialog);
        dialogObs.disconnect();
      }
    });
    dialogObs.observe(document.body, { childList: true });
  }

  function exportMuteState() {
    const ts = new Date().toLocaleString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year:    'numeric', month: '2-digit', day: '2-digit',
      hour:    '2-digit', minute: '2-digit', second: '2-digit',
      hour12:  false
    }).replace(/[\/\s:]/g, '-');
    const ok = downloadJsonFile(`twitch_mute_backup_${ts}.json`, getMuteExportPayload());
    if (!ok) alert('書き出し失敗');
    else showToast(`📁 ${mutedUsers.size} 件を書き出しました`);
  }

  /* ================================================================
     フィルタキャッシュ
  ================================================================ */
  let _filterCache = { key: null, result: null };
  function invalidateFilterCache() { _filterCache = { key: null, result: null }; }

  /* ================================================================
     セレクタ
  ================================================================ */
  const LIVE_SEL = ['[data-a-target="chat-line-message"]', '[role="row"]'].join(', ');
  const VOD_SEL  = [
    '.video-chat__message',
    '[data-test-selector="video-chat-message"]',
    '.video-chat__message-list-wrapper li'
  ].join(', ');
  const CHAT_SEL = [LIVE_SEL, VOD_SEL].join(', ');

  function isVodChatRow(row) {
    if (!row || row.nodeType !== Node.ELEMENT_NODE) return false;
    if (safe(() => row.matches(VOD_SEL), false)) return true;
    if (safe(() => !!row.closest('.video-chat__message-list-wrapper,[data-test-selector="video-chat"],[data-a-target="video-chat"]'), false)) return true;
    return false;
  }

  function collectChatRows(node) {
    const rows = [];
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return rows;
    if (safe(() => node.matches(CHAT_SEL), false)) rows.push(node);
    safe(() => rows.push(...node.querySelectorAll(CHAT_SEL)));
    return rows;
  }

  function initialScan(container) {
    safe(() => batchProcess(Array.from(container.querySelectorAll(CHAT_SEL))));
  }

  /* ================================================================
     ユーザー取得
  ================================================================ */
  // 内部実体。キャッシュなしで直接DOMを読む。
  function _extractUserFromRowInternal(row) {
    if (!row) return null;

    try {
      const el = row.querySelector('[data-a-user]');
      if (el && el.dataset.aUser) {
        const l = el.dataset.aUser.trim().toLowerCase();
        if (!l) return null;
        return { login: l, display: (el.textContent || '').trim() || l };
      }
    } catch (_) {}

    try {
      if (!isVodChatRow(row) && !isVodPage()) return null;
      const nameEl = row.querySelector('[data-a-target="chat-message-username"],.chat-author__display-name,a[href*="/viewercard/"]');
      if (!nameEl) return null;

      const display = (nameEl.textContent || '').trim();
      let login = '';

      safe(() => {
        const du = nameEl.getAttribute('data-a-user');
        if (du) login = du.trim().toLowerCase();
      });

      if (!login) {
        safe(() => {
          const intl = row.querySelector('.chat-author__intl-login');
          if (intl) login = intl.textContent.trim().replace(/^\(|\)$/g, '').toLowerCase();
        });
      }

      if (!login) {
        safe(() => {
          const a = nameEl.closest('a') || (nameEl.tagName === 'A' ? nameEl : null);
          const href = a ? (a.getAttribute('href') || '') : '';
          const m = href.match(/\/viewercard\/([^/?#]+)/i);
          if (m) login = m[1].trim().toLowerCase();
        });
      }

      if (!login && display && /^[a-z0-9_]{1,25}$/i.test(display)) {
        login = display.toLowerCase();
      }

      if (!login) return null;
      return { login, display: display || login };
    } catch (_) {}

    return null;
  }
  // 後方互換エイリアス。新規コードは getRowUser() を使うことでキャッシュする。
  function extractUserFromRow(row) { return _extractUserFromRowInternal(row); }

  /* ================================================================
     VOD / ライブ 共通の表示制御
  ================================================================ */
  function hideVodChatLine(row) {
    if (row && row.nodeType === Node.ELEMENT_NODE) row.dataset.tmVodMuted = '1';
  }
  function showVodChatLine(row) {
    if (row && row.nodeType === Node.ELEMENT_NODE && row.dataset && row.dataset.tmVodMuted) {
      delete row.dataset.tmVodMuted;
    }
  }

  // 「？」だけのコメント判定用の共通正規表現（インライン生成を避けてGC負荷を減らす）
  const ONLY_QUESTION_MARK_RE = /^[?？]+$/;
  const LEADING_COLON_RE      = /^[：:]\s*/;

  function isOnlyQuestionMark(text) {
    if (!text) return false;
    return ONLY_QUESTION_MARK_RE.test(text.replace(LEADING_COLON_RE, ''));
  }

  /* ================================================================
     コンテンツフィルター（NGワード / 文字数制限 / 繰り返し検出）
     - 設定はすべてミュートリストパネル内の「コメント設定」画面で変更する
     - 判定は processChatLine / applyMuteStateToVodRow の共通フックから使う
  ================================================================ */
  // /〜/ 形式なら正規表現としてコンパイルする。壊れた正規表現は登録時に弾く前提だが、
  //   保存データが壊れていた場合に備えてここでも握りつぶして通常ワード扱いに落とす。
  function compileNgWords() {
    _ngMatchers = ngWords.map((w) => {
      const t = String(w).trim();
      if (t.length >= 2 && t.startsWith('/') && t.lastIndexOf('/') > 0) {
        try { return { raw: w, re: new RegExp(t.slice(1, t.lastIndexOf('/')), 'i') }; }
        catch (_) { /* fallthrough: 通常ワードとして扱う */ }
      }
      return { raw: w, needle: t.toLowerCase() };
    });
  }

  function loadNgWords() {
    ngWords = safe(() => {
      const raw = lsGet(NG_WORDS_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter(x => typeof x === 'string' && x.trim()) : [];
    }, []);
    compileNgWords();
  }

  function saveNgWords() {
    safe(() => lsSet(NG_WORDS_KEY, JSON.stringify(ngWords)));
    compileNgWords();
  }

  // /〜/ 形式の入力が正規表現として正しいか（追加時のバリデーション用）
  function isValidNgWordInput(w) {
    const t = String(w || '').trim();
    if (!t) return false;
    if (t.length >= 2 && t.startsWith('/') && t.lastIndexOf('/') > 0) {
      try { new RegExp(t.slice(1, t.lastIndexOf('/'))); } catch (_) { return false; }
    }
    return true;
  }

  function addNgWord(w) {
    const t = String(w || '').trim();
    if (!t || !isValidNgWordInput(t)) return false;
    const lower = t.toLowerCase();
    if (ngWords.some(x => x.toLowerCase() === lower)) return false; // 重複は追加しない
    ngWords.push(t);
    saveNgWords();
    return true;
  }

  function removeNgWord(w) {
    const before = ngWords.length;
    ngWords = ngWords.filter(x => x !== w);
    if (ngWords.length !== before) saveNgWords();
  }

  function matchNgWord(text) {
    if (!_ngMatchers.length || !text) return false;
    const lower = text.toLowerCase();
    for (const m of _ngMatchers) {
      if (m.re) { if (m.re.test(text)) return true; }
      else if (m.needle && lower.includes(m.needle)) return true;
    }
    return false;
  }

  function getCharLimit() {
    const n = parseInt(lsGet(CHAR_LIMIT_KEY), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  function setCharLimit(n) {
    safe(() => lsSet(CHAR_LIMIT_KEY, String(Math.max(0, n | 0))));
  }
  function isOverCharLimit(text) {
    const lim = getCharLimit();
    if (!lim || !text) return false;
    return [...text.trim()].length > lim;
  }

  function isRepeatHideEnabled() { return isFeatureEnabled(REPEAT_HIDE_KEY, true); }
  function setRepeatHideEnabled(v) { setFeatureEnabled(REPEAT_HIDE_KEY, v); }

  function isSubOnlyModeEnabled() { return isFeatureEnabled(SUB_ONLY_KEY, false); }
  function setSubOnlyModeEnabled(v) { setFeatureEnabled(SUB_ONLY_KEY, v); }

  // サブスク限定モードの表示可否：チャット行のバッジで判定する。
  // サブスクライバー / ファウンダー（初期サブスク）に加え、配信者 / モデレーター / VIP も表示する。
  // バッジ名は表示言語で変わるため、英語と日本語の両方を見る。
  const SUB_ONLY_OK_BADGE_RE = /subscriber|サブスクライバ|founder|ファウンダー|broadcaster|配信者|moderator|モデレーター|\bvip\b/i;
  function rowPassesSubOnly(row) {
    if (!row || !row.querySelectorAll) return false;
    const badgeImgs = row.querySelectorAll('img.chat-badge, [class*="chat-badge"] img, [data-test-selector*="badge"] img');
    for (const img of badgeImgs) {
      const name = img.getAttribute('alt') || img.getAttribute('title') || '';
      if (SUB_ONLY_OK_BADGE_RE.test(name)) return true;
      const wrap = img.closest && img.closest('[aria-label], [title]');
      const wrapName = wrap ? (wrap.getAttribute('aria-label') || wrap.getAttribute('title') || '') : '';
      if (wrapName && SUB_ONLY_OK_BADGE_RE.test(wrapName)) return true;
    }
    return false;
  }

  // 繰り返しコメント判定: 空白を除いた全文が「同じ文字列の繰り返し」で
  //   どれだけ埋まるか（カバー率）を見て、70%以上なら繰り返しとみなす。
  //   末尾の余分な文字や、最後の単位が途中で切れたものも拾える。
  //   ただし次は対象外：
  //   - 繰り返し単位が単一文字だけ（ｗｗｗ / 草草草 等の笑い表現）
  //   - 単位が「っ・ッ・ｯ」で終わるもの（ｱｯ / アッ 等の声・音の切れ端）
  //   - A2: 単位の「文字の種類 ÷ 単位の長さ」が3割未満の単調な単位
  //   門番（どれか1つ）：繰り返し4回以上 / 全体15文字以上 / 単位4文字以上で3回以上
  function isRepeatedComment(text) {
    if (!text) return false;
    const s = text.replace(/\s+/g, '');
    const len = s.length;
    if (len < 6) return false; // 最小単位2文字 × 3回
    for (let L = 1; L * 2 <= len; L++) {
      const unit = s.slice(0, L);
      const kinds = new Set(unit).size;
      if (kinds < 2) continue; // 単一文字の繰り返しは除外
      if (/[っッｯ]$/.test(unit)) continue; // 声系の単位は除外
      if (kinds / L < 0.3) continue; // A2: 単調すぎる単位は除外
      // カバー率：先頭から単位を並べていき、末尾の部分一致まで数える
      let covered = 0;
      let pos = 0;
      while (pos < len) {
        if (s.startsWith(unit, pos)) { covered += L; pos += L; continue; }
        const rest = s.slice(pos);
        let k = 0;
        while (k < rest.length && k < L && rest[k] === unit[k]) k++;
        if (k === rest.length) covered += k; // 末尾の部分一致だけ認める
        break;
      }
      if (covered / len < 0.7) continue; // 一致率70%未満は対象外
      const count = covered / L;
      if (count >= 4 || len >= 15 || (L >= 4 && count >= 3)) return true;
    }
    return false;
  }

  // アスキーアート判定：点字（⣿⠋等）・ブロック・罫線・図形の文字が
  //   10文字以上あり、全体の3割以上を占めていたらアスキーアートとみなす。
  //   絵文字のアート（🟥の並び等）は対象外（「点々した文字」だけを見る）。
  const ASCII_ART_CHAR_RE = /[\u2800-\u28FF\u2580-\u259F\u2500-\u257F\u25A0-\u25FF]/g;
  function isAsciiArtComment(text) {
    if (!text) return false;
    const s = String(text).replace(/\s+/g, '');
    if (s.length < 10) return false;
    const m = s.match(ASCII_ART_CHAR_RE);
    const n = m ? m.length : 0;
    return n >= 10 && n / s.length >= 0.3;
  }
  function isAsciiArtHideEnabled() { return isFeatureEnabled(ASCII_ART_HIDE_KEY, true); }
  function setAsciiArtHideEnabled(v) { setFeatureEnabled(ASCII_ART_HIDE_KEY, v); }

  function isReplyButtonShown() { return isFeatureEnabled(REPLY_BTN_SHOW_KEY, false); }
  function setReplyButtonShown(v) { setFeatureEnabled(REPLY_BTN_SHOW_KEY, v); }

  // NGワード / 文字数 / 繰り返し のいずれかに引っかかるか（理由つき）
  //   繰り返し判定だけは plainText（スタンプを除いた生の文字）で判定する。
  //   スタンプだけのコメントは plainText が空になるため、連投されても消えない。
  function getFilterReason(text, plainText) {
    if (!text) return null;
    if (matchNgWord(text)) return 'ng';
    if (isOverCharLimit(text)) return 'char';
    if (isRepeatHideEnabled() && isRepeatedComment(plainText != null ? plainText : text)) return 'repeat';
    if (isAsciiArtHideEnabled() && isAsciiArtComment(plainText != null ? plainText : text)) return 'aa';
    return null;
  }
  function isContentFiltered(text, plainText) {
    return getFilterReason(text, plainText) !== null;
  }

  /* ---------- フィルターのヒット数（今日 / 累計） ---------- */
  const FILTER_STAT_KINDS = ['question', 'ng', 'char', 'repeat', 'aa', 'subonly'];
  const FILTER_STAT_LABELS = { question: '？のみ', ng: 'NGワード', char: '文字数制限', repeat: '繰り返し', aa: 'アスキーアート', subonly: 'サブスク限定' };
  function emptyStatCounts() {
    const o = {};
    FILTER_STAT_KINDS.forEach(k => { o[k] = 0; });
    return o;
  }
  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function loadFilterStats() {
    let s = safe(() => JSON.parse(lsGet(STATS_KEY) || ''), null);
    if (!s || typeof s !== 'object') s = { day: todayKey(), today: emptyStatCounts(), total: emptyStatCounts() };
    if (!s.today) s.today = emptyStatCounts();
    if (!s.total) s.total = emptyStatCounts();
    FILTER_STAT_KINDS.forEach(k => {
      if (!(k in s.today)) s.today[k] = 0;
      if (!(k in s.total)) s.total[k] = 0;
    });
    if (s.day !== todayKey()) { s.day = todayKey(); s.today = emptyStatCounts(); }
    return s;
  }
  function countFilterHit(kind) {
    safe(() => {
      const s = loadFilterStats();
      if (!(kind in s.today)) return;
      s.today[kind] += 1;
      s.total[kind] += 1;
      lsSet(STATS_KEY, JSON.stringify(s));
    });
  }

  /* ---------- フィルターで非表示にしたコメントの実例（メモリのみ） ----------
     文字数制限 / 繰り返し / アスキーアート の3種を、種類ごとに新しい順で最大20件覚える。
     統計の名前を押すとオーバーレイで中身を確認できる（パネルのレイアウトは崩さない）。 */
  const _filterSamples = { char: [], repeat: [], aa: [] };
  function recordFilterSample(kind, user, text) {
    const arr = _filterSamples[kind];
    if (!arr) return;
    const t = (text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!t) return;
    arr.unshift({ user: user || '', text: t });
    if (arr.length > 20) arr.length = 20;
  }
  let _filterSamplesOpenKind = null;
  let _filterSamplesDownHandler = null;
  function closeFilterSamples() {
    const p = document.getElementById('tm-filter-samples');
    if (p) p.remove();
    _filterSamplesOpenKind = null;
    if (_filterSamplesDownHandler) {
      document.removeEventListener('pointerdown', _filterSamplesDownHandler, true);
      _filterSamplesDownHandler = null;
    }
  }
  function showFilterSamples(kind, anchorEl) {
    // 同じ項目をもう一度押したら閉じる（トグル）
    if (_filterSamplesOpenKind === kind && document.getElementById('tm-filter-samples')) {
      closeFilterSamples();
      return;
    }
    closeFilterSamples();
    _filterSamplesOpenKind = kind;
    const samples = _filterSamples[kind] || [];
    const pop = document.createElement('div');
    pop.id = 'tm-filter-samples';
    const head = document.createElement('div');
    head.className = 'tm-samples-head';
    head.textContent = `${FILTER_STAT_LABELS[kind] || kind} で非表示にしたコメント`;
    pop.appendChild(head);
    if (!samples.length) {
      const empty = document.createElement('div');
      empty.className = 'tm-samples-empty';
      empty.textContent = 'まだありません';
      pop.appendChild(empty);
    } else {
      samples.forEach(s => {
        const row = document.createElement('div');
        row.className = 'tm-sample-row';
        row.title = s.text;
        const u = document.createElement('span');
        u.className = 'tm-sample-user';
        u.textContent = s.user;
        const tx = document.createElement('span');
        tx.className = 'tm-sample-text';
        tx.textContent = s.text;
        row.appendChild(u);
        row.appendChild(tx);
        pop.appendChild(row);
      });
    }
    document.body.appendChild(pop);
    // アンカーの下に出し、画面の外にはみ出さないように収める
    safe(() => {
      const r = anchorEl.getBoundingClientRect();
      const pw = pop.offsetWidth || 264;
      const ph = pop.offsetHeight || 120;
      let left = Math.min(r.left, window.innerWidth - pw - 8);
      let top = r.bottom + 4;
      if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 4);
      pop.style.left = `${Math.max(8, left)}px`;
      pop.style.top = `${top}px`;
    });
    // 外側を押したら閉じる。ただし統計の名前ラベル上は、click側のトグルに任せるので閉じない
    // （pointerdownがclickより先に発火するため、ここで閉じると「押すたびに開く」不具合になる）
    _filterSamplesDownHandler = (e) => {
      if (pop.contains(e.target)) return;
      if (e.target && e.target.closest && e.target.closest('.tm-filter-stat-link')) return;
      closeFilterSamples();
    };
    document.addEventListener('pointerdown', _filterSamplesDownHandler, true);
  }

  /* ---------- キーボードショートカット（設定で変更可能） ----------
     デフォルト 単体キー P: ミュートリストパネル / N: 弾幕 / S: サブスク限定
     単体キーでも Ctrl/Alt/Shift との組み合わせでも割り当てられる（コメント設定で変更）。
     チャット入力中など、文字を打てる場所にフォーカスがある時は効かせない。 */
  const SHORTCUTS_KEY = 'tm_shortcuts_v1';
  const DEFAULT_SHORTCUTS = {
    panel:   { key: 'p', alt: false, ctrl: false, shift: false },
    danmaku: { key: 'n', alt: false, ctrl: false, shift: false },
    subonly: { key: 's', alt: false, ctrl: false, shift: false },
  };
  function getShortcuts() {
    const raw = safe(() => JSON.parse(lsGet(SHORTCUTS_KEY) || 'null'), null);
    const out = {};
    ['panel', 'danmaku', 'subonly'].forEach(a => {
      const d = DEFAULT_SHORTCUTS[a];
      const v = raw && raw[a];
      out[a] = (v && typeof v.key === 'string')
        ? { key: v.key, alt: !!v.alt, ctrl: !!v.ctrl, shift: !!v.shift }
        : { key: d.key, alt: d.alt, ctrl: d.ctrl, shift: d.shift };
    });
    return out;
  }
  function saveShortcut(action, binding) {
    const all = getShortcuts();
    all[action] = binding;
    safe(() => lsSet(SHORTCUTS_KEY, JSON.stringify(all)));
  }
  function formatShortcut(b) {
    if (!b || !b.key) return 'なし';
    const parts = [];
    if (b.ctrl) parts.push('Ctrl');
    if (b.alt) parts.push('Alt');
    if (b.shift) parts.push('Shift');
    parts.push(b.key.length === 1 ? b.key.toUpperCase() : b.key);
    return parts.join('+');
  }
  // イベントが割り当てと一致するか（修飾キーは完全一致、Metaは常に不一致）
  function shortcutMatches(e, b) {
    if (!b || !b.key || e.metaKey) return false;
    if (e.altKey !== !!b.alt || e.ctrlKey !== !!b.ctrl || e.shiftKey !== !!b.shift) return false;
    if (b.key.length === 1) return (e.key || '').toLowerCase() === b.key;
    return e.key === b.key;
  }
  let _shortcutCapture = null; // 設定中に待っているアクション名
  function initShortcuts() {
    document.addEventListener('keydown', (e) => {
      // キー設定のキャプチャ中は最優先で拾う
      if (_shortcutCapture) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') { _shortcutCapture = null; safe(() => renderPage(true)); return; }
        if (['Alt', 'Control', 'Shift', 'Meta'].includes(e.key)) return; // 修飾キー単体は組み合わせ待ち
        if (e.key === 'Backspace' || e.key === 'Delete') {
          saveShortcut(_shortcutCapture, { key: '', alt: false, ctrl: false, shift: false });
          _shortcutCapture = null;
          safe(() => renderPage(true));
          return;
        }
        if (e.metaKey) { _shortcutCapture = null; safe(() => renderPage(true)); return; }
        if (e.key) {
          saveShortcut(_shortcutCapture, {
            key: e.key.length === 1 ? e.key.toLowerCase() : e.key,
            alt: e.altKey, ctrl: e.ctrlKey, shift: e.shiftKey,
          });
        }
        _shortcutCapture = null;
        safe(() => renderPage(true));
        return;
      }
      if (e.metaKey || e.repeat) return;
      const t = e.target;
      if (t && t.closest && t.closest('input, textarea, select, [contenteditable], [data-a-target="chat-input"]')) return;
      if (t && t.isContentEditable) return;
      const sc = getShortcuts();
      const hit = ['panel', 'danmaku', 'subonly'].find(a => shortcutMatches(e, sc[a]));
      if (!hit) return;
      e.preventDefault();
      if (hit === 'panel') {
        const b = document.getElementById('tm-setting-icon');
        if (b) b.click();
      } else if (hit === 'danmaku') {
        setDanmakuEnabled(!isDanmakuEnabled());
        safe(() => updateDanmakuButtonLook());
      } else if (hit === 'subonly') {
        setSubOnlyModeEnabled(!isSubOnlyModeEnabled());
        safe(() => syncAllExistingChatRows());
      }
    }, true);
  }

  function applyMuteStateToVodRow(row) {
    if (!row || row.nodeType !== Node.ELEMENT_NODE) return;

    // キャッシュ版を使用してDOM walkを削減
    const msgText = getRowMessage(row).trim();

    if (isOnlyQuestionMark(msgText)) {
      hideVodChatLine(row);
      return;
    }
    if (isContentFiltered(msgText, getRowPlainText(row))) {
      hideVodChatLine(row);
      return;
    }
    const info = getRowUser(row);
    if (!info || !info.login) { showVodChatLine(row); return; }
    if (muteEnabled && mutedUsers.has(info.login)) hideVodChatLine(row);
    else                                            showVodChatLine(row);
  }

  function clearAllVodHiddenRows() {
    safe(() => document.querySelectorAll(HIDDEN_ATTR_SEL).forEach(showVodChatLine));
  }
  function syncAllExistingChatRows() {
    safe(() => document.querySelectorAll(CHAT_SEL).forEach(row => safe(() => processChatLine(row))));
  }

  /* ================================================================
     ミュート操作コア
  ================================================================ */
  function muteUser(login, display, comment) {
    if (!login || mutedUsers.has(login) || mutedUsers.size >= MAX_MUTED) {
      // 上限到達時はユーザーに知らせる（従来は無音で失敗していた）
      if (login && !mutedUsers.has(login) && mutedUsers.size >= MAX_MUTED) {
        showToast(`⚠️ ミュート上限 (${MAX_MUTED}) に到達しています`);
      }
      return false;
    }
    mutedUsers.add(login);
    mutedDisplays[login] = {
      display:     display || login,
      mutedAt:     Date.now(),
      muteComment: (typeof comment === 'string' && comment.trim()) ? comment.trim() : null
    };
    invalidateFilterCache();
    saveMuted();
    removeChatLinesByUser(login);
    if (Array.isArray(panelSnapshot)) panelSnapshot.unshift(login);
    if (panelElem) renderPage();
    showToast(`🚫 ${display || login} をミュート`);
    return true;
  }

  function removeChatLinesByUser(loginId) {
    if (!loginId) return;

    // VODページでなくても直前のVODチャットがDOMに残っている場合があるため、
    // data-tm-vod-muted='1' の要素は常に走査対象にする
    if (isVodPage()) {
      safe(() => {
        document.querySelectorAll(VOD_SEL).forEach(row => {
          safe(() => {
            const info = extractUserFromRow(row);
            if (!info || info.login !== loginId) return;
            if (muteEnabled && mutedUsers.has(loginId)) hideVodChatLine(row);
            else                                        showVodChatLine(row);
          });
        });
      });
    }

    if (!muteEnabled) return;

    safe(() => {
      document.querySelectorAll(`[data-a-user="${escapeSelector(loginId)}"]`).forEach(el => {
        safe(() => {
          const line = el.closest('[role="row"],[data-a-target="chat-line-message"]');
          if (line) hideVodChatLine(line);
        });
      });
    });
  }

  /* ================================================================
     行処理
  ================================================================ */
  function processChatLine(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
    const targets = collectChatRows(node);
    if (!targets.length) return;

    for (const chatLine of targets) {
      try {
        // 新しい行はキャッシュミスするのでここで強制破棄（trackActiveViewer 直前の msgText は新しい値として拾いたいため）
        // ...と見せかけて一度のみ取得（キャッシュを利かせる）。
        const info = getRowUser(chatLine);

        if (isVodChatRow(chatLine)) {
          applyMuteStateToVodRow(chatLine);
          if (chatLine.dataset) chatLine.dataset.tmProcessed = '1';
          continue;
        }

        if (!info || !info.login) {
          if (chatLine.dataset) chatLine.dataset.tmProcessed = '1';
          continue;
        }

        const { login, display } = info;
        const wasHidden = !!(chatLine.dataset && chatLine.dataset.tmVodMuted === '1');
        const alreadyProcessed = !!(chatLine.dataset && chatLine.dataset.tmProcessed === '1');

        // 「？」だけのコメントを非表示（メッセージは後段でも使うので一度だけ取得）
        const rawMsgText = getRowMessage(chatLine);
        if (!alreadyProcessed) recordCommentHistory(login, display, rawMsgText);
        if (isQuestionMarkHideEnabled() && isOnlyQuestionMark(rawMsgText.trim())) {
          hideVodChatLine(chatLine);
          if (!wasHidden) countFilterHit('question');
          if (chatLine.dataset) chatLine.dataset.tmProcessed = '1';
          continue;
        }

        // コンテンツフィルター（NGワード / 文字数制限 / 繰り返し）を非表示
        const filterReason = getFilterReason(rawMsgText, getRowPlainText(chatLine));
        if (filterReason) {
          hideVodChatLine(chatLine);
          if (!wasHidden) {
            countFilterHit(filterReason);
            if (filterReason === 'char' || filterReason === 'repeat' || filterReason === 'aa') recordFilterSample(filterReason, display, rawMsgText);
          }
          if (chatLine.dataset) chatLine.dataset.tmProcessed = '1';
          continue;
        }

        // サブスク限定モード：対象バッジを持たないコメントを非表示
        if (isSubOnlyModeEnabled() && !rowPassesSubOnly(chatLine)) {
          hideVodChatLine(chatLine);
          if (!wasHidden) countFilterHit('subonly');
          if (chatLine.dataset) chatLine.dataset.tmProcessed = '1';
          continue;
        }

        if (mutedUsers.has(login)) {
          trackActiveViewer(login, display, rawMsgText);
          if (muteEnabled) {
            hideVodChatLine(chatLine);
            if (chatLine.dataset) chatLine.dataset.tmProcessed = '1';
            continue;
          } else {
            showVodChatLine(chatLine);
          }
        } else {
          if (chatLine.dataset && chatLine.dataset.tmVodMuted) showVodChatLine(chatLine);
        }

        // position:relative をつけるのは 1 回だけでよいので dataset フラグでガードし、
        //   getComputedStyle のコストを削減する。
        if (chatLine.dataset && chatLine.dataset.tmPosSet !== '1') {
          safeExec(() => {
            const cs = window.getComputedStyle(chatLine);
            if (cs && cs.position === 'static') chatLine.style.position = 'relative';
            chatLine.dataset.tmPosSet = '1';
          }, undefined, 'position:relative');
        }
        // 返信ボタン表示ONのときは、背景ごと左へずらしてミュートボタンと並べる
        if (isReplyButtonShown()) safe(() => applyReplyShiftInRow(chatLine));
        // 表示された通常コメントは弾幕にも流す（ミュート/フィルターで消えた行はここに来ない）
        safe(() => spawnDanmaku(chatLine));
        if (chatLine.dataset) chatLine.dataset.tmProcessed = '1';
      } catch (e) {
        logWarn('processChatLine error', e);
      }
    }
  }

  function batchProcess(elements) {
    if (!elements || !elements.length) return;
    for (const el of elements) processChatLine(el);
  }

  /* ================================================================
     弾幕（ニコニコ式にコメントを映像上へ流す）
     - ON/OFFは「チャットを折りたたむ」ボタンの右隣にある弾幕ボタン（ニコニコ旧アイコン）で切り替える
     - 流れるのはミュート/フィルターで消えなかった通常コメントのみ
       （processChatLine の表示確定地点から spawnDanmaku が呼ばれる）
     - スタンプ（エモート画像）もコメント本文のノードを複製して一緒に流す
     - 速度/透明度/大きさ/量/ユーザー色はパネルの「弾幕設定」画面で調整できる
  ================================================================ */
  const DANMAKU_LANES = 9;
  const DANMAKU_DURATION_MS = 9500;
  const DANMAKU_MAX_ACTIVE = 36;
  let _danmakuEnabledCache = null;
  let _danmakuLayer = null;
  const _danmakuRecentKeys = new Map(); // 弾幕の重複防止（ユーザー名＋本文 → 出した時刻）
  let _danmakuLaneUsedAt = [];
  let _danmakuActiveCount = 0;
  // ページ表示直後の既存行まとめ処理で弾幕が洪水にならないよう、少し経ってから流し始める
  let _danmakuArmAt = Date.now() + 3000;

  function isDanmakuEnabled() {
    if (_danmakuEnabledCache === null) _danmakuEnabledCache = isFeatureEnabled(DANMAKU_KEY, false);
    return _danmakuEnabledCache;
  }
  function setDanmakuEnabled(v) {
    _danmakuEnabledCache = !!v;
    setFeatureEnabled(DANMAKU_KEY, !!v);
    if (!v) clearDanmakuLayer();
    updateDanmakuButtonLook();
  }

  // 弾幕設定の読み取り（範囲外・未設定はデフォルトへ丸める）
  function getDanmakuSpeed() { const n = parseInt(lsGet(DANMAKU_SPEED_KEY), 10); return Number.isFinite(n) ? Math.min(20, Math.max(5, n)) : 10; }
  function getDanmakuOpacity() { const n = parseInt(lsGet(DANMAKU_OPACITY_KEY), 10); return Number.isFinite(n) ? Math.min(100, Math.max(10, n)) : 100; }
  function getDanmakuSize() { const n = parseInt(lsGet(DANMAKU_SIZE_KEY), 10); return Number.isFinite(n) ? Math.min(36, Math.max(12, n)) : 21; }
  function getDanmakuMax() { const n = parseInt(lsGet(DANMAKU_MAX_KEY), 10); return Number.isFinite(n) ? Math.min(60, Math.max(4, n)) : DANMAKU_MAX_ACTIVE; }
  function isDanmakuUserColorEnabled() { return isFeatureEnabled(DANMAKU_USER_COLOR_KEY, false); }

  function ensureDanmakuLayer() {
    const host = document.querySelector('.video-player__container')
      || document.querySelector('[data-a-target="video-player"]')
      || (document.querySelector('video') && document.querySelector('video').parentElement);
    if (!host) return null;
    if (_danmakuLayer && _danmakuLayer.isConnected && _danmakuLayer.parentElement === host) return _danmakuLayer;
    if (_danmakuLayer) { safe(() => _danmakuLayer.remove()); _danmakuLayer = null; }
    const layer = document.createElement('div');
    layer.id = 'tm-danmaku-layer';
    Object.assign(layer.style, {
      position: 'absolute', inset: '0', overflow: 'hidden',
      pointerEvents: 'none', zIndex: '30',
    });
    safe(() => { if (window.getComputedStyle(host).position === 'static') host.style.position = 'relative'; });
    host.appendChild(layer);
    _danmakuLayer = layer;
    _danmakuActiveCount = 0;
    return layer;
  }

  function clearDanmakuLayer() {
    if (_danmakuLayer) { safe(() => _danmakuLayer.remove()); _danmakuLayer = null; }
    _danmakuActiveCount = 0;
  }

  function spawnDanmaku(row) {
    if (!isDanmakuEnabled()) return;
    if (!row || row.dataset.tmDanmaku === '1') return;
    row.dataset.tmDanmaku = '1';
    if (Date.now() < _danmakuArmAt) return;
    const layer = ensureDanmakuLayer();
    if (!layer) return;
    if (_danmakuActiveCount >= getDanmakuMax()) return;
    const body = row.querySelector(
      '[data-a-target="chat-line-message-body"], .chat-line__message-body, .video-chat__message'
    );
    if (!body || !body.childNodes.length) return;

    // 自分の発言は「送信直後の仮表示」と「サーバーから戻ってきた確定表示」で
    // 別々の行として2回届くため、ユーザー名＋本文が同じ弾幕は8秒以内なら2回目を出さない
    const nameElForKey = row.querySelector('[data-a-user], [data-a-target="chat-message-username"], .chat-author__display-name');
    const userKey = ((nameElForKey && (nameElForKey.getAttribute('data-a-user') || nameElForKey.textContent)) || '').trim().toLowerCase();
    const dedupKey = userKey + '|' + (body.textContent || '').trim();
    const nowMs = Date.now();
    if (_danmakuRecentKeys.has(dedupKey) && nowMs - _danmakuRecentKeys.get(dedupKey) < 8000) return;
    _danmakuRecentKeys.set(dedupKey, nowMs);
    if (_danmakuRecentKeys.size > 200) {
      for (const [k, t] of _danmakuRecentKeys) if (nowMs - t >= 8000) _danmakuRecentKeys.delete(k);
    }

    // 一番長く空いているレーンを使う
    const now = performance.now();
    let lane = 0, oldest = Infinity;
    for (let i = 0; i < DANMAKU_LANES; i++) {
      const t = _danmakuLaneUsedAt[i] || 0;
      if (t < oldest) { oldest = t; lane = i; }
    }
    _danmakuLaneUsedAt[lane] = now;

    const el = document.createElement('div');
    el.className = 'tm-danmaku-item';
    el.style.fontSize = `${getDanmakuSize()}px`;
    el.style.opacity = String(getDanmakuOpacity() / 100);
    if (isDanmakuUserColorEnabled()) {
      const nameEl = row.querySelector('[data-a-user], [data-a-target="chat-message-username"], .chat-author__display-name');
      if (nameEl) {
        const c = safe(() => window.getComputedStyle(nameEl).color, '');
        if (c) el.style.color = c;
      }
    }
    for (const node of body.childNodes) {
      const clone = node.cloneNode(true);
      if (clone.nodeType === Node.ELEMENT_NODE) clone.removeAttribute('id');
      el.appendChild(clone);
    }
    el.style.top = `calc(${(lane * 100 / DANMAKU_LANES).toFixed(2)}% + 2px)`;
    layer.appendChild(el);
    _danmakuActiveCount++;

    const hostW = layer.clientWidth || 800;
    const w = el.offsetWidth || 200;
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      safe(() => el.remove());
      _danmakuActiveCount = Math.max(0, _danmakuActiveCount - 1);
    };
    const duration = Math.round(DANMAKU_DURATION_MS / (getDanmakuSpeed() / 10)) + Math.random() * 1500;
    if (typeof el.animate === 'function') {
      const anim = el.animate(
        [{ transform: `translateX(${hostW + 16}px)` }, { transform: `translateX(${-w - 16}px)` }],
        { duration, easing: 'linear' }
      );
      if (anim) { anim.onfinish = done; setTimeout(done, duration + 2500); }
      else setTimeout(done, duration + 1500);
    } else {
      el.style.transform = `translateX(${hostW + 16}px)`;
      setTimeout(done, duration + 1500);
    }
  }

  function updateDanmakuButtonLook() {
    safe(() => {
      const btn = document.getElementById('tm-danmaku-btn');
      if (btn) {
        btn.classList.toggle('tm-on', isDanmakuEnabled());
        btn.setAttribute('aria-pressed', isDanmakuEnabled() ? 'true' : 'false');
      }
    });
  }

  // ニコニコ旧アイコン（テレビ）のSVG
  const DANMAKU_ICON_SVG = `<svg width="21" height="21" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><path d="M12 7.4 5.2 2.7M12 7.4l6.8-4.7" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><circle cx="4.6" cy="2.3" r="1.2" fill="currentColor"/><circle cx="19.4" cy="2.3" r="1.2" fill="currentColor"/><rect x="2.6" y="7.2" width="18.8" height="12" rx="2.2" fill="currentColor"/><path d="M7.2 21.4h2.9l-.8-2.2H8l-.8 2.2ZM13.9 21.4h2.9l-.8-2.2h-1.3l-.8 2.2Z" fill="currentColor"/></svg>`;

  // 弾幕ボタンを「チャットを折りたたむ」ボタンの右隣に常駐させる。
  //   レイアウト内に差し込むと全体がずれるため、ヘッダーへ絶対配置で重ねる
  //   （レイアウトには一切影響させない）。
  function positionDanmakuButton() {
    safe(() => {
      const btn = document.getElementById('tm-danmaku-btn');
      if (!btn) return;
      const collapseBtn = document.querySelector(
        'button[data-a-target="right-column__toggle-collapse-btn"], button[aria-label="チャットを折りたたむ"]'
      );
      const header = btn.closest('.stream-chat-header') || document.querySelector('.stream-chat-header');
      if (!collapseBtn || !header) return;
      if (window.getComputedStyle(header).position === 'static') header.style.position = 'relative';
      const c = collapseBtn.getBoundingClientRect();
      const h = header.getBoundingClientRect();
      btn.style.position = 'absolute';
      btn.style.left = `${Math.round(c.right - h.left + 4)}px`;
      btn.style.top = `${Math.round(c.top - h.top + (c.height - 30) / 2)}px`;
      btn.style.zIndex = '5';
    });
  }

  function ensureDanmakuButton() {
    safe(() => {
      if (document.getElementById('tm-danmaku-btn')) {
        updateDanmakuButtonLook();
        positionDanmakuButton();
        return;
      }
      const header = document.querySelector('.stream-chat-header');
      if (!header) return;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'tm-danmaku-btn';
      btn.className = 'tm-danmaku-icon-btn' + (isDanmakuEnabled() ? ' tm-on' : '');
      btn.setAttribute('aria-label', '弾幕');
      btn.setAttribute('aria-pressed', isDanmakuEnabled() ? 'true' : 'false');
      btn.title = '弾幕のON/OFF';
      btn.innerHTML = DANMAKU_ICON_SVG;
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        setDanmakuEnabled(!isDanmakuEnabled());
      });

      header.appendChild(btn);
      positionDanmakuButton();
    });
  }

  /* ================================================================
     チャンネルポイントボーナスの自動回収（常時ON・設定なし）
     - チャット横に出るボーナスボタン（宝箱）を、出現していたら自動でクリックする
  ================================================================ */
  function tryClickChannelPointBonus() {
    safe(() => {
      const icon = document.querySelector('.claimable-bonus__icon');
      if (!icon) return;
      const btn = icon.closest('button') || icon;
      btn.click();
    });
  }

  /* ================================================================
     CSS
  ================================================================ */
  (function injectStyles() {
    if (document.getElementById('tm-unmute-style')) return;
    const s = document.createElement('style');
    s.id = 'tm-unmute-style';
    s.textContent = `
:root {
  --tm-width: 270px;
  --tm-padding: 8px;
  --tm-bg: rgba(0,0,0,0.66);
  --tm-border: rgba(255,255,255,0.07);
  --tm-text: #f5f5f5;
  --tm-muted-text: #c8c8ce;
  --tm-radius: 12px;
  --tm-name-font-size: 13px;
  --tm-login-font-size: 11px;
  --tm-action-padding: 4px 8px;
  --tm-shadow: 0 8px 24px rgba(0,0,0,0.35);
  --tm-scrollbar-w: 6px;
}

#tm-unmute-panel {
  font-family: "Hiragino Kaku Gothic ProN","Hiragino Kaku Gothic Pro","メイリオ","Noto Sans JP",sans-serif;
  width: var(--tm-width);
  padding: 0;
  box-sizing: border-box;
  color: var(--tm-text);
  background: var(--tm-bg);
  border: 1px solid var(--tm-border);
  border-radius: var(--tm-radius);
  backdrop-filter: blur(10px) saturate(130%);
  -webkit-backdrop-filter: blur(10px) saturate(130%);
  box-shadow: var(--tm-shadow);
  display: flex;
  flex-direction: column;
  user-select: none;
  position: fixed;
  overflow: hidden;
}

#tm-unmute-panel .tm-header {
  display: flex;
  align-items: center;
  padding: 8px 10px 6px;
  gap: 8px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  flex-shrink: 0;
  cursor: grab;
  min-height: 36px;
  box-sizing: border-box;
}
#tm-unmute-panel .tm-header:active,
#tm-unmute-panel.tm-dragging .tm-header,
#tm-unmute-panel.tm-dragging { cursor: grabbing !important; }

#tm-unmute-panel .tm-title-group {
  display: flex; align-items: center; gap: 6px;
  flex: 1 1 auto; min-width: 0; overflow: hidden;
}
#tm-unmute-panel .tm-page-title {
  font-size: 13px; font-weight: 600; color: var(--tm-text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  flex-shrink: 1; min-width: 0;
}

#tm-unmute-panel .tm-enable-toggle {
  display: inline-flex; align-items: center;
  width: 34px; height: 18px; border-radius: 999px;
  background: rgba(255,255,255,0.15); cursor: pointer;
  flex-shrink: 0; transition: background-color .15s ease; position: relative;
}
#tm-unmute-panel .tm-enable-toggle::after {
  content: ''; position: absolute; left: 2px; top: 1px;
  width: 16px; height: 16px; border-radius: 50%; background: #f5f5f5;
  transition: transform .15s ease;
}
#tm-unmute-panel .tm-enable-toggle.tm-on { background: rgba(82,222,94,0.85); }
#tm-unmute-panel .tm-enable-toggle.tm-on::after { transform: translateX(16px); }

#tm-unmute-panel .tm-search-row {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 8px; flex-shrink: 0; position: relative;
  border-bottom: 1px solid rgba(255,255,255,0.05); box-sizing: border-box;
}
#tm-unmute-panel .tm-search-main { position: relative; flex: 1 1 auto; min-width: 0; overflow: hidden; }
#tm-unmute-panel .tm-search-input {
  width: 100%; box-sizing: border-box; height: 30px;
  padding: 0 54px 0 8px; border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.15);
  background: rgba(0,0,0,0.3); color: var(--tm-text);
  font-size: 12px; font-family: inherit; outline: none; user-select: text;
}
#tm-unmute-panel .tm-search-input::placeholder { color: rgba(255,255,255,0.35); }
#tm-unmute-panel .tm-search-badge {
  position: absolute; right: 32px; top: 50%; transform: translateY(-50%);
  font-size: 10px; color: var(--tm-muted-text);
  pointer-events: none; white-space: nowrap; display: none;
}

#tm-unmute-panel .tm-search-clear {
  position: absolute; right: 5px; top: 50%; transform: translateY(-50%);
  width: 20px; height: 20px; border-radius: 50%;
  display: none; align-items: center; justify-content: center;
  border: none !important; background: rgba(255,255,255,0.12) !important;
  color: var(--tm-muted-text) !important; font-size: 12px; line-height: 1;
  cursor: pointer !important; padding: 0 !important;
  transition: background .1s ease, color .1s ease;
}
#tm-unmute-panel .tm-search-clear:hover { background: rgba(255,255,255,0.22) !important; color: var(--tm-text) !important; }

#tm-unmute-panel .tm-page-list {
  flex: 1 1 auto; overflow-y: auto; min-height: 0;
  padding: 4px 0px 4px 8px;
  scrollbar-width: auto; scrollbar-color: rgba(255,255,255,0.25) transparent;
}
#tm-unmute-panel .tm-page-list::-webkit-scrollbar { width: var(--tm-scrollbar-w); }
#tm-unmute-panel .tm-page-list::-webkit-scrollbar-track { background: transparent; }
#tm-unmute-panel .tm-page-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 999px; }

#tm-unmute-panel .tm-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: 6px; padding: 4px 2px; border-radius: 6px;
  transition: background-color .1s ease;
}
#tm-unmute-panel .tm-row:hover { background-color: rgba(255,255,255,0.03); }

#tm-unmute-panel .tm-name-container {
  display: flex; align-items: center; gap: 4px; overflow: hidden;
  flex: 1 1 auto; min-width: 0; cursor: pointer;
}
#tm-unmute-panel .tm-display-span {
  font-size: var(--tm-name-font-size); font-weight: 300;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--tm-text);
}
#tm-unmute-panel .tm-login-span {
  font-size: var(--tm-login-font-size); color: var(--tm-muted-text);
  white-space: nowrap; flex-shrink: 0;
}

#tm-unmute-panel button {
  border: none !important; padding: 0 !important;
  background: transparent !important; cursor: default;
}
#tm-unmute-panel .tm-action-label {
  display: inline-flex; align-items: center; justify-content: center;
  padding: var(--tm-action-padding); border-radius: 6px;
  font-size: 12px; line-height: 1.1; white-space: nowrap;
  cursor: pointer; user-select: none; border: 1px solid transparent;
  font-family: "Zen Maru Gothic", "ZenMaruGothic", inherit;
  font-weight: 548; letter-spacing: 1.4px;
}
#tm-unmute-panel .tm-action-label.tm-cancel        { background: rgba(210,48,48,1)  !important; color: #1d2026 !important; border-color: rgba(140,0,0,0.3)  !important; }
#tm-unmute-panel .tm-action-label.tm-cancel-active { background: rgba(76,208,88,1)  !important; color: #1d2026 !important; border-color: rgba(0,150,60,0.3)  !important; }
#tm-unmute-panel .tm-action-label.tm-confirm       { background: rgba(207, 30, 14)  !important; color: #1d2026 !important; border-color: rgba(110,8,8,0.3)   !important; }

.tm-copied { filter: brightness(0.5) !important; }
.tm-removed-row { opacity: 0.001; pointer-events: none; min-height: 14px; }

#tm-unmute-panel .tm-footer {
  display: flex; align-items: center; padding: 5px 8px 4px;
  border-top: 1px solid rgba(255,255,255,0.06); flex-shrink: 0;
  justify-content: space-between; position: relative;
}

#tm-unmute-panel .tm-actions-wrap {
  position: relative; display: flex; align-items: center; flex: 0 0 auto;
  flex-direction: row-reverse; gap: 2px;
  max-width: 26px; overflow: hidden; transition: max-width .24s ease;
}
#tm-unmute-panel .tm-actions-wrap.tm-open { max-width: 120px; }
#tm-unmute-panel .tm-actions-main {
  position: relative; display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; border-radius: 6px;
  border: none !important; background: transparent !important;
  color: var(--tm-muted-text) !important; font-size: 15px;
  cursor: pointer !important;
  transition: background .12s ease, color .12s ease, transform .18s ease;
  transform-origin: center center; padding: 0 !important;
  flex-shrink: 0; z-index: 2;
}
#tm-unmute-panel .tm-actions-main:hover {
  background: transparent !important; color: var(--tm-muted-text) !important;
}
#tm-unmute-panel .tm-actions-wrap.tm-open .tm-actions-main {
  transform: rotate(45deg); color: var(--tm-text) !important;
}

#tm-unmute-panel .tm-actions-menu {
  display: flex; align-items: center; gap: 2px;
  max-width: 0; opacity: 0; overflow: hidden;
  transition: max-width .25s ease, opacity .2s ease; pointer-events: none;
}
#tm-unmute-panel .tm-actions-wrap.tm-open .tm-actions-menu {
  max-width: 90px; opacity: 1; pointer-events: auto;
}

#tm-unmute-panel .tm-mini-action {
  position: relative; display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; border-radius: 6px;
  border: none !important; background: transparent !important;
  color: var(--tm-muted-text) !important; font-size: 15px;
  cursor: pointer !important;
  transition: background .1s ease, color .1s ease, transform .15s ease;
  padding: 0 !important; flex-shrink: 0;
}
#tm-unmute-panel .tm-mini-action svg { width: 16px; height: 16px; pointer-events: none; flex-shrink: 0; }
#tm-unmute-panel .tm-mini-action:hover {
  background: rgba(255,255,255,0.08) !important; color: var(--tm-text) !important;
}

.tm-viewer-dot {
  position: absolute; top: 3px; right: 3px;
  width: 7px; height: 7px; border-radius: 50%;
  background: rgba(255,60,60,0.95); box-shadow: 0 0 4px rgba(255,60,60,0.6);
  pointer-events: none;
}

#tm-unmute-panel .tm-nav-center {
  position: absolute; left: 50%; top: 50%;
  display: flex; align-items: center; gap: 0;
  width: max-content; justify-content: center;
  transform: translate(-50%, -50%) translateX(0px);
}
#tm-unmute-panel .tm-nav-num {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 16px; padding: 2px 4px;
  color: var(--tm-muted-text); font-size: 12px;
  border-radius: 4px; cursor: pointer; user-select: none;
  transition: background .1s ease, color .1s ease;
}
#tm-unmute-panel .tm-nav-num:hover { background: rgba(255,255,255,0.08); color: var(--tm-text); }
#tm-unmute-panel .tm-nav-num.tm-disabled { color: rgba(255,255,255,0.2); cursor: default; }
#tm-unmute-panel .tm-nav-num.tm-disabled:hover { background: transparent; color: rgba(255,255,255,0.2); }
#tm-unmute-panel .tm-nav-sep {
  color: var(--tm-muted-text); font-size: 12px; padding: 0 1px;
  user-select: none; pointer-events: none;
}

#tm-unmute-panel .tm-footer button { cursor: pointer !important; }

/* 弾幕ボタン（チャット入力欄下のボタン列に常駐。背景なし、色だけでON/OFFを表す） */
.tm-danmaku-icon-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; margin-right: 2px; flex: 0 0 auto;
  background: transparent !important; border: none !important; border-radius: 4px;
  color: #adadb8; cursor: pointer; padding: 0 !important;
  transition: color .12s ease;
}
.tm-danmaku-icon-btn:hover { color: #efeff1; }
.tm-danmaku-icon-btn.tm-on { color: #a970ff; }
.tm-danmaku-icon-btn svg { width: 21px; height: 21px; pointer-events: none; }

/* 設定/NG画面表示中はページナビとソートを隠す */
#tm-unmute-panel.tm-settings-view .tm-nav-center,
#tm-unmute-panel.tm-settings-view .tm-footer-right { display: none !important; }

/* コメント設定画面では検索入力欄だけ隠す（⚙メニューは残して画面移動を止めない） */
#tm-unmute-panel.tm-settings-view:not(.tm-ng-view) .tm-search-main { display: none; }

#tm-unmute-panel .tm-setting-back {
  display: flex; align-items: center; gap: 4px;
  width: 100%; padding: 7px 4px; margin-bottom: 2px;
  min-height: 36px; box-sizing: border-box;
  background: transparent !important; border: none !important;
  border-bottom: 1px solid rgba(255,255,255,0.06) !important;
  color: var(--tm-muted-text) !important; font-size: 12.5px;
  cursor: pointer !important; text-align: left;
  transition: color .1s ease;
}
#tm-unmute-panel .tm-setting-back:hover { color: var(--tm-text) !important; }

#tm-unmute-panel .tm-setting-section {
  padding: 8px 4px 2px; font-size: 11px; font-weight: 700;
  color: var(--tm-muted-text); letter-spacing: .04em;
}

#tm-unmute-panel .tm-setting-row {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 7px 4px; min-height: 36px; box-sizing: border-box;
  border-bottom: 1px solid rgba(255,255,255,0.04);
}

/* 左下の設定カルーセル（1枠分の窓を横スクロール＋スナップで切り替える） */
#tm-unmute-panel .tm-settings-carousel {
  display: flex; flex-direction: row; align-items: center; gap: 4px;
  flex: 0 0 auto;
}
#tm-unmute-panel .tm-search-carousels { display: flex; gap: 10px; align-items: center; flex: 0 0 auto; }
#tm-unmute-panel .tm-carousel-slot {
  display: flex; flex-direction: column; width: 28px; height: 26px;
  overflow-y: auto; overflow-x: hidden;
  scroll-snap-type: y mandatory; scrollbar-width: none; scroll-behavior: smooth;
  -webkit-mask-image: linear-gradient(to bottom, #000 72%, transparent 100%);
          mask-image: linear-gradient(to bottom, #000 72%, transparent 100%);
}
#tm-unmute-panel .tm-carousel-slot.tm-at-end {
  -webkit-mask-image: none; mask-image: none;
}
#tm-unmute-panel .tm-carousel-slot::-webkit-scrollbar { display: none; }
#tm-unmute-panel .tm-carousel-btn {
  flex: 0 0 26px; width: 28px; height: 26px; scroll-snap-align: start;
  display: inline-flex; align-items: center; justify-content: center;
  background: transparent; border: none; padding: 0;
  color: var(--tm-muted-text); cursor: pointer; position: relative;
}
#tm-unmute-panel .tm-carousel-btn:hover { color: var(--tm-text); }
#tm-unmute-panel .tm-carousel-btn.tm-active { color: #a970ff; }
#tm-unmute-panel .tm-carousel-dots { display: flex; flex-direction: column; gap: 3px; }
#tm-unmute-panel .tm-carousel-dot {
  display: block; width: 5px; height: 5px; border-radius: 50%;
  background: rgba(255,255,255,0.35); cursor: pointer;
}
#tm-unmute-panel .tm-carousel-dot.tm-on { background: var(--tm-text); }

/* スリム表示：戻る行を廃止しタイトル左の‹に統合。コメント設定・弾幕設定では検索/⚙の行も丸ごと隠す（NG画面は追加欄が要るので行は残す） */
#tm-unmute-panel.tm-slim-view:not(.tm-ng-view) .tm-search-row { display: none; }
#tm-unmute-panel .tm-view-back {
  display: none; align-items: center; justify-content: center;
  width: 22px; height: 22px; padding: 0; flex: 0 0 auto;
  background: transparent; border: none; cursor: pointer;
  color: var(--tm-muted-text); font-size: 21px; line-height: 1;
}
#tm-unmute-panel.tm-slim-view .tm-view-back { display: inline-flex; }
#tm-unmute-panel .tm-view-back:hover { color: var(--tm-text); }

/* チェック式の行（設定画面のON/OFFはトグルでなく行クリック＋✓で表す） */
#tm-unmute-panel .tm-check-row { cursor: pointer; border-radius: 6px; }
#tm-unmute-panel .tm-check-row:hover { background: rgba(255,255,255,0.03); }
#tm-unmute-panel .tm-check-row .tm-setting-label { color: var(--tm-muted-text); transition: color .1s ease; }
#tm-unmute-panel .tm-check-row.tm-on .tm-setting-label { color: var(--tm-text); }
#tm-unmute-panel .tm-check-mark {
  flex: 0 0 auto; font-size: 14px; font-weight: 700; line-height: 1; color: #a970ff;
  opacity: 0; transform: scale(.6);
  transition: opacity .12s ease, transform .12s ease;
}
#tm-unmute-panel .tm-check-row.tm-on .tm-check-mark { opacity: 1; transform: scale(1); }
#tm-unmute-panel .tm-filter-stats { margin-top: 10px; padding: 8px 10px; border-top: 1px solid rgba(255,255,255,0.08); font-size: 11px; color: #adadb8; }
#tm-unmute-panel .tm-filter-stats-row { display: grid; grid-template-columns: 1fr 44px 44px; padding: 2px 0; }
#tm-unmute-panel .tm-filter-stats-row span:nth-child(2), #tm-unmute-panel .tm-filter-stats-row span:nth-child(3) { text-align: right; font-variant-numeric: tabular-nums; }
#tm-unmute-panel .tm-filter-stats-head { color: #7d7d88; }
#tm-unmute-panel .tm-filter-stats-title { font-size: 11px; font-weight: 700; color: #adadb8; padding-bottom: 4px; }
#tm-unmute-panel .tm-filter-stat-link { cursor: pointer; text-decoration: underline dotted rgba(169,112,255,0.6); text-underline-offset: 3px; }
#tm-unmute-panel .tm-filter-stat-link:hover { color: #c9a7ff; }
#tm-filter-samples { position: fixed; z-index: 2147483002; width: 264px; max-height: 248px; overflow-y: auto; background: #18181b; border: 1px solid rgba(255,255,255,0.14); border-radius: 8px; box-shadow: 0 8px 28px rgba(0,0,0,0.55); padding: 6px 0; color: #efeff1; font-size: 12px; }
#tm-filter-samples .tm-samples-head { padding: 4px 10px 6px; font-weight: 700; font-size: 11.5px; color: #adadb8; }
#tm-filter-samples .tm-samples-empty { padding: 2px 10px 6px; color: #adadb8; }
#tm-filter-samples .tm-sample-row { display: flex; gap: 6px; padding: 4px 10px; border-top: 1px solid rgba(255,255,255,0.06); }
#tm-filter-samples .tm-sample-user { flex: 0 1 auto; max-width: 84px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #a970ff; font-weight: 600; }
#tm-filter-samples .tm-sample-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#tm-unmute-panel .tm-key-chip { margin-left: auto; appearance: none; border: 1px solid rgba(169,112,255,0.5); background: rgba(169,112,255,0.18); color: #efeff1; font-size: 11.5px; font-weight: 600; padding: 4px 12px; border-radius: 999px; cursor: pointer; font-variant-numeric: tabular-nums; }
#tm-unmute-panel .tm-key-chip:hover { background: rgba(169,112,255,0.32); }
#tm-ctx-menu { position: fixed; z-index: 99999; min-width: 150px; padding: 4px; background: #1f1f23; border: 1px solid rgba(255,255,255,0.14); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); display: flex; flex-direction: column; }
#tm-ctx-menu .tm-ctx-item { appearance: none; border: none; background: transparent; color: #efeff1; font-size: 12.5px; text-align: left; padding: 7px 10px; border-radius: 5px; cursor: pointer; }
#tm-ctx-menu .tm-ctx-item:hover { background: rgba(169,112,255,0.22); }
#tm-history-popup { position: fixed; z-index: 99999; width: 290px; background: #1f1f23; border: 1px solid rgba(255,255,255,0.14); border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); overflow: hidden; }
#tm-history-popup .tm-history-head { padding: 8px 12px; font-size: 13px; font-weight: 700; color: #efeff1; border-bottom: 1px solid rgba(255,255,255,0.08); }
#tm-history-popup .tm-history-list { max-height: 260px; overflow-y: auto; padding: 6px 0; }
#tm-history-popup .tm-history-item { display: flex; gap: 8px; padding: 4px 12px; font-size: 12.5px; color: #efeff1; line-height: 1.45; word-break: break-word; }
#tm-history-popup .tm-history-time { flex: 0 0 auto; color: #adadb8; font-variant-numeric: tabular-nums; }
#tm-unmute-panel .tm-setting-label { font-size: 12.5px; color: var(--tm-text); line-height: 1.35; }

#tm-unmute-panel .tm-setting-block { padding: 8px 4px 10px; border-bottom: 1px solid rgba(255,255,255,0.04); }
/* 弾幕設定用：縦幅を約半分に圧縮したスライダー行 */
#tm-unmute-panel .tm-setting-block-compact { padding: 4px 4px 5px; }
#tm-unmute-panel .tm-setting-block-compact .tm-setting-block-head { margin-bottom: 3px; }
#tm-unmute-panel .tm-setting-block-compact .tm-char-slider { margin: 1px 0 2px; }
#tm-unmute-panel .tm-setting-block-head {
  display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;
}
#tm-unmute-panel .tm-char-chip {
  font-size: 11px; padding: 2px 8px; border-radius: 999px;
  background: rgba(255,255,255,0.08); color: var(--tm-text);
  min-width: 44px; text-align: center; box-sizing: border-box;
}
#tm-unmute-panel .tm-char-slider {
  -webkit-appearance: none; appearance: none;
  width: 100%; height: 4px; border-radius: 999px;
  background: rgba(255,255,255,0.18);
  outline: none; cursor: pointer; margin: 2px 0 6px;
}
#tm-unmute-panel .tm-char-slider::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: 16px; height: 16px; border-radius: 50%;
  background: #fff; border: 2px solid rgba(169,112,255,0.9);
  box-shadow: 0 1px 5px rgba(0,0,0,0.45); cursor: pointer;
}
#tm-unmute-panel .tm-char-slider::-moz-range-thumb {
  width: 14px; height: 14px; border-radius: 50%;
  background: #fff; border: 2px solid rgba(169,112,255,0.9);
  box-shadow: 0 1px 5px rgba(0,0,0,0.45); cursor: pointer;
}
#tm-unmute-panel .tm-setting-note { font-size: 11px; color: var(--tm-muted-text); line-height: 1.4; }

#tm-unmute-panel .tm-ng-row {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 4px; min-height: 36px; box-sizing: border-box;
  border-bottom: 1px solid rgba(255,255,255,0.04);
}
#tm-unmute-panel .tm-ng-word {
  flex: 1 1 auto; min-width: 0; font-size: 12.5px; color: var(--tm-text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
#tm-unmute-panel .tm-ng-del {
  flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; border-radius: 6px;
  border: none !important; background: transparent !important;
  color: var(--tm-muted-text) !important; font-size: 14px; line-height: 1;
  cursor: pointer !important; padding: 0 !important;
  transition: background .1s ease, color .1s ease;
}
#tm-unmute-panel .tm-ng-del:hover { background: rgba(255,80,80,0.16) !important; color: #ff8a8a !important; }


.tm-danmaku-item {
  position: absolute; left: 0;
  display: flex; align-items: center; gap: 2px;
  white-space: nowrap; pointer-events: none;
  font-size: 21px; font-weight: 700; line-height: 1.3;
  color: #fff;
  text-shadow: 0 0 3px rgba(0,0,0,0.9), 1px 1px 2px rgba(0,0,0,0.8);
  will-change: transform;
}
.tm-danmaku-item img { height: 1.35em; width: auto; vertical-align: middle; }
.tm-danmaku-item a { color: inherit; text-decoration: none; }

#tm-unmute-panel .tm-footer-right {
  display: flex; align-items: center; gap: 4px;
  flex: 0 0 auto; margin-left: auto; margin-right: 8px;
  position: relative; z-index: 1;
}

#tm-unmute-panel .tm-sort-btn {
  font-size: 11px; padding: 2px 6px !important; border-radius: 4px;
  border: 1px solid rgba(255,255,255,0.1) !important;
  background: rgba(255,255,255,0.04) !important;
  color: var(--tm-muted-text) !important; cursor: pointer !important;
  white-space: nowrap; transition: background .1s ease;
  min-width: 47px; text-align: center; box-sizing: border-box;
}
#tm-unmute-panel .tm-sort-btn.tm-confirm-mode { color: #f71e1e !important; min-width: 47px !important; }
#tm-unmute-panel .tm-sort-btn.tm-confirm-mode:hover { color: #f71e1e !important; }
#tm-unmute-panel .tm-sort-btn:hover {
  background: rgba(255,255,255,0.10) !important; color: var(--tm-text) !important;
}

#tm-unmute-panel .tm-resize-handle {
  height: 6px; cursor: ns-resize; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
}
#tm-unmute-panel .tm-resize-handle::after {
  content: ''; width: 28px; height: 2px; border-radius: 1px;
  background: rgba(255,255,255,0.12);
}

#tm-viewer-panel .tm-viewer-header { cursor: grab; }
#tm-viewer-panel .tm-viewer-header:active,
#tm-viewer-panel.tm-dragging .tm-viewer-header,
#tm-viewer-panel.tm-dragging { cursor: grabbing !important; }

#tm-setting-icon {
  transition: opacity .12s ease, transform .18s ease;
  display: flex; align-items: center; justify-content: center;
  border-radius: 6px; background: transparent; border: none;
  cursor: pointer; user-select: none;
  /* 色修正: 以前は color 指定がなく currentColor を継承した上に opacity:0.6 が
     かかっていたため、指定しても見かけの色が約 rgb(153,153,156) に沈んでいた。
     オンは rgb(239,239,241) をそのまま出すため opacity:1 で固定する。 */
  color: rgb(239, 239, 241); opacity: 1;
  padding: 4px; position: fixed;
  z-index: 999999;
}
/* オフはオンの旧・見かけ色 rgb(153,153,156)。旧 filter brightness(0.7) は
   指定色をさらに暗くしてしまうため外す。 */
#tm-setting-icon.tm-disabled { color: rgb(153, 153, 156); opacity: 1; filter: none; }

#tm-picker-icon {
  transition: opacity .12s ease, transform .18s ease, background .12s ease;
  display: flex; align-items: center; justify-content: center;
  border-radius: 6px; background: transparent; border: none;
  cursor: pointer; user-select: none;
  color: rgb(239, 239, 241); opacity: 1;
  padding: 4px; position: fixed;
  z-index: 999999;
  font-size: 22px;
}
#tm-picker-icon.tm-picker-active {
  background: rgba(255, 60, 60, 0.28) !important;
  color: #ff6b6b;
  outline: 1px solid rgba(255, 60, 60, 0.7);
}
#tm-setting-icon:hover, #tm-picker-icon:hover { background: rgba(255,255,255,0.08); }

/* ===== 消した要素パネル（ミュートリストとデザインを統一） ===== */
@keyframes tm-panel-in {
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: translateY(0); }
}
#tm-hidden-panel {
  font-family: "Hiragino Kaku Gothic ProN","Hiragino Kaku Gothic Pro","メイリオ","Noto Sans JP",sans-serif;
  width: 280px; max-height: 440px;
  display: flex; flex-direction: column;
  color: var(--tm-text);
  background: var(--tm-bg);
  border: 1px solid var(--tm-border);
  border-radius: var(--tm-radius);
  backdrop-filter: blur(10px) saturate(130%);
  -webkit-backdrop-filter: blur(10px) saturate(130%);
  box-shadow: var(--tm-shadow);
  overflow: hidden; user-select: none;
  animation: tm-panel-in .15s ease;
}
#tm-hidden-panel .tm-hidden-header {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px 8px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  flex-shrink: 0;
}
#tm-hidden-panel .tm-hidden-title { font-size: 13px; font-weight: 600; color: var(--tm-text); }
#tm-hidden-panel .tm-hidden-count {
  font-size: 11px; color: var(--tm-muted-text);
  background: rgba(255,255,255,0.08);
  border-radius: 999px; padding: 1px 8px; line-height: 1.5;
}
#tm-hidden-panel .tm-enable-toggle {
  margin-left: auto;
  display: inline-flex; align-items: center;
  width: 34px; height: 18px; border-radius: 999px;
  background: rgba(255,255,255,0.15); cursor: pointer;
  flex-shrink: 0; transition: background-color .15s ease; position: relative;
}
#tm-hidden-panel .tm-enable-toggle::after {
  content: ''; position: absolute; left: 2px; top: 1px;
  width: 16px; height: 16px; border-radius: 50%; background: #f5f5f5;
  transition: transform .15s ease;
}
#tm-hidden-panel .tm-enable-toggle.tm-on { background: rgba(82,222,94,0.85); }
#tm-hidden-panel .tm-enable-toggle.tm-on::after { transform: translateX(16px); }
#tm-hidden-panel .tm-hidden-close {
  flex-shrink: 0;
  width: 26px; height: 26px; border-radius: 6px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 15px; line-height: 1; color: var(--tm-muted-text);
  background: transparent; border: none; cursor: pointer;
  transition: background .1s ease, color .1s ease;
}
#tm-hidden-panel .tm-hidden-close:hover { background: rgba(255,255,255,0.08); color: var(--tm-text); }
#tm-hidden-panel .tm-hidden-start {
  margin: 10px 12px 4px; padding: 8px 10px;
  display: flex; align-items: center; justify-content: center; gap: 7px;
  border-radius: 8px; border: 1px solid rgba(255,60,60,0.5);
  background: rgba(255,60,60,0.16); color: var(--tm-text);
  font-size: 13px; font-family: inherit; cursor: pointer; flex-shrink: 0;
  transition: background .12s ease, border-color .12s ease;
}
#tm-hidden-panel .tm-hidden-start:hover { background: rgba(255,60,60,0.26); border-color: rgba(255,60,60,0.75); }
#tm-hidden-panel .tm-hidden-start svg { width: 15px; height: 15px; flex-shrink: 0; }
#tm-hidden-panel .tm-hidden-hint {
  padding: 4px 12px 8px; font-size: 11px; color: #9a9aa2; line-height: 1.6; flex-shrink: 0;
}
#tm-hidden-panel .tm-kbd {
  display: inline-block; padding: 0 5px; border-radius: 4px;
  background: rgba(255,255,255,0.09); border: 1px solid rgba(255,255,255,0.12);
  font-size: 10px; line-height: 1.5; color: var(--tm-muted-text);
}
#tm-hidden-panel #tm-hidden-body { overflow-y: auto; flex: 1; padding: 2px 8px 10px; }
#tm-hidden-panel .tm-hidden-empty {
  padding: 18px 0 14px; text-align: center; color: #8a8a93;
  font-size: 12px; line-height: 1.6;
}
#tm-hidden-panel .tm-hidden-empty svg { width: 26px; height: 26px; opacity: 0.35; margin-bottom: 4px; }
#tm-hidden-panel .tm-hidden-row {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;
  padding: 7px 6px; border-radius: 8px;
  border-bottom: 1px solid rgba(255,255,255,0.04);
  transition: background .1s ease;
}
#tm-hidden-panel .tm-hidden-row:hover { background: rgba(255,255,255,0.04); }
#tm-hidden-panel .tm-hidden-row-main { overflow: hidden; flex: 1 1 auto; min-width: 0; }
#tm-hidden-panel .tm-hidden-label {
  font-size: 12px; color: var(--tm-text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
#tm-hidden-panel .tm-hidden-sub {
  font-size: 10px; color: #8a8a93; margin-top: 1px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
#tm-hidden-panel .tm-hidden-sub .tm-hidden-selector {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
#tm-hidden-panel .tm-hidden-undo {
  font-size: 11px; color: var(--tm-muted-text); cursor: pointer; flex-shrink: 0;
  background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
  border-radius: 6px; padding: 3px 9px; font-family: inherit;
  transition: background .1s ease, color .1s ease;
}
#tm-hidden-panel .tm-hidden-undo:hover { background: rgba(255,255,255,0.12); color: var(--tm-text); }
#tm-hidden-panel .tm-hidden-all {
  margin-top: 10px; width: 100%; padding: 7px 10px; border-radius: 8px;
  border: 1px solid rgba(255,255,255,0.1); background: transparent;
  color: var(--tm-muted-text); font-size: 12px; cursor: pointer; font-family: inherit;
  transition: background .1s ease, color .1s ease;
}
#tm-hidden-panel .tm-hidden-all:hover { background: rgba(255,255,255,0.07); color: var(--tm-text); }
#tm-hidden-panel #tm-hidden-body::-webkit-scrollbar { width: 6px !important; background: transparent !important; }
#tm-hidden-panel #tm-hidden-body::-webkit-scrollbar-track { background: transparent !important; }
#tm-hidden-panel #tm-hidden-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.22) !important; border-radius: 999px !important; }
#tm-hidden-panel #tm-hidden-body::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.45) !important; }

/* 要素ピッカーで保存されたルールにより非表示にした要素（常時ONスタイル側に置き、
   コミュニティハイライト非表示の ON/OFF とは独立に効くようにする） */
[data-tm-custom-hidden="1"] {
  display: none !important;
  visibility: hidden !important;
  height: 0 !important;
  min-height: 0 !important;
  max-height: 0 !important;
  width: 0 !important;
  min-width: 0 !important;
  overflow: hidden !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  opacity: 0 !important;
  pointer-events: none !important;
}
[data-tm-custom-hidden="1"] > * { display: none !important; }

#tm-unmute-panel .tm-page-list::-webkit-scrollbar,
#tm-viewer-panel #tm-viewer-body::-webkit-scrollbar {
  width: var(--tm-scrollbar-w) !important;
  height: var(--tm-scrollbar-w) !important;
  background: transparent !important;
}
#tm-unmute-panel .tm-page-list::-webkit-scrollbar-track,
#tm-viewer-panel #tm-viewer-body::-webkit-scrollbar-track { background: transparent !important; }
#tm-unmute-panel .tm-page-list::-webkit-scrollbar-thumb,
#tm-viewer-panel #tm-viewer-body::-webkit-scrollbar-thumb {
  background: rgba(255,255,255,0.22) !important; border-radius: 999px !important;
}
#tm-unmute-panel .tm-page-list::-webkit-scrollbar-thumb:hover,
#tm-viewer-panel #tm-viewer-body::-webkit-scrollbar-thumb:hover {
  background: rgba(255,255,255,0.45) !important;
}
#tm-unmute-panel .tm-page-list::-webkit-scrollbar-button,
#tm-viewer-panel #tm-viewer-body::-webkit-scrollbar-button { display: none !important; }

[data-tm-vod-muted="1"] {
  opacity: 0 !important; pointer-events: none !important;
  height: 0 !important; min-height: 0 !important; max-height: 0 !important;
  margin: 0 !important; padding-top: 0 !important; padding-bottom: 0 !important;
  border: 0 !important; overflow: hidden !important;
}
[data-tm-vod-muted="1"] > * { display: none !important; }

/* チャット上部のスポンサー・プロモーション枠全般 */
[data-test-selector*="channel-skins"] {
  display: none !important;
  visibility: hidden !important;
  height: 0 !important;
  min-height: 0 !important;
  max-height: 0 !important;
  overflow: hidden !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
}

button[data-a-target="unfollow-button"] {
  pointer-events: none !important;
  opacity: 0.4 !important;
}

`;
    document.head.appendChild(s);
  })();

  /* ================================================================
     コミュニティハイライト非表示（ギフト/クリップ ランキングバナー等）用CSS
     - メインの常時ONスタイルとは別の<style>に分離し、Tampermonkeyメニューの
       トグルでいつでも挿入/撤去できるようにする
     - ※ ピン留め / 予想 は JS 側の isProtectedCard() で保護されるため、
        カード全体をブロックするセレクタはここに書かず、JSだけに任せる
  ================================================================ */
  const COMMUNITY_HIGHLIGHT_STYLE_ID = 'tm-community-highlight-hide-style';
  const COMMUNITY_HIGHLIGHT_CSS = `
[class*="channelLeaderboardHeaderRotating"],
[class*="channelLeaderboardHeader"],
[class*="ChannelLeaderboard"],
[class*="channelLeaderboard"],
[class*="leaderboard-header"],
[class*="LeaderboardHeader"],
[class*="GiftSubBanner"],
[class*="gift-sub-banner"],
[class*="SubscriptionsGifter"],
[class*="subscriptions-gifter"],
/* ハイプトレイン／トレジャートレインの進行バナー */
[class*="hypeTrainBanner"],
[aria-controls="hype-train-expanded-view"],
[data-a-target="leaderboard-header"],
[data-a-target="leaderboard-banner"],
[data-test-selector="leaderboard-header"],
[aria-label*="目標"],
div:has(> button[aria-label="前のランキングセット"]),
div:has(> button[aria-label="次のランキングセット"]),
[aria-label="前のランキングセット"],
[aria-label="次のランキングセット"],
[aria-label*="ランキングを展開"],
[aria-label*="leaderboard" i],
/* High-2: 以下は文言だけを見ると「サブスクライブ」「ギフター」「ランキング」等の
   汎用的な部分一致になっており、コミュニティハイライト領域の外（チャンネルページの
   本物のサブスクライブボタン、チャット入力欄のビッツボタン等）にも当たってしまう
   危険があった。:where() でコミュニティハイライト領域の子孫にスコープを限定する。 */
:where(.community-highlight-stack, [class*="community-highlight-stack"]) [aria-label*="サブスクギフト"],
:where(.community-highlight-stack, [class*="community-highlight-stack"]) [aria-label*="サブスクライブ"],
:where(.community-highlight-stack, [class*="community-highlight-stack"]) [aria-label*="モジュール"],
:where(.community-highlight-stack, [class*="community-highlight-stack"]) button[aria-label*="ギフター"],
:where(.community-highlight-stack, [class*="community-highlight-stack"]) button[aria-label*="ランキング"],
/* プラスプログラム等の「〜の条件を展開して表示」系ウィジェット（CSS即時版）
   button自体を消すことで中身（進捗バー・レベル表示等）ごと非表示にする。
   同種の別キャンペーンが同じ命名規則で来た場合も自動で拾える（$= の前方一致ではなく後方一致） */
button[aria-label$="の条件を展開して表示"],
a[href*="help.twitch.tv/s/article/plus-program"] {
  display: none !important;
  visibility: hidden !important;
  height: 0 !important;
  min-height: 0 !important;
  max-height: 0 !important;
  overflow: hidden !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
}

/* JS判定で「ブロック対象」とマークされた要素
   - 枠だけ残る問題を防ぐため、子要素も含めて完全に隠す
   - 複数の層でマークされても OK （CSS は冪等） */
[data-tm-block-banner="1"] {
  display: none !important;
  visibility: hidden !important;
  height: 0 !important;
  min-height: 0 !important;
  max-height: 0 !important;
  width: 0 !important;
  min-width: 0 !important;
  overflow: hidden !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  opacity: 0 !important;
  pointer-events: none !important;
}
[data-tm-block-banner="1"] > * { display: none !important; }
`;

  function injectCommunityHighlightStyle() {
    safe(() => {
      if (document.getElementById(COMMUNITY_HIGHLIGHT_STYLE_ID)) return;
      const s = document.createElement('style');
      s.id = COMMUNITY_HIGHLIGHT_STYLE_ID;
      s.textContent = COMMUNITY_HIGHLIGHT_CSS;
      document.head.appendChild(s);
    });
  }

  function removeCommunityHighlightStyle() {
    safe(() => {
      const s = document.getElementById(COMMUNITY_HIGHLIGHT_STYLE_ID);
      if (s) s.remove();
    });
  }

  /* ================================================================
     返信ボタンの表示制御（コメント設定「返信ボタンを表示」）
     - OFF（デフォルト）: 返信ボタンを非表示にする
       （ホバー時のミュートボタンがメッセージ右下にあり、返信ボタンと被るため）
     - ON: 表示する。ただしミュートボタンと被らないよう左へ32pxずらす
  ================================================================ */
  const REPLY_BTN_STYLE_ID = 'tm-reply-btn-style';
  const REPLY_BTN_SELECTORS =
    'button[data-a-target="reply-button"],' +
    'button[data-test-selector="reply-button"],' +
    'button[aria-label*="reply" i],' +
    'button[aria-label*="返信" i],' +
    '[data-test-selector="message-context-reply-toggle"]';
  // 返信ボタンを「背景ごと」ずらすため、ボタン単体ではなく背景を持つ
  //   外側のツールバー要素を探して動かす（ボタンだけ動かすと背景が
  //   置いていかれて、アイコンと背景がずれて見えるため）。
  function findReplyToolbar(btn, row) {
    if (!btn) return null;
    if (safe(() => btn.matches('[data-test-selector="message-context-reply-toggle"]'), false)) return btn;
    const toggle = safe(() => btn.closest('[data-test-selector="message-context-reply-toggle"]'), null);
    if (toggle && toggle !== btn) return toggle;
    let el = btn.parentElement;
    for (let i = 0; el && i < 6 && el !== row; i++) {
      if (safe(() => window.getComputedStyle(el).position, '') === 'absolute') return el;
      el = el.parentElement;
    }
    return btn;
  }

  function applyReplyShiftInRow(row) {
    if (!row || !row.querySelector) return;
    const btn = safe(() => row.querySelector(REPLY_BTN_SELECTORS), null);
    if (!btn) return;
    const bar = findReplyToolbar(btn, row);
    if (!bar || bar.dataset.tmReplyShifted === '1') return;
    bar.dataset.tmReplyShifted = '1';
    // 既定は左へ32px。ボタンの位置が実測できる場合は、ミュートボタン
    //   （行の右下・中心は右端から約21px／下端から約12px）と中心が揃うよう
    //   縦横を実測で合わせ、返信ボタンがミュートボタンの真横に並ぶようにする。
    let dx = -32, dy = 0;
    safe(() => {
      const rowRect = row.getBoundingClientRect();
      const btnRect = btn.getBoundingClientRect();
      if (rowRect && btnRect && btnRect.width > 0 && btnRect.height > 0) {
        const muteCx = rowRect.right - 21;
        const muteCy = rowRect.bottom - 12;
        const targetCx = muteCx - (11 + btnRect.width / 2 + 4);
        dx = Math.round(targetCx - (btnRect.left + btnRect.width / 2));
        dy = Math.round(muteCy - (btnRect.top + btnRect.height / 2));
        dx = Math.max(-80, Math.min(0, dx));
        dy = Math.max(-60, Math.min(60, dy));
      }
    });
    bar.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  function refreshReplyShifts() {
    safe(() => {
      document.querySelectorAll(REPLY_BTN_SELECTORS).forEach(btn => {
        const row = safe(() => btn.closest('[data-a-target="chat-line-message"], [role="row"]'), null) || btn.parentElement;
        if (row) applyReplyShiftInRow(row);
      });
    });
  }

  function clearReplyShifts() {
    safe(() => {
      document.querySelectorAll('[data-tm-reply-shifted="1"]').forEach(el => {
        el.style.transform = '';
        delete el.dataset.tmReplyShifted;
      });
    });
  }

  function applyReplyButtonStyle() {
    safe(() => {
      let s = document.getElementById(REPLY_BTN_STYLE_ID);
      if (!s) {
        s = document.createElement('style');
        s.id = REPLY_BTN_STYLE_ID;
        document.head.appendChild(s);
      }
      if (isReplyButtonShown()) {
        // 表示ON: 非表示CSSは外し、ツールバーを背景ごと左へずらして
        //   右下のミュートボタンと横並びにする（JSで要素を特定して動かす）
        s.textContent = '';
        refreshReplyShifts();
      } else {
        s.textContent = `${REPLY_BTN_SELECTORS} { display: none !important; visibility: hidden !important; opacity: 0 !important; pointer-events: none !important; }`;
        clearReplyShifts();
      }
    });
  }

  // OFFに切り替えた瞬間、既に data-tm-block-banner="1" が付いている要素を
  // 元に戻す（属性を外すだけ。要素そのものは触らないので副作用がない）
  function unmarkAllBlockedBanners() {
    safe(() => {
      document.querySelectorAll('[data-tm-block-banner="1"]').forEach(el => {
        el.removeAttribute('data-tm-block-banner');
      });
    });
  }

  function enableCommunityHighlightHiding() {
    injectCommunityHighlightStyle();
    startLeaderboardWatcher();
  }

  function disableCommunityHighlightHiding() {
    safe(() => { if (leaderboardWatcher) { leaderboardWatcher.disconnect(); leaderboardWatcher = null; } });
    removeCommunityHighlightStyle();
    unmarkAllBlockedBanners();
  }

  /* ================================================================
     設定ボタン（仕様変更耐性付き）
  ================================================================ */
  function calcSettingBtnRight() {
    const ANCHOR_SELS = [
      // 検索アイコンは配信ページ・設定ページなど、どのページのヘッダーにも
      // 常に存在しアイコン群の一番左に来るため、最優先アンカーとして使う。
      // これが無いと設定ページ（Prime/通知アイコンが無いレイアウト）では
      // 配信ページ用のキャッシュ位置に頼ってしまい、実際のアイコンとズレて被る。
      'button[aria-label="検索"]',
      '[title="検索"]',
      '[data-a-target="prime-offers-icon"]',
      '[data-a-target="header-account-menu-button"]',
      '[data-a-target="header-notifications-button"]',
      '[data-a-target="notifications-toggle"]',
      // 仕様変更耐性のための追加候補
      '[data-a-target*="prime" i]',
      '[data-a-target*="notification" i]',
      '[data-a-target*="account" i]',
      '[aria-label*="アカウント"]',
      '[aria-label*="通知"]',
    ];
    for (const sel of ANCHOR_SELS) {
      const el = safe(() => document.querySelector(sel), null);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const val = Math.max(60, window.innerWidth - rect.left + UI_POSITIONS.settingButton.autoOffset);
        // 成功した位置をキャッシュ
        if (UI_POSITIONS.settingButton.stickyOnFailure) {
          saveStickyPos('settingBtn_right', val);
        }
        return val;
      }
    }
    // anchor取得失敗時、最後に成功した位置を使う
    if (UI_POSITIONS.settingButton.stickyOnFailure) {
      const sv = getStickyPos('settingBtn_right');
      if (sv != null) return sv;
    }
    return UI_POSITIONS.settingButton.right;
  }

  function repositionSettingBtn() {
    const btn = document.querySelector('#tm-setting-icon');
    if (!btn) return;
    // シアターモード時はチャットヘッダー内へ移動する（パネル位置は変えない）
    const theater = safe(() => calcTheaterBtnPlacement(), null);
    if (theater) {
      btn.style.top = `${theater.top}px`;
      btn.style.right = `${theater.right}px`;
      // サイズもシアター時のみコミュニティボタンに合わせる（通常時は変えない）
      safe(() => applyTheaterButtonSize(theater));
      safe(() => repositionPickerBtn(theater.right, theater.top, theater.btnBox));
      return;
    }
    safe(() => clearTheaterButtonSize());
    btn.style.top = `${UI_POSITIONS.settingButton.top}px`;
    const rightVal = UI_POSITIONS.settingButton.autoCalc
      ? calcSettingBtnRight()
      : UI_POSITIONS.settingButton.right;
    btn.style.right = `${rightVal}px`;
    // 要素ピッカーのボタンも同じアンカー基準で追従させる
    safe(() => repositionPickerBtn(rightVal));
  }

  let _settingBtnTimer = null;
  function scheduleSettingBtnReposition() {
    if (_settingBtnTimer) clearTimeout(_settingBtnTimer);
    _settingBtnTimer = setTimeout(() => {
      _settingBtnTimer = null;
      repositionSettingBtn();
    }, 4500);
  }

  function createSettingsButton() {
    if (document.querySelector('#tm-setting-icon') || !document.body) return;
    const btn = document.createElement('button');
    btn.id = 'tm-setting-icon';
    btn.type = 'button';
    // アクセシビリティ: div → button に変えてキーボードでも操作できるように
    btn.setAttribute('aria-label', 'Twitch Chat mute のミュートリストを開く');
    btn.setAttribute('aria-pressed', muteEnabled ? 'true' : 'false');
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;

    Object.assign(btn.style, { fontSize: '22px' });
    if (!muteEnabled) btn.classList.add('tm-disabled');
    btn.addEventListener('click', toggleUnmuteUI);
    document.body.appendChild(btn);

    // 固定タイマーの代わりに、ヘッダー DOM のマウントを検知したら位置追従する
    _observeHeaderMountForBtn();
    // 初回は 1 回だけ短い遅延でリトライ（SPA 初回マウント直後への保険）
    setTimeout(repositionSettingBtn, 2000);
  }

  // ヘッダーボタンのマウントを MutationObserver で検知し、マウント時に位置を再計算する。
  //   これにより Twitch のロードが遅い環境でも確実にボタン位置を合わせられる。
  let _headerBtnObserver = null;
  function _observeHeaderMountForBtn() {
    if (_headerBtnObserver) return;
    _headerBtnObserver = new MutationObserver(() => {
      // 位置計算の anchor がひとつでも存在すれば即座に repos
      const anchorFound =
        document.querySelector('button[aria-label="検索"], [data-a-target="header-account-menu-button"], [data-a-target="header-notifications-button"], [data-a-target="prime-offers-icon"]');
      if (anchorFound) {
        repositionSettingBtn();
      }
    });
    // 全体に張ると重いので childList のみ + subtree。ヘッダーマウントはページ初期の一瞬だけ
    _headerBtnObserver.observe(document.body, { childList: true, subtree: true });
    // 30 秒後には自動停止（ヘッダーはそれより前に必ずマウントされる）
    setTimeout(() => {
      if (_headerBtnObserver) { _headerBtnObserver.disconnect(); _headerBtnObserver = null; }
    }, 30_000);
  }

  function updateSettingsIconLook() {
    const btn = document.querySelector('#tm-setting-icon');
    if (!btn) return;
    btn.classList.toggle('tm-disabled', !muteEnabled);
    btn.setAttribute('aria-pressed', muteEnabled ? 'true' : 'false');
  }

  /* ================================================================
     要素ピッカー（手動で選んで消す）
     仕様（ユーザー確定 2026-10-31）:
     - ヘッダーのゴミ箱の隣に専用ボタンを置き、押すと専用パネルが開く
     - パネルの「要素を選ぶ」で選択モード開始。クリックした要素を非表示化し、
       そのセレクタを localStorage に保存して次回以降も自動で消す（全チャンネル共通）
     - 選択モードは Esc か右クリックまで継続し、連続で消せる
     - ホイール上＝親要素へ範囲拡大 / ホイール下＝子要素へ縮小
     - 消した要素はパネルの一覧から個別に／一括で戻せる
     - 非表示は要素の削除ではなく data-tm-custom-hidden 属性＋CSS で行う
       （TwitchのSPAが再描画しても MutationObserver で消し直せるように）
  ================================================================ */
  const CUSTOM_HIDDEN_KEY = 'tm_custom_hidden_elements_v1';
  let customHiddenRules = (() => {
    const raw = lsGet(CUSTOM_HIDDEN_KEY);
    if (!raw) return [];
    const parsed = safe(() => JSON.parse(raw), []);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(r => r && typeof r.selector === 'string' && r.selector.trim());
  })();
  function saveCustomHiddenRules() { lsSet(CUSTOM_HIDDEN_KEY, JSON.stringify(customHiddenRules)); }

  let hiddenPanelElem = null;
  let hiddenOutsideHandlerRef = null;
  let hiddenEscHandlerRef = null;
  let pickerActive    = false;
  let pickerTarget    = null;
  let pickerStack     = [];
  let pickerAbort     = null;

  const PICKER_OWN_UI_SEL = '#tm-setting-icon, #tm-picker-icon, #tm-hidden-panel, #tm-unmute-panel, #tm-viewer-panel, #tm-toast, #tm-picker-overlay, #tm-merge-dialog';
  function isPickerOwnUI(el) {
    return !!(el && el.closest && safe(() => !!el.closest(PICKER_OWN_UI_SEL), false));
  }

  /* ================================================================
     ピン留めマークの絶対保護
     ピン留めコメントを目マークで閉じた時に出てくる再表示ボタン
     （aria-label「ピン留めメッセージを表示」）は、このスクリプトのどの
     非表示機能でも絶対に消さない。過去に要素ピッカーでピン留めコメントや
     その周辺を消した保存ルールが、このマークやその祖先要素に一致して
     「マークが出てこない」状態になるのを防ぐための最終防衛線。
  ================================================================ */
  const PIN_MARK_SELECTOR = '[aria-label*="ピン留めメッセージを表示"], [aria-label*="ピン留めを表示"], [aria-label*="unpin" i]';

  // el がピン留めマーク本人・その子孫・マークを含む祖先のいずれかなら true
  function isPinMarkRelated(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    return safe(() => !!(
      (el.matches && el.matches(PIN_MARK_SELECTOR)) ||
      (el.querySelector && el.querySelector(PIN_MARK_SELECTOR)) ||
      (el.closest && el.closest(PIN_MARK_SELECTOR))
    ), false);
  }

  // 既に付いてしまった非表示属性を、マーク本人とその祖先（8世代まで）から剥がす。
  // 祖先が隠れればマークも見えなくなるため、祖先側も保護対象に含める。
  function repairPinMarkVisibility() {
    safe(() => {
      document.querySelectorAll(PIN_MARK_SELECTOR).forEach(mark => {
        let node = mark;
        for (let i = 0; i < 8 && node && node.nodeType === Node.ELEMENT_NODE; i++) {
          if (node.removeAttribute) {
            node.removeAttribute('data-tm-custom-hidden');
            node.removeAttribute('data-tm-block-banner');
          }
          node = node.parentElement;
        }
      });
    });
  }

  // ページ全体・プレイヤー本体・チャット本体など、消すと致命的な要素は対象外
  function isDangerousPickerTarget(el) {
    if (!el || el === document.body || el === document.documentElement) return true;
    if (isPickerOwnUI(el)) return true;
    if (isPinMarkRelated(el)) return true; // ピン留めマークとその周辺はピッカーでも消せない
    if (safe(() => el.matches('[data-a-target="video-player"], .video-player, .persistent-player, .channel-root, .chat-shell, .stream-chat, [data-a-target="stream-chat"]'), false)) return true;
    const rect = safe(() => el.getBoundingClientRect(), null);
    if (rect && rect.width >= window.innerWidth * 0.92 && rect.height >= window.innerHeight * 0.92) return true;
    return false;
  }

  function selectorIsUnique(sel, el) {
    try {
      const list = document.querySelectorAll(sel);
      return list.length === 1 && list[0] === el;
    } catch (_) { return false; }
  }

  function escapeAttrValue(v) {
    return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  // ハッシュっぽい不安定なクラスを避け、構造系のクラスだけを拾う
  function stableClassesOf(el) {
    const cls = (typeof el.className === 'string') ? el.className : '';
    if (!cls) return [];
    return cls.split(/\s+/).filter(c =>
      c && c.length >= 3 &&
      !/^Sc[A-Z]/.test(c) &&
      !/^css-/.test(c) &&
      !/^[a-z]{1,3}-[a-z0-9]{6,}$/i.test(c)
    ).slice(0, 4);
  }

  function generateSelectorFor(el) {
    const tag = el.tagName.toLowerCase();
    // 1) id（英字始まりの通常形式のみ）
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) {
      const sel = '#' + escapeSelector(el.id);
      if (selectorIsUnique(sel, el)) return sel;
    }
    // 2) 安定属性
    for (const attr of ['data-a-target', 'data-test-selector', 'data-a-id']) {
      const v = el.getAttribute && el.getAttribute(attr);
      if (v) {
        const sel = `[${attr}="${escapeAttrValue(v)}"]`;
        if (selectorIsUnique(sel, el)) return sel;
      }
    }
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) {
      const sel = `${tag}[aria-label="${escapeAttrValue(aria)}"]`;
      if (selectorIsUnique(sel, el)) return sel;
    }
    // 3) クラス組み合わせ（少ない個数から試す）
    const classes = stableClassesOf(el);
    for (let n = 1; n <= classes.length; n++) {
      const sel = tag + classes.slice(0, n).map(c => '.' + escapeSelector(c)).join('');
      if (selectorIsUnique(sel, el)) return sel;
    }
    // 4) 構造パス（nth-of-type で一意化）
    const parts = [];
    let node = el;
    while (node && node !== document.body && node.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
      let seg = node.tagName.toLowerCase();
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
        parts.unshift('#' + escapeSelector(node.id));
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const sameTag = [...parent.children].filter(s => s.tagName === node.tagName);
        if (sameTag.length > 1) seg += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
      parts.unshift(seg);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function describePickedElement(el) {
    if (!el) return '';
    const tag = el.tagName.toLowerCase();
    const name =
      (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('data-a-target') || el.getAttribute('data-test-selector'))) ||
      (stableClassesOf(el)[0] || '') ||
      (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return name ? `${tag}: ${name}` : tag;
  }

  function isCustomHiddenEnabled() { return isFeatureEnabled(CUSTOM_HIDDEN_ENABLED_KEY, true); }
  function setCustomHiddenEnabled(v) { setFeatureEnabled(CUSTOM_HIDDEN_ENABLED_KEY, !!v); }

  function applyCustomHiddenRules() {
    // 一括OFFの間は、既に消えている要素を全部戻して何も消さない
    if (!isCustomHiddenEnabled()) {
      safe(() => {
        document.querySelectorAll('[data-tm-custom-hidden="1"]').forEach(el => el.removeAttribute('data-tm-custom-hidden'));
      });
      repairPinMarkVisibility();
      return;
    }
    if (customHiddenRules.length) {
      for (const rule of customHiddenRules) {
        safe(() => {
          document.querySelectorAll(rule.selector).forEach(el => {
            if (!isPickerOwnUI(el) && !isPinMarkRelated(el)) el.setAttribute('data-tm-custom-hidden', '1');
          });
        });
      }
    }
    // 保存ルールがどうであれ、ピン留めマークは最後に必ず復旧させる
    repairPinMarkVisibility();
  }

  function reapplyCustomHiddenRules() {
    safe(() => {
      document.querySelectorAll('[data-tm-custom-hidden="1"]').forEach(el => el.removeAttribute('data-tm-custom-hidden'));
    });
    applyCustomHiddenRules();
  }

  let _customHiddenObserver = null;
  let _customHiddenTimer = null;
  function startCustomHiddenObserver() {
    applyCustomHiddenRules();
    setTimeout(applyCustomHiddenRules, 1500);
    setTimeout(applyCustomHiddenRules, 4000);
    if (_customHiddenObserver || !document.body) return;
    _customHiddenObserver = new MutationObserver(() => {
      if (!customHiddenRules.length) return;
      if (_customHiddenTimer) return;
      _customHiddenTimer = setTimeout(() => {
        _customHiddenTimer = null;
        applyCustomHiddenRules();
      }, 350);
    });
    safe(() => _customHiddenObserver.observe(document.body, { childList: true, subtree: true }));
  }

  /* ---------- シアターモード時のボタン移動 ----------
     シアターモードでは上部ヘッダーが隠れ、固定位置のボタンが映像の上に
     浮いてしまう。消すのではなく、チャットヘッダー（.stream-chat-header）の
     右側・コミュニティボタンの左隣へボタン2つを移動する。
     パネル（ミュートリスト／消した要素）の位置は従来どおり変えない。
     ボタンをTwitchのDOM内へは入れず、座標計算のみで追従させる
     （Reactの再描画でボタンが消される事故を避けるため）。 */
  function isTheaterMode() {
    return safe(() => !!document.querySelector(
      '.channel-root__scroll-area--theatre-mode, .right-column--theatre, ' +
      '[class*="--theatre-mode"], [class*="--theater-mode"]'
    ), false);
  }

  // ピン留めカードの検出（コミュニティハイライト保護で使っている実績のある
  // セレクタ群と同じものを使う。カード単位＝最も外側の要素で判定する）
  const PINNED_CARD_SELECTORS = '.community-highlight-stack__card, .community-highlight, [class*="community-highlight"]';
  const PINNED_INNER_SELECTORS = [
    '.pinned-chat__highlight-card',
    '.pinned-chat__pinned-by',
    '.pinned-chat__message',
    '.pinned-chat__scrollable-area',
    '[class*="pinned-chat"]',
    '[class*="PinnedChat"]',
    '[data-test-selector*="pinned-chat" i]',
    '[aria-label*="ピン留めメッセージを表示"]',
    '[aria-label*="unpin" i]'
  ].join(', ');

  function cardIsPinned(card) {
    if (!card) return false;
    if (safe(() => !!card.querySelector(PINNED_INNER_SELECTORS), false)) return true;
    // クラスで拾えない場合はカード冒頭のテキストで判定（「ピン留め／pinned by」）
    const text = safe(() => (card.textContent || '').slice(0, 600), '');
    return /ピン留め/.test(text) || /pinned by/i.test(text);
  }

  // 表示中のピン留めカード（外側のカード要素）の矩形一覧を返す
  function findPinnedCardRects() {
    const rects = [];
    const seen = new Set();
    const push = (el) => {
      if (!el || seen.has(el) || isPickerOwnUI(el)) return;
      seen.add(el);
      const r = safe(() => el.getBoundingClientRect(), null);
      if (r && r.width > 0 && r.height > 0) rects.push(r);
    };
    // 1) カード単位でピン留めを含むものを拾う
    safe(() => document.querySelectorAll(PINNED_CARD_SELECTORS), null)?.forEach(card => {
      if (cardIsPinned(card)) push(card);
    });
    // 2) カード構造の外にあるピン留め要素は、最も近いカード祖先（無ければ要素自身）で拾う
    safe(() => document.querySelectorAll(PINNED_INNER_SELECTORS), null)?.forEach(el => {
      const card = safe(() => el.closest(PINNED_CARD_SELECTORS), null);
      push(card || el);
    });
    return rects;
  }

  // ピン留めマークの検出（PIN_MARK_SELECTOR はピッカー保護の節で定義済み）
  function findPinMarkElement(header) {
    if (header) {
      const inHeader = safe(() => header.querySelector(PIN_MARK_SELECTOR), null);
      if (inHeader) return inHeader;
    }
    return safe(() => document.querySelector(PIN_MARK_SELECTOR), null);
  }

  // 戻り値は「ゴミ箱ボタン」の top/right と、コミュニティボタンの実測サイズ。
  // ピッカーはその左隣に並ぶ。サイズは実物から測るため、Twitch側の寸法が
  // 変わっても追従できる（測れない場合の既定は 枠30px / アイコン20px）。
  function calcTheaterBtnPlacement() {
    if (!isTheaterMode()) return null;
    const header = safe(() => document.querySelector('.stream-chat-header'), null);
    if (!header) return null;
    const hr = safe(() => header.getBoundingClientRect(), null);
    if (!hr || hr.width < 50 || hr.height < 10) return null;
    let btnBox = 30;   // ボタン枠の一辺
    let iconSize = 20; // 中のアイコン（SVG）の大きさ
    // ボタンのサイズは実物のアイコンボタンから測る（コミュニティ優先、無ければピンのマーク）
    const measureSizeFrom = (btnEl) => {
      const r = safe(() => btnEl.getBoundingClientRect(), null);
      if (!r || !(r.height > 0)) return;
      btnBox = Math.round(r.height);
      const svg = safe(() => btnEl.querySelector('svg'), null);
      const sr = svg ? safe(() => svg.getBoundingClientRect(), null) : null;
      if (sr && sr.height >= 8 && sr.height <= btnBox) iconSize = Math.round(sr.height);
      else iconSize = Math.max(12, btnBox - 10);
    };
    // コミュニティ（視聴者リスト）ボタン
    const communityBtn = safe(() => header.querySelector(
      'button[data-test-selector="chat-viewer-list"], button[aria-label="コミュニティ"]'
    ), null);
    // アンカー候補（右側に居てほしい Twitch 純正アイコン）の左端リスト。
    // 自前ボタン2つは「候補の中で一番左の要素」より左に並べる。これにより
    // ピン留めマークが出ている時は、右から ピン留めマーク→ゴミ箱→要素ピッカー
    // の順になり、マークが自前ボタンに隠れて消えたように見えることがなくなる。
    const anchorLefts = [];
    if (communityBtn) {
      const cr = safe(() => communityBtn.getBoundingClientRect(), null);
      if (cr && cr.width > 0) {
        anchorLefts.push(cr.left);
        measureSizeFrom(communityBtn);
      }
    }
    const pinMark = findPinMarkElement(header);
    if (pinMark && pinMark !== communityBtn) {
      const pr = safe(() => pinMark.getBoundingClientRect(), null);
      // ヘッダー内の要素は無条件で、ヘッダー外の要素はヘッダー帯と縦に重なる場合だけ対象
      const inHeaderBand = safe(() => header.contains(pinMark), false)
        || (pr && pr.bottom > hr.top && pr.top < hr.bottom);
      if (pr && pr.width > 0 && pr.height > 0 && inHeaderBand) {
        anchorLefts.push(pr.left);
        if (!communityBtn) measureSizeFrom(pinMark);
      }
    }
    let right = null;
    if (anchorLefts.length) {
      // ゴミ箱の right = 一番左のアンカー左端から間隔6px
      right = Math.max(0, Math.round(window.innerWidth - Math.min(...anchorLefts) + 6));
    }
    if (right === null) {
      // 無ければヘッダー右端（余白8px）に合わせる
      right = Math.max(0, Math.round(window.innerWidth - hr.right + 8));
    }
    // ヘッダーの縦中央に合わせる
    const top = Math.max(0, Math.round(hr.top + (hr.height - btnBox) / 2));
    const placement = { top, right, btnBox, iconSize };

    // ピン留めコメントとの重なり回避: ボタン2つの占有範囲（右端から
    // 枠×2 + 間隔6px）が、表示中のピン留めカード（外側のカード単位）と実際に
    // 重なる場合だけ、カードの下端+6px へボタン位置をずらす。ピン留め自体は
    // 隠さない。重なっていなければ従来位置のまま（実測判定なので、重ならない
    // レイアウトでは何も変えない）。ずらした先で別のカードと重なるケースに
    // 備えて最大3回まで再判定する。
    for (let iter = 0; iter < 3; iter++) {
      const area = {
        left:   window.innerWidth - (placement.right + placement.btnBox * 2 + 6),
        right:  window.innerWidth - placement.right,
        top:    placement.top,
        bottom: placement.top + placement.btnBox
      };
      let lowestBottom = -1;
      for (const r of findPinnedCardRects()) {
        const overlaps = !(r.bottom <= area.top || r.top >= area.bottom || r.left >= area.right || r.right <= area.left);
        if (overlaps) lowestBottom = Math.max(lowestBottom, r.bottom);
      }
      if (lowestBottom < 0) break;
      placement.top = Math.round(lowestBottom + 6);
    }
    return placement;
  }

  // シアター時のみ、ボタン2つの大きさをコミュニティボタンに合わせる。
  // アイコン font-size を iconSize にし、padding で枠が btnBox になるよう調整する。
  let _theaterSizeApplied = false;
  function applyTheaterButtonSize(placement) {
    if (!placement) return;
    _theaterSizeApplied = true;
    const pad = Math.max(0, (placement.btnBox - placement.iconSize) / 2);
    for (const id of ['#tm-setting-icon', '#tm-picker-icon']) {
      const el = document.querySelector(id);
      if (!el) continue;
      el.style.fontSize = `${placement.iconSize}px`;
      el.style.padding = `${pad}px`;
    }
  }

  // 通常時に戻ったら従来サイズ（アイコン22px / padding 4px）に戻す。
  // ゴミ箱ボタンは通常サイズが JS 側のインライン指定（fontSize:22px）で
  // 決まっているため、単に指定を消すと継承サイズに落ちてしまう。両ボタンとも
  // 明示的に通常値へ戻すのが確実。
  function clearTheaterButtonSize() {
    if (!_theaterSizeApplied) return;
    _theaterSizeApplied = false;
    for (const id of ['#tm-setting-icon', '#tm-picker-icon']) {
      const el = document.querySelector(id);
      if (!el) continue;
      el.style.fontSize = '22px';
      el.style.padding = '4px';
    }
  }

  // シアター切替はクラス変更で起きるため、class の MutationObserver と
  // 定期チェックで「状態かアンカー位置が変わった時だけ」再配置する
  let _btnPlacementKey = null;
  let _btnPlacementObserver = null;
  let _btnPlacementTimer = null;
  let _btnPlacementInterval = null;
  function refreshButtonPlacementIfChanged() {
    const theater = isTheaterMode();
    let key = theater ? 'theater' : 'normal';
    if (theater) {
      const header = safe(() => document.querySelector('.stream-chat-header'), null);
      const hr = header ? safe(() => header.getBoundingClientRect(), null) : null;
      const cb = header ? safe(() => header.querySelector('button[data-test-selector="chat-viewer-list"], button[aria-label="コミュニティ"]'), null) : null;
      const cr = cb ? safe(() => cb.getBoundingClientRect(), null) : null;
      key += ':' + (hr ? `${Math.round(hr.top)},${Math.round(hr.right)},${Math.round(hr.height)}` : 'noheader')
           + ':' + (cr ? `${Math.round(cr.left)},${Math.round(cr.height)}` : 'nobtn');
      // ピン留めカードの出現・消滅・高さ変化でも再配置が要るため、その範囲もキーに含める
      const pinRects = safe(() => findPinnedCardRects(), []);
      key += ':pin' + (pinRects.length
        ? pinRects.map(r => `${Math.round(r.top)},${Math.round(r.height)}`).join('|')
        : 'none');
      // ピン留めマーク（閉じた時に出る再表示ボタン）の出現・位置もキーに含める
      const headerEl = safe(() => document.querySelector('.stream-chat-header'), null);
      const pinMarkEl = safe(() => findPinMarkElement(headerEl), null);
      const pmr = pinMarkEl ? safe(() => pinMarkEl.getBoundingClientRect(), null) : null;
      key += ':pinmark' + (pmr && pmr.width > 0 ? `${Math.round(pmr.left)}` : 'none');
    }
    if (key === _btnPlacementKey) return;
    _btnPlacementKey = key;
    repositionSettingBtn();
  }
  function startButtonPlacementWatch() {
    refreshButtonPlacementIfChanged();
    if (!_btnPlacementObserver && document.body && typeof MutationObserver !== 'undefined') {
      _btnPlacementObserver = new MutationObserver(() => {
        if (_btnPlacementTimer) return;
        _btnPlacementTimer = setTimeout(() => {
          _btnPlacementTimer = null;
          refreshButtonPlacementIfChanged();
        }, 250);
      });
      safe(() => _btnPlacementObserver.observe(document.body, {
        attributes: true, attributeFilter: ['class'], subtree: true
      }));
    }
    // チャットヘッダーの出現など class 変更を伴わないケースの保険
    if (!_btnPlacementInterval) {
      _btnPlacementInterval = setInterval(refreshButtonPlacementIfChanged, 2000);
    }
  }

  /* ---------- 専用パネル（起動＋管理） ---------- */
  function repositionPickerBtn(baseRight, baseTop, btnBox) {
    const btn = document.querySelector('#tm-picker-icon');
    if (!btn) return;
    const rightVal = (typeof baseRight === 'number' && Number.isFinite(baseRight))
      ? baseRight
      : (UI_POSITIONS.settingButton.autoCalc ? calcSettingBtnRight() : UI_POSITIONS.settingButton.right);
    btn.style.top = `${(typeof baseTop === 'number' && Number.isFinite(baseTop)) ? baseTop : UI_POSITIONS.settingButton.top}px`;
    // ゴミ箱ボタンの左隣（ボタン幅 + 間隔6px）。幅は通常時30px、シアター時は実測値
    const box = (typeof btnBox === 'number' && Number.isFinite(btnBox) && btnBox > 0) ? btnBox : 30;
    btn.style.right = `${rightVal + box + 6}px`;
    // シアター経由でない通常配置の時は、ピッカー側のサイズ指定も通常時に戻す
    if (!(typeof baseTop === 'number' && Number.isFinite(baseTop))) {
      safe(() => clearTheaterButtonSize());
    }
  }

  function createPickerButton() {
    if (document.querySelector('#tm-picker-icon') || !document.body) return;
    const btn = document.createElement('button');
    btn.id = 'tm-picker-icon';
    btn.type = 'button';
    btn.setAttribute('aria-label', '消した要素のパネルを開く');
    btn.title = '消した要素（要素ピッカー）';
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="7"/><path d="M12 2v3"/><path d="M12 19v3"/><path d="M2 12h3"/><path d="M19 12h3"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/></svg>`;
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggleHiddenPanel(); });
    document.body.appendChild(btn);
    repositionPickerBtn();
  }

  function toggleHiddenPanel() {
    if (pickerActive) { stopPicker(); return; }
    if (hiddenPanelElem) { closeHiddenPanel(); return; }
    openHiddenPanel();
  }

  function openHiddenPanel() {
    const panel = document.createElement('div');
    hiddenPanelElem = panel;
    panel.id = 'tm-hidden-panel';
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', '消した要素');
    // 見た目は CSS 側（#tm-hidden-panel）に寄せ、ここは配置だけを指定する。
    // ミュートリストパネル（プレイヤー右上）の鏡写しで、プレイヤー左上に置く。
    Object.assign(panel.style, { position: 'fixed', zIndex: '9999998' });
    positionHiddenPanel(panel);
    document.body.appendChild(panel);
    renderHiddenPanel();

    // ミュートリストと同様に、パネル外クリックで閉じる（開いたクリック自身では閉じないよう遅延登録）
    hiddenOutsideHandlerRef = (evt) => {
      if (!hiddenPanelElem || pickerActive) return;
      const t = evt.target;
      if (t && t.closest && t.closest('#tm-picker-icon')) return; // ボタン側のトグルに任せる
      if (hiddenPanelElem.contains(t)) return;
      closeHiddenPanel();
    };
    setTimeout(() => {
      if (hiddenPanelElem && hiddenOutsideHandlerRef) {
        document.addEventListener('click', hiddenOutsideHandlerRef);
      }
    }, 0);

    // Esc でも閉じる（選択モード中の Esc はピッカー終了が優先）
    hiddenEscHandlerRef = (ev) => {
      if (ev.key !== 'Escape' || !hiddenPanelElem || pickerActive) return;
      ev.stopPropagation();
      closeHiddenPanel();
    };
    document.addEventListener('keydown', hiddenEscHandlerRef);
  }

  function closeHiddenPanel() {
    if (hiddenOutsideHandlerRef) {
      document.removeEventListener('click', hiddenOutsideHandlerRef);
      hiddenOutsideHandlerRef = null;
    }
    if (hiddenEscHandlerRef) {
      document.removeEventListener('keydown', hiddenEscHandlerRef);
      hiddenEscHandlerRef = null;
    }
    if (hiddenPanelElem) { safe(() => hiddenPanelElem.remove()); hiddenPanelElem = null; }
  }

  function renderHiddenPanel() {
    if (!hiddenPanelElem) return;
    const panel = hiddenPanelElem;
    panel.innerHTML = '';

    const hdr = document.createElement('div');
    hdr.className = 'tm-hidden-header';
    const title = document.createElement('span');
    title.className = 'tm-hidden-title';
    title.textContent = '消した要素';
    const count = document.createElement('span');
    count.className = 'tm-hidden-count';
    count.textContent = `${customHiddenRules.length}件`;
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'tm-hidden-close';
    closeBtn.setAttribute('aria-label', '閉じる');
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeHiddenPanel(); });
    // 一括ON/OFFトグル（右上）: ピッカーで消した要素全体をまとめてON/OFFする
    const masterToggle = document.createElement('div');
    masterToggle.className = 'tm-enable-toggle' + (isCustomHiddenEnabled() ? ' tm-on' : '');
    masterToggle.setAttribute('role', 'switch');
    masterToggle.setAttribute('aria-checked', isCustomHiddenEnabled() ? 'true' : 'false');
    masterToggle.setAttribute('aria-label', '消した要素をまとめてON/OFF');
    masterToggle.title = '消した要素をまとめてON/OFF';
    masterToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const next = !isCustomHiddenEnabled();
      setCustomHiddenEnabled(next);
      masterToggle.classList.toggle('tm-on', next);
      masterToggle.setAttribute('aria-checked', next ? 'true' : 'false');
      applyCustomHiddenRules();
    });
    hdr.appendChild(title);
    hdr.appendChild(count);
    hdr.appendChild(masterToggle);
    hdr.appendChild(closeBtn);
    panel.appendChild(hdr);

    const startBtn = document.createElement('button');
    startBtn.type = 'button';
    startBtn.className = 'tm-hidden-start';
    startBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="7"/><path d="M12 2v3"/><path d="M12 19v3"/><path d="M2 12h3"/><path d="M19 12h3"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/></svg><span>要素を選んで消す</span>`;
    startBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeHiddenPanel();
      setTimeout(startPicker, 0);
    });
    panel.appendChild(startBtn);

    const hint = document.createElement('div');
    hint.className = 'tm-hidden-hint';
    hint.innerHTML = '<span class="tm-kbd">ホイール</span> 範囲の拡大縮小　/　<span class="tm-kbd">クリック</span> 消去 <br><span class="tm-kbd">Esc</span> または <span class="tm-kbd">右クリック</span> でモード終了。消したものは保存され、次回も自動で消去されます。';
    panel.appendChild(hint);

    const body = document.createElement('div');
    body.id = 'tm-hidden-body';

    if (!customHiddenRules.length) {
      const em = document.createElement('div');
      em.className = 'tm-hidden-empty';
      em.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="7"/><path d="M12 2v3"/><path d="M12 19v3"/><path d="M2 12h3"/><path d="M19 12h3"/></svg><br>まだありません`;
      body.appendChild(em);
    } else {
      [...customHiddenRules].reverse().forEach(rule => {
        const row = document.createElement('div');
        row.className = 'tm-hidden-row';
        const left = document.createElement('div');
        left.className = 'tm-hidden-row-main';
        const label = document.createElement('div');
        label.className = 'tm-hidden-label';
        label.textContent = rule.label || rule.selector;
        label.title = rule.selector;
        const sub = document.createElement('div');
        sub.className = 'tm-hidden-sub';
        sub.title = rule.selector;
        if (rule.createdAt && formatMutedAt(rule.createdAt)) {
          const dateSpan = document.createElement('span');
          dateSpan.textContent = `${formatMutedAt(rule.createdAt)} / `;
          sub.appendChild(dateSpan);
        }
        const selSpan = document.createElement('span');
        selSpan.className = 'tm-hidden-selector';
        selSpan.textContent = rule.selector;
        sub.appendChild(selSpan);
        left.appendChild(label);
        left.appendChild(sub);
        const undoBtn = document.createElement('button');
        undoBtn.type = 'button';
        undoBtn.className = 'tm-hidden-undo';
        undoBtn.textContent = '戻す';
        undoBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          customHiddenRules = customHiddenRules.filter(r => r !== rule);
          saveCustomHiddenRules();
          reapplyCustomHiddenRules();
          renderHiddenPanel();
          showToast('↩️ 要素を戻しました');
        });
        row.appendChild(left);
        row.appendChild(undoBtn);
        body.appendChild(row);
      });

      const allBtn = document.createElement('button');
      allBtn.type = 'button';
      allBtn.className = 'tm-hidden-all';
      allBtn.textContent = 'リセット';
      allBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!confirm(`消した要素 ${customHiddenRules.length}件 を全部戻しますか？`)) return;
        customHiddenRules = [];
        saveCustomHiddenRules();
        reapplyCustomHiddenRules();
        renderHiddenPanel();
        showToast('↩️ 消した要素を全部戻しました');
      });
      body.appendChild(allBtn);
    }
    panel.appendChild(body);
  }

  /* ---------- 選択モード本体 ---------- */
  function ensurePickerOverlay() {
    let ov = document.getElementById('tm-picker-overlay');
    if (ov) return ov;
    ov = document.createElement('div');
    ov.id = 'tm-picker-overlay';
    Object.assign(ov.style, {
      position: 'fixed', zIndex: '10000001', pointerEvents: 'none',
      border: '2px solid rgba(255, 59, 48, 0.95)',
      background: 'rgba(255, 59, 48, 0.08)',
      borderRadius: '2px', display: 'none', boxSizing: 'border-box'
    });
    const label = document.createElement('div');
    label.id = 'tm-picker-overlay-label';
    Object.assign(label.style, {
      position: 'absolute', left: '0', top: '-22px', maxWidth: '320px',
      background: 'rgba(255, 59, 48, 0.95)', color: '#fff',
      fontSize: '11px', lineHeight: '1.4', padding: '2px 6px', borderRadius: '3px',
      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      fontFamily: FONT_STACK_JP
    });
    ov.appendChild(label);
    document.body.appendChild(ov);
    return ov;
  }

  function updatePickerOverlay() {
    const ov = ensurePickerOverlay();
    if (!pickerActive || !pickerTarget || !pickerTarget.isConnected) { ov.style.display = 'none'; return; }
    const rect = pickerTarget.getBoundingClientRect();
    ov.style.display = 'block';
    ov.style.left = `${rect.left}px`;
    ov.style.top = `${rect.top}px`;
    ov.style.width = `${rect.width}px`;
    ov.style.height = `${rect.height}px`;
    const label = ov.querySelector('#tm-picker-overlay-label');
    if (label) {
      label.textContent = describePickedElement(pickerTarget);
      label.style.top = rect.top >= 24 ? '-22px' : '2px';
    }
  }

  function setPickerTarget(el) {
    if (!el || isDangerousPickerTarget(el)) return;
    pickerTarget = el;
    updatePickerOverlay();
  }

  function hidePickedTarget() {
    const el = pickerTarget;
    if (!el || isDangerousPickerTarget(el)) return;
    const selector = generateSelectorFor(el);
    const label = describePickedElement(el);
    const existing = customHiddenRules.find(r => r.selector === selector);
    if (!existing) {
      customHiddenRules.push({ selector, label, createdAt: Date.now() });
      saveCustomHiddenRules();
    }
    applyCustomHiddenRules();
    pickerTarget = null;
    pickerStack = [];
    updatePickerOverlay();
    showToast(existing
      ? `すでに保存済みの要素でした（保存 ${customHiddenRules.length}件）`
      : `🗑 消しました（保存 ${customHiddenRules.length}件） Esc／右クリックで終了`, 2600);
  }

  function startPicker() {
    if (pickerActive) return;
    pickerActive = true;
    pickerTarget = null;
    pickerStack = [];
    pickerAbort = new AbortController();
    const sig = pickerAbort.signal;
    const cap = { capture: true, signal: sig };

    document.addEventListener('mouseover', (e) => {
      if (e.target && e.target.nodeType === Node.ELEMENT_NODE) setPickerTarget(e.target);
    }, cap);
    document.addEventListener('click', (e) => {
      if (isPickerOwnUI(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      hidePickedTarget();
    }, cap);
    document.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      stopPicker();
      showToast('要素ピッカーを終了しました');
    }, cap);
    document.addEventListener('wheel', (e) => {
      if (!pickerTarget) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.deltaY < 0) {
        const parent = pickerTarget.parentElement;
        if (parent && !isDangerousPickerTarget(parent)) {
          pickerStack.push(pickerTarget);
          pickerTarget = parent;
          updatePickerOverlay();
        }
      } else if (e.deltaY > 0) {
        if (pickerStack.length) {
          pickerTarget = pickerStack.pop();
          updatePickerOverlay();
        }
      }
    }, { capture: true, signal: sig, passive: false });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        stopPicker();
        showToast('要素ピッカーを終了しました');
      }
    }, cap);
    window.addEventListener('resize', updatePickerOverlay, { signal: sig, passive: true });
    window.addEventListener('scroll', updatePickerOverlay, { capture: true, signal: sig, passive: true });

    const btn = document.querySelector('#tm-picker-icon');
    if (btn) btn.classList.add('tm-picker-active');
    safe(() => { document.body.style.cursor = 'crosshair'; });
    showToast('🎯 選択モード：クリックで消す／ホイール上で拡大・下で縮小／Esc・右クリックで終了', 3600);
  }

  function stopPicker() {
    if (!pickerActive) return;
    pickerActive = false;
    if (pickerAbort) { safe(() => pickerAbort.abort()); pickerAbort = null; }
    pickerTarget = null;
    pickerStack = [];
    const ov = document.getElementById('tm-picker-overlay');
    if (ov) ov.style.display = 'none';
    const btn = document.querySelector('#tm-picker-icon');
    if (btn) btn.classList.remove('tm-picker-active');
    safe(() => { document.body.style.cursor = ''; });
  }

  /* ================================================================
     ドラッグ
  ================================================================ */
  /**
   * ドラッグハンドラを ListenerScope（AbortController）で一元管理する。
   * panel に _tmDragScope を保持して、前回のスコープがあれば dispose してから新しいリスナーを張る。
   * renderPage() で handle が作り直されても document リスナーが重複しないことを保証する。
   */
  function setupDragHandler(panel, handle, { excludeSelector, forceBodyCursor = false } = {}) {
    if (handle._tmDragHooked) return;
    handle._tmDragHooked = true;

    // 既存スコープが残っていたら初期化前に確実に破棄
    if (panel._tmDragScope) { panel._tmDragScope.dispose(); }
    const scope = new ListenerScope();
    panel._tmDragScope = scope;

    let dragging = false;
    let sx = 0, sy = 0, oR = 0, oT = 0;

    const onMouseMove = (e) => {
      if (!dragging) return;
      panel.style.right = `${Math.max(0, oR - (e.clientX - sx))}px`;
      panel.style.top   = `${Math.max(0, oT + (e.clientY - sy))}px`;
    };
    const onMouseUp = () => {
      if (!dragging) return;
      dragging = false;
      panel.classList.remove('tm-dragging');
      if (forceBodyCursor) document.body.style.cursor = '';
    };

    scope.on(handle, 'mousedown', (e) => {
      if (e.button !== 0) return;
      if (excludeSelector && e.target && e.target.closest && e.target.closest(excludeSelector)) return;

      dragging = true;
      sx = e.clientX;
      sy = e.clientY;
      const rect = panel.getBoundingClientRect();
      oR = window.innerWidth - rect.right;
      oT = rect.top;

      panel.classList.add('tm-dragging');
      if (forceBodyCursor) document.body.style.cursor = 'grabbing';
      e.preventDefault();
    });

    scope.on(document, 'mousemove', onMouseMove);
    scope.on(document, 'mouseup', onMouseUp);

    // panel がDOMから外れたら自動クリーンアップ
    const cleanupObs = new MutationObserver(() => {
      if (panel.isConnected) return;
      if (forceBodyCursor) document.body.style.cursor = '';
      scope.dispose();
      cleanupObs.disconnect();
    });
    cleanupObs.observe(panel.parentNode || document.body, { childList: true, subtree: true });
    scope.add(() => cleanupObs.disconnect());
  }

  function setupPanelDrag(panel, handle) {
    setupDragHandler(panel, handle, {
      excludeSelector: '.tm-enable-toggle,.tm-viewer-toggle,button',
      forceBodyCursor: false
    });
  }

  function setupPanelDragWithGrab(panel, handle) {
    setupDragHandler(panel, handle, {
      excludeSelector: 'button',
      forceBodyCursor: true
    });
  }

  /* ================================================================
     縦リサイズ
  ================================================================ */
  /**
   * 縦リサイズハンドラも ListenerScope で一元管理。
   * renderPage() で handle が作り直されても document リスナーが重複しないことを保証し、
   * panel が DOM から外れたら自動で全リスナーを破棄する。
   */
  function setupVerticalResize(panel, handle) {
    if (handle._tmResizeHooked) return;
    handle._tmResizeHooked = true;

    if (panel._tmResizeScope) { panel._tmResizeScope.dispose(); }
    const scope = new ListenerScope();
    panel._tmResizeScope = scope;

    let resizing = false, sy = 0, sh = 0;

    scope.on(handle, 'mousedown', (e) => {
      resizing = true;
      sy = e.clientY;
      sh = panel.getBoundingClientRect().height;
      e.preventDefault();
      e.stopPropagation();
    });

    const onMove = (e) => {
      if (!resizing) return;
      const newH = Math.max(PANEL_H_MIN, Math.min(PANEL_H_MAX, sh + (e.clientY - sy)));
      panel.style.height = `${newH}px`;
      panelHeight = newH;
    };
    const onUp = () => {
      if (!resizing) return;
      resizing = false;
      savePanelH();
    };
    scope.on(document, 'mousemove', onMove);
    scope.on(document, 'mouseup', onUp);

    const cleanupObs = new MutationObserver(() => {
      if (panel.isConnected) return;
      scope.dispose();
      cleanupObs.disconnect();
    });
    cleanupObs.observe(panel.parentNode || document.body, { childList: true, subtree: true });
    scope.add(() => cleanupObs.disconnect());
  }

  /* ================================================================
     機能ロジック（メインパネル）
  ================================================================ */
  let currentPage      = 0;
  let panelElem        = null;
  let panelSnapshot    = null;
  const pendingUnmutes = new Set();
  let filterText       = '';
  let renderTimer      = null;
  let isComposing      = false;
  let escHandlerRef    = null;
  let actionsMenuOpen  = false;
  let panelView        = 'list'; // 'list'（ミュートリスト） | 'settings'（コメント設定） | 'ng'（NGワード）
  let ngFilterText     = '';     // 設定画面でのNGワード絞り込み文字列

  const SORT_LABELS = {
    newest: '新着順',
    oldest: '古い順',
    name:   '名前順'
  };

  function getSortButtonLabel() {
    if (pendingUnmutes.size >= 3) return '確定';
    return SORT_LABELS[sortOrder] || '新着順';
  }

  function updateSortButtonLabel() {
    if (!panelElem) return;
    const sortBtn = panelElem.querySelector('.tm-sort-btn');
    if (!sortBtn) return;
    sortBtn.textContent = getSortButtonLabel();
    updateSortButtonStyle();
  }

  function updateSortButtonStyle() {
    if (!panelElem) return;
    const sortBtn = panelElem.querySelector('.tm-sort-btn');
    if (!sortBtn) return;

    const isConfirmMode = pendingUnmutes.size >= 3;
    if (isConfirmMode) {
      sortBtn.classList.add('tm-confirm-mode');
      sortBtn.title = '保留中の解除をすべて確定します（クリック）';
      sortBtn.style.minWidth = '45px';
    } else {
      sortBtn.classList.remove('tm-confirm-mode');
      sortBtn.title = '';
      sortBtn.style.minWidth = '45px';
    }
  }

  function confirmUnmuteUser(user) {
    if (!user) return false;
    try {
      mutedUsers.delete(user);
      if (mutedDisplays[user]) delete mutedDisplays[user];
      if (pendingUnmutes.has(user)) pendingUnmutes.delete(user);
      if (Array.isArray(panelSnapshot)) {
        const i = panelSnapshot.indexOf(user);
        if (i !== -1) panelSnapshot.splice(i, 1);
      }

      safe(() => {
        document.querySelectorAll(HIDDEN_ATTR_SEL).forEach(r => {
          safe(() => {
            const info = extractUserFromRow(r);
            if (info && info.login === user) showVodChatLine(r);
          });
        });
      });

      invalidateFilterCache();
      saveMuted();
      return true;
    } catch (err) {
      safe(() => {
        mutedUsers.delete(user);
        if (mutedDisplays[user]) delete mutedDisplays[user];
        if (pendingUnmutes.has(user)) pendingUnmutes.delete(user);
        invalidateFilterCache();
        saveMuted();
      });
      return false;
    }
  }

  function confirmAllPendingUnmutes() {
    const targets = [...pendingUnmutes];
    if (!targets.length) return false;

    const nl = panelElem && panelElem.querySelector('.tm-page-list');
    const prevScroll = nl ? nl.scrollTop : 0;

    let changed = false;
    for (const user of targets) {
      if (confirmUnmuteUser(user)) changed = true;
    }
    pendingUnmutes.clear();
    updateSortButtonLabel();

    if (changed && panelElem) {
      renderPage();
      requestAnimationFrame(() => {
        safe(() => {
          const nl2 = panelElem && panelElem.querySelector('.tm-page-list');
          if (nl2) nl2.scrollTop = Math.min(prevScroll, Math.max(0, nl2.scrollHeight - nl2.clientHeight));
        });
      });
    }
    return changed;
  }

  function scheduleRenderDebounced() {
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      renderTimer = null;
      safe(() => renderPage(true));
    }, DEBOUNCE_MS);
  }

  function outsideHandler(evt) {
    if (!panelElem) return;
    const t = evt.target;

    if (document.getElementById('tm-merge-dialog')) return;
    if (t.id === 'tm-setting-icon') return;
    if (t.id === 'tm-danmaku-btn') return; // 弾幕ボタンは外側クリック扱いにしない
    // チャンネルポイントボーナスのボタンは外側クリック扱いにしない
    //   （自動回収の programmatic click でパネルが閉じてしまうのを防ぐ。
    //     click の target はボタン本体になるため、子要素のアイコンも含めて判定する）
    if (t.closest && (t.closest('.claimable-bonus__icon, .claimable-bonus') ||
        (t.querySelector && t.querySelector('.claimable-bonus__icon')))) return;

    const isInMainPanel   = panelElem.contains(t);
    const isInViewerPanel = viewerPanelElem && viewerPanelElem.contains(t);
    if (isInViewerPanel) return;

    if (actionsMenuOpen) {
      const wrap = panelElem.querySelector('.tm-actions-wrap');
      if (wrap && !wrap.contains(t)) closeActionsMenu();
    }

    if (viewerPanelElem) {
      if (!isInMainPanel) closeViewerPanel();
      return;
    }

    if (!isInMainPanel) closePanel();
  }

  function closePanel() {
    if (!panelElem) return;
    safe(() => closeFilterSamples()); // フィルター実例の枠も一緒に閉じる
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }

    pendingUnmutes.clear();
    panelSnapshot = null;
    // パネル閉じと同時に drag/resize の ListenerScope を確実に破棄（二重保険）
    if (panelElem._tmDragScope)   { try { panelElem._tmDragScope.dispose();   } catch (_) {} }
    if (panelElem._tmResizeScope) { try { panelElem._tmResizeScope.dispose(); } catch (_) {} }
    _clearShellRefs();
    panelElem.remove();
    panelElem = null;
    actionsMenuOpen = false;

    safe(() => { if (globalMuteButton && globalMuteButton.parentElement) globalMuteButton.remove(); });
    currentHoverRow     = null;
    currentHoverLogin   = null;
    currentHoverDisplay = null;

    document.removeEventListener('click', outsideHandler);
    if (escHandlerRef) {
      document.removeEventListener('keydown', escHandlerRef);
      escHandlerRef = null;
    }
    closeViewerPanel();
  }

  function ensureMutedDisplays() {
    safeExec(() => {
      // display エントリを欠いているユーザーがいなければ querySelectorAll ごと省略する
      const missing = [];
      for (const l of mutedUsers) if (!mutedDisplays[l]) missing.push(l);
      if (!missing.length) return;

      // 大手配信で [data-a-user] が数百件あるとこのループが重いので、
      // 初回取得をキャッシュして不要な再走査を避ける。
      // キャッシュはパネルを開いたセッション内でのみ有効。
      let map = ensureMutedDisplays._cache;
      if (!map) {
        map = new Map();
        const nodes = document.querySelectorAll('[data-a-user]');
        for (const el of nodes) {
          const id = el.dataset && el.dataset.aUser;
          if (id) {
            const key = id.toLowerCase();
            if (!map.has(key)) map.set(key, (el.textContent || '').trim() || id);
          }
        }
        ensureMutedDisplays._cache = map;
        // 少ししたらキャッシュを破棄して最新のチャットDOMを取れるようにする
        setTimeout(() => { ensureMutedDisplays._cache = null; }, 5000);
      }

      let changed = false;
      for (const l of missing) {
        const v = map.get(l) || l;
        if (getDisplay(l) === l && v !== l) {
          mutedDisplays[l] = normalizeDisplayEntry({ display: v, mutedAt: null }, l);
          changed = true;
        }
      }
      if (changed) { invalidateFilterCache(); saveMuted(); }
    }, undefined, 'ensureMutedDisplays');
  }

  function toggleUnmuteUI(e) {
    if (e && e.stopPropagation) e.stopPropagation();
    if (panelElem) { closePanel(); return; }

    // 開く直前に保存状態を読み直す（同一タブ内の別インスタンスが変更した内容を、
    //   イベント同期が無い相手でも開いた瞬間に反映するため）
    safeExec(() => {
      const raw = lsGet(STORAGE_KEY);
      if (raw && raw !== _lastLocalPayload) {
        const st = coerceState(JSON.parse(raw));
        if (st) {
          rebuildFromState(st);
          invalidateFilterCache();
          panelSnapshot = null;
        }
      }
    }, undefined, 'reload state on panel open');

    const panel = document.createElement('div');
    panelElem = panel;
    panel.id = 'tm-unmute-panel';
    // アクセシビリティ: リージョンとしてマークし、スクリーンリーダーにパネルの存在を伝える
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', 'ミュートユーザー一覧');
    Object.assign(panel.style, {
      position: 'fixed',
      zIndex:   '999999',
      height:   `${panelHeight}px`
    });
    positionMainPanel(panel);
    document.body.appendChild(panel);

    panelSnapshot = [...mutedUsers].reverse();
    pendingUnmutes.clear();
    filterText = '';
    actionsMenuOpen = false;

    invalidateFilterCache();
    ensureMutedDisplays();
    renderPage();

    setTimeout(() => document.addEventListener('click', outsideHandler), 0);

    // マージダイアログが開いている間は専用の ESC に譲る（パネルも閉じない）
    escHandlerRef = (ev) => {
      if (ev.key !== 'Escape' || !panelElem) return;
      if (document.getElementById('tm-merge-dialog')) return;
      ev.stopPropagation();
      if (actionsMenuOpen) { closeActionsMenu(); return; }
      closePanel();
    };
    document.addEventListener('keydown', escHandlerRef);
  }

  function addMutedByLogin(rawLogin, displayName) {
    if (!rawLogin) return false;
    let l = String(rawLogin).trim().toLowerCase();
    if (l.startsWith('@')) l = l.slice(1);
    if (!/^[a-z0-9_]{1,25}$/.test(l) || mutedUsers.has(l) || mutedUsers.size >= MAX_MUTED) return false;
    return muteUser(l, displayName || l);
  }

  function openActionsMenu() {
    if (!panelElem) return;
    const wrap = panelElem.querySelector('.tm-actions-wrap');
    if (!wrap) return;
    wrap.classList.add('tm-open');
    actionsMenuOpen = true;
    updateViewerHeaderBadge();
  }

  function closeActionsMenu() {
    if (!panelElem) { actionsMenuOpen = false; return; }
    const wrap = panelElem.querySelector('.tm-actions-wrap');
    if (wrap) wrap.classList.remove('tm-open');
    actionsMenuOpen = false;
    updateViewerHeaderBadge();
  }

  function toggleActionsMenu() {
    if (actionsMenuOpen) closeActionsMenu();
    else                 openActionsMenu();
  }

  function getSortedSnapshot() {
    const base = Array.isArray(panelSnapshot) ? panelSnapshot : [...mutedUsers].reverse();
    if (sortOrder === 'newest') return base;

    const nn = base.filter(Boolean);
    if (sortOrder === 'oldest') return [...nn].reverse();
    if (sortOrder === 'name')   return [...nn].sort((a, b) => getDisplay(a).localeCompare(getDisplay(b), 'ja'));
    return base;
  }

  function nfkcLower(s) {
    const str = String(s);
    return str.normalize ? str.normalize('NFKC').toLowerCase() : str.toLowerCase();
  }

  function getSnapshotArray() {
    const base = getSortedSnapshot();
    if (!filterText) return base;

    const ft = String(filterText).toLowerCase().trim();
    if (!ft) return base;

    const ck = `${ft}|${sortOrder}|${base.length}`;
    if (_filterCache.key === ck) return _filterCache.result;

    const fn = nfkcLower(ft);
    const result = base.filter(l => {
      if (!l) return false;
      try {
        if (nfkcLower(l).includes(fn)) return true;
        if (nfkcLower(getDisplay(l)).includes(fn)) return true;
        const cm = getMuteComment(l);
        if (cm && nfkcLower(cm).includes(fn)) return true;
      } catch (_) {}
      return false;
    });

    _filterCache = { key: ck, result };
    return result;
  }

  function updateSearchBadge() {
    if (!panelElem) return;
    const badge = panelElem.querySelector('.tm-search-badge');
    if (!badge) return;

    // 検索クリア（×）ボタンは、入力中の文字があるときだけ出す
    const clearBtn = panelElem.querySelector('.tm-search-clear');
    if (clearBtn) {
      const curText = panelView === 'ng' ? ngFilterText : filterText;
      clearBtn.style.display = curText && curText.length ? 'inline-flex' : 'none';
    }

    if (panelView === 'ng') {
      const total = ngWords.length;
      const shown = getFilteredNgWords().length;
      if (ngFilterText.trim() && shown !== total) {
        badge.textContent = `${shown} / ${total}`;
        badge.style.display = '';
      } else {
        badge.style.display = 'none';
      }
      return;
    }

    const arr   = getSnapshotArray();
    const total = mutedUsers.size;

    if (filterText.trim() && arr.length !== total) {
      badge.textContent = `${arr.length} / ${total}`;
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  }

  function buildUserRow(user) {
    const row = document.createElement('div');
    row.className = 'tm-row';
    // アクセシビリティ: リストアイテムとしてマークし、スクリーンリーダーにユーザーを伝える
    row.setAttribute('role', 'listitem');

    const displayName = getDisplay(user);
    const mutedAt     = getMutedAt(user);

    const nameContainer = document.createElement('div');
    nameContainer.className = 'tm-name-container';

    const displaySpan = document.createElement('span');
    displaySpan.className = 'tm-display-span';
    displaySpan.textContent = displayName;
    nameContainer.appendChild(displaySpan);

    const muteComment = getMuteComment(user);
    function buildTitleText() {
      if (!mutedAt) return muteComment ? `「${muteComment}」` : '';
      const base = `ミュート日時：${formatMutedAt(mutedAt)}（${formatRelative(mutedAt)}）`;
      return muteComment ? `${base}\n${muteComment}` : base;
    }
    const titleText = buildTitleText();

    if (displayName !== user) {
      const loginSpan = document.createElement('span');
      loginSpan.className = 'tm-login-span';
      loginSpan.textContent = `(${user})`;
      if (titleText) {
        loginSpan.title   = titleText;
        displaySpan.title = titleText;
      }
      nameContainer.appendChild(loginSpan);
    } else if (titleText) {
      displaySpan.title = titleText;
    }

    nameContainer.addEventListener('click', (e) => {
      e.stopPropagation();
      // Shift / Ctrl を押しながらクリック → どこリスでこのユーザーを検索
      if (e.shiftKey || e.ctrlKey || e.metaKey) { openDokorisuSearch(user); return; }
      const flashOk  = () => { nameContainer.classList.add('tm-copied'); setTimeout(() => nameContainer.classList.remove('tm-copied'), 150); };
      const flashErr = () => { nameContainer.style.outline = '1px solid rgba(255,80,80,0.9)'; setTimeout(() => { nameContainer.style.outline = ''; }, 300); };
      copyTextToClipboard(user).then(flashOk, flashErr);
    });

    row.appendChild(nameContainer);

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';

    const toggleLabel = document.createElement('span');
    toggleLabel.className = 'tm-action-label tm-cancel';
    toggleLabel.textContent = pendingUnmutes.has(user) ? '取消' : '解除';

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';

    const confirmLabel = document.createElement('span');
    confirmLabel.className = 'tm-action-label tm-confirm';
    confirmLabel.textContent = '確定';
    confirmBtn.style.display = pendingUnmutes.has(user) ? '' : 'none';

    toggleLabel.addEventListener('click', (e) => {
      e.stopPropagation();
      if (pendingUnmutes.has(user)) {
        pendingUnmutes.delete(user);
        toggleLabel.classList.remove('tm-pending-btn', 'tm-cancel-active');
        toggleLabel.textContent = '解除';
        confirmBtn.style.display = 'none';
      } else {
        pendingUnmutes.add(user);
        toggleLabel.classList.add('tm-pending-btn', 'tm-cancel-active');
        toggleLabel.textContent = '取消';
        confirmBtn.style.display = '';
      }
      updateSortButtonLabel();
      safe(() => e.currentTarget && e.currentTarget.blur && e.currentTarget.blur());
    });

    confirmLabel.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirmUnmuteUser(user)) {
        safe(() => renderPage());
        return;
      }
      safe(() => {
        updateSortButtonLabel();
        const nl = panelElem && panelElem.querySelector('.tm-page-list');
        const prevScroll = nl ? nl.scrollTop : 0;
        renderPage();
        requestAnimationFrame(() => {
          safe(() => {
            const nl2 = panelElem && panelElem.querySelector('.tm-page-list');
            if (nl2) nl2.scrollTop = Math.min(prevScroll, Math.max(0, nl2.scrollHeight - nl2.clientHeight));
          });
        });
      });
    });

    toggleBtn.appendChild(toggleLabel);
    confirmBtn.appendChild(confirmLabel);
    if (pendingUnmutes.has(user)) {
      toggleLabel.classList.add('tm-pending-btn', 'tm-cancel-active');
      toggleLabel.textContent = '取消';
      confirmBtn.style.display = '';
    }

    const bw = document.createElement('div');
    Object.assign(bw.style, {
      display: 'flex', alignItems: 'center', gap: '8px',
      flexShrink: '0', marginLeft: '4px'
    });
    bw.appendChild(toggleBtn);
    bw.appendChild(confirmBtn);
    row.appendChild(bw);

    return row;
  }

  function updateNavCenter(centerBox, total) {
    if (!centerBox) return;
    centerBox.innerHTML = '';

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const cur        = currentPage + 1;

    const isFirst = currentPage === 0;
    const isLast  = (currentPage + 1) >= totalPages;

    const curEl = document.createElement('span');
    curEl.className = 'tm-nav-num';
    curEl.textContent = String(cur);
    if (isFirst) {
      curEl.style.pointerEvents = 'none';
      curEl.style.cursor        = 'default';
    } else {
      curEl.title = '前のページ';
      curEl.addEventListener('click', (e) => {
        e.stopPropagation();
        if (currentPage > 0) {
          currentPage--;
          renderPage(true);
          scrollListTop();
        }
      });
    }

    const sep = document.createElement('span');
    sep.className = 'tm-nav-sep';
    sep.textContent = '/';

    const totEl = document.createElement('span');
    totEl.className = 'tm-nav-num';
    totEl.textContent = String(totalPages);
    if (isLast) {
      totEl.style.pointerEvents = 'none';
      totEl.style.cursor        = 'default';
    } else {
      totEl.title = '次のページ';
      totEl.addEventListener('click', (e) => {
        e.stopPropagation();
        if ((currentPage + 1) * PAGE_SIZE < total) {
          currentPage++;
          renderPage(true);
          scrollListTop();
        }
      });
    }

    centerBox.appendChild(curEl);
    centerBox.appendChild(sep);
    centerBox.appendChild(totEl);
  }

  function scrollListTop() {
    setTimeout(() => {
      safe(() => {
        const nl = panelElem && panelElem.querySelector('.tm-page-list');
        if (nl) nl.scrollTop = 0;
      });
    }, 0);
  }

  // パネルシェルのキャッシュ
  //   従来は renderPage() ごとに panelElem.innerHTML='' してヘッダー/検索行/フッター/
  //   リサイズハンドルを全て作り直していた。パネルを開いている間は、ソート変更や
  //   リスト変更でもシェル自体は変えないので、リストとバッジ/ページナビだけを更新する。
  //   これにより、【見た目・振る舞いは完全に同一で、重い全体再描画が消える】。
  const _panelShellRefs = { root: null, header: null, listWrapper: null, badge: null,
    centerBox: null, sortBtn: null, searchInput: null, title: null, toggle: null };

  function _clearShellRefs() {
    for (const k of Object.keys(_panelShellRefs)) _panelShellRefs[k] = null;
  }

  function renderPage(scrollToTopAfter = false) {
    if (!panelElem) return;

    const arr     = getSnapshotArray();
    const maxPage = arr.length === 0 ? 0 : Math.floor((arr.length - 1) / PAGE_SIZE);
    if (currentPage > maxPage) currentPage = maxPage;
    if (currentPage < 0)       currentPage = 0;

    // シェルがすでにあるならリストとナビ/バッジだけ更新して即座にリターン
    if (_panelShellRefs.root === panelElem && _panelShellRefs.listWrapper && _panelShellRefs.listWrapper.isConnected) {
      panelElem.classList.toggle('tm-settings-view', panelView !== 'list');
      panelElem.classList.toggle('tm-ng-view', panelView === 'ng');
      panelElem.classList.toggle('tm-slim-view', panelView !== 'list');
      _renderPanelBody(arr, scrollToTopAfter);
      syncCarouselToView(false);
      _updatePanelTitleAndToggle();
      updateSearchBadge();
      updateNavCenter(_panelShellRefs.centerBox, arr.length);
      updateSortButtonLabel();
      updateViewerHeaderBadge();
      updateDanmakuButtonLook();
      return;
    }

    const existingList = panelElem.querySelector('.tm-page-list');
    const prevScroll   = existingList ? existingList.scrollTop : 0;

    panelElem.innerHTML = '';
    _clearShellRefs();
    _panelShellRefs.root = panelElem;
    panelElem.classList.toggle('tm-settings-view', panelView !== 'list');
    panelElem.classList.toggle('tm-ng-view', panelView === 'ng');
    panelElem.classList.toggle('tm-slim-view', panelView !== 'list');
    _panelShellRefs.prevScrollForFirst = prevScroll;

    const hdr = document.createElement('div');
    hdr.className = 'tm-header';

    const titleGroup = document.createElement('div');
    titleGroup.className = 'tm-title-group';

    const viewBack = document.createElement('button');
    viewBack.type = 'button';
    viewBack.className = 'tm-view-back';
    viewBack.textContent = '‹';
    viewBack.title = 'ミュートリストに戻る';
    viewBack.setAttribute('aria-label', 'ミュートリストに戻る');
    viewBack.addEventListener('click', (ev) => { ev.stopPropagation(); backToListView(); });
    titleGroup.appendChild(viewBack);

    const title = document.createElement('div');
    title.className = 'tm-page-title';
    title.textContent = `MUTE LIST 【 ${mutedUsers.size} 】`;
    titleGroup.appendChild(title);
    _panelShellRefs.title = title;

    hdr.appendChild(titleGroup);

    const toggle = document.createElement('div');
    toggle.className = 'tm-enable-toggle' + (muteEnabled ? ' tm-on' : '');
    // アクセシビリティ: トグルをスイッチパーツとして専門支援技術に伝える
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('tabindex', '0');
    toggle.setAttribute('aria-checked', muteEnabled ? 'true' : 'false');
    toggle.setAttribute('aria-label', 'ミュート機能の有効/無効');
    toggle.title = muteEnabled ? 'クリックしてミュートOFF' : 'クリックしてミュートON';
    const toggleMute = (ev) => {
      if (ev) ev.stopPropagation();
      muteEnabled = !muteEnabled;
      saveEnabled();
      updateSettingsIconLook();
      toggle.classList.toggle('tm-on', muteEnabled);
      toggle.setAttribute('aria-checked', muteEnabled ? 'true' : 'false');
      toggle.title = muteEnabled ? 'クリックしてミュートOFF' : 'クリックしてミュートON';
      if (muteEnabled) syncAllExistingChatRows();
      else             clearAllVodHiddenRows();
    };
    toggle.addEventListener('click', toggleMute);
    toggle.addEventListener('keydown', (ev) => {
      if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); toggleMute(ev); }
    });
    _panelShellRefs.toggle = toggle;
    hdr.appendChild(toggle);

    panelElem.appendChild(hdr);
    setupPanelDrag(panelElem, hdr);

    const searchRow = document.createElement('div');
    searchRow.className = 'tm-search-row' + (actionsMenuOpen ? ' tm-actions-open' : '');

    const searchMain = document.createElement('div');
    searchMain.className = 'tm-search-main';

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = panelView === 'ng' ? 'NGワードを入力して' : '検索 / 追加';
    searchInput.className = 'tm-search-input';
    searchInput.value = panelView === 'ng' ? ngFilterText : filterText;
    searchInput.title = panelView === 'ng' ? 'NGワードを入力して' : 'ユーザー名・ミュート時のコメントで検索';

    const searchBadge = document.createElement('span');
    searchBadge.className = 'tm-search-badge';

    const searchClear = document.createElement('button');
    searchClear.type = 'button';
    searchClear.className = 'tm-search-clear';
    searchClear.textContent = '×';
    searchClear.title = '検索を消す';
    searchClear.setAttribute('aria-label', '検索を消す');
    searchClear.addEventListener('click', (ev) => {
      ev.stopPropagation();
      searchInput.value = '';
      if (panelView === 'ng') {
        ngFilterText = '';
      } else {
        filterText = '';
        currentPage = 0;
      }
      updateSearchBadge();
      safe(() => renderPage(true));
      safe(() => searchInput.focus());
    });

    searchMain.appendChild(searchInput);
    searchMain.appendChild(searchBadge);
    searchMain.appendChild(searchClear);
    searchRow.appendChild(searchMain);

    // 検索行の右端（旧⚙の位置）に並ぶカルーセル群（1枠分の窓を縦スクロール＋スナップで切り替える）
    const buildCarousel = (items, onScroll) => {
      const box = document.createElement('div');
      box.className = 'tm-settings-carousel';
      const slot = document.createElement('div');
      slot.className = 'tm-carousel-slot';
      items.forEach((it) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'tm-carousel-btn';
        if (it.id) b.id = it.id;
        if (it.view) b.dataset.view = it.view;
        b.innerHTML = it.svg;
        b.title = it.tip;
        b.setAttribute('aria-label', it.tip);
        b.addEventListener('click', (ev) => { ev.stopPropagation(); it.onClick(); });
        slot.appendChild(b);
      });
      const dots = document.createElement('div');
      dots.className = 'tm-carousel-dots';
      items.forEach((it, idx) => {
        const d = document.createElement('span');
        d.className = 'tm-carousel-dot';
        d.title = it.tip;
        d.setAttribute('role', 'button');
        d.setAttribute('aria-label', it.tip);
        d.addEventListener('click', (ev) => { ev.stopPropagation(); slot.scrollTop = idx * 26; });
        dots.appendChild(d);
      });
      box.appendChild(slot);
      box.appendChild(dots);
      const syncDots = () => {
        const idx = Math.max(0, Math.min(items.length - 1, Math.round(slot.scrollTop / 26)));
        [...dots.children].forEach((d, i) => d.classList.toggle('tm-on', i === idx));
        slot.classList.toggle('tm-at-end', slot.scrollTop >= slot.scrollHeight - slot.clientHeight - 2);
      };
      slot.addEventListener('scroll', () => { syncDots(); if (onScroll) onScroll(slot); }, { passive: true });
      // ホイールは1ノッチで1枠だけ進める（deltaYをそのまま流すと真ん中を飛び越えるため）
      let lockUntil = 0;
      slot.addEventListener('wheel', (e) => {
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
        e.preventDefault();
        const now = Date.now();
        if (now < lockUntil) return;
        lockUntil = now + 220;
        const idx = Math.round(slot.scrollTop / 26);
        const next = Math.max(0, Math.min(items.length - 1, idx + (e.deltaY > 0 ? 1 : -1)));
        slot.scrollTop = next * 26;
      }, { passive: false });
      syncDots();
      return { box, slot, dots };
    };

    const carouselsRow = document.createElement('div');
    carouselsRow.className = 'tm-search-carousels';

    const SVG_BAN_C = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z"/><line x1="9.6" y1="9.2" x2="14.4" y2="14"/><line x1="14.4" y1="9.2" x2="9.6" y2="14"/></svg>`;
    const SVG_SLIDERS_C = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><circle cx="9" cy="6" r="2.2" fill="currentColor" stroke="none"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="2.2" fill="currentColor" stroke="none"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="7" cy="18" r="2.2" fill="currentColor" stroke="none"/></svg>`;
    const SVG_TV_C = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 7.4 5.2 2.7M12 7.4l6.8-4.7" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><circle cx="4.6" cy="2.3" r="1.2" fill="currentColor"/><circle cx="19.4" cy="2.3" r="1.2" fill="currentColor"/><rect x="2.6" y="7.2" width="18.8" height="12" rx="2.2" fill="currentColor"/><path d="M7.2 21.4h2.9l-.8-2.2H8l-.8 2.2ZM13.9 21.4h2.9l-.8-2.2h-1.3l-.8 2.2Z" fill="currentColor"/></svg>`;
    const settingsCarousel = buildCarousel([
      { view: 'settings', tip: 'コメント設定', svg: SVG_SLIDERS_C, onClick: () => switchPanelView('settings') },
      { view: 'ng',       tip: 'NGワード',     svg: SVG_BAN_C,     onClick: () => switchPanelView('ng') },
      { view: 'danmaku',  tip: '弾幕設定',     svg: SVG_TV_C,      onClick: () => switchPanelView('danmaku') },
    ], (slot) => {
      if (slot.scrollTop > 2) { try { localStorage.setItem(CAROUSEL_HINT_KEY, '1'); } catch (_) {} }
    });
    settingsCarousel.slot.id = 'tm-carousel-slot';
    carouselsRow.appendChild(settingsCarousel.box);
    _panelShellRefs.carouselSlot = settingsCarousel.slot;
    _panelShellRefs.carouselDots = settingsCarousel.dots;

    const SVG_EXPORT_C = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>`;
    const SVG_IMPORT_C = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>`;
    const SVG_VIEWERS_C = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>`;
    const actionsCarousel = buildCarousel([
      { tip: '視聴中のミュートユーザーを表示', svg: SVG_VIEWERS_C, id: 'tm-viewer-toggle-btn', onClick: () => {
          for (const [, d] of activeViewers) d.hasNew = false;
          updateViewerHeaderBadge();
          openViewerPanel();
        } },
      { tip: 'ミュートリストを保存', svg: SVG_EXPORT_C, onClick: () => exportMuteState() },
      { tip: 'ミュートリストを復元', svg: SVG_IMPORT_C, onClick: () => openImportDialog() },
    ]);
    actionsCarousel.slot.id = 'tm-actions-carousel-slot';
    carouselsRow.appendChild(actionsCarousel.box);
    _panelShellRefs.actionsSlot = actionsCarousel.slot;
    _panelShellRefs.actionsDots = actionsCarousel.dots;

    searchRow.appendChild(carouselsRow);
    syncCarouselToView(true);
    maybePlayCarouselHint();


    panelElem.appendChild(searchRow);

    if (!searchInput._tmHooked) {
      searchInput._tmHooked = true;

      searchInput.addEventListener('compositionstart', () => {
        isComposing = true;
        if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
      });

      searchInput.addEventListener('compositionend', (ev) => {
        isComposing = false;
        if (panelView === 'ng') {
          ngFilterText = ev.target.value;
          updateSearchBadge();
          safe(() => renderPage(true));
          return;
        }
        filterText  = ev.target.value;
        currentPage = 0;
        updateSearchBadge();
        safe(() => renderPage(true));
      });

      searchInput.addEventListener('input', (ev) => {
        if (panelView === 'ng') {
          ngFilterText = ev.target.value;
          updateSearchBadge();
          if (!isComposing) scheduleRenderDebounced();
          return;
        }
        filterText  = ev.target.value;
        currentPage = 0;
        updateSearchBadge();
        if (!isComposing) scheduleRenderDebounced();
      });

      searchInput.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter') return;
        ev.stopPropagation();
        if (isComposing) return;
        ev.preventDefault();

        let raw = searchInput.value.trim();
        if (!raw) return;

        // NGワード画面では検索欄をNGワード追加に転用する
        if (panelView === 'ng') {
          if (!isValidNgWordInput(raw)) {
            searchInput.style.outline = '1px solid rgba(255,80,80,0.9)';
            setTimeout(() => { searchInput.style.outline = ''; }, 400);
            return;
          }
          addNgWord(raw);
          searchInput.value = '';
          ngFilterText = '';
          updateSearchBadge();
          safe(() => renderPage(true));
          safe(() => searchInput.focus());
          safe(() => syncAllExistingChatRows());
          return;
        }

        let norm = raw.toLowerCase();
        if (norm.startsWith('@')) norm = norm.slice(1);

        if (mutedUsers.has(norm)) {
          searchInput.value = '';
          filterText = '';
          scheduleRenderDebounced();
          return;
        }

        const ok = addMutedByLogin(norm, norm);
        if (!ok) {
          searchInput.style.outline = '1px solid rgba(255,80,80,0.9)';
          setTimeout(() => { searchInput.style.outline = ''; }, 400);
          return;
        }

        searchInput.value = '';
        filterText = '';
        currentPage = 0;
        safe(() => renderPage(true));
        safe(() => searchInput.focus());
      });
    }

    _panelShellRefs.searchInput = searchInput;

    updateSearchBadge();

    const listWrapper = document.createElement('div');
    listWrapper.className = 'tm-page-list';
    // アクセシビリティ: リストを進行行のリストとしてやさしく伝える
    listWrapper.setAttribute('role', 'list');
    _panelShellRefs.listWrapper = listWrapper;

    _renderPanelBody(arr, scrollToTopAfter);
    panelElem.appendChild(listWrapper);

    const footer = document.createElement('div');
    footer.className = 'tm-footer';

    const centerBox = document.createElement('div');
    centerBox.className = 'tm-nav-center';
    _panelShellRefs.centerBox = centerBox;
    updateNavCenter(centerBox, arr.length);
    footer.appendChild(centerBox);

    const rightBox = document.createElement('div');
    rightBox.className = 'tm-footer-right';

    const sortBtn = document.createElement('button');
    sortBtn.type = 'button';
    sortBtn.className = 'tm-sort-btn';
    sortBtn.textContent = getSortButtonLabel();
    _panelShellRefs.sortBtn = sortBtn;

    updateSortButtonStyle();

    sortBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (pendingUnmutes.size >= 3) {
        confirmAllPendingUnmutes();
        return;
      }
      const os = ['newest', 'oldest', 'name'];
      sortOrder = os[(os.indexOf(sortOrder) + 1) % os.length];
      saveSort();
      panelSnapshot = [...mutedUsers].reverse();
      invalidateFilterCache();
      currentPage = 0;
      renderPage(true);
    });

    rightBox.appendChild(sortBtn);
    footer.appendChild(rightBox);
    updateSortButtonLabel();

    const onFooterWheel = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.deltaY > 0 && (currentPage + 1) * PAGE_SIZE < arr.length) {
        currentPage++;
        renderPage(true);
        scrollListTop();
      } else if (e.deltaY < 0 && currentPage > 0) {
        currentPage--;
        renderPage(true);
        scrollListTop();
      }
    };
    centerBox.addEventListener('wheel', onFooterWheel, { passive: false });

    panelElem.appendChild(footer);

    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'tm-resize-handle';
    panelElem.appendChild(resizeHandle);
    setupVerticalResize(panelElem, resizeHandle);

    if (!scrollToTopAfter && existingList) {
      requestAnimationFrame(() => {
        safeExec(() => {
          listWrapper.scrollTop = Math.min(prevScroll, Math.max(0, listWrapper.scrollHeight - listWrapper.clientHeight));
        }, undefined, 'restore scroll');
      });
    }

    if (document.activeElement !== searchInput) {
      safeExec(() => { if (filterText) searchInput.focus(); }, undefined, 'focus search');
    }

    updateViewerHeaderBadge();
  }

  // リストだけを引き当て直す内部ヘルパー。DocumentFragment でリフローを一括し、
  //   既存リストのスクロール位置も可能な限り保存する。
  function _renderListSection(arr, scrollToTopAfter) {
    const lw = _panelShellRefs.listWrapper;
    if (!lw) return;

    const prevScroll = lw.scrollTop;

    const items = arr.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

    const frag = document.createDocumentFragment();
    if (!items.length) {
      const empty = document.createElement('div');
      Object.assign(empty.style, {
        padding: '10px 4px', color: 'var(--tm-muted-text)', fontSize: '12px'
      });
      empty.textContent = filterText ? '一致するユーザーなし' : 'No users';
      frag.appendChild(empty);
    } else {
      for (const user of items) {
        if (user == null) continue;
        frag.appendChild(buildUserRow(user));
      }
    }

    // 一括クリアして fragment を一回だけ挿入することで reflow を最小化
    lw.textContent = '';
    lw.appendChild(frag);

    if (scrollToTopAfter) {
      lw.scrollTop = 0;
    } else {
      // リスト長が変わってもスクロール位置を保つ
      lw.scrollTop = Math.min(prevScroll, Math.max(0, lw.scrollHeight - lw.clientHeight));
    }
  }

  // 設定画面で表示するNGワード（検索欄の文字列で絞り込み）
  function getFilteredNgWords() {
    const q = ngFilterText.trim().toLowerCase();
    if (!q) return ngWords;
    return ngWords.filter(w => w.toLowerCase().includes(q));
  }

  // 画面切替（リスト / コメント設定 / NGワード）。同じ画面をもう一度選ぶとリストに戻る。
  //   検索欄は画面ごとに役割と内容を入れ替える（NG画面ではNGワード追加欄になる）。
  function syncSearchInputForView() {
    const input = _panelShellRefs.searchInput;
    if (!input) return;
    if (panelView === 'ng') {
      input.value = ngFilterText;
      input.placeholder = 'NGワードを入力して';
      input.title = 'NGワードを入力して';
    } else {
      input.value = filterText;
      input.placeholder = '検索 / 追加';
      input.title = 'ユーザー名・ミュート時のコメントで検索';
    }
  }

  /* ---------- パネル内の画面履歴（マウスのサイドボタン用） ---------- */
  const _viewBackStack = [];
  const _viewForwardStack = [];
  let _viewNavigating = false;
  function noteViewChange(prev) {
    if (_viewNavigating || panelView === prev) return;
    _viewBackStack.push(prev);
    if (_viewBackStack.length > 30) _viewBackStack.shift();
    _viewForwardStack.length = 0;
  }
  function panelViewGoBack() {
    if (!_viewBackStack.length) return;
    const target = _viewBackStack.pop();
    _viewForwardStack.push(panelView);
    _viewNavigating = true;
    goToView(target);
    _viewNavigating = false;
  }
  function panelViewGoForward() {
    if (!_viewForwardStack.length) return;
    const target = _viewForwardStack.pop();
    _viewBackStack.push(panelView);
    _viewNavigating = true;
    goToView(target);
    _viewNavigating = false;
  }
  // パネルの上にマウスがある時だけ、サイドボタン（戻る/進む）をパネル内の画面遷移に使う
  function initPanelSideButtons() {
    const onBtn = (e) => {
      if (e.button !== 3 && e.button !== 4) return;
      const panel = document.getElementById('tm-unmute-panel');
      if (!panel || !e.target || !panel.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.type !== 'mouseup') return;
      if (e.button === 3) panelViewGoBack();
      else panelViewGoForward();
    };
    document.addEventListener('mousedown', onBtn, true);
    document.addEventListener('mouseup', onBtn, true);
  }

  function switchPanelView(view) {
    const prev = panelView;
    panelView = panelView === view ? 'list' : view;
    noteViewChange(prev);
    safe(() => closeFilterSamples());
    syncSearchInputForView();
    updateSearchBadge();
    safe(() => renderPage(true));
  }

  // 指定した画面へ直接移動する（トグル動作なし）
  function goToView(view) {
    const prev = panelView;
    panelView = view;
    noteViewChange(prev);
    safe(() => closeFilterSamples());
    syncSearchInputForView();
    updateSearchBadge();
    safe(() => renderPage(true));
  }

  // 「戻る」の遷移先は常にミュートリスト
  function backToListView() {
    if (panelView !== 'list') goToView('list');
  }

  const CAROUSEL_VIEWS = ['settings', 'ng', 'danmaku'];

  // カルーセルのドット表示を現在のスクロール位置に合わせる
  function updateCarouselDots() {
    const slot = _panelShellRefs.carouselSlot;
    const dots = _panelShellRefs.carouselDots;
    if (!slot || !dots) return;
    const idx = Math.max(0, Math.min(CAROUSEL_VIEWS.length - 1, Math.round(slot.scrollTop / 26)));
    [...dots.children].forEach((d, i) => d.classList.toggle('tm-on', i === idx));
    slot.classList.toggle('tm-at-end', slot.scrollTop >= slot.scrollHeight - slot.clientHeight - 2);
  }

  // 現在の画面に合わせてカルーセルの選択状態を同期する。
  // moveScroll=true のときは表示中アイコンまでスクロールも合わせる（リスト画面では位置を触らない）
  function syncCarouselToView(moveScroll) {
    const slot = _panelShellRefs.carouselSlot;
    if (!slot) return;
    [...slot.children].forEach(b => b.classList.toggle('tm-active', b.dataset.view === panelView));
    if (moveScroll && panelView !== 'list') {
      const idx = CAROUSEL_VIEWS.indexOf(panelView);
      if (idx >= 0) slot.scrollTop = idx * 26;
    }
    updateCarouselDots();
  }

  let _carouselHintPlayed = false;
  // パネルを開いた直後に1回だけ、カルーセルが横に動くことを示すヒントアニメーション。
  // ユーザーが自分でスクロールしたら localStorage に記録して二度と出さない。
  function maybePlayCarouselHint() {
    if (_carouselHintPlayed) return;
    _carouselHintPlayed = true;
    const slot = _panelShellRefs.carouselSlot;
    if (!slot) return;
    let done = false;
    try { done = localStorage.getItem(CAROUSEL_HINT_KEY) === '1'; } catch (_) {}
    if (done) return;
    setTimeout(() => {
      if (!slot.isConnected || slot.scrollTop > 2) return;
      slot.style.scrollSnapType = 'none'; // スナップに吸われないよう一時的に外して揺らす
      slot.scrollTop = 8;
      setTimeout(() => {
        if (slot.isConnected) slot.scrollTop = 0;
        setTimeout(() => { slot.style.scrollSnapType = ''; }, 350);
      }, 480);
    }, 600);
  }

  // パネル本体の描画ディスパッチャ（リスト画面 / 各設定画面）
  function _renderPanelBody(arr, scrollToTopAfter) {
    if (panelView === 'settings') _renderSettingsSection();
    else if (panelView === 'ng') _renderNgSection();
    else if (panelView === 'danmaku') _renderDanmakuSection();
    else _renderListSection(arr, scrollToTopAfter);
  }

  // ショートカット設定の行：右端のチップを押してから、割り当てたいキーを押す
  function buildShortcutRow(action, label, binding) {
    const row = document.createElement('div');
    row.className = 'tm-setting-row tm-shortcut-row';
    const lab = document.createElement('span');
    lab.className = 'tm-setting-label';
    lab.textContent = label;
    row.appendChild(lab);
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'tm-key-chip';
    chip.textContent = _shortcutCapture === action ? 'キーを押す' : formatShortcut(binding);
    chip.addEventListener('click', (ev) => {
      ev.stopPropagation();
      _shortcutCapture = action;
      chip.textContent = 'キーを押す';
      chip.style.background = 'rgba(169,112,255,0.5)';
    });
    row.appendChild(chip);
    return row;
  }

  // チェック式の行：行全体がボタンで、ONのときだけ右端に✓が出る（トグルは使わない）
  function buildSettingCheckRow(label, getFn, setFn, onChange) {
    const row = document.createElement('div');
    row.className = 'tm-setting-row tm-check-row' + (getFn() ? ' tm-on' : '');
    row.setAttribute('role', 'checkbox');
    row.setAttribute('tabindex', '0');
    row.setAttribute('aria-checked', getFn() ? 'true' : 'false');
    row.setAttribute('aria-label', label);

    const lab = document.createElement('span');
    lab.className = 'tm-setting-label';
    lab.textContent = label;
    row.appendChild(lab);

    const mark = document.createElement('span');
    mark.className = 'tm-check-mark';
    mark.textContent = '✓';
    row.appendChild(mark);

    const flip = (ev) => {
      if (ev) ev.stopPropagation();
      const next = !getFn();
      setFn(next);
      row.classList.toggle('tm-on', next);
      row.setAttribute('aria-checked', next ? 'true' : 'false');
      if (onChange) onChange(next);
    };
    row.addEventListener('click', flip);
    row.addEventListener('keydown', (ev) => {
      if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); flip(ev); }
    });
    return row;
  }

  // スライダー行（チップ付き）。文字数制限と同じ部品で、弾幕設定でも使う
  function buildSliderBlock(label, opts) {
    const block = document.createElement('div');
    block.className = 'tm-setting-block' + (opts.compact ? ' tm-setting-block-compact' : '');
    const head = document.createElement('div');
    head.className = 'tm-setting-block-head';
    const lab = document.createElement('span');
    lab.className = 'tm-setting-label';
    lab.textContent = label;
    const chip = document.createElement('span');
    chip.className = 'tm-char-chip';
    head.appendChild(lab);
    head.appendChild(chip);
    block.appendChild(head);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(opts.min);
    slider.max = String(opts.max);
    slider.step = String(opts.step);
    slider.className = 'tm-char-slider';
    slider.value = String(opts.value);
    slider.setAttribute('aria-label', label);
    const paint = () => {
      const v = parseInt(slider.value, 10) || 0;
      chip.textContent = opts.format(v);
      const p = ((v - opts.min) / (opts.max - opts.min)) * 100;
      slider.style.background = `linear-gradient(90deg, rgba(169,112,255,0.85) ${p}%, rgba(255,255,255,0.18) ${p}%)`;
    };
    paint();
    slider.addEventListener('input', paint);
    slider.addEventListener('change', () => { opts.onCommit(parseInt(slider.value, 10) || 0); });
    block.appendChild(slider);
    return block;
  }

  function _renderSettingsSection() {
    const lw = _panelShellRefs.listWrapper;
    if (!lw) return;
    const frag = document.createDocumentFragment();

    frag.appendChild(buildSettingCheckRow('コミュニティハイライト非表示',
      isCommunityHighlightHideEnabled, setCommunityHighlightHideEnabled,
      (enabled) => { enabled ? enableCommunityHighlightHiding() : disableCommunityHighlightHiding(); }));
    frag.appendChild(buildSettingCheckRow('コメントを長押しでコピー',
      isLongPressCopyEnabled, setLongPressCopyEnabled, null));

    frag.appendChild(buildSettingCheckRow('「？」だけのコメントを非表示',
      isQuestionMarkHideEnabled, setQuestionMarkHideEnabled,
      () => safe(() => syncAllExistingChatRows())));
    frag.appendChild(buildSettingCheckRow('繰り返しコメントを非表示',
      isRepeatHideEnabled, setRepeatHideEnabled,
      () => safe(() => syncAllExistingChatRows())));
    frag.appendChild(buildSettingCheckRow('アスキーアートを非表示',
      isAsciiArtHideEnabled, setAsciiArtHideEnabled,
      () => safe(() => syncAllExistingChatRows())));
    frag.appendChild(buildSettingCheckRow('サブスク限定モード',
      isSubOnlyModeEnabled, setSubOnlyModeEnabled,
      () => safe(() => syncAllExistingChatRows())));
    frag.appendChild(buildSettingCheckRow('返信ボタンを表示',
      isReplyButtonShown, setReplyButtonShown,
      () => safe(() => applyReplyButtonStyle())));

    // 文字数制限スライダー（0＝OFF、10字刻み、上限300字）
    const block = document.createElement('div');
    block.className = 'tm-setting-block';
    const head = document.createElement('div');
    head.className = 'tm-setting-block-head';
    const lab = document.createElement('span');
    lab.className = 'tm-setting-label';
    lab.textContent = '文字数制限';
    const chip = document.createElement('span');
    chip.className = 'tm-char-chip';
    head.appendChild(lab);
    head.appendChild(chip);
    block.appendChild(head);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '300';
    slider.step = '10';
    slider.className = 'tm-char-slider';
    slider.value = String(getCharLimit());
    const paintSlider = () => {
      const v = parseInt(slider.value, 10) || 0;
      chip.textContent = v === 0 ? 'OFF' : `${v}字`;
      const p = (v / 300) * 100;
      slider.style.background = `linear-gradient(90deg, rgba(169,112,255,0.85) ${p}%, rgba(255,255,255,0.18) ${p}%)`;
    };
    paintSlider();
    slider.addEventListener('input', paintSlider);
    slider.addEventListener('change', () => {
      setCharLimit(parseInt(slider.value, 10) || 0);
      safe(() => syncAllExistingChatRows());
    });
    block.appendChild(slider);
    frag.appendChild(block);

    // ショートカット設定（チップを押してから割り当てたいキーを押す）
    const scTitle = document.createElement('div');
    scTitle.className = 'tm-filter-stats-title';
    scTitle.style.padding = '10px 10px 2px';
    scTitle.textContent = 'ショートカット';
    frag.appendChild(scTitle);
    const sc = getShortcuts();
    [['panel', 'パネルを開く'], ['danmaku', '弾幕'], ['subonly', 'サブスク限定']].forEach(([action, label]) => {
      frag.appendChild(buildShortcutRow(action, label, sc[action]));
    });

    // フィルターのヒット数（今日 / 累計）
    const stats = loadFilterStats();
    const statsBox = document.createElement('div');
    statsBox.className = 'tm-filter-stats';
    const headRow = document.createElement('div');
    headRow.className = 'tm-filter-stats-row tm-filter-stats-head';
    const statsTitle = document.createElement('span');
    statsTitle.className = 'tm-filter-stats-title';
    statsTitle.textContent = '非表示フィルター';
    headRow.appendChild(statsTitle);
    const headToday = document.createElement('span');
    headToday.textContent = '今日';
    headRow.appendChild(headToday);
    const headTotal = document.createElement('span');
    headTotal.textContent = '累計';
    headRow.appendChild(headTotal);
    statsBox.appendChild(headRow);
    FILTER_STAT_KINDS.filter(kind => kind !== 'subonly').forEach(kind => {
      const r = document.createElement('div');
      r.className = 'tm-filter-stats-row';
      const l = document.createElement('span');
      l.textContent = FILTER_STAT_LABELS[kind];
      // 文字数制限 / 繰り返し / アスキーアート は、名前を押すと非表示にした実例が見られる
      if (kind === 'char' || kind === 'repeat' || kind === 'aa') {
        l.className = 'tm-filter-stat-link';
        l.title = '非表示にしたコメントを見る';
        l.addEventListener('click', (ev) => { ev.stopPropagation(); showFilterSamples(kind, l); });
      }
      const t = document.createElement('span');
      t.textContent = String(stats.today[kind] || 0);
      const a = document.createElement('span');
      a.textContent = String(stats.total[kind] || 0);
      r.appendChild(l); r.appendChild(t); r.appendChild(a);
      statsBox.appendChild(r);
    });
    frag.appendChild(statsBox);

    lw.textContent = '';
    lw.appendChild(frag);
    lw.scrollTop = 0;
  }

  // 弾幕設定画面（スライダー4本＋ユーザー色のチェック行）
  function _renderDanmakuSection() {
    const lw = _panelShellRefs.listWrapper;
    if (!lw) return;
    const frag = document.createDocumentFragment();

    frag.appendChild(buildSliderBlock('速度', {
      compact: true,
      min: 5, max: 20, step: 1, value: getDanmakuSpeed(),
      format: v => `×${(v / 10).toFixed(1)}`,
      onCommit: v => lsSet(DANMAKU_SPEED_KEY, String(v)),
    }));
    frag.appendChild(buildSliderBlock('透明度', {
      compact: true,
      min: 10, max: 100, step: 5, value: getDanmakuOpacity(),
      format: v => `${v}%`,
      onCommit: v => lsSet(DANMAKU_OPACITY_KEY, String(v)),
    }));
    frag.appendChild(buildSliderBlock('大きさ', {
      compact: true,
      min: 12, max: 36, step: 1, value: getDanmakuSize(),
      format: v => `${v}px`,
      onCommit: v => lsSet(DANMAKU_SIZE_KEY, String(v)),
    }));
    frag.appendChild(buildSliderBlock('同時に流れる数', {
      compact: true,
      min: 4, max: 60, step: 2, value: getDanmakuMax(),
      format: v => `${v}個`,
      onCommit: v => lsSet(DANMAKU_MAX_KEY, String(v)),
    }));
    frag.appendChild(buildSettingCheckRow('ユーザー色を使う',
      isDanmakuUserColorEnabled,
      (v) => setFeatureEnabled(DANMAKU_USER_COLOR_KEY, !!v),
      null));

    lw.textContent = '';
    lw.appendChild(frag);
    lw.scrollTop = 0;
  }

  // NGワード専用画面（追加は検索欄から、一覧はここで削除）
  function _renderNgSection() {
    const lw = _panelShellRefs.listWrapper;
    if (!lw) return;
    const frag = document.createDocumentFragment();

    const words = getFilteredNgWords();
    if (!words.length) {
      const empty = document.createElement('div');
      Object.assign(empty.style, { padding: '10px 4px', color: 'var(--tm-muted-text)', fontSize: '12px' });
      empty.textContent = ngFilterText.trim() ? '一致するNGワードなし' : 'NGワードはまだありません';
      frag.appendChild(empty);
    } else {
      for (const w of words) {
        const row = document.createElement('div');
        row.className = 'tm-ng-row';
        const span = document.createElement('span');
        span.className = 'tm-ng-word';
        span.textContent = w;
        span.title = w;
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'tm-ng-del';
        del.textContent = '×';
        del.title = '削除';
        del.addEventListener('click', (ev) => {
          ev.stopPropagation();
          removeNgWord(w);
          updateSearchBadge();
          safe(() => renderPage(true));
          safe(() => syncAllExistingChatRows());
        });
        row.appendChild(span);
        row.appendChild(del);
        frag.appendChild(row);
      }
    }

    lw.textContent = '';
    lw.appendChild(frag);
    lw.scrollTop = 0;
  }

  // タイトルとトグルのミユート件数を同期（リスト変更時のヘッダー更新用）
  function _updatePanelTitleAndToggle() {
    const t = _panelShellRefs.title;
    if (t) t.textContent =
      panelView === 'settings' ? 'コメント設定' :
      panelView === 'danmaku' ? '弾幕設定' :
      panelView === 'ng' ? `NGワード 【 ${ngWords.length} 】` :
      `MUTE LIST 【 ${mutedUsers.size} 】`;
    const tg = _panelShellRefs.toggle;
    if (tg) {
      tg.classList.toggle('tm-on', muteEnabled);
      tg.setAttribute('aria-checked', muteEnabled ? 'true' : 'false');
      tg.title = muteEnabled ? 'クリックしてミュートOFF' : 'クリックしてミュートON';
    }
  }

  /* ================================================================
     ミュートボタン（ホバー）
  ================================================================ */
  const containerObserverMap = new WeakMap();
  let globalMuteButton  = null;
  let currentHoverRow   = null;
  let currentHoverLogin = null;
  let currentHoverDisplay = null;

  function ensureGlobalMuteButton() {
    if (globalMuteButton) return globalMuteButton;
    const btn = document.createElement('div');
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 -960 960 960" fill="currentColor"><path d="M324-111.5Q251-143 197-197t-85.5-127Q80-397 80-480t31.5-156Q143-709 197-763t127-85.5Q397-880 480-880t156 31.5Q709-817 763-763t85.5 127Q880-563 880-480t-31.5 156Q817-251 763-197t-127 85.5Q563-80 480-80t-156-31.5ZM480-140q61.01 0 117.51-20.5Q654-181 699-220L220-699q-38 46-59 102.17T140-480q0 142.37 98.81 241.19Q337.63-140 480-140Zm259-121q37-45 59-101.49 22-56.5 22-117.51 0-142.38-98.81-241.19T480-820q-60.66 0-116.83 21T261-739l478 478ZM480-480Z"/></svg>`;
    Object.assign(btn.style, {
      position: 'absolute', right: '10px', bottom: '0px',
      fontSize: '20px', cursor: 'pointer', userSelect: 'none',
      padding: '1px', zIndex: '2', background: 'transparent'
    });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!currentHoverLogin) return;
      try {
        // キャッシュ版を利用してDOM再走査を回避
        const _muteMsg = safeExec(() => getRowMessage(currentHoverRow), '', 'muteBtn extractMsg');
        muteUser(String(currentHoverLogin).trim().toLowerCase(), currentHoverDisplay || currentHoverLogin, _muteMsg);
      } catch (err) {
        logWarn('mute btn error', err);
      } finally {
        safe(() => { if (globalMuteButton && globalMuteButton.parentElement) globalMuteButton.remove(); });
        currentHoverRow = null;
        currentHoverLogin = null;
        currentHoverDisplay = null;
      }
    });
    globalMuteButton = btn;
    return globalMuteButton;
  }

  function setupObserver(chatContainer) {
    if (!chatContainer || containerObserverMap.has(chatContainer)) return;
    initialScan(chatContainer);

    const mo = new MutationObserver(mutations => {
      const added = [];
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) added.push(node);
        }
      }
      for (const node of added) {
        safe(() => {
          const rows = collectChatRows(node);
          if (rows.length) batchProcess(rows);
        });
      }
    });
    mo.observe(chatContainer, { childList: true, subtree: true });

    let _chatPressTimer     = null;
    let _chatLongPressFired = false;
    let _chatPressRow       = null;
    let _chatPressStartXY   = null;

    const cancelChatPress = () => {
      if (_chatPressTimer) { clearTimeout(_chatPressTimer); _chatPressTimer = null; }
      _chatPressRow     = null;
      _chatPressStartXY = null;
    };

    const onChatMouseDown = (e) => {
      if (!isLongPressCopyEnabled()) return;
      if (e.button !== 0) return;
      const row = e.target && e.target.closest ? e.target.closest(CHAT_SEL) : null;
      if (!row) return;
      if (isVodChatRow(row)) return;
      const info = extractUserFromRow(row);
      if (!info || !info.login || mutedUsers.has(info.login)) return;

      _chatLongPressFired = false;
      _chatPressRow       = row;
      _chatPressStartXY   = { x: e.clientX, y: e.clientY };

      _chatPressTimer = setTimeout(() => {
        _chatPressTimer = null;
        _chatLongPressFired = true;
        const msgText = extractMessageText(row);
        if (!msgText) { cancelChatPress(); return; }
        copyTextToClipboard(msgText).then(
          () => {
            showToast('📋 コメントをコピーしました');
            safe(() => {
              const prevBg = row.style.backgroundColor;
              const prevTr = row.style.transition;
              row.style.transition = 'background-color .15s ease';
              row.style.backgroundColor = 'rgba(82,222,94,0.35)';
              setTimeout(() => {
                row.style.backgroundColor = prevBg;
                row.style.transition = prevTr;
              }, 300);
            });
          },
          () => showToast('コピー失敗')
        );
        cancelChatPress();
      }, LONG_PRESS_MS);
    };

    const onChatMouseUp = (e) => {
      if (e.button !== 0) return;
      cancelChatPress();
    };

    const onChatMouseMove = (e) => {
      if (!_chatPressStartXY) return;
      const dx = e.clientX - _chatPressStartXY.x;
      const dy = e.clientY - _chatPressStartXY.y;
      if (dx * dx + dy * dy > 36) cancelChatPress();
    };

    chatContainer.addEventListener('mousedown', onChatMouseDown, { passive: true });
    chatContainer.addEventListener('mouseup',   onChatMouseUp,   { passive: true });
    chatContainer.addEventListener('mousemove', onChatMouseMove, { passive: true });

    const onMouseOver = (e) => {
      const row = e.target && e.target.closest ? e.target.closest(CHAT_SEL) : null;
      if (!row || row === currentHoverRow) return;
      const info = extractUserFromRow(row);
      if (!info || !info.login) return;

      if (muteEnabled && mutedUsers.has(info.login)) {
        hideVodChatLine(row);
        return;
      }

      try {
        const btn = ensureGlobalMuteButton();
        safe(() => {
          const cs = window.getComputedStyle(row);
          if (cs && cs.position === 'static') row.style.position = 'relative';
        });
        currentHoverRow     = row;
        currentHoverLogin   = info.login;
        currentHoverDisplay = info.display || info.login;
        safe(() => {
          if (btn.parentElement !== row) {
            btn.remove();
            row.appendChild(btn);
          }
        });
      } catch (_) {}
    };

    const onMouseOut = (e) => {
      if (!currentHoverRow) return;
      if (e.relatedTarget && currentHoverRow.contains(e.relatedTarget)) return;
      safe(() => { if (globalMuteButton && globalMuteButton.parentElement) globalMuteButton.remove(); });
      currentHoverRow = null;
      currentHoverLogin = null;
      currentHoverDisplay = null;
    };

    chatContainer.addEventListener('mouseover', onMouseOver, { passive: true });
    chatContainer.addEventListener('mouseout',  onMouseOut,  { passive: true });

    safe(() => {
      // chatContainer が親ごと祖先要素から取り除かれるケース（SPA遷移でラッパーごと
      // 差し替えられる場合など）も検知できるよう、document.body 配下を subtree で監視し、
      // removedNodes の一致判定に加えて isConnected でも存在チェックする。
      const cleanup = () => {
        safe(() => mo.disconnect());
        safe(() => {
          chatContainer.removeEventListener('mousedown', onChatMouseDown);
          chatContainer.removeEventListener('mouseup',   onChatMouseUp);
          chatContainer.removeEventListener('mousemove', onChatMouseMove);
          chatContainer.removeEventListener('mouseover', onMouseOver);
          chatContainer.removeEventListener('mouseout',  onMouseOut);
        });
        safe(() => remObs.disconnect());
        safe(() => containerObserverMap.delete(chatContainer));
        safe(() => { if (globalMuteButton && globalMuteButton.parentElement) globalMuteButton.remove(); });
      };
      const remObs = new MutationObserver(() => {
        if (chatContainer.isConnected) return;
        cleanup();
      });
      remObs.observe(document.body, { childList: true, subtree: true });
    });

    containerObserverMap.set(chatContainer, { mo, onMouseOver, onMouseOut, onChatMouseDown, onChatMouseUp, onChatMouseMove });
  }

  function findAndSetupChatContainer() {
    const candidates = [
      '[data-test-selector="chat-lines"]',
      '[data-a-target="video-chat"]',
      '[data-test-selector="video-chat"]',
      '.video-chat__message-list-wrapper ul',
      '.video-chat__message-list-wrapper',
      '.chat-scrollable-area__message-container',
      '.chat-list [role="log"]',
    ];
    let chatContainer = null;
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) { chatContainer = el; break; }
    }
    createSettingsButton();
    createPickerButton();
    ensureDanmakuButton();
    startCustomHiddenObserver();
    startButtonPlacementWatch();
    if (chatContainer) setupObserver(chatContainer);

  }

  /* ================================================================
     コミュニティハイライト領域: 汎用バナーブロック v3
     設計方針：
     - 「カード単位」でブロックを判定し、枠だけ残る問題を防ぐ
     - スキャン範囲を .community-highlight* 配下に限定することで軽量化
     - MutationObserver を rAF + 関連変更のみ反応でスロットリング
     - ピン留めコメント / 予想(Prediction) は「保護指標」で絶対残す
  ================================================================ */

  // 「保護したいもの」の識別セレクタ（今後追加しやすいよう配列化）
  // これらのいずれかを含むカードは「保護」ステータスになり、ブロックされない
  const PROTECT_SELECTORS = [
    // ピン留めコメント
    '.pinned-chat__highlight-card',
    '.pinned-chat__pinned-by',
    '.pinned-chat__message',
    '.pinned-chat__scrollable-area',
    '[class*="pinned-chat"]',
    '[class*="PinnedChat"]',
    '[data-test-selector*="pinned-chat" i]',
    '[aria-label*="ピン留めメッセージを表示"]',
    '[aria-label*="unpin" i]',
    // 予想 / Prediction
    '[class*="prediction" i]',
    '[class*="Prediction"]',
    '[data-test-selector*="prediction" i]',
    '[data-a-target*="prediction" i]',
    '[aria-label*="予想"]',
    '[aria-label*="prediction" i]',
    '[aria-label*="アンケート"]',
    // ハイライトメッセージ（ユーザーがチャンネルポイントで強調表示したコメント）
    '[class*="highlight-message"]',
    '[class*="highlighted-message"]',
  ].join(', ');

  // カード（ブロック判定の最小単位）のセレクタ
  const CARD_SELECTORS = [
    '.community-highlight-stack__card',
    '.community-highlight',
    '[class*="community-highlight"]',
  ].join(', ');

  // スキャンルート：ここ配下だけを見ることで軽量化
  function getHighlightScanRoots() {
    const out = [];
    safe(() => {
      const stacks = document.querySelectorAll('.community-highlight-stack, [class*="community-highlight-stack"]');
      stacks.forEach(s => out.push(s));
    });
    if (!out.length) {
      safe(() => {
        const c = document.querySelector('.chat-shell, .stream-chat, [data-a-target="stream-chat"]');
        if (c) out.push(c);
      });
    }
    return out;
  }

  // 要素が「保護対象」かを判定（自分 or 子孫に保護指標があれば保護）
  function isProtectedCard(card) {
    if (!card || card.nodeType !== Node.ELEMENT_NODE) return false;
    if (safe(() => card.matches(PROTECT_SELECTORS), false)) return true;
    if (safe(() => !!card.querySelector(PROTECT_SELECTORS), false)) return true;
    // テキストベースの追加保護
    const text = safe(() => (card.textContent || '').slice(0, 600), '');
    if (text) {
      if (/ピン留め/.test(text)) return true;
      if (/pinned by/i.test(text)) return true;
    }
    return false;
  }

  /* ================================================================
     プロモーション進捗ウィジェット（プラスプログラム等）非表示
     - 「プラスプログラム」の文字列だけに依存せず、同じ枠に入れ替わりで
       表示されうる別キャンペーンにも対応できるよう、仕様変更に強い
       属性（aria-label / href / alt）をマーカーとして検出する
     - マーカー要素自身に加えて、tw-transition（カード単位のラッパー）
       まで登って一緒に隠すことで「枠だけ残る」問題を防ぐ
       （tw-transition-group＝カルーセル全体までは登らない＝他の
       カードを巻き込んで消さないようにする）
  ================================================================ */
  const PROMO_WIDGET_MARKERS = [
    // 「〜の条件を展開して表示」系の展開ボタン（プラスプログラム等、共通の命名規則）
    'button[aria-label$="の条件を展開して表示"]',
    // プラスプログラムの説明リンク
    'a[href*="help.twitch.tv/s/article/plus-program"]',
    // プラスプログラムのチェックマーク画像
    'img[alt="小切手"]',
  ].join(', ');

  function hidePromoWidgetCard(marker) {
    if (!marker || marker.nodeType !== Node.ELEMENT_NODE) return;
    if (marker.dataset && marker.dataset.tmBlockBanner === '1') return;
    if (isProtectedCard(marker)) return;
    // まず自分自身を隠す（button の場合はこれだけで中身ごと消える）
    safe(() => marker.setAttribute('data-tm-block-banner', '1'));

    // tw-transition ラッパー（カード単位）まで登って、そちらも隠す
    let p = marker.parentElement;
    for (let i = 0; i < 12 && p; i++) {
      if (p.tagName === 'BODY' || p.tagName === 'HTML') break;
      const cls = (typeof p.className === 'string')
        ? p.className
        : (p.className && typeof p.className.baseVal === 'string' ? p.className.baseVal : '');
      // チャット本体は絶対に消さない
      if (/chat-list|chat-room|chat-shell|chat-input|stream-chat/.test(cls)) break;
      if (isProtectedCard(p)) break;
      if (/(?:^|\s)tw-transition(?!-group)(?:\s|$)/.test(cls)) {
        safe(() => p.setAttribute('data-tm-block-banner', '1'));
        break; // カード単位まで到達したらそこで止める（グループ全体は消さない）
      }
      p = p.parentElement;
    }
  }

  function hidePromoWidgets() {
    safe(() => {
      const chatScope =
        document.querySelector('.chat-shell, .stream-chat, [data-a-target="stream-chat"]') ||
        document.body;
      chatScope.querySelectorAll(PROMO_WIDGET_MARKERS).forEach(hidePromoWidgetCard);
    });
  }

  // カードをブロック（マーク付け）。「枠だけ残る」を防ぐためカードラッパーも一緒にマーク
  function blockCard(card) {
    if (!card || card.nodeType !== Node.ELEMENT_NODE) return;
    if (isProtectedCard(card)) return;
    safe(() => card.setAttribute('data-tm-block-banner', '1'));

    // 「カードラッパー」を探してそちらもマーク（最大4世代）
    let p = card.parentElement;
    for (let i = 0; i < 4 && p; i++) {
      if (p.tagName === 'BODY' || p.tagName === 'HTML') break;
      // SVG要素の className.baseVal にも対応
      const cls = (typeof p.className === 'string')
        ? p.className
        : (p.className && typeof p.className.baseVal === 'string' ? p.className.baseVal : '');
      // チャット本体は絶対に消さない
      if (/chat-list|chat-room|chat-shell|chat-input|stream-chat/.test(cls)) break;
      if (isProtectedCard(p)) break;
      // community-highlight-stack 自体には到達したら止める（その親まで消すと chat全体に影響する）
      if (/community-highlight-stack(?!__)/.test(cls)) break;
      // 「カードラッパー」と判定
      if (/community-highlight(-stack__card)?(--wide)?|tw-transition-group|tw-transition/.test(cls) ||
          /\bhighlight\b/.test(cls) || /highlight__collapsed/.test(cls)) {
        if (!isProtectedCard(p)) {
          safe(() => p.setAttribute('data-tm-block-banner', '1'));
        } else {
          break;
        }
      }
      p = p.parentElement;
    }
  }

  // 2要素の共通祖先（一番近いもの）を返す
  function lowestCommonAncestor(a, b) {
    if (!a || !b) return a || b || null;
    const anc = new Set();
    let n = a;
    while (n) { anc.add(n); n = n.parentElement; }
    n = b;
    while (n && !anc.has(n)) n = n.parentElement;
    return n || null;
  }

  // スキャン本体：コミュニティハイライト領域のすべてのカードを判定する
  function removeLeaderboardBanner() {
    if (!isCommunityHighlightHideEnabled()) return;
    safe(() => {
      // ギフト系ランキングカルーセル（「ヒーローになろう！」「サブスク目標」等）は
      //   community-highlight 領域の外に出ることがあるため、ルート走査より先に単独で処理する。
      //   外側の Layout div は無印クラスしか無く直接は狙えないため、
      //   「前/次」両ボタンの共通祖先をユニットとみなして隠す。
      //   ※ section を目印に遡る方式は使わない。チャット全体を含む section を掴むと
      //     チャット欄ごと消える事故になるため（v2.2の不具合）。
      safe(() => {
        const prevBtn = document.querySelector('button[aria-label="前のランキングセット"]');
        const nextBtn = document.querySelector('button[aria-label="次のランキングセット"]');
        if (!prevBtn || !nextBtn) return;
        let root = lowestCommonAncestor(prevBtn, nextBtn);
        if (!root || root === document.body) return;
        // 空のラッパーだけを伝って少し上までまとめて隠す
        // （子要素が1つだけの無印 div のみ。チャット本体を含む要素には絶対に到達させない）
        let guard = 0;
        while (root.parentElement && guard++ < 6) {
          const p = root.parentElement;
          if (p === document.body) break;
          if (p.tagName !== 'DIV') break;
          if (p.children.length !== 1) break;
          if (p.id || p.hasAttribute('data-a-target') || p.hasAttribute('data-test-selector')) break;
          if (p.matches && p.matches('.chat-shell, .stream-chat, [data-a-target="stream-chat"]')) break;
          if (p.querySelector('[data-test-selector="chat-lines"], [data-test-selector="chat-input-buttons-container"], .chat-scrollable-area__message-container')) break;
          root = p;
        }
        if (root.dataset && root.dataset.tmBlockBanner === '1') return;
        if (root.querySelector('[data-test-selector="chat-lines"], [data-test-selector="chat-input-buttons-container"]')) return;
        if (isProtectedCard(root)) return;
        safe(() => root.setAttribute('data-tm-block-banner', '1'));
      });

      const roots = getHighlightScanRoots();
      if (!roots.length) return;

      for (const root of roots) {
        // ルート自身もカードの可能性
        if (safe(() => root.matches(CARD_SELECTORS), false)) {
          if (!isProtectedCard(root)) blockCard(root);
        }
        const cards = safe(() => root.querySelectorAll(CARD_SELECTORS), null);
        if (!cards) continue;
        for (const card of cards) {
          if (card.dataset && card.dataset.tmBlockBanner === '1') continue;
          if (isProtectedCard(card)) continue;
          blockCard(card);
        }
      }

      // 予備：既知の外部バナー（chat-shell配下、community-highlight領域外でも対応）
      const externalKnown = [
        '[class*="channelLeaderboardHeader"]',
        '[class*="ChannelLeaderboard"]',
        '[class*="GiftSubBanner"]',
        '[class*="SubscriptionsGifter"]',
        '[aria-label*="ランキングを展開"]',
        '[aria-label*="leaderboard" i]',
      ];
      const chatScope = document.querySelector('.chat-shell, .stream-chat, [data-a-target="stream-chat"]') || document.body;
      for (const sel of externalKnown) {
        safe(() => {
          chatScope.querySelectorAll(sel).forEach(el => {
            if (isProtectedCard(el)) return;
            safe(() => el.setAttribute('data-tm-block-banner', '1'));
          });
        });
      }

      // プラスプログラム等の進捗ウィジェット（カード単位で隠す）
      hidePromoWidgets();

      // 最終防衛線: ピン留めマークに非表示属性が付いていたら必ず剥がす
      repairPinMarkVisibility();
    });
  }

  // MutationObserver を rAF + 関連変更のみ反応 でスロットリング
  let leaderboardWatcher = null;
  let _bannerScanScheduled = false;
  function scheduleBannerScan() {
    if (_bannerScanScheduled) return;
    _bannerScanScheduled = true;
    requestAnimationFrame(() => {
      _bannerScanScheduled = false;
      removeLeaderboardBanner();
    });
  }

  function startLeaderboardWatcher() {
    if (!isCommunityHighlightHideEnabled()) return;
    if (leaderboardWatcher) {
      safe(() => leaderboardWatcher.disconnect());
      leaderboardWatcher = null;
    }
    leaderboardWatcher = new MutationObserver((mutations) => {
      // 関係ある変更だけスキャン
      for (const m of mutations) {
        if (m.type !== 'childList') continue;
        if (!m.addedNodes || m.addedNodes.length === 0) continue;
        for (const n of m.addedNodes) {
          if (n.nodeType !== Node.ELEMENT_NODE) continue;
          // SVG要素の場合 className は SVGAnimatedString で string ではないため、
          // typeof チェックで判定を切り替える
          const clsStr = (typeof n.className === 'string')
            ? n.className
            : (n.className && typeof n.className.baseVal === 'string' ? n.className.baseVal : '');
          if (clsStr && /community-highlight|highlight|leaderboard|GiftSub|ChannelLeaderboard|tw-transition/.test(clsStr)) {
            scheduleBannerScan();
            return;
          }
          if (n.querySelector && safe(() => !!n.querySelector(CARD_SELECTORS), false)) {
            scheduleBannerScan();
            return;
          }
          if (n.querySelector && safe(() => !!n.querySelector('button[aria-label="前のランキングセット"], button[aria-label="次のランキングセット"]'), false)) {
            scheduleBannerScan();
            return;
          }
        }
      }
    });
    safe(() => {
      const chatRoot =
        document.querySelector('[data-a-target="stream-chat"], .stream-chat') ||
        document.body;
      leaderboardWatcher.observe(chatRoot, { childList: true, subtree: true });
      removeLeaderboardBanner();
    });
  }
  if (isCommunityHighlightHideEnabled()) enableCommunityHighlightHiding();
  applyReplyButtonStyle();

  // 初回ロード後の遅延スキャン（SPA / マウント遅延対策）
  setTimeout(removeLeaderboardBanner, 800);
  setTimeout(removeLeaderboardBanner, 2500);
  setTimeout(removeLeaderboardBanner, 5000);

  /* ================================================================
     VOD定期スキャン
  ================================================================ */
  function sweepExistingVodMessages() {
    if (!isVodPage() || !muteEnabled || !mutedUsers.size) return;
    safeExec(() => {
      const rows = document.querySelectorAll(VOD_SEL);
      // 大量の VOD 行でも WeakMap キャッシュを使って extractUserFromRow のDOM walkを回避
      for (const row of rows) {
        safeExec(() => {
          if (row.dataset && row.dataset.tmVodMuted === '1') return;
          const info = getRowUser(row);
          if (info && info.login && mutedUsers.has(info.login)) hideVodChatLine(row);
        }, undefined, 'sweep row');
      }
    }, undefined, 'sweepExistingVodMessages');
  }

  /* ================================================================
     SPA遷移対策
  ================================================================ */
  // SPA 遷移・チャットコンテナマウントを検知する watcher
  // ＜軽量化＞
  //   - 追加ノードに「チャット関連」のシグネチャがある場合のみ処理
  //   - rAF + 250msデバウンスでコールバック実行頻度を抑制
  let _watcherScheduled = false;
  let _watcherTimer = null;
  function _runGlobalWatcherCb() {
    findAndSetupChatContainer();
    scheduleSettingBtnReposition();
  }
  const globalContainerWatcher = new MutationObserver((mutations) => {
    if (_watcherScheduled) return;
    // 関連ある変更かだけチェック
    let relevant = false;
    for (const m of mutations) {
      if (m.type !== 'childList' || !m.addedNodes || m.addedNodes.length === 0) continue;
      for (const n of m.addedNodes) {
        if (n.nodeType !== Node.ELEMENT_NODE) continue;
        // SVG要素対応（同上）
        const cls = (typeof n.className === 'string')
          ? n.className
          : (n.className && typeof n.className.baseVal === 'string' ? n.className.baseVal : '');
        // ※ M-3でここを "chat-scrollable-area|chat-room|..." のように狭めたところ、
        // SPA遷移（配信切り替え）後にホバーミュートボタンが再セットアップされなくなる
        // 不具合が発生したため元の判定に戻した。理由：findAndSetupChatContainer() が
        // 実際に探しているコンテナ候補は data-test-selector 等の属性セレクタが中心で、
        // クラス名ベースではない。従来は「classに"chat"を含む要素(メッセージ行など)が
        // 追加されるたび再スキャンする」という間接的な仕組みで、結果的にコンテナの
        // 取りこぼしを防いでいた。CPU消費より動作の確実性を優先し、広い判定に戻す。
        if (cls && /chat|stream|video-chat|primary-nav|top-nav|persistent-player/.test(cls)) {
          relevant = true; break;
        }
      }
      if (relevant) break;
    }
    if (!relevant) return;

    _watcherScheduled = true;
    if (_watcherTimer) clearTimeout(_watcherTimer);
    _watcherTimer = setTimeout(() => {
      _watcherTimer = null;
      requestAnimationFrame(() => {
        _watcherScheduled = false;
        _runGlobalWatcherCb();
      });
    }, 250);
  });
  safe(() => {
    if (document.body) globalContainerWatcher.observe(document.body, { childList: true, subtree: true });
  });

  /* ================================================================
     ブロックユーザー一覧の取り込み（/settings/security）
     Twitchの「ブロック中」テーブルを検出し、ワンクリックでミュートリストへ
     一括マージ取り込みする。DOM構造（2026年8月時点で確認）:
       <tr>
         <td>(アバター)</td>
         <td><a href="/{login}" aria-label="ユーザー、{login}のプロフィールページに移動">...</a></td>
         <td>(ブロックした日付)</td>
         <td><button aria-label='ユーザー「{login}」のブロックを解除'>ブロック解除</button></td>
       </tr>
     ログイン名は href="/xxx" から取得する（表示名とログイン名の乖離やaria-label文言
     変化に一番強いため）。ハッシュ化クラス名（Sc*, InjectLayout-* 等）は一切使わない。
  ================================================================ */
  function isBlockedUsersPage() {
    return safe(() => location.pathname === '/settings/security', false);
  }

  // M-4: /settings/security ページに将来別のテーブル（ログイン履歴等）が追加された場合、
  // document 全体の table を対象にすると無関係なテーブルを誤ってブロック中一覧として
  // 走査してしまう恐れがある。見出しに「ブロック」を含むセクション内のテーブルに
  // 限定して探し、見つからない場合のみ現状どおり最初の table にフォールバックする
  // （フォールバックがあるので、見出し構造が変わっても動作が壊れることはない）。
  function getBlockedUsersTable() {
    return safeExec(() => {
      const tables = [...document.querySelectorAll('table')];
      for (const t of tables) {
        let el = t;
        for (let i = 0; i < 4 && el; i++, el = el.parentElement) {
          const heading = el.querySelector && el.querySelector('h1,h2,h3,h4,[role="heading"]');
          if (heading && /ブロック/.test(heading.textContent || '')) return t;
        }
      }
      return tables[0] || null;
    }, null, 'getBlockedUsersTable');
  }

  // ページネーションボタン等、テーブル周辺のUIを探すための祖先セクション
  function getBlockedUsersSection(table) {
    let el = table;
    for (let i = 0; i < 4 && el && el.parentElement; i++) el = el.parentElement;
    return el || document;
  }

  function scanBlockedLoginsOnce() {
    const logins = new Set();
    safeExec(() => {
      const table = getBlockedUsersTable();
      const rows = table ? table.querySelectorAll('tbody tr') : document.querySelectorAll('table tbody tr');
      rows.forEach(tr => {
        const a = tr.querySelector('td a[href^="/"]');
        if (a) {
          const href = a.getAttribute('href') || '';
          const login = normalizeLogin(href.replace(/^\//, '').split(/[/?#]/)[0]);
          if (login && /^[a-z0-9_]{1,25}$/.test(login)) { logins.add(login); return; }
        }
        // フォールバック: プロフィールリンクの無い行（凍結・削除済みアカウント等）は
        // href からログイン名を取れないため、その行が永久に照合から漏れて
        // 「既にブロック済みなのに再追加を試みる」原因になっていた。
        // ブロック解除ボタンの aria-label（ユーザー「{login}」のブロックを解除）から拾う。
        const btn = tr.querySelector('button[aria-label*="のブロックを解除"]');
        if (btn) {
          const m = (btn.getAttribute('aria-label') || '').match(/「([^」]+)」/);
          const login = m ? normalizeLogin(m[1]) : '';
          if (login && /^[a-z0-9_]{1,25}$/.test(login)) logins.add(login);
        }
      });
    }, undefined, 'scanBlockedLoginsOnce');
    return logins;
  }

  // --- ページネーション巡回設定 ---
  const BLOCKLIST_CHECKPOINT_KEY = 'tm_blocklist_import_checkpoint_v1';
  const BLOCKLIST_CHECKPOINT_MAX_AGE_MS = 3 * 3600 * 1000; // 3時間以内なら再開候補にする
  const BLOCKLIST_MAX_PAGES = 2000; // 暴走防止の安全上限（539ページ想定なら十分な余裕）
  const BLOCKLIST_PAGE_WAIT_TIMEOUT_MS = 8000; // 1ページの内容更新を待つ最大時間
  const BLOCKLIST_PAGE_POLL_MS = 200;
  const BLOCKLIST_INTER_PAGE_JITTER_MS = [350, 700]; // クリック間の待機（連打防止・軽いレート制御）
  const BLOCKLIST_READY_TIMEOUT_MS = 8000; // テーブル初回描画（非同期取得）を待つ最大時間
  const BLOCKLIST_READY_POLL_MS = 200;
  const BLOCKLIST_NEXTBTN_RETRY_COUNT = 5; // 「次のページ」ボタン未検出時のリトライ回数
  const BLOCKLIST_NEXTBTN_RETRY_INTERVAL_MS = 300;

  // ブロック中一覧のテーブルに最低1行描画されるまで待つ。
  // /settings/security へ遷移した直後や、走査対象ページのAPI取得がまだ完了していない
  // タイミングで走査を始めると、テーブルもページネーションUIも空のままとなり、
  // 「次のページ」ボタンが見つからない＝最終ページ、と誤判定してしまうため。
  async function waitForBlockedTableReady(timeoutMs) {
    const start = Date.now();
    const ready = () => {
      const table = getBlockedUsersTable();
      return table ? !!table.querySelector('tbody tr') : !!document.querySelector('table tbody tr');
    };
    while (Date.now() - start < timeoutMs) {
      if (ready()) return true;
      await new Promise(r => setTimeout(r, BLOCKLIST_READY_POLL_MS));
    }
    return ready();
  }

  function findNextPageButton() {
    // M-4: まずブロック中テーブル周辺のセクションに限定して探し、
    // 見つからなければ document 全体にフォールバックする（既存動作を維持）。
    const table = getBlockedUsersTable();
    const scope = table ? getBlockedUsersSection(table) : document;
    // aria-label 完全一致 → 部分一致の順でフォールバック（文言の微調整に耐える）
    return scope.querySelector('button[aria-label="次のページ"]')
      || scope.querySelector('button[aria-label*="次のページ" i]')
      || scope.querySelector('button[aria-label*="next page" i]')
      || document.querySelector('button[aria-label="次のページ"]')
      || document.querySelector('button[aria-label*="次のページ" i]')
      || document.querySelector('button[aria-label*="next page" i]');
  }

  function isNextPageButtonDisabled(btn) {
    if (!btn) return true;
    if (btn.disabled) return true;
    if (btn.getAttribute('aria-disabled') === 'true') return true;
    if (btn.hasAttribute('disabled')) return true;
    return false;
  }

  function findFirstPageButton() {
    const table = getBlockedUsersTable();
    const scope = table ? getBlockedUsersSection(table) : document;
    return scope.querySelector('button[aria-label="最初のページ"]')
      || scope.querySelector('button[aria-label*="最初のページ" i]')
      || scope.querySelector('button[aria-label*="first page" i]')
      || document.querySelector('button[aria-label="最初のページ"]')
      || document.querySelector('button[aria-label*="first page" i]');
  }

  // 巡回開始前に必ず1ページ目へ戻る。
  // テーブルが前回の巡回終了時の最終ページや、ユーザーの手動ページ送りの状態の
  // まま開始すると、それより前のページが丸ごと未走査になり、ブロック済み
  // ユーザーが大量に「未ブロック」と誤判定される（再追加試行の主因の1つ）。
  // 戻り値: 1ページ目にいる（または移動できた）ことが確認できたら true。
  async function goToFirstBlockedPage() {
    const btn = findFirstPageButton();
    if (!btn) return false; // ボタンが無いUIでは判定できない（キャッシュ併用でカバー）
    if (isNextPageButtonDisabled(btn)) return true; // 無効＝既に1ページ目
    const prevSig = firstRowSignature();
    safeExec(() => btn.click(), undefined, 'click first page button');
    const changed = await waitForPageContentChange(prevSig, BLOCKLIST_PAGE_WAIT_TIMEOUT_MS);
    if (changed) return true;
    // 変化検知に失敗しても、実際に1ページ目へ戻れている場合があるため再確認する
    const retryBtn = findFirstPageButton();
    return !!retryBtn && isNextPageButtonDisabled(retryBtn);
  }

  // 1ページ分を「行の集合が安定するまで」繰り返しスキャンして取り込む。
  // ページ遷移直後は行が段階的に描画されることがあり、1回だけのスキャンでは
  // 途中までしか拾えず、そのページの残りが照合から漏れる。新しいログイン名が
  // 増えなくなるまで（最大3回）300ms間隔で再スキャンする。
  async function scanBlockedLoginsStable(logins, pageLabel) {
    scanBlockedLoginsOnce().forEach(l => logins.add(l));
    for (let i = 0; i < 3; i++) {
      const before = logins.size;
      await new Promise(r => setTimeout(r, 300));
      scanBlockedLoginsOnce().forEach(l => logins.add(l));
      if (logins.size === before) break;
      console.warn('[MTB-DIAG] delayed row rendering detected on page', pageLabel,
        '- found', logins.size - before, 'additional login(s) after wait');
    }
  }

  function firstRowSignature() {
    const table = getBlockedUsersTable();
    const tr = table ? table.querySelector('tbody tr') : document.querySelector('table tbody tr');
    if (!tr) return '';
    const a = tr.querySelector('td a[href^="/"]');
    return a ? a.getAttribute('href') : tr.textContent.slice(0, 50);
  }

  function saveBlocklistCheckpoint(loginsSet, page) {
    safeExec(() => {
      lsSet(BLOCKLIST_CHECKPOINT_KEY, JSON.stringify({
        logins: [...loginsSet],
        page,
        savedAt: Date.now()
      }));
    }, undefined, 'saveBlocklistCheckpoint');
  }

  function loadBlocklistCheckpoint() {
    return safeExec(() => {
      const raw = lsGet(BLOCKLIST_CHECKPOINT_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || !Array.isArray(obj.logins) || !obj.savedAt) return null;
      if (Date.now() - obj.savedAt > BLOCKLIST_CHECKPOINT_MAX_AGE_MS) return null;
      return obj;
    }, null, 'loadBlocklistCheckpoint');
  }

  function clearBlocklistCheckpoint() {
    safe(() => localStorage.removeItem(BLOCKLIST_CHECKPOINT_KEY));
  }

  // 1ページ分の内容が「クリック前と変わる」まで待つ。タイムアウトしたら false を返す。
  // ページ遷移中の空文字列シグネチャを誤って「変化した」と判定しないよう、
  // 非空のシグネチャに変化した場合のみ「変化した」とみなす。
  async function waitForPageContentChange(prevSignature, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, BLOCKLIST_PAGE_POLL_MS));
      const sig = firstRowSignature();
      if (sig && sig !== prevSignature) return true;
    }
    return false;
  }

  function jitterDelay([min, max]) {
    return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
  }

  const _blockedImportState = { running: false, cancelRequested: false };

  // 「次のページ」を自動クリックしながら全ページを巡回し、ログイン名を収集する。
  // onProgress(page, count) は進捗表示用コールバック。
  async function crawlAllBlockedPages({ onProgress, resumeFrom, isCancelled } = {}) {
    // isCancelled 省略時は従来通り「ブロックリストをミュートに追加」ボタンの状態を見る。
    // 他ボタン（ミュートリスト→ブロック追加）から呼ぶ場合は、そのボタン自身の中断フラグを渡す。
    const checkCancelled = isCancelled || (() => _blockedImportState.cancelRequested);

    const logins = new Set(resumeFrom && resumeFrom.logins ? resumeFrom.logins : []);
    let page = resumeFrom && resumeFrom.page ? resumeFrom.page : 1;

    // テーブルがまだ非同期取得中で1行も描画されていない状態で走査を始めると、
    // 「次のページ」ボタンも未描画のため即座に最終ページと誤判定してしまう
    // （＝ごく一部しか収集できないまま「完了」扱いになる）。最初のスキャン前に
    // 最低1行が描画されるまで待つ。
    await waitForBlockedTableReady(BLOCKLIST_READY_TIMEOUT_MS);

    // 巡回は必ず1ページ目から始める（テーブルが途中のページを表示したまま
    // 開始すると、それより前が丸ごと未走査になるため）。チェックポイントから
    // 再開する場合も、収集済みセットは保持したまま全ページを走査し直す方が
    // 正確（ページ番号カウンタだけ1に戻す）。
    const wentFirst = await goToFirstBlockedPage();
    if (wentFirst) page = 1;

    // 開始ページ分を取り込む（行の集合が安定するまで繰り返しスキャン）
    await scanBlockedLoginsStable(logins, page);
    if (onProgress) onProgress(page, logins.size);

    let cancelled = false;

    for (let i = 0; i < BLOCKLIST_MAX_PAGES; i++) {
      if (checkCancelled()) { cancelled = true; break; }

      let nextBtn = findNextPageButton();
      if (!nextBtn) {
        // ボタンが「見つからない」は「最終ページ」と断定できない。直前のページ遷移
        // 直後でページネーションUIがまだ再描画されていないだけの可能性があるため、
        // 数百ページ規模の巡回で一度でも誤って早期終了すると致命的（以降が全て
        // 未走査のまま「完了」扱いになる）。見つかるまで軽くリトライする。
        // 一方、ボタンが「見つかった上でdisabled」なのは本当に最終ページに
        // 到達した確度の高いシグナルなので、その場合は即break（下の行で判定）。
        for (let r = 0; r < BLOCKLIST_NEXTBTN_RETRY_COUNT && !nextBtn; r++) {
          await new Promise(res => setTimeout(res, BLOCKLIST_NEXTBTN_RETRY_INTERVAL_MS));
          nextBtn = findNextPageButton();
        }
      }
      if (!nextBtn || isNextPageButtonDisabled(nextBtn)) break; // 最終ページ到達

      const prevSig = firstRowSignature();
      safeExec(() => nextBtn.click(), undefined, 'click next page button');

      let changed = await waitForPageContentChange(prevSig, BLOCKLIST_PAGE_WAIT_TIMEOUT_MS);

      if (!changed) {
        // タイムアウト＝クリック失敗とは限らない（変化検知が間に合わなかっただけの
        // 場合もある）。その状態でリトライクリックするとページがN→N+2と進んで
        // 間のページが欠落しうるため、リトライ前に今の画面内容を一度スキャンしておく。
        scanBlockedLoginsOnce().forEach(l => logins.add(l));
        const midSig = firstRowSignature();

        if (midSig && midSig !== prevSig) {
          // 検知が遅れていただけで、実際にはページは変わっていた
          changed = true;
        } else {
          // 本当にまだ変わっていない場合のみリトライクリック
          safeExec(() => { const b = findNextPageButton(); if (b) b.click(); }, undefined, 'retry click next page button');
          changed = await waitForPageContentChange(prevSig, BLOCKLIST_PAGE_WAIT_TIMEOUT_MS);
          // リトライ後も、変化検知の成否に関わらず必ず現在の内容を取り込む（安全網）
          scanBlockedLoginsOnce().forEach(l => logins.add(l));
          if (!changed) {
            const afterRetrySig = firstRowSignature();
            if (!afterRetrySig || afterRetrySig === prevSig) break; // 本当に最終ページとみなして終了
            changed = true;
          }
        }
      }

      page++;
      // 遷移先ページを取り込む（行の集合が安定するまで繰り返しスキャン）
      await scanBlockedLoginsStable(logins, page);
      if (onProgress) onProgress(page, logins.size);

      if (page % 10 === 0) saveBlocklistCheckpoint(logins, page);

      await jitterDelay(BLOCKLIST_INTER_PAGE_JITTER_MS);
    }

    // [MTB-DIAG] クロール終了時点のサマリー（想定より早く終わっていないかの確認用）
    console.log('[MTB-DIAG] crawlAllBlockedPages: finished', {
      finalPage: page,
      totalCollected: logins.size,
      cancelled
    });

    return { logins, page, cancelled };
  }

  /* ================================================================
     ブロック済み学習キャッシュ
     照合（全ページ巡回）は1回でもページを取りこぼすと、そのページの
     ブロック済みユーザーを「未ブロック」と誤判定して再追加を試みてしまう。
     そこで「ブロック済みだと一度でも確認できたユーザー」を永続キャッシュに
     蓄積し、照合結果とは常に和集合で除外判定する。一度学習したユーザーは
     巡回が失敗しても二度と再追加対象にならないため、再追加試行は回を追う
     ごとに減っていく。学習元は次の3つ:
       1) 巡回で収集できたログイン名（中断時の部分収集分も含む）
       2) ブロック追加が成功したユーザー（追加した時点でブロック済み）
       3) 追加を試みたら「既にブロック」応答が返ったユーザー
  ================================================================ */
  const KNOWN_BLOCKED_KEY = 'tm_known_blocked_logins_v1';
  let knownBlockedLogins = (() => {
    const raw = lsGet(KNOWN_BLOCKED_KEY);
    if (!raw) return new Set();
    const arr = safe(() => JSON.parse(raw), []);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.map(normalizeLogin).filter(l => /^[a-z0-9_]{1,25}$/.test(l)));
  })();
  let _knownBlockedSaveTimer = null;
  function saveKnownBlockedLogins() {
    if (_knownBlockedSaveTimer) return;
    _knownBlockedSaveTimer = setTimeout(() => {
      _knownBlockedSaveTimer = null;
      lsSet(KNOWN_BLOCKED_KEY, JSON.stringify([...knownBlockedLogins]));
    }, 500);
  }
  function rememberKnownBlocked(iterable) {
    if (!iterable) return 0;
    let added = 0;
    for (const rawLogin of iterable) {
      const l = normalizeLogin(rawLogin);
      if (l && /^[a-z0-9_]{1,25}$/.test(l) && !knownBlockedLogins.has(l)) {
        knownBlockedLogins.add(l);
        added++;
      }
    }
    if (added) saveKnownBlockedLogins();
    return added;
  }

  // 「存在しないユーザー」の学習キャッシュ。
  // アカウント削除等で存在しないユーザーは、ブロック追加を試みても毎回失敗し、
  // 失敗リスト経由で次回も再試行されてしまう。それを防ぐため、「存在しない」
  // 応答が返ったユーザーをここに学習し、次回以降は最初から対象外にする。
  const KNOWN_NONEXISTENT_KEY = 'tm_known_nonexistent_logins_v1';
  let knownNonexistentLogins = (() => {
    const raw = lsGet(KNOWN_NONEXISTENT_KEY);
    if (!raw) return new Set();
    const arr = safe(() => JSON.parse(raw), []);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.map(normalizeLogin).filter(l => /^[a-z0-9_]{1,25}$/.test(l)));
  })();
  let _knownNonexistentSaveTimer = null;
  function saveKnownNonexistentLogins() {
    if (_knownNonexistentSaveTimer) return;
    _knownNonexistentSaveTimer = setTimeout(() => {
      _knownNonexistentSaveTimer = null;
      lsSet(KNOWN_NONEXISTENT_KEY, JSON.stringify([...knownNonexistentLogins]));
    }, 500);
  }
  function rememberKnownNonexistent(iterable) {
    if (!iterable) return 0;
    let added = 0;
    for (const rawLogin of iterable) {
      const l = normalizeLogin(rawLogin);
      if (l && /^[a-z0-9_]{1,25}$/.test(l) && !knownNonexistentLogins.has(l)) {
        knownNonexistentLogins.add(l);
        added++;
      }
    }
    if (added) saveKnownNonexistentLogins();
    return added;
  }
  // 追加試行の応答文言が「存在しないユーザー」を示しているか
  const NONEXISTENT_PATTERN = /見つかりません|見つからなかった|存在しません|存在しない|user not found|does not exist|doesn't exist|no such user/i;

  // 「ブロックリストをミュートに追加」用のチェックポイント（BLOCKLIST_CHECKPOINT_KEY）を
  // 共用して、現在ブロック中の全ユーザーを走査する。既にチェックポイントがあれば
  // （どちらのボタン由来でも）そこから再開し、完走した場合のみクリアする。
  // 戻り値の logins は「今回の巡回結果 ∪ 学習キャッシュ」（照合の取りこぼしを
  // キャッシュ側で補うため、巡回単体の結果より常に大きくなる）。
  async function collectCurrentlyBlockedLogins({ onProgress, isCancelled } = {}) {
    const resumeFrom = loadBlocklistCheckpoint();
    // [MTB-DIAG] 共有チェックポイント（BLOCKLIST_CHECKPOINT_KEY）が古い状態から
    // 再開されていないかを確認するための診断ログ（挙動は変更しない）。
    console.log('[MTB-DIAG] collectCurrentlyBlockedLogins: checkpoint check', resumeFrom ? {
      resumedFromCheckpoint: true,
      resumeStartPage: resumeFrom.page,
      resumeLoginsCount: Array.isArray(resumeFrom.logins) ? resumeFrom.logins.length : 0,
      savedAt: resumeFrom.savedAt ? new Date(resumeFrom.savedAt).toISOString() : null,
      ageMs: resumeFrom.savedAt ? (Date.now() - resumeFrom.savedAt) : null
    } : { resumedFromCheckpoint: false });

    const { logins, cancelled } = await crawlAllBlockedPages({ onProgress, resumeFrom, isCancelled });

    console.log('[MTB-DIAG] collectCurrentlyBlockedLogins: crawl result', {
      totalLoginsCollected: logins.size,
      cancelled
    });

    // 巡回結果（中断時の部分収集を含む）を学習キャッシュへ蓄積し、
    // 除外判定は「巡回 ∪ キャッシュ」で行う。今回の巡回がどこかのページを
    // 取りこぼしても、過去に確認できたユーザーは除外され続ける。
    const learnedNow = rememberKnownBlocked(logins);
    const merged = new Set(knownBlockedLogins);
    console.log('[MTB-DIAG] collectCurrentlyBlockedLogins: merged with known cache', {
      crawlCollected: logins.size,
      learnedNow,
      cacheTotal: knownBlockedLogins.size,
      mergedTotal: merged.size
    });

    if (!cancelled) clearBlocklistCheckpoint();
    return { logins: merged, cancelled };
  }

  const BLOCKED_IMPORT_BTN_ID = 'tm-blocklist-import-btn';
  const BLOCKED_IMPORT_BTN_DEFAULT_TEXT = 'ブロックリストをミュートに追加';

  function ensureBlockedImportButton() {
    let btn = document.getElementById(BLOCKED_IMPORT_BTN_ID);
    if (btn) return btn;
    btn = document.createElement('button');
    btn.id = BLOCKED_IMPORT_BTN_ID;
    btn.type = 'button';
    btn.textContent = BLOCKED_IMPORT_BTN_DEFAULT_TEXT;
    Object.assign(btn.style, {
      position:      'fixed',
      right:         '20px',
      bottom:        '20px',
      zIndex:        '999999',
      padding:       '10px 16px',
      borderRadius:  '8px',
      border:        'none',
      background:    '#9147ff',
      color:         '#fff',
      fontSize:      '13px',
      fontFamily:    FONT_STACK_JP,
      cursor:        'pointer',
      boxShadow:     '0 4px 14px rgba(0,0,0,0.4)'
    });
    btn.addEventListener('click', onClickBlockedImportButton);
    safe(() => document.body.appendChild(btn));
    return btn;
  }

  function removeBlockedImportButton() {
    safe(() => {
      const btn = document.getElementById(BLOCKED_IMPORT_BTN_ID);
      if (btn) btn.remove();
    });
  }

  async function finishBlockedImport(logins, { cancelled = false, page } = {}) {
    if (!logins.size) {
      showToast('ブロック中ユーザーが見つかりませんでした');
      return;
    }
    // 確認ダイアログは出さず、収集完了後は自動でミュートリストへ書き込む。
    // このボタンは /settings/security ページでのみ表示され、ユーザー自身の
    // 明示的なクリックで開始する処理のため、意図しない実行の心配はない。
    // 書き込み前に必ずチェックポイントを保存し、結果はトースト通知で知らせる。
    if (Number.isFinite(page)) saveBlocklistCheckpoint(logins, page);

    const newCount = [...logins].filter(l => !mutedUsers.has(l)).length;
    const cancelNote = cancelled ? '（ 中断・ここまでの取得分 ）' : '';

    const result = applyImportedMutePayload(
      { schema: 2, users: [...logins], displays: {} },
      'merge'
    );
    if (result && result.ok) {
      showToast(`✅ 取り込み完了${cancelNote}：新規 ${newCount} 件をミュートリストに追加（ 合計 ${result.total} 件 ）`, 4500);
      clearBlocklistCheckpoint();
    } else {
      showToast('⚠️ 取り込みに失敗しました');
    }
  }

  async function onClickBlockedImportButton() {
    const btn = document.getElementById(BLOCKED_IMPORT_BTN_ID);

    // 実行中に押された → 誤クリックで直接中断させないよう確認ダイアログを挟む
    if (_blockedImportState.running) {
      const reallyCancel = window.confirm(
        '取り込みを中断しますか？\n\n' +
        '[ OK ] 中断する（ ここまでの収集分をミュートリストに取り込めます ）\n' +
        '[ キャンセル ] このまま自動で最後のページまで続行する'
      );
      if (reallyCancel) {
        _blockedImportState.cancelRequested = true;
        showToast('中断リクエストを受け付けました…');
      }
      return;
    }

    // 有効なチェックポイントがあれば再開するか確認
    let resumeFrom = null;
    const checkpoint = loadBlocklistCheckpoint();
    if (checkpoint) {
      const resume = window.confirm(
        `前回の取り込みが ${checkpoint.page} ページ目（ ${checkpoint.logins.length} 件収集済み ）で中断されています。\n` +
        `続きから再開しますか？\n\n` +
        `[ OK ] 続きから再開　/　[ キャンセル ] 最初からやり直す`
      );
      if (resume) {
        resumeFrom = checkpoint;
        showToast(`${checkpoint.page}ページ目から再開します`);
      } else {
        clearBlocklistCheckpoint();
      }
    }

    _blockedImportState.running = true;
    _blockedImportState.cancelRequested = false;

    try {
      const { logins, page, cancelled } = await crawlAllBlockedPages({
        resumeFrom,
        onProgress: (p, count) => {
          if (btn) btn.textContent = `⏳ ${p}ページ目 / 収集${count}件（ クリックで中断 ）`;
        }
      });

      if (cancelled) {
        saveBlocklistCheckpoint(logins, page);
        showToast(`${page}ページ目で中断しました（ ${logins.size}件収集済み・チェックポイント保存済み ）`);
      }

      await finishBlockedImport(logins, { cancelled, page });
    } catch (err) {
      logWarn('blocked import failed', err);
      showToast('⚠️ 取り込み中にエラーが発生しました');
    } finally {
      _blockedImportState.running = false;
      _blockedImportState.cancelRequested = false;
      if (btn) { btn.disabled = false; btn.textContent = BLOCKED_IMPORT_BTN_DEFAULT_TEXT; }
    }
  }

  function updateBlockedImportButtonVisibility() {
    safe(() => {
      if (isBlockedUsersPage()) ensureBlockedImportButton();
      else removeBlockedImportButton();
    });
  }

  /* ================================================================
     ミュートリスト → ブロックリストへの一括追加（/settings/security）
     実行前にまずブロックリスト（テーブル）を全ページ走査し、ミュートリストとの
     差分（＝まだブロックされていないユーザー）だけを追加対象とする。これにより
     既にブロック済みのユーザーへ無駄な追加操作を行わない（crawlAllBlockedPages /
     collectCurrentlyBlockedLogins を参照）。
     追加自体は「ユーザー名を入力してください」欄に1件ずつ入力して「追加」ボタンを押す、
     という通常の操作を自動で繰り返すことで実現する。
     input はReact管理下のコントロール入力のため、value を直接書き換えるだけでは
     Reactの内部stateに反映されない。ネイティブの value setter を使って値をセットした後、
     input/change イベントを発火させることでReact側にも変更を伝える。
     ハッシュ化クラス名（Sc*, Layout-* 等）は使わず、placeholder文言とボタンのラベル
     テキスト（data-a-target="tw-core-button-label-text"）から要素を特定する。
  ================================================================ */
  const MUTE_TO_BLOCK_CHECKPOINT_KEY = 'tm_mute_to_block_checkpoint_v1';
  const MUTE_TO_BLOCK_CHECKPOINT_MAX_AGE_MS = 3 * 3600 * 1000; // 3時間以内なら再開候補にする
  const MUTE_TO_BLOCK_ITEM_TIMEOUT_MS = 10000; // 1件あたり、ボタン有効化・結果表示を待つ最大時間（[MTB-FIX] 6000→10000。ロード中表示が続くケースに余裕を持たせる）
  const MUTE_TO_BLOCK_POLL_MS = 150;
  // 書き込み操作（実際にブロックが作成される）のため、ページ送りより間隔を広めに取る
  const MUTE_TO_BLOCK_JITTER_MS = [900, 1600];

  function findBlockAddInput() {
    return document.querySelector('input[placeholder="ユーザー名を入力してください"]');
  }

  // 入力欄・追加ボタン・エラー表示（role="status"）を共通で含む祖先要素を探す
  function findBlockAddContainer(input) {
    let el = input;
    for (let i = 0; i < 6 && el; i++) {
      el = el.parentElement;
      if (!el) break;
      if (el.querySelector('button') && el.querySelector('[role="status"]')) return el;
    }
    return (input && input.closest('form')) || (input ? input.parentElement : null);
  }

  function findBlockAddButton(container) {
    const scope = container || document;
    const buttons = scope.querySelectorAll('button');
    for (const b of buttons) {
      const label = b.querySelector('[data-a-target="tw-core-button-label-text"]');
      if (label && label.textContent.trim() === '追加') return b;
    }
    return null;
  }

  // React管理下の input に対して、Reactのstateにも反映される形で値をセットする
  function setReactInputValue(input, value) {
    safeExec(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, value);
      input.dispatchEvent(new Event('input',  { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, undefined, 'setReactInputValue');
  }

  async function waitUntilTrue(predicate, timeoutMs, pollMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (safeExec(predicate, false)) return true;
      await new Promise(r => setTimeout(r, pollMs));
    }
    return safeExec(predicate, false);
  }

  // クリック後、入力欄が空に戻れば成功・role="status" にエラー文言が出れば失敗とみなす。
  // ただし status の変化を検知しても即座に失敗確定はしない。成功時のクリアが1ポーリング分
  // 遅れて到着するケースがあり得るため、STATUS_GRACE_MS の猶予を置いて、その間に入力欄が
  // クリアされたら成功として扱う（=先に観測したstatus変化は誤検知だったとみなす）。
  //
  // [MTB-FIX] さらに、statusの変化が「ロード中」等の進行中インジケータである場合は、
  // それ自体をエラー候補として扱わない（猶予タイマーを開始・継続しない）。実際のブロック
  // API呼び出しが500msの猶予内に終わらず「ロード中」表示が残っているだけのケースを、
  // 誤って「失敗」と確定してしまっていたため（診断ログで reason: 'ロード中' が多発するのを
  // 確認済み）。ローディング表示である間は判定を保留し続け、それ以外の文言に変わった時点
  // で初めて失敗候補としての猶予カウントを開始する。
  const STATUS_GRACE_MS = 500;
  const LOADING_STATUS_PATTERN = /ロード中|読[みょ]?込み?中|loading/i;

  // [MTB-DIAG] role="status"（statusEl）以外の場所に出ているトースト等の通知
  // （role="alert" や aria-live 属性を持つ要素）の文言を拾うための診断用ヘルパー。
  // 挙動には一切影響させず、observedLiveRegionTexts として結果に付与するだけ。
  function scanLiveRegions() {
    const texts = new Set();
    safeExec(() => {
      document.querySelectorAll('[role="alert"], [aria-live], .tw-snackbar-message').forEach(el => {
        const t = (el.textContent || '').trim();
        if (t) texts.add(t);
      });
    }, undefined, 'scanLiveRegions');
    return texts;
  }

  async function waitForBlockAddOutcome(input, statusEl, beforeStatusText, timeoutMs, baselineLiveTexts) {
    const start = Date.now();
    let pendingStatusText = null;
    let pendingStatusAt = 0;
    const observedLiveRegionTexts = new Set(); // [MTB-DIAG]

    while (Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, MUTE_TO_BLOCK_POLL_MS));

      // statusEl以外の通知領域も毎ポーリングで確認し、observedLiveRegionTexts に蓄積する。
      scanLiveRegions().forEach(t => observedLiveRegionTexts.add(t));

      if (input && input.value === '') return { ok: true, reason: 'cleared', observedLiveRegionTexts: [...observedLiveRegionTexts] };

      // スナックバー等の通知に決定的なエラー（「このユーザーは存在しません」等）が
      // 新しく出たら、タイムアウトを待たずに失敗として早期確定する。
      // （クリック前から表示されていた通知は baseline として除外する）
      for (const t of observedLiveRegionTexts) {
        if (baselineLiveTexts && baselineLiveTexts.has(t)) continue;
        if (NONEXISTENT_PATTERN.test(t) || /既にブロック|すでにブロック|already blocked/i.test(t)) {
          return { ok: false, reason: t, observedLiveRegionTexts: [...observedLiveRegionTexts] };
        }
      }

      if (statusEl) {
        const now = statusEl.textContent || '';
        const isLoadingIndicator = LOADING_STATUS_PATTERN.test(now);

        if (isLoadingIndicator) {
          // まだ処理中。ここまでに拾いかけていた失敗候補があっても、実際には
          // ロード中の表示を経由しているだけの可能性が高いのでリセットして待ち続ける。
          pendingStatusText = null;
          pendingStatusAt = 0;
        } else if (now && now !== beforeStatusText) {
          if (pendingStatusText === null) {
            pendingStatusText = now;
            pendingStatusAt = Date.now();
          } else if (Date.now() - pendingStatusAt >= STATUS_GRACE_MS) {
            return { ok: false, reason: pendingStatusText, observedLiveRegionTexts: [...observedLiveRegionTexts] };
          }
        }
      }
    }
    // タイムアウト時：status変化を検知済みならそれを理由に、なければ純粋なtimeoutとして失敗扱い
    return { ok: false, reason: pendingStatusText || 'timeout', observedLiveRegionTexts: [...observedLiveRegionTexts] };
  }

  async function addLoginToBlocklist(login) {
    const input = findBlockAddInput();
    if (!input) return { ok: false, reason: 'no-input' };

    const container = findBlockAddContainer(input);
    const statusEl = container ? container.querySelector('[role="status"]') : null;

    setReactInputValue(input, login);
    await new Promise(r => setTimeout(r, 200));

    const btn = findBlockAddButton(container);
    if (!btn) return { ok: false, reason: 'no-button' };

    const enabled = await waitUntilTrue(() => !isNextPageButtonDisabled(btn), MUTE_TO_BLOCK_ITEM_TIMEOUT_MS, MUTE_TO_BLOCK_POLL_MS);
    if (!enabled) return { ok: false, reason: 'button-never-enabled' };

    // 基準値は「クリック直前」で取得する。role="status" は文字数カウンタ等の入力補助表示も
    // 兼ねていることが多く、入力反映やボタン活性化バリデーションの過程だけでも変化しうる。
    // 入力前に基準値を取ると、その変化をクリック後のエラー表示と誤認して即座に「失敗」と
    // 判定してしまう（実際にはこの後ブロックが成功していても拾えない）ため、ここで取り直す。
    const beforeStatusText = statusEl ? statusEl.textContent : '';
    const baselineLiveTexts = scanLiveRegions();

    safeExec(() => btn.click(), undefined, 'click block-add button');

    return waitForBlockAddOutcome(input, statusEl, beforeStatusText, MUTE_TO_BLOCK_ITEM_TIMEOUT_MS, baselineLiveTexts);
  }

  // M-5: done（成功済み）と failed（失敗済み）を分けて保存する。
  // 以前は成否に関わらず done に入れていたため、中断→再開すると失敗したユーザーが
  // 「処理済み」として二度とリトライされず、静かに取りこぼされていた。
  function saveMuteToBlockCheckpoint(doneSet, failedSet, successCount, failCount) {
    safeExec(() => {
      lsSet(MUTE_TO_BLOCK_CHECKPOINT_KEY, JSON.stringify({
        done: [...doneSet],
        failed: [...failedSet],
        successCount,
        failCount,
        savedAt: Date.now()
      }));
    }, undefined, 'saveMuteToBlockCheckpoint');
  }

  function loadMuteToBlockCheckpoint() {
    return safeExec(() => {
      const raw = lsGet(MUTE_TO_BLOCK_CHECKPOINT_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || !Array.isArray(obj.done) || !obj.savedAt) return null;
      if (!Array.isArray(obj.failed)) obj.failed = []; // 旧チェックポイント互換
      if (Date.now() - obj.savedAt > MUTE_TO_BLOCK_CHECKPOINT_MAX_AGE_MS) return null;
      return obj;
    }, null, 'loadMuteToBlockCheckpoint');
  }

  function clearMuteToBlockCheckpoint() {
    safe(() => localStorage.removeItem(MUTE_TO_BLOCK_CHECKPOINT_KEY));
  }

  const _muteToBlockState = { running: false, cancelRequested: false };

  // onlyLogins: 指定時はミュートリスト全体ではなくこのログイン一覧のみを対象にする
  // （M-5: 「失敗分のみ再試行」用）
  async function runMuteToBlockCrawl({ onProgress, onExclusionProgress, resumeFrom, onlyLogins } = {}) {
    // フェーズ1: 現在のブロックリストを全ページ走査し、既にブロック済みのユーザーを把握する
    const { logins: blockedLogins, cancelled: exclusionCancelled } = await collectCurrentlyBlockedLogins({
      onProgress: onExclusionProgress,
      isCancelled: () => _muteToBlockState.cancelRequested
    });
    if (exclusionCancelled) {
      return { done: new Set(), failed: new Set(), successCount: 0, failCount: 0, cancelled: true, total: 0, skippedAlreadyBlocked: 0, skippedDuringAttempts: 0, skippedNonexistent: 0 };
    }

    // 照合フェーズの実際の収集件数を可視化する（この値が明らかに少なすぎる場合、
    // 照合処理自体がまだうまく機能していない可能性があるため、目視確認できるようにする）
    showToast(`🔍 ブロックリスト照合完了：${blockedLogins.size}件を確認`, 3000);

    // フェーズ2: 対象のうち「まだブロックされていないユーザー」だけを追加対象にする
    // mutedUsers（Set）は古い順で挿入されているため、そのままだと古い順に処理してしまう。
    // パネルの「新着順」表示と同じ並び（新しくミュートした人が先頭）に合わせるため反転する。
    const allLoginsRaw = Array.isArray(onlyLogins) ? onlyLogins : [...mutedUsers].reverse();
    const skippedAlreadyBlocked = allLoginsRaw.filter(l => blockedLogins.has(l)).length;
    // 存在しないと学習済みのユーザーは最初から対象外にする（毎回失敗→再試行の繰り返し防止）
    const skippedNonexistent = new Set(allLoginsRaw.filter(l => knownNonexistentLogins.has(l)));
    const allLogins = allLoginsRaw.filter(l => !blockedLogins.has(l) && !knownNonexistentLogins.has(l));

    // M-5: done（成功）と failed（失敗）を分けて管理する。
    const done   = new Set(resumeFrom && resumeFrom.done   ? resumeFrom.done   : []);
    const failed = new Set(resumeFrom && resumeFrom.failed ? resumeFrom.failed : []);
    // 追加を試みたら「既にブロック」応答だったユーザー。失敗ではなく「除外漏れが
    // その場で判明した」ケースなので、失敗件数にも再試行対象にも入れず、
    // 学習キャッシュへ入れて次回以降は最初から除外する。
    const skippedDuringAttempts = new Set();
    let successCount = resumeFrom && Number.isFinite(resumeFrom.successCount) ? resumeFrom.successCount : 0;
    let failCount    = resumeFrom && Number.isFinite(resumeFrom.failCount)    ? resumeFrom.failCount    : 0;
    let processed = done.size + failed.size;
    let cancelled = false;

    const targets = allLogins.filter(l => !done.has(l) && !failed.has(l));
    if (onProgress) onProgress(processed, allLogins.length, successCount, failCount);

    for (const login of targets) {
      if (_muteToBlockState.cancelRequested) { cancelled = true; break; }

      const result = await addLoginToBlocklist(login);
      processed++;

      // [MTB-DIAG] 失敗理由と、このユーザーが照合フェーズの blockedLogins に
      // 含まれていたかを1件ごとに記録する。挙動は変更しない。
      // - wasInBlockedSet: false なのに失敗 → 照合フェーズでの取りこぼし（収集漏れ）
      // - wasInBlockedSet: true なのに対象に残っていた → フィルタ自体のロジック不具合
      console.log('[MTB-DIAG] attempt result', {
        login,
        ok: !!(result && result.ok),
        reason: result ? result.reason : 'no-result',
        wasInBlockedSet: blockedLogins.has(login),
        observedLiveRegionTexts: result ? result.observedLiveRegionTexts : []
      });

      // 「既にブロック」応答の判定は、失敗理由（ステータス文言）だけでなく
      // 通知領域（トースト等）に拾った文言も対象にする。
      const resultText = result
        ? [String(result.reason || ''), ...(Array.isArray(result.observedLiveRegionTexts) ? result.observedLiveRegionTexts : [])].join(' ')
        : '';
      const wasAlreadyBlocked = !!(result && !result.ok && /既にブロック|すでにブロック|already blocked/i.test(resultText));
      const wasNonexistent = !!(result && !result.ok && NONEXISTENT_PATTERN.test(resultText));

      if (result && result.ok) {
        done.add(login); successCount++;
        rememberKnownBlocked([login]); // 追加できた＝今この瞬間からブロック済み
      } else if (wasAlreadyBlocked) {
        skippedDuringAttempts.add(login);
        rememberKnownBlocked([login]); // 学習して次回から対象外にする
      } else if (wasNonexistent) {
        // 存在しないユーザーは失敗に数えず、学習して次回から対象外にする
        skippedNonexistent.add(login);
        rememberKnownNonexistent([login]);
      } else { failed.add(login); failCount++; }

      if (onProgress) onProgress(processed, allLogins.length, successCount, failCount);
      if (processed % 10 === 0) saveMuteToBlockCheckpoint(done, failed, successCount, failCount);

      await jitterDelay(MUTE_TO_BLOCK_JITTER_MS);
    }

    return { done, failed, successCount, failCount, cancelled, total: allLogins.length, skippedAlreadyBlocked, skippedDuringAttempts: skippedDuringAttempts.size, skippedNonexistent: skippedNonexistent.size };
  }

  const MUTE_TO_BLOCK_BTN_ID = 'tm-mute-to-block-btn';
  const MUTE_TO_BLOCK_BTN_DEFAULT_TEXT = 'ミュートリストをブロックに追加';

  function ensureMuteToBlockButton() {
    let btn = document.getElementById(MUTE_TO_BLOCK_BTN_ID);
    if (btn) return btn;
    btn = document.createElement('button');
    btn.id = MUTE_TO_BLOCK_BTN_ID;
    btn.type = 'button';
    btn.textContent = MUTE_TO_BLOCK_BTN_DEFAULT_TEXT;
    Object.assign(btn.style, {
      position:      'fixed',
      right:         '20px',
      bottom:        '70px', // ブロック取り込みボタンの上に重ならないよう配置
      zIndex:        '999999',
      padding:       '10px 16px',
      borderRadius:  '8px',
      border:        'none',
      background:    '#c0392b',
      color:         '#fff',
      fontSize:      '13px',
      fontFamily:    FONT_STACK_JP,
      cursor:        'pointer',
      boxShadow:     '0 4px 14px rgba(0,0,0,0.4)'
    });
    btn.addEventListener('click', onClickMuteToBlockButton);
    safe(() => document.body.appendChild(btn));
    return btn;
  }

  function removeMuteToBlockButton() {
    safe(() => {
      const btn = document.getElementById(MUTE_TO_BLOCK_BTN_ID);
      if (btn) btn.remove();
    });
  }

  async function onClickMuteToBlockButton() {
    const btn = document.getElementById(MUTE_TO_BLOCK_BTN_ID);

    // 実行中に押された → 誤クリックで直接中断させないよう確認ダイアログを挟む
    if (_muteToBlockState.running) {
      const reallyCancel = window.confirm(
        'ブロックへの追加を中断しますか？\n\n' +
        '[ OK ] 中断する（ ここまでの処理結果は保持されます ）\n' +
        '[ キャンセル ] このまま自動で続行する'
      );
      if (reallyCancel) {
        _muteToBlockState.cancelRequested = true;
        showToast('中断リクエストを受け付けました…');
      }
      return;
    }

    if (!mutedUsers.size) {
      showToast('ミュートリストが空です');
      return;
    }

    let resumeFrom = null;
    const checkpoint = loadMuteToBlockCheckpoint();
    if (checkpoint) {
      const resume = window.confirm(
        `前回の処理が ${checkpoint.done.length} 件（ 成功${checkpoint.successCount}件 / 失敗${checkpoint.failCount}件 ）で中断されています。\n` +
        `続きから再開しますか？\n\n` +
        `[ OK ] 続きから再開　/　[ キャンセル ] 最初からやり直す`
      );
      if (resume) {
        resumeFrom = checkpoint;
        showToast('続きから再開します');
      } else {
        clearMuteToBlockCheckpoint();
      }
    }

    const startConfirmed = window.confirm(
      `ミュートリスト（ ${mutedUsers.size} 件 ）とTwitch本体のブロックリストを照合し、\n` +
      `既にブロック済みのユーザーを除いた分だけを、ブロックリストへ自動で追加していきます。\n` +
      `件数によっては時間がかかります。\n\n` +
      `このタブを開いたまま進めてください。よろしいですか？`
    );
    if (!startConfirmed) return;

    _muteToBlockState.running = true;
    _muteToBlockState.cancelRequested = false;

    try {
      const { failed, successCount, failCount, cancelled, total, skippedAlreadyBlocked, skippedDuringAttempts, skippedNonexistent } = await runMuteToBlockCrawl({
        resumeFrom,
        onExclusionProgress: (page, count) => {
          if (btn) btn.textContent = `🔍 ブロックリストと照合中…（ ${page}ページ目・${count}件確認・クリックで中断 ）`;
        },
        onProgress: (processed, totalCount, s, f) => {
          if (!btn) return;
          btn.textContent = totalCount > 0
            ? `⏳ ${processed}/${totalCount} 件処理中（ 成功${s}/失敗${f}・クリックで中断 ）`
            : '✅ 追加対象なし（ 全員ブロック済み ）';
        }
      });

      if (cancelled) {
        showToast(`中断しました（ 成功${successCount}件 / 失敗${failCount}件・チェックポイント保存済み ）`);
      } else {
        const skipNote = skippedAlreadyBlocked ? `／既にブロック済みのため除外${skippedAlreadyBlocked}件` : '';
        const attemptSkipNote = skippedDuringAttempts ? `／追加中に既にブロック済みと判明し学習${skippedDuringAttempts}件` : '';
        const nonexistentNote = skippedNonexistent ? `／存在しないため除外${skippedNonexistent}件` : '';
        showToast(`✅ ブロックへの追加が完了しました（ 成功${successCount}件 / 失敗${failCount}件 / 対象${total}件${skipNote}${attemptSkipNote}${nonexistentNote} ）`, 5000);
        clearMuteToBlockCheckpoint();

        // M-5: 失敗分は「取りこぼし」にせず、その場で再試行するかを確認する。
        if (failed && failed.size > 0) {
          const retry = window.confirm(`失敗した${failed.size}件のみ、続けて再試行しますか？`);
          if (retry) {
            _muteToBlockState.cancelRequested = false;
            const retryResult = await runMuteToBlockCrawl({
              onlyLogins: [...failed],
              onExclusionProgress: (page, count) => {
                if (btn) btn.textContent = `🔍 再照合中…（ ${page}ページ目・${count}件確認・クリックで中断 ）`;
              },
              onProgress: (processed, totalCount, s, f) => {
                if (!btn) return;
                btn.textContent = `⏳ 再試行 ${processed}/${totalCount} 件（ 成功${s}/失敗${f}・クリックで中断 ）`;
              }
            });
            if (retryResult.cancelled) {
              showToast(`再試行を中断しました（ 成功${retryResult.successCount}件 / 失敗${retryResult.failCount}件 ）`);
            } else {
              showToast(`✅ 再試行完了（ 成功${retryResult.successCount}件 / 失敗${retryResult.failCount}件 ）`, 5000);
            }
          }
        }
      }
    } catch (err) {
      logWarn('mute to block failed', err);
      showToast('⚠️ 処理中にエラーが発生しました');
    } finally {
      _muteToBlockState.running = false;
      _muteToBlockState.cancelRequested = false;
      if (btn) { btn.disabled = false; btn.textContent = MUTE_TO_BLOCK_BTN_DEFAULT_TEXT; }
    }
  }

  function isMuteToBlockFeatureEnabled() {
    // v2.8: コメント設定の項目を廃止し、常時ONに変更
    return true;
  }

  function setMuteToBlockFeatureEnabled(v) {
    setFeatureEnabled(MUTE_TO_BLOCK_FEATURE_KEY, v);
  }

  function updateMuteToBlockButtonVisibility() {
    safe(() => {
      if (isBlockedUsersPage() && isMuteToBlockFeatureEnabled()) ensureMuteToBlockButton();
      else removeMuteToBlockButton();
    });
  }

  /* ================================================================
     機能ON/OFFの保存基盤
     - 切替UIはミュートリストパネル内の「コメント設定」画面に一本化した
       （旧Tampermonkeyメニューのトグルは v2.0 で撤去）
     - 各機能のデフォルト値は「これまでの既定動作」を壊さない値にしている
       （ミュートリストをブロックに追加＝自動書き込みを伴うため唯一デフォルトOFF）
  ================================================================ */
  function isFeatureEnabled(key, defaultOn) {
    return safe(() => {
      const raw = lsGet(key);
      if (raw === null) return defaultOn; // 未設定＝初回インストール直後はデフォルト値を使う
      return raw === '1';
    }, defaultOn);
  }

  function setFeatureEnabled(key, v) {
    safe(() => lsSet(key, v ? '1' : '0'));
  }

  function isQuestionMarkHideEnabled() { return isFeatureEnabled(QUESTION_MARK_HIDE_KEY, true); }
  function setQuestionMarkHideEnabled(v) { setFeatureEnabled(QUESTION_MARK_HIDE_KEY, v); }

  function isCommunityHighlightHideEnabled() { return isFeatureEnabled(COMMUNITY_HIGHLIGHT_HIDE_KEY, true); }
  function setCommunityHighlightHideEnabled(v) { setFeatureEnabled(COMMUNITY_HIGHLIGHT_HIDE_KEY, v); }

  function isLongPressCopyEnabled() { return isFeatureEnabled(LONG_PRESS_COPY_KEY, true); }
  function setLongPressCopyEnabled(v) { setFeatureEnabled(LONG_PRESS_COPY_KEY, v); }

  /* ================================================================
     過去発言の記録と、名前の右クリックメニュー
     - この配信で見たコメントをユーザーごとに記録する（メモリのみ、配信が変わるとリセット）
     - チャットの名前を右クリックすると「ミュート / 過去発言」メニューを出す
       （既存のミュート方法はそのまま残し、メニューは追加の入口）
  ================================================================ */
  const commentHistory = new Map(); // login -> { display, items: [{t, text}] }
  const HISTORY_PER_USER = 30;
  const HISTORY_MAX_USERS = 400;
  function recordCommentHistory(login, display, text) {
    if (!login || !text || !text.trim()) return;
    let e = commentHistory.get(login);
    if (!e) {
      e = { display: display || login, items: [] };
      commentHistory.set(login, e);
      if (commentHistory.size > HISTORY_MAX_USERS) {
        const oldest = commentHistory.keys().next().value;
        if (oldest !== login) commentHistory.delete(oldest);
      }
    }
    e.display = display || e.display;
    e.items.push({ t: Date.now(), text: text.trim() });
    if (e.items.length > HISTORY_PER_USER) e.items.splice(0, e.items.length - HISTORY_PER_USER);
  }

  let _ctxMenu = null;
  let _historyPopup = null;
  function closeUserCtxMenu() { if (_ctxMenu) { _ctxMenu.remove(); _ctxMenu = null; } }
  function closeHistoryPopup() { if (_historyPopup) { _historyPopup.remove(); _historyPopup = null; } }

  function showHistoryPopup(x, y, login) {
    closeHistoryPopup();
    const e = commentHistory.get(login);
    const pop = document.createElement('div');
    pop.id = 'tm-history-popup';
    const head = document.createElement('div');
    head.className = 'tm-history-head';
    head.textContent = e ? e.display : login;
    pop.appendChild(head);
    const list = document.createElement('div');
    list.className = 'tm-history-list';
    if (!e || !e.items.length) {
      const d = document.createElement('div');
      d.className = 'tm-history-item';
      d.textContent = '記録なし';
      list.appendChild(d);
    } else {
      e.items.forEach(it => {
        const d = document.createElement('div');
        d.className = 'tm-history-item';
        const time = document.createElement('span');
        time.className = 'tm-history-time';
        const dt = new Date(it.t);
        time.textContent = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
        const tx = document.createElement('span');
        tx.textContent = it.text;
        d.appendChild(time);
        d.appendChild(tx);
        list.appendChild(d);
      });
    }
    pop.appendChild(list);
    pop.style.left = `${Math.max(4, Math.min(x, window.innerWidth - 300))}px`;
    pop.style.top = `${Math.max(4, Math.min(y, window.innerHeight - 300))}px`;
    document.body.appendChild(pop);
    _historyPopup = pop;
    list.scrollTop = list.scrollHeight;
  }

  function showUserCtxMenu(x, y, login, display) {
    closeUserCtxMenu();
    closeHistoryPopup();
    const menu = document.createElement('div');
    menu.id = 'tm-ctx-menu';
    const mkItem = (label, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tm-ctx-item';
      b.textContent = label;
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeUserCtxMenu();
        safe(fn);
      });
      return b;
    };
    if (mutedUsers.has(login)) {
      menu.appendChild(mkItem('ミュート解除', () => {
        confirmUnmuteUser(login);
        if (panelElem) renderPage();
        safe(() => syncAllExistingChatRows());
      }));
    } else {
      menu.appendChild(mkItem('ミュートする', () => {
        const e = commentHistory.get(login);
        const last = e && e.items.length ? e.items[e.items.length - 1].text : null;
        muteUser(login, display, last);
      }));
    }
    menu.appendChild(mkItem('過去発言を見る', () => showHistoryPopup(x, y, login)));
    menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - 170))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - 110))}px`;
    document.body.appendChild(menu);
    _ctxMenu = menu;
  }

  function initUserContextMenu() {
    document.addEventListener('contextmenu', (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      // 名前（またはその行）の上だけで標準メニューを差し替える
      const nameEl = t.closest('.chat-author__display-name, [data-a-user]');
      const row = t.closest(CHAT_SEL);
      if (!row) return;
      if (!nameEl && !t.closest('[data-a-target="chat-line-message"]')) return;
      const info = safe(() => getRowUser(row), null);
      if (!info || !info.login) return;
      e.preventDefault();
      showUserCtxMenu(e.clientX, e.clientY, info.login, info.display);
    });
    document.addEventListener('pointerdown', (e) => {
      if (_ctxMenu && !_ctxMenu.contains(e.target)) closeUserCtxMenu();
      if (_historyPopup && !_historyPopup.contains(e.target)) closeHistoryPopup();
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeUserCtxMenu(); closeHistoryPopup(); }
    });
  }

  function onNavigate() {
    safeExec(() => { if (globalMuteButton && globalMuteButton.parentElement) globalMuteButton.remove(); }, undefined, 'nav btn cleanup');
    safe(() => { commentHistory.clear(); closeUserCtxMenu(); closeHistoryPopup(); });
    currentHoverRow     = null;
    currentHoverLogin   = null;
    currentHoverDisplay = null;
    // SPA 遷移時に短命キャッシュをクリア（前のページのDOM参照が残らないように）
    if (ensureMutedDisplays._cache) ensureMutedDisplays._cache = null;
    setTimeout(findAndSetupChatContainer, 500);
    setTimeout(findAndSetupChatContainer, 1500);
    setTimeout(sweepExistingVodMessages,  800);
    setTimeout(sweepExistingVodMessages, 2000);
    setTimeout(repositionSettingBtn, 2000);
    setTimeout(repositionSettingBtn, 4000);
    setTimeout(startLeaderboardWatcher, 1000);
    setTimeout(applyCustomHiddenRules, 1200);
    setTimeout(applyCustomHiddenRules, 3000);
    updateBlockedImportButtonVisibility();
    updateMuteToBlockButtonVisibility();
  }

  safe(() => {
    const _origPush    = history.pushState.bind(history);
    const _origReplace = history.replaceState.bind(history);
    history.pushState    = (...args) => { _origPush(...args);    onNavigate(); };
    history.replaceState = (...args) => { _origReplace(...args); onNavigate(); };
  });
  window.addEventListener('popstate', onNavigate);
  window.addEventListener('resize', scheduleSettingBtnReposition);
  initUserContextMenu();
  initShortcuts();
  initPanelSideButtons();

  setInterval(() => { if (isVodPage()) sweepExistingVodMessages(); }, VOD_SWEEP_MS);

  findAndSetupChatContainer();
  setTimeout(sweepExistingVodMessages,  500);
  setTimeout(sweepExistingVodMessages, 1500);

  updateBlockedImportButtonVisibility();
  updateMuteToBlockButtonVisibility();

  // チャンネルポイントボーナスの自動回収（常時ON）：定期的に宝箱ボタンを探して押す
  setInterval(tryClickChannelPointBonus, 4000);
  setTimeout(tryClickChannelPointBonus, 2500);

  // 弾幕ボタンがSPA再描画で消えたら戻す
  setInterval(() => { if (!document.getElementById('tm-danmaku-btn')) ensureDanmakuButton(); }, 2500);
  setTimeout(ensureDanmakuButton, 1500);

  // ボーナスサブ / channel-skins バナーを CSSで一括非表示（以前の setInterval ループは不要）
  // → これはもうスタイルシート側の [data-test-selector*="channel-skins"] でカバーされているため、スクリプトレベルでの処理は不要

})();