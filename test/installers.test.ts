import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { promisify } from "node:util"
import test from "node:test"

const execFile = promisify(execFileCallback)

const POSIX_INSTALL_SCRIPT_PATH = join(process.cwd(), "install", "install.sh")
const POWERSHELL_INSTALL_SCRIPT_PATH = join(process.cwd(), "install", "install.ps1")

const CORE_COMMANDS = [
  "awk",
  "bash",
  "basename",
  "cat",
  "chmod",
  "cp",
  "dirname",
  "grep",
  "id",
  "mkdir",
  "mktemp",
  "mv",
  "rm",
  "tee",
  "touch",
]

type PlatformName = "Darwin" | "Linux"
type ProcessorName = "arm64" | "x86_64"

interface PosixHarnessOptions {
  shell?: string
  unameS: PlatformName
  unameM: ProcessorName
  createPathRuntime?: boolean
  pathNodeVersion?: string
  npmMode?: "success" | "native-fail-once" | "generic-fail"
  installRootName?: string
  includeCurl?: boolean
  includeTar?: boolean
  includeXz?: boolean
  includeBrew?: boolean
  includeXcodeSelect?: boolean
  xcodeReadyAfterSleeps?: number
  aptProvisionTools?: string[]
}

interface PosixHarness {
  root: string
  home: string
  installRoot: string
  stubDir: string
  helperDir: string
  logDir: string
  coreDir: string
  brewRoot: string
  env: NodeJS.ProcessEnv
  profileFile: string
  prefixFile: string
  attemptFile: string
  cogcoinLogFile: string
  xcodeStateFile: string
}

async function makeTempRoot(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), `${prefix}-`))
}

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content, "utf8")
  await chmod(path, 0o755)
}

async function resolveSystemCommand(name: string): Promise<string> {
  const candidates = [
    join("/usr/bin", name),
    join("/bin", name),
    join("/opt/homebrew/bin", name),
    join("/usr/local/bin", name),
  ]

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      continue
    }
  }

  throw new Error(`Could not resolve a system command for ${name}`)
}

async function linkSystemCommand(path: string, name: string): Promise<void> {
  await symlink(await resolveSystemCommand(name), path)
}

function createNodeStub(versionExpression: string): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "if [ \"${1:-}\" = \"-v\" ]; then",
    `  printf '%s\\n' "${versionExpression}"`,
    "  exit 0",
    "fi",
    "printf 'unsupported node invocation: %s\\n' \"$*\" >&2",
    "exit 1",
    "",
  ].join("\n")
}

function createNpmStub(): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "log_dir=\"${FAKE_STUB_LOG_DIR:?}\"",
    "attempt_file=\"${FAKE_NPM_ATTEMPT_FILE:?}\"",
    "prefix_file=\"${FAKE_NPM_PREFIX_FILE:?}\"",
    "mode=\"${FAKE_NPM_MODE:-success}\"",
    "printf '%s\\n' \"$*\" >> \"$log_dir/npm-invocations.log\"",
    "if [ \"${1:-}\" = \"config\" ] && [ \"${2:-}\" = \"set\" ] && [ \"${3:-}\" = \"prefix\" ]; then",
    "  mkdir -p \"$(dirname \"$prefix_file\")\"",
    "  printf '%s' \"$4\" > \"$prefix_file\"",
    "  exit 0",
    "fi",
    "if [ \"${1:-}\" = \"install\" ] && [ \"${2:-}\" = \"-g\" ]; then",
    "  attempts=0",
    "  if [ -f \"$attempt_file\" ]; then",
    "    attempts=\"$(cat \"$attempt_file\")\"",
    "  fi",
    "  attempts=$((attempts + 1))",
    "  printf '%s' \"$attempts\" > \"$attempt_file\"",
    "  if [ \"$mode\" = \"native-fail-once\" ] && [ \"$attempts\" -eq 1 ]; then",
    "    printf 'prebuild-install warn install No prebuilt binaries found\\n' >&2",
    "    printf 'gyp ERR! build error\\n' >&2",
    "    exit 1",
    "  fi",
    "  if [ \"$mode\" = \"generic-fail\" ]; then",
    "    printf 'npm ERR! registry unavailable\\n' >&2",
    "    exit 1",
    "  fi",
    "  prefix=\"$(cat \"$prefix_file\")\"",
    "  mkdir -p \"$prefix/bin\"",
    "  cat > \"$prefix/bin/cogcoin\" <<'EOF'",
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "printf '%s\\n' \"$*\" >> \"${FAKE_COGCOIN_LOG_FILE:?}\"",
    "EOF",
    "  chmod +x \"$prefix/bin/cogcoin\"",
    "  printf 'installed %s\\n' \"$3\"",
    "  exit 0",
    "fi",
    "printf 'unsupported npm invocation: %s\\n' \"$*\" >&2",
    "exit 1",
    "",
  ].join("\n")
}

