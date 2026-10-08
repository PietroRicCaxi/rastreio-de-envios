/**
 * LojaIntegrada.gs — leitura de pedidos "Enviado" e dos códigos de rastreio.
 *
 * API v1: https://api.awsli.com.br/v1
 * Autenticação: header  Authorization: chave_api <CHAVE> aplicacao <CHAVE_APLICACAO>
 *
 * IMPORTANTE: os nomes de campos abaixo seguem a API v1 da LI. Se a função
 * diagnosticoLojaIntegrada() mostrar nomes diferentes, ajuste só as funções
 * liExtrairEnvios_() e liResumoPedido_() — o resto do sistema não muda.
 */
const LI_BASE = 'https://api.awsli.com.br/v1';

function liHeaders_() {
  return {
    'Authorization': 'chave_api ' + prop_('LI_CHAVE_API', true) +
                     ' aplicacao ' + prop_('LI_CHAVE_APLICACAO', true),
    'Content-Type': 'application/json'
  };
}

function liGet_(caminho, params) {
  Utilities.sleep(CONFIG.PAUSA_ENTRE_CHAMADAS_MS);
  return httpJson_(LI_BASE + caminho + montarQuery_(params),
    { method: 'get', headers: liHeaders_() }, 'LI GET ' + caminho);
}

function liPut_(caminho, corpo) {
  Utilities.sleep(CONFIG.PAUSA_ENTRE_CHAMADAS_MS);
  return httpJson_(LI_BASE + caminho,
    { method: 'put', headers: liHeaders_(), payload: JSON.stringify(corpo) }, 'LI PUT ' + caminho);
}

/** Descobre o ID numérico de uma situação pelo código (ex.: "pedido_enviado"). Fica em cache. */
function liIdSituacao_(codigo) {
  const chave = 'LI_SITUACAO_ID_' + codigo;
  const cache = prop_(chave);
  if (cache) return cache;

  const resp = liGet_('/situacao/', { limit: 100 });
  const lista = (resp && (resp.objects || resp)) || [];
  for (let i = 0; i < lista.length; i++) {
    if (lista[i].codigo === codigo) {
      setProp_(chave, lista[i].id);
      return String(lista[i].id);
    }
  }
  throw new Error('Situação "' + codigo + '" não encontrada na LI. Rode diagnosticoLojaIntegrada() ' +
    'e ajuste CONFIG.LI_SITUACAO_ENVIADO com o código correto.');
}

/** Lista de situações da LI ({id, codigo, nome}), guardada por 6 h. */
function liSituacoes_() {
  const cache = CacheService.getScriptCache();
  const salvo = cache.get('LI_SITUACOES');
  if (salvo) return JSON.parse(salvo);
  const resp = liGet_('/situacao/', { limit: 100 });
  const lista = ((resp && (resp.objects || resp)) || []).map(function (x) {
    return { id: String(x.id), codigo: x.codigo || '', nome: x.nome || '' };
  });
  cache.put('LI_SITUACOES', JSON.stringify(lista), 6 * 60 * 60);
  return lista;
}

/** Situações da LI que contam como chargeback / pagamento em disputa (ver CONFIG.LI_SITUACOES_CHARGEBACK). */
function liSituacoesChargeback_() {
  return liSituacoes_().filter(function (x) { return ehSituacaoChargeback_(x); });
}

/**
 * Lista os números dos pedidos de uma situação que foram ATUALIZADOS desde `desde`.
 * É isso que evita puxar os pedidos antigos (2022+): só entra o que mudou recentemente.
 */
function liListarPorSituacaoDesde_(idSit, desde) {
  const numeros = [];
  let offset = 0;
  const limit = 50;
  while (true) {
    const resp = liGet_('/pedido/search/', {
      situacao_id: idSit,
      since_atualizado: desde,
      limit: limit,
      offset: offset
    });
    const objs = (resp && resp.objects) || [];
    objs.forEach(function (p) {
      if (p.numero) numeros.push(String(p.numero));
    });
    const temMais = resp && resp.meta && resp.meta.next;
    if (!temMais || objs.length < limit) break;
    offset += limit;
    if (offset > 5000) break; // trava de segurança
  }
  return numeros;
}

/** Pedidos "Enviado" atualizados desde `desde`. */
function liListarEnviadosDesde_(desde) {
  return liListarPorSituacaoDesde_(liIdSituacao_(CONFIG.LI_SITUACAO_ENVIADO), desde);
}

function liDetalhePedido_(numero) {
  return liGet_('/pedido/' + numero + '/');
}

/**
 * Converte as datas da LI em Date, aceitando os formatos que a API usa
 * ("2026-09-23T12:03:47.430942", "2026-09-23 12:03:47", "23/09/2026 12:03", com ou sem fuso).
 * Devolve null se não der para entender (em vez de gravar uma data inválida, que some na planilha).
 */
function parseDataLi_(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const s = String(v).trim();
  if (/T.*(Z|[+-]\d{2}:?\d{2})$/.test(s)) { const z = new Date(s); if (!isNaN(z.getTime())) return z; }
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/** Dados básicos do pedido para a planilha. */
function liResumoPedido_(p) {
  const cliente = p.cliente || {};
  const end = p.endereco_entrega || {};
  const sit = p.situacao || {};
  return {
    numero: String(p.numero),
    dataPedido: p.data_criacao || p.data || p.data_modificacao || '',
    dataModificacao: p.data_modificacao || '',
    cliente: cliente.nome || end.nome || '',
    cidadeUf: [end.cidade, end.estado].filter(Boolean).join('/'),
    situacaoCodigo: (typeof sit === 'object') ? (sit.codigo || '') : String(sit),
    situacaoNome: (typeof sit === 'object') ? (sit.nome || '') : ''
  };
}

/**
 * Extrai os envios (código de rastreio + forma) de um pedido.
 * Um pedido pode ter mais de um envio/volume — cada um vira uma linha.
 */
function liExtrairEnvios_(p) {
  const envios = p.envios || p.envio || [];
  const lista = Array.isArray(envios) ? envios : [envios];
  const saida = [];
  lista.forEach(function (e) {
    if (!e) return;
    const codigo = normalizarCodigo_(e.objeto || e.codigo_rastreio || e.rastreamento || e.tracking || '');
    if (!codigo) return;
    const forma = e.forma_envio || {};
    saida.push({
      codigo: codigo,
      formaNome: forma.nome || forma.name || '',
      formaCodigo: forma.code || forma.codigo || '',
      formaTipo: forma.tipo || '',
      prazoDias: Number(e.prazo || 0) || null,
      dataEnvio: e.data_modificacao || e.data_criacao || ''
    });
  });
  return saida;
}

/** Muda a situação do pedido na LI (usado só se ATUALIZAR_LI_QUANDO_ENTREGUE = true). */
function liAtualizarSituacao_(numero, codigoSituacao) {
  return liPut_('/situacao/pedido/' + numero + '/', { codigo: codigoSituacao });
}
