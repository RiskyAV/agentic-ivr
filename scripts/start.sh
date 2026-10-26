#!/usr/bin/env bash
# Container entrypoint: mock systems on 127.0.0.1:$MOCK_PORT, then the server on $PORT.
# Both are supervised: if either exits, the other is stopped and the container exits with that code.
set -euo pipefail
cd "$(dirname "$0")/.."

export MOCK_PORT="${MOCK_PORT:-4100}"
export MOCK_BASE_URL="${MOCK_BASE_URL:-http://127.0.0.1:${MOCK_PORT}}"
export PORT="${PORT:-4000}"

pids=()
stop() { for p in "${pids[@]}"; do kill -TERM "$p" 2>/dev/null || true; done; }
stopping=0
trap 'stopping=1; stop' TERM INT

node --import tsx apps/mock-systems/src/main.ts &
pids+=($!)

# Wait (max 15 s) until the mocks accept connections before starting the server.
for _ in $(seq 1 75); do
  if (exec 3<>"/dev/tcp/127.0.0.1/${MOCK_PORT}") 2>/dev/null; then break; fi
  if ! kill -0 "${pids[0]}" 2>/dev/null; then echo "[start] mock systems exited during startup" >&2; exit 1; fi
  sleep 0.2
done

node --import tsx apps/server/src/main.ts &
pids+=($!)

code=0
wait -n "${pids[@]}" || code=$?
if [ "$stopping" = 1 ]; then wait || true; exit 0; fi
echo "[start] a process exited (code ${code}); stopping the other" >&2
stop
wait || true
[ "$code" = 0 ] && code=1  # an unexpected clean exit still means the container is not serving
exit "$code"
