import React, { useState, useRef, useEffect } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import ShakaVideoPlayer from '../components/player/ShakaVideoPlayer'

const API_URL = '/api'

function PlayerPage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const magnetFromUrl = searchParams.get('magnet') || ''
  
  const [input, setInput] = useState(magnetFromUrl)
  const [streamId, setStreamId] = useState(null)
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [hlsUrl, setHlsUrl] = useState(null)
  const [currentQuality, setCurrentQuality] = useState(null)
  const [downloadSpeed, setDownloadSpeed] = useState(0)
  const [lastDownloadRate, setLastDownloadRate] = useState(0)
  const [lastUpdateTime, setLastUpdateTime] = useState(null)
  
  const playerRef = useRef(null)
  const autoStarted = useRef(false)

  // Iniciar automaticamente se vier magnet na URL
  useEffect(() => {
    if (magnetFromUrl && !autoStarted.current) {
      autoStarted.current = true
      startStream(magnetFromUrl)
    }
  }, [magnetFromUrl])

  // Limpar stream quando sair da página
  useEffect(() => {
    const cleanup = () => {
      if (streamId) {
        navigator.sendBeacon(`${API_URL}/stream/${streamId}`, JSON.stringify({ method: 'DELETE' }))
      }
    }
    
    window.addEventListener('beforeunload', cleanup)
    return () => {
      window.removeEventListener('beforeunload', cleanup)
      if (streamId) {
        fetch(`${API_URL}/stream/${streamId}`, { method: 'DELETE' }).catch(() => {})
      }
    }
  }, [streamId])

  // Polling de status
  useEffect(() => {
    if (!streamId) return

    let cancelled = false
    
    const pollStatus = async () => {
      if (cancelled) return
      
      try {
        const res = await fetch(`${API_URL}/stream/${streamId}/status`)
        if (!res.ok) {
          if (res.status === 404) return
        }
        
        const data = await res.json()
        if (cancelled) return
        
        setStatus(data)
        
        // Calcular velocidade de download (MB/s)
        if (data.downloadRate !== undefined) {
          const now = Date.now()
          if (lastUpdateTime && lastDownloadRate !== undefined) {
            const timeDiff = (now - lastUpdateTime) / 1000 // segundos
            if (timeDiff > 0) {
              const byteDiff = (data.downloadRate - lastDownloadRate) // MB
              const speed = byteDiff / timeDiff // MB/s
              if (speed >= 0) {
                setDownloadSpeed(speed)
              }
            }
          }
          setLastDownloadRate(data.downloadRate)
          setLastUpdateTime(now)
        }

        if (data.status === 'ready' && data.hlsUrl && !hlsUrl) {
          setHlsUrl(data.hlsUrl)
        }

        if (data.status !== 'error') {
          setTimeout(pollStatus, 2000)
        }
      } catch (err) {
        if (!cancelled) {
          console.error('Erro no polling:', err)
          setTimeout(pollStatus, 3000)
        }
      }
    }

    pollStatus()
    
    return () => { cancelled = true }
  }, [streamId, hlsUrl])

  const startStream = async (magnetLink) => {
    if (!magnetLink.trim()) return

    setLoading(true)
    setError(null)
    setStatus(null)
    setStreamId(null)
    setHlsUrl(null)

    // Destruir player anterior
    if (playerRef.current) {
      playerRef.current.destroy()
    }

    try {
      const res = await fetch(`${API_URL}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: magnetLink.trim() })
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.error || 'Erro ao iniciar stream')
      }

      setStreamId(data.id)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    startStream(input)
  }

  const handleStop = async () => {
    if (streamId) {
      if (playerRef.current) {
        playerRef.current.destroy()
      }
      await fetch(`${API_URL}/stream/${streamId}`, { method: 'DELETE' }).catch(() => {})
      setStreamId(null)
      setStatus(null)
      setHlsUrl(null)
    }
  }

  const getStatusLabel = (status) => {
    switch (status) {
      case 'downloading': return '📥 Baixando torrent...'
      case 'transcoding': return '🔄 Transcodificando...'
      case 'ready': return '✅ Reproduzindo'
      case 'error': return '❌ Erro'
      default: return status
    }
  }

  const getStatusColor = (status) => {
    switch (status) {
      case 'downloading': return 'from-blue-600 to-blue-800'
      case 'transcoding': return 'from-yellow-600 to-orange-700'
      case 'ready': return 'from-green-600 to-green-800'
      case 'error': return 'from-red-600 to-red-800'
      default: return 'from-gray-600 to-gray-800'
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-900 to-black text-white">
      {/* Background decorativo */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-80 h-80 bg-red-600/10 rounded-full blur-3xl"></div>
        <div className="absolute -bottom-40 -left-40 w-80 h-80 bg-red-600/5 rounded-full blur-3xl"></div>
      </div>
      
      <div className="relative max-w-6xl mx-auto px-4 py-6">
        {/* Header */}
        <header className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-gradient-to-br from-red-600 to-red-700 rounded-xl flex items-center justify-center shadow-lg shadow-red-600/20">
              <svg className="w-7 h-7 text-white" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z"/>
              </svg>
            </div>
            <div>
              <h1 className="text-2xl font-bold bg-gradient-to-r from-white to-gray-300 bg-clip-text text-transparent">
                WebTorrent Player
              </h1>
              <p className="text-sm text-gray-500">Streaming de torrents no navegador</p>
            </div>
          </div>
          <button
            onClick={() => navigate('/')}
            className="px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg transition-all flex items-center gap-2 text-sm"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
            </svg>
            Catálogo
          </button>
        </header>

        {/* Input Form */}
        <form onSubmit={handleSubmit} className="mb-8">
          <div className="relative">
            <div className="absolute inset-0 bg-gradient-to-r from-red-600/20 to-orange-600/20 rounded-2xl blur-xl"></div>
            <div className="relative bg-gray-800/50 backdrop-blur-xl border border-white/10 rounded-2xl p-4">
              <div className="flex gap-3">
                <div className="flex-1 relative">
                  <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Cole o magnet link ou hash do torrent..."
                    className="w-full px-4 py-3.5 bg-gray-900/50 border border-white/10 rounded-xl 
                      focus:outline-none focus:ring-2 focus:ring-red-500/50 focus:border-red-500/50
                      text-white placeholder-gray-500 text-sm transition-all"
                    disabled={loading}
                  />
                  {input && (
                    <button
                      type="button"
                      onClick={() => setInput('')}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white transition-colors"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>
                <button
                  type="submit"
                  disabled={loading || !input.trim()}
                  className="px-6 py-3.5 bg-gradient-to-r from-red-600 to-red-700 hover:from-red-500 hover:to-red-600 
                    disabled:from-gray-600 disabled:to-gray-700 disabled:cursor-not-allowed 
                    rounded-xl font-medium transition-all shadow-lg shadow-red-600/20 
                    flex items-center gap-2 text-sm"
                >
                  {loading ? (
                    <>
                      <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      <span>Iniciando...</span>
                    </>
                  ) : (
                    <>
                      <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M8 5v14l11-7z"/>
                      </svg>
                      <span>Reproduzir</span>
                    </>
                  )}
                </button>
              </div>
              <p className="text-xs text-gray-500 mt-3 flex items-center gap-1">
                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
                </svg>
                Aceita magnet links completos ou hash de 40 caracteres
              </p>
            </div>
          </div>
        </form>

        {/* Error */}
        {error && (
          <div className="mb-6 p-4 bg-red-900/30 border border-red-500/30 rounded-xl text-red-200 flex items-center gap-3">
            <svg className="w-5 h-5 text-red-400 shrink-0" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
            </svg>
            <span>{error}</span>
          </div>
        )}

        {/* Status Card */}
        {status && (
          <div className={`mb-6 p-5 bg-gradient-to-r ${getStatusColor(status.status)} rounded-2xl shadow-xl`}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-3">
                {status.status === 'downloading' && (
                  <div className="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center">
                    <svg className="w-5 h-5 text-white animate-bounce" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
                    </svg>
                  </div>
                )}
                {status.status === 'transcoding' && (
                  <div className="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center">
                    <svg className="w-5 h-5 text-white animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                  </div>
                )}
                {status.status === 'ready' && (
                  <div className="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center">
                    <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                    </svg>
                  </div>
                )}
                <div>
                  <span className="font-semibold text-white">{getStatusLabel(status.status)}</span>
                  {status.fileName && (
                    <p className="text-sm text-white/70 truncate max-w-md">{status.fileName}</p>
                  )}
                </div>
              </div>
              {streamId && (
                <button
                  onClick={handleStop}
                  className="px-4 py-2 bg-white/20 hover:bg-white/30 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
                >
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M6 6h12v12H6z"/>
                  </svg>
                  Parar
                </button>
              )}
            </div>
            
            {/* Barra de progresso de download */}
            {status.status === 'downloading' && (
              <div className="mt-4">
                <div className="flex justify-between text-sm text-white/80 mb-2">
                  <span>Progresso do download</span>
                  <span>{status.progress?.toFixed(1) || 0}%</span>
                </div>
                <div className="w-full bg-white/20 rounded-full h-2 overflow-hidden">
                  <div 
                    className="bg-white h-full rounded-full transition-all duration-500"
                    style={{ width: `${Math.min(status.progress || 0, 100)}%` }}
                  />
                </div>
              </div>
            )}

            {/* Informações extras */}
            {(status.status === 'downloading' || status.status === 'transcoding') && (
              <div className="flex items-center gap-6 mt-4 text-sm text-white/80 flex-wrap">
                <div className="flex items-center gap-2">
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
                  </svg>
                  <span>Peers: <span className={`font-mono font-bold ${status.peers > 0 ? 'text-green-300' : 'text-red-300'}`}>{status.peers || 0}</span></span>
                </div>
                
                {/* Velocidade de Download */}
                <div className="flex items-center gap-2">
                  <svg className="w-4 h-4 text-green-400" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
                  </svg>
                  <span>Velocidade: <span className={`font-mono font-bold ${downloadSpeed > 1 ? 'text-green-300' : downloadSpeed > 0.1 ? 'text-yellow-300' : 'text-red-300'}`}>
                    {downloadSpeed >= 1 ? downloadSpeed.toFixed(2) : (downloadSpeed * 1024).toFixed(0)} {downloadSpeed >= 1 ? 'MB/s' : 'KB/s'}
                  </span></span>
                </div>
                
                {/* Total baixado */}
                {status.downloadRate > 0 && (
                  <div className="flex items-center gap-2">
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M2 20h20v-4H2v4zm2-3h2v2H4v-2zM2 4v4h20V4H2zm4 3H4V5h2v2zm-4 7h20v-4H2v4zm2-3h2v2H4v-2z"/>
                    </svg>
                    <span>Baixado: <span className="font-mono">{status.downloadRate >= 1024 ? (status.downloadRate / 1024).toFixed(2) + ' GB' : status.downloadRate?.toFixed(1) + ' MB'}</span></span>
                  </div>
                )}
                
                {currentQuality && (
                  <div className="flex items-center gap-2">
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h18v14z"/>
                    </svg>
                    <span>Qualidade: <span className="font-mono">{currentQuality.height}p</span></span>
                  </div>
                )}
              </div>
            )}

            {status.error && (
              <p className="text-red-200 mt-3 text-sm">{status.error}</p>
            )}
          </div>
        )}

        {/* Video Player */}
        {hlsUrl && (
          <div className="mb-8">
            <ShakaVideoPlayer
              ref={playerRef}
              src={hlsUrl}
              autoPlay={true}
              muted={true}
              onReady={() => console.log('🎬 Player pronto!')}
              onError={(err) => setError(err)}
              onQualityChange={(quality) => setCurrentQuality(quality)}
            />
          </div>
        )}

        {/* Instructions */}
        {!streamId && !status && (
          <div className="mt-16 text-center">
            <div className="inline-flex items-center justify-center w-20 h-20 bg-gradient-to-br from-red-600/20 to-orange-600/20 rounded-2xl mb-6">
              <svg className="w-10 h-10 text-red-500" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
              </svg>
            </div>
            <h3 className="text-xl font-semibold mb-4 text-white">Como usar</h3>
            <div className="max-w-md mx-auto text-left space-y-3">
              <div className="flex items-start gap-3 p-3 bg-white/5 rounded-xl">
                <span className="w-6 h-6 bg-red-600 rounded-full flex items-center justify-center text-xs font-bold shrink-0">1</span>
                <span className="text-gray-400 text-sm">Cole um magnet link ou hash de torrent contendo um vídeo</span>
              </div>
              <div className="flex items-start gap-3 p-3 bg-white/5 rounded-xl">
                <span className="w-6 h-6 bg-red-600 rounded-full flex items-center justify-center text-xs font-bold shrink-0">2</span>
                <span className="text-gray-400 text-sm">Clique em "Reproduzir" e aguarde o download iniciar</span>
              </div>
              <div className="flex items-start gap-3 p-3 bg-white/5 rounded-xl">
                <span className="w-6 h-6 bg-red-600 rounded-full flex items-center justify-center text-xs font-bold shrink-0">3</span>
                <span className="text-gray-400 text-sm">O vídeo começará automaticamente com qualidade adaptativa</span>
              </div>
              <div className="flex items-start gap-3 p-3 bg-white/5 rounded-xl">
                <span className="w-6 h-6 bg-red-600 rounded-full flex items-center justify-center text-xs font-bold shrink-0">4</span>
                <span className="text-gray-400 text-sm">Use as teclas de atalho: Espaço (play/pause), F (fullscreen), M (mudo)</span>
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <footer className="mt-16 text-center text-gray-600 text-sm pb-8">
          <p className="flex items-center justify-center gap-2">
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
            </svg>
            Use apenas para conteúdo legal e próprio
          </p>
        </footer>
      </div>
    </div>
  )
}

export default PlayerPage
