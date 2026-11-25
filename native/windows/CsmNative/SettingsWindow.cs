using System.Net.Http;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace CsmNative;

// Réglages : mêmes onglets et mêmes réglages que l'interface web, enregistrés à chaque changement (PUT /api/settings).
public sealed class SettingsWindow : Screen
{
    // (onglet, clé, libellé, type, options « valeur=libellé|… » ou bornes, aide)
    static readonly (string Tab, string Key, string Label, string Kind, string Opts, string Hint)[] Defs =
    [
        ("Général", "theme", "Thème", "enum", "system=Système (suit Windows / macOS)|light=Clair|dark=Sombre", ""),
        ("Général", "lang", "Langue", "enum", "auto=Automatique|fr=Français|en=English", ""),
        ("Général", "replyLanguage", "Langue des réponses de Claude", "enum", "app=Celle de l'interface|fr=Français|en=English|es=Español|ar=العربية|de=Deutsch|it=Italiano|pt=Português|claude=Réglage de Claude Code", ""),
        ("Général", "defaultModel", "Modèle par défaut", "enum", "opus=opus|sonnet=sonnet|haiku=haiku|=défaut Claude Code", ""),
        ("Général", "defaultMode", "Mode par défaut", "enum", "=par défaut|acceptEdits=acceptEdits|plan=plan|bypassPermissions=bypassPermissions", ""),
        ("Général", "worktreeDefault", "Proposer un worktree git par défaut dans un dépôt", "bool", "", ""),
        ("Général", "editor", "Éditeur pour « Ouvrir dans »", "enum", "auto=Automatique|code=VS Code|cursor=Cursor|windsurf=Windsurf|zed=Zed|idea=IntelliJ IDEA|subl=Sublime Text|custom=Commande personnalisée", ""),
        ("Général", "editorCommand", "Commande personnalisée", "text", "", ""),
        ("Général", "authReminder", "🔑 Prévenir avant l'expiration de la connexion à Claude et la renouveler en un clic", "bool", "", ""),
        ("Général", "authWarnDays", "Prévenir combien de jours avant", "int", "1,30", ""),
        ("Général", "commitSignature", "Signer les commits et les PR faits par Claude", "bool", "", "Co-Authored-By: Claude…, « Generated with Claude Code », lien de la session. Décoché : aucune signature."),
        ("Général", "statusLine", "Afficher les quotas et l'heure de leur réinitialisation sous chaque session (si tu n'as pas ta propre barre d'état Claude Code)", "bool", "", ""),
        ("Général", "memoryAI", "Mémoire IA (recommandé)", "bool", "", "À la fin de chaque session, Haiku écrit un résumé fiable (sujet, état réel, prochaine étape) et retient les décisions, corrections et choses à faire. La session suivante du dossier le reçoit, et Claude peut chercher dans toute la mémoire. Coût : une petite part de ton quota, une fois par session."),
        ("Général", "queueQuotaPause", "Mettre la file d'attente en pause près de la limite des 5 h et la reprendre à la réinitialisation", "bool", "", ""),
        ("Général", "queueQuotaThreshold", "Seuil de la pause", "enum", "80=80 %|90=90 %|95=95 %|99=99 %", ""),
        ("Général", "queueResumeAfterLimit", "À la réinitialisation, relancer (« continue ») les sessions coupées par la limite", "bool", "", ""),
        ("Général", "sleepMinutes", "Mettre en veille une session au repos depuis", "enum", "0=Jamais|15=15 min|30=30 min|60=1 h|120=2 h|240=4 h", "Une session en veille libère la mémoire de son Claude et reste dans la liste. Elle reprend sa conversation dès que tu l'affiches ou lui envoies un message."),
        ("Général", "sleepOnPressure", "Mémoire de l'ordinateur presque pleine : mettre en veille sans attendre les sessions au repos depuis le plus longtemps", "bool", "", ""),
        ("Général", "autoCompactWindow", "Compactage automatique", "enum", "model=Fenêtre complète du modèle (recommandé)|400000=Vers 400 000 tokens|200000=Vers 200 000 tokens|claude=Réglage de Claude Code", "Si Claude compacte la conversation en boucle, c'est souvent une fenêtre trop petite imposée par CLAUDE_CODE_AUTO_COMPACT_WINDOW : « Fenêtre complète » la remplace pour les sessions de l'app."),
        ("Général", "trustFolders", "Faire confiance au dossier de chaque session", "bool", "", "Claude Code ne demande plus « Do you trust the files in this folder? » au lancement d'une session : son dossier est approuvé d'avance, quel qu'il soit."),
        ("Général", "spinnerDarija", "Messages d'attente de Claude en darija", "bool", "", "Pendant que Claude travaille, « Polishing… » ou « Thinking… » deviennent « Kan-khemem a sahbi… », « Sber m3aya chwia… », « Kan7fer f had lcode… »."),
        ("Général", "peerMessages", "Accepter les messages entre sessions", "bool", "", "Une session reçoit les messages de tes autres sessions même si leurs modes d'autorisation diffèrent (par exemple bypass et auto)."),
        ("Général", "rtk", "RTK : moins de tokens sur les commandes de Claude", "bool", "", ""),
        ("Général", "chromeAll", "Claude in Chrome dans toutes les sessions", "bool", "", "Lance chaque session avec --chrome : Claude peut piloter Chrome (extension Claude in Chrome requise)."),
        ("Général", "remoteAll", "Rendre toutes les sessions joignables (Remote Control)", "bool", "", "Chaque session apparaît dans l'app Claude (onglet Code) et sur claude.ai/code, et reçoit les messages des sessions de tes autres machines."),
        ("Général", "autoUpdate", "Mises à jour automatiques", "bool", "", ""),
        ("Général", "autoRestart", "Installer la mise à jour et redémarrer tout seul (fenêtre réduite ou en arrière-plan, ou après 5 min d'inactivité ; jamais pendant qu'une session travaille ; les sessions reviennent)", "bool", "", ""),
        ("Général", "compactSidebar", "Barre latérale compacte", "bool", "", ""),
        ("Général", "closeToTray", "Fermer la fenêtre la garde dans la zone de notification (sinon l'app se ferme ; les sessions continuent)", "bool", "", ""),
        ("Terminal", "fontSize", "Taille du texte", "int", "9,28", ""),
        ("Terminal", "fontFamily", "Police", "text", "", "Par exemple Cascadia Mono, Consolas. Vide : Cascadia Mono."),
        ("Terminal", "keepScrollback", "Garder l'historique du terminal quand Claude Code efface l'écran (compaction, /clear)", "bool", "", ""),
        ("Terminal", "classicTerminal", "Affichage classique de Claude Code", "bool", "", "Défilement à la molette, historique gardé et recherche dans le terminal. Décoché : son affichage plein écran, qui gère lui-même le défilement."),
        ("Alertes", "notifications", "Notifications système", "bool", "", "Quand une session attend ta réponse ou a fini (seulement si tu ne la regardes pas)."),
        ("Alertes", "sound", "Son", "enum", "off=Aucun|soft=Doux|bell=Cloche", ""),
        ("Alertes", "dnd", "Ne pas déranger", "bool", "", ""),
        ("Alertes", "waitingMinutes", "Rappel si une session attend depuis (min, 0 = jamais)", "int", "0,240", ""),
        ("Alertes", "longRunMinutes", "Alerte si une session travaille plus de (min, 0 = jamais)", "int", "0,600", ""),
        ("Sécurité", "lockOnHide", "Reverrouiller les sessions protégées quand la fenêtre est masquée", "bool", "", ""),
        ("Sécurité", "autoLockMinutes", "Reverrouiller après N minutes d'inactivité (0 = jamais)", "int", "0,240", ""),
        ("Sécurité", "remoteControl", "Autoriser le pilotage de cette machine depuis mes autres machines", "bool", "", ""),
        ("Synchronisation", "syncTranscripts", "Conversations — historique et contexte, chiffrés", "bool", "", ""),
        ("Synchronisation", "syncGroups", "Groupes — groupes vides compris, dans l'ordre", "bool", "", ""),
        ("Synchronisation", "syncTemplates", "Modèles de session — chiffrés", "bool", "", ""),
        ("Synchronisation", "syncPlugins", "Plugins Claude Code — les mêmes sur toutes les machines", "bool", "", ""),
        ("Synchronisation", "syncUsage", "Usage de Claude — temps, coût et tokens, chiffrés ; jamais de conversation", "bool", "", ""),
        ("Synchronisation", "syncExtensions", "Extensions importées — installées sur les autres machines, chiffrées", "bool", "", ""),
        ("Synchronisation", "syncSessionMemory", "Mémoire des sessions — chiffrée", "bool", "", ""),
        ("Synchronisation", "syncSecrets", "Coffre — PAT et tokens de services, chiffrés de bout en bout", "bool", "", ""),
        ("Synchronisation", "syncClaudeRules", "Règles : ~/.claude/CLAUDE.md, ~/.claude/rules", "bool", "", ""),
        ("Synchronisation", "syncClaudeSkills", "Skills : ~/.claude/skills", "bool", "", ""),
        ("Synchronisation", "syncClaudeAgents", "Agents et commandes", "bool", "", ""),
        ("Synchronisation", "syncClaudeMemory", "Notes de Claude Code (dossiers memory/)", "bool", "", ""),
        ("Synchronisation", "claudeSyncReview", "Me demander avant d'appliquer les règles, skills, agents, commandes et plugins reçus", "bool", "", ""),
        ("Synchronisation", "syncMinutes", "Synchronisation automatique toutes les", "enum", "5=5 min|10=10 min|30=30 min|60=1 h", ""),
        ("Synchronisation", "syncMachine", "Nom de cette machine", "text", "", ""),
        ("Synchronisation", "syncRoots", "Racines de dossiers (une par ligne, alias=chemin)", "lines", "", "Le dossier personnel est reconnu tout seul ({home}). Déclare le même alias sur chaque machine pour les dossiers rangés ailleurs (ex. code=D:\\dev sur le PC, code=~/dev sur le Mac)."),
        ("Synchronisation", "syncServer", "Serveur de synchro", "text", "", "Vide = serveur par défaut. Pour héberger le tien, voir sync-worker/ dans le dépôt."),
    ];
    static readonly string[] Tabs = ["Général", "Terminal", "Alertes", "Sécurité", "Modèles", "Prompts", "Extensions", "Tâches programmées", "Mémoire", "Synchronisation", "Transfert", "Diagnostic", "Journaux", "À propos"];

