#!/bin/sh
# game 브랜치 화면+API를 시험용 주소(manito-dev)로 올린다
cd "$(dirname "$0")" && rm -rf public-dev && mkdir public-dev && cp ../index.html public-dev/ && npx wrangler deploy -c wrangler.dev.toml
