# Cache local persistente de arquivos

Data: 2026-08-02
Status: aprovado, aguardando revisão da especificação

## Objetivo

Manter no servidor uma cópia persistente dos arquivos acessados ou encontrados ao abrir
uma pasta, reduzindo leituras repetidas nos provedores de nuvem sem transformar o volume
local na fonte primária dos dados.

A listagem continua vindo imediatamente do espelho de metadados no SQLite. Os conteúdos
ficam em um volume Docker sem limite ou expiração automática. Somente operações feitas
pelo OmniCloud escrevem nesse volume; alterações feitas diretamente nele não são
observadas nem enviadas aos provedores.

## Decisões

- O provedor continua sendo a fonte de verdade; o volume local é um cache durável.
- Abrir uma pasta agenda, em segundo plano, somente os arquivos diretamente nela.
- Abrir um arquivo ausente serve o conteúdo remoto imediatamente e inicia, em paralelo,
  o download completo para o volume.
- Depois de completo e validado, download, preview e WebDAV leem do volume.
- Arquivos completos permanecem indefinidamente. Não há teto de armazenamento ou LRU.
- O estado de pasta aquecida expira em uma hora, mas somente em memória.
- Redis não será adicionado. A implantação atual tem uma única API, e perder bloqueios e
  marcadores durante um restart é inofensivo porque o volume e os sidecars persistem.
- Não serão adicionadas dependências: a implementação usa `fs`, `stream` e `crypto` do
  Node.

## Arquitetura

```text
Frontend / WebDAV
       |
       | lista metadados
       v
SQLite file_metadata
       |
       | agenda filhos diretos
       v
localFileCacheService ----> /app/cache/files (volume persistente)
       |                              |
       | cache miss                   | cache hit
       v                              v
Cloud adapter ------------------> stream local
```

O Compose ganha o volume `omnicloud_file_cache`, montado na API em
`/app/cache/files`. O volume existente `omnicloud_api_data` continua reservado ao
SQLite.

Um novo `localFileCacheService` será o único componente que conhece a estrutura do
volume. Rotas e serviços não construirão caminhos por conta própria.

## Identidade e layout dos arquivos

A chave lógica de um arquivo é:

```text
user_id + cloud_account_id + remote_file_id
```

Cada componente será convertido em hash SHA-256 antes de participar do caminho. Isso
impede path traversal, evita nomes incompatíveis com o sistema de arquivos e mantém
usuários e contas isolados.

Cada entrada contém:

```text
<cache-key>.data       conteúdo completo
<cache-key>.json       sidecar de validade
<cache-key>.<uuid>.tmp download ainda incompleto
```

O sidecar registra a chave lógica, tamanho, `remote_modified_time` e o instante em que a
cópia foi concluída. Conteúdo e sidecar são escritos em temporários e publicados por
rename atômico. Um `.data` sem sidecar compatível nunca é considerado válido.

## Validação

Uma entrada é válida quando:

- o conteúdo e o sidecar existem;
- a chave lógica do sidecar corresponde ao registro solicitado;
- o tamanho gravado corresponde ao tamanho em `file_metadata` e ao `stat` local;
- `remote_modified_time` corresponde ao metadado atual, quando o provedor o fornece.

Se o provedor não oferece um marcador confiável de versão, cada snapshot de
sincronização invalida conservadoramente as cópias daquela conta. Isso preserva a
correção ao custo de novos downloads sob demanda para esses provedores.

## Estado em memória

Dois `Map`s no processo da API são suficientes:

- `warmedFolders`: chave por usuário e caminho normalizado, com expiração de uma hora;
- `inflightDownloads`: chave pela identidade e versão do arquivo, apontando para a
  Promise do download completo.

`inflightDownloads` impede downloads completos duplicados dentro da instância única da
API. Entradas são removidas ao concluir ou falhar. Qualquer alteração detectada por
sincronização limpa os marcadores de pasta aquecida do usuário afetado.

Esses mapas não são restaurados após restart. O primeiro acesso volta a verificar os
sidecars persistidos, operação local e barata.

## Fluxos de leitura

### Abrir pasta

1. `GET /api/files?path=...` consulta `file_metadata` e responde sem aguardar conteúdo.
2. Depois de obter a lista, agenda somente entradas com `is_folder = 0` diretamente
   naquele caminho.
3. Se a pasta ainda estiver marcada como aquecida, não agenda novamente.
4. Cada trabalho valida primeiro o volume; somente misses usam o adapter.
5. A fila executa no máximo `FILE_CACHE_CONCURRENCY` downloads simultâneos, padrão 3.

O mesmo comportamento se aplica à abertura de uma pasta compartilhada depois que o
adapter devolve seus filhos diretos.

### Abrir arquivo

Download, preview e GET WebDAV usam a mesma resolução:

1. Cache válido: abre `createReadStream` local.
2. Cache ausente: obtém o stream remoto para responder imediatamente e agenda um
   download completo separado, deduplicado por `inflightDownloads`.
3. O download completo só publica a entrada depois de terminar e validar o tamanho.

Uma requisição Range em cache hit é atendida com `createReadStream({ start, end })`.
Em cache miss, o Range remoto atende o cliente enquanto um segundo stream remoto baixa
o arquivo completo. A duplicação ocorre apenas no primeiro acesso parcial.

Abortar a resposta do cliente não cancela o aquecimento já iniciado.

## Fluxos de alteração

### Upload

O stream recebido passa por um `Transform` que também grava um temporário local. O
adapter continua recebendo o stream normalmente.

