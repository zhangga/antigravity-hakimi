<#
.SYNOPSIS
  Build standalone Windows Antigravity Hakimi (%LOCALAPPDATA%\Programs\Hakimi)
  without ever modifying official Antigravity installation.

.EXAMPLE
  .\build-hakimi.ps1
  .\build-hakimi.ps1 --stage-only
  .\build-hakimi.ps1 --no-restart --client-lang zh-CN
#>
[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$PassThruArgs
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-Error 'Node.js (>= 22.4.0) is required. Please install Node.js first.'
  exit 1
}

$nodeVerRaw = (& node -v).Trim()
if ($nodeVerRaw -match '^v(\d+)\.(\d+)') {
  $major = [int]$Matches[1]
  $minor = [int]$Matches[2]
  if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 4)) {
    Write-Error "Node.js >= 22.4.0 required, found $nodeVerRaw"
    exit 1
  }
}

Write-Host '==> [0/5] 构建前端渲染器 bundle (meter-renderer.js)'
& node (Join-Path $ScriptDir 'scripts\build-renderer.js')
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

& node (Join-Path $ScriptDir 'scripts\build-hakimi-win.js') @PassThruArgs
exit $LASTEXITCODE
