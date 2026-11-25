using System.IO;
using System.Net.Http;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace CsmNative;

// Onglets de Réglages qui gèrent des listes : extensions, modèles, tâches programmées, mémoire, transfert, machines.
static class SettingsParts
{
    static Border Card(UIElement c) => new() { Background = Ui.R("Bar"), BorderBrush = Ui.R("Line"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(10), Padding = new Thickness(12), Margin = new Thickness(0, 6, 0, 0), Child = c };
    static DockPanel RowWith(UIElement left, params UIElement[] right) { var d = new DockPanel(); var r = Ui.Row(right); DockPanel.SetDock(r, Dock.Right); d.Children.Add(r); d.Children.Add(left); return d; }
    static StackPanel Two(string a, string b) { var p = new StackPanel(); p.Children.Add(new TextBlock { Text = a, FontWeight = FontWeights.SemiBold, TextTrimming = TextTrimming.CharacterEllipsis }); if (b.Length > 0) p.Children.Add(new TextBlock { Text = b, Foreground = Ui.R("Muted"), FontSize = 12, TextTrimming = TextTrimming.CharacterEllipsis }); return p; }

    // ---------------------------------------------------------------- extensions
    public static UIElement Extensions(MainWindow main, Window owner)
    {
        var p = new StackPanel(); var list = new StackPanel();
        var link = Ui.Box(); link.ToolTip = "Coller un lien (fichier GitHub, dossier, dépôt, gist ou https)";
        async Task Load()
        {
            list.Children.Clear();
            try
            {
                var r = await main.server.Api(HttpMethod.Get, "/api/extensions");
                foreach (var e in (r as JsonArray ?? r?["list"] as JsonArray ?? r?["extensions"] as JsonArray ?? []).OfType<JsonObject>())
                {
                    var id = (string?)e["id"]; var on = (bool?)e["enabled"] != false;
                    var what = string.Join(" · ", new[] { (e["templates"] as JsonArray)?.Count > 0 ? $"{(e["templates"] as JsonArray)!.Count} modèle(s)" : "", (e["prompts"] as JsonArray)?.Count > 0 ? $"{(e["prompts"] as JsonArray)!.Count} prompt(s)" : "", (e["types"] as JsonArray)?.Count > 0 ? "type de session" : "", (e["secrets"] as JsonArray)?.Count > 0 ? "secret demandé" : "" }.Where(x => x.Length > 0));
                    var toggle = new CheckBox { Content = "Activée", IsChecked = on, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 10, 0) };
                    toggle.Click += async (_, _) => await main.Try(() => main.server.Api(HttpMethod.Post, $"/api/extensions/{id}/enabled", new { enabled = toggle.IsChecked == true }));
                    var upd = Ui.Btn("Mettre à jour", async (_, _) => { if ((string?)e["source"] is { Length: > 0 } src) { await main.Try(() => main.server.Api(HttpMethod.Post, "/api/extensions", new { url = src })); await Load(); } });
                    upd.IsEnabled = !string.IsNullOrEmpty((string?)e["source"]);
                    var del = Ui.Btn("Supprimer", async (_, _) => { if (MessageBox.Show(owner, $"Supprimer l'extension « {e["name"]} » ?", "Extensions", MessageBoxButton.YesNo) == MessageBoxResult.Yes) { await main.Try(() => main.server.Api(HttpMethod.Delete, $"/api/extensions/{id}")); await Load(); } }, "Danger");
                    list.Children.Add(Card(RowWith(Two($"{e["name"]}  {e["version"]}", what), toggle, upd, del)));
                }
                if (list.Children.Count == 0) list.Children.Add(Ui.Hint("Aucune extension importée."));
            }
            catch (Exception ex) { list.Children.Add(Ui.Hint(ex.Message)); }
        }
        var file = Ui.Btn("Importer un fichier…", async (_, _) =>
        {
            var d = new Microsoft.Win32.OpenFileDialog { Filter = "Extension CSM|*.csm.json;*.json" };
            if (d.ShowDialog(owner) != true) return;
            await main.Try(async () => await main.server.Api(HttpMethod.Post, "/api/extensions", new { content = await File.ReadAllTextAsync(d.FileName) })); await Load();
        });
        file.Margin = new Thickness(0);
        var imp = Ui.Btn("Importer le lien", async (_, _) => { if (link.Text.Trim().Length > 0) { await main.Try(() => main.server.Api(HttpMethod.Post, "/api/extensions", new { url = link.Text.Trim() })); link.Clear(); await Load(); } }, "Primary");
        p.Children.Add(Ui.Hint("Une extension apporte des modèles de session, des prompts, un type de session avec son affichage et ses actions, et les secrets dont elle a besoin. Elle ne contient aucun code : c'est Claude qui fait le travail. Avec la synchro, elle est installée sur tes autres machines."));
        p.Children.Add(file);
        p.Children.Add(new DockPanel { Margin = new Thickness(0, 8, 0, 0), Children = { imp, link } });
        DockPanel.SetDock(imp, Dock.Right);
        p.Children.Add(list);
        p.Loaded += async (_, _) => await Load();
        return p;
    }

