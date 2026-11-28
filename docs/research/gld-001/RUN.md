# GLD-001: how the run is done

Protocol: [`PREREG.md`](PREREG.md) (frozen). The operator runs every step that installs or starts third-party code; an
agent only prepares the commands and reads the result file.

1. **Model host (operator, any host with a supported GPU).** In a fresh virtualenv, outside every agent skill directory:
   `hf download fastino/GLiDE-0.4B --revision 16fb9d63cc34d1b4b5a1fb7cbf2d9d4a3dd5ad71 --local-dir GLiDE-0.4B`, check the
   two sha256 values of PREREG §0 (`shasum -a 256 GLiDE-0.4B/*.safetensors`), `pip install -r requirements.txt`, then
   `python -m glide.server --model GLiDE-0.4B --host 127.0.0.1 --port 8000` (the default bind is `0.0.0.0`; use the tailnet
   address instead of loopback only if the replay runs on another host). `GET /health` answers when it is ready. The vendor
   validated one NVIDIA Blackwell GPU with CUDA 13.0 wheels; a load failure on other hardware is a result (RESULTS.md), not
   something to patch around.
2. **Database copy (operator).** A consistent copy of the production database (`sqlite3 <db> ".backup <copy>"` on the VPS,
   then copied to the replay host). Never the live file, never inside the production container.
3. **Dry run.** `npx tsx packages/server/src/scripts/system-one-replay.ts --db <copy>` prints the case count and the copy's
   sha256. Below 200 cases: stop, INSUFFICIENT_EVIDENCE.
4. **Replay, once.** Add `--url http://127.0.0.1:8000 --out gld-001-result.json`. The script refuses a public host.
5. **Record.** `RESULTS.md` next to this file: the result JSON, the copy's sha256, hardware, deviations. Stop the server and
   delete the database copy.
