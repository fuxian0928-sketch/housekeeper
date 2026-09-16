param([int]$TimeoutSeconds = 20)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Speech

try {
  $culture = [System.Globalization.CultureInfo]::GetCultureInfo('zh-CN')
  $recognizer = [System.Speech.Recognition.SpeechRecognitionEngine]::new($culture)
  $recognizer.InitialSilenceTimeout = [TimeSpan]::FromSeconds(6)
  $recognizer.BabbleTimeout = [TimeSpan]::FromSeconds(2)
  $recognizer.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(850)
  $recognizer.EndSilenceTimeoutAmbiguous = [TimeSpan]::FromMilliseconds(1200)
  $recognizer.LoadGrammar([System.Speech.Recognition.DictationGrammar]::new())
  $recognizer.SetInputToDefaultAudioDevice()
  $result = $recognizer.Recognize([TimeSpan]::FromSeconds([Math]::Max(8, [Math]::Min(45, $TimeoutSeconds))))
  if ($null -eq $result -or [string]::IsNullOrWhiteSpace($result.Text)) {
    @{ ok = $false; error = 'no-speech'; message = 'No speech was recognized.' } | ConvertTo-Json -Compress
  } else {
    @{ ok = $true; text = $result.Text.Trim(); confidence = [Math]::Round($result.Confidence, 3) } | ConvertTo-Json -Compress
  }
} catch {
  @{ ok = $false; error = 'recognition-failed'; message = $_.Exception.Message } | ConvertTo-Json -Compress
} finally {
  if ($null -ne $recognizer) { $recognizer.Dispose() }
}
