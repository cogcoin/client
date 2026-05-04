Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$CogcoinPackageName = "@cogcoin/client"
$CogcoinInstallCommand = "npm install -g @cogcoin/client"
$CogcoinMinNodeMajor = 22
$CogcoinPinnedNodeVersion = "22.22.2"
$CogcoinNodeDistBaseUrl = "https://nodejs.org/dist/v$CogcoinPinnedNodeVersion"
$CogcoinTotalPhases = 7

function Write-Phase {
  param(
    [int]$Index,
    [string]$Message
  )

  Write-Host "==> [$Index/$CogcoinTotalPhases] $Message"
}

function Write-Detail {
  param([string]$Message)
  Write-Host "    $Message"
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
    $versionText = & $ManagedNodePath -v
    Write-Detail "Reusing the existing Cogcoin-managed Node.js runtime."
    Write-Detail "Managed Node path: $ManagedNodePath"
    Write-Detail "Using Node.js version: $versionText"
    return @{
      Node = $ManagedNodePath
      Npm = $ManagedNpmPath
      Version = $versionText
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

    Write-Detail "No managed Node.js runtime was found. Downloading a fresh copy."
    Write-Detail "Downloading Node.js archive: $archiveName."
    Download-File -Url $archiveUrl -Destination $archivePath
    Write-Detail "Downloading checksum manifest: $shasumsUrl."
    Download-File -Url $shasumsUrl -Destination $shasumsPath
    Write-Detail "Verifying SHA-256 checksum for $archiveName."
    Verify-Checksum -ArchivePath $archivePath -ArchiveName $archiveName -ShasumsPath $shasumsPath
    Write-Detail "Checksum verified."

    Write-Detail "Installing managed Node.js runtime to $NodeRoot."
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

  $installedVersion = & $ManagedNodePath -v
  Write-Detail "Managed Node.js runtime installed successfully."
  Write-Detail "Managed Node path: $ManagedNodePath"
  Write-Detail "Using Node.js version: $installedVersion"
  return @{
    Node = $ManagedNodePath
    Npm = $ManagedNpmPath
    Version = $installedVersion
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
    Write-Detail "Installing winget package: $packageId."
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
    [string]$LogPath,
    [string]$CliPath
  )

  Write-Detail "Package: $CogcoinPackageName"
  Write-Detail "CLI target path: $CliPath"
  Write-Detail "Running: $CogcoinInstallCommand"
  if ((Run-NpmInstall -NpmPath $NpmPath -LogPath $LogPath) -eq 0) {
    Write-Detail "npm install completed successfully."
    return
  }

  if (-not (Test-NativeBuildFailure -LogPath $LogPath)) {
    Fail-Install "npm install failed. Review $LogPath."
  }

  Write-Detail "Detected a native build failure."
  Write-Detail "Installing native build prerequisites and retrying npm install."
  Install-WindowsBuildPrerequisites
  if ((Run-NpmInstall -NpmPath $NpmPath -LogPath $LogPath) -eq 0) {
    Write-Detail "npm install completed successfully after remediation."
    return
  }

  Fail-Install "npm install failed after installing native build prerequisites. Review $LogPath."
}

function Write-FollowUpCommand {
  param([string]$CogcoinCmd)
  Write-Host "Run & `"$CogcoinCmd`" init in an interactive terminal to continue."
}

function Main {
  $arch = Get-ProcessorArch
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

  Write-Phase -Index 1 -Message "Detect platform and install location"
  New-Item -ItemType Directory -Path $bootstrapRoot, $cacheRoot, $logRoot, $npmPrefix -Force | Out-Null
  Write-Detail "Platform: win32"
  Write-Detail "Architecture: $arch"
  Write-Detail "Install root: $dataRoot"
  Write-Detail "Managed Node path: $managedNodePath"
  Write-Detail "Cogcoin CLI path: $cogcoinCmd"
  Write-Detail "Persistent PATH target: current user Path environment variable"

  Write-Phase -Index 2 -Message "Prepare bootstrap tools"
  Write-Detail "PowerShell provides the bootstrap download tools needed for this installer."

  Write-Phase -Index 3 -Message "Prepare managed Node.js runtime"
  $runtime = Ensure-ManagedNodeRuntime -ManagedNodePath $managedNodePath -ManagedNpmPath $managedNpmPath -NodeRoot $nodeRoot -CacheRoot $cacheRoot

  Write-Phase -Index 4 -Message "Configure PATH and npm prefix"
  Write-Detail "Updating PATH for the current PowerShell session."
  $env:Path = "$npmBinDir;$($runtime.Node | Split-Path -Parent);$env:Path"
  Write-Detail "Added to PATH: $($runtime.Node | Split-Path -Parent)"
  Write-Detail "Added to PATH: $npmBinDir"
  Write-Detail "Persisting PATH entries to the current user's Path environment variable."
  Set-UserPathEntry -Entries @($npmBinDir, ($runtime.Node | Split-Path -Parent))
  Write-Detail "Persistent PATH entries are up to date."
  Write-Detail "Configuring npm global prefix: $npmPrefix."
  & $runtime.Npm config set prefix $npmPrefix --location=user | Out-Null
  Write-Detail "npm global prefix configured."

  Write-Phase -Index 5 -Message "Install the Cogcoin CLI"
  $installLog = Join-Path $logRoot "npm-install.log"
  Install-ClientWithRetry -NpmPath $runtime.Npm -LogPath $installLog -CliPath $cogcoinCmd

  Write-Phase -Index 6 -Message "Verify the install"
  if (-not (Test-Path $cogcoinCmd)) {
    Fail-Install "The Cogcoin CLI was not found at $cogcoinCmd after installation."
  }
  Write-Detail "Verified Cogcoin CLI at $cogcoinCmd."

  Write-Phase -Index 7 -Message "Complete installation and hand off to cogcoin init"
  if ($env:COGCOIN_SKIP_INIT -eq "1") {
    Write-Detail "Installation completed. `cogcoin init` was skipped because COGCOIN_SKIP_INIT=1."
    Write-FollowUpCommand -CogcoinCmd $cogcoinCmd
    return
  }

  if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) {
    Write-Detail "Installation completed. `cogcoin init` needs an interactive terminal."
    Write-FollowUpCommand -CogcoinCmd $cogcoinCmd
    return
  }

  Write-Detail "Installation completed. Starting `cogcoin init` now."
  & $cogcoinCmd init
}

Main
