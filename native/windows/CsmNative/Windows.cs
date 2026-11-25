using System.Net.Http;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;

namespace CsmNative;

// Base des fenêtres d'écran : sombre, centrée sur la fenêtre principale, Échap ferme.
public class Screen : Window
{
    protected readonly MainWindow main;
    protected Screen(MainWindow owner, string title, double w, double h)
    {
        main = owner; Owner = owner; Title = title; Width = w; Height = h; WindowStartupLocation = WindowStartupLocation.CenterOwner;
        Background = Ui.R("Panel"); Foreground = Ui.R("Fg"); FontFamily = (FontFamily)Application.Current.FindResource("UiFont"); FontSize = 13; ShowInTaskbar = false;
        PreviewKeyDown += (_, e) => { if (e.Key == Key.Escape) { e.Handled = true; SafeClose(); } };
    }
    // Close() pendant une fermeture déjà en cours lève une exception dans WPF (ex. Échap puis perte du focus)
    protected bool closing;
    protected override void OnClosing(System.ComponentModel.CancelEventArgs e) { closing = true; base.OnClosing(e); if (e.Cancel) closing = false; }
    public void SafeClose() { if (!closing) Close(); }
    protected static Border Card(UIElement c, double pad = 12) => new() { Background = Ui.R("Bar"), BorderBrush = Ui.R("Line"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(10), Padding = new Thickness(pad), Margin = new Thickness(0, 4, 0, 0), Child = c };
    protected static ListBox DarkList() => new() { Background = Brushes.Transparent, BorderThickness = new Thickness(0), Foreground = Ui.R("Fg"), HorizontalContentAlignment = HorizontalAlignment.Stretch };
}

// ------------------------------------------------------------------ palette (Ctrl+K) : sessions, actions, prompts
// Maquette « Palette » : carte arrondie, recherche avec loupe et Échap, sections SESSIONS / ACTIONS / GROUPES /
// PROMPTS, pastille d'état ou icône, nom en gras + groupe en gris, état ou raccourci (police fixe) à droite.
public sealed class PaletteWindow : Screen
{
    readonly TextBox q = new() { BorderThickness = new Thickness(0), Background = Brushes.Transparent, FontSize = 15, VerticalContentAlignment = VerticalAlignment.Center, Padding = new Thickness(0), MinHeight = 0, Height = 28 };
    readonly StackPanel rows = new();
    readonly ScrollViewer scroll;
    sealed record Entry(string Group, string Icon, string Label, string Sub, string Hint, bool Kbd, Brush? Dot, Func<Task> Run);
    readonly List<Entry> all = [];
    List<Entry> shown = [];
    readonly List<Border> rowEls = [];
    int sel;
    static readonly Dictionary<string, string> Sections = new() { ["s"] = "SESSIONS", [">"] = "ACTIONS", ["#"] = "GROUPES", ["@"] = "PROMPTS" };
    internal static readonly FontFamily Icons = new("Segoe Fluent Icons, Segoe MDL2 Assets");

