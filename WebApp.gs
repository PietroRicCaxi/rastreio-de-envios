/**
 * WebApp.gs — o app da operadora (Ocorrências · Detalhe + tratativa · Painel).
 *
 * Publicar: Implantar → Nova implantação → Tipo "App da Web"
 *   Executar como: EU (a conta dona da planilha — é dela que saem os e-mails)
 *   Quem pode acessar: pessoas da organização (ou "Somente eu" para testar)
 *
 * Tudo que a tela pede passa pelas funções api_* abaixo (chamadas via google.script.run).
 * As tratativas ficam nas abas "Tratativas" e "Tratativas - Histórico" da mesma planilha.
 */

const APP = {
  NOME_LOJA: 'Click Presilhas',            // assinatura dos e-mails/mensagens ao cliente
  // Link do pedido no painel da LI. CONFIRMAR: abra um pedido no painel e copie o formato do endereço.
  LI_URL_PEDIDO: 'https://app.lojaintegrada.com.br/painel/pedido/{numero}/detalhar',
  // Satisfação: pedidos entregues há até X dias que ainda não receberam a mensagem entram na lista
  SATISFACAO_JANELA_DIAS: 10,
  // Link de avaliação no Google, incluído na mensagem de satisfação
  LINK_AVALIACAO: 'https://g.page/Click%20Presilhas/review?mt',
  ABA_TRAT: 'Tratativas',
  ABA_TRAT_HIST: 'Tratativas - Histórico'
};

const TRAT_SITUACOES = [
  { id: 'nova', label: 'Nova', aberta: true },
  { id: 'contato', label: 'Em contato com cliente', aberta: true },
  { id: 'transportadora', label: 'Aguardando transportadora', aberta: true },
  { id: 'reenvio', label: 'Reenvio solicitado', aberta: true },
  { id: 'reembolso', label: 'Reembolso solicitado', aberta: true },
  { id: 'resolvida', label: 'Resolvida', aberta: false },
  { id: 'encerrada', label: 'Encerrada sem ação (só anotado)', aberta: false }
];

// Gravidade para ordenar a fila (menor = mais grave)
const GRAVIDADE = {
  EXTRAVIADO: 1, DEVOLVIDO: 2, EM_DEVOLUCAO: 3, PROBLEMA_ENTREGA: 4, TENTATIVA_FALHOU: 4, DESVIO: 5,
  PARADO: 6, ATRASADO: 7, AGUARDANDO_RETIRADA: 8, NAO_POSTADO: 9, CANCELADO: 10, SEM_CONCLUSAO: 11
};

/* ============================== PÁGINA ============================== */

