package torrent

import (
	"context"
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

// QualityLevel define uma qualidade de vídeo para ABR
type QualityLevel struct {
	Name       string // 360p, 480p, 720p, 1080p
	Width      int
	Height     int
	Bitrate    string // ex: "1000k"
	MaxBitrate string // ex: "1200k"
	BufSize    string // ex: "2000k"
	AudioRate  string // ex: "96k", "128k"
	CRF        int    // Qualidade (menor = melhor)
	Preset     string // ultrafast, veryfast, fast, medium
}

// Níveis de qualidade estilo Netflix
// 240p é ultra-rápido para início instantâneo em conexões lentas ou arquivos grandes
var qualityLevels = []QualityLevel{
	{Name: "240p", Width: 426, Height: 240, Bitrate: "400k", MaxBitrate: "428k", BufSize: "600k", AudioRate: "64k", CRF: 30, Preset: "ultrafast"},
	{Name: "360p", Width: 640, Height: 360, Bitrate: "800k", MaxBitrate: "856k", BufSize: "1200k", AudioRate: "96k", CRF: 28, Preset: "ultrafast"},
	{Name: "480p", Width: 854, Height: 480, Bitrate: "1400k", MaxBitrate: "1498k", BufSize: "2100k", AudioRate: "128k", CRF: 26, Preset: "veryfast"},
	{Name: "720p", Width: 1280, Height: 720, Bitrate: "2800k", MaxBitrate: "2996k", BufSize: "4200k", AudioRate: "128k", CRF: 24, Preset: "fast"},
	{Name: "1080p", Width: 1920, Height: 1080, Bitrate: "5000k", MaxBitrate: "5350k", BufSize: "7500k", AudioRate: "192k", CRF: 22, Preset: "fast"},
	// Qualidades mais altas (exigem bastante CPU/GPU, especialmente em tempo real)
	{Name: "1440p", Width: 2560, Height: 1440, Bitrate: "9000k", MaxBitrate: "9630k", BufSize: "13500k", AudioRate: "192k", CRF: 21, Preset: "fast"},
	{Name: "2160p", Width: 3840, Height: 2160, Bitrate: "16000k", MaxBitrate: "17120k", BufSize: "24000k", AudioRate: "256k", CRF: 20, Preset: "fast"},
}

type StreamInfo struct {
	ID             string            `json:"id"`
	MagnetLink     string            `json:"magnetLink"`
	Status         string            `json:"status"` // downloading, transcoding, ready, error
	Progress       float64           `json:"progress"`
	FileName       string            `json:"fileName"`
	VideoFile      string            `json:"videoFile"`
	HLSPath        string            `json:"hlsPath"`
	Error          string            `json:"error,omitempty"`
	Peers          int               `json:"peers"`
	DownloadRate   float64           `json:"downloadRate"`
	CreatedAt      time.Time         `json:"createdAt"`
	Qualities      []string          `json:"qualities"`    // Qualidades disponíveis
	SourceWidth    int               `json:"sourceWidth"`
	SourceHeight   int               `json:"sourceHeight"`
	AudioTracks    []AudioTrackInfo  `json:"audioTracks"`  // Faixas de áudio disponíveis
	torrent        *torrent.Torrent
	cancelChan     chan struct{}
	ffmpegProcs    []*exec.Cmd
	// Tracking de velocidade
	lastBytes      int64
	lastSpeedCheck time.Time
	currentSpeed   float64 // MB/s instantâneo
	mu             sync.Mutex
}

// GetPeerStats retorna estatísticas de peers e velocidade
func (s *StreamInfo) GetPeerStats() (peers int, downloaded float64, speed float64) {
	if s.torrent == nil {
		return 0, 0, 0
	}
	
	stats := s.torrent.Stats()
	currentBytes := stats.BytesReadData.Int64()
	downloaded = float64(currentBytes) / 1024 / 1024 // MB total baixados
	
	s.mu.Lock()
	defer s.mu.Unlock()
	
	now := time.Now()
	if !s.lastSpeedCheck.IsZero() {
		elapsed := now.Sub(s.lastSpeedCheck).Seconds()
		if elapsed > 0.5 { // Atualizar a cada 500ms
			bytesDiff := currentBytes - s.lastBytes
			s.currentSpeed = float64(bytesDiff) / 1024 / 1024 / elapsed // MB/s
			s.lastBytes = currentBytes
			s.lastSpeedCheck = now
		}
	} else {
		s.lastBytes = currentBytes
		s.lastSpeedCheck = now
	}
	
	return stats.ActivePeers, downloaded, s.currentSpeed
}

// Hardware acceleration detection
var (
	hwAccel     string // vaapi, nvenc, qsv, or empty
	hwAccelInit sync.Once
)

func detectHardwareAcceleration() string {
	// Testar VAAPI (Intel/AMD no Linux)
	cmd := exec.Command("ffmpeg", "-init_hw_device", "vaapi=va:/dev/dri/renderD128", "-f", "lavfi", "-i", "nullsrc=s=1920x1080:d=1", "-vf", "format=nv12,hwupload", "-c:v", "h264_vaapi", "-f", "null", "-t", "0.1", "-")
	if err := cmd.Run(); err == nil {
		log.Println("✅ Hardware acceleration: VAAPI detectado")
		return "vaapi"
	}
	
	// Testar NVENC (NVIDIA)
	cmd = exec.Command("ffmpeg", "-f", "lavfi", "-i", "nullsrc=s=1920x1080:d=1", "-c:v", "h264_nvenc", "-f", "null", "-t", "0.1", "-")
	if err := cmd.Run(); err == nil {
		log.Println("✅ Hardware acceleration: NVENC detectado")
		return "nvenc"
	}
	
	// Testar QSV (Intel Quick Sync)
	cmd = exec.Command("ffmpeg", "-f", "lavfi", "-i", "nullsrc=s=1920x1080:d=1", "-c:v", "h264_qsv", "-f", "null", "-t", "0.1", "-")
	if err := cmd.Run(); err == nil {
		log.Println("✅ Hardware acceleration: QSV detectado")
		return "qsv"
	}
	
	log.Println("⚠️ Hardware acceleration: nenhum detectado, usando software")
	return ""
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

	// Carregar cache de metadados
	GetMetadataCache() // Inicializa o cache singleton
	
	// Detectar hardware acceleration em background
	go func() {
		hwAccelInit.Do(func() {
			hwAccel = detectHardwareAcceleration()
		})
	}()

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
	
	// Verificar se já temos cache deste magnet
	if cached, ok := GetMetadataCache().Get(magnetLink); ok {
		log.Printf("[CACHE] Hit para torrent: %s (%dx%d)", cached.Name, cached.Width, cached.Height)
	}
	
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
			
			// Parar processos FFmpeg primeiro
			for _, proc := range oldStream.ffmpegProcs {
				if proc != nil && proc.Process != nil {
					proc.Process.Kill()
				}
			}
			
			// Remover torrent de forma segura
			if oldStream.torrent != nil {
				func() {
					defer func() {
						if r := recover(); r != nil {
							log.Printf("[%s] Torrent já fechado: %v", oldestID[:8], r)
						}
					}()
					oldStream.torrent.Drop()
				}()
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

	// IMPORTANTE: Para MKV/MP4, os headers estão no início do arquivo
	// Precisamos baixar os primeiros MB de forma sequencial antes de iniciar transcodificação
	
	// Iniciar download completo do arquivo
	videoFile.Download()

	// OTIMIZAÇÃO: Priorização sequencial inteligente
	go monitorAndPrioritizePieces(stream, videoFile)
	
	// Priorizar um bloco inicial maior para garantir que os headers E os primeiros segundos
	// do arquivo estejam realmente disponíveis (evita o FFmpeg ler "buracos"/zeros e gerar
	// segmentos corrompidos/sem áudio, que costumam causar Shaka Error 3018).
	// Isso é crítico para o FFmpeg poder ler os metadados do arquivo
	// Em arquivos MKV/MP4, os headers geralmente estão nos primeiros 5-10MB
	pieceLength := t.Info().PieceLength
	initialPieces := (60 * 1024 * 1024) / int(pieceLength) // Primeiros ~60MB em peças
	if initialPieces < 10 {
		initialPieces = 10
	}
	if initialPieces > 2000 {
		initialPieces = 2000 // Limitar para não priorizar demais (pieceLength pode ser pequeno)
	}
	
	// Obter o índice da primeira peça do arquivo de vídeo
	fileOffset := videoFile.Offset()
	firstPiece := int(fileOffset / int64(pieceLength))
	
	log.Printf("[%s] Priorizando primeiras %d peças (bloco inicial/headers)...", stream.ID[:8], initialPieces)
	
	// Definir prioridade alta para as primeiras peças (headers do arquivo)
	for i := 0; i < initialPieces; i++ {
		pieceIndex := firstPiece + i
		if pieceIndex < t.NumPieces() {
			t.Piece(pieceIndex).SetPriority(torrent.PiecePriorityNow)
		}
	}

	// Monitorar progresso do download - verificar a cada 1 segundo para início rápido
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()
	
	transcodeStarted := false
	headersReady := false

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
			// Ser agressivo para início rápido, especialmente em arquivos 4K
			minBytes := int64(20 * 1024 * 1024) // 20MB mínimo para arquivos normais
			minPercent := float64(1) // 1% mínimo
			
			// Para arquivos grandes (>5GB), ser mais agressivo
			if totalBytes > 5*1024*1024*1024 {
				minBytes = 15 * 1024 * 1024 // 15MB
				minPercent = 0.3 // 0.3%
			}
			
			// Para arquivos muito grandes (>15GB, típico 4K), ainda mais agressivo
			if totalBytes > 15*1024*1024*1024 {
				minBytes = 10 * 1024 * 1024 // 10MB apenas
				minPercent = 0.1 // 0.1%
			}
			
			// Verificar se o bloco inicial está pronto (primeiras peças baixadas e contíguas)
			if !headersReady {
				headersComplete := true
				for i := 0; i < initialPieces; i++ {
					pieceIndex := firstPiece + i
					if pieceIndex < t.NumPieces() {
						piece := t.Piece(pieceIndex)
						state := piece.State()
						if !state.Complete {
							headersComplete = false
							break
						}
					}
				}
				if headersComplete {
					headersReady = true
					log.Printf("[%s] ✅ Bloco inicial pronto! Primeiras %d peças completas.", stream.ID[:8], initialPieces)
				}
			}
			
			if headersReady && (progress >= minPercent || bytesCompleted >= minBytes) && !transcodeStarted && stream.Status == "downloading" {
				// Verificar se arquivo existe e se o FFmpeg consegue ler
				// Usar limite mais baixo (8MB) para arquivos grandes já que os headers são pequenos
				minFileSize := int64(10 * 1024 * 1024) // 10MB padrão
				if totalBytes > 10*1024*1024*1024 {
					minFileSize = 8 * 1024 * 1024 // 8MB para arquivos >10GB
				}
				
				if info, err := os.Stat(stream.VideoFile); err == nil && info.Size() > minFileSize {
					// Verificar se o FFmpeg consegue ler o arquivo
					if canReadVideoFile(stream.VideoFile) {
						log.Printf("[%s] ⚡ Arquivo válido com %.2f MB, iniciando transcodificação rápida...", 
							stream.ID[:8], float64(info.Size())/1024/1024)
						transcodeStarted = true
						stream.Status = "transcoding"
						go transcodeToHLS(stream)
					} else {
						log.Printf("[%s] Aguardando mais dados... arquivo ainda não legível", stream.ID[:8])
					}
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

func monitorAndPrioritizePieces(stream *StreamInfo, videoFile *torrent.File) {
	t := stream.torrent
	if t == nil { return }
	
	pieceLength := int64(t.Info().PieceLength)
	fileOffset := videoFile.Offset()
	fileLength := videoFile.Length()
	
	// Calculate first and last piece index for the file
	firstPieceIndex := int(fileOffset / pieceLength)
	lastPieceIndex := int((fileOffset + fileLength - 1) / pieceLength)
	
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	
	log.Printf("[%s] 🚀 Iniciando priorização sequencial de peças (Window: 30MB)", stream.ID[:8])
	
	for {
		select {
		case <-stream.cancelChan:
			return
		case <-ticker.C:
			// Find first incomplete piece in the file range
			startPriorityIndex := -1
			
			// Start scanning from the approximate current position to avoid scanning entire file
			// But since pieces can be downloaded out of order, scanning from start of file is safer/more robust
			// Optimization: keep track of last clean index?
			// For now, linear scan of bitfield is fast enough for video files.
			
			for i := firstPieceIndex; i <= lastPieceIndex; i++ {
				if i >= t.NumPieces() { break }
				if !t.Piece(i).State().Complete {
					startPriorityIndex = i
					break
				}
			}
			
			if startPriorityIndex == -1 {
				// All pieces complete
				return
			}
			
			// Prioritize next ~30MB (approx 15 seconds of 1080p)
			windowBytes := int64(30 * 1024 * 1024)
			piecesToPrioritize := int(windowBytes / pieceLength)
			if piecesToPrioritize < 5 { piecesToPrioritize = 5 } // Minimum 5 pieces
			
			endPriorityIndex := startPriorityIndex + piecesToPrioritize
			if endPriorityIndex > lastPieceIndex {
				endPriorityIndex = lastPieceIndex
			}
			
			// Apply priority
			// Note: We don't clear priority of passed pieces because usually we want them to finish if they started.
			for i := startPriorityIndex; i <= endPriorityIndex; i++ {
				if i < t.NumPieces() {
					t.Piece(i).SetPriority(torrent.PiecePriorityNow)
				}
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

	// Aguardar arquivo existir - timeout mais curto para início rápido
	for i := 0; i < 30; i++ {
		if info, err := os.Stat(stream.VideoFile); err == nil && info.Size() > 5*1024*1024 {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}

	// Detectar resolução do vídeo fonte
	sourceWidth, sourceHeight := getVideoResolution(stream.VideoFile)
	stream.SourceWidth = sourceWidth
	stream.SourceHeight = sourceHeight
	log.Printf("[%s] Resolução fonte: %dx%d", stream.ID[:8], sourceWidth, sourceHeight)

	// Detectar faixas de áudio disponíveis
	audioTracks := GetAudioTracksInfo(stream.VideoFile)
	stream.AudioTracks = audioTracks
	log.Printf("[%s] Faixas de áudio detectadas: %d", stream.ID[:8], len(audioTracks))

	// Determinar quais qualidades gerar baseado na resolução fonte
	availableQualities := []QualityLevel{}
	for _, q := range qualityLevels {
		if q.Height <= sourceHeight {
			availableQualities = append(availableQualities, q)
		}
	}
	
	if len(availableQualities) == 0 {
		availableQualities = []QualityLevel{qualityLevels[0]}
	}

	log.Printf("[%s] Gerando %d qualidades: %v", stream.ID[:8], len(availableQualities), 
		func() []string {
			names := make([]string, len(availableQualities))
			for i, q := range availableQualities {
				names[i] = q.Name
			}
			return names
		}())

	// OTIMIZAÇÃO CRÍTICA: Gerar Master Playlist IMEDIATAMENTE.
	// Assumimos que todas as qualidades serão geradas.
	// Isso permite que o player saiba o que esperar e tente carregar assim que possível.
	if err := generateMasterPlaylist(stream, availableQualities); err != nil {
		log.Printf("[%s] Erro ao gerar master playlist: %v", stream.ID[:8], err)
	}

	// Canais para monitorar início
	qualitiesReady := make(chan string, len(availableQualities))
	errors := make(chan error, len(availableQualities))
	
	// A qualidade mais baixa (primeira da lista) é a crítica para desbloquear o player
	lowestQualityName := availableQualities[0].Name

	// Iniciar transcodificação de TODAS as qualidades em background
	for _, q := range availableQualities {
		go func(quality QualityLevel) {
			err := transcodeQuality(stream, quality)
			if err != nil {
				errors <- fmt.Errorf("%s: %v", quality.Name, err)
			} else {
				qualitiesReady <- quality.Name
			}
		}(q)
	}

	// Aguardar APENAS a qualidade mais baixa ter segmentos prontos para marcar "Ready"
	// As outras qualidades continuarão sendo geradas em background.
	log.Printf("[%s] ⏳ Aguardando segmento da qualidade base (%s) para liberar stream...", stream.ID[:8], lowestQualityName)
	
	streamReady := false
	
	go func() {
		// Monitorar progresso geral e erros
		readyCount := 0
		totalQualities := len(availableQualities)
		
		for readyCount < totalQualities {
			select {
			case qName := <-qualitiesReady:
				readyCount++
				
				// Se a qualidade pronta for a mais baixa (ou se for a primeira a ficar pronta), liberar o player!
				if !streamReady && (qName == lowestQualityName || readyCount == 1) {
					streamReady = true
					stream.Status = "ready"
					stream.Qualities = []string{qName} // Inicialmente só sabemos dessa
					stream.HLSPath = hlsDir // Garantir caminho
					
					log.Printf("[%s] 🎬 STREAM PRONTO! Qualidade %s iniciou. Liberando player.", stream.ID[:8], qName)
					
					// Salvar metadados no cache
					duration, videoCodec, audioCodec, audioTracks, subtitleTracks := GetVideoInfo(stream.VideoFile)
					GetMetadataCache().UpdateFromStream(stream, duration, videoCodec, audioCodec, audioTracks, subtitleTracks)
				} else {
					log.Printf("[%s] Qualidade adicional pronta: %s", stream.ID[:8], qName)
				}
				
			case err := <-errors:
				log.Printf("[%s] ⚠️ Erro em transcodificação: %v", stream.ID[:8], err)
				readyCount++ // Contar como "finalizado" (com erro) para não bloquear loop se fosse o caso
				
			case <-stream.cancelChan:
				return
			}
		}
		log.Printf("[%s] Todas as transcodificações foram iniciadas/finalizadas.", stream.ID[:8])
	}()
}

// transcodeQuality transcodifica para uma qualidade específica
func transcodeQuality(stream *StreamInfo, quality QualityLevel) error {
	qualityDir := filepath.Join(stream.HLSPath, quality.Name)
	if err := os.MkdirAll(qualityDir, 0755); err != nil {
		return err
	}

	playlistPath := filepath.Join(qualityDir, "playlist.m3u8")
	segmentPath := filepath.Join(qualityDir, "segment%03d.ts")

	log.Printf("[%s] Iniciando transcodificação %s (%dx%d @ %s)...", 
		stream.ID[:8], quality.Name, quality.Width, quality.Height, quality.Bitrate)

	// Construir argumentos FFmpeg baseado no hardware disponível e faixas de áudio
	args := buildFFmpegArgs(stream.VideoFile, quality, playlistPath, segmentPath, stream.AudioTracks)

	cmd := exec.Command("ffmpeg", args...)
	
	// Log de erros do FFmpeg
	cmd.Stderr = os.Stderr

	// Adicionar à lista de processos do stream
	mu.Lock()
	stream.ffmpegProcs = append(stream.ffmpegProcs, cmd)
	mu.Unlock()

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("erro ao iniciar FFmpeg: %v", err)
	}

	// Aguardar pelo menos 1 segmento ser criado (mais rápido)
	for i := 0; i < 45; i++ {
		select {
		case <-stream.cancelChan:
			cmd.Process.Kill()
			return fmt.Errorf("cancelado")
		default:
		}

		// 1 segmento já é suficiente para começar a reproduzir
		if countSegmentsInDir(qualityDir) >= 1 {
			log.Printf("[%s] %s: primeiro segmento pronto!", stream.ID[:8], quality.Name)
			
			// Continuar rodando em background
			go func() {
				cmd.Wait()
				log.Printf("[%s] %s: transcodificação completa", stream.ID[:8], quality.Name)
			}()
			
			return nil
		}
		time.Sleep(time.Second)
	}

	cmd.Process.Kill()
	return fmt.Errorf("timeout aguardando segmentos")
}

// buildFFmpegArgs constrói os argumentos do FFmpeg baseado no hardware disponível
func buildFFmpegArgs(inputFile string, quality QualityLevel, playlistPath, segmentPath string, audioTracks []AudioTrackInfo) []string {
	// Garantir que hwAccel foi detectado
	hwAccelInit.Do(func() {
		hwAccel = detectHardwareAcceleration()
	})
	
	// Args base de entrada - otimizado para arquivos parcialmente baixados
	args := []string{
		"-y",
		"-fflags", "+genpts+igndts+discardcorrupt+nobuffer",
		"-flags", "low_delay",
		"-strict", "experimental",
		"-err_detect", "ignore_err",
		"-analyzeduration", "2000000",   // Reduzido para análise mais rápida
		"-probesize", "10000000",        // Reduzido para início mais rápido
		"-max_delay", "0",
		"-thread_queue_size", "512",
	}
	
	// Adicionar hardware acceleration de entrada se disponível
	switch hwAccel {
	case "vaapi":
		args = append(args, "-hwaccel", "vaapi", "-hwaccel_device", "/dev/dri/renderD128", "-hwaccel_output_format", "vaapi")
	case "nvenc":
		args = append(args, "-hwaccel", "cuda", "-hwaccel_output_format", "cuda")
	case "qsv":
		args = append(args, "-hwaccel", "qsv")
	}
	
	args = append(args, "-i", inputFile)

	// Mapear o stream de vídeo
	args = append(args, "-map", "0:v:0")

	// Mapear TODAS as faixas de áudio
	if len(audioTracks) > 1 {
		// Se há múltiplas faixas, mapear cada uma explicitamente
		for i := range audioTracks {
			args = append(args, "-map", fmt.Sprintf("0:a:%d", i))
		}
		log.Printf("[FFmpeg] Mapeando %d faixas de áudio", len(audioTracks))
	} else {
		// Apenas uma faixa ou nenhuma detectada - mapear todas as faixas de áudio disponíveis
		args = append(args, "-map", "0:a?")
	}
	
	// Adicionar filtros e codecs baseado no hardware
	switch hwAccel {
	case "vaapi":
		// VAAPI encoding
		args = append(args,
			"-vf", fmt.Sprintf("format=nv12|vaapi,hwupload,scale_vaapi=%d:%d", quality.Width, quality.Height),
			"-c:v", "h264_vaapi",
			"-qp", fmt.Sprintf("%d", quality.CRF+5), // VAAPI usa QP ao invés de CRF
			"-maxrate", quality.MaxBitrate,
			"-bufsize", quality.BufSize,
		)
		log.Printf("[VAAPI] Usando hardware encoding para %s", quality.Name)
		
	case "nvenc":
		// NVIDIA NVENC encoding
		args = append(args,
			"-vf", fmt.Sprintf("scale=%d:%d", quality.Width, quality.Height),
			"-c:v", "h264_nvenc",
			"-preset", "p4", // NVENC preset (p1=fastest, p7=slowest)
			"-rc", "vbr",
			"-cq", fmt.Sprintf("%d", quality.CRF),
			"-maxrate", quality.MaxBitrate,
			"-bufsize", quality.BufSize,
		)
		log.Printf("[NVENC] Usando hardware encoding para %s", quality.Name)
		
	case "qsv":
		// Intel Quick Sync encoding
		args = append(args,
			"-vf", fmt.Sprintf("scale=%d:%d", quality.Width, quality.Height),
			"-c:v", "h264_qsv",
			"-preset", "faster",
			"-global_quality", fmt.Sprintf("%d", quality.CRF),
			"-maxrate", quality.MaxBitrate,
			"-bufsize", quality.BufSize,
		)
		log.Printf("[QSV] Usando hardware encoding para %s", quality.Name)
		
	default:
		// Software encoding (libx264)
		args = append(args,
			"-vf", fmt.Sprintf("scale=%d:%d:flags=bilinear", quality.Width, quality.Height),
			"-c:v", "libx264",
			"-preset", quality.Preset,
			"-tune", "zerolatency",
			"-crf", fmt.Sprintf("%d", quality.CRF),
			"-maxrate", quality.MaxBitrate,
			"-bufsize", quality.BufSize,
			"-profile:v", "main",
			"-level", "4.0",
		)
	}
	
	// Args comuns para keyframes
	args = append(args,
		"-g", "48",
		"-keyint_min", "48",
		"-sc_threshold", "0",
	)
	
	// Codec de áudio AAC para TODAS as faixas
	args = append(args,
		"-c:a", "aac",
		"-b:a", quality.AudioRate,
		"-ac", "2",
		"-ar", "48000",
	)

	// Adicionar metadados de idioma para cada faixa de áudio
	for i, track := range audioTracks {
		args = append(args, fmt.Sprintf("-metadata:s:a:%d", i), fmt.Sprintf("language=%s", track.Language))
		if track.Title != "" {
			args = append(args, fmt.Sprintf("-metadata:s:a:%d", i), fmt.Sprintf("title=%s", track.Title))
		}
	}
	
	// Configurações HLS
	args = append(args,
		"-hls_time", "2",
		"-hls_list_size", "0",
		// temp_file faz o muxer escrever segmentos/playlist em arquivo temporário e renomear ao final.
		// Isso evita que o player leia segmentos .ts parcialmente gravados (causando erro 3018 no Shaka).
		"-hls_flags", "independent_segments+append_list+temp_file",
		"-hls_segment_type", "mpegts",
		"-hls_segment_filename", segmentPath,
		"-f", "hls",
		playlistPath,
	)
	
	return args
}

// generateMasterPlaylist gera o master playlist HLS com todas as qualidades e faixas de áudio
func generateMasterPlaylist(stream *StreamInfo, qualities []QualityLevel) error {
	masterPath := filepath.Join(stream.HLSPath, "master.m3u8")

	// Gerar master playlist contendo todas as qualidades previstas
	// Não verificamos existência dos arquivos porque eles serão gerados em breve
	
	f, err := os.Create(masterPath)
	if err != nil {
		return err
	}
	defer f.Close()

	// Escrever header
	f.WriteString("#EXTM3U\n")
	f.WriteString("#EXT-X-VERSION:4\n") // Versão 4 para suportar EXT-X-MEDIA

	// Se há múltiplas faixas de áudio, declará-las com EXT-X-MEDIA
	audioGroup := ""
	if len(stream.AudioTracks) > 1 {
		audioGroup = "audio"
		for i, track := range stream.AudioTracks {
			isDefault := "NO"
			if track.Default || i == 0 {
				isDefault = "YES"
			}
			
			// Nome amigável para a faixa
			name := track.Title
			if name == "" {
				name = getLanguageName(track.Language)
			}
			
			// Canais formatados
			channels := ""
			if track.Channels > 0 {
				if track.Channels >= 6 {
					channels = fmt.Sprintf(",CHANNELS=\"%d\"", track.Channels)
				} else {
					channels = fmt.Sprintf(",CHANNELS=\"%d\"", track.Channels)
				}
			}
			
			// EXT-X-MEDIA para áudio alternativo
			// Note: Não usamos URI aqui porque o áudio está multiplexado nos segmentos .ts
			// O Shaka Player identificará as faixas pelos metadados dos segmentos
			f.WriteString(fmt.Sprintf("#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"%s\",NAME=\"%s\",LANGUAGE=\"%s\",DEFAULT=%s,AUTOSELECT=%s%s\n",
				audioGroup, name, track.Language, isDefault, isDefault, channels))
		}
		f.WriteString("\n")
		log.Printf("[%s] 🔊 Master playlist incluiu %d faixas de áudio", stream.ID[:8], len(stream.AudioTracks))
	}

	// Escrever cada qualidade (ordenar por bandwidth crescente para o player)
	for _, q := range qualities {
		// Converter bitrate string para int
		bitrateStr := strings.TrimSuffix(q.Bitrate, "k")
		var bitrate int
		fmt.Sscanf(bitrateStr, "%d", &bitrate)
		bitrate *= 1000
		
		// Incluir referência ao grupo de áudio se houver múltiplas faixas
		if audioGroup != "" {
			f.WriteString(fmt.Sprintf("#EXT-X-STREAM-INF:BANDWIDTH=%d,RESOLUTION=%dx%d,NAME=\"%s\",AUDIO=\"%s\"\n", 
				bitrate, q.Width, q.Height, q.Name, audioGroup))
		} else {
			f.WriteString(fmt.Sprintf("#EXT-X-STREAM-INF:BANDWIDTH=%d,RESOLUTION=%dx%d,NAME=\"%s\"\n", 
				bitrate, q.Width, q.Height, q.Name))
		}
		f.WriteString(fmt.Sprintf("%s/playlist.m3u8\n", q.Name))
	}

	log.Printf("[%s] 📋 Master playlist gerado antecipadamente com %d qualidades", 
		stream.ID[:8], len(qualities))

	return nil
}

// getVideoResolution obtém a resolução do vídeo usando ffprobe
func getVideoResolution(videoPath string) (int, int) {
	cmd := exec.Command("ffprobe",
		"-v", "error",
		"-select_streams", "v:0",
		"-show_entries", "stream=width,height",
		"-of", "csv=s=x:p=0",
		videoPath,
	)

	output, err := cmd.Output()
	if err != nil {
		log.Printf("Erro ao obter resolução: %v", err)
		return 1920, 1080 // Assumir 1080p por padrão
	}

	var width, height int
	fmt.Sscanf(strings.TrimSpace(string(output)), "%dx%d", &width, &height)
	
	if width == 0 || height == 0 {
		return 1920, 1080
	}
	
	return width, height
}

// canReadVideoFile verifica se o FFmpeg consegue ler o arquivo de vídeo
// Usa timeout curto para não bloquear
func canReadVideoFile(videoPath string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	
	cmd := exec.CommandContext(ctx, "ffprobe",
		"-v", "error",
		"-show_entries", "format=duration",
		"-of", "default=noprint_wrappers=1:nokey=1",
		"-analyzeduration", "1000000",
		"-probesize", "5000000",
		videoPath,
	)
	
	err := cmd.Run()
	return err == nil
}

// countSegmentsInDir conta segmentos .ts em um diretório
func countSegmentsInDir(dir string) int {
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
	select {
	case <-stream.cancelChan:
		// Já fechado
	default:
		close(stream.cancelChan)
	}

	// Matar processos FFmpeg
	for _, cmd := range stream.ffmpegProcs {
		if cmd != nil && cmd.Process != nil {
			cmd.Process.Kill()
		}
	}

	// Remover torrent de forma segura
	if stream.torrent != nil {
		func() {
			defer func() {
				if r := recover(); r != nil {
					log.Printf("[%s] Torrent já fechado ao parar: %v", id[:8], r)
				}
			}()
			stream.torrent.Drop()
		}()
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
		select {
		case <-stream.cancelChan:
			// Já fechado
		default:
			close(stream.cancelChan)
		}
		
		if stream.torrent != nil {
			func() {
				defer func() {
					if r := recover(); r != nil {
						log.Printf("[%s] Torrent já fechado em cleanup: %v", id[:8], r)
					}
				}()
				stream.torrent.Drop()
			}()
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
