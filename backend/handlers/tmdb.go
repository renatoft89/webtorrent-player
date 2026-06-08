package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/gin-gonic/gin"
)

// Estruturas de dados para o TMDB
type TMDBItem struct {
	ID           int     `json:"id"`
	Title        string  `json:"title,omitempty"`         // Filmes usam Title
	Name         string  `json:"name,omitempty"`          // Séries usam Name
	Overview     string  `json:"overview"`
	PosterPath   string  `json:"poster_path"`
	BackdropPath string  `json:"backdrop_path"`
	VoteAverage  float64 `json:"vote_average"`
	ReleaseDate  string  `json:"release_date,omitempty"`  // Filmes usam ReleaseDate
	FirstAirDate string  `json:"first_air_date,omitempty"` // Séries usam FirstAirDate
}

type TMDBResponse struct {
	Results []TMDBItem `json:"results"`
}

type TMDBExternalIDsResponse struct {
	ImdbID string `json:"imdb_id"`
}

type TMDBMovieDetailsResponse struct {
	ImdbID string `json:"imdb_id"`
}

// Estruturas de resposta compatíveis com Cinemeta (para facilidade no frontend)
type CinemetaMeta struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Poster      string `json:"poster"`
	Background  string `json:"background"`
	ImdbRating  string `json:"imdbRating"`
	ReleaseInfo string `json:"releaseInfo"`
	Year        string `json:"year"`
	Description string `json:"description"`
	Type        string `json:"type"`
}

type CinemetaResponse struct {
	Metas []CinemetaMeta `json:"metas"`
}

// getTMDBKey obtém a API key do TMDB das variáveis de ambiente
func getTMDBKey() string {
	return os.Getenv("TMDB_API_KEY")
}

// checkTMDBKey verifica se a API Key está disponível, caso contrário retorna erro HTTP 401
func checkTMDBKey(c *gin.Context) bool {
	apiKey := getTMDBKey()
	if apiKey == "" {
		c.JSON(http.StatusUnauthorized, gin.H{
			"error":   "TMDB_API_KEY_NOT_CONFIGURED",
			"message": "A variável de ambiente TMDB_API_KEY não está configurada no backend.",
		})
		return false
	}
	return true
}

// helper para extrair o ano de uma string de data (YYYY-MM-DD)
func extractYear(dateStr string) string {
	if dateStr == "" {
		return ""
	}
	parts := strings.Split(dateStr, "-")
	if len(parts) > 0 {
		return parts[0]
	}
	return ""
}

// mapTMDBToCinemeta formata os dados do TMDB no formato consumido pelo Cinemeta
func mapTMDBToCinemeta(items []TMDBItem, mediaType string) []CinemetaMeta {
	metas := make([]CinemetaMeta, 0)
	for _, item := range items {
		// Determina o título
		title := item.Title
		if title == "" {
			title = item.Name
		}
		if title == "" {
			continue
		}

		// Determina a data de lançamento
		releaseInfo := item.ReleaseDate
		if releaseInfo == "" {
			releaseInfo = item.FirstAirDate
		}

		// URLs completas de imagens do TMDB
		posterURL := ""
		if item.PosterPath != "" {
			posterURL = "https://image.tmdb.org/t/p/w500" + item.PosterPath
		}

		backgroundURL := ""
		if item.BackdropPath != "" {
			backgroundURL = "https://image.tmdb.org/t/p/original" + item.BackdropPath
		}

		metas = append(metas, CinemetaMeta{
			ID:          fmt.Sprintf("%d", item.ID),
			Name:        title,
			Poster:      posterURL,
			Background:  backgroundURL,
			ImdbRating:  fmt.Sprintf("%.1f", item.VoteAverage),
			ReleaseInfo: releaseInfo,
			Year:        extractYear(releaseInfo),
			Description: item.Overview,
			Type:        mediaType,
		})
	}
	return metas
}

// GetTMDBTrending retorna os filmes populares/trending da semana
func GetTMDBTrending(c *gin.Context) {
	if !checkTMDBKey(c) {
		return
	}

	apiKey := getTMDBKey()
	// Usamos /trending/movie/week para exibir o conteúdo principal em alta
	apiURL := fmt.Sprintf("https://api.themoviedb.org/3/trending/movie/week?api_key=%s&language=pt-BR", apiKey)

	resp, err := http.Get(apiURL)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao conectar com a API do TMDB"})
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		c.JSON(resp.StatusCode, gin.H{"error": fmt.Sprintf("Erro do TMDB: status %d", resp.StatusCode)})
		return
	}

	var tmdbResp TMDBResponse
	if err := json.NewDecoder(resp.Body).Decode(&tmdbResp); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao processar dados do TMDB"})
		return
	}

	metas := mapTMDBToCinemeta(tmdbResp.Results, "movie")
	c.JSON(http.StatusOK, CinemetaResponse{Metas: metas})
}

