# STS2 CLI Mod compatibility patch for game v0.111

This directory contains a local patch for [STS2-Cli-Mod](https://github.com/longkerdandy/STS2-Cli-Mod) at commit `e6ce5bb1f0e5af1213e59582b645c18027ded476`. That source declares game v0.103 support; the patch adapts the APIs that failed compilation against the installed v0.111 game.

Upstream review: [draft PR #1](https://github.com/longkerdandy/STS2-Cli-Mod/pull/1), fork branch `Sskift:codex/sts2-0-111-compat`, commit `00ff596f55b73878aad0b0aa33cc5b99f642c9bd`.

Read [UPSTREAM-NOTICE.md](UPSTREAM-NOTICE.md) for attribution and the unresolved upstream licensing status. No full upstream source or DLL is committed here.

## Decision context extension (2026-09-20)

The build applies `decision-context.patch` after the original compatibility patch, and copies our `context/DecisionContextBuilder.cs` into the temporary source. It produces **0.111.0-context.16**, assembly/file version **0.111.0.17**. The original draft PR above only contains the v0.111 API compatibility changes; the decision-context extension is maintained in this repository.

context.16 reads the native `CalculatedBlock.PreviewValue` when a card has no standard `Block` variable. This fixes missing immediate Block on Expect a Fight and covers the same native variable used by Mirage. The native preview already includes current modifiers; Node does not add Strength/Dexterity again. Rage's separate per-attack power is unchanged. Full compilation and 12 checks against the actual patched builder with native API stubs passed. Installed at the main menu after run 19 ended; DLL SHA256 `FE630450A50130601BCA5ECD4B2744819BCB745B62351679E04AAC9CE503B87A`. A live occurrence of a calculated-Block card remains to be verified.

context.15 fixes a live Cauldron purchase deadlock: the native purchase obtains the relic and then awaits its potion rewards, while the pipe server waits for the purchase handler. The handler now hands control back when a reward or card/relic selection appears, reporting `selection_required: true` and `purchase_complete: false`. It preserves the same native task, rejects a duplicate purchase while it is pending, observes later faults, and returns `PURCHASE_TIMEOUT` after the existing five-second UI wait if no supported handoff appears. Node retains an unresolved action on that timeout rather than replaying it. The original price is captured before acquisition hooks can change the entry. 37 actual-handler checks with stub native APIs and the full build passed; the new binary has not yet been deployed or exercised live. Run 18 recovered the already-running old handler through Jev-selected, screenshot-grounded game-window reward inputs without restarting the game or repurchasing.

Context.14 exports the same `details.instance_id` in selectable/selected hand cards and the combat hand, and exposes each upgradable hand card's native `upgrade_preview`. The detached preview preserves the owner for current combat variables but does not execute upgrade/play hooks or target-dependent effects. Star costs share the native detached-preview limitation: global hooks requiring a real combat pile are not predicted. Cloning first clears event delegates on an unregistered shallow staging copy, so native enchantment cloning cannot notify the live card's subscribers; the live object is never cleared or upgraded. Unknown event backing-field layouts fail closed. The build and 26 targeted actual-builder assertions plus 25 existing upgrade assertions passed with stub game APIs; live behavior needs separate confirmation.

The extension collects player, permanent deck, current-act map, card enhancements, rules and combat history in the same main-thread snapshot as the screen. It preserves combat beneath overlays, reports extraction gaps, exports card/potion usability and targets, and formats power/card rules with current values. Target damage previews use the game's normal preview hooks and support both fixed `Damage` and `CalculatedDamage` variables, including Perfected Strike and Body Slam. All-enemy attacks also expose previews for the native HittableEnemies recipient set; random targets remain unknown. No hidden draw order, RNG, future encounter table or seed is exported. Run identity uses the saved start time; combat/card identities are opaque random identifiers.

See the [decision context and coverage](../../docs/decision-context.md) and [live run progress](../../docs/full-run-progress.md). An older mod without this contract is rejected before a Jev/game-action request. Context builds have been deployed and tested through Act 2's boss, including shops, rewards, enchantment confirmation and act transitions; a complete three-act victory is still pending. The calculated-damage path was verified live in the ninth run: Perfected Strike previewed 22 damage and reduced the boss from 163 to 141 HP. Explicit HpLossVar values are also exported as hp_loss before prevention hooks. Earlier single-battle evidence below describes the initial compatibility build only.

FakeMerchant custom events expose the already initialized, currently accessible merchant inventory as `SHOP`, with their event ID/title, stock, native rules and prices. A shared resolver is used by state extraction and all four purchase/removal handlers. It rejects inaccessible overlays and started fights; purchases still use the game's native merchant entry checks and actions. Finished events use the existing `proceed` command instead of assuming a standard option-button layout.

Event completion compares the visible page and full option content, including descriptions and text keys. It waits for interactive buttons and two matching observations, so repeated pages with the same button titles but different costs are recognized without accepting a transient click flag. The native card-reward Skip behavior is preserved: it closes the picker while retaining the reward; Node remembers the prior choice.

## Changes

- Three reads of the removed `CombatManager.IsPlayPhase` property now check the local player's `PlayerCombatState.Phase == PlayerTurnPhase.Play`.
- The end-turn handler also listens for `PlayerTurnPhaseChanged` and unsubscribes in `finally`. The game's v0.111 XML documentation states that each player progresses from Start through AutoPrePlay to Play; the old TurnStarted event alone does not establish play readiness.
- Five reads of the removed `MerchantRoom.Inventory` property now call the public `GetLocalInventory()` method.
- The combat state DTO's source documentation is updated.

These replacements were identified from the installed `sts2.dll` public metadata and `sts2.xml`, without executing or inspecting live game memory during the build.

## Prerequisites

- Windows with an installed Slay the Spire 2 v0.111 game.
- Git, PowerShell, and an existing .NET 8 SDK with its .NET 8 reference pack.
- A separate clone of the upstream repository containing the pinned commit.

The script does not install an SDK, change global runtime configuration, start the game, or deploy a mod. It does not invoke the upstream MSBuild targets, including `DeployMod`.

## Build

From the repository root, with your own source and game locations:

```powershell
git clone https://github.com/longkerdandy/STS2-Cli-Mod.git "$env:TEMP\sts2-cli-upstream"
./mods/sts2-cli-compat/build.ps1 `
  -GameDir 'D:\SteamLibrary\steamapps\common\Slay the Spire 2' `
  -SourceDir "$env:TEMP\sts2-cli-upstream" `
  -OutputDir './mods/sts2-cli-compat/out'
```

All three paths are configurable. `SourceDir` is read through `git archive` at the pinned commit; its working tree is not modified and local edits are not included. The script exports that clean source under `OutputDir`, checks/applies both patches, copies the context builder, then compiles it. Output inside the game directory is rejected. Each run keeps a separate work directory for inspection and does not delete previous work.

To inspect patch applicability independently, check out the pinned commit in a disposable clone and run:

```powershell
git -C path/to/disposable-clone checkout e6ce5bb1f0e5af1213e59582b645c18027ded476
git -C path/to/disposable-clone apply --check path/to/jev-sts2-agent/mods/sts2-cli-compat/v0.111-compat.patch
```

Successful outputs:

- `STS2.Cli.Mod.dll` and `STS2.Cli.Mod.json`, manifest version `0.111.0-context.13`, assembly version `0.111.0.14`.
- `compile.log` and `compile.rsp`, containing the build output and exact compiler inputs.
- `build-evidence.json`, recording the upstream commit, both patch hashes, context builder and game assembly hashes, compiler location, source/reference counts, exit code, binary hash, and `deploymentPerformed: false`.

The existing CLI executable remains a separate upstream component; this builds only the in-game mod.

## Why the .NET 8 compiler works here

The source uses C# 12, supported by the installed Roslyn compiler in SDK 8.0.408. The script disables implicit standard-library references and supplies the installed game's managed .NET 9 assemblies as explicit references, including its pipe-access-control assembly. The official .NET 8 regex generator handles the upstream `GeneratedRegex` partial methods. Generated assembly metadata identifies the target runtime as .NET 9, matching the game host.

The original source produced eight CS1061 errors against the game. With this patch, all 102 mod source files compiled against 186 managed game/runtime assemblies with zero errors and zero warnings on the verified installation.

The compatibility build also loaded into the Windows v0.111.0 game and completed a live single-player `NIBBITS_WEAK` battle: six card plays, two end-turn calls, then the reward screen with 20 gold and a card reward. Both end-turn calls reached the next playable phase. The game did not need foreground focus. Local session evidence is `run-artifacts/2026-09-19T16-39-33-428Z-dcc28eb7/session.json` with the reward state in `step-0017/before-state.json`; these local run artifacts are not committed.

This is a local compatibility build using runtime implementation metadata, rather than an official .NET 9 reference pack and the standard project restore. SDK/runtime updates may change that behavior. Compilation proves that referenced APIs exist; it does not prove every gameplay path works. Revalidate mod loading, `ping`, `state`, combat card play, end turn, and combat completion on another installation after explicit deployment and game restart. Shop changes still require runtime verification. The patch retains the upstream single-player local-player assumption; multiplayer and older game versions are untested. A power-description formatting error involving an `Amount` template was observed on the newer game, remains outside this patch, and did not prevent the battle from completing.