    public PaletteWindow(MainWindow owner) : base(owner, "Palette", 680, 560)
    {
        WindowStyle = WindowStyle.None; ResizeMode = ResizeMode.NoResize; AllowsTransparency = true; Background = Brushes.Transparent;
        SizeToContent = SizeToContent.Height; WindowStartupLocation = WindowStartupLocation.Manual;
        q.SetResourceReference(ForegroundProperty, "Fg"); q.CaretBrush = Ui.R("Fg");
        var esc = new Border { BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(4), Padding = new Thickness(6, 1, 6, 1), VerticalAlignment = VerticalAlignment.Center, Child = new TextBlock { Text = "Échap", FontSize = 11 } };
        esc.SetResourceReference(Border.BorderBrushProperty, "Ring"); ((TextBlock)esc.Child).SetResourceReference(TextBlock.ForegroundProperty, "Muted");
        esc.MouseLeftButtonUp += (_, _) => SafeClose(); esc.Cursor = Cursors.Hand;
        var glass = new TextBlock { Text = "", FontFamily = Icons, FontSize = 14, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 12, 0) };
        glass.SetResourceReference(TextBlock.ForegroundProperty, "Muted");
        var top = new DockPanel { Margin = new Thickness(16, 12, 16, 12) };
        DockPanel.SetDock(glass, Dock.Left); DockPanel.SetDock(esc, Dock.Right); top.Children.Add(glass); top.Children.Add(esc); top.Children.Add(q);
        scroll = new ScrollViewer { Content = rows, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, MaxHeight = 420, Padding = new Thickness(6, 4, 6, 6) };
        var foot = new TextBlock { Margin = new Thickness(16, 10, 16, 10), FontSize = 12 };
        foot.SetResourceReference(TextBlock.ForegroundProperty, "Muted");
        foot.Inlines.Add(new System.Windows.Documents.Run("↑↓ choisir      Entrée ouvrir      > commandes · # groupes · @ prompts"));
        var body = new DockPanel();
        DockPanel.SetDock(top, Dock.Top); body.Children.Add(top);
        body.Children.Add(Sep(Dock.Top));
        DockPanel.SetDock(foot, Dock.Bottom); body.Children.Add(foot);
        body.Children.Add(Sep(Dock.Bottom));
        body.Children.Add(scroll);
        var card = new Border { CornerRadius = new CornerRadius(12), BorderThickness = new Thickness(1), Child = body, Margin = new Thickness(18),
            Effect = new System.Windows.Media.Effects.DropShadowEffect { BlurRadius = 30, ShadowDepth = 8, Opacity = 0.45, Color = Colors.Black } };
        card.SetResourceReference(Border.BackgroundProperty, "Panel"); card.SetResourceReference(Border.BorderBrushProperty, "Line2");
        Content = card;
        Build();
        q.TextChanged += (_, _) => Filter();
        q.PreviewKeyDown += async (_, e) =>
        {
            if (e.Key == Key.Down) { Select(sel + 1); e.Handled = true; }
            else if (e.Key == Key.Up) { Select(sel - 1); e.Handled = true; }
            else if (e.Key == Key.Enter) { e.Handled = true; await RunSel(); }
        };
        Deactivated += (_, _) => { if (IsVisible) SafeClose(); };
        Loaded += async (_, _) =>
        {
            // en haut de la fenêtre principale, centrée (comme la palette de l'app web)
            var o = main.WindowState == WindowState.Maximized ? new Point(0, 0) : new Point(main.Left, main.Top);
            Left = o.X + (main.ActualWidth - ActualWidth) / 2; Top = o.Y + 70;
            q.Focus(); await LoadPrompts(); Filter();
        };
    }
    static Border Sep(Dock d) { var b = new Border { Height = 1 }; b.SetResourceReference(Border.BackgroundProperty, "Line"); DockPanel.SetDock(b, d); return b; }

