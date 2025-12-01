import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import Hls from 'hls.js'

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
  const [buffering, setBuffering] = useState(false)
  const [bufferInfo, setBufferInfo] = useState({ buffered: 0, duration: 0 })
  const [audioTracks, setAudioTracks] = useState([])
  const [currentAudioTrack, setCurrentAudioTrack] = useState(0)
  const videoRef = useRef(null)
  const hlsRef = useRef(null)
  const currentUrlRef = useRef(null)
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

  // Função para inicializar o player HLS
  const initHlsPlayer = useCallback((hlsUrl) => {
    if (!videoRef.current) return

    // Evitar inicialização duplicada
    if (currentUrlRef.current === hlsUrl && hlsRef.current) {
      return
    }

    // Destruir instância anterior
    if (hlsRef.current) {
      hlsRef.current.destroy()
      hlsRef.current = null
    }

    currentUrlRef.current = hlsUrl

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 60,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        maxBufferSize: 60 * 1000 * 1000,
        maxBufferHole: 0.5,
        fragLoadingTimeOut: 20000,
        fragLoadingMaxRetry: 6,
        fragLoadingRetryDelay: 1000,
        manifestLoadingTimeOut: 20000,
        manifestLoadingMaxRetry: 4,
        levelLoadingTimeOut: 20000,
        levelLoadingMaxRetry: 4,
        startLevel: -1,
        abrEwmaDefaultEstimate: 500000,
      })

      hls.loadSource(hlsUrl)
      hls.attachMedia(videoRef.current)
      
      hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
        console.log('Manifest parsed, iniciando reprodução...')
        setBuffering(true)
        
        // Detectar faixas de áudio disponíveis
        if (data.audioTracks && data.audioTracks.length > 0) {
          setAudioTracks(data.audioTracks)
          setCurrentAudioTrack(0)
        }
        
        const video = videoRef.current
        if (video) {
          const playPromise = video.play()
          
          if (playPromise !== undefined) {
            playPromise
              .then(() => {
                console.log('Reprodução iniciada com sucesso')
                setBuffering(false)
              })
              .catch((error) => {
                console.log('Autoplay bloqueado:', error.message)
                setBuffering(false)
              })
          }
        }
      })

      // Atualizar lista de faixas de áudio
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, (event, data) => {
        if (data.audioTracks && data.audioTracks.length > 0) {
          setAudioTracks(data.audioTracks)
        }
      })

      // Atualizar faixa de áudio atual
      hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (event, data) => {
        setCurrentAudioTrack(data.id)
      })

      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        setBuffering(false)
      })

      hls.on(Hls.Events.ERROR, (event, data) => {
        // Só logar erros fatais para evitar spam no console
        if (data.fatal) {
          console.log('HLS Fatal Error:', data.type, data.details)
          
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              console.log('Erro de rede, tentando reconectar em 2s...')
              setTimeout(() => {
                if (hlsRef.current === hls) {
                  hls.startLoad()
                }
              }, 2000)
              break
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.log('Erro de mídia, tentando recuperar...')
              hls.recoverMediaError()
              break
            default:
              console.log('Erro fatal irrecuperável')
              break
          }
        }
      })

      hlsRef.current = hls
    } else if (videoRef.current.canPlayType('application/vnd.apple.mpegurl')) {
      videoRef.current.src = hlsUrl
    }
  }, [])

  // Polling de status
  useEffect(() => {
    if (!streamId) return

    let cancelled = false
    
    const pollStatus = async () => {
      if (cancelled) return
      
      try {
        const res = await fetch(`${API_URL}/stream/${streamId}/status`)
        if (!res.ok) {
          if (res.status === 404) {
            return
          }
        }
        
        const data = await res.json()
        if (cancelled) return
        
        setStatus(data)

        if (data.status === 'ready' && data.hlsUrl) {
          initHlsPlayer(data.hlsUrl)
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
    
    return () => {
      cancelled = true
    }
  }, [streamId, initHlsPlayer])

  const startStream = async (magnetLink) => {
    if (!magnetLink.trim()) return

    setLoading(true)
    setError(null)
    setStatus(null)
    setStreamId(null)

    // Destruir player anterior
    if (hlsRef.current) {
      hlsRef.current.destroy()
      hlsRef.current = null
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
      if (hlsRef.current) {
        hlsRef.current.destroy()
        hlsRef.current = null
      }
      await fetch(`${API_URL}/stream/${streamId}`, { method: 'DELETE' }).catch(() => {})
      setStreamId(null)
      setStatus(null)
      setAudioTracks([])
      setBufferInfo({ buffered: 0, duration: 0 })
    }
  }

  // Trocar faixa de áudio
  const changeAudioTrack = (trackId) => {
    if (hlsRef.current) {
      hlsRef.current.audioTrack = trackId
      setCurrentAudioTrack(trackId)
    }
  }

  // Atualizar informações de buffer
  const updateBufferInfo = useCallback(() => {
    const video = videoRef.current
    if (video && video.buffered.length > 0) {
      const currentTime = video.currentTime
      let bufferedEnd = 0
      
      // Encontrar o range de buffer que contém o tempo atual
      for (let i = 0; i < video.buffered.length; i++) {
        if (video.buffered.start(i) <= currentTime && video.buffered.end(i) >= currentTime) {
          bufferedEnd = video.buffered.end(i)
          break
        }
      }
      
      setBufferInfo({
        buffered: Math.max(0, bufferedEnd - currentTime),
        duration: video.duration || 0
      })
    }
  }, [])

  // Monitorar buffer periodicamente
  useEffect(() => {
    if (!streamId || status?.status !== 'ready') return
    
    const interval = setInterval(updateBufferInfo, 1000)
    return () => clearInterval(interval)
  }, [streamId, status?.status, updateBufferInfo])

  const getStatusLabel = (status) => {
    switch (status) {
      case 'downloading': return '📥 Baixando torrent...'
      case 'transcoding': return '🔄 Transcodificando...'
      case 'ready': return '✅ Reproduzindo'
      case 'error': return '❌ Erro'
      default: return status
    }
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white p-4">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <header className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-4xl font-bold mb-2">🎬 WebTorrent Player</h1>
            <p className="text-gray-400">Reproduza vídeos de torrents diretamente no navegador</p>
          </div>
          <button
            onClick={() => navigate('/')}
            className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors flex items-center gap-2"
          >
            🏠 Catálogo
          </button>
        </header>

        {/* Input Form */}
        <form onSubmit={handleSubmit} className="mb-8">
          <div className="flex gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Cole o magnet link ou hash do torrent (ex: 08ada5a7a6183aae1e09d831df6748d566095a10)"
              className="flex-1 px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-white placeholder-gray-500"
              disabled={loading}
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="px-6 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed rounded-lg font-medium transition-colors"
            >
              {loading ? '⏳ Iniciando...' : '▶️ Reproduzir'}
            </button>
          </div>
          <p className="text-xs text-gray-500 mt-2">
            Aceita magnet links completos ou apenas o hash de 40 caracteres
          </p>
        </form>

        {/* Error */}
        {error && (
          <div className="mb-6 p-4 bg-red-900/50 border border-red-700 rounded-lg text-red-200">
            ❌ {error}
          </div>
        )}

        {/* Status */}
        {status && (
          <div className="mb-6 p-4 bg-gray-800 rounded-lg">
            <div className="flex items-center justify-between mb-2">
              <span className="font-medium">{getStatusLabel(status.status)}</span>
              {streamId && (
                <button
                  onClick={handleStop}
                  className="px-3 py-1 bg-red-600 hover:bg-red-700 rounded text-sm"
                >
                  ⏹️ Parar
                </button>
              )}
            </div>
            
            {status.fileName && (
              <p className="text-sm text-gray-400 mb-2">📁 {status.fileName}</p>
            )}

            {status.status === 'downloading' && (
              <div className="w-full bg-gray-700 rounded-full h-2">
                <div 
                  className="bg-blue-500 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${Math.min(status.progress, 100)}%` }}
                />
              </div>
            )}

            {status.progress > 0 && status.progress < 100 && (
              <p className="text-xs text-gray-500 mt-1">{status.progress.toFixed(1)}% baixado</p>
            )}

            {/* Mostrador de Peers e Download */}
            {(status.status === 'downloading' || status.status === 'transcoding') && (
              <div className="flex items-center gap-4 mt-2 text-sm">
                <div className="flex items-center gap-1">
                  <span className="text-gray-400">👥 Peers:</span>
                  <span className={`font-mono ${status.peers > 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {status.peers || 0}
                  </span>
                </div>
                {status.downloadRate > 0 && (
                  <div className="flex items-center gap-1">
                    <span className="text-gray-400">⬇️ Download:</span>
                    <span className="font-mono text-blue-400">
                      {status.downloadRate.toFixed(2)} MB
                    </span>
                  </div>
                )}
              </div>
            )}

            {status.error && (
              <p className="text-red-400 mt-2">{status.error}</p>
            )}
          </div>
        )}

        {/* Video Player */}
        {streamId && (
          <div className="video-container mx-auto shadow-2xl relative">
            {buffering && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/50 z-10 pointer-events-none">
                <div className="text-center">
                  <div className="animate-spin rounded-full h-12 w-12 border-4 border-blue-500 border-t-transparent mx-auto mb-2"></div>
                  <p className="text-white">Carregando...</p>
                </div>
              </div>
            )}
            <video
              ref={videoRef}
              controls
              playsInline
              autoPlay
              muted
              className="w-full"
              poster="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 9'%3E%3Crect fill='%23000'/%3E%3C/svg%3E"
              onWaiting={() => setBuffering(true)}
              onPlaying={() => setBuffering(false)}
              onCanPlay={() => setBuffering(false)}
              onTimeUpdate={updateBufferInfo}
            >
              Seu navegador não suporta reprodução de vídeo.
            </video>
            
            {/* Controles extras: Buffer e Idioma */}
            {status?.status === 'ready' && (
              <div className="mt-3 p-3 bg-gray-800 rounded-lg flex flex-wrap items-center gap-4">
                {/* Indicador de Buffer */}
                <div className="flex items-center gap-2">
                  <span className="text-gray-400 text-sm">📊 Buffer:</span>
                  <div className="flex items-center gap-1">
                    <div className="w-24 h-2 bg-gray-700 rounded-full overflow-hidden">
                      <div 
                        className={`h-full rounded-full transition-all duration-300 ${
                          bufferInfo.buffered > 10 ? 'bg-green-500' : 
                          bufferInfo.buffered > 5 ? 'bg-yellow-500' : 'bg-red-500'
                        }`}
                        style={{ width: `${Math.min((bufferInfo.buffered / 30) * 100, 100)}%` }}
                      />
                    </div>
                    <span className={`text-sm font-mono ${
                      bufferInfo.buffered > 10 ? 'text-green-400' : 
                      bufferInfo.buffered > 5 ? 'text-yellow-400' : 'text-red-400'
                    }`}>
                      {bufferInfo.buffered.toFixed(0)}s
                    </span>
                  </div>
                </div>

                {/* Seletor de Idioma/Áudio */}
                {audioTracks.length > 1 && (
                  <div className="flex items-center gap-2">
                    <span className="text-gray-400 text-sm">🔊 Áudio:</span>
                    <select
                      value={currentAudioTrack}
                      onChange={(e) => changeAudioTrack(parseInt(e.target.value))}
                      className="bg-gray-700 text-white text-sm rounded px-2 py-1 border border-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    >
                      {audioTracks.map((track, index) => (
                        <option key={track.id || index} value={track.id || index}>
                          {track.name || track.lang || `Faixa ${index + 1}`}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Info de duração */}
                {bufferInfo.duration > 0 && (
                  <div className="text-gray-400 text-sm ml-auto">
                    ⏱️ Duração: {Math.floor(bufferInfo.duration / 60)}:{(Math.floor(bufferInfo.duration % 60)).toString().padStart(2, '0')}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Instructions */}
        {!streamId && (
          <div className="mt-12 text-center text-gray-500">
            <h3 className="text-lg font-medium mb-4">Como usar</h3>
            <ol className="text-sm space-y-2 max-w-md mx-auto text-left">
              <li>1. Cole um magnet link ou hash de torrent contendo um vídeo</li>
              <li>2. Clique em "Reproduzir" e aguarde o download iniciar</li>
              <li>3. O vídeo começará automaticamente quando estiver pronto</li>
              <li>4. Os arquivos são automaticamente removidos ao sair da página</li>
            </ol>
          </div>
        )}

        {/* Footer */}
        <footer className="mt-12 text-center text-gray-600 text-sm">
          <p>⚠️ Use apenas para conteúdo legal e próprio</p>
        </footer>
      </div>
    </div>
  )
}

export default PlayerPage
