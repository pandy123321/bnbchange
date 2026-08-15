// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import App from "../src/App";

// 测试绝不触碰真实 RPC：mock pickProvider 返回一个立即出块的假 Provider。
vi.mock("../src/utils/rpc", () => ({
  pickProvider: () =>
    Promise.resolve({ provider: { getBlockNumber: async () => 1 } }),
}));

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv("VITE_BYPASS_LICENSE", "0");
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("授权 localStorage 伪造防护（P0-2）", () => {
  it("手工写入 bnb_tool_license=permanent 不能进入系统", () => {
    localStorage.setItem("bnb_tool_license", "permanent");
    render(<App />);
    expect(screen.getByText("仅限内部授权使用")).toBeTruthy();
    expect(screen.queryByText("带单跟单")).toBeNull();
  });

  it("写入未来时间戳不能进入系统", () => {
    localStorage.setItem(
      "bnb_tool_license",
      String(Date.now() + 10 * 365 * 24 * 3600 * 1000)
    );
    render(<App />);
    expect(screen.getByText("仅限内部授权使用")).toBeTruthy();
    expect(screen.queryByText("带单跟单")).toBeNull();
  });
});