    JsonObject st = new();
    readonly StackPanel nav = new() { Margin = new Thickness(0) };
    readonly List<(Border Box, TextBlock Text)> navItems = [];
    readonly ContentControl pane = new();
    readonly TextBlock hdr = new() { Text = "Réglages" };

    // Maquette « Settings » : bandeau de 52 px, onglets à gauche (230 px), réglages en sections et en cartes à interrupteurs
    public SettingsWindow(MainWindow owner, string? tab = null) : base(owner, "Réglages", 1100, 820)
    {
        var startTab = Math.Max(0, Array.IndexOf(Tabs, tab));
        this.SetResourceReference(BackgroundProperty, "Bg");
        for (var i = 0; i < Tabs.Length; i++)
        {
            var idx = i;
            var tx = new TextBlock { Text = Tabs[i], VerticalAlignment = VerticalAlignment.Center };
            var b = new Border { Height = 34, CornerRadius = new CornerRadius(7), Padding = new Thickness(12, 0, 12, 0), Margin = new Thickness(0, 0, 0, 2), Cursor = System.Windows.Input.Cursors.Hand, Background = Brushes.Transparent, Child = tx };
            b.MouseLeftButtonUp += (_, _) => Select(idx);
            navItems.Add((b, tx)); nav.Children.Add(b);
        }
        var side = new Border { Width = 230, Padding = new Thickness(8, 12, 8, 12), BorderThickness = new Thickness(0, 0, 1, 0), Child = nav };
        side.SetResourceReference(Border.BackgroundProperty, "Panel"); side.SetResourceReference(Border.BorderBrushProperty, "Line");
        var title = hdr; hdr.FontSize = 16; hdr.FontWeight = FontWeights.SemiBold; hdr.VerticalAlignment = VerticalAlignment.Center;
        var header = new Border { Height = 52, Padding = new Thickness(20, 0, 20, 0), BorderThickness = new Thickness(0, 0, 0, 1), Child = title };
        header.SetResourceReference(Border.BackgroundProperty, "Panel"); header.SetResourceReference(Border.BorderBrushProperty, "Line");
        var root = new DockPanel();
        DockPanel.SetDock(header, Dock.Top); root.Children.Add(header);
        DockPanel.SetDock(side, Dock.Left); root.Children.Add(side);
        root.Children.Add(new ScrollViewer { Content = pane, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Padding = new Thickness(32, 24, 32, 24) });
        Content = root;
        Loaded += async (_, _) => { try { st = await main.server.Api(HttpMethod.Get, "/api/settings") as JsonObject ?? new(); } catch { } Select(startTab); };
    }

