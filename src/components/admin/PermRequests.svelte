<script lang="ts">
import { onMount } from "svelte";

// 后台「权限审批」：列出申请 → 通过/拒绝
// 数据源 GET /api/admin/perm-requests/?status=；动作 POST /api/admin/perm-review/

interface ReqView {
	id: string;
	user_id: string;
	perm: string;
	permLabel: string;
	status: string;
	note: string;
	requested_at: string;
	reviewed_at: string | null;
	reviewed_by: string | null;
	userName: string;
	userEmail: string;
}

let status = $state("pending");
let items = $state<ReqView[]>([]);
let loading = $state(true);
let error = $state("");
let busyId = $state("");
let toast = $state("");

async function load() {
	loading = true;
	error = "";
	try {
		const r = await fetch(
			`/api/admin/perm-requests/?status=${encodeURIComponent(status)}&pageSize=50`,
			{ credentials: "include", headers: { accept: "application/json" } },
		);
		const data = await r.json().catch(() => null);
		if (!r.ok) {
			error = data?.message || `加载失败（${r.status}）`;
			items = [];
			return;
		}
		items = data?.items ?? [];
	} catch (e) {
		error = "网络异常，请重试";
	} finally {
		loading = false;
	}
}

async function review(id: string, action: "approve" | "deny") {
	if (busyId) return;
	busyId = id;
	try {
		const r = await fetch("/api/admin/perm-review/", {
			method: "POST",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id, action }),
		});
		const data = await r.json().catch(() => null);
		if (!r.ok) {
			error = data?.message || "操作失败";
			return;
		}
		toast = action === "approve" ? "已通过，权限已授予" : "已拒绝";
		setTimeout(() => (toast = ""), 2400);
		await load();
	} finally {
		busyId = "";
	}
}

onMount(load);
</script>

<div class="card">
	<div class="head">
		<h2>权限审批</h2>
		<div class="tabs">
			{#each [["pending", "待审批"], ["approved", "已通过"], ["denied", "已拒绝"], ["all", "全部"]] as [v, label]}
				<button
					type="button"
					class="tab"
					class:on={status === v}
					onclick={() => { status = v; load(); }}>{label}</button>
			{/each}
		</div>
	</div>

	{#if toast}<p class="toast">{toast}</p>{/if}
	{#if error}<p class="err">{error}</p>{/if}
	{#if loading}
		<p class="muted">加载中…</p>
	{:else if items.length === 0}
		<p class="muted">暂无申请</p>
	{:else}
		<ul class="list">
			{#each items as it (it.id)}
				<li class="row">
					<div class="who">
						<strong>{it.userName || "（无昵称）"}</strong>
						<span class="mail">{it.userEmail}</span>
					</div>
					<div class="what">
						<span class="perm">{it.permLabel}</span>
						{#if it.note}<span class="note">理由：{it.note}</span>{/if}
						<span class="time">{it.requested_at}</span>
					</div>
					<div class="act">
						{#if it.status === "pending"}
							<button type="button" class="ok" disabled={busyId === it.id}
								onclick={() => review(it.id, "approve")}>通过</button>
							<button type="button" class="no" disabled={busyId === it.id}
								onclick={() => review(it.id, "deny")}>拒绝</button>
						{:else}
							<span class="done">{it.status === "approved" ? "已通过" : "已拒绝"}</span>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.card { background: var(--card-bg, #fff); border: 1px solid var(--line-divider, #e5e5e5); border-radius: 12px; padding: 20px; }
	.head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
	h2 { font-size: 18px; margin: 0; }
	.tabs { display: flex; gap: 6px; }
	.tab { padding: 6px 12px; border-radius: 8px; border: 1px solid var(--line-divider, #e5e5e5); background: transparent; cursor: pointer; font-size: 13px; }
	.tab.on { border-color: var(--primary, #f97316); color: var(--primary, #f97316); }
	.list { list-style: none; margin: 0; padding: 0; }
	.row { display: flex; align-items: center; gap: 14px; padding: 12px 0; border-top: 1px solid var(--line-divider, #eee); flex-wrap: wrap; }
	.who { min-width: 180px; display: flex; flex-direction: column; }
	.mail { font-size: 12px; color: #888; }
	.what { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 180px; }
	.perm { font-weight: 600; }
	.note { font-size: 12px; color: #666; }
	.time { font-size: 12px; color: #999; }
	.act { display: flex; gap: 8px; align-items: center; }
	.ok, .no { padding: 6px 14px; border-radius: 8px; border: 1px solid transparent; cursor: pointer; font-size: 13px; }
	.ok { background: var(--primary, #f97316); color: #fff; }
	.no { background: transparent; border-color: var(--line-divider, #ddd); }
	.done { font-size: 13px; color: #888; }
	.muted { color: #888; }
	.err { color: #dc2626; }
	.toast { color: #16a34a; }
</style>
