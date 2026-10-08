# Fork upgrade to DSH 0.2

This fork targets DSH `0.2.0-rc.2`, Lark `0.19.17-fork.1`, Codex Connect
`0.2.0-alpha.2`, and Mnemon `0.5.24`. The fork baseline is Lark origin/main
`d91dfa2`; the upstream Lark baseline remains `6e722e0` (`0.19.16`).

## Runtime compatibility

The in-process Web bridge uses the public `sessionController` service instead
of the removed HTTP `session.create` / `events.mux` interface. Session events
and transient assistant streams feed the existing renderer. Committed answers
fill missing text without repeating streamed prefixes; committed usage stays
deduplicated by step, and first-class tool results retain their call IDs.

Native cancellation handles stops during session creation and prompt acceptance.
Controller availability and removal are tied to the plugin lifecycle. Settings
use loader-owned volatile references and native browser config forms.

SDK launch flags map to the new public launch options. Unsupported arbitrary
commands and flags fail explicitly. ACP handles asynchronous provider
registration. DSH 0.2 profiles own their provider configuration: legacy
`settings.yaml` is imported into the first profile and retained as a backup;
independent SDK/ACP profiles need their own provider rows.

The native Host uses the current DSH session model selection. It does not call
`selectModel` solely to apply a bridge model override, because that API also
changes the saved default for future sessions. The standalone legacy HTTP Web
adapter is not the DSH 0.2 production integration.

## Preserved fork behavior

| Area | Preserved behavior |
| --- | --- |
| Permissions | Native Web approval routing; Feishu scope policies and YOLO; plan tool omitted when its gate is off; Feishu questions use Lark cards |
| Feedback | Inline votes, actor names and reasons, correction requests, curated memory writeback |
| Learning | Follow-up user corrections, conversation evidence, scoped lessons and attribution |
| Cards | Friendly processing history, one-row metrics, all-step usage and tool counts |
| Files | Metadata/size preflight, bounded resumable downloads, attachment grounding |
| OCR | Canonical Python worker, checkpoint resume, quality retries, page warnings and progress bars |
| Groups | Selective intervention, recent history, filename indexing and stable sender identity |
| Reliability | Sparse history handling, bounded human questions, cancellation, quiet reconnect notices |

## Data preparation and rollback

Never run the new runtime against the live home before backing up its profile,
settings, sessions, bridge state, and memory. Keep credentials in their existing
home; no OAuth credential copying or reauthorization is required.

Some DSH 0.1.1 logs contain subagent descriptor v2, which the new v0 converter
rejects. `scripts/migrate-legacy-descriptors.mjs` validates these records through
both pinned runtimes, prepares a separate copy, and promotes the descriptor
version only when its composition remains identical. It rejects overlapping
paths and changed source files, publishes the completed directory atomically,
and creates a private SHA-256 receipt. Originals are never modified.

Use an immutable snapshot with all writers stopped for activation. Require
both a complete receipt and successful history validation before swapping the
prepared tree into service. A failed candidate remains separate from production.
Older Mnemon instructions/recall records can include a summary that the new
converter rejects. With explicit operator approval, pass
`--mnemon-summary-policy archive`: retain the message body, role and form,
remove only the incompatible summary field from the prepared copy, and record
the complete original source metadata in the private receipt. Keep the full
original session snapshot as well. Other producers and malformed summaries
are never silently converted. Without this option, affected records fail closed.
Do not erase,
archive/reset bindings automatically, or ignore a converter refusal.

Keep the previous runtime, profile and original session tree as the rollback
generation. If startup, OAuth/provider checks, or history reads fail, restore
that generation before reopening the bot. Preserve the existing loopback port
and tunnel target.

## Verification

`pnpm test` covers renderer, feedback, learning, file/OCR, policy and adapter
behavior. `pnpm compat:probe` uses an isolated home and local model fixture to
exercise SDK/ACP tasks, tools, questions, approvals and explicit resume failures.

The native Host probe additionally verifies real streaming, committed usage,
continuation, history, tool-free feedback generation and conversation learning:

```sh
DSH_HOST_PROBE_BIN=/path/to/dsh/lib/bin.js node scripts/probe-dsh-host.mjs
```

Set `DSH_HOST_PROBE_SESSIONS` to a prepared, private snapshot to verify every
source historical session, checks inventory coverage, fully replay-validates child
logs without activating them, and pages through root histories. The probe copies that snapshot into another isolated
home. It does not connect to Feishu or read OAuth credentials.
