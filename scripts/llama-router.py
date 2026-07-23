#!/usr/bin/env python3
"""
llama-router: a tiny OpenAI-compatible router in front of several llama-server
(llama.cpp) instances, each of which serves ONE model on its own port.

It merges every backend's GET /v1/models and forwards chat/completions requests
to the backend that serves the requested model. Standard library only, no deps,
and it never touches the running servers (no reload, no unload).

Point Overleaf at the router instead of a single server:
    LLM_API_URL=http://<router-host>:18090/v1

Config via environment variables:
    LLAMA_BACKENDS       comma-separated OpenAI-compatible base URLs, each ending in /v1
                         default: http://127.0.0.1:18080/v1,http://127.0.0.1:18081/v1
    ROUTER_HOST          bind address (default 0.0.0.0)
    ROUTER_PORT          bind port    (default 18090)
    MODELS_TTL           seconds to cache the model->backend map (default 30)
    PROXY_TIMEOUT        seconds to wait for a backend response (default 3600). A
                         CPU compliance review of a large document is dominated by
                         prompt processing and can take tens of minutes.
    EARLY_RESPONSE_WAIT  seconds to wait for the backend before committing an early
                         "200 + chunked" response and starting the heartbeat
                         (default 240). Must stay below the client's header timeout.
    HEARTBEAT_INTERVAL   seconds between heartbeat chunks once the early response is
                         committed (default 30). Must stay below the client's idle
                         body timeout.
    CHAT_TEMPLATE_KWARGS optional JSON object injected into completion requests that
                         do not carry their own chat_template_kwargs, e.g.
                         {"enable_thinking": false} to turn off a reasoning model's
                         internal thinking (which on a CPU backend otherwise eats the
                         whole answer-token budget and slows every request). Empty or
                         invalid = no injection. Only reaches the local llama-server.

Routing: the request's "model" field decides the backend. Unknown model names
(and the placeholder "default") fall back to the first reachable backend, which
is fine for llama-server because it ignores the model name and serves whatever it
has loaded. Unreachable backends are skipped, not fatal.

Note: requests are proxied as a single request/response (the Overleaf module is
non-streaming). If a client sets stream=true the SSE body is returned in one shot
rather than incrementally.

Slow-response handling: Node/undici (the Overleaf module's fetch) aborts at 300s
if it receives no response headers (HeadersTimeoutError), and again on an idle
body, regardless of any longer server-side timeout. A plain blocking proxy sends
nothing until the backend finishes, so long reviews die at 300s even with a large
PROXY_TIMEOUT. To avoid that, if the backend has not answered within
EARLY_RESPONSE_WAIT the router commits "200 + Transfer-Encoding: chunked" up front
and emits a whitespace chunk every HEARTBEAT_INTERVAL until the real body is ready
(leading whitespace is valid JSON, so it does not corrupt the parsed response).
Fast requests (chat, inline completion, connection test) answer well within
EARLY_RESPONSE_WAIT and take the verbatim path, status code included.
"""

import json
import os
import queue
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BACKENDS = [
    b.strip().rstrip("/")
    for b in os.environ.get(
        "LLAMA_BACKENDS",
        "http://127.0.0.1:18080/v1,http://127.0.0.1:18081/v1",
    ).split(",")
    if b.strip()
]
HOST = os.environ.get("ROUTER_HOST", "0.0.0.0")
PORT = int(os.environ.get("ROUTER_PORT", "18090"))
TTL = int(os.environ.get("MODELS_TTL", "30"))
PROXY_TIMEOUT = int(os.environ.get("PROXY_TIMEOUT", "3600"))  # backend response cap
EARLY_RESPONSE_WAIT = int(os.environ.get("EARLY_RESPONSE_WAIT", "240"))  # commit 200 by now
HEARTBEAT_INTERVAL = int(os.environ.get("HEARTBEAT_INTERVAL", "30"))  # between heartbeats
SCAN_TIMEOUT = 10  # seconds; querying /models

