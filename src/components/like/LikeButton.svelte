<script lang="ts">
import { onMount } from "svelte";
import Icon from "@/components/common/Icon.svelte";

interface Props {
	slug: string;
	initialCount?: number;
	initialLiked?: boolean;
}

let {
	slug,
	initialCount = 0,
	initialLiked = false,
}: Props = $props();

// SSR 首屏种子值：挂载后 onMount 会拉取真实计数覆盖，props 不再变化
// svelte-ignore state_referenced_locally
let count = $state(initialCount);
// svelte-ignore state_referenced_locally
let liked = $state(initialLiked);
let authenticated = $state(false);
let busy = $state(false);
let hint = $state("");

// 挂载后补一次真实状态（计数 / 是否已赞 / 是否登录）
onMount(() => {
	(async () => {
		try {
			const resp = await fetch(
				`/api/likes/?slug=${encodeURIComponent(slug)}`,
				{ credentials: "same-origin" },
			);
			if (!resp.ok) return;
			const data = (await resp.json()) as {
				count?: number;
				liked?: boolean;
				authenticated?: boolean;
			};
			if (typeof data.count === "number") count = data.count;
			if (typeof data.liked === "boolean") liked = data.liked;
			if (typeof data.authenticated === "boolean")
				authenticated = data.authenticated;
		} catch {
			// 静默：计数展示不影响阅读
		}
	})();
});

function showHint(text: string) {
	hint = text;
	window.setTimeout(() => {
		if (hint === text) hint = "";
	}, 2200);
}

async function toggle() {
	if (busy) return;

	// 未登录：跳登录页（任务要求）
	if (!authenticated) {
		window.location.href = "/login/";
		return;
	}

	busy = true;
	try {
		const resp = await fetch("/api/likes/toggle/", {
			method: "POST",
			credentials: "same-origin",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ slug }),
		});
		const data = (await resp.json().catch(() => null)) as {
			message?: string;
			count?: number;
			liked?: boolean;
			needLogin?: boolean;
		} | null;

		if (!resp.ok) {
			if (data?.needLogin || resp.status === 401) {
				authenticated = false;
				window.location.href = "/login/";
				return;
			}
			showHint(data?.message || "操作失败，请稍后再试");
			return;
		}

		if (typeof data?.count === "number") count = data.count;
		if (typeof data?.liked === "boolean") liked = data.liked;
		showHint(liked ? "已点赞" : "已取消点赞");
	} catch {
		showHint("网络错误，请稍后再试");
	} finally {
		busy = false;
	}
}
</script>

<div class="flex items-center gap-3">
  <button
    class="group inline-flex items-center gap-2 rounded-full border px-5 py-2.5 text-sm transition-all active:scale-95 disabled:opacity-60 {liked
      ? 'border-(--primary) bg-(--primary) text-white dark:text-black/80'
      : 'border-(--line-divider) text-(--content-meta) hover:border-(--primary) hover:text-(--primary)'}"
    onclick={toggle}
    disabled={busy}
    aria-pressed={liked}
    aria-label={liked ? "取消点赞" : "点赞本文"}
  >
    <Icon
      icon={liked ? "material-symbols:favorite" : "material-symbols:favorite-outline-rounded"}
      class="text-lg"
    />
    <span class="font-medium">{count}</span>
    <span>{liked ? "已点赞" : "点赞"}</span>
  </button>

  {#if hint}
    <span class="text-xs text-(--content-meta)" role="status">{hint}</span>
  {/if}
</div>
