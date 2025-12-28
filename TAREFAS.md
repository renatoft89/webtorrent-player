# 📋 Lista de Tarefas - WebTorrent Player

---

## ✅ Tarefa 1: Corrigir Faixa de Áudio do Player - **CONCLUÍDA**

### Descrição do Problema
A seleção de faixa de áudio no player não funciona corretamente. O usuário pode ver as opções de áudio no menu de configurações, mas a troca entre faixas de áudio pode não estar funcionando como esperado.

### ✅ Solução Implementada

#### Backend - Modificações Realizadas:

1. **Nova função `GetAudioTracksInfo`** em [cache.go](backend/torrent/cache.go):
   - Usa `ffprobe` para obter informações detalhadas de TODAS as faixas de áudio
   - Retorna: índice, idioma, título, codec, número de canais
   - Detecta automaticamente o nome do idioma

2. **Novo campo `AudioTracks` em `StreamInfo`** em [client.go](backend/torrent/client.go):
   - Armazena as informações das faixas de áudio detectadas
   - Disponível via API de status

3. **`buildFFmpegArgs` modificada** para mapear TODAS as faixas:
   - Usa `-map 0:v:0` para vídeo
   - Usa `-map 0:a:N` para cada faixa de áudio
   - Adiciona metadados de idioma: `-metadata:s:a:N language=XXX`

4. **`generateMasterPlaylist` atualizada**:
   - Versão HLS 4 para suportar `#EXT-X-MEDIA`
   - Declara cada faixa de áudio com `#EXT-X-MEDIA:TYPE=AUDIO`
   - Referencia grupo de áudio em cada qualidade

5. **API de status** agora retorna `audioTracks`

#### Frontend - Modificações Realizadas:

1. **`updateAudioTracks` melhorada** em [ShakaVideoPlayer.jsx](frontend/src/components/player/ShakaVideoPlayer.jsx):
   - Tenta primeiro usar `getAudioLanguagesAndRoles()` (mais confiável)
   - Fallback para extração de `getVariantTracks()`
   - Detecta corretamente a faixa ativa

2. **`changeAudioTrack` robusta**:
   - Usa `selectAudioLanguage()` como método principal
   - Configura preferências para seleções futuras
   - Fallback para `selectVariantTrack()` se necessário
   - Atualiza estado visual imediatamente

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
