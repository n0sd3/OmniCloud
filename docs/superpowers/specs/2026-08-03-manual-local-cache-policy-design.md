# Política manual de armazenamento local

Data: 2026-08-03  
Status: aprovado, aguardando revisão da especificação

## Objetivo

Permitir que cada usuário controle quais arquivos o OmniCloud mantém no volume local,
sem deixar de usar a nuvem como fonte de verdade. Cada conta terá uma configuração de
download automático, e cada arquivo poderá herdar essa configuração, forçar uma cópia
permanente ou impedir uma cópia permanente.

Arquivos que não devam permanecer localmente ainda poderão usar um cache temporário de
24 horas quando tiverem até 100 MB. Arquivos maiores serão transmitidos diretamente do
provedor. Miniaturas JPEG e PDFs derivados para preview permanecem em seus caches
próprios e não participam dessa política.

## Situação atual

O SQLite contém o espelho de metadados, enquanto o provedor é a fonte de verdade dos
bytes. O cache central da API, no volume `omnicloud_file_cache`, mantém indefinidamente
arquivos encontrados ao abrir uma pasta, arquivos lidos e arquivos enviados.

O acesso SMB possui ainda um segundo volume, `omnicloud_rclone_cache`. O rclone usa
atualmente o modo VFS `full`, que pode duplicar por até 24 horas qualquer arquivo lido
pelo SMB. Sem alteração, esse segundo cache poderia contrariar uma preferência de não
manter um arquivo grande localmente.

## Modelo de dados

### Configuração por conta

`cloud_accounts` ganha a coluna:

```text
auto_cache_enabled INTEGER NOT NULL DEFAULT 1
```

Contas existentes e novas começam com download automático ligado, preservando o
comportamento atual.

### Preferência por arquivo

Uma tabela separada preserva as decisões do usuário mesmo quando a sincronização
substitui registros de `file_metadata`:

```text
file_local_preferences
- user_id
- cloud_account_id
- remote_file_id
- mode: keep | exclude
- created_at
- updated_at
```

A chave única é `user_id + cloud_account_id + remote_file_id`. As duas relações com
usuário e conta usam exclusão em cascata. `inherit` é representado pela ausência de um
registro, evitando armazenar o caso padrão.

Preferências órfãs, causadas por arquivos removidos remotamente, são eliminadas durante
a reconciliação da conta. A identidade usa o ID remoto porque o ID local de
`file_metadata` pode mudar entre sincronizações.

## Resolução da política

A política efetiva é resolvida em um único serviço antes de qualquer aquecimento,
leitura ou publicação local:

| Preferência | Automático da conta | Política efetiva |
| --- | --- | --- |
| `keep` | ligado ou desligado | permanente |
| `exclude` | ligado ou desligado | temporária ou streaming |
| `inherit` | ligado | permanente |
| `inherit` | desligado | temporária ou streaming |

Na política temporária:

- arquivos de até e incluindo `FILE_CACHE_TEMP_MAX_BYTES` recebem cache por
  `FILE_CACHE_TEMP_TTL_MS`;
- arquivos acima do limite são transmitidos diretamente, sem gravar o conteúdo no
  cache central.

Os padrões são:

| Variável | Padrão | Função |
| --- | ---: | --- |
| `FILE_CACHE_TEMP_MAX_BYTES` | `104857600` | limite inclusivo de 100 MB |
| `FILE_CACHE_TEMP_TTL_MS` | `86400000` | retenção temporária de 24 horas |

## Fluxos de leitura

### Abrir uma pasta

Depois de responder a listagem, `fileCacheService.warmFolder` consulta a política de
cada filho direto. Somente arquivos com política permanente entram na fila de
aquecimento. Desligar o automático de uma conta impede novos aquecimentos herdados,
mas não remove conteúdo já existente.

### Download, preview e WebDAV

Todos continuam passando por `fileCacheService.openFile`:

1. Política permanente e cópia válida: serve o volume local.
2. Política permanente e miss: serve o stream remoto imediatamente e agenda a cópia
   completa.
3. Política temporária, arquivo de até 100 MB e cópia não expirada: serve o volume
   local.
4. Política temporária, arquivo de até 100 MB e miss: serve o stream remoto e agenda
   uma cópia com expiração de 24 horas.
5. Política temporária e arquivo acima de 100 MB: serve somente o stream remoto.

Ranges continuam seguindo as capacidades atuais: cache hit usa `createReadStream` com
intervalo; miss usa Range remoto somente quando o adapter declara suporte.

