Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$CogcoinPackageName = "@cogcoin/client"
$CogcoinInstallCommand = "npm install -g @cogcoin/client"
$CogcoinMinNodeMajor = 22
$CogcoinPinnedNodeVersion = "22.22.2"
$CogcoinNodeDistBaseUrl = "https://nodejs.org/dist/v$CogcoinPinnedNodeVersion"

function Write-Step {
  param([string]$Message)
  Write-Host "==> $Message"
}

function Write-WarningMessage {
  param([string]$Message)
  Write-Warning $Message
}

function Fail-Install {
  param([string]$Message)
  throw $Message
}

function Get-ProcessorArch {
  $arch = $env:PROCESSOR_ARCHITECTURE
  if ($arch -eq "ARM64") {
    return "arm64"
  }
  if ($arch -eq "AMD64") {
    return "x64"
  }
  Fail-Install "Unsupported CPU architecture: $arch. Supported architectures are x64 and arm64."
}

function Resolve-DataRoot {
  if ($env:COGCOIN_INSTALL_ROOT) {
    if (-not [System.IO.Path]::IsPathRooted($env:COGCOIN_INSTALL_ROOT)) {
      Fail-Install "COGCOIN_INSTALL_ROOT must be an absolute path."
    }
    return $env:COGCOIN_INSTALL_ROOT
  }

  if (-not $env:LOCALAPPDATA) {
    Fail-Install "LOCALAPPDATA is required on Windows."
  }

  return (Join-Path $env:LOCALAPPDATA "Cogcoin")
}

function Get-NodeMajor {
  param([string]$VersionText)

  if (-not $VersionText) {
    return $null
  }

  $trimmed = $VersionText.TrimStart("v")
  $parts = $trimmed.Split(".")
  if ($parts.Count -lt 1) {
    return $null
  }

  [int]$major = 0
  if (-not [int]::TryParse($parts[0], [ref]$major)) {
    return $null
  }

  return $major
}

function Test-UsableRuntime {
  param(
    [string]$NodePath,
    [string]$NpmPath
  )

  if (-not (Test-Path $NodePath) -or -not (Test-Path $NpmPath)) {
    return $false
  }

  $versionText = & $NodePath -v 2>$null
  $major = Get-NodeMajor -VersionText $versionText
  return $major -ne $null -and $major -ge $CogcoinMinNodeMajor
}

function Download-File {
  param(
    [string]$Url,
    [string]$Destination
  )

  Invoke-WebRequest -Uri $Url -OutFile $Destination
}

function Verify-Checksum {
  param(
    [string]$ArchivePath,
    [string]$ArchiveName,
    [string]$ShasumsPath
  )

  $expected = $null
  foreach ($line in (Get-Content $ShasumsPath)) {
    $parts = $line -split "\s+"
    if ($parts.Count -ge 2 -and $parts[1] -eq $ArchiveName) {
      $expected = $parts[0]
      break
    }
  }

  if (-not $expected) {
    Fail-Install "Could not find a checksum for $ArchiveName."
  }

  $actual = (Get-FileHash -Path $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected.ToLowerInvariant()) {
    Fail-Install "Checksum verification failed for $ArchiveName."
  }
}

function Ensure-ManagedNodeRuntime {
  param(
    [string]$ManagedNodePath,
    [string]$ManagedNpmPath,
    [string]$NodeRoot,
    [string]$CacheRoot
  )

  if (Test-UsableRuntime -NodePath $ManagedNodePath -NpmPath $ManagedNpmPath) {
    Write-Step "Using existing Cogcoin-managed Node.js runtime: $(& $ManagedNodePath -v)."
    return @{
      Node = $ManagedNodePath
      Npm = $ManagedNpmPath
    }
  }

  $arch = Get-ProcessorArch
  $archiveName = "node-v$CogcoinPinnedNodeVersion-win-$arch.zip"
  $archiveUrl = "$CogcoinNodeDistBaseUrl/$archiveName"
  $shasumsUrl = "$CogcoinNodeDistBaseUrl/SHASUMS256.txt"
  $tempRoot = Join-Path $CacheRoot ([System.Guid]::NewGuid().ToString("n"))
  New-Item -ItemType Directory -Path $tempRoot | Out-Null
  try {
    $archivePath = Join-Path $tempRoot $archiveName
    $shasumsPath = Join-Path $tempRoot "SHASUMS256.txt"
    $extractRoot = Join-Path $tempRoot "extract"
    $expandedRoot = Join-Path $extractRoot "node-v$CogcoinPinnedNodeVersion-win-$arch"

    Write-Step "Downloading Node.js v$CogcoinPinnedNodeVersion (win/$arch)."
    Download-File -Url $archiveUrl -Destination $archivePath
    Download-File -Url $shasumsUrl -Destination $shasumsPath
    Verify-Checksum -ArchivePath $archivePath -ArchiveName $archiveName -ShasumsPath $shasumsPath

    Expand-Archive -Path $archivePath -DestinationPath $extractRoot -Force
    if (-not (Test-Path $expandedRoot)) {
      Fail-Install "The downloaded Node.js archive did not unpack as expected."
    }

    if (Test-Path $NodeRoot) {
      Remove-Item -Path $NodeRoot -Recurse -Force
    }

    Move-Item -Path $expandedRoot -Destination $NodeRoot
  }
  finally {
    if (Test-Path $tempRoot) {
      Remove-Item -Path $tempRoot -Recurse -Force
    }
  }

  if (-not (Test-UsableRuntime -NodePath $ManagedNodePath -NpmPath $ManagedNpmPath)) {
    Fail-Install "The managed Node.js runtime is not usable after installation."
  }

  Write-Step "Using Cogcoin-managed Node.js runtime: $(& $ManagedNodePath -v)."
  return @{
    Node = $ManagedNodePath
    Npm = $ManagedNpmPath
  }
}

