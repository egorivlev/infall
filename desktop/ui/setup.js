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
  var createSection = document.querySelector('.section.create');
  var createStatus = $('create-status');
  var createError = $('create-error');
  var signinForm = $('signin-form');
  var address = $('address');
  var addressError = $('address-error');
  var signin = $('signin');
  var importBox = $('import');
  var importBtn = $('import-btn');
  var importError = $('import-error');
  var importSlotRecent = $('import-slot-recent');
  var importSlotCreate = $('import-slot-create');
  var tiles = Array.prototype.slice.call(document.querySelectorAll('.tile'));
  var template = $('entry-template');

  var busy = false;
  var entries = []; // WorkspaceEntry[] as start_view gave them
  var rows = {}; // id -> row controller
  var openMenu = null; // the row whose menu is open

  function invoke(command, args) {
    try {
      return Promise.resolve(window.__TAURI_INTERNALS__.invoke(command, args || {}));
    } catch (e) {
      return Promise.reject(e);
    }
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
        '.tile, #signin, #import-btn, .entry-open, .entry-actions button, .menu button, .confirm button, .entry-rename button'
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
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

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

  // "<verb> just now", "<verb> 5 minutes ago", "<verb> today at 09:12", "<verb> on Monday",
  // "<verb> 3 Nov": relative while it is recent, a date after a week.
  function when(verb, ms, now) {
    var d = new Date(ms);
    var diff = now - ms;
    if (diff < 60 * 1000) return verb + ' just now';
    if (diff < 60 * 60 * 1000) {
      var m = Math.floor(diff / 60000);
      return verb + ' ' + m + (m === 1 ? ' minute ago' : ' minutes ago');
    }
    var days = Math.round((startOfDay(new Date(now)) - startOfDay(d)) / 86400000);
    if (days <= 0) return verb + ' today at ' + clock(d);
    if (days === 1) return verb + ' yesterday at ' + clock(d);
    if (days < 7) return verb + ' on ' + DAYS[d.getDay()];
    var date = d.getDate() + ' ' + MONTHS[d.getMonth()];
    if (d.getFullYear() !== new Date(now).getFullYear()) date += ' ' + d.getFullYear();
    return verb + ' ' + date;
  }

  function whenOpened(ms, now) {
    return known(ms) ? when('opened', ms, now) : 'not opened yet';
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

  function showCreateError(text) {
    createError.textContent = text || '';
    createError.hidden = !text;
  }

  tiles.forEach(function (tile) {
    tile.addEventListener('click', function () {
      if (busy) return;
      var preset = tile.getAttribute('data-preset');
      var name = tile.getAttribute('data-name');
      var desc = tile.querySelector('.tile-desc');
      var descText = desc.textContent;
      clearMessages();
      setBusy(true);
      tile.setAttribute('aria-busy', 'true');
      spinnerText(desc, 'Creating…');
      createStatus.textContent = 'Creating the ' + name + ' workspace…';
      invoke('workspace_create', { preset: preset }).then(
        function () {
          // The shell opens the new Workspace and closes this window.
          desc.textContent = 'Opening…';
          createStatus.textContent = 'Opening the ' + name + ' workspace…';
        },
        function (reason) {
          tile.removeAttribute('aria-busy');
          desc.textContent = descText;
          createStatus.textContent = '';
          setBusy(false);
          showCreateError(sentence(reason, 'The workspace could not be created. Try again.'));
          tile.focus();
        }
      );
    });
  });

  // ---- import -------------------------------------------------------------------------

  function showImportError(text) {
    importError.textContent = text || '';
    importError.hidden = !text;
  }

  importBtn.addEventListener('click', function () {
    if (busy) return;
    clearMessages();
    closeAllPanels(null);
    setBusy(true);
    importBtn.setAttribute('aria-busy', 'true');
    spinnerText(importBtn, 'Importing…');
    function done() {
      importBtn.removeAttribute('aria-busy');
      importBtn.textContent = 'Import a workspace…';
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
        importBtn.focus();
      }
    );
  });

  // ---- sign in ------------------------------------------------------------------------

  function showAddressError(text) {
    addressError.textContent = text || '';
    addressError.hidden = !text;
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

    var local = entry.kind === 'local';
    var uid = 'entry-' + index;
    var now = Date.now();
    var whenText = whenOpened(entry.lastOpened, now);
    var backupText = local && known(entry.lastBackup) ? when('backed up', entry.lastBackup, now) : '';

    nameEl.textContent = entry.name;
    nameEl.id = uid + '-name';
    kindEl.textContent = local ? 'Local' : 'Team';
    kindEl.className = 'kind ' + (local ? 'kind-local' : 'kind-team');
    if (local) {
      whereEl.textContent = entry.preset ? PRESET_NAMES[entry.preset] || entry.preset : '';
    } else {
      whereEl.textContent = entry.address || '';
      whereEl.classList.add('address');
      whereEl.title = entry.address || '';
    }
    if (!whereEl.textContent) whereEl.hidden = true;
    whenEl.textContent = whenText;
    if (known(entry.lastOpened)) whenEl.title = fullDate(entry.lastOpened);
    if (backupText) {
      backupEl.textContent = backupText;
      backupEl.title = 'Backed up ' + fullDate(entry.lastBackup);
      backupEl.hidden = false;
    }

    var kindWords = local
      ? 'Local Workspace' + (entry.preset ? ', ' + (PRESET_NAMES[entry.preset] || entry.preset) : '')
      : 'Team Workspace at ' + (entry.address || '');
    var meta = li.querySelector('.entry-meta');
    open.setAttribute('aria-label', 'Open ' + entry.name);
    open.setAttribute('aria-describedby', uid + '-meta');
    meta.id = uid + '-meta';
    meta.setAttribute('aria-label', kindWords + ', ' + whenText + (backupText ? ', ' + backupText : ''));

    // Team Workspaces have no file on this computer: no export, no folder.
    if (!local) {
      Array.prototype.slice.call(menu.querySelectorAll('[data-local]')).forEach(function (b) {
        b.parentNode.removeChild(b);
      });
    }
    var items = Array.prototype.slice.call(menu.querySelectorAll('[role="menuitem"]'));

    moreBtn.setAttribute('aria-label', 'More for ' + entry.name);
    moreBtn.title = 'Rename, ' + (local ? 'export, show in folder, ' : '') + 'remove';
    moreBtn.setAttribute('aria-controls', uid + '-menu');
    menu.id = uid + '-menu';
    menu.setAttribute('aria-label', entry.name);

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
    if (local) {
      confirmTitle.textContent = 'Delete “' + entry.name + '” for good?';
      confirmBody.textContent =
        'Its Board, Pages and history are removed from this computer, and its backups with them. ' +
        'This cannot be undone. To keep a copy, export a Workspace file first.';
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
        moreBtn.setAttribute('aria-expanded', 'true');
        placeMenu(menu, moreBtn);
        (focusLast ? items[items.length - 1] : items[0]).focus();
      },
      closeMenu: function (refocus) {
        if (openMenu !== row) return;
        openMenu = null;
        menu.hidden = true;
        moreBtn.setAttribute('aria-expanded', 'false');
        if (refocus) moreBtn.focus();
      },
      startRename: function () {
        closeAllPanels(row);
        row.closeConfirm(false);
        row.showError('');
        row.showStatus('');
        row.renaming = true;
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
      }
    };

    // ---- open ----

    open.addEventListener('click', function () {
      if (busy) return;
      clearMessages();
      closeAllPanels(null);
      setBusy(true);
      open.setAttribute('aria-busy', 'true');
      li.setAttribute('aria-busy', 'true');
      spinnerText(whenEl, 'Opening…');
      whenEl.classList.add('is-busy');
      announce('Opening ' + entry.name + '…');
      invoke('workspace_open', { id: entry.id }).then(
        function () {
          // The shell shows the Workspace and closes this window.
        },
        function (reason) {
          open.removeAttribute('aria-busy');
          li.removeAttribute('aria-busy');
          whenEl.textContent = whenText;
          setBusy(false);
          row.showError(sentence(reason, 'This workspace could not be opened. Try again.'));
          open.focus();
        }
      );
    });

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
      var i = items.indexOf(document.activeElement);
      var next = -1;
      if (event.key === 'ArrowDown') next = (i + 1) % items.length;
      else if (event.key === 'ArrowUp') next = (i - 1 + items.length) % items.length;
      else if (event.key === 'Home' || event.key === 'PageUp') next = 0;
      else if (event.key === 'End' || event.key === 'PageDown') next = items.length - 1;
      else if (event.key === 'Escape') {
        event.preventDefault();
        row.closeMenu(true);
        return;
      } else if (event.key === 'Tab') {
        // Close it and let Tab go on from its button, as if the menu had not been open.
        row.closeMenu(true);
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
        exportFile(null);
      }));
      miReveal.addEventListener('click', fromMenu(function () {
        reveal();
      }));
    }

    // ---- export, show in folder ----

    // `button` is the control that started it when it stays on screen (Export first…);
    // from the menu the row itself says what is going on.
    function exportFile(button) {
      clearMessages();
      setBusy(true);
      li.setAttribute('aria-busy', 'true');
      var label = button ? button.textContent : '';
      if (button) {
        button.setAttribute('aria-busy', 'true');
        spinnerText(button, 'Exporting…');
      } else {
        moreBtn.setAttribute('aria-busy', 'true');
        status.hidden = false;
        spinnerText(status, 'Exporting ' + entry.name + '…');
      }
      announce('Exporting ' + entry.name + '…');
      function done() {
        li.removeAttribute('aria-busy');
        moreBtn.removeAttribute('aria-busy');
        if (button) {
          button.removeAttribute('aria-busy');
          button.textContent = label;
        }
        row.showStatus('');
        setBusy(false);
      }
      invoke('workspace_export', { id: entry.id }).then(
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
    recentCount.textContent = entries.length > 1 ? entries.length + ' workspaces' : '';
    recentList.hidden = entries.length === 0;
    recentList.classList.toggle('long', entries.length > 2);
    // A first start shows the ways in, not an empty box.
    recent.hidden = entries.length === 0 && recentError.hidden;
    // Import sits under the list; with no list, under the ways to create one.
    var slot = recent.hidden ? importSlotCreate : importSlotRecent;
    if (importBox.parentNode !== slot) slot.appendChild(importBox);
    // With a list to show, the Create tiles shrink so both fit in the window.
    var compact = entries.length > 0;
    createSection.classList.toggle('compact', compact);
    // In the small tiles the description is read out but not shown; hovering shows it.
    tiles.forEach(function (tile) {
      var desc = tile.querySelector('.tile-desc');
      if (compact && desc) tile.title = desc.textContent;
      else tile.removeAttribute('title');
    });
  }

  function focusRow(id, which) {
    var row = rows[id];
    if (!row) return focusStart();
    (which === 'open' ? row.open : row.moreBtn).focus();
  }

  function focusStart() {
    var first = recentList.querySelector('.entry-open');
    if (first && !recent.hidden) first.focus();
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
      else tiles[0].focus();
    });
  });

  reload(function (view) {
    if (view && typeof view.notice === 'string' && view.notice) showNotice(view.notice);
    focusStart();
  });
})();
