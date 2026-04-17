const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const WORD_PAIRS = [
  ["Cat", "Dog"], ["Coffee", "Tea"], ["Guitar", "Violin"], ["Pizza", "Burger"],
  ["Sun", "Moon"], ["Beach", "Desert"], ["Apple", "Orange"], ["Rain", "Snow"],
  ["Doctor", "Nurse"], ["Bicycle", "Motorcycle"], ["Piano", "Keyboard"],
  ["Butter", "Cheese"], ["Soccer", "Basketball"], ["Shirt", "Jacket"],
  ["River", "Lake"], ["Train", "Bus"], ["Pen", "Pencil"], ["Sofa", "Chair"],
  ["Cake", "Cookie"], ["Painting", "Drawing"], ["Frog", "Toad"],
  ["Butterfly", "Moth"], ["Dolphin", "Whale"], ["Laptop", "Tablet"],
  ["Candle", "Lamp"], ["Pillow", "Cushion"], ["Jam", "Jelly"],
  ["Boots", "Sneakers"], ["Scarf", "Tie"], ["Soup", "Stew"],
  ["Helicopter", "Airplane"], ["Couch", "Bed"], ["Honey", "Syrup"],
  ["Tiger", "Lion"], ["Sword", "Knife"], ["Castle", "Palace"],
  ["Forest", "Jungle"], ["Yogurt", "Ice Cream"], ["Newspaper", "Magazine"],
  ["Gloves", "Mittens"]
];

const app = express();
app.use(express.static(__dirname));
const httpServer = createServer(app);
const io = new Server(httpServer);

const rooms = {};

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms[code]);
  return code;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function newRoom(code, hostId, hostName) {
  return {
    code,
    hostId,
    players: [{ id: hostId, name: hostName, connected: true }],
    phase: 'lobby',
    round: 0,
    numUndercover: 1,
    numMrWhite: 1,
    roles: {},
    words: {},
    civilianWord: '',
    undercoverWord: '',
    eliminated: [],
    revealed: [],
    votes: {},
    lastElimination: null,
    pendingMrWhite: null,
    result: null,
  };
}

function publicState(room) {
  return {
    code: room.code,
    phase: room.phase,
    round: room.round,
    numUndercover: room.numUndercover,
    numMrWhite: room.numMrWhite,
    players: room.players.map(p => ({
      name: p.name,
      isHost: p.id === room.hostId,
      eliminated: room.eliminated.includes(p.name),
      connected: p.connected,
    })),
    revealed: room.revealed,
    // During voting, we only expose *who* has voted, not their target, so
    // players can't counter-vote based on live tallies.
    votedNames: Object.keys(room.votes),
    lastElimination: room.lastElimination,
    pendingMrWhite: room.pendingMrWhite,
    result: room.result,
  };
}

function broadcastState(code) {
  const room = rooms[code];
  if (!room) return;
  io.to(code).emit('state', publicState(room));
}

function sendPrivate(room, player) {
  if (!player) return;
  const role = room.roles[player.name] || null;
  const word = room.words[player.name] ?? null;
  io.to(player.id).emit('private', { role, word });
}

function sendAllPrivates(room) {
  for (const p of room.players) sendPrivate(room, p);
}

function assignRoles(room) {
  const pair = WORD_PAIRS[Math.floor(Math.random() * WORD_PAIRS.length)];
  const flip = Math.random() < 0.5;
  room.civilianWord = flip ? pair[0] : pair[1];
  room.undercoverWord = flip ? pair[1] : pair[0];

  const names = room.players.map(p => p.name);
  const indices = shuffle([...Array(names.length).keys()]);
  room.roles = {};
  room.words = {};
  let idx = 0;
  for (let i = 0; i < room.numUndercover; i++) {
    room.roles[names[indices[idx]]] = 'undercover';
    room.words[names[indices[idx]]] = room.undercoverWord;
    idx++;
  }
  for (let i = 0; i < room.numMrWhite; i++) {
    room.roles[names[indices[idx]]] = 'mrwhite';
    room.words[names[indices[idx]]] = null;
    idx++;
  }
  for (; idx < names.length; idx++) {
    room.roles[names[indices[idx]]] = 'civilian';
    room.words[names[indices[idx]]] = room.civilianWord;
  }
}

function checkWin(room) {
  const alive = room.players.filter(p => !room.eliminated.includes(p.name));
  const aliveCivilians = alive.filter(p => room.roles[p.name] === 'civilian');
  const aliveInfiltrators = alive.filter(p => room.roles[p.name] !== 'civilian');
  const base = {
    civilianWord: room.civilianWord,
    undercoverWord: room.undercoverWord,
    roles: room.roles,
  };
  if (aliveInfiltrators.length === 0) {
    return { winner: 'civilians', reason: 'All infiltrators have been eliminated!', ...base };
  }
  if (aliveInfiltrators.length >= aliveCivilians.length) {
    return { winner: 'infiltrators', reason: 'The infiltrators have taken over!', ...base };
  }
  return null;
}