# Optional default chat_template_kwargs injected into completion requests that do
# not carry their own (a JSON object, e.g. {"enable_thinking": false}). Only the
# local llama-server understands this field; cloud backends (per-user OpenAI /
# Anthropic keys) are called directly by the module, not through the router, so
# they are never affected. Empty/invalid = no injection.
_DEFAULT_CHAT_TEMPLATE_KWARGS = None
_ctk_raw = os.environ.get("CHAT_TEMPLATE_KWARGS", "").strip()
if _ctk_raw:
    try:
        _DEFAULT_CHAT_TEMPLATE_KWARGS = json.loads(_ctk_raw)
        if not isinstance(_DEFAULT_CHAT_TEMPLATE_KWARGS, dict):
            raise ValueError("must be a JSON object")
    except Exception as _exc:
        print(f"[router] ignoring invalid CHAT_TEMPLATE_KWARGS ({_exc})", flush=True)
        _DEFAULT_CHAT_TEMPLATE_KWARGS = None

_lock = threading.Lock()
_cache = {"ts": 0.0, "map": {}, "models": []}  # map: model_id -> backend base url


def _fetch_model_ids(backend):
    req = urllib.request.Request(backend + "/models", method="GET")
    with urllib.request.urlopen(req, timeout=SCAN_TIMEOUT) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return [
        m["id"]
        for m in data.get("data", [])
        if isinstance(m, dict) and isinstance(m.get("id"), str)
    ]


def _refresh(force=False):
    with _lock:
        if not force and _cache["map"] and (time.time() - _cache["ts"] < TTL):
            return _cache
        mmap, models = {}, []
        for backend in BACKENDS:
            try:
                ids = _fetch_model_ids(backend)
            except Exception as exc:  # unreachable backend: skip, do not fail
                print(f"[router] skipping unreachable backend {backend} ({exc})", flush=True)
                continue
            for mid in ids:
                if mid not in mmap:  # first backend wins on a duplicate id
                    mmap[mid] = backend
                    models.append({"id": mid, "object": "model", "owned_by": backend})
        _cache.update(ts=time.time(), map=mmap, models=models)
        return _cache


def _pick_backend(model):
    cache = _refresh()
    if model and model in cache["map"]:
        return cache["map"][model]
    # cache miss: refresh once in case a server just came up
    cache = _refresh(force=True)
    if model and model in cache["map"]:
        return cache["map"][model]
    # fallback: first reachable backend (documented behavior)
    for backend in BACKENDS:
        try:
            _fetch_model_ids(backend)
            print(f"[router] model {model!r} not found; falling back to {backend}", flush=True)
            return backend
        except Exception:
            continue
    return None