function doGet() {
  return HtmlService.createTemplateFromFile('App').evaluate()
    .setTitle('Rastreio de envios')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function usuarioAtual_() {
  let email = '';
  try { email = Session.getActiveUser().getEmail() || ''; } catch (e) {}
  return email;
}

/** Se a propriedade USUARIOS_APP existir (e-mails separados por vírgula), só eles usam o app. */
function checarAcesso_() {
  const lista = prop_('USUARIOS_APP');
  if (!lista) return;
  const u = usuarioAtual_().toLowerCase();
  if (!u) return; // conta pessoal do Google não informa o e-mail: o controle fica no "Quem pode acessar"
  const ok = lista.toLowerCase().split(',').map(function (s) { return s.trim(); }).indexOf(u) >= 0;
  if (!ok) throw new Error('Seu usuário (' + u + ') não tem acesso a este app.');
}

/* ============================== TRATATIVAS (planilha) ============================== */

const COLS_TRAT = ['Chave', 'Pedido LI', 'Situação', 'Gestão informada', 'Status na resolução', 'Atualizado em', 'Atualizado por',
                   'Satisfação', 'Satisfação em'];
const COLS_TRAT_HIST = ['Data/hora', 'Chave', 'Pedido LI', 'Ação', 'Detalhe', 'Por'];

function abaTrat_(nome, cols) {
  const ss = planilha_();
  let aba = ss.getSheetByName(nome);
  if (!aba) {
    aba = ss.insertSheet(nome);
    aba.getRange(1, 1, 1, cols.length).setValues([cols])
      .setFontWeight('bold').setBackground('#1f3b5c').setFontColor('#ffffff');
    aba.setFrozenRows(1);
  } else {
    const cab = aba.getRange(1, 1, 1, cols.length);
    if (cab.getValues()[0].join('|') !== cols.join('|')) {  // colunas novas entram no fim
      cab.setValues([cols]).setFontWeight('bold').setBackground('#1f3b5c').setFontColor('#ffffff');
    }
  }
  return aba;
}

/** { chave: {linha, situacao, gestao, statusResolucao, atualizadoEm, por} } */
function lerTratativas_() {
  const aba = abaTrat_(APP.ABA_TRAT, COLS_TRAT);
  const n = aba.getLastRow();
  const mapa = {};
  if (n < 2) return mapa;
  aba.getRange(2, 1, n - 1, COLS_TRAT.length).getValues().forEach(function (l, i) {
    if (!l[0]) return;
    mapa[l[0]] = { linha: i + 2, situacao: l[2] || 'nova', gestao: l[3] === true, statusResolucao: l[4] || '',
                   atualizadoEm: l[5], por: l[6] || '', satisfacao: l[7] || '', satisfacaoEm: l[8] || '' };
  });
  return mapa;
}

function gravarTratativa_(chave, pedido, t) {
  const aba = abaTrat_(APP.ABA_TRAT, COLS_TRAT);
  const valores = [[chave, pedido, t.situacao || 'nova', t.gestao === true, t.statusResolucao || '', new Date(), t.por || '',
                     t.satisfacao || '', t.satisfacaoEm || '']];
  if (t.linha) aba.getRange(t.linha, 1, 1, COLS_TRAT.length).setValues(valores);
  else aba.appendRow(valores[0]);
}

function registrarTratHist_(chave, pedido, acao, detalhe) {
  abaTrat_(APP.ABA_TRAT_HIST, COLS_TRAT_HIST)
    .appendRow([new Date(), chave, pedido, acao, String(detalhe || '').substring(0, 2000), usuarioAtual_() || 'Operadora']);
}

function lerTratHist_(chave) {
  const aba = abaTrat_(APP.ABA_TRAT_HIST, COLS_TRAT_HIST);
  const n = aba.getLastRow();
  if (n < 2) return [];
  return aba.getRange(2, 1, n - 1, COLS_TRAT_HIST.length).getValues()
    .filter(function (l) { return l[1] === chave; })
    .map(function (l) { return { quando: fmtData_(l[0]), ts: new Date(l[0]).getTime(), acao: l[3], detalhe: l[4], por: l[5] }; });
}

function rotuloSituacao_(id) {
  const s = TRAT_SITUACOES.filter(function (x) { return x.id === id; })[0];
  return s ? s.label : 'Nova';
}

function situacaoAberta_(id) {
  const s = TRAT_SITUACOES.filter(function (x) { return x.id === id; })[0];
  return s ? s.aberta : true;
}

/**
 * Regra da fila (função pura): uma linha é ocorrência quando o status atual é de alerta e
 *  - a tratativa está aberta, ou
 *  - foi resolvida/encerrada, mas o status mudou desde então (problema novo → reabre).
 */
function ehOcorrenciaAberta_(o, trat) {
  const cod = o['Status código'];
  if (!STATUS[cod] || !STATUS[cod].alerta) return false;
  if (!trat) return true;
  if (situacaoAberta_(trat.situacao)) return true;
  return trat.statusResolucao !== cod;
}

/** Quando o alerta atual começou (última linha da aba Alertas com o mesmo tipo). */
function inicioDosAlertas_() {
  const aba = planilha_().getSheetByName(CONFIG.ABAS.ALERTAS);
  const mapa = {};
  if (!aba) return mapa;
  const ult = ultimaLinhaColA_(aba);
  if (ult < 2) return mapa;
  aba.getRange(2, 1, ult - 1, 6).getValues().forEach(function (l) {
    if (!l[0]) return;
    const k = String(l[1]) + '|' + normalizarCodigo_(l[3]) + '|' + l[5];
    mapa[k] = l[0];
  });
  return mapa;
}

/* ============================== SATISFAÇÃO E CONTAGENS ============================== */

/** Situação da satisfação de uma linha: 'pendente' | 'enviada' | 'dispensada' | '' (não se aplica). */
function situacaoSatisfacao_(o, t, agora) {
  if (o['Status código'] !== 'ENTREGUE') return '';
  if (t && t.satisfacao) return t.satisfacao;
  const entrega = o['Data último evento'] ? new Date(o['Data último evento']).getTime() : 0;
  if (!entrega) return '';
  return (new Date(agora).getTime() - entrega) / 864e5 <= APP.SATISFACAO_JANELA_DIAS ? 'pendente' : '';
}

/** Grupo de status para os filtros da lista de pedidos. */
function grupoStatus_(o, t) {
  const cod = o['Status código'];
  if (ehOcorrenciaAberta_(o, t)) return 'ocorrencia';
  if (cod === 'ENTREGUE') return 'entregue';
  if (['NOVO', 'AGUARDANDO_POSTAGEM', 'NAO_LOCALIZADO_ME'].indexOf(cod) >= 0) return 'aguardando';
  if (STATUS[cod] && STATUS[cod].final) return 'finalizado';
  return 'transito';
}

function contagens_(linhas, trats, agora) {
  let occ = 0, sat = 0;
  linhas.forEach(function (o) {
    const t = trats[o['Chave']];
    if (ehOcorrenciaAberta_(o, t)) occ++;
    if (situacaoSatisfacao_(o, t, agora) === 'pendente') sat++;
  });
  return { ocorrencias: occ, satisfacao: sat };
}

function mensagemSatisfacao_(d) {
  return {
    assunto: 'Pedido #' + d.pedido + ' — chegou tudo certo?',
    texto: 'Olá' + (d.nome ? ', ' + d.nome : '') + '! Vimos que o seu pedido #' + d.pedido + ' foi entregue. ' +
           'Chegou tudo certo, com a entrega e com os produtos? Se precisar de qualquer coisa, é só responder esta mensagem.\n\n' +
           (APP.LINK_AVALIACAO ? 'Se puder, conte como foi a sua experiência com a gente — leva menos de 1 minuto:\n' + APP.LINK_AVALIACAO + '\n\n' : '') +
           'Obrigado pela compra!\nEquipe ' + APP.NOME_LOJA
  };
}

/* ============================== API: TODOS OS PEDIDOS ============================== */

function api_pedidos() {
  checarAcesso_();
  const linhas = lerEnvios_().linhas;
  const trats = lerTratativas_();
  const agora = new Date();
  let ultimaVerif = 0;
  const itens = linhas.map(function (o) {
    if (o['Última verificação']) ultimaVerif = Math.max(ultimaVerif, new Date(o['Última verificação']).getTime());
    const t = trats[o['Chave']];
    let dias = null;
    if (o['Data postagem']) {
      const fim = (o['Status código'] === 'ENTREGUE' && o['Data último evento']) ? o['Data último evento'] : agora;
      dias = diasUteisEntre_(o['Data postagem'], fim);
    }
    const prazo = Number(o['Prazo LI (dias úteis)']) || null;
    const sat = situacaoSatisfacao_(o, t, agora);
    return {
      chave: o['Chave'], pedido: String(o['Pedido LI']), cliente: o['Cliente'] || '', cidade: o['Cidade/UF'] || '',
      dataPedido: o['Data pedido'] ? fmtData_(o['Data pedido'], 'dd/MM') : '',
      ts: o['Data pedido'] ? new Date(o['Data pedido']).getTime() : (o['Data vínculo'] ? new Date(o['Data vínculo']).getTime() : 0),
      forma: o['Forma de envio'] || '', enviadoPor: o['Enviado por'] || '', codigo: String(o['Código rastreio'] || ''),
      tipo: o['Status código'] || '', status: o['Status'] || '', grupo: grupoStatus_(o, t),
      entregueEm: o['Status código'] === 'ENTREGUE' && o['Data último evento'] ? fmtData_(o['Data último evento'], 'dd/MM') : '',
      dias: dias, prazo: prazo, passou: dias !== null && !!prazo && dias > prazo,
      satisfacao: sat, satisfacaoEm: t && t.satisfacaoEm ? fmtData_(t.satisfacaoEm, 'dd/MM HH:mm') : '',
      satisfacaoDia: t && t.satisfacaoEm ? fmtData_(t.satisfacaoEm, 'yyyy-MM-dd') : '',
      satisfacaoPor: t && t.satisfacao ? (t.por || '') : ''
    };
  }).sort(function (a, b) { return b.ts - a.ts; });
  return {
    usuario: usuarioAtual_(),
    atualizadoEm: ultimaVerif ? fmtData_(new Date(ultimaVerif), 'dd/MM HH:mm') : '',
    janelaSatisfacao: APP.SATISFACAO_JANELA_DIAS,
    contagens: contagens_(linhas, trats, agora),
    itens: itens
  };
}

/** Marca a satisfação como enviada ou dispensada. */
function marcarSatisfacao_(chave, o, valor) {
  const t = lerTratativas_()[chave] || { linha: 0, situacao: 'nova', gestao: false, statusResolucao: '' };
  t.satisfacao = valor; t.satisfacaoEm = new Date(); t.por = usuarioAtual_() || 'Operadora';
  gravarTratativa_(chave, o['Pedido LI'], t);
}

/** Desfaz a marcação de satisfação (enviada/dispensada por engano). */
function api_desfazerSatisfacao(chave) {
  checarAcesso_();
  const o = acharLinha_(chave);
  const t = lerTratativas_()[chave];
  if (t && t.satisfacao) {
    const antes = t.satisfacao;
    t.satisfacao = ''; t.satisfacaoEm = ''; t.por = usuarioAtual_() || 'Operadora';
    gravarTratativa_(chave, o['Pedido LI'], t);
    registrarTratHist_(chave, o['Pedido LI'], 'Satisfação', 'Marcação "' + antes + '" desfeita');
  }
  return api_pedido(chave);
}

function api_dispensarSatisfacao(chave) {
  checarAcesso_();
  const o = acharLinha_(chave);
  marcarSatisfacao_(chave, o, 'dispensada');
  registrarTratHist_(chave, o['Pedido LI'], 'Satisfação', 'Dispensada (não será enviada)');
  return api_pedido(chave);
}

/* ============================== API: RESOLVIDOS E ALTERAÇÕES ============================== */

/**
 * Casos com tratativa resolvida/encerrada + o histórico de tudo que foi alterado no app
 * (situação, anotação, e-mail, WhatsApp, gestão, satisfação), do mais recente para o mais antigo.
 */
function api_resolvidos() {
  checarAcesso_();
  const reg = lerEnvios_();
  const trats = lerTratativas_();
  const agora = new Date();

  const abaH = abaTrat_(APP.ABA_TRAT_HIST, COLS_TRAT_HIST);
  const nH = abaH.getLastRow();
  const hist = nH < 2 ? [] : abaH.getRange(2, 1, nH - 1, COLS_TRAT_HIST.length).getValues().filter(function (l) { return l[0]; });
  const ultimaNota = {};
  hist.forEach(function (l) { if (l[3] === 'Anotação') ultimaNota[l[1]] = l[4]; });

  const resolvidos = Object.keys(trats).filter(function (k) {
    return trats[k].situacao && !situacaoAberta_(trats[k].situacao);
  }).map(function (k) {
    const t = trats[k], o = reg.porChave[k] || {};
    return {
      chave: k, pedido: String(o['Pedido LI'] || String(k).split('|')[0]), cliente: o['Cliente'] || '', cidade: o['Cidade/UF'] || '',
      ocorrencia: STATUS[t.statusResolucao] ? STATUS[t.statusResolucao].rotulo : (t.statusResolucao || ''),
      ocorrenciaTipo: t.statusResolucao || '',
      statusAtual: o['Status'] || '', tipo: o['Status código'] || '',
      situacao: t.situacao, situacaoLabel: rotuloSituacao_(t.situacao),
      quando: t.atualizadoEm ? fmtData_(t.atualizadoEm, 'dd/MM HH:mm') : '', ts: t.atualizadoEm ? new Date(t.atualizadoEm).getTime() : 0,
      por: t.por || '', nota: ultimaNota[k] || '', codigo: String(o['Código rastreio'] || '')
    };
  }).sort(function (a, b) { return b.ts - a.ts; });

  const historico = hist.map(function (l) {
    const o = reg.porChave[l[1]] || {};
    return { quando: fmtData_(l[0], 'dd/MM HH:mm'), ts: new Date(l[0]).getTime(), dia: fmtData_(l[0], 'yyyy-MM-dd'),
             chave: l[1], pedido: String(l[2] || ''), cliente: o['Cliente'] || '', acao: l[3],
             detalhe: String(l[4] || '').substring(0, 220), por: l[5] || '' };
  }).sort(function (a, b) { return b.ts - a.ts; }).slice(0, 500);

  return { usuario: usuarioAtual_(), contagens: contagens_(reg.linhas, trats, agora), resolvidos: resolvidos, historico: historico };
}

/* ============================== API: OCORRÊNCIAS ============================== */

function api_ocorrencias() {
  checarAcesso_();
  const linhas = lerEnvios_().linhas;
  const trats = lerTratativas_();
  const inicios = inicioDosAlertas_();
  const agora = new Date();
  let ultimaVerif = 0;
  const itens = [];
  linhas.forEach(function (o) {
    if (o['Última verificação']) ultimaVerif = Math.max(ultimaVerif, new Date(o['Última verificação']).getTime());
    const t = trats[o['Chave']];
    if (!ehOcorrenciaAberta_(o, t)) return;
    const reaberta = t && !situacaoAberta_(t.situacao);
    const desde = inicios[String(o['Pedido LI']) + '|' + normalizarCodigo_(o['Código rastreio']) + '|' + o['Status']];
    itens.push({
      chave: o['Chave'],
      pedido: String(o['Pedido LI']),
      cliente: o['Cliente'] || '',
      cidade: o['Cidade/UF'] || '',
      tipo: o['Status código'],
      tipoLabel: o['Status'],
      gravidade: GRAVIDADE[o['Status código']] || 50,
      desde: desde ? fmtData_(desde, 'dd/MM') : '',
      diasUteis: desde ? diasUteisEntre_(desde, agora) : null,
      evento: o['Último evento'] || '',
      eventoData: o['Data último evento'] ? fmtData_(o['Data último evento']) : '',
      forma: o['Forma de envio'] || '',
      enviadoPor: o['Enviado por'] || '',
      codigo: String(o['Código rastreio'] || ''),
      vinculo: o['Data vínculo'] ? fmtData_(o['Data vínculo'], 'dd/MM') : '',
      dataPedido: o['Data pedido'] ? fmtData_(o['Data pedido'], 'dd/MM') : '',
      situacao: reaberta ? 'nova' : (t ? t.situacao : 'nova'),
      situacaoLabel: reaberta ? 'Nova (reaberta)' : rotuloSituacao_(t ? t.situacao : 'nova'),
      gestao: !!(t && t.gestao)
    });
  });
  itens.sort(function (a, b) {
    return (a.gravidade - b.gravidade) || ((b.diasUteis || 0) - (a.diasUteis || 0));
  });
  return {
    usuario: usuarioAtual_(),
    atualizadoEm: ultimaVerif ? fmtData_(new Date(ultimaVerif), 'dd/MM HH:mm') : '',
    situacoes: TRAT_SITUACOES,
    contagens: contagens_(linhas, trats, agora),
    itens: itens
  };
}

/* ============================== API: DETALHE DO PEDIDO ============================== */

function acharLinha_(chave) {
  const o = lerEnvios_().porChave[chave];
  if (!o) throw new Error('Envio não encontrado: ' + chave);
  return o;
}

/** E-mail, telefone e endereço do cliente, direto da LI (não ficam guardados na planilha). */
function liContatoCliente_(p) {
  let c = p.cliente || {};
  if (typeof c === 'string') {
    try { c = liGet_(c.replace(/^\/api\/v1/, '')) || {}; } catch (e) { c = {}; }
  }
  const end = p.endereco_entrega || {};
  const tel = c.telefone_celular || c.telefone_principal || c.telefone || end.telefone_celular || end.telefone || '';
  const linha1 = [end.endereco, end.numero].filter(Boolean).join(', ') + (end.complemento ? ' — ' + end.complemento : '');
  const linha2 = [end.bairro, [end.cidade, end.estado].filter(Boolean).join('/')].filter(Boolean).join(', ');
  return {
    nome: c.nome || end.nome || '',
    email: c.email || p.email || '',
    telefone: String(tel || ''),
    whatsapp: numeroWhatsApp_(tel),
    endereco: [linha1, linha2, end.cep ? 'CEP ' + end.cep : ''].filter(Boolean).join(' · ')
  };
}

function numeroWhatsApp_(tel) {
  let d = String(tel || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length >= 12 && d.indexOf('55') === 0) return d;
  if (d.length === 10 || d.length === 11) return '55' + d;
  return '';
}

function primeiroNome_(nome) {
  const p = String(nome || '').trim().split(/\s+/)[0] || '';
  return p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : '';
}

/** Mensagem sugerida ao cliente, de acordo com o tipo de ocorrência (função pura). */
function mensagemSugerida_(tipo, d) {
  const ola = 'Olá' + (d.nome ? ', ' + d.nome : '') + '! ';
  const ped = 'Seu pedido #' + d.pedido;
  const cod = d.codigo ? ' Código de rastreio: ' + d.codigo + '.' : '';
  const transp = d.transportadora ? ' pela ' + d.transportadora : '';
  const assinatura = '\n\nEquipe ' + APP.NOME_LOJA;
  let corpo;
  switch (tipo) {
    case 'ATRASADO': case 'PARADO': case 'DESVIO':
      corpo = ped + ' está com atraso na entrega' + transp + '. Já estamos acompanhando com a transportadora e avisaremos assim que houver novidade.' + cod; break;
    case 'AGUARDANDO_RETIRADA':
      corpo = ped + ' está aguardando retirada na agência. Para retirar, leve um documento com foto e o código de rastreio.' + cod +
              (d.link ? ' Endereço da agência: ' + d.link : ''); break;
    case 'TENTATIVA_FALHOU': case 'PROBLEMA_ENTREGA':
      corpo = 'A transportadora não conseguiu concluir a entrega do pedido #' + d.pedido + '. Pode confirmar o endereço e se haverá alguém para receber?' +
              (d.endereco ? '\n\nEndereço cadastrado: ' + d.endereco : '') + '\n' + cod.trim(); break;
    case 'EXTRAVIADO':
      corpo = 'Infelizmente a transportadora informou o extravio do pedido #' + d.pedido + '. Pedimos desculpas! Já estamos cuidando disso e vamos combinar com você o reenvio ou o reembolso.'; break;
    case 'EM_DEVOLUCAO': case 'DEVOLVIDO':
      corpo = 'O pedido #' + d.pedido + ' não pôde ser entregue e está voltando para nós. Vamos combinar o reenvio: pode confirmar o endereço de entrega?' +
              (d.endereco ? '\n\nEndereço cadastrado: ' + d.endereco : ''); break;
    default:
      corpo = 'Estamos verificando o envio do pedido #' + d.pedido + ' e retornaremos em breve com uma atualização.' + cod;
  }
  return { assunto: 'Pedido #' + d.pedido + ' — atualização da entrega', texto: ola + corpo + assinatura };
}

function api_pedido(chave) {
  checarAcesso_();
  const o = acharLinha_(chave);
  const trats = lerTratativas_();
  const t = trats[chave] || null;
  const reaberta = t && !situacaoAberta_(t.situacao) && t.statusResolucao !== o['Status código'] && STATUS[o['Status código']] && STATUS[o['Status código']].alerta;

  // Eventos ao vivo da transportadora
  let eventos = [], fonte = '', avisoEventos = '';
  try {
    if (o['Rota'] === 'CORREIOS_API' && correiosDisponivel_()) {
      const norm = correiosRastrear_(o['Código rastreio']);
      eventos = norm.eventos; fonte = 'Correios';
    } else if (o['ID Melhor Envio']) {
      const st = meStatusLote_([String(o['ID Melhor Envio'])]);
      eventos = meNormalizar_(st[String(o['ID Melhor Envio'])]).eventos; fonte = 'Melhor Envio';
      avisoEventos = 'O Melhor Envio informa só as etapas principais. Os eventos detalhados da transportadora estão no link de rastreio.';
    }
  } catch (e) { avisoEventos = 'Não foi possível consultar a transportadora agora: ' + e.message; }

  // Contato do cliente (LI)
  let contato = { nome: o['Cliente'] || '', email: '', telefone: '', whatsapp: '', endereco: '' };
  try { const p = liDetalhePedido_(o['Pedido LI']); if (p) contato = liContatoCliente_(p); } catch (e) {}

  const transportadora = o['Enviado por'] || o['Forma de envio'] || '';
  const msg = mensagemSugerida_(o['Status código'], {
    nome: primeiroNome_(contato.nome || o['Cliente']), pedido: String(o['Pedido LI']), codigo: String(o['Código rastreio'] || ''),
    transportadora: transportadora, endereco: contato.endereco, link: o['Link rastreio'] || ''
  });

  let diasTransito = null;
  if (o['Data postagem']) {
    const fim = (o['Status código'] === 'ENTREGUE' && o['Data último evento']) ? o['Data último evento'] : new Date();
    diasTransito = diasUteisEntre_(o['Data postagem'], fim);
  }
  let semMov = null;
  if (o['Data último evento'] && o['Finalizado'] !== 'SIM') semMov = diasUteisEntre_(o['Data último evento'], new Date());

  const agora = new Date();
  const sat = situacaoSatisfacao_(o, t, agora);
  const alerta = !!(STATUS[o['Status código']] && STATUS[o['Status código']].alerta);
  return {
    chave: chave,
    pedido: String(o['Pedido LI']),
    dataPedido: o['Data pedido'] ? fmtData_(o['Data pedido'], 'dd/MM/yyyy') : '',
    vinculo: o['Data vínculo'] ? fmtData_(o['Data vínculo'], 'dd/MM/yyyy') : '',
    entregue: o['Status código'] === 'ENTREGUE',
    entregueEm: o['Status código'] === 'ENTREGUE' && o['Data último evento'] ? fmtData_(o['Data último evento'], 'dd/MM/yyyy') : '',
    satisfacao: sat || (o['Status código'] === 'ENTREGUE' ? 'fora_janela' : ''),
    satisfacaoEm: t && t.satisfacaoEm ? fmtData_(t.satisfacaoEm, 'dd/MM HH:mm') : '',
    mensagemSatisfacao: mensagemSatisfacao_({ nome: primeiroNome_(contato.nome || o['Cliente']), pedido: String(o['Pedido LI']) }),
    mostrarTratativa: alerta || !!(t && (t.situacao !== 'nova' || t.gestao)),
    contagens: contagens_(lerEnvios_().linhas, trats, agora),
    tipo: o['Status código'], tipoLabel: o['Status'],
    alerta: alerta,
    forma: o['Forma de envio'] || '', enviadoPor: o['Enviado por'] || '',
    codigo: String(o['Código rastreio'] || ''), codigoTransportadora: String(o['Código transportadora'] || ''),
    encontradoVia: o['Encontrado via'] || '', observacao: o['Observação'] || '',
    linkRastreio: o['Link rastreio'] || '',
    linkLI: APP.LI_URL_PEDIDO.replace('{numero}', String(o['Pedido LI'])),
    prazo: Number(o['Prazo LI (dias úteis)']) || null,
    diasTransito: diasTransito,
    previsao: o['Previsão entrega'] ? fmtData_(o['Previsão entrega'], 'dd/MM') : '',
    semMovimento: semMov,
    eventos: eventos.map(function (e) {
      return { dia: fmtData_(e.data, 'dd/MM'), hora: fmtData_(e.data, 'HH:mm'), titulo: e.descricao, local: e.local || '' };
    }),
    fonteEventos: fonte, avisoEventos: avisoEventos,
    cliente: { nome: contato.nome || o['Cliente'] || '', cidade: o['Cidade/UF'] || '', email: contato.email,
               telefone: contato.telefone, whatsapp: contato.whatsapp, endereco: contato.endereco },
    situacao: reaberta ? 'nova' : (t ? t.situacao : 'nova'),
    gestao: !!(t && t.gestao),
    situacoes: TRAT_SITUACOES,
    mensagem: msg,
    historico: lerTratHist_(chave).sort(function (a, b) { return b.ts - a.ts; }),
    usuario: usuarioAtual_()
  };
}

/* ============================== API: AÇÕES ============================== */

function tratativaAtual_(chave, o) {
  const t = lerTratativas_()[chave];
  return t || { linha: 0, situacao: 'nova', gestao: false, statusResolucao: '', por: '' };
}

function api_salvarTratativa(chave, situacao, nota, gestao) {
  checarAcesso_();
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const o = acharLinha_(chave);
    const t = tratativaAtual_(chave, o);
    if (!TRAT_SITUACOES.some(function (s) { return s.id === situacao; })) throw new Error('Situação inválida: ' + situacao);
    const mudouSit = t.situacao !== situacao;
    const avisarGestao = gestao === true && !t.gestao;
    t.situacao = situacao;
    t.gestao = gestao === true;
    t.statusResolucao = situacaoAberta_(situacao) ? '' : o['Status código'];
    t.por = usuarioAtual_() || 'Operadora';
    gravarTratativa_(chave, o['Pedido LI'], t);
    if (mudouSit) registrarTratHist_(chave, o['Pedido LI'], 'Situação', 'Alterada para "' + rotuloSituacao_(situacao) + '"');
    if (nota && String(nota).trim()) registrarTratHist_(chave, o['Pedido LI'], 'Anotação', String(nota).trim());
    if (avisarGestao) {
      registrarTratHist_(chave, o['Pedido LI'], 'Gestão informada', 'Aviso enviado por e-mail à gestão');
      const para = (prop_('EMAILS_GESTAO') || prop_('EMAILS_ALERTA', true));
      MailApp.sendEmail({
        to: para,
        subject: '[Rastreio] Pedido #' + o['Pedido LI'] + ' — ' + o['Status'] + ' (' + rotuloSituacao_(situacao) + ')',
        htmlBody: '<p style="font-family:Arial">A operadora marcou este caso para a gestão acompanhar.</p>' +
          tabelaHtml_(['Pedido', 'Cliente', 'Ocorrência', 'Situação', 'Rastreio'],
            [[o['Pedido LI'], o['Cliente'], '<b>' + o['Status'] + '</b>', rotuloSituacao_(situacao), o['Código rastreio']]]) +
          (nota ? '<p style="font-family:Arial"><b>Anotação:</b> ' + String(nota).replace(/</g, '&lt;') + '</p>' : '') +
          '<p style="font-family:Arial;font-size:12px;color:#666">Por ' + (t.por || 'Operadora') + '</p>'
      });
    }
    if (!t.gestao && gestao === false) { /* desmarcar não gera aviso */ }
    return api_pedido(chave);
  } finally {
    lock.releaseLock();
  }
}

