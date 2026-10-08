/**
 * Planilha.gs — leitura e gravação das abas (Envios, Histórico, Alertas, Log).
 * O script deve estar VINCULADO à planilha (Extensões > Apps Script dentro dela).
 */

function planilha_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function garantirAbas_() {
  const ss = planilha_();
  const defs = {};
  defs[CONFIG.ABAS.ENVIOS] = COLUNAS_ENVIOS;
  defs[CONFIG.ABAS.HISTORICO] = ['Data/hora', 'Pedido LI', 'Código rastreio', 'Status anterior', 'Status novo', 'Evento'];
  defs[CONFIG.ABAS.ALERTAS] = ['Data/hora', 'Pedido LI', 'Cliente', 'Código rastreio', 'Rota', 'Tipo de alerta',
                               'Evento', 'Link rastreio', 'Resolvido?', 'Observação'];
  defs[CONFIG.ABAS.LOG] = ['Data/hora', 'Rotina', 'Resultado'];

  Object.keys(defs).forEach(function (nome) {
    let aba = ss.getSheetByName(nome);
    if (!aba) aba = ss.insertSheet(nome);
    if (aba.getLastRow() === 0) {
      aba.getRange(1, 1, 1, defs[nome].length).setValues([defs[nome]])
        .setFontWeight('bold').setBackground('#1f3b5c').setFontColor('#ffffff');
      aba.setFrozenRows(1);
    }
  });

  // Cabeçalho de Envios sempre igual a COLUNAS_ENVIOS (colunas novas entram no fim)
  const env = ss.getSheetByName(CONFIG.ABAS.ENVIOS);
  const cab = env.getRange(1, 1, 1, COLUNAS_ENVIOS.length);
  if (cab.getValues()[0].join('|') !== COLUNAS_ENVIOS.join('|')) {
    cab.setValues([COLUNAS_ENVIOS]).setFontWeight('bold').setBackground('#1f3b5c').setFontColor('#ffffff');
  }
  compactarAlertas_();
  formatarEnvios_();
}

/**
 * Remove linhas vazias da aba Alertas e deixa caixas de seleção só nas linhas com alerta.
 * (Corrige a versão anterior, que punha caixas em todas as linhas e fazia os alertas
 *  novos irem parar lá no fim da planilha.)
 */
function compactarAlertas_() {
  const aba = planilha_().getSheetByName(CONFIG.ABAS.ALERTAS);
  const max = aba.getMaxRows();
  if (max < 2) return;
  const valores = aba.getRange(2, 1, max - 1, 10).getValues();
  const comDado = valores.filter(function (l) { return l[0] !== '' && l[0] !== null; });
  const ultima = ultimaLinhaColA_(aba);
  const semBuracos = comDado.length === ultima - 1;
  const temCaixaSobrando = ultima + 1 <= max && aba.getRange(ultima + 1, 9).getDataValidation() !== null;
  if (semBuracos && !temCaixaSobrando) return;  // já está arrumada

  const tudo = aba.getRange(2, 1, max - 1, 10);
  tudo.clearDataValidations();
  tudo.clearContent();
  if (comDado.length) {
    aba.getRange(2, 9, comDado.length, 1).insertCheckboxes();
    aba.getRange(2, 1, comDado.length, 10).setValues(comDado.map(function (l) {
      l[8] = l[8] === true; return l;
    }));
  }
}

/** Última linha com algo na coluna A (ignora caixas de seleção vazias em outras colunas). */
function ultimaLinhaColA_(aba) {
  const n = aba.getLastRow();
  if (n < 1) return 0;
  const col = aba.getRange(1, 1, n, 1).getValues();
  for (let i = col.length - 1; i >= 0; i--) {
    if (col[i][0] !== '' && col[i][0] !== null) return i + 1;
  }
  return 0;
}

