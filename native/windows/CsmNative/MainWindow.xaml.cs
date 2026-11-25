using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Net.Http;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Data;
using System.Windows.Input;
using System.Windows.Media;
using Microsoft.Terminal.Wpf;

namespace CsmNative;

public partial class MainWindow : Window
{
    readonly CsmServer server = new();
    readonly ObservableCollection<SessionItem> items = [];
    readonly ICollectionView view;
    readonly Dictionary<string, (TerminalControl Term, SessionConnection Conn)> terms = [];
    readonly Dictionary<string, List<string>> early = []; // sortie reçue avant l'ouverture du terminal de la session
    readonly Tray tray;
    bool quitting;

    static readonly TerminalTheme Theme = new()
    {
        DefaultBackground = 0x1F1B1B, DefaultForeground = 0xEAE6E6, DefaultSelectionBackground = 0x5A4A44, CursorStyle = CursorStyle.BlinkingBar,
        // COLORREF (0x00BBGGRR) : palette proche de celle de l'app web
        ColorTable = [0x2E2E2E, 0x6B6BE0, 0x8BC26A, 0x7BC0E5, 0xE8A061, 0xC778C6, 0xC2B656, 0xE6E6E6,
                      0x75756B, 0x8080FF, 0xA0E08A, 0x9AD7F0, 0xFFB57A, 0xE69BE0, 0xDCD27A, 0xFFFFFF],
    };

    public MainWindow()
    {
        InitializeComponent();
        view = CollectionViewSource.GetDefaultView(items);
        view.GroupDescriptions.Add(new PropertyGroupDescription(nameof(SessionItem.GroupKey)));
        view.SortDescriptions.Add(new SortDescription(nameof(SessionItem.GroupKey), ListSortDirection.Ascending));
        view.SortDescriptions.Add(new SortDescription(nameof(SessionItem.Order), ListSortDirection.Ascending));
        view.Filter = o => Matches((SessionItem)o);
        if (view is ICollectionViewLiveShaping live && live.CanChangeLiveGrouping)
        {
            live.IsLiveGrouping = live.IsLiveSorting = true;
            live.LiveGroupingProperties.Add(nameof(SessionItem.GroupKey));
            live.LiveSortingProperties.Add(nameof(SessionItem.Order));
        }
        List.ItemsSource = view;
        tray = new Tray(this, () => { quitting = true; Close(); });
        Loaded += async (_, _) => await Start();
        Closing += (_, e) => { if (!quitting) { e.Cancel = true; Hide(); tray.Hint(); } }; // fermer la fenêtre : l'app reste dans la zone de notification
        Closed += async (_, _) => { tray.Dispose(); await server.DisposeAsync(); };
        PreviewKeyDown += OnKeys;
        UpdateToolbar();
    }

    SessionItem? Current => List.SelectedItem as SessionItem;
    IEnumerable<string> Groups => items.Select(i => i.Group).Where(g => g.Length > 0).Distinct().OrderBy(g => g);

