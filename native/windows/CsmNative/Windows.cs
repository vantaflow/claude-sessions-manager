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
    public HistoryWindow(MainWindow owner) : base(owner, "Historique", 920, 760)
    {
        q.ToolTip = "Filtrer (titre, dossier, dernier message, branche)";
        var head = new DockPanel { Margin = new Thickness(0, 0, 0, 8) };
        var h = Ui.H2("Historique"); h.Margin = new Thickness(0, 0, 12, 0); DockPanel.SetDock(h, Dock.Left); head.Children.Add(h); head.Children.Add(q);
        var root = new DockPanel { Margin = new Thickness(18) };
        DockPanel.SetDock(head, Dock.Top); root.Children.Add(head);
        var foot = Ui.Hint("↑↓ choisir · Entrée reprendre · clic droit : Reprendre, Renommer, Exporter, Copier le chemin, Copier l'identifiant de session"); DockPanel.SetDock(foot, Dock.Bottom); root.Children.Add(foot);
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
            var g = new Grid(); g.ColumnDefinitions.Add(new ColumnDefinition()); g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(130) });
            var title = Ui.Row(new TextBlock { Text = (string?)o["title"] ?? "", FontWeight = FontWeights.SemiBold, TextTrimming = TextTrimming.CharacterEllipsis });
            if ((bool?)o["managed"] == true) title.Children.Add(new Border { Background = new SolidColorBrush(Color.FromArgb(0x24, 0x3F, 0xB8, 0xA5)), CornerRadius = new CornerRadius(4), Padding = new Thickness(6, 0, 6, 0), Margin = new Thickness(8, 0, 0, 0), Child = new TextBlock { Text = "ouverte", FontSize = 11, Foreground = Ui.R("Ok") } });
            var date = new TextBlock { Text = o["mtime"] is JsonValue v && v.TryGetValue<double>(out var ms) ? DateTimeOffset.FromUnixTimeMilliseconds((long)ms).LocalDateTime.ToString("dd/MM HH:mm") : "", Foreground = Ui.R("Muted"), FontSize = 12, HorizontalAlignment = HorizontalAlignment.Right };
            Grid.SetColumn(date, 1);
            var sp = new StackPanel { Margin = new Thickness(4, 6, 4, 6) };
            g.Children.Add(title); g.Children.Add(date); sp.Children.Add(g);
            sp.Children.Add(new TextBlock { Text = string.Join("   ", new[] { (string?)o["cwd"], (string?)o["branch"] }.Where(x => !string.IsNullOrEmpty(x))), Foreground = Ui.R("Muted"), FontSize = 12, FontFamily = (FontFamily)FindResource("MonoFont"), TextTrimming = TextTrimming.CharacterEllipsis });
            sp.Children.Add(new TextBlock { Text = (string?)o["lastPrompt"] ?? "", Foreground = Ui.R("Fg2"), FontSize = 12, TextTrimming = TextTrimming.CharacterEllipsis });
            list.Items.Add(new ListBoxItem { Content = sp, Tag = o, Foreground = Ui.R("Fg"), ContextMenu = new ContextMenu() });
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
    public PromptsWindow(MainWindow owner) : base(owner, "Bibliothèque de prompts", 640, 720)
    {
        var head = new DockPanel { Margin = new Thickness(0, 0, 0, 8) };
        var add = Ui.Btn("+ Nouveau", (_, _) => Edit(null), "Primary"); DockPanel.SetDock(add, Dock.Right); head.Children.Add(add);
        head.Children.Add(Ui.H2("Bibliothèque de prompts"));
        q.ToolTip = "Filtrer…"; q.Margin = new Thickness(0, 0, 0, 8);
        var root = new DockPanel { Margin = new Thickness(18) };
        DockPanel.SetDock(head, Dock.Top); root.Children.Add(head);
        DockPanel.SetDock(q, Dock.Top); root.Children.Add(q);
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
            sp.Children.Add(Ui.Row(new TextBlock { Text = (string?)p["title"] ?? "", FontWeight = FontWeights.SemiBold }, new TextBlock { Text = "  " + Tags(p), Foreground = Ui.R("Muted"), FontSize = 11, VerticalAlignment = VerticalAlignment.Center }));
            sp.Children.Add(new TextBlock { Text = text.Replace("\n", " "), Foreground = Ui.R("Muted"), FontSize = 12, TextTrimming = TextTrimming.CharacterEllipsis });
            var send = Ui.Btn("Envoyer", async (_, _) => { if (main.Current is { } c) { await main.Try(() => Send(main, c, text)); Close(); } });
            var edit = Ui.Btn("✎", (_, _) => Edit(p)); edit.ToolTip = "Modifier";
            var row = new DockPanel(); var right = Ui.Row(send, edit); DockPanel.SetDock(right, Dock.Right); row.Children.Add(right); row.Children.Add(sp);
            list.Children.Add(Card(row));
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
        var w = Ui.Dialog(this, "Prompt", 540);
        var title = Ui.Box((string?)p?["title"] ?? ""); var text = Ui.Box((string?)p?["text"] ?? "", true, 7); var tags = Ui.Box(p == null ? "" : Tags(p).Replace(" · ", ", "));
        text.FontFamily = (FontFamily)FindResource("MonoFont");
        var save = Ui.Btn("Enregistrer", async (_, _) =>
        {
            var o = p ?? new JsonObject { ["id"] = Guid.NewGuid().ToString("N")[..10] };
            o["title"] = title.Text.Trim(); o["text"] = text.Text; o["tags"] = new JsonArray(tags.Text.Split(',').Select(x => x.Trim()).Where(x => x.Length > 0).Select(x => (JsonNode)x).ToArray());
            if (p == null) prompts.Add(o);
            await main.Try(() => main.server.Api(HttpMethod.Put, "/api/prompts", prompts)); w.DialogResult = true;
        }, "Primary");
        var del = Ui.Btn("Supprimer", async (_, _) => { if (p != null) { prompts.Remove(p); await main.Try(() => main.server.Api(HttpMethod.Put, "/api/prompts", prompts)); } w.DialogResult = true; }, "Danger");
        var cancel = Ui.Btn("Annuler"); cancel.IsCancel = true;
        var foot = Ui.Footer(cancel, save); if (p != null) { del.Margin = new Thickness(0); DockPanel.SetDock(del, Dock.Left); foot.Children.Add(del); }
        w.Content = Ui.Body(Ui.H2("Prompt"), Ui.Label("Titre"), title, Ui.Label("Texte"), text,
            Ui.Hint("Variables : {dossier}, {branche}, {nom}, {selection} (texte sélectionné dans le terminal)."), Ui.Label("Étiquettes"), tags, foot);
        if (w.ShowDialog() == true) Render();
    }
}
