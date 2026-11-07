#Requires -Version 7.0
[CmdletBinding()]
param([string]$SdkPath, [switch]$LiveContract)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
if (-not $SdkPath) {
    $activeSdk = Join-Path $env:APPDATA 'Garmin\ConnectIQ\current-sdk.cfg'
    $SdkPath = if (Test-Path -LiteralPath $activeSdk) {
        (Get-Content -LiteralPath $activeSdk -Raw).Trim()
    } else { Join-Path $repo '.spike-tools\sdk' }
}
$config = Join-Path $PSScriptRoot 'source\LocalConfig.mc'
$savedConfig = if (Test-Path -LiteralPath $config) { [System.IO.File]::ReadAllBytes($config) } else { $null }
$startedSimulator = $null
try {
    if ($LiveContract) {
        & python (Join-Path $PSScriptRoot 'prepare_contract_test.py')
        if ($LASTEXITCODE -ne 0) { throw 'Could not prepare the private contract fixture.' }
    }
    & (Join-Path $PSScriptRoot 'build.ps1') -UnitTests -SdkPath $SdkPath
    if (-not (Get-Process simulator -ErrorAction SilentlyContinue)) {
        $startedSimulator = Start-Process -FilePath (Join-Path $SdkPath 'bin\simulator.exe') -WindowStyle Hidden -PassThru
        Start-Sleep -Seconds 2
    }
    $log = Join-Path $PSScriptRoot 'bin\unit-tests.log'
    & (Join-Path $SdkPath 'bin\monkeydo.bat') (Join-Path $PSScriptRoot 'bin\PACEJAMS-TEST.prg') fr255sm /t 2>&1 |
        Tee-Object -FilePath $log
    # monkeydo can exit zero even when unit tests fail.
    if (-not (Select-String -LiteralPath $log -Pattern '^PASSED \(') -or
        (Select-String -LiteralPath $log -Pattern '^FAILED|^ERROR|^Error:')) {
        throw 'Monkey C unit tests failed; inspect bin/unit-tests.log.'
    }
} finally {
    if ($null -ne $savedConfig) { [System.IO.File]::WriteAllBytes($config, $savedConfig) }
    elseif (Test-Path -LiteralPath $config) { Remove-Item -LiteralPath $config }
    if ($null -ne $startedSimulator) { Stop-Process -Id $startedSimulator.Id -ErrorAction SilentlyContinue }
}
