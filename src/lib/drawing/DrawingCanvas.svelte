<script lang="ts">
	let {
		canvas = $bindable(),
		onpointerdown,
		onpointermove,
		onpointerup,
		onwheel,
		ondoublepress,
		tool
	}: {
		canvas: HTMLCanvasElement;
		onpointerdown: (event: PointerEvent) => void;
		onpointermove: (event: PointerEvent) => void;
		onpointerup: (event: PointerEvent) => void;
		onwheel: (event: WheelEvent) => void;
		ondoublepress: (event: MouseEvent) => void;
		tool: 'draw' | 'transform' | 'pan';
	} = $props();
</script>

<section class="flex h-full w-full flex-1">
	<div class="canvas-frame absolute h-full w-full">
		<canvas
			class="h-full"
			class:transform-mode={tool === 'transform'}
			class:pan-mode={tool === 'pan'}
			bind:this={canvas}
			{onpointerdown}
			{onpointermove}
			{onpointerup}
			onpointercancel={onpointerup}
			ondblclick={ondoublepress}
			{onwheel}
			aria-label="Drawing canvas"
		></canvas>
	</div>
	<footer class="absolute bottom-0 z-[9999] w-full bg-white">
		<span
			>{tool === 'pan'
				? 'Drag to pan · scroll to zoom'
				: tool === 'transform'
				? 'Drag layer · side/corner handles resize · hold Alt/Option to scale from center · round handle rotates'
				: 'Draw freely'}</span
		><span class="footer-dot">•</span><span><kbd>⌘</kbd> <kbd>Z</kbd> to undo</span><span
			class="footer-dot">•</span
		><span>Your drawing stays in this tab</span>
	</footer>
</section>
