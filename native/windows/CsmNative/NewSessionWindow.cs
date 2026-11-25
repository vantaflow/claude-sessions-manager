using System.IO;
using System.Net.Http;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;

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
        void Cell(UIElement e, int row, int col) { while (grid.RowDefinitions.Count <= row) grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto }); Grid.SetRow(e, row); Grid.SetColumn(e, col); grid.Children.Add(e); }
        Cell(Field("Nom", name), 0, 0); Cell(Field("Groupe", group), 0, 2);
        Cell(Field("Modèle", model), 1, 0); Cell(Field("Mode", mode), 1, 2);

        var options = new StackPanel();
        options.Children.Add(worktree); options.Children.Add(wtBox);
        remote.Margin = lockpw.Margin = new Thickness(0, 8, 0, 0);
        options.Children.Add(remote); options.Children.Add(lockpw);
        var quota = Ui.Row(new TextBlock { Text = "Plafond de quota", VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 12, 0) },
            new TextBlock { Text = "5 h", Foreground = Ui.R("Muted"), VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 6, 0) }, q5,
            new TextBlock { Text = "7 jours", Foreground = Ui.R("Muted"), VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(14, 0, 6, 0) }, q7, qResume);
        quota.Margin = new Thickness(0, 10, 0, 0);
        options.Children.Add(quota);
        var optBox = new Border { Background = Ui.R("Bar"), BorderBrush = Ui.R("Line"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(10), Padding = new Thickness(14, 12, 14, 12), Margin = new Thickness(0, 14, 0, 0), Child = options };

        var adv = new Expander { Header = "Options avancées", Foreground = Ui.R("Fg2"), Margin = new Thickness(0, 12, 0, 0), Content = Field("Arguments supplémentaires", extra) };
        extra.FontFamily = (System.Windows.Media.FontFamily)FindResource("MonoFont");

        var saveTpl = Ui.Btn("Enregistrer comme modèle", async (_, _) => await SaveAsTemplate());
        saveTpl.Margin = new Thickness(0);
        var cancel = Ui.Btn("Annuler"); cancel.IsCancel = true;
        var go = Ui.Btn("Lancer la session", async (_, _) => await Launch(), "Primary"); go.IsDefault = true;
        var foot = Ui.Footer(cancel, go); DockPanel.SetDock(saveTpl, Dock.Left); foot.Children.Add(saveTpl);

        var head = new DockPanel { Margin = new Thickness(0, 0, 0, 6) };
        var tplRow = Ui.Row(new TextBlock { Text = "Partir d'un modèle", Foreground = Ui.R("Muted"), FontSize = 12, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 8, 0) }, tpl);
        DockPanel.SetDock(tplRow, Dock.Right); head.Children.Add(tplRow); head.Children.Add(Ui.H2("Nouvelle session"));

        Content = new ScrollViewer
        {
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto, MaxHeight = SystemParameters.WorkArea.Height - 80,
            Content = Ui.Body(head, Ui.Label("Dossier de travail"), cwdRow, recent, grid, optBox,
                Ui.Label("Premier message (envoyé dès que la session est prête)"), prompt, adv, foot),
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

    static StackPanel Field(string label, UIElement c) { var p = new StackPanel(); p.Children.Add(Ui.Label(label)); p.Children.Add(c); return p; }

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
