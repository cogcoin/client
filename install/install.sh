#!/usr/bin/env bash
set -euo pipefail

readonly COGCOIN_PACKAGE_NAME="@cogcoin/client"
readonly COGCOIN_INSTALL_COMMAND="npm install -g @cogcoin/client"
readonly COGCOIN_MIN_NODE_MAJOR=22
readonly COGCOIN_PINNED_NODE_VERSION="22.22.2"
readonly COGCOIN_NODE_DIST_BASE_URL="https://nodejs.org/dist/v${COGCOIN_PINNED_NODE_VERSION}"
readonly COGCOIN_PATH_MARKER_START="# >>> cogcoin installer >>>"
readonly COGCOIN_PATH_MARKER_END="# <<< cogcoin installer <<<"
readonly COGCOIN_TOTAL_PHASES=7

COGCOIN_PLATFORM=""
COGCOIN_ARCH=""
COGCOIN_NODE_ARCHIVE_NAME=""
COGCOIN_NODE_ARCHIVE_URL=""
COGCOIN_NODE_SHASUMS_URL=""
COGCOIN_DATA_ROOT=""
COGCOIN_BOOTSTRAP_ROOT=""
COGCOIN_CACHE_ROOT=""
COGCOIN_LOG_ROOT=""
COGCOIN_MANAGED_NODE_ROOT=""
COGCOIN_MANAGED_NODE_BIN_DIR=""
COGCOIN_MANAGED_NODE_BIN=""
COGCOIN_MANAGED_NPM_BIN=""
COGCOIN_NPM_PREFIX=""
COGCOIN_NPM_BIN_DIR=""
COGCOIN_PROFILE_FILE=""
COGCOIN_CURL_BIN=""
COGCOIN_TAR_BIN=""
COGCOIN_XZ_BIN=""
COGCOIN_BREW_BIN=""
COGCOIN_ACTIVE_NODE_BIN=""
COGCOIN_ACTIVE_NPM_BIN=""
COGCOIN_ACTIVE_NODE_VERSION=""
COGCOIN_BIN=""
COGCOIN_LAST_INSTALL_LOG=""

phase() {
  printf '==> [%s/%s] %s\n' "$1" "${COGCOIN_TOTAL_PHASES}" "$2"
}

log() {
  printf '    %s\n' "$*"
}

warn() {
  printf 'warning: %s\n' "$*" >&2
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

extract_node_major() {
  local version major
  version="${1#v}"
  major="${version%%.*}"
  case "$major" in
    ''|*[!0-9]*)
      return 1
      ;;
  esac
  printf '%s' "$major"
}

detect_platform() {
  local kernel machine archive_extension
  kernel="$(uname -s)"
  machine="$(uname -m)"

  case "$kernel" in
    Darwin)
      COGCOIN_PLATFORM="darwin"
      archive_extension="tar.gz"
      ;;
    Linux)
      COGCOIN_PLATFORM="linux"
      archive_extension="tar.xz"
      ;;
    *)
      fail "Unsupported operating system: ${kernel}. Use macOS, Linux, or the Windows PowerShell installer."
      ;;
  esac

  case "$machine" in
    x86_64|amd64)
      COGCOIN_ARCH="x64"
      ;;
    arm64|aarch64)
      COGCOIN_ARCH="arm64"
      ;;
    *)
      fail "Unsupported CPU architecture: ${machine}. Supported architectures are x64 and arm64."
      ;;
  esac

  COGCOIN_NODE_ARCHIVE_NAME="node-v${COGCOIN_PINNED_NODE_VERSION}-${COGCOIN_PLATFORM}-${COGCOIN_ARCH}.${archive_extension}"
  COGCOIN_NODE_ARCHIVE_URL="${COGCOIN_NODE_DIST_BASE_URL}/${COGCOIN_NODE_ARCHIVE_NAME}"
  COGCOIN_NODE_SHASUMS_URL="${COGCOIN_NODE_DIST_BASE_URL}/SHASUMS256.txt"
}

