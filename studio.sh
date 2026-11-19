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

main() {
  local action="${1:-status}"
  case "${action}" in
    start) start_stack ;;
    stop) stop_stack ;;
    restart) restart_stack ;;
    status) show_status ;;
    logs) show_logs ;;
    cleanup) shift; exec "${ROOT_DIR}/cleanup.sh" "$@" ;;
    *)
      echo "Usage: $0 {start|stop|restart|status|logs|cleanup}" >&2
      exit 1
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]:-}" == "${0:-}" ]]; then
  main "$@"
fi
