package handlers

import (
	"net/http"
	"os"
	"path/filepath"
	"time"

	"webtorrent-player/torrent"

	"github.com/gin-gonic/gin"
)

type StreamRequest struct {
	Input string `json:"input" binding:"required"` // Magnet link ou hash
}

type StreamResponse struct {
	ID      string `json:"id"`
	Message string `json:"message"`
}

// StartStream inicia um novo stream de torrent
func StartStream(c *gin.Context) {
	var req StreamRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Input é obrigatório (magnet link ou hash)"})
		return
	}

	// Converter hash para magnet link se necessário
	magnetLink := torrent.ParseInput(req.Input)

	stream, err := torrent.StartStream(magnetLink)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, StreamResponse{
		ID:      stream.ID,
		Message: "Stream iniciado com sucesso",
	})
}

// GetStreamStatus retorna o status de um stream
func GetStreamStatus(c *gin.Context) {
	id := c.Param("id")

	stream, ok := torrent.GetStream(id)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "Stream não encontrado"})
		return
	}

	peers, downloaded, speed := stream.GetPeerStats()
	
	c.JSON(http.StatusOK, gin.H{
		"id":           stream.ID,
		"status":       stream.Status,
		"progress":     stream.Progress,
		"fileName":     stream.FileName,
		"error":        stream.Error,
		"peers":        peers,
		"downloaded":   downloaded,   // Total baixado em MB
		"speed":        speed,        // Velocidade instantânea em MB/s
		"qualities":    stream.Qualities,
		"sourceWidth":  stream.SourceWidth,
		"sourceHeight": stream.SourceHeight,
		"hlsUrl":       "/api/stream/" + stream.ID + "/master.m3u8",
	})
}

// GetPlaylist retorna a playlist HLS (master ou de qualidade específica)
func GetPlaylist(c *gin.Context) {
	id := c.Param("id")

	stream, ok := torrent.GetStream(id)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "Stream não encontrado"})
		return
	}

	if stream.Status != "ready" && stream.Status != "transcoding" {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Stream ainda não está pronto"})
		return
	}

	// Tentar master playlist primeiro
	playlistPath := filepath.Join(stream.HLSPath, "master.m3u8")
	
	if _, err := os.Stat(playlistPath); os.IsNotExist(err) {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Playlist ainda não gerada"})
		return
	}

	c.Header("Content-Type", "application/vnd.apple.mpegurl")
	c.Header("Cache-Control", "no-cache")
	c.File(playlistPath)
}

// GetQualityPlaylist retorna a playlist de uma qualidade específica
func GetQualityPlaylist(c *gin.Context) {
	id := c.Param("id")
	quality := c.Param("quality")

	stream, ok := torrent.GetStream(id)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "Stream não encontrado"})
		return
	}

	playlistPath := filepath.Join(stream.HLSPath, quality, "playlist.m3u8")

	// IMPORTANTE: o master.m3u8 é gerado antes das playlists de cada qualidade.
	// O Shaka tende a solicitar TODAS as playlists listadas no master durante o load.
	// Se retornarmos 404 cedo demais, o load falha. Então, aguardamos o arquivo existir.
	// (Nginx está com proxy_read_timeout=300s, então segurar a conexão aqui é ok.)
	deadline := time.Now().Add(90 * time.Second)
	for {
		if _, err := os.Stat(playlistPath); err == nil {
			break
		}

		if stream.Status == "error" {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Stream em erro"})
			return
		}

		if time.Now().After(deadline) {
			c.JSON(http.StatusNotFound, gin.H{"error": "Playlist da qualidade ainda não foi gerada"})
			return
		}

		select {
		case <-c.Request.Context().Done():
			return
		case <-time.After(500 * time.Millisecond):
		}
	}

	c.Header("Content-Type", "application/vnd.apple.mpegurl")
	c.Header("Cache-Control", "no-cache")
	c.File(playlistPath)
}

// GetSegment retorna um segmento HLS
func GetSegment(c *gin.Context) {
	id := c.Param("id")
	segment := c.Param("segment")

	stream, ok := torrent.GetStream(id)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "Stream não encontrado"})
		return
	}

	// Verificar se é um segmento de qualidade específica (ex: 720p/segment001.ts)
	segmentPath := filepath.Join(stream.HLSPath, segment)

	// Evitar servir segmento enquanto ainda está sendo escrito (arquivo parcial)
	if !waitForStableFile(c, segmentPath, 30*time.Second, 200*time.Millisecond) {
		return
	}

	c.Header("Content-Type", "video/mp2t")
	c.Header("Cache-Control", "max-age=3600")
	c.File(segmentPath)
}

// GetQualitySegment retorna um segmento de qualidade específica
func GetQualitySegment(c *gin.Context) {
	id := c.Param("id")
	quality := c.Param("quality")
	segment := c.Param("segment")

	stream, ok := torrent.GetStream(id)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "Stream não encontrado"})
		return
	}

	segmentPath := filepath.Join(stream.HLSPath, quality, segment)

	// Evitar servir segmento enquanto ainda está sendo escrito (arquivo parcial)
	if !waitForStableFile(c, segmentPath, 30*time.Second, 200*time.Millisecond) {
		return
	}

	c.Header("Content-Type", "video/mp2t")
	c.Header("Cache-Control", "max-age=3600")
	c.File(segmentPath)
}

// waitForStableFile aguarda um arquivo existir e ficar com tamanho estável por um curto período.
// Retorna false se já respondeu ao cliente (404/timeout/cancel).
func waitForStableFile(c *gin.Context, path string, timeout time.Duration, stableWindow time.Duration) bool {
	deadline := time.Now().Add(timeout)
	var lastSize int64 = -1
	var lastStableAt time.Time

	for {
		select {
		case <-c.Request.Context().Done():
			return false
		default:
		}

		info, err := os.Stat(path)
		if err != nil {
			if os.IsNotExist(err) {
				if time.Now().After(deadline) {
					c.JSON(http.StatusNotFound, gin.H{"error": "Segmento não encontrado"})
					return false
				}
				select {
				case <-c.Request.Context().Done():
					return false
				case <-time.After(100 * time.Millisecond):
				}
				continue
			}

			c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao acessar segmento"})
			return false
		}

		size := info.Size()
		if size == lastSize {
			if lastStableAt.IsZero() {
				lastStableAt = time.Now()
			}
			if time.Since(lastStableAt) >= stableWindow {
				return true
			}
		} else {
			lastSize = size
			lastStableAt = time.Time{}
		}

		if time.Now().After(deadline) {
			c.JSON(http.StatusGatewayTimeout, gin.H{"error": "Timeout aguardando segmento"})
			return false
		}

		select {
		case <-c.Request.Context().Done():
			return false
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// StopStream para e limpa um stream
func StopStream(c *gin.Context) {
	id := c.Param("id")

	err := torrent.StopStream(id)
	if err != nil {
		// Retornar sucesso mesmo se não encontrado (idempotente)
		// Isso evita erros quando o stream já foi removido
		c.JSON(http.StatusOK, gin.H{"message": "Stream já foi removido ou não existe"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Stream removido com sucesso"})
}
