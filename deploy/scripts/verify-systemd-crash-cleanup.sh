#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "run as root" >&2
  exit 2
fi

unit="doorbell-bell-crash-test.service"
test_dir="$(mktemp -d /tmp/doorbell-bell-crash-test.XXXXXX)"

cleanup() {
  systemctl stop "${unit}" >/dev/null 2>&1 || true
  systemctl reset-failed "${unit}" >/dev/null 2>&1 || true
  rm -rf -- "${test_dir}"
}
trap cleanup EXIT

cat >"${test_dir}/main.sh" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
test_dir="$1"
exec 9>"${test_dir}/counter.lock"
flock 9
generation=0
if [[ -f "${test_dir}/generation" ]]; then
  generation="$(<"${test_dir}/generation")"
fi
generation=$((generation + 1))
printf '%s\n' "${generation}" >"${test_dir}/generation"
if [[ -f "${test_dir}/old-child.pid" ]]; then
  old_child="$(<"${test_dir}/old-child.pid")"
  if kill -0 "${old_child}" 2>/dev/null; then
    touch "${test_dir}/overlap"
  fi
fi
bash -c 'trap "" TERM; while :; do sleep 1; done' &
child_pid=$!
printf '%s\n' "${child_pid}" >"${test_dir}/child.pid"
if [[ ${generation} -eq 1 ]]; then
  printf '%s\n' "${child_pid}" >"${test_dir}/old-child.pid"
else
  touch "${test_dir}/restarted"
fi
wait "${child_pid}"
SCRIPT
chmod 0700 "${test_dir}/main.sh"

systemd-run \
  --unit="${unit}" \
  --property=Type=exec \
  --property=KillMode=control-group \
  --property=SendSIGKILL=yes \
  --property=Restart=on-failure \
  --property=RestartSec=5s \
  --property=TimeoutStopSec=20s \
  "${test_dir}/main.sh" "${test_dir}" >/dev/null

for _ in {1..100}; do
  [[ -s "${test_dir}/old-child.pid" ]] && break
  sleep 0.1
done
[[ -s "${test_dir}/old-child.pid" ]]
old_child="$(<"${test_dir}/old-child.pid")"
main_pid="$(systemctl show --property=MainPID --value "${unit}")"
[[ ${main_pid} =~ ^[1-9][0-9]*$ ]]
kill -KILL "${main_pid}"

for _ in {1..500}; do
  [[ -f "${test_dir}/restarted" ]] && break
  sleep 0.1
done
[[ -f "${test_dir}/restarted" ]]
[[ ! -f "${test_dir}/overlap" ]]
if kill -0 "${old_child}" 2>/dev/null; then
  echo "old injector descendant survived into the restarted unit" >&2
  exit 1
fi

echo "systemd crash cleanup verified"
