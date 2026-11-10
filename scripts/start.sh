#!/bin/sh
# Starts the server from the repo this script belongs to, wherever that folder has moved.
# Settings come from ~/.config/interactive-document-translator/env (ANTHROPIC_API_KEY, PAPERGLOSS_PASSWORD, PORT,
# HOST, DATA_DIR). Refuses to start on online-only placeholders of a cloud-synced folder.
# With an instance name ("start.sh work"), it starts that other app of this code instead.
set -eu
cd "$(dirname "$0")/.."
instance="${1:-}"

# launchd and systemd start with a bare PATH; Homebrew keeps node, poppler and tesseract here.
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if [ -f "$HOME/.config/interactive-document-translator/env" ]; then
  set -a
  . "$HOME/.config/interactive-document-translator/env"
  set +a
fi
# Another app of this code: its name, id, port and data folder (instances/<name>.env, no secrets)
# go over the settings above. Its id (so its sign-in cookie, backups and log) and its data folder
# never come from those, which are the first app's: the id is its name unless its file gives one,
# and a file without a data folder of its own is refused.
first="${DATA_DIR:-data}"
if [ -n "$instance" ]; then
  case "$instance" in *[!a-z0-9]*)
    echo "'$instance' is no app's name: a name is lowercase letters and digits (instances/<name>.env)." >&2
    exit 1
    ;;
  esac
  if [ ! -f "instances/$instance.env" ]; then
    echo "No app named '$instance': there is no instances/$instance.env." >&2
    exit 1
  fi
  unset APP_ID DATA_DIR
  set -a
  . "instances/$instance.env"
  set +a
  export APP_ID="${APP_ID:-$instance}"
  # A folder's full path, where it exists. ponytail: one that doesn't exist yet is compared as
  # written (./data/ is not data until data is made).
  full() { (cd "$1" 2>/dev/null && pwd -P) || echo "$1"; }
  if [ -z "${DATA_DIR:-}" ] || [ "$(full "$DATA_DIR")" = "$(full "$first")" ]; then
    echo "The $instance app needs a data folder of its own: set DATA_DIR in instances/$instance.env ($first is the first app's)." >&2
    exit 1
  fi
fi
data="${DATA_DIR:-data}"

# A cloud-synced folder may hold online-only files as 0-byte placeholders, which read as empty.
empty=$( (find server public -type f -size 0; [ -d "$data" ] && find "$data" -type f \( -name meta.json -o -name book.json -o -name annotations.json -o -name raw.json \) -size 0) 2>/dev/null || true)
if [ -n "$empty" ]; then
  echo "These files are empty, most likely online-only placeholders of a synced folder:" >&2
  echo "$empty" >&2
  echo "Make the folder available offline, let the sync finish, then start again." >&2
  exit 1
fi

mkdir -p "$data/tmp"

exec node server/index.js
