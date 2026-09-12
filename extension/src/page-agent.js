/*
 * SubtitleCorrector - page agent (draait in de MAIN world van de pagina).
 *
 * Verantwoordelijk voor alle communicatie met de YouTube player:
 *   - probe:    leest de audiotaal, de huidige ondertitel-track en alle tracks
 *   - apply:    zet de juiste ondertitel-track (API + settings-menu)
 *   - events:   meldt video-wissels / ads / ondertitelwijzigingen aan de content script
 *
 * BELANGRIJKE, EMPIRISCH GEVERIFIEERDE FEITEN (YouTube, 2026-09):
 *   1. player.getAudioTrack().s1.id == "en.4"  -> taal van de HUIDIGE audiotrack.
 *      Is "und" als YouTube de taal niet kent (bv. veel NL-video's zonder dub).
 *   2. player.getOption('captions','track')    -> huidige track:
 *      {languageCode, kind(''|'asr'), vss_id, displayName, translationLanguage:{...}}
 *      Let op: bij het uitlezen heten de velden vss_id / is_translateable (snake_case),
 *      bij het zetten gebruiken we vss_id.
 *   3. translationLanguage != null  ==  YouTube vertaalt de ondertitels (jouw probleem).
 *      displayName bevat dan " >> <taal>".
 *   4. player.setOption('captions','track',{languageCode,vss_id}) KAN WEL een
 *      handmatige track zetten, maar NIET de auto-gegenereerde ('asr') track:
 *      die valt altijd terug op de handmatige track van dezelfde taal.
 *      De auto-gegenereerde track is alleen te kiezen via het settings-menu:
 *      settings -> "Subtitles/CC" -> item "<Taal> (auto-generated)".
 *   5. In dat menu is de actieve track af te lezen via
 *      .ytp-menuitem[aria-checked="true"] in het zichtbare .ytp-panel-menu.
 *   6. Vertaalde varianten staan als APART menu-item met " >> <taal>" in het label;
 *      die moeten we nooit aanklikken (dan zet je de vertaling juist aan).
 */
