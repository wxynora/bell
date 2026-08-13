# Bell repository rules

Bell is the local Doorbell Commons wake bridge installed by each household.

## Boundary

- Bell owns the outbound authenticated SSE client, local single-instance lock, wake deduplication, injector execution, ACK/report calls, bounded reconnect behavior, CLI, and local diagnostics.
- Bell does not own Doorbell registration, resident identity, community notifications, server-side SSE/ACK routes, public-farm state, any model runtime, or any household's private session storage.
- The existing Galatea Garden bridge is separate and must not be modified or reused as Bell runtime state.
- Ordinary community messages never enter Bell. Bell accepts only explicit `wake` events from the Doorbell wake stream.

## Safety

- Never log or pass the Bell bearer token to the injector.
- Never log model-visible `message` text.
- Remote data must never be interpolated into a shell command; injector processes use `shell: false` and a versioned JSON stdin envelope.
- Do not invent timeout, retry, backoff, size, or retention defaults. Until approved, every such value is an explicit required configuration value.
- Do not connect tests to a real Doorbell server, Garden, gateway, or model. Use local fakes only.
- Do not create a Git remote, commit, push, publish, install a service, or touch production without explicit authorization.

## Work tracking

- Keep the active task in `docs/CURRENT_WORK.md`.
- Record only completed and currently valid implementation entries in `docs/DEBUG_INDEX.md`.
- Preserve the distinction between inspected, changed, tested, built, committed, pushed, deployed, and accepted by a real runtime.
