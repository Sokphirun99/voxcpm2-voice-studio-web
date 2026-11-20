#!/usr/bin/env bash
# Manages the persistent native macOS VoxCPM2 engine (8808), Media Subtitle service (8810), and Voice Studio Docker stack.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_DIR="${ROOT_DIR}/engine"
ENGINE_PYTHON="${ENGINE_DIR}/.venv/bin/python"
MEDIA_DIR="${ROOT_DIR}/media"
MEDIA_UVICORN="${MEDIA_DIR}/.venv/bin/uvicorn"
COMPOSE_FILE="${ROOT_DIR}/${VOICE_STUDIO_COMPOSE:-web/compose.prod.yaml}"
LOG_DIR="${ROOT_DIR}/logs"
GUI_DOMAIN="gui/$(id -u)"

ENGINE_LABEL="com.voxcpm.engine"
ENGINE_PLIST="${HOME}/Library/LaunchAgents/${ENGINE_LABEL}.plist"
ENGINE_PORT="8808"

MEDIA_LABEL="com.voxcpm.media"
MEDIA_PLIST="${HOME}/Library/LaunchAgents/${MEDIA_LABEL}.plist"
MEDIA_PORT="8810"

STUDIO_PORT="${VOICE_STUDIO_PORT:-8087}"

VOLUME_NAME="voxcpm_voice_studio_data"  # Must match the named volume in web/compose.prod.yaml
STORAGE_SERVICE="storage"
BACKUP_IMAGE="alpine:3.20"
BACKUP_DIR="${ROOT_DIR}/backups"

if [[ -x "/usr/bin/curl" ]]; then
  CURL_BIN="/usr/bin/curl"
else
  CURL_BIN="$(command -v curl || true)"
fi

LSOF_BIN="$(command -v lsof || true)"
if [[ -z "${LSOF_BIN}" && -x "/usr/sbin/lsof" ]]; then
  LSOF_BIN="/usr/sbin/lsof"
fi

die() {
  echo "Error: $*" >&2
  exit 1
}

ensure_prerequisites() {
  [[ -n "${CURL_BIN}" && -x "${CURL_BIN}" ]] || die "Missing curl."
  [[ -x "${ENGINE_PYTHON}" ]] || die "Missing ${ENGINE_PYTHON}. Run 'cd engine && uv sync --frozen --python 3.12' first."
  [[ -f "${ENGINE_DIR}/app.py" ]] || die "Missing ${ENGINE_DIR}/app.py."
  [[ -x "${MEDIA_UVICORN}" ]] || die "Missing ${MEDIA_UVICORN}. Run 'cd media && uv sync --frozen --python 3.12' first."
  [[ -f "${MEDIA_DIR}/server.py" ]] || die "Missing ${MEDIA_DIR}/server.py."
  [[ -f "${COMPOSE_FILE}" ]] || die "Missing ${COMPOSE_FILE}."
}

write_engine_plist() {
  mkdir -p "$(dirname "${ENGINE_PLIST}")" "${LOG_DIR}"
  cat >"${ENGINE_PLIST}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${ENGINE_LABEL}</string>
  <key>WorkingDirectory</key>
  <string>${ENGINE_DIR}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${ENGINE_PYTHON}</string>
    <string>app.py</string>
    <string>--host</string>
    <string>127.0.0.1</string>
    <string>--port</string>
    <string>${ENGINE_PORT}</string>
    <string>--device</string>
    <string>auto</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DYLD_FALLBACK_LIBRARY_PATH</key>
    <string>/opt/homebrew/opt/ffmpeg@8/lib:/opt/homebrew/lib:/usr/local/lib:/usr/lib</string>
    <key>HOME</key>
    <string>${HOME}</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>PYTORCH_ENABLE_MPS_FALLBACK</key>
    <string>1</string>
    <key>PYTHONUNBUFFERED</key>
    <string>1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/engine.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/engine.err.log</string>
</dict>
</plist>
EOF
}

write_media_plist() {
  mkdir -p "$(dirname "${MEDIA_PLIST}")" "${LOG_DIR}"
  cat >"${MEDIA_PLIST}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MEDIA_LABEL}</string>
  <key>WorkingDirectory</key>
  <string>${MEDIA_DIR}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${MEDIA_UVICORN}</string>
    <string>server:app</string>
    <string>--host</string>
    <string>127.0.0.1</string>
    <string>--port</string>
    <string>${MEDIA_PORT}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HF_HUB_DISABLE_XET</key>
    <string>1</string>
    <key>HOME</key>
    <string>${HOME}</string>
    <key>MEDIA_FFMPEG_BIN</key>
    <string>/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg</string>
    <key>MEDIA_FFPROBE_BIN</key>
    <string>/opt/homebrew/opt/ffmpeg-full/bin/ffprobe</string>
    <key>PATH</key>
    <string>/opt/homebrew/opt/ffmpeg-full/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>PYTHONUNBUFFERED</key>
    <string>1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/media.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/media.err.log</string>
</dict>
</plist>
EOF
}

