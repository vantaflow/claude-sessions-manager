using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace CsmNative;

// Client du serveur CSM local (le même que celui de l'app Electron) : API HTTP + WebSocket /ws.
// Le serveur garde tout (sessions, terminaux, synchro, mémoire, veille) : cette app n'est qu'un affichage natif.
public sealed class CsmServer : IAsyncDisposable
{
    public int Port { get; }
    public string DataDir { get; }
    public string Token { get; private set; } = "";
    readonly HttpClient http = new();
    ClientWebSocket? ws;
    readonly CancellationTokenSource cts = new();
    readonly SemaphoreSlim sendLock = new(1, 1);

    public event Action<JsonArray>? SessionsReceived;      // { t: 'sessions', list }
    public event Action<JsonObject>? SessionUpdated;       // { t: 'session', s }
    public event Action<string>? SessionRemoved;           // { t: 'removed', id }
    public event Action<string, string, bool>? Output;     // id, données, replay (contenu complet)
    public event Action<string>? Clear;                    // { t: 'clear', id }
    public event Action? Quota;                            // { t: 'quota' } : relevé de quota à relire (/api/quota)
    public string Version { get; private set; } = "";
    public event Action<string>? Disconnected;

    public CsmServer(int port = 7890)
    {
        Port = int.TryParse(Environment.GetEnvironmentVariable("CSM_PORT"), out var p) ? p : port;
        var root = Environment.GetEnvironmentVariable("CSM_DATA")
            ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "claude-sessions");
        DataDir = Port == 7890 || Environment.GetEnvironmentVariable("CSM_DATA") != null ? root : $"{root}-{Port}";
        http.BaseAddress = new Uri($"http://127.0.0.1:{Port}");
        http.Timeout = TimeSpan.FromSeconds(60);
    }

    async Task<bool> Alive()
    {
        try { using var r = await http.GetAsync("/", cts.Token); return r.IsSuccessStatusCode; } catch { return false; }
    }

    // Serveur déjà lancé (app Electron, tâche planifiée) : utilisé tel quel ; sinon lancé ici.
    public async Task EnsureRunningAsync()
    {
        if (!await Alive())
        {
            StartServer();
            for (var i = 0; i < 60 && !await Alive(); i++) await Task.Delay(500, cts.Token);
            if (!await Alive()) throw new InvalidOperationException($"Le serveur CSM ne répond pas sur le port {Port}.");
        }
        var tokenFile = Path.Combine(DataDir, "token");
        for (var i = 0; i < 20 && !File.Exists(tokenFile); i++) await Task.Delay(250, cts.Token);
        Token = File.ReadAllText(tokenFile).Trim();
        http.DefaultRequestHeaders.Remove("X-CSM-Token");
        http.DefaultRequestHeaders.Add("X-CSM-Token", Token);
        try { Version = (string?)(await Api(HttpMethod.Get, "/api/version"))?["version"] ?? ""; } catch { }
    }

    // Serveur à lancer :
    // - CSM_SERVER_JS (développement, dépôt avec ses node_modules) : avec le node du système ;
    // - sinon celui de l'app CSM installée, avec SON runtime (Electron en mode node) : son module des terminaux
    //   (node-pty) est compilé pour Electron, il ne se charge pas dans un autre node.
    void StartServer()
    {
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var installed = Path.Combine(local, "Programs", "claude-sessions-manager");
        var dev = Environment.GetEnvironmentVariable("CSM_SERVER_JS");
        var serverJs = string.IsNullOrEmpty(dev) ? Path.Combine(installed, "resources", "app", "server.js") : dev;
        if (!File.Exists(serverJs)) throw new FileNotFoundException("server.js de CSM introuvable : installe CSM (app Electron), qui fournit le serveur.", serverJs);
        var psi = new ProcessStartInfo { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Path.GetDirectoryName(serverJs)! };
        if (!string.IsNullOrEmpty(dev)) psi.FileName = FindOnPath("node.exe") ?? throw new FileNotFoundException("node.exe introuvable (CSM_SERVER_JS).");
        else
        {
            var electron = Directory.GetFiles(installed, "*.exe").FirstOrDefault(f => !Path.GetFileName(f).StartsWith("Uninstall", StringComparison.OrdinalIgnoreCase));
            psi.FileName = electron ?? throw new FileNotFoundException("app CSM installée introuvable.");
            psi.Environment["ELECTRON_RUN_AS_NODE"] = "1";
        }
        psi.ArgumentList.Add(serverJs);
        psi.ArgumentList.Add($"--port={Port}");
        Process.Start(psi);
    }

    static string? FindOnPath(string exe) =>
        (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator)
            .Select(d => { try { return Path.Combine(d.Trim(), exe); } catch { return ""; } })
            .FirstOrDefault(File.Exists);

    public async Task ConnectAsync()
    {
        ws = new ClientWebSocket();
        ws.Options.SetRequestHeader("Host", $"127.0.0.1:{Port}");
        await ws.ConnectAsync(new Uri($"ws://127.0.0.1:{Port}/ws?token={Uri.EscapeDataString(Token)}"), cts.Token);
        _ = Task.Run(ReceiveLoop);
    }

    async Task ReceiveLoop()
    {
        var buf = new byte[1 << 16];
        var ms = new MemoryStream();
        try
        {
            while (ws!.State == WebSocketState.Open && !cts.IsCancellationRequested)
            {
                var r = await ws.ReceiveAsync(buf, cts.Token);
                if (r.MessageType == WebSocketMessageType.Close) break;
                ms.Write(buf, 0, r.Count);
                if (!r.EndOfMessage) continue;
                var text = Encoding.UTF8.GetString(ms.GetBuffer(), 0, (int)ms.Length);
                ms.SetLength(0);
                Dispatch(text);
            }
        }
        catch (Exception e) when (e is not OperationCanceledException) { Disconnected?.Invoke(e.Message); return; }
        Disconnected?.Invoke("connexion fermée");
    }

    void Dispatch(string text)
    {
        JsonObject? m;
        try { m = JsonNode.Parse(text) as JsonObject; } catch { return; }
        if (m == null) return;
        switch ((string?)m["t"])
        {
            case "sessions": if (m["list"] is JsonArray l) SessionsReceived?.Invoke(l); break;
            case "session": if (m["s"] is JsonObject s) SessionUpdated?.Invoke(s); break;
            case "removed": SessionRemoved?.Invoke((string?)m["id"] ?? ""); break;
            case "replay": Output?.Invoke((string?)m["id"] ?? "", (string?)m["d"] ?? "", true); break;
            case "out": Output?.Invoke((string?)m["id"] ?? "", (string?)m["d"] ?? "", false); break;
            case "clear": Clear?.Invoke((string?)m["id"] ?? ""); break;
            case "quota": Quota?.Invoke(); break;
        }
    }

    public async Task SendAsync(object msg)
    {
        if (ws?.State != WebSocketState.Open) return;
        var bytes = JsonSerializer.SerializeToUtf8Bytes(msg);
        await sendLock.WaitAsync();
        try { await ws.SendAsync(bytes, WebSocketMessageType.Text, true, cts.Token); }
        catch { }
        finally { sendLock.Release(); }
    }

    public Task Input(string id, string d) => SendAsync(new { t = "input", id, d });
    public Task Resize(string id, int cols, int rows) => SendAsync(new { t = "resize", id, cols, rows });
    public Task Shown(IEnumerable<string> ids) => SendAsync(new { t = "shown", ids = ids.ToArray() });

    public async Task<JsonNode?> Api(HttpMethod method, string path, object? body = null)
    {
        using var req = new HttpRequestMessage(method, path);
        if (body != null) req.Content = JsonContent.Create(body);
        using var r = await http.SendAsync(req, cts.Token);
        var txt = await r.Content.ReadAsStringAsync();
        JsonNode? j = null;
        try { j = string.IsNullOrWhiteSpace(txt) ? null : JsonNode.Parse(txt); } catch { }
        if (!r.IsSuccessStatusCode) throw new InvalidOperationException((string?)j?["error"] ?? $"{(int)r.StatusCode} {r.ReasonPhrase}");
        return j;
    }

    public async ValueTask DisposeAsync()
    {
        cts.Cancel();
        try { if (ws?.State == WebSocketState.Open) await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "", CancellationToken.None); } catch { }
        ws?.Dispose(); http.Dispose();
    }
}
