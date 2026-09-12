<#
    Subtitle Corrector - testfixtures maken met de Windows-spraaksynthese (SAPI).

    Maakt twee WAV-bestanden met gesproken tekst (Engels en Nederlands) die de
    smoke test gebruikt om de bridge echt te testen.

    Gebruik:  powershell -ExecutionPolicy Bypass -File tools\make_tts_fixtures.ps1

    Bestanden komen in tools\fixtures\ (staat in .gitignore).
#>
param(
    [string]$OutDir = (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "fixtures")
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo })

Write-Host "Beschikbare stemmen:" -ForegroundColor Cyan
foreach ($v in $voices) {
    Write-Host ("  - {0}  [{1}]" -f $v.Name, $v.Culture)
}

function Say-ToFile {
    param([string]$Text, [string]$Culture, [string]$Path, [string]$Label)

    $voice = $voices | Where-Object { $_.Culture.Name -like "$Culture*" } | Select-Object -First 1
    if (-not $voice) {
        Write-Host ("Geen stem voor {0} gevonden - {1} overgeslagen." -f $Culture, $Label) -ForegroundColor Yellow
        return $false
    }

    $synth.SelectVoice($voice.Name)
    $synth.Rate = 0
    $synth.Volume = 100
    $synth.SetOutputToWaveFile($Path)
    $synth.Speak($Text)
    $synth.SetOutputToNull()
    Write-Host ("Geschreven: {0}  (stem {1}, {2})" -f $Path, $voice.Name, $Label) -ForegroundColor Green
    return $true
}

$enText = "This is a test of the subtitle corrector. The weather in London is cloudy today, " +
          "and I would like a cup of tea while I watch this video about history and science."
$nlText = "Dit is een test van de ondertitel corrector. Het weer in Amsterdam is vandaag bewolkt " +
          "en ik wil graag een kopje koffie terwijl ik deze video bekijk over geschiedenis en wetenschap."

$enOk = Say-ToFile -Text $enText -Culture "en" -Path (Join-Path $OutDir "speech_en.wav") -Label "Engels"
$nlOk = Say-ToFile -Text $nlText -Culture "nl" -Path (Join-Path $OutDir "speech_nl.wav") -Label "Nederlands"

if (-not $nlOk) {
    Write-Host ""
    Write-Host "Tip: installeer de Nederlandse spraakstem via Instellingen > Tijd en taal > Taal en regio" -ForegroundColor Yellow
    Write-Host "     (Nederlands > taalopties > spraak). Daarna opnieuw draaien." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Klaar. Draai nu:  python tools\bridge-smoke-test.py" -ForegroundColor Cyan
