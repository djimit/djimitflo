#!/bin/bash
# usage: probes/run.sh probes/<script> > out.json
# Read-only: the script is piped over stdin into node inside djimitflo-live (no file is written in the container) and
# opens /data/djimitflo.sqlite with {readonly:true, fileMustExist:true}. .mjs probes import prod's own compiled dist.
f=$1
case "$f" in *.mjs) flag="--input-type=module";; *) flag="";; esac
ssh vps-agentical "docker exec -i -e NODE_PATH=/app/node_modules -w /app/packages/server djimitflo-live node $flag -" < "$f"
