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
  var rowMenu = $('row-menu');
  var scrim = $('add-lang-scrim');
  var dialog = $('add-lang-dialog');
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

  // ---- a row's ⋯ menu (one open at a time) --------------------------------------------------

  var menuOwner = null; // the ⋯ button whose menu is open

  function closeRowMenu(refocus) {
    if (!menuOwner) return;
    var owner = menuOwner;
    menuOwner = null;
    rowMenu.hidden = true;
    rowMenu.textContent = '';
    owner.setAttribute('aria-expanded', 'false');
    if (refocus && document.body.contains(owner)) owner.focus();
  }

  function placeMenu(button) {
    var r = button.getBoundingClientRect();
    rowMenu.style.left = '0px';
    rowMenu.style.top = '0px';
    var w = rowMenu.offsetWidth;
    var h = rowMenu.offsetHeight;
    var vw = document.documentElement.clientWidth;
    var vh = document.documentElement.clientHeight;
    var left = Math.max(8, Math.min(r.right - w, vw - w - 8));
    var top = r.bottom + 4;
    if (top + h > vh - 8) top = Math.max(8, r.top - h - 4);
    rowMenu.style.left = Math.round(left) + 'px';
    rowMenu.style.top = Math.round(top) + 'px';
  }

  // A ⋯ button for a row: `label` names the row; `items` are { text, danger, run }.
  function moreButton(label, items) {
    var button = el('button', 'btn sm ico more');
    button.type = 'button';
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-label', 'More for ' + label);
    button.title = items
      .map(function (item) {
        return item.text;
      })
      .join(', ');
    button.appendChild(dots());
    function open(focusLast) {
      closeRowMenu(false);
      menuOwner = button;
      rowMenu.textContent = '';
      rowMenu.setAttribute('aria-label', label);
      var buttons = items.map(function (item) {
        var mi = el('button', 'mi' + (item.danger ? ' danger-text' : ''), item.text);
        mi.type = 'button';
        mi.setAttribute('role', 'menuitem');
        mi.tabIndex = -1;
        mi.addEventListener('click', function () {
          closeRowMenu(true);
          item.run(button);
        });
        rowMenu.appendChild(mi);
        return mi;
      });
      rowMenu.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      placeMenu(button);
      (focusLast ? buttons[buttons.length - 1] : buttons[0]).focus();
    }
    button.addEventListener('click', function () {
      if (menuOwner === button) closeRowMenu(true);
      else open(false);
    });
    button.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        open(event.key === 'ArrowUp');
      }
    });
    return button;
  }

  function dots() {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('class', 'more-glyph');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    [3.5, 8, 12.5].forEach(function (cx) {
      var c = document.createElementNS(ns, 'circle');
      c.setAttribute('cx', String(cx));
      c.setAttribute('cy', '8');
      c.setAttribute('r', '1.4');
      svg.appendChild(c);
    });
    return svg;
  }

  rowMenu.addEventListener('keydown', function (event) {
    var items = Array.prototype.slice.call(rowMenu.querySelectorAll('[role="menuitem"]'));
    var i = items.indexOf(document.activeElement);
    var next = -1;
    if (event.key === 'ArrowDown') next = (i + 1) % items.length;
    else if (event.key === 'ArrowUp') next = (i - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeRowMenu(true);
      return;
    } else if (event.key === 'Tab') {
      closeRowMenu(true);
      return;
    }
    if (next >= 0) {
      event.preventDefault();
      items[next].focus();
    }
  });
  document.addEventListener('mousedown', function (event) {
    if (!menuOwner) return;
    if (rowMenu.contains(event.target) || menuOwner.contains(event.target)) return;
    closeRowMenu(false);
  });
  window.addEventListener('resize', function () {
    closeRowMenu(false);
  });
  document.addEventListener(
    'scroll',
    function () {
      closeRowMenu(false);
    },
    true
  );

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

  function baseName(path) {
    var parts = String(path).split(/[\\/]/);
    return parts[parts.length - 1] || String(path);
  }

  // The short name of an interpreter in its row: where it comes from and its name
  // ("conda · lab"), or the program's own name for one on PATH ("python3").
  function shortName(python) {
    if (python.name) return (python.kind && KINDS[python.kind] ? KINDS[python.kind] + ' · ' : '') + python.name;
    return baseName(python.path);
  }

  function versionOf(v, path) {
    var match = interpreters(v).filter(function (python) {
      return python.path === path;
    })[0];
    return match && match.version ? match.version : '';
  }

  function renderPython(v) {
    var previous = mainForm.querySelector('input[name="python"]:checked');
    var keep = mainTouched && previous ? previous.value : null;
    found.textContent = '';
    var current = keep !== null ? keep : v.python && typeof v.python.path === 'string' ? v.python.path : null;
    var listed = false;
    var list = interpreters(v);
    list.forEach(function (python, index) {
      var item = el('li', 'choice');
      var radio = el('input');
      radio.type = 'radio';
      radio.name = 'python';
      radio.id = 'found-' + index;
      radio.value = python.path;
      radio.setAttribute('form', 'main');
      radio.checked = python.path === current;
      radio.addEventListener('change', function () {
        mainTouched = true;
        otherHint();
      });
      listed = listed || radio.checked;
      var label = el('label', 'choice-label');
      label.htmlFor = radio.id;
      label.title = describe(python);
      label.appendChild(el('span', 'choice-name', shortName(python)));
      label.appendChild(el('span', 'version', python.version || 'did not answer'));
      label.appendChild(el('span', 'path', python.path));
      // Read out as before: "Python 3.12.3 · lab (conda)", then the path.
      var words = el('span', 'visually-hidden', describe(python) + ', ');
      label.insertBefore(words, label.firstChild);
      label.querySelector('.choice-name').setAttribute('aria-hidden', 'true');
      label.querySelector('.version').setAttribute('aria-hidden', 'true');
      item.appendChild(radio);
      item.appendChild(label);
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
      show($('override'), 'INFALL_PYTHON_BIN is set, so Runs use ' + v.overridden + ' whatever is chosen here.');
    }
    otherHint();
  }

  // What another Python must be is said once it is the one chosen.
  function otherHint() {
    $('other-hint').hidden = !other.checked;
  }

  // A <select> of every interpreter, `selected` chosen (added when it is not listed).
  function interpreterSelect(v, selected, id) {
    var select = el('select', 'field mono small');
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

  // ---- environments: the names Runs ask for, and the environments added by hand --------------
  //
  // One table: a name a Run asks for, and what it means here. A name chosen here (`names`) can
  // be pointed at another Python; an environment added by hand is its own name. Removing a row
  // sends the command for the kind of entry it is.

  function renderNames(v) {
    var list = $('names');
    list.textContent = '';
    var rows = [];
    var names = v.names && typeof v.names === 'object' ? Object.keys(v.names) : [];
    names.forEach(function (name) {
      rows.push({ name: name, mapped: String(v.names[name]) });
    });
    (v.environments || []).forEach(function (env) {
      if (env && env.kind === 'added' && typeof env.name === 'string') {
        rows.push({ name: env.name, added: env });
      }
    });
    rows.sort(function (a, b) {
      return a.name < b.name ? -1 : a.name > b.name ? 1 : a.added ? 1 : -1;
    });
    $('names-empty').hidden = rows.length > 0;
    $('names-table').hidden = rows.length === 0;
    rows.forEach(function (entry, index) {
      var row = el('div', 'tr');
      row.setAttribute('role', 'row');
      var nameCell = el('span', 'mono small name', entry.name);
      nameCell.setAttribute('role', 'rowheader');
      row.appendChild(nameCell);
      var means = el('span', 'cell');
      means.setAttribute('role', 'cell');
      var version = el('span', 'version');
      version.setAttribute('role', 'cell');
      var more;
      if (entry.added) {
        var path = el('span', 'path', entry.added.path);
        path.title = 'Added by hand';
        means.appendChild(path);
        version.textContent = entry.added.version || '';
        more = moreButton('the environment ' + entry.name, [
          {
            text: 'Remove',
            danger: true,
            run: function (button) {
              change({ do: 'remove_environment', name: entry.name }, $('names-error'), button);
            }
          }
        ]);
      } else {
        var select = interpreterSelect(v, entry.mapped, 'name-' + index);
        select.setAttribute('aria-label', 'What “' + entry.name + '” means on this computer');
        select.addEventListener('change', function () {
          change({ do: 'map', name: entry.name, path: select.value }, $('names-error'), select);
        });
        means.appendChild(select);
        version.textContent = versionOf(v, entry.mapped);
        more = moreButton('the name “' + entry.name + '”', [
          {
            text: 'Remove',
            danger: true,
            run: function (button) {
              change({ do: 'map', name: entry.name, path: null }, $('names-error'), button);
            }
          }
        ]);
      }
      row.appendChild(means);
      row.appendChild(version);
      var moreCell = el('span');
      moreCell.setAttribute('role', 'cell');
      moreCell.appendChild(more);
      row.appendChild(moreCell);
      list.appendChild(row);
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

  // A language that is set up: its switch, name, command, version and ⋯ (Remove).
  function languageRow(language) {
    var box = el('div', 'toolchain');
    box.dataset.lang = language.id;
    var head = el('div', 'tr');
    var toggle = el('input', 'switch');
    toggle.type = 'checkbox';
    toggle.id = 'lang-on-' + language.id;
    toggle.setAttribute('role', 'switch');
    toggle.checked = !!language.enabled;
    head.appendChild(toggle);
    var label = el('label', 'lang-name', language.name);
    label.htmlFor = toggle.id;
    head.appendChild(label);
    var command = el('span', 'path', commandText(language.program, language.args));
    command.title = 'Id ' + language.id + ' · files .' + language.ext;
    head.appendChild(command);
    var problem = !language.available || !!language.problem;
    var state = el(
      'span',
      'state' + (problem ? ' bad' : language.version ? '' : ' unknown'),
      !language.available
        ? 'Its program is not there any more.'
        : language.problem
          ? 'Not working'
          : language.version
            ? language.version
            : 'Did not say its version.'
    );
    state.id = 'lang-state-' + language.id;
    toggle.setAttribute('aria-describedby', state.id);
    head.appendChild(state);
    var error = el('p', 'error row-error');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    head.appendChild(
      moreButton(language.name, [
        {
          text: 'Remove',
          danger: true,
          run: function (button) {
            change({ do: 'remove_language', id: language.id }, error, button);
          }
        }
      ])
    );
    box.appendChild(head);
    // The program is there but failed when asked its version: what it said, and what to do.
    if (language.available && language.problem) {
      box.appendChild(
        el(
          'p',
          'hint row-note',
          language.problem + ' Runs in ' + language.name + ' will likely fail until it is repaired or another program is set up.'
        )
      );
    }
    box.appendChild(error);
    toggle.addEventListener('change', function () {
      change({ do: 'enable_language', id: language.id, on: toggle.checked }, error, toggle);
    });
    return box;
  }

  // A preset not set up yet: the programs found, or a path, and "Set up".
  function presetRow(preset) {
    var box = el('form', 'toolchain');
    box.noValidate = true;
    box.dataset.lang = preset.id;
    var head = el('div', 'tr');
    head.appendChild(el('span'));
    var name = el('label', 'lang-name off', preset.name);
    head.appendChild(name);
    var select = el('select', 'field mono small');
    select.id = 'preset-' + preset.id;
    name.htmlFor = select.id;
    select.setAttribute('aria-label', 'Program for ' + preset.name);
    (preset.found || []).forEach(function (program) {
      var option = el('option', null, program.path + (program.problem ? ' — not working' : program.version ? ' — ' + program.version : ''));
      option.value = program.path;
      select.appendChild(option);
    });
    var by = el('option', null, (preset.found || []).length ? 'Another program…' : 'No program found: enter its path…');
    by.value = '';
    select.appendChild(by);
    head.appendChild(select);
    var button = el('button', 'btn sm soft', 'Set up ' + preset.name);
    button.type = 'submit';
    var started = 'Started as: <program> {file}, the Run written to main.' + preset.ext + '.';
    button.title = started;
    head.appendChild(button);
    box.appendChild(head);
    var path = el('input', 'field mono small row-path');
    path.type = 'text';
    path.autocomplete = 'off';
    path.spellcheck = false;
    path.placeholder = 'The full path of the program';
    path.setAttribute('aria-label', 'Full path of the program for ' + preset.name);
    var hint = el('p', 'hint row-note', started);
    path.hidden = hint.hidden = select.value !== '';
    select.addEventListener('change', function () {
      path.hidden = hint.hidden = select.value !== '';
      if (!path.hidden) path.focus();
    });
    box.appendChild(path);
    box.appendChild(hint);
    var error = el('p', 'error row-error');
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
    if (asked && typeof asked.lang === 'string') markAsked(asked.lang);

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

  // The language a Run asked for, outlined where it is set up.
  function markAsked(lang) {
    var row = document.querySelector('[data-lang="' + CSS.escape(lang) + '"]');
    if (row) row.classList.add('asked');
    return row;
  }

  function renderAsk(v) {
    var ask = v.ask;
    if (!ask || asked) return;
    asked = ask;
    var box = $('ask');
    var text = $('ask-text');
    box.hidden = false;
    text.textContent = '';
    if (typeof ask.env === 'string') {
      var lead = el('strong');
      lead.appendChild(document.createTextNode('A Run asks for the environment '));
      lead.appendChild(el('span', 'mono', ask.env));
      lead.appendChild(document.createTextNode('.'));
      text.appendChild(lead);
      text.appendChild(
        document.createTextNode(
          ' This computer has none of that name. Choose which of your Pythons it means here; Infall remembers the answer.'
        )
      );
      var form = $('ask-env');
      form.hidden = false;
      var select = interpreterSelect(v, v.python ? v.python.path : null, 'ask-env-choice');
      select.setAttribute('aria-labelledby', 'ask-text');
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
      text.textContent =
        'A Run is written in ' +
        name +
        ', which is not set up on this computer. Set it up below, or close this window to leave the Run.';
      var target = null;
      if (ask.lang === 'qsharp') {
        $('qsharp-row').classList.add('asked');
        target = $('qsharp-on');
      } else {
        var row = markAsked(ask.lang);
        if (row) {
          target = row.querySelector('select, input[type="checkbox"], button');
        } else {
          // Not a language this app knows: the form to add one, with its id filled in.
          openAddLanguage();
          $('lang-id').value = ask.lang;
          $('lang-name').focus();
          return;
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
    closeRowMenu(false);
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

  // ---- Add a language: a dialog ------------------------------------------------------------

  var dialogReturn = null;

  function openAddLanguage() {
    closeRowMenu(false);
    dialogReturn = document.activeElement;
    show($('add-lang-error'), '');
    scrim.hidden = false;
    $('lang-id').focus();
  }

  function closeAddLanguage() {
    scrim.hidden = true;
    var back = dialogReturn && document.body.contains(dialogReturn) ? dialogReturn : $('add-lang-open');
    dialogReturn = null;
    back.focus();
  }

  function dialogOpen() {
    return !scrim.hidden;
  }

  $('add-lang-open').addEventListener('click', openAddLanguage);
  $('add-lang-cancel').addEventListener('click', closeAddLanguage);
  scrim.addEventListener('mousedown', function (event) {
    if (event.target === scrim) closeAddLanguage();
  });
  // Focus stays inside the dialog while it is open.
  dialog.addEventListener('keydown', function (event) {
    if (event.key !== 'Tab') return;
    var focusable = Array.prototype.slice.call(dialog.querySelectorAll('input, textarea, button')).filter(function (node) {
      return !node.disabled && !node.hidden;
    });
    var firstOne = focusable[0];
    var last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === firstOne) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      firstOne.focus();
    }
  });

  // ---- the Member's actions ----------------------------------------------------------------

  otherPath.addEventListener('input', function () {
    other.checked = true;
    mainTouched = true;
    otherHint();
    show($('error'), '');
  });
  otherPath.addEventListener('focus', function () {
    // Typing a path is choosing it; the hint says what it must be.
    $('other-hint').hidden = false;
  });
  other.addEventListener('change', function () {
    mainTouched = true;
    otherHint();
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
    var button = event.target.querySelector('button[type="submit"]');
    var after = answeredIf({ lang: id });
    change(what, $('add-lang-error'), button, function () {
      if (after() === 'closed') return 'closed';
      ['lang-id', 'lang-name', 'lang-program', 'lang-ext'].forEach(function (field) {
        $(field).value = '';
      });
      $('lang-args').value = '{file}';
      closeAddLanguage();
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
    if (event.key !== 'Escape') return;
    // Escape closes what is open over the window first: a menu, then the dialog.
    if (menuOwner) {
      closeRowMenu(true);
      return;
    }
    if (dialogOpen()) {
      event.preventDefault();
      closeAddLanguage();
      return;
    }
    close();
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
