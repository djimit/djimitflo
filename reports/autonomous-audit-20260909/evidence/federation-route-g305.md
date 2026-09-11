# Federation peer/capability route proof — G305

The authenticated local HTTP fixture registers a high-trust federation peer, reads it back through `/federation/peers`, inserts a validated local capability, and projects it through `/federation/capabilities`. Existing federation work-distribution and capacity proofs remain green. Focused federation coverage passes 3/3 files (4 tests).

This proves local peer/capability registration and projection only; no external peer trust or cross-node delivery is certified.
