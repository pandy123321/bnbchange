const { app, BrowserWindow, shell, ipcMain, dialog } = require("electron");
const http = require("node:http");
const { readFile } = require("node:fs/promises");
const { extname, join, normalize } = require("node:path");

const DIST = join(__dirname, "..", "dist");
// 前端静态页面固定端口，保证浏览器 localStorage 的 origin 稳定（授权记住有效）
const APP_PORT = Number(process.env.APP_PORT) || 4173;
// 授权服务器地址（本地测试默认 8788；远程部署时用 LICENSE_SERVER_URL 覆盖）
const LICENSE_SERVER_URL =
  process.env.LICENSE_SERVER_URL || "http://127.0.0.1:8788";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
};

// 内嵌静态服务器：服务打包后的前端，供系统浏览器访问。
// 监听 127.0.0.1 固定端口，使 fetch(授权/RPC) 保持 http origin，CORS 正常。
function createStaticServer(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        let pathname = decodeURIComponent(url.pathname);
        if (pathname === "/") pathname = "/index.html";

        const filePath = normalize(join(DIST, pathname));
        if (!filePath.startsWith(DIST)) {
          res.writeHead(403);
          res.end("Forbidden");
          return;
        }

        const data = await readFile(filePath);
        res.writeHead(200, {
          "Content-Type":
            MIME[extname(filePath)] ?? "application/octet-stream",
        });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end("Not Found");
      }
    });

    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

let mainWindow = null;
let appPort = APP_PORT;

// 单实例：重复启动时聚焦已有授权窗口
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    // 固定端口（默认 4173）；被占用时不再回退到随机端口，
    // 否则授权 CORS 白名单（仅 4173/5173）无法放行随机端口，授权 session 无法被消费。
    // 改为显示明确错误并退出，提示用户关闭占用端口的程序后重试。
    let server;
    try {
      server = await createStaticServer(appPort);
    } catch {
      dialog.showErrorBox(
        "端口被占用",
        `端口 ${appPort} 被占用，无法启动。\n请关闭占用该端口的程序后重新启动本工具。`
      );
      app.quit();
      return;
    }
    appPort = server.address().port;

    mainWindow = new BrowserWindow({
      width: 460,
      height: 360,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      title: "BSC 批量转账与跟单工具 - 授权验证",
      autoHideMenuBar: true,
      backgroundColor: "#030712",
      webPreferences: {
        preload: join(__dirname, "preload.cjs"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    await mainWindow.loadFile(join(__dirname, "license.html"));
  });

  // 授权窗口发起验证：调用授权服务器换取一次性 session，成功后拉起系统浏览器
  ipcMain.handle("license:verify", async (_event, code) => {
    const endpoint = `${LICENSE_SERVER_URL}/api/tool/issue-session`;
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: String(code ?? "").trim().toUpperCase() }),
      });
      const data = await res.json();
      if (data.ok && data.sessionToken) {
        const appUrl = `http://127.0.0.1:${appPort}/?session=${data.sessionToken}`;
        await shell.openExternal(appUrl);
        return { ok: true };
      }
      return { ok: false, error: data.error || "授权码无效或不可用" };
    } catch {
      return { ok: false, error: "无法连接授权服务器" };
    }
  });
}

app.on("window-all-closed", () => {
  app.quit();
});
