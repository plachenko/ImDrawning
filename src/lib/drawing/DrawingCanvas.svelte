<script lang="ts">
	let {
		canvas = $bindable(),
		overlayCanvas = $bindable(),
		onpointerdown,
		onpointermove,
		onpointerup,
		onpointerleave,
		onwheel,
		ondoublepress,
		tool
	}: {
		canvas: HTMLCanvasElement;
		overlayCanvas: HTMLCanvasElement;
		onpointerdown: (event: PointerEvent) => void;
		onpointermove: (event: PointerEvent) => void;
		onpointerup: (event: PointerEvent) => void;
		onpointerleave: (event: PointerEvent) => void;
		onwheel: (event: WheelEvent) => void;
		ondoublepress: (event: MouseEvent) => void;
		tool: 'draw' | 'edit' | 'transform' | 'pan';
	} = $props();
</script>

<section class="flex h-full w-full flex-1">
	<div class="canvas-frame absolute h-full w-full">
		<canvas class="drawing-canvas h-full" bind:this={canvas} aria-label="Drawing canvas"></canvas>
		<canvas
			class="interaction-canvas h-full"
			class:transform-mode={tool === 'transform'}
			class:edit-mode={tool === 'edit'}
			class:pan-mode={tool === 'pan'}
			bind:this={overlayCanvas}
			{onpointerdown}
			{onpointermove}
			{onpointerup}
			onpointercancel={onpointerup}
			{onpointerleave}
			ondblclick={ondoublepress}
			{onwheel}
			aria-label="Drawing interaction surface"
		></canvas>
	</div>
	<footer class="absolute bottom-0 z-[9999] w-full bg-white">
		<span
			>{tool === 'pan'
				? 'Drag to pan · scroll to zoom'
				: tool === 'transform'
				? 'Two fingers over layer move, scale, and rotate · move outside it to transform the canvas'
				: tool === 'edit'
					? 'Select a shape, then drag its blue handles'
				: 'Draw freely'}</span
		><span class="footer-dot">•</span><span><kbd>⌘</kbd> <kbd>Z</kbd> to undo</span><span
			class="footer-dot">•</span
		><span>Your drawing stays in this tab</span>
	</footer>
</section>
