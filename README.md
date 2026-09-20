# Subtitle Corrector

Zet YouTube-ondertitels automatisch in de **taal van de audio** (Engels of Nederlands) en schakelt **automatische vertaling** uit.

> **Waarom:** YouTube onthoudt je laatst gebruikte ondertitelkeuze en past die toe op de volgende video. Kijk je Engels en Nederlands door elkaar, dan vertaalt YouTube je ondertitels de verkeerde kant op (Engelse video → Nederlandse ondertitels, Nederlandse video → Engelse ondertitels). Deze extensie zet per video de juiste track: de **auto-gegenereerde** ondertitel van de gesproken taal (prioriteit 1), of anders de **handmatige** (prioriteit 2).

* **Lokaal**: losse extensie (unpacked), geen webstore, geen account, geen cloud.
* **Automatisch** bij elke nieuwe video, plus handmatig met de hotkey <kbd>]</kbd> (hotkey staat standaard uit; aanzetten of de hotkey-modus kiezen: zie §2).
* **Alleen EN/NL** — andere talen worden met rust gelaten.
* **Spaarzaam met CPU/GPU (caption-prioriteit)**: in playlists draait de zware audio-analyse alleen via de hotkey, er wordt nooit opgenomen als de bridge niet klaar is, en de extensie pollt langzamer op de achtergrond. Zo houdt YouTube ruimte over voor het tekenen van de ondertitels (zie §5.1).
* **Caption Boost (eigen ondertitelweergave)**: tekent de ondertitel zelf, in plaats van YouTube's venster. Standaard **woord voor woord** (optie Word-for-Word); zet die uit voor blokken van **2 volle zinnen** in één keer. De blokgrens ligt exact op het 2e zinseinde — ook als dat midden in een YouTube-cue valt, want de rest van die cue gaat naar het volgende blok. Zo blijft elke zin bij elkaar en komt er geen halfgevuld blok meer waarin de rest van de zin pas later in een nieuw blok verschijnt. Dit lost het "loopt 1-2 s achter en plopt dan in blokken"-probleem op, ook als dat zonder de extensie gebeurt (zie §5.1).
* **Word-for-Word (optie, standaard aan)**: liever woord voor woord, zoals YouTube's auto-gegenereerde ondertitels? Dat is de standaard: elk woord verschijnt op zijn eigen tijd en het venster van 2 regels rolt per regel omhoog (regel 1 verdwijnt, regel 2 wordt regel 1, verder op de nieuwe regel 2). Ook als een cue geen per-woordtijden heeft (één tijd voor een hele zin) verschijnen de woorden één voor één — de tijd wordt dan over de cue verdeeld, zodat er nooit ineens een halve zin in beeld plopt. Zet de optie uit voor hele blokken van 2 volle zinnen.
* **Sprekerswissel (`>>`)**: geeft YouTube een nieuwe spreker aan met `>>`, dan begint die op een **nieuwe regel** (in beide weergaven). De markering zelf blijft staan, zoals bij YouTube.
* **Zwarte achtergrond per woord**: het zwart zit niet als één balk achter het hele venster, maar op **elk woord apart** — een woord komt binnen met zijn eigen zwarte blokje (de blokjes van een regel groeien aan elkaar vast), net als bij YouTube's auto-ondertitels. Zo staat er nooit zwart waar nog geen tekst is. De blokjes zijn altijd **dekkend** (de kleur volgt je YouTube-instellingen, de doorschijnendheid niet), zodat het zwart effen blijft waar blokjes en regels elkaar overlappen.
* **Positie**: met **Y-offset** schuif je de ondertiteling in de opties omhoog of omlaag (−40 tot +30 procentpunten van de spelerhoogte; standaard 9, dus iets hoger dan het uitgangspunt) en met **X-offset** naar links of rechts (−40 tot +40; standaard −9, dus iets links van het midden).
* **Lettertype & breedte**: kies in de opties het font (YouTube's eigen proportionele sans-serif = **Roboto**, of leesfonts als Arial, Verdana, Segoe UI, Cambria, Georgia, Times New Roman en Palatino), de **letterdikte** (300-700 in stappen van 25; standaard 400) en de **breedte van het tekstvlak** (30-100%, standaard 50%). Voor precies YouTube's caption-look: font *Proportionele sans-serif*, dikte *400* en grootte *100%.
* Volledige spec: [`SUBTITLE_CORRECTOR_PROMPT.md`](SUBTITLE_CORRECTOR_PROMPT.md)

---

## 1. Extensie installeren (eenmalig, ~1 minuut)

1. Open in Brave (of Chrome/Edge): `brave://extensions` resp. `chrome://extensions`.
2. Zet **Developer mode** aan (rechtsboven).
3. Klik **Load unpacked** en kies de map **`extension/`** van deze repo.
4. Klaar. Het icoon staat in de werkbalk; de badge toont de laatst gezette taal (`EN`, `NL`, of `EN*` als de handmatige track is gebruikt).

> De extensie blijft werken zolang deze map blijft staan. Verplaats of verwijder je de repo, laad hem dan opnieuw.

## 2. Gebruiken

* **Automatisch**: open je een YouTube-video, dan gaat het vanzelf goed (binnen ~2 seconden).
* **Handmatig**: druk op <kbd>]</kbd> terwijl het YouTube-tabblad focus heeft om de ondertiteling van dít tabblad aan/uit te zetten. De hotkey staat **standaard uit** (optie **Hotkey actief**).
* **Hotkey aan/uit** (optie **Hotkey actief**, default uit): aan = de hotkey is de aan/uit-schakelaar van dit tabblad. De eerste keer drukken zet de ondertiteling volledig uit (captions uit, Caption Boost uit, geen bridge/audio-analyse, ook als YouTube ze daarna opnieuw aanzet); nog een keer drukken zet alles weer aan en past de correctie toe. Uit = de toets doet helemaal niets (geen correctie, geen toast) en gaat gewoon naar de pagina; een leeg hotkey-veld betekent hetzelfde. Wil je alleen een keer geforceerd corrigeren, gebruik dan **Nu toepassen** in de popup.
* **Uitzetten per tabblad**: links naast het tandwiel in de speler staat een **CC-knopje**; één klik zet de ondertiteling van dít tabblad volledig uit (captions uit, Caption Boost uit én geen bridge/audio-analyse — ook als YouTube ze daarna opnieuw aanzet). Nog een klik (of de hotkey <kbd>]</kbd>) zet alles weer aan; in de uit-stand zie je een **rode streep** door het icoon en staat `off` op de badge.
* **Popup** (klik op het icoon): toont de gedetecteerde audiotaal + bron, de huidige ondertitel, wat de extensie zou doen, en of de bridge online is. Met **Nu toepassen** forceer je een correctie.
* **Toast**: linksonder in de video zie je kort wat er gebeurd is (uit te zetten in de opties).