    void Build()
    {
        foreach (var it in main.items) all.Add(new("s", "", it.Name, it.Group.Replace("/", " › "), it.StatusLabel, false, it.Dot, () => { main.ShowSession(it.Id); return Task.CompletedTask; }));
        var cur = main.Current;
        void A(string icon, string label, Func<Task> run, string kbd = "") => all.Add(new(">", icon, label, "", kbd, true, null, run));
        A("", "Nouvelle session", () => main.NewSession(), "Ctrl Alt N");
        A("", "Historique des conversations", () => { new HistoryWindow(main).ShowDialog(); return Task.CompletedTask; }, "Ctrl H");
        A("", "Bibliothèque de prompts", () => { new PromptsWindow(main).ShowDialog(); return Task.CompletedTask; });
        A("", "Coffre", () => { new VaultWindow(main).ShowDialog(); return Task.CompletedTask; });
        A("", "Réglages", () => { new SettingsWindow(main).ShowDialog(); return Task.CompletedTask; }, "Ctrl ,");
        A("", "Connexion à Claude…", () => { new AuthWindow(main).ShowDialog(); return Task.CompletedTask; });
        A("", "À traiter (demandes de toutes les sessions)", () => { new AttentionWindow(main).Show(); return Task.CompletedTask; }, "Ctrl Maj A");
        A("", "Rechercher dans les sessions", () => { new SearchWindow(main).Show(); return Task.CompletedTask; }, "Ctrl Maj F");
        A("", "Usage de Claude", () => { new UsageWindow(main).ShowDialog(); return Task.CompletedTask; });
        A("", "Skills disponibles", () => { new SkillsWindow(main).ShowDialog(); return Task.CompletedTask; });
        A("", Theme.IsLight ? "Thème : passer en sombre" : "Thème : passer en clair", () => main.Try(async () => main.ApplySettings(await main.server.Api(HttpMethod.Put, "/api/settings", new { theme = Theme.IsLight ? "dark" : "light" }))));
        if (cur != null)
        {
            A("", "Renommer la session", () => main.Rename(cur), "Ctrl Alt R");
            A("", cur.Alive ? "Relancer la session" : "Reprendre la session", () => main.server.Api(HttpMethod.Post, $"/api/sessions/{cur.Id}/restart"));
            A("", "Fermer la session", () => main.CloseSession(cur), "Ctrl Alt W");
            A("", "File d'attente…", () => { Dialogs.Queue(main, cur); return Task.CompletedTask; }, "Ctrl Alt Q");
            A("", "Plafond de quota…", () => { Dialogs.QuotaStop(main, cur); return Task.CompletedTask; });
            A("", "Mettre en veille la session active", () => main.server.Api(HttpMethod.Post, $"/api/sessions/{cur.Id}/sleep"));
            A("", cur.NoSleep ? "Autoriser la mise en veille" : "Ne jamais mettre en veille", () => main.server.Api(HttpMethod.Post, $"/api/sessions/{cur.Id}/meta", new { noSleep = !cur.NoSleep }));
            A("", cur.Locked ? "Verrouiller maintenant" : "Verrouiller par mot de passe…", () => Dialogs.Lock(main, cur), "Ctrl Alt L");
            A("", "Enregistrer la session comme modèle", () => Dialogs.SaveTemplate(main, cur));
            A("", "Modifications (git)", () => { new SessionPanelWindow(main, cur).Show(); return Task.CompletedTask; });
        }
        foreach (var g in main.Groups) all.Add(new("#", "", g.Replace("/", " › "), "", "nouvelle session dans ce groupe", false, null, () => main.NewSession(g)));
    }
    async Task LoadPrompts()
    {
        try
        {
            foreach (var p in (await main.server.Api(HttpMethod.Get, "/api/prompts") as JsonArray ?? []).OfType<JsonObject>())
            {
                var text = (string?)p["text"] ?? "";
                all.Add(new("@", "", (string?)p["title"] ?? "", "", "envoyer à la session", false, null, async () => { if (main.Current is { } c) await PromptsWindow.Send(main, c, text); }));
            }
        }
        catch { }
    }
    void Filter()
    {
        var t = q.Text.Trim();
        var prefix = t.Length > 0 && ">#@".Contains(t[0]) ? t[0].ToString() : "";
        var term = prefix.Length > 0 ? t[1..].Trim() : t;
        shown = all.Where(e => (prefix.Length == 0 || e.Group == prefix) && (term.Length == 0 || e.Label.Contains(term, StringComparison.OrdinalIgnoreCase) || e.Sub.Contains(term, StringComparison.OrdinalIgnoreCase)))
                   .GroupBy(e => e.Group).OrderBy(g => "s>#@".IndexOf(g.Key)).SelectMany(g => g.Take(prefix.Length > 0 || term.Length > 0 ? 40 : 8)).ToList();
        rows.Children.Clear(); rowEls.Clear();
        string? last = null;
        foreach (var e in shown)
        {
            if (e.Group != last)
            {
                var h = new TextBlock { Text = Sections[e.Group], FontSize = 11, FontWeight = FontWeights.SemiBold, Margin = new Thickness(10, last == null ? 6 : 10, 0, 4) };
                h.SetResourceReference(TextBlock.ForegroundProperty, "Muted"); rows.Children.Add(h); last = e.Group;
            }
            var b = Row(e); rowEls.Add(b); rows.Children.Add(b);
        }
        if (shown.Count == 0) { var n = new TextBlock { Text = "Aucun résultat.", Margin = new Thickness(10, 10, 0, 10) }; n.SetResourceReference(TextBlock.ForegroundProperty, "Muted"); rows.Children.Add(n); }
        Select(0);
    }
    Border Row(Entry e)
    {
        var d = new DockPanel();
        if (e.Dot != null) d.Children.Add(new System.Windows.Shapes.Ellipse { Width = 7, Height = 7, Fill = e.Dot, Margin = new Thickness(0, 0, 11, 0), VerticalAlignment = VerticalAlignment.Center });
        else if (e.Icon.Length > 0) { var ic = new TextBlock { Text = e.Icon, FontFamily = Icons, FontSize = 13, Width = 18, Margin = new Thickness(0, 0, 10, 0), VerticalAlignment = VerticalAlignment.Center }; ic.SetResourceReference(TextBlock.ForegroundProperty, "Muted"); d.Children.Add(ic); }
        foreach (UIElement c in d.Children) DockPanel.SetDock(c, Dock.Left);
        if (e.Hint.Length > 0)
        {
            var h = new TextBlock { Text = e.Hint, FontSize = e.Kbd ? 11 : 12, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(12, 0, 0, 0) };
            if (e.Kbd) h.FontFamily = (FontFamily)Application.Current.FindResource("MonoFont");
            h.SetResourceReference(TextBlock.ForegroundProperty, "Muted"); DockPanel.SetDock(h, Dock.Right); d.Children.Add(h);
        }
        var name = new TextBlock { VerticalAlignment = VerticalAlignment.Center, TextTrimming = TextTrimming.CharacterEllipsis };
        name.Inlines.Add(new System.Windows.Documents.Run(e.Label) { FontWeight = e.Group == "s" ? FontWeights.SemiBold : FontWeights.Normal });
        if (e.Sub.Length > 0) { var s = new System.Windows.Documents.Run("   " + e.Sub) { FontSize = 12 }; s.SetResourceReference(System.Windows.Documents.TextElement.ForegroundProperty, "Muted"); name.Inlines.Add(s); }
        name.SetResourceReference(TextBlock.ForegroundProperty, "Fg");
        d.Children.Add(name);
        var b = new Border { Child = d, Padding = new Thickness(10, 0, 10, 0), Height = 34, CornerRadius = new CornerRadius(7), BorderThickness = new Thickness(2, 0, 0, 0), BorderBrush = Brushes.Transparent, Background = Brushes.Transparent, Cursor = Cursors.Hand };
        b.MouseEnter += (_, _) => Select(rowEls.IndexOf(b));
        b.MouseLeftButtonUp += async (_, _) => await RunSel();
        return b;
    }
    void Select(int i)
    {
        if (rowEls.Count == 0) return;
        sel = Math.Clamp(i, 0, rowEls.Count - 1);
        for (var k = 0; k < rowEls.Count; k++)
        {
            if (k == sel) { rowEls[k].SetResourceReference(Border.BackgroundProperty, "Sel"); rowEls[k].SetResourceReference(Border.BorderBrushProperty, "Accent"); rowEls[k].BringIntoView(); }
            else { rowEls[k].Background = Brushes.Transparent; rowEls[k].BorderBrush = Brushes.Transparent; }
        }
    }
    async Task RunSel()
    {
        if (sel < 0 || sel >= shown.Count) return;
        var e = shown[sel];
        SafeClose();
        await main.Try(e.Run);
    }
}

