import type { CloudflareEnv } from "../../types/env";
import { hashPassword, verifyPasswordAllowPlaintext } from "./password";

export interface AdminUserRow {
	id: number;
	username: string;
	password_hash: string;
	enabled: number;
	created_at: string;
	updated_at: string;
}

export async function getAdminUserByUsername(
	db: D1Database,
	username: string,
): Promise<AdminUserRow | null> {
	if (!username) return null;
	const row = await db
		.prepare(
			"SELECT id, username, password_hash, enabled, created_at, updated_at FROM admin_users WHERE username = ?",
		)
		.bind(username.trim())
		.first<AdminUserRow>();
	return row ?? null;
}

export async function verifyAdminUserCredentials(
	db: D1Database,
	username: string,
	password: string,
): Promise<boolean> {
	const user = await getAdminUserByUsername(db, username);
	if (!user) return false;
	if (user.enabled !== 1) return false;

	// 兼容站长手工写库时把密码写成明文：比对通过后自动升级为 bcrypt 哈希
	return verifyPasswordAllowPlaintext(
		password,
		user.password_hash,
		async (hash) => {
			await db
				.prepare(
					"UPDATE admin_users SET password_hash = ?, updated_at = datetime('now') WHERE username = ?",
				)
				.bind(hash, user.username)
				.run();
		},
	);
}

// 管理员不再提供「注册/初始化」入口：账号只能由站长直接写库（见 verifyAdminUserCredentials 的明文兼容）。

export async function updateAdminUserPassword(
	db: D1Database,
	username: string,
	password: string,
): Promise<boolean> {
	const name = String(username || "").trim();
	if (!name || !password) return false;
	const user = await getAdminUserByUsername(db, name);
	if (!user) return false;
	const hash = await hashPassword(password);
	await db
		.prepare(
			"UPDATE admin_users SET password_hash = ?, updated_at = datetime('now') WHERE username = ?",
		)
		.bind(hash, name)
		.run();
	return true;
}

export async function authenticateAdmin(
	env: CloudflareEnv,
	db: D1Database,
	username: string,
	password: string,
): Promise<boolean> {
	return verifyAdminUserCredentials(db, username, password);
}
