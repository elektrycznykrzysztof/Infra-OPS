#!/bin/sh
set -eu

log_dir=/var/log/postgresql
container_log="$log_dir/postgres-container.log"
postgres_log="$log_dir/postgresql.log"
output_pipe="/tmp/postgres-container-output.$$"
retained_bytes=5242880

mkdir -p "$log_dir"
chmod 755 "$log_dir"

trim_log() {
  if [ -f "$1" ]; then
    tail -c "$retained_bytes" "$1" > "$1.trimmed"
    mv "$1.trimmed" "$1"
  fi
}

trim_log "$container_log"
trim_log "$postgres_log"
rm -f "$output_pipe"
mkfifo "$output_pipe"

# Mirror container stdout/stderr to files that the API can attach without Docker socket access.
tee -a "$container_log" "$postgres_log" < "$output_pipe" &
tee_pid=$!
/usr/local/bin/docker-entrypoint.sh "$@" > "$output_pipe" 2>&1 &
server_pid=$!

forward_shutdown() {
  kill -TERM "$server_pid" 2>/dev/null || true
}
trap forward_shutdown INT TERM

set +e
wait "$server_pid"
server_status=$?
while kill -0 "$server_pid" 2>/dev/null; do
  wait "$server_pid"
  server_status=$?
done
wait "$tee_pid"
exit "$server_status"
