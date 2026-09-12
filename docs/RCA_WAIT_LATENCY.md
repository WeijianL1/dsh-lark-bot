# Waiting and latency RCA — 2026-09-12

## Evidence

Read-only inspection of native session events and service logs identified distinct causes. Times below are wall-clock observations, not estimates of future performance. No private message content, identities, or credentials are included.

| Observed turn | Total | Confirmed contributors |
| --- | --- | --- |
| Sep 11, clarification | 631.5 s | 600 s waiting on `lark_ask_user`; 31.3 s over three model steps |
| Sep 11, long task A | 924.6 s | 36 model steps totaling 622.5 s; synchronous subagent call 192.1 s |
| Sep 11, long task B | 809.7 s | 26 model steps totaling 442.4 s; synchronous subagent call 261.1 s |
| Sep 12, history lookup | 100.5 s | Three history calls taking 15.8, 15.7, and 14.5 s |

Model timing pairs step/start with assistant/message within the same turn and step. Individual tool spans pair call/result events; overlapping spans must not be added as exclusive time. One interrupted turn was user-stopped, not a transport crash. Brief recovered WebSocket reconnects do not explain the long model/human waits above.

## Causes and fixes

1. Human clarification had no bounded handler wait and depended on the ten-minute outer tool timeout. The Web-only question tool also caused a failed attempt before the Lark fallback. Context grounding reduces unnecessary questions; channel guidance explicitly selects `lark_ask_user`. The handler now bounds delivery at 15 seconds and human waiting at 120 seconds after confirmed delivery. The outer tool watchdog is 180 seconds. No answer is not consent or rejection. Exact-question cleanup, immediate cancellation, late-card closure, and readonly expiry avoid stale forms. The model is instructed to end the turn with missing information instead of asking the same question again; this instruction is not a hard whole-turn limit.
2. Long workflows perform many serial model steps and sometimes wait synchronously for an independent reviewer. Execution guidance favors reusing extracts/OCR, batching independent reads, and background review where safe. This is model guidance, not a deterministic scheduler change; production improvement on a comparable long task remains to be measured.
3. The newly introduced history parser recursively visited missing fields through its depth bound, creating exponential traversal on sparse cards and blocking the event loop. The API timeout cannot interrupt synchronous JavaScript. Early rejection of null/non-object nodes removes this expansion. A zero-I/O fixture of 50 sparse cards took 24,209 ms before and 1 ms after the fix. This regression appeared with the history feature and does not explain Sep 11 latency. A regression test requires the fixture to finish within one second; network/member lookup time remains additional.
4. Progress treated human waiting like inactivity. Running cards now show an explicit human-input state for questions owned by that run's native session. Completion remains terminal and cannot display a stale waiting label.

## Validation and limits

Tests cover sparse-card parsing, answer expiry, absent delivery receipt, late delivery, cancellation during delivery, registry cleanup, and waiting/terminal card rendering. Full local CI additionally verifies types, build, runtime admission, PTY, publication bundle, and version compatibility. Live validation should use authenticated read-only history calls and service readiness checks, without sending unsolicited chat messages.

This does not promise a maximum duration for OCR, research, or model generation. Further optimization should compare equivalent tasks and distinguish model, tool, human, queue, and delivery time.