- Sucesso no provedor: sincroniza metadados, associa o temporário ao `remote_file_id`
  devolvido e publica conteúdo e sidecar.
- Falha no provedor ou na captura: remove o temporário. Falha apenas na captura local
  não converte um upload remoto bem-sucedido em erro; o arquivo poderá ser aquecido
  depois.

### Rename

Após sucesso no provedor e atualização dos metadados, mantém o mesmo conteúdo local e
atualiza o sidecar se a identidade remota não mudou. Se o provedor trocar o ID, a
reconciliação invalida a entrada antiga.

### Delete

Depois do sucesso no provedor, remove conteúdo e sidecar. Exclusão de pasta usa a
diferença entre snapshots para remover também as entradas dos descendentes apagados.

### Criação de pasta

Atualiza provedor e metadados como hoje. Não há conteúdo para gravar no volume.

## Reconciliação com os provedores

Antes de `replaceFilesForAccount`, `syncService` preserva o snapshot SQLite atual da
conta. Depois de obter o snapshot remoto, compara registros por `remote_file_id`:

- removido: apaga a entrada local;
- mesmo ID com tamanho ou `remote_modified_time` diferente: invalida a entrada;
- novo: não baixa imediatamente; será aquecido quando sua pasta for aberta;
- inalterado: preserva a entrada local.

A substituição do mirror SQLite e a reconciliação do cache pertencem à mesma operação
de sincronização, mas o SQLite continua sendo atualizado mesmo se uma remoção local
falhar. A falha é registrada e tentada novamente em acesso ou sincronização futura.

Esse fluxo cobre alterações externas realizadas diretamente no provedor. Não existe
watcher no volume local.

## Tratamento de erros e concorrência

- Falha de leitura ou escrita do cache nunca impede a leitura remota nem uma alteração
  bem-sucedida no provedor.
- Temporários abandonados são removidos na inicialização.
- Downloads concorrentes da mesma versão compartilham uma única Promise.
- Uma versão nova usa outra chave de trabalho; a antiga não pode sobrescrevê-la porque
  a validade é conferida novamente antes da publicação.
- Erro do adapter encerra o temporário e remove o bloqueio em memória.
- Falta de espaço ou volume somente leitura é registrada; não há eviction automática.
- Sidecars inválidos, truncados ou incompatíveis são tratados como cache miss.

## Configuração

Variáveis opcionais:

| Variável | Padrão | Função |
| --- | --- | --- |
| `FILE_CACHE_PATH` | `/app/cache/files` | raiz do volume de conteúdo |
| `FILE_CACHE_WARM_TTL_MS` | `3600000` | duração do marcador de pasta aquecida |
| `FILE_CACHE_CONCURRENCY` | `3` | downloads completos simultâneos |

Em desenvolvimento fora do Docker, `FILE_CACHE_PATH` usa por padrão
`backend/.cache/files`; `backend/.cache/` será adicionado ao `.gitignore` durante a
implementação.

## Integração com SMB/WebDAV

As rotas WebDAV passam a consumir o mesmo `localFileCacheService`; assim, leituras por
SMB via rclone também aproveitam a cópia central. Um VFS cache futuro do rclone não deve
duplicar indefinidamente esse conteúdo: deve permanecer limitado ao mínimo necessário
para semântica de escrita do mount.

Esta especificação substitui, para leituras, a proposta de cache de bytes exclusivamente
no rclone descrita na especificação SMB. O SQLite continua sendo o cache de metadados.

## Testes

Os testes usam `node:test` e diretórios temporários, sem framework ou serviço externo.

- caminho derivado somente de hashes e isolado por usuário/conta;
- hit válido por tamanho e versão remota;
- sidecar ausente, inválido ou desatualizado produz miss;
- publicação atômica e limpeza de temporários após erro;
- duas solicitações simultâneas iniciam apenas um download completo;
- aquecimento inclui somente arquivos diretamente na pasta;
- marcador de pasta expira após uma hora;
- fila respeita a concorrência configurada;
- abertura em miss responde pelo adapter e aquece em paralelo;
- abertura seguinte lê do volume;
- Range local devolve o intervalo correto;
- mudança detectada pelo sync invalida conteúdo;
- upload publica a captura após sucesso e limpa após falha;
- rename preserva a entrada quando o ID remoto é estável;
- delete remove conteúdo e sidecar;
- falha no cache preserva o comportamento remoto existente.

## Fora do escopo

- Redis, BullMQ ou processo worker separado.
- Limite de volume, LRU, expiração ou painel de limpeza.
- Sincronização de alterações feitas diretamente no volume.
- Tornar o volume a fonte de verdade ou operar offline.
- Pré-carregamento recursivo de subpastas.
- Cache distribuído para múltiplas instâncias da API.
- Criptografia adicional do conteúdo local; a proteção do volume é responsabilidade do
  host.

## Critérios de aceite

- A listagem de pasta não espera downloads.
- Os arquivos diretamente na pasta começam a ser baixados em segundo plano.
- Abrir um arquivo em miss começa a resposta remota imediatamente e aquece o volume.
- Depois de completo, download, preview e WebDAV leem localmente, incluindo Range.
- Upload, rename e delete mantêm provedor, SQLite e volume coerentes.
- Mudanças externas detectadas no provedor invalidam a cópia local.
- Restart da API preserva e reutiliza arquivos completos válidos.
- Nenhum Redis ou nova dependência é necessário.
