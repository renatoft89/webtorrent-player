import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

// Addons Stremio para buscar torrents
const ADDONS = {
  brazuca: {
    id: 'brazuca',
    name: '🇧🇷 Brazuca Torrents',
    url: 'https://94c8cb9f702d-brazuca-torrents.baby-beamup.club',
    color: 'bg-green-600',
    description: 'Torrents brasileiros dublados e legendados'
  },
  torrentio: {
    id: 'torrentio',
    name: '🌐 Torrentio',
    url: 'https://torrentio.strem.fun',
    color: 'bg-purple-600',
    description: 'Agregador de múltiplos trackers (YTS, RARBG, 1337x, TPB...)'
  },
  piratebay: {
    id: 'piratebay',
    name: '🏴‍☠️ ThePirateBay+',
    url: 'https://thepiratebay-plus.strem.fun',
    color: 'bg-yellow-600',
    description: 'Busca direta no ThePirateBay'
  }
}

// Usando Cinemeta API do Stremio (não requer autenticação)
const CINEMETA_API = 'https://v3-cinemeta.strem.io'

function HomePage() {
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [results, setResults] = useState([])
  const [trending, setTrending] = useState([])
  const [loading, setLoading] = useState(false)
  const [loadingStreams, setLoadingStreams] = useState(null)
  const [selectedItem, setSelectedItem] = useState(null)
  const [streams, setStreams] = useState([])
  const [error, setError] = useState(null)
  const [activeAddons, setActiveAddons] = useState(['brazuca', 'torrentio', 'piratebay'])
  const [loadingAddons, setLoadingAddons] = useState({})

  // Carregar filmes em alta ao iniciar
  useEffect(() => {
    fetchTrending()
  }, [])

  const fetchTrending = async () => {
    try {
      // Cinemeta top filmes
      const res = await fetch(`${CINEMETA_API}/catalog/movie/top.json`)
      const data = await res.json()
      
      // Mapear para formato compatível
      const movies = (data.metas || []).slice(0, 10).map(m => ({
        id: m.id,
        imdb_id: m.id,
        title: m.name,
        poster_path: m.poster,
        backdrop_path: m.background,
        vote_average: m.imdbRating ? parseFloat(m.imdbRating) : 0,
        release_date: m.releaseInfo || m.year,
        overview: m.description,
        media_type: 'movie'
      }))
      
      setTrending(movies)
    } catch (err) {
      console.error('Erro ao buscar trending:', err)
    }
  }

  const handleSearch = async (e) => {
    e.preventDefault()
    if (!search.trim()) return

    setLoading(true)
    setError(null)
    setResults([])

    try {
      // Buscar filmes no Cinemeta
      const moviesRes = await fetch(
        `${CINEMETA_API}/catalog/movie/top/search=${encodeURIComponent(search)}.json`
      )
      const moviesData = await moviesRes.json()

      // Buscar séries no Cinemeta
      const seriesRes = await fetch(
        `${CINEMETA_API}/catalog/series/top/search=${encodeURIComponent(search)}.json`
      )
      const seriesData = await seriesRes.json()

      // Mapear e combinar resultados
      const movies = (moviesData.metas || []).map(m => ({
        id: m.id,
        imdb_id: m.id,
        title: m.name,
        poster_path: m.poster,
        backdrop_path: m.background,
        vote_average: m.imdbRating ? parseFloat(m.imdbRating) : 0,
        release_date: m.releaseInfo || m.year,
        overview: m.description,
        media_type: 'movie'
      }))

      const series = (seriesData.metas || []).map(s => ({
        id: s.id,
        imdb_id: s.id,
        title: s.name,
        poster_path: s.poster,
        backdrop_path: s.background,
        vote_average: s.imdbRating ? parseFloat(s.imdbRating) : 0,
        first_air_date: s.releaseInfo || s.year,
        overview: s.description,
        media_type: 'tv'
      }))

      // Combinar e ordenar por rating
      const combined = [...movies, ...series]
        .sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0))
        .slice(0, 20)

      setResults(combined)
      
      if (combined.length === 0) {
        setError('Nenhum resultado encontrado')
      }
    } catch (err) {
      setError('Erro ao buscar. Tente novamente.')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  const fetchStreams = async (item) => {
    setSelectedItem(item)
    setStreams([])
    setLoadingStreams(item.id)
    setLoadingAddons({})
    setError(null)

    try {
      const imdbId = item.imdb_id || item.id
      if (!imdbId || !imdbId.startsWith('tt')) {
        setError('IMDB ID não encontrado para este título')
        setLoadingStreams(null)
        return
      }

      const type = item.media_type === 'movie' ? 'movie' : 'series'
      
      // Buscar streams de todos os addons ativos em paralelo
      const allStreams = []
      
      const fetchPromises = activeAddons.map(async (addonId) => {
        const addon = ADDONS[addonId]
        if (!addon) return []
        
        setLoadingAddons(prev => ({ ...prev, [addonId]: true }))
        
        try {
          const streamRes = await fetch(`${addon.url}/stream/${type}/${imdbId}.json`, {
            signal: AbortSignal.timeout(10000) // 10s timeout
          })
          
          if (!streamRes.ok) {
            console.log(`${addon.name}: Sem resultados`)
            return []
          }
          
          const streamData = await streamRes.json()
          
          const streams = (streamData.streams || [])
            .filter(s => s.infoHash || s.url?.includes('magnet'))
            .map(s => ({
              ...s,
              addonId: addonId,
              addonName: addon.name,
              addonColor: addon.color
            }))
          
          console.log(`${addon.name}: ${streams.length} torrents`)
          return streams
        } catch (err) {
          console.log(`${addon.name}: Erro - ${err.message}`)
          return []
        } finally {
          setLoadingAddons(prev => ({ ...prev, [addonId]: false }))
        }
      })
      
      const results = await Promise.all(fetchPromises)
      results.forEach(streams => allStreams.push(...streams))
      
      if (allStreams.length > 0) {
        // Ordenar: Brazuca primeiro (dublados), depois por qualidade
        const sortedStreams = allStreams.sort((a, b) => {
          // Priorizar Brazuca (conteúdo brasileiro)
          if (a.addonId === 'brazuca' && b.addonId !== 'brazuca') return -1
          if (b.addonId === 'brazuca' && a.addonId !== 'brazuca') return 1
          
          // Depois por qualidade
          const qualityOrder = { '4k': 4, '2160p': 4, '1080p': 3, '720p': 2, '480p': 1 }
          const getQuality = (stream) => {
            const title = (stream.title || stream.name || '').toLowerCase()
            for (const [q, v] of Object.entries(qualityOrder)) {
              if (title.includes(q)) return v
            }
            return 0
          }
          return getQuality(b) - getQuality(a)
        })
        
        setStreams(sortedStreams.slice(0, 30))
      } else {
        setError('Nenhum torrent encontrado em nenhum addon')
      }
    } catch (err) {
      setError('Erro ao buscar streams')
      console.error(err)
    } finally {
      setLoadingStreams(null)
    }
  }

  const playStream = (stream) => {
    let magnetLink = ''
    
    if (stream.infoHash) {
      magnetLink = `magnet:?xt=urn:btih:${stream.infoHash}`
      if (stream.sources) {
        stream.sources.forEach(s => {
          magnetLink += `&tr=${encodeURIComponent(s)}`
        })
      }
    } else if (stream.url) {
      magnetLink = stream.url
    }

    if (magnetLink) {
      // Navegar para o player com o magnet link
      navigate(`/player?magnet=${encodeURIComponent(magnetLink)}`)
    }
  }

  const parseStreamTitle = (stream) => {
    const title = stream.title || stream.name || ''
    
    // Extrair qualidade
    const qualityMatch = title.match(/(\d{3,4}p|4K|HDR|WEB-DL|BluRay|BDRip|HDTV)/i)
    const quality = qualityMatch ? qualityMatch[0].toUpperCase() : ''
    
    // Extrair tamanho
    const sizeMatch = title.match(/(\d+\.?\d*\s*(GB|MB))/i)
    const size = sizeMatch ? sizeMatch[0] : ''
    
    // Extrair idioma
    const isDubbed = /dublado|dual|portuguese|pt-br/i.test(title)
    const isLegendado = /legendado|leg\b/i.test(title)
    
    return { title, quality, size, isDubbed, isLegendado }
  }

  const MovieCard = ({ item, onClick }) => (
    <div 
      className="group relative cursor-pointer transform transition-all duration-300 hover:scale-105 hover:z-10"
      onClick={() => onClick(item)}
    >
      <div className="relative aspect-[2/3] rounded-lg overflow-hidden bg-gray-800 shadow-lg">
        {item.poster_path ? (
          <img
            src={item.poster_path}
            alt={item.title}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-500">
            <span className="text-4xl">🎬</span>
          </div>
        )}
        
        {/* Overlay com informações */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/30 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300">
          <div className="absolute bottom-0 left-0 right-0 p-3">
            <h3 className="text-white font-bold text-sm mb-1 line-clamp-2">{item.title}</h3>
            <div className="flex items-center gap-2 text-xs text-gray-300">
              {item.vote_average > 0 && <span>⭐ {item.vote_average?.toFixed(1)}</span>}
              <span>📅 {(item.release_date || item.first_air_date)?.split('-')[0]}</span>
              {item.media_type === 'tv' && <span className="bg-blue-600 px-1.5 rounded">Série</span>}
            </div>
          </div>
        </div>

        {/* Botão Play */}
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-300">
          <div className="bg-blue-600 rounded-full p-4 shadow-lg transform group-hover:scale-110 transition-transform">
            <svg className="w-8 h-8 text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z"/>
            </svg>
          </div>
        </div>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-gray-900/95 backdrop-blur border-b border-gray-800">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between gap-4">
            <h1 className="text-2xl font-bold text-blue-500 flex items-center gap-2">
              🎬 WebTorrent Player
            </h1>
            
            {/* Barra de Busca */}
            <form onSubmit={handleSearch} className="flex-1 max-w-xl">
              <div className="relative">
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Buscar filmes e séries..."
                  className="w-full px-4 py-2 pl-10 bg-gray-800 border border-gray-700 rounded-full focus:outline-none focus:ring-2 focus:ring-blue-500 text-white placeholder-gray-500"
                />
                <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                {loading && (
                  <div className="absolute right-3 top-1/2 -translate-y-1/2">
                    <div className="animate-spin rounded-full h-5 w-5 border-2 border-blue-500 border-t-transparent"></div>
                  </div>
                )}
              </div>
            </form>

            {/* Link para Player Direto */}
            <button
              onClick={() => navigate('/player')}
              className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm transition-colors"
            >
              🔗 Magnet Link
            </button>
          </div>
          
          {/* Addon Toggles */}
          <div className="flex items-center gap-2 mt-3 flex-wrap">
            <span className="text-sm text-gray-400">Fontes:</span>
            {Object.values(ADDONS).map(addon => (
              <button
                key={addon.id}
                onClick={() => {
                  setActiveAddons(prev => 
                    prev.includes(addon.id) 
                      ? prev.filter(id => id !== addon.id)
                      : [...prev, addon.id]
                  )
                }}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-all ${
                  activeAddons.includes(addon.id)
                    ? `${addon.color} text-white`
                    : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                }`}
                title={addon.description}
              >
                {addon.name}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Conteúdo Principal */}
      <main className="max-w-7xl mx-auto px-4 py-8">
        {/* Erro */}
        {error && !selectedItem && (
          <div className="mb-6 p-4 bg-red-900/50 border border-red-700 rounded-lg text-red-200">
            ❌ {error}
          </div>
        )}

        {/* Resultados da Busca */}
        {results.length > 0 && (
          <section className="mb-12">
            <h2 className="text-xl font-bold mb-4">🔍 Resultados para "{search}"</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
              {results.map((item) => (
                <MovieCard key={`${item.media_type}-${item.id}`} item={item} onClick={fetchStreams} />
              ))}
            </div>
          </section>
        )}

        {/* Trending */}
        {!results.length && (
          <section>
            <h2 className="text-xl font-bold mb-4">🔥 Em Alta Esta Semana</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
              {trending.map((item) => (
                <MovieCard key={item.id} item={{ ...item, media_type: 'movie' }} onClick={fetchStreams} />
              ))}
            </div>
          </section>
        )}
      </main>

      {/* Modal de Streams */}
      {selectedItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80" onClick={() => setSelectedItem(null)}>
          <div 
            className="bg-gray-800 rounded-xl max-w-2xl w-full max-h-[80vh] overflow-hidden shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            {/* Header do Modal */}
            <div className="relative">
              {selectedItem.backdrop_path && (
                <img
                  src={selectedItem.backdrop_path}
                  alt=""
                  className="w-full h-48 object-cover"
                />
              )}
              <div className="absolute inset-0 bg-gradient-to-t from-gray-800 to-transparent" />
              <button
                onClick={() => setSelectedItem(null)}
                className="absolute top-4 right-4 p-2 bg-black/50 rounded-full hover:bg-black/70 transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              <div className="absolute bottom-4 left-4 right-4">
                <h3 className="text-2xl font-bold">{selectedItem.title}</h3>
                <div className="flex items-center gap-3 text-sm text-gray-300 mt-1">
                  {selectedItem.vote_average > 0 && <span>⭐ {selectedItem.vote_average?.toFixed(1)}</span>}
                  <span>📅 {(selectedItem.release_date || selectedItem.first_air_date)?.split('-')[0]}</span>
                </div>
              </div>
            </div>

            {/* Conteúdo do Modal */}
            <div className="p-4">
              {selectedItem.overview && (
                <p className="text-gray-400 text-sm mb-4 line-clamp-3">{selectedItem.overview}</p>
              )}

              {/* Loading */}
              {loadingStreams && (
                <div className="py-6">
                  <div className="flex items-center justify-center mb-4">
                    <div className="animate-spin rounded-full h-8 w-8 border-2 border-blue-500 border-t-transparent"></div>
                    <span className="ml-3 text-gray-400">Buscando torrents...</span>
                  </div>
                  {/* Status dos addons */}
                  <div className="flex items-center justify-center gap-3 flex-wrap">
                    {Object.values(ADDONS).filter(a => activeAddons.includes(a.id)).map(addon => (
                      <div 
                        key={addon.id}
                        className={`flex items-center gap-2 px-3 py-1 rounded-full text-xs ${
                          loadingAddons[addon.id] 
                            ? 'bg-gray-700 text-white' 
                            : 'bg-gray-800 text-gray-500'
                        }`}
                      >
                        {loadingAddons[addon.id] && (
                          <div className="animate-spin rounded-full h-3 w-3 border border-white border-t-transparent"></div>
                        )}
                        {!loadingAddons[addon.id] && <span>✓</span>}
                        {addon.name}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Erro */}
              {error && (
                <div className="p-4 bg-red-900/30 border border-red-700 rounded-lg text-red-300 text-sm">
                  {error}
                </div>
              )}

              {/* Lista de Streams */}
              {streams.length > 0 && (
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  <h4 className="text-sm font-medium text-gray-400 mb-2">
                    📥 {streams.length} torrents encontrados
                  </h4>
                  {streams.map((stream, index) => {
                    const { title, quality, size, isDubbed, isLegendado } = parseStreamTitle(stream)
                    return (
                      <button
                        key={index}
                        onClick={() => playStream(stream)}
                        className="w-full p-3 bg-gray-700 hover:bg-gray-600 rounded-lg text-left transition-colors group"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            {/* Badge do Addon */}
                            <div className="flex items-center gap-2 mb-1">
                              <span className={`px-2 py-0.5 ${stream.addonColor} rounded text-xs`}>
                                {stream.addonName?.replace(/[🇧🇷🌐🏴‍☠️]/g, '').trim()}
                              </span>
                            </div>
                            <p className="text-sm text-white truncate group-hover:text-blue-400 transition-colors">
                              {title || 'Stream disponível'}
                            </p>
                            <div className="flex items-center gap-2 mt-1 flex-wrap">
                              {quality && (
                                <span className="px-2 py-0.5 bg-blue-600 rounded text-xs">{quality}</span>
                              )}
                              {isDubbed && (
                                <span className="px-2 py-0.5 bg-green-600 rounded text-xs">Dublado</span>
                              )}
                              {isLegendado && (
                                <span className="px-2 py-0.5 bg-yellow-600 rounded text-xs">Legendado</span>
                              )}
                              {size && (
                                <span className="text-xs text-gray-400">{size}</span>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-1 text-blue-400">
                            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                              <path d="M8 5v14l11-7z"/>
                            </svg>
                          </div>
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default HomePage
