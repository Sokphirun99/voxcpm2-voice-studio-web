#!/usr/bin/env bash
# Safely reclaims disk space from Voice Studio temporary caches, unused models, virtualenvs, and Docker assets.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "${ROOT_DIR}/studio.sh" ]] || { echo "Error: Run cleanup.sh from project-text-to-voice root." >&2; exit 1; }

GUI_DOMAIN="gui/$(id -u)"
ENGINE_LABEL="com.voxcpm.engine"
MEDIA_LABEL="com.voxcpm.media"
ENGINE_PLIST="${HOME}/Library/LaunchAgents/${ENGINE_LABEL}.plist"
MEDIA_PLIST="${HOME}/Library/LaunchAgents/${MEDIA_LABEL}.plist"
MODELSCOPE_DIR="${HOME}/.cache/modelscope/hub/models/iic/speech_zipenhancer_ans_multiloss_16k_base"
DIARIZATION_DIR="${HOME}/.cache/voxcpm-media"
MEDIA_JOB_DIR="/tmp/voxcpm-media-jobs"
DOCKER_VOLUME="voxcpm_voice_studio_data"

MODE=""
DRY_RUN=false
AUTO_YES=false

usage() {
  cat <<'EOF'
Usage: ./cleanup.sh <mode> [--dry-run] [--yes]

Modes:
  --unused   Remove unused benchmark AI models (~9.4 GB), temp jobs, rotated logs, and dangling Docker layers (app keeps working).
  --app      Stop LaunchAgents & Docker stack, delete .venv/node_modules & project AI models (keeps saved voice volume).
  --all      Remove everything in --app plus the Docker saved-character volume (voxcpm_voice_studio_data).

Flags:
  --dry-run  Preview exact files, models, and containers that would be removed without deleting anything.
  --yes, -y  Skip confirmation prompt.
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --unused|--app|--all) MODE="${1#--}" ;;
      --dry-run) DRY_RUN=true ;;
      --yes|-y) AUTO_YES=true ;;
      --help|-h) usage; exit 0 ;;
      *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
    esac
    shift
  done
  [[ -n "${MODE}" ]] || { usage; exit 1; }
}

confirm_destructive() {
  [[ "${DRY_RUN}" == true || "${AUTO_YES}" == true ]] && return 0
  if [[ ! -t 0 ]]; then
    echo "Refusing non-interactive cleanup without --yes (or test first with --dry-run)." >&2
    exit 1
  fi
  printf "Proceed with '%s' cleanup for Voice Studio? [y/N]: " "${MODE}"
  read -r reply
  [[ "${reply}" =~ ^[Yy]$ ]] || { echo "Cancelled."; exit 0; }
}

run_or_preview() {
  if [[ "${DRY_RUN}" == true ]]; then
    echo "[DRY-RUN] $*"
    return 0
  fi
  "$@"
}

remove_path() {
  local target="$1"
  [[ -e "${target}" || -L "${target}" ]] || return 0
  local size
  size="$(du -sh "${target}" 2>/dev/null | cut -f1 || echo "?")"
  if [[ "${DRY_RUN}" == true ]]; then
    echo "[DRY-RUN] remove ${target} (${size})"
    return 0
  fi
  rm -rf "${target}"
  echo "Removed ${target} (${size})"
}

truncate_logs() {
  shopt -s nullglob
  for logfile in "${ROOT_DIR}"/logs/*.log; do
    if [[ "${DRY_RUN}" == true ]]; then
      echo "[DRY-RUN] truncate ${logfile} ($(du -sh "${logfile}" 2>/dev/null | cut -f1 || echo "?"))"
    else
      : > "${logfile}"
      echo "Truncated ${logfile}"
    fi
  done
  shopt -u nullglob
}

clean_dir_contents() {
  local dir="$1"
  [[ -d "${dir}" ]] || return 0
  shopt -s nullglob dotglob
  for child in "${dir}"/*; do
    remove_path "${child}"
  done
  shopt -u nullglob dotglob
}

clean_tmp_files() {
  if [[ "${MODE}" == "unused" ]]; then
    clean_dir_contents "${MEDIA_JOB_DIR}"
  else
    remove_path "${MEDIA_JOB_DIR}"
  fi
  shopt -s nullglob
  for item in /tmp/test_* /tmp/tiktok_* /tmp/burned_* /tmp/kmwiktionary-latest-pages-articles.xml.bz2; do
    remove_path "${item}"
  done
  shopt -u nullglob
}

clean_hf_models() {
  local scope="$1"
  local py=""
  if [[ -x "${ROOT_DIR}/media/.venv/bin/python" ]]; then
    py="${ROOT_DIR}/media/.venv/bin/python"
  elif [[ -x "${ROOT_DIR}/engine/.venv/bin/python" ]]; then
    py="${ROOT_DIR}/engine/.venv/bin/python"
  fi
  [[ -n "${py}" && -f "${ROOT_DIR}/media/cleanup_cache.py" ]] || { echo "Skipping HF cache scan (Python env not present)."; return 0; }
  local flags=(--scope "${scope}")
  [[ "${DRY_RUN}" == true ]] && flags+=(--dry-run)
  "${py}" "${ROOT_DIR}/media/cleanup_cache.py" "${flags[@]}"
}

unload_launchd_service() {
  local label="$1"
  local plist="$2"
  if launchctl print "${GUI_DOMAIN}/${label}" >/dev/null 2>&1; then
    run_or_preview launchctl bootout "${GUI_DOMAIN}/${label}"
  fi
  remove_path "${plist}"
}

clean_docker_stack() {
  local include_volume="$1"
  command -v docker >/dev/null 2>&1 || return 0
  docker info >/dev/null 2>&1 || { echo "Docker daemon not running; skipping Docker cleanup."; return 0; }
  local compose_flags=(-f "${ROOT_DIR}/web/compose.prod.yaml" down --rmi local)
  [[ "${include_volume}" == true ]] && compose_flags+=(--volumes)
  run_or_preview docker compose "${compose_flags[@]}"
  run_or_preview docker image prune -f --filter "dangling=true"
  if [[ "${include_volume}" == true ]] && docker volume inspect "${DOCKER_VOLUME}" >/dev/null 2>&1; then
    run_or_preview docker volume rm "${DOCKER_VOLUME}"
  fi
}

clean_unused_docker_layers() {
  command -v docker >/dev/null 2>&1 || return 0
  docker info >/dev/null 2>&1 || return 0
  run_or_preview docker image prune -f --filter "dangling=true"
}

clean_app_artifacts() {
  unload_launchd_service "${ENGINE_LABEL}" "${ENGINE_PLIST}"
  unload_launchd_service "${MEDIA_LABEL}" "${MEDIA_PLIST}"
  clean_docker_stack "$([[ "${MODE}" == "all" ]] && echo true || echo false)"
  remove_path "${MODELSCOPE_DIR}"
  remove_path "${DIARIZATION_DIR}"
  remove_path "${ROOT_DIR}/engine/.venv"
  remove_path "${ROOT_DIR}/media/.venv"
  remove_path "${ROOT_DIR}/web/node_modules"
  remove_path "${ROOT_DIR}/web/dist"
  remove_path "${ROOT_DIR}/logs"
}

main() {
  parse_args "$@"
  confirm_destructive
  clean_tmp_files
  if [[ "${MODE}" == "unused" ]]; then
    truncate_logs
    clean_hf_models "unused"
    clean_unused_docker_layers
    echo "Unused cleanup complete."
    return 0
  fi
  clean_hf_models "all"
  clean_app_artifacts
  echo "Full '${MODE}' cleanup complete."
}

main "$@"
