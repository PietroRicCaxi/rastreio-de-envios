# Rastreio de Envios

Rastreio automático dos pedidos da **Loja Integrada** enviados por **SEDEX/PAC (Correios)** e **Jadlog (Melhor Envio)**.
Avisa quando há atraso, extravio, devolução, destinatário não encontrado ou pedido não postado. Tem um **app web** para a
operadora tratar as ocorrências e mandar a mensagem de satisfação depois da entrega.

Feito em **Google Apps Script**, vinculado a uma **Planilha Google**, que guarda os dados e serve de painel.

---

## Como funciona

```
Loja Integrada ──(15 min)──► pedidos que PASSARAM a "Enviado" desde a última checagem
                                    │
                                    ▼
                    aba "Envios" (1 linha por código de rastreio)
                                    │
                      (1 h) busca em cascata, pelo formato do código
                                    │
        ┌───────────────────────────┼──────────────────────────────┐
        ▼                           ▼                              ▼
 1. API dos Correios        2. Melhor Envio pelo             3. Melhor Envio pelo
    (contrato próprio)         código / nº do pedido LI         nome do cliente
                                    │
                                    ▼
            classificador → status + alerta → e-mail · aba Alertas · app web
```

### Busca em cascata
A forma de envio que o cliente escolheu na LI nem sempre é a usada no envio. Um pedido "SEDEX" pode sair por Jadlog por
causa das medidas, e um "PAC" pode ter etiqueta gerada no Melhor Envio. Por isso a rota é decidida **pelo formato do código**:

| Código | Começa por |
|---|---|
| `AB123456789BR` (padrão Correios) | API dos Correios. Se responder *SRO-009 (não pertence ao contrato)* ou *SRO-020 (não localizado)*, passa para o Melhor Envio |
| `6xxxxxxxx` (Jadlog) ou `ME…BR` (Melhor Rastreio) | Melhor Envio direto |

No Melhor Envio, a etiqueta é achada pelo **código** (`self_tracking`, `tracking`, `authorization_code`…), pelo
**número do pedido da LI** que fica gravado na etiqueta e, por último, pelo **nome do cliente** (com janela de datas e
marcado como "conferir"). Se não for achada em nenhum lugar, o pedido fica *Aguardando postagem* e vira alerta
**Não postado** depois de 3 dias.

Os códigos digitados na LI são normalizados (espaços, pontos, traços, colchetes e falta do "BR").

### Filtro do histórico
Todos os pedidos antigos (desde 2022) também estão como "Enviado" na LI. Por isso o sistema não lista pedidos por situação:
ele pede à LI só os que foram **atualizados depois da última execução** (na instalação, os últimos 30 dias). Envio
finalizado para de ser consultado. Envio com mais de 60 dias sem conclusão sai do monitoramento com alerta.

### Status

| Status | Alerta | Quando |
|---|---|---|
| Aguardando postagem | — | código vinculado, transportadora ainda não recebeu |
| **Não postado (atenção)** | ⚠️ | 3 dias sem postagem, ou código não encontrado em lugar nenhum |
| Postado · Em trânsito · Saiu para entrega | — | fluxo normal |
| **Aguardando retirada** | ⚠️ | cliente precisa buscar na agência |
| **Não entregue / destinatário não encontrado** | ⚠️ | ausente, endereço incorreto, recusado… (Correios) |
| **Problema na entrega (ver motivo)** | ⚠️ | "não entregue" genérico do Melhor Envio. O motivo fica no link do Melhor Rastreio |
| **Desvio** | ⚠️ | objeto mal encaminhado |
| **Atrasado** | ⚠️ | passou da previsão dos Correios ou do prazo cotado na LI (dias úteis + 2 de tolerância) |
| **Parado (possível extravio)** | ⚠️ | 5 dias sem evento novo (só Correios) |
| **Em devolução** · **Devolvido** | ⚠️ | voltando / chegou de volta |
| **Extraviado / roubado** | ⚠️ | inclui "não localizado no fluxo postal" e "sinistro" |
| **Etiqueta cancelada** | ⚠️ | etiqueta do Melhor Envio cancelada ou expirada |
| Entregue | ✅ | finaliza e entra na lista de satisfação. Guarda **quem recebeu**, quando a transportadora informa |
| **Chargeback (compra contestada)** | ⚠️ | o pedido entrou em chargeback / pagamento em disputa na LI (veja abaixo) |