/** Envia o e-mail ao cliente (pela conta Google que roda o app) e registra no histórico. */
function api_enviarEmailCliente(chave, assunto, texto, tipo) {
  checarAcesso_();
  const o = acharLinha_(chave);
  const p = liDetalhePedido_(o['Pedido LI']);
  const contato = p ? liContatoCliente_(p) : {};
  if (!contato.email) throw new Error('A Loja Integrada não informou o e-mail deste cliente.');
  if (!texto || !String(texto).trim()) throw new Error('A mensagem está vazia.');
  MailApp.sendEmail({ to: contato.email, subject: assunto || ('Pedido #' + o['Pedido LI']), body: String(texto), name: APP.NOME_LOJA });
  if (tipo === 'satisfacao') {
    registrarTratHist_(chave, o['Pedido LI'], 'Satisfação por e-mail', 'Para ' + contato.email + ': ' + String(texto));
    marcarSatisfacao_(chave, o, 'enviada');
  } else {
    registrarTratHist_(chave, o['Pedido LI'], 'E-mail ao cliente', 'Para ' + contato.email + ': ' + String(texto));
    avancarParaContato_(chave, o);
  }
  return api_pedido(chave);
}

/** O WhatsApp abre no navegador da operadora; aqui só registramos que a mensagem foi aberta. */
function api_registrarWhatsApp(chave, texto, tipo) {
  checarAcesso_();
  const o = acharLinha_(chave);
  if (tipo === 'satisfacao') {
    registrarTratHist_(chave, o['Pedido LI'], 'Satisfação por WhatsApp', 'Mensagem aberta no WhatsApp: ' + String(texto || ''));
    marcarSatisfacao_(chave, o, 'enviada');
  } else {
    registrarTratHist_(chave, o['Pedido LI'], 'WhatsApp', 'Mensagem aberta no WhatsApp: ' + String(texto || ''));
    avancarParaContato_(chave, o);
  }
  return api_pedido(chave);
}

