using WinForms = System.Windows.Forms;

namespace CsmNative;

// Zone de notification : icône (ouvrir, nouvelle session, quitter) et notifications système. Fermer la fenêtre range
// l'app ici, les sessions continuent (comme l'app Electron).
public sealed class Tray : IDisposable
{
    readonly WinForms.NotifyIcon icon;
    readonly MainWindow win;
    Action? onClick;
    bool hinted;

    public Tray(MainWindow win, Action quit)
    {
        this.win = win;
        var menu = new WinForms.ContextMenuStrip();
        menu.Items.Add("Ouvrir Claude Sessions", null, (_, _) => win.Reveal());
        menu.Items.Add(new WinForms.ToolStripSeparator());
        menu.Items.Add("Quitter (les sessions continuent)", null, (_, _) => quit());
        icon = new WinForms.NotifyIcon
        {
            Text = "Claude Sessions", Visible = true, ContextMenuStrip = menu,
            Icon = System.Drawing.Icon.ExtractAssociatedIcon(Environment.ProcessPath!) ?? System.Drawing.SystemIcons.Application,
        };
        icon.DoubleClick += (_, _) => win.Reveal();
        icon.BalloonTipClicked += (_, _) => { var a = onClick; onClick = null; if (a != null) win.Dispatcher.Invoke(a); else win.Reveal(); };
    }

    public void Toast(string title, string text, Action? click = null)
    {
        onClick = click;
        icon.ShowBalloonTip(6000, title, text, WinForms.ToolTipIcon.None);
    }

    // première fermeture de la fenêtre : dire où est passée l'app
    public void Hint()
    {
        if (hinted) return;
        hinted = true;
        Toast("Claude Sessions", "L'app reste ici, les sessions continuent. Clic droit › Quitter pour la fermer.");
    }

    public void Dispose() { icon.Visible = false; icon.Dispose(); }
}