resolve_data_root() {
  local install_root shell_name xdg_data_home

  install_root="${COGCOIN_INSTALL_ROOT:-}"
  if [ -n "${install_root}" ]; then
    case "${install_root}" in
      /*)
        COGCOIN_DATA_ROOT="${install_root}"
        ;;
      *)
        fail "COGCOIN_INSTALL_ROOT must be an absolute path."
        ;;
    esac
  elif [ "${COGCOIN_PLATFORM}" = "darwin" ]; then
    COGCOIN_DATA_ROOT="${HOME}/Library/Application Support/Cogcoin"
  else
    xdg_data_home="${XDG_DATA_HOME:-${HOME}/.local/share}"
    COGCOIN_DATA_ROOT="${xdg_data_home}/cogcoin"
  fi

  COGCOIN_BOOTSTRAP_ROOT="${COGCOIN_DATA_ROOT}/bootstrap"
  COGCOIN_CACHE_ROOT="${COGCOIN_BOOTSTRAP_ROOT}/cache"
  COGCOIN_LOG_ROOT="${COGCOIN_BOOTSTRAP_ROOT}/logs"
  COGCOIN_MANAGED_NODE_ROOT="${COGCOIN_BOOTSTRAP_ROOT}/node"
  COGCOIN_MANAGED_NODE_BIN_DIR="${COGCOIN_MANAGED_NODE_ROOT}/bin"
  COGCOIN_MANAGED_NODE_BIN="${COGCOIN_MANAGED_NODE_BIN_DIR}/node"
  COGCOIN_MANAGED_NPM_BIN="${COGCOIN_MANAGED_NODE_BIN_DIR}/npm"
  COGCOIN_NPM_PREFIX="${COGCOIN_BOOTSTRAP_ROOT}/npm-global"
  COGCOIN_NPM_BIN_DIR="${COGCOIN_NPM_PREFIX}/bin"
  COGCOIN_BIN="${COGCOIN_NPM_BIN_DIR}/cogcoin"

  shell_name="$(basename "${SHELL:-}")"
  case "${shell_name}" in
    zsh)
      COGCOIN_PROFILE_FILE="${HOME}/.zshrc"
      ;;
    bash)
      if [ -f "${HOME}/.bashrc" ]; then
        COGCOIN_PROFILE_FILE="${HOME}/.bashrc"
      elif [ -f "${HOME}/.bash_profile" ]; then
        COGCOIN_PROFILE_FILE="${HOME}/.bash_profile"
      elif [ "${COGCOIN_PLATFORM}" = "darwin" ]; then
        COGCOIN_PROFILE_FILE="${HOME}/.bash_profile"
      else
        COGCOIN_PROFILE_FILE="${HOME}/.bashrc"
      fi
      ;;
    *)
      COGCOIN_PROFILE_FILE="${HOME}/.profile"
      ;;
  esac
}

ensure_base_directories() {
  mkdir -p \
    "${COGCOIN_BOOTSTRAP_ROOT}" \
    "${COGCOIN_CACHE_ROOT}" \
    "${COGCOIN_LOG_ROOT}" \
    "${COGCOIN_NPM_PREFIX}" \
    "$(dirname "${COGCOIN_PROFILE_FILE}")"
}

build_profile_block() {
  cat <<EOF
${COGCOIN_PATH_MARKER_START}
export PATH="${COGCOIN_MANAGED_NODE_BIN_DIR}:\$PATH"
export PATH="${COGCOIN_NPM_BIN_DIR}:\$PATH"
${COGCOIN_PATH_MARKER_END}
EOF
}

persist_path_block() {
  local block_file temp_file

  touch "${COGCOIN_PROFILE_FILE}"
  block_file="$(mktemp "${COGCOIN_CACHE_ROOT}/profile-block.XXXXXX")"
  temp_file="$(mktemp "${COGCOIN_CACHE_ROOT}/profile.XXXXXX")"
  build_profile_block > "${block_file}"

  awk -v start="${COGCOIN_PATH_MARKER_START}" -v end="${COGCOIN_PATH_MARKER_END}" '
    BEGIN {
      in_block = 0
    }
    $0 == start {
      in_block = 1
      next
    }
    in_block && $0 == end {
      in_block = 0
      next
    }
    !in_block {
      print
    }
  ' "${COGCOIN_PROFILE_FILE}" > "${temp_file}"

  if [ -s "${temp_file}" ]; then
    printf '\n' >> "${temp_file}"
  fi
  cat "${block_file}" >> "${temp_file}"

  mv "${temp_file}" "${COGCOIN_PROFILE_FILE}"
  rm -f "${block_file}"
}

prepend_runtime_path() {
  export PATH="${COGCOIN_MANAGED_NODE_BIN_DIR}:${COGCOIN_NPM_BIN_DIR}:${PATH}"
}

probe_usable_runtime() {
  local node_bin npm_bin version major
  node_bin="$1"
  npm_bin="$2"

  if [ ! -x "${node_bin}" ] || [ ! -x "${npm_bin}" ]; then
    return 1
  fi

  version="$("${node_bin}" -v 2>/dev/null || true)"
  major="$(extract_node_major "${version}" 2>/dev/null || true)"
  if [ -z "${major}" ] || [ "${major}" -lt "${COGCOIN_MIN_NODE_MAJOR}" ]; then
    return 1
  fi

  return 0
}

use_runtime() {
  COGCOIN_ACTIVE_NODE_BIN="$1"
  COGCOIN_ACTIVE_NPM_BIN="$2"
  COGCOIN_ACTIVE_NODE_VERSION="$("${COGCOIN_ACTIVE_NODE_BIN}" -v 2>/dev/null || true)"
}

compute_sha256() {
  local path
  path="$1"

  if command_exists shasum; then
    shasum -a 256 "${path}" | awk '{print $1}'
    return
  fi

  if command_exists sha256sum; then
    sha256sum "${path}" | awk '{print $1}'
    return
  fi

  if command_exists openssl; then
    openssl dgst -sha256 "${path}" | awk '{print $NF}'
    return
  fi

  fail "No SHA-256 tool was found. Install shasum, sha256sum, or openssl."
}

download_file() {
  local url destination
  url="$1"
  destination="$2"

  if [ -z "${COGCOIN_CURL_BIN}" ] || [ ! -x "${COGCOIN_CURL_BIN}" ]; then
    fail "The installer could not resolve a curl binary for managed runtime downloads."
  fi

  "${COGCOIN_CURL_BIN}" -fsSL "${url}" -o "${destination}"
}

verify_checksum() {
  local archive_path shasums_path expected actual
  archive_path="$1"
  shasums_path="$2"

  expected="$(awk -v file="${COGCOIN_NODE_ARCHIVE_NAME}" '$2 == file { print $1; exit }' "${shasums_path}")"
  if [ -z "${expected}" ]; then
    fail "Could not find a checksum for ${COGCOIN_NODE_ARCHIVE_NAME}."
  fi

  actual="$(compute_sha256 "${archive_path}")"
  if [ "${actual}" != "${expected}" ]; then
    fail "Checksum verification failed for ${COGCOIN_NODE_ARCHIVE_NAME}."
  fi
}

install_managed_node_runtime() {
  local temp_root archive_path shasums_path extract_root extracted_dir

  if [ -z "${COGCOIN_TAR_BIN}" ] || [ ! -x "${COGCOIN_TAR_BIN}" ]; then
    fail "The installer could not resolve a tar binary for managed runtime extraction."
  fi

  temp_root="$(mktemp -d "${COGCOIN_CACHE_ROOT}/node.XXXXXX")"
  archive_path="${temp_root}/${COGCOIN_NODE_ARCHIVE_NAME}"
  shasums_path="${temp_root}/SHASUMS256.txt"
  extract_root="${temp_root}/extract"
  mkdir -p "${extract_root}"

  trap 'rm -rf "${temp_root}"' RETURN

  log "Downloading Node.js archive: ${COGCOIN_NODE_ARCHIVE_NAME}."
  download_file "${COGCOIN_NODE_ARCHIVE_URL}" "${archive_path}"
  log "Downloading checksum manifest: ${COGCOIN_NODE_SHASUMS_URL}."
  download_file "${COGCOIN_NODE_SHASUMS_URL}" "${shasums_path}"
  log "Verifying SHA-256 checksum for ${COGCOIN_NODE_ARCHIVE_NAME}."
  verify_checksum "${archive_path}" "${shasums_path}"
  log "Checksum verified."

  log "Installing managed Node.js runtime to ${COGCOIN_MANAGED_NODE_ROOT}."
  "${COGCOIN_TAR_BIN}" -xf "${archive_path}" -C "${extract_root}"
  extracted_dir="${extract_root}/node-v${COGCOIN_PINNED_NODE_VERSION}-${COGCOIN_PLATFORM}-${COGCOIN_ARCH}"
  if [ ! -d "${extracted_dir}" ]; then
    fail "The downloaded Node.js archive did not unpack as expected."
  fi

  rm -rf "${COGCOIN_MANAGED_NODE_ROOT}"
  mkdir -p "$(dirname "${COGCOIN_MANAGED_NODE_ROOT}")"
  mv "${extracted_dir}" "${COGCOIN_MANAGED_NODE_ROOT}"
  trap - RETURN
  rm -rf "${temp_root}"
}

run_as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
    return
  fi

  if command_exists sudo; then
    sudo "$@"
    return
  fi

  fail "sudo is required to install build prerequisites automatically."
}

resolve_brew_binary() {
  local package_name binary_name prefix path
  package_name="$1"
  binary_name="$2"

  prefix="$("${COGCOIN_BREW_BIN}" --prefix "${package_name}")"
  path="${prefix}/bin/${binary_name}"
  if [ ! -x "${path}" ]; then
    fail "Homebrew installed ${package_name}, but ${path} was not found."
  fi

  printf '%s' "${path}"
}

managed_runtime_is_available() {
  probe_usable_runtime "${COGCOIN_MANAGED_NODE_BIN}" "${COGCOIN_MANAGED_NPM_BIN}"
}

install_linux_bootstrap_tools() {
  if command_exists apt-get; then
    log "Detected Linux package manager: apt-get."
    log "Installing packages: curl ca-certificates tar xz-utils."
    run_as_root apt-get update
    run_as_root apt-get install -y curl ca-certificates tar xz-utils
    return
  fi

  if command_exists dnf; then
    log "Detected Linux package manager: dnf."
    log "Installing packages: curl ca-certificates tar xz."
    run_as_root dnf install -y curl ca-certificates tar xz
    return
  fi

  if command_exists yum; then
    log "Detected Linux package manager: yum."
    log "Installing packages: curl ca-certificates tar xz."
    run_as_root yum install -y curl ca-certificates tar xz
    return
  fi

  if command_exists zypper; then
    log "Detected Linux package manager: zypper."
    log "Installing packages: curl ca-certificates tar xz."
    run_as_root zypper --non-interactive install curl ca-certificates tar xz
    return
  fi

  if command_exists pacman; then
    log "Detected Linux package manager: pacman."
    log "Installing packages: curl ca-certificates tar xz."
    run_as_root pacman -Sy --noconfirm curl ca-certificates tar xz
    return
  fi

  if command_exists apk; then
    log "Detected Linux package manager: apk."
    log "Installing packages: curl ca-certificates tar xz."
    run_as_root apk add --no-cache curl ca-certificates tar xz
    return
  fi

  fail "Could not determine how to install Linux bootstrap tools automatically on this distribution."
}

ensure_linux_bootstrap_tools() {
  local missing_tools=()

  if ! command_exists curl; then
    missing_tools+=("curl")
  fi
  if ! command_exists tar; then
    missing_tools+=("tar")
  fi
  if ! command_exists xz; then
    missing_tools+=("xz")
  fi

  if [ "${#missing_tools[@]}" -gt 0 ]; then
    log "Missing bootstrap tools: ${missing_tools[*]}."
    install_linux_bootstrap_tools
  else
    log "Bootstrap download tools are already available."
  fi

  COGCOIN_CURL_BIN="$(command -v curl || true)"
  COGCOIN_TAR_BIN="$(command -v tar || true)"
  COGCOIN_XZ_BIN="$(command -v xz || true)"

  if [ -z "${COGCOIN_CURL_BIN}" ] || [ -z "${COGCOIN_TAR_BIN}" ] || [ -z "${COGCOIN_XZ_BIN}" ]; then
    fail "Linux bootstrap tools are still unavailable after automatic installation. Expected curl, tar, and xz."
  fi

  log "Using curl: ${COGCOIN_CURL_BIN}"
  log "Using tar: ${COGCOIN_TAR_BIN}"
  log "Using xz: ${COGCOIN_XZ_BIN}"
}

ensure_macos_bootstrap_tools() {
  local missing_tools=()

  if ! command_exists curl; then
    missing_tools+=("curl")
  fi
  if ! command_exists tar; then
    missing_tools+=("tar")
  fi

  if [ "${#missing_tools[@]}" -eq 0 ]; then
    COGCOIN_CURL_BIN="$(command -v curl)"
    COGCOIN_TAR_BIN="$(command -v tar)"
    COGCOIN_XZ_BIN="$(command -v xz || true)"
    log "Bootstrap download tools are already available."
    log "Using curl: ${COGCOIN_CURL_BIN}"
    log "Using tar: ${COGCOIN_TAR_BIN}"
    if [ -n "${COGCOIN_XZ_BIN}" ]; then
      log "Using xz: ${COGCOIN_XZ_BIN}"
    fi
    return
  fi

  log "Missing bootstrap tools: ${missing_tools[*]}."
  if ! command_exists brew; then
    fail "Unsupported macOS environment: missing required tool(s): ${missing_tools[*]}. Install Homebrew, then rerun this installer."
  fi

  COGCOIN_BREW_BIN="$(command -v brew)"
  log "Detected Homebrew: ${COGCOIN_BREW_BIN}"
  log "Installing packages: curl gnu-tar xz."
  "${COGCOIN_BREW_BIN}" install curl gnu-tar xz

  COGCOIN_CURL_BIN="$(resolve_brew_binary curl curl)"
  COGCOIN_TAR_BIN="$(resolve_brew_binary gnu-tar gtar)"
  COGCOIN_XZ_BIN="$(resolve_brew_binary xz xz)"

  log "Using curl: ${COGCOIN_CURL_BIN}"
  log "Using tar: ${COGCOIN_TAR_BIN}"
  log "Using xz: ${COGCOIN_XZ_BIN}"
}

prepare_bootstrap_download_tools() {
  if managed_runtime_is_available; then
    log "Managed runtime already exists. Bootstrap download tools are not needed for this run."
    return
  fi

  case "${COGCOIN_PLATFORM}" in
    linux)
      ensure_linux_bootstrap_tools
      ;;
    darwin)
      ensure_macos_bootstrap_tools
      ;;
    *)
      fail "Automatic bootstrap download tooling is not available on this platform."
      ;;
  esac
}

prepare_active_runtime() {
  if managed_runtime_is_available; then
    use_runtime "${COGCOIN_MANAGED_NODE_BIN}" "${COGCOIN_MANAGED_NPM_BIN}"
    log "Reusing the existing Cogcoin-managed Node.js runtime."
    log "Managed Node path: ${COGCOIN_ACTIVE_NODE_BIN}"
    log "Using Node.js version: ${COGCOIN_ACTIVE_NODE_VERSION}"
    return
  fi

  log "No managed Node.js runtime was found. Downloading a fresh copy."
  install_managed_node_runtime
  if ! managed_runtime_is_available; then
    fail "The managed Node.js runtime is not usable after installation."
  fi

  use_runtime "${COGCOIN_MANAGED_NODE_BIN}" "${COGCOIN_MANAGED_NPM_BIN}"
  log "Managed Node.js runtime installed successfully."
  log "Managed Node path: ${COGCOIN_ACTIVE_NODE_BIN}"
  log "Using Node.js version: ${COGCOIN_ACTIVE_NODE_VERSION}"
}

configure_npm_prefix() {
  mkdir -p "${COGCOIN_NPM_PREFIX}" "${COGCOIN_NPM_BIN_DIR}"
  "${COGCOIN_ACTIVE_NPM_BIN}" config set prefix "${COGCOIN_NPM_PREFIX}" --location=user >/dev/null
}

is_native_build_failure() {
  local log_path
  log_path="$1"

  grep -Eiq \
    'node-gyp|gyp ERR!|prebuild-install warn install|No prebuilt binaries found|Could not find any Visual Studio installation|CMake Error|cmake-ts|fatal error: .* not found' \
    "${log_path}"
}

install_linux_build_prerequisites() {
  if command_exists apt-get; then
    log "Detected Linux package manager: apt-get."
    log "Installing packages: build-essential python3 cmake pkg-config xz-utils."
    run_as_root apt-get update
    run_as_root apt-get install -y build-essential python3 cmake pkg-config xz-utils
    return
  fi

  if command_exists dnf; then
    log "Detected Linux package manager: dnf."
    log "Installing packages: gcc-c++ make python3 cmake pkgconf-pkg-config xz."
    run_as_root dnf install -y gcc-c++ make python3 cmake pkgconf-pkg-config xz
    return
  fi

  if command_exists yum; then
    log "Detected Linux package manager: yum."
    log "Installing packages: gcc-c++ make python3 cmake pkgconfig xz."
    run_as_root yum install -y gcc-c++ make python3 cmake pkgconfig xz
    return
  fi

  if command_exists zypper; then
    log "Detected Linux package manager: zypper."
    log "Installing packages: gcc-c++ make python3 cmake pkg-config xz."
    run_as_root zypper --non-interactive install gcc-c++ make python3 cmake pkg-config xz
    return
  fi

  if command_exists pacman; then
    log "Detected Linux package manager: pacman."
    log "Installing packages: base-devel python cmake pkgconf xz."
    run_as_root pacman -Sy --noconfirm base-devel python cmake pkgconf xz
    return
  fi

  if command_exists apk; then
    log "Detected Linux package manager: apk."
    log "Installing packages: build-base python3 cmake pkgconf xz."
    run_as_root apk add --no-cache build-base python3 cmake pkgconf xz
    return
  fi

  fail "Could not determine how to install Linux build prerequisites automatically on this distribution."
}

can_use_interactive_terminal() {
  [ -t 1 ] && [ -r /dev/tty ]
}

print_follow_up_command() {
  printf 'Run "%s" init in an interactive terminal to continue.\n' "${COGCOIN_BIN}"
}

print_native_build_resume_command() {
  printf 'Run "%s" install -g %s && "%s" init in an interactive terminal to continue.\n' \
    "${COGCOIN_ACTIVE_NPM_BIN}" \
    "${COGCOIN_PACKAGE_NAME}" \
    "${COGCOIN_BIN}"
}

wait_for_xcode_command_line_tools() {
  local remaining_checks elapsed_seconds
  remaining_checks=120
  elapsed_seconds=0

  while [ "${remaining_checks}" -gt 0 ]; do
    if xcode-select -p >/dev/null 2>&1; then
      return 0
    fi
    sleep 15
    remaining_checks=$((remaining_checks - 1))
    elapsed_seconds=$((elapsed_seconds + 15))
    if [ $((elapsed_seconds % 60)) -eq 0 ]; then
      log "Still waiting for Xcode Command Line Tools to finish installing."
    fi
  done

  return 1
}

install_macos_build_prerequisites() {
  if command_exists xcode-select && xcode-select -p >/dev/null 2>&1; then
    fail "Native addon compilation still failed even though Xcode Command Line Tools are already installed. Review ${COGCOIN_LAST_INSTALL_LOG}."
  fi

  if ! command_exists xcode-select; then
    fail "xcode-select is required to request Xcode Command Line Tools."
  fi

  warn "Native addon compilation needs Xcode Command Line Tools."
  log "Requesting Xcode Command Line Tools installation."
  xcode-select --install >/dev/null 2>&1 || true

  if ! can_use_interactive_terminal; then
    log "Xcode Command Line Tools installation has been requested."
    print_native_build_resume_command
    exit 0
  fi

  log "Polling every 15 seconds for Xcode Command Line Tools to finish installing."
  if wait_for_xcode_command_line_tools; then
    log "Xcode Command Line Tools are ready. Retrying npm install."
    return
  fi

  log "Xcode Command Line Tools are still installing."
  print_native_build_resume_command
  exit 0
}

run_npm_install() {
  local log_path
  log_path="$1"
  mkdir -p "$(dirname "${log_path}")"

  if "${COGCOIN_ACTIVE_NPM_BIN}" install -g "${COGCOIN_PACKAGE_NAME}" 2>&1 | tee "${log_path}"; then
    return 0
  fi

  return 1
}

install_client() {
  local install_log
  install_log="${COGCOIN_LOG_ROOT}/npm-install.log"

  log "Package: ${COGCOIN_PACKAGE_NAME}"
  log "CLI target path: ${COGCOIN_BIN}"
  log "Running: ${COGCOIN_INSTALL_COMMAND}"
  if run_npm_install "${install_log}"; then
    COGCOIN_LAST_INSTALL_LOG="${install_log}"
    log "npm install completed successfully."
    return
  fi

  COGCOIN_LAST_INSTALL_LOG="${install_log}"
  if ! is_native_build_failure "${install_log}"; then
    fail "npm install failed. Review ${install_log}."
  fi

  log "Detected a native build failure."
  case "${COGCOIN_PLATFORM}" in
    linux)
      log "Installing native build prerequisites and retrying npm install."
      install_linux_build_prerequisites
      ;;
    darwin)
      install_macos_build_prerequisites
      ;;
    *)
      fail "Automatic native build fallback is not available on this platform."
      ;;
  esac

  if run_npm_install "${install_log}"; then
    log "npm install completed successfully after remediation."
    return
  fi

  fail "npm install failed after installing native build prerequisites. Review ${install_log}."
}

verify_client_install() {
  if [ ! -x "${COGCOIN_BIN}" ]; then
    fail "The Cogcoin CLI was not found at ${COGCOIN_BIN} after installation."
  fi

  log "Verified Cogcoin CLI at ${COGCOIN_BIN}."
}

run_init_if_possible() {
  if [ "${COGCOIN_SKIP_INIT:-0}" = "1" ]; then
    log "Installation completed. \`cogcoin init\` was skipped because COGCOIN_SKIP_INIT=1."
    print_follow_up_command
    return
  fi

  if ! can_use_interactive_terminal; then
    log "Installation completed. \`cogcoin init\` needs an interactive terminal."
    print_follow_up_command
    return
  fi

  log "Installation completed. Starting \`cogcoin init\` now."
  "${COGCOIN_BIN}" init < /dev/tty
}

main() {
  phase 1 "Detect platform and install location"
  detect_platform
  resolve_data_root
  ensure_base_directories
  log "Platform: ${COGCOIN_PLATFORM}"
  log "Architecture: ${COGCOIN_ARCH}"
  log "Install root: ${COGCOIN_DATA_ROOT}"
  log "Managed Node path: ${COGCOIN_MANAGED_NODE_BIN}"
  log "Cogcoin CLI path: ${COGCOIN_BIN}"
  log "Persistent PATH target: ${COGCOIN_PROFILE_FILE}"

  phase 2 "Prepare bootstrap tools"
  prepare_bootstrap_download_tools

  phase 3 "Prepare managed Node.js runtime"
  prepare_active_runtime

  phase 4 "Configure PATH and npm prefix"
  log "Updating PATH for the current process."
  prepend_runtime_path
  log "Added to PATH: ${COGCOIN_MANAGED_NODE_BIN_DIR}"
  log "Added to PATH: ${COGCOIN_NPM_BIN_DIR}"
  log "Writing persistent PATH block to ${COGCOIN_PROFILE_FILE}."
  persist_path_block
  log "Persistent PATH block is up to date."
  log "Configuring npm global prefix: ${COGCOIN_NPM_PREFIX}."
  configure_npm_prefix
  log "npm global prefix configured."

  phase 5 "Install the Cogcoin CLI"
  install_client

  phase 6 "Verify the install"
  verify_client_install

  phase 7 "Complete installation and hand off to cogcoin init"
  run_init_if_possible
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
