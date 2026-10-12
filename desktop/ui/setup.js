// The first-run screen. It can do two things in the app, and nothing else: read the saved
// server address and save a new one (src-tauri/capabilities/setup.json).
(function () {
  'use strict';
  var form = document.getElementById('form');
  var input = document.getElementById('address');
  var error = document.getElementById('error');
  var button = document.getElementById('connect');
  var busy = false;

  function invoke(command, args) {
    return window.__TAURI_INTERNALS__.invoke(command, args || {});
  }

  function showError(message) {
    error.textContent = message;
    error.hidden = !message;
    if (message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }

  function setBusy(now) {
    busy = now;
    button.textContent = now ? 'Connecting…' : 'Connect';
    if (now) button.setAttribute('aria-busy', 'true');
    else button.removeAttribute('aria-busy');
  }

  input.addEventListener('input', function () {
    showError('');
  });

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (busy) return;
    showError('');
    setBusy(true);
    invoke('setup_save', { address: input.value }).then(
      function () {
        // The app opens the server's UI and closes this window.
      },
      function (reason) {
        setBusy(false);
        showError(typeof reason === 'string' ? reason : 'The address could not be checked. Try again.');
        input.focus();
      }
    );
  });

  invoke('setup_current').then(
    function (saved) {
      if (typeof saved === 'string' && !input.value) input.value = saved;
      input.focus();
    },
    function () {
      input.focus();
    }
  );
})();
