param([string]$TextPath = '', [string]$Voice = '', [int]$Rate = 0, [int]$Volume = 100)

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer,Windows.Media.SpeechSynthesis,ContentType=WindowsRuntime]

function Await($operation, [Type]$resultType) {
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } | Select-Object -First 1
  $task = $method.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $task.Wait()
  return $task.Result
}

try {
  $text = if ($TextPath) { [IO.File]::ReadAllText($TextPath, [Text.UTF8Encoding]::new($false)) } else { [Console]::In.ReadToEnd() }
  if ([string]::IsNullOrWhiteSpace($text)) { throw 'No text to speak.' }
  $speaker = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::new()
  $voices = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices
  $selected = $voices | Where-Object { $_.DisplayName -eq $Voice -or $_.Id -eq $Voice } | Select-Object -First 1
  if ($null -eq $selected) { $selected = $voices | Where-Object Language -eq 'zh-CN' | Select-Object -First 1 }
  if ($null -ne $selected) { $speaker.Voice = $selected }
  $speaker.Options.SpeakingRate = [Math]::Pow(1.12, [Math]::Max(-5, [Math]::Min(5, $Rate)))
  $speaker.Options.AudioVolume = [Math]::Max(0, [Math]::Min(100, $Volume)) / 100
  $stream = Await ($speaker.SynthesizeTextToStreamAsync($text)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
  $input = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream)
  $audioPath = Join-Path $env:TEMP ("ai-secretary-speech-" + [Guid]::NewGuid().ToString('N') + '.wav')
  $output = [IO.File]::Create($audioPath)
  $input.CopyTo($output)
  $output.Dispose(); $input.Dispose(); $stream.Dispose(); $speaker.Dispose()
  $player = [Media.SoundPlayer]::new($audioPath)
  $player.PlaySync()
  $player.Dispose()
  Remove-Item -LiteralPath $audioPath -Force -ErrorAction SilentlyContinue
  @{ ok = $true; engine = 'Windows OneCore'; voice = $selected.DisplayName } | ConvertTo-Json -Compress
} catch {
  if ($null -ne $output) { $output.Dispose() }
  if ($null -ne $input) { $input.Dispose() }
  if ($null -ne $stream) { $stream.Dispose() }
  if ($null -ne $speaker) { $speaker.Dispose() }
  if ($audioPath) { Remove-Item -LiteralPath $audioPath -Force -ErrorAction SilentlyContinue }
  @{ ok = $false; error = 'synthesis-failed'; message = $_.Exception.Message } | ConvertTo-Json -Compress
}
