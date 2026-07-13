#!/bin/bash
set -euo pipefail

[[ "$(id -u)" == 0 ]] || { echo 'operations install: root is required' >&2; exit 77; }
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
install -m 0644 "$root/botmem-v2-backup.service" /etc/systemd/system/botmem-v2-backup.service
install -m 0644 "$root/botmem-v2-backup.timer" /etc/systemd/system/botmem-v2-backup.timer
install -m 0644 "$root/botmem-v2-health-recover.service" /etc/systemd/system/botmem-v2-health-recover.service
install -m 0644 "$root/botmem-v2-health-recover.timer" /etc/systemd/system/botmem-v2-health-recover.timer
systemctl daemon-reload
systemctl enable --now botmem-v2-backup.timer >/dev/null
systemctl enable --now botmem-v2-health-recover.timer >/dev/null
systemctl is-enabled --quiet botmem-v2-backup.timer
systemctl is-active --quiet botmem-v2-backup.timer
systemctl is-enabled --quiet botmem-v2-health-recover.timer
systemctl is-active --quiet botmem-v2-health-recover.timer
echo 'operations install: backup verification and stateless health recovery timers are active'
