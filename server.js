const express = require('express');
const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');
const { networkInterfaces } = require('node:os');
const { join } = require('node:path');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { packs } = require('./cah-official-deck.json');
const defaultHandSize = 10;
const minHandSize = 3;
const maxHandSize = 20;
const packOptions = packs.map((pack, id) => ({
  id, name: pack.name, prompts: pack.black.length, answers: pack.white.length
}));
let selectedPacks = new Set(packOptions.map(pack => pack.id));
let answerCards = packs.flatMap(pack => pack.white.map(card => card.text));
let promptCards = packs.flatMap(pack => pack.black);
const playerColors = [
  '#ffb3c6', '#b6d9ff', '#b9edc9', '#ffe4a3', '#d6baff',
  '#ffc39f', '#a4ece7', '#f5baf1', '#dceca7', '#bfc9ff'
];

const app = express();
const server = createServer(app);
const io = new Server(server);
const port = Number(process.env.PORT || 3000);
const lanUrls = Object.values(networkInterfaces()).flat()
  .filter(address => address.family === 'IPv4' &&
    /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address.address))
  .map(address => `http://${address.address}:${port}`);

app.use(express.static(join(__dirname, 'public')));
app.get('/join-links', async (_request, response) => {
  response.json(await Promise.all(lanUrls.map(async url => ({
    url, qr: await QRCode.toDataURL(url)
  }))));
});

const players = new Map();
let host;
let phase = 'lobby';
let seats = [];
let judgeIndex = -1;
let round = 0;
let prompt;
let submissions = [];
let submissionsShown = false;
let winner;
let answers = [];
let prompts = [];
let handSize = defaultHandSize;
let previewPickCount = Number(process.env.PREVIEW_PICK_COUNT);

function availableColor() {
  const used = new Set([...players.values()].map(player => player.color));
  return playerColors.find(color => !used.has(color));
}

function shuffle(items) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
  }
  return shuffled;
}

function drawAnswer() {
  if (!answers.length) answers = shuffle(answerCards);
  return { id: randomUUID(), text: answers.pop() };
}

function setPackSelection(selection) {
  if (selection === 'all' || selection === 'none') {
    selectedPacks = new Set(selection === 'all' ? packOptions.map(pack => pack.id) : []);
  } else {
    const { id, enabled } = selection ?? {};
    if (!Number.isInteger(id) || !packs[id] || typeof enabled !== 'boolean') return false;
    if (enabled) selectedPacks.add(id);
    else selectedPacks.delete(id);
  }
  const blend = packs.filter((_, id) => selectedPacks.has(id));
  answerCards = blend.flatMap(pack => pack.white.map(card => card.text));
  promptCards = blend.flatMap(pack => pack.black);
  answers = prompts = [];
  for (const player of players.values()) player.hand = [];
  return true;
}

function publish() {
  const submitted = new Set(submissions.map(entry => entry.player));
  const judge = seats[judgeIndex];
  const scoreboard = [...players.values()].map(player => {
    const { id, name, score, socket, bot, color } = player;
    const submission = phase === 'submit' && seats.includes(player) && player !== judge
      ? (submitted.has(player) ? 'submitted' : 'waiting') : undefined;
    return { id, name, score, bot, color, online: Boolean(socket || bot), submission };
  });
  for (const player of players.values()) {
    if (!player.socket) continue;
    const isJudging = phase === 'judge' && judge === player;
    if (isJudging) submissionsShown = true;
    player.socket.emit('state', {
      you: player.id, host, phase, round, prompt: prompt?.text, pickCount: prompt?.pick, winner,
      judge: judge?.id,
      nextRoundPlayer: phase === 'result' ? nextRoundPlayer()?.id : undefined,
      handSettings: phase === 'lobby' && player.id === host
        ? { size: handSize, min: minHandSize, max: maxHandSize } : undefined,
      deckSelection: phase === 'lobby' ? {
        packs: player.id === host ? packOptions : undefined,
        selected: [...selectedPacks],
        playable: Boolean(answerCards.length && promptCards.length)
      } : undefined,
      players: scoreboard,
      hand: player === judge ? [] : player.hand,
      submitted: submitted.has(player),
      count: submissions.length,
      choices: isJudging
        ? submissions.map(({ id, cards }) => {
          const parts = cards.map(card => card.text);
          return { id, parts, text: parts.join('\n') };
        }) : []
    });
  }
}

