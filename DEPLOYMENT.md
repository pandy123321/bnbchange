# 部署文档（DEPLOYMENT.md）

> 项目：一键转账跟单（BSC 批量转账 + PancakeSwap V2 带单跟单）
> 适用版本：V0.1
> 部署对象：① 后端服务（授权验证 / 私钥托管 / 日志 / 持仓 / RBAC）；② 桌面端 Windows 安装包（exe）

---

## 1. 部署架构总览

```
┌───────────────────────────  内部用户机器  ───────────────────────────┐
│                                                                       │
│  双击安装好的桌面端（Electron）                                          │
│    │ 输入授权码                                                          │
│    ▼                                                                   │
│  授权验证窗口 ──(POST /api/tool/issue-session)──┐                        │
│    │ 验证通过，拉起系统浏览器                      │                        │
│    ▼                                             │                        │
│  系统浏览器 http://127.0.0.1:4173/?session=token   │                        │
│    │ 消费一次性 token                             │                        │
│    ▼                                             │                        │
│  前端操作界面（批量转账 / 带单跟单）                 │                        │
│    │ 调用 verify-session / verify-license         ▼                        │
│    │ (浏览器 fetch，受 CORS 限制)          ┌──────────────────────┐        │
│    └──────────────────────────────────────►│  公网授权/后台服务器   │        │
│                                            │  admin-server (Node)  │        │
│                                            │  127.0.0.1:8788       │        │
│                                            │  ↑ Nginx/Caddy 反代    │        │
│                                            │  ↑ HTTP/HTTPS + CORS + 限流 │     │
│                                            └──────────────────────┘        │
└─────────────────────────────────────────────────────────────────────────┘
```

要点：

- **桌面端主进程**（Electron `main.cjs`）用 `LICENSE_SERVER_URL` 发 `issue-session`，是 Node 原生 `fetch`，**不受 CORS 限制**，只需网络可达。
- **浏览器页面**（前端 `licenseApi.ts`）用 `VITE_LICENSE_API_BASE_URL` 发 `verify-session` / `verify-license`，是浏览器 `fetch`，**受 CORS 限制**，需要后端把浏览器 Origin（`http://127.0.0.1:4173`）加入 CORS 白名单。
- 两个地址**必须指向同一个后端**，路径与行为一致。

---

## 2. 部署后端（推荐：`admin-server/` 统一后台）

`admin-server/` 一个服务同时提供：**授权验证** + **私钥加密托管** + **用户/RBAC** + **操作日志** + **持仓管理** + **授权码管理**，并内置 `/admin` 管理界面。

### 2.1 上传代码

把 `admin-server/` 整个目录上传到服务器，例如 `/opt/bnbchange/admin-server`。

### 2.2 安装依赖

```bash
cd /opt/bnbchange/admin-server
npm install
```

> 说明：当前 `admin-server` 运行代码**仅依赖 Node 内置模块**（`http` / `crypto` / `fs` 等），`package.json` 声明的 `ethers` 为预留依赖。`npm install` 无害，也可跳过直接运行。

### 2.3 配置环境变量

在服务器上设置环境变量（推荐用 systemd 或进程管理器注入，见 2.6），核心变量：

| 变量 | 必填 | 说明 | 默认 |
| --- | --- | --- | --- |
| `MASTER_KEY` | **是** | AES-256-GCM 主密钥，加密私钥用。**高强度随机串，绝不提交版本库** | 无 |
| `MASTER_KEY_FILE` | 否 | 指向主密钥文件（与 `MASTER_KEY` 二选一） | 无 |
| `ADMIN_HOST` | 否 | 监听地址 | `127.0.0.1` |
| `ADMIN_PORT` | 否 | 监听端口 | `8788` |
| `ADMIN_ALLOWED_ORIGINS` | 否 | CORS 白名单（逗号分隔，禁止 `*`） | `http://127.0.0.1:4173,http://127.0.0.1:5173` |
| `ADMIN_TRUSTED_PROXIES` | 否 | 可信反向代理来源（仅这些来源的 `X-Forwarded-For` 被信任） | `127.0.0.1,::1,::ffff:127.0.0.1` |
| `ADMIN_RATE_LIMIT` | 否 | 每 IP 每分钟最大请求数 | `10` |
| `ADMIN_DATA_DIR` | 否 | 数据文件目录（默认 `admin-server/` 下） | 无 |

