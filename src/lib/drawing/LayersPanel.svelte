<script lang="ts">
	import type { Layer } from './types';

	let {
		layers,
		activeLayerId = $bindable(),
		activeLayer,
		onadd,
		onimport,
		onmerge,
		onlock,
		onremove,
		ontoggle,
		onmove,
		onopacitychange,
		onresettransform
	}: {
		layers: Layer[];
		activeLayerId: number;
		activeLayer: Layer;
		onadd: () => void;
		onimport: (files: FileList | null) => void;
		onmerge: () => void;
		onlock: (layer: Layer) => void;
		onremove: (id: number) => void;
		ontoggle: (layer: Layer) => void;
		onmove: (id: number, direction: -1 | 1) => void;
		onopacitychange: () => void;
		onresettransform: () => void;
	} = $props();
</script>

<aside class="layers-panel" aria-label="Layers">
	<div class="layers-heading">
		<strong>Layers</strong><div class="layer-heading-actions"><label class="layer-import" title="Import image as layer">
			<input type="file" accept="image/*" onchange={(event) => onimport(event.currentTarget.files)} />
			<span aria-label="Import image">Image</span>
		</label><button
			class="layer-add"
			onclick={onadd}
			aria-label="Add layer"
			title="Add layer">+</button
		></div>
	</div>
	<div class="layer-list">
		{#each [...layers].reverse() as layer, reversedIndex (layer.id)}
			{@const layerIndex = layers.length - reversedIndex - 1}
			<div class:active={layer.id === activeLayerId} class="layer-row">
				<button
					class:hidden={!layer.visible}
					class="visibility-button"
					onclick={() => ontoggle(layer)}
					aria-label={layer.visible ? `Hide ${layer.name}` : `Show ${layer.name}`}
				>
					{#if layer.visible}<svg viewBox="0 0 24 24"
							><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" /><circle
								cx="12"
								cy="12"
								r="2.5"
							/></svg
						>
					{:else}<svg viewBox="0 0 24 24"
							><path d="M3 3l18 18" /><path
								d="M10.6 6.1A11 11 0 0 1 12 6c6.5 0 10 6 10 6a18 18 0 0 1-2.1 2.8M6.2 6.2C3.5 8 2 12 2 12s3.5 6 10 6a10 10 0 0 0 4-.8"
							/></svg
						>{/if}
				</button>
				<button
					class:locked={layer.locked}
					class="layer-lock"
					onclick={() => onlock(layer)}
					aria-label={layer.locked ? `Unlock ${layer.name}` : `Lock ${layer.name}`}
					title={layer.locked ? 'Unlock layer content' : 'Lock layer content'}
				>{layer.locked ? '●' : '○'}</button
				>
				<button class="layer-select" onclick={() => (activeLayerId = layer.id)}
					><span>{layer.name}</span><small
						>{layer.image ? 'Image' : `${layer.strokes.length} stroke${layer.strokes.length === 1 ? '' : 's'}`}</small
					></button
				>
				<div class="layer-order">
					<button
						onclick={() => onmove(layer.id, 1)}
						disabled={layerIndex === layers.length - 1}
						aria-label="Move layer up">↑</button
					>
					<button
						onclick={() => onmove(layer.id, -1)}
						disabled={layerIndex === 0}
						aria-label="Move layer down">↓</button
					>
				</div>
				<button
					class="layer-delete"
					onclick={() => onremove(layer.id)}
					disabled={layers.length === 1}
					aria-label={`Delete ${layer.name}`}>×</button
				>
			</div>
		{/each}
	</div>
	<button class="merge-layer" onclick={onmerge} disabled={layers.findIndex((layer) => layer.id === activeLayerId) <= 0}>Merge down</button>
	<label class="layer-opacity"
		><span>Opacity</span><input
			type="range"
			min="0"
			max="1"
			step="0.01"
			bind:value={activeLayer.opacity}
			oninput={onopacitychange}
		/><output>{Math.round(activeLayer.opacity * 100)}%</output></label
	>
	<div class="transform-summary">
		<span>Transform</span>
		<output
			>{Math.round(activeLayer.transform.x)}, {Math.round(activeLayer.transform.y)} · {Math.round(
				activeLayer.transform.rotation
			)}° · {Math.round(activeLayer.transform.scaleX * 100)}%</output
		>
		<button
			onclick={onresettransform}
			disabled={activeLayer.strokes.length === 0 && !activeLayer.image}
			title="Reset layer transform">Reset</button
		>
	</div>
</aside>