function resolveVotes(room) {
  const counts = {};
  for (const target of Object.values(room.votes)) {
    counts[target] = (counts[target] || 0) + 1;
  }
  if (Object.keys(counts).length === 0) return;
  const maxVotes = Math.max(...Object.values(counts));
  const tied = Object.keys(counts).filter(p => counts[p] === maxVotes);

  if (tied.length > 1) {
    room.votes = {};
    room.lastElimination = { tie: true, names: tied };
    broadcastState(room.code);
    return;
  }

  const elim = tied[0];
  const role = room.roles[elim];

  if (role === 'mrwhite') {
    room.phase = 'mrwhite-guess';
    room.pendingMrWhite = elim;
    room.lastElimination = { name: elim, role };
    broadcastState(room.code);
    return;
  }

  room.eliminated.push(elim);
  room.lastElimination = { name: elim, role };
  const win = checkWin(room);
  if (win) {
    room.phase = 'result';
    room.result = win;
  } else {
    room.round++;
    room.phase = 'describe';
    room.votes = {};
  }
  broadcastState(room.code);
}

function resolveMrWhiteFail(room, wrongGuess) {
  const mrWhite = room.pendingMrWhite;
  if (!mrWhite) return;
  room.pendingMrWhite = null;
  room.eliminated.push(mrWhite);
  room.lastElimination = { name: mrWhite, role: 'mrwhite', wrongGuess };
  const win = checkWin(room);
  if (win) {
    room.phase = 'result';
    room.result = win;
  } else {
    room.round++;
    room.phase = 'describe';
    room.votes = {};
  }
  broadcastState(room.code);
}

