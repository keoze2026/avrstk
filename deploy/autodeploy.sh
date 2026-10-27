#!/usr/bin/env bash
# Deploys new commits on main to the VPS. Cron runs it every minute; when the branch has not moved it does
# nothing and prints nothing. Same system as CallsTalk's server/deploy/autodeploy.sh. Steps, limited to what
# the new commits touch:
#
#   package*.json                    npm ci
#   src/, tsconfig.json, package*    npm run build
#   anything but *.md and docs/      pm2 restart, then check the bot stays up
#
# If a step fails or the bot does not stay up, the previous commit is put back, rebuilt and restarted, and the
# failed commit is not tried again until a newer one is pushed.
# A manual rollback (git checkout <commit>, which leaves the branch) pauses it until the branch is checked out.
# .env and data/groups.json are ignored by git, so a deploy never touches them.
#
#   * * * * * /bin/bash /root/avrstk/avrstk/deploy/autodeploy.sh >> /var/log/avrstk-deploy.log 2>&1

set -euo pipefail

REPO=${AVRSTK_REPO:-/root/avrstk/avrstk}
BRANCH=main
APP=avrstk-bot
# cron's own PATH is only /usr/bin:/bin
export PATH="$PATH:/usr/local/sbin:/usr/local/bin:/usr/sbin:/sbin"
export HOME=${HOME:-/root}
export GIT_TERMINAL_PROMPT=0 # fail instead of waiting for a password nobody will type

FAILED=$REPO/.git/autodeploy-failed # the commit that last failed to deploy
NOTE=$REPO/.git/autodeploy-note     # the last problem logged, so a repeating one is logged once

log() { echo "$(date '+%F %T') $*"; }
note() { [ "$(cat "$NOTE" 2>/dev/null)" = "$*" ] || { log "$*"; echo "$*" > "$NOTE"; }; }
short() { git rev-parse --short "$1"; }

# The bot has no health URL, so "healthy" means PM2 shows it online and it has not restarted for 15 s.
# A bad token, a 409 Conflict or a startup crash makes it exit, and PM2's restart resets the uptime.
healthy() {
  sleep 20
  pm2 jlist 2>/dev/null | node -e '
    let s = "";
    process.stdin.on("data", d => (s += d)).on("end", () => {
      const app = JSON.parse(s).find(a => a.name === process.argv[1]);
      const up = app && app.pm2_env.status === "online" ? Date.now() - app.pm2_env.pm_uptime : 0;
      process.exit(up >= 15000 ? 0 : 1);
    });' "$APP"
}

# Runs the steps the changed files need ("all" runs every step). Each step stops it on failure by hand:
# set -e does not apply inside a function called from an if.
build() {
  local changed=$1
  touches() { [ "$changed" = all ] || grep -qE "$1" <<< "$changed"; }
  touches_other_than() { [ "$changed" = all ] || grep -qvE "$1" <<< "$changed"; }

  if touches '^package(-lock)?\.json$' || [ ! -d "$REPO/node_modules" ]; then
    log "installing packages"
    (cd "$REPO" && npm ci --no-audit --no-fund) || return 1
  fi
  if touches '^(src/|tsconfig\.json$|package(-lock)?\.json$)' || [ ! -f "$REPO/dist/index.js" ]; then
    log "building"
    (cd "$REPO" && npm run build) || return 1
  fi
  if touches_other_than '(\.md$|^docs/)'; then
    log "restarting $APP"
    (cd "$REPO" && pm2 startOrRestart ecosystem.config.js > /dev/null) || return 1
    healthy || { log "$APP did not stay online (pm2 logs $APP --err --lines 50 --nostream)"; return 1; }
  fi
}

main() {
  cd "$REPO"
  exec 9> "$REPO/.git/autodeploy.lock"
  flock -n 9 || exit 0 # the previous run is still deploying

  [ "$(git symbolic-ref -q --short HEAD)" = "$BRANCH" ] || exit 0 # rolled back by hand: paused
  local out
  out=$(git fetch -q origin "$BRANCH" 2>&1) || { note "cannot fetch $BRANCH: $out"; exit 1; }

  local old new
  old=$(git rev-parse HEAD)
  new=$(git rev-parse FETCH_HEAD)
  [ "$old" != "$new" ] || exit 0
  [ "$(cat "$FAILED" 2>/dev/null)" != "$new" ] || exit 0
  if ! git merge-base --is-ancestor "$old" "$new"; then
    note "not deploying $(short "$new"): $BRANCH was rewritten (force push), so it does not follow $(short "$old"). Deploy it by hand."
    exit 1
  fi
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    note "not deploying $(short "$new"): files were changed on the server (git status). See MAINTENANCE.md."
    exit 1
  fi

  local changed
  changed=$(git diff --name-only "$old" "$new")
  log "deploying $(short "$new") over $(short "$old"): $(git log -1 --format=%s "$new")"
  if git merge -q --ff-only "$new" && { [ -z "$changed" ] || build "$changed"; }; then
    rm -f "$FAILED" "$NOTE"
    log "deployed $(short "$new")"
    exit 0
  fi

  log "FAILED to deploy $(short "$new"); putting $(short "$old") back"
  echo "$new" > "$FAILED"
  git reset -q --hard "$old"
  if build all; then
    log "back on $(short "$old"); $(short "$new") is skipped until a newer commit is pushed"
  else
    log "$(short "$old") did not come back either: the bot needs a hand (MAINTENANCE.md, Auto-deploy)"
  fi
  exit 1
}

# Read in full before it runs, so a deploy that changes this file does not change it under the running copy.
main "$@"
exit
