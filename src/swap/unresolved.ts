// 统一的 unresolved（待对账）交易门禁与真实链上对账。
//
// 目标：自动买入/卖出、手工 Leader 买入、手工持仓卖出出现 `unknown`
// （已广播但无法确认）时，统一登记为 unresolved；存在任何 unresolved 时，
// 全局禁止再次手工买入/卖出、禁止启动自动监听；只有通过当前 provider
// 真实查询链上 receipt 得到确定结果并完成账本更新后，才解除门禁。
//
// 安全边界：
// 1. 只保存非敏感的待对账元数据（chainId/txHash/地址/代币/数量/角色/快照），绝不保存私钥。
// 2. localStorage 仅用于跨标签/remount 保留这些元数据，不承载任何授权信任。
// 3. 内存状态是本会话内的可靠回退源；localStorage 写失败不影响门禁。
// 4. 持久化数据损坏/非法时 Fail Closed，绝不把损坏当成“无 unresolved”而解除门禁。
// 5. 对账只读链上 receipt 与代币余额，绝不广播任何新交易。
import { ethers } from "ethers";
import { getPosition, setPosition, type Position } from "./position";

export type UnresolvedSide = "buy" | "sell";
export type UnresolvedPhase = "approval" | "swap";
export type AccountingRole = "leader" | "follower";

// 对账所需的「操作前持仓快照」，保证账本可恢复、可验证、幂等。
export interface PositionSnapshot {
  amountWei: bigint;
  costBnbWei: bigint;
  tokenSymbol: string;
  decimals: number;
  buyTxHash?: string;
}

export interface UnresolvedTx {
  id: string;
  chainId: number;
  // 对账时查询的收据哈希：buy=swapHash；sell=approvalHash 或 swapHash
  txHash: string;
  walletAddress: string; // 规范化小写
  tokenAddress: string; // 规范化小写
  tokenSymbol: string;
  tokenDecimals: number;
  side: UnresolvedSide;
  phase: UnresolvedPhase;
  // 显式会计角色：leader 买入对账不写 Follower 持仓；follower 买入成功才写持仓。
  accountingRole: AccountingRole;
  // buy: 计划投入的原生币（作为建仓成本）；sell: 计划卖出的代币数量（用于减仓）
  plannedAmountWei: bigint;
  // buy: 广播前的代币余额，用于对账时以可靠差值计算实际到账量
  balanceBeforeWei?: bigint;
  // follower 对账恢复账本所需；leader 无需快照
  snapshotBefore?: PositionSnapshot;
  createdAt: number;
}

// ---- 序列化：bigint → string，localStorage 只存非敏感元数据 ----

interface StoredSnapshot {
  amountWei: string;
  costBnbWei: string;
  tokenSymbol: string;
  decimals: number;
  buyTxHash?: string;
}

interface StoredUnresolved {
  chainId: number;
  txHash: string;
  walletAddress: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  side: UnresolvedSide;
  phase: UnresolvedPhase;
  accountingRole: AccountingRole;
  plannedAmountWei: string;
  balanceBeforeWei?: string;
  snapshotBefore?: StoredSnapshot;
  createdAt: number;
}

export const UNRESOLVED_STORAGE_KEY = "bnbchange.unresolved.v1";

function makeId(
  chainId: number,
  txHash: string,
  walletAddress: string,
  side: UnresolvedSide,
  phase: UnresolvedPhase
): string {
  return `${chainId}-${txHash.toLowerCase()}-${walletAddress.toLowerCase()}-${side}-${phase}`;
}

export function snapshotOf(pos: Position): PositionSnapshot {
  return {
    amountWei: pos.amountWei,
    costBnbWei: pos.costBnbWei,
    tokenSymbol: pos.tokenSymbol,
    decimals: pos.decimals,
    buyTxHash: pos.buyTxHash,
  };
}

export function emptySnapshot(
  tokenSymbol: string,
  decimals: number
): PositionSnapshot {
  return { amountWei: 0n, costBnbWei: 0n, tokenSymbol, decimals };
}

