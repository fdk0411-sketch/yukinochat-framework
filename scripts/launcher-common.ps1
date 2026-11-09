# Shared helpers for the local Yukino Chat launcher. Compatible with Windows PowerShell 5.1.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-YukinoRoot {
    return [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
}

function Get-YukinoExecutable {
    param([Parameter(Mandatory = $true)][string]$Name, [string[]]$Candidates = @())
    $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command -and (Test-Path -LiteralPath $command.Source -PathType Leaf)) {
        return [IO.Path]::GetFullPath($command.Source)
    }
    foreach ($candidate in $Candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return [IO.Path]::GetFullPath($candidate)
        }
    }
    return $null
}

function Get-YukinoHealth {
    param([Parameter(Mandatory = $true)][int]$Port)
    if ($Port -lt 1024 -or $Port -gt 65535) { return $null }
    try {
        $result = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/health" -f $Port) -Method Get -TimeoutSec 2 -UseBasicParsing
        if ($result.ok -eq $true -and $result.app -eq 'yukino-chat') { return $result }
    } catch { }
    return $null
}

function Get-YukinoInstance {
    param([Parameter(Mandatory = $true)][string]$Root)
    $instanceFile = Join-Path $Root 'data\instance.json'
    if (-not (Test-Path -LiteralPath $instanceFile -PathType Leaf)) { return $null }
    try {
        $instance = Get-Content -LiteralPath $instanceFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if (-not $instance.PSObject.Properties['pid'] -or -not $instance.PSObject.Properties['port']) { return $null }
        $servicePid = [int]$instance.pid
        $servicePort = [int]$instance.port
        if ($servicePid -gt 0 -and $servicePort -ge 1024 -and $servicePort -le 65535) { return $instance }
    } catch { }
    return $null
}

function Get-VerifiedYukinoProcess {
    param([Parameter(Mandatory = $true)][int]$ServicePid, [Parameter(Mandatory = $true)][string]$Root)
    $processInfo = Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f $ServicePid) -ErrorAction SilentlyContinue
    if (-not $processInfo -or $processInfo.Name -ine 'node.exe' -or -not $processInfo.CommandLine) { return $null }
    $serverFile = [IO.Path]::GetFullPath((Join-Path $Root 'server.mjs'))
    # Match an entire command-line token, not a substring or another workspace's similarly named script.
    $arguments = [regex]::Matches($processInfo.CommandLine, '(?:^|\s)(?:"([^\"]*)"|(\S+))')
    foreach ($argument in $arguments) {
        $token = if ($argument.Groups[1].Success) { $argument.Groups[1].Value } else { $argument.Groups[2].Value }
        if ($token -ieq $serverFile) { return $processInfo }
    }
    return $null
}

function Test-YukinoPortAvailable {
    param([Parameter(Mandatory = $true)][int]$Port)
    $listener = New-Object Net.Sockets.TcpListener ([Net.IPAddress]::Loopback), $Port
    try {
        $listener.Start()
        return $true
    } catch {
        return $false
    } finally {
        $listener.Stop()
    }
}

function Open-YukinoWindow {
    param([Parameter(Mandatory = $true)][string]$BaseUrl, [Parameter(Mandatory = $true)][string]$Root)
    $browserCandidates = @()
    if (${env:ProgramFiles(x86)}) { $browserCandidates += (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe') }
    if ($env:ProgramFiles) { $browserCandidates += (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe') }
    if ($env:LOCALAPPDATA) { $browserCandidates += (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe') }
    $browserPath = Get-YukinoExecutable -Name 'msedge.exe' -Candidates $browserCandidates
    if (-not $browserPath) {
        $chromeCandidates = @()
        if ($env:ProgramFiles) { $chromeCandidates += (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe') }
        if (${env:ProgramFiles(x86)}) { $chromeCandidates += (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe') }
        if ($env:LOCALAPPDATA) { $chromeCandidates += (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe') }
        $browserPath = Get-YukinoExecutable -Name 'chrome.exe' -Candidates $chromeCandidates
    }
    if ($browserPath) {
        $profileDirectory = Join-Path $Root 'data\browser-profile'
        # This is the intentionally visible, user-facing chat window, not a background helper.
        Start-Process -FilePath $browserPath -ArgumentList @(
            ('--app="{0}"' -f $BaseUrl),
            ('--user-data-dir="{0}"' -f $profileDirectory),
            # Open maximized while keeping a comfortable size when the user restores the window.
            '--no-first-run', '--no-default-browser-check', '--window-size=1360,900', '--start-maximized'
        ) | Out-Null
    } else {
        Start-Process -FilePath $BaseUrl | Out-Null
    }
}
