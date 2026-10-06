param(
    [Parameter(Mandatory = $true)]
    [string]$Url,

    [double]$Start = 5,
    [double]$End = 10,

    [ValidateSet("Best", "1080", "720", "480", "360")]
    [string]$Quality = "360"
)

$ErrorActionPreference = "Stop"

function Format-SectionTimestamp([double]$Seconds) {
    if ($Seconds -lt 0) { throw "Timestamp must be non-negative." }
    $hours = [math]::Floor($Seconds / 3600)
    $minutes = [math]::Floor(($Seconds % 3600) / 60)
    $remaining = $Seconds % 60
    return "{0:00}:{1:00}:{2:00.000}" -f $hours, $minutes, $remaining
}

function Assert-ExitCode([string]$Name, [string]$ErrorFile) {
    if ($LASTEXITCODE -ne 0) {
        $details = if (Test-Path -LiteralPath $ErrorFile) {
            (Get-Content -LiteralPath $ErrorFile -Raw -ErrorAction SilentlyContinue).Trim()
        } else { "" }
        throw "$Name failed with exit code $LASTEXITCODE. $details"
    }
}

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$v2Root = Join-Path $repoRoot "v2"
$binDir = Join-Path $v2Root "src-tauri\binaries"
$triple = "x86_64-pc-windows-msvc"
$yt = Join-Path $binDir "yt-dlp-$triple.exe"
$ffprobe = Join-Path $binDir "ffprobe-$triple.exe"
$stagedFfmpeg = Join-Path $binDir "ffmpeg-$triple.exe"
$tempRoot = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) ("mvt-youtube-smoke-" + [guid]::NewGuid().ToString("N"))))
$systemTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())