/** Cores na coluna Status para bater o olho. */
function formatarEnvios_() {
  const aba = planilha_().getSheetByName(CONFIG.ABAS.ENVIOS);
  const col = COLUNAS_ENVIOS.indexOf('Status') + 1;
  const range = aba.getRange(2, col, Math.max(aba.getMaxRows() - 1, 1), 1);
  const regra = function (texto, cor) {
    return SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(texto).setBackground(cor).setRanges([range]).build();
  };
  const vermelho = '#f4c7c3', amarelo = '#fce8b2', verde = '#b7e1cd', cinza = '#e8eaed';
  const regras = [];
  Object.keys(STATUS).forEach(function (k) {
    const s = STATUS[k];
    let cor = null;
    if (k === 'ENTREGUE') cor = verde;
    else if (['EXTRAVIADO', 'DEVOLVIDO', 'EM_DEVOLUCAO', 'DESVIO', 'CANCELADO', 'PARADO', 'NAO_POSTADO', 'PROBLEMA_ENTREGA'].indexOf(k) >= 0) cor = vermelho;
    else if (k === 'SEM_RASTREIO') cor = cinza;
    else if (s.alerta) cor = amarelo;
    else if (k === 'ERRO_CONSULTA' || k === 'NAO_LOCALIZADO_ME') cor = cinza;
    if (cor) regras.push(regra(s.rotulo, cor));
  });
  // coluna Chargeback preenchida → vermelho
  const colCb = COLUNAS_ENVIOS.indexOf('Chargeback') + 1;
  regras.push(SpreadsheetApp.newConditionalFormatRule().whenCellNotEmpty().setBackground(vermelho)
    .setRanges([aba.getRange(2, colCb, Math.max(aba.getMaxRows() - 1, 1), 1)]).build());
  aba.setConditionalFormatRules(regras);
}

/**
 * Lê a aba Envios inteira para memória.
 * Retorna { linhas: [obj], porChave: {chave: obj}, porPedido: {numero: true} }
 * Cada obj tem as colunas por nome + _linha (número da linha na planilha).
 */
function lerEnvios_() {
  const aba = planilha_().getSheetByName(CONFIG.ABAS.ENVIOS);
  const ultima = aba.getLastRow();
  const res = { linhas: [], porChave: {}, porPedido: {} };
  if (ultima < 2) return res;
  const valores = aba.getRange(2, 1, ultima - 1, COLUNAS_ENVIOS.length).getValues();
  valores.forEach(function (v, i) {
    const o = { _linha: i + 2 };
    COLUNAS_ENVIOS.forEach(function (c, j) { o[c] = v[j]; });
    if (!o['Chave']) return;
    res.linhas.push(o);
    res.porChave[o['Chave']] = o;
    res.porPedido[String(o['Pedido LI'])] = true;
  });
  return res;
}

function objParaLinha_(o) {
  return COLUNAS_ENVIOS.map(function (c) { return o[c] === undefined || o[c] === null ? '' : o[c]; });
}

function adicionarEnvios_(objs) {
  if (!objs.length) return;
  const aba = planilha_().getSheetByName(CONFIG.ABAS.ENVIOS);
  aba.getRange(aba.getLastRow() + 1, 1, objs.length, COLUNAS_ENVIOS.length)
    .setValues(objs.map(objParaLinha_));
}

/** Regrava só as linhas alteradas (agrupando linhas vizinhas para ficar rápido). */
function salvarEnvios_(objs) {
  if (!objs.length) return;
  const aba = planilha_().getSheetByName(CONFIG.ABAS.ENVIOS);
  const vistos = {};
  objs = objs.filter(function (o) { if (vistos[o._linha]) return false; vistos[o._linha] = true; return true; });
  objs.sort(function (a, b) { return a._linha - b._linha; });
  let bloco = [objs[0]];
  const gravar = function (b) {
    aba.getRange(b[0]._linha, 1, b.length, COLUNAS_ENVIOS.length).setValues(b.map(objParaLinha_));
  };
  for (let i = 1; i < objs.length; i++) {
    if (objs[i]._linha === bloco[bloco.length - 1]._linha + 1) bloco.push(objs[i]);
    else { gravar(bloco); bloco = [objs[i]]; }
  }
  gravar(bloco);
}

function registrarHistorico_(linhas) {
  if (!linhas.length) return;
  const aba = planilha_().getSheetByName(CONFIG.ABAS.HISTORICO);
  aba.getRange(aba.getLastRow() + 1, 1, linhas.length, linhas[0].length).setValues(linhas);
}

/**
 * Mantém a aba Alertas igual à situação ATUAL dos envios: um alerta aberto cujo pedido
 * já está em outro status (entregue, ou virou outro tipo de alerta) é marcado como resolvido
 * automaticamente, com o motivo na coluna Observação. Os alertas resolvidos continuam como histórico.
 */