function toStored(tx: UnresolvedTx): StoredUnresolved {
  return {
    chainId: tx.chainId,
    txHash: tx.txHash,
    walletAddress: tx.walletAddress,
    tokenAddress: tx.tokenAddress,
    tokenSymbol: tx.tokenSymbol,
    tokenDecimals: tx.tokenDecimals,
    side: tx.side,
    phase: tx.phase,
    accountingRole: tx.accountingRole,
    plannedAmountWei: tx.plannedAmountWei.toString(),
    balanceBeforeWei:
      tx.balanceBeforeWei === undefined
        ? undefined
        : tx.balanceBeforeWei.toString(),
    snapshotBefore: tx.snapshotBefore
      ? {
          amountWei: tx.snapshotBefore.amountWei.toString(),
          costBnbWei: tx.snapshotBefore.costBnbWei.toString(),
          tokenSymbol: tx.snapshotBefore.tokenSymbol,
          decimals: tx.snapshotBefore.decimals,
          buyTxHash: tx.snapshotBefore.buyTxHash,
        }
      : undefined,
    createdAt: tx.createdAt,
  };
}

// ---- 运行时校验：任何非法字段都抛错，触发 Fail Closed，绝不静默放行 ----

const SIDES: UnresolvedSide[] = ["buy", "sell"];
const PHASES: UnresolvedPhase[] = ["approval", "swap"];
const ROLES: AccountingRole[] = ["leader", "follower"];

function fail(msg: string): never {
  throw new Error(`待对账数据非法：${msg}`);
}

function parseBigIntStrict(s: unknown, label: string): bigint {
  if (typeof s !== "string" || !/^-?\d+$/.test(s)) fail(`${label} 必须是数字字符串`);
  try {
    return BigInt(s);
  } catch {
    fail(`${label} 无法解析`);
  }
}

function assertHex32(s: unknown, label: string): asserts s is string {
  if (typeof s !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(s)) {
    fail(`${label} 必须是 32 字节十六进制交易哈希`);
  }
}

function assertAddress(s: unknown, label: string): asserts s is string {
  if (typeof s !== "string" || !ethers.isAddress(s)) {
    fail(`${label} 必须是合法 EVM 地址`);
  }
}

function assertInt(
  v: unknown,
  label: string,
  min: number,
  max: number
): asserts v is number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    fail(`${label} 必须是 ${min}~${max} 的整数`);
  }
}

function assertEnum<T extends string>(
  v: unknown,
  label: string,
  allowed: T[]
): asserts v is T {
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    fail(`${label} 取值非法`);
  }
}

function parseSnapshot(s: unknown): PositionSnapshot | undefined {
  if (s === undefined) return undefined;
  if (typeof s !== "object" || s === null) fail("快照必须是对象");
  const o = s as Record<string, unknown>;
  const amountWei = parseBigIntStrict(o.amountWei, "快照 amountWei");
  const costBnbWei = parseBigIntStrict(o.costBnbWei, "快照 costBnbWei");
  if (amountWei < 0n) fail("快照 amountWei 不能为负");
  if (costBnbWei < 0n) fail("快照 costBnbWei 不能为负");
  if (typeof o.tokenSymbol !== "string") fail("快照 tokenSymbol 必须是字符串");
  assertInt(o.decimals, "快照 decimals", 0, 255);
  let buyTxHash: string | undefined;
  if (o.buyTxHash !== undefined) {
    assertHex32(o.buyTxHash, "快照 buyTxHash");
    buyTxHash = o.buyTxHash;
  }
  return {
    amountWei,
    costBnbWei,
    tokenSymbol: o.tokenSymbol,
    decimals: o.decimals,
    buyTxHash,
  };
}

