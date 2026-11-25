using System.IO;
using System.Net.Http;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;

namespace CsmNative;

// ------------------------------------------------------------------ À traiter : demandes de toutes les sessions
public sealed class AttentionWindow : Screen
{
    static readonly Regex Risk = new(@"\b(git\s+push|push\s+--force|rm\s+-rf?|rmdir|del\s+/|drop\s+(table|database)|delete\s+from|truncate|deploy|publish|npm\s+publish|wrangler\s+deploy|kubectl|terraform\s+apply|format\s+[a-z]:|shutdown|curl[^|]*\|\s*(ba)?sh)\b", RegexOptions.IgnoreCase);
    static readonly Regex Perm = new("permission|autoris|approv|proceed|Do you want", RegexOptions.IgnoreCase);
    readonly StackPanel list = new();
    readonly TextBlock count = new() { FontSize = 11, VerticalAlignment = VerticalAlignment.Center };
    readonly Border countBadge = new() { CornerRadius = new CornerRadius(999), Padding = new Thickness(7, 1, 7, 1), Margin = new Thickness(10, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
    // Maquette « Attention » : en-tête (titre, compteur, Fermer, explication), cartes par session avec boutons de réponse
    public AttentionWindow(MainWindow owner) : base(owner, "À traiter", 820, 760)
    {
        ShowInTaskbar = true;
        countBadge.Child = count; countBadge.SetResourceReference(Border.BackgroundProperty, "WarnSoft"); count.SetResourceReference(TextBlock.ForegroundProperty, "WarnFg");
        var title = Ui.H2("À traiter"); title.Margin = new Thickness(0); title.VerticalAlignment = VerticalAlignment.Center;
        var close = Ui.Btn("Fermer", (_, _) => SafeClose()); close.Height = 30; close.Margin = new Thickness(0);
        var top = new DockPanel(); DockPanel.SetDock(close, Dock.Right); top.Children.Add(close); top.Children.Add(Ui.Row(title, countBadge));
        var hint = new TextBlock { Text = "Les demandes de toutes tes sessions : autorise, réponds ou relis sans changer de session. Les réponses sont envoyées comme au clavier (1 = oui, 2 = oui pour ce projet, Échap = non).", FontSize = 12, LineHeight = 18, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 8, 0, 0) };
        hint.SetResourceReference(TextBlock.ForegroundProperty, "Muted");
        var hs = new StackPanel(); hs.Children.Add(top); hs.Children.Add(hint);
        list.Margin = new Thickness(0);
        var root = new DockPanel();
        var hb = Ui.Band(hs, 20, 16); DockPanel.SetDock(hb, Dock.Top); root.Children.Add(hb);
        root.Children.Add(new ScrollViewer { Content = new Border { Padding = new Thickness(20, 12, 20, 20), Child = list }, VerticalScrollBarVisibility = ScrollBarVisibility.Auto });
        Content = root;
        Render();
        main.items.CollectionChanged += (_, _) => Dispatcher.Invoke(Render);
        foreach (var it in main.items) it.PropertyChanged += (_, _) => Dispatcher.Invoke(Render);
    }
    void Render()
    {
        list.Children.Clear();
        var asks = main.items.Where(s => s.Status == "attention" && !s.Locked).Select(s => (s, ctx: main.Context(s.Id))).OrderByDescending(x => Risk.IsMatch(x.ctx)).ToList();
        count.Text = asks.Count.ToString(); countBadge.Visibility = asks.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
        if (asks.Count == 0) { list.Children.Add(Ui.Hint("Rien à traiter.")); return; }
        foreach (var (s, ctx) in asks)
        {
            var perm = Perm.IsMatch($"{s.Message} {ctx[Math.Max(0, ctx.Length - 400)..]}");
            var risky = perm && Risk.IsMatch(ctx);
            var p = new StackPanel();
            var show = Ui.Btn("Afficher la session", (_, _) => { main.ShowSession(s.Id); main.Activate(); }); show.Height = 26; show.Padding = new Thickness(10, 0, 10, 0); show.FontSize = 12; show.Margin = new Thickness(0); show.Background = Brushes.Transparent;
            var head = new DockPanel(); DockPanel.SetDock(show, Dock.Right); head.Children.Add(show);
            var who = new TextBlock { Text = s.Name, FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center };
            var grp = new TextBlock { Text = $"  {s.Group.Replace("/", " › ")}{(risky ? "  ⚠ action sensible" : "")}", FontSize = 12, VerticalAlignment = VerticalAlignment.Center }; grp.SetResourceReference(TextBlock.ForegroundProperty, risky ? "Warn" : "Muted");
            var dot = new System.Windows.Shapes.Ellipse { Width = 7, Height = 7, Margin = new Thickness(0, 0, 9, 0), VerticalAlignment = VerticalAlignment.Center }; dot.SetResourceReference(System.Windows.Shapes.Shape.FillProperty, "Warn");
            head.Children.Add(Ui.Row(dot, who, grp));
            p.Children.Add(head);
            if (s.Message.Length > 0) p.Children.Add(new TextBlock { Text = s.Message, FontWeight = FontWeights.Medium, Margin = new Thickness(0, 12, 0, 0), TextWrapping = TextWrapping.Wrap });
            var box = new TextBox { Text = ctx, IsReadOnly = true, TextWrapping = TextWrapping.Wrap, FontSize = 12, Margin = new Thickness(0, 10, 0, 0), MaxHeight = 220, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Padding = new Thickness(10, 8, 10, 8), MinHeight = 34 };
            box.SetResourceReference(Control.FontFamilyProperty, "MonoFont"); box.SetResourceReference(Control.BackgroundProperty, "Term"); box.SetResourceReference(Control.BorderBrushProperty, "Line");
            p.Children.Add(box);
            var answer = Ui.Box(); answer.ToolTip = "Répondre autre chose…"; answer.Height = 32; answer.Padding = new Thickness(10, 0, 10, 0);
            var row = new DockPanel { Margin = new Thickness(0, 10, 0, 0) };
            var btns = perm
                ? Ui.Row(Ui.Btn("1 · Oui", async (_, _) => await main.server.Input(s.Id, "1"), "Primary"), Ui.Btn("2 · Oui pour ce projet", async (_, _) => await main.server.Input(s.Id, "2")), Ui.Btn("Échap · Non", async (_, _) => await main.server.Input(s.Id, "\x1b"), "Danger"))
                : Ui.Row(Ui.Btn("Envoyer", async (_, _) => { if (answer.Text.Trim().Length > 0) { await main.server.Input(s.Id, answer.Text.Trim() + "\r"); answer.Clear(); } }, "Primary"));
            foreach (var bt in btns.Children.OfType<Button>()) bt.Margin = new Thickness(0, 0, 8, 0);
            btns.Margin = new Thickness(0, 0, 0, 0);
            DockPanel.SetDock(btns, Dock.Left); row.Children.Add(btns); row.Children.Add(Ui.Placeholder(answer, "Répondre autre chose…"));
            answer.KeyDown += async (_, e) => { if (e.Key == Key.Enter && answer.Text.Trim().Length > 0) { await main.server.Input(s.Id, answer.Text.Trim() + "\r"); answer.Clear(); } };
            p.Children.Add(row);
            var card = Card(p, 14); card.Margin = new Thickness(0, 0, 0, 10); card.CornerRadius = new CornerRadius(12); list.Children.Add(card);
        }
    }
}

// ------------------------------------------------------------------ Usage de Claude
public sealed class UsageWindow : Screen
{
    readonly StackPanel body = new();
    readonly ContentControl headHost = new();
    int days = 7; bool all;
    // Maquette « Usage » : bandeau (titre, sous-titre, périodes et machines en groupes segmentés, Fermer), cartes de quota, tableau « Par session »
    public UsageWindow(MainWindow owner) : base(owner, "Usage de Claude", 1100, 800)
    {
        var root = new DockPanel();
        var hb = Ui.Band(headHost, 20, 16); DockPanel.SetDock(hb, Dock.Top); root.Children.Add(hb);
        root.Children.Add(new ScrollViewer { Content = new Border { Padding = new Thickness(20, 16, 20, 20), Child = body }, VerticalScrollBarVisibility = ScrollBarVisibility.Auto });
        Content = root;
        Loaded += async (_, _) => await Load();
    }
    static Border SegGroup(params UIElement[] items)
    {
        var g = new Border { CornerRadius = new CornerRadius(8), BorderThickness = new Thickness(1), Padding = new Thickness(2), Child = Ui.Row(items), Margin = new Thickness(0, 0, 0, 0) };
        g.SetResourceReference(Border.BorderBrushProperty, "Line2"); g.SetResourceReference(Border.BackgroundProperty, "Term"); return g;
    }
    async Task Load()
    {
        body.Children.Clear();
        var period = SegGroup(new[] { (1, "Jour"), (7, "7 jours"), (30, "30 jours") }.Select(x => (UIElement)Chip(x.Item2, days == x.Item1, async () => { days = x.Item1; await Load(); })).ToArray());
        var scope = SegGroup(Chip("Cette machine", !all, async () => { all = false; await Load(); }), Chip("Toutes les machines", all, async () => { all = true; await Load(); }));
        scope.Margin = new Thickness(12, 0, 0, 0);
        var close = Ui.Btn("Fermer", (_, _) => SafeClose()); close.Height = 32; close.Margin = new Thickness(12, 0, 0, 0);
        var title = Ui.H2("Usage de Claude"); title.Margin = new Thickness(0); title.VerticalAlignment = VerticalAlignment.Center;
        var subT = new TextBlock { Text = all ? "Toutes les machines" : "Sur cette machine", FontSize = 12, Margin = new Thickness(10, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center }; subT.SetResourceReference(TextBlock.ForegroundProperty, "Muted");
        var right = Ui.Row(period, scope, close); right.VerticalAlignment = VerticalAlignment.Center;
        var head = new DockPanel(); DockPanel.SetDock(right, Dock.Right); head.Children.Add(right); head.Children.Add(Ui.Row(title, subT));
        headHost.Content = head;
        try
        {
            var q = await main.server.Api(HttpMethod.Get, "/api/quota");
            var u = await main.server.Api(HttpMethod.Get, $"/api/usage?days={days}{(all ? "&scope=all" : "")}");
            string Pct(JsonNode? n) => n?["pct"] is JsonValue v && v.TryGetValue<double>(out var d) ? $"{Math.Round(d)} %" : "—";
            var cards = new Grid(); for (var ci = 0; ci < 5; ci++) cards.ColumnDefinitions.Add(new ColumnDefinition { Width = ci % 2 == 1 ? new GridLength(16) : new GridLength(1, GridUnitType.Star) });
            void Put(UIElement e, int col) { var c = UsageCard(e); Grid.SetColumn(c, col); cards.Children.Add(c); }
            Put(Stat("Quota 5 h : prévision", Pct(q?["five"]), Forecast(q?["forecast"]), "Work"), 0);
            Put(Stat("Quota 7 jours : prévision", Pct(q?["seven"]), Forecast(q?["forecast7"]), "Ok"), 2);
            Put(Stat($"Coût sur la période (équivalent API)", Money(u?["period"]?["cost"]), (string?)u?["note"] ?? "", null), 4);
            body.Children.Add(cards);
            var tbl = new StackPanel();
            tbl.Children.Add(new TextBlock { Text = "Par session", FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 0, 0, 14) });
            var grid = new Grid(); foreach (var w in new[] { 3.0, 2, 1.2, 1.2, 1.2 }) grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(w, GridUnitType.Star) });
            var rows = (all ? u?["rows"] : u?["top"]) as JsonArray ?? [];
            void Cell(string t, int r, int c, bool head = false)
            {
                var tb = new TextBlock { Text = t, Margin = new Thickness(0, 7, 8, 7), FontSize = head ? 12 : 13, TextAlignment = c >= 3 ? TextAlignment.Right : TextAlignment.Left, TextTrimming = TextTrimming.CharacterEllipsis };
                tb.SetResourceReference(TextBlock.ForegroundProperty, head ? "Muted" : "Fg"); Grid.SetRow(tb, r); Grid.SetColumn(tb, c); grid.Children.Add(tb);
            }
            grid.RowDefinitions.Add(new RowDefinition());
            var h = new[] { "Session", "Machine", "Travail", "Tokens", "Équivalent API" }; for (var c = 0; c < h.Length; c++) Cell(h[c], 0, c, true);
            var i = 1;
            foreach (var r in rows.OfType<JsonObject>())
            {
                grid.RowDefinitions.Add(new RowDefinition());
                var tokens = r["tokens"] is JsonValue tv && tv.TryGetValue<double>(out var tk) ? tk : new[] { "in", "out", "cr", "cw" }.Sum(k => r[k] is JsonValue x && x.TryGetValue<double>(out var y) ? y : 0);
                Cell((string?)r["name"] ?? "", i, 0); Cell((string?)r["machine"] ?? "cette machine", i, 1); Cell(Dur(r["work"]), i, 2);
                Cell(tokens >= 1e6 ? $"{tokens / 1e6:0.0} M" : $"{tokens / 1e3:0} k", i, 3); Cell(Money(r["cost"]), i, 4); i++;
            }
            tbl.Children.Add(grid);
            var tc = UsageCard(tbl); tc.Margin = new Thickness(0, 16, 0, 0); tc.Padding = new Thickness(14, 14, 14, 10); body.Children.Add(tc);
        }
        catch (Exception e) { body.Children.Add(Ui.Hint(e.Message)); }
    }
    static Border UsageCard(UIElement c)
    {
        var b = new Border { CornerRadius = new CornerRadius(12), BorderThickness = new Thickness(1), Padding = new Thickness(14), Child = c };
        b.SetResourceReference(Border.BackgroundProperty, "Bar"); b.SetResourceReference(Border.BorderBrushProperty, "Line"); return b;
    }
    static ToggleButtonEx Chip(string t, bool on, Func<Task> click) { var c = new ToggleButtonEx { Content = t, IsChecked = on, Style = Ui.S("Seg"), Margin = new Thickness(0) }; c.Click += async (_, _) => await click(); return c; }
    static StackPanel Stat(string label, string big, string sub, string? subBrush)
    {
        var p = new StackPanel();
        var l = new TextBlock { Text = label, FontSize = 12 }; l.SetResourceReference(TextBlock.ForegroundProperty, "Muted"); p.Children.Add(l);
        var line = new TextBlock { Margin = new Thickness(0, 6, 0, 0), TextWrapping = TextWrapping.Wrap };
        line.Inlines.Add(new System.Windows.Documents.Run(big) { FontSize = 28, FontWeight = FontWeights.Bold });
        if (subBrush != null && sub.Length > 0) { var r = new System.Windows.Documents.Run("  " + sub) { FontSize = 12 }; r.SetResourceReference(System.Windows.Documents.TextElement.ForegroundProperty, subBrush); line.Inlines.Add(r); }
        p.Children.Add(line);
        if (subBrush == null) p.Children.Add(Ui.Hint(sub));
        return p;
    }
    static string Forecast(JsonNode? f) => f is JsonObject o && o["pct"] is JsonValue v && v.TryGetValue<double>(out var d) ? $"→ {Math.Round(d)} % à la réinitialisation" : "";
    static string Money(JsonNode? n) => n is JsonValue v && v.TryGetValue<double>(out var d) ? $"{d:0.##} $" : "—";
    static string Dur(JsonNode? n) { if (n is not JsonValue v || !v.TryGetValue<double>(out var ms)) return "—"; var m = (int)(ms / 60000); return $"{m / 60} h {m % 60:00}"; }
}
public sealed class ToggleButtonEx : System.Windows.Controls.Primitives.ToggleButton { }