    // ---------------------------------------------------------------- modèles de session
    public static UIElement Templates(MainWindow main, Window owner)
    {
        var p = new StackPanel(); var list = new StackPanel();
        p.Children.Add(Ui.Hint("Lancer, renommer ou supprimer les modèles créés avec « Enregistrer comme modèle »."));
        p.Children.Add(list);
        async Task Load()
        {
            list.Children.Clear();
            try
            {
                var arr = await main.server.Api(HttpMethod.Get, "/api/templates") as JsonArray ?? [];
                foreach (var t in arr.OfType<JsonObject>().ToList())
                {
                    var run = Ui.Btn("Lancer", async (_, _) => await main.Try(async () =>
                    {
                        var args = string.Join(" ", new[] { (string?)t["model"] is { Length: > 0 } m ? $"--model {m}" : "", (string?)t["mode"] is { Length: > 0 } md ? $"--permission-mode {md}" : "", (string?)t["extra"] ?? "" }.Where(x => x.Length > 0));
                        var s = await main.server.Api(HttpMethod.Post, "/api/sessions", new { cwd = (string?)t["cwd"], name = (string?)t["name"], group = (string?)t["group"], args, initialPrompt = (string?)t["prompt"] is { Length: > 0 } pr ? pr : null, type = (string?)t["type"] });
                        if ((string?)s?["id"] is { } id) main.ShowSession(id);
                    }), "Primary");
                    var ren = Ui.Btn("Renommer", async (_, _) => { var n = Ui.Ask(owner, "Renommer le modèle", "Nom", (string?)t["name"] ?? ""); if (n != null) { t["name"] = n; await main.Try(() => main.server.Api(HttpMethod.Put, "/api/templates", arr)); await Load(); } });
                    var del = Ui.Btn("Supprimer", async (_, _) => { arr.Remove(t); await main.Try(() => main.server.Api(HttpMethod.Put, "/api/templates", arr)); await Load(); }, "Danger");
                    list.Children.Add(Card(RowWith(Two((string?)t["name"] ?? "modèle", string.Join(" · ", new[] { (string?)t["cwd"], (string?)t["model"], (string?)t["group"] }.Where(x => !string.IsNullOrEmpty(x)))), run, ren, del)));
                }
                if (arr.Count == 0) list.Children.Add(Ui.Hint("Aucun modèle pour l'instant."));
            }
            catch (Exception e) { list.Children.Add(Ui.Hint(e.Message)); }
        }
        p.Loaded += async (_, _) => await Load();
        return p;
    }