function startRound() {
  const active = [...players.values()].filter(player => player.bot || player.socket);
  const rotation = [...seats.slice(judgeIndex + 1), ...seats.slice(0, judgeIndex + 1)];
  const nextJudge = rotation.find(player => active.includes(player));
  seats = active;
  judgeIndex = nextJudge ? seats.indexOf(nextJudge) : 0;
  if (!prompts.length) prompts = shuffle(promptCards);
  const previewIndex = prompts.findIndex(card => card.pick === previewPickCount);
  if (previewIndex >= 0) {
    [prompt] = prompts.splice(previewIndex, 1);
    previewPickCount = undefined;
  } else {
    prompt = prompts.pop();
  }
  round++;
  phase = 'submit';
  submissions = [];
  submissionsShown = false;
  winner = undefined;
  for (const player of seats) {
    while (player.hand.length < handSize) player.hand.push(drawAnswer());
    if (player.bot && player !== seats[judgeIndex]) {
      submit(player, player.hand.slice(0, prompt.pick).map(card => card.id));
    }
  }
  publish();
}

function submit(player, selection) {
  if (phase !== 'submit' || !seats.includes(player) || player === seats[judgeIndex]
      || submissions.some(entry => entry.player === player)) return false;
  const ids = Array.isArray(selection) ? selection : [selection];
  if (ids.length !== prompt.pick || new Set(ids).size !== ids.length) return false;
  const cards = ids.map(id => player.hand.find(card => card.id === id));
  if (cards.some(card => !card)) return false;
  player.hand = player.hand.filter(card => !ids.includes(card.id));
  submissions.push({ id: randomUUID(), cards, player });
  advanceToJudging();
  publish();
  return true;
}

function advanceToJudging() {
  if (phase === 'submit' && submissions.length === seats.length - 1) {
    phase = 'judge';
    submissions = shuffle(submissions);
    if (seats[judgeIndex].bot) {
      const judgingSubmissions = submissions;
      setTimeout(() => {
        if (phase === 'judge' && submissions === judgingSubmissions) pick(submissions[0]?.id);
      }, 900);
    }
  }
}

function pick(cardId) {
  const entry = submissions.find(card => card.id === cardId);
  if (!entry) return false;
  entry.player.score++;
  winner = { name: entry.player.name, color: entry.player.color,
    text: entry.cards.map(card => card.text).join('\n') };
  phase = 'result';
  if (seats[judgeIndex].bot) {
    const result = winner;
    setTimeout(() => {
      if (phase === 'result' && winner === result) advanceRound();
    }, 5000);
  }
  publish();
  return true;
}

function nextRoundPlayer() {
  const judge = seats[judgeIndex];
  if (judge?.bot) return;
  if (judge?.socket) return judge;
  const hostPlayer = players.get(host);
  return hostPlayer?.socket ? hostPlayer : [...players.values()].find(player => player.socket);
}

function advanceRound() {
  const active = [...players.values()].filter(player => player.bot || player.socket);
  if (active.length >= 3 && active.some(player => player.socket)) {
    startRound();
  } else {
    openLobby();
    publish();
  }
}

function openLobby() {
  phase = 'lobby';
  seats = [];
  judgeIndex = -1;
  prompt = winner = undefined;
  submissions = [];
  submissionsShown = false;
}

function resetMatch() {
  openLobby();
  round = 0;
  answers = prompts = [];
  for (const seat of players.values()) {
    if (seat.bot || !seat.socket) players.delete(seat.id);
    seat.score = 0;
    seat.hand = [];
  }
}

function leave(player) {
  const midRound = phase === 'submit' || phase === 'judge';
  const seatIndex = seats.indexOf(player);
  const judgeLeft = midRound && seats[judgeIndex] === player;
  if (midRound) {
    if (judgeLeft && !submissionsShown) {
      for (const { player: submitter, cards } of submissions) {
        submitter.hand.push(...cards);
      }
    }
    const submittedIndex = submissions.findIndex(entry => entry.player === player);
    if (submittedIndex !== -1) {
      const [{ cards }] = submissions.splice(submittedIndex, 1);
      if (!submissionsShown) answers.unshift(...cards.map(card => card.text));
    }
    if (!judgeLeft && seatIndex !== -1) {
      seats.splice(seatIndex, 1);
      if (seatIndex < judgeIndex) judgeIndex--;
    }
  }

  // Draws pop from the end, so returned cards go beneath the unused cards.
  answers.unshift(...player.hand.map(card => card.text));
  players.delete(player.id);
  player.socket = undefined;
  const remaining = [...players.values()];
  if (host === player.id) {
    host = remaining.find(seat => seat.socket)?.id ?? remaining.find(seat => !seat.bot)?.id;
  }
  const connected = remaining.filter(seat => seat.bot || seat.socket);
  if (!remaining.some(seat => !seat.bot)) {
    resetMatch();
    setPackSelection('all');
    handSize = defaultHandSize;
  } else if (phase !== 'lobby' && !connected.some(seat => !seat.bot)) {
    openLobby();
  } else if (judgeLeft) {
    if (connected.length >= 3) {
      startRound();
      return;
    }
    openLobby();
  } else if (midRound) {
    if (seats.length < 2) openLobby();
    else advanceToJudging();
  }
  publish();
}

