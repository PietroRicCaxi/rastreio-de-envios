/**
 * Main.gs — rotinas agendadas, menu da planilha e instalação.
 *
 *  instalar()             → roda UMA vez: cria abas, define a data de corte e agenda tudo
 *  sincronizarPedidosLI() → a cada 15 min: pega pedidos que viraram "Enviado" na LI
 *                           e os que entraram em chargeback / disputa
 *  atualizarRastreios()   → a cada 1 h: consulta Correios / Melhor Envio (Rastreio.gs)
 *  resumoDiario()         → todo dia às 8h: e-mail com o panorama
 */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('📦 Rastreio')
    .addItem('Buscar novos pedidos da LI agora', 'sincronizarPedidosLI')
    .addItem('Atualizar rastreios agora', 'atualizarRastreios')
    .addItem('Atualizar aba Resumo', 'atualizarResumo')
    .addItem('Verificar chargebacks na LI agora', 'verificarChargebacks')
    .addItem('Limpar alertas que já não valem', 'sincronizarAlertas')
    .addItem('Enviar resumo por e-mail agora', 'resumoDiario')
    .addSeparator()
    .addItem('Diagnóstico: Loja Integrada', 'diagnosticoLojaIntegrada')
    .addItem('Diagnóstico: Melhor Envio', 'diagnosticoMelhorEnvio')
    .addItem('Diagnóstico: Correios', 'diagnosticoCorreios')
    .addToUi();
}

/** Rode UMA vez depois de preencher as Propriedades do script. */
function instalar() {
  // valida credenciais obrigatórias antes de agendar qualquer coisa
  ['LI_CHAVE_API', 'LI_CHAVE_APLICACAO', 'ME_TOKEN', 'ME_EMAIL_CONTATO', 'EMAILS_ALERTA'].forEach(function (p) { prop_(p, true); });

  garantirAbas_();
  if (!prop_('DATA_INICIO')) {
    const corte = new Date(Date.now() - CONFIG.DIAS_RETROATIVOS_INICIAL * 86400000);
    setProp_('DATA_INICIO', Utilities.formatDate(corte, CONFIG.FUSO, 'yyyy-MM-dd HH:mm:ss'));
  }
  criarGatilhos_();
  log_('instalar', 'Instalado. Data de corte: ' + prop_('DATA_INICIO') + ' | Correios API: ' +
       (correiosDisponivel_() ? 'configurada' : 'NÃO configurada'));
  sincronizarPedidosLI();
}

function criarGatilhos_() {
  const alvo = ['sincronizarPedidosLI', 'atualizarRastreios', 'resumoDiario'];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (alvo.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sincronizarPedidosLI').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('atualizarRastreios').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('resumoDiario').timeBased().atHour(8).everyDays(1).inTimezone(CONFIG.FUSO).create();
}

/** Para tudo (remove os agendamentos). */
function desligar() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  log_('desligar', 'Agendamentos removidos.');
}

/**
 * Busca na LI os pedidos que ficaram "Enviado" desde a última execução
 * e cria uma linha por código de rastreio na aba Envios.
 */
