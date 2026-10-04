<script lang="ts">
import { apiJson } from "@/lib/adminApi";
import { clearDraft, getDraft } from "@/lib/adminDrafts";
import { registerSaveAll } from "@/lib/adminSave";
import { onMountAsync } from "@/utils/svelte-mount";

// 「页面管理」面板：在线编辑 R2 里的独立路由页 Markdown（隐私政策 / 用户协议）
interface SpecPageItem {
	key: string;
	label: string;
	r2Key: string;
	path: string;
}

const PAGES: SpecPageItem[] = [
	{ key: "privacy", label: "隐私政策", r2Key: "spec/privacy.md", path: "/privacy/" },
	{ key: "terms", label: "用户协议", r2Key: "spec/terms.md", path: "/terms/" },
];

let active = $state(PAGES[0].key);
let contents = $state<Record<string, string>>({});
let loadedMap = $state<Record<string, boolean>>({});
let saving = $state(false);
let message = $state("");
let messageKind = $state<"ok" | "err">("ok");

const activeItem = $derived(
	PAGES.find((p) => p.key === active) ?? PAGES[0],
);

async function load(key: string) {
	if (loadedMap[key]) return;
	try {
		const data = await apiJson<{ source?: string }>(`/api/spec/${key}/`);
		contents = { ...contents, [key]: data.source ?? "" };
	} catch (err) {
		// 404（R2 尚无该对象）保持空白，保存后即创建；仅网络错误提示
		if (err instanceof TypeError) {
			message = "加载失败";
			messageKind = "err";
		}
		contents = { ...contents, [key]: contents[key] ?? "" };
	}
	loadedMap = { ...loadedMap, [key]: true };
}

function switchTo(key: string) {
	active = key;
	message = "";
	void load(key);
}

async function save(): Promise<boolean> {
	saving = true;
	message = "";
	const key = active;
	const content = contents[key] ?? "";
	if (!content.trim()) {
		message = "内容不能为空";
		messageKind = "err";
		saving = false;
		return false;
	}
	try {
		await apiJson(`/api/spec/${key}/`, {
			method: "PUT",
			headers: { "Content-Type": "text/markdown" },
			body: content,
		});
		message = "已保存";
		messageKind = "ok";
		clearDraft("页面管理");
		return true;
	} catch (err) {
		message = err instanceof Error ? err.message : "网络错误";
		messageKind = "err";
		return false;
	} finally {
		saving = false;
	}
}

// 顶栏「保存全部」：两份都已加载且非空时逐个写入，任一失败即整体记失败
async function saveAllPages(): Promise<boolean> {
	let ok = true;
	saving = true;
	message = "";
	try {
		for (const p of PAGES) {
			const content = contents[p.key] ?? "";
			// 空白页视为尚未填写，不阻塞另一份的保存
			if (!content.trim()) continue;
			try {
				await apiJson(`/api/spec/${p.key}/`, {
					method: "PUT",
					headers: { "Content-Type": "text/markdown" },
					body: content,
				});
			} catch (err) {
				ok = false;
				message = err instanceof Error ? err.message : "网络错误";
				messageKind = "err";
			}
		}
	} finally {
		saving = false;
	}
	if (ok) {
		message = "已保存";
		messageKind = "ok";
		clearDraft("页面管理");
	}
	return ok;
}

onMountAsync(async () => {
	await load(active);
	const d = getDraft<Record<string, string>>("页面管理");
	if (d) {
		contents = { ...contents, ...d };
		clearDraft("页面管理");
	}
	return registerSaveAll(
		"页面管理",
		saveAllPages,
		() => ({ ...contents }),
	);
});
</script>

<div class="crud-page">
	<div class="crud-head">
		<div>
			<h2>页面管理</h2>
			<p class="crud-sub">在线编辑独立路由页（Markdown，存 R2：spec/privacy.md、spec/terms.md）</p>
		</div>
		<div class="crud-head-actions">
			{#each PAGES as p (p.key)}
				<button
					type="button"
					class="btn {active === p.key ? 'btn-primary' : 'btn-ghost'}"
					onclick={() => switchTo(p.key)}
				>
					{p.label}
				</button>
			{/each}
			{#if message}
				<span class="crud-msg" class:err={messageKind === "err"}>{message}</span>
			{/if}
			<button class="btn btn-primary" onclick={save} disabled={saving}>
				{saving ? "保存中…" : "保存"}
			</button>
		</div>
	</div>

	{#if loadedMap[active]}
		<div class="crud-field">
			<span>{activeItem.label}（{activeItem.r2Key}） · 前台地址 <a href={activeItem.path} target="_blank" rel="noopener">{activeItem.path}</a></span>
			<textarea
				rows="24"
				aria-label={activeItem.label}
				bind:value={contents[active]}
			></textarea>
		</div>
	{:else}
		<div class="crud-empty">{message || "加载中…"}</div>
	{/if}
</div>
