$ErrorActionPreference = "Stop"

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$v2Root = Join-Path $repoRoot "v2"

Push-Location $v2Root
try {
    & npm.cmd run stage:sidecars
    if ($LASTEXITCODE -ne 0) {
        throw "Sidecar staging failed with exit code $LASTEXITCODE."
    }

    & cargo.exe test --manifest-path "src-tauri\Cargo.toml" windows_local_backend_smoke -- --nocapture
    if ($LASTEXITCODE -ne 0) {
        throw "Local backend smoke failed with exit code $LASTEXITCODE."
    }

    Write-Host "PASS: local v2 smoke completed with one final FFmpeg encode and cleanup."
}
finally {
    Pop-Location
}
