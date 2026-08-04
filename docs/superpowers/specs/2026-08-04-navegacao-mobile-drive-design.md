# Navegação de pastas e abertura de arquivos no mobile

Data: 2026-08-04
Escopo: `frontend/` — Meu Drive (`MyDriveView`), lista de arquivos e roteamento.

## Problema

Navegar entre pastas e abrir arquivos é ruim, principalmente no telefone. Causas verificadas no código atual:

1. **A pasta atual não existe na URL.** `currentPath` vive só no store Pinia (`stores/fileTree.js`) e a rota é sempre `/my-drive`. Consequências: o botão voltar do sistema (Android) e o swipe-back (iOS) saem do Drive inteiro em vez de subir um nível; F5 volta para a raiz; não há como compartilhar link de uma pasta.
2. **Abrir item depende de duplo clique.** `FileListRow` e `FileListGridCard` emitem `open` apenas em `@dblclick`. Em touch, double-tap é gesto de zoom do navegador, então no telefone praticamente não se abre arquivo nem se entra em pasta tocando no item — sobra selecionar e usar a barra de seleção.
3. **A lista força scroll horizontal no telefone.** O container da tabela tem `min-w-[760px]` com quatro colunas (nome / conta / modificado / tamanho).
4. **O breadcrumb quebra em várias linhas** em caminhos profundos (`flex-wrap` sem colapso).

Fora de escopo (identificado, não tratado agora): cache por path para evitar o piscar da lista a cada navegação, árvore de pastas na sidebar, drag & drop para mover. O componente `components/FileExplorer.vue` está morto (nenhum import) — a remoção fica para um trabalho separado.

## Solução

Quatro mudanças independentes entre si.

### 1. Path da pasta na URL

Rota `my-drive` passa a aceitar o caminho:

```js
{ path: '/my-drive/:segments(.*)*', name: 'my-drive', component: MyDriveView }
```

`/my-drive` continua válido e significa raiz.

Duas funções puras novas em `stores/fileTree.js` (ou `utils/`), exportadas para teste:

- `pathToSegments('/A/B/')` → `['A', 'B']`
- `segmentsToPath(['A', 'B'])` → `'/A/B/'`, `segmentsToPath([])` → `'/'`

Regras: raiz é `'/'`; caminho de pasta sempre termina em `/`; segmentos vazios são descartados. A codificação percentual da URL fica com o vue-router — `params.segments` chega decodificado.

Fluxo de navegação:

- `fileTreeStore.navigate(path)` deixa de chamar `loadFiles` e passa a fazer `router.push({ name: 'my-drive', params: { segments: pathToSegments(path) } })`. O store importa a instância singleton do router (`import router from '../router'`).
- `MyDriveView` observa `route.params.segments` com `{ immediate: true }` e chama `fileTreeStore.loadFiles(segmentsToPath(segments))`. O `loadFiles` do `onMounted` sai — o watcher imediato cobre a carga inicial.
- Se a rota alvo é igual à atual, `router.push` não dispara o watcher; nesse caso não há nada a recarregar (o refresh explícito continua sendo `loadFiles`).

Isso elimina `pendingPath`. Call sites afetados:

- `DriveShell.openSearchResult`: mantém `pendingHighlightId` e troca todo o bloco `pendingPath` + `router.push({ name: 'my-drive' })` por um único `fileTreeStore.navigate(targetPath)`.
- `StarredView`: mesma troca.
- `MyDriveView.openFolder` e os botões do breadcrumb: já chamam `navigate`, seguem iguais.

O highlight pós-navegação (`consumePendingHighlight`) continua funcionando: ele reage a `fileTreeStore.files`, que ainda muda ao fim do `loadFiles`.

### 2. Tap único abre, em ponteiro grosso

Composable novo `composables/usePointerCoarse.js`: um `ref` alimentado por `matchMedia('(pointer: coarse)')`, com listener de `change` (tablet com teclado acoplado/desacoplado).

Em `FileListRow` e `FileListGridCard`:

- ponteiro grosso: `@click` emite `open`;
- ponteiro fino: comportamento atual — `@click` emite `select`, `@dblclick` emite `open`.

