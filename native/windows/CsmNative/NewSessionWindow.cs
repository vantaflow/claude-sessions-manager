using System.IO;
using System.Net.Http;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Media;

namespace CsmNative;

// Nouvelle session : mêmes champs que l'interface web (dlgNew).
public sealed class NewSessionWindow : Window
{
    static readonly string[] Models = ["opus", "sonnet", "haiku", ""];
    static readonly string[] ModelLabels = ["Opus", "Sonnet", "Haiku", "Défaut"];
    static readonly string[] Modes = ["", "acceptEdits", "plan", "bypassPermissions"];
    static readonly string[] ModeLabels = ["par défaut", "acceptEdits", "plan", "bypassPermissions"];
    static readonly string[] Seuils = ["", "50", "60", "70", "80", "85", "90", "95", "99"];

    public JsonNode? Result { get; private set; }
    readonly MainWindow main;
    readonly ComboBox tpl = new() { MinWidth = 200 }, group, model, mode, q5, q7;
    readonly TextBox cwd = Ui.Box(), name = Ui.Box(), prompt = Ui.Box("", true, 3), extra = Ui.Box(), branch = Ui.Box();
    readonly CheckBox worktree = new() { Content = "Travailler dans un worktree git dédié (nouvelle branche, sans toucher au dépôt principal)" };
    readonly CheckBox remote = new() { Content = "Accessible depuis l'app Claude (téléphone) et claude.ai/code — Remote Control de Claude Code" };
    readonly CheckBox lockpw = new() { Content = "Verrouiller par mot de passe" };
    readonly CheckBox qResume = new() { Content = "reprise automatique", Margin = new Thickness(12, 0, 0, 0) };
    readonly StackPanel wtBox = new() { Visibility = Visibility.Collapsed, Margin = new Thickness(24, 4, 0, 0) };
    readonly TextBlock wtInfo = Ui.Hint("");
    readonly TextBlock namePh = new();
    readonly WrapPanel recent = new() { Margin = new Thickness(0, 6, 0, 0) };
    JsonArray templates = [];
    string type = "";

    public NewSessionWindow(MainWindow owner, string? defaultGroup)
    {
        main = owner;
        Owner = owner; Title = "Nouvelle session"; Width = 720; SizeToContent = SizeToContent.Height; ResizeMode = ResizeMode.NoResize;
        WindowStartupLocation = WindowStartupLocation.CenterOwner; Background = Ui.R("Panel"); Foreground = Ui.R("Fg"); ShowInTaskbar = false;
        group = Ui.Combo(owner.Groups.Prepend(""), 0, true); group.Text = defaultGroup ?? "";
        model = Ui.Combo(ModelLabels, 0); mode = Ui.Combo(ModeLabels, 0);
        q5 = Ui.Combo(Seuils.Select(s => s.Length == 0 ? "aucun" : s + " %"), 0); q7 = Ui.Combo(Seuils.Select(s => s.Length == 0 ? "aucun" : s + " %"), 0);
        q5.Width = q7.Width = 90;

        var browse = Ui.Btn("Parcourir…", (_, _) => { var d = new Microsoft.Win32.OpenFolderDialog { Title = "Dossier de travail" }; if (d.ShowDialog(this) == true) { cwd.Text = d.FolderName; _ = CheckRepo(); } });
        var cwdRow = new DockPanel(); DockPanel.SetDock(browse, Dock.Right); cwdRow.Children.Add(browse); cwdRow.Children.Add(cwd);
        cwd.LostFocus += async (_, _) => await CheckRepo();
        name.LostFocus += async (_, _) => { if (worktree.IsChecked == true && branch.Tag == null) await CheckRepo(); };
        foreach (var d in owner.items.OrderByDescending(i => i.Order).Select(i => (string?)i.Worktree?["repo"] ?? i.Cwd).Where(Directory.Exists).Distinct().Take(6))
        {
            var b = Ui.Btn(Path.GetFileName(d.TrimEnd('\\', '/')), async (_, _) => { cwd.Text = d; await CheckRepo(); });
            b.Height = 26; b.Margin = new Thickness(0, 0, 6, 0); b.ToolTip = d;
            recent.Children.Add(b);
        }
        worktree.Click += (_, _) => wtBox.Visibility = worktree.IsChecked == true ? Visibility.Visible : Visibility.Collapsed;
        branch.TextChanged += (_, _) => branch.Tag = "touché";
        wtBox.Children.Add(Ui.Row(new TextBlock { Text = "Branche", Foreground = Ui.R("Muted"), VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 8, 0) }, branch));
        branch.Width = 280; branch.FontFamily = (System.Windows.Media.FontFamily)FindResource("MonoFont");
        wtBox.Children.Add(wtInfo);
        tpl.SelectionChanged += (_, _) => ApplyTemplate(tpl.SelectedIndex > 0 ? templates[tpl.SelectedIndex - 1] as JsonObject : null);

