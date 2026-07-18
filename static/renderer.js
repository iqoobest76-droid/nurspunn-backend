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
  const albumArt = null;
  const albumBg = null;
  const btnPlay = $('#btn-play');
  const btnPrev = $('#btn-prev');
  const btnNext = $('#btn-next');
  const btnHeart = $('#btn-heart');
  const tNow = $('#time-now');
  const tEnd = $('#time-end');
  const pBar = $('#p-bar');
  const pFill = $('#p-fill');
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
  const searchSuggestions = $('#search-suggestions');
  const searchQueryBar = $('#search-query-bar');
  const fsPlayer = $('#fs-player');
  const fsClose = $('#fs-close');
  const fsBg = $('#fs-bg');
  const fsArt = $('#fs-art');
  const fsTitle = $('#fs-title');
  const fsArtist = $('#fs-artist');
  const fsHeart = $('#fs-heart');
  const fsBar = $('#fs-bar');
  const fsFill = $('#fs-fill');
  const fsTimeNow = $('#fs-time-now');
  const fsTimeEnd = $('#fs-time-end');
  const fsPlay = $('#fs-play');
  const fsPrev = $('#fs-prev');
  const fsNext = $('#fs-next');
  const fsPlayingFrom = $('#fs-playing-from');
  const playerBar = $('#player-bar');

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
  let streamCache = {};
  let loadingTrackId = '';
  // Restore stream cache from localStorage
  try {
    const saved = JSON.parse(localStorage.getItem('nurspunn_stream_cache') || '{}');
    const keys = Object.keys(saved);
    keys.forEach(k => {
      if (saved[k] && saved[k].ts && Date.now() - saved[k].ts < 7200000) {
        const val = saved[k].url;
        // Support both old (object) and new (string) cache formats
        streamCache[k] = typeof val === 'object' ? (val.direct || val.proxy || '') : val;
      }
    });
  } catch(e) {}

  async function apiGet(path) {
    try {
      const r = await fetch(BACKEND_URL + path, { signal: AbortSignal.timeout(60000) });
      if (r.ok) return await r.json();
    } catch (e) { console.warn('apiGet failed', path, e); }
    return null;
  }

  async function getStreamUrl(videoId) {
    if (streamCache[videoId]) return streamCache[videoId];
    try {
      const data = await apiGet('/api/stream?id=' + encodeURIComponent(videoId));
      if (data && data.url) {
        streamCache[videoId] = data.url;
        try {
          const cache = {};
          Object.keys(streamCache).forEach(k => {
            const v = streamCache[k];
            cache[k] = { url: v, ts: Date.now() };
          });
          localStorage.setItem('nurspunn_stream_cache', JSON.stringify(cache));
        } catch(e) {}
        return data.url;
      }
    } catch(e) { console.warn('getStreamUrl server failed', e); }
    return null;
  }

  function preloadStream(videoId) {
    if (!videoId || streamCache[videoId]) return;
    getStreamUrl(videoId).catch(() => {});
  }

  function loadFavs() {
    try { favorites = JSON.parse(localStorage.getItem('nurspunn_favs') || '[]'); } catch(e) { favorites = []; }
  }
  loadFavs();
  // Preload favorites on startup — ALL of them for instant playback
  favorites.forEach(f => preloadStream(f.id));
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
    if (fsPlayer.classList.contains('show') && fsHeart.dataset.id === trackId) { fsHeart.classList.toggle('liked', liked); fsHeart.textContent = liked ? '\u2665' : '\u2661'; }
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
    // Build queries from listening history and favorites
    const historyTracks = [];
    try { historyTracks.push(...JSON.parse(localStorage.getItem('nurspunn_history') || '[]')); } catch(e) {}
    try { historyTracks.push(...favorites); } catch(e) {}

    if (historyTracks.length > 0) {
      // Infer genres from history
      const genreCounts = {};
      historyTracks.forEach(t => {
        const genres = inferGenres(trackText(t));
        genres.forEach(g => { genreCounts[g] = (genreCounts[g] || 0) + 1; });
      });
      // Sort by frequency
      const sorted = Object.entries(genreCounts).sort((a, b) => b[1] - a[1]);
      sorted.forEach(([genre]) => {
        const profile = GENRE_PROFILES.find(p => p.key === genre);
        if (profile) profile.queries.forEach(pq => q.push(pq));
      });
      // Also use artist/channel names from history
      const channels = new Set();
      historyTracks.slice(0, 15).forEach(t => { if (t.channel) channels.add(t.channel); });
      const chArr = [...channels].slice(0, 3);
      chArr.forEach(ch => q.push(ch + ' music'));
    }
    // Fallback if no history
    if (q.length === 0) {
      q.push('popular music 2026', 'viral songs 2026', 'trending music');
    }
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
    // Push browser history so back button has somewhere to go
    if (!skipHistory) {
      try { history.pushState({ view: view }, ''); } catch(e) {}
    }
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
    next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8.5 17.5 5.5-5.5-5.5-5.5 1.8-1.8 7.3 7.3-7.3 7.3-1.8-1.8z"/></svg>'
  };
  function setIcon(el, name) { if (el && ICONS[name]) el.innerHTML = ICONS[name]; }
  function setPlayIcon(isPlaying) {
    setIcon(btnPlay, isPlaying ? 'pause' : 'play');
    setIcon(fsPlay, isPlaying ? 'pause' : 'play');
  }
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
  let backHandled = false;
  function setupBackButton() {
    function registerBack() {
      if (backHandled) return;
      try {
        var Cap = window.Capacitor || window.CapacitorJS;
        if (Cap && Cap.Plugins && Cap.Plugins.App) {
          Cap.Plugins.App.addListener('backButton', function () {
            if (fsPlayer && fsPlayer.classList.contains('show')) {
              closeFsPlayer();
            } else if (navStack.length > 0) {
              var prev = navStack.pop();
              currentViewName = '';
              if (prev === 'home') { showView('home', true); }
              else if (prev === 'search') { showView('search', true); }
              else if (prev === 'fav') { showView('fav', true); }
              else if (prev === 'ai') { showView('ai', true); }
              else { showView('home', true); }
            } else {
              if (Cap.Plugins.App.minimizeApp) {
                Cap.Plugins.App.minimizeApp();
              } else if (Cap.Plugins.App.exitApp) {
                Cap.Plugins.App.exitApp();
              }
            }
          });
          backHandled = true;
          console.log('Back button handler registered');
        }
      } catch (e) { console.warn('Back button setup failed', e); }
    }
    registerBack();
    // Retry if Capacitor bridge not ready yet
    if (!backHandled) {
      setTimeout(registerBack, 500);
      setTimeout(registerBack, 1500);
      setTimeout(registerBack, 3000);
    }
    // Cordova-style fallback
    document.addEventListener('backbutton', function(e) {
      e.preventDefault();
      if (fsPlayer && fsPlayer.classList.contains('show')) {
        closeFsPlayer();
      } else if (navStack.length > 0) {
        var prev = navStack.pop();
        currentViewName = '';
        if (prev === 'home') { showView('home', true); }
        else if (prev === 'search') { showView('search', true); }
        else if (prev === 'fav') { showView('fav', true); }
        else if (prev === 'ai') { showView('ai', true); }
        else { showView('home', true); }
      }
    }, false);
    // Also handle via popstate for browser/PWA
    window.addEventListener('popstate', function(e) {
      if (fsPlayer && fsPlayer.classList.contains('show')) {
        closeFsPlayer();
      } else if (e.state && e.state.view) {
        currentViewName = '';
        var v = e.state.view;
        if (v === 'home') { showView('home', true); }
        else if (v === 'search') { showView('search', true); }
        else if (v === 'fav') { showView('fav', true); }
        else if (v === 'ai') { showView('ai', true); }
        else { showView('home', true); }
      } else if (navStack.length > 0) {
        var prev = navStack.pop();
        currentViewName = '';
        if (prev === 'home') { showView('home', true); }
        else if (prev === 'search') { showView('search', true); }
        else if (prev === 'fav') { showView('fav', true); }
        else if (prev === 'ai') { showView('ai', true); }
        else { showView('home', true); }
      }
    });
  }
  setupBackButton();

  // Register handler for Java-side onBackPressed
  window._nursBackHandler = function() {
    if (fsPlayer && fsPlayer.classList.contains('show')) {
      closeFsPlayer();
    } else if (navStack.length > 0) {
      var prev = navStack.pop();
      currentViewName = '';
      if (prev === 'home') { showView('home', true); }
      else if (prev === 'search') { showView('search', true); }
      else if (prev === 'fav') { showView('fav', true); }
      else if (prev === 'ai') { showView('ai', true); }
      else { showView('home', true); }
    }
    return navStack.length > 0 || (fsPlayer && fsPlayer.classList.contains('show'));
  };

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

  function ytHome() {
    const queries = recommendationQueries();
    // Pick 2-3 random queries from the list
    const shuffled = queries.sort(() => Math.random() - 0.5);
    const picked = shuffled.slice(0, 2);
    // Search with first query, merge with second
    return ytSearch(picked[0], 15).then(r1 => {
      if (picked[1]) {
        return ytSearch(picked[1], 10).then(r2 => {
          const seen = new Set(r1.map(t => t.id));
          const merged = [...r1, ...r2.filter(t => !seen.has(t.id))];
          return merged.slice(0, 20);
        });
      }
      return r1;
    });
  }

  // ========== Playback via Piped + HTML5 Audio ==========
  let streamUrl = '';
  let loadingStream = false;
  let audioUnlocked = false;

  // Unlock audio context on first user gesture
  function unlockAudio() {
    if (audioUnlocked) return;
    try {
      const silent = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=');
      silent.volume = 0;
      silent.play().then(() => { audioUnlocked = true; silent.remove(); }).catch(() => { silent.remove(); });
    } catch(e) {}
  }
  document.addEventListener('touchstart', unlockAudio, { once: true });
  document.addEventListener('click', unlockAudio, { once: true });

  audio.addEventListener('loadedmetadata', () => {
    const dur = audio.duration || 0;
    if (dur > 0) {
      tEnd.textContent = fmt(dur);
      pFill.style.width = '0%';
      tNow.textContent = '0:00';
      if (fsPlayer.classList.contains('show')) {
        fsTimeEnd.textContent = fmt(dur);
        fsFill.style.width = '0%';
        fsTimeNow.textContent = '0:00';
      }
    }
  });

  // "playing" fires when audio actually starts producing sound
  audio.addEventListener('playing', () => {
    playing = true;
    btnPlay.classList.remove('is-loading');
    fsPlay.classList.remove('is-loading');
    setPlayIcon(true);
    setLoading(idx >= 0 && playlist[idx] ? playlist[idx].id : '', false);
    try { if (window.AndroidMusic && playlist[idx]) { window.AndroidMusic.updateNotification(playlist[idx].title || 'nurspunn', playlist[idx].channel || 'Playing'); } } catch(e) {}
  });

  audio.addEventListener('pause', () => {
    if (!audio.ended) {
      playing = false;
      btnPlay.classList.remove('is-loading');
      fsPlay.classList.remove('is-loading');
      setPlayIcon(false);
    }
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
      if (fsPlayer.classList.contains('show')) {
        fsFill.style.width = ((cur / dur) * 100) + '%';
        fsTimeNow.textContent = fmt(cur);
        fsTimeEnd.textContent = fmt(dur);
      }
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
        if (fsPlayer.classList.contains('show')) {
          fsFill.style.width = ((cur / dur) * 100) + '%';
          fsTimeNow.textContent = fmt(cur);
          fsTimeEnd.textContent = fmt(dur);
        }
      }
      updateSyncedLyrics(cur);
      const deepTrack = idx >= 0 ? playlist[idx] : null;
      if (deepTrack && deepTrack.id !== deepListenLoggedFor && cur >= 30) {
        deepListenLoggedFor = deepTrack.id;
      }
    }, 250);
  }

  function setLoading(trackId, isLoading) {
    loadingTrackId = isLoading ? trackId : '';
    $$('.ri[data-i], .tr[data-i]').forEach(r => {
      const n = parseInt(r.getAttribute('data-i'));
      const inPlaylist = n >= 0 && n < playlist.length && playlist[n] && playlist[n].id === trackId;
      r.classList.toggle('loading', isLoading && inPlaylist);
    });
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
    const liked = isFav(t.id);
    btnHeart.dataset.id = t.id;
    btnHeart.textContent = liked ? '\u2665' : '\u2661';
    btnHeart.classList.toggle('liked', liked);
    syncFsPlayer(t, cover, coverFallback);
    try {
      var hist = JSON.parse(localStorage.getItem('nurspunn_history') || '[]');
      hist = hist.filter(h => h.id !== t.id);
      hist.unshift({ id: t.id, title: t.title, channel: t.channel, thumbnail: t.thumbnail || '' });
      if (hist.length > 50) hist = hist.slice(0, 50);
      localStorage.setItem('nurspunn_history', JSON.stringify(hist));
    } catch(e) {}
    $$('.ri').forEach((r, n) => r.classList.toggle('active', n === i));
    $$('.tr').forEach((r, n) => r.classList.toggle('active', n === i));
    renderSide();
    if (fsLyricsActive && idx >= 0 && playlist[idx]) {
      fetchLyrics(playlist[idx].title, playlist[idx].channel);
    }
    try { if (window.AndroidMusic) { window.AndroidMusic.updateNotification(t.title || 'nurspunn', t.channel || 'Playing music'); } } catch(e) {}
    // Auto-open fullscreen player
    openFsPlayer();
    btnPlay.classList.add('is-loading');
    fsPlay.classList.add('is-loading');
    playing = false;
    audio.pause();
    audio.src = '';
    streamUrl = '';
    setLoading(t.id, true);

    getStreamUrl(t.id).then(url => {
      if (idx !== i) return;
      if (url) {
        streamUrl = url;
        audio.src = url;
        const loadTimeout = setTimeout(() => {
          audio.removeEventListener('canplay', onReady);
          audio.removeEventListener('error', onError);
          btnPlay.classList.remove('is-loading');
          fsPlay.classList.remove('is-loading');
          setPlayIcon(false);
          playing = false;
          setLoading(t.id, false);
        }, 60000);
        function onReady() {
          clearTimeout(loadTimeout);
          audio.removeEventListener('canplay', onReady);
          audio.removeEventListener('error', onError);
          setLoading(t.id, false);
          btnPlay.classList.remove('is-loading');
          fsPlay.classList.remove('is-loading');
          audio.muted = false;
          audio.volume = 1;
          audio.play().catch(e => {
            console.warn('play() blocked, retrying', e);
            setTimeout(() => { audio.play().catch(() => {}); }, 400);
          });
        }
        function onError() {
          clearTimeout(loadTimeout);
          audio.removeEventListener('canplay', onReady);
          audio.removeEventListener('error', onError);
          setLoading(t.id, false);
          btnPlay.classList.remove('is-loading');
          fsPlay.classList.remove('is-loading');
          setPlayIcon(false);
          playing = false;
        }
        audio.addEventListener('canplay', onReady, { once: true });
        audio.addEventListener('error', onError, { once: true });
        audio.load();
      } else {
        btnPlay.classList.remove('is-loading');
        fsPlay.classList.remove('is-loading');
        setPlayIcon(false);
        playing = false;
        setLoading(t.id, false);
        results.innerHTML = '<div class="empty" style="padding:30px;text-align:center;color:rgba(255,255,255,0.5);font-size:13px">Stream unavailable. Tap again to retry.</div>';
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
    if (playing) {
      audio.pause();
    } else {
      if (audio.src && audio.src !== '' && !audio.paused) {
        audio.play().catch(() => {});
      } else if (audio.src && audio.src !== '') {
        audio.play().catch(() => {});
      } else {
        play(idx);
      }
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

  function showSuggestions(q) {
    if (!searchSuggestions) return;
    if (!q || q.length < 1) { searchSuggestions.innerHTML = ''; searchSuggestions.style.display = 'none'; return; }
    const lower = q.toLowerCase();
    const suggestions = [];
    // From listening history
    try {
      const hist = JSON.parse(localStorage.getItem('nurspunn_history') || '[]');
      hist.forEach(t => {
        if (t.title && t.title.toLowerCase().includes(lower)) suggestions.push({ title: t.title, channel: t.channel, type: 'hist' });
      });
    } catch(e) {}
    // From favorites
    favorites.forEach(t => {
      if (t.title && t.title.toLowerCase().includes(lower) && !suggestions.some(s => s.title === t.title)) {
        suggestions.push({ title: t.title, channel: t.channel, type: 'fav' });
      }
    });
    // Fetch YouTube autocomplete suggestions
    fetch('https://suggestqueries.google.com/complete/search?client=youtube&ds=yt&q=' + encodeURIComponent(q), {
      signal: AbortSignal.timeout(3000)
    }).then(r => r.text()).then(txt => {
      try {
        const match = txt.match(/\[(\[.*?\])\]/);
        if (match) {
          const arr = JSON.parse(match[1]);
          arr.forEach(item => {
            const title = Array.isArray(item) ? item[0] : (item || '');
            if (title && !suggestions.some(s => s.title.toLowerCase() === title.toLowerCase())) {
              suggestions.push({ title: title, channel: 'YouTube', type: 'yt' });
            }
          });
        }
      } catch(e) {}
      renderSuggestionsList(suggestions, q);
    }).catch(() => {
      renderSuggestionsList(suggestions, q);
    });
    // Show local suggestions immediately while YouTube loads
    renderSuggestionsList(suggestions, q);
  }

  function renderSuggestionsList(suggestions, q) {
    if (!searchSuggestions) return;
    if (!suggestions.length) { searchSuggestions.innerHTML = ''; searchSuggestions.style.display = 'none'; return; }
    searchSuggestions.style.display = 'flex';
    searchSuggestions.innerHTML = suggestions.slice(0, 10).map(s =>
      '<button class="suggestion-chip' + (s.type === 'hist' ? ' hist' : '') + (s.type === 'yt' ? ' yt' : '') + '" data-q="' + esc(s.title) + '">' +
      esc(s.title) + (s.channel ? '<span class="suggestion-sub">' + esc(s.channel) + '</span>' : '') + '</button>'
    ).join('');
    searchSuggestions.querySelectorAll('.suggestion-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        search.value = btn.getAttribute('data-q');
        search.dispatchEvent(new Event('input'));
      });
    });
  }

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
      // Preload ALL home tracks
      tracks.forEach(t => preloadStream(t.id));
      $$('.card').forEach(c => c.addEventListener('click', function () {
        playlist = homePlaylist.slice();
        play(parseInt(this.getAttribute('data-i')));
      }));
      $$('.tr').forEach(r => r.addEventListener('click', function (e) {
        if (e.target.closest('.tr-heart')) return;
        playlist = homePlaylist.slice();
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
  // Push initial state so back button doesn't exit immediately
  try { history.replaceState({ view: 'home' }, ''); } catch(e) {}

  let st;
  search.addEventListener('input', function () {
    clearTimeout(st);
    const q = this.value.trim();
    searchSeq++;
    showSuggestions(q);
    if (!q) { results.innerHTML = '<div class="empty" data-i18n="searchPlaceholder">Search for songs</div>'; searchQueryBar.style.display = 'none'; showView('home'); return; }
    searchQueryBar.style.display = 'flex';
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
      showSuggestions('');
      searchQueryBar.style.display = 'flex';
      queueQuery.textContent = q;
      showView('search');
      results.innerHTML = '<div class="skeleton-list">' + renderSkeletonRows(8) + '</div>';
      ytSearch(q).then(r => { if (seq === searchSeq) renderResults(r, q); });
    }
  });

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
    // Preload ALL tracks for instant playback
    arr.forEach(t => preloadStream(t.id));
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

  // No more queue tabs — lyrics moved to fullscreen player

  function renderSide() {}

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
    const fsLyricsScroll = $('#fs-lyrics-scroll');
    if (fsLyricsScroll) fsLyricsScroll.innerHTML = '<div style="color:rgba(255,255,255,0.5);padding:20px">Searching lyrics...</div>';
    const q = guessArtistAndTitle(title, artist);
    if (!q.title) { if (fsLyricsScroll) fsLyricsScroll.innerHTML = '<div style="color:rgba(255,255,255,0.5);padding:20px">Lyrics not found</div>'; return; }
    const url = 'https://lrclib.net/api/search?track_name=' + encodeURIComponent(q.title) + (q.artist ? '&artist_name=' + encodeURIComponent(q.artist) : '');
    fetch(url).then(r => r.json()).then(matches => {
      if (lyricsTrackId !== trackId) return;
      const best = Array.isArray(matches) && matches.find(item => item?.plainLyrics || item?.syncedLyrics);
      if (best) {
        const synced = best.syncedLyrics || '';
        const plain = best.plainLyrics || '';
        timedLyrics = parseSyncedLyrics(synced);
        if (!timedLyrics.length && plain) timedLyrics = distributePlainLyrics(plain);
        renderFsLyrics(timedLyrics);
        updateSyncedLyrics(audio.currentTime || 0);
      } else {
        if (fsLyricsScroll) fsLyricsScroll.innerHTML = '<div style="color:rgba(255,255,255,0.5);padding:20px">Lyrics not found</div>';
      }
    }).catch(() => {
      if (fsLyricsScroll) fsLyricsScroll.innerHTML = '<div style="color:rgba(255,255,255,0.5);padding:20px">Lyrics unavailable</div>';
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
    const fsLyricsScroll = $('#fs-lyrics-scroll');
    if (!lines.length) { if (fsLyricsScroll) fsLyricsScroll.innerHTML = '<div style="color:rgba(255,255,255,0.5);padding:20px">Lyrics not found</div>'; return; }
    if (fsLyricsScroll) {
      fsLyricsScroll.innerHTML = lines.map((line, i) =>
        '<div class="fs-lyric-line" data-i="' + i + '">' + esc(line.text) + '</div>'
      ).join('');
    }
  }
  const renderFsLyrics = renderSyncedLyrics;

  function updateSyncedLyrics(currentTime) {
    if (!timedLyrics.length) return;
    const fsLyricsScroll = $('#fs-lyrics-scroll');
    const isActive = fsPlayer.classList.contains('show') && fsLyricsScroll && fsLyricsScroll.children.length > 0;
    if (!isActive) return;
    let nextIndex = -1;
    for (let i = 0; i < timedLyrics.length; i++) {
      if (timedLyrics[i].time <= currentTime + 0.18) nextIndex = i;
      else break;
    }
    if (nextIndex === activeLyricIndex) return;
    activeLyricIndex = nextIndex;
    fsLyricsScroll.querySelectorAll('.fs-lyric-line').forEach(el => {
      const n = parseInt(el.getAttribute('data-i'), 10);
      const distance = n - nextIndex;
      el.classList.remove('active', 'near');
      if (distance === 0) el.classList.add('active');
      else if (Math.abs(distance) <= 1) el.classList.add('near');
    });
    if (nextIndex < 0) return;
    const line = fsLyricsScroll.querySelector('.fs-lyric-line.active');
    if (line) line.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  // === FULLSCREEN PLAYER ===

  function syncFsPlayer(t, cover, coverFallback) {
    if (!t) {
      if (idx < 0 || !playlist[idx]) return;
      t = playlist[idx];
      cover = bestThumb(t);
      coverFallback = fallbackThumb(t);
    }
    fsTitle.textContent = t.title;
    fsArtist.textContent = t.channel;
    fsArt.innerHTML = '<img src="' + esc(cover) + '" data-fallback="' + esc(fallbackThumb(t)) + '" alt="">';
    bindImageFallback(fsArt);
    fsBg.style.backgroundImage = 'url(' + cover + ')';
    const liked = isFav(t.id);
    fsHeart.textContent = liked ? '\u2665' : '\u2661';
    fsHeart.classList.toggle('liked', liked);
    fsHeart.dataset.id = t.id;
    fsPlayingFrom.textContent = 'nurspunn';
    setIcon(fsPlay, playing ? 'pause' : 'play');
    const dur = audio.duration || 0;
    const cur = audio.currentTime || 0;
    if (dur > 0) {
      fsFill.style.width = ((cur / dur) * 100) + '%';
      fsTimeNow.textContent = fmt(cur);
      fsTimeEnd.textContent = fmt(dur);
    }
    // Extract dominant color for gradient animation
    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = cover;
      img.onload = function() {
        const canvas = document.createElement('canvas');
        canvas.width = 1; canvas.height = 1;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        const r = d[0], g = d[1], b = d[2];
        fsArt.style.boxShadow = '0 20px 60px rgba(' + r + ',' + g + ',' + b + ',0.4)';
      };
    } catch(e) {}
  }

  function openFsPlayer() {
    if (fsPlayer.classList.contains('show')) return;
    syncFsPlayer();
    fsPlayer.classList.add('show');
    document.body.style.overflow = 'hidden';
    history.pushState({ fs: true }, '');
  }

  function closeFsPlayer() {
    fsPlayer.classList.remove('show');
    document.body.style.overflow = '';
  }

  fsClose.addEventListener('click', closeFsPlayer);
  playerBar.addEventListener('click', function(e) {
    if (e.target.closest('.p-btn') || e.target.closest('.p-heart')) return;
    openFsPlayer();
  });

  // Lyrics toggle in fullscreen player
  const fsLyricsBtn = $('#fs-lyrics-btn');
  const fsLyricsOverlay = $('#fs-lyrics-overlay');
  let fsLyricsActive = false;
  if (fsLyricsBtn) {
    fsLyricsBtn.addEventListener('click', () => {
      fsLyricsActive = !fsLyricsActive;
      fsLyricsBtn.classList.toggle('active', fsLyricsActive);
      fsArt.classList.toggle('lyrics-mode', fsLyricsActive);
      fsLyricsOverlay.classList.toggle('visible', fsLyricsActive);
      if (fsBg) fsBg.classList.toggle('lyrics-bg', fsLyricsActive);
      if (fsLyricsActive && idx >= 0 && playlist[idx]) {
        fetchLyrics(playlist[idx].title, playlist[idx].channel);
      }
    });
  }

  fsPlay.addEventListener('click', () => {
    if (idx === -1 && playlist.length > 0) { play(0); return; }
    if (idx === -1) return;
    if (playing) {
      audio.pause();
    } else {
      if (audio.src && audio.src !== '') {
        audio.play().catch(() => {});
      } else {
        play(idx);
      }
    }
  });

  fsPrev.addEventListener('click', () => {
    if (!playlist.length) return;
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    play(idx <= 0 ? playlist.length - 1 : idx - 1);
  });

  fsNext.addEventListener('click', doNext);

  fsHeart.addEventListener('click', () => { if (idx < 0 || !playlist[idx]) return; toggleFav(playlist[idx]); });

  fsBar.addEventListener('click', e => {
    const dur = audio.duration || 0;
    if (!dur) return;
    const rect = fsBar.getBoundingClientRect();
    audio.currentTime = ((e.clientX - rect.left) / rect.width) * dur;
  });

  // Gradient animation when playing
  audio.addEventListener('play', () => {
    if (fsPlayer.classList.contains('show')) fsBg.classList.add('animating');
  });
  audio.addEventListener('pause', () => {
    fsBg.classList.remove('animating');
  });

  // Pull-to-refresh on home
  (function() {
    const indicator = document.querySelector('.pull-refresh-indicator');
    const spinner = indicator ? indicator.querySelector('.pull-refresh-spinner') : null;
    if (!indicator || !vHome) return;
    let startY = 0, pulling = false, refreshing = false;
    vHome.addEventListener('touchstart', function(e) {
      if (refreshing) return;
      if (vHome.scrollTop > 5) return;
      startY = e.touches[0].clientY;
      pulling = true;
    }, { passive: true });
    vHome.addEventListener('touchmove', function(e) {
      if (!pulling || refreshing) return;
      const diff = e.touches[0].clientY - startY;
      if (diff > 20 && vHome.scrollTop <= 0) {
        indicator.classList.add('visible');
      } else {
        indicator.classList.remove('visible');
      }
    }, { passive: true });
    vHome.addEventListener('touchend', function() {
      if (!pulling) return;
      pulling = false;
      if (indicator.classList.contains('visible') && !refreshing) {
        refreshing = true;
        indicator.classList.add('loading');
        loadHome();
        const checkDone = setInterval(() => {
          if (homeCards && !homeCards.querySelector('.skeleton-grid') && homeCards.children.length > 0) {
            clearInterval(checkDone);
            indicator.classList.remove('visible', 'loading');
            refreshing = false;
          }
        }, 500);
        setTimeout(() => { clearInterval(checkDone); indicator.classList.remove('visible', 'loading'); refreshing = false; }, 15000);
      } else {
        indicator.classList.remove('visible');
      }
    }, { passive: true });
  })();

  // Keep server alive — ping every 4 minutes to prevent Render cold start
  setInterval(() => {
    apiGet('/api/keepalive').catch(() => {});
  }, 240000);

  applyLang();
})();