function sincronizarPedidosLI() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) { log_('sincronizarPedidosLI', 'Outra execução em andamento — pulando.'); return; }
  const inicio = Date.now();
  let adicionados = 0, ignorados = 0, processados = 0;
  const novos = [];
  try {
    garantirAbas_();
    const desde = prop_('ULTIMA_SYNC_LI') || prop_('DATA_INICIO', true);
    const agora = new Date();
    const numeros = liListarEnviadosDesde_(desde);
    // próxima execução começa 10 min antes de agora (sobreposição de segurança; duplicados são ignorados)
    setProp_('ULTIMA_SYNC_LI', Utilities.formatDate(new Date(agora.getTime() - 10 * 60000), CONFIG.FUSO, 'yyyy-MM-dd HH:mm:ss'));

    const reg = lerEnvios_();
    const fila = filaLer_();
    let chargebacks = 0;
    numeros.forEach(function (n) {
      if (!reg.porPedido[n] && fila.indexOf(n) < 0) fila.push(n);
    });

    const correiosOk = correiosDisponivel_();
    while (fila.length && Date.now() - inicio < CONFIG.LIMITE_TEMPO_MS) {
      const numero = fila[0];
      const p = liDetalhePedido_(numero);
      fila.shift();
      processados++;
      if (!p) continue;

      const r = liResumoPedido_(p);
      liExtrairEnvios_(p).forEach(function (e) {
        if (!formaMonitorada_(e.formaNome, e.formaCodigo, e.codigo)) { ignorados++; return; }
        const chave = numero + '|' + e.codigo;
        if (reg.porChave[chave]) return;
        reg.porChave[chave] = true;
        const linha = novaLinhaEnvio_(numero, r, e, decidirRota_(e.codigo, e.formaNome, e.formaCodigo, correiosOk));
        if (!linha['Data pedido']) log_('sincronizarPedidosLI', 'Pedido ' + numero + ': data do pedido ilegível na LI: ' +
                                         JSON.stringify(r.dataPedido).substring(0, 80));
        novos.push(linha);
      });
    }

    // Conserto: linhas já gravadas sem data do pedido / data de vínculo → busca de novo na LI (até 20 por rodada)
    const semData = reg.linhas.filter(function (o) {
      return o['Finalizado'] !== 'SIM' && (!o['Data pedido'] || !o['Data vínculo']);
    }).slice(0, 20);
    const consertados = [];
    semData.forEach(function (o) {
      if (Date.now() - inicio > CONFIG.LIMITE_TEMPO_MS) return;
      try {
        const p = liDetalhePedido_(o['Pedido LI']);
        if (!p) return;
        const r = liResumoPedido_(p);
        const env = liExtrairEnvios_(p).filter(function (e) { return e.codigo === normalizarCodigo_(o['Código rastreio']); })[0];
        if (!o['Data pedido']) o['Data pedido'] = parseDataLi_(r.dataPedido) || '';
        if (!o['Data vínculo']) o['Data vínculo'] = (env && parseDataLi_(env.dataEnvio)) || parseDataLi_(r.dataModificacao) || o['Data pedido'] || '';
        if (!o['Prazo LI (dias úteis)'] && env && env.prazoDias) o['Prazo LI (dias úteis)'] = env.prazoDias;
        if (!o['Cidade/UF'] && r.cidadeUf) o['Cidade/UF'] = r.cidadeUf;
        consertados.push(o);
      } catch (e) { log_('sincronizarPedidosLI', 'Conserto de datas, pedido ' + o['Pedido LI'] + ': ' + e.message); }
    });
    salvarEnvios_(consertados);
    adicionarEnvios_(novos);
    adicionados = novos.length;
    filaSalvar_(fila);

    // Chargeback / pagamento em disputa (depois de gravar os novos, para achar as linhas deles)
    try { chargebacks = verificarChargebacks_(); } catch (e) { log_('verificarChargebacks', 'ERRO: ' + e.message); }
    log_('sincronizarPedidosLI', 'desde=' + desde + ' encontrados=' + numeros.length + ' detalhados=' + processados +
         ' novos envios=' + adicionados + ' ignorados (outras formas)=' + ignorados + ' fila restante=' + fila.length + ' datas consertadas=' + consertados.length + ' chargebacks novos=' + chargebacks);
  } catch (e) {
    log_('sincronizarPedidosLI', 'ERRO: ' + e.message);
    throw e;
  } finally {
    lock.releaseLock();
  }
}

