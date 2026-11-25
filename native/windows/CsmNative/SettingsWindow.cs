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
        ("Général", "closeToTray", "Fermer la fenêtre la garde dans la zone de notification (sinon l'app se ferme ; les sessions continuent)", "bool", "", ""),
        ("Terminal", "fontSize", "Taille du texte", "int", "9,28", ""),
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
    ];
    static readonly string[] Tabs = ["Général", "Terminal", "Alertes", "Sécurité", "Modèles", "Prompts", "Extensions", "Tâches programmées", "Mémoire", "Synchronisation", "Transfert", "Diagnostic", "Journaux", "À propos"];

    JsonObject st = new();
    readonly ListBox nav = DarkList();
    readonly ContentControl pane = new();

    public SettingsWindow(MainWindow owner) : base(owner, "Réglages", 1100, 820)
    {
        foreach (var t in Tabs) nav.Items.Add(new ListBoxItem { Content = t, Padding = new Thickness(12, 7, 12, 7), Foreground = Ui.R("Fg") });
        nav.Width = 220; nav.Background = Ui.R("Bar");
        nav.SelectionChanged += (_, _) => Show(Tabs[Math.Max(0, nav.SelectedIndex)]);
        var root = new DockPanel(); DockPanel.SetDock(nav, Dock.Left); root.Children.Add(nav);
        root.Children.Add(new ScrollViewer { Content = pane, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Padding = new Thickness(26, 20, 26, 20) });
        Content = root;
        Loaded += async (_, _) => { try { st = await main.server.Api(HttpMethod.Get, "/api/settings") as JsonObject ?? new(); } catch { } nav.SelectedIndex = 0; };
    }

    async Task Set(string key, JsonNode? value)
    {
        st[key] = value?.DeepClone();
        await main.Try(() => main.server.Api(HttpMethod.Put, "/api/settings", new JsonObject { [key] = value?.DeepClone() }));
    }

    void Show(string tab)
    {
        var p = new StackPanel { MaxWidth = 780, HorizontalAlignment = HorizontalAlignment.Left };
        p.Children.Add(Ui.H2(tab));
        foreach (var d in Defs.Where(d => d.Tab == tab)) p.Children.Add(Control(d));
        switch (tab)
        {
            case "Synchronisation": p.Children.Insert(1, SyncBox()); break;
            case "Modèles": p.Children.Add(JsonList("/api/templates", "name", "Lancer, renommer ou supprimer les modèles créés avec « Enregistrer comme modèle »")); break;
            case "Prompts": p.Children.Add(Ui.Btn("Ouvrir la bibliothèque de prompts", (_, _) => new PromptsWindow(main).ShowDialog())); break;
            case "Extensions": p.Children.Add(JsonList("/api/extensions", "name", "Extensions importées (fichier .csm.json, lien GitHub, gist ou https)")); break;
            case "Tâches programmées": p.Children.Add(JsonList("/api/schedules", "text", "Demandes envoyées à une session à heure fixe")); break;
            case "Mémoire": p.Children.Add(JsonList("/api/memory/ai/cards", "title", "Ce que Claude retient d'une session à l'autre. Corrige une fiche fausse, ajoute une note « À retenir » (donnée à Claude en premier dans ce dossier), ou oublie une fiche : les changements suivent la synchro.")); break;
            case "Transfert": p.Children.Add(Ui.Hint("Pour changer d’ordinateur sans synchronisation : un fichier avec toutes les sessions de cette machine (noms, dossiers, groupes, options), leurs conversations, les groupes, les modèles, les extensions importées et la mémoire des sessions. Copie-le sur le nouvel ordinateur (clé USB, cloud…) et importe-le ici. Rien n’est envoyé sur internet.")); break;
            case "Diagnostic": p.Children.Add(TextFrom("/api/diag")); break;
            case "Journaux": p.Children.Add(TextFrom("/api/logs")); break;
            case "À propos": p.Children.Add(Ui.Hint($"Claude Sessions natif · serveur {main.server.Version} · port {main.server.Port}")); break;
        }
        pane.Content = p;
    }

    UIElement Control((string Tab, string Key, string Label, string Kind, string Opts, string Hint) d)
    {
        var box = new StackPanel { Margin = new Thickness(0, 8, 0, 4) };
        var v = st[d.Key];
        switch (d.Kind)
        {
            case "bool":
                var cb = new CheckBox { Content = new TextBlock { Text = d.Label, TextWrapping = TextWrapping.Wrap }, IsChecked = v is JsonValue b && b.TryGetValue<bool>(out var x) && x };
                cb.Click += async (_, _) => await Set(d.Key, cb.IsChecked == true);
                box.Children.Add(cb); break;
            case "enum":
                var opts = d.Opts.Split('|').Select(o => o.Split('=', 2)).ToList();
                var cur = v?.ToString() ?? "";
                var combo = Ui.Combo(opts.Select(o => o[1]), Math.Max(0, opts.FindIndex(o => o[0] == cur))); combo.Width = 320; combo.HorizontalAlignment = HorizontalAlignment.Left;
                combo.SelectionChanged += async (_, _) =>
                {
                    var raw = opts[combo.SelectedIndex][0];
                    await Set(d.Key, v is JsonValue nv && nv.TryGetValue<double>(out _) && double.TryParse(raw, out var num) ? JsonValue.Create(num) : JsonValue.Create(raw));
                };
                box.Children.Add(Ui.Label(d.Label)); box.Children.Add(combo); break;
            case "int":
                var t = Ui.Box(v?.ToString() ?? ""); t.Width = 120; t.HorizontalAlignment = HorizontalAlignment.Left;
                t.LostFocus += async (_, _) => { if (int.TryParse(t.Text, out var n)) await Set(d.Key, n); };
                box.Children.Add(Ui.Label(d.Label)); box.Children.Add(t); break;
            default:
                var tb = Ui.Box((string?)v ?? ""); tb.Width = 420; tb.HorizontalAlignment = HorizontalAlignment.Left;
                tb.LostFocus += async (_, _) => await Set(d.Key, tb.Text);
                box.Children.Add(Ui.Label(d.Label)); box.Children.Add(tb); break;
        }
        if (d.Hint.Length > 0) box.Children.Add(Ui.Hint(d.Hint));
        return box;
    }

    UIElement SyncBox()
    {
        var p = new StackPanel();
        p.Children.Add(Ui.Hint("Retrouve tes sessions (nom, dossier, modèle, groupe) et leurs conversations sur tes autres machines. Les conversations sont chiffrées avec ton code avant l’envoi : le serveur ne peut pas les lire. Seules les machines qui partagent le même code se voient."));
        var status = Ui.Hint("…");
        var code = Ui.Box(); code.Width = 320;
        p.Children.Add(status);
        p.Children.Add(Ui.Row(
            Ui.Btn("Synchroniser maintenant", async (_, _) => { await main.Try(() => main.server.Api(HttpMethod.Post, "/api/sync/now")); await Refresh(); }, "Primary"),
            Ui.Btn("Copier le code", (_, _) => { if (((string?)st["syncCode"])?.Length > 0) Clipboard.SetText((string?)st["syncCode"]!); }),
            Ui.Btn("Désactiver", async (_, _) => { if (MessageBox.Show(this, "Désactiver la synchronisation sur cette machine ?", "Synchronisation", MessageBoxButton.YesNo) == MessageBoxResult.Yes) { await Set("syncCode", ""); await Refresh(); } }, "Danger")));
        p.Children.Add(Ui.Label("J'ai déjà un code (créé sur une autre machine) :"));
        p.Children.Add(Ui.Row(code, Ui.Btn("Activer", async (_, _) => { await main.Try(() => main.server.Api(HttpMethod.Post, "/api/sync/code", new { code = code.Text.Trim() })); await Refresh(); }),
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
        return Card(p, 16);
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
        var box = new TextBox { IsReadOnly = true, TextWrapping = TextWrapping.Wrap, FontFamily = new FontFamily("Cascadia Mono, Consolas"), FontSize = 12, MinHeight = 400, Text = "Chargement…" };
        box.Loaded += async (_, _) => { try { var r = await main.server.Api(HttpMethod.Get, path); box.Text = (string?)r?["text"] ?? r?.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true }) ?? ""; } catch (Exception e) { box.Text = e.Message; } };
        return box;
    }
}