    bool Matches(SessionItem it)
    {
        var q = Search?.Text.Trim() ?? "";
        return q.Length == 0 || $"{it.Name} {it.Cwd} {it.Group}".Contains(q, StringComparison.OrdinalIgnoreCase);
    }
    void OnSearch(object sender, TextChangedEventArgs e) => view.Refresh();

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
            StatusText.Text = $"Serveur CSM {server.Version} · port {server.Port}";
            await LoadQuota();
        }
        catch (Exception e) { StatusText.Text = e.Message; }
    }

    // ---------------------------------------------------------------- liste
    void SetList(JsonArray list)
    {
        var keep = Current?.Id;
        items.Clear();
        foreach (var n in list.OfType<JsonObject>()) items.Add(Make(n));
        Select(keep) ;
    }
    void Select(string? id) => List.SelectedItem = items.FirstOrDefault(i => i.Id == id) ?? view.Cast<SessionItem>().FirstOrDefault();
    static SessionItem Make(JsonObject o) { var it = new SessionItem { Id = (string?)o["id"] ?? "" }; it.Update(o); return it; }
    void Upsert(JsonObject s)
    {
        var id = (string?)s["id"] ?? "";
        var it = items.FirstOrDefault(i => i.Id == id);
        if (it == null) { items.Add(Make(s)); return; }
        var before = it.Status;
        it.Update(s);
        Notify(it, before);
        if (Current?.Id == id) ShowHeader();
    }
    void Remove(string id)
    {
        var it = items.FirstOrDefault(i => i.Id == id);
        var wasCurrent = Current?.Id == id;
        if (it != null) items.Remove(it);
        terms.Remove(id); early.Remove(id);
        if (wasCurrent || List.SelectedItem == null) Select(null);
        if (items.Count == 0) { TermHost.Content = null; ShowHeader(); }
    }

    // Notification système quand une session attend ta réponse ou a fini, si tu ne la regardes pas (alertes coupées : rien)
    void Notify(SessionItem it, string before)
    {
        if (it.Muted || before == it.Status) return;
        var looking = IsActive && Current?.Id == it.Id;
        if (looking) return;
        if (it.Status == "attention") tray.Toast(it.Name, it.Message.Length > 0 ? it.Message : "attend ta réponse", () => Reveal(it.Id));
        else if (it.Status == "idle" && before == "working") tray.Toast(it.Name, "a fini", () => Reveal(it.Id));
    }
    public void Reveal(string? id = null)
    {
        Show(); if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal; Activate();
        if (id != null) Select(id);
    }

    // ---------------------------------------------------------------- terminal
    void Feed(string id, string d, bool replay)
    {
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
        term.Loaded += (_, _) => term.SetTheme(Theme, "Cascadia Mono", 12, Color.FromRgb(0x1B, 0x1B, 0x1F));
        term.Connection = conn;
        terms[id] = (term, conn);
        return term;
    }

    void OnSelect(object sender, RoutedEventArgs e)
    {
        var it = Current;
        TermHost.Content = it == null ? null : TermFor(it.Id);
        if (TermHost.Content is TerminalControl tc) tc.Focus();
        // session affichée : jamais mise en veille, réveillée si elle dort (lib/sleep.js)
        _ = server.Shown(it == null ? [] : [it.Id]);
        ShowHeader();
    }

    void ShowHeader()
    {
        var it = Current;
        Title.Text = it?.Name ?? "Aucune session";
        Subtitle.Text = it == null ? "" : $"{it.Cwd} · {it.Detail}";
        UpdateToolbar();
    }
    void UpdateToolbar()
    {
        var it = Current;
        BtnRestart.IsEnabled = BtnClose.IsEnabled = it != null;
        BtnPause.IsEnabled = it?.Alive == true;
        BtnRestart.Content = it?.Alive == true ? "Relancer" : "Reprendre";
    }

    async Task LoadQuota()
    {
        try
        {
            var q = await server.Api(HttpMethod.Get, "/api/quota");
            string part(string label, JsonNode? n) => n?["pct"] is JsonNode p ? $"{label} : {Math.Round((double)p)} %" : "";
            QuotaText.Text = string.Join(" · ", new[] { part("Quota 5 h", q?["five"]), part("7 jours", q?["seven"]) }.Where(x => x.Length > 0));
        }
        catch { }
    }

    // ---------------------------------------------------------------- actions
    async Task Try(Func<Task> f)
    {
        try { await f(); } catch (Exception e) { StatusText.Text = e.Message; }
    }
    Task Post(string id, string action, object? body = null) => Try(() => server.Api(HttpMethod.Post, $"/api/sessions/{id}/{action}", body));
    Task Meta(string id, object body) => Post(id, "meta", body);

    async void OnNew(object sender, RoutedEventArgs e) => await NewSession();
    async Task NewSession(string? group = null)
    {
        var r = NewSessionDialog.Show(this, Groups, group ?? Current?.Group);
        if (r == null) return;
        await Try(async () =>
        {
            var s = await server.Api(HttpMethod.Post, "/api/sessions", new
            {
                cwd = r.Cwd, name = r.Name.Length > 0 ? r.Name : null, group = r.Group.Length > 0 ? r.Group : null,
                args = r.Args, initialPrompt = r.Prompt.Length > 0 ? r.Prompt : null,
            });
            if (s is JsonObject o) { Upsert(o); Select((string?)o["id"]); }
        });
    }
    async void OnRestart(object sender, RoutedEventArgs e) { if (Current is { } it) await Post(it.Id, "restart"); }
    async void OnPause(object sender, RoutedEventArgs e) { if (Current is { } it) await Pause(it); }
    async void OnClose(object sender, RoutedEventArgs e) { if (Current is { } it) await CloseSession(it); }

    async Task Pause(SessionItem it)
    {
        StatusText.Text = "Mise en pause… (mémoire et synchro)";
        await Try(async () => { await server.Api(HttpMethod.Post, $"/api/sessions/{it.Id}/pause"); StatusText.Text = "En pause"; });
    }
    // Fermer : retirée ici et sur les autres machines synchronisées ; la conversation reste dans l'Historique
    async Task CloseSession(SessionItem it)
    {
        if (it.Data["worktree"] is JsonObject)
        {
            MessageBox.Show(this, "Cette session travaille dans un worktree : ferme-la depuis l'app CSM (choix du worktree à porter en natif).", "Fermer", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        StatusText.Text = "Fermeture… (mémoire et synchro)";
        await Try(async () => { await server.Api(HttpMethod.Delete, $"/api/sessions/{it.Id}?here=1"); StatusText.Text = "Fermée"; });
    }
    async Task Rename(SessionItem it)
    {
        var n = Ui.Ask(this, "Renommer", "Nouveau nom", it.Name);
        if (n != null) await Post(it.Id, "rename", new { name = n });
    }

    // Menu clic droit : mêmes entrées que l'interface web (essentiel)
    void OnMenu(object sender, ContextMenuEventArgs e)
    {
        var src = (e.OriginalSource as DependencyObject);
        while (src != null && src is not ListBoxItem) src = VisualTreeHelper.GetParent(src);
        if (src is ListBoxItem li) li.IsSelected = true;
        var menu = List.ContextMenu!;
        menu.Items.Clear();
        if (Current is not { } it) { e.Handled = true; return; }
        MenuItem Item(string h, Func<Task> a, bool enabled = true) { var m = new MenuItem { Header = h, IsEnabled = enabled }; m.Click += async (_, _) => await a(); return m; }
        menu.Items.Add(Item("Renommer…", () => Rename(it)));
        menu.Items.Add(Item(it.Alive ? "Relancer" : "Reprendre", () => Post(it.Id, "restart")));
        menu.Items.Add(Item("Mettre en pause", () => Pause(it), it.Alive));
        menu.Items.Add(Item("Mettre en veille", () => Post(it.Id, "sleep"), it.Alive && it.Status is not ("working" or "attention")));
        menu.Items.Add(Item(it.NoSleep ? "Autoriser la mise en veille" : "Ne jamais mettre en veille", () => Meta(it.Id, new { noSleep = !it.NoSleep })));
        menu.Items.Add(new Separator());
        menu.Items.Add(Item(it.Pinned ? "Désépingler" : "Épingler en haut", () => Meta(it.Id, new { pinned = !it.Pinned })));
        menu.Items.Add(Item("Déplacer vers le groupe…", async () =>
        {
            var g = Ui.Ask(this, "Groupe", "Groupe (« Parent/Enfant » pour un sous-groupe ; vide : sans groupe)", it.Group);
            if (g != null) await Meta(it.Id, new { group = g });
        }));
        menu.Items.Add(Item("Nouvelle session dans ce groupe…", () => NewSession(it.Group)));
        menu.Items.Add(Item(it.Remote ? "Désactiver l'accès depuis l'app Claude" : "Accès depuis l'app Claude (Remote Control)", () => Post(it.Id, "remote", new { on = !it.Remote })));
        menu.Items.Add(Item(it.Muted ? "Réactiver les alertes" : "Couper les alertes de cette session", () => Meta(it.Id, new { alerts = new { mute = !it.Muted } })));
        menu.Items.Add(Item("Copier le chemin", () => { Clipboard.SetText(it.Cwd); return Task.CompletedTask; }));
        menu.Items.Add(new Separator());
        menu.Items.Add(Item("Arrêter", () => Post(it.Id, "kill"), it.Alive));
        menu.Items.Add(Item("Fermer", () => CloseSession(it)));
    }

    // Raccourcis de l'interface web : Ctrl+Alt+N nouvelle, Ctrl+Alt+W fermer, Ctrl+Alt+R renommer, Ctrl+K recherche
    async void OnKeys(object sender, KeyEventArgs e)
    {
        var ca = Keyboard.Modifiers == (ModifierKeys.Control | ModifierKeys.Alt);
        var key = e.Key == Key.System ? e.SystemKey : e.Key;
        if (ca && key == Key.N) { e.Handled = true; await NewSession(); }
        else if (ca && key == Key.W && Current is { } c) { e.Handled = true; await CloseSession(c); }
        else if (ca && key == Key.R && Current is { } r) { e.Handled = true; await Rename(r); }
        else if (Keyboard.Modifiers == ModifierKeys.Control && key == Key.K) { e.Handled = true; Search.Focus(); Search.SelectAll(); }
    }
}
