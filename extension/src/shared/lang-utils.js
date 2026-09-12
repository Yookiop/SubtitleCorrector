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

  var CAPTION_LINE_HEIGHT = 1.4;     // line-height van de eigen overlay (CSS)
  var CAPTION_PAD_TOP_EM = 0.06;     // ruimte boven de 1e regel (.06em in de CSS)
  var CAPTION_PAD_BOTTOM_EM = 0.03;  // ruimte onder de laatste regel (.03em in de CSS);
                                     // bewust kleiner dan boven, want de regelbox heeft
                                     // onder de baseline al meer lege ruimte (descender)
  var CAPTION_PAD_X_EM = 0.32;       // horizontale padding (links/rechts, in de CSS)

  /**
   * Hoogte van het vaste captionvenster in em (1 of 2 regels + padding).
   *
   * Dit is tegelijk de hoogte waarop de overlay klipt (`overflow:hidden` in
   * page-agent.js), dus deze waarde moet exact bij de CSS-padding horen. De
   * bovenste padding is bewust kleiner dan de halve regelafstand (≈0,13em),
   * zodat een regel die het venster uit schuift gegarandeerd volledig buiten
   * het venster valt: de regelbox onder de baseline is dan al leeg.
   */
  function captionBoxHeightEm(lines) {
    var n = typeof lines === 'number' && isFinite(lines) ? Math.round(lines) : 2;
    if (n < 1) n = 1;
    if (n > 2) n = 2;
    return Math.round((n * CAPTION_LINE_HEIGHT + CAPTION_PAD_TOP_EM + CAPTION_PAD_BOTTOM_EM) * 1000) / 1000;
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
   * Woord-voor-woord (optie sinds 2026-09-12)
   *
   * Dezelfde opgevangen json3-track, maar nu woord voor woord getoond zoals
   * YouTube's auto-gegenereerde ondertitels: elk woord verschijnt op zijn
   * eigen tijd in het vaste venster van 1 of 2 regels en zodra de onderste
   * regel vol is schuift het venster één regel omhoog (regel 1 verdwijnt,
   * regel 2 wordt regel 1 en de nieuwe woorden gaan verder op de lege regel
   * 2). Een stilte zet alles terug: die begint een nieuwe "run" met een
   * leeg venster.
   * ------------------------------------------------------------------ */

  /** Woorden komen heel even vóór hun gemeten starttijd in beeld (seconden). */
  var WORD_LEAD = 0.05;

  /** Vast woordtempo (s/woord) als een segment totaal geen timing heeft. */
  var WORD_FALLBACK_STEP = 0.3;

  /* ------------------------------------------------------------------ *
   * Sprekerswissel (">>") in auto-ondertitels
   *
   * YouTube's auto-ondertitels zetten een ">>" vóór de woorden van een nieuwe
   * spreker. Zo'n wissel hoort op een nieuwe regel te beginnen; de markering
   * zelf blijft staan (die toont YouTube ook).
   * ------------------------------------------------------------------ */

  /** Begint deze tekst (of dit woord) met een sprekerswissel (">>")? */
  function isSpeakerChange(text) {
    return /^\s*>>/.test(String(text == null ? '' : text));
  }

  /**
   * Bloktekst met een regelovergang vóór elke sprekerswissel. De markering aan
   * het begin van de tekst blijft gewoon vooraan staan. De overlay gebruikt
   * `white-space:pre-wrap`, dus de `\n` is een echte regelovergang.
   */
  function captionSpeakerBreaks(text) {
    var s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (!s) return '';
    return s.replace(/\s*>>\s*/g, function (m, off) {
      return off === 0 ? '>> ' : '\n>> ';
    });
  }

  /**
   * Alle events omzetten naar losse woorden met een EIGEN tijd.
   *
   * YouTube's auto-ondertitels tonen elk woord op het moment dat het gezegd
   * wordt. Dat kan alleen als elk woord een eigen tijd heeft. De speler levert
   * die tijden niet altijd: een ASR-segment heeft vaak één `tOffsetMs` per
   * segment, en een segment bevat soms meerdere woorden (of het hele segment
   * heeft om het even welke reden dezelfde tijd). Zonder extra werk zou zo'n
   * segment dan in één keer in beeld ploppen — "ineens een halve zin".
   *
   * Daarom krijgt elk woord hier een eigen, strikt oplopende tijd:
   *   - heeft een stukje één woord, dan houden we de gemeten tijd exact;
   *   - bevat een stukje meerdere woorden, dan verdelen we ze gelijkmatig over
   *     de duur van dat stukje (start van het stukje t/m het einde), zodat ze
   *     één voor één verschijnen — precies zoals YouTube's auto-ondertitels;
   *   - heeft een stukje geen bruikbare duur, dan nemen we de afstand tot het
   *     volgende stukje, of anders een vast woordtempo.
   *
   * -> [{t, end, text}] op tijdsorde, met strikt oplopende `t`. `end` = tijd
   *    van het volgende woord binnen hetzelfde stukje (of het stukje-einde),
   *    gebruikt voor de stiltedetectie tussen runs.
   */
  function buildCaptionWords(events) {
    var chunks = captionChunks(events || []);
    var out = [];
    var prevT = -Infinity;
    for (var i = 0; i < chunks.length; i++) {
      var ch = chunks[i];
      var txt = String(ch.raw == null ? '' : ch.raw).replace(/\s+/g, ' ').trim();
      if (!txt) continue;
      var parts = [];
      var rawParts = txt.split(' ');
      for (var r = 0; r < rawParts.length; r++) {
        if (rawParts[r]) parts.push(rawParts[r]);
      }
      var k = parts.length;
      if (!k) continue;

      var start = typeof ch.t === 'number' && isFinite(ch.t) ? ch.t : 0;
      var end = typeof ch.end === 'number' && isFinite(ch.end) ? ch.end : start;
      if (!(end > start)) {
        // Geen bruikbare duur. Neem de afstand tot het volgende stukje (dat is
        // het moment waarop de volgende klank begint), anders een vast tempo.
        var next = chunks[i + 1];
        var nextT = next && typeof next.t === 'number' && isFinite(next.t) ? next.t : Infinity;
        end = nextT > start ? nextT : start + k * WORD_FALLBACK_STEP;
      }
      var span = end - start;
      var base = out.length;
      for (var p = 0; p < k; p++) {
        var wt = k === 1 ? start : start + span * (p / k);
        if (!(wt > prevT)) wt = prevT + 0.001; // nooit terug in de tijd
        out.push({ t: wt, end: 0, text: parts[p] });
      }
      // Einde per woord: binnen het stukje de tijd van het volgende woord,
      // voor het laatste woord het einde van het stukje.
      for (var q = 0; q < k; q++) {
        var w = out[base + q];
        w.end = q + 1 < k ? out[base + q + 1].t : Math.max(end, w.t);
        if (!(w.end > w.t)) w.end = w.t;
      }
      prevT = out[out.length - 1].t;
    }
    return out;
  }

  /**
   * Woorden groeperen in "runs": een run is doorlopende spraak. Een stilte
   * groter dan `silenceGap` (default 1,6 s — dezelfde grens als bij de
   * blokken) sluit de run af; binnen een run blijft het venster staan en rolt
   * het door, na een stilte begint het venster weer leeg.
   *
   * -> [{start, end, words:[{t,end,text}]}]
   */
  function buildCaptionRuns(words, silenceGap) {
    var gap = typeof silenceGap === 'number' && isFinite(silenceGap) && silenceGap >= 0 ? silenceGap : 1.6;
    var runs = [];
    var cur = null;
    var list = words || [];
    for (var i = 0; i < list.length; i++) {
      var w = list[i];
      if (!w || !w.text) continue;
      var t = typeof w.t === 'number' && isFinite(w.t) ? w.t : 0;
      var end = typeof w.end === 'number' && isFinite(w.end) && w.end > t ? w.end : t;
      if (cur && t - cur.end > gap) cur = null;
      if (!cur) {
        cur = { start: t, end: end, words: [] };
        runs.push(cur);
      } else if (end > cur.end) {
        cur.end = end;
      }
      cur.words.push(w);
    }
    return runs;
  }

  /**
   * Actieve run op tijd `t`: de laatste run die begonnen is, zolang `t` binnen
   * de run + `linger` valt (-1 = niets tonen: stilte of nog niets gezegd).
   */
  function captionRunAt(runs, t, linger) {
    if (!runs || !runs.length) return -1;
    var lo = 0;
    var hi = runs.length - 1;
    var ans = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (runs[mid].start <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (ans < 0) return -1;
    var lg = typeof linger === 'number' && isFinite(linger) && linger >= 0 ? linger : 0.45;
    return t <= runs[ans].end + lg ? ans : -1;
  }

  /**
   * Hoeveel woorden van deze run zijn op tijd `t` (seconden) gezegd? Woorden
   * met dezelfde tijd (segment zonder per-woordoffsets) komen samen in beeld.
   * `lead` (default 0,05 s) laat een woord heel even vóór zijn starttijd
   * verschijnen, zodat het niet ná de klank komt.
   */
  function captionWordIndex(words, t, lead) {
    if (!words || !words.length) return 0;
    var ld = typeof lead === 'number' && isFinite(lead) ? lead : WORD_LEAD;
    var tt = (typeof t === 'number' && isFinite(t) ? t : 0) + ld;
    var n = 0;
    for (var i = 0; i < words.length; i++) {
      if (words[i].t <= tt) n++;
      else break;
    }
    return n;
  }

  /**
   * Verschuiving (px) van het rollende venster: alles boven de laatste
   * `visibleLines` regels schuift omhoog, in stapjes van hele regels (nooit
   * een halve regel). `totalPx` = hoogte van alle gezette tekst,
   * `lineHeightPx` = één regel (uit de CSS). Past alles binnen het venster,
   * dan 0.
   */
  function captionWindowShift(totalPx, lineHeightPx, visibleLines) {
    var total = typeof totalPx === 'number' && isFinite(totalPx) && totalPx > 0 ? totalPx : 0;
    var lh = typeof lineHeightPx === 'number' && isFinite(lineHeightPx) && lineHeightPx > 0 ? lineHeightPx : 0;
    var vis = typeof visibleLines === 'number' && isFinite(visibleLines) ? Math.round(visibleLines) : 2;
    if (vis < 1) vis = 1;
    if (!total || !lh) return 0;
    var lines = Math.round(total / lh);
    if (lines <= vis) return 0;
    return Math.round((lines - vis) * lh * 100) / 100;
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

  /** Standaardafstand van de captionbalk tot de onderrand (% van de spelerhoogte). */
  var CAPTION_BOTTOM_BASE = 10.5;

  /**
   * Effectieve afstand van de captionbalk tot de onderrand (% van de
   * spelerhoogte) na de y-offset uit de opties. `offset` is in %-punten:
   * positief schuift de ondertitels **omlaag** (dichter bij de onderrand),
   * negatief **omhoog**. Geclamped op 0-80%, zodat de balk in de speler blijft.
   */
  function captionBottomPct(offset, base) {
    var b = typeof base === 'number' && isFinite(base) ? base : CAPTION_BOTTOM_BASE;
    var o = typeof offset === 'number' && isFinite(offset) ? Math.max(-80, Math.min(80, offset)) : 0;
    return Math.round(Math.max(0, Math.min(80, b - o)) * 100) / 100;
  }

  /* ------------------------------------------------------------------ *
   * Lettertype, dikte en balkbreedte van de eigen overlay (opties)
   * ------------------------------------------------------------------ */

  /**
   * Beschikbare lettertypes voor de eigen ondertitelweergave.
   *
   * `youtube` is YouTube's eigen "proportionele sans-serif" (het font waarin de
   * speler zijn auto-ondertitels tekent, en de standaard van de extensie). De
   * rest zijn fonts die juist bij leesteksten veel gebruikt worden: eerst de
   * sans-serif-achtigen (Arial, Verdana, Segoe UI, Tahoma) en daarna de
   * serif-leesfonts (Cambria, Georgia, Times New Roman, Palatino). Elke stack
   * eindigt op een generieke familie, zodat er ook zonder het font iets
   * leesbaars staat.
   */
  var CAPTION_FONTS = [
    { key: 'youtube', label: "Proportionele sans-serif (YouTube's eigen)", stack: '"YouTube Sans","Roboto",Arial,sans-serif' },
    { key: 'arial', label: 'Arial', stack: 'Arial,Helvetica,sans-serif' },
    { key: 'verdana', label: 'Verdana', stack: 'Verdana,Geneva,sans-serif' },
    { key: 'segoe', label: 'Segoe UI', stack: '"Segoe UI",Tahoma,sans-serif' },
    { key: 'tahoma', label: 'Tahoma', stack: 'Tahoma,Verdana,sans-serif' },
    { key: 'cambria', label: 'Cambria', stack: 'Cambria,Georgia,serif' },
    { key: 'georgia', label: 'Georgia', stack: 'Georgia,"Times New Roman",serif' },
    { key: 'times', label: 'Times New Roman', stack: '"Times New Roman",Times,serif' },
    { key: 'palatino', label: 'Palatino', stack: '"Palatino Linotype","Book Antiqua",Palatino,serif' },
    { key: 'mono', label: 'Monospaced (Consolas / Roboto Mono)', stack: '"Roboto Mono",Consolas,"Courier New",monospace' },
    { key: 'casual', label: 'Casual (Comic Sans MS)', stack: '"Comic Sans MS","Comic Sans",cursive' }
  ];

  /** Geldige lettertype-sleutel; onbekend of leeg wordt YouTube's eigen font. */
  function captionFontKey(value) {
    var k = String(value == null ? '' : value).trim();
    for (var i = 0; i < CAPTION_FONTS.length; i++) {
      if (CAPTION_FONTS[i].key === k) return k;
    }
    return CAPTION_FONTS[0].key;
  }

  /** CSS font-family-stack voor een lettertype-sleutel. */
  function captionFontStack(value) {
    var key = captionFontKey(value);
    for (var i = 0; i < CAPTION_FONTS.length; i++) {
      if (CAPTION_FONTS[i].key === key) return CAPTION_FONTS[i].stack;
    }
    return CAPTION_FONTS[0].stack;
  }

  /** Toegestane letterdiktes (400 = normaal, 600 = de oude standaard, 700 = vet). */
  var CAPTION_WEIGHTS = [400, 500, 600, 700];

  /** Geldige letterdikte; onbekend wordt 600 (zoals de extensie altijd tekende). */
  function captionFontWeight(value) {
    var v = Number(value);
    for (var i = 0; i < CAPTION_WEIGHTS.length; i++) {
      if (CAPTION_WEIGHTS[i] === v) return v;
    }
    return 600;
  }

  /**
   * Breedte van de ondertitelbalk in % van de spelerbreedte. De balk staat
   * gecentreerd (links en rechts evenveel video zichtbaar), dus hoe kleiner
   * deze waarde, hoe smaller de balk. Geclamped op 30-100%; ontbrekend = 80.
   */
  function captionBarWidthPct(pct) {
    var p = typeof pct === 'number' && isFinite(pct) ? pct : 80;
    return Math.round(Math.max(30, Math.min(100, p)) * 10) / 10;
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
    CAPTION_LINE_HEIGHT: CAPTION_LINE_HEIGHT,
    CAPTION_PAD_TOP_EM: CAPTION_PAD_TOP_EM,
    CAPTION_PAD_BOTTOM_EM: CAPTION_PAD_BOTTOM_EM,
    CAPTION_PAD_X_EM: CAPTION_PAD_X_EM,
    splitSentences: splitSentences,
    buildCaptionBlocks: buildCaptionBlocks,
    captionBlockIndex: captionBlockIndex,
    captionBlockAt: captionBlockAt,
    buildCaptionWords: buildCaptionWords,
    buildCaptionRuns: buildCaptionRuns,
    captionRunAt: captionRunAt,
    captionWordIndex: captionWordIndex,
    captionWindowShift: captionWindowShift,
    isSpeakerChange: isSpeakerChange,
    captionSpeakerBreaks: captionSpeakerBreaks,
    rgbaFromHex: rgbaFromHex,
    captionSizeScale: captionSizeScale,
    captionFontPx: captionFontPx,
    captionBottomPct: captionBottomPct,
    CAPTION_BOTTOM_BASE: CAPTION_BOTTOM_BASE,
    CAPTION_FONTS: CAPTION_FONTS,
    captionFontKey: captionFontKey,
    captionFontStack: captionFontStack,
    CAPTION_WEIGHTS: CAPTION_WEIGHTS,
    captionFontWeight: captionFontWeight,
    captionBarWidthPct: captionBarWidthPct,
    captionLineCount: captionLineCount,
    captionFitWidth: captionFitWidth,
    captionBoxWidth: captionBoxWidth,
    describePlan: describePlan,
    toastText: toastText
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