Os limites (dias, prazos, janelas) ficam em `Config.gs`.

### Chargeback e quem recebeu
A cada 15 min o sistema também procura na LI os pedidos que entraram em **chargeback / pagamento em disputa**
(situações reconhecidas pelo código ou nome, ou fixadas em `CONFIG.LI_SITUACOES_CHARGEBACK`). Para cada um:
- marca a coluna **Chargeback** na aba Envios, gera alerta e e-mail, e o caso vai para o topo da fila de Ocorrências;
- se o pedido não estava na planilha (ex.: antigo), entra com os códigos dele e é rastreado ao menos uma vez;
- se já foi entregue, mostra a **prova de entrega**: data e **quem recebeu** (coluna *Recebido por*);
- não entra na lista de satisfação. O alerta só sai quando a tratativa do chargeback for resolvida ou encerrada no app.

O nome de quem recebeu vem do evento de entrega dos Correios ou do detalhe da etiqueta do Melhor Envio, quando
a transportadora informa. O documento do recebedor nunca é guardado.

---

## App web da operadora

| Aba | O que faz |
|---|---|
| **Ocorrências** | fila só com o que precisa de atenção, com os mais graves e mais antigos primeiro. Filtros por tipo, transportadora e situação da tratativa. Busca por pedido, código ou cliente |
| **Resolvidos e alterações** | casos resolvidos/encerrados e o histórico de tudo que foi feito no app (quem, quando, o quê) |
| **Pedidos** | todos os pedidos acompanhados, inclusive entregues, com filtro por situação e funil por status |
| **Satisfação** | entregues nos últimos 10 dias sem mensagem de satisfação. Visões *Pendentes / Enviadas / Não enviadas*, com filtro por data de envio |
| **Painel** | indicadores do período escolhido (em dias úteis), % no prazo por SEDEX/PAC/Jadlog e lista de envios |

**Detalhe do pedido:** prazo LI × dias úteis em trânsito, linha do tempo consultada na hora, dados do cliente (vindos da LI)
e tratativa:
- **Situações:** Nova · Em contato com cliente · Aguardando transportadora · Reenvio solicitado · Reembolso solicitado · Resolvida · Encerrada sem ação.
- **Gestão informada:** marca o caso e manda e-mail para a gestão.
- **Mensagens prontas por tipo de ocorrência e de satisfação** (com link de avaliação no Google).
  - **E-mail:** sai direto, com um clique.
  - **WhatsApp:** abre no WhatsApp Web ou no aplicativo, com o texto pronto. Só é registrado depois que a operadora confirma o envio.

Um caso resolvido volta para a fila sozinho se aparecer um problema novo no pedido. Listas podem ser ordenadas pela coluna
**Pedido** (mais antigo ↔ mais novo).

---

## Estrutura

| Arquivo | Responsabilidade |
|---|---|
| `Config.gs` | parâmetros (prazos, janelas, limites) e colunas da aba Envios |
| `Http.gs` | chamadas HTTP com novas tentativas em erros 429/5xx (`httpJson_`, `montarQuery_`) |
| `LojaIntegrada.gs` | pedidos "Enviado" e em chargeback, códigos de rastreio, datas e contato do cliente |
| `Correios.gs` | API Rastro (CWS) com chave de acesso `cws-…` |
| `MelhorEnvio.gs` | busca de etiquetas (código, nº do pedido, nome) e status em lote |
| `Classificador.gs` | regras de status, prazos, rotas, normalização de códigos, quem recebeu e situações de chargeback (funções puras) |
| `Rastreio.gs` | rodada de atualização: cascata, histórico, alertas |
| `Planilha.gs` | leitura/gravação das abas, sincronização de alertas |
| `Resumo.gs` | aba Resumo (últimos 14 dias úteis) |
| `Main.gs` | menu, instalação, agendamentos, busca na LI, verificação de chargeback, e-mails |
| `Diagnostico.gs` | testes de credenciais e de campos de cada API |
| `WebApp.gs` · `App.html` | app web (servidor e tela) |
| `appsscript.json` | manifesto e permissões |

