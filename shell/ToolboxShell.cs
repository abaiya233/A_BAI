// ============================================================================
//  大肥鱼工具箱 · 原生壳（WebView2 + 无边框 + 亚克力毛玻璃）
//  ---------------------------------------------------------------------------
//  为什么要有这个壳：
//  Edge --app 窗口的标题栏是 Chromium 自绘的假标题栏，DWM 拿不到控制权，
//  毛玻璃永远做不出来（实测 DwmSetWindowAttribute 38/34/35/36 全部 no-op）。
//  这个壳自己拥有窗口，直接走 DWM：
//    DWMWA_SYSTEMBACKDROP_TYPE = 3 (DWMSBT_TRANSIENTWINDOW = Acrylic 真亚克力)
//  网页里只有标题栏那 44px 是透明的，其余区域不透明 —— 毛玻璃只在标题栏透出。
//
//  编译（build.bat 调用）：
//    %FW%\csc.exe /target:winexe /platform:anycpu
//        /r:..\panel\Microsoft.Web.WebView2.Core.dll
//        /r:..\panel\Microsoft.Web.WebView2.WinForms.dll
//        /win32icon:..\web\brand.ico ToolboxShell.cs
//  语法约束：.NET Framework 自带编译器只认 C# 5，不许用 $"..."、?.、nameof。
// ============================================================================

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace DaFeiYu.Toolbox
{
    internal static class Program
    {
        [DllImport("user32.dll")]
        private static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr FindWindowW(string cls, string title);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int cmd);

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [STAThread]
        private static void Main()
        {
            try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
            bool created;
            using (var mtx = new Mutex(true, "DaFeiYuToolbox.SingleInstance", out created))
            {
                if (!created)
                {
                    // 已经开着一个壳了：把它叫到前面来，然后自己退出
                    IntPtr h = FindWindowW(null, ShellForm.WIN_TITLE);
                    if (h != IntPtr.Zero)
                    {
                        ShowWindow(h, 9);            // SW_RESTORE
                        SetForegroundWindow(h);
                    }
                    return;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new ShellForm());
            }
        }
    }

    internal class ShellForm : Form
    {
        public const string WIN_TITLE = "大肥鱼工具箱";
        private const int PORT = 8788;

        // ---------- 布局：支持两种放法 ----------
        // 开发目录：toolbox\shell\DaFeiYuToolbox.exe  → Root = 上一级（toolbox）
        // 绿色包：  DaFeiYuToolbox\DaFeiYuToolbox.exe → Root = 自己这一级
        // 判据：exe 同级有没有 server\server.mjs。
        private static string ExeDir
        {
            get { return AppDomain.CurrentDomain.BaseDirectory; }
        }
        private static string Root
        {
            get
            {
                string d = ExeDir.TrimEnd('\\');
                if (File.Exists(Path.Combine(d, "server", "server.mjs"))) return d;
                return Path.GetDirectoryName(d);
            }
        }

        private static string FindNode()
        {
            // 绿色版自带 runtime/node.exe，优先用它；
            // 源码目录直接跑时没有 runtime，退到 PATH 上的 node。
            string[] cand = new string[]
            {
                Path.Combine(Root, "runtime", "node.exe")
            };
            foreach (string p in cand)
                if (File.Exists(p)) return p;
            return "node.exe"; // PATH 兜底
        }

        // ================= DWM / Win32 =================

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int val, int size);

        [DllImport("user32.dll")]
        private static extern bool ReleaseCapture();

        [DllImport("user32.dll")]
        private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wp, IntPtr lp);

        [DllImport("user32.dll")]
        private static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int w, int h, uint flags);

        private const int WM_NCLBUTTONDOWN = 0x00A1;
        private const int WM_SIZE = 0x0005;
        private const int WM_NCHITTEST = 0x0084;
        private static readonly IntPtr HTCAPTION = new IntPtr(2);

        private const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
        private const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
        private const int DWMWA_SYSTEMBACKDROP_TYPE = 38;

        // ================= 控件与状态 =================

        private WebView2 pageView;
        private bool webReady;
        private bool navigated;
        private bool maxed;

        // 标题栏模式：
        //   native（默认）= 保留系统边框，DWM 亚克力直接作用在系统标题栏上 —— 和 QQ 同款
        //   custom         = 无边框 + 网页自绘标题栏（需要 WebView2 画布透明，实测拿不到亚克力）
        // 用环境变量 DFY_TITLEBAR=custom 切换，方便两种方案对比。
        private bool customTitle;

        private const string WAIT_HTML =
            "<!doctype html><html><head><meta charset='utf-8'><style>" +
            "html,body{height:100%;margin:0;background:transparent}" +
            ".c{position:fixed;inset:0;display:grid;place-items:center;" +
            "font:13.5px 'Microsoft YaHei UI',system-ui;color:#334155;" +
            "text-shadow:0 1px 0 rgba(255,255,255,.8)}" +
            ".s{width:34px;height:34px;border-radius:50%;margin:0 auto 14px;" +
            "border:3px solid rgba(37,99,235,.18);border-top-color:#2563eb;" +
            "animation:r 1s linear infinite}" +
            "@keyframes r{to{transform:rotate(360deg)}}" +
            "</style></head><body><div class='c'><div>" +
            "<div class='s'></div>\u6B63\u5728\u542F\u52A8\u5927\u80A5\u9C7C\u670D\u52A1\u2026" +
            "</div></div></body></html>";

        public ShellForm()
        {
            Text = WIN_TITLE;

            customTitle = string.Equals(
                Environment.GetEnvironmentVariable("DFY_TITLEBAR"), "custom",
                StringComparison.OrdinalIgnoreCase);

            // native（默认）：保留系统边框。
            //   真正的 Win32 窗口一旦有系统标题栏，DWM 的 backdrop 就会直接作用在它身上，
            //   这就是 QQ/系统设置那种毛玻璃标题栏的标准做法 —— 也是唯一被实测证明
            //   在 WebView2 里能透出来的路径。
            // custom：无边框 + 网页自绘标题栏（WebView2 画布透明只透出 WinForms 客户区，
            //   拿不到 DWM 亚克力，仅作对比保留）。
            FormBorderStyle = customTitle ? FormBorderStyle.None : FormBorderStyle.Sizable;
            MaximizeBox = true;
            MinimizeBox = true;
            StartPosition = FormStartPosition.Manual;
            ShowInTaskbar = true;
            AutoScaleMode = AutoScaleMode.None;
            DoubleBuffered = false;

            if (customTitle)
            {
                // 不让 WinForms 自己铺背景色 —— 客户区交给 DWM 亚克力
                SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint
                    | ControlStyles.Opaque, true);
            }

            // WebView2 透明画布：网页里透明的地方直接透到窗口的亚克力上
            pageView = new WebView2();
            pageView.Dock = DockStyle.Fill;
            pageView.DefaultBackgroundColor = Color.Transparent;
            pageView.AllowExternalDrop = false;
            Controls.Add(pageView);

            ApplyGeometry();
            Icon = TryLoadIcon();

            Load += delegate { InitDwm(); InitWeb(); };
        }

        private static Icon TryLoadIcon()
        {
            try
            {
                string p = Path.Combine(Root, "web", "brand.ico");
                if (File.Exists(p))
                {
                    // brand.ico 里带了 256/128/64/48/32/24/16 七种尺寸。
                    // 不要用 new Icon(p)：它只取系统默认的 32px，本机 150% 缩放下
                    // 任务栏需要 48px 以上，拿 32 放大就发虚、边缘发毛。
                    // 指定 256 让系统从最大那张往下缩，任何 DPI 都清晰。
                    return new Icon(p, 256, 256);
                }
            }
            catch { }
            return null;
        }

        // ================= 窗口几何（记忆在 toolbox\data\win-geometry.txt） =================

        private void ApplyGeometry()
        {
            int x = -1, y = -1, w = 0, h = 0;
            bool geoOk = false;
            try
            {
                string p = Path.Combine(Root, "data", "win-geometry.txt");
                if (File.Exists(p))
                {
                    string[] parts = File.ReadAllText(p).Trim().Split(',');
                    if (parts.Length >= 4)
                    {
                        x = int.Parse(parts[0]); y = int.Parse(parts[1]);
                        w = int.Parse(parts[2]); h = int.Parse(parts[3]);
                        maxed = parts.Length >= 5 && parts[4] == "1";
                        geoOk = w >= 1024 && h >= 700;
                    }
                }
            }
            catch { geoOk = false; }

            if (!geoOk)
            {
                // 逻辑 1320x900（跟旧启动器一致），按 DPI 换算成物理像素后居中
                float scale = 1f;
                try
                {
                    using (var g = CreateGraphics()) scale = g.DpiX / 96f;
                }
                catch { }
                w = (int)(1320 * scale); h = (int)(900 * scale);
                var wa = (maxed ? Screen.PrimaryScreen : Screen.PrimaryScreen).WorkingArea;
                if (w > wa.Width) w = wa.Width;
                if (h > wa.Height) h = wa.Height;
                x = wa.X + (wa.Width - w) / 2;
                y = wa.Y + (wa.Height - h) / 2;
            }

            // 别跑到看不见的屏幕外去
            bool onScreen = false;
            foreach (Screen sc in Screen.AllScreens)
            {
                var r = sc.WorkingArea;
                if (x >= r.X - 200 && x < r.Right - 200 && y >= r.Y - 100 && y < r.Bottom - 100)
                { onScreen = true; break; }
            }
            if (!onScreen)
            {
                var wa = Screen.PrimaryScreen.WorkingArea;
                x = wa.X + 100; y = wa.Y + 100;
            }

            StartPosition = FormStartPosition.Manual;
            Location = new Point(x, y);
            Size = new Size(w, h);
            if (maxed) WindowState = FormWindowState.Maximized;
        }

        private void SaveGeometry()
        {
            try
            {
                bool m = WindowState == FormWindowState.Maximized;
                var b = Bounds;
                string dir = Path.Combine(Root, "data");
                Directory.CreateDirectory(dir);
                File.WriteAllText(Path.Combine(dir, "win-geometry.txt"),
                    string.Format("{0},{1},{2},{3},{4}", b.X, b.Y, b.Width, b.Height, m ? 1 : 0));
            }
            catch { }
        }

        // ================= DWM：亚克力 + 圆角 + 跟随系统深浅 =================

        private void InitDwm()
        {
            IntPtr h = Handle;

            // 真亚克力。这是本项目里唯一被实测证明可用的毛玻璃路径
            // （ACCENT_ENABLE_ACRYLICBLURBEHIND 在 Win11 24H2 已退化成纯色，别用）
            int backdrop = 3; // DWMSBT_TRANSIENTWINDOW
            DwmSetWindowAttribute(h, DWMWA_SYSTEMBACKDROP_TYPE, ref backdrop, 4);

            // Win11 圆角 + 自动阴影
            int corner = 2; // DWMWCP_ROUND
            DwmSetWindowAttribute(h, DWMWA_WINDOW_CORNER_PREFERENCE, ref corner, 4);

            // 亚克力明暗跟随系统应用主题（不是网页自己的深色开关，跟旧 --win-bar 的语义一致）
            int dark = ReadSystemDark() ? 1 : 0;
            DwmSetWindowAttribute(h, DWMWA_USE_IMMERSIVE_DARK_MODE, ref dark, 4);
        }

        private static bool ReadSystemDark()
        {
            try
            {
                object v = Microsoft.Win32.Registry.GetValue(
                    @"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
                    "AppsUseLightTheme", 1);
                if (v is int) return (int)v == 0;
            }
            catch { }
            return false;
        }

        // ================= 无边框必备：最大化不许盖住任务栏 =================

        protected override void WndProc(ref Message m)
        {
            base.WndProc(ref m);
            if (m.Msg == WM_SIZE && WindowState == FormWindowState.Maximized)
            {
                var wa = Screen.FromControl(this).WorkingArea;
                SetWindowPos(Handle, IntPtr.Zero, wa.X, wa.Y, wa.Width, wa.Height, 0x0024);
                maxed = true;
            }
        }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            // custom 模式：故意什么都不画，客户区留给 DWM 亚克力。
            // native 模式：正常绘制（WebView2 铺满客户区，正常绘制只是打底，
            //   免得边缘露出未定义的客户区颜色）。
            if (customTitle) return;
            base.OnPaintBackground(e);
        }

        // ================= 服务管理 =================

        private static bool PortOpen(int port)
        {
            var c = new TcpClient();
            try
            {
                IAsyncResult ar = c.BeginConnect("127.0.0.1", port, null, null);
                bool ok = ar.AsyncWaitHandle.WaitOne(800);
                return ok && c.Connected;
            }
            catch { return false; }
            finally { try { c.Close(); } catch { } }
        }

        private static string Ping()
        {
            // /api/ping 返回纯文本 PID
            try
            {
                var req = System.Net.HttpWebRequest.Create(
                    "http://127.0.0.1:" + PORT + "/api/ping") as System.Net.HttpWebRequest;
                req.Timeout = 1500;
                req.ReadWriteTimeout = 1500;
                using (var rsp = req.GetResponse())
                using (var sr = new System.IO.StreamReader(rsp.GetResponseStream()))
                    return sr.ReadToEnd().Trim();
            }
            catch { return ""; }
        }

        private static void StartServer()
        {
            string node = FindNode();
            var psi = new ProcessStartInfo(node);
            psi.Arguments = "server/server.mjs";
            psi.WorkingDirectory = Root;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            try { Process.Start(psi); } catch { }
        }

        /// <summary>
        /// 服务是常驻的（关窗口不清服务）。但代码更新后旧进程不会自动换新：
        /// boot.stamp 是服务每次启动时写的，server.mjs 比 stamp 新 → 跑的是旧代码，杀掉重启。
        /// </summary>
        private static void EnsureServer()
        {
            string pid = Ping();
            if (pid.Length > 0)
            {
                try
                {
                    string stamp = Path.Combine(Root, "data", "boot.stamp");
                    string mjs = Path.Combine(Root, "server", "server.mjs");
                    if (File.Exists(stamp) && File.Exists(mjs)
                        && File.GetLastWriteTimeUtc(mjs) > File.GetLastWriteTimeUtc(stamp))
                    {
                        int old;
                        if (int.TryParse(pid, out old))
                        {
                            var psi = new ProcessStartInfo("taskkill.exe");
                            psi.Arguments = "/PID " + old + " /T /F";
                            psi.UseShellExecute = false;
                            psi.CreateNoWindow = true;
                            try { Process.Start(psi); } catch { }
                            Thread.Sleep(900);
                            pid = "";
                        }
                    }
                }
                catch { }
            }

            if (pid.Length == 0) StartServer();

            // 等端口就绪（最多 25 秒）
            for (int i = 0; i < 36; i++)
            {
                if (Ping().Length > 0) return;
                Thread.Sleep(700);
            }
        }

        // ================= WebView2 =================

        private async void InitWeb()
        {
            try
            {
                string dataDir = Path.Combine(Root, "data", "webview-shell");
                Directory.CreateDirectory(dataDir);
                var env = await CoreWebView2Environment.CreateAsync(null, dataDir, null);
                await pageView.EnsureCoreWebView2Async(env);

                var core = pageView.CoreWebView2;
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.Settings.IsZoomControlEnabled = false;
                core.Settings.AreDevToolsEnabled = Environment.GetEnvironmentVariable("DFY_DEV") == "1";

                // 网页 → 壳 的指令总线
                core.WebMessageReceived += OnWebMessage;

                webReady = true;

                // 先放等待页，服务就绪后再跳正主
                core.NavigateToString(WAIT_HTML);
                await Task.Run((Action)EnsureServer);

                if (Ping().Length > 0)
                {
                    // custom 模式才让网页自绘标题栏（加 shelltitle=1）
                    string url = "http://127.0.0.1:" + PORT + "/?shell=1"
                        + (customTitle ? "&shelltitle=1" : "");
                    core.Navigate(url);
                    navigated = true;
                }
                else
                {
                    core.NavigateToString(
                        "<!doctype html><meta charset='utf-8'><body style='margin:0;background:transparent;" +
                        "font:13.5px \"Microsoft YaHei UI\";color:#b91c1c;padding:40px'>" +
                        "\u670D\u52A1\u6CA1\u8D77\u6765\u3002\u8BF7\u68C0\u67E5 " +
                        System.IO.Path.Combine(Root, "server", "server.mjs") +
                        " \u548C node \u662F\u5426\u5B58\u5728\u3002</body>");
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show("初始化界面失败：" + ex.Message, WIN_TITLE,
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            string msg;
            try { msg = e.TryGetWebMessageAsString(); }
            catch { return; }

            if (msg == "win:drag")
            {
                ReleaseCapture();
                SendMessage(Handle, WM_NCLBUTTONDOWN, HTCAPTION, IntPtr.Zero);
            }
            else if (msg == "win:min")
            {
                WindowState = FormWindowState.Minimized;
            }
            else if (msg == "win:max")
            {
                ToggleMax();
            }
            else if (msg == "win:close")
            {
                SaveGeometry();
                Close();
            }
            else if (msg != null && msg.StartsWith("win:rz:"))
            {
                // win:rz:10 = HTLEFT ... 网页四边把手请求系统接管调尺寸
                int edge;
                if (int.TryParse(msg.Substring(7), out edge) && edge >= 1 && edge <= 17)
                {
                    ReleaseCapture();
                    SendMessage(Handle, WM_NCLBUTTONDOWN, new IntPtr(edge), IntPtr.Zero);
                }
            }
        }

        private void ToggleMax()
        {
            if (WindowState == FormWindowState.Maximized)
            {
                WindowState = FormWindowState.Normal;
                maxed = false;
            }
            else
            {
                WindowState = FormWindowState.Maximized;
                maxed = true;
            }
        }

        // 窗口正在被拖拽/调尺寸时系统需要消息循环自己跑，这里啥都不用做

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            SaveGeometry();
            base.OnFormClosing(e);
        }
    }
}