// SearchTMDBMovies busca filmes no TMDB em português
func SearchTMDBMovies(c *gin.Context) {
	if !checkTMDBKey(c) {
		return
	}

	query := c.Query("query")
	if query == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Parâmetro 'query' é obrigatório"})
		return
	}

	apiKey := getTMDBKey()
	apiURL := fmt.Sprintf("https://api.themoviedb.org/3/search/movie?api_key=%s&language=pt-BR&query=%s", apiKey, url.QueryEscape(query))

	resp, err := http.Get(apiURL)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao buscar filmes no TMDB"})
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		c.JSON(resp.StatusCode, gin.H{"error": fmt.Sprintf("Erro do TMDB: status %d", resp.StatusCode)})
		return
	}

	var tmdbResp TMDBResponse
	if err := json.NewDecoder(resp.Body).Decode(&tmdbResp); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao processar dados do TMDB"})
		return
	}

	metas := mapTMDBToCinemeta(tmdbResp.Results, "movie")
	c.JSON(http.StatusOK, CinemetaResponse{Metas: metas})
}

// SearchTMDBSeries busca séries no TMDB em português
func SearchTMDBSeries(c *gin.Context) {
	if !checkTMDBKey(c) {
		return
	}

	query := c.Query("query")
	if query == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Parâmetro 'query' é obrigatório"})
		return
	}

	apiKey := getTMDBKey()
	apiURL := fmt.Sprintf("https://api.themoviedb.org/3/search/tv?api_key=%s&language=pt-BR&query=%s", apiKey, url.QueryEscape(query))

	resp, err := http.Get(apiURL)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao buscar séries no TMDB"})
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		c.JSON(resp.StatusCode, gin.H{"error": fmt.Sprintf("Erro do TMDB: status %d", resp.StatusCode)})
		return
	}

	var tmdbResp TMDBResponse
	if err := json.NewDecoder(resp.Body).Decode(&tmdbResp); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao processar dados do TMDB"})
		return
	}

	metas := mapTMDBToCinemeta(tmdbResp.Results, "tv")
	c.JSON(http.StatusOK, CinemetaResponse{Metas: metas})
}

// GetTMDBExternalIDs obtém o IMDb ID a partir do ID do TMDB sob demanda
func GetTMDBExternalIDs(c *gin.Context) {
	if !checkTMDBKey(c) {
		return
	}

	id := c.Query("id")
	mediaType := c.Query("type")

	if id == "" || mediaType == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Os parâmetros 'id' e 'type' são obrigatórios"})
		return
	}

	apiKey := getTMDBKey()
	var imdbID string

	if mediaType == "movie" {
		// Detalhes do filme retornam imdb_id na raiz
		apiURL := fmt.Sprintf("https://api.themoviedb.org/3/movie/%s?api_key=%s", id, apiKey)
		resp, err := http.Get(apiURL)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao obter detalhes do filme no TMDB"})
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			c.JSON(resp.StatusCode, gin.H{"error": fmt.Sprintf("Erro do TMDB: status %d", resp.StatusCode)})
			return
		}

		var movieDetails TMDBMovieDetailsResponse
		if err := json.NewDecoder(resp.Body).Decode(&movieDetails); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao processar detalhes do filme"})
			return
		}
		imdbID = movieDetails.ImdbID

	} else if mediaType == "tv" {
		// Séries de TV requerem o endpoint de external_ids
		apiURL := fmt.Sprintf("https://api.themoviedb.org/3/tv/%s/external_ids?api_key=%s", id, apiKey)
		resp, err := http.Get(apiURL)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao obter IDs externos da série no TMDB"})
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			c.JSON(resp.StatusCode, gin.H{"error": fmt.Sprintf("Erro do TMDB: status %d", resp.StatusCode)})
			return
		}

		var extIDs TMDBExternalIDsResponse
		if err := json.NewDecoder(resp.Body).Decode(&extIDs); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao processar IDs externos da série"})
			return
		}
		imdbID = extIDs.ImdbID
	} else {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Tipo de mídia inválido. Use 'movie' ou 'tv'"})
		return
	}

	if imdbID == "" {
		c.JSON(http.StatusNotFound, gin.H{"error": "IMDb ID não encontrado para esta mídia no TMDB"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"imdb_id": imdbID})
}