/** Primeira mensagem ao cliente: "Nova" passa sozinha para "Em contato com cliente". */
function avancarParaContato_(chave, o) {
  const t = tratativaAtual_(chave, o);
  if (t.situacao === 'nova' || !situacaoAberta_(t.situacao)) {
    t.situacao = 'contato'; t.statusResolucao = ''; t.por = usuarioAtual_() || 'Operadora';
    gravarTratativa_(chave, o['Pedido LI'], t);
    registrarTratHist_(chave, o['Pedido LI'], 'Situação', 'Alterada para "Em contato com cliente"');
  }
}

/* ============================== API: PAINEL ============================== */

function grupoForma_(o) {
  const real = normalizarTexto_(o['Enviado por'] || '');
  const forma = normalizarTexto_(o['Forma de envio'] || '');
  if (real.indexOf('jadlog') >= 0 || ehCodigoMelhorEnvio_(o['Código rastreio'])) return 'Jadlog';
  if (real.indexOf('pac') >= 0 || forma.indexOf('pac') >= 0) return 'PAC';
  if (real.indexOf('sedex') >= 0 || forma.indexOf('sedex') >= 0 || real.indexOf('correios') >= 0) return 'SEDEX';
  return 'Outro';
}

/** Monta o painel a partir das linhas (função pura, testável). */
function montarPainel_(linhas, trats, agora, diasUteis) {
  diasUteis = Math.max(1, Math.min(120, Math.round(Number(diasUteis) || RESUMO_DIAS_UTEIS)));
  const corte = voltarDiasUteis_(agora, diasUteis).getTime();
  const periodo = linhas.filter(function (o) { return o['Data vínculo'] && new Date(o['Data vínculo']).getTime() >= corte; });
  const emTransito = ['POSTADO', 'EM_TRANSITO', 'SAIU_PARA_ENTREGA', 'AGUARDANDO_RETIRADA'];
  let transito = 0, entregues = 0, noPrazo = 0, comPrazo = 0, somaDias = 0;
  const grupos = {};
  const lista = periodo.map(function (o) {
    const g = grupoForma_(o);
    grupos[g] = grupos[g] || { nome: g, entregues: 0, noPrazo: 0, comPrazo: 0, somaDias: 0 };
    let dias = null;
    if (o['Data postagem']) {
      const fim = (o['Status código'] === 'ENTREGUE' && o['Data último evento']) ? o['Data último evento'] : agora;
      dias = diasUteisEntre_(o['Data postagem'], fim);
    }
    const prazo = Number(o['Prazo LI (dias úteis)']) || null;
    if (emTransito.indexOf(o['Status código']) >= 0) transito++;
    if (o['Status código'] === 'ENTREGUE') {
      entregues++; grupos[g].entregues++;
      if (dias !== null) { somaDias += dias; grupos[g].somaDias += dias; }
      if (dias !== null && prazo) {
        comPrazo++; grupos[g].comPrazo++;
        if (dias <= prazo) { noPrazo++; grupos[g].noPrazo++; }
      }
    }
    return {
      chave: o['Chave'], pedido: String(o['Pedido LI']),
      forma: o['Enviado por'] && nomeComparavel_(o['Enviado por']).indexOf(nomeComparavel_(o['Forma de envio'])) < 0
        ? o['Forma de envio'] + ' → ' + o['Enviado por'] : (o['Forma de envio'] || ''),
      grupo: g, codigo: String(o['Código rastreio'] || ''),
      vinculo: fmtData_(o['Data vínculo'], 'dd/MM'), vinculoTs: new Date(o['Data vínculo']).getTime(),
      dias: dias, prazo: prazo, passou: dias !== null && !!prazo && dias > prazo,
      status: o['Status'] || '', tipo: o['Status código'] || ''
    };
  }).sort(function (a, b) { return b.vinculoTs - a.vinculoTs; });

  const abertas = linhas.filter(function (o) { return ehOcorrenciaAberta_(o, trats[o['Chave']]); }).length;
  const gestao = Object.keys(trats).filter(function (k) {
    const t = trats[k]; return t.gestao && situacaoAberta_(t.situacao);
  }).length;
  const pct = function (a, b) { return b ? Math.round(100 * a / b) : null; };
  const media = function (s, n) { return n ? Math.round(10 * s / n) / 10 : null; };
  return {
    indicadores: {
      emTransito: transito, entregues: entregues, noPrazoPct: pct(noPrazo, comPrazo),
      ocorrencias: abertas, gestao: gestao, mediaDias: media(somaDias, entregues)
    },
    formas: ['SEDEX', 'PAC', 'Jadlog', 'Outro'].filter(function (g) { return grupos[g]; }).map(function (g) {
      const x = grupos[g];
      return { nome: g, pct: pct(x.noPrazo, x.comPrazo), entregues: x.entregues, media: media(x.somaDias, x.entregues) };
    }),
    lista: lista
  };
}

