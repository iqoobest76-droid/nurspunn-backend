(function () {
  'use strict';

  const $ = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);
  const audio = $('#audio');
  const search = $('#search');
  const results = $('#results');
  const lyricsView = $('#lyrics-view');
  const homeCards = $('#home-cards');
  const homeTracks = $('#home-tracks');
  const favTracks = $('#fav-tracks');
  const vHome = $('#view-home');
  const vSearch = $('#view-search');
  const vFav = $('#view-fav');
  const vAi = $('#view-ai');
  const pTitle = $('#p-title');
  const pArtist = $('#p-artist');
  const pThumb = $('#p-thumb');
  const albumArt = $('#album-art');
  const albumBg = $('#album-bg');
  const btnPlay = $('#btn-play');
  const btnPrev = $('#btn-prev');
  const btnNext = $('#btn-next');
  const btnHeart = $('#btn-heart');
  const tNow = $('#time-now');
  const tEnd = $('#time-end');
  const pBar = $('#p-bar');
  const pFill = $('#p-fill');
  const volume = $('#volume');
  const queueQuery = $('#queue-query');
  const navHome = $('#nav-home');
  const navFav = $('#nav-fav');
  const navAi = $('#nav-ai');
  const navSearchBtn = $('#nav-search-btn');
  const queueLabel = $('.queue-label');
  const aiMessages = $('#ai-messages');
  const aiForm = $('#ai-form');
  const aiInput = $('#ai-input');
  const bottomNav = $('.bottom-nav');

  let YT_API_KEY = '';
  let GEMINI_API_KEY = '';
  apiGet('/api/config').then(c => { if (c) { YT_API_KEY = c.yt_api_key || ''; GEMINI_API_KEY = c.gemini_api_key || ''; } });

  // Backend server URL (set this to your deployed backend)
  // The backend uses yt-dlp to extract audio streams reliably.
  const BACKEND_URL = (localStorage.getItem('nurspunn_backend') || 'https://nurspunn-backend.onrender.com').replace(/\/+$/, '');

  let playlist = [];
  let idx = -1;
  let playing = false;
  let favorites = [];
  let searchSeq = 0;
  let navStack = [];
  let currentViewName = 'home';
  let timedLyrics = [];
  let activeLyricIndex = -1;
  let lyricsTrackId = '';
  let deepListenLoggedFor = '';
  let homePlaylist = [];
  let lastHomeSignature = '';
  let homeRequestSeq = 0;
  let queueMode = 'idle';
  let relatedPlaylist = [];
  let relatedRequestSeq = 0;
  let lastRelatedFor = '';

  async function apiGet(path) {
    try {
      const r = await fetch(BACKEND_URL + path, { signal: AbortSignal.timeout(90000) });
      if (r.ok) return await r.json();
    } catch (e) { console.warn('apiGet failed', path, e); }
    return null;
  }

  async function getStreamUrl(videoId) {
    const data = await apiGet('/api/stream?id=' + encodeURIComponent(videoId));
    if (data && data.proxy_url) return BACKEND_URL + data.proxy_url;
    if (data && data.url) return data.url;
    return await clientExtractStream(videoId);
  }

  async function clientExtractStream(videoId) {
    const clients = [
      { clientName: 'ANDROID_MUSIC', clientVersion: '7.27.52', api_key: 'AIzaSyAOghZGza2MQSZkY_zfZ370N-PUdXEo8AI' },
      { clientName: 'ANDROID', clientVersion: '19.29.37', api_key: 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w' },
      { clientName: 'IOS', clientVersion: '19.29.1', api_key: 'AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc' },
      { clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', clientVersion: '2.0', api_key: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8' },
    ];
    for (const cl of clients) {
      try {
        const body = JSON.stringify({
          context: {
            client: {
              clientName: cl.clientName,
              clientVersion: cl.clientVersion,
              hl: 'en',
              gl: 'US',
            }
          },
          videoId: videoId,
          contentCheckOk: true,
          racyCheckOk: true,
        });
        const url = 'https://www.youtube.com/youtubei/v1/player?key=' + cl.api_key + '&prettyPrint=false';
        const r = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'com.google.android.youtube/19.29.37 (Linux; U; Android 14)',
            'X-YouTube-Client-Name': '3',
            'X-YouTube-Client-Version': cl.clientVersion,
          },
          body: body,
          signal: AbortSignal.timeout(15000),
        });
        if (!r.ok) continue;
        const data = await r.json();
        const ps = data.playabilityStatus || {};
        if (ps.status === 'ERROR' || ps.status === 'UNPLAYABLE') continue;
        const streaming = data.streamingData || {};
        const formats = (streaming.adaptiveFormats || []).concat(streaming.formats || []);
        const audioFormats = formats.filter(f => (f.mimeType || '').startsWith('audio/'));
        if (audioFormats.length === 0) continue;
        audioFormats.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        const best = audioFormats[0];
        if (best.url) return best.url;
        if (best.signatureCipher) {
          const decoded = await decodeSignatureCipher(best.signatureCipher, cl.api_key);
          if (decoded) return decoded;
        }
      } catch (e) { console.warn('clientExtract', cl.clientName, 'failed', e); }
    }
    return null;
  }

  async function decodeSignatureCipher(sc, apiKey) {
    try {
      const params = new URLSearchParams(sc);
      const sig = params.get('s') || '';
      const url = params.get('url') || '';
      const sp = params.get('sp') || 'sig';
      const playerUrls = [
        'https://www.youtube.com/s/player/5f88cbaa/player_ias.vflset/en_US/base.js',
        'https://www.youtube.com/s/player/f1ab6734/player_ias.vflset/en_US/base.js',
        'https://www.youtube.com/s/player/f01bbb65/player_ias.vflset/en_US/base.js',
      ];
      let js = '';
      for (const pUrl of playerUrls) {
        try {
          const resp = await fetch(pUrl, { signal: AbortSignal.timeout(8000) });
          if (resp.ok) { js = await resp.text(); break; }
        } catch (e) { continue; }
      }
      if (!js) return null;
      const nParam = url.match(/[?&]n=([^&]*)/);
      if (nParam) {
        const nMatch = js.match(/\b([a-zA-Z0-9$]{2})\s*=\s*function\(\s*a\s*\)\s*\{\s*a\s*=\s*a\.split\(\s*""\s*\)/);
        if (nMatch) {
          const funcName = nMatch[1];
          const funcRegex = new RegExp(funcName + '\\s*=\\s*function\\s*\\(\\s*a\\s*\\)');
          if (funcRegex.test(js)) {
            try {
              const enhanced = new Function('a', js.match(new RegExp(funcName + '\\s*=\\s*function\\s*\\(\\s*a\\s*\\)\\s*\\{[^}]+\\}'))[0].split('{').slice(1).join('{').replace(/\}$/, ''));
              const newN = enhanced(sig);
              if (newN && newN !== sig) {
                const sep = url.includes('?') ? '&' : '?';
                return url + sep + 'n=' + encodeURIComponent(newN);
              }
            } catch (e) {}
          }
        }
      }
      const funcMatch = js.match(/var\s+(\w+)\s*=\s*\[([^\]]+)\]\.join\(""\);/);
      if (funcMatch) {
        const ops = funcMatch[2].split(',').map(s => s.trim().replace(/["']/g, ''));
        let decoded = sig.split('');
        for (const op of ops) {
          if (op.includes('splice')) { const n = parseInt(op.match(/\d+/)[0]); decoded.splice(0, n); }
          else if (op.includes('reverse')) { decoded.reverse(); }
          else { const n = parseInt(op.match(/\d+/)[0]); if (!isNaN(n) && n < decoded.length) { const c = decoded[0]; decoded[0] = decoded[n]; decoded[n] = c; } }
        }
        const sep = url.includes('?') ? '&' : '?';
        return url + sep + sp + '=' + encodeURIComponent(decoded.join(''));
      }
      return null;
    } catch (e) { console.warn('decodeSignatureCipher failed', e); return null; }
  }

  function loadFavs() {
    try { favorites = JSON.parse(localStorage.getItem('nurspunn_favs') || '[]'); } catch(e) { favorites = []; }
  }
  function saveFavs() { localStorage.setItem('nurspunn_favs', JSON.stringify(favorites)); }
  function isFav(id) { return favorites.some(f => f.id === id); }
  function toggleFav(track) {
    const i = favorites.findIndex(f => f.id === track.id);
    if (i >= 0) favorites.splice(i, 1);
    else favorites.push({ id: track.id, title: track.title, channel: track.channel, thumbnail: track.thumbnail });
    saveFavs();
    updateHeartUI(track.id);
    if (!vFav.classList.contains('hidden')) renderFavList();
  }
  function updateHeartUI(trackId) {
    const liked = isFav(trackId);
    $$('.ri-heart').forEach(h => {
      if (h.dataset.id === trackId) { h.classList.toggle('liked', liked); h.textContent = liked ? '\u2665' : '\u2661'; }
    });
    $$('.tr-heart').forEach(h => {
      if (h.dataset.id === trackId) { h.classList.toggle('liked', liked); h.textContent = liked ? '\u2665' : '\u2661'; }
    });
    if (btnHeart.dataset.id === trackId) { btnHeart.classList.toggle('liked', liked); btnHeart.textContent = liked ? '\u2665' : '\u2661'; }
  }
  function cleanText(text) {
    return String(text || '').toLowerCase().replace(/\[[^\]]*]/g, ' ').replace(/\([^)]*\)/g, ' ').replace(/\b(official|video|audio|lyrics?|lyric|visualizer|clip|ft|feat|prod)\b/g, ' ').replace(/[#|_/\\.,:;!?'"`~]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function keywordTokens(text) {
    const stop = new Set(['the', 'and', 'with', 'from', 'for', 'you', 'your', 'music', 'song', 'songs', 'official', 'video', 'audio', 'remix']);
    return cleanText(text).split(' ').filter(word => word.length > 2 && !stop.has(word)).slice(0, 8);
  }
  const GENRE_PROFILES = [
    { key: 'phonk', labels: ['phonk', 'funk', 'drift', 'brazilian funk'], queries: ['popular phonk music', 'drift phonk playlist'] },
    { key: 'rap', labels: ['rap', 'hip hop', 'trap', 'drill'], queries: ['popular rap songs', 'trap music playlist'] },
    { key: 'pop', labels: ['pop', 'taylor', 'ariana', 'weeknd'], queries: ['popular pop songs', 'top music hits'] },
    { key: 'edm', labels: ['edm', 'house', 'techno', 'dance', 'club'], queries: ['popular edm music', 'dance music hits'] },
    { key: 'rock', labels: ['rock', 'metal', 'punk', 'alternative'], queries: ['popular rock songs', 'alternative rock'] },
    { key: 'kpop', labels: ['kpop', 'bts', 'blackpink', 'jungkook'], queries: ['popular kpop songs', 'kpop hits'] }
  ];
  function inferGenres(text) {
    const lower = cleanText(text);
    return GENRE_PROFILES.filter(p => p.labels.some(l => lower.includes(l))).map(p => p.key);
  }
  function trackText(t) { return [t?.title, t?.channel].filter(Boolean).join(' '); }
  function recommendationQueries() {
    const q = [];
    q.push('popular music hits', 'new music 2026', 'viral songs');
    return [...new Set(q)].slice(0, 6);
  }
  function isPlayableTrack(t) { return !!(t && t.id); }
  function cleanTrackList(tracks, blockedId) {
    const seen = new Set();
    return (tracks || []).filter(t => { if (!isPlayableTrack(t) || t.id === blockedId || seen.has(t.id)) return false; seen.add(t.id); return true; });
  }

  function showView(view, skipHistory) {
    if (view === currentViewName && !skipHistory) return;
    if (!skipHistory) { navStack.push(currentViewName); }
    currentViewName = view;
    vHome.classList.add('hidden');
    vSearch.classList.add('hidden');
    vFav.classList.add('hidden');
    if (vAi) vAi.classList.add('hidden');
    $$('.nav-item').forEach(n => n.classList.remove('active'));
    if (view === 'home') { vHome.classList.remove('hidden'); navHome.classList.add('active'); }
    else if (view === 'search') { vSearch.classList.remove('hidden'); navSearchBtn.classList.add('active'); }
    else if (view === 'fav') { vFav.classList.remove('hidden'); navFav.classList.add('active'); renderFavList(); }
    else if (view === 'ai' && vAi) { vAi.classList.remove('hidden'); if (navAi) navAi.classList.add('active'); }
  }

  const ICONS = {
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10-6.5-10-6.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7V5zm6 0h4v14h-4V5z"/></svg>',
    prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 6.5 10 12l5.5 5.5-1.8 1.8L6.4 12l7.3-7.3 1.8 1.8z"/></svg>',
    next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8.5 17.5 5.5-5.5-5.5-5.5 1.8-1.8 7.3 7.3-7.3 7.3-1.8-1.8z"/></svg>',
    volume: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4zm12.4-.9-1.3 1.3A3.6 3.6 0 0 1 16 12c0 1-.4 1.9-.9 2.6l1.3 1.3A5.5 5.5 0 0 0 18 12c0-1.5-.6-2.9-1.6-3.9z"/></svg>'
  };
  function setIcon(el, name) { if (el && ICONS[name]) el.innerHTML = ICONS[name]; }
  function setPlayIcon(isPlaying) { setIcon(btnPlay, isPlaying ? 'pause' : 'play'); }
  function youtubeThumb(id, q) { return id ? 'https://i.ytimg.com/vi/' + id + '/' + (q || 'maxresdefault') + '.jpg' : ''; }
  function bestThumb(t) { return youtubeThumb(t && t.id) || (t && t.thumbnail) || ''; }
  function fallbackThumb(t) { return youtubeThumb(t && t.id, 'hqdefault') || (t && t.thumbnail) || ''; }
  function imgTag(cls, t) { return '<img class="' + cls + '" src="' + esc(bestThumb(t)) + '" data-fallback="' + esc(fallbackThumb(t)) + '" alt="">'; }
  function bindImageFallback(root) {
    (root || document).querySelectorAll('img[data-fallback]').forEach(img => {
      img.onerror = function () { const fb = this.getAttribute('data-fallback'); if (fb && this.src !== fb) { this.removeAttribute('data-fallback'); this.src = fb; } else { const row = this.closest('.card,.tr,.ri'); if (row) row.remove(); } };
    });
  }
  function esc(t) { const d = document.createElement('div'); d.textContent = t || ''; return d.innerHTML; }
  function fmt(sec) { if (!sec || !isFinite(sec)) return '0:00'; const m = Math.floor(sec / 60); const s = Math.floor(sec % 60); return m + ':' + (s < 10 ? '0' : '') + s; }

  function applyLang() {
    if (!window.NURS_I18N || !window.NURS_LOCALES) return;
    const lang = window.NURS_I18N.getLang();
    const loc = window.NURS_LOCALES[lang] || window.NURS_LOCALES.kk;
    $$('[data-i18n]').forEach(el => { const k = el.getAttribute('data-i18n'); if (loc[k]) el.textContent = loc[k]; });
    $$('[data-i18n-placeholder]').forEach(el => { const k = el.getAttribute('data-i18n-placeholder'); if (loc[k]) el.placeholder = loc[k]; });
    if ($('#lang-btn')) $('#lang-btn').textContent = loc.langSwitch || 'EN';
  }
  if ($('#lang-btn')) $('#lang-btn').addEventListener('click', () => { window.NURS_I18N.toggle(); applyLang(); });
  applyLang();
  window.NURS_ON_LANG_CHANGE = () => applyLang();

  setIcon(btnPrev, 'prev');
  setIcon(btnNext, 'next');
  setPlayIcon(false);
  const volIcon = document.querySelector('.vol-icon');
  if (volIcon) volIcon.innerHTML = ICONS.volume;

  navHome.addEventListener('click', e => { e.preventDefault(); navStack = []; currentViewName = ''; loadHome(); showView('home'); });
  navFav.addEventListener('click', () => showView('fav'));
  navSearchBtn.addEventListener('click', () => { showView('search'); setTimeout(() => search.focus(), 100); });
  if (navAi) navAi.addEventListener('click', () => showView('ai'));

  // Settings: backend URL configuration
  const settingsBtn = $('#settings-btn');
  const settingsPop = $('#settings-pop');
  const backendInput = $('#backend-input');
  const settingsSave = $('#settings-save');
  const settingsCancel = $('#settings-cancel');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      backendInput.value = (localStorage.getItem('nurspunn_backend') || BACKEND_URL);
      settingsPop.classList.add('show');
    });
    settingsCancel.addEventListener('click', () => settingsPop.classList.remove('show'));
    settingsSave.addEventListener('click', () => {
      const url = backendInput.value.trim().replace(/\/+$/, '');
      if (url) {
        localStorage.setItem('nurspunn_backend', url);
        settingsPop.classList.remove('show');
        alert('Backend saved. Restart the app to apply.');
      }
    });
    settingsPop.addEventListener('click', e => { if (e.target === settingsPop) settingsPop.classList.remove('show'); });
  }

  // Android back button handling
  function setupBackButton() {
    try {
      if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
        window.Capacitor.Plugins.App.addListener('backButton', function () {
          if (navStack.length > 0) {
            var prev = navStack.pop();
            currentViewName = '';
            if (prev === 'home') { loadHome(); showView('home', true); }
            else if (prev === 'search') { showView('search', true); }
            else if (prev === 'fav') { showView('fav', true); }
            else if (prev === 'ai') { showView('ai', true); }
            else { showView('home', true); }
          } else {
            if (window.Capacitor.Plugins.App.minimizeApp) {
              window.Capacitor.Plugins.App.minimizeApp();
            } else {
              window.Capacitor.Plugins.App.exitApp();
            }
          }
        });
      }
    } catch (e) { console.warn('Back button setup failed', e); }
  }
  setupBackButton();

  function aiAppend(role, text) {
    if (!aiMessages) return;
    const div = document.createElement('div');
    div.className = 'ai-msg ' + role;
    div.textContent = text;
    aiMessages.appendChild(div);
    aiMessages.scrollTop = aiMessages.scrollHeight;
  }

  function aiReply(text) {
    const thinking = document.createElement('div');
    thinking.className = 'ai-msg bot thinking';
    thinking.textContent = 'Thinking...';
    aiMessages.appendChild(thinking);
    aiMessages.scrollTop = aiMessages.scrollHeight;
    const currentTrack = idx >= 0 && playlist[idx] ? { title: playlist[idx].title, channel: playlist[idx].channel } : null;
    const system = 'You are NURS AI, a music assistant. Reply concisely about music.';
    const prompt = system + '\nUser: ' + text;
    fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + GEMINI_API_KEY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.55, maxOutputTokens: 520 } })
    }).then(r => r.json()).then(json => {
      thinking.remove();
      const reply = json?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
      aiAppend('bot', reply || 'No response. Check GEMINI_API_KEY.');
    }).catch(() => {
      thinking.remove();
      aiAppend('bot', 'Cannot connect to AI. Check internet or GEMINI_API_KEY.');
    });
    const query = cleanText(text).replace(/\b(find|search|song|music|lyrics?|genre|artist)\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (query.length >= 3) {
      ytSearch(query).then(found => { const clean = cleanTrackList(found).slice(0, 5); if (clean.length) renderResults(clean, query); }).catch(() => {});
    }
  }

  if (aiForm) {
    aiForm.addEventListener('submit', e => {
      e.preventDefault();
      const text = aiInput.value.trim();
      if (!text) return;
      aiInput.value = '';
      aiAppend('user', text);
      aiReply(text);
    });
  }

  const langBtn = $('#lang-btn');

  // ========== Search via backend (yt-dlp) ==========
  function ytSearch(query, maxResults) {
    const max = maxResults || 20;
    return apiGet('/api/search?q=' + encodeURIComponent(query) + '&max=' + max).then(json => {
      if (!json || !json.items) return [];
      return json.items.map(item => ({
        id: item.id,
        title: item.title || 'Untitled',
        channel: item.channel || '',
        thumbnail: youtubeThumb(item.id) || item.thumbnail || '',
        duration: item.duration || 0
      })).filter(t => t.id);
    }).catch(() => []);
  }

  function ytHome() { return ytSearch('popular music 2026', 20); }

  // ========== Playback via Piped + HTML5 Audio ==========
  let streamUrl = '';
  let loadingStream = false;

  audio.addEventListener('loadedmetadata', () => {
    playing = true;
    setPlayIcon(true);
    btnPlay.classList.remove('is-loading');
    const dur = audio.duration || 0;
    if (dur > 0) {
      tEnd.textContent = fmt(dur);
      pFill.style.width = '0%';
      tNow.textContent = '0:00';
    }
    try { if (window.AndroidMusic && playlist[idx]) { window.AndroidMusic.updateNotification(playlist[idx].title || 'nurspunn', playlist[idx].channel || 'Playing'); } } catch(e) {}
  });

  audio.addEventListener('error', (e) => {
    console.error('Audio error:', audio.error);
    btnPlay.classList.remove('is-loading');
    setPlayIcon(false);
    playing = false;
  });

  audio.addEventListener('ended', () => {
    doNext();
  });

  audio.addEventListener('timeupdate', () => {
    if (!playing) return;
    const cur = audio.currentTime || 0;
    const dur = audio.duration || 0;
    if (dur > 0) {
      pFill.style.width = ((cur / dur) * 100) + '%';
      tNow.textContent = fmt(cur);
    }
    updateSyncedLyrics(cur);
  });

  audio.addEventListener('waiting', () => {
    btnPlay.classList.add('is-loading');
  });

  audio.addEventListener('canplay', () => {
    btnPlay.classList.remove('is-loading');
  });

  let timeUpdateInterval = null;
  function startTimeUpdate() {
    if (timeUpdateInterval) clearInterval(timeUpdateInterval);
    timeUpdateInterval = setInterval(() => {
      if (!playing) return;
      const cur = audio.currentTime || 0;
      const dur = audio.duration || 0;
      if (dur > 0) {
        pFill.style.width = ((cur / dur) * 100) + '%';
        tNow.textContent = fmt(cur);
        tEnd.textContent = fmt(dur);
      }
      updateSyncedLyrics(cur);
      const deepTrack = idx >= 0 ? playlist[idx] : null;
      if (deepTrack && deepTrack.id !== deepListenLoggedFor && cur >= 30) {
        deepListenLoggedFor = deepTrack.id;
      }
    }, 250);
  }

  function play(i) {
    if (i < 0 || i >= playlist.length) return;
    idx = i;
    const t = playlist[i];
    pTitle.textContent = t.title;
    pArtist.textContent = t.channel;
    const cover = bestThumb(t);
    const coverFallback = fallbackThumb(t);
    pThumb.style.backgroundImage = 'url(' + cover + ')';
    albumArt.innerHTML = '<img src="' + esc(cover) + '" data-fallback="' + esc(coverFallback) + '" alt="">';
    bindImageFallback(albumArt);
    const liked = isFav(t.id);
    btnHeart.dataset.id = t.id;
    btnHeart.textContent = liked ? '\u2665' : '\u2661';
    btnHeart.classList.toggle('liked', liked);
    $$('.ri').forEach((r, n) => r.classList.toggle('active', n === i));
    $$('.tr').forEach((r, n) => r.classList.toggle('active', n === i));
    renderSide();
    if (currentTab === 'lyrics') fetchLyrics(t.title, t.channel);
    if (currentTab === 'lyrics') {
      var sl = document.querySelector('.search-layout');
      if (sl) sl.classList.add('lyrics-active');
    }
    try { if (window.AndroidMusic) { window.AndroidMusic.updateNotification(t.title || 'nurspunn', t.channel || 'Playing music'); } } catch(e) {}
    btnPlay.classList.add('is-loading');
    setPlayIcon(true);
    playing = false;
    audio.pause();
    audio.src = '';
    streamUrl = '';
    getStreamUrl(t.id).then(url => {
      if (idx !== i) return;
      if (url) {
        streamUrl = url;
        audio.src = url;
        audio.load();
        audio.play().catch(() => {
          btnPlay.classList.remove('is-loading');
          setPlayIcon(false);
          playing = false;
        });
      } else {
        btnPlay.classList.remove('is-loading');
        setPlayIcon(false);
        playing = false;
        alert('Could not load audio stream. Try a different song.');
      }
    });
    startTimeUpdate();
  }

  function doNext() {
    if (!playlist.length) return;
    play(idx >= playlist.length - 1 ? 0 : idx + 1);
  }

  btnPlay.addEventListener('click', () => {
    if (idx === -1 && playlist.length > 0) { play(0); return; }
    if (idx === -1) return;
    if (playing) { audio.pause(); playing = false; setPlayIcon(false); }
    else {
      if (audio.src && audio.src !== '') { audio.play().catch(() => {}); playing = true; setPlayIcon(true); }
      else { play(idx); }
    }
  });
  btnNext.addEventListener('click', doNext);
  btnPrev.addEventListener('click', () => {
    if (!playlist.length) return;
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    play(idx <= 0 ? playlist.length - 1 : idx - 1);
  });
  btnHeart.addEventListener('click', function () { if (idx < 0 || !playlist[idx]) return; toggleFav(playlist[idx]); });
  pBar.addEventListener('click', e => { const dur = audio.duration || 0; if (!dur) return; const rect = pBar.getBoundingClientRect(); audio.currentTime = ((e.clientX - rect.left) / rect.width) * dur; });
  volume.addEventListener('input', function () { audio.volume = Math.max(0, Math.min(1, parseFloat(this.value) || 0)); });

  function renderSide() {}

  function renderFavList() {
    if (!favorites.length) { favTracks.innerHTML = '<div class="empty">No favorite songs</div>'; return; }
    favTracks.innerHTML = favorites.map((t, i) =>
      '<div class="tr" data-i="' + i + '">' + imgTag('tr-img', t) +
      '<div class="tr-info"><div class="tr-title">' + esc(t.title) + '</div>' +
      '<div class="tr-channel">' + esc(t.channel) + '</div></div>' +
      '<div class="tr-dur"></div></div>'
    ).join('');
    bindImageFallback(favTracks);
    $$('#fav-tracks .tr').forEach(r => {
      r.addEventListener('click', function () {
        const fi = parseInt(this.getAttribute('data-i'));
        playlist = favorites.map(track => ({ ...track }));
        idx = -1;
        showView('search');
        play(fi);
      });
    });
  }

  function loadHome() {
    const requestSeq = ++homeRequestSeq;
    homeCards.innerHTML = '<div class="skeleton-grid">' + renderSkeletonCards(6) + '</div>';
    homeTracks.innerHTML = '<div class="skeleton-list">' + renderSkeletonRows(5) + '</div>';
    ytHome().then(tracks => {
      if (requestSeq !== homeRequestSeq) return;
      if (!tracks || !tracks.length) { homeCards.innerHTML = '<div class="loading">No recommendations</div>'; return; }
      homePlaylist = tracks;
      let ch = '', th = '';
      tracks.forEach((t, i) => {
        ch += '<div class="card" data-i="' + i + '">' + imgTag('card-img', t) + '<div class="card-title">' + esc(t.title) + '</div><div class="card-sub">' + esc(t.channel) + '</div></div>';
        const liked = isFav(t.id);
        th += '<div class="tr" data-i="' + i + '">' + imgTag('tr-img', t) + '<div class="tr-info"><div class="tr-title">' + esc(t.title) + '</div><div class="tr-channel">' + esc(t.channel) + '</div></div><button class="tr-heart' + (liked ? ' liked' : '') + '" data-id="' + t.id + '">' + (liked ? '\u2665' : '\u2661') + '</button><div class="tr-dur"></div></div>';
      });
      homeCards.innerHTML = ch;
      homeTracks.innerHTML = th;
      bindImageFallback(homeCards);
      bindImageFallback(homeTracks);
      $$('.card').forEach(c => c.addEventListener('click', function () {
        playlist = homePlaylist.slice();
        showView('search');
        renderSide();
        play(parseInt(this.getAttribute('data-i')));
      }));
      $$('.tr').forEach(r => r.addEventListener('click', function (e) {
        if (e.target.closest('.tr-heart')) return;
        playlist = homePlaylist.slice();
        showView('search');
        renderSide();
        play(parseInt(this.getAttribute('data-i')));
      }));
      $$('.tr-heart').forEach(h => h.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleFav(homePlaylist[parseInt(this.closest('.tr').getAttribute('data-i'))]);
      }));
    }).catch(() => {
      if (requestSeq === homeRequestSeq) homeCards.innerHTML = '<div class="loading">Failed to load</div>';
    });
  }
  loadHome();

  let st;
  search.addEventListener('input', function () {
    clearTimeout(st);
    const q = this.value.trim();
    searchSeq++;
    if (!q) { results.innerHTML = '<div class="empty">Search for songs</div>'; showView('home'); return; }
    if (queueLabel) queueLabel.textContent = 'Results';
    queueQuery.textContent = q;
    results.innerHTML = '<div class="skeleton-list">' + renderSkeletonRows(8) + '</div>';
    st = setTimeout(() => {
      const seq = ++searchSeq;
      showView('search');
      lastHomeSignature = '';
      ytSearch(q).then(r => { if (seq === searchSeq) renderResults(r, q); });
    }, 300);
  });

  search.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      clearTimeout(st);
      const q = this.value.trim();
      if (!q) return;
      const seq = ++searchSeq;
      showView('search');
      if (queueLabel) queueLabel.textContent = 'Results';
      queueQuery.textContent = q;
      results.innerHTML = '<div class="skeleton-list">' + renderSkeletonRows(8) + '</div>';
      ytSearch(q).then(r => { if (seq === searchSeq) renderResults(r, q); });
    }
  });

  let currentTab = 'results';

  function renderResults(arr, query) {
    const clean = cleanTrackList(arr);
    queueMode = 'search';
    if (queueLabel) queueLabel.textContent = 'Results';
    if (!clean.length) { results.innerHTML = '<div class="empty">Nothing found</div>'; return; }
    playlist = clean;
    queueQuery.textContent = query;
    renderQueueTracks(clean, playlist);
  }

  function renderQueueTracks(arr, sourcePlaylist) {
    results.innerHTML = arr.map((t, i) => {
      const liked = isFav(t.id);
      return '<div class="ri' + (i === idx ? ' active' : '') + '" data-i="' + i + '">' +
        '<div class="ri-thumb">' + imgTag('', t) + '</div>' +
        '<div class="ri-text"><div class="ri-title">' + esc(t.title) + '</div>' +
        '<div class="ri-channel">' + esc(t.channel) + '</div></div>' +
        '<button class="ri-heart' + (liked ? ' liked' : '') + '" data-id="' + t.id + '">' + (liked ? '\u2665' : '\u2661') + '</button>' +
        '<div class="ri-dur"></div></div>';
    }).join('');
    bindImageFallback(results);
    $$('.ri').forEach(r => r.addEventListener('click', function (e) {
      if (e.target.closest('.ri-heart')) return;
      playlist = sourcePlaylist.slice();
      play(parseInt(this.getAttribute('data-i')));
    }));
    $$('.ri-heart').forEach(h => h.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleFav(sourcePlaylist[parseInt(this.closest('.ri').getAttribute('data-i'))]);
    }));
  }

  $$('.queue-tab').forEach(tab => {
    tab.addEventListener('click', function () {
      $$('.queue-tab').forEach(t => t.classList.remove('active'));
      this.classList.add('active');
      currentTab = this.dataset.tab;
      var sl = document.querySelector('.search-layout');
      if (sl) sl.classList.toggle('lyrics-active', currentTab === 'lyrics');
      results.classList.add('hidden');
      lyricsView.classList.add('hidden');
      $(currentTab === 'results' ? '#results' : '#lyrics-view').classList.remove('hidden');
      if (currentTab === 'lyrics' && idx >= 0 && playlist[idx]) {
        fetchLyrics(playlist[idx].title, playlist[idx].channel);
      }
    });
  });

  function renderSkeletonCards(count) {
    let html = '';
    for (let i = 0; i < count; i++) html += '<div class="skeleton-card"><div class="skeleton-img"></div><div class="skeleton-text"><div class="skeleton-line"></div><div class="skeleton-line"></div></div></div>';
    return html;
  }
  function renderSkeletonRows(count) {
    let html = '';
    for (let i = 0; i < count; i++) html += '<div class="skeleton-row"><div class="skeleton-row-img"></div><div class="skeleton-row-text"><div class="skeleton-row-line"></div><div class="skeleton-row-line"></div></div></div>';
    return html;
  }

  // ========== Lyrics (direct LRCLIB) ==========
  function guessArtistAndTitle(title, artist) {
    let t = String(title || '').replace(/\[[^\]]*]/g, ' ').replace(/\([^)]*\)/g, ' ').replace(/\b(official|video|audio|lyrics?|remix)\b/ig, ' ').replace(/\s+/g, ' ').trim();
    let a = String(artist || '').replace(/\b(official|video|audio|lyrics?|remix)\b/ig, ' ').replace(/\s+/g, ' ').trim();
    const parts = t.split(/\s+-\s+|\s+\u2013\s+|\s+\u2014\s+/).map(p => p.trim()).filter(Boolean);
    if (parts.length >= 2) { a = parts[0]; t = parts.slice(1).join(' '); }
    return { title: t, artist: a };
  }

  function fetchLyrics(title, artist) {
    const trackId = idx >= 0 && playlist[idx] ? playlist[idx].id : title + artist;
    lyricsTrackId = trackId;
    timedLyrics = [];
    activeLyricIndex = -1;
    lyricsView.innerHTML = '<div class="loading">Searching lyrics...</div>';
    const q = guessArtistAndTitle(title, artist);
    if (!q.title) { lyricsView.innerHTML = '<div class="empty">Lyrics not found</div>'; return; }
    const url = 'https://lrclib.net/api/search?track_name=' + encodeURIComponent(q.title) + (q.artist ? '&artist_name=' + encodeURIComponent(q.artist) : '');
    fetch(url).then(r => r.json()).then(matches => {
      if (lyricsTrackId !== trackId) return;
      const best = Array.isArray(matches) && matches.find(item => item?.plainLyrics || item?.syncedLyrics);
      if (best) {
        const synced = best.syncedLyrics || '';
        const plain = best.plainLyrics || '';
        timedLyrics = parseSyncedLyrics(synced);
        if (!timedLyrics.length && plain) timedLyrics = distributePlainLyrics(plain);
        renderSyncedLyrics(timedLyrics);
        updateSyncedLyrics(audio.currentTime || 0);
      } else {
        lyricsView.innerHTML = '<div class="empty">Lyrics not found</div>';
      }
    }).catch(() => {
      lyricsView.innerHTML = '<div class="empty">Lyrics unavailable</div>';
    });
  }

  function parseSyncedLyrics(synced) {
    return String(synced || '').split(/\r?\n/).map(line => {
      const match = line.match(/^\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]\s*(.*)$/);
      if (!match) return null;
      const time = parseInt(match[1], 10) * 60 + parseInt(match[2], 10) + (match[3] ? parseFloat('0.' + match[3]) : 0);
      const text = match[4].trim();
      if (!text) return null;
      return { time, text, approx: false };
    }).filter(Boolean).sort((a, b) => a.time - b.time);
  }

  function distributePlainLyrics(lyrics) {
    const lines = String(lyrics || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) return [];
    const dur = audio.duration || Math.max(lines.length * 4, 80);
    const start = Math.min(8, dur * 0.08);
    const usable = Math.max(dur - start - 6, lines.length * 2.2);
    return lines.map((text, i) => ({ time: start + (usable * i / Math.max(lines.length, 1)), text, approx: true }));
  }

  function renderSyncedLyrics(lines) {
    activeLyricIndex = -1;
    if (!lines.length) { lyricsView.innerHTML = '<div class="empty">Lyrics not found</div>'; return; }
    lyricsView.innerHTML = '<div class="lyrics-sync">' +
      lines.map((line, i) => '<div class="lyric-line" data-i="' + i + '"><span>' + esc(line.text) + '</span></div>').join('') +
      '</div>';
  }

  function updateSyncedLyrics(currentTime) {
    if (!timedLyrics.length || lyricsView.classList.contains('hidden')) return;
    let nextIndex = -1;
    for (let i = 0; i < timedLyrics.length; i++) {
      if (timedLyrics[i].time <= currentTime + 0.18) nextIndex = i;
      else break;
    }
    if (nextIndex === activeLyricIndex) return;
    activeLyricIndex = nextIndex;
    $$('#lyrics-view .lyric-line').forEach(el => {
      const n = parseInt(el.getAttribute('data-i'), 10);
      const distance = n - nextIndex;
      el.classList.remove('active', 'near', 'far', 'fade-past', 'fade-future');
      if (distance === 0) el.classList.add('active');
      else if (Math.abs(distance) <= 1) el.classList.add('near');
      else if (Math.abs(distance) <= 3) el.classList.add('far');
      else el.classList.add(distance < 0 ? 'fade-past' : 'fade-future');
    });
    if (nextIndex < 0) return;
    const line = lyricsView.querySelector('.lyric-line.active');
    if (line) line.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  applyLang();
})();
