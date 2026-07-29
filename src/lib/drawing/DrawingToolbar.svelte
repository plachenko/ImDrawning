<script lang="ts">
	import type { Layer } from './types';

	let {
		colors,
		color = $bindable(),
		brushSize = $bindable(),
		smoothingSteps = $bindable(),
		taper = $bindable(),
		globalHistory = $bindable(),
		activeLayer,
		canUndo,
		canRedo,
		onundo,
		onredo,
		onclear,
		onexportview,
		onexportall,
		onexportanimation,
		onrotateview,
		onresetview,
		gridVisible = $bindable(),
		radialSlots = $bindable(),
		tool = $bindable()
	}: {
		colors: string[];
		color: string;
		brushSize: number;
		smoothingSteps: number;
		taper: number;
		globalHistory: boolean;
		activeLayer: Layer;
		canUndo: boolean;
		canRedo: boolean;
		onundo: () => void;
		onredo: () => void;
		onclear: () => void;
		tool: 'draw' | 'transform' | 'pan';
		onexportview: () => void;
		onexportall: () => void;
		onexportanimation: () => void;
		onrotateview: () => void;
		onresetview: () => void;
		gridVisible: boolean;
		radialSlots: string[];
	} = $props();
	let menuOpen = $state(false);
	const radialOptions = [
		'Draw',
		'Transform',
		'Pan',
		'Undo',
		'Redo',
		'Reset view',
		'Toggle grid',
		'Clear'
	];
</script>

<div class="toolbar">
	<button
		class="menu-trigger"
		onclick={() => (menuOpen = !menuOpen)}
		aria-expanded={menuOpen}
		aria-label="Open menu">☰</button
	>
	{#if menuOpen}
		<aside class="main-popover" aria-label="Canvas menu">
			<div class="popover-heading">
				<strong>Canvas menu</strong><button onclick={() => (menuOpen = false)}>×</button>
			</div>
			<div class="popover-list">
				<label class="menu-check"
					><input type="checkbox" bind:checked={gridVisible} /><span>Show grid</span></label
				>
				<label class="menu-check"
					><input type="checkbox" bind:checked={globalHistory} /><span>Global history</span></label
				>
				<button onclick={onrotateview}>Rotate view 15°</button>
				<button onclick={onresetview}>Reset view</button>
				<hr />
				<strong class="menu-label">Save</strong>
				<button onclick={onexportview}>Viewport PNG</button>
				<button onclick={onexportall}>All artwork PNG</button>
				<button onclick={onexportanimation}>All as animation</button>
				<hr />
				<strong class="menu-label">Circle menu slots</strong>
				{#each radialSlots as slot, index}
					<label class="slot-select"
						><span>{index + 1}</span><select bind:value={radialSlots[index]}
							>{#each radialOptions as option}<option>{option}</option>{/each}</select
						></label
					>
				{/each}
			</div>
		</aside>
	{/if}
	<div class="tool-picker" aria-label="Canvas tool">
		<button
			class:active={tool === 'draw'}
			onclick={() => (tool = 'draw')}
			aria-pressed={tool === 'draw'}>Draw</button
		>
		<button
			class:active={tool === 'transform'}
			onclick={() => (tool = 'transform')}
			aria-pressed={tool === 'transform'}>Transform</button
		>
		<button
			class:active={tool === 'pan'}
			onclick={() => (tool = 'pan')}
			aria-pressed={tool === 'pan'}>Pan</button
		>
	</div>
	<!--
	<div class="divider"></div>
	<div class="color-tools" aria-label="Brush color">
		{#each colors as swatch}
			<button
				class:active={color === swatch}
				class="swatch"
				style:--swatch={swatch}
				onclick={() => (color = swatch)}
				aria-label={`Use ${swatch}`}
				aria-pressed={color === swatch}
			></button>
		{/each}
	</div>
	<div class="divider"></div>
	<label class="size-control">
		<span>Size</span>
		<input type="range" min="2" max="28" step="1" bind:value={brushSize} aria-label="Brush size" />
		<output>{brushSize}</output>
	</label>
	<label class="size-control smoothing-control">
		<span>Curve</span>
		<input
			type="range"
			min="0"
			max="12"
			step="1"
			bind:value={smoothingSteps}
			aria-label="Bézier curve smoothing"
		/>
		<output>{smoothingSteps}</output>
	</label>
	<label class="size-control taper-control">
		<span>Sharp ends</span>
		<input type="range" min="0" max="100" step="1" bind:value={taper} aria-label="Stroke end taper" />
		<output>{taper}%</output>
	</label>
	<div class="toolbar-actions">
		<button
			class="icon-button"
			onclick={onundo}
			disabled={!canUndo}
			aria-label="Undo last stroke"
			title="Undo (Ctrl/⌘ Z)"
		>
			<svg viewBox="0 0 24 24"><path d="m9 7-5 5 5 5" /><path d="M20 17a8 8 0 0 0-8-8H4" /></svg
			><span>Undo</span>
		</button>
		<button
			class="icon-button"
			onclick={onredo}
			disabled={!canRedo}
			aria-label="Redo stroke"
			title="Redo (Ctrl/⌘ Shift Z)"
		>
			<svg viewBox="0 0 24 24"><path d="m15 7 5 5-5 5" /><path d="M4 17a8 8 0 0 1 8-8h8" /></svg
			><span>Redo</span>
		</button>
		<button class="clear-button" onclick={onclear} disabled={activeLayer.locked || activeLayer.strokes.length === 0}
			>Clear</button
		>
	</div>
  -->
</div>
