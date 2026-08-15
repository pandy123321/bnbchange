// 用户 / RBAC + 会话。密码用 scrypt 哈希，绝不存明文。
// 角色：super（超级管理员）> admin（普通管理员）> operator（操作员）。
import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { dataFile, loadJson, saveJson } from "./store.js";

const USERS_FILE = dataFile("users.json");
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 小时

export const ROLE_RANK = { operator: 1, admin: 2, super: 3 };

export function roleAllows(actual, required) {
  return (ROLE_RANK[actual] ?? 0) >= (ROLE_RANK[required] ?? 0);
}

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password), salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password, stored) {
  try {
    const parts = String(stored ?? "").split(":");
    if (parts.length !== 2) return false;
    // 严格校验格式：salt 非空合法 hex、hash 恰好 64 字节，
    // 避免 malformed hash 触发 timingSafeEqual 长度不匹配抛异常（500）。
    const salt = Buffer.from(parts[0], "hex");
    const hash = Buffer.from(parts[1], "hex");
    if (
      !/^[0-9a-fA-F]+$/.test(parts[0]) ||
      !/^[0-9a-fA-F]+$/.test(parts[1]) ||
      salt.length === 0 ||
      hash.length !== 64
    ) {
      return false;
    }
    const test = scryptSync(String(password), salt, 64);
    return timingSafeEqual(test, hash);
  } catch {
    // 损坏/异常 hash → 安全失败，绝不抛 500
    return false;
  }
}

export function loadUsers() {
  return loadJson(USERS_FILE, { users: [] }).users;
}

export function saveUsers(users) {
  saveJson(USERS_FILE, { users });
}

export function findUser(username) {
  return loadUsers().find(
    (u) => u.username === String(username ?? "").trim()
  );
}

// 用户管理（供后台 API / CLI）。对外不返回 passwordHash。
function publicUser(u) {
  return { username: u.username, role: u.role, createdAt: u.createdAt };
}

export function listUsers() {
  return loadUsers().map(publicUser);
}

export function createUser(username, password, role) {
  const name = String(username ?? "").trim();
  if (!name) throw new Error("用户名不能为空");
  if (!["super", "admin", "operator"].includes(role)) {
    throw new Error("角色必须是 super / admin / operator");
  }
  if (!password || String(password).length < 6) {
    throw new Error("密码至少 6 位");
  }
  const users = loadUsers();
  if (users.some((u) => u.username === name)) {
    throw new Error("用户名已存在");
  }
  const user = {
    username: name,
    role,
    passwordHash: hashPassword(password),
    authVersion: 0,
    createdAt: Date.now(),
  };
  users.push(user);
  saveUsers(users);
  return publicUser(user);
}

export function updateUser(username, patch) {
  const users = loadUsers();
  const user = users.find((u) => u.username === String(username ?? "").trim());
  if (!user) throw new Error("用户不存在");
  let changed = false;
  if (patch.role != null) {
    if (!["super", "admin", "operator"].includes(patch.role)) {
      throw new Error("角色必须是 super / admin / operator");
    }
    user.role = patch.role;
    changed = true;
  }
  if (patch.password != null) {
    if (String(patch.password).length < 6) throw new Error("密码至少 6 位");
    user.passwordHash = hashPassword(patch.password);
    changed = true;
  }
  // 角色或密码变更 → 递增 authVersion，使该用户所有旧会话立即失效
  if (changed) user.authVersion = (user.authVersion ?? 0) + 1;
  saveUsers(users);
  return publicUser(user);
}

export function deleteUser(username) {
  const users = loadUsers();
  const next = users.filter(
    (u) => u.username !== String(username ?? "").trim()
  );
  if (next.length === users.length) throw new Error("用户不存在");
  saveUsers(next);
}

// 内存态会话：进程重启即失效
const sessions = new Map(); // token -> { username, role, expiresAt }

export function issueSession(user) {
  const token = randomBytes(24).toString("hex");
  sessions.set(token, {
    username: user.username,
    role: user.role,
    authVersion: user.authVersion ?? 0,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return token;
}

export function getSession(token) {
  const t = String(token ?? "").trim();
  const rec = sessions.get(t);
  if (!rec) return null;
  if (Date.now() > rec.expiresAt) {
    sessions.delete(t);
    return null;
  }
  // 每次鉴权都校验用户仍然存在 + authVersion 未变（覆盖删除/降权/改密码）
  const user = findUser(rec.username);
  if (!user) {
    sessions.delete(t);
    return null;
  }
  if ((user.authVersion ?? 0) !== (rec.authVersion ?? 0)) {
    sessions.delete(t);
    return null;
  }
  // 返回当前角色（不是登录时缓存的角色），降权立即生效
  return { username: user.username, role: user.role, expiresAt: rec.expiresAt };
}

export function destroySession(token) {
  sessions.delete(String(token ?? "").trim());
}
