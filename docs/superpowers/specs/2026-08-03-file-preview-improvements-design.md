# Melhorias na previsualização de arquivos

Data: 2026-08-03
Status: aprovado para planejamento

## Problema

A previsualização atual (`GET /files/:id/preview` + `FilePreviewModal.vue`) tem quatro
falhas concretas:

1. **Tipos não suportados.** O backend responde 415 para docx/xlsx/pptx/odt/ods/odp.
   O frontend, porém, considera esses arquivos previsualizáveis (`getFileCategory`
   retorna `document`) e os injeta num `<iframe>`. Resultado: o usuário vê o JSON de
   erro dentro do modal. Áudio também vai para `<iframe>`, sem player.
2. **Reprodução de mídia.** A rota não envia `Accept-Ranges` nem responde 206. O
   `<video>` recebe o arquivo inteiro em um único stream e o seek não funciona.
3. **UX do modal.** Não fecha com Esc, não navega entre arquivos, não tem zoom em
   imagem, não tem download no cabeçalho e não mostra estado de erro — falha de
   carga apenas apaga o spinner e deixa a área em branco.
4. **Performance.** Sem `Cache-Control` nem `ETag`: reabrir o mesmo arquivo baixa
   tudo de novo.

## Restrições e o que já existe

- O container do backend já traz `libreoffice`, `ffmpeg` e `pdftoppm`
  (`backend/Dockerfile`), usados por `thumbnailService.js`. Converter Office → PDF é
  reuso de infraestrutura, não dependência nova.
- `fileCacheService.openFile({ userId, file, adapter, range })` já aceita range, e
  `localFileStore.openReadStream` repassa para `createReadStream`.
- `parseRangeHeader(header, size)` já existe em `backend/src/services/webdav.js` e é
  usado por `webdavRoutes.js`. O padrão completo de resposta 206 está em
  `webdavRoutes.js:114-160` e serve de referência.
- Os adapters expõem `getCapabilities().supportsRange`; nem todos suportam range
  remoto (PCloud e Mega ignoram o parâmetro).
- Autenticação é por cookie (`credentials: 'include'`), então `<img>`, `<video>`,
  `<audio>` e `<iframe>` autenticam sozinhos.
- Nenhuma dependência npm nova, no backend ou no frontend.

## Arquitetura

### Fonte única de verdade sobre o tipo de preview

Hoje o frontend decide o que é previsualizável (`getFileCategory`) e o backend decide
outra coisa (regex sobre mime). Os dois discordam. Passa a existir um vocabulário
único de `previewKind`:

| kind | como é servido | como é renderizado |
|------|----------------|--------------------|
| `image` | bytes originais | `<img>` com zoom |
| `video` | bytes originais, com Range | `<video controls>` |
| `audio` | bytes originais, com Range | `<audio controls>` |
| `pdf` | bytes originais | `<iframe>` |
| `office` | convertido para PDF e cacheado | `<iframe>` (mime `application/pdf`) |
| `text` | bytes originais | `<pre>` com scroll |
| `null` | 415 | fallback "não disponível" + botão baixar |

O backend ganha `getPreviewKind(file)` em `backend/src/services/previewService.js`.
Ele classifica pelo **mime efetivo**, não pelo mime bruto: arquivos nativos do Google
não têm conteúdo binário e só chegam pelo formato de exportação de
`googleDocsExport(file)`. Logo o mime e a extensão considerados são
`exportTarget?.mimeType || file.mime_type` e `exportTarget?.extension || extname(nome)`.
Na prática: Google Docs → `pdf`, Sheets → `office` (via xlsx), Slides → `office`
(via pptx), Drawings → `image` (png), Apps Script → `text` (json). Hoje Sheets e
Slides caem no 415.

O frontend ganha `getPreviewType(file)` em `frontend/src/composables/useFileType.js`,
espelhando as mesmas regras e mapeando `office → pdf` (o cliente só precisa saber
como renderizar, e Office chega como PDF). O contrato entre os dois é validado por
teste: um mesmo conjunto de fixtures de arquivo deve produzir kinds compatíveis.

