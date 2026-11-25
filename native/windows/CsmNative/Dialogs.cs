using System.Net.Http;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace CsmNative;

// Briques d'interface communes (maquette : fenêtres sombres, bords arrondis, boutons accent / fantôme / danger).
static class Ui
{
    public static Brush R(string key) => (Brush)Application.Current.FindResource(key);
    public static Style S(string key) => (Style)Application.Current.FindResource(key);

    public static Window Dialog(Window owner, string title, double width = 520, double? height = null) => new()
    {
        Owner = owner, Title = title, Width = width, Height = height ?? double.NaN, SizeToContent = height == null ? SizeToContent.Height : SizeToContent.Manual,
        ResizeMode = height == null ? ResizeMode.NoResize : ResizeMode.CanResize, WindowStartupLocation = WindowStartupLocation.CenterOwner,
        Background = R("Panel"), Foreground = R("Fg"), FontFamily = (FontFamily)Application.Current.FindResource("UiFont"), FontSize = 13, ShowInTaskbar = false,
    };
    public static TextBlock H2(string t) => new() { Text = t, FontSize = 17, FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 0, 0, 6) };
    public static TextBlock Hint(string t) => new() { Text = t, Style = S("Hint"), Margin = new Thickness(0, 2, 0, 6) };
    public static TextBlock Label(string t) => new() { Text = t, Foreground = R("Muted"), FontSize = 12, Margin = new Thickness(0, 10, 0, 4) };
    public static TextBlock Label(string t, double bottom) { var l = Label(t); l.Margin = new Thickness(0, 0, 0, bottom); return l; }
    // champ avec texte indicatif (affiché tant que le champ est vide) ; ph reçoit le texte si on veut le changer plus tard
    public static UIElement Placeholder(TextBox box, string text, TextBlock? ph = null)
    {
        ph ??= new TextBlock(); if (text.Length > 0) ph.Text = text;
        ph.IsHitTestVisible = false; ph.VerticalAlignment = VerticalAlignment.Center; ph.Margin = new Thickness(box.Padding.Left + 1, 0, 0, 0);
        ph.SetResourceReference(TextBlock.ForegroundProperty, "Dim2"); ph.SetBinding(TextBlock.FontFamilyProperty, new System.Windows.Data.Binding("FontFamily") { Source = box });
        ph.SetBinding(TextBlock.FontSizeProperty, new System.Windows.Data.Binding("FontSize") { Source = box });
        void Sync() => ph!.Visibility = box.Text.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
        box.TextChanged += (_, _) => Sync(); Sync();
        var g = new Grid(); g.Children.Add(box); g.Children.Add(ph); return g;
    }
    public static UIElement Placeholder2(PasswordBox box, string text)
    {
        var ph = new TextBlock { Text = text, IsHitTestVisible = false, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(10, 0, 0, 0) }; ph.SetResourceReference(TextBlock.ForegroundProperty, "Dim2");
        void Sync() => ph.Visibility = box.Password.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
        box.PasswordChanged += (_, _) => Sync(); Sync();
        var g = new Grid(); g.Children.Add(box); g.Children.Add(ph); return g;
    }
    // fenêtre en trois bandes (maquette) : en-tête 18/22 + filet, corps 20/22, pied 14/22 + filet
    public static StackPanel Modal(UIElement header, UIElement body, UIElement? footer = null, double padX = 22, double padHead = 18, double padBody = 20, double padFoot = 14)
    {
        Border Band(UIElement c, Thickness pad, Thickness line) { var b = new Border { Padding = pad, BorderThickness = line, Child = c }; b.SetResourceReference(Border.BorderBrushProperty, "Line"); return b; }
        var p = new StackPanel();
        p.Children.Add(Band(header, new Thickness(padX, padHead, padX, padHead), new Thickness(0, 0, 0, 1)));
        p.Children.Add(new Border { Padding = new Thickness(padX, padBody, padX, padBody), Child = body });
        if (footer != null) p.Children.Add(Band(footer, new Thickness(padX, padFoot, padX, padFoot), new Thickness(0, 1, 0, 0)));
        return p;
    }
    // bande horizontale avec filet (en-tête, filtre, pied)
    public static Border Band(UIElement c, double padX, double padY, bool top = false)
    {
        var b = new Border { Padding = new Thickness(padX, padY, padX, padY), BorderThickness = top ? new Thickness(0, 1, 0, 0) : new Thickness(0, 0, 0, 1), Child = c };
        b.SetResourceReference(Border.BorderBrushProperty, "Line"); return b;
    }
    // bouton de fermeture carré 30 x 30 (maquette : croix grise)
    public static Button CloseBtn(Window w)
    {
        var b = new Button { Content = new TextBlock { Text = "\uE711", FontFamily = PaletteWindow.Icons, FontSize = 12 }, Width = 30, Height = 30, Padding = new Thickness(0), Style = S("Ghost"), ToolTip = "Fermer", Margin = new Thickness(10, 0, 0, 0) };
        b.Click += (_, _) => { if (w is Screen s) s.SafeClose(); else w.Close(); }; return b;
    }
    public static Button IconBtn(string glyph, string tip, RoutedEventHandler click, double size = 28)
    {
        var b = new Button { Content = new TextBlock { Text = glyph, FontFamily = PaletteWindow.Icons, FontSize = 12 }, Width = size, Height = size, Padding = new Thickness(0), ToolTip = tip, Background = Brushes.Transparent, Margin = new Thickness(8, 0, 0, 0) };
        b.Click += click; return b;
    }
    public static Button Btn(string t, RoutedEventHandler? click = null, string? style = null)
    {
        var b = new Button { Content = t, Margin = new Thickness(6, 0, 0, 0) };
        if (style != null) b.Style = S(style);
        if (click != null) b.Click += click;
        return b;
    }
    public static TextBox Box(string text = "", bool multi = false, int lines = 3) => new()
    {
        Text = text, AcceptsReturn = multi, TextWrapping = multi ? TextWrapping.Wrap : TextWrapping.NoWrap,
        Height = multi ? 22 * lines + 14 : 34, Padding = multi ? new Thickness(8, 6, 8, 6) : new Thickness(8, 0, 8, 0), VerticalScrollBarVisibility = multi ? ScrollBarVisibility.Auto : ScrollBarVisibility.Disabled,
    };
    public static StackPanel Row(params UIElement[] els) { var p = new StackPanel { Orientation = Orientation.Horizontal }; foreach (var e in els) p.Children.Add(e); return p; }
    public static DockPanel Footer(params UIElement[] right)
    {
        var d = new DockPanel { Margin = new Thickness(0, 16, 0, 0), LastChildFill = false };
        foreach (var e in right.Reverse()) { DockPanel.SetDock(e, Dock.Right); d.Children.Add(e); }
        return d;
    }
    public static StackPanel Body(params UIElement[] els) { var p = new StackPanel { Margin = new Thickness(20, 16, 20, 18) }; foreach (var e in els) p.Children.Add(e); return p; }
    public static ComboBox Combo(IEnumerable<string> items, int sel = 0, bool editable = false) => new() { ItemsSource = items.ToList(), SelectedIndex = sel, IsEditable = editable };

    public static string? Ask(Window owner, string title, string label, string value = "", string? hint = null)
    {
        var w = Dialog(owner, title, 460);
        var box = Box(value);
        string? result = null;
        var ok = Btn("Valider", (_, _) => { if (box.Text.Trim().Length > 0) { result = box.Text.Trim(); w.DialogResult = true; } }, "Primary"); ok.IsDefault = true;
        var cancel = Btn("Annuler"); cancel.IsCancel = true;
        var body = Body(H2(title), Label(label), box);
        if (hint != null) body.Children.Add(Hint(hint));
        body.Children.Add(Footer(cancel, ok));
        w.Content = body;
        w.Loaded += (_, _) => { box.Focus(); box.SelectAll(); };
        return w.ShowDialog() == true ? result : null;
    }
}