def _proxy_worker(url, raw, headers, q):
    """Run the (blocking, non-streaming) backend call and post one result to q:
    ("ok", status, ctype, body)  - a real HTTP response, including 4xx/5xx from the
                                   backend (delivered with its own status on the fast
                                   path; delivered as-is under the early 200 otherwise)
    ("err", message)             - a connection-level failure (-> 502 on the fast path)
    """
    req = urllib.request.Request(url, data=raw, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=PROXY_TIMEOUT) as resp:
            q.put(("ok", resp.status, resp.headers.get("Content-Type", "application/json"), resp.read()))
    except urllib.error.HTTPError as exc:
        q.put(("ok", exc.code, exc.headers.get("Content-Type", "application/json"), exc.read()))
    except Exception as exc:
        q.put(("err", str(exc)))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code, body, ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _begin_chunked(self, ctype="application/json"):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

    def _write_chunk(self, data):
        # Returns False if the client has gone away, so the caller can stop.
        if not data:
            return True
        try:
            self.wfile.write(b"%X\r\n" % len(data) + data + b"\r\n")
            self.wfile.flush()
            return True
        except (BrokenPipeError, ConnectionResetError):
            print("[router] client disconnected during chunked response", flush=True)
            return False

    def _end_chunked(self):
        try:
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            cache = _refresh()
            body = json.dumps({"object": "list", "data": cache["models"]}).encode("utf-8")
            return self._send(200, body)
        self._send(404, b'{"error":"not found"}')

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            payload = {}
        backend = _pick_backend(payload.get("model"))
        if not backend:
            return self._send(503, b'{"error":"no backend reachable"}')

        # keep the path after /v1 (e.g. /chat/completions, /completions)
        idx = self.path.find("/v1/")
        suffix = self.path[idx + len("/v1"):] if idx >= 0 else self.path

        # llama.cpp serves /tokenize (and /detokenize) at the SERVER ROOT, not under
        # /v1, but a client that only knows the OpenAI-style base URL can only address
        # them as <base>/v1/tokenize. Map those two back to the root so the Overleaf
        # module can ask for an exact token count without being taught a second URL.
        if suffix in ("/tokenize", "/detokenize"):
            root = backend[: -len("/v1")] if backend.endswith("/v1") else backend
            url = root.rstrip("/") + suffix
        else:
            url = backend + suffix

        # Inject the default chat_template_kwargs into completion requests that do
        # not set their own, then re-serialize (urllib recomputes Content-Length).
        if (
            _DEFAULT_CHAT_TEMPLATE_KWARGS is not None
            and isinstance(payload, dict)
            and "completions" in suffix
            and "chat_template_kwargs" not in payload
        ):
            payload["chat_template_kwargs"] = _DEFAULT_CHAT_TEMPLATE_KWARGS
            raw = json.dumps(payload).encode("utf-8")

        headers = {"Content-Type": "application/json"}
        auth = self.headers.get("Authorization")
        if auth:  # forward auth so a keyless local + an authenticated remote can coexist
            headers["Authorization"] = auth

        # Run the backend call in a worker thread so we can start heartbeating if it
        # is slow. The worker posts exactly one result (the module is non-streaming).
        q = queue.Queue()
        threading.Thread(target=_proxy_worker, args=(url, raw, headers, q), daemon=True).start()

        # Fast path: if the backend answers within EARLY_RESPONSE_WAIT, forward it
        # verbatim (status code included), exactly as a plain proxy would.
        try:
            result = q.get(timeout=EARLY_RESPONSE_WAIT)
        except queue.Empty:
            result = None
        if result is not None:
            kind = result[0]
            if kind == "ok":
                _, status, ctype, body = result
                return self._send(status, body, ctype)
            print(f"[router] proxy error to {url}: {result[1]}", flush=True)
            return self._send(502, json.dumps({"error": result[1]}).encode("utf-8"))

        # Slow path: nothing yet. Commit "200 + chunked" now (so undici sees response
        # headers before its 300s deadline) and heartbeat until the body is ready.
        self._begin_chunked()
        while True:
            try:
                result = q.get(timeout=HEARTBEAT_INTERVAL)
            except queue.Empty:
                if not self._write_chunk(b" "):  # heartbeat; leading whitespace is valid JSON
                    return
                continue
            if result[0] == "ok":
                _, status, _ctype, body = result
                if status >= 400:
                    print(f"[router] late backend error {status} from {url}", flush=True)
                self._write_chunk(body)
            else:
                print(f"[router] late proxy error to {url}: {result[1]}", flush=True)
                self._write_chunk(json.dumps({"error": result[1]}).encode("utf-8"))
            self._end_chunked()
            return

    def log_message(self, *args):
        pass  # silence the default per-request logging


def main():
    if not BACKENDS:
        raise SystemExit("[router] LLAMA_BACKENDS is empty; set at least one backend URL")
    print(f"[router] backends: {BACKENDS}", flush=True)
    print(f"[router] listening on http://{HOST}:{PORT}/v1", flush=True)
    _refresh(force=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