// ------------------------------------------------------------------ historique des conversations
public sealed class HistoryWindow : Screen
{
    readonly TextBox q = Ui.Box();
    readonly ListBox list = DarkList();
    JsonArray rows = [];
    // Maquette « History » : en-tête avec filtre et croix, lignes en grille (titre, date / dossier, branche / dernier message), pied d'aide
    public HistoryWindow(MainWindow owner) : base(owner, "Historique", 920, 760)
    {
        q.ToolTip = "Filtrer (titre, dossier, dernier message, branche)"; q.Height = 34; q.Padding = new Thickness(12, 0, 12, 0);
        var h = Ui.H2("Historique"); h.Margin = new Thickness(0, 0, 12, 0); DockPanel.SetDock(h, Dock.Left);
        var close = Ui.CloseBtn(this); DockPanel.SetDock(close, Dock.Right);
        var head = new DockPanel(); head.Children.Add(h); head.Children.Add(close); head.Children.Add(Ui.Placeholder(q, "Filtrer (titre, dossier, dernier message, branche)…"));
        var root = new DockPanel();
        var hb = Ui.Band(head, 20, 16); DockPanel.SetDock(hb, Dock.Top); root.Children.Add(hb);
        var f1 = new TextBlock { Text = "↑↓ choisir · Entrée reprendre", FontSize = 12 }; var f2 = new TextBlock { Text = "Clic droit : Reprendre, Renommer, Exporter, Copier le chemin, Copier l'identifiant de session", FontSize = 12, Margin = new Thickness(18, 0, 0, 0) };
        f1.SetResourceReference(TextBlock.ForegroundProperty, "Dim2"); f2.SetResourceReference(TextBlock.ForegroundProperty, "Dim2");
        var fb = Ui.Band(Ui.Row(f1, f2), 20, 10, true); DockPanel.SetDock(fb, Dock.Bottom); root.Children.Add(fb);
        list.ItemContainerStyle = Ui.S("HistItem"); list.Margin = new Thickness(10, 6, 10, 6); list.BorderThickness = new Thickness(0);
        ScrollViewer.SetHorizontalScrollBarVisibility(list, ScrollBarVisibility.Disabled);
        root.Children.Add(list);
        Content = root;
        q.TextChanged += (_, _) => Render();
        list.MouseDoubleClick += async (_, _) => await Resume();
        list.KeyDown += async (_, e) => { if (e.Key == Key.Enter) await Resume(); };
        q.PreviewKeyDown += async (_, e) => { if (e.Key == Key.Enter) await Resume(); else if (e.Key == Key.Down) { list.SelectedIndex++; e.Handled = true; } else if (e.Key == Key.Up && list.SelectedIndex > 0) { list.SelectedIndex--; e.Handled = true; } };
        list.ContextMenuOpening += (_, e) => { e.Handled = true; if (list.SelectedItem is ListBoxItem li && li.Tag is JsonObject o) Menu(o).IsOpen = true; };
        Loaded += async (_, _) => { q.Focus(); try { rows = await main.server.Api(HttpMethod.Get, "/api/history") as JsonArray ?? []; } catch { } Render(); };
    }
    void Render()
    {
        var t = q.Text.Trim();
        list.Items.Clear();
        foreach (var o in rows.OfType<JsonObject>().Where(o => t.Length == 0 || $"{o["title"]} {o["cwd"]} {o["lastPrompt"]} {o["branch"]}".Contains(t, StringComparison.OrdinalIgnoreCase)).Take(200))
        {
            TextBlock T(string s, double size, string brush, bool mono = false, bool bold = false)
            {
                var x = new TextBlock { Text = s, FontSize = size, TextTrimming = TextTrimming.CharacterEllipsis, VerticalAlignment = VerticalAlignment.Center };
                x.SetResourceReference(TextBlock.ForegroundProperty, brush); if (mono) x.SetResourceReference(TextBlock.FontFamilyProperty, "MonoFont"); if (bold) x.FontWeight = FontWeights.SemiBold; return x;
            }
            var g = new Grid(); g.ColumnDefinitions.Add(new ColumnDefinition()); g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(120) });
            for (var i = 0; i < 3; i++) g.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            var pen = Ui.IconBtn("\uE70F", "Renommer", (_, _) => { }, 22); pen.Margin = new Thickness(0, 0, 8, 0); pen.BorderThickness = new Thickness(0); pen.SetResourceReference(Control.ForegroundProperty, "Dim2");
            pen.Click += async (_, _) => await main.Try(async () => { var n = Ui.Ask(this, "Renommer la conversation", "Nom", (string?)o["title"] ?? ""); if (n != null) { await main.server.Api(HttpMethod.Post, $"/api/history/{o["id"]}/rename", new { name = n }); o["title"] = n; Render(); } });
            var title = Ui.Row(pen, T((string?)o["title"] ?? "", 13, "Fg", false, true));
            if ((bool?)o["managed"] == true)
            {
                var badge = new Grid { Margin = new Thickness(8, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
                var bg = new Border { CornerRadius = new CornerRadius(4), Opacity = 0.14 }; bg.SetResourceReference(Border.BackgroundProperty, "Ok");
                var bt = T("ouverte", 11, "Ok"); bt.Margin = new Thickness(6, 1, 6, 1); badge.Children.Add(bg); badge.Children.Add(bt); title.Children.Add(badge);
            }
            var date = T(o["mtime"] is JsonValue v && v.TryGetValue<double>(out var ms) ? DateTimeOffset.FromUnixTimeMilliseconds((long)ms).LocalDateTime.ToString("dd/MM HH:mm") : "", 12, "Muted"); date.HorizontalAlignment = HorizontalAlignment.Right;
            var cwd = T((string?)o["cwd"] ?? "", 12, "Muted", true); cwd.Margin = new Thickness(30, 4, 16, 0);
            var br = T((string?)o["branch"] ?? "", 12, "Branch", true); br.HorizontalAlignment = HorizontalAlignment.Right; br.Margin = new Thickness(0, 4, 0, 0);
            var last = T((string?)o["lastPrompt"] ?? "", 12, "Dim"); last.Margin = new Thickness(30, 4, 0, 0);
            Grid.SetColumn(date, 1); Grid.SetRow(cwd, 1); Grid.SetColumn(br, 1); Grid.SetRow(br, 1); Grid.SetRow(last, 2); Grid.SetColumnSpan(last, 2);
            title.Margin = new Thickness(0, 0, 16, 0);
            foreach (UIElement e in new UIElement[] { title, date, cwd, br, last }) g.Children.Add(e);
            list.Items.Add(new ListBoxItem { Content = g, Tag = o, ContextMenu = new ContextMenu() });
        }
        if (list.Items.Count > 0) list.SelectedIndex = 0;
    }
    ContextMenu Menu(JsonObject o)
    {
        var m = new ContextMenu();
        void Add(string h, Func<Task> a) { var i = new MenuItem { Header = h }; i.Click += async (_, _) => await main.Try(a); m.Items.Add(i); }
        Add((bool?)o["managed"] == true ? "Afficher" : "Reprendre", Resume);
        Add("Renommer", async () => { var n = Ui.Ask(this, "Renommer la conversation", "Nom", (string?)o["title"] ?? ""); if (n != null) { await main.server.Api(HttpMethod.Post, $"/api/history/{o["id"]}/rename", new { name = n }); o["title"] = n; Render(); } });
        Add("Exporter en Markdown…", async () =>
        {
            var r = await main.server.Api(HttpMethod.Get, $"/api/history/{o["id"]}/export");
            var d = new Microsoft.Win32.SaveFileDialog { FileName = ((string?)o["title"] ?? "conversation") + ".md", Filter = "Markdown|*.md" };
            if (d.ShowDialog(this) == true) await System.IO.File.WriteAllTextAsync(d.FileName, (string?)r?["markdown"] ?? r?.ToJsonString() ?? "");
        });
        Add("Copier le chemin", () => { Clipboard.SetText((string?)o["cwd"] ?? ""); return Task.CompletedTask; });
        Add("Copier l’identifiant de session", () => { Clipboard.SetText((string?)o["id"] ?? ""); return Task.CompletedTask; });
        return m;
    }
    async Task Resume()
    {
        if (list.SelectedItem is not ListBoxItem { Tag: JsonObject h }) return;
        Close();
        var id = (string?)h["id"];
        var existing = main.items.FirstOrDefault(s => (string?)s.Data["claudeSessionId"] == id);
        if (existing != null) { main.ShowSession(existing.Id); if (!existing.Alive) await main.Try(() => main.server.Api(HttpMethod.Post, $"/api/sessions/{existing.Id}/restart")); return; }
        await main.Try(async () =>
        {
            var title = (string?)h["title"] ?? "session";
            var s = await main.server.Api(HttpMethod.Post, "/api/sessions", new { cwd = (string?)h["cwd"], name = title[..Math.Min(40, title.Length)], resume = id });
            if ((string?)s?["id"] is { } sid) main.ShowSession(sid);
        });
    }
}