    void Select(int i)
    {
        for (var k = 0; k < navItems.Count; k++)
        {
            var on = k == i; var (b, t) = navItems[k];
            if (on) b.SetResourceReference(Border.BackgroundProperty, "Sel"); else { b.ClearValue(Border.BackgroundProperty); b.Background = Brushes.Transparent; }
            t.SetResourceReference(TextBlock.ForegroundProperty, on ? "Fg" : "Dim"); t.FontWeight = on ? FontWeights.SemiBold : FontWeights.Normal;
        }
        hdr.Text = i == 0 ? "Réglages" : "Réglages › " + Tabs[i];
        Show(Tabs[i]);
    }

    async Task Set(string key, JsonNode? value)
    {
        st[key] = value?.DeepClone();
        await main.Try(async () => main.ApplySettings(await main.server.Api(HttpMethod.Put, "/api/settings", new JsonObject { [key] = value?.DeepClone() })));
    }

    void Show(string tab)
    {
        var blocks = new List<UIElement>();
        if (tab == "Général")
        {
            var ic = new TextBlock { Text = "\uE192", FontFamily = PaletteWindow.Icons, Margin = new Thickness(0, 0, 8, 0), VerticalAlignment = VerticalAlignment.Center };
            var login = Ui.Btn("", (_, _) => new AuthWindow(main).ShowDialog()); login.Content = Ui.Row(ic, new TextBlock { Text = "Se connecter à Claude…", VerticalAlignment = VerticalAlignment.Center });
            login.Margin = new Thickness(0); login.HorizontalAlignment = HorizontalAlignment.Left; blocks.Add(login);
        }
        var defs = Defs.Where(d => d.Tab == tab).ToList();
        var header = tab == "Général" ? "Apparence" : tab; var first = true;
        var fields = defs.Where(d => d.Kind != "bool" && d.Key != "sleepMinutes").ToList();
        var split = tab == "Général" ? fields.FindIndex(d => d.Key == "lang") + 1 : 0;
        if (split > 0) { blocks.Add(Section(header, FieldGrid(fields.Take(split).ToList()))); fields = fields.Skip(split).ToList(); first = false; }
        if (fields.Count > 0) { blocks.Add(Section(first ? header : null, FieldGrid(fields))); first = false; }
        var toggles = defs.Where(d => d.Kind == "bool").ToList();
        if (tab == "Synchronisation") { blocks.Insert(0, SyncChecks(toggles)); }
        else if (toggles.Count > 0) blocks.Add(BoolCard(toggles));
        foreach (var d in defs.Where(d => d.Key == "sleepMinutes")) blocks.Add(Section("Veille des sessions", InlineField(d)));
        switch (tab)
        {
            case "Synchronisation": blocks.Insert(0, SyncBox()); break;
            case "Modèles": blocks.Add(SettingsParts.Templates(main, this)); break;
            case "Prompts": blocks.Add(Ui.Btn("Ouvrir la bibliothèque de prompts", (_, _) => new PromptsWindow(main).ShowDialog())); break;
            case "Extensions": blocks.Add(SettingsParts.Extensions(main, this)); blocks.Add(Ui.Btn("Skills disponibles…", (_, _) => new SkillsWindow(main).ShowDialog())); break;
            case "Tâches programmées": blocks.Add(SettingsParts.Schedules(main, this)); break;
            case "Mémoire": blocks.Add(SettingsParts.Memory(main, this)); break;
            case "Transfert": blocks.Add(SettingsParts.Transfer(main, this)); break;
            case "Diagnostic": blocks.Add(TextFrom("/api/diag")); break;
            case "Journaux": blocks.Add(TextFrom("/api/logs")); break;
            case "À propos": blocks.Add(Ui.Hint($"Claude Sessions natif · serveur {main.server.Version} · port {main.server.Port}")); break;
        }
        var p = new StackPanel { MaxWidth = tab is "Synchronisation" or "Transfert" or "Mémoire" ? 1000 : 760, HorizontalAlignment = HorizontalAlignment.Left };
        foreach (var e in blocks) { if (p.Children.Count > 0 && e is FrameworkElement f) f.Margin = new Thickness(f.Margin.Left, 22, f.Margin.Right, f.Margin.Bottom); p.Children.Add(e); }
        pane.Content = p;
    }