        var grid = new Grid(); grid.ColumnDefinitions.Add(new ColumnDefinition()); grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(18) }); grid.ColumnDefinitions.Add(new ColumnDefinition());
        void Cell(UIElement e, int row, int col, int span = 1) { while (grid.RowDefinitions.Count <= row) grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto }); Grid.SetRow(e, row); Grid.SetColumn(e, col); Grid.SetColumnSpan(e, span); if (row > 0 && e is FrameworkElement fe) fe.Margin = new Thickness(0, 16, 0, 0); grid.Children.Add(e); }

        // en-tête de la maquette : champ monospace 12 px, pastilles de dossiers récents, hauteur 36
        cwd.Height = 36; cwd.FontSize = 12; cwd.SetResourceReference(Control.FontFamilyProperty, "MonoFont"); cwd.Padding = new Thickness(10, 0, 10, 0);
        browse.Height = 36; browse.Margin = new Thickness(8, 0, 0, 0); browse.Padding = new Thickness(14, 0, 14, 0);
        recent.Margin = new Thickness(0, 6, 0, 0);
        foreach (var e in recent.Children.OfType<Button>()) { e.Style = Ui.S("Pill"); e.Height = double.NaN; e.Margin = new Thickness(0, 0, 6, 0); }
        var cwdField = new StackPanel(); cwdField.Children.Add(Ui.Label("Dossier de travail", 6)); cwdField.Children.Add(cwdRow); cwdField.Children.Add(recent);
        Cell(cwdField, 0, 0, 3);
        name.Height = 36; name.Padding = new Thickness(10, 0, 10, 0); group.Height = 36; mode.Height = 36; model.Height = 36; model.Visibility = Visibility.Collapsed;
        var seg = Segmented(model, ModelLabels);
        Cell(Field("Nom", Ui.Placeholder(name, "", namePh)), 1, 0); Cell(Field("Groupe", group), 1, 2);
        var modelField = new StackPanel(); modelField.Children.Add(Ui.Label("Modèle", 6)); modelField.Children.Add(seg); modelField.Children.Add(model);
        Cell(modelField, 2, 0); Cell(Field("Mode", mode), 2, 2);
        cwd.TextChanged += (_, _) => namePh.Text = Path.GetFileName(cwd.Text.Trim().TrimEnd('\\', '/'));

        var options = new StackPanel();
        branch.Height = 30; branch.MinHeight = 30; branch.FontSize = 12; branch.Padding = new Thickness(8, 0, 8, 0);
        wtBox.Margin = new Thickness(26, 10, 0, 0); wtInfo.Margin = new Thickness(8, 0, 0, 0); wtInfo.VerticalAlignment = VerticalAlignment.Center; wtInfo.SetResourceReference(TextBlock.ForegroundProperty, "Dim2");
        options.Children.Add(worktree); options.Children.Add(wtBox);
        remote.Margin = lockpw.Margin = new Thickness(0, 10, 0, 0);
        options.Children.Add(remote); options.Children.Add(lockpw);
        q5.Height = q7.Height = 28; q5.Width = q7.Width = 100;
        qResume.SetResourceReference(Control.ForegroundProperty, "Muted"); qResume.Margin = new Thickness(0);
        TextBlock Mut(string t, double l, double r) { var x = new TextBlock { Text = t, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(l, 0, r, 0) }; x.SetResourceReference(TextBlock.ForegroundProperty, "Muted"); return x; }
        var quota = Ui.Row(new TextBlock { Text = "Plafond de quota", VerticalAlignment = VerticalAlignment.Center }, Mut("5 h", 10, 6), q5, Mut("7 jours", 10, 6), q7, Mut("", 10, 0), qResume);
        quota.Margin = new Thickness(0, 10, 0, 0);
        options.Children.Add(quota);
        var optBox = new Border { CornerRadius = new CornerRadius(10), Padding = new Thickness(14, 12, 14, 12), BorderThickness = new Thickness(1), Child = options };
        optBox.SetResourceReference(Border.BackgroundProperty, "Bar"); optBox.SetResourceReference(Border.BorderBrushProperty, "Line");
        Cell(optBox, 3, 0, 3);

        prompt.Height = 70; prompt.Padding = new Thickness(10);
        var promptField = new StackPanel(); promptField.Children.Add(Ui.Label("Premier message (envoyé dès que la session est prête)", 6)); promptField.Children.Add(prompt);
        Cell(promptField, 4, 0, 3);

        extra.Height = 36; extra.FontSize = 12; extra.Padding = new Thickness(10, 0, 10, 0); extra.SetResourceReference(Control.FontFamilyProperty, "MonoFont");
        var advBody = Field("Arguments supplémentaires", Ui.Placeholder(extra, "--add-dir ../shared")); advBody.Margin = new Thickness(0, 6, 0, 0);
        var advHead = new TextBlock { Text = "▾ Options avancées", FontSize = 12, FontWeight = FontWeights.SemiBold, Cursor = System.Windows.Input.Cursors.Hand };
        advHead.SetResourceReference(TextBlock.ForegroundProperty, "Dim");
        advHead.MouseLeftButtonUp += (_, _) => { var open = advBody.Visibility != Visibility.Visible; advBody.Visibility = open ? Visibility.Visible : Visibility.Collapsed; advHead.Text = (open ? "▾" : "▸") + " Options avancées"; };
        var adv = new StackPanel(); adv.Children.Add(advHead); adv.Children.Add(advBody);
        Cell(adv, 5, 0, 3);

        var saveTpl = Ui.Btn("Enregistrer comme modèle", async (_, _) => await SaveAsTemplate());
        saveTpl.Margin = new Thickness(0); saveTpl.Height = 36; saveTpl.Background = Brushes.Transparent; saveTpl.SetResourceReference(Control.ForegroundProperty, "Fg2");
        var cancel = Ui.Btn("Annuler"); cancel.IsCancel = true; cancel.Height = 36; cancel.Padding = new Thickness(16, 0, 16, 0);
        var go = Ui.Btn("Lancer la session", async (_, _) => await Launch(), "Primary"); go.IsDefault = true; go.Height = 36; go.Padding = new Thickness(20, 0, 20, 0); go.Margin = new Thickness(8, 0, 0, 0);
        var foot = new DockPanel { LastChildFill = false };
        DockPanel.SetDock(saveTpl, Dock.Left); foot.Children.Add(saveTpl);
        DockPanel.SetDock(go, Dock.Right); foot.Children.Add(go); DockPanel.SetDock(cancel, Dock.Right); foot.Children.Add(cancel);

        var title = new TextBlock { Text = "Nouvelle session", FontSize = 17, FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center };
        var tplLbl = new TextBlock { Text = "Partir d'un modèle", FontSize = 12, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 8, 0) }; tplLbl.SetResourceReference(TextBlock.ForegroundProperty, "Muted");
        tpl.Height = 32; tpl.MinWidth = 134; tpl.SetResourceReference(Control.BackgroundProperty, "Panel2");
        var head = new DockPanel();
        var tplRow = Ui.Row(tplLbl, tpl); DockPanel.SetDock(tplRow, Dock.Right); head.Children.Add(tplRow); head.Children.Add(title);

        Content = new ScrollViewer
        {
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto, MaxHeight = SystemParameters.WorkArea.Height - 80,
            Content = Ui.Modal(head, grid, foot),
        };
        Loaded += async (_, _) =>
        {
            cwd.Focus();
            try
            {
                templates = await main.server.Api(HttpMethod.Get, "/api/templates") as JsonArray ?? [];
                tpl.ItemsSource = templates.Select(t => (string?)t?["name"] ?? "modèle").Prepend("— aucun —").ToList(); tpl.SelectedIndex = 0;
                var st = await main.server.Api(HttpMethod.Get, "/api/settings");
                model.SelectedIndex = Math.Max(0, Array.IndexOf(Models, (string?)st?["defaultModel"] ?? "opus"));
                mode.SelectedIndex = Math.Max(0, Array.IndexOf(Modes, (string?)st?["defaultMode"] ?? ""));
                worktree.IsChecked = (bool?)st?["worktreeDefault"] == true;
                remote.IsChecked = (bool?)st?["remoteAll"] == true;
            }
            catch { }
        };
    }

    static StackPanel Field(string label, UIElement c) { var p = new StackPanel(); p.Children.Add(Ui.Label(label, 6)); p.Children.Add(c); return p; }

    // choix du modèle en boutons segmentés (maquette) ; la liste cachée porte la valeur
    static UIElement Segmented(ComboBox src, string[] labels)
    {
        var host = new Border { CornerRadius = new CornerRadius(8), BorderThickness = new Thickness(1), Padding = new Thickness(3) };
        host.SetResourceReference(Border.BackgroundProperty, "Term"); host.SetResourceReference(Border.BorderBrushProperty, "Line2");
        var g = new UniformGrid { Rows = 1 }; var items = new List<Border>();
        for (var i = 0; i < labels.Length; i++)
        {
            var idx = i;
            var t = new TextBlock { Text = labels[i], HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
            var b = new Border { Height = 30, CornerRadius = new CornerRadius(6), Cursor = System.Windows.Input.Cursors.Hand, Background = Brushes.Transparent, Child = t };
            b.MouseLeftButtonUp += (_, _) => src.SelectedIndex = idx;
            items.Add(b); g.Children.Add(b);
        }
        void Sync()
        {
            for (var i = 0; i < items.Count; i++)
            {
                var on = i == src.SelectedIndex;
                if (on) items[i].SetResourceReference(Border.BackgroundProperty, "Line2"); else { items[i].ClearValue(Border.BackgroundProperty); items[i].Background = Brushes.Transparent; }
                ((TextBlock)items[i].Child).SetResourceReference(TextBlock.ForegroundProperty, on ? "Fg" : "Muted");
            }
        }
        src.SelectionChanged += (_, _) => Sync(); Sync();
        host.Child = g; return host;
    }

    void ApplyTemplate(JsonObject? x)
    {
        if (x == null) return;
        if ((string?)x["cwd"] is { Length: > 0 } c) cwd.Text = c;
        name.Text = (string?)x["name"] ?? "";
        model.SelectedIndex = Math.Max(0, Array.IndexOf(Models, (string?)x["model"] ?? ""));
        mode.SelectedIndex = Math.Max(0, Array.IndexOf(Modes, (string?)x["mode"] ?? ""));
        extra.Text = (string?)x["extra"] ?? ""; prompt.Text = (string?)x["prompt"] ?? ""; group.Text = (string?)x["group"] ?? "";
        worktree.IsChecked = (bool?)x["worktree"] == true; wtBox.Visibility = worktree.IsChecked == true ? Visibility.Visible : Visibility.Collapsed;
        type = (string?)x["type"] ?? "";
        var q = x["quotaStop"] as JsonObject;
        q5.SelectedIndex = Math.Max(0, Array.IndexOf(Seuils, ((int?)q?["five"])?.ToString() ?? ""));
        q7.SelectedIndex = Math.Max(0, Array.IndexOf(Seuils, ((int?)q?["seven"])?.ToString() ?? ""));
        qResume.IsChecked = (bool?)q?["resume"] == true;
        _ = CheckRepo();
    }

    // dépôt git : branche proposée pour le worktree (csm/<nom>)
    async Task CheckRepo()
    {
        if (!Directory.Exists(cwd.Text.Trim())) { worktree.IsEnabled = false; wtInfo.Text = ""; return; }
        try
        {
            var n = name.Text.Trim().Length > 0 ? name.Text.Trim() : Path.GetFileName(cwd.Text.Trim().TrimEnd('\\', '/'));
            var r = await main.server.Api(HttpMethod.Get, $"/api/git/suggest-branch?cwd={Uri.EscapeDataString(cwd.Text.Trim())}&name={Uri.EscapeDataString(n)}");
            var repo = (bool?)r?["repo"] == true;
            worktree.IsEnabled = repo;
            if (!repo) { worktree.IsChecked = false; wtBox.Visibility = Visibility.Collapsed; return; }
            if (branch.Tag == null || branch.Text.Length == 0) { branch.Text = (string?)r?["branch"] ?? ""; branch.Tag = null; }
            wtInfo.Text = $"depuis {(string?)r?["base"]}";
        }
        catch { }
    }

    string Args => string.Join(" ", new[] { Models[model.SelectedIndex] is { Length: > 0 } m ? $"--model {m}" : "", Modes[mode.SelectedIndex] is { Length: > 0 } p ? $"--permission-mode {p}" : "", extra.Text.Trim() }.Where(x => x.Length > 0));

    async Task Launch()
    {
        var dir = cwd.Text.Trim().Trim('"');
        if (!Directory.Exists(dir)) { MessageBox.Show(this, "Dossier introuvable.", "Nouvelle session"); return; }
        var body = new JsonObject
        {
            ["cwd"] = dir, ["args"] = Args, ["remote"] = remote.IsChecked == true,
            ["name"] = name.Text.Trim().Length > 0 ? name.Text.Trim() : null, ["group"] = group.Text.Trim().Length > 0 ? group.Text.Trim() : null,
            ["initialPrompt"] = prompt.Text.Trim().Length > 0 ? prompt.Text.Trim() : null, ["type"] = type.Length > 0 ? type : null,
        };
        try
        {
            JsonNode? s;
            if (worktree.IsChecked == true && worktree.IsEnabled) { body["branch"] = branch.Text.Trim(); s = await main.server.Api(HttpMethod.Post, "/api/worktree/session", body); }
            else s = await main.server.Api(HttpMethod.Post, "/api/sessions", body);
            var id = (string?)s?["id"];
            int? Seuil(ComboBox c) => c.SelectedIndex > 0 ? int.Parse(Seuils[c.SelectedIndex]) : null;
            if (id != null && (Seuil(q5) != null || Seuil(q7) != null))
                await main.server.Api(HttpMethod.Post, $"/api/sessions/{id}/quota-stop", new { five = Seuil(q5), seven = Seuil(q7), resume = qResume.IsChecked == true });
            Result = s;
            DialogResult = true;
            if (lockpw.IsChecked == true && s is JsonObject o) { var it = new SessionItem { Id = id! }; it.Update(o); await Dialogs.Lock(main, it); }
        }
        catch (Exception e) { MessageBox.Show(this, $"Création impossible : {e.Message}", "Nouvelle session"); }
    }

    async Task SaveAsTemplate()
    {
        var n = Ui.Ask(this, "Enregistrer comme modèle", "Nom du modèle", name.Text.Trim());
        if (n == null) return;
        try
        {
            var list = await main.server.Api(HttpMethod.Get, "/api/templates") as JsonArray ?? [];
            int? Seuil(ComboBox c) => c.SelectedIndex > 0 ? int.Parse(Seuils[c.SelectedIndex]) : null;
            list.Add(new JsonObject
            {
                ["id"] = Guid.NewGuid().ToString("N")[..10], ["name"] = n, ["cwd"] = cwd.Text.Trim(), ["model"] = Models[model.SelectedIndex], ["mode"] = Modes[mode.SelectedIndex],
                ["extra"] = extra.Text.Trim(), ["prompt"] = prompt.Text.Trim(), ["group"] = group.Text.Trim(), ["worktree"] = worktree.IsChecked == true,
                ["quotaStop"] = Seuil(q5) != null || Seuil(q7) != null ? new JsonObject { ["five"] = Seuil(q5), ["seven"] = Seuil(q7), ["resume"] = qResume.IsChecked == true } : null,
            });
            await main.server.Api(HttpMethod.Put, "/api/templates", list);
        }
        catch (Exception e) { MessageBox.Show(this, e.Message, "Modèle"); }
    }
}
