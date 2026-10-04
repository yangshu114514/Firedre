<script lang="ts">
import { onMount } from "svelte";
import { apiJson } from "@/lib/adminApi";

// 用户管理面板（设计 B.1/B.4）：成员列表 + 封禁/解封。
// 数据源 GET /api/auth/admin-users?page=&q=；动作 POST /api/auth/admin-users {id, action: ban|unban}
// 封禁即时生效：登录 403、getAuthUser 拒绝（无状态会话无法吊销 cookie，靠 banned 每请求校验）。

type UserItem = {
	id: string;
	email: string;
	name: string;
	avatar: string;
	email_verified: number;
	banned: number;
	created_at: string;
	oauth_count: number;
	comment_count: number;
};

type ListResult = {
	users?: UserItem[];
	total?: number;
	page?: number;
	pageSize?: number;
};

let items = $state<UserItem[]>([]);
let loading = $state(true);
let error = $state("");
let q = $state("");
let page = $state(1);
let pageSize = 20;
let total = $state(0);
let busyId = $state("");

const totalPages = $derived(Math.max(1, Math.ceil(total / pageSize)));

async function load(nextPage = page) {
	loading = true;
	error = "";
	try {
		const qs = q.trim()
			? `&q=${encodeURIComponent(q.trim())}`
			: "";
		const data = await apiJson<ListResult>(
			`/api/auth/admin-users?page=${nextPage}&pageSize=${pageSize}${qs}`,
		);
		items = data.users ?? [];
		total = data.total ?? 0;
		page = data.page ?? nextPage;
	} catch (e) {
		error = e instanceof Error ? e.message : "加载失败";
		items = [];
	}
	loading = false;
}

function search(e: SubmitEvent) {
	e.preventDefault();
	load(1);
}

async function act(id: string, action: "ban" | "unban") {
	if (busyId) return;
	if (action === "ban" && !confirm("确定封禁该用户？封禁后其将无法登录、评论、点赞。")) return;
	busyId = id;
	try {
		await apiJson("/api/auth/admin-users", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id, action }),
		});
		const target = items.find((u) => u.id === id);
		if (target) target.banned = action === "ban" ? 1 : 0;
	} catch (e) {
		alert(e instanceof Error ? e.message : "操作失败");
	}
	busyId = "";
}

function verifyChip(v: number): { cls: string; label: string } {
	return v === 1 ? { cls: "ok", label: "已验证" } : { cls: "off", label: "未验证" };
}

function bannedChip(b: number): { cls: string; label: string } {
	return b === 1 ? { cls: "lock", label: "已封禁" } : { cls: "ok", label: "正常" };
}

onMount(() => load(1));
</script>

<div class="crud-page">
	<div class="crud-head">
		<div>
			<h2>用户管理</h2>
			<p class="crud-sub">
				<span class="stat">共 <b>{total}</b> 名用户</span><span class="stat"
					>第 {page} / {totalPages} 页</span
				>
			</p>
		</div>
		<div class="crud-head-actions">
			<form onsubmit={search} class="user-search">
				<input
					type="search"
					placeholder="搜索邮箱或昵称"
					bind:value={q}
				/>
				<button class="btn btn-ghost" type="submit">搜索</button>
			</form>
			<button class="btn" onclick={() => load(page)}>刷新</button>
		</div>
	</div>

	<div class="crud-card" style="padding:.6rem 1.25rem">
		{#if loading}
			<div class="list-empty">加载中…</div>
		{:else if error}
			<div class="list-empty error">{error}</div>
		{:else if items.length === 0}
			<div class="list-empty">没有找到用户</div>
		{:else}
			{#each items as user (user.id)}
				<div class="list-row">
					<div class="list-main">
						<div class="list-title">
							{#if user.avatar}
								<img
									class="user-avatar"
									src={user.avatar}
									alt=""
									referrerpolicy="no-referrer"
								/>
							{:else}
								<span class="user-avatar user-avatar-empty"
									>{user.name?.slice(0, 1) || "?"}</span
								>
							{/if}
							<span>{user.name}</span>
							{#if user.email_verified === 1}
								<span class="u-chip ok">已验证</span>
							{:else}
								<span class="u-chip off">未验证</span>
							{/if}
							{#if user.banned === 1}
								<span class="u-chip lock">已封禁</span>
							{/if}
						</div>
						<div class="list-sub">
							<span class="mono">{user.email}</span>
							{#if user.oauth_count > 0}
								<span class="u-chip ok">OAuth×{user.oauth_count}</span>
							{/if}
							<span class="stat">评论 {user.comment_count}</span>
							<span>注册于 {user.created_at} UTC</span>
						</div>
					</div>
					<div class="list-actions">
						{#if user.banned === 1}
							<button
								class="btn btn-ghost"
								disabled={busyId === user.id}
								onclick={() => act(user.id, "unban")}
							>
								{busyId === user.id ? "处理中…" : "解封"}
							</button>
						{:else}
							<button
								class="btn btn-ghost danger"
								disabled={busyId === user.id}
								onclick={() => act(user.id, "ban")}
							>
								{busyId === user.id ? "处理中…" : "封禁"}
							</button>
						{/if}
					</div>
				</div>
			{/each}
		{/if}
	</div>

	{#if totalPages > 1}
		<div class="crud-foot">
			<button
				class="btn btn-ghost"
				disabled={page <= 1 || loading}
				onclick={() => load(page - 1)}
			>
				上一页
			</button>
			<span>{page} / {totalPages}</span>
			<button
				class="btn btn-ghost"
				disabled={page >= totalPages || loading}
				onclick={() => load(page + 1)}
			>
				下一页
			</button>
		</div>
	{/if}
</div>

<style>
	.user-search {
		display: flex;
		gap: 0.5rem;
	}
	.user-search input {
		background: var(--page-bg);
		color: var(--btn-content);
		border: 1px solid var(--btn-regular-bg);
		border-radius: 0.5rem;
		padding: 0.35rem 0.75rem;
		min-width: 14rem;
	}
	.user-avatar {
		width: 2rem;
		height: 2rem;
		border-radius: 9999px;
		object-fit: cover;
	}
	.user-avatar-empty {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: var(--btn-regular-bg);
		font-weight: 600;
	}
	.danger {
		color: #b91c1c;
	}
</style>
