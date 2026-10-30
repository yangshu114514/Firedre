<script lang="ts">
import { onMount } from "svelte";
import { apiJson } from "@/lib/adminApi";
import Switch from "./Switch.svelte";

interface Props {
	group: string;
	enableKey: string;
	enableLabel: string;
	title: string;
	titleField?: string;
	descField?: string;
	/**
	 * 该模块组的 `enabled` 是否就是页面前台开关。
	 *
	 * 后台「页面管理」的开关真源是 `basic.pageXxx`（middleware derivePages →
	 * settings.pages → 页面门禁读取）；而各模块组（gallery/dynamic/friends）的
	 * `enabled` 只是模块自身配置。相册管理页此前只写 gallery.enabled，
	 * 导致「启用相册页」开关打开后前台仍 302 到 /404/。
	 */
	syncPageSwitch?: boolean;
}

let {
	group,
	enableKey,
	enableLabel,
	title,
	titleField = "",
	descField = "",
	syncPageSwitch = false,
}: Props = $props();

// basic 组里对应的页面前台开关名（pageGallery / pageDynamic / pageFriends ...）
const pageSwitchKey = (() => {
	if (!syncPageSwitch) return "";
	const cap = group.charAt(0).toUpperCase() + group.slice(1);
	return `page${cap}`;
})();

let enabled = $state(false);
let titleVal = $state("");
let descVal = $state("");
let loading = $state(true);
let saving = $state(false);

async function load() {
	loading = true;
	try {
		const [data, basic] = await Promise.all([
			apiJson<Record<string, unknown>>(`/api/settings/?group=${group}`),
			pageSwitchKey
				? apiJson<Record<string, unknown>>("/api/settings/?group=basic")
				: Promise.resolve({} as Record<string, unknown>),
		]);
		// 有页面前台开关时以后者为准（它才是实际门禁）
		enabled = pageSwitchKey
			? Boolean(basic[pageSwitchKey])
			: Boolean(data[enableKey]);
		if (titleField) titleVal = String(data[titleField] ?? "");
		if (descField) descVal = String(data[descField] ?? "");
	} catch {}
	loading = false;
}

async function toggle() {
	enabled = !enabled;
	saving = true;
	try {
		const groups: Record<string, Record<string, unknown>> = {
			[group]: { [enableKey]: enabled },
		};
		// 同步写 basic.pageXxx，否则前台门禁不会变
		if (pageSwitchKey) groups.basic = { [pageSwitchKey]: enabled };
		await apiJson("/api/settings/", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ groups }),
		});
	} catch {
		enabled = !enabled;
	}
	saving = false;
}

onMount(load);
</script>

<details class="modcfg">
	<summary>
		<span class="mct">{title}</span>
		<span class="mccaret">▾</span>
	</summary>
	<div class="mcin">
		<label class="mctr">
			<span>{enableLabel}</span>
			<Switch on={enabled} label={enableLabel} toggle={toggle} disabled={saving} />
		</label>
		{#if titleField}
			<div class="mcfg">
				<div class="a2f">
					<!-- svelte-ignore a11y_label_has_associated_control —— 输入框已有 aria-label -->
					<label>页面标题</label>
					<input type="text" aria-label="页面标题" bind:value={titleVal} />
				</div>
				{#if descField}
					<div class="a2f w">
						<!-- svelte-ignore a11y_label_has_associated_control —— 输入框已有 aria-label -->
						<label>页面描述</label>
						<textarea rows="3" aria-label="页面描述" bind:value={descVal}></textarea>
					</div>
				{/if}
			</div>
		{/if}
	</div>
</details>
