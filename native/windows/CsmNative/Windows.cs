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
        PreviewKeyDown += (_, e) => { if (e.Key == Key.Escape) Close(); };
    }
    protected static Border Card(UIElement c, double pad = 12) => new() { Background = Ui.R("Bar"), BorderBrush = Ui.R("Line"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(10), Padding = new Thickness(pad), Margin = new Thickness(0, 4, 0, 0), Child = c };
    protected static ListBox DarkList() => new() { Background = Brushes.Transparent, BorderThickness = new Thickness(0), Foreground = Ui.R("Fg"), HorizontalContentAlignment = HorizontalAlignment.Stretch };
}

// ------------------------------------------------------------------ palette (Ctrl+K) : sessions, actions, prompts
public sealed class PaletteWindow : Screen
{
    readonly TextBox q = Ui.Box();
    readonly ListBox list = DarkList();
    sealed record Entry(string Group, string Label, string Hint, Func<Task> Run) { public override string ToString() => Label; }
    readonly List<Entry> all = [];

    public PaletteWindow(MainWindow owner) : base(owner, "Palette", 680, 520)
    {
        WindowStyle = WindowStyle.None; ResizeMode = ResizeMode.NoResize; AllowsTransparency = false;
        BorderBrush = Ui.R("Ring"); BorderThickness = new Thickness(1);
        q.FontSize = 16; q.ToolTip = "> commandes · # groupes · @ prompts";
        list.ItemTemplate = Template();
        var root = new DockPanel { Margin = new Thickness(10) };
        DockPanel.SetDock(q, Dock.Top); root.Children.Add(q);
        var foot = Ui.Hint("↑↓ choisir · Entrée ouvrir · > commandes · # groupes · @ prompts"); DockPanel.SetDock(foot, Dock.Bottom); root.Children.Add(foot);
        list.Margin = new Thickness(0, 8, 0, 0); root.Children.Add(list);
        Content = root;
        Build();
        q.TextChanged += (_, _) => Filter();
        q.PreviewKeyDown += async (_, e) =>
        {
            if (e.Key == Key.Down) { list.SelectedIndex = Math.Min(list.Items.Count - 1, list.SelectedIndex + 1); list.ScrollIntoView(list.SelectedItem); e.Handled = true; }
            else if (e.Key == Key.Up) { list.SelectedIndex = Math.Max(0, list.SelectedIndex - 1); list.ScrollIntoView(list.SelectedItem); e.Handled = true; }
            else if (e.Key == Key.Enter) { e.Handled = true; await RunSel(); }
        };
        list.MouseDoubleClick += async (_, _) => await RunSel();
        Deactivated += (_, _) => { if (IsVisible) Close(); };
        Loaded += async (_, _) => { q.Focus(); await LoadPrompts(); Filter(); };
    }
    static DataTemplate Template()
    {
        var f = new FrameworkElementFactory(typeof(DockPanel));
        var g = new FrameworkElementFactory(typeof(TextBlock)); g.SetBinding(TextBlock.TextProperty, new System.Windows.Data.Binding("Hint")); g.SetValue(TextBlock.ForegroundProperty, Ui.R("Muted")); g.SetValue(DockPanel.DockProperty, Dock.Right); g.SetValue(TextBlock.FontSizeProperty, 12.0);
        var l = new FrameworkElementFactory(typeof(TextBlock)); l.SetBinding(TextBlock.TextProperty, new System.Windows.Data.Binding("Label")); l.SetValue(TextBlock.PaddingProperty, new Thickness(4, 6, 4, 6));
        f.AppendChild(g); f.AppendChild(l);
        return new DataTemplate { VisualTree = f };
    }
    void Build()
    {
        foreach (var it in main.items) all.Add(new("s", $"● {it.Name}", $"{(it.Group.Length > 0 ? it.Group.Replace("/", " › ") + " · " : "")}{it.StatusLabel}", () => { main.ShowSession(it.Id); return Task.CompletedTask; }));
        var cur = main.Current;
        void A(string label, Func<Task> run, string kbd = "") => all.Add(new(">", label, kbd, run));
        A("Nouvelle session", () => main.NewSession(), "Ctrl+Alt+N");
        A("Historique des conversations", () => { new HistoryWindow(main).ShowDialog(); return Task.CompletedTask; }, "Ctrl+H");
        A("Bibliothèque de prompts", () => { new PromptsWindow(main).ShowDialog(); return Task.CompletedTask; });
        A("Coffre", () => { new VaultWindow(main).ShowDialog(); return Task.CompletedTask; });
        A("Réglages", () => { new SettingsWindow(main).ShowDialog(); return Task.CompletedTask; }, "Ctrl+,");
        A("Connexion à Claude…", () => { new AuthWindow(main).ShowDialog(); return Task.CompletedTask; });
        if (cur != null)
        {
            A("Renommer la session", () => main.Rename(cur), "Ctrl+Alt+R");
            A(cur.Alive ? "Relancer la session" : "Reprendre la session", () => main.server.Api(HttpMethod.Post, $"/api/sessions/{cur.Id}/restart"));
            A("Fermer la session", () => main.CloseSession(cur), "Ctrl+Alt+W");
            A("File d'attente…", () => { Dialogs.Queue(main, cur); return Task.CompletedTask; }, "Ctrl+Alt+Q");
            A("Plafond de quota…", () => { Dialogs.QuotaStop(main, cur); return Task.CompletedTask; });
            A("Mettre en veille la session active", () => main.server.Api(HttpMethod.Post, $"/api/sessions/{cur.Id}/sleep"));
            A(cur.NoSleep ? "Autoriser la mise en veille" : "Ne jamais mettre en veille", () => main.server.Api(HttpMethod.Post, $"/api/sessions/{cur.Id}/meta", new { noSleep = !cur.NoSleep }));
            A(cur.Locked ? "Verrouiller maintenant" : "Verrouiller par mot de passe…", () => Dialogs.Lock(main, cur), "Ctrl+Alt+L");
            A("Enregistrer la session comme modèle", () => Dialogs.SaveTemplate(main, cur));
            A("Modifications (git)", () => { new SessionPanelWindow(main, cur).Show(); return Task.CompletedTask; });
        }
        foreach (var g in main.Groups) all.Add(new("#", $"# {g.Replace("/", " › ")}", "nouvelle session dans ce groupe", () => main.NewSession(g)));
    }
    async Task LoadPrompts()
    {
        try
        {
            foreach (var p in (await main.server.Api(HttpMethod.Get, "/api/prompts") as JsonArray ?? []).OfType<JsonObject>())
            {
                var text = (string?)p["text"] ?? "";
                all.Add(new("@", $"@ {(string?)p["title"]}", "envoyer à la session", async () => { if (main.Current is { } c) await PromptsWindow.Send(main, c, text); }));
            }
        }
        catch { }
    }
    void Filter()
    {
        var t = q.Text.Trim();
        var prefix = t.Length > 0 && ">#@".Contains(t[0]) ? t[0].ToString() : "";
        var term = prefix.Length > 0 ? t[1..].Trim() : t;
        list.ItemsSource = all.Where(e => (prefix.Length == 0 || e.Group == prefix) && (term.Length == 0 || e.Label.Contains(term, StringComparison.OrdinalIgnoreCase) || e.Hint.Contains(term, StringComparison.OrdinalIgnoreCase))).Take(60).ToList();
        list.SelectedIndex = 0;
    }
    async Task RunSel()
    {
        if (list.SelectedItem is not Entry e) return;
        Close();
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
