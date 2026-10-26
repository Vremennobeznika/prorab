using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Web.Script.Serialization;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class Program {
    [STAThread]
    private static void Main() {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        bool first;
        using (var mutex = new Mutex(true, "Local\\Prorab-Workspace-" + System.Security.Principal.WindowsIdentity.GetCurrent().User.Value, out first)) {
            if (!first) { MessageBox.Show("Прораб уже открыт. Переключитесь в существующее окно.", "Прораб"); return; }
            try { Application.Run(new WorkspaceWindow()); } finally { mutex.ReleaseMutex(); }
        }
    }
}

internal sealed class WorkspaceWindow : Form {
    private Process server;
    private WebView2 view;
    private readonly string userDir;
    private string readyFile;
    private Uri applicationOrigin;
    private bool closing;
    private readonly Label loading;

    public WorkspaceWindow() {
        Text = "Прораб — проекты и агенты";
        AutoScaleMode = AutoScaleMode.Dpi;
        var screen = Screen.FromPoint(Cursor.Position).WorkingArea;
        Width = Math.Min(1024, screen.Width - 32);
        Height = Math.Min(720, screen.Height - 32);
        MinimumSize = new Size(640, 480);
        StartPosition = FormStartPosition.CenterScreen;
        Icon = SystemIcons.Application;
        userDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Prorab");
        Directory.CreateDirectory(userDir);
        loading = new Label { Dock = DockStyle.Fill, Text = "Запускаю рабочее пространство…", TextAlign = ContentAlignment.MiddleCenter };
        Controls.Add(loading);
        Shown += async (s, e) => await StartWorkspace();
        FormClosing += (s, e) => { closing = true; StopServer(); };
    }

    private async Task StartWorkspace() {
        try {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            string executable = Path.Combine(root, "runtime", "node.exe");
            string script = Path.Combine(root, "app", "src", "main.js");
            if (!File.Exists(executable) || !File.Exists(script)) throw new Exception("Не найдены файлы программы. Переустановите Прораб.");
            readyFile = Path.Combine(userDir, "launch-" + Guid.NewGuid().ToString("N") + ".json");
            var start = new ProcessStartInfo(executable) {
                Arguments = "\"" + script + "\" --no-open --port 0 --ready-file \"" + readyFile + "\"",
                WorkingDirectory = Path.Combine(root, "app"), UseShellExecute = false, CreateNoWindow = true
            };
            start.EnvironmentVariables["PRORAB_USER_DIR"] = userDir;
            server = Process.Start(start);
            server.EnableRaisingEvents = true;
            server.Exited += (s, e) => {
                if (!closing && IsHandleCreated) BeginInvoke((MethodInvoker)(() => {
                    if (!closing) { MessageBox.Show(this, "Движок остановился. Закройте и снова откройте Прораб. Диалоги сохранены.", "Прораб"); Close(); }
                }));
            };
            string url = null;
            for (int i = 0; i < 300 && !closing; i++) {
                if (server.HasExited) throw new Exception("Не удалось запустить движок. Проверьте папку данных приложения.");
                if (File.Exists(readyFile)) {
                    var json = new JavaScriptSerializer().DeserializeObject(File.ReadAllText(readyFile, Encoding.UTF8)) as System.Collections.Generic.Dictionary<string, object>;
                    if (json != null && json.ContainsKey("url")) { url = Convert.ToString(json["url"]); break; }
                }
                await Task.Delay(100);
            }
            if (closing) return;
            if (url == null) throw new Exception("Движок не сообщил о готовности за 30 секунд.");
            applicationOrigin = new Uri(url);
            view = new WebView2 { Dock = DockStyle.Fill };
            Controls.Add(view);
            CoreWebView2EnvironmentOptions options = null;
            int testPort;
            if (int.TryParse(Environment.GetEnvironmentVariable("PRORAB_UI_TEST_PORT"), out testPort) && testPort > 1024 && testPort < 65536) {
                options = new CoreWebView2EnvironmentOptions("--remote-debugging-port=" + testPort);
            }
            var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(userDir, "WebView2"), options);
            if (closing) return;
            await view.EnsureCoreWebView2Async(environment);
            view.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
            view.CoreWebView2.Settings.AreDevToolsEnabled = false;
            view.CoreWebView2.Settings.IsStatusBarEnabled = false;
            view.CoreWebView2.NewWindowRequested += (s, e) => { e.Handled = true; };
            view.CoreWebView2.DownloadStarting += (s, e) => { e.Cancel = true; };
            view.CoreWebView2.NavigationStarting += (s, e) => { if (!IsApplicationUrl(e.Uri)) e.Cancel = true; };
            view.CoreWebView2.WebMessageReceived += ChooseFolder;
            view.KeyDown += async (s, e) => {
                if ((e.Control && e.KeyCode == Keys.V) || (e.Shift && e.KeyCode == Keys.Insert)) {
                    e.Handled = true; e.SuppressKeyPress = true;
                    if (!IsApplicationUrl(view.Source.AbsoluteUri)) return;
                    try {
                        string value = Clipboard.ContainsText() ? Clipboard.GetText() : "";
                        await view.CoreWebView2.ExecuteScriptAsync("window.ProrabInput && window.ProrabInput.insertClipboard(" + new JavaScriptSerializer().Serialize(value) + ")");
                    } catch { /* The Paste button can retry if another process owns the clipboard. */ }
                }
            };
            view.CoreWebView2.NavigationCompleted += (s, e) => {
                if (e.IsSuccess) {
                    loading.Visible = false;
                    view.BringToFront();
                    view.Focus();
                    // Testable readiness means the own window has rendered, not just an HTTP port.
                    File.WriteAllText(readyFile + ".desktop", "rendered", Encoding.UTF8);
                }
            };
            view.CoreWebView2.Navigate(url);
        } catch (Exception ex) {
            if (!closing) {
                MessageBox.Show(this, "Не удалось открыть рабочее пространство: " + ex.Message + "\nДля окна приложения требуется Microsoft Edge WebView2 Runtime. Повторите установку Прораба.", "Прораб", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
            }
        }
    }

