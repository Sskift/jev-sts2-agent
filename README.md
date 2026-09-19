# jev-sts2-agent

A local agent loop for playing Slay the Spire 2 with structured game-state decisions.

## Current status

This repository currently contains the TypeSafe/Jev API smoke tests and the installed TypeSafe skill. The implementation plan is being researched before building the loop.

- `.env` is local-only and ignored. Set `TYPESAFE_API_KEY` there.
- Claude/Opus credentials are read from the local Claude Code configuration at runtime; do not copy them into this repository.
- Research and the first implementation plan are documented in the linked Feishu document delivered with this task.

## Initial direction

Use the STS2 CLI mod as the primary state/action transport when available. Use Claude Opus 5 for screen understanding and recovery when the structured mod state is incomplete; use Jev for narrow, typed choices such as play-card, target, route, reward, and end-turn judgments.
