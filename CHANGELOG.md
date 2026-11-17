# Changelog

## 0.3.2

Second review pass: close configuration and contract gaps, make search see the whole
description, and remove repeated work from the listing path. The only visibility change
is `run_code` joining the eager set in PTC compositions that provide it.

- **`skills:false` really disables skills now.** The catalog was hidden but the `skill`
  action still loaded skill bodies; it now refuses with a clear message, and the guide
  line is omitted. This matches the `Config` comment and README.
- **`run_code` stays eager when the PTC composition provides it.** It was missing from
  the default working set, so every PTC task needed a toolbox hop before doing work.
  The registry filter still drops the name in compositions that do not expose it.
- **`list` queries search the full description.** The filter used to match only the
  96-character rendered summary, so a tool whose description mentioned the query past
  that budget was reported as missing even though it existed.
- **JSON Schema wrappers without `type:"object"` are parsed.** `properties` plus
  `required` alone is enough for a signature; wrapper metadata such as `$id` is preserved,
  while a real parameter named `properties` is still treated as a parameter, not a wrapper.
- **Signatures are projected once per registry generation.** A repeated `list` reuses
  the rows instead of re-projecting every schema; cached `schema` blocks are cleared on
  `tools/change`, so an in-place definition update cannot answer with a stale block.
- **`plugins` has one total 1.5 s inventory deadline.** Per-call deadlines let four
  hanging methods on one service cost 4 × 1.5 s, and three services could hold the
  action for roughly 18 s. A timeout now stops probing, a rejection moves to the next
  method, and a service shape without an array is skipped instead of reported as zero
  plugins.
- **Input cleanup:** a non-text `query` no longer crashes the listing; `schema` trims,
  deduplicates and ignores non-string names; a blank `tool` is rejected before a
  registry lookup; group labels keep their separator (`mcp_*` and `mcp.*` stay distinct).
- **The token estimator includes Hangul**, so Korean catalogs are no longer priced as
  ASCII.

51 tests; CI runs the suite plus the first-call measurement.

## 0.3.1

Reliability pass over 0.3.0's frozen surface: no new visible state, only measurements and
answers that were wrong or unhelpful.

- **The listing budget is measured in tokens.** `catalogTokenBudget` used to be read as characters
  and multiplied by four, which priced a Chinese catalog at about a quarter of its real size.
  The estimator now counts one token per CJK character and a quarter per other character, so the
  configured 1200 means 1200 tokens in both languages.
- **Signatures keep whole parameters and carry types.** `read(path:str, offset?:int)`, with a short
  enum inlined when there is one. String enums stay quoted; numeric and boolean enums keep their
  declared type (`retries:int:1|2`), because `"1|2"` would read as strings. A signature over 160
  characters drops whole parameters and ends with `…` instead of cutting a name in half. JSON
  Schema wrappers are read too.
- **Skill discovery has a 2-second deadline.** A provider that never answers no longer holds the
  first listing hostage; the answer says the catalog was unavailable instead of pretending the
  session has no skills.
- **One budget covers both catalogs.** The tool and skill listings no longer each receive the full
  `catalogTokenBudget`; headers and notes are reserved, and the skills catalog gets what is left.
- **`schema` never splits a JSON block.** Blocks that do not fit one answer are named in a trailing
  note, to be fetched in a second call.
- **A listing cannot mix registry generations.** If the registry changes while skill discovery is
  awaited, the rows are re-rendered before the answer is assembled.
- **`call` tolerates two common shapes:** a tool name with surrounding whitespace, and an
  `arguments` object sent as a JSON string.
- **The withheld-token header is priced per schema**, so the saving it reports for Chinese
  profiles is no longer understated fourfold.

Compatible at the API level; `catalogTokenBudget` keeps its name but its unit is now tokens
(previously characters × 4). 34 tests; CI runs the suite plus the first-call measurement.

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
