const socket = io();
const joinForm = document.querySelector('#join');
const board = document.querySelector('#board');
const game = document.querySelector('#game');
const players = document.querySelector('#players');
const error = document.querySelector('#error');
const connection = document.querySelector('#connection');
const returnDialog = document.querySelector('#return-dialog');
const packSelector = document.querySelector('#pack-selector');
const packSummary = document.querySelector('#pack-summary');
const packOptions = document.querySelector('#pack-options');
const packHelp = document.querySelector('#pack-help');
const packInputs = new Map();
const handSettings = document.querySelector('#hand-settings');
const handSizeInput = document.querySelector('#hand-size');
let savedHandSize = 10;
let token = sessionStorage.getItem('bad-answers-player');
let selectedRound;
const selectedCards = [];

function join(name) {
  error.textContent = '';
  socket.timeout(5000).emit('join', { name, token }, (timeout, response) => {
    if (timeout || response.error) {
      token = null;
      sessionStorage.removeItem('bad-answers-player');
      joinForm.hidden = false;
      error.textContent = timeout ? 'The host did not respond. Try again.' : response.error;
      return;
    }
    token = response.token;
    sessionStorage.setItem('bad-answers-player', token);
    joinForm.hidden = true;
  });
}

socket.on('connect', () => {
  connection.textContent = 'Connected';
  if (token) join();
  else joinForm.hidden = false;
});
socket.on('disconnect', () => {
  if (returnDialog.open) returnDialog.close('cancel');
  connection.textContent = 'Disconnected · reconnecting…';
  game.hidden = true;
  joinForm.hidden = true;
});
joinForm.addEventListener('submit', event => {
  event.preventDefault();
  join(document.querySelector('#name').value);
});

function showJoinForm() {
  token = null;
  sessionStorage.removeItem('bad-answers-player');
  game.hidden = true;
  joinForm.hidden = false;
  document.querySelector('#name').focus();
}

socket.on('kicked', () => {
  showJoinForm();
  error.textContent = 'The host removed you from the lobby.';
});

function element(tag, text, parent, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  parent.append(node);
  return node;
}

function confirmReturnToLobby() {
  returnDialog.returnValue = '';
  return new Promise(resolve => {
    returnDialog.addEventListener('close', () => {
      resolve(returnDialog.returnValue === 'confirm');
    }, { once: true });
    returnDialog.showModal();
  });
}

function button(parent, label, type, card, className, round) {
  const control = element('button', label, parent, className);
  control.addEventListener('click', async () => {
    if (type === 'reset' && !await confirmReturnToLobby()) return;

    error.textContent = '';
    control.disabled = true;
    socket.timeout(5000).emit('action', { type, card, round }, (timeout, response) => {
      control.disabled = false;
      error.textContent = timeout ? 'The host did not respond. Try again.' : (response.error || '');
      if (type === 'leave' && !timeout && !response.error) {
        showJoinForm();
      }
    });
  });
  return control;
}

const lobbyActions = document.querySelector('#lobby-actions');
const returnToLobby = button(lobbyActions, 'Return to lobby', 'reset', undefined, 'secondary');
returnToLobby.hidden = true;
button(lobbyActions, 'Leave lobby', 'leave', undefined, 'secondary');
const packBulkActions = document.querySelector('#pack-bulk-actions');
button(packBulkActions, 'Select all', 'packs', 'all', 'secondary');
button(packBulkActions, 'Clear all', 'packs', 'none', 'secondary');

handSizeInput.addEventListener('change', () => {
  error.textContent = '';
  handSizeInput.disabled = true;
  const card = Number(handSizeInput.value);
  socket.timeout(5000).emit('action', { type: 'hand-size', card }, (timeout, response) => {
    handSizeInput.disabled = false;
    if (timeout || response.error) {
      handSizeInput.value = savedHandSize;
      error.textContent = timeout ? 'The host did not respond. Try again.' : response.error;
    }
  });
});

function showPackSelection(selection) {
  packSelector.hidden = !selection?.packs;
  if (packSelector.hidden) return;

  if (!packInputs.size) {
    for (const { id, name, prompts, answers } of selection.packs) {
      const label = element('label', '', packOptions, 'pack-option');
      const input = element('input', '', label);
      input.type = 'checkbox';
      element('span', name + ' (' + prompts + ' prompts, ' + answers + ' answers)', label);
      input.addEventListener('change', () => {
        const enabled = input.checked;
        error.textContent = '';
        socket.timeout(5000).emit('action', { type: 'packs', card: { id, enabled } }, (timeout, response) => {
          if (timeout || response.error) {
            if (input.checked === enabled) input.checked = !enabled;
            error.textContent = timeout ? 'The host did not respond. Try again.' : response.error;
          }
        });
      });
      packInputs.set(id, input);
    }
  }
  const selected = new Set(selection.selected);
  for (const [id, input] of packInputs) input.checked = selected.has(id);
  packSummary.textContent = 'Card packs (' + selected.size + ' selected)';
  packHelp.hidden = selection.playable;
}