function deserializeTx(raw: unknown): UnresolvedTx {
  if (typeof raw !== "object" || raw === null) fail("记录必须是对象");
  const o = raw as Record<string, unknown>;

  assertInt(o.chainId, "chainId", 1, Number.MAX_SAFE_INTEGER);
  assertHex32(o.txHash, "txHash");
  assertAddress(o.walletAddress, "walletAddress");
  assertAddress(o.tokenAddress, "tokenAddress");
  if (typeof o.tokenSymbol !== "string") fail("tokenSymbol 必须是字符串");
  assertInt(o.tokenDecimals, "tokenDecimals", 0, 255);
  assertEnum(o.side, "side", SIDES);
  assertEnum(o.phase, "phase", PHASES);
  assertEnum(o.accountingRole, "accountingRole", ROLES);
  assertInt(o.createdAt, "createdAt", 1, Number.MAX_SAFE_INTEGER);

  const plannedAmountWei = parseBigIntStrict(o.plannedAmountWei, "plannedAmountWei");
  if (plannedAmountWei <= 0n) fail("plannedAmountWei 必须大于 0");

  let balanceBeforeWei: bigint | undefined;
  if (o.balanceBeforeWei !== undefined) {
    balanceBeforeWei = parseBigIntStrict(o.balanceBeforeWei, "balanceBeforeWei");
    if (balanceBeforeWei < 0n) fail("balanceBeforeWei 不能为负");
  }

  const snapshotBefore = parseSnapshot(o.snapshotBefore);

  const chainId = o.chainId;
  const txHash = o.txHash;
  const walletAddress = o.walletAddress;
  const side = o.side;
  const phase = o.phase;

  return {
    id: makeId(chainId, txHash, walletAddress, side, phase),
    chainId,
    txHash,
    walletAddress,
    tokenAddress: o.tokenAddress,
    tokenSymbol: o.tokenSymbol,
    tokenDecimals: o.tokenDecimals,
    side,
    phase,
    accountingRole: o.accountingRole,
    plannedAmountWei,
    balanceBeforeWei,
    snapshotBefore,
    createdAt: o.createdAt,
  };
}

function deserializeList(raw: string): UnresolvedTx[] {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) fail("必须是数组");
  return parsed.map(deserializeTx);
}

// ---- 存储访问与内存回退 ----

function getStorage(): Storage | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    /* localStorage 被禁用时回退内存 */
  }
  return null;
}

// 内存状态：本会话内的可靠回退源，权威于 localStorage（写失败不丢记录）。
const memoryStore: UnresolvedTx[] = [];
// Fail Closed：持久化数据损坏/非法时置为非空，门禁保持锁定，绝不自动清除。
let failClosedError: string | null = null;
// 是否已从 localStorage 完成首次同步；之后内存即为权威，避免写失败被旧数据覆盖。
let bootstrapped = false;

function cloneTx(tx: UnresolvedTx): UnresolvedTx {
  return {
    ...tx,
    snapshotBefore: tx.snapshotBefore ? { ...tx.snapshotBefore } : undefined,
  };
}

export function loadUnresolved(): UnresolvedTx[] {
  if (failClosedError) return memoryStore.map(cloneTx);

  if (!bootstrapped) {
    bootstrapped = true;
    const s = getStorage();
    if (s) {
      let raw: string | null = null;
      try {
        raw = s.getItem(UNRESOLVED_STORAGE_KEY);
      } catch {
        failClosedError =
          "待对账数据读取失败，已禁止交易，请勿清空本地数据";
        return memoryStore.map(cloneTx);
      }
      if (raw != null) {
        try {
          const list = deserializeList(raw);
          memoryStore.length = 0;
          memoryStore.push(...list);
        } catch {
          failClosedError =
            "待对账数据损坏或格式非法，已禁止交易，请勿自动清除数据";
          return memoryStore.map(cloneTx);
        }
      }
    }
  }

  return memoryStore.map(cloneTx);
}

function persist(list: UnresolvedTx[]): void {
  memoryStore.length = 0;
  memoryStore.push(...list.map(cloneTx));
  const s = getStorage();
  if (!s) return;
  try {
    s.setItem(UNRESOLVED_STORAGE_KEY, JSON.stringify(list.map(toStored)));
  } catch {
    /* 写失败：内存副本已保留，本会话门禁不受影响 */
  }
}

