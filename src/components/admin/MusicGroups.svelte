<script lang="ts">
import { onMount } from "svelte";
import { apiJson } from "@/lib/adminApi";

// 音乐分组管理（自动嗅探架构）：
// - 桶内 music/ 前缀文件 = 唯一事实来源（GET /api/music/playlist/ 实时嗅探）；
// - D1 归属 = 显式分组（GET/POST /api/admin/music-groups）；
// - 移动歌曲：POST /api/admin/music-move { filenames, toGroupId|null }；
//   toGroupId=null → 移出所有组（回到动态「单曲」兜底组）。
// 桶内已删除但仍在归属表的文件自动不显示（交集语义）。

type Track = { filename: string; name: string; url: string };
type PlaylistGroup = { id: number | null; name: string; tracks: Track[] };
type AdminGroup = { id: number; name: string; sort: number; filenames: string[] };

let adminGroups = $state<AdminGroup[]>([]);
let loose = $state<Track[]>([]);
let loading = $state(true);
let error = $state("");
let busy = $state(false);
let newGroupName = $state("");
let checked = $state<Set<string>>(new Set());
let checkedLoose = $state<Set<string>>(new Set());
let targetGroupId = $state<number | "loose">("loose");

const checkedCount = $derived(checked.size + checkedLoose.size);

async function load() {
	loading = true;
	error = "";
	try {
		const [admin, playlist] = await Promise.all([
			apiJson<{ groups: AdminGroup[] }>("/api/admin/music-groups/"),
			apiJson<{ groups: PlaylistGroup[] }>("/api/music/playlist/"),
		]);
		adminGroups = admin.groups ?? [];
		// 未归属文件 = 嗅探到的全部文件 − 各组归属文件
		const claimed = new Set<string>();
		for (const g of adminGroups) for (const f of g.filenames) claimed.add(f);
		loose = (playlist.groups ?? [])
			.flatMap((g) => g.tracks)
			.filter((t) => !claimed.has(t.filename));
		// 清理勾选中已消失的文件
		const allKnown = new Set((playlist.groups ?? []).flatMap((g) => g.tracks.map((t) => t.filename)));
		checked = new Set([...checked].filter((f) => allKnown.has(f)));
		checkedLoose = new Set([...checkedLoose].filter((f) => loose.some((t) => t.filename === f)));
	} catch (e) {
		error = e instanceof Error ? e.message : "加载失败";
	}
	loading = false;
}

async function createGroup() {
	if (!newGroupName.trim() || busy) return;
	busy = true;
	try {
		await apiJson("/api/admin/music-groups/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "create", name: newGroupName.trim() }),
		});
		newGroupName = "";
		await load();
	} catch (e) {
		alert(e instanceof Error ? e.message : "创建失败");
	}
	busy = false;
}

async function renameGroup(g: AdminGroup) {
	const name = prompt("新组名", g.name);
	if (!name || name.trim() === g.name) return;
	busy = true;
	try {
		await apiJson("/api/admin/music-groups/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "rename", id: g.id, name: name.trim() }),
		});
		await load();
	} catch (e) {
		alert(e instanceof Error ? e.message : "改名失败");
	}
	busy = false;
}

async function deleteGroup(g: AdminGroup) {
	if (!confirm(`删除分组「${g.name}」？组内歌曲会回到「单曲」兜底组（文件不受影响）。`)) return;
	busy = true;
	try {
		await apiJson("/api/admin/music-groups/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "delete", id: g.id }),
		});
		await load();
	} catch (e) {
		alert(e instanceof Error ? e.message : "删除失败");
	}
	busy = false;
}

function toggle(set: Set<string>, filename: string) {
	const next = new Set(set);
	if (next.has(filename)) next.delete(filename);
	else next.add(filename);
	return next;
}

async function moveSelected() {
	if (checkedCount === 0 || busy) return;
	const filenames = [...checked, ...checkedLoose];
	const to = targetGroupId === "loose" ? null : Number(targetGroupId);
	const toName =
		targetGroupId === "loose" ? "单曲（兜底组）" : adminGroups.find((g) => g.id === to)?.name ?? "?";
	if (!confirm(`把 ${filenames.length} 首移动到「${toName}」？`)) return;
	busy = true;
	try {
		await apiJson("/api/admin/music-move/", {
			method: "POST",
			headers: { "Content-Type" : "application/json" },
			body: JSON.stringify({ filenames, toGroupId: to }),
		});
		checked = new Set();
		checkedLoose = new Set();
		await load();
	} catch (e) {
		alert(e instanceof Error ? e.message : "移动失败");
	}
	busy = false;
}

onMount(() => load());
</script>

