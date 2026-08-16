import { describe, it, expect } from "vitest";
import {
  buyOnceKey,
  calcBuyAmount,
  calcSellQuantity,
  defaultStrategy,
  shouldFollow,
  validateStrategy,
  type CopyStrategy,
} from "../src/swap/strategy";

const ONE_ETHER = 10n ** 18n;

function strat(over: Partial<CopyStrategy> = {}): CopyStrategy {
  return { ...defaultStrategy(), ...over };
}

describe("calcBuyAmount 买入金额（比例/倍数 + 四舍五入）", () => {
  it("比例 0.5 时按 Leader 买入额一半跟单", () => {
    expect(
      calcBuyAmount(ONE_ETHER, strat({ buyMode: "ratio", buyValue: 0.5 }))
    ).toBe(5n * 10n ** 17n);
  });

  it("比例 1 时全额跟单", () => {
    expect(
      calcBuyAmount(ONE_ETHER, strat({ buyMode: "ratio", buyValue: 1 }))
    ).toBe(ONE_ETHER);
  });

  it("倍数 2 时按 Leader 买入额两倍跟单", () => {
    expect(
      calcBuyAmount(ONE_ETHER, strat({ buyMode: "multiplier", buyValue: 2 }))
    ).toBe(2n * ONE_ETHER);
  });

  it("倍数 0.5 时减半跟单（倍数可小于 1）", () => {
    expect(
      calcBuyAmount(ONE_ETHER, strat({ buyMode: "multiplier", buyValue: 0.5 }))
    ).toBe(5n * 10n ** 17n);
  });

  it("Leader 买入额为 0 时返回 0", () => {
    expect(
      calcBuyAmount(0n, strat({ buyMode: "ratio", buyValue: 0.5 }))
    ).toBe(0n);
  });

  it("比例按 1e6 精度四舍五入", () => {
    // 0.1234567 * 1e6 = 123456.7 → 四舍五入为 123457
    expect(
      calcBuyAmount(10n ** 12n, strat({ buyMode: "ratio", buyValue: 0.1234567 }))
    ).toBe(123457n * 10n ** 6n);
  });
});

describe("calcSellQuantity 卖出数量（比例/倍数 + 截断到持仓）", () => {
  it("比例 0.5 卖出持仓一半", () => {
    expect(
      calcSellQuantity(ONE_ETHER, strat({ sellMode: "ratio", sellValue: 0.5 }))
    ).toBe(5n * 10n ** 17n);
  });

  it("比例 1 全额卖出", () => {
    expect(
      calcSellQuantity(ONE_ETHER, strat({ sellMode: "ratio", sellValue: 1 }))
    ).toBe(ONE_ETHER);
  });

  it("倍数 2 截断到当前持仓", () => {
    expect(
      calcSellQuantity(ONE_ETHER, strat({ sellMode: "multiplier", sellValue: 2 }))
    ).toBe(ONE_ETHER);
  });

  it("倍数 0.5 卖出持仓一半", () => {
    expect(
      calcSellQuantity(ONE_ETHER, strat({ sellMode: "multiplier", sellValue: 0.5 }))
    ).toBe(5n * 10n ** 17n);
  });

  it("持仓为 0 时返回 0", () => {
    expect(
      calcSellQuantity(0n, strat({ sellMode: "ratio", sellValue: 0.5 }))
    ).toBe(0n);
  });
});

describe("shouldFollow 最小跟单金额过滤", () => {
  it("未开启最小跟单金额时总是跟随", () => {
    expect(
      shouldFollow(0n, strat({ buyMinEnabled: false, buyMinAmountWei: undefined }))
    ).toBe(true);
    expect(
      shouldFollow(ONE_ETHER, strat({ buyMinEnabled: false, buyMinAmountWei: undefined }))
    ).toBe(true);
  });

  it("开启后低于阈值不跟随", () => {
    expect(
      shouldFollow(
        ONE_ETHER - 1n,
        strat({ buyMinEnabled: true, buyMinAmountWei: ONE_ETHER })
      )
    ).toBe(false);
  });

  it("开启后等于阈值跟随", () => {
    expect(
      shouldFollow(
        ONE_ETHER,
        strat({ buyMinEnabled: true, buyMinAmountWei: ONE_ETHER })
      )
    ).toBe(true);
  });

  it("开启后高于阈值跟随", () => {
    expect(
      shouldFollow(
        ONE_ETHER + 1n,
        strat({ buyMinEnabled: true, buyMinAmountWei: ONE_ETHER })
      )
    ).toBe(true);
  });

  it("开启但阈值无效时 Fail Closed（不跟随）", () => {
    expect(
      shouldFollow(
        ONE_ETHER,
        strat({ buyMinEnabled: true, buyMinAmountWei: undefined })
      )
    ).toBe(false);
    expect(
      shouldFollow(
        ONE_ETHER,
        strat({ buyMinEnabled: true, buyMinAmountWei: 0n })
      )
    ).toBe(false);
  });
});

