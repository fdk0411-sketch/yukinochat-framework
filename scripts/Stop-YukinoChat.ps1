[CmdletBinding()]
param()

. (Join-Path $PSScriptRoot 'launcher-common.ps1')
$appRoot = Get-YukinoRoot
function Stop-YukinoVoice {
    $voiceStop = Join-Path $appRoot 'voice-runtime\Stop-VoiceRuntime.ps1'
    if (-not (Test-Path -LiteralPath $voiceStop -PathType Leaf)) { return }
    $logDirectory = Join-Path $appRoot 'logs'
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $helper = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-File', ('"{0}"' -f $voiceStop)) -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $logDirectory ("voice-stop-{0}.stdout.log" -f $stamp)) -RedirectStandardError (Join-Path $logDirectory ("voice-stop-{0}.stderr.log" -f $stamp))
    if ($helper.ExitCode -eq 0) { Write-Output 'Voice shutdown check completed; only the verified project runtime can be stopped.' }
    else { Write-Warning 'Voice shutdown could not be verified. Check the voice-stop log; no unrelated process was targeted.' }
}
$instance = Get-YukinoInstance -Root $appRoot
if (-not $instance) { Write-Output 'No Yukino Chat instance record was found.'; Stop-YukinoVoice; exit 0 }
$servicePid = [int]$instance.pid
$verifiedProcess = Get-VerifiedYukinoProcess -ServicePid $servicePid -Root $appRoot
if (-not $verifiedProcess) {
    Write-Output 'The recorded process is absent or does not match this Yukino Chat server. No process was stopped.'
    Stop-YukinoVoice
    exit 0
}

# Stop only this server's direct Codex app-server child; the official desktop backend has a different parent.
$children = @(Get-CimInstance Win32_Process -Filter ("ParentProcessId = {0}" -f $servicePid))
foreach ($child in $children) {
    if ($child.Name -ieq 'codex.exe' -and $child.CommandLine -match '(?:^|\s)app-server(?:\s|$)') {
        $currentChild = Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f $child.ProcessId) -ErrorAction SilentlyContinue
        if ($currentChild -and $currentChild.ParentProcessId -eq $servicePid -and $currentChild.CreationDate -eq $child.CreationDate) {
            Stop-Process -Id ([int]$child.ProcessId) -Force -ErrorAction SilentlyContinue
        }
    }
}
# Revalidate immediately before stopping the parent to avoid acting on a reused PID.
$currentParent = Get-VerifiedYukinoProcess -ServicePid $servicePid -Root $appRoot
if ($currentParent -and $currentParent.CreationDate -eq $verifiedProcess.CreationDate) {
    Stop-Process -Id $servicePid -Force
    Write-Output 'Yukino Chat service stopped. Chat history and browser window were preserved.'
} else {
    Write-Output 'The service process changed before shutdown. No replacement process was stopped.'
}
Stop-YukinoVoice