> 生成强随机主密钥示例：
> ```bash
> openssl rand -hex 32
> # 或
> node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
> ```

### 2.4 初始化超级管理员

首次部署必须先创建超管（用于登录 `/admin` 管理界面、查看私钥明文、管理用户）：

```bash
node cli.js init-admin --username admin --password '强密码'
```

### 2.5 生成授权码

```bash
node cli.js license generate --count 5 --days 30 --note "首批内部用户"   # 生成 5 个 30 天卡
node cli.js license list                                                  # 查看
node cli.js license revoke XXXX-XXXX-XXXX-XXXX                           # 吊销
node cli.js license restore XXXX-XXXX-XXXX-XXXX                          # 恢复
```

授权码格式：`XXXX-XXXX-XXXX-XXXX`（大写十六进制，带连字符）。

### 2.6 启动 + 反向代理（HTTP / HTTPS 可选）

**Node 进程只监听 `127.0.0.1`，不直接裸露公网**，用 Nginx 反代到 `127.0.0.1:8788`。内部测试可直接用 HTTP；生产环境建议加 HTTPS。

Nginx 示例（HTTP 内部测试）：

```nginx
server {
    listen 80;
    server_name your-server.example.com;

    location / {
        proxy_pass http://127.0.0.1:8788;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;   # 必须转发真实客户端 IP
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

> 生产环境如需 HTTPS，把 `listen 80` 换成 `listen 443 ssl` 并补上 `ssl_certificate` / `ssl_certificate_key` 即可，其余不变。

systemd 服务示例（`/etc/systemd/system/bnbchange-admin.service`）：

```ini
[Unit]
Description=bnbchange admin-server
After=network.target

[Service]
WorkingDirectory=/opt/bnbchange/admin-server
Environment=MASTER_KEY=<你的32字节hex主密钥>
Environment=ADMIN_HOST=127.0.0.1
Environment=ADMIN_PORT=8788
Environment=ADMIN_ALLOWED_ORIGINS=http://127.0.0.1:4173,http://127.0.0.1:5173
Environment=ADMIN_TRUSTED_PROXIES=127.0.0.1,::1,::ffff:127.0.0.1
Environment=ADMIN_RATE_LIMIT=10
ExecStart=/usr/bin/node server.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now bnbchange-admin
```

> **关键**：`X-Forwarded-For` 必须由反代转发，否则限流会按代理自身 IP 计数，误伤所有用户。后端仅在请求来自可信代理（`ADMIN_TRUSTED_PROXIES`）时才解析 `X-Forwarded-For`。

### 2.7 数据文件与备份

默认数据文件在 `admin-server/` 下（或 `ADMIN_DATA_DIR` 指定目录）：

| 文件 | 内容 | 敏感性 |
| --- | --- | --- |
| `users.json` | 用户 + scrypt 密码哈希 | 敏感 |
| `keys.json` | 私钥密文（AES-256-GCM） | **敏感** |
| `audit.json` | 操作日志（不含私钥） | 敏感 |
| `positions.json` | 持仓 | 普通 |
| `licenses.json` | 授权码 | 敏感 |
| `master.key` | 主密钥文件（若用文件方式） | **极敏感** |

**备份要求**：

- 定期备份 `users.json`、`keys.json`、`licenses.json`、`audit.json`、`positions.json`。
- **`master.key` 与 `keys.json` 必须分开保存**：丢失主密钥 = 全部托管私钥永久不可解密；主密钥与密文放一起 = 泄露即全部私钥泄露。
- 主密钥需有**轮换与丢失恢复方案**（见 6.1）。

---

## 3. 部署后端（可选：`license-server/` 独立精简版）

若**不需要**私钥托管 / 日志 / 持仓 / RBAC，只想要「授权码验证」，可只部署 `license-server/`（纯授权，无第三方依赖，接口路径与 `admin-server` 一致）。

```bash
cd /opt/bnbchange/license-server
node server.js   # 默认 127.0.0.1:8788
```

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `LICENSE_PORT` | 端口 | `8788` |
| `LICENSE_HOST` | 监听地址 | `127.0.0.1` |
| `LICENSE_ALLOWED_ORIGINS` | CORS 白名单 | `http://127.0.0.1:4173,http://127.0.0.1:5173` |
| `LICENSE_TRUSTED_PROXIES` | 可信代理 | `127.0.0.1,::1,::ffff:127.0.0.1` |
| `LICENSE_RATE_LIMIT` | 每 IP 每分钟限流 | `10` |
| `LICENSE_DATA_FILE` | 授权码数据文件 | `licenses.json` |

