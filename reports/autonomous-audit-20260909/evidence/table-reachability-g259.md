# G259 table reachability recheck

The read-only `npm run audit:tables` scan reports 167 runtime-shaped tables and 11 statically unreachable tables, with the existing documented limitations (regex/source reachability, not runtime liveness). No table deletion or production liveness claim is made.