`MyDriveView.openItemOnDoubleClick` já roteia pasta para `openFolder` e arquivo para `openPreview`; nada muda no consumidor. Desktop não regride.

### 3. Long-press abre o menu de contexto

Nenhum código de gesto novo. Chrome Android e iOS Safari disparam `contextmenu` no long-press, e `FileListRow`/`FileListGridCard` já escutam esse evento; `useContextMenu.openContextMenu` já reposiciona o menu dentro da viewport, e `FileListContextMenu` já tem abrir / baixar / renomear / favoritar / detalhes / excluir.

Único ajuste: `-webkit-touch-callout: none` nas linhas e cards, para o callout nativo do iOS não competir com o menu.

Decisão explícita: **não há modo de seleção múltipla no telefone.** O menu de contexto cobre as ações de um item, que é o caso comum. Seleção múltipla continua sendo desktop.

### 4. Lista compacta abaixo de `sm`

- `FileListSurface`: `min-w-[760px]` vira `sm:min-w-[760px]`; o `overflow-x-auto` do container só vale a partir de `sm`.
- `FileListHeader`: `hidden sm:grid` — cabeçalho de colunas some no telefone.
- `FileListRow`: duas apresentações no mesmo componente por classes responsivas. No mobile, uma coluna com nome (+ estrela) e um subtítulo `conta · tamanho · modificado`; a partir de `sm`, o grid de quatro colunas atual, inalterado.
- Breadcrumb do `MyDriveView`: abaixo de `sm`, um botão `‹` que navega para o pai mais o nome da pasta atual; a partir de `sm`, a trilha completa de hoje.

## Testes

O workspace `frontend` já roda `node --test "test/*.test.js"` com testes em `node:test` — nenhuma dependência nova. Um arquivo novo, `frontend/test/drivePath.test.js`, no mesmo estilo dos existentes, cobrindo as funções puras de path:

- raiz nos dois sentidos (`'/'` ↔ `[]`);
- ida e volta de caminho profundo;
- nome com espaço e com acento;
- barras duplicadas e ausência de barra final normalizam para a mesma coisa.

Sem testes de componente, sem jsdom, sem fixtures. As funções ficam em `src/utils/drivePath.js` para o teste não arrastar o router junto com o store.

Verificação manual antes de entregar, em viewport mobile: entrar em pasta com um toque, voltar pelo botão do navegador, F5 mantendo a pasta, abrir link direto de subpasta, long-press abrindo o menu, tocar em arquivo abrindo preview, e conferir que não há scroll horizontal na lista.

## Arquivos tocados

| Arquivo | Mudança |
|---|---|
| `frontend/src/router/index.js` | rota `my-drive` aceita `:segments(.*)*` |
| `frontend/src/utils/drivePath.js` | novo — `pathToSegments`/`segmentsToPath` |
| `frontend/src/stores/fileTree.js` | `navigate` via router, remove `pendingPath` |
| `frontend/src/views/MyDriveView.vue` | watcher de rota, breadcrumb responsivo, remove carga do `onMounted` |
| `frontend/src/components/DriveShell.vue` | `openSearchResult` usa `navigate` |
| `frontend/src/views/StarredView.vue` | idem |
| `frontend/src/composables/usePointerCoarse.js` | novo |
| `frontend/src/components/FileListRow.vue` | tap abre em touch, layout compacto, callout off |
| `frontend/src/components/FileListGridCard.vue` | tap abre em touch, callout off |
| `frontend/src/components/FileListSurface.vue` | `min-w`/overflow só a partir de `sm` |
| `frontend/src/components/FileListHeader.vue` | `hidden sm:grid` |
| `frontend/test/drivePath.test.js` | novo — teste das funções de path |
| `frontend/src/locales/{en,id}.json` | chave `common.back` para o botão de voltar do breadcrumb |

## Riscos

- **Nome de pasta com caractere especial na URL.** Mitigado pelo encode/decode do vue-router e coberto pelo teste de path.
- **`contextmenu` no long-press do iOS** é menos previsível que no Android. Se falhar em algum caso, o item continua acessível por tap (abre) e as ações por preview/inspector; a correção seria um handler de long-press manual, fora do escopo inicial.
- **Deep link para pasta inexistente** cai no erro que `loadFiles` já trata (`store.error`), sem tela branca.
