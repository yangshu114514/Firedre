<script lang="ts">
import { onMount } from "svelte";
import { apiJson } from "@/lib/adminApi";

// 评论审核面板（设计 B.4）：待审列表 + 通过/垃圾/删除。
// 数据源 GET /api/comments/admin?status=&page=；动作 POST /api/comments/moderate
// 注意：接线前此组件不会出现在 AdminApp 的 VIEWS 表中，仅作为待接线件落盘。

type CommentItem = {
	id: string;
	target: string;
	parent_id: string | null;
	user_id: string | null;
	guest_name: string;
	guest_email: string;
	content: string;
	status: string;
	ip: string;
	created_at: string;
	authorName: string;
	avatar: string;
	isMember: boolean;
};

type ListResult = {
	items?: CommentItem[];
	total?: number;
	page?: number;
	pageSize?: number;
};

const STATUS_TABS: { value: string; label: string }[] = [
	{ value: "pending", label: "待审核" },
	{ value: "approved", label: "已通过" },
	{ value: "spam", label: "垃圾" },
	{ value: "deleted", label: "已删除" },
];

let items = $state<CommentItem[]>([]);
let loading = $state(true);
let error = $state("");
let status = $state("pending");
let page = $state(1);
let pageSize = 20;
let total = $state(0);
let busyId = $state("");

const totalPages = $derived(Math.max(1, Math.ceil(total / pageSize)));

async function load(nextPage = page) {
	loading = true;
	error = "";
	try {
		const data = await apiJson<ListResult>(
			`/api/comments/admin?status=${encodeURIComponent(status)}&page=${nextPage}&pageSize=${pageSize}`,
		);
		items = data.items ?? [];
		total = data.total ?? 0;
		page = data.page ?? nextPage;
	} catch (e) {
		error = e instanceof Error ? e.message : "加载失败";
		items = [];
	}
	loading = false;
}

function switchStatus(next: string) {
	if (status === next) return;
	status = next;
	load(1);
}

async function act(id: string, action: "approve" | "spam" | "delete") {
	if (busyId) return;
	busyId = id;
	try {
		await apiJson("/api/comments/moderate", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id, action }),
		});
		// 动作会改变状态归属，成功后从当前列表移除（跨状态筛选需手动切换查看）
		items = items.filter((c) => c.id !== id);
		total = Math.max(0, total - 1);
	} catch (e) {
		alert(e instanceof Error ? e.message : "操作失败");
	}
	busyId = "";
}

function statusChip(s: string): { cls: string; label: string } {
	switch (s) {
		case "pending":
			return { cls: "off", label: "待审核" };
		case "approved":
			return { cls: "ok", label: "已通过" };
		case "spam":
			return { cls: "lock", label: "垃圾" };
		case "deleted":
			return { cls: "off", label: "已删除" };
		default:
			return { cls: "off", label: s };
	}
}

onMount(() => load(1));
</script>

<div class="crud-page">
	<div class="crud-head">
		<div>
			<h2>评论审核</h2>
			<p class="crud-sub">
				<span class="stat">当前 <b>{total}</b> 条</span><span class="stat"
					>第 {page} / {totalPages} 页</span
				>
			</p>
		</div>
		<div class="crud-head-actions">
			{#each STATUS_TABS as tab (tab.value)}
				<button
					class="btn btn-ghost"
					class:btn-primary={status === tab.value}
					onclick={() => switchStatus(tab.value)}
				>
					{tab.label}
				</button>
			{/each}
			<button class="btn" onclick={() => load(page)}>刷新</button>
		</div>
	</div>

	<div class="crud-card" style="padding:.6rem 1.25rem">
		{#if loading}
			<div class="list-empty">加载中…</div>
		{:else if error}
			<div class="list-empty error">{error}</div>
		{:else if items.length === 0}
			<div class="list-empty">暂无{STATUS_TABS.find((t) => t.value === status)?.label ?? ""}评论</div>
		{:else}
			{#each items as comment (comment.id)}
				<div class="list-row comment-row">
					<div class="list-main">
						<div class="list-title comment-content">{comment.content}</div>
						<div class="list-sub">
							<span class="mono">{comment.authorName}</span>
							{#if comment.isMember}
								<span class="u-chip ok">成员</span>
							{:else}
								<span class="u-chip off">匿名</span>
							{/if}
							{#if comment.guest_email}
								<span class="mono">{comment.guest_email}</span>
							{/if}
							<span class="mono">IP {comment.ip || "-"}</span>
							<span class="mono">{comment.target}</span>
							<span>{comment.created_at} UTC</span>
							{#if comment.parent_id}
								<span class="u-chip off">回复</span>
							{/if}
						</div>
					</div>
					<span class="u-chip {statusChip(comment.status).cls}">
						{statusChip(comment.status).label}
					</span>
					<div class="comment-actions">
						{#if comment.status !== "approved"}
							<button
								class="btn btn-primary"
								disabled={busyId === comment.id}
								onclick={() => act(comment.id, "approve")}
							>
								通过
							</button>
						{/if}
						{#if comment.status !== "spam"}
							<button
								class="btn"
								disabled={busyId === comment.id}
								onclick={() => act(comment.id, "spam")}
							>
								垃圾
							</button>
						{/if}
						<button
							class="btn btn-danger-text"
							disabled={busyId === comment.id}
							onclick={() => act(comment.id, "delete")}
						>
							删除
						</button>
					</div>
				</div>
			{/each}

			{#if totalPages > 1}
				<div class="comment-pager">
					<button
						class="btn"
						disabled={page <= 1}
						onclick={() => load(page - 1)}
					>
						上一页
					</button>
					<span>{page} / {totalPages}</span>
					<button
						class="btn"
						disabled={page >= totalPages}
						onclick={() => load(page + 1)}
					>
						下一页
					</button>
				</div>
			{/if}
		{/if}
	</div>
</div>

<style>
	.comment-row {
		align-items: flex-start;
	}
	.comment-content {
		white-space: pre-wrap;
		word-break: break-word;
		max-width: 46rem;
	}
	.comment-actions {
		display: flex;
		gap: 0.5rem;
		flex-shrink: 0;
	}
	.comment-pager {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 1rem;
		padding: 1rem 0 0.5rem;
		color: var(--text-muted);
	}
</style>
