// The Qoop desktop bridge: puts `window.qoopDesktop` (docs/specs/desktop.md) on the pages of
// the configured server origin, in the top frame only. The app injects this as an
// initialization script that the webview runs in the main frame only; the checks below hold
// even if it ever ran somewhere else.
//
// __QOOP_ORIGIN__, __QOOP_VERSION__ and __QOOP_KEY__ are replaced by JSON string literals.
(function () {
  'use strict';
  var ORIGIN = __QOOP_ORIGIN__;
  var VERSION = __QOOP_VERSION__;
  // Sent with every call; the app refuses calls without it. It lives only in this closure,
  // so a frame (which never runs this script) cannot learn it.
  var KEY = __QOOP_KEY__;

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

  Object.defineProperty(window, 'qoopDesktop', {
    value: Object.freeze({ version: VERSION, claude: claude, runner: runner }),
    writable: false,
    configurable: false,
    enumerable: true
  });
})();
