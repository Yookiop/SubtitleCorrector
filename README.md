# Subtitle Corrector

Zet YouTube-ondertitels automatisch in de **taal van de audio** (Engels of Nederlands) en schakelt **automatische vertaling** uit.

> **Waarom:** YouTube onthoudt je laatst gebruikte ondertitelkeuze en past die toe op de volgende video. Kijk je Engels en Nederlands door elkaar, dan vertaalt YouTube je ondertitels de verkeerde kant op (Engelse video → Nederlandse ondertitels, Nederlandse video → Engelse ondertitels). Deze extensie zet per video de juiste track: de **auto-gegenereerde** ondertitel van de gesproken taal (prioriteit 1), of anders de **handmatige** (prioriteit 2).

* **Lokaal**: losse extensie (unpacked), geen webstore, geen account, geen cloud.
* **Automatisch** bij elke nieuwe video, plus handmatig met de hotkey <kbd>]</kbd>.
* **Alleen EN/NL** — andere talen worden met rust gelaten.
* **Spaarzaam met CPU/GPU (caption-prioriteit)**: in playlists draait de zware audio-analyse alleen via de hotkey, er wordt nooit opgenomen als de bridge niet klaar is, en de extensie pollt langzamer op de achtergrond. Zo houdt YouTube ruimte over voor het tekenen van de ondertitels (zie §5.1).
* **Caption Boost (hele blokken ondertitel)**: toont de ondertitel in blokken van **2 volle zinnen**, in één keer. De blokgrens ligt exact op het 2e zinseinde — ook als dat midden in een YouTube-cue valt, want de rest van die cue gaat naar het volgende blok. Zo blijft elke zin bij elkaar en komt er geen halfgevuld blok meer waarin de rest van de zin pas later in een nieuw blok verschijnt. Dit lost het "loopt 1-2 s achter en plopt dan in blokken"-probleem op, ook als dat zonder de extensie gebeurt (zie §5.1).
* **Word-for-Word (optie)**: liever woord voor woord, zoals YouTube's auto-gegenereerde ondertitels? Zet de optie aan: elk woord verschijnt op zijn eigen tijd en het venster van 2 regels rolt per regel omhoog (regel 1 verdwijnt, regel 2 wordt regel 1, verder op de nieuwe regel 2). Ook als een cue geen per-woordtijden heeft (één tijd voor een hele zin) verschijnen de woorden één voor één — de tijd wordt dan over de cue verdeeld, zodat er nooit ineens een halve zin in beeld plopt.
* **Sprekerswissel (`>>`)**: geeft YouTube een nieuwe spreker aan met `>>`, dan begint die op een **nieuwe regel** (in beide weergaven). De markering zelf blijft staan, zoals bij YouTube.
* **Positie**: met **Y-offset** schuif je de ondertitelbalk in de opties omhoog of omlaag (−40 tot +30 procentpunten van de spelerhoogte).
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
* **Handmatig**: druk op <kbd>]</kbd> terwijl het YouTube-tabblad focus heeft (bijvoorbeeld als YouTube iets verkeerd heeft gezet).
* **Uitzetten per tabblad**: links naast het tandwiel in de speler staat een **CC-knopje**; één klik zet de ondertiteling van dít tabblad volledig uit (captions uit, Caption Boost uit én geen bridge/audio-analyse — ook als YouTube ze daarna opnieuw aanzet). Nog een klik (of de hotkey <kbd>]</kbd>) zet alles weer aan; in de uit-stand zie je een **rode streep** door het icoon en staat `off` op de badge.
* **Popup** (klik op het icoon): toont de gedetecteerde audiotaal + bron, de huidige ondertitel, wat de extensie zou doen, en of de bridge online is. Met **Nu toepassen** forceer je een correctie.
* **Toast**: linksonder in de video zie je kort wat er gebeurd is (uit te zetten in de opties).

## 3. Opties

Rechtermuisknop op het icoon → **Options** (of via de popup → Instellingen). Belangrijkste:

