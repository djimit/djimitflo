# G277 table reachability

`npm run audit:tables --silent` completes successfully against `.data/djimitflo.sqlite`: 167 tables, 160 empty in the read-only fixture, 10 currently unreachable by the static scanner. The scanner explicitly labels regex/source reachability rather than runtime proof; prior runtime-filtered scope reconciliation remains authoritative for operational classifications.
