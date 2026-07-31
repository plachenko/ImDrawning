import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

const port = Number(process.env.PORT || 8787);
const rooms = new Map();
const server = createServer((request, response) => {
	response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
	response.end('ImDrawning collaboration relay is running.\n');
});
const sockets = new WebSocketServer({ server, maxPayload: 2_000_000 });
const colors = ['#ef4444', '#f59e0b', '#16a34a', '#2563eb', '#7c3aed', '#db2777'];
let nextUser = 1;

function send(socket, message) {
	if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function broadcast(roomCode, message, except) {
	for (const peer of rooms.get(roomCode) || []) if (peer !== except) send(peer, message);
}

function leave(socket) {
	if (!socket.room) return;
	const roomCode = socket.room;
	const room = rooms.get(socket.room);
	room?.delete(socket);
	if (room?.size === 0) rooms.delete(socket.room);
	else broadcast(roomCode, { type: 'peer-left', user: socket.user }, socket);
	socket.room = null;
}

sockets.on('connection', (socket) => {
	const number = nextUser++;
	socket.user = { id: `user-${number}-${Math.random().toString(36).slice(2, 7)}`, name: `User ${number}`, color: colors[(number - 1) % colors.length] };
	socket.on('message', (raw) => {
		let message;
		try {
			message = JSON.parse(raw.toString());
		} catch {
			return;
		}
		if (message.type === 'join') {
			leave(socket);
			const roomCode = String(message.room || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
			if (!roomCode) return;
			socket.room = roomCode;
			socket.role = message.role === 'control' ? 'control' : 'draw';
			if (!rooms.has(roomCode)) rooms.set(roomCode, new Set());
			const peers = [...rooms.get(roomCode)].map((peer) => peer.user);
			rooms.get(roomCode).add(socket);
			send(socket, { type: 'joined', room: roomCode, user: socket.user, peers });
			broadcast(roomCode, { type: 'peer-joined', user: socket.user }, socket);
			return;
		}
		if (!socket.room) return;
		if (message.type === 'stroke' && socket.role !== 'draw') return;
		if (!['stroke', 'parameters', 'cursor'].includes(message.type)) return;
		broadcast(socket.room, { ...message, user: socket.user }, socket);
	});
	socket.on('close', () => leave(socket));
});

server.listen(port, '0.0.0.0', () => {
	console.log(`ImDrawning collaboration relay: ws://0.0.0.0:${port}`);
});
