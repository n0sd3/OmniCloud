# Explorer: Inspector, Quick Preview e navegação por teclado

Data: 2026-08-03
Status: aprovado (design)

## Contexto

O explorer atual do OmniCloud é um clone de Google Drive: lista ou grade, barra de
filtros, barra de seleção, menu de contexto, modal de detalhes e modal de preview.
Toda a lógica vive em `useFileListView`, e quatro views consomem esse composable
(`MyDriveView`, `RecentView`, `StarredView`, `SharedWithMeView`).

O usuário quer aproximar a experiência da do Spacedrive. Este documento cobre
apenas o primeiro subprojeto. Tags e Locations/vistas salvas ficam para specs
próprias, porque exigem trabalho de backend.

## Escopo

Dentro:

- Painel Inspector lateral, substituindo o `FileDetailsModal`.
- Quick Preview acionado pela barra de espaço.
- Navegação e atalhos de teclado no explorer.
- Refino dos modos lista e grade já existentes.
- Extração do markup duplicado das quatro views para um componente compartilhado.

Fora:

- Drag-and-drop para mover arquivos. Não existe endpoint de move em
  `backend/src/routes/fileRoutes.js`, e implementá-lo exige uma operação por
  adapter de provider. Vira spec própria.
- Column view e media view. O usuário optou por refinar lista e grade.
- Tags, Locations e vistas salvas.

## Problema encontrado no código atual

As quatro views repetem o mesmo bloco de template: `FileListViewModeToggle`,
`FileListSelectionBar`, `FileListFilterBar`, `FileListHeader`, `FileListRow`,
`FileListGridCard`, `FileListContextMenu`, `FileDetailsModal`, `FilePreviewModal`,
`LoadingState` e o `useIncrementalRender` que alimenta a lista.

Adicionar o Inspector e o teclado view a view significaria escrever a mesma
mudança quatro vezes, três vezes seguidas. Extrair primeiro deixa o resto barato.

As diferenças reais entre as views são poucas:

| View | Cabeçalho | Altura da lista | Extras |
|---|---|---|---|
| MyDrive | breadcrumb navegável | `flex-1` (ocupa a tela) | dropzone, highlight de arquivo, `nameField='display_name'` |
| Starred | `h1` | `max-h-[min(52vh,520px)]` | mensagem de erro |
| Recent | `h1` | idem | mensagem de erro |
| SharedWithMe | `h1` | idem | mensagem de erro, expansão de filhos |

Essas diferenças viram props e slots.

## Arquitetura

### 1. `components/FileListSurface.vue` (novo)

Dono do markup compartilhado. Recebe o objeto retornado por `useFileListView` e
renderiza tudo que hoje está duplicado.

Props:

- `view` (Object, obrigatório) — retorno de `useFileListView`.
- `nameField` (String, default `'file_name'`).
- `fillHeight` (Boolean, default `false`) — `true` no MyDrive, lista ocupa a
  altura restante; `false` aplica `max-h-[min(52vh,520px)]`.
- `highlightedFileId` (String, default `null`).
- `errorMessage` (String, default `''`).

Slots:

- `header` — breadcrumb ou `h1`.
- `selection-prefix` — botão "abrir pasta" da barra de seleção, que depende da
  navegação de cada view.
- `overlay` — dropzone do MyDrive.

Eventos:

- `open` (item) — duplo clique ou Enter. Cada view decide se navega no
  `fileTreeStore` ou empurra rota.
- `open-selected` — ação "abrir" do menu de contexto e da barra de seleção.

O componente mantém o `useIncrementalRender` internamente (mesmos parâmetros de
hoje: `initialCount: 80`, `step: 80`, `threshold: 240`) e expõe `renderCount` via
`defineExpose`, porque o MyDrive precisa forçar a renderização de um item para
fazer scroll até o resultado de busca.

Depois dessa extração as quatro views ficam com fetch, navegação e o
`<FileListSurface>`. Nenhuma mudança visível para o usuário nesta etapa.

### 2. `components/FileInspector.vue` (novo)

Painel lateral à direita da lista, dentro do `FileListSurface`.

Layout:

- `lg` e acima: coluna fixa de 320px, `grid-cols-[minmax(0,1fr)_320px]` quando
  aberto, uma coluna só quando fechado.
