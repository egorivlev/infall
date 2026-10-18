# Infall Runner: executes one Run's code and records what it leaves behind.
#
# Started by the Infall desktop app as
#     <python> -u -X utf8 runner.py <main.py>
# with QOOP_RUN_DIR set to the Run's temporary directory. Standard library only; works on
# Python 3.8 and newer.
#
# It makes a module `qoop` importable by the code (qoop.step, qoop.progress: what the code
# says it is doing and how far it is, written to qoop-progress.json for the app to read),
# runs the code as __main__, then saves the matplotlib figures that are still open (only
# if the code imported matplotlib.pyplot) and writes qoop-env.json: the Python version, the
# versions of the packages the code imports, and the names of the figure files.
#
# Nothing in here may hide the program's own output or change its exit code: every step of
# its own is guarded, and its own messages are single lines starting with "[qoop]".

import sys

MAX_FIGURES = 3
MAX_FIGURE_BYTES = 120000  # 160 000 base64 characters
MAX_PACKAGES = 8
MIN_DPI = 12.0
ENV_FILE = "qoop-env.json"
SAID_FILE = "qoop-progress.json"
SAID_INTERVAL = 0.2  # seconds between two writes of it: about five a second
MAX_STEP = 120


def _flush():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.flush()
        except BaseException:
            pass


def _note(text):
    """One line in the Run's output, after everything the program printed."""
    try:
        import os

        _flush()
        os.write(2, ("[qoop] " + text + "\n").encode("utf-8", "replace"))
    except BaseException:
        pass


def _exit_code(error):
    """The exit code a SystemExit asks for, as the interpreter itself would decide it."""
    code = error.code
    if code is None:
        return 0
    if isinstance(code, int):
        return code & 0xFF
    try:
        print(code, file=sys.stderr)
    except BaseException:
        pass
    return 1


def _report(error):
    """Prints the traceback of an exception the program did not catch, without this file's
    own frames. Through the program's own excepthook if it set one; otherwise with the
    traceback module, which shows the code's lines from what was really executed (the
    interpreter's built-in printer would look for a file called main.py instead)."""
    tb = error.__traceback__
    while tb is not None and tb.tb_frame.f_code.co_filename == __file__:
        tb = tb.tb_next
    try:
        error = error.with_traceback(tb)
    except BaseException:
        pass
    if sys.excepthook is not sys.__excepthook__:
        try:
            sys.excepthook(type(error), error, tb)
            return
        except BaseException:
            pass
    try:
        import traceback

        traceback.print_exception(type(error), error, tb)
    except BaseException:
        _note("The program ended with %s." % type(error).__name__)


def _run(main_path):
    """Runs the code in main_path as __main__. Returns (source, exit code)."""
    import linecache
    import os
    import types

    with open(main_path, "rb") as handle:
        data = handle.read()
    # Always UTF-8, and compiled from text: an encoding declaration in the code must not
    # make the interpreter read something else than what the Member was shown.
    source = data.decode("utf-8")

    # Tracebacks say `File "main.py", line N` and show the line, wherever the code runs.
    lines = source.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    linecache.cache["main.py"] = (len(source), None, [line + "\n" for line in lines], "main.py")

    module = types.ModuleType("__main__")
    module.__file__ = main_path
    module.__spec__ = None
    # Keep this file's own module alive under another name: its functions are still needed.
    sys.modules["__qoop_runner__"] = sys.modules["__main__"]
    sys.modules["__main__"] = module
    sys.argv = [main_path]
    # As for any script: the working directory first on the import path, not this file's.
    sys.path[0] = os.getcwd()

    try:
        code = compile(source, "main.py", "exec", dont_inherit=True)
        exec(code, module.__dict__)
    except SystemExit as error:
        return source, _exit_code(error)
    except BaseException as error:
        try:
            # For some syntax errors the interpreter fetches the offending line from a file
            # of that name; there may be another main.py in the working directory.
            if isinstance(error, SyntaxError) and error.filename == "main.py" and error.lineno:
                if 1 <= error.lineno <= len(lines):
                    error.text = lines[error.lineno - 1] + "\n"
        except BaseException:
            pass
        _report(error)
        return source, 1
    return source, 0


