import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

const ADDONS = {
  brazuca: {
    id: 'brazuca',
    name: 'Brazuca',
    icon: '🇧🇷',
    url: 'https://94c8cb9f702d-brazuca-torrents.baby-beamup.club',
    gradient: 'from-green-500 to-emerald-600',
    description: 'Torrents brasileiros'
  },
  torrentio: {
    id: 'torrentio',
    name: 'Torrentio',
    icon: '🌐',
    url: 'https://torrentio.strem.fun',
    gradient: 'from-purple-500 to-indigo-600',
    description: 'Multi-trackers'
  },
  piratebay: {
    id: 'piratebay',
    name: 'TPB+',
    icon: '🏴‍☠️',
    url: 'https://thepiratebay-plus.strem.fun',
    gradient: 'from-amber-500 to-orange-600',
    description: 'ThePirateBay'
  }
}

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
  const [isLoadingTrending, setIsLoadingTrending] = useState(true)

  useEffect(() => { fetchTrending() }, [])

  const fetchTrending = async () => {
    setIsLoadingTrending(true)
    try {
      const res = await fetch(`${CINEMETA_API}/catalog/movie/top.json`)
      const data = await res.json()
      const movies = (data.metas || []).slice(0, 12).map(m => ({
        id: m.id, imdb_id: m.id, title: m.name, poster_path: m.poster,
        backdrop_path: m.background, vote_average: m.imdbRating ? parseFloat(m.imdbRating) : 0,
        release_date: m.releaseInfo || m.year, overview: m.description, media_type: 'movie'
      }))
      setTrending(movies)
    } catch (err) { console.error('Erro:', err) }
    finally { setIsLoadingTrending(false) }
  }

  const handleSearch = async (e) => {
    e.preventDefault()
    if (!search.trim()) return
    setLoading(true); setError(null); setResults([])
    try {
      const [moviesRes, seriesRes] = await Promise.all([
        fetch(`${CINEMETA_API}/catalog/movie/top/search=${encodeURIComponent(search)}.json`),
        fetch(`${CINEMETA_API}/catalog/series/top/search=${encodeURIComponent(search)}.json`)
      ])
      const [moviesData, seriesData] = await Promise.all([moviesRes.json(), seriesRes.json()])
      const movies = (moviesData.metas || []).map(m => ({
        id: m.id, imdb_id: m.id, title: m.name, poster_path: m.poster, backdrop_path: m.background,
        vote_average: m.imdbRating ? parseFloat(m.imdbRating) : 0, release_date: m.releaseInfo || m.year,
        overview: m.description, media_type: 'movie'
      }))
      const series = (seriesData.metas || []).map(s => ({
        id: s.id, imdb_id: s.id, title: s.name, poster_path: s.poster, backdrop_path: s.background,
        vote_average: s.imdbRating ? parseFloat(s.imdbRating) : 0, first_air_date: s.releaseInfo || s.year,
        overview: s.description, media_type: 'tv'
      }))
      const combined = [...movies, ...series].sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0)).slice(0, 20)
      setResults(combined)
      if (combined.length === 0) setError('Nenhum resultado encontrado')
    } catch { setError('Erro ao buscar') }
    finally { setLoading(false) }
  }

  const fetchStreams = async (item) => {
    setSelectedItem(item); setStreams([]); setLoadingStreams(item.id); setLoadingAddons({}); setError(null)
    try {
      const imdbId = item.imdb_id || item.id
      if (!imdbId?.startsWith('tt')) { setError('IMDB ID não encontrado'); setLoadingStreams(null); return }
      const type = item.media_type === 'movie' ? 'movie' : 'series'
      const allStreams = []
      const fetchPromises = activeAddons.map(async (addonId) => {
        const addon = ADDONS[addonId]
        if (!addon) return []
        setLoadingAddons(prev => ({ ...prev, [addonId]: true }))
        try {
          const streamRes = await fetch(`${addon.url}/stream/${type}/${imdbId}.json`, { signal: AbortSignal.timeout(10000) })
          if (!streamRes.ok) return []
          const streamData = await streamRes.json()
          return (streamData.streams || []).filter(s => s.infoHash || s.url?.includes('magnet'))
            .map(s => ({ ...s, addonId, addonName: addon.name, addonIcon: addon.icon, addonGradient: addon.gradient }))
        } catch { return [] }
        finally { setLoadingAddons(prev => ({ ...prev, [addonId]: false })) }
      })
      const results = await Promise.all(fetchPromises)
      results.forEach(streams => allStreams.push(...streams))
      if (allStreams.length > 0) {
        const sortedStreams = allStreams.sort((a, b) => {
          if (a.addonId === 'brazuca' && b.addonId !== 'brazuca') return -1
          if (b.addonId === 'brazuca' && a.addonId !== 'brazuca') return 1
          const qualityOrder = { '4k': 4, '2160p': 4, '1080p': 3, '720p': 2, '480p': 1 }
          const getQuality = (stream) => { const title = (stream.title || '').toLowerCase(); for (const [q, v] of Object.entries(qualityOrder)) { if (title.includes(q)) return v }; return 0 }
          return getQuality(b) - getQuality(a)
        })
        setStreams(sortedStreams.slice(0, 30))
      } else { setError('Nenhum torrent encontrado') }
    } catch { setError('Erro ao buscar streams') }
    finally { setLoadingStreams(null) }
  }

  const playStream = (stream) => {
    let magnetLink = stream.infoHash ? `magnet:?xt=urn:btih:${stream.infoHash}${stream.sources?.map(s => `&tr=${encodeURIComponent(s)}`).join('') || ''}` : stream.url
    if (magnetLink) navigate(`/player?magnet=${encodeURIComponent(magnetLink)}`)
  }

  const parseStreamTitle = (stream) => {
    const title = stream.title || ''
    const qualityMatch = title.match(/(\d{3,4}p|4K|HDR|WEB-DL|BluRay|BDRip|HDTV)/i)
    const sizeMatch = title.match(/(\d+\.?\d*\s*(GB|MB))/i)
    const isDubbed = /dublado|dual|portuguese|pt-br/i.test(title)
    const isLegendado = /legendado|leg\b/i.test(title)
    return { title, quality: qualityMatch?.[0]?.toUpperCase() || '', size: sizeMatch?.[0] || '', isDubbed, isLegendado }
  }

  const MovieCard = ({ item, onClick, index }) => (
    <div className="group relative cursor-pointer card-hover" onClick={() => onClick(item)} style={{ animationDelay: `${index * 0.05}s` }}>
      <div className="relative aspect-[2/3] rounded-2xl overflow-hidden glass">
        {item.poster_path ? (
          <img src={item.poster_path} alt={item.title} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110" loading="lazy" />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-gray-800 to-gray-900"><span className="text-5xl">🎬</span></div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-all duration-300" />
        <div className="absolute inset-0 flex flex-col justify-end p-4 opacity-0 group-hover:opacity-100 transition-all duration-300 translate-y-4 group-hover:translate-y-0">
          <h3 className="text-white font-bold text-sm mb-2 line-clamp-2">{item.title}</h3>
          <div className="flex items-center gap-2 text-xs">
            {item.vote_average > 0 && <span className="flex items-center gap-1 bg-yellow-500/20 text-yellow-400 px-2 py-0.5 rounded-full">⭐ {item.vote_average?.toFixed(1)}</span>}
            <span className="text-gray-400">{(item.release_date || item.first_air_date)?.split('-')[0]}</span>
            {item.media_type === 'tv' && <span className="bg-indigo-500/30 text-indigo-300 px-2 py-0.5 rounded-full text-xs">Série</span>}
          </div>
        </div>
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-300 scale-50 group-hover:scale-100">
          <div className="w-16 h-16 rounded-full bg-gradient-to-r from-indigo-500 to-pink-500 flex items-center justify-center shadow-lg shadow-indigo-500/50 glow">
            <svg className="w-8 h-8 text-white ml-1" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
          </div>
        </div>
        {item.media_type === 'tv' && <div className="absolute top-3 left-3 px-2 py-1 rounded-lg bg-black/60 backdrop-blur-sm text-xs font-medium">📺 Série</div>}
      </div>
    </div>
  )

  const SkeletonCard = () => <div className="aspect-[2/3] rounded-2xl skeleton" />

  return (
    <div className="min-h-screen relative overflow-hidden">
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute -top-40 -right-40 w-[500px] h-[500px] bg-indigo-600/20 rounded-full blur-[120px] animate-float" />
        <div className="absolute -bottom-40 -left-40 w-[400px] h-[400px] bg-pink-600/15 rounded-full blur-[100px] animate-float" style={{ animationDelay: '-3s' }} />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-purple-600/10 rounded-full blur-[150px] animate-glow-pulse" />
      </div>

      <header className="sticky top-0 z-50 glass-strong border-b border-white/5">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-pink-500 flex items-center justify-center shadow-lg shadow-indigo-500/30">
                <svg className="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
              </div>
              <div className="hidden sm:block">
                <h1 className="text-xl font-bold text-gradient">StreamTorrent</h1>
                <p className="text-xs text-gray-500">Streaming P2P</p>
              </div>
            </div>
            <form onSubmit={handleSearch} className="flex-1 max-w-xl">
              <div className="relative group">
                <div className="absolute -inset-0.5 bg-gradient-to-r from-indigo-500 to-pink-500 rounded-full opacity-0 group-hover:opacity-50 blur transition-all duration-300" />
                <div className="relative">
                  <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar filmes e séries..."
                    className="w-full px-5 py-3 pl-12 bg-white/5 border border-white/10 rounded-full focus:outline-none focus:border-indigo-500/50 focus:bg-white/10 text-white placeholder-gray-500 transition-all duration-300" />
                  <svg className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                  {loading && <div className="absolute right-4 top-1/2 -translate-y-1/2"><div className="w-5 h-5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" /></div>}
                </div>
              </div>
            </form>
            <button onClick={() => navigate('/player')} className="hidden sm:flex items-center gap-2 px-4 py-2.5 glass rounded-xl hover:bg-white/10 transition-all duration-300 group">
              <span className="text-lg">🔗</span><span className="text-sm font-medium text-gray-300 group-hover:text-white">Magnet</span>
            </button>
          </div>
          <div className="flex items-center gap-2 mt-4 flex-wrap">
            <span className="text-xs text-gray-500 uppercase tracking-wider">Fontes:</span>
            {Object.values(ADDONS).map(addon => (
              <button key={addon.id} onClick={() => setActiveAddons(prev => prev.includes(addon.id) ? prev.filter(id => id !== addon.id) : [...prev, addon.id])}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-300 ${activeAddons.includes(addon.id) ? `bg-gradient-to-r ${addon.gradient} text-white shadow-lg` : 'glass text-gray-400 hover:text-white hover:bg-white/10'}`}>
                <span>{addon.icon}</span><span>{addon.name}</span>
                {activeAddons.includes(addon.id) && <svg className="w-3 h-3 ml-1" fill="currentColor" viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="relative max-w-7xl mx-auto px-4 sm:px-6 py-8">
        {error && !selectedItem && (
          <div className="mb-6 p-4 glass rounded-xl border border-red-500/30 text-red-300 flex items-center gap-3 animate-slide-up">
            <span className="text-xl">❌</span><span>{error}</span>
          </div>
        )}
        {results.length > 0 && (
          <section className="mb-12 animate-slide-up">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-1 h-8 bg-gradient-to-b from-indigo-500 to-pink-500 rounded-full" />
              <h2 className="text-2xl font-bold">Resultados para "{search}"</h2>
              <span className="text-sm text-gray-500">{results.length} encontrados</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
              {results.map((item, index) => <MovieCard key={`${item.media_type}-${item.id}`} item={item} onClick={fetchStreams} index={index} />)}
            </div>
          </section>
        )}
        {!results.length && (
          <section className="animate-slide-up">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-1 h-8 bg-gradient-to-b from-orange-500 to-red-500 rounded-full" />
              <h2 className="text-2xl font-bold">🔥 Em Alta</h2>
              <span className="text-sm text-gray-500">Top filmes</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
              {isLoadingTrending ? Array(12).fill(0).map((_, i) => <SkeletonCard key={i} />) : trending.map((item, index) => <MovieCard key={item.id} item={{ ...item, media_type: 'movie' }} onClick={fetchStreams} index={index} />)}
            </div>
          </section>
        )}
      </main>

      {selectedItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-scale-in" onClick={() => setSelectedItem(null)}>
          <div className="glass-strong rounded-3xl max-w-2xl w-full max-h-[85vh] overflow-hidden shadow-2xl border border-white/10" onClick={e => e.stopPropagation()}>
            <div className="relative h-52">
              {selectedItem.backdrop_path ? <img src={selectedItem.backdrop_path} alt="" className="w-full h-full object-cover" /> : <div className="w-full h-full bg-gradient-to-br from-indigo-900 to-purple-900" />}
              <div className="absolute inset-0 bg-gradient-to-t from-[#0f0f23] via-[#0f0f23]/50 to-transparent" />
              <button onClick={() => setSelectedItem(null)} className="absolute top-4 right-4 w-10 h-10 rounded-full glass flex items-center justify-center hover:bg-white/20 transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
              <div className="absolute bottom-0 left-0 right-0 p-6">
                <h3 className="text-3xl font-bold mb-2">{selectedItem.title}</h3>
                <div className="flex items-center gap-4 text-sm">
                  {selectedItem.vote_average > 0 && <span className="flex items-center gap-1.5 bg-yellow-500/20 text-yellow-400 px-3 py-1 rounded-full">⭐ {selectedItem.vote_average?.toFixed(1)}</span>}
                  <span className="text-gray-400">📅 {(selectedItem.release_date || selectedItem.first_air_date)?.split('-')[0]}</span>
                  {selectedItem.media_type === 'tv' && <span className="bg-indigo-500/30 text-indigo-300 px-3 py-1 rounded-full">📺 Série</span>}
                </div>
              </div>
            </div>
            <div className="p-6">
              {selectedItem.overview && <p className="text-gray-400 text-sm mb-6 line-clamp-3">{selectedItem.overview}</p>}
              {loadingStreams && (
                <div className="py-8">
                  <div className="flex flex-col items-center gap-4">
                    <div className="relative"><div className="w-12 h-12 border-3 border-indigo-500 border-t-transparent rounded-full animate-spin" /><div className="absolute inset-0 w-12 h-12 border-3 border-pink-500/30 rounded-full animate-ping" /></div>
                    <span className="text-gray-400">Buscando torrents...</span>
                  </div>
                  <div className="flex items-center justify-center gap-2 mt-4 flex-wrap">
                    {Object.values(ADDONS).filter(a => activeAddons.includes(a.id)).map(addon => (
                      <div key={addon.id} className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs transition-all ${loadingAddons[addon.id] ? `bg-gradient-to-r ${addon.gradient} text-white` : 'bg-white/5 text-gray-500'}`}>
                        {loadingAddons[addon.id] ? <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <span>✓</span>}
                        <span>{addon.icon} {addon.name}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {error && <div className="p-4 glass rounded-xl border border-red-500/30 text-red-300 text-sm flex items-center gap-3"><span>❌</span><span>{error}</span></div>}
              {streams.length > 0 && (
                <div className="space-y-2 max-h-72 overflow-y-auto pr-2">
                  <div className="flex items-center justify-between mb-3"><h4 className="text-sm font-medium text-gray-400">📥 {streams.length} torrents encontrados</h4></div>
                  {streams.map((stream, index) => {
                    const { title, quality, size, isDubbed, isLegendado } = parseStreamTitle(stream)
                    return (
                      <button key={index} onClick={() => playStream(stream)} className="w-full p-4 glass rounded-xl text-left transition-all duration-300 hover:bg-white/10 hover:scale-[1.02] group border border-transparent hover:border-indigo-500/30">
                        <div className="flex items-center gap-3">
                          <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${stream.addonGradient} flex items-center justify-center text-lg shadow-lg`}>{stream.addonIcon}</div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-white truncate group-hover:text-indigo-300 transition-colors">{title || 'Stream disponível'}</p>
                            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                              {quality && <span className={`px-2 py-0.5 rounded-md text-xs font-medium ${quality.includes('4K') || quality.includes('2160') ? 'bg-purple-500/20 text-purple-300' : quality.includes('1080') ? 'bg-indigo-500/20 text-indigo-300' : 'bg-gray-500/20 text-gray-300'}`}>{quality}</span>}
                              {isDubbed && <span className="px-2 py-0.5 bg-green-500/20 text-green-300 rounded-md text-xs font-medium">🎙️ Dublado</span>}
                              {isLegendado && <span className="px-2 py-0.5 bg-yellow-500/20 text-yellow-300 rounded-md text-xs font-medium">📝 Leg</span>}
                              {size && <span className="text-xs text-gray-500">{size}</span>}
                            </div>
                          </div>
                          <div className="w-10 h-10 rounded-full bg-gradient-to-r from-indigo-500 to-pink-500 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all scale-75 group-hover:scale-100 shadow-lg shadow-indigo-500/30">
                            <svg className="w-5 h-5 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
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

      <footer className="relative mt-16 py-8 border-t border-white/5">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 text-center">
          <p className="text-sm text-gray-600 flex items-center justify-center gap-2">
            <span className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500/20 to-pink-500/20 flex items-center justify-center">⚡</span>
            <span>Powered by WebTorrent • Use apenas para conteúdo legal</span>
          </p>
        </div>
      </footer>
    </div>
  )
}

export default HomePage