    // ---------------------------------------------------------------- tâches programmées
    public static UIElement Schedules(MainWindow main, Window owner)
    {
        var p = new StackPanel(); var list = new StackPanel();
        JsonArray arr = [];
        async Task Save() { await main.Try(async () => arr = await main.server.Api(HttpMethod.Put, "/api/schedules", arr) as JsonArray ?? arr); Render(); }
        void Render()
        {
            list.Children.Clear();
            foreach (var x in arr.OfType<JsonObject>().ToList())
            {
                var on = new CheckBox { Content = "Active", IsChecked = (bool?)x["enabled"] != false, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 10, 0) };
                on.Click += async (_, _) => { x["enabled"] = on.IsChecked == true; await Save(); };
                var run = Ui.Btn("Lancer maintenant", async (_, _) => await main.Try(() => main.server.Api(HttpMethod.Post, $"/api/schedules/{x["id"]}/run")));
                var del = Ui.Btn("Supprimer", async (_, _) => { arr.Remove(x); await Save(); }, "Danger");
                var sess = main.items.FirstOrDefault(s => s.Id == (string?)x["session"])?.Name ?? (string?)x["sessionName"] ?? "";
                var when = $"{(string?)x["time"]} {(x["days"] is JsonArray d && d.Count > 0 ? string.Join(",", d) : (string?)x["date"] ?? "chaque jour")}";
                list.Children.Add(Card(RowWith(Two((string?)x["text"] ?? "", $"⏰ {when} · {sess}"), on, run, del)));
            }
            if (arr.Count == 0) list.Children.Add(Ui.Hint("Aucune tâche programmée."));
        }
        var text = Ui.Box(); text.ToolTip = "Demande à envoyer";
        var time = Ui.Box("08:00"); time.Width = 80;
        var target = Ui.Combo(main.items.Select(s => s.Name), 0); target.Width = 220;
        var add = Ui.Btn("Ajouter", async (_, _) =>
        {
            if (text.Text.Trim().Length == 0 || target.SelectedIndex < 0) return;
            var s = main.items[target.SelectedIndex];
            arr.Add(new JsonObject { ["id"] = Guid.NewGuid().ToString("N")[..10], ["text"] = text.Text.Trim(), ["time"] = time.Text.Trim(), ["session"] = s.Id, ["sessionName"] = s.Name, ["enabled"] = true, ["days"] = new JsonArray() });
            text.Clear(); await Save();
        }, "Primary");
        p.Children.Add(Ui.Hint("Une demande envoyée à une session à heure fixe (chaque jour). En veille, la session est réveillée."));
        p.Children.Add(list);
        p.Children.Add(Ui.Label("Nouvelle tâche"));
        var row = new DockPanel(); var right = Ui.Row(time, target, add); DockPanel.SetDock(right, Dock.Right); right.Margin = new Thickness(8, 0, 0, 0); row.Children.Add(right); row.Children.Add(text);
        p.Children.Add(row);
        p.Loaded += async (_, _) => { try { var r = await main.server.Api(HttpMethod.Get, "/api/schedules"); arr = r as JsonArray ?? r?["list"] as JsonArray ?? []; } catch { } Render(); };
        return p;
    }

    // ---------------------------------------------------------------- mémoire IA : fiches, « À retenir », oublier
    public static UIElement Memory(MainWindow main, Window owner)
    {
        var p = new StackPanel(); var list = new StackPanel(); var q = Ui.Box(); q.ToolTip = "Chercher dans la mémoire…";
        p.Children.Add(Ui.Hint("Ce que Claude retient d'une session à l'autre. Corrige une fiche fausse, ajoute une note « À retenir » (donnée à Claude en premier dans ce dossier), ou oublie une fiche : les changements suivent la synchro."));
        p.Children.Add(q); p.Children.Add(list);
        async Task Load()
        {
            list.Children.Clear();
            try
            {
                var path = q.Text.Trim().Length > 0 ? $"/api/memory/ai/search?q={Uri.EscapeDataString(q.Text.Trim())}" : "/api/memory/ai/cards";
                var r = await main.server.Api(HttpMethod.Get, path);
                var arr = r as JsonArray ?? r?["cards"] as JsonArray ?? r?["results"] as JsonArray ?? r?["items"] as JsonArray ?? [];
                foreach (var c in arr.OfType<JsonObject>().Take(100))
                {
                    var id = (string?)c["id"] ?? (string?)c["sessionId"];
                    var open = Ui.Btn("Ouvrir", async (_, _) => await Card(main, owner, id!, Load));
                    open.IsEnabled = id != null;
                    list.Children.Add(Card(RowWith(Two((string?)c["title"] ?? (string?)c["subject"] ?? "fiche", string.Join(" · ", new[] { (string?)c["cwd"], (string?)c["machine"], (string?)c["date"] }.Where(x => !string.IsNullOrEmpty(x)))), open)));
                }
                if (arr.Count == 0) list.Children.Add(Ui.Hint("Aucune fiche."));
            }
            catch (Exception e) { list.Children.Add(Ui.Hint(e.Message)); }
        }
        q.TextChanged += async (_, _) => await Load();
        p.Loaded += async (_, _) => await Load();
        return p;
    }
    static async Task Card(MainWindow main, Window owner, string id, Func<Task> reload)
    {
        JsonObject? c;
        try { c = await main.server.Api(HttpMethod.Get, $"/api/memory/ai/cards/{id}") as JsonObject; } catch (Exception e) { MessageBox.Show(owner, e.Message); return; }
        if (c == null) return;
        var w = Ui.Dialog(owner, "Fiche mémoire", 720);
        var title = Ui.Box((string?)c["title"] ?? ""); var note = Ui.Box((string?)c["note"] ?? "", true, 3);
        var detail = new TextBox { Text = string.Join("\n\n", c.Where(kv => kv.Value is JsonValue && kv.Key is not ("id" or "title" or "note")).Select(kv => $"{kv.Key} : {kv.Value}")), IsReadOnly = true, TextWrapping = TextWrapping.Wrap, Height = 260, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, FontSize = 12 };
        var save = Ui.Btn("Enregistrer", async (_, _) => { await main.Try(() => main.server.Api(HttpMethod.Patch, $"/api/memory/ai/cards/{id}", new { title = title.Text, note = note.Text })); w.DialogResult = true; }, "Primary");
        var forget = Ui.Btn("Oublier cette fiche", async (_, _) => { if (MessageBox.Show(w, "Oublier cette fiche ?", "Mémoire", MessageBoxButton.YesNo) == MessageBoxResult.Yes) { await main.Try(() => main.server.Api(HttpMethod.Patch, $"/api/memory/ai/cards/{id}", new { forget = true })); w.DialogResult = true; } }, "Danger");
        var close = Ui.Btn("Fermer"); close.IsCancel = true;
        var foot = Ui.Footer(close, save); forget.Margin = new Thickness(0); DockPanel.SetDock(forget, Dock.Left); foot.Children.Add(forget);
        w.Content = Ui.Body(Ui.H2("Fiche mémoire"), Ui.Label("Titre"), title, Ui.Label("À retenir (donné à Claude en premier dans ce dossier)"), note, Ui.Label("Contenu"), detail, foot);
        if (w.ShowDialog() == true) await reload();
    }

    // ---------------------------------------------------------------- transfert (.csmx)
    public static UIElement Transfer(MainWindow main, Window owner)
    {
        var p = new StackPanel();
        p.Children.Add(Ui.Hint("Pour changer d’ordinateur sans synchronisation : un fichier avec toutes les sessions de cette machine (noms, dossiers, groupes, options), leurs conversations, les groupes, les modèles, les extensions importées et la mémoire des sessions. Copie-le sur le nouvel ordinateur (clé USB, cloud…) et importe-le ici. Rien n’est envoyé sur internet."));
        var withTx = new CheckBox { Content = "Avec les conversations (reprises avec « Reprendre » sur l’autre ordinateur)", IsChecked = true, Margin = new Thickness(0, 8, 0, 0) };
        var pw = new PasswordBox(); var pw2 = new PasswordBox();
        var exp = Ui.Btn("Exporter les sessions…", async (_, _) =>
        {
            if (pw.Password != pw2.Password) { MessageBox.Show(owner, "Les deux mots de passe ne correspondent pas."); return; }
            var d = new Microsoft.Win32.SaveFileDialog { Filter = "Sessions CSM|*.csmx", FileName = $"sessions-{Environment.MachineName.ToLowerInvariant()}.csmx" };
            if (d.ShowDialog(owner) != true) return;
            await main.Try(async () => { var r = await main.server.Api(HttpMethod.Post, "/api/transfer/export", new { path = d.FileName, password = pw.Password, transcripts = withTx.IsChecked == true }); MessageBox.Show(owner, $"Exporté : {(string?)r?["path"]}", "Transfert"); });
        }, "Primary");
        exp.Margin = new Thickness(0, 10, 0, 0); exp.HorizontalAlignment = HorizontalAlignment.Left;
        var ex = new StackPanel(); ex.Children.Add(new TextBlock { Text = "Exporter", FontWeight = FontWeights.SemiBold }); ex.Children.Add(withTx);
        ex.Children.Add(Ui.Label("Mot de passe")); ex.Children.Add(pw); ex.Children.Add(Ui.Label("Confirmer")); ex.Children.Add(pw2);
        ex.Children.Add(Ui.Hint("Mot de passe conseillé : le fichier contient tes conversations. Il sera demandé à l’import.")); ex.Children.Add(exp);
        p.Children.Add(Card(ex));

        var ipw = new PasswordBox(); var info = Ui.Hint("");
        var choose = Ui.Btn("Choisir un fichier .csmx…", async (_, _) =>
        {
            var d = new Microsoft.Win32.OpenFileDialog { Filter = "Sessions CSM|*.csmx" };
            if (d.ShowDialog(owner) != true) return;
            await main.Try(async () =>
            {
                using var content = new StreamContent(File.OpenRead(d.FileName));
                await main.server.Upload("/api/transfer/upload", content);
                info.Text = $"{Path.GetFileName(d.FileName)} reçu. Saisis son mot de passe puis « Ouvrir ».";
            });
        });
        var open = Ui.Btn("Ouvrir", async (_, _) => await main.Try(async () => { var r = await main.server.Api(HttpMethod.Post, "/api/transfer/preview", new { password = ipw.Password }); info.Text = $"{r?["sessions"]?.ToString() ?? "?"} session(s) dans ce fichier."; }));
        var imp = Ui.Btn("Importer", async (_, _) => await main.Try(async () => { var r = await main.server.Api(HttpMethod.Post, "/api/transfer/import", new { password = ipw.Password }); info.Text = "Importé : " + r?.ToJsonString(); }), "Primary");
        var im = new StackPanel(); im.Children.Add(new TextBlock { Text = "Importer", FontWeight = FontWeights.SemiBold }); choose.Margin = new Thickness(0, 8, 0, 0); choose.HorizontalAlignment = HorizontalAlignment.Left; im.Children.Add(choose);
        im.Children.Add(Ui.Label("Mot de passe du fichier")); im.Children.Add(ipw); var r2 = Ui.Row(open, imp); r2.Margin = new Thickness(-6, 10, 0, 0); im.Children.Add(r2); im.Children.Add(info);
        im.Children.Add(Ui.Hint("Une session déjà présente ici (même conversation) n’est pas ajoutée en double, et une conversation déjà présente n’est jamais remplacée. Dossier introuvable sur cet ordinateur : la session s’ouvre dans le dossier personnel. Les réglages et le code de synchro ne sont pas exportés."));
        p.Children.Add(Card(im));
        return p;
    }

    // ---------------------------------------------------------------- machines synchronisées (et pilotage)
    public static UIElement Machines(MainWindow main, Window owner)
    {
        var p = new StackPanel(); var list = new StackPanel();
        p.Children.Add(Ui.Label("Machines")); p.Children.Add(list);
        async Task Load()
        {
            list.Children.Clear();
            try
            {
                var r = await main.server.Api(HttpMethod.Get, "/api/sync/machines");
                JsonArray pilots = [];
                try { pilots = await main.server.Api(HttpMethod.Get, "/api/remote/machines") as JsonArray ?? []; } catch { }
                foreach (var m in (r?["machines"] as JsonArray ?? []).OfType<JsonObject>())
                {
                    var seen = m["seen"] is JsonValue v && v.TryGetValue<double>(out var t) && t > 0 ? DateTimeOffset.FromUnixTimeMilliseconds((long)t).LocalDateTime.ToString("dd/MM HH:mm") : "jamais";
                    var me = (bool?)m["me"] == true;
                    var pilot = pilots.OfType<JsonObject>().FirstOrDefault(x => (string?)x["name"] == (string?)m["name"] && (bool?)x["remote"] == true);
                    var btns = new List<UIElement>();
                    if (pilot != null) btns.Add(Ui.Btn("Piloter", async (_, _) => await main.Try(async () =>
                    {
                        var o = await main.server.Api(HttpMethod.Post, "/api/remote/open", new { dev = (string?)pilot["dev"] });
                        if ((string?)o?["url"] is { } u) System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(u) { UseShellExecute = true });
                    }), "Primary"));
                    if (!me) btns.Add(Ui.Btn("Oublier", async (_, _) => { await main.Try(() => main.server.Api(HttpMethod.Delete, $"/api/sync/machines/{m["id"]}")); await Load(); }, "Danger"));
                    list.Children.Add(Card(RowWith(Two($"{m["name"]}{(me ? " (cette machine)" : "")}", $"{m["platform"]} · {m["version"]} · vue {seen}"), btns.ToArray())));
                }
                if (list.Children.Count == 0) list.Children.Add(Ui.Hint("Synchronisation désactivée."));
            }
            catch (Exception e) { list.Children.Add(Ui.Hint(e.Message)); }
        }
        p.Loaded += async (_, _) => await Load();
        return p;
    }
}
