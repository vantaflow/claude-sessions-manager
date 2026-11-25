using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Data;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Shapes;
using Microsoft.Terminal.Wpf;

namespace CsmNative;

public partial class MainWindow : Window
{
    internal readonly CsmServer server = new();
    internal readonly ObservableCollection<SessionItem> items = [];
    readonly ICollectionView view;
    readonly Dictionary<string, (TerminalControl Term, SessionConnection Conn)> terms = [];
    readonly Dictionary<string, List<string>> early = []; // sortie reçue avant l'ouverture du terminal de la session
    readonly Tray tray;
    bool quitting;
    // Panneaux : 1, 2 ou 4 sessions affichées ; la session choisie dans la liste va dans le panneau actif
    int layout = 1, activePane;
    readonly string?[] panes = new string?[4];
    readonly HashSet<string> excluded = []; // panneaux décochés pour l'envoi groupé

    static readonly TerminalTheme Theme = new()
    {
        DefaultBackground = 0x110F0E, DefaultForeground = 0xCCD3D6, DefaultSelectionBackground = 0x5A4A44, CursorStyle = CursorStyle.BlinkingBar,
        // COLORREF (0x00BBGGRR) : palette proche de celle de l'app web
        ColorTable = [0x2E2E2E, 0x4E73E5, 0xA5B83F, 0x3BA3E3, 0xE8A061, 0xC778C6, 0xC2B656, 0xE1E6E8,
                      0x75756B, 0x8080FF, 0xA0E08A, 0x9AD7F0, 0xFFB57A, 0xE69BE0, 0xDCD27A, 0xFFFFFF],
    };

    public MainWindow()
    {
        InitializeComponent();
        view = CollectionViewSource.GetDefaultView(items);
        view.GroupDescriptions.Add(new PropertyGroupDescription(nameof(SessionItem.GroupKey)));
        view.SortDescriptions.Add(new SortDescription(nameof(SessionItem.Pinned), ListSortDirection.Descending));
        view.SortDescriptions.Add(new SortDescription(nameof(SessionItem.GroupKey), ListSortDirection.Ascending));
        view.SortDescriptions.Add(new SortDescription(nameof(SessionItem.Order), ListSortDirection.Ascending));
        view.Filter = o => Matches((SessionItem)o);
        if (view is ICollectionViewLiveShaping live && live.CanChangeLiveGrouping)
        {
            live.IsLiveGrouping = live.IsLiveSorting = live.IsLiveFiltering = true;
            foreach (var p in new[] { nameof(SessionItem.GroupKey), nameof(SessionItem.Order), nameof(SessionItem.Pinned) }) { live.LiveGroupingProperties.Add(p); live.LiveSortingProperties.Add(p); }
            live.LiveFilteringProperties.Add(nameof(SessionItem.Status));
        }
        List.ItemsSource = view;
        tray = new Tray(this, () => { quitting = true; Close(); });
        SourceInitialized += (_, _) => DarkTitleBar();
        Loaded += async (_, _) => await Start();
        Closing += (_, e) => { if (!quitting) { e.Cancel = true; Hide(); tray.Hint(); } }; // fermer la fenêtre : l'app reste dans la zone de notification
        Closed += async (_, _) => { tray.Dispose(); await server.DisposeAsync(); };
        PreviewKeyDown += OnKeys;
        BuildPanes();
        ShowHeader();
    }

    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
    void DarkTitleBar() { var on = 1; try { DwmSetWindowAttribute(new WindowInteropHelper(this).Handle, 20, ref on, 4); } catch { } }

    internal SessionItem? Current => panes[activePane] is { } id ? items.FirstOrDefault(i => i.Id == id) : List.SelectedItem as SessionItem;
    internal IEnumerable<string> Groups => items.Select(i => i.Group).Where(g => g.Length > 0).Distinct().OrderBy(g => g);

    bool Matches(SessionItem it)
    {
        var q = Search?.Text.Trim() ?? "";
        if (q.Length > 0 && !$"{it.Name} {it.Cwd} {it.Group}".Contains(q, StringComparison.OrdinalIgnoreCase)) return false;
        if (FWork?.IsChecked == true) return it.Status == "working";
        if (FWait?.IsChecked == true) return it.Status == "attention";
        return true;
    }
    void OnSearch(object sender, TextChangedEventArgs e) => view.Refresh();
    void OnFilter(object sender, RoutedEventArgs e)
    {
        foreach (var t in new[] { FAll, FWork, FWait }) t.IsChecked = t == sender;
        view.Refresh();
    }

