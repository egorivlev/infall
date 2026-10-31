// The Infall desktop bridge: puts `window.qoopDesktop` (docs/specs/desktop.md,
// docs/specs/local.md) on the pages of the open Workspace's origin, in the top frame only. The app injects this as an
// initialization script that the webview runs in the main frame only; the checks below hold
// even if it ever ran somewhere else.
//
// __QOOP_ORIGIN__, __QOOP_VERSION__ and __QOOP_KEY__ are replaced by JSON string literals,
// __QOOP_OWN_PRINT__ by `true` or `false`.
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
  var runner = Object.freeze({
    status: function () {
      return call('runner_status', {}).then(function (status) {
        var result = {};
        var python = status && status.python;
        if (python && typeof python.path === 'string' && typeof python.version === 'string') {
          result.python = { path: python.path, version: python.version };
        }
        if (status && typeof status.folder === 'string') result.folder = status.folder;
        return result;
      });
    },
    configure: function () {
      return call('runner_configure', {}).then(function () {});
    },
    run: function (request, onEvent) {
      var sent = {
        id: String(request && request.id),
        code: String(request && request.code),
        title: String(request && request.title != null ? request.title : '')
      };
      return stream('runner_run', { request: sent }, onEvent, function (unreachable) {
        return {
          type: 'error',
          reason: 'failed',
          message: unreachable ? 'The desktop app is not reachable.' : 'The desktop app could not start the Run.'
        };
      });
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
      saveFile: saveFile
    }),
    writable: false,
    configurable: false,
    enumerable: true
  });
})();