Push-Location $v2Root
try {
    & npm.cmd run stage:sidecars
    if ($LASTEXITCODE -ne 0) { throw "Sidecar staging failed." }
    if (-not (Test-Path -LiteralPath $yt -PathType Leaf)) { throw "yt-dlp sidecar is missing." }
    if (-not (Test-Path -LiteralPath $ffprobe -PathType Leaf)) { throw "ffprobe sidecar is missing." }
    if (-not (Test-Path -LiteralPath $stagedFfmpeg -PathType Leaf)) { throw "ffmpeg sidecar is missing." }
    if ($End -le $Start) { throw "End must be greater than Start." }

    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    $toolDir = Join-Path $tempRoot "tools"
    New-Item -ItemType Directory -Path $toolDir -Force | Out-Null
    Copy-Item -LiteralPath $stagedFfmpeg -Destination (Join-Path $toolDir "ffmpeg.exe")
    $metadataErr = Join-Path $tempRoot "metadata.stderr.log"

    # Step 1 is metadata-only. No output template and no media download are allowed here.
    $metadataLines = & $yt "--no-playlist" "--skip-download" "-J" $Url 2>$metadataErr
    Assert-ExitCode "YouTube metadata inspection" $metadataErr
    $metadata = ($metadataLines -join "`n") | ConvertFrom-Json
    $sourceDuration = [double]$metadata.duration
    if ($sourceDuration -le 0) { throw "Metadata returned an invalid duration." }
    if ($Start -lt 0 -or $End -gt $sourceDuration) {
        throw "Requested range [$Start, $End] is outside source duration $sourceDuration."
    }
    if ($Start -eq 0 -and [math]::Abs($End - $sourceDuration) -lt 0.001) {
        throw "Smoke refuses a full-source selection."
    }
    $mediaExtensions = @(".mp4", ".webm", ".mkv", ".mov", ".m4a", ".opus", ".ts")
    $beforeMedia = @(Get-ChildItem -LiteralPath $tempRoot -File | Where-Object { $mediaExtensions -contains $_.Extension.ToLowerInvariant() })
    if ($beforeMedia.Count -ne 0) { throw "Metadata-only inspection created a media artifact." }
    Write-Host "Metadata PASS: $($metadata.title) - duration $sourceDuration s; no media downloaded."

    $selector = switch ($Quality) {
        "Best" { "bv*+ba/b" }
        "1080" { "bv[height<=1080][protocol*=m3u8][vcodec^=avc1]+ba[protocol*=m3u8]/b[height<=1080][protocol*=m3u8][vcodec^=avc1]/bv[height<=1080][protocol*=m3u8]+ba[protocol*=m3u8]/b[height<=1080][protocol*=m3u8]/bv*[height<=1080]+ba/b[height<=1080]" }
        "720" { "bv[height<=720][protocol*=m3u8][vcodec^=avc1]+ba[protocol*=m3u8]/b[height<=720][protocol*=m3u8][vcodec^=avc1]/bv[height<=720][protocol*=m3u8]+ba[protocol*=m3u8]/b[height<=720][protocol*=m3u8]/bv*[height<=720]+ba/b[height<=720]" }
        "480" { "bv[height<=480][protocol*=m3u8][vcodec^=avc1]+ba[protocol*=m3u8]/b[height<=480][protocol*=m3u8][vcodec^=avc1]/bv[height<=480][protocol*=m3u8]+ba[protocol*=m3u8]/b[height<=480][protocol*=m3u8]/bv*[height<=480]+ba/b[height<=480]" }
        "360" { "bv[height<=360][protocol*=m3u8][vcodec^=avc1]+ba[protocol*=m3u8]/b[height<=360][protocol*=m3u8][vcodec^=avc1]/bv[height<=360][protocol*=m3u8]+ba[protocol*=m3u8]/b[height<=360][protocol*=m3u8]/bv*[height<=360]+ba/b[height<=360]" }
    }

    $section = "*$(Format-SectionTimestamp $Start)-$(Format-SectionTimestamp $End)"
    $downloadErr = Join-Path $tempRoot "download.stderr.log"
    $template = Join-Path $tempRoot "partial.%(ext)s"
    $downloadArgs = @(
        "--ffmpeg-location", $toolDir,
        "--no-playlist",
        "--newline",
        "--download-sections", $section,
        "--print", "after_move:FINAL_FILE:%(filepath)s",
        "-f", $selector,
        "--no-overwrites",
        "-o", $template,
        $Url
    )
    $downloadLines = & $yt @downloadArgs 2>$downloadErr
    Assert-ExitCode "Partial YouTube download" $downloadErr
    $finalLine = @($downloadLines | Where-Object { $_ -like "FINAL_FILE:*" }) | Select-Object -Last 1
    if (-not $finalLine) { throw "yt-dlp did not report the downloaded partial file." }
    $partialPath = $finalLine.Substring("FINAL_FILE:".Length).Trim()
    if (-not (Test-Path -LiteralPath $partialPath -PathType Leaf)) { throw "Partial file is missing: $partialPath" }

    $probeErr = Join-Path $tempRoot "probe.stderr.log"
    $probeLines = & $ffprobe "-v" "error" "-show_streams" "-show_format" "-of" "json" $partialPath 2>$probeErr
    Assert-ExitCode "Partial ffprobe" $probeErr
    $probe = ($probeLines -join "`n") | ConvertFrom-Json
    $partialDuration = [double]$probe.format.duration
    $requestedDuration = $End - $Start
    if ($partialDuration -le 0) { throw "Partial download has an invalid duration." }
    if ($partialDuration -ge ($sourceDuration - 0.25)) { throw "Downloaded artifact looks like the full source." }
    if ($partialDuration -gt ($requestedDuration + 5.0)) { throw "Partial duration is unexpectedly larger than the requested section." }

    $mediaFiles = @(Get-ChildItem -LiteralPath $tempRoot -File | Where-Object { $mediaExtensions -contains $_.Extension.ToLowerInvariant() })
    if ($mediaFiles.Count -ne 1) {
        throw "Expected exactly one partial media artifact, found $($mediaFiles.Count)."
    }
    if ([System.IO.Path]::GetFullPath($mediaFiles[0].FullName) -ne [System.IO.Path]::GetFullPath($partialPath)) {
        throw "Unexpected media artifact exists beside the selected partial."
    }

    Write-Host "PASS: metadata-only first, then strict partial download $Start-$End s; no full-video artifact created."
}
finally {
    Pop-Location
    if ((Test-Path -LiteralPath $tempRoot) -and $tempRoot.StartsWith($systemTemp, [System.StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
