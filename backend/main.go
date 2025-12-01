package main

import (
	"log"
	"os"
	"os/signal"
	"syscall"

	"webtorrent-player/handlers"
	"webtorrent-player/torrent"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
)

func main() {
	// Criar diretório de downloads
	if err := os.MkdirAll("./downloads", 0755); err != nil {
		log.Fatal("Erro ao criar diretório de downloads:", err)
	}

	// Inicializar cliente de torrent
	if err := torrent.InitClient(); err != nil {
		log.Fatal("Erro ao inicializar cliente de torrent:", err)
	}
	defer torrent.CloseClient()

	// Configurar Gin
	gin.SetMode(gin.ReleaseMode)
	r := gin.Default()

	// Configurar CORS - permitir qualquer origem
	r.Use(cors.New(cors.Config{
		AllowOrigins:     []string{"*"},
		AllowMethods:     []string{"GET", "POST", "DELETE", "OPTIONS"},
		AllowHeaders:     []string{"Origin", "Content-Type", "Accept"},
		AllowCredentials: false,
	}))

	// Rotas da API
	api := r.Group("/api")
	{
		api.POST("/stream", handlers.StartStream)
		api.GET("/stream/:id/status", handlers.GetStreamStatus)
		// Master playlist (ABR)
		api.GET("/stream/:id/master.m3u8", handlers.GetPlaylist)
		// Playlist de qualidade específica
		api.GET("/stream/:id/:quality/playlist.m3u8", handlers.GetQualityPlaylist)
		// Segmentos de qualidade específica (usando * para capturar subpath)
		api.GET("/stream/:id/:quality/:segment", handlers.GetQualitySegment)
		api.DELETE("/stream/:id", handlers.StopStream)
	}

	// Servir arquivos HLS
	r.Static("/hls", "./downloads")

	// Graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		<-quit
		log.Println("Encerrando servidor...")
		torrent.CleanupAll()
	}()

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	log.Printf("Servidor rodando em http://localhost:%s", port)
	if err := r.Run(":" + port); err != nil {
		log.Fatal("Erro ao iniciar servidor:", err)
	}
}
