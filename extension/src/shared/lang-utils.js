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
   * Caption Boost: json3 timedtext parsen en in blokken groeperen
   *
   * De YouTube-speler haalt de ondertitel-track op als json3; ASR-tracks
   * hebben per segment `tOffsetMs` per woord. Met die data bouwt de
   * extensie zelf blokken van 2 volle zinnen en omzeilt zo het
   * achterlopende caption-venster van YouTube. Alles hier is puur (geen
   * DOM) en dus testbaar.
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

  /** Index van het laatste event dat op tijd `t` (seconden) begonnen is (-1 = nog niets). */
  function captionEventIndex(events, t) {
    if (!events || !events.length) return -1;
    var lo = 0;
    var hi = events.length - 1;
    var ans = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (events[mid].start <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  /**
   * Hoeveel woorden van dit event zijn op tijd `t` (seconden) al gezegd?
   * De overlay zet alle woorden vooraf in de DOM (vaste layout/linkse uitlijning)
   * en maakt ze stuk voor stuk zichtbaar met deze telling.
   */
  function captionRevealCount(ev, t) {
    if (!ev) return 0;
    if (!ev.bounds || !ev.bounds.length) return ev.start <= t ? 1 : 0;
    var n = 0;
    for (var i = 0; i < ev.bounds.length; i++) {
      if (ev.bounds[i].t <= t + 0.05) n++;
      else break;
    }
    return n;
  }

  /* ------------------------------------------------------------------ *
   * Caption Boost: van losse cue's naar blokken van 2 volle zinnen
   *
   * De YouTube-track bestaat uit korte cue's (zinsdelen). Die los renderen
   * geeft halfgevulde regels: de 2e regel vult maar een kwart en de rest
   * komt pas in een volgend blok. Daarom groepeert de extensie de cue's
   * vooraf in blokken van (standaard) 2 VOLLEDIGE zinnen: zo'n blok komt in
   * één keer in beeld, van het eerste tot het laatste woord. De grens ligt
   * exact op het 2e zinseinde — ook als dat midden in een cue valt; de rest
   * van die cue gaat dan naar het volgende blok.
   *
   * Een stilte (standaard > 1,6 s tussen twee woorden) sluit een blok af,
   * ook met maar één zin erin (korte zin tussen twee stiltes houdt dus zijn
   * eigen blok). Tracks zonder punctuatie vallen terug op een tekenlimiet
   * (`maxChars`, standaard 150).
   * ------------------------------------------------------------------ */

  var CAPTION_LINE_HEIGHT = 1.4; // line-height van de eigen overlay (CSS)
  var CAPTION_PAD_EM = 0.06;     // verticale padding per kant (.06em in de CSS)

  /** Hoogte van het vaste captionvenster in em (1 of 2 regels + padding). */
  function captionBoxHeightEm(lines) {
    var n = typeof lines === 'number' && isFinite(lines) ? Math.round(lines) : 2;
    if (n < 1) n = 1;
    if (n > 2) n = 2;
    return Math.round((n * CAPTION_LINE_HEIGHT + 2 * CAPTION_PAD_EM) * 1000) / 1000;
  }

  /** Eindposities (index ná het leesteken) van alle zinseinden in `text`. */
  function sentenceEndPositions(text) {
    var re = /[.!?…]+["'”’)\]]*(?=\s|$)/g;
    var out = [];
    var m;
    while ((m = re.exec(String(text == null ? '' : text)))) {
      out.push(m.index + m[0].length);
    }
    return out;
  }

  /**
   * Tekst opdelen in zinnen (leestekens blijven bij de zin). Een rest zonder
   * eindpunt is ook een zin. "3.5" wordt niet gesplitst; "etc." wel
   * (bewust simpel gehouden — het gaat om spraak, niet om proza).
   */
  function splitSentences(text) {
    var s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (!s) return [];
    var out = [];
    var pos = sentenceEndPositions(s);
    var start = 0;
    for (var i = 0; i < pos.length; i++) {
      var piece = s.slice(start, pos[i]).trim();
      if (piece) out.push(piece);
      start = pos[i];
    }
    var rest = s.slice(start).trim();
    if (rest) out.push(rest);
    return out;
  }

  /**
   * Alle events omzetten naar losse stukjes (woorddelen) met een tijd, zodat
   * een blokgrens ook midden in een cue kan liggen. Elk stukje krijgt een
   * `end` (start van het volgende stukje, of het einde van het event).
   */
  function captionChunks(events) {
    var chunks = [];
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (!ev) continue;
      var next = events[i + 1] || null;
      var dur = ev.dur > 0 ? ev.dur : (next ? Math.max(0.2, next.start - ev.start) : 1.5);
      var evEnd = ev.start + dur;
      var parts = [];
      if (ev.bounds && ev.bounds.length) {
        var prev = 0;
        for (var b = 0; b < ev.bounds.length; b++) {
          var end = Math.min(ev.bounds[b].end, ev.raw.length);
          if (end > prev) {
            parts.push({ raw: ev.raw.slice(prev, end), t: ev.bounds[b].t });
            prev = end;
          }
        }
        if (prev < ev.raw.length) {
          parts.push({ raw: ev.raw.slice(prev), t: ev.bounds[ev.bounds.length - 1].t });
        }
      } else {
        parts.push({ raw: ev.raw, t: ev.start });
      }
      for (var p = 0; p < parts.length; p++) {
        var endT = p + 1 < parts.length ? parts[p + 1].t : evEnd;
        parts[p].end = endT > parts[p].t ? endT : parts[p].t;
      }
      chunks = chunks.concat(parts);
    }
    return chunks;
  }

  /**
   * Groepeer events in blokken van hele zinnen.
   *
   * opts.sentences   zinnen per blok (default 2)
   * opts.silenceGap  stilte (s) die een blok afsluit (default 1.6)
   * opts.maxChars    noodrem voor tracks zonder punctuatie (default 150)
   *
   * -> [{start, end, text, sentences}] op tijdsorde
   */
  function buildCaptionBlocks(events, opts) {
    opts = opts || {};
    var perBlock = typeof opts.sentences === 'number' && isFinite(opts.sentences) ? Math.max(1, Math.round(opts.sentences)) : 2;
    var silenceGap = typeof opts.silenceGap === 'number' && isFinite(opts.silenceGap) ? Math.max(0, opts.silenceGap) : 1.6;
    var maxChars = typeof opts.maxChars === 'number' && isFinite(opts.maxChars) ? Math.max(20, opts.maxChars) : 150;
    var chunks = captionChunks(events || []);
    var blocks = [];
    var cur = null;

    function close() {
      if (!cur) return;
      var text = String(cur.raw).replace(/\s+/g, ' ').trim();
      if (text) {
        blocks.push({ start: cur.start, end: cur.until, text: text, sentences: sentenceEndPositions(text).length });
      }
      cur = null;
    }

    for (var i = 0; i < chunks.length; i++) {
      var ch = chunks[i];
      if (!ch.raw || !ch.raw.trim()) continue;
      if (cur && ch.t - cur.until > silenceGap) close(); // stilte: blok sluit
      var rest = ch.raw;
      var guard = 0;
      while (rest && rest.trim() && guard++ < 12) {
        if (!cur) cur = { start: ch.t, until: ch.end, raw: '' };
        // Sommige tracks leveren segmenten zonder leidende spatie; vul die
        // aan, anders plakken twee stukjes aan elkaar ("ccccdddd").
        var piece = rest;
        if (cur.raw && !/\s$/.test(cur.raw) && !/^\s/.test(piece)) piece = ' ' + piece;
        var combined = cur.raw + piece;
        var ends = sentenceEndPositions(combined);
        if (ends.length >= perBlock) {
          // Knippen op het 2e zinseinde; de rest van dit stukje gaat door
          // naar het volgende blok (zelfde tijd).
          cur.raw = combined.slice(0, ends[perBlock - 1]);
          cur.until = ch.end;
          close();
          rest = combined.slice(ends[perBlock - 1]);
          continue;
        }
        cur.raw = combined;
        cur.until = ch.end;
        if (cur.raw.replace(/\s+/g, ' ').trim().length >= maxChars) close();
        rest = '';
      }
    }
    close();
    return blocks;
  }

  /** Index van het laatste blok dat op tijd `t` (s) begonnen is (-1 = nog niets). */
  function captionBlockIndex(blocks, t) {
    if (!blocks || !blocks.length) return -1;
    var lo = 0;
    var hi = blocks.length - 1;
    var ans = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (blocks[mid].start <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  /**
   * Actief blok op tijd `t`: het laatste blok dat begonnen is, zolang `t`
   * binnen het blok + `linger` (default 0,45 s) valt. In een stilte geeft dat
   * -1 -> de overlay gaat uit (zoals YouTube's eigen venster).
   */
  function captionBlockAt(blocks, t, linger) {
    var idx = captionBlockIndex(blocks, t);
    if (idx < 0) return -1;
    var lg = typeof linger === 'number' && isFinite(linger) && linger >= 0 ? linger : 0.45;
    return t <= blocks[idx].end + lg ? idx : -1;
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
   * size-stand × het gebruikerspercentage (50-250; ontbreekt -> default 175).
   */
  function captionFontPx(playerHeight, increment, sizePercent) {
    var h = typeof playerHeight === 'number' && isFinite(playerHeight) && playerHeight > 0 ? playerHeight : 400;
    var pct = typeof sizePercent === 'number' && isFinite(sizePercent) ? Math.max(50, Math.min(250, sizePercent)) : 175;
    var px = h * 0.032 * captionSizeScale(increment) * (pct / 100);
    return Math.max(10, Math.min(160, px));
  }

  /**
   * Aantal regels dat de browser (greedy, per woord) nodig heeft om
   * `wordWidths` — met `spacePx` ertussen — in een box van `widthPx` te zetten.
   * Simuleert de regelafbreking; zonder woorden 0.
   */
  function captionLineCount(wordWidths, spacePx, widthPx) {
    var n = wordWidths && wordWidths.length ? wordWidths.length : 0;
    if (!n) return 0;
    var w = typeof widthPx === 'number' && isFinite(widthPx) ? widthPx : 0;
    if (w <= 0) return n;
    var sp = typeof spacePx === 'number' && isFinite(spacePx) && spacePx > 0 ? spacePx : 0;
    var lines = 1;
    var cur = wordWidths[0];
    for (var i = 1; i < n; i++) {
      if (cur + sp + wordWidths[i] <= w + 0.01) cur += sp + wordWidths[i];
      else { lines++; cur = wordWidths[i]; }
    }
    return lines;
  }

  /**
   * Kleinste boxbreedte (px) waarin `wordWidths` in maximaal `lines` regels
   * past. Voor 2 regels: de best mogelijke woordgrens (`min` over alle grenzen
   * van `max(links, rechts)`). Bij die breedte kiest de browser automatisch
   * dezelfde grens: hij neemt zoveel woorden als passen en de rest is een
   * suffix van de rechterkant, dus die past ook. `lines < 2` of één woord:
   * de volledige breedte op één regel.
   */
  function captionFitWidth(wordWidths, spacePx, lines) {
    var n = wordWidths && wordWidths.length ? wordWidths.length : 0;
    if (!n) return 0;
    var sp = typeof spacePx === 'number' && isFinite(spacePx) && spacePx > 0 ? spacePx : 0;
    var total = 0;
    for (var i = 0; i < n; i++) total += wordWidths[i] + (i ? sp : 0);
    if (lines < 2 || n === 1) return total;
    var best = total;
    var left = 0;
    for (var k = 1; k < n; k++) {
      left += wordWidths[k - 1] + (k > 1 ? sp : 0);
      var right = total - left - sp;
      var w = left > right ? left : right;
      if (w < best) best = w;
    }
    return best;
  }

  /**
   * Boxbreedte (px) + eventuele fontkrimp voor de eigen captionweergave bij
   * een maximaal aantal regels.
   *
   * lines     1 of 2 (2 = de cue wordt zoveel mogelijk over twee regels verdeeld).
   * wordWidths  breedtes van de losse woorden (px, canvas `measureText`).
   * spacePx   breedte van één spatie (px).
   * softMaxPx normale bovengrens (92% van de speler).
   * hardMaxPx absolute bovengrens (bijna de hele spelerbreedte). Past de cue
   *           door een grote `captionSize` niet in `lines` regels binnen
   *           softMaxPx, dan groeit de box tot maximaal hardMaxPx — anders zou
   *           de tekst naar 3+ regels wikkelen (bug 2026-09-12 bij 175%).
   * padPx     kleine marge.
   *
   * -> { width, fontScale }
   *    width     boxbreedte (px); 0 = geen ruimte/geen beperking.
   *    fontScale 1, of < 1 (ondergrens 0,4) als zelfs hardMaxPx niet genoeg
   *              is: de caller verkleint de fontgrootte met deze factor; alle
   *              breedtes schalen mee, dus de cue past dan alsnog in `lines`.
   */
  function captionBoxWidth(lines, wordWidths, spacePx, softMaxPx, hardMaxPx, padPx) {
    var soft = typeof softMaxPx === 'number' && isFinite(softMaxPx) && softMaxPx > 0 ? softMaxPx : 0;
    if (!soft) return { width: 0, fontScale: 1 };
    var hard = typeof hardMaxPx === 'number' && isFinite(hardMaxPx) && hardMaxPx > 0 ? hardMaxPx : 0;
    if (hard < soft) hard = soft;
    var pad = typeof padPx === 'number' && isFinite(padPx) && padPx > 0 ? padPx : 0;
    var widths = [];
    if (wordWidths && wordWidths.length) {
      for (var i = 0; i < wordWidths.length; i++) {
        var v = Number(wordWidths[i]);
        if (isFinite(v) && v > 0) widths.push(v);
      }
    }
    if (!widths.length) return { width: soft, fontScale: 1 };
    if (lines < 2) return { width: soft, fontScale: 1 };
    var fit = captionFitWidth(widths, spacePx, 2);
    var width = fit + pad;
    var scale = 1;
    if (width > hard) {
      scale = Math.max(0.4, Math.max(1, hard - pad) / fit);
      width = fit * scale + pad;
      if (width > hard) width = hard;
    }
    return { width: Math.max(1, width), fontScale: scale };
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
    captionEventIndex: captionEventIndex,
    captionRevealCount: captionRevealCount,
    captionBoxHeightEm: captionBoxHeightEm,
    splitSentences: splitSentences,
    buildCaptionBlocks: buildCaptionBlocks,
    captionBlockIndex: captionBlockIndex,
    captionBlockAt: captionBlockAt,
    rgbaFromHex: rgbaFromHex,
    captionSizeScale: captionSizeScale,
    captionFontPx: captionFontPx,
    captionLineCount: captionLineCount,
    captionFitWidth: captionFitWidth,
    captionBoxWidth: captionBoxWidth,
    describePlan: describePlan,
    toastText: toastText
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
