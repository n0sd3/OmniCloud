# Servidor SMB para o OmniCloud

Data: 2026-08-02
Status: aprovado, pronto para planejamento de implementação

## Objetivo

Expor a árvore virtual unificada do OmniCloud como um compartilhamento SMB, para que
Linux, macOS, iOS e Windows montem o drive nativamente pelo Finder, Explorer, app Files
e `mount.cifs`, sem passar pela interface web.

SMB foi escolhido em vez de WebDAV como protocolo de ponta porque o app Files do iOS
monta SMB nativamente e não monta WebDAV.

## Escopo

Dentro do escopo:

- Camada WebDAV no backend Express, mapeada sobre `fileService` e a camada de adapters.
- Suporte a `Range` (leitura por offset) nos adapters que permitem.
- Container Samba servindo um share por usuário, alimentado por `rclone mount`.
- Provisionamento dinâmico de contas Samba e mounts a partir dos usuários do OmniCloud.
- Tela de configuração de acesso SMB no frontend.

Fora do escopo:

- Substituir conteúdo de arquivo preservando versões no provider (`PUT` sobre arquivo
  existente vira delete + upload).
- `COPY` server-side em WebDAV.
- `LOCK` / `UNLOCK` em WebDAV.
- Hash NTLM calculado no backend (ver "Decisões em aberto").

## Arquitetura

```
Finder / Explorer / Files (iOS) / Linux
        │  SMB2/3 · porta 445
        ▼
┌─ container omnicloud-smb ─────────────────┐
│  smbd  ── share por usuário               │
│    └─ /mnt/omnicloud/<userId>             │
│  rclone mount (1 processo por usuário)    │
│  smb-provisioner (poll 30s)               │
└───────────────┬───────────────────────────┘
                │  HTTP WebDAV + Basic Auth
                ▼
┌─ container api (Express) ─────────────────┐
│  /webdav/*  →  webdavService              │
│      ├─ metadados: fileService (SQLite)   │
│      └─ bytes: adapters (Range)           │
└───────────────┬───────────────────────────┘
                ▼
   Google Drive · Dropbox · OneDrive · S3 · Yandex · pCloud · MEGA
```

Nenhum código de FUSE é escrito. O `rclone` é o cliente FUSE, e o WebDAV é a interface
entre ele e o OmniCloud. Cache, retry, emulação de leitura parcial e atributos POSIX
vêm prontos do rclone.

## Componentes

### 1. Camada WebDAV

Arquivos novos: `backend/src/routes/webdavRoutes.js`, `backend/src/services/webdavService.js`.

O único consumidor é o `rclone`. Isso permite ignorar as exigências de `LOCK` do Finder
e as do Mini-Redirector do Windows, que só apareceriam se um cliente montasse o WebDAV
diretamente.

| Método | Mapeia para | Notas |
| --- | --- | --- |
| `OPTIONS` | — | anuncia `DAV: 1` |
| `PROPFIND` | `listFilesByPath(userId, path)` | Depth 0 e 1; responde XML multistatus |
| `GET` | `adapter.getDownloadStream(file, { start, end })` | honra `Range`, responde `206` |
| `HEAD` | metadados do mirror | sem corpo |
| `PUT` | `selectBestAccount()` + `adapter.uploadStream()` | cria ou substitui |
| `MKCOL` | `adapter.createFolder()` | |
| `DELETE` | `adapter.deleteFile()` | |
| `MOVE` | `adapter.renameFile()` | rename e move dentro do mesmo provider |
| `COPY` | — | responde `501`; rclone cai no fallback GET+PUT |

O corpo da requisição `PROPFIND` é ignorado e a resposta é sempre `allprop`. O rclone
aceita esse comportamento, e isso elimina a necessidade de um parser de XML de entrada.

Propriedades emitidas por recurso: `displayname`, `getcontentlength`, `getcontenttype`,
`getlastmodified`, `resourcetype`.

### 2. Range nos adapters

`BaseCloudAdapter.getDownloadStream(fileRecord, options)` ganha `options.start` e
`options.end`. `getCapabilities()` ganha a flag `supportsRange`.

Suportam `Range` nativo: Google Drive (`files.get?alt=media`), Dropbox
(`/2/files/download`), OneDrive (Microsoft Graph), S3, Yandex Disk.

Quem não suporta ignora `options` e devolve o corpo inteiro. Nesse caso o `webdavService`
responde `200` em vez de `206`, e o rclone lida com a diferença.

### 3. Cache

Dois níveis, ambos já existentes no projeto. Nenhum serviço de cache novo é escrito —
um terceiro cache entre os dois adicionaria invalidação para manter sem entregar
capacidade nova.

**Metadados:** o mirror SQLite alimentado pelo `syncService` já é o cache. `PROPFIND`
lê de `file_metadata` e nunca toca no provider, então navegar pastas no Finder é
instantâneo.

**Bytes:** VFS cache do rclone, em volume dedicado:

```
--vfs-cache-mode full
--vfs-cache-max-size 20G
--vfs-cache-max-age 24h
--vfs-read-chunk-size 32M
```

Com `Range` nos adapters, o rclone busca por chunk sob demanda em vez de baixar o
arquivo inteiro ao abrir.

### 4. Autenticação

Duas camadas independentes.