// ------------------------------------------------------------------ Skills disponibles
public sealed class SkillsWindow : Screen
{
    public SkillsWindow(MainWindow owner) : base(owner, "Skills disponibles", 760, 720)
    {
        var list = new StackPanel { Margin = new Thickness(0) };
        var title = new TextBlock { Text = "Skills disponibles", FontSize = 17, FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center };
        var close = Ui.CloseBtn(this); var hd = new DockPanel(); DockPanel.SetDock(close, Dock.Right); hd.Children.Add(close); hd.Children.Add(title);
        var hint = new TextBlock { Text = "Tous les skills que Claude Code peut lancer dans CSM : les tiens, ceux des plugins activés et ceux du dossier de la session active. Lancer écrit /nom dans la session active : ajoute ta demande puis Entrée.", FontSize = 12, LineHeight = 18, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 12) };
        hint.SetResourceReference(TextBlock.ForegroundProperty, "Muted");
        var body = new StackPanel(); body.Children.Add(hint); body.Children.Add(list);
        var root = new DockPanel(); var hb = Ui.Band(hd, 18, 14); DockPanel.SetDock(hb, Dock.Top); root.Children.Add(hb);
        root.Children.Add(new ScrollViewer { Content = new Border { Padding = new Thickness(18, 14, 18, 18), Child = body }, VerticalScrollBarVisibility = ScrollBarVisibility.Auto });
        Content = root;
        Loaded += async (_, _) =>
        {
            try
            {
                var r = await main.server.Api(HttpMethod.Get, $"/api/skills{(main.Current is { } c ? "?session=" + c.Id : "")}");
                var arr = r as JsonArray ?? r?["skills"] as JsonArray ?? [];
                foreach (var s in arr.OfType<JsonObject>())
                {
                    var name = (string?)s["name"] ?? "";
                    var p = new StackPanel();
                    var nm = new TextBlock { Text = "/" + name, FontWeight = FontWeights.Bold, VerticalAlignment = VerticalAlignment.Center }; nm.SetResourceReference(TextBlock.FontFamilyProperty, "MonoFont");
                    var src = new TextBlock { Text = "  " + ((string?)s["source"] ?? (string?)s["plugin"] ?? ""), FontSize = 11, VerticalAlignment = VerticalAlignment.Center }; src.SetResourceReference(TextBlock.ForegroundProperty, "Muted");
                    p.Children.Add(Ui.Row(nm, src));
                    var ds = new TextBlock { Text = (string?)s["description"] ?? "", FontSize = 12, TextTrimming = TextTrimming.CharacterEllipsis, Margin = new Thickness(0, 3, 0, 0) }; ds.SetResourceReference(TextBlock.ForegroundProperty, "Dim");
                    p.Children.Add(ds);
                    var run = Ui.Btn("Lancer", async (_, _) => { if (main.Current is { } cur) { await main.server.Input(cur.Id, "/" + name + " "); Close(); } }); run.Height = 28; run.Padding = new Thickness(12, 0, 12, 0);
                    var row = new DockPanel(); DockPanel.SetDock(run, Dock.Right); run.VerticalAlignment = VerticalAlignment.Center; row.Children.Add(run); p.VerticalAlignment = VerticalAlignment.Center; row.Children.Add(p);
                    var card = Card(row, 10); card.Margin = new Thickness(0, 0, 0, 4); card.CornerRadius = new CornerRadius(8); card.Padding = new Thickness(12, 9, 12, 9);
                    list.Children.Add(card);
                }
                if (arr.Count == 0) list.Children.Add(Ui.Hint("Aucun skill."));
            }
            catch (Exception e) { list.Children.Add(Ui.Hint(e.Message)); }
        };
    }
}

