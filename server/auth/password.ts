import bcrypt from "bcryptjs";
import { constantTimeEqual } from "../utils/timingSafe";

/**
 * 统一密码哈希/校验（管理员体系与用户体系共用）。
 *
 * bcrypt 参数：$2b$ 10 轮（管理员与用户保持一致）。
 */
export const BCRYPT_ROUNDS = 10;

/** 是否为 bcrypt 哈希（$2$ / $2a$ / $2b$ / $2y$ 且长度 60） */
export function isBcryptHash(value: string): boolean {
	return (
		(value.startsWith("$2$") ||
			value.startsWith("$2a$") ||
			value.startsWith("$2b$") ||
			value.startsWith("$2y$")) &&
		value.length === 60
	);
}

export async function hashPassword(
	password: string,
	rounds: number = BCRYPT_ROUNDS,
): Promise<string> {
	return bcrypt.hash(password, rounds);
}

/**
 * 校验密码，并兼容「库里存的是明文」的历史手工写入场景。
 *
 * 本站不提供任何管理员注册/初始化入口：管理员账号只能由站长直接写库。
 * 手工写库时最容易把密码以明文填进 password 列，故此处做兼容：
 *  - 存的是 bcrypt 哈希 → 常规比对；
 *  - 存的是明文       → 恒定时间比对，通过后立即回写 bcrypt 哈希（自动升级，只发生一次）。
 *
 * @param onUpgrade 明文比对通过后回写哈希；失败不影响本次登录结果
 */
export async function verifyPasswordAllowPlaintext(
	plain: string,
	stored: string,
	onUpgrade: (hash: string) => Promise<void>,
	rounds: number = BCRYPT_ROUNDS,
): Promise<boolean> {
	if (!plain || !stored) return false;

	if (isBcryptHash(stored)) return bcrypt.compare(plain, stored);

	// 明文兼容：仅当完全相等才通过，避免把哈希误判为明文
	if (!constantTimeEqual(plain, stored)) return false;

	try {
		await onUpgrade(await hashPassword(plain, rounds));
	} catch {
		// 回写失败不影响本次登录（下次登录会再尝试升级）
	}
	return true;
}