| Optie | Default | Betekenis |
|-------|---------|-----------|
| Hotkey | `]` | Ook `ctrl+]` etc. mogelijk |
| Automatisch bij elke nieuwe video | aan | Uitzetten = alleen handmatig met de hotkey |
| Auto-gegenereerd boven handmatig | aan | Prioriteit 1 = auto, 2 = handmatig |
| Ondertitels aanzetten als ze uit staan | aan | Want YouTube activeert ze niet altijd |
| Als ik ze zelf uitzet, niet opnieuw aanzetten | aan | Per video onthouden |
| Vertaling herstellen als YouTube hem opnieuw aanzet | aan | Met cooldown |
| Bridge gebruiken als metadata onduidelijk is | aan | Zie §4 |
| Eigen ondertitelweergave (Caption Boost) | aan | Toont de ondertitel in blokken van 2 volle zinnen, in één keer, en verbergt YouTube's eigen caption-venster zolang dat lukt |
| Word-for-Word | uit | Woord voor woord, zoals YouTube's auto-gegenereerde ondertitels: elk woord op zijn eigen tijd in het vaste venster; zodra de onderste regel vol is schuift het venster één regel omhoog (regel 1 eruit, verder op de nieuwe regel 2). Een stilte begint met een leeg venster. Ook een cue zonder per-woordtijden (één tijd voor de hele zin) wordt woord voor woord getoond: de woorden worden dan gelijkmatig over de cue verdeeld |
| Ondertitelgrootte (Caption Boost) | 175% | 50 - 250% van de standaardgrootte; stijl (kleur/achtergrond en de grove "Font size"-stand) volgt automatisch je YouTube-ondertitelinstellingen |
| Ondertitelregels (Caption Boost) | 2 regels | Hoogte van het vaste captionblok in regels (1 of 2). Het blok is altijd precies zo hoog — ook met maar één zin: regel 1 linksboven, regel 2 leeg. Past een blok van 2 zinnen niet helemaal, dan wordt de tekst onderaan afgekapt. Het font krimpt nooit |
| Y-offset (Caption Boost) | 0% | Verticale positie van de ondertitelbalk in procentpunten van de spelerhoogte: positief = omlaag, negatief = omhoog (bereik −40 tot +30). De balk blijft altijd binnen de speler |
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
* de **stijl** komt uit YouTube's eigen captioninstellingen (`getSubtitlesUserSettings`: tekstkleur, achtergrondkleur + opacity, `fontSizeIncrement`), dus wit-op-zwart of welke stijl je daar ook hebt gekozen wordt automatisch nagebouwd;
* met de optie **Word-for-Word** (standaard uit) komt elk woord apart in beeld, net als bij YouTube's auto-ondertitels: dezelfde vaste box, maar het venster schuift door — zodra de onderste regel vol is glijdt de tekst met een korte **slide-up** (200 ms) één regel omhoog (`L.captionWindowShift()`, altijd hele regels), regel 1 verdwijnt, regel 2 wordt regel 1 en de nieuwe woorden gaan verder op de lege regel 2. Die beweging gaat met `top` op de tekstwrapper (geen `transform`: dat zet de tekst op een eigen compositing-laag en dan kan hij tijdens het schuiven buiten het zwarte blok getekend worden) en de box heeft naast `overflow:hidden` ook `clip-path:inset(0)`, zodat er nooit tekst buiten het blok valt. `L.buildCaptionWords()` geeft **elk** woord een eigen, strikt oplopende tijd: bij een cue met per-woordtijden (`tOffsetMs`) exact zoals gemeten, en bij een cue zonder per-woordtijden (één tijd voor de hele zin) worden de woorden gelijkmatig over de cue verdeeld. Daardoor verschijnt er nooit ineens een hele zin: de woorden komen altijd één voor één. Een stilte (> ±1,6 s, `L.buildCaptionRuns()`) begint met een leeg venster; binnen doorlopende spraak blijft het venster staan;
* het blok staat in een **vast venster van 1 of 2 regels** (*Ondertitelregels*, standaard 2), **linksboven uitgelijnd**: de tekst begint links in de balk en gebruikt de volle balkbreedte. De balk is 80% van de spelerbreedte en staat gecentreerd (links en rechts blijft de video zichtbaar — geen balk van rand tot rand) en sluit **strak om het tekstvak**: de box is een block (geen inline-block) en de onderpadding is kleiner dan de bovenpadding (`L.captionBoxHeightEm()` = `regels × 1,4 + 0,06 + 0,03` em), zodat er onderaan geen strook zwart overblijft die er boven niet is. Het venster is altijd precies zo hoog, ook als een blok maar één zin heeft (regel 2 blijft dan leeg); past een blok van 2 zinnen niet helemaal, dan wordt het onderaan afgekapt. Het font krimpt **nooit** en er schuift niets op; YouTube's eigen regelovergangen worden als spatie behandeld;
* een **sprekerswissel** (`>>`) begint op een **nieuwe regel** (`L.isSpeakerChange()` / `L.captionSpeakerBreaks()`): in de blokweergave via een `\n` (de overlay gebruikt `white-space:pre-wrap`), in de woord-voor-woord-weergave via een `<br>` vóór het `>>`-woord. De hangende spatie van het vorige woord wordt weggehaald, zodat de nieuwe regel niet inspringt; staat het venster nog leeg, dan komt er geen lege regel boven;
* de **positie** stel je in met *Y-offset* (standaard 0, bereik −40 tot +30): `L.captionBottomPct()` rekent dat om naar de afstand tot de onderrand (basis 10,5% van de spelerhoogte; positief = omlaag) en clamped op 0-80%, zodat de balk in de speler blijft;
* de **grootte** stel je zelf in met *Ondertitelgrootte* (50 - 250%; standaard **175%**, 100% ≈ YouTube's eigen standaardgrootte);
* zolang dat lukt blijft YouTube's eigen caption-venster verborgen; bij advertenties, een actieve vertaling, een ontbrekende track of een videowissel gaat alles direct terug naar YouTube's eigen weergave.

Meer automatiek nodig voor video's zonder metadata? Zet in de opties **"Audio-analyse ook automatisch in playlists"** aan (kost meer CPU/GPU).

## 6. Testen

```text
dubbelklik tools\test-lang-utils.html     # 51 tests van de pure logica, geen Node nodig
node tools\test-lang-utils.mjs            # zelfde tests (als Node geïnstalleerd is)
dubbelklik tools\check-caption-lines.html # blokken van 2 zinnen, het rollende woord-voor-woord-venster (ook zonder per-woordtijden en met sprekerswissels) en de Y-offset, met regels en vulling per blok/run
python tools\bridge-smoke-test.py         # bridge end-to-end
powershell -ExecutionPolicy Bypass -File tools\make_tts_fixtures.ps1   # EN/NL spraak-WAV's maken
```

Syntax- en manifestcheck (nalopen na het aanpassen van bestanden):

```text
python -m http.server 8099     ->  http://localhost:8099/tools/check-syntax.html
```

## 7. Problemen oplossen

| Symptoom | Oplossing |
|----------|-----------|
| Er gebeurt niets bij `]` | Staat de hotkey in de opties goed? Heeft het YouTube-tabblad focus? Staat de extensie aan? Ververs het tabblad na het (her)laden van de extensie. |
| Ondertitels blijven uit terwijl ik ze wél wil | Je hebt het CC-knopje in de speler (rode streep) gebruikt: nog een klik op dat knopje of de hotkey `]` zet de kill switch van dat tabblad weer uit. |
| Popup zegt "extensie nog niet actief" | Ververs het YouTube-tabblad (content scripts worden niet in bestaande tabs geïnjecteerd). |
| Ondertitels worden niet gevonden | De video heeft geen EN/NL-ondertitel. De toast meldt dat; badge wordt `!`. |
| "Kon het ondertitelmenu niet bedienen" | YouTube heeft zijn menu gewijzigd. Zet `preferAutoGenerated` uit als workaround (dan gebruikt de extensie de API) of werk `page-agent.js` bij — zie §13 van de spec. |
| Bridge offline | `bridge\run_bridge.bat` starten. Draai je op een andere poort? Zet de URL in de opties. |
| Tijdens een detectie hoor je niets | Chrome dempt het tabblad bij het opnemen. Laat "Geluid hoorbaar houden tijdens opname" aan staan. |
| Echo/dubbel geluid tijdens detectie | Zet "Geluid hoorbaar houden tijdens opname" **uit**. |
| Melding "model laden..." duurt lang | De eerste keer downloadt Whisper het model (~75 MB voor `tiny`, ~145 MB voor `base`). |
| Playlists haperen / ondertitels lopen achter | Dit zit deels in YouTube zelf (playlists decoderen en prefetchen zwaarder). Zet **Caption-prioriteit** aan (default); in playlists draait de audio-analyse dan alleen via de hotkey. Meer automatiek nodig? Zet "Audio-analyse ook automatisch in playlists" aan. |
| Auto-ondertitels lopen achter of ploppen in blokken (ook zónder extensie) | Dit is YouTube's eigen caption-venster. Laat **Caption Boost** aan (default): de extensie tekent de ondertitel dan zelf in blokken van 2 volle zinnen (in één keer). Werkt het niet (geen track kunnen onderscheppen, advertentie, vertaling), dan blijft YouTube's eigen weergave staan en kun je niets forceren. |
| Ik wil liever woord voor woord (zoals YouTube's auto-ondertitels) | Zet de optie **Word-for-Word** aan — in de popup (één klik) of in de opties. De blokken blijven dan uit en het venster rolt per regel omhoog. Elk woord krijgt een eigen tijd; een cue zonder per-woordtijden wordt over de cue verdeeld, dus ook dan komt er geen hele zin in één keer in beeld. |
| Een nieuwe spreker (`>>`) begint niet op een nieuwe regel | Alleen als de track de `>>`-markering bevat (auto-gegenereerde tracks doen dat). Zonder markering is er niets om op te breken. |
| De ondertitels staan te hoog of te laag | Zet **Y-offset** in de opties: positief schuift omlaag, negatief omhoog (−40 tot +30). |

## 8. Repo-structuur

```text
extension/     de Brave/Chrome-extensie (load unpacked vanaf deze map)
bridge/        lokale Python-bridge (alleen nodig voor audio-analyse)
tools/         tests, iconen-generator, spraak-fixtures, smoke test
SUBTITLE_CORRECTOR_PROMPT.md   volledige specificatie en onderhoudshandleiding
```
