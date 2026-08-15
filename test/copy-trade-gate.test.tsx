// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { CopyTrade } from "../src/swap/CopyTrade";
import {
  addUnresolved,
  clearUnresolved,
  UNRESOLVED_STORAGE_KEY,
} from "../src/swap/unresolved";
import { NETWORKS } from "../src/config/networks";
import type { Provider } from "ethers";

const NETWORK = NETWORKS["bsc-mainnet"];

beforeEach(() => {
  clearUnresolved();
});

afterEach(() => {
  cleanup();
});

describe("unresolved 全局门禁（UI，P1）", () => {
  it("存在 unresolved 时禁止手动跟单与监听启动", () => {
    addUnresolved({
      chainId: 56,
      txHash: "0x" + "ab".repeat(32),
      walletAddress: "0x1111111111111111111111111111111111111111",
      tokenAddress: "0x55d398326f99059fF775485246999027B3197955".toLowerCase(),
      tokenSymbol: "USDT",
      tokenDecimals: 18,
      side: "buy",
      phase: "swap",
      accountingRole: "follower",
      plannedAmountWei: 1n,
      balanceBeforeWei: 0n,
    });

    render(
      <CopyTrade
        network={NETWORK}
        provider={{} as Provider}
        rpcReady
        onExecutingChange={() => {}}
      />
    );

    const buyBtn = screen.getByText("开始跟单") as HTMLButtonElement;
    const monitorBtn = screen.getByText("开始监听") as HTMLButtonElement;
    expect(buyBtn.disabled).toBe(true);
    expect(monitorBtn.disabled).toBe(true);
    // 真实对账按钮出现（替代「我已人工核对」）
    expect(screen.getByText("重新查询链上结果")).toBeTruthy();
  });

  it("无 unresolved 时（rpcReady 正常）跟单与监听按钮可用", () => {
    render(
      <CopyTrade
        network={NETWORK}
        provider={{} as Provider}
        rpcReady
        onExecutingChange={() => {}}
      />
    );
    const buyBtn = screen.getByText("开始跟单") as HTMLButtonElement;
    const monitorBtn = screen.getByText("开始监听") as HTMLButtonElement;
    expect(buyBtn.disabled).toBe(false);
    expect(monitorBtn.disabled).toBe(false);
    expect(screen.queryByText("重新查询链上结果")).toBeNull();
  });

  it("本地数据损坏时 Fail Closed：按钮禁用并显示错误，不得清空数据", () => {
    // 预置非法 JSON，模拟本地数据损坏
    localStorage.setItem(UNRESOLVED_STORAGE_KEY, "{ not valid json");

    render(
      <CopyTrade
        network={NETWORK}
        provider={{} as Provider}
        rpcReady
        onExecutingChange={() => {}}
      />
    );

    const buyBtn = screen.getByText("开始跟单") as HTMLButtonElement;
    const monitorBtn = screen.getByText("开始监听") as HTMLButtonElement;
    expect(buyBtn.disabled).toBe(true);
    expect(monitorBtn.disabled).toBe(true);
    expect(screen.getByText(/损坏或格式非法/)).toBeTruthy();
    // 不得自动清空损坏数据
    expect(localStorage.getItem(UNRESOLVED_STORAGE_KEY)).toBe("{ not valid json");
  });
});