`useFilePreviewModal` já aceita `getPreviewType` injetado e usa
`canPreview = Boolean(getPreviewType(file))` quando ele existe. As views passam a
injetá-lo, o que elimina o caminho `defaultCanPreview` baseado em `getFileCategory`.

### Backend

**`backend/src/services/fileConvert.js` (novo).** Extrai de `thumbnailService.js` a
chamada do LibreOffice e a escrita limitada de stream para disco, exportando
`officeToPdf({ inputPath, outDir, execute, timeoutMs })` e
`writeStreamToFile(stream, targetPath, maxBytes)`. Dois consumidores reais:
`thumbnailService` (que continua rasterizando o PDF) e `previewService` (que serve o
PDF). Sem essa extração, as duas ficariam duplicadas.

**`backend/src/services/previewService.js` (novo).** Exporta:

- `getPreviewKind(file)` — classificação descrita acima.
- `getPreviewCacheKey(userId, file)` — mesmo esquema de
  `getThumbnailCacheKey` (sha256 de userId + id + revisão + tamanho). Serve também
  como `ETag`.
- `renderOfficePdf({ userId, file, openStream, cacheDir, execute, maxBytes, timeoutMs })`
  — baixa para um temp dir, converte via `officeToPdf`, move o resultado para
  `<cacheDir>/<key>.pdf` e devolve o caminho. Se o arquivo já está em cache, retorna
  direto. Espelha `generateThumbnail`: `415` para arquivo grande demais ou tipo
  errado, `422` para falha de conversão, `fs.rm` do temp no `finally`.

Limites: `maxBytes` 100 MB (igual ao thumbnail), `timeoutMs` 60 s (conversão de PDF
é mais pesada que gerar capa; o thumbnail usa 30 s).

Cache em `env.previewCacheDir` (`PREVIEW_CACHE_DIR`, default
`data/previews`), separado do cache de thumbnails para poder ser limpo à parte.

**`GET /files/:id/preview` (reescrita).** Fluxo:

1. Resolve contexto e rejeita pasta (400), como hoje.
2. `getPreviewKind` decide, sobre o mime efetivo (com `googleDocsExport` aplicado).
   `null` → 415.
3. `office` → `renderOfficePdf`, depois serve o arquivo local com
   `createReadStream`, `Content-Type: application/pdf` e suporte a Range sobre o
   tamanho do PDF gerado. A extensão de entrada passada ao LibreOffice vem de
   `exportTarget?.extension` quando existe (o nome do Google Sheet não tem `.xlsx`).
4. Demais kinds → `fileCacheService.openFile` com o range pedido, exatamente como
   `webdavRoutes.sendFile`: só responde 206 quando `opened.cached` ou
   `adapter.getCapabilities?.().supportsRange`; caso contrário responde 200 com o
   corpo inteiro. `Content-Type` é o mime efetivo.
5. Sempre: `Accept-Ranges: bytes`, `Content-Disposition: inline`,
   `Cache-Control: private, max-age=3600`, `ETag: "<cacheKey>"`. Se
   `If-None-Match` bate, responde 304 sem corpo.

`Content-Length` só é enviado quando o tamanho real do corpo é conhecido — para
`office` é o tamanho do PDF gerado, não `file.size`.

### Frontend

**`FilePreviewModal.vue`.** Passa a receber, além do que já recebe, `has-previous` /
`has-next` e emitir `previous` / `next` / `download`. Renderização por
`previewType`:

- `image` — `<img>` com zoom por clique (alterna 1× ↔ 2×) e roda do mouse, via
  `transform: scale()` e `transform-origin` no ponto do cursor. Sem biblioteca.
- `video` / `audio` — elementos nativos com `controls`.
- `pdf` — `<iframe>`, como hoje.
- `text` — conteúdo carregado como texto e exibido em `<pre>` monoespaçado com
  scroll. Sem realce de sintaxe.