// ------------------------------------------------------------------ bibliothèque de prompts
public sealed class PromptsWindow : Screen
{
    readonly StackPanel list = new();
    readonly TextBox q = Ui.Box();
    JsonArray prompts = [];
    // Maquette « Prompts » : en-tête (titre, + Nouveau, croix), filtre, cartes avec titre, étiquettes, texte, Envoyer et crayon
    public PromptsWindow(MainWindow owner) : base(owner, "Bibliothèque de prompts", 600, 720)
    {
        var h = Ui.H2("Bibliothèque de prompts"); h.Margin = new Thickness(0); h.VerticalAlignment = VerticalAlignment.Center;
        var add = Ui.Btn("+ Nouveau", (_, _) => Edit(null), "Primary"); add.Margin = new Thickness(10, 0, 0, 0);
        var close = Ui.CloseBtn(this);
        var head = new DockPanel(); DockPanel.SetDock(close, Dock.Right); head.Children.Add(close); DockPanel.SetDock(add, Dock.Right); head.Children.Add(add); head.Children.Add(h);
        q.ToolTip = "Filtrer…"; q.Height = 32; q.Padding = new Thickness(10, 0, 10, 0);
        var root = new DockPanel();
        var hb = Ui.Band(head, 20, 16); DockPanel.SetDock(hb, Dock.Top); root.Children.Add(hb);
        var fb = Ui.Band(Ui.Placeholder(q, "Filtrer…"), 20, 10); DockPanel.SetDock(fb, Dock.Top); root.Children.Add(fb);
        list.Margin = new Thickness(12, 8, 12, 8);
        root.Children.Add(new ScrollViewer { Content = list, VerticalScrollBarVisibility = ScrollBarVisibility.Auto });
        Content = root;
        q.TextChanged += (_, _) => Render();
        Loaded += async (_, _) => await Load();
    }
    async Task Load() { try { prompts = await main.server.Api(HttpMethod.Get, "/api/prompts") as JsonArray ?? []; } catch { } Render(); }
    void Render()
    {
        list.Children.Clear();
        var t = q.Text.Trim();
        foreach (var p in prompts.OfType<JsonObject>().Where(p => t.Length == 0 || $"{p["title"]} {p["text"]} {p["tags"]}".Contains(t, StringComparison.OrdinalIgnoreCase)))
        {
            var text = (string?)p["text"] ?? "";
            var sp = new StackPanel();
            var tt = new TextBlock { Text = (string?)p["title"] ?? "", FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center };
            var tg = new TextBlock { Text = Tags(p), FontSize = 11, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(8, 0, 0, 0) }; tg.SetResourceReference(TextBlock.ForegroundProperty, "Muted");
            sp.Children.Add(Ui.Row(tt, tg));
            var tx = new TextBlock { Text = text.Replace("\n", " "), FontSize = 12, TextTrimming = TextTrimming.CharacterEllipsis, Margin = new Thickness(0, 4, 0, 0) }; tx.SetResourceReference(TextBlock.ForegroundProperty, "Muted");
            sp.Children.Add(tx);
            var send = Ui.Btn("Envoyer", async (_, _) => { if (main.Current is { } c) { await main.Try(() => Send(main, c, text)); Close(); } }); send.Height = 28; send.Padding = new Thickness(10, 0, 10, 0); send.Margin = new Thickness(12, 0, 0, 0);
            var edit = Ui.IconBtn("\uE70F", "Modifier", (_, _) => Edit(p)); edit.Margin = new Thickness(8, 0, 0, 0); edit.SetResourceReference(Control.BorderBrushProperty, "Line2");
            var right = Ui.Row(send, edit); right.VerticalAlignment = VerticalAlignment.Top;
            var row = new DockPanel(); DockPanel.SetDock(right, Dock.Right); row.Children.Add(right); row.Children.Add(sp);
            var card = new Border { CornerRadius = new CornerRadius(8), BorderThickness = new Thickness(1), Padding = new Thickness(12), Margin = new Thickness(0, 0, 0, 4), Child = row };
            card.SetResourceReference(Border.BackgroundProperty, "Bar"); card.SetResourceReference(Border.BorderBrushProperty, "Hover");
            list.Children.Add(card);
        }
        if (list.Children.Count == 0) list.Children.Add(Ui.Hint("Aucun prompt ne correspond."));
    }
    static string Tags(JsonObject p) => p["tags"] is JsonArray a ? string.Join(" · ", a.Select(x => (string?)x)) : (string?)p["tags"] ?? "";
    // Variables : {dossier}, {branche}, {nom}, {selection} (texte sélectionné dans le terminal)
    public static Task Send(MainWindow main, SessionItem s, string text)
    {
        var t = text.Replace("{dossier}", s.Cwd).Replace("{branche}", s.Branch).Replace("{nom}", s.Name).Replace("{selection}", "");
        return main.server.Api(HttpMethod.Post, $"/api/sessions/{s.Id}/prompt", new { text = t });
    }
    void Edit(JsonObject? p)
    {
        var w = Ui.Dialog(this, "Prompt", 520);
        var title = Ui.Box((string?)p?["title"] ?? ""); var text = Ui.Box((string?)p?["text"] ?? "", true, 7); var tags = Ui.Box(p == null ? "" : Tags(p).Replace(" · ", ", "));
        title.Height = 34; tags.Height = 34; title.Padding = tags.Padding = new Thickness(10, 0, 10, 0); text.Height = 134; text.Padding = new Thickness(10); text.FontSize = 12;
        text.SetResourceReference(Control.FontFamilyProperty, "MonoFont");
        var save = Ui.Btn("Enregistrer", async (_, _) =>
        {
            var o = p ?? new JsonObject { ["id"] = Guid.NewGuid().ToString("N")[..10] };
            o["title"] = title.Text.Trim(); o["text"] = text.Text; o["tags"] = new JsonArray(tags.Text.Split(',').Select(x => x.Trim()).Where(x => x.Length > 0).Select(x => (JsonNode)x).ToArray());
            if (p == null) prompts.Add(o);
            await main.Try(() => main.server.Api(HttpMethod.Put, "/api/prompts", prompts)); w.DialogResult = true;
        }, "Primary"); save.Height = 34; save.Padding = new Thickness(16, 0, 16, 0);
        var del = Ui.Btn("Supprimer", async (_, _) => { if (p != null) { prompts.Remove(p); await main.Try(() => main.server.Api(HttpMethod.Put, "/api/prompts", prompts)); } w.DialogResult = true; }, "Danger"); del.Height = 34; del.Padding = new Thickness(14, 0, 14, 0);
        var cancel = Ui.Btn("Annuler"); cancel.IsCancel = true; cancel.Height = 34; cancel.Padding = new Thickness(14, 0, 14, 0);
        save.Margin = new Thickness(8, 0, 0, 0);
        var foot = Ui.Footer(cancel, save); foot.Margin = new Thickness(0); if (p != null) { del.Margin = new Thickness(0); DockPanel.SetDock(del, Dock.Left); foot.Children.Add(del); }
        var vars = new TextBlock { FontSize = 12, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 12, 0, 0) }; vars.SetResourceReference(TextBlock.ForegroundProperty, "Muted");
        vars.Inlines.Add("Variables : ");
        var names = new[] { "{dossier}", "{branche}", "{nom}", "{selection}" };
        for (var i = 0; i < names.Length; i++)
        {
            var r = new System.Windows.Documents.Run(names[i]); r.SetResourceReference(System.Windows.Documents.TextElement.ForegroundProperty, "Branch"); r.SetResourceReference(System.Windows.Documents.TextElement.FontFamilyProperty, "MonoFont");
            vars.Inlines.Add(r); if (i < names.Length - 1) vars.Inlines.Add(", ");
        }
        vars.Inlines.Add(" (texte sélectionné dans le terminal).");
        var body = new StackPanel();
        body.Children.Add(Ui.Label("Titre", 6)); body.Children.Add(title);
        var l2 = Ui.Label("Texte", 6); l2.Margin = new Thickness(0, 12, 0, 6); body.Children.Add(l2); body.Children.Add(text); body.Children.Add(vars);
        var l3 = Ui.Label("Étiquettes", 6); l3.Margin = new Thickness(0, 12, 0, 6); body.Children.Add(l3); body.Children.Add(tags);
        var ph = new TextBlock { Text = "Prompt", FontSize = 17, FontWeight = FontWeights.SemiBold };
        w.Content = Ui.Modal(ph, body, foot, 20, 16, 16, 14);
        if (w.ShowDialog() == true) Render();
    }
}