<div class="crud-page">
	<div class="crud-head">
		<div>
			<h2>音乐分组</h2>
			<p class="crud-sub">
				<span class="stat">桶内文件实时嗅探</span>
				<span class="stat">删除文件自动下架，新文件自动进「单曲」</span>
			</p>
		</div>
		<div class="crud-head-actions">
			<button class="btn" onclick={() => load()} disabled={loading}>刷新</button>
		</div>
	</div>

	{#if loading}
		<div class="crud-card"><div class="list-empty">加载中…</div></div>
	{:else if error}
		<div class="crud-card"><div class="list-empty error">{error}</div></div>
	{:else}
		<div class="mg-grid">
			<div class="crud-card mg-col">
				<h3 class="mg-title">分组（{adminGroups.length}）</h3>
				<form class="mg-new" onsubmit={(e) => { e.preventDefault(); createGroup(); }}>
					<input placeholder="新分组名" bind:value={newGroupName} maxlength="50" />
					<button class="btn" type="submit" disabled={busy || !newGroupName.trim()}>添加</button>
				</form>
				{#each adminGroups as g (g.id)}
					<div class="mg-group">
						<div class="mg-group-head">
							<b>{g.name}</b>
							<span class="stat">{g.filenames.length} 首</span>
							<span class="mg-group-actions">
								<button class="btn btn-ghost" onclick={() => renameGroup(g)} disabled={busy}>改名</button>
								<button class="btn btn-ghost danger" onclick={() => deleteGroup(g)} disabled={busy}>删除</button>
							</span>
						</div>
						{#if g.filenames.length > 0}
							<div class="mg-files">
								{#each g.filenames as f (f)}
									<label class="mg-file">
										<input
											type="checkbox"
											checked={checked.has(f)}
											onchange={() => (checked = toggle(checked, f))}
										/>
										<span>{f}</span>
									</label>
								{/each}
							</div>
						{/if}
					</div>
				{/each}
			</div>

			<div class="crud-card mg-col">
				<h3 class="mg-title">未分组（自动「单曲」兜底）— {loose.length} 首</h3>
				{#if loose.length === 0}
					<div class="list-empty">没有未分组文件</div>
				{:else}
					<div class="mg-files">
						{#each loose as t (t.filename)}
							<label class="mg-file">
								<input
									type="checkbox"
									checked={checkedLoose.has(t.filename)}
									onchange={() => (checkedLoose = toggle(checkedLoose, t.filename))}
								/>
								<span>{t.name}</span>
								<span class="stat mono">{t.filename}</span>
							</label>
						{/each}
					</div>
				{/if}
			</div>
		</div>

		<div class="crud-card mg-bar">
			<span>已选 <b>{checkedCount}</b> 首</span>
			<select bind:value={targetGroupId}>
				<option value="loose">移出所有组（进「单曲」）</option>
				{#each adminGroups as g (g.id)}
					<option value={g.id}>移到「{g.name}」</option>
				{/each}
			</select>
			<button class="btn" onclick={moveSelected} disabled={busy || checkedCount === 0}>
				{busy ? "处理中…" : "移动所选"}
			</button>
		</div>
	{/if}
</div>

<style>
	.mg-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1rem;
		align-items: start;
	}
	@media (max-width: 900px) {
		.mg-grid {
			grid-template-columns: 1fr;
		}
	}
	.mg-title {
		margin: 0 0 0.75rem;
		font-size: 1rem;
	}
	.mg-new {
		display: flex;
		gap: 0.5rem;
		margin-bottom: 0.75rem;
	}
	.mg-new input {
		flex: 1;
		background: var(--page-bg);
		color: var(--btn-content);
		border: 1px solid var(--btn-regular-bg);
		border-radius: 0.5rem;
		padding: 0.35rem 0.75rem;
	}
	.mg-group {
		border: 1px solid var(--btn-regular-bg);
		border-radius: 0.75rem;
		padding: 0.6rem 0.8rem;
		margin-bottom: 0.6rem;
	}
	.mg-group-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.35rem;
	}
	.mg-group-actions {
		margin-left: auto;
		display: flex;
		gap: 0.25rem;
	}
	.mg-files {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		max-height: 16rem;
		overflow-y: auto;
	}
	.mg-file {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.2rem 0.3rem;
		border-radius: 0.4rem;
		cursor: pointer;
	}
	.mg-file:hover {
		background: var(--btn-regular-bg);
	}
	.mg-file .stat {
		margin-left: auto;
		font-size: 0.75rem;
		opacity: 0.6;
	}
	.mg-bar {
		margin-top: 1rem;
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}
	.mg-bar select {
		background: var(--page-bg);
		color: var(--btn-content);
		border: 1px solid var(--btn-regular-bg);
		border-radius: 0.5rem;
		padding: 0.35rem 0.75rem;
	}
	.danger {
		color: #b91c1c;
	}
</style>