def _make_qoop(run_dir):
    """The module `qoop` the code can import. Returns (module, flush); flush writes what was
    said last if that has not been written yet.

    Its functions never raise and never print, whatever they are given: a value that makes
    no sense is ignored. What was said is written to one small file, atomically, at most
    about five times a second; when calls come faster, a timer writes the last one."""
    import _thread
    import json
    import math
    import os
    import time
    import types

    path = os.path.join(run_dir, SAID_FILE)
    lock = _thread.allocate_lock()
    said = {}
    state = {"dirty": False, "written": None, "timer": None}
    # Kept here: the program may replace what the modules offer later on.
    dumps, replace, getpid, open_ = json.dumps, os.replace, os.getpid, open
    clock, isfinite = time.monotonic, math.isfinite

    def write():
        state["dirty"] = False
        state["written"] = clock()
        # Its own name per process: a child process of the code may call qoop too.
        temporary = "%s.%d.tmp" % (path, getpid())
        with open_(temporary, "w", encoding="utf-8") as handle:
            handle.write(dumps(said, allow_nan=False))
        replace(temporary, path)

    def later():
        try:
            if lock.acquire(True, 1.0):
                try:
                    state["timer"] = None
                    if state["dirty"]:
                        write()
                finally:
                    lock.release()
        except Exception:
            pass

    def changed():
        wait = 0.0 if state["written"] is None else state["written"] + SAID_INTERVAL - clock()
        if wait <= 0.0:
            write()
            return
        state["dirty"] = True
        if state["timer"] is None:
            import threading

            timer = threading.Timer(wait, later)
            timer.daemon = True
            timer.start()
            state["timer"] = timer

    def say(change):
        # Never waits long for the lock: a signal handler or a forked child may find it held.
        if not lock.acquire(True, 0.05):
            return
        try:
            if change():
                changed()
        finally:
            lock.release()

    def line(value):
        """The step as one short line; None if it is not text at all."""
        if not isinstance(value, str):
            return None
        for part in value[:2000].splitlines():
            part = part.strip()
            if part:
                part = part[:MAX_STEP]
                part.encode("utf-8")  # raises for text that cannot be written
                return part
        return ""

    def number(value):
        if value is None or isinstance(value, (bool, str, bytes, bytearray)):
            return None
        value = float(value)
        return value if isfinite(value) else None

    def set_step(text):
        if text is None or said.get("step", "") == text:
            return False
        if text:
            said["step"] = text
        else:
            said.pop("step", None)
        return True

    # (*args, **kwargs): even a call with the wrong arguments is only ignored.
    def step(*args, **kwargs):
        """step(text): says what the code is doing now, as one short line."""
        try:
            text = line((lambda text: text)(*args, **kwargs))
            say(lambda: set_step(text))
        except Exception:
            pass

    def progress(*args, **kwargs):
        """progress(done, total, step=None): says how far the code is (total > 0), and
        optionally what it is doing."""
        try:
            done, total, step = (lambda done, total, step=None: (done, total, step))(*args, **kwargs)
            text = None
            try:
                text = line(step)
            except Exception:
                pass
            position = None
            try:
                done, total = number(done), number(total)
                if done is not None and total is not None and total > 0.0:
                    position = (min(max(done, 0.0), total), total)
            except Exception:
                pass

            def change():
                moved = set_step(text)
                if position is not None and (said.get("done"), said.get("total")) != position:
                    said["done"], said["total"] = position
                    moved = True
                return moved

            say(change)
        except Exception:
            pass

    def flush():
        try:
            if lock.acquire(True, 0.05):
                try:
                    if state["dirty"]:
                        write()
                finally:
                    lock.release()
        except BaseException:
            pass

    module = types.ModuleType("qoop", "What a Run's code can tell Infall while it runs: step(text), progress(done, total).")
    module.step = step
    module.progress = progress
    module.__all__ = ["step", "progress"]
    return module, flush


