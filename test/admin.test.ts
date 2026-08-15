import { describe, it, expect, beforeEach } from "vitest";
import { ethers } from "ethers";
import { rmSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  createUser,
  updateUser,
  deleteUser,
  issueSession,
  getSession,
  roleAllows,
  loadUsers,
  hashPassword,
  verifyPassword,
} from "../admin-server/auth";
import {
  generateLicenses,
  setLicenseStatus,
  listLicenses,
  verify,
  issueSession as issueLicenseSession,
  consumeSession,
} from "../admin-server/license";
import {
  upsertPosition,
  reducePosition,
  listPositions,
} from "../admin-server/positionStore";
import { createKey, listKeys, updateKey, getKey, revealKey } from "../admin-server/keyStore";
import { decodeMasterKey, encrypt, decrypt } from "../admin-server/crypto";
import { deriveAddressFromPrivateKey } from "../admin-server/validation";

const FOLLOWER = "0x3333333333333333333333333333333333333333";
const TOKEN = "0x55d398326f99059fF775485246999027B3197955";

function cleanData() {
  const dir = process.env.ADMIN_DATA_DIR!;
  for (const f of readdirSync(dir)) {
    rmSync(join(dir, f), { force: true });
  }
}

beforeEach(() => {
  cleanData();
});

describe("auth.js 会话失效（P0-3）", () => {
  it("用户被删除后旧会话立即失效", () => {
    createUser("alice", "password1", "super");
    const token = issueSession({ username: "alice", role: "super", authVersion: 0 });
    expect(getSession(token)?.role).toBe("super");
    deleteUser("alice");
    expect(getSession(token)).toBeNull();
  });

  it("用户被降权后旧会话立即失效", () => {
    createUser("bob", "password1", "super");
    const token = issueSession({ username: "bob", role: "super", authVersion: 0 });
    updateUser("bob", { role: "admin" });
    expect(getSession(token)).toBeNull();
  });

  it("用户修改密码后旧会话立即失效", () => {
    createUser("carol", "password1", "admin");
    const token = issueSession({ username: "carol", role: "admin", authVersion: 0 });
    updateUser("carol", { password: "password2" });
    expect(getSession(token)).toBeNull();
  });

  it("有效会话返回当前角色（非登录时缓存）", () => {
    createUser("dave", "password1", "super");
    const token = issueSession({ username: "dave", role: "super", authVersion: 0 });
    expect(getSession(token)?.role).toBe("super");
  });

  it("Operator 无法通过 Admin 权限判定（roleAllows）", () => {
    expect(roleAllows("operator", "admin")).toBe(false);
    expect(roleAllows("admin", "operator")).toBe(true);
    expect(roleAllows("super", "admin")).toBe(true);
  });
});

describe("license.js 输入校验与会话（P0-2 / P1-6）", () => {
  it("超大授权码数量被拒绝且零写入", () => {
    expect(() => generateLicenses(10001, 30)).toThrow();
    expect(listLicenses()).toHaveLength(0);
  });

  it("count 为 0 / 负数被拒绝", () => {
    expect(() => generateLicenses(0, 30)).toThrow();
    expect(() => generateLicenses(-5, 30)).toThrow();
  });

  it("days 负数 / 非有限 / 超上限被拒绝", () => {
    expect(() => generateLicenses(1, -1)).toThrow();
    expect(() => generateLicenses(1, NaN)).toThrow();
    expect(() => generateLicenses(1, 3651)).toThrow();
  });

  it("授权状态只允许 active/revoked", () => {
    const [lic] = generateLicenses(1, 30);
    expect(() => setLicenseStatus(lic.code, "bogus")).toThrow();
    setLicenseStatus(lic.code, "revoked");
    expect(verify(lic.code).ok).toBe(false);
  });

  it("一次性会话第二次消费失败", () => {
    const [lic] = generateLicenses(1, 0);
    const issued = issueLicenseSession(lic.code);
    expect(issued.ok).toBe(true);
    expect(consumeSession(issued.sessionToken).ok).toBe(true);
    expect(consumeSession(issued.sessionToken).ok).toBe(false);
  });

  it("被吊销授权无法签发会话（重启后失效）", () => {
    const [lic] = generateLicenses(1, 30);
    setLicenseStatus(lic.code, "revoked");
    expect(issueLicenseSession(lic.code).ok).toBe(false);
  });
});

describe("positionStore.js 输入校验（P1-6）", () => {
  const base = {
    chainId: 56,
    follower: FOLLOWER,
    tokenAddress: TOKEN,
    decimals: 18,
    amountWei: "1000000000000000000",
    costBnbWei: "0",
    avgPriceWei: "0",
  };

  it("非法地址被拒绝且零写入", () => {
    expect(() => upsertPosition({ ...base, follower: "0x123" })).toThrow();
    expect(listPositions()).toHaveLength(0);
  });

  it("非法 chainId 被拒绝", () => {
    expect(() => upsertPosition({ ...base, chainId: 0 })).toThrow();
    expect(listPositions()).toHaveLength(0);
  });

  it("负数减仓被拒绝且持仓不变", () => {
    upsertPosition(base);
    expect(() => reducePosition(56, FOLLOWER, TOKEN, "-1")).toThrow();
    expect(listPositions()[0].amountWei).toBe("1000000000000000000");
  });

  it("超额减仓被拒绝且持仓不变", () => {
    upsertPosition(base);
    expect(() => reducePosition(56, FOLLOWER, TOKEN, "2000000000000000000")).toThrow();
    expect(listPositions()[0].amountWei).toBe("1000000000000000000");
  });

  it("合法减仓成功且扣减正确", () => {
    upsertPosition(base);
    const p = reducePosition(56, FOLLOWER, TOKEN, "400000000000000000");
    expect(p.amountWei).toBe("600000000000000000");
  });
});

