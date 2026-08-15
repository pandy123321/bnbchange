import { describe, it, expect } from "vitest";
import { ethers } from "ethers";
import { checkTransferFunds, verifyErc20Transfer } from "../src/transfer/token";
import { ERC20_ABI } from "../src/transfer/abi";
import type { TokenConfig } from "../src/config/networks";

const NATIVE: TokenConfig = { symbol: "BNB", name: "BNB", address: null, decimals: 18 };
const ERC20: TokenConfig = {
  symbol: "USDT",
  name: "USDT",
  address: "0x55d398326f99059fF775485246999027B3197955",
  decimals: 18,
};
const FROM = "0x1111111111111111111111111111111111111111";
const TO = "0x2222222222222222222222222222222222222222";

describe("checkTransferFunds 余额预检边界", () => {
  it("原生币本金够、Gas 够但本金加 Gas 不够时必须阻止", () => {
    const r = checkTransferFunds(NATIVE, 0n, 14n, 10n, 5n);
    expect(r.ok).toBe(false);
  });

  it("原生币余额刚好等于本金加 Gas 时可以通过", () => {
    const r = checkTransferFunds(NATIVE, 0n, 15n, 10n, 5n);
    expect(r.ok).toBe(true);
  });

  it("ERC20 代币余额够但原生币 Gas 不够时必须阻止", () => {
    const r = checkTransferFunds(ERC20, 10n, 4n, 10n, 5n);
    expect(r.ok).toBe(false);
  });

  it("ERC20 代币余额与 Gas 均够时通过", () => {
    const r = checkTransferFunds(ERC20, 10n, 5n, 10n, 5n);
    expect(r.ok).toBe(true);
  });

  it("ERC20 代币余额不足时阻止", () => {
    const r = checkTransferFunds(ERC20, 9n, 5n, 10n, 5n);
    expect(r.ok).toBe(false);
  });
});

describe("verifyErc20Transfer 收据核验", () => {
  const value = 1000n;

  function transferLog(token: string, from: string, to: string, v: bigint) {
    const iface = new ethers.Interface(ERC20_ABI);
    const { topics, data } = iface.encodeEventLog("Transfer", [from, to, v]);
    return { address: token, topics, data };
  }

  it("正常返回 true 的代币显示成功", () => {
    const receipt = {
      status: 1,
      logs: [transferLog(ERC20.address!, FROM, TO, value)],
    } as unknown as ethers.TransactionReceipt;
    expect(verifyErc20Transfer(receipt, ERC20.address!, FROM, TO, value)).toBe(true);
  });

  it("返回 false 但不回滚（无 Transfer 事件）不得记为成功", () => {
    const receipt = {
      status: 1,
      logs: [],
    } as unknown as ethers.TransactionReceipt;
    expect(verifyErc20Transfer(receipt, ERC20.address!, FROM, TO, value)).toBe(false);
  });

  it("手续费代币（FOT）实际到账量小于 amountWei 仍发事件，兼容为成功", () => {
    const receipt = {
      status: 1,
      logs: [transferLog(ERC20.address!, FROM, TO, value - 10n)],
    } as unknown as ethers.TransactionReceipt;
    expect(verifyErc20Transfer(receipt, ERC20.address!, FROM, TO, value)).toBe(true);
  });

  it("回滚交易显示失败（无 Transfer 事件）", () => {
    // 回滚交易不会产生日志，因此没有可核验的 Transfer 事件
    const receipt = {
      status: 0,
      logs: [],
    } as unknown as ethers.TransactionReceipt;
    expect(verifyErc20Transfer(receipt, ERC20.address!, FROM, TO, value)).toBe(false);
  });

  it("错误代币合约的事件不得记为成功", () => {
    const receipt = {
      status: 1,
      logs: [transferLog(TO, FROM, TO, value)],
    } as unknown as ethers.TransactionReceipt;
    expect(verifyErc20Transfer(receipt, ERC20.address!, FROM, TO, value)).toBe(false);
  });
});
