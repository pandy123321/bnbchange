import { describe, it, expect } from "vitest";
import { ethers } from "ethers";
import { validateWalletTopology } from "../src/swap/walletTopology";

const PK_A = "0x" + "1".repeat(64);
const PK_B = "0x" + "2".repeat(64);
const PK_C = "0x" + "3".repeat(64);

const addrA = new ethers.Wallet(PK_A).address;
const addrB = new ethers.Wallet(PK_B).address;
const addrC = new ethers.Wallet(PK_C).address;

describe("validateWalletTopology 钱包拓扑校验（P0）", () => {
  it("同一个私钥输入两次（地址重复）被拒绝", () => {
    const r = validateWalletTopology(addrA, [addrB, addrB]);
    expect(r.ok).toBe(false);
  });

  it("Follower 地址等于 Leader 时被拒绝", () => {
    const r = validateWalletTopology(addrA, [addrB, addrA]);
    expect(r.ok).toBe(false);
  });

  it("地址大小写不同但实际相同时被拒绝（重复 Follower）", () => {
    const lower = addrB.toLowerCase();
    const checksum = ethers.getAddress(addrB);
    expect(lower).not.toBe(checksum); // 确认两种写法确实不同
    const r = validateWalletTopology(addrA, [lower, checksum]);
    expect(r.ok).toBe(false);
  });

  it("Follower 地址等于 Leader（大小写不同）被拒绝", () => {
    const r = validateWalletTopology(addrA, [addrB, addrA.toLowerCase()]);
    expect(r.ok).toBe(false);
  });

  it("合法且互不重复的钱包列表能够通过", () => {
    const r = validateWalletTopology(addrA, [addrB, addrC]);
    expect(r.ok).toBe(true);
  });

  it("非法地址返回错误", () => {
    const r = validateWalletTopology(addrA, ["not-an-address"]);
    expect(r.ok).toBe(false);
  });
});
