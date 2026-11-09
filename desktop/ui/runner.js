// The Runner settings window. It can list the interpreters, environments and programs the
// app found, save the Member's choices, forget remembered approvals and close itself
// (src-tauri/capabilities/runner-settings.json). Everything is put on the page as text.
//
// When a Run named something this computer does not know (an environment, a language), the
// app opens this window to ask; the question is in the view (`ask`), and once it is answered
// the window closes and the Run goes on.
(function () {
  'use strict';
  var $ = function (id) {
    return document.getElementById(id);
  };
  var mainForm = $('main');
  var found = $('found');
  var looking = $('looking');
  var other = $('other');
  var otherPath = $('other-path');
  var folder = $('folder');
  var save = $('save');
  var busy = false;
  var mainTouched = false; // the Member changed the Python or folder choice: keep it on screen
  var view = null;
  var asked = null; // what the window was opened to ask, once read

  var KINDS = { conda: 'conda', pyenv: 'pyenv', venv: 'in the folder', path: 'on PATH', added: 'added by hand' };

  function invoke(command, args) {
    return window.__TAURI_INTERNALS__.invoke(command, args || {});
  }

  function sentence(reason, fallback) {
    return typeof reason === 'string' ? reason : fallback;
  }

  function show(el, message) {
    el.textContent = message || '';
    el.hidden = !message;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function close() {
    invoke('runner_settings_close');
  }

  // One change; the view is read again afterwards. `then` runs after a success.
  function change(what, errorEl, button, then) {
    show(errorEl, '');
    if (button) button.disabled = true;
    return invoke('runner_settings_change', { change: what }).then(
      function () {
        if (then && then() === 'closed') return;
        return reload(false).then(function () {
          if (button) button.disabled = false;
        });
      },
      function (reason) {
        if (button) button.disabled = false;
        show(errorEl, sentence(reason, 'The change could not be saved. Try again.'));
      }
    );
  }

  // ---- Python ------------------------------------------------------------------------------

  // Every interpreter the window knows of, each once: those on PATH, the environments found
  // and those added by hand.
  function interpreters(v) {
    var list = [];
    var seen = {};
    (v.environments || []).forEach(function (env) {
      if (!env || typeof env.path !== 'string' || seen[env.path]) return;
      seen[env.path] = true;
      list.push({ path: env.path, version: env.version, name: env.name, kind: env.kind });
    });
    (v.found || []).forEach(function (python) {
      if (!python || typeof python.path !== 'string' || seen[python.path]) return;
      seen[python.path] = true;
      list.push({ path: python.path, version: python.version, kind: 'path' });
    });
    return list;
  }

  function describe(python) {
    var text = python.version ? 'Python ' + python.version : 'Python (did not answer)';
    if (python.name) text += ' · ' + python.name;
    if (python.kind && KINDS[python.kind]) text += ' (' + KINDS[python.kind] + ')';
    return text;
  }

  function renderPython(v) {
    var previous = mainForm.querySelector('input[name="python"]:checked');
    var keep = mainTouched && previous ? previous.value : null;
    found.textContent = '';
    var current = keep !== null ? keep : v.python && typeof v.python.path === 'string' ? v.python.path : null;
    var listed = false;
    var list = interpreters(v);
    list.forEach(function (python, index) {
      var item = el('li');
      var radio = el('input');
      radio.type = 'radio';
      radio.name = 'python';
      radio.id = 'found-' + index;
      radio.value = python.path;
      radio.setAttribute('form', 'main');
      radio.checked = python.path === current;
      radio.addEventListener('change', function () {
        mainTouched = true;
      });
      listed = listed || radio.checked;
      var label = el('label');
      label.htmlFor = radio.id;
      label.appendChild(document.createTextNode(describe(python)));
      label.appendChild(el('span', 'path', python.path));
      item.appendChild(radio);
      item.appendChild(label);
      if (python.kind === 'added') {
        var remove = el('button', 'quiet', 'Remove');
        remove.type = 'button';
        remove.setAttribute('aria-label', 'Remove the environment ' + python.name);
        remove.addEventListener('click', function () {
          change({ do: 'remove_environment', name: python.name }, $('add-env-error'), remove);
        });
        item.appendChild(remove);
      }
      found.appendChild(item);
    });
    var text =
      list.length === 0
        ? 'Infall found no Python 3 on this computer. Enter the path of one below.'
        : current === null
          ? 'Nothing is chosen yet. Choose the Python that Runs should use.'
          : '';
    show(looking, text);
    if (current !== null && !listed) {
      other.checked = true;
      if (!mainTouched) otherPath.value = current;
    }
    if (!mainTouched) folder.value = typeof v.folder === 'string' ? v.folder : '';
    if (typeof v.overridden === 'string') {
      show($('override'), 'QOOP_PYTHON_BIN is set, so Runs use ' + v.overridden + ' whatever is chosen here.');
    }
  }

  // A <select> of every interpreter, `selected` chosen (added when it is not listed).
  function interpreterSelect(v, selected, id) {
    var select = el('select');
    if (id) select.id = id;
    var list = interpreters(v);
    var has = false;
    list.forEach(function (python) {
      var option = el('option', null, describe(python) + ' — ' + python.path);
      option.value = python.path;
      if (python.path === selected) {
        option.selected = true;
        has = true;
      }
      select.appendChild(option);
    });
    if (selected && !has) {
      var option = el('option', null, selected);
      option.value = selected;
      option.selected = true;
      select.insertBefore(option, select.firstChild);
    }
    return select;
  }

  function renderNames(v) {
    var list = $('names');
    list.textContent = '';
    var names = v.names && typeof v.names === 'object' ? Object.keys(v.names) : [];
    names.sort();
    $('names-empty').hidden = names.length > 0;
    names.forEach(function (name, index) {
      var item = el('li', 'row');
      var label = el('label', 'name', name);
      var select = interpreterSelect(v, String(v.names[name]), 'name-' + index);
      label.htmlFor = select.id;
      select.addEventListener('change', function () {
        change({ do: 'map', name: name, path: select.value }, $('names-error'), select);
      });
      var remove = el('button', 'quiet', 'Remove');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Forget what “' + name + '” means here');
      remove.addEventListener('click', function () {
        change({ do: 'map', name: name, path: null }, $('names-error'), remove);
      });
      item.appendChild(label);
      item.appendChild(select);
      item.appendChild(remove);
      list.appendChild(item);
    });
  }

  // ---- languages ---------------------------------------------------------------------------

  function languageById(v, id) {
    return (v.languages || []).filter(function (l) {
      return l && l.id === id;
    })[0];
  }

  function commandText(program, args) {
    return [program]
      .concat(
        (args || []).map(function (arg) {
          return /[\s"']/.test(arg) || arg === '' ? '"' + String(arg).replace(/"/g, '\\"') + '"' : String(arg);
        })
      )
      .join(' ');
  }

  // A language that is set up: its command, version, switch and Remove.
  function languageRow(language) {
    var box = el('div', 'toolchain');
    box.dataset.lang = language.id;
    var head = el('div', 'row');
    var label = el('label', 'switch-label');
    var toggle = el('input');
    toggle.type = 'checkbox';
    toggle.setAttribute('role', 'switch');
    toggle.checked = !!language.enabled;
    label.appendChild(toggle);
    label.appendChild(document.createTextNode(' ' + language.name));
    head.appendChild(label);
    var state = el(
      'span',
      'muted',
      !language.available
        ? 'Its program is not there any more.'
        : language.version
          ? language.version
          : 'Did not say its version.'
    );
    head.appendChild(state);
    var remove = el('button', 'quiet', 'Remove');
    remove.type = 'button';
    remove.setAttribute('aria-label', 'Remove ' + language.name);
    head.appendChild(remove);
    box.appendChild(head);
    box.appendChild(el('p', 'path', commandText(language.program, language.args)));
    box.appendChild(el('p', 'hint', 'Id ' + language.id + ' · files .' + language.ext));
    var error = el('p', 'error');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    box.appendChild(error);
    toggle.addEventListener('change', function () {
      change({ do: 'enable_language', id: language.id, on: toggle.checked }, error, toggle);
    });
    remove.addEventListener('click', function () {
      change({ do: 'remove_language', id: language.id }, error, remove);
    });
    return box;
  }

  // A preset not set up yet: the programs found, or a path, and "Set up".
  function presetRow(preset) {
    var box = el('form', 'toolchain');
    box.noValidate = true;
    box.dataset.lang = preset.id;
    var head = el('div', 'row');
    head.appendChild(el('strong', null, preset.name));
    head.appendChild(el('span', 'muted', 'Not set up'));
    box.appendChild(head);
    var select = el('select');
    select.id = 'preset-' + preset.id;
    select.setAttribute('aria-label', 'Program for ' + preset.name);
    (preset.found || []).forEach(function (program) {
      var option = el('option', null, program.path + (program.version ? ' — ' + program.version : ''));
      option.value = program.path;
      select.appendChild(option);
    });
    var by = el('option', null, (preset.found || []).length ? 'Another program…' : 'No program found: enter its path…');
    by.value = '';
    select.appendChild(by);
    var path = el('input');
    path.type = 'text';
    path.autocomplete = 'off';
    path.spellcheck = false;
    path.placeholder = 'The full path of the program';
    path.setAttribute('aria-label', 'Full path of the program for ' + preset.name);
    path.hidden = select.value !== '';
    select.addEventListener('change', function () {
      path.hidden = select.value !== '';
      if (!path.hidden) path.focus();
    });
    var button = el('button', 'quiet', 'Set up ' + preset.name);
    button.type = 'submit';
    var row = el('div', 'row');
    row.appendChild(select);
    row.appendChild(button);
    box.appendChild(row);
    box.appendChild(path);
    box.appendChild(el('p', 'hint', 'Started as: <program> {file}, the Run written to main.' + preset.ext + '.'));
    var error = el('p', 'error');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    box.appendChild(error);
    box.addEventListener('submit', function (event) {
      event.preventDefault();
      var program = select.value || path.value.trim();
      if (!program) {
        show(error, 'Choose a program, or enter its full path.');
        path.focus();
        return;
      }
      change(
        { do: 'set_language', id: preset.id, name: preset.name, program: program, args: preset.args, ext: preset.ext },
        error,
        button,
        answeredIf({ lang: preset.id })
      );
    });
    return box;
  }

  function renderLanguages(v) {
    var presets = $('presets');
    var languages = $('languages');
    presets.textContent = '';
    languages.textContent = '';
    var presetIds = {};
    (v.presets || []).forEach(function (preset) {
      presetIds[preset.id] = true;
      var set = languageById(v, preset.id);
      presets.appendChild(set ? languageRow(set) : presetRow(preset));
    });
    (v.languages || []).forEach(function (language) {
      if (!presetIds[language.id]) languages.appendChild(languageRow(language));
    });

    var q = v.qsharp;
    var on = $('qsharp-on');
    on.checked = !!(q && !q.off);
    on.disabled = !v.python && typeof v.overridden !== 'string';
    $('qsharp-state').textContent = on.disabled
      ? 'Choose a Python first: Q# runs through it.'
      : q && !q.off
        ? q.package + ' ' + q.version + ' in the default Python'
        : 'Off';
  }

  // ---- what the window was opened to ask -------------------------------------------------

  function askLabel(lang) {
    var preset = (view && view.presets ? view.presets : []).filter(function (p) {
      return p.id === lang;
    })[0];
    return lang === 'qsharp' ? 'Q#' : preset ? preset.name : lang;
  }

  // After a change: if it answered the question the window was opened for, close it so the
  // Run goes on.
  function answeredIf(what) {
    return function () {
      if (!asked) return;
      if ((what.lang && asked.lang === what.lang) || (what.env && asked.env === what.env)) {
        close();
        return 'closed';
      }
    };
  }

  function renderAsk(v) {
    var ask = v.ask;
    if (!ask || asked) return;
    asked = ask;
    var box = $('ask');
    box.hidden = false;
    if (typeof ask.env === 'string') {
      $('ask-text').textContent =
        'A Run asks for the Python environment “' +
        ask.env +
        '”, and nothing on this computer goes by that name. Choose the one it means here; Infall remembers your choice for that name.';
      var form = $('ask-env');
      form.hidden = false;
      var select = interpreterSelect(v, v.python ? v.python.path : null, 'ask-env-choice');
      $('ask-env-choice').replaceWith(select);
      $('ask-env-use').textContent = 'Use it for “' + ask.env + '”';
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var chosen = $('ask-env-choice').value;
        if (!chosen) {
          show($('ask-env-error'), 'Choose an environment, or add one below first.');
          return;
        }
        change({ do: 'map', name: ask.env, path: chosen }, $('ask-env-error'), $('ask-env-use'), answeredIf({ env: ask.env }));
      });
      select.focus();
    } else if (typeof ask.lang === 'string') {
      var name = askLabel(ask.lang);
      $('ask-text').textContent =
        'A Run is written in ' +
        name +
        ', which is not set up on this computer. Set it up below, or close this window to leave the Run.';
      var target = null;
      if (ask.lang === 'qsharp') {
        target = $('qsharp-on');
      } else {
        var row = document.querySelector('[data-lang="' + CSS.escape(ask.lang) + '"]');
        if (row) {
          row.classList.add('asked');
          target = row.querySelector('select, input[type="checkbox"], button');
        } else {
          $('lang-id').value = ask.lang;
          target = $('lang-name');
        }
      }
      if (target) {
        target.scrollIntoView({ block: 'center' });
        target.focus();
      }
    }
  }

  // ---- the whole view ----------------------------------------------------------------------

  function render(v) {
    view = v;
    renderPython(v);
    renderNames(v);
    renderLanguages(v);
    var count = Number(v.remembered) || 0;
    $('remembered').textContent =
      count === 0
        ? 'No approved code is remembered: every Run asks first.'
        : count === 1
          ? 'Infall remembers 1 approved piece of code and runs exactly that again without asking.'
          : 'Infall remembers ' + count + ' approved pieces of code and runs exactly those again without asking.';
    $('forget').disabled = count === 0;
    renderAsk(v);
  }

  function reload(refresh) {
    return invoke('runner_settings_view', { refresh: !!refresh }).then(render, function (reason) {
      show(looking, sentence(reason, 'Infall could not look for Python on this computer.'));
    });
  }

  // ---- the Member's actions ----------------------------------------------------------------

  otherPath.addEventListener('input', function () {
    other.checked = true;
    mainTouched = true;
    show($('error'), '');
  });
  other.addEventListener('change', function () {
    mainTouched = true;
  });
  folder.addEventListener('input', function () {
    mainTouched = true;
    show($('error'), '');
  });

  mainForm.addEventListener('submit', function (event) {
    event.preventDefault();
    if (busy) return;
    show($('error'), '');
    var picked = mainForm.querySelector('input[name="python"]:checked');
    var python = null;
    if (picked === other) {
      python = otherPath.value.trim();
      if (!python) {
        show($('error'), 'Enter the full path of a Python 3 interpreter, or choose one from the list.');
        otherPath.focus();
        return;
      }
    } else if (picked) {
      python = picked.value;
    }
    busy = true;
    save.disabled = true;
    save.textContent = 'Checking…';
    invoke('runner_settings_save', { python: python, folder: folder.value.trim() || null }).then(
      function () {
        // The app closes this window.
      },
      function (reason) {
        busy = false;
        save.disabled = false;
        save.textContent = 'Save Python and folder';
        show($('error'), sentence(reason, 'The settings could not be saved. Try again.'));
      }
    );
  });

  $('add-env').addEventListener('submit', function (event) {
    event.preventDefault();
    var name = $('add-env-name').value.trim();
    var path = $('add-env-path').value.trim();
    if (!name || !path) {
      show($('add-env-error'), 'Give the environment a name and the full path of its Python.');
      (name ? $('add-env-path') : $('add-env-name')).focus();
      return;
    }
    var button = event.target.querySelector('button');
    change({ do: 'add_environment', name: name, path: path }, $('add-env-error'), button, function () {
      $('add-env-name').value = '';
      $('add-env-path').value = '';
    });
  });

  $('qsharp-on').addEventListener('change', function () {
    var on = $('qsharp-on').checked;
    $('qsharp-state').textContent = on ? 'Asking the default Python for qdk…' : 'Off';
    change({ do: 'qsharp', on: on }, $('qsharp-error'), $('qsharp-on'), on ? answeredIf({ lang: 'qsharp' }) : null).then(
      function () {
        if (!$('qsharp-error').hidden) {
          $('qsharp-on').checked = false;
          renderLanguages(view);
        }
      }
    );
  });

  $('add-lang').addEventListener('submit', function (event) {
    event.preventDefault();
    var id = $('lang-id').value.trim();
    var args = $('lang-args')
      .value.split('\n')
      .map(function (line) {
        return line.replace(/\r$/, '');
      })
      .filter(function (line) {
        return line.trim() !== '';
      });
    var what = {
      do: 'set_language',
      id: id,
      name: $('lang-name').value.trim() || id,
      program: $('lang-program').value.trim(),
      args: args,
      ext: $('lang-ext').value.trim()
    };
    var button = event.target.querySelector('button');
    var after = answeredIf({ lang: id });
    change(what, $('add-lang-error'), button, function () {
      if (after() === 'closed') return 'closed';
      ['lang-id', 'lang-name', 'lang-program', 'lang-ext'].forEach(function (field) {
        $(field).value = '';
      });
      $('lang-args').value = '{file}';
    });
  });

  $('look-again').addEventListener('click', function () {
    var button = $('look-again');
    button.disabled = true;
    button.textContent = 'Looking…';
    reload(true).then(function () {
      button.disabled = false;
      button.textContent = 'Check again';
    });
  });

  $('cancel').addEventListener('click', close);
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') close();
  });

  $('forget').addEventListener('click', function () {
    var forget = $('forget');
    forget.disabled = true;
    invoke('runner_settings_forget').then(
      function () {
        $('remembered').textContent = 'No approved code is remembered: every Run asks first.';
      },
      function (reason) {
        forget.disabled = false;
        show($('error'), sentence(reason, 'The approvals could not be removed.'));
      }
    );
  });

  reload(false);
})();