function createUnameStub(): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "case \"${1:-}\" in",
    "  -s)",
    "    printf '%s\\n' \"${FAKE_UNAME_S:?}\"",
    "    ;;",
    "  -m)",
    "    printf '%s\\n' \"${FAKE_UNAME_M:?}\"",
    "    ;;",
    "  *)",
    "    printf '%s\\n' \"${FAKE_UNAME_S:?}\"",
    "    ;;",
    "esac",
    "",
  ].join("\n")
}

function createCurlStub(): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "log_dir=\"${FAKE_STUB_LOG_DIR:?}\"",
    "printf '%s\\n' \"$*\" >> \"$log_dir/curl.log\"",
    "destination=\"\"",
    "url=\"\"",
    "while [ \"$#\" -gt 0 ]; do",
    "  case \"$1\" in",
    "    -o)",
    "      destination=\"$2\"",
    "      shift 2",
    "      ;;",
    "    -*)",
    "      shift",
    "      ;;",
    "    *)",
    "      url=\"$1\"",
    "      shift",
    "      ;;",
    "  esac",
    "done",
    "if [ -z \"$destination\" ] || [ -z \"$url\" ]; then",
    "  printf 'curl stub expected both url and destination\\n' >&2",
    "  exit 1",
    "fi",
    "if [ \"${FAKE_CURL_MODE:-archive}\" = \"unexpected\" ]; then",
    "  printf 'unexpected curl invocation: %s\\n' \"$url\" >&2",
    "  exit 99",
    "fi",
    "if [ \"${url##*/}\" = \"SHASUMS256.txt\" ]; then",
    "  printf '%s  %s\\n' \"${FAKE_NODE_SHA256:?}\" \"${FAKE_NODE_ARCHIVE_NAME:?}\" > \"$destination\"",
    "  exit 0",
    "fi",
    "printf 'archive:%s\\n' \"$url\" > \"$destination\"",
    "",
  ].join("\n")
}

function createShasumStub(): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "printf '%s  %s\\n' \"${FAKE_NODE_SHA256:?}\" \"$3\"",
    "",
  ].join("\n")
}

function createTarStub(): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "log_dir=\"${FAKE_STUB_LOG_DIR:?}\"",
    "printf '%s\\n' \"$*\" >> \"$log_dir/tar.log\"",
    "destination=\"\"",
    "while [ \"$#\" -gt 0 ]; do",
    "  case \"$1\" in",
    "    -C)",
    "      destination=\"$2\"",
    "      shift 2",
    "      ;;",
    "    *)",
    "      shift",
    "      ;;",
    "  esac",
    "done",
    "if [ -z \"$destination\" ]; then",
    "  printf 'tar stub expected a destination\\n' >&2",
    "  exit 1",
    "fi",
    "extract_dir=\"$destination/${FAKE_NODE_EXTRACT_DIRNAME:?}\"",
    "mkdir -p \"$extract_dir/bin\"",
    "cat > \"$extract_dir/bin/node\" <<'EOF'",
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "if [ \"${1:-}\" = \"-v\" ]; then",
    "  printf '%s\\n' \"${FAKE_MANAGED_NODE_VERSION:-v22.22.2}\"",
    "  exit 0",
    "fi",
    "printf 'unsupported managed node invocation: %s\\n' \"$*\" >&2",
    "exit 1",
    "EOF",
    "chmod +x \"$extract_dir/bin/node\"",
    "cp \"${FAKE_NPM_STUB_SOURCE:?}\" \"$extract_dir/bin/npm\"",
    "chmod +x \"$extract_dir/bin/npm\"",
    "",
  ].join("\n")
}

