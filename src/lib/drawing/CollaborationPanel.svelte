<script lang="ts">
	import { onMount } from 'svelte';
	import QRCode from 'qrcode';
	import type { Stroke } from './types';
	export type CollaborationUser = { id: string; name: string; color: string };

	let {
		color = $bindable(),
		brushSize = $bindable(),
		onstroke,
		oncursor,
		onpeerjoined,
		onpeerleft,
		onreset
	}: {
		color: string;
		brushSize: number;
		onstroke: (user: CollaborationUser, stroke: Stroke) => void;
		oncursor: (user: CollaborationUser, x: number, y: number, visible: boolean) => void;
		onpeerjoined: (user: CollaborationUser) => void;
		onpeerleft: (user: CollaborationUser) => void;
		onreset: () => void;
	} = $props();
	let open = $state(false);
	let serverUrl = $state('');
	let room = $state('');
	let role = $state<'draw' | 'control'>('draw');
	let status = $state<'offline' | 'connecting' | 'connected'>('offline');
	let qr = $state('');
	let copied = $state(false);
	let scanning = $state(false);
	let video = $state<HTMLVideoElement>(null!);
	let socket: WebSocket | null = null;
	let stream: MediaStream | null = null;

	onMount(() => {
		const params = new URLSearchParams(location.search);
		const localDevelopment = location.protocol === 'http:' && location.port !== '8787';
		serverUrl =
			params.get('collabWs') ||
			(localDevelopment
				? `ws://${location.hostname || 'localhost'}:8787`
				: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
		room = params.get('room') || '';
		role = params.get('role') === 'control' ? 'control' : 'draw';
		return disconnect;
	});

	function normalizeServer(value: string) {
		const trimmed = value.trim().replace(/\/$/, '');
		if (/^wss?:\/\//i.test(trimmed)) return trimmed;
		return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${trimmed}`;
	}

	function makeRoom() {
		room = Math.random().toString(36).slice(2, 8).toUpperCase();
		connect();
	}

	async function updateQr() {
		if (!room || !serverUrl) return;
		const link = new URL(location.href);
		link.searchParams.set('collabWs', normalizeServer(serverUrl));
		link.searchParams.set('room', room);
		link.searchParams.set('role', role);
		qr = await QRCode.toDataURL(link.toString(), { width: 220, margin: 1 });
	}

	async function copyRoomCode() {
		try {
			await navigator.clipboard.writeText(room);
		} catch {
			const input = document.createElement('textarea');
			input.value = room;
			input.style.position = 'fixed';
			input.style.opacity = '0';
			document.body.append(input);
			input.select();
			document.execCommand('copy');
			input.remove();
		}
		copied = true;
		setTimeout(() => (copied = false), 1400);
	}

	function connect() {
		disconnect();
		if (!room.trim()) room = Math.random().toString(36).slice(2, 8).toUpperCase();
		room = room.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
		serverUrl = normalizeServer(serverUrl);
		status = 'connecting';
		socket = new WebSocket(serverUrl);
		socket.onopen = () => socket?.send(JSON.stringify({ type: 'join', room, role }));
		socket.onmessage = (event) => {
			const message = JSON.parse(event.data);
			if (message.type === 'joined') {
				status = 'connected';
				for (const peer of message.peers || []) onpeerjoined(peer);
				updateQr();
			} else if (message.type === 'peer-joined') onpeerjoined(message.user);
			else if (message.type === 'peer-left') onpeerleft(message.user);
			else if (message.type === 'stroke' && role === 'draw')
				onstroke(message.user, message.stroke);
			else if (message.type === 'cursor')
				oncursor(message.user, message.x, message.y, message.visible);
			else if (message.type === 'parameters') {
				if (typeof message.color === 'string') color = message.color;
				if (typeof message.brushSize === 'number') brushSize = message.brushSize;
			}
		};
		socket.onclose = () => {
			status = 'offline';
			onreset();
		};
		socket.onerror = () => (status = 'offline');
	}

	export function disconnect() {
		socket?.close();
		socket = null;
		status = 'offline';
		onreset();
		stopScanner();
	}

	export function sendStroke(stroke: Stroke) {
		if (status === 'connected' && role === 'draw')
			socket?.send(JSON.stringify({ type: 'stroke', stroke }));
	}

	export function sendCursor(x: number, y: number, visible: boolean) {
		if (status === 'connected')
			socket?.send(JSON.stringify({ type: 'cursor', x, y, visible }));
	}

	function sendParameters() {
		if (status === 'connected')
			socket?.send(JSON.stringify({ type: 'parameters', color, brushSize }));
	}

	async function startScanner() {
		const Detector = (globalThis as typeof globalThis & { BarcodeDetector?: new (options: unknown) => { detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>> } }).BarcodeDetector;
		if (!Detector) return alert('QR scanning is not supported by this browser. Enter the server and room code instead.');
		scanning = true;
		stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
		video.srcObject = stream;
		await video.play();
		const detector = new Detector({ formats: ['qr_code'] });
		while (scanning) {
			const codes = await detector.detect(video);
			if (codes[0]) {
				const link = new URL(codes[0].rawValue);
				serverUrl = link.searchParams.get('collabWs') || serverUrl;
				room = link.searchParams.get('room') || room;
				stopScanner();
				connect();
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 180));
		}
	}

	function stopScanner() {
		scanning = false;
		stream?.getTracks().forEach((track) => track.stop());
		stream = null;
	}
</script>

<button class="collab-trigger" onclick={() => (open = !open)}>Share</button>
{#if open}
	<aside class="collab-panel" aria-label="Collaboration">
		<header><strong>Connect devices</strong><button onclick={() => (open = false)}>×</button></header>
		<label>Server<input bind:value={serverUrl} placeholder="192.168.1.10:8787" /></label>
		<label>Room code<input bind:value={room} maxlength="8" placeholder="ROOM42" /></label>
		<label>Access<select bind:value={role}><option value="draw">Draw</option><option value="control">Brush controls</option></select></label>
		<div class="collab-actions">
			<button onclick={makeRoom}>Start room</button><button onclick={connect}>Connect</button>
			<button onclick={startScanner}>Scan QR</button>
			{#if status !== 'offline'}<button onclick={disconnect}>Disconnect</button>{/if}
		</div>
		<p class:connected={status === 'connected'}>{status}</p>
		{#if qr && status === 'connected'}
			<button class="qr-copy" onclick={copyRoomCode} title="Copy room code">
				<img src={qr} alt={`Join room ${room}; click to copy the room code`} />
				<span>{copied ? 'Copied!' : 'Click QR to copy room code'}</span>
			</button>
			<strong class="room-code">{room}</strong>
		{/if}
		{#if status === 'connected'}
			<label>Remote color<input type="color" bind:value={color} oninput={sendParameters} /></label>
			<label>Remote size<input type="range" min="2" max="28" bind:value={brushSize} oninput={sendParameters} /></label>
		{/if}
		{#if scanning}<div class="scanner"><video bind:this={video} muted playsinline></video><button onclick={stopScanner}>Cancel scan</button></div>{/if}
		<small>Hosted builds connect securely to this page by default. For local sharing, run <code>npm run collab</code> and use the host's local IP.</small>
	</aside>
{/if}