Um sidecar temporário recebe `expiresAt`. Uma entrada vencida é tratada imediatamente
como miss e nunca é servida. A remoção física ocorre em uma limpeza periódica simples e
também pode ocorrer durante acessos e inicialização. Entradas permanentes não recebem
expiração.

### Conteúdo derivado

Miniaturas JPEG e PDFs gerados para preview permanecem nos caches atuais. Eles são
artefatos derivados e pequenos, não cópias completas do arquivo, e ficam fora das ações
`keep`, `exclude` e de limpeza do cache da conta.

## Fluxos de alteração

### Alterar preferência do arquivo

`PATCH /api/files/:id/local-preference` aceita somente:

```json
{ "mode": "inherit" | "keep" | "exclude" }
```

- `keep` persiste a preferência e agenda um download permanente em segundo plano;
- `exclude` persiste a preferência e remove a cópia completa existente;
- `inherit` remove o registro e reaplica a política da conta;
- pastas recebem `400`, pois preferências recursivas ficam fora desta versão.

Se a remoção física após `exclude` falhar, a preferência continua valendo: leituras não
servem a entrada permanente antiga e a limpeza é tentada novamente. Se o download de
`keep` falhar, a preferência permanece e o próximo acesso ou aquecimento tenta de novo.

### Alterar configuração da conta

`PATCH /api/accounts/:id/cache` aceita:

```json
{ "auto_cache_enabled": true | false }
```

Desligar impede novos aquecimentos herdados, mas não apaga cópias existentes. Ligar
novamente também não varre toda a conta: o aquecimento recomeça conforme as pastas são
abertas.

Quando o automático estiver desligado, o cartão da conta mostra a ação separada
`DELETE /api/accounts/:id/cache`. Essa ação remove somente conteúdo original do cache
central pertencente à conta. Ela preserva arquivos remotos, metadados, preferências por
arquivo e derivados de preview.

Arquivos marcados como `keep` também são removidos por essa limpeza explícita, mas a
preferência permanece. Eles voltam a ser baixados no próximo acesso ou aquecimento
explícito, não durante a própria limpeza.

### Upload

O stream recebido pode continuar sendo capturado temporariamente enquanto o destino
final e possíveis fallbacks são resolvidos. Depois do sucesso remoto e da sincronização,
a política efetiva da conta de destino decide a publicação:

- permanente: publica a captura sem baixar novamente;
- temporária: descarta a captura, pois o upload por si só não inicia a retenção de
  24 horas;
- falha na captura local: não transforma um upload remoto bem-sucedido em erro.

Uma preferência `keep` só pode ser atribuída depois que o arquivo possui identidade
remota, portanto não existe preferência por arquivo durante a iniciação do upload.

### Rename, delete e sincronização

Rename preserva preferência e cache quando o ID remoto permanece estável. Se o
provedor trocar o ID, a preferência antiga é removida e a entrada antiga é invalidada.

Delete remove conteúdo e preferência depois do sucesso no provedor. A sincronização
continua invalidando cópias removidas ou com tamanho/versão alterados e limpa
preferências sem arquivo remoto correspondente.

Desconectar uma conta remove suas cópias no cache central e suas preferências por
cascata antes de excluir a conta local. Isso não apaga dados no provedor.

## Concorrência e consistência

A política é consultada ao enfileirar e novamente imediatamente antes da publicação.
Assim, um download iniciado antes de `exclude`, de desligar a conta ou de limpar o
cache não pode restaurar conteúdo permanente proibido.

Downloads da mesma identidade e versão continuam deduplicados. O trabalho em voo
carrega a retenção pretendida, mas a política mais recente prevalece na publicação. Se
uma entrada permanente passar a temporária durante o download, ela só poderá ser
publicada com `expiresAt` quando ainda respeitar o limite de tamanho; caso contrário, o
temporário é descartado.

A limpeza por conta ocorre depois de persistir `auto_cache_enabled = 0`. A revalidação
dos trabalhos em voo impede a recriação, e a remoção varre sidecars por `userId` e
`accountId`, sem derivar identidade a partir de nomes fornecidos pelo usuário.

## SMB e cache VFS do rclone

O rclone muda de:

```text
--vfs-cache-mode full
```

para:

```text
--vfs-cache-mode writes
```

Leituras SMB passam a obedecer à política central aplicada pelas rotas WebDAV. Arquivos
grandes excluídos não são duplicados pelo rclone, enquanto arquivos permanentes e
temporários usam o cache da API normalmente.

O VFS cache permanece para escritas SMB, incluindo uploads e sobrescritas. Seus limites
de tamanho e idade continuam configuráveis para essa finalidade. A mudança evita dois
caches de leitura com políticas independentes.

## Interface

