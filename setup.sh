#!/usr/bin/env bash
# Portable fresh-machine bootstrap script for Voice Studio (clones open-source VoxCPM2 engine and installs all dependencies).

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_DIR="${ENGINE_DIR:-${ROOT_DIR}/engine}"
ENGINE_REPO_URL="${ENGINE_REPO_URL:-https://github.com/OpenBMB/VoxCPM.git}"
VERIFIED_ENGINE_SHA="300e4260b509066151d623dc9c0aa922cf82232b"
ENGINE_COMMIT="${ENGINE_COMMIT:-${VERIFIED_ENGINE_SHA}}"
MEDIA_DIR="${MEDIA_DIR:-${ROOT_DIR}/media}"
WEB_DIR="${WEB_DIR:-${ROOT_DIR}/web}"
STUDIO_SCRIPT="${STUDIO_SCRIPT:-${ROOT_DIR}/studio.sh}"
QWEN_ASR_SPEC="${QWEN_ASR_SPEC:-qwen-asr==0.0.6}"

USE_LATEST="0"
CHECK_ONLY="0"
NO_START="${SKIP_START:-0}"
SKIP_WEB_NPM="${SKIP_WEB_NPM:-0}"

die() {
  echo "Error: $*" >&2
  exit 1
}

usage() {
  cat <<EOF
Usage: ./setup.sh [options]

Bootstrap a fresh machine after cloning this repository:
  1. Verifies prerequisites (git, uv, node, docker, brew/ffmpeg-full)
  2. Clones open-source OpenBMB/VoxCPM into engine/ (pinned to verified SHA ${VERIFIED_ENGINE_SHA:0:7})
  3. Builds engine/.venv, media/.venv (+ ${QWEN_ASR_SPEC} --no-deps), and web/node_modules
  4. Starts the local stack via ./studio.sh start

Options:
  --latest         Clone engine/ at latest upstream origin/main instead of the pinned verified commit.
  --no-start       Complete installation without starting ./studio.sh start at the end.
  --skip-web-npm   Skip installing host web/node_modules (Docker still builds web/ independently).
  --check          Verify prerequisites and workspace setup status without modifying anything.
  -h, --help       Show this help message.
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --latest) USE_LATEST="1" ;;
      --no-start) NO_START="1" ;;
      --skip-web-npm) SKIP_WEB_NPM="1" ;;
      --check) CHECK_ONLY="1" ;;
      -h|--help) usage; exit 0 ;;
      *) die "Unknown option: $1 (run --help for usage)" ;;
    esac
    shift
  done
}

find_ffmpeg_with_libass() {
  local candidate filters
  for candidate in /opt/homebrew/opt/ffmpeg-full/bin/ffmpeg /usr/local/opt/ffmpeg-full/bin/ffmpeg "$(command -v ffmpeg 2>/dev/null || true)"; do
    if [[ -n "${candidate}" && -x "${candidate}" ]]; then
      filters="$("${candidate}" -hide_banner -filters 2>/dev/null || true)"
      if [[ "${filters}" == *" ass "* ]]; then
        echo "${candidate}"
        return 0
      fi
    fi
  done
  return 1
}

