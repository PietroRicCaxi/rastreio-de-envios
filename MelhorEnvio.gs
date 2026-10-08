/**
 * MelhorEnvio.gs — status das etiquetas (Jadlog .Com / .Package, e SEDEX/PAC se comprados no ME).
 *
 * Token: painel do Melhor Envio > Integrações > Permissões de acesso > Gerar novo token
 *        (marque ao menos as permissões de leitura de pedidos/etiquetas e "shipping-tracking").
 * Limite: 250 requisições/min por usuário. A rota de status tem cache de ~1h no ME,
 *         por isso consultamos de hora em hora.
 *
 * Por que não webhook? O webhook do ME só dispara para etiquetas geradas pelo MESMO
 * aplicativo que cadastrou o webhook. Etiquetas geradas pelo site ou por outra
 * integração (ex.: a da LI/Bling) não disparam. Por isso usamos consulta periódica.
 */
const ME_BASE = 'https://melhorenvio.com.br/api/v2/me';

function meHeaders_() {
  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + prop_('ME_TOKEN', true),
    'User-Agent': 'ClickPresilhas-Rastreio (' + prop_('ME_EMAIL_CONTATO', true) + ')'
  };
}

function meGet_(caminho, params) {
  Utilities.sleep(CONFIG.PAUSA_ENTRE_CHAMADAS_MS);
  return httpJson_(ME_BASE + caminho + montarQuery_(params), { method: 'get', headers: meHeaders_() }, 'ME GET ' + caminho);
}

function mePost_(caminho, corpo) {
  Utilities.sleep(CONFIG.PAUSA_ENTRE_CHAMADAS_MS);
  return httpJson_(ME_BASE + caminho, { method: 'post', headers: meHeaders_(), payload: JSON.stringify(corpo) }, 'ME POST ' + caminho);
}

/**
 * Acha as etiquetas do Melhor Envio que correspondem aos códigos salvos na LI.
 *
 * Na LI, os pedidos Jadlog guardam o código do Melhor Rastreio (formato ME...BR), que no ME
 * fica no campo "self_tracking". A busca /orders/search do ME NÃO procura por esse campo,
 * então varremos a lista de etiquetas (/orders) da mais nova para a mais antiga até achar
 * todos os códigos, ou até passar de `dataLimite` (etiquetas mais antigas não interessam).
 *
 * Retorna { CODIGO_EM_MAIUSCULAS: idEtiqueta }.
 */
function meIndexarEtiquetas_(codigos, dataLimite, tempoOk, info) {
  info = info || {};
  info.campos = {}; info.itens = {}; info.paginas = 0; info.etiquetas = 0; info.maisAntiga = null;
  const pendentes = {};
  codigos.forEach(function (c) { pendentes[String(c).toUpperCase()] = true; });
  let faltam = Object.keys(pendentes).length;
  const achados = {};
  const limite = dataLimite ? new Date(dataLimite).getTime() : 0;
  const maxPaginas = CONFIG.ME_MAX_PAGINAS_BUSCA;

  const processar = function (itens) {
    let maisNova = 0, maisAntiga = Infinity;
    info.paginas++;
    itens.forEach(function (it) {
      info.etiquetas++;
      const campos = { self_tracking: it.self_tracking, tracking: it.tracking, protocol: it.protocol,
                       melhorenvio_tracking: it.melhorenvio_tracking, authorization_code: it.authorization_code, id: it.id };
      // Número do pedido da Loja Integrada gravado na etiqueta (tag mi:marketplace_code ou "Loja Integrada - SITE 12345")
      const ped = pedidoDaEtiqueta_(it);
      if (ped && !/^(canceled|cancelled|expired)$/i.test(String(it.status || ''))) campos.pedido = 'PEDIDO:' + ped;
      Object.keys(campos).forEach(function (nome) {
        if (!campos[nome]) return;
        const k = String(campos[nome]).toUpperCase();
        if (pendentes[k] && !achados[k]) { achados[k] = it.id; info.campos[k] = nome; info.itens[k] = it; faltam--; }
      });
      // Plano B: o código pode estar em outro campo (ex.: código nativo da Jadlog).
      // Procuramos o texto do código em toda a etiqueta (só para códigos com 8+ caracteres).
      if (faltam > 0) {
        const texto = JSON.stringify(it).toUpperCase();
        Object.keys(pendentes).forEach(function (k) {
          if (achados[k] || k.length < 8) return;
          if (new RegExp('[^A-Z0-9]' + k + '[^A-Z0-9]').test(texto)) { achados[k] = it.id; info.campos[k] = 'outro campo'; info.itens[k] = it; faltam--; }
        });
      }
      const t = it.created_at ? new Date(it.created_at).getTime() : NaN;
      if (!isNaN(t)) {
        maisNova = Math.max(maisNova, t); maisAntiga = Math.min(maisAntiga, t);
        if (!info.maisAntiga || t < info.maisAntiga) info.maisAntiga = t;
      }
    });
    return { maisNova: maisNova, maisAntiga: maisAntiga };
  };

  // Página 1 diz se a lista vem da mais nova para a mais antiga (normal) ou o contrário
  const p1 = meGet_('/orders', { page: 1 }) || {};
  const itens1 = p1.data || [];
  if (!itens1.length) return achados;
  const d1 = processar(itens1);
  const ultima = Number(p1.last_page) || 1;
  const decrescente = !(itens1.length > 1 && itens1[0].created_at && itens1[itens1.length - 1].created_at &&
    new Date(itens1[0].created_at) < new Date(itens1[itens1.length - 1].created_at));

  // Se a lista vier da mais antiga para a mais nova, começamos pela última página
  const paginas = [];
  if (decrescente) { for (let p = 2; p <= ultima; p++) paginas.push(p); }
  else { for (let p = ultima; p >= 2; p--) paginas.push(p); }
  if (decrescente && limite && d1.maisAntiga < limite) return achados;

  for (let i = 0; i < paginas.length && i < maxPaginas && faltam > 0; i++) {
    if (tempoOk && !tempoOk()) break;
    const resp = meGet_('/orders', { page: paginas[i] }) || {};
    const itens = resp.data || [];
    if (!itens.length) break;
    const d = processar(itens);
    if (limite && d.maisAntiga < limite && d.maisNova < limite) break; // página inteira é mais antiga que o necessário
  }
  return achados;
}