### Contas

Cada cartão de conta na tela de cota exibe:

- toggle `Download automático`;
- explicação de que o aquecimento ocorre conforme pastas são abertas;
- quando desligado, botão `Apagar cópias locais`;
- confirmação explícita de que arquivos na nuvem não serão removidos;
- estado de carregamento, sucesso e erro das duas ações.

O botão de limpeza não precisa calcular tamanho ou quantidade antes de executar. A API
retorna a quantidade de entradas removidas e eventuais falhas para uma mensagem final.

### Arquivos

Para uma seleção de exatamente um arquivo não-pasta, o menu de contexto e o inspetor
mostram `Armazenamento local` com as opções:

- `Seguir configuração da conta`;
- `Manter localmente`;
- `Não manter localmente`.

A opção atual é marcada. A interface atualiza de forma otimista, restaura o valor
anterior em caso de erro e exibe a falha. `keep` pode mostrar `Preparando cópia local`,
sem barra de progresso e sem criar um novo canal de eventos. Ações para pastas e ações
em massa ficam fora do escopo.

As respostas de listagem e detalhes incluem `local_preference` com `inherit`, `keep` ou
`exclude`, além de `account_auto_cache_enabled`. A interface deriva a política efetiva
desses dois campos; não precisa consultar o sistema de arquivos para renderizar o menu.

## API e autorização

Todos os endpoints usam o usuário autenticado para buscar conta e arquivo. Um ID válido
de outro usuário responde como não encontrado. Modos desconhecidos e payloads que não
sejam booleanos recebem `400`.

As respostas seguem o envelope `{ data: ... }` já usado pelo projeto. Operações
explícitas de preferência ou limpeza devolvem erro ao usuário quando não puderem
cumprir o efeito solicitado. Falhas oportunistas do cache durante leitura, preview,
WebDAV ou upload continuam apenas registradas e nunca bloqueiam uma operação remota
bem-sucedida.

## Testes

Os testes permanecem em `node:test`, com diretórios temporários e sem dependências
novas.

### Backend

- migração aditiva preserva contas existentes com automático ligado;
- combinação de `inherit`, `keep`, `exclude` com o toggle da conta;
- limite inclusivo de 100 MB e arquivo um byte acima do limite;
- expiração exata de 24 horas e rejeição imediata de entrada vencida;
- aquecimento de pasta inclui somente políticas permanentes;
- arquivo pequeno não permanente aquece temporariamente após leitura;
- arquivo grande não permanente nunca é gravado;
- `keep` prevalece com automático desligado;
- `exclude` prevalece com automático ligado;
- mudança de política durante download impede publicação incompatível;
- toggle não remove conteúdo existente;
- limpeza remove somente originais da conta solicitada e preserva preferências;
- captura de upload segue a conta de destino final, inclusive fallback;
- rename, delete, desconexão e sync reconciliam conteúdo e preferências;
- autorização impede acesso cruzado entre usuários;
- WebDAV usa a mesma resolução de política;
- falhas do volume preservam operações remotas oportunistas.

### Frontend e SMB

- API client envia os três modos e o booleano sem coerção indevida;
- ações de arquivo aparecem somente para uma seleção de arquivo;
- erro restaura a preferência exibida;
- cartão liga/desliga o automático e só mostra limpeza quando desligado;
- confirmação diferencia cache local de arquivo remoto;
- comando do rclone usa `--vfs-cache-mode writes`.

## Fora do escopo

- Preferências recursivas por pasta.
- Alteração em massa de preferências.
- Barra de progresso para downloads `keep`.
- Limite global, quota local, LRU ou painel detalhado de uso do cache.
- Remoção de miniaturas e PDFs derivados pelas ações desta política.
- Sincronização de alterações feitas diretamente no volume local.
- Redis, worker separado ou nova dependência.

## Critérios de aceite

1. O usuário pode ligar ou desligar download automático por conta sem exclusão
   implícita de conteúdo.
2. Com o automático desligado, aparece uma ação confirmada para apagar cópias locais
   da conta.
3. Cada arquivo pode herdar, forçar retenção permanente ou impedir retenção permanente.
4. Arquivos não permanentes de até 100 MB podem permanecer por no máximo 24 horas;
   arquivos maiores são somente transmitidos.
5. Preview, download, WebDAV e SMB respeitam a mesma política de leitura.
6. Upload, rename, delete, sync e desconexão não deixam cópias ou preferências
   inconsistentes.
7. Miniaturas e previews derivados continuam disponíveis em seus caches próprios.
8. Nenhuma falha oportunista do cache converte uma operação remota bem-sucedida em
   falha.