    async Task Start()
    {
        StatusText.Text = "Connexion au serveur CSM…";
        server.SessionsReceived += l => Dispatcher.Invoke(() => SetList(l));
        server.SessionUpdated += s => Dispatcher.Invoke(() => Upsert(s));
        server.SessionRemoved += id => Dispatcher.Invoke(() => Remove(id));
        server.Output += (id, d, replay) => Dispatcher.Invoke(() => Feed(id, d, replay));
        server.Clear += id => Dispatcher.Invoke(() => Feed(id, "\x1b[2J\x1b[3J\x1b[H", false));
        server.Quota += () => Dispatcher.Invoke(async () => await LoadQuota());
        server.Disconnected += why => Dispatcher.Invoke(() => StatusText.Text = $"Déconnecté du serveur : {why}");
        try
        {
            await server.EnsureRunningAsync();
            await server.ConnectAsync();
            VersionText.Text = server.Version;
            StatusText.Text = "";
            await LoadQuota();
            _ = SyncLoop();
        }
        catch (Exception e) { StatusText.Text = e.Message; }
    }

    // ---------------------------------------------------------------- liste
    void SetList(JsonArray list)
    {
        var keep = Current?.Id;
        items.Clear();
        foreach (var n in list.OfType<JsonObject>()) items.Add(Make(n));
        for (var i = 0; i < 4; i++) if (panes[i] != null && !items.Any(x => x.Id == panes[i])) panes[i] = null;
        if (panes[activePane] == null) panes[activePane] = keep != null && items.Any(x => x.Id == keep) ? keep : view.Cast<SessionItem>().FirstOrDefault()?.Id;
        RenderPanes(); Count();
    }
    static SessionItem Make(JsonObject o) { var it = new SessionItem { Id = (string?)o["id"] ?? "" }; it.Update(o); return it; }
    void Upsert(JsonObject s)
    {
        var id = (string?)s["id"] ?? "";
        var it = items.FirstOrDefault(i => i.Id == id);
        if (it == null) { items.Add(Make(s)); Count(); return; }
        var before = it.Status;
        it.Update(s);
        Notify(it, before);
        if (panes.Contains(id)) { RenderPaneHeaders(); ShowHeader(); }
        Count();
    }
    void Remove(string id)
    {
        var it = items.FirstOrDefault(i => i.Id == id);
        if (it != null) items.Remove(it);
        terms.Remove(id); early.Remove(id);
        for (var i = 0; i < 4; i++) if (panes[i] == id) panes[i] = null;
        if (panes[activePane] == null) panes[activePane] = view.Cast<SessionItem>().FirstOrDefault(x => !panes.Contains(x.Id))?.Id;
        RenderPanes(); Count();
    }
    void Count()
    {
        CountText.Text = $"SESSIONS · {items.Count}";
        FWork.Content = $"Travaillent · {items.Count(i => i.Status == "working")}";
        FWait.Content = $"Attendent · {items.Count(i => i.Status == "attention")}";
    }

    // Notification système quand une session attend ta réponse ou a fini, si tu ne la regardes pas (alertes coupées : rien)
    void Notify(SessionItem it, string before)
    {
        if (it.Muted || before == it.Status) return;
        if (IsActive && panes.Take(layout).Contains(it.Id)) return;
        if (it.Status == "attention") tray.Toast(it.Name, it.Message.Length > 0 ? it.Message : "attend ta réponse", () => Reveal(it.Id));
        else if (it.Status == "idle" && before == "working") tray.Toast(it.Name, "a fini", () => Reveal(it.Id));
    }
    public void Reveal(string? id = null)
    {
        Show(); if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal; Activate();
        if (id != null) ShowSession(id);
    }
    internal void ShowSession(string id)
    {
        var at = Array.IndexOf(panes, id);
        if (at >= 0 && at < layout) activePane = at; else panes[activePane] = id;
        RenderPanes();
    }

