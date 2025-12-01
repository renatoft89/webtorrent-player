package torrent

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/anacrolix/torrent"
	"github.com/google/uuid"
)

var (
	client     *torrent.Client
	streams    = make(map[string]*StreamInfo)
	mu         sync.RWMutex
	maxStreams = 2 // Máximo de streams simultâneos
)

type StreamInfo struct {
	ID           string    `json:"id"`
	MagnetLink   string    `json:"magnetLink"`
	Status       string    `json:"status"` // downloading, transcoding, ready, error
	Progress     float64   `json:"progress"`
	FileName     string    `json:"fileName"`
	VideoFile    string    `json:"videoFile"`
	HLSPath      string    `json:"hlsPath"`
	Error        string    `json:"error,omitempty"`
	Peers        int       `json:"peers"`
	DownloadRate float64   `json:"downloadRate"` // bytes por segundo
	CreatedAt    time.Time `json:"createdAt"`
	torrent      *torrent.Torrent
	cancelChan   chan struct{}
}

// GetPeerStats retorna estatísticas de peers do torrent
func (s *StreamInfo) GetPeerStats() (int, float64) {
	if s.torrent == nil {
		return 0, 0
	}
	stats := s.torrent.Stats()
	return stats.ActivePeers, float64(stats.BytesReadData.Int64()) / 1024 / 1024 // MB
}

func InitClient() error {
	cfg := torrent.NewDefaultClientConfig()
	cfg.DataDir = "./downloads"
	cfg.NoUpload = true
	cfg.Seed = false
	cfg.DisableIPv6 = true

	var err error
	client, err = torrent.NewClient(cfg)
	if err != nil {
		return fmt.Errorf("erro ao criar cliente torrent: %w", err)
	}

	log.Println("Cliente torrent inicializado")
	return nil
}

func CloseClient() {
	if client != nil {
		client.Close()
	}
}

// ParseInput converte hash ou magnet link para magnet link completo
func ParseInput(input string) string {
	input = strings.TrimSpace(input)
	
	// Se já é um magnet link, retorna como está
	if strings.HasPrefix(input, "magnet:") {
		return input
	}
	
	// Se é um hash (40 caracteres hexadecimais), converte para magnet link
	if len(input) == 40 && isHex(input) {
		trackers := []string{
			"udp://tracker.opentrackr.org:1337/announce",
			"udp://open.demonii.com:1337/announce",
			"udp://tracker.openbittorrent.com:6969/announce",
			"udp://exodus.desync.com:6969/announce",
		}
		magnetLink := fmt.Sprintf("magnet:?xt=urn:btih:%s", input)
		for _, tracker := range trackers {
			magnetLink += "&tr=" + tracker
		}
		return magnetLink
	}
	
	return input
}