/** Linha nova da aba Envios para um código de rastreio de um pedido da LI. */
function novaLinhaEnvio_(numero, r, e, rota) {
  const linha = {};
  COLUNAS_ENVIOS.forEach(function (c) { linha[c] = ''; });
  Object.assign(linha, {
    'Chave': numero + '|' + e.codigo,
    'Pedido LI': numero,
    'Data pedido': parseDataLi_(r.dataPedido) || '',
    'Cliente': r.cliente,
    'Cidade/UF': r.cidadeUf,
    'Forma de envio': e.formaNome || e.formaCodigo,
    'Rota': rota,
    'Código rastreio': e.codigo,
    'Data vínculo': parseDataLi_(e.dataEnvio) || parseDataLi_(r.dataModificacao) || new Date(),
    'Status': STATUS.NOVO.rotulo,
    'Status código': 'NOVO',
    'Link rastreio': linkRastreio_(rota, e.codigo),
    'Prazo LI (dias úteis)': e.prazoDias || ''
  });
  return linha;
}

/* ---------------------------- CHARGEBACK ---------------------------- */

/** Item de menu: verifica agora os pedidos em chargeback / disputa na LI. */
function verificarChargebacks() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) { log_('verificarChargebacks', 'Outra execução em andamento — tente de novo em instantes.'); return; }
  try {
    garantirAbas_();
    const n = verificarChargebacks_();
    log_('verificarChargebacks', n + ' chargeback(s) novo(s)');
    try { SpreadsheetApp.getActive().toast(n + ' chargeback(s) novo(s)', 'Rastreio'); } catch (e) {}
  } finally {
    lock.releaseLock();
  }
}

/**
 * Busca na LI os pedidos que entraram em chargeback / pagamento em disputa desde a última checagem.
 * - Pedido já acompanhado: marca a coluna "Chargeback" e completa "Recebido por" se já foi entregue.
 * - Pedido fora da planilha (ex.: antigo): cria as linhas com os códigos dele para buscar a prova de entrega.
 * Gera alerta (aba Alertas + e-mail) e o caso entra na fila de ocorrências do app.
 * Devolve quantos pedidos novos em chargeback foram encontrados.
 */
