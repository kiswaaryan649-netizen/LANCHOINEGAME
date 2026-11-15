const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

const WORD_CATEGORIES = {
  Space: ['Comet', 'Nebula', 'Orbit', 'Gravity', 'Satellite', 'Galaxy', 'Asteroid', 'Rocket', 'Vortex', 'Moon'],
  Nature: ['Forest', 'River', 'Canyon', 'Rain', 'Meadow', 'Volcano', 'Pebble', 'Storm', 'Leaf', 'Valley'],
  Food: ['Pasta', 'Burrito', 'Grapes', 'Saffron', 'Pepper', 'Sushi', 'Mango', 'Cocoa', 'Taco', 'Brûlée'],
  Tech: ['Circuit', 'Kernel', 'Server', 'Quantum', 'Signal', 'Binary', 'Drone', 'Code', 'Cache', 'Firewall'],
  City: ['Metro', 'Skyscraper', 'Harbor', 'Signal', 'Tunnel', 'Plaza', 'Taxi', 'Lantern', 'Bridge', 'Monorail'],
  Fantasy: ['Dragon', 'Rune', 'Portal', 'Warden', 'Phoenix', 'Crown', 'Castle', 'Oath', 'Spell', 'Talisman']
};

const DEFAULT_SETTINGS = {
  maxPlayers: 8,
  imposters: 2,
  discussionTimer: 90,
  voteTimer: 30,
  categories: ['Space', 'Nature']
};

const rooms = new Map();

function sanitizeSettings(input = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...input };
  settings.maxPlayers = Math.max(4, Math.min(20, Number(settings.maxPlayers) || DEFAULT_SETTINGS.maxPlayers));
  settings.imposters = Math.max(1, Math.min(4, Number(settings.imposters) || DEFAULT_SETTINGS.imposters));
  settings.discussionTimer = Math.max(30, Math.min(180, Number(settings.discussionTimer) || DEFAULT_SETTINGS.discussionTimer));
  settings.voteTimer = Math.max(15, Math.min(90, Number(settings.voteTimer) || DEFAULT_SETTINGS.voteTimer));
  settings.categories = Array.isArray(input.categories) && input.categories.length ? input.categories.slice(0, 3) : DEFAULT_SETTINGS.categories;
  return settings;
}

function randomWordFromCategories(categories) {
  const active = categories.length ? categories : ['Space'];
  const category = active[Math.floor(Math.random() * active.length)];
  const words = WORD_CATEGORIES[category] || WORD_CATEGORIES.Space;
  return {
    category,
    word: words[Math.floor(Math.random() * words.length)]
  };
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  while (code.length < 6) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function emitError(socket, message) {
  socket.emit('serverError', { message });
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getSafePlayer(player) {
  return {
    id: player.id,
    username: player.username,
    avatar: player.avatar,
    ready: !!player.ready,
    isHost: !!player.isHost,
    eliminated: !!player.eliminated,
    role: player.role || null,
    vote: player.vote || null
  };
}

function buildRoomState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    state: room.state,
    settings: room.settings,
    chat: room.chat.slice(-20),
    players: room.players.map(getSafePlayer),
    game: room.game ? {
      phase: room.game.phase,
      timeLeft: room.game.timeLeft,
      category: room.game.category,
      winner: room.game.winner,
      reveal: room.game.reveal,
      lastEliminated: room.game.lastEliminated,
      accusations: room.game.accusations || []
    } : null
  };
}

function updateRoomBroadcast(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const payload = buildRoomState(room);
  io.to(roomCode).emit('roomUpdate', payload);
}

function clearRoomPhaseTimer(room) {
  if (room.phaseTimer) {
    clearInterval(room.phaseTimer);
    room.phaseTimer = null;
  }
}

function getRoomForSocket(socket) {
  const roomCode = socket.data.roomCode;
  if (!roomCode) return null;
  return rooms.get(roomCode) || null;
}

function removePlayerFromRoom(socket) {
  const room = getRoomForSocket(socket);
  if (!room) return;

  const index = room.players.findIndex((player) => player.socketId === socket.id);
  if (index === -1) return;

  const [removed] = room.players.splice(index, 1);
  delete socket.data.roomCode;

  if (room.players.length === 0) {
    clearRoomPhaseTimer(room);
    rooms.delete(room.code);
    return;
  }

  if (room.hostId === removed.id) {
    room.hostId = room.players[0].id;
    room.players[0].isHost = true;
  }

  if (room.state === 'playing' && room.game) {
    const alive = room.players.filter((player) => !player.eliminated);
    const impostersAlive = alive.filter((player) => player.role === 'imposter');
    const civiliansAlive = alive.filter((player) => player.role !== 'imposter');

    if (impostersAlive.length === 0 || impostersAlive.length >= civiliansAlive.length) {
      room.game.winner = impostersAlive.length >= civiliansAlive.length ? 'imposters' : 'civilians';
      room.state = 'results';
      clearRoomPhaseTimer(room);
    }
  }

  updateRoomBroadcast(room.code);
}