O desenho é multi-usuário e funciona nos dois modos do app. Em `APP_MODE=hosted` cada
usuário registrado ganha sua conta Samba e seu share. Em `APP_MODE=local` o provisioner
recebe um único usuário (`getFallbackLocalUser()`) e provisiona um único share — mesmo
código, sem caminho especial.

**SMB (NTLMv2):** o usuário define uma senha SMB em Settings, distinta da senha da conta
OmniCloud. O backend guarda cifrada com `env.encryptionKey` — o mesmo mecanismo já usado
para tokens OAuth e para as senhas de MEGA e pCloud.

**WebDAV (Basic Auth):** um token separado por usuário, gerado junto com a senha SMB.
Vazar um não entrega o outro.

**Endpoint interno:** `GET /internal/smb/users` devolve
`{ userId, username, smbPassword, webdavToken }` para o provisioner. Protegido por
`SMB_PROVISION_SECRET`, e deliberadamente não exposto no proxy do frontend — só
alcançável dentro da rede do compose.

A senha SMB trafega em claro nessa rota interna porque o Samba precisa dela para gerar
o hash NTLM via `smbpasswd`.

### 5. Provisionador

Arquivo novo: `smb/provisioner.js`, rodando no container SMB, com poll a cada 30s.

Para cada usuário retornado pelo endpoint interno:

```
escreve remote no rclone.conf:
  [omnicloud-<userId>]
  type = webdav
  url = http://api:8787/webdav
  vendor = other
  user = <username>
  pass = <webdavToken obfuscado via `rclone obscure`>

smbpasswd -a <username>
mkdir -p /mnt/omnicloud/<userId>
rclone mount omnicloud-<userId>: /mnt/omnicloud/<userId> \
  --vfs-cache-mode full --vfs-cache-max-size 20G --daemon
escreve bloco [omnicloud-<username>] no smb.conf
smbcontrol all reload-config
```

O `rclone.conf` é gerado inteiramente pelo provisioner a partir do endpoint interno.
Nenhuma credencial de provider é duplicada nele — o rclone só conhece o OmniCloud.

Usuário removido: unmount, `smbpasswd -x`, remoção do bloco.

Poll em vez de webhook porque sobrevive a restart do container sem estado extra para
reconciliar.

Bloco de share gerado:

```ini
[omnicloud-<username>]
  path = /mnt/omnicloud/<userId>
  valid users = <username>
  writable = yes
  vfs objects = catia fruit streams_xattr
  fruit:metadata = stream
  fruit:posix_rename = yes
```

`vfs_fruit` é o que faz macOS e iOS se comportarem: sem arquivos `._`, rename correto.

Configuração global: `server min protocol = SMB2_10`, sem acesso guest. Windows 11
recusa SMB1 e autenticação guest de qualquer forma.

### 6. Frontend

`frontend/src/views/SettingsView.vue` ganha uma seção "Acesso SMB": definir a senha SMB,
ver o caminho de montagem do share e instruções por sistema operacional.

## Tratamento de erros

| Situação | Resposta WebDAV | Efeito no cliente |
| --- | --- | --- |
| Provider indisponível | `503` | rclone retenta com backoff |
| Arquivo ausente no mirror | `404` | arquivo some do Finder |
| Usuário sem contas ativas | `PROPFIND` vazio | share monta vazio, não falha |
| Sem espaço na allocation | `507` | erro de escrita no cliente |
| Falha de upload por outro motivo | `502` | erro de escrita no cliente |

## Testes

`node --test`, sem framework — padrão já usado em `backend/test/uploadChunks.test.js`.

- `backend/test/webdav.test.js`
  - `PROPFIND` gera multistatus correto a partir de uma lista de arquivos
  - `Depth: 0` devolve só o próprio recurso; `Depth: 1` inclui os filhos
  - parse de `Range` calcula `start`/`end` corretamente, incluindo sufixo (`-500`)
  - `MOVE` mapeia para `renameFile` com o destino certo
- `backend/test/rangeStream.test.js`
  - fallback da `BaseCloudAdapter` quando o adapter não suporta `Range`

Verificação manual após implementação: montar o share de macOS, Windows, iOS Files e
Linux; ler, escrever, renomear e apagar em cada um.

## Limitações conhecidas

- `PUT` sobre arquivo existente é delete + upload. Perde o histórico de versões do
  provider.
- Um processo `rclone` e um VFS cache por usuário. Esse é o teto de escala do desenho;
  adequado para self-hosted, não para dezenas de usuários simultâneos.
- `MOVE` entre providers diferentes não é suportado — só dentro do mesmo provider.

## Riscos

**Porta 445 no ZimaOS.** O ZimaOS já roda um Samba próprio na 445, e dois servidores SMB
não dividem a porta. Saídas: desligar o compartilhamento nativo do ZimaOS, ou dar ao
container uma rede `macvlan` com IP próprio na LAN. A segunda é a recomendada. Porta
alternativa não serve — iOS e Windows não deixam escolher porta no montador.

**FUSE em container.** O container SMB precisa de `cap_add: SYS_ADMIN`, `devices:
/dev/fuse` e `security_opt: apparmor:unconfined`. É uma elevação de privilégio real em
relação aos containers atuais do compose.

## Decisões em aberto

Nenhuma bloqueante. Registrado como possível upgrade futuro: calcular o hash NTLM no
backend para que a senha SMB nunca trafegue em claro, mesmo na rede interna. Requer
implementar MD4 na mão, já que o OpenSSL 3 o removeu do provider default do Node.