    static StackPanel Section(string? title, UIElement body)
    {
        var p = new StackPanel();
        if (title != null) { var h = new TextBlock { Text = title.ToUpperInvariant(), FontSize = 12, FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 0, 0, 10) }; h.SetResourceReference(TextBlock.ForegroundProperty, "Muted"); p.Children.Add(h); }
        p.Children.Add(body); return p;
    }

    // interrupteurs réunis dans une carte : titre, texte d'aide, interrupteur à droite
    UIElement BoolCard(List<(string Tab, string Key, string Label, string Kind, string Opts, string Hint)> rows)
    {
        var col = new StackPanel();
        for (var i = 0; i < rows.Count; i++)
        {
            var d = rows[i]; var v = st[d.Key];
            var sw = new System.Windows.Controls.Primitives.ToggleButton { Style = Ui.S("Switch"), IsChecked = v is JsonValue b && b.TryGetValue<bool>(out var x) && x, VerticalAlignment = VerticalAlignment.Top };
            sw.Click += async (_, _) => await Set(d.Key, sw.IsChecked == true);
            var left = new StackPanel();
            left.Children.Add(new TextBlock { Text = d.Label.Replace("🔑 ", ""), FontWeight = FontWeights.Medium, TextWrapping = TextWrapping.Wrap });
            if (d.Hint.Length > 0) { var h = new TextBlock { Text = d.Hint, FontSize = 12, LineHeight = 18, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 4, 0, 0) }; h.SetResourceReference(TextBlock.ForegroundProperty, "Muted"); left.Children.Add(h); }
            var g = new Grid(); g.ColumnDefinitions.Add(new ColumnDefinition()); g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            sw.Margin = new Thickness(16, 0, 0, 0); Grid.SetColumn(sw, 1); g.Children.Add(left); g.Children.Add(sw);
            var row = new Border { Padding = new Thickness(16, 14, 16, 14), BorderThickness = new Thickness(0, 0, 0, i < rows.Count - 1 ? 1 : 0), Child = g };
            row.SetResourceReference(Border.BorderBrushProperty, "Hover");
            col.Children.Add(row);
        }
        var card = new Border { CornerRadius = new CornerRadius(12), BorderThickness = new Thickness(1), Child = col };
        card.SetResourceReference(Border.BackgroundProperty, "Panel"); card.SetResourceReference(Border.BorderBrushProperty, "Line");
        return card;
    }

    UIElement FieldGrid(List<(string Tab, string Key, string Label, string Kind, string Opts, string Hint)> run)
    {
        var g = new Grid(); g.ColumnDefinitions.Add(new ColumnDefinition()); g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(12) }); g.ColumnDefinitions.Add(new ColumnDefinition());
        int row = 0, col = 0;
        foreach (var d in run)
        {
            var wide = d.Kind is "text" or "lines";
            if (wide && col != 0) { row++; col = 0; }
            while (g.RowDefinitions.Count <= row) g.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            var f = FieldCtl(d); f.Margin = new Thickness(0, row == 0 ? 0 : 12, 0, 0);
            Grid.SetRow(f, row); Grid.SetColumn(f, col == 0 ? 0 : 2); if (wide) Grid.SetColumnSpan(f, 3);
            g.Children.Add(f);
            if (wide || col == 1) { row++; col = 0; } else col = 1;
        }
        return g;
    }

    FrameworkElement InlineField((string Tab, string Key, string Label, string Kind, string Opts, string Hint) d)
    {
        var f = FieldCtl(d, true); return f;
    }

    FrameworkElement FieldCtl((string Tab, string Key, string Label, string Kind, string Opts, string Hint) d, bool inline = false)
    {
        var box = new StackPanel();
        var v = st[d.Key];
        FrameworkElement ctl;
        switch (d.Kind)
        {
            case "enum":
                var opts = d.Opts.Split('|').Select(o => o.Split('=', 2)).ToList();
                var cur = v?.ToString() ?? "";
                var combo = Ui.Combo(opts.Select(o => o[1]), Math.Max(0, opts.FindIndex(o => o[0] == cur))); combo.Height = 34; combo.SetResourceReference(Control.BackgroundProperty, "Panel2");
                combo.SelectionChanged += async (_, _) =>
                {
                    var raw = opts[combo.SelectedIndex][0];
                    await Set(d.Key, v is JsonValue nv && nv.TryGetValue<double>(out _) && double.TryParse(raw, out var num) ? JsonValue.Create(num) : JsonValue.Create(raw));
                };
                ctl = combo; break;
            case "int":
                var t = Ui.Box(v?.ToString() ?? ""); t.Width = 120; t.HorizontalAlignment = HorizontalAlignment.Left;
                t.LostFocus += async (_, _) => { if (int.TryParse(t.Text, out var n)) await Set(d.Key, n); };
                ctl = t; break;
            case "lines":
                var ml = new TextBox { Text = (string?)v ?? "", AcceptsReturn = true, TextWrapping = TextWrapping.NoWrap, Height = 86, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, FontFamily = (FontFamily)Application.Current.FindResource("MonoFont") };
                ml.LostFocus += async (_, _) => await Set(d.Key, ml.Text);
                ctl = ml; break;
            default:
                var tb = Ui.Box((string?)v ?? "");
                tb.LostFocus += async (_, _) => await Set(d.Key, tb.Text);
                ctl = tb; break;
        }
        if (inline)
        {
            var row = new StackPanel { Orientation = Orientation.Horizontal };
            row.Children.Add(new TextBlock { Text = d.Label, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 12, 0), TextWrapping = TextWrapping.Wrap });
            ctl.MinWidth = 140; row.Children.Add(ctl); box.Children.Add(row);
        }
        else { box.Children.Add(Ui.Label(d.Label, 6)); box.Children.Add(ctl); }
        if (d.Hint.Length > 0) box.Children.Add(Ui.Hint(d.Hint));
        return box;
    }

    static WrapPanel WrapRow(params UIElement[] els) { var w = new WrapPanel { Margin = new Thickness(0, 6, 0, 0) }; foreach (var e in els) { if (e is FrameworkElement f && f is Button) f.Margin = new Thickness(0, 0, 8, 6); w.Children.Add(e); } return w; }

    UIElement SyncBox()
    {
        var p = new StackPanel();
        var intro = (Ui.Hint("Retrouve tes sessions (nom, dossier, modèle, groupe) et leurs conversations sur tes autres machines. Les conversations sont chiffrées avec ton code avant l’envoi : le serveur ne peut pas les lire. Seules les machines qui partagent le même code se voient."));
        intro.Margin = new Thickness(0, 0, 0, 14);
        var status = Ui.Hint("…");
        var code = Ui.Box(); code.Width = 200; code.Margin = new Thickness(0, 0, 8, 6);
        p.Children.Add(status);
        p.Children.Add(WrapRow(
            Ui.Btn("Synchroniser maintenant", async (_, _) => { await main.Try(() => main.server.Api(HttpMethod.Post, "/api/sync/now")); await Refresh(); }, "Primary"),
            Ui.Btn("Copier le code", (_, _) => { if (((string?)st["syncCode"])?.Length > 0) Clipboard.SetText((string?)st["syncCode"]!); }),
            Ui.Btn("Désactiver", async (_, _) => { if (MessageBox.Show(this, "Désactiver la synchronisation sur cette machine ?", "Synchronisation", MessageBoxButton.YesNo) == MessageBoxResult.Yes) { await Set("syncCode", ""); await Refresh(); } }, "Danger")));
        p.Children.Add(Ui.Label("J'ai déjà un code (créé sur une autre machine) :"));
        p.Children.Add(WrapRow(code, Ui.Btn("Activer", async (_, _) => { await main.Try(() => main.server.Api(HttpMethod.Post, "/api/sync/code", new { code = code.Text.Trim() })); await Refresh(); }),
            Ui.Btn("Créer un code", async (_, _) => { await main.Try(() => main.server.Api(HttpMethod.Post, "/api/sync/code", new { create = true })); await Refresh(); })));
        async Task Refresh()
        {
            try
            {
                var s = await main.server.Api(HttpMethod.Get, "/api/sync");
                st = await main.server.Api(HttpMethod.Get, "/api/settings") as JsonObject ?? st;
                status.Text = (bool?)s?["enabled"] != true ? "Synchronisation désactivée." : ((string?)s?["lastError"] is { Length: > 0 } e ? "⚠ " + e : "✓ Synchronisé") + $" · machine « {(string?)s?["machine"]} »";
            }
            catch (Exception e) { status.Text = e.Message; }
        }
        _ = Refresh();
        var host = new StackPanel(); host.Children.Add(intro);
        var two = new Grid(); two.ColumnDefinitions.Add(new ColumnDefinition()); two.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(18) }); two.ColumnDefinitions.Add(new ColumnDefinition());
        var left = Card(p, 18); left.CornerRadius = new CornerRadius(12); left.Margin = new Thickness(0);
        var right = Card(SettingsParts.Machines(main, this), 18); right.CornerRadius = new CornerRadius(12); right.Margin = new Thickness(0); Grid.SetColumn(right, 2);
        two.Children.Add(left); two.Children.Add(right); host.Children.Add(two);
        return host;
    }

    // « À synchroniser » : cases à cocher en deux colonnes, titre et texte d'aide
    UIElement SyncChecks(List<(string Tab, string Key, string Label, string Kind, string Opts, string Hint)> rows)
    {
        var g = new Grid(); g.ColumnDefinitions.Add(new ColumnDefinition()); g.ColumnDefinitions.Add(new ColumnDefinition());
        var col = new StackPanel(); var title = new TextBlock { Text = "À synchroniser", FontSize = 14, FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 0, 0, 10) }; col.Children.Add(title);
        int n = 0;
        UIElement Item(string key, string label)
        {
            var cut = label.IndexOf(" — "); var cut2 = label.IndexOf(": ");
            string head = label, hint = "";
            if (cut > 0) { head = label[..cut]; hint = label[(cut + 3)..]; } else if (cut2 > 0) { head = label[..cut2]; hint = label[(cut2 + 2)..]; }
            if (hint.Length > 0) hint = char.ToUpper(hint[0]) + hint[1..];
            var v = st[key];
            var cb = new CheckBox { IsChecked = v is JsonValue b && b.TryGetValue<bool>(out var x) && x, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 1, 10, 0) };
            cb.Click += async (_, _) => await Set(key, cb.IsChecked == true);
            var t = new StackPanel(); t.Children.Add(new TextBlock { Text = head, FontWeight = FontWeights.Medium, TextWrapping = TextWrapping.Wrap });
            if (hint.Length > 0) { var h = new TextBlock { Text = hint, FontSize = 12, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 2, 0, 0) }; h.SetResourceReference(TextBlock.ForegroundProperty, "Muted"); t.Children.Add(h); }
            t.MouseLeftButtonUp += async (_, _) => { cb.IsChecked = cb.IsChecked != true; await Set(key, cb.IsChecked == true); };
            var row = new DockPanel { Margin = new Thickness(0, 0, 16, 12) }; DockPanel.SetDock(cb, Dock.Left); row.Children.Add(cb); row.Children.Add(t);
            return row;
        }
        foreach (var d in rows.Where(d => d.Key != "claudeSyncReview"))
        {
            var it = Item(d.Key, d.Label);
            while (g.RowDefinitions.Count <= n / 2) g.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            Grid.SetRow(it, n / 2); Grid.SetColumn(it, n % 2); g.Children.Add(it); n++;
        }
        col.Children.Add(g);
        foreach (var d in rows.Where(d => d.Key == "claudeSyncReview")) col.Children.Add(Item(d.Key, d.Label));
        var card = new Border { CornerRadius = new CornerRadius(12), BorderThickness = new Thickness(1), Padding = new Thickness(18, 16, 2, 4), Child = col, Margin = new Thickness(0, 0, 0, 0) };
        card.SetResourceReference(Border.BackgroundProperty, "Bar"); card.SetResourceReference(Border.BorderBrushProperty, "Line");
        return card;
    }

    UIElement JsonList(string path, string field, string hint)
    {
        var p = new StackPanel(); p.Children.Add(Ui.Hint(hint));
        p.Loaded += async (_, _) =>
        {
            try
            {
                var r = await main.server.Api(HttpMethod.Get, path);
                var arr = r as JsonArray ?? r?["items"] as JsonArray ?? r?["list"] as JsonArray ?? r?["cards"] as JsonArray ?? [];
                foreach (var o in arr.OfType<JsonObject>()) p.Children.Add(Card(new TextBlock { Text = (string?)o[field] ?? (string?)o["name"] ?? (string?)o["title"] ?? o.ToJsonString(), TextTrimming = TextTrimming.CharacterEllipsis }, 10));
                if (arr.Count == 0) p.Children.Add(Ui.Hint("Rien pour l'instant."));
            }
            catch (Exception e) { p.Children.Add(Ui.Hint(e.Message)); }
        };
        return p;
    }
    UIElement TextFrom(string path)
    {
        var box = new TextBox { IsReadOnly = true, TextWrapping = TextWrapping.Wrap, FontFamily = (FontFamily)Application.Current.FindResource("MonoFont"), FontSize = 12, MinHeight = 400, Text = "Chargement…" };
        box.Loaded += async (_, _) => { try { var r = await main.server.Api(HttpMethod.Get, path); box.Text = (string?)r?["text"] ?? r?.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true }) ?? ""; } catch (Exception e) { box.Text = e.Message; } };
        return box;
    }
}
