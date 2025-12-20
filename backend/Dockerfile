# Build stage
FROM golang:1.22-alpine AS builder

WORKDIR /app

# Instalar dependências do sistema
RUN apk add --no-cache gcc musl-dev

# Copiar arquivos de dependências
COPY go.mod ./
RUN go mod download || true

# Copiar código fonte
COPY . .

# Baixar dependências e build
RUN go mod tidy && CGO_ENABLED=0 GOOS=linux go build -o server .

# Runtime stage
FROM alpine:latest

WORKDIR /app

# Instalar FFmpeg com suporte a hardware acceleration (VAAPI)
RUN apk add --no-cache ffmpeg ca-certificates libva libva-intel-driver mesa-va-gallium

# Copiar binário
COPY --from=builder /app/server .

# Criar diretório de downloads
RUN mkdir -p /app/downloads

# Expor porta
EXPOSE 8080

# Executar
CMD ["./server"]
