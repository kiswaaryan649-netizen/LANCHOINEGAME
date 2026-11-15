const socket = io();
const state = {
  player: null,
  room: null,
  card: null
};

const ui = {
  home: document.getElementById('homeScreen'),
  room: document.getElementById('roomScreen'),
  authStatus: document.getElementById('authStatus'),
  install: document.getElementById('installAppBtn'),
  playerName: document.getElementById('playerNameInput'),
  maxPlayers: document.getElementById('maxPlayersInput'),
  create: document.getElementById('createRoomAction'),
  joinForm: document.getElementById('joinForm'),
  joinCode: document.getElementById('joinCodeInput'),
  meta: document.getElementById('roomMeta'),
  copy: document.getElementById('copyRoomBtn'),
  card: document.getElementById('privateCard'),
  timer: document.getElementById('timerDisplay'),
  ready: document.getElementById('toggleReadyBtn'),
  start: document.getElementById('startGameBtn'),
  leave: document.getElementById('leaveRoomBtn'),
  count: document.getElementById('playerCount'),
  players: document.getElementById('playerList'),
  chat: document.getElementById('chatWindow'),
  chatForm: document.getElementById('chatForm'),
  chatInput: document.getElementById('chatMessageInput'),
  toast: document.getElementById('toast')
};

let deferredInstallPrompt = null;
let toastTimeout;

function toast(message) {
  ui.toast.textContent = message;
  ui.toast.classList.remove('hidden');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => ui.toast.classList.add('hidden'), 2200);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  })[character]);
}

