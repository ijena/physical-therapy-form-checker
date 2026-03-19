from flask import Flask, send_from_directory, request, Response, jsonify
import os
import requests

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(BASE_DIR, "src", "frontend")

app = Flask(
    __name__,
    static_folder=FRONTEND_DIR,
    static_url_path=""
)

@app.get("/")
def serve_index():
    return send_from_directory(FRONTEND_DIR, "index.html")

@app.post("/ollama/chat")
def ollama_chat():
    try:
        r = requests.post(
            "http://127.0.0.1:11434/api/chat",
            json=request.get_json(silent=True),
            timeout=120
        )
        return Response(
            r.text,
            status=r.status_code,
            content_type=r.headers.get("Content-Type", "application/json")
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.get("/<path:path>")
def serve_static(path):
    file_path = os.path.join(FRONTEND_DIR, path)
    if os.path.isfile(file_path):
        return send_from_directory(FRONTEND_DIR, path)
    return send_from_directory(FRONTEND_DIR, "index.html")

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 3000))
    print(f"✅ FormCheck running at http://localhost:{port}")
    print(f"📁 Serving static files from: {FRONTEND_DIR}")
    app.run(host="0.0.0.0", port=port, debug=True)