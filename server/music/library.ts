/**
 * 音乐库服务（自动嗅探架构，用户确认方案）
 *
 * 数据模型：
 * - R2 music/ 前缀 = 唯一事实来源（文件存在才有曲）；
 * - D1 music_groups / music_group_items = 显式分组归属（不存曲目元数据）；
 * - 未归属文件 → 动态组「单曲」（与旧 Halo s3-player rootPlaylistName 对齐）；
 * - 删文件 → 交集为空自动消失；新文件 → 未归属自动进「单曲」。
 *
 * 排序：组按 sort 升序、文件名字典序；曲名 = 去扩展名文件名。
 */
import { UserError } from "../utils/userError";

export interface MusicTrack {
	/** 文件名（含扩展名），桶内唯一键 */
	filename: string;
	/** 展示名（去扩展名） */
	name: string;
	artist: string;
	url: string;
}

export interface MusicGroupView {
	id: number | null;
	name: string;
	tracks: MusicTrack[];
}

const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|opus|flac|wav)$/i;
const DEFAULT_GROUP_NAME = "单曲";

function displayName(filename: string): string {
	return filename.replace(AUDIO_EXT, "");
}

export function mediaMusicUrl(origin: string, filename: string): string {
	const base =
		import.meta.env.PROD && import.meta.env.MEDIA_MUSIC_HOST
			? `https://${import.meta.env.MEDIA_MUSIC_HOST}`
			: origin;
	return `${base}/music/${filename
		.split("/")
		.map(encodeURIComponent)
		.join("/")}`;
}

/** 列桶（嗅探），返回音频文件名列表 */
export async function listBucketAudio(env: {
	BUCKET: R2Bucket;
}): Promise<string[]> {
	const out: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await env.BUCKET.list({ prefix: "music/", cursor });
		for (const obj of page.objects) {
			const name = obj.key.slice("music/".length);
			if (name && AUDIO_EXT.test(name)) out.push(name);
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return out.sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

interface GroupRow {
	id: number;
	name: string;
	sort: number;
}
interface ItemRow {
	group_id: number;
	filename: string;
}

/** 读分组归属（D1 故障时返回空归属，页面仍可用「单曲」兜底） */
async function loadGroups(env: { DB: D1Database }): Promise<{
	groups: GroupRow[];
	items: ItemRow[];
}> {
	try {
		const gRes = await env.DB.prepare(
			"SELECT id, name, sort FROM music_groups ORDER BY sort, id",
		).all<GroupRow>();
		const iRes = await env.DB.prepare(
			"SELECT group_id, filename FROM music_group_items",
		).all<ItemRow>();
		return { groups: gRes.results ?? [], items: iRes.results ?? [] };
	} catch (e) {
		console.warn("[music] 分组表读取失败，按无分组渲染", e);
		return { groups: [], items: [] };
	}
}

export interface PlaylistOptions {
	/** 站点 origin（构建 media 直链） */
	origin: string;
}

/** 组装渲染用分组播放列表（嗅探 ∩ 归属） */
export async function buildPlaylist(
	env: { BUCKET: R2Bucket; DB: D1Database },
	options: PlaylistOptions,
): Promise<MusicGroupView[]> {
	const files = await listBucketAudio(env);
	const fileSet = new Set(files);
	const { groups, items } = await loadGroups(env);

	const byGroup = new Map<number, string[]>();
	for (const it of items) {
		if (!fileSet.has(it.filename)) continue; // 文件已删 → 自动消失
		const list = byGroup.get(it.group_id) ?? [];
		list.push(it.filename);
		byGroup.set(it.group_id, list);
	}

	const views: MusicGroupView[] = [];
	const claimed = new Set<string>();
	for (const g of groups) {
		const tracks = (byGroup.get(g.id) ?? [])
			.sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))
			.map((filename) => ({
				filename,
				name: displayName(filename),
				artist: "",
				url: mediaMusicUrl(options.origin, filename),
			}));
		for (const t of tracks) claimed.add(t.filename);
		if (tracks.length > 0 || g.name === DEFAULT_GROUP_NAME) {
			views.push({ id: g.id, name: g.name, tracks });
		}
	}

	const loose = files
		.filter((f) => !claimed.has(f))
		.map((filename) => ({
			filename,
			name: displayName(filename),
			artist: "",
			url: mediaMusicUrl(options.origin, filename),
		}));
	if (loose.length > 0) {
		const existingDefault = views.find((v) => v.name === DEFAULT_GROUP_NAME);
		if (existingDefault) {
			existingDefault.tracks.push(...loose);
		} else {
			views.push({ id: null, name: DEFAULT_GROUP_NAME, tracks: loose });
		}
	}
	return views;
}

// ---------------- 管理端（分组 CRUD） ----------------

export async function listGroupsAdmin(env: {
	DB: D1Database;
}): Promise<Array<{ id: number; name: string; sort: number; filenames: string[] }>> {
	const { groups, items } = await loadGroups(env);
	return groups.map((g) => ({
		id: g.id,
		name: g.name,
		sort: g.sort,
		filenames: items
			.filter((i) => i.group_id === g.id)
			.map((i) => i.filename)
			.sort((a, b) => a.localeCompare(b, "zh-Hans-CN")),
	}));
}

export async function createGroup(
	env: { DB: D1Database },
	name: string,
): Promise<{ id: number }> {
	const trimmed = name.trim();
	if (!trimmed || trimmed.length > 50) throw new UserError("组名需为 1-50 字符");
	const res = await env.DB.prepare(
		"INSERT INTO music_groups (name, sort) SELECT ?, COALESCE(MAX(sort), 0) + 1 FROM music_groups",
	)
		.bind(trimmed)
		.run();
	return { id: Number(res.meta.last_row_id) };
}

export async function renameGroup(
	env: { DB: D1Database },
	id: number,
	name: string,
): Promise<void> {
	const trimmed = name.trim();
	if (!trimmed || trimmed.length > 50) throw new UserError("组名需为 1-50 字符");
	const res = await env.DB.prepare("UPDATE music_groups SET name = ? WHERE id = ?")
		.bind(trimmed, id)
		.run();
	if (!res.meta.changes) throw new UserError("分组不存在");
}

export async function deleteGroup(env: { DB: D1Database }, id: number): Promise<void> {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM music_group_items WHERE group_id = ?").bind(id),
		env.DB.prepare("DELETE FROM music_groups WHERE id = ?").bind(id),
	]);
}

/** 移动一首歌到某组（toGroupId = null → 移出所有组，回到动态「单曲」） */
export async function moveTrack(
	env: { DB: D1Database },
	filename: string,
	toGroupId: number | null,
): Promise<void> {
	if (!filename || filename.includes("/") || filename.includes("..")) {
		throw new UserError("非法文件名");
	}
	await env.DB.prepare("DELETE FROM music_group_items WHERE filename = ?")
		.bind(filename)
		.run();
	if (toGroupId !== null) {
		const g = await env.DB.prepare("SELECT id FROM music_groups WHERE id = ?")
			.bind(toGroupId)
			.first<{ id: number }>();
		if (!g) throw new UserError("目标分组不存在");
		await env.DB.prepare(
			"INSERT INTO music_group_items (group_id, filename) VALUES (?, ?)",
		)
			.bind(toGroupId, filename)
			.run();
	}
}

/** 批量移动（后台一次勾选多首） */
export async function moveTracks(
	env: { DB: D1Database },
	filenames: string[],
	toGroupId: number | null,
): Promise<void> {
	for (const f of filenames) {
		await moveTrack(env, f, toGroupId);
	}
}