function getPlayer() {
  const username = ui.playerName.value.trim();
  if (!username) {
    ui.playerName.focus();
    toast('Enter your name first.');
    return null;
  }
  if (username.length > 18) {
    toast('Name must be 18 characters or less.');
    return null;
  }

  let id = localStorage.getItem('imposterPlayerId');
  if (!id) {
    id = globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `player-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem('imposterPlayerId', id);
  }
  localStorage.setItem('imposterPlayerName', username);
  state.player = { id, username, avatar: username[0].toUpperCase() };
  ui.authStatus.textContent = username;
  return state.player;
}

async function createRoom() {
  const player = getPlayer();
  if (player) {
    socket.emit('createRoom', {
      user: player,
      settings: { maxPlayers: Number(ui.maxPlayers.value) }
    });
  }
}

function joinRoom(code = ui.joinCode.value) {
  const roomCode = code.trim().toUpperCase();
  if (!roomCode) {
    toast('Enter a room code.');
    return;
  }
  const player = getPlayer();
  if (player) socket.emit('joinRoom', { code: roomCode, user: player });
}

function showRoom(room) {
  state.room = room;
  ui.home.classList.toggle('hidden', !!room);
  ui.room.classList.toggle('hidden', !room);
  if (!room) {
    state.card = null;
    ui.card.classList.add('hidden');
    ui.meta.textContent = '';
    ui.players.innerHTML = '';
    ui.chat.innerHTML = '';
    return;
  }

  const me = room.players.find((player) => player.id === state.player?.id);
  const isHost = room.hostId === state.player?.id;
  const myVote = me?.vote;
  ui.meta.innerHTML = `<strong>${escapeHtml(room.code)}</strong> <span>${room.players.length}/${room.settings.maxPlayers}</span>`;
  ui.count.textContent = `${room.players.length}/${room.settings.maxPlayers}`;

  ui.players.innerHTML = room.players.map((player) => {
    const eliminated = !!player.eliminated;
    const voteButton = room.game?.phase === 'voting' && !eliminated && player.id !== state.player?.id
      ? `<button class="vote-button" type="button" data-vote="${escapeHtml(player.id)}" ${myVote ? 'disabled' : ''}>${myVote === player.id ? 'VOTED' : 'VOTE'}</button>`
      : '';
    const role = room.game?.reveal && player.role
      ? `<span class="role-tag">${player.role === 'imposter' ? 'IMPOSTER' : 'CIVILIAN'}</span>`
      : '';
    return `<div class="player-row">
      <span class="player-avatar">${escapeHtml(player.avatar)}</span>
      <span class="player-label">${escapeHtml(player.username)}${player.isHost ? ' <small>HOST</small>' : ''}${player.id === state.player?.id ? ' <small>YOU</small>' : ''}${role}</span>
      ${eliminated ? '<span class="eliminated">OUT</span>' : voteButton}
    </div>`;
  }).join('');

  ui.chat.innerHTML = (room.chat || []).map((message) =>
    `<div class="chat-message"><strong>${escapeHtml(message.sender)}</strong> ${escapeHtml(message.message)}</div>`
  ).join('');
  ui.chat.scrollTop = ui.chat.scrollHeight;

  ui.timer.textContent = room.state === 'results'
    ? (room.game.winner === 'imposters' ? 'IMPOSTERS WIN' : 'PLAYERS WIN')
    : room.game
      ? `${room.game.phase.toUpperCase()} · ${room.game.timeLeft}s`
      : 'WAITING FOR PLAYERS';

  const isLobby = room.state === 'lobby';
  ui.ready.classList.toggle('hidden', !isLobby);
  ui.ready.textContent = me?.ready ? 'NOT READY' : 'READY';
  ui.start.classList.toggle('hidden', !isLobby || !isHost);
  ui.start.disabled = room.players.length < 4;
  ui.start.textContent = room.players.length < 4 ? `WAITING · ${room.players.length}/4` : 'START GAME';
}

function renderCard(card = state.card) {
  state.card = card;
  if (!card) {
    ui.card.classList.add('hidden');
    return;
  }
  ui.card.classList.remove('hidden');
  ui.card.innerHTML = `<span>${card.role === 'imposter' ? 'YOUR ROLE' : 'YOUR WORD'}</span><strong>${escapeHtml(card.card)}</strong>`;
}

async function shareRoom() {
  if (!state.room) return;
  const code = state.room.code;
  const url = new URL('/', window.location.href);
  url.searchParams.set('room', code);
  const shareData = { title: 'IMPOSTER', text: `Room code: ${code}`, url: url.toString() };
  if (navigator.share) {
    try {
      await navigator.share(shareData);
    } catch (error) {
      if (error.name !== 'AbortError') toast('Could not share the invite.');
    }
  } else if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(`${shareData.text} — ${shareData.url}`);
      toast('Invite copied.');
    } catch {
      toast(`Room code: ${code}`);
    }
  } else {
    toast(`Room code: ${code}`);
  }
}

ui.create.addEventListener('click', createRoom);
ui.joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  joinRoom();
});
ui.copy.addEventListener('click', shareRoom);
ui.ready.addEventListener('click', () => {
  if (state.room) socket.emit('toggleReady', { roomCode: state.room.code });
});
ui.start.addEventListener('click', () => {
  if (state.room) socket.emit('startGame', { roomCode: state.room.code });
});
ui.leave.addEventListener('click', () => {
  socket.emit('leaveRoom');
  state.room = null;
  showRoom(null);
});
ui.players.addEventListener('click', (event) => {
  const button = event.target.closest('[data-vote]');
  if (button && state.room) {
    socket.emit('submitVote', { roomCode: state.room.code, targetId: button.dataset.vote });
  }
});
ui.chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const message = ui.chatInput.value.trim();
  if (!message || !state.room) return;
  socket.emit('sendLobbyChat', { roomCode: state.room.code, text: message });
  ui.chatInput.value = '';
});

ui.playerName.addEventListener('input', () => {
  const username = ui.playerName.value.trim();
  localStorage.setItem('imposterPlayerName', username);
  if (username) ui.authStatus.textContent = username;
});

socket.on('connect', () => {
  const requestedRoom = new URLSearchParams(window.location.search).get('room');
  if (requestedRoom && ui.playerName.value.trim()) joinRoom(requestedRoom);
});
socket.on('roomCreated', ({ code }) => {
  ui.joinCode.value = code;
  toast(`Room ${code}`);
});
socket.on('roomUpdate', (room) => showRoom(room));
socket.on('privateCard', renderCard);
socket.on('gameTick', ({ phase, timeLeft }) => {
  if (state.room?.game) ui.timer.textContent = `${phase.toUpperCase()} · ${timeLeft}s`;
});
socket.on('serverError', ({ message }) => toast(message));

ui.playerName.value = localStorage.getItem('imposterPlayerName') || '';
if (ui.playerName.value) ui.authStatus.textContent = ui.playerName.value;

const requestedRoom = new URLSearchParams(window.location.search).get('room');
if (requestedRoom) ui.joinCode.value = requestedRoom.toUpperCase();

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  ui.install.classList.remove('hidden');
});
ui.install.addEventListener('click', async () => {
  if (!deferredInstallPrompt) {
    toast('Use your browser menu to install.');
    return;
  }
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  ui.install.classList.add('hidden');
});
window.addEventListener('appinstalled', () => ui.install.classList.add('hidden'));

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch((error) => {
      console.error('Service worker registration failed:', error);
    });
  });
}
