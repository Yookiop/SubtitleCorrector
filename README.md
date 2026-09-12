# Subtitle Corrector

Zet YouTube-ondertitels automatisch in de **taal van de audio** (Engels of Nederlands) en schakelt **automatische vertaling** uit.

> **Waarom:** YouTube onthoudt je laatst gebruikte ondertitelkeuze en past die toe op de volgende video. Kijk je Engels en Nederlands door elkaar, dan vertaalt YouTube je ondertitels de verkeerde kant op (Engelse video → Nederlandse ondertitels, Nederlandse video → Engelse ondertitels). Deze extensie zet per video de juiste track: de **auto-gegenereerde** ondertitel van de gesproken taal (prioriteit 1), of anders de **handmatige** (prioriteit 2).

* **Lokaal**: losse extensie (unpacked), geen webstore, geen account, geen cloud.
* **Automatisch** bij elke nieuwe video, plus handmatig met de hotkey <kbd>]</kbd>.
* **Alleen EN/NL** — andere talen worden met rust gelaten.
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
| Bridge-URL | `http://127.0.0.1:8791` | Alleen nodig als je een andere poort gebruikt |

## 4. Bridge (optioneel, voor audio-analyse)

De extensie redt het in de praktijk met metadata: de audiotrack vertelt de taal, en anders doet de ASR-track dat. Alleen als dat allebei onduidelijk of tegenstrijdig is, wordt er **naar de audio geluisterd**. Dat doet een klein lokaal Python-programma (Whisper op CPU).

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

## 6. Testen

```text
dubbelklik tools\test-lang-utils.html     # 22 tests van de pure logica, geen Node nodig
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

## 8. Repo-structuur

```text
extension/     de Brave/Chrome-extensie (load unpacked vanaf deze map)
bridge/        lokale Python-bridge (alleen nodig voor audio-analyse)
tools/         tests, iconen-generator, spraak-fixtures, smoke test
SUBTITLE_CORRECTOR_PROMPT.md   volledige specificatie en onderhoudshandleiding
```
