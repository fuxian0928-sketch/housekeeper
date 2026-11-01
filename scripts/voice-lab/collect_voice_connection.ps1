param(
  [string]$InstallRoot,
  [string]$OutputDirectory = [Environment]::GetFolderPath('Desktop'),
  [switch]$SkipStreamCheck,
  [switch]$NoReveal
)
$ErrorActionPreference = 'Stop'

function Read-VoiceJson([string]$File) {
  try {
    if ((Get-Item -LiteralPath $File).Length -gt 200000) { return $null }
    return Get-Content -LiteralPath $File -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch { return $null }
}

function Invoke-VoiceProbe([string]$Python, [string]$Script, [string]$WorkerRoot, [string]$JsonInput, [string]$Extra = '') {
  $taskTemporary = Join-Path ([IO.Path]::GetTempPath()) ('xiwei-voice-check-' + [guid]::NewGuid().ToString('N'))
  [void](New-Item -ItemType Directory -Path $taskTemporary)
  $taskStdout = Join-Path $taskTemporary 'stdout.txt'
  $taskStderr = Join-Path $taskTemporary 'stderr.txt'
  $taskOldEncoding = $env:PYTHONIOENCODING
  $taskOldUserSite = $env:PYTHONNOUSERSITE
  $taskOldInput = $env:XIWEI_DIAGNOSTIC_INPUT
  $taskProcess = $null
  try {
    $env:PYTHONIOENCODING = 'utf-8'
    $env:PYTHONNOUSERSITE = '1'
    $env:XIWEI_DIAGNOSTIC_INPUT = $JsonInput
    $taskProcess = Start-Process -FilePath $Python -ArgumentList ('-E -s -B "' + $Script + '"' + $Extra) -WorkingDirectory $WorkerRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $taskStdout -RedirectStandardError $taskStderr
    if (-not $taskProcess.WaitForExit(15000)) {
      try { $taskProcess.Kill(); [void]$taskProcess.WaitForExit(1000) } catch {}
      return @{ completed = $false; code = 'PROBE_TIMEOUT' }
    }
    if ((Get-Item -LiteralPath $taskStdout).Length -gt 131072) { return @{ completed = $false; code = 'PROBE_REPORT_LIMIT' } }
    $taskText = Get-Content -LiteralPath $taskStdout -Raw -Encoding UTF8
    try { return @{ completed = $true; exitCode = $taskProcess.ExitCode; report = ($taskText | ConvertFrom-Json) } }
    catch { return @{ completed = $false; code = 'PROBE_PROCESS_FAILED'; exitCode = $taskProcess.ExitCode } }
  } catch { return @{ completed = $false; code = 'PROBE_START_FAILED' } }
  finally {
    $env:PYTHONIOENCODING = $taskOldEncoding
    $env:PYTHONNOUSERSITE = $taskOldUserSite
    $env:XIWEI_DIAGNOSTIC_INPUT = $taskOldInput
    if ($taskProcess) { $taskProcess.Dispose() }
    # Only remove the two exact scratch files created above; no recursive cleanup.
    Remove-Item -LiteralPath $taskStdout,$taskStderr -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $taskTemporary -ErrorAction SilentlyContinue
  }
}

if (-not $InstallRoot) {
  $taskRunning = @(Get-CimInstance Win32_Process -Filter "Name='AI 秘书.exe'" -ErrorAction SilentlyContinue | Where-Object ExecutablePath)
  foreach ($taskApp in $taskRunning) {
    $taskCandidate = Split-Path -Parent $taskApp.ExecutablePath
    if (Test-Path -LiteralPath (Join-Path $taskCandidate 'resources/native-voice/python/python.exe')) { $InstallRoot = $taskCandidate; break }
  }
}
if (-not $InstallRoot) {
  foreach ($taskRegistry in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
    foreach ($taskEntry in @(Get-ItemProperty -Path $taskRegistry -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*AI 秘书*' })) {
      if ($taskEntry.InstallLocation -and (Test-Path -LiteralPath (Join-Path $taskEntry.InstallLocation 'resources/native-voice/python/python.exe'))) { $InstallRoot = $taskEntry.InstallLocation; break }
    }
    if ($InstallRoot) { break }
  }
}
if (-not $InstallRoot) {
  Add-Type -AssemblyName System.Windows.Forms
  $taskPicker = New-Object System.Windows.Forms.OpenFileDialog
  $taskPicker.Title = '请选择公司电脑上的 AI 秘书.exe'
  $taskPicker.Filter = 'AI 秘书|AI 秘书.exe'
  if ($taskPicker.ShowDialog() -ne 'OK') { exit 1 }
  $InstallRoot = Split-Path -Parent $taskPicker.FileName
}
$taskBundle = Join-Path $InstallRoot 'resources/native-voice'
$taskPython = Join-Path $taskBundle 'python/python.exe'
if (-not (Test-Path -LiteralPath $taskPython)) { throw '当前安装中未找到语音组件，请选择实际安装的 AI 秘书.exe。' }
$taskData = Join-Path $env:APPDATA 'housekeeper'
$taskConfig = Read-VoiceJson (Join-Path $taskData 'desktop-companion.json')
$taskDevices = Read-VoiceJson (Join-Path $taskData 'native-voice-devices.json')
$taskEngine = Read-VoiceJson (Join-Path $taskData 'voice-engine.json')
$taskSession = Read-VoiceJson (Join-Path $taskData 'logs/native-voice-session.json')
$taskStartup = Read-VoiceJson (Join-Path $taskData 'logs/native-voice-startup.json')
$taskReport = [ordered]@{
  schema = 1
  createdAt = [DateTime]::UtcNow.ToString('o')
  computer = $env:COMPUTERNAME
  clientVersion = (Get-Item -LiteralPath (Join-Path $InstallRoot 'AI 秘书.exe')).VersionInfo.ProductVersion
  system = @{ windowsVersion = [Environment]::OSVersion.Version.ToString(); is64Bit = [Environment]::Is64BitOperatingSystem }
  privacy = @{ recordsAudio = $false; readsKeys = $false; changesSettings = $false; uploads = $false }
  preferences = @{ voiceEnabled = $taskConfig.voiceEnabled; mockMode = $taskConfig.mockMode; engine = $taskEngine.engine }
  selected = @{ inputName = $taskDevices.inputName; outputName = $taskDevices.outputName }
  microphonePermission = @{}
}
foreach ($taskPermission in @(@('user','HKCU:\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone'),@('desktopApps','HKCU:\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\NonPackaged'),@('machine','HKLM:\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone'))) {
  try { $taskValue = (Get-ItemProperty -LiteralPath $taskPermission[1] -Name Value).Value; if ($taskValue -in @('Allow','Deny')) { $taskReport.microphonePermission[$taskPermission[0]] = $taskValue } } catch {}
}
if ($taskSession) {
  $taskReport.lastSession = @{ failure = $taskSession.failure; callbackFaults = $taskSession.callbackFaults; modelLoadMs = $taskSession.modelLoadMs; callbackCount = $taskSession.callbackCount; streamsClosed = $taskSession.streamsClosed; continuous = $taskSession.continuous }
  $taskReport.lastSessionWrittenAt = (Get-Item -LiteralPath (Join-Path $taskData 'logs/native-voice-session.json')).LastWriteTimeUtc.ToString('o')
}
if ($taskStartup.events) { $taskReport.startup = @($taskStartup.events | Select-Object -Last 40 | ForEach-Object { @{ at = $_.at; phase = $_.phase; status = $_.status; elapsedMs = $_.elapsedMs; code = $_.code } }) }
$taskFaultFile = Join-Path $taskData 'logs/native-voice-faults.log'
if (Test-Path -LiteralPath $taskFaultFile) {
  # Windows PowerShell 5 retains provider metadata on Get-Content strings.
  # Copy only the matched value, not PSDrive/PSProvider object graphs.
  $taskReport.faults = @(Get-Content -LiteralPath $taskFaultFile -Tail 20 -Encoding UTF8 | ForEach-Object { $taskMatch = [regex]::Match([string]$_, '^\d{4}-\d\d-\d\dT[\d:.]+Z generation=\d+ turn=\d+ code=[A-Z_]+$'); if ($taskMatch.Success) { $taskMatch.Value } })
}
Write-Host '正在读取语音组件和设备列表…'
$taskReport.runtime = Invoke-VoiceProbe $taskPython (Join-Path $taskBundle 'scripts/voice-lab/runtime_probe.py') $taskBundle '' ' --list-devices'
$taskProbeInput = @{ workerRoot = $taskBundle; inputName = [string]$taskDevices.inputName; outputName = [string]$taskDevices.outputName; openStream = (-not $SkipStreamCheck) } | ConvertTo-Json -Compress
if (-not $SkipStreamCheck) { Write-Host '正在按希微的实际格式打开所选设备约两秒；只输出静音，不保存录音…' }
$taskReport.deviceConnection = Invoke-VoiceProbe $taskPython (Join-Path $PSScriptRoot 'connection_diagnostic.py') $taskBundle $taskProbeInput
[void](New-Item -ItemType Directory -Path $OutputDirectory -Force)
$taskResultFile = Join-Path $OutputDirectory ('Xiwei-Voice-Diagnostic-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json')
$taskReport | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $taskResultFile -Encoding UTF8
Write-Host ('已生成诊断文件：' + $taskResultFile)
Write-Host '请把该 JSON 文件发给 Codex。此工具未修改客户端设置，也未读取密钥或保存录音。'
if (-not $NoReveal) { Start-Process -FilePath explorer.exe -ArgumentList ('/select,"' + $taskResultFile + '"') }
