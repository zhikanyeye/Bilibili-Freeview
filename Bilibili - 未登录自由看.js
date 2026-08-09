// ==UserScript==
// @name         Bilibili - 未登录自由看
// @namespace    https://bilibili.com/
// @version      4.0.0-alpha.26
// @description  B站未登录观看增强：高清画质、只读评论、倍速、前进后退、防自动暂停和直播分区连续加载。
// @license      GPL-3.0
// @author       zhikanyeye
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/list/*
// @match        https://www.bilibili.com/festival/*
// @match        https://www.bilibili.com/opus/*
// @match        https://www.bilibili.com/read/cv*
// @match        https://t.bilibili.com/*
// @match        https://space.bilibili.com/*
// @match        https://live.bilibili.com/*
// @icon         https://www.bilibili.com/favicon.ico
// @require      https://cdnjs.cloudflare.com/ajax/libs/spark-md5/3.0.2/spark-md5.min.js
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @run-at       document-start
// ==/UserScript==

(async function () {
  'use strict';

  // 最早保存原生 fetch，避免后续自劫持互相递归
  const nativePageFetch = (unsafeWindow.fetch || fetch).bind(unsafeWindow);

  /* ========== 0. 公共配置 ========== */
  const CONFIG = {
    QUALITY_CHECK_INTERVAL: 1500,
    PLAYER_CHECK_INTERVAL: 300,
    QUALITY_SWITCH_DELAY: 5000,
    BUTTON_CLICK_DELAY: 800,
    TOAST_CHECK_INTERVAL: 100,
    CLICK_TIMEOUT: 800,
    AUTO_RESUME_INTERVAL: 1200,
    TRIAL_TIMEOUT: 3e8,
    // 兜底拔高配置（fallback 内使用）
    RE_UNLOCK_DELAY: 5000,
    RE_UNLOCK_INTERVAL: 3000
  };

  const options = {
    preferQuality: GM_getValue('preferQuality', '1080'),
    isWaitUntilHighQualityLoaded: GM_getValue('isWaitUntilHighQualityLoaded', false),
    enableCommentUnlock: GM_getValue('enableCommentUnlock', true),
    enableReplyPagination: GM_getValue('enableReplyPagination', false),
    enableLiveAreaUnlock: GM_getValue('enableLiveAreaUnlock', true),
    enableProtocolUnlock: GM_getValue('enableProtocolUnlock', true),  // false 时回退旧客户端架构
    playbackRate: Number(GM_getValue('playbackRate', 1)) || 1,
    customPlaybackRate: Number(GM_getValue('customPlaybackRate', 1.5)) || 1.5,
    enablePlaybackRateControl: GM_getValue('enablePlaybackRateControl', true),
    seekBackwardSeconds: Math.max(1, Math.min(300, Math.round(Number(GM_getValue('seekBackwardSeconds', 10)) || 10))),
    seekForwardSeconds: Math.max(1, Math.min(300, Math.round(Number(GM_getValue('seekForwardSeconds', 15)) || 15))),
    holdPlaybackRate: Math.max(1, Math.min(16, Number(GM_getValue('holdPlaybackRate', 2)) || 2))
  };

  // 菜单需在其他模块之前注册，避免页面初始化异常或登录分支影响设置入口。
  installSettingsPanel();

  const PAGE_RE = {
    video: /^https:\/\/www\.bilibili\.com\/video\//,
    dynamic: /^https:\/\/t\.bilibili\.com\/\d+/,
    opus: /^https:\/\/www\.bilibili\.com\/opus\/\d+/,
    space: /^https:\/\/space\.bilibili\.com\/\d+/,
    article: /^https:\/\/www\.bilibili\.com\/read\/cv\d+/,
    festival: /^https:\/\/www\.bilibili\.com\/festival\//,
    list: /^https:\/\/www\.bilibili\.com\/list\//,
    live: /^https:\/\/live\.bilibili\.com\//
  };

  function isPlaybackPage() {
    return PAGE_RE.video.test(location.href)
      || PAGE_RE.festival.test(location.href)
      || PAGE_RE.list.test(location.href);
  }

  /* ========== 工具函数 ========== */
  function waitForElement(selector, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const element = document.querySelector(selector);
      if (element) return resolve(element);

      const root = document.body || document.documentElement;
      if (!root) {
        reject(new Error(`等待元素失败: 无 document root`));
        return;
      }

      const observer = new MutationObserver((_mutations, obs) => {
        const el = document.querySelector(selector);
        if (el) {
          obs.disconnect();
          resolve(el);
        }
      });
      observer.observe(root, { childList: true, subtree: true });

      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`等待元素超时: ${selector}`));
      }, timeout);
    });
  }

  // 延迟函数
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function isBilibiliLoggedIn() {
    return document.cookie.includes('DedeUserID__ckMd5=') && /\S/.test(document.cookie.match(/DedeUserID__ckMd5=([^;]+)/)?.[1] || '');
  }

  // 注入伪造 DedeUserID 让服务端按登录态响应。ckMd5 带签名不可伪造，故 isBilibiliLoggedIn 校验它。
  let _fakeDedeUserId = '';
  function ensureFakeLoginCookie() {
    if (document.cookie.match(/DedeUserID__ckMd5=([^;]+)/)?.[1]) return;
    const currentUid = document.cookie.match(/(?:^|;\s*)DedeUserID=([^;]+)/)?.[1] || '';
    if (!_fakeDedeUserId) _fakeDedeUserId = currentUid || String(Math.floor(Math.random() * 1e10));
    if (currentUid !== _fakeDedeUserId) {
      document.cookie = `DedeUserID=${_fakeDedeUserId}; path=/; domain=.bilibili.com`;
    }
  }

  // 拦 top/feed/rcmd 前清 buvid3，避免 B 站按游客跟踪触发登录弹窗（DD1969 思路）
  let rcmdGuardInstalled = false;
  function installRcmdLoginGuard() {
    if (rcmdGuardInstalled || isBilibiliLoggedIn()) return;
    rcmdGuardInstalled = true;
    const originFetch = unsafeWindow.fetch?.bind(unsafeWindow);
    if (!originFetch) return;
    unsafeWindow.fetch = function(input, init) {
      const rawUrl = typeof input === 'string' ? input : (input?.url ?? '');
      if (rawUrl && rawUrl.includes('top/feed/rcmd')) {
        document.cookie = 'buvid3=;expires=Thu, 01 Jan 1970 00:00:01 GMT;domain=.bilibili.com;path=/';
      }
      return originFetch(input, init);
    };
  }

  // 吞掉 SSR 写入的低质 __playinfo__，只接受 writePlayinfo 写入的高清数据
  let _playinfoCache = null;
  let _playinfoWriteAllow = false;
  let _playinfoKey = ''; // aid_cid，避免 SPA 切视频串流
  let _videoGeneration = 0;
  function clearPlayinfoSSR() {
    try {
      _playinfoCache = null;
      _playinfoKey = '';
      Object.defineProperty(unsafeWindow, '__playinfo__', {
        get: () => _playinfoCache,
        set: (v) => { if (_playinfoWriteAllow) _playinfoCache = v; },
        configurable: true
      });
      const s = document.createElement('script');
      s.textContent = 'window.playurlSSRData = {}';
      document.documentElement.appendChild(s);
      document.documentElement.removeChild(s);
    } catch (e) {
      try { unsafeWindow.__playinfo__ = null; } catch (e2) {}
    }
  }

  function getPlayurlRequestKey(rawUrl) {
    try {
      const u = new URL(rawUrl, location.href);
      const aid = u.searchParams.get('avid') || u.searchParams.get('aid') || '';
      const cid = u.searchParams.get('cid') || '';
      const bvid = u.searchParams.get('bvid') || '';
      const pgcId = u.searchParams.get('ep_id') || u.searchParams.get('season_id') || '';
      const mediaId = bvid || aid || pgcId;
      return mediaId || cid ? `${mediaId}_${cid}` : '';
    } catch (e) {
      return '';
    }
  }

  function isPlayurlRequestUrl(rawUrl) {
    if (!rawUrl) return false;
    return rawUrl.includes('/x/player/wbi/playurl')
      || rawUrl.includes('/x/player/playurl')
      || rawUrl.includes('/pgc/player/web/playurl')
      || rawUrl.includes('/pgc/player/web/v2/playurl');
  }

  function getUrlBvid() {
    try {
      return location.pathname.match(/BV[\w]+/i)?.[0] || '';
    } catch (e) {
      return '';
    }
  }

  function getVideoIdsFromState() {
    try {
      const state = unsafeWindow.__INITIAL_STATE__ || {};
      const aid = String(state.aid || state.videoData?.aid || state.videoData?.id || '');
      const cid = String(state.cid || state.videoData?.cid || state.player?.cid || state.videoData?.pages?.[0]?.cid || '');
      const bvid = String(state.bvid || state.videoData?.bvid || '');
      return { aid, cid, bvid };
    } catch (e) {
      return { aid: '', cid: '', bvid: getUrlBvid() };
    }
  }

  function getCurrentVideoKey() {
    try {
      const { aid, cid, bvid } = getVideoIdsFromState();
      const urlBvid = getUrlBvid();
      if (aid || bvid || urlBvid || cid) return `${urlBvid || bvid || aid}_${cid}`;
    } catch (e) {}
    try {
      const bv = getUrlBvid();
      return bv ? `${bv}_` : location.pathname;
    } catch (e) {
      return location.pathname;
    }
  }

  // URL 中的 BV 已变且 state 尚未跟上时返回 true
  function isStateStaleForUrl() {
    try {
      const urlBv = getUrlBvid();
      if (!urlBv) return false;
      const { bvid, aid, cid } = getVideoIdsFromState();
      if (!bvid || bvid.toUpperCase() !== urlBv.toUpperCase()) return true;
      if (!cid && !aid) return true;
      return false;
    } catch (e) {
      return false;
    }
  }

  function waitForVideoStateReady(timeout = 5000, interval = 100) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (!isStateStaleForUrl()) {
          const ids = getVideoIdsFromState();
          if (ids.cid && (ids.aid || ids.bvid)) {
            resolve(ids);
            return;
          }
        }
        if (Date.now() - start >= timeout) {
          resolve(getVideoIdsFromState());
          return;
        }
        setTimeout(tick, interval);
      };
      tick();
    });
  }

  async function resolveCurrentVideoIds() {
    const urlBvid = getUrlBvid();
    const stateIds = getVideoIdsFromState();
    if (!urlBvid || (stateIds.bvid && stateIds.bvid.toUpperCase() === urlBvid.toUpperCase() && stateIds.cid)) {
      return stateIds;
    }

    try {
      const res = await nativePageFetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(urlBvid)}`, {
        credentials: 'include'
      });
      const json = await res.json();
      const data = json?.data;
      if (json?.code !== 0 || !data) return { aid: '', cid: '', bvid: urlBvid };
      const page = Math.max(1, Number(new URL(location.href).searchParams.get('p') || 1));
      const pageInfo = Array.isArray(data.pages) ? data.pages[page - 1] || data.pages[0] : null;
      return {
        aid: String(data.aid || ''),
        cid: String(pageInfo?.cid || data.cid || ''),
        bvid: String(data.bvid || urlBvid)
      };
    } catch (e) {
      return { aid: '', cid: '', bvid: urlBvid };
    }
  }

  // 同步 localStorage 默认画质，避免 SPA 切片后按 16/360 初始化
  function patchPlayerProfileQuality() {
    try {
      const qn = getTargetQn();
      const key = 'bpx_player_profile';
      let profile = {};
      try { profile = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (e) { profile = {}; }
      if (!profile.media) profile.media = {};
      if (profile.media.quality !== qn || profile.media.qualityMark !== 'auto') {
        profile.media.quality = qn;
        profile.media.qualityMark = 'auto';
        localStorage.setItem(key, JSON.stringify(profile));
      }
    } catch (e) {}
  }

  // 强制切到目标画质（协议级也走，避免卡在 480/360）
  function forcePlayerTargetQuality(reason = 'protocol') {
    try {
      const map = { 1080: 80, 720: 64, 480: 32, 360: 16 };
      const target = map[options.preferQuality] || 80;
      const player = unsafeWindow.player;
      if (!player) return false;

      // 部分版本优先 setQuality
      if (typeof player.setQuality === 'function') {
        Promise.resolve(player.setQuality(target)).catch(() => {});
      }

      if (typeof player.requestQuality === 'function') {
        const supported = player.getSupportedQualityList?.();
        let qn = target;
        if (Array.isArray(supported) && supported.length) {
          if (supported.includes(target)) qn = target;
          else {
            const lower = supported.filter(q => q <= target);
            qn = lower.length ? Math.max(...lower) : Math.max(...supported);
          }
        }
        Promise.resolve(player.requestQuality(qn)).catch(() => {});
      } else if (typeof player.setQuality !== 'function') {
        return false;
      }

      // 写入高清流后，部分场景需 reload 媒体源才能真正切档
      try {
        const cur = player.getCurrentQuality?.();
        if (cur != null && cur < target && typeof player.reload === 'function') {
          // 仅在持续低档时 reload，避免频繁打断
          if (!player.__bfqReloadAt || Date.now() - player.__bfqReloadAt > 4000) {
            player.__bfqReloadAt = Date.now();
            Promise.resolve(player.reload()).catch(() => {});
          }
        }
      } catch (e) {}

      return true;
    } catch (e) {
      return false;
    }
  }

  function scheduleForceQuality(times = 12, gap = 500) {
    let n = 0;
    const tick = () => {
      forcePlayerTargetQuality('retry-' + n);
      n += 1;
      if (n < times) setTimeout(tick, gap);
    };
    setTimeout(tick, 80);
  }

  function maxQnOfPlayurl(json) {
    try {
      const d = json?.data;
      if (!d) return 0;
      if (d.dash?.video?.length) return Math.max(...d.dash.video.map(v => v.id || 0));
      if (Array.isArray(d.accept_quality) && d.accept_quality.length) return Math.max(...d.accept_quality);
      return d.quality || 0;
    } catch (e) {
      return 0;
    }
  }

  function pickPlayablePlayurl(...candidates) {
    const playable = candidates.filter(hasPlayableMedia);
    if (!playable.length) return null;
    const unrestricted = playable.filter(candidate => {
      const data = candidate?.data || {};
      return data.isPreview !== 1 && data.preview !== 1 && data.need_login !== 1 && data.need_login !== true;
    });
    if (!unrestricted.length) return null;
    return unrestricted.reduce((best, candidate) =>
      maxQnOfPlayurl(candidate) >= maxQnOfPlayurl(best) ? candidate : best
    );
  }

  async function proactiveRefetchPlayurl(reason = 'spa', forcedIds = null, generation = _videoGeneration) {
    if (!options.enableProtocolUnlock || isBilibiliLoggedIn()) return false;
    try {
      ensureFakeLoginCookie();
      patchPlayerProfileQuality();

      let aid, cid, bvid;
      if (forcedIds?.cid && (forcedIds.aid || forcedIds.bvid)) {
        ({ aid, cid, bvid } = forcedIds);
      } else {
        // SPA 切片后 state 常滞后，先等到 URL 与 state 对齐
        await waitForVideoStateReady(1200, 80);
        const ready = await resolveCurrentVideoIds();
        aid = ready.aid;
        cid = ready.cid;
        bvid = ready.bvid;
      }
      if (generation !== _videoGeneration) return false;
      if (!cid || (!aid && !bvid)) {
        console.warn('[Bilibili脚本] 主动重签跳过：缺少 aid/cid', reason, { aid, cid, bvid });
        return false;
      }

      const params = {
        fnval: '4048',
        fourk: '1',
        qn: String(getTargetQn()),
        try_look: '1',
        platform: 'pc',
        high_quality: '1',
        is_html5: '1',
        cid: String(cid)
      };
      if (aid) params.avid = String(aid);
      if (bvid) params.bvid = String(bvid);

      const qs = await getWbiQueryString(params);
      const rawUrl = `https://api.bilibili.com/x/player/wbi/playurl?${qs}`;
      const res = await nativePageFetch(rawUrl, { credentials: 'include', method: 'GET' });
      let json = await parseFetchResponseJson(res);
      if (generation !== _videoGeneration) return false;

      if (isTrialOnlyPlayurl(json)) {
        const params2 = { ...params };
        delete params2.try_look;
        const qs2 = await getWbiQueryString(params2);
        const res2 = await nativePageFetch(`https://api.bilibili.com/x/player/wbi/playurl?${qs2}`, {
          credentials: 'include',
          method: 'GET'
        });
        const json2 = await parseFetchResponseJson(res2);
        if (generation !== _videoGeneration) return false;
        json = pickPlayablePlayurl(json, json2);
      }

      if (hasPlayableMedia(json)) {
        json = normalizePlayurlQuality(json);
        const reqKey = `${bvid || aid}_${cid}`;
        if (generation !== _videoGeneration) return false;
        writePlayinfo(json, reqKey, generation);
        scheduleForceQuality(12, 350);
        console.log('[Bilibili脚本] 主动重签 playurl 成功:', reason, reqKey, 'qn=', json?.data?.quality);
        return true;
      }
    } catch (e) {
      console.warn('[Bilibili脚本] 主动重签 playurl 失败:', reason, e);
    }
    return false;
  }

  // 把高清 playinfo 推给已存在的 player 实例（SPA 切片关键）
  function applyHighQualityToPlayer(json, reason = '') {
    try {
      if (!json || json.code !== 0) return;
      const player = unsafeWindow.player;
      if (!player) return;
      const target = getTargetQn();
      const payload = json.data || json;

      // 常见内部入口：updatePlayurl / setPlayurl / reloadMedia
      const candidates = [
        'updatePlayurl',
        'setPlayurl',
        'setPlayInfo',
        'updateMediaData',
        'reloadMediaData',
        'setMediaData',
        'core_updatePlayurl',
        'core_setPlayurl'
      ];
      for (const name of candidates) {
        if (typeof player[name] === 'function') {
          try {
            Promise.resolve(player[name](payload)).catch(() => {});
            console.log('[Bilibili脚本] 已调用 player.' + name, reason);
            break;
          } catch (e) {}
        }
      }

      // 部分版本把 playurl 挂在 player 内部 store
      try {
        if (player.core && typeof player.core.updatePlayurl === 'function') {
          Promise.resolve(player.core.updatePlayurl(payload)).catch(() => {});
        }
      } catch (e) {}

      if (typeof player.setQuality === 'function') {
        Promise.resolve(player.setQuality(target)).catch(() => {});
      }
      if (typeof player.requestQuality === 'function') {
        Promise.resolve(player.requestQuality(target)).catch(() => {});
      }

      // 若仍低档，延迟再推一轮（给 SPA 播放器换源时间）
      setTimeout(() => {
        try {
          const cur = player.getCurrentQuality?.();
          if (cur != null && cur < target) {
            if (typeof player.requestQuality === 'function') {
              Promise.resolve(player.requestQuality(target)).catch(() => {});
            }
            if (typeof player.setQuality === 'function') {
              Promise.resolve(player.setQuality(target)).catch(() => {});
            }
          }
        } catch (e) {}
      }, 600);
    } catch (e) {}
  }

  let _spaResetToken = 0;
  function resetPlayinfoForNewVideo(reason = 'spa') {
    const token = ++_spaResetToken;
    const generation = ++_videoGeneration;
    _playinfoCache = null;
    _playinfoKey = '';
    ensureFakeLoginCookie();
    patchPlayerProfileQuality();
    try {
      Object.defineProperty(unsafeWindow, '__playinfo__', {
        get: () => _playinfoCache,
        set: (v) => { if (_playinfoWriteAllow) _playinfoCache = v; },
        configurable: true
      });
    } catch (e) {}
    try {
      const s = document.createElement('script');
      s.textContent = 'window.playurlSSRData = {}; try { window.__playinfo__ = null; } catch (e) {}';
      document.documentElement.appendChild(s);
      document.documentElement.removeChild(s);
    } catch (e) {
      try { unsafeWindow.__playinfo__ = null; } catch (e2) {}
    }

    // 等待 state 对齐后再重签，避免用旧 aid/cid 抢跑
    const run = async (tag) => {
      if (token !== _spaResetToken) return;
      await proactiveRefetchPlayurl(tag, null, generation);
      if (token !== _spaResetToken) return;
      scheduleForceQuality(10, 400);
    };

    run(reason);
    setTimeout(() => run(reason + '-delay1'), 700);
    setTimeout(() => run(reason + '-delay2'), 1800);
    setTimeout(() => {
      if (token !== _spaResetToken) return;
      scheduleForceQuality(8, 600);
    }, 3500);
    console.log('[Bilibili脚本] 视频切换，清理 playinfo 并强制目标画质:', reason, getCurrentVideoKey());
  }

  // SPA 切视频：history + pathname + aid/cid 三保险
  function installSpaPlayinfoReset() {
    let lastVideoKey = getCurrentVideoKey();
    let lastPath = location.pathname;
    let lastHref = location.href;

    const triggerSwitch = (reason) => {
      const key = getCurrentVideoKey();
      const path = location.pathname;
      const href = location.href;
      // path/href 变了，或 aid/cid 变了，都算切片
      const pathChanged = path !== lastPath || href !== lastHref;
      const keyChanged = key && key !== lastVideoKey;
      if (!pathChanged && !keyChanged) return;
      lastPath = path;
      lastHref = href;
      lastVideoKey = key || lastVideoKey;
      resetPlayinfoForNewVideo(reason);
    };

    const wrapHistory = (type) => {
      const origin = history[type];
      if (typeof origin !== 'function' || origin.__bfqPatched) return;
      const wrapped = function (...args) {
        const beforePath = location.pathname;
        const beforeKey = getCurrentVideoKey();
        const ret = origin.apply(this, args);
        // URL 可能已变，state 延迟；立即清缓存并调度重签
        setTimeout(() => {
          const afterPath = location.pathname;
          const afterKey = getCurrentVideoKey();
          if (afterPath !== beforePath || afterKey !== beforeKey) {
            lastPath = afterPath;
            lastHref = location.href;
            lastVideoKey = afterKey || beforeKey;
            resetPlayinfoForNewVideo(type);
          }
        }, 0);
        return ret;
      };
      wrapped.__bfqPatched = true;
      history[type] = wrapped;
    };

    try {
      wrapHistory('pushState');
      wrapHistory('replaceState');
      window.addEventListener('popstate', () => triggerSwitch('popstate'));
    } catch (e) {}

    // pathname / aid / cid 轮询（推荐栏点视频有时不触发完整 history 语义）
    setInterval(() => {
      try {
        if (!isPlaybackPage()) return;
        triggerSwitch('poll-watch');
      } catch (e) {}
    }, 400);
  }

  // 协议级开启时也装：试用按钮点击 + 画质掉落监听 + SPA 切视频检测
  function installAlwaysQualityGuard() {
    if (isBilibiliLoggedIn()) return;
    if (!isPlaybackPage()) return;

    let dropStarted = false;
    let lastRefetchAt = 0;
    const startDropWatcher = () => {
      if (dropStarted) return;
      dropStarted = true;
      setInterval(() => {
        try {
          const target = getTargetQn();
          const player = unsafeWindow.player;
          const cur = player?.getCurrentQuality?.();
          const supported = player?.getSupportedQualityList?.();
          if (cur == null) return;

          // 菜单已有 1080 但当前仍是 360：说明流未真正切档
          const stuckLow = cur < target;
          const menuHasTarget = Array.isArray(supported) && supported.includes(target);

          if (stuckLow) {
            forcePlayerTargetQuality(menuHasTarget ? 'drop-exact' : 'drop-watch');
            // 持续卡低档时主动重签 playurl（节流）
            if (Date.now() - lastRefetchAt > 5000 && options.enableProtocolUnlock) {
              lastRefetchAt = Date.now();
              proactiveRefetchPlayurl('drop-stuck');
            }
          }
        } catch (e) {}
      }, CONFIG.RE_UNLOCK_INTERVAL);
    };

    const observeTrialButton = () => {
      const observer = new MutationObserver(() => {
        const btn = document.querySelector('.bpx-player-toast-confirm-login');
        if (!btn || btn.dataset.bfqClicked) return;
        btn.dataset.bfqClicked = '1';
        setTimeout(() => {
          try { btn.click(); } catch (e) {}
          scheduleForceQuality(10, 600);
          startDropWatcher();
          setTimeout(() => delete btn.dataset.bfqClicked, 2000);
        }, CONFIG.BUTTON_CLICK_DELAY);
      });
      const root = document.body || document.documentElement;
      if (root) observer.observe(root, { childList: true, subtree: true });
    };

    if (document.body) observeTrialButton();
    else document.addEventListener('DOMContentLoaded', observeTrialButton, { once: true });

    // 播放器就绪后立即拔高 + 掉落监听
    const waitPlayer = setInterval(() => {
      const player = unsafeWindow.player;
      if (player && (player.requestQuality || player.setQuality)) {
        clearInterval(waitPlayer);
        patchPlayerProfileQuality();
        scheduleForceQuality(10, 600);
        startDropWatcher();
      }
    }, 300);
    setTimeout(() => clearInterval(waitPlayer), 30000);

    // 媒体质量事件 / 播放开始时再强制一次
    const bindMediaQualityHook = () => {
      try {
        const media = unsafeWindow.player?.mediaElement?.();
        if (!media || media.dataset.bfqQualityHook) return;
        media.dataset.bfqQualityHook = '1';
        const reforce = () => {
          scheduleForceQuality(6, 400);
          if (options.enableProtocolUnlock) {
            const cur = unsafeWindow.player?.getCurrentQuality?.();
            if (cur != null && cur < getTargetQn() && Date.now() - lastRefetchAt > 3000) {
              lastRefetchAt = Date.now();
              proactiveRefetchPlayurl('media-event');
            }
          }
        };
        media.addEventListener('play', reforce, true);
        media.addEventListener('loadeddata', reforce, true);
        media.addEventListener('loadedmetadata', reforce, true);
      } catch (e) {}
    };
    setInterval(bindMediaQualityHook, 1000);
  }

  // 获取视频AID
  function getVideoOid() {
    try {
      const initialState = unsafeWindow.__INITIAL_STATE__;
      if (initialState?.aid) return initialState.aid;
      if (initialState?.videoData?.aid) return initialState.videoData.aid;
    } catch (e) {}
    
    const aidElement = document.querySelector('[data-aid]');
    if (aidElement) return aidElement.dataset.aid;
    
    return null;
  }

  /* ========== 评论模块 ========== */
  let commentOid, commentType, commentCreatorID;
  let commentCurrentSortType = 2;
  let commentIsLoading = false;
  let commentIsEnd = false;
  let commentNextOffset = '';
  let commentPageOffsets = [''];
  let commentCurrentPage = 0;
  let commentTotalCount = 0;
  let commentGeneration = 0;
  let commentAbortController = null;
  const COMMENT_SORT = { LATEST: 0, HOT: 2 };
  const COMMENT_PAGE_SIZE = 20;

  let _wbiMixinKey = null;
  let _wbiMixinKeyTs = 0;
  let _wbiMixinKeyPromise = null;
  async function getWbiMixinKey() {
    if (_wbiMixinKey && Date.now() - _wbiMixinKeyTs < 3600e3) return _wbiMixinKey;
    if (_wbiMixinKeyPromise) return _wbiMixinKeyPromise;
    _wbiMixinKeyPromise = (async () => {
      const navJson = await nativePageFetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' })
        .then(res => res.json())
        .catch(() => null);
      // 未登录时 nav 返回 code=-101，但 data.wbi_img 仍是有效的 WBI 签名材料。
      const wbiImg = navJson?.data?.wbi_img || null;
      if (!wbiImg?.img_url || !wbiImg?.sub_url) return null;
      const { img_url, sub_url } = wbiImg;
      const imgKey = img_url.slice(img_url.lastIndexOf('/') + 1, img_url.lastIndexOf('.'));
      const subKey = sub_url.slice(sub_url.lastIndexOf('/') + 1, sub_url.lastIndexOf('.'));
      const originKey = imgKey + subKey;
      if (originKey.length < 64) return null;
      const mixinKeyEncryptTable = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
      _wbiMixinKey = mixinKeyEncryptTable.map(n => originKey[n]).join('').slice(0, 32);
      _wbiMixinKeyTs = Date.now();
      return _wbiMixinKey;
    })();
    try {
      return await _wbiMixinKeyPromise;
    } finally {
      _wbiMixinKeyPromise = null;
    }
  }

  async function getWbiQueryString(params) {
    const mixinKey = await getWbiMixinKey();
    if (!mixinKey) throw new Error('无法获取 WBI mixin key');
    const p = { ...params };
    delete p.w_rid;
    p.wts = Math.round(Date.now() / 1000);
    const query = Object.keys(p).sort().map(key => {
      const value = p[key].toString().replace(/[!'()*]/g, '');
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    }).join('&');
    const wbiSign = SparkMD5.hash(query + mixinKey);
    return query + '&w_rid=' + wbiSign;
  }

  function b2a(bvid) {
    const XOR_CODE = 23442827791579n;
    const MASK_CODE = 2251799813685247n;
    const BASE = 58n;
    const ALPHABET = 'FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf'.split('');
    const DIGIT_MAP = [0,1,2,9,7,5,6,4,8,3,10,11];
    const BV_LEN = 12;
    let r = 0n;
    for (let i = 3; i < BV_LEN; i++) {
      r = r * BASE + BigInt(ALPHABET.indexOf(bvid[DIGIT_MAP[i]]));
    }
    return `${r & MASK_CODE ^ XOR_CODE}`;
  }

  function isVideoCommentPage() {
    return isPlaybackPage();
  }

  function isCommentDetailPage() {
    return isVideoCommentPage() || PAGE_RE.dynamic.test(location.href) || PAGE_RE.opus.test(location.href) || PAGE_RE.article.test(location.href);
  }

  function getDynamicIdFromLocation() {
    const match = location.pathname.match(/(?:\/opus\/|^\/)(\d+)/);
    return match ? match[1] : '';
  }

  function getArticleIdFromLocation() {
    const match = location.pathname.match(/\/read\/cv(\d+)/i);
    return match ? match[1] : '';
  }

  async function getDynamicCommentTarget(dynamicId) {
    if (!dynamicId) return null;
    const res = await fetch(`https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?id=${dynamicId}`, {
      credentials: 'include'
    });
    const json = await res.json();
    const item = json.data?.item;
    const basic = item?.basic || {};
    const oid = basic.comment_id_str || basic.comment_id || item?.id_str || dynamicId;
    const type = Number(basic.comment_type || basic.comment_type_str || 17);
    const creator = item?.modules?.module_author?.mid || item?.modules?.module_author?.uid || 0;
    return oid ? { oid: String(oid), type, creator } : null;
  }

  function getVideoCommentTarget() {
    const state = unsafeWindow.__INITIAL_STATE__;
    let oid = String(state?.aid || state?.videoData?.aid || '');
    if (!oid || oid === 'undefined') {
      const bvMatch = location.pathname.match(/BV[\w]+/i);
      if (bvMatch) oid = b2a(bvMatch[0]);
    }
    return oid ? {
      oid,
      type: 1,
      creator: state?.upData?.mid || state?.videoData?.owner?.mid || 0
    } : null;
  }

  function getArticleCommentTarget() {
    const state = unsafeWindow.__INITIAL_STATE__ || {};
    const oid = String(
      state?.readInfo?.id ||
      state?.readInfo?.cvid ||
      state?.readInfo?.cid ||
      state?.detail?.id ||
      state?.articleInfo?.id ||
      getArticleIdFromLocation()
    );
    const creator = state?.readInfo?.mid || state?.readInfo?.author?.mid || state?.articleInfo?.author?.mid || 0;
    return oid && oid !== 'undefined' ? { oid, type: 12, creator } : null;
  }

  async function resolveCommentTarget() {
    try {
      if (isVideoCommentPage()) return getVideoCommentTarget();
      if (PAGE_RE.article.test(location.href)) return getArticleCommentTarget();
      if (PAGE_RE.dynamic.test(location.href) || PAGE_RE.opus.test(location.href)) {
        return await getDynamicCommentTarget(getDynamicIdFromLocation());
      }
    } catch(e) {
      console.error('[评论模块] 获取评论目标失败:', e);
    }
    return null;
  }

  function setupDynamicCommentBtnModifier() {
    if (!PAGE_RE.live.test(location.href) && !PAGE_RE.space.test(location.href)) return;

    const getDynamicLink = (node) => {
      const root = node.closest?.('[data-did], [data-dynamic-id], .opus-card, .bili-dyn-item, .dynamic-card, .card');
      const linkEl = root?.querySelector?.('a[href*="/opus/"], a[href*="t.bilibili.com/"]') ||
        node.closest?.('a[href*="/opus/"], a[href*="t.bilibili.com/"]');
      if (linkEl?.href) return linkEl.href;
      const did = root?.dataset?.did || root?.dataset?.dynamicId;
      return did ? `https://www.bilibili.com/opus/${did}` : '';
    };

    const bind = () => {
      document.querySelectorAll('[class*="comment"], [aria-label*="评论"], [title*="评论"]').forEach((btn) => {
        if (btn.dataset.bfqCommentBound) return;
        const text = (btn.textContent || btn.getAttribute('aria-label') || btn.getAttribute('title') || '').trim();
        if (!/评论/.test(text)) return;
        const href = getDynamicLink(btn);
        if (!href) return;
        btn.dataset.bfqCommentBound = '1';
        btn.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          location.href = href;
        }, true);
      });
    };

    const start = () => {
      bind();
      new MutationObserver(bind).observe(document.body, { childList: true, subtree: true });
    };

    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  }

  function getLiveAreaFallbackUrl(rawUrl) {
    try {
      const url = new URL(rawUrl, location.href);
      if (url.hostname !== 'api.live.bilibili.com') return null;
      if (url.pathname !== '/xlive/web-interface/v1/second/getList') return null;

      const params = url.searchParams;
      const fallback = new URL('https://api.live.bilibili.com/room/v3/area/getRoomList');
      fallback.searchParams.set('platform', 'web');
      fallback.searchParams.set('parent_area_id', params.get('parent_area_id') || '0');
      fallback.searchParams.set('area_id', params.get('area_id') || '0');
      fallback.searchParams.set('page', params.get('page') || '1');
      fallback.searchParams.set('page_size', params.get('page_size') || '30');
      fallback.searchParams.set('sort_type', params.get('sort_type') || '');
      return {
        url: fallback.toString(),
        page: Number(params.get('page') || '1'),
        pageSize: Number(params.get('page_size') || '30'),
        parentAreaId: Number(params.get('parent_area_id') || '0'),
        areaId: Number(params.get('area_id') || '0')
      };
    } catch(e) {
      return null;
    }
  }

  function isUsableLiveAreaResponse(json, requestInfo) {
    if (!json || json.code !== 0) return false;
    const data = json.data || {};
    if (!Array.isArray(data.list)) return false;

    // case 1：空列表，仅在合理终态时视为可用
    if (data.list.length === 0) {
      return requestInfo.page > 1 || ('has_more' in data && Number(data.has_more) === 0);
    }

    // case 2：列表非空但明显被登录态裁剪——count 与 list 长度严重不匹配
    const count = Number(data.count || 0);
    const pageSize = requestInfo.pageSize || 30;
    const listLen = data.list.length;

    if (count > 0 && listLen < pageSize) {
      const expectedEndPage = Math.ceil(count / pageSize);
      const isLastPage = requestInfo.page >= expectedEndPage;
      if (!isLastPage) {
        console.warn('[直播分区] 列表疑似被登录态裁剪，走兜底:', {
          areaId: requestInfo.areaId, page: requestInfo.page, listLen, pageSize, count
        });
        return false;
      }
    }

    // case 3：has_more 标记与 list 长度矛盾（has_more=0 但 list 满，或反过来）→ 可能裁剪
    if ('has_more' in data) {
      const hasMore = Number(data.has_more);
      if (hasMore === 0 && listLen >= pageSize && count > requestInfo.page * pageSize) {
        console.warn('[直播分区] has_more 标记与列表长度矛盾，走兜底:', {
          areaId: requestInfo.areaId, page: requestInfo.page, listLen, pageSize, count, hasMore
        });
        return false;
      }
    }

    return true;
  }

  function createLiveAreaJsonResponse(json, NativeResponse) {
    return new NativeResponse(JSON.stringify(json), {
      status: 200,
      statusText: 'OK',
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }

  async function fetchLiveAreaFallbackJson(originFetch, requestInfo, init) {
    const fallbackInit = {
      ...init,
      method: 'GET',
      body: undefined,
      credentials: 'omit'
    };
    const res = await originFetch(requestInfo.url, fallbackInit);
    return mapLiveAreaRoomList(await res.json(), requestInfo);
  }

  async function resolveLiveAreaJson(originFetch, requestInfo, originRequest, originInit) {
    let originJson = null;
    try {
      const originRes = await originFetch(originRequest, originInit);
      originJson = await originRes.clone().json();
      if (isUsableLiveAreaResponse(originJson, requestInfo)) {
        return { json: originJson, response: originRes };
      }
    } catch (e) {
      console.warn('[直播分区] 原接口请求失败，尝试旧接口兜底:', e);
    }

    try {
      return {
        json: await fetchLiveAreaFallbackJson(originFetch, requestInfo, originInit),
        response: null
      };
    } catch (e) {
      console.warn('[直播分区] 旧接口兜底失败:', e);
      if (originJson) return { json: originJson, response: null };
      throw e;
    }
  }

  function mapLiveAreaRoomList(json, requestInfo) {
    if (!json || json.code !== 0) return json;
    const oldData = json.data || {};
    const list = (oldData.list || []).map((item) => {
      const roomid = item.roomid || item.room_id;
      return {
        ...item,
        roomid,
        uid: item.uid || item.anchor_id || 0,
        title: item.title || '',
        uname: item.uname || item.user_name || '',
        cover: item.cover || item.user_cover || item.system_cover || '',
        user_cover: item.user_cover || item.cover || item.system_cover || '',
        system_cover: item.system_cover || item.keyframe || item.cover || '',
        face: item.face || item.avatar || '',
        link: item.link || `/${roomid}`,
        parent_id: item.parent_id || requestInfo.parentAreaId,
        area_id: item.area_id || requestInfo.areaId,
        area_v2_id: item.area_v2_id || item.area_id || requestInfo.areaId,
        area_v2_parent_id: item.area_v2_parent_id || item.parent_id || requestInfo.parentAreaId,
        area_v2_name: item.area_v2_name || item.area_name || '',
        area_v2_parent_name: item.area_v2_parent_name || item.parent_area_name || '',
        show_cover: item.show_cover || 'roomCover',
        is_auto_play: item.is_auto_play || 0,
        pendant_info: item.pendant_info || {},
        watched_show: item.watched_show || {}
      };
    });
    const count = Number(oldData.count || 0);
    const pageSize = Math.max(requestInfo.pageSize || 30, list.length || 0, 1);
    // 宁可多翻一页空也不提前停：count 已知时严格按 count 判；count 缺失时倾向 has_more=1，
    // 让前端多翻一页验证，避免旧接口真实数据被误判为末页导致「显示不全」
    let hasMore;
    if (count > 0) {
      hasMore = requestInfo.page * pageSize < count ? 1 : 0;
    } else {
      hasMore = list.length >= pageSize ? 1 : 0;
      if (list.length > 0 && list.length < pageSize) {
        console.warn('[直播分区] 旧接口返回不完整但 count 缺失，保守置 has_more=1:', {
          areaId: requestInfo.areaId, page: requestInfo.page, listLen: list.length, pageSize
        });
        hasMore = 1;
      }
    }
    return {
      code: 0,
      msg: json.msg || 'success',
      message: json.message || json.msg || 'success',
      ttl: json.ttl ?? 1,
      data: {
        list,
        count,
        total: count,
        total_count: count,
        page: requestInfo.page,
        page_size: requestInfo.pageSize,
        banner: oldData.banner || [],
        tags: oldData.tags || [],
        new_tags: oldData.new_tags || [],
        has_more: hasMore,
        vajra: oldData.vajra || [],
        cover_source: oldData.cover_source || 0
      }
    };
  }

  /* ========== 协议级画质解锁（拦截 playurl，服务端直接出 1080P）========== */
  const PROTOCOL_UNLOCK_TARGET_QN = 80;
  let playurlUnlockInstalled = false;

  function writePlayinfo(json, requestKey = '', generation = _videoGeneration) {
    try {
      if (!json || json.code !== 0 || generation !== _videoGeneration) return false;
      if (requestKey) _playinfoKey = requestKey;
      _playinfoWriteAllow = true;
      _playinfoCache = json;
      try { unsafeWindow.__playinfo__ = json; } catch (e) {}
      _playinfoWriteAllow = false;
      // SPA 切片后播放器实例已在，需主动推高清流
      applyHighQualityToPlayer(json, 'write-playinfo');
      setTimeout(() => forcePlayerTargetQuality('after-playinfo'), 100);
      setTimeout(() => forcePlayerTargetQuality('after-playinfo-2'), 500);
      setTimeout(() => forcePlayerTargetQuality('after-playinfo-3'), 1200);
      setTimeout(() => forcePlayerTargetQuality('after-playinfo-4'), 2500);
      scheduleForceQuality(8, 450);
      return true;
    } catch (e) {
      _playinfoWriteAllow = false;
      return false;
    }
  }

  function emitXhrFakeResponse(xhr, json) {
    const text = JSON.stringify(json);
    const responseType = xhr.responseType || '';
    Object.defineProperties(xhr, {
      readyState: { value: 4, configurable: true },
      status: { value: 200, configurable: true },
      statusText: { value: 'OK', configurable: true },
      responseText: { value: text, configurable: true },
      response: { value: responseType === 'json' ? json : text, configurable: true },
      responseURL: { value: xhr.__bfqPlayurlUrl || '', configurable: true },
    });
    try { xhr.dispatchEvent(new Event('readystatechange')); } catch (e) {}
    try { xhr.dispatchEvent(new Event('load')); } catch (e) {}
    try { xhr.dispatchEvent(new Event('loadend')); } catch (e) {}
  }

  function hasPlayableMedia(json) {
    const data = json?.data;
    return json?.code === 0 && !!data && (
      (Array.isArray(data.dash?.video) && data.dash.video.length > 0)
      || (Array.isArray(data.durl) && data.durl.length > 0)
    );
  }

  function getTargetQn() {
    const map = { 1080: 80, 720: 64, 480: 32, 360: 16 };
    return map[options.preferQuality] || PROTOCOL_UNLOCK_TARGET_QN;
  }

  async function buildPlayurlUrl(rawUrl, useTryLook = true) {
    const url = new URL(rawUrl, location.href);
    const params = {};
    for (const [k, v] of url.searchParams.entries()) {
      if (k === 'w_rid' || k === 'wts') continue;
      params[k] = v;
    }
    params.qn = String(getTargetQn());
    if (useTryLook) params.try_look = '1';
    else delete params.try_look;
    const signedQuery = await getWbiQueryString(params);
    return `${url.origin}${url.pathname}?${signedQuery}`;
  }

  function isTrialOnlyPlayurl(json) {
    try {
      if (!json || json.code !== 0) return true;
      const data = json.data || {};
      if (data.isPreview === 1 || data.preview === 1) return true;
      if (data.need_login === 1 || data.need_login === true) return true;
      // 必须达到用户目标档（默认 1080=80），480/360 一律视为失败并重试
      const target = getTargetQn();
      if (data.dash && Array.isArray(data.dash.video) && data.dash.video.length > 0) {
        return Math.max(...data.dash.video.map(v => v.id || 0)) < target;
      }
      if (Array.isArray(data.durl) && data.durl.length > 0) {
        return (data.quality || 0) < target;
      }
      if (Array.isArray(data.accept_quality) && data.accept_quality.length > 0) {
        return Math.max(...data.accept_quality) < target;
      }
      return true;
    } catch (e) { return true; }
  }

  // 把响应里的 quality / accept 对齐到 dash 实际最高档，并清掉登录/会员锁，方便 SPA 后切 1080
  function normalizePlayurlQuality(json) {
    try {
      if (!json || json.code !== 0 || !json.data) return json;
      const data = json.data;
      const target = getTargetQn();

      // 清除前端锁档标记（菜单里显示「需登录」的根源）
      data.need_login = 0;
      data.need_vip = 0;
      data.isPreview = 0;
      data.preview = 0;
      if (data.vip_status != null) data.vip_status = 1;
      if (data.vip_type != null && data.vip_type === 0) data.vip_type = 1;

      let maxQn = 0;
      if (data.dash?.video?.length) {
        maxQn = Math.max(...data.dash.video.map(v => v.id || 0));
      } else if (Array.isArray(data.durl) && data.quality) {
        maxQn = data.quality;
      } else if (Array.isArray(data.accept_quality) && data.accept_quality.length) {
        maxQn = Math.max(...data.accept_quality);
      }

      if (maxQn > 0) {
        // 优先展示用户目标档（若流里已有）
        data.quality = maxQn >= target ? target : maxQn;
        if (Array.isArray(data.accept_quality)) {
          const set = new Set(data.accept_quality);
          set.add(maxQn);
          if (maxQn >= target) set.add(target);
          data.accept_quality = [...set].sort((a, b) => b - a);
        } else {
          data.accept_quality = [maxQn, 64, 32, 16].filter((v, i, a) => a.indexOf(v) === i);
        }
      }

      // support_formats：去掉 need_login / need_vip，让清晰度菜单可点 1080
      if (Array.isArray(data.support_formats)) {
        data.support_formats = data.support_formats.map((fmt) => {
          if (!fmt || typeof fmt !== 'object') return fmt;
          const next = { ...fmt };
          if (next.quality != null && next.quality <= maxQn) {
            next.need_login = false;
            next.need_vip = false;
            delete next.attribute;
          }
          return next;
        });
      }

      return json;
    } catch (e) {
      return json;
    }
  }

  // 安全改写 player/wbi/v2：只改 JSON 文本
  function patchPlayerV2JsonText(text) {
    try {
      const json = JSON.parse(text);
      if (!json?.data) return text;
      const data = json.data;
      if (!data.login_mid) data.login_mid = Math.floor(Math.random() * 1e8) + 1;
      if (data.need_login_subtitle != null) data.need_login_subtitle = false;
      if (!data.level_info) data.level_info = {};
      if (!data.level_info.current_level || data.level_info.current_level < 1) {
        data.level_info.current_level = 6;
      }
      // 播放器 widget 可能读这些字段决定画质/试看 UI
      if (data.is_owner != null) data.is_owner = 0;
      if ('answer_status' in data && data.answer_status === 0) data.answer_status = 1;
      return JSON.stringify(json);
    } catch (e) {
      return text;
    }
  }

  function isPlayerV2Url(rawUrl) {
    return !!(rawUrl && rawUrl.includes('/x/player/wbi/v2'));
  }

  // 可多次 json()/text()/arrayBuffer()/clone() 的 Response，避免顶栏二次读 body 失败
  function createReusableJsonResponse(bodyText, baseRes) {
    const text = typeof bodyText === 'string' ? bodyText : JSON.stringify(bodyText || {});
    const status = baseRes?.status || 200;
    const statusText = baseRes?.statusText || 'OK';
    const headers = new Headers(baseRes?.headers || { 'content-type': 'application/json; charset=utf-8' });
    if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8');

    const makeBodyStream = () => new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      }
    });

    const res = new Response(makeBodyStream(), { status, statusText, headers });
    // 覆盖一次性消费方法，始终可重复读
    res.text = async () => text;
    res.json = async () => JSON.parse(text);
    res.arrayBuffer = async () => {
      const enc = new TextEncoder().encode(text);
      return enc.buffer.slice(enc.byteOffset, enc.byteOffset + enc.byteLength);
    };
    res.blob = async () => new Blob([text], { type: headers.get('content-type') || 'application/json' });
    res.clone = () => createReusableJsonResponse(text, { status, statusText, headers });
    return res;
  }

  async function parseFetchResponseJson(res) {
    try {
      return await res.clone().json();
    } catch (e) {
      try { return JSON.parse(await res.clone().text()); } catch (e2) { return null; }
    }
  }

  function installPlayurlUnlock() {
    if (!options.enableProtocolUnlock) return;
    if (!isPlaybackPage()) return;
    if (isBilibiliLoggedIn()) return;
    if (playurlUnlockInstalled) return;
    playurlUnlockInstalled = true;

    ensureFakeLoginCookie();
    patchPlayerProfileQuality();
    clearPlayinfoSSR();
    installSpaPlayinfoReset();

    const fetchPlayurlJson = async (rawUrl, useTryLook) => {
      const signed = await buildPlayurlUrl(rawUrl, useTryLook);
      const res = await nativePageFetch(signed, { credentials: 'include', method: 'GET' });
      const json = await parseFetchResponseJson(res);
      return { res, json };
    };

    /* ---- fetch 链 ---- */
    const originFetch = unsafeWindow.fetch?.bind(unsafeWindow) || nativePageFetch;
    if (originFetch) {
      unsafeWindow.fetch = async function(input, init) {
        let rawUrl = typeof input === 'string' ? input : (input?.url ?? '');

        // 安全改写 player/wbi/v2：可多次读取 body，避免顶栏二次消费失败
        if (isPlayerV2Url(rawUrl)) {
          let res;
          try {
            ensureFakeLoginCookie();
            res = await originFetch(input, init);
            const text = await res.clone().text();
            const patched = patchPlayerV2JsonText(text);
            if (patched === text) return res;
            return createReusableJsonResponse(patched, res);
          } catch (e) {
            if (res) return res;
            throw e;
          }
        }

        if (!isPlayurlRequestUrl(rawUrl)) {
          return originFetch(input, init);
        }

        try {
          const requestGeneration = _videoGeneration;
          const url = new URL(rawUrl, location.href);
          if (url.hostname !== 'api.bilibili.com') return originFetch(input, init);

          const reqKey = getPlayurlRequestKey(rawUrl);
          // 切到新 aid/cid 时先清旧缓存，防止串流
          if (reqKey && _playinfoKey && reqKey !== _playinfoKey) {
            _playinfoCache = null;
            _playinfoKey = '';
          }
          ensureFakeLoginCookie();
          patchPlayerProfileQuality();

          let { json: json1 } = await fetchPlayurlJson(rawUrl, true);
          if (hasPlayableMedia(json1) && !isTrialOnlyPlayurl(json1)) {
            json1 = normalizePlayurlQuality(json1);
            if (requestGeneration === _videoGeneration) {
              writePlayinfo(json1, reqKey, requestGeneration);
              scheduleForceQuality(8, 400);
            }
            if (requestGeneration !== _videoGeneration) return originFetch(input, init);
            return createReusableJsonResponse(JSON.stringify(json1));
          }

          console.warn('[Bilibili脚本] try_look 未达目标画质，重试 qn=' + getTargetQn());
          const { json: json2 } = await fetchPlayurlJson(rawUrl, false);
          let pick = pickPlayablePlayurl(json1, json2);
          if (pick) pick = normalizePlayurlQuality(pick);
          if (pick && requestGeneration === _videoGeneration) {
            writePlayinfo(pick, reqKey, requestGeneration);
            scheduleForceQuality(10, 450);
          }
          if (!pick) return originFetch(input, init);
          if (requestGeneration !== _videoGeneration) return originFetch(input, init);
          return createReusableJsonResponse(JSON.stringify(pick));
        } catch (e) {
          console.warn('[Bilibili脚本] playurl 解锁失败，回退:', e);
          return originFetch(input, init);
        }
      };
    }

    /* ---- XHR 链 ---- */
    const XHR = unsafeWindow.XMLHttpRequest;
    if (!XHR || XHR.prototype.__bfqPlayurlPatched) return;
    XHR.prototype.__bfqPlayurlPatched = true;

    const originOpen = XHR.prototype.open;
    const originSend = XHR.prototype.send;

    XHR.prototype.open = function(method, url, ...rest) {
      this.__bfqPlayurlUrl = typeof url === 'string' ? url : (url?.url ?? '');
      this.__bfqPlayurlMethod = method;
      return originOpen.call(this, method, url, ...rest);
    };

    XHR.prototype.send = function(...args) {
      const rawUrl = this.__bfqPlayurlUrl;

      // XHR 改写 player/wbi/v2：在业务回调前改写 response（捕获阶段优先）
      if (isPlayerV2Url(rawUrl)) {
        try {
          ensureFakeLoginCookie();
          const xhr = this;
          let patchedOnce = false;
          const applyPatch = () => {
            if (patchedOnce || xhr.readyState !== 4) return;
            patchedOnce = true;
            try {
              const rawValue = xhr.responseType === 'json' ? xhr.response : xhr.responseText;
              const text = typeof rawValue === 'string' ? rawValue : JSON.stringify(rawValue || {});
              if (!text) return;
              const patched = patchPlayerV2JsonText(text);
              if (patched === text) return;
              const asJson = (() => { try { return JSON.parse(patched); } catch (e) { return patched; } })();
              const descriptors = {
                response: { get: () => xhr.responseType === 'json' ? asJson : patched, configurable: true }
              };
              if (xhr.responseType !== 'json') {
                descriptors.responseText = { get: () => patched, configurable: true };
              }
              Object.defineProperties(xhr, descriptors);
            } catch (e) {}
          };
          // 捕获阶段先于页面监听器
          xhr.addEventListener('readystatechange', applyPatch, true);
          xhr.addEventListener('load', applyPatch, true);
          const prevOrsc = xhr.onreadystatechange;
          xhr.onreadystatechange = function (...a) {
            applyPatch();
            if (typeof prevOrsc === 'function') return prevOrsc.apply(this, a);
          };
          const prevOnload = xhr.onload;
          xhr.onload = function (...a) {
            applyPatch();
            if (typeof prevOnload === 'function') return prevOnload.apply(this, a);
          };
        } catch (e) {}
        return originSend.apply(this, args);
      }

      if (!isPlayurlRequestUrl(rawUrl)) {
        return originSend.apply(this, args);
      }

      const xhr = this;
      const requestGeneration = _videoGeneration;
      (async () => {
        try {
          const url = new URL(rawUrl, location.href);
          if (url.hostname !== 'api.bilibili.com') {
            return originSend.apply(xhr, args);
          }

          const reqKey = getPlayurlRequestKey(rawUrl);
          if (reqKey && _playinfoKey && reqKey !== _playinfoKey) {
            _playinfoCache = null;
            _playinfoKey = '';
          }
          ensureFakeLoginCookie();
          patchPlayerProfileQuality();

          let { json } = await fetchPlayurlJson(rawUrl, true);
          if (isTrialOnlyPlayurl(json)) {
            console.warn('[Bilibili脚本] XHR try_look 未达目标画质，重试');
            let json2;
            ({ json: json2 } = await fetchPlayurlJson(rawUrl, false));
            json = pickPlayablePlayurl(json, json2);
          }
          if (!hasPlayableMedia(json)) {
            console.warn('[Bilibili脚本] XHR playurl 未获得有效媒体流，回退原请求');
            return originSend.apply(xhr, args);
          }
          json = normalizePlayurlQuality(json);
          if (requestGeneration !== _videoGeneration) return originSend.apply(xhr, args);
          writePlayinfo(json, reqKey, requestGeneration);
          scheduleForceQuality(10, 450);
          emitXhrFakeResponse(xhr, json);
        } catch (e) {
          console.warn('[Bilibili脚本] XHR playurl 解锁失败:', e);
          try { originSend.apply(xhr, args); } catch (e2) {}
        }
      })();
    };
  }

  function installLiveAreaUnlock() {
    if (!options.enableLiveAreaUnlock || !PAGE_RE.live.test(location.href) || isBilibiliLoggedIn()) return;

    const NativeResponse = unsafeWindow.Response || Response;
    const originFetch = unsafeWindow.fetch?.bind(unsafeWindow);
    if (originFetch) {
      unsafeWindow.fetch = async function(input, init) {
        const rawUrl = typeof input === 'string' ? input : input?.url;
        const fallback = getLiveAreaFallbackUrl(rawUrl);
        if (!fallback) return originFetch(input, init);

        const result = await resolveLiveAreaJson(originFetch, fallback, input, init);
        return result.response || createLiveAreaJsonResponse(result.json, NativeResponse);
      };
    }

    const XHR = unsafeWindow.XMLHttpRequest;
    if (!XHR || XHR.prototype.__bfqLiveAreaPatched) return;
    XHR.prototype.__bfqLiveAreaPatched = true;

    const fakeStates = new WeakMap();
    const originOpen = XHR.prototype.open;
    const originSend = XHR.prototype.send;
    const originSetRequestHeader = XHR.prototype.setRequestHeader;
    const originGetResponseHeader = XHR.prototype.getResponseHeader;
    const originGetAllResponseHeaders = XHR.prototype.getAllResponseHeaders;

    const nativeGetters = {};
    ['readyState', 'status', 'statusText', 'response', 'responseText', 'responseURL'].forEach((prop) => {
      nativeGetters[prop] = Object.getOwnPropertyDescriptor(XHR.prototype, prop)?.get;
    });

    const emit = (xhr, type) => {
      const event = new unsafeWindow.Event(type);
      xhr.dispatchEvent(event);
    };

    const setReadyState = (xhr, state, readyState) => {
      state.readyState = readyState;
      emit(xhr, 'readystatechange');
    };

    XHR.prototype.open = function(method, url, async = true) {
      const fallback = getLiveAreaFallbackUrl(url);
      if (!fallback) return originOpen.apply(this, arguments);

      originOpen.apply(this, arguments);

      fakeStates.set(this, {
        matched: true,
        method,
        url: String(url),
        fallback,
        async: async !== false,
        headers: {},
        readyState: 1,
        status: 0,
        statusText: '',
        response: null,
        responseText: '',
        responseURL: fallback.url,
        responseHeaders: 'content-type: application/json; charset=utf-8\r\n'
      });
    };

    XHR.prototype.setRequestHeader = function(name, value) {
      const state = fakeStates.get(this);
      if (state?.matched) {
        state.headers[name] = value;
        return;
      }
      return originSetRequestHeader.apply(this, arguments);
    };

    XHR.prototype.send = function(body) {
      const state = fakeStates.get(this);
      if (!state?.matched) return originSend.apply(this, arguments);

      emit(this, 'loadstart');
      setReadyState(this, state, 2);

      resolveLiveAreaJson(originFetch, state.fallback, state.url, {
        method: state.method || 'GET',
        headers: state.headers,
        credentials: this.withCredentials ? 'include' : 'same-origin'
      })
        .then(({ json }) => {
          state.status = 200;
          state.statusText = 'OK';
          state.responseText = JSON.stringify(json);
          state.response = this.responseType === 'json' ? json : state.responseText;
          setReadyState(this, state, 4);
          emit(this, 'load');
          emit(this, 'loadend');
        })
        .catch((err) => {
          state.status = 0;
          state.statusText = String(err);
          setReadyState(this, state, 4);
          emit(this, 'error');
          emit(this, 'loadend');
        });
    };

    XHR.prototype.getResponseHeader = function(name) {
      const state = fakeStates.get(this);
      if (state?.matched) return String(name).toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null;
      return originGetResponseHeader.apply(this, arguments);
    };

    XHR.prototype.getAllResponseHeaders = function() {
      const state = fakeStates.get(this);
      if (state?.matched) return state.responseHeaders;
      return originGetAllResponseHeaders.apply(this, arguments);
    };

    ['readyState', 'status', 'statusText', 'response', 'responseText', 'responseURL'].forEach((prop) => {
      if (!nativeGetters[prop]) return;
      Object.defineProperty(XHR.prototype, prop, {
        configurable: true,
        get() {
          const state = fakeStates.get(this);
          if (state?.matched) return state[prop];
          return nativeGetters[prop].call(this);
        }
      });
    });
  }

  function commentFormatTime(ts) {
    const d = new Date(ts * 1000);
    const now = new Date();
    const diff = (now - d) / 1000;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
    if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}天前`;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function sanitizeId(value) {
    const s = String(value ?? '').trim();
    return /^\d{1,20}$/.test(s) ? s : '0';
  }

  function sanitizeLevel(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(6, Math.floor(n));
  }

  function sanitizeImageUrl(url) {
    try {
      const u = new URL(String(url || ''), location.href);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
      const host = u.hostname.toLowerCase();
      if (
        host === 'i0.hdslb.com' || host === 'i1.hdslb.com' || host === 'i2.hdslb.com' ||
        host.endsWith('.hdslb.com') || host.endsWith('.bilibili.com') || host.endsWith('.bilivideo.com')
      ) {
        return u.href;
      }
      return '';
    } catch (e) {
      return '';
    }
  }

  function renderReplyContent(reply) {
    let text = escapeHtml(reply.content?.message || '');
    if (reply.content?.emote) {
      Object.entries(reply.content.emote).forEach(([key, emote]) => {
        const esc = escapeHtml(key);
        const imgUrl = sanitizeImageUrl(emote?.url);
        if (!imgUrl) return;
        text = text.replace(
          new RegExp(esc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
          `<img class="reply-emote" src="${escapeHtml(imgUrl)}" alt="${esc}" />`
        );
      });
    }
    text = text.replace(/@([^\s,，：:@\n]+)/g, '<a class="reply-mention" href="javascript:void(0)">@$1</a>');
    return text;
  }

  function appendCommentItem(replyData, isTop) {
    const list = document.getElementById('bili-comment-list');
    if (!list) return;

    const mid = sanitizeId(replyData.mid);
    const rpid = sanitizeId(replyData.rpid);
    const avatar = sanitizeImageUrl(replyData.member?.avatar) || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
    const isVip = replyData.member?.vip?.vipStatus === 1;
    const isUp = Number(mid) === Number(commentCreatorID);
    const level = sanitizeLevel(replyData.member?.level_info?.current_level);
    const nameStyle = isVip ? ' style="color:#fb7299"' : '';
    const upBadge = isUp ? '<span class="reply-up-badge">UP主</span>' : '';
    const subReplies = (replyData.replies || []).slice(0, 3);
    const subCount = Number(replyData.rcount) || 0;

    let subHtml = '';
    if (subReplies.length > 0) {
      const subItems = subReplies.map(sub => {
        const sMid = sanitizeId(sub.mid);
        const sAvatar = sanitizeImageUrl(sub.member?.avatar) || avatar;
        const sVip = sub.member?.vip?.vipStatus === 1;
        const sUp = Number(sMid) === Number(commentCreatorID);
        return `<div class="sub-reply-item">
          <a class="sub-reply-avatar" href="https://space.bilibili.com/${sMid}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(sAvatar)}" alt="" loading="lazy" /></a>
          <div class="sub-reply-main">
            <a class="sub-reply-username" href="https://space.bilibili.com/${sMid}" target="_blank" rel="noopener noreferrer"${sVip ? ' style="color:#fb7299"' : ''}>${escapeHtml(sub.member?.uname || '')}</a>${sUp ? '<span class="reply-up-badge reply-up-badge-sm">UP主</span>' : ''}：<span class="sub-reply-text">${renderReplyContent(sub)}</span>
            <span class="sub-reply-time">${commentFormatTime(sub.ctime)}</span>
          </div>
        </div>`;
      }).join('');
      const moreBtn = subCount > 3
        ? `<div class="sub-reply-more" data-rpid="${rpid}" data-count="${subCount}">共 ${subCount} 条回复，点击查看全部 &gt;</div>`
        : '';
      subHtml = `<div class="sub-reply-list">${subItems}${moreBtn}</div>`;
    }

    const wrapper = document.createElement('div');
    wrapper.innerHTML = `<div class="reply-item${isTop ? ' reply-top' : ''}" data-rpid="${rpid}">
      <a class="reply-avatar" href="https://space.bilibili.com/${mid}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(avatar)}" alt="" loading="lazy" /></a>
      <div class="reply-main">
        <div class="reply-header">
          <a class="reply-username" href="https://space.bilibili.com/${mid}" target="_blank" rel="noopener noreferrer"${nameStyle}>${escapeHtml(replyData.member?.uname || '')}</a>${upBadge}<span class="reply-level lv-${level}">Lv.${level}</span>
        </div>
        <div class="reply-text">${renderReplyContent(replyData)}</div>
        <div class="reply-footer">
          <span class="reply-time">${commentFormatTime(replyData.ctime)}</span>
          <span class="reply-likes">${escapeHtml(String(replyData.like || 0))}</span>
        </div>
        ${subHtml}
      </div>
    </div>`;

    const item = wrapper.firstElementChild;
    const moreEl = item.querySelector('.sub-reply-more');
    if (moreEl) {
      moreEl.addEventListener('click', () => {
        loadSubReplies(rpid, item.querySelector('.sub-reply-list'), parseInt(moreEl.dataset.count, 10) || 0, 1);
      });
    }
    list.appendChild(item);
  }

  async function loadSubReplies(rootReplyID, container, totalCount, pageNum) {
    if (!container) return;
    const safeRoot = sanitizeId(rootReplyID);
    const safeOid = sanitizeId(commentOid);
    const safeType = sanitizeId(commentType);
    const loadEl = document.createElement('div');
    loadEl.className = 'sub-reply-loading';
    loadEl.textContent = '加载中...';
    container.appendChild(loadEl);
    try {
      const res = await nativePageFetch(
        `https://api.bilibili.com/x/v2/reply/reply?oid=${safeOid}&root=${safeRoot}&pn=${pageNum}&ps=10&type=${safeType}`,
        { credentials: 'omit' }
      );
      const data = await res.json();
      loadEl.remove();
      if (data.code === 0 && data.data?.replies) {
        if (pageNum === 1) container.innerHTML = '';
        data.data.replies.forEach(sub => {
          const sMid = sanitizeId(sub.mid);
          const sAvatar = sanitizeImageUrl(sub.member?.avatar) || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
          const sVip = sub.member?.vip?.vipStatus === 1;
          const sUp = Number(sMid) === Number(commentCreatorID);
          const el = document.createElement('div');
          el.className = 'sub-reply-item';
          el.innerHTML = `
            <a class="sub-reply-avatar" href="https://space.bilibili.com/${sMid}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(sAvatar)}" alt="" loading="lazy" /></a>
            <div class="sub-reply-main">
              <a class="sub-reply-username" href="https://space.bilibili.com/${sMid}" target="_blank" rel="noopener noreferrer"${sVip ? ' style="color:#fb7299"' : ''}>${escapeHtml(sub.member?.uname || '')}</a>${sUp ? '<span class="reply-up-badge reply-up-badge-sm">UP主</span>' : ''}：<span class="sub-reply-text">${renderReplyContent(sub)}</span>
              <span class="sub-reply-time">${commentFormatTime(sub.ctime)}</span>
            </div>`;
          container.appendChild(el);
        });
        const loaded = pageNum * 10;
        if (loaded < totalCount) {
          const nextBtn = document.createElement('div');
          nextBtn.className = 'sub-reply-more';
          nextBtn.textContent = `继续加载（还有 ${totalCount - loaded} 条）`;
          nextBtn.addEventListener('click', () => { nextBtn.remove(); loadSubReplies(safeRoot, container, totalCount, pageNum + 1); });
          container.appendChild(nextBtn);
        }
      }
    } catch(e) {
      loadEl.remove();
      console.error('[评论模块] 子评论加载失败:', e);
    }
  }

  async function getCommentPaginationData(offset, signal) {
    const mode = commentCurrentSortType === COMMENT_SORT.HOT ? 3 : 2;
    const paginationStr = JSON.stringify({ offset: offset || '' });
    const wts = Math.floor(Date.now() / 1000);
    const qs = await getWbiQueryString({ oid: commentOid, type: commentType, mode, ps: COMMENT_PAGE_SIZE, pagination_str: paginationStr, wts });
    const res = await nativePageFetch(`https://api.bilibili.com/x/v2/reply/wbi/main?${qs}`, { credentials: 'omit', signal });
    return res.json();
  }

  async function loadCommentPage(offset, appendToList) {
    if (commentIsLoading) return;
    const generation = commentGeneration;
    const requestOid = commentOid;
    commentAbortController?.abort();
    commentAbortController = new AbortController();
    commentIsLoading = true;
    const loader = document.getElementById('bili-comment-loader');
    if (loader) loader.style.display = 'block';
    try {
      const data = await getCommentPaginationData(offset, commentAbortController.signal);
      if (generation !== commentGeneration || requestOid !== commentOid) return;
      if (data.code !== 0) {
        console.error('[评论模块] API错误:', data.code, data.message);
        return;
      }
      const list = document.getElementById('bili-comment-list');
      if (!appendToList && list) list.innerHTML = '';
      if (!appendToList) {
        const topReply = data.data?.top?.upper;
        if (topReply) appendCommentItem(topReply, true);
      }
      (data.data?.replies || []).forEach(r => appendCommentItem(r, false));
      commentTotalCount = Number(data.data?.cursor?.all_count || data.data?.cursor?.total || commentTotalCount || 0);
      const totalEl = document.getElementById('bili-total-reply') || document.querySelector('.comment-container .total-reply');
      if (totalEl) totalEl.textContent = String(commentTotalCount);
      const nextOffset = data.data?.cursor?.pagination_reply?.next_offset || '';
      const isEnd = !nextOffset || !!data.data?.cursor?.is_end;
      commentIsEnd = isEnd;
      commentNextOffset = nextOffset;
      if (options.enableReplyPagination) {
        if (!isEnd) commentPageOffsets[commentCurrentPage + 1] = nextOffset;
        updatePaginationControls();
      } else {
        if (isEnd) {
          const endEl = document.getElementById('bili-comment-end');
          if (endEl) endEl.style.display = 'block';
        }
      }
    } catch(e) {
      if (e?.name === 'AbortError') return;
      console.error('[评论模块] 加载评论失败:', e);
    } finally {
      if (generation === commentGeneration) {
        commentIsLoading = false;
        if (loader) loader.style.display = 'none';
      }
    }
  }

  function updatePaginationControls() {
    const pageInfo = document.getElementById('bili-page-info');
    const prevBtn = document.getElementById('bili-prev-page');
    const nextBtn = document.getElementById('bili-next-page');
    const jumpInput = document.getElementById('bili-jump-page-input');
    const totalPages = commentTotalCount ? Math.max(1, Math.ceil(commentTotalCount / COMMENT_PAGE_SIZE)) : 0;
    if (pageInfo) pageInfo.textContent = totalPages ? `第 ${commentCurrentPage + 1} / ${totalPages} 页` : `第 ${commentCurrentPage + 1} 页`;
    if (prevBtn) prevBtn.disabled = commentCurrentPage === 0;
    if (nextBtn) nextBtn.disabled = commentIsEnd;
    if (jumpInput) {
      jumpInput.max = totalPages || '';
      jumpInput.placeholder = totalPages ? `1-${totalPages}` : '页码';
    }
  }

  async function ensureCommentPageOffset(targetPage) {
    if (targetPage < 0) return false;
    if (commentPageOffsets[targetPage] !== undefined) return true;

    let knownIndex = commentPageOffsets.length - 1;
    while (knownIndex >= 0 && commentPageOffsets[knownIndex] === undefined) knownIndex--;
    if (knownIndex < 0) return false;

    while (knownIndex < targetPage) {
      const data = await getCommentPaginationData(commentPageOffsets[knownIndex] || '');
      if (data.code !== 0) return false;
      const nextOffset = data.data?.cursor?.pagination_reply?.next_offset || '';
      if (!nextOffset) return false;
      commentPageOffsets[knownIndex + 1] = nextOffset;
      knownIndex++;
    }
    return true;
  }

  async function jumpToCommentPage(pageNum) {
    if (commentIsLoading) return;
    const totalPages = commentTotalCount ? Math.max(1, Math.ceil(commentTotalCount / COMMENT_PAGE_SIZE)) : 0;
    if (!Number.isFinite(pageNum) || pageNum < 1) return;
    if (totalPages && pageNum > totalPages) pageNum = totalPages;

    const targetIndex = pageNum - 1;
    const loader = document.getElementById('bili-comment-loader');
    commentIsLoading = true;
    if (loader) {
      loader.textContent = `正在定位第 ${pageNum} 页...`;
      loader.style.display = 'block';
    }
    const ok = await ensureCommentPageOffset(targetIndex);
    commentIsLoading = false;
    if (loader) {
      loader.textContent = '加载中...';
      loader.style.display = 'none';
    }
    if (!ok) return;

    commentCurrentPage = targetIndex;
    commentIsEnd = false;
    await loadCommentPage(commentPageOffsets[targetIndex] || '', false);
  }

  // 参考 DD1969：只替换评论容器本身，绝不全站 hide / 不动顶栏
  function buildStandardCommentShellHtml() {
    return `
      <div class="comment-container" id="bili-custom-comments">
        <div class="reply-header bili-comment-header">
          <div class="reply-navigation">
            <ul class="nav-bar" style="display:flex;justify-content:space-between;align-items:center;list-style:none;margin:0;padding:0 0 12px;border-bottom:1px solid #e3e5e7">
              <li class="nav-title bili-comment-title" style="font-size:18px;font-weight:700">评论 <span class="total-reply" id="bili-total-reply"></span></li>
              <li class="nav-sort bili-comment-sort" style="display:flex;gap:16px">
                <span class="sort-btn hot-sort active" data-sort="2">最热</span>
                <span class="sort-btn time-sort" data-sort="0">最新</span>
              </li>
            </ul>
          </div>
        </div>
        <div class="reply-warp">
          <div class="reply-list" id="bili-comment-list"></div>
          <div id="bili-comment-loader" style="display:none;text-align:center;padding:16px;color:#9499a0">加载中...</div>
          <div id="bili-comment-end" style="display:none;text-align:center;padding:16px;color:#9499a0;font-size:13px">没有更多评论了</div>
          ${options.enableReplyPagination
            ? `<div id="bili-comment-pagination"><button id="bili-prev-page" disabled>上一页</button><span id="bili-page-info">第 1 页</span><button id="bili-next-page">下一页</button><label class="bili-page-jump">跳至 <input id="bili-jump-page-input" type="number" min="1" inputmode="numeric" /><button id="bili-jump-page">跳转</button></label></div>`
            : `<div id="bili-scroll-anchor"></div>`}
        </div>
      </div>`;
  }

  function isSafeCommentHost(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.closest?.('.bili-header, #bili-header-container, #biliMainHeader, .fixed-header, .header-login-entry, .right-entry')) return false;
    // 顶栏/全局节点绝不替换
    if (el === document.body || el === document.documentElement || el.id === 'app' || el.id === 'bili-header-container') return false;
    return true;
  }

  function findNativeCommentHost() {
    // 优先级：标准容器 > 旧容器 > web component > 明确评论挂载点
    return (
      document.querySelector('.comment-container') ||
      document.querySelector('.comment-wrapper .common') ||
      document.querySelector('bili-comments') ||
      document.querySelector('#commentapp') ||
      document.querySelector('.bili-comment-container') ||
      document.querySelector('.comment-wrap > .bili-comment-container') ||
      null
    );
  }

  async function setupStandardCommentContainer() {
    const host = await new Promise((resolve, reject) => {
      let n = 0;
      const timer = setInterval(() => {
        const el = findNativeCommentHost();
        if (el && isSafeCommentHost(el)) {
          clearInterval(timer);
          resolve(el);
          return;
        }
        if (++n > 100) {
          clearInterval(timer);
          reject(new Error('未找到安全的评论容器'));
        }
      }, 150);
    });

    // 已是我们的壳：直接复用
    if (host.id === 'bili-custom-comments' || host.querySelector?.('#bili-comment-list')) {
      return host.closest?.('#bili-custom-comments') || host;
    }

    // 已是标准 .comment-container：清空列表区，挂上我们的列表 id
    if (host.classList?.contains('comment-container') && isSafeCommentHost(host)) {
      let list = host.querySelector('.reply-list');
      if (!list) {
        const warp = host.querySelector('.reply-warp') || host;
        list = document.createElement('div');
        list.className = 'reply-list';
        warp.appendChild(list);
      }
      list.id = 'bili-comment-list';
      list.innerHTML = '';
      host.id = host.id || 'bili-custom-comments';

      // 排序按钮
      if (!host.querySelector('.sort-btn')) {
        const nav = host.querySelector('.reply-header, .nav-bar') || host;
        const sortWrap = document.createElement('div');
        sortWrap.className = 'bili-comment-sort';
        sortWrap.style.cssText = 'display:flex;gap:16px;margin:8px 0';
        sortWrap.innerHTML = `<span class="sort-btn hot-sort active" data-sort="2">最热</span><span class="sort-btn time-sort" data-sort="0">最新</span>`;
        nav.appendChild(sortWrap);
      }
      if (!host.querySelector('#bili-comment-loader')) {
        const loader = document.createElement('div');
        loader.id = 'bili-comment-loader';
        loader.style.cssText = 'display:none;text-align:center;padding:16px;color:#9499a0';
        loader.textContent = '加载中...';
        list.parentNode?.appendChild(loader);
      }
      if (!host.querySelector('#bili-comment-end')) {
        const endEl = document.createElement('div');
        endEl.id = 'bili-comment-end';
        endEl.style.cssText = 'display:none;text-align:center;padding:16px;color:#9499a0;font-size:13px';
        endEl.textContent = '没有更多评论了';
        list.parentNode?.appendChild(endEl);
      }
      if (options.enableReplyPagination && !host.querySelector('#bili-comment-pagination')) {
        const pager = document.createElement('div');
        pager.id = 'bili-comment-pagination';
        pager.innerHTML = `<button id="bili-prev-page" disabled>上一页</button><span id="bili-page-info">第 1 页</span><button id="bili-next-page">下一页</button><label class="bili-page-jump">跳至 <input id="bili-jump-page-input" type="number" min="1" inputmode="numeric" /><button id="bili-jump-page">跳转</button></label>`;
        list.parentNode?.appendChild(pager);
      } else if (!options.enableReplyPagination && !host.querySelector('#bili-scroll-anchor')) {
        const anchor = document.createElement('div');
        anchor.id = 'bili-scroll-anchor';
        list.parentNode?.appendChild(anchor);
      }
      return host;
    }

    // bili-comments / 非标准：只替换评论节点自身，不清空包含其他组件的父节点
    if (!isSafeCommentHost(host)) {
      throw new Error('评论容器不在安全挂载点，放弃替换以防误伤顶栏');
    }
    const template = document.createElement('template');
    template.innerHTML = buildStandardCommentShellHtml().trim();
    const customRoot = template.content.firstElementChild;
    if (!customRoot) throw new Error('评论容器创建失败');
    host.replaceWith(customRoot);
    return customRoot;
  }

  // 动态/opus：只拦截评论 tab 容器挂载 BILI-COMMENTS，不碰全局 appendChild
  function setupOfficialCommentModuleBlocker() {
    if (!PAGE_RE.dynamic.test(location.href) && !PAGE_RE.opus.test(location.href)) return;
    const tryPatch = () => {
      const wrap = document.querySelector('.bili-tab-pane[role="tabpanel"] > .comment-wrap > .bili-comment-container, .comment-wrap .bili-comment-container');
      if (!wrap || wrap.__bfqAppendPatched) return false;
      wrap.__bfqAppendPatched = true;
      const origin = wrap.appendChild.bind(wrap);
      wrap.appendChild = function (node) {
        if (node?.tagName === 'BILI-COMMENTS') return node;
        return origin(node);
      };
      return true;
    };
    if (!tryPatch()) {
      const timer = setInterval(() => { if (tryPatch()) clearInterval(timer); }, 300);
      setTimeout(() => clearInterval(timer), 15000);
    }
  }

  let duplicateOfficialCommentGuardInstalled = false;
  function installDuplicateOfficialCommentGuard() {
    if (duplicateOfficialCommentGuardInstalled) return;
    duplicateOfficialCommentGuardInstalled = true;

    const selector = [
      'bili-comments',
      '#commentapp',
      '.bili-comment-container',
      '.comment-wrap > .comment-container',
      '.comment-wrapper .common'
    ].join(',');

    const isOurCommentRoot = (el) => {
      if (!el || el.nodeType !== 1) return false;
      return el.id === 'bili-custom-comments'
        || el.id === 'bili-comment-list'
        || !!el.closest?.('#bili-custom-comments')
        || !!el.querySelector?.('#bili-custom-comments, #bili-comment-list');
    };

    const hideOfficialRoot = (el) => {
      if (!el || el.nodeType !== 1 || isOurCommentRoot(el) || !isSafeCommentHost(el)) return;
      el.dataset.bfqOfficialCommentHidden = '1';
      el.setAttribute('aria-hidden', 'true');
      el.style.setProperty('display', 'none', 'important');
    };

    const sweep = (root = document) => {
      // 自绘区成功挂载后才隐藏官方区，避免挂载失败时页面无评论可看。
      if (!document.getElementById('bili-comment-list')) return;
      if (root.nodeType === 1 && root.matches?.(selector)) hideOfficialRoot(root);
      root.querySelectorAll?.(selector).forEach(hideOfficialRoot);
    };

    sweep();
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === 1) sweep(node);
        });
      }
    });
    const start = () => {
      if (document.body) observer.observe(document.body, { childList: true, subtree: true });
    };
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  }

  async function initCommentModule() {
    if (!options.enableCommentUnlock) return;
    if (!isCommentDetailPage()) return;
    if (isBilibiliLoggedIn()) return;

    const target = await resolveCommentTarget();
    if (!target?.oid) {
      console.warn('[评论模块] 无法获取评论目标');
      return;
    }

    // 参考 DD1969：替换评论容器内部结构 + 自调 WBI API；不做全站 hide
    commentCurrentSortType = COMMENT_SORT.HOT;
    commentIsLoading = false;
    commentIsEnd = false;
    commentNextOffset = '';
    commentPageOffsets = [''];
    commentCurrentPage = 0;
    commentTotalCount = 0;

    GM_addStyle(`
#bili-custom-comments,.comment-container#bili-custom-comments{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB",sans-serif;font-size:14px;color:#222;padding:16px 0;min-height:120px}
.bili-comment-header{margin-bottom:8px}
.bili-comment-title{font-size:18px;font-weight:700;color:#18191c}
.bili-comment-sort{display:flex;gap:16px}
.sort-btn{cursor:pointer;color:#9499a0;font-size:14px;padding:4px 8px;border-radius:4px;transition:color .2s}
.sort-btn.active{color:#00aeec;font-weight:700}
.sort-btn:hover{color:#00aeec}
.reply-item{display:flex;gap:12px;padding:16px 0;border-bottom:1px solid #e3e5e7}
.reply-item.reply-top{background:#fef9f0;border-radius:8px;padding:16px;margin-bottom:8px;border-bottom:none}
.reply-avatar img{width:40px;height:40px;border-radius:50%;object-fit:cover;background:#e3e5e7}
.reply-main{flex:1;min-width:0}
.reply-header{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:6px}
.reply-username{color:#61666d;font-weight:600;text-decoration:none}
.reply-username:hover{color:#00aeec}
.reply-level{font-size:11px;padding:1px 4px;border-radius:3px;background:#e3e5e7;color:#9499a0}
.lv-3,.lv-4{background:#e8ffe8;color:#52c41a}
.lv-5,.lv-6{background:#fff7e6;color:#fa8c16}
.reply-up-badge{font-size:11px;padding:1px 4px;border-radius:3px;background:#fb7299;color:#fff}
.reply-up-badge-sm{font-size:10px;padding:0 3px}
.reply-text{color:#18191c;line-height:1.7;word-break:break-word;margin-bottom:8px}
.reply-emote{height:20px;vertical-align:middle}
.reply-mention{color:#00aeec;text-decoration:none}
.reply-footer{display:flex;align-items:center;gap:16px;color:#9499a0;font-size:12px}
.sub-reply-list{margin-top:10px;background:#f6f7f8;border-radius:8px;padding:8px 12px}
.sub-reply-item{display:flex;gap:8px;padding:6px 0;border-bottom:1px solid #e3e5e7}
.sub-reply-item:last-child{border-bottom:none}
.sub-reply-avatar img{width:24px;height:24px;border-radius:50%;object-fit:cover;background:#e3e5e7}
.sub-reply-main{flex:1;min-width:0;font-size:13px;line-height:1.6}
.sub-reply-username{color:#61666d;font-weight:600;text-decoration:none;margin-right:2px}
.sub-reply-username:hover{color:#00aeec}
.sub-reply-text{color:#18191c;word-break:break-word}
.sub-reply-time{color:#9499a0;font-size:11px;margin-left:6px}
.sub-reply-more{cursor:pointer;color:#00aeec;font-size:13px;padding:8px 0;text-align:center}
.sub-reply-more:hover{opacity:.8}
.sub-reply-loading{color:#9499a0;font-size:13px;padding:6px 0;text-align:center}
#bili-comment-pagination{display:flex;justify-content:center;align-items:center;gap:16px;padding:16px 0}
#bili-comment-pagination button{padding:6px 16px;border:1px solid #ddd;border-radius:4px;cursor:pointer;background:#fff;color:#555;transition:all .2s}
#bili-comment-pagination button:hover:not(:disabled){border-color:#00aeec;color:#00aeec}
#bili-comment-pagination button:disabled{opacity:.5;cursor:not-allowed}
#bili-page-info{color:#555;font-size:14px}
.bili-page-jump{display:flex;align-items:center;gap:6px;color:#555;font-size:14px}
#bili-jump-page-input{width:72px;height:30px;padding:0 8px;border:1px solid #ddd;border-radius:4px;outline:none}
#bili-jump-page-input:focus{border-color:#00aeec}
.login-tip,.fixed-reply-box{display:none!important}
`);

    let customEl;
    try {
      customEl = await setupStandardCommentContainer();
    } catch (e) {
      console.warn('[评论模块] 安全挂载失败，跳过评论重绘以免误伤顶栏:', e.message);
      return;
    }
    setupOfficialCommentModuleBlocker();
    installDuplicateOfficialCommentGuard();

    commentGeneration++;
    commentOid = target.oid;
    commentType = target.type;
    commentCreatorID = target.creator || 0;
    console.log(`[评论模块] 初始化，oid=${commentOid}, type=${commentType}, creator=${commentCreatorID}`);

    const bindSortAndPager = (root) => {
      root.querySelectorAll('.sort-btn').forEach(btn => {
        if (btn.dataset.bfqBound) return;
        btn.dataset.bfqBound = '1';
        btn.addEventListener('click', async () => {
          const sort = parseInt(btn.dataset.sort, 10);
          if (sort === commentCurrentSortType) return;
          commentCurrentSortType = sort;
          root.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          commentNextOffset = '';
          commentPageOffsets = [''];
          commentCurrentPage = 0;
          commentTotalCount = 0;
          commentIsEnd = false;
          const endEl = document.getElementById('bili-comment-end');
          if (endEl) endEl.style.display = 'none';
          await loadCommentPage('', false);
        });
      });

      if (options.enableReplyPagination) {
        document.getElementById('bili-next-page')?.addEventListener('click', async () => {
          if (commentIsEnd || commentIsLoading) return;
          commentCurrentPage++;
          await loadCommentPage(commentPageOffsets[commentCurrentPage] || '', false);
        }, { once: false });
        document.getElementById('bili-prev-page')?.addEventListener('click', async () => {
          if (commentCurrentPage <= 0 || commentIsLoading) return;
          commentCurrentPage--;
          commentIsEnd = false;
          await loadCommentPage(commentPageOffsets[commentCurrentPage] || '', false);
        }, { once: false });
        const jumpInput = document.getElementById('bili-jump-page-input');
        document.getElementById('bili-jump-page')?.addEventListener('click', async () => {
          await jumpToCommentPage(Number(jumpInput?.value));
        });
        jumpInput?.addEventListener('keydown', async (event) => {
          if (event.key === 'Enter') await jumpToCommentPage(Number(jumpInput.value));
        });
      } else {
        const anchor = document.getElementById('bili-scroll-anchor');
        if (anchor && !anchor.dataset.bfqBound) {
          anchor.dataset.bfqBound = '1';
          const scrollObserver = new IntersectionObserver(async () => {
            if (!commentIsLoading && !commentIsEnd && commentNextOffset) {
              await loadCommentPage(commentNextOffset, true);
            }
          }, { rootMargin: '300px' });
          scrollObserver.observe(anchor);
        }
      }
    };

    bindSortAndPager(customEl);
    await loadCommentPage('', false);

    // SPA 切视频：只重填列表，不重跑全站 DOM hide
    let lastCommentKey = `${commentType}:${commentOid}`;
    let commentSwitchChecking = false;
    setInterval(async () => {
      if (commentSwitchChecking) return;
      commentSwitchChecking = true;
      try {
        const nextTarget = await resolveCommentTarget();
        if (!nextTarget?.oid) return;
        const nextKey = `${nextTarget.type}:${nextTarget.oid}`;
        if (nextKey === lastCommentKey) return;
        lastCommentKey = nextKey;
        commentGeneration++;
        commentAbortController?.abort();
        commentAbortController = null;
        commentIsLoading = false;
        commentOid = nextTarget.oid;
        commentType = nextTarget.type;
        commentCreatorID = nextTarget.creator || 0;
        console.log(`[评论模块] 检测到页面切换，新 oid=${commentOid}, type=${commentType}`);

        // 若壳被 SPA 拆掉，仅在安全 host 上重建
        if (!document.getElementById('bili-comment-list')) {
          try {
            customEl = await setupStandardCommentContainer();
            bindSortAndPager(customEl);
            installDuplicateOfficialCommentGuard();
          } catch (e) {
            console.warn('[评论模块] SPA 重建跳过:', e.message);
            return;
          }
        }

        commentCurrentSortType = COMMENT_SORT.HOT;
        document.querySelectorAll('#bili-custom-comments .sort-btn, .comment-container .sort-btn').forEach(b => b.classList.remove('active'));
        document.querySelector('#bili-custom-comments .sort-btn[data-sort="2"], .comment-container .sort-btn[data-sort="2"]')?.classList.add('active');
        commentNextOffset = '';
        commentPageOffsets = [''];
        commentCurrentPage = 0;
        commentTotalCount = 0;
        commentIsEnd = false;
        const totalEl = document.getElementById('bili-total-reply');
        if (totalEl) totalEl.textContent = '0';
        const list = document.getElementById('bili-comment-list');
        if (list) list.innerHTML = '';
        const endEl = document.getElementById('bili-comment-end');
        if (endEl) endEl.style.display = 'none';
        loadCommentPage('', false);
      } finally {
        commentSwitchChecking = false;
      }
    }, 1500);
  }

  /* ========== 1. 主模块安装 ========== */

  installRcmdLoginGuard();
  installLiveAreaUnlock();
  installPlayurlUnlock();
  installAlwaysQualityGuard();
  setupDynamicCommentBtnModifier();

  /* ========== 初始化评论模块 ========== */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCommentModule);
  } else {
    initCommentModule();
  }

  // 倍速控制属于通用播放器功能，登录与未登录状态都安装。
  installPlaybackRateController();

  /* ========== 1. 如果已登录直接退出 ========== */
  if (isBilibiliLoggedIn()) return;

  /* ========== 2. 阻止登录弹窗 / 自动暂停 ========== */

  /* 2-1 登录遮罩 / 弹窗选择器 */
  const LOGIN_MASK_SELECTOR = [
    '.bili-mini-mask',
    '.bili-mini-login-mask',
    '.mini-login-mask',
    '.bili-login-v2-mask',
    '.login-panel-mask',
    '.v-popover-wrap .login-panel-popover',
    '[class*="login-mask"]',
    '[class*="mini-login-mask"]'
  ].join(',');

  const LOGIN_POPUP_SELECTOR = [
    '.bili-mini-login',
    '.mini-login',
    '.bili-login-v2-container',
    '.passport-login-pop',
    '.passport-login-container',
    '.login-panel-popover',
    '.bili-mini-login-right-panel',
    '.login-panel',
    '[class*="mini-login"]',
    '[class*="login-panel"]'
  ].join(',');

  const PLAYER_LOGIN_SELECTOR = [
    '.passport-login-tip-container',
    '.login-tip',
    '.bpx-player-toast-confirm-login',
    '.bpx-player-ending-content-login',
    '[class*="login-tip"]'
  ].join(',');

  /* 2-2 CSS：顶栏最高层级 + 更广登录层隐藏（仍避开顶栏内部） */
  GM_addStyle(`
    .bili-header, #bili-header-container, .bili-header__bar, #biliMainHeader, .fixed-header {
      position: relative !important; z-index: 100001 !important;
      pointer-events: auto !important; visibility: visible !important; opacity: 1 !important;
    }
    .bili-header .center-search-container, .bili-header .nav-search, .bili-header .nav-search-input,
    .bili-header .search-panel, .bili-header .search-panel-popover {
      position: relative !important; z-index: 100002 !important;
      pointer-events: auto !important; visibility: visible !important; opacity: 1 !important;
    }
    .bili-mini-mask, .bili-mini-login-mask, .mini-login-mask, .bili-login-v2-mask,
    .login-panel-mask, [class*="login-mask"], [class*="mini-login-mask"],
    body > .bili-mini-login, body > .mini-login, body > .bili-login-v2-container,
    body > .passport-login-pop, body > .passport-login-container,
    body > .login-panel-popover, body > .login-panel,
    .bpx-player-container .passport-login-tip-container,
    .bpx-player-container .login-tip {
      display: none !important; pointer-events: none !important;
      opacity: 0 !important; visibility: hidden !important;
    }
  `);

  // 2-3 兜底：DOM MutationObserver 处理仍漏出的弹窗
  const hideElement = (el) => {
    if (!el || el.nodeType !== 1) return;
    el.style.setProperty('display', 'none', 'important');
    el.style.setProperty('pointer-events', 'none', 'important');
    el.style.setProperty('opacity', '0', 'important');
    el.style.setProperty('visibility', 'hidden', 'important');
  };

  const isInHeader = (el) => !!el.closest?.(
    '.bili-header, #bili-header-container, .bili-header__bar, #biliMainHeader, .fixed-header'
  );

  const isViewportLoginLayer = (el) => {
    if (!el || el.nodeType !== 1 || isInHeader(el)) return false;
    // 顶栏登录按钮本身不隐藏
    if (el.closest?.('.header-login-entry, .header-avatar-wrap, .right-entry')) return false;
    if (el.matches?.(LOGIN_MASK_SELECTOR) || el.matches?.(LOGIN_POPUP_SELECTOR)) return true;

    const cls = typeof el.className === 'string' ? el.className : '';
    const looksLogin = /mini-login|login-panel|login-mask|passport-login|bili-login/i.test(cls);
    if (!looksLogin && !el.matches?.(PLAYER_LOGIN_SELECTOR)) return false;

    const style = unsafeWindow.getComputedStyle?.(el) || getComputedStyle(el);
    const rect = el.getBoundingClientRect?.();
    const isLayerPosition = ['fixed', 'absolute', 'sticky'].includes(style.position) || el.parentElement === document.body;
    const isLargeLayer = rect && rect.width >= Math.min(280, unsafeWindow.innerWidth * 0.3) && rect.height >= Math.min(160, unsafeWindow.innerHeight * 0.18);
    const hasLoginForm = !!el.querySelector?.('input[type="password"], input[placeholder*="密码"], input[placeholder*="登录"], button, [class*="login"]');
    return isLayerPosition && (isLargeLayer || hasLoginForm || looksLogin);
  };

  const hideLoginLayersInNode = (node) => {
    if (!node || node.nodeType !== 1) return;
    if (isViewportLoginLayer(node)) hideElement(node);
    node.querySelectorAll?.(`${LOGIN_MASK_SELECTOR},${LOGIN_POPUP_SELECTOR},${PLAYER_LOGIN_SELECTOR}`)?.forEach((el) => {
      if (isInHeader(el)) return;
      if (el.closest?.('.header-login-entry, .header-avatar-wrap, .right-entry')) return;
      hideElement(el);
    });
    // 类名模糊匹配：覆盖 B 站改版后的登录层
    node.querySelectorAll?.('[class*="mini-login"], [class*="login-mask"], [class*="login-panel"], [class*="passport-login"]')?.forEach((el) => {
      if (isInHeader(el)) return;
      if (el.closest?.('.header-login-entry, .header-avatar-wrap, .right-entry')) return;
      if (isViewportLoginLayer(el) || /mask|panel|pop|modal|dialog/i.test(el.className || '')) hideElement(el);
    });
  };

  if (document.documentElement) hideLoginLayersInNode(document.documentElement);

  const startLoginLayerGuard = () => {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => hideLoginLayersInNode(node));
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  };

  if (document.body) {
    startLoginLayerGuard();
  } else {
    document.addEventListener('DOMContentLoaded', startLoginLayerGuard, { once: true });
  }

  (function blockLoginAndAutoPause() {
    /* 2-1 等待播放器就绪后屏蔽 getMediaInfo 返回值 */
    const waitPlayer = () => new Promise((resolve, reject) => {
      const maxAttempts = 50; // 最多等待15秒
      let attempts = 0;
      const checkPlayer = setInterval(() => {
        if (unsafeWindow.player && unsafeWindow.player.getMediaInfo) {
          clearInterval(checkPlayer);
          resolve();
        } else if (++attempts >= maxAttempts) {
          clearInterval(checkPlayer);
          reject(new Error('Player initialization timeout'));
        }
      }, CONFIG.PLAYER_CHECK_INTERVAL);
    });

    waitPlayer().then(() => {
      const player = unsafeWindow.player;
      const originGet = player.getMediaInfo;
      player.getMediaInfo = function () {
        const info = originGet.call(this);
        return { absolutePlayTime: 0, relativePlayTime: info.relativePlayTime, playUrl: info.playUrl };
      };

      let lastTrustedActionTime = 0;
      let allowInternalPause = false;
      let currentMedia = null;
      let isUserPaused = false;
      let hasPlaybackStarted = false;
      let hasMediaEnded = false;

      const markTrustedAction = (event) => {
        if (event && event.isTrusted === false) return;
        lastTrustedActionTime = Date.now();
      };

      const canPauseNow = () => {
        return allowInternalPause || Date.now() - lastTrustedActionTime <= CONFIG.CLICK_TIMEOUT;
      };

      const isAtMediaEnd = (media) => {
        if (!media) return false;
        if (media.ended) return true;
        return Number.isFinite(media.duration)
          && media.duration > 0
          && media.currentTime >= media.duration - 0.5;
      };

      document.addEventListener('pointerdown', markTrustedAction, { passive: true, capture: true });
      document.addEventListener('keydown', (e) => {
        if (!e.isTrusted) return;
        if (e.code === 'Space' || e.code === 'KeyK' || e.key === ' ' || e.key === 'k' || e.key === 'K') {
          markTrustedAction(e);
        }
      }, { passive: true, capture: true });

      const originPause = typeof player.pause === 'function' ? player.pause.bind(player) : null;
      if (originPause) {
        player.pause = function () {
          if (currentMedia && !hasPlaybackStarted) return originPause(...arguments);
          if (isAtMediaEnd(currentMedia)) return originPause(...arguments);
          if (!canPauseNow()) return;
          return originPause(...arguments);
        };
      }

      // 自动 play() 常触发浏览器自动播放静音策略；记录用户音量意图并恢复
      let userWantsMuted = false;
      let lastGoodVolume = 0.8;
      try {
        const bootMedia = player.mediaElement?.();
        if (bootMedia && typeof bootMedia.volume === 'number' && bootMedia.volume > 0) {
          lastGoodVolume = bootMedia.volume;
        }
        if (bootMedia) userWantsMuted = !!bootMedia.muted && bootMedia.volume === 0;
      } catch (e) {}

      const rememberVolumeFrom = (media) => {
        try {
          if (!media) return;
          if (!media.muted && media.volume > 0) {
            lastGoodVolume = media.volume;
            userWantsMuted = false;
          }
        } catch (e) {}
      };

      const restoreUnmute = (media, reason = 'auto') => {
        if (!media || userWantsMuted) return false;
        try {
          if (media.muted || media.volume === 0) {
            media.muted = false;
            if (media.volume === 0) media.volume = lastGoodVolume || 0.8;
            console.log('[Bilibili脚本] 恢复非静音播放:', reason, 'volume=', media.volume);
            return true;
          }
        } catch (e) {}
        return false;
      };

      const safePlay = (media, reason = 'resume') => {
        if (!media || hasMediaEnded || isAtMediaEnd(media)) return Promise.resolve();
        return Promise.resolve(media.play()).then(() => {
          // 自动播放策略可能把视频静音；立即尝试恢复，用户手势后再保底一次
          restoreUnmute(media, reason);
        }).catch(() => {});
      };

      document.addEventListener('volumechange', (e) => {
        const m = e.target;
        if (!m || m.tagName !== 'VIDEO' && m.tagName !== 'AUDIO') return;
        try {
          if (m.muted || m.volume === 0) {
            // 仅在近期有用户操作时视为用户主动静音
            if (Date.now() - lastTrustedActionTime <= CONFIG.CLICK_TIMEOUT) {
              userWantsMuted = true;
            }
          } else {
            userWantsMuted = false;
            lastGoodVolume = m.volume > 0 ? m.volume : lastGoodVolume;
          }
        } catch (err) {}
      }, true);

      // 用户首次点击/按键后强制取消脚本触发的静音
      const unmuteOnGesture = () => {
        try {
          const media = currentMedia || unsafeWindow.player?.mediaElement?.();
          restoreUnmute(media, 'user-gesture');
          document.querySelectorAll('video').forEach((v) => restoreUnmute(v, 'user-gesture-all'));
        } catch (e) {}
      };
      document.addEventListener('pointerdown', unmuteOnGesture, { capture: true, passive: true });
      document.addEventListener('keydown', unmuteOnGesture, { capture: true, passive: true });

      const bindMediaGuard = (media) => {
        if (!media || media.dataset.bfqPauseGuardBound) return;
        const originMediaPause = media.pause.bind(media);
        rememberVolumeFrom(media);

        media.pause = function () {
          if (!hasPlaybackStarted) return originMediaPause();
          if (isAtMediaEnd(media)) return originMediaPause();
          if (!canPauseNow()) return;
          return originMediaPause();
        };

        media.addEventListener('pause', () => {
          if (media !== currentMedia || !media.isConnected) return;
          if (!hasPlaybackStarted) return;
          if (allowInternalPause) return;
          if (hasMediaEnded || isAtMediaEnd(media)) {
            hasMediaEnded = true;
            return;
          }

          if (Date.now() - lastTrustedActionTime <= CONFIG.CLICK_TIMEOUT) {
            isUserPaused = true;
            return;
          }

          isUserPaused = false;
          safePlay(media, 'anti-pause');
        }, true);

        media.addEventListener('play', () => {
          if (media !== currentMedia || !media.isConnected) return;
          hasMediaEnded = false;
          hasPlaybackStarted = true;
          isUserPaused = false;
          restoreUnmute(media, 'play-event');
        }, true);

        media.addEventListener('playing', () => {
          if (media !== currentMedia || !media.isConnected) return;
          restoreUnmute(media, 'playing-event');
        }, true);

        media.addEventListener('ended', () => {
          if (media !== currentMedia || !media.isConnected) return;
          hasMediaEnded = true;
          isUserPaused = false;
        }, true);

        media.addEventListener('loadedmetadata', () => {
          hasMediaEnded = false;
          rememberVolumeFrom(media);
          // 刷新后媒体常以 muted 初始化，若用户未主动静音则恢复
          setTimeout(() => restoreUnmute(media, 'loadedmetadata'), 50);
          setTimeout(() => restoreUnmute(media, 'loadedmetadata-delay'), 500);
        }, true);

        media.dataset.bfqPauseGuardBound = '1';
      };

      const trackCurrentMedia = () => {
        try {
          const media = unsafeWindow.player?.mediaElement?.();
          if (media && media !== currentMedia) {
            currentMedia = media;
            hasMediaEnded = !!media.ended;
            hasPlaybackStarted = !media.paused && !media.ended;
            isUserPaused = false;
            bindMediaGuard(media);
          }
        } catch (e) {}
      };

      trackCurrentMedia();
      setInterval(trackCurrentMedia, 500);

      if (player && typeof player.mediaElement === 'function') {
        const originMediaElementGetter = player.mediaElement.bind(player);
        player.mediaElement = function () {
          const media = originMediaElementGetter();
          bindMediaGuard(media);
          if (media && media !== currentMedia) {
            currentMedia = media;
            hasMediaEnded = !!media.ended;
            hasPlaybackStarted = !media.paused && !media.ended;
            isUserPaused = false;
          } else {
            currentMedia = media || currentMedia;
          }
          return media;
        };
      }

      setInterval(() => {
        const media = currentMedia;
        if (!media || !hasPlaybackStarted || hasMediaEnded || media.ended || document.hidden || allowInternalPause || isUserPaused) return;
        if (media.paused) {
          safePlay(media, 'auto-resume');
        } else if (media.muted && !userWantsMuted) {
          restoreUnmute(media, 'auto-resume-unmute');
        }
      }, CONFIG.AUTO_RESUME_INTERVAL);

      unsafeWindow.__BFQ_ALLOW_INTERNAL_PAUSE__ = () => {
        allowInternalPause = true;
        setTimeout(() => {
          allowInternalPause = false;
        }, CONFIG.CLICK_TIMEOUT);
      };
    }).catch(err => {
      console.warn('[Bilibili脚本] 播放器初始化失败:', err);
    });
  })();

  /* ========== 客户端兜底（关闭协议级解锁时启用）========== */
  const installClientArchFallback = () => {
    const originDef = Object.defineProperty;
    let definePropertyCallCount = 0;
    Object.defineProperty = function (obj, prop, desc) {
      if (prop === 'isViewToday' || prop === 'isVideoAble') {
        let isLikelyPlayerState = true;
        try {
          if (obj === globalThis || obj === unsafeWindow || obj === window) isLikelyPlayerState = false;
          else if (obj instanceof Element) isLikelyPlayerState = false;
          else if (desc && 'value' in desc && !('get' in desc) && !('set' in desc)) isLikelyPlayerState = false;
          else if (desc && typeof desc.get === 'function') {
            const getterText = String(desc.get);
            if (!/play|trial|view|able|quality|qn/i.test(getterText)) {
              isLikelyPlayerState = false;
            }
          }
        } catch (e) { isLikelyPlayerState = false; }

        definePropertyCallCount++;
        if (isLikelyPlayerState) {
          desc = { get: () => true, enumerable: false, configurable: true };
        }
      }
      return originDef.call(this, obj, prop, desc);
    };

    /* 3-2 试用倒计时延长到 3 亿秒 */
    const originSetTimeout = unsafeWindow.setTimeout;
    const originSetInterval = unsafeWindow.setInterval;
    const shouldExtendTrialTimer = (fn, delayNum) => {
      if (delayNum !== 30000 && delayNum !== 60000 && delayNum !== 62000 && delayNum !== 90000) return false;
      const fnText = typeof fn === 'function' ? String(fn) : String(fn || '');
      return (
        fnText.includes('试看') ||
        fnText.includes('trial') ||
        fnText.includes('isViewToday') ||
        fnText.includes('isVideoAble') ||
        fnText.includes('absolutePlayTime')
      );
    };

    unsafeWindow.setTimeout = (fn, delay) => {
      const delayNum = Number(delay);
      if (shouldExtendTrialTimer(fn, delayNum)) {
        delay = CONFIG.TRIAL_TIMEOUT;
      }
      return originSetTimeout.call(unsafeWindow, fn, delay);
    };
    unsafeWindow.setInterval = (fn, delay) => {
      const delayNum = Number(delay);
      if (shouldExtendTrialTimer(fn, delayNum)) {
        delay = CONFIG.TRIAL_TIMEOUT;
      }
      return originSetInterval.call(unsafeWindow, fn, delay);
    };

    /* 3-3 点击试用按钮 + 画质切换 + 兜底拔高 */
    const QUALITY_MAP = { 1080: 80, 720: 64, 480: 32, 360: 16 };
    const TARGET_QUALITY = () => QUALITY_MAP[options.preferQuality] || 80;

    let qualityDropWatcherStarted = false;
    let reUnlockTimerId = null;

    const requestTargetQuality = (reason = 'manual') => {
      const target = TARGET_QUALITY();
      try {
        if (unsafeWindow.player?.getSupportedQualityList?.()?.includes(target)) {
          Promise.resolve(unsafeWindow.player.requestQuality(target)).catch((err) => {
            if (!String(err?.message || err).includes('Same as current quality')) {
              console.warn('[Bilibili脚本] 画质切换失败:', err, '来源:', reason);
            }
          });
          return true;
        }
      } catch (err) {
        console.warn('[Bilibili脚本] 画质切换失败:', err, '来源:', reason);
      }
      return false;
    };

    // 试用后再补一次画质请求
    const scheduleReUnlockAfterTrial = () => {
      requestTargetQuality('reunlock-immediate');
      startQualityDropWatcher();
      if (reUnlockTimerId) clearTimeout(reUnlockTimerId);
      reUnlockTimerId = originSetTimeout.call(unsafeWindow, () => {
        requestTargetQuality('reunlock-after-trial');
        startQualityDropWatcher();
      }, CONFIG.RE_UNLOCK_DELAY);
    };

    // 画质掉回低时自动拔高
    const startQualityDropWatcher = () => {
      if (qualityDropWatcherStarted) return;
      qualityDropWatcherStarted = true;

      originSetInterval.call(unsafeWindow, () => {
        try {
          const cur = unsafeWindow.player?.getCurrentQuality?.();
          const supported = unsafeWindow.player?.getSupportedQualityList?.();
          const target = TARGET_QUALITY();
          if (cur != null && supported?.includes(target) && cur !== target) {
            requestTargetQuality('drop-watch');
          }
        } catch (err) {}
      }, CONFIG.RE_UNLOCK_INTERVAL);

      try {
        const player = unsafeWindow.player;
        const media = player?.mediaElement?.();
        if (media && typeof media.addEventListener === 'function') {
          media.addEventListener('media_qualitychange' in media ? 'media_qualitychange' : 'qualitychange', () => {
            try {
              const cur = player?.getCurrentQuality?.();
              const target = TARGET_QUALITY();
              if (cur != null && cur !== target) requestTargetQuality('qualitychange-event');
            } catch (err) {}
          });
        }
      } catch (err) {}
    };

    // 使用 MutationObserver 而不是 setInterval 来监听按钮出现，性能更好
    const observeTrialButton = () => {
      const observer = new MutationObserver(() => {
        const btn = document.querySelector('.bpx-player-toast-confirm-login');
        if (!btn) return;
        if (btn.dataset.clicked) return;
        btn.dataset.clicked = 'true';

        setTimeout(() => {
          btn.click();
          scheduleReUnlockAfterTrial();
          startQualityDropWatcher();

          if (options.isWaitUntilHighQualityLoaded && unsafeWindow.player?.mediaElement) {
            const media = unsafeWindow.player.mediaElement();
            const wasPlaying = !media.paused;
            if (wasPlaying) {
              unsafeWindow.__BFQ_ALLOW_INTERNAL_PAUSE__?.();
              media.pause();
            }
            const checkToast = setInterval(() => {
              const toastTexts = document.querySelectorAll('.bpx-player-toast-text');
              if ([...toastTexts].some(el => el.textContent.endsWith('试用中'))) {
                if (wasPlaying) {
                  media.play().then(() => {
                    try {
                      if (media.muted && media.volume === 0) { /* keep */ }
                      else if (media.muted) { media.muted = false; }
                    } catch (e) {}
                  }).catch(() => {});
                }
                clearInterval(checkToast);
                requestTargetQuality('trial-toast-detected');
              }
            }, CONFIG.TOAST_CHECK_INTERVAL);
            setTimeout(() => clearInterval(checkToast), 10000);
          }

          setTimeout(() => requestTargetQuality('trial-button'), CONFIG.QUALITY_SWITCH_DELAY);
          setTimeout(() => delete btn.dataset.clicked, 2000);
        }, CONFIG.BUTTON_CLICK_DELAY);
      });

      observer.observe(document.body, { childList: true, subtree: true });
    };

    if (document.body) observeTrialButton();
    else document.addEventListener('DOMContentLoaded', observeTrialButton);
  };

  if (!options.enableProtocolUnlock) {
    installClientArchFallback();
  }


  /* 倍速控制模块（参考 polywock/globalSpeed 的 GhostMode：原型级 playbackRate setter 拦截 + 校验回写，强制绕过站点自定义 setter）
     MIT License, Copyright (c) polywock — 仅借鉴核心兼容机制，缩窄到 B 站 media 元素 */
  function installPlaybackRateController() {
    const isVideoPage = isPlaybackPage();
    const isLivePage = PAGE_RE.live.test(location.href);

    const proto = (unsafeWindow.HTMLMediaElement || HTMLMediaElement).prototype;
    const ogDesc = Object.getOwnPropertyDescriptor(proto, 'playbackRate');
    if (!ogDesc || !ogDesc.get || !ogDesc.set) return;
    if (proto.__bfqRatePatched) return; // 与 globalSpeed 等共存：已 hook 过就不重复
    proto.__bfqRatePatched = true;

    const clipsTargetRate = new WeakMap();
    const isBiliMedia = (el) => {
      try { return el instanceof HTMLMediaElement; } catch (e) { return false; }
    };

    const applyRate = (el, rate) => {
      if (!el || !isBiliMedia(el)) return false;
      try {
        ogDesc.set.call(el, rate);
        if (Math.abs(ogDesc.get.call(el) - rate) > 0.001) ogDesc.set.call(el, rate);
        clipsTargetRate.set(el, rate);
        return Math.abs(ogDesc.get.call(el) - rate) < 0.001;
      } catch (e) { return false; }
    };

    // 原型级覆盖 setter：站点后续 set 都会被记录并校正回来（借鉴 globalSpeed GhostMode）
    Object.defineProperty(proto, 'playbackRate', {
      configurable: true,
      enumerable: true,
      get() { return ogDesc.get.call(this); },
      set(v) {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return ogDesc.set.call(this, v);
        clipsTargetRate.set(this, n);
        ogDesc.set.call(this, n);
        if (Math.abs(ogDesc.get.call(this) - n) > 0.001) ogDesc.set.call(this, n);
      },
    });

    const applyToAllMedia = () => {
      if (!options.enablePlaybackRateControl && !holdRateActive) return;
      document.querySelectorAll('video, audio').forEach(m => {
        if (!isBiliMedia(m)) return;
        const target = holdRateActive && m === holdRateMedia ? options.holdPlaybackRate : options.playbackRate;
        if (target === 1) return;
        const cur = ogDesc.get.call(m);
        if (Math.abs(cur - target) > 0.001) applyRate(m, target);
      });
    };

    let enforceTimer = null;
    const mediaObserver = new MutationObserver(() => applyToAllMedia());
    const startEnforce = () => {
      if (enforceTimer) return;
      enforceTimer = setInterval(applyToAllMedia, 1500);
      if (isVideoPage || isLivePage) {
        try { mediaObserver.observe(document.body, { childList: true, subtree: true }); } catch (e) {}
      }
    };
    const stopEnforce = () => {
      if (enforceTimer) { clearInterval(enforceTimer); enforceTimer = null; }
      mediaObserver.disconnect();
    };
    if (options.enablePlaybackRateControl && options.playbackRate !== 1) startEnforce();

    document.addEventListener('ratechange', (e) => {
      const m = e.target;
      if ((!options.enablePlaybackRateControl && !(holdRateActive && m === holdRateMedia)) || !isBiliMedia(m)) return;
      const target = holdRateActive && m === holdRateMedia
        ? options.holdPlaybackRate
        : (clipsTargetRate.get(m) || options.playbackRate);
      if (!target || target === 1) return;
      const cur = ogDesc.get.call(m);
      if (Math.abs(cur - target) > 0.001) ogDesc.set.call(m, target);
    }, true);

    /* ===== 倍速按钮（播放器原生右侧控制栏） ===== */
    GM_addStyle(`
#bfq-speed-control{position:relative;display:flex;align-items:center;align-self:stretch;height:100%;flex:0 0 auto}
#bfq-speed-btn{display:flex;align-items:center;justify-content:center;gap:4px;padding:0 8px;height:100%;min-width:48px;color:#fff;cursor:pointer;font-size:13px;user-select:none;white-space:nowrap;opacity:.9;transition:opacity .2s}
#bfq-speed-btn:hover{opacity:1}
:fullscreen #bfq-speed-control,:-webkit-full-screen #bfq-speed-control{display:none!important}
#bfq-speed-btn .bfq-speed-label{font-weight:600;letter-spacing:.5px}
#bfq-speed-btn .bfq-speed-chev{font-size:10px;opacity:.7;margin-left:2px}
.bfq-speed-pop{position:absolute;bottom:calc(100% + 8px);right:0;z-index:1001;min-width:210px;padding:8px 0;background:#fff;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.25);font-family:sans-serif;display:none}
.bfq-speed-pop.show{display:block}
.bfq-speed-pop .bfq-row{padding:8px 14px;font-size:14px;color:#333;cursor:pointer;display:flex;justify-content:space-between;align-items:center}
.bfq-speed-pop .bfq-row:hover{background:#f4f5f7}
.bfq-speed-pop .bfq-row.active{color:#00aeec;font-weight:700}
.bfq-speed-pop .bfq-row.active::after{content:'✓';color:#00aeec}
.bfq-speed-pop .bfq-divider{height:1px;background:#eee;margin:4px 0}
.bfq-speed-pop .bfq-custom{padding:8px 14px}
.bfq-speed-pop .bfq-custom-label{font-size:12px;color:#666;margin-bottom:6px}
.bfq-speed-pop .bfq-custom-row{display:flex;gap:6px}
.bfq-speed-pop .bfq-custom-row input{flex:1;width:60px;padding:4px 8px;border:1px solid #ddd;border-radius:6px;font-size:13px;outline:none}
.bfq-speed-pop .bfq-custom-row input:focus{border-color:#00aeec}
.bfq-speed-pop .bfq-custom-row button{padding:4px 10px;background:#00aeec;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px}
.bfq-speed-pop .bfq-custom-row button:hover{background:#0098d1}
.bfq-speed-pop .bfq-toggle{padding:8px 14px;font-size:12px;color:#666;border-top:1px solid #eee;display:flex;justify-content:space-between;align-items:center;cursor:pointer}
.bfq-speed-pop .bfq-toggle:hover{background:#f4f5f7}
.bfq-speed-pop .bfq-toggle .bfq-mini-switch{width:32px;height:18px;background:#ccc;border-radius:9px;position:relative;transition:background .2s}
.bfq-speed-pop .bfq-toggle .bfq-mini-switch.on{background:#00aeec}
.bfq-speed-pop .bfq-toggle .bfq-mini-switch::after{content:'';position:absolute;top:2px;left:2px;width:14px;height:14px;background:#fff;border-radius:50%;transition:left .2s}
.bfq-speed-pop .bfq-toggle .bfq-mini-switch.on::after{left:16px}
.bfq-seek-layer{position:absolute;inset:0;z-index:20;pointer-events:none;display:flex;align-items:center;justify-content:space-between;padding:0 18%;opacity:0;visibility:hidden;transition:opacity .18s,visibility .18s}
.bfq-seek-layer.show{opacity:1;visibility:visible}
.bfq-seek-btn{pointer-events:auto;width:58px;height:58px;border:0;border-radius:50%;background:rgba(0,0,0,.58);color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;cursor:pointer;box-shadow:0 3px 16px rgba(0,0,0,.3);font-family:sans-serif;transition:transform .15s,background .15s}
.bfq-seek-btn:hover{background:rgba(0,0,0,.75);transform:scale(1.06)}
.bfq-seek-btn .bfq-seek-icon{font-size:22px;line-height:20px}
.bfq-seek-btn .bfq-seek-time{font-size:11px;font-weight:700;line-height:14px}
.bfq-hold-rate-indicator{position:absolute;left:50%;top:16%;z-index:22;transform:translate(-50%,-8px);padding:8px 14px;border-radius:18px;background:rgba(0,0,0,.68);color:#fff;font:600 14px/1.2 sans-serif;pointer-events:none;opacity:0;visibility:hidden;transition:opacity .18s,transform .18s,visibility .18s}
.bfq-hold-rate-indicator.show{opacity:1;visibility:visible;transform:translate(-50%,0)}
.bfq-seek-btn[data-seek-action="forward"]{-webkit-touch-callout:none;touch-action:none}
    `);

    const SPEED_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];
    const fmtRate = (n) => {
      const r = Number(n);
      if (Number.isInteger(r)) return `${r}x`;
      return `${r.toFixed(2).replace(/0$/, '')}x`;
    };

    const getPlayerUi = () => {
      const player = document.querySelector('.bpx-player-container') ||
        document.querySelector('.bilibili-player-video-wrap')?.closest('.bilibili-player');
      if (!player) return null;
      const controls = player.querySelector('.bpx-player-control-bottom-right') ||
        player.querySelector('.bilibili-player-video-control-bottom-right');
      const video = player.querySelector('video');
      const videoWrap = player.querySelector('.bpx-player-video-wrap') ||
        player.querySelector('.bilibili-player-video-wrap') || player;
      return { player, controls, video, videoWrap };
    };

    const isPlayerUiReady = (ui) => {
      if (!ui?.controls || !ui.video || document.hidden) return false;
      const rect = ui.controls.getBoundingClientRect();
      return ui.controls.isConnected && ui.video.isConnected &&
        ui.video.readyState >= HTMLMediaElement.HAVE_METADATA &&
        rect.width > 0 && rect.height > 0;
    };

    let controlEl = null;
    let btnEl = null;
    let popEl = null;
    let seekLayerEl = null;
    let seekHideTimer = null;
    let holdIndicatorEl = null;
    let holdTimer = null;
    let holdPointerId = null;
    let holdStartX = 0;
    let holdStartY = 0;
    let holdRateActive = false;
    let holdRateMedia = null;
    let holdRestoreRate = 1;
    let holdPointerHost = null;
    let suppressNextForwardClick = false;
    const boundSeekHosts = new WeakSet();

    const syncFullscreenUi = () => {
      const isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);
      if (controlEl) controlEl.style.display = isFullscreen ? 'none' : '';
      if (isFullscreen && popEl) popEl.classList.remove('show');
    };

    document.addEventListener('fullscreenchange', syncFullscreenUi);
    document.addEventListener('webkitfullscreenchange', syncFullscreenUi);

    const refreshBtnLabel = () => {
      if (btnEl) btnEl.querySelector('.bfq-speed-label').textContent = `▶ ${fmtRate(options.playbackRate)}`;
    };

    const refreshPop = () => {
      if (!popEl) return;
      const customActive = SPEED_PRESETS.every(s => Math.abs(s - options.playbackRate) >= 0.001);
      const presetRows = SPEED_PRESETS.map(s => {
        const active = Math.abs(s - options.playbackRate) < 0.001 ? 'active' : '';
        return `<div class="bfq-row ${active}" data-rate="${s}">${fmtRate(s)}</div>`;
      }).join('');
      popEl.innerHTML = `
        ${presetRows}
        <div class="bfq-divider"></div>
        <div class="bfq-row ${customActive ? 'active' : ''}" data-rate="custom">自定义 ${fmtRate(options.customPlaybackRate)}</div>
        <div class="bfq-custom">
          <div class="bfq-custom-label">输入自定义倍速 (0.07-16)</div>
          <div class="bfq-custom-row">
            <input type="number" min="0.07" max="16" step="0.05" value="${options.customPlaybackRate}" />
            <button data-action="apply-rate">应用</button>
          </div>
        </div>
        <div class="bfq-divider"></div>
        <div class="bfq-custom bfq-seek-config">
          <div class="bfq-custom-label">左右跳转秒数 (1-300)</div>
          <div class="bfq-custom-row">
            <input data-seek="backward" type="number" min="1" max="300" step="1" value="${options.seekBackwardSeconds}" title="后退秒数" />
            <input data-seek="forward" type="number" min="1" max="300" step="1" value="${options.seekForwardSeconds}" title="前进秒数" />
            <button data-action="apply-seek">应用</button>
          </div>
        </div>
        <div class="bfq-divider"></div>
        <div class="bfq-custom bfq-hold-rate-config">
          <div class="bfq-custom-label">长按前进按钮 2 秒临时倍速 (1-16)</div>
          <div class="bfq-custom-row">
            <input data-hold-rate type="number" min="1" max="16" step="0.25" value="${options.holdPlaybackRate}" title="临时倍速" />
            <button data-action="apply-hold-rate">应用</button>
          </div>
        </div>
        <div class="bfq-divider"></div>
        <div class="bfq-toggle" data-toggle="enable">
          <span>启用倍速强制</span>
          <span class="bfq-mini-switch ${options.enablePlaybackRateControl ? 'on' : ''}"></span>
        </div>`;
    };

    const setRate = (rate) => {
      let r = Number(rate);
      if (!Number.isFinite(r)) return;
      r = Math.max(0.07, Math.min(16, r));
      options.playbackRate = r;
      GM_setValue('playbackRate', r);
      applyToAllMedia();
      refreshBtnLabel();
      refreshPop();
      if (options.enablePlaybackRateControl && r !== 1) startEnforce(); else stopEnforce();
      console.log('[Bilibili脚本] 倍速设置为', r);
    };

    const onPopClick = (e) => {
      const row = e.target.closest?.('.bfq-row');
      if (row) {
        if (row.dataset.rate === 'custom') setRate(options.customPlaybackRate);
        else setRate(Number(row.dataset.rate));
        return;
      }
      const applyBtn = e.target.closest?.('button');
      if (applyBtn) {
        if (applyBtn.dataset.action === 'apply-rate') {
          const input = applyBtn.closest('.bfq-custom')?.querySelector('input');
          const v = Number(input?.value);
          if (Number.isFinite(v) && v > 0) {
            options.customPlaybackRate = v;
            GM_setValue('customPlaybackRate', v);
            setRate(v);
          }
        } else if (applyBtn.dataset.action === 'apply-seek') {
          const root = applyBtn.closest('.bfq-seek-config');
          const backward = Math.max(1, Math.min(300, Math.round(Number(root?.querySelector('[data-seek="backward"]')?.value) || 10)));
          const forward = Math.max(1, Math.min(300, Math.round(Number(root?.querySelector('[data-seek="forward"]')?.value) || 15)));
          options.seekBackwardSeconds = backward;
          options.seekForwardSeconds = forward;
          GM_setValue('seekBackwardSeconds', backward);
          GM_setValue('seekForwardSeconds', forward);
          refreshPop();
          refreshSeekLabels();
        } else if (applyBtn.dataset.action === 'apply-hold-rate') {
          const value = Number(applyBtn.closest('.bfq-hold-rate-config')?.querySelector('[data-hold-rate]')?.value);
          options.holdPlaybackRate = Math.max(1, Math.min(16, Number.isFinite(value) ? value : 2));
          GM_setValue('holdPlaybackRate', options.holdPlaybackRate);
          refreshPop();
          refreshSeekLabels();
        }
        return;
      }
      const toggle = e.target.closest?.('.bfq-toggle');
      if (toggle) {
        options.enablePlaybackRateControl = !options.enablePlaybackRateControl;
        GM_setValue('enablePlaybackRateControl', options.enablePlaybackRateControl);
        const sw = toggle.querySelector('.bfq-mini-switch');
        if (sw) sw.classList.toggle('on', options.enablePlaybackRateControl);
        if (options.enablePlaybackRateControl) {
          applyToAllMedia();
          if (options.playbackRate !== 1) startEnforce();
        } else {
          stopEnforce();
          document.querySelectorAll('video, audio').forEach(m => applyRate(m, 1));
        }
      }
    };

    const buildBtn = () => {
      const btn = document.createElement('div');
      btn.id = 'bfq-speed-btn';
      btn.title = '脚本倍速控制';
      btn.innerHTML = `<span class="bfq-speed-label">▶ ${fmtRate(options.playbackRate)}</span><span class="bfq-speed-chev">▾</span>`;
      return btn;
    };

    const refreshSeekLabels = () => {
      if (!seekLayerEl) return;
      const backward = seekLayerEl.querySelector('[data-seek-action="backward"] .bfq-seek-time');
      const forward = seekLayerEl.querySelector('[data-seek-action="forward"] .bfq-seek-time');
      if (backward) backward.textContent = `${options.seekBackwardSeconds}s`;
      if (forward) forward.textContent = `${options.seekForwardSeconds}s`;
      const backwardButton = seekLayerEl.querySelector('[data-seek-action="backward"]');
      const forwardButton = seekLayerEl.querySelector('[data-seek-action="forward"]');
      if (backwardButton) backwardButton.title = `后退 ${options.seekBackwardSeconds} 秒`;
      if (forwardButton) forwardButton.title = `点击前进 ${options.seekForwardSeconds} 秒，长按临时 ${fmtRate(options.holdPlaybackRate)}`;
    };

    const hideSeekControls = () => {
      if (seekHideTimer) clearTimeout(seekHideTimer);
      seekHideTimer = null;
      seekLayerEl?.classList.remove('show');
    };

    const showSeekControls = () => {
      seekLayerEl?.classList.add('show');
      if (seekHideTimer) clearTimeout(seekHideTimer);
      seekHideTimer = setTimeout(hideSeekControls, 2000);
    };

    const seekVideo = (direction) => {
      const video = getPlayerUi()?.video;
      if (!video || !Number.isFinite(video.currentTime)) return;
      const delta = direction === 'backward' ? -options.seekBackwardSeconds : options.seekForwardSeconds;
      const maxTime = Number.isFinite(video.duration) ? video.duration : video.currentTime + Math.max(delta, 0);
      video.currentTime = Math.max(0, Math.min(maxTime, video.currentTime + delta));
      showSeekControls();
    };

    const clearHoldTimer = () => {
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = null;
    };

    const releaseHoldPointer = () => {
      if (holdPointerHost && holdPointerId != null) {
        try {
          if (holdPointerHost.hasPointerCapture?.(holdPointerId)) holdPointerHost.releasePointerCapture(holdPointerId);
        } catch (e) {}
      }
      holdPointerId = null;
      holdPointerHost = null;
    };

    const restoreHoldRate = () => {
      clearHoldTimer();
      releaseHoldPointer();
      if (!holdRateActive) return;
      const media = holdRateMedia;
      const restoreRate = holdRestoreRate;
      holdRateActive = false;
      holdRateMedia = null;
      holdIndicatorEl?.classList.remove('show');
      if (media?.isConnected) applyRate(media, restoreRate);
      applyToAllMedia();
    };

    const activateHoldRate = () => {
      const video = getPlayerUi()?.video;
      if (!video || video.paused || !Number.isFinite(video.playbackRate)) {
        releaseHoldPointer();
        return;
      }
      holdRateMedia = video;
      holdRestoreRate = ogDesc.get.call(video) || options.playbackRate || 1;
      holdRateActive = true;
      applyRate(video, options.holdPlaybackRate);
      if (holdIndicatorEl) {
        holdIndicatorEl.textContent = `${fmtRate(options.holdPlaybackRate)} 临时倍速`;
        holdIndicatorEl.classList.add('show');
      }
    };

    const beginHoldRate = (event) => {
      if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
      restoreHoldRate();
      holdPointerId = event.pointerId;
      holdPointerHost = event.currentTarget;
      try { holdPointerHost.setPointerCapture?.(holdPointerId); } catch (e) {}
      holdStartX = event.clientX;
      holdStartY = event.clientY;
      holdTimer = setTimeout(activateHoldRate, 2000);
    };

    const moveHoldRate = (event) => {
      if (event.pointerId !== holdPointerId || holdRateActive) return;
      if (Math.hypot(event.clientX - holdStartX, event.clientY - holdStartY) > 12) {
        clearHoldTimer();
        releaseHoldPointer();
      }
    };

    const endHoldRate = (event) => {
      if (holdPointerId == null || (event?.pointerId != null && event.pointerId !== holdPointerId)) return;
      const wasActive = holdRateActive;
      restoreHoldRate();
      if (wasActive) {
        suppressNextForwardClick = true;
        setTimeout(() => { suppressNextForwardClick = false; }, 500);
      }
    };

    const mountSeekControls = (ui) => {
      if (!ui?.videoWrap) return;
      if (!seekLayerEl?.isConnected || seekLayerEl.parentElement !== ui.videoWrap) {
        seekLayerEl?.remove();
        seekLayerEl = document.createElement('div');
        seekLayerEl.className = 'bfq-seek-layer';
        seekLayerEl.innerHTML = `
          <button class="bfq-seek-btn" data-seek-action="backward" title="后退 ${options.seekBackwardSeconds} 秒">
            <span class="bfq-seek-icon">↶</span><span class="bfq-seek-time">${options.seekBackwardSeconds}s</span>
          </button>
          <button class="bfq-seek-btn" data-seek-action="forward" title="点击前进 ${options.seekForwardSeconds} 秒，长按临时 ${fmtRate(options.holdPlaybackRate)}">
            <span class="bfq-seek-icon">↷</span><span class="bfq-seek-time">${options.seekForwardSeconds}s</span>
          </button>`;
        ui.videoWrap.style.position = ui.videoWrap.style.position || 'relative';
        ui.videoWrap.appendChild(seekLayerEl);
        holdIndicatorEl?.remove();
        holdIndicatorEl = document.createElement('div');
        holdIndicatorEl.className = 'bfq-hold-rate-indicator';
        ui.videoWrap.appendChild(holdIndicatorEl);
        seekLayerEl.querySelectorAll('[data-seek-action]').forEach((button) => {
          button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (button.dataset.seekAction === 'forward' && suppressNextForwardClick) {
              suppressNextForwardClick = false;
              return;
            }
            seekVideo(button.dataset.seekAction);
          });
        });
        const forwardButton = seekLayerEl.querySelector('[data-seek-action="forward"]');
        forwardButton?.addEventListener('pointerdown', beginHoldRate, true);
        forwardButton?.addEventListener('contextmenu', (event) => {
          if (holdPointerId != null || holdRateActive) event.preventDefault();
        }, true);
      }
      if (!boundSeekHosts.has(ui.videoWrap)) {
        boundSeekHosts.add(ui.videoWrap);
        ui.videoWrap.addEventListener('click', (event) => {
          if (event.target.closest?.('.bfq-seek-btn')) return;
          showSeekControls();
        }, true);
      }
      refreshSeekLabels();
    };

    const mount = () => {
      const ui = getPlayerUi();
      if (!ui?.video?.isConnected || !ui?.videoWrap?.isConnected) return;
      mountSeekControls(ui);
      if (!isPlayerUiReady(ui)) return;
      if (controlEl?.isConnected && controlEl.parentElement === ui.controls) return;

      controlEl?.remove();
      controlEl = document.createElement('div');
      controlEl.id = 'bfq-speed-control';
      btnEl = buildBtn();
      popEl = document.createElement('div');
      popEl.className = 'bfq-speed-pop';
      refreshPop();
      controlEl.appendChild(btnEl);
      controlEl.appendChild(popEl);
      ui.controls.prepend(controlEl);
      syncFullscreenUi();
      btnEl.addEventListener('click', (e) => {
        e.stopPropagation();
        popEl.classList.toggle('show');
      });
      popEl.addEventListener('click', onPopClick);
      console.log('[Bilibili脚本] 倍速按钮已挂载');
    };

    document.addEventListener('click', (e) => {
      if (popEl && btnEl && !popEl.contains(e.target) && !btnEl.contains(e.target)) popEl.classList.remove('show');
    }, true);

    let mountTimer = null;
    const scheduleMount = () => {
      if (mountTimer) return;
      mountTimer = setTimeout(() => {
        mountTimer = null;
        mount();
        applyToAllMedia();
      }, 120);
    };

    const mountObserver = new MutationObserver((mutations) => {
      const currentControls = getPlayerUi()?.controls;
      const currentVideoWrap = getPlayerUi()?.videoWrap;
      const controlChanged = !controlEl?.isConnected || controlEl.parentElement !== currentControls;
      const seekLayerChanged = !seekLayerEl?.isConnected || seekLayerEl.parentElement !== currentVideoWrap;
      const videoAdded = mutations.some((mutation) => [...mutation.addedNodes].some((node) =>
        node.nodeType === 1 && (node.matches?.('video') || node.querySelector?.('video'))
      ));
      if (controlChanged || seekLayerChanged || videoAdded) scheduleMount();
    });
    const startMountWatch = () => {
      scheduleMount();
      try { mountObserver.observe(document.body, { childList: true, subtree: true }); } catch (e) {}
    };

    document.addEventListener('visibilitychange', scheduleMount);
    document.addEventListener('pointermove', moveHoldRate, true);
    document.addEventListener('pointerup', endHoldRate, true);
    document.addEventListener('pointercancel', endHoldRate, true);
    document.addEventListener('pause', (event) => {
      if (event.target === holdRateMedia) restoreHoldRate();
    }, true);
    unsafeWindow.addEventListener('blur', restoreHoldRate);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) restoreHoldRate();
    });
    document.addEventListener('loadedmetadata', scheduleMount, true);
    unsafeWindow.navigation?.addEventListener?.('navigate', scheduleMount);

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startMountWatch, { once: true });
    } else {
      startMountWatch();
    }
    setTimeout(applyToAllMedia, 800);
    setTimeout(applyToAllMedia, 2500);
  }

  /* ========== 4. 设置面板 ========== */
  function installSettingsPanel() {
    GM_addStyle(`
#qp-panel{position:fixed;inset:0;z-index:999999;display:none;place-items:center;background:rgba(0,0,0,.6);backdrop-filter:blur(2px)}
.qp-wrapper{width:90%;max-width:420px;padding:20px;background:#fff;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.3);display:flex;flex-direction:column;gap:16px;font-size:14px;font-family:sans-serif}
.qp-title{margin:0 0 8px;font-size:22px;font-weight:600;color:#333;border-bottom:2px solid #00aeec;padding-bottom:8px}
.qp-row{display:flex;justify-content:space-between;align-items:center;padding:8px 0}
.qp-label{color:#555;font-weight:500}
select{padding:6px 10px;border:1px solid #ddd;border-radius:6px;background:#fff;cursor:pointer;transition:border-color .2s}
select:hover{border-color:#00aeec}
.switch{cursor:pointer;display:inline-block;width:44px;height:24px;background:#ccc;border-radius:12px;position:relative;transition:background .3s}
.switch[data-status='on']{background:#00aeec}
.switch:after{content:'';position:absolute;top:3px;left:3px;width:18px;height:18px;background:#fff;border-radius:50%;transition:left .3s;box-shadow:0 1px 3px rgba(0,0,0,.2)}
.switch[data-status='on']:after{left:23px}
.qp-close-btn{padding:10px;background:#00aeec;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600;transition:background .2s}
.qp-close-btn:hover{background:#0098d1}
.qp-section-divider{height:1px;background:#e0e0e0;margin:8px 0}
`);

    const panel = document.createElement('div');
    panel.id = 'qp-panel';
    panel.innerHTML = `
    <div class="qp-wrapper">
      <div class="qp-title">🎬 画质设置</div>
      <div class="qp-row">
        <span class="qp-label">偏好分辨率</span>
        <select data-key="preferQuality">
          <option value="1080" ${options.preferQuality === '1080' ? 'selected' : ''}>1080p 高清</option>
          <option value="720" ${options.preferQuality === '720' ? 'selected' : ''}>720p 清晰</option>
          <option value="480" ${options.preferQuality === '480' ? 'selected' : ''}>480p 流畅</option>
          <option value="360" ${options.preferQuality === '360' ? 'selected' : ''}>360p 省流</option>
        </select>
      </div>
      <div class="qp-row">
        <span class="qp-label">切换时暂停播放</span>
        <span class="switch" data-key="isWaitUntilHighQualityLoaded" data-status="${options.isWaitUntilHighQualityLoaded ? 'on' : 'off'}"></span>
      </div>
      <div class="qp-section-divider"></div>
      <div class="qp-title">💬 评论设置</div>
      <div class="qp-row">
        <span class="qp-label">解锁全部评论</span>
        <span class="switch" data-key="enableCommentUnlock" data-status="${options.enableCommentUnlock ? 'on' : 'off'}"></span>
      </div>
      <div class="qp-row">
        <span class="qp-label">分页加载评论</span>
        <span class="switch" data-key="enableReplyPagination" data-status="${options.enableReplyPagination ? 'on' : 'off'}"></span>
      </div>
      <div class="qp-section-divider"></div>
      <div class="qp-title">📺 直播设置</div>
      <div class="qp-row">
        <span class="qp-label">直播分区连续加载</span>
        <span class="switch" data-key="enableLiveAreaUnlock" data-status="${options.enableLiveAreaUnlock ? 'on' : 'off'}"></span>
      </div>
      <div class="qp-section-divider"></div>
      <div class="qp-title">🛡️ 解锁模式</div>
      <div class="qp-row">
        <span class="qp-label">协议级解锁（推荐·无副作用）</span>
        <span class="switch" data-key="enableProtocolUnlock" data-status="${options.enableProtocolUnlock ? 'on' : 'off'}"></span>
      </div>
      <button class="qp-close-btn" onclick="this.parentElement.parentElement.style.display='none'">✓ 保存并关闭</button>
    </div>`;

    // 等待 body 加载完成再添加面板
    const addPanel = () => {
      if (panel.isConnected) return;
      if (document.body) {
        document.body.appendChild(panel);
      } else {
        document.addEventListener('DOMContentLoaded', addPanel, { once: true });
      }
    };
    addPanel();

    /* 注册 GM 菜单 & 播放器入口 */
    GM_registerMenuCommand('🎬 画质设置', () => {
      addPanel();
      panel.style.display = 'flex';
    });

    let settingsEntry = null;
    const addSettingsEntry = () => {
      if (settingsEntry?.isConnected) return;

      const others = document.querySelector('.bpx-player-ctrl-setting-others-content');
      if (!others) return;

      settingsEntry = document.createElement('div');
      settingsEntry.textContent = '🎬 脚本设置 >';
      settingsEntry.style.cssText = 'cursor:pointer;height:20px;line-height:20px;padding:4px 8px;transition:background .2s';
      settingsEntry.onmouseenter = () => { settingsEntry.style.background = 'rgba(0,174,236,0.1)'; };
      settingsEntry.onmouseleave = () => { settingsEntry.style.background = ''; };
      settingsEntry.onclick = () => { panel.style.display = 'flex'; };
      others.appendChild(settingsEntry);
    };

    let entryMountTimer = null;
    const scheduleSettingsEntry = () => {
      if (settingsEntry?.isConnected || entryMountTimer) return;
      entryMountTimer = setTimeout(() => {
        entryMountTimer = null;
        addSettingsEntry();
      }, 100);
    };
    const settingsObserver = new MutationObserver(scheduleSettingsEntry);

    const startObserving = () => {
      addPanel();
      addSettingsEntry();
      settingsObserver.observe(document.body, { childList: true, subtree: true });
    };

    if (document.body) {
      startObserving();
    } else {
      document.addEventListener('DOMContentLoaded', startObserving, { once: true });
    }

    /* 事件绑定：即时存储 */
    panel.querySelectorAll('[data-key]').forEach(el => {
      if (el.tagName === 'SELECT') {
        el.onchange = e => {
          const value = e.target.value;
          options.preferQuality = value;
          GM_setValue(el.dataset.key, value);
        };
      } else {
        el.onclick = () => {
          const newStatus = el.dataset.status === 'on' ? 'off' : 'on';
          el.dataset.status = newStatus;
          const isOn = newStatus === 'on';
          const key = el.dataset.key;

          if (key === 'isWaitUntilHighQualityLoaded') {
            options.isWaitUntilHighQualityLoaded = isOn;
          } else if (key === 'enableCommentUnlock') {
            options.enableCommentUnlock = isOn;
          } else if (key === 'enableReplyPagination') {
            options.enableReplyPagination = isOn;
          } else if (key === 'enableLiveAreaUnlock') {
            options.enableLiveAreaUnlock = isOn;
          } else if (key === 'enableProtocolUnlock') {
            options.enableProtocolUnlock = isOn;
          }

          GM_setValue(key, isOn);
        };
      }
    });

    // 支持 ESC 键关闭面板
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && panel.style.display === 'flex') {
        panel.style.display = 'none';
      }
    });

    // 点击背景关闭面板
    panel.addEventListener('click', (e) => {
      if (e.target === panel) {
        panel.style.display = 'none';
      }
    });
  }
})();
