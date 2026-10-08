/**
 * Correios.gs — API de Rastro (CWS). Exige contrato com os Correios.
 *
 * Dois jeitos de autenticar (o sistema detecta sozinho):
 *
 *  1) CHAVE DE ACESSO (recomendado — é o que a Click Presilhas usa)
 *     CWS > Chaves de acesso > Nova chave (com "SRO - Rastro" ligado).
 *     A chave começa com "cws-" e JÁ É o token: vai direto no header
 *     "Authorization: Bearer cws-...". Não precisa de usuário nem cartão.
 *     Validade: a que foi escolhida na criação (máx. 180 dias) — gere outra antes de vencer.
 *
 *  2) CÓDIGO DE ACESSO (modelo antigo)
 *     Usuário idCorreios + código de acesso (40 caracteres) + cartão de postagem →
 *     o sistema pede um token na API Token e guarda por 6 h.
 *
 *  Propriedade obrigatória: CORREIOS_CODIGO_ACESSO (a chave "cws-..." ou o código antigo).
 *  CORREIOS_USUARIO e CORREIOS_CARTAO_POSTAGEM só são usados no modelo 2.
 */
const CORREIOS_BASE = 'https://api.correios.com.br';

function correiosUsaChaveDireta_() {
  return /^cws-/i.test(prop_('CORREIOS_CODIGO_ACESSO'));
}

function correiosDisponivel_() {
  if (!prop_('CORREIOS_CODIGO_ACESSO')) return false;
  if (correiosUsaChaveDireta_()) return true;
  return !!(prop_('CORREIOS_USUARIO') && prop_('CORREIOS_CARTAO_POSTAGEM'));
}

/** Devolve o token para o header Bearer. */
function correiosToken_() {
  // Modelo 1: a chave de acesso já é o token
  if (correiosUsaChaveDireta_()) return prop_('CORREIOS_CODIGO_ACESSO', true);

  // Modelo 2: gera token com usuário + código de acesso + cartão
  const cache = CacheService.getScriptCache();
  const salvo = cache.get('CORREIOS_TOKEN');
  if (salvo) return salvo;

  const basic = Utilities.base64Encode(prop_('CORREIOS_USUARIO', true) + ':' + prop_('CORREIOS_CODIGO_ACESSO', true));
  const resp = httpJson_(CORREIOS_BASE + '/token/v1/autentica/cartaopostagem', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Basic ' + basic },
    payload: JSON.stringify({ numero: prop_('CORREIOS_CARTAO_POSTAGEM', true) })
  }, 'Correios token');

  if (!resp || !resp.token) throw new Error('Correios: não retornou token. Verifique as credenciais CORREIOS_*.');
  cache.put('CORREIOS_TOKEN', resp.token, 6 * 60 * 60);
  return resp.token;
}

/** Consulta todos os eventos de um objeto. */
function correiosRastrear_(codigo) {
  Utilities.sleep(CONFIG.PAUSA_ENTRE_CHAMADAS_MS);
  const resp = httpJson_(CORREIOS_BASE + '/srorastro/v1/objetos/' + encodeURIComponent(codigo) + '?resultado=T', {
    method: 'get',
    headers: { 'Authorization': 'Bearer ' + correiosToken_() }
  }, 'Correios rastro');
  const obj = resp && resp.objetos && resp.objetos[0];
  return correiosNormalizar_(obj);
}

/**
 * Se a chave for recusada (vencida/revogada), avisa por e-mail — no máximo 1 vez a cada 12 h.
 * Sem isso, o rastreio dos Correios pararia em silêncio quando a chave vencer.
 */
function avisarAcessoCorreiosNegado_(mensagem) {
  log_('atualizarRastreios/Correios', 'Acesso negado: ' + mensagem);
  const cache = CacheService.getScriptCache();
  if (cache.get('AVISO_CORREIOS_401')) return;
  cache.put('AVISO_CORREIOS_401', '1', 12 * 60 * 60);
  MailApp.sendEmail({
    to: destinatarios_(),
    subject: '[Rastreio] ⚠️ Correios recusou a chave de acesso — rastreio SEDEX/PAC parado',
    htmlBody: '<p style="font-family:Arial">A API dos Correios recusou a chave configurada em ' +
      '<b>CORREIOS_CODIGO_ACESSO</b>. O mais provável é que a chave tenha <b>vencido</b>.</p>' +
      '<p style="font-family:Arial">Como resolver: entre em <a href="https://cws.correios.com.br">cws.correios.com.br</a> ' +
      '→ Chaves de acesso → Nova chave (ligar "SRO - Rastro", expiração 180 dias) e cole a nova chave em ' +
      'Apps Script → Configurações do projeto → Propriedades do script.</p>' +
      '<p style="font-family:Arial;font-size:12px;color:#666">Detalhe técnico: ' + String(mensagem).substring(0, 300) + '</p>'
  });
}

/**
 * Converte a resposta dos Correios para o formato interno:
 * { eventos: [{data, descricao, local, codigo, tipo, recebedor}] (mais recente primeiro), previsao, erro,
 *   recebedor (quem recebeu, se os Correios informarem), camposEntrega (nomes dos campos do evento de entrega) }
 */
function correiosNormalizar_(obj) {
  if (!obj) return { eventos: [], previsao: null, erro: 'Sem resposta dos Correios' };
  const eventos = (obj.eventos || []).map(function (ev) {
    const un = ev.unidade || {};
    const end = un.endereco || {};
    const destino = ev.unidadeDestino && ev.unidadeDestino.endereco;
    let descricao = ev.descricao || '';
    // "detalhe" às vezes traz convite de pesquisa com link — ignoramos esse tipo de texto
    if (ev.detalhe && !/https?:\/\//i.test(ev.detalhe)) descricao += ' — ' + ev.detalhe;
    if (destino && destino.cidade) descricao += ' (para ' + destino.cidade + '/' + (destino.uf || '') + ')';
    return {
      data: ev.dtHrCriado || '',
      descricao: descricao,
      local: [un.nome || '', [end.cidade, end.uf].filter(Boolean).join('/')].filter(Boolean).join(' — '),
      codigo: ev.codigo || '',
      tipo: ev.tipo || '',
      recebedor: extrairRecebedor_(ev),
      _campos: Object.keys(ev)
    };
  });
  eventos.sort(function (a, b) { return new Date(b.data) - new Date(a.data); });
  // quem recebeu: de preferência o do evento de entrega
  const entrega = eventos.filter(function (e) { return classificarEvento_(e) === 'ENTREGUE'; })[0];
  const comNome = eventos.filter(function (e) { return e.recebedor; })[0];
  const recebedor = (entrega && entrega.recebedor) || (comNome && comNome.recebedor) || extrairRecebedor_({ recebedor: obj.recebedor });
  const camposEntrega = entrega ? entrega._campos : [];
  eventos.forEach(function (e) { delete e._campos; });
  return {
    eventos: eventos,
    previsao: obj.dtPrevista || null,
    erro: eventos.length ? null : (obj.mensagem || null),
    recebedor: recebedor,
    camposEntrega: camposEntrega
  };
}
