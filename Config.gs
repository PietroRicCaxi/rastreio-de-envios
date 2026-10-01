/**
 * ============================================================
 *  RASTREIO DE ENVIOS — Click Presilhas
 *  Loja Integrada  →  Correios (SEDEX/PAC)  +  Melhor Envio (Jadlog)
 * ============================================================
 *
 *  Config.gs — tudo que você pode ajustar sem mexer no resto do código.
 *
 *  CREDENCIAIS NÃO FICAM AQUI. Elas ficam em:
 *  Apps Script > Configurações do projeto (engrenagem) > Propriedades do script
 *
 *    LI_CHAVE_API              (obrigatória)  chave_api da Loja Integrada
 *    LI_CHAVE_APLICACAO        (obrigatória)  chave de aplicação enviada pelo suporte da LI
 *    ME_TOKEN                  (obrigatória)  token gerado no painel do Melhor Envio
 *    ME_EMAIL_CONTATO          (obrigatória)  e-mail técnico (o Melhor Envio exige no User-Agent)
 *    EMAILS_ALERTA             (obrigatória)  e-mails que recebem alertas, separados por vírgula
 *    CORREIOS_USUARIO          (opcional)     usuário do Meu Correios / ID Correios (só com contrato)
 *    CORREIOS_CODIGO_ACESSO    (opcional)     código de acesso gerado em cws.correios.com.br
 *    CORREIOS_CARTAO_POSTAGEM  (opcional)     número do cartão de postagem do contrato
 */

const CONFIG = {
  FUSO: 'America/Sao_Paulo',

  // ---------- FILTRO ANTI-HISTÓRICO (pedidos "Enviado" desde 2022) ----------
  // Na 1ª execução, só entram pedidos que foram ATUALIZADOS nos últimos X dias.
  // Depois disso, o sistema só pega pedidos alterados desde a última execução.
  DIAS_RETROATIVOS_INICIAL: 30,

  // Envio com mais de X dias sem conclusão para de ser consultado
  // (vira "SEM_CONCLUSAO" e gera um alerta para verificação manual).
  JANELA_MAX_DIAS: 60,

  // ---------- REGRAS DE ALERTA ----------
  // Sem nenhum evento novo há X dias (e não entregue) → alerta "PARADO" (possível extravio)
  // (só vale para os Correios: o Melhor Envio não informa eventos no meio do caminho,
  //  então para Jadlog o sistema usa apenas a regra de ATRASADO)
  DIAS_SEM_MOVIMENTO_ALERTA: 5,

  // Código vinculado na LI há X dias, mas a transportadora ainda não registrou a postagem
  // → alerta "NÃO POSTADO" (pedido marcado como Enviado, mas o pacote não saiu)
  DIAS_SEM_POSTAGEM_ALERTA: 3,

  // Prazo máximo (dias corridos após a postagem) usado quando a transportadora
  // não informa data prevista. Passou disso sem entrega → alerta "ATRASADO".
  PRAZO_PADRAO_DIAS: { SEDEX: 6, PAC: 14, JADLOG: 12, OUTRO: 14 },
  // Quando o pedido da LI traz o prazo cotado (dias úteis), ele tem prioridade sobre o padrão:
  // previsão = postagem + prazo convertido em dias corridos + esta margem de tolerância.
  MARGEM_PRAZO_DIAS: 2,

  // ---------- ROTEAMENTO ----------
  // Por onde rastrear códigos no formato dos Correios (ex.: AB123456789BR):
  //   'AUTO'         → API dos Correios se as credenciais existirem; senão, Melhor Envio
  //   'CORREIOS_API' → sempre API dos Correios (exige contrato)
  //   'MELHOR_ENVIO' → sempre Melhor Envio (quando as etiquetas SEDEX/PAC são compradas lá)
  // Click Presilhas tem CONTRATO PRÓPRIO com os Correios → SEDEX/PAC vão direto pela API deles.
  ROTA_CODIGO_CORREIOS: 'CORREIOS_API',

  // Palavras usadas para reconhecer a forma de envio no pedido da LI (nome ou código)
  FORMAS_CORREIOS: ['sedex', 'pac', 'correios'],
  FORMAS_MELHOR_ENVIO: ['jadlog', 'melhor envio', 'melhorenvio', '.package', '.com'],

  // ---------- LOJA INTEGRADA ----------
  LI_SITUACAO_ENVIADO: 'pedido_enviado',   // código da situação "Enviado"
  LI_SITUACAO_ENTREGUE: 'pedido_entregue', // código da situação "Entregue"
  // Quando a transportadora confirmar a entrega, mudar o pedido na LI para "Entregue"?
  // ATENÇÃO: isso pode disparar e-mail automático da LI para o cliente. Deixe false
  // até testar. Ligar isso também "limpa" a LI: pedidos entregues deixam de ficar como Enviado.
  ATUALIZAR_LI_QUANDO_ENTREGUE: false,

  // ---------- EXECUÇÃO ----------
  LIMITE_TEMPO_MS: 5 * 60 * 1000,   // Apps Script corta em 6 min; paramos em 5 com folga
  ME_MAX_PAGINAS_BUSCA: 60,
  ME_MAX_BUSCAS_NOME: 40,           // buscas por nome do cliente no ME por execução (quando o código não é achado)         // páginas da lista de etiquetas do ME varridas por execução para achar códigos novos
  PAUSA_ENTRE_CHAMADAS_MS: 200,

  ABAS: {
    ENVIOS: 'Envios',
    HISTORICO: 'Histórico',
    ALERTAS: 'Alertas',
    LOG: 'Log'
  }
};

/** Colunas da aba Envios (a ordem aqui define a ordem na planilha). */
const COLUNAS_ENVIOS = [
  'Chave', 'Pedido LI', 'Data pedido', 'Cliente', 'Cidade/UF', 'Forma de envio',
  'Rota', 'Código rastreio', 'Data vínculo', 'ID Melhor Envio', 'Status', 'Alerta', 'Último evento',
  'Data último evento', 'Local', 'Data postagem', 'Previsão entrega', 'Dias em trânsito',
  'Finalizado', 'Última verificação', 'Link rastreio', 'Observação', 'Status código', 'Prazo LI (dias úteis)',
  'Encontrado via', 'Enviado por', 'Código transportadora', 'Nota busca'
];

/** Lê uma propriedade do script. */
function prop_(nome, obrigatoria) {
  const v = PropertiesService.getScriptProperties().getProperty(nome);
  if (obrigatoria && !v) {
    throw new Error('Propriedade do script "' + nome + '" não configurada. ' +
      'Vá em Configurações do projeto > Propriedades do script.');
  }
  return (v || '').trim();
}

function setProp_(nome, valor) {
  PropertiesService.getScriptProperties().setProperty(nome, String(valor));
}

function agoraStr_(formato) {
  return Utilities.formatDate(new Date(), CONFIG.FUSO, formato || 'yyyy-MM-dd HH:mm:ss');
}

function fmtData_(d, formato) {
  if (!d) return '';
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt.getTime())) return '';
  return Utilities.formatDate(dt, CONFIG.FUSO, formato || 'dd/MM/yyyy HH:mm');
}
