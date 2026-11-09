[CmdletBinding()]
param(
    [ValidateRange(1024, 65515)][int]$Port = 8821,
    [switch]$NoWindow
)

. (Join-Path $PSScriptRoot 'launcher-common.ps1')

function Find-YukinoCodexExecutable {
    $pathExecutable = Get-YukinoExecutable -Name 'codex.exe'
    if ($pathExecutable) { return $pathExecutable }
    if (-not $env:LOCALAPPDATA) { return $null }

    # Explorer may retain an obsolete PATH after a Codex update. Inspect only
    # direct version directories in the official per-user CLI installation.
    $binRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'))
    if (-not (Test-Path -LiteralPath $binRoot -PathType Container)) { return $null }
    $candidates = @(foreach ($versionDirectory in (Get-ChildItem -LiteralPath $binRoot -Directory -ErrorAction SilentlyContinue)) {
        if (($versionDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
        $candidatePath = Join-Path $versionDirectory.FullName 'codex.exe'
        $candidate = Get-Item -LiteralPath $candidatePath -ErrorAction SilentlyContinue
        if ($candidate -and -not $candidate.PSIsContainer -and
            (($candidate.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)) {
            $candidate
        }
    })
    $selected = $candidates | Sort-Object -Property @{Expression = 'LastWriteTimeUtc'; Descending = $true}, FullName | Select-Object -First 1
    if ($selected) { return [IO.Path]::GetFullPath($selected.FullName) }
    return $null
}

$appRoot = Get-YukinoRoot
$logDirectory = Join-Path $appRoot 'logs'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$startupLog = Join-Path $logDirectory 'launcher.log'

# The server owns optional voice startup and warmup. This launcher must not race
# the same 9880 model process or wait for GPU work before opening text chat.

try {
    $serverPath = Join-Path $appRoot 'server.mjs'
    if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) { throw 'server.mjs is missing. Complete the application installation first.' }

    $existing = Get-YukinoInstance -Root $appRoot
    if ($existing) {
        $verifiedProcess = Get-VerifiedYukinoProcess -ServicePid ([int]$existing.pid) -Root $appRoot
        $existingHealth = Get-YukinoHealth -Port ([int]$existing.port)
        if ($verifiedProcess -and $existingHealth -and $existingHealth.PSObject.Properties['pid'] -and [int]$existingHealth.pid -eq [int]$existing.pid) {
            $baseUrl = 'http://127.0.0.1:{0}' -f [int]$existing.port
            if (-not $NoWindow) { Open-YukinoWindow -BaseUrl $baseUrl -Root $appRoot }
            Write-Output $baseUrl
            exit 0
        }
        if ($verifiedProcess) { throw 'A Yukino Chat process exists but is not healthy. Run Stop-YukinoChat.ps1, then start again; no process was changed.' }
    }

    $nodeCandidates = @()
    if ($env:ProgramFiles) { $nodeCandidates += (Join-Path $env:ProgramFiles 'nodejs\node.exe') }
    $nodePath = Get-YukinoExecutable -Name 'node.exe' -Candidates $nodeCandidates
    if (-not $nodePath) { throw 'Node.js was not found. Install Node.js or add node.exe to PATH.' }
    & $nodePath (Join-Path $appRoot 'scripts\initialize.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Could not initialize application settings.' }
    $codexPath = Find-YukinoCodexExecutable
    if (-not $codexPath) { throw 'The official Codex CLI was not found on PATH or in the local Codex installation. Open Codex once and try again.' }

    $selectedPort = $null
    for ($candidatePort = $Port; $candidatePort -le ($Port + 19); $candidatePort++) {
        if (Test-YukinoPortAvailable -Port $candidatePort) { $selectedPort = $candidatePort; break }
    }
    if ($null -eq $selectedPort) { throw ("No free loopback port between {0} and {1}." -f $Port, ($Port + 19)) }

    $previousPort = $env:YUKINO_PORT
    $previousCodex = $env:YUKINO_CODEX_BIN
    $previousMossKey = $env:MOSS_API_KEY
    $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $stdoutPath = Join-Path $logDirectory ("server-{0}.stdout.log" -f $timestamp)
    $stderrPath = Join-Path $logDirectory ("server-{0}.stderr.log" -f $timestamp)
    try {
        $env:YUKINO_PORT = [string]$selectedPort
        $env:YUKINO_CODEX_BIN = $codexPath
        # Explorer/Codex may still have an old inherited environment. Read the
        # user's latest credential without writing it to arguments or logs.
        $persistedMossKey = [Environment]::GetEnvironmentVariable('MOSS_API_KEY', 'User')
        if (-not $persistedMossKey) { $persistedMossKey = [Environment]::GetEnvironmentVariable('MOSS_API_KEY', 'Machine') }
        if ($persistedMossKey) { $env:MOSS_API_KEY = $persistedMossKey.Trim() }
        $startedProcess = Start-Process -FilePath $nodePath -ArgumentList ('"{0}"' -f $serverPath) -WorkingDirectory $appRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
    } finally {
        $env:YUKINO_PORT = $previousPort
        $env:YUKINO_CODEX_BIN = $previousCodex
        $env:MOSS_API_KEY = $previousMossKey
    }
    $startedPid = $startedProcess.Id
    $deadline = [DateTime]::UtcNow.AddSeconds(40)
    $health = $null
    do {
        $health = Get-YukinoHealth -Port $selectedPort
        if ($health -and $health.PSObject.Properties['pid'] -and [int]$health.pid -eq $startedPid) { break }
        $health = $null
        if (-not (Get-Process -Id $startedPid -ErrorAction SilentlyContinue)) { throw ("Yukino Chat exited during startup. See {0}" -f $stderrPath) }
        Start-Sleep -Milliseconds 400
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not $health) { throw ("Yukino Chat did not answer health checks within 40 seconds. See {0}" -f $stderrPath) }

    $baseUrl = 'http://127.0.0.1:{0}' -f $selectedPort
    Add-Content -LiteralPath $startupLog -Encoding UTF8 -Value ("{0:o} Started PID {1} at {2}; ready={3}" -f [DateTime]::Now, $startedPid, $baseUrl, $health.ready)
    if (-not $NoWindow) { Open-YukinoWindow -BaseUrl $baseUrl -Root $appRoot }
    Write-Output $baseUrl
    exit 0
} catch {
    Add-Content -LiteralPath $startupLog -Encoding UTF8 -Value ("{0:o} ERROR {1}" -f [DateTime]::Now, $_.Exception.Message)
    Write-Error -Message $_.Exception.Message -ErrorAction Continue
    exit 1
}
