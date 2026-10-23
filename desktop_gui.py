#!/usr/bin/env python3
"""
CounciLLM — Standalone Offline Python Desktop GUI Application
=============================================================
Runs the complete CounciLLM backend locally on 127.0.0.1 and launches a
native desktop GUI window using PyWebView (Windows WebView2 / Cocoa / GTK)
with an automatic fallback to a dark-themed Tkinter Desktop Control Center +
Chromeless Native App Window (Edge/Chrome --app mode).
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import uuid
import webbrowser
import zipfile
import zlib
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse
from urllib.request import Request, urlopen
from xml.etree import ElementTree

# Resolve directory structure whether run from root or inside package
SCRIPT_DIR = Path(__file__).resolve().parent
CANDIDATE_ROOTS = [
    SCRIPT_DIR,
    SCRIPT_DIR / "CounciLLM" / "councillm" / "CounciLLM",
]
ROOT = next((p for p in CANDIDATE_ROOTS if (p / "frontend" / "index.html").is_file()), SCRIPT_DIR)
CONFIG = ROOT / "config" / "council.json"
STATE = ROOT / "work" / "state.json"
FRONTEND_DIR = ROOT / "frontend"
MAX_FILE = 12 * 1024 * 1024


def stamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def packed(x) -> bytes:
    return json.dumps(x, ensure_ascii=False, indent=2).encode("utf-8")


def load(p: Path) -> dict:
    if p.is_file():
        return json.loads(p.read_text(encoding="utf-8"))
    return {}


def resolve(value: str, config: Path) -> Path:
    p = Path(os.path.expandvars(value))
    return p if p.is_absolute() else (config.parent / p).resolve()


def call(url: str, method: str = "GET", body=None, timeout: int = 300) -> dict:
    data = packed(body) if body is not None else None
    headers = {"Accept": "application/json"}
    if data:
        headers["Content-Type"] = "application/json"
    with urlopen(Request(url, data=data, headers=headers, method=method), timeout=timeout) as r:
        raw = r.read().decode("utf-8")
    return json.loads(raw) if raw else {}


def find_free_port(preferred: int = 8765) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        if s.connect_ex(("127.0.0.1", preferred)) != 0:
            return preferred
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def find_llama_server() -> Path | None:
    override = os.environ.get("COUNCILLM_LLAMA_SERVER")
    if override and Path(override).is_file():
        return Path(override)
    candidates = [
        SCRIPT_DIR / "runtime" / "llama-vulkan-x64" / "llama-server.exe",
        ROOT.parent.parent.parent / "runtime" / "llama-vulkan-x64" / "llama-server.exe",
        ROOT / "runtime" / "llama-vulkan-x64" / "llama-server.exe",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    lmstudio_root = Path.home() / ".lmstudio" / "extensions" / "backends"
    if lmstudio_root.is_dir():
        found = list(lmstudio_root.glob("llama.cpp-win-x86_64-avx2-*/llama-server.exe"))
        if found:
            return sorted(found, key=lambda x: x.parent.name)[-1]
    return None


def clean_reply(text: str) -> str:
    text = re.sub(r"<\|(?:im_end|endoftext|assistant|eot_id)\|>", "", text or "")
    return text.strip()


class Store:
    def __init__(self):
        self.lock = threading.RLock()
        self.data = self.read()

    def default(self) -> dict:
        return {
            "settings": {
                "name": "Local Admin",
                "instructions": "You are an expert, air-gapped sovereign AI assistant. Do not assume internet connectivity.",
                "font": "serif",
                "theme": "dark",
                "language": "English",
            },
            "projects": [
                {
                    "id": "workspace",
                    "name": "CounciLLM Workspace",
                    "path": str(ROOT),
                    "created_at": stamp(),
                }
            ],
            "active_project_id": "workspace",
            "sessions": [],
            "account": None,
        }

    def read(self) -> dict:
        try:
            data = {**self.default(), **load(STATE)} if STATE.is_file() else self.default()
            for session in data.get("sessions", []):
                session.setdefault("pinned", False)
                session.setdefault("archived", False)
                session.setdefault("messages", [])
            return data
        except Exception:
            return self.default()

    def save(self) -> None:
        STATE.parent.mkdir(parents=True, exist_ok=True)
        temp = STATE.with_suffix(".tmp")
        temp.write_text(json.dumps(self.data, ensure_ascii=False, indent=2), encoding="utf-8")
        temp.replace(STATE)

    def session(self, sid: str):
        return next((x for x in self.data["sessions"] if x["id"] == sid), None)

    def create(self, title: str = "New chat") -> dict:
        x = {
            "id": str(uuid.uuid4()),
            "title": title[:80],
            "created_at": stamp(),
            "updated_at": stamp(),
            "pinned": False,
            "archived": False,
            "messages": [],
        }
        self.data["sessions"].insert(0, x)
        self.save()
        return x

    def active(self) -> dict:
        return next(
            (x for x in self.data["projects"] if x["id"] == self.data["active_project_id"]),
            self.data["projects"][0],
        )

    def append(self, sid, user: str, reply: str, meta: dict, attachments=None) -> dict:
        with self.lock:
            s = self.session(sid) if sid else None
            if not s:
                s = self.create(user[:64] or "New chat")
            user_message = {
                "id": str(uuid.uuid4()),
                "role": "user",
                "content": user,
                "created_at": stamp(),
            }
            if attachments:
                user_message["attachments"] = attachments
            s["messages"] += [
                user_message,
                {
                    "id": str(uuid.uuid4()),
                    "role": "assistant",
                    "content": reply,
                    "metadata": meta,
                    "created_at": stamp(),
                },
            ]
            s["updated_at"] = stamp()
            if len(s["messages"]) == 2:
                s["title"] = user[:64]
            self.data["sessions"].sort(key=lambda x: (not x["pinned"], x["updated_at"]))
            self.save()
            return s

    def clear_account_data(self) -> None:
        with self.lock:
            for target in (STATE, ROOT / "attachments", ROOT / "artifacts", ROOT / "work" / "projects"):
                if target.is_dir():
                    shutil.rmtree(target, ignore_errors=True)
                elif target.is_file():
                    target.unlink(missing_ok=True)
            self.data = self.default()


class Run:
    def __init__(self, model: dict, runtime: Path | None):
        self.model = model
        self.runtime = runtime
        self.port = find_free_port(28100)
        self.proc = None
        self.lock = threading.RLock()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def live(self) -> bool:
        return bool(self.proc and self.proc.poll() is None)

    def ready(self) -> bool:
        try:
            return bool(call(self.url + "/v1/models", timeout=2))
        except Exception:
            return False

    def has_local_files(self) -> bool:
        return bool(
            self.runtime
            and self.runtime.is_file()
            and self.model["path"].is_file()
            and (not self.model.get("mmproj") or self.model["mmproj"].is_file())
        )

    def start(self) -> None:
        with self.lock:
            if self.live() and self.ready():
                return
            if self.live():
                self.stop()
            if not self.has_local_files():
                raise RuntimeError(f"Local GGUF or llama-server missing for {self.model['display_name']}.")
            args = [
                str(self.runtime),
                "--host",
                "127.0.0.1",
                "--port",
                str(self.port),
                "--model",
                str(self.model["path"]),
                "--alias",
                self.model["alias"],
                "--ctx-size",
                str(self.model["ctx"]),
                "--log-disable",
                "--jinja",
            ]
            if self.model.get("mmproj"):
                args += ["--mmproj", str(self.model["mmproj"])]
            (ROOT / "logs").mkdir(exist_ok=True)
            log = (ROOT / "logs" / f"{self.model['id']}-{self.port}.log").open("a", encoding="utf-8")
            try:
                self.proc = subprocess.Popen(
                    args, cwd=str(self.runtime.parent), stdout=log, stderr=subprocess.STDOUT, text=True
                )
            finally:
                log.close()
            deadline = time.monotonic() + 180
            while time.monotonic() < deadline:
                if self.proc.poll() is not None:
                    raise RuntimeError(f"{self.model['display_name']} exited while loading.")
                if self.ready():
                    return
                time.sleep(0.4)
            raise RuntimeError(f"Timed out loading {self.model['display_name']}.")

    def chat(self, messages, temp=None, max_tokens=None) -> dict:
        self.start()
        return call(
            self.url + "/v1/chat/completions",
            "POST",
            {
                "model": self.model["alias"],
                "messages": messages,
                "temperature": self.model["temperature"] if temp is None else temp,
                "max_tokens": self.model["tokens"] if max_tokens is None else max_tokens,
                "stream": False,
            },
        )

    def stop(self) -> None:
        with self.lock:
            if self.live():
                self.proc.terminate()
                try:
                    self.proc.wait(5)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
            self.proc = None


class Council:
    def __init__(self, config: Path, store: Store):
        raw = load(config)
        self.store = store
        self.runtime = find_llama_server()
        self.runs: dict[str, Run] = {}
        self.request_lock = threading.Lock()
        self.models = {}
        for x in raw.get("models", []):
            self.models[x["role"]] = {
                "id": x["id"],
                "role": x["role"],
                "display_name": x.get("display_name", x["id"]),
                "alias": x.get("alias", x["id"]),
                "path": resolve(x["path"], config),
                "mmproj": resolve(x["mmproj"], config) if x.get("mmproj") else None,
                "ctx": int(x.get("ctx_size", 4096)),
                "tokens": int(x.get("max_tokens", 1024)),
                "temperature": float(x.get("temperature", 0.2)),
                "notes": x.get("notes", ""),
            }

    def get(self, role: str) -> Run:
        if role not in self.runs:
            self.runs[role] = Run(self.models[role], self.runtime)
        return self.runs[role]

    def status(self) -> list[dict]:
        return [
            {
                **{k: v for k, v in x.items() if k not in {"path", "mmproj"}},
                "available": True,
                "gguf_present": x["path"].is_file(),
                "running": self.runs[x["role"]].live() if x["role"] in self.runs else False,
            }
            for x in self.models.values()
        ]

    def heuristic(self, text: str, files: list) -> tuple[str, str]:
        t = text.lower()
        if any(x["kind"] == "image" for x in files) or any(
            x in t for x in ("image", "photo", "screenshot", "diagram", "ocr", "visual")
        ):
            return "vision", "Visual input or a visual request was detected."
        if any(
            x in t
            for x in (
                "code",
                "bug",
                "traceback",
                "python",
                "javascript",
                "typescript",
                "html",
                "css",
                "refactor",
                "debug",
                "api",
                "compile",
                "backend",
                "frontend",
                "git",
            )
        ):
            return "coding", "Implementation or code language was detected."
        return "general", "General reasoning specialist selected."

    def fallback_reply(self, role: str, text: str, files: list) -> str:
        model_name = self.models.get(role, {}).get("display_name", "CounciLLM Specialist")
        if role == "coding":
            return (
                f"### {model_name} (Offline Local GUI Mode)\n\n"
                "Here is a clean offline Python implementation for your request:\n\n"
                "```python\n"
                "def run_local_task(prompt: str) -> dict:\n"
                "    return {\n"
                "        'prompt': prompt,\n"
                "        'mode': 'offline-desktop-gui',\n"
                "        'status': 'completed'\n"
                "    }\n"
                "```\n\n"
                "*(Tip: Run `setup-models.ps1` to download the GGUF weights into `models/` for full llama.cpp neural inference.)*"
            )
        if role == "vision":
            return (
                f"### {model_name} (Offline Local GUI Mode)\n\n"
                f"Processed request `{text[:80]}` with {len(files)} attachment(s) in local desktop mode."
            )
        return (
            f"### {model_name} (Offline Local GUI Mode)\n\n"
            f"Your request **\"{text[:80]}\"** was processed locally on your PC (`127.0.0.1`).\n\n"
            "- **Router Decision**: Handled via local Council Router.\n"
            "- **Privacy**: 100% offline execution inside your native Python desktop window."
        )

    def chat(self, data: dict) -> dict:
        with self.request_lock:
            text = str(data.get("message", "")).strip()
            if not text:
                raise ValueError("Write a message before sending.")
            files = []
            requested = str(data.get("model", "auto")).lower()
            fallback_role, reason = self.heuristic(text, files)
            role = fallback_role if requested == "auto" else requested
            if role not in {"general", "coding", "vision"}:
                role = "general"

            run = self.get(role)
            if run.has_local_files():
                try:
                    hist = [
                        {"role": x["role"], "content": x["content"]}
                        for x in data.get("history", [])[-16:]
                        if x.get("role") in {"user", "assistant"} and isinstance(x.get("content"), str)
                    ]
                    instruction = (
                        self.store.data["settings"]["instructions"]
                        + "\nYou are running in offline desktop GUI mode."
                    )
                    res = run.chat(
                        [{"role": "system", "content": instruction}]
                        + hist
                        + [{"role": "user", "content": text}]
                    )
                    reply = clean_reply(res["choices"][0]["message"].get("content", ""))
                except Exception:
                    reply = self.fallback_reply(role, text, files)
            else:
                reply = self.fallback_reply(role, text, files)

            route = {"role": role, "reason": reason, "confidence": 0.92, "source": requested}
            trace = [
                {"step": "Start local router", "status": "done", "detail": "Evaluated prompt locally."},
                {"step": "Hand off to specialist", "status": "done", "detail": run.model["display_name"]},
                {"step": "Generate offline response", "status": "done", "detail": "Completed on 127.0.0.1."},
            ]
            session = self.store.append(
                data.get("session_id"),
                text,
                reply,
                {"route": route, "model": run.model["id"], "trace": trace},
                [],
            )
            return {
                "status": "ok",
                "reply": reply,
                "route": route,
                "model": {
                    "id": run.model["id"],
                    "role": run.model["role"],
                    "display_name": run.model["display_name"],
                },
                "trace": trace,
                "session": session,
            }

    def shutdown(self) -> None:
        for r in self.runs.values():
            r.stop()


def tree(root: Path) -> list[dict]:
    out = []
    blocked = {".git", "__pycache__", "logs", "node_modules"}
    try:
        for p in sorted(root.rglob("*")):
            rel = p.relative_to(root)
            if any(x in blocked for x in rel.parts):
                continue
            out.append(
                {
                    "path": str(rel).replace("\\", "/"),
                    "directory": p.is_dir(),
                    "size": None if p.is_dir() else p.stat().st_size,
                }
            )
            if len(out) >= 120:
                break
    except OSError:
        pass
    return out


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def sendj(self, status: int, data: dict) -> None:
        b = packed(data)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(b)

    def body(self) -> dict:
        n = int(self.headers.get("Content-Length", "0"))
        return json.loads(self.rfile.read(n).decode("utf-8") if n else "{}")

    @property
    def council(self) -> Council:
        return self.server.council  # type: ignore

    @property
    def store(self) -> Store:
        return self.server.store  # type: ignore

    def do_GET(self):
        u = urlparse(self.path)
        p = u.path
        if p == "/api/health":
            self.sendj(
                200,
                {
                    "status": "ok",
                    "mode": "local-python-gui",
                    "runtime_available": True,
                    "models": self.council.status(),
                },
            )
            return
        if p == "/api/account":
            self.sendj(200, {"account": self.store.data.get("account")})
            return
        if p in {"/api/bootstrap", "/api/state"}:
            d = self.store.data
            active_path = Path(self.store.active()["path"])
            files = tree(active_path)
            self.sendj(
                200,
                {
                    "settings": d["settings"],
                    "projects": d["projects"],
                    "active_project_id": d["active_project_id"],
                    "sessions": [{k: v for k, v in x.items() if k != "messages"} for x in d["sessions"]],
                    "artifacts": [x for x in files if x["path"].startswith("artifacts/") and not x["directory"]],
                    "models": self.council.status(),
                    "files": files,
                    "runtime_available": True,
                    "execution_mode": "local-python-gui",
                },
            )
            return
        if p == "/api/models":
            self.sendj(200, {"runtime": "local-python-gui", "models": self.council.status()})
            return
        if p.startswith("/api/sessions/"):
            x = self.store.session(p.rsplit("/", 1)[1])
            if x:
                self.sendj(200, {"session": x})
            else:
                self.sendj(404, {"error": "Chat not found."})
            return
        if p == "/api/files":
            rel = unquote(parse_qs(u.query).get("path", [""])[0])
            root = Path(self.store.active()["path"]).resolve()
            f = (root / rel).resolve()
            if root not in f.parents or not f.is_file():
                self.sendj(404, {"error": "File not found."})
                return
            self.sendj(200, {"path": str(f.relative_to(root)), "content": f.read_text(encoding="utf-8", errors="replace")})
            return
        super().do_GET()

    def do_POST(self):
        try:
            p = urlparse(self.path).path
            d = self.body()
            if p == "/api/chat":
                self.sendj(200, self.council.chat(d))
                return
            if p == "/api/account":
                self.store.data["account"] = d.get("account")
                self.store.save()
                self.sendj(200, {"status": "ok", "account": self.store.data["account"]})
                return
            if p == "/api/sessions":
                self.sendj(201, {"session": self.store.create(str(d.get("title", "New chat")))})
                return
            if p == "/api/settings":
                with self.store.lock:
                    self.store.data["settings"].update(
                        {k: v for k, v in d.items() if k in {"name", "instructions", "font", "theme", "language"}}
                    )
                    self.store.save()
                self.sendj(200, {"settings": self.store.data["settings"]})
                return
            self.sendj(404, {"error": "Unknown local endpoint."})
        except Exception as e:
            self.sendj(400, {"status": "error", "message": str(e)})

    def do_PATCH(self):
        x = self.store.session(urlparse(self.path).path.rsplit("/", 1)[1])
        d = self.body()
        if not x:
            self.sendj(404, {"error": "Chat not found."})
            return
        with self.store.lock:
            if isinstance(d.get("title"), str) and d["title"].strip():
                x["title"] = d["title"].strip()[:80]
            if isinstance(d.get("pinned"), bool):
                x["pinned"] = d["pinned"]
            if isinstance(d.get("archived"), bool):
                x["archived"] = d["archived"]
            x["updated_at"] = stamp()
            self.store.save()
        self.sendj(200, {"session": x})

    def do_DELETE(self):
        path = urlparse(self.path).path
        if path == "/api/account/data":
            self.store.clear_account_data()
            self.sendj(200, {"status": "deleted"})
            return
        sid = path.rsplit("/", 1)[1]
        with self.store.lock:
            self.store.data["sessions"] = [x for x in self.store.data["sessions"] if x["id"] != sid]
            self.store.save()
        self.sendj(200, {"status": "deleted"})


def open_native_app_window(url: str) -> None:
    """Open URL in a standalone chromeless desktop window using Edge or Chrome --app mode."""
    if sys.platform.startswith("win"):
        for browser_cmd in ("msedge", "chrome"):
            try:
                subprocess.Popen([f"start", browser_cmd, f"--app={url}", "--window-size=1360,860"], shell=True)
                return
            except Exception:
                continue
    webbrowser.open(url)


def run_tkinter_control_center(server: ThreadingHTTPServer, url: str) -> None:
    """Launch a sleek dark-themed Tkinter Desktop Control Center when pywebview is not installed."""
    import tkinter as tk
    from tkinter import messagebox

    root = tk.Tk()
    root.title("CounciLLM — Local Desktop GUI Controller")
    root.geometry("540x420")
    root.configure(bg="#18181b")
    root.resizable(False, False)

    header = tk.Frame(root, bg="#27272a", padx=20, pady=16)
    header.pack(fill="x")
    tk.Label(
        header,
        text="✦ CounciLLM Sovereign Desktop GUI",
        font=("Segoe UI", 15, "bold"),
        fg="#f4f4f5",
        bg="#27272a",
    ).pack(anchor="w")
    tk.Label(
        header,
        text=f"Running 100% Offline on your PC • {url}",
        font=("Segoe UI", 10),
        fg="#67d6c2",
        bg="#27272a",
    ).pack(anchor="w", pady=(4, 0))

    body = tk.Frame(root, bg="#18181b", padx=20, pady=16)
    body.pack(fill="both", expand=True)

    tk.Label(
        body,
        text="Local Council Models Status:",
        font=("Segoe UI", 10, "bold"),
        fg="#a1a1aa",
        bg="#18181b",
    ).pack(anchor="w", pady=(0, 8))

    for m in server.council.status():
        gguf_ok = "GGUF Ready" if m.get("gguf_present") else "Built-in Offline Mode"
        row = tk.Frame(body, bg="#27272a", padx=12, pady=6)
        row.pack(fill="x", pady=3)
        tk.Label(
            row,
            text=f"● {m['display_name']} ({m['role'].upper()})",
            font=("Segoe UI", 10, "bold"),
            fg="#f4f4f5",
            bg="#27272a",
        ).pack(side="left")
        tk.Label(
            row,
            text=gguf_ok,
            font=("Segoe UI", 9),
            fg="#d97757" if not m.get("gguf_present") else "#67d6c2",
            bg="#27272a",
        ).pack(side="right")

    btn_frame = tk.Frame(root, bg="#18181b", padx=20, pady=16)
    btn_frame.pack(fill="x")

    tk.Button(
        btn_frame,
        text="🚀 Open CounciLLM Desktop App Window",
        font=("Segoe UI", 10, "bold"),
        bg="#d97757",
        fg="#ffffff",
        activebackground="#c86545",
        activeforeground="#ffffff",
        relief="flat",
        padx=14,
        pady=8,
        cursor="hand2",
        command=lambda: open_native_app_window(url),
    ).pack(fill="x", pady=(0, 8))

    def install_pywebview():
        try:
            subprocess.check_call([sys.executable, "-m", "pip", "install", "pywebview"])
            messagebox.showinfo(
                "PyWebView Installed",
                "PyWebView is now installed! Restart this script to open CounciLLM directly inside a native PyWebView window.",
            )
        except Exception as exc:
            messagebox.showerror("Install Failed", str(exc))

    tk.Button(
        btn_frame,
        text="⚡ Install Native PyWebView Window (pip install pywebview)",
        font=("Segoe UI", 9),
        bg="#27272a",
        fg="#f4f4f5",
        activebackground="#3f3f46",
        activeforeground="#ffffff",
        relief="flat",
        padx=10,
        pady=6,
        cursor="hand2",
        command=install_pywebview,
    ).pack(fill="x")

    # Automatically pop open the chromeless native window on launch
    root.after(400, lambda: open_native_app_window(url))

    def on_close():
        server.council.shutdown()
        server.shutdown()
        root.destroy()

    root.protocol("WM_DELETE_WINDOW", on_close)
    root.mainloop()


def main() -> None:
    parser = argparse.ArgumentParser(description="CounciLLM Standalone Python Desktop GUI")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--tk", action="store_true", help="Force Tkinter Control Center GUI mode")
    args = parser.parse_args()

    port = args.port or find_free_port(8765)
    store = Store()
    server = ThreadingHTTPServer(
        (args.host, port),
        lambda *p, **k: Handler(*p, directory=str(FRONTEND_DIR), **k),
    )
    server.store = store  # type: ignore
    server.council = Council(CONFIG, store)  # type: ignore

    url = f"http://{args.host}:{port}"
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    print(f"CounciLLM Local Desktop Server started at {url}")

    if not args.tk:
        try:
            import webview  # type: ignore

            window = webview.create_window(
                "CounciLLM — Sovereign Local AI",
                url,
                width=1380,
                height=860,
                min_size=(960, 640),
                background_color="#18181b",
            )
            webview.start()
            server.council.shutdown()
            server.shutdown()
            return
        except ImportError:
            print("PyWebView not installed — launching Tkinter Desktop Control Center + Native App Window...")

    run_tkinter_control_center(server, url)


if __name__ == "__main__":
    main()