    // ---------------------------------------------------------------- terminaux et panneaux
    // Aperçu Claude Design : dernier lien claude.ai/artifact/… vu dans le terminal de chaque session ; une nouvelle
    // publication (sortie en direct, pas le contenu d'avant) ouvre l'aperçu tout seul
    static readonly System.Text.RegularExpressions.Regex ArtifactUrl = new(@"https://claude\.ai/(?:code/)?artifact/[A-Za-z0-9-]{6,}", System.Text.RegularExpressions.RegexOptions.Compiled);
    readonly Dictionary<string, string> designUrls = [];
    readonly Dictionary<string, DesignWindow> designWindows = [];
    void WatchDesign(string id, string d, bool replay)
    {
        var plain = System.Text.RegularExpressions.Regex.Replace(d, @"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)", "");
        var m = ArtifactUrl.Matches(plain).LastOrDefault();
        if (m == null || (designUrls.TryGetValue(id, out var old) && old == m.Value && replay)) return;
        var isNew = !designUrls.TryGetValue(id, out var prev) || prev != m.Value || !replay;
        designUrls[id] = m.Value;
        if (Current?.Id == id) ShowHeader();
        if (!replay && isNew) OpenDesign(id);
    }
    void OpenDesign(string id)
    {
        if (!designUrls.TryGetValue(id, out var url)) return;
        if (designWindows.TryGetValue(id, out var w) && w.IsLoaded) { w.Show(url); return; }
        var name = items.FirstOrDefault(i => i.Id == id)?.Name ?? "session";
        w = new DesignWindow(this, name, url);
        w.Closed += (_, _) => designWindows.Remove(id);
        designWindows[id] = w;
        w.Show();
    }
    void OnDesign(object sender, RoutedEventArgs e) { if (Current is { } it) OpenDesign(it.Id); }

    void Feed(string id, string d, bool replay)
    {
        if (d.Contains("claude.ai/")) WatchDesign(id, d, replay);
        if (terms.TryGetValue(id, out var t)) { if (!replay) t.Conn.Feed(d); return; }
        if (!early.TryGetValue(id, out var l)) early[id] = l = [];
        if (replay) l.Clear();
        l.Add(d);
        var size = l.Sum(x => x.Length);
        while (size > 2_000_000 && l.Count > 1) { size -= l[0].Length; l.RemoveAt(0); }
    }

    TerminalControl TermFor(string id)
    {
        if (terms.TryGetValue(id, out var t)) return t.Term;
        var conn = new SessionConnection(server, id);
        if (early.Remove(id, out var buf)) foreach (var d in buf) conn.Feed(d);
        var term = new TerminalControl { AutoResize = true, Focusable = true };
        term.Loaded += (_, _) => term.SetTheme(Theme, "Cascadia Mono", 12, Color.FromRgb(0x0E, 0x0F, 0x11));
        term.Connection = conn;
        terms[id] = (term, conn);
        return term;
    }

    readonly Border[] paneBoxes = new Border[4];
    readonly ContentControl[] paneHosts = new ContentControl[4];
    readonly TextBlock[] paneTitles = new TextBlock[4], paneStates = new TextBlock[4];
    readonly Ellipse[] paneDots = new Ellipse[4];
    readonly CheckBox[] paneChecks = new CheckBox[4];
    readonly Border[] paneHeads = new Border[4];

