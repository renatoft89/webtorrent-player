import React, { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from 'react'
import shaka from 'shaka-player'

const ShakaVideoPlayer = forwardRef(({ 
  src, 
  poster,
  onReady,
  onError,
  onBuffering,
  onTimeUpdate,
  onQualityChange,
  autoPlay = true,
  muted = true 
}, ref) => {
  const videoRef = useRef(null)
  const containerRef = useRef(null)
  const playerRef = useRef(null)
  const initializingRef = useRef(false)
  const currentSrcRef = useRef(null)
  
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(1)
  const [isMuted, setIsMuted] = useState(muted)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showControls, setShowControls] = useState(true)
  const [bufferedPercent, setBufferedPercent] = useState(0)
  const [qualities, setQualities] = useState([])
  const [currentQuality, setCurrentQuality] = useState('auto')
  const [playbackRate, setPlaybackRate] = useState(1)
  const [showSettings, setShowSettings] = useState(false)
  const [settingsTab, setSettingsTab] = useState('quality') // 'quality', 'audio', 'subtitles', 'speed'
  const [isBuffering, setIsBuffering] = useState(false)
  
  // Faixas de áudio e legendas
  const [audioTracks, setAudioTracks] = useState([])
  const [currentAudioTrack, setCurrentAudioTrack] = useState(null)
  const [textTracks, setTextTracks] = useState([])
  const [currentTextTrack, setCurrentTextTrack] = useState(null)
  
  const controlsTimeoutRef = useRef(null)

  // Expor métodos via ref
  useImperativeHandle(ref, () => ({
    play: () => videoRef.current?.play(),
    pause: () => videoRef.current?.pause(),
    seek: (time) => { if (videoRef.current) videoRef.current.currentTime = time },
    getPlayer: () => playerRef.current,
    destroy: async () => {
      if (playerRef.current) {
        await playerRef.current.destroy()
        playerRef.current = null
      }
    }
  }))

  // Inicializar Shaka Player - apenas quando src muda
  useEffect(() => {
    if (!src || !videoRef.current) return
    
    // Evitar inicialização duplicada
    if (initializingRef.current) return
    if (currentSrcRef.current === src) return
    
    initializingRef.current = true

    const initPlayer = async () => {
      try {
        // Instalar polyfills apenas uma vez
        shaka.polyfill.installAll()

        if (!shaka.Player.isBrowserSupported()) {
          console.error('Navegador não suportado pelo Shaka Player')
          onError?.('Navegador não suportado')
          initializingRef.current = false
          return
        }

        // Destruir player anterior se existir
        if (playerRef.current) {
          try {
            await playerRef.current.destroy()
          } catch (e) {
            console.warn('Erro ao destruir player anterior:', e)
          }
          playerRef.current = null
        }

        // Usar API moderna com attach()
        const player = new shaka.Player()
        await player.attach(videoRef.current)
        playerRef.current = player
        currentSrcRef.current = src

        // Configuração otimizada para streaming com ABR inteligente
        player.configure({
          streaming: {
            bufferingGoal: 30,
            rebufferingGoal: 2,
            bufferBehind: 30,
            retryParameters: {
              maxAttempts: 5,
              baseDelay: 500,
              backoffFactor: 2,
              fuzzFactor: 0.3
            },
            startAtSegmentBoundary: false
          },
          abr: {
            enabled: true,
            // Estimativa inicial alta (10 Mbps) - assumir boa conexão
            defaultBandwidthEstimate: 10000000,
            // Switch rápido (a cada 2 segundos avaliar)
            switchInterval: 2,
            // Subir de qualidade quando tiver 60% de margem
            bandwidthUpgradeTarget: 0.6,
            // Descer apenas quando estiver muito apertado (95%)
            bandwidthDowngradeTarget: 0.95,
            // Não restringir por tamanho - deixar ABR decidir
            restrictToElementSize: false,
            restrictToScreenSize: false,
            // Usar histórico de bandwidth para decisões melhores
            useNetworkInformation: true
          }
        })
        
        console.log('🎬 Shaka Player configurado com ABR inteligente')

        // Event listeners
        player.addEventListener('error', (event) => {
          console.error('Shaka Error:', event.detail)
          onError?.(event.detail?.message || 'Erro no player')
        })

        player.addEventListener('buffering', (event) => {
          setIsBuffering(event.buffering)
          onBuffering?.(event.buffering)
        })

        player.addEventListener('adaptation', () => {
          const tracks = player.getVariantTracks()
          const active = tracks.find(t => t.active)
          if (active) {
            console.log(`🔄 ABR mudou para: ${active.height}p (bandwidth: ${(active.bandwidth/1000000).toFixed(2)} Mbps)`)
            setCurrentQuality(`${active.height}p`)
            onQualityChange?.(active)
          }
        })

        player.addEventListener('trackschanged', () => {
          const tracks = player.getVariantTracks()
          const uniqueHeights = [...new Set(tracks.map(t => t.height))].sort((a, b) => b - a)
          setQualities(['auto', ...uniqueHeights.map(h => `${h}p`)])
          console.log('📊 Qualidades disponíveis:', uniqueHeights.map(h => `${h}p`).join(', '))
          
          // Atualizar faixas de áudio
          updateAudioTracks(player)
          
          // Atualizar legendas
          updateTextTracks(player)
        })

        // Carregar mídia
        await player.load(src)
        console.log('🎬 Shaka Player carregado com sucesso')
        
        // Configurar qualidades
        const tracks = player.getVariantTracks()
        const uniqueHeights = [...new Set(tracks.map(t => t.height))].sort((a, b) => b - a)
        setQualities(['auto', ...uniqueHeights.map(h => `${h}p`)])
        
        // Log detalhado das tracks
        console.log('📺 Variant tracks encontradas:', tracks.length)
        tracks.forEach(t => {
          console.log(`  - ${t.height}p: bandwidth=${t.bandwidth}, active=${t.active}`)
        })
        
        // Se houver qualidades altas disponíveis, tentar selecionar a melhor
        if (tracks.length > 1) {
          const highestTrack = tracks.reduce((a, b) => (a.height > b.height ? a : b))
          console.log(`🎯 Maior qualidade disponível: ${highestTrack.height}p`)
        }
        
        // Configurar faixas de áudio
        updateAudioTracks(player)
        
        // Configurar legendas
        updateTextTracks(player)
        
        // Tentar autoplay após um pequeno delay
        if (autoPlay && videoRef.current) {
          setTimeout(async () => {
            try {
              await videoRef.current?.play()
            } catch (e) {
              console.log('Autoplay bloqueado:', e.message)
            }
          }, 200)
        }
        
        onReady?.()
      } catch (e) {
        console.error('Erro ao carregar mídia:', e)
        onError?.(e.message)
        currentSrcRef.current = null
      } finally {
        initializingRef.current = false
      }
    }

    initPlayer()

    // Cleanup
    return () => {
      const cleanup = async () => {
        if (playerRef.current) {
          try {
            await playerRef.current.destroy()
          } catch (e) {
            // Ignorar erros no cleanup
          }
          playerRef.current = null
        }
      }
      cleanup()
      currentSrcRef.current = null
    }
  }, [src]) // Apenas src como dependência

  // Monitorar eventos do vídeo
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const handleTimeUpdate = () => {
      setCurrentTime(video.currentTime)
      
      // Atualizar duração se disponível (útil para streams que carregam a duração depois)
      if (video.duration && isFinite(video.duration) && video.duration > 0) {
        setDuration(video.duration)
      }
      
      onTimeUpdate?.(video.currentTime, video.duration)
      
      // Calcular buffer
      if (video.buffered.length > 0 && video.duration && isFinite(video.duration)) {
        const buffered = video.buffered.end(video.buffered.length - 1)
        setBufferedPercent((buffered / video.duration) * 100)
      }
    }

    const handleDurationChange = () => {
      if (video.duration && isFinite(video.duration) && video.duration > 0) {
        setDuration(video.duration)
        console.log('⏱️ Duração do vídeo:', formatTime(video.duration))
      }
    }
    
    const handleLoadedMetadata = () => {
      if (video.duration && isFinite(video.duration) && video.duration > 0) {
        setDuration(video.duration)
        console.log('📼 Metadados carregados, duração:', formatTime(video.duration))
      }
    }
    const handlePlay = () => setIsPlaying(true)
    const handlePause = () => setIsPlaying(false)
    const handleVolumeChange = () => {
      setVolume(video.volume)
      setIsMuted(video.muted)
    }
    const handleWaiting = () => setIsBuffering(true)
    const handleCanPlay = () => setIsBuffering(false)

    video.addEventListener('timeupdate', handleTimeUpdate)
    video.addEventListener('durationchange', handleDurationChange)
    video.addEventListener('loadedmetadata', handleLoadedMetadata)
    video.addEventListener('play', handlePlay)
    video.addEventListener('pause', handlePause)
    video.addEventListener('volumechange', handleVolumeChange)
    video.addEventListener('waiting', handleWaiting)
    video.addEventListener('canplay', handleCanPlay)

    return () => {
      video.removeEventListener('timeupdate', handleTimeUpdate)
      video.removeEventListener('durationchange', handleDurationChange)
      video.removeEventListener('loadedmetadata', handleLoadedMetadata)
      video.removeEventListener('play', handlePlay)
      video.removeEventListener('pause', handlePause)
      video.removeEventListener('volumechange', handleVolumeChange)
      video.removeEventListener('waiting', handleWaiting)
      video.removeEventListener('canplay', handleCanPlay)
    }
  }, [onTimeUpdate])

  // Controle de visibilidade dos controles
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const showControlsHandler = () => {
      setShowControls(true)
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current)
      }
      controlsTimeoutRef.current = setTimeout(() => {
        if (isPlaying) setShowControls(false)
      }, 3000)
    }

    container.addEventListener('mousemove', showControlsHandler)
    container.addEventListener('touchstart', showControlsHandler)

    return () => {
      container.removeEventListener('mousemove', showControlsHandler)
      container.removeEventListener('touchstart', showControlsHandler)
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current)
      }
    }
  }, [isPlaying])

  // Fullscreen
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement)
    }

    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])

  // Funções de controle
  const togglePlay = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      video.play()
    } else {
      video.pause()
    }
  }, [])

  const toggleMute = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    video.muted = !video.muted
  }, [])

  const handleVolumeSlider = useCallback((e) => {
    const video = videoRef.current
    if (!video) return
    const newVolume = parseFloat(e.target.value)
    video.volume = newVolume
    video.muted = newVolume === 0
  }, [])

  const handleSeek = useCallback((e) => {
    const video = videoRef.current
    if (!video || !duration) return
    const rect = e.currentTarget.getBoundingClientRect()
    const percent = (e.clientX - rect.left) / rect.width
    video.currentTime = percent * video.duration
  }, [duration])

  const toggleFullscreen = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    
    if (document.fullscreenElement) {
      document.exitFullscreen()
    } else {
      container.requestFullscreen()
    }
  }, [])

  const changeQuality = useCallback((quality) => {
    const player = playerRef.current
    if (!player) {
      console.warn('⚠️ Player não disponível para mudar qualidade')
      return
    }

    console.log(`🔄 Mudando qualidade para: ${quality}`)
    setCurrentQuality(quality)
    setShowSettings(false)

    if (quality === 'auto') {
      player.configure({ abr: { enabled: true } })
      console.log('✅ ABR automático ativado')
    } else {
      const height = parseInt(quality)
      player.configure({ abr: { enabled: false } })
      const tracks = player.getVariantTracks()
      console.log(`📊 Tracks disponíveis:`, tracks.map(t => `${t.height}p`).join(', '))
      
      const track = tracks.find(t => t.height === height)
      if (track) {
        player.selectVariantTrack(track, true)
        console.log(`✅ Qualidade ${height}p selecionada (bandwidth: ${track.bandwidth})`)
      } else {
        console.warn(`⚠️ Track ${height}p não encontrada. Disponíveis:`, tracks.map(t => t.height))
        // Tentar encontrar a qualidade mais próxima
        const closest = tracks.reduce((prev, curr) => 
          Math.abs(curr.height - height) < Math.abs(prev.height - height) ? curr : prev
        )
        if (closest) {
          player.selectVariantTrack(closest, true)
          setCurrentQuality(`${closest.height}p`)
          console.log(`🔄 Usando qualidade mais próxima: ${closest.height}p`)
        }
      }
    }
  }, [])

  const changePlaybackRate = useCallback((rate) => {
    const video = videoRef.current
    if (!video) return
    video.playbackRate = rate
    setPlaybackRate(rate)
    setShowSettings(false)
  }, [])

  // Atualizar faixas de áudio
  const updateAudioTracks = useCallback((player) => {
    const variants = player.getVariantTracks()
    const audioLanguages = new Map()
    
    variants.forEach(variant => {
      if (variant.audioId && !audioLanguages.has(variant.language)) {
        audioLanguages.set(variant.language, {
          language: variant.language || 'und',
          label: getLanguageLabel(variant.language) || 'Desconhecido',
          roles: variant.audioRoles || [],
          channelCount: variant.channelsCount || 2,
          active: variant.active
        })
      }
    })
    
    const tracks = Array.from(audioLanguages.values())
    setAudioTracks(tracks)
    
    const active = tracks.find(t => t.active)
    if (active) {
      setCurrentAudioTrack(active.language)
    }
  }, [])

  // Atualizar legendas
  const updateTextTracks = useCallback((player) => {
    const tracks = player.getTextTracks()
    const formattedTracks = tracks.map(track => ({
      id: track.id,
      language: track.language || 'und',
      label: track.label || getLanguageLabel(track.language) || 'Desconhecido',
      kind: track.kind || 'subtitles',
      active: track.active
    }))
    
    setTextTracks([{ id: 'off', language: 'off', label: 'Desligado' }, ...formattedTracks])
    
    const active = formattedTracks.find(t => t.active)
    setCurrentTextTrack(active ? active.language : 'off')
  }, [])

  // Mudar faixa de áudio
  const changeAudioTrack = useCallback((language) => {
    const player = playerRef.current
    if (!player) return
    
    player.selectAudioLanguage(language)
    setCurrentAudioTrack(language)
    setShowSettings(false)
    console.log(`🔊 Áudio alterado para: ${getLanguageLabel(language)}`)
  }, [])

  // Mudar legenda
  const changeTextTrack = useCallback((language) => {
    const player = playerRef.current
    if (!player) return
    
    if (language === 'off') {
      player.setTextTrackVisibility(false)
      setCurrentTextTrack('off')
    } else {
      player.setTextTrackVisibility(true)
      player.selectTextLanguage(language)
      setCurrentTextTrack(language)
    }
    setShowSettings(false)
    console.log(`📝 Legenda alterada para: ${language === 'off' ? 'Desligado' : getLanguageLabel(language)}`)
  }, [])

  // Helper para obter nome do idioma
  const getLanguageLabel = (code) => {
    const languages = {
      'pt': 'Português',
      'pt-BR': 'Português (Brasil)',
      'pt-PT': 'Português (Portugal)',
      'en': 'English',
      'en-US': 'English (US)',
      'en-GB': 'English (UK)',
      'es': 'Español',
      'es-ES': 'Español (España)',
      'es-MX': 'Español (México)',
      'fr': 'Français',
      'de': 'Deutsch',
      'it': 'Italiano',
      'ja': 'Japanese (日本語)',
      'ko': 'Korean (한국어)',
      'zh': 'Chinese (中文)',
      'ru': 'Russian (Русский)',
      'ar': 'Arabic (العربية)',
      'hi': 'Hindi (हिन्दी)',
      'und': 'Desconhecido'
    }
    return languages[code] || code?.toUpperCase() || 'Desconhecido'
  }

  // Formatar tempo
  const formatTime = (seconds) => {
    if (!seconds || isNaN(seconds) || !isFinite(seconds) || seconds <= 0) return '0:00'
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const s = Math.floor(seconds % 60)
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
    }
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  // Atalhos de teclado
  useEffect(() => {
    const handleKeydown = (e) => {
      const video = videoRef.current
      if (!video || e.target.tagName === 'INPUT') return

      switch (e.key.toLowerCase()) {
        case ' ':
        case 'k':
          e.preventDefault()
          togglePlay()
          break
        case 'f':
          e.preventDefault()
          toggleFullscreen()
          break
        case 'm':
          e.preventDefault()
          toggleMute()
          break
        case 'arrowleft':
          e.preventDefault()
          video.currentTime -= 10
          break
        case 'arrowright':
          e.preventDefault()
          video.currentTime += 10
          break
        case 'arrowup':
          e.preventDefault()
          video.volume = Math.min(1, video.volume + 0.1)
          break
        case 'arrowdown':
          e.preventDefault()
          video.volume = Math.max(0, video.volume - 0.1)
          break
        default:
          if (/^[0-9]$/.test(e.key)) {
            e.preventDefault()
            video.currentTime = (parseInt(e.key) / 10) * video.duration
          }
          break
      }
    }

    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  }, [togglePlay, toggleFullscreen, toggleMute])

  return (
    <div 
      ref={containerRef}
      className={`shaka-player-container relative bg-black rounded-xl overflow-hidden shadow-2xl group ${isFullscreen ? 'fullscreen' : ''}`}
      style={{ aspectRatio: '16/9' }}
    >
      <video
        ref={videoRef}
        className="w-full h-full object-contain"
        poster={poster}
        playsInline
        muted={muted}
        onClick={togglePlay}
      />
      
      {/* Loading spinner */}
      {isBuffering && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/30 z-20 pointer-events-none">
          <div className="relative">
            <div className="w-16 h-16 border-4 border-red-600 border-t-transparent rounded-full animate-spin"></div>
            <div className="absolute inset-0 flex items-center justify-center">
              <svg className="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z"/>
              </svg>
            </div>
          </div>
        </div>
      )}
      
      {/* Overlay de controles customizados */}
      <div 
        className={`absolute inset-0 transition-opacity duration-300 ${
          showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        {/* Gradiente superior */}
        <div className="absolute top-0 left-0 right-0 h-24 bg-gradient-to-b from-black/70 to-transparent" />
        
        {/* Gradiente inferior */}
        <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-black/70 to-transparent" />
        
        {/* Botão central de play/pause */}
        <div className="absolute inset-0 flex items-center justify-center">
          <button
            onClick={togglePlay}
            className={`w-20 h-20 rounded-full bg-red-600/80 backdrop-blur-sm flex items-center justify-center 
              transition-all duration-200 hover:bg-red-600 hover:scale-110 ${isPlaying ? 'opacity-0' : 'opacity-100'}`}
          >
            <svg className="w-10 h-10 text-white ml-1" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z"/>
            </svg>
          </button>
        </div>

        {/* Barra de controles inferior */}
        <div className="absolute bottom-0 left-0 right-0 p-4">
          {/* Barra de progresso */}
          <div 
            className="relative h-1 bg-white/30 rounded-full mb-4 cursor-pointer group/progress hover:h-1.5 transition-all"
            onClick={handleSeek}
          >
            {/* Buffer */}
            <div 
              className="absolute h-full bg-white/50 rounded-full"
              style={{ width: `${bufferedPercent}%` }}
            />
            {/* Progresso */}
            <div 
              className="absolute h-full bg-red-600 rounded-full"
              style={{ width: `${duration ? (currentTime / duration) * 100 : 0}%` }}
            />
            {/* Ponto indicador */}
            <div 
              className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-red-600 rounded-full 
                opacity-0 group-hover/progress:opacity-100 transition-opacity shadow-lg"
              style={{ left: `calc(${duration ? (currentTime / duration) * 100 : 0}% - 8px)` }}
            />
          </div>

          {/* Controles */}
          <div className="flex items-center gap-3">
            {/* Play/Pause */}
            <button onClick={togglePlay} className="text-white hover:text-red-500 transition-colors p-1">
              {isPlaying ? (
                <svg className="w-7 h-7" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/>
                </svg>
              ) : (
                <svg className="w-7 h-7" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z"/>
                </svg>
              )}
            </button>

            {/* Skip -10s */}
            <button 
              onClick={() => videoRef.current && (videoRef.current.currentTime -= 10)}
              className="text-white hover:text-red-500 transition-colors p-1"
              title="Voltar 10s"
            >
              <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                <path d="M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z"/>
              </svg>
            </button>

            {/* Skip +10s */}
            <button 
              onClick={() => videoRef.current && (videoRef.current.currentTime += 10)}
              className="text-white hover:text-red-500 transition-colors p-1"
              title="Avançar 10s"
            >
              <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                <path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z"/>
              </svg>
            </button>

            {/* Volume */}
            <div className="flex items-center gap-2 group/volume">
              <button onClick={toggleMute} className="text-white hover:text-red-500 transition-colors p-1">
                {isMuted || volume === 0 ? (
                  <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
                  </svg>
                ) : volume < 0.5 ? (
                  <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z"/>
                  </svg>
                ) : (
                  <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
                  </svg>
                )}
              </button>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={isMuted ? 0 : volume}
                onChange={handleVolumeSlider}
                className="w-0 group-hover/volume:w-20 transition-all duration-200 accent-red-600 cursor-pointer"
              />
            </div>

            {/* Tempo */}
            <div className="text-white text-sm font-mono ml-2">
              <span className="text-white">{formatTime(currentTime)}</span>
              <span className="text-gray-400 mx-1">/</span>
              <span className="text-gray-300">{duration > 0 ? formatTime(duration) : '--:--'}</span>
            </div>

            <div className="flex-1" />

            {/* Badges de status */}
            <div className="flex items-center gap-2">
              {/* Badge Áudio */}
              {currentAudioTrack && currentAudioTrack !== 'und' && (
                <span className="bg-blue-600 text-white text-xs font-bold px-2 py-0.5 rounded uppercase">
                  🔊 {currentAudioTrack}
                </span>
              )}
              
              {/* Badge Legenda */}
              {currentTextTrack && currentTextTrack !== 'off' && (
                <span className="bg-green-600 text-white text-xs font-bold px-2 py-0.5 rounded uppercase">
                  📝 {currentTextTrack}
                </span>
              )}
              
              {/* Qualidade Badge */}
              {currentQuality !== 'auto' && (
                <span className="bg-red-600 text-white text-xs font-bold px-2 py-0.5 rounded">
                  {currentQuality}
                </span>
              )}
            </div>

            {/* Configurações */}
            <div className="relative">
              <button 
                onClick={() => setShowSettings(s => !s)}
                className="text-white hover:text-red-500 transition-colors p-1 flex items-center gap-1"
              >
                <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22l-1.92 3.32c-.12.21-.07.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94 0 .31.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.03-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
                </svg>
              </button>
              
              {/* Menu de configurações */}
              {showSettings && (
                <div className="absolute bottom-full right-0 mb-2 bg-gray-900/95 backdrop-blur-sm rounded-lg shadow-xl overflow-hidden min-w-[220px] border border-gray-700">
                  {/* Abas */}
                  <div className="flex border-b border-gray-700">
                    <button
                      onClick={() => setSettingsTab('quality')}
                      className={`flex-1 px-3 py-2 text-xs font-semibold transition-colors ${
                        settingsTab === 'quality' ? 'text-red-500 bg-white/5' : 'text-gray-400 hover:text-white'
                      }`}
                    >
                      📺 Qualidade
                    </button>
                    <button
                      onClick={() => setSettingsTab('audio')}
                      className={`flex-1 px-3 py-2 text-xs font-semibold transition-colors ${
                        settingsTab === 'audio' ? 'text-red-500 bg-white/5' : 'text-gray-400 hover:text-white'
                      }`}
                    >
                      🔊 Áudio
                    </button>
                    <button
                      onClick={() => setSettingsTab('subtitles')}
                      className={`flex-1 px-3 py-2 text-xs font-semibold transition-colors ${
                        settingsTab === 'subtitles' ? 'text-red-500 bg-white/5' : 'text-gray-400 hover:text-white'
                      }`}
                    >
                      📝 Legendas
                    </button>
                    <button
                      onClick={() => setSettingsTab('speed')}
                      className={`flex-1 px-3 py-2 text-xs font-semibold transition-colors ${
                        settingsTab === 'speed' ? 'text-red-500 bg-white/5' : 'text-gray-400 hover:text-white'
                      }`}
                    >
                      ⚡ Veloc.
                    </button>
                  </div>

                  {/* Conteúdo da aba Qualidade */}
                  {settingsTab === 'quality' && (
                    <div className="max-h-48 overflow-y-auto">
                      {qualities.map((q) => (
                        <button
                          key={q}
                          onClick={() => changeQuality(q)}
                          className={`w-full px-4 py-2.5 text-left text-sm hover:bg-white/10 transition-colors flex items-center justify-between ${
                            currentQuality === q ? 'text-red-500 bg-white/5' : 'text-white'
                          }`}
                        >
                          <span>{q === 'auto' ? '🔄 Auto' : q}</span>
                          {currentQuality === q && (
                            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                              <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                            </svg>
                          )}
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Conteúdo da aba Áudio */}
                  {settingsTab === 'audio' && (
                    <div className="max-h-48 overflow-y-auto">
                      {audioTracks.length === 0 ? (
                        <div className="px-4 py-3 text-gray-400 text-sm text-center">
                          Nenhuma faixa de áudio disponível
                        </div>
                      ) : (
                        audioTracks.map((track) => (
                          <button
                            key={track.language}
                            onClick={() => changeAudioTrack(track.language)}
                            className={`w-full px-4 py-2.5 text-left text-sm hover:bg-white/10 transition-colors flex items-center justify-between ${
                              currentAudioTrack === track.language ? 'text-red-500 bg-white/5' : 'text-white'
                            }`}
                          >
                            <div className="flex flex-col">
                              <span>{track.label}</span>
                              {track.channelCount && (
                                <span className="text-xs text-gray-400">
                                  {track.channelCount >= 6 ? '5.1 Surround' : 'Stereo'}
                                </span>
                              )}
                            </div>
                            {currentAudioTrack === track.language && (
                              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                                <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                              </svg>
                            )}
                          </button>
                        ))
                      )}
                    </div>
                  )}

                  {/* Conteúdo da aba Legendas */}
                  {settingsTab === 'subtitles' && (
                    <div className="max-h-48 overflow-y-auto">
                      {textTracks.length <= 1 ? (
                        <div className="px-4 py-3 text-gray-400 text-sm text-center">
                          Nenhuma legenda disponível
                        </div>
                      ) : (
                        textTracks.map((track) => (
                          <button
                            key={track.id || track.language}
                            onClick={() => changeTextTrack(track.language)}
                            className={`w-full px-4 py-2.5 text-left text-sm hover:bg-white/10 transition-colors flex items-center justify-between ${
                              currentTextTrack === track.language ? 'text-red-500 bg-white/5' : 'text-white'
                            }`}
                          >
                            <span>{track.label}</span>
                            {currentTextTrack === track.language && (
                              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                                <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                              </svg>
                            )}
                          </button>
                        ))
                      )}
                    </div>
                  )}

                  {/* Conteúdo da aba Velocidade */}
                  {settingsTab === 'speed' && (
                    <div className="max-h-48 overflow-y-auto">
                      {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
                        <button
                          key={rate}
                          onClick={() => changePlaybackRate(rate)}
                          className={`w-full px-4 py-2.5 text-left text-sm hover:bg-white/10 transition-colors flex items-center justify-between ${
                            playbackRate === rate ? 'text-red-500 bg-white/5' : 'text-white'
                          }`}
                        >
                          <span>{rate === 1 ? 'Normal' : `${rate}x`}</span>
                          {playbackRate === rate && (
                            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                              <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                            </svg>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Fullscreen */}
            <button onClick={toggleFullscreen} className="text-white hover:text-red-500 transition-colors p-1">
              {isFullscreen ? (
                <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/>
                </svg>
              ) : (
                <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Estilos adicionais */}
      <style>{`
        .shaka-player-container video::-webkit-media-controls {
          display: none !important;
        }
        
        .shaka-player-container.fullscreen {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          z-index: 9999;
          border-radius: 0;
          aspect-ratio: unset;
        }
        
        .shaka-player-container.fullscreen video {
          width: 100%;
          height: 100%;
        }
        
        input[type="range"] {
          -webkit-appearance: none;
          height: 4px;
          background: rgba(255,255,255,0.3);
          border-radius: 2px;
        }
        
        input[type="range"]::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 14px;
          height: 14px;
          background: #e50914;
          border-radius: 50%;
          cursor: pointer;
          box-shadow: 0 2px 4px rgba(0,0,0,0.3);
        }
        
        input[type="range"]::-moz-range-thumb {
          width: 14px;
          height: 14px;
          background: #e50914;
          border-radius: 50%;
          cursor: pointer;
          border: none;
        }
      `}</style>
    </div>
  )
})

ShakaVideoPlayer.displayName = 'ShakaVideoPlayer'

export default ShakaVideoPlayer