/**
 * Busca a etiqueta pelo NOME DO DESTINATÁRIO (usada quando o código da LI não é achado).
 * Aceita só etiquetas: do mesmo nome, criadas entre 2 dias antes e 15 dias depois do pedido,
 * não canceladas e ainda não ligadas a outro pedido. Havendo mais de uma, a mais próxima da data do pedido.
 */
function meBuscarPorNome_(nome, dataPedido, idsUsados, cfg) {
  const alvo = nomeComparavel_(nome);
  if (alvo.length < 5) return null;
  const resp = meGet_('/orders/search', { q: String(nome).trim() });
  const itens = Array.isArray(resp) ? resp : ((resp && resp.data) || []);
  return escolherPorNome_(itens, alvo, dataPedido, idsUsados || {});
}

function nomeComparavel_(n) {
  return normalizarTexto_(n).replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Parte pura da busca por nome (testável). */
function escolherPorNome_(itens, alvo, dataPedido, idsUsados) {
  const ref = dataPedido ? new Date(dataPedido).getTime() : Date.now();
  const cands = (itens || []).filter(function (it) {
    if (!it || !it.id || idsUsados[String(it.id)]) return false;
    if (['canceled', 'cancelled', 'expired'].indexOf(String(it.status || '').toLowerCase()) >= 0) return false;
    const destino = it.to && it.to.name ? nomeComparavel_(it.to.name) : '';
    if (!destino || (destino !== alvo && destino.indexOf(alvo) < 0 && alvo.indexOf(destino) < 0)) return false;
    const t = it.created_at ? new Date(it.created_at).getTime() : NaN;
    if (isNaN(t)) return false;
    const dias = (t - ref) / 864e5;
    return dias >= -2 && dias <= 15;
  });
  if (!cands.length) return null;
  cands.sort(function (a, b) {
    return Math.abs(new Date(a.created_at).getTime() - ref) - Math.abs(new Date(b.created_at).getTime() - ref);
  });
  return cands[0];
}

/** Número do pedido da LI que o Melhor Envio guardou na etiqueta (ou ''). */
function pedidoDaEtiqueta_(it) {
  const tags = (it && it.tags) || [];
  for (let i = 0; i < tags.length; i++) {
    if (tags[i] && tags[i].tag === 'mi:marketplace_code' && /^\d{3,}$/.test(String(tags[i].url || ''))) return String(tags[i].url);
  }
  const m = String((it && it.reminder) || '').match(/loja integrada\D*(\d{3,})/i);
  return m ? m[1] : '';
}

/** Atalho para um único código (usado no diagnóstico). */
function meBuscarEtiqueta_(codigo) {
  const achados = meIndexarEtiquetas_([codigo], new Date(Date.now() - CONFIG.JANELA_MAX_DIAS * 86400000));
  return achados[String(codigo).toUpperCase()] || null;
}

/** Detalhe completo de uma etiqueta (GET /orders/{id}). */
function meDetalhe_(id) {
  return meGet_('/orders/' + encodeURIComponent(id));
}

/** Status de várias etiquetas de uma vez. Retorna { idEtiqueta: {...} }. */
function meStatusLote_(ids) {
  const saida = {};
  for (let i = 0; i < ids.length; i += 100) {
    const lote = ids.slice(i, i + 100);
    const resp = mePost_('/shipment/tracking', { orders: lote }) || {};
    Object.keys(resp).forEach(function (k) { saida[k] = resp[k]; });
  }
  return saida;
}

/**
 * Converte o status do ME para o formato interno (o mesmo usado para os Correios).
 * O ME não devolve o histórico detalhado da Jadlog — só a situação da etiqueta e as datas.
 */
function meNormalizar_(info) {
  if (!info) return { eventos: [], previsao: null, erro: 'Etiqueta não encontrada no Melhor Envio', statusMe: '' };
  const marcos = [
    ['created_at', 'Etiqueta criada'],
    ['paid_at', 'Etiqueta paga'],
    ['generated_at', 'Etiqueta gerada'],
    ['posted_at', 'Objeto postado'],
    ['delivered_at', 'Objeto entregue ao destinatário'],
    ['canceled_at', 'Etiqueta cancelada'],
    ['expired_at', 'Etiqueta expirada']
  ];
  const eventos = [];
  marcos.forEach(function (m) {
    if (info[m[0]]) eventos.push({ data: info[m[0]], descricao: m[1], local: '', codigo: 'ME', tipo: m[0] });
  });
  eventos.sort(function (a, b) { return new Date(b.data) - new Date(a.data); });
  return {
    eventos: eventos,
    previsao: null,
    erro: null,
    statusMe: String(info.status || '').toLowerCase(),
    tracking: info.tracking || info.melhorenvio_tracking || '',
    recebedor: extrairRecebedor_(info)
  };
}