// ------------------------------------------------------------------ Bienvenue (premier lancement)
public sealed class WelcomeWindow : Screen
{
    public WelcomeWindow(MainWindow owner) : base(owner, "Bienvenue", 686, 520)
    {
        SizeToContent = SizeToContent.Height; ResizeMode = ResizeMode.NoResize;
        var folder = Ui.Box(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Projects"));
        folder.Height = 36; folder.FontSize = 12; folder.SetResourceReference(Control.FontFamilyProperty, "MonoFont"); folder.Padding = new Thickness(10, 0, 10, 0);
        var browse = Ui.Btn("Parcourir…", (_, _) => { var d = new Microsoft.Win32.OpenFolderDialog(); if (d.ShowDialog(this) == true) folder.Text = d.FolderName; }); browse.Height = 36; browse.Margin = new Thickness(8, 0, 0, 0); browse.Padding = new Thickness(14, 0, 14, 0);
        var row = new DockPanel(); DockPanel.SetDock(browse, Dock.Right); row.Children.Add(browse); row.Children.Add(folder);
        async Task Done() { await main.Try(() => main.server.Api(HttpMethod.Put, "/api/settings", new { onboarded = true })); }
        var later = Ui.Btn("Plus tard", async (_, _) => { await Done(); Close(); }); later.Height = 38; later.Padding = new Thickness(16, 0, 16, 0); later.Background = Brushes.Transparent;
        var go = Ui.Btn("Créer ma première session", async (_, _) =>
        {
            await Done();
            if (Directory.Exists(folder.Text.Trim())) await main.Try(async () => { var s = await main.server.Api(HttpMethod.Post, "/api/sessions", new { cwd = folder.Text.Trim() }); if ((string?)s?["id"] is { } id) main.ShowSession(id); });
            Close();
        }, "Primary"); go.Height = 38; go.Padding = new Thickness(18, 0, 18, 0);
        var logo = new Border { Width = 44, Height = 44, CornerRadius = new CornerRadius(11), HorizontalAlignment = HorizontalAlignment.Left, Child = new TextBlock { Text = "\uE756", FontFamily = PaletteWindow.Icons, FontSize = 20, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center } };
        logo.SetResourceReference(Border.BackgroundProperty, "Accent"); ((TextBlock)logo.Child).SetResourceReference(TextBlock.ForegroundProperty, "OnAccent");
        var title = new TextBlock { Text = "Bienvenue dans Claude Sessions", FontSize = 24, FontWeight = FontWeights.Bold, Margin = new Thickness(0, 16, 0, 0) };
        UIElement Kbd(string k, string label)
        {
            var kb = new Border { BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(4), Padding = new Thickness(6, 2, 6, 2), Child = new TextBlock { Text = k, FontSize = 12 } };
            kb.SetResourceReference(Border.BorderBrushProperty, "Ring"); ((TextBlock)kb.Child).SetResourceReference(TextBlock.FontFamilyProperty, "MonoFont");
            var t = new TextBlock { Text = " " + label, VerticalAlignment = VerticalAlignment.Center }; t.SetResourceReference(TextBlock.ForegroundProperty, "Fg2");
            return Ui.Row(kb, t);
        }
        var k1 = Kbd("Ctrl + Alt + N", "nouvelle session"); var k2 = Kbd("Ctrl + K", "palette de commandes");
        var kr = Ui.Row(k1, new Border { Width = 14 }, k2); kr.Margin = new Thickness(0, 16, 0, 0);
        var list = new StackPanel { Margin = new Thickness(0, 16, 0, 0) };
        foreach (var t in new[] { "Fermer la fenêtre ne coupe rien : les sessions continuent et reviennent après un redémarrage.", "Choisis 2 ou 4 panneaux (en haut à droite) pour suivre plusieurs sessions à la fois.", "Coche « worktree git » pour faire travailler plusieurs Claude sur le même dépôt sans conflit." })
        {
            var g = new DockPanel { Margin = new Thickness(0, 0, 0, 8) };
            var dot = new TextBlock { Text = "•", Width = 18, Margin = new Thickness(0), VerticalAlignment = VerticalAlignment.Top, TextAlignment = TextAlignment.Left }; DockPanel.SetDock(dot, Dock.Left); dot.SetResourceReference(TextBlock.ForegroundProperty, "Dim");
            var tx = new TextBlock { Text = t, TextWrapping = TextWrapping.Wrap, LineHeight = 20 }; tx.SetResourceReference(TextBlock.ForegroundProperty, "Dim");
            g.Children.Add(dot); g.Children.Add(tx); list.Children.Add(g);
        }
        var lbl = Ui.Label("Premier dossier de travail", 6); lbl.Margin = new Thickness(0, 8, 0, 6);
        var foot = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 20, 0, 0) };
        later.Margin = new Thickness(0, 0, 8, 0); go.Margin = new Thickness(0); foot.Children.Add(later); foot.Children.Add(go);
        var body = new StackPanel { Margin = new Thickness(32, 30, 32, 30) };
        foreach (var e in new UIElement[] { logo, title, kr, list, lbl, row, foot }) body.Children.Add(e);
        Content = body;
    }
}