function api_painel(diasUteis) {
  checarAcesso_();
  const linhas = lerEnvios_().linhas;
  let ultimaVerif = 0;
  linhas.forEach(function (o) {
    if (o['Última verificação']) ultimaVerif = Math.max(ultimaVerif, new Date(o['Última verificação']).getTime());
  });
  const dias = Math.max(1, Math.min(120, Math.round(Number(diasUteis) || RESUMO_DIAS_UTEIS)));
  const trats = lerTratativas_();
  const p = montarPainel_(linhas, trats, new Date(), dias);
  p.dias = dias;
  p.contagens = contagens_(linhas, trats, new Date());
  let menor = 0;
  linhas.forEach(function (o) { const t = o['Data vínculo'] ? new Date(o['Data vínculo']).getTime() : 0; if (t && (!menor || t < menor)) menor = t; });
  p.dadosDesde = menor ? fmtData_(new Date(menor), 'dd/MM/yyyy') : '';
  p.atualizadoEm = ultimaVerif ? fmtData_(new Date(ultimaVerif), 'dd/MM HH:mm') : '';
  p.usuario = usuarioAtual_();
  return p;
}

/** Botão "Atualizar agora" do app. */
function api_atualizarAgora() {
  checarAcesso_();
  atualizarRastreios();
  return true;
}
