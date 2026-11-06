"""One-origin development launcher, opening the browser after HTTP is ready."""
import argparse
import threading
import time
import urllib.request
import webbrowser

import uvicorn


def open_when_ready(port):
    url = f"http://127.0.0.1:{port}"
    for _ in range(60):
        try:
            with urllib.request.urlopen(url + "/api/health", timeout=1):
                webbrowser.open(url)
                return
        except OSError:
            time.sleep(0.25)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=3000)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    if not args.no_browser:
        threading.Thread(target=open_when_ready, args=(args.port,), daemon=True).start()
    uvicorn.run("api.index:app", host="127.0.0.1", port=args.port, reload=True)