check_prerequisites() {
  if [[ "${SKIP_PREREQS:-0}" == "1" ]]; then
    return 0
  fi
  local missing=()
  local cmd
  for cmd in git uv docker; do
    command -v "${cmd}" >/dev/null 2>&1 || missing+=("${cmd}")
  done
  if [[ "${SKIP_WEB_NPM}" != "1" ]]; then
    command -v node >/dev/null 2>&1 || missing+=("node")
    command -v npm >/dev/null 2>&1 || missing+=("npm")
  fi
  if [[ ${#missing[@]} -gt 0 ]]; then
    die "Missing required tools: ${missing[*]}. Install them first (macOS: brew install uv node && install Docker Desktop)."
  fi
}

run_check() {
  echo "Checking Voice Studio workspace setup..."
  local ok=1
  local cmd
  for cmd in git uv node npm docker brew; do
    if command -v "${cmd}" >/dev/null 2>&1; then
      echo "  [ok] ${cmd}: $(command -v "${cmd}")"
    else
      echo "  [missing] ${cmd}"
      [[ "${cmd}" != "brew" ]] && ok=0
    fi
  done
  if ffmpeg_bin="$(find_ffmpeg_with_libass)"; then
    echo "  [ok] ffmpeg (libass): ${ffmpeg_bin}"
  else
    echo "  [missing] ffmpeg-full with libass (run: brew install ffmpeg-full)"
    ok=0
  fi
  if [[ -d "${ENGINE_DIR}/.git" ]]; then
    echo "  [ok] engine/ cloned at $(git -C "${ENGINE_DIR}" rev-parse --short HEAD)"
  else
    echo "  [missing] engine/ clone (run: ./setup.sh)"
    ok=0
  fi
  [[ -x "${ENGINE_DIR}/.venv/bin/python" ]] && echo "  [ok] engine/.venv ready" || { echo "  [missing] engine/.venv"; ok=0; }
  [[ -x "${MEDIA_DIR}/.venv/bin/uvicorn" ]] && echo "  [ok] media/.venv ready" || { echo "  [missing] media/.venv"; ok=0; }
  [[ -d "${WEB_DIR}/node_modules" ]] && echo "  [ok] web/node_modules ready" || echo "  [info] web/node_modules not installed (optional if using Docker only)"
  [[ "${ok}" -eq 1 ]] || exit 1
}

ensure_engine_clone() {
  if [[ -d "${ENGINE_DIR}/.git" ]]; then
    local dirty
    dirty="$(git -C "${ENGINE_DIR}" status --short)"
    [[ -z "${dirty}" ]] || die "engine/ has local modifications. Clean or stash them before running setup.sh:\n${dirty}"
    echo "engine/ already cloned at $(git -C "${ENGINE_DIR}" rev-parse --short HEAD) (keeping existing clean clone)."
    return 0
  fi
  if [[ -e "${ENGINE_DIR}" ]]; then
    die "${ENGINE_DIR} exists but is not a git repository. Remove or move it before running setup.sh."
  fi
  echo "Cloning upstream OpenBMB/VoxCPM into ${ENGINE_DIR}..."
  git clone "${ENGINE_REPO_URL}" "${ENGINE_DIR}"
  if [[ "${USE_LATEST}" == "1" ]]; then
    echo "engine/ initialized at latest upstream commit $(git -C "${ENGINE_DIR}" rev-parse --short HEAD)."
    return 0
  fi
  local resolved
  resolved="$(git -C "${ENGINE_DIR}" rev-parse --verify "${ENGINE_COMMIT}^{commit}" 2>/dev/null || true)"
  [[ -n "${resolved}" ]] || die "Pinned ENGINE_COMMIT '${ENGINE_COMMIT}' not found in ${ENGINE_REPO_URL}."
  local upstream_branch
  upstream_branch="$(git -C "${ENGINE_DIR}" symbolic-ref --short HEAD 2>/dev/null || echo "main")"
  git -C "${ENGINE_DIR}" checkout -B "${upstream_branch}" "${resolved}"
  git -C "${ENGINE_DIR}" branch --set-upstream-to="origin/${upstream_branch}" "${upstream_branch}" >/dev/null 2>&1 || true
  echo "engine/ pinned to verified commit $(git -C "${ENGINE_DIR}" rev-parse --short HEAD) (branch ${upstream_branch} tracking origin/${upstream_branch})."
}

ensure_ffmpeg_full() {
  if [[ "${SKIP_BREW:-0}" == "1" ]]; then
    echo "Skipping ffmpeg-full check (SKIP_BREW=1)."
    return 0
  fi
  if ffmpeg_bin="$(find_ffmpeg_with_libass)"; then
    echo "FFmpeg with libass ready: ${ffmpeg_bin}"
    return 0
  fi
  command -v brew >/dev/null 2>&1 || die "FFmpeg with libass is required for subtitle burn-in. Install Homebrew then run: brew install ffmpeg-full"
  echo "Installing Homebrew ffmpeg-full (required for libass subtitle burn-in)..."
  brew install ffmpeg-full
}

sync_python_environments() {
  if [[ "${SKIP_SYNC:-0}" == "1" ]]; then
    echo "Skipping Python environment sync (SKIP_SYNC=1)."
    return 0
  fi
  echo "Syncing engine/.venv (Python 3.12)..."
  (cd "${ENGINE_DIR}" && uv sync --frozen --python 3.12)
  echo "Syncing media/.venv (Python 3.12) + ${QWEN_ASR_SPEC} (--no-deps)..."
  (cd "${MEDIA_DIR}" && uv sync --frozen --python 3.12 && uv pip install --python .venv/bin/python --no-deps "${QWEN_ASR_SPEC}")
}

install_web_dependencies() {
  if [[ "${SKIP_WEB_NPM}" == "1" ]]; then
    echo "Skipping host web npm install (--skip-web-npm)."
    return 0
  fi
  echo "Installing web/ host dependencies (npm ci)..."
  npm --prefix "${WEB_DIR}" ci --no-audit --no-fund
}

maybe_start_stack() {
  if [[ "${NO_START}" == "1" ]]; then
    echo "Setup complete. Start Voice Studio anytime with: ./studio.sh start"
    return 0
  fi
  [[ -x "${STUDIO_SCRIPT}" ]] || die "Missing executable ${STUDIO_SCRIPT}."
  echo "Starting Voice Studio stack..."
  "${STUDIO_SCRIPT}" start
}

main() {
  parse_args "$@"
  if [[ "${CHECK_ONLY}" == "1" ]]; then
    run_check
    return 0
  fi
  check_prerequisites
  ensure_engine_clone
  ensure_ffmpeg_full
  sync_python_environments
  install_web_dependencies
  maybe_start_stack
}

main "$@"
