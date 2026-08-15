// 通用 JSON 文件存储：原子写（临时文件 + rename），避免写一半崩溃导致数据损坏。
// 各领域数据文件通过 ADMIN_DATA_DIR 环境变量统一指定目录，默认在 admin-server/ 下。
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function dataFile(name) {
  const dir = process.env.ADMIN_DATA_DIR
    ? process.env.ADMIN_DATA_DIR
    : __dirname;
  return join(dir, name);
}

export function loadJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  const raw = readFileSync(file, "utf8");
  if (!raw.trim()) return fallback;
  return JSON.parse(raw);
}

export function saveJson(file, data) {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}