function sincronizarAlertas_(linhasEnvios) {
  const aba = planilha_().getSheetByName(CONFIG.ABAS.ALERTAS);
  const ult = ultimaLinhaColA_(aba);
  if (ult < 2) return 0;
  const atual = {};
  linhasEnvios.forEach(function (o) {
    atual[String(o['Pedido LI']) + '|' + normalizarCodigo_(o['Código rastreio'])] = o;
  });
  const range = aba.getRange(2, 1, ult - 1, 10);
  const valores = range.getValues();
  const quando = agoraStr_('dd/MM HH:mm');
  let trats = null;
  let resolvidos = 0;
  valores.forEach(function (l) {
    if (l[0] === '' || l[8] === true) return;
    const o = atual[String(l[1]) + '|' + normalizarCodigo_(l[3])];
    if (!o) return;
    if (l[5] === STATUS.CHARGEBACK.rotulo) {
      // chargeback não depende do rastreio: só sai quando a tratativa for resolvida/encerrada no app
      if (!trats) { try { trats = lerTratativas_(); } catch (e) { trats = {}; } }
      if (tipoOcorrencia_(o, trats[o['Chave']]) === 'CHARGEBACK') return;
      l[8] = true;
      l[9] = 'Resolvido em ' + quando + ': tratativa do chargeback encerrada no app';
      resolvidos++;
      return;
    }
    if (STATUS[o['Status código']] && STATUS[o['Status código']].alerta && o['Status'] === l[5]) return; // continua valendo
    l[8] = true;
    l[9] = 'Resolvido automaticamente em ' + quando + ': agora "' + (o['Status'] || '?') + '"';
    resolvidos++;
  });
  if (resolvidos) {
    aba.getRange(2, 9, valores.length, 2).setValues(valores.map(function (l) { return [l[8] === true, l[9]]; }));
  }
  return resolvidos;
}

/** Item de menu: aplica a sincronização agora. */
function sincronizarAlertas() {
  const n = sincronizarAlertas_(lerEnvios_().linhas);
  log_('sincronizarAlertas', n + ' alertas antigos marcados como resolvidos');
  try { SpreadsheetApp.getActive().toast(n + ' alertas antigos marcados como resolvidos', 'Rastreio'); } catch (e) {}
}

function registrarAlertas_(linhas) {
  if (!linhas.length) return;
  const aba = planilha_().getSheetByName(CONFIG.ABAS.ALERTAS);
  const inicio = ultimaLinhaColA_(aba) + 1;
  aba.getRange(inicio, 9, linhas.length, 1).insertCheckboxes();
  aba.getRange(inicio, 1, linhas.length, linhas[0].length).setValues(linhas);
}

function log_(rotina, resultado) {
  try {
    const aba = planilha_().getSheetByName(CONFIG.ABAS.LOG);
    aba.appendRow([agoraStr_(), rotina, String(resultado).substring(0, 1000)]);
    // mantém o log curto (últimas 2000 linhas)
    if (aba.getLastRow() > 2500) aba.deleteRows(2, 500);
  } catch (e) {
    console.log(rotina + ': ' + resultado);
  }
}

function linkRastreio_(rota, codigo) {
  if (rota === 'CORREIOS_API') return 'https://rastreamento.correios.com.br/app/index.php?objetos=' + codigo;
  return 'https://www.melhorrastreio.com.br/rastreio/' + codigo;
}

/** Fila de pedidos da LI ainda não detalhados (aba oculta "_Fila"). */
function filaLer_() {
  const aba = planilha_().getSheetByName('_Fila');
  if (!aba || aba.getLastRow() < 1) return [];
  return aba.getRange(1, 1, aba.getLastRow(), 1).getValues()
    .map(function (r) { return String(r[0]); }).filter(Boolean);
}

function filaSalvar_(lista) {
  const ss = planilha_();
  let aba = ss.getSheetByName('_Fila');
  if (!aba) { aba = ss.insertSheet('_Fila'); aba.hideSheet(); }
  aba.clearContents();
  if (lista.length) aba.getRange(1, 1, lista.length, 1).setValues(lista.map(function (n) { return [n]; }));
}