function createXzStub(): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "printf '%s\\n' \"$*\" >> \"${FAKE_STUB_LOG_DIR:?}/xz.log\"",
    "exit 0",
    "",
  ].join("\n")
}

function createSudoStub(): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "printf '%s\\n' \"$*\" >> \"${FAKE_STUB_LOG_DIR:?}/sudo.log\"",
    "\"$@\"",
    "",
  ].join("\n")
}

function createAptGetStub(): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "printf '%s\\n' \"$*\" >> \"${FAKE_STUB_LOG_DIR:?}/apt-get.log\"",
    "if [ \"${1:-}\" = \"install\" ]; then",
    "  IFS=':' read -r -a tools <<< \"${FAKE_APT_PROVISION_TOOLS:-}\"",
    "  for tool in \"${tools[@]}\"; do",
    "    if [ -z \"$tool\" ]; then",
    "      continue",
    "    fi",
    "    cp \"${FAKE_HELPER_DIR:?}/$tool\" \"${FAKE_STUB_DIR:?}/$tool\"",
    "    chmod +x \"${FAKE_STUB_DIR:?}/$tool\"",
    "  done",
    "fi",
    "exit 0",
    "",
  ].join("\n")
}

function createBrewStub(): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "printf '%s\\n' \"$*\" >> \"${FAKE_STUB_LOG_DIR:?}/brew.log\"",
    "case \"${1:-}\" in",
    "  install)",
    "    mkdir -p \"${FAKE_BREW_ROOT:?}/opt/curl/bin\" \"${FAKE_BREW_ROOT:?}/opt/gnu-tar/bin\" \"${FAKE_BREW_ROOT:?}/opt/xz/bin\"",
    "    cp \"${FAKE_HELPER_DIR:?}/curl\" \"${FAKE_BREW_ROOT:?}/opt/curl/bin/curl\"",
    "    chmod +x \"${FAKE_BREW_ROOT:?}/opt/curl/bin/curl\"",
    "    cp \"${FAKE_HELPER_DIR:?}/gtar\" \"${FAKE_BREW_ROOT:?}/opt/gnu-tar/bin/gtar\"",
    "    chmod +x \"${FAKE_BREW_ROOT:?}/opt/gnu-tar/bin/gtar\"",
    "    cp \"${FAKE_HELPER_DIR:?}/xz\" \"${FAKE_BREW_ROOT:?}/opt/xz/bin/xz\"",
    "    chmod +x \"${FAKE_BREW_ROOT:?}/opt/xz/bin/xz\"",
    "    ;;",
    "  --prefix)",
    "    case \"${2:-}\" in",
    "      curl)",
    "        printf '%s\\n' \"${FAKE_BREW_ROOT:?}/opt/curl\"",
    "        ;;",
    "      gnu-tar)",
    "        printf '%s\\n' \"${FAKE_BREW_ROOT:?}/opt/gnu-tar\"",
    "        ;;",
    "      xz)",
    "        printf '%s\\n' \"${FAKE_BREW_ROOT:?}/opt/xz\"",
    "        ;;",
    "      *)",
    "        printf 'unsupported brew package: %s\\n' \"${2:-}\" >&2",
    "        exit 1",
    "        ;;",
    "    esac",
    "    ;;",
    "  *)",
    "    printf 'unsupported brew invocation: %s\\n' \"$*\" >&2",
    "    exit 1",
    "    ;;",
    "esac",
    "",
  ].join("\n")
}

function createXcodeSelectStub(): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "printf '%s\\n' \"$*\" >> \"${FAKE_STUB_LOG_DIR:?}/xcode-select.log\"",
    "state_file=\"${FAKE_XCODE_STATE_FILE:?}\"",
    "case \"${1:-}\" in",
    "  -p)",
    "    if [ ! -f \"$state_file\" ]; then",
    "      exit 1",
    "    fi",
    "    state=\"$(cat \"$state_file\")\"",
    "    if [ \"$state\" -le 0 ]; then",
    "      printf '%s\\n' '/Library/Developer/CommandLineTools'",
    "      exit 0",
    "    fi",
    "    exit 1",
    "    ;;",
    "  --install)",
    "    exit 0",
    "    ;;",
    "  *)",
    "    printf 'unsupported xcode-select invocation: %s\\n' \"$*\" >&2",
    "    exit 1",
    "    ;;",
    "esac",
    "",
  ].join("\n")
}