function verificarChargebacks_() {
  const sits = liSituacoesChargeback_();
  if (!sits.length) {
    const cache = CacheService.getScriptCache();
    if (!cache.get('AVISO_SEM_SIT_CHARGEBACK')) {
      cache.put('AVISO_SEM_SIT_CHARGEBACK', '1', 24 * 60 * 60);
      log_('verificarChargebacks', 'Nenhuma situação de chargeback/disputa reconhecida na LI. ' +
           'Rode "Diagnóstico: Loja Integrada" e coloque o código certo em CONFIG.LI_SITUACOES_CHARGEBACK.');
    }
    return 0;
  }
  const agora = new Date();
  const desde = prop_('ULTIMA_CHARGEBACK_LI') ||
    Utilities.formatDate(new Date(agora.getTime() - CONFIG.DIAS_RETROATIVOS_CHARGEBACK * 86400000), CONFIG.FUSO, 'yyyy-MM-dd HH:mm:ss');
  const achados = {};   // número do pedido → nome da situação na LI
  sits.forEach(function (sit) {
    liListarPorSituacaoDesde_(sit.id, desde).forEach(function (n) { achados[n] = sit.nome || sit.codigo; });
  });
  setProp_('ULTIMA_CHARGEBACK_LI', Utilities.formatDate(new Date(agora.getTime() - 10 * 60000), CONFIG.FUSO, 'yyyy-MM-dd HH:mm:ss'));
  const numeros = Object.keys(achados);
  if (!numeros.length) return 0;

  const reg = lerEnvios_();
  const porPedido = {};
  reg.linhas.forEach(function (o) { (porPedido[String(o['Pedido LI'])] = porPedido[String(o['Pedido LI'])] || []).push(o); });
  const correiosOk = correiosDisponivel_();
  const alterados = [], novos = [], alertas = [];
  let pedidosNovos = 0;

  numeros.forEach(function (numero) {
    let linhas = porPedido[numero] || [];
    if (linhas.every(function (o) { return o['Chargeback']; }) && linhas.length) return;  // já sinalizado antes
    try {
      if (!linhas.length) {
        const p = liDetalhePedido_(numero);
        if (!p) return;
        const r = liResumoPedido_(p);
        linhas = liExtrairEnvios_(p).map(function (e) {
          return novaLinhaEnvio_(numero, r, e, decidirRota_(e.codigo, e.formaNome, e.formaCodigo, correiosOk));
        });
        if (!linhas.length) {  // sem código de rastreio na LI: entra só para virar ocorrência
          const l = novaLinhaEnvio_(numero, r, { codigo: '', formaNome: '', formaCodigo: '', dataEnvio: '' }, '');
          l['Chave'] = numero + '|SEM-RASTREIO';
          l['Status código'] = 'SEM_RASTREIO'; l['Status'] = STATUS.SEM_RASTREIO.rotulo;
          l['Finalizado'] = 'SIM'; l['Link rastreio'] = '';
          linhas = [l];
        }
        linhas.forEach(function (l) { novos.push(l); });
      }
      pedidosNovos++;
      linhas.forEach(function (o) {
        if (o['Chargeback']) return;
        o['Chargeback'] = achados[numero] + ' · ' + fmtData_(agora, 'dd/MM/yyyy');
        if (o['Status código'] === 'ENTREGUE' && !o['Recebido por']) {
          try { o['Recebido por'] = buscarRecebedor_(o); } catch (e) {}
        }
        if (o._linha) alterados.push(o);
        alertas.push([agora, numero, o['Cliente'], o['Código rastreio'], o['Rota'], STATUS.CHARGEBACK.rotulo,
                      descricaoChargeback_(o, achados[numero]), o['Link rastreio'], false, '']);
      });
    } catch (e) {
      log_('verificarChargebacks', 'Pedido ' + numero + ': ' + e.message);
    }
  });

  salvarEnvios_(alterados);
  adicionarEnvios_(novos);
  registrarAlertas_(alertas);
  enviarEmailRodada_(alertas, []);
  return pedidosNovos;
}

/** Texto do alerta de chargeback, já com a prova de entrega quando houver. */
function descricaoChargeback_(o, situacaoLi) {
  let t = 'LI: ' + situacaoLi;
  if (o['Status código'] === 'ENTREGUE') {
    t += ' · entregue' + (o['Data último evento'] ? ' em ' + fmtData_(o['Data último evento'], 'dd/MM/yyyy') : '') +
         (o['Recebido por'] ? ', recebido por ' + o['Recebido por'] : '');
  } else if (o['Status código'] === 'SEM_RASTREIO') {
    t += ' · pedido sem código de rastreio na LI';
  } else {
    t += ' · rastreio: ' + (o['Status'] || 'ainda não consultado');
  }
  return t;
}

/* ---------------------------- E-MAILS ---------------------------- */

function destinatarios_() {
  return prop_('EMAILS_ALERTA', true).split(',').map(function (s) { return s.trim(); }).filter(Boolean).join(',');
}

function tabelaHtml_(cabecalho, linhas) {
  const th = cabecalho.map(function (c) { return '<th style="text-align:left;padding:6px;background:#1f3b5c;color:#fff">' + c + '</th>'; }).join('');
  const trs = linhas.map(function (l) {
    return '<tr>' + l.map(function (c) { return '<td style="padding:6px;border-bottom:1px solid #ddd">' + (c === null || c === undefined ? '' : c) + '</td>'; }).join('') + '</tr>';
  }).join('');
  return '<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px">' +
         '<tr>' + th + '</tr>' + trs + '</table>';
}

