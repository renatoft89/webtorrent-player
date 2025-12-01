package torrent

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"text/template"
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
var qualityLevels = []QualityLevel{
	{Name: "360p", Width: 640, Height: 360, Bitrate: "800k", MaxBitrate: "856k", BufSize: "1200k", AudioRate: "96k", CRF: 28, Preset: "veryfast"},
	{Name: "480p", Width: 854, Height: 480, Bitrate: "1400k", MaxBitrate: "1498k", BufSize: "2100k", AudioRate: "128k", CRF: 26, Preset: "veryfast"},
	{Name: "720p", Width: 1280, Height: 720, Bitrate: "2800k", MaxBitrate: "2996k", BufSize: "4200k", AudioRate: "128k", CRF: 24, Preset: "fast"},
	{Name: "1080p", Width: 1920, Height: 1080, Bitrate: "5000k", MaxBitrate: "5350k", BufSize: "7500k", AudioRate: "192k", CRF: 22, Preset: "fast"},
}

type StreamInfo struct {
	ID             string          `json:"id"`
	MagnetLink     string          `json:"magnetLink"`
	Status         string          `json:"status"` // downloading, transcoding, ready, error
	Progress       float64         `json:"progress"`
	FileName       string          `json:"fileName"`
	VideoFile      string          `json:"videoFile"`
	HLSPath        string          `json:"hlsPath"`
	Error          string          `json:"error,omitempty"`
	Peers          int             `json:"peers"`
	DownloadRate   float64         `json:"downloadRate"`
	CreatedAt      time.Time       `json:"createdAt"`
	Qualities      []string        `json:"qualities"` // Qualidades disponíveis
	SourceWidth    int             `json:"sourceWidth"`
	SourceHeight   int             `json:"sourceHeight"`
	torrent        *torrent.Torrent
	cancelChan     chan struct{}
	ffmpegProcs    []*exec.Cmd
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

	// Aguardar arquivo existir e ter tamanho mínimo
	for i := 0; i < 60; i++ {
		if info, err := os.Stat(stream.VideoFile); err == nil && info.Size() > 10*1024*1024 {
			break
		}
		time.Sleep(time.Second)
	}

	// Detectar resolução do vídeo fonte
	sourceWidth, sourceHeight := getVideoResolution(stream.VideoFile)
	stream.SourceWidth = sourceWidth
	stream.SourceHeight = sourceHeight
	log.Printf("[%s] Resolução fonte: %dx%d", stream.ID[:8], sourceWidth, sourceHeight)

	// Determinar quais qualidades gerar baseado na resolução fonte
	// Não faz sentido gerar 1080p se o vídeo fonte é 720p
	availableQualities := []QualityLevel{}
	for _, q := range qualityLevels {
		if q.Height <= sourceHeight {
			availableQualities = append(availableQualities, q)
		}
	}
	
	// Se nenhuma qualidade se encaixa, usar a menor
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

	// Iniciar transcodificação para cada qualidade em paralelo
	var wg sync.WaitGroup
	qualitiesReady := make(chan string, len(availableQualities))
	errors := make(chan error, len(availableQualities))

	for _, quality := range availableQualities {
		wg.Add(1)
		go func(q QualityLevel) {
			defer wg.Done()
			err := transcodeQuality(stream, q)
			if err != nil {
				errors <- fmt.Errorf("%s: %v", q.Name, err)
			} else {
				qualitiesReady <- q.Name
			}
		}(quality)
	}

	// Aguardar pelo menos uma qualidade ficar pronta
	go func() {
		firstReady := false
		readyQualities := []string{}
		
		for {
			select {
			case q := <-qualitiesReady:
				readyQualities = append(readyQualities, q)
				stream.Qualities = readyQualities
				
				if !firstReady {
					firstReady = true
					// Gerar master playlist assim que a primeira qualidade estiver pronta
					if err := generateMasterPlaylist(stream, availableQualities); err != nil {
						log.Printf("[%s] Erro ao gerar master playlist: %v", stream.ID[:8], err)
					} else {
						stream.Status = "ready"
						log.Printf("[%s] 🎬 Stream ABR pronto! Qualidade inicial: %s", stream.ID[:8], q)
					}
				} else {
					// Atualizar master playlist com nova qualidade
					generateMasterPlaylist(stream, availableQualities)
					log.Printf("[%s] ✅ Qualidade %s adicionada", stream.ID[:8], q)
				}
				
			case err := <-errors:
				log.Printf("[%s] ⚠️ Erro em qualidade: %v", stream.ID[:8], err)
				
			case <-stream.cancelChan:
				return
			}
		}
	}()

	// Aguardar todas terminarem
	wg.Wait()
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

	// FFmpeg otimizado estilo Netflix
	// Usando 2-pass seria ideal mas muito lento, então usamos CRF com maxrate
	args := []string{
		"-y",
		"-fflags", "+genpts+igndts+discardcorrupt",
		"-err_detect", "ignore_err",
		"-analyzeduration", "20000000",
		"-probesize", "100000000",
		"-i", stream.VideoFile,
		// Filtro de escala com algoritmo de alta qualidade
		"-vf", fmt.Sprintf("scale=%d:%d:flags=lanczos", quality.Width, quality.Height),
		// Codec de vídeo H.264 otimizado
		"-c:v", "libx264",
		"-preset", quality.Preset,
		"-crf", fmt.Sprintf("%d", quality.CRF),
		"-maxrate", quality.MaxBitrate,
		"-bufsize", quality.BufSize,
		"-profile:v", "high",
		"-level", "4.1",
		// Keyframes a cada 2 segundos para seek rápido
		"-g", "48",
		"-keyint_min", "48",
		"-sc_threshold", "0",
		// Codec de áudio AAC otimizado
		"-c:a", "aac",
		"-b:a", quality.AudioRate,
		"-ac", "2",
		"-ar", "48000",
		// Configurações HLS
		"-hls_time", "4",
		"-hls_list_size", "0",
		"-hls_flags", "independent_segments+append_list",
		"-hls_segment_type", "mpegts",
		"-hls_segment_filename", segmentPath,
		"-f", "hls",
		playlistPath,
	}

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

	// Aguardar pelo menos 2 segmentos serem criados
	for i := 0; i < 60; i++ {
		select {
		case <-stream.cancelChan:
			cmd.Process.Kill()
			return fmt.Errorf("cancelado")
		default:
		}

		if countSegmentsInDir(qualityDir) >= 2 {
			log.Printf("[%s] %s: primeiros segmentos prontos", stream.ID[:8], quality.Name)
			
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

// generateMasterPlaylist gera o master playlist HLS com todas as qualidades
func generateMasterPlaylist(stream *StreamInfo, qualities []QualityLevel) error {
	masterPath := filepath.Join(stream.HLSPath, "master.m3u8")

	// Template do master playlist
	const masterTemplate = `#EXTM3U
#EXT-X-VERSION:3
{{range .Qualities}}
#EXT-X-STREAM-INF:BANDWIDTH={{.Bandwidth}},RESOLUTION={{.Width}}x{{.Height}},NAME="{{.Name}}"
{{.Name}}/playlist.m3u8
{{end}}`

	type PlaylistQuality struct {
		Name      string
		Width     int
		Height    int
		Bandwidth int
	}

	// Verificar quais qualidades realmente têm playlist
	var availableQualities []PlaylistQuality
	for _, q := range qualities {
		playlistPath := filepath.Join(stream.HLSPath, q.Name, "playlist.m3u8")
		if _, err := os.Stat(playlistPath); err == nil {
			// Converter bitrate string para int (ex: "2800k" -> 2800000)
			bitrateStr := strings.TrimSuffix(q.Bitrate, "k")
			var bitrate int
			fmt.Sscanf(bitrateStr, "%d", &bitrate)
			bitrate *= 1000
			
			availableQualities = append(availableQualities, PlaylistQuality{
				Name:      q.Name,
				Width:     q.Width,
				Height:    q.Height,
				Bandwidth: bitrate,
			})
		}
	}

	if len(availableQualities) == 0 {
		return fmt.Errorf("nenhuma qualidade disponível")
	}

	// Gerar master playlist
	tmpl, err := template.New("master").Parse(masterTemplate)
	if err != nil {
		return err
	}

	f, err := os.Create(masterPath)
	if err != nil {
		return err
	}
	defer f.Close()

	return tmpl.Execute(f, map[string]interface{}{
		"Qualities": availableQualities,
	})
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
