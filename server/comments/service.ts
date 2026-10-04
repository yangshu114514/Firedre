// 原生评论服务（设计 DESIGN-USER-SYSTEM.md B.3/B.4/D.3）
// 表结构见 migrations/0002_user_system.sql：comments（target 不设 FK，可为文章 slug / 'guestbook' 等伪目标）
// 本层只做数据与业务校验；限流（withRateLimit）、Origin 校验、管理员鉴权在 API 层完成

import { UserError } from "../utils/userError";

export type CommentStatus = "pending" | "approved" | "spam" | "deleted";

/** 分页默认值（页内分页，前台每页 10 条顶层评论） */
export const COMMENT_PAGE_SIZE = 10;
export const COMMENT_MAX_PAGE_SIZE = 50;
export const COMMENT_CONTENT_MAX = 2000;
export const COMMENT_TARGET_MAX = 200;
export const COMMENT_NAME_MAX = 30;
export const COMMENT_EMAIL_MAX = 100;

/** 前台可见评论（密码/邮箱/IP 永不出栈） */
export interface PublicComment {
	id: string;
	parentId: string | null;
	content: string;
	authorName: string;
	avatar: string;
	isMember: boolean;
	createdAt: string;
	status: "approved" | "pending";
	replies: PublicComment[];
}

export interface CommentListResult {
	items: PublicComment[];
	total: number;
	page: number;
	pageSize: number;
}

interface CommentRow {
	id: string;
	parent_id: string | null;
	user_id: string | null;
	guest_name: string;
	content: string;
	status: string;
	created_at: string;
	author_name: string | null;
	author_avatar: string | null;
}

/** 后台列表用（多带 email/ip/status 过滤） */
export interface AdminCommentRow extends CommentRow {
	guest_email: string;
	ip: string;
	target: string;
}

const SELECT_COLUMNS = `
  c.id, c.parent_id, c.user_id, c.guest_name, c.content, c.status, c.created_at,
  u.name AS author_name, u.avatar AS author_avatar
`;

function toPublic(row: CommentRow): PublicComment {
	const isMember = Boolean(row.user_id);
	return {
		id: row.id,
		parentId: row.parent_id,
		content: row.content,
		authorName: isMember
			? row.author_name || row.guest_name || "用户"
			: row.guest_name || "匿名访客",
		avatar: isMember ? row.author_avatar || "" : "",
		isMember,
		createdAt: row.created_at,
		status: row.status === "pending" ? "pending" : "approved",
		replies: [],
	};
}

/**
 * 可见性条件：
 * - 无登录观众：只看 approved
 * - 有登录观众：approved + 自己的 pending（D.3「自己的 pending 仅作者可见」）
 */
function visibleClause(viewerId: string | null): string {
	return viewerId
		? "(c.status = 'approved' OR (c.status = 'pending' AND c.user_id = ?))"
		: "c.status = 'approved'";
}

function visibleBinds(viewerId: string | null): unknown[] {
	return viewerId ? [viewerId] : [];
}

function normalizeTarget(raw: string): string {
	const target = String(raw || "").trim();
	if (!target) throw new UserError("评论目标不能为空");
	if (target.length > COMMENT_TARGET_MAX)
		throw new UserError("评论目标不合法");
	// 目标作为伪主键使用，拒绝控制字符（D1 参数化已防注入，这里防展示层脏数据）
	// biome-ignore lint/suspicious/noControlCharactersInRegex: 目标字段需排除控制字符
	if (/[\u0000-\u001f\u007f]/.test(target)) throw new UserError("评论目标不合法");
	return target;
}

function clampPage(page: unknown, pageSize: unknown) {
	const p = Math.max(1, Math.floor(Number(page) || 1));
	const rawSize = Math.floor(Number(pageSize) || COMMENT_PAGE_SIZE);
	const s = Math.min(COMMENT_MAX_PAGE_SIZE, Math.max(1, rawSize));
	return { page: p, pageSize: s };
}