管理授权码：

```bash
node cli.js generate --days 30 --note "张三"
node cli.js list
node cli.js revoke XXXX-XXXX-XXXX-XXXX
```

> 反代配置与 2.6 相同（HTTP 内部测试 / HTTPS 生产，把端口换成 8788 即可）。

---

## 4. 打包桌面端 Windows 安装包（exe）

### 4.1 配置授权后端地址（关键，两处都要配）

打包前在**项目根目录**建 `.env.production`（参考 `.env.production.example`），**两处地址都要填、且必须指向同一个后端**：

```env
# 浏览器页面（前端）连接的授权后端地址：vite build 时编译进 dist
VITE_LICENSE_API_BASE_URL=http://your-server.example.com

# 桌面端（Electron 主进程）连接的授权后端地址：打包时固化进 exe
LICENSE_SERVER_URL=http://your-server.example.com
```

> 内部测试直接用 `http://` 即可；生产环境如需加密，把两处都换成 `https://` 再重新打包。

- `VITE_LICENSE_API_BASE_URL`：浏览器页面（前端）连接的授权后端地址，`vite build` 时**编译进产物**，改后必须重新 `npm run dist`。
- `LICENSE_SERVER_URL`：桌面端（Electron 主进程）连接的授权后端地址。`electron/main.cjs` 启动时会读取 `.env.production`（其次 `.env`），且 `package.json` 的 `build.files` 已把 `.env.production` 固化进 exe，因此**分发给用户后无需手动配置**，桌面端即可连到远程授权服务器。

> 优先级：`process.env` 运行时环境变量 > `.env.production` > `.env` > 代码默认值 `http://127.0.0.1:8788`。
>
> `.env.production` 已被 `.gitignore` 忽略（含远程地址，不提交到版本库），但会被 electron-builder 打包进 exe（`build.files` 显式包含）。

### 4.2 打包

```bash
npm install
npm run dist
```

产物输出到 `release/`：

```
release/BSC批量转账与跟单工具 Setup x.x.x.exe
```

> electron-builder 若在 Windows 上因 `winCodeSign` 解压符号链接失败，可手动下载 `winCodeSign` 并用 `7za x ... -x!"darwin"` 排除 darwin 目录后重试（历史踩坑记录）。

### 4.3 本地调试（不打包）

```bash
npm run build
npm run electron
```

---

## 5. 分发给用户

1. 把 exe 发给内部用户，用户双击安装。
2. 首次启动 → 输入授权码（`XXXX-XXXX-XXXX-XXXX`）。
3. 验证通过 → 自动拉起系统浏览器进入操作界面。
4. 浏览器内点「连接小狐狸」使用 MetaMask，或「输入私钥」本地签名。

> 每次启动都需授权服务器**在线验证**；吊销授权码后用户下次启动即失效。

---

## 6. 运维与安全

### 6.1 主密钥管理 / 轮换

- 主密钥（`MASTER_KEY` / `master.key`）是全部托管私钥的加密密钥，**绝不进入源码 / 日志 / 前端产物 / 版本库**。
- 轮换流程（需开发配套工具，当前未内置自动轮换）：
  1. 备份旧 `keys.json` + 旧主密钥。
  2. 用旧主密钥解密全部私钥 → 用新主密钥重新加密 → 写回 `keys.json`。
  3. 更新 `MASTER_KEY`，重启服务，验证可正常解密。
