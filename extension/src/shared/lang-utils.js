/*
 * SubtitleCorrector - gedeelde pure logica (klassiek script, geen modules).
 *
 * Wordt geladen door:
 *   - content script (isolated world)  -> chrome.scripting world "ISOLATED"
 *   - page agent     (MAIN world)      -> praat met de YouTube player
 *   - service worker                   -> importScripts()
 *
 * Alles hier is puur (geen DOM, geen chrome.*), zodat het testbaar is met Node
 * (zie tools/test-lang-utils.mjs).
 *
 * Exposeert: globalThis.SCLang
 */
(function (root) {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Scope: alleen Engels en Nederlands (bewust, zie de prompt-spec).
   * ------------------------------------------------------------------ */
  var SUPPORTED = ['en', 'nl'];
  var SUPPORTED_LABEL = { en: 'EN', nl: 'NL' };

  /* ------------------------------------------------------------------ *
   * Gelokaliseerde UI-herkenning (YouTube kan NL/EN/DE/... UI tonen).
   * ------------------------------------------------------------------ */
  var RE_SUBTITLE_ITEM = /subtitles?\s*(\/\s*cc|cc)?|ondertitel|untertitel|subtítulos?|sottotitoli|sous-titres|subtitr|legendas|subti|субтитры|자막|字幕|คำบรรยาย|الترجمة|ترجمة/i;
  var RE_AUTO_TRANSLATE = /auto[\s-]?translate|automatisch vertalen|automatisch [uü]bersetzen|traducci[oó]n autom[aá]tica|traduire automatiquement|traduzione automatica|tradu[çc][aã]o autom[aá]tica|автоперевод|자동 번역|自動翻訳|自动翻译|ترجمة تلقائية/i;
  var RE_AUTO_GENERATED = /\(.*auto[\s-]?gen|\(.*automatisch|\(.*autom[aá]tic|\(.*automatique|\(.*automatic|\(.*автоматич|\(.*자동|\(.*自動|\(.*自动|\(.*تلقائ/i;
  var RE_TRANSLATED_LABEL = />>|»/;

  /* ------------------------------------------------------------------ *
   * Basis-helpers
   * ------------------------------------------------------------------ */

  /** "en-US" / "nl_NL" / "EN" -> "en" */
  function baseLang(code) {
    if (!code || typeof code !== 'string') return null;
    var c = code.trim().toLowerCase().replace(/_/g, '-');
    if (!c) return null;
    var base = c.split('-')[0];
    return /^[a-z]{2,3}$/.test(base) ? base : null;
  }

  function isSupported(code) {
    var b = baseLang(code);
    return !!b && SUPPORTED.indexOf(b) !== -1;
  }

  function sameLang(a, b) {
    var x = baseLang(a);
    var y = baseLang(b);
    return !!x && !!y && x === y;
  }

  /** Korte badge-tekst: 'en' -> 'EN' */
  function shortLabel(code) {
    var b = baseLang(code);
    return b ? b.toUpperCase() : String(code || '?').toUpperCase();
  }

  function normalizeLabel(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
  }

  /** Label zonder de " >> Engels" vertaal-suffix. */
  function stripTranslationSuffix(label) {
    return String(label == null ? '' : label).split(/>>|»/)[0].replace(/\s+/g, ' ').trim();
  }

  function isTranslatedLabel(label) {
    return RE_TRANSLATED_LABEL.test(String(label || ''));
  }

  /* ------------------------------------------------------------------ *
   * Prestatie-regels: wanneer mag de zware audio-analyse (laag 4)?
   *
   * Een extensie kan YouTube's caption-renderer geen CPU geven; ze kan
   * alleen haar EIGEN zware werk (tab-capture + Whisper/GPU) uit de weg
   * gaan op de momenten dat de speler het drukst is (playlists).
   * ------------------------------------------------------------------ */

  /** Zit deze query (location.search) in een playlist-context? */
  function queryHasPlaylist(search) {
    return /(?:^|[?&])list=/.test(String(search || ''));
  }

  /**
   * Mag laag 4 (audio opnemen + bridge/Whisper) draaien?
   *
   * @param {Object} ctx
   *   ctx.enabled          audioFallback-setting aan? (anders: nooit)
   *   ctx.trigger          'auto' | 'hotkey'
   *   ctx.inPlaylist       playlist-context?
   *   ctx.captionPriority  caption-prioriteit aan? (default true)
   *   ctx.allowInPlaylists audioFallbackInPlaylists-setting (default false)
   *   ctx.lastCaptureAt    tijdstip (ms) van de vorige opname
   *   ctx.now              nu (ms)
   *   ctx.cooldownMs       min. tijd tussen opnames (default 45000)
   * @returns {{allowed:boolean, reason:string}}
   */
  function shouldUseAudioFallback(ctx) {
    ctx = ctx || {};
    if (ctx.enabled === false) return { allowed: false, reason: 'fallback-disabled' };

    // In een playlist standaard geen zware audio-analyse; alleen via de hotkey.
    if (ctx.trigger !== 'hotkey' && ctx.captionPriority !== false && ctx.inPlaylist && ctx.allowInPlaylists !== true) {
      return { allowed: false, reason: 'playlist-hotkey-only' };
    }

    // Nooit twee opnames kort na elkaar (Whisper is zwaar; playlists wisselen snel).
    if (ctx.trigger !== 'hotkey') {
      var cooldown = typeof ctx.cooldownMs === 'number' ? ctx.cooldownMs : 45000;
      if (ctx.lastCaptureAt && ctx.now - ctx.lastCaptureAt < cooldown) {
        return { allowed: false, reason: 'cooldown' };
      }
    }
    return { allowed: true, reason: 'ok' };
  }

  /* ------------------------------------------------------------------ *
   * Audio-track taal
   *
   * YouTube geeft `player.getAudioTrack()`:
   *   { id: "251;ChEKBWFjb250...", s1: { name: "English original", id: "en.4" }, ... }
   * Het `s1.id` is "<taal>.<n>" als YouTube de audiotaal kent, anders "und".
   * De `id` zelf is base64-protobuf met daarin de taal (laatste redmiddel).
   * ------------------------------------------------------------------ */

  /** "en.4" -> "en"; base64-protobuf -> taal; "und" -> null */
  function decodeAudioTrackLang(id) {
    if (!id || typeof id !== 'string') return null;
    var raw = id.trim();
    if (!raw || /^und$/i.test(raw)) return null;

    // Vorm "<lang>.<n>" of "<lang>-<REGIO>.<n>"
    var m = /^([a-z]{2,3}(?:-[a-z0-9]{2,8})?)\.\d+$/i.exec(raw);
    if (m) return baseLang(m[1]);

    // Base64-protobuf: "...lang\x12\x02en" (zoek 'lang' gevolgd door de code)
    var b64 = raw.split(';').pop();
    if (!/^[A-Za-z0-9+/=_-]{8,}$/.test(b64)) return null;
    try {
      var bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
      var lm = /lang[^a-z]*([a-z]{2,3})/.exec(bin);
      if (lm) return baseLang(lm[1]);
    } catch (e) { /* geen base64 -> negeren */ }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * Track-selectie: prioriteit 1 = auto-gegenereerd, prioriteit 2 = handmatig
   * ------------------------------------------------------------------ */

  /**
   * @param {Array} tracks    [{languageCode, kind, vssId, displayName, isAutoGenerated, translated}]
   * @param {string} lang     doeltaal ('en'|'nl' of variant)
   * @param {boolean} preferAutoGenerated
   * @returns {{track:Object, priority:1|2, candidates:Array}|null}
   */
  function pickCaptionTrack(tracks, lang, preferAutoGenerated) {
    if (!tracks || !tracks.length) return null;
    var want = baseLang(lang);
    if (!want) return null;

    var ofLang = tracks.filter(function (t) {
      return t && sameLang(t.languageCode, want) && !t.translated;
    });
    if (!ofLang.length) return null;

    var auto = ofLang.filter(function (t) { return t.isAutoGenerated; });
    var manual = ofLang.filter(function (t) { return !t.isAutoGenerated; });

    var prefer = preferAutoGenerated !== false;
    var list = prefer ? auto.concat(manual) : manual.concat(auto);
    if (!list.length) return null;

    var chosen = list[0];
    return {
      track: chosen,
      priority: chosen.isAutoGenerated ? 1 : 2,
      candidates: list
    };
  }

  /* ------------------------------------------------------------------ *
   * Audio-taal detectie uit player-metadata (zonder audio-analyse).
   *
   * Bronnen, op betrouwbaarheid:
   *   100  audioTrack.s1  ("en.4" / "English original")   <- echte audiotrack
   *    90  huidige caption-track met kind 'asr'            <- ASR volgt de audio
   *    80  precies één ASR-taal in de tracklijst
   *    40  videoDetails.defaultAudioLanguage               <- zwak, kan dub zijn
   * ------------------------------------------------------------------ */
  function detectAudioLanguage(probe) {
    var cands = [];
    function push(code, source, weight) {
      var b = baseLang(code);
      if (b && isSupported(b)) cands.push({ lang: b, source: source, weight: weight });
    }

    if (probe && probe.audioTrack) push(probe.audioTrack.languageCode, 'audio-track', 100);
    if (probe && probe.current && probe.current.isAutoGenerated) push(probe.current.languageCode, 'current-asr', 90);

    var asrLangs = (probe && probe.asrLanguages) || [];
    var manyAsr = asrLangs.length > 1;
    if (asrLangs.length === 1) push(asrLangs[0], 'asr-track', 80);
    if (probe && probe.defaultAudioLanguage) push(probe.defaultAudioLanguage, 'default-audio-language', 40);

    if (!cands.length) {
      return { lang: null, source: null, ambiguous: manyAsr, candidates: [] };
    }

    var strong = cands.filter(function (c) { return c.weight >= 80; });
    var uniqStrong = {};
    strong.forEach(function (c) { uniqStrong[c.lang] = true; });
    var ambiguous = manyAsr || Object.keys(uniqStrong).length > 1;

    var best = cands.slice().sort(function (a, b) { return b.weight - a.weight; })[0];
    return {
      lang: best.lang,
      source: best.source,
      ambiguous: ambiguous,
      candidates: cands
    };
  }

  /* ------------------------------------------------------------------ *
   * Het plan: wat moet er gebeuren?
   *
   * acties:
   *   'apply'     -> zet de ondertitel op `target`
   *   'none'      -> alles staat al goed
   *   'no-track'  -> audio-taal bekend, maar geen ondertitel in die taal
   *   'unknown'   -> audio-taal niet uit metadata te halen (audio-fallback nodig)
   * ------------------------------------------------------------------ */
  function planFix(probe, opts) {
    opts = opts || {};
    var prefer = opts.preferAutoGenerated !== false;

    var det = null;
    if (opts.detected) {
      det = {
        lang: baseLang(opts.detected),
        source: opts.detectedSource || 'audio-analysis',
        ambiguous: false,
        candidates: []
      };
    } else {
      det = detectAudioLanguage(probe);
    }

    if (!det || !det.lang || !isSupported(det.lang)) {
      return {
        action: 'unknown',
        lang: null,
        source: det ? det.source : null,
        ambiguous: !!(det && det.ambiguous),
        reason: det && det.ambiguous ? 'ambiguous-audio-language' : 'audio-language-unknown'
      };
    }

    var pick = pickCaptionTrack(probe.tracks || [], det.lang, prefer);
    if (!pick) {
      return {
        action: 'no-track',
        lang: det.lang,
        source: det.source,
        reason: 'no-subtitle-track-for-audio-language'
      };
    }

    var target = pick.track;
    var cur = probe.current || null;
    var curIsAsr = !!(cur && cur.isAutoGenerated);
    var targetIsAsr = !!target.isAutoGenerated;
    var sameTrack = !!(cur && sameLang(cur.languageCode, target.languageCode) && curIsAsr === targetIsAsr);
    var translated = !!(cur && cur.translated);
    var captionsOff = !probe.captionsOn;
    var wantOn = captionsOff && opts.forceSubtitlesOn !== false;

    // Ondertitels staan uit en we mogen ze niet aanzetten -> niets doen.
    if (captionsOff && !wantOn) {
      return {
        action: 'none',
        lang: det.lang,
        source: det.source,
        target: target,
        priority: pick.priority,
        reason: 'captions-off-ignored'
      };
    }

    var reason = null;
    if (wantOn) reason = 'subtitles-off';
    else if (translated) reason = 'translation-active';
    else if (!sameTrack) reason = 'wrong-track';

    if (!reason) {
      return {
        action: 'none',
        lang: det.lang,
        source: det.source,
        target: target,
        priority: pick.priority,
        reason: 'already-ok'
      };
    }

    return {
      action: 'apply',
      lang: det.lang,
      source: det.source,
      target: target,
      priority: pick.priority,
      reason: reason,
      translatedTo: translated && cur ? baseLang(cur.translatedTo) : null,
      turnOn: captionsOff
    };
  }

  /* ------------------------------------------------------------------ *
   * Caption Boost: json3 timedtext parsen en per woord uitlezen
   *
   * De YouTube-speler haalt de ondertitel-track op als json3; ASR-tracks
   * hebben per segment `tOffsetMs` per woord. Daarmee kan de extensie zelf
   * woord-voor-woord renderen en zo het achterlopende caption-venster van
   * YouTube omzeilen. Alles hier is puur (geen DOM) en dus testbaar.
   * ------------------------------------------------------------------ */

  /**
   * @param {Object} data json3-object ({events:[{tStartMs,dDurationMs,segs:[{utf8,tOffsetMs}]}]})
   * @returns {Array<{start:number,dur:number,raw:string,text:string,bounds:Array<{t:number,end:number}>}>}
   */
  function parseCaptionJson(data) {
    var out = [];
    var events = (data && data.events) || [];
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (!e || !e.segs || !e.segs.length) continue;
      var raw = '';
      var bounds = [];
      for (var j = 0; j < e.segs.length; j++) {
        var s = e.segs[j];
        var u = s && s.utf8 ? String(s.utf8) : '';
        if (!u) continue;
        raw += u;
        var off = typeof s.tOffsetMs === 'number' ? s.tOffsetMs : 0;
        bounds.push({ t: ((e.tStartMs || 0) + off) / 1000, end: raw.length });
      }
      var clean = raw.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
      if (!clean) continue;
      out.push({
        start: (e.tStartMs || 0) / 1000,
        dur: (e.dDurationMs || 0) / 1000,
        raw: raw,
        text: clean,
        bounds: bounds
      });
    }
    out.sort(function (a, b) { return a.start - b.start; });
    return out;
  }

  /** Index van het laatste event dat op tijd `t` (seconden) begonnen is. */
  function findCaptionEvent(events, t) {
    var lo = 0;
    var hi = events.length - 1;
    var ans = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (events[mid].start <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  /** Welke tekst hoort bij tijd `t` (seconden)? Woord-voor-woord bij offsets. */
  function boostTextFor(events, t) {
    if (!events || !events.length) return '';
    var idx = findCaptionEvent(events, t);
    if (idx < 0) return '';
    var ev = events[idx];
    var next = events[idx + 1];
    if (!next && t > ev.start + ev.dur + 5) return '';
    var text = ev.raw;
    if (ev.bounds && ev.bounds.length) {
      var last = -1;
      for (var i = 0; i < ev.bounds.length; i++) {
        if (ev.bounds[i].t <= t + 0.05) last = i;
        else break;
      }
      text = last < 0 ? '' : ev.raw.slice(0, ev.bounds[last].end);
    }
    return String(text).replace(/[^\S\n]+/g, ' ').trim();
  }

  /* ------------------------------------------------------------------ *
   * Captionstijl: kleur/opacity en grootte van de eigen overlay
   * ------------------------------------------------------------------ */

  /** '#rgb'/'#rrggbb' + alpha (0-1) -> 'rgba(r,g,b,a)'; null bij een ongeldige kleur. */
  function rgbaFromHex(color, alpha) {
    var hex = String(color == null ? '' : color).trim();
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
    if (!m) return null;
    var h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    var a = typeof alpha === 'number' && isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1;
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + (Math.round(a * 1000) / 1000) + ')';
  }

  /** YouTube's fontSizeIncrement -> schaalfactor voor onze overlay (milde benadering). */
  function captionSizeScale(increment) {
    var inc = typeof increment === 'number' && isFinite(increment) ? increment : 0;
    return Math.max(0.5, Math.min(2, 1 + inc * 0.12));
  }

  /**
   * Fontgrootte (px) voor de overlay: 3,2% van de spelerhoogte × YouTube's
   * size-stand × het gebruikerspercentage (50-250).
   */
  function captionFontPx(playerHeight, increment, sizePercent) {
    var h = typeof playerHeight === 'number' && isFinite(playerHeight) && playerHeight > 0 ? playerHeight : 400;
    var pct = typeof sizePercent === 'number' && isFinite(sizePercent) ? Math.max(50, Math.min(250, sizePercent)) : 100;
    var px = h * 0.032 * captionSizeScale(increment) * (pct / 100);
    return Math.max(10, Math.min(160, px));
  }

  /* ------------------------------------------------------------------ *
   * UI-tekst (Nederlands) voor de toast/badge
   * ------------------------------------------------------------------ */
  var REASON_NL = {
    'translation-active': 'vertaling stond aan',
    'wrong-track': 'verkeerde track',
    'subtitles-off': 'ondertitels stonden uit',
    'captions-off-ignored': 'ondertitels staan uit (niet aangezet)',
    'already-ok': 'stond al goed',
    'no-subtitle-track-for-audio-language': 'geen ondertitel in deze taal',
    'audio-language-unknown': 'audiotaal onbekend',
    'ambiguous-audio-language': 'audiotaal onduidelijk'
  };

  function describePlan(plan) {
    if (!plan) return 'onbekend';
    return REASON_NL[plan.reason] || plan.reason || 'onbekend';
  }

  /**
   * Toast-tekst voor een uitgevoerd plan.
   * @param {Object} plan   resultaat van planFix()
   * @param {Object|null} result  resultaat van de page agent ({ok, method, fallback})
   */
  function toastText(plan, result) {
    if (!plan) return 'Subtitle Corrector: geen resultaat';
    var what = plan.lang ? shortLabel(plan.lang) : '?';
    var kind = plan.target && plan.target.isAutoGenerated ? 'auto' : 'handmatig';

    if (plan.action === 'none') {
      return what + ' (' + kind + ') - ' + describePlan(plan) + ' \u2713';
    }
    if (plan.action === 'unknown') {
      return 'Audiotaal niet te bepalen (' + describePlan(plan) + ')';
    }
    if (plan.action === 'no-track') {
      return 'Audio is ' + what + ', maar er is geen ondertitel in die taal';
    }
    if (result && result.ok) {
      var extra = result.fallback === 'manual' ? ' (auto-track niet gevonden, handmatig gebruikt)' : '';
      return what + ' ' + kind + ' gezet - ' + describePlan(plan) + extra + ' \u2713';
    }
    if (result && result.reason === 'click-failed') {
      return 'Kon het ondertitelmenu niet bedienen (YouTube UI gewijzigd?)';
    }
    return 'Toepassen mislukt (' + describePlan(plan) + ')';
  }

  root.SCLang = {
    SUPPORTED: SUPPORTED,
    SUPPORTED_LABEL: SUPPORTED_LABEL,
    RE_SUBTITLE_ITEM: RE_SUBTITLE_ITEM,
    RE_AUTO_TRANSLATE: RE_AUTO_TRANSLATE,
    RE_AUTO_GENERATED: RE_AUTO_GENERATED,
    baseLang: baseLang,
    isSupported: isSupported,
    sameLang: sameLang,
    shortLabel: shortLabel,
    normalizeLabel: normalizeLabel,
    stripTranslationSuffix: stripTranslationSuffix,
    isTranslatedLabel: isTranslatedLabel,
    queryHasPlaylist: queryHasPlaylist,
    shouldUseAudioFallback: shouldUseAudioFallback,
    decodeAudioTrackLang: decodeAudioTrackLang,
    pickCaptionTrack: pickCaptionTrack,
    detectAudioLanguage: detectAudioLanguage,
    planFix: planFix,
    parseCaptionJson: parseCaptionJson,
    boostTextFor: boostTextFor,
    rgbaFromHex: rgbaFromHex,
    captionSizeScale: captionSizeScale,
    captionFontPx: captionFontPx,
    describePlan: describePlan,
    toastText: toastText
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
