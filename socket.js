const { Server } = require('socket.io');

let io = null;

function initSocket(httpServer) {
  io = new Server(httpServer, { cors: { origin: '*' } });

  io.on('connection', (socket) => {
    console.log('[SOCKET] Client connected:', socket.id);

    // Dashboard admin join room ini -- semua update peta/KPI/tiket
    // realtime dikirim ke sini.
    socket.on('register-dashboard', () => {
      socket.join('dashboard');
    });

    // Teknisi join room pribadinya sendiri (buat notifikasi assign tiket
    // baru khusus buat dia).
    socket.on('register-teknisi', (teknisiId) => {
      socket.join(`teknisi-${teknisiId}`);
    });

    socket.on('disconnect', () => {
      console.log('[SOCKET] Client disconnected:', socket.id);
    });
  });

  return io;
}

function emitToDashboard(event, payload) {
  if (io) io.to('dashboard').emit(event, payload);
}

function emitToTeknisi(teknisiId, event, payload) {
  if (io) io.to(`teknisi-${teknisiId}`).emit(event, payload);
}

module.exports = { initSocket, emitToDashboard, emitToTeknisi };