function setPhase(room, phase) {
  if (!room.game) return;
  clearRoomPhaseTimer(room);
  room.game.phase = phase;
  room.game.reveal = false;
  room.game.lastEliminated = room.game.lastEliminated || null;

  const duration = phase === 'discussion' ? room.settings.discussionTimer : room.settings.voteTimer;
  room.game.timeLeft = duration;
  const endsAt = Date.now() + duration * 1000;

  room.phaseTimer = setInterval(() => {
    const remaining = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    room.game.timeLeft = remaining;
    io.to(room.code).emit('gameTick', {
      code: room.code,
      phase,
      timeLeft: remaining,
      winner: room.game.winner || null
    });

    if (remaining <= 0) {
      clearRoomPhaseTimer(room);
      if (phase === 'discussion') {
        startVotingPhase(room);
      } else {
        resolveVoting(room);
      }
    }
  }, 1000);

  io.to(room.code).emit('gameTick', {
    code: room.code,
    phase,
    timeLeft: duration,
    winner: room.game.winner || null
  });
}

function startVotingPhase(room) {
  room.game.phase = 'voting';
  room.players.forEach((player) => {
    player.vote = null;
  });
  setPhase(room, 'voting');
  io.to(room.code).emit('roomUpdate', buildRoomState(room));
}

function resolveVoting(room) {
  if (!room.game || room.state !== 'playing') return;

  const alivePlayers = room.players.filter((player) => !player.eliminated);
  const voteMap = new Map();

  alivePlayers.forEach((player) => {
    if (player.vote && player.vote !== player.id) {
      voteMap.set(player.vote, (voteMap.get(player.vote) || 0) + 1);
    }
  });

  let eliminationTarget = null;
  let maxVotes = 0;
  voteMap.forEach((count, targetId) => {
    if (count > maxVotes) {
      maxVotes = count;
      eliminationTarget = targetId;
    }
  });

  if (eliminationTarget) {
    const target = room.players.find((player) => player.id === eliminationTarget);
    if (target) {
      target.eliminated = true;
      room.game.lastEliminated = target.username;
      room.game.reveal = true;
    }
  }

  const remainingImposters = room.players.filter((player) => !player.eliminated && player.role === 'imposter');
  const remainingCivilians = room.players.filter((player) => !player.eliminated && player.role !== 'imposter');

  if (remainingImposters.length === 0) {
    room.game.winner = 'civilians';
    room.state = 'results';
  } else if (remainingImposters.length >= remainingCivilians.length) {
    room.game.winner = 'imposters';
    room.state = 'results';
  }

  if (room.state === 'results') {
    clearRoomPhaseTimer(room);
  } else {
    room.game.phase = 'discussion';
    room.game.reveal = false;
    room.players.forEach((player) => {
      player.vote = null;
      player.eliminated = !!player.eliminated;
    });
    setPhase(room, 'discussion');
  }

  io.to(room.code).emit('roomUpdate', buildRoomState(room));
}

function startNewRound(room) {
  room.state = 'playing';
  room.game = {
    phase: 'discussion',
    timeLeft: room.settings.discussionTimer,
    category: 'Random',
    winner: null,
    reveal: false,
    lastEliminated: null,
    accusations: []
  };

  const selected = randomWordFromCategories(room.settings.categories);
  room.game.category = selected.category;
  room.game.secretWord = selected.word;
  const imposterCount = Math.min(room.settings.imposters || 2, room.players.length - 1);
  const shuffled = [...room.players].sort(() => Math.random() - 0.5);
  const imposterIds = new Set(shuffled.slice(0, imposterCount).map((player) => player.id));

  room.players.forEach((player) => {
    player.role = imposterIds.has(player.id) ? 'imposter' : 'civilian';
    player.eliminated = false;
    player.vote = null;
    const card = imposterIds.has(player.id) ? 'IMPOSTER' : room.game.secretWord;
    io.to(player.socketId).emit('privateCard', {
      role: player.role,
      card,
      secretWord: room.game.secretWord,
      category: room.game.category,
      imposters: imposterCount
    });
  });

  setPhase(room, 'discussion');
  updateRoomBroadcast(room.code);
}

function ensureUserFromPayload(payload) {
  if (
    !payload
    || typeof payload.id !== 'string'
    || !payload.id.trim()
    || payload.id.length > 64
    || typeof payload.username !== 'string'
  ) {
    return null;
  }
  const username = payload.username.trim();
  if (!username || username.length > 18) {
    return null;
  }
  return {
    id: payload.id.trim(),
    username,
    avatar: typeof payload.avatar === 'string' && payload.avatar.length <= 8 ? payload.avatar : username[0].toUpperCase()
  };
}

app.get('/socket.io-client.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', 'socket.io', 'client-dist', 'socket.io.min.js'));
});
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, status: 'online', rooms: rooms.size });
});

