#!/usr/bin/env bash
# 2smart watchdog: reboot / EMQX-restart safety for the KNX smart-home stack.
#
# What it does (idempotent, safe to run every 2 min and on boot):
#   1. ensure_running   - starts any expected container that is not running
#                         (9 KNX bridges + 2smart-core + scenario-runner).
#   2. wait_authz       - waits until EMQX authorization is healthy (a subscribe
#                         round-trip succeeds), i.e. MySQL-ACL is up.
#   3. recovery         - on boot OR when an EMQX restart is detected, staggers a
#                         restart of the bridges + scenario-runner so their MQTT
#                         clients (re)subscribe against a HEALTHY authz. This is the
#                         fix for the "clients subscribed before authz was ready and
#                         SUBSCRIBE was silently denied" race that killed relays/scenarios.
#   4. orphan retained  - EMQX retainer uses RAM storage, so a broker restart wipes
#      snapshot+replay    retained topics that have no republisher (scenario setpoints,
#                         custom device names/settings, extensions, bridge-types).
#                         We keep a fresh snapshot of those namespaces and, if a wipe
#                         is detected after recovery, replay ONLY the orphan snapshot
#                         (never touches sweet-home/* or bridges/* which their owners
#                         republish themselves).
#
# Config (MQTT creds) is read from /etc/2smart-watchdog.env
set -u
umask 077

CONF=/etc/2smart-watchdog.env
[ -r "$CONF" ] && . "$CONF"
: "${MQTT_HOST:=2smart-emqx}"
: "${MQTT_USER:=2smart}"
: "${MQTT_PASS:=}"
: "${DOCKER_NET:=admin007_app-network}"
: "${MOSQ_IMAGE:=eclipse-mosquitto:2}"

STATE_DIR=/var/lib/2smart-watchdog
LOG=/var/log/2smart-watchdog.log
SNAP="$STATE_DIR/orphan-retained.snap"
EMQX_STATE="$STATE_DIR/emqx_started"
mkdir -p "$STATE_DIR"

BRIDGES="yvkyxab0s86xkg7enhqe r0p3e1q6eysh8rho3885 qydykuq95jn71y1ib6ry p89q75wf0j47dfiyuq6a aqi80gp3ootejnjzf0qa 71cqybqfhrj8idiz7vgs 37tmrwuj5aanu6atapyv 36elxz3ueur3adtu118b kisvbugguy8ek0lx3a3g"
# Non-KNX dynamic bridge containers (full container names) to keep running.
# These are managed by Core exactly like the KNX bridges, but do not follow the
# bridge-knx-bridge-<id> naming, so they are listed explicitly here.
SERVICE_BRIDGES="bridge-tuya-bridge-ntw0c3p5ch488kfu662i bridge-openweathermap-bridge-jgku5qw8vsfbjiyhd6td"
EMQX_CT=2smart-emqx
EXTRA_CT="2smart-core scenario-runner"
# Orphan retained namespaces (no republisher -> lost on EMQX restart).
# bridges/# holds Core's per-bridge registration ($state/$type/$configuration).
# Core publishes it once at create and does NOT reliably re-publish it after an
# EMQX retained wipe; when it is lost Core drops the entity and then removes the
# still-running container (clearRunningBridgesWithoutEntities). Snapshotting and
# replaying it lets Core re-adopt the running container after a wipe.
ORPHAN_TOPICS="scenarios/# device-settings/# groups-of-properties/# topics-aliases/# extensions/# bridge-types/# bridges/#"
SNAP_MIN_SETPOINTS=80   # only trust/refresh snapshot when broker looks healthy

log(){ echo "$(date -Is) $*" >>"$LOG" 2>&1; }

running(){ [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = "true" ]; }

mosq(){ # mosq sub|pub <args...>
  local cmd="$1"; shift
  docker run --rm --network "$DOCKER_NET" "$MOSQ_IMAGE" \
    "mosquitto_${cmd}" -h "$MQTT_HOST" -u "$MQTT_USER" -P "$MQTT_PASS" "$@"
}

authz_ready(){
  running "$EMQX_CT" || return 1
  # subscribe must succeed and return at least one retained message
  timeout 12 docker run --rm --network "$DOCKER_NET" "$MOSQ_IMAGE" \
    mosquitto_sub -h "$MQTT_HOST" -u "$MQTT_USER" -P "$MQTT_PASS" \
    -t '#' -C 1 -W 8 >/dev/null 2>&1
}

wait_authz(){
  local i
  for i in $(seq 1 60); do
    authz_ready && { log "authz ready (attempt $i)"; return 0; }
    sleep 5
  done
  log "authz NOT ready after wait"
  return 1
}

ensure_running(){
  local id name c
  for id in $BRIDGES; do
    name="bridge-knx-bridge-$id"
    if ! running "$name"; then
      log "ensure_running: starting $name"
      docker start "$name" >/dev/null 2>&1 || log "  failed to start $name"
    fi
  done
  for name in $SERVICE_BRIDGES; do
    if ! running "$name"; then
      log "ensure_running: starting $name"
      docker start "$name" >/dev/null 2>&1 || log "  failed to start $name"
    fi
  done
  for c in $EXTRA_CT; do
    if ! running "$c"; then
      log "ensure_running: starting $c"
      docker start "$c" >/dev/null 2>&1 || log "  failed to start $c"
    fi
  done
}

