package torrent

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// CacheEntry representa uma entrada no cache de metadados
type CacheEntry struct {
	InfoHash     string    `json:"infoHash"`
	Name         string    `json:"name"`
	FileName     string    `json:"fileName"`
	FileSize     int64     `json:"fileSize"`
	Duration     float64   `json:"duration"` // duração em segundos
	Width        int       `json:"width"`
	Height       int       `json:"height"`
	VideoCodec   string    `json:"videoCodec"`
	AudioCodec   string    `json:"audioCodec"`
	AudioTracks  int       `json:"audioTracks"`
	SubtitleTracks int     `json:"subtitleTracks"`
	CreatedAt    time.Time `json:"createdAt"`
	LastAccess   time.Time `json:"lastAccess"`
	AccessCount  int       `json:"accessCount"`
}

// MetadataCache gerencia o cache de metadados de torrents
type MetadataCache struct {
	entries map[string]*CacheEntry
	mu      sync.RWMutex
	path    string
}

var (
	metadataCache *MetadataCache
	cacheOnce     sync.Once
)

// GetMetadataCache retorna a instância única do cache
func GetMetadataCache() *MetadataCache {
	cacheOnce.Do(func() {
		metadataCache = &MetadataCache{
			entries: make(map[string]*CacheEntry),
			path:    "./downloads/metadata_cache.json",
		}
		metadataCache.load()
	})
	return metadataCache
}

// HashMagnetLink gera um hash único para um magnet link
func HashMagnetLink(magnetLink string) string {
	// Extrair o infoHash do magnet link
	infoHash := extractInfoHash(magnetLink)
	if infoHash != "" {
		return infoHash
	}
	
	// Fallback: hash do magnet link completo
	hash := sha256.Sum256([]byte(magnetLink))
	return hex.EncodeToString(hash[:16])
}

// extractInfoHash extrai o info hash de um magnet link
func extractInfoHash(magnetLink string) string {
	// magnet:?xt=urn:btih:HASH...
	if len(magnetLink) < 60 {
		return ""
	}
	
	start := 20 // "magnet:?xt=urn:btih:" tem 20 caracteres
	end := start + 40 // Hash tem 40 caracteres
	
	if end > len(magnetLink) {
		return ""
	}
	
	hash := magnetLink[start:end]
	
	// Verificar se é um hash válido (hexadecimal)
	for _, c := range hash {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return ""
		}
	}
	
	return hash
}

// Get busca uma entrada no cache
func (c *MetadataCache) Get(magnetLink string) (*CacheEntry, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	
	hash := HashMagnetLink(magnetLink)
	entry, ok := c.entries[hash]
	
	if ok {
		// Atualizar acesso (fora do lock de leitura)
		go func() {
			c.mu.Lock()
			defer c.mu.Unlock()
			if e, exists := c.entries[hash]; exists {
				e.LastAccess = time.Now()
				e.AccessCount++
			}
		}()
	}
	
	return entry, ok
}

// Set adiciona ou atualiza uma entrada no cache
func (c *MetadataCache) Set(magnetLink string, entry *CacheEntry) {
	c.mu.Lock()
	defer c.mu.Unlock()
	
	hash := HashMagnetLink(magnetLink)
	entry.InfoHash = hash
	entry.LastAccess = time.Now()
	
	if entry.CreatedAt.IsZero() {
		entry.CreatedAt = time.Now()
	}
	
	c.entries[hash] = entry
	
	// Salvar em background
	go c.save()
	
	log.Printf("📦 Cache: Salvo metadados para %s (%s)", entry.Name, hash[:8])
}

// UpdateFromStream atualiza o cache a partir de um StreamInfo
func (c *MetadataCache) UpdateFromStream(stream *StreamInfo, duration float64, videoCodec, audioCodec string, audioTracks, subtitleTracks int) {
	entry := &CacheEntry{
		Name:           stream.FileName,
		FileName:       stream.FileName,
		FileSize:       0, // Será preenchido quando disponível
		Duration:       duration,
		Width:          stream.SourceWidth,
		Height:         stream.SourceHeight,
		VideoCodec:     videoCodec,
		AudioCodec:     audioCodec,
		AudioTracks:    audioTracks,
		SubtitleTracks: subtitleTracks,
	}
	
	c.Set(stream.MagnetLink, entry)
}

