#!/usr/bin/env bash
# Safely checks, updates, verifies, and rolls back the upstream OpenBMB/VoxCPM engine clone.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_DIR="${ENGINE_DIR:-${ROOT_DIR}/engine}"
WEB_DIR="${WEB_DIR:-${ROOT_DIR}/web}"
MEDIA_DIR="${MEDIA_DIR:-${ROOT_DIR}/media}"
STUDIO_SCRIPT="${STUDIO_SCRIPT:-${ROOT_DIR}/studio.sh}"
CONTRACT_FILES=(app.py pyproject.toml uv.lock src/voxcpm/core.py src/voxcpm/model/utils.py)

MODE="update"
ROLLBACK_SHA=""
NO_RESTART="0"
FORCE_SYNC="0"

die() {
  echo "Error: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: ./update-engine.sh [options]

Safely inspect, fast-forward update, verify, or roll back upstream open-source engine/ (OpenBMB/VoxCPM).

Options:
  --check, --dry-run   Fetch upstream and show incoming commits/contract diffs without modifying engine/.
  --rollback <SHA>     Roll engine/ back to a previous commit SHA and rebuild its virtualenv.
  --no-restart         Skip restarting the live stack via ./studio.sh restart after updating.
  --force-sync         Re-sync engine/.venv and run verification checks even if already up to date.
  -h, --help           Show this help message.
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --check|--dry-run) MODE="check" ;;
      --no-restart) NO_RESTART="1" ;;
      --force-sync) FORCE_SYNC="1" ;;
      --rollback)
        [[ $# -ge 2 ]] || die "--rollback requires a commit SHA."
        MODE="rollback"
        ROLLBACK_SHA="$2"
        shift
        ;;
      -h|--help) usage; exit 0 ;;
      *) die "Unknown option: $1 (run --help for usage)" ;;
    esac
    shift
  done
}

require_clean_engine() {
  [[ -d "${ENGINE_DIR}/.git" ]] || die "Missing upstream engine clone at ${ENGINE_DIR}. Run: git clone https://github.com/OpenBMB/VoxCPM.git engine"
  local dirty
  dirty="$(git -C "${ENGINE_DIR}" status --short)"
  [[ -z "${dirty}" ]] || die "engine/ has local modifications. Keep engine/ untouched before updating:\n${dirty}"
}

resolve_upstream_ref() {
  local upstream
  upstream="$(git -C "${ENGINE_DIR}" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
  if [[ -n "${upstream}" ]]; then
    echo "${upstream}"
    return 0
  fi
  echo "origin/main"
}

print_contract_diff() {
  local old_sha="$1"
  local target_ref="$2"
  local changed
  changed="$(git -C "${ENGINE_DIR}" diff --name-only "${old_sha}..${target_ref}" -- "${CONTRACT_FILES[@]}" || true)"
  if [[ -z "${changed}" ]]; then
    echo "Contract-sensitive files unchanged (${CONTRACT_FILES[*]})."
    return 0
  fi
  echo "WARNING: Contract-sensitive upstream files changed:"
  printf '  - %s\n' ${changed}
  echo "Review AGENTS.md (Gradio 10-arg /generate contract, routes, MPS dtype, 48 kHz sample rate):"
  echo "  git -C engine diff ${old_sha}..${target_ref} -- ${changed//$'\n'/ }"
}

sync_engine_venv() {
  if [[ "${SKIP_SYNC:-0}" == "1" ]]; then
    echo "Skipping engine uv sync (SKIP_SYNC=1)."
    return 0
  fi
  command -v uv >/dev/null 2>&1 || die "Missing uv in PATH."
  echo "Syncing engine/.venv (Python 3.12)..."
  (cd "${ENGINE_DIR}" && uv sync --frozen --python 3.12 && .venv/bin/python app.py --help >/dev/null)
}

run_compatibility_checks() {
  if [[ "${SKIP_CHECKS:-0}" == "1" ]]; then
    echo "Skipping compatibility test suite (SKIP_CHECKS=1)."
    return 0
  fi
  echo "Running Voice Studio compatibility tests (web + media)..."
  npm --prefix "${WEB_DIR}" test
  npm --prefix "${WEB_DIR}" run build
  "${MEDIA_DIR}/.venv/bin/pytest" -v "${MEDIA_DIR}/tests"
}

maybe_restart_stack() {
  if [[ "${NO_RESTART}" == "1" ]]; then
    echo "Skipping live stack restart (--no-restart)."
    return 0
  fi
  [[ -x "${STUDIO_SCRIPT}" ]] || die "Missing executable ${STUDIO_SCRIPT}."
  "${STUDIO_SCRIPT}" restart
}

run_check() {
  require_clean_engine
  local current_sha upstream_ref count
  current_sha="$(git -C "${ENGINE_DIR}" rev-parse --short HEAD)"
  git -C "${ENGINE_DIR}" fetch --prune origin
  upstream_ref="$(resolve_upstream_ref)"
  count="$(git -C "${ENGINE_DIR}" rev-list --count "HEAD..${upstream_ref}")"
  echo "engine/ HEAD: ${current_sha} | upstream (${upstream_ref}): ${count} incoming commit(s)."
  if [[ "${count}" == "0" ]]; then
    echo "engine/ is already up to date."
    return 0
  fi
  git -C "${ENGINE_DIR}" log --oneline "HEAD..${upstream_ref}"
  print_contract_diff "${current_sha}" "${upstream_ref}"
}

run_update() {
  require_clean_engine
  local old_sha new_sha
  old_sha="$(git -C "${ENGINE_DIR}" rev-parse --short HEAD)"
  echo "Baseline engine/ commit: ${old_sha}"
  echo "Rollback command: ./update-engine.sh --rollback ${old_sha}"
  git -C "${ENGINE_DIR}" pull --ff-only
  new_sha="$(git -C "${ENGINE_DIR}" rev-parse --short HEAD)"
  if [[ "${old_sha}" == "${new_sha}" && "${FORCE_SYNC}" != "1" ]]; then
    echo "engine/ is already up to date at ${new_sha}."
    return 0
  fi
  print_contract_diff "${old_sha}" "${new_sha}"
  sync_engine_venv
  run_compatibility_checks || die "Compatibility checks failed after updating to ${new_sha}. Roll back with: ./update-engine.sh --rollback ${old_sha}"
  maybe_restart_stack
  echo "Updated engine/ cleanly: ${old_sha} -> ${new_sha}."
}

run_rollback() {
  require_clean_engine
  local resolved_sha
  resolved_sha="$(git -C "${ENGINE_DIR}" rev-parse --verify "${ROLLBACK_SHA}^{commit}" 2>/dev/null || true)"
  [[ -n "${resolved_sha}" ]] || die "Invalid commit SHA: ${ROLLBACK_SHA}"
  echo "Rolling engine/ back to ${ROLLBACK_SHA} (${resolved_sha:0:7})..."
  git -C "${ENGINE_DIR}" checkout --detach "${resolved_sha}"
  sync_engine_venv
  maybe_restart_stack
  echo "Rolled back engine/ to $(git -C "${ENGINE_DIR}" rev-parse --short HEAD)."
}

main() {
  parse_args "$@"
  case "${MODE}" in
    check) run_check ;;
    update) run_update ;;
    rollback) run_rollback ;;
  esac
}

main "$@"
