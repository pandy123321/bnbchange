# BSC 批量转账与跟单工具

BSC 批量转账 + PancakeSwap V2 带单跟单的内部桌面工具（V0.1）。

- 本地 Private Key 或 MetaMask（小狐狸）签名
- 多链批量转账（BSC / Ethereum / Polygon / Arbitrum / Optimism / Base），支持原生币 + ERC20
- Leader 先买入，成功后 Followers 顺序跟买（仅 BSC / PancakeSwap）
- 内部系统：跟单地址与私钥由后台加密托管（AES-256-GCM），超级管理员可查看（留审计）；后台部署在公网服务器，供内部人员使用
- 授权码验证一次后本地记住，后续打开免输入（过期自动失效）

## 技术栈

React 19 · Vite · TypeScript · Tailwind CSS · ethers v6 · Electron · electron-builder

## 快速开始（开发）

```bash
npm install
cp .env.example .env   # 按需修改 RPC / License 后端地址
npm run dev
```

浏览器访问 http://127.0.0.1:5173

## 打包成 Windows 安装包（exe）

前置：确认 `VITE_LICENSE_API_BASE_URL` 已指向你的**远程授权服务器**（见下）。

```bash
npm install
npm run dist
```

安装包输出到 `release/` 目录（`BSC批量转账与跟单工具 Setup x.x.x.exe`），双击安装后即可使用。

本地直接跑 Electron 调试（不打包）：

```bash
npm run build
npm run electron
```

## 远程授权服务器

授权码验证需要一台**远程授权服务器**（后端代码在 `license-server/`）。

> 规划：后续授权功能将合并进统一后台 `admin-server/`（私钥托管 + 操作日志 + 持仓管理 + 角色权限），原 `license-server/` 功能由 `admin-server/` 取代。当前 README 仍按 `license-server/` 描述。

### 部署后端

1. 把 `license-server/` 目录上传到你的服务器。
2. 服务器上运行：

```bash
cd license-server
node server.js   # 默认监听 127.0.0.1:8788（如需改端口/监听地址，用 LICENSE_PORT / LICENSE_HOST 环境变量）
```

> 公网部署：Node 进程默认只监听 `127.0.0.1`，不直接裸露公网。请用 Nginx / Caddy / 负载均衡提供 HTTPS，再反向代理到 `127.0.0.1:8788`。同时通过 `LICENSE_ALLOWED_ORIGINS` 显式配置允许的前端 Origin（逗号分隔），禁止使用 `*`。
>
> 反向代理需把真实客户端 IP 转发给后端（`X-Forwarded-For`），否则限流会按代理自身 IP 统一计数、误伤所有用户。后端仅在请求来自可信代理（默认本机 loopback，可用 `LICENSE_TRUSTED_PROXIES` 追加）时才解析 `X-Forwarded-For`，并按「可信代理链」从右向左取第一个不可信 IP 作为真实客户端；即使客户端自行伪造 `X-Forwarded-For`，也无法改变限流所用的真实客户端 IP。直接公网访问 Node 时伪造 `X-Forwarded-For` 不会生效。
>
> 确需 Node 直接监听公网时再显式设置 `LICENSE_HOST=0.0.0.0`，并自行配置防火墙 / HTTPS / CORS 等边界。

3. 生成 / 管理授权码（在服务器上）：

```bash
node cli.js generate --days 30 --note "张三"   # 生成 30 天卡
node cli.js list                                # 查看
node cli.js revoke XXXX-XXXX-XXXX-XXXX         # 吊销
```

### 让前端连到远程授权服务器

打包前，在项目根目录创建 `.env.production`：

```env
VITE_LICENSE_API_BASE_URL=https://你的服务器域名或IP
```

> 注意：`VITE_` 开头的变量会在 `vite build` 时被**编译进产物**。改地址后必须重新 `npm run build` / `npm run dist`。

