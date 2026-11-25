using System.Net.Http;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace CsmNative;

// ------------------------------------------------------------------ coffre : PAT, tokens de services, secrets
public sealed class VaultWindow : Screen
{
    readonly StackPanel list = new();
    readonly TextBlock sync = Ui.Hint("");
    readonly ComboBox kind = Ui.Combo(["PAT Azure DevOps", "Token d'un service (Turso, GitHub, Cloudflare…)", "Autre secret"]);
    readonly ComboBox service = new();
    readonly TextBox name = Ui.Box(), env = Ui.Box();
    readonly PasswordBox value = new();
    readonly StackPanel serviceRow = new() { Visibility = Visibility.Collapsed };
    JsonArray services = [];

    public VaultWindow(MainWindow owner) : base(owner, "Coffre", 860, 820)
    {
        var form = new StackPanel();
        form.Children.Add(new TextBlock { Text = "Ajouter", FontWeight = FontWeights.SemiBold });
        form.Children.Add(Ui.Label("Type")); form.Children.Add(kind);
        serviceRow.Children.Add(Ui.Label("Service")); serviceRow.Children.Add(service); form.Children.Add(serviceRow);
        form.Children.Add(Ui.Label("Nom")); form.Children.Add(name);
        form.Children.Add(Ui.Label("Valeur")); form.Children.Add(value);
        form.Children.Add(Ui.Label("Variable d'environnement donnée aux sessions")); form.Children.Add(env);
        form.Children.Add(Ui.Hint("Les sessions de l'app (et, sous Windows, les nouveaux terminaux) la reçoivent : Claude et les outils du service (CLI, SDK) l'utilisent sans la voir écrite nulle part. Sans variable, le secret reste seulement copiable."));
        var add = Ui.Btn("Ajouter au coffre", async (_, _) => await Add(), "Primary"); add.HorizontalAlignment = HorizontalAlignment.Right; form.Children.Add(add);
        env.FontFamily = (FontFamily)FindResource("MonoFont");
        kind.SelectionChanged += (_, _) => { serviceRow.Visibility = kind.SelectedIndex == 1 ? Visibility.Visible : Visibility.Collapsed; if (kind.SelectedIndex == 1) Pick(); };
        service.SelectionChanged += (_, _) => Pick();
        var body = Ui.Body(Ui.H2("Coffre"),
            Ui.Hint("PAT Azure DevOps, tokens de services (Turso, GitHub, Cloudflare, OpenAI…) et autres secrets, gardés par le système (trousseau macOS, chiffrement Windows) et donnés aux sessions de l'app. Pour un dépôt Azure DevOps, le PAT qui marche pour son organisation est choisi tout seul. Les valeurs ne sont jamais réaffichées."),
            sync, list, Card(form, 16));
        Content = new ScrollViewer { Content = body, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        Loaded += async (_, _) => await Load();
    }
    void Pick()
    {
        if (service.SelectedIndex < 0) return;
        if (service.SelectedIndex >= services.Count) { env.Clear(); env.Focus(); return; }
        var s = services[service.SelectedIndex] as JsonArray;
        name.Text = (string?)s?[0] ?? ""; env.Text = (string?)s?[1] ?? "";
    }
    async Task Load()
    {
        try
        {
            var d = await main.server.Api(HttpMethod.Get, "/api/vault");
            sync.Text = (bool?)d?["sync"] == true ? "Partagé chiffré entre tes machines (synchro)." : "Sur cette machine seulement (sans synchro, ou partage du coffre coupé).";
            services = d?["services"] as JsonArray ?? [];
            if (service.Items.Count == 0) service.ItemsSource = services.Select(s => $"{(string?)s?[0]} · {(string?)s?[1]}").Append("Autre service…").ToList();
            list.Children.Clear();
            foreach (var it in (d?["items"] as JsonArray ?? []).OfType<JsonObject>())
            {
                var id = (string?)it["id"];
                var kindLabel = (string?)it["kind"] == "azure-pat" ? "PAT Azure DevOps" : "Secret";
                var target = (string?)it["targets"]?["env"] is { Length: > 0 } e ? $"variable {e}" : "";
                var sp = new StackPanel();
                sp.Children.Add(new TextBlock { Text = ((bool?)it["isDefault"] == true ? "★ " : "") + (string?)it["name"], FontWeight = FontWeights.SemiBold });
                sp.Children.Add(new TextBlock { Text = string.Join(" · ", new[] { kindLabel, target, (string?)it["origin"] }.Where(x => !string.IsNullOrEmpty(x))), Foreground = Ui.R("Muted"), FontSize = 12 });
                if ((bool?)it["pendingTargets"] == true) sp.Children.Add(Ui.Row(Ui.Hint("Reçu avec une cible à poser sur cette machine : pas posée sans ton accord. "), Ui.Btn("Utiliser ici aussi", async (_, _) => { await main.Try(() => main.server.Api(HttpMethod.Patch, $"/api/vault/{id}", new { applyTargets = true })); await Load(); })));
                var copy = Ui.Btn("Copier", async (_, _) =>
                {
                    if (MessageBox.Show(this, $"Copier la valeur de « {it["name"]} » dans le presse-papiers ?", "Coffre", MessageBoxButton.YesNo) != MessageBoxResult.Yes) return;
                    await main.Try(async () => { Clipboard.SetText((string?)(await main.server.Api(HttpMethod.Post, $"/api/vault/{id}/reveal"))?["value"] ?? ""); });
                });
                var repl = Ui.Btn("Remplacer", async (_, _) =>
                {
                    var v = Ui.Ask(this, "Remplacer", $"Nouvelle valeur pour « {it["name"]} »");
                    if (v != null) { await main.Try(() => main.server.Api(HttpMethod.Patch, $"/api/vault/{id}", new { value = v, overwrite = true })); await Load(); }
                });
                var del = Ui.Btn("Supprimer", async (_, _) =>
                {
                    if (MessageBox.Show(this, $"Supprimer « {it["name"]} » du coffre, ici et sur tes autres machines ?", "Coffre", MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes) return;
                    await main.Try(() => main.server.Api(HttpMethod.Delete, $"/api/vault/{id}")); await Load();
                }, "Danger");
                var right = Ui.Row(copy, repl, del);
                if ((string?)it["kind"] == "azure-pat")
                {
                    right.Children.Insert(0, Ui.Btn("Vérifier", async (_, _) => await main.Try(async () => { var r = await main.server.Api(HttpMethod.Post, $"/api/vault/{id}/check", new { }); MessageBox.Show(this, (r?["results"] as JsonObject)?.Select(kv => $"{kv.Key} : {((string?)kv.Value == "ok" ? "accepté" : (string?)kv.Value == "refused" ? "refusé" : "injoignable")}").DefaultIfEmpty("Aucune organisation connue : ouvre une session dans un dépôt Azure DevOps.").Aggregate((a, b) => a + "\n" + b), "Vérifier"); })));
                    if ((bool?)it["isDefault"] != true) right.Children.Insert(1, Ui.Btn("Par défaut", async (_, _) => { await main.Try(() => main.server.Api(HttpMethod.Patch, $"/api/vault/{id}", new { isDefault = true })); await Load(); }));
                }
                var row = new DockPanel(); DockPanel.SetDock(right, Dock.Right); row.Children.Add(right); row.Children.Add(sp);
                list.Children.Add(Card(row));
            }
            if (list.Children.Count == 0) list.Children.Add(Ui.Hint("Le coffre est vide."));
        }
        catch (Exception e) { sync.Text = e.Message; }
    }
    async Task Add()
    {
        var body = new { name = name.Text, kind = kind.SelectedIndex == 0 ? "azure-pat" : "secret", value = value.Password, targets = new { env = env.Text.Trim(), keychain = "" } };
        try { await main.server.Api(HttpMethod.Post, "/api/vault", body); }
        catch (Exception e) when (e.Message.Contains("déjà une autre valeur"))
        {
            if (MessageBox.Show(this, "Cette cible (trousseau ou variable) contient déjà une autre valeur, posée par un autre outil. La remplacer ?", "Coffre", MessageBoxButton.YesNo) != MessageBoxResult.Yes) return;
            await main.Try(() => main.server.Api(HttpMethod.Post, "/api/vault", new { body.name, body.kind, body.value, body.targets, overwrite = true }));
        }
        catch (Exception e) { MessageBox.Show(this, e.Message, "Coffre"); return; }
        value.Clear(); name.Clear(); env.Clear();
        await Load();
    }
}

// ------------------------------------------------------------------ panneau de la session : Modifications, Chronologie, Consommation, Prompts, Mémoire
public sealed class SessionPanelWindow : Screen
{
    readonly SessionItem s;
    readonly TabControl tabs = new() { Background = Brushes.Transparent, BorderThickness = new Thickness(0) };
    readonly StackPanel files = new();
    readonly TextBox diff = new() { IsReadOnly = true, FontFamily = new FontFamily("Cascadia Mono, Consolas"), FontSize = 12, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Auto, TextWrapping = TextWrapping.NoWrap, AcceptsReturn = true };
    readonly TextBox msg = Ui.Box("", true, 2);
    readonly TextBlock info = Ui.Hint("Chargement…");

    public SessionPanelWindow(MainWindow owner, SessionItem session) : base(owner, $"{session.Name} — Modifications", 760, 860)
    {
        s = session; ShowInTaskbar = true;
        var refresh = Ui.Btn("Actualiser", async (_, _) => await LoadGit());
        var commit = Ui.Btn("Committer tout", async (_, _) => await Commit(), "Primary");
        var head = new DockPanel(); DockPanel.SetDock(refresh, Dock.Right); head.Children.Add(refresh); head.Children.Add(info);
        var commitRow = new DockPanel { Margin = new Thickness(0, 8, 0, 0) }; DockPanel.SetDock(commit, Dock.Right); commitRow.Children.Add(commit); msg.Margin = new Thickness(0, 0, 8, 0); msg.ToolTip = "Message du commit"; commitRow.Children.Add(msg);
        var changes = new DockPanel { Margin = new Thickness(0, 10, 0, 0) };
        DockPanel.SetDock(head, Dock.Top); changes.Children.Add(head);
        var filesScroll = new ScrollViewer { Content = files, MaxHeight = 220, VerticalScrollBarVisibility = ScrollBarVisibility.Auto }; DockPanel.SetDock(filesScroll, Dock.Top); changes.Children.Add(filesScroll);
        DockPanel.SetDock(commitRow, Dock.Bottom); changes.Children.Add(commitRow);
        diff.Margin = new Thickness(0, 8, 0, 0); diff.Text = "Cliquer un fichier pour voir le diff."; changes.Children.Add(diff);
        tabs.Items.Add(new TabItem { Header = "Modifications", Content = changes });
        foreach (var (h, path) in new[] { ("Chronologie", "timeline"), ("Consommation", "usage"), ("Prompts", "prompts") }) tabs.Items.Add(new TabItem { Header = h, Content = JsonView($"/api/sessions/{s.Id}/{path}") });
        tabs.Items.Add(new TabItem { Header = "Mémoire", Content = JsonView((string?)s.Data["claudeSessionId"] is { Length: > 0 } cid ? $"/api/memory/ai/session/{cid}" : null) });
        Content = new Border { Padding = new Thickness(16), Child = tabs };
        Loaded += async (_, _) => await LoadGit();
    }
    UIElement JsonView(string? path)
    {
        var box = new TextBox { IsReadOnly = true, TextWrapping = TextWrapping.Wrap, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, FontSize = 12, Text = path == null ? "Pas encore de conversation dans cette session." : "Chargement…", Margin = new Thickness(0, 10, 0, 0) };
        if (path != null) box.Loaded += async (_, _) => { try { box.Text = Readable(await main.server.Api(HttpMethod.Get, path)); } catch (Exception e) { box.Text = e.Message; } };
        return box;
    }
    static string Readable(JsonNode? n, int depth = 0)
    {
        var pad = new string(' ', depth * 2);
        return n switch
        {
            JsonArray a => string.Join("\n", a.Select(x => Readable(x, depth))),
            JsonObject o => string.Join("\n", o.Select(kv => kv.Value is JsonObject or JsonArray ? $"{pad}{kv.Key} :\n{Readable(kv.Value, depth + 1)}" : $"{pad}{kv.Key} : {kv.Value}")),
            _ => pad + n?.ToString(),
        };
    }
    async Task LoadGit()
    {
        try
        {
            var g = await main.server.Api(HttpMethod.Get, $"/api/sessions/{s.Id}/git");
            files.Children.Clear();
            if ((bool?)g?["repo"] != true) { info.Text = "Le dossier de cette session n’est pas un dépôt git."; return; }
            var wt = g?["worktree"] as JsonObject;
            info.Text = $"{(wt != null ? "Worktree dédié · " : "")}{(string?)g?["branch"]}{(wt != null ? $" · base {(string?)wt["base"]}" : "")}";
            if (wt != null) files.Children.Add(Ui.Btn($"Fusionner dans {(string?)wt["base"]}", async (_, _) => { await main.Try(() => main.server.Api(HttpMethod.Post, $"/api/sessions/{s.Id}/worktree/merge")); await LoadGit(); }));
            var list = g?["files"] as JsonArray ?? [];
            if (list.Count == 0) files.Children.Add(Ui.Hint("Aucune modification dans ce dossier."));
            foreach (var f in list.OfType<JsonObject>())
            {
                var path = (string?)f["path"] ?? "";
                var state = (string?)f["state"] ?? "";
                var col = state switch { "nouveau" or "ajouté" => Ui.R("Ok"), "supprimé" => Ui.R("Warn"), _ => Ui.R("Work") };
                var label = new TextBlock { Text = $"{state[0..1].ToUpperInvariant()}  {path}", Foreground = col, FontFamily = new FontFamily("Cascadia Mono, Consolas"), FontSize = 12, VerticalAlignment = VerticalAlignment.Center, TextTrimming = TextTrimming.CharacterEllipsis };
                var undo = Ui.Btn("↺", async (_, _) =>
                {
                    if (MessageBox.Show(this, $"Annuler toutes les modifications de {path} ?{(state == "nouveau" ? " Le fichier (non suivi) sera supprimé." : "")}", "Modifications", MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes) return;
                    await main.Try(() => main.server.Api(HttpMethod.Post, $"/api/sessions/{s.Id}/git/discard", new { paths = new[] { path } })); await LoadGit();
                }, "Ghost");
                undo.ToolTip = "Annuler les modifications de ce fichier";
                var row = new DockPanel { Margin = new Thickness(0, 2, 0, 0), Cursor = System.Windows.Input.Cursors.Hand, Background = Brushes.Transparent };
                DockPanel.SetDock(undo, Dock.Right); row.Children.Add(undo); row.Children.Add(label);
                row.MouseLeftButtonUp += async (_, _) => { try { diff.Text = (string?)(await main.server.Api(HttpMethod.Get, $"/api/sessions/{s.Id}/git/diff?path={Uri.EscapeDataString(path)}"))?["diff"] is { Length: > 0 } d ? d : "(fichier binaire ou vide)"; } catch (Exception e) { diff.Text = e.Message; } };
                files.Children.Add(row);
            }
        }
        catch (Exception e) { info.Text = e.Message; }
    }
    async Task Commit()
    {
        if (msg.Text.Trim().Length == 0) { msg.Focus(); return; }
        await main.Try(async () =>
        {
            await main.server.Api(HttpMethod.Post, $"/api/sessions/{s.Id}/git/stage", new { paths = Array.Empty<string>() });
            await main.server.Api(HttpMethod.Post, $"/api/sessions/{s.Id}/git/commit", new { message = msg.Text.Trim() });
            msg.Clear(); info.Text = "Commit créé";
        });
        await LoadGit();
    }
}
