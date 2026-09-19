[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$GameDir,
    [Parameter(Mandatory = $true)][string]$SourceDir,
    [string]$OutputDir = (Join-Path $PSScriptRoot 'out')
)

$ErrorActionPreference = 'Stop'
$upstreamCommit = 'e6ce5bb1f0e5af1213e59582b645c18027ded476'
$compatVersion = '0.111.0-context.6'
$gameDirPath = (Resolve-Path -LiteralPath $GameDir).Path
$sourceDirPath = (Resolve-Path -LiteralPath $SourceDir).Path
$outputDirPath = [System.IO.Path]::GetFullPath($OutputDir)
$gameAssemblyDir = Join-Path $gameDirPath 'data_sts2_windows_x86_64'
$gameDll = Join-Path $gameAssemblyDir 'sts2.dll'
$patch = Join-Path $PSScriptRoot 'v0.111-compat.patch'
$contextPatch = Join-Path $PSScriptRoot 'decision-context.patch'
if (!(Test-Path -LiteralPath $gameDll -PathType Leaf)) { throw "Game assembly not found: $gameDll" }
if ($outputDirPath.StartsWith($gameDirPath.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or $outputDirPath -eq $gameDirPath) {
    throw 'OutputDir must be outside the game directory; this script never deploys mods.'
}

# Build from immutable git objects, ignoring uncommitted changes in SourceDir.
$resolvedCommit = & git -C $sourceDirPath rev-parse --verify ($upstreamCommit + '^{commit}')
if ($LASTEXITCODE -ne 0 -or $resolvedCommit -ne $upstreamCommit) { throw 'SourceDir does not contain the pinned upstream commit.' }
$sdk = @(& dotnet --list-sdks | ForEach-Object {
    if ($_ -match '^(8\.[0-9.]+)\s+\[(.+)\]$') {
        [pscustomobject]@{ Version = [version]$Matches[1]; Root = $Matches[2] }
    }
} | Sort-Object Version -Descending | Select-Object -First 1)
if ($sdk.Count -eq 0) { throw 'An installed .NET 8 SDK is required. This script never installs or changes SDKs.' }
$compiler = Join-Path $sdk[0].Root ($sdk[0].Version.ToString() + '\Roslyn\bincore\csc.dll')
$dotnetRoot = Split-Path -Parent $sdk[0].Root
$referencePackRoot = Join-Path $dotnetRoot 'packs\Microsoft.NETCore.App.Ref'
$referencePack = Get-ChildItem -LiteralPath $referencePackRoot -Directory | Where-Object { $_.Name -match '^8\.[0-9.]+$' } | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
if ($null -eq $referencePack) { throw 'The .NET 8 reference pack containing the regex generator was not found.' }
$regexGenerator = Join-Path $referencePack.FullName 'analyzers\dotnet\cs\System.Text.RegularExpressions.Generator.dll'
if (!(Test-Path -LiteralPath $regexGenerator -PathType Leaf)) { throw 'The official .NET regex source generator was not found.' }

[void][System.IO.Directory]::CreateDirectory($outputDirPath)
$workDir = Join-Path $outputDirPath ('work-' + [guid]::NewGuid().ToString('N'))
[void][System.IO.Directory]::CreateDirectory($workDir)
$archive = Join-Path $workDir 'upstream.zip'
$patchedSource = Join-Path $workDir 'source'
& git -C $sourceDirPath archive --format=zip ('--output=' + $archive) $upstreamCommit
if ($LASTEXITCODE -ne 0) { throw 'Could not export the pinned upstream source.' }
Expand-Archive -LiteralPath $archive -DestinationPath $patchedSource
# Isolate Git's path discovery from any parent repository containing OutputDir.
& git -C $patchedSource init --quiet
if ($LASTEXITCODE -ne 0) { throw 'Could not initialize the disposable patch work tree.' }
& git -C $patchedSource apply --check -- $patch
if ($LASTEXITCODE -ne 0) { throw 'Compatibility patch does not apply cleanly to the pinned source.' }
& git -C $patchedSource apply -- $patch
if ($LASTEXITCODE -ne 0) { throw 'Could not apply compatibility patch.' }
& git -C $patchedSource apply --check -- $contextPatch
if ($LASTEXITCODE -ne 0) { throw 'Decision context patch does not apply cleanly.' }
& git -C $patchedSource apply -- $contextPatch
if ($LASTEXITCODE -ne 0) { throw 'Could not apply decision context patch.' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'context\DecisionContextBuilder.cs') -Destination (Join-Path $patchedSource 'STS2.Cli.Mod\State\Builders\DecisionContextBuilder.cs')

$modSource = Join-Path $patchedSource 'STS2.Cli.Mod'
$outputDll = Join-Path $outputDirPath 'STS2.Cli.Mod.dll'
$generatedUsings = Join-Path $workDir 'GlobalUsings.g.cs'
$generatedAssemblyInfo = Join-Path $workDir 'AssemblyInfo.g.cs'
$responseFile = Join-Path $outputDirPath 'compile.rsp'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($generatedUsings, @'
global using global::System;
global using global::System.Collections.Generic;
global using global::System.IO;
global using global::System.Linq;
global using global::System.Net.Http;
global using global::System.Threading;
global using global::System.Threading.Tasks;
'@, $utf8)
[System.IO.File]::WriteAllText($generatedAssemblyInfo, @'
[assembly: System.Reflection.AssemblyVersion("0.111.0.7")]
[assembly: System.Reflection.AssemblyFileVersion("0.111.0.7")]
[assembly: System.Reflection.AssemblyInformationalVersion("0.111.0-context.6")]
[assembly: System.Runtime.Versioning.TargetFramework(".NETCoreApp,Version=v9.0")]
'@, $utf8)

# Read assembly metadata without loading or executing game code. Native DLLs are excluded.
$managedReferences = @(foreach ($candidate in Get-ChildItem -LiteralPath $gameAssemblyDir -Filter '*.dll' | Sort-Object Name) {
    try {
        [void][System.Reflection.AssemblyName]::GetAssemblyName($candidate.FullName)
        '/reference:"' + $candidate.FullName + '"'
    } catch [System.BadImageFormatException] { }
})
$sources = @(Get-ChildItem -LiteralPath $modSource -Recurse -Filter '*.cs' -File | Sort-Object FullName)
$compilerArguments = @('/nostdlib+', '/target:library', '/langversion:12', '/nullable:enable', '/optimize+', '/debug:portable', '/deterministic+', ('/out:"' + $outputDll + '"'), ('/pathmap:"' + $workDir + '=/sts2-cli-compat"'))
$compilerArguments += $managedReferences
$compilerArguments += '/analyzer:"' + $regexGenerator + '"'
$compilerArguments += '"' + $generatedUsings + '"'
$compilerArguments += '"' + $generatedAssemblyInfo + '"'
$compilerArguments += $sources | ForEach-Object { '"' + $_.FullName + '"' }
[System.IO.File]::WriteAllLines($responseFile, [string[]]$compilerArguments, $utf8)
& dotnet $compiler /noconfig ('@' + $responseFile) 2>&1 | Tee-Object -FilePath (Join-Path $outputDirPath 'compile.log')
$compileExitCode = $LASTEXITCODE
$evidence = [ordered]@{
    upstreamRepository = 'https://github.com/longkerdandy/STS2-Cli-Mod'
    upstreamCommit = $upstreamCommit
    compatVersion = $compatVersion
    patchSha256 = (Get-FileHash -LiteralPath $patch -Algorithm SHA256).Hash
    contextPatchSha256 = (Get-FileHash -LiteralPath $contextPatch -Algorithm SHA256).Hash
    contextSourceSha256 = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'context\DecisionContextBuilder.cs') -Algorithm SHA256).Hash
    gameAssemblySha256 = (Get-FileHash -LiteralPath $gameDll -Algorithm SHA256).Hash
    compiler = $compiler
    regexGenerator = $regexGenerator
    sourceCount = $sources.Count
    referenceCount = $managedReferences.Count
    responseFile = $responseFile
    compileExitCode = $compileExitCode
    deploymentPerformed = $false
    utc = [DateTime]::UtcNow.ToString('o')
}
if ($compileExitCode -eq 0) {
    $manifest = [System.IO.File]::ReadAllText((Join-Path $modSource 'STS2.Cli.Mod.json.template'))
    [System.IO.File]::WriteAllText((Join-Path $outputDirPath 'STS2.Cli.Mod.json'), $manifest.Replace('$VERSION$', $compatVersion), $utf8)
    $evidence['outputDll'] = $outputDll
    $evidence['outputSha256'] = (Get-FileHash -LiteralPath $outputDll -Algorithm SHA256).Hash
}
[System.IO.File]::WriteAllText((Join-Path $outputDirPath 'build-evidence.json'), ($evidence | ConvertTo-Json -Depth 4), $utf8)
if ($compileExitCode -ne 0) { throw "Compatibility compilation failed with exit code $compileExitCode. See compile.log." }
Write-Host "Built $compatVersion at $outputDll. No files were deployed to the game."
