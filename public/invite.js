const links = document.querySelector('#invite-links');
const status = document.querySelector('#invite-status');
const template = document.querySelector('#invite-template');

async function copyLink(input, button, feedback) {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(input.value);
      feedback.textContent = 'Link copied.';
      return;
    }
  } catch {
    // The browser may deny clipboard access. Try copying the selected field.
  }

  input.select();
  if (document.execCommand('copy')) {
    button.focus();
    feedback.textContent = 'Link copied.';
  } else {
    feedback.textContent = 'Use your browser’s copy command on the selected link.';
  }
}

async function showLinks() {
  try {
    const response = await fetch('/join-links');
    if (!response.ok) throw new Error('Game links unavailable');
    const addresses = await response.json();
    status.textContent = addresses.length ? '' : 'No local network address found. Connect this computer to the network and restart the game server.';

    for (const { url, qr } of addresses) {
      const card = template.content.cloneNode(true);
      const input = card.querySelector('input');
      const button = card.querySelector('button');
      const feedback = card.querySelector('.copy-status');
      input.value = url;
      card.querySelector('.invite-qr').href = url;
      card.querySelector('.invite-qr img').src = qr;
      card.querySelector('.invite-open').href = url;
      button.addEventListener('click', () => copyLink(input, button, feedback));
      links.append(card);
    }
  } catch {
    status.textContent = 'Could not load the game links. Check that the server is running and reload this page.';
  }
}

showLinks();
