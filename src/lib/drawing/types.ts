export type Point = { x: number; y: number };

export type Stroke = {
	id: number;
	points: Point[];
	color: string;
	size: number;
	smoothing: number;
	taper: number;
};

export type LayerTransform = {
	x: number;
	y: number;
	rotation: number;
	scaleX: number;
	scaleY: number;
	pivotX?: number;
	pivotY?: number;
};

export type LayerImage = {
	element: HTMLImageElement;
	src: string;
	x: number;
	y: number;
	width: number;
	height: number;
};

export type Layer = {
	id: number;
	name: string;
	visible: boolean;
	locked: boolean;
	opacity: number;
	strokes: Stroke[];
	image?: LayerImage;
	transform: LayerTransform;
};