    private bool IsApplicationUrl(string url) {
        Uri target;
        return applicationOrigin != null && Uri.TryCreate(url, UriKind.Absolute, out target)
            && target.Scheme == applicationOrigin.Scheme && target.Host == applicationOrigin.Host && target.Port == applicationOrigin.Port;
    }

    private void ChooseFolder(object sender, CoreWebView2WebMessageReceivedEventArgs e) {
        if (!IsApplicationUrl(e.Source)) return;
        string message;
        try { message = e.TryGetWebMessageAsString(); } catch { return; }
        if (message.StartsWith("paste-key:", StringComparison.Ordinal)) {
            string id = message.Substring("paste-key:".Length);
            try {
                var payload = new { type = "paste-key", providerId = id, text = Clipboard.ContainsText() ? Clipboard.GetText() : "" };
                view.CoreWebView2.PostWebMessageAsJson(new JavaScriptSerializer().Serialize(payload));
            } catch { view.CoreWebView2.PostWebMessageAsJson("{\"type\":\"clipboard-error\"}"); }
            return;
        }
        if (message != "choose-folder") return;
        using (var dialog = new FolderBrowserDialog { Description = "Выберите папку проекта", ShowNewFolderButton = false }) {
            if (dialog.ShowDialog(this) == DialogResult.OK) {
                var payload = new { type = "folder", path = dialog.SelectedPath };
                view.CoreWebView2.PostWebMessageAsJson(new JavaScriptSerializer().Serialize(payload));
            }
        }
    }

    private void StopServer() {
        try { if (view != null) view.Dispose(); } catch { }
        try {
            if (server != null && !server.HasExited) {
                using (var killer = Process.Start(new ProcessStartInfo("taskkill.exe", "/PID " + server.Id + " /T /F") { UseShellExecute = false, CreateNoWindow = true })) killer.WaitForExit(5000);
            }
        } catch { }
        try { if (readyFile != null) { File.Delete(readyFile); File.Delete(readyFile + ".desktop"); } } catch { }
    }
}
