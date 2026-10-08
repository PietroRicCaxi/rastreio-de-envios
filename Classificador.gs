/**
 * Classificador.gs — transforma eventos das transportadoras em um STATUS único
 * e decide quando gerar alerta. Funções puras (sem planilha, sem API).
 *
 * Para ajustar o que conta como "desvio", "devolução" etc., edite as listas
 * de palavras em REGRAS_TEXTO — a comparação ignora acentos e maiúsculas.
 */

const STATUS = {
  AGUARDANDO_POSTAGEM: { rotulo: 'Aguardando postagem',        alerta: false, final: false },
  NAO_POSTADO:         { rotulo: 'Não postado (atenção)',      alerta: true,  final: false },
  POSTADO:             { rotulo: 'Postado',                    alerta: false, final: false },
  EM_TRANSITO:         { rotulo: 'Em trânsito',                alerta: false, final: false },
  SAIU_PARA_ENTREGA:   { rotulo: 'Saiu para entrega',          alerta: false, final: false },
  AGUARDANDO_RETIRADA: { rotulo: 'Aguardando retirada',        alerta: true,  final: false },
  TENTATIVA_FALHOU:    { rotulo: 'Não entregue / destinatário não encontrado', alerta: true, final: false },
  PROBLEMA_ENTREGA:    { rotulo: 'Problema na entrega (ver motivo)', alerta: true, final: false },
  DESVIO:              { rotulo: 'Desvio / mal encaminhado',   alerta: true,  final: false },
  ATRASADO:            { rotulo: 'Atrasado',                   alerta: true,  final: false },
  PARADO:              { rotulo: 'Parado (possível extravio)', alerta: true,  final: false },
  EM_DEVOLUCAO:        { rotulo: 'Em devolução',               alerta: true,  final: false },
  DEVOLVIDO:           { rotulo: 'Devolvido (chegou para nós)', alerta: true, final: true },
  EXTRAVIADO:          { rotulo: 'Extraviado / roubado',       alerta: true,  final: true },
  CANCELADO:           { rotulo: 'Etiqueta cancelada',         alerta: true,  final: true },
  ENTREGUE:            { rotulo: 'Entregue',                   alerta: false, final: true },
  SEM_CONCLUSAO:       { rotulo: 'Sem conclusão (verificar)',  alerta: true,  final: true },
  CHARGEBACK:          { rotulo: 'Chargeback (compra contestada)', alerta: true, final: false },
  SEM_RASTREIO:        { rotulo: 'Sem código de rastreio',     alerta: false, final: true },
  NAO_LOCALIZADO_ME:   { rotulo: 'Etiqueta não localizada no ME', alerta: false, final: false },
  ERRO_CONSULTA:       { rotulo: 'Erro na consulta',           alerta: false, final: false },
  NOVO:                { rotulo: 'Novo (ainda não consultado)', alerta: false, final: false }
};

// A ORDEM IMPORTA: a primeira regra que bater decide.
const REGRAS_TEXTO = [
  ['DEVOLVIDO',           ['entregue ao remetente', 'devolvido ao remetente e entregue']],
  ['EXTRAVIADO',          ['extraviado', 'extravio', 'roubado', 'roubo', 'furtado', 'sinistro', 'objeto nao localizado no fluxo', 'nao localizado no fluxo postal']],
  ['EM_DEVOLUCAO',        ['em devolucao', 'devolvido ao remetente', 'sera devolvido', 'devolucao ao remetente', 'retorno ao remetente', 'devolucao']],
  ['ENTREGUE',            ['entregue ao destinatario', 'objeto entregue', 'entregue']],
  ['DESVIO',              ['mal encaminhado', 'encaminhado incorretamente', 'desviado', 'desvio', 'erro de encaminhamento']],
  ['TENTATIVA_FALHOU',    ['nao entregue', 'ausente', 'nao atendido', 'endereco incorreto', 'endereco insuficiente',
                           'mudou-se', 'mudou se', 'desconhecido', 'recusado', 'nao procurado', 'nao localizado',
                           'nao encontrado', 'area com restricao', 'area de risco', 'numero inexistente',
                           'entrega interrompida', 'acao do destinatario', 'suspens']],
  ['AGUARDANDO_RETIRADA', ['aguardando retirada', 'disponivel para retirada', 'retirar na unidade', 'retirada no endereco']],
  ['SAIU_PARA_ENTREGA',   ['saiu para entrega', 'em rota de entrega', 'saiu para o endereco']],
  ['POSTADO',             ['postado', 'objeto recebido', 'coletado']],
  ['AGUARDANDO_POSTAGEM', ['etiqueta criada', 'etiqueta paga', 'etiqueta gerada', 'pre-postado', 'aguardando postagem']],
  ['CANCELADO',           ['etiqueta cancelada', 'etiqueta expirada']]
];

