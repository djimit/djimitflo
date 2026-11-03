#!/bin/bash
# usage: run.sh script.js > out.json   (read-only probe in prod container; script opens the DB readonly)
f=$1; b=evo_$RANDOM.${f##*.}
scp -q "$f" vps-agentical:/tmp/$b && ssh vps-agentical "docker cp /tmp/$b djimitflo-live:/tmp/$b && docker exec -e NODE_PATH=/app/node_modules djimitflo-live node /tmp/$b; docker exec -u root djimitflo-live rm -f /tmp/$b; rm -f /tmp/$b"