如不设置，前端默认连 `http://127.0.0.1:8788`（仅适合本地联调，不适合分发给用户）。

## 桌面端工作方式（授权验证 + 拉起浏览器）

桌面端（Electron）只负责**验证授权码**，验证通过后自动**拉起系统浏览器**进入操作界面：

1. 双击打开桌面端 → 弹出授权验证窗口，输入授权码。
2. 验证通过后，自动用系统浏览器打开 `http://127.0.0.1:4173/?session=<一次性token>`。
3. 浏览器内用该 token 换取「已验证」状态（一次性、10 分钟有效），直接进入操作界面，**无需二次输入授权码**。
4. 在浏览器里操作，小狐狸（MetaMask）钱包为原生完整体验，直接点「连接小狐狸」即可。

> 桌面端启动时会在本地起一个静态服务器（默认 `127.0.0.1:4173`）服务前端页面，关闭桌面端后该服务停止。
> 浏览器记住授权后（localStorage），下次直接访问 `http://127.0.0.1:4173` 也能进入（授权未过期时）。

## 带单跟单（PancakeSwap 交易对）

带单跟单**只在 BSC 链（PancakeSwap V2 Router）执行**，其它链不提供该功能（界面会自动禁用「带单跟单」标签）：

- **带单（Leader）**：用原生币（BNB）在 PancakeSwap V2 上买入目标代币，交易对为 `WBNB ↔ 目标代币`（`swapExactETHForTokens`）。
- **跟单（Follower）**：带单成功后，各跟单钱包用各自的私钥、按各自买入金额，在同一交易对（`WBNB ↔ 目标代币`）上独立买入，每个钱包独立获取实时报价。
- 带单失败或未确认时，所有跟单钱包自动跳过，不执行买入。

## 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `VITE_LICENSE_API_BASE_URL` | 前端（浏览器页面）连接的授权后端地址 | `http://127.0.0.1:8788` |
| `LICENSE_SERVER_URL` | 桌面端（Electron 主进程）连接的授权后端地址 | `http://127.0.0.1:8788` |
| `LICENSE_ALLOWED_ORIGINS` | 授权后端 CORS 白名单（逗号分隔，禁止 `*`） | `http://127.0.0.1:4173,http://127.0.0.1:5173` |
| `LICENSE_TRUSTED_PROXIES` | 可信反向代理来源（逗号分隔，仅这些来源的 `X-Forwarded-For` 会被信任） | `127.0.0.1,::1,::ffff:127.0.0.1` |
| `APP_PORT` | 桌面端本地静态服务器端口 | `4173` |
| `VITE_BSC_MAINNET_RPC_URL` | BSC 主网首选 RPC | `https://bsc-dataseed.bnbchain.org` |
| `VITE_BSC_TESTNET_RPC_URL` | BSC 测试网首选 RPC | `https://bsc-testnet-dataseed.bnbchain.org` |

> 授权服务器默认端口 `8788`（可用 `LICENSE_PORT` 覆盖）。远程部署时把 `VITE_LICENSE_API_BASE_URL` 与 `LICENSE_SERVER_URL` 都指向你的远程服务器地址。

其余链（ETH/Polygon/Arbitrum/Optimism/Base）的多个 RPC 节点已内置在 `src/config/networks.ts`，自动探测回退。

## 安全底线

> 说明：本工具为**内部系统**，私钥采用「后台加密托管」模型（区别于早期「服务器不接触私钥」的纯本地模式）。

- 私钥由后台 AES-256-GCM 加密托管，仅超级管理员二次鉴权后可查看明文，每次查看留审计日志
- 主密钥（加密密钥）不进入源码 / 日志 / 前端产物 / 版本库，并有轮换与丢失恢复方案
- 本地服务只监听 `127.0.0.1`
- 任何资金交易不自动 Retry
- 一次性 session token 用于桌面端→浏览器授权传递，用后即废，进程重启即失效
- 日志不记录私钥明文或密文