// ------------------------------------------------------------------ Rechercher dans les sessions (texte des terminaux)
public sealed class SearchWindow : Screen
{
    public SearchWindow(MainWindow owner) : base(owner, "Rechercher dans les sessions", 760, 640)
    {
        var q = Ui.Box(); var list = new StackPanel();
        void Run()
        {
            list.Children.Clear();
            var t = q.Text.Trim(); if (t.Length < 2) return;
            foreach (var s in main.items)
            {
                var lines = main.tails.GetValueOrDefault(s.Id, "").Split('\n').Where(l => l.Contains(t, StringComparison.OrdinalIgnoreCase)).ToList();
                if (lines.Count == 0) continue;
                var p = new StackPanel();
                p.Children.Add(Ui.Row(new TextBlock { Text = s.Name, FontWeight = FontWeights.SemiBold }, new TextBlock { Text = $"  {lines.Count} résultat{(lines.Count > 1 ? "s" : "")}", Foreground = Ui.R("Muted"), FontSize = 12, VerticalAlignment = VerticalAlignment.Center }));
                foreach (var l in lines.TakeLast(3)) p.Children.Add(new TextBlock { Text = l.Trim(), FontFamily = (FontFamily)Application.Current.FindResource("MonoFont"), FontSize = 12, Foreground = Ui.R("Fg2"), TextTrimming = TextTrimming.CharacterEllipsis });
                var b = Card(p); b.Cursor = Cursors.Hand; b.CornerRadius = new CornerRadius(8); b.Padding = new Thickness(12, 10, 12, 10); b.Margin = new Thickness(0, 0, 0, 6); b.MouseLeftButtonUp += (_, _) => { main.ShowSession(s.Id); Close(); };
                list.Children.Add(b);
            }
            if (list.Children.Count == 0) list.Children.Add(Ui.Hint("Aucun résultat."));
        }
        q.TextChanged += (_, _) => Run();
        var title = new TextBlock { Text = "Rechercher dans les sessions", FontSize = 16, FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center };
        var close = Ui.CloseBtn(this); close.Width = 28; close.Height = 28; var hd = new DockPanel(); DockPanel.SetDock(close, Dock.Right); hd.Children.Add(close); hd.Children.Add(title);
        q.Height = 34; q.Padding = new Thickness(10, 0, 10, 0); q.SetResourceReference(Control.FontFamilyProperty, "MonoFont");
        var root = new DockPanel(); var hb = Ui.Band(hd, 18, 14); DockPanel.SetDock(hb, Dock.Top); root.Children.Add(hb);
        var qb = new Border { Padding = new Thickness(18, 12, 18, 12), Child = q }; DockPanel.SetDock(qb, Dock.Top); root.Children.Add(qb);
        root.Children.Add(new ScrollViewer { Content = new Border { Padding = new Thickness(12, 0, 12, 12), Child = list }, VerticalScrollBarVisibility = ScrollBarVisibility.Auto });
        Content = root;
        Loaded += (_, _) => q.Focus();
    }
}