- **丢失主密钥 = 全部托管私钥永久不可解密**，务必异地离线备份。

### 6.2 查看私钥明文（超管）

- 登录 `http://your-server.example.com/admin`（生产 https 时对应 `https://...`）。
- 「私钥托管」页 → 「查看明文」→ **重新输入登录密码（二次鉴权）**。
- 每次查看写入审计日志（`view_private_key`，记录操作者/地址/时间/IP）。

### 6.3 角色权限

| 角色 | 查看明文私钥 | 管理私钥/用户 | 查看日志/持仓 | 生成授权码 |
| --- | :-: | :-: | :-: | :-: |
| super（超管） | ✔（二次鉴权） | ✔ | ✔ | ✔ |
| admin（管理员） | ✗ | 私钥/授权码 ✔，用户 ✗ | ✔ | ✔ |
| operator（操作员） | ✗ | ✗ | ✔ | ✗ |

### 6.4 限流与防爆破

- 后端对登录、验证、查看私钥等接口统一限流（默认每 IP 每分钟 10 次）。
- 确保反代转发 `X-Forwarded-For`，且仅信任真实代理（`ADMIN_TRUSTED_PROXIES`）。
- 登录密码用 scrypt 哈希；连续失败建议结合系统层防火墙/ fail2ban。

### 6.5 日志

- 操作日志存 `audit.json`，最多保留 5000 条（自动裁剪），**不含私钥明文/密文**。
- 前端错误经 `safeErrorMessage` 脱敏后才展示。

---

## 7. 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 桌面端提示「无法连接授权服务器」 | `.env.production` 的 `LICENSE_SERVER_URL` 未配置或未被打包 | 按 4.1 配置 `.env.production` 后重新 `npm run dist` |
| 浏览器页面授权失败 / 卡在验证 | 远程后端 CORS 白名单不含 `http://127.0.0.1:4173` | `ADMIN_ALLOWED_ORIGINS` 加入该 Origin |
| 限流误伤所有用户 | 反代未转发 `X-Forwarded-For` | Nginx 加 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for` |
| 端口 8788 被占用 | 其它 Node 进程占用 | 改 `ADMIN_PORT` / `LICENSE_PORT`，并同步前端地址 |
| 授权码提示无效 | 已吊销/过期 | `node cli.js license list` 核对状态 |

---

## 8. 环境变量速查表

| 变量 | 作用域 | 说明 |
| --- | --- | --- |
| `VITE_LICENSE_API_BASE_URL` | 前端（编译进 dist） | 浏览器页面连接的授权后端地址 |
| `LICENSE_SERVER_URL` | 桌面端主进程 | 授权窗口连接的授权后端地址 |
| `APP_PORT` | 桌面端 | 本地静态服务器端口，默认 `4173` |
| `MASTER_KEY` / `MASTER_KEY_FILE` | admin-server | 私钥加密主密钥 |
| `ADMIN_HOST` / `ADMIN_PORT` | admin-server | 监听地址/端口（默认 `127.0.0.1:8788`） |
| `ADMIN_ALLOWED_ORIGINS` | admin-server | CORS 白名单 |
| `ADMIN_TRUSTED_PROXIES` | admin-server | 可信反向代理 |
| `ADMIN_RATE_LIMIT` | admin-server | 每 IP 每分钟限流 |
| `ADMIN_DATA_DIR` | admin-server | 数据文件目录 |
| `LICENSE_PORT` / `LICENSE_HOST` 等 | license-server | 独立授权版对应配置（见第 3 节） |

---

## 信息来源

- `package.json`（构建脚本、electron-builder 配置）
- `electron/main.cjs`（桌面端授权流程、`LICENSE_SERVER_URL` / `APP_PORT`）
- `src/license/licenseApi.ts`（前端授权地址）
- `admin-server/{server.js,crypto.js,keyStore.js,auth.js,auditLog.js,positionStore.js,license.js,cli.js,.env.example}`
- `license-server/{server.js,store.js,cli.js}`
- `.env.example`、`.env.production.example`、`README.md`