/** Um e-mail por rodada, só se houver alerta novo ou entrega nova. */
function enviarEmailRodada_(alertas, entregas) {
  if (!alertas.length && !entregas.length) return;
  let html = '';
  if (alertas.length) {
    html += '<h3 style="font-family:Arial">⚠️ ' + alertas.length + ' alerta(s) novo(s)</h3>' +
      tabelaHtml_(['Pedido', 'Cliente', 'Código', 'Alerta', 'Último evento', 'Rastreio'],
        alertas.map(function (a) { return [a[1], a[2], a[3], '<b>' + a[5] + '</b>', a[6], '<a href="' + a[7] + '">abrir</a>']; }));
  }
  if (entregas.length) {
    html += '<h3 style="font-family:Arial">✅ ' + entregas.length + ' entrega(s) confirmada(s)</h3>' +
      tabelaHtml_(['Pedido', 'Cliente', 'Código', 'Dias em trânsito', 'Recebido por'],
        entregas.map(function (o) { return [o['Pedido LI'], o['Cliente'], o['Código rastreio'], o['Dias em trânsito'], o['Recebido por'] || '—']; }));
  }
  html += '<p style="font-family:Arial;font-size:12px;color:#666">Planilha: <a href="' + planilha_().getUrl() + '">abrir painel de rastreio</a></p>';
  const assunto = '[Rastreio] ' + (alertas.length ? alertas.length + ' alerta(s)' : '') +
                  (alertas.length && entregas.length ? ' · ' : '') +
                  (entregas.length ? entregas.length + ' entregue(s)' : '');
  MailApp.sendEmail({ to: destinatarios_(), subject: assunto, htmlBody: html });
}

/** Resumo diário: quantos envios em cada situação + alertas ainda não resolvidos. */
function resumoDiario() {
  const reg = lerEnvios_();
  const contagem = {};
  reg.linhas.filter(function (o) { return o['Finalizado'] !== 'SIM'; }).forEach(function (o) {
    const s = o['Status'] || '—';
    contagem[s] = (contagem[s] || 0) + 1;
  });
  const ontem = Date.now() - 86400000;
  const entreguesOntem = reg.linhas.filter(function (o) {
    return o['Status código'] === 'ENTREGUE' && o['Data último evento'] && new Date(o['Data último evento']).getTime() >= ontem;
  }).length;

  const abaAl = planilha_().getSheetByName(CONFIG.ABAS.ALERTAS);
  const abertos = [];
  const ultAl = ultimaLinhaColA_(abaAl);
  if (ultAl > 1) {
    abaAl.getRange(2, 1, ultAl - 1, 10).getValues().forEach(function (l) {
      if (l[0] !== '' && l[8] !== true) abertos.push([fmtData_(l[0]), l[1], l[2], l[3], '<b>' + l[5] + '</b>', l[6]]);
    });
  }

  let html = '<h3 style="font-family:Arial">📦 Envios em andamento</h3>' +
    tabelaHtml_(['Situação', 'Qtd'], Object.keys(contagem).sort().map(function (k) { return [k, contagem[k]]; })) +
    '<p style="font-family:Arial">Entregues nas últimas 24h: <b>' + entreguesOntem + '</b></p>';
  if (abertos.length) {
    html += '<h3 style="font-family:Arial">⚠️ Alertas não resolvidos (' + abertos.length + ')</h3>' +
      tabelaHtml_(['Desde', 'Pedido', 'Cliente', 'Código', 'Alerta', 'Evento'], abertos.slice(-100));
  }
  html += '<p style="font-family:Arial;font-size:12px;color:#666">Marque "Resolvido?" na aba Alertas para tirar da lista. ' +
          '<a href="' + planilha_().getUrl() + '">Abrir planilha</a></p>';
  MailApp.sendEmail({ to: destinatarios_(), subject: '[Rastreio] Resumo diário — ' + agoraStr_('dd/MM/yyyy'), htmlBody: html });
  log_('resumoDiario', 'enviado — alertas abertos=' + abertos.length);
}