(function () {
  'use strict';

  var L = globalThis.SCLang;
  if (!L) {
    console.warn('[SC/page] lang-utils.js niet geladen - page agent doet niets');
    return;
  }

  var DEBUG = false;
  function dbg() {
    if (!DEBUG) return;
    var a = [].slice.call(arguments);
    console.log.apply(console, ['[SC/page]'].concat(a));
  }

  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  function safe(fn, dflt) {
    try {
      var v = fn();
      return v === undefined ? dflt : v;
    } catch (e) {
      return dflt;
    }
  }

  /* ------------------------------------------------------------------ *
   * Berichten: content script (isolated world) <-> page agent (main world)
   * ------------------------------------------------------------------ */
  function post(payload) {
    try {
      var msg = { __sc: true, dir: 'to-content' };
      for (var k in payload) if (Object.prototype.hasOwnProperty.call(payload, k)) msg[k] = payload[k];
      window.postMessage(msg, location.origin);
    } catch (e) { /* ignore */ }
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.__sc !== true || d.dir !== 'to-page') return;

    if (d.type === 'setDebug') { DEBUG = !!d.value; dbg('debug', DEBUG); post({ id: d.id, type: 'reply', ok: true, result: { debug: DEBUG } }); return; }

    handle(d).then(
      function (result) { post({ id: d.id, type: 'reply', ok: true, result: result }); },
      function (err) { post({ id: d.id, type: 'reply', ok: false, error: String((err && err.message) || err) }); }
    );
  });

  function handle(d) {
    switch (d.type) {
      case 'ping': return Promise.resolve({ pong: true, videoId: currentVideoId() });
      case 'probe': return Promise.resolve(probe());
      case 'apply': return apply(d.payload || {});
      case 'setOptions': return Promise.resolve(setPageOptions(d.payload || {}));
      case 'setSubtitlesOff': return Promise.resolve(setSubtitlesOff(!!(d.payload && d.payload.off), 'content'));
      case 'state': return Promise.resolve({ videoId: currentVideoId(), current: readCurrentTrack(), captionsOn: captionsOn(), adShowing: isAd() });
      default: return Promise.resolve({ ok: false, reason: 'unknown-request:' + d.type });
    }
  }

  /* ------------------------------------------------------------------ *
   * Player uitlezen
   * ------------------------------------------------------------------ */
  function player() { return document.getElementById('movie_player'); }

  function currentVideoId() {
    var p = player();
    var vd = safe(function () { return p && p.getVideoData ? p.getVideoData() : null; }, null);
    if (vd && vd.video_id) return vd.video_id;
    var m = /[?&]v=([A-Za-z0-9_-]{6,})/.exec(location.href);
    return m ? m[1] : null;
  }

  function isAd() {
    var wrap = document.querySelector('.html5-video-player');
    if (wrap && /\bad-showing\b/.test(String(wrap.className))) return true;
    var p = player();
    var st = safe(function () { return p && p.getAdState ? p.getAdState() : -1; }, -1);
    return st > 0;
  }

  function readCurrentTrack() {
    var p = player();
    if (!p || !p.getOption) return null;
    var t = safe(function () { return p.getOption('captions', 'track'); });
    if (!t || !t.languageCode) return null;
    var vss = t.vssId || t.vss_id || null;
    var tr = t.translationLanguage || null;
    return {
      languageCode: t.languageCode,
      languageName: t.languageName || t.displayName || null,
      displayName: t.displayName || t.languageName || null,
      kind: t.kind || '',
      vssId: vss,
      isAutoGenerated: (t.kind === 'asr') || /^a\./.test(String(vss || '')),
      translated: !!tr,
      translatedTo: tr ? (tr.languageCode || tr) : null
    };
  }

  function captionsOn() {
    if (readCurrentTrack()) return true;
    var btn = document.querySelector('.ytp-subtitles-button');
    if (btn) return btn.getAttribute('aria-pressed') === 'true';
    return false;
  }

  /** Alle bekende tracks (bron: audioTrack.captionTracks + getOption tracklist). */
  function collectTracks() {
    var p = player();
    if (!p) return [];
    var out = [];
    var seen = {};

    function add(t) {
      if (!t || !t.languageCode) return;
      var vss = t.vssId || t.vss_id || '';
      var disp = t.displayName || t.name || t.languageName || '';
      if (L.isTranslatedLabel(disp)) return; // vertaalde pseudo-items overslaan
      var key = t.languageCode + '|' + (t.kind || '') + '|' + vss;
      if (seen[key]) return;
      seen[key] = true;
      out.push({
        languageCode: t.languageCode,
        languageName: t.languageName || '',
        displayName: disp,
        kind: t.kind || '',
        vssId: vss,
        isAutoGenerated: (t.kind === 'asr') || /^a\./.test(vss),
        translated: false
      });
    }

    var at = safe(function () { return p.getAudioTrack ? p.getAudioTrack() : null; }, null);
    if (at && at.captionTracks && at.captionTracks.forEach) at.captionTracks.forEach(add);

    var tl = safe(function () { return p.getOption('captions', 'tracklist'); }, []);
    if (tl && tl.forEach) tl.forEach(add);

    return out;
  }

  function readAudioTrack() {
    var p = player();
    if (!p || !p.getAudioTrack) return null;
    var at = safe(function () { return p.getAudioTrack(); }, null);
    if (!at) return null;
    var s1 = at.s1 || null;
    var code = s1 ? L.decodeAudioTrackLang(s1.id) : null;
    if (!code) code = L.decodeAudioTrackLang(at.id);
    if (!code && !(s1 && s1.name)) return null;
    return {
      languageCode: code,
      id: (s1 && s1.id) || at.id || null,
      name: (s1 && s1.name) || null,
      isAutoDubbed: !!(s1 && s1.isAutoDubbed)
    };
  }

  function uniq(arr) {
    var seen = {};
    return arr.filter(function (v) {
      if (!v || seen[v]) return false;
      seen[v] = true;
      return true;
    });
  }

  function probe() {
    var p = player();
    if (!p) return { ok: false, reason: 'no-player' };

    var vd = safe(function () { return p.getVideoData ? p.getVideoData() : null; }, null);
    var tracks = collectTracks();
    var supported = tracks.filter(function (t) { return L.isSupported(t.languageCode); });
    var asrLanguages = uniq(tracks.filter(function (t) { return t.isAutoGenerated; })
      .map(function (t) { return L.baseLang(t.languageCode); }));

    var pr = safe(function () { return p.getPlayerResponse ? p.getPlayerResponse() : null; }, null);
    var defaultAudioLanguage = pr && pr.videoDetails ? (pr.videoDetails.defaultAudioLanguage || null) : null;

    return {
      ok: true,
      videoId: currentVideoId(),
      title: (vd && vd.title) || null,
      adShowing: isAd(),
      playerState: safe(function () { return p.getPlayerState(); }, -1),
      captionsOn: captionsOn(),
      current: readCurrentTrack(),
      audioTrack: readAudioTrack(),
      tracks: supported,
      allTrackCount: tracks.length,
      asrLanguages: asrLanguages,
      defaultAudioLanguage: defaultAudioLanguage
    };
  }

  /* ------------------------------------------------------------------ *
   * Menu-automatisering (settings -> Subtitles/CC -> item)
   * ------------------------------------------------------------------ */
  function clickEl(el) {
    if (!el) return false;
    try {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;
    } catch (e) {
      try { el.click(); return true; } catch (e2) { return false; }
    }
  }

  function labelOf(item) {
    var el = item.querySelector('.ytp-menuitem-label');
    return el ? String(el.textContent || '') : String(item.textContent || '');
  }

  function contentOf(item) {
    var el = item.querySelector('.ytp-menuitem-content');
    return el ? String(el.textContent || '') : '';
  }

  function menuItems(scope) {
    return [].slice.call((scope || document).querySelectorAll('.ytp-menuitem'));
  }

  function visiblePanelMenus() {
    return [].slice.call(document.querySelectorAll('.ytp-panel-menu')).filter(function (m) { return m.offsetParent !== null; });
  }

  function visiblePanel() {
    var m = visiblePanelMenus();
    return m.length ? m[m.length - 1] : null;
  }

  function settingsOpen() {
    var el = document.querySelector('.ytp-settings-menu');
    return !!el && el.offsetParent !== null;
  }

  function subPanelOpen() {
    var b = document.querySelector('.ytp-panel-back-button');
    return !!b && b.offsetParent !== null;
  }

  function settingsButton() { return document.querySelector('.ytp-settings-button'); }

  async function closeSettings() {
    if (!settingsOpen()) return;
    clickEl(settingsButton());
    await sleep(250);
  }

  /** De rij "Subtitles/CC" in het hoofdmenu van de settings. */
  function findSubtitlesEntry() {
    var items = menuItems();
    var byLabel = items.filter(function (e) { return L.RE_SUBTITLE_ITEM.test(labelOf(e)); });
    if (byLabel.length) return byLabel[0];

    // Fallback: de rij waarvan de inhoud de huidige ondertitel-taal toont
    var cur = readCurrentTrack();
    var names = [];
    if (cur) {
      if (cur.languageName) names.push(L.normalizeLabel(cur.languageName));
      if (cur.displayName) names.push(L.normalizeLabel(cur.displayName));
    }
    if (names.length) {
      var byContent = items.filter(function (e) {
        var c = L.normalizeLabel(contentOf(e));
        return c && names.indexOf(c) !== -1;
      });
      if (byContent.length) return byContent[0];
    }
    return null;
  }

  async function openCaptionsPanel() {
    if (!settingsOpen()) {
      clickEl(settingsButton());
      await sleep(500);
    }
    if (!subPanelOpen()) {
      var entry = findSubtitlesEntry();
      if (!entry) {
        dbg('Subtitles/CC-rij niet gevonden', menuItems().map(labelOf));
        await closeSettings();
        return null;
      }
      clickEl(entry);
      await sleep(700);
    }
    return visiblePanel();
  }

  /**
   * Zoekt het menu-item voor de doel-track.
   * Nooit een item met ">>"-suffix (dat is de vertaalde variant).
   */
  function findTargetItem(panel, target) {
    var items = menuItems(panel).filter(function (e) { return !L.isTranslatedLabel(labelOf(e)); });
    if (!items.length) return null;

    var want = L.normalizeLabel(L.stripTranslationSuffix(target.displayName || target.languageName || target.languageCode));
    var nameSource = target.languageName || target.displayName || '';
    var firstWord = L.normalizeLabel(L.stripTranslationSuffix(nameSource)).split(/[\s(]+/)[0] || '';

    // 1. exact
    var it = items.filter(function (e) { return L.normalizeLabel(labelOf(e)) === want; })[0];
    if (it) return it;

    // 2. begint met de verwachte naam
    if (want) {
      it = items.filter(function (e) { return L.normalizeLabel(labelOf(e)).indexOf(want) === 0; })[0];
      if (it) return it;
    }

    if (target.isAutoGenerated) {
      // 3. auto-generated-hint + taalnaam
      it = items.filter(function (e) {
        var l = labelOf(e);
        if (!L.RE_AUTO_GENERATED.test(l)) return false;
        return !firstWord || L.normalizeLabel(l).indexOf(firstWord) !== -1;
      })[0];
      if (it) return it;

      // 3b. structureel: het enige "(...)"-item vóór "Auto-translate"
      var idx = -1;
      items.forEach(function (e, i) { if (idx < 0 && L.RE_AUTO_TRANSLATE.test(labelOf(e))) idx = i; });
      var before = idx > 0 ? items.slice(0, idx) : items;
      var paren = before.filter(function (e) { return /\(.+\)/.test(labelOf(e)); });
      if (paren.length === 1) return paren[0];

      // 4. laatste redmiddel: elk auto-generated item
      it = items.filter(function (e) { return L.RE_AUTO_GENERATED.test(labelOf(e)); })[0];
      if (it) return it;
    }

    // 5. taalnaam ergens in het label (handmatige track)
    if (firstWord) {
      it = items.filter(function (e) { return L.normalizeLabel(labelOf(e)).indexOf(firstWord) !== -1; })[0];
      if (it) return it;
    }
    return null;
  }

  async function applyViaMenu(target) {
    var panel = await openCaptionsPanel();
    if (!panel) return { ok: false, reason: 'no-panel' };
    var item = findTargetItem(panel, target);
    if (!item) {
      dbg('doel-item niet gevonden voor', target, menuItems(panel).map(labelOf));
      await closeSettings();
      return { ok: false, reason: 'no-item' };
    }
    var clicked = labelOf(item);
    clickEl(item);
    await sleep(900);
    await closeSettings();
    return { ok: true, clicked: clicked };
  }

  /** Sterkste controle: welk menu-item staat aangevinkt? */
  async function readCheckedMenuItem() {
    var panel = await openCaptionsPanel();
    if (!panel) return null;
    var checked = menuItems(panel).filter(function (e) { return e.getAttribute('aria-checked') === 'true'; })[0];
    var label = checked ? labelOf(checked) : null;
    await closeSettings();
    return label;
  }

  function verifyState(st, target) {
    if (!st) return false;
    if (!L.sameLang(st.languageCode, target.languageCode)) return false;
    if (st.translated) return false;
    if (target.isAutoGenerated && !st.isAutoGenerated) return false;
    return true;
  }

  /* ------------------------------------------------------------------ *
   * Toepassen
   * ------------------------------------------------------------------ */
  async function apply(payload) {
    var target = payload.target;
    var p = player();
    if (!p) return { ok: false, reason: 'no-player' };
    if (!target || !target.languageCode) return { ok: false, reason: 'no-target' };
    if (isAd()) return { ok: false, reason: 'ad-playing' };

    var before = readCurrentTrack();
    var attempts = [];

    // 1. Snel pad via de player-API (werkt alleen voor handmatige tracks).
    if (!target.isAutoGenerated) {
      var apiObj = { languageCode: target.languageCode, vss_id: target.vssId || ('.' + target.languageCode) };
      try {
        p.setOption('captions', 'track', apiObj);
        attempts.push('api');
      } catch (e) {
        attempts.push('api-error');
      }
      await sleep(700);
      var st1 = readCurrentTrack();
      if (verifyState(st1, target)) {
        return { ok: true, method: 'api', attempts: attempts, before: before, after: st1, target: target };
      }
    }

    // 2. Menu-pad: nodig voor auto-gegenereerde tracks (en om een vertaling te wissen).
    var menuRes = await applyViaMenu(target);
    attempts.push('menu:' + (menuRes.reason || 'clicked'));
    await sleep(400);
    var st2 = readCurrentTrack();
    if (verifyState(st2, target)) {
      return { ok: true, method: 'menu', clicked: menuRes.clicked, attempts: attempts, before: before, after: st2, target: target };
    }

    // 3. Handmatige track van dezelfde taal als terugval (prioriteit 2).
    if (target.isAutoGenerated && payload.allowManualFallback !== false) {
      var manual = collectTracks().filter(function (t) {
        return L.sameLang(t.languageCode, target.languageCode) && !t.isAutoGenerated;
      })[0];
      if (manual) {
        try {
          p.setOption('captions', 'track', { languageCode: manual.languageCode, vss_id: manual.vssId || ('.' + manual.languageCode) });
          attempts.push('api-manual-fallback');
        } catch (e) { /* ignore */ }
        await sleep(700);
        var st3 = readCurrentTrack();
        if (verifyState(st3, manual)) {
          return { ok: true, method: 'api', fallback: 'manual', attempts: attempts, before: before, after: st3, target: manual };
        }
      }
    }

    // 4. Diagnose: wat staat er aangevinkt?
    var checked = null;
    try { checked = await readCheckedMenuItem(); } catch (e) { /* ignore */ }

    return {
      ok: false,
      reason: menuRes.reason === 'no-item' ? 'menu-item-missing' : 'verify-failed',
      attempts: attempts,
      before: before,
      after: readCurrentTrack(),
      expected: target,
      checkedMenuItem: checked
    };
  }

  /* ------------------------------------------------------------------ *
   * Caption Boost: eigen vloeiende ondertitelweergave
   *
   * YouTube's eigen caption-venster loopt in playlists soms 1-2 s achter en
   * toont dan in blokken tekst. De speler haalt de track zelf op via XHR
   * (json3, met `tOffsetMs` per woord bij ASR); die respons vangen we
   * passief op en we tekenen de tekst zelf woord voor woord synchroon met
   * `getCurrentTime()`. YouTube's caption-venster verbergen we zolang dat
   * lukt; lukt het niet, dan blijft YouTube's eigen weergave gewoon staan.
   * ------------------------------------------------------------------ */
  var CAPTION_BOOST_ENABLED = true;
  var BOOST_MAX_TRACKS = 2;

  var boost = {
    videoId: null,
    trackKey: null,
    events: null,
    shownOnce: false,
    frame: 0,
    rafActive: false,
    rafHandle: null,
    overlay: null,
    bar: null,
    box: null,
    scrollEl: null,
    lines: null,          // regelmeting van de huidige cue (venster met max. BOOST_LINES regels)
    windowOffset: -1,     // huidige verschuiving (px) van het tekstvenster
    pendingLines: false,  // nog meten zodra de overlay zichtbaar is
    cueSpans: null,
    cueKey: null,
    cueShown: -1,
    styleReady: false
  };

  var boostTracks = Object.create(null);
  var boostTrackOrder = [];

  function boostKey(videoId, lang, kind) {
    return videoId + '|' + (lang || '') + '|' + (kind || '');
  }

  function urlParam(url, name) {
    var m = new RegExp('[?&]' + name + '=([^&]*)').exec(String(url || ''));
    return m ? decodeURIComponent(m[1]) : null;
  }

  /** Timedtext-respons (json3) bewaren; nooit een fout naar de speler laten lekken. */
  function storeBoostTrack(url, body) {
    if (!CAPTION_BOOST_ENABLED) return;
    try {
      var lang = urlParam(url, 'lang');
      var v = urlParam(url, 'v');
      if (!v || !lang || !L.isSupported(lang)) return;
      if (urlParam(url, 'tlang')) return; // vertaalde variant: nooit gebruiken
      var data = body;
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch (e) { return; }
      }
      if (!data || !data.events) return;
      var events = L.parseCaptionJson(data);
      if (!events.length) return;
      var key = boostKey(v, L.baseLang(lang), urlParam(url, 'kind') || '');
      if (!boostTracks[key]) boostTrackOrder.push(key);
      boostTracks[key] = { at: Date.now(), events: events };
      while (boostTrackOrder.length > BOOST_MAX_TRACKS) {
        var old = boostTrackOrder.shift();
        if (old !== key) delete boostTracks[old];
      }
      dbg('timedtext opgevangen', key, events.length);
    } catch (e) { /* ignore */ }
  }

  /**
   * De speler gebruikt XMLHttpRequest (met pot-token) voor timedtext; direct
   * fetchen levert een lege 200 op. We observeren alleen — de respons zelf
   * blijft ongemoeid. fetch-varianten worden voor de zekerheid ook gevolgd.
   */
  function installTimedtextHooks() {
    try {
      if (window.__scTtHooked) return;
      window.__scTtHooked = true;
      var origOpen = XMLHttpRequest.prototype.open;
      var origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, url) {
        try {
          this.__scTtUrl = String(url || '');
          this.__scTt = this.__scTtUrl.indexOf('/api/timedtext') !== -1;
        } catch (e) { /* ignore */ }
        return origOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function () {
        if (this.__scTt) {
          try {
            var xhr = this;
            xhr.addEventListener('load', function () {
              try {
                var txt = null;
                try { txt = xhr.responseText || null; } catch (e) { txt = null; }
                if (!txt) {
                  try { if (typeof xhr.response === 'string') txt = xhr.response; } catch (e) { /* ignore */ }
                }
                if (txt) storeBoostTrack(xhr.__scTtUrl, txt);
              } catch (e) { /* ignore */ }
            });
          } catch (e) { /* ignore */ }
        }
        return origSend.apply(this, arguments);
      };
    } catch (e) { /* ignore */ }

    try {
      var origFetch = window.fetch;
      if (origFetch && !origFetch.__scWrapped) {
        var wrapped = function (input, init) {
          var url = typeof input === 'string' ? input : (input && input.url) || '';
          var pr = origFetch.apply(this, arguments);
          if (String(url).indexOf('/api/timedtext') !== -1) {
            try {
              pr.then(function (res) {
                try {
                  res.clone().text().then(function (t) { storeBoostTrack(url, t); }).catch(function () {});
                } catch (e) { /* ignore */ }
              }).catch(function () {});
            } catch (e) { /* ignore */ }
          }
          return pr;
        };
        wrapped.__scWrapped = true;
        window.fetch = wrapped;
      }
    } catch (e) { /* ignore */ }
  }

  function boostSupported(cur) {
    return !!cur && L.isSupported(cur.languageCode) && !cur.translated;
  }

  /* Stijl en grootte van de overlay: kleuren/opacity komen uit YouTube's eigen
     captioninstellingen (player.getSubtitlesUserSettings), de grootte is een
     percentage bovenop YouTube's size-stand. */
  var BOOST_SIZE_PCT = 175;    // default ondertitelgrootte (%; optie 50-250)
  var BOOST_LINES = 2;         // max. regels in de eigen weergave (1 of 2; optie, default 2)
  var BOOST_BAR_WIDTH = 0.8;   // de ondertitelbalk is 80% van de spelerbreedte en staat
                               // gecentreerd: links en rechts blijft video zichtbaar
                               // (geen balk van rand tot rand)
  var SUBTITLES_OFF = false;   // per-tab kill switch (knop in de controlbar)
  var boostStyle = { at: 0, textColor: 'rgba(255,255,255,1)', bgColor: 'rgba(0,0,0,1)', increment: 0, applied: '' };

  function refreshBoostStyle(force) {
    var now = Date.now();
    if (!force && now - boostStyle.at < 5000) return;
    boostStyle.at = now;
    var p = player();
    var s = null;
    try { s = p && p.getSubtitlesUserSettings ? p.getSubtitlesUserSettings() : null; } catch (e) { s = null; }
    if (!s) return; // geen API: witte tekst op zwarte achtergrond (default) aanhouden
    var tc = L.rgbaFromHex(s.color, typeof s.textOpacity === 'number' ? s.textOpacity : 1);
    var bc = L.rgbaFromHex(s.background, typeof s.backgroundOpacity === 'number' ? s.backgroundOpacity : 1);
    if (tc) boostStyle.textColor = tc;
    if (bc) boostStyle.bgColor = bc;
    boostStyle.increment = typeof s.fontSizeIncrement === 'number' ? s.fontSizeIncrement : 0;
  }

  function applyBoostStyle() {
    var el = boost.overlay;
    if (!el) return;
    var p = player();
    var px = L.captionFontPx(p ? p.clientHeight : 400, boostStyle.increment, BOOST_SIZE_PCT);
    var key = Math.round(px * 10) + '|' + boostStyle.textColor + '|' + boostStyle.bgColor;
    if (key === boostStyle.applied) return;
    boostStyle.applied = key;
    boost.cueKey = null; // stijl/grootte gewijzigd -> cue opnieuw opbouwen (en meten)
    el.style.fontSize = (Math.round(px * 10) / 10) + 'px';
    if (boost.bar) boost.bar.style.background = boostStyle.bgColor;
    if (boost.box) {
      boost.box.style.color = boostStyle.textColor;
      boost.box.style.background = ''; // achtergrond zit op de balk (ook na een extensie-herlaadbeurt op een open pagina)
    }
  }

  function ensureBoostDom() {
    var p = player();
    if (!p) return null;
    if (!boost.styleReady) {
      try {
        // Een oud style-element van een eerdere versie (extensie herladen
        // zonder pagina-refresh) zou oude regels kunnen laten gelden -> weg.
        var oldStyle = document.getElementById('sc-caption-style');
        if (oldStyle && oldStyle.parentNode) oldStyle.parentNode.removeChild(oldStyle);
        var st = document.createElement('style');
        st.id = 'sc-caption-style';
        st.textContent =
          '.sc-boost-on .ytp-caption-window-container{display:none!important}' +
          '#sc-caption-overlay{position:absolute;left:0;right:0;bottom:10.5%;text-align:center;pointer-events:none;z-index:45;display:none;' +
          'font-weight:600;line-height:1.4;font-family:"YouTube Sans","Roboto",Arial,sans-serif}' +
          '#sc-caption-overlay.sc-on{display:block}' +
          // De balk is BOOST_BAR_WIDTH breed en wordt gecentreerd (left/right
          // zet ensureBoostDom inline): links en rechts blijft video zichtbaar.
          // De box is precies zo breed als de balk (border-box, dus de padding
          // valt binnen die breedte); de tekst begint linksboven, links
          // uitgelijnd. De box is het VENSTER: hij toont max. BOOST_LINES
          // regels (overflow:hidden) en de tekst erin schuift regel voor regel
          // omhoog zodra een nieuwe regel begint — zoals YouTube's eigen
          // ondertitels; het font krimpt nooit.
          '#sc-caption-overlay .sc-caption-bar{position:absolute;top:0;bottom:0}' +
          '#sc-caption-overlay .sc-caption-box{position:relative;display:inline-block;overflow:hidden;box-sizing:border-box;width:' +
          (Math.round(BOOST_BAR_WIDTH * 1000) / 10) + '%;text-align:left;white-space:pre-wrap;' +
          'padding:.06em .32em;text-shadow:0 0 2px rgba(0,0,0,.8)}' +
          '#sc-caption-overlay .sc-caption-scroll{position:relative}';
        (document.head || document.documentElement).appendChild(st);
        boost.styleReady = true;
      } catch (e) { /* ignore */ }
    }
    var el = document.getElementById('sc-caption-overlay');
    if (el && el.parentNode && el.parentNode !== p) el.parentNode.removeChild(el);
    if (!el) {
      el = document.createElement('div');
      el.id = 'sc-caption-overlay';
    }
    var bar = el.querySelector('.sc-caption-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'sc-caption-bar';
      el.insertBefore(bar, el.firstChild);
    }
    var sidePct = ((1 - BOOST_BAR_WIDTH) / 2 * 100).toFixed(2) + '%'; // 10.00% bij 80%
    if (bar.style.left !== sidePct) bar.style.left = sidePct;
    if (bar.style.right !== sidePct) bar.style.right = sidePct;
    var box = el.querySelector('.sc-caption-box');
    if (!box) {
      box = document.createElement('div');
      box.className = 'sc-caption-box';
      el.appendChild(box);
    }
    // Oudere versies zetten een inline max-width (fit-breedte) op de box; die
    // moet weg, anders wikkelt de tekst niet meer over de volle balk.
    if (box.style.maxWidth) box.style.maxWidth = '';
    var scrollEl = box.querySelector('.sc-caption-scroll');
    if (!scrollEl) {
      // Eerste keer (of een oudere versie zette de spans direct in de box):
      // de box helemaal leegmaken en de scroll-wrapper aanmaken.
      while (box.firstChild) box.removeChild(box.firstChild);
      scrollEl = document.createElement('div');
      scrollEl.className = 'sc-caption-scroll';
      box.appendChild(scrollEl);
    }
    if (el.parentNode !== p) p.appendChild(el);
    boost.overlay = el;
    boost.bar = bar;
    boost.box = box;
    boost.scrollEl = scrollEl;
    applyBoostStyle();
    return el;
  }

  function hideBoost(on) {
    var p = player();
    if (p) {
      if (on) p.classList.add('sc-boost-on');
      else p.classList.remove('sc-boost-on');
    }
    if (boost.overlay) {
      if (on) boost.overlay.classList.add('sc-on');
      else {
        boost.overlay.classList.remove('sc-on');
        if (boost.scrollEl) {
          boost.scrollEl.textContent = '';
          boost.scrollEl.style.transform = '';
        }
        if (boost.box) {
          boost.box.style.height = '';
          boost.box.style.fontSize = ''; // het font krimpt nooit
        }
        boost.cueSpans = null;
        boost.lines = null;
        boost.windowOffset = -1;
        boost.pendingLines = false;
        boost.cueKey = null;
        boost.cueShown = -1;
      }
    }
  }

  function stopBoost() {
    boost.rafActive = false;
    if (boost.rafHandle) {
      try { cancelAnimationFrame(boost.rafHandle); } catch (e) { /* ignore */ }
      boost.rafHandle = null;
    }
    boost.shownOnce = false;
    hideBoost(false);
  }

  /* ------------------------------------------------ *
   * Venster met max. BOOST_LINES regels (optie
   * "Ondertitelregels"): de tekst schuift regel voor
   * regel omhoog zoals YouTube's eigen ondertitels —
   * het font krimpt nooit
   * ------------------------------------------------ */

  /**
   * Meet de regelindeling van de volledige cue (alle woorden staan al
   * verborgen in de DOM; `visibility:hidden` heeft gewoon layout) en stel het
   * venster in: de box toont maximaal BOOST_LINES regels (overflow:hidden).
   * Langere cues schuiven tijdens het uitspreken regel voor regel omhoog
   * i.p.v. dat het font krimpt (user-feedback 2026-09-12: "als een zin te
   * lang is, wordt gewoon een nieuwe regel eronder gezet en verder gegaan
   * woord voor woord" — zoals YouTube's auto-generated ondertitels).
   *
   * Regeltops worden met een tolerantie gegroepeerd, zodat
   * afrondingsverschillen tussen spans nooit een spookregel opleveren; de
   * vensterhoogte is evenredig (natH x zichtbare regels / totaal + padding),
   * zodat het venster altijd precies min(total, BOOST_LINES) regels toont.
   */
  function measureBoostWindow() {
    var box = boost.box;
    var wrap = boost.scrollEl;
    if (!box || !wrap || !boost.cueSpans || !boost.cueSpans.length) return;
    wrap.style.transform = '';
    var wrapTop = wrap.getBoundingClientRect().top;
    var LINE_TOL = 4; // px: alles binnen deze marge is dezelfde visuele regel
    var tops = [];    // unieke regeltops (px t.o.v. de wrapper), gesorteerd
    var spanLine = [];
    for (var i = 0; i < boost.cueSpans.length; i++) {
      var rects = boost.cueSpans[i].el.getClientRects();
      var last = spanLine.length ? spanLine[spanLine.length - 1] : 0;
      for (var r = 0; r < rects.length; r++) {
        if (rects[r].width <= 0) continue; // lege fragmenten (spaties) overslaan
        var top = rects[r].top - wrapTop;
        var idx = -1;
        for (var t = 0; t < tops.length; t++) {
          if (Math.abs(tops[t] - top) <= LINE_TOL) { idx = t; break; }
        }
        if (idx === -1) {
          tops.push(top);
          tops.sort(function (a, b) { return a - b; });
          for (var ti = 0; ti < tops.length; ti++) { if (tops[ti] === top) { idx = ti; break; } }
        }
        last = idx;
      }
      spanLine.push(last);
    }
    var total = tops.length;
    if (!total) return;
    var natH = wrap.offsetHeight;
    var padY = 0;
    try {
      var cs = getComputedStyle(box);
      padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    } catch (e) { /* ignore */ }
    var shown = Math.min(total, BOOST_LINES);
    box.style.height = Math.max(1, Math.round(natH * shown / total + padY)) + 'px';
    boost.lines = { total: total, natH: natH, lineH: natH / total, tops: tops, spanLine: spanLine };
    boost.windowOffset = -1;
  }

  /**
   * Schuif het venster naar de regel van de laatste zichtbare span. Bij
   * BOOST_LINES = 2 begint dat zodra het eerste woord van regel 3 in beeld
   * komt: regel 1 verdwijnt dan boven uit het venster en de nieuwe regel
   * komt eronder ("de 1e regel schuift 1 naar boven"), zodat er altijd twee
   * gevulde regels zichtbaar zijn. De verschuiving komt uit de gemeten top
   * van de doellijn en is geclamped op het einde van de tekst.
   */
  function applyBoostWindow(count) {
    var info = boost.lines;
    if (!info || !boost.scrollEl || count <= 0) return;
    var n = Math.min(count, info.spanLine.length);
    var line = info.spanLine[n - 1];
    if (typeof line !== 'number' || line < 0) return;
    var k = line - (BOOST_LINES - 1);
    if (k < 0) k = 0;
    var maxK = info.total > BOOST_LINES ? info.total - BOOST_LINES : 0;
    if (k > maxK) k = maxK;
    var off = info.tops && info.tops.length > k ? info.tops[k] - info.tops[0] : k * info.lineH;
    off = Math.max(0, Math.round(off || 0));
    if (off === boost.windowOffset) return;
    boost.windowOffset = off;
    boost.scrollEl.style.transform = off ? 'translateY(' + (-off) + 'px)' : '';
  }

  /**
   * Witruimte voor de weergave normaliseren: YouTube's eigen \n en dubbele
   * spaties worden één spatie. Anders komt zo'n harde regelovergang bovenop
   * onze eigen afbreking en wordt de cue alsnog 3+ regels i.p.v. de gekozen
   * 1 of 2 (bug 2026-09-12). Dubbele spaties op chunk-grenzen worden gemerged.
   */
  function normChunkText(s, prevParts) {
    var txt = String(s == null ? '' : s).replace(/\s+/g, ' ');
    var prev = prevParts && prevParts.length ? prevParts[prevParts.length - 1].text : '';
    if (txt.charAt(0) === ' ' && prev.charAt(prev.length - 1) === ' ') txt = txt.slice(1);
    return txt;
  }

  /**
   * Bouw de caption voor één cue. Alle woorden staan er in één keer in (met
   * hun vaste plek), maar zijn verborgen tot hun tijd; per frame toggelen we
   * alleen de visibility. Daardoor verspringt de tekst nooit: woord 1 blijft
   * links staan en de rest schuift niet op. De regelafbreking (door de
   * browser, op de volle balkbreedte) wordt één keer berekend;
   * `measureBoostWindow()` meet daarna hoeveel regels het zijn en hoe ver het
   * venster (max. BOOST_LINES regels) moet meeschuiven.
   */
  function buildCue(ev) {
    var box = boost.box;
    var wrap = boost.scrollEl;
    if (!box || !wrap) return;
    wrap.textContent = '';
    wrap.style.transform = '';
    box.style.height = '';
    box.style.fontSize = ''; // nooit krimpen: altijd de ingestelde grootte
    box.style.maxWidth = ''; // oude fit-breedte (vorige versie) niet overnemen
    boost.cueSpans = [];
    boost.lines = null;
    boost.windowOffset = -1;
    boost.pendingLines = true;
    var parts = [];
    var prev = 0;
    if (ev.bounds && ev.bounds.length) {
      for (var i = 0; i < ev.bounds.length; i++) {
        var end = Math.min(ev.bounds[i].end, ev.raw.length);
        var chunk = normChunkText(ev.raw.slice(prev, end), parts);
        prev = end;
        if (!chunk) continue;
        parts.push({ text: chunk, t: ev.bounds[i].t });
      }
      if (prev < ev.raw.length) {
        var tail = ev.bounds[ev.bounds.length - 1];
        var rest = normChunkText(ev.raw.slice(prev), parts);
        if (rest) parts.push({ text: rest, t: tail ? tail.t : ev.start });
      }
    } else {
      var all = normChunkText(ev.raw, null);
      if (all) parts.push({ text: all, t: ev.start });
    }
    for (var s = 0; s < parts.length; s++) {
      var el = document.createElement('span');
      el.className = 'sc-word';
      el.textContent = parts[s].text;
      el.style.visibility = 'hidden';
      wrap.appendChild(el);
      boost.cueSpans.push({ el: el, t: parts[s].t });
    }
    boost.cueShown = 0;
    // Is de overlay al zichtbaar (opeenvolgende cue), meet dan direct — anders
    // gebeurt dat zodra het eerste woord in beeld komt (zie renderBoost).
    if (boost.overlay && boost.overlay.classList.contains('sc-on')) {
      measureBoostWindow();
      boost.pendingLines = false;
    }
  }

  function renderBoost() {
    if (!boost.rafActive) return;
    var p = player();
    var cur = readCurrentTrack();
    if (!CAPTION_BOOST_ENABLED || !p || !cur || !boostSupported(cur) || isAd() || !boost.events) {
      stopBoost();
      return;
    }
    boost.frame++;
    if (boost.frame % 30 === 0) {
      var idNow = currentVideoId();
      if (idNow && boost.videoId && idNow !== boost.videoId) {
        boost.events = null;
        stopBoost();
        return;
      }
      applyBoostStyle(); // spelerformaat kan veranderd zijn (fullscreen/theater)
    }

    var t = safe(function () { return p.getCurrentTime(); }, 0);
    var idx = L.captionEventIndex(boost.events, t);
    var ev = idx >= 0 ? boost.events[idx] : null;
    var next = idx >= 0 ? boost.events[idx + 1] : null;

    // Niets te tonen: vóór de eerste cue, of ruim na de laatste cue.
    if (!ev || (!next && t > ev.start + ev.dur + 5)) {
      if (boost.shownOnce) {
        boost.shownOnce = false;
        hideBoost(false);
      }
      boost.rafHandle = requestAnimationFrame(renderBoost);
      return;
    }

    if (boost.cueKey !== ev.start || !boost.cueSpans) {
      buildCue(ev);
      boost.cueKey = ev.start;
    }

    var count = L.captionRevealCount(ev, t);
    if (count !== boost.cueShown) {
      boost.cueShown = count;
      for (var i = 0; i < boost.cueSpans.length; i++) {
        var want = i < count ? '' : 'hidden';
        if (boost.cueSpans[i].el.style.visibility !== want) boost.cueSpans[i].el.style.visibility = want;
      }
    }
    if (count > 0 && !boost.shownOnce) {
      boost.shownOnce = true;
      hideBoost(true);
    }
    // Venster meten zodra de overlay zichtbaar is (daarvóór is er geen
    // layout) en de tekst daarna met de uitgesproken regel mee laten
    // schuiven: max. BOOST_LINES regels zichtbaar (zoals YouTube's eigen
    // ondertitels), het font krimpt nooit.
    if (boost.pendingLines && count > 0 && boost.overlay &&
        boost.overlay.classList.contains('sc-on')) {
      measureBoostWindow();
      boost.pendingLines = false;
    }
    if (boost.lines) applyBoostWindow(count);
    boost.rafHandle = requestAnimationFrame(renderBoost);
  }

  function boostTick() {
    if (!CAPTION_BOOST_ENABLED || SUBTITLES_OFF) { if (boost.rafActive) stopBoost(); return; }
    var cur = readCurrentTrack();
    if (!cur || !boostSupported(cur) || isAd()) { if (boost.rafActive) stopBoost(); return; }
    var id = currentVideoId();
    if (!id) { if (boost.rafActive) stopBoost(); return; }
    var key = boostKey(id, L.baseLang(cur.languageCode), cur.kind === 'asr' ? 'asr' : '');
    if (boost.videoId !== id || boost.trackKey !== key) {
      boost.events = null;
      stopBoost();
      boost.videoId = id;
      boost.trackKey = key;
    }
    if (!boost.events) {
      var rec = boostTracks[key];
      if (rec) boost.events = rec.events;
    }
    if (boost.events) {
      refreshBoostStyle(false);
      ensureBoostDom();
      if (!boost.rafActive) {
        boost.rafActive = true;
        boost.frame = 0;
        boost.rafHandle = requestAnimationFrame(renderBoost);
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Per-tab kill switch: een knop in de controlbar (links van de ondertitel-
   * knop, in de groep van het tandwiel) waarmee je de ondertiteling van dít
   * tabblad volledig uitzet: captions uit, Caption Boost uit en de content
   * script stuurt niets meer naar de bridge. Nog een klik (of de hotkey)
   * zet hem weer aan.
   * ------------------------------------------------------------------ */
  var PLAYER_BUTTON_ID = 'sc-cc-toggle';

  function turnSubtitlesOff() {
    var p = player();
    try { if (p && p.setOption) p.setOption('captions', 'track', {}); } catch (e) { /* ignore */ }
    stopBoost();
  }

  function setSubtitlesOff(off, source) {
    SUBTITLES_OFF = !!off;
    if (SUBTITLES_OFF) turnSubtitlesOff();
    updatePlayerButton();
    if (source === 'button') post({ type: 'subtitlesOffChanged', off: SUBTITLES_OFF, videoId: currentVideoId() });
    return { subtitlesOff: SUBTITLES_OFF };
  }

  function ensureButtonStyle() {
    if (document.getElementById('sc-cc-toggle-style')) return;
    try {
      var st = document.createElement('style');
      st.id = 'sc-cc-toggle-style';
      st.textContent =
        '#' + PLAYER_BUTTON_ID + ' .sc-cc-slash{display:none}' +
        '#' + PLAYER_BUTTON_ID + '.sc-off .sc-cc-slash{display:block}' +
        '#' + PLAYER_BUTTON_ID + '.sc-off svg{opacity:.55}';
      (document.head || document.documentElement).appendChild(st);
    } catch (e) { /* ignore */ }
  }

  function updatePlayerButton(btn) {
    btn = btn || document.getElementById(PLAYER_BUTTON_ID);
    if (!btn) return;
    var off = SUBTITLES_OFF;
    if (btn.classList.contains('sc-off') !== off) btn.classList.toggle('sc-off', off);
    var title = off
      ? 'Ondertiteling weer aanzetten voor dit tabblad (Subtitle Corrector)'
      : 'Ondertiteling uitzetten voor dit tabblad (Subtitle Corrector)';
    if (btn.getAttribute('title') !== title) {
      btn.setAttribute('title', title);
      btn.setAttribute('aria-label', title);
      btn.setAttribute('aria-pressed', off ? 'true' : 'false');
    }
  }

  /**
   * SVG-icon van de knop. Bewust opgebouwd met DOM-API's en niet met
   * innerHTML: YouTube handhaaft Trusted Types in de pagina, dus een
   * innerHTML-assignment wordt daar geblokkeerd (geverifieerd 2026-09-12).
   */
  function buildButtonIcon(btn) {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('height', '100%');
    svg.setAttribute('width', '100%');
    svg.setAttribute('viewBox', '0 0 36 36');
    var rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('x', '7');
    rect.setAttribute('y', '9.5');
    rect.setAttribute('width', '22');
    rect.setAttribute('height', '17');
    rect.setAttribute('rx', '3');
    rect.setAttribute('fill', 'none');
    rect.setAttribute('stroke', 'currentColor');
    rect.setAttribute('stroke-width', '2');
    svg.appendChild(rect);
    var text = document.createElementNS(NS, 'text');
    text.setAttribute('x', '18');
    text.setAttribute('y', '23');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('font-size', '10.5');
    text.setAttribute('font-weight', '700');
    text.setAttribute('fill', 'currentColor');
    text.setAttribute('font-family', 'Roboto,Arial,sans-serif');
    text.textContent = 'CC';
    svg.appendChild(text);
    var slash = document.createElementNS(NS, 'line');
    slash.setAttribute('class', 'sc-cc-slash');
    slash.setAttribute('x1', '9.5');
    slash.setAttribute('y1', '27');
    slash.setAttribute('x2', '26.5');
    slash.setAttribute('y2', '9');
    slash.setAttribute('stroke', '#ff5a5a');
    slash.setAttribute('stroke-width', '2.6');
    slash.setAttribute('stroke-linecap', 'round');
    svg.appendChild(slash);
    btn.appendChild(svg);
  }

  function ensurePlayerButton() {
    var rc = document.querySelector('.ytp-right-controls');
    if (!rc) return;
    var btn = document.getElementById(PLAYER_BUTTON_ID);
    if (!btn) {
      ensureButtonStyle();
      btn = document.createElement('button');
      btn.id = PLAYER_BUTTON_ID;
      btn.className = 'ytp-button';
      buildButtonIcon(btn);
      btn.addEventListener('click', function (ev) {
        try { ev.preventDefault(); ev.stopPropagation(); } catch (e) { /* ignore */ }
        setSubtitlesOff(!SUBTITLES_OFF, 'button');
      }, true);
    }
    if (!rc.contains(btn)) {
      // Zo dicht mogelijk links van het tandwiel (\"links naast het settings
      // icoontje\"); staat er in de rechtergroep een '<'-knop (playlist /
      // nieuwe UI), dan komt hij direct links daarvan te staan. De
      // ondertitelknop (CC) is de terugvaloptie.
      var anchors = ['.ytp-prev-button', '.ytp-settings-button', '.ytp-subtitles-button'];
      var target = null;
      for (var i = 0; i < anchors.length; i++) {
        var cand = rc.querySelector(anchors[i]);
        if (!cand) continue;
        if (cand.offsetParent === null) { if (!target) target = cand; continue; }
        target = cand;
        break;
      }
      if (target && target.parentNode) target.parentNode.insertBefore(btn, target);
      else {
        var left = rc.querySelector('.ytp-right-controls-left') || rc;
        left.insertBefore(btn, left.firstChild);
      }
    }
    updatePlayerButton(btn);
  }

  function setPageOptions(opts) {
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'captionBoost')) {
      CAPTION_BOOST_ENABLED = !!opts.captionBoost;
      if (!CAPTION_BOOST_ENABLED) stopBoost();
      dbg('captionBoost', CAPTION_BOOST_ENABLED);
    }
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'captionSize')) {
      var pct = Number(opts.captionSize);
      if (isFinite(pct)) BOOST_SIZE_PCT = Math.max(50, Math.min(250, pct));
      applyBoostStyle();
    }
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'captionLines')) {
      var lines = Number(opts.captionLines) === 1 ? 1 : 2;
      if (lines !== BOOST_LINES) { BOOST_LINES = lines; boost.cueKey = null; }
      dbg('captionLines', BOOST_LINES);
    }
    return { captionBoost: CAPTION_BOOST_ENABLED, captionSize: BOOST_SIZE_PCT, captionLines: BOOST_LINES, subtitlesOff: SUBTITLES_OFF };
  }

  installTimedtextHooks();

  /* ------------------------------------------------------------------ *
   * Events naar de content script
   * ------------------------------------------------------------------ */
  var lastVideoId = null;
  var lastAd = null;
  var lastState = null;
  var lastCaptionKey = null;

  function captionKey(cur) {
    if (!cur) return 'off';
    return cur.languageCode + '|' + cur.kind + '|' + (cur.translated ? 'tr:' + cur.translatedTo : 'orig');
  }

  function tick() {
    var p = player();
    if (!p) return;

    var id = currentVideoId();
    if (id && id !== lastVideoId) {
      lastVideoId = id;
      dbg('videoChanged', id);
      post({ type: 'videoChanged', videoId: id, title: safe(function () { return p.getVideoData().title; }, null) });
    }

    var ad = isAd();
    if (ad !== lastAd) {
      lastAd = ad;
      post({ type: 'adChanged', adShowing: ad, videoId: lastVideoId });
    }

    var ps = safe(function () { return p.getPlayerState(); }, -1);
    if (ps !== lastState) {
      lastState = ps;
      post({ type: 'playerState', state: ps, videoId: lastVideoId });
    }

    var cur = readCurrentTrack();
    var key = captionKey(cur);
    if (key !== lastCaptionKey) {
      lastCaptionKey = key;
      post({
        type: 'captionChanged',
        videoId: lastVideoId,
        current: cur,
        captionsOn: !!cur,
        translated: !!(cur && cur.translated)
      });
    }

    // Caption Boost: eigen weergave aan/uitzetten zodra de juiste track actief is.
    boostTick();

    // Kill switch-knop: aanwezig houden in de controlbar en de ondertitels van
    // dit tabblad uit laten blijven, ook als YouTube ze opnieuw aanzet.
    ensurePlayerButton();
    if (SUBTITLES_OFF && cur) turnSubtitlesOff();
  }

  // Poll-ritme: snel als het tabblad zichtbaar is, langzaam op de achtergrond
  // (playlists spelen vaak in een niet-actief tabblad; dan is rust belangrijker).
  var TICK_MS = 900;
  var TICK_HIDDEN_MS = 2600;
  function tickDelay() {
    return document.hidden ? TICK_HIDDEN_MS : TICK_MS;
  }
  function loop() {
    try { tick(); } catch (e) { /* ignore */ }
    setTimeout(loop, tickDelay());
  }
  loop();
  dbg('page agent geladen');
})();
