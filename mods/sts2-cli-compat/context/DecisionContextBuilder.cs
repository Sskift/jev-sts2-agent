using System.Reflection;
using System.Runtime.CompilerServices;
using MegaCrit.Sts2.Core.Combat;
using MegaCrit.Sts2.Core.Combat.History.Entries;
using MegaCrit.Sts2.Core.Entities.Cards;
using MegaCrit.Sts2.Core.Entities.Potions;
using MegaCrit.Sts2.Core.Entities.Players;
using MegaCrit.Sts2.Core.HoverTips;
using MegaCrit.Sts2.Core.Localization;
using MegaCrit.Sts2.Core.Map;
using MegaCrit.Sts2.Core.Models;
using MegaCrit.Sts2.Core.Runs;
using STS2.Cli.Mod.Models.State;
using static STS2.Cli.Mod.Utils.TextUtils;

namespace STS2.Cli.Mod.State.Builders;

// Read on the same main-thread invocation as the screen DTO. No game commands,
// RNG reads, future encounter tables, seed, or ordered draw pile are exported.
public static class DecisionContextBuilder
{
    private sealed class Identity { public string Value { get; } = Guid.NewGuid().ToString("N"); }
    private static readonly ConditionalWeakTable<object, Identity> Identities = new();
    private static readonly List<string> Issues = [];
    private static string IdentityOf(object value) => Identities.GetValue(value, static _ => new Identity()).Value;
    private static string RunIdentity(RunState run)
    {
        // The saved start time survives game/agent restarts and contains no random seed.
        var start = typeof(RunManager).GetField("_startTime", BindingFlags.Instance | BindingFlags.NonPublic)?.GetValue(RunManager.Instance);
        return start is long value && value > 0 ? $"run-{value}" : IdentityOf(run);
    }

    public static void Begin() => Issues.Clear();
    public static void Report(string issue) => Issues.Add(issue);

    private static T? Read<T>(string field, Func<T> read)
    {
        try { return read(); }
        catch (Exception error) { Report($"{field}: {error.GetType().Name}"); return default; }
    }

    public static string PowerDescription(PowerModel power)
    {
        try
        {
            // Use the same fully formatted tooltip as the visible power icon.
            // SmartDescription alone omits owner-dependent variables (e.g. Slow).
            var tooltip = power.HoverTips.OfType<HoverTip>().FirstOrDefault();
            if (tooltip != null) return StripGameTags(tooltip.Description);
            var original = power.SmartDescription;
            var description = new LocString(original.LocTable, original.LocEntryKey);
            description.AddVariablesFrom(original);
            power.DynamicVars.AddTo(description);
            description.Add("Amount", power.Amount);
            return StripGameTags(description.GetFormattedText());
        }
        catch
        {
            return Read($"power.{power.Id.Entry}.description", () => StripGameTags(power.GetDumbHoverTip(power.Amount).Description)) ?? "";
        }
    }

    public static bool CanUsePotion(PotionModel potion)
    {
        var owner = potion.Owner;
        if (!owner.CanUseOrRemovePotions || !owner.Creature.IsAlive || potion.IsQueued || !potion.PassesCustomUsabilityCheck) return false;
        if (potion.Usage != PotionUsage.AnyTime && potion.Usage != PotionUsage.CombatOnly) return false;
        if (!RunManager.Instance.IsInProgress) return false;
        if (!CombatManager.Instance.IsInProgress) return potion.Usage == PotionUsage.AnyTime;
        return owner.PlayerCombatState?.Phase == PlayerTurnPhase.Play && !CombatManager.Instance.PlayerActionsDisabled && !CombatManager.Instance.IsOverOrEnding;
    }

    public static List<int> PotionTargets(PotionModel potion)
    {
        var combat = CombatManager.Instance.IsInProgress ? CombatManager.Instance.DebugOnlyGetState() : null;
        if (combat == null) return [];
        return combat.Enemies.Concat(combat.Players.Select(p => p.Creature))
            .Concat(potion.Owner.PlayerCombatState?.Pets ?? [])
            .Where(c => c.IsAlive && c.CombatId.HasValue && potion.IsValidTarget(c))
            .Select(c => (int)c.CombatId!.Value).Distinct().ToList();
    }

