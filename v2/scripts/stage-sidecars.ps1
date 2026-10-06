$ErrorActionPreference = "Stop"

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$commonGitDir = (& git -C $repoRoot rev-parse --path-format=absolute --git-common-dir).Trim()
if ($LASTEXITCODE -ne 0 -or -not $commonGitDir) {
    throw "Could not resolve the repository root for sidecar staging."
}

$mainRepoRoot = Split-Path -Parent $commonGitDir
$destinationDir = Join-Path $repoRoot "v2\src-tauri\binaries"
$targetTriple = "x86_64-pc-windows-msvc"
$binaryNames = @("ffmpeg", "ffprobe", "yt-dlp")

New-Item -ItemType Directory -Path $destinationDir -Force | Out-Null

foreach ($name in $binaryNames) {
    $localSource = Join-Path $repoRoot "bin\$name.exe"
    $mainSource = Join-Path $mainRepoRoot "bin\$name.exe"
    $source = if (Test-Path -LiteralPath $localSource -PathType Leaf) { $localSource } else { $mainSource }

    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Required sidecar '$name.exe' is missing. Checked '$localSource' and '$mainSource'."
    }

    $destination = Join-Path $destinationDir "$name-$targetTriple.exe"
    Copy-Item -LiteralPath $source -Destination $destination -Force
}

Write-Host "Staged ffmpeg, ffprobe, and yt-dlp sidecars for $targetTriple."