    void BuildPanes()
    {
        for (var i = 0; i < 4; i++)
        {
            var idx = i;
            var host = new ContentControl();
            var check = new CheckBox { ToolTip = "Inclure dans l'envoi groupé", Margin = new Thickness(0, 0, 8, 0), VerticalAlignment = VerticalAlignment.Center };
            check.Click += (_, _) => { if (panes[idx] is { } id) { if (check.IsChecked == true) excluded.Remove(id); else excluded.Add(id); RenderSplit(); } };
            var dot = new Ellipse { Width = 8, Height = 8, Margin = new Thickness(0, 0, 8, 0), VerticalAlignment = VerticalAlignment.Center };
            var title = new TextBlock { FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center };
            var state = new TextBlock { Foreground = (Brush)FindResource("Muted"), FontSize = 12, Margin = new Thickness(8, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
            var max = new Button { Content = "⤢", Width = 26, Height = 24, Padding = new Thickness(0), Style = (Style)FindResource("Ghost"), ToolTip = "Agrandir ce panneau" };
            max.Click += (_, _) => { activePane = idx; if (panes[idx] is { } id) { panes[0] = id; activePane = 0; } SetLayout(1); };
            var x = new Button { Content = "✕", Width = 26, Height = 24, Padding = new Thickness(0), Style = (Style)FindResource("Ghost"), ToolTip = "Retirer de la grille" };
            x.Click += (_, _) => { panes[idx] = null; RenderPanes(); };
            var right = new StackPanel { Orientation = Orientation.Horizontal }; right.Children.Add(max); right.Children.Add(x);
            var headRow = new DockPanel(); DockPanel.SetDock(right, Dock.Right); headRow.Children.Add(right);
            var left = new StackPanel { Orientation = Orientation.Horizontal };
            foreach (var c in new UIElement[] { check, dot, title, state }) left.Children.Add(c);
            headRow.Children.Add(left);
            var head = new Border { Height = 36, Padding = new Thickness(10, 0, 4, 0), Background = (Brush)FindResource("Panel"), BorderBrush = (Brush)FindResource("Line"), BorderThickness = new Thickness(0, 0, 0, 1), Child = headRow };
            var dock = new DockPanel(); DockPanel.SetDock(head, Dock.Top); dock.Children.Add(head); dock.Children.Add(host);
            var box = new Border { CornerRadius = new CornerRadius(10), Background = (Brush)FindResource("Term"), BorderThickness = new Thickness(1), Margin = new Thickness(4), ClipToBounds = true, Child = dock };
            box.PreviewMouseDown += (_, _) => { if (activePane != idx) { activePane = idx; RenderPaneHeaders(); ShowHeader(); SyncListSelection(); } };
            paneBoxes[i] = box; paneHosts[i] = host; paneTitles[i] = title; paneStates[i] = state; paneDots[i] = dot; paneChecks[i] = check; paneHeads[i] = head;
            Panes.Children.Add(box);
        }
        SetLayout(1);
    }

    void SetLayout(int n)
    {
        layout = n;
        L1.IsChecked = n == 1; L2.IsChecked = n == 2; L4.IsChecked = n == 4;
        Panes.RowDefinitions.Clear(); Panes.ColumnDefinitions.Clear();
        var cols = n == 1 ? 1 : 2; var rows = n == 4 ? 2 : 1;
        for (var c = 0; c < cols; c++) Panes.ColumnDefinitions.Add(new ColumnDefinition());
        for (var r = 0; r < rows; r++) Panes.RowDefinitions.Add(new RowDefinition());
        if (activePane >= n) activePane = 0;
        // panneaux libres : remplis avec les sessions suivantes de la liste
        foreach (var it in view.Cast<SessionItem>())
        {
            var free = Array.FindIndex(panes, 0, n, p => p == null);
            if (free < 0) break;
            if (!panes.Take(n).Contains(it.Id)) panes[free] = it.Id;
        }
        RenderPanes();
    }
    void OnLayout(object sender, RoutedEventArgs e) => SetLayout(int.Parse((string)((FrameworkElement)sender).Tag));

    void RenderPanes()
    {
        for (var i = 0; i < 4; i++)
        {
            var on = i < layout;
            paneBoxes[i].Visibility = on ? Visibility.Visible : Visibility.Collapsed;
            Grid.SetColumn(paneBoxes[i], layout == 1 ? 0 : i % 2);
            Grid.SetRow(paneBoxes[i], layout == 4 ? i / 2 : 0);
            paneHeads[i].Visibility = layout == 1 ? Visibility.Collapsed : Visibility.Visible;
            var id = on ? panes[i] : null;
            if (paneHosts[i].Content is TerminalControl old && (id == null || !terms.TryGetValue(id, out var t) || t.Term != old)) paneHosts[i].Content = null;
        }
        // un terminal n'a qu'un parent : d'abord tout détacher, puis rattacher
        for (var i = 0; i < layout; i++) if (panes[i] is { } id) paneHosts[i].Content = TermFor(id);
        RenderPaneHeaders();
        ShowHeader();
        SyncListSelection();
        _ = server.Shown(panes.Take(layout).OfType<string>()); // sessions affichées : jamais mises en veille, réveillées si elles dorment
        (paneHosts[activePane].Content as TerminalControl)?.Focus();
    }
    void RenderPaneHeaders()
    {
        for (var i = 0; i < layout; i++)
        {
            var it = panes[i] is { } id ? items.FirstOrDefault(x => x.Id == id) : null;
            paneTitles[i].Text = it?.Name ?? "Glisse ou choisis une session";
            paneStates[i].Text = it?.StatusLabel ?? "";
            paneDots[i].Fill = it?.Dot ?? Brushes.Transparent;
            paneChecks[i].IsChecked = it != null && !excluded.Contains(it.Id);
            paneChecks[i].IsEnabled = it != null;
            paneBoxes[i].BorderBrush = layout > 1 && i == activePane ? (Brush)FindResource("Accent") : (Brush)FindResource("Line");
        }
        RenderSplit();
    }
    bool syncing;
    void SyncListSelection()
    {
        syncing = true;
        try { List.SelectedItem = items.FirstOrDefault(x => x.Id == panes[activePane]); }
        finally { syncing = false; }
    }
    void OnSelect(object sender, RoutedEventArgs e)
    {
        if (syncing || List.SelectedItem is not SessionItem it) return;
        ShowSession(it.Id);
    }

    // Envoi groupé (2 ou 4 panneaux) : même message à toutes les sessions affichées cochées
    IEnumerable<SessionItem> SplitTargets => panes.Take(layout).OfType<string>().Where(id => !excluded.Contains(id)).Select(id => items.FirstOrDefault(x => x.Id == id)).OfType<SessionItem>();
    void RenderSplit()
    {
        SplitBar.Visibility = layout > 1 ? Visibility.Visible : Visibility.Collapsed;
        var n = SplitTargets.Count();
        SplitCount.Text = n == 1 ? "1 session" : $"{n} sessions";
    }
    void OnSplitKey(object sender, KeyEventArgs e) { if (e.Key == Key.Enter) { e.Handled = true; OnSplitSend(sender, e); } }
    async void OnSplitSend(object sender, RoutedEventArgs e)
    {
        var text = SplitText.Text.Trim();
        if (text.Length == 0) return;
        foreach (var it in SplitTargets.ToList())
        {
            if (it.Status is "working" or "attention" && SplitQueue.IsChecked == true) await Try(() => Dialogs.Enqueue(this, it, text));
            else await Try(() => server.Api(HttpMethod.Post, $"/api/sessions/{it.Id}/prompt", new { text }));
        }
        SplitText.Clear();
    }

    void ShowHeader()
    {
        var it = Current;
        Title.Text = it?.Name ?? "Aucune session";
        BranchBadge.Visibility = it?.Branch.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
        BranchText.Text = it != null ? $"⎇ {it.Branch}" : "";
        StateText.Text = it?.StatusLabel ?? "";
        StateText.Foreground = it?.StateBrush ?? Brushes.Transparent;
        StateBadge.Background = it == null ? Brushes.Transparent : new SolidColorBrush(Color.FromArgb(0x24, ((SolidColorBrush)it.StateBrush).Color.R, ((SolidColorBrush)it.StateBrush).Color.G, ((SolidColorBrush)it.StateBrush).Color.B));
        Subtitle.Text = it == null ? "" : string.Join(" · ", new[] { it.Cwd, it.Model, it.Mode }.Where(x => x.Length > 0));
        var has = it != null;
        foreach (var b in new[] { BtnRestart, BtnClose, BtnChanges, BtnOpen, BtnAttach, BtnMore }) b.IsEnabled = has;
        BtnPause.IsEnabled = it?.Alive == true;
        BtnDesign.Visibility = it != null && designUrls.ContainsKey(it.Id) ? Visibility.Visible : Visibility.Collapsed;
        BtnRestart.Content = it?.Alive == true ? "Relancer" : "Reprendre";
    }

    async Task LoadQuota()
    {
        try
        {
            var q = await server.Api(HttpMethod.Get, "/api/quota");
            void Set(ProgressBar bar, TextBlock txt, JsonNode? n)
            {
                if (n?["pct"] is JsonValue p && p.TryGetValue<double>(out var v)) { bar.Value = v; txt.Text = $"{Math.Round(v)} %"; }
                else { bar.Value = 0; txt.Text = "—"; }
            }
            Set(Q5Bar, Q5Text, q?["five"]); Set(Q7Bar, Q7Text, q?["seven"]);
        }
        catch { }
    }
    async Task SyncLoop()
    {
        while (IsLoaded)
        {
            try
            {
                var s = await server.Api(HttpMethod.Get, "/api/sync");
                var on = (bool?)s?["enabled"] == true;
                var last = s?["lastOk"] is JsonValue l && l.TryGetValue<double>(out var t) && t > 0 ? DateTimeOffset.FromUnixTimeMilliseconds((long)t) : (DateTimeOffset?)null;
                var err = (string?)s?["lastError"] ?? "";
                SyncDot.Fill = !on ? SessionItem.OffB : err.Length > 0 ? SessionItem.WarnB : SessionItem.OkB;
                SyncText.Text = !on ? "Synchro désactivée" : err.Length > 0 ? "Synchro : " + err : last is { } d ? $"Synchro · {Ago(d)}" : "Synchro…";
            }
            catch { }
            await Task.Delay(TimeSpan.FromSeconds(10));
        }
    }
    static string Ago(DateTimeOffset d)
    {
        var s = (DateTimeOffset.Now - d).TotalSeconds;
        return s < 60 ? $"il y a {Math.Max(1, (int)s)} s" : s < 3600 ? $"il y a {(int)(s / 60)} min" : $"il y a {(int)(s / 3600)} h";
    }

    // ---------------------------------------------------------------- actions
    internal async Task Try(Func<Task> f)
    {
        try { await f(); } catch (Exception e) { StatusText.Text = e.Message; }
    }
    Task Post(string id, string action, object? body = null) => Try(() => server.Api(HttpMethod.Post, $"/api/sessions/{id}/{action}", body));
    Task Meta(string id, object body) => Post(id, "meta", body);

    async void OnNew(object sender, RoutedEventArgs e) => await NewSession();
    internal async Task NewSession(string? group = null)
    {
        var dlg = new NewSessionWindow(this, group ?? Current?.Group);
        if (dlg.ShowDialog() != true || dlg.Result == null) return;
        if (dlg.Result is JsonObject o) { Upsert(o); ShowSession((string?)o["id"] ?? ""); }
    }
    void OnNewGroup(object sender, RoutedEventArgs e)
    {
        var g = Ui.Ask(this, "Nouveau groupe", "Nom du groupe (« Parent/Enfant » pour un sous-groupe)");
        if (g != null) _ = Try(async () =>
        {
            var st = await server.Api(HttpMethod.Get, "/api/settings");
            var list = ((string?)st?["groupList"] ?? "").Split('\n').Where(x => x.Trim().Length > 0).ToList();
            if (!list.Contains(g)) list.Add(g);
            await server.Api(HttpMethod.Put, "/api/settings", new { groupList = string.Join("\n", list) });
        });
    }
    async void OnRestart(object sender, RoutedEventArgs e) { if (Current is { } it) await Post(it.Id, "restart"); }
    async void OnPause(object sender, RoutedEventArgs e) { if (Current is { } it) await Pause(it); }
    async void OnClose(object sender, RoutedEventArgs e) { if (Current is { } it) await CloseSession(it); }
    async void OnRenameBtn(object sender, RoutedEventArgs e) { if (Current is { } it) await Rename(it); }

    async Task Pause(SessionItem it)
    {
        StatusText.Text = "Mise en pause… (mémoire et synchro)";
        await Try(async () =>
        {
            var r = await server.Api(HttpMethod.Post, $"/api/sessions/{it.Id}/pause");
            var parts = new[] { (bool?)r?["memory"] switch { true => "mémoire à jour", false => "mémoire non enregistrée", _ => "" }, (bool?)r?["synced"] switch { true => "synchronisée", false => "synchro en échec (voir Réglages › Synchronisation)", _ => "" } }.Where(x => x.Length > 0);
            StatusText.Text = "En pause" + (parts.Any() ? " — " + string.Join(", ", parts) : "");
        });
    }
    // Fermer : retirée ici et sur les autres machines synchronisées ; la conversation reste dans l'Historique.
    // Session dans un worktree : garder, fusionner ou supprimer le worktree.
    internal async Task CloseSession(SessionItem it)
    {
        if (it.Worktree is { } wt)
        {
            var choice = Dialogs.CloseWorktree(this, it.Name, (string?)wt["path"] ?? "", it.Branch, (string?)wt["base"] ?? "");
            if (choice == null) return;
            await Try(async () =>
            {
                if (choice == "keep") await server.Api(HttpMethod.Delete, $"/api/sessions/{it.Id}?here=1");
                else if (choice == "merge")
                {
                    await server.Api(HttpMethod.Post, $"/api/sessions/{it.Id}/worktree/merge");
                    await server.Api(HttpMethod.Post, $"/api/sessions/{it.Id}/worktree/remove", new { deleteBranch = true });
                    StatusText.Text = $"Fusionné dans {(string?)wt["base"]}";
                }
                else if (choice == "remove")
                {
                    if (MessageBox.Show(this, $"Supprimer définitivement le worktree et la branche {it.Branch} ?", "Fermer", MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes) return;
                    await server.Api(HttpMethod.Post, $"/api/sessions/{it.Id}/worktree/remove", new { deleteBranch = true, force = true });
                }
            });
            return;
        }
        StatusText.Text = "Fermeture… (mémoire et synchro)";
        await Try(async () =>
        {
            var r = await server.Api(HttpMethod.Delete, $"/api/sessions/{it.Id}?here=1");
            StatusText.Text = (bool?)r?["kept"] == true ? "Fermée — retirée aussi de tes autres machines" : "Fermée";
        });
    }
    internal async Task Rename(SessionItem it)
    {
        var n = Dialogs.Rename(this, it.Name);
        if (n != null) await Post(it.Id, "rename", new { name = n });
    }

    void OnOpenIn(object sender, RoutedEventArgs e)
    {
        if (Current is not { } it) return;
        var m = new ContextMenu { PlacementTarget = BtnOpen, Placement = PlacementMode.Bottom };
        void Add(string h, string target) { var mi = new MenuItem { Header = h }; mi.Click += async (_, _) => await Post(it.Id, "open", new { target }); m.Items.Add(mi); }
        Add("Dossier (Explorateur)", "folder"); Add("Terminal", "terminal"); Add("Éditeur", "editor");
        m.IsOpen = true;
    }
    async void OnAttach(object sender, RoutedEventArgs e)
    {
        if (Current is not { } it) return;
        var d = new Microsoft.Win32.OpenFileDialog { Title = "Joindre un fichier", Multiselect = true };
        if (d.ShowDialog(this) != true) return;
        // chemin(s) tapé(s) dans la saisie de Claude, entre guillemets : il lit le fichier lui-même
        await server.Input(it.Id, string.Join(" ", d.FileNames.Select(f => $"\"{f}\"")) + " ");
        (paneHosts[activePane].Content as TerminalControl)?.Focus();
    }
    void OnMore(object sender, RoutedEventArgs e)
    {
        if (Current is null) return;
        var m = BuildMenu(Current);
        m.PlacementTarget = BtnMore; m.Placement = PlacementMode.Bottom; m.IsOpen = true;
    }

    // Menu de la session (clic droit dans la liste, ⋯) : mêmes entrées que l'interface web
    ContextMenu BuildMenu(SessionItem it)
    {
        var menu = new ContextMenu();
        MenuItem Item(string h, Func<Task> a, bool enabled = true, string? kbd = null) { var m = new MenuItem { Header = h, IsEnabled = enabled, InputGestureText = kbd ?? "" }; m.Click += async (_, _) => await a(); return m; }
        menu.Items.Add(Item("Renommer…", () => Rename(it), kbd: "Ctrl+Alt+R"));
        menu.Items.Add(Item(it.Alive ? "Relancer" : "Reprendre", () => Post(it.Id, "restart")));
        menu.Items.Add(Item("Arrêter", () => Post(it.Id, "kill"), it.Alive));
        var open = new MenuItem { Header = "Ouvrir dans…" };
        foreach (var (h, t) in new[] { ("Dossier", "folder"), ("Terminal", "terminal"), ("Éditeur", "editor") }) open.Items.Add(Item(h, () => Post(it.Id, "open", new { target = t })));
        menu.Items.Add(open);
        menu.Items.Add(Item("Copier le chemin", () => { Clipboard.SetText(it.Cwd); return Task.CompletedTask; }));
        if ((string?)it.Data["claudeSessionId"] is { Length: > 0 } cid) menu.Items.Add(Item("Copier l’identifiant de session", () => { Clipboard.SetText(cid); return Task.CompletedTask; }));
        menu.Items.Add(new Separator());
        menu.Items.Add(Item("File d'attente…", () => { Dialogs.Queue(this, it); return Task.CompletedTask; }, kbd: "Ctrl+Alt+Q"));
        menu.Items.Add(Item("Enregistrer comme modèle…", () => Dialogs.SaveTemplate(this, it)));
        menu.Items.Add(Item("Déplacer vers le groupe…", async () =>
        {
            var g = Ui.Ask(this, "Groupe", "Groupe (« Parent/Enfant » pour un sous-groupe ; vide : sans groupe)", it.Group);
            if (g != null) await Meta(it.Id, new { group = g });
        }));
        menu.Items.Add(Item(it.Pinned ? "Désépingler" : "Épingler en haut", () => Meta(it.Id, new { pinned = !it.Pinned })));
        menu.Items.Add(Item(it.Locked ? "Verrouiller maintenant" : "Verrouiller par mot de passe…", () => Dialogs.Lock(this, it), kbd: "Ctrl+Alt+L"));
        menu.Items.Add(Item(it.Muted ? "Réactiver les alertes" : "Couper les alertes de cette session", () => Meta(it.Id, new { alerts = new { mute = !it.Muted } })));
        menu.Items.Add(Item(it.Remote ? "Désactiver l’accès depuis l’app Claude" : "Accès depuis l’app Claude (téléphone)", () => Post(it.Id, "remote", new { on = !it.Remote })));
        menu.Items.Add(new Separator());
        menu.Items.Add(Item("Mettre en pause", () => Pause(it), it.Alive));
        menu.Items.Add(Item("Mettre en veille", () => Post(it.Id, "sleep"), it.Alive && it.Status is not ("working" or "attention")));
        menu.Items.Add(Item(it.NoSleep ? "Autoriser la mise en veille" : "Ne jamais mettre en veille", () => Meta(it.Id, new { noSleep = !it.NoSleep })));
        menu.Items.Add(Item("Plafond de quota…", () => { Dialogs.QuotaStop(this, it); return Task.CompletedTask; }));
        menu.Items.Add(new Separator());
        menu.Items.Add(Item("Fermer", () => CloseSession(it), kbd: "Ctrl+Alt+W"));
        return menu;
    }
    void OnMenu(object sender, ContextMenuEventArgs e)
    {
        var src = e.OriginalSource as DependencyObject;
        while (src != null && src is not ListBoxItem) src = VisualTreeHelper.GetParent(src);
        if (src is not ListBoxItem li || li.DataContext is not SessionItem it) { e.Handled = true; return; }
        e.Handled = true;
        var m = BuildMenu(it);
        m.PlacementTarget = li; m.IsOpen = true;
    }

    // Écrans : chacun dans sa fenêtre (Windows/Dialogs.cs, Windows/*.cs)
    void OnPalette(object sender, RoutedEventArgs e) => new PaletteWindow(this).ShowDialog();
    void OnHistory(object sender, RoutedEventArgs e) => new HistoryWindow(this).ShowDialog();
    void OnPrompts(object sender, RoutedEventArgs e) => new PromptsWindow(this).ShowDialog();
    void OnVault(object sender, RoutedEventArgs e) => new VaultWindow(this).ShowDialog();
    void OnSettings(object sender, RoutedEventArgs e) => new SettingsWindow(this).ShowDialog();
    void OnChanges(object sender, RoutedEventArgs e) { if (Current is { } it) new SessionPanelWindow(this, it).Show(); }

    // Raccourcis de l'interface web
    async void OnKeys(object sender, KeyEventArgs e)
    {
        var mods = Keyboard.Modifiers;
        var ca = mods == (ModifierKeys.Control | ModifierKeys.Alt);
        var key = e.Key == Key.System ? e.SystemKey : e.Key;
        if (ca && key == Key.N) { e.Handled = true; await NewSession(); }
        else if (ca && key == Key.W && Current is { } c) { e.Handled = true; await CloseSession(c); }
        else if (ca && key == Key.R && Current is { } r) { e.Handled = true; await Rename(r); }
        else if (ca && key == Key.Q && Current is { } q) { e.Handled = true; Dialogs.Queue(this, q); }
        else if (ca && key == Key.L && Current is { } l) { e.Handled = true; await Dialogs.Lock(this, l); }
        else if (mods == ModifierKeys.Control && key == Key.K) { e.Handled = true; OnPalette(this, e); }
        else if (mods == ModifierKeys.Control && key == Key.H) { e.Handled = true; OnHistory(this, e); }
        else if (mods == ModifierKeys.Control && key == Key.OemComma) { e.Handled = true; OnSettings(this, e); }
    }
}
