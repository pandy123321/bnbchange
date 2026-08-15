const { contextBridge, ipcRenderer } = require("electron");

// 暴露给授权窗口（license.html）的最小 API：
// 验证授权码 → 主进程调用远程授权服务器，成功后拉起系统浏览器。
contextBridge.exposeInMainWorld("desktop", {
  verifyLicense: (code) => ipcRenderer.invoke("license:verify", code),
});
