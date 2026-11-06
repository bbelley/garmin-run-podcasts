#Requires -Version 7.0
[CmdletBinding()]
param(
    [string]$Mp3Url = 'https://soniqtools.com/assets/audio/test-audio-mp3-128kbps.mp3',
    [string]$SdkPath,
    [string]$KeyPath = (Join-Path $PSScriptRoot 'developer_key.der')
)

$ErrorActionPreference = 'Stop'
$localTools = Join-Path $PSScriptRoot '..\.spike-tools'

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
Set-Content -LiteralPath $config -Encoding utf8NoBOM -Value @"
module LocalConfig {
    const MP3_URL = "$Mp3Url";
}
"@

$outDir = Join-Path $PSScriptRoot 'bin'
New-Item -ItemType Directory -Path $outDir -Force | Out-Null
$output = Join-Path $outDir 'OUTBACK.prg'
$jungle = Join-Path $PSScriptRoot 'monkey.jungle'
& $monkeyc -v
& $monkeyc -d fr255sm -f $jungle -y $KeyPath -o $output -w
if ($LASTEXITCODE -ne 0) {
    throw 'Build failed. Confirm that SDK Manager has installed the Forerunner 255s Music (fr255sm) device profile.'
}
Write-Host "Signed app: $output"