is_service_loaded() {
  launchctl print "${GUI_DOMAIN}/$1" >/dev/null 2>&1
}

is_port_listening() {
  local port="$1"
  [[ -n "${LSOF_BIN}" && -x "${LSOF_BIN}" ]] || die "Missing lsof."
  "${LSOF_BIN}" -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1
}

wait_for_port_release() {
  local port="$1"
  local label="$2"
  local attempts=50
  local i
  for ((i = 1; i <= attempts; i++)); do
    if ! is_port_listening "${port}"; then
      return 0
    fi
    sleep 0.2
  done
  die "Port ${port} is still listening after stopping ${label}. Inspect with: ${LSOF_BIN} -nP -iTCP:${port} -sTCP:LISTEN"
}

wait_for_url() {
  local url="$1"
  local label="$2"
  local attempts=30
  local i
  for ((i = 1; i <= attempts; i++)); do
    if "${CURL_BIN}" -sf --connect-timeout 2 --max-time 5 "${url}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  die "${label} did not respond at ${url}. Check ${LOG_DIR}/."
}

start_service() {
  local label="$1"
  local plist="$2"
  if ! is_service_loaded "${label}"; then
    launchctl bootstrap "${GUI_DOMAIN}" "${plist}"
  else
    launchctl kickstart "${GUI_DOMAIN}/${label}" >/dev/null 2>&1 || true
  fi
}

stop_service() {
  local label="$1"
  local port="${2:-}"
  if is_service_loaded "${label}"; then
    launchctl bootout "${GUI_DOMAIN}/${label}" >/dev/null 2>&1 || true
    local unloaded=0
    local i
    for ((i = 1; i <= 50; i++)); do
      if ! is_service_loaded "${label}"; then
        unloaded=1
        break
      fi
      sleep 0.2
    done
    if [[ "${unloaded}" -ne 1 ]]; then
      die "Timed out waiting for launchd service ${label} to unload."
    fi
  fi
  if [[ -n "${port}" ]] && is_port_listening "${port}"; then
    wait_for_port_release "${port}" "${label}"
  fi
}

start_stack() {
  ensure_prerequisites
  write_engine_plist
  write_media_plist
  start_service "${ENGINE_LABEL}" "${ENGINE_PLIST}"
  start_service "${MEDIA_LABEL}" "${MEDIA_PLIST}"
  wait_for_url "http://127.0.0.1:${ENGINE_PORT}/gradio_api/info" "VoxCPM2 engine"
  wait_for_url "http://127.0.0.1:${MEDIA_PORT}/health" "Media subtitle service"
  docker compose -f "${COMPOSE_FILE}" up -d
  echo "Engine online:        http://127.0.0.1:${ENGINE_PORT}"
  echo "Media subtitle API:   http://127.0.0.1:${MEDIA_PORT}"
  echo "Voice Studio UI:      http://127.0.0.1:${STUDIO_PORT}"
}

stop_stack() {
  stop_service "${ENGINE_LABEL}" "${ENGINE_PORT}"
  stop_service "${MEDIA_LABEL}" "${MEDIA_PORT}"
  docker compose -f "${COMPOSE_FILE}" down
  echo "Stopped VoxCPM2 engine, Media subtitle service, and Voice Studio container."
}

restart_stack() {
  ensure_prerequisites
  write_engine_plist
  write_media_plist
  stop_service "${ENGINE_LABEL}" "${ENGINE_PORT}"
  stop_service "${MEDIA_LABEL}" "${MEDIA_PORT}"
  launchctl bootstrap "${GUI_DOMAIN}" "${ENGINE_PLIST}"
  launchctl bootstrap "${GUI_DOMAIN}" "${MEDIA_PLIST}"
  wait_for_url "http://127.0.0.1:${ENGINE_PORT}/gradio_api/info" "VoxCPM2 engine"
  wait_for_url "http://127.0.0.1:${MEDIA_PORT}/health" "Media subtitle service"
  docker compose -f "${COMPOSE_FILE}" up -d --build --force-recreate
  echo "Restarted VoxCPM2 engine, Media subtitle service, and Voice Studio container."
}

