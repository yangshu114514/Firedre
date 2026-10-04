import type { CloudflareEnv } from "../../types/env";
import { getClientIp } from "./clientIp";

export interface RateLimitConfig {
	windowMs: number;

	maxRequests: number;

	message?: string;

	failOpen?: boolean;

	scope?: string;
}

export interface RateLimitResult {
	allowed: boolean;

	remaining?: number;

	resetAt?: number;

	retryAfterSec?: number;
}

const defaultConfig: RateLimitConfig = {
	windowMs: 60_000, // 1 分钟
	maxRequests: 60,
	message: "请求过于频繁，请稍后再试",
};

export async function checkD1RateLimit(
	db: D1Database,
	key: string,
	config: RateLimitConfig = defaultConfig,
): Promise<RateLimitResult> {
	const now = Date.now();
	const { windowMs, maxRequests } = config;
	// 固定窗口起始
	const windowStart = now - (now % windowMs);

	try {
		const info = await db
			.prepare(`
        INSERT INTO rate_limits (key, kind, window_started_at, count, updated_at)
        VALUES (?, 'window', ?, 1, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET
          window_started_at = excluded.window_started_at,
          count = CASE
            WHEN rate_limits.window_started_at = excluded.window_started_at THEN rate_limits.count + 1
            ELSE 1
          END,
          updated_at = datetime('now')
        WHERE rate_limits.window_started_at <> excluded.window_started_at
           OR rate_limits.count < ?
      `)
			.bind(key, windowStart, maxRequests)
			.run();

		if (!info.success) {
			if (config.failOpen === false) {
				return { allowed: false, retryAfterSec: 60 };
			}
			return { allowed: true, remaining: maxRequests };
		}

		if (Number(info.meta?.changes ?? 0) <= 0) {
			return {
				allowed: false,
				retryAfterSec: Math.ceil((windowStart + windowMs - now) / 1000),
				resetAt: windowStart + windowMs,
			};
		}

		void pruneExpiredWindows(db, now, windowMs).catch(() => {});

		return {
			allowed: true,
			resetAt: windowStart + windowMs,
		};
	} catch {
		if (config.failOpen === false) {
			return { allowed: false, retryAfterSec: 60 };
		}
		return { allowed: true, remaining: maxRequests };
	}
}

async function pruneExpiredWindows(
	db: D1Database,
	now: number,
	windowMs: number,
) {
	// key 结构 = `[scope:]ip:windowMs:maxRequests`（见 withRateLimit），窗口时长已编码在 key 里。
	// 只清理与本次调用【同窗口参数】的过期行：旧实现按调用方 windowMs 无差别删除全部
	// kind='window' 行，短窗口调用（如 user-login 15min）会把长窗口（如 register 1h）的
	// 计数行提前删掉，导致长窗口限流形同虚设（register 第 4 次注册不再 429）。
	// 方案取舍：范围仅限本文件 → 不加列/不迁移；key 结构不变、存量数据直接兼容；
	// 单条 SQL 无读放大，各窗口参数组由自己的调用负责清理自己。
	// windowMs 必须以文本绑定：JS number 在部分驱动会被绑成 REAL，
	// `'%:' || 900000.0 || ':%'` 得到 '%:900000.0:%' 与 key 中的 ':900000:' 不匹配。
	await db
		.prepare(
			"DELETE FROM rate_limits WHERE kind = 'window' AND key LIKE '%:' || ? || ':%' AND window_started_at < ?",
		)
		.bind(String(windowMs), now - windowMs)
		.run();
}

const memoryStore = new Map<string, { windowStart: number; count: number }>();

export function checkMemoryRateLimit(
	key: string,
	config: RateLimitConfig = defaultConfig,
): RateLimitResult {
	const now = Date.now();
	const { windowMs, maxRequests } = config;
	const windowStart = now - (now % windowMs);

	const row = memoryStore.get(key);
	if (!row || row.windowStart !== windowStart) {
		memoryStore.set(key, { windowStart, count: 1 });
		return {
			allowed: true,
			remaining: maxRequests - 1,
			resetAt: windowStart + windowMs,
		};
	}

	if (row.count >= maxRequests) {
		return {
			allowed: false,
			retryAfterSec: Math.ceil((windowStart + windowMs - now) / 1000),
			resetAt: windowStart + windowMs,
		};
	}

	row.count += 1;
	return {
		allowed: true,
		remaining: maxRequests - row.count,
		resetAt: windowStart + windowMs,
	};
}

export async function withRateLimit<T extends Response>(
	env: CloudflareEnv,
	request: Request,
	config: RateLimitConfig,
	handler: () => Promise<T>,
): Promise<T> {
	const resolvedConfig = config ?? defaultConfig;
	const clientIp = getClientIp(request);
	const scopePart = resolvedConfig.scope ? `${resolvedConfig.scope}:` : "";
	const rateKey = `${scopePart}${clientIp}:${resolvedConfig.windowMs}:${resolvedConfig.maxRequests}`;

	let allowed = true;
	let retryAfter = 0;

	if (env?.DB) {
		const result = await checkD1RateLimit(env.DB, rateKey, resolvedConfig);
		allowed = result.allowed;
		retryAfter = result.retryAfterSec || 0;
	} else {
		const result = checkMemoryRateLimit(rateKey, resolvedConfig);
		allowed = result.allowed;
		retryAfter = result.retryAfterSec || 0;
	}

	if (!allowed) {
		return new Response(
			JSON.stringify({
				message: resolvedConfig.message || defaultConfig.message,
			}),
			{
				status: 429,
				headers: {
					"Content-Type": "application/json; charset=utf-8",
					"Retry-After": String(retryAfter || 1),
					"Cache-Control": "no-store",
				},
			},
		) as T;
	}

	return handler();
}