    public static List<int> CardTargets(CardModel card)
    {
        var combat = CombatManager.Instance.IsInProgress ? CombatManager.Instance.DebugOnlyGetState() : null;
        if (combat == null) return [];
        return combat.Enemies.Concat(combat.Players.Select(p => p.Creature))
            .Concat(combat.Players.SelectMany(p => p.PlayerCombatState?.Pets ?? []))
            .Where(c => c.IsAlive && c.CombatId.HasValue && card.CanPlayTargeting(c))
            .Select(c => (int)c.CombatId!.Value).Distinct().ToList();
    }

    public static object CardTargetPreviews(CardModel card)
    {
        var combat = CombatManager.Instance.IsInProgress ? CombatManager.Instance.DebugOnlyGetState() : null;
        if (combat == null) return Array.Empty<object>();
        return combat.Enemies.Concat(combat.Players.Select(p => p.Creature))
            .Where(c => c.IsAlive && c.CombatId.HasValue && card.CanPlayTargeting(c))
            .Select(target => new
            {
                target_id = (int)target.CombatId!.Value,
                description = Read($"card.{card.Id.Entry}.target_description", () => StripGameTags(card.GetDescriptionForPile(PileType.Hand, target))),
                damage = Read($"card.{card.Id.Entry}.damage_preview", () =>
                {
                    if (!card.DynamicVars.TryGetValue("Damage", out var value)) return (int?)null;
                    var preview = value.Clone();
                    preview.UpdateCardPreview(card, CardPreviewMode.Normal, target, true);
                    return (int?)preview.PreviewValue;
                })
            }).ToArray();
    }

    public static object CardDetails(CardModel card) => new
    {
        // Random opaque identity: assigning sequential IDs while enumerating a
        // draw pile would accidentally disclose its hidden order.
        instance_id = IdentityOf(card),
        upgrade_level = card.CurrentUpgradeLevel,
        target_type = card.TargetType.ToString(),
        star_cost = card.CanonicalStarCost < 0 ? (int?)null : card.HasStarCostX ? -1 : card.GetStarCostWithModifiers(),
        enchantment = card.Enchantment is { } enchantment ? new
        {
            id = enchantment.Id.Entry, amount = enchantment.Amount,
            description = Read($"enchantment.{enchantment.Id.Entry}", () => StripGameTags(enchantment.DynamicDescription.GetFormattedText()))
        } : null,
        affliction = card.Affliction is { } affliction ? new
        {
            id = affliction.Id.Entry, amount = affliction.Amount,
            description = Read($"affliction.{affliction.Id.Entry}", () => StripGameTags(affliction.DynamicDescription.GetFormattedText()))
        } : null
    };

    private static PileCardDto DeckCard(CardModel card, PileType pile) => new()
    {
        Id = card.Id.Entry, Name = StripGameTags(card.Title),
        Type = card.Type.ToString(), Rarity = card.Rarity.ToString(),
        Cost = card.EnergyCost.CostsX ? -1 : card.EnergyCost.GetAmountToSpend(),
        Keywords = card.Keywords.Where(k => k != CardKeyword.None).Select(k => k.ToString()).ToList(),
        IsUpgraded = card.IsUpgraded,
        Description = StripGameTags(card.GetDescriptionForPile(pile)),
        Details = CardDetails(card)
    };

    private static List<PileCardDto> Cards(IEnumerable<CardModel> cards, PileType pile)
    {
        var result = new List<PileCardDto>();
        foreach (var card in cards)
        {
            var dto = Read($"card.{card.Id.Entry}", () => DeckCard(card, pile));
            if (dto != null) result.Add(dto);
        }
        return result;
    }

    private static string PointType(MapPointType type) => type switch
    {
        MapPointType.RestSite => "REST_SITE",
        _ => type.ToString().ToUpperInvariant()
    };

