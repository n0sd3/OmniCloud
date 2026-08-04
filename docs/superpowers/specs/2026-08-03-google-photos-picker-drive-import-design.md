# Importação do Google Fotos para Google Drive

Data: 2026-08-03
Status: aprovado (design)

## Contexto

O OmniCloud já conecta contas do Google Drive por OAuth, armazena as credenciais
criptografadas e envia arquivos por streaming através do `GoogleDriveAdapter`.
Não existe integração com Google Fotos.

O escopo legado `photoslibrary` deixou de dar acesso amplo à biblioteca em 31 de
março de 2025. Para itens existentes, a integração deve usar a Google Photos
Picker API com o escopo:

```text
https://www.googleapis.com/auth/photospicker.mediaitems.readonly
```

O usuário quer selecionar imagens e vídeos no Picker oficial e copiá-los para o
Google Drive da mesma conta.

Referências oficiais:

- https://developers.google.com/photos/support/updates
- https://developers.google.com/photos/picker/guides/get-started-picker
- https://developers.google.com/photos/picker/guides/media-items

## Escopo

Dentro:

- Autorizar o escopo do Picker junto da conexão Google Drive existente.
- Abrir o seletor oficial do Google Fotos para uma conta Google Drive conectada.
- Importar todas as imagens e vídeos selecionados, incluindo resultados paginados.
- Copiar por streaming a melhor representação disponibilizada pelo Picker para o
  Drive da mesma conta.
- Criar e reutilizar a pasta fixa
  `/OmniCloud/Google Fotos/<parte-do-email-antes-de-@>/`.
- Preservar duplicatas com nomes numerados, como `foto (2).jpg`.
- Exibir progresso e um resumo de sucessos e falhas.

Fora:

- Expor Google Fotos como provider navegável ou armazenamento permanente.
- Ler a biblioteca completa sem seleção explícita do usuário.
- Manter histórico separado das importações.
- Enviar itens ao Google Fotos pela Library API.
- Adicionar dependências.

## Abordagens consideradas

### 1. OAuth unificado com Google Drive (escolhida)

Adicionar o escopo do Picker à autorização já usada pela conta Google Drive. O
mesmo token identifica a conta de origem e a de destino, eliminando associação
por e-mail e uma segunda conexão. Contas existentes precisam ser reconectadas
uma vez para conceder o novo escopo.

### 2. OAuth separado para Google Fotos

Manter uma conexão de Fotos e outra de Drive exigiria comparar identidades,
armazenar outro token e tratar combinações incorretas de contas. Não oferece
benefício para o fluxo aprovado.

### 3. Download pelo navegador e reenvio

Faria os arquivos passarem pelo dispositivo do usuário antes do upload. Duplica
transferência, piora o suporte a vídeos grandes e impede uma operação confiável
em segundo plano.

## Arquitetura

### OAuth

`googleOAuthService` inclui
`https://www.googleapis.com/auth/photospicker.mediaitems.readonly` na solicitação
de autorização do Google Drive. O refresh token e os demais dados continuam no
registro criptografado da conta existente.

Se o token de uma conta antiga não contiver o novo escopo, a interface solicita
reconexão em vez de iniciar o Picker.

### Serviço de importação

Um serviço dedicado coordena apenas o fluxo do Picker e entrega os streams ao
adapter existente. Suas responsabilidades são:

1. Validar que a conta pertence ao usuário e é `google_drive`.
2. Criar uma sessão em `https://photospicker.googleapis.com/v1/sessions`.
3. Expor o `pickerUri` ao frontend.
4. Consultar a sessão usando sempre os valores mais recentes de `pollInterval` e
   `timeoutIn` retornados pelo Google.
5. Paginar todos os itens selecionados.
6. Baixar cada item com Bearer token e `=d` para imagem ou `=dv` para vídeo,
   obtendo a melhor representação disponibilizada pelo Picker.
7. Enviar o stream ao `GoogleDriveAdapter` da mesma conta.
8. Sincronizar os metadados do Drive e informar o progresso.
9. Excluir a sessão do Picker ao terminar ou falhar.

O serviço inteiro mantém no máximo duas transferências simultâneas, mesmo quando
há vários jobs. Jobs da mesma conta entram de forma serializada para que a leitura
e a reserva de nomes não concorram. Isso reduz o risco de estourar a janela dos
URLs temporários sem carregar arquivos completos em memória.

O Picker não promete arquivos byte a byte idênticos aos originais. Downloads de
imagens podem omitir metadados de localização, e downloads de vídeos podem ser
transcodificados pelo Google.

### Destino e nomes

Para `usuario@gmail.com`, o caminho é:

```text
/OmniCloud/Google Fotos/usuario/
```

A subpasta usa tudo antes do primeiro `@`. Caracteres que não possam formar um
segmento seguro são normalizados. Como cada conta escreve no próprio Drive, duas
contas com a mesma parte local não se misturam.

