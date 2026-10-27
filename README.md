# EB Manager — pacote para publicar

Todos os arquivos do pacote ficam na raiz, sem subpastas.

## O que está incluído
- `server.js`: servidor web, login Roblox por código na bio, sessão/logout, CDP, promoções, permissões, ranking e históricos.
- `index.html` e `dashboard.html`: login e painel do site.
- `cargos_eb.json` e `divisoes.json`: configuração dos cargos e divisões conforme informações fornecidas.
- `CDP_Roblox_Server.lua`: Script servidor para criar o TextLabel de CDP no Roblox Studio e consultar a API do site.
- `render.yaml`: configuração-base do serviço Render.
- `INSTRUCOES_ATUALIZACAO.txt`, `ARQUIVOS_PARA_GITHUB.txt` e `VARIAVEIS_RENDER.txt`: instruções.
- Imagens do site.

## Publicar
1. Faça backup do repositório e dos dados atuais.
2. Extraia o ZIP e envie o conteúdo à raiz do GitHub.
3. Use um Render Web Service, build `npm install`, start `npm start`.
4. Configure os segredos no Environment do Render (nunca no GitHub).
5. No Roblox Studio, ative Allow HTTP Requests e coloque o conteúdo de `CDP_Roblox_Server.lua` em um `Script` em `ServerScriptService`. Atualize a URL do Render e a chave da API nesse Script.

## Atenção
- Não substitua arquivos de dados existentes que contenham registros reais.
- Para os dados sobreviverem a deploys/reinicializações, configure um disco persistente no Render (se disponível para seu plano) e `EB_DATA_DIR=/var/data`.
- Antes de promoções reais, confirme a ordem exata dos cargos. A maioria dos cargos recebidos no JSON original tem `rank: 1`.
- Sem definir `EB_PROMOTER_ROLE_IDS`, a promoção no grupo principal fica bloqueada por segurança.
- O pacote não inclui chaves secretas nem foi conectado às credenciais da sua conta Roblox.