function createSleepStub(): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "printf '%s\\n' \"$*\" >> \"${FAKE_STUB_LOG_DIR:?}/sleep.log\"",
    "state_file=\"${FAKE_XCODE_STATE_FILE:?}\"",
    "if [ -f \"$state_file\" ]; then",
    "  state=\"$(cat \"$state_file\")\"",
    "  if [ \"$state\" -gt 0 ]; then",
    "    state=$((state - 1))",
    "    printf '%s' \"$state\" > \"$state_file\"",
    "  fi",
    "fi",
    "exit 0",
    "",
  ].join("\n")
}

async function createPosixHarness(options: PosixHarnessOptions): Promise<PosixHarness> {
  const root = await makeTempRoot("cogcoin-client-install")
  const home = join(root, "home")
  const installRoot = join(root, options.installRootName ?? "install root")
  const stubDir = join(root, "bin")
  const helperDir = join(root, "helpers")
  const logDir = join(root, "logs")
  const coreDir = join(root, "core")
  const brewRoot = join(root, "homebrew")
  const prefixFile = join(root, "prefix.txt")
  const attemptFile = join(root, "attempts.txt")
  const cogcoinLogFile = join(root, "cogcoin.log")
  const xcodeStateFile = join(root, "xcode-state.txt")
  const profileFile = join(home, options.shell === "/bin/zsh" ? ".zshrc" : ".bashrc")
  const nodeArchiveName = `node-v22.22.2-${options.unameS === "Darwin" ? "darwin" : "linux"}-${options.unameM === "x86_64" ? "x64" : "arm64"}.${options.unameS === "Darwin" ? "tar.gz" : "tar.xz"}`
  const nodeExtractDirname = basename(nodeArchiveName, options.unameS === "Darwin" ? ".tar.gz" : ".tar.xz")

  await mkdir(home, { recursive: true })
  await mkdir(stubDir, { recursive: true })
  await mkdir(helperDir, { recursive: true })
  await mkdir(logDir, { recursive: true })
  await mkdir(coreDir, { recursive: true })
  await mkdir(brewRoot, { recursive: true })

  for (const command of CORE_COMMANDS) {
    await linkSystemCommand(join(coreDir, command), command)
  }

  const npmStubSource = join(helperDir, "npm")
  await writeExecutable(npmStubSource, createNpmStub())
  await writeExecutable(join(helperDir, "curl"), createCurlStub())
  await writeExecutable(join(helperDir, "tar"), createTarStub())
  await writeExecutable(join(helperDir, "gtar"), createTarStub())
  await writeExecutable(join(helperDir, "xz"), createXzStub())

  await writeExecutable(join(stubDir, "uname"), createUnameStub())
  await writeExecutable(join(stubDir, "shasum"), createShasumStub())
  await writeExecutable(join(stubDir, "sudo"), createSudoStub())
  await writeExecutable(join(stubDir, "apt-get"), createAptGetStub())
  await writeExecutable(join(stubDir, "sleep"), createSleepStub())

  if (options.includeCurl ?? true) {
    await writeExecutable(join(stubDir, "curl"), createCurlStub())
  }
  if (options.includeTar ?? true) {
    await writeExecutable(join(stubDir, "tar"), createTarStub())
  }
  if (options.includeXz ?? true) {
    await writeExecutable(join(stubDir, "xz"), createXzStub())
  }
  if (options.includeBrew) {
    await writeExecutable(join(stubDir, "brew"), createBrewStub())
  }
  if (options.includeXcodeSelect) {
    await writeExecutable(join(stubDir, "xcode-select"), createXcodeSelectStub())
  }

  if (options.createPathRuntime) {
    await writeExecutable(join(stubDir, "node"), createNodeStub("${FAKE_PATH_NODE_VERSION:?}"))
    await writeExecutable(join(stubDir, "npm"), createNpmStub())
  }

  if (options.xcodeReadyAfterSleeps !== undefined) {
    await writeFile(xcodeStateFile, String(options.xcodeReadyAfterSleeps), "utf8")
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    SHELL: options.shell ?? "/bin/bash",
    PATH: `${stubDir}:${coreDir}`,
    COGCOIN_INSTALL_ROOT: installRoot,
    FAKE_UNAME_S: options.unameS,
    FAKE_UNAME_M: options.unameM,
    FAKE_NODE_SHA256: "abc123",
    FAKE_NODE_ARCHIVE_NAME: nodeArchiveName,
    FAKE_NODE_EXTRACT_DIRNAME: nodeExtractDirname,
    FAKE_MANAGED_NODE_VERSION: "v22.22.2",
    FAKE_STUB_LOG_DIR: logDir,
    FAKE_STUB_DIR: stubDir,
    FAKE_HELPER_DIR: helperDir,
    FAKE_BREW_ROOT: brewRoot,
    FAKE_XCODE_STATE_FILE: xcodeStateFile,
    FAKE_NPM_STUB_SOURCE: npmStubSource,
    FAKE_NPM_PREFIX_FILE: prefixFile,
    FAKE_NPM_ATTEMPT_FILE: attemptFile,
    FAKE_COGCOIN_LOG_FILE: cogcoinLogFile,
    FAKE_NPM_MODE: options.npmMode ?? "success",
    FAKE_CURL_MODE: "archive",
    FAKE_APT_PROVISION_TOOLS: (options.aptProvisionTools ?? ["curl", "tar", "xz"]).join(":"),
  }

  if (options.createPathRuntime) {
    env.FAKE_PATH_NODE_VERSION = options.pathNodeVersion ?? "v22.11.0"
  }

  return {
    root,
    home,
    installRoot,
    stubDir,
    helperDir,
    logDir,
    coreDir,
    brewRoot,
    env,
    profileFile,
    prefixFile,
    attemptFile,
    cogcoinLogFile,
    xcodeStateFile,
  }
}