describe("keyStore.js 私钥托管（P1-6）", () => {
  const wallet = ethers.Wallet.createRandom();
  const pk = wallet.privateKey;
  const addr = wallet.address;

  it("合法私钥自动派生地址且不泄露私钥/密文", () => {
    const rec = createKey({ walletType: "follower", privateKey: pk });
    expect(rec.address.toLowerCase()).toBe(addr.toLowerCase());
    expect(JSON.stringify(rec)).not.toContain(pk);
    expect(rec).not.toHaveProperty("enc");
  });

  it("地址与私钥不匹配被拒绝且零写入", () => {
    expect(() =>
      createKey({
        walletType: "follower",
        privateKey: pk,
        address: "0x0000000000000000000000000000000000000000",
      })
    ).toThrow();
    expect(listKeys()).toHaveLength(0);
  });

  it("非法私钥被拒绝", () => {
    expect(() => createKey({ walletType: "follower", privateKey: "not-a-key" })).toThrow();
  });

  it("非法 walletType 被拒绝", () => {
    expect(() => createKey({ walletType: "hacker", privateKey: pk })).toThrow();
  });
});

describe("keyStore.js key/address 强一致（P1-1）", () => {
  it("updateKey 仅改 address 被拒绝且记录不变", () => {
    const w = ethers.Wallet.createRandom();
    const rec = createKey({ walletType: "follower", privateKey: w.privateKey });
    const other = ethers.Wallet.createRandom();
    expect(() => updateKey(rec.id, { address: other.address })).toThrow();
    const after = getKey(rec.id)!;
    expect(after.address.toLowerCase()).toBe(w.address.toLowerCase());
  });

  it("updateKey 更新 privateKey 自动派生新地址", () => {
    const w1 = ethers.Wallet.createRandom();
    const rec = createKey({ walletType: "follower", privateKey: w1.privateKey });
    const w2 = ethers.Wallet.createRandom();
    const updated = updateKey(rec.id, { privateKey: w2.privateKey });
    expect(updated.address.toLowerCase()).toBe(w2.address.toLowerCase());
    expect(revealKey(rec.id)).toBe(w2.privateKey);
  });

  it("updateKey 同时提交 address 与 privateKey 不一致被拒绝", () => {
    const w1 = ethers.Wallet.createRandom();
    const rec = createKey({ walletType: "follower", privateKey: w1.privateKey });
    const w2 = ethers.Wallet.createRandom();
    const w3 = ethers.Wallet.createRandom();
    expect(() =>
      updateKey(rec.id, { privateKey: w2.privateKey, address: w3.address })
    ).toThrow();
  });

  it("解密后派生地址恒等于存储地址（invariant）", () => {
    const w = ethers.Wallet.createRandom();
    const rec = createKey({ walletType: "follower", privateKey: w.privateKey });
    const revealed = revealKey(rec.id);
    expect(deriveAddressFromPrivateKey(revealed).toLowerCase()).toBe(
      rec.address.toLowerCase()
    );
  });
});

describe("crypto.js MASTER_KEY 强度（P1-2）", () => {
  it("64 位 hex 解析为 32 字节", () => {
    expect(decodeMasterKey("01".repeat(32)).length).toBe(32);
  });

  it("32 字节 base64 解析成功", () => {
    const b64 = Buffer.from("x".repeat(32)).toString("base64");
    expect(decodeMasterKey(b64).length).toBe(32);
  });

  it("低熵口令被拒绝", () => {
    expect(() => decodeMasterKey("mycompany2026")).toThrow();
    expect(() => decodeMasterKey("")).toThrow();
  });

  it("31 / 33 字节 hex 被拒绝", () => {
    expect(() => decodeMasterKey("01".repeat(31))).toThrow();
    expect(() => decodeMasterKey("01".repeat(33))).toThrow();
  });

  it("AES-GCM 加解密往返成功且随机 IV", () => {
    const a = encrypt("secret-payload");
    const b = encrypt("secret-payload");
    expect(decrypt(a)).toBe("secret-payload");
    expect(a.iv).not.toBe(b.iv);
    expect(a.data).not.toBe(b.data);
  });

  it("篡改密文 / IV 解密失败（GCM auth）", () => {
    const ct = encrypt("secret-payload");
    const badData = Buffer.from(ct.data, "base64");
    badData[0] ^= 0xff;
    expect(() => decrypt({ iv: ct.iv, data: badData.toString("base64") })).toThrow();

    const badIv = Buffer.from(ct.iv, "base64");
    badIv[0] ^= 0xff;
    expect(() => decrypt({ iv: badIv.toString("base64"), data: ct.data })).toThrow();
  });
});

describe("auth.js verifyPassword malformed hash（P2-1）", () => {
  it("正确密码通过、错误密码拒绝", () => {
    const hash = hashPassword("secret123");
    expect(verifyPassword("secret123", hash)).toBe(true);
    expect(verifyPassword("wrong", hash)).toBe(false);
  });

  it("malformed hash 安全返回 false 而非抛异常", () => {
    expect(verifyPassword("x", "00:00")).toBe(false);
    expect(verifyPassword("x", "not-a-hash")).toBe(false);
    expect(verifyPassword("x", "zz:yy")).toBe(false);
    expect(verifyPassword("x", "a:b:c")).toBe(false);
    expect(verifyPassword("x", "")).toBe(false);
    expect(verifyPassword("x", "deadbeef:0123456789abcdef")).toBe(false);
  });
});
