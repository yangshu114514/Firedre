// 文章点赞服务（设计 DESIGN-USER-SYSTEM.md B.3）
// 表：post_likes(post_slug, user_id) 复合主键 → 一人一文一赞，再点即取消（toggle 幂等）
// post_slug 不设 FK（与 comments.target 同理），这里在写入前校验目标文章真实存在，避免脏数据

import { UserError } from "../utils/userError";

export interface LikeState {
	count: number;
	liked: boolean;
}

/** 目标必须是已发布文章，否则拒绝计数/写入 */
async function assertPostExists(db: D1Database, slug: string): Promise<string> {
	const s = String(slug || "").trim();
	if (!s) throw new UserError("文章标识不能为空");
	if (s.length > 200) throw new UserError("文章标识不合法");

	const row = await db
		.prepare("SELECT slug FROM posts WHERE slug = ? AND published = 1")
		.bind(s)
		.first<{ slug: string }>();
	if (!row) throw new UserError("文章不存在");
	return row.slug;
}

async function countFor(db: D1Database, slug: string): Promise<number> {
	const row = await db
		.prepare(
			"SELECT COUNT(*) AS n FROM post_likes WHERE post_slug = ?",
		)
		.bind(slug)
		.first<{ n: number }>();
	return Number(row?.n ?? 0);
}

/** 读计数 + 当前用户是否已赞（匿名 liked 恒 false） */
export async function getLikeState(
	db: D1Database,
	slug: string,
	userId: string | null,
): Promise<LikeState> {
	const target = await assertPostExists(db, slug);
	const count = await countFor(db, target);
	if (!userId) return { count, liked: false };

	const row = await db
		.prepare(
			"SELECT 1 AS x FROM post_likes WHERE post_slug = ? AND user_id = ?",
		)
		.bind(target, userId)
		.first<{ x: number }>();
	return { count, liked: Boolean(row) };
}

/**
 * 切换点赞：已赞 → 取消；未赞 → 新增。
 * 幂等：靠 DELETE 的 changes 判定本次是「取消」还是「新增」，
 * 并发下 INSERT ON CONFLICT DO NOTHING 保证同一 (slug,user) 只有一行。
 */
export async function toggleLike(
	db: D1Database,
	slug: string,
	userId: string,
): Promise<LikeState> {
	if (!userId) throw new UserError("请先登录");
	const target = await assertPostExists(db, slug);

	const removed = await db
		.prepare("DELETE FROM post_likes WHERE post_slug = ? AND user_id = ?")
		.bind(target, userId)
		.run();

	if (Number(removed.meta?.changes ?? 0) > 0) {
		return { count: await countFor(db, target), liked: false };
	}

	await db
		.prepare(
			`INSERT INTO post_likes (post_slug, user_id, created_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(post_slug, user_id) DO NOTHING`,
		)
		.bind(target, userId)
		.run();

	return { count: await countFor(db, target), liked: true };
}