Antes de cada upload, o serviço verifica os nomes existentes na pasta. Em caso de
colisão, preserva a extensão e usa o primeiro número livre:

```text
foto.jpg
foto (2).jpg
foto (3).jpg
```

Selecionar novamente o mesmo item cria uma nova cópia; não há deduplicação por ID
do Google Fotos.

### Estado e eventos

O estado da importação fica em memória, como as sessões OAuth e de upload atuais.
Ele contém somente identificadores, contadores, status e erros resumidos; URLs do
Picker não são persistidas nem registradas em logs.

A infraestrutura de eventos existente publica início, progresso por bytes,
conclusão de item e resumo final. Reiniciar a API interrompe uma importação ativa;
persistência de jobs só será adicionada se o backend passar a operar com múltiplos
workers ou se recuperação após reinício virar requisito.

## Interface e fluxo

Cada cartão de uma conta Google Drive conectada oferece a ação **Importar do
Google Fotos**.

1. O usuário aciona a importação.
2. O backend cria a sessão e devolve o `pickerUri`.
3. O frontend abre o Picker oficial em uma nova aba com fechamento automático.
4. O frontend consulta o status do backend no intervalo indicado.
5. Quando o usuário conclui a seleção, a transferência começa imediatamente.
6. A interface apresenta contagem e progresso enquanto a importação continua.
7. Ao final, mostra quantos arquivos foram importados e quais falharam.

Cancelar ou fechar o Picker antes da seleção encerra o fluxo sem criar arquivos.
Como `/autoclose` também fecha a janela depois de uma seleção válida, o frontend
só solicita cancelamento após duas consultas consecutivas e atualizadas ainda
indicarem `waiting_for_selection` com a janela fechada.

## Tratamento de erros

- Falta do escopo do Picker: marcar a ação como necessitando reconexão.
- Sessão expirada ou cancelada: limpar a sessão e informar que nada foi importado.
- Falha ao listar qualquer página: encerrar antes de iniciar uploads, para não
  apresentar uma seleção incompleta como se fosse a escolha total do usuário.
- Falha em um arquivo: registrar o erro desse item e continuar os demais.
- Falta de espaço ou quota no Drive: os itens já concluídos permanecem; os demais
  são reportados como falha.
- Token inválido ou revogado: interromper novas transferências, marcar a conta com
  token inválido e solicitar reconexão.
- Falha ao excluir a sessão: registrar apenas uma mensagem sanitizada; não alterar
  o resultado dos arquivos já processados.

Os links de mídia do Picker expiram em até 60 minutos. A importação começa assim
que `mediaItemsSet` fica verdadeiro e nunca guarda esses links para uso futuro.

## Segurança

- Toda rota valida o usuário autenticado e a propriedade da conta Google Drive.
- O backend é o único componente que recebe o token e acessa os bytes.
- Tokens, URLs temporárias e cabeçalhos de autorização não entram em logs ou
  respostas de erro.
- O Picker não é embutido em iframe; usa a aba oficial exigida pelo Google.
- O escopo solicitado é o mínimo necessário para o fluxo aprovado.

## Testes

Testes automatizados cobrem:

- presença do novo escopo na autorização Google;
- rejeição de conta inexistente, alheia ou de outro provider;
- criação e limpeza de sessão;
- respeito ao polling recomendado e ao timeout;
- paginação dos itens selecionados;
- download autenticado da melhor representação de imagem e vídeo disponibilizada
  pelo Picker;
- caminho derivado da parte local do e-mail;
- criação da árvore de pastas e reutilização de pastas existentes;
- numeração de nomes repetidos preservando extensões;
- limite de duas transferências simultâneas;
- continuação após falha isolada e resumo parcial correto;
- token inválido, sessão expirada e falha de limpeza;
- ausência de tokens e URLs temporárias em respostas e logs.

Verificação manual:

1. Reconectar uma conta Google Drive existente e confirmar o novo consentimento.
2. Selecionar uma imagem e um vídeo no Picker.
3. Confirmar as melhores representações disponibilizadas pelo Picker em
   `OmniCloud/Google Fotos/<conta>/` no mesmo Drive.
4. Repetir a seleção e confirmar os sufixos `(2)`.
5. Fechar o Picker sem concluir e confirmar que nenhum arquivo foi criado.

## Critérios de aceite

- Somente a conta Google Drive que abriu o Picker recebe os arquivos.
- Imagens e vídeos chegam completos na melhor representação disponibilizada pelo
  Picker, sem promessa de identidade byte a byte com o original.
- O caminho fixo e a regra de duplicatas são aplicados exatamente como definidos.
- Uma falha isolada não desfaz nem impede importações independentes.
- A sessão é limpa e o usuário recebe um resumo verificável.
- Nenhuma dependência nova ou provider Google Fotos é introduzido.