describe("buyOnceKey 只跟一次键", () => {
  it("大小写归一化后同一地址同一代币得到相同键", () => {
    expect(buyOnceKey("0xABCdef", "0x123456")).toBe(
      buyOnceKey("0xabcdef", "0x123456")
    );
  });

  it("不同代币得到不同键", () => {
    expect(buyOnceKey("0xabc", "0x111")).not.toBe(buyOnceKey("0xabc", "0x222"));
  });

  it("键格式为 leader:token 小写", () => {
    expect(buyOnceKey("0xABC", "0xDEF")).toBe("0xabc:0xdef");
  });
});

describe("validateStrategy 策略配置校验", () => {
  it("默认策略合法", () => {
    expect(validateStrategy(defaultStrategy())).toBeNull();
  });

  it("买入比例 0 非法", () => {
    expect(validateStrategy(strat({ buyMode: "ratio", buyValue: 0 }))).not.toBeNull();
  });

  it("买入比例大于 1 非法", () => {
    expect(validateStrategy(strat({ buyMode: "ratio", buyValue: 1.5 }))).not.toBeNull();
  });

  it("买入比例等于 1 合法", () => {
    expect(validateStrategy(strat({ buyMode: "ratio", buyValue: 1 }))).toBeNull();
  });

  it("买入倍数 0 非法", () => {
    expect(
      validateStrategy(strat({ buyMode: "multiplier", buyValue: 0 }))
    ).not.toBeNull();
  });

  it("买入倍数 0.5 合法（倍数可小于 1）", () => {
    expect(
      validateStrategy(strat({ buyMode: "multiplier", buyValue: 0.5 }))
    ).toBeNull();
  });

  it("跟卖时卖出比例 0 非法", () => {
    expect(
      validateStrategy(strat({ copySell: true, sellMode: "ratio", sellValue: 0 }))
    ).not.toBeNull();
  });

  it("跟卖时卖出比例大于 1 非法", () => {
    expect(
      validateStrategy(strat({ copySell: true, sellMode: "ratio", sellValue: 1.2 }))
    ).not.toBeNull();
  });

  it("跟卖时卖出倍数 0 非法", () => {
    expect(
      validateStrategy(strat({ copySell: true, sellMode: "multiplier", sellValue: 0 }))
    ).not.toBeNull();
  });

  it("不跟卖时不校验卖出参数", () => {
    expect(
      validateStrategy(strat({ copySell: false, sellMode: "ratio", sellValue: 0 }))
    ).toBeNull();
  });

  it("买入比例 NaN 非法", () => {
    expect(
      validateStrategy(strat({ buyMode: "ratio", buyValue: NaN }))
    ).not.toBeNull();
  });

  it("买入倍数 Infinity 非法", () => {
    expect(
      validateStrategy(strat({ buyMode: "multiplier", buyValue: Infinity }))
    ).not.toBeNull();
  });

  it("买入倍数超出安全上限非法", () => {
    expect(
      validateStrategy(strat({ buyMode: "multiplier", buyValue: 1e12 }))
    ).not.toBeNull();
  });

  it("跟卖时卖出倍数 NaN 非法", () => {
    expect(
      validateStrategy(strat({ copySell: true, sellMode: "multiplier", sellValue: NaN }))
    ).not.toBeNull();
  });

  it("开启最小跟单金额但金额缺失非法（Fail Closed）", () => {
    expect(
      validateStrategy(strat({ buyMinEnabled: true, buyMinAmountWei: undefined }))
    ).not.toBeNull();
  });

  it("开启最小跟单金额但金额为 0 非法（Fail Closed）", () => {
    expect(
      validateStrategy(strat({ buyMinEnabled: true, buyMinAmountWei: 0n }))
    ).not.toBeNull();
  });

  it("开启最小跟单金额但金额为负非法", () => {
    expect(
      validateStrategy(strat({ buyMinEnabled: true, buyMinAmountWei: -1n }))
    ).not.toBeNull();
  });

  it("开启最小跟单金额且金额为正合法", () => {
    expect(
      validateStrategy(strat({ buyMinEnabled: true, buyMinAmountWei: ONE_ETHER }))
    ).toBeNull();
  });

  it("未开启最小跟单金额时金额缺失合法", () => {
    expect(
      validateStrategy(strat({ buyMinEnabled: false, buyMinAmountWei: undefined }))
    ).toBeNull();
  });
});
