# 2smart watchdog

Host-level systemd watchdog that keeps the standalone stack self-healing across
host reboots and EMQX (MQTT broker) restarts. It runs **outside** the containers
and complements Core's own `RestartPolicy=unless-stopped`.

## Why it exists

EMQX's retainer uses **RAM storage**, so a broker restart wipes every retained
topic that has no live republisher — including Core's per-bridge registration
(`bridges/<id>/$state|$type|$configuration`) and scenario setpoints. When that
happens Core "forgets" bridges that have no running container to re-announce
themselves, and MQTT clients that subscribed *before* the MySQL-backed authz was
ready get silently denied (EMQX `deny_action=ignore`), which kills relay commands
and scenarios.

## What the script does (idempotent, safe every 2 min and on boot)

1. **ensure_running** – starts any expected container that isn't running
   (the KNX bridges + the non-KNX service bridges in `SERVICE_BRIDGES` +
   `2smart-core` + `scenario-runner`).
2. **wait_authz** – waits until an MQTT subscribe round-trip succeeds, i.e. the
   MySQL ACL layer is actually up.
3. **recovery** – on boot or when an EMQX restart is detected, staggers a restart
   of the bridges + scenario-runner so their MQTT clients re-subscribe against a
   healthy authz.
4. **orphan retained snapshot + replay** – keeps a fresh snapshot of the retained
   namespaces that have no republisher (`ORPHAN_TOPICS`) and, if a wipe is
   detected after recovery, replays **only** that snapshot. It never touches
   `sweet-home/*` (device data) which owners republish themselves.

## Configuration

MQTT credentials are read from `/etc/2smart-watchdog.env` (NOT committed):

```sh
MQTT_HOST=2smart-emqx
MQTT_USER=2smart
MQTT_PASS=<broker password>
DOCKER_NET=admin007_app-network
```

Bridge/container lists are set at the top of `2smart-watchdog.sh`:
- `BRIDGES` – KNX bridge ids (container name `bridge-knx-bridge-<id>`).
- `SERVICE_BRIDGES` – full container names of non-KNX dynamic bridges
  (Tuya PTH-9CW, Open-Meteo weather bridge, …).

## Install (on the host)

```sh
install -m 755 -o root -g root 2smart-watchdog.sh /usr/local/bin/2smart-watchdog.sh
cp 2smart-watchdog.service 2smart-watchdog-boot.service 2smart-watchdog.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now 2smart-watchdog.timer 2smart-watchdog-boot.service
```

- `2smart-watchdog.timer` runs the periodic check every 2 min (`ExecStart=… periodic`).
- `2smart-watchdog-boot.service` runs the boot recovery once, 30s after Docker is up (`… boot`).