func isHex(s string) bool {
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

func StartStream(magnetLink string) (*StreamInfo, error) {
	streamID := uuid.New().String()
	
	stream := &StreamInfo{
		ID:         streamID,
		MagnetLink: magnetLink,
		Status:     "downloading",
		Progress:   0,
		CreatedAt:  time.Now(),
		cancelChan: make(chan struct{}),
	}
	
	mu.Lock()
	
	// Se já temos o máximo de streams, remover o mais antigo
	if len(streams) >= maxStreams {
		var oldestID string
		var oldestTime time.Time
		
		for id, s := range streams {
			if oldestID == "" || s.CreatedAt.Before(oldestTime) {
				oldestID = id
				oldestTime = s.CreatedAt
			}
		}
		
		if oldestID != "" {
			oldStream := streams[oldestID]
			log.Printf("[%s] Removendo stream antigo para liberar espaço (limite: %d)", oldestID[:8], maxStreams)
			
			// Fechar canal de cancelamento de forma segura
			select {
			case <-oldStream.cancelChan:
				// Já está fechado
			default:
				close(oldStream.cancelChan)
			}
			
			// Remover torrent
			if oldStream.torrent != nil {
				oldStream.torrent.Drop()
			}
			
			// Limpar arquivos do stream antigo
			hlsDir := filepath.Join("./downloads", oldestID)
			os.RemoveAll(hlsDir)
			
			// Limpar também o diretório do torrent se existir
			if oldStream.VideoFile != "" {
				// Pegar o diretório pai do arquivo de vídeo (pasta do torrent)
				torrentDir := filepath.Dir(oldStream.VideoFile)
				if torrentDir != "./downloads" && torrentDir != "downloads" {
					os.RemoveAll(torrentDir)
				}
			}
			
			delete(streams, oldestID)
			log.Printf("[%s] Stream antigo removido com sucesso", oldestID[:8])
		}
	}
	
	streams[streamID] = stream
	mu.Unlock()
	
	// Iniciar download em goroutine
	go downloadAndTranscode(stream)
	
	return stream, nil
}

func downloadAndTranscode(stream *StreamInfo) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("Panic recuperado em downloadAndTranscode: %v", r)
			stream.Status = "error"
			stream.Error = fmt.Sprintf("Erro interno: %v", r)
		}
	}()

	// Adicionar torrent
	t, err := client.AddMagnet(stream.MagnetLink)
	if err != nil {
		stream.Status = "error"
		stream.Error = fmt.Sprintf("Erro ao adicionar magnet: %v", err)
		return
	}
	stream.torrent = t

	log.Printf("[%s] Aguardando metadados do torrent...", stream.ID[:8])

	// Aguardar metadados com timeout
	select {
	case <-t.GotInfo():
		log.Printf("[%s] Metadados recebidos: %s", stream.ID[:8], t.Name())
	case <-time.After(60 * time.Second):
		stream.Status = "error"
		stream.Error = "Timeout ao obter metadados do torrent"
		return
	case <-stream.cancelChan:
		return
	}

	// Encontrar arquivo de vídeo
	var videoFile *torrent.File
	videoExtensions := []string{".mp4", ".mkv", ".avi", ".mov", ".wmv", ".webm"}
	
	for _, file := range t.Files() {
		for _, ext := range videoExtensions {
			if strings.HasSuffix(strings.ToLower(file.Path()), ext) {
				if videoFile == nil || file.Length() > videoFile.Length() {
					videoFile = file
				}
			}
		}
	}

	if videoFile == nil {
		stream.Status = "error"
		stream.Error = "Nenhum arquivo de vídeo encontrado no torrent"
		return
	}

	stream.FileName = filepath.Base(videoFile.Path())
	// O anacrolix/torrent baixa para ./downloads/NOME_DO_TORRENT/arquivo
	// O videoFile.Path() já contém o caminho completo desde a raiz do torrent
	stream.VideoFile = filepath.Join("./downloads", videoFile.Path())
	
	log.Printf("[%s] Baixando: %s (%.2f MB)", stream.ID[:8], stream.FileName, float64(videoFile.Length())/1024/1024)
	log.Printf("[%s] Caminho do arquivo: %s", stream.ID[:8], stream.VideoFile)

	// Configurar download sequencial para priorizar o início do arquivo
	// Isso é importante para que o FFmpeg consiga ler os headers do vídeo
	t.SetDisplayName(stream.FileName)
	
	// Priorizar as primeiras peças do arquivo (headers)
	// Baixar primeiros 5% primeiro para garantir headers
	initialBytes := videoFile.Length() / 20 // 5%
	if initialBytes < 10*1024*1024 {
		initialBytes = 10 * 1024 * 1024 // Mínimo 10MB
	}
	videoFile.Download()

	// Monitorar progresso do download
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	
	transcodeStarted := false

	for {
		select {
		case <-stream.cancelChan:
			return
		case <-ticker.C:
			bytesCompleted := videoFile.BytesCompleted()
			totalBytes := videoFile.Length()
			progress := float64(bytesCompleted) / float64(totalBytes) * 100
			stream.Progress = progress
			
			log.Printf("[%s] Progresso: %.1f%% (%.2f/%.2f MB)", 
				stream.ID[:8], progress, 
				float64(bytesCompleted)/1024/1024, 
				float64(totalBytes)/1024/1024)

			// Se baixou o suficiente para iniciar transcodificação
			// Aguardar pelo menos 100MB ou 10% para garantir que headers foram baixados
			minBytes := int64(100 * 1024 * 1024) // 100MB mínimo
			if (progress >= 10 || bytesCompleted >= minBytes) && !transcodeStarted && stream.Status == "downloading" {
				// Verificar se arquivo existe e tem tamanho razoável
				if info, err := os.Stat(stream.VideoFile); err == nil && info.Size() > 10*1024*1024 {
					log.Printf("[%s] Arquivo disponível com %.2f MB, iniciando transcodificação...", 
						stream.ID[:8], float64(info.Size())/1024/1024)
					transcodeStarted = true
					stream.Status = "transcoding"
					go transcodeToHLS(stream)
				}
			}

			// Se download completo
			if bytesCompleted >= totalBytes {
				log.Printf("[%s] Download completo!", stream.ID[:8])
				return
			}
		}
	}
}

