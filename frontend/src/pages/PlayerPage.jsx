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
  const [downloaded, setDownloaded] = useState(0)
  const [peakSpeed, setPeakSpeed] = useState(0)
  
  const playerRef = useRef(null)
  const autoStarted = useRef(false)

  useEffect(() => {
    if (magnetFromUrl && !autoStarted.current) {
      autoStarted.current = true
      startStream(magnetFromUrl)
    }
  }, [magnetFromUrl])

  useEffect(() => {
    const cleanup = () => {
      if (streamId) {
        navigator.sendBeacon(`${API_URL}/stream/${streamId}`, JSON.stringify({ method: 'DELETE' }))
      }
    }
    window.addEventListener('beforeunload', cleanup)
    return () => {
      window.removeEventListener('beforeunload', cleanup)
      if (streamId) fetch(`${API_URL}/stream/${streamId}`, { method: 'DELETE' }).catch(() => {})
    }
  }, [streamId])

  useEffect(() => {
    if (!streamId) return
    let cancelled = false
    
    const pollStatus = async () => {
      if (cancelled) return
      try {
        const res = await fetch(`${API_URL}/stream/${streamId}/status`)
        if (!res.ok && res.status === 404) return
        const data = await res.json()
        if (cancelled) return
        setStatus(data)
        
        // Usar velocidade diretamente do backend
        if (data.speed !== undefined && data.speed !== null) {
          setDownloadSpeed(data.speed)
          if (data.speed > peakSpeed) setPeakSpeed(data.speed)
        }
        
        if (data.downloaded !== undefined) {
          setDownloaded(data.downloaded)
        }

        if (data.status === 'ready' && data.hlsUrl && !hlsUrl) setHlsUrl(data.hlsUrl)
        if (data.status !== 'error') setTimeout(pollStatus, 1000)
      } catch (err) {
        if (!cancelled) setTimeout(pollStatus, 3000)
      }
    }
    pollStatus()
    return () => { cancelled = true }
  }, [streamId, hlsUrl, peakSpeed])

  const startStream = async (magnetLink) => {
    if (!magnetLink.trim()) return
    setLoading(true); setError(null); setStatus(null); setStreamId(null); setHlsUrl(null)
    setDownloadSpeed(0); setPeakSpeed(0); setDownloaded(0)
    if (playerRef.current) playerRef.current.destroy()

    try {
      const res = await fetch(`${API_URL}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: magnetLink.trim() })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Erro ao iniciar stream')
      setStreamId(data.id)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleSubmit = (e) => { e.preventDefault(); startStream(input) }

  const handleStop = async () => {
    if (streamId) {
      if (playerRef.current) playerRef.current.destroy()
      await fetch(`${API_URL}/stream/${streamId}`, { method: 'DELETE' }).catch(() => {})
      setStreamId(null); setStatus(null); setHlsUrl(null)
    }
  }

  const formatSpeed = (mbps) => {
    if (mbps >= 1) return { value: mbps.toFixed(2), unit: 'MB/s', color: 'text-green-400' }
    if (mbps >= 0.1) return { value: (mbps * 1024).toFixed(0), unit: 'KB/s', color: 'text-yellow-400' }
    if (mbps > 0) return { value: (mbps * 1024).toFixed(0), unit: 'KB/s', color: 'text-orange-400' }
    return { value: '0', unit: 'KB/s', color: 'text-gray-500' }
  }

  const formatSize = (mb) => {
    if (mb >= 1024) return { value: (mb / 1024).toFixed(2), unit: 'GB' }
    return { value: mb.toFixed(1), unit: 'MB' }
  }

  const getStatusInfo = (st) => {
    const info = {
      downloading: { icon: '📥', label: 'Baixando...', gradient: 'from-blue-500 to-cyan-500' },
      transcoding: { icon: '⚡', label: 'Transcodificando...', gradient: 'from-amber-500 to-orange-500' },
      ready: { icon: '▶️', label: 'Reproduzindo', gradient: 'from-green-500 to-emerald-500' },
      error: { icon: '❌', label: 'Erro', gradient: 'from-red-500 to-rose-500' }
    }
    return info[st] || { icon: '⏳', label: st, gradient: 'from-gray-500 to-gray-600' }
  }

  const speed = formatSpeed(downloadSpeed)
  const peak = formatSpeed(peakSpeed)
  const size = formatSize(downloaded)

  return (
    <div className="min-h-screen relative overflow-hidden">
      {/* Background */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute -top-40 -right-40 w-[500px] h-[500px] bg-indigo-600/20 rounded-full blur-[120px] animate-float" />
        <div className="absolute -bottom-40 -left-40 w-[400px] h-[400px] bg-pink-600/15 rounded-full blur-[100px] animate-float" style={{ animationDelay: '-3s' }} />
      </div>
      
      <div className="relative max-w-6xl mx-auto px-4 py-6">
        {/* Header */}
        <header className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-indigo-500 to-pink-500 flex items-center justify-center shadow-lg shadow-indigo-500/30">
              <svg className="w-7 h-7 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gradient">StreamTorrent</h1>
              <p className="text-sm text-gray-500">Player de torrents P2P</p>
            </div>
          </div>
          <button onClick={() => navigate('/')} className="px-4 py-2.5 glass rounded-xl hover:bg-white/10 transition-all flex items-center gap-2 text-sm group">
            <svg className="w-4 h-4 group-hover:-translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            Catálogo
          </button>
        </header>

        {/* Input Form */}
        <form onSubmit={handleSubmit} className="mb-8">
          <div className="relative group">
            <div className="absolute -inset-1 bg-gradient-to-r from-indigo-500 to-pink-500 rounded-2xl opacity-20 group-hover:opacity-40 blur-xl transition-all duration-500" />
            <div className="relative glass-strong rounded-2xl p-5">
              <div className="flex gap-3">
                <div className="flex-1 relative">
                  <input type="text" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Cole o magnet link ou hash do torrent..."
                    className="w-full px-5 py-4 bg-white/5 border border-white/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 text-white placeholder-gray-500 transition-all" disabled={loading} />
                  {input && (
                    <button type="button" onClick={() => setInput('')} className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white transition-colors">
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                  )}
                </div>
                <button type="submit" disabled={loading || !input.trim()}
                  className="px-8 py-4 bg-gradient-to-r from-indigo-500 to-pink-500 hover:from-indigo-400 hover:to-pink-400 disabled:from-gray-600 disabled:to-gray-700 disabled:cursor-not-allowed rounded-xl font-semibold transition-all shadow-lg shadow-indigo-500/30 flex items-center gap-3">
                  {loading ? (
                    <><div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" /><span>Iniciando...</span></>
                  ) : (
                    <><svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg><span>Reproduzir</span></>
                  )}
                </button>
              </div>
              <p className="text-xs text-gray-500 mt-3 flex items-center gap-2">
                <span className="w-4 h-4 rounded-full bg-indigo-500/20 flex items-center justify-center text-[10px]">i</span>
                Aceita magnet links completos ou hash de 40 caracteres
              </p>
            </div>
          </div>
        </form>

        {/* Error */}
        {error && (
          <div className="mb-6 p-4 glass rounded-xl border border-red-500/30 text-red-300 flex items-center gap-3 animate-slide-up">
            <span className="text-xl">❌</span><span>{error}</span>
          </div>
        )}

        {/* Status Card */}
        {status && (
          <div className="mb-6 glass-strong rounded-2xl overflow-hidden animate-slide-up">
            {/* Status Header */}
            <div className={`p-5 bg-gradient-to-r ${getStatusInfo(status.status).gradient}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-white/20 backdrop-blur flex items-center justify-center text-2xl">
                    {status.status === 'downloading' && <span className="animate-bounce">📥</span>}
                    {status.status === 'transcoding' && <span className="animate-pulse">⚡</span>}
                    {status.status === 'ready' && <span>▶️</span>}
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-white">{getStatusInfo(status.status).label}</h3>
                    {status.fileName && <p className="text-sm text-white/70 truncate max-w-md">{status.fileName}</p>}
                  </div>
                </div>
                {streamId && (
                  <button onClick={handleStop} className="px-4 py-2 bg-white/20 hover:bg-white/30 rounded-xl text-sm font-medium transition-all flex items-center gap-2 backdrop-blur">
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 6h12v12H6z"/></svg>
                    Parar
                  </button>
                )}
              </div>
            </div>

            {/* Stats Grid */}
            {(status.status === 'downloading' || status.status === 'transcoding' || status.status === 'ready') && (
              <div className="p-5">
                {/* Progress Bar */}
                <div className="mb-5">
                  <div className="flex justify-between text-sm mb-2">
                    <span className="text-gray-400">Progresso do download</span>
                    <span className="font-mono text-white">{status.progress?.toFixed(1) || 0}%</span>
                  </div>
                  <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-indigo-500 to-pink-500 rounded-full transition-all duration-500 relative"
                      style={{ width: `${Math.min(status.progress || 0, 100)}%` }}>
                      <div className="absolute inset-0 bg-white/30 animate-pulse" />
                    </div>
                  </div>
                </div>

                {/* Stats Cards */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  {/* Download Speed */}
                  <div className="glass rounded-xl p-4 relative overflow-hidden">
                    <div className="absolute inset-0 bg-gradient-to-br from-green-500/10 to-transparent" />
                    <div className="relative">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-lg">⬇️</span>
                        <span className="text-xs text-gray-500 uppercase tracking-wider">Velocidade</span>
                      </div>
                      <div className="flex items-baseline gap-1">
                        <span className={`text-2xl font-bold tabular-nums ${speed.color} transition-colors`}>
                          {speed.value}
                        </span>
                        <span className="text-xs text-gray-500">{speed.unit}</span>
                      </div>
                    </div>
                  </div>

                  {/* Peak Speed */}
                  <div className="glass rounded-xl p-4 relative overflow-hidden">
                    <div className="absolute inset-0 bg-gradient-to-br from-purple-500/10 to-transparent" />
                    <div className="relative">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-lg">📈</span>
                        <span className="text-xs text-gray-500 uppercase tracking-wider">Pico</span>
                      </div>
                      <div className="flex items-baseline gap-1">
                        <span className="text-2xl font-bold tabular-nums text-purple-400">{peak.value}</span>
                        <span className="text-xs text-gray-500">{peak.unit}</span>
                      </div>
                    </div>
                  </div>

                  {/* Peers */}
                  <div className="glass rounded-xl p-4 relative overflow-hidden">
                    <div className="absolute inset-0 bg-gradient-to-br from-blue-500/10 to-transparent" />
                    <div className="relative">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-lg">👥</span>
                        <span className="text-xs text-gray-500 uppercase tracking-wider">Peers</span>
                      </div>
                      <div className="flex items-baseline gap-1">
                        <span className={`text-2xl font-bold tabular-nums ${status.peers > 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {status.peers || 0}
                        </span>
                        <span className="text-xs text-gray-500">conectados</span>
                      </div>
                    </div>
                  </div>

                  {/* Downloaded */}
                  <div className="glass rounded-xl p-4 relative overflow-hidden">
                    <div className="absolute inset-0 bg-gradient-to-br from-cyan-500/10 to-transparent" />
                    <div className="relative">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-lg">💾</span>
                        <span className="text-xs text-gray-500 uppercase tracking-wider">Baixado</span>
                      </div>
                      <div className="flex items-baseline gap-1">
                        <span className="text-2xl font-bold tabular-nums text-cyan-400">{size.value}</span>
                        <span className="text-xs text-gray-500">{size.unit}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Video Player */}
        {hlsUrl && (
          <div className="mb-8 animate-scale-in">
            <ShakaVideoPlayer ref={playerRef} src={hlsUrl} autoPlay={true} muted={true}
              onReady={() => console.log('🎬 Player pronto!')}
              onError={(err) => setError(err)}
              onQualityChange={(quality) => setCurrentQuality(quality)} />
          </div>
        )}

        {/* Instructions */}
        {!streamId && !status && (
          <div className="mt-16 text-center animate-slide-up">
            <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-gradient-to-br from-indigo-500/20 to-pink-500/20 mb-6">
              <span className="text-4xl">🎬</span>
            </div>
            <h3 className="text-2xl font-bold mb-6 text-gradient">Como usar</h3>
            <div className="max-w-md mx-auto space-y-4">
              {[
                { num: 1, text: 'Cole um magnet link ou hash de torrent' },
                { num: 2, text: 'Clique em "Reproduzir" e aguarde o download' },
                { num: 3, text: 'O vídeo inicia com qualidade adaptativa (ABR)' },
                { num: 4, text: 'Use ⚙️ para áudio, legendas e qualidade' }
              ].map(step => (
                <div key={step.num} className="flex items-center gap-4 p-4 glass rounded-xl text-left group hover:bg-white/5 transition-all">
                  <span className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-pink-500 flex items-center justify-center text-sm font-bold shadow-lg">{step.num}</span>
                  <span className="text-gray-400 group-hover:text-white transition-colors">{step.text}</span>
                </div>
              ))}
            </div>
            <div className="mt-8 p-4 glass rounded-xl inline-flex items-center gap-4 flex-wrap justify-center">
              <span className="text-gray-500">Atalhos:</span>
              <div className="flex items-center gap-2"><span className="px-2 py-1 bg-white/10 rounded text-xs">Espaço</span><span className="text-gray-500">play/pause</span></div>
              <div className="flex items-center gap-2"><span className="px-2 py-1 bg-white/10 rounded text-xs">F</span><span className="text-gray-500">fullscreen</span></div>
              <div className="flex items-center gap-2"><span className="px-2 py-1 bg-white/10 rounded text-xs">M</span><span className="text-gray-500">mudo</span></div>
            </div>
          </div>
        )}

        {/* Footer */}
        <footer className="mt-16 text-center text-gray-600 text-sm pb-8">
          <p className="flex items-center justify-center gap-2">
            <span className="w-6 h-6 rounded-lg bg-gradient-to-br from-indigo-500/20 to-pink-500/20 flex items-center justify-center text-xs">⚡</span>
            Use apenas para conteúdo legal e próprio
          </p>
        </footer>
      </div>
    </div>
  )
}

export default PlayerPage
