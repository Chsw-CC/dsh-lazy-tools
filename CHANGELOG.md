# Changelog

## 0.3.0

Stability first: the visible tool surface is frozen instead of being tuned per step.

- **Core tools stay eager.** `read`, `write`, `edit`, `apply_patch`, `glob`, `grep`, `bash`,
  `todo_write` remain native and directly callable. They used to be deferred, so every task
  paid a discovery hop before its first real step - that hop is the detour the model then
  worked around. Names the running registry does not have are skipped.
- **`use` / `release` removed.** Rewriting the visible list invalidates the cached prompt
  prefix, so the next request re-bills the whole context; the actions also taught the model to
  call a tool first and work second. The surface is now installed once per session and is
  byte-stable.
- **`list` carries parameter signatures.** `read(path, offset?)` is usually enough to call
  correctly, so the `schema` round trip mostly disappears.
- **A rejected call carries its own schema.** The failure answer includes the parameter table
  (omitted above 3000 characters), so the retry happens inside the same turn.
- **Unknown names return near misses.** A typo answers with the three closest tools instead of
  sending the model back to a full listing.
- **The view is installed at most three times.** Success latches; persistent failure leaves the
  surface open rather than stripping capabilities.

Compatible: `keep` is still read as `eager`, and `keep: false` means `eager: []`.

23 tests.

## 0.2.0

Tiered catalog (summary, then names, then prefixes with counts) so a listing degrades instead of
overrunning its budget; wildcard patterns in `keep`; the `list` header reports the token volume
being withheld. 24 tests.

## 0.1.1

Three behaviour fixes, not just refactoring:

- `call` no longer truncates a tool's real result; only catalog surfaces are budgeted.
- The restriction is installed before the previous one is released, so a failure cannot leave an
  agent over-exposed.
- The definition index is cached against `tools/change` instead of rebuilt per call.

Also: nesting guard, a 1.5 s inventory probe deadline, skill providers isolated, schema descriptions
clipped at 600 characters while the parameter tree stays verbatim. 22 tests.

## 0.1.0

First release: one `toolbox` entry point with `list`, `schema`, `call`, `skill`, `plugins`,
`use` and `release`.
