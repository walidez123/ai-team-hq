# new-project.ps1 — scaffold a fresh project or adopt an existing one.
#
#   New (path doesn't exist or is empty):
#     .\tools\new-project.ps1 -Name invoice-cli -Path "C:\work\invoice-cli"
#
#   Existing project (adds only what's missing, never overwrites):
#     .\tools\new-project.ps1 -Name invoice-cli -Path "C:\work\invoice-cli" -Adopt
#
# Creates/fills: AGENTS.md, .agents\agents\*, docs\report-template.md, reports\.gitkeep, .gitignore, git init,
# and registers the path in the AI Team HQ registry (projects.json).
param(
    [Parameter(Mandatory = $true)] [string] $Name,
    [Parameter(Mandatory = $true)] [string] $Path,
    [switch] $Adopt
)

$ErrorActionPreference = 'Stop'
$HQ       = Split-Path -Parent $PSScriptRoot          # the AI team folder
$Tpl      = Join-Path $HQ 'templates\project'
$Registry = Join-Path $HQ 'projects.json'

$existed  = Test-Path $Path
$nonEmpty = $existed -and (Get-ChildItem -Force $Path | Measure-Object).Count -gt 0
if ($nonEmpty -and -not $Adopt) {
    Write-Host "Path exists and is not empty: $Path" -ForegroundColor Yellow
    Write-Host "Re-run with -Adopt to add the team scaffold to the existing project." -ForegroundColor Yellow
    exit 2
}

New-Item -ItemType Directory -Force $Path | Out-Null
New-Item -ItemType Directory -Force (Join-Path $Path 'docs'), (Join-Path $Path 'reports'), (Join-Path $Path 'journal'), (Join-Path $Path '.agents\agents') | Out-Null

function Copy-IfMissing([string] $src, [string] $dst) {
    if (-not (Test-Path $dst)) {
        Copy-Item $src $dst -Force
        Write-Host "  + $(Split-Path $dst -Leaf)"
    } else {
        Write-Host "  = kept existing $(Split-Path $dst -Leaf)"
    }
}

Write-Host "Scaffolding $Name at $Path"
Copy-IfMissing (Join-Path $Tpl '.gitignore')            (Join-Path $Path '.gitignore')
Copy-IfMissing (Join-Path $Tpl 'docs\report-template.md') (Join-Path $Path 'docs\report-template.md')
$agentsDst = Join-Path $Path 'AGENTS.md'
if (-not (Test-Path $agentsDst)) {
    (Get-Content (Join-Path $Tpl 'AGENTS.md') -Raw).Replace('{{NAME}}', $Name) | Set-Content $agentsDst -Encoding utf8
    Write-Host '  + AGENTS.md'
} else { Write-Host '  = kept existing AGENTS.md' }
if (-not (Test-Path (Join-Path $Path 'reports\.gitkeep'))) {
    New-Item -ItemType File -Force (Join-Path $Path 'reports\.gitkeep') | Out-Null
    Write-Host '  + reports\.gitkeep'
}

# Copy Antigravity agent definitions if missing
$hqAgents = Join-Path $HQ '.agents\agents'
if (Test-Path $hqAgents) {
    foreach ($f in Get-ChildItem $hqAgents -Filter '*.md') {
        Copy-IfMissing $f.FullName (Join-Path $Path ".agents\agents\$($f.Name)")
    }
}

# git init (skip if already a repo or git missing)
if (-not (Test-Path (Join-Path $Path '.git'))) {
    try {
        git -C $Path init -b main | Out-Null
        Write-Host '  + git repo (branch main)'
    } catch {
        try { git -C $Path init | Out-Null; Write-Host '  + git repo' }
        catch { Write-Host '  ! git unavailable — folder created without repo' -ForegroundColor Yellow }
    }
} else {
    Write-Host '  = existing git repo'
}

# Register in projects.json (de-duplicated by normalized path)
$resolved = (Resolve-Path $Path).Path
$now      = (Get-Date).ToUniversalTime().ToString('o')
$list     = @()
if (Test-Path $Registry) {
    try { $list = @(Get-Content $Registry -Raw | ConvertFrom-Json) } catch { $list = @() }
}
$norm = { param($p) ([string]$p).TrimEnd('\','/').ToLowerInvariant() }
$key  = & $norm $resolved
$list = @($list | Where-Object { (& $norm $_.path) -ne $key })
$list += [pscustomobject]@{ name = $Name; path = $resolved; addedAt = $now; lastUsed = $now }
ConvertTo-Json -InputObject @($list) -Depth 4 | Set-Content $Registry -Encoding utf8
Write-Host "  + registered in $Registry"
Write-Host "Done." -ForegroundColor Green
