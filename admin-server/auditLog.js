// 操作日志 / 审计。任何日志不得出现私钥明文或密文。
import { randomBytes } from "node:crypto";
import { dataFile, loadJson, saveJson } from "./store.js";

const LOGS_FILE = dataFile("audit.json");
const MAX_LOGS = 5000;

export function addLog({ operator, action, targetAddress = "", detail = "", txHash, ip }) {
  const { logs } = loadJson(LOGS_FILE, { logs: [] });
  const record = {
    id: randomBytes(8).toString("hex"),
    operator: String(operator ?? ""),
    action: String(action ?? ""),
    targetAddress: String(targetAddress ?? ""),
    detail: String(detail ?? ""),
    txHash: txHash || undefined,
    ip: ip || undefined,
    at: Date.now(),
  };
  logs.push(record);
  // 裁剪到最近 N 条，防止无限增长
  saveJson(LOGS_FILE, { logs: logs.slice(-MAX_LOGS) });
  return record;
}

export function listLogs() {
  return loadJson(LOGS_FILE, { logs: [] }).logs;
}
