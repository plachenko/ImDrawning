<script lang="ts">
	import { onMount } from 'svelte';
	import DrawingCanvas from '$lib/drawing/DrawingCanvas.svelte';
	import DrawingToolbar from '$lib/drawing/DrawingToolbar.svelte';
	import LayersPanel from '$lib/drawing/LayersPanel.svelte';
	import type { Layer, LayerTransform, Point, Stroke } from '$lib/drawing/types';
	type HistoryEntry =
		| { kind: 'stroke'; layerId: number; strokeId: number; stroke: Stroke }
		| { kind: 'transform'; layerId: number; before: LayerTransform; after: LayerTransform };
	type TransformGesture = {
		kind: 'move' | 'scale' | 'rotate';
		pointerId: number;
		start: Point;
		center: Point;
		before: LayerTransform;
		handle?: { x: -1 | 0 | 1; y: -1 | 0 | 1 };
		bounds?: ReturnType<typeof layerBounds>;
	};

	let canvas = $state<HTMLCanvasElement>(null!);
	let context: CanvasRenderingContext2D | null = null;
	let nextLayerId = 2;
	let nextStrokeId = 1;
	let layers = $state<Layer[]>([
		{
			id: 1,
			name: 'Layer 1',
			visible: true,
			locked: false,
			opacity: 1,
			strokes: [],
			transform: identityTransform()
		}
	]);
	let activeLayerId = $state(1);
	let activeLayer = $derived(layers.find((layer) => layer.id === activeLayerId) ?? layers[0]);
	let globalHistory = $state(true);
	let globalUndo = $state<HistoryEntry[]>([]);
	let globalRedo = $state<HistoryEntry[]>([]);
	let canUndo = $derived(
		globalHistory
			? globalUndo.length > 0
			: globalUndo.some((entry) => entry.layerId === activeLayerId)
	);
	let canRedo = $derived(
		globalHistory
			? globalRedo.length > 0
			: globalRedo.some((entry) => entry.layerId === activeLayerId)
	);
	let activeStroke: Stroke | null = null;
	let color = $state('#171717');
	let brushSize = $state(6);
	let smoothingSteps = $state(4);
	let taper = $state(35);
	let isDrawing = $state(false);
	let canvasWidth = 0;
	let canvasHeight = 0;
	let tool = $state<'draw' | 'transform' | 'pan'>('draw');
	let camera = $state({ x: 0, y: 0, zoom: 1, rotation: 0 });
	let gridVisible = $state(true);
	let radialSlots = $state(['Draw', 'Undo', 'Transform', 'Reset view']);
	let radialMenu = $state<{ x: number; y: number } | null>(null);
	let lastCanvasPress: { time: number; point: Point } | null = null;
	let panGesture: { pointerId: number; start: Point; x: number; y: number } | null = null;
	let touchPoints = new Map<number, Point>();
	let pinchGesture: {
		distance: number;
		worldMidpoint: Point;
		zoom: number;
		angle: number;
		rotation: number;
	} | null = null;
	let multiTouchActive = false;
	let pinchCache: { canvas: HTMLCanvasElement; origin: Point; scale: number } | null = null;
	let transformGesture: TransformGesture | null = null;

	const colors = ['#171717', '#ef4444', '#f59e0b', '#16a34a', '#2563eb', '#7c3aed'];
	function identityTransform(): LayerTransform {
		return { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };
	}
	const copyTransform = (value: LayerTransform): LayerTransform => ({ ...value });

	function configureContext() {
		if (!context) return;
		context.lineCap = 'round';
		context.lineJoin = 'round';
	}

	function drawStroke(stroke: Stroke, target = context) {
		if (!target || stroke.points.length === 0) return;
		const [first] = stroke.points;
		target.save();
		target.fillStyle = stroke.color;

		if (stroke.points.length === 1) {
			target.beginPath();
			target.arc(first.x, first.y, stroke.size / 2, 0, Math.PI * 2);
			target.fill();
			target.restore();
			return;
		}

		type WidthPoint = Point & { width: number; distance: number };
		const samples: WidthPoint[] = [{ ...first, width: stroke.size, distance: 0 }];
		const curveAmount = stroke.smoothing / 24;
		let cursor = first;
		for (let index = 1; index < stroke.points.length - 1; index++) {
			const point = stroke.points[index];
			const next = stroke.points[index + 1];
			const end = {
				x: point.x + (next.x - point.x) * curveAmount,
				y: point.y + (next.y - point.y) * curveAmount
			};
			const sampleDistance = Math.hypot(point.x - stroke.points[index - 1].x, point.y - stroke.points[index - 1].y);
			const width = stroke.size + Math.min(stroke.size * 0.9, Math.sqrt(sampleDistance) * 0.45);
			const steps = Math.max(3, Math.ceil(Math.hypot(end.x - cursor.x, end.y - cursor.y) / 5));
			const startWidth = samples[samples.length - 1].width;
			for (let step = 1; step <= steps; step++) {
				const amount = step / steps;
				const inverse = 1 - amount;
				const x = inverse * inverse * cursor.x + 2 * inverse * amount * point.x + amount * amount * end.x;
				const y = inverse * inverse * cursor.y + 2 * inverse * amount * point.y + amount * amount * end.y;
				const previous = samples[samples.length - 1];
				samples.push({ x, y, width: startWidth + (width - startWidth) * amount, distance: previous.distance + Math.hypot(x - previous.x, y - previous.y) });
			}
			cursor = end;
		}
		const last = stroke.points[stroke.points.length - 1];
		const previousRaw = stroke.points[stroke.points.length - 2];
		const finalDistance = Math.hypot(last.x - previousRaw.x, last.y - previousRaw.y);
		const finalWidth = stroke.size + Math.min(stroke.size * 0.9, Math.sqrt(finalDistance) * 0.45);
		const finalSteps = Math.max(3, Math.ceil(Math.hypot(last.x - cursor.x, last.y - cursor.y) / 5));
		const finalStartWidth = samples[samples.length - 1].width;
		for (let step = 1; step <= finalSteps; step++) {
			const amount = step / finalSteps;
			const x = cursor.x + (last.x - cursor.x) * amount;
			const y = cursor.y + (last.y - cursor.y) * amount;
			const previous = samples[samples.length - 1];
			samples.push({ x, y, width: finalStartWidth + (finalWidth - finalStartWidth) * amount, distance: previous.distance + Math.hypot(x - previous.x, y - previous.y) });
		}

		// Pointer events arrive at uneven intervals. Two weighted passes remove those
		// timing spikes without flattening intentional changes in stroke width.
		for (let pass = 0; pass < 3; pass++) {
			const widths = samples.map((sample, index) => {
				const before = samples[Math.max(0, index - 1)].width;
				const after = samples[Math.min(samples.length - 1, index + 1)].width;
				return before * 0.25 + sample.width * 0.5 + after * 0.25;
			});
			for (let index = 0; index < samples.length; index++) samples[index].width = widths[index];
		}

		const totalDistance = samples[samples.length - 1].distance || 1;
		const taperDistance = totalDistance * (((stroke.taper ?? 0) / 100) * 0.5);
		const edge = (sample: WidthPoint, index: number, side: -1 | 1) => {
			const before = samples[Math.max(0, index - 2)];
			const after = samples[Math.min(samples.length - 1, index + 2)];
			const tangentX = after.x - before.x;
			const tangentY = after.y - before.y;
			const length = Math.hypot(tangentX, tangentY) || 1;
			const taperScale = taperDistance > 0 ? Math.min(1, sample.distance / taperDistance, (totalDistance - sample.distance) / taperDistance) : 1;
			// A diagonal calligraphic axis distributes ink according to direction.
			// Up-left motion biases the right side; down-right reverses that bias.
			const angleBias = Math.max(-1, Math.min(1, (-tangentX - tangentY) / (length * Math.SQRT2))) * 0.34;
			const sideWeight = 1 - side * angleBias;
			const radius = (sample.width / 2) * Math.max(0, taperScale) * sideWeight;
			return { x: sample.x + (-tangentY / length) * radius * side, y: sample.y + (tangentX / length) * radius * side };
		};
		const left = samples.map((sample, index) => edge(sample, index, 1));
		const right = samples.map((sample, index) => edge(sample, index, -1)).reverse();
		const outline = [...left, ...right];
		target.beginPath();
		target.moveTo(outline[0].x, outline[0].y);
		for (let index = 1; index < outline.length - 1; index++) {
			const point = outline[index];
			const next = outline[index + 1];
			target.quadraticCurveTo(point.x, point.y, (point.x + next.x) / 2, (point.y + next.y) / 2);
		}
		const outlineLast = outline[outline.length - 1];
		target.lineTo(outlineLast.x, outlineLast.y);
		target.closePath();
		target.fill();
		target.restore();
	}

	function redraw() {
		if (!context) return;
		context.clearRect(0, 0, canvasWidth, canvasHeight);
		if (gridVisible) drawGrid();
		context.save();
		context.translate(camera.x, camera.y);
		context.rotate(camera.rotation);
		context.scale(camera.zoom, camera.zoom);
		if (pinchCache) {
			context.drawImage(
				pinchCache.canvas,
				pinchCache.origin.x,
				pinchCache.origin.y,
				pinchCache.canvas.width / pinchCache.scale,
				pinchCache.canvas.height / pinchCache.scale
			);
		} else {
			for (const layer of layers) {
				if (!layer.visible) continue;
				context.save();
				context.globalAlpha = layer.opacity;
				applyLayerTransform(layer);
				if (layer.image) context.drawImage(layer.image.element, layer.image.x, layer.image.y, layer.image.width, layer.image.height);
				for (const stroke of layer.strokes) drawStroke(stroke);
				if (layer.id === activeLayerId && activeStroke) drawStroke(activeStroke);
				context.restore();
			}
		}
		context.globalAlpha = 1;
		if (tool === 'transform') drawTransformControls();
		context.restore();
	}

	function drawGrid() {
		if (!context) return;
		let step = 40;
		while (step * camera.zoom < 16) step *= 5;
		const corners = [
			screenToWorld({ x: 0, y: 0 }),
			screenToWorld({ x: canvasWidth, y: 0 }),
			screenToWorld({ x: canvasWidth, y: canvasHeight }),
			screenToWorld({ x: 0, y: canvasHeight })
		];
		const minX = Math.floor(Math.min(...corners.map((point) => point.x)) / step) * step;
		const maxX = Math.ceil(Math.max(...corners.map((point) => point.x)) / step) * step;
		const minY = Math.floor(Math.min(...corners.map((point) => point.y)) / step) * step;
		const maxY = Math.ceil(Math.max(...corners.map((point) => point.y)) / step) * step;
		context.save();
		context.translate(camera.x, camera.y);
		context.rotate(camera.rotation);
		context.scale(camera.zoom, camera.zoom);
		context.strokeStyle = '#dedbd4';
		context.fillStyle = '#c9c5bc';
		context.lineWidth = 1 / camera.zoom;
		context.globalAlpha = 0.55;
		context.beginPath();
		for (let x = minX; x <= maxX; x += step) {
			context.moveTo(x, minY);
			context.lineTo(x, maxY);
		}
		for (let y = minY; y <= maxY; y += step) {
			context.moveTo(minX, y);
			context.lineTo(maxX, y);
		}
		context.stroke();
		for (let x = minX; x <= maxX; x += step) {
			for (let y = minY; y <= maxY; y += step) {
				context.beginPath();
				context.arc(x, y, 1.15 / camera.zoom, 0, Math.PI * 2);
				context.fill();
			}
		}
		context.restore();
	}

	function layerBounds(layer: Layer) {
		if (layer.strokes.length === 0 && !layer.image) return null;
		let minX = Infinity,
			minY = Infinity,
			maxX = -Infinity,
			maxY = -Infinity;
		for (const stroke of layer.strokes)
			for (const point of stroke.points) {
				const radius = stroke.size / 2;
				minX = Math.min(minX, point.x - radius);
				minY = Math.min(minY, point.y - radius);
				maxX = Math.max(maxX, point.x + radius);
				maxY = Math.max(maxY, point.y + radius);
			}
		if (layer.image) {
			minX = Math.min(minX, layer.image.x);
			minY = Math.min(minY, layer.image.y);
			maxX = Math.max(maxX, layer.image.x + layer.image.width);
			maxY = Math.max(maxY, layer.image.y + layer.image.height);
		}
		return { minX, minY, maxX, maxY, center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 } };
	}

	function applyLayerTransform(layer: Layer, target = context) {
		const bounds = layerBounds(layer);
		if (!target || !bounds) return;
		const t = layer.transform;
		const pivot = transformPivot(layer, bounds.center);
		target.translate(t.x + pivot.x, t.y + pivot.y);
		target.rotate((t.rotation * Math.PI) / 180);
		target.scale(t.scaleX, t.scaleY);
		target.translate(-pivot.x, -pivot.y);
	}

	function transformPivot(layer: Layer, fallback: Point): Point {
		return {
			x: layer.transform.pivotX ?? fallback.x,
			y: layer.transform.pivotY ?? fallback.y
		};
	}

	function stabilizeTransformPivot(layer: Layer) {
		if (layer.transform.pivotX !== undefined && layer.transform.pivotY !== undefined) return;
		const bounds = layerBounds(layer);
		if (!bounds) return;
		layer.transform.pivotX = bounds.center.x;
		layer.transform.pivotY = bounds.center.y;
	}

	function transformPoint(point: Point, layer = activeLayer): Point {
		const bounds = layerBounds(layer);
		if (!bounds) return point;
		const t = layer.transform,
			angle = (t.rotation * Math.PI) / 180;
		const pivot = transformPivot(layer, bounds.center);
		const x = (point.x - pivot.x) * t.scaleX;
		const y = (point.y - pivot.y) * t.scaleY;
		return {
			x: pivot.x + t.x + x * Math.cos(angle) - y * Math.sin(angle),
			y: pivot.y + t.y + x * Math.sin(angle) + y * Math.cos(angle)
		};
	}

	function inverseTransformPoint(point: Point, layer = activeLayer): Point {
		const bounds = layerBounds(layer);
		if (!bounds) return point;
		const t = layer.transform,
			angle = (-t.rotation * Math.PI) / 180;
		const pivot = transformPivot(layer, bounds.center);
		const x = point.x - pivot.x - t.x,
			y = point.y - pivot.y - t.y;
		return {
			x: pivot.x + (x * Math.cos(angle) - y * Math.sin(angle)) / t.scaleX,
			y: pivot.y + (x * Math.sin(angle) + y * Math.cos(angle)) / t.scaleY
		};
	}

	function inversePointWithTransform(point: Point, transform: LayerTransform, pivot: Point): Point {
		const angle = (-transform.rotation * Math.PI) / 180;
		const x = point.x - pivot.x - transform.x;
		const y = point.y - pivot.y - transform.y;
		return {
			x: pivot.x + (x * Math.cos(angle) - y * Math.sin(angle)) / transform.scaleX,
			y: pivot.y + (x * Math.sin(angle) + y * Math.cos(angle)) / transform.scaleY
		};
	}

	function transformHandles(bounds: NonNullable<ReturnType<typeof layerBounds>>) {
		const centerX = (bounds.minX + bounds.maxX) / 2;
		const centerY = (bounds.minY + bounds.maxY) / 2;
		return [
			{ x: -1 as const, y: -1 as const, point: transformPoint({ x: bounds.minX, y: bounds.minY }) },
			{ x: 0 as const, y: -1 as const, point: transformPoint({ x: centerX, y: bounds.minY }) },
			{ x: 1 as const, y: -1 as const, point: transformPoint({ x: bounds.maxX, y: bounds.minY }) },
			{ x: 1 as const, y: 0 as const, point: transformPoint({ x: bounds.maxX, y: centerY }) },
			{ x: 1 as const, y: 1 as const, point: transformPoint({ x: bounds.maxX, y: bounds.maxY }) },
			{ x: 0 as const, y: 1 as const, point: transformPoint({ x: centerX, y: bounds.maxY }) },
			{ x: -1 as const, y: 1 as const, point: transformPoint({ x: bounds.minX, y: bounds.maxY }) },
			{ x: -1 as const, y: 0 as const, point: transformPoint({ x: bounds.minX, y: centerY }) }
		];
	}

	function drawTransformControls() {
		if (!context || !activeLayer.visible) return;
		const bounds = layerBounds(activeLayer);
		if (!bounds) return;
		const handles = transformHandles(bounds);
		const corners = [handles[0].point, handles[2].point, handles[4].point, handles[6].point];
		const top = { x: (corners[0].x + corners[1].x) / 2, y: (corners[0].y + corners[1].y) / 2 };
		const center = transformPoint(bounds.center);
		const length = Math.hypot(top.x - center.x, top.y - center.y) || 1;
		const rotate = {
			x: top.x + ((top.x - center.x) / length) * 28,
			y: top.y + ((top.y - center.y) / length) * 28
		};
		context.save();
		context.globalAlpha = 1;
		context.strokeStyle = '#2563eb';
		context.fillStyle = '#fff';
		context.lineWidth = 1.5;
		context.beginPath();
		context.moveTo(corners[0].x, corners[0].y);
		for (let i = 1; i < 4; i++) context.lineTo(corners[i].x, corners[i].y);
		context.closePath();
		context.stroke();
		context.beginPath();
		context.moveTo(top.x, top.y);
		context.lineTo(rotate.x, rotate.y);
		context.stroke();
		for (const handle of handles) {
			const point = handle.point;
			context.beginPath();
			if (handle.x === 0 || handle.y === 0) context.rect(point.x - 5, point.y - 5, 10, 10);
			else context.arc(point.x, point.y, 5, 0, Math.PI * 2);
			context.fill();
			context.stroke();
		}
		for (const point of [rotate]) {
			context.beginPath();
			context.arc(point.x, point.y, 6, 0, Math.PI * 2);
			context.fill();
			context.stroke();
		}
		context.restore();
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

	function screenToWorld(point: Point): Point {
		const x = (point.x - camera.x) / camera.zoom;
		const y = (point.y - camera.y) / camera.zoom;
		const cosine = Math.cos(camera.rotation), sine = Math.sin(camera.rotation);
		return { x: x * cosine + y * sine, y: -x * sine + y * cosine };
	}

	function placeWorldPointAtScreen(world: Point, screen: Point, zoom = camera.zoom, rotation = camera.rotation) {
		const cosine = Math.cos(rotation), sine = Math.sin(rotation);
		camera.x = screen.x - (world.x * cosine - world.y * sine) * zoom;
		camera.y = screen.y - (world.x * sine + world.y * cosine) * zoom;
	}

	function localPosition(event: PointerEvent) {
		return inverseTransformPoint(screenToWorld(position(event)));
	}

	function touchMidpoint() {
		const [a, b] = [...touchPoints.values()];
		return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
	}

	function touchDistance() {
		const [a, b] = [...touchPoints.values()];
		return Math.hypot(b.x - a.x, b.y - a.y);
	}

	function touchAngle() {
		const [a, b] = [...touchPoints.values()];
		return Math.atan2(b.y - a.y, b.x - a.x);
	}

	function cancelCanvasInteraction() {
		activeStroke = null;
		isDrawing = false;
		panGesture = null;
		if (transformGesture) activeLayer.transform = copyTransform(transformGesture.before);
		transformGesture = null;
	}

	function beginPinch() {
		cancelCanvasInteraction();
		buildPinchCache();
		multiTouchActive = true;
		const midpoint = touchMidpoint();
		pinchGesture = {
			distance: Math.max(1, touchDistance()),
			worldMidpoint: screenToWorld(midpoint),
			zoom: camera.zoom
			,angle: touchAngle(),
			rotation: camera.rotation
		};
		redraw();
	}

	function buildPinchCache() {
		const bounds = artworkBounds();
		if (!bounds) {
			pinchCache = null;
			return;
		}
		const width = Math.max(1, bounds.maxX - bounds.minX);
		const height = Math.max(1, bounds.maxY - bounds.minY);
		const desiredScale = Math.max(0.25, camera.zoom * (window.devicePixelRatio || 1));
		const scale = Math.min(desiredScale, 4096 / width, 4096 / height, Math.sqrt(8_000_000 / (width * height)));
		const cachedCanvas = document.createElement('canvas');
		cachedCanvas.width = Math.max(1, Math.ceil(width * scale));
		cachedCanvas.height = Math.max(1, Math.ceil(height * scale));
		renderExport(cachedCanvas, { x: bounds.minX, y: bounds.minY }, scale);
		pinchCache = { canvas: cachedCanvas, origin: { x: bounds.minX, y: bounds.minY }, scale };
	}

	function startDrawing(event: PointerEvent) {
		const pressPoint = position(event);
		const now = performance.now();
		if (touchPoints.size === 0 && lastCanvasPress && now - lastCanvasPress.time < 320 && Math.hypot(pressPoint.x - lastCanvasPress.point.x, pressPoint.y - lastCanvasPress.point.y) < 28) {
			lastCanvasPress = null;
			const lastStroke = activeLayer.strokes[activeLayer.strokes.length - 1];
			const lastHistory = globalUndo[globalUndo.length - 1];
			if (lastStroke?.points.length <= 2 && lastHistory?.kind === 'stroke' && lastHistory.strokeId === lastStroke.id) {
				activeLayer.strokes.pop();
				globalUndo.pop();
			}
			openRadialMenu(event);
			return;
		}
		lastCanvasPress = { time: now, point: pressPoint };
		if (event.pointerType === 'touch') {
			touchPoints.set(event.pointerId, position(event));
			canvas.setPointerCapture(event.pointerId);
			if (touchPoints.size >= 2) {
				beginPinch();
				return;
			}
			if (multiTouchActive) return;
		}
		if (tool === 'pan') {
			if (event.button !== 0 && event.pointerType === 'mouse') return;
			canvas.setPointerCapture(event.pointerId);
			panGesture = { pointerId: event.pointerId, start: position(event), x: camera.x, y: camera.y };
			return;
		}
		if (tool === 'transform') {
			startTransform(event);
			return;
		}
		if (activeLayer.locked) return;
		if (event.button !== 0 && event.pointerType === 'mouse') return;
		stabilizeTransformPivot(activeLayer);
		if (!activeLayer.visible) activeLayer.visible = true;
		canvas.setPointerCapture(event.pointerId);
		isDrawing = true;
		activeStroke = {
			id: nextStrokeId++,
			points: [localPosition(event)],
			color,
			size: brushSize,
			smoothing: smoothingSteps,
			taper
		};
		redraw();
	}

	function draw(event: PointerEvent) {
		if (event.pointerType === 'touch' && touchPoints.has(event.pointerId)) {
			touchPoints.set(event.pointerId, position(event));
			if (pinchGesture && touchPoints.size >= 2) {
				const midpoint = touchMidpoint();
				const nextZoom = Math.min(
					8,
					Math.max(0.08, pinchGesture.zoom * (touchDistance() / pinchGesture.distance))
				);
				const nextRotation = pinchGesture.rotation + touchAngle() - pinchGesture.angle;
				camera.zoom = nextZoom;
				camera.rotation = nextRotation;
				placeWorldPointAtScreen(pinchGesture.worldMidpoint, midpoint, nextZoom, nextRotation);
				redraw();
				return;
			}
			if (multiTouchActive) return;
		}
		if (panGesture && event.pointerId === panGesture.pointerId) {
			const point = position(event);
			camera.x = panGesture.x + point.x - panGesture.start.x;
			camera.y = panGesture.y + point.y - panGesture.start.y;
			redraw();
			return;
		}
		if (transformGesture) {
			updateTransform(event);
			return;
		}
		if (!isDrawing || !activeStroke) return;
		const events = event.getCoalescedEvents?.() ?? [event];
		for (const sample of events) activeStroke.points.push(localPosition(sample));
		redraw();
	}

	function stopDrawing(event?: PointerEvent) {
		if (event?.pointerType === 'touch') {
			touchPoints.delete(event.pointerId);
			if (multiTouchActive) {
				pinchGesture = null;
				if (touchPoints.size === 0) {
					multiTouchActive = false;
					pinchCache = null;
					redraw();
				}
				if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
				return;
			}
		}
		if (panGesture) {
			if (event && canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
			panGesture = null;
			return;
		}
		if (transformGesture) {
			finishTransform(event);
			return;
		}
		if (!isDrawing || !activeStroke) return;
		if (event && canvas.hasPointerCapture(event.pointerId))
			canvas.releasePointerCapture(event.pointerId);
		activeLayer.strokes.push(activeStroke);
		globalUndo.push({
			kind: 'stroke',
			layerId: activeLayer.id,
			strokeId: activeStroke.id,
			stroke: activeStroke
		});
		globalRedo.length = 0;
		activeStroke = null;
		isDrawing = false;
	}

	function startTransform(event: PointerEvent) {
		if (event.button !== 0 && event.pointerType === 'mouse') return;
		const bounds = layerBounds(activeLayer);
		if (!bounds) return;
		stabilizeTransformPivot(activeLayer);
		const point = screenToWorld(position(event)),
			local = inverseTransformPoint(point);
		const center = transformPoint(bounds.center);
		const handles = transformHandles(bounds);
		const top = transformPoint({ x: (bounds.minX + bounds.maxX) / 2, y: bounds.minY });
		const topDistance = Math.hypot(top.x - center.x, top.y - center.y) || 1;
		const rotate = {
			x: top.x + ((top.x - center.x) / topDistance) * 28,
			y: top.y + ((top.y - center.y) / topDistance) * 28
		};
		let kind: TransformGesture['kind'] | null = null;
		let selectedHandle: TransformGesture['handle'];
		if (Math.hypot(point.x - rotate.x, point.y - rotate.y) <= 12) kind = 'rotate';
		else {
			const hit = handles.find((handle) => Math.hypot(point.x - handle.point.x, point.y - handle.point.y) <= 14);
			if (hit) {
				kind = 'scale';
				selectedHandle = { x: hit.x, y: hit.y };
			}
		}
		if (!kind &&
			local.x >= bounds.minX &&
			local.x <= bounds.maxX &&
			local.y >= bounds.minY &&
			local.y <= bounds.maxY
		)
			kind = 'move';
		if (!kind) return;
		canvas.setPointerCapture(event.pointerId);
		transformGesture = {
			kind,
			pointerId: event.pointerId,
			start: point,
			center,
			before: copyTransform(activeLayer.transform),
			handle: selectedHandle,
			bounds
		};
	}

	function updateTransform(event: PointerEvent) {
		const gesture = transformGesture;
		if (!gesture || event.pointerId !== gesture.pointerId) return;
		const point = screenToWorld(position(event)),
			before = gesture.before;
		if (gesture.kind === 'move') {
			activeLayer.transform.x = before.x + point.x - gesture.start.x;
			activeLayer.transform.y = before.y + point.y - gesture.start.y;
		} else if (gesture.kind === 'rotate') {
			const start = Math.atan2(
				gesture.start.y - gesture.center.y,
				gesture.start.x - gesture.center.x
			);
			const current = Math.atan2(point.y - gesture.center.y, point.x - gesture.center.x);
			activeLayer.transform.rotation = before.rotation + ((current - start) * 180) / Math.PI;
		} else if (gesture.handle && gesture.bounds) {
			const bounds = gesture.bounds;
			const pivot = transformPivot(activeLayer, bounds.center);
			const local = inversePointWithTransform(point, before, pivot);
			const fromCenter = event.altKey;
			let scaleX = before.scaleX;
			let scaleY = before.scaleY;
			const anchor = { x: bounds.center.x, y: bounds.center.y };

			if (gesture.handle.x) {
				const edge = gesture.handle.x < 0 ? bounds.minX : bounds.maxX;
				anchor.x = fromCenter ? bounds.center.x : gesture.handle.x < 0 ? bounds.maxX : bounds.minX;
				const ratio = (local.x - anchor.x) / (edge - anchor.x);
				scaleX = before.scaleX * Math.max(0.05, ratio);
			}
			if (gesture.handle.y) {
				const edge = gesture.handle.y < 0 ? bounds.minY : bounds.maxY;
				anchor.y = fromCenter ? bounds.center.y : gesture.handle.y < 0 ? bounds.maxY : bounds.minY;
				const ratio = (local.y - anchor.y) / (edge - anchor.y);
				scaleY = before.scaleY * Math.max(0.05, ratio);
			}

			const angle = (before.rotation * Math.PI) / 180;
			const offsetX = (before.scaleX - scaleX) * (anchor.x - pivot.x);
			const offsetY = (before.scaleY - scaleY) * (anchor.y - pivot.y);
			activeLayer.transform.scaleX = scaleX;
			activeLayer.transform.scaleY = scaleY;
			activeLayer.transform.x = before.x + offsetX * Math.cos(angle) - offsetY * Math.sin(angle);
			activeLayer.transform.y = before.y + offsetX * Math.sin(angle) + offsetY * Math.cos(angle);
		}
		redraw();
	}

	function zoomCanvas(event: WheelEvent) {
		event.preventDefault();
		const rect = canvas.getBoundingClientRect();
		const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
		const world = screenToWorld(point);
		const next = Math.min(8, Math.max(0.08, camera.zoom * Math.exp(-event.deltaY * 0.0015)));
		camera.zoom = next;
		placeWorldPointAtScreen(world, point, next);
		redraw();
	}

	function rotateView() {
		const screenCenter = { x: canvasWidth / 2, y: canvasHeight / 2 };
		const worldCenter = screenToWorld(screenCenter);
		camera.rotation += Math.PI / 12;
		placeWorldPointAtScreen(worldCenter, screenCenter);
		redraw();
	}

	function resetView() {
		camera.x = 0;
		camera.y = 0;
		camera.zoom = 1;
		camera.rotation = 0;
		redraw();
	}

	function openRadialMenu(event: MouseEvent) {
		event.preventDefault();
		cancelCanvasInteraction();
		const rect = canvas.getBoundingClientRect();
		radialMenu = { x: event.clientX - rect.left, y: event.clientY - rect.top };
		redraw();
	}

	function runRadialAction(action: string) {
		radialMenu = null;
		if (action === 'Draw') tool = 'draw';
		else if (action === 'Transform') tool = 'transform';
		else if (action === 'Pan') tool = 'pan';
		else if (action === 'Undo') undo();
		else if (action === 'Redo') redo();
		else if (action === 'Reset view') resetView();
		else if (action === 'Toggle grid') gridVisible = !gridVisible;
		else if (action === 'Clear') clearCanvas();
	}

	function finishTransform(event?: PointerEvent) {
		const gesture = transformGesture;
		if (!gesture) return;
		if (event && canvas.hasPointerCapture(event.pointerId))
			canvas.releasePointerCapture(event.pointerId);
		const after = copyTransform(activeLayer.transform);
		if (JSON.stringify(gesture.before) !== JSON.stringify(after)) {
			globalUndo.push({
				kind: 'transform',
				layerId: activeLayer.id,
				before: gesture.before,
				after
			});
			globalRedo.length = 0;
		}
		transformGesture = null;
		redraw();
	}

	function undo() {
		const index = globalHistory
			? globalUndo.length - 1
			: globalUndo.findLastIndex((entry) => entry.layerId === activeLayerId);
		if (index < 0) return;
		const [entry] = globalUndo.splice(index, 1);
		const layer = layers.find((candidate) => candidate.id === entry.layerId);
		if (!layer) return;
		if (entry.kind === 'stroke') {
			const strokeIndex = layer.strokes.findIndex((stroke) => stroke.id === entry.strokeId);
			if (strokeIndex >= 0) layer.strokes.splice(strokeIndex, 1);
		} else layer.transform = copyTransform(entry.before);
		globalRedo.push(entry);
		redraw();
	}

	function redo() {
		const index = globalHistory
			? globalRedo.length - 1
			: globalRedo.findLastIndex((entry) => entry.layerId === activeLayerId);
		if (index < 0) return;
		const [entry] = globalRedo.splice(index, 1);
		const layer = layers.find((candidate) => candidate.id === entry.layerId);
		if (!layer) return;
		if (entry.kind === 'stroke') layer.strokes.push(entry.stroke);
		else layer.transform = copyTransform(entry.after);
		globalUndo.push(entry);
		redraw();
	}

	function clearCanvas() {
		if (activeLayer.locked || activeLayer.strokes.length === 0) return;
		activeLayer.strokes.length = 0;
		globalUndo = globalUndo.filter((entry) => entry.layerId !== activeLayer.id);
		globalRedo = globalRedo.filter((entry) => entry.layerId !== activeLayer.id);
		redraw();
	}

	function addLayer() {
		const id = nextLayerId++;
		layers.push({
			id,
			name: `Layer ${nextLayerId - 1}`,
			visible: true,
			locked: false,
			opacity: 1,
			strokes: [],
			transform: identityTransform()
		});
		activeLayerId = id;
	}

	function importImage(files: FileList | null) {
		const file = files?.[0];
		if (!file) return;
		const src = URL.createObjectURL(file);
		const element = new Image();
		element.onload = () => {
			const center = screenToWorld({ x: canvasWidth / 2, y: canvasHeight / 2 });
			const fit = Math.min(1, (canvasWidth * 0.7) / element.naturalWidth, (canvasHeight * 0.7) / element.naturalHeight) / camera.zoom;
			const width = element.naturalWidth * fit;
			const height = element.naturalHeight * fit;
			const id = nextLayerId++;
			layers.push({
				id,
				name: file.name.replace(/\.[^.]+$/, '') || `Image ${id}`,
				visible: true,
				locked: true,
				opacity: 1,
				strokes: [],
				image: { element, src, x: center.x - width / 2, y: center.y - height / 2, width, height },
				transform: identityTransform()
			});
			activeLayerId = id;
			tool = 'transform';
			redraw();
		};
		element.onerror = () => URL.revokeObjectURL(src);
		element.src = src;
	}

	function layerWorldBounds(layer: Layer) {
		const bounds = layerBounds(layer);
		if (!bounds) return null;
		const corners = [
			transformPoint({ x: bounds.minX, y: bounds.minY }, layer),
			transformPoint({ x: bounds.maxX, y: bounds.minY }, layer),
			transformPoint({ x: bounds.maxX, y: bounds.maxY }, layer),
			transformPoint({ x: bounds.minX, y: bounds.maxY }, layer)
		];
		return {
			minX: Math.min(...corners.map((p) => p.x)), minY: Math.min(...corners.map((p) => p.y)),
			maxX: Math.max(...corners.map((p) => p.x)), maxY: Math.max(...corners.map((p) => p.y))
		};
	}

	function drawLayerTo(target: CanvasRenderingContext2D, layer: Layer) {
		if (!layer.visible) return;
		target.save();
		target.globalAlpha = layer.opacity;
		applyLayerTransform(layer, target);
		if (layer.image) target.drawImage(layer.image.element, layer.image.x, layer.image.y, layer.image.width, layer.image.height);
		for (const stroke of layer.strokes) drawStroke(stroke, target);
		target.restore();
	}

	function mergeDown() {
		const topIndex = layers.findIndex((layer) => layer.id === activeLayerId);
		if (topIndex <= 0) return;
		const bottom = layers[topIndex - 1], top = layers[topIndex];
		const boundsList = [layerWorldBounds(bottom), layerWorldBounds(top)].filter((value) => value !== null);
		if (!boundsList.length) return;
		const minX = Math.floor(Math.min(...boundsList.map((b) => b.minX)) - 2);
		const minY = Math.floor(Math.min(...boundsList.map((b) => b.minY)) - 2);
		const maxX = Math.ceil(Math.max(...boundsList.map((b) => b.maxX)) + 2);
		const maxY = Math.ceil(Math.max(...boundsList.map((b) => b.maxY)) + 2);
		const mergedCanvas = document.createElement('canvas');
		mergedCanvas.width = Math.max(1, maxX - minX);
		mergedCanvas.height = Math.max(1, maxY - minY);
		const mergedContext = mergedCanvas.getContext('2d');
		if (!mergedContext) return;
		mergedContext.translate(-minX, -minY);
		drawLayerTo(mergedContext, bottom);
		drawLayerTo(mergedContext, top);
		const element = new Image();
		const src = mergedCanvas.toDataURL('image/png');
		element.onload = () => {
			const merged: Layer = { id: bottom.id, name: `${bottom.name} + ${top.name}`, visible: true, locked: bottom.locked || top.locked, opacity: 1, strokes: [], image: { element, src, x: minX, y: minY, width: mergedCanvas.width, height: mergedCanvas.height }, transform: identityTransform() };
			layers.splice(topIndex - 1, 2, merged);
			activeLayerId = merged.id;
			globalUndo = globalUndo.filter((entry) => entry.layerId !== bottom.id && entry.layerId !== top.id);
			globalRedo = globalRedo.filter((entry) => entry.layerId !== bottom.id && entry.layerId !== top.id);
			redraw();
		};
		element.src = src;
	}

	function resetTransform() {
		const before = copyTransform(activeLayer.transform),
			after = identityTransform();
		if (JSON.stringify(before) === JSON.stringify(after)) return;
		activeLayer.transform = after;
		globalUndo.push({
			kind: 'transform',
			layerId: activeLayer.id,
			before,
			after: copyTransform(after)
		});
		globalRedo.length = 0;
		redraw();
	}

	function removeLayer(id: number) {
		if (layers.length === 1) return;
		const index = layers.findIndex((layer) => layer.id === id);
		if (index < 0) return;
		layers.splice(index, 1);
		globalUndo = globalUndo.filter((entry) => entry.layerId !== id);
		globalRedo = globalRedo.filter((entry) => entry.layerId !== id);
		if (activeLayerId === id) activeLayerId = layers[Math.min(index, layers.length - 1)].id;
		redraw();
	}

	function toggleLayer(layer: Layer) {
		layer.visible = !layer.visible;
		redraw();
	}

	function toggleLayerLock(layer: Layer) {
		layer.locked = !layer.locked;
	}

	function moveLayer(id: number, direction: -1 | 1) {
		const index = layers.findIndex((layer) => layer.id === id);
		const destination = index + direction;
		if (index < 0 || destination < 0 || destination >= layers.length) return;
		const [layer] = layers.splice(index, 1);
		layers.splice(destination, 0, layer);
		redraw();
	}

	function artworkBounds() {
		const points: Point[] = [];
		for (const layer of layers) {
			if (!layer.visible) continue;
			const bounds = layerBounds(layer);
			if (!bounds) continue;
			for (const point of [
				{ x: bounds.minX, y: bounds.minY },
				{ x: bounds.maxX, y: bounds.minY },
				{ x: bounds.maxX, y: bounds.maxY },
				{ x: bounds.minX, y: bounds.maxY }
			]) points.push(transformPoint(point, layer));
		}
		if (!points.length) return null;
		const padding = 24;
		return {
			minX: Math.min(...points.map((p) => p.x)) - padding,
			minY: Math.min(...points.map((p) => p.y)) - padding,
			maxX: Math.max(...points.map((p) => p.x)) + padding,
			maxY: Math.max(...points.map((p) => p.y)) + padding
		};
	}

	function renderExport(target: HTMLCanvasElement, origin: Point, scale: number, limit = Infinity) {
		const targetContext = target.getContext('2d');
		if (!targetContext) return;
		targetContext.clearRect(0, 0, target.width, target.height);
		targetContext.save();
		targetContext.scale(scale, scale);
		targetContext.translate(-origin.x, -origin.y);
		let count = 0;
		for (const layer of layers) {
			if (!layer.visible) continue;
			targetContext.save();
			targetContext.globalAlpha = layer.opacity;
			applyLayerTransform(layer, targetContext);
			if (layer.image) targetContext.drawImage(layer.image.element, layer.image.x, layer.image.y, layer.image.width, layer.image.height);
			for (const stroke of layer.strokes) {
				if (count++ >= limit) break;
				drawStroke(stroke, targetContext);
			}
			targetContext.restore();
		}
		targetContext.restore();
	}

	function download(blob: Blob, filename: string) {
		const link = document.createElement('a');
		link.href = URL.createObjectURL(blob);
		link.download = filename;
		link.click();
		setTimeout(() => URL.revokeObjectURL(link.href), 1000);
	}

	function savePng(target: HTMLCanvasElement, filename: string) {
		target.toBlob((blob) => blob && download(blob, filename), 'image/png');
	}

	function exportViewport() {
		const output = document.createElement('canvas');
		output.width = Math.max(1, Math.round(canvasWidth));
		output.height = Math.max(1, Math.round(canvasHeight));
		const outputContext = output.getContext('2d');
		if (!outputContext) return;
		outputContext.translate(camera.x, camera.y);
		outputContext.rotate(camera.rotation);
		outputContext.scale(camera.zoom, camera.zoom);
		for (const layer of layers) drawLayerTo(outputContext, layer);
		savePng(output, 'canvas-view.png');
	}

	function exportAll() {
		const bounds = artworkBounds();
		if (!bounds) return;
		const output = document.createElement('canvas');
		output.width = Math.max(1, Math.ceil(bounds.maxX - bounds.minX));
		output.height = Math.max(1, Math.ceil(bounds.maxY - bounds.minY));
		renderExport(output, { x: bounds.minX, y: bounds.minY }, 1);
		savePng(output, 'canvas-all.png');
	}

	async function exportAnimation() {
		const bounds = artworkBounds();
		const strokeCount = layers.reduce((sum, layer) => sum + (layer.visible ? layer.strokes.length : 0), 0);
		if (!bounds || !strokeCount || !('MediaRecorder' in window)) return;
		const output = document.createElement('canvas');
		const maxDimension = 1920;
		const scale = Math.min(1, maxDimension / Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY));
		output.width = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) * scale));
		output.height = Math.max(1, Math.ceil((bounds.maxY - bounds.minY) * scale));
		const stream = output.captureStream(30);
		const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
		const chunks: Blob[] = [];
		recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
		const finished = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
		recorder.start();
		for (let frame = 0; frame <= strokeCount; frame++) {
			renderExport(output, { x: bounds.minX, y: bounds.minY }, scale, frame);
			await new Promise((resolve) => setTimeout(resolve, Math.max(35, 2000 / strokeCount)));
		}
		await new Promise((resolve) => setTimeout(resolve, 350));
		recorder.stop();
		await finished;
		download(new Blob(chunks, { type: 'video/webm' }), 'canvas-animation.webm');
	}

	function handleKeydown(event: KeyboardEvent) {
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && event.shiftKey) {
			event.preventDefault();
			redo();
		} else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
			event.preventDefault();
			undo();
		} else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') {
			event.preventDefault();
			redo();
		}
	}

	onMount(() => {
		const observer = new ResizeObserver(resizeCanvas);
		observer.observe(canvas);
		resizeCanvas();
		return () => observer.disconnect();
	});

	$effect(() => {
		tool;
		activeLayerId;
		gridVisible;
		redraw();
	});
