<script lang="ts">
	import { onMount } from 'svelte';

	type Point = { x: number; y: number };
	type Stroke = { points: Point[]; color: string; size: number };

	let canvas: HTMLCanvasElement;
	let context: CanvasRenderingContext2D | null = null;
	let strokes = $state<Stroke[]>([]);
	let activeStroke: Stroke | null = null;
	let color = $state('#171717');
	let brushSize = $state(6);
	let isDrawing = $state(false);
	let canvasWidth = 0;
	let canvasHeight = 0;

	const colors = ['#171717', '#ef4444', '#f59e0b', '#16a34a', '#2563eb', '#7c3aed'];

	function configureContext() {
		if (!context) return;
		context.lineCap = 'round';
		context.lineJoin = 'round';
	}

	function drawStroke(stroke: Stroke) {
		if (!context || stroke.points.length === 0) return;
		context.strokeStyle = stroke.color;
		context.fillStyle = stroke.color;
		context.lineWidth = stroke.size;

		if (stroke.points.length === 1) {
			const point = stroke.points[0];
			context.beginPath();
			context.arc(point.x, point.y, stroke.size / 2, 0, Math.PI * 2);
			context.fill();
			return;
		}

		context.beginPath();
		context.moveTo(stroke.points[0].x, stroke.points[0].y);
		for (let index = 1; index < stroke.points.length - 1; index++) {
			const point = stroke.points[index];
			const next = stroke.points[index + 1];
			context.quadraticCurveTo(point.x, point.y, (point.x + next.x) / 2, (point.y + next.y) / 2);
		}
		const last = stroke.points.at(-1)!;
		context.lineTo(last.x, last.y);
		context.stroke();
	}

	function redraw() {
		if (!context) return;
		context.clearRect(0, 0, canvasWidth, canvasHeight);
		for (const stroke of strokes) drawStroke(stroke);
	}

	function resizeCanvas() {
		const rect = canvas.getBoundingClientRect();
		const dpr = window.devicePixelRatio || 1;
		canvasWidth = rect.width;
		canvasHeight = rect.height;
		canvas.width = Math.round(rect.width * dpr);
		canvas.height = Math.round(rect.height * dpr);
		context = canvas.getContext('2d');
		context?.setTransform(dpr, 0, 0, dpr, 0, 0);
		configureContext();
		redraw();
	}

	function position(event: PointerEvent): Point {
		const rect = canvas.getBoundingClientRect();
		return { x: event.clientX - rect.left, y: event.clientY - rect.top };
	}

	function startDrawing(event: PointerEvent) {
		if (event.button !== 0 && event.pointerType === 'mouse') return;
		canvas.setPointerCapture(event.pointerId);
		isDrawing = true;
		activeStroke = { points: [position(event)], color, size: brushSize };
		drawStroke(activeStroke);
	}

	function draw(event: PointerEvent) {
		if (!isDrawing || !activeStroke) return;
		const events = event.getCoalescedEvents?.() ?? [event];
		for (const sample of events) activeStroke.points.push(position(sample));
		redraw();
		drawStroke(activeStroke);
	}

	function stopDrawing(event?: PointerEvent) {
		if (!isDrawing || !activeStroke) return;
		if (event && canvas.hasPointerCapture(event.pointerId))
			canvas.releasePointerCapture(event.pointerId);
		strokes.push(activeStroke);
		activeStroke = null;
		isDrawing = false;
	}

	function undo() {
		if (strokes.length === 0) return;
		strokes.pop();
		redraw();
	}

	function clearCanvas() {
		if (strokes.length === 0) return;
		strokes.length = 0;
		redraw();
	}

	function handleKeydown(event: KeyboardEvent) {
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
			event.preventDefault();
			undo();
		}
	}

	onMount(() => {
		const observer = new ResizeObserver(resizeCanvas);
		observer.observe(canvas);
		resizeCanvas();
		return () => observer.disconnect();
	});
</script>

<svelte:head>
	<title>Canvas — Draw freely</title>
	<meta name="description" content="A simple, focused drawing canvas." />
</svelte:head>

<svelte:window onkeydown={handleKeydown} />

<main>
	<!--
	<header>
		<a class="brand" href="/" aria-label="Canvas home">
			<span class="brand-mark" aria-hidden="true">
				<svg viewBox="0 0 24 24"
					><path d="M4 17.5 15.8 5.7a2.1 2.1 0 0 1 3 3L7 20.5 3.5 21l.5-3.5Z" /><path
						d="m13.8 7.7 3 3"
					/></svg
				>
			</span>
			Canvas
		</a>
	</header>
  -->

	<section class="workspace w-full" aria-label="Drawing workspace">
		<div class="toolbar">
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
				<input
					type="range"
					min="2"
					max="28"
					step="1"
					bind:value={brushSize}
					aria-label="Brush size"
				/>
				<output>{brushSize}</output>
			</label>

			<div class="toolbar-actions">
				<button
					class="icon-button"
					onclick={undo}
					disabled={strokes.length === 0}
					aria-label="Undo last stroke"
					title="Undo (Ctrl/⌘ Z)"
				>
					<svg viewBox="0 0 24 24"><path d="m9 7-5 5 5 5" /><path d="M20 17a8 8 0 0 0-8-8H4" /></svg
					>
					<span>Undo</span>
				</button>
				<button class="clear-button" onclick={clearCanvas} disabled={strokes.length === 0}
					>Clear</button
				>
			</div>
		</div>

		<section class="flex h-full w-full flex-1 bg-red-400">
			<div class="absolute h-full w-full bg-blue-400">
				<canvas
					class="h-full bg-blue-300"
					bind:this={canvas}
					onpointerdown={startDrawing}
					onpointermove={draw}
					onpointerup={stopDrawing}
					onpointercancel={stopDrawing}
					aria-label="Drawing canvas"
				></canvas>
			</div>
			<footer class="absolute bottom-0 z-[9999] w-full bg-white">
				<span><kbd>⌘</kbd> <kbd>Z</kbd> to undo</span>
				<span class="footer-dot">•</span>
				<span>Your drawing stays in this tab</span>
			</footer>
		</section>
		<!--
		<div class="canvas-frame h-full flex-1 flex-row bg-red-400">
			<canvas
				class="flex-1 bg-blue-300"
				bind:this={canvas}
				onpointerdown={startDrawing}
				onpointermove={draw}
				onpointerup={stopDrawing}
				onpointercancel={stopDrawing}
				aria-label="Drawing canvas"
			></canvas>
			{#if strokes.length === 0 && !isDrawing}
				<div class="empty-state" aria-hidden="true">
					<svg viewBox="0 0 24 24"
						><path d="M4 17.5 15.8 5.7a2.1 2.1 0 0 1 3 3L7 20.5 3.5 21l.5-3.5Z" /><path
							d="m13.8 7.7 3 3"
						/></svg
					>
					<span>Start drawing anywhere</span>
				</div>
			{/if}
		</div>
	</section>
      -->
	</section>
</main>
