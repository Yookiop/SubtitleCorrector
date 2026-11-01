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
   * Diagnose (waarom loopt de ondertiteling achter?)
   *
   * De klacht "de ondertiteling loopt achter" heeft maar twee mogelijke
   * oorzaken: wij tekenen niet (dan zie je YouTube's eigen, in playlists
   * 1-2 s achterlopende venster) of onze frame-lus staat stil. Allebei is
   * van buitenaf onzichtbaar, dus houdt de page agent hier de feiten bij:
   * binnenkomende timedtext-verzoeken (en waarom er één genegeerd werd),
   * waarom de eigen weergave startte of stopte, en hoe groot de gaten
   * tussen twee frames waren. Uitlezen met `__scDiag()` in de console
   * (MAIN world) - hetzelfde object gaat mee in de popup (Diagnose).
   * ------------------------------------------------------------------ */
  var diag = {
    bootAt: Date.now(),
    videoId: null,
    timedtext: { requests: 0, stored: 0, ignored: Object.create(null) },
    lastTrack: null,
    boost: { starts: 0, stops: 0, active: false, since: 0, lastStop: null, stops: Object.create(null) },
    frames: { count: 0, maxGapMs: 0, slowFrames: 0, lastGapMs: 0, lastAt: 0, hiddenFrames: 0 },
    own: { on: 0, off: 0 },
    repairs: 0,
    lastRepair: null,
    audioSwitches: 0,
    lastAudioSwitch: null,
    apply: { count: 0, last: null }
  };

  function diagIgnore(reason) {
    var d = diag.timedtext.ignored;
    d[reason] = (d[reason] || 0) + 1;
  }

  /**
   * De laatste toepassing bewaren (popup -> Diagnose): welke methode, welke
   * pogingen, wat de speler daarvoor en daarna zei en of de weergave aan stond.
   * Nodig om "hij meldt succes maar ik zie niets" objectief te kunnen lezen.
   */
  function diagApply(res) {
    if (!res) return;
    var track = function (t) { return t ? t.languageCode + '/' + (t.kind || '') : null; };
    diag.apply.count++;
    diag.apply.last = {
      at: new Date().toISOString(),
      ok: !!res.ok,
      reason: res.reason || null,
      method: res.method || null,
      attempts: res.attempts || null,
      before: track(res.before),
      after: track(res.after),
      target: track(res.target || res.expected),
      captionsOn: typeof res.captionsOn === 'boolean' ? res.captionsOn : null,
      checkedMenuItem: res.checkedMenuItem || null
    };
  }

  /**
   * Leesbare momentopname. `hidden`/`rafActive`/`ownsCaptions` vertellen
   * meteen welke van de twee oorzaken speelt; `timedtext.ignored` zegt of de
   * track überhaupt is opgevangen.
   */
  function diagSnapshot() {
    var cur = readCurrentTrack();
    var id = currentVideoId();
    var key = cur && id ? boostKey(id, L.baseLang(cur.languageCode), cur.kind === 'asr' ? 'asr' : '') : null;
    var pNow = player();
    var tNow = safe(function () { return pNow && pNow.getCurrentTime ? pNow.getCurrentTime() : null; }, null);
    return {
      at: new Date().toISOString(),
      uptimeS: Math.round((Date.now() - diag.bootAt) / 1000),
      videoId: id,
      current: cur,
      captionsOn: captionsDisplayed(),
      trackKey: key,
      trackCaptured: !!(key && boostTracks[key]),
      boostStoredKeys: Object.keys(boostTracks),
      drawing: {
        cboostOn: CAPTION_BOOST_ENABLED,
        rafActive: boost.rafActive,
        ownsCaptions: boost.ownsCaptions,
        blockKey: boost.blockKey,
        runKey: boost.runKey,
        words: boost.wordCount,
        // Wat de weergave tot zijn beschikking heeft, en of de speeltijd
        // daarbinnen valt (buiten bereik -> YouTube's venster moet terug).
        blocks: boost.blocks ? boost.blocks.length : -1,
        runs: boost.runs ? boost.runs.length : -1,
        coversTime: boostCoversTime(boost.blocks, tNow),
        blocksFrom: boost.blocks && boost.blocks.length ? boost.blocks[0].start : null,
        blocksTo: boost.blocks && boost.blocks.length ? boost.blocks[boost.blocks.length - 1].end : null,
        playerTime: tNow,
        overlayConnected: !!(boost.overlay && boost.overlay.isConnected),
        overlayVisible: boostDisplayed(),
        text: boost.box ? String(boost.box.textContent || '').slice(-140) : ''
      },
      renderLag: diagRenderLag(),
      timedtext: diag.timedtext,
      boost: diag.boost,
      frames: diag.frames,
      own: diag.own,
      repairs: diag.repairs,
      lastRepair: diag.lastRepair,
      audioSwitches: diag.audioSwitches,
      lastAudioSwitch: diag.lastAudioSwitch,
      apply: diag.apply,
      docHidden: document.hidden,
      pageVisibility: document.visibilityState
    };
  }

  /**
   * Hoeveel woorden staat de eigen weergave achter op de spelerklok?
   *
   * Dit is de enige harde maat voor "de ondertiteling loopt achter": het
   * verschil tussen de woorden die volgens de track nu gezegd zijn
   * (`captionWordIndex`) en de woorden die al in de DOM staan
   * (`boost.wordCount`). 0-1 = normaal (de reveal-pace loopt één frame
   * achter); oplopend = de frame-lus of de opbouw kan het niet bijhouden.
   * `run: -1` betekent een stilte, `-2` dat het venster nog opgebouwd wordt.
   */
  function diagRenderLag() {
    if (!boost.rafActive || !boost.runs) return null;
    var p = player();
    var t = safe(function () { return p && p.getCurrentTime ? p.getCurrentTime() : null; }, null);
    if (t === null || !isFinite(t)) return null;
    var ts = t + L.wordLeadSeconds(BOOST_SYNC_MS);
    var idx = L.captionRunAt(boost.runs, ts, BOOST_LINGER);
    if (idx < 0) return { t: t, run: -1, pending: 0, have: boost.wordCount };
    var run = boost.runs[idx];
    if (run.start !== boost.runKey) return { t: t, run: -2, pending: 0, have: boost.wordCount };
    var n = L.captionWordIndex(run.words, ts, 0);
    return { t: t, run: idx, want: n, have: boost.wordCount, pending: Math.max(0, n - boost.wordCount) };
  }

  try {
    window.__scDiag = diagSnapshot;
  } catch (e) { /* ignore */ }

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
      case 'diag': return Promise.resolve(diagSnapshot());
      case 'setOriginalAudio': return Promise.resolve(setOriginalAudio());
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

  /**
   * De wrapper van de speler (`html5-video-player`) wordt één keer opgezocht en
   * daarna hergebruikt: `isAd()` hangt in de frame-lus van Caption Boost en een
   * `querySelector` per frame is nodeloos werk. Raakt het element los (een
   * nieuwe speler), dan zoeken we hem opnieuw.
   */
  var adWrapEl = null;

  function videoWrap() {
    if (adWrapEl && adWrapEl.isConnected) return adWrapEl;
    adWrapEl = document.querySelector('.html5-video-player');
    return adWrapEl;
  }

  function isAdShowingInDom() {
    var wrap = videoWrap();
    return !!(wrap && wrap.classList && wrap.classList.contains('ad-showing'));
  }

  function isAd() {
    if (isAdShowingInDom()) return true;
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

  /** Het CC-knopje van YouTube; `aria-pressed` is de echte aan/uit-stand. */
  function ccButton() {
    return document.querySelector('.ytp-subtitles-button');
  }

  /**
   * Staat de ondertitel-weergave écht aan?
   *
   * `getOption('captions','track')` is hier niet genoeg: een gekozen track
   * betekent niet dat YouTube hem ook toont. Zet de speler een track terwijl
   * de weergave uit staat (wat `setOption` en het settings-menu doen), dan
   * blijft de track-optie gevuld en staat het CC-knopje op `aria-pressed=false`
   * — de ondertitel is dan in het menu aangevinkt maar nergens te zien
   * (bugmelding 2026-11-01). Het knopje is de bron van waarheid; zonder knop
   * valt het terug op de track-optie.
   */
  function captionsDisplayed() {
    var btn = ccButton();
    if (btn) {
      var pressed = btn.getAttribute('aria-pressed');
      if (pressed === 'true') return true;
      if (pressed === 'false') return false;
    }
    return !!readCurrentTrack();
  }

  function captionsOn() {
    return captionsDisplayed();
  }

  /**
   * Zet de caption-weergave aan of uit via het CC-knopje en controleer dat het
   * gelukt is. `apply()` en de reparatie (`reRequestCaptions`) mogen niet op de
   * track-optie alleen vertrouwen: die blijft gevuld als de weergave uit staat.
   */
  async function setCaptionsDisplayed(on, settleMs) {
    var want = !!on;
    var wait = settleMs || 600;
    for (var i = 0; i < 3; i++) {
      if (captionsDisplayed() === want) return true;
      var btn = ccButton();
      if (!btn) break;
      clickEl(btn);
      await sleep(wait);
    }
    return captionsDisplayed() === want;
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
    // Twee vormen: `s1` (oud) en `Pb` (sinds 2026: {name:"Originele Nederlands
    // (NL)", id:"nl-NL.4", isDefault, isAutoDubbed}) — dezelfde velden die we
    // nodig hebben, dus één variabele voor beide.
    var s1 = at.s1 || at.Pb || null;
    var code = s1 ? L.decodeAudioTrackLang(s1.id) : null;
    if (!code) code = L.decodeAudioTrackLang(at.id);
    if (!code && !(s1 && s1.name)) return null;
    // `isAutoDubbed` zit niet in elke vorm; de base64-blob zegt het ook
    // ("dubbed-auto" vs "original") — zie L.decodeAudioTrackDubbed().
    var dubbed = s1 && typeof s1.isAutoDubbed === 'boolean' ? s1.isAutoDubbed : null;
    if (dubbed === null) dubbed = L.decodeAudioTrackDubbed((s1 && s1.id) || at.id);
    return {
      languageCode: code,
      id: (s1 && s1.id) || at.id || null,
      name: (s1 && s1.name) || null,
      isAutoDubbed: !!dubbed
    };
  }

  /** Alle beschikbare audiotracks (origineel + auto-dubs), met hun vlaggen. */
  function readAudioTracks() {
    var p = player();
    var list = safe(function () { return p && p.getAvailableAudioTracks ? p.getAvailableAudioTracks() : []; }, []) || [];
    return list.map(function (t) {
      var s = (t && (t.s1 || t.Pb)) || null;
      var raw = (s && s.id) || (t && t.id) || null;
      var dubbed = s && typeof s.isAutoDubbed === 'boolean' ? s.isAutoDubbed : L.decodeAudioTrackDubbed(raw);
      return {
        id: raw,
        name: (s && s.name) || null,
        languageCode: L.decodeAudioTrackLang(raw),
        isAutoDubbed: !!dubbed,
        isDefault: !!(s && s.isDefault),
        track: t
      };
    }).filter(function (t) { return !!t.id; });
  }

  /**
   * Auto-dub uitzetten: terug naar de originele audiotrack.
   *
   * YouTube kiest op een niet-Engelse UI soms automatisch een nagesynchroniseerde
   * track (bv. Nederlands op een Engelse video). Dat verandert de audiotaal — en
   * dus de taal van de ondertitels die de gebruiker verwacht. `setAudioTrack()`
   * werkt alleen met het **volledige** trackobject uit `getAvailableAudioTracks()`
   * (met `{id}` of een string gooit de speler; live geverifieerd 2026-10-31).
   */
  function setOriginalAudio() {
    var p = player();
    if (!p || !p.setAudioTrack || !p.getAvailableAudioTracks) return { ok: false, reason: 'no-api' };
    var cur = safe(function () { return p.getAudioTrack(); }, null);
    var curS = cur && (cur.s1 || cur.Pb) || null;
    var curId = (curS && curS.id) || (cur && cur.id) || null;
    var curDub = curS && typeof curS.isAutoDubbed === 'boolean' ? curS.isAutoDubbed : L.decodeAudioTrackDubbed(curId);
    if (!curDub) return { ok: true, changed: false, reason: 'not-dubbed', current: curId };
    var list = readAudioTracks().filter(function (t) { return !t.isAutoDubbed; });
    if (!list.length) return { ok: false, reason: 'no-original-track', current: curId };
    // Voorkeur: origineel in een ondersteunde taal (EN/NL), dan een standaardtack.
    var pick = list.filter(function (t) { return L.isSupported(t.languageCode); })[0] ||
               list.filter(function (t) { return t.isDefault; })[0] || list[0];
    try {
      p.setAudioTrack(pick.track);
    } catch (e) {
      return { ok: false, reason: 'api-error', detail: String((e && e.message) || e), current: curId };
    }
    diag.audioSwitches++;
    diag.lastAudioSwitch = { at: Date.now(), from: curId, to: pick.id, videoId: currentVideoId() };
    dbg('auto-dub uit: ' + curId + ' -> ' + pick.id);
    return { ok: true, changed: true, from: curId, to: pick.id, languageCode: pick.languageCode };
  }

  /**
   * Welke ondertitel hoort volgens YouTube zelf bij de actieve audiotrack?
   *
   * `playerResponse.captions.playerCaptionsTracklistRenderer` koppelt elke
   * audiotrack aan zijn ondertiteltracks: `audioTracks[i].audioTrackId`,
   * `captionTrackIndices[]` en `defaultCaptionTrackIndex`.
   *
   * Let op (live geverifieerd 2026-10-31 op `nQhXoo5564w`, EN-video met 20
   * auto-dubs): `defaultCaptionTrackIndex` is de **getoonde/localized** track
   * (hier `nl`, omdat de UI Nederlands is), terwijl **`captionTrackIndices[0]`
   * de bron-taal** is (`en`). Voor "wat is de taal van deze audio" is dat eerste
   * index het juiste signaal; anders leidde een Nederlandse UI een Engelse video
   * naar Nederlandse ondertitels.
   *
   * Bij een **auto-dub** zegt de bron-taal niets over de audio (die is immers
   * nagesynchroniseerd), dus dan geven we niets terug: de audiotaal zelf komt
   * dan uit `readAudioTrack()` (gewicht 100), en met de optie *Auto-dub uitzetten*
   * gaat de speler eerst terug naar het origineel.
   */
  function readAudioCaptionLanguage() {
    var p = player();
    var pr = safe(function () { return p && p.getPlayerResponse ? p.getPlayerResponse() : null; }, null);
    var r = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer;
    if (!r || !r.captionTracks || !r.captionTracks.length) return null;
    var at = safe(function () { return p.getAudioTrack ? p.getAudioTrack() : null; }, null);
    var atS = (at && (at.s1 || at.Pb)) || null;
    var activeId = (atS && atS.id) || (at && at.id) || null;
    var dubbed = atS && typeof atS.isAutoDubbed === 'boolean' ? atS.isAutoDubbed : L.decodeAudioTrackDubbed(activeId);
    if (dubbed) return null;
    var tracks = r.audioTracks || [];
    var entry = null;
    for (var i = 0; i < tracks.length; i++) {
      if (activeId && tracks[i] && tracks[i].audioTrackId === activeId) { entry = tracks[i]; break; }
    }
    if (!entry && typeof r.defaultAudioTrackIndex === 'number') entry = tracks[r.defaultAudioTrackIndex] || null;
    if (!entry && tracks.length === 1) entry = tracks[0];
    if (!entry) return null;
    var ct = null;
    if (entry.captionTrackIndices && entry.captionTrackIndices.length) {
      ct = r.captionTracks[entry.captionTrackIndices[0]] || null;
    }
    if (!ct && typeof entry.defaultCaptionTrackIndex === 'number') {
      ct = r.captionTracks[entry.defaultCaptionTrackIndex] || null;
    }
    if (!ct || !ct.languageCode) return null;
    return {
      languageCode: ct.languageCode,
      kind: ct.kind || '',
      vssId: ct.vssId || '',
      audioTrackId: entry.audioTrackId || null,
      isAutoDubbed: false
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
      audioCaption: readAudioCaptionLanguage(),
      audioTracks: readAudioTracks().map(function (t) {
        return { id: t.id, name: t.name, languageCode: t.languageCode, isAutoDubbed: t.isAutoDubbed, isDefault: t.isDefault };
      }),
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

  /**
   * De track staat goed én YouTube toont hem ook. Zonder die tweede controle
   * meldde `apply()` succes terwijl het CC-knopje uit stond: het menu toonde
   * een aangevinkte ondertitel, maar er kwam niets in beeld.
   */
  async function applyConfirmed(st, target, attempts) {
    if (!verifyState(st, target)) return false;
    if (await setCaptionsDisplayed(true)) return true;
    attempts.push('captions-off');
    return false;
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

    // 0. De track staat al goed maar de weergave niet (YouTube onthoudt de
    //    track en toont hem als aangevinkt in het menu, terwijl het CC-knopje
    //    uit staat). Dan is het menu openen en het al aangevinkte item
    //    aanklikken precies het verkeerde: dat is de klik die de gebruiker zelf
    //    moet doen om het weer aan de praat te krijgen. Alleen de weergave
    //    aanzetten is genoeg (bugmelding 2026-11-01).
    if (verifyState(before, target)) {
      if (await setCaptionsDisplayed(true)) {
        var shown = { ok: true, method: 'display', attempts: ['display'], before: before, after: readCurrentTrack(), target: target, captionsOn: true };
        diagApply(shown);
        return shown;
      }
      attempts.push('captions-off');
    }

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
      if (await applyConfirmed(st1, target, attempts)) {
        var viaApi = { ok: true, method: 'api', attempts: attempts, before: before, after: readCurrentTrack(), target: target, captionsOn: true };
        diagApply(viaApi);
        return viaApi;
      }
    }

    // 2. Menu-pad: nodig voor auto-gegenereerde tracks (en om een vertaling te wissen).
    var menuRes = await applyViaMenu(target);
    attempts.push('menu:' + (menuRes.reason || 'clicked'));
    await sleep(400);
    var st2 = readCurrentTrack();
    if (await applyConfirmed(st2, target, attempts)) {
      var viaMenu = { ok: true, method: 'menu', clicked: menuRes.clicked, attempts: attempts, before: before, after: readCurrentTrack(), target: target, captionsOn: true };
      diagApply(viaMenu);
      return viaMenu;
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
        if (await applyConfirmed(st3, manual, attempts)) {
          var viaFallback = { ok: true, method: 'api', fallback: 'manual', attempts: attempts, before: before, after: readCurrentTrack(), target: manual, captionsOn: true };
          diagApply(viaFallback);
          return viaFallback;
        }
      }
    }

    // 4. Diagnose: wat staat er aangevinkt?
    var checked = null;
    try { checked = await readCheckedMenuItem(); } catch (e) { /* ignore */ }

    var failed = {
      ok: false,
      reason: menuRes.reason === 'no-item' ? 'menu-item-missing' : 'verify-failed',
      attempts: attempts,
      before: before,
      after: readCurrentTrack(),
      captionsOn: captionsDisplayed(),
      expected: target,
      checkedMenuItem: checked
    };
    diagApply(failed);
    return failed;
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
  var BOOST_WORD_BY_WORD = true;   // optie "Word-for-Word" (default aan = woord voor woord;
                                   // uit = hele blokken van 2 volle zinnen)
  // YouTube kan per video meerdere tracks opvragen (handmatig + ASR + een
  // vertaalde variant) en prefetcht in playlists de volgende video. Met een
  // kleine voorraad gooit zo'n verzoek de track van de video die je nú kijkt
  // weg — en dan valt de weergave terug op YouTube's eigen (achterlopende)
  // venster. Vier is ruim genoeg en nog steeds begrensd.
  var BOOST_MAX_TRACKS = 4;
  var BOOST_BLOCK_SENTENCES = 2;    // zinnen per blok (user-keuze: 2 volle zinnen)
  var BOOST_SILENCE_GAP = 1.6;      // s stilte die een blok/run afsluit
  var BOOST_MAX_BLOCK_CHARS = 150;  // noodrem voor tracks zonder punctuatie
  var BOOST_LINGER = 0.45;          // s dat een blok/run na zijn laatste woord nog "actief" is
  // s dat de laatste regel na de stilte blijft staan voordat de overlay uitgaat
  // (YouTube's captionvenster laat de regel ook even staan; zie renderWordFrame).
  var BOOST_HOLD = 4.0;
  var BOOST_SYNC_MS = L.CAPTION_SYNC_DEFAULT_MS; // optie *Sync-offset*: woord verschijnt zoveel ms eerder
  var BOOST_WINDOW_RECHECK_FRAMES = 120;         // ± 2 s: venster/regelafstand opnieuw meten (vangnet)
  // s dat de slide-up duurt (CSS: `transition: top .2s`) + wat marge. Pas
  // daarna mag de regel die het venster uit schoof onzichtbaar gemaakt worden
  // (zie scheduleHideAboveWindow): tijdens het schuiven hoort hij nog te zien.
  var BOOST_WINDOW_SETTLE_MS = 240;
  // Aantal regels woordblokjes dat in de DOM blijft staan. Een run kan minuten
  // doorgaan zonder stilte; zonder grens groeit de DOM onbeperkt door en wordt
  // elke regelwissel (meten van alle blokjes) en elk schilderframe steeds
  // duurder — dat is de "na een tijdje loopt de ondertiteling achter"-klacht
  // (2026-10-31). De regels die ruim boven het venster staan zijn onzichtbaar
  // en worden weggegooid; de verschuiving gaat evenveel omlaag.
  var BOOST_KEEP_LINES = 4;

  /* ------------------------------------------------------------------ *
   * Reparatie als de track niet binnenkomt (2026-10-31)
   *
   * Caption Boost kan alleen tekenen als de speler de timedtext-track heeft
   * opgevraagd. Gebeurt dat niet (de speler denkt hem al te hebben, een
   * mislukt verzoek, een extensie die de respons tegenhield), dan bleef
   * YouTube's eigen venster staan — en dat loopt in playlists 1-2 s achter.
   * De page agent zet de ondertiteling dan één keer uit en weer aan, precies
   * wat een gebruiker doet. De speler vraagt de track dan opnieuw op en onze
   * XHR-hook vangt hem alsnog op (live geverifieerd 2026-10-31: verzoeken
   * 2 -> 3, daarna tekent de overlay direct weer).
   *
   * Er wordt NIET meer ververst als dat niet lukt (2026-11-01): een
   * pagina-reload zette de caption-weergave juist uit, waardoor de
   * ondertiteling onzichtbaar bleef. Na twee pogingen geeft de page agent het
   * op en laat hij YouTube's eigen venster staan.
   * ------------------------------------------------------------------ */
  var BOOST_REPAIR_AFTER_MS = 7000;    // s zonder track voordat we ingrijpen
  var BOOST_REPAIR_RETRY_MS = 10000;   // minimale tijd tussen twee pogingen
  var BOOST_REPAIR_MAX = 2;            // pogingen per video
  var BOOST_TRACK_SETTLE_MS = 3000;    // track moet zo lang stabiel zijn (menu-automatisering niet storen)

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
    box: null,
    scrollEl: null,
    blockKey: null,       // starttijd van het blok dat nu in de DOM staat
    runKey: null,         // starttijd van de run die nu in de DOM staat
    wordCount: 0,         // aantal woorden van die run dat al in de DOM staat
    windowShift: -1,      // laatst gezette venster-verschuiving in px (-1 = opnieuw meten)
    lastWordTop: null,    // bovenkant (px) van het laatst gezette woord (alleen voor de meting)
    lastWordEl: null,     // element van het laatst gezette woord (zelfde-frame vergelijking)
    lineChanged: false,   // laatste woord begon een nieuwe regel -> venster opnieuw meten
    currentTrack: null,   // track uit de 900ms-poll; niet opnieuw via de player-API per frame
    ownsCaptions: false,  // wij tekenen de ondertitel -> YouTube's eigen venster verborgen
    styleReady: false,
    missingSince: 0,      // sinds wanneer deze video geen opgevangen track heeft (0 = niets aan de hand)
    repairs: 0,           // reparatiepogingen (ondertiteling uit/aan) voor deze video
    repairAt: 0,          // tijdstip van de laatste reparatiepoging
    trackStableSince: 0   // sinds wanneer de track-key onveranderd is
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
    if (!CAPTION_BOOST_ENABLED) { diagIgnore('boost-off'); return; }
    try {
      var lang = urlParam(url, 'lang');
      var v = urlParam(url, 'v');
      if (!v) { diagIgnore('no-v'); return; }
      if (!lang) { diagIgnore('no-lang'); return; }
      if (!L.isSupported(lang)) { diagIgnore('lang-unsupported:' + lang); return; }
      if (urlParam(url, 'tlang')) { diagIgnore('translated'); return; } // vertaalde variant: nooit gebruiken
      var data = body;
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch (e) { diagIgnore('not-json'); return; }
      }
      if (!data || !data.events) { diagIgnore('no-events-field'); return; }
      var events = L.parseCaptionJson(data);
      if (!events.length) { diagIgnore('no-events'); return; }
      var blocks = L.buildCaptionBlocks(events, {
        sentences: BOOST_BLOCK_SENTENCES,
        silenceGap: BOOST_SILENCE_GAP,
        maxChars: BOOST_MAX_BLOCK_CHARS
      });
      if (!blocks.length) { diagIgnore('no-blocks'); return; }
      // Woord-voor-woord (optie): dezelfde events, maar als losse woorden en
      // in runs van doorlopende spraak — een stilte begint een nieuw venster.
      var runs = L.buildCaptionRuns(L.buildCaptionWords(events), BOOST_SILENCE_GAP);
      var key = boostKey(v, L.baseLang(lang), urlParam(url, 'kind') || '');
      // Dezelfde track kan opnieuw binnenkomen (bv. nadat YouTube de track
      // opnieuw ophaalt). Haal de sleutel dan eerst uit de volgorde: anders
      // staat hij er dubbel in en gooit het opruimen hieronder de gegevens van
      // de zojuist opgeslagen track weg (bug 2026-10-15).
      var at = boostTrackOrder.indexOf(key);
      if (at !== -1) boostTrackOrder.splice(at, 1);
      boostTrackOrder.push(key);
      boostTracks[key] = { at: Date.now(), events: events, blocks: blocks, runs: runs };
      diag.timedtext.stored++;
      diag.lastTrack = { key: key, at: Date.now(), events: events.length, blocks: blocks.length, runs: runs.length };
      while (boostTrackOrder.length > BOOST_MAX_TRACKS) {
        var old = boostTrackOrder.shift();
        if (old !== key) delete boostTracks[old];
      }
      dbg('timedtext opgevangen', key, events.length + ' events / ' + blocks.length + ' blokken / ' + runs.length + ' runs');
    } catch (e) { /* ignore */ }
  }

  /**
   * Een XHR-/fetch-respons naar een json3-object omzetten. De speler gebruikt
   * `responseType: 'json'`, 'text' of (zelden) een blob/ArrayBuffer; alle vier
   * moeten werken, anders valt Caption Boost terug op YouTube's eigen venster.
   */
  function bodyAsObject(body) {
    if (!body) return null;
    if (typeof body === 'object') {
      // Al geparsed door de speler (responseType 'json') of een Blob/ArrayBuffer.
      if (body.events) return body;
      if (typeof body.text === 'function') return null;   // Blob: synchroon niet te lezen
      if (body instanceof ArrayBuffer) return null;       // idem
      return body;
    }
    try { return JSON.parse(String(body)); } catch (e) { return null; }
  }

  /** Async variant voor Blob/ArrayBuffer (fetch of XHR met responseType blob). */
  function bodyAsObjectAsync(body, cb) {
    var sync = bodyAsObject(body);
    if (sync) { cb(sync); return; }
    try {
      if (body && typeof body.text === 'function') { body.text().then(function (t) { cb(bodyAsObject(t)); }, function () { cb(null); }); return; }
      if (body instanceof ArrayBuffer) { cb(bodyAsObject(new TextDecoder().decode(body))); return; }
    } catch (e) { /* ignore */ }
    cb(null);
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
          if (this.__scTt) diag.timedtext.requests++;
        } catch (e) { /* ignore */ }
        return origOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function () {
        if (this.__scTt) {
          try {
            var xhr = this;
            xhr.addEventListener('load', function () {
              try {
                var body = null;
                // `responseText` gooit bij responseType 'json'/'blob'/'arraybuffer';
                // `response` is dan het al geparste object (of een Blob).
                try { body = xhr.response; } catch (e) { body = null; }
                if (typeof body === 'string' && !body) {
                  try { body = xhr.responseText || null; } catch (e) { /* ignore */ }
                }
                if (body) {
                  bodyAsObjectAsync(body, function (data) {
                    if (data) storeBoostTrack(xhr.__scTtUrl, data);
                    else diagIgnore('unreadable');
                  });
                } else {
                  diagIgnore('empty-body');
                }
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
            diag.timedtext.requests++;
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
  var BOOST_SIZE_PCT = 130;    // default ondertitelgrootte (%; optie 50-250)
  var BOOST_LINES = 2;         // max. regels in de eigen weergave (1 of 2; optie, default 2)
  var BOOST_OFFSET_PCT = 9;    // y-offset in %-punten (optie; + = omlaag, - = omhoog)
  var BOOST_OFFSET_X_PCT = -9; // x-offset in %-punten (optie; + = naar rechts, - = naar
                               // links, 0 = gecentreerd)
  var BOOST_FONT = 'youtube';  // lettertype (optie; sleutel uit L.CAPTION_FONTS)
  var BOOST_WEIGHT = 400;      // letterdikte (optie; 300-700 in stappen van 25)
  var BOOST_BAR_WIDTH_PCT = 50; // breedte van het ondertitelvlak in % van de spelerbreedte
                                // (optie 30-100; het vlak staat gecentreerd, dus links en
                                // rechts blijft video zichtbaar)
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
    // De achtergrond van de woordblokjes is altijd ONDOORZICHTIG (alpha 1).
    // YouTube's captioninstellingen geven standaard een opacity van 0,75 mee en
    // de blokjes van naast elkaar liggende woorden én van twee regels
    // OVERLAPPEN elkaar (dat is juist de bedoeling: geen kier in het zwart).
    // Met een transparante achtergrond wordt zo'n overlap donkerder: dan zie je
    // per woord en per regel een andere griestint — een gevlekt zwart in plaats
    // van effen zwart (bugmelding 2026-09-20). De KLEUR komt nog steeds uit
    // YouTube's instellingen, alleen die opacity wordt genegeerd.
    var bc = L.rgbaFromHex(s.background, 1);
    if (tc) boostStyle.textColor = tc;
    if (bc) boostStyle.bgColor = bc;
    boostStyle.increment = typeof s.fontSizeIncrement === 'number' ? s.fontSizeIncrement : 0;
  }

  /**
   * De hoogte van de speler bepaalt de fontgrootte van de overlay. Die hoogte
   * wordt NIET elke keer opnieuw uit de layout gelezen: `clientHeight` forceren
   * na een DOM-wijziging een synchrone layout van de hele speler. We bewaren de
   * laatste waarde en verversen hem alleen als de speler echt van formaat
   * verandert (ResizeObserver + fullscreenchange; zonder ResizeObserver valt de
   * frame-lus terug op de oude periodieke controle).
   */
  var boostPlayerH = 0;

  function markPlayerSizeStale() {
    boostPlayerH = 0;
  }

  var boostSizeWatch = { ok: false };

  function watchPlayerSize() {
    if (boostSizeWatch.ok) return;
    try {
      var p = player();
      if (!p || typeof ResizeObserver !== 'function') return;
      var ro = new ResizeObserver(function () {
        markPlayerSizeStale();
        applyBoostStyle();
      });
      ro.observe(p);
      document.addEventListener('fullscreenchange', function () {
        markPlayerSizeStale();
        applyBoostStyle();
      });
      boostSizeWatch.ok = true;
    } catch (e) { /* ignore */ }
  }

  function applyBoostStyle() {
    var el = boost.overlay;
    if (!el) return;
    var p = player();
    if (!boostPlayerH) boostPlayerH = p ? p.clientHeight : 400;
    var px = L.captionFontPx(boostPlayerH, boostStyle.increment, BOOST_SIZE_PCT);
    // Lettertype en letterdikte (opties): meteen zetten, ook als de rest van de
    // stijl al toegepast is — een andere keuze of een nieuw overlay-element moet
    // direct goed staan.
    var family = L.captionFontStack(BOOST_FONT);
    if (el.style.fontFamily !== family) el.style.fontFamily = family;
    var weight = String(L.captionFontWeight(BOOST_WEIGHT));
    if (el.style.fontWeight !== weight) el.style.fontWeight = weight;
    // Kleur van de zwarte blokjes achter elk woord. Elk woord is een eigen
    // element met een eigen achtergrond; in de woord-voor-woord-weergave komen
    // die elementen er één voor één bij. Via deze CSS-variabele krijgt een
    // nieuw blokje meteen de juiste kleur en volgt een kleurwissel in YouTube's
    // ondertitelinstellingen alle blokjes die al in beeld staan.
    el.style.setProperty('--sc-caption-bg', boostStyle.bgColor);
    // Verticale positie (optie *Y-offset*): de ondertiteling hangt standaard
    // 10,5% boven de onderrand van de speler; de offset verschuift hem in
    // %-punten van de spelerhoogte (positief = omlaag).
    var bottom = L.captionBottomPct(BOOST_OFFSET_PCT) + '%';
    if (el.style.bottom !== bottom) el.style.bottom = bottom;
    // Horizontale positie (optie *X-offset*): de overlay loopt van links naar
    // rechts over de speler en de tekst wordt daarbinnen gecentreerd. De offset
    // schuift alles in %-punten van de spelerbreedte op (positief = naar
    // rechts); `left` en `right` gaan even hard de andere kant op, zodat de
    // breedte gelijk blijft.
    var side = L.captionSidePcts(BOOST_OFFSET_X_PCT);
    var leftCss = side.left + '%';
    var rightCss = side.right + '%';
    if (el.style.left !== leftCss) el.style.left = leftCss;
    if (el.style.right !== rightCss) el.style.right = rightCss;
    // Breedte van het ondertitelvlak (optie *Ondertitelbreedte*): het vlak staat
    // gecentreerd in de overlay en bepaalt waar de tekst mag afbreken.
    var wPct = L.captionBarWidthPct(BOOST_BAR_WIDTH_PCT);
    if (boost.box) {
      var widthCss = wPct + '%';
      if (boost.box.style.width !== widthCss) boost.box.style.width = widthCss;
    }
    var key = Math.round(px * 10) + '|' + boostStyle.textColor + '|' + boostStyle.bgColor;
    if (key === boostStyle.applied) return;
    boostStyle.applied = key;
    invalidateBoostText(); // stijl/grootte gewijzigd -> tekst opnieuw opbouwen
    el.style.fontSize = (Math.round(px * 10) / 10) + 'px';
    if (boost.box) {
      boost.box.style.color = boostStyle.textColor;
      boost.box.style.background = ''; // de achtergrond zit op de woordblokjes (ook na een extensie-herlaadbeurt op een open pagina)
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
          '#sc-caption-overlay{position:absolute;left:0;right:0;bottom:3.5%;text-align:center;pointer-events:none;z-index:45;display:none;' +
          'font-weight:500;line-height:1.4;font-family:Roboto,Arial,sans-serif;' +
          '--sc-caption-bg:rgba(8,8,8,1)}' +
          '#sc-caption-overlay.sc-on{display:block}' +
          // De achtergrond zit NIET meer op één balk achter het hele venster,
          // maar op elk woord apart (`.sc-caption-word`, net als YouTube's
          // auto-ondertitels): een woord komt binnen met zijn eigen zwarte
          // blokje en de blokjes van een regel groeien aan elkaar vast. De
          // kleur komt uit de CSS-variabele `--sc-caption-bg` (gezet in
          // applyBoostStyle op de overlay), zodat een nieuw woord meteen de
          // juiste kleur heeft.
          //
          // De verticale padding van een blokje valt bij een inline-element
          // BUITEN de regelbox: daardoor raken de blokjes van twee regels elkaar
          // en blijft er geen streep video tussen de regels staan. De
          // horizontale padding wordt door een even grote NEGATIEVE marge
          // gecompenseerd, zodat de woordafstand en de regelafbreking exact
          // gelijk blijven: het zwart loopt alleen door over de spaties (die
          // zitten in het blokje) en steekt een beetje voorbij de eerste en de
          // laatste letter van elke regel uit. Beide maten staan in
          // lang-utils (L.CAPTION_WORD_PAD_*_EM), zodat de checkpagina met
          // dezelfde waarden werkt.
          //
          // De breedte van het tekstvlak is een optie (BOOST_BAR_WIDTH_PCT,
          // 30-100%); de inline width op de box komt uit applyBoostStyle(). De
          // waarde hier is de terugval (50%). De box heeft een VASTE hoogte van
          // BOOST_LINES regels (inline, in em); de tekst begint linksboven,
          // links uitgelijnd. In de blokweergave staat het hele blok er in één
          // keer in (wat niet past wordt afgekapt); in de woord-voor-woord-
          // weergave wordt elk woord op zijn tijd toegevoegd en schuift
          // `.sc-caption-scroll` per HELE regel omhoog (`top`), zodat altijd
          // precies de laatste regels zichtbaar zijn.
          //
          // `display:block` + `margin:0 auto` (niet inline-block): een
          // inline-block met `overflow:hidden` heeft zijn ONDERrand als
          // baseline, waardoor de regelbox van de overlay onder de box nog de
          // descender van de strut toevoegde — de zwarte blokjes staken daardoor
          // ~15px verder door onder de tekst dan erboven. Als block is de
          // overlay precies zo hoog als de box. De verticale padding is bewust
          // asymmetrisch: onder minder dan boven, want de regelbox heeft onder
          // de baseline al meer ruimte. De som moet exact gelijk zijn aan
          // L.captionBoxHeightEm().
          //
          // `clip-path:inset(0)` is een extra vangnet naast `overflow:hidden`:
          // het klipt ook eventueel gecompositeerde lagen op de rand van het
          // venster af, zodat er nooit tekst buiten het venster valt als de
          // tekst omhoog schuift (zie setWordShift()).
          //
          // De regelafstand en de fontgrootte van de wrapper en van de
          // woordblokjes worden hier met `!important` VASTGEZET. Dat is geen
          // overbodige luxe: de mutatie (de verschuiving en de hoogte van het
          // venster) hangt aan de echte regelafstand, en een regel in de pagina
          // (of een andere extensie) die alleen `span`/`div` raakt kan de
          // overgeërfde 1,4em overschrijven. Dan staan de regels verder uit
          // elkaar dan de wrapper zegt en liep de bovenste regel uit het venster
          // (klacht 2026-09-18: "de tekst op de 1e regel kruipt omhoog en de
          // letters worden afgekapt"). De page agent meet de afstand nu ook
          // zelf (zie boostLineMetrics()), maar het ontwerp hoort 1,4em te zijn
          // en dat mag de pagina niet veranderen.
          '#sc-caption-overlay .sc-caption-box{position:relative;display:block;margin:0 auto;overflow:hidden;clip-path:inset(0);' +
          'box-sizing:border-box;width:50%;text-align:left;white-space:pre-wrap;' +
          'font-size:1em!important;' +
          'padding:' + L.CAPTION_PAD_TOP_EM + 'em ' + L.CAPTION_PAD_X_EM + 'em ' + L.CAPTION_PAD_BOTTOM_EM + 'em;' +
          'text-shadow:0 0 2px rgba(0,0,0,.8)}' +
          // De tekst schuift met een korte overgang op `top` (en niet met
          // `transform`: dat zet de tekst op een eigen compositing-laag, want
          // dan kan hij tijdens het schuiven buiten het venster getekend
          // worden — "regel 1 komt boven het blok uit").
          '#sc-caption-overlay .sc-caption-scroll{position:relative;transition:top .2s ease-out;' +
          'line-height:' + L.CAPTION_LINE_HEIGHT + '!important;font-size:1em!important}' +
          '#sc-caption-overlay .sc-caption-word{background:var(--sc-caption-bg);' +
          'line-height:' + L.CAPTION_LINE_HEIGHT + '!important;font-size:1em!important;' +
          // De verticale padding staat in CSS-variabelen (met de ontworpen maat
          // als terugval): de page agent zet ze op basis van de ECHTE inktmaten
          // van het font, zodat het zwart even ver boven als onder de letters
          // doorloopt en tot de rand van het venster komt (zie
          // applyBoostVerticalLayout() en L.captionVerticalLayout()).
          'padding:var(--sc-word-pad-top,' + L.CAPTION_WORD_PAD_Y_EM + 'em) ' + L.CAPTION_WORD_PAD_X_EM + 'em ' +
          'var(--sc-word-pad-bottom,' + L.CAPTION_WORD_PAD_Y_EM + 'em);' +
          'margin:0 -' + L.CAPTION_WORD_PAD_X_EM + 'em}';
        (document.head || document.documentElement).appendChild(st);
        boost.styleReady = true;
      } catch (e) { /* ignore */ }
    }
    // Snel pad: de overlay staat al in de speler en is compleet opgebouwd. Dan
    // hoeft er niets opgezocht of opgeruimd te worden (dit draait elke poll).
    var cached = boost.overlay;
    if (cached && cached.isConnected && cached.parentNode === p && boost.box && boost.box.isConnected &&
        boost.scrollEl && boost.scrollEl.isConnected) {
      applyBoostStyle();
      return cached;
    }
    var el = document.getElementById('sc-caption-overlay');
    if (el && el.parentNode && el.parentNode !== p) el.parentNode.removeChild(el);
    if (!el) {
      el = document.createElement('div');
      el.id = 'sc-caption-overlay';
    }
    // Een oudere versie zette één zwarte balk achter het hele venster; die moet
    // weg, anders staat de achtergrond er na een extensie-herlaadbeurt op een
    // open pagina alsnog als één blok in.
    var oldBar = el.querySelector('.sc-caption-bar');
    if (oldBar && oldBar.parentNode) oldBar.parentNode.removeChild(oldBar);
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
    boost.box = box;
    boost.scrollEl = scrollEl;
    applyBoostStyle();
    // Een nieuwe speler (SPA-navigatie) mist de klasse die YouTube's venster
    // verbergt; zolang wij de captions tekenen zetten we hem terug.
    if (boost.ownsCaptions && p.classList) p.classList.add('sc-boost-on');
    return el;
  }

  /**
   * Onze eigen overlay aan/uit. Dit raakt YouTube's caption-venster NIET: dat
   * blijft verborgen zolang Caption Boost de track tekent (`ownCaptions`). Zo
   * kan YouTube's eigen venster tijdens een stilte niet ineens zijn oude,
   * achterlopende regel terugzetten.
   */
  function hideBoost(on) {
    if (!boost.overlay) return;
    if (on) {
      boost.overlay.classList.add('sc-on');
      return;
    }
    boost.overlay.classList.remove('sc-on');
    if (boost.box) {
      boost.box.style.height = '';
      boost.box.style.fontSize = ''; // het font krimpt nooit
    }
    invalidateBoostText();
  }

  /**
   * YouTube's eigen caption-venster verbergen (`.sc-boost-on`) zolang Caption
   * Boost de ondertitel tekent. Vanaf het moment dat wij de track in handen
   * hebben is YouTube's renderer volledig uit beeld: die loopt in playlists
   * 1-2 s achter en houdt na een stilte de oude regel nog even vast. Wat je
   * ziet komt dan altijd uit onze eigen, op de tracktijd gesynchroniseerde
   * weergave.
   */
  function ownCaptions(on) {
    boost.ownsCaptions = !!on;
    if (on) diag.own.on++; else diag.own.off++;
    var p = player();
    if (!p || !p.classList) return;
    if (on) p.classList.add('sc-boost-on');
    else p.classList.remove('sc-boost-on');
  }

  /**
   * Verschuiving van het rollende venster zetten: `px` = het aantal pixels dat
   * de tekst omhoog moet (0 = bovenaan).
   *
   * Met `animate=true` schuift de tekst zichtbaar omhoog via de CSS-overgang op
   * `top` (slide-up, zoals YouTube's auto-ondertitels). Bij het opnieuw opbouwen
   * van het venster (nieuwe run, terugspoelen, moduswissel) gaat het juist
   * met-een: anders zou de tekst zichtbaar terugschuiven naar boven. Daarvoor
   * wordt de overgang heel even uitgezet en met een reflow afgedwongen.
   */
  function setWordShift(px, animate) {
    var wrap = boost.scrollEl;
    if (!wrap) return;
    // Altijd een expliciete lengte, nooit `''` (= `top:auto`): CSS kan niet van
    // `auto` naar een lengte interpoleren, dus dan zou de slide-up niet
    // animeren maar in één keer springen.
    var val = (px ? -px : 0) + 'px';
    if (wrap.style.top === val) return;
    if (animate) {
      wrap.style.top = val;
      return;
    }
    wrap.style.transition = 'none';
    wrap.style.top = val;
    try { void wrap.offsetHeight; } catch (e) { /* ignore */ }
    wrap.style.transition = '';
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
    boost.lastWordTop = null;
    boost.lastWordEl = null;
    boost.lineChanged = false;
    invalidateLineHeightCache();
    clearHideTimer();
    if (boost.scrollEl) {
      boost.scrollEl.textContent = '';
      boost.scrollEl.style.transform = ''; // oude versies schoven met transform
      setWordShift(0, false);
    }
  }

  /** Onze overlay uit als er iets in stond (hold verlopen, video-einde, wissel). */
  function hideOnce() {
    if (!boost.shownOnce) return;
    boost.shownOnce = false;
    hideBoost(false);
  }

  function stopBoost(reason) {
    if (boost.rafActive || boost.ownsCaptions) {
      diag.boost.stops++;
      diag.boost.lastStop = { reason: reason || 'unknown', at: Date.now(), videoId: diag.videoId };
      if (reason) diag.boost.stops[reason] = (diag.boost.stops[reason] || 0) + 1;
    }
    diag.boost.active = false;
    boost.rafActive = false;
    if (boost.rafHandle) {
      try { cancelAnimationFrame(boost.rafHandle); } catch (e) { /* ignore */ }
      boost.rafHandle = null;
    }
    boost.shownOnce = false;
    hideBoost(false);
    // Wij tekenen niets meer: YouTube's eigen venster mag weer (het is de enige
    // weergave die dan nog kan tonen wat er gezegd wordt).
    ownCaptions(false);
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
    // Elke sprekerswissel (">>") begint op een nieuwe regel; de markering zelf
    // blijft staan (die toont YouTube ook).
    buildBoostText(wrap, blk.text);
    wrap.style.transform = '';
    box.style.fontSize = '';
    box.style.maxWidth = '';
    box.style.height = L.captionBoxHeightEm(BOOST_LINES) + 'em';
    // Daarna de echte regels meten en de verticale layout daarop zetten: de
    // hoogte van het venster, de verticale padding van de blokjes en de marge
    // boven de tekst (dezelfde layout als het rollende venster; zie
    // L.captionVerticalLayout()). In de blokweergave schuift er niets, dus de
    // verschuiving is alleen die marge.
    var lh = boostLineHeightPx();
    var m = boostLineMetrics(lh);
    // In de blokweergave staat de tekst bovenaan: de regels die onder het
    // venster vallen mogen er ook geen zwart in schuiven.
    applyWordBleed(m, false);
    var layout = boostVerticalLayout(m.advance > 0 ? m.advance : lh, BOOST_LINES);
    applyBoostVerticalLayout(layout);
    setWordShift(layout.shiftPx, false);
  }

  /**
   * Eén frame van de blokweergave: welk blok hoort bij `t`? Het hele blok
   * staat in één keer in beeld (geen woord-voor-woord). Tijdens een stilte
   * blijft het laatste blok nog BOOST_HOLD s staan (zoals YouTube's venster);
   * daarna gaat onze overlay uit. YouTube's eigen venster blijft verborgen,
   * dus er komt geen oude regel terug.
   */
  function renderBlockFrame(t) {
    var ts = t + L.wordLeadSeconds(BOOST_SYNC_MS);
    var idx = L.captionBlockAt(boost.blocks, ts, BOOST_LINGER);
    if (idx < 0) {
      var held = L.captionBlockAt(boost.blocks, ts, BOOST_HOLD);
      if (held >= 0 && boost.shownOnce && boost.blockKey === boost.blocks[held].start) return;
      hideOnce();
      return;
    }
    var blk = boost.blocks[idx];
    // Eerst zichtbaar maken, dan pas opbouwen/metern: in een verborgen venster
    // (`display:none`) geven alle rects 0 en zou het venster op lucht gezet
    // worden (zie updateWordWindow).
    if (!boost.shownOnce) {
      boost.shownOnce = true;
      hideBoost(true);
    }
    if (boost.blockKey !== blk.start) {
      buildBlock(blk);
      boost.blockKey = blk.start;
    }
  }

  /**
   * Hoogte van één regel (px) in het captionvenster volgens de CSS. De CSS zet
   * `line-height:1.4` (met `!important`, zie ensureBoostDom);
   * `getComputedStyle` geeft die (via de overlay overgeërfd) als px terug. Komt
   * er geen bruikbare waarde uit, dan rekenen we met dezelfde verhouding als de
   * CSS.
   *
   * Dit is de VERWACHTE regelafstand; de echte afstand tussen de regels wordt
   * gemeten met boostLineMetrics() (die kan groter zijn als de pagina de
   * woordblokjes toch een andere line-height geeft).
   *
   * De waarde wordt bewaard: `getComputedStyle` na een DOM-wijziging forceren
   * een style-herberekening, en deze functie hangt aan elk nieuw woord
   * (`noteWordLine`). De cache vervalt bij een stijl-/groottewissel (de sleutel
   * is de laatst toegepaste stijl) en bij het vangnet van ± 2 s
   * (`invalidateLineHeightCache`), zodat een wijziging door de pagina alsnog
   * binnen twee seconden wordt opgemerkt.
   */
  var boostLineHeightCache = { key: '', px: 0 };

  function invalidateLineHeightCache() {
    boostLineHeightCache.key = '';
  }

  function boostLineHeightPx() {
    var key = 'v' + (boostStyle.applied || '');
    if (key === boostLineHeightCache.key) return boostLineHeightCache.px;
    var px = 0;
    try { px = parseFloat(getComputedStyle(boost.scrollEl).lineHeight); } catch (e) { px = 0; }
    if (!isFinite(px) || px <= 0) px = boostFontPx() * L.CAPTION_LINE_HEIGHT;
    if (!isFinite(px) || px <= 0) px = 0;
    boostLineHeightCache.key = key;
    boostLineHeightCache.px = px;
    return px;
  }

  /** Fontgrootte (px) van de overlay: inline gezet door applyBoostStyle(). */
  function boostFontPx() {
    var el = boost.overlay;
    var px = 0;
    try { px = parseFloat(el && el.style ? el.style.fontSize : ''); } catch (e) { px = 0; }
    if (!isFinite(px) || px <= 0) {
      try { px = parseFloat(getComputedStyle(el).fontSize); } catch (e) { px = 0; }
    }
    return isFinite(px) && px > 0 ? px : 0;
  }

  /**
   * De regels van de eigen weergave METEN in plaats van ze uit de line-height
   * van de wrapper af te leiden: `{lines, advance}` uit de bovenkanten van de
   * woordblokjes (via L.captionLineMetrics()). `advance` = de echte afstand
   * tussen twee regels in px (0 als er maar één regel staat).
   *
   * Nodig omdat de pagina de woordblokjes een andere line-height kan geven dan
   * de wrapper (de wrapper houdt dan 1,4em terwijl de regels verder uit elkaar
   * staan). Rekenen met de verkeerde regelafstand laat de bovenste regel uit het
   * venster lopen: de letters bovenaan worden dan afgekapt (klacht 2026-09-18).
   * De verschuiving en de vensterhoogte gebruiken daarom deze meting; alleen als
   * meten niet lukt (geen woorden, geen layout) valt de aanroeper terug op de
   * verwachte regelafstand.
   */
  function boostLineMetrics(expectedLineHeightPx) {
    var wrap = boost.scrollEl;
    var empty = { lines: 0, advance: 0, tops: [], index: [], items: [] };
    if (!wrap) return empty;
    var spans = null;
    try { spans = wrap.querySelectorAll('.sc-caption-word'); } catch (e) { spans = null; }
    if (!spans || !spans.length) return empty;
    var rects = [];
    var items = [];
    for (var i = 0; i < spans.length; i++) {
      var r = null;
      try { r = spans[i].getBoundingClientRect(); } catch (e) { r = null; }
      if (!r || !(r.width > 0) || !(r.height > 0)) continue;
      rects.push({ top: r.top, bottom: r.bottom });
      items.push({ el: spans[i], top: r.top });
    }
    if (!rects.length) return empty;
    var m = L.captionLineMetrics(rects, expectedLineHeightPx);
    m.items = items; // parallel aan m.index: per woordblokje zijn regelgroep
    return m;
  }

  /**
   * De woordblokjes van regels die BUITEN het venster vallen mogen geen zwart
   * ín het venster schilderen. De verticale padding van een inline-element valt
   * namelijk buiten zijn regelbox: de onderpadding van de regel die net boven
   * het venster staat steekt een paar px onder de bovenrand uit. Zo'n regel
   * loopt bijna altijd verder door dan de bovenste zichtbare regel (die breekt af
   * op het volgende woord), dus zag je daar een zwarte strook zonder tekst —
   * precies naast het laatste woord van de bovenste regel (bugmelding
   * 2026-09-20). We zetten daarom alleen de padding aan de kant van het venster
   * op 0 (boven het venster de onderpadding, eronder de bovenpadding). De andere
   * kant blijft staan, zodat de hartlijn van de blokjes — en daarmee de gemeten
   * regelafstand in de volgende frame — niet verschuift. De horizontale padding
   * en de letters zelf blijven ongemoeid, dus de slide-up en de regelafbreking
   * veranderen niet.
   */
  function applyWordBleed(m, fromEnd) {
    if (!m || !m.items || !m.items.length) return;
    var range = L.captionVisibleGroupRange(m.lines, BOOST_LINES, fromEnd);
    var idx = m.index || [];
    for (var i = 0; i < m.items.length; i++) {
      var el = m.items[i].el;
      if (!el || !el.style) continue;
      var g = typeof idx[i] === 'number' ? idx[i] : 0;
      var pt = g > range.last ? '0px' : '';  // regel onder het venster
      var pb = g < range.first ? '0px' : ''; // regel boven het venster
      if (el.style.paddingTop !== pt) el.style.paddingTop = pt;
      if (el.style.paddingBottom !== pb) el.style.paddingBottom = pb;
    }
  }

  /**
   * De fontmaten die de verticale layout bepalen, één keer per fontgrootte/
   * -familie gemeten met een canvas (`measureText`):
   *   fontBoxPx   = ascent + descent van het font (het vak van een inline-element),
   *   inkAbovePx  = ruimte in dat vak BOVEN de inkt (ascent - inktascent),
   *   inkBelowPx  = ruimte ONDER de inkt (descent - inktdiepte).
   *
   * De inktmaten komen uit een probe met een kapitaal, lange letters en
   * staartletters (`Hxdpgjq`), dus de hoogste en diepste letters van een gewone
   * regel. Waarom dit nodig is: een font reserveert boven de letters meer ruimte
   * dan eronder (bij Roboto/Arial ~0,20em tegen ~0,03em), waardoor de tekst in
   * een symmetrisch venster scheef staat — de letters tegen de bovenrand
   * (bugmelding 2026-09-19). Ontbreekt de API of gaat er iets mis, dan blijven de
   * waarden 0 en valt de layout terug op het oude gedrag.
   */
  var boostInk = { key: '', fontBoxPx: 0, inkAbovePx: 0, inkBelowPx: 0 };

  function boostInkMetrics() {
    var fs = boostFontPx();
    var family = '';
    var weight = '';
    try {
      var cs = getComputedStyle(boost.overlay);
      family = cs.fontFamily || '';
      weight = cs.fontWeight || '';
    } catch (e) { /* ignore */ }
    var key = Math.round(fs * 10) + '|' + weight + '|' + family;
    if (key === boostInk.key) return boostInk;
    var next = { key: key, fontBoxPx: 0, inkAbovePx: 0, inkBelowPx: 0 };
    try {
      if (fs > 0 && family) {
        var ctx = document.createElement('canvas').getContext('2d');
        if (ctx) {
          ctx.font = (weight ? weight + ' ' : '') + fs + 'px ' + family;
          var m = ctx.measureText('Hxdpgjq');
          var ascent = m.fontBoundingBoxAscent || 0;
          var descent = m.fontBoundingBoxDescent || 0;
          var inkAsc = m.actualBoundingBoxAscent || 0;
          var inkDesc = m.actualBoundingBoxDescent || 0;
          // Plausibiliteit: is de font-shorthand niet geaccepteerd (dan blijft
          // `ctx.font` op zijn oude waarde staan), dan kloppen de maten niet bij
          // deze fontgrootte. Zo'n meting is erger dan geen meting: de
          // halve regelafstand zou er enorm van worden en het venster op de
          // verkeerde plek zetten. Een fontvak tussen 0,6em en 2,2em is reëel.
          var box = ascent + descent;
          var plausible = box > fs * 0.6 && box < fs * 2.2 && inkAsc + inkDesc > 0;
          if (plausible) {
            next.fontBoxPx = box;
            next.inkAbovePx = Math.max(0, ascent - inkAsc);
            next.inkBelowPx = Math.max(0, descent - inkDesc);
          }
        }
      }
    } catch (e) { /* ignore */ }
    boostInk = next;
    return boostInk;
  }

  /**
   * De layout voor het huidige venster: de gemeten regelafstand + de fontmaten
   * van het gebruikte font + de padding van de box. Geeft het resultaat van
   * `L.captionVerticalLayout()` (hoogte in em, verschuiving in px en de
   * verticale padding van de woordblokjes).
   */
  function boostVerticalLayout(advancePx, lines) {
    var padTop = 0;
    var padBottom = 0;
    try {
      var cs = getComputedStyle(boost.box);
      padTop = parseFloat(cs.paddingTop) || 0;
      padBottom = parseFloat(cs.paddingBottom) || 0;
    } catch (e) { /* ignore */ }
    var ink = boostInkMetrics();
    return L.captionVerticalLayout({
      advancePx: advancePx,
      fontPx: boostFontPx(),
      fontBoxPx: ink.fontBoxPx,
      inkAbovePx: ink.inkAbovePx,
      inkBelowPx: ink.inkBelowPx,
      padTopPx: padTop,
      padBottomPx: padBottom,
      lines: lines
    });
  }

  /**
   * De verticale layout toepassen: de hoogte van de box (in em, dus hij volgt de
   * ondertitelgrootte) en de verticale padding van de woordblokjes (via de
   * CSS-variabelen `--sc-word-pad-top/-bottom`, zie de CSS in ensureBoostDom).
   * De *verschuiving* hoort bij de aanroeper: die weet hoeveel regels er zijn en
   * hoe groot de gemeten regelafstand is (updateWordWindow() / buildBlock()).
   */
  function applyBoostVerticalLayout(layout) {
    var box = boost.box;
    if (!box || !layout) return;
    if (layout.heightEm > 0) {
      var css = layout.heightEm + 'em';
      if (box.style.height !== css) box.style.height = css;
    }
    var el = boost.overlay;
    if (el && el.style && el.style.setProperty) {
      el.style.setProperty('--sc-word-pad-top', layout.wordPadTopEm + 'em');
      el.style.setProperty('--sc-word-pad-bottom', layout.wordPadBottomEm + 'em');
    }
  }

  /**
   * Onderkant van het FONTVLAK van één woordblokje (viewport-px): waar de
   * glyphs van dat woord echt staan, zónder de verticale padding van het
   * blokje. `getBoundingClientRect()` van het blokje geeft de rand mét die
   * padding, en die padding wordt voor regels buiten het venster juist op 0
   * gezet (applyWordBleed) — voor de controle "steekt deze regel nog in het
   * venster?" hebben we het tekstvlak nodig. Een Range om de inhoud geeft dat
   * vlak; lukt de meting niet, dan is de onderkant van het blokje de terugval.
   */
  function boostWordInkBottom(el) {
    if (!el) return null;
    var bottom = null;
    try {
      var range = document.createRange();
      range.selectNodeContents(el);
      var rects = range.getClientRects();
      for (var i = 0; i < rects.length; i++) {
        var r = rects[i];
        if (!(r.height > 0) || !(r.width > 0)) continue;
        if (bottom === null || r.bottom > bottom) bottom = r.bottom;
      }
    } catch (e) { bottom = null; }
    if (bottom !== null) return bottom;
    try {
      var own = el.getBoundingClientRect();
      if (own && own.height > 0) return own.bottom;
    } catch (e) { /* ignore */ }
    return null;
  }

  /** Staat de eigen overlay zichtbaar in de layout? Meten heeft anders geen zin. */
  function boostDisplayed() {
    var el = boost.overlay;
    if (!el || !el.isConnected) return false;
    try {
      if (!el.classList.contains('sc-on')) return false;
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch (e) {
      return false;
    }
  }

  /**
   * Extra verschuiving (px) zodat de regel die NET boven het venster staat er
   * niet in schildert (zie L.captionTopKeepOut voor de berekening).
   *
   * `captionVerticalLayout()` rekent de onderkant van die regel uit de
   * fontmaten en de marge. Zodra één van die maten niet klopt — een ander font
   * dan de canvasmeting zag, een pagina die de line-height overschrijft, een
   * fontval — staat die regel nét niet buiten en zie je de onderkant van zijn
   * letters als witte puntjes/streepjes boven de bovenste regel (klacht
   * 2026-10-31). Daarom meet deze functie de echte onderkant en schuift hij het
   * venster bij. De uitkomst is nooit groter dan de marge, zodat de tekst niet
   * tegen de bovenrand komt; wat er daarna nog zou uitsteken vangt
   * scheduleHideAboveWindow af.
   */
  function boostTopKeepOut(m, range, nextShiftPx, marginPx) {
    var box = boost.box;
    if (!box || !m || !m.items || !m.index) return 0;
    var prev = range && typeof range.first === 'number' ? range.first - 1 : -1;
    if (prev < 0) return 0;
    var boxTop = 0;
    try { boxTop = box.getBoundingClientRect().top; } catch (e) { return 0; }
    // De stand die de wrapper NU heeft (tijdens een slide-up een tussenstand;
    // `boost.windowShift` is dan al de eindstand van de vorige wissel).
    var cur = 0;
    try {
      var top = parseFloat(boost.scrollEl.style.top);
      cur = isFinite(top) ? -top : 0;
    } catch (e) { cur = 0; }
    var bottom = null;
    for (var i = 0; i < m.items.length; i++) {
      if (m.index[i] !== prev) continue;
      var b = boostWordInkBottom(m.items[i].el);
      if (b !== null && (bottom === null || b > bottom)) bottom = b;
    }
    if (bottom === null) return 0;
    return L.captionTopKeepOut(bottom, boxTop, cur, nextShiftPx, marginPx, 0.5);
  }

  var boostHideTimer = null;

  function clearHideTimer() {
    if (!boostHideTimer) return;
    try { clearTimeout(boostHideTimer); } catch (e) { /* ignore */ }
    boostHideTimer = null;
  }

  /**
   * `visibility:hidden` voor de woordblokjes van regels die boven het venster
   * staan. De clip van de box (`overflow:hidden` + `clip-path`) hoort die
   * regels al buiten te houden, maar dat is afhankelijk van de gemeten
   * geometrie — en zodra die een paar px afwijkt zie je de onderkant van de
   * letters van de vorige regel bovenaan het venster (klacht 2026-10-31).
   * Onzichtbare blokjes kunnen per definitie niets meer laten lekken, dus dit
   * is de harde garantie naast de berekening.
   *
   * De blokjes blijven in de layout staan (alleen `visibility`), zodat de
   * metingen en de regelindeling niet veranderen.
   */
  function applyHiddenAbove(m, range) {
    if (!m || !m.items || !m.index || !range) return;
    for (var i = 0; i < m.items.length; i++) {
      var el = m.items[i].el;
      if (!el || !el.style) continue;
      var v = m.index[i] < range.first ? 'hidden' : '';
      if (el.style.visibility !== v) el.style.visibility = v;
    }
  }

  /**
   * Het onzichtbaar maken uitstellen tot de slide-up klaar is: tijdens het
   * schuiven hoort de vertrekkende regel nog gewoon te zien, daarna nooit
   * meer. Elke nieuwe wissel zet de teller opnieuw.
   */
  function scheduleHideAboveWindow(m, range) {
    clearHideTimer();
    if (!m || !m.items || !m.index || !m.lines) return;
    if (!range || !(range.first > 0)) return;
    boostHideTimer = setTimeout(function () {
      boostHideTimer = null;
      applyHiddenAbove(m, range);
    }, BOOST_WINDOW_SETTLE_MS);
  }

  /**
   * Woordblokjes van regels die ruim boven het venster staan uit de DOM halen
   * (zie BOOST_KEEP_LINES).
   *
   * Retour: `{lines, px}` — hoeveel regels er weg zijn en hoeveel px de inhoud
   * daardoor omhoog schoof. Dat laatste moet van de verschuiving af, anders
   * verspringt het beeld; omdat de afstand GEMETEN is, blijft de stand exact.
   */
  function boostTrimAbove(m) {
    var wrap = boost.scrollEl;
    var none = { lines: 0, px: 0 };
    if (!wrap || !m || !m.items || !m.index || !m.lines) return none;
    // Nooit in de zichtbare regels snijden: er moeten minstens BOOST_LINES + 1
    // regels blijven staan (de zichtbare regels plus één regel erboven, zodat de
    // slide-up iets te schuiven heeft).
    var keep = Math.max(BOOST_KEEP_LINES, BOOST_LINES + 1);
    var cut = m.lines - keep;
    if (cut <= 0) return none;
    var keepEl = null;
    for (var i = 0; i < m.items.length; i++) {
      if (m.index[i] >= cut) { keepEl = m.items[i].el; break; }
    }
    if (!keepEl || keepEl.parentNode !== wrap) return none;
    var px = 0;
    try { px = m.tops[cut] - m.tops[0]; } catch (e) { px = 0; }
    if (!isFinite(px) || px <= 0) return none;
    while (wrap.firstChild && wrap.firstChild !== keepEl) wrap.removeChild(wrap.firstChild);
    return { lines: cut, px: Math.round(px * 100) / 100 };
  }

  /**
   * Het rollende venster bijwerken: zolang de gezette tekst binnen BOOST_LINES
   * regels past gebeurt er niets; daarboven schuift de tekst per HELE regel
   * omhoog zodat altijd de laatste regels zichtbaar zijn. De box zelf blijft
   * even hoog (het font krimpt nooit).
   *
   * De verschuiving komt uit de GEMETEN regels (`boostLineMetrics`: het aantal
   * regels, de echte afstand ertussen en de bovenkant van elke regel) plus de
   * marge uit de verticale layout (`boostVerticalLayout` /
   * `L.captionVerticalLayout()`). Die layout zet de inkt van de bovenste
   * zichtbare regel precies `L.CAPTION_MARGIN_RATIO` x de regelafstand onder de
   * bovenrand, maakt het venster zo hoog als de inkt van BOOST_LINES regels plus
   * twee keer die marge, en geeft de woordblokjes zoveel verticale padding dat
   * het zwart tot de rand van het venster komt. Daardoor staat de tekst optisch
   * midden in het zwart in plaats van tegen de bovenrand (bugmelding
   * 2026-09-19) en blijft de bovenste regel ook heel als de echte regelafstand
   * afwijkt van de line-height van de wrapper (bugmelding 2026-09-18).
   *
   * Het schuiven gebeurt met `top` op een `position:relative`-wrapper (via
   * setWordShift), met een korte CSS-overgang zodat je de slide-up ziet. Bewust
   * geen `transform`: dat zet de tekst op een eigen compositing-laag en dan kan
   * hij tijdens de beweging buiten het `overflow:hidden`-venster getekend
   * worden. `top` wordt niet gecompositeerd, dus het venster klipt elke frame.
   */
  function updateWordWindow() {
    var wrap = boost.scrollEl;
    if (!wrap) return;
    // Meten kan alleen als het venster echt in de layout staat: bij een
    // verborgen overlay (`display:none`) zijn alle rects 0 en zou de geometrie
    // op lucht gezet worden — met een veel te klein venster en een verkeerde
    // verschuiving tot gevolg. Dan blijft `windowShift` op -1 staan, zodat de
    // eerstvolgende zichtbare frame opnieuw meet.
    if (!boostDisplayed()) {
      boost.windowShift = -1;
      return;
    }
    var lh = boostLineHeightPx();
    var h = 0;
    try { h = wrap.getBoundingClientRect().height; } catch (e) { h = 0; }
    var m = boostLineMetrics(lh);
    var lines = m.lines > 0 ? m.lines : L.captionLinesFromHeight(h, lh);
    var step = m.advance > 0 ? m.advance : lh;
    // Hoogte + verticale padding van de blokjes uit de echte fontmaten; de tekst
    // komt met de marge (L.CAPTION_MARGIN_*) onder de bovenrand, zodat de inkt
    // optisch midden in het zwart staat en er boven én onder evenveel overblijft.
    var layout = boostVerticalLayout(step, BOOST_LINES);
    applyBoostVerticalLayout(layout);
    // Het zwart van regels die buiten het venster vallen mag niet in het venster
    // doorlopen (bugmelding 2026-09-20: een strook zwart naast het laatste woord
    // van de bovenste regel).
    applyWordBleed(m, true);
    var range = L.captionVisibleGroupRange(m.lines, BOOST_LINES, true);
    // De verschuiving bij voorkeur uit de GEMETEN hoogteverschillen: het aantal
    // regels x de mediaan-regelafstand is net niet de afstand waarop de
    // bovenste zichtbare regel staat zodra de regels onderling afwijken.
    var shiftLines = L.captionWindowShiftLines(lines, step, BOOST_LINES);
    var measured = m.lines > 1 ? L.captionWindowShiftMeasured(m.tops, BOOST_LINES) : 0;
    if (measured > 0) shiftLines = measured;
    var shift = Math.round((shiftLines + layout.shiftPx) * 100) / 100;
    // Vangnet: de regel die net boven het venster staat mag er echt niet in
    // schilderen, ook niet als een van de fontmaten niet klopt. Zonder bekende
    // marge (layout zonder meting) is de minimummarge het plafond.
    var keepOutMax = layout.marginPx > 0 ? layout.marginPx : boostFontPx() * L.CAPTION_MARGIN_MIN_EM;
    shift = Math.round((shift + boostTopKeepOut(m, range, shift, keepOutMax)) * 100) / 100;
    // Oude regels opruimen: de DOM groeit anders onbeperkt door in een lange run
    // (elke regelwissel meet alle blokjes en de browser schildert ze allemaal).
    var trimmed = boostTrimAbove(m);
    if (trimmed.px > 0) shift = Math.round((shift - trimmed.px) * 100) / 100;
    boost.lineChanged = false;
    if (shift !== boost.windowShift || trimmed.px > 0) {
      var animate = boost.windowShift >= 0 && !(trimmed.px > 0);
      boost.windowShift = shift;
      setWordShift(shift, animate);
    }
    // En na de slide-up: niets van de regels erboven mag nog zichtbaar zijn.
    scheduleHideAboveWindow(m, range);
  }

  /**
   * Eén woord als eigen element met een eigen zwarte achtergrond (net als
   * YouTube's auto-ondertitels): het blokje komt er samen met het woord bij en
   * de blokjes van een regel groeien aan elkaar vast.
   *
   * De spatie NA het woord zit in hetzelfde element, zodat er tussen twee
   * woorden nooit een kier in het zwart kan vallen. De padding links/rechts
   * daarvan wordt door een even grote NEGATIEVE marge gecompenseerd (zie de CSS
   * in ensureBoostDom), dus de woordafstand en de regelafbreking blijven exact
   * gelijk aan voorheen.
   */
  function appendBoostWord(wrap, text) {
    if (!wrap) return null;
    var el = document.createElement('span');
    el.className = 'sc-caption-word';
    el.textContent = text + ' ';
    wrap.appendChild(el);
    return el;
  }

  /**
   * Een hele tekst (blokweergave) in woordblokjes zetten. Elke sprekerswissel
   * (">>") begint op een nieuwe regel: `L.captionSpeakerBreaks()` zet daar een
   * regeleinde, en startCaptionLine() begint hier de nieuwe regel — precies
   * zoals in de woord-voor-woord-weergave.
   */
  function buildBoostText(wrap, text) {
    if (!wrap) return;
    wrap.textContent = '';
    var lines = L.captionSpeakerBreaks(text).split('\n');
    for (var i = 0; i < lines.length; i++) {
      if (i) startCaptionLine(wrap);
      var words = lines[i].split(' ');
      for (var j = 0; j < words.length; j++) {
        if (words[j]) appendBoostWord(wrap, words[j]);
      }
    }
  }

  /**
   * Een nieuwe regel beginnen in het rollende venster (sprekerswissel ">>"):
   * eerst de losse spatie van het vorige woord weghalen — anders blijft die
   * als hangende witruimte aan het regeleinde staan — en dan een echte
   * regelovergang (`<br>`) zetten. In een leeg venster gebeurt er niets, zodat
   * er geen lege eerste regel ontstaat.
   */
  function startCaptionLine(wrap) {
    if (!wrap) return;
    var last = wrap.lastChild;
    if (!last) return;
    if (last.nodeType === 1 && last.tagName === 'BR') return; // al een nieuwe regel
    // De spatie hangt aan het laatste woordblokje (een tekstknoop erin); een
    // ouder DOM had hem als losse tekstknoop in het venster.
    var node = last.firstChild;
    if (node && node.nodeType === 3) node.data = node.data.replace(/\s+$/, '');
    else if (last.nodeType === 3) last.data = last.data.replace(/\s+$/, '');
    wrap.appendChild(document.createElement('br'));
  }

  /**
   * Eén goedkope meting per nieuw woord: begint het op een nieuwe regel?
   *
   * Alle woorden van één regel hebben (vrijwel) exact dezelfde bovenkant; het
   * verschil tussen twee regels is de regelafstand. Alleen als de bovenkant
   * meer dan de meettolerantie verspringt (0,4 x de regelafstand, dezelfde maat
   * als `L.captionLineMetrics`) hoeft het venster opnieuw gemeten te worden.
   * Dat scheelt het dure meetwerk (alle woordblokjes langsgaan) bij elk woord —
   * precies het werk dat de weergave kon laten haperen en dan de hele rest van
   * de zin in één keer in beeld bracht.
   *
   * Beide blokjes worden in dezelfde frame gemeten: de slide-up schuift de
   * hele wrapper (`top`), dus een meting uit een vorige frame zou tijdens die
   * beweging een verschil van een halve regel kunnen zien.
   */
  function noteWordLine(prevEl, el) {
    if (!el) return;
    var top = null;
    var prevTop = null;
    try {
      top = el.getBoundingClientRect().top;
      if (prevEl && prevEl !== el) prevTop = prevEl.getBoundingClientRect().top;
    } catch (e) {
      return;
    }
    if (top == null || !isFinite(top)) return;
    var lh = boostLineHeightPx();
    var tol = Math.max(1, lh * L.CAPTION_LINE_GROUP_TOL);
    if (prevTop != null && isFinite(prevTop) && Math.abs(top - prevTop) > tol) boost.lineChanged = true;
    boost.lastWordTop = top;
  }

  /**
   * Eén frame van de woord-voor-woord-weergave: de woorden van de actieve run
   * komen één voor één in de DOM (op hun eigen tijd) en het venster rolt per
   * regel mee. Een stilte begint een nieuwe run (venster leeg); een sprong in
   * de video (terugspoelen) bouwt het venster opnieuw op.
   *
   * De sync-offset verschuift de HELE tijdlijn (runkeuze én woorden), zodat ook
   * het eerste woord van een nieuwe zin evenveel eerder komt als de rest.
   *
   * Per frame komt er hooguit één woord bij (`L.captionRevealPace`): loopt de
   * weergave even vast, dan tikken de woorden één voor één na in plaats van
   * dat er ineens een hele zin staat. Alleen bij een echte onderbreking
   * (tabblad op de achtergrond, terugspoelen) springt de weergave naar nu.
   */
  function renderWordFrame(t) {
    if (!boost.runs) { renderBlockFrame(t); return; }
    var ts = t + L.wordLeadSeconds(BOOST_SYNC_MS);
    var idx = L.captionRunAt(boost.runs, ts, BOOST_LINGER);
    if (idx < 0) {
      // Stilte: de laatste regel blijft nog BOOST_HOLD s staan (zoals YouTube's
      // venster) en gaat daarna uit. YouTube's eigen venster blijft verborgen,
      // zodat daar nooit een oude, achterlopende regel terugkomt.
      var held = L.captionRunAt(boost.runs, ts, BOOST_HOLD);
      if (held >= 0 && boost.shownOnce && boost.runKey === boost.runs[held].start) return;
      hideOnce();
      return;
    }
    var run = boost.runs[idx];
    var wrap = boost.scrollEl;
    var box = boost.box;
    if (!wrap || !box) return;
    var n = L.captionWordIndex(run.words, ts, 0);
    if (boost.runKey !== run.start || n < boost.wordCount) invalidateBoostText();
    boost.runKey = run.start;
    // De hoogte van het venster wordt NIET elke frame opnieuw gezet (dat zou de
    // gemeten hoogte steeds terugzetten): hij volgt de woorden, via
    // updateWordWindow() -> applyBoostBoxHeight() zodra er iets verandert.
    var reveal = L.captionRevealPace(n - boost.wordCount, L.CAPTION_REVEAL_PER_FRAME, L.CAPTION_REVEAL_JUMP);
    var prevEl = boost.lastWordEl || null;
    var lastEl = null;
    var want = Math.min(reveal, run.words.length - boost.wordCount);
    for (var k = 0; k < want; k++) {
      var word = run.words[boost.wordCount];
      // Sprekerswissel (">>") begint op een nieuwe regel, net als bij YouTube's
      // auto-ondertitels.
      if (L.isSpeakerChange(word.text)) startCaptionLine(wrap);
      // Elk woord komt er als eigen element bij — met zijn eigen zwarte
      // achtergrond, die dus ook pas met dat woord verschijnt. De rest van de
      // regelafbreking blijft daardoor staan (de browser wikkelt nog steeds
      // zelf, greedy).
      appendBoostWord(wrap, word.text);
      lastEl = wrap.lastChild;
      boost.wordCount++;
    }
    // Eén meting per frame, ná alle toevoegingen: meten tussen twee DOM-
    // wijzigingen in forceren de browser per woord een layout. Het laatste woord
    // van de reeks ligt per definitie op dezelfde regel als het vorige of een
    // regel lager, dus de vergelijking met het vórige frame detecteert een
    // regelovergang net zo goed als meten per woord (bugfix 2026-10-12: bij een
    // inhaalslag kwam anders de halve zin in één keer in beeld).
    // Eerst de overlay zichtbaar maken en dán pas meten: in een verborgen
    // venster (`display:none`) geeft elke rect 0 en zou de geometrie op lucht
    // gezet worden (zie updateWordWindow).
    if (!boost.shownOnce) {
      boost.shownOnce = true;
      hideBoost(true);
    }
    if (lastEl) noteWordLine(prevEl, lastEl);
    boost.lastWordEl = lastEl || prevEl;
    if (boost.windowShift < 0 || boost.lineChanged) updateWordWindow();
  }

  /**
   * Eén frame: kies de weergave (blokken of woord voor woord) en teken de
   * tekst die bij de huidige speeltijd hoort.
   *
   * De frame-lus is de enige plek waar een fout ons eigen captionvenster kan
   * laten staan terwijl YouTube's venster verborgen is (`ownCaptions`). Daarom
   * zit de body in een try/catch: bij een fout stoppen we netjes, zodat
   * YouTube's eigen weergave weer terugkomt in plaats van dat er helemaal geen
   * ondertiteling meer te zien is.
   */
  function renderBoost() {
    if (!boost.rafActive) return;
    var now = Date.now();
    if (diag.frames.lastAt) {
      var gap = now - diag.frames.lastAt;
      diag.frames.lastGapMs = gap;
      if (gap > diag.frames.maxGapMs) diag.frames.maxGapMs = gap;
      // > 150 ms = er zijn frames overgeslagen: de weergave kan dan zichtbaar
      // achter de audio aanlopen (rAF staat stil, pagina is te druk).
      if (gap > 150) diag.frames.slowFrames++;
    }
    diag.frames.lastAt = now;
    diag.frames.count++;
    if (document.hidden) diag.frames.hiddenFrames++;
    try {
      renderBoostFrame();
    } catch (e) {
      stopBoost('frame-error');
      return;
    }
    if (boost.rafActive) boost.rafHandle = requestAnimationFrame(renderBoost);
  }

  /**
   * Dekken de opgevangen blokken de huidige speeltijd? Tijdens een stilte
   * *binnen* de track is dat zo (dan verbergen we YouTube's venster bewust),
   * maar vóór de eerste of ná de laatste caption niet. In dat geval moet
   * YouTube's eigen venster terugkomen: een lege eigen overlay boven een
   * verborgen YouTube-venster is precies "de ondertitel lijkt aan maar je ziet
   * niets" (bugmelding 2026-11-01).
   */
  function boostCoversTime(blocks, t) {
    if (!blocks || !blocks.length) return false;
    var first = blocks[0] && blocks[0].start;
    var last = blocks[blocks.length - 1] && blocks[blocks.length - 1].end;
    if (typeof first !== 'number' || !isFinite(first)) return false;
    if (typeof last !== 'number' || !isFinite(last)) last = first;
    return t >= first - 1 && t <= last + BOOST_HOLD;
  }

  function renderBoostFrame() {
    var p = player();
    var cur = boost.currentTrack;
    if (!CAPTION_BOOST_ENABLED || !p || !cur || !boostSupported(cur) || isAdShowingInDom() ||
        !boost.blocks || !boost.blocks.length) {
      stopBoost('no-track-or-ad');
      return;
    }
    boost.frame++;
    if (boost.frame % 30 === 0) {
      var idNow = currentVideoId();
      if (idNow && boost.videoId && idNow !== boost.videoId) {
        boost.blocks = null;
        boost.runs = null;
        stopBoost('video-changed');
        return;
      }
      // Spelerformaat kan veranderd zijn (fullscreen/theater). Met een
      // ResizeObserver weten we dat meteen; zonder die API blijft deze
      // periodieke controle de terugvaloptie (dan is de hoogte wél opnieuw
      // nodig).
      if (!boostSizeWatch.ok) markPlayerSizeStale();
      applyBoostStyle();
    }
    // Vangnet: elke ± 2 s het venster opnieuw meten, ook als er geen nieuwe
    // regel begon. Zo volgt de weergave een tussentijdse wijziging van de
    // regelafstand/fontgrootte door de pagina alsnog (bugmelding 2026-09-18).
    if (BOOST_WORD_BY_WORD && boost.frame % BOOST_WINDOW_RECHECK_FRAMES === 0 && boost.wordCount > 0) {
      boost.lineChanged = true;
      invalidateLineHeightCache(); // de gemeten line-height hoort bij dit vangnet
    }

    var t = safe(function () { return p.getCurrentTime(); }, 0);
    // Buiten het bereik van de opgevangen track: niets te tekenen, dus geef
    // YouTube's venster terug in plaats van een leeg venster te claimen. De
    // lus blijft draaien (goedkoop) zodat we het bij een seek vanzelf weer
    // overnemen.
    if (!boostCoversTime(boost.blocks, t)) {
      if (boost.ownsCaptions) { hideOnce(); ownCaptions(false); }
      return;
    }
    if (!boost.ownsCaptions) ownCaptions(true);
    if (BOOST_WORD_BY_WORD) renderWordFrame(t);
    else renderBlockFrame(t);
  }

  /**
   * De speler opnieuw om de timedtext-track laten vragen: ondertiteling één
   * keer uit en (na een korte pauze) weer aan — dezelfde twee klikken die een
   * gebruiker zou doen. Live geverifieerd 2026-10-31: dit levert een nieuw
   * `/api/timedtext`-verzoek op dat de XHR-hook opvangt.
   *
   * Alleen als er echt gespeeld wordt en het tabblad zichtbaar is: een
   * reparatie in een verborgen tabblad kan niemand zien en zou alleen de
   * ondertiteling van dat tabblad laten knipperen.
   *
   * De tweede klik gebeurt op basis van het CC-knopje (`aria-pressed`) en
   * wordt herhaald tot de weergave echt aan staat. Vroeger hing hij aan
   * `readCurrentTrack()`; die blijft een track teruggeven terwijl de weergave
   * uit staat, waardoor de reparatie de ondertiteling uitzette en nooit meer
   * aanzette (bugmelding 2026-11-01).
   */
  var boostRepairBusy = false;

  function reRequestCaptions() {
    var p = player();
    var ps = safe(function () { return p && p.getPlayerState ? p.getPlayerState() : -1; }, -1);
    if (ps !== 1 || document.hidden) return false;
    if (boostRepairBusy) return false;
    if (!ccButton()) return false;
    if (!readCurrentTrack() && !captionsDisplayed()) return false;
    boostRepairBusy = true;
    (async function () {
      try {
        await setCaptionsDisplayed(false, 400);
        await sleep(500);
        // Weer aan (en controleer het): de speler vraagt de track dan opnieuw
        // op, en de weergave blijft niet per ongeluk uit staan.
        await setCaptionsDisplayed(true, 400);
      } finally {
        boostRepairBusy = false;
      }
    })();
    return true;
  }

  /**
   * Vangnet in de poll: hoort er getekend te worden maar is de track van deze
   * video nooit opgevangen, dan zet de page agent de ondertiteling één keer
   * uit/aan (max. BOOST_REPAIR_MAX keer). De pagina wordt nooit ververst: dat
   * zette de caption-weergave juist uit (bugmelding 2026-11-01).
   */
  function maybeRepairTrack(cur, id) {
    var now = Date.now();
    if (!boost.missingSince) {
      boost.missingSince = now;
      boost.repairs = 0;
      boost.repairAt = 0;
      return;
    }
    // De menu-automatisering van de content script kan net een track gezet
    // hebben; geef die eerst de tijd om binnen te komen.
    if (now - (boost.trackStableSince || 0) < BOOST_TRACK_SETTLE_MS) return;
    var waited = now - boost.missingSince;
    if (boost.repairs < BOOST_REPAIR_MAX && waited >= BOOST_REPAIR_AFTER_MS &&
        now - boost.repairAt >= BOOST_REPAIR_RETRY_MS) {
      boost.repairAt = now;
      if (reRequestCaptions()) {
        boost.repairs++;
        diag.repairs++;
        diag.lastRepair = { at: now, videoId: id, attempt: boost.repairs, track: cur ? cur.languageCode + '/' + (cur.kind || '') : null };
        dbg('track niet opgevangen - ondertiteling een keer uit/aan (poging ' + boost.repairs + ')');
      }
    }
  }

  /**
   * Aan/uit van de eigen weergave. `cur`, `id` en `ad` komen van `tick()` door:
   * die heeft ze in dezelfde ronde al uit de speler gelezen (scheelt twee
   * player-API-calls en een DOM-query per poll).
   */
  function boostTick(cur, id, ad) {
    boost.currentTrack = cur;
    if (!CAPTION_BOOST_ENABLED || SUBTITLES_OFF) { if (boost.rafActive) stopBoost('off'); return; }
    if (!cur || !boostSupported(cur) || ad) {
      if (boost.rafActive) stopBoost(!cur ? 'no-track-selected' : (!boostSupported(cur) ? 'track-unsupported-or-translated' : 'ad'));
      return;
    }
    if (!id) { if (boost.rafActive) stopBoost('no-video-id'); return; }
    var key = boostKey(id, L.baseLang(cur.languageCode), cur.kind === 'asr' ? 'asr' : '');
    if (boost.videoId !== id || boost.trackKey !== key) {
      boost.blocks = null;
      boost.runs = null;
      stopBoost('track-key-changed');
      boost.videoId = id;
      boost.trackKey = key;
      boost.missingSince = 0;
      boost.repairs = 0;
      boost.repairAt = 0;
      boost.trackStableSince = Date.now();
      diag.videoId = id;
    }
    if (!boost.blocks) {
      var rec = boostTracks[key];
      if (rec && rec.blocks && rec.blocks.length) boost.blocks = rec.blocks;
    }
    // De runs horen bij de blokken en worden los opgebouwd: als die stap ooit
    // halverwege afbreekt (fout in de parser), bleef `runs` null terwijl
    // `blocks` al gezet was — en dan viel de weergave voorgoed terug op de
    // blokken (bugmelding 2026-11-01: `drawing.words: 0`, `renderLag: null`).
    if (boost.blocks && !boost.runs) {
      var recRuns = boostTracks[key];
      if (recRuns) {
        try {
          boost.runs = recRuns.runs || L.buildCaptionRuns(L.buildCaptionWords(recRuns.events || []), BOOST_SILENCE_GAP);
        } catch (e) {
          boost.runs = null;
        }
      }
    }
    if (boost.blocks && boost.blocks.length) {
      boost.missingSince = 0;
      boost.repairs = 0;
      refreshBoostStyle(false);
      ensureBoostDom();
      watchPlayerSize();
      // Vanaf hier tekenen wij de ondertitel: YouTube's eigen venster gaat uit
      // en blijft uit tot stopBoost() (dus ook tijdens een stilte). Anders zet
      // YouTube's (in playlists 1-2 s achterlopende) renderer tijdens elke
      // pauze zijn oude regel terug — precies het "de ondertiteling loopt
      // achter" dat je dan ziet. Buiten het bereik van de track niet: dan
      // heeft onze overlay niets te tekenen en moet YouTube's venster blijven
      // staan (zie renderBoostFrame).
      if (boostCoversTime(boost.blocks, safe(function () { return player().getCurrentTime(); }, 0))) {
        ownCaptions(true);
      }
      if (!boost.rafActive) {
        boost.rafActive = true;
        boost.frame = 0;
        diag.boost.starts++;
        diag.boost.active = true;
        diag.boost.since = Date.now();
        diag.frames.lastAt = 0;
        boost.rafHandle = requestAnimationFrame(renderBoost);
      }
    } else {
      // Wel een geschikte track, maar (nog) geen opgevangen timedtext: eerst
      // de ondertiteling één keer uit/aan, daarna pas het oude vangnet.
      maybeRepairTrack(cur, id);
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
    stopBoost('subtitles-off');
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
      if (!CAPTION_BOOST_ENABLED) stopBoost('boost-disabled');
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
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'captionOffset')) {
      var off = Number(opts.captionOffset);
      BOOST_OFFSET_PCT = isFinite(off) ? Math.max(-40, Math.min(30, off)) : 9;
      applyBoostStyle(); // zet de nieuwe bottom op de overlay (en herrekent niets onnodig)
      dbg('captionOffset', BOOST_OFFSET_PCT);
    }
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'captionOffsetX')) {
      var offX = Number(opts.captionOffsetX);
      var maxX = L.CAPTION_OFFSET_X_MAX;
      BOOST_OFFSET_X_PCT = isFinite(offX) ? Math.max(-maxX, Math.min(maxX, offX)) : -9;
      applyBoostStyle(); // zet de nieuwe left/right op de overlay
      dbg('captionOffsetX', BOOST_OFFSET_X_PCT);
    }
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'captionWidth')) {
      BOOST_BAR_WIDTH_PCT = L.captionBarWidthPct(Number(opts.captionWidth));
      applyBoostStyle(); // balk en box krijgen meteen de nieuwe breedte
      dbg('captionWidth', BOOST_BAR_WIDTH_PCT);
    }
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'captionFont')) {
      BOOST_FONT = L.captionFontKey(opts.captionFont);
      applyBoostStyle();
      dbg('captionFont', BOOST_FONT);
    }
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'captionWeight')) {
      BOOST_WEIGHT = L.captionFontWeight(Number(opts.captionWeight));
      applyBoostStyle();
      dbg('captionWeight', BOOST_WEIGHT);
    }
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'captionWordByWord')) {
      var wbw = !!opts.captionWordByWord;
      if (wbw !== BOOST_WORD_BY_WORD) {
        BOOST_WORD_BY_WORD = wbw;
        invalidateBoostText(); // andere weergave -> tekst opnieuw opbouwen
      }
      dbg('captionWordByWord', BOOST_WORD_BY_WORD);
    }
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'captionSyncMs')) {
      var sync = L.captionSyncMs(opts.captionSyncMs);
      if (sync !== BOOST_SYNC_MS) {
        BOOST_SYNC_MS = sync; // geldt meteen voor de woorden die nog moeten komen
        invalidateBoostText();
      }
      dbg('captionSyncMs', BOOST_SYNC_MS);
    }
    return {
      captionBoost: CAPTION_BOOST_ENABLED,
      captionSize: BOOST_SIZE_PCT,
      captionLines: BOOST_LINES,
      captionOffset: BOOST_OFFSET_PCT,
      captionOffsetX: BOOST_OFFSET_X_PCT,
      captionWidth: BOOST_BAR_WIDTH_PCT,
      captionFont: BOOST_FONT,
      captionWeight: BOOST_WEIGHT,
      captionWordByWord: BOOST_WORD_BY_WORD,
      captionSyncMs: BOOST_SYNC_MS,
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
  var lastAudioKey = null;

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
    var on = captionsDisplayed();
    var key = captionKey(cur) + (on ? '|on' : '|off');
    if (key !== lastCaptionKey) {
      lastCaptionKey = key;
      post({
        type: 'captionChanged',
        videoId: lastVideoId,
        current: cur,
        captionsOn: on,
        translated: !!(cur && cur.translated)
      });
    }

    // Audiotrack-wissel (auto-dub!): YouTube kan tijdens het kijken van
    // audiotrack wisselen (of de gebruiker doet het). De content script zet
    // een dub terug naar het origineel als die optie aan staat.
    var at = readAudioTrack();
    var atKey = at ? (at.id + '|' + (at.isAutoDubbed ? 'dub' : 'orig')) : 'none';
    if (atKey !== lastAudioKey) {
      lastAudioKey = atKey;
      post({ type: 'audioChanged', videoId: lastVideoId, audioTrack: at });
    }

    // Caption Boost: eigen weergave aan/uitzetten zodra de juiste track actief is.
    // De al gelezen waarden gaan mee (geen tweede ronde langs de player-API).
    boostTick(cur, id, ad);

    // Vangnet: een herlaadbeurt van de extensie kan '.sc-boost-on' op een open
    // pagina hebben achtergelaten. Zonder eigen weergave hoort YouTube's
    // captionvenster gewoon zichtbaar te zijn.
    if (!boost.ownsCaptions && p.classList) p.classList.remove('sc-boost-on');

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