live_setpoint_count(){
  timeout 15 docker run --rm --network "$DOCKER_NET" "$MOSQ_IMAGE" \
    mosquitto_sub -h "$MQTT_HOST" -u "$MQTT_USER" -P "$MQTT_PASS" \
    -t 'scenarios/#' -W 10 -v 2>/dev/null \
    | grep -Ec '^scenarios/[^/]+/setpoint '
}

snapshot_orphans(){
  # Only snapshot when broker looks healthy, so we never overwrite a good snapshot with a wiped state.
  local n; n="$(live_setpoint_count)"
  if [ "${n:-0}" -lt "$SNAP_MIN_SETPOINTS" ]; then
    log "snapshot: skipped (live setpoints=$n < $SNAP_MIN_SETPOINTS)"
    return 0
  fi
  local tmp="$SNAP.tmp" args=()
  local t; for t in $ORPHAN_TOPICS; do args+=("-t" "$t"); done
  # mosquitto_sub -W exits non-zero on its timeout even on success, so we do NOT
  # gate on exit code; we validate the captured file instead.
  timeout 45 docker run --rm --network "$DOCKER_NET" "$MOSQ_IMAGE" \
    mosquitto_sub -h "$MQTT_HOST" -u "$MQTT_USER" -P "$MQTT_PASS" \
    "${args[@]}" -W 25 -v 2>/dev/null > "$tmp"
  local cap_sp; cap_sp="$(grep -Ec '^scenarios/[^/]+/setpoint ' "$tmp" 2>/dev/null)"
  if [ -s "$tmp" ] && [ "${cap_sp:-0}" -ge "$SNAP_MIN_SETPOINTS" ]; then
    mv "$tmp" "$SNAP"
    log "snapshot: saved $(wc -l < "$SNAP") orphan retained topics (setpoints=$cap_sp)"
  else
    rm -f "$tmp"; log "snapshot: capture invalid (lines=$(wc -l < "$tmp" 2>/dev/null || echo 0), setpoints=${cap_sp:-0}), kept previous snapshot"
  fi
}

replay_orphans_if_wiped(){
  [ -s "$SNAP" ] || { log "replay: no snapshot yet, nothing to do"; return 0; }
  local snap_sp live_sp
  snap_sp="$(grep -Ec '^scenarios/[^/]+/setpoint ' "$SNAP")"
  live_sp="$(live_setpoint_count)"
  log "replay: live setpoints=$live_sp, snapshot setpoints=$snap_sp"
  # Wipe detected if live is less than half of what the snapshot has.
  if [ "${snap_sp:-0}" -gt 0 ] && [ "$(( ${live_sp:-0} * 2 ))" -lt "$snap_sp" ]; then
    log "replay: WIPE detected -> replaying orphan snapshot"
    # Publish every topic inside a SINGLE container (loop internally) so we pay the
    # docker-run overhead once instead of per-topic (thousands of topics).
    local n
    n="$(cat "$SNAP" | timeout 300 docker run --rm -i --network "$DOCKER_NET" \
        -e H="$MQTT_HOST" -e U="$MQTT_USER" -e P="$MQTT_PASS" "$MOSQ_IMAGE" \
        sh -c 'c=0; while IFS= read -r line; do
                 t=${line%% *}; m=${line#* };
                 [ -z "$t" ] && continue;
                 [ "$t" = "$m" ] && m="";
                 mosquitto_pub -h "$H" -u "$U" -P "$P" -t "$t" -m "$m" -r -q 1 2>/dev/null;
                 c=$((c+1));
               done; echo "$c"' 2>/dev/null | tail -1)"
    log "replay: republished ${n:-0} orphan retained topics"
  else
    log "replay: broker retained looks intact, no replay needed"
  fi
}

recovery(){
  local reason="$1"
  log "recovery START ($reason)"
  wait_authz || { log "recovery ABORT: authz not ready"; return 1; }
  local id
  for id in $BRIDGES; do
    docker restart "bridge-knx-bridge-$id" >/dev/null 2>&1 && log "recovery: restarted bridge $id"
    sleep 8
  done
  for name in $SERVICE_BRIDGES; do
    running "$name" && docker restart "$name" >/dev/null 2>&1 && log "recovery: restarted service bridge $name"
    sleep 8
  done
  docker restart scenario-runner >/dev/null 2>&1 && log "recovery: restarted scenario-runner"
  # give bridges/core a moment to republish their own retained before we check for orphan wipe
  sleep 20
  replay_orphans_if_wiped
  log "recovery DONE ($reason)"
}

MODE="${1:-periodic}"
CUR_STARTED="$(docker inspect -f '{{.State.StartedAt}}' "$EMQX_CT" 2>/dev/null)"
PREV_STARTED="$(cat "$EMQX_STATE" 2>/dev/null)"

ensure_running

case "$MODE" in
  boot)
    recovery "boot"
    echo "$CUR_STARTED" > "$EMQX_STATE"
    snapshot_orphans
    ;;
  periodic)
    if [ -n "$CUR_STARTED" ] && [ "$CUR_STARTED" != "$PREV_STARTED" ]; then
      log "EMQX restart detected ($PREV_STARTED -> $CUR_STARTED)"
      recovery "emqx-restart"
      echo "$CUR_STARTED" > "$EMQX_STATE"
    fi
    snapshot_orphans
    ;;
  *)
    echo "usage: $0 [boot|periodic]" >&2; exit 2;;
esac
