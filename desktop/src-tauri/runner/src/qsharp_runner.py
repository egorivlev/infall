# Infall Runner: executes one Q# Run through the qdk package of the chosen Python
# (docs/specs/desktop.md, "Q#"; how the package behaves: docs/specs/qsharp-check.md).
#
# Started by the Infall desktop app as
#     <python> -u -X utf8 qsharp_runner.py <main.qs>
# with INFALL_RUN_DIR set to the Run's temporary directory. Standard library and the qdk
# package (or, from before qdk, the qsharp package) only.
#
# The whole text is evaluated with one qsharp.eval. Message and DumpMachine output goes to
# standard output as it happens; the value of a final expression is printed as Q# writes a
# value in an interpolated string. Then the entry point (the callable marked @EntryPoint(),
# else the one named Main, in any namespace) is evaluated, unless the text calls it itself.
# Errors print the compiler's own text and nothing of Python's. Exit code 0 when the code
# ran, 1 when it did not compile, failed, or Q# is not installed. At exit, infall-env.json:
# the Python version and the distribution that ran the code, with its version.

import os
import sys

# Read by qdk when it is imported: without it, every Run would send a usage report to
# Microsoft at exit and wait up to 3 s for it. The app sets it too; set again here so that
# nothing in the environment can turn it back on.
os.environ["QDK_PYTHON_TELEMETRY"] = "none"
os.environ["QSHARP_PYTHON_TELEMETRY"] = "none"

ENV_FILE = "infall-env.json"
NOT_INSTALLED = (
    "Q# is not installed for this Python. Install it with: pip install qdk "
    "(it needs Python 3.10 or newer)."
)


def _flush():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.flush()
        except BaseException:
            pass


def _load():
    """(qsharp module, code module, distribution name), or None when neither is there.
    Never `import qsharp` beside a qdk: the shim then warns at every Run."""
    try:
        import qdk
        from qdk import qsharp

        return qsharp, qdk.code, "qdk"
    except ImportError:
        pass
    try:
        import qsharp  # 1.28 and earlier: the package itself, from before qdk

        return qsharp, qsharp.code, "qsharp"
    except ImportError:
        return None


def show(value, qsharp=None):
    """A value as Q# writes it in an interpolated string: true, One, [Zero, One],
    (1, true, s), PauliX, 1..3."""
    if value is None:
        return "()"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, tuple):
        return "(" + ", ".join(show(v, qsharp) for v in value) + ")"
    if isinstance(value, list):
        return "[" + ", ".join(show(v, qsharp) for v in value) + "]"
    pauli = getattr(qsharp, "Pauli", None)
    if pauli is not None and isinstance(value, pauli):
        return str(value).replace("Pauli.", "Pauli")  # str() gives "Pauli.X"
    text = str(value)
    if text.startswith("<Range> "):
        return text[len("<Range> "):]
    return text


def callables(code):
    """Qualified names of every callable the code declared, from what eval registered."""
    import types

    found = []
    prefix_name = code.__name__ + "."

    def walk(module, prefix, depth):
        if depth > 32:
            return
        for name, value in list(vars(module).items()):
            if hasattr(value, "__global_callable"):
                found.append(prefix + name)
            elif isinstance(value, types.ModuleType) and value.__name__.startswith(prefix_name):
                walk(value, prefix + name + ".", depth + 1)

    walk(code, "", 0)
    return found


def _strip(source):
    """The text without comments and string contents, for finding names in it."""
    import re

    out = []
    i, n = 0, len(source)
    string = re.compile(r'"(?:\\.|[^"\\])*"')
    while i < n:
        if source.startswith("//", i):
            end = source.find("\n", i)
            i = n if end < 0 else end
            continue
        if source[i] == '"':
            match = string.match(source, i)
            if match:
                out.append('""')
                i = match.end()
                continue
        out.append(source[i])
        i += 1
    return "".join(out)


def entry_point(text, names):
    """The compiler's own rule: the @EntryPoint() callable, else the one named Main.
    (Parameters and duplicates are already compile errors.)"""
    import re

    marked = re.search(
        r"@EntryPoint\s*\(\s*\)\s*(?:internal\s+)?(?:operation|function)\s+(\w+)", text
    )
    short = marked.group(1) if marked else "Main"
    matches = [n for n in names if n.split(".")[-1] == short]
    return matches[0] if len(matches) == 1 else None


def called_in_text(text, short):
    """True when the code itself calls it: a use of the name other than its declaration."""
    import re

    uses = len(re.findall(r"\b%s\s*\(" % re.escape(short), text))
    declarations = len(
        re.findall(r"(?:operation|function)\s+%s\b\s*\(" % re.escape(short), text)
    )
    return uses > declarations


def write_env(dist):
    """infall-env.json, as runner.py writes it: the Python, and the distribution that ran the
    code with its version as installed now."""
    try:
        import json

        info = {"python": "%d.%d.%d" % sys.version_info[:3], "packages": [], "figures": []}
        if dist is not None:
            try:
                import importlib.metadata

                info["packages"] = [[dist, importlib.metadata.version(dist)]]
            except Exception:
                pass
        run_dir = os.environ.get("INFALL_RUN_DIR") or os.path.dirname(os.path.abspath(sys.argv[1]))
        temporary = os.path.join(run_dir, ENV_FILE + ".tmp")
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump(info, handle)
        os.replace(temporary, os.path.join(run_dir, ENV_FILE))
    except BaseException:
        pass


def main():
    with open(sys.argv[1], "rb") as handle:
        source = handle.read().decode("utf-8")
    loaded = _load()
    if loaded is None:
        print(NOT_INSTALLED)
        write_env(None)
        return 1
    qsharp, code, dist = loaded
    error_type = getattr(qsharp, "QSharpError", None) or Exception
    status = 0
    try:
        value = qsharp.eval(source)
        if value is not None:
            print(show(value, qsharp))
        text = _strip(source)
        entry = entry_point(text, callables(code))
        if entry and not called_in_text(text, entry.split(".")[-1]):
            value = qsharp.eval(entry + "()")
            if value is not None:
                print(show(value, qsharp))
    except error_type as error:
        print(str(error).rstrip())
        status = 1
    except Exception as error:
        print("%s: %s" % (type(error).__name__, error))
        status = 1
    _flush()
    write_env(dist)
    return status


if __name__ == "__main__":
    sys.exit(main())
