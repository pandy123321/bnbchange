// admin-server CLI：初始化超级管理员、管理授权码。
import {
  createUser,
  deleteUser,
  listUsers,
  updateUser,
} from "./auth.js";
import {
  generateLicenses,
  listLicenses,
  setLicenseStatus,
} from "./license.js";

const USAGE = `用法:
  node cli.js init-admin --username <name> --password <pwd>   # 创建/重置超级管理员
  node cli.js user list                                       # 列出用户
  node cli.js user delete <username>                          # 删除用户
  node cli.js license generate [--count N] [--days D] [--note "备注"]
  node cli.js license list
  node cli.js license revoke <code>
  node cli.js license restore <code>

说明:
  init-admin 若用户名已存在则重置其密码为超级管理员。
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

function initAdmin(args) {
  const username = argValue(args, "--username");
  const password = argValue(args, "--password");
  if (!username || !password) throw new Error("需要 --username 和 --password");

  const existing = listUsers().find((u) => u.username === username);
  if (existing) {
    updateUser(username, { role: "super", password });
    console.log(`已重置超级管理员密码: ${username}`);
  } else {
    createUser(username, password, "super");
    console.log(`已创建超级管理员: ${username}`);
  }
}

function userList() {
  const users = listUsers();
  if (users.length === 0) {
    console.log("暂无用户（请先运行 init-admin）");
    return;
  }
  for (const u of users) {
    console.log(`  ${u.username}  [${u.role}]`);
  }
}

function userDelete(username) {
  deleteUser(username);
  console.log(`已删除用户: ${username}`);
}

function licenseGenerate(args) {
  const count = Number(argValue(args, "--count") ?? "1");
  const days = Number(argValue(args, "--days") ?? "0");
  const note = argValue(args, "--note") ?? "";
  if (!Number.isInteger(count) || count <= 0 || count > 10000) {
    throw new Error("--count 必须是 1~10000 的整数");
  }
  if (!Number.isFinite(days) || days < 0) {
    throw new Error("--days 必须是非负数字（0 表示永久）");
  }
  const created = generateLicenses(count, days, note);
  console.log(`已生成 ${created.length} 个授权码：\n`);
  for (const c of created) {
    console.log(`  ${c.code}   (${fmtExpiry(c)})`);
  }
}

function licenseList() {
  const licenses = listLicenses();
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

function licenseSetStatus(code, status) {
  const lic = setLicenseStatus(code, status);
  console.log(`已${status === "revoked" ? "吊销" : "恢复"}授权码: ${lic.code}`);
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return;
  }

  try {
    if (cmd === "init-admin") {
      initAdmin(args.slice(1));
    } else if (cmd === "user") {
      const sub = args[1];
      if (sub === "list") userList();
      else if (sub === "delete") userDelete(args[2]);
      else throw new Error("user 子命令: list | delete <username>");
    } else if (cmd === "license") {
      const sub = args[1];
      if (sub === "generate") licenseGenerate(args.slice(2));
      else if (sub === "list") licenseList();
      else if (sub === "revoke") licenseSetStatus(args[2], "revoked");
      else if (sub === "restore") licenseSetStatus(args[2], "active");
      else throw new Error("license 子命令: generate | list | revoke | restore");
    } else {
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
