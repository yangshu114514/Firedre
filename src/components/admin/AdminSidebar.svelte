<script lang="ts">
import { onMount } from "svelte";
import { iconSvg, isActive, NAV_GROUPS } from "@/lib/adminNav";

interface Props {
	open: boolean;
	section: string;
	settingsCat: number;
	s3open: boolean;
	username: string;
	onClose: () => void;
	onToggleS3: () => void;
	onGoSettings: (ci: number) => void;
}
let {
	open,
	section,
	settingsCat,
	s3open,
	username,
	onClose,
	onToggleS3,
	onGoSettings,
}: Props = $props();

// 身份自适应：管理员看全部菜单；仅持细粒度权限的账号只看到其可用的组。
// 越权请求在接口层仍会被拒绝，此处只负责界面呈现。
let isAdmin = $state(true);
let roleLabel = $state("管理员");
let visibleGroups = $state(NAV_GROUPS);

onMount(async () => {
	try {
		const r = await fetch("/api/backend/me/", {
			credentials: "include",
			headers: { accept: "application/json" },
		});
		const d = await r.json().catch(() => null);
		if (d?.authenticated) {
			isAdmin = !!d.isAdmin;
			visibleGroups = NAV_GROUPS.filter((g) => isAdmin || !g.adminOnly);
			roleLabel = d.isAdmin ? "管理员" : (d.permLabels?.[0] ?? "受限账号");
		}
	} catch {
		// 网络异常保持默认（显示全部菜单）
	}
});
</script>

<aside class="sidebar" class:open={open}>
			<div class="brand">
				<img class="brand-logo" src="/favicon/firefly-32.png" alt="Firedre" />
				<span class="brand-text">Firedre</span>
				<button class="menu-close" aria-label="关闭菜单" onclick={onClose}>
					{@html iconSvg("close")}
				</button>
			</div>

			<nav class="nav">
				{#each visibleGroups as group (group.title)}
					<div class="nav-group">
						<p class="nav-title">{group.title}</p>
						{#if group.settings}
							<div class="s3wrap" class:open={s3open && section === "settings"}>
								<a
									href="/admin/settings/"
									class="nav-item s3parent"
									class:active={section === "settings"}
									onclick={() => {	onToggleS3();
										if (section !== "settings") onGoSettings(0);
									}}
								>
									<span class="nav-icon">{@html iconSvg("settings")}</span>
									<span class="nav-label">站点设置</span>
									<span class="s3caret">{@html iconSvg("chevron")}</span>
								</a>
								<div class="s3sub">
									{#each ["站点配置", "功能配置", "页面配置", "扩展功能"] as label, ci}
										<button
											type="button"
											class="s3cat"
											class:on={section === "settings" && settingsCat === ci}
											onclick={() => onGoSettings(ci)}
										>
											{label}
										</button>
									{/each}
								</div>
							</div>
						{:else}
							{#each group.items as item (item.href)}
								<a
									href={item.href}
									class="nav-item"
									class:active={isActive(item, section)}
								>
									<span class="nav-icon">{@html iconSvg(item.icon)}</span>
									<span class="nav-label">{item.label}</span>
								</a>
							{/each}
						{/if}
					</div>
				{/each}
			</nav>

			<div class="side-foot">
				<a class="site-link" href="/" target="_blank" rel="noopener">
					<span class="nav-icon">{@html iconSvg("external")}</span>
					<span class="nav-label">查看站点</span>
				</a>
				<div class="user">
					<img class="avatar" src="/favicon/firefly-32.png" alt="" />
					<div class="user-meta">
						<span class="user-name">{username || "admin"}</span>
						<span class="user-role">{roleLabel}</span>
					</div>
				</div>
			</div>
</aside>