socket.on('state', state => {
  if (selectedRound !== state.round || state.phase !== 'submit' || state.submitted) {
    selectedCards.length = 0;
    selectedRound = state.round;
  }
  game.hidden = false;
  board.replaceChildren();
  const openPlayerMenu = players.querySelector('.player-menu[open]')?.dataset.playerId;
  players.replaceChildren();
  const isHost = state.you === state.host;
  handSettings.hidden = !state.handSettings;
  if (state.handSettings) {
    if (!handSizeInput.options.length) {
      for (let size = state.handSettings.min; size <= state.handSettings.max; size++) {
        element('option', size + ' cards', handSizeInput).value = size;
      }
    }
    savedHandSize = state.handSettings.size;
    handSizeInput.value = savedHandSize;
  }
  showPackSelection(state.deckSelection);
  const judge = state.players.find(player => player.id === state.judge);
  const canStart = state.players.filter(player => player.online).length >= 3;
  for (const player of state.players) {
    const row = element('li', '', players);
    const canManage = isHost && player.id !== state.you;
    const menu = canManage ? element('details', '', row, 'player-menu') : null;
    const identity = menu ? element('summary', '', menu) : element('span', '', row);
    element('span', player.name, identity).style.color = player.color;
    if (player.submission) {
      const submitted = player.submission === 'submitted';
      const status = element('span', submitted ? '✓' : '', identity, 'submission-status');
      status.style.color = player.color;
      status.setAttribute('role', 'img');
      status.setAttribute('aria-label', submitted ? 'Answer submitted' : 'Waiting for answer');
      if (!submitted) {
        status.classList.add('submission-waiting');
        for (let dot = 0; dot < 3; dot++) element('span', '.', status);
      }
    }
    identity.append((player.id === state.you ? ' (you)' : '')
      + (player.id === state.host ? ' · host' : '') + (!player.online ? ' · away' : ''));
    if (menu) {
      menu.dataset.playerId = player.id;
      menu.name = 'player-actions';
      menu.open = player.id === openPlayerMenu;
      const actions = element('div', '', menu, 'player-menu-actions');
      button(actions, 'Transfer host', 'transfer-host', player.id, 'secondary').disabled =
        player.bot || !player.online;
      button(actions, 'Kick player', 'kick-player', player.id, 'secondary');
    }
    element('strong', player.score, row);
  }
  returnToLobby.hidden = !isHost || state.phase === 'lobby';
  if (returnToLobby.hidden && returnDialog.open) returnDialog.close('cancel');
  if (state.phase === 'lobby') {
    element('h2', 'Lobby', board);
    element('p', isHost ? 'Invite friends over Wi-Fi or add two bots to try a match on your own.'
      : 'You’re in. The host will start the match.', board);
    if (isHost) {
      const actions = element('div', '', board, 'actions');
      button(actions, 'Start match', 'start').disabled = !canStart || state.deckSelection?.playable === false;
      button(actions, 'Add bot', 'bots', undefined, 'secondary').disabled =
        state.players.length >= 10 || state.players.filter(player => player.bot).length >= 2;
    }
    return;
  }
  const heading = element('h2', 'Round ' + state.round, board);
  if (judge) {
    heading.append(' · Judge: ');
    element('span', judge.name, heading).style.color = judge.color;
  }
  const promptText = state.prompt.replace(/(?<![\p{L}\p{N}])_+(?![\p{L}\p{N}])/gu, '_________');
  element('p', promptText, board, 'prompt');
  if (state.phase === 'submit') {
    if (state.you === state.judge) {
      element('p', 'Waiting for players to submit.', board);
    } else {
      const pickCount = state.pickCount ?? 1;
      element('p', state.submitted ? 'Answer submitted.' : pickCount === 1
        ? 'Tap a card to submit your answer.' : 'Select ' + pickCount + ' cards in the order you want to play them.', board);
      element('h2', 'Your hand', board);
      const cards = element('div', '', board, 'cards');
      if (!state.submitted && pickCount > 1) {
        const controls = state.hand.map(card => {
          const control = element('button', card.text, cards, 'card');
          control.addEventListener('click', () => {
            const index = selectedCards.indexOf(card.id);
            if (index !== -1) selectedCards.splice(index, 1);
            else if (selectedCards.length < pickCount) selectedCards.push(card.id);
            updateSelection();
          });
          return { card, control };
        });
        const submit = button(board, 'Submit answer', 'submit', selectedCards, undefined, state.round);
        function updateSelection() {
          for (const { card, control } of controls) {
            const position = selectedCards.indexOf(card.id) + 1;
            control.setAttribute('aria-pressed', String(position > 0));
            control.textContent = position ? position + '. ' + card.text : card.text;
          }
          submit.disabled = selectedCards.length !== pickCount;
        }
        updateSelection();
      } else {
        for (const card of state.hand) {
          if (state.submitted) {
            element('div', card.text, cards, 'card hand-card');
          } else {
            button(cards, card.text, 'submit', card.id, 'card', state.round);
          }
        }
      }
    }
  } else if (state.phase === 'judge') {
    element('p', state.you === state.judge ? 'Pick the winning answer.' : 'Waiting for the judge.', board);
    if (state.choices.length) {
      const cards = element('div', '', board, 'cards');
      for (const card of state.choices) {
        const parts = card.parts ?? [card.text];
        if (parts.length === 1) {
          button(cards, parts[0], 'pick', card.id, 'card', state.round);
          continue;
        }
        const choice = button(cards, '', 'pick', card.id, 'card answer-group', state.round);
        parts.forEach((part, index) => {
          const row = element('span', '', choice, 'answer-part');
          element('span', (index + 1) + '.', row, 'answer-part-number');
          element('span', part, row);
        });
      }
    }
  } else {
    const result = element('h2', '', board, 'round-winner');
    element('span', state.winner.name, result).style.color = state.winner.color;
    result.append(' wins the round');
    element('p', state.winner.text, board, 'winning-answer');
  }
  if (state.phase === 'result' && state.you === state.nextRoundPlayer) {
    const actions = element('div', '', board, 'actions');
    button(actions, canStart ? 'Next round' : 'Back to lobby', 'next');
  } else if (state.phase === 'result' && judge?.bot) {
    element('p', canStart ? 'Next round starts shortly.' : 'Returning to the lobby shortly.', board);
  }
});
