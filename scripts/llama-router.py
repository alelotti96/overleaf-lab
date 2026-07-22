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
    LLAMA_BACKENDS   comma-separated OpenAI-compatible base URLs, each ending in /v1
                     default: http://127.0.0.1:18080/v1,http://127.0.0.1:18081/v1
    ROUTER_HOST      bind address (default 0.0.0.0)
    ROUTER_PORT      bind port    (default 18090)
    MODELS_TTL       seconds to cache the model->backend map (default 30)

Routing: the request's "model" field decides the backend. Unknown model names
(and the placeholder "default") fall back to the first reachable backend, which
is fine for llama-server because it ignores the model name and serves whatever it
has loaded. Unreachable backends are skipped, not fatal.

Note: requests are proxied as a single request/response (the Overleaf module is
non-streaming). If a client sets stream=true the SSE body is returned in one shot
rather than incrementally.
"""

import json
import os
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
PROXY_TIMEOUT = 300  # seconds; chat can be slow on CPU
SCAN_TIMEOUT = 10  # seconds; querying /models

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


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code, body, ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

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
        url = backend + suffix

        headers = {"Content-Type": "application/json"}
        auth = self.headers.get("Authorization")
        if auth:  # forward auth so a keyless local + an authenticated remote can coexist
            headers["Authorization"] = auth

        req = urllib.request.Request(url, data=raw, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=PROXY_TIMEOUT) as resp:
                return self._send(
                    resp.status, resp.read(), resp.headers.get("Content-Type", "application/json")
                )
        except urllib.error.HTTPError as exc:
            return self._send(
                exc.code, exc.read(), exc.headers.get("Content-Type", "application/json")
            )
        except Exception as exc:
            print(f"[router] proxy error to {url}: {exc}", flush=True)
            return self._send(502, json.dumps({"error": str(exc)}).encode("utf-8"))

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