</script>

<svelte:head>
	<title>Canvas — Draw freely</title>
	<meta name="description" content="A simple, focused drawing canvas." />
</svelte:head>

<svelte:window onkeydown={handleKeydown} />

<main>
	<section class="workspace w-full" aria-label="Drawing workspace">
		<DrawingToolbar
			{colors}
			bind:color
			bind:brushSize
			bind:smoothingSteps
			bind:taper
			bind:globalHistory
			bind:tool
			bind:gridVisible
			bind:radialSlots
			{activeLayer}
			{canUndo}
			{canRedo}
			onundo={undo}
			onredo={redo}
			onclear={clearCanvas}
			onexportview={exportViewport}
			onexportall={exportAll}
			onexportanimation={exportAnimation}
			onrotateview={rotateView}
			onresetview={resetView}
		/>
		<LayersPanel
			{layers}
			bind:activeLayerId
			{activeLayer}
			onadd={addLayer}
			onimport={importImage}
			onmerge={mergeDown}
			onlock={toggleLayerLock}
			onremove={removeLayer}
			ontoggle={toggleLayer}
			onmove={moveLayer}
			onopacitychange={redraw}
			onresettransform={resetTransform}
		/>
			<DrawingCanvas
			bind:canvas
			{tool}
			onwheel={zoomCanvas}
			onpointerdown={startDrawing}
			onpointermove={draw}
			onpointerup={stopDrawing}
			ondoublepress={openRadialMenu}
		/>
		{#if radialMenu}
			<div class="radial-menu" style:left={`${radialMenu.x}px`} style:top={`${radialMenu.y}px`} role="menu">
				<button class="radial-close" onclick={() => (radialMenu = null)} aria-label="Close quick menu">×</button>
				{#each radialSlots as action, index}
					<button class="radial-action" style:--slot={index} onclick={() => runRadialAction(action)}>{action}</button>
				{/each}
			</div>
		{/if}
	</section>
</main>
