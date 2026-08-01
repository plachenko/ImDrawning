<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import DrawingCanvas from '$lib/drawing/DrawingCanvas.svelte';
	import DrawingToolbar from '$lib/drawing/DrawingToolbar.svelte';
	import LayersPanel from '$lib/drawing/LayersPanel.svelte';
	import CollaborationPanel from '$lib/drawing/CollaborationPanel.svelte';
	import type { CollaborationUser } from '$lib/drawing/CollaborationPanel.svelte';
	import type { Layer, LayerTransform, Point, Stroke } from '$lib/drawing/types';
	type HistoryEntry =
		| { kind: 'stroke'; layerId: number; strokeId: number; stroke: Stroke }
		| { kind: 'transform'; layerId: number; before: LayerTransform; after: LayerTransform }
		| {
				kind: 'edit';
				layerId: number;
				strokeId: number;
				before: Point[];
				after: Point[];
				beforeShape?: Stroke['shape'];
				afterShape?: Stroke['shape'];
		  };
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
	let overlayCanvas = $state<HTMLCanvasElement>(null!);
	let collaborationPanel: CollaborationPanel;
	let remoteLayerIds = new Map<string, number>();
	let remoteCursors = $state<
		Record<string, CollaborationUser & { x: number; y: number; visible: boolean }>
	>({});
	let context: CanvasRenderingContext2D | null = null;
	let overlayContext: CanvasRenderingContext2D | null = null;
	let strokePreviewFrame = 0;
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
	let canvasWidth = $state(0);
	let canvasHeight = $state(0);
	let tool = $state<'draw' | 'edit' | 'transform' | 'pan'>('draw');
	let shape = $state<'freehand' | 'line' | 'rectangle' | 'ellipse' | 'bezier'>('freehand');
	let selectedStrokeId = $state<number | null>(null);
	let editGesture: {
		pointerId: number;
		stroke: Stroke;
		mode: 'handle' | 'bend-line';
		handle: number;
		bendT?: number;
		before: Point[];
		beforeShape?: Stroke['shape'];
	} | null = null;
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
	let layerPinchGesture: {
		distance: number;
		angle: number;
		worldMidpoint: Point;
		before: LayerTransform;
	} | null = null;
	let multiTouchActive = false;
	let pinchCache: { canvas: HTMLCanvasElement; origin: Point; scale: number } | null = null;
	let transformGesture: TransformGesture | null = null;
	let layerTransformCache: {
		canvas: HTMLCanvasElement;
		origin: Point;
		scale: number;
		layerId: number;
	} | null = null;
	let transformSceneCache: HTMLCanvasElement | null = null;
	let transformPreviewFrame = 0;

	const colors = ['#171717', '#ef4444', '#f59e0b', '#16a34a', '#2563eb', '#7c3aed'];
	$effect(() => {
		tool;
		untrack(() => {
			if (context) redraw(false);
		});
	});
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
		target.save();
		target.fillStyle = stroke.color;
		const strokeShape = stroke.shape ?? 'freehand';

		if (strokeShape !== 'freehand' && stroke.points.length > 1) {
			const start = stroke.points[0];
			const end = stroke.points[stroke.points.length - 1];
			target.beginPath();
			if (strokeShape === 'bezier' && stroke.points.length >= 4) {
				target.moveTo(start.x, start.y);
				target.bezierCurveTo(
					stroke.points[1].x,
					stroke.points[1].y,
					stroke.points[2].x,
					stroke.points[2].y,
					stroke.points[3].x,
					stroke.points[3].y
				);
			} else if (strokeShape === 'line') {
				target.moveTo(start.x, start.y);
				target.lineTo(end.x, end.y);
			} else if (strokeShape === 'rectangle') {
				target.rect(start.x, start.y, end.x - start.x, end.y - start.y);
			} else {
				const centerX = (start.x + end.x) / 2;
				const centerY = (start.y + end.y) / 2;
				target.ellipse(
					centerX,
					centerY,
					Math.abs(end.x - start.x) / 2,
					Math.abs(end.y - start.y) / 2,
					0,
					0,
					Math.PI * 2
				);
			}
			target.strokeStyle = stroke.color;
			target.lineWidth = stroke.size;
			target.lineCap = 'round';
			target.lineJoin = 'round';
			target.stroke();
			target.restore();
			return;
		}

		if (stroke.points.length === 1) {
			const point = stroke.points[0];
			const radius = stroke.size / 2;
			target.beginPath();
			target.arc(point.x, point.y, radius, 0, Math.PI * 2);
			target.fill();
			target.restore();
			return;
		}

		type WidthPoint = Point & { width: number; distance: number };
		const samples: WidthPoint[] = [];
		const bridgedPoints: Point[] = [];
		const bridgeSpacing = Math.max(1, stroke.size * 0.4);
		for (const point of stroke.points) {
			const previous = bridgedPoints[bridgedPoints.length - 1];
			if (previous) {
				const gap = Math.hypot(point.x - previous.x, point.y - previous.y);
				const steps = Math.ceil(gap / bridgeSpacing);
				for (let step = 1; step < steps; step++) {
					const amount = step / steps;
					bridgedPoints.push({
						x: previous.x + (point.x - previous.x) * amount,
						y: previous.y + (point.y - previous.y) * amount,
						time:
							previous.time !== undefined && point.time !== undefined
								? previous.time + (point.time - previous.time) * amount
								: point.time
					});
				}
			}
			bridgedPoints.push(point);
		}
		for (const point of bridgedPoints) {
			const previous = samples[samples.length - 1];
			const segment = previous ? Math.hypot(point.x - previous.x, point.y - previous.y) : 0;
			if (previous && segment < 0.25) continue;
			samples.push({
				...point,
				width: stroke.size + Math.min(stroke.size * 0.9, Math.sqrt(segment) * 0.45),
				distance: (previous?.distance ?? 0) + segment
			});
		}
		if (samples.length === 1) samples.push({ ...samples[0] });

		// Smooth the resampled centerline before deriving its edges. Resampling first
		// lets the curve fill event gaps instead of cutting a straight, angular chord.
		const smoothing = Math.max(0, Math.min(12, stroke.smoothing ?? 0));
		const smoothingPasses = Math.ceil(smoothing / 3);
		const smoothingStrength = (smoothing / 12) * 0.65;
		for (let pass = 0; pass < smoothingPasses; pass++) {
			const positions = samples.map((sample, index) => {
				if (index === 0 || index === samples.length - 1) return sample;
				const before = samples[index - 1];
				const after = samples[index + 1];
				return {
					x: sample.x + ((before.x + after.x) / 2 - sample.x) * smoothingStrength,
					y: sample.y + ((before.y + after.y) / 2 - sample.y) * smoothingStrength
				};
			});
			for (let index = 1; index < samples.length - 1; index++) {
				samples[index].x = positions[index].x;
				samples[index].y = positions[index].y;
			}
		}
		samples[0].distance = 0;
		for (let index = 1; index < samples.length; index++) {
			samples[index].distance =
				samples[index - 1].distance +
				Math.hypot(
					samples[index].x - samples[index - 1].x,
					samples[index].y - samples[index - 1].y
				);
		}

		// Pointer events arrive at uneven intervals. Weighted passes remove those
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
		const tip = samples[samples.length - 1];
		const previousTip = samples[samples.length - 2];
		const elapsed = Math.max(1, (tip.time ?? 0) - (previousTip.time ?? 0));
		const velocity = Math.hypot(tip.x - previousTip.x, tip.y - previousTip.y) / elapsed;
		const sharpness = Math.max(0, Math.min(1, (velocity - 0.04) / 0.9));
		const tipLength = stroke.size * (0.65 + sharpness * 2.35);
		const baseDistance = Math.max(0, totalDistance - tipLength);
		const railSamples = samples.filter((sample) => sample.distance < baseDistance);
		const afterBase = samples.find((sample) => sample.distance >= baseDistance) ?? tip;
		const beforeBase = samples[Math.max(0, samples.indexOf(afterBase) - 1)];
		const baseSpan = afterBase.distance - beforeBase.distance;
		const baseAmount = baseSpan > 0 ? (baseDistance - beforeBase.distance) / baseSpan : 0;
		railSamples.push({
			x: beforeBase.x + (afterBase.x - beforeBase.x) * baseAmount,
			y: beforeBase.y + (afterBase.y - beforeBase.y) * baseAmount,
			width: beforeBase.width + (afterBase.width - beforeBase.width) * baseAmount,
			distance: baseDistance,
			time: beforeBase.time
		});

		const edge = (sample: WidthPoint, index: number, side: -1 | 1) => {
			const before = railSamples[Math.max(0, index - 1)];
			const after = railSamples[Math.min(railSamples.length - 1, index + 1)];
			const tangentX = after.x - before.x;
			const tangentY = after.y - before.y;
			const length = Math.hypot(tangentX, tangentY) || 1;
			const taperScale = taperDistance > 0 ? Math.min(1, sample.distance / taperDistance) : 1;
			// A diagonal calligraphic axis distributes ink according to direction.
			// Up-left motion biases the right side; down-right reverses that bias.
			const angleBias =
				Math.max(-1, Math.min(1, (-tangentX - tangentY) / (length * Math.SQRT2))) * 0.34;
			const sideWeight = 1 - side * angleBias;
			const radius = (sample.width / 2) * Math.max(0, taperScale) * sideWeight;
			return {
				x: sample.x + (-tangentY / length) * radius * side,
				y: sample.y + (tangentX / length) * radius * side
			};
		};
		// Faster motion moves the triangle's shoulders farther behind the pointer,
		// producing a longer, sharper brush tip while the polygon follows its base.
		const left = railSamples.map((sample, index) => edge(sample, index, 1));
		const right = railSamples.map((sample, index) => edge(sample, index, -1)).reverse();
		const outline = [...left, tip, ...right];
		target.beginPath();
		const first = outline[0];
		const last = outline[outline.length - 1];
		target.moveTo((last.x + first.x) / 2, (last.y + first.y) / 2);
		for (let index = 0; index < outline.length; index++) {
			const point = outline[index];
			const next = outline[(index + 1) % outline.length];
			target.quadraticCurveTo(point.x, point.y, (point.x + next.x) / 2, (point.y + next.y) / 2);
		}
		target.closePath();
		target.fill();
		target.restore();
	}

	function redraw(includeActiveStroke = true) {
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
				if (layerTransformCache?.layerId === layer.id) {
					context.restore();
					continue;
				} else if (layer.image)
					context.drawImage(
						layer.image.element,
						layer.image.x,
						layer.image.y,
						layer.image.width,
						layer.image.height
					);
				if (layerTransformCache?.layerId !== layer.id)
					for (const stroke of layer.strokes) drawStroke(stroke);
				if (includeActiveStroke && layer.id === activeLayerId && activeStroke)
					drawStroke(activeStroke);
				context.restore();
			}
		}
		context.globalAlpha = 1;
		if (tool === 'transform') drawTransformControls();
		if (tool === 'edit') drawEditControls();
		context.restore();
	}

	function editableStroke() {
		return activeLayer.strokes.find((stroke) => stroke.id === selectedStrokeId) ?? null;
	}

	function drawEditControls() {
		if (!context) return;
		const stroke = editableStroke();
		if (!stroke || (stroke.shape ?? 'freehand') === 'freehand') return;
		context.save();
		applyLayerTransform(activeLayer);
		context.lineWidth = 1.25 / camera.zoom;
		context.strokeStyle = '#2563eb';
		context.fillStyle = '#fff';
		if (stroke.shape === 'bezier' && stroke.points.length >= 4) {
			context.beginPath();
			context.moveTo(stroke.points[0].x, stroke.points[0].y);
			context.lineTo(stroke.points[1].x, stroke.points[1].y);
			context.moveTo(stroke.points[2].x, stroke.points[2].y);
			context.lineTo(stroke.points[3].x, stroke.points[3].y);
			context.stroke();
		}
		for (const point of stroke.points) {
			context.beginPath();
			context.arc(point.x, point.y, 5 / camera.zoom, 0, Math.PI * 2);
			context.fill();
			context.stroke();
		}
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
		overlayCanvas.width = canvas.width;
		overlayCanvas.height = canvas.height;
		context = canvas.getContext('2d');
		overlayContext = overlayCanvas.getContext('2d');
		context?.setTransform(dpr, 0, 0, dpr, 0, 0);
		overlayContext?.setTransform(dpr, 0, 0, dpr, 0, 0);
		configureContext();
		redraw();
	}

	function clearStrokePreview() {
		if (!overlayContext) return;
		overlayContext.clearRect(0, 0, canvasWidth, canvasHeight);
	}

	function predictedStroke(stroke: Stroke): Stroke {
		if ((stroke.shape ?? 'freehand') !== 'freehand' || stroke.points.length < 3) return stroke;

		const recent = stroke.points.slice(-6);
		let velocityX = 0;
		let velocityY = 0;
		let totalWeight = 0;
		let directionConfidence = 1;
		for (let index = 1; index < recent.length; index++) {
			const before = recent[index - 1];
			const point = recent[index];
			const elapsed = Math.max(1, (point.time ?? 0) - (before.time ?? 0));
			const segmentX = (point.x - before.x) / elapsed;
			const segmentY = (point.y - before.y) / elapsed;
			const weight = index * index;
			if (totalWeight > 0) {
				const oldLength = Math.hypot(velocityX, velocityY);
				const newLength = Math.hypot(segmentX, segmentY);
				if (oldLength > 0 && newLength > 0) {
					const alignment = (velocityX * segmentX + velocityY * segmentY) / (oldLength * newLength);
					directionConfidence = Math.min(directionConfidence, Math.max(0, alignment));
				}
			}
			velocityX += segmentX * weight;
			velocityY += segmentY * weight;
			totalWeight += weight;
		}
		if (!totalWeight) return stroke;

		velocityX /= totalWeight;
		velocityY /= totalWeight;
		const speed = Math.hypot(velocityX, velocityY);
		if (speed < 0.01) return stroke;

		// Look roughly one input frame ahead. Direction confidence shortens the
		// prediction while turning, and the screen-space cap prevents wild tails.
		const horizon = 18 * (0.25 + directionConfidence * 0.75);
		const distance = Math.min(speed * horizon, 24 / camera.zoom);
		const tip = recent[recent.length - 1];
		const unitX = velocityX / speed;
		const unitY = velocityY / speed;
		const predictedTip: Point = {
			x: tip.x + unitX * distance,
			y: tip.y + unitY * distance,
			time: (tip.time ?? 0) + horizon
		};
		return {
			...stroke,
			points: [
				...stroke.points,
				{
					x: tip.x + (predictedTip.x - tip.x) * 0.5,
					y: tip.y + (predictedTip.y - tip.y) * 0.5,
					time: (tip.time ?? 0) + horizon * 0.5
				},
				predictedTip
			]
		};
	}

	function renderStrokePreview() {
		strokePreviewFrame = 0;
		clearStrokePreview();
		if (!overlayContext || !activeStroke) return;
		overlayContext.save();
		overlayContext.translate(camera.x, camera.y);
		overlayContext.rotate(camera.rotation);
		overlayContext.scale(camera.zoom, camera.zoom);
		applyLayerTransform(activeLayer, overlayContext);
		overlayContext.globalAlpha = activeLayer.opacity;
		drawStroke(predictedStroke(activeStroke), overlayContext);
		overlayContext.restore();
	}

	function scheduleStrokePreview() {
		if (!strokePreviewFrame) strokePreviewFrame = requestAnimationFrame(renderStrokePreview);
	}

	function position(event: PointerEvent): Point {
		const rect = canvas.getBoundingClientRect();
		return { x: event.clientX - rect.left, y: event.clientY - rect.top };
	}

	function screenToWorld(point: Point): Point {
		const x = (point.x - camera.x) / camera.zoom;
		const y = (point.y - camera.y) / camera.zoom;
		const cosine = Math.cos(camera.rotation),
			sine = Math.sin(camera.rotation);
		return { x: x * cosine + y * sine, y: -x * sine + y * cosine };
	}

	function placeWorldPointAtScreen(
		world: Point,
		screen: Point,
		zoom = camera.zoom,
		rotation = camera.rotation
	) {
		const cosine = Math.cos(rotation),
			sine = Math.sin(rotation);
		camera.x = screen.x - (world.x * cosine - world.y * sine) * zoom;
		camera.y = screen.y - (world.x * sine + world.y * cosine) * zoom;
	}

	function localPosition(event: PointerEvent) {
		return { ...inverseTransformPoint(screenToWorld(position(event))), time: event.timeStamp };
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
		if (transformPreviewFrame) cancelAnimationFrame(transformPreviewFrame);
		transformPreviewFrame = 0;
		layerTransformCache = null;
		transformSceneCache = null;
	}

	function redrawTransformPreview() {
		if (!context || !layerTransformCache || !transformSceneCache) return;
		context.clearRect(0, 0, canvasWidth, canvasHeight);
		context.drawImage(transformSceneCache, 0, 0, canvasWidth, canvasHeight);
		context.save();
		context.translate(camera.x, camera.y);
		context.rotate(camera.rotation);
		context.scale(camera.zoom, camera.zoom);
		context.globalAlpha = activeLayer.opacity;
		applyLayerTransform(activeLayer);
		context.drawImage(
			layerTransformCache.canvas,
			layerTransformCache.origin.x,
			layerTransformCache.origin.y,
			layerTransformCache.canvas.width / layerTransformCache.scale,
			layerTransformCache.canvas.height / layerTransformCache.scale
		);
		context.restore();
	}

	function scheduleTransformPreview() {
		if (transformPreviewFrame) return;
		transformPreviewFrame = requestAnimationFrame(() => {
			transformPreviewFrame = 0;
			redrawTransformPreview();
		});
	}

	function buildLayerTransformCache() {
		const bounds = layerBounds(activeLayer);
		if (!bounds) return;
		const width = Math.max(1, bounds.maxX - bounds.minX);
		const height = Math.max(1, bounds.maxY - bounds.minY);
		const desiredScale = Math.max(1, camera.zoom * (window.devicePixelRatio || 1));
		const scale = Math.min(
			desiredScale,
			4096 / width,
			4096 / height,
			Math.sqrt(8_000_000 / (width * height))
		);
		const cachedCanvas = document.createElement('canvas');
		cachedCanvas.width = Math.max(1, Math.ceil(width * scale));
		cachedCanvas.height = Math.max(1, Math.ceil(height * scale));
		const cachedContext = cachedCanvas.getContext('2d');
		if (!cachedContext) return;
		cachedContext.scale(scale, scale);
		cachedContext.translate(-bounds.minX, -bounds.minY);
		if (activeLayer.image)
			cachedContext.drawImage(
				activeLayer.image.element,
				activeLayer.image.x,
				activeLayer.image.y,
				activeLayer.image.width,
				activeLayer.image.height
			);
		for (const stroke of activeLayer.strokes) drawStroke(stroke, cachedContext);
		layerTransformCache = {
			canvas: cachedCanvas,
			origin: { x: bounds.minX, y: bounds.minY },
			scale,
			layerId: activeLayer.id
		};
		// Freeze everything except the active layer. Pointer movement now composites
		// only this background bitmap and the layer bitmap.
		redraw();
		const scene = document.createElement('canvas');
		scene.width = canvas.width;
		scene.height = canvas.height;
		scene.getContext('2d')?.drawImage(canvas, 0, 0);
		transformSceneCache = scene;
		redrawTransformPreview();
	}

	function beginPinch() {
		cancelCanvasInteraction();
		buildPinchCache();
		multiTouchActive = true;
		const midpoint = touchMidpoint();
		pinchGesture = {
			distance: Math.max(1, touchDistance()),
			worldMidpoint: screenToWorld(midpoint),
			zoom: camera.zoom,
			angle: touchAngle(),
			rotation: camera.rotation
		};
		redraw();
	}

	function isNearActiveLayer(screenPoint: Point) {
		const bounds = layerBounds(activeLayer);
		if (!bounds || activeLayer.locked || !activeLayer.visible) return false;
		const center = transformPoint(bounds.center);
		const corners = [
			transformPoint({ x: bounds.minX, y: bounds.minY }),
			transformPoint({ x: bounds.maxX, y: bounds.minY }),
			transformPoint({ x: bounds.maxX, y: bounds.maxY }),
			transformPoint({ x: bounds.minX, y: bounds.maxY })
		];
		const objectRadius = Math.max(
			...corners.map((corner) => Math.hypot(corner.x - center.x, corner.y - center.y))
		);
		const point = screenToWorld(screenPoint);
		const touchRadius = 48 / camera.zoom;
		return Math.hypot(point.x - center.x, point.y - center.y) <= objectRadius + touchRadius;
	}

	function beginLayerPinch() {
		const midpoint = touchMidpoint();
		if (!isNearActiveLayer(midpoint)) return false;
		cancelCanvasInteraction();
		stabilizeTransformPivot(activeLayer);
		buildLayerTransformCache();
		multiTouchActive = true;
		layerPinchGesture = {
			distance: Math.max(1, touchDistance()),
			angle: touchAngle(),
			worldMidpoint: screenToWorld(midpoint),
			before: copyTransform(activeLayer.transform)
		};
		redrawTransformPreview();
		return true;
	}

	function commitLayerPinch() {
		if (!layerPinchGesture) return;
		const after = copyTransform(activeLayer.transform);
		if (JSON.stringify(layerPinchGesture.before) !== JSON.stringify(after)) {
			globalUndo.push({
				kind: 'transform',
				layerId: activeLayer.id,
				before: layerPinchGesture.before,
				after
			});
			globalRedo.length = 0;
		}
		layerPinchGesture = null;
		if (transformPreviewFrame) cancelAnimationFrame(transformPreviewFrame);
		transformPreviewFrame = 0;
		layerTransformCache = null;
		transformSceneCache = null;
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
		const scale = Math.min(
			desiredScale,
			4096 / width,
			4096 / height,
			Math.sqrt(8_000_000 / (width * height))
		);
		const cachedCanvas = document.createElement('canvas');
		cachedCanvas.width = Math.max(1, Math.ceil(width * scale));
		cachedCanvas.height = Math.max(1, Math.ceil(height * scale));
		renderExport(cachedCanvas, { x: bounds.minX, y: bounds.minY }, scale);
		pinchCache = { canvas: cachedCanvas, origin: { x: bounds.minX, y: bounds.minY }, scale };
	}

	function distanceToSegment(point: Point, start: Point, end: Point) {
		const dx = end.x - start.x;
		const dy = end.y - start.y;
		const lengthSquared = dx * dx + dy * dy;
		const amount = lengthSquared
			? Math.max(
					0,
					Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared)
				)
			: 0;
		return Math.hypot(point.x - (start.x + dx * amount), point.y - (start.y + dy * amount));
	}

	function strokeHitDistance(stroke: Stroke, point: Point) {
		const shapeType = stroke.shape ?? 'freehand';
		if (shapeType === 'freehand') return Infinity;
		const points: Point[] = [];
		const start = stroke.points[0];
		const end = stroke.points[stroke.points.length - 1];
		if (!start || !end) return Infinity;
		if (shapeType === 'line') points.push(start, end);
		else if (shapeType === 'rectangle')
			points.push(start, { x: end.x, y: start.y }, end, { x: start.x, y: end.y }, start);
		else if (shapeType === 'ellipse') {
			const centerX = (start.x + end.x) / 2;
			const centerY = (start.y + end.y) / 2;
			for (let index = 0; index <= 32; index++) {
				const angle = (index / 32) * Math.PI * 2;
				points.push({
					x: centerX + (Math.cos(angle) * Math.abs(end.x - start.x)) / 2,
					y: centerY + (Math.sin(angle) * Math.abs(end.y - start.y)) / 2
				});
			}
		} else if (stroke.points.length >= 4) {
			const [p0, p1, p2, p3] = stroke.points;
			for (let index = 0; index <= 32; index++) {
				const t = index / 32;
				const inverse = 1 - t;
				points.push({
					x:
						inverse ** 3 * p0.x +
						3 * inverse ** 2 * t * p1.x +
						3 * inverse * t ** 2 * p2.x +
						t ** 3 * p3.x,
					y:
						inverse ** 3 * p0.y +
						3 * inverse ** 2 * t * p1.y +
						3 * inverse * t ** 2 * p2.y +
						t ** 3 * p3.y
				});
			}
		}
		let distance = Infinity;
		for (let index = 1; index < points.length; index++)
			distance = Math.min(distance, distanceToSegment(point, points[index - 1], points[index]));
		return distance;
	}

	function startEdit(event: PointerEvent) {
		if (activeLayer.locked || (event.button !== 0 && event.pointerType === 'mouse')) return;
		const point = localPosition(event);
		const threshold = 12 / camera.zoom;
		let stroke = editableStroke();
		let handle =
			stroke?.points.findIndex(
				(candidate) => Math.hypot(candidate.x - point.x, candidate.y - point.y) <= threshold
			) ?? -1;
		if (handle < 0) {
			stroke =
				[...activeLayer.strokes]
					.reverse()
					.find(
						(candidate) => strokeHitDistance(candidate, point) <= threshold + candidate.size / 2
					) ?? null;
			selectedStrokeId = stroke?.id ?? null;
			handle =
				stroke?.points.findIndex(
					(candidate) => Math.hypot(candidate.x - point.x, candidate.y - point.y) <= threshold
				) ?? -1;
		}
		if (stroke && (handle >= 0 || stroke.shape === 'line')) {
			const start = stroke.points[0];
			const end = stroke.points[stroke.points.length - 1];
			const dx = end.x - start.x;
			const dy = end.y - start.y;
			const lengthSquared = dx * dx + dy * dy;
			overlayCanvas.setPointerCapture(event.pointerId);
			editGesture = {
				pointerId: event.pointerId,
				stroke,
				mode: handle >= 0 ? 'handle' : 'bend-line',
				handle,
				bendT:
					handle < 0
						? Math.max(
								0.05,
								Math.min(
									0.95,
									lengthSquared
										? ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared
										: 0.5
								)
							)
						: undefined,
				before: stroke.points.map((candidate) => ({ ...candidate })),
				beforeShape: stroke.shape
			};
		}
		redraw(false);
	}

	function startDrawing(event: PointerEvent) {
		const pressPoint = position(event);
		const now = performance.now();
		if (
			touchPoints.size === 0 &&
			lastCanvasPress &&
			now - lastCanvasPress.time < 320 &&
			Math.hypot(pressPoint.x - lastCanvasPress.point.x, pressPoint.y - lastCanvasPress.point.y) <
				28
		) {
			lastCanvasPress = null;
			const lastStroke = activeLayer.strokes[activeLayer.strokes.length - 1];
			const lastHistory = globalUndo[globalUndo.length - 1];
			if (
				lastStroke?.points.length <= 2 &&
				lastHistory?.kind === 'stroke' &&
				lastHistory.strokeId === lastStroke.id
			) {
				activeLayer.strokes.pop();
				globalUndo.pop();
			}
			openRadialMenu(event);
			return;
		}
		lastCanvasPress = { time: now, point: pressPoint };
		if (event.pointerType === 'touch') {
			touchPoints.set(event.pointerId, position(event));
			overlayCanvas.setPointerCapture(event.pointerId);
			if (touchPoints.size >= 2) {
				if (tool !== 'transform' || !beginLayerPinch()) beginPinch();
				return;
			}
			if (multiTouchActive) return;
		}
		if (tool === 'pan') {
			if (event.button !== 0 && event.pointerType === 'mouse') return;
			overlayCanvas.setPointerCapture(event.pointerId);
			panGesture = { pointerId: event.pointerId, start: position(event), x: camera.x, y: camera.y };
			return;
		}
		if (tool === 'transform') {
			startTransform(event);
			return;
		}
		if (tool === 'edit') {
			startEdit(event);
			return;
		}
		if (activeLayer.locked) return;
		if (event.button !== 0 && event.pointerType === 'mouse') return;
		stabilizeTransformPivot(activeLayer);
		if (!activeLayer.visible) activeLayer.visible = true;
		overlayCanvas.setPointerCapture(event.pointerId);
		isDrawing = true;
		activeStroke = {
			id: nextStrokeId++,
			points: [localPosition(event)],
			color,
			size: brushSize,
			smoothing: smoothingSteps,
			taper,
			shape
		};
		clearStrokePreview();
		scheduleStrokePreview();
	}

	function draw2(event: PointerEvent) {
		if (!isDrawing || !activeStroke) return;
		const events = event.getCoalescedEvents?.() ?? [event];
		if ((activeStroke.shape ?? 'freehand') === 'freehand') {
			for (const sample of events) activeStroke.points.push(localPosition(sample));
		} else {
			const endpoint = localPosition(events[events.length - 1]);
			if (activeStroke.points.length === 1) activeStroke.points.push(endpoint);
			else activeStroke.points[1] = endpoint;
		}
		// Clear the previous preview while keeping committed artwork visible.
		redraw(false);

		if (!context || activeStroke.points.length < 2) return;
		const points = activeStroke.points.slice(-6);
		const tip = points[points.length - 1];
		const previous = points[points.length - 2];
		const angle = Math.atan2(tip.y - previous.y, tip.x - previous.x);
		const triangleLength = Math.max(10, activeStroke.size * 2);
		const triangleWidth = Math.max(7, activeStroke.size * 1.4);

		context.save();
		context.translate(camera.x, camera.y);
		context.rotate(camera.rotation);
		context.scale(camera.zoom, camera.zoom);
		applyLayerTransform(activeLayer);

		// Follow the recorded pointer positions with a midpoint-smoothed Bézier path.
		context.beginPath();
		context.moveTo(points[0].x, points[0].y);
		for (let index = 1; index < points.length - 1; index++) {
			const point = points[index];
			const next = points[index + 1];
			context.quadraticCurveTo(point.x, point.y, (point.x + next.x) / 2, (point.y + next.y) / 2);
		}
		context.lineTo(tip.x, tip.y);
		context.strokeStyle = activeStroke.color;
		context.lineWidth = activeStroke.size;
		context.lineCap = 'round';
		context.lineJoin = 'round';
		context.stroke();

		// Point the triangle along the most recent pair of input points.
		context.beginPath();
		context.moveTo(tip.x, tip.y);
		context.lineTo(
			tip.x - Math.cos(angle) * triangleLength + Math.sin(angle) * (triangleWidth / 2),
			tip.y - Math.sin(angle) * triangleLength - Math.cos(angle) * (triangleWidth / 2)
		);
		context.lineTo(
			tip.x - Math.cos(angle) * triangleLength - Math.sin(angle) * (triangleWidth / 2),
			tip.y - Math.sin(angle) * triangleLength + Math.cos(angle) * (triangleWidth / 2)
		);
		context.closePath();
		context.fillStyle = activeStroke.color;
		context.fill();
		context.restore();
	}

	function draw(event: PointerEvent) {
		broadcastCursor(event);
		if (event.pointerType === 'touch' && touchPoints.has(event.pointerId)) {
			touchPoints.set(event.pointerId, position(event));
			if (layerPinchGesture && touchPoints.size >= 2) {
				const midpoint = touchMidpoint();
				if (!isNearActiveLayer(midpoint)) {
					commitLayerPinch();
					beginPinch();
					return;
				}
				const scale = touchDistance() / layerPinchGesture.distance;
				const rotation = ((touchAngle() - layerPinchGesture.angle) * 180) / Math.PI;
				const worldMidpoint = screenToWorld(midpoint);
				activeLayer.transform.scaleX = Math.max(0.05, layerPinchGesture.before.scaleX * scale);
				activeLayer.transform.scaleY = Math.max(0.05, layerPinchGesture.before.scaleY * scale);
				activeLayer.transform.rotation = layerPinchGesture.before.rotation + rotation;
				activeLayer.transform.x =
					layerPinchGesture.before.x + worldMidpoint.x - layerPinchGesture.worldMidpoint.x;
				activeLayer.transform.y =
					layerPinchGesture.before.y + worldMidpoint.y - layerPinchGesture.worldMidpoint.y;
				scheduleTransformPreview();
				return;
			}
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
		if (editGesture && event.pointerId === editGesture.pointerId) {
			const pointer = localPosition(event);
			if (editGesture.mode === 'bend-line') {
				const [start, end] = editGesture.before;
				const t = editGesture.bendT ?? 0.5;
				const inverse = 1 - t;
				// Flash-style line bending is a quadratic curve whose endpoints stay fixed.
				// Convert it to the cubic representation already used by the editor.
				const denominator = 2 * inverse * t;
				const control = {
					x: (pointer.x - inverse * inverse * start.x - t * t * end.x) / denominator,
					y: (pointer.y - inverse * inverse * start.y - t * t * end.y) / denominator
				};
				editGesture.stroke.shape = 'bezier';
				editGesture.stroke.points = [
					{ ...start },
					{
						x: start.x + (2 / 3) * (control.x - start.x),
						y: start.y + (2 / 3) * (control.y - start.y)
					},
					{ x: end.x + (2 / 3) * (control.x - end.x), y: end.y + (2 / 3) * (control.y - end.y) },
					{ ...end }
				];
			} else editGesture.stroke.points[editGesture.handle] = pointer;
			redraw(false);
			return;
		}
		if (!isDrawing || !activeStroke) return;
		const events = event.getCoalescedEvents?.() ?? [event];
		if ((activeStroke.shape ?? 'freehand') === 'freehand') {
			for (const sample of events) activeStroke.points.push(localPosition(sample));
		} else {
			const start = activeStroke.points[0];
			const endpoint = localPosition(events[events.length - 1]);
			if (activeStroke.shape === 'bezier') {
				const dx = endpoint.x - start.x;
				activeStroke.points = [
					start,
					{ x: start.x + dx / 3, y: start.y },
					{ x: endpoint.x - dx / 3, y: endpoint.y },
					endpoint
				];
			} else if (activeStroke.points.length === 1) activeStroke.points.push(endpoint);
			else activeStroke.points[1] = endpoint;
		}
		scheduleStrokePreview();
	}

	function stopDrawing(event?: PointerEvent) {
		if (event?.pointerType === 'touch') {
			touchPoints.delete(event.pointerId);
			if (multiTouchActive) {
				pinchGesture = null;
				if (touchPoints.size === 0) {
					commitLayerPinch();
					multiTouchActive = false;
					pinchCache = null;
					redraw();
				}
				if (overlayCanvas.hasPointerCapture(event.pointerId))
					overlayCanvas.releasePointerCapture(event.pointerId);
				return;
			}
		}
		if (panGesture) {
			if (event && overlayCanvas.hasPointerCapture(event.pointerId))
				overlayCanvas.releasePointerCapture(event.pointerId);
			panGesture = null;
			return;
		}
		if (transformGesture) {
			finishTransform(event);
			return;
		}
		if (editGesture) {
			if (event && overlayCanvas.hasPointerCapture(event.pointerId))
				overlayCanvas.releasePointerCapture(event.pointerId);
			const after = editGesture.stroke.points.map((point) => ({ ...point }));
			const afterShape = editGesture.stroke.shape;
			if (
				JSON.stringify(editGesture.before) !== JSON.stringify(after) ||
				editGesture.beforeShape !== afterShape
			) {
				globalUndo.push({
					kind: 'edit',
					layerId: activeLayer.id,
					strokeId: editGesture.stroke.id,
					before: editGesture.before,
					after,
					beforeShape: editGesture.beforeShape,
					afterShape
				});
				globalRedo.length = 0;
			}
			editGesture = null;
			redraw(false);
			return;
		}
		if (!isDrawing || !activeStroke) return;
		if (event && overlayCanvas.hasPointerCapture(event.pointerId))
			overlayCanvas.releasePointerCapture(event.pointerId);
		activeLayer.strokes.push(activeStroke);
		if ((activeStroke.shape ?? 'freehand') !== 'freehand') selectedStrokeId = activeStroke.id;
		globalUndo.push({
			kind: 'stroke',
			layerId: activeLayer.id,
			strokeId: activeStroke.id,
			stroke: activeStroke
		});
		globalRedo.length = 0;
		collaborationPanel?.sendStroke(activeStroke);
		if (strokePreviewFrame) cancelAnimationFrame(strokePreviewFrame);
		strokePreviewFrame = 0;
		clearStrokePreview();
		activeStroke = null;
		isDrawing = false;
		redraw(false);
	}

	function ensureRemoteLayer(user: CollaborationUser) {
		const existingId = remoteLayerIds.get(user.id);
		const existing = layers.find((layer) => layer.id === existingId);
		if (existing) return existing;
		const layer: Layer = {
			id: nextLayerId++,
			name: `${user.name} · ${user.color}`,
			visible: true,
			locked: false,
			opacity: 1,
			strokes: [],
			transform: identityTransform()
		};
		layers.push(layer);
		remoteLayerIds.set(user.id, layer.id);
		return layer;
	}

	function receiveRemoteStroke(user: CollaborationUser, stroke: Stroke) {
		if (!stroke || !Array.isArray(stroke.points)) return;
		const layer = ensureRemoteLayer(user);
		const remoteStroke: Stroke = {
			...stroke,
			id: nextStrokeId++,
			points: stroke.points.map((point) => ({ ...point }))
		};
		layer.strokes.push(remoteStroke);
		redraw(false);
	}

	function receiveRemoteCursor(user: CollaborationUser, x: number, y: number, visible: boolean) {
		remoteCursors[user.id] = { ...user, x, y, visible };
	}

	function remoteCursorScreen(cursor: CollaborationUser & Point) {
		const layer = layers.find((candidate) => candidate.id === remoteLayerIds.get(cursor.id));
		const world = layer ? transformPoint(cursor, layer) : cursor;
		const cosine = Math.cos(camera.rotation);
		const sine = Math.sin(camera.rotation);
		return {
			x: camera.x + (world.x * cosine - world.y * sine) * camera.zoom,
			y: camera.y + (world.x * sine + world.y * cosine) * camera.zoom
		};
	}

	function remotePeerLeft(user: CollaborationUser) {
		if (remoteCursors[user.id]) remoteCursors[user.id].visible = false;
	}

	function resetRemotePresence() {
		for (const cursor of Object.values(remoteCursors)) cursor.visible = false;
	}

	function broadcastCursor(event: PointerEvent, visible = true) {
		const point = localPosition(event);
		collaborationPanel?.sendCursor(point.x, point.y, visible);
	}

	function pointerLeft(event: PointerEvent) {
		broadcastCursor(event, false);
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
			const hit = handles.find(
				(handle) => Math.hypot(point.x - handle.point.x, point.y - handle.point.y) <= 14
			);
			if (hit) {
				kind = 'scale';
				selectedHandle = { x: hit.x, y: hit.y };
			}
		}
		if (
			!kind &&
			local.x >= bounds.minX &&
			local.x <= bounds.maxX &&
			local.y >= bounds.minY &&
			local.y <= bounds.maxY
		)
			kind = 'move';
		if (!kind) return;
		buildLayerTransformCache();
		overlayCanvas.setPointerCapture(event.pointerId);
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
		scheduleTransformPreview();
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
		return;
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
		if (event && overlayCanvas.hasPointerCapture(event.pointerId))
			overlayCanvas.releasePointerCapture(event.pointerId);
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
		if (transformPreviewFrame) cancelAnimationFrame(transformPreviewFrame);
		transformPreviewFrame = 0;
		layerTransformCache = null;
		transformSceneCache = null;
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
		} else if (entry.kind === 'transform') layer.transform = copyTransform(entry.before);
		else {
			const stroke = layer.strokes.find((candidate) => candidate.id === entry.strokeId);
			if (stroke) {
				stroke.points = entry.before.map((point) => ({ ...point }));
				stroke.shape = entry.beforeShape;
			}
		}
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
		else if (entry.kind === 'transform') layer.transform = copyTransform(entry.after);
		else {
			const stroke = layer.strokes.find((candidate) => candidate.id === entry.strokeId);
			if (stroke) {
				stroke.points = entry.after.map((point) => ({ ...point }));
				stroke.shape = entry.afterShape;
			}
		}
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
			const fit =
				Math.min(
					1,
					(canvasWidth * 0.7) / element.naturalWidth,
					(canvasHeight * 0.7) / element.naturalHeight
				) / camera.zoom;
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
			minX: Math.min(...corners.map((p) => p.x)),
			minY: Math.min(...corners.map((p) => p.y)),
			maxX: Math.max(...corners.map((p) => p.x)),
			maxY: Math.max(...corners.map((p) => p.y))
		};
	}

	function drawLayerTo(target: CanvasRenderingContext2D, layer: Layer) {
		if (!layer.visible) return;
		target.save();
		target.globalAlpha = layer.opacity;
		applyLayerTransform(layer, target);
		if (layer.image)
			target.drawImage(
				layer.image.element,
				layer.image.x,
				layer.image.y,
				layer.image.width,
				layer.image.height
			);
		for (const stroke of layer.strokes) drawStroke(stroke, target);
		target.restore();
	}

	function mergeDown() {
		const topIndex = layers.findIndex((layer) => layer.id === activeLayerId);
		if (topIndex <= 0) return;
		const bottom = layers[topIndex - 1],
			top = layers[topIndex];
		const boundsList = [layerWorldBounds(bottom), layerWorldBounds(top)].filter(
			(value) => value !== null
		);
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
			const merged: Layer = {
				id: bottom.id,
				name: `${bottom.name} + ${top.name}`,
				visible: true,
				locked: bottom.locked || top.locked,
				opacity: 1,
				strokes: [],
				image: {
					element,
					src,
					x: minX,
					y: minY,
					width: mergedCanvas.width,
					height: mergedCanvas.height
				},
				transform: identityTransform()
			};
			layers.splice(topIndex - 1, 2, merged);
			activeLayerId = merged.id;
			globalUndo = globalUndo.filter(
				(entry) => entry.layerId !== bottom.id && entry.layerId !== top.id
			);
			globalRedo = globalRedo.filter(
				(entry) => entry.layerId !== bottom.id && entry.layerId !== top.id
			);
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
			])
				points.push(transformPoint(point, layer));
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
			if (layer.image)
				targetContext.drawImage(
					layer.image.element,
					layer.image.x,
					layer.image.y,
					layer.image.width,
					layer.image.height
				);
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
		const strokeCount = layers.reduce(
			(sum, layer) => sum + (layer.visible ? layer.strokes.length : 0),
			0
		);
		if (!bounds || !strokeCount || !('MediaRecorder' in window)) return;
		const output = document.createElement('canvas');
		const maxDimension = 1920;
		const scale = Math.min(
			1,
			maxDimension / Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY)
		);
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
			bind:shape
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
		<CollaborationPanel
			bind:this={collaborationPanel}
			bind:color
			bind:brushSize
			onstroke={receiveRemoteStroke}
			oncursor={receiveRemoteCursor}
			onpeerjoined={ensureRemoteLayer}
			onpeerleft={remotePeerLeft}
			onreset={resetRemotePresence}
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
			bind:overlayCanvas
			{tool}
			onwheel={zoomCanvas}
			onpointerdown={startDrawing}
			onpointermove={draw}
			onpointerup={stopDrawing}
			onpointerleave={pointerLeft}
			ondoublepress={openRadialMenu}
		/>
		{#each Object.values(remoteCursors) as cursor (cursor.id)}
			{#if cursor.visible}
				{@const screen = remoteCursorScreen(cursor)}
				<div
					class="remote-cursor"
					style:left={`${screen.x}px`}
					style:top={`${screen.y}px`}
					style:--cursor-color={cursor.color}
				>
					<span></span><small>{cursor.name}</small>
				</div>
			{/if}
		{/each}
		{#if radialMenu}
			<div
				class="radial-menu"
				style:left={`${radialMenu.x}px`}
				style:top={`${radialMenu.y}px`}
				role="menu"
			>
				<button
					class="radial-close"
					onclick={() => (radialMenu = null)}
					aria-label="Close quick menu">×</button
				>
				{#each radialSlots as action, index}
					<button class="radial-action" style:--slot={index} onclick={() => runRadialAction(action)}
						>{action}</button
					>
				{/each}
			</div>
		{/if}
	</section>
</main>