## 3. Opties

Rechtermuisknop op het icoon → **Options** (of via de popup → Instellingen). Belangrijkste:

| Optie | Default | Betekenis |
|-------|---------|-----------|
| Hotkey | `]` | Ook `ctrl+]` etc. mogelijk. Leeg (`<empty>`) = hotkey uit |
| Hotkey actief | **uit** | Aan = de hotkey is de aan/uit-schakelaar van dit tabblad: 1e keer drukken = alles uit (captions, Caption Boost, bridge), nog een keer = weer aan + de correctie. Uit (standaard) = de hotkey doet helemaal niets: geen correctie, geen toast, en de toets gaat gewoon naar de pagina |
| Automatisch bij elke nieuwe video | aan | Uitzetten = alleen handmatig met de hotkey |
| Auto-gegenereerd boven handmatig | aan | Prioriteit 1 = auto, 2 = handmatig |
| Ondertitels aanzetten als ze uit staan | aan | Want YouTube activeert ze niet altijd |
| Als ik ze zelf uitzet, niet opnieuw aanzetten | aan | Per video onthouden |
| Vertaling herstellen als YouTube hem opnieuw aanzet | aan | Met cooldown |
| Bridge gebruiken als metadata onduidelijk is | aan | Zie §4 |
| Eigen ondertitelweergave (Caption Boost) | aan | Tekent de ondertitel zelf (standaard woord voor woord; zie Word-for-Word), met een **eigen zwarte achtergrond per woord** in plaats van één balk achter het hele venster, en verbergt YouTube's eigen caption-venster zolang dat lukt |
| Word-for-Word | **aan** | Woord voor woord, zoals YouTube's auto-gegenereerde ondertitels: elk woord op zijn eigen tijd in het vaste venster; zodra de onderste regel vol is schuift het venster één regel omhoog (regel 1 eruit, verder op de nieuwe regel 2). Een stilte begint met een leeg venster. Ook een cue zonder per-woordtijden (één tijd voor de hele zin) wordt woord voor woord getoond: de woorden worden dan gelijkmatig over de cue verdeeld. **Uit** = hele blokken van 2 volle zinnen in één keer |
| Ondertitelgrootte (Caption Boost) | 130% | 50 - 250%. **100% = precies zo groot als YouTube's eigen ondertitels**; 130% is onze standaard. Stijl (kleur/achtergrond en de grove "Font size"-stand) volgt automatisch je YouTube-ondertitelinstellingen |
| Lettertype (Caption Boost) | Proportionele sans-serif (YouTube's eigen: Roboto) | Het font van de eigen weergave: YouTube's eigen caption-font (**Roboto**, het font van de ondertitels die je zonder deze extensie ziet — niet YouTube Sans, dat is het rondere merkfont van de site), daaronder Arial, Verdana, Segoe UI, Tahoma (sans) en Cambria, Georgia, Times New Roman, Palatino (serif-leesfonts), plus Monospaced en Casual. Elke stack heeft een generieke fallback |
| Letterdikte (Caption Boost) | 400 (normaal) | De dikte van de letters: **300 t/m 700 in stappen van 25** (dus ook 325, 350, 375, …). 400 = normaal (onze standaard, en de dikte waarin YouTube zijn eigen ondertitels tekent), 300 = licht, 700 = vet. De fijnere stappen werken op variable fonts zoals Roboto; bij een gewoon font pakt de browser de dichtstbijzijnde beschikbare dikte |
| Ondertitelbreedte (Caption Boost) | 50% | Breedte van het tekstvlak als percentage van de spelerbreedte (30 - 100%). Het vlak staat gecentreerd, dus je houdt links en rechts altijd video zichtbaar. De zwarte achtergrond zelf is per woord en dus zo breed als de tekst; deze instelling bepaalt hoe breed de tekst mag worden voordat hij afbreekt. Lager = smaller |
| Ondertitelregels (Caption Boost) | 2 regels | Hoogte van het vaste captionblok in regels (1 of 2). Het blok is altijd precies zo hoog — ook met maar één zin: regel 1 linksboven, regel 2 leeg. Past een blok van 2 zinnen niet helemaal, dan wordt de tekst onderaan afgekapt. Het font krimpt nooit |
| Y-offset (Caption Boost) | 9% | Verticale positie van de ondertiteling in procentpunten van de spelerhoogte: positief = omlaag, negatief = omhoog (bereik −40 tot +30). De ondertiteling blijft altijd binnen de speler |
| X-offset (Caption Boost) | −9% | Horizontale positie van de ondertiteling in procentpunten van de spelerbreedte: positief = naar rechts, negatief = naar links (bereik −40 tot +40). 0 = gecentreerd |
| Caption-prioriteit | aan | Playlists soepel houden: langere wachttijd bij videostart, geen zware audio-analyse zonder hotkey, rustiger pollen op de achtergrond |
| Audio-analyse ook automatisch in playlists | uit | Aanzetten = ook in playlists automatisch opnemen (kost meer CPU/GPU) |
| Bridge-URL | `http://127.0.0.1:8791` | Alleen nodig als je een andere poort gebruikt |

## 4. Bridge (optioneel, voor audio-analyse)

De extensie redt het in de praktijk met metadata: de audiotrack vertelt de taal, en anders doet de ASR-track dat. Alleen als dat allebei onduidelijk of tegenstrijdig is, wordt er **naar de audio geluisterd**. Dat doet een klein lokaal Python-programma (Whisper op CPU).

> Met **Caption-prioriteit** (default aan) gebeurt dat in **playlists alleen via de hotkey**: een playlist wisselt snel van video en Whisper kost veel CPU/GPU, precies op het moment dat YouTube de ondertitels moet opbouwen (§5.1). Er wordt ook nooit opgenomen als de bridge offline is of het model nog laadt, en maximaal één automatische opname per 45 seconden.

Eenmalig installeren:

```powershell
powershell -ExecutionPolicy Bypass -File bridge\setup.ps1
```

> De `-ExecutionPolicy Bypass` is nodig omdat Windows standaard geen PowerShell-scripts toestaat.

Starten:

```text
bridge\run_bridge.bat
```

Automatisch starten bij inloggen (optioneel, zonder consolevenster):

```powershell
powershell -ExecutionPolicy Bypass -File bridge\install_autostart.ps1
```

Testen:

```powershell
python tools\bridge-smoke-test.py
```

Wat de bridge doet bij een detectie: 5 seconden tab-audio opnemen → 16 kHz mono → Whisper → `{"language":"nl","confidence":0.93,…}`. Er wordt niets opgeslagen; de bridge luistert alleen op `127.0.0.1`.

**Opties van de bridge**

```text
python bridge_server.py --model tiny        # sneller, iets minder nauwkeurig (default: base)
python bridge_server.py --port 8792         # andere poort (zet dan ook de Bridge-URL in de opties)
python bridge_server.py --backend whisper   # openai-whisper in plaats van faster-whisper
python bridge_server.py --verbose           # laat transcripten zien in de console
python bridge_server.py --warmup            # model vast downloaden en stoppen
```

## 5. Hoe het werkt (kort)

1. Een script in de pagina (`page-agent.js`) leest de player uit: **audiotaal** (`getAudioTrack().s1`), de **huidige ondertitel** (`getOption('captions','track')`) en alle beschikbare tracks.
2. De gekozen track = **auto-gegenereerd van de audiotaal**, anders de handmatige.
3. Zetten gebeurt via de player-API voor handmatige tracks, en via het **settings-menu** voor auto-gegenereerde tracks (de API kan die niet kiezen — geverifieerd).
4. Een actieve **auto-vertaling** (`translationLanguage`) wordt gewist door de bron-track opnieuw te kiezen.
5. Alles wat puur is (taalnormalisatie, keuze, planning) staat in `extension/src/shared/lang-utils.js` en is getest.

### 5.1 Playlists soepel houden (caption-prioriteit)

Een extensie kan YouTube's caption-renderer geen extra CPU geven — wat wél kan is zelf zo weinig mogelijk beslag leggen op CPU/GPU op de momenten dat de speler het drukst is. Met **Caption-prioriteit** (default aan):

* draait de zware audio-analyse (tab-capture + Whisper) **in playlists alleen via de hotkey**;
* wordt er **nooit** opgenomen als de bridge offline is of het model nog laadt;
* duurt het minstens 45 s voordat er automatisch opnieuw wordt opgenomen;
* wacht de extensie in playlists langer met corrigeren (±4 s na de videostart) en tussen retries;
* pollt de page agent langzamer (2,6 s) als het tabblad niet zichtbaar is;
* maakt het offscreen document geen echte audio-uitvoer als "Geluid hoorbaar houden" uit staat.

Daarnaast tekent **Caption Boost** (default aan) de ondertitels zelf:

* de timedtext-track die de speler zelf ophaalt (json3, met per-woord `tOffsetMs` bij auto-gegenereerde tracks) wordt passief uit de XHR gelezen — een eigen fetch kan niet, want YouTube's timedtext vereist een `pot`-token (zonder token: HTTP 200 met een lege body);
* de tekst wordt in **blokken van 2 volle zinnen** getoond (`L.buildCaptionBlocks`): de cue's worden vooraf gegroepeerd, de grens ligt exact op het 2e zinseinde — ook midden in een cue; de rest van die cue gaat naar het volgende blok. Vijf zinnen op rij geven dus blokken van 2 + 2 + 1. Een stilte (meer dan ±1,6 s) sluit een blok af, ook met maar één zin erin; tracks zonder punctuatie vallen terug op een tekenlimiet;
* een blok komt in **één keer** in beeld, van het eerste tot het laatste woord, en blijft staan tot het volgende blok begint — geen halfgevulde blokken en geen losse zinsdelen meer. (Liever woord voor woord zoals YouTube's auto-ondertitels? Zet de optie **Word-for-Word** aan, zie hieronder.);
* de **stijl** komt uit YouTube's eigen captioninstellingen (`getSubtitlesUserSettings`: tekstkleur + opacity, achtergrondkleur en `fontSizeIncrement`), dus wit-op-zwart of welke stijl je daar ook hebt gekozen wordt automatisch nagebouwd. Alleen de **opacity van de achtergrond** wordt genegeerd: die is altijd **dekkend** (zie de volgende punten);
* met de optie **Word-for-Word** (standaard aan) komt elk woord apart in beeld, net als bij YouTube's auto-ondertitels: dezelfde vaste box, maar het venster schuift door — zodra de onderste regel vol is glijdt de tekst met een korte **slide-up** (200 ms) één regel omhoog, regel 1 verdwijnt, regel 2 wordt regel 1 en de nieuwe woorden gaan verder op de lege regel 2. Die beweging gaat met `top` op de tekstwrapper (geen `transform`: dat zet de tekst op een eigen compositing-laag en dan kan hij tijdens het schuiven buiten het zwarte blok getekend worden) en de box heeft naast `overflow:hidden` ook `clip-path:inset(0)`, zodat er nooit tekst buiten het blok valt. De verschuiving en de hoogte van het venster komen uit een **meting van de echte regels** (`L.captionLineMetrics()`: het aantal regels en de afstand ertussen, uit de woordblokjes; `L.captionWindowShiftLines()` zet de tekst in hele regels omhoog en `L.captionBoxHeightEmForAdvance()` maakt het venster precies zo hoog als het aantal regels). In de normale situatie is dat identiek aan rekenen met de line-height van de wrapper; staat er (door de pagina of een andere extensie) een andere `line-height` op de woordblokjes, dan klopt de verschuiving nu tóch en blijven de letters heel (bugmelding 2026-09-18: vóór de fix kroop de bovenste regel dan uit het venster en werden de letters bovenaan afgekapt — zie rij 25 van de samenvatting in `SUBTITLE_CORRECTOR_PROMPT.md` en `tools/check-caption-window.html`). De regelafstand en de fontgrootte van de wrapper en de woordblokjes worden daarom ook expliciet vastgezet in onze eigen CSS (`line-height:1.4!important;font-size:1em!important`), zodat de pagina onze maatvoering niet kan verzetten. `L.buildCaptionWords()` geeft **elk** woord een eigen, strikt oplopende tijd: bij een cue met per-woordtijden (`tOffsetMs`) exact zoals gemeten, en bij een cue zonder per-woordtijden (één tijd voor de hele zin) worden de woorden gelijkmatig over de cue verdeeld. Daardoor verschijnt er nooit ineens een hele zin: de woorden komen altijd één voor één. Een stilte (> ±1,6 s, `L.buildCaptionRuns()`) begint met een leeg venster; binnen doorlopende spraak blijft het venster staan;
* het blok staat in een **vast venster van 1 of 2 regels** (*Ondertitelregels*, standaard 2), **linksboven uitgelijnd**: de tekst begint links en gebruikt de volle breedte van het tekstvlak (*Ondertitelbreedte*, standaard 50% van de spelerbreedte en gecentreerd, dus links en rechts blijft de video zichtbaar). De box is een block (geen inline-block) met een vaste hoogte (`L.captionBoxHeightEm()` = `regels × 1,4 + 0,06 + 0,03` em; wijkt de gemeten regelafstand af, dan gebruikt de page agent `L.captionBoxHeightEmForAdvance()` met die meting), zodat het venster altijd precies even hoog is, ook als een blok maar één zin heeft (regel 2 blijft dan leeg); past een blok van 2 zinnen niet helemaal, dan wordt het onderaan afgekapt. Het font krimpt **nooit** en er schuift niets op; YouTube's eigen regelovergangen worden als spatie behandeld;
* de **achtergrond zit op elk woord apart** (`.sc-caption-word`), niet meer op één balk achter het hele venster: een woord komt binnen mét zijn eigen zwarte blokje en de blokjes van een regel groeien aan elkaar vast, net als bij YouTube's auto-ondertitels. De kleur komt uit YouTube's captioninstellingen en gaat via de CSS-variabele `--sc-caption-bg` naar alle blokjes (dus ook naar blokjes die al in beeld staan). De spatie achter een woord zit ín zijn blokje, zodat er tussen twee woorden nooit een kier in het zwart valt; de horizontale padding (`.28em`) wordt door een even grote negatieve marge gecompenseerd, zodat de woordafstand en de regelafbreking exact gelijk blijven aan voorheen — de tekst staat dus precies waar hij stond, maar het zwart steekt aan het begin en het eind van elke regel een paar millimeter (~3 mm bij de standaardgrootte) verder door dan de letters. De verticale padding valt bij een inline-element buiten de regelbox, waardoor de blokjes van twee regels elkaar raken en er geen streep video tussen de regels blijft staan. Beide maten staan als `L.CAPTION_WORD_PAD_Y_EM` / `L.CAPTION_WORD_PAD_X_EM` in lang-utils (met de invariant dat de horizontale maat ≤ de box-padding is, anders knipt `overflow:hidden` het zwart af), zodat de checkpagina met dezelfde waarden werkt. De achtergrond is **altijd dekkend**: de *kleur* komt uit YouTube's captioninstellingen, maar de opacity daarvan wordt genegeerd. Dat moet wel, want de blokjes **overlappen** elkaar bewust (de buren op een regel en de twee regels onder elkaar) en twee halfdoorzichtige lagen over elkaar worden donkerder (0,75 over 0,75 is samen 0,9375) — op een heldere video zag je daardoor per woord en per regel een andere griestint met een donkere band tussen de regels, in plaats van effen zwart (bugmelding 2026-09-20, zie rij 27 van de samenvatting in `SUBTITLE_CORRECTOR_PROMPT.md`). `tools/check-syntax.html` controleert op bronniveau dat `backgroundOpacity` niet meer gebruikt wordt en dat zowel de berekening als de CSS-terugval dekkend zijn;
* de tekst staat **optisch midden in het zwart**: het venster wordt niet om de *regelbox* gebouwd maar om de **inkt** van de letters (`L.captionVerticalLayout()`). De hoogte is de inkt van de zichtbare regels plus twee keer de marge, die marge is 30% van de regelafstand (minimaal 0,2em) en de woordblokjes krijgen via de CSS-variabelen `--sc-word-pad-top` / `--sc-word-pad-bottom` net zoveel verticale padding dat het zwart tot de rand van het venster doorloopt. Zo blijft er boven én onder evenveel zwart over in plaats van dat de letters tegen de (boven)rand plakken — een font reserveert in zijn fontvak nu eenmaal meer ruimte bóven de letters (ascender) dan eronder (descender). De maten komen uit een canvasmeting van het gebruikte font (`boostInkMetrics()`, o.a. `actualBoundingBoxAscent`/`Descent`); zonder die meting valt de layout terug op de vaste em-hoogte en de vaste padding van vroeger;
* een **sprekerswissel** (`>>`) begint op een **nieuwe regel** (`L.isSpeakerChange()` / `L.captionSpeakerBreaks()`): in de blokweergave via een `\n` (de overlay gebruikt `white-space:pre-wrap`), in de woord-voor-woord-weergave via een `<br>` vóór het `>>`-woord. De hangende spatie van het vorige woord wordt weggehaald, zodat de nieuwe regel niet inspringt; staat het venster nog leeg, dan komt er geen lege regel boven;
* de **positie** stel je in met *Y-offset* (standaard **9**, bereik −40 tot +30): `L.captionBottomPct()` rekent dat om naar de afstand tot de onderrand (basis 10,5% van de spelerhoogte; positief = omlaag) en clamped op 0-80%, zodat de ondertiteling in de speler blijft (standaard 9 → `bottom: 1,5%`); met *X-offset* (standaard **−9**, bereik −40 tot +40) schuift ze horizontaal: `L.captionSidePcts()` zet `left` en `right` op de overlay (positief = naar rechts), en die twee gaan even hard de andere kant op, zodat de breedte gelijk blijft;
* de **grootte** stel je zelf in met *Ondertitelgrootte* (50 - 250%; standaard **130%**). **100% is precies zo groot als YouTube's eigen ondertitels** — wil je die look, zet hem dan op 100 (de optielijst stelt 75/100/125/150/175/200 voor);
* het **lettertype** kies je met *Lettertype*: YouTube's eigen "proportionele sans-serif" — dat is **Roboto**, het font waarin de speler zijn auto-ondertitels tekent (en onze standaard; YouTube Sans, het ronde merkfont van de site, staat er bewust niet meer in — dat viel zichtbaar uit de toon) — plus veelgebruikte leesfonts — Arial, Verdana, Segoe UI, Tahoma, Cambria, Georgia, Times New Roman en Palatino, met daarnaast Monospaced en Casual. De lijst en de CSS-stacks staan in één bron (`L.CAPTION_FONTS` / `L.captionFontStack()`), dus de optiepagina en het testgereedschap gebruiken automatisch dezelfde lijst. Met *Letterdikte* kies je 300 t/m 700 in stappen van 25 (standaard **400** = normaal, zoals YouTube's eigen ondertitels);
* de **breedte** van het tekstvlak stel je in met *Ondertitelbreedte* (standaard **50%**, bereik 30 - 100%): `L.captionBarWidthPct()` rekent dat om en de box krijgt die breedte, gecentreerd in de overlay — zo houd je links en rechts altijd video zichtbaar. De zwarte blokjes zelf zijn zo breed als de tekst; deze instelling bepaalt waar de tekst afbreekt. Lager = smaller (let op: in een smaller vlak wordt een blok van 2 zinnen eerder onderaan afgekapt; met Word-for-Word speelt dat niet);
* zolang dat lukt blijft YouTube's eigen caption-venster verborgen; bij advertenties, een actieve vertaling, een ontbrekende track of een videowissel gaat alles direct terug naar YouTube's eigen weergave.

Meer automatiek nodig voor video's zonder metadata? Zet in de opties **"Audio-analyse ook automatisch in playlists"** aan (kost meer CPU/GPU).

## 6. Testen

```text
dubbelklik tools\test-lang-utils.html     # 62 tests van de pure logica, geen Node nodig
node tools\test-lang-utils.mjs            # zelfde tests (als Node geïnstalleerd is)
dubbelklik tools\check-caption-lines.html # blokken van 2 zinnen, het rollende woord-voor-woord-venster (ook zonder per-woordtijden en met sprekerswissels) en de Y-offset, met regels en vulling per blok/run
dubbelklik tools\check-caption-window.html # het rollende venster: blijft de bovenste regel heel? (ook als de pagina de woordblokjes een andere line-height geeft)
python tools\bridge-smoke-test.py         # bridge end-to-end
powershell -ExecutionPolicy Bypass -File tools\make_tts_fixtures.ps1   # EN/NL spraak-WAV's maken
```

Syntax- en manifestcheck (nalopen na het aanpassen van bestanden; 16 controles, inclusief de dekkende ondertitelachtergrond):

```text
python -m http.server 8099     ->  http://localhost:8099/tools/check-syntax.html
```

## 7. Problemen oplossen

| Symptoom | Oplossing |
|----------|-----------|
| Er gebeurt niets bij `]` | Staat in de opties **Hotkey actief** aan (staat standaard uit) en staat er een toets in het hotkey-veld? Heeft het YouTube-tabblad focus? Staat de extensie aan? Ververs het tabblad na het (her)laden van de extensie. |
| De hotkey doet nog iets terwijl ik hem uit wil | Zet in de opties **Hotkey actief** uit (of maak het hotkey-veld leeg, dan staat er `<empty>`). |
| Ik wil alleen corrigeren, maar de hotkey zet mijn ondertitels uit | Dat is de functie van de hotkey: hij is de aan/uit-schakelaar van dít tabblad. Druk nog een keer (dan gaat alles weer aan en wordt de correctie toegepast) of gebruik **Nu toepassen** in de popup; het CC-knopje in de speler werkt altijd. |
| Ondertitels blijven uit terwijl ik ze wél wil | Je hebt het CC-knopje in de speler (rode streep) gebruikt: nog een klik op dat knopje of de hotkey `]` zet de kill switch van dat tabblad weer uit. |
| Popup zegt "extensie nog niet actief" | Ververs het YouTube-tabblad (content scripts worden niet in bestaande tabs geïnjecteerd). |
| Ondertitels worden niet gevonden | De video heeft geen EN/NL-ondertitel. De toast meldt dat; badge wordt `!`. |
| "Kon het ondertitelmenu niet bedienen" | YouTube heeft zijn menu gewijzigd. Zet `preferAutoGenerated` uit als workaround (dan gebruikt de extensie de API) of werk `page-agent.js` bij — zie §13 van de spec. |
| De zwarte achtergrond van de ondertiteling is gevlekt / niet effen (of je ziet een donkere band tussen de regels) | Dat gebeurde toen de blokjes de opacity uit je YouTube-instellingen overnamen: ze overlappen elkaar, dus halfdoorzichtige lagen werden plaatselijk donkerder (bugmelding 2026-09-20). De achtergrond is nu altijd dekkend — **herlaad de extensie** (`brave://extensions` → ⟳) en ververs het YouTube-tabblad. Wil je een andere kleur dan zwart, zet die dan in YouTube's eigen captioninstellingen; de kleur volgt die instelling, alleen de doorschijnendheid niet. |
| Bridge offline | `bridge\run_bridge.bat` starten. Draai je op een andere poort? Zet de URL in de opties. |
| Tijdens een detectie hoor je niets | Chrome dempt het tabblad bij het opnemen. Laat "Geluid hoorbaar houden tijdens opname" aan staan. |
| Echo/dubbel geluid tijdens detectie | Zet "Geluid hoorbaar houden tijdens opname" **uit**. |
| Melding "model laden..." duurt lang | De eerste keer downloadt Whisper het model (~75 MB voor `tiny`, ~145 MB voor `base`). |
| Playlists haperen / ondertitels lopen achter | Dit zit deels in YouTube zelf (playlists decoderen en prefetchen zwaarder). Zet **Caption-prioriteit** aan (default); in playlists draait de audio-analyse dan alleen via de hotkey. Meer automatiek nodig? Zet "Audio-analyse ook automatisch in playlists" aan. |
| Auto-ondertitels lopen achter of ploppen in blokken (ook zónder extensie) | Dit is YouTube's eigen caption-venster. Laat **Caption Boost** aan (default): de extensie tekent de ondertitel dan zelf in blokken van 2 volle zinnen (in één keer). Werkt het niet (geen track kunnen onderscheppen, advertentie, vertaling), dan blijft YouTube's eigen weergave staan en kun je niets forceren. |
| Ik wil liever woord voor woord (zoals YouTube's auto-ondertitels) | Dat is de standaard (**Word-for-Word** staat aan) — in de popup (één klik) of in de opties. Elk woord krijgt een eigen tijd; een cue zonder per-woordtijden wordt over de cue verdeeld, dus er komt geen hele zin in één keer in beeld. Uitzetten = hele blokken van 2 volle zinnen. |
| Een nieuwe spreker (`>>`) begint niet op een nieuwe regel | Alleen als de track de `>>`-markering bevat (auto-gegenereerde tracks doen dat). Zonder markering is er niets om op te breken. |
| De bovenste regel wordt afgekapt of de letters plakken tegen de bovenrand van het zwart | Herlaad de extensie (`brave://extensions` → ⟳) zodat de nieuwste `page-agent.js` actief is. Sinds de fixes van 2026-09-18/19 meet het rollende venster de **echte** afstand tussen de regels (`L.captionLineMetrics()` → `L.captionWindowShiftLines()`) én bouwt het venster om de **inkt** van de letters (`L.captionVerticalLayout()`), zodat de tekst optisch midden in het zwart staat met boven én onder evenveel marge; onze eigen CSS zet de `line-height`/`font-size` van de wrapper en de woordblokjes met `!important` vast. Geeft een pagina (of een andere extensie) de woordblokjes tóch een andere regelafstand, dan blijft de bovenste regel nu binnen het venster in plaats van erboven. Controle: `tools\check-caption-window.html`. |
| De ondertitels staan te hoog of te laag | Zet **Y-offset** in de opties: positief schuift omlaag, negatief omhoog (−40 tot +30). |

## 8. Repo-structuur

```text
extension/     de Brave/Chrome-extensie (load unpacked vanaf deze map)
bridge/        lokale Python-bridge (alleen nodig voor audio-analyse)
tools/         tests, iconen-generator, spraak-fixtures, smoke test
SUBTITLE_CORRECTOR_PROMPT.md   volledige specificatie en onderhoudshandleiding
```