- fallback / erro — ícone, mensagem e botão "Baixar".

Teclado: `Escape` fecha, `ArrowLeft` / `ArrowRight` navegam. O listener é registrado
em `window` enquanto o modal está aberto e removido ao fechar/desmontar. As setas não
disparam quando o foco está num controle de mídia.

Cabeçalho ganha botão de download (`api.downloadUrl`), ao lado do fechar.

**`useFilePreviewModal.js`.** Ganha:

- `previewError` (ref) — `handlePreviewFailed` passa a marcá-lo, e o modal exibe o
  estado de erro em vez de área em branco.
- Conteúdo de texto: quando `previewType === 'text'`, o composable busca o corpo via
  `fetch` com `credentials: 'include'`, trunca em 1 MB e expõe `previewText`. Falha
  de rede cai no mesmo `previewError`.
- Navegação: recebe `sourceList` opcional e expõe `hasPrevious`, `hasNext`,
  `showPrevious()`, `showNext()`, que caminham pela lista visível filtrada por
  `canPreview`.

**`useFileActions.js`.** Repassa `sourceList` (que já recebe) para
`useFilePreviewModal` e reexporta os novos campos. As quatro views que montam o
modal (`MyDriveView`, `StarredView`, `SharedWithMeView`, `RecentView`) passam as
novas props e handlers.

**`useFileType.js`.** Ganha `getPreviewType(file)`, incluindo o mapeamento dos mimes
`application/vnd.google-apps.*` (doc → `pdf`, sheet e presentation → `pdf`, porque
chegam já convertidos, drawing → `image`, script → `text`). `getFileCategory`
continua existindo para ícones e filtros — não é removida.

## Tratamento de erro

| Situação | Backend | Frontend |
|----------|---------|----------|
| Pasta | 400 | não acontece (`canPreview` bloqueia) |
| Tipo sem preview | 415 | fallback com botão baixar |
| Arquivo grande demais para converter | 415 | mesma tela de fallback |
| Conversão do LibreOffice falha | 422 | estado de erro com botão baixar |
| Provider indisponível | erro propagado ao handler genérico | estado de erro |
| Falha ao carregar texto | — | estado de erro |

O modal nunca deixa a área de conteúdo em branco: ou renderiza, ou mostra spinner, ou
mostra erro.

## Testes

Backend (`node --test`, seguindo o padrão de `thumbnailRoutes.test.js` e
`thumbnailService.test.js`, com `execute` injetado):

- `previewService.test.js` — `getPreviewKind` para cada categoria e para o caso
  `null`; `renderOfficePdf` reaproveita cache existente sem chamar o conversor;
  propaga 415 para arquivo grande e 422 para falha do conversor; remove o temp dir.
- `previewRoutes.test.js` — 206 com `Content-Range` correto para requisição com
  `Range`; 200 quando o adapter não suporta range e o arquivo não está em cache; 304
  quando `If-None-Match` bate; 415 para tipo sem suporte; Office responde
  `application/pdf`.
- `fileConvert.test.js` — argumentos passados ao LibreOffice e caminho do PDF
  resultante.
- Ajuste em `thumbnailService.test.js` para a extração de `officeToPdf`.

Frontend (`frontend/test/`, já existente):

- `useFilePreviewModal.test.js` — navegação pula arquivos sem preview, respeita as
  bordas da lista; `previewError` é setado em falha; texto é truncado em 1 MB.
- `previewType.test.js` — paridade entre `getPreviewType` do frontend e as regras de
  `getPreviewKind`, sobre fixtures compartilhadas.

## Fora de escopo

- Realce de sintaxe em preview de texto.
- Preload do arquivo vizinho ao navegar.
- Edição inline, comentários ou anotações.
- Preview de arquivos compactados (listar conteúdo do zip).
- Rotação de imagem.
- Conversão assíncrona com fila: a conversão do Office é síncrona na primeira
  requisição, com spinner. Se o tempo de espera se mostrar um problema real, uma fila
  entra depois.
