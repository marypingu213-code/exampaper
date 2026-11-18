#!/bin/bash
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "請先安裝 Node.js：https://nodejs.org （選 LTS 版）"; read; exit 1; }
[ -d node_modules ] || npm install
(sleep 1; open http://localhost:8080/host) &
node server.js