/** 单页评论：顶层（parent_id IS NULL）按时间倒序分页，各自挂载一级回复（时间正序） */
export async function listComments(
	db: D1Database,
	opts: {
		target: string;
		page?: number;
		pageSize?: number;
		viewerId?: string | null;
	},
): Promise<CommentListResult> {
	const target = normalizeTarget(opts.target);
	const { page, pageSize } = clampPage(opts.page, opts.pageSize);
	const viewerId = opts.viewerId ?? null;

	const totalRow = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM comments c
       WHERE c.target = ? AND c.parent_id IS NULL AND ${visibleClause(viewerId)}`,
		)
		.bind(target, ...visibleBinds(viewerId))
		.first<{ n: number }>();
	const total = Number(totalRow?.n ?? 0);

	const offset = (page - 1) * pageSize;
	const topRows = await db
		.prepare(
			`SELECT ${SELECT_COLUMNS} FROM comments c
       LEFT JOIN users u ON u.id = c.user_id
       WHERE c.target = ? AND c.parent_id IS NULL AND ${visibleClause(viewerId)}
       ORDER BY c.created_at DESC, c.id DESC
       LIMIT ? OFFSET ?`,
		)
		.bind(target, ...visibleBinds(viewerId), pageSize, offset)
		.all<CommentRow>();

	const tops = (topRows.results ?? []).map(toPublic);
	if (!tops.length) return { items: [], total, page, pageSize };

	// 一级回复：一次取回该页所有顶层的回复，再按 parent_id 归位
	const ids = tops.map((t) => t.id);
	const placeholders = ids.map(() => "?").join(",");
	const replyRows = await db
		.prepare(
			`SELECT ${SELECT_COLUMNS} FROM comments c
       LEFT JOIN users u ON u.id = c.user_id
       WHERE c.parent_id IN (${placeholders}) AND ${visibleClause(viewerId)}
       ORDER BY c.created_at ASC, c.id ASC`,
		)
		.bind(...ids, ...visibleBinds(viewerId))
		.all<CommentRow>();

	const byParent = new Map<string, PublicComment[]>();
	for (const row of replyRows.results ?? []) {
		if (!row.parent_id) continue;
		const list = byParent.get(row.parent_id) ?? [];
		list.push(toPublic(row));
		byParent.set(row.parent_id, list);
	}
	for (const top of tops) top.replies = byParent.get(top.id) ?? [];

	return { items: tops, total, page, pageSize };
}

export interface SubmitCommentInput {
	target: string;
	content: string;
	guestName?: string;
	guestEmail?: string;
	parentId?: string | null;
	ip?: string;
}

export interface SubmitCommentResult {
	comment: PublicComment;
	/** approved=登录直发可见；pending=匿名待审 */
	status: "approved" | "pending";
}

/**
 * 提交评论（D.3/B.4）：
 * - viewer 非空（已通过 email_verified 校验的登录用户）→ status=approved 直发
 * - viewer 为空 → 匿名，guest_name 必填 → status=pending，前台提示「评论已提交，审核后展示」
 * 限流与 Origin 校验在 API 层完成。
 */
export async function submitComment(
	db: D1Database,
	input: SubmitCommentInput,
	viewer: { id: string; name: string; avatar: string } | null,
): Promise<SubmitCommentResult> {
	const target = normalizeTarget(input.target);

	const content = String(input.content || "").trim();
	if (!content) throw new UserError("评论内容不能为空");
	if (content.length > COMMENT_CONTENT_MAX)
		throw new UserError(`评论最多 ${COMMENT_CONTENT_MAX} 个字符`);

	let guestName = "";
	let guestEmail = "";
	if (!viewer) {
		guestName = String(input.guestName || "").trim();
		if (!guestName) throw new UserError("请填写昵称");
		if (guestName.length > COMMENT_NAME_MAX)
			throw new UserError(`昵称最多 ${COMMENT_NAME_MAX} 个字符`);

		guestEmail = String(input.guestEmail || "").trim();
		if (guestEmail) {
			if (guestEmail.length > COMMENT_EMAIL_MAX)
				throw new UserError("邮箱格式不正确");
			if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestEmail))
				throw new UserError("邮箱格式不正确");
		}
	}

	// 一级回复：父评论必须存在、同 target、approved，且其本身是一级评论（只允许一级回复）
	let parentId: string | null = null;
	const rawParent = String(input.parentId || "").trim();
	if (rawParent) {
		const parent = await db
			.prepare(
				"SELECT id, target, parent_id, status FROM comments WHERE id = ?",
			)
			.bind(rawParent)
			.first<{
				id: string;
				target: string;
				parent_id: string | null;
				status: string;
			}>();
		if (!parent) throw new UserError("回复的评论不存在");
		if (parent.target !== target) throw new UserError("回复目标不匹配");
		if (parent.parent_id) throw new UserError("仅支持一级回复");
		if (parent.status !== "approved")
			throw new UserError("回复的评论不存在");
		parentId = parent.id;
	}

	const id = crypto.randomUUID();
	const status: CommentStatus = viewer ? "approved" : "pending";

	await db
		.prepare(
			`INSERT INTO comments (id, target, parent_id, user_id, guest_name, guest_email, content, status, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
		)
		.bind(
			id,
			target,
			parentId,
			viewer?.id ?? null,
			guestName,
			guestEmail,
			content,
			status,
			String(input.ip || ""),
		)
		.run();

	const comment: PublicComment = {
		id,
		parentId,
		content,
		authorName: viewer ? viewer.name : guestName || "匿名访客",
		avatar: viewer ? viewer.avatar || "" : "",
		isMember: Boolean(viewer),
		createdAt: new Date().toISOString().replace("T", " ").slice(0, 19),
		status: viewer ? "approved" : "pending",
		replies: [],
	};

	return { comment, status: viewer ? "approved" : "pending" };
}

