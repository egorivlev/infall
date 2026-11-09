// The approval window. It can do two things in the app, and nothing else: read the code it
// asks about and give the Member's answer (src-tauri/capabilities/runner-approval.json).
//
// The title and the code are written by other people. Everything from the app is put on
// the page as text (textContent / text nodes); nothing is ever parsed as HTML.
(function () {
  'use strict';
  var code = document.getElementById('code');
  var notices = document.getElementById('notices');
  var hint = document.getElementById('hint');
  var error = document.getElementById('error');
  var runButton = document.getElementById('run');
  var dontButton = document.getElementById('dont');

  var loaded = false; // the code is on screen
  var waited = false; // it has been there for a moment
  var reachedEnd = false; // the Member has scrolled to its end
  var sent = false; // an answer is on its way

  function invoke(command, args) {
    return window.__TAURI_INTERNALS__.invoke(command, args || {});
  }

  function setText(id, text) {
    document.getElementById(id).textContent = text;
  }

  function showError(message) {
    error.textContent = message;
    error.hidden = !message;
  }

  function update() {
    runButton.disabled = !(loaded && waited && reachedEnd) || sent;
    if (!loaded) hint.textContent = '';
    else if (!reachedEnd) hint.textContent = 'Scroll to the end of the code to be able to run it.';
    else if (!waited) hint.textContent = 'One moment…';
    else
      hint.textContent =
        'Infall will remember this exact code, in this language and run by this program, for this Workspace, and not ask again until one of them changes.';
  }

  // A command as it will be started: the program, then each argument as it is passed (no
  // shell reads them). An argument with a space or a quote is shown in quotes so that where
  // one ends is visible; {file} stands for the Run's file.
  function commandText(program, args) {
    return [program]
      .concat(
        (args || []).map(function (arg) {
          arg = String(arg);
          return /[\s"']/.test(arg) || arg === '' ? '"' + arg.replace(/"/g, '\\"') + '"' : arg;
        })
      )
      .join(' ');
  }

  function checkEnd() {
    if (!loaded || reachedEnd) return;
    if (code.scrollTop + code.clientHeight >= code.scrollHeight - 8) {
      reachedEnd = true;
      update();
    }
  }

  function decide(run) {
    if (sent) return;
    sent = true;
    update();
    invoke('approval_decide', { run: run }).then(
      function () {
        // The app closes this window.
      },
      function (reason) {
        sent = false;
        update();
        showError(typeof reason === 'string' ? reason : 'The answer could not be given. Try again.');
      }
    );
  }

  function plural(n, one, many) {
    return n === 1 ? '1 ' + one : n.toLocaleString('en-US') + ' ' + many;
  }

  function render(view) {
    setText('title', String(view.title));
    setText('language', String(view.language || 'Python'));
    setText('origin', String(view.origin));
    if (typeof view.environment === 'string') {
      setText('environment', view.environment);
      document.getElementById('environment').hidden = false;
      document.getElementById('environment-label').hidden = false;
    }
    if (view.lang === 'qsharp') {
      setText('program-label', 'Runs through');
      setText('program', 'Q#, through Python at ' + String(view.program));
    } else if (Array.isArray(view.args)) {
      setText('program-label', 'Command');
      setText('program', commandText(String(view.program), view.args));
      document.getElementById('program').title = '{file} stands for the file the code is written to.';
    } else {
      setText('program', String(view.program));
    }
    setText('folder', view.folder ? String(view.folder) : 'A new, empty temporary folder');
    setText(
      'size',
      plural(view.line_count, 'line', 'lines') + ', ' + plural(view.char_count, 'character', 'characters')
    );

    (view.notices || []).forEach(function (sentence) {
      var item = document.createElement('li');
      item.textContent = String(sentence);
      notices.appendChild(item);
    });
    notices.hidden = notices.childNodes.length === 0;

    var all = document.createDocumentFragment();
    (view.lines || []).forEach(function (parts, index) {
      var row = document.createElement('div');
      row.className = 'line';
      var number = document.createElement('span');
      number.className = 'no';
      number.textContent = String(index + 1);
      var source = document.createElement('span');
      source.className = 'src';
      (parts || []).forEach(function (part) {
        if (part && typeof part.t === 'string') {
          source.appendChild(document.createTextNode(part.t));
        } else if (part && typeof part.h === 'string') {
          // A character that cannot be seen: drawn as its code point.
          var mark = document.createElement('span');
          mark.className = 'hidden-char';
          mark.textContent = part.h;
          mark.title = 'A character that cannot be seen, or that changes how text is drawn';
          source.appendChild(mark);
        }
      });
      row.appendChild(number);
      row.appendChild(source);
      all.appendChild(row);
    });
    code.appendChild(all);

    loaded = true;
    setTimeout(function () {
      waited = true;
      update();
    }, Math.max(0, Number(view.wait_ms) || 0) + 50);
    update();
    // Short code that fits without scrolling has been "scrolled to the end" already.
    requestAnimationFrame(checkEnd);
  }

  code.addEventListener('scroll', checkEnd);
  window.addEventListener('resize', checkEnd);
  runButton.addEventListener('click', function () {
    decide(true);
  });
  dontButton.addEventListener('click', function () {
    decide(false);
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') decide(false);
  });

  update();
  dontButton.focus();
  invoke('approval_view').then(render, function (reason) {
    showError(typeof reason === 'string' ? reason : 'This question is no longer open.');
    hint.textContent = '';
    dontButton.textContent = 'Close';
  });
})();
