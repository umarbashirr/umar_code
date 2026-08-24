#!/usr/bin/env bash
# Stop a running instance, but only if the recorded pid really is one of ours.
PID=$(node -p "try{require(require('os').homedir()+'/.tandem/bridge.json').pid}catch(e){0}" 2>/dev/null)
[ -z "$PID" ] || [ "$PID" = "0" ] && exit 0
CMD=$(tr '\0' ' ' < /proc/$PID/cmdline 2>/dev/null)
case "$CMD" in
  *electron*|*tandem*) kill "$PID" && echo "stopped $PID" ;;
  *) echo "pid $PID is not ours, leaving it alone" ;;
esac
