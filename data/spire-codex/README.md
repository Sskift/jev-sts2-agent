# Spire Codex public rule snapshot

The `v0.111.0` directory stores the complete English JSON responses for 14 gameplay entity categories. They were fetched from the Beta channel after checking `/api/beta/version` both before and after download. `manifest.json` records the source URLs, timestamp, counts and SHA-256 checksums. This is the version supported by the current game/mod build; updating the game requires reviewing and updating this pinned snapshot.

Source: [Spire Codex](https://spire-codex.com/developers), by Peter Lord and contributors. Game content belongs to Mega Crit Games. See the source's [hosted API terms](https://github.com/ptrlrd/spire-codex/blob/main/API_TERMS.md); the project's MIT license does not relicense this third-party game data. No upstream parser code or game assets are included.

Refresh explicitly with `node --use-system-ca scripts/sync_rules.mjs v0.111.0`. The script refuses a different advertised Beta version. Gameplay reads local files once and makes no Wiki requests. No Python service, embedding model, or vector database is needed.

`src/rule_reference.mjs` selects current cards, relics, potions, enemies, event/selection choices and their related powers, keywords, modifications and generated cards. It keeps base/upgrade rules separate from live values. It does not expand a random pool into all possible cards, expose this run's RNG, or add actions from reference event branches. Missing entries/pages remain explicit.

The raw snapshot is a community extraction, not an authoritative runtime simulator. For example, Blade Dance has `cards_draw: 3` even though its description says it generates Shivs; dynamic Strength/Dexterity descriptions may omit amounts. Such parsed numeric summaries do not drive our calculations. Requests use rule text and relationships, while native resolved descriptions, target previews, upgrades, current amounts, actual options and legal actions take precedence. Cosmetic image URLs, flavor text, dialogue, unrelated source lists and broad Ancient offering pools remain stored locally but are not injected into decisions.