// ------------------------------------------------------------------ session verrouillée : écran à la place du terminal
public sealed class LockView : Border
{
    public readonly string Id;
    readonly TextBlock err = Ui.Hint("");
    public LockView(MainWindow main, SessionItem s)
    {
        Id = s.Id; Background = Ui.R("Term");
        var pw = new PasswordBox { Height = 36 }; pw.SetResourceReference(Control.BackgroundProperty, "Panel");
        var go = Ui.Btn("Déverrouiller", async (_, _) => await main.Unlock(s.Id, pw.Password), "Primary"); go.Height = 36; go.Padding = new Thickness(14, 0, 14, 0); go.Margin = new Thickness(8, 0, 0, 0);
        pw.KeyDown += async (_, e) => { if (e.Key == Key.Enter) await main.Unlock(s.Id, pw.Password); };
        err.SetResourceReference(TextBlock.ForegroundProperty, "Warn");
        var p = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        var circle = new Border { Width = 56, Height = 56, CornerRadius = new CornerRadius(28), HorizontalAlignment = HorizontalAlignment.Center, Child = new TextBlock { Text = "\uE72E", FontFamily = PaletteWindow.Icons, FontSize = 22, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center } };
        circle.SetResourceReference(Border.BackgroundProperty, "Panel2"); ((TextBlock)circle.Child).SetResourceReference(TextBlock.ForegroundProperty, "Fg2");
        p.Children.Add(circle);
        p.Children.Add(new TextBlock { Text = "Session verrouillée", FontSize = 18, FontWeight = FontWeights.SemiBold, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 14, 0, 0) });
        var hint = (string?)s.Data["lockHint"];
        var sub = new TextBlock { Text = "Elle continue de tourner." + (string.IsNullOrEmpty(hint) ? "" : $" Indice : {hint}"), FontSize = 12, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 14, 0, 14) }; sub.SetResourceReference(TextBlock.ForegroundProperty, "Muted");
        p.Children.Add(sub);
        var row = new DockPanel { Width = 320 }; DockPanel.SetDock(go, Dock.Right); row.Children.Add(go); row.Children.Add(Ui.Placeholder2(pw, "Mot de passe")); p.Children.Add(row);
        err.HorizontalAlignment = HorizontalAlignment.Center; p.Children.Add(err);
        Child = p; BorderThickness = new Thickness(1); CornerRadius = new CornerRadius(12); SetResourceReference(BorderBrushProperty, "Hover");
        Loaded += (_, _) => pw.Focus();
    }
    public void Error(string e) => err.Text = e;
}