async function seedManagedRuntime(harness: PosixHarness): Promise<void> {
  const managedNodeDir = join(harness.installRoot, "bootstrap", "node", "bin")
  await mkdir(managedNodeDir, { recursive: true })
  await writeExecutable(join(managedNodeDir, "node"), createNodeStub("v22.22.2"))
  await writeExecutable(join(managedNodeDir, "npm"), createNpmStub())
}

function cogcoinBinPath(harness: PosixHarness): string {
  return join(harness.installRoot, "bootstrap", "npm-global", "bin", "cogcoin")
}

function managedNpmPath(harness: PosixHarness): string {
  return join(harness.installRoot, "bootstrap", "node", "bin", "npm")
}

async function runInstallSh(harness: PosixHarness, extraEnv: NodeJS.ProcessEnv = {}) {
  return await execFile("/bin/bash", [POSIX_INSTALL_SCRIPT_PATH], {
    cwd: harness.root,
    env: {
      ...harness.env,
      ...extraEnv,
    },
    maxBuffer: 1024 * 1024 * 8,
  })
}

async function runInstallerSnippet(harness: PosixHarness, scriptBody: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return await execFile("/bin/bash", ["-c", scriptBody], {
    cwd: harness.root,
    env: {
      ...harness.env,
      ...extraEnv,
    },
    maxBuffer: 1024 * 1024 * 8,
  })
}