// load carrega o cache do disco
func (c *MetadataCache) load() {
	c.mu.Lock()
	defer c.mu.Unlock()
	
	// Criar diretório se não existir
	dir := filepath.Dir(c.path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		log.Printf("⚠️ Cache: Erro ao criar diretório: %v", err)
		return
	}
	
	data, err := os.ReadFile(c.path)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("⚠️ Cache: Erro ao ler arquivo: %v", err)
		}
		return
	}
	
	if err := json.Unmarshal(data, &c.entries); err != nil {
		log.Printf("⚠️ Cache: Erro ao decodificar: %v", err)
		return
	}
	
	log.Printf("📦 Cache: Carregado %d entradas de metadados", len(c.entries))
}

// save salva o cache no disco
func (c *MetadataCache) save() {
	c.mu.RLock()
	defer c.mu.RUnlock()
	
	data, err := json.MarshalIndent(c.entries, "", "  ")
	if err != nil {
		log.Printf("⚠️ Cache: Erro ao codificar: %v", err)
		return
	}
	
	if err := os.WriteFile(c.path, data, 0644); err != nil {
		log.Printf("⚠️ Cache: Erro ao salvar: %v", err)
	}
}

// Cleanup remove entradas antigas do cache
func (c *MetadataCache) Cleanup(maxAge time.Duration) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	
	now := time.Now()
	removed := 0
	
	for hash, entry := range c.entries {
		if now.Sub(entry.LastAccess) > maxAge {
			delete(c.entries, hash)
			removed++
		}
	}
	
	if removed > 0 {
		go c.save()
		log.Printf("📦 Cache: Removidas %d entradas antigas", removed)
	}
	
	return removed
}

// Stats retorna estatísticas do cache
func (c *MetadataCache) Stats() (total int, hits int, avgAccess float64) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	
	total = len(c.entries)
	totalAccess := 0
	
	for _, entry := range c.entries {
		totalAccess += entry.AccessCount
	}
	
	if total > 0 {
		avgAccess = float64(totalAccess) / float64(total)
	}
	
	return total, totalAccess, avgAccess
}

// GetVideoInfo obtém informações do vídeo usando ffprobe (com cache)
func GetVideoInfo(videoPath string) (duration float64, videoCodec, audioCodec string, audioTracks, subtitleTracks int) {
	// Duração
	durationCmd := exec.Command("ffprobe",
		"-v", "error",
		"-show_entries", "format=duration",
		"-of", "default=noprint_wrappers=1:nokey=1",
		videoPath,
	)
	if output, err := durationCmd.Output(); err == nil {
		fmt.Sscanf(strings.TrimSpace(string(output)), "%f", &duration)
	}
	
	// Codec de vídeo
	videoCmd := exec.Command("ffprobe",
		"-v", "error",
		"-select_streams", "v:0",
		"-show_entries", "stream=codec_name",
		"-of", "default=noprint_wrappers=1:nokey=1",
		videoPath,
	)
	if output, err := videoCmd.Output(); err == nil {
		videoCodec = strings.TrimSpace(string(output))
	}
	
	// Codec de áudio
	audioCmd := exec.Command("ffprobe",
		"-v", "error",
		"-select_streams", "a:0",
		"-show_entries", "stream=codec_name",
		"-of", "default=noprint_wrappers=1:nokey=1",
		videoPath,
	)
	if output, err := audioCmd.Output(); err == nil {
		audioCodec = strings.TrimSpace(string(output))
	}
	
	// Contar faixas de áudio
	audioCountCmd := exec.Command("ffprobe",
		"-v", "error",
		"-select_streams", "a",
		"-show_entries", "stream=index",
		"-of", "csv=p=0",
		videoPath,
	)
	if output, err := audioCountCmd.Output(); err == nil {
		lines := strings.Split(strings.TrimSpace(string(output)), "\n")
		audioTracks = len(lines)
		if lines[0] == "" {
			audioTracks = 0
		}
	}
	
	// Contar faixas de legenda
	subCountCmd := exec.Command("ffprobe",
		"-v", "error",
		"-select_streams", "s",
		"-show_entries", "stream=index",
		"-of", "csv=p=0",
		videoPath,
	)
	if output, err := subCountCmd.Output(); err == nil {
		lines := strings.Split(strings.TrimSpace(string(output)), "\n")
		subtitleTracks = len(lines)
		if lines[0] == "" {
			subtitleTracks = 0
		}
	}
	
	return
}