// Petites fenêtres de l'interface web (index.html), mêmes textes.
static class Dialogs
{
    public static string? Rename(Window owner, string current) =>
        Ui.Ask(owner, "Renommer", "Nom", current, "Le nom est aussi enregistré dans la conversation Claude (historique, claude --resume).");

    // Fermer une session de worktree : garder, fusionner puis supprimer, ou supprimer
    public static string? CloseWorktree(Window owner, string name, string path, string branch, string baseBranch)
    {
        var w = Ui.Dialog(owner, "Fermer la session", 520);
        string? choice = null;
        Button Choice(string key, string title, string text, bool danger = false)
        {
            var sp = new StackPanel();
            sp.Children.Add(new TextBlock { Text = title, FontWeight = FontWeights.SemiBold, Foreground = danger ? Ui.R("Warn") : Ui.R("Fg") });
            sp.Children.Add(new TextBlock { Text = text, Style = Ui.S("Hint") });
            var b = new Button { Content = sp, Height = double.NaN, Padding = new Thickness(12, 10, 12, 10), Margin = new Thickness(0, 6, 0, 0), HorizontalContentAlignment = HorizontalAlignment.Stretch };
            if (key == "keep") { b.Background = Ui.R("AccentSoft"); b.BorderBrush = Ui.R("Accent"); }
            b.Click += (_, _) => { choice = key; w.DialogResult = true; };
            return b;
        }
        var cancel = Ui.Btn("Annuler"); cancel.IsCancel = true;
        w.Content = Ui.Body(Ui.H2($"Fermer « {name} »"),
            Ui.Hint($"Cette session travaille dans le worktree {path} (branche {branch}, base {baseBranch})."),
            Choice("keep", "Fermer et garder le worktree", "Le dossier et la branche restent : tu pourras y revenir, fusionner plus tard ou les supprimer à la main."),
            Choice("merge", "Fusionner puis supprimer", "Fusionne la branche dans sa branche de base, puis supprime le worktree et la branche. Les modifications doivent être commitées."),
            Choice("remove", "Supprimer le worktree et la branche", "Abandonne tout le travail de cette branche.", true),
            Ui.Footer(cancel));
        return w.ShowDialog() == true ? choice : null;
    }

