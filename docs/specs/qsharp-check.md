# Q# check — scripts and what they printed

The pre-build check of M19b ([desktop.md, "Languages — Runs in more than Python"](desktop.md), its Q# part and "Checked on…"). Run on 24 November 2026 on macOS 26.5.2 arm64 (Apple silicon), Python 3.12.13, with `qsharp` 1.31.0 / `qdk` 1.34.0 / `pyqir` 0.12.8 from PyPI, and a second environment with `qsharp` 1.28.0 (the last release before the shim). Everything here is what ran. Nothing in it was run on Windows or Linux.

## How to repeat it

Every script is below in full. Put them in one folder (`scripts/`), next to empty folders `work/`, `work2/`, `rundir/`, `fakehome/`, `faketmp/`, `out/`, all under a scratch folder `$Q`. Never install into the system Python.

```sh
python3 -m venv $Q/venv && $Q/venv/bin/python -m pip install qsharp
python3 -m venv $Q/venv128 && $Q/venv128/bin/python -m pip install "qsharp==1.28.0"
python3 -m venv $Q/venv_empty
python3 -I $Q/scripts/make_samples.py $Q/samples
cd $Q/work && python3 -I $Q/scripts/harness.py $Q/venv/bin/python $Q/work $Q/scripts/e1_eval.py
# …each experiment as written above its output below
```

`harness.py` starts a program the way the Runner does (`exec.rs`): `<python> -u -X utf8 <script> <file>`, standard input from `/dev/null`, its own process group, an environment given in full with `PYTHONUNBUFFERED`, `PYTHONIOENCODING`, `QOOP_RUN_DIR` (the working directory here). It prints each line with the time since start and the stream it came on (`out`, `err`, or `out+err` with `MERGED=1`: one pipe for both streams, exactly as the Runner reads it). Lines a stream delivered in pieces show `⏎` at the break. It sets `QDK_PYTHON_TELEMETRY=none` unless `TELEMETRY=on`.

Paths of the scratch folder are shortened to `$Q` in the outputs. Runs of `e2`–`e5` and the samples are shown without the timestamps, where they add nothing.

**A slip during the check.** The first run of `e9_timing.py` built its own environment without `QDK_PYTHON_TELEMETRY=none`, so its seven bare `import qdk.qsharp` processes probably posted `qdk`'s default usage report (counts, OS kernel version, locale) to Microsoft's endpoint. Those timings (1.2–1.5 s, the exit waiting on the report) were discarded. The script below is the corrected one, and its output is from the corrected run.

## The harness

`harness.py`:

```python
"""Starts `<python> -u -X utf8 <script> [args]` the way the Runner does (stdin from
/dev/null, its own process group, environment given explicitly, the Python-only
variables of a Run set) and prints every chunk of output with the stream it came on
and the time since start. Then the exit code and the total time.

    harness.py <python> <cwd> <script> [args...]

Environment knobs: TELEMETRY=on leaves qdk telemetry as it is by default; anything
else sets QDK_PYTHON_TELEMETRY=none. MERGED=1 sends stdout and stderr to one pipe
(exactly the Runner), else they are two pipes so the stream can be told apart.
"""
import os
import selectors
import subprocess
import sys
import time

python, cwd, script, *args = sys.argv[1:]
env = {k: os.environ[k] for k in ("PATH", "HOME", "USER", "LANG", "TMPDIR") if k in os.environ}
env.update(MPLBACKEND="Agg", PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8", QOOP_RUN_DIR=cwd)
# QS_HOME / QS_TMP: run the program with that HOME / TMPDIR (empty folders, to see what it writes there).
if os.environ.get("QS_HOME"):
    env["HOME"] = os.environ["QS_HOME"]
if os.environ.get("QS_TMP"):
    env["TMPDIR"] = os.environ["QS_TMP"]
for k in ("QSHARP_PYTHON_AI_URL",):
    if k in os.environ:
        env[k] = os.environ[k]
if os.environ.get("TELEMETRY") != "on":
    env["QDK_PYTHON_TELEMETRY"] = "none"
merged = os.environ.get("MERGED") == "1"

t0 = time.monotonic()
p = subprocess.Popen(
    [python, "-u", "-X", "utf8", script, *args],
    cwd=cwd, env=env, stdin=subprocess.DEVNULL,
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT if merged else subprocess.PIPE,
    process_group=0,
)
sel = selectors.DefaultSelector()
sel.register(p.stdout, selectors.EVENT_READ, "out" if not merged else "out+err")
if not merged:
    sel.register(p.stderr, selectors.EVENT_READ, "err")
open_streams = len(sel.get_map())
while open_streams:
    for key, _ in sel.select():
        data = os.read(key.fileobj.fileno(), 65536)
        if not data:
            sel.unregister(key.fileobj)
            open_streams -= 1
            continue
        for line in data.decode("utf-8", "replace").splitlines(keepends=True):
            print(f"[{time.monotonic() - t0:6.3f}s {key.data:>7}] {line}", end="" if line.endswith("\n") else "⏎\n")
code = p.wait()
print(f"[{time.monotonic() - t0:6.3f}s    exit] {code}")
```


## 1. The package, and what PyPI has for it

`pip install qsharp` into the new environment:

```
Successfully installed pyqir-0.12.8 qdk-1.34.0 qsharp-1.31.0
```

`qsharp/__init__.py` of 1.31.0 says the package "has been replaced by `qdk`" and is "a thin compatibility shim that re-exports the `qdk` public API". On import it issues a `DeprecationWarning` and `from qdk.qsharp import …`. Its metadata: `Requires-Dist: qdk>=1.31.0`, `Requires-Python: >=3.10`. It also installs a top-level `tests` package (`tests/test_qsharp_shim.py`).

`pypi_files.py`:

```python
"""Lists the files PyPI has for the qsharp shim and what it pulls in."""
import json
import urllib.request


def get(path):
    with urllib.request.urlopen(f"https://pypi.org/pypi/{path}/json", timeout=30) as r:
        return json.load(r)


for path in ["qsharp/1.31.0", "qdk/1.34.0", "pyqir/0.12.8"]:
    d = get(path)
    print("==", path, "requires_python:", d["info"]["requires_python"])
    for u in d["urls"]:
        print("  ", u["filename"], u["size"], u["upload_time"][:10])


def key(v):
    return [int(x) if x.isdecimal() else -1 for x in v.split(".")]


for name in ["qsharp", "qdk"]:
    d = get(name)
    r = d["releases"]
    ks = sorted(r, key=key)
    print(name, "latest:", d["info"]["version"])
    for k in ks[-6:]:
        print("  ", k, r[k][0]["upload_time"][:10] if r[k] else None,
              "files:", len(r[k]))
```

Output (`pypi_files.out`):

```
== qsharp/1.31.0 requires_python: >=3.10
   qsharp-1.31.0-py3-none-any.whl 15918 2026-07-31
== qdk/1.34.0 requires_python: >=3.10
   qdk-1.34.0-cp310-abi3-macosx_10_12_x86_64.whl 7636001 2026-11-10
   qdk-1.34.0-cp310-abi3-macosx_11_0_arm64.whl 7203783 2026-11-10
   qdk-1.34.0-cp310-abi3-manylinux_2_28_aarch64.whl 7903799 2026-11-10
   qdk-1.34.0-cp310-abi3-manylinux_2_28_x86_64.whl 8588267 2026-11-10
   qdk-1.34.0-cp310-abi3-win_amd64.whl 9107492 2026-11-10
   qdk-1.34.0-cp310-abi3-win_arm64.whl 8562118 2026-11-10
== pyqir/0.12.8 requires_python: >=3.9
   pyqir-0.12.8-cp315-abi3.abi3t-manylinux_2_28_aarch64.whl 2182163 2026-10-30
   pyqir-0.12.8-cp315-abi3.abi3t-manylinux_2_28_x86_64.whl 2176235 2026-10-30
   pyqir-0.12.8-cp39-abi3-macosx_10_12_x86_64.whl 2157533 2026-10-30
   pyqir-0.12.8-cp39-abi3-macosx_11_0_arm64.whl 2109186 2026-10-30
   pyqir-0.12.8-cp39-abi3-manylinux_2_28_aarch64.whl 2118306 2026-10-30
   pyqir-0.12.8-cp39-abi3-manylinux_2_28_x86_64.whl 2084968 2026-10-30
   pyqir-0.12.8-cp39-abi3-win_amd64.whl 1970377 2026-10-30
   pyqir-0.12.8-cp39-abi3-win_arm64.whl 1869302 2026-10-30
qsharp latest: 1.31.0
   1.29.7.dev0 2026-07-08 files: 1
   1.30.0 2026-07-09 files: 1
   1.30.2.dev0 2026-07-21 files: 1
   1.30.3.dev0 2026-07-24 files: 1
   1.30.4.dev0 2026-07-29 files: 1
   1.31.0 2026-07-31 files: 1
qdk latest: 1.34.0
   1.33.0 2026-10-06 files: 6
   1.33.1 2026-10-08 files: 6
   1.33.2.dev0 2026-10-27 files: 6
   1.33.3.dev0 2026-11-06 files: 6
   1.33.4.dev0 2026-11-07 files: 6
   1.34.0 2026-11-10 files: 6
```


Releases of `qsharp` with platform wheels end at 1.28.0 (29 April 2026). From 1.29.1 (23 May 2026) each release is one `py3-none-any` wheel, the shim.

## 2. `eval`: output, values, timing — through the `qsharp` shim

`e1_eval.py`:

```python
"""What qsharp.eval does with Message output and what it returns, outside a notebook."""
import sys
import time

t = time.monotonic()
import qsharp
print(f"PY import qsharp took {time.monotonic() - t:.3f}s", flush=True)

def show(label, src):
    t = time.monotonic()
    v = qsharp.eval(src)
    print(f"PY {label}: returned {v!r} (type {type(v).__name__}) str={str(v)!r} in {time.monotonic() - t:.3f}s", flush=True)
    return v

# Message before and after a slow stretch: is it written as it happens?
show("message+slow", '''
Message("first message");
mutable x = 0;
for i in 0..3000000 { set x += i % 7; }
Message($"second message, x = {x}");
x
''')
show("unit", 'Message("only a message");')
show("int", '1 + 2')
show("double", '1.5 * 2.0')
show("bool", 'true')
show("string", '"hello"')
show("result", 'use q = Qubit(); X(q); let r = M(q); Reset(q); r')
show("result zero", 'use q = Qubit(); M(q)')
show("result array", 'use qs = Qubit[3]; X(qs[1]); let rs = MeasureEachZ(qs); ResetAll(qs); rs')
show("tuple", '(1, true, One, "s", 2.5)')
show("int array", '[1, 2, 3]')
show("pauli", 'PauliX')
show("range", '1..3')
show("bigint", '2L ^ 70')
show("empty array", 'let a : Int[] = []; a')
show("declaration only", 'function F() : Int { 4 }')
show("call declared", 'F()')
show("dump", 'use q = Qubit(); H(q); Microsoft.Quantum.Diagnostics.DumpMachine(); Reset(q);')
print("PY done", flush=True)
```

Output (`e1.txt`):

```
[ 0.026s     err] $Q/scripts/e1_eval.py:6: DeprecationWarning: The 'qsharp' package is deprecated and will be removed in a future release. Please use the 'qdk' package instead. See https://github.com/microsoft/qdk/wiki/Migrating-from-qsharp-to-qdk for migration guidance.
[ 0.026s     err]   import qsharp
[ 1.053s     out] PY import qsharp took 1.035s
[ 1.126s     out] first message
[ 1.936s     out] second message, x = 8999997
[ 1.936s     out] PY message+slow: returned 8999997 (type int) str='8999997' in 0.883s
[ 1.936s     out] only a message
[ 1.936s     out] PY unit: returned None (type NoneType) str='None' in 0.000s
[ 1.937s     out] PY int: returned 3 (type int) str='3' in 0.000s
[ 1.937s     out] PY double: returned 3.0 (type float) str='3.0' in 0.000s
[ 1.937s     out] PY bool: returned True (type bool) str='True' in 0.000s
[ 1.937s     out] PY string: returned 'hello' (type str) str='hello' in 0.000s
[ 1.937s     out] PY result: returned One (type Result) str='One' in 0.000s
[ 1.937s     out] PY result zero: returned Zero (type Result) str='Zero' in 0.000s
[ 1.937s     out] PY result array: returned [Zero, One, Zero] (type list) str='[Zero, One, Zero]' in 0.000s
[ 1.937s     out] PY tuple: returned (1, True, One, 's', 2.5) (type tuple) str="(1, True, One, 's', 2.5)" in 0.000s
[ 1.937s     out] PY int array: returned [1, 2, 3] (type list) str='[1, 2, 3]' in 0.000s
[ 1.937s     out] PY pauli: returned Pauli.X (type Pauli) str='Pauli.X' in 0.000s
[ 1.937s     out] PY range: returned '<Range> 1..3' (type str) str='<Range> 1..3' in 0.000s
[ 1.937s     out] PY bigint: returned 1180591620717411303424 (type int) str='1180591620717411303424' in 0.000s
[ 1.937s     out] PY empty array: returned [] (type list) str='[]' in 0.000s
[ 1.938s     out] PY declaration only: returned None (type NoneType) str='None' in 0.000s
[ 1.938s     out] PY call declared: returned 4 (type int) str='4' in 0.000s
[ 1.938s     out] STATE:
[ 1.938s     out] |000000⟩: 0.7071+0.0000𝑖
[ 1.938s     out] |000001⟩: 0.7071+0.0000𝑖
[ 1.938s     out] PY dump: returned None (type NoneType) str='None' in 0.000s
[ 1.938s     out] PY done
[ 1.960s    exit] 0
```


Seen: the shim's `DeprecationWarning` on standard error. `Message` on standard output as it happens: "first message" at 1.126 s, the second 0.8 s later, after the loop. The value of a final expression is returned and not printed. `Unit` is `None`, `Result` prints `One`/`Zero`, a Range comes back as the string `<Range> 1..3`, Pauli as `Pauli.X`. The import took 1.0 s on this first start after installing. Outside Jupyter, `qdk` writes every output with `print(output, flush=True)` (`qdk/_context.py`, `_display`).

## 3. `run`, and errors

`e2_run_errors.py`:

```python
"""qsharp.run for many shots, and how each kind of error surfaces."""
import time
import traceback

import qdk
from qdk import qsharp  # the non-deprecated import: no DeprecationWarning

qsharp.eval('''
operation Bell() : (Result, Result) {
    use (a, b) = (Qubit(), Qubit());
    H(a); CNOT(a, b);
    Message("shot");
    let r = (M(a), M(b));
    ResetAll([a, b]);
    r
}
operation Fails() : Unit { fail "deliberate failure"; }
''')

t = time.monotonic()
res = qsharp.run("Bell()", shots=4)
print(f"PY run 4 shots -> {res!r} in {time.monotonic() - t:.3f}s", flush=True)
t = time.monotonic()
res = qsharp.run("Bell()", shots=1000, save_events=True)
print(f"PY run 1000 shots save_events -> {len(res)} items, first {res[0]!r} in {time.monotonic() - t:.3f}s", flush=True)
res = qsharp.run(qdk.code.Bell, 2)
print(f"PY run via qdk.code.Bell -> {res!r}", flush=True)
try:
    res = qsharp.run("Fails()", shots=2)
    print(f"PY run of a failing op -> {res!r} types {[type(r).__name__ for r in res]}", flush=True)
except BaseException as e:
    print(f"PY run of a failing op RAISED {type(e).__name__}: {str(e).splitlines()[0]}", flush=True)


def attempt(label, src):
    try:
        v = qsharp.eval(src)
        print(f"PY {label}: no error, returned {v!r}", flush=True)
    except BaseException as e:
        print(f"PY {label}: {type(e).__module__}.{type(e).__name__}"
              f" (Exception subclass: {isinstance(e, Exception)})", flush=True)
        print("---- str(e) ----", flush=True)
        print(str(e), flush=True)
        print("----", flush=True)


attempt("syntax error", 'let x = ;')
attempt("type error", 'let x : Int = "a";')
attempt("unknown name", 'Foo()')
attempt("two errors", 'let a : Int = "x";\nlet b = Bar();')
attempt("runtime fail", 'Message("before"); fail "boom";')
attempt("runtime div by zero", 'let z = 0; 1 / z')
attempt("index out of range", 'let a = [1]; a[5]')
attempt("qubit not released in zero", 'use q = Qubit(); X(q);')
attempt("after errors still usable", '40 + 2')

print("PY now an uncaught error, as a plain script would end:", flush=True)
qsharp.eval('fail "uncaught";')
print("PY not reached", flush=True)
```

Output (`e2.txt`):

```
shot
shot
shot
shot
PY run 4 shots -> [(One, One), (Zero, Zero), (One, One), (One, One)] in 0.002s
PY run 1000 shots save_events -> 1000 items, first {'result': (Zero, Zero), 'events': [shot], 'messages': ['shot'], 'matrices': [], 'dumps': []} in 0.010s
shot
shot
PY run via qdk.code.Bell -> [(Zero, Zero), (One, One)]
PY run of a failing op RAISED QSharpError: Error: program failed: deliberate failure
PY syntax error: module.QSharpError (Exception subclass: True)
---- str(e) ----
Qdk.Qsc.Parse.Rule

  x syntax error
  `-> expected expression, found `;`
   ,-[line_1:1:9]
 1 | let x = ;
   :         ^
   `----

----
PY type error: module.QSharpError (Exception subclass: True)
---- str(e) ----
Qdk.Qsc.TypeCk.TyMismatch

  x type error
  `-> expected Int, found String
   ,-[line_2:1:15]
 1 | let x : Int = "a";
   :               ^^^
   `----

----
PY unknown name: module.QSharpError (Exception subclass: True)
---- str(e) ----
Qdk.Qsc.Resolve.NotFound

  x name error
  `-> `Foo` not found
   ,-[line_3:1:1]
 1 | Foo()
   : ^^^
   `----

----
PY two errors: module.QSharpError (Exception subclass: True)
---- str(e) ----
Qdk.Qsc.Resolve.NotFound

  x name error
  `-> `Bar` not found
   ,-[line_4:2:9]
 1 | let a : Int = "x";
 2 | let b = Bar();
   :         ^^^
   `----

Qdk.Qsc.TypeCk.TyMismatch

  x type error
  `-> expected Int, found String
   ,-[line_4:1:15]
 1 | let a : Int = "x";
   :               ^^^
 2 | let b = Bar();
   `----

Qdk.Qsc.TypeCk.AmbiguousTy

  x type error
  `-> insufficient type information to infer type
   ,-[line_4:2:5]
 1 | let a : Int = "x";
 2 | let b = Bar();
   :     ^
   `----
  help: provide a type annotation

----
before
PY runtime fail: module.QSharpError (Exception subclass: True)
---- str(e) ----
Qdk.Qsc.Eval.UserFail

  x runtime error
  `-> program failed: boom
   ,-[line_5:1:20]
 1 | Message("before"); fail "boom";
   :                    ^^^^^|^^^^^
   :                         `-- explicit fail
   `----

----
PY runtime div by zero: module.QSharpError (Exception subclass: True)
---- str(e) ----
Qdk.Qsc.Eval.DivZero

  x runtime error
  `-> division by zero
   ,-[line_6:1:16]
 1 | let z = 0; 1 / z
   :                |
   :                `-- cannot divide by zero
   `----

----
PY index out of range: module.QSharpError (Exception subclass: True)
---- str(e) ----
Qdk.Qsc.Eval.IndexOutOfRange

  x runtime error
  `-> index out of range: 5
   ,-[line_7:1:16]
 1 | let a = [1]; a[5]
   :                |
   :                `-- out of range
   `----

----
PY qubit not released in zero: no error, returned None
PY after errors still usable: no error, returned 42
PY now an uncaught error, as a plain script would end:
Traceback (most recent call last):
  File "$Q/scripts/e2_run_errors.py", line 58, in <module>
    qsharp.eval('fail "uncaught";')
  File "$Q/venv/lib/python3.12/site-packages/qdk/_interpreter.py", line 224, in eval
    return _get_default_context().eval(source, save_events=save_events)
      ⏎
     ^^^^^^^^^^^⏎
^^⏎
^^^^^^^⏎
^^^^^^⏎
^^^^^^⏎
^^^^^^⏎
^^^^^^⏎
^^^^^^⏎
^^^^^^⏎
^^^^
  File "$Q/venv/lib/python3.12/site-packages/qdk/_context.py", line 621, in eval
    output = self._interpreter.interpret(
          ⏎
   ^^^^^^^^^^⏎
^^^^^^⏎
^^^^^^⏎
^^^^^^
module⏎
.QSharpError: Qdk.Qsc.Eval.UserFail

  x runtime error
  `-> program failed: uncaught
   ,-[line_10:1:1]
 1 | fail "uncaught";
   : ^^^^^^^|^^^^^^^
   :        `-- explicit fail
   `----

1
```


Seen: `qsharp.run("Bell()", shots=4)` returns a list of 4 results, and each shot's `Message` is printed. With `save_events=True` it returns one dict per shot. A callable from `qdk.code` works too (there is no `qdk.qsharp.code`). A failing shot **raises** `QSharpError`, although the docstring says the list holds "results or runtime errors". Compile errors (syntax, type, name; several at once) and runtime failures (fail, division by zero, index) raise `QSharpError`. It is an `Exception` subclass at run time (`_native.pyi` declares `BaseException`). The interpreter stays usable after an error. Uncaught, it gives a Python traceback on standard error and exit code 1. Positions are `line_<n>`, counting `eval` calls.

## 4. Entry points

`e3_entry.py`:

```python
"""How an entry point is found. For each sample source:
  A. qsharp.eval(source): what it returns, and what it registered in qdk.code;
  B. project mode: the source as src/main.qs beside a qsharp.json, init(project_root=...),
     then the native interpreter's run with no entry expression (the compiler's own entry point).
"""
import json
import os
import sys
import tempfile
import types

import qdk
from qdk import qsharp

SAMPLES = {
    "statements only": 'Message("hi"); 1 + 1',
    "Main, no namespace": 'operation Main() : Result { use q = Qubit(); H(q); MResetZ(q) }',
    "Main in a namespace": 'namespace Demo { operation Main() : Int { Message("in Demo.Main"); 7 } }',
    "@EntryPoint not named Main": 'namespace Demo { @EntryPoint() operation Go() : Int { Message("in Go"); 8 } }',
    "@EntryPoint and a Main": 'namespace Demo { @EntryPoint() operation Go() : Int { 8 } operation Main() : Int { 9 } }',
    "Main + helper": '''
        function Square(x : Int) : Int { x * x }
        operation Main() : (Int, Result[]) {
            use qs = Qubit[2];
            Message($"square {Square(3)}");
            (Square(3), MResetEachZ(qs))
        }''',
    "Main and a statement calling it": 'operation Main() : Int { Message("Main ran"); 5 }\nMain()',
    "no entry point": 'operation Foo() : Unit { Message("foo"); }',
    "Main takes arguments": 'operation Main(n : Int) : Int { n }',
    "function Main": 'function Main() : String { "from function Main" }',
    "two namespaces with Main": 'namespace A { operation Main() : Int { 1 } } namespace B { operation Main() : Int { 2 } }',
    "syntax error": 'operation Main() : Int { let x = ; x }',
}


def registered():
    found = []

    def walk(mod, prefix):
        for k, v in sorted(vars(mod).items()):
            if hasattr(v, "__global_callable"):
                found.append(prefix + k)
            elif isinstance(v, types.ModuleType) and v.__name__.startswith("qdk.code."):
                walk(v, prefix + k + ".")

    walk(qdk.code, "")
    return found


def short(e):
    lines = [l for l in str(e).splitlines() if l.strip()]
    return " | ".join(lines[:3])


def try_eval(src):
    qsharp.init()
    try:
        v = qsharp.eval(src)
        print(f"  A eval -> {v!r}; registered: {registered()}")
    except Exception as e:
        print(f"  A eval raised {type(e).__name__}: {short(e)}")


def try_project(src):
    with tempfile.TemporaryDirectory(dir=os.getcwd()) as d:
        os.mkdir(os.path.join(d, "src"))
        with open(os.path.join(d, "qsharp.json"), "w") as f:
            json.dump({}, f)
        with open(os.path.join(d, "src", "main.qs"), "w") as f:
            f.write(src)
        try:
            qsharp.init(project_root=d)
        except Exception as e:
            print(f"  B init(project_root) raised {type(e).__name__}: {short(e)}")
            return
        print(f"  B registered after init: {registered()}")
        interp = qdk._interpreter.get_interpreter()
        try:
            v = interp.run(None, lambda o: print(f"    output: {o}"), None, None, None, None, None, None, None, None)
            print(f"  B run(no entry expr) -> {qdk._interpreter.qsharp_value_to_python_value(v)!r}")
        except Exception as e:
            print(f"  B run(no entry expr) raised {type(e).__name__}: {short(e)}")
        try:
            prog = qsharp.compile  # noqa: just to show the name exists
            del prog
        except Exception:
            pass


for name, src in SAMPLES.items():
    print(f"== {name}", flush=True)
    try_eval(src)
    try_project(src)
    sys.stdout.flush()
```

Output (`e3.txt`):

```
== statements only
hi
  A eval -> 2; registered: []
  B init(project_root) raised QSharpError: Qdk.Qsc.Parse.Token |   x syntax error |   `-> expected EOF, found identifier
== Main, no namespace
  A eval -> None; registered: ['Main']
  B registered after init: ['main.Main']
  B run(no entry expr) raised QSharpError: Qdk.Qsc.Interpret.NoEntryPoint |   x entry point not found
== Main in a namespace
  A eval -> None; registered: ['Demo.Main']
  B registered after init: ['Demo.Main']
  B run(no entry expr) raised QSharpError: Qdk.Qsc.Interpret.NoEntryPoint |   x entry point not found
== @EntryPoint not named Main
  A eval -> None; registered: ['Demo.Go']
  B registered after init: ['Demo.Go']
  B run(no entry expr) raised QSharpError: Qdk.Qsc.Interpret.NoEntryPoint |   x entry point not found
== @EntryPoint and a Main
  A eval -> None; registered: ['Demo.Go', 'Demo.Main']
  B registered after init: ['Demo.Go', 'Demo.Main']
  B run(no entry expr) raised QSharpError: Qdk.Qsc.Interpret.NoEntryPoint |   x entry point not found
== Main + helper
  A eval -> None; registered: ['Main', 'Square']
  B registered after init: ['main.Main', 'main.Square']
  B run(no entry expr) raised QSharpError: Qdk.Qsc.Interpret.NoEntryPoint |   x entry point not found
== Main and a statement calling it
Main ran
  A eval -> 5; registered: ['Main']
  B init(project_root) raised QSharpError: Qdk.Qsc.Parse.Token |   x syntax error |   `-> expected EOF, found identifier
== no entry point
  A eval -> None; registered: ['Foo']
  B registered after init: ['main.Foo']
  B run(no entry expr) raised QSharpError: Qdk.Qsc.Interpret.NoEntryPoint |   x entry point not found
== Main takes arguments
  A eval raised QSharpError: Qdk.Qsc.EntryPoint.Args |   x entry point cannot have parameters |    ,-[line_0:1:16]
  B init(project_root) raised QSharpError: Qdk.Qsc.EntryPoint.Args |   x entry point cannot have parameters |    ,-[$Q/work/tmpos2g4cw2/src/main.qs:1:16]
== function Main
  A eval -> None; registered: ['Main']
  B registered after init: ['main.Main']
  B run(no entry expr) raised QSharpError: Qdk.Qsc.Interpret.NoEntryPoint |   x entry point not found
== two namespaces with Main
  A eval raised QSharpError: Qdk.Qsc.EntryPoint.Duplicate |   x duplicate entry point callable `Main` |    ,-[line_0:1:25]
  B init(project_root) raised QSharpError: Qdk.Qsc.EntryPoint.Duplicate |   x duplicate entry point callable `Main` |    ,-[$Q/work/tmpipyv5p_0/src/main.qs:1:25]
== syntax error
  A eval raised QSharpError: Qdk.Qsc.Parse.Rule |   x syntax error |   `-> expected expression, found `;`
  B init(project_root) raised QSharpError: Qdk.Qsc.Parse.Rule |   x syntax error |   `-> expected expression, found `;`
0
```


`e4_entry_more.py`:

```python
"""What the compiler accepts around entry points in eval, and how a found Main is called."""
import types

import qdk
from qdk import qsharp

SAMPLES = {
    "@EntryPoint with a parameter": 'operation Go(n : Int) : Int { n }\n@EntryPoint() operation Go2(n : Int) : Int { n }',
    "two @EntryPoint": '@EntryPoint() operation A() : Int { 1 }\n@EntryPoint() operation B() : Int { 2 }',
    "@EntryPoint and Main(n)": '@EntryPoint() operation Go() : Int { 8 }\noperation Main(n : Int) : Int { n }',
    "Main in two evals": None,  # handled below
    "main lower case": 'operation main() : Int { 3 }',
    "Main returning Unit": 'operation Main() : Unit { Message("unit main"); }',
    "Main with qubit left in One": 'operation Main() : Result { use q = Qubit(); X(q); M(q) }',
    "lambda named Main": 'let Main = () -> 4;',
    "statements then Main declared": 'Message("statement first");\noperation Main() : Int { 6 }',
}


def entry_names():
    found = []

    def walk(mod, prefix):
        for k, v in sorted(vars(mod).items()):
            if hasattr(v, "__global_callable"):
                found.append((prefix + k, v))
            elif isinstance(v, types.ModuleType) and v.__name__.startswith("qdk.code."):
                walk(v, prefix + k + ".")

    walk(qdk.code, "")
    return found


for name, src in SAMPLES.items():
    print(f"== {name}", flush=True)
    qsharp.init()
    if src is None:
        try:
            qsharp.eval('operation Main() : Int { 1 }')
            qsharp.eval('namespace X { operation Main() : Int { 2 } }')
            print("  two evals each with a Main: accepted; registered", [n for n, _ in entry_names()])
        except Exception as e:
            print("  raised", type(e).__name__, str(e).splitlines()[0])
        continue
    try:
        v = qsharp.eval(src)
        names = entry_names()
        print(f"  eval -> {v!r}; registered {[n for n, _ in names]}")
        for n, fn in names:
            if n.split(".")[-1] == "Main":
                print(f"  calling qdk.code.{n}() ->", flush=True)
                r = fn()
                print(f"    returned {r!r}")
                print(f"  qsharp.eval('{n}()') -> {qsharp.eval(n + '()')!r}")
    except Exception as e:
        print(f"  raised {type(e).__name__}: {' | '.join(l for l in str(e).splitlines()[:3] if l.strip())}")
```

Output (`e4.txt`):

```
== @EntryPoint with a parameter
  raised QSharpError: Qdk.Qsc.EntryPoint.Args |   x entry point cannot have parameters
== two @EntryPoint
  raised QSharpError: Qdk.Qsc.EntryPoint.Duplicate |   x duplicate entry point callable `A`
== @EntryPoint and Main(n)
  eval -> None; registered ['Go', 'Main']
  calling qdk.code.Main() ->
  raised QSharpError: expected arguments of type `Int`
== Main in two evals
  two evals each with a Main: accepted; registered ['Main', 'X.Main']
== main lower case
  eval -> None; registered ['main']
== Main returning Unit
  eval -> None; registered ['Main']
  calling qdk.code.Main() ->
unit main
    returned None
unit main
  qsharp.eval('Main()') -> None
== Main with qubit left in One
  eval -> None; registered ['Main']
  calling qdk.code.Main() ->
  raised QSharpError: Error: Qubit0 released while not in |0⟩ state | Call stack: |     at QIR.Runtime.__quantum__rt__qubit_release in qsharp-library-source:core/qir.qs:13:5
== lambda named Main
  eval -> None; registered []
== statements then Main declared
statement first
  eval -> None; registered ['Main']
  calling qdk.code.Main() ->
    returned 6
  qsharp.eval('Main()') -> 6
0
```


Seen: `eval` never calls an entry point. It registers every callable in `qdk.code`, with namespaces (`Demo.Main`). Top-level callables appear bare after `eval` and under the file name (`main.Main`) in project mode. The compiler applies the entry-point rules inside `eval`: a parameterised `Main` or `@EntryPoint()` callable is `Qdk.Qsc.EntryPoint.Args`, and two of them are `…Duplicate`. With an `@EntryPoint()` present, a `Main(n : Int)` is accepted as an ordinary callable, and the match is case-sensitive (`main` is not one). Project mode (`init(project_root=…)` with a `qsharp.json`) does not help. A file there may not have top-level statements (`expected EOF`), and the interpreter's `run` without an expression finds no entry point (`Qdk.Qsc.Interpret.NoEntryPoint`). No public function runs "the program" without an expression, and Python cannot see which callable has `@EntryPoint()`.

## 5. How Q# writes values, against Python's `str`

`e5_format.py`:

```python
"""Q#'s own formatting of a value ($"{v}") next to Python's str() of what eval returns."""
from qdk import qsharp

EXPRS = [
    '()', '3', '3.0', '1.5e-7', 'true', '"text"', 'One', '[Zero, One]', '(1, true, One, "s", 2.5)',
    '[1, 2, 3]', 'PauliX', '1..3', '2L ^ 70', '[[1], [2, 3]]', 'Microsoft.Quantum.Math.Complex(1.0, 2.0)',
]
for e in EXPRS:
    qsharp_text = qsharp.eval(f'$"{{{e}}}"')
    python_value = qsharp.eval(e)
    print(f"{e:45} Q#: {qsharp_text!s:32} Python str: {python_value!s}")
```

Output (`e5.txt`):

```
()                                            Q#: ()                               Python str: None
3                                             Q#: 3                                Python str: 3
3.0                                           Q#: 3.0                              Python str: 3.0
1.5e-7                                        Q#: 0.00000015                       Python str: 1.5e-07
true                                          Q#: true                             Python str: True
"text"                                        Q#: text                             Python str: text
One                                           Q#: One                              Python str: One
[Zero, One]                                   Q#: [Zero, One]                      Python str: [Zero, One]
(1, true, One, "s", 2.5)                      Q#: (1, true, One, s, 2.5)           Python str: (1, True, One, 's', 2.5)
[1, 2, 3]                                     Q#: [1, 2, 3]                        Python str: [1, 2, 3]
PauliX                                        Q#: PauliX                           Python str: Pauli.X
1..3                                          Q#: 1..3                             Python str: <Range> 1..3
2L ^ 70                                       Q#: 1180591620717411303424           Python str: 1180591620717411303424
[[1], [2, 3]]                                 Q#: [[1], [2, 3]]                    Python str: [[1], [2, 3]]
Traceback (most recent call last):
  File "$Q/scripts/e5_format.py", line 9, in <module>
    qsharp_text = qsharp.eval(f'$"{{{e}}}"')
      ⏎
            ^^^^^^⏎
^^^^^^^^⏎
^^^^^^^⏎
^^^^^
  File "$Q/venv/lib/python3.12/site-packages/qdk/_interpreter.py", line 224, in eval
    return _get_default_context().eval(source, save_events=save_events)
      ⏎
     ^^^^⏎
^^^^^^^^^⏎
^^^^^^^^^^^^^⏎
^^^^^^^⏎
^^^^^^⏎
^^^^^^^^^^^^⏎
^^^^^^⏎
^^^
  File "$Q/venv/lib/python3.12/site-packages/qdk/_context.py", line 621, in eval
    output = self._interpreter.interpret(
        ⏎
     ^⏎
^^^^^^⏎
^^^^^^^^⏎
^^^^^^^^^^^⏎
^^
module.QSharpError: ⏎
Qdk.Qsc.TypeCk.MissingClassShow

  x type error
  `-> type Complex cannot be converted into a string
   ,-[line_28:1:4]
 1 | $"{Microsoft.Quantum.Math.Complex(1.0, 2.0)}"
   :    ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
   `----

1
```


(The last line fails on purpose: Q# cannot interpolate a struct.)

## 6. The prototype `qsharp_runner.py`, and the samples

The prototype applies what was found above. It is the shape the bundled file can take, not the bundled file.

`qsharp_runner.py`:

```python
"""Prototype of the bundled qsharp_runner.py: python -u -X utf8 qsharp_runner.py <main.qs>

Standard library and the qdk package only. Exit 0 when the code ran, 1 when it did not
compile, failed, or Q# is not installed.
"""
import os
import re
import sys
import types

# Read by qdk when it is imported: without this, every Run would send a usage report
# to Microsoft at exit (and wait up to 3 s for it).
os.environ["QDK_PYTHON_TELEMETRY"] = "none"

try:
    import qdk  # 1.29 and later: the package; `qsharp` is a deprecated shim over it
    from qdk import qsharp
    code = qdk.code
except ImportError:
    try:
        import qsharp  # 1.28 and earlier: the package itself, no qdk
        code = qsharp.code
    except ImportError:
        print("Q# is not installed for this Python. Install it with: pip install qdk")
        sys.exit(1)


def show(v):
    """A value as Q# writes it in an interpolated string."""
    if v is None:
        return "()"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, tuple):
        return "(" + ", ".join(show(x) for x in v) + ")"
    if isinstance(v, list):
        return "[" + ", ".join(show(x) for x in v) + "]"
    if isinstance(v, qsharp.Pauli):
        return str(v).replace("Pauli.", "Pauli")  # str() gives "Pauli.X"
    if isinstance(v, str) and v.startswith("<Range> "):
        return v[len("<Range> "):]
    return str(v)


def callables():
    """Qualified names of every callable the code declared, from what eval registered."""
    found = []

    def walk(mod, prefix):
        for k, v in vars(mod).items():
            if hasattr(v, "__global_callable"):
                found.append(prefix + k)
            elif isinstance(v, types.ModuleType) and v.__name__.startswith(code.__name__ + "."):
                walk(v, prefix + k + ".")

    walk(code, "")
    return found


COMMENT = re.compile(r"//[^\n]*")
STRING = re.compile(r'"(?:\\.|[^"\\])*"')
DECL = r"(?:operation|function)\s+{name}\b"


def entry_point(text, names):
    """The compiler's own rule: the @EntryPoint() callable, else the one named Main.
    (Parameters and duplicates are already compile errors.)"""
    marked = re.search(r"@EntryPoint\s*\(\s*\)\s*(?:internal\s+)?(?:operation|function)\s+(\w+)", text)
    short = marked.group(1) if marked else "Main"
    matches = [n for n in names if n.split(".")[-1] == short]
    return matches[0] if len(matches) == 1 else None


def called_in_text(text, short):
    """True when the code itself calls it: a use of the name other than its declaration."""
    uses = len(re.findall(rf"\b{short}\s*\(", text))
    decls = len(re.findall(DECL.format(name=short) + r"\s*\(", text))
    return uses > decls


def write_env():
    """qoop-env.json, as runner.py writes it: the Python, and the distribution that ran the code
    with its version as installed now."""
    import importlib.metadata
    import json

    dist = "qdk" if code.__name__.startswith("qdk.") else "qsharp"
    info = {"python": "%d.%d.%d" % sys.version_info[:3], "packages": [], "figures": []}
    try:
        info["packages"] = [[dist, importlib.metadata.version(dist)]]
    except Exception:
        pass
    run_dir = os.environ.get("QOOP_RUN_DIR") or os.path.dirname(os.path.abspath(sys.argv[1]))
    tmp = os.path.join(run_dir, "qoop-env.json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(info, f)
    os.replace(tmp, os.path.join(run_dir, "qoop-env.json"))


import atexit

atexit.register(lambda: write_env())
source = open(sys.argv[1], encoding="utf-8").read()
text = STRING.sub('""', COMMENT.sub("", source))
try:
    value = qsharp.eval(source)
    if value is not None:
        print(show(value))
    entry = entry_point(text, callables())
    if entry and not called_in_text(text, entry.split(".")[-1]):
        value = qsharp.eval(entry + "()")
        if value is not None:
            print(show(value))
except qsharp.QSharpError as e:
    print(str(e).rstrip())
    sys.exit(1)
```

`make_samples.py`:

```python
"""Writes the sample Q# Runs used with qsharp_runner.py into the directory given."""
import os
import sys

SAMPLES = {
    "01_statements.qs": '''Message("Hello from Q#");
use qs = Qubit[3];
ApplyToEach(H, qs);
MResetEachZ(qs)
''',
    "02_main.qs": '''// Run Main() to get a Bell pair.
operation Main() : (Result, Result) {
    use (a, b) = (Qubit(), Qubit());
    H(a);
    CNOT(a, b);
    Message("Bell pair prepared");
    (MResetZ(a), MResetZ(b))
}
''',
    "03_namespace.qs": '''namespace Demo {
    function Square(x : Int) : Int { x * x }
    operation Main() : Int[] {
        Message($"square of 3 is {Square(3)}");
        [Square(1), Square(2), Square(3)]
    }
}
''',
    "04_entrypoint.qs": '''namespace Demo {
    @EntryPoint()
    operation Teleport() : Bool {
        Message("teleporting");
        true
    }
    operation Main(n : Int) : Int { n }
}
''',
    "05_main_called.qs": '''operation Main() : Int {
    Message("Main ran");
    5
}
Main()
''',
    "06_no_entry.qs": '''operation Helper() : Unit { Message("never called"); }
''',
    "07_syntax_error.qs": '''operation Main() : Int {
    let x = ;
    x
}
''',
    "08_runtime_failure.qs": '''operation Main() : Unit {
    Message("about to fail");
    fail "the angle must be positive";
}
''',
    "09_main_with_args.qs": '''operation Main(shots : Int) : Int { shots }
''',
    "10_unicode.qs": '''Message("Привет, кубит ⟩ — ok");
"строка"
''',
    "11_main_unit.qs": '''operation Main() : Unit {
    use q = Qubit();
    H(q);
    Microsoft.Quantum.Diagnostics.DumpMachine();
    Reset(q);
}
''',
    "12_values.qs": '''(1, true, One, "s", 2.5, PauliX, 1..3, [Zero, One])
''',
    "13_long.qs": '''operation Main() : Int {
    mutable total = 0;
    for step in 1..5 {
        for i in 0..2000000 { set total += i % 3; }
        Message($"step {step} of 5");
    }
    total
}
''',
    "14_endless.qs": '''operation Main() : Unit {
    mutable i = 0;
    Message("looping forever");
    while true { set i += 1; }
}
''',
}

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
for name, text in SAMPLES.items():
    with open(os.path.join(out, name), "w", encoding="utf-8") as f:
        f.write(text)
print("\n".join(sorted(SAMPLES)))
```

`run_samples.sh`:

```sh
#!/bin/bash
# Every sample through qsharp_runner.py, started as the Runner starts it (one pipe), with the
# Python given; the endless sample is left out (e10_stop.py stops it).
#   run_samples.sh <qs dir> <python>
Q=$1
PY=$2
cd "$Q/work2" || exit 1
echo "python: $PY ($("$PY" -I -c 'import importlib.metadata as m, sys
for d in ("qdk", "qsharp"):
    try: print(d, m.version(d), end="  ")
    except m.PackageNotFoundError: print(d, "absent", end="  ")'))"
for f in "$Q"/samples/*.qs; do
  case "$f" in *14_endless*) continue ;; esac
  echo "== $(basename "$f")"
  MERGED=1 python3 -I "$Q/scripts/harness.py" "$PY" "$Q/work2" "$Q/scripts/qsharp_runner.py" "$f"
done
```


With `qdk` 1.34.0 only (the `qsharp` shim uninstalled):

Output (`runner_qdk.txt`):

```
python: $Q/venv/bin/python (qdk 1.34.0  qsharp absent  )
== 01_statements.qs
Hello from Q#
[Zero, Zero, One]
0
== 02_main.qs
Bell pair prepared
(One, One)
0
== 03_namespace.qs
square of 3 is 9
[1, 4, 9]
0
== 04_entrypoint.qs
teleporting
true
0
== 05_main_called.qs
Main ran
5
0
== 06_no_entry.qs
0
== 07_syntax_error.qs
Qdk.Qsc.Parse.Rule

  x syntax error
  `-> expected expression, found `;`
   ,-[line_0:2:13]
 1 | operation Main() : Int {
 2 |     let x = ;
   :             ^
 3 |     x
   `----
1
== 08_runtime_failure.qs
about to fail
Error: program failed: the angle must be positive
Call stack:
    at Main in line_0:3:5
Qdk.Qsc.Eval.UserFail

  x runtime error
  `-> program failed: the angle must be positive
   ,-[line_0:3:5]
 2 |     Message("about to fail");
 3 |     fail "the angle must be positive";
   :     ^^^^^^^^^^^^^^^^|^^^^^^^^^^^^^^^^
   :                     `-- explicit fail
 4 | }
   `----
1
== 09_main_with_args.qs
Qdk.Qsc.EntryPoint.Args

  x entry point cannot have parameters
   ,-[line_0:1:16]
 1 | operation Main(shots : Int) : Int { shots }
   :                ^^^^^^^^^^^
   `----
1
== 10_unicode.qs
Привет, кубит ⟩ — ok
строка
0
== 11_main_unit.qs
STATE:
|0⟩: 0.7071+0.0000𝑖
|1⟩: 0.7071+0.0000𝑖
0
== 12_values.qs
(1, true, One, s, 2.5, PauliX, 1..3, [Zero, One])
0
== 13_long.qs
step 1 of 5
step 2 of 5
step 3 of 5
step 4 of 5
step 5 of 5
10000005
0
```


With `qsharp` 1.28.0 only. The differences from the run above, timestamps left out:

Output (`runner_diff.txt`):

```
1c1
< python: $Q/venv/bin/python (qdk 1.34.0  qsharp absent  )
---
> python: $Q/venv128/bin/python (qdk absent  qsharp 1.28.0  )
4c4
< [t out+err] [Zero, Zero, One]
---
> [t out+err] [One, Zero, One]
20c20,21
< [t out+err] 5
---
> [t out+err] 5⏎
> [t out+err] 
25c26
< [t out+err] Qdk.Qsc.Parse.Rule
---
> [t out+err] Qsc.Parse.Rule
41c42
< [t out+err] Qdk.Qsc.Eval.UserFail
---
> [t out+err] Qsc.Eval.UserFail
54c55
< [t out+err] Qdk.Qsc.EntryPoint.Args
---
> [t out+err] Qsc.EntryPoint.Args
```


Only three things differ: the measurement outcomes (random), one line that the pipe delivered in two pieces (`5⏎`), and the prefix of error codes (`Qsc.` instead of `Qdk.Qsc.`).

What it writes as `qoop-env.json` (`QOOP_RUN_DIR` = `$Q/rundir`), on success and on failure:

Output (`e13_env.txt`):

```
[ 0.194s    exit] 0
venv 02_main -> {"python": "3.12.13", "packages": [["qdk", "1.34.0"]], "figures": []}
[ 0.181s    exit] 1
venv 08_runtime_failure -> {"python": "3.12.13", "packages": [["qdk", "1.34.0"]], "figures": []}
[ 0.168s    exit] 0
venv128 02_main -> {"python": "3.12.13", "packages": [["qsharp", "1.28.0"]], "figures": []}
[ 0.171s    exit] 1
venv128 08_runtime_failure -> {"python": "3.12.13", "packages": [["qsharp", "1.28.0"]], "figures": []}
```


And with a Python that has neither package:

Output (`e14_missing.txt`):

```
[ 0.027s out+err] Q# is not installed for this Python. Install it with: pip install qdk
[ 0.030s    exit] 1
```


`pyqir` is not loaded by a Run:

Output (`e12_pyqir.txt`):

```
Bell pair prepared
(Zero, Zero)
pyqir loaded: False
```


## 7. Versions and distributions

`e11_versions.py`:

```python
"""What importlib.metadata says about the Q# distributions, as the settings probe would ask
(python -I, five seconds), and what qdk says about itself."""
import importlib.metadata as md

for name in ("qsharp", "qdk", "pyqir", "QDK", "q-sharp"):
    try:
        print(f"version({name!r}) = {md.version(name)!r}")
    except md.PackageNotFoundError as e:
        print(f"version({name!r}) -> PackageNotFoundError: {e}")
for name in ("qsharp", "qdk"):
    try:
        print(f"requires({name!r}) = {md.requires(name)}")
    except md.PackageNotFoundError:
        pass
print("packages_distributions: qdk ->", md.packages_distributions().get("qdk"),
      "| qsharp ->", md.packages_distributions().get("qsharp"),
      "| tests ->", md.packages_distributions().get("tests"))
try:
    import os
    os.environ["QDK_PYTHON_TELEMETRY"] = "none"
    import qdk
    print("qdk.__version__ =", getattr(qdk, "__version__", "(none)"))
except ImportError as e:
    print("import qdk failed:", e)
```

Output (`e11.txt`):

```
== qsharp 1.31.0 + qdk 1.34.0 installed
version('qsharp') = '1.31.0'
version('qdk') = '1.34.0'
version('pyqir') = '0.12.8'
version('QDK') = '1.34.0'
version('q-sharp') -> PackageNotFoundError: No package metadata was found for q-sharp
requires('qsharp') = ['qdk>=1.31.0', 'qdk[jupyter]; extra == "jupyterlab"', 'qdk[jupyter]; extra == "widgets"', 'qdk[qiskit]; extra == "qiskit"', 'qdk[cirq]; extra == "cirq"', 'qdk[qre]; extra == "qre"']
requires('qdk') = ['pyqir>=0.12.8,<0.13', "qsharp-widgets==1.34.0 ; extra == 'jupyter'", "qsharp-jupyterlab==1.34.0 ; extra == 'jupyter'", "azure-quantum>=3.8.0 ; extra == 'azure'", "qiskit>=1.2.2,<3.0.0 ; extra == 'qiskit'", "cirq-core>=1.6.1,<1.8 ; extra == 'cirq'", "cirq-ionq>=1.6.1,<1.8 ; extra == 'cirq'", "ply>=3.11 ; extra == 'cirq'", "pandas>=2.1 ; extra == 'qre'", "cirq-core>=1.6.1,<1.8 ; extra == 'applications'", "qodec[parsers]>=0.2.0.dev0,<0.3 ; platform_machine != 'ARM64' and platform_machine != 'aarch64' and extra == 'ec'", "qodec>=0.2.0.dev0,<0.3 ; (platform_machine == 'ARM64' and extra == 'ec') or (platform_machine == 'aarch64' and extra == 'ec')", "paulimer>=0.2.2 ; extra == 'ec'", "binar>=0.1.2 ; extra == 'ec'", "more-itertools>=10.0 ; extra == 'ec'", "highspy>=1.11,<2 ; extra == 'ec'", "numpy>=1.24 ; extra == 'ec'", "scipy>=1.9 ; extra == 'ec'", "qsharp-widgets==1.34.0 ; extra == 'all'", "azure-quantum>=3.8.0 ; extra == 'all'", "qiskit>=1.2.2,<3.0.0 ; extra == 'all'", "cirq-core>=1.6.1,<1.8 ; extra == 'all'", "cirq-ionq>=1.6.1,<1.8 ; extra == 'all'", "pandas>=2.1 ; extra == 'all'", "ply>=3.11 ; extra == 'all'", "qsharp-jupyterlab==1.34.0 ; extra == 'all'", "qodec[parsers]>=0.2.0.dev0,<0.3 ; platform_machine != 'ARM64' and platform_machine != 'aarch64' and extra == 'all'", "qodec>=0.2.0.dev0,<0.3 ; (platform_machine == 'ARM64' and extra == 'all') or (platform_machine == 'aarch64' and extra == 'all')", "paulimer>=0.2.2 ; extra == 'all'", "binar>=0.1.2 ; extra == 'all'", "more-itertools>=10.0 ; extra == 'all'", "highspy>=1.11,<2 ; extra == 'all'", "numpy>=1.24 ; extra == 'all'", "scipy>=1.9 ; extra == 'all'"]
packages_distributions: qdk -> ['qdk'] | qsharp -> ['qsharp'] | tests -> ['qsharp']
qdk.__version__ = (none)
== qsharp uninstalled, qdk 1.34.0 only
version('qsharp') -> PackageNotFoundError: No package metadata was found for qsharp
version('qdk') = '1.34.0'
version('pyqir') = '0.12.8'
version('QDK') = '1.34.0'
version('q-sharp') -> PackageNotFoundError: No package metadata was found for q-sharp
packages_distributions: qdk -> ['qdk'] | qsharp -> None | tests -> None
qdk.__version__ = (none)
[ 0.149s out+err] square of 3 is 9
[ 0.149s out+err] [1, 4, 9]
[ 0.171s    exit] 0
ModuleNotFoundError: No module named 'qsharp'
```


## 8. Telemetry

`qdk/telemetry.py` (1.34.0) posts batched usage metrics to `https://westus2-2.in.applicationinsights.azure.com//v2.1/track` every 60 s and at exit (`atexit`, joining its thread for at most 3 s). It is on in release builds unless `QDK_PYTHON_TELEMETRY` or `QSHARP_PYTHON_TELEMETRY` is `none`/`0`/`false`/`disabled`, read once when the module is imported. `QSHARP_PYTHON_AI_URL` overrides the address, which is how it was observed below without reaching Microsoft. `qsharp/telemetry.py` of 1.28.0 reads the same two variables.

`e6_telemetry.py`:

```python
"""What qdk telemetry does when nobody turns it off, without letting it leave this machine.

Runs qsharp_runner-like code (but WITHOUT the line that turns telemetry off) three ways:
  1. QSHARP_PYTHON_AI_URL -> a listener on 127.0.0.1: what is sent, and when;
  2. QSHARP_PYTHON_AI_URL -> 10.255.255.1 (unroutable): how much longer the process takes to exit;
  3. QDK_PYTHON_TELEMETRY=none and the URL -> the listener: is anything sent.
    e6_telemetry.py <python> <cwd> <main.qs>
"""
import http.server
import json
import os
import subprocess
import sys
import threading
import time

python, cwd, qs = sys.argv[1:]
received = []


class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        received.append((time.monotonic(), body))
        self.send_response(200)
        self.end_headers()

    def log_message(self, *a):
        pass


srv = http.server.HTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
local = f"http://127.0.0.1:{srv.server_port}/v2.1/track"

CODE = (
    "import sys\n"
    "from qdk import qsharp\n"
    "print(qsharp.eval(open(sys.argv[1]).read()), flush=True)\n"
)
base = {k: os.environ[k] for k in ("PATH", "HOME", "USER", "LANG", "TMPDIR") if k in os.environ}
base.update(PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8")


def go(label, extra):
    received.clear()
    t0 = time.monotonic()
    p = subprocess.run([python, "-u", "-X", "utf8", "-c", CODE, qs], cwd=cwd, env={**base, **extra},
                       stdin=subprocess.DEVNULL, capture_output=True, text=True)
    t1 = time.monotonic()
    print(f"== {label}: exit {p.returncode} after {t1 - t0:.3f}s; output {p.stdout.strip()!r}")
    for at, body in received:
        print(f"   POST at +{at - t0:.3f}s, {len(body)} bytes:")
        for entry in json.loads(body):
            print("     ", json.dumps({"tags": entry["tags"], "metric": entry["data"]["baseData"]["metrics"][0],
                                        "properties": entry["data"]["baseData"]["properties"]}))
    if not received:
        print("   nothing was sent")


go("telemetry left on, sent to a local listener", {"QSHARP_PYTHON_AI_URL": local})
go("telemetry left on, sent to an unroutable address", {"QSHARP_PYTHON_AI_URL": "http://10.255.255.1/v2.1/track"})
import socket

silent = socket.socket()
silent.bind(("127.0.0.1", 0))
silent.listen(8)  # accepts connections (the kernel does) and never answers
go("telemetry left on, sent to a listener that never answers",
   {"QSHARP_PYTHON_AI_URL": f"http://127.0.0.1:{silent.getsockname()[1]}/v2.1/track"})
go("telemetry off (QDK_PYTHON_TELEMETRY=none), URL still the listener",
   {"QSHARP_PYTHON_AI_URL": local, "QDK_PYTHON_TELEMETRY": "none"})
```

Output (`e6.txt`):

```
== telemetry left on, sent to a local listener: exit 0 after 0.333s; output 'Hello from Q#\n[Zero, One, Zero]'
   POST at +0.290s, 1581 bytes:
      {"tags": {"ai.device.locale": "C", "ai.device.osVersion": "Darwin Kernel Version 25.5.0: Tue Jun  9 22:26:22 PDT 2026; root:xnu-12377.121.10~1/RELEASE_ARM64_T8132"}, "metric": {"name": "qdk.import", "value": 1, "count": 1}, "properties": {"qsharp.version": "1.34.0"}}
      {"tags": {"ai.device.locale": "C", "ai.device.osVersion": "Darwin Kernel Version 25.5.0: Tue Jun  9 22:26:22 PDT 2026; root:xnu-12377.121.10~1/RELEASE_ARM64_T8132"}, "metric": {"name": "qsharp.eval", "value": 1, "count": 1}, "properties": {"qsharp.version": "1.34.0"}}
      {"tags": {"ai.device.locale": "C", "ai.device.osVersion": "Darwin Kernel Version 25.5.0: Tue Jun  9 22:26:22 PDT 2026; root:xnu-12377.121.10~1/RELEASE_ARM64_T8132"}, "metric": {"name": "qsharp.eval.durationMs", "value": 0.46449992805719376, "count": 1, "min": 0.46449992805719376, "max": 0.46449992805719376}, "properties": {"qsharp.version": "1.34.0"}}
== telemetry left on, sent to an unroutable address: exit 0 after 0.265s; output 'Hello from Q#\n[One, One, One]'
   nothing was sent
== telemetry left on, sent to a listener that never answers: exit 0 after 3.231s; output 'Hello from Q#\n[One, One, One]'
   nothing was sent
== telemetry off (QDK_PYTHON_TELEMETRY=none), URL still the listener: exit 0 after 0.339s; output 'Hello from Q#\n[One, Zero, Zero]'
   nothing was sent
```


(The unroutable address failed at once on this network. The silent listener is the slow case: 3 s more.)

## 9. Network and files with telemetry off

A Python audit hook reports every socket use and every file opened for writing. The control below must show the telemetry connection.

`e7_audit.py`:

```python
"""Runs qsharp_runner.py under a Python audit hook that reports every socket use and every
file opened for writing, then runs it. Native code outside Python is not seen by the hook
(lsof, run beside it, covers sockets for that).
    python -u -X utf8 e7_audit.py <qsharp_runner.py> <main.qs>
"""
import runpy
import sys

_seen = set()


def hook(event, args):
    if event.startswith("socket.") or event in ("urllib.Request", "http.client.connect"):
        key = (event, repr(args)[:160])
    elif event == "open" and len(args) >= 2 and isinstance(args[1], str) and any(c in args[1] for c in "wax+"):
        key = (event, f"{args[0]!r} mode {args[1]!r}")
    elif event in ("os.mkdir", "os.remove", "os.rename", "shutil.copyfile"):
        key = (event, repr(args)[:160])
    else:
        return
    if key not in _seen:
        _seen.add(key)
        sys.__stderr__.write(f"AUDIT {key[0]} {key[1]}\n")


sys.addaudithook(hook)
runner, qs = sys.argv[1:]
sys.argv = [runner, qs]
runpy.run_path(runner, run_name="__main__")
```

`e7_control.py`:

```python
"""Positive control for e7_audit.py: imports qdk with telemetry as it is and evaluates one line,
so the audit hook must see the telemetry connection at exit."""
from qdk import qsharp

print(qsharp.eval("1 + 1"))
```


`e7_control_128.py` is the same with `import qsharp`.

Output (`e7.txt`):

```
== qdk 1.34.0 control: telemetry left on, URL a closed local port
[ 0.143s out+err] 2
[ 0.156s out+err] AUDIT urllib.Request ('http://127.0.0.1:9/x', b'[{"ver": 1, "name": "Microsoft.ApplicationInsights.Metric", "time": "2026-11-24T16:5
[ 0.156s out+err] AUDIT http.client.connect (<http.client.HTTPConnection object at 0x102ebd3d0>, '127.0.0.1', 9)
[ 0.158s out+err] AUDIT socket.getaddrinfo ('127.0.0.1', 9, 0, 1, 0)
[ 0.159s out+err] AUDIT socket.__new__ (<socket.socket fd=-1, family=0, type=0, proto=0>, 2, 1, 6)
[ 0.159s out+err] AUDIT socket.connect (<socket.socket fd=3, family=2, type=1, proto=6, laddr=('0.0.0.0', 0)>, ('127.0.0.1', 9))
[ 0.181s    exit] 0
== qdk 1.34.0, the runner
[ 0.146s out+err] Bell pair prepared
[ 0.146s out+err] (Zero, Zero)
[ 0.155s out+err] AUDIT open '$Q/rundir/qoop-env.json.tmp
[ 0.155s out+err] AUDIT os.rename ('$Q/rundir/qoop-env.js
[ 0.177s    exit] 0
```

Output (`e7_128.txt`):

```
== 1.28 control: telemetry left on, URL a closed local port
[ 0.140s out+err] 2
[ 0.153s out+err] AUDIT urllib.Request ('http://127.0.0.1:9/x', b'[{"ver": 1, "name": "Microsoft.ApplicationInsights.Metric", "time": "2026-11-24T16:5
[ 0.153s out+err] AUDIT http.client.connect (<http.client.HTTPConnection object at 0x102469670>, '127.0.0.1', 9)
[ 0.156s out+err] AUDIT socket.getaddrinfo ('127.0.0.1', 9, 0, 1, 0)
[ 0.156s out+err] AUDIT socket.__new__ (<socket.socket fd=-1, family=0, type=0, proto=0>, 2, 1, 6)
[ 0.156s out+err] AUDIT socket.connect (<socket.socket fd=3, family=2, type=1, proto=6, laddr=('0.0.0.0', 0)>, ('127.0.0.1', 9))
[ 0.171s    exit] 0
== 1.28, the runner
[ 0.138s out+err] Bell pair prepared
[ 0.138s out+err] (Zero, Zero)
[ 0.146s out+err] AUDIT open '$Q/rundir/qoop-env.json.tmp' mode 'w'
[ 0.146s out+err] AUDIT os.rename ('$Q/rundir/qoop-env.json.tmp', '$Q…
[ 0.160s    exit] 0
```


The audit hook sees only Python. For native code, `lsof` on the running process, and every new file afterwards:

`e8_native.sh`:

```sh
#!/bin/bash
# While the 5-second sample runs as the Runner would start it: its sockets (lsof -i) and open
# files; afterwards, every file that appeared in the fake HOME, the fake TMPDIR, the working
# directory or the venv, and any qdk/qsharp-named entry changed in the real caches.
#   e8_native.sh <qs dir>
Q=$1
cd "$Q/work2" || exit 1
touch "$Q/out/marker2"
sleep 1
QS_HOME=$Q/fakehome QS_TMP=$Q/faketmp MERGED=1 python3 -I "$Q/scripts/harness.py" "$Q/venv/bin/python" "$Q/work2" \
  "$Q/scripts/qsharp_runner.py" "$Q/samples/13_long.qs" > "$Q/out/e8_long.txt" 2>&1 &
sleep 2
PID=$(pgrep -f "venv/bin/python -u -X utf8 .*qsharp_runner.py .*13_long" | head -1)
echo "child pid $PID: $(ps -o command= -p "$PID" | cut -c1-90)"
echo "-- lsof -i (network) for it:"
lsof -a -i -p "$PID"
echo "(lsof exit $?: 1 means no network files)"
echo "-- open files, code it loaded (txt) left out:"
lsof -p "$PID" | awk 'NR>1 && $4 != "txt" {print $4, $5, $9}'
wait
tail -2 "$Q/out/e8_long.txt"
echo "-- files new since the start in fake HOME, fake TMPDIR, cwd, venv:"
find "$Q/fakehome" "$Q/faketmp" "$Q/work2" "$Q/venv" -newer "$Q/out/marker2"
echo "-- qdk/qsharp/qsc/quantum names changed in the last 30 min in the real caches:"
find ~/.cache ~/Library/Caches ~/Library/"Application Support" ~/.config -maxdepth 3 -mmin -30 2>/dev/null | grep -i "qdk\|qsharp\|qsc\|quantum"
echo "(end)"
```

Output (`e8.txt`):

```
child pid 85055: $Q…
-- lsof -i (network) for it:
(lsof exit 1: 1 means no network files)
-- open files, code it loaded (txt) left out:
cwd DIR $Q/work2
0u CHR /dev/null
1 PIPE 
2 PIPE 
[ 2.922s out+err] 10000005
[ 2.952s    exit] 0
-- files new since the start in fake HOME, fake TMPDIR, cwd, venv:
$Q/work2
$Q/work2/qoop-env.json
-- qdk/qsharp/qsc/quantum names changed in the last 30 min in the real caches:
(end)
```


(`qoop-env.json` is in the working directory because the harness makes it the Run's directory.)

## 10. Time

`e9_timing.py`:

```python
"""Wall time of `import qdk.qsharp` alone and of qsharp_runner.py on a small program, started
as the Runner starts it. First with qdk's bytecode cache removed (closest to a first start
that this check can make without root: the OS file cache is not emptied), then warm, 5 times.
    e9_timing.py <venv python> <cwd> <qsharp_runner.py> <main.qs>
"""
import glob
import os
import shutil
import subprocess
import sys
import time

python, cwd, runner, qs = sys.argv[1:]
site = subprocess.run([python, "-c", "import site; print(site.getsitepackages()[0])"],
                      capture_output=True, text=True).stdout.strip()
env = {k: os.environ[k] for k in ("PATH", "HOME", "USER", "LANG", "TMPDIR") if k in os.environ}
env.update(PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8")
# A bare `import qdk` sends a usage report at exit unless this is set (see e6); the runner
# sets it itself, the bare-import timings need it here.
env["QDK_PYTHON_TELEMETRY"] = "none"


def timed(args):
    t = time.monotonic()
    p = subprocess.run([python, "-u", "-X", "utf8", *args], cwd=cwd, env=env,
                       stdin=subprocess.DEVNULL, capture_output=True, text=True)
    assert p.returncode == 0, p.stdout + p.stderr
    return time.monotonic() - t


def drop_bytecode():
    n = 0
    for pkg in ("qdk", "qsharp", "pyqir"):
        for d in glob.glob(os.path.join(site, pkg, "**", "__pycache__"), recursive=True):
            shutil.rmtree(d)
            n += 1
    return n


base = timed(["-c", "pass"])
print(f"python start alone: {base:.3f}s")
print(f"removed {drop_bytecode()} __pycache__ folders")
print(f"import qdk.qsharp, no bytecode cache: {timed(['-c', 'import qdk.qsharp']):.3f}s")
warm = [timed(["-c", "import qdk.qsharp"]) for _ in range(5)]
print("import qdk.qsharp, warm:", " ".join(f"{t:.3f}" for t in warm))
print(f"removed {drop_bytecode()} __pycache__ folders")
print(f"runner + small program, no bytecode cache: {timed([runner, qs]):.3f}s")
warm = [timed([runner, qs]) for _ in range(5)]
print("runner + small program, warm:", " ".join(f"{t:.3f}" for t in warm))
```

Output (`e9.txt`):

```
python start alone: 0.020s
removed 3 __pycache__ folders
import qdk.qsharp, no bytecode cache: 0.133s
import qdk.qsharp, warm: 0.109 0.111 0.120 0.129 0.147
removed 3 __pycache__ folders
runner + small program, no bytecode cache: 0.267s
runner + small program, warm: 0.230 0.238 0.229 0.230 0.233
```


The OS file cache cannot be emptied without root, so the "no bytecode cache" lines are warm for the files themselves. The real first start after installing is the 1.0 s import in section 2.

## 11. Stopping

As `qoop_proc::Group::terminate` does on macOS and Linux: SIGTERM to the process group, 500 ms, then SIGKILL.

`e10_stop.py`:

```python
"""Stops a running Q# program the way the Runner does on macOS/Linux (qoop_proc::Group::terminate):
SIGTERM to its process group, 500 ms grace, then SIGKILL. Reports what ended it, its status,
and whether anything of its group or in its folders is left. Also tries SIGINT for comparison.
    e10_stop.py <venv python> <cwd> <qsharp_runner.py> <main.qs> <fake tmp>
"""
import os
import signal
import subprocess
import sys
import time

python, cwd, runner, qs, tmp = sys.argv[1:]
env = {k: os.environ[k] for k in ("PATH", "HOME", "USER", "LANG") if k in os.environ}
env.update(PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8", TMPDIR=tmp, QDK_PYTHON_TELEMETRY="none")


def group_members(pgid):
    out = subprocess.run(["ps", "-A", "-o", "pid=,pgid=,stat=,command="], capture_output=True, text=True).stdout
    return [l.strip() for l in out.splitlines() if l.split()[1] == str(pgid)]


def stop(first_signal):
    before = set(os.listdir(cwd)) | {"tmp:" + n for n in os.listdir(tmp)}
    p = subprocess.Popen([python, "-u", "-X", "utf8", runner, qs], cwd=cwd, env=env,
                         stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         process_group=0)
    time.sleep(2.0)
    print(f"== {signal.Signals(first_signal).name}: running, group {p.pid}: {group_members(p.pid)}")
    t = time.monotonic()
    os.killpg(p.pid, first_signal)
    try:
        code = p.wait(timeout=0.5)
        how = f"ended by {signal.Signals(first_signal).name} within {time.monotonic() - t:.3f}s"
    except subprocess.TimeoutExpired:
        os.killpg(p.pid, signal.SIGKILL)
        code = p.wait()
        how = f"still running after 500 ms grace; ended by SIGKILL after {time.monotonic() - t:.3f}s"
    out = p.stdout.read().decode()
    print(f"   {how}; returncode {code}")
    print(f"   output: {out!r}")
    print(f"   left in its group: {group_members(p.pid)}")
    after = set(os.listdir(cwd)) | {"tmp:" + n for n in os.listdir(tmp)}
    print(f"   new in cwd / TMPDIR: {sorted(after - before)}")


stop(signal.SIGTERM)
stop(signal.SIGINT)
```

Output (`e10.txt`):

```
== SIGTERM: running, group 80825: ['80825 80825 R    $Q/venv/bin/python -u -X utf8 $Q/scripts/qsharp_runner.py $Q/samples/14_endless.qs']
   ended by SIGTERM within 0.004s; returncode -15
   output: 'looping forever\n'
   left in its group: []
   new in cwd / TMPDIR: []
== SIGINT: running, group 80841: ['80841 80841 R    $Q/venv/bin/python -u -X utf8 $Q/scripts/qsharp_runner.py $Q/samples/14_endless.qs']
   still running after 500 ms grace; ended by SIGKILL after 0.502s; returncode -9
   output: 'looping forever\n'
   left in its group: []
   new in cwd / TMPDIR: []
```

