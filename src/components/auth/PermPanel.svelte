<script lang="ts">
import { onMount } from "svelte";

// 个人资料页的「我的权限」面板：查看权限 / 提交申请 / 查看审批状态
// 数据源 GET /api/perms/me/；申请 POST /api/perms/request/

interface PermSpec {
	id: string;
	label: string;
	desc: string;
}
interface ReqRow {
	id: string;
	perm: string;
	status: string;
	note: string;
	requested_at: string;
	reviewed_at: string | null;
}

let authenticated = $state(false);
let isAdmin = $state(false);
let perms = $state<string[]>([]);
let requests = $state<ReqRow[]>([]);
let catalog = $state<PermSpec[]>([]);
let loading = $state(true);
let msg = $state("");
let err = $state("");
let busy = $state("");

async function load() {
	loading = true;
	try {
		const r = await fetch("/api/perms/me/", {
			credentials: "include",
			headers: { accept: "application/json" },
		});
		const d = await r.json().catch(() => null);
		if (d) {
			authenticated = !!d.authenticated;
			isAdmin = !!d.isAdmin;
			perms = d.perms ?? [];
			requests = d.requests ?? [];
			catalog = d.catalog ?? [];
		}
	} catch {
		err = "加载失败";
	} finally {
		loading = false;
	}
}

function statusOf(permId: string): string {
	const r = requests.find((x) => x.perm === permId && x.status === "pending");
	if (r) return "待审批";
	const last = requests.find((x) => x.perm === permId);
	if (last) return last.status === "approved" ? "已通过" : "已拒绝";
	return "";
}

async function apply(permId: string) {
	if (busy) return;
	busy = permId;
	msg = "";
	err = "";
	try {
		const r = await fetch("/api/perms/request/", {
			method: "POST",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ perm: permId, note: "" }),
		});
		const d = await r.json().catch(() => null);
		if (!r.ok) {
			err = d?.message || "申请失败";
			return;
		}
		msg = "申请已提交，等待管理员审批";
		await load();
	} catch {
		err = "网络异常，请重试";
	} finally {
		busy = "";
	}
}

onMount(load);
</script>

<div class="card-base p-5 mt-5">
	<div class="flex items-center gap-3 mb-3">
		<div class="w-1 h-5 bg-(--primary) rounded-full"></div>
		<h3 class="text-lg font-bold">我的权限</h3>
	</div>

	{#if loading}
		<p class="text-sm text-50">加载中…</p>
	{:else if !authenticated}
		<p class="text-sm text-50">登录后可查看与申请权限</p>
	{:else if isAdmin}
		<p class="text-sm">你是管理员，拥有全部权限。</p>
	{:else}
		<p class="text-sm text-50 mb-3">
			普通用户默认没有后台权限。如需在站内发布文章，可申请「发布文章」权限，管理员审批通过后即可进入后台发文。
		</p>
		<ul class="space-y-3">
			{#each catalog as spec (spec.id)}
				{@const owned = perms.includes(spec.id)}
				{@const st = statusOf(spec.id)}
				<li class="flex items-start justify-between gap-4 rounded-xl border border-(--line-divider) p-3">
					<div>
						<div class="font-medium">{spec.label}</div>
						<div class="text-xs text-50">{spec.desc}</div>
						{#if st}<div class="text-xs mt-1 {st === '已拒绝' ? 'text-red-500' : 'text-(--primary)'}">{st}</div>{/if}
					</div>
					{#if owned}
						<span class="text-xs text-(--primary) whitespace-nowrap">已拥有</span>
					{:else if st === "待审批"}
						<span class="text-xs text-50 whitespace-nowrap">等待审批</span>
					{:else}
						<button
							type="button"
							class="btn-regular rounded-lg px-3 py-1.5 text-sm whitespace-nowrap"
							disabled={busy === spec.id}
							onclick={() => apply(spec.id)}>申请</button>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}

	{#if msg}<p class="text-sm text-green-600 mt-3">{msg}</p>{/if}
	{#if err}<p class="text-sm text-red-500 mt-3">{err}</p>{/if}
</div>
