import { describe, it, expect } from "vitest";
import { ethers } from "ethers";
import {
  parseRecipients,
  parseRecipientInput,
  findDuplicates,
  totalAmountWei,
  parseAddresses,
} from "../src/transfer/parser";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

describe("parseRecipients 文本/CSV 每行 address,amount", () => {
  it("正常解析多行", () => {
    const rs = parseRecipients(`${A},1.5\n${B} 0.25`, 18);
    expect(rs).toHaveLength(2);
    expect(rs[0].address).toBe(ethersChecksum(A));
    expect(rs[0].amountWei).toBe(1500000000000000000n);
    expect(rs[1].amountWei).toBe(250000000000000000n);
  });

  it("跳过表头行", () => {
    const rs = parseRecipients(`address,amount\n${A},1`, 18);
    expect(rs).toHaveLength(1);
    expect(rs[0].address).toBe(ethersChecksum(A));
  });

  it("缺少金额抛错", () => {
    expect(() => parseRecipients(`${A}`, 18)).toThrow(/缺少金额/);
  });

  it("地址格式错误抛错", () => {
    expect(() => parseRecipients(`0x123,1`, 18)).toThrow(/地址格式错误/);
  });

  it("金额格式错误抛错", () => {
    expect(() => parseRecipients(`${A},abc`, 18)).toThrow(/金额格式错误/);
  });

  it("金额为 0 抛错", () => {
    expect(() => parseRecipients(`${A},0`, 18)).toThrow(/必须大于 0/);
  });

  it("空输入抛错", () => {
    expect(() => parseRecipients("   ", 18)).toThrow(/至少输入/);
  });
});

describe("parseRecipientInput 统一导入（文本/JSON）", () => {
  it("文本回退到 parseRecipients", () => {
    const rs = parseRecipientInput(`${A},1`, 18);
    expect(rs).toHaveLength(1);
  });

  it("JSON 数组对象", () => {
    const rs = parseRecipientInput(
      JSON.stringify([{ address: A, amount: "2" }]),
      18
    );
    expect(rs).toHaveLength(1);
    expect(rs[0].amountWei).toBe(2000000000000000000n);
  });

  it("JSON 二维数组", () => {
    const rs = parseRecipientInput(JSON.stringify([[A, "1"]]), 18);
    expect(rs).toHaveLength(1);
    expect(rs[0].address).toBe(ethersChecksum(A));
  });

  it("JSON 非数组抛错", () => {
    expect(() => parseRecipientInput('{"a":1}', 18)).toThrow(/必须是数组/);
  });

  it("JSON 格式错误抛错", () => {
    expect(() => parseRecipientInput("[{", 18)).toThrow(/JSON 格式错误/);
  });

  it("JSON 金额为 0 抛错", () => {
    expect(() =>
      parseRecipientInput(JSON.stringify([{ address: A, amount: "0" }]), 18)
    ).toThrow(/必须大于 0/);
  });

  it("空内容抛错", () => {
    expect(() => parseRecipientInput("", 18)).toThrow(/内容为空/);
  });
});

describe("findDuplicates 重复检测", () => {
  it("检测重复地址", () => {
    const rs = parseRecipients(`${A},1\n${A},2\n${B},1`, 18);
    expect(findDuplicates(rs)).toEqual([ethersChecksum(A)]);
  });

  it("无重复返回空数组", () => {
    const rs = parseRecipients(`${A},1\n${B},2`, 18);
    expect(findDuplicates(rs)).toEqual([]);
  });
});

describe("totalAmountWei 合计", () => {
  it("正确累加", () => {
    const rs = parseRecipients(`${A},1\n${B},2`, 18);
    expect(totalAmountWei(rs)).toBe(3000000000000000000n);
  });
});

describe("parseAddresses 纯地址列表", () => {
  it("正常解析", () => {
    const addrs = parseAddresses(`${A}\n${B}`);
    expect(addrs).toHaveLength(2);
    expect(addrs[0].address).toBe(ethersChecksum(A));
  });
});

// ethers.getAddress 输出 checksum 地址，测试用统一 helper 生成期望值
function ethersChecksum(addr: string): string {
  return ethers.getAddress(addr);
}