function normalizarTexto_(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Classifica UM evento pelo texto (e pelo código SRO de entrega, quando houver). */
function classificarEvento_(ev) {
  const t = normalizarTexto_(ev.descricao);
  // "entregue" só vale se não for "não entregue" / "entregue ao remetente"
  for (let i = 0; i < REGRAS_TEXTO.length; i++) {
    const status = REGRAS_TEXTO[i][0];
    const palavras = REGRAS_TEXTO[i][1];
    for (let j = 0; j < palavras.length; j++) {
      if (t.indexOf(palavras[j]) >= 0) {
        if (status === 'ENTREGUE' && (t.indexOf('nao entregue') >= 0 || t.indexOf('remetente') >= 0)) continue;
        return status;
      }
    }
  }
  // Código SRO de baixa (BDE/BDI/BDR) com tipo 01 = entregue ao destinatário
  if (['BDE', 'BDI', 'BDR'].indexOf(String(ev.codigo).toUpperCase()) >= 0 && String(ev.tipo) === '01') return 'ENTREGUE';
  return 'EM_TRANSITO';
}

/**
 * Status a partir da lista de eventos (mais recente primeiro).
 * Regra extra: se em algum momento entrou em devolução, continua "EM_DEVOLUCAO"
 * até chegar de volta (DEVOLVIDO), mesmo que os eventos seguintes digam "em trânsito".
 */
function statusPorEventos_(eventos) {
  if (!eventos || !eventos.length) return 'AGUARDANDO_POSTAGEM';
  const atual = classificarEvento_(eventos[0]);
  if (STATUS[atual].final) return atual;
  const emDevolucao = eventos.some(function (e) { return classificarEvento_(e) === 'EM_DEVOLUCAO'; });
  if (emDevolucao && ['EM_TRANSITO', 'POSTADO', 'SAIU_PARA_ENTREGA', 'AGUARDANDO_RETIRADA'].indexOf(atual) >= 0) {
    return 'EM_DEVOLUCAO';
  }
  return atual;
}

/** Status do Melhor Envio → status interno. */
function statusPorMelhorEnvio_(statusMe, eventos) {
  const s = normalizarTexto_(statusMe).replace(/_/g, ' ');
  const mapa = {
    'pending': 'AGUARDANDO_POSTAGEM', 'released': 'AGUARDANDO_POSTAGEM', 'generated': 'AGUARDANDO_POSTAGEM',
    'received': 'POSTADO', 'posted': 'EM_TRANSITO', 'delivered': 'ENTREGUE',
    // O Melhor Envio junta vários motivos (extravio, recusa, ausência, endereço) em "undelivered";
    // por isso vira "Problema na entrega" e o motivo vem do detalhe da etiqueta, quando houver.
    'undelivered': 'PROBLEMA_ENTREGA', 'not delivered': 'PROBLEMA_ENTREGA',
    'paused': 'PROBLEMA_ENTREGA', 'suspended': 'PROBLEMA_ENTREGA',
    'canceled': 'CANCELADO', 'cancelled': 'CANCELADO', 'expired': 'CANCELADO'
  };
  if (mapa[s]) return mapa[s];
  return statusPorEventos_(eventos);
}

/**
 * Procura, em todos os textos de um objeto (o detalhe completo da etiqueta do ME), um motivo
 * mais específico: extravio, devolução, roubo. Devolve o status interno ou null.
 */
function motivoNoDetalhe_(obj) {
  const textos = [];
  const andar = function (v, prof) {
    if (prof > 6 || v === null || v === undefined) return;
    if (typeof v === 'string') { if (v.length > 3 && v.length < 400) textos.push(v); return; }
    if (Array.isArray(v)) { v.forEach(function (x) { andar(x, prof + 1); }); return; }
    if (typeof v === 'object') Object.keys(v).forEach(function (k) { andar(v[k], prof + 1); });
  };
  andar(obj, 0);
  const prioridade = ['DEVOLVIDO', 'EXTRAVIADO', 'EM_DEVOLUCAO'];
  for (let p = 0; p < prioridade.length; p++) {
    for (let i = 0; i < textos.length; i++) {
      if (classificarEvento_({ descricao: textos[i] }) === prioridade[p]) return { status: prioridade[p], texto: textos[i] };
    }
  }
  return null;
}

/** Descrição amigável para status do ME que não vêm com evento próprio. */
function descricaoStatusMe_(statusMe) {
  const d = {
    undelivered: 'Melhor Envio: encomenda não pôde ser entregue — o motivo (extravio, recusa, endereço) está no Melhor Rastreio',
    paused: 'Melhor Envio: entrega interrompida — ação do destinatário necessária',
    suspended: 'Melhor Envio: encomenda suspensa',
    canceled: 'Melhor Envio: etiqueta cancelada', cancelled: 'Melhor Envio: etiqueta cancelada',
    expired: 'Melhor Envio: etiqueta expirada (não foi postada no prazo)'
  };
  return d[String(statusMe).toLowerCase()] || '';
}

function tipoPrazo_(formaNome) {
  const f = normalizarTexto_(formaNome);
  if (f.indexOf('sedex') >= 0) return 'SEDEX';
  if (f.indexOf('pac') >= 0) return 'PAC';
  if (f.indexOf('jadlog') >= 0) return 'JADLOG';
  return 'OUTRO';
}

function diasEntre_(a, b) {
  return (new Date(b).getTime() - new Date(a).getTime()) / 86400000;
}

/**
 * Regras que dependem do tempo (só se o status atual ainda é "normal"):
 *  - código vinculado há muito tempo e nunca postado → NAO_POSTADO
 *  - sem evento novo há X dias → PARADO
 *  - passou da previsão de entrega → ATRASADO
 * Retorna { status, previsao }.
 */
function aplicarRegrasDePrazo_(status, ctx, agora) {
  const cfg = ctx.config || CONFIG;
  let previsao = ctx.previsao ? new Date(ctx.previsao) : null;
  if (!previsao && ctx.dataPostagem) {
    const dias = ctx.prazoDias
      ? Math.ceil(ctx.prazoDias * 7 / 5) + (cfg.MARGEM_PRAZO_DIAS || 0)   // dias úteis → corridos + margem
      : (cfg.PRAZO_PADRAO_DIAS[tipoPrazo_(ctx.formaNome)] || cfg.PRAZO_PADRAO_DIAS.OUTRO);
    previsao = new Date(new Date(ctx.dataPostagem).getTime() + dias * 86400000);
  }
  const normais = ['POSTADO', 'EM_TRANSITO', 'SAIU_PARA_ENTREGA'];

  if (status === 'AGUARDANDO_POSTAGEM' && ctx.dataVinculo &&
      diasEntre_(ctx.dataVinculo, agora) > cfg.DIAS_SEM_POSTAGEM_ALERTA) {
    return { status: 'NAO_POSTADO', previsao: previsao };
  }
  if (normais.indexOf(status) >= 0) {
    if (!ctx.semEventosIntermediarios && ctx.dataUltimoEvento &&
        diasEntre_(ctx.dataUltimoEvento, agora) > cfg.DIAS_SEM_MOVIMENTO_ALERTA) {
      return { status: 'PARADO', previsao: previsao };
    }
    if (previsao) {
      const fimDoDia = new Date(previsao.getTime());
      fimDoDia.setHours(23, 59, 59, 999);
      if (new Date(agora) > fimDoDia) return { status: 'ATRASADO', previsao: previsao };
    }
  }
  return { status: status, previsao: previsao };
}

/**
 * Limpa o código digitado na LI: tira espaços, pontos e traços, e completa o "BR"
 * quando o código dos Correios foi salvo sem ele (ex.: "AB 123 456 789" → "AB123456789BR").
 */
function normalizarCodigo_(codigo) {
  let c = String(codigo === null || codigo === undefined ? '' : codigo).toUpperCase().replace(/[^A-Z0-9]/g, '');  // tira espaço, ponto, traço, colchete…
  if (/^[A-Z]{2}\d{9}$/.test(c)) c += 'BR';
  return c;
}

/** Código no padrão dos Correios? (2 letras + 9 dígitos + 2 letras, ex.: AB123456789BR) */
function ehCodigoCorreios_(codigo) {
  return /^[A-Z]{2}\d{9}[A-Z]{2}$/.test(String(codigo || '').toUpperCase());
}

/** Código de Jadlog (só números, ex.: 600000000) ou do Melhor Envio (ex.: ME123ABC45BR)? */
function ehCodigoMelhorEnvio_(codigo) {
  const c = String(codigo || '').toUpperCase();
  return /^\d{8,15}$/.test(c) || /^ME[0-9A-Z]{6,}BR$/.test(c);
}

/**
 * Decide por onde COMEÇAR a rastrear: 'CORREIOS_API' ou 'MELHOR_ENVIO'.
 * O formato do código manda (a forma escolhida pelo cliente pode não ser a usada no envio):
 *  - Jadlog / Melhor Envio (619..., ME...BR) → Melhor Envio
 *  - padrão Correios (AB123456789BR) → Correios primeiro; se não for do nosso contrato,
 *    o atualizarRastreios() cai para o Melhor Envio
 *  - outro formato → pela forma de envio
 */
function decidirRota_(codigo, formaNome, formaCodigo, correiosOk, cfg) {
  cfg = cfg || CONFIG;
  if (ehCodigoMelhorEnvio_(codigo)) return 'MELHOR_ENVIO';
  if (ehCodigoCorreios_(codigo)) {
    if (cfg.ROTA_CODIGO_CORREIOS === 'MELHOR_ENVIO') return 'MELHOR_ENVIO';
    return (correiosOk || cfg.ROTA_CODIGO_CORREIOS === 'CORREIOS_API') ? 'CORREIOS_API' : 'MELHOR_ENVIO';
  }
  const forma = normalizarTexto_(formaNome + ' ' + formaCodigo);
  const pareceCorreios = cfg.FORMAS_CORREIOS.some(function (p) { return forma.indexOf(p) >= 0; });
  return pareceCorreios && correiosOk ? 'CORREIOS_API' : 'MELHOR_ENVIO';
}

/** A forma de envio é uma das monitoradas (SEDEX, PAC, Jadlog)? Motoboy/retirada ficam de fora. */
function formaMonitorada_(formaNome, formaCodigo, codigo, cfg) {
  cfg = cfg || CONFIG;
  const forma = normalizarTexto_(formaNome + ' ' + formaCodigo);
  const todas = cfg.FORMAS_CORREIOS.concat(cfg.FORMAS_MELHOR_ENVIO);
  return ehCodigoCorreios_(codigo) || todas.some(function (p) { return forma.indexOf(p) >= 0; });
}

/* ============================== QUEM RECEBEU ============================== */

// Campos que guardam quem assinou/recebeu a entrega (comparados sem acento, maiúscula, "_" ou espaço).
// "receiver"/"to" ficam de fora de propósito: nessas APIs costumam ser o DESTINATÁRIO, não quem recebeu.
const CAMPOS_RECEBEDOR = ['recebedor', 'nomerecebedor', 'recebedornome', 'nomedorecebedor', 'recebidopor', 'receivedby'];

/**
 * Procura o nome de quem recebeu a entrega em um evento/objeto bruto da transportadora.
 * Aceita campo próprio ({recebedor: {nome}} / {recebedor: "Nome"}) ou texto "Recebido por: Nome".
 * Nunca devolve documento (só números): CPF/RG do recebedor não é guardado.
 */
function extrairRecebedor_(obj) {
  let achado = '';
  const limpar = function (v) {
    const t = String(v || '').replace(/\s+/g, ' ').trim();
    if (t.length < 2 || t.length > 80 || /^[\d.\-\/\s]+$/.test(t)) return '';
    return t;
  };
  const andar = function (v, prof) {
    if (achado || prof > 6 || v === null || v === undefined) return;
    if (typeof v === 'string') {
      const m = v.match(/recebid[oa]\s+por\s*:?\s*([A-Za-zÀ-ÿ'´`. ]{3,60})/i);
      if (m) achado = limpar(m[1].replace(/\s+(em|no|na|às|as)\s*$/i, ''));
      return;
    }
    if (Array.isArray(v)) { v.forEach(function (x) { andar(x, prof + 1); }); return; }
    if (typeof v !== 'object') return;
    const chaves = Object.keys(v);
    for (let i = 0; i < chaves.length && !achado; i++) {
      const k = normalizarTexto_(chaves[i]).replace(/[^a-z]/g, '');
      if (CAMPOS_RECEBEDOR.indexOf(k) < 0) continue;
      const val = v[chaves[i]];
      achado = limpar(val && typeof val === 'object' ? (val.nome || val.name || val.nomeRecebedor || '') : val);
    }
    for (let i = 0; i < chaves.length && !achado; i++) andar(v[chaves[i]], prof + 1);
  };
  andar(obj, 0);
  return achado;
}

/* ============================== CHARGEBACK ============================== */

/**
 * A situação da LI conta como chargeback? Com códigos configurados, só eles valem;
 * sem códigos, vale a situação cujo código ou nome tenha uma das palavras (ex.: "chargeback", "disputa").
 */
function ehSituacaoChargeback_(sit, cfg) {
  cfg = cfg || CONFIG;
  if (!sit) return false;
  const codigos = cfg.LI_SITUACOES_CHARGEBACK || [];
  if (codigos.length) return codigos.indexOf(String(sit.codigo || '')) >= 0;
  const texto = normalizarTexto_((sit.codigo || '') + ' ' + (sit.nome || ''));
  return (cfg.PALAVRAS_CHARGEBACK || []).some(function (p) { return texto.indexOf(p) >= 0; });
}

