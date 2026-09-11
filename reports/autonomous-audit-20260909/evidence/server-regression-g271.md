# G271 server regression

The focused `/skills` route addition passes 13/13; the integration-spine
fixture passes 16/16 when isolated. The first full server run reproduced the
existing intermittent integration-spine response mismatch (`auth required`
instead of JSON) in one test. An immediate complete rerun passed **323 test
files, 2 skipped; 2,528 passed, 20 skipped, 0 failed**. The first failure is
retained as `UNKNOWN`; no auth boundary or assertion was weakened.
