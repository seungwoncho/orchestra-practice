"""
로컬 개발 서버.
  python3 serve.py
실행하면 이 파일이 있는 폴더를 http://localhost:8000 으로 띄운다.
(http.server 기본 모듈이 데스크톱 폴더에서 막히는 걸 우회하려고 직접 만든 버전)
"""
import http.server
import socketserver
import functools
import os

PORT = 8000
DIR = os.path.dirname(os.path.abspath(__file__))

Handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=DIR)


class Server(socketserver.TCPServer):
    allow_reuse_address = True


with Server(("127.0.0.1", PORT), Handler) as httpd:
    print(f"Serving {DIR}")
    print(f"→ http://localhost:{PORT}")
    httpd.serve_forever()
