# Subtitle Corrector

Zet YouTube-ondertitels automatisch in de **taal van de audio** (Engels of Nederlands) en schakelt **automatische vertaling** uit.

> **Waarom:** YouTube onthoudt je laatst gebruikte ondertitelkeuze en past die toe op de volgende video. Kijk je Engels en Nederlands door elkaar, dan vertaalt YouTube je ondertitels de verkeerde kant op (Engelse video → Nederlandse ondertitels, Nederlandse video → Engelse ondertitels). Deze extensie zet per video de juiste track: de **auto-gegenereerde** ondertitel van de gesproken taal (prioriteit 1), of anders de **handmatige** (prioriteit 2).

* **Lokaal**: losse extensie (unpacked), geen webstore, geen account, geen cloud.
* **Automatisch** bij elke nieuwe video, plus handmatig met de hotkey <kbd>]</kbd>.
* **Alleen EN/NL** — andere talen worden met rust gelaten.
* **Spaarzaam met CPU/GPU (caption-prioriteit)**: in playlists draait de zware audio-analyse alleen via de hotkey, er wordt nooit opgenomen als de bridge niet klaar is, en de extensie pollt langzamer op de achtergrond. Zo houdt YouTube ruimte over voor het tekenen van de ondertitels (zie §5.1).
* **Caption Boost (vloeiende ondertitels)**: tekent dezelfde ondertitel zelf woord voor woord, direct synchroon met de audio — met de per-woord timing uit YouTube's eigen track. Dit lost het "loopt 1-2 s achter en plopt dan in blokken"-probleem op, ook als dat zonder de extensie gebeurt (zie §5.1).
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
| Eigen ondertitelweergave (Caption Boost) | aan | Tekent de ondertitel zelf woord voor woord en verbergt YouTube's eigen caption-venster zolang dat lukt |
| Ondertitelgrootte (Caption Boost) | 100% | 50 - 250% van de standaardgrootte; stijl (kleur/achtergrond en de grove "Font size"-stand) volgt automatisch je YouTube-ondertitelinstellingen |
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
* de tekst wordt woord voor woord gerenderd in een overlay, synchroon met `getCurrentTime()`;
* de **stijl** komt uit YouTube's eigen captioninstellingen (`getSubtitlesUserSettings`: tekstkleur, achtergrondkleur + opacity, `fontSizeIncrement`), dus wit-op-zwart of welke stijl je daar ook hebt gekozen wordt automatisch nagebouwd;
* de hele cue staat **vooraf vast**: alle woorden krijgen hun plek, het eerste woord blijft **links uitgelijnd** staan en de rest schuift niet op; de tekst wikkelt zoals bij YouTube in 1-2 regels;
* de **grootte** stel je zelf in met *Ondertitelgrootte* (50 - 250%; 100% ≈ YouTube's standaardgrootte);
* zolang dat lukt blijft YouTube's eigen caption-venster verborgen; bij advertenties, een actieve vertaling, een ontbrekende track of een videowissel gaat alles direct terug naar YouTube's eigen weergave.

Meer automatiek nodig voor video's zonder metadata? Zet in de opties **"Audio-analyse ook automatisch in playlists"** aan (kost meer CPU/GPU).

## 6. Testen

```text
dubbelklik tools\test-lang-utils.html     # 31 tests van de pure logica, geen Node nodig
node tools\test-lang-utils.mjs            # zelfde tests (als Node geïnstalleerd is)
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
| Popup zegt "extensie nog niet actief" | Ververs het YouTube-tabblad (content scripts worden niet in bestaande tabs geïnjecteerd). |
| Ondertitels worden niet gevonden | De video heeft geen EN/NL-ondertitel. De toast meldt dat; badge wordt `!`. |
| "Kon het ondertitelmenu niet bedienen" | YouTube heeft zijn menu gewijzigd. Zet `preferAutoGenerated` uit als workaround (dan gebruikt de extensie de API) of werk `page-agent.js` bij — zie §13 van de spec. |
| Bridge offline | `bridge\run_bridge.bat` starten. Draai je op een andere poort? Zet de URL in de opties. |
| Tijdens een detectie hoor je niets | Chrome dempt het tabblad bij het opnemen. Laat "Geluid hoorbaar houden tijdens opname" aan staan. |
| Echo/dubbel geluid tijdens detectie | Zet "Geluid hoorbaar houden tijdens opname" **uit**. |
| Melding "model laden..." duurt lang | De eerste keer downloadt Whisper het model (~75 MB voor `tiny`, ~145 MB voor `base`). |
| Playlists haperen / ondertitels lopen achter | Dit zit deels in YouTube zelf (playlists decoderen en prefetchen zwaarder). Zet **Caption-prioriteit** aan (default); in playlists draait de audio-analyse dan alleen via de hotkey. Meer automatiek nodig? Zet "Audio-analyse ook automatisch in playlists" aan. |
| Auto-ondertitels lopen achter of ploppen in blokken (ook zónder extensie) | Dit is YouTube's eigen caption-venster. Laat **Caption Boost** aan (default): de extensie tekent de ondertitel dan zelf woord voor woord. Werkt het niet (geen track kunnen onderscheppen, advertentie, vertaling), dan blijft YouTube's eigen weergave staan en kun je niets forceren. |

## 8. Repo-structuur

```text
extension/     de Brave/Chrome-extensie (load unpacked vanaf deze map)
bridge/        lokale Python-bridge (alleen nodig voor audio-analyse)
tools/         tests, iconen-generator, spraak-fixtures, smoke test
SUBTITLE_CORRECTOR_PROMPT.md   volledige specificatie en onderhoudshandleiding
```
