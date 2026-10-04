import type { CloudflareEnv } from "../../types/env";
import type { PostFrontmatter } from "../../types/posts";
import { splitMarkdown } from "../posts/frontmatter";
import { renderMarkdown } from "../posts/render";
import { bumpContentVersion } from "../settings/service";

const SPEC_R2_PREFIX = "spec/";

export function isValidSpecName(name: string): boolean {
	return /^[a-zA-Z0-9._-]+$/.test(name);
}

/** 后台可在线编辑的 spec 页面白名单：仅隐私政策/用户协议（避免开放任意 spec 覆写） */
export const EDITABLE_SPEC_PAGES = ["privacy", "terms"] as const;

export function isEditableSpecName(name: string): boolean {
	return (EDITABLE_SPEC_PAGES as readonly string[]).includes(name);
}

export interface SpecPageDetail {
	name: string;
	frontmatter: PostFrontmatter;
	html: string;
	source: string;
}

/** 读取并渲染 R2 `spec/<name>.md`（通用 Markdown 页面，如留言板） */
export async function getSpecPage(
	env: CloudflareEnv,
	name: string,
): Promise<SpecPageDetail | null> {
	if (!isValidSpecName(name)) return null;

	const object = await env.BUCKET.get(`${SPEC_R2_PREFIX}${name}.md`);
	if (!object) return null;

	const source = await object.text();
	const { frontmatter, content } = splitMarkdown(source);
	// renderMarkdown 的插件会就地写入 words/minutes/excerpt，故返回渲染后的同一对象
	const rendered = await renderMarkdown(content, { frontmatter });
	return { name, frontmatter, html: rendered.html, source };
}

/** 覆写 R2 `spec/<name>.md`（仅白名单页面），成功后 bump 内容版本使前台 HTML 缓存失效 */
export async function upsertSpecPage(
	env: CloudflareEnv,
	name: string,
	source: string,
): Promise<SpecPageDetail | null> {
	if (!isValidSpecName(name) || !isEditableSpecName(name)) return null;

	await env.BUCKET.put(`${SPEC_R2_PREFIX}${name}.md`, source, {
		httpMetadata: { contentType: "text/markdown; charset=utf-8" },
	});
	await bumpContentVersion(env);

	return getSpecPage(env, name);
}