- Abaixo de `lg`: bottom sheet sobreposto, fechado por padrão.
- Botão de alternância no cabeçalho, ao lado do `FileListViewModeToggle`.
- Estado aberto/fechado persistido em `localStorage` sob
  `omnicloud-inspector-open`, seguindo o padrão do tema em `DriveShell`.

Conteúdo por estado de seleção:

- **Nenhum item**: nome da pasta ou da view, contagem de itens e soma de tamanhos.
- **Um item**: thumbnail grande via `api.thumbnailUrl(file)` com fallback para o
  ícone de `getFileIcon`, nome, e os campos que hoje estão no `FileDetailsModal`
  (tipo, tamanho, dono, provider, criado, modificado, localização, remote ID).
  Abaixo, botões de abrir, download, favoritar, renomear e excluir, reutilizando
  os handlers já expostos por `useFileListView`.
- **Vários itens**: contagem, soma de tamanhos, quebra por tipo. Ações que aceitam
  seleção múltipla ficam habilitadas; as demais, desabilitadas.

**Origem dos dados.** Os campos completos não estão no objeto da lista: o modal
atual busca por `useFileDetailsModal.openDetails`, que chama `api.getFile(id)`.
O Inspector mantém esse fetch, mas em duas camadas:

1. Renderiza imediatamente o que já existe no item da lista — nome, tamanho,
   provider, datas, path. Sem request, sem piscar.
2. Enriquece com `openDetails(file)` para os campos que só o backend tem
   (mime type completo, remote ID, dono). O request é disparado por um `watch`
   em `primarySelectedFile` com debounce de 300ms, para que segurar a seta para
   baixo não gere um request por item. Se o painel estiver fechado, não busca
   nada.

Enquanto o enriquecimento não chega, os campos pendentes mostram o valor da
lista ou um traço, nunca um spinner que sacoda o layout.

`FileDetailsModal.vue` é deletado; `useFileDetailsModal.js` permanece, porque é
ele que faz o fetch. `showSelectedFileDetails` em `useFileActions` passa a abrir
e focar o Inspector em vez de apenas setar `isDetailsOpen`. As referências ao
modal saem das quatro views junto com a extração.

Os campos são renderizados com formatação, não como texto cru: `formatBytes` e
`formatDate` de `useFormatFile.js`, `providerLabel` para o provider.

### 3. `composables/useFileListKeyboard.js` (novo)

Chamado de dentro de `useFileListView`, logo depois de `useFileActions`, de modo
que as quatro views ganham teclado sem alteração própria.

O cursor é o `lastSelectedFileId` que já existe em `useFileSelection` — nenhum
estado novo. Mover o cursor é `replaceSelection(próximoItem)`.

| Tecla | Ação |
|---|---|
| ↑ / ↓ | move o cursor um item |
| ← / → | move o cursor um item, apenas no modo grade |
| Shift + ↑↓ | estende a seleção com `selectRange` |
| Home / End | primeiro / último item |
| Espaço | abre Quick Preview do item sob o cursor; fecha se já aberto |
| Enter | abre pasta, ou preview se for arquivo previsível |
| Ctrl/⌘ + A | seleciona todos os itens de `sortedFiles` |
| Delete / Backspace | `deleteSelectedFile` |
| F2 | `renameSelectedFile` |
| I | alterna o Inspector |
| Esc | fecha preview se aberto; senão limpa a seleção |

Regras de guarda:

- Ignora o evento se `event.target` for `input`, `textarea`, `select` ou
  `[contenteditable]`. Isso protege a busca global do `DriveShell` e a barra de
  filtros.
- Ignora se algum modal estiver aberto, exceto as teclas que o preview usa
  (Espaço, Esc, setas), que já são tratadas pelo `FilePreviewModal`.
- `preventDefault` nas setas, Espaço, Home, End e Ctrl/⌘+A para não rolar a
  página nem disparar a busca do navegador.

Quando o cursor muda, o item é rolado para a vista com
`scrollIntoView({ block: 'nearest' })` e recebe anel de foco visível. Se o cursor
cair além do que o `useIncrementalRender` renderizou, o `renderCount` é
aumentado antes do scroll — mesma técnica que o MyDrive já usa em
`ensureHighlightedFileRendered`.

