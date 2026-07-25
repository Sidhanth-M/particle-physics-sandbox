"""
Static dev server with caching disabled.

Python's stock http.server sends Last-Modified but no Cache-Control, so
browsers apply *heuristic* freshness: a file that has sat unchanged for hours
gets cached for a long time and is never revalidated. During development that
shows up as an edit silently not taking effect — the module loader keeps
serving a stale copy while a plain fetch of the same file returns the new one.
"""

import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # keep the console usable


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f"Serving http://localhost:{port}  (self-checks: /?selfcheck)")
    ThreadingHTTPServer(("127.0.0.1", port), NoCacheHandler).serve_forever()
