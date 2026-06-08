# 📋 Lista de Tarefas - WebTorrent Player

---

## ✅ Tarefa 1: Corrigir Faixa de Áudio do Player - **CONCLUÍDA v2**

### Descrição do Problema
A seleção de faixa de áudio no player não funcionava. O usuário podia ver as opções de áudio no menu de configurações, mas a troca entre faixas de áudio não tinha efeito.

### 🔍 Causa Raiz Identificada
O problema era que **todas as faixas de áudio estavam multiplexadas nos mesmos segmentos .ts**. O HLS com áudio multiplexado **não suporta troca dinâmica de áudio pelo player** - todas as faixas são tocadas juntas ou o player simplesmente não consegue alternar.

### ✅ Solução Implementada (v2 - Streams de Áudio Separados)

#### Arquitetura Corrigida:
- **Áudio primário (track 0)**: Continua embutido nos segmentos de vídeo para compatibilidade
- **Áudios alternativos (track 1+)**: Gerados em **streams HLS separados** com seus próprios playlists

#### Backend - Modificações Realizadas:

1. **Nova função `transcodeAudioTrack`** em [client.go](backend/torrent/client.go):
   - Gera streams HLS de áudio separados para cada faixa alternativa
   - Cria diretórios `audio_{idioma}/` com seus próprios segmentos
   - Usa FFmpeg: `-map 0:a:N -vn -c:a aac` para extrair apenas áudio

2. **`buildFFmpegArgs` modificada**:
   - Agora mapeia **apenas o primeiro áudio** nos segmentos de vídeo: `-map 0:a:0?`
   - Outros áudios são gerados separadamente

3. **`generateMasterPlaylist` atualizada**:
   - Áudio primário: `#EXT-X-MEDIA` sem URI (embutido)
   - Áudios alternativos: `#EXT-X-MEDIA` com `URI="audio_{lang}/playlist.m3u8"`
   - Exemplo gerado:
     ```m3u8
     #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Português",LANGUAGE="por",DEFAULT=YES,AUTOSELECT=YES
     #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="eng",DEFAULT=NO,AUTOSELECT=NO,URI="audio_eng/playlist.m3u8"
     ```

4. **`transcodeToHLS` atualizada**:
   - Após iniciar transcodificações de qualidade, inicia transcodificação de áudios alternativos em paralelo

#### Frontend - Já Funcionando Corretamente:
O código do Shaka Player já estava preparado para lidar com streams de áudio separados via `selectAudioLanguage()`.

---

## ✅ Tarefa 2: Verificar Reprodução em 1080p Real - **CONCLUÍDA**

### Descrição do Problema
Verificar se o player oferece a opção de reprodução em 1080p real para o usuário, e se essa qualidade está sendo gerada e disponibilizada corretamente.

### ✅ Análise e Confirmação

#### Backend - Funcionando Corretamente ✅

1. **Qualidade 1080p definida** em [client.go](backend/torrent/client.go#L45):
   ```go
   {Name: "1080p", Width: 1920, Height: 1080, Bitrate: "5000k", ...}
   ```

2. **Filtro de qualidades** funciona corretamente:
   - Se vídeo fonte é 1080p ou superior → 1080p é gerado
   - Se vídeo fonte é 720p → só até 720p (sem upscaling)

3. **Fallback seguro**: Se não conseguir detectar resolução, assume 1080p

#### Frontend - Melhorias Implementadas ✅

1. **Badge visual de qualidade máxima**:
   - Mostra "FHD" quando 1080p está disponível
   - Mostra "2K" para 1440p
   - Mostra "4K" para 2160p

2. **Menu de qualidade melhorado**:
   - Cada opção agora mostra badges visuais (HD, FHD, 2K, 4K)
   - Cores diferenciadas para identificar qualidades

3. **Badge de qualidade atual clicável**:
   - Sempre visível na barra de controles
   - Cores indicam nível de qualidade (vermelho = alta, laranja = média)

### Verificações Confirmadas

- ✅ 1080p aparece quando vídeo fonte é 1080p+
- ✅ Seleção manual de qualidade funciona
- ✅ ABR sobe gradualmente para 1080p em conexões rápidas
- ✅ Interface mostra claramente qual qualidade está sendo reproduzida

---

## 📝 Ordem de Execução

Vamos realizar as tarefas uma de cada vez:

1. **Primeiro**: Tarefa 1 - Corrigir faixa de áudio
2. **Depois**: Tarefa 2 - Verificar e garantir 1080p real

---

*Documento criado em: 28/12/2025*
