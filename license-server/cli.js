import {
  generateCode,
  loadLicenses,
  normalizeCode,
  saveLicenses,
} from "./store.js";

const USAGE = `用法:
  node cli.js generate [--count N] [--days D] [--note "备注"]
  node cli.js list
  node cli.js revoke <code>
  node cli.js restore <code>
  node cli.js delete <code>

说明:
  --count   生成数量，默认 1
  --days    有效期天数；省略或 0 表示永久
  --note    备注（可选）
  授权码格式: XXXX-XXXX-XXXX-XXXX
`;

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function daysToExpiry(days) {
  if (!days || days <= 0) return null;
  return Date.now() + days * 24 * 60 * 60 * 1000;
}

function fmtExpiry(lic) {
  if (lic.expiresAt == null) return "永久";
  const expired = lic.expiresAt <= Date.now();
  return `${new Date(lic.expiresAt).toISOString()}${expired ? "（已过期）" : ""}`;
}

function generate(args) {
  const countRaw = argValue(args, "--count") ?? "1";
  const daysRaw = argValue(args, "--days") ?? "0";
  const note = argValue(args, "--note") ?? "";
  const count = Number(countRaw);
  const days = Number(daysRaw);

  if (!Number.isInteger(count) || count <= 0 || count > 10000) {
    throw new Error("--count 必须是 1~10000 的整数");
  }
  if (!Number.isFinite(days) || days < 0) {
    throw new Error("--days 必须是非负数字（0 表示永久）");
  }

  const existing = loadLicenses();
  const created = [];
  for (let i = 0; i < count; i++) {
    const record = {
      code: generateCode(),
      status: "active",
      createdAt: Date.now(),
      expiresAt: daysToExpiry(days),
      note: note || undefined,
    };
    existing.push(record);
    created.push(record);
  }

  saveLicenses(existing);

  console.log(`已生成 ${created.length} 个授权码：\n`);
  for (const c of created) {
    console.log(`  ${c.code}   (${fmtExpiry(c)})`);
  }
}

function list() {
  const licenses = loadLicenses();
  if (licenses.length === 0) {
    console.log("暂无授权码");
    return;
  }
  console.log(`共 ${licenses.length} 个授权码：\n`);
  for (const l of licenses) {
    const note = l.note ? `  备注: ${l.note}` : "";
    console.log(`  ${l.code}  [${l.status}]  ${fmtExpiry(l)}${note}`);
  }
}

function setStatus(code, status) {
  const normalized = normalizeCode(code);
  const licenses = loadLicenses();
  const target = licenses.find((l) => l.code === normalized);
  if (!target) {
    throw new Error(`未找到授权码: ${normalized}`);
  }
  target.status = status;
  saveLicenses(licenses);
  console.log(`已${status === "revoked" ? "吊销" : "恢复"}授权码: ${target.code}`);
}

function remove(code) {
  const normalized = normalizeCode(code);
  const licenses = loadLicenses();
  const next = licenses.filter((l) => l.code !== normalized);
  if (next.length === licenses.length) {
    throw new Error(`未找到授权码: ${normalized}`);
  }
  saveLicenses(next);
  console.log(`已删除授权码: ${normalized}`);
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return;
  }

  try {
    switch (cmd) {
      case "generate":
        generate(args.slice(1));
        break;
      case "list":
        list();
        break;
      case "revoke":
        if (!args[1]) throw new Error("缺少授权码参数");
        setStatus(args[1], "revoked");
        break;
      case "restore":
        if (!args[1]) throw new Error("缺少授权码参数");
        setStatus(args[1], "active");
        break;
      case "delete":
        if (!args[1]) throw new Error("缺少授权码参数");
        remove(args[1]);
        break;
      default:
        console.error(`未知命令: ${cmd}\n`);
        console.error(USAGE);
        process.exitCode = 1;
    }
  } catch (e) {
    console.error(`错误: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}

main();