// AudioTrackInfo contém informações detalhadas de uma faixa de áudio
type AudioTrackInfo struct {
	Index       int    `json:"index"`       // Índice do stream no arquivo (0, 1, 2...)
	StreamIndex int    `json:"streamIndex"` // Índice absoluto do stream
	Language    string `json:"language"`    // Código do idioma (eng, por, jpn, etc)
	Title       string `json:"title"`       // Nome/título da faixa
	Codec       string `json:"codec"`       // Codec (aac, ac3, dts, etc)
	Channels    int    `json:"channels"`    // Número de canais (2=stereo, 6=5.1)
	Default     bool   `json:"default"`     // Se é a faixa padrão
}

// GetAudioTracksInfo obtém informações detalhadas de todas as faixas de áudio
func GetAudioTracksInfo(videoPath string) []AudioTrackInfo {
	cmd := exec.Command("ffprobe",
		"-v", "error",
		"-select_streams", "a",
		"-show_entries", "stream=index,codec_name,channels:stream_tags=language,title",
		"-of", "json",
		videoPath,
	)

	output, err := cmd.Output()
	if err != nil {
		log.Printf("Erro ao obter faixas de áudio: %v", err)
		return nil
	}

	// Parse JSON do ffprobe
	var result struct {
		Streams []struct {
			Index     int    `json:"index"`
			CodecName string `json:"codec_name"`
			Channels  int    `json:"channels"`
			Tags      struct {
				Language string `json:"language"`
				Title    string `json:"title"`
			} `json:"tags"`
		} `json:"streams"`
	}

	if err := json.Unmarshal(output, &result); err != nil {
		log.Printf("Erro ao parsear JSON do ffprobe: %v", err)
		return nil
	}

	tracks := make([]AudioTrackInfo, 0, len(result.Streams))
	for i, stream := range result.Streams {
		lang := stream.Tags.Language
		if lang == "" {
			lang = "und" // undefined
		}

		title := stream.Tags.Title
		if title == "" {
			// Gerar título baseado no idioma
			title = getLanguageName(lang)
		}

		tracks = append(tracks, AudioTrackInfo{
			Index:       i,
			StreamIndex: stream.Index,
			Language:    lang,
			Title:       title,
			Codec:       stream.CodecName,
			Channels:    stream.Channels,
			Default:     i == 0, // Primeira faixa é a padrão
		})
	}

	log.Printf("🔊 Faixas de áudio encontradas: %d", len(tracks))
	for _, t := range tracks {
		log.Printf("   - [%d] %s (%s) - %s - %d canais", t.Index, t.Title, t.Language, t.Codec, t.Channels)
	}

	return tracks
}

// getLanguageName retorna o nome do idioma a partir do código ISO
func getLanguageName(code string) string {
	languages := map[string]string{
		"por": "Português",
		"pt":  "Português",
		"eng": "English",
		"en":  "English",
		"spa": "Español",
		"es":  "Español",
		"jpn": "日本語",
		"ja":  "日本語",
		"ger": "Deutsch",
		"de":  "Deutsch",
		"fre": "Français",
		"fr":  "Français",
		"ita": "Italiano",
		"it":  "Italiano",
		"rus": "Русский",
		"ru":  "Русский",
		"kor": "한국어",
		"ko":  "한국어",
		"chi": "中文",
		"zh":  "中文",
		"ara": "العربية",
		"ar":  "العربية",
		"hin": "हिन्दी",
		"hi":  "हिन्दी",
		"und": "Unknown",
	}

	if name, ok := languages[code]; ok {
		return name
	}
	return strings.ToUpper(code)
}
