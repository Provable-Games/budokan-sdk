# Grouping bracket tournaments into one card (Budokan client)

**Audience:** an engineer/agent implementing bracket grouping in the **Budokan
client** (budokan.gg). The SDK side is already implemented — this describes how
to consume it.

## Problem

A "bracket" is a 1v1 single-elimination tournament built over **many Budokan
tournaments — one per match** (4 players = 3 tournaments, 8 = 7, 16 = 15). The
client renders each as its own card, so one bracket looks like N unrelated
tournaments. We want to **recognise the matches of one bracket and present them
as a single entity** (collapsed summary; expandable tree).

## How linking works: the on-chain gating IS the link

No extra metadata, no tags, no description pollution — the bracket structure is
**already encoded on-chain** by the gating:

- Round-1 matches are open (no entry requirement).
- Every round > 1 match is created with an `entry_requirement` that is a
  **`tournament_validator` extension**, whose `config` span lists the **feeder
  tournament ids** — i.e. the matches whose winners may enter. The config is
  `[qualifierType, qualifyingMode, topPositions, ...feederTournamentIds]`.

So the feeder relationships form the bracket tree. **Connected components of
that graph = brackets; the node nobody feeds = the final (root); round-1 matches
= the leaves.** Indexers already return `entry_requirement` in the tournament
list (verified on sepolia), so this is a **pure client-side transform over the
list you already fetch — one API query, no extra RPC, no contract change.**

Example (live sepolia) — a final gated on winning tournament 5 or 6:
```json
"entry_requirement": {
  "entry_limit": 1,
  "entry_requirement_type": {
    "type": "extension",
    "address": "0x62b5418…",            // the tournament_validator
    "config": ["0x1","0x0","0x1","0x5","0x6"]   // → feeders 5, 6
  }
}
```

## Use the SDK (`@provable-games/budokan-sdk`)

Two functions do the work; the client just maps its API objects in.

```ts
import { reconstructBrackets, decodeTournamentValidatorConfig } from "@provable-games/budokan-sdk";

const { brackets, standalone } = reconstructBrackets(tournaments, {
  getId: (t) => t.id,
  // Return the extension entry requirement (address + config) or null.
  getEntryRequirement: (t) =>
    t.entryRequirement?.entry_requirement_type?.type === "extension"
      ? t.entryRequirement.entry_requirement_type   // { address, config }
      : null,
  // Optional: only treat the known validator as a bracket gate (strict).
  // validatorAddress: extensionAddressFor(chain, "tournament"),
});
```

Returns:
- `standalone: T[]` — tournaments not part of any bracket → render as today.
- `brackets: BracketGroup<T>[]`, each:
  - `bracketId` — the final (root) tournament id (stable grouping key)
  - `size` (= 2^rounds), `rounds`
  - `final?` — the final match's tournament
  - `matches: BracketMatchNode<T>[]` — sorted by `(round, matchIndex)`, each
    `{ tournament, tournamentId, round, matchIndex, isFinal, feederTournamentIds }`

`decodeTournamentValidatorConfig(config)` is exposed too, if you want the raw
`{ qualifierType, qualifyingMode, topPositions, feederTournamentIds }`.

## Client rendering

**Collapsed card (one per bracket):**
- Title: `<gamePrefix> — Bracket` (gamePrefix from a match name, before `R`).
- `size` players; **status** (see below); **prize pool** = aggregate of prizes
  across the bracket's matches, per token (the pool is spread across matches by
  placement tier); **champion** when complete.

**Expanded card — the tree:**
- Render `rounds` columns; each match is a node with its two competitors,
  scores, the winner (highlight), and a link to its tournament page
  (`/tournament/<id>?network=<chain>`). Edges come from `feederTournamentIds`.
- An empty competitor = a **bye/walkover** (under-filled bracket).

**Derived fields:**
- **Status:** `Complete` if the final has a position-1 finisher; else
  `Round k live` (highest round with an active match); else `Registering`.
- **Champion:** position 1 of the `final` match's leaderboard.
- **Prize pool:** sum prize amounts across all matches, per token; placement
  breakdown maps to positions (final p1 = 1st, final p2 = 2nd, each semi p2 =
  tied-3rd, …).

## Caveats
- **Gated brackets only.** Every bracket the bot creates is gated (`gated:true`),
  so coverage is 100% in practice; a hypothetical ungated bracket has no
  `entry_requirement` and wouldn't group.
- **Partial lists:** if the API page doesn't include every match of a bracket,
  only the present matches are grouped (still correct; the tree is partial).
- **`bracketId` is synthetic** (the final/root tournament id), not the bot's
  internal id — fine as a grouping key and stable.
- **Custom descriptions/names are untouched** — grouping reads the gating, not
  the text, so organizers can set any description on a bracket.

## Acceptance criteria
- A deployed 4 / 8 / 16-player bracket renders as **one** card.
- Expanding shows the correct tree (round-1 pairings, feeder→match edges, final).
- Champion shown when the final resolves; pool aggregates across matches.
- Standalone tournaments unaffected. Works on sepolia + mainnet.
