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

    readonly Border syncBadge = new() { CornerRadius = new CornerRadius(999), Padding = new Thickness(8, 2, 8, 2), VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(10, 0, 0, 0) };
    readonly TextBlock syncText = new() { FontSize = 12 };
    readonly Border nameBox;

    // Maquette « Vault » : en-tête avec pastille de partage, lignes à pastille-lettre, formulaire « Ajouter » en deux colonnes
    public VaultWindow(MainWindow owner) : base(owner, "Coffre", 860, 820)
    {
        sync.Visibility = Visibility.Collapsed;
        value.Height = 34; env.Height = 34; env.FontSize = 12; env.SetResourceReference(Control.FontFamilyProperty, "MonoFont"); name.Height = 34; kind.Height = 34; service.Height = 34;
        foreach (var c in new Control[] { value, env, name, kind, service }) c.Padding = c is ComboBox ? c.Padding : new Thickness(10, 0, 10, 0);
        syncBadge.Child = syncText;
        var title = new TextBlock { Text = "Coffre", FontSize = 17, FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center };
        var close = new Button { Content = new TextBlock { Text = "\uE711", FontFamily = PaletteWindow.Icons, FontSize = 12 }, Width = 30, Height = 30, Padding = new Thickness(0), Style = Ui.S("Ghost"), ToolTip = "Fermer" };
        close.Click += (_, _) => SafeClose();
        var head = new DockPanel(); DockPanel.SetDock(close, Dock.Right); head.Children.Add(close);
        head.Children.Add(Ui.Row(title, syncBadge));
        var headBand = new Border { Padding = new Thickness(22, 18, 22, 18), BorderThickness = new Thickness(0, 0, 0, 1), Child = head };
        headBand.SetResourceReference(Border.BorderBrushProperty, "Line");

        // formulaire : Type | Service (ou Nom) ; Valeur | Variable
        var grid = new Grid(); grid.ColumnDefinitions.Add(new ColumnDefinition()); grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(14) }); grid.ColumnDefinitions.Add(new ColumnDefinition());
        for (var i = 0; i < 4; i++) grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        StackPanel F(string l, UIElement c, int row, int col, int span = 1) { var f = new StackPanel { Margin = new Thickness(0, row == 0 ? 0 : 12, 0, 0) }; f.Children.Add(Ui.Label(l, 6)); f.Children.Add(c); Grid.SetRow(f, row); Grid.SetColumn(f, col); Grid.SetColumnSpan(f, span); grid.Children.Add(f); return f; }
        var ttl = new TextBlock { Text = "Ajouter", FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 0, 0, 12) };
        serviceRow.Children.Add(Ui.Label("Service", 6)); serviceRow.Children.Add(service);
        var nameF = new StackPanel(); nameF.Children.Add(Ui.Label("Nom", 6)); nameF.Children.Add(name);
        var slot = new Grid(); slot.Children.Add(serviceRow); slot.Children.Add(nameF);
        Grid.SetRow(slot, 0); Grid.SetColumn(slot, 2); grid.Children.Add(slot);
        F("Type", kind, 0, 0); F("Valeur", value, 1, 0); F("Variable donnée aux sessions", env, 1, 2);
        var hint = Ui.Hint("Les sessions de l'app (et, sous Windows, les nouveaux terminaux) la reçoivent : Claude et les outils du service (CLI, SDK) l'utilisent sans la voir écrite nulle part. Sans variable, le secret reste seulement copiable.");
        hint.Margin = new Thickness(0, 10, 0, 0); Grid.SetRow(hint, 2); Grid.SetColumnSpan(hint, 3); grid.Children.Add(hint);
        var add = Ui.Btn("Ajouter au coffre", async (_, _) => await Add(), "Primary"); add.Height = 36; add.Padding = new Thickness(18, 0, 18, 0); add.HorizontalAlignment = HorizontalAlignment.Right; add.Margin = new Thickness(0, 12, 0, 0);
        Grid.SetRow(add, 3); Grid.SetColumnSpan(add, 3); grid.Children.Add(add);
        var form = new StackPanel(); form.Children.Add(ttl); form.Children.Add(grid);
        var formCard = new Border { CornerRadius = new CornerRadius(12), BorderThickness = new Thickness(1), Padding = new Thickness(16), Margin = new Thickness(22, 8, 22, 22), Child = form };
        formCard.SetResourceReference(Border.BackgroundProperty, "Bar"); formCard.SetResourceReference(Border.BorderBrushProperty, "Line");
        nameBox = null!;
        void Vis() { var svc = kind.SelectedIndex == 1; serviceRow.Visibility = svc ? Visibility.Visible : Visibility.Collapsed; nameF.Visibility = !svc || service.SelectedIndex >= services.Count ? Visibility.Visible : Visibility.Collapsed; }
        Vis();
        kind.SelectionChanged += (_, _) => { Vis(); if (kind.SelectedIndex == 1) Pick(); };
        service.SelectionChanged += (_, _) => { Pick(); Vis(); };
        list.Margin = new Thickness(12, 8, 12, 0);
        var stack = new StackPanel(); stack.Children.Add(list); stack.Children.Add(formCard);
        var rootDock = new DockPanel(); DockPanel.SetDock(headBand, Dock.Top); rootDock.Children.Add(headBand);
        rootDock.Children.Add(new ScrollViewer { Content = stack, VerticalScrollBarVisibility = ScrollBarVisibility.Auto });
        Content = rootDock;
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
            var shared = (bool?)d?["sync"] == true;
            syncText.Text = shared ? "Partagé chiffré entre tes machines" : "Sur cette machine seulement (sans synchro, ou partage du coffre coupé)";
            syncBadge.SetResourceReference(Border.BackgroundProperty, shared ? "Bar" : "Bar");
            syncText.SetResourceReference(TextBlock.ForegroundProperty, shared ? "Ok" : "Muted");
            if (shared) { syncBadge.Background = Ui.R("Ok").Clone(); syncBadge.Background.Opacity = 0.14; }
            services = d?["services"] as JsonArray ?? [];
            if (service.Items.Count == 0) service.ItemsSource = services.Select(s => $"{(string?)s?[0]} · {(string?)s?[1]}").Append("Autre service…").ToList();
            list.Children.Clear();
            foreach (var it in (d?["items"] as JsonArray ?? []).OfType<JsonObject>())
            {
                var id = (string?)it["id"];
                var kindLabel = (string?)it["kind"] == "azure-pat" ? "PAT Azure DevOps" : "Secret";
                var target = (string?)it["targets"]?["env"] is { Length: > 0 } e ? $"variable {e}" : "";
                var sp = new StackPanel();
                var nm = (bool?)it["isDefault"] == true ? "★ " + (string?)it["name"] : (string?)it["name"];
                sp.Children.Add(new TextBlock { Text = nm, FontWeight = FontWeights.SemiBold, TextTrimming = TextTrimming.CharacterEllipsis });
                var sub = new TextBlock { FontSize = 12, Margin = new Thickness(0, 3, 0, 0), TextTrimming = TextTrimming.CharacterEllipsis }; sub.SetResourceReference(TextBlock.ForegroundProperty, "Muted");
                var envName = (string?)it["targets"]?["env"] ?? "";
                if (envName.Length > 0) { var r1 = new System.Windows.Documents.Run(envName); r1.SetResourceReference(System.Windows.Documents.TextElement.FontFamilyProperty, "MonoFont"); sub.Inlines.Add(r1); }
                sub.Inlines.Add(new System.Windows.Documents.Run((envName.Length > 0 ? " · " : "") + string.Join(" · ", new[] { kindLabel, (string?)it["origin"] }.Where(x => !string.IsNullOrEmpty(x)))));
                sp.Children.Add(sub);
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
                var del = Ui.Btn("", async (_, _) =>
                {
                    if (MessageBox.Show(this, $"Supprimer « {it["name"]} » du coffre, ici et sur tes autres machines ?", "Coffre", MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes) return;
                    await main.Try(() => main.server.Api(HttpMethod.Delete, $"/api/vault/{id}")); await Load();
                }, "Danger");
                del.Content = new TextBlock { Text = "\uE711", FontFamily = PaletteWindow.Icons, FontSize = 12 }; del.Width = 30; del.Padding = new Thickness(0); del.ToolTip = "Supprimer";
                foreach (var bt in new[] { copy, repl, del }) { bt.Height = 30; bt.Margin = new Thickness(8, 0, 0, 0); if (bt != del) bt.Padding = new Thickness(12, 0, 12, 0); }
                var right = Ui.Row(copy, repl, del);
                if ((string?)it["kind"] == "azure-pat")
                {
                    var ver = Ui.Btn("Vérifier", async (_, _) => await main.Try(async () => { var r = await main.server.Api(HttpMethod.Post, $"/api/vault/{id}/check", new { }); MessageBox.Show(this, (r?["results"] as JsonObject)?.Select(kv => $"{kv.Key} : {((string?)kv.Value == "ok" ? "accepté" : (string?)kv.Value == "refused" ? "refusé" : "injoignable")}").DefaultIfEmpty("Aucune organisation connue : ouvre une session dans un dépôt Azure DevOps.").Aggregate((a, b) => a + "\n" + b), "Vérifier"); }));
                    ver.Height = 30; ver.Padding = new Thickness(12, 0, 12, 0); right.Children.Insert(0, ver);
                    if ((bool?)it["isDefault"] != true) { var def = Ui.Btn("Par défaut", async (_, _) => { await main.Try(() => main.server.Api(HttpMethod.Patch, $"/api/vault/{id}", new { isDefault = true })); await Load(); }); def.Height = 30; def.Padding = new Thickness(12, 0, 12, 0); right.Children.Insert(1, def); }
                }
                var letter = new TextBlock { Text = ((string?)it["name"] ?? "?").TrimStart('★', ' ').Substring(0, 1).ToUpperInvariant(), FontWeight = FontWeights.Bold, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
                letter.SetResourceReference(TextBlock.ForegroundProperty, "Branch");
                var av = new Border { Width = 34, Height = 34, CornerRadius = new CornerRadius(8), Child = letter, Margin = new Thickness(0, 0, 14, 0), VerticalAlignment = VerticalAlignment.Center };
                av.SetResourceReference(Border.BackgroundProperty, "Panel2");
                var row = new DockPanel(); DockPanel.SetDock(right, Dock.Right); right.VerticalAlignment = VerticalAlignment.Center; DockPanel.SetDock(av, Dock.Left); row.Children.Add(right); row.Children.Add(av); sp.VerticalAlignment = VerticalAlignment.Center; row.Children.Add(sp);
                var rowBox = new Border { Padding = new Thickness(10, 12, 10, 12), BorderThickness = new Thickness(0, 0, 0, 1), Child = row }; rowBox.SetResourceReference(Border.BorderBrushProperty, "Hover");
                list.Children.Add(rowBox);
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
    readonly TabControl tabs = new() { Background = Brushes.Transparent, BorderThickness = new Thickness(0), Padding = new Thickness(0) };
    readonly StackPanel files = new();
    readonly DiffView diff = new();
    readonly TextBox msg = Ui.Box("", true, 2);
    readonly TextBlock info = new();
    string? openPath;

    // Maquette « Changes » : bandeau (session, branche), onglets Modifications / Chronologie / Consommation / Prompts / Mémoire,
    // fichiers avec lettre d'état, diff coloré, message de commit
    public SessionPanelWindow(MainWindow owner, SessionItem session) : base(owner, $"{session.Name} — Modifications", 760, 860)
    {
        s = session; ShowInTaskbar = true; this.SetResourceReference(BackgroundProperty, "Bg");
        info.FontSize = 12; info.FontFamily = (FontFamily)Application.Current.FindResource("MonoFont"); info.SetResourceReference(TextBlock.ForegroundProperty, "Branch"); info.VerticalAlignment = VerticalAlignment.Center;
        var chip = new Border { CornerRadius = new CornerRadius(4), Padding = new Thickness(7, 2, 7, 2), Margin = new Thickness(12, 0, 0, 0), Child = info, VerticalAlignment = VerticalAlignment.Center };
        chip.SetResourceReference(Border.BackgroundProperty, "AccentSoft");
        var name = new TextBlock { Text = session.Name, FontSize = 15, FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center };
        var refresh = Ui.Btn("Actualiser", async (_, _) => await LoadGit()); refresh.Height = 30; refresh.Margin = new Thickness(0);
        var bar = new DockPanel(); DockPanel.SetDock(refresh, Dock.Right); bar.Children.Add(refresh); bar.Children.Add(Ui.Row(name, chip));
        var band = Ui.Band(bar, 16, 12); band.SetResourceReference(Border.BackgroundProperty, "Panel");
        var commit = Ui.Btn("Committer tout", async (_, _) => await Commit(), "Primary"); commit.Height = 34; commit.Margin = new Thickness(0);
        msg.ToolTip = "Message du commit"; msg.Height = 50; msg.Padding = new Thickness(10, 8, 10, 8);
        var commitRow = new StackPanel { Margin = new Thickness(0, 12, 0, 0) }; commitRow.Children.Add(msg);
        commit.HorizontalAlignment = HorizontalAlignment.Right; commit.Margin = new Thickness(0, 8, 0, 0); commitRow.Children.Add(commit);
        var changes = new DockPanel { Margin = new Thickness(0, 12, 0, 0) };
        DockPanel.SetDock(commitRow, Dock.Bottom); changes.Children.Add(commitRow);
        var filesScroll = new ScrollViewer { Content = files, MaxHeight = 220, VerticalScrollBarVisibility = ScrollBarVisibility.Auto }; DockPanel.SetDock(filesScroll, Dock.Top); changes.Children.Add(filesScroll);
        diff.Margin = new Thickness(0, 10, 0, 0); diff.Text = "Cliquer un fichier pour voir le diff."; changes.Children.Add(diff);
        tabs.Items.Add(new TabItem { Header = "Modifications", Content = changes });
        foreach (var (h, path) in new[] { ("Chronologie", "timeline"), ("Consommation", "usage"), ("Prompts", "prompts") }) tabs.Items.Add(new TabItem { Header = h, Content = JsonView($"/api/sessions/{s.Id}/{path}") });
        tabs.Items.Add(new TabItem { Header = "Mémoire", Content = JsonView((string?)s.Data["claudeSessionId"] is { Length: > 0 } cid ? $"/api/memory/ai/session/{cid}" : null) });
        tabs.Template = (ControlTemplate)Application.Current.FindResource("PanelTabs");
        foreach (TabItem ti in tabs.Items) ti.Style = Ui.S("PanelTab");
        var root = new DockPanel(); DockPanel.SetDock(band, Dock.Top); root.Children.Add(band);
        root.Children.Add(new Border { Padding = new Thickness(14, 12, 14, 14), Child = tabs });
        Content = root;
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
            if ((bool?)g?["repo"] != true) { info.Text = "pas un dépôt git"; return; }
            var wt = g?["worktree"] as JsonObject;
            info.Text = $"{(string?)g?["branch"]}{(wt != null ? $" · worktree dédié, base {(string?)wt["base"]}" : "")}";
            if (wt != null) files.Children.Add(Ui.Btn($"Fusionner dans {(string?)wt["base"]}", async (_, _) => { await main.Try(() => main.server.Api(HttpMethod.Post, $"/api/sessions/{s.Id}/worktree/merge")); await LoadGit(); }));
            var list = g?["files"] as JsonArray ?? [];
            if (list.Count == 0) files.Children.Add(Ui.Hint("Aucune modification dans ce dossier."));
            foreach (var f in list.OfType<JsonObject>())
            {
                var path = (string?)f["path"] ?? "";
                var state = (string?)f["state"] ?? "";
                var col = state switch { "nouveau" or "ajouté" => "Ok", "supprimé" => "Warn", _ => "Work" };
                var letter = new TextBlock { Text = state.Length > 0 ? (state is "nouveau" or "ajouté" ? "A" : state == "supprimé" ? "D" : state == "renommé" ? "R" : "M") : "?", FontWeight = FontWeights.Bold, FontSize = 12, Width = 24, VerticalAlignment = VerticalAlignment.Center };
                letter.SetResourceReference(TextBlock.ForegroundProperty, col); letter.SetResourceReference(TextBlock.FontFamilyProperty, "MonoFont");
                var label = new TextBlock { Text = path, FontSize = 12, VerticalAlignment = VerticalAlignment.Center, TextTrimming = TextTrimming.CharacterEllipsis };
                label.SetResourceReference(TextBlock.ForegroundProperty, "Fg"); label.SetResourceReference(TextBlock.FontFamilyProperty, "MonoFont");
                var undo = Ui.Btn("", async (_, _) =>
                {
                    if (MessageBox.Show(this, $"Annuler toutes les modifications de {path} ?{(state == "nouveau" ? " Le fichier (non suivi) sera supprimé." : "")}", "Modifications", MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes) return;
                    await main.Try(() => main.server.Api(HttpMethod.Post, $"/api/sessions/{s.Id}/git/discard", new { paths = new[] { path } })); await LoadGit();
                }, "Ghost");
                undo.Content = new TextBlock { Text = "\uE777", FontFamily = PaletteWindow.Icons, FontSize = 12 }; undo.Width = 28; undo.Height = 28; undo.Padding = new Thickness(0); undo.Margin = new Thickness(0);
                undo.ToolTip = "Annuler les modifications de ce fichier";
                var rowIn = new DockPanel(); DockPanel.SetDock(undo, Dock.Right); rowIn.Children.Add(undo); DockPanel.SetDock(letter, Dock.Left); rowIn.Children.Add(letter); rowIn.Children.Add(label);
                var row = new Border { Padding = new Thickness(8, 5, 6, 5), CornerRadius = new CornerRadius(7), Cursor = System.Windows.Input.Cursors.Hand, Background = Brushes.Transparent, Child = rowIn, Margin = new Thickness(0, 1, 0, 0) };
                if (openPath == path) row.SetResourceReference(Border.BackgroundProperty, "Sel");
                row.MouseLeftButtonUp += async (_, _) => { openPath = path; try { diff.Text = (string?)(await main.server.Api(HttpMethod.Get, $"/api/sessions/{s.Id}/git/diff?path={Uri.EscapeDataString(path)}"))?["diff"] is { Length: > 0 } d ? d : "(fichier binaire ou vide)"; } catch (Exception e) { diff.Text = e.Message; } foreach (var c in files.Children.OfType<Border>()) c.Background = Brushes.Transparent; row.SetResourceReference(Border.BackgroundProperty, "Sel"); };
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

// diff coloré : lignes ajoutées en vert, supprimées en rouge, en-têtes @@ en gris
public sealed class DiffView : Border
{
    readonly StackPanel lines = new();
    public DiffView()
    {
        BorderThickness = new Thickness(1); CornerRadius = new CornerRadius(8); SetResourceReference(BackgroundProperty, "Term"); SetResourceReference(BorderBrushProperty, "Line");
        Child = new ScrollViewer { Content = lines, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Auto };
    }
    public string Text
    {
        set
        {
            lines.Children.Clear();
            foreach (var l in value.Replace("\r", "").Split('\n').Take(3000))
            {
                var t = new TextBlock { Text = l.Length == 0 ? " " : l, FontSize = 12, Padding = new Thickness(10, 1, 10, 1) };
                t.SetResourceReference(TextBlock.FontFamilyProperty, "MonoFont");
                string fg = "Fg"; string? bg = null;
                if (l.StartsWith("@@")) fg = "Dim2"; else if (l.StartsWith("+") && !l.StartsWith("+++")) { bg = "Ok"; } else if (l.StartsWith("-") && !l.StartsWith("---")) { bg = "Warn"; } else if (l.StartsWith("diff ") || l.StartsWith("index ") || l.StartsWith("---") || l.StartsWith("+++")) fg = "Muted";
                t.SetResourceReference(TextBlock.ForegroundProperty, fg);
                if (bg != null) { var c = Theme.C(bg); t.Background = new SolidColorBrush(Color.FromArgb(0x22, c.R, c.G, c.B)); }
                lines.Children.Add(t);
            }
        }
    }
}
