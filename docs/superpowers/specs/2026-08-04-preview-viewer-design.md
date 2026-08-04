# Visualizador de arquivos: navegação, tipos e players

Data: 2026-08-04
Escopo: `frontend/` (modal de preview), `backend/` (rotas e serviço de preview), novo workspace `shared/`.

## Problema

O preview atual (`components/FilePreviewModal.vue`, `composables/useFilePreviewModal.js`) é um modal centralizado com uma cadeia de `v-else-if` para seis tipos. Problemas verificados no código e em uso real no telefone:

1. **Navegar entre arquivos é lento e pouco descobrível.** Só existem dois botões de 40 px no cabeçalho e as setas do teclado (`FilePreviewModal.vue:73-78`, `:36-37`). No telefone não há swipe, não há indicação de posição na sequência e não há como pular vários arquivos de uma vez.
2. **PDF e Office aparecem em branco no telefone.** `getPreviewType()` mapeia `doc/docx/xls/xlsx/ppt/pptx/odt/ods/odp` para `pdf` (`useFileType.js:99-106`) e o backend converte de verdade com LibreOffice (`previewService.js:70`), mas o front entrega o resultado num `<iframe>` (`FilePreviewModal.vue:115`) — que a maioria dos navegadores móveis não renderiza inline. O usuário vê um retângulo vazio, sem erro.
3. **Poucos tipos abrem.** Código-fonte (`.js`, `.py`, `.go`, `.sql`, `.sh`…), arquivos compactados, HEIC e TIFF caem em "preview não disponível". Markdown e CSV abrem como texto cru.
4. **Players são o elemento nativo pelado.** Sem controle de velocidade, sem PiP, sem retomar de onde parou, sem pôster, sem continuar para a próxima faixa.
5. **As tabelas de tipo estão duplicadas.** `frontend/src/composables/useFileType.js` e `backend/src/services/previewService.js` mantêm listas de extensão quase iguais, sem nada que as force a concordar. É a raiz do item 2: os dois lados dizem "isto vira PDF" e ninguém garante que o front saiba exibir o PDF que o back produz.

Fora de escopo (identificado, não tratado): EPUB (nenhuma ferramenta instalada converte), legendas `.srt` externas, streaming HLS, vídeos cujo codec o navegador não toca (caem no cartão "baixar"), viewers externos de terceiros (mandariam conteúdo do usuário para fora — descartado por privacidade).

## Solução

Cinco frentes. As seções 1 e 2 são a queixa principal; as demais dependem só da seção 1 estar de pé.

### 1. Componentes

`FilePreviewModal.vue` é substituído por um conjunto com uma responsabilidade cada:

```
components/preview/FilePreviewViewer.vue   # shell full-screen: carrossel, auto-hide, cabeçalho
components/preview/PreviewSlide.vue        # um arquivo: escolhe o renderizador, emite loaded/failed
components/preview/PreviewThumbStrip.vue   # tira de miniaturas
components/preview/renderers/ImageRender.vue
components/preview/renderers/MediaRender.vue
components/preview/renderers/PagedRender.vue
components/preview/renderers/TextRender.vue
components/preview/renderers/ArchiveRender.vue
components/preview/renderers/FallbackRender.vue
```

`PreviewSlide` resolve o renderizador por um mapa `previewType → componente`, não por cadeia de `v-else-if`. Tipo novo passa a custar uma entrada no mapa e um arquivo.

`PagedRender` e `TextRender` entram por `defineAsyncComponent` — quem abre só fotos não baixa o highlight nem o renderizador de markdown.

`useFilePreviewModal.js` continua dono do estado (lista previewável, arquivo atual, `hasPrevious`/`hasNext`, carga de texto com a proteção de corrida que já existe em `loadText`). Ganha:

- `currentIndex` exposto (hoje é interno) e `total`;
- `goToIndex(i)`;
- `isNear(i)` — verdadeiro para o índice atual ±1, usado pelo slide para decidir se monta o conteúdo ou fica placeholder. Sem isso, uma pasta com 200 vídeos monta 200 elementos `<video>`.

