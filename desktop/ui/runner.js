// The Runner settings window. It can list the interpreters the app found, save the
// Member's choice, forget remembered approvals and close itself
// (src-tauri/capabilities/runner-settings.json). Everything is put on the page as text.
(function () {
  'use strict';
  var form = document.getElementById('form');
  var found = document.getElementById('found');
  var looking = document.getElementById('looking');
  var other = document.getElementById('other');
  var otherPath = document.getElementById('other-path');
  var folder = document.getElementById('folder');
  var remembered = document.getElementById('remembered');
  var forget = document.getElementById('forget');
  var override = document.getElementById('override');
  var error = document.getElementById('error');
  var save = document.getElementById('save');
  var cancel = document.getElementById('cancel');
  var busy = false;

  function invoke(command, args) {
    return window.__TAURI_INTERNALS__.invoke(command, args || {});
  }

  function showError(message) {
    error.textContent = message;
    error.hidden = !message;
  }

  function setBusy(now) {
    busy = now;
    save.disabled = now;
    save.textContent = now ? 'Checking…' : 'Save';
  }

  function showRemembered(count) {
    remembered.textContent =
      count === 0
        ? 'No approved code is remembered: every Run asks first.'
        : count === 1
          ? 'Sheaf remembers 1 approved piece of code and runs exactly that again without asking.'
          : 'Sheaf remembers ' + count + ' approved pieces of code and runs exactly those again without asking.';
    forget.disabled = count === 0;
  }

  function addChoice(interpreter, index, chosen) {
    var item = document.createElement('li');
    var radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'python';
    radio.id = 'found-' + index;
    radio.value = interpreter.path;
    radio.checked = chosen;
    var label = document.createElement('label');
    label.htmlFor = radio.id;
    label.appendChild(document.createTextNode('Python ' + interpreter.version));
    var path = document.createElement('span');
    path.className = 'path';
    path.textContent = interpreter.path;
    label.appendChild(path);
    item.appendChild(radio);
    item.appendChild(label);
    found.appendChild(item);
  }

  function render(view) {
    var list = Array.isArray(view.found) ? view.found : [];
    var current = view.python && typeof view.python.path === 'string' ? view.python.path : null;
    var listed = false;
    list.forEach(function (interpreter, index) {
      if (!interpreter || typeof interpreter.path !== 'string') return;
      var chosen = interpreter.path === current;
      listed = listed || chosen;
      addChoice({ path: interpreter.path, version: String(interpreter.version) }, index, chosen);
    });
    looking.textContent =
      list.length === 0
        ? 'Sheaf found no Python 3 on this computer. Enter the path of one below.'
        : current === null
          ? 'Nothing is chosen yet. Choose the Python that Runs should use.'
          : '';
    looking.hidden = looking.textContent === '';
    if (current !== null && !listed) {
      other.checked = true;
      otherPath.value = current;
    }
    if (typeof view.folder === 'string') folder.value = view.folder;
    if (typeof view.overridden === 'string') {
      override.textContent =
        'QOOP_PYTHON_BIN is set, so Runs use ' + view.overridden + ' whatever is chosen here.';
      override.hidden = false;
    }
    showRemembered(Number(view.remembered) || 0);
  }

  otherPath.addEventListener('input', function () {
    other.checked = true;
    showError('');
  });
  folder.addEventListener('input', function () {
    showError('');
  });

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (busy) return;
    showError('');
    var picked = form.querySelector('input[name="python"]:checked');
    var python = null;
    if (picked === other) {
      python = otherPath.value.trim();
      if (!python) {
        showError('Enter the full path of a Python 3 interpreter, or choose one from the list.');
        otherPath.focus();
        return;
      }
    } else if (picked) {
      python = picked.value;
    }
    setBusy(true);
    invoke('runner_settings_save', { python: python, folder: folder.value.trim() || null }).then(
      function () {
        // The app closes this window.
      },
      function (reason) {
        setBusy(false);
        showError(typeof reason === 'string' ? reason : 'The settings could not be saved. Try again.');
      }
    );
  });

  cancel.addEventListener('click', function () {
    invoke('runner_settings_close');
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') invoke('runner_settings_close');
  });

  forget.addEventListener('click', function () {
    forget.disabled = true;
    invoke('runner_settings_forget').then(
      function () {
        showRemembered(0);
      },
      function (reason) {
        forget.disabled = false;
        showError(typeof reason === 'string' ? reason : 'The approvals could not be removed.');
      }
    );
  });

  invoke('runner_settings_view').then(render, function (reason) {
    looking.textContent = typeof reason === 'string' ? reason : 'Sheaf could not look for Python on this computer.';
  });
})();
