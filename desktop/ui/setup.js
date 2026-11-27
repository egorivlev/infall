// The start screen, shown on every start: the way into any Workspace. It can do what the
// desktop shell's start-screen commands allow (docs/specs/local.md and
// docs/specs/portability.md, "Contract C"), and nothing else. Every failure arrives as one
// plain sentence, shown as it is — an older app without a command rejects too, and that
// sentence is shown the same way.
(function () {
  'use strict';

  var PRESET_NAMES = {
    tutorial: 'Tutorial',
    blank: 'Blank',
    'literature-review': 'Literature review',
    'research-project': 'Research project'
  };

  var $ = function (id) {
    return document.getElementById(id);
  };
  var notice = $('notice');
  var noticeText = $('notice-text');
  var live = $('live');
  var recent = $('recent');
  var recentCount = $('recent-count');
  var recentList = $('recent-list');
  var recentError = $('recent-error');
  var recentErrorText = $('recent-error-text');
  var layout = document.querySelector('.layout');
  var createStatus = $('create-status');
  var createError = $('create-error');
  var narrowError = $('narrow-error');
  var signinBox = $('signin-box');
  var signinToggle = $('signin-toggle');
  var signinNarrow = $('signin-narrow');
  var signinForm = $('signin-form');
  var address = $('address');
  var addressError = $('address-error');
  var signin = $('signin');
  var importBtn = $('import-btn');
  var importError = $('import-error');
  var first = $('first');
  var firstTutorial = $('first-tutorial');
  var firstError = $('first-error');
  var createMenuBtn = $('create-menu-btn');
  var createMenu = $('create-menu');
  var createItems = Array.prototype.slice.call(createMenu.querySelectorAll('[role="menuitem"]'));
  // The four Presets. The first is the Tutorial.
  var tiles = Array.prototype.slice.call(document.querySelectorAll('.preset'));
  var template = $('entry-template');

  var busy = false;
  var entries = []; // WorkspaceEntry[] as start_view gave them
  var rows = {}; // id -> row controller
  var openMenu = null; // the menu that is open: a row's, or Create a workspace in a narrow room

  function invoke(command, args) {
    try {
      return Promise.resolve(window.__TAURI_INTERNALS__.invoke(command, args || {}));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  // An app older than this screen has no such command: Tauri's own words name the command.
  function missingCommand(reason, command) {
    var text = typeof reason === 'string' ? reason : reason && reason.message;
    return typeof text === 'string' && text.indexOf(command) >= 0 && /not (found|allowed)/i.test(text);
  }

  // The host of an origin, with its port when it has one ("team.example.org:8443").
  function hostOf(origin) {
    var text = String(origin || '');
    var at = text.indexOf('://');
    return at >= 0 ? text.slice(at + 3) : text;
  }

  function sentence(reason, fallback) {
    if (typeof reason === 'string' && reason.trim()) return reason;
    if (reason && typeof reason.message === 'string' && reason.message.trim()) return reason.message;
    return fallback;
  }

  var announceTimer = 0;
  function announce(text) {
    window.clearTimeout(announceTimer);
    live.textContent = '';
    if (!text) return;
    // Emptied first, so the same words are read again.
    announceTimer = window.setTimeout(function () {
      live.textContent = text;
    }, 30);
  }

  function spinnerText(el, text) {
    el.textContent = '';
    var s = document.createElement('span');
    s.className = 'spinner';
    s.setAttribute('aria-hidden', 'true');
    el.appendChild(s);
    el.appendChild(document.createTextNode(text));
  }

  // ---- busy: one thing at a time ------------------------------------------------------

  function actionButtons() {
    return Array.prototype.slice.call(
      document.querySelectorAll(
        '.preset, #first-tutorial, #create-menu-btn, #signin, #import-btn, #update-go, .entry-open, .entry-actions button, .menu button, .confirm button, .entry-rename button, .move button, .export button'
      )
    );
  }

  function setBusy(now) {
    busy = now;
    actionButtons().forEach(function (b) {
      if (now) b.setAttribute('aria-disabled', 'true');
      else b.removeAttribute('aria-disabled');
    });
  }

  // ---- time in plain words ------------------------------------------------------------

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function two(n) {
    return n < 10 ? '0' + n : String(n);
  }
  function clock(d) {
    return two(d.getHours()) + ':' + two(d.getMinutes());
  }
  function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }
  function known(ms) {
    return typeof ms === 'number' && isFinite(ms) && ms > 0;
  }

  // "just now", "5 minutes ago", "2 hours ago", "yesterday", "3 days ago", "3 Nov": relative
  // while it is recent, a date after a week. The full date and time is in the tooltip.
  function ago(ms, now) {
    var d = new Date(ms);
    var diff = now - ms;
    if (diff < 60 * 1000) return 'just now';
    if (diff < 60 * 60 * 1000) {
      var m = Math.floor(diff / 60000);
      return m + (m === 1 ? ' minute ago' : ' minutes ago');
    }
    var days = Math.round((startOfDay(new Date(now)) - startOfDay(d)) / 86400000);
    if (days <= 0) {
      var h = Math.max(1, Math.floor(diff / 3600000));
      return h + (h === 1 ? ' hour ago' : ' hours ago');
    }
    if (days === 1) return 'yesterday';
    if (days < 7) return days + ' days ago';
    var date = d.getDate() + ' ' + MONTHS[d.getMonth()];
    if (d.getFullYear() !== new Date(now).getFullYear()) date += ' ' + d.getFullYear();
    return date;
  }

  function capital(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  // "Yesterday", in the row; "opened yesterday" where it is read out.
  function whenOpened(ms, now) {
    return known(ms) ? capital(ago(ms, now)) : 'Not opened yet';
  }
  function whenOpenedWords(ms, now) {
    return known(ms) ? 'opened ' + ago(ms, now) : 'not opened yet';
  }

  // "3 files, 4.2 MB": what Export… may include.
  function filesText(files) {
    var count = files.count === 1 ? '1 file' : files.count + ' files';
    var mb = (files.bytes || 0) / (1024 * 1024);
    var size = mb >= 10 ? Math.round(mb) + ' MB' : mb >= 0.1 ? mb.toFixed(1) + ' MB' : 'under 0.1 MB';
    return count + ', ' + size;
  }

  function fullDate(ms) {
    if (!known(ms)) return '';
    var d = new Date(ms);
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear() + ', ' + clock(d);
  }

  // ---- notice -------------------------------------------------------------------------

  function showNotice(text) {
    noticeText.textContent = text || '';
    notice.hidden = !text;
  }
  $('notice-dismiss').addEventListener('click', function () {
    showNotice('');
    focusStart();
  });

  // ---- create -------------------------------------------------------------------------

  // A failure is said next to what was pressed: under the first start's button, or under
  // the Presets (in a narrow room, where they are folded into a menu, at the top of the list).
  function showCreateError(text, where) {
    [createError, narrowError, firstError].forEach(function (el) {
      var mine = where === 'first' ? el === firstError : el !== firstError;
      el.textContent = mine ? text || '' : '';
      el.hidden = !(mine && text);
    });
  }

  function narrowRoom() {
    return window.matchMedia('(max-width: 699px)').matches;
  }

  // `tile` is the Preset; `from` the control that was pressed when it is not the tile itself
  // (the first start's button, or the narrow room's menu button), which then says it is busy.
  function create(tile, from) {
    if (busy) return;
    var preset = tile.getAttribute('data-preset');
    var name = tile.getAttribute('data-name');
    var desc = tile.querySelector('.preset-desc');
    var descText = desc.textContent;
    var fromText = from ? from.textContent : '';
    var where = from === firstTutorial ? 'first' : 'side';
    clearMessages();
    setBusy(true);
    tile.setAttribute('aria-busy', 'true');
    spinnerText(desc, 'Creating…');
    if (from) {
      from.setAttribute('aria-busy', 'true');
      spinnerText(from, 'Creating…');
    }
    createStatus.textContent = 'Creating the ' + name + ' workspace…';
    invoke('workspace_create', { preset: preset }).then(
      function () {
        // The shell opens the new Workspace and closes this window.
        desc.textContent = 'Opening…';
        if (from) from.textContent = 'Opening…';
        createStatus.textContent = 'Opening the ' + name + ' workspace…';
      },
      function (reason) {
        tile.removeAttribute('aria-busy');
        desc.textContent = descText;
        if (from) {
          from.removeAttribute('aria-busy');
          restoreLabel(from, fromText);
        }
        createStatus.textContent = '';
        setBusy(false);
        showCreateError(sentence(reason, 'The workspace could not be created. Try again.'), where);
        (from || tile).focus();
      }
    );
  }

  // The narrow room's menu button carries a ▾ that is not read out.
  function restoreLabel(button, text) {
    if (button === createMenuBtn) {
      button.textContent = 'Create a workspace ';
      var caret = document.createElement('span');
      caret.setAttribute('aria-hidden', 'true');
      caret.textContent = '▾';
      button.appendChild(caret);
    } else {
      button.textContent = text;
    }
  }

  tiles.forEach(function (tile) {
    tile.addEventListener('click', function () {
      create(tile, null);
    });
  });

  // A first start: the Tutorial, with the accent on one button.
  firstTutorial.addEventListener('click', function () {
    create(tiles[0], firstTutorial);
  });

  // ---- a narrow room: Create a workspace ▾ and Sign in… --------------------------------

  var createMenuRow = {
    menu: createMenu,
    moreBtn: createMenuBtn,
    closeMenu: function (refocus) {
      if (openMenu !== createMenuRow) return;
      openMenu = null;
      createMenu.hidden = true;
      createMenuBtn.setAttribute('aria-expanded', 'false');
      if (refocus) createMenuBtn.focus();
    },
    openMenu: function (focusLast) {
      closeAllPanels(null);
      openMenu = createMenuRow;
      createMenu.hidden = false;
      createMenuBtn.setAttribute('aria-expanded', 'true');
      placeMenu(createMenu, createMenuBtn);
      (focusLast ? createItems[createItems.length - 1] : createItems[0]).focus();
    }
  };

  createMenuBtn.addEventListener('click', function () {
    if (busy) return;
    if (openMenu === createMenuRow) createMenuRow.closeMenu(true);
    else createMenuRow.openMenu(false);
  });
  createMenuBtn.addEventListener('keydown', function (event) {
    if (busy) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      createMenuRow.openMenu(event.key === 'ArrowUp');
    }
  });
  createMenu.addEventListener('keydown', function (event) {
    menuKeys(event, createItems, createMenuRow);
  });
  createItems.forEach(function (item) {
    item.addEventListener('click', function () {
      if (busy) return;
      var which = item.getAttribute('data-for');
      createMenuRow.closeMenu(true);
      if (which === 'import') {
        startImport(createMenuBtn);
        return;
      }
      var tile = tiles.filter(function (t) {
        return t.getAttribute('data-preset') === which;
      })[0];
      if (tile) create(tile, createMenuBtn);
    });
  });

  // Sign in, folded: a short window shows one button in its place, a narrow room one in its
  // bar. Pressing it opens the field there.
  function openSignin(from) {
    signinBox.classList.add('open');
    layout.classList.add('signin-open');
    signinToggle.setAttribute('aria-expanded', 'true');
    signinNarrow.setAttribute('aria-expanded', 'true');
    address.focus();
    // In a short window the open form may be taller than the room under the Presets: the
    // side panel scrolls it into view.
    if (signinBox.scrollIntoView) signinBox.scrollIntoView({ block: 'nearest' });
  }
  function closeSignin(refocus) {
    var wasNarrow = layout.classList.contains('signin-open') && narrowRoom();
    signinBox.classList.remove('open');
    layout.classList.remove('signin-open');
    signinToggle.setAttribute('aria-expanded', 'false');
    signinNarrow.setAttribute('aria-expanded', 'false');
    if (refocus) (wasNarrow ? signinNarrow : signinToggle).focus();
  }
  function signinFolded() {
    return narrowRoom() || window.matchMedia('(max-height: 599px)').matches;
  }
  signinToggle.addEventListener('click', function () {
    openSignin(signinToggle);
  });
  signinNarrow.addEventListener('click', function () {
    if (layout.classList.contains('signin-open')) closeSignin(true);
    else openSignin(signinNarrow);
  });
  signinForm.addEventListener('keydown', function (event) {
    // Folded away again with Escape, when it was folded to begin with.
    if (event.key === 'Escape' && !busy && signinFolded() && signinBox.classList.contains('open')) {
      event.preventDefault();
      closeSignin(true);
    }
  });

  // ---- import -------------------------------------------------------------------------

  function showImportError(text) {
    importError.textContent = text || '';
    importError.hidden = !text;
    // In a narrow room the side panel is folded away: the error goes where Create errors go.
    if (text) {
      narrowError.textContent = text;
      narrowError.hidden = false;
    } else if (createError.hidden) {
      narrowError.textContent = '';
      narrowError.hidden = true;
    }
  }

  // `from`: the narrow room's menu button, when the import was chosen from its menu.
  function startImport(from) {
    if (busy) return;
    var button = from || importBtn;
    var label = button.textContent;
    clearMessages();
    closeAllPanels(null);
    setBusy(true);
    button.setAttribute('aria-busy', 'true');
    spinnerText(button, 'Importing…');
    function done() {
      button.removeAttribute('aria-busy');
      restoreLabel(button, label);
      setBusy(false);
    }
    invoke('workspace_import').then(
      function () {
        // Either the person cancelled (nothing to say), or the shell made the new
        // Workspace and is opening it, closing this window.
        done();
      },
      function (reason) {
        done();
        showImportError(sentence(reason, 'The Workspace file could not be imported. Try again.'));
        button.focus();
      }
    );
  }

  importBtn.addEventListener('click', function () {
    startImport(null);
  });

  // ---- sign in ------------------------------------------------------------------------

  function showAddressError(text) {
    addressError.textContent = text || '';
    addressError.hidden = !text;
    // The error takes the hint's place.
    $('address-hint').hidden = !!text;
    if (text) address.setAttribute('aria-invalid', 'true');
    else address.removeAttribute('aria-invalid');
  }

  address.addEventListener('input', function () {
    showAddressError('');
  });

  signinForm.addEventListener('submit', function (event) {
    event.preventDefault();
    if (busy) return;
    clearMessages();
    setBusy(true);
    signin.setAttribute('aria-busy', 'true');
    spinnerText(signin, 'Checking the address…');
    announce('Checking the address…');
    invoke('workspace_connect', { address: address.value }).then(
      function () {
        signin.textContent = 'Opening…';
      },
      function (reason) {
        signin.removeAttribute('aria-busy');
        signin.textContent = 'Sign in';
        setBusy(false);
        showAddressError(sentence(reason, 'The address could not be checked. Try again.'));
        address.focus();
      }
    );
  });

  // ---- your workspaces ----------------------------------------------------------------

  // Errors and the last "saved to" line go away as soon as something else is done.
  function clearMessages() {
    showCreateError('');
    showAddressError('');
    showImportError('');
    Object.keys(rows).forEach(function (id) {
      rows[id].showError('');
      rows[id].showStatus('');
    });
  }

  function closeAllPanels(except) {
    if (openMenu && openMenu !== except) openMenu.closeMenu(false);
    Object.keys(rows).forEach(function (id) {
      if (rows[id] !== except) {
        rows[id].stopRename(false);
        rows[id].closeConfirm(false);
        rows[id].closeMove(false);
        rows[id].closeExport(false);
      }
    });
  }

  // The row's menu sits over everything (the list scrolls, and would cut it off), so it
  // is placed next to its button by hand and closed when anything moves.
  function placeMenu(menu, button) {
    var r = button.getBoundingClientRect();
    menu.style.left = '0px';
    menu.style.top = '0px';
    var w = menu.offsetWidth;
    var h = menu.offsetHeight;
    var vw = document.documentElement.clientWidth;
    var vh = document.documentElement.clientHeight;
    var left = Math.max(8, Math.min(r.right - w, vw - w - 8));
    var top = r.bottom + 4;
    if (top + h > vh - 8) top = Math.max(8, r.top - h - 4);
    menu.style.left = Math.round(left) + 'px';
    menu.style.top = Math.round(top) + 'px';
  }

  document.addEventListener('mousedown', function (event) {
    if (!openMenu) return;
    if (openMenu.menu.contains(event.target) || openMenu.moreBtn.contains(event.target)) return;
    openMenu.closeMenu(false);
  });
  window.addEventListener('resize', function () {
    if (openMenu) openMenu.closeMenu(false);
  });
  recentList.addEventListener('scroll', function () {
    if (openMenu) openMenu.closeMenu(false);
  });
  document.addEventListener(
    'scroll',
    function (event) {
      if (openMenu && event.target !== openMenu.menu) openMenu.closeMenu(false);
    },
    true
  );

  // Arrow keys, Home and End move; a letter jumps to the next item starting with it; Escape
  // closes and returns to the button; Tab closes and goes on from the button.
  function menuKeys(event, items, owner) {
    var i = items.indexOf(document.activeElement);
    var next = -1;
    if (event.key === 'ArrowDown') next = (i + 1) % items.length;
    else if (event.key === 'ArrowUp') next = (i - 1 + items.length) % items.length;
    else if (event.key === 'Home' || event.key === 'PageUp') next = 0;
    else if (event.key === 'End' || event.key === 'PageDown') next = items.length - 1;
    else if (event.key === 'Escape') {
      event.preventDefault();
      owner.closeMenu(true);
      return;
    } else if (event.key === 'Tab') {
      // Close it and let Tab go on from its button, as if the menu had not been open.
      owner.closeMenu(true);
      return;
    } else if (event.key.length === 1 && /\S/.test(event.key)) {
      var k = event.key.toLowerCase();
      for (var n = 1; n <= items.length; n++) {
        var j = (Math.max(i, 0) + n) % items.length;
        if (items[j].textContent.trim().toLowerCase().charAt(0) === k) {
          next = j;
          break;
        }
      }
    }
    if (next >= 0) {
      event.preventDefault();
      items[next].focus();
    }
  }

  function makeRow(entry, index) {
    var li = template.content.firstElementChild.cloneNode(true);
    var open = li.querySelector('.entry-open');
    var nameEl = li.querySelector('.entry-name');
    var kindEl = li.querySelector('.kind');
    var whereEl = li.querySelector('.entry-where');
    var whenEl = li.querySelector('.entry-when');
    var backupEl = li.querySelector('.entry-backup');
    var moreBtn = li.querySelector('.more');
    var menu = li.querySelector('.menu');
    var miRename = li.querySelector('.mi-rename');
    var miExport = li.querySelector('.mi-export');
    var miReveal = li.querySelector('.mi-reveal');
    var miRemove = li.querySelector('.mi-remove');
    var miMove = li.querySelector('.mi-move');
    var miCopy = li.querySelector('.mi-copy');
    var movedEl = li.querySelector('.entry-moved');
    var cta = li.querySelector('.entry-cta');
    var moveForm = li.querySelector('.move');
    var moveTitle = moveForm.querySelector('.move-title');
    var moveBody = moveForm.querySelector('.move-body');
    var moveLabel = moveForm.querySelector('.move-label');
    var moveInput = moveForm.querySelector('.move-input');
    var moveHint = moveForm.querySelector('.move-hint');
    var moveError = moveForm.querySelector('.move-error');
    var moveGo = moveForm.querySelector('.move-go');
    var moveCancel = moveForm.querySelector('.move-cancel');
    var moveFields = moveForm.querySelector('.move-fields');
    var moveProgress = moveForm.querySelector('.move-progress');
    var progress = li.querySelector('.entry-progress');
    var form = li.querySelector('.entry-rename');
    var formLabel = form.querySelector('label');
    var input = form.querySelector('input');
    var commit = form.querySelector('.commit');
    var cancel = form.querySelector('.cancel');
    var status = li.querySelector('.entry-status');
    var error = li.querySelector('.entry-error');
    var confirm = li.querySelector('.confirm');
    var confirmTitle = li.querySelector('.confirm-title');
    var confirmBody = li.querySelector('.confirm-body');
    var keep = li.querySelector('.keep');
    var exportFirst = li.querySelector('.export-first');
    var go = li.querySelector('.go');
    var exportForm = li.querySelector('.export');
    var exportTitle = exportForm.querySelector('.export-title');
    var exportFiles = exportForm.querySelector('.export-files');
    var exportFilesLabel = exportForm.querySelector('.export-files-label');
    var exportHint = exportForm.querySelector('.export-hint');
    var exportGo = exportForm.querySelector('.export-go');
    var exportCancel = exportForm.querySelector('.export-cancel');

    var local = entry.kind === 'local';
    // A Local Workspace with PDFs (docs/specs/pdf-sources.md, decision 6): Export… asks
    // whether they go in. Without a count (an app or server crate that cannot say), it asks
    // nothing and exports as before.
    var files =
      local && entry.files && typeof entry.files.count === 'number' && entry.files.count > 0 ? entry.files : null;
    // A Local Workspace moved to a Team server (docs/specs/team-move.md, decision 3): its
    // main action opens the server; the copy here opens read-only from its menu.
    var movedTo = local && typeof entry.movedTo === 'string' && entry.movedTo ? entry.movedTo : '';
    var movedText = movedTo ? 'Moved to ' + hostOf(movedTo) : '';
    var uid = 'entry-' + index;
    var now = Date.now();
    var whenText = whenOpened(entry.lastOpened, now);
    var whenWords = whenOpenedWords(entry.lastOpened, now);
    var backupText = local && known(entry.lastBackup) ? 'Backed up ' + ago(entry.lastBackup, now) : '';

    nameEl.textContent = entry.name;
    nameEl.id = uid + '-name';
    nameEl.title = entry.name;
    kindEl.textContent = local ? 'Local' : 'Team';
    if (local) {
      whereEl.textContent = entry.preset ? PRESET_NAMES[entry.preset] || entry.preset : '';
    } else {
      // The host is what identifies a server; the whole address is in the tooltip.
      whereEl.textContent = entry.address ? hostOf(entry.address) : '';
      whereEl.title = entry.address || '';
    }
    if (movedTo) {
      // Where it is now says more than the Preset it began from; its main action, in place
      // of the time it was opened, says it opens the server.
      whereEl.textContent = '';
      movedEl.textContent = movedText + '. This copy is read-only.';
      movedEl.title = movedTo;
      movedEl.hidden = false;
      cta.hidden = false;
      whenEl.hidden = true;
      li.classList.add('moved');
    }
    if (!whereEl.textContent) whereEl.hidden = true;
    whenEl.textContent = whenText;
    if (known(entry.lastOpened)) whenEl.title = 'Opened ' + fullDate(entry.lastOpened);
    if (backupText) {
      backupEl.textContent = backupText;
      backupEl.title = 'Backed up ' + fullDate(entry.lastBackup);
      backupEl.hidden = false;
    }

    var kindWords = local
      ? 'Local Workspace' + (entry.preset ? ', ' + (PRESET_NAMES[entry.preset] || entry.preset) : '')
      : 'Team Workspace at ' + (entry.address || '');
    if (movedTo) kindWords = 'Local Workspace, ' + movedText + ', read-only here';
    var meta = li.querySelector('.entry-meta');
    open.setAttribute('aria-label', movedTo ? 'Open ' + entry.name + ' on the server' : 'Open ' + entry.name);
    open.setAttribute('aria-describedby', uid + '-meta');
    meta.id = uid + '-meta';
    meta.setAttribute(
      'aria-label',
      kindWords + ', ' + whenWords + (backupText ? ', backed up ' + ago(entry.lastBackup, now) : '')
    );

    // Team Workspaces have no file on this computer: no export, no folder.
    if (!local) {
      Array.prototype.slice.call(menu.querySelectorAll('[data-local]')).forEach(function (b) {
        b.parentNode.removeChild(b);
      });
    }
    if (movedTo) {
      // Moved once is moved: no second move. The copy here can still be opened.
      if (miMove) miMove.parentNode.removeChild(miMove);
      miMove = null;
      miCopy.hidden = false;
    } else {
      miCopy.parentNode.removeChild(miCopy);
      miCopy = null;
    }
    if (!local) miMove = null;
    var items = Array.prototype.slice.call(menu.querySelectorAll('[role="menuitem"]'));

    moreBtn.setAttribute('aria-label', 'More for ' + entry.name);
    moreBtn.title = movedTo
      ? 'Open this copy, rename, export, show in folder, delete'
      : 'Rename, ' + (local ? 'export, show in folder, move to a Team server, delete' : 'forget');

    moveForm.id = uid + '-move';
    moveForm.setAttribute('aria-labelledby', uid + '-move-title');
    moveTitle.id = uid + '-move-title';
    moveTitle.textContent = 'Move “' + entry.name + '” to a Team server';
    moveInput.id = uid + '-move-input';
    moveLabel.setAttribute('for', moveInput.id);
    moveBody.id = uid + '-move-body';
    moveHint.id = uid + '-move-hint';
    moveError.id = uid + '-move-error';
    moveInput.setAttribute('aria-describedby', moveBody.id + ' ' + moveHint.id + ' ' + moveError.id);
    moreBtn.setAttribute('aria-controls', uid + '-menu');
    menu.id = uid + '-menu';
    menu.setAttribute('aria-label', entry.name);

    exportForm.id = uid + '-export';
    exportTitle.id = uid + '-export-title';
    exportForm.setAttribute('aria-labelledby', exportTitle.id);
    exportTitle.textContent = 'Export “' + entry.name + '”';
    exportFiles.id = uid + '-export-files';
    exportHint.id = uid + '-export-hint';
    exportFiles.setAttribute('aria-describedby', exportHint.id);
    if (files) exportFilesLabel.textContent = 'Include PDFs (' + filesText(files) + ')';

    input.id = uid + '-input';
    formLabel.setAttribute('for', input.id);
    formLabel.textContent = 'New name for ' + entry.name;
    error.id = uid + '-error';
    input.setAttribute('aria-describedby', error.id);

    confirm.id = uid + '-confirm';
    confirm.setAttribute('aria-labelledby', uid + '-confirm-title');
    confirm.setAttribute('aria-describedby', uid + '-confirm-body');
    confirmTitle.id = uid + '-confirm-title';
    confirmBody.id = uid + '-confirm-body';
    // The menu item says what the question it opens asks.
    miRemove.textContent = local ? 'Delete…' : 'Forget…';
    if (local) {
      confirmTitle.textContent = 'Delete “' + entry.name + '” for good?';
      confirmBody.textContent =
        'Its Board, Pages and history are removed from this computer, and its backups with them. ' +
        'This cannot be undone.';
      go.textContent = 'Delete workspace';
      exportFirst.hidden = false;
      exportFirst.setAttribute('aria-label', 'Export ' + entry.name + ' first');
    } else {
      confirm.classList.add('team');
      confirmTitle.textContent = 'Forget “' + entry.name + '”?';
      confirmBody.textContent =
        'This app forgets the address ' +
        (entry.address || '') +
        '. The Team Workspace and everything in it stay on its server, and you can sign in again later.';
      go.textContent = 'Forget workspace';
      exportFirst.parentNode.removeChild(exportFirst);
      exportFirst = null;
    }

    var row = {
      id: entry.id,
      el: li,
      open: open,
      moreBtn: moreBtn,
      menu: menu,
      renaming: false,
      confirming: false,
      moving: false,
      exporting: false,
      showError: function (text) {
        error.textContent = text || '';
        error.hidden = !text;
        if (text && row.renaming) input.setAttribute('aria-invalid', 'true');
        else input.removeAttribute('aria-invalid');
      },
      showStatus: function (text, path) {
        status.textContent = '';
        status.hidden = !text;
        if (!text) return;
        status.appendChild(document.createTextNode(text));
        if (path) {
          var p = document.createElement('span');
          p.className = 'path';
          p.textContent = path;
          status.appendChild(p);
        }
      },
      openMenu: function (focusLast) {
        closeAllPanels(row);
        openMenu = row;
        menu.hidden = false;
        li.classList.add('menu-open');
        moreBtn.setAttribute('aria-expanded', 'true');
        placeMenu(menu, moreBtn);
        (focusLast ? items[items.length - 1] : items[0]).focus();
      },
      closeMenu: function (refocus) {
        if (openMenu !== row) return;
        openMenu = null;
        menu.hidden = true;
        li.classList.remove('menu-open');
        moreBtn.setAttribute('aria-expanded', 'false');
        if (refocus) moreBtn.focus();
      },
      startRename: function () {
        closeAllPanels(row);
        row.closeConfirm(false);
        row.showError('');
        row.showStatus('');
        row.renaming = true;
        li.classList.add('renaming');
        input.value = entry.name;
        open.hidden = true;
        moreBtn.parentNode.hidden = true;
        form.hidden = false;
        input.focus();
        input.select();
      },
      stopRename: function (refocus) {
        if (!row.renaming) return;
        row.renaming = false;
        li.classList.remove('renaming');
        row.showError('');
        form.hidden = true;
        open.hidden = false;
        moreBtn.parentNode.hidden = false;
        if (refocus) moreBtn.focus();
      },
      openConfirm: function () {
        closeAllPanels(row);
        row.stopRename(false);
        row.showError('');
        row.showStatus('');
        row.confirming = true;
        confirm.hidden = false;
        keep.focus();
        if (confirm.scrollIntoView) confirm.scrollIntoView({ block: 'nearest' });
      },
      closeConfirm: function (refocus) {
        if (!row.confirming) return;
        row.confirming = false;
        confirm.hidden = true;
        row.showError('');
        if (refocus) moreBtn.focus();
      },
      showMoveError: function (text) {
        moveError.textContent = text || '';
        moveError.hidden = !text;
        if (text) moveInput.setAttribute('aria-invalid', 'true');
        else moveInput.removeAttribute('aria-invalid');
        // The sentence makes the panel taller: keep all of it in view in the list.
        if (text && row.moving && moveForm.scrollIntoView) moveForm.scrollIntoView({ block: 'nearest' });
      },
      openMove: function () {
        closeAllPanels(row);
        row.stopRename(false);
        row.closeConfirm(false);
        row.showError('');
        row.showStatus('');
        row.showMoveError('');
        row.moving = true;
        moveForm.hidden = false;
        moveInput.focus();
        if (moveForm.scrollIntoView) moveForm.scrollIntoView({ block: 'nearest' });
      },
      closeMove: function (refocus) {
        if (!row.moving) return;
        row.moving = false;
        moveForm.hidden = true;
        row.showMoveError('');
        if (refocus) moreBtn.focus();
      },
      openExport: function () {
        closeAllPanels(row);
        row.stopRename(false);
        row.closeConfirm(false);
        row.showError('');
        row.showStatus('');
        row.exporting = true;
        exportFiles.checked = true;
        exportForm.hidden = false;
        exportFiles.focus();
        if (exportForm.scrollIntoView) exportForm.scrollIntoView({ block: 'nearest' });
      },
      closeExport: function (refocus) {
        if (!row.exporting) return;
        row.exporting = false;
        exportForm.hidden = true;
        if (refocus) moreBtn.focus();
      }
    };

    // While the row opens: dimmed, and the time (or a moved copy's "Open on the server")
    // gives way to what is going on.
    function rowBusy(on) {
      if (on) li.setAttribute('aria-busy', 'true');
      else li.removeAttribute('aria-busy');
      li.classList.toggle('busy', on);
      if (movedTo) {
        cta.hidden = on;
        whenEl.hidden = !on;
      }
      if (!on) whenEl.textContent = whenText;
    }

    // ---- open ----

    open.addEventListener('click', function () {
      if (busy) return;
      clearMessages();
      closeAllPanels(null);
      setBusy(true);
      open.setAttribute('aria-busy', 'true');
      rowBusy(true);
      spinnerText(whenEl, 'Opening…');
      if (movedTo) {
        spinnerText(whenEl, 'Checking the server…');
        announce('Opening ' + entry.name + ' on ' + hostOf(movedTo) + '…');
      } else {
        announce('Opening ' + entry.name + '…');
      }
      var opening = movedTo
        ? invoke('workspace_connect', { address: movedTo })
        : invoke('workspace_open', { id: entry.id });
      opening.then(
        function () {
          // The shell shows the Workspace and closes this window.
        },
        function (reason) {
          open.removeAttribute('aria-busy');
          rowBusy(false);
          setBusy(false);
          row.showError(sentence(reason, 'This workspace could not be opened. Try again.'));
          open.focus();
        }
      );
    });

    // The copy on this computer, read-only, of a moved Workspace.
    function openCopy() {
      clearMessages();
      closeAllPanels(null);
      setBusy(true);
      rowBusy(true);
      moreBtn.setAttribute('aria-busy', 'true');
      spinnerText(whenEl, 'Opening…');
      announce('Opening the copy of ' + entry.name + ' on this computer…');
      invoke('workspace_open', { id: entry.id }).then(
        function () {},
        function (reason) {
          rowBusy(false);
          moreBtn.removeAttribute('aria-busy');
          setBusy(false);
          row.showError(sentence(reason, 'This workspace could not be opened. Try again.'));
          moreBtn.focus();
        }
      );
    }

    open.addEventListener('keydown', function (event) {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      var opens = Array.prototype.slice.call(recentList.querySelectorAll('.entry-open:not([hidden])'));
      var i = opens.indexOf(open) + (event.key === 'ArrowDown' ? 1 : -1);
      if (i >= 0 && i < opens.length) {
        event.preventDefault();
        opens[i].focus();
      }
    });

    // ---- the menu ----

    moreBtn.addEventListener('click', function () {
      if (busy) return;
      if (openMenu === row) row.closeMenu(true);
      else row.openMenu(false);
    });

    moreBtn.addEventListener('keydown', function (event) {
      if (busy) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        row.openMenu(event.key === 'ArrowUp');
      }
    });

    menu.addEventListener('keydown', function (event) {
      menuKeys(event, items, row);
    });

    function fromMenu(action) {
      return function () {
        if (busy) return;
        row.closeMenu(true);
        action();
      };
    }

    miRename.addEventListener('click', fromMenu(function () {
      row.startRename();
    }));

    miRemove.addEventListener('click', fromMenu(function () {
      row.openConfirm();
    }));

    if (local) {
      miExport.addEventListener('click', fromMenu(function () {
        if (files) row.openExport();
        else exportFile(null);
      }));
      miReveal.addEventListener('click', fromMenu(function () {
        reveal();
      }));
    }
    if (miMove) {
      miMove.addEventListener('click', fromMenu(function () {
        row.openMove();
      }));
    }
    if (miCopy) {
      miCopy.addEventListener('click', fromMenu(function () {
        openCopy();
      }));
    }

    // ---- move to a Team server ----

    moveInput.addEventListener('input', function () {
      row.showMoveError('');
    });

    moveCancel.addEventListener('click', function () {
      if (busy) return;
      row.closeMove(true);
    });

    moveForm.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        row.closeMove(true);
      }
    });

    moveForm.addEventListener('submit', function (event) {
      event.preventDefault();
      if (busy) return;
      if (!moveInput.value.trim()) {
        row.showMoveError('Enter the address of the Team server.');
        moveInput.focus();
        return;
      }
      row.showMoveError('');
      setBusy(true);
      li.setAttribute('aria-busy', 'true');
      moveGo.setAttribute('aria-busy', 'true');
      // Nothing here can measure the copy: the sentence carries it, over a still track.
      var host = hostOf(moveInput.value.trim()).split('/')[0];
      moveFields.hidden = true;
      moveCancel.hidden = true;
      moveGo.hidden = true;
      moveProgress.hidden = false;
      moveProgress.querySelector('.progress-text').textContent = 'Copying to ' + host + '…';
      moveProgress.focus();
      announce('Checking the server and copying ' + entry.name + '…');
      invoke('workspace_move', { id: entry.id, address: moveInput.value }).then(
        function () {
          // The shell opens the server and closes this window; its page takes the file in.
          moveProgress.querySelector('.progress-text').textContent = 'Opening the server…';
          announce('Opening the server…');
        },
        function (reason) {
          li.removeAttribute('aria-busy');
          moveGo.removeAttribute('aria-busy');
          moveProgress.hidden = true;
          moveFields.hidden = false;
          moveCancel.hidden = false;
          moveGo.hidden = false;
          setBusy(false);
          announce('');
          row.showMoveError(
            missingCommand(reason, 'workspace_move')
              ? 'This version of Infall cannot move a workspace. Update the app and try again.'
              : sentence(reason, 'The workspace could not be moved. Try again.')
          );
          moveInput.focus();
        }
      );
    });

    // ---- export: with or without the PDFs; show in folder ----

    exportCancel.addEventListener('click', function () {
      if (busy) return;
      row.closeExport(true);
    });

    exportForm.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        row.closeExport(true);
      }
    });

    exportForm.addEventListener('submit', function (event) {
      event.preventDefault();
      if (busy) return;
      var include = exportFiles.checked;
      row.closeExport(false);
      exportFile(null, include);
    });

    // `button` is the control that started it when it stays on screen (Export first…);
    // from the menu the row itself says what is going on. `includeFiles`: whether the PDFs go
    // in, when the person was asked (absent: they do).
    function exportFile(button, includeFiles) {
      clearMessages();
      setBusy(true);
      li.setAttribute('aria-busy', 'true');
      var label = button ? button.textContent : '';
      if (button) {
        button.setAttribute('aria-busy', 'true');
        spinnerText(button, 'Exporting…');
      } else {
        // From the menu: the row dims and a progress line under it says what is going on.
        moreBtn.setAttribute('aria-busy', 'true');
        li.classList.add('busy');
        whenEl.hidden = true;
        progress.querySelector('.progress-text').textContent = 'Exporting ' + entry.name + '…';
        progress.hidden = false;
      }
      announce('Exporting ' + entry.name + '…');
      function done() {
        li.removeAttribute('aria-busy');
        moreBtn.removeAttribute('aria-busy');
        if (button) {
          button.removeAttribute('aria-busy');
          button.textContent = label;
        }
        li.classList.remove('busy');
        whenEl.hidden = !!movedTo;
        progress.hidden = true;
        row.showStatus('');
        setBusy(false);
      }
      var args = { id: entry.id };
      if (typeof includeFiles === 'boolean') args.includeFiles = includeFiles;
      invoke('workspace_export', args).then(
        function (path) {
          done();
          if (typeof path === 'string' && path) {
            row.showStatus('Workspace file saved to ', path);
            announce('Workspace file saved to ' + path);
          } else {
            // Cancelled: nothing happened, so nothing is said.
            announce('');
          }
          (button || moreBtn).focus();
        },
        function (reason) {
          done();
          announce('');
          row.showError(sentence(reason, 'The workspace could not be exported. Try again.'));
          (button || moreBtn).focus();
        }
      );
    }

    function reveal() {
      clearMessages();
      setBusy(true);
      moreBtn.setAttribute('aria-busy', 'true');
      invoke('workspace_reveal', { id: entry.id }).then(
        function () {
          moreBtn.removeAttribute('aria-busy');
          setBusy(false);
        },
        function (reason) {
          moreBtn.removeAttribute('aria-busy');
          setBusy(false);
          row.showError(sentence(reason, 'The folder could not be shown. Try again.'));
          moreBtn.focus();
        }
      );
    }

    if (exportFirst) {
      exportFirst.addEventListener('click', function () {
        if (busy) return;
        exportFile(exportFirst);
      });
    }

    // ---- rename ----

    cancel.addEventListener('click', function () {
      if (busy) return;
      row.stopRename(true);
    });

    input.addEventListener('input', function () {
      row.showError('');
    });

    input.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        row.stopRename(true);
      }
    });

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (busy) return;
      var name = input.value.trim();
      if (!name) {
        row.showError('Enter a name for this workspace.');
        input.focus();
        return;
      }
      if (name === entry.name) {
        row.stopRename(true);
        return;
      }
      row.showError('');
      setBusy(true);
      commit.setAttribute('aria-busy', 'true');
      commit.textContent = 'Renaming…';
      invoke('workspace_rename', { id: entry.id, name: name }).then(
        function () {
          setBusy(false);
          announce('Renamed to ' + name + '.');
          reload(function () {
            focusRow(entry.id, 'open');
          });
        },
        function (reason) {
          commit.removeAttribute('aria-busy');
          commit.textContent = 'Rename';
          setBusy(false);
          row.showError(sentence(reason, 'The workspace could not be renamed. Try again.'));
          input.focus();
        }
      );
    });

    // ---- remove ----

    keep.addEventListener('click', function () {
      if (busy) return;
      row.closeConfirm(true);
    });

    confirm.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        row.closeConfirm(true);
      }
    });

    go.addEventListener('click', function () {
      if (busy) return;
      var label = go.textContent;
      var position = entries.findIndex(function (e) {
        return e.id === entry.id;
      });
      row.showError('');
      row.showStatus('');
      setBusy(true);
      go.setAttribute('aria-busy', 'true');
      go.textContent = local ? 'Deleting…' : 'Forgetting…';
      invoke('workspace_remove', { id: entry.id }).then(
        function () {
          setBusy(false);
          announce(local ? 'Deleted ' + entry.name + '.' : 'Forgot ' + entry.name + '.');
          reload(function () {
            if (entries.length === 0) {
              focusStart();
              return;
            }
            var next = entries[Math.min(position, entries.length - 1)];
            focusRow(next.id, 'open');
          });
        },
        function (reason) {
          go.removeAttribute('aria-busy');
          go.textContent = label;
          setBusy(false);
          row.showError(sentence(reason, 'The workspace could not be removed. Try again.'));
          go.focus();
        }
      );
    });

    return row;
  }

  function render() {
    if (openMenu) openMenu.closeMenu(false);
    recentList.textContent = '';
    rows = {};
    entries.forEach(function (entry, i) {
      var row = makeRow(entry, i);
      rows[entry.id] = row;
      recentList.appendChild(row.el);
    });
    recentCount.textContent = '';
    if (entries.length > 1) {
      recentCount.appendChild(document.createTextNode(String(entries.length)));
      var words = document.createElement('span');
      words.className = 'visually-hidden';
      words.textContent = ' workspaces';
      recentCount.appendChild(words);
    }
    recentList.hidden = entries.length === 0;
    // A first start shows one way in, not an empty list: "No workspaces yet" and the
    // Tutorial. The Presets beside it stay the same in every state.
    recent.hidden = entries.length === 0 && recentError.hidden;
    first.hidden = !(entries.length === 0 && recentError.hidden);
  }

  function focusRow(id, which) {
    var row = rows[id];
    if (!row) return focusStart();
    (which === 'open' ? row.open : row.moreBtn).focus();
  }

  // Where the focus starts: the newest Workspace, or on a first start the button that makes
  // the Tutorial (scripts/package-linux.sh presses Return there to make one).
  function focusStart() {
    var top = recentList.querySelector('.entry-open');
    if (top && !recent.hidden) top.focus();
    else if (!first.hidden) firstTutorial.focus();
    else tiles[0].focus();
  }

  function newestFirst(list) {
    return list.slice().sort(function (a, b) {
      return (b.lastOpened || 0) - (a.lastOpened || 0);
    });
  }

  function reload(then) {
    invoke('start_view').then(
      function (view) {
        recentError.hidden = true;
        entries = newestFirst((view && Array.isArray(view.workspaces) && view.workspaces) || []);
        render();
        if (then) then(view);
      },
      function (reason) {
        recentErrorText.textContent = sentence(reason, 'Your workspaces could not be listed.');
        recentError.hidden = false;
        entries = [];
        render();
        if (then) then(null);
      }
    );
  }

  $('recent-retry').addEventListener('click', function () {
    if (busy) return;
    reload(function () {
      if (entries.length) focusStart();
      else if (!recentError.hidden) $('recent-retry').focus();
      else focusStart();
    });
  });

  // ---- an update that is ready (docs/specs/release.md, section 11) --------------------
  //
  // Only a build with the updater ever has one; it is downloaded and checked in the
  // background, so the screen asks again now and then. Installing it backs up every Local
  // Workspace first, then the app starts again as the new version.

  var updateBox = $('update');
  var updateText = $('update-text');
  var updateGo = $('update-go');
  var updateError = $('update-error');
  var updateTimer = 0;

  function showUpdateError(text) {
    updateError.textContent = text || '';
    updateError.hidden = !text;
  }

  function lookForUpdate() {
    invoke('update_view').then(
      function (ready) {
        if (ready && typeof ready.notice === 'string' && ready.notice) {
          updateText.textContent = ready.notice;
          updateBox.hidden = false;
        } else if (!busy) {
          updateBox.hidden = true;
        }
      },
      function () {
        // An app without the command (or with it refused) has nothing to offer.
        window.clearInterval(updateTimer);
      }
    );
  }

  updateGo.addEventListener('click', function () {
    if (busy) return;
    clearMessages();
    showUpdateError('');
    closeAllPanels(null);
    setBusy(true);
    updateGo.setAttribute('aria-busy', 'true');
    spinnerText(updateGo, 'Backing up your workspaces…');
    announce('Backing up your workspaces, then installing the update…');
    invoke('update_install').then(
      function () {
        // The app starts again as the new version.
        updateGo.textContent = 'Restarting…';
      },
      function (reason) {
        updateGo.removeAttribute('aria-busy');
        updateGo.textContent = 'Restart to update';
        setBusy(false);
        announce('');
        showUpdateError(sentence(reason, 'The update could not be installed. Try again.'));
        lookForUpdate();
        updateGo.focus();
      }
    );
  });

  lookForUpdate();
  updateTimer = window.setInterval(lookForUpdate, 20000);

  reload(function (view) {
    if (view && typeof view.notice === 'string' && view.notice) showNotice(view.notice);
    focusStart();
  });
})();