export type ModerateAction = "approve" | "spam" | "delete";

const MODERATE_STATUS: Record<ModerateAction, CommentStatus> = {
	approve: "approved",
	spam: "spam",
	delete: "deleted",
};

/** 后台审核动作（B.4）：通过 / 垃圾 / 删除（软删，保留行以便追溯） */
export async function moderateComment(
	db: D1Database,
	id: string,
	action: ModerateAction,
): Promise<{ ok: true }> {
	const status = MODERATE_STATUS[action];
	if (!status) throw new UserError("未知的审核动作");

	const info = await db
		.prepare("UPDATE comments SET status = ? WHERE id = ?")
		.bind(status, id)
		.run();
	if (Number(info.meta?.changes ?? 0) <= 0)
		throw new UserError("评论不存在");

	return { ok: true };
}

/** 后台列表：按状态过滤（默认 pending），含邮箱/IP/target 供审核判断 */
export async function listCommentsForAdmin(
	db: D1Database,
	opts: { status?: string; page?: number; pageSize?: number },
): Promise<{
	items: Array<
		AdminCommentRow & { authorName: string; avatar: string; isMember: boolean }
	>;
	total: number;
	page: number;
	pageSize: number;
}> {
	const status = String(opts.status || "pending");
	if (!["pending", "approved", "spam", "deleted"].includes(status))
		throw new UserError("状态不合法");
	const { page, pageSize } = clampPage(opts.page, opts.pageSize);

	const totalRow = await db
		.prepare("SELECT COUNT(*) AS n FROM comments WHERE status = ?")
		.bind(status)
		.first<{ n: number }>();
	const total = Number(totalRow?.n ?? 0);

	const offset = (page - 1) * pageSize;
	const rows = await db
		.prepare(
			`SELECT c.id, c.target, c.parent_id, c.user_id, c.guest_name, c.guest_email,
              c.content, c.status, c.ip, c.created_at,
              u.name AS author_name, u.avatar AS author_avatar
       FROM comments c
       LEFT JOIN users u ON u.id = c.user_id
       WHERE c.status = ?
       ORDER BY c.created_at DESC, c.id DESC
       LIMIT ? OFFSET ?`,
		)
		.bind(status, pageSize, offset)
		.all<
			AdminCommentRow & { author_name: string | null; author_avatar: string | null }
		>();

	const items = (rows.results ?? []).map((row) => ({
		...row,
		authorName: row.user_id
			? row.author_name || row.guest_name || "用户"
			: row.guest_name || "匿名访客",
		avatar: row.user_id ? row.author_avatar || "" : "",
		isMember: Boolean(row.user_id),
	}));

	return { items, total, page, pageSize };
}