    // File d'attente : prompts envoyés un par un, automatiquement, quand la session a fini le précédent
    static JsonArray QueueOf(SessionItem it) => (it.Data["queue"] as JsonArray)?.DeepClone() as JsonArray ?? [];
    public static async Task Enqueue(MainWindow owner, SessionItem it, string text)
    {
        var q = QueueOf(it);
        q.Add(new JsonObject { ["id"] = Guid.NewGuid().ToString("N")[..8], ["text"] = text });
        await owner.server.Api(HttpMethod.Put, $"/api/sessions/{it.Id}/queue", q);
    }
    public static void Queue(MainWindow owner, SessionItem it)
    {
        var w = Ui.Dialog(owner, "File d'attente", 600);
        var list = new StackPanel();
        var add = Ui.Box("", true, 2);
        JsonArray q = QueueOf(it);
        async Task Save() { await owner.Try(async () => { var s = await owner.server.Api(HttpMethod.Put, $"/api/sessions/{it.Id}/queue", q); if (s is JsonObject o) it.Update(o); }); Render(); }
        void Render()
        {
            list.Children.Clear();
            if (q.Count == 0) list.Children.Add(Ui.Hint("La file est vide."));
            for (var i = 0; i < q.Count; i++)
            {
                var idx = i;
                var t = new TextBlock { Text = $"{i + 1}. {(string?)q[i]?["text"]}", TextTrimming = TextTrimming.CharacterEllipsis, VerticalAlignment = VerticalAlignment.Center };
                var up = Ui.Btn("↑", async (_, _) => { if (idx == 0) return; var x = q[idx]!.DeepClone(); q.RemoveAt(idx); q.Insert(idx - 1, x); await Save(); }, "Ghost");
                var down = Ui.Btn("↓", async (_, _) => { if (idx >= q.Count - 1) return; var x = q[idx]!.DeepClone(); q.RemoveAt(idx); q.Insert(idx + 1, x); await Save(); }, "Ghost");
                var del = Ui.Btn("✕", async (_, _) => { q.RemoveAt(idx); await Save(); }, "Ghost"); del.Foreground = Ui.R("Warn");
                var row = new DockPanel { Margin = new Thickness(0, 3, 0, 0) };
                var right = Ui.Row(up, down, del); DockPanel.SetDock(right, Dock.Right); row.Children.Add(right); row.Children.Add(t);
                list.Children.Add(new Border { Background = Ui.R("Bar"), BorderBrush = Ui.R("Line"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(8), Padding = new Thickness(10, 4, 4, 4), Margin = new Thickness(0, 4, 0, 0), Child = row });
            }
        }
        Render();
        var addBtn = Ui.Btn("Ajouter", async (_, _) =>
        {
            if (add.Text.Trim().Length == 0) return;
            q.Add(new JsonObject { ["id"] = Guid.NewGuid().ToString("N")[..8], ["text"] = add.Text.Trim() }); add.Clear(); await Save();
        }, "Primary");
        var close = Ui.Btn("Fermer"); close.IsCancel = true;
        var addRow = new DockPanel { Margin = new Thickness(0, 12, 0, 0) }; DockPanel.SetDock(addBtn, Dock.Right); addRow.Children.Add(addBtn); addRow.Children.Add(add);
        w.Content = Ui.Body(Ui.H2($"File d'attente — {it.Name}"),
            Ui.Hint("Chaque prompt est envoyé automatiquement quand la session a fini le précédent."), list, addRow, Ui.Footer(close));
        w.ShowDialog();
    }

    // Plafond de quota : pause propre de la session quand le quota choisi atteint le seuil
    static readonly string[] Seuils = ["50", "60", "70", "80", "85", "90", "95", "99"];
    public static void QuotaStop(MainWindow owner, SessionItem it)
    {
        var w = Ui.Dialog(owner, "Plafond de quota", 600);
        var cur = it.Data["quotaStop"] as JsonObject;
        int Pick(string k) { var v = (int?)cur?[k]; return v is int n ? Math.Max(0, Array.IndexOf(Seuils, n.ToString())) : 6; }
        var on5 = new CheckBox { Content = "Quota 5 h à", IsChecked = cur?["five"] != null };
        var c5 = Ui.Combo(Seuils.Select(s => s + " %"), Pick("five")); c5.Width = 90; c5.Margin = new Thickness(8, 0, 24, 0);
        var on7 = new CheckBox { Content = "Quota 7 jours à", IsChecked = cur?["seven"] != null };
        var c7 = Ui.Combo(Seuils.Select(s => s + " %"), Pick("seven")); c7.Width = 90; c7.Margin = new Thickness(8, 0, 0, 0);
        var resume = new CheckBox { Content = "Reprendre automatiquement à la réinitialisation du quota atteint", IsChecked = (bool?)cur?["resume"] == true, Margin = new Thickness(0, 12, 0, 0) };
        var text = Ui.Box((string?)cur?["text"] ?? "", true, 5);
        _ = owner.Try(async () => { if (text.Text.Length == 0) text.Text = (string?)(await owner.server.Api(HttpMethod.Get, "/api/quota-stop/default"))?["text"] ?? ""; });
        async Task Send(object body) { await owner.Try(() => owner.server.Api(HttpMethod.Post, $"/api/sessions/{it.Id}/quota-stop", body)); w.DialogResult = true; }
        var save = Ui.Btn("Enregistrer", async (_, _) => await Send(new
        {
            five = on5.IsChecked == true ? int.Parse(Seuils[c5.SelectedIndex]) : (int?)null,
            seven = on7.IsChecked == true ? int.Parse(Seuils[c7.SelectedIndex]) : (int?)null,
            resume = resume.IsChecked == true, text = text.Text,
        }), "Primary");
        var off = Ui.Btn("Retirer le plafond", async (_, _) => await Send(new { off = true }), "Danger");
        var cancel = Ui.Btn("Annuler"); cancel.IsCancel = true;
        var foot = Ui.Footer(cancel, save); off.Margin = new Thickness(0); DockPanel.SetDock(off, Dock.Left); foot.Children.Add(off);
        w.Content = Ui.Body(Ui.H2($"Plafond de quota — {it.Name}"),
            Ui.Hint("Quand le quota choisi atteint le seuil, Claude reçoit la demande d’enregistrer où il en est (notes de reprise, commit du travail en cours), puis la session se met en pause : mémoire et synchro enregistrées. « Reprendre » continue plus tard."),
            Ui.Row(on5, c5, on7, c7), resume, Ui.Label("Message envoyé à Claude"), text,
            Ui.Hint("{quota} et {pct} sont remplacés par le quota atteint et sa valeur."), foot);
        w.ShowDialog();
    }

    // Verrouiller par mot de passe : contenu masqué, saisie bloquée, la session continue de tourner
    public static async Task Lock(MainWindow owner, SessionItem it)
    {
        var w = Ui.Dialog(owner, "Verrouiller", 480);
        var current = new PasswordBox(); var pw = new PasswordBox(); var pw2 = new PasswordBox(); var hint = Ui.Box();
        var body = Ui.Body(Ui.H2("Verrouiller"),
            Ui.Hint("Le contenu de la session est masqué et sa saisie bloquée tant qu'elle n'est pas déverrouillée. Elle continue de tourner. Attention : le mot de passe ne peut pas être récupéré."));
        if (it.Locked) { body.Children.Add(Ui.Label("Mot de passe actuel")); body.Children.Add(current); }
        body.Children.Add(Ui.Label("Mot de passe")); body.Children.Add(pw);
        body.Children.Add(Ui.Label("Confirmer le mot de passe")); body.Children.Add(pw2);
        body.Children.Add(Ui.Label("Indice (facultatif, visible sur l'écran de verrouillage)")); body.Children.Add(hint);
        var err = Ui.Hint(""); err.Foreground = Ui.R("Warn"); body.Children.Add(err);
        var ok = Ui.Btn("Valider", async (_, _) =>
        {
            if (pw.Password.Length < 4) { err.Text = "mot de passe trop court (4 caractères minimum)"; return; }
            if (pw.Password != pw2.Password) { err.Text = "Les deux mots de passe ne correspondent pas."; return; }
            try { await owner.server.Api(HttpMethod.Post, $"/api/sessions/{it.Id}/lock", new { password = pw.Password, current = current.Password, hint = hint.Text }); w.DialogResult = true; }
            catch (Exception e) { err.Text = e.Message; }
        }, "Primary");
        ok.IsDefault = true;
        var cancel = Ui.Btn("Annuler"); cancel.IsCancel = true;
        body.Children.Add(Ui.Footer(cancel, ok));
        w.Content = body;
        w.ShowDialog();
        await Task.CompletedTask;
    }

    // Ramener dans csm une session ouverte dans un terminal : Déplacer ou Copier
    public static string? ImportMode(Window owner, string title, int busy)
    {
        var w = Ui.Dialog(owner, "Ramener dans csm", 520);
        string? mode = null;
        Button Choice(string key, string t, string text, bool main)
        {
            var sp = new StackPanel(); sp.Children.Add(new TextBlock { Text = t, FontWeight = FontWeights.SemiBold }); sp.Children.Add(new TextBlock { Text = text, Style = Ui.S("Hint") });
            var b = new Button { Content = sp, Height = double.NaN, Padding = new Thickness(12, 10, 12, 10), Margin = new Thickness(0, 6, 0, 0), HorizontalContentAlignment = HorizontalAlignment.Stretch };
            if (main) { b.Background = Ui.R("AccentSoft"); b.BorderBrush = Ui.R("Accent"); }
            b.Click += (_, _) => { mode = key; w.DialogResult = true; };
            return b;
        }
        var cancel = Ui.Btn("Annuler"); cancel.IsCancel = true;
        var body = Ui.Body(Ui.H2($"Ramener « {title} »"), Ui.Hint("Ta conversation n'est pas perdue : elle reprend dans csm exactement là où elle en est (historique, contexte, dossier)."));
        if (busy > 0) { var warn = Ui.Hint($"⚠ {(busy > 1 ? $"{busy} sessions travaillent" : "Cette session travaille")} en ce moment : « Déplacer » l’arrête dans le terminal, puis la tâche reprend toute seule dans csm. « Copier » ne l’interrompt pas."); warn.Foreground = Ui.R("Work"); body.Children.Add(warn); }
        body.Children.Add(Choice("move", "Déplacer", "La session passe dans csm. Dans le terminal, Claude s'arrête : tu peux fermer cet onglet.", true));
        body.Children.Add(Choice("copy", "Copier", "Le terminal continue normalement. csm ouvre une copie de la conversation, qui évolue ensuite séparément.", false));
        body.Children.Add(Ui.Footer(cancel));
        w.Content = body;
        return w.ShowDialog() == true ? mode : null;
    }

    // Enregistrer comme modèle : dossier, nom, groupe, modèle, mode, worktree, premier prompt
    public static async Task SaveTemplate(MainWindow owner, SessionItem it)
    {
        var name = Ui.Ask(owner, "Enregistrer comme modèle", "Nom du modèle", it.Name);
        if (name == null) return;
        await owner.Try(async () =>
        {
            var list = (await owner.server.Api(HttpMethod.Get, "/api/templates")) as JsonArray ?? [];
            list.Add(new JsonObject
            {
                ["id"] = Guid.NewGuid().ToString("N")[..10], ["name"] = name, ["cwd"] = (string?)it.Worktree?["repo"] ?? it.Cwd, ["model"] = it.Model, ["mode"] = it.Mode,
                ["group"] = it.Group, ["worktree"] = it.Worktree != null, ["prompt"] = "", ["extra"] = "",
            });
            await owner.server.Api(HttpMethod.Put, "/api/templates", list);
        });
    }
}