app.get('/api/categories', (req, res) => {
  res.json({ categories: Object.keys(WORD_CATEGORIES) });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

io.on('connection', (socket) => {
  socket.on('createRoom', ({ user, settings }) => {
    const currentUser = ensureUserFromPayload(user);
    if (!currentUser) {
      return emitError(socket, 'Enter a name to play.');
    }

    const roomCode = generateRoomCode();
    const room = {
      code: roomCode,
      hostId: currentUser.id,
      state: 'lobby',
      settings: sanitizeSettings(settings),
      players: [],
      chat: [],
      phaseTimer: null,
      game: null
    };

    const player = {
      id: currentUser.id,
      socketId: socket.id,
      username: currentUser.username,
      avatar: currentUser.avatar,
      ready: false,
      isHost: true,
      role: null,
      eliminated: false,
      vote: null
    };

    room.players.push(player);
    socket.data.roomCode = roomCode;
    rooms.set(roomCode, room);
    socket.join(roomCode);
    socket.emit('roomCreated', { code: roomCode });
    updateRoomBroadcast(roomCode);
  });

  socket.on('joinRoom', ({ code, user }) => {
    const roomCode = String(code || '').trim().toUpperCase();
    const room = rooms.get(roomCode);
    if (!room) {
      return emitError(socket, 'Room code not found.');
    }

    if (room.players.length >= room.settings.maxPlayers) {
      return emitError(socket, 'This room is already full.');
    }

    const currentUser = ensureUserFromPayload(user);
    if (!currentUser) {
      return emitError(socket, 'Enter a name to play.');
    }
    const playerExists = room.players.some((player) => player.id === currentUser.id);
    if (playerExists) {
      return emitError(socket, 'You are already in this room.');
    }

    const newPlayer = {
      id: currentUser.id,
      socketId: socket.id,
      username: currentUser.username,
      avatar: currentUser.avatar,
      ready: false,
      isHost: false,
      role: null,
      eliminated: false,
      vote: null
    };

    room.players.push(newPlayer);
    socket.data.roomCode = roomCode;
    socket.join(roomCode);
    updateRoomBroadcast(roomCode);
  });

  socket.on('toggleReady', ({ roomCode }) => {
    const room = rooms.get(String(roomCode || '').trim().toUpperCase());
    if (!room) return;

    const player = room.players.find((entry) => entry.socketId === socket.id);
    if (!player) return;

    player.ready = !player.ready;
    updateRoomBroadcast(room.code);
  });

  socket.on('sendLobbyChat', ({ roomCode, text }) => {
    const room = rooms.get(String(roomCode || '').trim().toUpperCase());
    if (!room) return;

    const player = room.players.find((entry) => entry.socketId === socket.id);
    if (!player) return;

    const sanitized = String(text || '').trim();
    if (!sanitized) return;

    room.chat.push({
      sender: player.username,
      avatar: player.avatar,
      message: escapeHtml(sanitized),
      createdAt: new Date().toISOString()
    });

    updateRoomBroadcast(room.code);
  });

  socket.on('startGame', ({ roomCode }) => {
    const room = rooms.get(String(roomCode || '').trim().toUpperCase());
    if (!room) return;

    const player = room.players.find((entry) => entry.socketId === socket.id);
    if (!player || player.id !== room.hostId) {
      return emitError(socket, 'Only the room host can start the match.');
    }

    if (room.players.length < 4) {
      return emitError(socket, 'At least 4 players are required to start.');
    }

    room.state = 'playing';
    startNewRound(room);
  });

  socket.on('submitVote', ({ roomCode, targetId }) => {
    const room = rooms.get(String(roomCode || '').trim().toUpperCase());
    if (!room || room.state !== 'playing' || !room.game || room.game.phase !== 'voting') return;

    const player = room.players.find((entry) => entry.socketId === socket.id);
    if (!player || player.eliminated) return;

    if (!targetId || targetId === player.id) return;

    player.vote = targetId;
    const alive = room.players.filter((entry) => !entry.eliminated);
    if (alive.every((entry) => !!entry.vote)) {
      resolveVoting(room);
    } else {
      updateRoomBroadcast(room.code);
    }
  });

  socket.on('sendAccusation', ({ roomCode, targetId, message }) => {
    const room = rooms.get(String(roomCode || '').trim().toUpperCase());
    if (!room || !room.game) return;

    const player = room.players.find((entry) => entry.socketId === socket.id);
    const target = room.players.find((entry) => entry.id === targetId);
    if (!player || !target) return;

    const accusationText = String(message || `I suspect ${target.username} is hiding something.`).trim();
    room.game.accusations = room.game.accusations || [];
    room.game.accusations.push({
      from: player.username,
      target: target.username,
      message: escapeHtml(accusationText)
    });
    updateRoomBroadcast(room.code);
  });

  socket.on('leaveRoom', () => {
    removePlayerFromRoom(socket);
  });

  socket.on('disconnect', () => {
    removePlayerFromRoom(socket);
  });
});

server.listen(PORT, () => {
  console.log(`IMPOSTER server listening on http://localhost:${PORT}`);
});
