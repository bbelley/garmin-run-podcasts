#Requires -Version 7.0
[CmdletBinding()]
param(
    [string]$Mp3Url = 'https://soniqtools.com/assets/audio/test-audio-mp3-128kbps.mp3',
    [string]$SdkPath,
    [switch]$LiveQueue,
    [switch]$UnitTests,
    [string]$KeyPath = (Join-Path $PSScriptRoot 'developer_key.der')
)

$ErrorActionPreference = 'Stop'
$localTools = Join-Path $PSScriptRoot '..\.spike-tools'
$queueMode = 'false'
$syncUrl = ''
$watchToken = ''
if ($LiveQueue) {
    $statePath = Join-Path $localTools 'cloudflare\current.json'
    $secretPath = Join-Path $localTools 'cloudflare\secrets.json'
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $secrets = Get-Content -LiteralPath $secretPath -Raw | ConvertFrom-Json
    $syncUrl = $state.public_origin + '/v1/watch/sync'
    $watchToken = $secrets.PACEJAMS_WATCH_TOKEN
    $syncUri = $null
    if (-not [Uri]::TryCreate($syncUrl, [UriKind]::Absolute, [ref]$syncUri) -or
        $syncUri.Scheme -ne 'https' -or $syncUri.HostNameType -ne [UriHostNameType]::Dns -or
        $syncUri.AbsolutePath -cne '/v1/watch/sync' -or $syncUri.UserInfo -or $syncUri.Query -or $syncUri.Fragment -or
        $syncUrl -match '[^\x21-\x7e]|["\\]' -or $watchToken -notmatch '^[a-zA-Z0-9_-]{32,128}$') {
        throw 'Review the ignored Cloudflare watch configuration.'
    }
    $queueMode = 'true'
    # Keep access to the prior test clip and its bookmark when updating this checkout.
    $previousConfig = Join-Path $PSScriptRoot 'source\LocalConfig.mc'
    if (-not $PSBoundParameters.ContainsKey('Mp3Url') -and (Test-Path -LiteralPath $previousConfig)) {
        $previousSource = Get-Content -LiteralPath $previousConfig -Raw
        if ($previousSource -match 'const MP3_URL = "([^"\r\n]+)";') { $Mp3Url = $Matches[1] }
    }
}

if (-not $SdkPath) {
    $activeSdk = Join-Path $env:APPDATA 'Garmin\ConnectIQ\current-sdk.cfg'
    if (Test-Path -LiteralPath $activeSdk) {
        $SdkPath = (Get-Content -LiteralPath $activeSdk -Raw).Trim()
    } else {
        $SdkPath = Join-Path $localTools 'sdk'
    }
}
$monkeyc = Join-Path $SdkPath 'bin\monkeyc.bat'
if (-not (Test-Path -LiteralPath $monkeyc -PathType Leaf)) {
    throw 'Install and activate the Connect IQ SDK in SDK Manager, or pass -SdkPath.'
}

if (-not (Get-Command java.exe -ErrorAction SilentlyContinue)) {
    $javaBin = Get-ChildItem -Path "$localTools\java\*\bin\java.exe" -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty DirectoryName
    if (-not $javaBin) {
        throw 'Install a Java runtime such as OpenJDK 21 and add its bin folder to PATH.'
    }
    $env:Path = "$javaBin;$env:Path"
}

$mp3Uri = $null
if (-not [Uri]::TryCreate($Mp3Url, [UriKind]::Absolute, [ref]$mp3Uri) -or
    $mp3Uri.Scheme -ne 'https' -or -not $mp3Uri.Host -or $mp3Uri.UserInfo -or
    $mp3Uri.Fragment -or $Mp3Url -match '[^\x21-\x7e]|["\\]') {
    throw 'Supply a direct HTTPS MP3 URL with no whitespace, credentials, or fragment.'
}

if (-not (Test-Path -LiteralPath $KeyPath -PathType Leaf)) {
    $key = [System.Security.Cryptography.RSA]::Create(4096)
    try {
        $keyFile = [System.IO.Path]::GetFullPath($KeyPath)
        $stream = [System.IO.File]::Open($keyFile, [System.IO.FileMode]::CreateNew)
        try {
            $stream.Write($key.ExportPkcs8PrivateKey())
        } finally {
            $stream.Dispose()
        }
    } finally {
        $key.Dispose()
    }
    Write-Host "Created local signing key at $KeyPath. Keep it for future builds."
}

$config = Join-Path $PSScriptRoot 'source\LocalConfig.mc'
$sourceFingerprint = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData(
    [System.Text.Encoding]::UTF8.GetBytes($Mp3Url)))
$legacyItemId = ''
if ($LiveQueue) {
    $baselinePath = Join-Path $localTools 'cloudflare\feed-baseline.xml'
    if (Test-Path -LiteralPath $baselinePath) {
        $feed = [System.Xml.XmlDocument]::new()
        $feed.XmlResolver = $null
        $feed.Load($baselinePath)
        foreach ($episode in $feed.SelectNodes('/rss/channel/item')) {
            if ($episode.enclosure.url -eq $Mp3Url -and $episode.guid.InnerText) {
                $identity = ConvertTo-Json -InputObject @('upload', @('primary-uploads', $episode.guid.InnerText)) -Compress -Depth 4
                $legacyItemId = 'pj_' + [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData(
                    [System.Text.Encoding]::UTF8.GetBytes($identity))).ToLowerInvariant()
                break
            }
        }
    }
}
Set-Content -LiteralPath $config -Encoding utf8NoBOM -Value @"
module LocalConfig {
    const QUEUE_MODE = $queueMode;
    const SYNC_URL = "$syncUrl";
    const WATCH_TOKEN = "$watchToken";
    const CACHE_BUDGET = 268435456l;
    const CACHE_RESERVE = 67108864l;
    const LEGACY_ITEM_ID = "$legacyItemId";
    const MP3_URL = "$Mp3Url";
    const MP3_SOURCE = "$sourceFingerprint";
}
"@

$outDir = Join-Path $PSScriptRoot 'bin'
New-Item -ItemType Directory -Path $outDir -Force | Out-Null
$output = Join-Path $outDir $(if ($UnitTests) { 'PACEJAMS-TEST.prg' } else { 'PACEJAMS.prg' })
$jungle = Join-Path $PSScriptRoot 'monkey.jungle'
if ($UnitTests) {
    $jungle = Join-Path $outDir 'tests.jungle'
    New-Item -ItemType Directory -Path (Join-Path $outDir 'private-tests') -Force | Out-Null
    Set-Content -LiteralPath $jungle -Encoding utf8NoBOM -Value @'
project.manifest = ../manifest.xml
base.sourcePath = ../source;../test;private-tests
base.resourcePath = ../resources
'@
}
& $monkeyc -v
$compilerArgs = @('-d', 'fr255sm', '-f', $jungle, '-y', $KeyPath, '-o', $output, '-w')
if ($UnitTests) { $compilerArgs += '-t' }
& $monkeyc @compilerArgs
if ($LASTEXITCODE -ne 0) {
    throw 'Build failed. Review the compiler errors above; check the fr255sm device profile if it is missing.'
}
Write-Host "Signed app: $output"