function Set-UserPathEntry {
  param([string[]]$Entries)

  $currentUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $parts = New-Object System.Collections.Generic.List[string]
  foreach ($entry in $Entries) {
    if ($entry -and -not $parts.Contains($entry)) {
      $parts.Add($entry)
    }
  }
  if ($currentUserPath) {
    foreach ($part in ($currentUserPath -split ";")) {
      if ($part -and -not $parts.Contains($part)) {
        $parts.Add($part)
      }
    }
  }

  $newUserPath = ($parts -join ";")
  [Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")

  $currentProcessParts = New-Object System.Collections.Generic.List[string]
  foreach ($entry in $Entries) {
    if ($entry -and -not $currentProcessParts.Contains($entry)) {
      $currentProcessParts.Add($entry)
    }
  }
  foreach ($part in ($env:Path -split ";")) {
    if ($part -and -not $currentProcessParts.Contains($part)) {
      $currentProcessParts.Add($part)
    }
  }
  $env:Path = ($currentProcessParts -join ";")
}

function Test-NativeBuildFailure {
  param([string]$LogPath)

  $content = Get-Content $LogPath -Raw
  return $content -match "node-gyp|gyp ERR!|prebuild-install warn install|No prebuilt binaries found|CMake Error|Could not find any Visual Studio installation"
}

function Install-WindowsBuildPrerequisites {
  $pythonPackage = $env:COGCOIN_WINGET_PYTHON_ID
  if (-not $pythonPackage) {
    $pythonPackage = "Python.Python.3.12"
  }

  $cmakePackage = $env:COGCOIN_WINGET_CMAKE_ID
  if (-not $cmakePackage) {
    $cmakePackage = "Kitware.CMake"
  }

  $buildToolsPackage = $env:COGCOIN_WINGET_BUILDTOOLS_ID
  if (-not $buildToolsPackage) {
    $buildToolsPackage = "Microsoft.VisualStudio.2022.BuildTools"
  }

  foreach ($packageId in @($pythonPackage, $cmakePackage, $buildToolsPackage)) {
    & winget install --id $packageId --exact --silent --accept-package-agreements --accept-source-agreements
  }
}

function Run-NpmInstall {
  param(
    [string]$NpmPath,
    [string]$LogPath
  )

  $lines = & $NpmPath install -g $CogcoinPackageName 2>&1
  $lines | Tee-Object -FilePath $LogPath | Out-Host
  return $LASTEXITCODE
}

function Install-ClientWithRetry {
  param(
    [string]$NpmPath,
    [string]$LogPath
  )

  Write-Step "Installing $CogcoinPackageName."
  if ((Run-NpmInstall -NpmPath $NpmPath -LogPath $LogPath) -eq 0) {
    return
  }

  if (-not (Test-NativeBuildFailure -LogPath $LogPath)) {
    Fail-Install "npm install failed. Review $LogPath."
  }

  Write-Step "Installing native build prerequisites and retrying npm install."
  Install-WindowsBuildPrerequisites
  if ((Run-NpmInstall -NpmPath $NpmPath -LogPath $LogPath) -eq 0) {
    return
  }

  Fail-Install "npm install failed after installing native build prerequisites. Review $LogPath."
}

function Main {
  $dataRoot = Resolve-DataRoot
  $bootstrapRoot = Join-Path $dataRoot "bootstrap"
  $cacheRoot = Join-Path $bootstrapRoot "cache"
  $logRoot = Join-Path $bootstrapRoot "logs"
  $nodeRoot = Join-Path $bootstrapRoot "node"
  $managedNodePath = Join-Path $nodeRoot "node.exe"
  $managedNpmPath = Join-Path $nodeRoot "npm.cmd"
  $npmPrefix = Join-Path $bootstrapRoot "npm-global"
  $npmBinDir = $npmPrefix
  $cogcoinCmd = Join-Path $npmPrefix "cogcoin.cmd"

  New-Item -ItemType Directory -Path $bootstrapRoot, $cacheRoot, $logRoot, $npmPrefix -Force | Out-Null

  $runtime = Ensure-ManagedNodeRuntime -ManagedNodePath $managedNodePath -ManagedNpmPath $managedNpmPath -NodeRoot $nodeRoot -CacheRoot $cacheRoot
  $env:Path = "$npmBinDir;$($runtime.Node | Split-Path -Parent);$env:Path"
  Set-UserPathEntry -Entries @($npmBinDir, ($runtime.Node | Split-Path -Parent))

  & $runtime.Npm config set prefix $npmPrefix --location=user | Out-Null
  $installLog = Join-Path $logRoot "npm-install.log"
  Install-ClientWithRetry -NpmPath $runtime.Npm -LogPath $installLog

  if (-not (Test-Path $cogcoinCmd)) {
    Fail-Install "The Cogcoin CLI was not found at $cogcoinCmd after installation."
  }

  if ($env:COGCOIN_SKIP_INIT -eq "1") {
    Write-Step "Skipping `cogcoin init` because COGCOIN_SKIP_INIT=1."
    return
  }

  if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) {
    Write-Step "Installation completed."
    Write-Host "Run & `"$cogcoinCmd`" init in an interactive terminal to continue."
    return
  }

  Write-Step "Starting `cogcoin init`."
  & $cogcoinCmd init
}

Main
