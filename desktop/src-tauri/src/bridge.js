// The Infall desktop bridge: puts `window.qoopDesktop` (docs/specs/desktop.md,
// docs/specs/local.md) on the pages of the open Workspace's origin, in the top frame only. The app injects this as an
// initialization script that the webview runs in the main frame only; the checks below hold
// even if it ever ran somewhere else.
//
// __QOOP_ORIGIN__, __QOOP_VERSION__ and __QOOP_KEY__ are replaced by JSON string literals,
// __QOOP_OWN_PRINT__ by `true` or `false`, __QOOP_MAX_BINARY_BYTES__,
// __QOOP_MAX_MOVE_BYTES__ and __QOOP_MAX_PDF_BYTES__ by the app's limits (numbers).
(function () {
  'use strict';
  var ORIGIN = __QOOP_ORIGIN__;
  var VERSION = __QOOP_VERSION__;
  // Sent with every call; the app refuses calls without it. It lives only in this closure,
  // so a frame (which never runs this script) cannot learn it.
  var KEY = __QOOP_KEY__;
  // Whether `window.print()` is the app's to do (macOS: the webview ignores it).
  var OWN_PRINT = __QOOP_OWN_PRINT__;
  // `saveFile` takes at most this much text (UTF-8 bytes; the app checks it again).
  var MAX_SAVE_BYTES = 20971520;

  if (window.top !== window) return;
  if (window.location.origin !== ORIGIN) return;
  if (Object.prototype.hasOwnProperty.call(window, 'qoopDesktop')) return;

  function call(command, args) {
    var tauri = window.__TAURI_INTERNALS__;
    if (!tauri || typeof tauri.invoke !== 'function') {
      return Promise.reject(new Error('The desktop app is not reachable.'));
    }
    args.key = KEY;
    return tauri.invoke(command, args);
  }

  // Calls a command that reports through a stream of events, delivers the events to
  // `onEvent` in the order the app sent them, and resolves once the command has returned
  // and the last event has been delivered. `failure` is the event to deliver when the app
  // cannot be reached or refuses the call.
  function stream(command, args, onEvent, failure) {
    return new Promise(function (resolve) {
      var tauri = window.__TAURI_INTERNALS__;
      var finished = false; // the caller has been told the run ended
      var returned = false; // the app's command has returned
      var closed = false; // the app has closed the event stream
      var next = 0; // events are numbered by the app and delivered in that order
      var waiting = {};
      var callbackId = null;
      var fallback = null;

      function deliver(event) {
        if (finished) return;
        try {
          onEvent(event);
        } catch (error) {
          console.error(error);
        }
      }

      function finish() {
        if (finished) return;
        finished = true;
        if (fallback !== null) clearTimeout(fallback);
        if (callbackId !== null && tauri && typeof tauri.unregisterCallback === 'function') {
          tauri.unregisterCallback(callbackId);
        }
        resolve();
      }

      function settle() {
        // Resolve only once every event has been delivered: the command has returned and
        // the stream has been closed behind the last event.
        if (returned && closed) finish();
      }

      function fail(unreachable) {
        deliver(failure(unreachable));
        finish();
      }

      if (!tauri || typeof tauri.invoke !== 'function' || typeof tauri.transformCallback !== 'function') {
        fail(true);
        return;
      }

      callbackId = tauri.transformCallback(function (packet) {
        if (!packet || typeof packet.index !== 'number') return;
        waiting[packet.index] = packet;
        while (Object.prototype.hasOwnProperty.call(waiting, next)) {
          var current = waiting[next];
          delete waiting[next];
          next += 1;
          if (current.end) {
            closed = true;
            settle();
          } else {
            deliver(current.message);
          }
        }
      });

      args.onEvent = '__CHANNEL__:' + callbackId;
      call(command, args).then(
        function () {
          returned = true;
          settle();
          // Should the closing packet never arrive, do not leave the caller waiting.
          if (!finished) fallback = setTimeout(finish, 3000);
        },
        function () {
          // Never the app's own words here: they could quote the request.
          fail(false);
        }
      );
    });
  }

  function send(request, onEvent) {
    return stream('claude_send', { request: request }, onEvent, function (unreachable) {
      return {
        type: 'error',
        message: unreachable ? 'The desktop app is not reachable.' : 'The desktop app could not start Claude Code.'
      };
    });
  }

  var claude = Object.freeze({
    status: function () {
      return call('claude_status', {}).then(function (status) {
        var result = { installed: !!(status && status.installed) };
        if (status && typeof status.version === 'string') result.version = status.version;
        return result;
      });
    },
    send: send,
    cancel: function (id) {
      return call('claude_cancel', { id: String(id) }).then(function () {});
    }
  });

  // The Runner (docs/specs/desktop.md, M8). A page can read the status, ask for the app's
  // own settings window, ask for a Run of some code, and cancel it. Which interpreter runs
  // it, in which folder, and whether it runs at all is decided in the app's own windows.
  // Events reach `onEvent` as the app sent them, the M9 one included:
  // `{ type: 'stats', cpu_percent, cores, memory_bytes, memory_total_bytes, processes, gpu?,
  // step?, progress? }`, about once a second while the process runs.
  //
  // Since M19/M19b a Run names its language (`lang`, absent: Python) and, for Python and Q#,
  // the environment it wants (`env`). Only names travel: which program they start is this
  // computer's setting. Such a Run is asked for with `start`, which an app from before it
  // does not have, so an older app refuses it instead of running it as Python; `run` stays
  // Python in the default environment, exactly as in M8, and refuses any other language.
  function runFailure(unreachable) {
    return {
      type: 'error',
      reason: 'failed',
      message: unreachable ? 'The desktop app is not reachable.' : 'The desktop app could not start the Run.'
    };
  }

  function runRequest(request) {
    return {
      id: String(request && request.id),
      code: String(request && request.code),
      title: String(request && request.title != null ? request.title : '')
    };
  }

  function namesLanguage(request) {
    return !!request && request.lang != null && request.lang !== 'python';
  }

  var runner = Object.freeze({
    status: function () {
      return call('runner_status', {}).then(function (status) {
        var result = {};
        var python = status && status.python;
        if (python && typeof python.path === 'string' && typeof python.version === 'string') {
          result.python = { path: python.path, version: python.version };
        }
        if (status && typeof status.folder === 'string') result.folder = status.folder;
        // Names and versions only: which program a language starts is not the page's.
        var languages = {};
        var listed = status && status.languages;
        if (listed && typeof listed === 'object') {
          Object.keys(listed).forEach(function (id) {
            var entry = listed[id];
            if (!entry || typeof entry.name !== 'string') return;
            var language = { name: entry.name };
            if (typeof entry.version === 'string') language.version = entry.version;
            languages[id] = language;
          });
        }
        result.languages = languages;
        result.environments = Array.isArray(status && status.environments)
          ? status.environments.filter(function (name) {
              return typeof name === 'string';
            })
          : [];
        return result;
      });
    },
    configure: function (lang) {
      var args = {};
      if (typeof lang === 'string') args.lang = lang;
      return call('runner_configure', args).then(function () {});
    },
    run: function (request, onEvent) {
      if (namesLanguage(request)) {
        // Never as Python: a Run in another language is asked for with `start`.
        return Promise.resolve().then(function () {
          onEvent({
            type: 'error',
            reason: 'failed',
            message: 'This Run is not in Python, and was not asked for as such.'
          });
        });
      }
      return stream('runner_run', { request: runRequest(request) }, onEvent, runFailure);
    },
    start: function (request, onEvent) {
      var sent = runRequest(request);
      if (request && request.lang != null) sent.lang = String(request.lang);
      if (request && request.env != null && request.env !== '') sent.env = String(request.env);
      return stream('runner_start', { request: sent }, onEvent, runFailure);
    },
    cancel: function (id) {
      return call('runner_cancel', { id: String(id) }).then(function () {});
    }
  });

  // Back to the start screen, as the menu's "Switch Workspace…" does: stops what is
  // running, closes this window. (M12)
  function switchWorkspace() {
    return call('switch_workspace', {}).then(function () {});
  }

  // Saves text as a file where the person chooses, in the system's save dialog (M13).
  // Resolves true once written, false when the person cancelled; rejects with a sentence.
  function saveFile(file) {
    var name = file && file.suggestedName != null ? String(file.suggestedName) : '';
    var text = file && file.text != null ? String(file.text) : '';
    if (typeof text.toWellFormed === 'function') text = text.toWellFormed();
    // A string longer than this in UTF-16 units is longer in UTF-8 bytes too.
    if (text.length > MAX_SAVE_BYTES) {
      return Promise.reject(new Error('The file is too large to save (at most 20 MB).'));
    }
    return call('save_file', { suggestedName: name, text: text }).then(function (saved) {
      return saved === true;
    });
  }

  // Bytes across the bridge (M18) travel as base64 text in pieces: this page may not reach
  // the app's binary channel (see transfer.rs in the app).
  var MAX_BINARY_BYTES = __QOOP_MAX_BINARY_BYTES__;
  var MAX_MOVE_BYTES = __QOOP_MAX_MOVE_BYTES__;
  var SAVE_CHUNK_BYTES = 3145728; // 3 MB of bytes, 4 MB of text, per call
  var TOO_LARGE = 'The file is too large to save (at most ' + Math.round(MAX_BINARY_BYTES / 1048576) + ' MB).';

  function toBase64(bytes) {
    var parts = [];
    for (var i = 0; i < bytes.length; i += 0x8000) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)));
    }
    return btoa(parts.join(''));
  }

  // Decodes `text` into `target` from `at`; returns how many bytes it held. `changed` is the
  // sentence when there is more than the size said.
  function fromBase64(text, target, at, changed) {
    var raw = atob(text);
    if (at + raw.length > target.length) throw new Error(changed);
    for (var i = 0; i < raw.length; i++) target[at + i] = raw.charCodeAt(i);
    return raw.length;
  }

  // The bytes of a Uint8Array, an ArrayBuffer or any typed array, as a Uint8Array; null else.
  function asBytes(bytes) {
    if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
    if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return null;
  }

  // Sends `bytes` to the app in pieces (`save_binary_begin`, `save_binary_chunk`), then calls
  // `finish` with the ticket that names them; resolves to what `finish` answered.
  function sendBytes(bytes, finish, args) {
    return call('save_binary_begin', { size: bytes.length }).then(function (ticket) {
      var offset = 0;
      function next() {
        if (offset >= bytes.length) {
          args.ticket = ticket;
          return call(finish, args);
        }
        var end = Math.min(offset + SAVE_CHUNK_BYTES, bytes.length);
        var at = offset;
        var data = toBase64(bytes.subarray(at, end));
        offset = end;
        return call('save_binary_chunk', { ticket: ticket, offset: at, data: data }).then(next);
      }
      return next();
    });
  }

  // Reads a file from the app in pieces of `{ size, data }` (`command` with `args` and the
  // offset); resolves to one Uint8Array of the whole file.
  function readBytes(command, args, max, unreadable, changed) {
    function piece(offset) {
      var sent = {};
      Object.keys(args).forEach(function (k) {
        sent[k] = args[k];
      });
      sent.offset = offset;
      return call(command, sent);
    }
    return piece(0).then(function (first) {
      var size = first && first.size;
      if (typeof size !== 'number' || !(size >= 0) || size > max) throw new Error(unreadable);
      var out = new Uint8Array(size);
      var at = 0;
      function take(chunk) {
        if (!chunk || chunk.size !== size || typeof chunk.data !== 'string') throw new Error(changed);
        var got = fromBase64(chunk.data, out, at, changed);
        at += got;
        if (at >= size) return out;
        if (got === 0) throw new Error(unreadable);
        return piece(at).then(take);
      }
      return take(first);
    });
  }

  // Saves bytes the page made (an image, a Workspace file) where the person chooses, in the
  // system's save dialog (M18). Resolves true once written, false when the person cancelled;
  // rejects with a sentence.
  function saveBinaryFile(file) {
    var name = file && file.suggestedName != null ? String(file.suggestedName) : '';
    var bytes = asBytes(file ? file.bytes : null);
    if (!bytes) return Promise.reject(new Error('There is no file to save.'));
    if (bytes.length > MAX_BINARY_BYTES) return Promise.reject(new Error(TOO_LARGE));
    return sendBytes(bytes, 'save_binary_finish', { suggestedName: name }).then(function (saved) {
      return saved === true;
    });
  }

  // PDFs (M19; docs/specs/pdf-sources.md, decision 10). A folder the person picks in the
  // system's dialog: the page gets a token and the folder's name, never its path; the token
  // dies with this page.
  var MAX_PDF_BYTES = __QOOP_MAX_PDF_BYTES__;
  var PDF_TOO_LARGE = 'The file is too large to open (at most ' + Math.round(MAX_PDF_BYTES / 1048576) + ' MB).';

  function pickFolder() {
    return call('pick_folder', {}).then(function (picked) {
      if (!picked || typeof picked.token !== 'string' || typeof picked.name !== 'string') return null;
      return { token: picked.token, name: picked.name };
    });
  }

  // A PDF inside the picked folder: `relativePath` relative to it, or an absolute path (what a
  // BibTeX `file` field says, as it says it), which the app takes only when it is inside.
  function readFileIn(token, relativePath) {
    return readBytes(
      'folder_file_chunk',
      { token: String(token == null ? '' : token), path: String(relativePath == null ? '' : relativePath) },
      MAX_PDF_BYTES,
      'The file could not be read. Try again.',
      'The file changed while it was read. Try again.'
    );
  }

  // A PDF the page has, opened in the system's own viewer (written to a private temporary
  // file first, deleted when the app quits).
  function openExternally(file) {
    var name = file && file.suggestedName != null ? String(file.suggestedName) : '';
    var bytes = asBytes(file ? file.bytes : null);
    if (!bytes) return Promise.reject(new Error('There is no PDF to open.'));
    if (bytes.length > MAX_PDF_BYTES) return Promise.reject(new Error(PDF_TOO_LARGE));
    var magic = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
    for (var i = 0; i < magic.length; i++) {
      if (bytes[i] !== magic[i]) return Promise.reject(new Error('That file is not a PDF.'));
    }
    return sendBytes(bytes, 'open_external_finish', { suggestedName: name }).then(function () {});
  }

  // Moving a Local Workspace onto this server (docs/specs/team-move.md, Contract C). The app
  // answers only on the origin of a server a move from this computer is pending to.
  function moveHandover() {
    return call('move_handover', {}).then(function (handover) {
      if (!handover || typeof handover.name !== 'string' || typeof handover.size !== 'number') return null;
      return { name: handover.name, size: handover.size };
    });
  }

  function moveFile() {
    return readBytes(
      'move_file_chunk',
      {},
      MAX_MOVE_BYTES,
      'The Workspace file could not be read. Try again.',
      'The Workspace file changed while it was read. Try again.'
    );
  }

  function moveDone(result) {
    // `cancel` only with `ok: false`: the server can never take it, so the move is dropped.
    var ok = !!(result && result.ok === true);
    var cancel = !ok && !!(result && result.cancel === true);
    return call('move_done', { ok: ok, cancel: cancel }).then(function () {});
  }

  // `window.print()` opens the system's print dialog for this page.
  if (OWN_PRINT) {
    window.print = function () {
      call('print_page', {}).catch(function () {});
    };
  }

  // Undo (M15). The page's own `window.__infallUndo` says what Undo and Redo would do; this
  // tells the app, whose Edit menu names the step and calls the page's own `undo()` and
  // `redo()`. Only the two labels go to the app, with the key, and nothing comes back. With
  // no such object (an older web UI, another server's pages) nothing is sent, and the menu
  // stays the system's own. The keys are the page's: see docs/specs/desktop.md, M15.
  var MAX_STEP_LABEL = 200;
  var undoValue; // what the page set as `window.__infallUndo`
  var undoWatched; // the object subscribed to, and its unsubscribe
  var undoStop = null;
  var sentUndo = null; // what the app was last told
  var sentRedo = null;
  var undoQueued = false;
  var undoBusy = false; // a state is on its way to the app; another waits behind it
  var undoAgain = false;

  function undoLabel(state, which) {
    var label = state ? state[which] : null;
    return typeof label === 'string' && label !== '' ? label.slice(0, MAX_STEP_LABEL) : null;
  }

  function tellUndo() {
    undoQueued = false;
    var source = window.__infallUndo;
    if (source !== undoWatched) {
      if (undoStop) {
        try {
          undoStop();
        } catch (error) {}
      }
      undoStop = null;
      undoWatched = source;
      try {
        if (source && typeof source.subscribe === 'function') {
          var stop = source.subscribe(queueUndo);
          if (typeof stop === 'function') undoStop = stop;
        }
      } catch (error) {}
    }
    var undo = null;
    var redo = null;
    try {
      var state = source && typeof source.state === 'function' ? source.state() : null;
      undo = undoLabel(state, 'undo');
      redo = undoLabel(state, 'redo');
    } catch (error) {
      undo = redo = null;
    }
    if (undo === sentUndo && redo === sentRedo) return;
    if (undoBusy) {
      undoAgain = true;
      return;
    }
    undoBusy = true;
    sentUndo = undo;
    sentRedo = redo;
    function sent() {
      undoBusy = false;
      if (undoAgain) {
        undoAgain = false;
        queueUndo();
      }
    }
    call('undo_state', { undo: undo, redo: redo }).then(sent, sent);
  }

  function queueUndo() {
    if (undoQueued) return;
    undoQueued = true;
    setTimeout(tellUndo, 0);
  }

  // Seen as soon as the page sets it (this script runs before the page's own).
  try {
    if (!Object.prototype.hasOwnProperty.call(window, '__infallUndo')) {
      Object.defineProperty(window, '__infallUndo', {
        configurable: true,
        enumerable: false,
        get: function () {
          return undoValue;
        },
        set: function (value) {
          undoValue = value;
          queueUndo();
        }
      });
    }
  } catch (error) {}
  // And looked at again after every focus change and gesture: entering or leaving a field
  // changes what the menu should do, and the page may have put its object there another way.
  ['focusin', 'focusout', 'pointerup', 'keyup'].forEach(function (type) {
    window.addEventListener(type, queueUndo, true);
  });

  Object.defineProperty(window, 'qoopDesktop', {
    value: Object.freeze({
      version: VERSION,
      claude: claude,
      runner: runner,
      switchWorkspace: switchWorkspace,
      saveFile: saveFile,
      saveBinaryFile: saveBinaryFile,
      moveHandover: moveHandover,
      moveFile: moveFile,
      moveDone: moveDone,
      pickFolder: pickFolder,
      readFileIn: readFileIn,
      openExternally: openExternally
    }),
    writable: false,
    configurable: false,
    enumerable: true
  });
})();