### 2. Navegação e full-screen

**Carrossel.** Contêiner com `overflow-x:auto` e `scroll-snap-type: x mandatory`; cada slide com `scroll-snap-align:center`. Swipe no telefone, scroll/trackpad no desktop, momentum nativo — sem biblioteca de gestos. Trocar por botão ou teclado chama `scrollIntoView({ behavior: 'smooth' })`. Um `IntersectionObserver` sobre os slides detecta qual ficou centralizado e atualiza o índice, de modo que cabeçalho e tira de miniaturas seguem o gesto.

Sem virtualização: os slides fora da janela existem no DOM, mas vazios. Fica registrado com `// ponytail: sem virtualização; janela de ~15 slides se listas de milhares travarem`. Mexer no DOM durante o scroll desestabiliza a posição do `scroll-snap`, então a virtualização só entra se houver problema medido.

**Full-screen nas duas telas.** `fixed inset-0`, fundo `bg-black/95`, sem moldura arredondada. O cabeçalho vira barra flutuante sobre o conteúdo: nome do arquivo, contador `3 / 12`, baixar, fechar. O desktop ganha setas grandes nas laterais (`hidden sm:grid`); o telefone não exibe seta — o gesto é o controle.

**Sequência.** Continua contendo apenas arquivos previewáveis, como hoje (`previewableFiles`).

**Auto-hide.** Um `ref showChrome`. Toque ou clique no fundo alterna; ao abrir e a cada troca de arquivo, esconde sozinho após 3 s; movimento de mouse no desktop reexibe. Nunca esconde enquanto um menu estiver aberto ou o vídeo estiver pausado.

**Tira de miniaturas.** Rodapé com scroll horizontal, `api.thumbnailUrl()` e `loading="lazy"`. Quem não tem miniatura (áudio, texto, compactado) exibe o ícone do tipo vindo de `getFileIcon`. O item ativo recebe anel azul e a tira se recentraliza nele quando o swipe muda o arquivo. Tocar em um item pula direto para ele.

**Gestos e teclado.** Arrastar para baixo fecha, apenas quando a imagem não está ampliada (com zoom, o arrasto é pan). Duplo-toque mantém o zoom que já existe. `Esc` fecha, `←`/`→` navegam, `Home`/`End` vão ao primeiro/último.

### 3. Tipos de arquivo

Mudanças no mapeamento de tipos:

| Tipo | Hoje | Depois |
|---|---|---|
| PDF e Office | `<iframe>`, branco no telefone | `paged`: páginas rasterizadas, scroll vertical |
| Código (js, ts, py, go, rs, java, sql, sh, yaml…) | "não disponível" | `text` com realce de sintaxe |
| Markdown | texto cru | renderizado, com alternância "ver fonte" |
| CSV | texto cru | tabela |
| ZIP, RAR, 7z, tar | "não disponível" | lista de entradas (nome, tamanho) |
| HEIC, TIFF | falha em Chrome e Firefox | backend converte para JPEG |
| SVG | `<img>` | `<img>` (mantido: `<img>` não executa script) |

**Workspace `shared/`.** A raiz já declara `workspaces: ["backend", "frontend"]`; entra `shared` como terceiro. Ele exporta um único mapa de extensão/mime → tipo de preview, mais `getPreviewType(file)`, cujos valores são `image`, `video`, `audio`, `text`, `archive`, `pdf` e `office`. `useFileType.js` e `previewService.js` passam a importar dali em vez de manter listas próprias.

Front e back consomem o mesmo resultado de formas diferentes, e isso fica explícito: o backend usa `office` para decidir converter com LibreOffice (comportamento atual de `getPreviewKind`), enquanto o front colapsa `pdf` e `office` no renderizador `paged`, porque para ele os dois chegam como páginas. As funções específicas de cada lado (ícones no front, escolha de conversor no back) continuam onde estão.