    private static object Map(RunState run)
    {
        var map = run.Map;
        var points = map.GetAllMapPoints().Append(map.StartingMapPoint).Append(map.BossMapPoint)
            .GroupBy(p => p.coord).Select(g => g.First()).OrderBy(p => p.coord.row).ThenBy(p => p.coord.col);
        // Only the current act's visible topology. The second boss is not
        // exposed here: it may not yet be revealed to the player.
        var hiddenSecondBoss = map.SecondBossMapPoint?.coord;
        return new
        {
            act_index = run.CurrentActIndex,
            current_coord = run.CurrentMapCoord is { } current ? new { col = current.col, row = current.row } : null,
            visited = run.VisitedMapCoords.Select(c => new { col = c.col, row = c.row }).ToArray(),
            nodes = points.Where(p => !hiddenSecondBoss.HasValue || p.coord != hiddenSecondBoss.Value).Select(p => new
            {
                col = p.coord.col, row = p.coord.row, type = PointType(p.PointType),
                children = p.Children.Where(c => !hiddenSecondBoss.HasValue || c.coord != hiddenSecondBoss.Value)
                    .Select(c => new { col = c.coord.col, row = c.coord.row }).ToArray()
            }).ToArray(),
            boss = new { id = run.Act.BossEncounter.Id.Entry, name = GetLocText(run.Act.BossEncounter.Title) },
            hidden_information = "Question-mark contents, draw order, future encounters/rewards, unrevealed second boss and later acts are unknown."
        };
    }

    private static object[] History()
    {
        return CombatManager.Instance.History.Entries.Select((entry, index) =>
        {
            var card = entry switch
            {
                CardPlayStartedEntry e => e.CardPlay.Card,
                CardPlayFinishedEntry e => e.CardPlay.Card,
                CardDrawnEntry e => e.Card,
                CardDiscardedEntry e => e.Card,
                CardExhaustedEntry e => e.Card,
                _ => null
            };
            var flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
            var typed = entry is CardPlayStartedEntry or CardPlayFinishedEntry or CardDrawnEntry or CardDiscardedEntry or CardExhaustedEntry or EnergySpentEntry or BlockGainedEntry or DamageReceivedEntry or PowerReceivedEntry or PotionUsedEntry;
            return (object)new
            {
                sequence = index,
                type = entry.GetType().Name,
                round = Read("history.round", () => typeof(MegaCrit.Sts2.Core.Combat.History.CombatHistoryEntry).GetProperty("RoundNumber", flags)?.GetValue(entry)),
                side = Read("history.side", () => typeof(MegaCrit.Sts2.Core.Combat.History.CombatHistoryEntry).GetProperty("CurrentSide", flags)?.GetValue(entry)?.ToString()),
                actor_id = (int?)entry.Actor?.CombatId,
                card_id = card?.Id.Entry,
                card_instance_id = card != null ? IdentityOf(card) : null,
                result_pile = entry is CardPlayFinishedEntry play ? play.CardPlay.ResultPile.ToString() : null,
                potion_id = entry is PotionUsedEntry potion ? potion.Potion.Id.Entry : null,
                target_id = entry switch { CardPlayStartedEntry e => (int?)e.CardPlay.Target?.CombatId, CardPlayFinishedEntry e => (int?)e.CardPlay.Target?.CombatId, PotionUsedEntry e => (int?)e.Target?.CombatId, _ => null },
                source_id = entry switch { DamageReceivedEntry e => (int?)e.Dealer?.CombatId, PowerReceivedEntry e => (int?)e.Applier?.CombatId, _ => null },
                power_id = entry is PowerReceivedEntry powered ? powered.Power.Id.Entry : null,
                amount = entry switch { EnergySpentEntry e => (decimal?)e.Amount, BlockGainedEntry e => (decimal?)e.Amount, PowerReceivedEntry e => (decimal?)e.Amount, _ => null },
                damage = entry is DamageReceivedEntry damaged ? new { total = damaged.Result.TotalDamage, blocked = damaged.Result.BlockedDamage, unblocked = damaged.Result.UnblockedDamage, overkill = damaged.Result.OverkillDamage } : null,
                description = typed ? null : entry is MonsterPerformedMoveEntry ? "Enemy performed its observed move; damage and effects are recorded in the surrounding events." : Read($"history.{index}.description", () => StripGameTags(entry.Description))
            };
        }).ToArray();
    }