io.on('connection', socket => {
  let player;
  socket.on('join', (input, reply) => {
    if (typeof reply !== 'function') return;
    if (player?.socket === socket) return reply({ token: player.token });
    const existing = typeof input?.token === 'string' &&
      [...players.values()].find(seat => seat.token === input.token);
    if (existing && !existing.bot) {
      player = existing;
    } else {
      const name = typeof input?.name === 'string' ? input.name.trim().slice(0, 24) : '';
      if (!name) return reply({ error: 'Enter a nickname to join.' });
      if (phase !== 'lobby') return reply({ error: 'A match is underway. Ask the host to return to the lobby.' });
      const color = availableColor();
      if (!color) return reply({ error: 'The lobby is full (10 players).' });
      player = { id: randomUUID(), token: randomUUID(), name, color, score: 0, hand: [] };
      players.set(player.id, player);
    }
    const oldSocket = player.socket;
    player.socket = socket;
    if (phase === 'lobby' && !players.get(host)?.socket) host = player.id;
    oldSocket?.disconnect();
    reply({ token: player.token });
    publish();
  });

  socket.on('action', (input, reply) => {
    if (typeof reply !== 'function') return;
    if (!player && input?.type === 'leave') return reply({});
    if (!player || player.socket !== socket) return reply({ error: 'Join the lobby first.' });
    const isHost = player.id === host;
    const active = [...players.values()].filter(seat => seat.bot || seat.socket);
    switch (input?.type) {
      case 'transfer-host': {
        if (!isHost) break;
        const recipient = players.get(input.card);
        if (!recipient?.socket || recipient === player) {
          return reply({ error: 'Choose another connected player.' });
        }
        host = recipient.id;
        publish();
        return reply({});
      }
      case 'kick-player': {
        if (!isHost) break;
        const target = players.get(input.card);
        if (!target || target === player) return reply({ error: 'Choose another player.' });
        const targetSocket = target.socket;
        leave(target);
        targetSocket?.emit('kicked');
        return reply({});
      }
      case 'leave':
        leave(player);
        player = undefined;
        return reply({});
      case 'bots': {
        if (!isHost || phase !== 'lobby') break;
        const name = ['Bot Waffle', 'Bot Pickle'].find(name =>
          !active.some(seat => seat.bot && seat.name === name));
        const color = availableColor();
        if (!name || !color) {
          return reply({ error: 'There is no room for another bot.' });
        }
        const id = randomUUID();
        players.set(id, { id, name, color, bot: true, score: 0, hand: [] });
        publish();
        return reply({});
      }
      case 'packs':
        if (!isHost || phase !== 'lobby' || !setPackSelection(input.card)) break;
        publish();
        return reply({});
      case 'hand-size':
        if (!isHost || phase !== 'lobby') break;
        if (!Number.isInteger(input.card) || input.card < minHandSize || input.card > maxHandSize) {
          return reply({ error: `Choose a hand size from ${minHandSize} to ${maxHandSize}.` });
        }
        handSize = input.card;
        for (const seat of players.values()) {
          const returned = seat.hand.splice(handSize);
          answers.unshift(...returned.map(card => card.text));
        }
        publish();
        return reply({});
      case 'start':
        if (!isHost || phase !== 'lobby' || active.length < 3) break;
        if (!answerCards.length || !promptCards.length) {
          return reply({ error: 'Select packs with at least one prompt and one answer.' });
        }
        startRound();
        return reply({});
      case 'next':
        if (phase !== 'result' || player !== nextRoundPlayer()) break;
        advanceRound();
        return reply({});
      case 'submit':
        if ((input.round === undefined || input.round === round) && submit(player, input.card)) {
          return reply({});
        }
        break;
      case 'pick':
        if (phase !== 'judge' || player !== seats[judgeIndex]) break;
        if ((input.round === undefined || input.round === round) && pick(input.card)) return reply({});
        return reply({ error: 'That answer is no longer available. Choose one of the current answers.' });
      case 'reset':
        if (!isHost) break;
        resetMatch();
        publish();
        return reply({});
    }
    reply({ error: 'That move is unavailable right now.' });
  });

  socket.on('disconnect', () => {
    if (player?.socket !== socket) return;
    player.socket = undefined;
    if (phase === 'lobby') {
      if (host === player.id) host = [...players.values()].find(seat => seat.socket)?.id ?? host;
    }
    publish();
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Local: http://localhost:${port}`);
  for (const url of lanUrls) console.log(`Wi-Fi: ${url}`);
});