export function hasUnresolved(): boolean {
  return loadUnresolved().length > 0;
}

// 全局门禁原因：Fail Closed（数据损坏）或存在 unresolved 时返回非空。
export function unresolvedGateReason(): string | null {
  // 先触发 bootstrap/校验（loadUnresolved 可能置 failClosedError），再判断。
  const has = hasUnresolved();
  if (failClosedError) return failClosedError;
  return has
    ? "存在待对账的链上交易，请先查询链上结果并完成对账后再操作"
    : null;
}

export function addUnresolved(
  input: Omit<UnresolvedTx, "id" | "createdAt">
): UnresolvedTx {
  const list = loadUnresolved();
  const id = makeId(
    input.chainId,
    input.txHash,
    input.walletAddress,
    input.side,
    input.phase
  );
  const existing = list.find((t) => t.id === id);
  if (existing) return existing;

  const tx: UnresolvedTx = {
    ...input,
    id,
    createdAt: Date.now(),
  };
  list.push(tx);
  persist(list);
  return tx;
}

export function removeUnresolved(id: string): UnresolvedTx[] {
  const list = loadUnresolved().filter((t) => t.id !== id);
  persist(list);
  return list;
}

// 供测试清理环境，避免测试间污染内存/存储。生产 UI 不得调用此函数清除损坏数据。
export function clearUnresolved(): void {
  failClosedError = null;
  bootstrapped = false;
  memoryStore.length = 0;
  const s = getStorage();
  if (s) {
    try {
      s.removeItem(UNRESOLVED_STORAGE_KEY);
    } catch {
      /* 忽略 */
    }
  }
}

// ---- 对账：只读链上 receipt，绝不广播 ----

export type ReconcileOutcome =
  | "pending"
  | "reverted"
  | "buy-success"
  | "sell-success"
  | "approval-only";

export interface ReconcileResult {
  outcome: ReconcileOutcome;
  message: string;
  // buy-success 时的实际到账量（balance delta），用于按实际到账量建仓
  receivedAmountWei?: bigint;
}

export async function reconcileTx(
  tx: UnresolvedTx,
  provider: ethers.Provider,
  readTokenBalance: (wallet: string, token: string) => Promise<bigint>
): Promise<ReconcileResult> {
  // 对账前校验当前 provider 链与 unresolved.chainId 一致；不一致保持锁定。
  try {
    const net = await provider.getNetwork();
    if (Number(net.chainId) !== tx.chainId) {
      return {
        outcome: "pending",
        message: "当前网络与待对账交易链不一致，请切换网络后再对账",
      };
    }
  } catch {
    return { outcome: "pending", message: "无法确认当前网络，请稍后重试" };
  }

  let receipt: ethers.TransactionReceipt | null;
  try {
    receipt = await provider.getTransactionReceipt(tx.txHash);
  } catch {
    return { outcome: "pending", message: "查询链上结果失败，请稍后重试" };
  }

  // receipt 为 null：交易尚未上链/未确认，继续保持锁定
  if (!receipt) {
    return { outcome: "pending", message: "链上尚未确认该交易，请稍后重试" };
  }
  // 状态未定（罕见：receipt 已返回但 status 为空）
  if (receipt.status == null) {
    return { outcome: "pending", message: "交易状态尚未确定，请稍后重试" };
  }
  // 回滚：不改持仓，允许该记录完成对账
  if (receipt.status === 0) {
    return { outcome: "reverted", message: "交易已回滚，无实际成交" };
  }

  // receipt.status === 1
  if (tx.side === "buy") {
    // 必须用「广播前余额 + 对账时余额」的可靠差值，禁止用报价 expectedOut
    if (tx.balanceBeforeWei === undefined) {
      return {
        outcome: "pending",
        message: "缺少广播前余额，无法确定实际到账量，请保持待对账",
      };
    }
    let balanceAfter: bigint;
    try {
      balanceAfter = await readTokenBalance(tx.walletAddress, tx.tokenAddress);
    } catch {
      return { outcome: "pending", message: "无法读取链上余额，请稍后重试" };
    }
    const received =
      balanceAfter > tx.balanceBeforeWei ? balanceAfter - tx.balanceBeforeWei : 0n;
    if (received <= 0n) {
      return {
        outcome: "pending",
        message: "实际到账量无法确定，请保持待对账，不得伪造持仓",
      };
    }
    return { outcome: "buy-success", receivedAmountWei: received, message: "买入已确认" };
  }

  // sell：仅 approval 成功、swap 未广播 → 不减仓
  if (tx.phase === "approval") {
    return { outcome: "approval-only", message: "仅授权成功，卖出未发生" };
  }
  return { outcome: "sell-success", message: "卖出已确认" };
}

