param([Parameter(Mandatory=$true)][string]$OutputDirectory)
# Run with Windows PowerShell 5.1. Saves artificial offline fixtures; no speaker playback.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$destination = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($destination) | Out-Null
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $speaker.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::Female, [System.Speech.Synthesis.VoiceAge]::Adult, 0, [Globalization.CultureInfo]::GetCultureInfo('zh-CN'))
    $cases = @(
        @{id='wake-short';text='希微';expected=$true},
        @{id='wake-long';text='希微希微';expected=$true},
        @{id='wake-alias';text='小艺小艺';expected=$true},
        @{id='wake-legacy';text='小伊';expected=$true},
        @{id='wake-with-body';text='希微，帮我整理今天的任务';expected=$true},
        @{id='negative-work';text='帮我整理今天的任务';expected=$false},
        @{id='negative-common-homophone';text='注意细微差别';expected=$false},
        @{id='negative-similar';text='这个建议不错，明天再说';expected=$false}
    )
    foreach ($case in $cases) {
        $speaker.SetOutputToWaveFile((Join-Path $destination ($case.id + '.wav')))
        $speaker.Speak($case.text)
        $speaker.SetOutputToNull()
    }
    @{ source='Windows SAPI synthetic; NOT human wake acceptance'; voice=$speaker.Voice.Name; cases=$cases } | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $destination 'manifest.json') -Encoding UTF8
} finally { $speaker.Dispose() }