show_status() {
  local engine_state="stopped"
  local media_state="stopped"
  local proxy_code="000"
  local media_code="000"
  is_service_loaded "${ENGINE_LABEL}" && engine_state="loaded"
  is_service_loaded "${MEDIA_LABEL}" && media_state="loaded"
  if [[ -n "${CURL_BIN}" && -x "${CURL_BIN}" ]]; then
    proxy_code="$("${CURL_BIN}" -s --connect-timeout 2 --max-time 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${STUDIO_PORT}/gradio_api/info" || true)"
    media_code="$("${CURL_BIN}" -s --connect-timeout 2 --max-time 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${STUDIO_PORT}/media_api/health" || true)"
  fi
  echo "Engine launchd (${ENGINE_LABEL}): ${engine_state}"
  if [[ -n "${LSOF_BIN}" && -x "${LSOF_BIN}" ]]; then
    "${LSOF_BIN}" -nP -iTCP:"${ENGINE_PORT}" -sTCP:LISTEN || echo "Port ${ENGINE_PORT}: not listening"
  fi
  echo "Media launchd  (${MEDIA_LABEL}): ${media_state}"
  if [[ -n "${LSOF_BIN}" && -x "${LSOF_BIN}" ]]; then
    "${LSOF_BIN}" -nP -iTCP:"${MEDIA_PORT}" -sTCP:LISTEN || echo "Port ${MEDIA_PORT}: not listening"
  fi
  docker compose -f "${COMPOSE_FILE}" ps
  echo "Studio -> Gradio proxy HTTP: ${proxy_code}"
  echo "Studio -> Media proxy HTTP:  ${media_code}"
}

show_logs() {
  mkdir -p "${LOG_DIR}"
  touch "${LOG_DIR}/engine.log" "${LOG_DIR}/engine.err.log" "${LOG_DIR}/media.log" "${LOG_DIR}/media.err.log"
  tail -n 50 -f "${LOG_DIR}/engine.log" "${LOG_DIR}/engine.err.log" "${LOG_DIR}/media.log" "${LOG_DIR}/media.err.log"
}

usage() {
  cat <<'EOF'
Usage: ./studio.sh <command> [arguments]

Commands:
  start                            Start native services and the Docker stack
  stop                             Stop native services and Docker containers
  restart                          Rebuild and restart the full stack
  status                           Show launchd, Docker, port, and proxy status
  logs                             Tail engine and media logs
  backup [output.tar.gz]           Back up Docker volume voxcpm_voice_studio_data
  restore <backup.tar.gz> [--yes]  Restore a backup (replaces volume contents)
  cleanup [args...]                Delegate to cleanup.sh
  help                             Show this help

Backups default to ./backups/voice-studio-YYYYMMDD-HHMMSS.tar.gz.
Restore requires --yes when stdin is not interactive and the volume is not empty.
EOF
}

require_docker() {
  command -v docker >/dev/null 2>&1 || die "Missing docker CLI. Install Docker Desktop and retry."
  docker info >/dev/null 2>&1 || die "Cannot reach the Docker daemon. Start Docker Desktop and retry."
}

require_volume() {
  docker volume inspect "${VOLUME_NAME}" >/dev/null 2>&1 \
    || die "Docker volume '${VOLUME_NAME}' does not exist. Start the stack once with './studio.sh start'."
}

ensure_volume() {
  if docker volume inspect "${VOLUME_NAME}" >/dev/null 2>&1; then
    return 0
  fi
  docker volume create "${VOLUME_NAME}" >/dev/null \
    || die "Could not create Docker volume '${VOLUME_NAME}'."
}

validate_archive() {
  local archive="$1"
  local entries unsafe
  entries="$(tar -tzf "${archive}")" || die "Not a valid .tar.gz archive: ${archive}"
  [[ -n "${entries}" ]] || die "Backup archive is empty: ${archive}"
  unsafe="$(printf '%s\n' "${entries}" | awk '
    /^\// { print; exit }
    {
      count = split($0, parts, "/")
      for (i = 1; i <= count; i++) {
        if (parts[i] == "..") { print; exit }
      }
    }
  ')"
  [[ -z "${unsafe}" ]] || die "Unsafe path in archive (absolute or '..'): ${unsafe}"
}

create_backup() {
  local output="$1"
  local partial="${output}.partial"
  mkdir -p "$(dirname "${output}")" || die "Could not create backup directory for ${output}."
  rm -f "${partial}"
  if ! docker run --rm --volume "${VOLUME_NAME}:/data:ro" "${BACKUP_IMAGE}" \
      tar -czf - -C /data . >"${partial}"; then
    rm -f "${partial}"
    die "Backup failed. Is Docker running and the volume readable?"
  fi
  mv "${partial}" "${output}" || { rm -f "${partial}"; die "Could not write ${output}."; }
  echo "Backup written: ${output}"
}