function maybeAutoAdvanceVote(room) {
  if (room.phase !== 'vote') return;
  const alive = room.players.filter(p => !room.eliminated.includes(p.name));
  const aliveConnected = alive.filter(p => p.connected);
  if (aliveConnected.length === 0) return;
  const allVoted = aliveConnected.every(p => Object.prototype.hasOwnProperty.call(room.votes, p.name));
  if (allVoted) resolveVotes(room);
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentName = null;

  const myRoom = () => currentRoom ? rooms[currentRoom] : null;
  const isHost = () => { const r = myRoom(); return !!(r && r.hostId === socket.id); };

  socket.on('create-room', ({ name }, cb) => {
    name = (name || '').trim();
    if (!name) return cb({ ok: false, error: 'Name required' });
    if (name.length > 20) return cb({ ok: false, error: 'Name too long' });
    const code = makeRoomCode();
    rooms[code] = newRoom(code, socket.id, name);
    socket.join(code);
    currentRoom = code;
    currentName = name;
    cb({ ok: true, code, name });
    broadcastState(code);
  });

  socket.on('join-room', ({ name, code }, cb) => {
    name = (name || '').trim();
    code = (code || '').trim().toUpperCase();
    if (!name) return cb({ ok: false, error: 'Name required' });
    if (name.length > 20) return cb({ ok: false, error: 'Name too long' });
    const room = rooms[code];
    if (!room) return cb({ ok: false, error: 'Room not found' });

    // If player with this name already exists: take over their slot if they
    // appear disconnected OR their old socket is no longer in the pool
    // (handles page refresh where disconnect event hasn't fired yet).
    const existing = room.players.find(p => p.name === name);
    if (existing) {
      const oldStillAlive = existing.id && io.sockets.sockets.has(existing.id);
      if (existing.connected && oldStillAlive && existing.id !== socket.id) {
        return cb({ ok: false, error: 'Name already in use' });
      }
      // If the old socket is a different live socket, force it out
      if (existing.id && existing.id !== socket.id && io.sockets.sockets.has(existing.id)) {
        const oldSock = io.sockets.sockets.get(existing.id);
        if (oldSock) oldSock.disconnect(true);
      }
      existing.id = socket.id;
      existing.connected = true;
      socket.join(code);
      currentRoom = code;
      currentName = name;
      cb({ ok: true, code, name });
      broadcastState(code);
      if (room.phase !== 'lobby') sendPrivate(room, existing);
      return;
    }

    if (room.phase !== 'lobby') return cb({ ok: false, error: 'Game already in progress' });

    room.players.push({ id: socket.id, name, connected: true });
    socket.join(code);
    currentRoom = code;
    currentName = name;
    cb({ ok: true, code, name });
    broadcastState(code);
  });

  socket.on('update-config', ({ numUndercover, numMrWhite }) => {
    const room = myRoom();
    if (!room || !isHost() || room.phase !== 'lobby') return;
    numUndercover = Math.max(1, Math.min(10, +numUndercover || 1));
    numMrWhite = Math.max(0, Math.min(5, +numMrWhite || 0));
    room.numUndercover = numUndercover;
    room.numMrWhite = numMrWhite;
    broadcastState(room.code);
  });

  socket.on('kick-player', ({ name }) => {
    const room = myRoom();
    if (!room || !isHost() || room.phase !== 'lobby') return;
    const idx = room.players.findIndex(p => p.name === name);
    if (idx < 0) return;
    const kicked = room.players[idx];
    if (kicked.id === room.hostId) return;
    io.to(kicked.id).emit('kicked');
    room.players.splice(idx, 1);
    broadcastState(room.code);
  });

  socket.on('start-game', () => {
    const room = myRoom();
    if (!room || !isHost() || room.phase !== 'lobby') return;
    const min = room.numUndercover + room.numMrWhite + 2;
    const connectedCount = room.players.filter(p => p.connected).length;
    if (connectedCount < min) return;
    // Drop disconnected players on game start so they don't get dealt a word
    room.players = room.players.filter(p => p.connected);
    if (!room.players.some(p => p.id === room.hostId)) {
      room.hostId = room.players[0].id;
    }
    assignRoles(room);
    room.phase = 'reveal';
    room.revealed = [];
    room.round = 0;
    room.eliminated = [];
    room.votes = {};
    room.lastElimination = null;
    room.pendingMrWhite = null;
    room.result = null;
    broadcastState(room.code);
    sendAllPrivates(room);
  });

  socket.on('mark-revealed', () => {
    const room = myRoom();
    if (!room || room.phase !== 'reveal') return;
    if (!currentName) return;
    if (!room.players.some(p => p.name === currentName)) return;
    if (!room.revealed.includes(currentName)) {
      room.revealed.push(currentName);
      broadcastState(room.code);
    }
  });

  socket.on('begin-describe', () => {
    const room = myRoom();
    if (!room || !isHost() || room.phase !== 'reveal') return;
    // Only require all CURRENTLY-CONNECTED players to have revealed.
    const needed = room.players.filter(p => p.connected).map(p => p.name);
    const allSeen = needed.every(n => room.revealed.includes(n));
    if (!allSeen) return;
    room.phase = 'describe';
    room.round = 1;
    broadcastState(room.code);
  });

  socket.on('proceed-vote', () => {
    const room = myRoom();
    if (!room || !isHost() || room.phase !== 'describe') return;
    room.phase = 'vote';
    room.votes = {};
    room.lastElimination = null;
    broadcastState(room.code);
  });

  socket.on('cast-vote', ({ target }) => {
    const room = myRoom();
    if (!room || room.phase !== 'vote') return;
    if (!currentName) return;
    if (room.eliminated.includes(currentName)) return;
    const alive = room.players.filter(p => !room.eliminated.includes(p.name));
    if (!alive.find(p => p.name === target)) return;
    if (target === currentName) return;
    room.votes[currentName] = target;
    // Send back the private vote so the client knows what was recorded.
    socket.emit('your-vote', { target });
    broadcastState(room.code);
    maybeAutoAdvanceVote(room);
  });

  socket.on('submit-guess', ({ guess }) => {
    const room = myRoom();
    if (!room || room.phase !== 'mrwhite-guess') return;
    if (currentName !== room.pendingMrWhite) return;
    const clean = (guess || '').trim();
    const mrWhite = room.pendingMrWhite;

    if (clean.toLowerCase() === room.civilianWord.toLowerCase()) {
      room.pendingMrWhite = null;
      room.phase = 'result';
      room.result = {
        winner: 'mrwhite',
        reason: `${mrWhite} (Mr. White) guessed the word correctly!`,
        civilianWord: room.civilianWord,
        undercoverWord: room.undercoverWord,
        roles: room.roles,
      };
      broadcastState(room.code);
      return;
    }

    resolveMrWhiteFail(room, clean || '(blank)');
  });

  socket.on('play-again', () => {
    const room = myRoom();
    if (!room || !isHost() || room.phase !== 'result') return;
    room.phase = 'lobby';
    room.roles = {};
    room.words = {};
    room.civilianWord = '';
    room.undercoverWord = '';
    room.eliminated = [];
    room.revealed = [];
    room.votes = {};
    room.lastElimination = null;
    room.pendingMrWhite = null;
    room.result = null;
    room.round = 0;
    room.players = room.players.filter(p => p.connected);
    if (room.players.length === 0) {
      delete rooms[room.code];
      return;
    }
    if (!room.players.some(p => p.id === room.hostId)) {
      room.hostId = room.players[0].id;
    }
    broadcastState(room.code);
  });

  socket.on('disconnect', () => {
    const room = myRoom();
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    if (room.phase === 'lobby') {
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.players.length === 0) {
        delete rooms[room.code];
        return;
      }
      if (room.hostId === socket.id) {
        room.hostId = room.players[0].id;
      }
      broadcastState(room.code);
      return;
    }

    player.connected = false;

    // Host migration
    if (room.hostId === socket.id) {
      const next = room.players.find(p => p.connected);
      if (next) room.hostId = next.id;
    }

    // If the pending Mr. White dropped while waiting to guess, count it as a wrong guess.
    if (room.phase === 'mrwhite-guess' && room.pendingMrWhite === player.name) {
      resolveMrWhiteFail(room, '(disconnected)');
      return;
    }

    // If we were in the middle of a vote, the remaining connected players
    // may now all have voted without this player.
    broadcastState(room.code);
    maybeAutoAdvanceVote(room);
  });
});

const PORT = process.env.PORT || 7750;
httpServer.listen(PORT, () => {
  console.log(`Undercover server running on http://localhost:${PORT}`);
});
