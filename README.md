# WebTorrent Player

Player de vídeo para torrents no navegador web. Similar ao VLC, mas roda diretamente no browser.

## Arquitetura

- **Backend (Go)**: Baixa torrents usando anacrolix/torrent e transcodifica para HLS com FFmpeg
- **Frontend (React)**: Interface simples com player HLS.js

## Requisitos

- Docker e Docker Compose
- **OU** para desenvolvimento local:
  - Go 1.21+
  - Node.js 18+
  - FFmpeg

## Executar com Docker

```bash
docker-compose up --build
```

Acesse: http://localhost:3000

## Desenvolvimento Local

### Backend

```bash
cd backend
go mod tidy
go run .
```

O servidor roda em http://localhost:8080

### Frontend

```bash
cd frontend
npm install
npm run dev
```

O frontend roda em http://localhost:5173 (com proxy para o backend)

## Como Usar

1. Cole um **magnet link** ou **hash de torrent** (40 caracteres)
2. Clique em "Reproduzir"
3. Aguarde o download iniciar (exibe progresso)
4. O vídeo começa a tocar automaticamente quando pronto
5. Ao fechar a página, os arquivos são deletados automaticamente

## Exemplos de Entrada

**Hash de torrent:**
```
08ada5a7a6183aae1e09d831df6748d566095a10
```

**Magnet link:**
```
magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10
```

## API

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| POST | `/api/stream` | Inicia um novo stream (body: `{ "input": "magnet ou hash" }`) |
| GET | `/api/stream/:id/status` | Status do stream |
| GET | `/api/stream/:id/playlist.m3u8` | Playlist HLS |
| DELETE | `/api/stream/:id` | Para e remove o stream |

## Tecnologias

- **Go** - Backend
- **anacrolix/torrent** - Cliente BitTorrent
- **FFmpeg** - Transcodificação para HLS
- **React** - Frontend
- **HLS.js** - Player de vídeo HLS
- **Tailwind CSS** - Estilos
- **Docker** - Containerização

## Licença

MIT
