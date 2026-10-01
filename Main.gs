/**
 * Main.gs — rotinas agendadas, menu da planilha e instalação.
 *
 *  instalar()             → roda UMA vez: cria abas, define a data de corte e agenda tudo
 *  sincronizarPedidosLI() → a cada 15 min: pega pedidos que viraram "Enviado" na LI
 *  atualizarRastreios()   → a cada 1 h: consulta Correios / Melhor Envio (Rastreio.gs)
 *  resumoDiario()         → todo dia às 8h: e-mail com o panorama
 */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('📦 Rastreio')
    .addItem('Buscar novos pedidos da LI agora', 'sincronizarPedidosLI')
    .addItem('Atualizar rastreios agora', 'atualizarRastreios')
    .addItem('Atualizar aba Resumo', 'atualizarResumo')
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
        const rota = decidirRota_(e.codigo, e.formaNome, e.formaCodigo, correiosOk);
        const linha = {};
        COLUNAS_ENVIOS.forEach(function (c) { linha[c] = ''; });
        Object.assign(linha, {
          'Chave': chave,
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
    log_('sincronizarPedidosLI', 'desde=' + desde + ' encontrados=' + numeros.length + ' detalhados=' + processados +
         ' novos envios=' + adicionados + ' ignorados (outras formas)=' + ignorados + ' fila restante=' + fila.length + ' datas consertadas=' + consertados.length);
  } catch (e) {
    log_('sincronizarPedidosLI', 'ERRO: ' + e.message);
    throw e;
  } finally {
    lock.releaseLock();
  }
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
      tabelaHtml_(['Pedido', 'Cliente', 'Código', 'Dias em trânsito'],
        entregas.map(function (o) { return [o['Pedido LI'], o['Cliente'], o['Código rastreio'], o['Dias em trânsito']]; }));
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