**Abas da planilha:** Resumo · Envios · Histórico · Alertas · Tratativas · Tratativas - Histórico · Log (e Diagnóstico, quando usado).

---

## Instalação

### 1. Credenciais
- **Loja Integrada:** `chave_api` + chave de aplicação (pedida ao suporte da LI).
- **Correios (contrato):** em [cws.correios.com.br](https://cws.correios.com.br) → *Chaves de acesso → Nova chave*, com o
  contrato e o cartão de postagem, **só "SRO - Rastro"** ligado e expiração de 180 dias. A chave `cws-…` já é o token.
- **Melhor Envio:** painel → *Integrações → Permissões de acesso → Gerar novo token* (`orders-read`, `shipping-tracking`).

### 2. Projeto
1. Crie uma Planilha Google → *Extensões → Apps Script*.
2. Crie um arquivo para cada `.gs` (mesmo nome, sem extensão) e um HTML `App`. Cole o conteúdo de cada um.
3. Em *Configurações do projeto*, mostre o `appsscript.json` e substitua pelo deste repositório.

### 3. Propriedades do script
*Configurações do projeto → Propriedades do script*:

| Propriedade | Valor |
|---|---|
| `LI_CHAVE_API` | chave_api da LI |
| `LI_CHAVE_APLICACAO` | chave de aplicação da LI |
| `ME_TOKEN` | token do Melhor Envio |
| `ME_EMAIL_CONTATO` | e-mail técnico (exigido pelo Melhor Envio) |
| `EMAILS_ALERTA` | quem recebe alertas, separados por vírgula |
| `CORREIOS_CODIGO_ACESSO` | chave `cws-…` do CWS |
| `EMAILS_GESTAO` | *(opcional)* quem recebe "Gestão informada" |
| `USUARIOS_APP` | *(opcional)* e-mails que podem usar o app |

> Nunca coloque credenciais no código. Elas ficam só nas Propriedades do script.

### 4. Diagnóstico e ligação
1. Recarregue a planilha. No menu **📦 Rastreio**, rode os diagnósticos da Loja Integrada, dos Correios e do Melhor Envio.
2. No editor, execute **`instalar`**. Ele cria as abas e agenda as rotinas: LI a cada 15 min, rastreio a cada 1 h, resumo às 8h.
3. Rode **📦 Rastreio → Atualizar rastreios agora**.

### 5. App web
*Implantar → Nova implantação → App da Web*:
- *Executar como:* **Eu** (os e-mails aos clientes saem desta conta)
- *Quem pode acessar:* **sua organização**

A cada mudança no código: *Gerenciar implantações → editar → Nova versão*. O link continua o mesmo.

---

## Manutenção
- **Chave dos Correios vence** (máx. 180 dias). Quando for recusada, o sistema avisa por e-mail. Gere outra no CWS e troque `CORREIOS_CODIGO_ACESSO`.
- **Token do Melhor Envio** tem validade. Se as consultas começarem a falhar com 401, gere um novo token.
- **Parar tudo:** execute `desligar` (remove os agendamentos).
- **Limites:** Melhor Envio aceita 250 req/min; Apps Script corta cada execução em 6 min (o código para em 5 e continua na rodada seguinte).

## Limitações conhecidas
- **Atualização:** status a cada hora e pedidos novos a cada 15 min. O webhook do Melhor Envio só atende etiquetas geradas pelo próprio app que o cadastra.
- **Melhor Envio sem motivo detalhado:** a API não informa o motivo de "não entregue" (extravio, recusa…). Ele aparece no Melhor Rastreio, pelo link do pedido.
- **WhatsApp:** abre a conversa pronta, mas o envio é manual. O envio 100% automático depende da API oficial do WhatsApp Business (fase 2).

## Próximos passos (fase 2)
- WhatsApp automático pela API oficial, com modelos aprovados pela Meta.
- Pedido de informação aos Correios pela API SRO-Interatividade.
- Marcar o pedido como *Entregue* na Loja Integrada (`ATUALIZAR_LI_QUANDO_ENTREGUE` em `Config.gs`, hoje desligado).