run_backup() {
  local output="" arg
  for arg in "$@"; do
    case "${arg}" in
      -*) die "Unknown backup option: ${arg}" ;;
      *) [[ -z "${output}" ]] || die "backup accepts at most one output path."
         output="${arg}" ;;
    esac
  done
  if [[ -z "${output}" ]]; then
    output="${BACKUP_DIR}/voice-studio-$(date -u +%Y%m%d-%H%M%S).tar.gz"
  fi
  [[ ! -d "${output}" ]] || die "Backup output is a directory: ${output}"
  require_docker
  require_volume
  create_backup "${output}"
}

volume_has_data() {
  local entries
  entries="$(docker run --rm --volume "${VOLUME_NAME}:/data:ro" "${BACKUP_IMAGE}" ls -A /data)" \
    || die "Could not inspect Docker volume '${VOLUME_NAME}'."
  [[ -n "${entries}" ]]
}

confirm_overwrite() {
  local archive="$1"
  local assume_yes="$2"
  local reply=""
  if [[ "${assume_yes}" -eq 1 ]] || ! volume_has_data; then
    return 0
  fi
  [[ -t 0 ]] || die "Volume '${VOLUME_NAME}' contains data. Re-run with --yes to overwrite it."
  printf 'Replace all data in volume %s with %s? [y/N] ' "${VOLUME_NAME}" "${archive}" >&2
  read -r reply || die "Restore cancelled."
  case "${reply}" in
    y|Y|yes|YES|Yes) return 0 ;;
    *) die "Restore cancelled." ;;
  esac
}

storage_is_running() {
  local container_id
  container_id="$(docker compose -f "${COMPOSE_FILE}" ps -q "${STORAGE_SERVICE}")" \
    || die "Could not query the '${STORAGE_SERVICE}' container state."
  [[ -n "${container_id}" ]]
}

clear_volume() {
  docker run --rm --volume "${VOLUME_NAME}:/data" "${BACKUP_IMAGE}" \
    sh -c 'rm -rf /data/* /data/.[!.]* /data/..?*' \
    || die "Could not clear Docker volume '${VOLUME_NAME}'."
}

extract_archive() {
  docker run --rm -i --volume "${VOLUME_NAME}:/data" "${BACKUP_IMAGE}" \
    tar -xzf - -C /data <"$1" \
    || die "Could not extract ${1}. The storage container remains stopped."
}

restore_volume() {
  local archive="$1"
  local was_running=0
  if storage_is_running; then
    was_running=1
  fi
  if [[ "${was_running}" -eq 1 ]]; then
    docker compose -f "${COMPOSE_FILE}" stop "${STORAGE_SERVICE}" \
      || die "Could not stop the '${STORAGE_SERVICE}' container."
  fi
  clear_volume
  extract_archive "${archive}"
  if [[ "${was_running}" -eq 1 ]]; then
    docker compose -f "${COMPOSE_FILE}" up -d "${STORAGE_SERVICE}" \
      || die "Restored data, but failed to restart the '${STORAGE_SERVICE}' container."
  fi
  echo "Restored ${archive} into Docker volume ${VOLUME_NAME}."
}

run_restore() {
  local archive=""
  local assume_yes=0
  local arg
  for arg in "$@"; do
    case "${arg}" in
      --yes|-y) assume_yes=1 ;;
      -*) die "Unknown restore option: ${arg}" ;;
      *) [[ -z "${archive}" ]] || die "restore accepts exactly one archive path."
         archive="${arg}" ;;
    esac
  done
  [[ -n "${archive}" ]] || die "Usage: $0 restore <backup.tar.gz> [--yes]"
  [[ -f "${archive}" ]] || die "Backup archive not found: ${archive}"
  validate_archive "${archive}"
  require_docker
  [[ -f "${COMPOSE_FILE}" ]] || die "Missing compose file: ${COMPOSE_FILE}"
  ensure_volume
  confirm_overwrite "${archive}" "${assume_yes}"
  restore_volume "${archive}"
}

main() {
  local action="${1:-status}"
  case "${action}" in
    start) start_stack ;;
    stop) stop_stack ;;
    restart) restart_stack ;;
    status) show_status ;;
    logs) show_logs ;;
    backup) shift; run_backup "$@" ;;
    restore) shift; run_restore "$@" ;;
    cleanup) shift; exec "${ROOT_DIR}/cleanup.sh" "$@" ;;
    -h|--help|help) usage ;;
    *) die "Unknown command: ${action}. Run '$0 --help' for usage." ;;
  esac
}

if [[ "${BASH_SOURCE[0]:-}" == "${0:-}" ]]; then
  main "$@"
fi