def _save_figures(run_dir):
    """Saves the open matplotlib figures as PNG files; returns their file names."""
    pyplot = sys.modules.get("matplotlib.pyplot")
    if pyplot is None:
        return []
    import math
    import os

    numbers = list(pyplot.get_fignums())
    saved = []
    for position, number in enumerate(numbers[:MAX_FIGURES], 1):
        name = "qoop-figure-%d.png" % (len(saved) + 1)
        path = os.path.join(run_dir, name)
        try:
            figure = pyplot.figure(number)
            dpi = float(figure.dpi)
            kept = False
            for _ in range(8):
                figure.savefig(path, format="png", dpi=dpi)
                size = os.path.getsize(path)
                if size <= MAX_FIGURE_BYTES:
                    kept = True
                    break
                if dpi <= MIN_DPI:
                    break
                # The file size grows about with the square of the resolution.
                dpi = max(MIN_DPI, dpi * min(0.8, 0.9 * math.sqrt(MAX_FIGURE_BYTES / float(size))))
            if kept:
                saved.append(name)
            else:
                os.remove(path)
                _note("Figure %d was left out: it is too large to keep, even at a low resolution." % position)
        except BaseException as error:
            try:
                os.remove(path)
            except BaseException:
                pass
            _note("Figure %d could not be saved (%s)." % (position, type(error).__name__))
    extra = len(numbers) - MAX_FIGURES
    if extra == 1:
        _note("1 more figure was left out: a Run keeps the first three.")
    elif extra > 1:
        _note("%d more figures were left out: a Run keeps the first three." % extra)
    return saved


def _is_standard(name, module):
    names = getattr(sys, "stdlib_module_names", None)  # Python 3.10 and newer
    if names is not None:
        return name in names
    if name in sys.builtin_module_names:
        return True
    import os
    import sysconfig

    path = getattr(module, "__file__", None)
    if not path:
        return False
    stdlib = os.path.realpath(sysconfig.get_paths()["stdlib"])
    path = os.path.realpath(path)
    return path.startswith(stdlib + os.sep) and "site-packages" not in path and "dist-packages" not in path


def _packages(source):
    """[name, version] of the top-level packages the code imports, in the order it names
    them, for those that were really imported and say which version they are."""
    import ast
    import warnings

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        tree = ast.parse(source)
    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                found.append((node.lineno, node.col_offset, alias.name.split(".")[0]))
        elif isinstance(node, ast.ImportFrom) and not node.level and node.module:
            found.append((node.lineno, node.col_offset, node.module.split(".")[0]))
    found.sort()

    try:
        from importlib import metadata
    except ImportError:
        metadata = None
    packages = []
    seen = set()
    for _, _, name in found:
        if len(packages) >= MAX_PACKAGES:
            break
        if name in seen:
            continue
        seen.add(name)
        module = sys.modules.get(name)
        if module is None or len(name) > 60:
            continue
        try:
            if _is_standard(name, module):
                continue
            version = None
            if metadata is not None:
                try:
                    version = metadata.version(name)
                except Exception:
                    version = None
            if not isinstance(version, str):
                version = getattr(module, "__version__", None)
            if isinstance(version, str):
                version = version.strip()
                if 0 < len(version) <= 40:
                    packages.append([name, version])
        except Exception:
            continue
    return packages


def _write_env(run_dir, source, figures):
    import json
    import os

    info = {"python": "%d.%d.%d" % sys.version_info[:3], "packages": [], "figures": figures}
    if source is not None:
        try:
            info["packages"] = _packages(source)
        except BaseException:
            pass
    temporary = os.path.join(run_dir, ENV_FILE + ".tmp")
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(info, handle)
    os.replace(temporary, os.path.join(run_dir, ENV_FILE))


def _main():
    import os

    main_path = sys.argv[1]
    run_dir = os.environ.get("QOOP_RUN_DIR") or os.path.dirname(os.path.abspath(main_path))
    try:
        import warnings

        # Runs have no screen to show a figure on; open figures are saved at the end instead.
        warnings.filterwarnings("ignore", message=".*non-interactive, and thus cannot be shown")
    except BaseException:
        pass

    flush_said = None
    try:
        sys.modules["qoop"], flush_said = _make_qoop(run_dir)
    except BaseException:
        sys.modules.pop("qoop", None)

    source = None
    code = 1
    try:
        source, code = _run(main_path)
    except BaseException as error:  # this file's own failure, not the program's
        _note("The code could not be started (%s)." % type(error).__name__)
    _flush()
    if flush_said is not None:
        flush_said()

    figures = []
    try:
        figures = _save_figures(run_dir)
    except BaseException as error:
        _note("The figures could not be saved (%s)." % type(error).__name__)
    try:
        _write_env(run_dir, source, figures)
    except BaseException:
        pass
    _flush()
    return code


if __name__ == "__main__":
    _status = _main()
    sys.exit(_status)