    private static object[] Glossary(IEnumerable<CardModel> cards, IEnumerable<AbstractModel> models)
    {
        var tips = new Dictionary<string, object>();
        void Add(IEnumerable<IHoverTip> entries)
        {
            foreach (var tip in entries.OfType<HoverTip>())
            {
                var title = StripGameTags(tip.Title);
                var description = StripGameTags(tip.Description);
                tips.TryAdd(title + "\n" + description, new { title, description });
            }
        }
        foreach (var card in cards)
            Read($"card.{card.Id.Entry}.tooltips", () => { Add(card.HoverTips); return true; });
        foreach (var model in models)
            Read($"model.{model.Id.Entry}.tooltips", () =>
            {
                switch (model)
                {
                    case RelicModel relic: Add(relic.HoverTips); break;
                    case PotionModel potion: Add(potion.HoverTips); break;
                    // Power descriptions are already resolved with Amount above.
                }
                return true;
            });
        return tips.Values.ToArray();
    }

    public static object? Build(GameStateDto screen)
    {
        if (!RunManager.Instance.IsInProgress) return null;
        var run = RunManager.Instance.DebugOnlyGetState();
        if (run == null || run.Players.Count != 1)
        {
            Report("A complete local single-player run is required");
            return new { schema_version = 1, extraction_errors = Issues.ToArray() };
        }
        var player = run.Players[0];
        var pcs = player.PlayerCombatState;
        var combat = CombatManager.Instance.IsInProgress ? CombatManager.Instance.DebugOnlyGetState() : null;
        var playerDto = screen.Combat?.Player ?? Read("player", () => PlayerStateBuilder.Build(player));
        var deck = Cards(player.Deck.Cards, PileType.Deck);
        var map = Read("map", () => Map(run));
        var history = combat != null ? Read("combat_history", History) : null;
        var playPile = combat != null && pcs != null ? Cards(pcs.PlayPile.Cards, PileType.Play) : null;
        var glossary = Glossary(player.Deck.Cards.Concat(combat != null && pcs != null ? pcs.AllCards : []), player.Relics.Cast<AbstractModel>().Concat(player.Potions));
        if (playerDto == null) Report("player missing");
        else
        {
            if (playerDto.Relics.Count != player.Relics.Count) Report("relic extraction incomplete");
            if (playerDto.Potions.Count != player.Potions.Count()) Report("potion extraction incomplete");
            if (playerDto.Powers.Count != player.Creature.Powers.Count(p => p.IsVisible)) Report("player power extraction incomplete");
        }
        if (deck.Count != player.Deck.Cards.Count) Report("master deck extraction incomplete");
        if (combat != null && pcs != null)
        {
            if (screen.Combat == null) Report("combat overlay is missing its underlying combat");
            else
            {
                if (screen.Combat.Hand.Count != pcs.Hand.Cards.Count) Report("hand extraction incomplete");
                if (screen.Combat.DrawPile.Count != pcs.DrawPile.Cards.Count) Report("draw pile extraction incomplete");
                if (screen.Combat.DiscardPile.Count != pcs.DiscardPile.Cards.Count) Report("discard pile extraction incomplete");
                if (screen.Combat.ExhaustPile.Count != pcs.ExhaustPile.Cards.Count) Report("exhaust pile extraction incomplete");
                if (screen.Combat.Enemies.Count != combat.Enemies.Count()) Report("enemy extraction incomplete");
                foreach (var enemy in combat.Enemies)
                {
                    var dto = screen.Combat.Enemies.FirstOrDefault(e => e.CombatId == (int?)enemy.CombatId);
                    if (dto?.Powers.Count != enemy.Powers.Count(p => p.IsVisible)) Report("enemy power extraction incomplete");
                }
            }
        }
        var modifiers = run.Modifiers.Select(m => new { id = m.Id.Entry, name = GetLocText(m.Title), description = GetLocText(m.Description) }).ToArray();
        return new
        {
            schema_version = 1, run_id = RunIdentity(run), combat_id = combat != null ? IdentityOf(combat) : null,
            act_index = run.CurrentActIndex, act_floor = run.ActFloor, total_floor = run.TotalFloor,
            ascension = run.AscensionLevel, game_mode = run.GameMode.ToString(), modifiers,
            player = playerDto, potion_capacity = player.PotionSlots.Count, master_deck = deck,
            map, combat_history = history, play_pile = playPile, glossary,
            history_coverage = combat != null ? "Game combat history since this combat was loaded; earlier loaded-save events may be unavailable." : "No active combat.",
            extraction_errors = Issues.Distinct().ToArray()
        };
    }
}