**Endpoints novos** (mesma autenticação, mesmo `getFileContext`, mesmo diretório de cache dos endpoints atuais):

- `GET /files/:id/preview/pages` → `{ pageCount }`. Roda `pdfinfo` uma vez sobre o PDF já convertido; resultado cacheado pela mesma chave de revisão (`getPreviewCacheKey`).
- `GET /files/:id/preview/page/:n` → JPEG da página `n`, via `pdftoppm -f n -l n` (a ferramenta já é usada em `thumbnailService.js`). Cache por página. `n` fora do intervalo → 404.
- `GET /files/:id/preview/entries` → `{ entries: [{ name, size }], truncated }`, via `unzip -l` ou `7z l`. Teto de 1000 entradas; acima disso `truncated: true`.

`PagedRender` pede `pages`, desenha um `<img>` por página e carrega cada uma sob demanda conforme o usuário rola (`loading="lazy"`).

**Limites.** Herdados dos atuais: tamanho máximo por arquivo (415 acima do teto), timeout por conversão (422 ao estourar), um diretório temporário por conversão. Nada é extraído de arquivo compactado — só listado — e o nome de cada entrada é tratado como texto na exibição, nunca como caminho.

### 4. Players

`MediaRender.vue` atende vídeo e áudio; a diferença entre eles é o pôster e a altura.

- **Velocidade**: menu de 0,5× a 2×, aplicado em `playbackRate`.
- **PiP**: botão que chama `requestPictureInPicture()`, oculto quando `document.pictureInPictureEnabled` é falso.
- **Retomar posição**: `localStorage` por id de arquivo, gravado a cada 5 s. Ao reabrir, retoma se faltavam mais de 30 s para o fim; abaixo disso começa do zero. Entradas com mais de 90 dias são descartadas na leitura.
- **Auto-próximo**: no evento `ended`, avança para o próximo arquivo da sequência apenas se ele também for mídia.
- **Pôster**: `api.thumbnailUrl()` no atributo `poster` do vídeo.

Trilhas de áudio e legendas embutidas no contêiner já são expostas pelo elemento nativo; nada a implementar.

### 5. Erros

Cada renderizador emite `loaded` ou `failed`; o slide exibe o cartão de erro com o botão "baixar", como hoje. Falha em um slide não afeta os vizinhos — a navegação continua. Resposta 422 do backend (conversão falhou ou estourou o tempo) vira mensagem "não foi possível converter, baixe o arquivo", nunca spinner infinito.

## Testes

No padrão do repositório (`node --test`, sem framework adicional):

- `shared/`: extensão e mime conhecidos resolvem para o tipo esperado; desconhecido resolve para `null`; `docx` e `pdf` resolvem para o mesmo tipo `paged` nos dois lados.
- `useFilePreviewModal`: `currentIndex`, `hasPrevious`/`hasNext` nas bordas, `goToIndex` fora do intervalo é ignorado, `isNear` cobre atual ±1, e a corrida já existente (arquivo trocado antes da resposta de texto chegar) continua descartando a resposta velha.
- backend: página fora do intervalo → 404; arquivo acima do teto → 415; conversão que falha → 422; nome de entrada de compactado com caracteres de marcação sai escapado na resposta.

Sem teste automatizado de swipe ou `scroll-snap`: seria testar o navegador, não este código. A verificação desses é manual, no telefone.

## Ordem de implementação

1. Workspace `shared/` e unificação do mapa de tipos (sem mudança visível).
2. `FilePreviewViewer` full-screen com carrossel, contador, auto-hide e tira de miniaturas, reusando os renderizadores atuais.
3. `PagedRender` e os endpoints de página — corrige o PDF/Office em branco no telefone.
4. `TextRender` (código, markdown, CSV) e `ArchiveRender`.
5. `MediaRender` com velocidade, PiP, retomar, auto-próximo e pôster.

Cada etapa é entregável sozinha; a 3 é a que resolve a falha silenciosa mais visível.
