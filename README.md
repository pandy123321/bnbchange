# BSC Batch & Copy Trade Tool

BSC 批量转账 + PancakeSwap V2 带单跟单的内部桌面式网页工具（V0.1 Internal MVP）。

- 本地 Private Key 自动签名，无需 MetaMask
- 批量 BNB 转账（`地址,金额` 一行一笔）
- Leader 先买入，成功后 Followers 顺序跟买（每个钱包独立 fresh quote）
- 服务器只做简单卡密验证，不参与交易、不接触 Private Key

## 技术栈

React 19 · Vite · TypeScript · Tailwind CSS · ethers v6 · PancakeSwap Router V2 · BNB Smart Chain (56 / 97)

## 快速开始（开发）

```bash
npm install
cp .env.example .env   # 按需修改 RPC / License 后端地址
npm run dev
```

浏览器访问 http://127.0.0.1:5173

## 构建并本地运行（分发）

```bash
npm install
npm run build
```

然后双击 `start.bat`（或在终端运行 `node serve.js`），浏览器自动打开 http://127.0.0.1:4173

## 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `VITE_LICENSE_API_BASE_URL` | License 后端地址 | `http://127.0.0.1:8787` |
| `VITE_BSC_MAINNET_RPC_URL` | BSC 主网 RPC | `https://bsc-dataseed.bnbchain.org` |
| `VITE_BSC_TESTNET_RPC_URL` | BSC 测试网 RPC | `https://bsc-testnet-dataseed.bnbchain.org` |

## 安全底线

- Private Key 仅存于浏览器运行内存，刷新/关闭即丢失
- Private Key 不上传、不写 localStorage / sessionStorage / IndexedDB / CSV / 日志
- 本地服务只监听 `127.0.0.1`
- 任何资金交易不自动 Retry
