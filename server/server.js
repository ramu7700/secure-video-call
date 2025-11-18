import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const httpServer = createServer(app);

// CORS configuration
app.use(cors());

// Socket.IO setup with CORS
const io = new Server(httpServer, {
  cors: {
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

// Room management - stores room occupancy
// Note: No encryption keys or media data is stored!
const rooms = new Map();

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Handle room joining
  socket.on('join-room', ({ room }) => {
    // Check if room exists and get current occupancy
    const roomData = rooms.get(room) || { users: new Set(), occupancy: 0 };
    
    // Maximum 2 users per room for 1-to-1 calls
    if (roomData.occupancy >= 2) {
      socket.emit('roomFull');
      return;
    }

    // Add user to room
    socket.join(room);
    roomData.users.add(socket.id);
    roomData.occupancy = roomData.users.size;
    rooms.set(room, roomData);

    // Store room info on socket for cleanup
    socket.currentRoom = room;

    // Notify user they've joined
    socket.emit('roomJoined', { 
      occupancy: roomData.occupancy 
    });

    // Notify other users in room
    socket.to(room).emit('userJoined', {
      userId: socket.id,
      occupancy: roomData.occupancy
    });

    console.log(`User ${socket.id} joined room ${room}. Occupancy: ${roomData.occupancy}`);
  });

  // Handle WebRTC signaling - offer
  socket.on('offer', ({ room, offer }) => {
    console.log(`Relaying offer in room ${room}`);
    socket.to(room).emit('offer', { offer, from: socket.id });
  });

  // Handle WebRTC signaling - answer
  socket.on('answer', ({ room, answer }) => {
    console.log(`Relaying answer in room ${room}`);
    socket.to(room).emit('answer', { answer, from: socket.id });
  });

  // Handle ICE candidates
  socket.on('ice-candidate', ({ room, candidate }) => {
    console.log(`Relaying ICE candidate in room ${room}`);
    socket.to(room).emit('ice-candidate', { candidate, from: socket.id });
  });

  // Handle room leaving
  socket.on('leave-room', ({ room }) => {
    handleUserLeave(socket, room);
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    if (socket.currentRoom) {
      handleUserLeave(socket, socket.currentRoom);
    }
  });
});

// Helper function to handle user leaving
function handleUserLeave(socket, room) {
  const roomData = rooms.get(room);
  
  if (roomData) {
    roomData.users.delete(socket.id);
    roomData.occupancy = roomData.users.size;

    if (roomData.occupancy === 0) {
      // Delete empty room
      rooms.delete(room);
      console.log(`Room ${room} deleted (empty)`);
    } else {
      rooms.set(room, roomData);
      // Notify remaining users
      socket.to(room).emit('userLeft', {
        userId: socket.id,
        occupancy: roomData.occupancy
      });
      console.log(`User ${socket.id} left room ${room}. Occupancy: ${roomData.occupancy}`);
    }
  }

  socket.leave(room);
  socket.currentRoom = null;
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    activeRooms: rooms.size,
    timestamp: new Date().toISOString()
  });
});

// Server info endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'SecureCall Signaling Server',
    version: '1.0.0',
    description: 'WebRTC signaling server for E2EE video calls',
    endpoints: {
      health: '/health',
      socket: '/socket.io'
    }
  });
});

const PORT = process.env.PORT || 3001;

httpServer.listen(PORT, () => {
  console.log(`
  🚀 SecureCall Server Running
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Port: ${PORT}
  Health: http://localhost:${PORT}/health
  
  🔐 Security Note:
  - Server acts as signaling only
  - No media or encryption keys stored
  - All encryption happens client-side
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━
  `);
});