// ---- 对账账本更新：可恢复、可验证、幂等 ----

export type ApplyStatus = "applied" | "pending" | "inconsistent";

export interface ApplyResult {
  status: ApplyStatus;
  message: string;
}

// 根据对账结果把账本设置为唯一确定的目标持仓（幂等）。
// leader 不触碰 Follower 持仓；follower 依据快照 + 链上结果计算目标。
// 只有账本达到目标状态并验证成功才返回 applied。
export function applyReconciliation(
  tx: UnresolvedTx,
  result: ReconcileResult
): ApplyResult {
  // Leader：任何结果都只完成对账、解除记录，绝不写 Follower 持仓。
  if (tx.accountingRole === "leader") {
    return { status: "applied", message: "带单交易对账完成，无持仓变更" };
  }

  if (result.outcome === "pending") {
    return { status: "pending", message: result.message };
  }

  const snap = tx.snapshotBefore;
  if (!snap) {
    return {
      status: "inconsistent",
      message: "缺少操作前持仓快照，无法恢复账本，保持锁定",
    };
  }

  let target: { amountWei: bigint; costBnbWei: bigint; buyTxHash?: string };
  if (result.outcome === "buy-success") {
    const received = result.receivedAmountWei ?? 0n;
    if (received <= 0n) {
      return { status: "inconsistent", message: "实际到账量无法确定，保持锁定" };
    }
    // 目标 = 操作前持仓 + 实际到账量；成本 = 操作前成本 + 计划投入
    target = {
      amountWei: snap.amountWei + received,
      costBnbWei: snap.costBnbWei + tx.plannedAmountWei,
      buyTxHash: snap.buyTxHash ?? tx.txHash,
    };
  } else if (result.outcome === "sell-success") {
    if (tx.plannedAmountWei > snap.amountWei) {
      return {
        status: "inconsistent",
        message: "卖出数量超过操作前持仓，账本无法恢复，保持锁定",
      };
    }
    const remaining = snap.amountWei - tx.plannedAmountWei;
    const cost =
      remaining > 0n
        ? (snap.costBnbWei * remaining) / snap.amountWei
        : 0n;
    target = { amountWei: remaining, costBnbWei: cost, buyTxHash: snap.buyTxHash };
  } else {
    // reverted / approval-only：目标 = 操作前持仓
    target = {
      amountWei: snap.amountWei,
      costBnbWei: snap.costBnbWei,
      buyTxHash: snap.buyTxHash,
    };
  }

  setPosition(
    tx.chainId,
    tx.walletAddress,
    tx.tokenAddress,
    snap.tokenSymbol,
    snap.decimals,
    target.amountWei,
    target.costBnbWei,
    target.buyTxHash
  );

  // 验证账本达到目标状态
  const current = getPosition(tx.chainId, tx.walletAddress, tx.tokenAddress);
  if (target.amountWei <= 0n) {
    if (current == null) {
      return { status: "applied", message: "账本已清空，对账完成" };
    }
    return { status: "inconsistent", message: "账本未达到目标状态，保持锁定" };
  }
  if (
    current &&
    current.amountWei === target.amountWei &&
    current.costBnbWei === target.costBnbWei
  ) {
    return { status: "applied", message: "账本已更新至目标状态，对账完成" };
  }
  return { status: "inconsistent", message: "账本未达到目标状态，保持锁定" };
}