O composable exporta `handleKeydown(event)` e registra o listener em `onMounted`,
removendo em `onBeforeUnmount`, junto dos listeners que `useFileListView` já
gerencia. Expor `handleKeydown` não é acessório: é o que torna o composable
testável no runner atual, que roda em Node puro sem DOM. Os testes chamam
`handleKeydown` com eventos falsos, sem precisar de `window`.

### 4. Quick Preview

Sem componente novo. `useFilePreviewModal` já expõe `openPreview`, `closePreview`,
`showPreviousPreview` e `showNextPreview`, e o `FilePreviewModal` já trata imagem,
vídeo, áudio, texto e PDF com navegação e download.

O que muda: o binding da barra de espaço, e o Espaço passando a fechar o preview
quando ele já está aberto — comportamento do Quick Look do macOS.

### 5. Refino de lista e grade

- Grade: thumbnails maiores, `xl:grid-cols-5` em telas largas quando o Inspector
  está fechado, `xl:grid-cols-4` quando aberto.
- Lista e grade: anel de foco no item sob o cursor, distinto do fundo de seleção,
  para que dê para ver os dois estados ao mesmo tempo.
- Nenhuma outra mudança visual. Modos novos ficam fora do escopo.

## Fluxo de dados

`useFileListView` continua sendo a fonte única de estado. `FileListSurface` recebe
esse objeto e repassa para os filhos; o Inspector lê `primarySelectedFile`,
`selectedFiles` e as flags `can*` que já existem. O teclado escreve pelo mesmo
caminho que o mouse: `replaceSelection`, `selectRange`, `clearSelection`,
`openPreview`. Não há caminho paralelo de mutação.

## Tratamento de erros

- Thumbnail que falha no Inspector cai para o ícone por tipo via `@error`.
- Fetch de detalhes que falha deixa o painel com os dados da lista. `openDetails`
  já chama `onError` e fecha em caso de erro; no Inspector isso vira apenas o
  descarte do enriquecimento, sem esvaziar o painel.
- Resposta de detalhes que chega depois da seleção ter mudado é descartada,
  comparando o id do arquivo — mesma proteção contra corrida que
  `useFilePreviewModal.loadText` já faz.
- Ações disparadas por teclado passam pelo mesmo `useFileActionProgress` das
  ações de mouse, então o overlay de progresso e as mensagens de erro continuam
  valendo.
- Delete por teclado usa a mesma confirmação de `deleteSelectedFile`. Nenhuma
  exclusão sem confirmação.
- Teclas cujas ações não se aplicam à seleção atual não fazem nada — sem erro,
  sem alerta.

## Testes

O runner é `node --test "test/*.test.js"`, Node puro, sem DOM e sem
`@vue/test-utils`. Testar componentes exigiria adicionar `vitest` mais um
ambiente de DOM. Não vale para este subprojeto: a lógica que pode quebrar em
silêncio é o teclado, e ela é JavaScript puro.

Teste novo, `test/useFileListKeyboard.test.js`, no estilo de
`test/useFilePreviewModal.test.js`:

- cursor anda com ↑↓ e para no primeiro e no último item;
- Shift+seta estende a seleção em vez de substituir;
- Ctrl/⌘+A seleciona todos os itens de `sortedFiles`;
- evento com `target` de tag `INPUT` é ignorado;
- Espaço abre o preview e, com o preview aberto, fecha;
- Esc com preview aberto fecha o preview e preserva a seleção; sem preview,
  limpa a seleção.

`FileInspector` e `FileListSurface` são verificados manualmente. Roteiro: as
quatro views abrem, listam, selecionam, previsualizam e abrem o Inspector;
teclado funciona em lista e em grade; a busca global do `DriveShell` continua
aceitando espaço e setas sem que o explorer roube o evento.

## Ordem de implementação

1. `FileListSurface.vue` e migração das quatro views. Refactor puro, sem mudança
   visível. Ponto de verificação: as quatro telas funcionam como antes.
2. `FileInspector.vue`, remoção do `FileDetailsModal.vue`, novas chaves em
   `locales/en.json` e `locales/id.json`.
3. `useFileListKeyboard.js` e o binding do Quick Preview.
4. Refino visual da grade e do anel de foco.

Cada etapa é um commit.
