using Microsoft.Terminal.Wpf;

namespace CsmNative;

// Pont entre le moteur de Windows Terminal (TerminalControl) et une session du serveur CSM :
// la frappe part par le WebSocket (« input »), la sortie du pty arrive par « out »/« replay ».
public sealed class SessionConnection(CsmServer server, string id) : ITerminalConnection
{
    public event EventHandler<TerminalOutputEventArgs>? TerminalOutput;
    bool started;
    readonly List<string> pending = [];

    public void Start()
    {
        started = true;
        foreach (var d in pending) TerminalOutput?.Invoke(this, new TerminalOutputEventArgs(d));
        pending.Clear();
    }

    public void Feed(string data)
    {
        if (!started) { pending.Add(data); return; }
        TerminalOutput?.Invoke(this, new TerminalOutputEventArgs(data));
    }

    public void WriteInput(string data) => _ = server.Input(id, data);
    public void Resize(uint rows, uint columns) => _ = server.Resize(id, (int)columns, (int)rows);
    public void Close() { }
}
