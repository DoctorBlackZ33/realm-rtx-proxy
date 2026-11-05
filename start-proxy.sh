#!/bin/sh

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || {
  printf '%s\n' 'Could not locate the application directory.' >&2
  exit 1
}
cd "$SCRIPT_DIR" || exit 1

if [ -x "$SCRIPT_DIR/runtime/node" ]; then
  NODE="$SCRIPT_DIR/runtime/node"
elif [ -x "$SCRIPT_DIR/runtime/node.exe" ]; then
  NODE="$SCRIPT_DIR/runtime/node.exe"
elif command -v node >/dev/null 2>&1; then
  NODE=$(command -v node)
else
  printf '%s\n' 'Node.js 24 or newer is required. Place the bundled runtime in runtime/ or install Node.js 24+ for source use.' >&2
  exit 1
fi

exec "$NODE" "$SCRIPT_DIR/app.js" "$@"
