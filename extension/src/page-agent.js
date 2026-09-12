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
   * Caption Boost: eigen ondertitelweergave
   *
   * YouTube's eigen caption-venster loopt in playlists soms 1-2 s achter en
   * toont dan losse zinsdelen in blokken. De speler haalt de track zelf op
   * via XHR (json3, met `tOffsetMs` per woord bij ASR); die respons vangen
   * we passief op. Twee weergaven (optie "Word-for-Word"):
   *   - blokken (default): de cue's worden vooraf gegroepeerd in blokken van
   *     2 VOLLEDIGE zinnen (L.buildCaptionBlocks); een blok komt in één keer
   *     in beeld en blijft staan tot het volgende blok begint;
   *   - woord-voor-woord: elk woord komt op zijn eigen tijd in hetzelfde
   *     venster en het venster rolt per regel omhoog, zoals YouTube's
   *     auto-gegenereerde ondertitels.
   * YouTube's caption-venster verbergen we zolang dat lukt; lukt het niet,
   * dan blijft YouTube's eigen weergave gewoon staan.
   * ------------------------------------------------------------------ */
  var CAPTION_BOOST_ENABLED = true;
  var BOOST_WORD_BY_WORD = false;   // optie "Word-for-Word" (default uit = hele blokken)
  var BOOST_MAX_TRACKS = 2;
  var BOOST_BLOCK_SENTENCES = 2;    // zinnen per blok (user-keuze: 2 volle zinnen)
  var BOOST_SILENCE_GAP = 1.6;      // s stilte die een blok/run afsluit
  var BOOST_MAX_BLOCK_CHARS = 150;  // noodrem voor tracks zonder punctuatie
  var BOOST_LINGER = 0.45;          // s dat een blok/run na zijn laatste woord blijft staan
  var BOOST_WORD_LEAD = 0.05;       // s dat een woord vóór zijn gemeten tijd al in beeld komt

  var boost = {
    videoId: null,
    trackKey: null,
    blocks: null,         // blokken van 2 volle zinnen (blokweergave)
    runs: null,           // runs van doorlopende spraak (woord-voor-woord)
    shownOnce: false,
    frame: 0,
    rafActive: false,
    rafHandle: null,
    overlay: null,
    bar: null,
    box: null,
    scrollEl: null,
    blockKey: null,       // starttijd van het blok dat nu in de DOM staat
    runKey: null,         // starttijd van de run die nu in de DOM staat
    wordCount: 0,         // aantal woorden van die run dat al in de DOM staat
    windowShift: -1,      // laatst gezette venster-verschuiving in px (-1 = opnieuw meten)
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
      var blocks = L.buildCaptionBlocks(events, {
        sentences: BOOST_BLOCK_SENTENCES,
        silenceGap: BOOST_SILENCE_GAP,
        maxChars: BOOST_MAX_BLOCK_CHARS
      });
      if (!blocks.length) return;
      // Woord-voor-woord (optie): dezelfde events, maar als losse woorden en
      // in runs van doorlopende spraak — een stilte begint een nieuw venster.
      var runs = L.buildCaptionRuns(L.buildCaptionWords(events), BOOST_SILENCE_GAP);
      var key = boostKey(v, L.baseLang(lang), urlParam(url, 'kind') || '');
      if (!boostTracks[key]) boostTrackOrder.push(key);
      boostTracks[key] = { at: Date.now(), events: events, blocks: blocks, runs: runs };
      while (boostTrackOrder.length > BOOST_MAX_TRACKS) {
        var old = boostTrackOrder.shift();
        if (old !== key) delete boostTracks[old];
      }
      dbg('timedtext opgevangen', key, events.length + ' events / ' + blocks.length + ' blokken / ' + runs.length + ' runs');
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
    invalidateBoostText(); // stijl/grootte gewijzigd -> tekst opnieuw opbouwen
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
          // De box is precies zo breed als de balk (border-box) en heeft een
          // VASTE hoogte van BOOST_LINES regels (inline, in em); de tekst
          // begint linksboven, links uitgelijnd. In de blokweergave staat het
          // hele blok er in één keer in (wat niet past wordt afgekapt); in de
          // woord-voor-woord-weergave wordt elk woord op zijn tijd toegevoegd
          // en schuift `.sc-caption-scroll` per regel omhoog (transition) zodat
          // altijd de laatste regels zichtbaar zijn.
          '#sc-caption-overlay .sc-caption-bar{position:absolute;top:0;bottom:0}' +
          '#sc-caption-overlay .sc-caption-box{position:relative;display:inline-block;overflow:hidden;box-sizing:border-box;width:' +
          (Math.round(BOOST_BAR_WIDTH * 1000) / 10) + '%;text-align:left;white-space:pre-wrap;' +
          'padding:.06em .32em;text-shadow:0 0 2px rgba(0,0,0,.8)}' +
          '#sc-caption-overlay .sc-caption-scroll{position:relative;transition:transform .16s ease-out}';
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
        if (boost.box) {
          boost.box.style.height = '';
          boost.box.style.fontSize = ''; // het font krimpt nooit
        }
        invalidateBoostText();
      }
    }
  }

  /**
   * Alles wat in de DOM staat ongeldig maken (stijl-, grootte- of moduswissel,
   * video-/trackwissel, overlay uit): de volgende frame bouwt de tekst opnieuw
   * op. In de woord-voor-woord-weergave begint het venster dan weer bovenaan.
   */
  function invalidateBoostText() {
    boost.blockKey = null;
    boost.runKey = null;
    boost.wordCount = 0;
    boost.windowShift = -1;
    if (boost.scrollEl) {
      boost.scrollEl.textContent = '';
      boost.scrollEl.style.transform = '';
    }
  }

  /** Overlay uit als er iets in stond (stilte, video-einde, wissel). */
  function hideOnce() {
    if (!boost.shownOnce) return;
    boost.shownOnce = false;
    hideBoost(false);
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
   * Twee weergaven, één venster (optie "Word-for-Word")
   *
   * A. Blokken (default): een blok van 2 volle zinnen staat er in één keer
   *    in en blijft staan tot het volgende blok begint; wat niet past wordt
   *    onderaan afgekapt. Het font krimpt nooit en er schuift niets.
   * B. Woord-voor-woord (optie, zoals YouTube's auto-ondertitels): elk woord
   *    komt op zijn eigen tijd in hetzelfde vaste venster; zodra de onderste
   *    regel vol is schuift het venster één regel omhoog (regel 1 verdwijnt,
   *    regel 2 wordt regel 1, de nieuwe woorden gaan verder op regel 2).
   *
   * Allebei gebruiken ze dezelfde box met een VASTE hoogte van BOOST_LINES
   * regels; het font krimpt nooit.
   * ------------------------------------------------ */

  /**
   * Zet één blok in de overlay: alle tekst in één keer, linksboven
   * uitgelijnd, in een vast venster van BOOST_LINES regels. De hoogte staat
   * in em (relatief aan de overlay-fontgrootte), dus een andere
   * ondertitelgrootte volgt automatisch; `L.captionBoxHeightEm()` houdt
   * dezelfde verhouding aan als de CSS (line-height + padding).
   */
  function buildBlock(blk) {
    var box = boost.box;
    var wrap = boost.scrollEl;
    if (!box || !wrap) return;
    wrap.textContent = blk.text;
    wrap.style.transform = '';
    box.style.fontSize = '';
    box.style.maxWidth = '';
    box.style.height = L.captionBoxHeightEm(BOOST_LINES) + 'em';
  }

  /**
   * Eén frame van de blokweergave: welk blok hoort bij `t`? Het hele blok
   * staat in één keer in beeld (geen woord-voor-woord). Tijdens een stilte —
   * of na het laatste blok + BOOST_LINGER — gaat de overlay uit en komt
   * YouTube's eigen venster terug.
   */
  function renderBlockFrame(t) {
    var idx = L.captionBlockAt(boost.blocks, t, BOOST_LINGER);
    if (idx < 0) {
      hideOnce();
      return;
    }
    var blk = boost.blocks[idx];
    if (boost.blockKey !== blk.start) {
      buildBlock(blk);
      boost.blockKey = blk.start;
    }
    if (!boost.shownOnce) {
      boost.shownOnce = true;
      hideBoost(true);
    }
  }

  /**
   * Hoogte van één regel (px) in het captionvenster. De CSS zet
   * `line-height:1.4`; `getComputedStyle` geeft die (via de overlay
   * overgeërfd) als px terug. Komt er geen bruikbare waarde uit, dan rekenen
   * we met dezelfde verhouding als de CSS.
   */
  function boostLineHeightPx() {
    var px = 0;
    try { px = parseFloat(getComputedStyle(boost.scrollEl).lineHeight); } catch (e) { px = 0; }
    if (!isFinite(px) || px <= 0) {
      var fs = parseFloat((boost.overlay && boost.overlay.style.fontSize) || '') || 0;
      px = fs * 1.4;
    }
    return isFinite(px) && px > 0 ? px : 0;
  }

  /**
   * Het rollende venster bijwerken: zolang de gezette tekst binnen BOOST_LINES
   * regels past gebeurt er niets; daarboven schuift de tekst per HELE regel
   * omhoog zodat altijd de laatste regels zichtbaar zijn. De box zelf blijft
   * even hoog (het font krimpt nooit).
   */
  function updateWordWindow() {
    var wrap = boost.scrollEl;
    if (!wrap) return;
    var h = 0;
    try { h = wrap.getBoundingClientRect().height; } catch (e) { h = 0; }
    var shift = L.captionWindowShift(h, boostLineHeightPx(), BOOST_LINES);
    if (shift === boost.windowShift) return;
    boost.windowShift = shift;
    wrap.style.transform = shift ? 'translateY(' + (-shift) + 'px)' : '';
  }

  /**
   * Eén frame van de woord-voor-woord-weergave: de woorden van de actieve run
   * komen één voor één in de DOM (op hun eigen tijd) en het venster rolt per
   * regel mee. Een stilte begint een nieuwe run (venster leeg); een sprong in
   * de video (terugspoelen) bouwt het venster opnieuw op.
   */
  function renderWordFrame(t) {
    if (!boost.runs) { renderBlockFrame(t); return; }
    var idx = L.captionRunAt(boost.runs, t, BOOST_LINGER);
    if (idx < 0) {
      hideOnce();
      return;
    }
    var run = boost.runs[idx];
    var wrap = boost.scrollEl;
    var box = boost.box;
    if (!wrap || !box) return;
    var n = L.captionWordIndex(run.words, t, BOOST_WORD_LEAD);
    if (boost.runKey !== run.start || n < boost.wordCount) invalidateBoostText();
    boost.runKey = run.start;
    box.style.height = L.captionBoxHeightEm(BOOST_LINES) + 'em';
    var grew = false;
    while (boost.wordCount < n && boost.wordCount < run.words.length) {
      // Elk woord is een eigen tekstknoop: hij komt er op zijn tijd bij, de
      // rest van de regelafbreking blijft daardoor staan (greedy wrap).
      wrap.appendChild(document.createTextNode(run.words[boost.wordCount].text + ' '));
      boost.wordCount++;
      grew = true;
    }
    if (grew || boost.windowShift < 0) updateWordWindow();
    if (!boost.shownOnce) {
      boost.shownOnce = true;
      hideBoost(true);
    }
  }

  /**
   * Eén frame: kies de weergave (blokken of woord voor woord) en teken de
   * tekst die bij de huidige speeltijd hoort.
   */
  function renderBoost() {
    if (!boost.rafActive) return;
    var p = player();
    var cur = readCurrentTrack();
    if (!CAPTION_BOOST_ENABLED || !p || !cur || !boostSupported(cur) || isAd() || !boost.blocks) {
      stopBoost();
      return;
    }
    boost.frame++;
    if (boost.frame % 30 === 0) {
      var idNow = currentVideoId();
      if (idNow && boost.videoId && idNow !== boost.videoId) {
        boost.blocks = null;
        boost.runs = null;
        stopBoost();
        return;
      }
      applyBoostStyle(); // spelerformaat kan veranderd zijn (fullscreen/theater)
    }

    var t = safe(function () { return p.getCurrentTime(); }, 0);
    if (BOOST_WORD_BY_WORD) renderWordFrame(t);
    else renderBlockFrame(t);
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
      boost.blocks = null;
      boost.runs = null;
      stopBoost();
      boost.videoId = id;
      boost.trackKey = key;
    }
    if (!boost.blocks) {
      var rec = boostTracks[key];
      if (rec) {
        boost.blocks = rec.blocks;
        // Woord-voor-woord: de runs komen uit dezelfde opgevangen track.
        boost.runs = rec.runs || L.buildCaptionRuns(L.buildCaptionWords(rec.events || []), BOOST_SILENCE_GAP);
      }
    }
    if (boost.blocks) {
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
      if (lines !== BOOST_LINES) { BOOST_LINES = lines; invalidateBoostText(); }
      dbg('captionLines', BOOST_LINES);
    }
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'captionWordByWord')) {
      var wbw = !!opts.captionWordByWord;
      if (wbw !== BOOST_WORD_BY_WORD) {
        BOOST_WORD_BY_WORD = wbw;
        invalidateBoostText(); // andere weergave -> tekst opnieuw opbouwen
      }
      dbg('captionWordByWord', BOOST_WORD_BY_WORD);
    }
    return {
      captionBoost: CAPTION_BOOST_ENABLED,
      captionSize: BOOST_SIZE_PCT,
      captionLines: BOOST_LINES,
      captionWordByWord: BOOST_WORD_BY_WORD,
      subtitlesOff: SUBTITLES_OFF
    };
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