function countOccurrences(text: string, token: string): number {
  return text.split(token).length - 1
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

test("install.sh bootstraps a managed Node runtime when no usable node is on PATH", async () => {
  const harness = await createPosixHarness({
    unameS: "Darwin",
    unameM: "arm64",
    shell: "/bin/zsh",
  })

  try {
    const result = await runInstallSh(harness, {
      COGCOIN_SKIP_INIT: "1",
    })

    assert.match(result.stdout, /Downloading Node\.js v22\.22\.2/)
    assert.match(result.stdout, /Using Cogcoin-managed Node\.js runtime: v22\.22\.2\./)
    assert.match(result.stdout, /Skipping `cogcoin init` because COGCOIN_SKIP_INIT=1\./)
    await access(join(harness.installRoot, "bootstrap", "node", "bin", "node"), constants.X_OK)
    await access(cogcoinBinPath(harness), constants.X_OK)

    const profileText = await readFile(join(harness.home, ".zshrc"), "utf8")
    assert.match(profileText, /# >>> cogcoin installer >>>/)
    assert.match(profileText, /bootstrap\/node\/bin/)
    assert.match(profileText, /bootstrap\/npm-global\/bin/)

    const curlLog = await readFile(join(harness.logDir, "curl.log"), "utf8")
    assert.match(curlLog, /SHASUMS256\.txt/)
    assert.match(curlLog, /node-v22\.22\.2-darwin-arm64\.tar\.gz/)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test("install.sh replaces an outdated PATH node runtime with the managed runtime", async () => {
  const harness = await createPosixHarness({
    unameS: "Linux",
    unameM: "x86_64",
    createPathRuntime: true,
    pathNodeVersion: "v20.12.0",
  })

  try {
    const result = await runInstallSh(harness, {
      COGCOIN_SKIP_INIT: "1",
    })

    assert.match(result.stdout, /Downloading Node\.js v22\.22\.2/)
    assert.doesNotMatch(result.stdout, /Using existing Node\.js runtime/)
    await access(join(harness.installRoot, "bootstrap", "node", "bin", "node"), constants.X_OK)
    await access(cogcoinBinPath(harness), constants.X_OK)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test("install.sh ignores a PATH Node 22 runtime and still provisions the managed runtime", async () => {
  const harness = await createPosixHarness({
    unameS: "Linux",
    unameM: "x86_64",
    createPathRuntime: true,
    pathNodeVersion: "v22.11.0",
  })

  try {
    const result = await runInstallSh(harness, {
      COGCOIN_SKIP_INIT: "1",
    })

    assert.match(result.stdout, /Downloading Node\.js v22\.22\.2/)
    assert.doesNotMatch(result.stdout, /Using existing Node\.js runtime/)
    await access(join(harness.installRoot, "bootstrap", "node", "bin", "node"), constants.X_OK)
    await access(cogcoinBinPath(harness), constants.X_OK)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

for (const missingTool of ["curl", "tar", "xz"] as const) {
  test(`install.sh auto-installs missing Linux bootstrap tool: ${missingTool}`, async () => {
    const harness = await createPosixHarness({
      unameS: "Linux",
      unameM: "x86_64",
      includeCurl: missingTool !== "curl",
      includeTar: missingTool !== "tar",
      includeXz: missingTool !== "xz",
    })

    try {
      const result = await runInstallSh(harness, {
        COGCOIN_SKIP_INIT: "1",
      })

      assert.match(result.stdout, /Installing bootstrap download tools\./)
      const aptLog = await readFile(join(harness.logDir, "apt-get.log"), "utf8")
      assert.match(aptLog, /^update$/m)
      assert.match(aptLog, /install -y curl ca-certificates tar xz-utils/)
      await access(join(harness.installRoot, "bootstrap", "node", "bin", "node"), constants.X_OK)
      await access(cogcoinBinPath(harness), constants.X_OK)
    } finally {
      await rm(harness.root, { recursive: true, force: true })
    }
  })
}

test("install.sh uses Homebrew to provision missing macOS bootstrap tools when Homebrew is already installed", async () => {
  const harness = await createPosixHarness({
    unameS: "Darwin",
    unameM: "arm64",
    includeCurl: false,
    includeTar: false,
    includeBrew: true,
  })

  try {
    const result = await runInstallSh(harness, {
      COGCOIN_SKIP_INIT: "1",
    })

    assert.match(result.stdout, /Installing bootstrap download tools with Homebrew\./)
    const brewLog = await readFile(join(harness.logDir, "brew.log"), "utf8")
    assert.match(brewLog, /install curl gnu-tar xz/)
    await access(join(harness.installRoot, "bootstrap", "node", "bin", "node"), constants.X_OK)
    await access(cogcoinBinPath(harness), constants.X_OK)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test("install.sh fails clearly when macOS is missing bootstrap tools and Homebrew is absent", async () => {
  const harness = await createPosixHarness({
    unameS: "Darwin",
    unameM: "arm64",
    includeCurl: false,
    includeTar: false,
  })

  try {
    await assert.rejects(
      runInstallSh(harness, {
        COGCOIN_SKIP_INIT: "1",
      }),
      (error: NodeJS.ErrnoException & { stderr?: string }) => {
        assert.match(error.stderr ?? "", /missing required tool\(s\): curl tar/)
        assert.match(error.stderr ?? "", /Install Homebrew, then rerun this installer\./)
        return true
      },
    )
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test("install.sh retries after a native addon build failure on Linux", async () => {
  const harness = await createPosixHarness({
    unameS: "Linux",
    unameM: "x86_64",
    npmMode: "native-fail-once",
  })

  try {
    const result = await runInstallSh(harness, {
      COGCOIN_SKIP_INIT: "1",
    })

    assert.match(result.stdout, /Installing native build prerequisites and retrying npm install\./)
    assert.equal((await readFile(harness.attemptFile, "utf8")).trim(), "2")
    const aptLog = await readFile(join(harness.logDir, "apt-get.log"), "utf8")
    assert.match(aptLog, /^update$/m)
    assert.match(aptLog, /install -y build-essential python3 cmake pkg-config xz-utils/)
    await access(cogcoinBinPath(harness), constants.X_OK)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test("install.sh waits for macOS Command Line Tools and retries npm install in the same run", async () => {
  const harness = await createPosixHarness({
    unameS: "Darwin",
    unameM: "arm64",
    includeXcodeSelect: true,
    xcodeReadyAfterSleeps: 2,
    npmMode: "native-fail-once",
  })

  try {
    await seedManagedRuntime(harness)
    await mkdir(join(harness.installRoot, "bootstrap", "npm-global"), { recursive: true })
    await writeFile(harness.prefixFile, join(harness.installRoot, "bootstrap", "npm-global"), "utf8")

    const result = await runInstallerSnippet(
      harness,
      `
source "${POSIX_INSTALL_SCRIPT_PATH}"
can_use_interactive_terminal() { return 0; }
COGCOIN_PLATFORM="darwin"
COGCOIN_LOG_ROOT="${join(harness.installRoot, "bootstrap", "logs")}"
COGCOIN_NPM_PREFIX="${join(harness.installRoot, "bootstrap", "npm-global")}"
COGCOIN_BIN="${cogcoinBinPath(harness)}"
COGCOIN_ACTIVE_NPM_BIN="${managedNpmPath(harness)}"
install_client
`,
    )

    assert.match(result.stdout, /Waiting for Xcode Command Line Tools to finish installing\./)
    assert.match(result.stdout, /Xcode Command Line Tools are ready\. Retrying npm install\./)
    assert.equal((await readFile(harness.attemptFile, "utf8")).trim(), "2")
    await access(cogcoinBinPath(harness), constants.X_OK)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test("install.sh prints an exact resume command for noninteractive macOS Command Line Tools recovery", async () => {
  const harness = await createPosixHarness({
    unameS: "Darwin",
    unameM: "arm64",
    includeXcodeSelect: true,
    xcodeReadyAfterSleeps: 200,
    npmMode: "native-fail-once",
  })

  try {
    await seedManagedRuntime(harness)
    await mkdir(join(harness.installRoot, "bootstrap", "npm-global"), { recursive: true })
    await writeFile(harness.prefixFile, join(harness.installRoot, "bootstrap", "npm-global"), "utf8")

    const result = await runInstallerSnippet(
      harness,
      `
source "${POSIX_INSTALL_SCRIPT_PATH}"
can_use_interactive_terminal() { return 1; }
COGCOIN_PLATFORM="darwin"
COGCOIN_LOG_ROOT="${join(harness.installRoot, "bootstrap", "logs")}"
COGCOIN_NPM_PREFIX="${join(harness.installRoot, "bootstrap", "npm-global")}"
COGCOIN_BIN="${cogcoinBinPath(harness)}"
COGCOIN_ACTIVE_NPM_BIN="${managedNpmPath(harness)}"
install_client
`,
    )

    const expectedCommand = `Run "${managedNpmPath(harness)}" install -g @cogcoin/client && "${cogcoinBinPath(harness)}" init in an interactive terminal to continue.`
    assert.match(result.stdout, new RegExp(escapeRegex(expectedCommand)))
    assert.equal((await readFile(harness.attemptFile, "utf8")).trim(), "1")
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test("install.sh prints the same exact resume command when macOS Command Line Tools setup times out", async () => {
  const harness = await createPosixHarness({
    unameS: "Darwin",
    unameM: "arm64",
    includeXcodeSelect: true,
    xcodeReadyAfterSleeps: 200,
    npmMode: "native-fail-once",
  })

  try {
    await seedManagedRuntime(harness)
    await mkdir(join(harness.installRoot, "bootstrap", "npm-global"), { recursive: true })
    await writeFile(harness.prefixFile, join(harness.installRoot, "bootstrap", "npm-global"), "utf8")

    const result = await runInstallerSnippet(
      harness,
      `
source "${POSIX_INSTALL_SCRIPT_PATH}"
can_use_interactive_terminal() { return 0; }
COGCOIN_PLATFORM="darwin"
COGCOIN_LOG_ROOT="${join(harness.installRoot, "bootstrap", "logs")}"
COGCOIN_NPM_PREFIX="${join(harness.installRoot, "bootstrap", "npm-global")}"
COGCOIN_BIN="${cogcoinBinPath(harness)}"
COGCOIN_ACTIVE_NPM_BIN="${managedNpmPath(harness)}"
install_client
`,
    )

    const expectedCommand = `Run "${managedNpmPath(harness)}" install -g @cogcoin/client && "${cogcoinBinPath(harness)}" init in an interactive terminal to continue.`
    assert.match(result.stdout, /Xcode Command Line Tools are still installing\./)
    assert.match(result.stdout, new RegExp(escapeRegex(expectedCommand)))
    assert.equal(countOccurrences(await readFile(join(harness.logDir, "sleep.log"), "utf8"), "15"), 120)
    assert.equal((await readFile(harness.attemptFile, "utf8")).trim(), "1")
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test("install.sh is idempotent for profile updates and prints an exact follow-up command when noninteractive", async () => {
  const harness = await createPosixHarness({
    unameS: "Linux",
    unameM: "x86_64",
  })

  try {
    const first = await runInstallSh(harness)
    const second = await runInstallSh(harness)

    const expectedCommand = `Run "${cogcoinBinPath(harness)}" init in an interactive terminal to continue.`
    assert.match(first.stdout, new RegExp(escapeRegex(expectedCommand)))
    assert.match(second.stdout, new RegExp(escapeRegex(expectedCommand)))
    assert.match(second.stdout, /Using existing Cogcoin-managed Node\.js runtime: v22\.22\.2\./)

    const profileText = await readFile(join(harness.home, ".bashrc"), "utf8")
    assert.equal(countOccurrences(profileText, "# >>> cogcoin installer >>>"), 1)
    assert.equal(countOccurrences(profileText, "# <<< cogcoin installer <<<"), 1)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test("installer sources keep the intended interactive and Windows contract", async () => {
  const posixScript = await readFile(POSIX_INSTALL_SCRIPT_PATH, "utf8")
  const powershellScript = await readFile(POWERSHELL_INSTALL_SCRIPT_PATH, "utf8")

  assert.match(posixScript, /init < \/dev\/tty/)
  assert.match(posixScript, /COGCOIN_INSTALL_ROOT/)
  assert.match(posixScript, /COGCOIN_SKIP_INIT/)
  assert.match(posixScript, /npm install -g @cogcoin\/client/)
  assert.match(posixScript, /install curl gnu-tar xz/)
  assert.doesNotMatch(posixScript, /Using existing Node\.js runtime/)

  assert.match(powershellScript, /COGCOIN_INSTALL_ROOT/)
  assert.match(powershellScript, /COGCOIN_SKIP_INIT/)
  assert.match(powershellScript, /Using existing Cogcoin-managed Node\.js runtime/)
  assert.match(powershellScript, /SetEnvironmentVariable\("Path", \$newUserPath, "User"\)/)
  assert.match(powershellScript, /winget install --id/)
  assert.match(powershellScript, /Get-FileHash -Path/)
  assert.match(powershellScript, /& \$cogcoinCmd init/)
  assert.doesNotMatch(powershellScript, /Get-CommandPath -Name "node"/)
})

test("installer files and README do not embed private machine-specific paths", async () => {
  const files = [
    POSIX_INSTALL_SCRIPT_PATH,
    POWERSHELL_INSTALL_SCRIPT_PATH,
    join(process.cwd(), "README.md"),
  ]

  for (const path of files) {
    const text = await readFile(path, "utf8")
    assert.doesNotMatch(text, new RegExp(["Drop", "box"].join("")))
    assert.doesNotMatch(text, /\/Users\/[^/\n]+/)
    assert.doesNotMatch(text, /[A-Z]:\\\\Users\\\\[^\\\r\n]+/)
  }
})
