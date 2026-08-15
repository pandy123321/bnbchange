// vitest 全局 setup：在测试文件（及其 import）执行前运行。
// 为 admin-server 使用独立的临时数据目录，避免污染真实数据；
// 为 keyStore 加密设置测试主密钥（绝不使用真实 master.key / MASTER_KEY）。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ADMIN_DATA_DIR = mkdtempSync(join(tmpdir(), "bnbchange-admin-"));
process.env.MASTER_KEY = "test-only-master-key";