func transcodeToHLS(stream *StreamInfo) {
	hlsDir := filepath.Join("./downloads", stream.ID, "hls")
	if err := os.MkdirAll(hlsDir, 0755); err != nil {
		stream.Status = "error"
		stream.Error = fmt.Sprintf("Erro ao criar diretório HLS: %v", err)
		return
	}

	stream.HLSPath = hlsDir
	playlistPath := filepath.Join(hlsDir, "playlist.m3u8")

	// Aguardar arquivo existir e ter tamanho mínimo
	for i := 0; i < 60; i++ {
		if info, err := os.Stat(stream.VideoFile); err == nil && info.Size() > 10*1024*1024 {
			break
		}
		time.Sleep(time.Second)
	}

	// Tentar transcodificação com retry
	maxRetries := 5
	for retry := 0; retry < maxRetries; retry++ {
		if retry > 0 {
			log.Printf("[%s] Tentativa %d de transcodificação...", stream.ID[:8], retry+1)
			time.Sleep(5 * time.Second) // Aguardar mais dados
		}

		log.Printf("[%s] Iniciando transcodificação HLS...", stream.ID[:8])

		// Comando FFmpeg para transcodificar para H.264 (compatível com todos os navegadores)
		// x265/HEVC não é suportado nativamente em Chrome/Firefox
		cmd := exec.Command("ffmpeg",
			"-y",
			"-fflags", "+genpts+igndts+discardcorrupt",
			"-err_detect", "ignore_err",
			"-analyzeduration", "10000000",
			"-probesize", "50000000",
			"-i", stream.VideoFile,
			"-c:v", "libx264",       // Sempre transcodificar para H.264
			"-preset", "veryfast",   // Preset rápido
			"-crf", "23",            // Qualidade boa
			"-c:a", "aac",
			"-b:a", "128k",
			"-ac", "2",              // Stereo
			"-hls_time", "4",
			"-hls_list_size", "0",
			"-hls_flags", "append_list+omit_endlist",
			"-hls_segment_type", "mpegts",
			"-start_number", "0",
			"-f", "hls",
			playlistPath,
		)

		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr

		if err := cmd.Start(); err != nil {
			log.Printf("[%s] Erro ao iniciar FFmpeg: %v", stream.ID[:8], err)
			continue
		}

		// Aguardar playlist ser criada (com timeout)
		playlistCreated := false
		for i := 0; i < 30; i++ {
			if _, err := os.Stat(playlistPath); err == nil {
				segmentCount := countSegments(hlsDir)
				if segmentCount >= 2 {
					playlistCreated = true
					stream.Status = "ready"
					log.Printf("[%s] Stream HLS pronto! (%d segmentos)", stream.ID[:8], segmentCount)
					break
				}
			}
			time.Sleep(time.Second)
		}

		if playlistCreated {
			// Sucesso! Aguardar FFmpeg terminar ou stream ser cancelado
			go func() {
				select {
				case <-stream.cancelChan:
					cmd.Process.Kill()
				}
			}()
			cmd.Wait()
			return
		}

		// Falhou, matar processo e tentar novamente
		cmd.Process.Kill()
		cmd.Wait()
		log.Printf("[%s] FFmpeg falhou, tentando novamente...", stream.ID[:8])
	}

	stream.Status = "error"
	stream.Error = "Falha ao transcodificar após múltiplas tentativas"
}

// countSegments conta quantos arquivos .ts existem no diretório
func countSegments(dir string) int {
	files, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	count := 0
	for _, f := range files {
		if strings.HasSuffix(f.Name(), ".ts") {
			count++
		}
	}
	return count
}

func GetStream(id string) (*StreamInfo, bool) {
	mu.RLock()
	defer mu.RUnlock()
	stream, ok := streams[id]
	return stream, ok
}

func StopStream(id string) error {
	mu.Lock()
	defer mu.Unlock()

	stream, ok := streams[id]
	if !ok {
		return fmt.Errorf("stream não encontrado")
	}

	// Sinalizar cancelamento
	close(stream.cancelChan)

	// Remover torrent
	if stream.torrent != nil {
		stream.torrent.Drop()
	}

	// Limpar arquivos
	hlsDir := filepath.Join("./downloads", id)
	os.RemoveAll(hlsDir)

	delete(streams, id)
	log.Printf("[%s] Stream removido", id[:8])

	return nil
}

func CleanupAll() {
	mu.Lock()
	defer mu.Unlock()

	for id, stream := range streams {
		close(stream.cancelChan)
		if stream.torrent != nil {
			stream.torrent.Drop()
		}
		hlsDir := filepath.Join("./downloads", id)
		os.RemoveAll(hlsDir)
	}

	// Limpar todos os arquivos do diretório de downloads
	entries, err := os.ReadDir("./downloads")
	if err == nil {
		for _, entry := range entries {
			if entry.Name() != ".torrent.bolt.db" { // Manter o banco de dados do torrent
				os.RemoveAll(filepath.Join("./downloads", entry.Name()))
			}
		}
	}

	streams = make(map[string]*StreamInfo)
	log.Println("Todos os streams e downloads foram limpos")
}

// GetStats retorna estatísticas dos streams e tamanho total
func GetStats() (int, int64) {
	mu.RLock()
	activeStreams := len(streams)
	mu.RUnlock()

	// Calcular tamanho total dos downloads
	var totalSize int64
	filepath.Walk("./downloads", func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if !info.IsDir() {
			totalSize += info.Size()
		}
		return nil
	})

	return activeStreams, totalSize
}