// ------------------------------------------------------------------ affichage d'une session d'extension (format structuré, en texte)
public sealed class ExtensionView : Border
{
    public readonly string Id;
    readonly MainWindow main;
    readonly StackPanel root = new() { Margin = new Thickness(20) };
    readonly Dictionary<string, string> drafts = [];
    int selItem;
    public ExtensionView(MainWindow m, SessionItem s)
    {
        main = m; Id = s.Id; Background = Ui.R("Term");
        Child = new ScrollViewer { Content = root, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        Loaded += async (_, _) => await Load();
    }
    Task Act(object body) => main.Try(() => main.server.Api(HttpMethod.Post, $"/api/sessions/{Id}/view-action", body));

    public async Task Load()
    {
        JsonNode? r;
        try { r = await main.server.Api(HttpMethod.Get, $"/api/sessions/{Id}/view"); } catch (Exception e) { root.Children.Clear(); root.Children.Add(Ui.Hint(e.Message)); return; }
        root.Children.Clear();
        var type = r?["type"] as JsonObject; var v = r?["view"] as JsonObject;
        // actions du type de session (barre du haut) et champ de saisie direct
        var bar = new WrapPanel { Margin = new Thickness(0, 0, 0, 12) };
        foreach (var a in (type?["actions"] as JsonArray ?? []).OfType<JsonObject>())
        {
            var id = (string?)a["id"];
            var b = Ui.Btn((string?)a["label"] ?? id ?? "", async (_, _) => { if ((string?)a["confirm"] is { Length: > 0 } c && MessageBox.Show(c, "Action", MessageBoxButton.YesNo) != MessageBoxResult.Yes) return; await Act(new { action = id }); });
            b.Margin = new Thickness(0, 0, 6, 6); bar.Children.Add(b);
        }
        if (type?["input"] is JsonObject inp)
        {
            var box = Ui.Box(); box.Width = 260; box.ToolTip = (string?)inp["placeholder"] ?? (string?)inp["label"];
            bar.Children.Add(box); bar.Children.Add(Ui.Btn((string?)inp["button"] ?? "Envoyer", async (_, _) => { if (box.Text.Trim().Length > 0) { await Act(new { input = box.Text }); box.Clear(); } }, "Primary"));
        }
        if (bar.Children.Count > 0) root.Children.Add(bar);
        if (v == null) { root.Children.Add(Ui.Hint("L'affichage n'a pas encore été écrit par Claude.")); return; }
        Header(v);
        if (v["items"] is JsonArray its && its.Count > 0)
        {
            selItem = Math.Min(selItem, its.Count - 1);
            var grid = new Grid(); grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(280) }); grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(16) }); grid.ColumnDefinitions.Add(new ColumnDefinition());
            var left = new StackPanel();
            for (var i = 0; i < its.Count; i++)
            {
                var idx = i; var it = its[i] as JsonObject;
                var b = Ui.Btn($"{(string?)it?["title"]}  ·  {(string?)it?["state"]}", async (_, _) => { selItem = idx; await Load(); });
                b.HorizontalContentAlignment = HorizontalAlignment.Left; b.Margin = new Thickness(0, 0, 0, 4); if (i == selItem) { b.Background = Ui.R("Sel"); b.BorderBrush = Ui.R("Accent"); }
                left.Children.Add(b);
            }
            var right = new StackPanel(); var cur = its[selItem] as JsonObject;
            if (cur != null) { Header(cur, right, selItem); Sections(cur["sections"] as JsonArray, right, selItem); }
            Grid.SetColumn(right, 2); grid.Children.Add(left); grid.Children.Add(right); root.Children.Add(grid);
        }
        Sections(v["sections"] as JsonArray, root, null);
    }

    void Header(JsonObject v, Panel? into = null, int? item = null)
    {
        into ??= root;
        if ((string?)v["title"] is { Length: > 0 } t) into.Children.Add(new TextBlock { Text = t, FontSize = 18, FontWeight = FontWeights.SemiBold });
        if ((string?)v["subtitle"] is { Length: > 0 } st) into.Children.Add(Ui.Hint(st));
        if (v["verdict"] is JsonObject vd)
        {
            var lvl = (string?)vd["level"];
            var col = lvl == "ok" ? Ui.R("Ok") : lvl == "warn" ? Ui.R("Warn") : Ui.R("Accent");
            var p = new StackPanel(); p.Children.Add(new TextBlock { Text = (lvl == "ok" ? "✓ " : lvl == "warn" ? "⚠ " : "ℹ ") + (string?)vd["text"], Foreground = col, FontWeight = FontWeights.SemiBold, TextWrapping = TextWrapping.Wrap });
            if ((string?)vd["sub"] is { Length: > 0 } sub) p.Children.Add(Ui.Hint(sub));
            into.Children.Add(new Border { BorderBrush = col, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(10), Padding = new Thickness(12), Margin = new Thickness(0, 10, 0, 0), Child = p });
        }
        if (v["steps"] is JsonObject steps && steps["items"] is JsonArray sti)
        {
            var cur = (int?)steps["current"] ?? 0;
            into.Children.Add(new TextBlock { Text = string.Join("   ›   ", sti.Select((s, i) => (i < cur ? "✓ " : i == cur ? "● " : "○ ") + (string?)s)), Foreground = Ui.R("Fg2"), Margin = new Thickness(0, 10, 0, 0), TextWrapping = TextWrapping.Wrap });
        }
        if (v["meta"] is JsonArray meta) into.Children.Add(new TextBlock { Text = string.Join("   ·   ", meta.OfType<JsonObject>().Select(m => $"{m["label"]} : {m["value"]}")), Foreground = Ui.R("Muted"), Margin = new Thickness(0, 8, 0, 0), TextWrapping = TextWrapping.Wrap });
        if (v["next"] is JsonObject nx)
        {
            var b = Ui.Btn((string?)nx["button"] ?? "Continuer", async (_, _) => await Act(item == null ? new { next = true } : (object)new { next = true, item }), "Primary");
            var row = new DockPanel { Margin = new Thickness(0, 10, 0, 0) }; DockPanel.SetDock(b, Dock.Right); row.Children.Add(b); row.Children.Add(new TextBlock { Text = "Prochaine étape : " + (string?)nx["label"], VerticalAlignment = VerticalAlignment.Center, TextWrapping = TextWrapping.Wrap });
            into.Children.Add(row);
        }
    }

    void Sections(JsonArray? secs, Panel into, int? item)
    {
        if (secs == null) return;
        for (var si = 0; si < secs.Count; si++)
        {
            if (secs[si] is not JsonObject s) continue;
            var kind = (string?)s["kind"]; var title = (string?)s["title"] ?? "";
            var content = new StackPanel();
            switch (kind)
            {
                case "text": content.Children.Add(new TextBlock { Text = (string?)s["text"], TextWrapping = TextWrapping.Wrap, Foreground = Ui.R("Fg2") }); break;
                case "alert":
                    var lvl = (string?)s["level"];
                    content.Children.Add(new TextBlock { Text = (lvl == "warn" || lvl == "error" ? "⚠ " : "ℹ ") + (string?)s["text"], TextWrapping = TextWrapping.Wrap, Foreground = lvl == "warn" || lvl == "error" ? Ui.R("Warn") : Ui.R("Fg2") }); break;
                case "list": foreach (var x in s["items"] as JsonArray ?? []) content.Children.Add(new TextBlock { Text = "•  " + x, TextWrapping = TextWrapping.Wrap, Foreground = Ui.R("Fg2") }); break;
                case "kv": foreach (var x in (s["items"] as JsonArray ?? []).OfType<JsonObject>()) content.Children.Add(Ui.Row(new TextBlock { Text = (string?)x["label"], Width = 180, Foreground = Ui.R("Muted") }, new TextBlock { Text = (string?)x["value"], TextWrapping = TextWrapping.Wrap })); break;
                case "timeline": foreach (var x in (s["items"] as JsonArray ?? []).OfType<JsonObject>()) content.Children.Add(Ui.Row(new TextBlock { Text = (string?)x["at"], Width = 110, Foreground = Ui.R("Muted"), FontSize = 12 }, new TextBlock { Text = (string?)x["text"], TextWrapping = TextWrapping.Wrap })); break;
                case "checklist": foreach (var x in (s["items"] as JsonArray ?? []).OfType<JsonObject>()) content.Children.Add(new TextBlock { Text = ((bool?)x["done"] == true ? "☑  " : "☐  ") + (string?)x["label"] + ((string?)x["hint"] is { Length: > 0 } h ? $"  — {h}" : ""), TextWrapping = TextWrapping.Wrap }); break;
                case "table":
                    var g = new Grid(); var cols = s["columns"] as JsonArray ?? []; var rows = s["rows"] as JsonArray ?? [];
                    for (var c = 0; c < cols.Count; c++) g.ColumnDefinitions.Add(new ColumnDefinition());
                    g.RowDefinitions.Add(new RowDefinition());
                    for (var c = 0; c < cols.Count; c++) { var tb = new TextBlock { Text = (string?)cols[c], Foreground = Ui.R("Muted"), FontSize = 12, Margin = new Thickness(0, 0, 10, 4) }; Grid.SetColumn(tb, c); g.Children.Add(tb); }
                    for (var r = 0; r < rows.Count; r++)
                    {
                        g.RowDefinitions.Add(new RowDefinition());
                        var cells = rows[r] as JsonArray ?? [];
                        for (var c = 0; c < Math.Min(cells.Count, cols.Count); c++) { var tb = new TextBlock { Text = cells[c]?.ToString(), TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 2, 10, 2) }; Grid.SetRow(tb, r + 1); Grid.SetColumn(tb, c); g.Children.Add(tb); }
                    }
                    content.Children.Add(g); break;
                case "draft":
                    var key = $"{item}:{si}";
                    var box = Ui.Box(drafts.GetValueOrDefault(key, (string?)s["text"] ?? ""), true, 6);
                    box.TextChanged += (_, _) => drafts[key] = box.Text;
                    content.Children.Add(box);
                    var acts = new WrapPanel { Margin = new Thickness(0, 6, 0, 0) };
                    var secIdx = si;
                    var actions = s["actions"] as JsonArray ?? [];
                    for (var ai = 0; ai < actions.Count; ai++)
                    {
                        var aIdx = ai;
                        acts.Children.Add(Ui.Btn((string?)actions[ai]?["label"] ?? "Envoyer", async (_, _) => await Act(item == null ? new { section = secIdx, index = aIdx, draft = box.Text } : (object)new { section = secIdx, index = aIdx, draft = box.Text, item }), "Primary"));
                    }
                    content.Children.Add(acts); break;
                default: continue; // kind inconnu : ignoré
            }
            var folded = (bool?)s["fold"] == true;
            if (title.Length > 0)
            {
                var exp = new Expander { Header = title, IsExpanded = !folded, Content = content, Margin = new Thickness(0, 12, 0, 0), Foreground = Ui.R("Fg") };
                into.Children.Add(exp);
            }
            else { content.Margin = new Thickness(0, 12, 0, 0); into.Children.Add(content); }
        }
    }
}
