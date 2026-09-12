# G380 — social exchange accounting repair

Root cause: `ContinuousLearningLoop.runCycle()` reported `socialization.messages.length` as `socialExchangesStarted`, counting the two peer messages emitted by one exchange as two exchanges.

Correction: report `1` only when the socialization result status is `started`, otherwise `0`.

Focused `continuous-learning-loop.test.ts`: 8/8 passed, including a two-agent fixture that emits two `social.question` messages while asserting `socialExchangesStarted === 1`.
